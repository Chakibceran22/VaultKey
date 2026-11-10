//! VaultKey graph search (docs/graph-search.md): anchors by words and meaning, a walk
//! over the links between records, and a reranker that judges each result with the
//! path that explains it. Runs entirely on this machine.

pub mod engine;
pub mod graph;
pub mod intents;
pub mod model;
pub mod text;
pub mod types;
pub mod vault;

pub use engine::{Index, Models, Options, Params, Timing, search};
