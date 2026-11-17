//! Lookbehind and lookahead conditions of Python patterns on top of `regex` (which has neither).
use regex::{Captures, Regex};

/// Matches of `re` that `keep(text, start, end)` accepts, in Python's scan order: after a rejected match the
/// scan resumes one character after its start, after an accepted one at its end.
pub(crate) fn guarded_matches<'t>(
    text: &'t str,
    re: &Regex,
    keep: impl Fn(&str, usize, usize) -> bool,
) -> Vec<Captures<'t>> {
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(caps) = re.captures_at(text, at) {
        let whole = caps.get(0).expect("group 0 is the whole match");
        let next_char = whole.start()
            + text[whole.start()..]
                .chars()
                .next()
                .map_or(1, char::len_utf8);
        if keep(text, whole.start(), whole.end()) {
            at = if whole.is_empty() {
                next_char
            } else {
                whole.end()
            };
            found.push(caps);
        } else {
            at = next_char;
        }
        if at > text.len() {
            break;
        }
    }
    found
}

/// Replaces every match of `re` that `keep(text, start, end)` accepts, with Python's scan order.
pub(crate) fn replace_guarded(
    text: &str,
    re: &Regex,
    keep: impl Fn(&str, usize, usize) -> bool,
    with: impl Fn(&Captures) -> String,
) -> String {
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    for caps in guarded_matches(text, re, keep) {
        let whole = caps.get(0).expect("group 0 is the whole match");
        out.push_str(&text[copied..whole.start()]);
        out.push_str(&with(&caps));
        copied = whole.end();
    }
    out.push_str(&text[copied..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejected_lookbehind_resumes_one_character_later() {
        let re = regex::Regex::new(r"\d+").unwrap();
        let out = replace_guarded(
            "a1 22",
            &re,
            |t, s, _| !t[..s].ends_with('a'),
            |_| "#".into(),
        );
        assert_eq!(out, "a1 #"); // "1" rejected (after 'a'), "22" replaced
        let resumed = replace_guarded("a12", &re, |t, s, _| !t[..s].ends_with('a'), |_| "#".into());
        assert_eq!(resumed, "a1#", "Python re.sub(r'(?<!a)\\d+', '#', 'a12')");
    }
}
