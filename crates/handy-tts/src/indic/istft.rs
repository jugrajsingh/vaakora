//! Inverse STFT of `indic_tiny_tts/export/onnx_infer.py` `istft` (padding "center") at
//! sulabhkatiyar/indic-tiny-tts-english@eea5d4a578c0f18173825a037487cf9c47ed4247, MIT, see INDIC-TINY-TTS-CODE-LICENSE.
use anyhow::{Result, ensure};
use std::f64::consts::PI;

/// The smallest squared-window overlap the reference accepts (NOLA).
const MIN_ENVELOPE: f64 = 1e-11;

/// Waveform of a `[bins][frames]` spectrum (`bins = n_fft / 2 + 1`): an inverse real FFT per frame, a periodic Hann
/// window, overlap-add in f64 divided by the squared-window envelope, `n_fft / 2` samples trimmed at each end.
pub(crate) fn istft(
    real: &[f32],
    imag: &[f32],
    bins: usize,
    frames: usize,
    n_fft: usize,
    hop: usize,
) -> Result<Vec<f32>> {
    ensure!(
        n_fft.is_power_of_two() && bins == n_fft / 2 + 1 && hop > 0 && hop <= n_fft,
        "unsupported inverse STFT {bins} bins, n_fft {n_fft}, hop {hop}"
    );
    ensure!(
        real.len() == bins * frames && imag.len() == bins * frames,
        "spectrum size does not match {bins} x {frames}"
    );
    if frames == 0 {
        return Ok(vec![]);
    }
    let window: Vec<f64> = (0..n_fft)
        .map(|n| 0.5 - 0.5 * (2.0 * PI * n as f64 / n_fft as f64).cos())
        .collect();
    let total = n_fft + hop * (frames - 1);
    let mut y = vec![0.0f64; total];
    let mut envelope = vec![0.0f64; total];
    let mut re = vec![0.0f64; n_fft];
    let mut im = vec![0.0f64; n_fft];
    for frame in 0..frames {
        // Hermitian spectrum of a real frame; numpy's irfft ignores the imaginary parts at DC and Nyquist.
        for k in 0..bins {
            re[k] = f64::from(real[k * frames + frame]);
            im[k] = if k == 0 || k == bins - 1 {
                0.0
            } else {
                f64::from(imag[k * frames + frame])
            };
        }
        for k in bins..n_fft {
            re[k] = re[n_fft - k];
            im[k] = -im[n_fft - k];
        }
        inverse_fft(&mut re, &mut im);
        let offset = frame * hop;
        for n in 0..n_fft {
            y[offset + n] += re[n] * window[n];
            envelope[offset + n] += window[n] * window[n];
        }
    }
    let pad = n_fft / 2;
    let kept = pad..total - pad;
    ensure!(
        envelope[kept.clone()].iter().all(|&e| e >= MIN_ENVELOPE),
        "inverse STFT window overlap-add is about zero (NOLA violated)"
    );
    Ok(y[kept.clone()]
        .iter()
        .zip(&envelope[kept])
        .map(|(sample, overlap)| (sample / overlap) as f32)
        .collect())
}

/// In-place normalised inverse FFT (`x[n] = sum_k X[k] e^(2 pi i k n / N) / N`), iterative radix-2, `N` a power of two.
fn inverse_fft(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    debug_assert!(n.is_power_of_two() && im.len() == n);
    let bits = n.trailing_zeros();
    if bits == 0 {
        return;
    }
    for i in 0..n {
        let j = i.reverse_bits() >> (usize::BITS - bits);
        if j > i {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let twiddles: Vec<(f64, f64)> = (0..n / 2)
        .map(|k| {
            let angle = 2.0 * PI * k as f64 / n as f64;
            (angle.cos(), angle.sin())
        })
        .collect();
    for stage in 1..=bits {
        let len = 1usize << stage;
        let stride = n / len;
        for start in (0..n).step_by(len) {
            for k in 0..len / 2 {
                let (wr, wi) = twiddles[k * stride];
                let (a, b) = (start + k, start + k + len / 2);
                let (xr, xi) = (re[b] * wr - im[b] * wi, re[b] * wi + im[b] * wr);
                re[b] = re[a] - xr;
                im[b] = im[a] - xi;
                re[a] += xr;
                im[a] += xi;
            }
        }
    }
    let scale = 1.0 / n as f64;
    for (r, i) in re.iter_mut().zip(im.iter_mut()) {
        *r *= scale;
        *i *= scale;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{Rng, SeedableRng, rngs::StdRng};
    use serde_json::Value;

    const FIXTURE: &str = include_str!("../../tests/fixtures/indic-tiny/istft.json");

    fn floats(value: &Value) -> Vec<f32> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap() as f32)
            .collect()
    }

    #[test]
    fn istft_matches_the_numpy_reference() {
        let doc: Value = serde_json::from_str(FIXTURE).unwrap();
        let (n_fft, hop) = (
            doc["n_fft"].as_u64().unwrap() as usize,
            doc["hop"].as_u64().unwrap() as usize,
        );
        assert_eq!((n_fft, hop, doc["frames"].as_u64()), (1024, 256, Some(6)));
        let cases = doc["cases"].as_array().unwrap();
        assert!(cases.len() >= 4, "{} cases", cases.len());
        for case in std::iter::once(&doc).chain(cases) {
            let (bins, frames) = (
                case["bins"].as_u64().unwrap() as usize,
                case["frames"].as_u64().unwrap() as usize,
            );
            let expected = floats(&case["wav"]);
            let wav = istft(
                &floats(&case["real"]),
                &floats(&case["imag"]),
                bins,
                frames,
                n_fft,
                hop,
            )
            .unwrap();
            assert_eq!(wav.len(), 256 * (frames - 1), "{frames} frames");
            assert_eq!(wav.len(), expected.len(), "{frames} frames");
            let error = wav
                .iter()
                .zip(&expected)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0f32, f32::max);
            assert!(
                error <= 1e-5,
                "{frames} frames: max |rust - numpy| = {error}"
            );
        }
    }

    #[test]
    fn istft_refuses_a_window_overlap_of_about_zero() {
        // A hop of n_fft leaves the periodic Hann window's zero at every frame start uncovered.
        let error = istft(&[1.0; 513 * 2], &[0.0; 513 * 2], 513, 2, 1024, 1024).unwrap_err();
        assert!(error.to_string().contains("NOLA"), "{error:#}");
    }

    #[test]
    fn radix2_inverse_fft_matches_a_direct_dft() {
        const N: usize = 1024;
        let mut rng = StdRng::seed_from_u64(20261108);
        let spectrum: Vec<(f64, f64)> = (0..N)
            .map(|_| (rng.gen_range(-1.0..1.0), rng.gen_range(-1.0..1.0)))
            .collect();
        let (mut re, mut im): (Vec<f64>, Vec<f64>) = spectrum.iter().copied().unzip();
        inverse_fft(&mut re, &mut im);
        let mut error = 0.0f64;
        for n in 0..N {
            let (mut sum_re, mut sum_im) = (0.0, 0.0);
            for (k, (a, b)) in spectrum.iter().enumerate() {
                let angle = 2.0 * std::f64::consts::PI * ((k * n) % N) as f64 / N as f64;
                sum_re += a * angle.cos() - b * angle.sin();
                sum_im += a * angle.sin() + b * angle.cos();
            }
            error = error
                .max((re[n] - sum_re / N as f64).abs())
                .max((im[n] - sum_im / N as f64).abs());
        }
        assert!(error <= 1e-9, "max error {error}");
    }
}
