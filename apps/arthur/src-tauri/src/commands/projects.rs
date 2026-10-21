use tauri::{AppHandle, State};

use crate::commands::integration;
use crate::graph::integration::ChangedKnowledge;
use crate::runtime::RuntimeHandle;
use crate::storage::capture_store::Capture;
use crate::storage::knowledge_store::KnowledgeObject;
use crate::storage::project_store::{Project, ProjectError, ProjectGraph};

type Result<T> = std::result::Result<T, ProjectError>;

#[tauri::command]
pub fn list_projects(store: State<'_, RuntimeHandle>, include_archived: Option<bool>) -> Result<Vec<Project>> {
    store.list_projects(include_archived.unwrap_or(false))
}

#[tauri::command]
pub fn get_project(store: State<'_, RuntimeHandle>, project_id: String) -> Result<Project> {
    store.get_project(&project_id)
}

#[tauri::command]
pub fn create_project(store: State<'_, RuntimeHandle>, name: String) -> Result<Project> {
    store.create_project(&name)
}

#[tauri::command]
pub fn rename_project(store: State<'_, RuntimeHandle>, project_id: String, name: String) -> Result<Project> {
    store.rename_project(&project_id, &name)
}

#[tauri::command]
pub fn archive_project(store: State<'_, RuntimeHandle>, project_id: String) -> Result<Project> {
    store.archive_project(&project_id)
}

#[tauri::command]
pub fn restore_project(store: State<'_, RuntimeHandle>, project_id: String) -> Result<Project> {
    store.restore_project(&project_id)
}

/// Moves a capture only. Objects already distilled from it stay where they are.
#[tauri::command]
pub fn move_capture(store: State<'_, RuntimeHandle>, capture_id: String, project_id: String) -> Result<Capture> {
    store.move_capture(&capture_id, &project_id)
}

/// Moves one object. No revision, provenance or lineage change.
#[tauri::command]
pub fn move_knowledge_object(app: AppHandle, store: State<'_, RuntimeHandle>, object_id: String, project_id: String) -> Result<KnowledgeObject> {
    let object = store.move_knowledge_object(&object_id, &project_id)?;
    // The object may now be integrated with its new project. Relations it already has (cross-project ones included) are not touched.
    if let Ok(Some(revision_id)) = store.current_revision_id_of(&object.id) {
        integration::notify(&app, ChangedKnowledge::moved(&object.id, &revision_id));
    }
    Ok(object)
}

/// The active project, with the Inbox as the fallback when none is stored or the stored one is archived.
#[tauri::command]
pub fn get_active_project(store: State<'_, RuntimeHandle>) -> Result<Project> {
    let id = store.active_project_id()?;
    store.get_project(&id)
}

#[tauri::command]
pub fn set_active_project(store: State<'_, RuntimeHandle>, project_id: String) -> Result<Project> {
    store.set_active_project(&project_id)?;
    store.get_project(&project_id)
}

#[tauri::command]
pub fn get_project_graph(store: State<'_, RuntimeHandle>, project_id: String) -> Result<ProjectGraph> {
    store.project_graph(&project_id)
}
