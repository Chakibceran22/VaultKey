//! The search (docs/graph-search.md):
//!
//!   1. Read the question: filler dropped, what is asked for picked out ("device",
//!      "passkey"), by its words or, failing that, by its meaning ("how do I log in").
//!   2. Anchors: the records the remaining words name, by spelling (exact, prefix,
//!      typo; two words may be one name), and by meaning for words that name nothing
//!      ("shop" → Acme Store), the two fused by reciprocal rank.
//!   3. Walk the links out from the anchors, weaker at each hop, damped through busy
//!      records, preferring what every name leads to.
//!   4. Rank: the kind asked for first; then a cross-encoder judges the best
//!      candidates, each written out with the path that explains it.
//!
//! With meaning and the reranker off, steps 1–4 are `src/lib/search/engine.ts` exactly.

use std::time::{Duration, Instant};

use crate::{
    graph::{self, Graph},
    intents::{BY_WORD, INTENTS, Intent, is_filler, is_stopword},
    model::{self, Embedder, Reranker, dot},
    text::{quality, squash, words},
    types::{AnchorWords, NodeKind, PathStep, SearchHit, SearchNode, SearchResponse, Understood, Want},
    vault::Vault,
};

const DECAY: f64 = 0.7;
const MAX_HOPS: usize = 4;
const MIN_QUALITY: f64 = 0.45;

/// The knobs the gold set tunes.
#[derive(Clone, Debug)]
pub struct Params {
    /// A record is a meaning match only this many standard deviations above the vault's
    /// typical similarity to the phrase: "usthb" means nothing, and then nothing matches.
    pub z_min: f32,
    /// ...and within this much similarity of the best match.
    pub keep_within: f32,
    pub max_meaning: usize,
    /// The best meaning match counts like a word match of this quality.
    pub meaning_quality: f64,
    /// Word matches below this also get meaning, fused with them.
    pub strong_word: f64,
    /// Reciprocal rank fusion constant.
    pub rrf_k: f64,
    /// Overrides the embedder's own intent threshold (for tuning).
    pub intent_min: Option<f32>,
    /// How many of the best candidates the reranker reads.
    pub rerank_top: usize,
    /// Final score = this × reranker + the rest × walk.
    pub rerank_weight: f64,
    /// Final score = this × the whole question's closeness to the record + the rest × walk.
    pub query_weight: f64,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            z_min: 2.5,
            keep_within: 0.08,
            max_meaning: 5,
            meaning_quality: 0.8,
            strong_word: 0.8,
            rrf_k: 3.0,
            intent_min: None,
            rerank_top: 15,
            rerank_weight: 0.6,
            // No measurable gain on the dev questions; costs a second embedding.
            query_weight: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Options {
    pub limit: usize,
    pub meaning: bool,
    pub rerank: bool,
    pub params: Params,
}

impl Default for Options {
    fn default() -> Self {
        // The reranker is off: on the demo questions it lost accuracy on the held-out
        // split and cost ~80 ms per search (see eval.rs). Kept for re-testing on real ones.
        Self { limit: 40, meaning: true, rerank: false, params: Params::default() }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Timing {
    pub embed: Duration,
    pub rerank: Duration,
    pub total: Duration,
}

pub struct Models<'a> {
    pub embedder: &'a mut Embedder,
    pub reranker: Option<&'a mut Reranker>,
}

/// The graph, and (once embedded) a unit vector per record and per intent phrasing.
pub struct Index {
    pub graph: Graph,
    meaning: Option<Meaning>,
}

struct Meaning {
    dim: usize,
    intent_min: f32,
    nodes: Vec<f32>,
    examples: Vec<f32>,
    example_intent: Vec<usize>,
}

impl Index {
    pub fn new(vault: &Vault) -> Self {
        Self { graph: graph::build(vault), meaning: None }
    }

    /// Embeds every record's sentence and every intent phrasing.
    pub fn embed(&mut self, embedder: &mut Embedder) -> model::Result<()> {
        let texts: Vec<String> = self.graph.nodes.iter().map(|n| n.text.clone()).collect();
        let nodes = embedder.embed_documents(&texts)?;
        let mut example_intent = Vec::new();
        let mut phrasings = Vec::new();
        for (i, intent) in INTENTS.iter().enumerate() {
            for example in intent.examples {
                example_intent.push(i);
                phrasings.push((*example).to_owned());
            }
        }
        // Compared with the rest of a question, symmetrically: both without the prefix.
        let examples = embedder.embed_texts(&phrasings)?;
        self.meaning = Some(Meaning { dim: embedder.dim(), intent_min: embedder.intent_min(), nodes, examples, example_intent });
        Ok(())
    }

    pub fn node_vector(&self, i: usize) -> Option<&[f32]> {
        self.meaning.as_ref().map(|m| &m.nodes[i * m.dim..(i + 1) * m.dim])
    }
}

#[derive(Clone, Copy, Debug)]
struct Reach {
    score: f64,
    parent: Option<usize>,
    via: Option<&'static str>,
}

/// Reach per node, remembering first-insertion order (a JS Map's iteration order).
struct Reaches {
    at: Vec<Option<Reach>>,
    order: Vec<usize>,
}

impl Reaches {
    fn new(n: usize) -> Self {
        Self { at: vec![None; n], order: Vec::new() }
    }
    fn score(&self, i: usize) -> f64 {
        self.at[i].map_or(0.0, |r| r.score)
    }
    fn set(&mut self, i: usize, reach: Reach) {
        if self.at[i].is_none() {
            self.order.push(i);
        }
        self.at[i] = Some(reach);
    }
}

#[derive(Clone, Debug)]
struct Wanted {
    intent: usize,
    words: Vec<String>,
}

#[derive(Clone, Debug)]
struct Anchor {
    words: String,
    found: Vec<(usize, f64)>,
}

fn intent(i: usize) -> &'static Intent {
    &INTENTS[i]
}

/// The question split into what is wanted, and names to find.
fn read(query: &str) -> (Vec<Wanted>, Vec<String>) {
    let list: Vec<String> = words(query).into_iter().filter(|w| !is_filler(w)).collect();
    let (mut wanted, mut names) = (Vec::<Wanted>::new(), Vec::new());
    let mut i = 0;
    while i < list.len() {
        let pair_hit = list.get(i + 1).and_then(|next| BY_WORD.get(format!("{}{next}", list[i]).as_str()).copied());
        let hit = pair_hit.or_else(|| BY_WORD.get(list[i].as_str()).copied());
        if let Some(found) = hit {
            let used = if pair_hit.is_some() {
                i += 1;
                vec![list[i - 1].clone(), list[i].clone()]
            } else {
                vec![list[i].clone()]
            };
            match wanted.iter_mut().find(|w| w.intent == found) {
                Some(w) => w.words.extend(used),
                None => wanted.push(Wanted { intent: found, words: used }),
            }
        } else {
            names.push(list[i].clone());
        }
        i += 1;
    }
    (wanted, names)
}

fn match_word(graph: &Graph, word: &str) -> Vec<(usize, f64)> {
    let mut found: Vec<(usize, f64)> = graph
        .nodes
        .iter()
        .enumerate()
        .filter_map(|(i, node)| {
            let best = node.terms.iter().map(|t| quality(word, &t.text) * t.weight).fold(0.0, f64::max);
            (best >= MIN_QUALITY).then_some((i, best))
        })
        .collect();
    found.sort_by(|a, b| b.1.total_cmp(&a.1));
    found.truncate(8);
    found
}

/// Spelled exactly as some record's name, username, email or address (not only its
/// description or notes).
fn exact_name(graph: &Graph, word: &str) -> bool {
    graph.nodes.iter().any(|n| n.terms.iter().any(|t| t.weight >= 0.6 && t.text == word))
}

/// Spreads out from the matched records. Groups are only ever a start or an end, and
/// busy records (a phone half the vault uses) pass on less.
fn spread(graph: &Graph, starts: &[(usize, f64)]) -> Reaches {
    let mut reach = Reaches::new(graph.len());
    let mut frontier = Vec::new();
    for &(node, q) in starts {
        if reach.score(node) < q {
            reach.set(node, Reach { score: q, parent: None, via: None });
        }
        frontier.push(node);
    }
    for _ in 0..MAX_HOPS {
        if frontier.is_empty() {
            break;
        }
        let mut next = Vec::new();
        for &id in &frontier {
            let from = reach.at[id].expect("frontier nodes are reached");
            if graph.nodes[id].node.kind == NodeKind::Group && from.parent.is_some() {
                continue;
            }
            let out = &graph.edges[id];
            let busy = if out.len() > 4 { 4.0 / out.len() as f64 } else { 1.0 };
            for edge in out {
                let score = from.score * DECAY * busy;
                if score > reach.score(edge.to) + 1e-9 {
                    reach.set(edge.to, Reach { score, parent: Some(id), via: Some(edge.via) });
                    next.push(edge.to);
                }
            }
        }
        frontier = next;
    }
    reach
}

fn path_to(reach: &Reaches, id: usize) -> Vec<(usize, Option<&'static str>)> {
    let mut steps = Vec::new();
    let mut at = Some(id);
    while let Some(i) = at {
        let r = reach.at[i].expect("paths follow reached nodes");
        steps.push((i, r.via));
        at = r.parent;
    }
    steps.reverse();
    steps
}

/// The record is what the intent asks for (and, for a relation, reached through it).
fn fits(node: &SearchNode, intent: &Intent, reached_via: Option<&str>) -> bool {
    if !intent.kinds.contains(&node.kind) {
        return false;
    }
    if let (Some(detail), Some(d)) = (intent.detail, node.detail.as_deref()) {
        if !detail.contains(&d) {
            return false;
        }
    }
    match intent.via {
        None => true,
        Some(via) => reached_via.is_some_and(|r| via.contains(&r)),
    }
}

fn plain(graph: &Graph, i: usize) -> SearchNode {
    graph.nodes[i].node.clone()
}

/// Similarity of a phrase vector to every record: the records that stand out, best
/// first, each with its quality as an anchor.
fn meaning_matches(index: &Index, phrase: &[f32], p: &Params) -> Vec<(usize, f64)> {
    let m = index.meaning.as_ref().expect("embedded");
    let n = index.graph.len();
    if n < 3 {
        return Vec::new();
    }
    let sims: Vec<f32> = (0..n).map(|i| dot(phrase, &m.nodes[i * m.dim..(i + 1) * m.dim])).collect();
    let mean = sims.iter().sum::<f32>() / n as f32;
    let sd = (sims.iter().map(|s| (s - mean).powi(2)).sum::<f32>() / n as f32).sqrt().max(1e-6);
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| sims[b].total_cmp(&sims[a]));
    let best = sims[order[0]];
    let z_best = (best - mean) / sd;
    if z_best < p.z_min {
        return Vec::new();
    }
    order
        .into_iter()
        .take(p.max_meaning)
        .filter(|&i| {
            let z = (sims[i] - mean) / sd;
            z >= p.z_min && sims[i] >= best - p.keep_within
        })
        .map(|i| (i, p.meaning_quality * f64::from((sims[i] - mean) / sd / z_best)))
        .collect()
}

/// Reciprocal rank fusion of ranked lists; qualities scaled so the fused best keeps
/// the best quality either list had.
fn fuse(lists: &[&[(usize, f64)]], k: f64) -> Vec<(usize, f64)> {
    let mut score: Vec<(usize, f64)> = Vec::new();
    for list in lists {
        for (rank, &(node, _)) in list.iter().enumerate() {
            let add = 1.0 / (k + rank as f64 + 1.0);
            match score.iter_mut().find(|(n, _)| *n == node) {
                Some((_, s)) => *s += add,
                None => score.push((node, add)),
            }
        }
    }
    score.sort_by(|a, b| b.1.total_cmp(&a.1));
    let top_quality = lists.iter().flat_map(|l| l.first()).map(|&(_, q)| q).fold(0.0, f64::max);
    let best = score.first().map_or(1.0, |&(_, s)| s);
    score.into_iter().take(8).map(|(n, s)| (n, top_quality * s / best)).collect()
}

/// A candidate written out for the reranker: what it is, then the path back to the
/// record the question named, worded from the candidate's side ("spotify.com signs in
/// with apple.com", not "apple.com used to sign in to spotify.com"): questions are
/// phrased about what they ask for, and the cross-encoder reads words, not structure.
fn describe(graph: &Graph, hit: &SearchHit) -> String {
    let mut text = graph.find(&hit.node.id).map_or_else(|| hit.node.title.clone(), |i| graph.nodes[i].text.clone());
    let ids: Vec<usize> = hit.path.iter().filter_map(|s| graph.find(&s.node.id)).collect();
    if ids.len() > 1 {
        text.push_str(". ");
        text.push_str(&graph.nodes[ids[ids.len() - 1]].node.title);
        for k in (1..ids.len()).rev() {
            let (here, before) = (ids[k], ids[k - 1]);
            let via = graph.edges[here].iter().find(|e| e.to == before).map_or("linked to", |e| e.via);
            if k < ids.len() - 1 {
                text.push(',');
            }
            text.push(' ');
            text.push_str(via);
            text.push(' ');
            text.push_str(&graph.nodes[before].node.title);
        }
    }
    text
}

pub fn search(index: &Index, query: &str, models: Option<Models<'_>>, opts: &Options) -> model::Result<(SearchResponse, Timing)> {
    let started = Instant::now();
    let mut timing = Timing::default();
    let graph = &index.graph;
    let p = &opts.params;
    let (mut wanted, names) = read(query);

    // Names, two words at a time first: "auto transfert" → autotransfert.
    let mut anchors: Vec<Anchor> = Vec::new();
    // Per name: the anchor it belongs to, if any, and whether it is spelled exactly as a
    // record's name (not a prefix or a typo: "log" is not "logo.png").
    let mut name_anchor: Vec<Option<usize>> = vec![None; names.len()];
    let mut exact = vec![false; names.len()];
    // A precise word that asks for a kind can also be a name: "yubikey" is the YubiKey
    // too, when nothing else in the question is ("recovery codes for google" is not
    // about the note "Recovery phrase").
    let mut soft: Vec<Anchor> = Vec::new();
    for w in &wanted {
        if intent(w.intent).weight < 3 || w.words.len() != 1 {
            continue;
        }
        let found: Vec<_> = match_word(graph, &w.words[0]).into_iter().filter(|f| f.1 >= 0.85).collect();
        if !found.is_empty() {
            soft.push(Anchor { words: w.words[0].clone(), found });
        }
    }
    let mut i = 0;
    while i < names.len() {
        if let Some(next) = names.get(i + 1) {
            let joined = format!("{}{next}", names[i]);
            let pair: Vec<_> = match_word(graph, &joined).into_iter().filter(|f| f.1 >= 0.8).collect();
            if !pair.is_empty() {
                anchors.push(Anchor { words: format!("{} {next}", names[i]), found: pair });
                let is_exact = exact_name(graph, &joined);
                for k in [i, i + 1] {
                    name_anchor[k] = Some(anchors.len() - 1);
                    exact[k] = is_exact;
                }
                i += 2;
                continue;
            }
        }
        let found = match_word(graph, &names[i]);
        if !found.is_empty() {
            anchors.push(Anchor { words: names[i].clone(), found });
            name_anchor[i] = Some(anchors.len() - 1);
            exact[i] = exact_name(graph, &names[i]);
        }
        i += 1;
    }

    // Meaning: what the words that are not exact names ask for, and what they name.
    let mut meaning_used = vec![false; names.len()];
    let mut question_vector: Option<Vec<f32>> = None;
    let mut models = models;
    if opts.meaning
        && index.meaning.is_some()
        && let Some(m) = models.as_mut()
    {
        let weak = |i: usize| match name_anchor[i] {
            None => true,
            Some(a) => anchors[a].found.first().is_none_or(|f| f.1 < p.strong_word),
        };
        // Runs of consecutive loose names: "music streaming".
        let mut runs: Vec<Vec<usize>> = Vec::new();
        for i in (0..names.len()).filter(|&i| weak(i)) {
            match runs.last_mut() {
                Some(run) if run.last() == Some(&(i.wrapping_sub(1))) => run.push(i),
                _ => runs.push(vec![i]),
            }
        }
        // The question without its exact names and asked-for words, filler kept:
        // "how do i log in to binance" → "how do i log in to".
        let named: Vec<&str> = (0..names.len()).filter(|&i| exact[i]).map(|i| names[i].as_str()).collect();
        let asked: Vec<&str> = wanted.iter().flat_map(|w| w.words.iter().map(String::as_str)).collect();
        let rest: Vec<String> = words(query).into_iter().filter(|w| !named.contains(&w.as_str()) && !asked.contains(&w.as_str())).collect();
        let asks = rest.iter().any(|w| !is_filler(w) && !is_stopword(w));
        let whole = p.query_weight > 0.0;
        if asks || !runs.is_empty() || whole {
            let prefix = m.embedder.query_prefix();
            let mut batch = vec![rest.join(" ")];
            batch.extend(runs.iter().map(|run| format!("{prefix}{}", run.iter().map(|&i| names[i].as_str()).collect::<Vec<_>>().join(" "))));
            if whole {
                batch.push(format!("{prefix}{query}"));
            }
            let t = Instant::now();
            let vectors = m.embedder.embed_texts(&batch)?;
            timing.embed = t.elapsed();
            let meaning = index.meaning.as_ref().expect("checked above");
            let dim = meaning.dim;
            if whole {
                question_vector = Some(vectors[(runs.len() + 1) * dim..(runs.len() + 2) * dim].to_vec());
            }

            // Is the rest of the question a way of asking for something?
            let mut best: Option<(usize, f32)> = None;
            if asks {
                for (e, &intent_index) in meaning.example_intent.iter().enumerate() {
                    let s = dot(&vectors[..dim], &meaning.examples[e * dim..(e + 1) * dim]);
                    if best.is_none_or(|(_, b)| s > b) {
                        best = Some((intent_index, s));
                    }
                }
            }
            let mut runs_left: Vec<usize> = (0..runs.len()).collect();
            if let Some((found, s)) = best
                && s >= p.intent_min.unwrap_or(meaning.intent_min)
                && !wanted.iter().any(|w| w.intent == found)
            {
                // The words that were not exact names were the asking ("log", "depends").
                let used: Vec<String> = (0..names.len()).filter(|&i| !exact[i]).map(|i| names[i].clone()).collect();
                for i in (0..names.len()).filter(|&i| !exact[i]) {
                    if let Some(a) = name_anchor[i].take() {
                        anchors[a].found.clear();
                    }
                    meaning_used[i] = true;
                }
                runs_left.clear();
                wanted.push(Wanted { intent: found, words: used });
            }

            // Each remaining run: records near it in meaning, fused with its loose word matches.
            for r in runs_left {
                let run = &runs[r];
                let by_meaning = meaning_matches(index, &vectors[(r + 1) * dim..(r + 2) * dim], p);
                if by_meaning.is_empty() {
                    continue;
                }
                let mut by_words: Vec<(usize, f64)> = Vec::new();
                for a in run.iter().filter_map(|&i| name_anchor[i]) {
                    for &(node, q) in &anchors[a].found {
                        if !by_words.iter().any(|(n, _)| *n == node) {
                            by_words.push((node, q));
                        }
                    }
                }
                by_words.sort_by(|a, b| b.1.total_cmp(&a.1));
                let found = if by_words.is_empty() { by_meaning } else { fuse(&[&by_words, &by_meaning], p.rrf_k) };
                // The fused anchor replaces the loose word anchors of its names.
                for a in run.iter().filter_map(|&i| name_anchor[i]) {
                    anchors[a].found.clear();
                }
                let phrase: Vec<&str> = run.iter().map(|&i| names[i].as_str()).collect();
                anchors.push(Anchor { words: phrase.join(" "), found });
                for &i in run {
                    meaning_used[i] = true;
                    name_anchor[i] = Some(anchors.len() - 1);
                }
            }
            anchors.retain(|a| !a.found.is_empty());
        }
    }
    if anchors.is_empty() {
        anchors = soft;
    }
    let unmatched: Vec<String> =
        names.iter().enumerate().filter(|(i, _)| name_anchor[*i].is_none() && !meaning_used[*i]).map(|(_, n)| n.clone()).collect();

    // The most precise of the wanted kinds are the answer; the others only qualify it.
    let top = wanted.iter().map(|w| intent(w.intent).weight).max().unwrap_or(0);
    let answers: Vec<&Intent> = wanted.iter().filter(|w| intent(w.intent).weight == top).map(|w| intent(w.intent)).collect();
    let qualifiers: Vec<&Intent> = wanted.iter().filter(|w| intent(w.intent).weight < top).map(|w| intent(w.intent)).collect();

    let understood = Understood {
        wants: wanted.iter().map(|w| Want { label: intent(w.intent).label, words: w.words.clone() }).collect(),
        anchors: anchors
            .iter()
            .map(|a| AnchorWords { words: a.words.clone(), nodes: a.found.iter().take(3).map(|&(n, _)| plain(graph, n)).collect() })
            .collect(),
        unmatched: unmatched.clone(),
    };

    let mut hits: Vec<SearchHit> = Vec::new();
    if anchors.is_empty() && !answers.is_empty() {
        // "passkeys", "devices": everything of that kind.
        for i in 0..graph.len() {
            let node = &graph.nodes[i].node;
            if answers.iter().any(|a| a.via.is_none() && fits(node, a, None)) {
                hits.push(SearchHit { node: node.clone(), score: 0.5, path: vec![PathStep { node: node.clone(), via: None }], answer: true });
            }
        }
        let mut order: Vec<usize> = (0..hits.len()).collect();
        order.sort_by(|&a, &b| hits[a].node.title.to_lowercase().cmp(&hits[b].node.title.to_lowercase()));
        hits = order.iter().map(|&i| hits[i].clone()).collect();
    } else if !anchors.is_empty() {
        let reaches: Vec<Reaches> = anchors.iter().map(|a| spread(graph, &a.found)).collect();
        let mut seen = vec![false; graph.len()];
        let mut candidates = Vec::new();
        for r in &reaches {
            for &id in &r.order {
                if !seen[id] {
                    seen[id] = true;
                    candidates.push(id);
                }
            }
        }
        let mut scored: Vec<(SearchHit, f64)> = Vec::new();
        for id in candidates {
            let scores: Vec<f64> = reaches.iter().map(|r| r.score(id)).collect();
            let covered = scores.iter().filter(|&&s| s > 0.0).count() as f64 / anchors.len() as f64;
            let mut score = scores.iter().sum::<f64>() / anchors.len() as f64 * covered * covered;
            let node = &graph.nodes[id].node;
            // Explain it from the farthest name it was reached from.
            let mut from: Vec<(usize, usize, f64)> = reaches
                .iter()
                .enumerate()
                .filter(|(i, _)| scores[*i] > 0.0)
                .map(|(i, r)| (i, path_to(r, id).len(), scores[i]))
                .collect();
            from.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.total_cmp(&a.2)));
            let raw_path = path_to(&reaches[from[0].0], id);
            let path: Vec<PathStep> = raw_path.iter().map(|&(n, via)| PathStep { node: plain(graph, n), via }).collect();
            let reached_via = path.last().and_then(|s| s.via);
            // A record whose whole name was typed comes first, even typed in two
            // words ("lumen post" is the project Lumenpost, before coolify.lumenpost.io).
            if words(&node.title).join(" ") == names.join(" ") || (!names.is_empty() && squash(&node.title) == names.concat()) {
                score += 0.15;
            }
            let mut answer = false;
            if !answers.is_empty() {
                let fitting = answers.iter().find(|a| fits(node, a, reached_via));
                answer = fitting.is_some();
                if let Some(f) = fitting {
                    let rank = f.kinds.iter().position(|k| *k == node.kind).unwrap_or(0);
                    score *= 1.0 - 0.1 * rank as f64;
                } else {
                    score *= if answers.iter().any(|a| a.kinds.contains(&node.kind)) { 0.5 } else { 0.3 };
                }
                if qualifiers.iter().any(|q| path[..path.len() - 1].iter().any(|step| fits(&step.node, q, step.via))) {
                    score *= 1.3;
                }
            }
            if score >= 0.05 {
                scored.push((SearchHit { node: node.clone(), score: score as f32, path, answer }, score));
            }
        }
        scored.sort_by(|a, b| b.0.answer.cmp(&a.0.answer).then(b.1.total_cmp(&a.1)));
        let max = scored.iter().map(|s| s.1).fold(1.0, f64::max);
        for s in &mut scored {
            s.1 /= max;
            s.0.score = s.1 as f32;
        }
        if answers.is_empty() {
            // Nothing asked for in particular: the strongest ones are the answer.
            let best = scored.first().map_or(0.0, |s| s.1);
            for s in &mut scored {
                s.0.answer = s.1 >= best * 0.6;
            }
        }
        hits.extend(scored.into_iter().map(|(hit, _)| hit));
    }
    if hits.is_empty() && !unmatched.is_empty() {
        // Nothing understood: plain text, so typing an email still finds it.
        let text = query.trim().to_lowercase();
        for i in 0..graph.len() {
            let node = &graph.nodes[i].node;
            if format!("{} {}", node.title, node.subtitle).to_lowercase().contains(&text) {
                hits.push(SearchHit { node: node.clone(), score: 0.4, path: vec![PathStep { node: node.clone(), via: None }], answer: true });
            }
        }
    }

    // The whole question's closeness to each record, against the vault's typical closeness.
    if let (Some(q), Some(meaning)) = (&question_vector, &index.meaning)
        && hits.len() > 1
    {
        let dim = meaning.dim;
        let sims: Vec<f32> = (0..graph.len()).map(|i| dot(q, &meaning.nodes[i * dim..(i + 1) * dim])).collect();
        let n = sims.len() as f32;
        let mean = sims.iter().sum::<f32>() / n;
        let sd = (sims.iter().map(|s| (s - mean).powi(2)).sum::<f32>() / n).sqrt().max(1e-6);
        let w = p.query_weight;
        for hit in &mut hits {
            let close = graph.find(&hit.node.id).map_or(0.0, |i| f64::from(((sims[i] - mean) / sd / 4.0).clamp(0.0, 1.0)));
            hit.score = ((1.0 - w) * f64::from(hit.score) + w * close) as f32;
        }
        hits.sort_by(|a, b| b.answer.cmp(&a.answer).then(b.score.total_cmp(&a.score)));
        let max = hits.iter().map(|h| h.score).fold(f32::MIN_POSITIVE, f32::max);
        hits.iter_mut().for_each(|h| h.score /= max);
        if answers.is_empty() {
            hits.sort_by(|a, b| b.score.total_cmp(&a.score));
            hits.iter_mut().for_each(|h| h.answer = h.score >= 0.6);
        }
    }

    // Rerank the best candidates, each read with its path.
    if opts.rerank
        && hits.len() > 1
        && let Some(reranker) = models.as_mut().and_then(|m| m.reranker.as_mut())
    {
        let n = p.rerank_top.min(hits.len());
        let texts: Vec<String> = hits[..n].iter().map(|h| describe(graph, h)).collect();
        let t = Instant::now();
        let logits = reranker.score(query, &texts)?;
        timing.rerank = t.elapsed();
        let w = p.rerank_weight;
        for (i, hit) in hits.iter_mut().enumerate() {
            let walk = f64::from(hit.score);
            let judged = logits.get(i).map(|&l| 1.0 / (1.0 + (-f64::from(l)).exp()));
            hit.score = match judged {
                Some(r) => (w * r + (1.0 - w) * walk) as f32,
                None => ((1.0 - w) * walk) as f32,
            };
        }
        hits.sort_by(|a, b| b.answer.cmp(&a.answer).then(b.score.total_cmp(&a.score)));
        let max = hits.iter().map(|h| h.score).fold(f32::MIN_POSITIVE, f32::max);
        hits.iter_mut().for_each(|h| h.score /= max);
        if answers.is_empty() {
            // Nothing asked for in particular: the strongest, now judged, are the answer.
            hits.sort_by(|a, b| b.score.total_cmp(&a.score));
            hits.iter_mut().for_each(|h| h.answer = h.score >= 0.6);
        }
    }

    hits.truncate(opts.limit);
    timing.total = started.elapsed();
    Ok((SearchResponse { query: query.to_owned(), understood, hits }, timing))
}

/// What meaning sees in a phrase: the closest records (similarity, z-score) as an
/// anchor phrase, and the closest intents as the rest of a question. For tuning.
pub fn probe(index: &Index, embedder: &mut Embedder, phrase: &str, top: usize) -> model::Result<(Vec<(String, f32, f32)>, Vec<(&'static str, f32)>)> {
    let m = index.meaning.as_ref().ok_or("index not embedded")?;
    let v = embedder.embed_texts(&[format!("{}{phrase}", embedder.query_prefix()), phrase.to_owned()])?;
    let (anchor, rest) = (&v[..m.dim], &v[m.dim..]);
    let n = index.graph.len();
    let sims: Vec<f32> = (0..n).map(|i| dot(anchor, &m.nodes[i * m.dim..(i + 1) * m.dim])).collect();
    let mean = sims.iter().sum::<f32>() / n as f32;
    let sd = (sims.iter().map(|s| (s - mean).powi(2)).sum::<f32>() / n as f32).sqrt().max(1e-6);
    let mut nodes: Vec<(String, f32, f32)> = (0..n).map(|i| (index.graph.nodes[i].node.id.clone(), sims[i], (sims[i] - mean) / sd)).collect();
    nodes.sort_by(|a, b| b.1.total_cmp(&a.1));
    nodes.truncate(top);
    let mut intents: Vec<(&'static str, f32)> = Vec::new();
    for (e, &i) in m.example_intent.iter().enumerate() {
        let s = dot(rest, &m.examples[e * m.dim..(e + 1) * m.dim]);
        match intents.iter_mut().find(|(label, _)| *label == INTENTS[i].label) {
            Some((_, best)) => *best = best.max(s),
            None => intents.push((INTENTS[i].label, s)),
        }
    }
    intents.sort_by(|a, b| b.1.total_cmp(&a.1));
    intents.truncate(3);
    Ok((nodes, intents))
}

/// The text the reranker reads for a hit: the record, then the path that reaches it.
pub fn rerank_text(index: &Index, hit: &SearchHit) -> String {
    describe(&index.graph, hit)
}
