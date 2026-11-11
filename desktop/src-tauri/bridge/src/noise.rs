//! The encrypted channel between the extension and the app (`plans/02-security.md`, "The
//! channel").
//!
//! Noise `KK`, `25519 / AESGCM / SHA256`: each side knows the other's static key from
//! pairing, and every connection does a fresh handshake with new ephemeral keys, so each
//! session has forward secrecy. The extension starts (initiator); the app answers
//! (responder). The bridge in between only ever sees ciphertext.
//!
//! The extension's side is `extension/lib/noise.ts`, on WebCrypto. The test vectors below
//! (`extension/tests/fixtures/protocol/noise-kk.json`) pin both implementations to the
//! same bytes.

use std::fmt;

use sha2::{Digest, Sha256};
use snow::{Builder, HandshakeState, TransportState, params::NoiseParams};
use zeroize::Zeroizing;

pub const PATTERN: &str = "Noise_KK_25519_AESGCM_SHA256";
/// Mixed into the handshake: a session of another protocol (or another version of this
/// one) can't be completed with these messages.
pub const PROLOGUE: &[u8] = b"vaultkey-bridge/1";
pub const KEY_LEN: usize = 32;
pub const CLIENT_ID_LEN: usize = 16;
/// The largest inner message (before encryption). Its `x` frame, base64 with the tag,
/// stays under the 64 KiB frame limit.
pub const MAX_PLAINTEXT: usize = 48_000;
pub const TAG_LEN: usize = 16;
/// A KK handshake message with an empty payload is 48 bytes (ephemeral key + tag).
pub const MAX_HANDSHAKE: usize = 256;
/// Domain separation for the 6-digit code both sides show while pairing.
const PAIRING_LABEL: &[u8] = b"vaultkey-pair-v1";

pub type PublicKey = [u8; KEY_LEN];
pub type PrivateKey = Zeroizing<[u8; KEY_LEN]>;
pub type ClientId = [u8; CLIENT_ID_LEN];

/// Anything that went wrong with a handshake or a frame. Deliberately without detail:
/// the only answer is to end the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Error;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the encrypted channel failed")
    }
}

impl std::error::Error for Error {}

impl From<snow::Error> for Error {
    fn from(_: snow::Error) -> Self {
        Error
    }
}

fn params() -> NoiseParams {
    PATTERN.parse().expect("the pattern is valid")
}

/// A new static key pair (the app's own, made when "Browser extension" is first turned on).
pub fn generate_keypair() -> (PrivateKey, PublicKey) {
    let keypair = Builder::new(params())
        .generate_keypair()
        .expect("the system's random generator works");
    let mut private = Zeroizing::new([0; KEY_LEN]);
    private.copy_from_slice(&Zeroizing::new(keypair.private));
    let public = keypair.public.try_into().expect("an X25519 public key is 32 bytes");
    (private, public)
}

/// The public half of an X25519 private key.
pub fn public_key(private: &[u8; KEY_LEN]) -> PublicKey {
    use snow::{
        params::DHChoice,
        resolvers::{CryptoResolver, DefaultResolver},
    };
    let mut dh = DefaultResolver
        .resolve_dh(&DHChoice::Curve25519)
        .expect("curve25519 is built in");
    dh.set(private);
    dh.pubkey().try_into().expect("an X25519 public key is 32 bytes")
}

/// How a paired browser names itself in `hs1`: the first 16 bytes of SHA-256(its key).
pub fn client_id(public: &PublicKey) -> ClientId {
    let digest = Sha256::digest(public);
    digest[..CLIENT_ID_LEN].try_into().expect("16 of 32 bytes")
}

/// The 6-digit code VaultKey and the popup both show while pairing:
/// SHA-256("vaultkey-pair-v1" ‖ extension key ‖ app key), read as a big-endian integer,
/// mod 10⁶, zero-padded.
pub fn pairing_code(extension: &PublicKey, app: &PublicKey) -> String {
    let digest = Sha256::new()
        .chain_update(PAIRING_LABEL)
        .chain_update(extension)
        .chain_update(app)
        .finalize();
    let code = digest.iter().fold(0u32, |code, &byte| (code * 256 + u32::from(byte)) % 1_000_000);
    format!("{code:06}")
}

fn builder<'a>(local: &'a [u8; KEY_LEN], remote: &'a PublicKey, ephemeral: Option<&'a [u8; KEY_LEN]>) -> Result<Builder<'a>, Error> {
    let builder = Builder::new(params())
        .local_private_key(local)?
        .remote_public_key(remote)?
        .prologue(PROLOGUE)?;
    Ok(match ephemeral {
        Some(key) => builder.fixed_ephemeral_key_for_testing_only(key),
        None => builder,
    })
}

/// The app's side: reads the extension's first message and answers it. Both payloads
/// are empty; anything else is refused.
pub fn respond(local: &[u8; KEY_LEN], remote: &PublicKey, message: &[u8]) -> Result<(Vec<u8>, Transport), Error> {
    respond_with(local, remote, message, None)
}

fn respond_with(
    local: &[u8; KEY_LEN],
    remote: &PublicKey,
    message: &[u8],
    ephemeral: Option<&[u8; KEY_LEN]>,
) -> Result<(Vec<u8>, Transport), Error> {
    if message.len() > MAX_HANDSHAKE {
        return Err(Error);
    }
    let mut handshake = builder(local, remote, ephemeral)?.build_responder()?;
    let mut payload = [0; MAX_HANDSHAKE];
    if handshake.read_message(message, &mut payload)? != 0 {
        return Err(Error);
    }
    let mut answer = vec![0; MAX_HANDSHAKE];
    let length = handshake.write_message(&[], &mut answer)?;
    answer.truncate(length);
    Ok((answer, Transport(handshake.into_transport_mode()?)))
}

/// The extension's side, in Rust: for tests, and for the vectors the extension checks.
pub struct Initiator(HandshakeState);

impl Initiator {
    /// Starts a handshake; returns the first message (`hs1`).
    pub fn start(local: &[u8; KEY_LEN], remote: &PublicKey) -> Result<(Self, Vec<u8>), Error> {
        Self::start_with(local, remote, None)
    }

    fn start_with(
        local: &[u8; KEY_LEN],
        remote: &PublicKey,
        ephemeral: Option<&[u8; KEY_LEN]>,
    ) -> Result<(Self, Vec<u8>), Error> {
        let mut handshake = builder(local, remote, ephemeral)?.build_initiator()?;
        let mut message = vec![0; MAX_HANDSHAKE];
        let length = handshake.write_message(&[], &mut message)?;
        message.truncate(length);
        Ok((Self(handshake), message))
    }

    /// Reads the app's answer (`hs2`); the session is ready.
    pub fn finish(mut self, message: &[u8]) -> Result<Transport, Error> {
        let mut payload = [0; MAX_HANDSHAKE];
        if message.len() > MAX_HANDSHAKE || self.0.read_message(message, &mut payload)? != 0 {
            return Err(Error);
        }
        Ok(Transport(self.0.into_transport_mode()?))
    }
}

/// A session after the handshake. Each direction counts its messages: a frame replayed,
/// dropped, reordered or altered fails to decrypt, and the session ends.
pub struct Transport(TransportState);

impl Transport {
    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, Error> {
        if plaintext.len() > MAX_PLAINTEXT {
            return Err(Error);
        }
        let mut message = vec![0; plaintext.len() + TAG_LEN];
        let length = self.0.write_message(plaintext, &mut message)?;
        message.truncate(length);
        Ok(message)
    }

    pub fn decrypt(&mut self, message: &[u8]) -> Result<Zeroizing<Vec<u8>>, Error> {
        if message.len() < TAG_LEN || message.len() > MAX_PLAINTEXT + TAG_LEN {
            return Err(Error);
        }
        let mut plaintext = Zeroizing::new(vec![0; message.len()]);
        let length = self.0.read_message(message, &mut plaintext)?;
        plaintext.truncate(length);
        Ok(plaintext)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(label: &str) -> [u8; KEY_LEN] {
        Sha256::digest(label.as_bytes()).into()
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn a_handshake_gives_both_sides_one_session() {
        let (extension, extension_public) = generate_keypair();
        let (app, app_public) = generate_keypair();
        assert_eq!(public_key(&extension), extension_public);

        let (initiator, hello) = Initiator::start(&extension, &app_public).unwrap();
        let (answer, mut app_side) = respond(&app, &extension_public, &hello).unwrap();
        let mut extension_side = initiator.finish(&answer).unwrap();

        let sealed = extension_side.encrypt(br#"{"id":1,"m":"ping"}"#).unwrap();
        assert_eq!(&*app_side.decrypt(&sealed).unwrap(), br#"{"id":1,"m":"ping"}"#);
        let sealed = app_side.encrypt(br#"{"id":1,"ok":true,"r":{}}"#).unwrap();
        assert_eq!(&*extension_side.decrypt(&sealed).unwrap(), br#"{"id":1,"ok":true,"r":{}}"#);
    }

    #[test]
    fn only_the_paired_keys_complete_a_handshake() {
        let (extension, extension_public) = generate_keypair();
        let (app, app_public) = generate_keypair();
        let (stranger, stranger_public) = generate_keypair();

        // The app doesn't know this browser's key as the one it paired with.
        let (_, hello) = Initiator::start(&stranger, &app_public).unwrap();
        assert!(respond(&app, &extension_public, &hello).is_err());
        // The browser holds another app's key (VaultKey was reset since pairing).
        let (_, hello) = Initiator::start(&extension, &stranger_public).unwrap();
        assert!(respond(&app, &extension_public, &hello).is_err());
        // A payload where there must be none.
        let mut handshake = builder(&extension, &app_public, None).unwrap().build_initiator().unwrap();
        let mut hello = vec![0; MAX_HANDSHAKE];
        let length = handshake.write_message(b"surprise", &mut hello).unwrap();
        assert!(respond(&app, &extension_public, &hello[..length]).is_err());
    }

    #[test]
    fn replayed_reordered_or_altered_frames_are_refused() {
        let (extension, extension_public) = generate_keypair();
        let (app, app_public) = generate_keypair();
        let (initiator, hello) = Initiator::start(&extension, &app_public).unwrap();
        let (answer, mut app_side) = respond(&app, &extension_public, &hello).unwrap();
        let mut extension_side = initiator.finish(&answer).unwrap();

        let first = extension_side.encrypt(b"one").unwrap();
        let second = extension_side.encrypt(b"two").unwrap();
        let mut altered = second.clone();
        altered[0] ^= 1;
        assert!(app_side.decrypt(&second).is_err(), "out of order");
        assert_eq!(&*app_side.decrypt(&first).unwrap(), b"one");
        assert!(app_side.decrypt(&first).is_err(), "replayed");
        assert!(app_side.decrypt(&altered).is_err(), "altered");
        assert_eq!(&*app_side.decrypt(&second).unwrap(), b"two");
        assert!(app_side.decrypt(&[0; 4]).is_err(), "shorter than a tag");
        assert!(extension_side.encrypt(&vec![b' '; MAX_PLAINTEXT + 1]).is_err());
    }

    #[test]
    fn client_ids_and_pairing_codes() {
        let public = public_key(&key("extension static"));
        assert_eq!(client_id(&public), Sha256::digest(public)[..16]);
        let code = pairing_code(&public, &public_key(&key("app static")));
        assert_eq!(code.len(), 6);
        assert!(code.bytes().all(|byte| byte.is_ascii_digit()));
        // Order matters: the extension's key comes first.
        assert_ne!(
            pairing_code(&public_key(&key("a")), &public_key(&key("b"))),
            pairing_code(&public_key(&key("b")), &public_key(&key("a")))
        );
    }

    /// The vectors the extension checks (`extension/tests/noise.test.ts`): fixed keys,
    /// the handshake both ways, then transport messages in both directions. Set
    /// `VAULTKEY_WRITE_FIXTURES=1` to write the file after an intended change.
    #[test]
    fn the_extension_vectors_are_current() {
        let extension = key("vaultkey test: extension static");
        let extension_ephemeral = key("vaultkey test: extension ephemeral");
        let app = key("vaultkey test: app static");
        let app_ephemeral = key("vaultkey test: app ephemeral");
        let extension_public = public_key(&extension);
        let app_public = public_key(&app);

        let (initiator, message1) = Initiator::start_with(&extension, &app_public, Some(&extension_ephemeral)).unwrap();
        let (message2, mut app_side) = respond_with(&app, &extension_public, &message1, Some(&app_ephemeral)).unwrap();
        let mut extension_side = initiator.finish(&message2).unwrap();

        let exchange: [(&str, &str); 4] = [
            ("extension", r#"{"id":1,"m":"ping"}"#),
            ("app", r#"{"id":1,"ok":true,"r":{}}"#),
            ("extension", r#"{"id":2,"m":"ping"}"#),
            ("app", r#"{"ev":"locked"}"#),
        ];
        let transport: Vec<serde_json::Value> = exchange
            .iter()
            .map(|(from, plaintext)| {
                let (sender, receiver) = if *from == "extension" {
                    (&mut extension_side, &mut app_side)
                } else {
                    (&mut app_side, &mut extension_side)
                };
                let ciphertext = sender.encrypt(plaintext.as_bytes()).unwrap();
                assert_eq!(&*receiver.decrypt(&ciphertext).unwrap(), plaintext.as_bytes());
                serde_json::json!({ "from": from, "plaintext": plaintext, "ciphertext": hex(&ciphertext) })
            })
            .collect();

        let vectors = serde_json::json!({
            "comment": "Written by src-tauri/bridge/src/noise.rs (the_extension_vectors_are_current) with snow; checked by tests/noise.test.ts. Keys are SHA-256 of fixed labels: test values only.",
            "protocol": PATTERN,
            "prologue": std::str::from_utf8(PROLOGUE).unwrap(),
            "extension": {
                "static": hex(&extension),
                "staticPublic": hex(&extension_public),
                "ephemeral": hex(&extension_ephemeral),
                "ephemeralPublic": hex(&public_key(&extension_ephemeral)),
            },
            "app": {
                "static": hex(&app),
                "staticPublic": hex(&app_public),
                "ephemeral": hex(&app_ephemeral),
                "ephemeralPublic": hex(&public_key(&app_ephemeral)),
            },
            "clientId": hex(&client_id(&extension_public)),
            "pairingCode": pairing_code(&extension_public, &app_public),
            "message1": hex(&message1),
            "message2": hex(&message2),
            "transport": transport,
        });

        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../extension/tests/fixtures/protocol/noise-kk.json");
        let text = format!("{}\n", serde_json::to_string_pretty(&vectors).unwrap());
        if std::env::var_os("VAULTKEY_WRITE_FIXTURES").is_some() {
            std::fs::write(path, &text).unwrap();
        }
        let committed = std::fs::read_to_string(path).unwrap_or_default();
        assert_eq!(
            committed, text,
            "the Noise vectors changed: run with VAULTKEY_WRITE_FIXTURES=1 to update the extension's fixture"
        );
    }
}
