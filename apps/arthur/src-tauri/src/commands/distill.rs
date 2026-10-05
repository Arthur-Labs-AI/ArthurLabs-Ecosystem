use tauri::State;

use crate::distillation::{DistillError, DistillationService};
use crate::storage::capture_store::CaptureStore;
use crate::storage::knowledge_store::KnowledgeObject;
use crate::storage::organization_store::OrganizationState;
use crate::storage::summary_store::KnowledgeSummary;

/// Distills one capture into knowledge objects (once; repeating returns the existing set).
#[tauri::command]
pub async fn distill_capture(
    distillation: State<'_, DistillationService>,
    store: State<'_, CaptureStore>,
    capture_id: String,
) -> Result<Vec<KnowledgeObject>, DistillError> {
    distillation.distill(&store, &capture_id).await
}

#[tauri::command]
pub fn list_knowledge_objects(store: State<'_, CaptureStore>) -> Result<Vec<KnowledgeObject>, String> {
    store.list_knowledge_objects().map_err(|error| error.to_string())
}

/// Whether each capture is pending, running, succeeded or failed, from one read of durable state plus what is in flight.
#[tauri::command]
pub fn list_organization_states(distillation: State<'_, DistillationService>, store: State<'_, CaptureStore>) -> Result<Vec<OrganizationState>, String> {
    distillation.organization_states(&store).map_err(|error| error.to_string())
}

/// Connection and revision counts for many objects in one read. `object_ids` omitted: every object.
#[tauri::command]
pub fn get_knowledge_summaries(store: State<'_, CaptureStore>, object_ids: Option<Vec<String>>) -> Result<Vec<KnowledgeSummary>, String> {
    store.knowledge_summaries(object_ids.as_deref()).map_err(|error| error.to_string())
}
