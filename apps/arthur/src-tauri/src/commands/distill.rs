use tauri::State;

use crate::distillation::{DistillError, DistillationService};
use crate::storage::capture_store::CaptureStore;
use crate::storage::knowledge_store::KnowledgeObject;

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
