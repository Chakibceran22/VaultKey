//! Fuzzes the matcher's normaliser (`extension/plans/04-domain-matching.md`, "Tests").
//! Saved websites are free text and page URLs come from anywhere on the web, so for any
//! input: parsing never panics, normalising twice changes nothing, comparing never panics,
//! a fill never crosses registrable domains except through the related-domains data, and
//! reading a sign-in page's relying party never panics.
//!
//! An input is a saved website, a newline, then a page URL (no newline: both are the
//! input). To run it (a nightly toolchain, and `cargo install cargo-fuzz` once):
//!
//! ```sh
//! cd desktop/src-tauri/bridge/fuzz
//! cargo +nightly fuzz run normalise -- -max_len=1024 -max_total_time=600
//! ```
//!
//! A crash is saved under `artifacts/normalise/`; `cargo +nightly fuzz run normalise
//! <that file>` replays it. Then add it to `matcher.rs`'s table. The normal suite runs the
//! same checks on fixed random input
//! (`matcher::tests::random_input_never_panics_and_normalises_once`).

#![no_main]

use libfuzzer_sys::fuzz_target;
use vaultkey_bridge::{
    matcher::{Page, Saved, Scheme, Tier, Verdict, compare},
    provider,
};

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else { return };
    let (saved_text, page_text) = text.split_once('\n').unwrap_or((text, text));

    let saved = Saved::parse(saved_text);
    if let Some(canonical) = saved.canonical() {
        assert_eq!(Saved::parse(&canonical), saved, "{saved_text:?} → {canonical:?}");
    }

    if let Some(page) = Page::parse(page_text) {
        let scheme = if page.scheme == Scheme::Https { "https" } else { "http" };
        let again = format!("{scheme}://{}/", page.label());
        assert_eq!(Page::parse(&again).as_ref(), Some(&page), "{page_text:?} → {again:?}");
        if let Verdict::Fill(tier) = compare(&saved, &page) {
            let (host, registrable) = match &saved {
                Saved::Domain { host, registrable, .. } => (host, registrable.as_deref()),
                Saved::Address { host, .. } => (host, None),
                Saved::NameOnly => panic!("a name only matched {page_text:?}"),
            };
            let same_site = *host == page.host || (registrable.is_some() && registrable == page.registrable.as_deref());
            assert!(same_site || tier == Tier::Related, "{saved_text:?} on {page_text:?}: {tier:?}");
            assert_ne!(tier, Tier::Search);
        }
    }

    let _ = provider::relying_party(page_text);
});
