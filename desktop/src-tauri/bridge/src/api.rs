//! What a paired browser can ask for, inside its encrypted session (`plans/03-protocol.md`,
//! "Methods"; `plans/02-security.md`, "Handles, not IDs").
//!
//! - `match`: the cards for a page (no secrets), each with an opaque handle.
//! - `search`: cards from the whole vault by name, for the popup (no secrets).
//! - `reveal`: one card's username, email and password, after a click.
//! - `totp`: one card's current authenticator code.
//!
//! A handle is random, issued to this session only, and lives 10 minutes. `reveal` and
//! `totp` take only a handle, and match its login against the page **again**: a handle
//! from github.com is worthless on evil.com, and a browser can't walk through the vault by
//! guessing IDs. A handle from `search` is the one exception: it fills on any page, but only
//! with `confirmedCrossSite`, which only the popup's "Fill anyway on this site?" sets, and
//! such a fill is recorded as cross-site. Each paired browser is rate limited, across its
//! sessions.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroizing;

use crate::{
    inner::{self, Code, Request},
    matcher::{self, Page, Saved, Scheme, Tier, Verdict},
    noise::ClientId,
    provider,
    server::{App, Refusal},
};

/// What a login is: a saved account, or a project service's own login (`plans/02`: same
/// rules as accounts).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginKind {
    Account,
    ServiceLogin,
}

/// One login, as the app lists it for matching: no secrets.
#[derive(Clone, Debug)]
pub struct Account {
    pub kind: LoginKind,
    /// `credentials.id` or `service_logins.id`: separate counters, so only with `kind`.
    pub id: i64,
    /// Accounts: the saved website as typed ("github.com", "GitHub"); service logins: the
    /// service's name.
    pub title: String,
    /// What's matched: the saved website (`domains.name`), or the service's address.
    pub website: String,
    /// Accounts: the email; service logins: the login's username.
    pub email: String,
    /// Accounts: the username, if any; service logins: none.
    pub username: Option<String>,
    pub has_password: bool,
    /// An authenticator with a setup key (never for service logins).
    pub has_totp: bool,
    /// The accounts (kind `Account`) this one signs in with: `account_links` of kind
    /// `sign_in`.
    pub signs_in_with: Vec<i64>,
}

/// A login with its website normalised once (the app caches these).
#[derive(Clone, Debug)]
pub struct Entry {
    pub account: Account,
    pub saved: Saved,
}

impl Entry {
    pub fn new(account: Account) -> Self {
        let saved = Saved::parse(&account.website);
        Self { account, saved }
    }

    fn is(&self, kind: LoginKind, id: i64) -> bool {
        self.account.kind == kind && self.account.id == id
    }
}

/// One login, decrypted for one fill.
pub struct Login {
    pub email: String,
    pub username: Option<String>,
    pub password: Zeroizing<String>,
}

pub struct AuthCode {
    pub code: String,
    /// Unix time in milliseconds.
    pub expires_at: u64,
}

/// A fill the app records in "Recent fills" (memory only, cleared on lock).
#[derive(Clone, Debug)]
pub struct Fill {
    pub client: ClientId,
    /// The login filled, with `kind`.
    pub account: i64,
    /// The page it was filled on: "github.com".
    pub site: String,
    pub what: FillKind,
    pub via: Via,
    pub kind: LoginKind,
    /// A popup search result filled on a site it isn't saved for, after the user confirmed.
    pub cross_site: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FillKind {
    Login,
    Code,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Via {
    Menu,
    Popup,
    Shortcut,
}

/// How long a handle can be used.
pub const HANDLE_TTL: Duration = Duration::from_secs(10 * 60);
/// Handles kept per session; the oldest go first.
const MAX_HANDLES: usize = 1024;
/// Cards returned for one page.
pub const MAX_CARDS: usize = 50;
/// Cards returned for one search.
pub const MAX_SEARCH: usize = 20;
/// Longest search, in characters.
const MAX_QUERY: usize = 200;
/// Longest URL accepted in a request.
const MAX_URL: usize = 2048;

/// What a handle stands for.
#[derive(Clone, Copy, Debug)]
struct Grant {
    kind: LoginKind,
    id: i64,
    /// Issued by `search`: fills only once the user confirms it for the page.
    searched: bool,
    issued: Instant,
}

/// One session's handles.
#[derive(Default)]
pub struct Grants {
    handles: HashMap<String, Grant>,
    order: VecDeque<String>,
}

impl Grants {
    fn issue(&mut self, account: &Account, searched: bool, now: Instant) -> String {
        while self.order.len() >= MAX_HANDLES {
            if let Some(oldest) = self.order.pop_front() {
                self.handles.remove(&oldest);
            }
        }
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).expect("the system's random generator works");
        let handle = crate::message::encode(&bytes);
        self.handles.insert(handle.clone(), Grant { kind: account.kind, id: account.id, searched, issued: now });
        self.order.push_back(handle.clone());
        handle
    }

    fn get(&self, handle: &str, now: Instant) -> Option<Grant> {
        self.handles.get(handle).filter(|grant| now.duration_since(grant.issued) < HANDLE_TTL).copied()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Limited {
    Match,
    Search,
    Reveal,
    Totp,
    /// `reveal` and `totp` together, with a handle from `search`.
    SearchFill,
}

const MINUTE: Duration = Duration::from_secs(60);
const HOUR: Duration = Duration::from_secs(60 * 60);

impl Limited {
    /// Requests allowed per window, per paired browser (plans/02, "Rate limits").
    fn limits(self) -> &'static [(Duration, u32)] {
        match self {
            Limited::Match => &[(MINUTE, 600)],
            Limited::Search => &[(MINUTE, 60)],
            Limited::Reveal | Limited::Totp => &[(MINUTE, 20)],
            // A search result fills on any page once `confirmedCrossSite` is set, and the
            // app can't tell the popup's real "Fill anyway on this site?" from a forged flag:
            // a compromised extension could search "a", "e", "@"… and reveal every result.
            // plans/02's promise that it can't enumerate the vault rests on this limit, so
            // it's far below a page's own logins, and counts every such fill, even on the
            // login's own site.
            Limited::SearchFill => &[(MINUTE, 3), (HOUR, 10)],
        }
    }
}

/// Rate limits per paired browser, shared by all its sessions: fixed windows, each
/// starting at its first request. The time is passed in, so tests move it.
#[derive(Default)]
pub struct Limiter {
    windows: Mutex<HashMap<Window, (Instant, u32)>>,
}

/// One browser's window for one kind of request: which browser, what, how long.
type Window = (ClientId, Limited, Duration);

impl Limiter {
    fn allow(&self, client: ClientId, what: Limited, now: Instant) -> bool {
        let mut windows = self.windows.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // A few browsers at most; drop stale windows now and then.
        if windows.len() > 256 {
            windows.retain(|(_, _, period), (start, _)| now.duration_since(*start) < *period);
        }
        let limits = what.limits();
        for &(period, _) in limits {
            let (start, count) = windows.entry((client, what, period)).or_insert((now, 0));
            if now.duration_since(*start) >= period {
                *start = now;
                *count = 0;
            }
        }
        // Over any window: refused, and nothing counted.
        if limits.iter().any(|&(period, max)| windows.get(&(client, what, period)).is_some_and(|(_, count)| *count >= max)) {
            return false;
        }
        for &(period, _) in limits {
            if let Some((_, count)) = windows.get_mut(&(client, what, period)) {
                *count += 1;
            }
        }
        true
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct MatchParams {
    tab_url: String,
    frame_url: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SearchParams {
    q: String,
    tab_url: String,
    limit: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RevealParams {
    h: String,
    tab_url: String,
    frame_url: String,
    via: Via,
    /// The user said "Fill anyway on this site?" in the popup (search results only).
    #[serde(default)]
    confirmed_cross_site: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TotpParams {
    h: String,
    tab_url: String,
    frame_url: String,
    #[serde(default)]
    confirmed_cross_site: bool,
}

/// A request this app understands.
enum Call {
    Ping,
    Match(MatchParams),
    Search(SearchParams),
    Reveal(RevealParams),
    Totp(TotpParams),
}

fn params<T: for<'de> Deserialize<'de>>(p: &Option<Value>) -> Option<T> {
    // Objects only; `deny_unknown_fields` and the types do the rest.
    p.as_ref().filter(|p| p.is_object()).and_then(|p| T::deserialize(p).ok())
}

fn parse(request: &Request) -> Option<Call> {
    let call = match request.m.as_str() {
        "ping" if request.p.is_none() => Call::Ping,
        "match" => Call::Match(params(&request.p)?),
        "search" => Call::Search(params(&request.p)?),
        "reveal" => Call::Reveal(params(&request.p)?),
        "totp" => Call::Totp(params(&request.p)?),
        _ => return None,
    };
    let urls_ok = |tab: &str, frame: &str| tab.len() <= MAX_URL && frame.len() <= MAX_URL;
    let fine = match &call {
        Call::Ping => true,
        Call::Match(p) => urls_ok(&p.tab_url, &p.frame_url),
        Call::Search(p) => {
            p.tab_url.len() <= MAX_URL && (1..=MAX_QUERY).contains(&p.q.chars().count()) && (1..=MAX_SEARCH).contains(&p.limit)
        }
        Call::Reveal(p) => urls_ok(&p.tab_url, &p.frame_url) && p.h.len() <= 64,
        Call::Totp(p) => urls_ok(&p.tab_url, &p.frame_url) && p.h.len() <= 64,
    };
    fine.then_some(call)
}

/// "Signs in with Google as me@gmail.com".
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct Hint {
    provider: String,
    label: String,
}

/// Keys in the order the extension's fixture has them (`inner.json`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Card<'a> {
    h: String,
    kind: LoginKind,
    title: &'a str,
    host: String,
    email: &'a str,
    username: Option<&'a str>,
    method: &'static str,
    tier: Tier,
    has_totp: bool,
    signs_in_with: &'a [Hint],
    for_site: Option<&'a str>,
    last_used: Option<()>,
}

#[derive(Serialize)]
struct Site {
    host: String,
    registrable: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Matches<'a> {
    site: Option<Site>,
    cards: Vec<Card<'a>>,
    /// Logins saved for https that aren't offered because this page is http.
    insecure: usize,
    /// The "Continue with …" buttons this page's cards sign in with, once each.
    sso_hints: Vec<&'a Hint>,
}

#[derive(Serialize)]
struct Found<'a> {
    cards: Vec<Card<'a>>,
}

#[derive(Serialize)]
struct Revealed<'a> {
    email: &'a str,
    username: Option<&'a str>,
    password: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CodeReply<'a> {
    code: &'a str,
    expires_at: u64,
}

fn failure(id: u32, code: Code, msg: &str) -> Zeroizing<Vec<u8>> {
    Zeroizing::new(inner::failure(id, code, msg))
}

fn refused(id: u32, refusal: Refusal) -> Zeroizing<Vec<u8>> {
    match refusal {
        Refusal::Locked => failure(id, Code::Locked, "The vault is locked."),
        _ => failure(id, Code::Internal, "VaultKey couldn't do that. Its log has the details."),
    }
}

/// `{"id":…,"ok":true,"r":…}`, written once into one buffer of `capacity` bytes: when a
/// secret is in it, no copy is left behind in memory freed by a growing buffer.
fn reply_into<T: Serialize>(id: u32, result: &T, capacity: usize) -> Zeroizing<Vec<u8>> {
    let mut out = Zeroizing::new(Vec::with_capacity(capacity));
    out.extend_from_slice(format!(r#"{{"id":{id},"ok":true,"r":"#).as_bytes());
    serde_json::to_writer(&mut *out, result).expect("a result always serialises");
    out.push(b'}');
    out
}

fn reply<T: Serialize>(id: u32, result: &T) -> Zeroizing<Vec<u8>> {
    reply_into(id, result, 256)
}

/// Enough room for a reply carrying `texts`, even if every character were escaped
/// (`\u00XX`, 6 bytes): the buffer never grows, so it never leaves a copy.
fn room_for(texts: &[&str]) -> usize {
    128 + texts.iter().map(|text| text.len() * 6).sum::<usize>()
}

/// Labels in common with the page host, from the right: on `mail.google.com`,
/// `mail.google.com` (3) before `google.com` (2).
fn shared_labels(saved: &Saved, page: &Page) -> usize {
    let Some(label) = saved.label() else { return 0 };
    let host = label.split(':').next().unwrap_or_default().to_owned();
    host.rsplit('.').zip(page.host.rsplit('.')).take_while(|(a, b)| a == b).count()
}

/// The logins for `page`, best first: tier, then the most labels in common with the page
/// host, then website and email.
fn ranked<'a>(entries: &'a [Entry], page: &Page) -> Vec<(Tier, &'a Entry)> {
    let mut found: Vec<(Tier, usize, &Entry)> = entries
        .iter()
        .filter_map(|entry| match matcher::compare(&entry.saved, page) {
            Verdict::Fill(tier) => Some((tier, shared_labels(&entry.saved, page), entry)),
            _ => None,
        })
        .collect();
    found.sort_by(|a, b| {
        (a.0, std::cmp::Reverse(a.1), &a.2.account.website, &a.2.account.email)
            .cmp(&(b.0, std::cmp::Reverse(b.1), &b.2.account.website, &b.2.account.email))
    });
    found.into_iter().map(|(tier, _, entry)| (tier, entry)).collect()
}

/// On a provider's sign-in page (accounts.google.com…) during a sign-in for some site: that
/// site ("vercel.com"), and the provider accounts the user's accounts there sign in with.
/// Only for the provider page's own frames, and it only reorders their cards: those
/// accounts already match the provider's page by domain.
fn sign_in_for(entries: &[Entry], tab_url: &str, page: &Page) -> Option<(String, HashSet<i64>)> {
    let tab = Page::parse(tab_url)?;
    let same_site = tab.host == page.host || (tab.registrable.is_some() && tab.registrable == page.registrable);
    if !same_site {
        return None;
    }
    // One site, or none: never a second guess when the first has no accounts.
    let site = provider::relying_party(tab_url)?;
    let linked: HashSet<i64> = entries
        .iter()
        .filter(|entry| entry.account.kind == LoginKind::Account)
        .filter(|entry| matches!(matcher::compare(&entry.saved, &site), Verdict::Fill(_)))
        .flat_map(|entry| entry.account.signs_in_with.iter().copied())
        .collect();
    (!linked.is_empty()).then(|| (site.registrable.clone().unwrap_or_else(|| site.label()), linked))
}

/// The accounts that `logins` sign in with, found in one pass over the vault.
fn linked<'a>(entries: &'a [Entry], logins: &[&Entry]) -> HashMap<i64, &'a Entry> {
    let wanted: HashSet<i64> = logins
        .iter()
        .filter(|entry| entry.account.kind == LoginKind::Account)
        .flat_map(|entry| entry.account.signs_in_with.iter().copied())
        .collect();
    if wanted.is_empty() {
        return HashMap::new();
    }
    entries
        .iter()
        .filter(|entry| entry.account.kind == LoginKind::Account && wanted.contains(&entry.account.id))
        .map(|entry| (entry.account.id, entry))
        .collect()
}

/// What a linked account is called in a hint: its email, else its username, else its title.
fn hint_label(account: &Account) -> String {
    [account.email.as_str(), account.username.as_deref().unwrap_or_default(), account.title.as_str()]
        .into_iter()
        .map(str::trim)
        .find(|text| !text.is_empty())
        .unwrap_or_default()
        .to_owned()
}

fn hints(entry: &Entry, linked: &HashMap<i64, &Entry>) -> Vec<Hint> {
    let mut hints: Vec<Hint> = Vec::new();
    if entry.account.kind != LoginKind::Account {
        return hints;
    }
    for other in entry.account.signs_in_with.iter().filter_map(|id| linked.get(id)) {
        let hint = Hint { provider: provider::provider_id(&other.saved, &other.account.website), label: hint_label(&other.account) };
        if !hints.contains(&hint) {
            hints.push(hint);
        }
    }
    hints
}

/// A login about to be sent as a card.
struct Listed<'a> {
    entry: &'a Entry,
    tier: Tier,
    hints: Vec<Hint>,
    for_site: Option<&'a str>,
}

/// Same length as a real handle (16 bytes, base64): for measuring a reply before any
/// handle is issued.
const PLACEHOLDER_HANDLE: &str = "AAAAAAAAAAAAAAAAAAAAAA==";

fn card<'a>(listed: &'a Listed<'a>, h: String) -> Card<'a> {
    let account = &listed.entry.account;
    let method = if account.has_password {
        "password"
    } else if !listed.hints.is_empty() {
        "linked"
    } else {
        "none"
    };
    Card {
        h,
        kind: account.kind,
        title: account.title.trim(),
        host: listed.entry.saved.label().unwrap_or_default(),
        email: &account.email,
        username: account.username.as_deref(),
        method,
        tier: listed.tier,
        has_totp: account.has_totp,
        signs_in_with: &listed.hints,
        for_site: listed.for_site,
        last_used: None,
    }
}

fn cards<'a>(listed: &'a [Listed<'a>], mut handle: impl FnMut(&Account) -> String) -> Vec<Card<'a>> {
    listed.iter().map(|listed| card(listed, handle(&listed.entry.account))).collect()
}

fn sso_hints<'a>(listed: &'a [Listed<'a>]) -> Vec<&'a Hint> {
    let mut hints: Vec<&Hint> = Vec::new();
    for hint in listed.iter().flat_map(|listed| &listed.hints) {
        if !hints.contains(&hint) {
            hints.push(hint);
        }
    }
    hints
}

/// How many of `count` cards fit one encrypted message (`reply_with(n)`: the reply with the
/// first `n`): all, or fewer, halving, so the least likely go. `None` if not even none fit.
fn fitting(count: usize, reply_with: impl Fn(usize) -> Zeroizing<Vec<u8>>) -> Option<usize> {
    let mut limit = count;
    loop {
        if reply_with(limit).len() <= crate::noise::MAX_PLAINTEXT {
            return Some(limit);
        }
        if limit == 0 {
            return None;
        }
        limit /= 2;
    }
}

/// Does a search hit this login: the words typed, in any case, inside its title, website,
/// email or username.
fn mentions(account: &Account, needle: &str) -> bool {
    [account.title.as_str(), account.website.as_str(), account.email.as_str(), account.username.as_deref().unwrap_or_default()]
        .iter()
        .any(|text| text.to_lowercase().contains(needle))
}

const EXPIRED: &str = "That card has expired. Look it up again.";
const SEARCH_FILLS: &str = "Too many fills from search. Try again later, or fill from the page.";
const ELSEWHERE: &str = "That login isn't for this page.";

/// A handle's login, cleared to fill `frame_url`.
struct Cleared<'a> {
    entry: &'a Entry,
    page: Page,
    /// The handle came from `search`.
    searched: bool,
    cross_site: bool,
}

/// Checks a handle before anything is decrypted: issued to this session and not expired;
/// from `match`, still a login of this page (any of exact, subdomain, related); from
/// `search`, confirmed by the user, and then filled even on another site (cross-site).
/// Saved for https and the page on http: never, whoever asks.
fn clear<'a>(entries: &'a [Entry], grants: &Grants, h: &str, frame_url: &str, confirmed: bool, now: Instant) -> Result<Cleared<'a>, (Code, &'static str)> {
    let grant = grants.get(h, now).ok_or((Code::UnknownHandle, EXPIRED))?;
    if grant.searched && !confirmed {
        return Err((Code::ConfirmRequired, "Confirm filling this login on this site first."));
    }
    let page = Page::parse(frame_url).ok_or((Code::OriginMismatch, ELSEWHERE))?;
    let entry = entries.iter().find(|entry| entry.is(grant.kind, grant.id)).ok_or((Code::UnknownHandle, EXPIRED))?;
    let cross_site = match matcher::compare(&entry.saved, &page) {
        Verdict::Fill(_) => false,
        Verdict::Insecure => return Err((Code::OriginMismatch, ELSEWHERE)),
        Verdict::None if grant.searched && !(entry.saved.scheme() == Some(Scheme::Https) && page.scheme == Scheme::Http) => true,
        Verdict::None => return Err((Code::OriginMismatch, ELSEWHERE)),
    };
    Ok(Cleared { entry, page, searched: grant.searched, cross_site })
}

/// Answers one request of a session (`client` is the paired browser).
pub async fn answer(
    app: &Arc<dyn App>,
    client: ClientId,
    grants: &mut Grants,
    limiter: &Limiter,
    request: &Request,
) -> Zeroizing<Vec<u8>> {
    let id = request.id;
    let Some(call) = parse(request) else {
        return failure(id, Code::BadRequest, "Unknown method or parameters.");
    };
    let now = Instant::now();
    let what = match &call {
        Call::Ping => return Zeroizing::new(inner::reply(id, &Value::Object(Default::default()))),
        Call::Match(_) => Limited::Match,
        Call::Search(_) => Limited::Search,
        Call::Reveal(_) => Limited::Reveal,
        Call::Totp(_) => Limited::Totp,
    };
    if !limiter.allow(client, what, now) {
        return failure(id, Code::RateLimited, "Too many requests. Try again in a minute.");
    }
    let entries = match crate::server::blocking(app, |app| app.accounts()).await {
        Ok(entries) => entries,
        Err(refusal) => return refused(id, refusal),
    };
    match call {
        Call::Ping => unreachable!("answered above"),
        Call::Match(p) => {
            // A frame gets its own site's cards, whatever the tab is.
            let Some(page) = Page::parse(&p.frame_url) else {
                return reply(id, &Matches { site: None, cards: Vec::new(), insecure: 0, sso_hints: Vec::new() });
            };
            let insecure = entries.iter().filter(|entry| matcher::compare(&entry.saved, &page) == Verdict::Insecure).count();
            let sign_in = sign_in_for(&entries, &p.tab_url, &page);
            let for_site = |entry: &Entry| {
                let (site, linked) = sign_in.as_ref()?;
                (entry.account.kind == LoginKind::Account && linked.contains(&entry.account.id)).then_some(site.as_str())
            };
            let mut ranked: Vec<(Tier, &Entry, Option<&str>)> =
                ranked(&entries, &page).into_iter().map(|(tier, entry)| (tier, entry, for_site(entry))).collect();
            // The accounts this sign-in is for come first; the rest keep their order.
            ranked.sort_by_key(|(_, _, site)| site.is_none());
            ranked.truncate(MAX_CARDS);
            let logins: Vec<&Entry> = ranked.iter().map(|(_, entry, _)| *entry).collect();
            let linked = linked(&entries, &logins);
            let listed: Vec<Listed> = ranked
                .into_iter()
                .map(|(tier, entry, for_site)| Listed { entry, tier, hints: hints(entry, &linked), for_site })
                .collect();
            let site = || Some(Site { host: page.label(), registrable: page.registrable.clone() });
            let matches = |listed: &[Listed], handle: &mut dyn FnMut(&Account) -> String| {
                reply(id, &Matches { site: site(), cards: cards(listed, handle), insecure, sso_hints: sso_hints(listed) })
            };
            // The reply must fit one encrypted message: with very long titles and emails, the
            // least likely cards go. Measured with placeholder handles; real ones are issued
            // only for the cards sent.
            let Some(limit) = fitting(listed.len(), |n| matches(&listed[..n], &mut |_| PLACEHOLDER_HANDLE.to_owned())) else {
                return failure(id, Code::Internal, "Too much to send for this page.");
            };
            matches(&listed[..limit], &mut |account| grants.issue(account, false, now))
        }
        Call::Search(p) => {
            let needle = p.q.trim().to_lowercase();
            let mut found: Vec<&Entry> =
                if needle.is_empty() { Vec::new() } else { entries.iter().filter(|entry| mentions(&entry.account, &needle)).collect() };
            // Best first: the tab's own logins, then titles that start with the words typed,
            // then by title and email.
            let tab = Page::parse(&p.tab_url);
            found.sort_by_cached_key(|entry| {
                let here = tab.as_ref().is_some_and(|tab| matches!(matcher::compare(&entry.saved, tab), Verdict::Fill(_)));
                let title = entry.account.title.trim().to_lowercase();
                (!here, !title.starts_with(&needle), title, entry.account.email.to_lowercase())
            });
            found.truncate(p.limit);
            let linked = linked(&entries, &found);
            let listed: Vec<Listed> =
                found.into_iter().map(|entry| Listed { entry, tier: Tier::Search, hints: hints(entry, &linked), for_site: None }).collect();
            let found = |listed: &[Listed], handle: &mut dyn FnMut(&Account) -> String| reply(id, &Found { cards: cards(listed, handle) });
            let Some(limit) = fitting(listed.len(), |n| found(&listed[..n], &mut |_| PLACEHOLDER_HANDLE.to_owned())) else {
                return failure(id, Code::Internal, "Too much to send for this search.");
            };
            found(&listed[..limit], &mut |account| grants.issue(account, true, now))
        }
        Call::Reveal(p) => {
            let cleared = match clear(&entries, grants, &p.h, &p.frame_url, p.confirmed_cross_site, now) {
                Ok(cleared) => cleared,
                Err((code, msg)) => return failure(id, code, msg),
            };
            if cleared.searched && !limiter.allow(client, Limited::SearchFill, now) {
                return failure(id, Code::RateLimited, SEARCH_FILLS);
            }
            let (kind, account) = (cleared.entry.account.kind, cleared.entry.account.id);
            let login = match crate::server::blocking(app, move |app| app.login(kind, account)).await {
                Ok(Some(login)) if !login.password.is_empty() => login,
                Ok(_) => return failure(id, Code::NoSecret, "This account has no saved password."),
                Err(refusal) => return refused(id, refusal),
            };
            app.filled(Fill {
                client,
                account,
                site: cleared.page.label(),
                what: FillKind::Login,
                via: p.via,
                kind,
                cross_site: cleared.cross_site,
            });
            let room = room_for(&[&login.email, login.username.as_deref().unwrap_or_default(), &login.password]);
            reply_into(id, &Revealed { email: &login.email, username: login.username.as_deref(), password: &login.password }, room)
        }
        Call::Totp(p) => {
            let cleared = match clear(&entries, grants, &p.h, &p.frame_url, p.confirmed_cross_site, now) {
                Ok(cleared) => cleared,
                Err((code, msg)) => return failure(id, code, msg),
            };
            if cleared.searched && !limiter.allow(client, Limited::SearchFill, now) {
                return failure(id, Code::RateLimited, SEARCH_FILLS);
            }
            let (kind, account) = (cleared.entry.account.kind, cleared.entry.account.id);
            let code = match crate::server::blocking(app, move |app| app.code(kind, account)).await {
                Ok(Some(code)) => code,
                Ok(None) => return failure(id, Code::NoSecret, "This account has no authenticator setup key."),
                Err(refusal) => return refused(id, refusal),
            };
            app.filled(Fill {
                client,
                account,
                site: cleared.page.label(),
                what: FillKind::Code,
                via: Via::Popup,
                kind,
                cross_site: cleared.cross_site,
            });
            reply(id, &CodeReply { code: &code.code, expires_at: code.expires_at })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn login(id: i64) -> Account {
        Account {
            kind: LoginKind::Account,
            id,
            title: String::new(),
            website: String::new(),
            email: String::new(),
            username: None,
            has_password: true,
            has_totp: false,
            signs_in_with: Vec::new(),
        }
    }

    #[test]
    fn handles_expire_and_are_unguessable() {
        let mut grants = Grants::default();
        let now = Instant::now();
        let first = grants.issue(&login(7), false, now);
        let second = grants.issue(&login(7), true, now);
        assert_ne!(first, second);
        assert_eq!(first.len(), 24);
        let grant = grants.get(&first, now + Duration::from_secs(60)).unwrap();
        assert_eq!((grant.kind, grant.id, grant.searched), (LoginKind::Account, 7, false));
        assert!(grants.get(&second, now).unwrap().searched, "a search handle says so");
        assert!(grants.get(&first, now + HANDLE_TTL).is_none());
        assert!(grants.get("7", now).is_none());
    }

    #[test]
    fn a_session_keeps_a_bounded_number_of_handles() {
        let mut grants = Grants::default();
        let now = Instant::now();
        let first = grants.issue(&login(1), false, now);
        for _ in 0..MAX_HANDLES {
            grants.issue(&login(2), false, now);
        }
        assert_eq!(grants.handles.len(), MAX_HANDLES);
        assert!(grants.get(&first, now).is_none(), "the oldest went first");
    }

    #[test]
    fn limits_are_per_browser_and_per_minute() {
        let limiter = Limiter::default();
        let now = Instant::now();
        let (a, b) = ([1; 16], [2; 16]);
        for _ in 0..20 {
            assert!(limiter.allow(a, Limited::Reveal, now));
        }
        assert!(!limiter.allow(a, Limited::Reveal, now));
        assert!(limiter.allow(b, Limited::Reveal, now), "another browser has its own");
        assert!(limiter.allow(a, Limited::Match, now), "another method has its own");
        assert!(limiter.allow(a, Limited::Reveal, now + Duration::from_secs(60)));
        for _ in 0..60 {
            assert!(limiter.allow(a, Limited::Search, now));
        }
        assert!(!limiter.allow(a, Limited::Search, now));
    }

    #[test]
    fn fills_from_search_have_a_minute_and_an_hour_window() {
        let limiter = Limiter::default();
        let start = Instant::now();
        let (a, b) = ([1; 16], [2; 16]);
        let at = |minutes: u64| start + Duration::from_secs(60 * minutes);
        // 3 a minute.
        for _ in 0..3 {
            assert!(limiter.allow(a, Limited::SearchFill, at(0)));
        }
        assert!(!limiter.allow(a, Limited::SearchFill, at(0)));
        assert!(limiter.allow(b, Limited::SearchFill, at(0)), "another browser has its own");
        // 10 an hour, however they're spread.
        for minute in 1..=2 {
            for _ in 0..3 {
                assert!(limiter.allow(a, Limited::SearchFill, at(minute)), "minute {minute}");
            }
        }
        assert!(limiter.allow(a, Limited::SearchFill, at(3)), "the 10th");
        for minute in [3, 4, 30, 59] {
            assert!(!limiter.allow(a, Limited::SearchFill, at(minute)), "over 10 in the hour, minute {minute}");
        }
        // Refusals aren't counted: a new hour starts afresh.
        for _ in 0..3 {
            assert!(limiter.allow(a, Limited::SearchFill, at(60)));
        }
        assert!(!limiter.allow(a, Limited::SearchFill, at(60)));
        // A page's own fills keep their own limit.
        assert!(limiter.allow(a, Limited::Reveal, at(60)));
    }

    #[test]
    fn requests_are_checked_before_anything_runs() {
        let request = |json: &str| Request::from_bytes(json.as_bytes()).unwrap();
        for good in [
            r#"{"id":1,"m":"ping"}"#,
            r#"{"id":1,"m":"match","p":{"tabUrl":"https://a.com/","frameUrl":"https://a.com/"}}"#,
            r#"{"id":1,"m":"reveal","p":{"h":"x","tabUrl":"x","frameUrl":"x","via":"popup","confirmedCrossSite":true}}"#,
            r#"{"id":1,"m":"reveal","p":{"h":"x","tabUrl":"x","frameUrl":"x","via":"menu"}}"#,
            r#"{"id":1,"m":"totp","p":{"h":"x","tabUrl":"x","frameUrl":"x","confirmedCrossSite":false}}"#,
            r#"{"id":1,"m":"search","p":{"q":"git","tabUrl":"chrome://newtab","limit":20}}"#,
        ] {
            assert!(parse(&request(good)).is_some(), "refused {good}");
        }
        let long_query = format!(r#"{{"id":1,"m":"search","p":{{"q":"{}","tabUrl":"x","limit":5}}}}"#, "é".repeat(MAX_QUERY + 1));
        assert!(parse(&request(&long_query)).is_none());
        let longest_query = format!(r#"{{"id":1,"m":"search","p":{{"q":"{}","tabUrl":"x","limit":5}}}}"#, "é".repeat(MAX_QUERY));
        assert!(parse(&request(&longest_query)).is_some(), "200 characters, not bytes");
        for bad in [
            r#"{"id":1,"m":"ping","p":{}}"#,
            r#"{"id":1,"m":"match","p":{"tabUrl":"https://a.com/"}}"#,
            r#"{"id":1,"m":"match","p":{"tabUrl":"x","frameUrl":"x","extra":1}}"#,
            r#"{"id":1,"m":"match","p":[1]}"#,
            r#"{"id":1,"m":"reveal","p":{"h":"x","tabUrl":"x","frameUrl":"x"}}"#,
            r#"{"id":1,"m":"reveal","p":{"h":"x","tabUrl":"x","frameUrl":"x","via":"telepathy"}}"#,
            r#"{"id":1,"m":"reveal","p":{"h":"x","tabUrl":"x","frameUrl":"x","via":"popup","confirmedCrossSite":"yes"}}"#,
            r#"{"id":1,"m":"reveal","p":{"h":"x","tabUrl":"x","frameUrl":"x","via":"popup","confirmedCrossSite":null}}"#,
            r#"{"id":1,"m":"list","p":{}}"#,
            r#"{"id":1,"m":"totp","p":{"h":7,"tabUrl":"x","frameUrl":"x"}}"#,
            r#"{"id":1,"m":"search","p":{"q":"","tabUrl":"x","limit":5}}"#,
            r#"{"id":1,"m":"search","p":{"q":"a","tabUrl":"x","limit":0}}"#,
            r#"{"id":1,"m":"search","p":{"q":"a","tabUrl":"x","limit":21}}"#,
            r#"{"id":1,"m":"search","p":{"q":"a","tabUrl":"x","limit":-1}}"#,
            r#"{"id":1,"m":"search","p":{"q":"a","tabUrl":"x"}}"#,
            r#"{"id":1,"m":"search","p":{"q":"a","limit":5}}"#,
            r#"{"id":1,"m":"search","p":{"q":"a","tabUrl":"x","limit":5,"frameUrl":"x"}}"#,
        ] {
            assert!(parse(&request(bad)).is_none(), "accepted {bad}");
        }
        let long = format!(r#"{{"id":1,"m":"match","p":{{"tabUrl":"x","frameUrl":"https://a.com/{}"}}}}"#, "a".repeat(MAX_URL));
        assert!(parse(&request(&long)).is_none());
    }

    /// A vault in memory: accounts, a service login, their logins, one authenticator.
    struct Vault {
        entries: Arc<[Entry]>,
        locked: std::sync::atomic::AtomicBool,
        fills: Mutex<Vec<Fill>>,
        opened: std::sync::atomic::AtomicUsize,
    }

    fn account(id: i64, website: &str, email: &str, has_password: bool, has_totp: bool) -> Entry {
        linked_account(id, website, email, has_password, has_totp, &[])
    }

    fn linked_account(id: i64, website: &str, email: &str, has_password: bool, has_totp: bool, signs_in_with: &[i64]) -> Entry {
        Entry::new(Account {
            kind: LoginKind::Account,
            id,
            title: website.into(),
            website: website.into(),
            email: email.into(),
            username: None,
            has_password,
            has_totp,
            signs_in_with: signs_in_with.to_vec(),
        })
    }

    /// A project service's own login: same id as account 1, on purpose.
    fn service_login() -> Entry {
        Entry::new(Account {
            kind: LoginKind::ServiceLogin,
            id: 1,
            title: "Prod server".into(),
            website: "https://admin.example.org/".into(),
            email: "root".into(),
            username: None,
            has_password: true,
            has_totp: false,
            signs_in_with: Vec::new(),
        })
    }

    fn vault_of(entries: Vec<Entry>) -> Arc<Vault> {
        Arc::new(Vault { entries: Arc::from(entries), locked: Default::default(), fills: Mutex::default(), opened: Default::default() })
    }

    fn vault() -> Arc<Vault> {
        vault_of(vec![
            linked_account(1, "github.com", "me@x.com", true, true, &[7]),
            account(2, "https://gist.github.com/login", "other@x.com", true, false),
            account(3, "g1thub.com", "phish@x.com", true, false),
            account(4, "https://bank.com", "me@bank.com", true, false),
            linked_account(5, "vercel.com", "me@vercel.dev", false, false, &[7, 7, 99]),
            account(6, "GitHub", "named@x.com", true, false),
            account(7, "google.com", "me@gmail.com", true, false),
            account(8, "accounts.google.com", "work@corp.com", true, false),
            account(9, "steampowered.com", "gamer@x.com", true, false),
            account(10, "nopass.example.com", "nobody@x.com", false, false),
            service_login(),
        ])
    }

    impl App for Vault {
        fn status(&self) -> tokio::sync::watch::Receiver<crate::server::Status> {
            unreachable!("not used by the API")
        }
        fn static_key(&self) -> Result<crate::noise::PrivateKey, Refusal> {
            unreachable!()
        }
        fn client_key(&self, _: &ClientId) -> Result<Option<crate::noise::PublicKey>, Refusal> {
            unreachable!()
        }
        fn ask_to_pair(&self, _: crate::server::PairingRequest) -> Result<tokio::sync::oneshot::Receiver<bool>, Refusal> {
            unreachable!()
        }
        fn seen(&self, _: &ClientId) {}
        fn accounts(&self) -> Result<Arc<[Entry]>, Refusal> {
            if self.locked.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(Refusal::Locked);
            }
            Ok(Arc::clone(&self.entries))
        }
        fn login(&self, kind: LoginKind, id: i64) -> Result<Option<Login>, Refusal> {
            let entry = self.entries.iter().find(|entry| entry.is(kind, id));
            let prefix = if kind == LoginKind::Account { "password" } else { "service" };
            Ok(entry.filter(|entry| entry.account.has_password).map(|entry| Login {
                email: entry.account.email.clone(),
                username: Some("me".into()),
                password: Zeroizing::new(format!("{prefix}-{id}")),
            }))
        }
        fn code(&self, kind: LoginKind, id: i64) -> Result<Option<AuthCode>, Refusal> {
            Ok((kind == LoginKind::Account && id == 1).then(|| AuthCode { code: "123456".into(), expires_at: 1_700_000_030_000 }))
        }
        fn filled(&self, fill: Fill) {
            self.fills.lock().unwrap().push(fill);
        }
        fn open_window(&self) {
            self.opened.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    struct Session {
        app: Arc<dyn App>,
        vault: Arc<Vault>,
        grants: Grants,
        limiter: Arc<Limiter>,
        next: u32,
    }

    impl Session {
        fn new(vault: &Arc<Vault>, limiter: &Arc<Limiter>) -> Self {
            Self { app: Arc::clone(vault) as Arc<dyn App>, vault: Arc::clone(vault), grants: Grants::default(), limiter: Arc::clone(limiter), next: 0 }
        }

        async fn raw(&mut self, m: &str, p: Value) -> String {
            self.next += 1;
            let request = Request::from_bytes(serde_json::json!({ "id": self.next, "m": m, "p": p }).to_string().as_bytes()).unwrap();
            let bytes = answer(&self.app, [9; 16], &mut self.grants, &self.limiter, &request).await;
            String::from_utf8(bytes.to_vec()).unwrap()
        }

        async fn call(&mut self, m: &str, p: Value) -> Value {
            let reply: Value = serde_json::from_str(&self.raw(m, p).await).unwrap();
            assert_eq!(reply["id"], self.next);
            reply
        }

        async fn cards_in(&mut self, tab: &str, frame: &str) -> Value {
            let reply = self.call("match", serde_json::json!({ "tabUrl": tab, "frameUrl": frame })).await;
            assert_eq!(reply["ok"], true, "{reply}");
            reply["r"].clone()
        }

        async fn cards(&mut self, page: &str) -> Value {
            self.cards_in(page, page).await
        }

        async fn search(&mut self, q: &str, tab: &str, limit: usize) -> Value {
            let reply = self.call("search", serde_json::json!({ "q": q, "tabUrl": tab, "limit": limit })).await;
            assert_eq!(reply["ok"], true, "{reply}");
            reply["r"]["cards"].clone()
        }

        async fn reveal(&mut self, h: &Value, page: &str) -> Value {
            self.call("reveal", serde_json::json!({ "h": h, "tabUrl": page, "frameUrl": page, "via": "popup" })).await
        }

        async fn reveal_anyway(&mut self, h: &Value, page: &str, confirmed: bool) -> Value {
            let p = serde_json::json!({ "h": h, "tabUrl": page, "frameUrl": page, "via": "popup", "confirmedCrossSite": confirmed });
            self.call("reveal", p).await
        }
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    fn error(reply: &Value) -> &str {
        reply["e"]["code"].as_str().unwrap_or("none")
    }

    fn emails(cards: &Value) -> Vec<&str> {
        cards.as_array().unwrap().iter().map(|card| card["email"].as_str().unwrap()).collect()
    }

    /// The card that `email` is on.
    fn card<'a>(cards: &'a Value, email: &str) -> &'a Value {
        cards.as_array().unwrap().iter().find(|card| card["email"] == email).unwrap_or_else(|| panic!("no card for {email} in {cards}"))
    }

    #[test]
    fn match_gives_this_pages_cards_and_nothing_else() {
        runtime().block_on(async {
            let vault = vault();
            let mut session = Session::new(&vault, &Arc::new(Limiter::default()));
            let found = session.cards("https://github.com/login").await;
            assert_eq!(emails(&found["cards"]), ["me@x.com", "other@x.com"], "exact first; never g1thub.com or the name-only GitHub");
            assert_eq!(found["site"], serde_json::json!({ "host": "github.com", "registrable": "github.com" }));
            let card = &found["cards"][0];
            assert_eq!(card["tier"], "exact");
            assert_eq!(card["hasTotp"], true);
            assert_eq!(card["method"], "password");
            assert_eq!(card["kind"], "account");
            assert_eq!(card["title"], "github.com");
            assert_eq!(card["forSite"], Value::Null);
            assert_eq!(card["lastUsed"], Value::Null);
            assert_eq!(card["signsInWith"], serde_json::json!([{ "provider": "google", "label": "me@gmail.com" }]));
            assert_eq!(found["ssoHints"], serde_json::json!([{ "provider": "google", "label": "me@gmail.com" }]));
            assert_eq!(found["cards"][1]["tier"], "subdomain");
            assert_eq!(found["cards"][1]["host"], "gist.github.com");

            assert_eq!(session.cards("https://bank.com/").await["insecure"], 0);
            let http = session.cards("http://bank.com/").await;
            assert_eq!((http["cards"].as_array().unwrap().len(), http["insecure"].as_u64()), (0, Some(1)));
            assert_eq!(
                session.cards("chrome://settings").await,
                serde_json::json!({ "site": null, "cards": [], "insecure": 0, "ssoHints": [] })
            );
            let none = session.cards("https://nopass.example.com/").await;
            assert_eq!((none["cards"][0]["method"].as_str(), none["ssoHints"].as_array().unwrap().len()), (Some("none"), 0));
            // A frame only ever gets its own site's cards, whatever the tab.
            let frame = session.cards_in("https://github.com/login", "https://evil.io/frame").await;
            assert_eq!(frame["cards"], serde_json::json!([]));
            assert_eq!(frame["ssoHints"], serde_json::json!([]));
        });
    }

    #[test]
    fn card_keys_come_in_the_fixtures_order() {
        runtime().block_on(async {
            let vault = vault();
            let mut session = Session::new(&vault, &Arc::new(Limiter::default()));
            let raw = session.raw("match", serde_json::json!({ "tabUrl": "https://github.com/", "frameUrl": "https://github.com/" })).await;
            let keys = ["h", "kind", "title", "host", "email", "username", "method", "tier", "hasTotp", "signsInWith", "forSite", "lastUsed"];
            let first = &raw[raw.find(r#""cards":[{"#).unwrap()..];
            let at: Vec<usize> = keys.iter().map(|key| first.find(&format!(r#""{key}":"#)).unwrap_or_else(|| panic!("{key} in {raw}"))).collect();
            assert!(at.windows(2).all(|pair| pair[0] < pair[1]), "{raw}");
            let result = &raw[raw.find(r#""r":"#).unwrap()..];
            let at: Vec<usize> = ["site", "cards", "insecure", "ssoHints"].iter().map(|key| result.find(&format!(r#""{key}":"#)).unwrap()).collect();
            assert!(at.windows(2).all(|pair| pair[0] < pair[1]), "{raw}");
        });
    }

    #[test]
    fn related_domains_fill_after_the_sites_own() {
        runtime().block_on(async {
            let vault = vault();
            let mut session = Session::new(&vault, &Arc::new(Limiter::default()));
            let found = session.cards("https://steamcommunity.com/login").await;
            assert_eq!(emails(&found["cards"]), ["gamer@x.com"]);
            assert_eq!((found["cards"][0]["tier"].as_str(), found["cards"][0]["host"].as_str()), (Some("related"), Some("steampowered.com")));
            let h = found["cards"][0]["h"].clone();
            assert_eq!(session.reveal(&h, "https://steamcommunity.com/login").await["r"]["password"], "password-9");
            // Same site: subdomain, as before.
            assert_eq!(session.cards("https://store.steampowered.com/").await["cards"][0]["tier"], "subdomain");
            // A lookalike of a related site: nothing, and the handle doesn't work there.
            assert_eq!(session.cards("https://steamcommunity.com.evil.io/").await["cards"], serde_json::json!([]));
            assert_eq!(error(&session.reveal(&h, "https://steamcommunlty.com/").await), "ORIGIN_MISMATCH");

            // Ordered after this site's own logins.
            let vault = vault_of(vec![
                account(1, "steamcommunity.com", "own@x.com", true, false),
                account(2, "steampowered.com", "related@x.com", true, false),
                account(3, "help.steamcommunity.com", "sub@x.com", true, false),
            ]);
            let mut session = Session::new(&vault, &Arc::new(Limiter::default()));
            let found = session.cards("https://steamcommunity.com/").await;
            assert_eq!(emails(&found["cards"]), ["own@x.com", "sub@x.com", "related@x.com"]);
        });
    }

    #[test]
    fn accounts_that_sign_in_with_another_say_so() {
        runtime().block_on(async {
            let vault = vault();
            let mut session = Session::new(&vault, &Arc::new(Limiter::default()));
            let found = session.cards("https://vercel.com/login").await;
            let card = &found["cards"][0];
            assert_eq!(card["method"], "linked");
            // Once each, and a link to a login that's gone is left out.
            assert_eq!(card["signsInWith"], serde_json::json!([{ "provider": "google", "label": "me@gmail.com" }]));
            assert_eq!(found["ssoHints"], card["signsInWith"]);
            // No handle for the Google account rides along: only vercel.com's card.
            assert_eq!(found["cards"].as_array().unwrap().len(), 1);
            assert_eq!(error(&session.reveal(&card["h"], "https://vercel.com/").await), "NO_SECRET");
        });
    }

    #[test]
    fn on_a_providers_page_the_accounts_for_that_site_come_first() {
        runtime().block_on(async {
            let vault = vault();
            let mut session = Session::new(&vault, &Arc::new(Limiter::default()));
            // Without a sign-in for some site: tier order.
            let plain = session.cards("https://accounts.google.com/v3/signin/identifier").await;
            assert_eq!(emails(&plain["cards"]), ["work@corp.com", "me@gmail.com"]);
            assert!(plain["cards"].as_array().unwrap().iter().all(|card| card["forSite"].is_null()));

            // Signing in to vercel.com, which signs in with me@gmail.com.
            let tab = "https://accounts.google.com/o/oauth2/v2/auth?client_id=1-a.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fvercel.com%2Fapi%2Fauth%2Fcallback%2Fgoogle&response_type=code";
            let found = session.cards(tab).await;
            assert_eq!(emails(&found["cards"]), ["me@gmail.com", "work@corp.com"]);
            assert_eq!(found["cards"][0]["forSite"], "vercel.com");
            assert_eq!(found["cards"][0]["tier"], "subdomain", "the tier stays what it is");
            assert_eq!(found["cards"][1]["forSite"], Value::Null);
            // Nothing more than the page's own cards: the order changed, not what's sent.
            assert_eq!(found["cards"].as_array().unwrap().len(), plain["cards"].as_array().unwrap().len());

            // A site with no account in the vault, and another site's frame in that tab.
            let unknown = session.cards("https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fnot-saved.io%2Fcb").await;
            assert_eq!(emails(&unknown["cards"]), ["work@corp.com", "me@gmail.com"]);
            let frame = session.cards_in(tab, "https://github.com/").await;
            assert!(frame["cards"].as_array().unwrap().iter().all(|card| card["forSite"].is_null()));

            // evil.example's sign-in with vercel.com added to the link: no site is "for"
            // anything, and the order is the normal one.
            let spoofed = "https://accounts.google.com/o/oauth2/v2/auth?client_id=1-a.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fevil.example%2Fcb&followup=https%3A%2F%2Fvercel.com";
            let found = session.cards(spoofed).await;
            assert_eq!(emails(&found["cards"]), ["work@corp.com", "me@gmail.com"]);
            assert!(found["cards"].as_array().unwrap().iter().all(|card| card["forSite"].is_null()), "{found}");
            // And when the one site named has no accounts here, there's no second guess.
            let unlinked = session.cards("https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fevil.example%2Fcb").await;
            assert_eq!(emails(&unlinked["cards"]), ["work@corp.com", "me@gmail.com"]);
        });
    }

    #[test]
    fn service_logins_are_cards_of_their_own_kind() {
        runtime().block_on(async {
            let vault = vault();
            let mut session = Session::new(&vault, &Arc::new(Limiter::default()));
            let found = session.cards("https://admin.example.org/login").await;
            let card = &found["cards"][0];
            assert_eq!(
                (&card["kind"], &card["title"], &card["email"], &card["username"], &card["hasTotp"], &card["host"]),
                (&serde_json::json!("service_login"), &serde_json::json!("Prod server"), &serde_json::json!("root"), &Value::Null, &serde_json::json!(false), &serde_json::json!("admin.example.org"))
            );
            // Its id is account 1's too: the handle keeps the kind.
            let revealed = session.reveal(&card["h"], "https://admin.example.org/").await;
            assert_eq!(revealed["r"]["password"], "service-1");
            let totp = session.call("totp", serde_json::json!({ "h": card["h"], "tabUrl": "https://admin.example.org/", "frameUrl": "https://admin.example.org/" })).await;
            assert_eq!(error(&totp), "NO_SECRET");
            let fills = vault.fills.lock().unwrap();
            assert_eq!((fills[0].kind, fills[0].account, fills[0].cross_site), (LoginKind::ServiceLogin, 1, false));
        });
    }

    #[test]
    fn search_finds_by_name_and_fills_only_once_confirmed() {
        runtime().block_on(async {
            let vault = vault();
            let mut session = Session::new(&vault, &Arc::new(Limiter::default()));
            let found = session.search("GIT", "https://github.com/", 20).await;
            assert_eq!(emails(&found), ["me@x.com", "other@x.com", "named@x.com"], "this tab's logins first, then by title");
            assert!(found.as_array().unwrap().iter().all(|card| card["tier"] == "search" && card["forSite"].is_null()));
            assert_eq!(emails(&session.search("gmail", "chrome://newtab", 20).await), ["me@gmail.com"]);
            assert_eq!(emails(&session.search("  vercel ", "chrome://newtab", 20).await), ["me@vercel.dev"]);
            assert_eq!(emails(&session.search("prod", "chrome://newtab", 20).await), ["root"], "service logins too");
            assert_eq!(session.search("git", "chrome://newtab", 1).await.as_array().unwrap().len(), 1);
            assert_eq!(session.search("nothing like it", "chrome://newtab", 20).await, serde_json::json!([]));
            assert_eq!(session.search("   ", "chrome://newtab", 20).await, serde_json::json!([]));

            // The name-only GitHub, filled on github.com: only once the user confirms.
            let named = card(&found, "named@x.com")["h"].clone();
            assert_eq!(error(&session.reveal(&named, "https://github.com/login").await), "CONFIRM_REQUIRED");
            assert_eq!(error(&session.reveal_anyway(&named, "https://github.com/login", false).await), "CONFIRM_REQUIRED");
            let revealed = session.reveal_anyway(&named, "https://github.com/login", true).await;
            assert_eq!(revealed["r"]["password"], "password-6");
            // A result that does match the page still needs it, and then isn't cross-site.
            let own = card(&found, "me@x.com")["h"].clone();
            assert_eq!(error(&session.reveal(&own, "https://github.com/").await), "CONFIRM_REQUIRED");
            assert_eq!(session.reveal_anyway(&own, "https://github.com/", true).await["ok"], true);
            // Confirmed: any http(s) page, but never a login saved for https on an http page.
            assert_eq!(session.reveal_anyway(&own, "https://evil.io/", true).await["ok"], true);
            assert_eq!(error(&session.reveal_anyway(&own, "chrome://settings", true).await), "ORIGIN_MISMATCH");
            let bank = session.search("bank", "chrome://newtab", 20).await[0]["h"].clone();
            assert_eq!(error(&session.reveal_anyway(&bank, "http://other.io/", true).await), "ORIGIN_MISMATCH");
            assert_eq!(error(&session.reveal_anyway(&bank, "http://bank.com/", true).await), "ORIGIN_MISMATCH");
            // The authenticator code follows the same rule (a fresh browser: the fills
            // above used this one's search-fill budget).
            let mut session = Session::new(&vault, &Arc::new(Limiter::default()));
            let own = session.search("github.com", "chrome://newtab", 1).await[0]["h"].clone();
            let totp = |confirmed: Option<bool>| {
                let mut p = serde_json::json!({ "h": own, "tabUrl": "https://gitlab.com/", "frameUrl": "https://gitlab.com/" });
                if let Some(confirmed) = confirmed {
                    p["confirmedCrossSite"] = confirmed.into();
                }
                p
            };
            assert_eq!(error(&session.call("totp", totp(None)).await), "CONFIRM_REQUIRED");
            assert_eq!(session.call("totp", totp(Some(true))).await["r"]["code"], "123456");

            let fills = vault.fills.lock().unwrap();
            let seen: Vec<_> = fills.iter().map(|fill| (fill.account, fill.site.as_str(), fill.cross_site, fill.what)).collect();
            assert_eq!(
                seen,
                [
                    (6, "github.com", true, FillKind::Login),
                    (1, "github.com", false, FillKind::Login),
                    (1, "evil.io", true, FillKind::Login),
                    (1, "gitlab.com", true, FillKind::Code),
                ]
            );
        });
    }

    /// A compromised extension can forge `confirmedCrossSite`: what it can take through
    /// search is bounded by the search-fill limit, own site or not, reveal and totp alike.
    #[test]
    fn fills_from_search_are_strictly_limited() {
        runtime().block_on(async {
            let vault = vault();
            let limiter = Arc::new(Limiter::default());
            let mut session = Session::new(&vault, &limiter);
            let own = session.search("github.com", "https://github.com/", 1).await[0]["h"].clone();
            // Unconfirmed tries release nothing and aren't counted.
            for _ in 0..5 {
                assert_eq!(error(&session.reveal(&own, "https://github.com/").await), "CONFIRM_REQUIRED");
            }
            for _ in 0..3 {
                assert_eq!(session.reveal_anyway(&own, "https://github.com/", true).await["ok"], true);
            }
            assert_eq!(error(&session.reveal_anyway(&own, "https://github.com/", true).await), "RATE_LIMITED");
            assert_eq!(error(&session.reveal_anyway(&own, "https://evil.io/", true).await), "RATE_LIMITED");
            let totp = serde_json::json!({ "h": own, "tabUrl": "https://github.com/", "frameUrl": "https://github.com/", "confirmedCrossSite": true });
            assert_eq!(error(&session.call("totp", totp).await), "RATE_LIMITED");
            // Across sessions of the same browser too.
            let mut next = Session::new(&vault, &limiter);
            let again = next.search("github.com", "https://github.com/", 1).await[0]["h"].clone();
            assert_eq!(error(&next.reveal_anyway(&again, "https://github.com/", true).await), "RATE_LIMITED");
            // The page's own cards keep theirs.
            let h = next.cards("https://github.com/").await["cards"][0]["h"].clone();
            assert_eq!(next.reveal(&h, "https://github.com/").await["r"]["password"], "password-1");
            assert_eq!(vault.fills.lock().unwrap().len(), 4, "3 from search, 1 from the page");
        });
    }

    #[test]
    fn a_match_handle_never_fills_elsewhere_even_when_confirmed() {
        runtime().block_on(async {
            let vault = vault();
            let mut session = Session::new(&vault, &Arc::new(Limiter::default()));
            let h = session.cards("https://github.com/").await["cards"][0]["h"].clone();
            assert_eq!(error(&session.reveal_anyway(&h, "https://evil.io/", true).await), "ORIGIN_MISMATCH");
            assert_eq!(session.reveal_anyway(&h, "https://github.com/", false).await["ok"], true);
            assert!(!vault.fills.lock().unwrap()[0].cross_site);
        });
    }

    #[test]
    fn searches_are_rate_limited() {
        runtime().block_on(async {
            let vault = vault();
            let mut session = Session::new(&vault, &Arc::new(Limiter::default()));
            for _ in 0..60 {
                session.search("git", "chrome://newtab", 5).await;
            }
            let over = session.call("search", serde_json::json!({ "q": "git", "tabUrl": "x", "limit": 5 })).await;
            assert_eq!(error(&over), "RATE_LIMITED");
        });
    }

    #[test]
    fn a_match_reply_always_fits_one_encrypted_message() {
        runtime().block_on(async {
            // 100 matching accounts with 1,500-byte emails: far over one message.
            let long = "x".repeat(1500);
            let entries: Vec<Entry> = (0..100)
                .map(|i| account(i, if i < 50 { "example.com" } else { "app.example.com" }, &format!("{long}{i}@example.com"), true, false))
                .collect();
            let vault = vault_of(entries);
            let mut session = Session::new(&vault, &Arc::new(Limiter::default()));
            let request = Request::from_bytes(br#"{"id":1,"m":"match","p":{"tabUrl":"https://example.com/","frameUrl":"https://example.com/"}}"#).unwrap();
            let bytes = answer(&session.app, [9; 16], &mut session.grants, &session.limiter, &request).await;
            assert!(bytes.len() <= crate::noise::MAX_PLAINTEXT, "{} bytes", bytes.len());
            let reply: Value = serde_json::from_slice(&bytes).unwrap();
            let cards = reply["r"]["cards"].as_array().unwrap();
            assert!(!cards.is_empty() && cards.len() < MAX_CARDS);
            // The best ones stayed: exact matches first.
            assert!(cards.iter().all(|card| card["tier"] == "exact"));
            // Handles were issued for the cards sent, and no others.
            assert_eq!(session.grants.handles.len(), cards.len());

            // A search too.
            let long_title = "y".repeat(3000);
            let entries: Vec<Entry> = (0..20).map(|i| account(i, &format!("{long_title}{i}.example.com"), &format!("{long}{i}@x.com"), true, false)).collect();
            let vault = vault_of(entries);
            let mut session = Session::new(&vault, &Arc::new(Limiter::default()));
            let request = Request::from_bytes(br#"{"id":1,"m":"search","p":{"q":"yyy","tabUrl":"x","limit":20}}"#).unwrap();
            let bytes = answer(&session.app, [9; 16], &mut session.grants, &session.limiter, &request).await;
            assert!(bytes.len() <= crate::noise::MAX_PLAINTEXT, "{} bytes", bytes.len());
            let reply: Value = serde_json::from_slice(&bytes).unwrap();
            let cards = reply["r"]["cards"].as_array().unwrap().len();
            assert!(cards > 0 && cards < 20 && session.grants.handles.len() == cards, "{cards} cards");
        });
    }

    #[test]
    fn reveal_needs_this_sessions_handle_on_a_page_it_matches() {
        runtime().block_on(async {
            let vault = vault();
            let limiter = Arc::new(Limiter::default());
            let mut session = Session::new(&vault, &limiter);
            let found = session.cards("https://github.com/login").await;
            let h = found["cards"][0]["h"].clone();

            let revealed = session.reveal(&h, "https://github.com/session").await;
            assert_eq!(revealed["r"], serde_json::json!({ "email": "me@x.com", "username": "me", "password": "password-1" }));
            // Same site, another subdomain: still github.com's.
            assert_eq!(session.reveal(&h, "https://gist.github.com/").await["ok"], true);
            // Anywhere else: no.
            for elsewhere in ["https://g1thub.com/", "https://github.com.evil.io/", "http://github.co/", "chrome://newtab"] {
                assert_eq!(error(&session.reveal(&h, elsewhere).await), "ORIGIN_MISMATCH", "{elsewhere}");
            }
            // Another session's handle, a made-up one, a database id.
            let mut other = Session::new(&vault, &limiter);
            assert_eq!(error(&other.reveal(&h, "https://github.com/").await), "UNKNOWN_HANDLE");
            assert_eq!(error(&session.reveal(&serde_json::json!("AAAAAAAAAAAAAAAAAAAAAA=="), "https://github.com/").await), "UNKNOWN_HANDLE");
            assert_eq!(error(&session.reveal(&serde_json::json!("1"), "https://github.com/").await), "UNKNOWN_HANDLE");

            let fills = vault.fills.lock().unwrap();
            assert_eq!(fills.len(), 2, "each reveal is recorded; refusals aren't");
            assert_eq!(
                (fills[0].account, fills[0].kind, fills[0].site.as_str(), fills[0].via, fills[0].cross_site),
                (1, LoginKind::Account, "github.com", Via::Popup, false)
            );
            assert_eq!(fills[1].site, "gist.github.com");
        });
    }

    #[test]
    fn totp_follows_the_same_rules() {
        runtime().block_on(async {
            let vault = vault();
            let mut session = Session::new(&vault, &Arc::new(Limiter::default()));
            let cards = session.cards("https://github.com/").await["cards"].clone();
            let page = serde_json::json!({ "h": cards[0]["h"], "tabUrl": "https://github.com/", "frameUrl": "https://github.com/" });
            let code = session.call("totp", page).await;
            assert_eq!(code["r"], serde_json::json!({ "code": "123456", "expiresAt": 1_700_000_030_000u64 }));
            let elsewhere = serde_json::json!({ "h": cards[0]["h"], "tabUrl": "https://evil.io/", "frameUrl": "https://evil.io/" });
            assert_eq!(error(&session.call("totp", elsewhere).await), "ORIGIN_MISMATCH");
            let without = serde_json::json!({ "h": cards[1]["h"], "tabUrl": "https://github.com/", "frameUrl": "https://github.com/" });
            assert_eq!(error(&session.call("totp", without).await), "NO_SECRET");
        });
    }

    #[test]
    fn reveals_are_rate_limited_per_browser_across_sessions() {
        runtime().block_on(async {
            let vault = vault();
            let limiter = Arc::new(Limiter::default());
            let mut first = Session::new(&vault, &limiter);
            let h = first.cards("https://github.com/").await["cards"][0]["h"].clone();
            for _ in 0..20 {
                assert_eq!(first.reveal(&h, "https://github.com/").await["ok"], true);
            }
            assert_eq!(error(&first.reveal(&h, "https://github.com/").await), "RATE_LIMITED");
            // A new session of the same browser doesn't start over.
            let mut second = Session::new(&vault, &limiter);
            let h = second.cards("https://github.com/").await["cards"][0]["h"].clone();
            assert_eq!(error(&second.reveal(&h, "https://github.com/").await), "RATE_LIMITED");
        });
    }

    #[test]
    fn a_locked_vault_answers_locked() {
        runtime().block_on(async {
            let vault = vault();
            let mut session = Session::new(&vault, &Arc::new(Limiter::default()));
            let h = session.cards("https://github.com/").await["cards"][0]["h"].clone();
            session.vault.locked.store(true, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(error(&session.reveal(&h, "https://github.com/").await), "LOCKED");
            assert_eq!(error(&session.call("match", serde_json::json!({ "tabUrl": "https://a.com/", "frameUrl": "https://a.com/" })).await), "LOCKED");
            assert_eq!(error(&session.call("search", serde_json::json!({ "q": "a", "tabUrl": "x", "limit": 1 })).await), "LOCKED");
        });
    }

    /// Same keys, same JSON types, all the way down (arrays: their first item).
    fn same_shape(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Object(a), Value::Object(b)) => {
                a.len() == b.len() && a.iter().all(|(key, value)| b.get(key).is_some_and(|other| same_shape(value, other)))
            }
            (Value::Array(a), Value::Array(b)) => match (a.first(), b.first()) {
                (Some(a), Some(b)) => same_shape(a, b),
                _ => true,
            },
            (Value::Number(_), Value::Number(_)) | (Value::String(_), Value::String(_)) | (Value::Bool(_), Value::Bool(_)) => true,
            (Value::Null, Value::Null) => true,
            _ => false,
        }
    }

    /// What the app really answers has the shape the extension's guards are tested on.
    #[test]
    fn results_have_the_fixture_shapes() {
        const FIXTURE: &str = include_str!("../../../extension/tests/fixtures/protocol/inner.json");
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        let samples = &fixture["samples"];
        runtime().block_on(async {
            let vault = vault();
            let mut session = Session::new(&vault, &Arc::new(Limiter::default()));
            let found = session.cards("https://github.com/login").await;
            assert!(!found["ssoHints"].as_array().unwrap().is_empty(), "the sample's lists are compared item by item");
            assert!(same_shape(&found, &samples["match"]), "{found}");
            // On a provider's page, `forSite` is a string.
            let tab = "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fvercel.com%2Fcb";
            let provider = session.cards(tab).await;
            assert!(provider["cards"][0]["forSite"].is_string());
            let mut sample = samples["match"]["cards"][0].clone();
            sample["forSite"] = "vercel.com".into();
            assert!(same_shape(&provider["cards"][0], &sample), "{provider}");

            let searched = session.search("github", "https://github.com/", 20).await;
            assert!(same_shape(&serde_json::json!({ "cards": searched }), &samples["search"]), "{searched}");
            assert_eq!(samples["search"]["cards"][0]["tier"], "search");

            let page = serde_json::json!({ "h": found["cards"][0]["h"], "tabUrl": "https://github.com/", "frameUrl": "https://github.com/" });
            let revealed = session.reveal(&found["cards"][0]["h"], "https://github.com/").await;
            assert!(same_shape(&revealed["r"], &samples["reveal"]), "{revealed}");
            let code = session.call("totp", page).await;
            assert!(same_shape(&code["r"], &samples["totp"]), "{code}");
        });
        // The error codes, both ways.
        let codes: Vec<String> = serde_json::from_value(fixture["errorCodes"].clone()).unwrap();
        let ours = [
            Code::BadRequest,
            Code::UnknownHandle,
            Code::OriginMismatch,
            Code::ConfirmRequired,
            Code::NoSecret,
            Code::RateLimited,
            Code::Locked,
            Code::Internal,
        ]
        .map(|code| serde_json::to_value(code).unwrap().as_str().unwrap().to_owned());
        assert_eq!(codes, ours);
    }

    /// The shared fixture's exchanges: requests, and byte for byte what the app answers.
    #[test]
    fn answers_match_the_fixture() {
        const FIXTURE: &str = include_str!("../../../extension/tests/fixtures/protocol/inner.json");
        runtime().block_on(async {
            let all: Value = serde_json::from_str(FIXTURE).unwrap();
            let exchanges = all["exchanges"].as_array().unwrap();
            assert!(!exchanges.is_empty());
            let vault = vault();
            let app = Arc::clone(&vault) as Arc<dyn App>;
            for exchange in exchanges {
                let request = exchange["request"].as_str().unwrap();
                let expected = exchange["reply"].as_str().unwrap();
                let parsed = Request::from_bytes(request.as_bytes()).unwrap_or_else(|e| panic!("{request}: {e}"));
                let got = answer(&app, [9; 16], &mut Grants::default(), &Limiter::default(), &parsed).await;
                assert_eq!(std::str::from_utf8(&got).unwrap(), expected, "{request}");
            }
        });
    }

    #[test]
    fn replies_carry_the_result_unchanged() {
        let bytes = reply(3, &Revealed { email: "me@x.com", username: None, password: "p\"w" });
        assert_eq!(
            std::str::from_utf8(&bytes).unwrap(),
            r#"{"id":3,"ok":true,"r":{"email":"me@x.com","username":null,"password":"p\"w"}}"#
        );
    }
}
