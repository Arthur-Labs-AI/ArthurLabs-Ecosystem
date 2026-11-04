//! Which knowledge objects a relation-inference run may consider.
//!
//! Rule (deterministic, no embeddings, no retrieval): the candidate set is
//!   1. every object the caller asked about, then
//!   2. the most recent other objects, in `list_knowledge_objects` order
//!      (newest distillation first, reading order within one),
//!
//! up to a HARD LIMIT of `MAX_INFERENCE_CANDIDATES` objects in total. With no request, the
//! candidate set is simply the most recent `MAX_INFERENCE_CANDIDATES` objects. The model is never
//! shown the whole database. The result keeps `list_knowledge_objects` order.

use std::collections::HashSet;

use crate::storage::knowledge_store::KnowledgeObject;
use crate::storage::relation_store::is_object_id;

use super::RelationError;

/// Mirrors `MAX_INFERENCE_CANDIDATES` in `packages/contracts/cognitive.ts`.
pub const MAX_INFERENCE_CANDIDATES: usize = 40;

/// `all` must be in `list_knowledge_objects` order (most recent first).
pub fn select_candidates(
    all: Vec<KnowledgeObject>,
    requested: &[String],
) -> Result<Vec<KnowledgeObject>, RelationError> {
    let requested: HashSet<&str> = requested.iter().map(String::as_str).collect();
    if requested.len() > MAX_INFERENCE_CANDIDATES {
        return Err(RelationError::InvalidRelation(format!(
            "more than {MAX_INFERENCE_CANDIDATES} objects requested"
        )));
    }
    if requested.iter().any(|id| !is_object_id(id)) {
        return Err(RelationError::InvalidRelation("malformed object id".into()));
    }
    let present: HashSet<&str> = all.iter().map(|object| object.id.as_str()).collect();
    if requested.iter().any(|id| !present.contains(id)) {
        return Err(RelationError::ObjectNotFound);
    }

    let mut room = MAX_INFERENCE_CANDIDATES - requested.len();
    Ok(all
        .into_iter()
        .filter(|object| {
            if requested.contains(object.id.as_str()) {
                return true;
            }
            if room > 0 {
                room -= 1;
                return true;
            }
            false
        })
        .collect())
}
