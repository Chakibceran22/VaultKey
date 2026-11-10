//! Loads both models and checks that their outputs make sense, with timings.
//!
//!   cargo run -p vaultkey-search --example smoke

use std::{path::PathBuf, time::Instant};

use vaultkey_search::model::{self, BGE_SMALL, Embedder, Reranker, dot};

fn main() -> model::Result<()> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../models");
    let env = model::environment()?;

    let t = Instant::now();
    let mut embedder = Embedder::load(&env, &dir, BGE_SMALL, 2)?;
    let mut reranker = Reranker::load(&env, &dir, 2)?;
    println!("loaded {} ({} dims) + reranker in {:?}", embedder.name(), embedder.dim(), t.elapsed());

    let records: Vec<String> = [
        "Coolify: service of the project Acme Store, at coolify.acme.dev",
        "Vercel: service of the project Acme Store, at vercel.com",
        "Acme Store: project. Shop rebuild on Next.js, self-hosted on Hetzner.",
        "netflix.com: Streaming and media account",
        "spotify.com: Streaming and media account",
        "iPhone 15: phone",
        "Recovery codes for github.com, printed, in the drawer",
        "revolut.com: Money account",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let docs = embedder.embed_documents(&records)?;
    let dim = embedder.dim();

    for question in ["hosting", "music", "my bank", "backup codes", "the shop", "mobile"] {
        let t = Instant::now();
        let q = embedder.embed_queries(&[question])?;
        let took = t.elapsed();
        let mut sims: Vec<(f32, &str)> =
            records.iter().enumerate().map(|(i, r)| (dot(&q, &docs[i * dim..(i + 1) * dim]), r.as_str())).collect();
        sims.sort_by(|a, b| b.0.total_cmp(&a.0));
        println!("\n{question:?} ({took:?})");
        for (s, r) in sims.iter().take(3) {
            println!("  {s:.3}  {r}");
        }
    }

    let question = "what signs in with google";
    let candidates: Vec<String> = [
        "notion.so account: signs in with google.com",
        "google.com account: recovers github.com",
        "iPhone 15 phone: holds the sign-in prompt for google.com",
        "steampowered.com account",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let t = Instant::now();
    let scores = reranker.score(question, &candidates)?;
    println!("\nrerank {question:?} ({:?} for {})", t.elapsed(), candidates.len());
    for (s, c) in scores.iter().zip(&candidates) {
        println!("  {s:7.3}  {c}");
    }

    // Steady-state latency, after warm-up.
    let n = 50;
    let t = Instant::now();
    for _ in 0..n {
        embedder.embed_queries(&["device authentication for coolify auto"])?;
    }
    println!("\nembed one question: {:?} avg", t.elapsed() / n);
    let twenty: Vec<String> = (0..20).map(|i| format!("{} {}", candidates[i % 4], i)).collect();
    let t = Instant::now();
    for _ in 0..10 {
        reranker.score(question, &twenty)?;
    }
    println!("rerank 20 candidates: {:?} avg", t.elapsed() / 10);
    Ok(())
}
