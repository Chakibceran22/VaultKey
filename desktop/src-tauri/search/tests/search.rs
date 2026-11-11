//! The search on the demo vault. Word cases always run; meaning cases skip themselves
//! when the models are not fetched (`bash scripts/fetch-models.sh`).

use std::path::PathBuf;

use vaultkey_search::{Index, Models, Options, search, vault::Vault};
#[cfg(feature = "meaning")]
use vaultkey_search::model::{self, DEFAULT_EMBEDDER, Embedder};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn vault() -> Vault {
    serde_json::from_str(&std::fs::read_to_string(root().join("fixtures/demo-vault.json")).unwrap()).unwrap()
}

fn words_only() -> Options {
    Options { meaning: false, rerank: false, ..Options::default() }
}

fn first(index: &Index, query: &str, models: Option<Models<'_>>, opts: &Options) -> String {
    let (response, _) = search(index, query, models, opts).unwrap();
    response.hits.first().map(|h| h.node.id.clone()).unwrap_or_default()
}

#[test]
fn finds_by_words_and_links() {
    let index = Index::new(&vault());
    let cases = [
        ("github passkey", "step:2"),
        ("battlenet", "account:16"),
        ("lumen post", "project:3"),
        // Two hops past the names: Lumenpost › Coolify › its account › authenticator › Pixel 7.
        ("device authentication for coolify lumenpost", "device:5"),
        // Relations read both ways.
        ("what recovers github", "account:9"),
        // "recovery" asks for recovery codes here; it is not the note "Recovery phrase".
        ("recovery codes for google", "step:7"),
    ];
    for (query, want) in cases {
        assert_eq!(first(&index, query, None, &words_only()), want, "{query}");
    }
}

#[test]
fn finds_a_server_by_its_own_login() {
    let vault: Vault = serde_json::from_value(serde_json::json!({
        "projects": [{ "id": 1, "name": "Shaba", "description": "" }],
        "services": [
            { "id": 1, "projectId": 1, "name": "Prod server", "url": "203.0.113.7:22",
              "logins": [{ "username": "root", "note": "full access" }, { "username": "deploy", "note": "" }] },
            { "id": 2, "projectId": 1, "name": "Vercel", "url": "https://vercel.com" }
        ]
    }))
    .unwrap();
    let index = Index::new(&vault);
    for query in ["root", "deploy", "203.0.113.7", "full access"] {
        assert_eq!(first(&index, query, None, &words_only()), "service:1", "{query}");
    }
}

#[test]
fn keeps_the_console_contract() {
    let index = Index::new(&vault());
    let (response, _) = search(&index, "device authentication for coolify lumenpost", None, &words_only()).unwrap();
    let json = serde_json::to_value(&response).unwrap();
    let hit = &json["hits"][0];
    assert_eq!(hit["node"]["kind"], "device");
    assert_eq!(hit["node"]["detail"], "phone");
    assert_eq!(hit["path"][0]["via"], serde_json::Value::Null);
    // coolify.lumenpost.io › its authenticator app › lives on the Pixel 7.
    let path = hit["path"].as_array().unwrap();
    assert!(path.len() >= 3, "the path explains the hops");
    assert_eq!(path.last().unwrap()["via"], "lives on");
    assert_eq!(json["understood"]["wants"][0]["label"], "Devices");
}

#[test]
fn never_indexes_secret_values() {
    // The vault input has no field for a secret value; the record text is metadata only.
    let index = Index::new(&vault());
    for node in &index.graph.nodes {
        assert!(!node.text.contains("sk_live") && !node.text.contains("BEGIN OPENSSH"), "{}", node.text);
    }
}

#[cfg(feature = "meaning")]
#[test]
fn finds_by_meaning() -> model::Result<()> {
    let dir = root().join("../models");
    if !dir.join(DEFAULT_EMBEDDER.file).exists() {
        eprintln!("skipped: models not fetched");
        return Ok(());
    }
    let env = model::environment()?;
    let mut embedder = Embedder::load(&env, &dir, DEFAULT_EMBEDDER, 2)?;
    let mut index = Index::new(&vault());
    index.embed(&mut embedder)?;
    let opts = Options::default();
    let cases: [(&str, &[&str]); 4] = [
        // Intent by meaning: "log in" asks for sign-in steps.
        ("how do I log in to binance", &["step:18", "step:19"]),
        // A word in no name, close in meaning to a device's notes.
        ("spare phone", &["device:5"]),
        ("my bank", &["account:30", "account:31", "account:19"]),
        ("password manager", &["account:66"]),
    ];
    for (query, want) in cases {
        let got = first(&index, query, Some(Models { embedder: &mut embedder, reranker: None }), &opts);
        assert!(want.contains(&got.as_str()), "{query}: got {got}");
    }
    Ok(())
}

/// Schema v5: a service with several accounts, each with a role.
#[test]
fn finds_every_account_a_service_uses_and_each_by_its_role() {
    let vault: Vault = serde_json::from_value(serde_json::json!({
        "accounts": [
            { "id": 1, "domainName": "coolify.acme.dev", "email": "admin@acme.dev", "group": "Developer and cloud" },
            { "id": 2, "domainName": "coolify.acme.dev", "email": "deploy@acme.dev", "group": "Developer and cloud" },
            { "id": 3, "domainName": "github.com", "email": "me@acme.dev", "group": "Developer and cloud" }
        ],
        "projects": [{ "id": 1, "name": "Acme" }],
        "services": [{ "id": 1, "projectId": 1, "name": "Coolify", "url": "https://coolify.acme.dev",
            "accounts": [{ "accountId": 2, "role": "deploy only" }, { "accountId": 1, "role": "admin, root" }] }],
        "secrets": [{ "id": 1, "projectId": 1, "serviceId": 1, "kind": "file", "name": "id_ed25519",
            "description": "root ssh key for the prod server" }],
        "devices": [{ "id": 1, "name": "iPhone", "kind": "phone" }],
        "deviceLinks": [{ "accountId": 3, "deviceId": 1, "note": "authenticator" }]
    }))
    .unwrap();
    let index = Index::new(&vault);
    let ids = |query: &str| -> Vec<String> {
        let (response, _) = search(&index, query, None, &words_only()).unwrap();
        response.hits.iter().filter(|h| h.answer).map(|h| h.node.id.clone()).collect()
    };
    let both = ids("coolify account");
    assert!(both.contains(&"account:1".into()) && both.contains(&"account:2".into()), "{both:?}");
    assert_eq!(first(&index, "coolify admin", None, &words_only()), "account:1");
    assert_eq!(first(&index, "coolify deploy", None, &words_only()), "account:2");
    assert_eq!(first(&index, "root ssh key", None, &words_only()), "file:1");
    assert_eq!(first(&index, "authenticator iphone", None, &words_only()), "device:1");
}

/// Names are labels: "Shaba" means nothing and is found by its spelling. What a project
/// is comes from its description, which is what meaning reads.
#[cfg(feature = "meaning")]
#[test]
fn finds_a_meaningless_name_by_its_description() -> model::Result<()> {
    let dir = root().join("../models");
    if !dir.join(DEFAULT_EMBEDDER.file).exists() {
        eprintln!("skipped: models not fetched");
        return Ok(());
    }
    let vault: Vault = serde_json::from_value(serde_json::json!({
        "projects": [
            { "id": 1, "name": "Shaba", "description": "Online booking for a hair salon" },
            { "id": 2, "name": "Kito", "description": "Internal dashboard for warehouse stock levels" },
            { "id": 3, "name": "Moro", "description": "Mobile app for a running club" }
        ],
        "services": [
            { "id": 1, "projectId": 1, "name": "Vercel" },
            { "id": 2, "projectId": 2, "name": "Supabase" },
            { "id": 3, "projectId": 3, "name": "Expo" }
        ]
    }))
    .unwrap();
    let env = model::environment()?;
    let mut embedder = Embedder::load(&env, &dir, DEFAULT_EMBEDDER, 2)?;
    let mut index = Index::new(&vault);
    index.embed(&mut embedder)?;
    let opts = Options::default();
    let cases = [
        // By its name, spelled (typos too), as always.
        ("shaba", "project:1"),
        ("shabba", "project:1"),
        // By what it is, in words that appear nowhere in the vault.
        ("hairdresser appointments", "project:1"),
        ("inventory", "project:2"),
        ("joggers", "project:3"),
    ];
    for (query, want) in cases {
        let got = first(&index, query, Some(Models { embedder: &mut embedder, reranker: None }), &opts);
        assert_eq!(got, want, "{query}");
    }
    Ok(())
}
