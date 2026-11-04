//! Cognitive Recall: the RETRIEVAL core (M04B).
//!
//! Recall reads the Cognitive Store and produces a deterministic, inspectable `RetrievalResult` (a ranked evidence list with every
//! signal that produced the ranking). It does not synthesise answers, expand the graph, enrich with lineage, or call any tool.
//! The authoritative store is never modified by Recall; the only writes are to the rebuildable projections `recall_*`.
//!
//! ```text
//! query      interpretation: normalisation, content terms, stem-prefixes, intent weights, FTS expression
//! ranking    pure deterministic hybrid fusion (RRF) and seed selection
//! evidence   the stable output contract
//! settings   the user's opt-in to semantic Recall (app-private, fails closed)
//! service    orchestration: lexical || (query embedding + semantic), fusion, the lazy indexer
//! ```
//!
//! The architecture is in `docs/architecture/cognitive-recall/`.

#[cfg(test)]
mod acceptance;
pub mod answer;
#[cfg(test)]
mod ask_tests;
#[cfg(test)]
mod bench;
pub mod context;
pub mod evidence;
pub mod graph;
pub mod lexical;
pub mod package;
pub mod prompt;
pub mod query;
pub mod ranking;
pub mod revisions;
pub mod service;
#[cfg(test)]
mod service_tests;
pub mod settings;
pub mod synthesis;
#[cfg(test)]
pub mod testing;

pub use service::RecallService;
