use tauri::State;

use crate::storage::capture_store::{Capture, CaptureStore, CreateCaptureInput};

#[tauri::command]
pub fn create_capture(store: State<'_, CaptureStore>, input: CreateCaptureInput) -> Result<Capture, String> {
    store.create(input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_captures(store: State<'_, CaptureStore>) -> Result<Vec<Capture>, String> {
    store.list().map_err(|error| error.to_string())
}
