//! The Cognitive Graph: typed relations between knowledge objects.
//!
//! This is NOT Capture provenance. Provenance (`object_sources`) says which span of which raw
//! capture an object was interpreted from; a relation says how two objects relate. Provenance is
//! never stored as a relation.
//!
//! Every invariant is enforced here, in the native domain layer, and repeated as CHECK/UNIQUE/FK
//! constraints in schema v3, so neither the UI nor a model nor a faulty writer can persist a
//! malformed edge. Callers (manual creation, model inference) never choose ids, timestamps or the
//! stored direction of a symmetric edge.
//!
//! Semantics ("source"/"target" are the stored ends; mirrors `packages/contracts/cognitive.ts`):
//!
//! | kind           | meaning                                              | direction   |
//! |----------------|------------------------------------------------------|-------------|
//! | `related_to`   | general semantic relationship                        | symmetric   |
//! | `extends`      | source develops or adds detail to target             | directional |
//! | `depends_on`   | source requires target for execution/validity/context| directional |
//! | `contradicts`  | source materially conflicts with target              | symmetric   |
//! | `derived_from` | source is derived from target knowledge              | directional |
//! | `duplicates`   | source and target are effectively the same thought   | symmetric   |
//! | `supersedes`   | source replaces target as the current knowledge      | directional |
//!
//! Canonical form: a symmetric edge is stored once, with the lexicographically smaller object id
//! as the source, so "A related_to B" and "B related_to A" are the same edge. Directional edges
//! keep the direction they were given. Identity is `(kind, source, target)`.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

use super::capture_store::{now_rfc3339, CaptureStore, StoreError};
use super::knowledge_store::KnowledgeObject;

/// Mirrors `RELATION_KINDS` in `packages/contracts/cognitive.ts`.
pub const KINDS: [&str; 7] = ["related_to", "extends", "depends_on", "contradicts", "derived_from", "duplicates", "supersedes"];
/// Mirrors `SYMMETRIC_RELATION_KINDS` in `packages/contracts/cognitive.ts`.
pub const SYMMETRIC_KINDS: [&str; 3] = ["related_to", "contradicts", "duplicates"];
/// Mirrors `RELATION_ORIGINS` in `packages/contracts/cognitive.ts`.
pub const ORIGINS: [&str; 3] = ["model", "user", "system"];
/// Mirrors `MAX_RELATIONS_PER_INFERENCE` in `packages/contracts/cognitive.ts`.
pub const MAX_RELATIONS_PER_BATCH: usize = 30;

pub fn is_symmetric(kind: &str) -> bool {
    SYMMETRIC_KINDS.contains(&kind)
}

/// An object id is exactly what the store generates: a lowercase, hyphenated UUID.
pub fn is_object_id(id: &str) -> bool {
    Uuid::parse_str(id).is_ok_and(|parsed| parsed.hyphenated().to_string() == id)
}

/// The stored `(source, target)` of an edge: symmetric kinds are ordered by object id.
pub fn canonical_ends(kind: &str, source: &str, target: &str) -> (String, String) {
    if is_symmetric(kind) && target < source {
        (target.to_string(), source.to_string())
    } else {
        (source.to_string(), target.to_string())
    }
}

/// Mirrors `CognitiveRelation`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relation {
    pub id: String,
    pub kind: String,
    pub source_object_id: String,
    pub target_object_id: String,
    pub created_at: String,
    pub origin: String,
}

/// A candidate edge. Identity, time and (for symmetric kinds) the stored direction are assigned by the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewRelation {
    pub kind: String,
    pub source_object_id: String,
    pub target_object_id: String,
}

/// Mirrors `RelationDirection`. A symmetric relation is both incoming and outgoing for either end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Incoming,
    Outgoing,
    Any,
}

impl Direction {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "incoming" => Some(Direction::Incoming),
            "outgoing" => Some(Direction::Outgoing),
            "any" => Some(Direction::Any),
            _ => None,
        }
    }
}

pub(super) const RELATION_COLUMNS: &str = "r.id, r.kind, r.source_object_id, r.target_object_id, r.origin, r.created_at, so.id, tg.id";
pub(super) const RELATION_JOINS: &str = "relations r \
     LEFT JOIN knowledge_objects so ON so.id = r.source_object_id \
     LEFT JOIN knowledge_objects tg ON tg.id = r.target_object_id";

fn symmetric_sql_list() -> String {
    SYMMETRIC_KINDS.iter().map(|kind| format!("'{kind}'")).collect::<Vec<_>>().join(", ")
}

impl CaptureStore {
    /// Creates one relation, atomically. Creating an edge that already exists returns the
    /// existing one unchanged (idempotent), so the same edge can never be stored twice.
    pub fn create_relation(&self, relation: NewRelation, origin: &str) -> Result<Relation, StoreError> {
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction()?;
        let result = create_relation_in(&transaction, relation, origin)?;
        transaction.commit()?;
        Ok(result)
    }

    /// Records a whole set of relations, all-or-nothing, and returns only the NEW ones.
    ///
    /// Every candidate is validated first (kind, well-formed ids, no self edge, existing objects,
    /// no duplicate inside the set); any failure writes nothing. A candidate identical to an edge
    /// that already exists is not an error: it is skipped, which makes repeating a run harmless.
    pub fn record_relations(
        &self,
        relations: Vec<NewRelation>,
        origin: &str,
    ) -> Result<Vec<Relation>, StoreError> {
        validate_relations_count(&relations)?;
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction()?;
        let result = record_relations_in(&transaction, relations, origin)?;
        transaction.commit()?;
        Ok(result)
    }

    /// Every relation, oldest first. Fails as a whole if any stored row is malformed or dangling,
    /// so a graph read can never return an edge whose object is missing.
    pub fn list_relations(&self) -> Result<Vec<Relation>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        read_relations(&connection, &format!("SELECT {RELATION_COLUMNS} FROM {RELATION_JOINS} ORDER BY r.seq ASC"), [])
    }

    /// One-hop relations of an object, oldest first, optionally narrowed by direction and kind.
    pub fn object_relations(&self, object_id: &str, direction: Direction, kind: Option<&str>) -> Result<Vec<Relation>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        relations_of(&connection, object_id, direction, kind)
    }

    /// The distinct objects one hop away through the matching relations, in the same order as
    /// `list_knowledge_objects`.
    pub fn object_neighbors(&self, object_id: &str, direction: Direction, kind: Option<&str>) -> Result<Vec<KnowledgeObject>, StoreError> {
        let relations = self.object_relations(object_id, direction, kind)?;
        let neighbor_ids: Vec<&str> = relations
            .iter()
            .map(|relation| if relation.source_object_id == object_id { relation.target_object_id.as_str() } else { relation.source_object_id.as_str() })
            .collect();
        Ok(self.list_knowledge_objects()?.into_iter().filter(|object| neighbor_ids.contains(&object.id.as_str())).collect())
    }
}

fn validate_relations_count(relations: &[NewRelation]) -> Result<(), StoreError> {
    if relations.len() > MAX_RELATIONS_PER_BATCH {
        return Err(StoreError::Invalid(format!(
            "more than {MAX_RELATIONS_PER_BATCH} relations"
        )));
    }
    Ok(())
}

/// Shared result selection and validation; the caller owns commit.
pub(super) fn create_relation_in(
    connection: &Connection,
    relation: NewRelation,
    origin: &str,
) -> Result<Relation, StoreError> {
    let mut written = insert_all(connection, vec![relation], origin)?;
    Ok(written.remove(0).relation)
}

/// Shared result selection and validation; the caller owns commit.
pub(super) fn record_relations_in(
    connection: &Connection,
    relations: Vec<NewRelation>,
    origin: &str,
) -> Result<Vec<Relation>, StoreError> {
    validate_relations_count(&relations)?;
    let written = insert_all(connection, relations, origin)?;
    Ok(written
        .into_iter()
        .filter(|item| item.created)
        .map(|item| item.relation)
        .collect())
}

pub(super) struct Written {
    pub(super) relation: Relation,
    pub(super) created: bool,
}

pub(super) fn insert_all(connection: &Connection, candidates: Vec<NewRelation>, origin: &str) -> Result<Vec<Written>, StoreError> {
    if !ORIGINS.contains(&origin) {
        return Err(StoreError::Invalid(format!("unknown origin \"{origin}\"")));
    }

    // Validate and canonicalize everything before the first write.
    let mut canonical: Vec<(String, String, String)> = Vec::with_capacity(candidates.len());
    let mut seen: HashMap<(String, String, String), usize> = HashMap::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let invalid = |reason: String| StoreError::Invalid(format!("relation {index}: {reason}"));
        if !KINDS.contains(&candidate.kind.as_str()) {
            return Err(invalid(format!("unknown relation kind \"{}\"", candidate.kind)));
        }
        for id in [&candidate.source_object_id, &candidate.target_object_id] {
            if !is_object_id(id) {
                return Err(invalid("malformed object id".into()));
            }
        }
        if candidate.source_object_id == candidate.target_object_id {
            return Err(invalid("an object cannot be related to itself".into()));
        }
        for id in [&candidate.source_object_id, &candidate.target_object_id] {
            let exists = connection.query_row("SELECT 1 FROM knowledge_objects WHERE id = ?1", [id], |_| Ok(())).optional()?.is_some();
            if !exists {
                return Err(StoreError::NotFound(format!("relation {index}: object does not exist")));
            }
        }
        let (source, target) = canonical_ends(&candidate.kind, &candidate.source_object_id, &candidate.target_object_id);
        let key = (candidate.kind.clone(), source, target);
        if let Some(first) = seen.insert(key.clone(), index) {
            return Err(invalid(format!("duplicates relation {first}")));
        }
        canonical.push(key);
    }

    let mut written = Vec::with_capacity(canonical.len());
    for (kind, source, target) in canonical {
        let existing = connection
            .query_row(
                &format!("SELECT {RELATION_COLUMNS} FROM {RELATION_JOINS} WHERE r.kind = ?1 AND r.source_object_id = ?2 AND r.target_object_id = ?3"),
                params![kind, source, target],
                |row| row_tuple(row),
            )
            .optional()?;
        if let Some(row) = existing {
            written.push(Written { relation: check_row(row)?, created: false });
            continue;
        }
        let relation = Relation { id: Uuid::new_v4().to_string(), kind, source_object_id: source, target_object_id: target, created_at: now_rfc3339()?, origin: origin.to_string() };
        connection.execute(
            "INSERT INTO relations (id, kind, source_object_id, target_object_id, origin, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![relation.id, relation.kind, relation.source_object_id, relation.target_object_id, relation.origin, relation.created_at],
        )?;
        written.push(Written { relation, created: true });
    }
    Ok(written)
}

fn relations_of(connection: &Connection, object_id: &str, direction: Direction, kind: Option<&str>) -> Result<Vec<Relation>, StoreError> {
    if !is_object_id(object_id) {
        return Err(StoreError::Invalid("malformed object id".into()));
    }
    if let Some(kind) = kind {
        if !KINDS.contains(&kind) {
            return Err(StoreError::Invalid(format!("unknown relation kind \"{kind}\"")));
        }
    }
    let exists = connection.query_row("SELECT 1 FROM knowledge_objects WHERE id = ?1", [object_id], |_| Ok(())).optional()?.is_some();
    if !exists {
        return Err(StoreError::NotFound("object does not exist".into()));
    }

    let symmetric = symmetric_sql_list();
    let touches = match direction {
        Direction::Outgoing => format!("(r.source_object_id = ?1 OR (r.kind IN ({symmetric}) AND r.target_object_id = ?1))"),
        Direction::Incoming => format!("(r.target_object_id = ?1 OR (r.kind IN ({symmetric}) AND r.source_object_id = ?1))"),
        Direction::Any => "(r.source_object_id = ?1 OR r.target_object_id = ?1)".to_string(),
    };
    let sql = format!("SELECT {RELATION_COLUMNS} FROM {RELATION_JOINS} WHERE {touches} AND (?2 IS NULL OR r.kind = ?2) ORDER BY r.seq ASC");
    read_relations(connection, &sql, params![object_id, kind])
}

type Row = (String, String, String, String, String, String, Option<String>, Option<String>);

fn row_tuple(row: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?))
}

pub(super) fn read_relations<P: rusqlite::Params>(connection: &Connection, sql: &str, params: P) -> Result<Vec<Relation>, StoreError> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map(params, |row| row_tuple(row))?;
    rows.map(|row| check_row(row?)).collect()
}

/// A row read back from disk is re-checked: the graph never hands out anything it would not have accepted.
fn check_row(row: Row) -> Result<Relation, StoreError> {
    let (id, kind, source, target, origin, created_at, source_found, target_found) = row;
    let corrupt = |reason: &str| StoreError::Corrupt(format!("relation {id:?}: {reason}"));
    if source_found.is_none() || target_found.is_none() {
        return Err(corrupt("an endpoint is not a knowledge object"));
    }
    if !KINDS.contains(&kind.as_str()) {
        return Err(corrupt("unknown kind"));
    }
    if !ORIGINS.contains(&origin.as_str()) {
        return Err(corrupt("unknown origin"));
    }
    if source == target {
        return Err(corrupt("self relation"));
    }
    if canonical_ends(&kind, &source, &target) != (source.clone(), target.clone()) {
        return Err(corrupt("a symmetric relation is not in canonical order"));
    }
    if OffsetDateTime::parse(&created_at, &Rfc3339).is_err() {
        return Err(corrupt("created_at is not RFC 3339"));
    }
    Ok(Relation { id, kind, source_object_id: source, target_object_id: target, created_at, origin })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::capture_store::CreateCaptureInput;
    use crate::storage::knowledge_store::NewKnowledgeObject;

    const TEXT: &str = "alpha beta gamma delta epsilon";

    /// A store holding four knowledge objects from one capture. Ids are in creation order.
    fn graph() -> (CaptureStore, Vec<String>) {
        let store = CaptureStore::open_in_memory().unwrap();
        let capture = store.create(CreateCaptureInput { source: "text".into(), content: TEXT.into(), project_id: None }).unwrap();
        let spans = [(0, 5), (6, 10), (11, 16), (17, 22)];
        let objects = spans.iter().map(|(start, end)| NewKnowledgeObject { kind: "idea".into(), title: format!("t{start}"), body: "b".into(), source_start: *start, source_end: *end }).collect();
        let ids = store.record_distillation(&capture.id, objects).unwrap().into_iter().map(|object| object.id).collect();
        (store, ids)
    }

    fn new(kind: &str, source: &str, target: &str) -> NewRelation {
        NewRelation { kind: kind.into(), source_object_id: source.into(), target_object_id: target.into() }
    }

    fn count(store: &CaptureStore) -> i64 {
        store.connection.lock().unwrap().query_row("SELECT count(*) FROM relations", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn every_relation_kind_can_be_created_with_generated_identity_and_origin() {
        let (store, ids) = graph();
        for (index, kind) in KINDS.iter().enumerate() {
            // A different target per kind keeps the pairs distinct from each other.
            let target = &ids[1 + index % 3];
            let relation = store.create_relation(new(kind, &ids[0], target), "user").unwrap();
            assert_eq!(&relation.kind, kind);
            assert_eq!(relation.origin, "user");
            assert_eq!(Uuid::parse_str(&relation.id).unwrap().get_version_num(), 4);
            assert!(OffsetDateTime::parse(&relation.created_at, &Rfc3339).is_ok());
        }
        assert_eq!(count(&store), 7);
        assert_eq!(store.list_relations().unwrap().len(), 7);
    }

    #[test]
    fn the_kinds_in_sql_and_code_agree() {
        let sql = crate::storage::migrations::SCHEMA_V3;
        let list = KINDS.iter().map(|kind| format!("'{kind}'")).collect::<Vec<_>>().join(", ");
        assert!(sql.contains(&format!("kind IN ({list})")));
        let symmetric = SYMMETRIC_KINDS.iter().map(|kind| format!("'{kind}'")).collect::<Vec<_>>().join(", ");
        assert!(sql.contains(&format!("kind NOT IN ({symmetric})")));
        let origins = ORIGINS.iter().map(|origin| format!("'{origin}'")).collect::<Vec<_>>().join(", ");
        assert!(sql.contains(&format!("origin IN ({origins})")));
    }

    #[test]
    fn invalid_kinds_are_rejected() {
        let (store, ids) = graph();
        for kind in ["friends_with", "", "Extends", "EXTENDS", "extends ", "related"] {
            assert!(matches!(store.create_relation(new(kind, &ids[0], &ids[1]), "user"), Err(StoreError::Invalid(_))), "{kind:?}");
        }
        assert_eq!(count(&store), 0);
    }

    #[test]
    fn malformed_object_ids_are_rejected_before_touching_storage() {
        let (store, ids) = graph();
        let upper = ids[1].to_uppercase();
        let braced = format!("{{{}}}", ids[1]);
        for bad in ["", "x", "not-a-uuid", &upper, &braced, "../etc/passwd", "1'; DROP TABLE relations; --"] {
            assert!(matches!(store.create_relation(new("extends", &ids[0], bad), "user"), Err(StoreError::Invalid(_))), "target {bad:?}");
            assert!(matches!(store.create_relation(new("extends", bad, &ids[0]), "user"), Err(StoreError::Invalid(_))), "source {bad:?}");
        }
        assert_eq!(count(&store), 0);
    }

    #[test]
    fn a_missing_source_or_target_object_is_reported_as_not_found() {
        let (store, ids) = graph();
        let ghost = "00000000-0000-4000-8000-000000000000";
        assert!(matches!(store.create_relation(new("extends", ghost, &ids[0]), "user"), Err(StoreError::NotFound(_))));
        assert!(matches!(store.create_relation(new("extends", &ids[0], ghost), "user"), Err(StoreError::NotFound(_))));
        assert_eq!(count(&store), 0);
    }

    #[test]
    fn a_self_relation_is_rejected_for_every_kind() {
        let (store, ids) = graph();
        for kind in KINDS {
            assert!(matches!(store.create_relation(new(kind, &ids[0], &ids[0]), "user"), Err(StoreError::Invalid(reason)) if reason.contains("itself")), "{kind}");
        }
        assert_eq!(count(&store), 0);
    }

    #[test]
    fn an_unknown_origin_is_rejected() {
        let (store, ids) = graph();
        for origin in ["", "robot", "USER"] {
            assert!(matches!(store.create_relation(new("extends", &ids[0], &ids[1]), origin), Err(StoreError::Invalid(_))));
        }
        assert_eq!(count(&store), 0);
        for (index, origin) in ORIGINS.iter().enumerate() {
            assert_eq!(store.create_relation(new("extends", &ids[0], &ids[1 + index]), origin).unwrap().origin, *origin);
        }
    }

    #[test]
    fn creating_the_same_edge_twice_returns_the_first_and_stores_one() {
        let (store, ids) = graph();
        let first = store.create_relation(new("depends_on", &ids[0], &ids[1]), "model").unwrap();
        let second = store.create_relation(new("depends_on", &ids[0], &ids[1]), "user").unwrap();

        assert_eq!(second, first, "idempotent: the original edge, origin included, is returned unchanged");
        assert_eq!(count(&store), 1);
    }

    #[test]
    fn symmetric_kinds_are_stored_once_whichever_way_they_are_stated() {
        let (store, ids) = graph();
        let (low, high) = if ids[0] < ids[1] { (&ids[0], &ids[1]) } else { (&ids[1], &ids[0]) };
        for kind in SYMMETRIC_KINDS {
            let forward = store.create_relation(new(kind, low, high), "user").unwrap();
            let backward = store.create_relation(new(kind, high, low), "user").unwrap();
            assert_eq!(forward, backward, "{kind}");
            assert_eq!((&forward.source_object_id, &forward.target_object_id), (low, high), "{kind}: smaller id is the source");
        }
        assert_eq!(count(&store), 3);

        // Stated "backwards" from the start, it is still stored canonically.
        let (store, ids) = graph();
        let (low, high) = if ids[2] < ids[3] { (&ids[2], &ids[3]) } else { (&ids[3], &ids[2]) };
        let stored = store.create_relation(new("related_to", high, low), "user").unwrap();
        assert_eq!((&stored.source_object_id, &stored.target_object_id), (low, high));
    }

    #[test]
    fn directional_kinds_keep_their_direction_and_both_directions_are_distinct_edges() {
        let (store, ids) = graph();
        for kind in KINDS.iter().filter(|kind| !is_symmetric(kind)) {
            let forward = store.create_relation(new(kind, &ids[0], &ids[1]), "user").unwrap();
            let backward = store.create_relation(new(kind, &ids[1], &ids[0]), "user").unwrap();
            assert_eq!((forward.source_object_id.as_str(), forward.target_object_id.as_str()), (ids[0].as_str(), ids[1].as_str()), "{kind}");
            assert_eq!((backward.source_object_id.as_str(), backward.target_object_id.as_str()), (ids[1].as_str(), ids[0].as_str()), "{kind}");
            assert_ne!(forward.id, backward.id);
        }
        assert_eq!(count(&store), 8);
    }

    #[test]
    fn one_pair_may_carry_several_kinds_but_never_the_same_kind_twice() {
        let (store, ids) = graph();
        store.create_relation(new("extends", &ids[0], &ids[1]), "user").unwrap();
        store.create_relation(new("related_to", &ids[0], &ids[1]), "user").unwrap();
        store.create_relation(new("extends", &ids[0], &ids[1]), "user").unwrap();
        assert_eq!(count(&store), 2);
    }

    #[test]
    fn the_database_itself_refuses_malformed_edges() {
        let (store, ids) = graph();
        let (low, high) = if ids[0] < ids[1] { (&ids[0], &ids[1]) } else { (&ids[1], &ids[0]) };
        let connection = store.connection.lock().unwrap();
        let insert = |kind: &str, source: &str, target: &str| {
            connection.execute(
                "INSERT INTO relations (id, kind, source_object_id, target_object_id, origin, created_at) VALUES (?1, ?2, ?3, ?4, 'user', '2026-10-04T10:00:00Z')",
                params![Uuid::new_v4().to_string(), kind, source, target],
            )
        };
        assert!(insert("extends", low, low).is_err(), "self edge");
        assert!(insert("related_to", high, low).is_err(), "non-canonical symmetric edge");
        assert!(insert("friends_with", low, high).is_err(), "unknown kind");
        assert!(insert("extends", low, "00000000-0000-4000-8000-000000000000").is_err(), "dangling target (foreign key)");
        assert!(insert("extends", "00000000-0000-4000-8000-000000000000", high).is_err(), "dangling source (foreign key)");
        assert!(insert("extends", high, low).is_ok(), "a directional edge may point either way");
        assert!(insert("extends", high, low).is_err(), "the same edge twice");
    }

    #[test]
    fn deleting_a_knowledge_object_removes_its_relations_and_nothing_else() {
        let (store, ids) = graph();
        store.create_relation(new("extends", &ids[0], &ids[1]), "user").unwrap();
        store.create_relation(new("depends_on", &ids[2], &ids[0]), "user").unwrap();
        let survivor = store.create_relation(new("related_to", &ids[2], &ids[3]), "user").unwrap();

        store.connection.lock().unwrap().execute("DELETE FROM knowledge_objects WHERE id = ?1", [&ids[0]]).unwrap();

        assert_eq!(store.list_relations().unwrap(), vec![survivor], "no edge to the deleted object remains");
        assert_eq!(store.list_knowledge_objects().unwrap().len(), 3);
    }

    #[test]
    fn a_dangling_edge_is_never_returned() {
        let (store, ids) = graph();
        store.create_relation(new("extends", &ids[0], &ids[1]), "user").unwrap();
        {
            // A faulty writer that bypassed foreign keys.
            let connection = store.connection.lock().unwrap();
            connection.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
            connection.execute("DELETE FROM knowledge_objects WHERE id = ?1", [&ids[1]]).unwrap();
            connection.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        }
        assert!(matches!(store.list_relations(), Err(StoreError::Corrupt(_))));
        assert!(matches!(store.object_relations(&ids[0], Direction::Any, None), Err(StoreError::Corrupt(_))));
    }

    #[test]
    fn rows_that_break_the_invariants_fail_the_read() {
        let (store, ids) = graph();
        let (low, high) = if ids[0] < ids[1] { (&ids[0], &ids[1]) } else { (&ids[1], &ids[0]) };
        store.create_relation(new("related_to", low, high), "user").unwrap();
        {
            let connection = store.connection.lock().unwrap();
            connection.execute_batch("PRAGMA ignore_check_constraints = ON;").unwrap();
            connection.execute("UPDATE relations SET source_object_id = ?1, target_object_id = ?2", [high, low]).unwrap();
        }
        assert!(matches!(store.list_relations(), Err(StoreError::Corrupt(reason)) if reason.contains("canonical")));
    }

    fn sample() -> (CaptureStore, Vec<String>) {
        // 0 extends 1; 2 depends_on 0; 0 related_to 3 (symmetric); 0 contradicts 2
        let (store, ids) = graph();
        store.create_relation(new("extends", &ids[0], &ids[1]), "user").unwrap();
        store.create_relation(new("depends_on", &ids[2], &ids[0]), "user").unwrap();
        store.create_relation(new("related_to", &ids[0], &ids[3]), "model").unwrap();
        store.create_relation(new("contradicts", &ids[0], &ids[2]), "user").unwrap();
        (store, ids)
    }

    fn kinds(relations: &[Relation]) -> Vec<&str> {
        relations.iter().map(|relation| relation.kind.as_str()).collect()
    }

    #[test]
    fn outgoing_incoming_and_any_relations_of_an_object() {
        let (store, ids) = sample();
        // Symmetric edges count in both directions for both ends.
        assert_eq!(kinds(&store.object_relations(&ids[0], Direction::Outgoing, None).unwrap()), ["extends", "related_to", "contradicts"]);
        assert_eq!(kinds(&store.object_relations(&ids[0], Direction::Incoming, None).unwrap()), ["depends_on", "related_to", "contradicts"]);
        assert_eq!(kinds(&store.object_relations(&ids[0], Direction::Any, None).unwrap()), ["extends", "depends_on", "related_to", "contradicts"]);
        // A purely directional edge is not "outgoing" for its target.
        assert_eq!(kinds(&store.object_relations(&ids[1], Direction::Outgoing, None).unwrap()), Vec::<&str>::new());
        assert_eq!(kinds(&store.object_relations(&ids[1], Direction::Incoming, None).unwrap()), ["extends"]);
        // The target of a symmetric edge sees it outgoing too.
        assert_eq!(kinds(&store.object_relations(&ids[3], Direction::Outgoing, None).unwrap()), ["related_to"]);
    }

    #[test]
    fn relations_can_be_filtered_by_kind() {
        let (store, ids) = sample();
        assert_eq!(kinds(&store.object_relations(&ids[0], Direction::Any, Some("related_to")).unwrap()), ["related_to"]);
        assert_eq!(kinds(&store.object_relations(&ids[0], Direction::Outgoing, Some("depends_on")).unwrap()), Vec::<&str>::new());
        assert_eq!(kinds(&store.object_relations(&ids[0], Direction::Incoming, Some("depends_on")).unwrap()), ["depends_on"]);
        assert!(matches!(store.object_relations(&ids[0], Direction::Any, Some("nope")), Err(StoreError::Invalid(_))));
    }

    #[test]
    fn querying_an_unknown_or_malformed_object_is_an_error_not_an_empty_graph() {
        let (store, _ids) = sample();
        assert!(matches!(store.object_relations("00000000-0000-4000-8000-000000000000", Direction::Any, None), Err(StoreError::NotFound(_))));
        assert!(matches!(store.object_relations("zzz", Direction::Any, None), Err(StoreError::Invalid(_))));
    }

    #[test]
    fn neighbors_are_the_distinct_objects_one_hop_away() {
        let (store, ids) = sample();
        let titles = |objects: Vec<KnowledgeObject>| objects.into_iter().map(|object| object.id).collect::<Vec<_>>();
        let all = store.list_knowledge_objects().unwrap().into_iter().map(|object| object.id).collect::<Vec<_>>();
        let in_list_order = |wanted: &[&String]| all.iter().filter(|id| wanted.contains(id)).cloned().collect::<Vec<_>>();

        // ids[2] is both a depends_on source and a contradicts end of ids[0]: it appears once.
        assert_eq!(titles(store.object_neighbors(&ids[0], Direction::Any, None).unwrap()), in_list_order(&[&ids[1], &ids[2], &ids[3]]));
        assert_eq!(titles(store.object_neighbors(&ids[0], Direction::Outgoing, Some("extends")).unwrap()), vec![ids[1].clone()]);
        assert_eq!(titles(store.object_neighbors(&ids[1], Direction::Any, None).unwrap()), vec![ids[0].clone()]);
        assert!(store.object_neighbors(&ids[1], Direction::Outgoing, None).unwrap().is_empty());
    }

    #[test]
    fn an_object_with_no_relations_has_an_empty_neighborhood() {
        let (store, ids) = graph();
        assert!(store.object_relations(&ids[0], Direction::Any, None).unwrap().is_empty());
        assert!(store.object_neighbors(&ids[0], Direction::Any, None).unwrap().is_empty());
        assert!(store.list_relations().unwrap().is_empty());
    }

    #[test]
    fn a_batch_is_all_or_nothing() {
        let (store, ids) = graph();
        let ghost = "00000000-0000-4000-8000-000000000000";
        for bad in [new("extends", &ids[0], ghost), new("nope", &ids[0], &ids[1]), new("extends", &ids[2], &ids[2]), new("extends", "x", &ids[1])] {
            let result = store.record_relations(vec![new("extends", &ids[0], &ids[1]), new("depends_on", &ids[1], &ids[2]), bad], "model");
            assert!(result.is_err());
            assert_eq!(count(&store), 0, "the valid candidates were not written either");
        }
    }

    #[test]
    fn duplicates_inside_a_batch_reject_the_whole_batch_even_when_written_in_opposite_directions() {
        let (store, ids) = graph();
        let result = store.record_relations(vec![new("related_to", &ids[0], &ids[1]), new("related_to", &ids[1], &ids[0])], "model");
        assert!(matches!(result, Err(StoreError::Invalid(reason)) if reason.contains("duplicates relation 0")));
        assert_eq!(count(&store), 0);
        // But the same pair in two directions is fine for a directional kind.
        assert_eq!(store.record_relations(vec![new("extends", &ids[0], &ids[1]), new("extends", &ids[1], &ids[0])], "model").unwrap().len(), 2);
    }

    #[test]
    fn a_database_failure_midway_leaves_no_partial_batch() {
        let (store, ids) = graph();
        store.connection.lock().unwrap().execute_batch("CREATE TRIGGER poison BEFORE INSERT ON relations WHEN NEW.kind = 'supersedes' BEGIN SELECT RAISE(ABORT, 'boom'); END;").unwrap();
        let result = store.record_relations(vec![new("extends", &ids[0], &ids[1]), new("supersedes", &ids[1], &ids[2])], "model");
        assert!(matches!(result, Err(StoreError::Database(_))));
        assert_eq!(count(&store), 0);
    }

    #[test]
    fn a_batch_skips_edges_that_already_exist_and_returns_only_the_new_ones() {
        let (store, ids) = graph();
        let existing = store.create_relation(new("extends", &ids[0], &ids[1]), "user").unwrap();

        let added = store.record_relations(vec![new("extends", &ids[0], &ids[1]), new("depends_on", &ids[1], &ids[2])], "model").unwrap();

        assert_eq!(kinds(&added), ["depends_on"]);
        assert_eq!(added[0].origin, "model");
        assert_eq!(count(&store), 2);
        assert_eq!(store.list_relations().unwrap()[0], existing, "the existing edge keeps its original origin");
        // Running the very same batch again changes nothing.
        assert!(store.record_relations(vec![new("extends", &ids[0], &ids[1]), new("depends_on", &ids[1], &ids[2])], "model").unwrap().is_empty());
        assert_eq!(count(&store), 2);
    }

    #[test]
    fn an_empty_batch_is_valid_and_writes_nothing() {
        let (store, _ids) = graph();
        assert!(store.record_relations(vec![], "model").unwrap().is_empty());
        assert_eq!(count(&store), 0);
    }

    #[test]
    fn too_large_a_batch_is_rejected() {
        let (store, ids) = graph();
        let many = (0..=MAX_RELATIONS_PER_BATCH).map(|_| new("extends", &ids[0], &ids[1])).collect();
        assert!(matches!(store.record_relations(many, "model"), Err(StoreError::Invalid(_))));
    }

    #[test]
    fn manual_and_model_edges_keep_their_origin() {
        let (store, ids) = graph();
        store.create_relation(new("extends", &ids[0], &ids[1]), "user").unwrap();
        store.record_relations(vec![new("extends", &ids[1], &ids[2])], "model").unwrap();
        let origins: Vec<String> = store.list_relations().unwrap().into_iter().map(|relation| relation.origin).collect();
        assert_eq!(origins, ["user", "model"]);
    }

    #[test]
    fn relations_leave_capture_provenance_untouched() {
        let (store, ids) = graph();
        let captures = store.list().unwrap();
        let before = store.list_knowledge_objects().unwrap();

        store.create_relation(new("derived_from", &ids[0], &ids[1]), "user").unwrap();
        store.create_relation(new("supersedes", &ids[2], &ids[3]), "user").unwrap();

        assert_eq!(store.list_knowledge_objects().unwrap(), before, "every object, with its provenance, is unchanged");
        assert_eq!(store.list().unwrap(), captures);
        let connection = store.connection.lock().unwrap();
        let sources: i64 = connection.query_row("SELECT count(*) FROM object_sources", [], |r| r.get(0)).unwrap();
        assert_eq!(sources, 4, "provenance is its own table, not an edge");
        let to_captures: i64 = connection.query_row("SELECT count(*) FROM relations r JOIN captures c ON c.id IN (r.source_object_id, r.target_object_id)", [], |r| r.get(0)).unwrap();
        assert_eq!(to_captures, 0, "no relation points at a capture");
    }

    #[test]
    fn relations_survive_reopening_the_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        let (before, ids) = {
            let store = CaptureStore::open(&path).unwrap();
            let capture = store.create(CreateCaptureInput { source: "text".into(), content: TEXT.into(), project_id: None }).unwrap();
            let objects = store
                .record_distillation(&capture.id, vec![NewKnowledgeObject { kind: "idea".into(), title: "a".into(), body: "b".into(), source_start: 0, source_end: 5 }, NewKnowledgeObject { kind: "idea".into(), title: "c".into(), body: "d".into(), source_start: 6, source_end: 10 }])
                .unwrap();
            let ids: Vec<String> = objects.into_iter().map(|o| o.id).collect();
            store.create_relation(new("depends_on", &ids[0], &ids[1]), "user").unwrap();
            (store.list_relations().unwrap(), ids)
        };
        let reopened = CaptureStore::open(&path).unwrap();
        assert_eq!(reopened.list_relations().unwrap(), before);
        assert_eq!(before[0].source_object_id, ids[0]);
    }

    #[test]
    fn serializes_to_the_contract_shape() {
        let (store, ids) = graph();
        let relation = store.create_relation(new("extends", &ids[0], &ids[1]), "user").unwrap();
        let value = serde_json::to_value(&relation).unwrap();
        let mut keys: Vec<&String> = value.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["createdAt", "id", "kind", "origin", "sourceObjectId", "targetObjectId"]);
    }

    #[test]
    fn direction_names_parse_strictly() {
        assert_eq!(Direction::parse("incoming"), Some(Direction::Incoming));
        assert_eq!(Direction::parse("outgoing"), Some(Direction::Outgoing));
        assert_eq!(Direction::parse("any"), Some(Direction::Any));
        for bad in ["", "both", "Incoming", "in"] {
            assert_eq!(Direction::parse(bad), None);
        }
    }

    #[test]
    fn object_id_validation_accepts_only_the_generated_form() {
        assert!(is_object_id(&Uuid::new_v4().to_string()));
        assert!(!is_object_id(&Uuid::new_v4().to_string().to_uppercase()));
        assert!(!is_object_id(&Uuid::new_v4().simple().to_string()));
        assert!(!is_object_id(""));
    }
}
