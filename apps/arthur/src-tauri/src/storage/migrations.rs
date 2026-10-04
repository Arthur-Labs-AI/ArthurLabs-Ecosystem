//! Versioned SQLite schema, tracked with `PRAGMA user_version`.
//!
//! Each step runs in its own transaction together with the version bump, so a
//! failing step rolls back completely and leaves the previous schema (and all
//! its data) usable. Running the migrator again on an up-to-date database does
//! nothing, and a database from a newer version is refused untouched.

use rusqlite::Connection;

use super::capture_store::StoreError;

/// v1 (M01B): raw captures.
///
/// `seq` gives a total insertion order, so listing is deterministic even when
/// two captures share a timestamp.
pub const SCHEMA_V1: &str = "
CREATE TABLE IF NOT EXISTS captures (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    id         TEXT    NOT NULL UNIQUE CHECK (length(id) > 0),
    source     TEXT    NOT NULL CHECK (source IN ('text', 'voice', 'emg')),
    content    TEXT    NOT NULL CHECK (length(content) > 0),
    created_at TEXT    NOT NULL CHECK (length(created_at) > 0)
);
";

/// v2 (M01D): knowledge objects interpreted from captures, with provenance.
///
/// Plain `CREATE TABLE` (no `IF NOT EXISTS`) on purpose: a pre-existing table of
/// the same name is a conflict to surface, not something to silently adopt.
pub const SCHEMA_V2: &str = "
-- A capture is raw input and never rewritten: offsets in object_sources would silently
-- stop pointing at the right text if its content could change.
CREATE TRIGGER captures_are_immutable BEFORE UPDATE ON captures
BEGIN
    SELECT RAISE(ABORT, 'captures are immutable');
END;

-- At most one distillation per capture. A run with zero objects is a valid, recorded result.
CREATE TABLE distillation_runs (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id TEXT    NOT NULL UNIQUE REFERENCES captures(id),
    created_at TEXT    NOT NULL CHECK (length(created_at) > 0)
);

CREATE TABLE knowledge_objects (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    id         TEXT    NOT NULL UNIQUE CHECK (length(id) > 0),
    kind       TEXT    NOT NULL CHECK (kind IN ('idea', 'task', 'decision', 'question', 'note')),
    title      TEXT    NOT NULL CHECK (length(trim(title)) > 0),
    body       TEXT    NOT NULL CHECK (length(trim(body)) > 0),
    created_at TEXT    NOT NULL CHECK (length(created_at) > 0)
);

-- Provenance: one contiguous span of the raw capture per object, as a half-open range of
-- Unicode code points.
CREATE TABLE object_sources (
    object_id    TEXT    PRIMARY KEY REFERENCES knowledge_objects(id) ON DELETE CASCADE,
    capture_id   TEXT    NOT NULL REFERENCES captures(id),
    source_start INTEGER NOT NULL CHECK (source_start >= 0),
    source_end   INTEGER NOT NULL CHECK (source_end > source_start)
);

CREATE INDEX object_sources_by_capture ON object_sources(capture_id);
";

/// v3 (M02): the Cognitive Graph. Typed edges between knowledge objects.
///
/// Distinct from `object_sources`: that table is Capture provenance (object -> raw text span);
/// this one relates objects to objects. Existing captures and objects are not touched.
///
/// The CHECKs repeat the domain invariants so a faulty writer cannot persist a malformed edge:
/// no self edge, and a symmetric kind is stored once with the smaller object id as the source
/// (SQLite's default BINARY collation orders text exactly as Rust compares `str`).
pub const SCHEMA_V3: &str = "
CREATE TABLE relations (
    seq              INTEGER PRIMARY KEY AUTOINCREMENT,
    id               TEXT    NOT NULL UNIQUE CHECK (length(id) > 0),
    kind             TEXT    NOT NULL CHECK (kind IN ('related_to', 'extends', 'depends_on', 'contradicts', 'derived_from', 'duplicates', 'supersedes')),
    source_object_id TEXT    NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
    target_object_id TEXT    NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
    origin           TEXT    NOT NULL CHECK (origin IN ('model', 'user', 'system')),
    created_at       TEXT    NOT NULL CHECK (length(created_at) > 0),
    CHECK (source_object_id <> target_object_id),
    CHECK (kind NOT IN ('related_to', 'contradicts', 'duplicates') OR source_object_id < target_object_id),
    -- Canonical identity of an edge. A pair may carry several kinds, but never the same one twice.
    UNIQUE (kind, source_object_id, target_object_id)
);

CREATE INDEX relations_by_source ON relations(source_object_id);
CREATE INDEX relations_by_target ON relations(target_object_id);
";

pub type Step = (i64, &'static str);

/// Ordered migration steps: `(version after the step, SQL)`.
pub const STEPS: [Step; 3] = [(1, SCHEMA_V1), (2, SCHEMA_V2), (3, SCHEMA_V3)];

/// The version `STEPS` ends at; asserted against `STEPS` by a test.
#[cfg(test)]
pub const SCHEMA_VERSION: i64 = 3;

pub fn migrate(connection: &mut Connection) -> Result<(), StoreError> {
    migrate_with(connection, &STEPS)
}

pub fn migrate_with(connection: &mut Connection, steps: &[Step]) -> Result<(), StoreError> {
    let current: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let latest = steps.last().map_or(0, |(version, _)| *version);
    if current > latest {
        return Err(StoreError::Corrupt(format!(
            "schema version {current} is newer than the supported version {latest}"
        )));
    }
    for (version, sql) in steps.iter().filter(|(version, _)| *version > current) {
        let transaction = connection.transaction()?;
        transaction.execute_batch(sql)?;
        transaction.pragma_update(None, "user_version", version)?;
        transaction.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::capture_store::{CaptureStore, CreateCaptureInput};

    fn user_version(connection: &Connection) -> i64 {
        connection.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
    }

    fn has_object(connection: &Connection, kind: &str, name: &str) -> bool {
        connection.query_row("SELECT count(*) FROM sqlite_master WHERE type = ?1 AND name = ?2", [kind, name], |r| r.get::<_, i64>(0)).unwrap() > 0
    }

    /// A database exactly as M01B/M01C left it: schema v1 with captures in it.
    fn v1_database(path: &std::path::Path) {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(&format!(
                "{SCHEMA_V1}
                 INSERT INTO captures (id, source, content, created_at) VALUES ('c1', 'text', 'first thought', '2026-10-04T10:00:00Z');
                 INSERT INTO captures (id, source, content, created_at) VALUES ('c2', 'voice', 'второ нещо 😀', '2026-10-04T10:05:00Z');
                 PRAGMA user_version = 1;"
            ))
            .unwrap();
    }

    #[test]
    fn a_v1_database_upgrades_to_the_latest_version_and_keeps_every_capture() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v1_database(&path);

        let store = CaptureStore::open(&path).unwrap();

        let captures = store.list().unwrap();
        assert_eq!(captures.iter().map(|c| (c.id.as_str(), c.source.as_str(), c.content.as_str())).collect::<Vec<_>>(), [("c2", "voice", "второ нещо 😀"), ("c1", "text", "first thought")]);
        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), SCHEMA_VERSION);
        for table in ["distillation_runs", "knowledge_objects", "object_sources", "relations"] {
            assert!(has_object(&connection, "table", table), "{table}");
        }
        // And the upgraded database is fully usable for the new feature.
        let stored = store
            .record_distillation("c2", vec![crate::storage::knowledge_store::NewKnowledgeObject { kind: "note".into(), title: "t".into(), body: "b".into(), source_start: 0, source_end: 5 }])
            .unwrap();
        assert_eq!(stored.len(), 1);
    }

    /// A database exactly as M01D left it: schema v2 with two captures, three objects and their provenance.
    fn v2_database(path: &std::path::Path) {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(&format!(
                "{SCHEMA_V1}
                 INSERT INTO captures (id, source, content, created_at) VALUES ('c1', 'text', 'first thought here', '2026-10-04T10:00:00Z');
                 INSERT INTO captures (id, source, content, created_at) VALUES ('c2', 'voice', 'второ нещо 😀', '2026-10-04T10:05:00Z');
                 PRAGMA user_version = 1;"
            ))
            .unwrap();
        connection
            .execute_batch(&format!(
                "{SCHEMA_V2}
                 INSERT INTO distillation_runs (capture_id, created_at) VALUES ('c1', '2026-10-04T10:01:00Z');
                 INSERT INTO distillation_runs (capture_id, created_at) VALUES ('c2', '2026-10-04T10:06:00Z');
                 INSERT INTO knowledge_objects (id, kind, title, body, created_at) VALUES ('11111111-1111-4111-8111-111111111111', 'idea', 'first', 'body one', '2026-10-04T10:01:00Z');
                 INSERT INTO knowledge_objects (id, kind, title, body, created_at) VALUES ('22222222-2222-4222-8222-222222222222', 'task', 'thought', 'body two', '2026-10-04T10:01:00Z');
                 INSERT INTO knowledge_objects (id, kind, title, body, created_at) VALUES ('33333333-3333-4333-8333-333333333333', 'note', 'нещо', 'body три', '2026-10-04T10:06:00Z');
                 INSERT INTO object_sources VALUES ('11111111-1111-4111-8111-111111111111', 'c1', 0, 5);
                 INSERT INTO object_sources VALUES ('22222222-2222-4222-8222-222222222222', 'c1', 6, 13);
                 INSERT INTO object_sources VALUES ('33333333-3333-4333-8333-333333333333', 'c2', 6, 10);
                 PRAGMA user_version = 2;"
            ))
            .unwrap();
    }

    #[test]
    fn a_v2_database_upgrades_to_v3_and_keeps_every_capture_object_and_provenance_row() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v2_database(&path);
        let before = {
            let store = Connection::open(&path).unwrap();
            dump(&store)
        };

        let store = CaptureStore::open(&path).unwrap();

        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), 3);
        assert_eq!(dump(&connection), before, "captures, objects and provenance are byte-for-byte unchanged");
        assert!(has_object(&connection, "table", "relations"));
        for index in ["relations_by_source", "relations_by_target"] {
            assert!(has_object(&connection, "index", index), "{index}");
        }
        let integrity: String = connection.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(integrity, "ok");
        let violations: i64 = connection.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
        assert_eq!(violations, 0);
        // The existing M01 reads still work, and the new graph is empty but usable on the migrated data.
        assert_eq!(store.list().unwrap().len(), 2);
        let objects = store.list_knowledge_objects().unwrap();
        assert_eq!(objects.len(), 3);
        assert!(store.list_relations().unwrap().is_empty());
        let relation = store
            .create_relation(
                crate::storage::relation_store::NewRelation { kind: "extends".into(), source_object_id: objects[0].id.clone(), target_object_id: objects[1].id.clone() },
                "user",
            )
            .unwrap();
        assert_eq!(store.list_relations().unwrap(), vec![relation]);
    }

    fn dump(connection: &Connection) -> Vec<String> {
        let mut rows = Vec::new();
        for (table, columns) in [
            ("captures", "id || '|' || source || '|' || content || '|' || created_at"),
            ("distillation_runs", "capture_id || '|' || created_at"),
            ("knowledge_objects", "id || '|' || kind || '|' || title || '|' || body || '|' || created_at"),
            ("object_sources", "object_id || '|' || capture_id || '|' || source_start || '|' || source_end"),
        ] {
            let mut statement = connection.prepare(&format!("SELECT {columns} FROM {table} ORDER BY 1")).unwrap();
            rows.extend(statement.query_map([], |r| r.get::<_, String>(0)).unwrap().map(|row| format!("{table}:{}", row.unwrap())));
        }
        rows
    }

    #[test]
    fn a_failing_v3_upgrade_rolls_back_completely_and_leaves_v2_usable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v2_database(&path);
        let before = dump(&Connection::open(&path).unwrap());
        {
            // A foreign table named like the one v3 creates, with an index name v3 also needs,
            // so the step fails after its first statement has already run.
            let connection = Connection::open(&path).unwrap();
            connection.execute_batch("CREATE TABLE zzz (x); CREATE INDEX relations_by_target ON zzz(x);").unwrap();
        }

        assert!(CaptureStore::open(&path).is_err());

        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), 2, "still v2");
        assert!(!has_object(&connection, "table", "relations"), "the step's earlier statements were rolled back");
        assert!(!has_object(&connection, "index", "relations_by_source"));
        assert_eq!(dump(&connection), before);
        // v2 is still fully writable.
        connection.execute("INSERT INTO captures (id, source, content, created_at) VALUES ('c3', 'text', 'still works', '2026-10-04T11:00:00Z')", []).unwrap();
    }

    #[test]
    fn a_database_newer_than_v3_is_refused_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v2_database(&path);
        Connection::open(&path).unwrap().pragma_update(None, "user_version", 4).unwrap();
        let before = dump(&Connection::open(&path).unwrap());

        assert!(matches!(CaptureStore::open(&path), Err(StoreError::Corrupt(_))));

        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), 4);
        assert!(!has_object(&connection, "table", "relations"));
        assert_eq!(dump(&connection), before);
    }

    #[test]
    fn a_fresh_database_goes_straight_to_the_latest_version() {
        let store = CaptureStore::open_in_memory().unwrap();
        assert_eq!(user_version(&store.connection.lock().unwrap()), SCHEMA_VERSION);
    }

    #[test]
    fn migrating_repeatedly_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v1_database(&path);
        for _ in 0..4 {
            CaptureStore::open(&path).unwrap();
        }
        let store = CaptureStore::open(&path).unwrap();
        assert_eq!(store.list().unwrap().len(), 2);
        assert_eq!(user_version(&Connection::open(&path).unwrap()), SCHEMA_VERSION);
    }

    #[test]
    fn a_failing_upgrade_rolls_back_completely_and_leaves_v1_intact() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v1_database(&path);
        {
            // A foreign table with a name v2 needs makes the second CREATE fail partway through the step.
            let connection = Connection::open(&path).unwrap();
            connection.execute_batch("CREATE TABLE knowledge_objects (precious TEXT); INSERT INTO knowledge_objects VALUES ('keep me');").unwrap();
        }

        assert!(CaptureStore::open(&path).is_err());

        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), 1, "still v1");
        assert!(!has_object(&connection, "table", "distillation_runs"), "the step's earlier statements were rolled back");
        assert!(!has_object(&connection, "trigger", "captures_are_immutable"));
        let kept: String = connection.query_row("SELECT precious FROM knowledge_objects", [], |r| r.get(0)).unwrap();
        assert_eq!(kept, "keep me");
        let captures: i64 = connection.query_row("SELECT count(*) FROM captures", [], |r| r.get(0)).unwrap();
        assert_eq!(captures, 2);
        // The previous schema is still writable.
        connection.execute("INSERT INTO captures (id, source, content, created_at) VALUES ('c3', 'text', 'still works', '2026-10-04T11:00:00Z')", []).unwrap();
    }

    #[test]
    fn steps_that_succeeded_before_a_failing_step_are_kept() {
        let mut connection = Connection::open_in_memory().unwrap();
        let steps: [Step; 3] = [(1, SCHEMA_V1), (2, SCHEMA_V2), (3, "CREATE TABLE extra (x); CREATE TABLE extra (x);")];

        assert!(migrate_with(&mut connection, &steps).is_err());

        assert_eq!(user_version(&connection), 2);
        assert!(has_object(&connection, "table", "knowledge_objects"));
        assert!(!has_object(&connection, "table", "extra"));
    }

    #[test]
    fn a_newer_database_is_refused_without_modification() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v1_database(&path);
        Connection::open(&path).unwrap().pragma_update(None, "user_version", SCHEMA_VERSION + 1).unwrap();

        assert!(matches!(CaptureStore::open(&path), Err(StoreError::Corrupt(_))));
        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), SCHEMA_VERSION + 1);
        assert!(!has_object(&connection, "table", "knowledge_objects"));
    }

    #[test]
    fn migration_steps_are_ordered_and_end_at_the_declared_version() {
        let versions: Vec<i64> = STEPS.iter().map(|(v, _)| *v).collect();
        assert_eq!(versions, (1..=SCHEMA_VERSION).collect::<Vec<_>>());
        let _ = CreateCaptureInput { source: "text".into(), content: "x".into() };
    }
}
