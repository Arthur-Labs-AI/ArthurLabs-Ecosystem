use serde::Deserialize;
use tauri::State;

use crate::lineage::diff::RevisionDiff;
use crate::lineage::LineageError;
use crate::storage::capture_store::CaptureStore;
use crate::storage::lineage_store::{Changes, Lineage, Revision, RevisionContent};

/// Mirrors `CreateRevisionInput`. Ids, timestamps, origin and provenance are never accepted from the UI.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRevisionInput {
    pub object_id: String,
    pub parent_revision_id: String,
    pub changes: Changes,
    pub make_current: Option<bool>,
}

/// Mirrors `MergeRevisionsInput`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergeRevisionsInput {
    pub object_id: String,
    pub parent_revision_ids: Vec<String>,
    pub result: RevisionContent,
    pub make_current: Option<bool>,
}

type Result<T> = std::result::Result<T, LineageError>;

#[tauri::command]
pub fn get_object_lineage(store: State<'_, CaptureStore>, object_id: String) -> Result<Lineage> {
    Ok(store.object_lineage(&object_id)?)
}

#[tauri::command]
pub fn list_revisions(store: State<'_, CaptureStore>, object_id: String) -> Result<Vec<Revision>> {
    Ok(store.list_revisions(&object_id)?)
}

#[tauri::command]
pub fn get_revision(store: State<'_, CaptureStore>, revision_id: String) -> Result<Revision> {
    Ok(store.get_revision(&revision_id)?)
}

#[tauri::command]
pub fn get_revision_parents(store: State<'_, CaptureStore>, revision_id: String) -> Result<Vec<Revision>> {
    Ok(store.revision_parents(&revision_id)?)
}

#[tauri::command]
pub fn get_revision_children(store: State<'_, CaptureStore>, revision_id: String) -> Result<Vec<Revision>> {
    Ok(store.revision_children(&revision_id)?)
}

/// Edits an object: a new revision from the current one, which becomes current.
#[tauri::command]
pub fn update_knowledge_object(store: State<'_, CaptureStore>, object_id: String, changes: Changes) -> Result<Revision> {
    Ok(store.update_object(&object_id, changes)?)
}

/// A revision from any revision of the object (a branch). Not current unless `makeCurrent` is true.
#[tauri::command]
pub fn create_revision_from(store: State<'_, CaptureStore>, input: CreateRevisionInput) -> Result<Revision> {
    Ok(store.create_revision_from(&input.object_id, &input.parent_revision_id, input.changes, input.make_current.unwrap_or(false))?)
}

/// A new revision with two or more parents and caller-supplied content. Not current unless `makeCurrent` is true.
#[tauri::command]
pub fn merge_revisions(store: State<'_, CaptureStore>, input: MergeRevisionsInput) -> Result<Revision> {
    Ok(store.merge_revisions(&input.object_id, &input.parent_revision_ids, input.result, input.make_current.unwrap_or(false))?)
}

#[tauri::command]
pub fn diff_revisions(store: State<'_, CaptureStore>, old_revision_id: String, new_revision_id: String) -> Result<RevisionDiff> {
    Ok(store.diff_revisions(&old_revision_id, &new_revision_id)?)
}
