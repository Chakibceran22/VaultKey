//! What people ask for: "device", "passkey", "secrets"… The word lists are those of
//! `src/lib/search/engine.ts`, unchanged; the example phrasings are new and let a
//! question be read by meaning ("how do I log in" is about sign-in steps).

use std::{collections::HashMap, sync::LazyLock};

use crate::types::NodeKind::{self, *};

/// Words that carry no meaning here, in English and French.
pub static FILLER: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    "a an the of for to my on in at by with and or from is it its that which what where how do does i me show find get
    give open used use using this these those all any some
    de du des la le les l d pour mon ma mes sur avec et ou un une au aux dans par qui que quel quelle quels ce cet cette
    ces son sa ses mon est"
        .split_whitespace()
        .collect()
});

pub fn is_filler(word: &str) -> bool {
    FILLER.contains(&word)
}

/// Common English words beyond the filler list. They only decide whether what is left of a
/// question says anything ("where are my" does not; "would break if i lose" does).
const STOPWORDS: &[&str] = &[
    "are", "was", "were", "be", "been", "am", "can", "could", "should", "will", "did", "has", "have", "had",
    "there", "here", "when", "who", "whom", "whose", "why", "then", "than", "not", "no", "your", "our",
    "their", "his", "her", "they", "them", "we", "you", "he", "she", "us", "into", "about", "just", "only",
    "also", "very", "please", "need", "want", "keep", "kept", "put", "go", "goes", "see",
];

pub fn is_stopword(word: &str) -> bool {
    STOPWORDS.contains(&word)
}

pub struct Intent {
    pub label: &'static str,
    pub kinds: &'static [NodeKind],
    /// Narrower: only these device or step kinds.
    pub detail: Option<&'static [&'static str]>,
    /// Only what is reached through this relation: "signs in with google" → "used to sign in to".
    pub via: Option<&'static [&'static str]>,
    /// How precise it is: "passkey" (3) says more than "device" (2) or "account" (1).
    pub weight: u8,
    /// The words that ask for it (the stand-in's vocabulary).
    pub words: &'static str,
    /// How people phrase it, for reading a question by meaning. Empty: words only.
    pub examples: &'static [&'static str],
}

const CODES: &[&str] = &["authenticator", "sms", "email", "recovery_codes"];

pub static INTENTS: &[Intent] = &[
    Intent { label: "Devices", kinds: &[Device], detail: None, via: None, weight: 2,
        words: "device devices appareil appareils",
        examples: &["which device", "on what device", "which gadget"] },
    Intent { label: "Phones", kinds: &[Device], detail: Some(&["phone"]), via: None, weight: 2,
        words: "phone phones telephone telephones mobile portable",
        examples: &["which phone", "on my smartphone", "which cell phone"] },
    Intent { label: "Computers", kinds: &[Device], detail: Some(&["computer"]), via: None, weight: 2,
        words: "laptop laptops computer computers ordinateur ordinateurs mac",
        examples: &["which laptop", "which computer", "on my desktop pc"] },
    Intent { label: "Tablets", kinds: &[Device], detail: Some(&["tablet"]), via: None, weight: 2,
        words: "tablet tablets tablette tablettes ipad",
        examples: &["which tablet"] },
    Intent { label: "Security keys", kinds: &[Device, Step], detail: Some(&["security_key"]), via: None, weight: 3,
        words: "yubikey yubikeys securitykey securitykeys",
        examples: &["hardware security key", "usb key to sign in"] },
    Intent { label: "Sign-in steps", kinds: &[Step], detail: None, via: None, weight: 1,
        words: "authentication authenticate authentification auth 2fa mfa twofactor 2step verification",
        examples: &["how do i log in", "how to sign in", "two-factor authentication", "second step when signing in", "how do i get into"] },
    Intent { label: "Authenticator apps", kinds: &[Step], detail: Some(&["authenticator"]), via: None, weight: 3,
        words: "authenticator otp totp",
        examples: &["authenticator app", "six-digit codes app", "one-time password app"] },
    Intent { label: "Codes", kinds: &[Step], detail: Some(CODES), via: None, weight: 2,
        words: "code codes",
        examples: &["verification codes"] },
    Intent { label: "Passkeys", kinds: &[Step], detail: Some(&["passkey"]), via: None, weight: 3,
        words: "passkey passkeys",
        examples: &["passkey", "sign in with face id or touch id"] },
    Intent { label: "Recovery codes", kinds: &[Step], detail: Some(&["recovery_codes"]), via: None, weight: 3,
        words: "recovery backup recuperation secours",
        examples: &["backup codes", "recovery codes", "emergency codes if i lose my phone"] },
    Intent { label: "Text messages", kinds: &[Step], detail: Some(&["sms"]), via: None, weight: 3,
        words: "sms",
        examples: &["text message", "codes sent by text message", "codes sent to my phone number"] },
    Intent { label: "Sign-in prompts", kinds: &[Step], detail: Some(&["prompt"]), via: None, weight: 3,
        words: "prompt",
        examples: &["approve the sign-in on my phone", "push notification to sign in"] },
    Intent { label: "Accounts", kinds: &[Account], detail: None, via: None, weight: 1,
        words: "password passwords login logins credential credentials account accounts compte comptes identifiant identifiants mdp signin",
        examples: &["username and password", "my login for", "credentials"] },
    Intent { label: "Secrets", kinds: &[ProjectSecret, AccountSecret], detail: None, via: None, weight: 2,
        words: "secret secrets token tokens key keys api env variable variables cle cles",
        examples: &["secret keys", "environment variables", "access tokens"] },
    Intent { label: "API keys", kinds: &[ProjectSecret, AccountSecret], detail: None, via: None, weight: 3,
        words: "apikey apikeys",
        examples: &["api key"] },
    Intent { label: "SSH and private keys", kinds: &[File, ProjectSecret, AccountSecret], detail: None, via: None, weight: 3,
        words: "sshkey sshkeys privatekey privatekeys",
        examples: &["ssh private key"] },
    // Relations read both ways: "what signs in with google" and "what does figma sign in with".
    Intent { label: "Sign-in links", kinds: &[Account], detail: None, via: Some(&["used to sign in to", "signs in with"]), weight: 2,
        words: "sign signs signed",
        examples: &["what logs in with", "which sites use it to sign in", "what do i sign in to with"] },
    Intent { label: "Recovery links", kinds: &[Account], detail: None, via: Some(&["recovers", "recovered by"]), weight: 2,
        words: "recovers recover",
        examples: &["what is it the recovery email for", "which accounts does it recover"] },
    Intent { label: "Notes", kinds: &[Note], detail: None, via: None, weight: 2,
        words: "note notes",
        examples: &["my notes about"] },
    Intent { label: "Files", kinds: &[File], detail: None, via: None, weight: 2,
        words: "file files ssh certificate certificates cert pem fichier fichiers",
        examples: &["files", "documents", "certificate"] },
    Intent { label: "Projects", kinds: &[Project], detail: None, via: None, weight: 1,
        words: "project projects projet projets",
        examples: &["which project"] },
    Intent { label: "Services", kinds: &[Service], detail: None, via: None, weight: 1,
        words: "service services hosting server servers serveur hebergement",
        examples: &["hosting", "which server", "which service"] },
    Intent { label: "Groups", kinds: &[Group], detail: None, via: None, weight: 1,
        words: "group groups category categories",
        examples: &["which category"] },
    // By meaning only: what would be lost with it.
    Intent { label: "What depends on it", kinds: &[Step, Account, Service], detail: None,
        via: Some(&["holds", "signed in to", "protects", "used to sign in to", "recovers", "used by"]), weight: 2,
        words: "",
        examples: &["what depends on", "what would break if i lose", "what needs", "what relies on", "what is affected if it is stolen"] },
];

/// Word → index into [`INTENTS`]. A word listed twice keeps its last intent, as in the UI.
pub static BY_WORD: LazyLock<HashMap<&'static str, usize>> = LazyLock::new(|| {
    let mut map = HashMap::new();
    for (i, intent) in INTENTS.iter().enumerate() {
        for word in intent.words.split_whitespace() {
            map.insert(word, i);
        }
    }
    map
});
