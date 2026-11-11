//! The recovery code: the one way back into the vault when the master password is
//! forgotten. 24 words from the BIP39 English list (`recovery-words.txt`, 2048 words,
//! SHA-256 2f5eed53…dbda): 256 random bits and an 8-bit checksum, 11 bits per word.
//!
//! 256 bits can't be guessed: even at a trillion guesses a second, trying them all
//! takes about 10^57 years. On top of that, each guess costs an Argon2id run, because
//! the key that opens the vault is derived from the code's bits the same way as from a
//! master password (`crypto::derive_keys_from_bytes`), with a salt of its own.
//!
//! The checksum catches a mistyped or swapped word before any key is derived. Each word
//! is known by its first four letters, so "abando" or "aban" read as "abandon".

use std::sync::LazyLock;

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::crypto;
use crate::error::{VaultError, VaultResult};

pub const WORDS: usize = 24;
const ENTROPY_BYTES: usize = 32;

static LIST: LazyLock<Vec<&'static str>> =
    LazyLock::new(|| include_str!("recovery-words.txt").split_whitespace().collect());

/// The code's 256 random bits.
pub type Entropy = Zeroizing<[u8; ENTROPY_BYTES]>;

fn checksum(entropy: &[u8; ENTROPY_BYTES]) -> u8 {
    Sha256::digest(entropy)[0]
}

/// A new code: its words, and the bits they stand for.
pub fn generate() -> (Zeroizing<Vec<String>>, Entropy) {
    let entropy: Entropy = Zeroizing::new(crypto::random_bytes());
    (words_of(&entropy), entropy)
}

/// The 24 words for 256 bits (BIP39: the bits, then the checksum's 8, 11 at a time).
fn words_of(entropy: &[u8; ENTROPY_BYTES]) -> Zeroizing<Vec<String>> {
    let mut bits = Zeroizing::new([0u8; ENTROPY_BYTES + 1]);
    bits[..ENTROPY_BYTES].copy_from_slice(entropy);
    bits[ENTROPY_BYTES] = checksum(entropy);
    let bit = |i: usize| (bits[i / 8] >> (7 - i % 8)) & 1;
    Zeroizing::new(
        (0..WORDS)
            .map(|w| {
                let index = (0..11).fold(0usize, |acc, b| (acc << 1) | usize::from(bit(w * 11 + b)));
                LIST[index].to_owned()
            })
            .collect(),
    )
}

fn index_of(word: &str) -> Option<usize> {
    if let Ok(exact) = LIST.binary_search(&word) {
        return Some(exact);
    }
    // Typed by its first four letters or more: every word is unique by its first four,
    // so at most one word starts with what was typed.
    if word.len() < 4 {
        return None;
    }
    LIST.iter().position(|listed| listed.starts_with(word))
}

/// Reads a code as typed: any case, spaces, commas, new lines or numbering between
/// the words. Errors say which word is wrong, or that the checksum doesn't match.
pub fn parse(typed: &str) -> VaultResult<Entropy> {
    let words: Vec<String> = typed
        .split(|c: char| !c.is_ascii_alphabetic())
        .filter(|w| !w.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();
    if words.len() != WORDS {
        return Err(VaultError::invalid_input(format!(
            "A recovery code has {WORDS} words; this has {}.",
            words.len()
        )));
    }
    let mut bits = Zeroizing::new([0u8; ENTROPY_BYTES + 1]);
    for (w, word) in words.iter().enumerate() {
        let index = index_of(word).ok_or_else(|| {
            VaultError::invalid_input(format!("Word {} (“{word}”) isn’t in the recovery word list.", w + 1))
        })?;
        for b in 0..11 {
            if (index >> (10 - b)) & 1 == 1 {
                let i = w * 11 + b;
                bits[i / 8] |= 1 << (7 - i % 8);
            }
        }
    }
    let mut entropy: Entropy = Zeroizing::new([0u8; ENTROPY_BYTES]);
    entropy.copy_from_slice(&bits[..ENTROPY_BYTES]);
    if checksum(&entropy) != bits[ENTROPY_BYTES] {
        return Err(VaultError::invalid_input(
            "Those words don’t form a valid recovery code: one may be mistyped or out of order.",
        ));
    }
    Ok(entropy)
}

/// Whether `typed` is the word at that place of the code (as [`parse`] reads words).
pub fn word_matches(expected: &str, typed: &str) -> bool {
    let typed = typed.trim().to_ascii_lowercase();
    index_of(&typed).is_some_and(|i| LIST[i] == expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_is_the_bip39_english_list() {
        assert_eq!(LIST.len(), 2048);
        assert_eq!((LIST[0], LIST[2047]), ("abandon", "zoo"));
        assert!(LIST.windows(2).all(|w| w[0] < w[1]), "sorted and unique");
        let prefixes: std::collections::HashSet<_> = LIST.iter().map(|w| &w[..4.min(w.len())]).collect();
        assert_eq!(prefixes.len(), 2048, "unique by their first four letters");
    }

    #[test]
    fn matches_the_bip39_test_vector() {
        // BIP39 reference vector: 32 bytes of 0x00 → "abandon" ×23 + "art".
        let words = words_of(&[0u8; 32]);
        assert_eq!(words.join(" "), format!("{} art", ["abandon"; 23].join(" ")));
        // 32 bytes of 0x7f → "legal winner thank year wave sausage worth useful legal winner
        // thank year wave sausage worth useful legal winner thank year wave sausage worth title".
        let words = words_of(&[0x7f; 32]);
        assert_eq!(words[0], "legal");
        assert_eq!(words[23], "title");
    }

    #[test]
    fn round_trips_and_reads_codes_as_people_type_them() {
        for _ in 0..50 {
            let (words, entropy) = generate();
            assert_eq!(words.len(), 24);
            assert_eq!(*parse(&words.join(" ")).unwrap(), *entropy);
            let messy = words
                .iter()
                .enumerate()
                .map(|(i, w)| format!("{}. {}", i + 1, if i % 2 == 0 { w.to_uppercase() } else { w[..4.min(w.len())].to_owned() }))
                .collect::<Vec<_>>()
                .join(",\n ");
            assert_eq!(*parse(&messy).unwrap(), *entropy);
        }
    }

    #[test]
    fn catches_a_wrong_missing_or_swapped_word() {
        let (words, _) = generate();
        let code = |words: &[String]| words.join(" ");
        assert!(parse(&code(&words[..23])).unwrap_err().message.contains("has 24 words; this has 23"));
        let mut typo = words.to_vec();
        typo[5] = "zzzz".into();
        assert!(parse(&code(&typo)).unwrap_err().message.starts_with("Word 6 (“zzzz”)"));
        // Swapping two different words breaks the checksum (all but ~1 in 256 swaps).
        let mut caught = 0;
        for i in 0..23 {
            let mut swapped = words.to_vec();
            swapped.swap(i, i + 1);
            if swapped != *words && parse(&code(&swapped)).is_err() {
                caught += 1;
            }
        }
        assert!(caught >= 20, "caught {caught} of 23 swaps");
    }
}
