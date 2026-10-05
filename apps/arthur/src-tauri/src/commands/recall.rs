//! Native boundary of Cognitive Recall retrieval (M04B).
//!
//! This is retrieval, not Ask Arthur: there is no answer, no synthesis and no model call. `recall_retrieve` is a debug/test
//! boundary that returns the ranked evidence and diagnostics. The semantic-Recall consent and purge operations are here because
//! they are the user's privacy controls; their UI is a later milestone.

use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use crate::recall::evidence::{RecallError, RetrievalResult};
use crate::recall::service::{RecallService, SemanticRecallStatus, INDEX_RUN_LIMIT};
use crate::storage::capture_store::CaptureStore;

/// Ranked, scored evidence for one question inside ONE explicit project. Never widens the scope.
#[tauri::command]
pub async fn recall_retrieve(app: AppHandle, service: State<'_, RecallService>, store: State<'_, CaptureStore>, query: String, project_id: String) -> Result<RetrievalResult, RecallError> {
    let result = service.retrieve(&store, &query, &project_id).await?;
    // Lazy indexing: if semantic Recall is on and some objects still lack a vector, make progress in the background.
    if result.diagnostics.semantic_coverage.is_some_and(|c| c < 1.0) {
        kick_indexer(&app);
    }
    Ok(result)
}

#[tauri::command]
pub fn get_semantic_recall_status(service: State<'_, RecallService>, store: State<'_, CaptureStore>) -> Result<SemanticRecallStatus, RecallError> {
    service.semantic_status(&store)
}

/// The user's explicit choice. ON starts bounded background indexing; OFF takes effect for the very next request and keeps (but
/// ignores) the stored vectors. Never inferred from the presence of an API key.
#[tauri::command]
pub fn set_semantic_recall_enabled(app: AppHandle, service: State<'_, RecallService>, store: State<'_, CaptureStore>, enabled: bool) -> Result<SemanticRecallStatus, RecallError> {
    service.settings().set(service.model_key(), enabled).map_err(|error| RecallError::Storage(format!("the preference could not be saved: {error}")))?;
    if enabled {
        kick_indexer(&app);
    }
    service.semantic_status(&store)
}

/// Deletes every locally stored vector. Knowledge itself is untouched.
#[tauri::command]
pub fn purge_semantic_index(service: State<'_, RecallService>, store: State<'_, CaptureStore>) -> Result<SemanticRecallStatus, RecallError> {
    service.purge_semantic_index(&store)?;
    service.semantic_status(&store)
}

const FIRST_BACKOFF: Duration = Duration::from_secs(30);
const MAX_BACKOFF: Duration = Duration::from_secs(15 * 60);
const MAX_FAILURES: u32 = 5;
const MAX_RUNS: u32 = 64;

/// How often the app checks for objects whose current revision has no valid vector (new objects, edits, merges that became current).
/// Capture, Thought Distillation and Thought Lineage know nothing about Recall, so the indexer finds its own work: it recomputes the
/// set "objects without a valid vector" and does nothing when semantic Recall is off.
pub const INDEX_POLL: Duration = Duration::from_secs(60);

/// Starts the lazy, bounded indexer if semantic Recall is on and no run is already in progress. Never blocks the caller and never
/// affects capture, distillation or editing: a failure only leaves the semantic channel partial. There is no durable queue; the
/// work set is "objects whose current revision has no valid vector", which a run recomputes.
pub fn kick_indexer(app: &AppHandle) {
    if !app.state::<RecallService>().semantic_enabled() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let service = app.state::<RecallService>();
        let Some(_guard) = service.begin_indexing() else { return };
        let store = app.state::<CaptureStore>();
        let mut delay = FIRST_BACKOFF;
        let mut failures = 0;
        for _ in 0..MAX_RUNS {
            match service.index_pending(&store, INDEX_RUN_LIMIT).await {
                Ok(report) if report.stopped_by_consent || report.remaining == Some(0) => return,
                Ok(report) if report.failure.is_some() => {
                    failures += 1;
                    if failures >= MAX_FAILURES {
                        return;
                    }
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(MAX_BACKOFF);
                }
                Ok(report) if report.embedded + report.adopted == 0 => return,
                Ok(_) => {}
                Err(_) => return,
            }
        }
    });
}
