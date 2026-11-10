//! Words and spelling: how a typed word is compared with a record's name.

use unicode_normalization_alignments::UnicodeNormalization;

/// Parts of names that say nothing on their own.
const NOISE: &[&str] = &[
    "www", "com", "net", "org", "fr", "io", "co", "me", "so", "gg", "tv", "uk", "eu", "us", "http", "https",
];

/// Accents dropped, lowercased, split on anything that is not a-z or 0-9.
fn split(value: &str) -> Vec<String> {
    let folded: String = value
        .nfd()
        .map(|(c, _)| c)
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect::<String>()
        .to_lowercase();
    folded
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .filter(|w| !w.is_empty() && !NOISE.contains(w))
        .map(str::to_owned)
        .collect()
}

/// "BattleNet.com" → battle, battlenet ("net" is noise); "STRIPE_SECRET_KEY" → stripe, secret, key;
/// accents dropped ("Électricité" → electricite).
pub fn words(text: &str) -> Vec<String> {
    let mut spaced = String::with_capacity(text.len() + 4);
    let mut prev = None;
    for c in text.chars() {
        if prev.is_some_and(|p: char| p.is_ascii_lowercase()) && c.is_ascii_uppercase() {
            spaced.push(' ');
        }
        spaced.push(c);
        prev = Some(c);
    }
    let mut parts = split(&spaced);
    // Keep camel-cased names whole as well: "battlenet" finds BattleNet.
    let whole: Vec<String> = split(text).into_iter().filter(|w| !parts.contains(w)).collect();
    parts.extend(whole);
    parts
}

/// A name with accents, case, spaces and punctuation gone: "Lumen-Post" → lumenpost.
pub fn squash(text: &str) -> String {
    split(text).concat()
}

/// Two neighbouring letters swapped: "githbu" for "github".
fn swapped(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = Vec::with_capacity(3);
    for i in 0..a.len() {
        if diff.len() > 2 {
            break;
        }
        if a[i] != b[i] {
            diff.push(i);
        }
    }
    diff.len() == 2 && diff[1] == diff[0] + 1 && a[diff[0]] == b[diff[1]] && a[diff[1]] == b[diff[0]]
}

/// At most one letter added, dropped or changed.
fn within_one_edit(a: &[u8], b: &[u8]) -> bool {
    if a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    let (mut i, mut j, mut edits) = (0, 0, 0);
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            i += 1;
            j += 1;
            continue;
        }
        edits += 1;
        if edits > 1 {
            return false;
        }
        if a.len() > b.len() {
            i += 1;
        } else if b.len() > a.len() {
            j += 1;
        } else {
            i += 1;
            j += 1;
        }
    }
    edits + (a.len() - i) + (b.len() - j) <= 1
}

/// How well a typed word names a term: 1 exact, less for a prefix, a part, a typo.
/// Both are outputs of [`words`], so plain ASCII.
pub fn quality(word: &str, term: &str) -> f64 {
    let (w, t) = (word.as_bytes(), term.as_bytes());
    if term == word {
        return 1.0;
    }
    if term.starts_with(word) && w.len() >= 2 {
        return 0.6 + 0.4 * (w.len() as f64 / t.len() as f64);
    }
    if w.len() >= 4 && term.contains(word) {
        return 0.5;
    }
    if w.len() >= 5 && (within_one_edit(w, t) || swapped(w, t)) {
        return 0.6;
    }
    let start = &t[..w.len().min(t.len())];
    if w.len() >= 5 && (within_one_edit(w, start) || swapped(w, start)) {
        return 0.55;
    }
    0.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_names_like_the_ui() {
        // "net" is noise, as in the UI (whose comment lists it, but whose code drops it).
        assert_eq!(words("BattleNet.com"), ["battle", "battlenet"]);
        assert_eq!(words("STRIPE_SECRET_KEY"), ["stripe", "secret", "key"]);
        assert_eq!(words("Électricité"), ["electricite"]);
        assert_eq!(words("https://coolify.acme.dev"), ["coolify", "acme", "dev"]);
    }

    #[test]
    fn grades_spelling() {
        assert_eq!(quality("github", "github"), 1.0);
        assert!((quality("git", "github") - 0.8).abs() < 1e-6);
        assert_eq!(quality("githbu", "github"), 0.6);
        assert_eq!(quality("spotfy", "spotify"), 0.6);
        assert_eq!(quality("xyz", "github"), 0.0);
    }
}
