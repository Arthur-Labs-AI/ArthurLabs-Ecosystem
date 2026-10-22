//! The storage side of Automatic Graph Integration (M04.7A).
//!
//! Everything here is a narrow, guarded read or write for ONE changed object (the "focus"):
//!
//! * reads: the focus object, its current revision id, the relations among a set of objects, the MODEL-origin relations that
//!   touch it;
//! * one write, `apply_integration`, that adds model relations and removes/replaces model relations in a single transaction.
//!
//! The invariants live here, in SQL, so no caller can break them by mistake:
//!
//! 1. A relation is only ever deleted `WHERE origin = 'model'`. A user relation (explicit human intent) cannot be removed by this
//!    path, whatever the caller passes.
//! 2. Every added and every removed relation must touch the focus object. Unrelated regions of the graph are untouched.
//! 3. The write is based on a snapshot taken before slow provider calls. It is applied only if the focus object is STILL at the
//!    revision (and project) the decision was made for; otherwise nothing is written. A relation that touches another object that
//!    changed meanwhile is skipped, not written from stale text.
//! 4. All-or-nothing. A replacement (remove + add) is one transaction, so no reader sees both or neither.

use std::collections::HashMap;

use rusqlite::{params, params_from_iter, OptionalExtension};

use super::capture_store::{CaptureStore, StoreError};
use super::knowledge_store::{get_object_in, KnowledgeObject};
use super::relation_store::{canonical_ends, insert_all, read_relations, NewRelation, Relation, KINDS, RELATION_COLUMNS, RELATION_JOINS};

/// What a decision was based on for one object. Compared with the authoritative state at write time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectSnapshot {
    pub object_id: String,
    pub revision_id: String,
    pub project_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegrationWrite {
    pub focus: ObjectSnapshot,
    /// The other objects the decision looked at.
    pub context: Vec<ObjectSnapshot>,
    /// Ids of relations to delete. Only model-origin relations touching the focus are ever deleted.
    pub remove: Vec<String>,
    /// Model relations to add. Each must touch the focus.
    pub add: Vec<NewRelation>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct IntegrationWritten {
    /// The focus object changed (or left its project) after the snapshot. Nothing was written.
    pub stale: bool,
    pub added: Vec<Relation>,
    /// Relations that were really deleted.
    pub removed: usize,
    /// Edges or removals skipped because the other object changed after the snapshot.
    pub skipped_stale: usize,
    /// Edges that were already present (any origin), left exactly as they were.
    pub already_present: usize,
}

impl CaptureStore {
    /// One object with its CURRENT text, or `None`.
    pub fn get_knowledge_object(&self, object_id: &str) -> Result<Option<KnowledgeObject>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        get_object_in(&connection, object_id)
    }

    /// The id of the object's current revision, or `None` when the object does not exist.
    pub fn current_revision_id_of(&self, object_id: &str) -> Result<Option<String>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let found: Option<Option<String>> = connection.query_row("SELECT current_revision_id FROM knowledge_objects WHERE id = ?1", [object_id], |row| row.get(0)).optional()?;
        Ok(found.flatten())
    }

    /// `object id -> current revision id` for every object of a project, in one statement. Read BEFORE the text it will be compared
    /// with, so an edit in between can only make the later guard stricter, never looser.
    pub fn project_revisions(&self, project_id: &str) -> Result<HashMap<String, String>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let mut statement = connection.prepare("SELECT id, current_revision_id FROM knowledge_objects WHERE project_id = ?1 AND current_revision_id IS NOT NULL")?;
        let rows = statement.query_map([project_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        Ok(rows.collect::<Result<HashMap<_, _>, _>>()?)
    }

    /// `object id -> created_at of its CURRENT revision` (when the current text was last written), for every object of a project. This is the
    /// time of the latest revision, NOT the object's creation time; context for the verifier only.
    pub fn project_current_revision_times(&self, project_id: &str) -> Result<HashMap<String, String>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let mut statement = connection.prepare("SELECT o.id, r.created_at FROM knowledge_objects o JOIN thought_revisions r ON r.id = o.current_revision_id WHERE o.project_id = ?1")?;
        let rows = statement.query_map([project_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        Ok(rows.collect::<Result<HashMap<_, _>, _>>()?)
    }

    /// Every relation (any origin) whose BOTH ends are in `object_ids`, oldest first. One statement, no full-graph scan.
    pub fn relations_among(&self, object_ids: &[String]) -> Result<Vec<Relation>, StoreError> {
        if object_ids.is_empty() {
            return Ok(Vec::new());
        }
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let marks = vec!["?"; object_ids.len()].join(",");
        let sql = format!("SELECT {RELATION_COLUMNS} FROM {RELATION_JOINS} WHERE r.source_object_id IN ({marks}) AND r.target_object_id IN ({marks}) ORDER BY r.seq ASC");
        let values: Vec<&str> = object_ids.iter().chain(object_ids.iter()).map(String::as_str).collect();
        read_relations(&connection, &sql, params_from_iter(values))
    }

    /// The relations that touch this object and were created by the MODEL, newest first. User and system relations are not returned:
    /// they are never candidates for automatic revalidation.
    pub fn model_relations_touching(&self, object_id: &str) -> Result<Vec<Relation>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let sql = format!("SELECT {RELATION_COLUMNS} FROM {RELATION_JOINS} WHERE r.origin = 'model' AND (r.source_object_id = ?1 OR r.target_object_id = ?1) ORDER BY r.seq DESC");
        read_relations(&connection, &sql, [object_id])
    }

    /// Applies one integration decision atomically. See the module documentation for the invariants.
    pub fn apply_integration(&self, write: IntegrationWrite) -> Result<IntegrationWritten, StoreError> {
        validate_integration(&write)?;
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction()?;
        let written = apply_integration_in(&transaction, write)?;
        // A stale focus retains the original read-only rollback path.
        if !written.stale {
            transaction.commit()?;
        }
        Ok(written)
    }
}

fn validate_integration(write: &IntegrationWrite) -> Result<(), StoreError> {
    let focus = write.focus.object_id.as_str();
    for edge in &write.add {
        if !KINDS.contains(&edge.kind.as_str()) {
            return Err(StoreError::Invalid(format!(
                "unknown relation kind \"{}\"",
                edge.kind
            )));
        }
        if edge.source_object_id != focus && edge.target_object_id != focus {
            return Err(StoreError::Invalid(
                "an integration may only add relations that touch the changed object".into(),
            ));
        }
    }
    Ok(())
}

/// Shared graph replacement body. No provider work or transaction ownership.
pub(super) fn apply_integration_in(
    transaction: &rusqlite::Connection,
    write: IntegrationWrite,
) -> Result<IntegrationWritten, StoreError> {
    validate_integration(&write)?;
    let focus = write.focus.object_id.as_str();

    let state = |object_id: &str| -> Result<Option<(String, String)>, StoreError> {
        Ok(transaction
            .query_row(
                "SELECT current_revision_id, project_id FROM knowledge_objects WHERE id = ?1",
                [object_id],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
            .and_then(|(revision, project)| revision.map(|revision| (revision, project))))
    };
    let unchanged = |snapshot: &ObjectSnapshot| -> Result<bool, StoreError> {
        Ok(
            state(&snapshot.object_id)?.is_some_and(|(revision, project)| {
                revision == snapshot.revision_id && project == snapshot.project_id
            }),
        )
    };

    let mut written = IntegrationWritten::default();
    if !unchanged(&write.focus)? {
        written.stale = true;
        return Ok(written);
    }
    let mut still_valid: HashMap<&str, bool> = HashMap::new();
    for snapshot in &write.context {
        still_valid.insert(snapshot.object_id.as_str(), unchanged(snapshot)?);
    }
    // An object the decision never looked at cannot be a valid other end.
    let other_ok = |object_id: &str| {
        object_id == focus || still_valid.get(object_id).copied().unwrap_or(false)
    };

    for relation_id in &write.remove {
        let row: Option<(String, String, String)> = transaction
            .query_row(
                "SELECT source_object_id, target_object_id, origin FROM relations WHERE id = ?1",
                [relation_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((source, target, origin)) = row else {
            continue;
        };
        if origin != "model" || (source != focus && target != focus) {
            // Not ours to remove: a user/system relation, or one that does not touch the focus.
            continue;
        }
        let other = if source == focus { &target } else { &source };
        if !other_ok(other) {
            written.skipped_stale += 1;
            continue;
        }
        written.removed += transaction.execute("DELETE FROM relations WHERE id = ?1 AND origin = 'model' AND (source_object_id = ?2 OR target_object_id = ?2)", params![relation_id, focus])?;
    }

    let mut edges = Vec::new();
    for edge in write.add {
        let (source, target) =
            canonical_ends(&edge.kind, &edge.source_object_id, &edge.target_object_id);
        let other = if source == focus { &target } else { &source };
        if !other_ok(other) {
            written.skipped_stale += 1;
            continue;
        }
        edges.push(edge);
    }
    for item in insert_all(&transaction, edges, "model")? {
        if item.created {
            written.added.push(item.relation);
        } else {
            written.already_present += 1;
        }
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::capture_store::CreateCaptureInput;
    use crate::storage::knowledge_store::NewKnowledgeObject;
    use crate::storage::lineage_store::Changes;

    fn objects(count: usize) -> (CaptureStore, Vec<KnowledgeObject>) {
        let store = CaptureStore::open_in_memory().unwrap();
        let mut made = Vec::new();
        for index in 0..count {
            let text = format!("thought number {index}");
            let capture = store.create(CreateCaptureInput { source: "text".into(), content: text.clone(), project_id: None }).unwrap();
            let length = text.chars().count() as i64;
            made.extend(store.record_distillation(&capture.id, vec![NewKnowledgeObject { kind: "idea".into(), title: format!("t{index}"), body: text, source_start: 0, source_end: length }]).unwrap());
        }
        (store, made)
    }

    fn snapshot(store: &CaptureStore, object: &KnowledgeObject) -> ObjectSnapshot {
        ObjectSnapshot { object_id: object.id.clone(), revision_id: store.current_revision_id_of(&object.id).unwrap().unwrap(), project_id: object.project_id.clone() }
    }

    fn edge(kind: &str, source: &str, target: &str) -> NewRelation {
        NewRelation { kind: kind.into(), source_object_id: source.into(), target_object_id: target.into() }
    }

    #[test]
    fn a_user_relation_can_never_be_removed_through_an_integration() {
        let (store, o) = objects(2);
        let user = store.create_relation(edge("depends_on", &o[0].id, &o[1].id), "user").unwrap();
        let written = store
            .apply_integration(IntegrationWrite { focus: snapshot(&store, &o[0]), context: vec![snapshot(&store, &o[1])], remove: vec![user.id.clone()], add: vec![] })
            .unwrap();
        assert_eq!(written.removed, 0);
        assert_eq!(store.list_relations().unwrap(), vec![user], "the user relation is exactly as it was");
    }

    #[test]
    fn only_model_relations_that_touch_the_focus_are_removed() {
        let (store, o) = objects(4);
        let mine = store.create_relation(edge("related_to", &o[0].id, &o[1].id), "model").unwrap();
        let elsewhere = store.create_relation(edge("related_to", &o[2].id, &o[3].id), "model").unwrap();
        let written = store
            .apply_integration(IntegrationWrite { focus: snapshot(&store, &o[0]), context: vec![snapshot(&store, &o[1]), snapshot(&store, &o[2])], remove: vec![mine.id.clone(), elsewhere.id.clone()], add: vec![] })
            .unwrap();
        assert_eq!(written.removed, 1);
        assert_eq!(store.list_relations().unwrap(), vec![elsewhere], "a relation that does not touch the focus is left alone");
    }

    #[test]
    fn a_replacement_is_one_transaction_and_a_stale_focus_writes_nothing() {
        let (store, o) = objects(2);
        let old = store.create_relation(edge("related_to", &o[0].id, &o[1].id), "model").unwrap();
        let before = snapshot(&store, &o[0]);
        let context = vec![snapshot(&store, &o[1])];
        let write = IntegrationWrite { focus: before.clone(), context: context.clone(), remove: vec![old.id.clone()], add: vec![edge("depends_on", &o[0].id, &o[1].id)] };

        let written = store.apply_integration(write.clone()).unwrap();
        assert_eq!((written.removed, written.added.len()), (1, 1));
        let after = store.list_relations().unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!((after[0].kind.as_str(), after[0].origin.as_str(), after[0].source_object_id.as_str()), ("depends_on", "model", o[0].id.as_str()));

        // The focus is edited after the decision was made: the same write is now stale.
        store.update_object(&o[0].id, Changes { kind: None, title: Some("changed".into()), body: None }).unwrap();
        let stale = store.apply_integration(IntegrationWrite { remove: vec![after[0].id.clone()], add: vec![edge("extends", &o[0].id, &o[1].id)], ..write }).unwrap();
        assert!(stale.stale);
        assert_eq!(store.list_relations().unwrap(), after, "nothing was written");
    }

    #[test]
    fn an_edge_that_does_not_touch_the_focus_is_refused() {
        let (store, o) = objects(3);
        let result = store.apply_integration(IntegrationWrite { focus: snapshot(&store, &o[0]), context: vec![snapshot(&store, &o[1]), snapshot(&store, &o[2])], remove: vec![], add: vec![edge("related_to", &o[1].id, &o[2].id)] });
        assert!(matches!(result, Err(StoreError::Invalid(_))));
        assert!(store.list_relations().unwrap().is_empty());
    }

    #[test]
    fn an_existing_edge_is_not_duplicated_and_keeps_its_origin() {
        let (store, o) = objects(2);
        let user = store.create_relation(edge("related_to", &o[1].id, &o[0].id), "user").unwrap();
        let written = store.apply_integration(IntegrationWrite { focus: snapshot(&store, &o[0]), context: vec![snapshot(&store, &o[1])], remove: vec![], add: vec![edge("related_to", &o[0].id, &o[1].id)] }).unwrap();
        assert_eq!((written.added.len(), written.already_present), (0, 1));
        assert_eq!(store.list_relations().unwrap(), vec![user]);
    }

    #[test]
    fn a_context_object_that_changed_makes_its_edge_skip_instead_of_trusting_stale_text() {
        let (store, o) = objects(3);
        let focus = snapshot(&store, &o[0]);
        let a = snapshot(&store, &o[1]);
        let b = snapshot(&store, &o[2]);
        store.update_object(&o[1].id, Changes { kind: None, title: Some("edited meanwhile".into()), body: None }).unwrap();
        let written = store.apply_integration(IntegrationWrite { focus, context: vec![a, b], remove: vec![], add: vec![edge("related_to", &o[0].id, &o[1].id), edge("related_to", &o[0].id, &o[2].id)] }).unwrap();
        assert_eq!((written.added.len(), written.skipped_stale), (1, 1));
    }

    #[test]
    fn relations_among_and_model_relations_touching_are_exact() {
        let (store, o) = objects(3);
        store.create_relation(edge("related_to", &o[0].id, &o[1].id), "user").unwrap();
        store.create_relation(edge("extends", &o[0].id, &o[2].id), "model").unwrap();
        assert_eq!(store.relations_among(&[o[0].id.clone(), o[1].id.clone()]).unwrap().len(), 1);
        assert_eq!(store.relations_among(&[o[0].id.clone(), o[1].id.clone(), o[2].id.clone()]).unwrap().len(), 2);
        let model = store.model_relations_touching(&o[0].id).unwrap();
        assert_eq!(model.len(), 1);
        assert_eq!(model[0].origin, "model");
    }
}
