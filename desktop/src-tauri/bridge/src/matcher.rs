//! Which saved websites belong to a page (`plans/04-domain-matching.md`). This is the
//! security boundary of filling: a page gets an account's login only if this says so,
//! and the app asks it again for every fill.
//!
//! Saved websites are free text (`domains.name`): `github.com`,
//! `https://accounts.google.com/signin`, `192.168.1.10:8000`, `GitHub`. Each is normalised
//! when it's read ([`Saved::parse`]), without changing what's stored. Pages come from the
//! browser ([`Page::parse`]), never from page content.
//!
//! - Same host: `exact`. Same registrable domain (Public Suffix List, private section
//!   included): `subdomain`. Two registrable domains that share one account in the
//!   vendored related-domains data (`related.rs`): `related`. Anything else: nothing, so
//!   `g1thub.com`, `github.com.evil.io` and `bob.github.io` never get `github.com`'s or
//!   `alice.github.io`'s login.
//! - Addresses (IPs, `localhost`, a single-label name with a port or a scheme) match the
//!   same host only.
//! - A name with no address (`GitHub`) is never matched automatically.
//! - Saved as `https`, page on `http`: refused, with a warning.

use serde::Serialize;
use url::{Host, Url};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scheme {
    Http,
    Https,
}

/// A saved website, normalised.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Saved {
    /// A host name with a dot: matched by registrable domain too.
    Domain { host: String, registrable: Option<String>, port: Option<u16>, scheme: Option<Scheme> },
    /// An IP address, `localhost`, or a single-label name given with a port or a scheme:
    /// the same host only.
    Address { host: String, port: Option<u16>, scheme: Option<Scheme> },
    /// "GitHub", "Coolify": never matched automatically (popup search finds it).
    NameOnly,
}

/// A page, as the browser reports it: http or https only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page {
    pub scheme: Scheme,
    pub host: String,
    /// The port when it isn't the scheme's default.
    pub port: Option<u16>,
    pub registrable: Option<String>,
    /// The page's site is in the related-domains data: worked out once, so the many
    /// pages that aren't cost nothing more per saved website.
    related: bool,
}

/// How certain a match is (plans/04, "Match tiers"), most certain first. The first three
/// fill on a click; `search` is never a match: it marks a popup search result, which fills
/// only once the user confirms it for this site.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Exact,
    Subdomain,
    Related,
    Search,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Fill(Tier),
    /// It would match, but it was saved for https and the page is http: no fill.
    Insecure,
    None,
}

/// The longest text read as a website (`validate_domain_name` caps saved ones at 253).
const MAX_INPUT: usize = 2048;

/// Host as compared: lowercase (the URL parser did it, and IDNA), without the root's
/// trailing dot, no leading `www.` (all of them: `www.www.x.com` is `x.com`, so normalising
/// twice changes nothing). IPv6 in brackets. A name with an empty label (`github.com..`,
/// `a..b`) is no host: no browser reaches it, and trimming it could turn it into another
/// (`192.168.1.10..` would read as that IP address).
///
/// `www.` stays when what's left is a public suffix: `www.github.io` is someone's site under
/// `github.io` (private section) and `www.com` a site under `com`; stripped, either would
/// be the bare suffix and match a login saved for it.
fn normal_host(host: Host<&str>) -> Option<(String, bool)> {
    match host {
        Host::Domain(domain) => {
            let mut domain = domain.strip_suffix('.').unwrap_or(domain);
            while let Some(rest) = domain.strip_prefix("www.")
                && psl::suffix_str(rest) != Some(rest)
            {
                domain = rest;
            }
            let labels_ok = !domain.is_empty() && domain.split('.').all(|label| !label.is_empty());
            (labels_ok && !domain.contains('*')).then(|| (domain.to_owned(), false))
        }
        Host::Ipv4(ip) => Some((ip.to_string(), true)),
        Host::Ipv6(ip) => Some((format!("[{ip}]"), true)),
    }
}

fn registrable(host: &str) -> Option<String> {
    psl::domain_str(host).map(str::to_owned)
}

fn scheme_of(url: &Url) -> Option<Scheme> {
    match url.scheme() {
        "https" => Some(Scheme::Https),
        "http" => Some(Scheme::Http),
        _ => None,
    }
}

impl Saved {
    pub fn parse(text: &str) -> Saved {
        let text = text.trim();
        if text.is_empty() || text.len() > MAX_INPUT {
            return Saved::NameOnly;
        }
        let given = text.contains("://");
        let parsed = if given { Url::parse(text) } else { Url::parse(&format!("https://{text}")) };
        let Ok(url) = parsed else { return Saved::NameOnly };
        let scheme = if given {
            match scheme_of(&url) {
                Some(scheme) => Some(scheme),
                // ssh://, ftp://…: not a web page.
                None => return Saved::NameOnly,
            }
        } else {
            None
        };
        let port = url.port();
        let Some((host, ip)) = url.host().and_then(normal_host) else { return Saved::NameOnly };
        if ip || host == "localhost" || host.ends_with(".localhost") {
            return Saved::Address { host, port, scheme };
        }
        if !host.contains('.') {
            // "nas:5000" or "http://nas" is an address; "GitHub" is only a name.
            return if port.is_some() || scheme.is_some() { Saved::Address { host, port, scheme } } else { Saved::NameOnly };
        }
        let registrable = registrable(&host);
        Saved::Domain { host, registrable, port, scheme }
    }

    /// The scheme it was saved with, if one was typed.
    pub fn scheme(&self) -> Option<Scheme> {
        match self {
            Saved::Domain { scheme, .. } | Saved::Address { scheme, .. } => *scheme,
            Saved::NameOnly => None,
        }
    }

    /// The normal form as text (`https://accounts.google.com`, `192.168.1.10:8000`), or
    /// `None` for a name only. Parsing it gives this `Saved` back.
    pub fn canonical(&self) -> Option<String> {
        let label = self.label()?;
        Some(match self.scheme() {
            Some(Scheme::Http) => format!("http://{label}"),
            Some(Scheme::Https) => format!("https://{label}"),
            None => label,
        })
    }

    /// The host (and port) to show: "accounts.google.com", "192.168.1.10:8000".
    pub fn label(&self) -> Option<String> {
        let (host, port) = match self {
            Saved::Domain { host, port, .. } | Saved::Address { host, port, .. } => (host, port),
            Saved::NameOnly => return None,
        };
        Some(match port {
            Some(port) => format!("{host}:{port}"),
            None => host.clone(),
        })
    }
}

impl Page {
    /// `None` for anything but an http(s) page with a host (`chrome:`, `file:`, `data:`,
    /// extension pages…): those get no matches at all.
    pub fn parse(text: &str) -> Option<Page> {
        if text.len() > MAX_INPUT {
            return None;
        }
        let url = Url::parse(text).ok()?;
        let scheme = scheme_of(&url)?;
        let (host, ip) = url.host().and_then(normal_host)?;
        let registrable = if ip || !host.contains('.') { None } else { registrable(&host) };
        let related = registrable.as_deref().is_some_and(|registrable| crate::related::listed(&host, registrable));
        Some(Page { scheme, host, port: url.port(), registrable, related })
    }

    fn effective_port(&self) -> u16 {
        self.port.unwrap_or(match self.scheme {
            Scheme::Http => 80,
            Scheme::Https => 443,
        })
    }

    /// "github.com", "localhost:5173": what the popup calls this site.
    pub fn label(&self) -> String {
        match self.port {
            Some(port) => format!("{}:{port}", self.host),
            None => self.host.clone(),
        }
    }
}

/// Does `saved` belong to `page`, and how surely?
pub fn compare(saved: &Saved, page: &Page) -> Verdict {
    let (host, port, scheme, saved_registrable) = match saved {
        Saved::NameOnly => return Verdict::None,
        Saved::Domain { host, registrable, port, scheme } => (host, *port, *scheme, registrable.as_deref()),
        Saved::Address { host, port, scheme } => (host, *port, *scheme, None),
    };
    // A saved port must be the page's; with none saved, another port is a different
    // origin of the same host: a lesser match.
    let tier = if *host == page.host {
        match port {
            Some(port) if port != page.effective_port() => return Verdict::None,
            Some(_) => Tier::Exact,
            None if page.port.is_some() => Tier::Subdomain,
            None => Tier::Exact,
        }
    } else if saved_registrable.is_some() && saved_registrable == page.registrable.as_deref() {
        if port.is_some_and(|port| port != page.effective_port()) {
            return Verdict::None;
        }
        Tier::Subdomain
    } else if page.related
        && let (Some(saved_registrable), Some(page_registrable)) = (saved_registrable, page.registrable.as_deref())
        && crate::related::related(host, saved_registrable, &page.host, page_registrable)
    {
        if port.is_some_and(|port| port != page.effective_port()) {
            return Verdict::None;
        }
        Tier::Related
    } else {
        return Verdict::None;
    };
    if scheme == Some(Scheme::Https) && page.scheme == Scheme::Http {
        return Verdict::Insecure;
    }
    Verdict::Fill(tier)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(saved: &str, page: &str) -> &'static str {
        let Some(page) = Page::parse(page) else { return "no page" };
        match compare(&Saved::parse(saved), &page) {
            Verdict::Fill(Tier::Exact) => "exact",
            Verdict::Fill(Tier::Subdomain) => "subdomain",
            Verdict::Fill(Tier::Related) => "related",
            Verdict::Fill(Tier::Search) => "search",
            Verdict::Insecure => "insecure",
            Verdict::None => "none",
        }
    }

    /// The table from plans/04, then the edges around it: IDN, case, trailing dots, IPv6,
    /// user info, ports, http/https, public-suffix boundaries, name-only websites.
    const TABLE: &[(&str, &str, &str)] = &[
        // plans/04's examples
        ("github.com", "https://github.com/login", "exact"),
        ("github.com", "https://gist.github.com/", "subdomain"),
        ("https://accounts.google.com/signin", "https://mail.google.com/", "subdomain"),
        ("www.amazon.fr", "https://amazon.fr/ap/signin", "exact"),
        ("github.com", "https://g1thub.com/", "none"),
        ("github.com", "https://github.com.evil.io/", "none"),
        ("alice.github.io", "https://bob.github.io/", "none"),
        ("192.168.1.10:8000", "http://192.168.1.10:8000/login", "exact"),
        ("192.168.1.10:8000", "http://192.168.1.10:9000/", "none"),
        ("localhost", "http://localhost:5173/", "subdomain"),
        ("https://bank.com", "http://bank.com/", "insecure"),
        ("GitHub", "https://github.com/", "none"),
        ("vercel.com", "https://vercel.com/login", "exact"),
        // lookalikes and suffix tricks
        ("github.com", "https://github.co/", "none"),
        ("github.com", "https://githubcom.com/", "none"),
        ("github.com", "https://github.com-login.io/", "none"),
        ("github.com", "https://xn--gthub-cta.com/", "none"),
        ("github.com", "https://login.github.com.attacker.net/", "none"),
        ("github.com", "https://github.community/", "none"),
        ("paypal.com", "https://paypa1.com/", "none"),
        ("paypal.com", "https://paypal.com.evil.co.uk/", "none"),
        ("google.com", "https://google.co.uk/", "none"),
        ("amazon.fr", "https://amazon.com/", "none"),
        ("apple.com", "https://appleid.apple.com/", "subdomain"),
        ("appleid.apple.com", "https://apple.com/", "subdomain"),
        ("appleid.apple.com", "https://www.apple.com/", "subdomain"),
        ("icloud.com", "https://apple.com/", "none"),
        // private public suffixes: each project is its own site
        ("app.vercel.app", "https://other.vercel.app/", "none"),
        ("app.vercel.app", "https://app.vercel.app/", "exact"),
        ("site.netlify.app", "https://evil.netlify.app/", "none"),
        ("blog.pages.dev", "https://phish.pages.dev/", "none"),
        ("myapp.web.app", "https://yourapp.web.app/", "none"),
        ("myapp.herokuapp.com", "https://theirs.herokuapp.com/", "none"),
        ("alice.github.io", "https://alice.github.io/repo", "exact"),
        ("alice.github.io", "https://docs.alice.github.io/", "subdomain"),
        ("github.io", "https://alice.github.io/", "none"),
        ("vercel.app", "https://vercel.app/", "exact"),
        // `www.` in front of a public suffix is a site of its own, not the suffix
        ("vercel.app", "https://www.vercel.app/", "none"),
        ("github.io", "https://www.github.io/", "none"),
        ("www.github.io", "https://github.io/", "none"),
        ("www.github.io", "https://www.github.io/login", "exact"),
        ("www.github.io", "https://alice.github.io/", "none"),
        ("duckdns.org", "https://www.duckdns.org/", "none"),
        ("www.duckdns.org", "https://www.duckdns.org/", "exact"),
        ("www.duckdns.org", "https://evil.duckdns.org/", "none"),
        ("co.uk", "https://www.co.uk/", "none"),
        ("www.co.uk", "https://www.co.uk/", "exact"),
        ("www.com", "https://www.com/", "exact"),
        ("www.www.github.io", "https://www.github.io/", "exact"),
        ("www.bbc.co.uk", "https://bbc.co.uk/", "exact"),
        ("co.uk", "https://bbc.co.uk/", "none"),
        // ICANN multi-label suffixes
        ("bbc.co.uk", "https://www.bbc.co.uk/", "exact"),
        ("bbc.co.uk", "https://account.bbc.co.uk/", "subdomain"),
        ("bbc.co.uk", "https://itv.co.uk/", "none"),
        ("service-public.fr", "https://connexion.service-public.fr/", "subdomain"),
        ("impots.gouv.fr", "https://cfspart.impots.gouv.fr/", "subdomain"),
        ("impots.gouv.fr", "https://ameli.gouv.fr/", "none"),
        ("example.com.au", "https://login.example.com.au/", "subdomain"),
        ("example.com.au", "https://other.com.au/", "none"),
        ("ameli.fr", "https://assure.ameli.fr/", "subdomain"),
        // www., case, trailing dots
        ("WWW.GitHub.COM", "https://github.com/", "exact"),
        ("github.com", "https://WWW.GITHUB.COM/", "exact"),
        ("github.com.", "https://github.com/", "exact"),
        ("github.com", "https://github.com./", "exact"),
        ("github.com..", "https://github.com/", "none"),
        ("github.com", "https://github.com../", "no page"),
        ("github.com", "https://gist..github.com/", "no page"),
        ("192.168.1.10", "http://192.168.1.10../", "no page"),
        ("192.168.1.10", "http://192.168.1.10./", "exact"),
        ("www.github.com", "https://www.github.com/", "exact"),
        ("  github.com  ", "https://github.com/", "exact"),
        ("www.github.com", "https://gist.github.com/", "subdomain"),
        ("www2.github.com", "https://github.com/", "subdomain"),
        // paths, queries, fragments and user info don't count
        ("https://github.com/login?x=1#y", "https://github.com/", "exact"),
        ("github.com/settings", "https://github.com/login", "exact"),
        ("https://user:pass@github.com/", "https://github.com/", "exact"),
        ("github.com", "https://github.com@evil.io/", "none"),
        ("evil.io", "https://github.com@evil.io/", "exact"),
        ("github.com", "https://evil.io/?github.com", "none"),
        ("github.com", "https://evil.io/github.com", "none"),
        ("github.com", "https://evil.io/#github.com", "none"),
        // IDN
        ("bücher.de", "https://bücher.de/", "exact"),
        ("bücher.de", "https://xn--bcher-kva.de/", "exact"),
        ("xn--bcher-kva.de", "https://shop.bücher.de/", "subdomain"),
        ("bucher.de", "https://bücher.de/", "none"),
        ("münchen.de", "https://stadt.münchen.de/", "subdomain"),
        ("例え.jp", "https://例え.jp/", "exact"),
        ("apple.com", "https://аpple.com/", "none"),
        // schemes
        ("http://intranet.example.com", "https://intranet.example.com/", "exact"),
        ("http://example.com", "http://example.com/", "exact"),
        ("example.com", "http://example.com/", "exact"),
        ("https://example.com", "https://example.com/", "exact"),
        ("https://example.com", "http://sub.example.com/", "insecure"),
        ("https://example.com", "http://example.com:8080/", "insecure"),
        ("ssh://example.com", "https://example.com/", "none"),
        ("ftp://example.com", "https://example.com/", "none"),
        ("example.com", "ftp://example.com/", "no page"),
        ("example.com", "file:///etc/passwd", "no page"),
        ("example.com", "chrome://settings", "no page"),
        ("example.com", "about:blank", "no page"),
        ("example.com", "data:text/html,example.com", "no page"),
        ("example.com", "chrome-extension://abc/popup.html", "no page"),
        ("example.com", "javascript:alert(1)", "no page"),
        ("example.com", "not a url", "no page"),
        ("example.com", "", "no page"),
        // ports on domains
        ("example.com:8443", "https://example.com:8443/", "exact"),
        ("example.com:8443", "https://example.com/", "none"),
        ("example.com:8443", "https://example.com:9443/", "none"),
        ("example.com:8443", "https://app.example.com:8443/", "subdomain"),
        ("example.com:8443", "https://app.example.com/", "none"),
        ("example.com", "https://example.com:8443/", "subdomain"),
        ("example.com", "https://app.example.com:8443/", "subdomain"),
        ("example.com:443", "https://example.com/", "exact"),
        ("example.com:80", "http://example.com/", "exact"),
        ("example.com:80", "https://example.com/", "none"),
        ("http://example.com:80", "http://example.com/", "exact"),
        ("https://example.com:443", "https://example.com/", "exact"),
        ("https://example.com:8443", "https://example.com:8443/", "exact"),
        // IPv4 addresses
        ("192.168.1.10", "http://192.168.1.10/", "exact"),
        ("192.168.1.10", "http://192.168.1.10:8000/", "subdomain"),
        ("192.168.1.10", "http://192.168.1.11/", "none"),
        ("192.168.1.10:8000", "https://192.168.1.10:8000/", "exact"),
        ("http://192.168.1.10:8000", "http://192.168.1.10:8000/", "exact"),
        ("https://192.168.1.10:8000", "http://192.168.1.10:8000/", "insecure"),
        ("203.0.113.7:22", "http://203.0.113.7:22/", "exact"),
        ("10.0.0.1:3000", "http://10.0.0.2:3000/", "none"),
        ("10.0.0.1", "http://10.0.0.1.nip.io/", "none"),
        ("1.1.1.1", "https://one.one.one.one/", "none"),
        // IPv6
        ("[::1]:8080", "http://[::1]:8080/", "exact"),
        ("[::1]:8080", "http://[::1]:8081/", "none"),
        ("[::1]", "http://[::1]:5000/", "subdomain"),
        ("[::1]", "http://[0:0:0:0:0:0:0:1]/", "exact"),
        ("[2001:db8::1]", "http://[2001:db8::2]/", "none"),
        ("http://[fe80::1]:9000", "http://[fe80::1]:9000/", "exact"),
        // localhost and single-label names
        ("localhost:3000", "http://localhost:3000/", "exact"),
        ("localhost:3000", "http://localhost:3001/", "none"),
        ("localhost", "http://localhost/", "exact"),
        ("http://localhost", "http://localhost:8080/", "subdomain"),
        ("app.localhost", "http://app.localhost/", "exact"),
        ("app.localhost", "http://other.localhost/", "none"),
        ("localhost", "http://127.0.0.1/", "none"),
        ("nas:5000", "http://nas:5000/", "exact"),
        ("http://nas", "http://nas/", "exact"),
        ("nas", "http://nas/", "none"),
        ("coolify", "http://coolify:8000/", "none"),
        // internal names with unknown suffixes
        ("router.lan", "http://router.lan/", "exact"),
        ("router.lan", "http://admin.router.lan/", "subdomain"),
        ("router.lan", "http://other.lan/", "none"),
        ("grafana.internal", "http://grafana.internal:3000/", "subdomain"),
        ("pihole.home.arpa", "http://pihole.home.arpa/admin", "exact"),
        // name-only websites
        ("Coolify", "https://coolify.io/", "none"),
        ("My Bank", "https://mybank.com/", "none"),
        ("Bank of France", "https://banque-france.fr/", "none"),
        ("", "https://example.com/", "none"),
        ("   ", "https://example.com/", "none"),
        ("https://", "https://example.com/", "none"),
        ("://example.com", "https://example.com/", "none"),
        ("*.example.com", "https://a.example.com/", "none"),
        ("example .com", "https://example.com/", "none"),
        ("exa mple.com", "https://example.com/", "none"),
        // the same host saved several ways
        ("https://login.microsoftonline.com/common/oauth2", "https://login.microsoftonline.com/", "exact"),
        ("microsoftonline.com", "https://login.microsoftonline.com/", "subdomain"),
        ("microsoft.com", "https://login.microsoftonline.com/", "none"),
        ("live.com", "https://login.live.com/", "subdomain"),
        ("outlook.com", "https://outlook.live.com/", "none"),
        ("accounts.google.com", "https://accounts.google.com/v3/signin/identifier", "exact"),
        ("google.com", "https://accounts.google.com/", "subdomain"),
        ("google.com", "https://accounts.google.fr/", "none"),
        ("amazon.fr", "https://www.amazon.fr/", "exact"),
        ("amazon.co.jp", "https://www.amazon.co.jp/", "exact"),
        ("amazon.co.jp", "https://amazon.jp/", "none"),
        ("vercel.com", "https://vercel.app/", "none"),
        ("notion.so", "https://www.notion.so/login", "exact"),
        ("claude.ai", "https://claude.ai/login", "exact"),
        ("proton.me", "https://account.proton.me/login", "subdomain"),
        ("BattleNet.com", "https://battlenet.com/", "exact"),
        ("steampowered.com", "https://store.steampowered.com/login/", "subdomain"),
        // related domains (the vendored shared-credentials data): fills on a click, and
        // never for a lookalike of a related site
        ("steampowered.com", "https://steamcommunity.com/login", "related"),
        ("steamcommunity.com", "https://store.steampowered.com/login/", "related"),
        ("store.steampowered.com", "https://steamcommunity.com/", "related"),
        ("twitter.com", "https://x.com/i/flow/login", "related"),
        ("x.com", "https://twitter.com/login", "none"),
        ("discordapp.com", "https://discord.com/login", "related"),
        ("discord.com", "https://discordapp.com/login", "none"),
        ("trello.com", "https://id.atlassian.com/login", "related"),
        ("trello.com", "https://admin.atlassian.com/", "none"),
        ("airbnb.fr", "https://www.airbnb.co.uk/login", "related"),
        ("ebay.com", "https://signin.ebay.de/", "related"),
        ("https://steampowered.com", "http://steamcommunity.com/", "insecure"),
        ("steampowered.com:8443", "https://steamcommunity.com/", "none"),
        ("steampowered.com:8443", "https://steamcommunity.com:8443/", "related"),
        ("steampowered.com", "https://steamcommunity.com.evil.io/", "none"),
        ("steampowered.com", "https://steamcommunlty.com/", "none"),
        ("steampowered.com", "https://steamcommunity.co/", "none"),
        ("twitter.com", "https://x.com.evil.io/", "none"),
        ("twitter.com", "https://xx.com/", "none"),
        ("Steam", "https://steamcommunity.com/", "none"),
        ("192.168.1.10", "https://steamcommunity.com/", "none"),
    ];

    #[test]
    fn the_table() {
        assert!(TABLE.len() >= 150, "{} rows", TABLE.len());
        let mut wrong = Vec::new();
        for &(saved, page, expected) in TABLE {
            let got = check(saved, page);
            if got != expected {
                wrong.push(format!("{saved:?} on {page:?}: {got}, expected {expected}"));
            }
        }
        assert!(wrong.is_empty(), "{} wrong:\n{}", wrong.len(), wrong.join("\n"));
    }

    #[test]
    fn normalising_twice_changes_nothing() {
        for &(saved, _, _) in TABLE {
            let once = Saved::parse(saved);
            if let Some(text) = once.canonical() {
                assert_eq!(Saved::parse(&text), once, "{saved:?} → {text:?}");
            }
        }
        assert_eq!(Saved::parse("www.www.github.com").canonical().as_deref(), Some("github.com"));
        assert_eq!(Saved::parse("www.www.github.io").canonical().as_deref(), Some("www.github.io"));
        assert_eq!(Page::parse("https://www.github.io/").map(|page| page.host).as_deref(), Some("www.github.io"));
    }

    /// xorshift64: "random" input that is the same on every run, with no dependency.
    struct XorShift(u64);

    impl XorShift {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }

        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    /// Pieces of URLs, glued at random: schemes, hosts, suffixes, ports, IPs, user info,
    /// escapes, IDN and junk.
    const PIECES: &[&str] = &[
        "http://", "https://", "ftp://", "://", "www.", "WWW.", ".", "..", "-", "github", "com", "co.uk", "github.io",
        "vercel.app", "localhost", "nas", "xn--", "xn--bcher-kva", "bücher", "例え", "а", ":", ":8080", ":443", ":80",
        ":0", ":99999", "[", "]", "::1", "[::1]", "[2001:db8::1]", "192.168.1.10", "0x7f.1", "1.2.3", "@", "user:pass@",
        "/", "/login", "?", "?continue=https://x.com/", "#", "%", "%41", "%2e", " ", "\t", "\u{0}", "*", "\\",
        "steampowered.com", "steamcommunity.com", "x.com", "id.atlassian.com", "a", "1", "-.", "\u{202E}", "ü", "ß",
        "accounts.google.com/o/oauth2/v2/auth?redirect_uri=", "storagerelay://https/", "duckdns.org", "&followup=",
    ];

    fn random_text(rng: &mut XorShift) -> String {
        let pieces = 1 + rng.below(8);
        (0..pieces).map(|_| PIECES[rng.below(PIECES.len())]).collect()
    }

    /// The fuzz target's checks (`fuzz/`), on fixed random input in the normal suite: no
    /// panics, normalising twice changes nothing, and a fill never crosses registrable
    /// domains except through the related-domains data.
    #[test]
    fn random_input_never_panics_and_normalises_once() {
        let mut rng = XorShift(0x9E37_79B9_7F4A_7C15);
        for _ in 0..20_000 {
            let (saved_text, page_text) = (random_text(&mut rng), random_text(&mut rng));
            let saved = Saved::parse(&saved_text);
            if let Some(text) = saved.canonical() {
                assert_eq!(Saved::parse(&text), saved, "{saved_text:?} → {text:?}");
            }
            for text in [&page_text, &saved_text] {
                let Some(page) = Page::parse(text) else { continue };
                let scheme = if page.scheme == Scheme::Https { "https" } else { "http" };
                let again = format!("{scheme}://{}/", page.label());
                assert_eq!(Page::parse(&again).as_ref(), Some(&page), "{text:?} → {again:?}");
                if let Verdict::Fill(tier) = compare(&saved, &page) {
                    let (host, registrable) = match &saved {
                        Saved::Domain { host, registrable, .. } => (host, registrable.as_deref()),
                        Saved::Address { host, .. } => (host, None),
                        Saved::NameOnly => panic!("a name only matched {text:?}"),
                    };
                    let same_site = *host == page.host || (registrable.is_some() && registrable == page.registrable.as_deref());
                    assert!(same_site || tier == Tier::Related, "{saved_text:?} on {text:?}: {tier:?}");
                    assert_ne!(tier, Tier::Search);
                }
            }
            let _ = crate::provider::relying_party(&page_text);
        }
    }

    #[test]
    fn labels() {
        assert_eq!(Saved::parse("https://WWW.Accounts.Google.com/signin").label().as_deref(), Some("accounts.google.com"));
        assert_eq!(Saved::parse("192.168.1.10:8000").label().as_deref(), Some("192.168.1.10:8000"));
        assert_eq!(Saved::parse("GitHub").label(), None);
        assert_eq!(Page::parse("http://localhost:5173/x").unwrap().label(), "localhost:5173");
        assert_eq!(Page::parse("https://bücher.de/").unwrap().label(), "xn--bcher-kva.de");
    }

    #[test]
    fn odd_input_never_panics() {
        let long = "a.".repeat(5000);
        for text in [
            "\u{0}", "%", "%%%", "[", "[::", "http://[", "https://a:99999/", "https://a:-1/", "http://.", "http://..",
            "http://...com", "https://.com", "\u{202E}moc.elgoog", "xn--", "https://xn--/", long.as_str(),
        ] {
            let _ = Saved::parse(text);
            if let Some(page) = Page::parse(text) {
                let _ = compare(&Saved::parse(text), &page);
            }
        }
    }
}
