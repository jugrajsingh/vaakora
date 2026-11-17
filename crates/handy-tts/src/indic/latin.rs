//! Latin letters in Hindi and Punjabi text spelled as English letter names in the model's script (Handy addition).
use super::Lang;

/// English letter names in Devanagari, NFC (decomposed nukta).
const HINDI: &[(char, &str)] = &[
    ('A', "ए"),
    ('B', "बी"),
    ('C', "सी"),
    ('D', "डी"),
    ('E', "ई"),
    ('F', "\u{090f}\u{092b}\u{093c}"),
    ('G', "जी"),
    ('H', "एच"),
    ('I', "आई"),
    ('J', "जे"),
    ('K', "के"),
    ('L', "एल"),
    ('M', "एम"),
    ('N', "एन"),
    ('O', "ओ"),
    ('P', "पी"),
    ('Q', "क्यू"),
    ('R', "आर"),
    ('S', "एस"),
    ('T', "टी"),
    ('U', "यू"),
    ('V', "वी"),
    ('W', "डब्ल्यू"),
    ('X', "एक्स"),
    ('Y', "वाई"),
    ('Z', "\u{091c}\u{093c}\u{0947}\u{0921}"),
];

/// English letter names in Gurmukhi, NFC (decomposed nukta).
const PUNJABI: &[(char, &str)] = &[
    ('A', "ਏ"),
    ('B', "ਬੀ"),
    ('C', "ਸੀ"),
    ('D', "ਡੀ"),
    ('E', "ਈ"),
    ('F', "ਐੱਫ"),
    ('G', "ਜੀ"),
    ('H', "ਐੱਚ"),
    ('I', "ਆਈ"),
    ('J', "ਜੇ"),
    ('K', "ਕੇ"),
    ('L', "ਐੱਲ"),
    ('M', "ਐੱਮ"),
    ('N', "ਐੱਨ"),
    ('O', "ਓ"),
    ('P', "ਪੀ"),
    ('Q', "ਕਿਊ"),
    ('R', "ਆਰ"),
    ('S', "ਐੱਸ"),
    ('T', "ਟੀ"),
    ('U', "ਯੂ"),
    ('V', "ਵੀ"),
    ('W', "ਡਬਲਯੂ"),
    ('X', "ਐਕਸ"),
    ('Y', "ਵਾਈ"),
    ('Z', "\u{0a1c}\u{0a3c}\u{0a48}\u{0a71}\u{0a21}"),
];

/// Replaces every ASCII letter run with its letter names joined by single spaces; returns the count spelled.
pub(crate) fn spell_latin(text: &str, lang: Lang) -> (String, usize) {
    let table = match lang {
        Lang::En => return (text.to_string(), 0),
        Lang::Hi => HINDI,
        Lang::Pa => PUNJABI,
    };
    let mut out = String::with_capacity(text.len() * 3);
    let mut run: Vec<&str> = Vec::new();
    let mut spelled = 0;
    for ch in text.chars() {
        let upper = ch.to_ascii_uppercase();
        let name = ch
            .is_ascii_alphabetic()
            .then(|| table.iter().find(|(letter, _)| *letter == upper))
            .flatten();
        if let Some((_, name)) = name {
            run.push(name);
            spelled += 1;
            continue;
        }
        out.push_str(&run.join(" "));
        run.clear();
        out.push(ch);
    }
    out.push_str(&run.join(" "));
    (out, spelled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spell_latin_hindi_and_punjabi() {
        assert_eq!(
            spell_latin("इस GPU पर", Lang::Hi),
            ("इस जी पी यू पर".to_string(), 3)
        );
        assert_eq!(
            spell_latin("ਇਸ gpu ਉੱਤੇ", Lang::Pa),
            ("ਇਸ ਜੀ ਪੀ ਯੂ ਉੱਤੇ".to_string(), 3)
        );
        assert_eq!(
            spell_latin("README.md", Lang::Hi),
            ("आर ई ए डी एम ई.एम डी".to_string(), 8)
        );
        assert_eq!(spell_latin("GPU", Lang::En), ("GPU".to_string(), 0));
        assert_eq!(
            spell_latin("www", Lang::Hi),
            ("डब्ल्यू डब्ल्यू डब्ल्यू".to_string(), 3)
        );
    }

    #[test]
    fn every_letter_name_is_nfc_and_in_the_model_vocabulary() {
        use unicode_normalization::UnicodeNormalization;
        for (lang, fixture) in [
            (
                Lang::Hi,
                include_str!("../../tests/fixtures/indic-tiny/hi-frontend.json"),
            ),
            (
                Lang::Pa,
                include_str!("../../tests/fixtures/indic-tiny/pa-frontend.json"),
            ),
        ] {
            let doc: serde_json::Value = serde_json::from_str(fixture).unwrap();
            let symbols: Vec<&str> = doc["symbols"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap())
                .collect();
            for letter in 'A'..='Z' {
                let (name, count) = spell_latin(&letter.to_string(), lang);
                assert_eq!(count, 1, "{lang:?} {letter}");
                assert_eq!(
                    name.nfc().collect::<String>(),
                    name,
                    "{lang:?} {letter} is not NFC"
                );
                for ch in name.chars() {
                    assert!(
                        symbols.contains(&format!("c:{ch}").as_str()),
                        "{lang:?} {letter}: {ch:?} not in the vocabulary"
                    );
                }
            }
        }
    }
}
