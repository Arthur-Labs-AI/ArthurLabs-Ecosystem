use tauri::{AppHandle, State};

use crate::commands::integration;
use crate::distillation::{change_events, DistillError, DistillationService};
use crate::runtime::RuntimeHandle;
use crate::storage::knowledge_store::KnowledgeObject;
use crate::storage::organization_store::OrganizationState;
use crate::storage::summary_store::KnowledgeSummary;

/// Distills one capture into knowledge objects (once; repeating returns the existing set).
#[tauri::command]
pub async fn distill_capture(
    app: AppHandle,
    distillation: State<'_, DistillationService>,
    store: State<'_, RuntimeHandle>,
    capture_id: String,
) -> Result<Vec<KnowledgeObject>, DistillError> {
    let outcome = distillation.distill_detailed(&store, &capture_id).await?;
    // Everything is committed. Graph Integration continues in the background and can neither delay nor fail this result. The events come
    // only from a committed outcome (NEW -> created, REVISE -> revised, UNCERTAIN -> none) and are dropped unless Automatic Connections is on.
    for event in change_events(&store, &outcome) {
        integration::notify(&app, event);
    }
    // Existing contract: the objects the distillation created. Revised objects and pending claims are not folded into this list.
    Ok(outcome.objects)
}

#[tauri::command]
pub fn list_knowledge_objects(store: State<'_, RuntimeHandle>, project_id: Option<String>) -> Result<Vec<KnowledgeObject>, String> {
    store.list_knowledge_objects_in(project_id.as_deref()).map_err(|error| error.to_string())
}

/// Whether each capture is pending, running, succeeded or failed, from one read of durable state plus what is in flight.
#[tauri::command]
pub fn list_organization_states(distillation: State<'_, DistillationService>, store: State<'_, RuntimeHandle>, project_id: Option<String>) -> Result<Vec<OrganizationState>, String> {
    distillation.organization_states_in(&store, project_id.as_deref()).map_err(|error| error.to_string())
}

/// Connection and revision counts for many objects in one read. `object_ids` omitted: every object.
#[tauri::command]
pub fn get_knowledge_summaries(store: State<'_, RuntimeHandle>, object_ids: Option<Vec<String>>, project_id: Option<String>) -> Result<Vec<KnowledgeSummary>, String> {
    store.knowledge_summaries_in(object_ids.as_deref(), project_id.as_deref()).map_err(|error| error.to_string())
}
