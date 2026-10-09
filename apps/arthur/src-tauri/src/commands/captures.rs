use tauri::State;

use crate::storage::capture_store::{Capture, CaptureStore, CreateCaptureInput};

#[tauri::command]
pub fn create_capture(store: State<'_, CaptureStore>, input: CreateCaptureInput) -> Result<Capture, String> {
    store.create(input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_captures(store: State<'_, CaptureStore>, project_id: Option<String>) -> Result<Vec<Capture>, String> {
    store.list_in(project_id.as_deref()).map_err(|error| error.to_string())
}

/// Captures by id, from one query, wherever they live. Provenance uses this to open the original Capture.
#[tauri::command]
pub fn get_captures(store: State<'_, CaptureStore>, capture_ids: Vec<String>) -> Result<Vec<Capture>, String> {
    store.get_captures(&capture_ids).map_err(|error| error.to_string())
}
