use tauri::State;

use crate::graph::{create_manual_relation, GraphService, RelationError};
use crate::storage::capture_store::CaptureStore;
use crate::storage::knowledge_store::KnowledgeObject;
use crate::storage::relation_store::{Direction, NewRelation, Relation};

/// Mirrors `CreateRelationInput`. Id, timestamp and origin are never accepted from the UI.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRelationInput {
    pub kind: String,
    pub source_object_id: String,
    pub target_object_id: String,
}

/// A user-authored relation (origin `user`). Creating an edge that already exists returns it unchanged.
#[tauri::command]
pub fn create_relation(store: State<'_, CaptureStore>, input: CreateRelationInput) -> Result<Relation, RelationError> {
    create_manual_relation(&store, NewRelation { kind: input.kind, source_object_id: input.source_object_id, target_object_id: input.target_object_id })
}

#[tauri::command]
pub fn list_relations(store: State<'_, CaptureStore>) -> Result<Vec<Relation>, RelationError> {
    store.list_relations().map_err(|error| RelationError::Storage(error.to_string()))
}

fn parse_filter(direction: Option<String>) -> Result<Direction, RelationError> {
    match direction {
        None => Ok(Direction::Any),
        Some(text) => Direction::parse(&text).ok_or_else(|| RelationError::InvalidRelation("unknown direction".into())),
    }
}

fn from_query(error: crate::storage::capture_store::StoreError) -> RelationError {
    use crate::storage::capture_store::StoreError;
    match error {
        StoreError::Invalid(reason) => RelationError::InvalidRelation(reason),
        StoreError::NotFound(_) => RelationError::ObjectNotFound,
        other => RelationError::Storage(other.to_string()),
    }
}

#[tauri::command]
pub fn get_object_relations(store: State<'_, CaptureStore>, object_id: String, direction: Option<String>, kind: Option<String>) -> Result<Vec<Relation>, RelationError> {
    store.object_relations(&object_id, parse_filter(direction)?, kind.as_deref()).map_err(from_query)
}

#[tauri::command]
pub fn get_object_neighbors(store: State<'_, CaptureStore>, object_id: String, direction: Option<String>, kind: Option<String>) -> Result<Vec<KnowledgeObject>, RelationError> {
    store.object_neighbors(&object_id, parse_filter(direction)?, kind.as_deref()).map_err(from_query)
}

/// Asks the cloud model to propose relations among recent objects; only validated ones are stored.
/// Returns the relations this run added.
#[tauri::command]
pub async fn infer_relations(graph: State<'_, GraphService>, store: State<'_, CaptureStore>, object_ids: Option<Vec<String>>) -> Result<Vec<Relation>, RelationError> {
    graph.infer(&store, &object_ids.unwrap_or_default()).await
}
