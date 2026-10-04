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

pub type Step = (i64, &'static str);

/// Ordered migration steps: `(version after the step, SQL)`.
pub const STEPS: [Step; 2] = [(1, SCHEMA_V1), (2, SCHEMA_V2)];

/// The version `STEPS` ends at; asserted against `STEPS` by a test.
#[cfg(test)]
pub const SCHEMA_VERSION: i64 = 2;

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
    fn a_v1_database_upgrades_to_v2_and_keeps_every_capture() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v1_database(&path);

        let store = CaptureStore::open(&path).unwrap();

        let captures = store.list().unwrap();
        assert_eq!(captures.iter().map(|c| (c.id.as_str(), c.source.as_str(), c.content.as_str())).collect::<Vec<_>>(), [("c2", "voice", "второ нещо 😀"), ("c1", "text", "first thought")]);
        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), SCHEMA_VERSION);
        for table in ["distillation_runs", "knowledge_objects", "object_sources"] {
            assert!(has_object(&connection, "table", table), "{table}");
        }
        // And the upgraded database is fully usable for the new feature.
        let stored = store
            .record_distillation("c2", vec![crate::storage::knowledge_store::NewKnowledgeObject { kind: "note".into(), title: "t".into(), body: "b".into(), source_start: 0, source_end: 5 }])
            .unwrap();
        assert_eq!(stored.len(), 1);
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
