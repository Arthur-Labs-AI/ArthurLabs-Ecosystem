//! Whether each capture has been organized: durable, and derived from the data that proves it.
//!
//! * succeeded: a `distillation_runs` row exists. This includes a run that found no objects.
//! * failed: no run, but `organization_failures` holds the latest failure (code and safe message).
//! * pending: neither. The capture was never organized, or the app died before an attempt finished.
//!
//! "Running" is not stored: it is only true while this process is working on the capture, so the caller overlays it
//! from memory. A stored "running" would be a lie after a crash.

use rusqlite::params;
use serde::Serialize;

use super::capture_store::{now_rfc3339, CaptureStore, StoreError};

/// Mirrors `OrganizationState` in `packages/contracts/cognitive.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationState {
    pub capture_id: String,
    /// `pending`, `running`, `succeeded` or `failed`.
    pub status: &'static str,
    /// How many knowledge objects came from this capture. Zero with `succeeded` means "organized, nothing found".
    pub object_count: i64,
    /// Set only when `status` is `failed`.
    pub failure: Option<OrganizationFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationFailure {
    pub code: String,
    pub message: String,
    pub failed_at: String,
}

impl CaptureStore {
    /// Remembers that organizing this capture failed. A capture that was organized in the meantime keeps its success:
    /// nothing is written for it. Replaces an earlier failure for the same capture.
    pub fn record_organization_failure(&self, capture_id: &str, code: &str, message: &str) -> Result<(), StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        connection.execute(
            "INSERT INTO organization_failures (capture_id, code, message, failed_at) \
             SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM distillation_runs WHERE capture_id = ?1) \
             ON CONFLICT(capture_id) DO UPDATE SET code = excluded.code, message = excluded.message, failed_at = excluded.failed_at",
            params![capture_id, code, message, now_rfc3339()?],
        )?;
        Ok(())
    }

    /// One entry per capture, newest first, from a single query.
    pub fn list_organization_states(&self) -> Result<Vec<OrganizationState>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT c.id, \
                    CASE WHEN d.capture_id IS NOT NULL THEN 'succeeded' WHEN f.capture_id IS NOT NULL THEN 'failed' ELSE 'pending' END, \
                    (SELECT count(*) FROM object_sources s WHERE s.capture_id = c.id), \
                    f.code, f.message, f.failed_at \
             FROM captures c \
             LEFT JOIN distillation_runs d ON d.capture_id = c.id \
             LEFT JOIN organization_failures f ON f.capture_id = c.id \
             ORDER BY c.seq DESC",
        )?;
        let rows = statement.query_map([], |row| {
            let status: String = row.get(1)?;
            let failure = match (row.get::<_, Option<String>>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?) {
                (Some(code), Some(message), Some(failed_at)) if status == "failed" => Some(OrganizationFailure { code, message, failed_at }),
                _ => None,
            };
            Ok(OrganizationState {
                capture_id: row.get(0)?,
                status: match status.as_str() {
                    "succeeded" => "succeeded",
                    "failed" => "failed",
                    _ => "pending",
                },
                object_count: row.get(2)?,
                failure,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::capture_store::CreateCaptureInput;
    use crate::storage::knowledge_store::NewKnowledgeObject;

    fn capture(store: &CaptureStore, text: &str) -> String {
        store.create(CreateCaptureInput { source: "text".into(), content: text.into() }).unwrap().id
    }
    fn object(start: i64, end: i64) -> NewKnowledgeObject {
        NewKnowledgeObject { kind: "idea".into(), title: "T".into(), body: "B".into(), source_start: start, source_end: end }
    }
    fn state_of(store: &CaptureStore, id: &str) -> OrganizationState {
        store.list_organization_states().unwrap().into_iter().find(|s| s.capture_id == id).unwrap()
    }

    #[test]
    fn a_capture_nobody_organized_is_pending() {
        let store = CaptureStore::open_in_memory().unwrap();
        let id = capture(&store, "never tried");
        let state = state_of(&store, &id);
        assert_eq!((state.status, state.object_count, state.failure), ("pending", 0, None));
    }

    #[test]
    fn a_successful_run_with_objects_is_succeeded_with_their_count() {
        let store = CaptureStore::open_in_memory().unwrap();
        let id = capture(&store, "alpha beta");
        store.record_distillation(&id, vec![object(0, 5), object(6, 10)]).unwrap();
        let state = state_of(&store, &id);
        assert_eq!((state.status, state.object_count), ("succeeded", 2));
    }

    #[test]
    fn a_successful_run_that_found_nothing_is_succeeded_not_pending() {
        let store = CaptureStore::open_in_memory().unwrap();
        let id = capture(&store, "just chatter");
        store.record_distillation(&id, vec![]).unwrap();
        let state = state_of(&store, &id);
        assert_eq!((state.status, state.object_count, state.failure), ("succeeded", 0, None));
    }

    #[test]
    fn a_failure_is_remembered_with_its_code_and_safe_message_and_replaced_by_the_next_one() {
        let store = CaptureStore::open_in_memory().unwrap();
        let id = capture(&store, "alpha");
        store.record_organization_failure(&id, "llm_failed", "Could not reach the language model.").unwrap();
        let first = state_of(&store, &id);
        assert_eq!(first.status, "failed");
        let failure = first.failure.unwrap();
        assert_eq!((failure.code.as_str(), failure.message.as_str()), ("llm_failed", "Could not reach the language model."));
        assert!(!failure.failed_at.is_empty());

        store.record_organization_failure(&id, "llm_refused", "Declined.").unwrap();
        assert_eq!(state_of(&store, &id).failure.unwrap().code, "llm_refused");
        let rows: i64 = store.connection.lock().unwrap().query_row("SELECT count(*) FROM organization_failures", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1, "one row per capture, not a history");
    }

    #[test]
    fn a_success_clears_the_failure_atomically_and_a_late_failure_cannot_undo_a_success() {
        let store = CaptureStore::open_in_memory().unwrap();
        let id = capture(&store, "alpha");
        store.record_organization_failure(&id, "llm_failed", "x").unwrap();
        store.record_distillation(&id, vec![object(0, 5)]).unwrap();
        let state = state_of(&store, &id);
        assert_eq!((state.status, state.failure), ("succeeded", None));

        store.record_organization_failure(&id, "llm_failed", "late").unwrap();
        assert_eq!(state_of(&store, &id).status, "succeeded");
        let rows: i64 = store.connection.lock().unwrap().query_row("SELECT count(*) FROM organization_failures", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn a_rejected_distillation_keeps_the_previous_failure_untouched() {
        let store = CaptureStore::open_in_memory().unwrap();
        let id = capture(&store, "alpha");
        store.record_organization_failure(&id, "llm_failed", "x").unwrap();
        assert!(store.record_distillation(&id, vec![object(0, 99)]).is_err(), "span outside the capture");
        assert_eq!(state_of(&store, &id).status, "failed", "the failed transaction rolled back, failure intact");
    }

    #[test]
    fn states_are_listed_newest_capture_first_in_one_pass() {
        let store = CaptureStore::open_in_memory().unwrap();
        let (a, b, c) = (capture(&store, "aaa"), capture(&store, "bbb"), capture(&store, "ccc"));
        store.record_distillation(&a, vec![object(0, 3)]).unwrap();
        store.record_organization_failure(&b, "llm_failed", "x").unwrap();
        let states = store.list_organization_states().unwrap();
        assert_eq!(states.iter().map(|s| (s.capture_id.as_str(), s.status)).collect::<Vec<_>>(), [(c.as_str(), "pending"), (b.as_str(), "failed"), (a.as_str(), "succeeded")]);
    }

    #[test]
    fn an_unknown_error_code_cannot_be_stored() {
        let store = CaptureStore::open_in_memory().unwrap();
        let id = capture(&store, "alpha");
        assert!(store.record_organization_failure(&id, "made_up", "x").is_err());
        assert!(store.record_organization_failure("no-such-capture", "llm_failed", "x").is_err());
    }
}
