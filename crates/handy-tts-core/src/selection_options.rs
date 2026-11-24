use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::formatted::tables::TableStyle;
use crate::vocabulary::TechnicalOptions;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct Selection {
    pub model_id: String,
    pub voice: String,
    pub speed: f32,
    pub pitch: f32,
    pub output_device: Option<String>,
    pub read_code: bool,
    /// Paths, file names, flags and identifiers are read with the vocabulary. Older payloads
    /// lack it and read with it off.
    #[serde(default)]
    pub technical: bool,
    /// With technical reading, every path segment is read; off reads the last one.
    #[serde(default = "full_paths_default")]
    pub full_paths: bool,
    /// With technical reading, a link's host and path are read; off keeps "link to <host>".
    #[serde(default)]
    pub full_links: bool,
    /// How tables are spoken. Older payloads lack it and read each value with its column name.
    #[serde(default)]
    pub tables: TableStyle,
}
fn full_paths_default() -> bool {
    TechnicalOptions::default().full_paths
}
impl Selection {
    /// The full or short path and link choice technical reading uses.
    pub fn technical_options(&self) -> TechnicalOptions {
        TechnicalOptions {
            full_paths: self.full_paths,
            full_links: self.full_links,
            tables: self.tables,
        }
    }
}
#[derive(Debug, Error, Clone, PartialEq)]
pub enum SelectionError {
    #[error("tts.errors.unknownModel")]
    Model,
    #[error("tts.errors.invalidControls")]
    Controls,
    #[error("tts.errors.invalidVoice")]
    Voice,
    #[error("tts.errors.settings")]
    Persist,
}
pub fn maximum_speed(model_id: &str) -> Result<f32, SelectionError> {
    crate::catalog::entry(model_id)
        .map(|_| 2.0)
        .map_err(|_| SelectionError::Model)
}
pub fn clamp_selection(mut selection: Selection) -> Result<Selection, SelectionError> {
    let maximum = maximum_speed(&selection.model_id)?;
    if !selection.speed.is_finite()
        || !selection.pitch.is_finite()
        || selection.speed < 0.5
        || selection.speed > 2.0
        || !(-6.0..=6.0).contains(&selection.pitch)
        || (selection.speed * 10.0 - (selection.speed * 10.0).round()).abs() > 0.001
    {
        return Err(SelectionError::Controls);
    }
    selection.speed = selection.speed.min(maximum);
    Ok(selection)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maximum_speed_follows_the_catalog() {
        for id in crate::catalog::ids().unwrap() {
            assert_eq!(maximum_speed(id), Ok(2.0));
        }
        assert_eq!(maximum_speed("ghost"), Err(SelectionError::Model));
    }
    #[test]
    fn older_selection_payloads_read_name_each() {
        let older = r#"{"model_id":"pocket-en","voice":"alba","speed":1.0,"pitch":0.0,
            "output_device":null,"read_code":false}"#;
        let selection: Selection = serde_json::from_str(older).unwrap();
        assert_eq!(selection.tables, TableStyle::NameEach);
        assert_eq!(selection.technical_options().tables, TableStyle::NameEach);
        let once = older.replace(
            "\"read_code\":false",
            "\"read_code\":false,\"tables\":\"names_once\"",
        );
        let selection: Selection = serde_json::from_str(&once).unwrap();
        assert_eq!(selection.tables, TableStyle::NamesOnce);
        assert_eq!(selection.technical_options().tables, selection.tables);
        assert_eq!(selection.technical_options().tables, TableStyle::NamesOnce);
    }
}
