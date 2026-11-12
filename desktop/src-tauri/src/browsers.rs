//! The browser extension's rows (schema v8, `migrations/0008_browser_extension.sql`):
//! VaultKey's own key for the channel, and the browsers paired with it. Values arrive
//! sealed and leave sealed; `vault.rs` holds the key.
//!
//! Also what the extension reads from the rest of the vault (accounts, sign-in links,
//! service logins), and the websites it can't match.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};
use vaultkey_bridge::matcher::Saved;

use crate::db::now_iso;
use crate::error::VaultResult;
use crate::workspace::SIGN_IN;

/// The `bridge_settings` row, if "Browser extension" was ever turned on.
pub struct Settings {
    pub enabled: bool,
    /// The X25519 private key, sealed.
    pub private_key: Vec<u8>,
}

pub fn read_settings(conn: &Connection) -> VaultResult<Option<Settings>> {
    Ok(conn
        .query_row("SELECT enabled, private_key FROM bridge_settings WHERE id = 1", [], |row| {
            Ok(Settings { enabled: row.get::<_, i64>(0)? == 1, private_key: row.get(1)? })
        })
        .optional()?)
}

/// The first time it's turned on: the key pair is made, and the setting is on.
pub fn create_settings(conn: &Connection, sealed_private_key: &[u8]) -> VaultResult<()> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO bridge_settings (id, enabled, private_key, created_at, updated_at) VALUES (1, 1, ?1, ?2, ?2)",
        params![sealed_private_key, now],
    )?;
    Ok(())
}

pub fn set_enabled(conn: &Connection, enabled: bool) -> VaultResult<()> {
    conn.execute(
        "UPDATE bridge_settings SET enabled = ?1, updated_at = ?2 WHERE id = 1",
        params![i64::from(enabled), now_iso()],
    )?;
    Ok(())
}

/// A paired browser, sealed.
pub struct StoredClient {
    pub id: i64,
    pub client_id: Vec<u8>,
    pub name: Vec<u8>,
    pub created_at: String,
    pub last_seen_at: String,
}

/// A paired browser's sealed public key, by its client id.
pub fn client_key(conn: &Connection, client_id: &[u8]) -> VaultResult<Option<Vec<u8>>> {
    Ok(conn
        .query_row("SELECT public_key FROM browser_clients WHERE client_id = ?1", [client_id], |row| row.get(0))
        .optional()?)
}

/// Saves a newly paired browser. Pairing the same key again (the extension forgot it was
/// paired) keeps the row and takes the new name.
pub fn save_client(conn: &Connection, client_id: &[u8], sealed_public_key: &[u8], sealed_name: &[u8]) -> VaultResult<()> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO browser_clients (client_id, public_key, name, created_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT (client_id) DO UPDATE SET
           public_key = excluded.public_key, name = excluded.name, last_seen_at = excluded.last_seen_at",
        params![client_id, sealed_public_key, sealed_name, now],
    )?;
    Ok(())
}

pub fn list_clients(conn: &Connection) -> VaultResult<Vec<StoredClient>> {
    let mut statement =
        conn.prepare("SELECT id, client_id, name, created_at, last_seen_at FROM browser_clients ORDER BY created_at, id")?;
    let rows = statement.query_map([], |row| {
        Ok(StoredClient {
            id: row.get(0)?,
            client_id: row.get(1)?,
            name: row.get(2)?,
            created_at: row.get(3)?,
            last_seen_at: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Whether a row was removed.
pub fn delete_client(conn: &Connection, id: i64) -> VaultResult<bool> {
    Ok(conn.execute("DELETE FROM browser_clients WHERE id = ?1", [id])? == 1)
}

/// Removes a browser by its client id (a pairing the browser never heard was approved).
pub fn delete_client_by_client_id(conn: &Connection, client_id: &[u8]) -> VaultResult<()> {
    conn.execute("DELETE FROM browser_clients WHERE client_id = ?1", [client_id])?;
    Ok(())
}

// ── what the extension reads (M2) ──────────────────────────────────────────

/// Accounts with an authenticator whose setup key is saved (so a code can be made).
pub fn accounts_with_authenticator(conn: &Connection) -> VaultResult<HashSet<i64>> {
    let mut statement = conn
        .prepare("SELECT DISTINCT account_id FROM account_factors WHERE kind = 'authenticator' AND payload IS NOT NULL")?;
    let rows = statement.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The account's first authenticator with a setup key.
pub fn authenticator_of(conn: &Connection, account: i64) -> VaultResult<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT id FROM account_factors WHERE account_id = ?1 AND kind = 'authenticator' AND payload IS NOT NULL ORDER BY id LIMIT 1",
            [account],
            |row| row.get(0),
        )
        .optional()?)
}

/// One account's login, its password still sealed (base64, as the Electron app wrote it).
pub struct StoredLogin {
    pub email: String,
    pub username: Option<String>,
    pub password: String,
}

pub fn login(conn: &Connection, account: i64) -> VaultResult<Option<StoredLogin>> {
    Ok(conn
        .query_row("SELECT email, username, password FROM credentials WHERE id = ?1", [account], |row| {
            Ok(StoredLogin { email: row.get(0)?, username: row.get(1)?, password: row.get(2)? })
        })
        .optional()?)
}

pub fn touch_client(conn: &Connection, client_id: &[u8]) -> VaultResult<()> {
    conn.execute(
        "UPDATE browser_clients SET last_seen_at = ?1 WHERE client_id = ?2",
        params![now_iso(), client_id],
    )?;
    Ok(())
}

// ── what the extension reads (M4) ──────────────────────────────────────────

/// Each account's `sign_in` links: the accounts it signs in with ("Vercel signs in with
/// Google"), in id order.
pub fn sign_in_links(conn: &Connection) -> VaultResult<HashMap<i64, Vec<i64>>> {
    let mut statement = conn.prepare_cached(
        "SELECT account_id, linked_account_id FROM account_links WHERE kind = ?1 ORDER BY account_id, linked_account_id",
    )?;
    let rows = statement.query_map([SIGN_IN], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))?;
    let mut links: HashMap<i64, Vec<i64>> = HashMap::new();
    for row in rows {
        let (account, linked) = row?;
        links.entry(account).or_default().push(linked);
    }
    Ok(links)
}

/// A service's own login, as the extension lists it: its username still sealed, and
/// only whether it keeps a password.
pub struct ListedServiceLogin {
    pub id: i64,
    /// The service's name ("Prod server").
    pub service: String,
    /// The service's address, as typed (a URL, a hostname, an IP; maybe empty).
    pub url: String,
    pub username: Vec<u8>,
    pub has_password: bool,
}

pub fn service_logins(conn: &Connection) -> VaultResult<Vec<ListedServiceLogin>> {
    let mut statement = conn.prepare_cached(
        "SELECT l.id, s.name, s.url, l.username, l.password IS NOT NULL
         FROM service_logins l JOIN services s ON s.id = l.service_id
         ORDER BY s.name COLLATE NOCASE, s.id, l.position, l.id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(ListedServiceLogin {
            id: row.get(0)?,
            service: row.get(1)?,
            url: row.get(2)?,
            username: row.get(3)?,
            has_password: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// One service login for one fill: username and password sealed (no password: `None`).
pub struct SealedServiceLogin {
    pub username: Vec<u8>,
    pub password: Option<Vec<u8>>,
}

pub fn service_login(conn: &Connection, id: i64) -> VaultResult<Option<SealedServiceLogin>> {
    Ok(conn
        .query_row("SELECT username, password FROM service_logins WHERE id = ?1", [id], |row| {
            Ok(SealedServiceLogin { username: row.get(0)?, password: row.get(1)? })
        })
        .optional()?)
}

// ── websites the extension can't match (M4) ────────────────────────────────

/// What makes two saved websites the same one: the host and port as the matcher reads
/// them, so "GitHub.com", "https://www.github.com/login" and "github.com" are all
/// "github.com". `None` for a name only ("GitHub"). The app already treats website names
/// case-insensitively; this goes one step further, to what the extension sees.
pub fn site_key(name: &str) -> Option<String> {
    Saved::parse(name).label()
}

/// The name of a saved website other than `except` that is the same site as `key`
/// ([`site_key`]), if there is one.
pub fn same_site(conn: &Connection, key: &str, except: i64) -> VaultResult<Option<String>> {
    let mut statement = conn.prepare_cached("SELECT id, name FROM domains ORDER BY id")?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?;
    for row in rows {
        let (id, name) = row?;
        if id != except && site_key(&name).as_deref() == Some(key) {
            return Ok(Some(name));
        }
    }
    Ok(None)
}

/// Gives a saved website a new name (`vault.rs` checked it's an address no other website
/// has). Whether a row changed.
pub fn rename_domain(conn: &Connection, id: i64, name: &str) -> VaultResult<bool> {
    Ok(conn.execute("UPDATE domains SET name = ?1, updated_at = ?2 WHERE id = ?3", params![name, now_iso(), id])? == 1)
}

/// Where well-known services sign their users in, by name. Only services whose address
/// is certain and the same in every country: a wrong one would put these accounts on a
/// site the user never chose, in one click. Anything else gets no suggestion, and the
/// user types the address. Keyed by the name lowercased, without spaces, dashes, dots or
/// underscores.
pub(crate) const KNOWN_ADDRESSES: &[(&str, &str)] = &[
    // Google accounts sign in on accounts.google.com.
    ("gmail", "google.com"),
    ("google", "google.com"),
    ("googleaccount", "google.com"),
    ("googledrive", "google.com"),
    ("youtube", "google.com"),
    // Personal Microsoft accounts sign in on login.live.com. ("Microsoft", "Office 365",
    // "OneDrive" or "Azure" may be a work account, signed in elsewhere: no suggestion.)
    ("microsoftaccount", "live.com"),
    ("outlook", "live.com"),
    ("hotmail", "live.com"),
    ("live", "live.com"),
    ("xbox", "live.com"),
    // Apple accounts sign in on idmsa.apple.com.
    ("apple", "apple.com"),
    ("appleid", "apple.com"),
    ("icloud", "apple.com"),
    // signin.aws.amazon.com.
    ("aws", "aws.amazon.com"),
    ("amazonwebservices", "aws.amazon.com"),
    // id.atlassian.com.
    ("atlassian", "atlassian.com"),
    ("jira", "atlassian.com"),
    ("confluence", "atlassian.com"),
    ("twitter", "x.com"),
    ("x", "x.com"),
    ("chatgpt", "openai.com"),
    ("openai", "openai.com"),
    ("claude", "claude.ai"),
    ("github", "github.com"),
    ("gitlab", "gitlab.com"),
    ("npm", "npmjs.com"),
    ("docker", "docker.com"),
    ("dockerhub", "docker.com"),
    ("vercel", "vercel.com"),
    ("netlify", "netlify.com"),
    ("heroku", "heroku.com"),
    ("cloudflare", "cloudflare.com"),
    ("digitalocean", "digitalocean.com"),
    ("stripe", "stripe.com"),
    ("figma", "figma.com"),
    ("slack", "slack.com"),
    ("discord", "discord.com"),
    ("dropbox", "dropbox.com"),
    ("proton", "proton.me"),
    ("protonmail", "proton.me"),
    ("yahoo", "yahoo.com"),
    ("yahoomail", "yahoo.com"),
    ("facebook", "facebook.com"),
    ("instagram", "instagram.com"),
    ("linkedin", "linkedin.com"),
    ("reddit", "reddit.com"),
    ("netflix", "netflix.com"),
    ("spotify", "spotify.com"),
    ("paypal", "paypal.com"),
    ("twitch", "twitch.tv"),
    ("steam", "steampowered.com"),
];

/// The address of a well-known service saved under its name ("GitHub" → "github.com",
/// "Gmail" → "google.com"), or `None`. Never a guess like "<name>.com": "Ameli" is
/// ameli.fr. Only ever offered: the user picks it.
pub fn suggest_address(name: &str) -> Option<String> {
    let key: String = name
        .chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '-' | '.' | '_'))
        .flat_map(char::to_lowercase)
        .collect();
    KNOWN_ADDRESSES.iter().find(|(known, _)| *known == key).map(|(_, address)| (*address).to_owned())
}
