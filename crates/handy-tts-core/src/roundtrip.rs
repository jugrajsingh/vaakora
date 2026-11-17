//! The round-trip match: what speech-to-text heard against the words a voice was asked to say.

/// Words for comparison: lowercase, every character that is not a letter or digit read as a
/// space, and runs of single-letter words joined, so "G P U." and "GPU" both give `["gpu"]`.
pub fn normalise(text: &str) -> Vec<String> {
    let spaced: String = text
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    let mut words: Vec<String> = Vec::new();
    let mut letters = String::new();
    for word in spaced.split_whitespace().map(str::to_lowercase) {
        let mut chars = word.chars();
        let single_letter = chars.next().is_some_and(char::is_alphabetic) && chars.next().is_none();
        if single_letter {
            letters.push_str(&word);
            continue;
        }
        if !letters.is_empty() {
            words.push(std::mem::take(&mut letters));
        }
        words.push(word);
    }
    if !letters.is_empty() {
        words.push(letters);
    }
    words
}

/// Whether the expected words appear, in order and next to each other, in what was heard. An
/// empty expectation matches only when nothing was heard.
pub fn heard_matches(heard: &str, expected: &str) -> bool {
    let heard = normalise(heard);
    let expected = normalise(expected);
    if expected.is_empty() {
        return heard.is_empty();
    }
    heard
        .windows(expected.len())
        .any(|words| words == expected.as_slice())
}

#[cfg(test)]
mod tests {
    use super::*;

    mod normalise {
        use super::*;

        #[test]
        fn joins_spaced_letters_and_drops_punctuation() {
            assert_eq!(normalise("G P U."), ["gpu"]);
        }

        #[test]
        fn joins_only_the_single_letters() {
            assert_eq!(normalise("README dot M D"), ["readme", "dot", "md"]);
        }

        #[test]
        fn reads_punctuation_as_spaces() {
            assert_eq!(normalise("Read me, dot MD!"), ["read", "me", "dot", "md"]);
        }
    }

    mod heard_matches {
        use super::*;

        #[test]
        fn finds_the_expected_words_inside_a_longer_transcript() {
            assert!(heard_matches("Open README dot MD now.", "README dot M D"));
        }

        #[test]
        fn refuses_a_different_reading() {
            assert!(!heard_matches("readme dot markdown", "README dot M D"));
        }

        #[test]
        fn empty_expectation_matches_only_silence() {
            assert!(heard_matches("", ""));
            assert!(!heard_matches("something", ""));
        }
    }
}
