//! VaultKey graph search (docs/graph-search.md): anchors by words and meaning, a walk
//! over the links between records, and a reranker that judges each result with the
//! path that explains it. Runs entirely on this machine.

pub mod engine;
pub mod graph;
pub mod intents;
/// Search by meaning: an embedding model (and a reranker) through ONNX Runtime. Off by
/// default: the app searches by words and links (no model, ~11 MB, under a millisecond).
#[cfg(feature = "meaning")]
pub mod model;
pub mod text;
pub mod types;
pub mod vault;

pub use engine::{Index, Models, Options, Params, Timing, search};

pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub type Result<T> = std::result::Result<T, Error>;
