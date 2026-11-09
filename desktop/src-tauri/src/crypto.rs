//! Vault cryptography, byte-compatible with the Electron app.
//!
//! Format (unchanged from the Electron version, which used hash-wasm + WebCrypto):
//!
//! ```text
//! master    = Argon2id v1.3(password UTF-8, kdf_salt, t, m KiB, p, len)
//! authKey   = HKDF-SHA256(ikm = master, salt = kdf_salt, info = "vaultkey-auth", 32 bytes)
//! encKey    = HKDF-SHA256(ikm = master, salt = kdf_salt, info = "vaultkey-enc",  32 bytes)
//! verifier  = scrypt(authKey, verifier_salt, N = 2^15, r = 8, p = 1, 32 bytes)
//! password  = base64(iv[12] || AES-256-GCM(encKey, iv, plaintext) || tag[16])
//! ```
//!
//! Only the verifier is stored. The encryption key lives in memory while unlocked and is
//! zeroised on lock.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::error::{VaultError, VaultResult};

pub const KEY_LEN: usize = 32;
pub const SALT_LEN: usize = 16;
pub const IV_LEN: usize = 12;
pub const TAG_LEN: usize = 16;

pub const KDF_VERSION: i64 = 2;
pub const DEFAULT_ARGON2_ITERATIONS: u32 = 3;
pub const DEFAULT_ARGON2_MEMORY_KIB: u32 = 65_536;
pub const DEFAULT_ARGON2_PARALLELISM: u32 = 1;
pub const DEFAULT_ARGON2_HASH_LENGTH: u32 = 32;

pub const VERIFIER_VERSION: i64 = 1;
pub const VERIFIER_LEN: usize = 32;
const SCRYPT_LOG_N: u8 = 15; // N = 32768
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;

const AUTH_INFO: &[u8] = b"vaultkey-auth";
const ENC_INFO: &[u8] = b"vaultkey-enc";

/// A 256-bit key that is wiped from memory when dropped.
pub type SecretKey = Zeroizing<[u8; KEY_LEN]>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KdfParams {
    pub salt: [u8; SALT_LEN],
    pub iterations: u32,
    pub memory_kib: u32,
    pub parallelism: u32,
    pub hash_length: u32,
}

impl KdfParams {
    /// Parameters for a brand-new vault: random salt, same cost as the Electron app.
    pub fn generate() -> Self {
        Self {
            salt: random_bytes(),
            iterations: DEFAULT_ARGON2_ITERATIONS,
            memory_kib: DEFAULT_ARGON2_MEMORY_KIB,
            parallelism: DEFAULT_ARGON2_PARALLELISM,
            hash_length: DEFAULT_ARGON2_HASH_LENGTH,
        }
    }
}

pub struct DerivedKeys {
    pub auth_key: SecretKey,
    pub encryption_key: SecretKey,
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

fn unsupported_kdf() -> VaultError {
    VaultError::internal("Unsupported vault key derivation configuration.")
}

/// Argon2id → HKDF key separation. Equivalent to `deriveKeys` in the old renderer.
pub fn derive_keys(password: &str, kdf: &KdfParams) -> VaultResult<DerivedKeys> {
    let hash_length = usize::try_from(kdf.hash_length).map_err(|_| unsupported_kdf())?;
    let params = Params::new(
        kdf.memory_kib,
        kdf.iterations,
        kdf.parallelism,
        Some(hash_length),
    )
    .map_err(|error| unsupported_kdf().with_detail(error))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut master = Zeroizing::new(vec![0u8; hash_length]);
    argon2
        .hash_password_into(password.as_bytes(), &kdf.salt, &mut master)
        .map_err(|error| unsupported_kdf().with_detail(error))?;

    let hkdf = Hkdf::<Sha256>::new(Some(&kdf.salt), &master);
    let mut auth_key: SecretKey = Zeroizing::new([0u8; KEY_LEN]);
    let mut encryption_key: SecretKey = Zeroizing::new([0u8; KEY_LEN]);
    hkdf.expand(AUTH_INFO, auth_key.as_mut())
        .map_err(|_| VaultError::internal("Key separation failed."))?;
    hkdf.expand(ENC_INFO, encryption_key.as_mut())
        .map_err(|_| VaultError::internal("Key separation failed."))?;

    Ok(DerivedKeys {
        auth_key,
        encryption_key,
    })
}

/// scrypt verifier of the auth key. Equivalent to `deriveVerifier` in the old main process.
pub fn derive_verifier(auth_key: &[u8], salt: &[u8]) -> VaultResult<Zeroizing<[u8; VERIFIER_LEN]>> {
    let params = scrypt::Params::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, VERIFIER_LEN)
        .map_err(|error| VaultError::internal("Verifier derivation failed.").with_detail(error))?;
    let mut verifier = Zeroizing::new([0u8; VERIFIER_LEN]);
    scrypt::scrypt(auth_key, salt, &params, verifier.as_mut())
        .map_err(|error| VaultError::internal("Verifier derivation failed.").with_detail(error))?;
    Ok(verifier)
}

/// Constant-time comparison, like `timingSafeEqual` with the length pre-check.
pub fn verifier_matches(stored: &[u8], derived: &[u8]) -> bool {
    stored.len() == derived.len() && bool::from(stored.ct_eq(derived))
}

pub fn encrypt(plaintext: &str, key: &[u8; KEY_LEN]) -> VaultResult<String> {
    encrypt_with_iv(plaintext.as_bytes(), key, &random_bytes::<IV_LEN>())
}

fn encrypt_with_iv(
    plaintext: &[u8],
    key: &[u8; KEY_LEN],
    iv: &[u8; IV_LEN],
) -> VaultResult<String> {
    Ok(BASE64.encode(seal(plaintext, key, iv)?))
}

/// `iv || AES-256-GCM(plaintext) || tag`, the one sealed format for everything.
fn seal(plaintext: &[u8], key: &[u8; KEY_LEN], iv: &[u8; IV_LEN]) -> VaultResult<Vec<u8>> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| VaultError::internal("Encryption failed."))?;
    let sealed = cipher
        .encrypt(Nonce::from_slice(iv), plaintext)
        .map_err(|_| VaultError::internal("Encryption failed."))?;
    let mut combined = Vec::with_capacity(IV_LEN + sealed.len());
    combined.extend_from_slice(iv);
    combined.extend_from_slice(&sealed);
    Ok(combined)
}

/// Encrypts raw bytes (secrets and files) into the same sealed format as
/// passwords, stored as a BLOB instead of base64 text.
pub fn encrypt_bytes(plaintext: &[u8], key: &[u8; KEY_LEN]) -> VaultResult<Vec<u8>> {
    seal(plaintext, key, &random_bytes::<IV_LEN>())
}

pub fn decrypt_bytes(sealed: &[u8], key: &[u8; KEY_LEN]) -> VaultResult<Zeroizing<Vec<u8>>> {
    let failure = || VaultError::internal("A stored secret could not be decrypted.");
    if sealed.len() < IV_LEN + TAG_LEN {
        return Err(failure());
    }
    let (iv, body) = sealed.split_at(IV_LEN);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| failure())?;
    Ok(Zeroizing::new(
        cipher
            .decrypt(Nonce::from_slice(iv), body)
            .map_err(|_| failure())?,
    ))
}

pub fn decrypt(encoded: &str, key: &[u8; KEY_LEN]) -> VaultResult<Zeroizing<String>> {
    let failure = || VaultError::internal("A stored credential could not be decrypted.");
    let raw = BASE64.decode(encoded).map_err(|_| failure())?;
    if raw.len() < IV_LEN + TAG_LEN {
        return Err(failure());
    }
    let (iv, sealed) = raw.split_at(IV_LEN);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| failure())?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(Nonce::from_slice(iv), sealed)
            .map_err(|_| failure())?,
    );
    // `new TextDecoder().decode()` semantics: invalid sequences become U+FFFD and one
    // leading byte-order mark is dropped (ignoreBOM defaults to false).
    let text = String::from_utf8_lossy(&plaintext);
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
    Ok(Zeroizing::new(text.to_owned()))
}

#[cfg(test)]
pub(crate) mod tests {
    //! Vectors generated by running the Electron app's own `crypto.ts` (hash-wasm 4.12.0 +
    //! WebCrypto) and Node's `crypto.scrypt` with `auth-service.ts` options. If any of
    //! these fail, the Rust port cannot open vaults written by the Electron app.
    use super::*;

    pub(crate) const VECTOR_SALT: &str = "AQIDBAUGBwgJCgsMDQ4PEA==";
    pub(crate) const ASCII_PASSWORD: &str = "correct horse battery staple";
    const UNICODE_PASSWORD: &str = "pässwörd — 🔑 ключ";

    pub(crate) const K1_AUTH: &str =
        "3a841d9d01bd0c730042b75815b489cf4e1582ab70b3b11efc393d62f54442c6";
    pub(crate) const K1_ENC: &str =
        "6cd3f50eee8380656c43930f10208b887cadb56e984a31f7f3396f0afec07324";
    const K2_AUTH: &str = "8e6c4badfbaba01fa3477f875efaadca914a762c1b98c1b3c1ab268f8398c68c";
    const K2_ENC: &str = "35166d5f7f0ee1bc8a19fa08f327cabd1de85be8d24ddc0907442c79decc6c05";
    const K3_AUTH: &str = "dd3cb11ed3d0f76baa8d6632f3a275ef41e23ae878d13c3eee471a49bc46ddb9";
    const K3_ENC: &str = "63929c7f56e72197f2e810d2b3427aeb73a40e2a06b0c34e0f33435a6940a30a";

    /// JS `encrypt('secret-password', K1_ENC)`.
    pub(crate) const CT1: &str = "SGeO+fsNmosTFVm5Cx9+B56n0Vijf2c61nigJrLvxA0FVHGWmQIvhXel4g==";
    /// JS `encrypt('ünïcødé 🔐 пароль', K1_ENC)`.
    const CT2: &str =
        "4pgRzMiEGq1pA6aSWASNb2AhbwUGNxIg9V6msrA1F+m18TMqPGGe14pqwvQQqxJLXCQJmKeuzC6j";
    /// JS `encrypt('', K1_ENC)`.
    const CT3: &str = "q4GfEXYOBV0toOb+nlzBpTqpfhdrj7rDN2/lww==";
    /// WebCrypto AES-GCM of 'secret-password' under K1_ENC with iv = 00 01 .. 0b.
    const FIXED_IV_CT: &str = "AAECAwQFBgcICQoLIZCeuteSwI8Jm+ucPNQiyrGDHRSrmW510XOmSnpQ/w==";

    pub(crate) const VERIFIER_SALT: &str = "101112131415161718191a1b1c1d1e1f";
    pub(crate) const VERIFIER: &str =
        "78b2bc6d99a9bf4dd32c0f089263203f7a40b0f0aa9a8baebc5f3c29048a8e3f";

    pub(crate) fn vector_kdf(iterations: u32, memory_kib: u32) -> KdfParams {
        KdfParams {
            salt: BASE64.decode(VECTOR_SALT).unwrap().try_into().unwrap(),
            iterations,
            memory_kib,
            parallelism: 1,
            hash_length: 32,
        }
    }

    fn key(hex_key: &str) -> [u8; KEY_LEN] {
        hex::decode(hex_key).unwrap().try_into().unwrap()
    }

    #[test]
    fn derives_the_same_keys_as_the_electron_app() {
        let production = vector_kdf(3, 65_536);
        let keys = derive_keys(ASCII_PASSWORD, &production).unwrap();
        assert_eq!(hex::encode(*keys.auth_key), K1_AUTH);
        assert_eq!(hex::encode(*keys.encryption_key), K1_ENC);

        let keys = derive_keys(UNICODE_PASSWORD, &production).unwrap();
        assert_eq!(hex::encode(*keys.auth_key), K2_AUTH);
        assert_eq!(hex::encode(*keys.encryption_key), K2_ENC);

        let keys = derive_keys(ASCII_PASSWORD, &vector_kdf(1, 8_192)).unwrap();
        assert_eq!(hex::encode(*keys.auth_key), K3_AUTH);
        assert_eq!(hex::encode(*keys.encryption_key), K3_ENC);
    }

    #[test]
    fn decrypts_ciphertext_written_by_the_electron_app() {
        let k = key(K1_ENC);
        assert_eq!(decrypt(CT1, &k).unwrap().as_str(), "secret-password");
        assert_eq!(decrypt(CT2, &k).unwrap().as_str(), "ünïcødé 🔐 пароль");
        assert_eq!(decrypt(CT3, &k).unwrap().as_str(), "");
    }

    #[test]
    fn produces_byte_identical_ciphertext_for_the_same_iv() {
        let iv: [u8; IV_LEN] = core::array::from_fn(|i| i as u8);
        let ciphertext = encrypt_with_iv(b"secret-password", &key(K1_ENC), &iv).unwrap();
        assert_eq!(ciphertext, FIXED_IV_CT);
    }

    #[test]
    fn derives_the_same_verifier_as_node_scrypt() {
        let verifier =
            derive_verifier(&key(K1_AUTH), &hex::decode(VERIFIER_SALT).unwrap()).unwrap();
        assert_eq!(hex::encode(*verifier), VERIFIER);
        assert!(verifier_matches(
            &hex::decode(VERIFIER).unwrap(),
            verifier.as_ref()
        ));
        assert!(!verifier_matches(&[0u8; 32], verifier.as_ref()));
        assert!(!verifier_matches(&[0u8; 31], verifier.as_ref()));
    }

    #[test]
    fn round_trips_and_rejects_wrong_keys_or_tampering() {
        let k = key(K1_ENC);
        let ciphertext = encrypt("hunter2 ✓", &k).unwrap();
        assert!(!ciphertext.contains("hunter2"));
        assert_eq!(decrypt(&ciphertext, &k).unwrap().as_str(), "hunter2 ✓");
        // Fresh IV every time.
        assert_ne!(ciphertext, encrypt("hunter2 ✓", &k).unwrap());

        let mut wrong = k;
        wrong[31] ^= 0xff;
        assert!(decrypt(&ciphertext, &wrong).is_err());

        let mut raw = BASE64.decode(&ciphertext).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        assert!(decrypt(&BASE64.encode(raw), &k).is_err());
        assert!(decrypt("AAAA", &k).is_err());
        assert!(decrypt("not base64!", &k).is_err());
    }

    #[test]
    fn seals_bytes_in_the_password_format() {
        let k = key(K1_ENC);
        let file = b"-----BEGIN OPENSSH PRIVATE KEY-----\n\x00\xff binary too";
        let sealed = encrypt_bytes(file, &k).unwrap();
        assert_eq!(sealed.len(), IV_LEN + file.len() + TAG_LEN);
        assert!(!sealed.windows(7).any(|w| w == b"OPENSSH"));
        assert_eq!(decrypt_bytes(&sealed, &k).unwrap().as_slice(), file);
        // Same construction as passwords: a password's base64 decodes to a sealed blob.
        let password = BASE64.decode(CT1).unwrap();
        assert_eq!(
            decrypt_bytes(&password, &k).unwrap().as_slice(),
            b"secret-password"
        );

        let mut wrong = k;
        wrong[0] ^= 1;
        assert!(decrypt_bytes(&sealed, &wrong).is_err());
        assert!(decrypt_bytes(&sealed[..20], &k).is_err());
        assert_eq!(
            decrypt_bytes(&encrypt_bytes(b"", &k).unwrap(), &k)
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn decodes_like_text_decoder() {
        let k = key(K1_ENC);
        let iv = [7u8; IV_LEN];
        // One leading BOM is dropped (as TextDecoder does), a second one is kept.
        let bom = encrypt_with_iv("\u{FEFF}\u{FEFF}x".as_bytes(), &k, &iv).unwrap();
        assert_eq!(decrypt(&bom, &k).unwrap().as_str(), "\u{FEFF}x");
        // Invalid UTF-8 becomes U+FFFD instead of failing.
        let invalid = encrypt_with_iv(&[b'a', 0xff, b'b'], &k, &iv).unwrap();
        assert_eq!(decrypt(&invalid, &k).unwrap().as_str(), "a\u{FFFD}b");
    }
}
