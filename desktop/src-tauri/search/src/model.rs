//! The two models, run with ONNX Runtime on the CPU.
//!
//! - [`Embedder`]: a sentence into a unit vector, so "hosting" lands near Coolify.
//! - [`Reranker`]: a cross-encoder that reads the question and a candidate together
//!   (with the path that leads to it) and says how well one answers the other.
//!
//! Both are BERT-sized (6–12 layers, 384 wide), int8, and share one WordPiece tokenizer.
//! Nothing here touches the network: the files are read from disk once.

use std::{borrow::Cow, path::Path};

use ort::{
    environment::Environment,
    session::{
        Session, SessionInputValue,
        builder::{AutoDevicePolicy, GraphOptimizationLevel},
    },
    value::Tensor,
};
use tokenizers::{Encoding, Tokenizer, TruncationParams, TruncationStrategy};

pub use crate::{Error, Result};

/// How a sequence of token vectors becomes one vector.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pooling {
    /// The first token ([CLS]): bge and arctic-embed.
    Cls,
    /// The mean over real tokens: e5, MiniLM sentence-transformers.
    Mean,
}

/// Which embedding model, and how it wants to be called.
#[derive(Clone, Debug)]
pub struct EmbedderSpec {
    pub name: &'static str,
    /// The ONNX file and its tokenizer, in the models directory.
    pub file: &'static str,
    pub tokenizer: &'static str,
    /// Prepended to questions: asymmetric retrieval models expect it.
    pub query_prefix: &'static str,
    /// Prepended to records ("passage: " for e5); usually nothing.
    pub doc_prefix: &'static str,
    pub pooling: Pooling,
    /// Which output to read; `None` for the first one.
    pub output: Option<&'static str>,
    /// How far above the vault's typical similarity a record must stand to be a meaning
    /// match (standard deviations). Tuned per model on the dev questions.
    pub z_min: f32,
    /// How far an intent's phrasing must stand above all phrasings (standard deviations)
    /// for the rest of a question to ask for it; models separate them more or less.
    /// Tuned per model on the dev questions.
    pub intent_z: f32,
}

/// bert-base-uncased WordPiece, shared by bge, arctic-embed and the MiniLM reranker.
pub const BERT_TOKENIZER: &str = "tokenizer.json";

pub const BGE_SMALL: EmbedderSpec = EmbedderSpec {
    name: "bge-small-en-v1.5",
    file: "bge-small-en-v1.5.onnx",
    tokenizer: BERT_TOKENIZER,
    query_prefix: "Represent this sentence for searching relevant passages: ",
    doc_prefix: "",
    pooling: Pooling::Cls,
    output: None,
    z_min: 2.5,
    intent_z: 2.5,
};

/// Ahead of bge-small on the demo questions.
pub const ARCTIC_S: EmbedderSpec = EmbedderSpec {
    name: "snowflake-arctic-embed-s",
    file: "snowflake-arctic-embed-s.onnx",
    tokenizer: BERT_TOKENIZER,
    query_prefix: "Represent this sentence for searching relevant passages: ",
    doc_prefix: "",
    pooling: Pooling::Cls,
    output: None,
    z_min: 2.5,
    intent_z: 2.0,
};

/// The embedder the app uses: English and small (34 MB, ~120 MB in memory, ~4 ms per
/// question). Names are matched by their spelling; meaning is only needed for what is
/// written about records (descriptions, roles, notes), which is English. Multilingual
/// models (EmbeddingGemma-2, arctic-embed v2) were measured too: better on brand and
/// French names, which aren't needed, at 700 MB to 1.7 GB of memory (docs/graph-search.md).
pub const DEFAULT_EMBEDDER: EmbedderSpec = ARCTIC_S;

/// Every embedder the eval knows, by name.
pub const EMBEDDERS: &[EmbedderSpec] = &[ARCTIC_S, BGE_SMALL];

pub fn embedder_spec(name: &str) -> Option<EmbedderSpec> {
    EMBEDDERS.iter().find(|spec| spec.name == name).cloned()
}

pub const RERANKER_FILE: &str = "ms-marco-MiniLM-L-6-v2.onnx";

/// Creates the ONNX Runtime environment every session hangs off. One per process.
pub fn environment() -> Result<Environment> {
    Ok(ort::init().with_name("vaultkey-search").build()?)
}

/// The builder's errors carry the builder (not `Send`); `?` here turns them into plain ones.
fn session(env: &Environment, model: &Path, threads: usize) -> ort::Result<Session> {
    Session::builder(env)?
        // CPU only. This ort's default picks "max efficiency", which on macOS hands parts of
        // the graph to CoreML: ~3x slower for these small models (5 ms instead of 15), and
        // it rejects some graphs. Same results on every platform this way.
        .with_auto_device(AutoDevicePolicy::PreferCPU)?
        .with_optimization_level(GraphOptimizationLevel::Level3)?
        .with_intra_threads(threads)?
        .with_inter_threads(1)?
        .commit_from_file(model)
}

/// A transformer encoder: tokens in, one output out. Only the inputs the model
/// declares are fed (some want `token_type_ids`, some `position_ids`).
struct Encoder {
    session: Session,
    tokenizer: Tokenizer,
    token_types: bool,
    positions: bool,
    /// The tokenizer's padding id (0 for BERT, 1 for XLM-R, …).
    pad: i64,
    output: Option<&'static str>,
}

impl Encoder {
    fn load(
        env: &Environment,
        model: &Path,
        tokenizer: &Path,
        max_tokens: usize,
        threads: usize,
        output: Option<&'static str>,
    ) -> Result<Self> {
        let mut tokenizer = Tokenizer::from_file(tokenizer)?;
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: max_tokens,
                strategy: TruncationStrategy::LongestFirst,
                ..Default::default()
            }))?
            .with_padding(None);
        let session = session(env, model, threads)?;
        let declares = |name: &str| session.inputs().iter().any(|input| input.name() == name);
        let (token_types, positions) = (declares("token_type_ids"), declares("position_ids"));
        let pad = ["<pad>", "[PAD]"]
            .iter()
            .find_map(|token| tokenizer.token_to_id(token))
            .map_or(0, i64::from);
        if let Some(name) = output {
            if !session.outputs().iter().any(|o| o.name() == name) {
                return Err(format!("{} has no output named {name}", model.display()).into());
            }
        }
        Ok(Self { session, tokenizer, token_types, positions, pad, output })
    }

    /// Runs one padded batch; returns the first output and its shape.
    fn run(&mut self, batch: &[Encoding]) -> Result<(Vec<usize>, Vec<f32>)> {
        let rows = batch.len();
        let width = batch.iter().map(|e| e.get_ids().len()).max().unwrap_or(0);
        let mut ids = vec![self.pad; rows * width];
        let mut mask = vec![0i64; rows * width];
        let mut types = vec![0i64; rows * width];
        for (row, encoding) in batch.iter().enumerate() {
            for (col, ((&id, &m), &t)) in encoding
                .get_ids()
                .iter()
                .zip(encoding.get_attention_mask())
                .zip(encoding.get_type_ids())
                .enumerate()
            {
                ids[row * width + col] = id as i64;
                mask[row * width + col] = m as i64;
                types[row * width + col] = t as i64;
            }
        }
        let shape = [rows, width];
        let positions: Vec<i64> = (0..rows).flat_map(|_| 0..width as i64).collect();
        let mut inputs: Vec<(Cow<'static, str>, SessionInputValue<'_>)> = vec![
            ("input_ids".into(), Tensor::from_array((shape, ids))?.into()),
            ("attention_mask".into(), Tensor::from_array((shape, mask))?.into()),
        ];
        if self.token_types {
            inputs.push(("token_type_ids".into(), Tensor::from_array((shape, types))?.into()));
        }
        if self.positions {
            inputs.push(("position_ids".into(), Tensor::from_array((shape, positions))?.into()));
        }
        let outputs = self.session.run(inputs)?;
        let value = match self.output {
            Some(name) => &outputs[name],
            None => &outputs[0],
        };
        let (out_shape, data) = value.try_extract_tensor::<f32>()?;
        Ok((out_shape.iter().map(|&d| d as usize).collect(), data.to_vec()))
    }
}

pub struct Embedder {
    encoder: Encoder,
    spec: EmbedderSpec,
    dim: usize,
}

impl Embedder {
    pub fn load(env: &Environment, dir: &Path, spec: EmbedderSpec, threads: usize) -> Result<Self> {
        // Records and questions are a line or two; 128 tokens is far more than either.
        let mut encoder = Encoder::load(env, &dir.join(spec.file), &dir.join(spec.tokenizer), 128, threads, spec.output)?;
        let probe = encoder.tokenizer.encode("probe", true)?;
        let (shape, _) = encoder.run(&[probe])?;
        let dim = *shape.last().ok_or("embedder returned no dimensions")?;
        Ok(Self { encoder, spec, dim })
    }

    pub fn dim(&self) -> usize {
        self.dim
    }

    pub fn query_prefix(&self) -> &'static str {
        self.spec.query_prefix
    }

    pub fn name(&self) -> &'static str {
        self.spec.name
    }

    pub fn z_min(&self) -> f32 {
        self.spec.z_min
    }

    pub fn intent_z(&self) -> f32 {
        self.spec.intent_z
    }

    /// Questions, with the model's query instruction. Row-major, one unit vector each.
    pub fn embed_queries(&mut self, texts: &[&str]) -> Result<Vec<f32>> {
        let prefixed: Vec<String> = texts.iter().map(|t| format!("{}{t}", self.spec.query_prefix)).collect();
        self.embed_texts(&prefixed)
    }

    /// Records, with the model's document prefix (if any). Row-major, one unit vector each.
    pub fn embed_documents(&mut self, texts: &[String]) -> Result<Vec<f32>> {
        if self.spec.doc_prefix.is_empty() {
            return self.embed_texts(texts);
        }
        let prefixed: Vec<String> = texts.iter().map(|t| format!("{}{t}", self.spec.doc_prefix)).collect();
        self.embed_texts(&prefixed)
    }

    /// Texts exactly as given (callers add the query prefix where they want it).
    pub fn embed_texts(&mut self, texts: &[String]) -> Result<Vec<f32>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        const BATCH: usize = 32;
        let encodings = self.encoder.tokenizer.encode_batch(texts.to_vec(), true)?;
        // Similar lengths together: padding is wasted work.
        let mut order: Vec<usize> = (0..texts.len()).collect();
        order.sort_by_key(|&i| encodings[i].get_ids().len());
        let mut out = vec![0f32; texts.len() * self.dim];
        for chunk in order.chunks(BATCH) {
            let batch: Vec<Encoding> = chunk.iter().map(|&i| encodings[i].clone()).collect();
            let (shape, data) = self.encoder.run(&batch)?;
            // [batch, tokens, dim], or [batch, dim] when the model pools itself.
            let (width, dim) = if shape.len() == 3 { (shape[1], shape[2]) } else { (1, shape[1]) };
            for (row, &index) in chunk.iter().enumerate() {
                let target = &mut out[index * dim..(index + 1) * dim];
                let tokens = &data[row * width * dim..(row + 1) * width * dim];
                match self.spec.pooling {
                    Pooling::Cls => target.copy_from_slice(&tokens[..dim]),
                    Pooling::Mean => {
                        let mask = batch[row].get_attention_mask();
                        let count = mask.iter().filter(|&&m| m == 1).count().max(1) as f32;
                        for (t, &m) in mask.iter().enumerate() {
                            if m == 1 {
                                for d in 0..dim {
                                    target[d] += tokens[t * dim + d];
                                }
                            }
                        }
                        target.iter_mut().for_each(|v| *v /= count);
                    }
                }
                normalize(target);
            }
        }
        Ok(out)
    }
}

pub struct Reranker {
    encoder: Encoder,
}

impl Reranker {
    pub fn load(env: &Environment, dir: &Path, threads: usize) -> Result<Self> {
        Ok(Self { encoder: Encoder::load(env, &dir.join(RERANKER_FILE), &dir.join(BERT_TOKENIZER), 192, threads, None)? })
    }

    /// How well each candidate answers the question: raw logits, higher is better.
    pub fn score(&mut self, question: &str, candidates: &[String]) -> Result<Vec<f32>> {
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        let pairs: Vec<(String, String)> = candidates.iter().map(|c| (question.to_owned(), c.clone())).collect();
        let encodings = self.encoder.tokenizer.encode_batch(pairs, true)?;
        let (shape, data) = self.encoder.run(&encodings)?;
        let per_row = shape.get(1).copied().unwrap_or(1);
        Ok((0..candidates.len()).map(|row| data[row * per_row]).collect())
    }
}

pub fn normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        v.iter_mut().for_each(|x| *x /= norm);
    }
}

pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}
