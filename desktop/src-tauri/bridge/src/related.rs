//! Related domains: sites that share one account across registrable domains
//! (`plans/04-domain-matching.md`, "Related domains"), for the `related` tier.
//!
//! The data is Apple's password-manager-resources `quirks/shared-credentials.json` (MIT,
//! `data/LICENSE-password-manager-resources.md`), vendored at the commit in
//! `data/shared-credentials.commit` and refreshed by `scripts/update-related-domains.sh`.
//! It's built into the binary and read once, on first use. Upstream has two kinds of entry:
//!
//! - `shared`: each domain's logins are offered on every other (`steampowered.com`,
//!   `steamcommunity.com`);
//! - `from` → `to`: logins saved for a `from` domain are offered on the `to` domains, not
//!   the other way round (`twitter.com` → `x.com`).
//!
//! A registrable domain in the data stands for its whole site, as the `subdomain` tier
//! does; a longer name (`id.atlassian.com`) stands for that one host only.
//!
//! Upstream asks that the list never release a login without the user's say: a `related`
//! card fills on a click only, and shows the site it was saved for.

use std::{collections::HashMap, sync::OnceLock};

use serde::Deserialize;

use crate::matcher::Saved;

const DATA: &str = include_str!("data/shared-credentials.json");

/// The upstream commit the data was taken at.
pub fn commit() -> &'static str {
    include_str!("data/shared-credentials.commit").trim()
}

/// One upstream entry, as the file has it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Upstream {
    #[serde(default)]
    shared: Vec<String>,
    #[serde(default)]
    from: Vec<String>,
    #[serde(default)]
    to: Vec<String>,
    /// The `from` domains no longer serve logins: nothing changes for matching.
    #[serde(default, rename = "fromDomainsAreObsoleted")]
    _obsolete: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    Shared,
    From,
    To,
}

/// Every domain (or single host) in the data, with the entries it's in and how.
#[derive(Default)]
struct Groups {
    of: HashMap<Box<str>, Vec<(u32, Role)>>,
}

fn groups() -> &'static Groups {
    static GROUPS: OnceLock<Groups> = OnceLock::new();
    // A file that no longer parses (a refresh brought a new format) relates nothing; the
    // tests catch it before it ships.
    GROUPS.get_or_init(|| parse(DATA).unwrap_or_default())
}

/// What a data domain is filed under: its host as the matcher normalises it (lowercase,
/// no `www.`), when that's in a registrable domain. Bare public suffixes, addresses and
/// anything with a port or a path are left out.
fn key(domain: &str) -> Option<String> {
    match Saved::parse(domain) {
        Saved::Domain { host, registrable: Some(_), port: None, scheme: None } if !domain.contains('/') => Some(host),
        _ => None,
    }
}

fn parse(json: &str) -> Option<Groups> {
    let entries: Vec<Upstream> = serde_json::from_str(json).ok()?;
    let mut groups = Groups::default();
    for (index, entry) in entries.iter().enumerate() {
        let index = u32::try_from(index).ok()?;
        // One kind or the other, never both, never half a pair.
        let shared = !entry.shared.is_empty() && entry.from.is_empty() && entry.to.is_empty();
        let one_way = entry.shared.is_empty() && !entry.from.is_empty() && !entry.to.is_empty();
        if !shared && !one_way {
            continue;
        }
        for (list, role) in [(&entry.shared, Role::Shared), (&entry.from, Role::From), (&entry.to, Role::To)] {
            for name in list.iter().filter_map(|domain| key(domain)) {
                let roles = groups.of.entry(name.into_boxed_str()).or_default();
                if !roles.contains(&(index, role)) {
                    roles.push((index, role));
                }
            }
        }
    }
    Some(groups)
}

/// The entries a host is in: through its registrable domain, and as itself.
fn roles<'a>(groups: &'a Groups, host: &str, registrable: &str) -> impl Iterator<Item = (u32, Role)> + use<'a> {
    let site = groups.of.get(registrable);
    let one = if host == registrable { None } else { groups.of.get(host) };
    site.into_iter().chain(one).flatten().copied()
}

/// Is this host in the data at all (through its registrable domain, or as itself)?
pub fn listed(host: &str, registrable: &str) -> bool {
    roles(groups(), host, registrable).next().is_some()
}

/// Are logins saved for `saved_host` offered on `page_host` through the data? Hosts as the
/// matcher normalises them, with their registrable domains. The same registrable domain is
/// never "related": it's the same site (`exact` or `subdomain`).
pub fn related(saved_host: &str, saved_registrable: &str, page_host: &str, page_registrable: &str) -> bool {
    if saved_registrable == page_registrable {
        return false;
    }
    let groups = groups();
    roles(groups, page_host, page_registrable).any(|(entry, page)| {
        roles(groups, saved_host, saved_registrable)
            .any(|(other, saved)| other == entry && matches!((saved, page), (Role::Shared, Role::Shared) | (Role::From, Role::To)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(saved: &str, page: &str) -> bool {
        let registrable = |host: &str| psl::domain_str(host).unwrap_or(host).to_owned();
        related(saved, &registrable(saved), page, &registrable(page))
    }

    #[test]
    fn the_vendored_data_is_whole_and_pinned() {
        assert!(commit().len() == 40 && commit().bytes().all(|b| b.is_ascii_hexdigit()), "{:?}", commit());
        let entries: Vec<Upstream> = serde_json::from_str(DATA).expect("upstream's format is the one read here");
        assert!(entries.len() > 50, "{} entries", entries.len());
        for entry in &entries {
            let shared = !entry.shared.is_empty() && entry.from.is_empty() && entry.to.is_empty();
            let one_way = entry.shared.is_empty() && !entry.from.is_empty() && !entry.to.is_empty();
            assert!(shared || one_way, "an entry of neither kind: {:?} {:?} {:?}", entry.shared, entry.from, entry.to);
            // Every name is a domain the matcher reads as one (or a bare public suffix,
            // which relates nothing).
            for domain in entry.shared.iter().chain(&entry.from).chain(&entry.to) {
                assert!(key(domain).is_some() || psl::domain_str(domain).is_none(), "{domain}");
            }
        }
        assert!(groups().of.len() > 300, "{} names", groups().of.len());
    }

    #[test]
    fn shared_groups_go_both_ways() {
        assert!(check("steampowered.com", "steamcommunity.com"));
        assert!(check("steamcommunity.com", "steampowered.com"));
        // A registrable domain stands for its whole site.
        assert!(check("store.steampowered.com", "steamcommunity.com"));
        assert!(check("airbnb.fr", "airbnb.co.uk"));
        assert!(check("ebay.com", "ebay.de"));
    }

    #[test]
    fn one_way_entries_go_one_way() {
        assert!(check("twitter.com", "x.com"));
        assert!(!check("x.com", "twitter.com"));
        assert!(check("discordapp.com", "discord.com"));
        assert!(!check("discord.com", "discordapp.com"));
        // Two `from` domains of one entry aren't related to each other.
        assert!(!check("trello.com", "bitbucket.org"));
    }

    #[test]
    fn a_single_host_in_the_data_is_that_host_only() {
        assert!(check("trello.com", "id.atlassian.com"));
        assert!(!check("trello.com", "atlassian.com"));
        assert!(!check("trello.com", "evil.id.atlassian.com"));
        assert!(!check("trello.com", "start.atlassian.com"));
        assert!(check("wikipedia.org", "commons.wikimedia.org"));
        assert!(!check("wikipedia.org", "wikimedia.org"));
    }

    #[test]
    fn pages_know_whether_they_are_listed() {
        assert!(listed("steamcommunity.com", "steamcommunity.com"));
        assert!(listed("store.steampowered.com", "steampowered.com"));
        assert!(listed("id.atlassian.com", "atlassian.com"));
        assert!(!listed("start.atlassian.com", "atlassian.com"));
        assert!(!listed("github.com", "github.com"));
    }

    #[test]
    fn everything_else_is_unrelated() {
        for (saved, page) in [
            ("github.com", "gitlab.com"),
            ("steampowered.com", "steampowered.com"),
            ("steampowered.com", "steamcommunity.com.evil.io"),
            ("steampowered.com", "steamcommunlty.com"),
            ("evil.io", "steamcommunity.com"),
            ("", ""),
        ] {
            assert!(!check(saved, page), "{saved} → {page}");
        }
    }

    #[test]
    fn malformed_entries_relate_nothing() {
        let groups = parse(r#"[{"shared":["a.com"],"from":["b.com"],"to":["c.com"]},{"from":["d.com"]},{"to":["e.com"]},{"shared":["co.uk","f.co.uk"]}]"#).unwrap();
        assert_eq!(groups.of.keys().map(|k| &**k).collect::<Vec<_>>(), ["f.co.uk"]);
        assert!(parse(r#"[{"shared":["a.com","b.com"],"new":true}]"#).is_none(), "an unknown format is refused whole");
        assert!(parse("{}").is_none());
    }
}
