//! Durations, length regulation and the Euler solver of `indic_tiny_tts/export/onnx_infer.py` (`durations`,
//! `length_regulate`, `TinyTTSOnnx.decode`, `torch_linspace`) at sulabhkatiyar/indic-tiny-tts-english@eea5d4a578c0f18173825a037487cf9c47ed4247,
//! MIT, see INDIC-TINY-TTS-CODE-LICENSE.
use anyhow::{Result, ensure};

/// `(w_ceil, y_len, y_pad)`: `w_ceil = ceil(exp(logw)) x length_scale` in f32, `y_len` = the f64 sum cast to f32,
/// at least 1, truncated, and `y_pad` = `y_len` rounded up to a multiple of `frame_multiple`.
pub(crate) fn durations(
    logw: &[f32],
    length_scale: f32,
    frame_multiple: usize,
) -> (Vec<f32>, usize, usize) {
    let w_ceil: Vec<f32> = logw.iter().map(|w| w.exp().ceil() * length_scale).collect();
    let sum = w_ceil.iter().map(|&w| f64::from(w)).sum::<f64>() as f32;
    let y_len = sum.max(1.0) as usize;
    (
        w_ceil,
        y_len,
        y_len.div_ceil(frame_multiple) * frame_multiple,
    )
}

/// `(mu_y [channels][y_pad], mask [y_pad])` from `mu_x [channels][tokens]`: frame `j` copies token `i` iff
/// `cum[i-1] <= j < cum[i]` (the cumulative sum accumulated in f64, stored as f32); frames from `y_len` on are zero.
pub(crate) fn length_regulate(
    mu_x: &[f32],
    channels: usize,
    w_ceil: &[f32],
    y_len: usize,
    y_pad: usize,
) -> (Vec<f32>, Vec<f32>) {
    let tokens = w_ceil.len();
    let mut total = 0.0f64;
    let cum: Vec<f32> = w_ceil
        .iter()
        .map(|&w| {
            total += f64::from(w);
            total as f32
        })
        .collect();
    let mut mu_y = vec![0.0; channels * y_pad];
    let mut mask = vec![0.0; y_pad];
    for (j, slot) in mask.iter_mut().enumerate() {
        let frame = j as f32;
        // numpy searchsorted side "right": the first token whose cumulative duration exceeds the frame.
        let token = cum.partition_point(|&c| c <= frame);
        if token < tokens && frame < y_len as f32 {
            *slot = 1.0;
            for c in 0..channels {
                mu_y[c * y_pad + j] = mu_x[c * tokens + token];
            }
        }
    }
    (mu_y, mask)
}

/// f32 `torch.linspace` (the symmetric two-sided formula, so the values match torch bit for bit).
fn torch_linspace(start: f32, end: f32, steps: usize) -> Vec<f32> {
    if steps == 1 {
        return vec![start];
    }
    let step = ((f64::from(end) - f64::from(start)) / (steps - 1) as f64) as f32;
    let half = steps / 2;
    (0..steps)
        .map(|i| {
            if i < half {
                start + step * i as f32
            } else {
                end - step * (steps - 1 - i) as f32
            }
        })
        .collect()
}

/// Integrates `x' = step(x, t)` from `t = 0` to 1 in `steps` Euler steps on the f32 `torch_linspace` grid, with
/// `dt` recomputed as `t_span[k + 1] - t` after each step; returns the final state.
pub(crate) fn euler(
    steps: usize,
    x0: Vec<f32>,
    mut step: impl FnMut(&[f32], f32) -> Result<Vec<f32>>,
) -> Result<Vec<f32>> {
    ensure!(steps > 0, "the Euler solver needs at least one step");
    let t_span = torch_linspace(0.0, 1.0, steps + 1);
    let mut x = x0;
    let mut t = t_span[0];
    let mut dt = t_span[1] - t_span[0];
    for k in 1..=steps {
        let v = step(&x, t)?;
        ensure!(v.len() == x.len(), "decoder velocity has the wrong size");
        for (state, velocity) in x.iter_mut().zip(&v) {
            *state += dt * velocity;
        }
        t += dt;
        if k < steps {
            dt = t_span[k + 1] - t;
        }
    }
    Ok(x)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_ceil_scale_and_pad() {
        let (w, y_len, y_pad) = durations(&[1.2, 1.2, -3.0], 1.0, 2);
        assert_eq!((w, y_len, y_pad), (vec![4.0, 4.0, 1.0], 9, 10));
        let (_, y_len, y_pad) = durations(&[0.4, 0.9, -1.0], 1.0319, 2); // ceil -> 2, 3, 1; sum 6.1914
        assert_eq!((y_len, y_pad), (6, 6));
    }

    #[test]
    fn length_regulation_copies_tokens_and_masks_padding() {
        let (mu, mask) = length_regulate(&[10.0, 20.0, 30.0], 1, &[2.0, 3.0, 1.0], 6, 8);
        assert_eq!(mu, [10.0, 10.0, 20.0, 20.0, 20.0, 30.0, 0.0, 0.0]);
        assert_eq!(mask, [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0]);
    }

    #[test]
    fn euler_takes_four_quarter_steps() {
        let mut times = vec![];
        let x = euler(4, vec![0.0; 3], |x, t| {
            times.push(t);
            Ok(vec![1.0; x.len()])
        })
        .unwrap();
        assert_eq!(times, [0.0, 0.25, 0.5, 0.75]);
        assert_eq!(x, [1.0, 1.0, 1.0]);
    }
}
