//! What a paired browser can ask for, inside its encrypted session (`plans/03-protocol.md`,
//! "Methods"; `plans/02-security.md`, "Handles, not IDs").
//!
//! - `match`: the cards for a page (no secrets), each with an opaque handle.
//! - `reveal`: one card's username, email and password, after a click.
//! - `totp`: one card's current authenticator code.
//!
//! A handle is random, issued to this session only, and lives 10 minutes. `reveal` and
//! `totp` take only a handle, and match its account against the page **again**: a handle
//! from github.com is worthless on evil.com, and a browser can't walk through the vault by
//! guessing IDs. Each paired browser is rate limited, across its sessions.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroizing;

use crate::{
    inner::{self, Code, Request},
    matcher::{self, Page, Saved, Tier, Verdict},
    noise::ClientId,
    server::{App, Refusal},
};

/// One account, as the app lists it for matching: no secrets.
#[derive(Clone, Debug)]
pub struct Account {
    pub id: i64,
    /// The saved website, as typed ("github.com", "GitHub").
    pub website: String,
    pub email: String,
    pub username: Option<String>,
    pub has_password: bool,
    pub has_totp: bool,
}

/// An account with its website normalised once (the app caches these).
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
}

/// One account's login, decrypted for one fill.
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
    pub account: i64,
    /// The page it was filled on: "github.com".
    pub site: String,
    pub what: FillKind,
    pub via: Via,
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
/// Longest URL accepted in a request.
const MAX_URL: usize = 2048;

/// A handle's account.
struct Grant {
    account: i64,
    issued: Instant,
}

/// One session's handles.
#[derive(Default)]
pub struct Grants {
    handles: HashMap<String, Grant>,
    order: VecDeque<String>,
}

impl Grants {
    fn issue(&mut self, account: i64, now: Instant) -> String {
        while self.order.len() >= MAX_HANDLES {
            if let Some(oldest) = self.order.pop_front() {
                self.handles.remove(&oldest);
            }
        }
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).expect("the system's random generator works");
        let handle = crate::message::encode(&bytes);
        self.handles.insert(handle.clone(), Grant { account, issued: now });
        self.order.push_back(handle.clone());
        handle
    }

    fn account(&self, handle: &str, now: Instant) -> Option<i64> {
        self.handles
            .get(handle)
            .filter(|grant| now.duration_since(grant.issued) < HANDLE_TTL)
            .map(|grant| grant.account)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Limited {
    Match,
    Reveal,
    Totp,
}

impl Limited {
    /// Requests per minute, per paired browser (plans/02, "Rate limits").
    fn per_minute(self) -> u32 {
        match self {
            Limited::Match => 600,
            Limited::Reveal | Limited::Totp => 20,
        }
    }
}

/// Rate limits per paired browser, shared by all its sessions.
#[derive(Default)]
pub struct Limiter {
    windows: Mutex<HashMap<(ClientId, Limited), (Instant, u32)>>,
}

impl Limiter {
    fn allow(&self, client: ClientId, what: Limited, now: Instant) -> bool {
        let mut windows = self.windows.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // A few browsers at most; drop stale windows now and then.
        if windows.len() > 256 {
            windows.retain(|_, (start, _)| now.duration_since(*start) < Duration::from_secs(60));
        }
        let (start, count) = windows.entry((client, what)).or_insert((now, 0));
        if now.duration_since(*start) >= Duration::from_secs(60) {
            *start = now;
            *count = 0;
        }
        if *count >= what.per_minute() {
            return false;
        }
        *count += 1;
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
struct RevealParams {
    h: String,
    tab_url: String,
    frame_url: String,
    via: Via,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TotpParams {
    h: String,
    tab_url: String,
    frame_url: String,
}

/// A request this app understands.
enum Call {
    Ping,
    Match(MatchParams),
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
        "reveal" => Call::Reveal(params(&request.p)?),
        "totp" => Call::Totp(params(&request.p)?),
        _ => return None,
    };
    let urls_ok = |tab: &str, frame: &str| tab.len() <= MAX_URL && frame.len() <= MAX_URL;
    let fine = match &call {
        Call::Ping => true,
        Call::Match(p) => urls_ok(&p.tab_url, &p.frame_url),
        Call::Reveal(p) => urls_ok(&p.tab_url, &p.frame_url) && p.h.len() <= 64,
        Call::Totp(p) => urls_ok(&p.tab_url, &p.frame_url) && p.h.len() <= 64,
    };
    fine.then_some(call)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Card<'a> {
    h: String,
    kind: &'static str,
    title: &'a str,
    host: String,
    email: &'a str,
    username: Option<&'a str>,
    method: &'static str,
    tier: Tier,
    has_totp: bool,
    signs_in_with: [(); 0],
    last_used: Option<()>,
}

#[derive(Serialize)]
struct Site {
    host: String,
    registrable: Option<String>,
}

#[derive(Serialize)]
struct Matches<'a> {
    site: Option<Site>,
    cards: Vec<Card<'a>>,
    /// Logins saved for https that aren't offered because this page is http.
    insecure: usize,
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

/// The account a handle stands for, if this page still matches it.
fn granted<'a>(entries: &'a [Entry], account: i64, page: &Page) -> Result<&'a Entry, Code> {
    let entry = entries.iter().find(|entry| entry.account.id == account).ok_or(Code::UnknownHandle)?;
    match matcher::compare(&entry.saved, page) {
        Verdict::Fill(_) => Ok(entry),
        Verdict::Insecure | Verdict::None => Err(Code::OriginMismatch),
    }
}

/// The cards for `page`, best first: tier, then the most labels in common with the page
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

/// Same length as a real handle (16 bytes, base64): for measuring a reply before any
/// handle is issued.
const PLACEHOLDER_HANDLE: &str = "AAAAAAAAAAAAAAAAAAAAAA==";

fn card(entry: &Entry, tier: Tier, h: String) -> Card<'_> {
    let account = &entry.account;
    Card {
        h,
        kind: "account",
        title: account.website.trim(),
        host: entry.saved.label().unwrap_or_default(),
        email: &account.email,
        username: account.username.as_deref(),
        method: if account.has_password { "password" } else { "none" },
        tier,
        has_totp: account.has_totp,
        signs_in_with: [],
        last_used: None,
    }
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
            let Some(page) = Page::parse(&p.frame_url) else {
                return reply(id, &Matches { site: None, cards: Vec::new(), insecure: 0 });
            };
            let insecure = entries.iter().filter(|entry| matcher::compare(&entry.saved, &page) == Verdict::Insecure).count();
            // The reply must fit one encrypted message: with very long titles and emails, the
            // least likely cards go. Measured with placeholder handles; real ones are issued
            // only for the cards sent.
            let ranked = ranked(&entries, &page);
            let site = || Some(Site { host: page.label(), registrable: page.registrable.clone() });
            let mut limit = ranked.len().min(MAX_CARDS);
            loop {
                let cards = ranked[..limit].iter().map(|&(tier, entry)| card(entry, tier, PLACEHOLDER_HANDLE.to_owned())).collect();
                if reply(id, &Matches { site: site(), cards, insecure }).len() <= crate::noise::MAX_PLAINTEXT {
                    break;
                }
                if limit == 0 {
                    return failure(id, Code::Internal, "Too much to send for this page.");
                }
                limit /= 2;
            }
            let cards = ranked[..limit].iter().map(|&(tier, entry)| card(entry, tier, grants.issue(entry.account.id, now))).collect();
            reply(id, &Matches { site: site(), cards, insecure })
        }
        Call::Reveal(p) => {
            let Some(account) = grants.account(&p.h, now) else {
                return failure(id, Code::UnknownHandle, "That card has expired. Look it up again.");
            };
            let Some(page) = Page::parse(&p.frame_url) else {
                return failure(id, Code::OriginMismatch, "That login isn't for this page.");
            };
            let entry = match granted(&entries, account, &page) {
                Ok(entry) => entry,
                Err(code) => return failure(id, code, "That login isn't for this page."),
            };
            let account = entry.account.id;
            let login = match crate::server::blocking(app, move |app| app.login(account)).await {
                Ok(Some(login)) if !login.password.is_empty() => login,
                Ok(_) => return failure(id, Code::NoSecret, "This account has no saved password."),
                Err(refusal) => return refused(id, refusal),
            };
            app.filled(Fill { client, account, site: page.label(), what: FillKind::Login, via: p.via });
            let room = room_for(&[&login.email, login.username.as_deref().unwrap_or_default(), &login.password]);
            reply_into(id, &Revealed { email: &login.email, username: login.username.as_deref(), password: &login.password }, room)
        }
        Call::Totp(p) => {
            let Some(account) = grants.account(&p.h, now) else {
                return failure(id, Code::UnknownHandle, "That card has expired. Look it up again.");
            };
            let Some(page) = Page::parse(&p.frame_url) else {
                return failure(id, Code::OriginMismatch, "That login isn't for this page.");
            };
            let entry = match granted(&entries, account, &page) {
                Ok(entry) => entry,
                Err(code) => return failure(id, code, "That login isn't for this page."),
            };
            let account = entry.account.id;
            let code = match crate::server::blocking(app, move |app| app.code(account)).await {
                Ok(Some(code)) => code,
                Ok(None) => return failure(id, Code::NoSecret, "This account has no authenticator setup key."),
                Err(refusal) => return refused(id, refusal),
            };
            app.filled(Fill { client, account, site: page.label(), what: FillKind::Code, via: Via::Popup });
            reply(id, &CodeReply { code: &code.code, expires_at: code.expires_at })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_expire_and_are_unguessable() {
        let mut grants = Grants::default();
        let now = Instant::now();
        let first = grants.issue(7, now);
        let second = grants.issue(7, now);
        assert_ne!(first, second);
        assert_eq!(first.len(), 24);
        assert_eq!(grants.account(&first, now + Duration::from_secs(60)), Some(7));
        assert_eq!(grants.account(&first, now + HANDLE_TTL), None);
        assert_eq!(grants.account("7", now), None);
    }

    #[test]
    fn a_session_keeps_a_bounded_number_of_handles() {
        let mut grants = Grants::default();
        let now = Instant::now();
        let first = grants.issue(1, now);
        for _ in 0..MAX_HANDLES {
            grants.issue(2, now);
        }
        assert_eq!(grants.handles.len(), MAX_HANDLES);
        assert_eq!(grants.account(&first, now), None, "the oldest went first");
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
    }

    #[test]
    fn requests_are_checked_before_anything_runs() {
        let request = |json: &str| Request::from_bytes(json.as_bytes()).unwrap();
        assert!(parse(&request(r#"{"id":1,"m":"ping"}"#)).is_some());
        assert!(parse(&request(r#"{"id":1,"m":"match","p":{"tabUrl":"https://a.com/","frameUrl":"https://a.com/"}}"#)).is_some());
        for bad in [
            r#"{"id":1,"m":"ping","p":{}}"#,
            r#"{"id":1,"m":"match","p":{"tabUrl":"https://a.com/"}}"#,
            r#"{"id":1,"m":"match","p":{"tabUrl":"x","frameUrl":"x","extra":1}}"#,
            r#"{"id":1,"m":"match","p":[1]}"#,
            r#"{"id":1,"m":"reveal","p":{"h":"x","tabUrl":"x","frameUrl":"x"}}"#,
            r#"{"id":1,"m":"reveal","p":{"h":"x","tabUrl":"x","frameUrl":"x","via":"telepathy"}}"#,
            r#"{"id":1,"m":"reveal","p":{"h":"x","tabUrl":"x","frameUrl":"x","via":"popup","confirmedCrossSite":true}}"#,
            r#"{"id":1,"m":"list","p":{}}"#,
            r#"{"id":1,"m":"totp","p":{"h":7,"tabUrl":"x","frameUrl":"x"}}"#,
        ] {
            assert!(parse(&request(bad)).is_none(), "accepted {bad}");
        }
        let long = format!(r#"{{"id":1,"m":"match","p":{{"tabUrl":"x","frameUrl":"https://a.com/{}"}}}}"#, "a".repeat(MAX_URL));
        assert!(parse(&request(&long)).is_none());
    }

    /// A vault in memory: a few accounts, their logins, one authenticator.
    struct Vault {
        entries: Arc<[Entry]>,
        locked: std::sync::atomic::AtomicBool,
        fills: Mutex<Vec<Fill>>,
        opened: std::sync::atomic::AtomicUsize,
    }

    fn account(id: i64, website: &str, email: &str, has_password: bool, has_totp: bool) -> Entry {
        Entry::new(Account { id, website: website.into(), email: email.into(), username: None, has_password, has_totp })
    }

    fn vault() -> Arc<Vault> {
        Arc::new(Vault {
            entries: Arc::from(vec![
                account(1, "github.com", "me@x.com", true, true),
                account(2, "https://gist.github.com/login", "other@x.com", true, false),
                account(3, "g1thub.com", "phish@x.com", true, false),
                account(4, "https://bank.com", "me@bank.com", true, false),
                account(5, "vercel.com", "me@gmail.com", false, false),
                account(6, "GitHub", "named@x.com", true, false),
            ]),
            locked: Default::default(),
            fills: Mutex::default(),
            opened: Default::default(),
        })
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
        fn login(&self, account: i64) -> Result<Option<Login>, Refusal> {
            let entry = self.entries.iter().find(|entry| entry.account.id == account);
            Ok(entry.filter(|entry| entry.account.has_password).map(|entry| Login {
                email: entry.account.email.clone(),
                username: Some("me".into()),
                password: Zeroizing::new(format!("password-{account}")),
            }))
        }
        fn code(&self, account: i64) -> Result<Option<AuthCode>, Refusal> {
            Ok((account == 1).then(|| AuthCode { code: "123456".into(), expires_at: 1_700_000_030_000 }))
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

        async fn call(&mut self, m: &str, p: Value) -> Value {
            self.next += 1;
            let request = Request::from_bytes(serde_json::json!({ "id": self.next, "m": m, "p": p }).to_string().as_bytes()).unwrap();
            let bytes = answer(&self.app, [9; 16], &mut self.grants, &self.limiter, &request).await;
            let reply: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(reply["id"], self.next);
            reply
        }

        async fn cards(&mut self, page: &str) -> Value {
            let reply = self.call("match", serde_json::json!({ "tabUrl": page, "frameUrl": page })).await;
            assert_eq!(reply["ok"], true, "{reply}");
            reply["r"].clone()
        }

        async fn reveal(&mut self, h: &Value, page: &str) -> Value {
            self.call("reveal", serde_json::json!({ "h": h, "tabUrl": page, "frameUrl": page, "via": "popup" })).await
        }
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    fn error(reply: &Value) -> &str {
        reply["e"]["code"].as_str().unwrap_or("none")
    }

    #[test]
    fn match_gives_this_pages_cards_and_nothing_else() {
        runtime().block_on(async {
            let vault = vault();
            let mut session = Session::new(&vault, &Arc::new(Limiter::default()));
            let found = session.cards("https://github.com/login").await;
            let emails: Vec<_> = found["cards"].as_array().unwrap().iter().map(|card| card["email"].as_str().unwrap()).collect();
            assert_eq!(emails, ["me@x.com", "other@x.com"], "exact first; never g1thub.com or the name-only GitHub");
            assert_eq!(found["site"], serde_json::json!({ "host": "github.com", "registrable": "github.com" }));
            let card = &found["cards"][0];
            assert_eq!(card["tier"], "exact");
            assert_eq!(card["hasTotp"], true);
            assert_eq!(card["method"], "password");
            assert_eq!(card["kind"], "account");
            assert_eq!(card["signsInWith"], serde_json::json!([]));
            assert_eq!(found["cards"][1]["tier"], "subdomain");
            assert_eq!(found["cards"][1]["host"], "gist.github.com");
            // Every key the extension's guard expects, and no other.
            let mut keys: Vec<_> = card.as_object().unwrap().keys().cloned().collect();
            keys.sort();
            let mut expected = ["h", "kind", "title", "host", "email", "username", "method", "tier", "hasTotp", "signsInWith", "lastUsed"];
            expected.sort();
            assert_eq!(keys, expected);

            assert_eq!(session.cards("https://bank.com/").await["insecure"], 0);
            let http = session.cards("http://bank.com/").await;
            assert_eq!((http["cards"].as_array().unwrap().len(), http["insecure"].as_u64()), (0, Some(1)));
            assert_eq!(session.cards("chrome://settings").await, serde_json::json!({ "site": null, "cards": [], "insecure": 0 }));
            assert_eq!(session.cards("https://vercel.com/").await["cards"][0]["method"], "none");
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
            let vault = Arc::new(Vault { entries: Arc::from(entries), locked: Default::default(), fills: Mutex::default(), opened: Default::default() });
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

            // An account without a password.
            let vercel = session.cards("https://vercel.com/").await["cards"][0]["h"].clone();
            assert_eq!(error(&session.reveal(&vercel, "https://vercel.com/").await), "NO_SECRET");

            let fills = vault.fills.lock().unwrap();
            assert_eq!(fills.len(), 2, "each reveal is recorded; refusals aren't");
            assert_eq!((fills[0].account, fills[0].site.as_str(), fills[0].via), (1, "github.com", Via::Popup));
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
        let samples: Value = serde_json::from_str::<Value>(FIXTURE).unwrap()["samples"].clone();
        runtime().block_on(async {
            let vault = vault();
            let mut session = Session::new(&vault, &Arc::new(Limiter::default()));
            let found = session.cards("https://github.com/login").await;
            assert!(same_shape(&found, &samples["match"]), "{found}");
            let page = serde_json::json!({ "h": found["cards"][0]["h"], "tabUrl": "https://github.com/", "frameUrl": "https://github.com/" });
            let revealed = session.reveal(&found["cards"][0]["h"], "https://github.com/").await;
            assert!(same_shape(&revealed["r"], &samples["reveal"]), "{revealed}");
            let code = session.call("totp", page).await;
            assert!(same_shape(&code["r"], &samples["totp"]), "{code}");
        });
        let codes: Vec<String> = serde_json::from_value(serde_json::from_str::<Value>(FIXTURE).unwrap()["errorCodes"].clone()).unwrap();
        for code in [Code::BadRequest, Code::UnknownHandle, Code::OriginMismatch, Code::NoSecret, Code::RateLimited, Code::Locked, Code::Internal] {
            let name = serde_json::to_value(code).unwrap();
            assert!(codes.iter().any(|known| name == *known), "{name} isn't in the fixture");
        }
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
