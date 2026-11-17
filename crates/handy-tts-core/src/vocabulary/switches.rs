//! Per-entry switches: the `disabled` lists of a vocabulary file, at the top level and inside
//! each `models.<id>`. `mine` switches off the file's own entries in that scope, `builtin` the
//! built-in entries in that scope.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::Sections;

/// Keys switched off, per section. Extension keys are lowercased; a key with no entry is
/// ignored.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Switches {
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    pub symbols: BTreeSet<String>,
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    pub extensions: BTreeSet<String>,
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    pub terms: BTreeSet<String>,
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    pub acronyms: BTreeSet<String>,
}

/// The `disabled` object of one scope.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Disabled {
    /// Switches off the owner's own entries in this scope.
    #[serde(skip_serializing_if = "Switches::is_empty")]
    pub mine: Switches,
    /// Switches off the built-in entries in this scope; at the top level, also the same built-in
    /// keys in every `models.<id>` section, so the switch acts for every voice.
    #[serde(skip_serializing_if = "Switches::is_empty")]
    pub builtin: Switches,
}

impl Switches {
    /// The switches with extension keys lowercased, matching how extensions are stored.
    fn normalised(self) -> Switches {
        Switches {
            extensions: self
                .extensions
                .into_iter()
                .map(|key| key.to_lowercase())
                .collect(),
            ..self
        }
    }

    /// True when no key is switched off.
    pub fn is_empty(&self) -> bool {
        self.symbols.is_empty()
            && self.extensions.is_empty()
            && self.terms.is_empty()
            && self.acronyms.is_empty()
    }

    /// `sections` without the entries switched off here.
    pub(super) fn filter(&self, sections: &Sections) -> Sections {
        if self.is_empty() {
            return sections.clone();
        }
        Sections {
            symbols: sections
                .symbols
                .iter()
                .filter(|(key, _)| !self.symbols.contains(*key))
                .map(|(key, spoken)| (key.clone(), spoken.clone()))
                .collect(),
            extensions: sections
                .extensions
                .iter()
                .filter(|(key, _)| !self.extensions.contains(*key))
                .map(|(key, spoken)| (key.clone(), spoken.clone()))
                .collect(),
            terms: sections
                .terms
                .iter()
                .filter(|(key, _)| !self.terms.contains(key))
                .cloned()
                .collect(),
            acronyms: sections
                .acronyms
                .difference(&self.acronyms)
                .cloned()
                .collect(),
            acronym_style: sections.acronym_style,
        }
    }
}

impl Disabled {
    /// True when nothing is switched off in this scope.
    pub fn is_empty(&self) -> bool {
        self.mine.is_empty() && self.builtin.is_empty()
    }

    /// The lists as read from a file, with extension keys lowercased.
    pub(super) fn normalised(self) -> Disabled {
        Disabled {
            mine: self.mine.normalised(),
            builtin: self.builtin.normalised(),
        }
    }
}
