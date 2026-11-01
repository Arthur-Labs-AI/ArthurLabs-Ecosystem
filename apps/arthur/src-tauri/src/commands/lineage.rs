use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::commands::integration;

use crate::lineage::diff::RevisionDiff;
use crate::lineage::LineageError;
use crate::runtime::RuntimeHandle;
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
pub fn get_object_lineage(store: State<'_, RuntimeHandle>, object_id: String) -> Result<Lineage> {
    Ok(store.object_lineage(&object_id)?)
}

#[tauri::command]
pub fn list_revisions(store: State<'_, RuntimeHandle>, object_id: String) -> Result<Vec<Revision>> {
    Ok(store.list_revisions(&object_id)?)
}

#[tauri::command]
pub fn get_revision(store: State<'_, RuntimeHandle>, revision_id: String) -> Result<Revision> {
    Ok(store.get_revision(&revision_id)?)
}

#[tauri::command]
pub fn get_revision_parents(
    store: State<'_, RuntimeHandle>,
    revision_id: String,
) -> Result<Vec<Revision>> {
    Ok(store.revision_parents(&revision_id)?)
}

#[tauri::command]
pub fn get_revision_children(
    store: State<'_, RuntimeHandle>,
    revision_id: String,
) -> Result<Vec<Revision>> {
    Ok(store.revision_children(&revision_id)?)
}

/// Edits an object: a new revision from the current one, which becomes current.
#[tauri::command]
pub fn update_knowledge_object(
    app: AppHandle,
    store: State<'_, RuntimeHandle>,
    object_id: String,
    changes: Changes,
) -> Result<Revision> {
    let before = store.current_revision_id_of(&object_id).ok().flatten();
    let revision = store.update_object(&object_id, changes)?;
    integration::notify_revised(&app, &store, &object_id, before);
    Ok(revision)
}

/// A revision from any revision of the object (a branch). Not current unless `makeCurrent` is true.
#[tauri::command]
pub fn create_revision_from(
    app: AppHandle,
    store: State<'_, RuntimeHandle>,
    input: CreateRevisionInput,
) -> Result<Revision> {
    let before = store
        .current_revision_id_of(&input.object_id)
        .ok()
        .flatten();
    let revision = store.create_revision_from(
        &input.object_id,
        &input.parent_revision_id,
        input.changes,
        input.make_current.unwrap_or(false),
    )?;
    // A branch that is not current changes nothing authoritative, so `notify_revised` finds the current revision unchanged.
    integration::notify_revised(&app, &store, &input.object_id, before);
    Ok(revision)
}

/// A new revision with two or more parents and caller-supplied content. Not current unless `makeCurrent` is true.
#[tauri::command]
pub fn merge_revisions(
    app: AppHandle,
    store: State<'_, RuntimeHandle>,
    input: MergeRevisionsInput,
) -> Result<Revision> {
    let before = store
        .current_revision_id_of(&input.object_id)
        .ok()
        .flatten();
    let revision = store.merge_revisions(
        &input.object_id,
        &input.parent_revision_ids,
        input.result,
        input.make_current.unwrap_or(false),
    )?;
    integration::notify_revised(&app, &store, &input.object_id, before);
    Ok(revision)
}

#[tauri::command]
pub fn diff_revisions(
    store: State<'_, RuntimeHandle>,
    old_revision_id: String,
    new_revision_id: String,
) -> Result<RevisionDiff> {
    Ok(store.diff_revisions(&old_revision_id, &new_revision_id)?)
}
