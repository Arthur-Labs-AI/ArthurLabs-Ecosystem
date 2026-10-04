//! Knowledge objects: structured interpretations of raw captures, each with provenance.
//!
//! The raw capture stays the authority for what the user said. An object records the
//! exact span of that text it came from, so every interpretation can be audited.
//! This is app-local storage, not the future Home Node Cognitive Store.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

use super::capture_store::{now_rfc3339, CaptureStore, StoreError};

/// Mirrors `KNOWLEDGE_OBJECT_KINDS` in `packages/contracts/cognitive.ts`.
pub const KINDS: [&str; 5] = ["idea", "task", "decision", "question", "note"];
/// Mirrors the limits in `packages/contracts/cognitive.ts`.
pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_BODY_CHARS: usize = 2_000;
pub const MAX_OBJECTS_PER_DISTILLATION: usize = 12;

/// Mirrors `KnowledgeProvenance`. Offsets are Unicode code points, half-open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub capture_id: String,
    pub source_start: i64,
    pub source_end: i64,
}

/// Mirrors `KnowledgeObject`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeObject {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub created_at: String,
    pub provenance: Provenance,
}

/// A candidate object. Identity and time are assigned by the store, never by the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewKnowledgeObject {
    pub kind: String,
    pub title: String,
    pub body: String,
    pub source_start: i64,
    pub source_end: i64,
}

const OBJECT_COLUMNS: &str = "o.id, o.kind, o.title, o.body, o.created_at, s.capture_id, s.source_start, s.source_end, length(c.content)";
const OBJECT_JOINS: &str = "knowledge_objects o \
     LEFT JOIN object_sources s ON s.object_id = o.id \
     LEFT JOIN captures c ON c.id = s.capture_id";

impl CaptureStore {
    /// `None` when the capture has never been distilled; `Some(vec![])` when it was and yielded nothing.
    pub fn distillation_for(&self, capture_id: &str) -> Result<Option<Vec<KnowledgeObject>>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        distillation_in(&connection, capture_id)
    }

    /// Records one distillation for a capture, all-or-nothing.
    ///
    /// Every candidate is validated against the stored capture first, then the run and all
    /// objects are written in a single transaction. On any failure nothing is written. If the
    /// capture already has a distillation, that existing set is returned and nothing is written.
    pub fn record_distillation(
        &self,
        capture_id: &str,
        mut objects: Vec<NewKnowledgeObject>,
    ) -> Result<Vec<KnowledgeObject>, StoreError> {
        if objects.len() > MAX_OBJECTS_PER_DISTILLATION {
            return Err(StoreError::Invalid(format!("more than {MAX_OBJECTS_PER_DISTILLATION} objects")));
        }

        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction()?;

        let content: String = transaction
            .query_row("SELECT content FROM captures WHERE id = ?1", [capture_id], |row| row.get(0))
            .optional()?
            .ok_or_else(|| StoreError::Invalid("capture does not exist".into()))?;

        if let Some(existing) = distillation_in(&transaction, capture_id)? {
            return Ok(existing);
        }

        for (index, object) in objects.iter().enumerate() {
            validate_new(&content, object).map_err(|reason| StoreError::Invalid(format!("object {index}: {reason}")))?;
        }
        // Source order, so `seq` order is reading order.
        objects.sort_by_key(|object| (object.source_start, object.source_end));

        transaction.execute(
            "INSERT INTO distillation_runs (capture_id, created_at) VALUES (?1, ?2)",
            params![capture_id, now_rfc3339()?],
        )?;

        let mut stored = Vec::with_capacity(objects.len());
        for object in objects {
            let id = Uuid::new_v4().to_string();
            let created_at = now_rfc3339()?;
            transaction.execute(
                "INSERT INTO knowledge_objects (id, kind, title, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, object.kind, object.title, object.body, created_at],
            )?;
            transaction.execute(
                "INSERT INTO object_sources (object_id, capture_id, source_start, source_end) VALUES (?1, ?2, ?3, ?4)",
                params![id, capture_id, object.source_start, object.source_end],
            )?;
            stored.push(KnowledgeObject {
                id,
                kind: object.kind,
                title: object.title,
                body: object.body,
                created_at,
                provenance: Provenance {
                    capture_id: capture_id.to_string(),
                    source_start: object.source_start,
                    source_end: object.source_end,
                },
            });
        }

        transaction.commit()?;
        Ok(stored)
    }

    /// Newest distillation first; within a distillation, in the order the text was written.
    /// Fails as a whole if any stored row is malformed or its provenance does not resolve.
    pub fn list_knowledge_objects(&self) -> Result<Vec<KnowledgeObject>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let sql = format!(
            "SELECT {OBJECT_COLUMNS} FROM {OBJECT_JOINS} \
             LEFT JOIN distillation_runs r ON r.capture_id = s.capture_id \
             ORDER BY r.seq DESC, o.seq ASC"
        );
        read_objects(&connection, &sql, [])
    }
}

fn distillation_in(connection: &Connection, capture_id: &str) -> Result<Option<Vec<KnowledgeObject>>, StoreError> {
    let ran: bool = connection
        .query_row("SELECT 1 FROM distillation_runs WHERE capture_id = ?1", [capture_id], |_| Ok(true))
        .optional()?
        .unwrap_or(false);
    if !ran {
        return Ok(None);
    }
    let sql = format!("SELECT {OBJECT_COLUMNS} FROM {OBJECT_JOINS} WHERE s.capture_id = ?1 ORDER BY o.seq ASC");
    read_objects(connection, &sql, [capture_id]).map(Some)
}

fn read_objects<P: rusqlite::Params>(connection: &Connection, sql: &str, params: P) -> Result<Vec<KnowledgeObject>, StoreError> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map(params, |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<i64>>(6)?,
            row.get::<_, Option<i64>>(7)?,
            row.get::<_, Option<i64>>(8)?,
        ))
    })?;

    let mut objects = Vec::new();
    for row in rows {
        let (id, kind, title, body, created_at, capture_id, start, end, capture_len) = row?;
        let corrupt = |reason: &str| StoreError::Corrupt(format!("knowledge object {id:?}: {reason}"));
        let (Some(capture_id), Some(source_start), Some(source_end), Some(capture_len)) = (capture_id, start, end, capture_len) else {
            return Err(corrupt("provenance does not resolve to a capture"));
        };
        if !KINDS.contains(&kind.as_str()) {
            return Err(corrupt("unknown kind"));
        }
        if title.trim().is_empty() || body.trim().is_empty() {
            return Err(corrupt("empty title or body"));
        }
        if OffsetDateTime::parse(&created_at, &Rfc3339).is_err() {
            return Err(corrupt("created_at is not RFC 3339"));
        }
        if source_start < 0 || source_end <= source_start || source_end > capture_len {
            return Err(corrupt("source span is outside its capture"));
        }
        objects.push(KnowledgeObject {
            id,
            kind,
            title,
            body,
            created_at,
            provenance: Provenance { capture_id, source_start, source_end },
        });
    }
    Ok(objects)
}

fn validate_new(content: &str, object: &NewKnowledgeObject) -> Result<(), String> {
    if !KINDS.contains(&object.kind.as_str()) {
        return Err(format!("unknown kind \"{}\"", object.kind));
    }
    if object.title.trim().is_empty() {
        return Err("title is empty".into());
    }
    if object.title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!("title exceeds {MAX_TITLE_CHARS} characters"));
    }
    if object.body.trim().is_empty() {
        return Err("body is empty".into());
    }
    if object.body.chars().count() > MAX_BODY_CHARS {
        return Err(format!("body exceeds {MAX_BODY_CHARS} characters"));
    }

    let (start, end) = (object.source_start, object.source_end);
    let length = content.chars().count() as i64;
    if start < 0 {
        return Err("source span starts before the capture".into());
    }
    if end <= start {
        return Err("source span is empty or reversed".into());
    }
    if end > length {
        return Err("source span ends after the capture".into());
    }
    let span: String = content.chars().skip(start as usize).take((end - start) as usize).collect();
    if span.trim().is_empty() {
        return Err("source span contains no text".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::capture_store::{Capture, CreateCaptureInput};

    fn store_with(content: &str) -> (CaptureStore, Capture) {
        let store = CaptureStore::open_in_memory().unwrap();
        let capture = store.create(CreateCaptureInput { source: "text".into(), content: content.into() }).unwrap();
        (store, capture)
    }

    fn object(kind: &str, title: &str, body: &str, start: i64, end: i64) -> NewKnowledgeObject {
        NewKnowledgeObject { kind: kind.into(), title: title.into(), body: body.into(), source_start: start, source_end: end }
    }

    fn span_text(content: &str, provenance: &Provenance) -> String {
        content.chars().skip(provenance.source_start as usize).take((provenance.source_end - provenance.source_start) as usize).collect()
    }

    const TEXT: &str = "Improve the capture screen. Email Ignatov tomorrow.";

    #[test]
    fn records_objects_with_generated_identity_time_and_resolvable_provenance() {
        let (store, capture) = store_with(TEXT);
        let stored = store
            .record_distillation(
                &capture.id,
                vec![object("idea", "Improve capture screen", "Make the screen better.", 0, 27), object("task", "Email Ignatov", "Email Ignatov.", 28, 51)],
            )
            .unwrap();

        assert_eq!(stored.len(), 2);
        for item in &stored {
            assert_eq!(Uuid::parse_str(&item.id).unwrap().get_version_num(), 4);
            assert!(OffsetDateTime::parse(&item.created_at, &Rfc3339).is_ok());
            assert_eq!(item.provenance.capture_id, capture.id);
        }
        assert_ne!(stored[0].id, stored[1].id);
        assert_eq!(span_text(TEXT, &stored[0].provenance), "Improve the capture screen.");
        assert_eq!(span_text(TEXT, &stored[1].provenance), "Email Ignatov tomorrow.");
        assert_eq!(store.list_knowledge_objects().unwrap(), stored);
        assert_eq!(store.distillation_for(&capture.id).unwrap(), Some(stored));
    }

    #[test]
    fn the_raw_capture_is_untouched_by_distillation() {
        let (store, capture) = store_with(TEXT);
        store.record_distillation(&capture.id, vec![object("note", "Whole", "All of it.", 0, 51)]).unwrap();
        assert_eq!(store.get_capture(&capture.id).unwrap(), Some(capture.clone()));
        assert_eq!(store.list().unwrap(), vec![capture]);
    }

    #[test]
    fn every_supported_kind_is_accepted() {
        let (store, capture) = store_with("idea task decision question note");
        let kinds = ["idea", "task", "decision", "question", "note"];
        let objects = kinds
            .iter()
            .enumerate()
            .map(|(i, kind)| {
                let start = ["idea ", "task ", "decision ", "question "].iter().take(i).map(|w| w.len() as i64).sum::<i64>();
                object(kind, "t", "b", start, start + kind.len() as i64)
            })
            .collect();
        let stored = store.record_distillation(&capture.id, objects).unwrap();
        assert_eq!(stored.iter().map(|o| o.kind.as_str()).collect::<Vec<_>>(), kinds);
    }

    fn rejected(content: &str, candidate: NewKnowledgeObject) {
        let (store, capture) = store_with(content);
        assert!(matches!(store.record_distillation(&capture.id, vec![candidate]), Err(StoreError::Invalid(_))));
        assert!(store.list_knowledge_objects().unwrap().is_empty(), "nothing is stored");
        assert_eq!(store.distillation_for(&capture.id).unwrap(), None, "a rejected attempt is not a run");
    }

    #[test]
    fn invalid_kinds_are_rejected() {
        for kind in ["gizmo", "", "Idea", "IDEA", "idea "] {
            rejected(TEXT, object(kind, "t", "b", 0, 5));
        }
    }

    #[test]
    fn empty_blank_and_oversized_titles_and_bodies_are_rejected() {
        rejected(TEXT, object("idea", "", "b", 0, 5));
        rejected(TEXT, object("idea", "  \n\t", "b", 0, 5));
        rejected(TEXT, object("idea", "t", "", 0, 5));
        rejected(TEXT, object("idea", "t", "   ", 0, 5));
        rejected(TEXT, object("idea", &"t".repeat(MAX_TITLE_CHARS + 1), "b", 0, 5));
        rejected(TEXT, object("idea", "t", &"b".repeat(MAX_BODY_CHARS + 1), 0, 5));
        let (store, capture) = store_with(TEXT);
        assert!(store.record_distillation(&capture.id, vec![object("idea", &"t".repeat(MAX_TITLE_CHARS), &"b".repeat(MAX_BODY_CHARS), 0, 5)]).is_ok());
    }

    #[test]
    fn provenance_must_reference_an_existing_capture() {
        let store = CaptureStore::open_in_memory().unwrap();
        let result = store.record_distillation("00000000-0000-4000-8000-000000000000", vec![object("idea", "t", "b", 0, 1)]);
        assert!(matches!(result, Err(StoreError::Invalid(reason)) if reason.contains("capture does not exist")));
        assert!(store.list_knowledge_objects().unwrap().is_empty());
    }

    #[test]
    fn invalid_source_spans_are_rejected() {
        let length = TEXT.chars().count() as i64;
        for (start, end) in [(-1, 5), (-10, -2), (5, 5), (9, 3), (0, length + 1), (length, length + 4), (0, 0)] {
            rejected(TEXT, object("idea", "t", "b", start, end));
        }
        rejected("abc   def", object("idea", "t", "b", 3, 6)); // span of whitespace only
    }

    #[test]
    fn spans_count_code_points_so_non_ascii_text_resolves_exactly() {
        let content = "Здравей 😀 свят";
        let (store, capture) = store_with(content);
        // "😀 свят": code points 8..14 (one emoji is one code point, two UTF-16 units, four bytes).
        let stored = store.record_distillation(&capture.id, vec![object("note", "Поздрав", "Поздрав.", 8, 14)]).unwrap();
        assert_eq!(span_text(content, &stored[0].provenance), "😀 свят");
        assert!(store.record_distillation(&store_with(content).1.id, vec![]).is_err(), "unknown capture in another store");
        let (other, other_capture) = store_with(content);
        let length = content.chars().count() as i64;
        assert!(other.record_distillation(&other_capture.id, vec![object("note", "t", "b", 0, length + 1)]).is_err());
        assert!(other.record_distillation(&other_capture.id, vec![object("note", "t", "b", 0, length)]).is_ok());
    }

    #[test]
    fn one_invalid_object_rolls_back_the_whole_set() {
        let (store, capture) = store_with(TEXT);
        let result = store.record_distillation(
            &capture.id,
            vec![object("idea", "ok", "ok", 0, 26), object("task", "bad span", "b", 27, 9_999), object("note", "ok too", "ok", 27, 51)],
        );
        assert!(matches!(result, Err(StoreError::Invalid(reason)) if reason.starts_with("object 1:")));
        assert!(store.list_knowledge_objects().unwrap().is_empty());
        assert_eq!(store.distillation_for(&capture.id).unwrap(), None);
        // The failed attempt did not use up the capture's one distillation.
        assert_eq!(store.record_distillation(&capture.id, vec![object("idea", "ok", "ok", 0, 26)]).unwrap().len(), 1);
    }

    #[test]
    fn a_database_failure_midway_leaves_no_partial_set() {
        let (store, capture) = store_with(TEXT);
        store
            .connection
            .lock()
            .unwrap()
            .execute_batch("CREATE TRIGGER poison BEFORE INSERT ON knowledge_objects WHEN NEW.title = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END;")
            .unwrap();

        let result = store.record_distillation(
            &capture.id,
            vec![object("idea", "first", "b", 0, 26), object("task", "boom", "b", 27, 51)],
        );

        assert!(matches!(result, Err(StoreError::Database(_))));
        let connection = store.connection.lock().unwrap();
        for table in ["distillation_runs", "knowledge_objects", "object_sources"] {
            let count: i64 = connection.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)).unwrap();
            assert_eq!(count, 0, "{table} must be empty after rollback");
        }
        drop(connection);
        assert_eq!(store.list().unwrap().len(), 1, "the capture survives");
    }

    #[test]
    fn distilling_twice_returns_the_first_set_and_never_duplicates() {
        let (store, capture) = store_with(TEXT);
        let first = store.record_distillation(&capture.id, vec![object("idea", "first", "b", 0, 26)]).unwrap();
        let second = store.record_distillation(&capture.id, vec![object("task", "different", "b", 27, 51), object("note", "more", "b", 0, 5)]).unwrap();

        assert_eq!(second, first);
        assert_eq!(store.list_knowledge_objects().unwrap(), first);
    }

    #[test]
    fn a_distillation_with_no_objects_is_a_valid_recorded_result() {
        let (store, capture) = store_with(TEXT);
        assert_eq!(store.distillation_for(&capture.id).unwrap(), None);
        assert_eq!(store.record_distillation(&capture.id, vec![]).unwrap(), vec![]);
        assert_eq!(store.distillation_for(&capture.id).unwrap(), Some(vec![]));
        assert_eq!(store.record_distillation(&capture.id, vec![object("idea", "late", "b", 0, 5)]).unwrap(), vec![]);
    }

    #[test]
    fn too_many_objects_are_rejected() {
        let (store, capture) = store_with(TEXT);
        let many = (0..=MAX_OBJECTS_PER_DISTILLATION).map(|_| object("note", "t", "b", 0, 5)).collect();
        assert!(matches!(store.record_distillation(&capture.id, many), Err(StoreError::Invalid(_))));
    }

    #[test]
    fn listing_is_newest_distillation_first_and_source_order_within_one() {
        let store = CaptureStore::open_in_memory().unwrap();
        let first = store.create(CreateCaptureInput { source: "text".into(), content: "alpha beta".into() }).unwrap();
        let second = store.create(CreateCaptureInput { source: "voice".into(), content: "gamma delta".into() }).unwrap();

        // Candidates are supplied out of order; the store keeps reading order.
        store.record_distillation(&first.id, vec![object("note", "beta", "b", 6, 10), object("note", "alpha", "b", 0, 5)]).unwrap();
        store.record_distillation(&second.id, vec![object("task", "delta", "b", 6, 11), object("idea", "gamma", "b", 0, 5)]).unwrap();

        let titles: Vec<String> = store.list_knowledge_objects().unwrap().into_iter().map(|o| o.title).collect();
        assert_eq!(titles, ["gamma", "delta", "alpha", "beta"]);
        assert_eq!(store.list_knowledge_objects().unwrap(), store.list_knowledge_objects().unwrap());
    }

    #[test]
    fn captures_cannot_be_rewritten_because_provenance_offsets_depend_on_their_text() {
        let (store, capture) = store_with(TEXT);
        let connection = store.connection.lock().unwrap();
        assert!(connection.execute("UPDATE captures SET content = 'changed' WHERE id = ?1", [&capture.id]).is_err());
        assert!(connection.execute("UPDATE captures SET created_at = 'x' WHERE id = ?1", [&capture.id]).is_err());
        drop(connection);
        assert_eq!(store.get_capture(&capture.id).unwrap(), Some(capture));
    }

    #[test]
    fn foreign_keys_are_enforced() {
        let (store, capture) = store_with(TEXT);
        store.record_distillation(&capture.id, vec![object("idea", "t", "b", 0, 5)]).unwrap();
        let connection = store.connection.lock().unwrap();

        let orphan = connection.execute("INSERT INTO distillation_runs (capture_id, created_at) VALUES ('missing', 'now')", []);
        assert!(orphan.is_err(), "a run needs an existing capture");
        let dangling = connection.execute("INSERT INTO object_sources (object_id, capture_id, source_start, source_end) VALUES ('nope', ?1, 0, 1)", [&capture.id]);
        assert!(dangling.is_err(), "a source needs an existing object");
        assert!(connection.execute("DELETE FROM captures WHERE id = ?1", [&capture.id]).is_err(), "a capture with objects cannot be deleted");
    }

    #[test]
    fn a_row_with_unresolvable_provenance_fails_the_listing() {
        let (store, capture) = store_with(TEXT);
        store.record_distillation(&capture.id, vec![object("idea", "t", "b", 0, 5)]).unwrap();
        {
            let connection = store.connection.lock().unwrap();
            // A faulty writer that bypassed the constraints.
            connection.execute_batch("PRAGMA ignore_check_constraints = ON; UPDATE object_sources SET source_end = 9999;").unwrap();
        }
        assert!(matches!(store.list_knowledge_objects(), Err(StoreError::Corrupt(_))));
    }

    #[test]
    fn an_object_without_a_source_row_fails_the_listing() {
        let (store, _capture) = store_with(TEXT);
        store
            .connection
            .lock()
            .unwrap()
            .execute("INSERT INTO knowledge_objects (id, kind, title, body, created_at) VALUES ('x', 'idea', 't', 'b', '2026-01-01T00:00:00Z')", [])
            .unwrap();
        assert!(matches!(store.list_knowledge_objects(), Err(StoreError::Corrupt(_))));
    }

    #[test]
    fn serializes_to_the_contract_shape() {
        let (store, capture) = store_with(TEXT);
        let stored = store.record_distillation(&capture.id, vec![object("idea", "t", "b", 0, 5)]).unwrap();
        let value = serde_json::to_value(&stored[0]).unwrap();
        let mut keys: Vec<&String> = value.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["body", "createdAt", "id", "kind", "provenance", "title"]);
        let mut provenance: Vec<&String> = value["provenance"].as_object().unwrap().keys().collect();
        provenance.sort();
        assert_eq!(provenance, ["captureId", "sourceEnd", "sourceStart"]);
    }
}
