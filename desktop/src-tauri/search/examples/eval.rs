//! Accuracy and latency of the search on the demo vault and its gold questions.
//!
//!   cargo run -p vaultkey-search --example eval -- [options]
//!
//!   --embedder arctic|bge   which embedding model (default arctic)
//!   --split dev|held|all    which questions to show failures for (default dev)
//!   --threads N             ONNX Runtime threads per model (default 2)
//!   --set name=value        override a Params field (repeatable)
//!   --only words|meaning|full   run one configuration instead of all three
//!   --probe "a|b"           what meaning sees in each phrase (closest records, intents)
//!   --dump                  print words-only results as JSON lines (for the TS parity check)
//!
//! Metrics: hit@1 (a right record comes first), MRR@5, and per-question latency.

use std::{
    collections::HashMap,
    path::PathBuf,
    time::{Duration, Instant},
};

use serde::Deserialize;
use vaultkey_search::{
    Index, Models, Options, Params,
    model::{self, ARCTIC_S, BGE_SMALL, Embedder, Reranker},
    search,
    vault::Vault,
};

#[derive(Deserialize)]
struct Gold {
    questions: Vec<Question>,
}

#[derive(Deserialize)]
struct Question {
    q: String,
    kind: String,
    expect: Vec<String>,
}

struct Outcome {
    rank: Option<usize>,
    top: Vec<String>,
    took: Duration,
}

fn set(params: &mut Params, assignment: &str) {
    let (name, value) = assignment.split_once('=').expect("--set name=value");
    let f: f64 = value.parse().expect("a number");
    match name {
        "z_min" => params.z_min = f as f32,
        "keep_within" => params.keep_within = f as f32,
        "max_meaning" => params.max_meaning = f as usize,
        "meaning_quality" => params.meaning_quality = f,
        "strong_word" => params.strong_word = f,
        "rrf_k" => params.rrf_k = f,
        "intent_min" => params.intent_min = Some(f as f32),
        "rerank_top" => params.rerank_top = f as usize,
        "rerank_weight" => params.rerank_weight = f,
        "query_weight" => params.query_weight = f,
        _ => panic!("unknown param {name}"),
    }
}

fn main() -> model::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let flag = |name: &str| args.iter().any(|a| a == name);
    let split = arg("--split").unwrap_or_else(|| "dev".into());
    let threads: usize = arg("--threads").map_or(2, |t| t.parse().unwrap());
    let spec = if arg("--embedder").as_deref() == Some("bge") { BGE_SMALL } else { ARCTIC_S };
    let mut params = Params::default();
    for (i, a) in args.iter().enumerate() {
        if a == "--set" {
            set(&mut params, &args[i + 1]);
        }
    }

    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let vault: Vault = serde_json::from_str(&std::fs::read_to_string(root.join("fixtures/demo-vault.json"))?)?;
    let gold: Gold = serde_json::from_str(&std::fs::read_to_string(root.join("fixtures/demo-questions.json"))?)?;
    let mut index = Index::new(&vault);

    if flag("--dump") {
        let opts = Options { meaning: false, rerank: false, ..Options::default() };
        for q in &gold.questions {
            let (response, _) = search(&index, &q.q, None, &opts)?;
            let hits: Vec<_> = response
                .hits
                .iter()
                .take(10)
                .map(|h| serde_json::json!([h.node.id, h.answer, (h.score * 1000.0).round() / 1000.0]))
                .collect();
            println!("{}", serde_json::json!({ "q": q.q, "understood": response.understood, "hits": hits }));
        }
        return Ok(());
    }

    let dir = root.join("../models");
    let env = model::environment()?;
    let t = Instant::now();
    let mut embedder = Embedder::load(&env, &dir, spec.clone(), threads)?;
    let mut reranker = Reranker::load(&env, &dir, threads)?;
    let load = t.elapsed();
    let t = Instant::now();
    index.embed(&mut embedder)?;
    println!(
        "{} nodes · {} · models loaded in {load:.0?} · vault embedded in {:.0?} · {threads} threads",
        index.graph.len(),
        spec.name,
        t.elapsed()
    );
    println!("{params:?}\n");

    if let Some(phrases) = arg("--probe") {
        for phrase in phrases.split('|') {
            let (nodes, intents) = vaultkey_search::engine::probe(&index, &mut embedder, phrase, 6)?;
            println!("{phrase:?}");
            for (id, s, z) in nodes {
                println!("    {s:.3}  z {z:4.1}  {id}");
            }
            let intents: Vec<String> = intents.iter().map(|(l, s)| format!("{l} {s:.3}")).collect();
            println!("    intents: {}", intents.join(" · "));
        }
        return Ok(());
    }

    if let Some(question) = arg("--q") {
        for (name, meaning, rerank) in [("words", false, false), ("meaning", true, false), ("full", true, true)] {
            let opts = Options { meaning, rerank, params: params.clone(), ..Options::default() };
            let (r, timing) = search(&index, &question, Some(Models { embedder: &mut embedder, reranker: Some(&mut reranker) }), &opts)?;
            let u = &r.understood;
            let wants: Vec<String> = u.wants.iter().map(|w| format!("{} ({})", w.label, w.words.join(" "))).collect();
            let anchors: Vec<String> = u
                .anchors
                .iter()
                .map(|a| format!("{:?} → {}", a.words, a.nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>().join(", ")))
                .collect();
            println!("{name}: wants [{}] anchors [{}] unmatched {:?} ({:.1?})", wants.join("; "), anchors.join("; "), u.unmatched, timing.total);
            for h in r.hits.iter().take(5) {
                let path: Vec<String> = h.path.iter().map(|s| format!("{}{}", s.via.map_or(String::new(), |v| format!("-{v}→ ")), s.node.id)).collect();
                println!("    {:.3} {} {}", h.score, if h.answer { "A" } else { " " }, path.join(" "));
            }
            if name == "meaning" && flag("--texts") {
                let texts: Vec<String> = r.hits.iter().take(8).map(|h| vaultkey_search::engine::rerank_text(&index, h)).collect();
                let logits = reranker.score(&question, &texts)?;
                for (t, l) in texts.iter().zip(logits) {
                    println!("      rerank {l:6.2}  {t}");
                }
            }
        }
        return Ok(());
    }

    let configs: Vec<(&str, bool, bool)> = [("words", false, false), ("meaning", true, false), ("full", true, true)]
        .into_iter()
        .filter(|(name, ..)| arg("--only").is_none_or(|o| o == *name))
        .collect();
    let mut summary = Vec::new();
    for (name, meaning, rerank) in configs {
        let opts = Options { meaning, rerank, params: params.clone(), ..Options::default() };
        // Warm-up: the first runs pay for allocations inside ONNX Runtime.
        for q in gold.questions.iter().take(3) {
            search(&index, &q.q, Some(Models { embedder: &mut embedder, reranker: Some(&mut reranker) }), &opts)?;
        }
        let mut outcomes = Vec::new();
        for q in &gold.questions {
            let t = Instant::now();
            let (response, _) = search(&index, &q.q, Some(Models { embedder: &mut embedder, reranker: Some(&mut reranker) }), &opts)?;
            let took = t.elapsed();
            let ids: Vec<String> = response.hits.iter().map(|h| h.node.id.clone()).collect();
            let rank = ids.iter().position(|id| q.expect.contains(id));
            outcomes.push(Outcome { rank, top: ids.into_iter().take(3).collect(), took });
        }
        summary.push((name, outcomes));
    }

    let in_split = |i: usize, s: &str| match s {
        "dev" => i % 2 == 0,
        "held" => i % 2 == 1,
        _ => true,
    };
    println!("{:<10} {:>13} {:>13} {:>9} {:>9} {:>9} {:>9}", "config", "hit@1 dev", "hit@1 held", "MRR dev", "MRR held", "p50", "p95");
    for (name, outcomes) in &summary {
        let hit = |s: &str| {
            let (n, ok) = outcomes.iter().enumerate().filter(|(i, _)| in_split(*i, s)).fold((0, 0), |(n, ok), (_, o)| (n + 1, ok + usize::from(o.rank == Some(0))));
            format!("{ok}/{n} {:>3.0}%", 100.0 * ok as f64 / n as f64)
        };
        let mrr = |s: &str| {
            let picked: Vec<&Outcome> = outcomes.iter().enumerate().filter(|(i, _)| in_split(*i, s)).map(|(_, o)| o).collect();
            picked.iter().map(|o| o.rank.filter(|&r| r < 5).map_or(0.0, |r| 1.0 / (r + 1) as f64)).sum::<f64>() / picked.len() as f64
        };
        let mut times: Vec<Duration> = outcomes.iter().map(|o| o.took).collect();
        times.sort();
        let pct = |p: f64| times[((times.len() as f64 * p) as usize).min(times.len() - 1)];
        println!("{name:<10} {:>13} {:>13} {:>9.3} {:>9.3} {:>9.1?} {:>9.1?}", hit("dev"), hit("held"), mrr("dev"), mrr("held"), pct(0.5), pct(0.95));
    }

    // Per kind of question, for the last configuration.
    if let Some((name, outcomes)) = summary.last() {
        let mut kinds: HashMap<&str, (usize, usize)> = HashMap::new();
        for (q, o) in gold.questions.iter().zip(outcomes) {
            let e = kinds.entry(q.kind.as_str()).or_default();
            e.0 += 1;
            e.1 += usize::from(o.rank == Some(0));
        }
        let mut kinds: Vec<_> = kinds.into_iter().collect();
        kinds.sort();
        println!("\nhit@1 by kind ({name}, all splits):");
        for (kind, (n, ok)) in kinds {
            println!("  {kind:<12} {ok}/{n}");
        }
    }

    println!("\nmisses ({split} split):");
    for (i, q) in gold.questions.iter().enumerate() {
        if !in_split(i, &split) {
            continue;
        }
        let marks: Vec<String> = summary
            .iter()
            .map(|(name, o)| match o[i].rank {
                Some(0) => format!("{name}:✓"),
                Some(r) => format!("{name}:#{}", r + 1),
                None => format!("{name}:✗"),
            })
            .collect();
        let last = &summary.last().unwrap().1[i];
        if last.rank != Some(0) {
            println!("  {:<46} {}  top: {}", format!("{:?}", q.q), marks.join(" "), last.top.join(", "));
        }
    }
    Ok(())
}
