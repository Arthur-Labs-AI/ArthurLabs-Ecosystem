//! The retrieval evidence contract: what retrieval hands to whatever comes next (synthesis, a debug view, a benchmark).
//!
//! It is a plain, serialisable structure. Every ranking decision is visible in it: which channel found the object, at which rank,
//! with which score, whether a historical revision contributed, and which channels were degraded. Nothing here is generated text.
//!
//! `title` and `body` are ALWAYS the object's current revision. Old wording appears only inside `matchedHistorical`, a separate,
//! explicitly labelled slot, and only for objects discovered through it.

use std::fmt;

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

use super::query::IntentWeights;
use super::ranking::{Fused, Ranked};

/// Characters of an old revision shown in `matchedHistorical`.
pub const HISTORICAL_EXCERPT_CHARS: usize = 300;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LexicalEvidence {
    pub rank: usize,
    pub bm25: f64,
    pub coverage: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticEvidence {
    pub rank: usize,
    pub cosine: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HybridEvidence {
    pub score: f64,
    pub normalized: f64,
    pub bonus: f64,
    pub prior: f64,
    /// `both`, `lexical`, `semantic` or `historical`.
    pub admission: &'static str,
}

/// An OLD revision that matched the query. Never current knowledge.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchedHistorical {
    pub revision_id: String,
    /// Always `historical`.
    pub status: &'static str,
    pub rank: usize,
    /// Fraction of the query's content terms the OLD revision matched.
    pub coverage: f64,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalEvidence {
    /// 1-based position in the ranked pool.
    pub rank: usize,
    /// Whether this entry is one of the seeds (within the seed cutoff, at most 8).
    pub is_seed: bool,
    pub object_id: String,
    pub project_id: String,
    pub kind: String,
    /// The CURRENT revision's title and body.
    pub title: String,
    pub body: String,
    pub current_revision_id: String,
    pub lexical: Option<LexicalEvidence>,
    pub semantic: Option<SemanticEvidence>,
    pub hybrid: HybridEvidence,
    /// `current` (found by what the object says now) or `historicalDiscovery` (found only through an old revision).
    pub discovery: &'static str,
    pub matched_historical: Option<MatchedHistorical>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalScope {
    pub project_id: String,
    pub project_name: String,
    pub archived: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LexicalStatus {
    Ok,
    /// FTS5 failed; the Rust fallback scan answered (lower quality, same scope and currency rules).
    DegradedScan,
    /// The query had no content terms; the channel did not run.
    SkippedNoTerms,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SemanticStatus {
    Ok,
    /// Some in-scope objects have no valid vector yet; they are reachable lexically only.
    Partial,
    /// Not opted in (the default), switched off, or the saved choice does not match the current provider. No embedding request was made.
    Disabled,
    /// Opted in but the provider failed or timed out. Lexical results are unaffected.
    Unavailable,
    /// Opted in, provider fine, but no valid vector exists in scope yet.
    NoIndex,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Timings {
    pub interpret_ms: f64,
    pub lexical_ms: f64,
    pub historical_ms: f64,
    /// Network time of the query embedding. Reported separately and never added to local retrieval time.
    pub query_embedding_ms: f64,
    /// Local vector scan plus resolving the hits.
    pub semantic_local_ms: f64,
    pub merge_ms: f64,
    /// Everything except the query-embedding wait (lexical and the embedding overlap).
    pub total_ms: f64,
    pub wall_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalDiagnostics {
    pub intent: IntentWeights,
    pub lexical: LexicalStatus,
    pub semantic: SemanticStatus,
    /// Why the semantic channel was unavailable (a code, never provider text).
    pub semantic_reason: Option<&'static str>,
    /// Fraction of in-scope objects with a valid vector (only when semantic is enabled).
    pub semantic_coverage: Option<f64>,
    /// Whether the gated historical path ran, and how many old revisions it nominated.
    pub historical_ran: bool,
    pub historical_nominated: usize,
    pub timings: Timings,
    pub embedding_requests: u32,
    pub uploaded_texts: u32,
    pub sql_reads: u32,
    pub pool_size: usize,
    pub seed_count: usize,
    pub active_channels: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RetrievalOutcome {
    Results,
    /// Retrieval ran and nothing was relevant enough. Distinct from a degraded channel and from a storage failure.
    NoMatch,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalResult {
    pub query: String,
    pub scope: RetrievalScope,
    pub outcome: RetrievalOutcome,
    pub evidence: Vec<RetrievalEvidence>,
    pub diagnostics: RetrievalDiagnostics,
}

fn excerpt(text: &str) -> String {
    text.chars().take(HISTORICAL_EXCERPT_CHARS).collect()
}

fn evidence_of(index: usize, seed_count: usize, ranked: Ranked) -> RetrievalEvidence {
    let matched_historical = ranked
        .historical
        .as_ref()
        .filter(|_| ranked.historical_discovery)
        .map(|h| MatchedHistorical {
            revision_id: h.revision_id.clone(),
            status: "historical",
            rank: h.rank,
            coverage: h.coverage,
            title: excerpt(&h.revision_title),
            body: excerpt(&h.revision_body),
        });
    RetrievalEvidence {
        rank: index + 1,
        is_seed: index < seed_count,
        object_id: ranked.object.object_id,
        project_id: ranked.object.project_id,
        kind: ranked.object.kind,
        title: ranked.object.title,
        body: ranked.object.body,
        current_revision_id: ranked.object.current_revision_id,
        lexical: ranked.lexical.map(|l| LexicalEvidence {
            rank: l.rank,
            bm25: l.bm25,
            coverage: l.coverage,
        }),
        semantic: ranked.semantic.map(|s| SemanticEvidence {
            rank: s.rank,
            cosine: s.cosine,
        }),
        hybrid: HybridEvidence {
            score: ranked.hybrid,
            normalized: ranked.normalized,
            bonus: ranked.bonus,
            prior: ranked.prior,
            admission: ranked.admission.as_str(),
        },
        discovery: if ranked.historical_discovery {
            "historicalDiscovery"
        } else {
            "current"
        },
        matched_historical,
    }
}

pub fn evidence_list(fused: Fused) -> Vec<RetrievalEvidence> {
    let seeds = fused.seed_count;
    fused
        .pool
        .into_iter()
        .enumerate()
        .map(|(index, ranked)| evidence_of(index, seeds, ranked))
        .collect()
}

/// Why retrieval could not run at all. Degradation (a failed embedding, a broken index) is NOT an error: it is reported in
/// `diagnostics` and retrieval continues. `Storage` is reserved for a store that cannot be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecallError {
    InvalidQuery(String),
    ProjectNotFound,
    Storage(String),
}

impl RecallError {
    pub fn code(&self) -> &'static str {
        match self {
            RecallError::InvalidQuery(_) => "invalid_query",
            RecallError::ProjectNotFound => "project_not_found",
            RecallError::Storage(_) => "storage_failed",
        }
    }

    pub fn message(&self) -> String {
        match self {
            RecallError::InvalidQuery(reason) => {
                format!("That question cannot be searched: {reason}.")
            }
            RecallError::ProjectNotFound => "That project does not exist.".into(),
            RecallError::Storage(_) => "Your knowledge could not be searched. Try again.".into(),
        }
    }
}

impl fmt::Display for RecallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RecallError::Storage(reason) => write!(f, "{}: {reason}", self.code()),
            other => write!(f, "{}: {}", other.code(), other.message()),
        }
    }
}

impl std::error::Error for RecallError {}

/// Serialized as `{ code, message }`, like every other error payload crossing the boundary. The message never contains stored text.
impl Serialize for RecallError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("RecallError", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.message())?;
        state.end()
    }
}
