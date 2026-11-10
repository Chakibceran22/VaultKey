//! Input validation, ported from the Electron `validation.ts`.
//!
//! Length limits are counted in UTF-16 code units, like JavaScript's `String.length`, and
//! whitespace follows JavaScript's `\s` / `String.prototype.trim`, so the same inputs are
//! accepted and rejected as before.

use serde::Deserialize;
use zeroize::Zeroizing;

use crate::error::{VaultError, VaultResult};

/// `Number.MAX_SAFE_INTEGER`
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_DOMAIN_NAME: usize = 253;
const MAX_EMAIL: usize = 320;
const MAX_USERNAME: usize = 256;
/// The Electron app capped the stored ciphertext at 131072 base64 characters, i.e.
/// 98304 raw bytes = 12 (iv) + plaintext + 16 (tag). Keep exactly that ceiling.
pub const MAX_PASSWORD_BYTES: usize = 98_304 - 12 - 16;
/// Upper bound on master password size, purely to refuse absurd IPC payloads.
const MAX_MASTER_PASSWORD_BYTES: usize = 1 << 20;
const MIN_MASTER_PASSWORD: usize = 8;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialInput {
    pub domain_id: i64,
    #[serde(default)]
    pub username: Option<String>,
    pub email: String,
    pub password: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialUpdateInput {
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

// Hand-written so a stray `{:?}` can never log a plaintext password.
impl std::fmt::Debug for CredentialInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialInput")
            .field("domain_id", &self.domain_id)
            .field("password", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for CredentialUpdateInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialUpdateInput")
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .finish_non_exhaustive()
    }
}

pub struct ValidCredential {
    pub domain_id: i64,
    pub username: Option<String>,
    pub email: String,
    pub password: Zeroizing<String>,
}

pub struct ValidCredentialUpdate {
    pub username: Option<String>,
    pub email: Option<String>,
    pub password: Option<Zeroizing<String>>,
}

/// JavaScript's `\s` class (and the set `String.prototype.trim` removes).
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

fn js_length(value: &str) -> usize {
    value.encode_utf16().count()
}

fn require_max_length(value: &str, field: &str, max: usize) -> VaultResult<()> {
    if js_length(value) > max {
        return Err(VaultError::invalid_input(format!("Invalid {field}.")));
    }
    Ok(())
}

pub fn validate_id(value: i64, field: &str) -> VaultResult<i64> {
    if value <= 0 || value > MAX_SAFE_INTEGER {
        return Err(VaultError::invalid_input(format!("Invalid {field}.")));
    }
    Ok(value)
}

pub fn validate_domain_name(value: &str) -> VaultResult<String> {
    require_max_length(value, "domain name", MAX_DOMAIN_NAME)?;
    let name = value.trim_matches(is_js_whitespace);
    if name.is_empty() {
        return Err(VaultError::invalid_input("Domain name is required."));
    }
    Ok(name.to_owned())
}

/// `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
fn is_valid_email(value: &str) -> bool {
    if value.chars().any(is_js_whitespace) {
        return false;
    }
    let mut parts = value.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    // A '.' with at least one character on each side of it.
    !local.is_empty()
        && domain
            .char_indices()
            .any(|(index, c)| c == '.' && index > 0 && index + 1 < domain.len())
}

fn validate_email(value: String) -> VaultResult<String> {
    require_max_length(&value, "email", MAX_EMAIL)?;
    if !is_valid_email(&value) {
        return Err(VaultError::invalid_input("Invalid email."));
    }
    Ok(value)
}

fn validate_username(value: String) -> VaultResult<String> {
    require_max_length(&value, "username", MAX_USERNAME)?;
    Ok(value)
}

fn validate_password(value: String) -> VaultResult<Zeroizing<String>> {
    let value = Zeroizing::new(value);
    if value.len() > MAX_PASSWORD_BYTES {
        return Err(VaultError::invalid_input("Invalid password."));
    }
    Ok(value)
}

pub fn validate_credential_input(input: CredentialInput) -> VaultResult<ValidCredential> {
    let CredentialInput {
        domain_id,
        username,
        email,
        password,
    } = input;
    let password = validate_password(password)?;
    Ok(ValidCredential {
        domain_id: validate_id(domain_id, "domain id")?,
        username: username.map(validate_username).transpose()?,
        email: validate_email(email)?,
        password,
    })
}

pub fn validate_credential_update(
    input: CredentialUpdateInput,
) -> VaultResult<ValidCredentialUpdate> {
    let CredentialUpdateInput {
        username,
        email,
        password,
    } = input;
    if username.is_none() && email.is_none() && password.is_none() {
        return Err(VaultError::invalid_input("At least one field is required."));
    }
    let password = password.map(validate_password).transpose()?;
    Ok(ValidCredentialUpdate {
        username: username.map(validate_username).transpose()?,
        email: email.map(validate_email).transpose()?,
        password,
    })
}

pub fn validate_new_master_password(value: &str) -> VaultResult<()> {
    if js_length(value) < MIN_MASTER_PASSWORD {
        return Err(VaultError::invalid_input(
            "Master password must be at least 8 characters.",
        ));
    }
    validate_master_password(value)
}

pub fn validate_master_password(value: &str) -> VaultResult<()> {
    if value.is_empty() || value.len() > MAX_MASTER_PASSWORD_BYTES {
        return Err(VaultError::invalid_input("Invalid master password."));
    }
    Ok(())
}

// ── projects, services, secrets (schema v2) ────────────────────────────────

/// A text secret (API key, token, env var) is at most 64 KiB.
pub const MAX_SECRET_TEXT_BYTES: usize = 64 * 1024;
/// A file is at most 25 MiB: SSH keys, certificates, .env files, documents.
pub const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
/// Files up to this size can be shown and copied as text, when they are UTF-8.
pub const MAX_TEXT_FILE_BYTES: i64 = 256 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceInput {
    pub name: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub account_id: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretInput {
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub service_id: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretUpdateInput {
    pub name: String,
    #[serde(default)]
    pub service_id: Option<i64>,
    /// Text secrets only; absent keeps the current value.
    #[serde(default)]
    pub value: Option<String>,
}

impl std::fmt::Debug for SecretInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretInput")
            .field("name", &self.name)
            .field("value", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for SecretUpdateInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretUpdateInput")
            .field("name", &self.name)
            .field("value", &self.value.as_ref().map(|_| "<redacted>"))
            .finish_non_exhaustive()
    }
}

/// A required, trimmed name, at most `max` UTF-16 units.
pub fn validate_name(value: &str, field: &str, max: usize) -> VaultResult<String> {
    require_max_length(value, field, max)?;
    let name = value.trim_matches(is_js_whitespace);
    if name.is_empty() {
        return Err(VaultError::invalid_input(format!("Enter a {field}.")));
    }
    Ok(name.to_owned())
}

fn validate_optional_text(value: &str, field: &str, max: usize) -> VaultResult<String> {
    require_max_length(value, field, max)?;
    Ok(value.trim_matches(is_js_whitespace).to_owned())
}

pub fn validate_project(input: &ProjectInput) -> VaultResult<(String, String)> {
    Ok((
        validate_name(&input.name, "project name", 120)?,
        validate_optional_text(&input.description, "description", 2000)?,
    ))
}

pub fn validate_service(input: &ServiceInput) -> VaultResult<(String, String, Option<i64>)> {
    Ok((
        validate_name(&input.name, "service name", 120)?,
        validate_optional_text(&input.url, "URL", 2048)?,
        input
            .account_id
            .map(|id| validate_id(id, "account id"))
            .transpose()?,
    ))
}

pub fn validate_secret_value(value: &str) -> VaultResult<()> {
    if value.is_empty() {
        return Err(VaultError::invalid_input("Enter the secret value."));
    }
    if value.len() > MAX_SECRET_TEXT_BYTES {
        return Err(VaultError::invalid_input(
            "A secret can be at most 64 KB. Add it as a file instead.",
        ));
    }
    Ok(())
}

pub fn validate_optional_id(value: Option<i64>, field: &str) -> VaultResult<Option<i64>> {
    value.map(|id| validate_id(id, field)).transpose()
}

// ── devices, second steps, account secrets (schema v3) ─────────────────────

pub const DEVICE_KINDS: &[&str] = &["phone", "computer", "tablet", "security_key", "other"];
pub const FACTOR_KINDS: &[&str] = &[
    "authenticator",
    "passkey",
    "security_key",
    "sms",
    "email",
    "prompt",
    "recovery_codes",
];
pub const ACCOUNT_SECRET_KINDS: &[&str] = &["secret", "note"];
/// A setup key or `otpauth://` link is short; this only refuses absurd payloads.
pub const MAX_SETUP_KEY_BYTES: usize = 2048;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceInput {
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactorInput {
    pub kind: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub device_id: Option<i64>,
    /// An authenticator's setup key, or the recovery codes.
    #[serde(default)]
    pub secret: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactorUpdateInput {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub device_id: Option<i64>,
    /// Absent keeps the saved secret; empty removes it (where it is optional).
    #[serde(default)]
    pub secret: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountSecretInput {
    pub kind: String,
    pub name: String,
    pub value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountSecretUpdateInput {
    pub name: String,
    /// Absent keeps the current value.
    #[serde(default)]
    pub value: Option<String>,
}

impl std::fmt::Debug for FactorInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FactorInput")
            .field("kind", &self.kind)
            .field("secret", &self.secret.as_ref().map(|_| "<redacted>"))
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for FactorUpdateInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FactorUpdateInput")
            .field("secret", &self.secret.as_ref().map(|_| "<redacted>"))
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for AccountSecretInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountSecretInput")
            .field("kind", &self.kind)
            .field("name", &self.name)
            .field("value", &"<redacted>")
            .finish()
    }
}

impl std::fmt::Debug for AccountSecretUpdateInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountSecretUpdateInput")
            .field("name", &self.name)
            .field("value", &self.value.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// One of a fixed set of kinds, returned as the canonical `'static` spelling.
pub fn validate_kind(value: &str, kinds: &[&'static str], what: &str) -> VaultResult<&'static str> {
    kinds
        .iter()
        .copied()
        .find(|kind| *kind == value)
        .ok_or_else(|| VaultError::invalid_input(format!("Unknown {what}.")))
}

/// An optional short label (an app name, a phone number), trimmed.
pub fn validate_label(value: &str) -> VaultResult<String> {
    validate_optional_text(value, "label", 200)
}

/// An account's group: None, or blank, means "guess it".
pub fn validate_category(value: Option<&str>) -> VaultResult<Option<String>> {
    match value {
        Some(name) if !name.trim_matches(is_js_whitespace).is_empty() => {
            Ok(Some(validate_name(name, "category", 40)?))
        }
        _ => Ok(None),
    }
}

pub fn validate_device(input: &DeviceInput) -> VaultResult<(String, &'static str, String)> {
    Ok((
        validate_name(&input.name, "device name", 120)?,
        validate_kind(&input.kind, DEVICE_KINDS, "kind of device")?,
        validate_optional_text(&input.notes, "notes", 2000)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_matches_the_original_regex() {
        for ok in [
            "a@b.co",
            "a.b@c.d",
            "x@a.b.c",
            "ü@ex.ample",
            "a+b@c..d",
            "a@b.c.",
        ] {
            assert!(is_valid_email(ok), "{ok} should be valid");
        }
        for bad in [
            "",
            "a",
            "a@b",
            "@b.c",
            "a@.c",
            "a@b.",
            "a@@b.c",
            "a@b@c.d",
            "a b@c.d",
            "a@b.c ",
            "a\u{00A0}@b.c",
            "a@b\u{FEFF}.c",
            "a@.",
            "a@..",
        ] {
            assert!(!is_valid_email(bad), "{bad:?} should be invalid");
        }
    }

    #[test]
    fn domain_names_are_trimmed_like_javascript() {
        assert_eq!(
            validate_domain_name("  example.com\u{FEFF}\n").unwrap(),
            "example.com"
        );
        assert!(validate_domain_name(" \u{3000} ").is_err());
        // NEL (U+0085) is not JavaScript whitespace, so it is kept.
        assert_eq!(validate_domain_name("\u{0085}x").unwrap(), "\u{0085}x");
        assert!(validate_domain_name(&"a".repeat(253)).is_ok());
        assert!(validate_domain_name(&"a".repeat(254)).is_err());
        // Length is checked before trimming, in UTF-16 units: 🔑 counts as 2.
        assert!(validate_domain_name(&"🔑".repeat(127)).is_err());
    }

    #[test]
    fn ids_must_be_positive_safe_integers() {
        assert!(validate_id(1, "id").is_ok());
        assert!(validate_id(MAX_SAFE_INTEGER, "id").is_ok());
        assert!(validate_id(0, "id").is_err());
        assert!(validate_id(-1, "id").is_err());
        assert!(validate_id(MAX_SAFE_INTEGER + 1, "id").is_err());
    }

    #[test]
    fn credential_updates_need_at_least_one_field() {
        assert!(validate_credential_update(CredentialUpdateInput::default()).is_err());
        let update = validate_credential_update(CredentialUpdateInput {
            username: Some("new".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(update.username.as_deref(), Some("new"));
    }

    #[test]
    fn unknown_credential_fields_are_rejected() {
        let parsed: Result<CredentialInput, _> = serde_json::from_value(serde_json::json!({
            "domainId": 1, "email": "a@b.co", "password": "x", "isAdmin": true
        }));
        assert!(parsed.is_err());
    }

    #[test]
    fn password_size_matches_the_old_ciphertext_ceiling() {
        assert!(validate_password("a".repeat(MAX_PASSWORD_BYTES)).is_ok());
        assert!(validate_password("a".repeat(MAX_PASSWORD_BYTES + 1)).is_err());
    }

    #[test]
    fn master_passwords_follow_the_signup_rules() {
        assert!(validate_new_master_password("1234567").is_err());
        assert!(validate_new_master_password("12345678").is_ok());
        assert!(validate_master_password("").is_err());
        assert!(validate_master_password("x").is_ok());
    }

    #[test]
    fn kinds_come_from_a_fixed_list() {
        assert_eq!(
            validate_kind("passkey", FACTOR_KINDS, "x").unwrap(),
            "passkey"
        );
        assert!(validate_kind("Passkey", FACTOR_KINDS, "x").is_err());
        assert!(validate_kind("", DEVICE_KINDS, "x").is_err());
        let device = DeviceInput {
            name: "  iPhone ".into(),
            kind: "phone".into(),
            notes: String::new(),
        };
        assert_eq!(validate_device(&device).unwrap().0, "iPhone");
        let bad = DeviceInput {
            name: "Pager".into(),
            kind: "pager".into(),
            notes: String::new(),
        };
        assert!(validate_device(&bad).is_err());
    }

    #[test]
    fn second_step_inputs_never_print_their_secret() {
        let factor: FactorInput = serde_json::from_value(serde_json::json!({
            "kind": "authenticator", "secret": "JBSWY3DPEHPK3PXP"
        }))
        .unwrap();
        let note = AccountSecretInput {
            kind: "note".into(),
            name: "PIN".into(),
            value: "4421".into(),
        };
        let printed = format!("{factor:?}{note:?}");
        assert!(
            !printed.contains("JBSWY3DP") && !printed.contains("4421"),
            "{printed}"
        );
    }
}
