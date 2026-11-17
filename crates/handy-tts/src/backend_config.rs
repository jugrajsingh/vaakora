use crate::graph::BackendConfig;
use crate::padding::ShapeClass;
use anyhow::{Context, Result};
use handy_tts_core::device::Device;
use std::{collections::BTreeMap, path::Path};

pub fn config(model_id: &str, root: &Path, device: Device, cache: &Path) -> Result<BackendConfig> {
    let mut placement = BTreeMap::new();
    let mut shapes = BTreeMap::new();
    if model_id == "pocket-en" {
        for graph in [
            "text_conditioner",
            "flow_lm_main_int8",
            "flow_lm_flow_int8",
            "mimi_decoder_int8",
        ] {
            let target = if graph == "flow_lm_main_int8"
                || device == Device::Gpu
                    && matches!(graph, "mimi_decoder_int8" | "flow_lm_flow_int8")
            {
                Device::Cpu
            } else {
                device
            };
            placement.insert(graph.into(), target);
        }
        if device == Device::Npu {
            shapes.insert(
                "text_conditioner".into(),
                BTreeMap::from([("token_ids".into(), vec![1, 64])]),
            );
            shapes.insert(
                "flow_lm_flow_int8".into(),
                BTreeMap::from([
                    ("c".into(), vec![1, 1024]),
                    ("s".into(), vec![1, 1]),
                    ("t".into(), vec![1, 1]),
                    ("x".into(), vec![1, 32]),
                ]),
            );
            let bundle: serde_json::Value = serde_json::from_slice(
                &std::fs::read(root.join("onnx/english_2026-04/bundle.json"))
                    .context("read pinned Pocket static shapes")?,
            )
            .context("decode Pocket static shapes")?;
            let mut decoder = BTreeMap::from([("latent".into(), vec![1, 12, 32])]);
            for state in bundle["mimi_state_manifest"]
                .as_array()
                .context("Pocket decoder state manifest missing")?
            {
                let name = state["input_name"]
                    .as_str()
                    .context("Pocket state input name missing")?;
                let dimensions = state["shape"]
                    .as_array()
                    .context("Pocket state shape missing")?
                    .iter()
                    .map(|d| d.as_i64().context("Pocket state dimension invalid"))
                    .collect::<Result<Vec<_>>>()?;
                decoder.insert(name.into(), dimensions);
            }
            shapes.insert("mimi_decoder_int8".into(), decoder);
        }
    } else if model_id == "supertonic-3" {
        for graph in [
            "duration_predictor",
            "text_encoder",
            "vector_estimator",
            "vocoder",
        ] {
            placement.insert(graph.into(), device);
        }
        if device == Device::Npu {
            shapes = supertonic_shapes(ShapeClass {
                text: 512,
                frames: 512,
            });
        }
    } else if model_id == "kokoro-82m-int8" {
        placement.insert("model_quantized".into(), device);
        if device == Device::Npu {
            shapes.insert(
                "model_quantized".into(),
                BTreeMap::from([
                    ("input_ids".into(), vec![1, 512]),
                    ("style".into(), vec![1, 256]),
                    ("speed".into(), vec![1]),
                ]),
            );
        }
    } else if model_id.starts_with("indic-tiny-") {
        anyhow::ensure!(
            device != Device::Npu,
            "indic-tiny-* does not run on the NPU"
        );
        placement.extend(INDIC_GRAPHS.map(|graph| (graph.to_string(), device)));
    } else if let Some(graphs) = cpu_only_graphs(model_id) {
        anyhow::ensure!(device == Device::Cpu, "{model_id} runs on the CPU only");
        for graph in graphs {
            placement.insert((*graph).into(), Device::Cpu);
        }
    } else {
        anyhow::bail!("unknown model id");
    }
    Ok(BackendConfig {
        model_id: model_id.into(),
        device,
        cache_dir: cache.into(),
        placement,
        shapes,
        family: match (model_id, device) {
            ("supertonic-3", Device::Gpu) => Some(StaticFamily::Supertonic),
            (id, Device::Gpu) if id.starts_with("indic-tiny-") => Some(StaticFamily::IndicTiny),
            _ => None,
        },
        classes: match (model_id, device) {
            ("supertonic-3", Device::Gpu) => [
                (32, 48),
                (80, 144),
                (176, 208),
                (224, 288),
                (272, 336),
                (304, 416),
            ]
            .into_iter()
            .map(|(text, frames)| ShapeClass { text, frames })
            .collect(),
            (id, Device::Gpu) if id.starts_with("indic-tiny-") => INDIC_CLASSES
                .into_iter()
                .map(|(text, frames)| ShapeClass { text, frames })
                .collect(),
            _ => vec![],
        },
    })
}
/// The three Indic Tiny graphs.
const INDIC_GRAPHS: [&str; 3] = ["text_encoder", "flow_decoder", "vocoder"];
/// Indic Tiny GPU classes `(text, frames)`: the spike's token buckets for the text encoder. The decoder and vocoder
/// run with dynamic shapes because zero-padded frames changed their mel by up to 8% (nm6 measurement).
const INDIC_CLASSES: [(i64, i64); 4] = [(64, 0), (128, 0), (256, 0), (512, 0)];

/// A model whose graphs run at static GPU shape classes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StaticFamily {
    Supertonic,
    IndicTiny,
}
impl StaticFamily {
    /// Input shapes of every graph at one class.
    pub fn shapes(self, class: ShapeClass) -> BTreeMap<String, BTreeMap<String, Vec<i64>>> {
        match self {
            Self::Supertonic => supertonic_shapes(class),
            Self::IndicTiny => indic_shapes(class),
        }
    }
    /// Whether a graph of the family runs on the GPU with dynamic shapes instead of static classes.
    pub fn dynamic(self, graph: &str) -> bool {
        self == Self::IndicTiny && matches!(graph, "flow_decoder" | "vocoder")
    }
    /// Whether a class graph compiles with f32 inference precision instead of the default f16.
    pub fn full_precision(self, graph: &str) -> bool {
        match self {
            Self::Supertonic => crate::ov_graph::class_full_precision(graph),
            Self::IndicTiny => false,
        }
    }
    /// The `(text, frames)` a call needs, from its original input shapes.
    pub fn dimensions(self, original: &BTreeMap<String, Vec<i64>>) -> (i64, i64) {
        let at = |name: &str, axis: usize| original.get(name).and_then(|s| s.get(axis).copied());
        match self {
            Self::Supertonic => (
                at("text_ids", 1)
                    .or_else(|| at("text_mask", 2))
                    .unwrap_or(0),
                at("noisy_latent", 2)
                    .or_else(|| at("latent", 2))
                    .unwrap_or(0),
            ),
            Self::IndicTiny => (at("tokens", 1).unwrap_or(0), 0),
        }
    }
    /// The axis and original length a padded output is cropped to.
    pub fn crop(
        self,
        index: usize,
        rank: usize,
        original: &BTreeMap<String, Vec<i64>>,
    ) -> Option<(usize, i64)> {
        let at = |name: &str, axis: usize| original.get(name).and_then(|s| s.get(axis).copied());
        match self {
            Self::Supertonic => {
                if index != 0 || rank != 3 {
                    return None;
                }
                at("noisy_latent", 2)
                    .map(|length| (2, length))
                    .or_else(|| at("text_ids", 1).map(|length| (2, length)))
                    .or_else(|| at("token_ids", 1).map(|length| (1, length)))
            }
            Self::IndicTiny => {
                if rank != 3 {
                    return None;
                }
                at("tokens", 1).map(|length| (2, length))
            }
        }
    }
}
/// Input shapes of the Indic Tiny text encoder at a static token capacity.
fn indic_shapes(class: ShapeClass) -> BTreeMap<String, BTreeMap<String, Vec<i64>>> {
    BTreeMap::from([(
        "text_encoder".into(),
        BTreeMap::from([
            ("tokens".into(), vec![1, class.text]),
            ("token_lengths".into(), vec![1]),
            ("language".into(), vec![1]),
            ("speaker".into(), vec![1]),
            ("style".into(), vec![1]),
        ]),
    )])
}
/// Graphs of the models that run on the CPU only (no GPU or NPU route was measured to work).
fn cpu_only_graphs(model_id: &str) -> Option<&'static [&'static str]> {
    match model_id {
        "paradee-8m-int8" => Some(&["paradee_int8"]),
        "phonon-31m-en" => Some(&["model_q4", "mimi_decoder"]),
        _ => None,
    }
}
/// Input shapes for all four Supertonic graphs at a static capacity.
pub fn supertonic_shapes(class: ShapeClass) -> BTreeMap<String, BTreeMap<String, Vec<i64>>> {
    let mut shapes = BTreeMap::new();
    let text = [
        ("text_ids".into(), vec![1, class.text]),
        ("text_mask".into(), vec![1, 1, class.text]),
    ];
    let mut dp = BTreeMap::from(text.clone());
    dp.insert("style_dp".into(), vec![1, 8, 16]);
    let mut encoder = BTreeMap::from(text);
    encoder.insert("style_ttl".into(), vec![1, 50, 256]);
    let estimator = BTreeMap::from([
        ("noisy_latent".into(), vec![1, 144, class.frames]),
        ("text_emb".into(), vec![1, 256, class.text]),
        ("style_ttl".into(), vec![1, 50, 256]),
        ("latent_mask".into(), vec![1, 1, class.frames]),
        ("text_mask".into(), vec![1, 1, class.text]),
        ("current_step".into(), vec![1]),
        ("total_step".into(), vec![1]),
    ]);
    shapes.insert("duration_predictor".into(), dp);
    shapes.insert("text_encoder".into(), encoder);
    shapes.insert("vector_estimator".into(), estimator);
    shapes.insert(
        "vocoder".into(),
        BTreeMap::from([("latent".into(), vec![1, 144, class.frames])]),
    );
    shapes
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn measured_placements_and_supertonic_static_shapes_are_explicit() {
        let supertonic = config(
            "supertonic-3",
            Path::new("."),
            Device::Npu,
            Path::new("cache"),
        )
        .unwrap();
        assert_eq!(
            supertonic.shapes["vector_estimator"]["noisy_latent"],
            [1, 144, 512]
        );
        assert_eq!(supertonic.placement.len(), 4);
        assert!(
            supertonic
                .placement
                .values()
                .all(|device| *device == Device::Npu)
        );
        let pocket = config("pocket-en", Path::new("."), Device::Gpu, Path::new("cache")).unwrap();
        assert_eq!(pocket.placement["flow_lm_main_int8"], Device::Cpu);
        assert_eq!(pocket.placement["mimi_decoder_int8"], Device::Cpu);
        assert_eq!(
            pocket.placement["flow_lm_flow_int8"],
            Device::Cpu,
            "the int8 flow sampler clips speech on the Intel GPU"
        );
        assert_eq!(pocket.placement["text_conditioner"], Device::Gpu);
        let kokoro = config(
            "kokoro-82m-int8",
            Path::new("."),
            Device::Gpu,
            Path::new("cache"),
        )
        .unwrap();
        assert_eq!(kokoro.placement["model_quantized"], Device::Gpu);
    }

    mod cpu_only {
        use super::*;
        #[test]
        fn cpu_only_models_refuse_accelerators() {
            for (model, graphs) in [
                ("paradee-8m-int8", &["paradee_int8"][..]),
                ("phonon-31m-en", &["mimi_decoder", "model_q4"][..]),
            ] {
                for device in [Device::Gpu, Device::Npu] {
                    let error = config(model, Path::new("."), device, Path::new("cache"))
                        .unwrap_err()
                        .to_string();
                    assert_eq!(error, format!("{model} runs on the CPU only"));
                }
                let cpu = config(model, Path::new("."), Device::Cpu, Path::new("cache")).unwrap();
                assert_eq!(
                    cpu.placement,
                    graphs
                        .iter()
                        .map(|graph| (graph.to_string(), Device::Cpu))
                        .collect::<BTreeMap<_, _>>(),
                    "{model}"
                );
                assert!(cpu.shapes.is_empty() && cpu.classes.is_empty(), "{model}");
            }
        }
    }

    mod indic {
        use super::*;
        #[test]
        fn indic_gpu_classes_are_the_spike_token_buckets() {
            for model in ["indic-tiny-en", "indic-tiny-hi", "indic-tiny-pa"] {
                let gpu = config(model, Path::new("."), Device::Gpu, Path::new("cache")).unwrap();
                assert_eq!(gpu.family, Some(StaticFamily::IndicTiny), "{model}");
                assert_eq!(
                    gpu.classes
                        .iter()
                        .map(|class| (class.text, class.frames))
                        .collect::<Vec<_>>(),
                    [(64, 0), (128, 0), (256, 0), (512, 0)],
                    "{model}: only the text encoder runs at static token classes"
                );
                assert!(gpu.shapes.is_empty(), "{model}");
                assert_eq!(
                    gpu.placement,
                    INDIC_GRAPHS
                        .iter()
                        .map(|graph| (graph.to_string(), Device::Gpu))
                        .collect::<BTreeMap<_, _>>(),
                    "{model}"
                );
                let family = StaticFamily::IndicTiny;
                for (class, tokens) in gpu.classes.iter().zip([64, 128, 256, 512]) {
                    let shapes = family.shapes(*class);
                    assert_eq!(
                        shapes.keys().collect::<Vec<_>>(),
                        ["text_encoder"],
                        "decoder and vocoder have no static shapes"
                    );
                    assert_eq!(shapes["text_encoder"]["tokens"], [1, tokens]);
                    for scalar in ["token_lengths", "language", "speaker", "style"] {
                        assert_eq!(shapes["text_encoder"][scalar], [1], "{scalar}");
                    }
                }

                let cpu = config(model, Path::new("."), Device::Cpu, Path::new("cache")).unwrap();
                assert!(cpu.classes.is_empty() && cpu.shapes.is_empty(), "{model}");
                assert_eq!(cpu.family, None, "{model}");
                assert_eq!(
                    cpu.placement,
                    INDIC_GRAPHS
                        .iter()
                        .map(|graph| (graph.to_string(), Device::Cpu))
                        .collect::<BTreeMap<_, _>>(),
                    "{model}"
                );
                let npu = config(model, Path::new("."), Device::Npu, Path::new("cache"))
                    .unwrap_err()
                    .to_string();
                assert_eq!(npu, "indic-tiny-* does not run on the NPU");
            }
        }

        #[test]
        fn indic_decoder_and_vocoder_stay_dynamic_on_the_gpu() {
            let family = StaticFamily::IndicTiny;
            assert!(
                family.dynamic("flow_decoder"),
                "zero-padded decoder frames changed the mel by up to 8% on the GPU and the CPU"
            );
            assert!(family.dynamic("vocoder"));
            assert!(!family.dynamic("text_encoder"));
            for graph in [
                "duration_predictor",
                "text_encoder",
                "vector_estimator",
                "vocoder",
            ] {
                assert!(!StaticFamily::Supertonic.dynamic(graph), "{graph}");
            }
        }

        #[test]
        fn indic_graphs_stay_at_default_gpu_precision() {
            for graph in INDIC_GRAPHS {
                assert!(!StaticFamily::IndicTiny.full_precision(graph), "{graph}");
            }
            assert!(StaticFamily::Supertonic.full_precision("text_encoder"));
            assert!(!StaticFamily::Supertonic.full_precision("vector_estimator"));
        }
    }

    mod gpu_classes {
        use super::*;
        #[test]
        fn smallest_fitting_class_is_chosen() {
            let cfg = config(
                "supertonic-3",
                Path::new("."),
                Device::Gpu,
                Path::new("cache"),
            )
            .unwrap();
            assert_eq!(cfg.classes.len(), 6);
            let first = supertonic_shapes(cfg.classes[0]);
            assert_eq!(first["vector_estimator"]["text_emb"], [1, 256, 32]);
            assert_eq!(first["vector_estimator"]["noisy_latent"], [1, 144, 48]);
            assert_eq!(first["vector_estimator"]["text_mask"], [1, 1, 32]);
            assert_eq!(first["vector_estimator"]["latent_mask"], [1, 1, 48]);
            for (index, class) in cfg.classes.iter().enumerate() {
                assert_eq!(
                    crate::padding::class_index(&cfg.classes, class.text, class.frames).unwrap(),
                    index
                );
            }
            assert_eq!(
                crate::padding::class_index(&cfg.classes, 70, 150).unwrap(),
                2
            );
            assert_eq!(
                crate::padding::class_index(&cfg.classes, 180, 100).unwrap(),
                3
            );
            assert!(
                crate::padding::class_index(&cfg.classes, 305, 1)
                    .unwrap_err()
                    .is::<crate::padding::StaticCapacity>()
            );
            assert!(
                crate::padding::class_index(&cfg.classes, 1, 417)
                    .unwrap_err()
                    .is::<crate::padding::StaticCapacity>()
            );
            for device in [Device::Cpu, Device::Npu] {
                assert!(
                    config("supertonic-3", Path::new("."), device, Path::new("cache"))
                        .unwrap()
                        .classes
                        .is_empty()
                );
            }
        }
    }
}
