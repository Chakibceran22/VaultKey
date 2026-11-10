//! Peak memory of the app's embedder alone: load, index the demo vault, answer a question.
//!
//!   /usr/bin/time -l cargo run -p vaultkey-search --example memory
use std::path::PathBuf;

use vaultkey_search::{Index, Models, Options, model, search, vault::Vault};

fn main() -> model::Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let vault: Vault = serde_json::from_str(&std::fs::read_to_string(root.join("fixtures/demo-vault.json"))?)?;
    let env = model::environment()?;
    let spec = std::env::args().nth(1).map_or(model::DEFAULT_EMBEDDER, |name| model::embedder_spec(&name).expect("known embedder"));
    let mut embedder = model::Embedder::load(&env, &root.join("../models"), spec, 2)?;
    let mut index = Index::new(&vault);
    index.embed(&mut embedder)?;
    let (response, _) = search(&index, "taxes", Some(Models { embedder: &mut embedder, reranker: None }), &Options::default())?;
    println!("{} → {}", response.query, response.hits[0].node.id);
    // What it holds once loaded (the peak, during loading, is reported by `time -l`).
    let rss = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output()?;
    let kb: f64 = String::from_utf8_lossy(&rss.stdout).trim().parse().unwrap_or(0.0);
    println!("held after loading: {:.0} MB", kb / 1024.0);
    Ok(())
}
