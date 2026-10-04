//! Thought Lineage: how ONE knowledge object evolved, as a DAG of immutable revisions.
//!
//! Not the Cognitive Graph (object <-> object, `graph`/`relation_store`) and not Capture provenance (object <->
//! raw capture span, `object_sources`). Graph `supersedes` means one OBJECT replaces another; a revision parent
//! means this object's own earlier state. The storage and invariants live in `storage::lineage_store`; this module
//! holds what has no database in it: the deterministic diff and the error type shown to the UI.

pub mod diff;

use std::fmt;

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

use crate::storage::capture_store::StoreError;

/// Why a lineage operation failed. `code()` values mirror `LINEAGE_ERROR_CODES` in `packages/contracts/lineage.ts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineageError {
    ObjectNotFound,
    RevisionNotFound,
    InvalidRevision(String),
    Storage(String),
}

impl LineageError {
    pub fn code(&self) -> &'static str {
        match self {
            LineageError::ObjectNotFound => "object_not_found",
            LineageError::RevisionNotFound => "revision_not_found",
            LineageError::InvalidRevision(_) => "invalid_revision",
            LineageError::Storage(_) => "storage_failed",
        }
    }

    pub fn message(&self) -> String {
        match self {
            LineageError::ObjectNotFound => "That knowledge object no longer exists.".into(),
            LineageError::RevisionNotFound => "That revision no longer exists.".into(),
            LineageError::InvalidRevision(reason) => format!("That revision is not valid: {reason}."),
            LineageError::Storage(reason) => format!("The history could not be read or saved: {reason}"),
        }
    }
}

impl fmt::Display for LineageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

impl std::error::Error for LineageError {}

/// Serialized as `{ code, message }`, matching `LineageErrorPayload`.
impl Serialize for LineageError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("LineageError", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.message())?;
        state.end()
    }
}

impl From<StoreError> for LineageError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Invalid(reason) => LineageError::InvalidRevision(reason),
            StoreError::NotFound(_) => LineageError::ObjectNotFound,
            StoreError::MissingRevision(_) => LineageError::RevisionNotFound,
            other => LineageError::Storage(other.to_string()),
        }
    }
}
