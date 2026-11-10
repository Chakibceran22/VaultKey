//! The search on the demo vault. Word cases always run; meaning cases skip themselves
//! when the models are not fetched (`bash scripts/fetch-models.sh`).

use std::path::PathBuf;

use vaultkey_search::{
    Index, Models, Options, search,
    model::{self, ARCTIC_S, Embedder},
    vault::Vault,
};

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

#[test]
fn finds_by_meaning() -> model::Result<()> {
    let dir = root().join("../models");
    if !dir.join(ARCTIC_S.file).exists() {
        eprintln!("skipped: models not fetched");
        return Ok(());
    }
    let env = model::environment()?;
    let mut embedder = Embedder::load(&env, &dir, ARCTIC_S, 2)?;
    let mut index = Index::new(&vault());
    index.embed(&mut embedder)?;
    let opts = Options::default();
    let cases: [(&str, &[&str]); 5] = [
        // Intent by meaning: "log in" asks for sign-in steps.
        ("how do I log in to binance", &["step:18", "step:19"]),
        // A consequence, asked in a sentence.
        ("what would break if I lose my pixel", &["step:11", "step:14", "account:24", "account:13"]),
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
