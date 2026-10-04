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

use super::{RelationCandidate, RelationError};

pub fn validate_proposals(candidates: &[KnowledgeObject], proposals: Vec<RelationCandidate>) -> Result<Vec<NewRelation>, RelationError> {
    if proposals.len() > MAX_RELATIONS_PER_BATCH {
        return Err(reject(format!("more than {MAX_RELATIONS_PER_BATCH} relations proposed")));
    }
    let known: HashSet<&str> = candidates.iter().map(|object| object.id.as_str()).collect();

    let mut seen: HashSet<(String, String, String)> = HashSet::new();
    let mut valid = Vec::with_capacity(proposals.len());
    for (index, proposal) in proposals.into_iter().enumerate() {
        let problem = |reason: &str| reject(format!("relation {index}: {reason}"));
        if !KINDS.contains(&proposal.kind.as_str()) {
            return Err(problem("unknown relation kind"));
        }
        for id in [&proposal.source_object_id, &proposal.target_object_id] {
            if !known.contains(id.as_str()) {
                return Err(problem("refers to an object that was not supplied"));
            }
        }
        if proposal.source_object_id == proposal.target_object_id {
            return Err(problem("relates an object to itself"));
        }
        let (source, target) = canonical_ends(&proposal.kind, &proposal.source_object_id, &proposal.target_object_id);
        if !seen.insert((proposal.kind.clone(), source.clone(), target.clone())) {
            return Err(problem("proposed more than once"));
        }
        valid.push(NewRelation { kind: proposal.kind, source_object_id: source, target_object_id: target });
    }
    Ok(valid)
}

fn reject(reason: String) -> RelationError {
    RelationError::InvalidOutput(reason)
}
