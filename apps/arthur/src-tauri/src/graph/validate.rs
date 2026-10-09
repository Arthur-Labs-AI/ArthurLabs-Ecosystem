//! Deterministic validation of what the model proposed. The model is never trusted.
//!
//! One bad candidate rejects the whole proposed set (the same strictness as Thought Distillation):
//! nothing is silently repaired, dropped or guessed. Surviving candidates are canonicalized
//! (symmetric edges ordered by object id) and handed to the store, which re-validates and writes
//! them in a single transaction.
//!
//! A candidate that matches an edge ALREADY in the graph is deliberately not checked here: it is not
//! a hallucination, and the store skips it, so repeating an inference run is harmless.

use std::collections::HashSet;

use crate::storage::knowledge_store::KnowledgeObject;
use crate::storage::relation_store::{canonical_ends, KINDS, MAX_RELATIONS_PER_BATCH, NewRelation};

use super::{RelationCandidate, RelationError, MAX_RELATION_PROPOSALS};

/// Stage A output: at most `MAX_RELATION_PROPOSALS`, each structurally valid. Returns canonical edges.
pub fn validate_proposals(candidates: &[KnowledgeObject], proposals: Vec<RelationCandidate>) -> Result<Vec<NewRelation>, RelationError> {
    if proposals.len() > MAX_RELATION_PROPOSALS {
        return Err(reject(format!("more than {MAX_RELATION_PROPOSALS} relations proposed")));
    }
    let edges = proposals.into_iter().map(|p| NewRelation { kind: p.kind, source_object_id: p.source_object_id, target_object_id: p.target_object_id }).collect();
    validate_edges(candidates, edges)
}

/// The deterministic invariants, applied to any set of edges that is about to be trusted. They run on
/// the proposals AND again on the verified set, so the verifier can never widen what is allowed.
pub fn validate_edges(candidates: &[KnowledgeObject], edges: Vec<NewRelation>) -> Result<Vec<NewRelation>, RelationError> {
    if edges.len() > MAX_RELATIONS_PER_BATCH {
        return Err(reject(format!("more than {MAX_RELATIONS_PER_BATCH} relations")));
    }
    let known: HashSet<&str> = candidates.iter().map(|object| object.id.as_str()).collect();

    let mut seen: HashSet<(String, String, String)> = HashSet::new();
    let mut valid = Vec::with_capacity(edges.len());
    for (index, edge) in edges.into_iter().enumerate() {
        let problem = |reason: &str| reject(format!("relation {index}: {reason}"));
        if !KINDS.contains(&edge.kind.as_str()) {
            return Err(problem("unknown relation kind"));
        }
        for id in [&edge.source_object_id, &edge.target_object_id] {
            if !known.contains(id.as_str()) {
                return Err(problem("refers to an object that was not supplied"));
            }
        }
        if edge.source_object_id == edge.target_object_id {
            return Err(problem("relates an object to itself"));
        }
        let (source, target) = canonical_ends(&edge.kind, &edge.source_object_id, &edge.target_object_id);
        if !seen.insert((edge.kind.clone(), source.clone(), target.clone())) {
            return Err(problem("proposed more than once"));
        }
        valid.push(NewRelation { kind: edge.kind, source_object_id: source, target_object_id: target });
    }
    Ok(valid)
}

fn reject(reason: String) -> RelationError {
    RelationError::InvalidOutput(reason)
}
