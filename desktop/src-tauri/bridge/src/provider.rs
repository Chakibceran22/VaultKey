//! Sign-in providers (`plans/04-domain-matching.md`, "Signs in with"):
//!
//! - [`provider_id`]: which provider an account is ("google" for a Google account), for the
//!   "Continue with …" hints of the sites that sign in with it;
//! - [`relying_party`]: on a provider's own sign-in page (accounts.google.com…), which
//!   site the sign-in is for, read from the tab's URL.
//!
//! Neither releases anything: the provider id is a label, and the relying party only puts
//! the provider page's own cards in a better order.

use url::Url;

use crate::matcher::{Page, Saved};

/// Known providers, by registrable domain.
const KNOWN: &[(&str, &str)] = &[
    ("google.com", "google"),
    ("gmail.com", "google"),
    ("googlemail.com", "google"),
    ("apple.com", "apple"),
    ("icloud.com", "apple"),
    ("microsoft.com", "microsoft"),
    ("microsoftonline.com", "microsoft"),
    ("live.com", "microsoft"),
    ("outlook.com", "microsoft"),
    ("hotmail.com", "microsoft"),
    ("office.com", "microsoft"),
    ("github.com", "github"),
    ("facebook.com", "facebook"),
    ("fb.com", "facebook"),
    ("x.com", "x"),
    ("twitter.com", "x"),
    ("linkedin.com", "linkedin"),
    ("gitlab.com", "gitlab"),
    ("slack.com", "slack"),
    ("discord.com", "discord"),
    ("discordapp.com", "discord"),
    ("amazon.com", "amazon"),
];

/// Websites saved as a name only that plainly name a provider ("Google", "GitHub").
const NAMES: &[(&str, &str)] = &[
    ("google", "google"),
    ("gmail", "google"),
    ("apple", "apple"),
    ("icloud", "apple"),
    ("microsoft", "microsoft"),
    ("outlook", "microsoft"),
    ("github", "github"),
    ("facebook", "facebook"),
    ("x", "x"),
    ("twitter", "x"),
    ("linkedin", "linkedin"),
    ("gitlab", "gitlab"),
    ("slack", "slack"),
    ("discord", "discord"),
    ("amazon", "amazon"),
];

fn known(registrable: &str) -> Option<&'static str> {
    if let Some(&(_, id)) = KNOWN.iter().find(|(domain, _)| *domain == registrable) {
        return Some(id);
    }
    // Country sites (amazon.fr, google.co.uk): a registrable domain is one label in front of
    // a public suffix.
    match registrable.split_once('.')?.0 {
        "amazon" => Some("amazon"),
        "google" => Some("google"),
        _ => None,
    }
}

/// The provider id of an account other accounts sign in with: a known id from its
/// registrable domain ("google"), else that registrable domain ("proton.me"), or the host of
/// an address. A website saved as a name only gives the provider it names, else the name.
pub fn provider_id(saved: &Saved, website: &str) -> String {
    match saved {
        Saved::Domain { host, registrable, .. } => {
            let domain = registrable.as_deref().unwrap_or(host);
            known(domain).map_or_else(|| domain.to_owned(), str::to_owned)
        }
        Saved::Address { host, .. } => host.clone(),
        Saved::NameOnly => {
            let name = website.trim().to_lowercase();
            NAMES.iter().find(|(known, _)| *known == name).map_or(name, |(_, id)| (*id).to_owned())
        }
    }
}

/// A provider's sign-in pages.
struct Provider {
    hosts: &'static [&'static str],
    /// The page's path starts with one of these (none listed: any page of those hosts).
    paths: &'static [&'static str],
    /// The provider's own sites: a URL to one of them is followed, never a relying party.
    family: &'static [&'static str],
    /// Its `client_id` is a reverse-DNS name of the relying party (Apple's Services IDs:
    /// `com.vercel.signin`).
    reverse_dns_client: bool,
}

const PROVIDERS: &[Provider] = &[
    Provider { hosts: &["accounts.google.com"], paths: &[], family: &["google.com"], reverse_dns_client: false },
    Provider {
        hosts: &["login.microsoftonline.com", "login.live.com", "login.microsoft.com"],
        paths: &[],
        family: &["microsoftonline.com", "live.com", "microsoft.com"],
        reverse_dns_client: false,
    },
    Provider { hosts: &["appleid.apple.com"], paths: &[], family: &["apple.com"], reverse_dns_client: true },
    Provider { hosts: &["github.com"], paths: &["/login", "/sessions"], family: &["github.com"], reverse_dns_client: false },
];

impl Provider {
    fn owns(&self, page: &Page) -> bool {
        let site = page.registrable.as_deref().unwrap_or(&page.host);
        self.family.contains(&site)
    }
}

/// Query parameters that can name the site being signed in to, with how telling each is
/// (lower: more): the callback the provider sends the user back to (which it checks
/// against the client's registration), then where the flow goes on to, then where it
/// started, then the client's own id. Values are URLs, absolute or relative to the page
/// (GitHub's `return_to=/login/oauth/…`); anything else resolves to the provider's own site
/// and is passed over.
const PARAMS: &[(&str, u8)] = &[
    ("redirect_uri", 0),
    ("redirect_url", 0),
    ("wreply", 0),
    ("return_to", 1),
    ("continue", 1),
    ("followup", 1),
    ("ru", 1),
    ("origin", 2),
    ("app_domain", 2),
    ("client_id", 3),
];

/// URLs inside URLs are followed this deep (the page's own query is level 1).
const MAX_DEPTH: usize = 3;

/// The longest tab URL read (as in requests).
const MAX_URL: usize = 2048;

/// On a provider's sign-in page (`tab_url`), the one site the sign-in is for:
/// `accounts.google.com/v3/signin/identifier?continue=…redirect_uri=https://vercel.com/…`
/// gives `vercel.com`. `None` on any other page, when no site is named, and when the URL
/// names two different sites: anyone can add a parameter to a sign-in link
/// (`redirect_uri=https://evil.example/cb&followup=https://vercel.com`), and a guess would
/// label the Google account you use for Vercel "for vercel.com" during evil.example's
/// sign-in. So the URL's sites must agree; the most telling parameter gives the address.
/// Only when no URL names a site does Apple's reverse-DNS `client_id` count.
pub fn relying_party(tab_url: &str) -> Option<Page> {
    if tab_url.len() > MAX_URL {
        return None;
    }
    let (Ok(url), Some(page)) = (Url::parse(tab_url), Page::parse(tab_url)) else { return None };
    let provider = PROVIDERS.iter().find(|provider| {
        provider.hosts.contains(&page.host.as_str())
            && (provider.paths.is_empty() || provider.paths.iter().any(|path| url.path().starts_with(path)))
    })?;
    let mut found: Vec<(u8, Page)> = Vec::new();
    follow(&url, provider, 1, &mut found);
    if found.is_empty() {
        return provider
            .reverse_dns_client
            .then(|| url.query_pairs().filter(|(key, _)| key == "client_id").find_map(|(_, id)| reverse_dns(&id, provider)))
            .flatten();
    }
    let (_, first) = found.iter().min_by_key(|(class, _)| *class)?;
    found.iter().all(|(_, other)| same_site(first, other)).then(|| first.clone())
}

/// Collects the sites named in `url`'s query, each with how telling its parameter is,
/// following the provider's own URLs.
fn follow(url: &Url, provider: &Provider, depth: usize, found: &mut Vec<(u8, Page)>) {
    let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    for &(name, class) in PARAMS {
        for (_, value) in pairs.iter().filter(|(key, _)| key == name) {
            let Some(nested) = nested_url(url, value) else { continue };
            let Some(page) = Page::parse(nested.as_str()) else { continue };
            if provider.owns(&page) {
                if depth < MAX_DEPTH {
                    follow(&nested, provider, depth + 1, found);
                }
            } else {
                found.push((class, page));
            }
        }
    }
}

fn same_site(a: &Page, b: &Page) -> bool {
    a.host == b.host || (a.registrable.is_some() && a.registrable == b.registrable)
}

/// A parameter's value as a URL, relative to the page it's on.
fn nested_url(base: &Url, value: &str) -> Option<Url> {
    let value = value.trim();
    // Google's popup sign-in: `storagerelay://https/vercel.com?id=auth123`.
    if let Some(rest) = value.strip_prefix("storagerelay://") {
        let (scheme, rest) = rest.split_once('/')?;
        let host = rest.split(['/', '?', '#']).next()?;
        return Url::parse(&format!("{scheme}://{host}/")).ok();
    }
    base.join(value).ok()
}

/// `com.vercel.signin` → `signin.vercel.com`, when that's another site's address.
fn reverse_dns(id: &str, provider: &Provider) -> Option<Page> {
    if id.len() > 253 || !id.contains('.') || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
        return None;
    }
    let host: Vec<&str> = id.split('.').rev().collect();
    let page = Page::parse(&format!("https://{}/", host.join(".")))?;
    (page.registrable.is_some() && !provider.owns(&page)).then_some(page)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sites(tab_url: &str) -> Vec<String> {
        relying_party(tab_url).into_iter().map(|page| page.registrable.unwrap_or(page.host)).collect()
    }

    #[test]
    fn google() {
        // The OAuth consent flow, with the client's callback inside `continue`.
        assert_eq!(
            sites(
                "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Faccounts.google.com%2Fo%2Foauth2%2Fauth%2Fpartial%3Fclient_id%3D1234-abc.apps.googleusercontent.com%26redirect_uri%3Dhttps%253A%252F%252Fvercel.com%252Fapi%252Fregistration%252Flogin-with-google%252Fcallback%26response_type%3Dcode%26scope%3Demail%2Bprofile%26state%3Dxyz&dsh=S123&flowName=GeneralOAuthFlow&o2v=2&service=lso"
            ),
            ["vercel.com"]
        );
        assert_eq!(
            sites(
                "https://accounts.google.com/o/oauth2/v2/auth?client_id=1234-abc.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fapp.linear.app%2Fauth%2Fgoogle%2Fcallback&response_type=code&scope=openid%20email"
            ),
            ["linear.app"]
        );
        // Sign in with Google's popup and its One Tap / button iframe.
        assert_eq!(
            sites(
                "https://accounts.google.com/o/oauth2/v2/auth?client_id=1234-abc.apps.googleusercontent.com&redirect_uri=storagerelay%3A%2F%2Fhttps%2Fwww.notion.so%3Fid%3Dauth123&response_type=permission%20id_token&scope=email"
            ),
            ["notion.so"]
        );
        assert_eq!(
            sites("https://accounts.google.com/gsi/select?client_id=1234-abc.apps.googleusercontent.com&ux_mode=popup&ui_mode=card&origin=https%3A%2F%2Fwww.canva.com"),
            ["canva.com"]
        );
        // Another provider can be the site: GitHub's "Continue with Google".
        assert_eq!(
            sites("https://accounts.google.com/o/oauth2/v2/auth?client_id=1-a.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fgithub.com%2Fsessions%2Fsocial%2Fgoogle%2Fcallback"),
            ["github.com"]
        );
        // Google's own services aren't a relying party.
        assert!(sites("https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F&service=mail").is_empty());
        assert!(sites("https://accounts.google.com/").is_empty());
    }

    #[test]
    fn microsoft() {
        assert_eq!(
            sites(
                "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=00000000-0000-0000-0000-000000000000&response_type=code&redirect_uri=https%3A%2F%2Fapp.slack.com%2Fsso%2Fmicrosoft&scope=openid%20profile&state=abc"
            ),
            ["slack.com"]
        );
        assert_eq!(
            sites("https://login.live.com/oauth20_authorize.srf?client_id=0000000040000000&scope=wl.signin&response_type=code&redirect_uri=https%3A%2F%2Fwww.figma.com%2Fauth%2Fmicrosoft"),
            ["figma.com"]
        );
        assert!(sites("https://login.live.com/login.srf?wa=wsignin1.0&wreply=https%3A%2F%2Foutlook.live.com%2Fowa%2F").is_empty());
    }

    #[test]
    fn apple() {
        assert_eq!(
            sites(
                "https://appleid.apple.com/auth/authorize?client_id=com.vercel.signin&redirect_uri=https%3A%2F%2Fvercel.com%2Fapi%2Fauth%2Fcallback%2Fapple&response_type=code%20id_token&response_mode=form_post&scope=name%20email&state=abc"
            ),
            ["vercel.com"]
        );
        // No callback in the URL: the Services ID names the site.
        assert_eq!(sites("https://appleid.apple.com/auth/authorize?client_id=com.dropbox.web&response_type=code"), ["dropbox.com"]);
        assert!(sites("https://appleid.apple.com/auth/authorize?client_id=com.apple.music").is_empty());
        assert!(sites("https://appleid.apple.com/auth/authorize?client_id=nodots").is_empty());
    }

    #[test]
    fn github() {
        assert_eq!(
            sites(
                "https://github.com/login/oauth/authorize?client_id=Iv1.0123456789abcdef&redirect_uri=https%3A%2F%2Fvercel.com%2Fapi%2Fauth%2Fcallback%2Fgithub&scope=user%3Aemail&state=xyz"
            ),
            ["vercel.com"]
        );
        // Signed out: the authorize URL waits in `return_to`, relative to github.com.
        assert_eq!(
            sites(
                "https://github.com/login?client_id=Iv1.0123&return_to=%2Flogin%2Foauth%2Fauthorize%3Fclient_id%3DIv1.0123%26redirect_uri%3Dhttps%253A%252F%252Fapp.netlify.com%252Fauth%252Fdone%26response_type%3Dcode"
            ),
            ["netlify.com"]
        );
        assert!(sites("https://github.com/login?return_to=%2Fsettings%2Fprofile").is_empty());
        // Only the sign-in pages.
        assert!(sites("https://github.com/settings?redirect_uri=https%3A%2F%2Fvercel.com%2F").is_empty());
    }

    #[test]
    fn only_on_providers_pages() {
        for page in [
            "https://vercel.com/login?redirect_uri=https%3A%2F%2Fevil.io%2F",
            "https://accounts.google.com.evil.io/?continue=https%3A%2F%2Fvercel.com%2F",
            "https://evil.io/accounts.google.com?continue=https%3A%2F%2Fvercel.com%2F",
            "http://appleid.apple.co/auth/authorize?redirect_uri=https%3A%2F%2Fvercel.com%2F",
            "chrome://settings",
            "",
        ] {
            assert!(sites(page).is_empty(), "{page}");
        }
    }

    #[test]
    fn nested_urls_are_followed_three_levels_deep() {
        let encode = |url: &str| url::form_urlencoded::byte_serialize(url.as_bytes()).collect::<String>();
        let level3 = format!("https://accounts.google.com/c?redirect_uri={}", encode("https://vercel.com/cb"));
        let level2 = format!("https://accounts.google.com/b?continue={}", encode(&level3));
        let level1 = format!("https://accounts.google.com/a?continue={}", encode(&level2));
        assert_eq!(sites(&level1), ["vercel.com"], "three levels: the page, and two inside it");
        let deeper = format!("https://accounts.google.com/z?continue={}", encode(&level1));
        assert!(sites(&deeper).is_empty(), "a fourth isn't read");
        // The same site named several ways: that site, at the callback's address.
        let same = relying_party(
            "https://accounts.google.com/o?origin=https%3A%2F%2Fwww.vercel.com&redirect_uri=https%3A%2F%2Fapp.vercel.com%2Fcb&continue=https%3A%2F%2Fvercel.com%2F",
        );
        assert_eq!(same.map(|page| page.host).as_deref(), Some("app.vercel.com"));
    }

    /// Anyone can add parameters to a sign-in link: a URL that names two sites names none.
    #[test]
    fn a_second_site_in_the_url_cancels_the_guess() {
        for tab in [
            // The review's case: evil.example's real callback, Vercel added in `followup`.
            "https://accounts.google.com/o/oauth2/v2/auth?client_id=1-a.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fevil.example%2Fcb&followup=https%3A%2F%2Fvercel.com",
            // Vercel added as a more telling parameter than the real one.
            "https://accounts.google.com/gsi/select?client_id=1-a.apps.googleusercontent.com&origin=https%3A%2F%2Fevil.example&redirect_uri=https%3A%2F%2Fvercel.com%2Fcb",
            // Two callbacks: one at the top, the real one inside `continue`.
            "https://accounts.google.com/v3/signin/identifier?redirect_uri=https%3A%2F%2Fvercel.com%2F&continue=https%3A%2F%2Faccounts.google.com%2Fo%2Foauth2%2Fauth%3Fredirect_uri%3Dhttps%253A%252F%252Fevil.example%252Fcb",
            "https://github.com/login/oauth/authorize?client_id=Iv1.0&return_to=https%3A%2F%2Fvercel.com%2F&redirect_uri=https%3A%2F%2Fevil.example%2Fcb",
            "https://appleid.apple.com/auth/authorize?client_id=com.vercel.signin&redirect_uri=https%3A%2F%2Fevil.example%2Fcb&continue=https%3A%2F%2Fvercel.com",
        ] {
            assert!(sites(tab).is_empty(), "{tab}");
        }
        // Apple's Services ID is a guess too: a URL's site wins over it.
        assert_eq!(sites("https://appleid.apple.com/auth/authorize?client_id=com.vercel.signin&redirect_uri=https%3A%2F%2Fevil.example%2Fcb"), ["evil.example"]);
    }

    #[test]
    fn provider_ids() {
        let id = |website: &str| provider_id(&Saved::parse(website), website);
        assert_eq!(id("google.com"), "google");
        assert_eq!(id("https://accounts.google.com/signin"), "google");
        assert_eq!(id("gmail.com"), "google");
        assert_eq!(id("google.co.uk"), "google");
        assert_eq!(id("amazon.fr"), "amazon");
        assert_eq!(id("login.microsoftonline.com"), "microsoft");
        assert_eq!(id("twitter.com"), "x");
        assert_eq!(id("appleid.apple.com"), "apple");
        assert_eq!(id("GitHub"), "github");
        assert_eq!(id(" Google "), "google");
        assert_eq!(id("vercel.com"), "vercel.com");
        assert_eq!(id("auth.proton.me"), "proton.me");
        assert_eq!(id("192.168.1.10:8000"), "192.168.1.10");
        assert_eq!(id("My SSO"), "my sso");
        // A lookalike is just another domain.
        assert_eq!(id("g00gle.com"), "g00gle.com");
        assert_eq!(id("google.com.evil.io"), "evil.io");
    }
}
