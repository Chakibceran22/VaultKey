//! The plaintext messages (`extension/plans/03-protocol.md`, outer layer). None of them
//! carry vault data: what the extension asks for travels inside `x`, encrypted end to end
//! (`noise`, `inner`).

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};

use crate::noise::{CLIENT_ID_LEN, ClientId, KEY_LEN, PublicKey};

/// The protocol version both ends speak.
pub const PROTOCOL: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", deny_unknown_fields)]
pub enum Message {
    /// Extension → bridge: is VaultKey running? The bridge answers itself.
    // `{}` rather than a unit variant: serde ignores unknown fields on unit variants
    // even with `deny_unknown_fields`, and `{"t":"bridge.status","x":1}` must be refused.
    #[serde(rename = "bridge.status")]
    BridgeStatus {},
    /// Bridge → extension: the answer, and again whenever the app goes away.
    #[serde(rename = "bridge.state")]
    BridgeState { app: AppPresence },
    /// App → extension: on connect, and at once whenever it changes.
    #[serde(rename = "state")]
    State { state: VaultState, protocol: u32 },
    /// Extension → app: bring VaultKey's window forward, to unlock it there. No session
    /// needed (a locked vault has none) and no data; the app limits how often it obeys.
    #[serde(rename = "app.show")]
    AppShow {},
    /// Extension → app: proves the whole path works and times it.
    #[serde(rename = "ping")]
    Ping { n: u32 },
    /// App → extension: the answer to `ping`, same `n`.
    #[serde(rename = "pong")]
    Pong { n: u32 },
    /// Extension → app: asks to pair, with its X25519 public key (base64).
    #[serde(rename = "pair.request")]
    PairRequest {
        #[serde(rename = "pub")]
        public: String,
        name: String,
        browser: Browser,
        protocol: u32,
    },
    /// App → extension: the app's public key. Both sides now show the 6-digit code.
    #[serde(rename = "pair.pending")]
    PairPending {
        #[serde(rename = "pub")]
        public: String,
    },
    /// App → extension: the user's answer in VaultKey (false too after 2 minutes, or
    /// when the vault locked meanwhile).
    #[serde(rename = "pair.result")]
    PairResult { approved: bool },
    /// Extension → app: starts a session. `client` is the browser's client id, `msg`
    /// the Noise KK first message (both base64), `protocol` the version it speaks.
    #[serde(rename = "hs1")]
    Hs1 { client: String, msg: String, protocol: u32 },
    /// App → extension: the Noise KK answer. The session is ready.
    #[serde(rename = "hs2")]
    Hs2 { msg: String },
    /// Either way, inside a session: one encrypted inner message (base64).
    #[serde(rename = "x")]
    X { c: String },
    /// Something was refused. The app closes its connection after sending it; the bridge,
    /// answering for itself, stays up. `need` comes with `PROTOCOL_VERSION` only.
    #[serde(rename = "err")]
    Err {
        code: ErrorCode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        need: Option<Need>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppPresence {
    Running,
    NotRunning,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VaultState {
    Locked,
    Unlocked,
    /// "Browser extension" is off in VaultKey's settings.
    Disabled,
}

/// Which browser asks to pair (for the dialog; the name says it too).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Browser {
    Chrome,
    Brave,
    Edge,
    Chromium,
    Vivaldi,
    Arc,
    Firefox,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    /// Not JSON, not a known message, or not one this side accepts now.
    BadFrame,
    /// This browser isn't paired (any more), or holds another VaultKey's key.
    NotPaired,
    /// The vault is locked: no pairing, no session.
    Locked,
    /// "Browser extension" is off in VaultKey.
    Disabled,
    /// The other side speaks another protocol version; `need` says which to update.
    ProtocolVersion,
    /// VaultKey is already showing a pairing dialog.
    Busy,
    /// Anything else; the details stay in VaultKey's log.
    Internal,
}

/// With `PROTOCOL_VERSION`: which side is too old.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Need {
    UpdateApp,
    UpdateExtension,
}

/// Is `version` one this app speaks? Its own and the previous one are accepted;
/// otherwise, which side needs updating.
pub fn check_version(version: u32) -> Result<(), Need> {
    if version == PROTOCOL || (PROTOCOL > 1 && version == PROTOCOL - 1) {
        Ok(())
    } else if version > PROTOCOL {
        Err(Need::UpdateApp)
    } else {
        Err(Need::UpdateExtension)
    }
}

/// Bytes as the messages carry them: standard base64, padded.
pub fn encode(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// Base64 of at most `max` bytes (canonical only), or `None`.
pub fn decode(text: &str, max: usize) -> Option<Vec<u8>> {
    // Four characters per three bytes: refuse before decoding anything too long.
    if text.len() > max.div_ceil(3) * 4 {
        return None;
    }
    STANDARD.decode(text).ok().filter(|bytes| bytes.len() <= max)
}

pub fn decode_key(text: &str) -> Option<PublicKey> {
    decode(text, KEY_LEN)?.try_into().ok()
}

pub fn decode_client(text: &str) -> Option<ClientId> {
    decode(text, CLIENT_ID_LEN)?.try_into().ok()
}

/// A browser's name as the pairing dialog shows it: 1 to 64 characters, no surrounding
/// spaces, nothing that hides itself or changes how the text around it reads.
pub fn valid_name(name: &str) -> bool {
    (1..=64).contains(&name.chars().count())
        && name.trim() == name
        && !name.chars().any(|c| c.is_control() || is_invisible(c))
}

/// Bidi marks, overrides and isolates, zero-width spaces and joiners, the BOM and the soft
/// hyphen: characters a name could use to look like something else.
fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}'
    )
}

impl Message {
    pub fn to_bytes(&self) -> Vec<u8> {
        // Plain enums and integers: serialising cannot fail.
        serde_json::to_vec(self).expect("a message always serialises")
    }

    /// A JSON object of exactly one message's shape, or an error. Objects only: serde's
    /// tagged enums would also read the array form, `["ping",7]`, which nothing sends.
    /// Parsed straight from the bytes (not through a `Value`, which would quietly keep
    /// the last of two `"n"` keys), so a duplicated field is refused too.
    pub fn from_bytes(bytes: &[u8]) -> serde_json::Result<Self> {
        if bytes.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{') {
            return Err(serde::de::Error::custom("a message is a JSON object"));
        }
        serde_json::from_slice(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact JSON the extension expects (`extension/lib/messages.ts`).
    #[test]
    fn messages_have_the_documented_shape() {
        let cases = [
            (Message::BridgeStatus {}, r#"{"t":"bridge.status"}"#),
            (
                Message::BridgeState { app: AppPresence::NotRunning },
                r#"{"t":"bridge.state","app":"not_running"}"#,
            ),
            (
                Message::State { state: VaultState::Unlocked, protocol: PROTOCOL },
                r#"{"t":"state","state":"unlocked","protocol":1}"#,
            ),
            (Message::Ping { n: 7 }, r#"{"t":"ping","n":7}"#),
            (Message::AppShow {}, r#"{"t":"app.show"}"#),
            (Message::Pong { n: 7 }, r#"{"t":"pong","n":7}"#),
            (Message::Err { code: ErrorCode::BadFrame, need: None }, r#"{"t":"err","code":"BAD_FRAME"}"#),
            (
                Message::Err { code: ErrorCode::ProtocolVersion, need: Some(Need::UpdateApp) },
                r#"{"t":"err","code":"PROTOCOL_VERSION","need":"update_app"}"#,
            ),
            (
                Message::PairRequest {
                    public: "AAAA".into(),
                    name: "Brave on macOS".into(),
                    browser: Browser::Brave,
                    protocol: PROTOCOL,
                },
                r#"{"t":"pair.request","pub":"AAAA","name":"Brave on macOS","browser":"brave","protocol":1}"#,
            ),
            (Message::PairPending { public: "AAAA".into() }, r#"{"t":"pair.pending","pub":"AAAA"}"#),
            (Message::PairResult { approved: true }, r#"{"t":"pair.result","approved":true}"#),
            (
                Message::Hs1 { client: "AA==".into(), msg: "AA==".into(), protocol: PROTOCOL },
                r#"{"t":"hs1","client":"AA==","msg":"AA==","protocol":1}"#,
            ),
            (Message::Hs2 { msg: "AA==".into() }, r#"{"t":"hs2","msg":"AA=="}"#),
            (Message::X { c: "AA==".into() }, r#"{"t":"x","c":"AA=="}"#),
        ];
        for (message, json) in cases {
            assert_eq!(String::from_utf8(message.to_bytes()).unwrap(), json);
            assert_eq!(Message::from_bytes(json.as_bytes()).unwrap(), message);
        }
    }

    /// The fixture the extension's tests read too (`extension/tests/messages.test.ts`).
    const FIXTURE: &str = include_str!("../../../extension/tests/fixtures/protocol/outer.json");

    fn fixture(list: &str) -> Vec<String> {
        let all: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        all[list]
            .as_array()
            .unwrap_or_else(|| panic!("fixture list {list}"))
            .iter()
            .map(|json| json.as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn every_fixture_message_round_trips_exactly() {
        let lists = [fixture("fromExtension"), fixture("toExtension")];
        assert!(lists.iter().all(|list| !list.is_empty()));
        for json in lists.iter().flatten() {
            let message = Message::from_bytes(json.as_bytes()).unwrap_or_else(|e| panic!("{json}: {e}"));
            assert_eq!(&String::from_utf8(message.to_bytes()).unwrap(), json);
        }
    }

    #[test]
    fn anything_else_is_refused() {
        let refused = fixture("refused");
        assert!(!refused.is_empty());
        for json in refused.iter().map(String::as_str).chain(["not json"]) {
            assert!(Message::from_bytes(json.as_bytes()).is_err(), "accepted {json}");
        }
    }

    /// Rust only: `JSON.parse` keeps the last of two keys, so the shared fixture can't
    /// hold these.
    #[test]
    fn duplicated_fields_are_refused() {
        for json in [
            r#"{"t":"ping","n":1,"n":2}"#,
            r#"{"t":"state","state":"locked","state":"unlocked","protocol":1}"#,
            r#"{"t":"ping","t":"pong","n":1}"#,
        ] {
            assert!(Message::from_bytes(json.as_bytes()).is_err(), "accepted {json}");
        }
        assert!(Message::from_bytes(b"  \n{\"t\":\"ping\",\"n\":1}").is_ok());
    }

    #[test]
    fn versions_keys_and_names() {
        assert_eq!(check_version(PROTOCOL), Ok(()));
        assert_eq!(check_version(PROTOCOL + 1), Err(Need::UpdateApp));
        assert_eq!(check_version(0), Err(Need::UpdateExtension));

        let key = [7u8; KEY_LEN];
        assert_eq!(decode_key(&encode(&key)), Some(key));
        assert_eq!(decode_key(&encode(&key[..31])), None);
        assert_eq!(decode_key(&encode(&[0; 33])), None);
        assert_eq!(decode_key("not base64!"), None);
        // Canonical only: the last character's spare bits must be zero.
        assert_eq!(decode("AB==", 1), None);
        assert_eq!(decode_client(&encode(&[1; CLIENT_ID_LEN])), Some([1; CLIENT_ID_LEN]));
        assert_eq!(decode(&"A".repeat(1 << 20), 32), None);

        assert!(valid_name("Brave on macOS"));
        assert!(valid_name(&"é".repeat(64)));
        for bad in ["", " Brave", "Brave ", "Bra\nve", &"x".repeat(65), "Brave\u{202E}soMcam", "Bra\u{200B}ve", "\u{FEFF}Brave"] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }
}
