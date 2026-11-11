//! The inner layer (`plans/03-protocol.md`): what travels encrypted inside `x` once a
//! session is up. Requests carry an `id`; replies echo it; events have none.
//!
//! The methods themselves are in `api.rs`. `extension/tests/fixtures/protocol/inner.json`
//! holds the exact JSON both sides agree on.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Extension → app.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: u32,
    pub m: String,
    #[serde(default)]
    pub p: Option<Value>,
}

impl Request {
    /// Exactly one request object (objects only, no duplicated or unknown fields).
    pub fn from_bytes(bytes: &[u8]) -> serde_json::Result<Self> {
        if bytes.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{') {
            return Err(serde::de::Error::custom("a request is a JSON object"));
        }
        serde_json::from_slice(bytes)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Code {
    /// Unknown method, missing or extra parameters.
    BadRequest,
    /// Not issued to this session, or expired (10 minutes).
    UnknownHandle,
    /// The handle's account doesn't match this page.
    OriginMismatch,
    /// No password, or no authenticator setup key.
    NoSecret,
    RateLimited,
    /// The vault locked while the request was on its way.
    Locked,
    /// Anything else; details stay in the app's log.
    Internal,
}

#[derive(Serialize)]
struct Failure<'a> {
    code: Code,
    msg: &'a str,
}

#[derive(Serialize)]
struct Ok<'a> {
    id: u32,
    ok: bool,
    r: &'a Value,
}

#[derive(Serialize)]
struct Failed<'a> {
    id: u32,
    ok: bool,
    e: Failure<'a>,
}

/// `{"id":…,"ok":true,"r":…}`
pub fn reply(id: u32, result: &Value) -> Vec<u8> {
    serde_json::to_vec(&Ok { id, ok: true, r: result }).expect("a reply always serialises")
}

/// `{"id":…,"ok":false,"e":{"code":…,"msg":…}}`
pub fn failure(id: u32, code: Code, msg: &str) -> Vec<u8> {
    serde_json::to_vec(&Failed { id, ok: false, e: Failure { code, msg } }).expect("a reply always serialises")
}

/// App → extension, unprompted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Event {
    /// The vault is locking: this session ends now.
    Locked,
    /// This browser's pairing was removed in VaultKey: forget the keys.
    Revoked,
}

#[derive(Serialize)]
struct EventMessage {
    ev: Event,
}

pub fn event(event: Event) -> Vec<u8> {
    serde_json::to_vec(&EventMessage { ev: event }).expect("an event always serialises")
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../extension/tests/fixtures/protocol/inner.json");

    fn list(name: &str) -> Vec<String> {
        let all: Value = serde_json::from_str(FIXTURE).unwrap();
        all[name]
            .as_array()
            .unwrap_or_else(|| panic!("fixture list {name}"))
            .iter()
            .map(|json| json.as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn events_match_the_fixture() {
        let events = list("events");
        assert_eq!(events, [Event::Locked, Event::Revoked].map(|e| String::from_utf8(event(e)).unwrap()));
    }

    #[test]
    fn malformed_requests_are_refused() {
        let refused = list("refusedRequests");
        assert!(!refused.is_empty());
        for json in refused.iter().map(String::as_str).chain([r#"{"id":1,"id":2,"m":"ping"}"#, "nope"]) {
            assert!(Request::from_bytes(json.as_bytes()).is_err(), "accepted {json}");
        }
    }
}
