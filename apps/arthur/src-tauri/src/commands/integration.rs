//! Native boundary of Automatic Graph Integration (M04.7A).
//!
//! `notify` is the only way an event enters integration. It returns at once: the caller (distillation, an edit, a move) has already
//! committed its own result and never waits for, or fails because of, the graph work that follows.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::graph::integration::{ChangedKnowledge, IntegrationService};
use crate::recall::evidence::RecallError;
use crate::recall::RecallService;
use crate::runtime::RuntimeHandle;
use crate::storage::capture_store::CaptureStore;

/// Sent to the UI after an integration changed the graph, so an open Connections screen can re-read it.
pub const GRAPH_CHANGED_EVENT: &str = "graph-integrated";

/// How often the app looks for integrations that failed earlier and are due again. Bounded: `MAX_RETRIES_PER_TICK` per tick, and the
/// ledger caps the number of real attempts per object.
pub const RETRY_POLL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphChanged {
    object_id: String,
    added: usize,
    removed: usize,
}

/// The door of integration, free of any window handle so it can be tested: counts the announcement and says whether the event may enter.
/// While Automatic Connections is off nothing enters and nothing is scheduled.
pub fn admit(service: &IntegrationService) -> bool {
    let enabled = service.enabled();
    service.diagnostics.event_emitted(enabled);
    enabled
}

/// The work an admitted event does: exactly what the background task runs, without the window notification.
pub async fn process(service: &IntegrationService, store: &CaptureStore, recall: &RecallService, change: ChangedKnowledge) -> crate::graph::integration::IntegrationReport {
    service.integrate(store, recall, change).await
}

/// Hands one change to Graph Integration in the background. Does nothing at all while integration is off.
pub fn notify(app: &AppHandle, change: ChangedKnowledge) {
    if !admit(&app.state::<IntegrationService>()) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { run(&app, change).await });
}

/// A new current revision of `object_id`, replacing `previous_revision_id`. Looks the new current revision up, so it is always the
/// authoritative one.
pub fn notify_revised(app: &AppHandle, store: &CaptureStore, object_id: &str, previous_revision_id: Option<String>) {
    let (Some(previous), Ok(Some(current))) = (previous_revision_id, store.current_revision_id_of(object_id)) else { return };
    if previous != current {
        notify(app, ChangedKnowledge::revised(object_id, &previous, &current));
    }
}

async fn run(app: &AppHandle, change: ChangedKnowledge) {
    let service = app.state::<IntegrationService>();
    let store = app.state::<RuntimeHandle>();
    let recall = app.state::<RecallService>();
    let report = process(&service, &store, &recall, change).await;
    if report.added > 0 || report.removed > 0 {
        let delivered = app.emit(GRAPH_CHANGED_EVENT, GraphChanged { object_id: report.object_id, added: report.added, removed: report.removed }).is_ok();
        service.diagnostics.ui_update(delivered);
    }
}

/// Starts the integrations that failed earlier and are due now. Never blocks.
pub fn kick_retries(app: &AppHandle) {
    let due = app.state::<IntegrationService>().due_retries_now();
    for change in due {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { run(&app, change).await });
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphIntegrationStatus {
    pub enabled: bool,
    /// Integrations waiting for a retry.
    pub pending: usize,
}

fn status(service: &IntegrationService) -> GraphIntegrationStatus {
    GraphIntegrationStatus { enabled: service.enabled(), pending: service.ledger.pending() }
}

#[tauri::command]
pub fn get_graph_integration(service: State<'_, IntegrationService>) -> GraphIntegrationStatus {
    status(&service)
}

/// The user's explicit choice. OFF stops new automatic inference at once and deletes nothing.
#[tauri::command]
pub fn set_graph_integration_enabled(service: State<'_, IntegrationService>, enabled: bool) -> Result<GraphIntegrationStatus, RecallError> {
    service.set_enabled(enabled).map_err(|error| RecallError::Storage(format!("the preference could not be saved: {error}")))?;
    Ok(status(&service))
}

/// What Automatic Connections has done since Arthur started, as counts, stage names and error codes. Never any text, key or answer.
#[tauri::command]
pub fn get_graph_integration_diagnostics(service: State<'_, IntegrationService>) -> crate::graph::diagnostics::Snapshot {
    service.diagnostics.snapshot(service.enabled())
}
