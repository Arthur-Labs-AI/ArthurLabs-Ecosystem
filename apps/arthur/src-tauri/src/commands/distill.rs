use tauri::{AppHandle, State};

use crate::commands::integration;
use crate::graph::integration::ChangedKnowledge;
use crate::distillation::{DistillError, DistillationService};
use crate::storage::capture_store::CaptureStore;
use crate::storage::knowledge_store::KnowledgeObject;
use crate::storage::organization_store::OrganizationState;
use crate::storage::summary_store::KnowledgeSummary;

/// Distills one capture into knowledge objects (once; repeating returns the existing set).
#[tauri::command]
pub async fn distill_capture(
    app: AppHandle,
    distillation: State<'_, DistillationService>,
    store: State<'_, CaptureStore>,
    capture_id: String,
) -> Result<Vec<KnowledgeObject>, DistillError> {
    let objects = distillation.distill(&store, &capture_id).await?;
    // The objects are committed. Graph Integration continues in the background and can neither delay nor fail this result.
    for object in &objects {
        if let Ok(Some(revision_id)) = store.current_revision_id_of(&object.id) {
            integration::notify(&app, ChangedKnowledge::created(&object.id, &revision_id));
        }
    }
    Ok(objects)
}

#[tauri::command]
pub fn list_knowledge_objects(store: State<'_, CaptureStore>, project_id: Option<String>) -> Result<Vec<KnowledgeObject>, String> {
    store.list_knowledge_objects_in(project_id.as_deref()).map_err(|error| error.to_string())
}

/// Whether each capture is pending, running, succeeded or failed, from one read of durable state plus what is in flight.
#[tauri::command]
pub fn list_organization_states(distillation: State<'_, DistillationService>, store: State<'_, CaptureStore>, project_id: Option<String>) -> Result<Vec<OrganizationState>, String> {
    distillation.organization_states_in(&store, project_id.as_deref()).map_err(|error| error.to_string())
}

/// Connection and revision counts for many objects in one read. `object_ids` omitted: every object.
#[tauri::command]
pub fn get_knowledge_summaries(store: State<'_, CaptureStore>, object_ids: Option<Vec<String>>, project_id: Option<String>) -> Result<Vec<KnowledgeSummary>, String> {
    store.knowledge_summaries_in(object_ids.as_deref(), project_id.as_deref()).map_err(|error| error.to_string())
}
