//! What search is given: the vault's metadata, never a password, secret value, file
//! content or note body. Field names follow the renderer's contracts (camelCase), so a
//! snapshot of what the UI holds deserializes as is.

use serde::Deserialize;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Vault {
    pub accounts: Vec<Account>,
    pub links: Vec<AccountLink>,
    pub devices: Vec<Device>,
    pub factors: Vec<Factor>,
    pub account_secrets: Vec<AccountSecret>,
    pub device_links: Vec<DeviceLink>,
    pub projects: Vec<Project>,
    pub services: Vec<Service>,
    pub secrets: Vec<ProjectSecret>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: i64,
    pub domain_name: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub email: String,
    /// The group it is shown in (chosen, or guessed from its name by the app).
    pub group: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkKind {
    SignIn,
    Recovery,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLink {
    pub account_id: i64,
    pub linked_account_id: i64,
    pub kind: LinkKind,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: i64,
    pub name: String,
    /// phone, computer, tablet, security_key, other
    pub kind: String,
    #[serde(default)]
    pub notes: String,
}

/// A sign-in step (second factor) of an account.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Factor {
    pub id: i64,
    pub account_id: i64,
    /// authenticator, passkey, security_key, sms, email, prompt, recovery_codes
    pub kind: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub device_id: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSecret {
    pub id: i64,
    pub account_id: i64,
    /// "note", or anything else for a secret.
    pub kind: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLink {
    pub account_id: i64,
    pub device_id: i64,
    /// What it does there ("mobile app + authenticator"), decrypted; may be empty.
    #[serde(default)]
    pub note: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub id: i64,
    pub project_id: i64,
    pub name: String,
    #[serde(default)]
    pub url: String,
    /// The accounts it uses, in order, each with its role there (schema v5).
    #[serde(default)]
    pub accounts: Vec<ServiceAccount>,
    /// Its one account, before v5 (snapshots and fixtures written then).
    #[serde(default)]
    pub account_id: Option<i64>,
    /// Its own logins (schema v6): a server's root user. Never a password.
    #[serde(default)]
    pub logins: Vec<ServiceLogin>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceLogin {
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceAccount {
    pub account_id: i64,
    /// "admin", "deploy only"…, decrypted; may be empty.
    #[serde(default)]
    pub role: String,
}

impl Service {
    /// Its accounts and their roles, whichever way they were given.
    pub fn uses(&self) -> Vec<(i64, &str)> {
        if self.accounts.is_empty() {
            self.account_id.map(|id| (id, "")).into_iter().collect()
        } else {
            self.accounts.iter().map(|a| (a.account_id, a.role.as_str())).collect()
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSecret {
    pub id: i64,
    pub project_id: i64,
    #[serde(default)]
    pub service_id: Option<i64>,
    /// "file", or anything else for a text secret.
    pub kind: String,
    pub name: String,
    /// What it's for, its scopes, decrypted; may be empty.
    #[serde(default)]
    pub description: String,
}

/// Display names, as `components/accounts/kinds.ts` shows them.
pub fn step_name(kind: &str) -> &'static str {
    match kind {
        "authenticator" => "Authenticator app",
        "passkey" => "Passkey",
        "security_key" => "Security key",
        "sms" => "Text message",
        "email" => "Email code",
        "prompt" => "Sign-in prompt",
        "recovery_codes" => "Recovery codes",
        _ => "Sign-in step",
    }
}

pub fn device_name(kind: &str) -> &'static str {
    match kind {
        "phone" => "Phone",
        "computer" => "Computer",
        "tablet" => "Tablet",
        "security_key" => "Security key",
        _ => "Other",
    }
}
