//! The two models, run with ONNX Runtime on the CPU.
//!
//! - [`Embedder`]: a sentence into a unit vector, so "hosting" lands near Coolify.
//! - [`Reranker`]: a cross-encoder that reads the question and a candidate together
//!   (with the path that leads to it) and says how well one answers the other.
//!
//! Both are BERT-sized (6–12 layers, 384 wide), int8, and share one WordPiece tokenizer.
//! Nothing here touches the network: the files are read from disk once.

use std::path::Path;

use ort::{
    environment::Environment,
    session::{Session, builder::GraphOptimizationLevel},
    value::Tensor,
};
use tokenizers::{Encoding, Tokenizer, TruncationParams, TruncationStrategy};

pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub type Result<T> = std::result::Result<T, Error>;

/// How a sequence of token vectors becomes one vector.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pooling {
    /// The first token ([CLS]): bge and arctic-embed.
    Cls,
    /// The mean over real tokens: MiniLM sentence-transformers.
    Mean,
}

/// Which embedding model, and how it wants to be called.
#[derive(Clone, Debug)]
pub struct EmbedderSpec {
    pub name: &'static str,
    pub file: &'static str,
    /// Prepended to questions (not to records): asymmetric retrieval models expect it.
    pub query_prefix: &'static str,
    pub pooling: Pooling,
    /// How close the rest of a question must be to an intent's phrasing to ask for it.
    /// Similarities are scaled differently per model: tuned on the dev questions.
    pub intent_min: f32,
}

pub const BGE_SMALL: EmbedderSpec = EmbedderSpec {
    name: "bge-small-en-v1.5",
    file: "bge-small-en-v1.5.onnx",
    query_prefix: "Represent this sentence for searching relevant passages: ",
    pooling: Pooling::Cls,
    intent_min: 0.8,
};

/// The default: ahead of bge-small on both splits of the demo questions (see eval.rs).
pub const ARCTIC_S: EmbedderSpec = EmbedderSpec {
    name: "snowflake-arctic-embed-s",
    file: "snowflake-arctic-embed-s.onnx",
    query_prefix: "Represent this sentence for searching relevant passages: ",
    pooling: Pooling::Cls,
    intent_min: 0.95,
};

pub const RERANKER_FILE: &str = "ms-marco-MiniLM-L-6-v2.onnx";
pub const TOKENIZER_FILE: &str = "tokenizer.json";

/// Creates the ONNX Runtime environment every session hangs off. One per process.
pub fn environment() -> Result<Environment> {
    Ok(ort::init().with_name("vaultkey-search").build()?)
}

/// The builder's errors carry the builder (not `Send`); `?` here turns them into plain ones.
fn session(env: &Environment, model: &Path, threads: usize) -> ort::Result<Session> {
    Session::builder(env)?
        .with_optimization_level(GraphOptimizationLevel::Level3)?
        .with_intra_threads(threads)?
        .with_inter_threads(1)?
        .commit_from_file(model)
}

/// A BERT-style encoder: tokens in, the model's first output out.
struct Encoder {
    session: Session,
    tokenizer: Tokenizer,
    token_types: bool,
}

impl Encoder {
    fn load(env: &Environment, model: &Path, tokenizer: &Path, max_tokens: usize, threads: usize) -> Result<Self> {
        let mut tokenizer = Tokenizer::from_file(tokenizer)?;
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: max_tokens,
                strategy: TruncationStrategy::LongestFirst,
                ..Default::default()
            }))?
            .with_padding(None);
        let session = session(env, model, threads)?;
        let token_types = session.inputs().iter().any(|input| input.name() == "token_type_ids");
        Ok(Self { session, tokenizer, token_types })
    }

    /// Runs one padded batch; returns the first output and its shape.
    fn run(&mut self, batch: &[Encoding]) -> Result<(Vec<usize>, Vec<f32>)> {
        let rows = batch.len();
        let width = batch.iter().map(|e| e.get_ids().len()).max().unwrap_or(0);
        let mut ids = vec![0i64; rows * width];
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
        let outputs = if self.token_types {
            self.session.run(ort::inputs![
                "input_ids" => Tensor::from_array((shape, ids))?,
                "attention_mask" => Tensor::from_array((shape, mask))?,
                "token_type_ids" => Tensor::from_array((shape, types))?,
            ])?
        } else {
            self.session.run(ort::inputs![
                "input_ids" => Tensor::from_array((shape, ids))?,
                "attention_mask" => Tensor::from_array((shape, mask))?,
            ])?
        };
        let (out_shape, data) = outputs[0].try_extract_tensor::<f32>()?;
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
        let mut encoder = Encoder::load(env, &dir.join(spec.file), &dir.join(TOKENIZER_FILE), 128, threads)?;
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

    pub fn intent_min(&self) -> f32 {
        self.spec.intent_min
    }

    /// Questions, with the model's query instruction. Row-major, one unit vector each.
    pub fn embed_queries(&mut self, texts: &[&str]) -> Result<Vec<f32>> {
        let prefixed: Vec<String> = texts.iter().map(|t| format!("{}{t}", self.spec.query_prefix)).collect();
        self.embed_texts(&prefixed)
    }

    /// Records, as they are. Row-major, one unit vector each.
    pub fn embed_documents(&mut self, texts: &[String]) -> Result<Vec<f32>> {
        self.embed_texts(texts)
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
            let (width, dim) = (shape[1], shape[2]);
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
        Ok(Self { encoder: Encoder::load(env, &dir.join(RERANKER_FILE), &dir.join(TOKENIZER_FILE), 192, threads)? })
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
