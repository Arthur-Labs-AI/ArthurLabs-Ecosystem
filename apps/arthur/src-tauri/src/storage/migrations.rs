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

/// v4 (M03): Thought Lineage. A DAG of immutable revisions per knowledge object.
///
/// AUTHORITY. `thought_revisions` is the history; `knowledge_objects.current_revision_id` says which revision the
/// object currently is. The object's kind/title/body columns stay (every existing read path keeps working) as a
/// PROJECTION of that revision. A trigger refuses any write that would make them differ from it, and reads verify it
/// again, so the two cannot drift.
///
/// SEPARATE FROM the graph (`relations`) and from Capture provenance (`object_sources`): a revision never
/// references a relation, and a revision's own `capture_id` span is set only when that revision's text was
/// genuinely interpreted from that Capture.
///
/// BOOTSTRAP. Every existing object gets exactly one initial revision, derived deterministically in SQL: its id is
/// the object's id with the UUID version nibble set to 8 (a valid UUID, unique because the mapping is injective),
/// so re-deriving it always yields the same id, it needs no random source, and nothing depends on migration order.
/// Its content, timestamp and source span are copied from the object and `object_sources`; nothing existing is
/// modified except the new `current_revision_id` pointer.
pub const SCHEMA_V4: &str = "
CREATE TABLE thought_revisions (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    id           TEXT    NOT NULL UNIQUE CHECK (length(id) > 0),
    object_id    TEXT    NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
    kind         TEXT    NOT NULL CHECK (kind IN ('idea', 'task', 'decision', 'question', 'note')),
    title        TEXT    NOT NULL CHECK (length(trim(title)) > 0),
    body         TEXT    NOT NULL CHECK (length(trim(body)) > 0),
    origin       TEXT    NOT NULL CHECK (origin IN ('initial', 'user_edit', 'distillation', 'merge', 'system')),
    created_at   TEXT    NOT NULL CHECK (length(created_at) > 0),
    -- Where THIS revision's text came from in a raw capture, if it genuinely did. All three or none.
    capture_id   TEXT    REFERENCES captures(id),
    source_start INTEGER,
    source_end   INTEGER,
    CHECK (
        (capture_id IS NULL AND source_start IS NULL AND source_end IS NULL)
        OR (capture_id IS NOT NULL AND source_start >= 0 AND source_end > source_start)
    )
);

CREATE INDEX thought_revisions_by_object ON thought_revisions(object_id, seq);
-- An object has exactly one root.
CREATE UNIQUE INDEX one_initial_revision_per_object ON thought_revisions(object_id) WHERE origin = 'initial';

CREATE TABLE revision_parents (
    child_revision_id  TEXT NOT NULL REFERENCES thought_revisions(id) ON DELETE CASCADE,
    parent_revision_id TEXT NOT NULL REFERENCES thought_revisions(id) ON DELETE CASCADE,
    PRIMARY KEY (child_revision_id, parent_revision_id),
    CHECK (child_revision_id <> parent_revision_id)
) WITHOUT ROWID;

CREATE INDEX revision_parents_by_parent ON revision_parents(parent_revision_id);

ALTER TABLE knowledge_objects ADD COLUMN current_revision_id TEXT REFERENCES thought_revisions(id);

-- Bootstrap: one initial revision per existing object, in object order.
INSERT INTO thought_revisions (id, object_id, kind, title, body, origin, created_at, capture_id, source_start, source_end)
SELECT substr(o.id, 1, 14) || '8' || substr(o.id, 16), o.id, o.kind, o.title, o.body, 'initial', o.created_at,
       s.capture_id, s.source_start, s.source_end
FROM knowledge_objects o
LEFT JOIN object_sources s ON s.object_id = o.id
ORDER BY o.seq;

UPDATE knowledge_objects SET current_revision_id = substr(id, 1, 14) || '8' || substr(id, 16);

-- History is append-only.
CREATE TRIGGER thought_revisions_are_immutable BEFORE UPDATE ON thought_revisions
BEGIN
    SELECT RAISE(ABORT, 'revisions are immutable');
END;

CREATE TRIGGER revision_parents_are_immutable BEFORE UPDATE ON revision_parents
BEGIN
    SELECT RAISE(ABORT, 'revision parents are immutable');
END;

-- A parent belongs to the same object as its child, and is OLDER than it. Because every edge points to an older
-- revision, a cycle is structurally impossible; the explicit cycle check below says so in words and also
-- covers a faulty writer that disables the ordering.
CREATE TRIGGER revision_parents_same_object BEFORE INSERT ON revision_parents
WHEN (SELECT object_id FROM thought_revisions WHERE id = NEW.child_revision_id)
     IS NOT (SELECT object_id FROM thought_revisions WHERE id = NEW.parent_revision_id)
BEGIN
    SELECT RAISE(ABORT, 'a parent revision must belong to the same object');
END;

CREATE TRIGGER revision_parents_parent_is_older BEFORE INSERT ON revision_parents
WHEN (SELECT seq FROM thought_revisions WHERE id = NEW.parent_revision_id)
     >= (SELECT seq FROM thought_revisions WHERE id = NEW.child_revision_id)
BEGIN
    SELECT RAISE(ABORT, 'a parent revision must be older than its child');
END;

CREATE TRIGGER revision_parents_are_acyclic BEFORE INSERT ON revision_parents
WHEN EXISTS (
    WITH RECURSIVE descendants(id) AS (
        SELECT NEW.child_revision_id
        UNION
        SELECT p.child_revision_id FROM revision_parents p JOIN descendants d ON p.parent_revision_id = d.id
    )
    SELECT 1 FROM descendants WHERE id = NEW.parent_revision_id
)
BEGIN
    SELECT RAISE(ABORT, 'a revision cannot be its own ancestor');
END;

-- The projection guard: an object's kind/title/body always equal its current revision, which belongs to it.
CREATE TRIGGER knowledge_objects_equal_their_current_revision
BEFORE UPDATE OF kind, title, body, current_revision_id ON knowledge_objects
WHEN NOT EXISTS (
    SELECT 1 FROM thought_revisions r
    WHERE r.id = NEW.current_revision_id AND r.object_id = NEW.id
      AND r.kind = NEW.kind AND r.title = NEW.title AND r.body = NEW.body
)
BEGIN
    SELECT RAISE(ABORT, 'an object must equal its current revision');
END;
";

/// v5 (M03.1B-2): durable organization failures.
///
/// Whether a capture was organized is already durable: `distillation_runs` has a row exactly when a distillation
/// succeeded, including one that found no objects. What was missing is a failed attempt, so a failure survived only
/// in memory and a relaunch could not tell "organizing failed" from "never tried". This table records the latest
/// failure per capture and nothing else: no job queue, no attempt history, and no copy of the capture or the model's
/// output. A success deletes the row in the same transaction that writes the run, so the two can never disagree.
/// Existing tables and rows are not touched. `capture_not_found` is not storable: there is no capture to attach it to.
pub const SCHEMA_V5: &str = "
CREATE TABLE organization_failures (
    capture_id TEXT PRIMARY KEY REFERENCES captures(id),
    code       TEXT NOT NULL CHECK (code IN ('llm_not_configured', 'llm_failed', 'llm_refused', 'llm_invalid_output', 'storage_failed')),
    message    TEXT NOT NULL CHECK (length(message) > 0),
    failed_at  TEXT NOT NULL CHECK (length(failed_at) > 0)
);
";

/// The id of the system Inbox project. Fixed, so every database (fresh or migrated, on any device) agrees on it and
/// the migration needs no random source.
pub const INBOX_PROJECT_ID: &str = "00000000-0000-4000-8000-000000000001";

/// v6 (M03.2): Projects / Knowledge Spaces.
///
/// A project is a real domain boundary that owns Captures and KnowledgeObjects. Ownership is ONE column on each of those
/// two tables. Nothing else carries a project: a revision belongs to the project of its object, a relation derives the
/// projects of its two endpoints, and provenance (`object_sources`) stays independent of membership.
///
/// INBOX. Exactly one system project, with a fixed id. It can be neither deleted nor archived nor renamed (triggers),
/// so a project always exists. Migration is deterministic: every existing capture and object moves to Inbox; no model
/// guesses anything and no relation, revision, provenance or organization row is touched.
///
/// NOT NULL. SQLite refuses `ADD COLUMN ... NOT NULL REFERENCES` without a default, and a non-NULL default is refused for
/// a foreign key, so the columns are added nullable, backfilled, and then guarded by triggers that refuse a NULL
/// project or an archived target on insert and on any change of the column. A project that still owns rows cannot be
/// deleted either (plain foreign key), so rows can never be orphaned.
///
/// CAPTURES stay immutable in every column but `project_id`: the v2 trigger fired on ANY update, so it is replaced by
/// one that fires on the content columns only. Moving a capture is organizational context, not a change of what was said.
///
/// ACTIVE PROJECT is one row in `active_project`, validated by the foreign key; reads fall back to Inbox.
pub const SCHEMA_V6: &str = "
CREATE TABLE projects (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    id          TEXT    NOT NULL UNIQUE CHECK (length(id) > 0),
    name        TEXT    NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 80),
    created_at  TEXT    NOT NULL CHECK (length(created_at) > 0),
    updated_at  TEXT    NOT NULL CHECK (length(updated_at) > 0),
    archived_at TEXT    CHECK (archived_at IS NULL OR length(archived_at) > 0),
    CHECK (id <> '00000000-0000-4000-8000-000000000001' OR archived_at IS NULL)
);

INSERT INTO projects (id, name, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000001', 'Inbox', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z');

CREATE TRIGGER projects_keep_the_inbox_on_delete BEFORE DELETE ON projects
WHEN OLD.id = '00000000-0000-4000-8000-000000000001'
BEGIN
    SELECT RAISE(ABORT, 'the Inbox cannot be deleted');
END;

CREATE TRIGGER projects_keep_the_inbox_on_update BEFORE UPDATE ON projects
WHEN OLD.id = '00000000-0000-4000-8000-000000000001' AND (NEW.id <> OLD.id OR NEW.name <> OLD.name OR NEW.archived_at IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'the Inbox cannot be renamed or archived');
END;

ALTER TABLE captures ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE knowledge_objects ADD COLUMN project_id TEXT REFERENCES projects(id);

-- The v2 trigger refused every update. Replace it: only project membership may change.
DROP TRIGGER captures_are_immutable;
CREATE TRIGGER captures_are_immutable BEFORE UPDATE OF id, seq, source, content, created_at ON captures
BEGIN
    SELECT RAISE(ABORT, 'captures are immutable');
END;

UPDATE captures SET project_id = '00000000-0000-4000-8000-000000000001';
UPDATE knowledge_objects SET project_id = '00000000-0000-4000-8000-000000000001';

CREATE INDEX captures_by_project ON captures(project_id, seq);
CREATE INDEX knowledge_objects_by_project ON knowledge_objects(project_id, seq);

CREATE TRIGGER captures_need_an_open_project_on_insert BEFORE INSERT ON captures
WHEN NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND archived_at IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'a capture needs an existing, unarchived project');
END;

CREATE TRIGGER captures_need_an_open_project_on_move BEFORE UPDATE OF project_id ON captures
WHEN NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND archived_at IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'a capture needs an existing, unarchived project');
END;

CREATE TRIGGER objects_need_an_open_project_on_insert BEFORE INSERT ON knowledge_objects
WHEN NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND archived_at IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'an object needs an existing, unarchived project');
END;

CREATE TRIGGER objects_need_an_open_project_on_move BEFORE UPDATE OF project_id ON knowledge_objects
WHEN NEW.project_id IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND archived_at IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'an object needs an existing, unarchived project');
END;

CREATE TABLE active_project (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    project_id TEXT    NOT NULL REFERENCES projects(id)
);
";


/// v7 (M04B): Cognitive Recall retrieval indexes. ADDITIVE: no v1-v6 table, trigger or row is touched, and every object created
/// here is a REBUILDABLE PROJECTION of authoritative data (see docs/architecture/cognitive-recall/storage-plan.md).
///
/// * `recall_revision_fts` is a lexical index over `thought_revisions`. Revisions are immutable (their update trigger
///   aborts), so the index is insert-only. Which revision is "current" is decided at query time by
///   `knowledge_objects.current_revision_id`, and the project by `knowledge_objects.project_id`; neither is stored here, so
///   an edit, a branch, a merge, a project move or an archive needs no index maintenance.
/// * `recall_embeddings` holds at most one vector per (object, model key) for the CURRENT projection of an object. It is valid
///   only while `revision_id = knowledge_objects.current_revision_id`. It carries no project: moving an object never touches it.
/// * `recall_meta` holds index facts only. The user's consent to semantic Recall is NOT stored in the database (a rebuildable
///   projection must not own a privacy choice); it lives in app-private settings.
pub const SCHEMA_V7: &str = "
CREATE VIRTUAL TABLE recall_revision_fts USING fts5(
    title, body,
    content = 'thought_revisions',
    content_rowid = 'seq',
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER recall_fts_after_revision_insert AFTER INSERT ON thought_revisions
BEGIN
    INSERT INTO recall_revision_fts(rowid, title, body) VALUES (NEW.seq, NEW.title, NEW.body);
END;

CREATE TRIGGER recall_fts_after_revision_delete AFTER DELETE ON thought_revisions
BEGIN
    INSERT INTO recall_revision_fts(recall_revision_fts, rowid, title, body) VALUES ('delete', OLD.seq, OLD.title, OLD.body);
END;

INSERT INTO recall_revision_fts(recall_revision_fts) VALUES ('rebuild');

CREATE TABLE recall_embeddings (
    object_id   TEXT    NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
    model_key   TEXT    NOT NULL CHECK (length(model_key) > 0),
    revision_id TEXT    NOT NULL REFERENCES thought_revisions(id) ON DELETE CASCADE,
    dims        INTEGER NOT NULL CHECK (dims > 0),
    vector      BLOB    NOT NULL CHECK (length(vector) = dims * 4),
    text_hash   TEXT    NOT NULL CHECK (length(text_hash) > 0),
    created_at  TEXT    NOT NULL CHECK (length(created_at) > 0),
    PRIMARY KEY (object_id, model_key)
);

CREATE INDEX recall_embeddings_by_model_revision ON recall_embeddings(model_key, revision_id);

CREATE TABLE recall_meta (
    key   TEXT PRIMARY KEY CHECK (length(key) > 0),
    value TEXT NOT NULL
);

INSERT INTO recall_meta (key, value) VALUES ('fts_tokenizer_version', 'unicode61-remove_diacritics2-v1');
";

pub type Step = (i64, &'static str);

/// Ordered migration steps: `(version after the step, SQL)`.
pub const STEPS: [Step; 7] = [(1, SCHEMA_V1), (2, SCHEMA_V2), (3, SCHEMA_V3), (4, SCHEMA_V4), (5, SCHEMA_V5), (6, SCHEMA_V6), (7, SCHEMA_V7)];

/// The version `STEPS` ends at; asserted against `STEPS` by a test.
#[cfg(test)]
pub const SCHEMA_VERSION: i64 = 7;

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
        assert_eq!(user_version(&connection), SCHEMA_VERSION);
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
    fn a_database_newer_than_the_latest_is_refused_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v2_database(&path);
        Connection::open(&path).unwrap().pragma_update(None, "user_version", SCHEMA_VERSION + 1).unwrap();
        let before = dump(&Connection::open(&path).unwrap());

        assert!(matches!(CaptureStore::open(&path), Err(StoreError::Corrupt(_))));

        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), SCHEMA_VERSION + 1);
        assert!(!has_object(&connection, "table", "relations"));
        assert_eq!(dump(&connection), before);
    }

    /// A database exactly as M02/M02.1 left it: schema v3 with captures, objects, provenance and graph relations.
    fn v3_database(path: &std::path::Path) {
        v2_database(path);
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(&format!(
                "{SCHEMA_V3}
                 INSERT INTO relations (id, kind, source_object_id, target_object_id, origin, created_at) VALUES ('rel-1', 'extends', '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'user', '2026-10-04T10:10:00Z');
                 INSERT INTO relations (id, kind, source_object_id, target_object_id, origin, created_at) VALUES ('rel-2', 'related_to', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', 'model', '2026-10-04T10:11:00Z');
                 PRAGMA user_version = 3;"
            ))
            .unwrap();
    }

    /// `dump` never reads `project_id`, so it already ignores the column v6 added; kept as an explicit marker.
    fn strip_project(rows: Vec<String>) -> Vec<String> {
        rows
    }

    fn relations_dump(connection: &Connection) -> Vec<String> {
        let mut statement = connection.prepare("SELECT id || '|' || kind || '|' || source_object_id || '|' || target_object_id || '|' || origin || '|' || created_at FROM relations ORDER BY seq").unwrap();
        statement.query_map([], |r| r.get::<_, String>(0)).unwrap().map(|r| r.unwrap()).collect()
    }

    #[test]
    fn a_v3_database_upgrades_to_v4_and_gives_every_object_exactly_one_initial_revision() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v3_database(&path);
        let (before, before_relations) = {
            let connection = Connection::open(&path).unwrap();
            assert_eq!(user_version(&connection), 3);
            (dump(&connection), relations_dump(&connection))
        };

        let store = CaptureStore::open(&path).unwrap();

        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), SCHEMA_VERSION);
        assert_eq!(strip_project(dump(&connection)), before, "captures, runs, objects and provenance are unchanged");
        assert_eq!(relations_dump(&connection), before_relations, "graph relations are unchanged");
        let integrity: String = connection.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(integrity, "ok");
        let violations: i64 = connection.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
        assert_eq!(violations, 0);
        for table in ["thought_revisions", "revision_parents"] {
            assert!(has_object(&connection, "table", table), "{table}");
        }
        for index in ["thought_revisions_by_object", "revision_parents_by_parent", "one_initial_revision_per_object"] {
            assert!(has_object(&connection, "index", index), "{index}");
        }

        // Exactly one initial revision per object, deterministic id, copied content, time and source span.
        let objects: i64 = connection.query_row("SELECT count(*) FROM knowledge_objects", [], |r| r.get(0)).unwrap();
        let revisions: i64 = connection.query_row("SELECT count(*) FROM thought_revisions", [], |r| r.get(0)).unwrap();
        assert_eq!((objects, revisions), (3, 3));
        let mismatched: i64 = connection
            .query_row(
                "SELECT count(*) FROM knowledge_objects o
                 LEFT JOIN thought_revisions r ON r.id = o.current_revision_id
                 LEFT JOIN object_sources s ON s.object_id = o.id
                 WHERE r.id IS NULL OR r.object_id <> o.id OR r.origin <> 'initial'
                    OR r.id <> substr(o.id, 1, 14) || '8' || substr(o.id, 16)
                    OR r.kind <> o.kind OR r.title <> o.title OR r.body <> o.body OR r.created_at <> o.created_at
                    OR r.capture_id IS NOT s.capture_id OR r.source_start IS NOT s.source_start OR r.source_end IS NOT s.source_end",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(mismatched, 0);
        let parents: i64 = connection.query_row("SELECT count(*) FROM revision_parents", [], |r| r.get(0)).unwrap();
        assert_eq!(parents, 0, "initial revisions have no parents");
        // The existing reads still work on the upgraded data.
        assert_eq!(store.list_knowledge_objects().unwrap().len(), 3);
        assert_eq!(store.list_relations().unwrap().len(), 2);
    }

    #[test]
    fn the_bootstrap_is_deterministic_idempotent_and_survives_repeated_opens() {
        let revision_rows = |path: &std::path::Path| -> Vec<String> {
            let connection = Connection::open(path).unwrap();
            let mut statement = connection.prepare("SELECT id || '|' || object_id || '|' || origin || '|' || created_at || '|' || ifnull(capture_id, '-') FROM thought_revisions ORDER BY seq").unwrap();
            statement.query_map([], |r| r.get::<_, String>(0)).unwrap().map(|r| r.unwrap()).collect()
        };
        let dir = tempfile::tempdir().unwrap();
        let (first, second) = (dir.path().join("a.db"), dir.path().join("b.db"));
        v3_database(&first);
        v3_database(&second);
        CaptureStore::open(&first).unwrap();
        CaptureStore::open(&second).unwrap();
        assert_eq!(revision_rows(&first), revision_rows(&second), "two independent migrations derive identical revisions");

        let once = revision_rows(&first);
        for _ in 0..4 {
            CaptureStore::open(&first).unwrap();
        }
        assert_eq!(revision_rows(&first), once, "re-opening never adds or changes a revision");
        assert_eq!(user_version(&Connection::open(&first).unwrap()), SCHEMA_VERSION);
    }

    #[test]
    fn a_failing_v4_upgrade_rolls_back_completely_and_leaves_v3_usable() {
        for blocker in ["CREATE TABLE thought_revisions (precious TEXT); INSERT INTO thought_revisions VALUES ('keep me');", "CREATE TABLE revision_parents (precious TEXT); INSERT INTO revision_parents VALUES ('keep me');"] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("arthur.db");
            v3_database(&path);
            let before = {
                let connection = Connection::open(&path).unwrap();
                connection.execute_batch(blocker).unwrap();
                (dump(&connection), relations_dump(&connection))
            };

            assert!(CaptureStore::open(&path).is_err(), "{blocker}");

            let connection = Connection::open(&path).unwrap();
            assert_eq!(user_version(&connection), 3, "still v3");
            assert_eq!((dump(&connection), relations_dump(&connection)), before, "nothing of the failed step survived");
            for trigger in ["knowledge_objects_equal_their_current_revision", "thought_revisions_are_immutable", "revision_parents_are_acyclic"] {
                assert!(!has_object(&connection, "trigger", trigger), "{trigger} was rolled back");
            }
            let has_pointer: i64 = connection.query_row("SELECT count(*) FROM pragma_table_info('knowledge_objects') WHERE name = 'current_revision_id'", [], |r| r.get(0)).unwrap();
            assert_eq!(has_pointer, 0, "the new column was rolled back too");
            // v3 is still fully writable.
            connection.execute("INSERT INTO captures (id, source, content, created_at) VALUES ('c3', 'text', 'still works', '2026-10-04T11:00:00Z')", []).unwrap();
        }
    }

    /// A database exactly as M03 left it: schema v4 with captures, objects, provenance, relations and revisions.
    fn v4_database(path: &std::path::Path) {
        v3_database(path);
        let mut connection = Connection::open(path).unwrap();
        migrate_with(&mut connection, &STEPS[..4]).unwrap();
        assert_eq!(user_version(&connection), 4);
    }

    #[test]
    fn a_v4_database_upgrades_to_v5_and_every_existing_row_is_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v4_database(&path);
        let (before, before_relations, revisions) = {
            let connection = Connection::open(&path).unwrap();
            let revisions: i64 = connection.query_row("SELECT count(*) FROM thought_revisions", [], |r| r.get(0)).unwrap();
            (dump(&connection), relations_dump(&connection), revisions)
        };

        {
            let mut connection = Connection::open(&path).unwrap();
            migrate_with(&mut connection, &STEPS[..5]).unwrap();
        }
        let store = CaptureStore::open(&path).unwrap();
        // (Opening migrates on to the latest version; this test is about the v5 step, so look at what v5 added.)
        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), SCHEMA_VERSION);
        assert!(has_object(&connection, "table", "organization_failures"));
        assert_eq!(strip_project(dump(&connection)), before, "captures, runs, objects and provenance are unchanged");
        assert_eq!(relations_dump(&connection), before_relations, "graph relations are unchanged");
        let after: i64 = connection.query_row("SELECT count(*) FROM thought_revisions", [], |r| r.get(0)).unwrap();
        assert_eq!(after, revisions, "lineage is unchanged");
        let failures: i64 = connection.query_row("SELECT count(*) FROM organization_failures", [], |r| r.get(0)).unwrap();
        assert_eq!(failures, 0, "the upgrade invents no failure");
        let integrity: String = connection.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(integrity, "ok");
        // Existing runs read as succeeded, and a capture without one as pending: nothing was lost or invented.
        let states = store.list_organization_states().unwrap();
        assert!(states.iter().all(|s| s.status == "succeeded" || s.status == "pending"));
    }

    #[test]
    fn a_failing_v5_upgrade_rolls_back_completely_and_leaves_v4_usable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v4_database(&path);
        let before = {
            let connection = Connection::open(&path).unwrap();
            connection.execute_batch("CREATE TABLE organization_failures (precious TEXT); INSERT INTO organization_failures VALUES ('keep me');").unwrap();
            (dump(&connection), relations_dump(&connection))
        };

        let mut connection = Connection::open(&path).unwrap();
        assert!(migrate_with(&mut connection, &STEPS[..5]).is_err());
        drop(connection);

        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), 4, "still v4");
        assert_eq!((dump(&connection), relations_dump(&connection)), before);
        let kept: String = connection.query_row("SELECT precious FROM organization_failures", [], |r| r.get(0)).unwrap();
        assert_eq!(kept, "keep me");
        connection.execute("INSERT INTO captures (id, source, content, created_at) VALUES ('c9', 'text', 'still works', '2026-10-04T12:00:00Z')", []).unwrap();
    }

    #[test]
    fn a_database_newer_than_the_code_is_refused_untouched_even_when_it_is_only_one_ahead() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v4_database(&path);
        Connection::open(&path).unwrap().pragma_update(None, "user_version", SCHEMA_VERSION + 1).unwrap();
        let before = dump(&Connection::open(&path).unwrap());
        assert!(matches!(CaptureStore::open(&path), Err(StoreError::Corrupt(_))));
        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), SCHEMA_VERSION + 1);
        assert!(!has_object(&connection, "table", "organization_failures"));
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

    // ---- v6: Projects ---------------------------------------------------------------------------------------------

    /// A populated database exactly as M03.1B left it: schema v5, with revisions beyond the initial ones, a relation,
    /// a zero-object run and a recorded organization failure.
    fn v5_database(path: &std::path::Path) {
        v4_database(path);
        let mut connection = Connection::open(path).unwrap();
        migrate_with(&mut connection, &STEPS[..5]).unwrap();
        connection
            .execute_batch(
                "INSERT INTO captures (id, source, content, created_at) VALUES ('c3', 'text', 'never organized', '2026-10-04T11:00:00Z');
                 INSERT INTO captures (id, source, content, created_at) VALUES ('c4', 'text', 'nothing here', '2026-10-04T11:05:00Z');
                 INSERT INTO distillation_runs (capture_id, created_at) VALUES ('c4', '2026-10-04T11:06:00Z');
                 INSERT INTO captures (id, source, content, created_at) VALUES ('c5', 'voice', 'failed once', '2026-10-04T11:10:00Z');
                 INSERT INTO organization_failures (capture_id, code, message, failed_at) VALUES ('c5', 'llm_failed', 'try again', '2026-10-04T11:11:00Z');",
            )
            .unwrap();
    }

    /// Everything v6 must leave alone, as one fingerprint.
    fn fingerprint(connection: &Connection) -> Vec<String> {
        let mut rows = dump(connection);
        rows.extend(relations_dump(connection));
        for (table, columns, order) in [
            ("thought_revisions", "id || '|' || object_id || '|' || kind || '|' || title || '|' || body || '|' || origin || '|' || created_at || '|' || ifnull(capture_id, '-') || '|' || ifnull(source_start, '-') || '|' || ifnull(source_end, '-')", "seq"),
            ("revision_parents", "child_revision_id || '|' || parent_revision_id", "1"),
            ("organization_failures", "capture_id || '|' || code || '|' || message || '|' || failed_at", "1"),
        ] {
            let mut statement = connection.prepare(&format!("SELECT {columns} FROM {table} ORDER BY {order}")).unwrap();
            rows.extend(statement.query_map([], |r| r.get::<_, String>(0)).unwrap().map(|row| format!("{table}:{}", row.unwrap())));
        }
        let mut statement = connection.prepare("SELECT id || '|' || current_revision_id FROM knowledge_objects ORDER BY seq").unwrap();
        rows.extend(statement.query_map([], |r| r.get::<_, String>(0)).unwrap().map(|row| format!("current:{}", row.unwrap())));
        rows
    }

    #[test]
    fn a_populated_v5_database_upgrades_to_v6_with_everything_in_the_inbox_and_nothing_else_changed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v5_database(&path);
        let before = {
            let connection = Connection::open(&path).unwrap();
            assert_eq!(user_version(&connection), 5);
            fingerprint(&connection)
        };
        assert!(before.len() > 15, "the fixture is populated");

        let store = CaptureStore::open(&path).unwrap();

        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), SCHEMA_VERSION);
        assert_eq!(fingerprint(&connection), before, "captures, objects, provenance, relations, revisions, runs and failures are unchanged");
        let (captures, objects, in_inbox): (i64, i64, i64) = connection
            .query_row(
                "SELECT (SELECT count(*) FROM captures), (SELECT count(*) FROM knowledge_objects), \
                        (SELECT count(*) FROM captures WHERE project_id = ?1) + (SELECT count(*) FROM knowledge_objects WHERE project_id = ?1)",
                [INBOX_PROJECT_ID],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((captures, objects), (5, 3));
        assert_eq!(in_inbox, captures + objects, "every capture and object is in the Inbox");
        let projects: Vec<(String, String)> = connection.prepare("SELECT id, name FROM projects").unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(projects, [(INBOX_PROJECT_ID.to_string(), "Inbox".to_string())], "the Inbox is the only project");
        let integrity: String = connection.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(integrity, "ok");
        let violations: i64 = connection.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
        assert_eq!(violations, 0);
        assert_eq!(store.active_project_id().unwrap(), INBOX_PROJECT_ID);
        // The upgraded data reads back through the normal paths, now with the project.
        assert!(store.list().unwrap().iter().all(|c| c.project_id == INBOX_PROJECT_ID));
        assert!(store.list_knowledge_objects().unwrap().iter().all(|o| o.project_id == INBOX_PROJECT_ID));
        assert_eq!(store.list_organization_states().unwrap().iter().filter(|s| s.status == "failed").count(), 1);
    }

    #[test]
    fn the_v6_migration_is_deterministic_and_repeating_it_changes_nothing() {
        let rows = |path: &std::path::Path| -> Vec<String> {
            let connection = Connection::open(path).unwrap();
            let mut statement = connection.prepare("SELECT id || '|' || name || '|' || created_at || '|' || updated_at || '|' || ifnull(archived_at, '-') FROM projects ORDER BY seq").unwrap();
            let mut rows: Vec<String> = statement.query_map([], |r| r.get::<_, String>(0)).unwrap().map(|r| r.unwrap()).collect();
            rows.extend(fingerprint(&connection));
            rows
        };
        let dir = tempfile::tempdir().unwrap();
        let (first, second) = (dir.path().join("a.db"), dir.path().join("b.db"));
        v5_database(&first);
        v5_database(&second);
        CaptureStore::open(&first).unwrap();
        CaptureStore::open(&second).unwrap();
        assert_eq!(rows(&first), rows(&second), "two independent migrations agree, Inbox included");
        let once = rows(&first);
        for _ in 0..3 {
            CaptureStore::open(&first).unwrap();
        }
        assert_eq!(rows(&first), once);
        // And a database that never had data gets the same Inbox.
        let fresh = CaptureStore::open_in_memory().unwrap();
        assert_eq!(fresh.list_projects(true).unwrap().iter().map(|p| (p.id.as_str(), p.name.as_str())).collect::<Vec<_>>(), [(INBOX_PROJECT_ID, "Inbox")]);
    }

    #[test]
    fn a_failing_v6_upgrade_rolls_back_completely_and_leaves_v5_usable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v5_database(&path);
        let before = {
            let connection = Connection::open(&path).unwrap();
            connection.execute_batch("CREATE TABLE active_project (precious TEXT); INSERT INTO active_project VALUES ('keep me');").unwrap();
            fingerprint(&connection)
        };

        assert!(CaptureStore::open(&path).is_err(), "the last statement of the step fails");

        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), 5, "still v5");
        assert_eq!(fingerprint(&connection), before);
        assert!(!has_object(&connection, "table", "projects"), "the earlier statements were rolled back");
        for table in ["captures", "knowledge_objects"] {
            let has_column: i64 = connection.query_row(&format!("SELECT count(*) FROM pragma_table_info('{table}') WHERE name = 'project_id'"), [], |r| r.get(0)).unwrap();
            assert_eq!(has_column, 0, "{table} has no project column");
        }
        // The v2 immutability trigger is back as it was, and v5 still writes.
        assert!(connection.execute("UPDATE captures SET content = 'x' WHERE id = 'c1'", []).is_err());
        connection.execute("INSERT INTO captures (id, source, content, created_at) VALUES ('c9', 'text', 'still works', '2026-10-04T12:00:00Z')", []).unwrap();
    }

    #[test]
    fn the_inbox_cannot_be_deleted_archived_or_renamed_and_a_project_that_owns_rows_cannot_be_deleted() {
        let store = CaptureStore::open_in_memory().unwrap();
        let connection = store.connection.lock().unwrap();
        assert!(connection.execute("DELETE FROM projects WHERE id = ?1", [INBOX_PROJECT_ID]).is_err());
        assert!(connection.execute("UPDATE projects SET archived_at = '2026-10-05T00:00:00Z' WHERE id = ?1", [INBOX_PROJECT_ID]).is_err());
        assert!(connection.execute("UPDATE projects SET name = 'Elsewhere' WHERE id = ?1", [INBOX_PROJECT_ID]).is_err());
        assert!(connection.execute("UPDATE projects SET id = 'other' WHERE id = ?1", [INBOX_PROJECT_ID]).is_err());
        connection.execute("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1', 'Nexus', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z')", []).unwrap();
        connection.execute("INSERT INTO captures (id, source, content, created_at, project_id) VALUES ('c1', 'text', 'hi', '2026-10-05T00:00:00Z', 'p1')", []).unwrap();
        assert!(connection.execute("DELETE FROM projects WHERE id = 'p1'", []).is_err(), "deleting would orphan a capture");
        // A capture or an object must have an existing, unarchived project.
        assert!(connection.execute("INSERT INTO captures (id, source, content, created_at) VALUES ('c2', 'text', 'hi', '2026-10-05T00:00:00Z')", []).is_err());
        assert!(connection.execute("INSERT INTO captures (id, source, content, created_at, project_id) VALUES ('c2', 'text', 'hi', '2026-10-05T00:00:00Z', 'missing')", []).is_err());
        assert!(connection.execute("UPDATE captures SET project_id = NULL WHERE id = 'c1'", []).is_err());
        connection.execute("UPDATE projects SET archived_at = '2026-10-05T00:00:00Z' WHERE id = 'p1'", []).unwrap();
        assert!(connection.execute("INSERT INTO captures (id, source, content, created_at, project_id) VALUES ('c2', 'text', 'hi', '2026-10-05T00:00:00Z', 'p1')", []).is_err());
        // Content stays immutable; only membership may change.
        assert!(connection.execute("UPDATE captures SET content = 'changed' WHERE id = 'c1'", []).is_err());
        connection.execute("UPDATE captures SET project_id = ?1 WHERE id = 'c1'", [INBOX_PROJECT_ID]).unwrap();
    }

    /// Migration proof on a REAL populated v5 database: `ARTHUR_V5_PROOF_DB=<path> cargo test migration_proof -- --ignored --nocapture`.
    /// Works on copies; the original is never opened for writing.
    #[test]
    #[ignore = "needs a real v5 database: set ARTHUR_V5_PROOF_DB"]
    fn migration_proof_on_a_real_populated_v5_database() {
        let source = std::env::var("ARTHUR_V5_PROOF_DB").expect("ARTHUR_V5_PROOF_DB");
        let dir = tempfile::tempdir().unwrap();
        let copy = |name: &str| {
            let path = dir.path().join(name);
            std::fs::copy(&source, &path).unwrap();
            path
        };
        let tables = ["captures", "knowledge_objects", "object_sources", "relations", "thought_revisions", "revision_parents", "distillation_runs", "organization_failures"];
        let count = |connection: &Connection, table: &str| -> i64 { connection.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)).unwrap() };

        // 1. The upgrade itself.
        let path = copy("upgraded.db");
        let (before, counts_before) = {
            let connection = Connection::open(&path).unwrap();
            assert_eq!(user_version(&connection), 5, "the proof needs a v5 database");
            (fingerprint(&connection), tables.map(|t| count(&connection, t)))
        };
        let started = std::time::Instant::now();
        let store = CaptureStore::open(&path).unwrap();
        let elapsed = started.elapsed();
        let connection = Connection::open(&path).unwrap();
        let after = fingerprint(&connection);
        let counts_after = tables.map(|t| count(&connection, t));
        assert_eq!(user_version(&connection), SCHEMA_VERSION);
        assert_eq!(after, before, "captures, objects, provenance, relations, revisions, parents, runs and failures: byte-for-byte identical");
        assert_eq!(counts_after, counts_before);
        let integrity: String = connection.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        let violations: i64 = connection.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
        let (captures, objects): (i64, i64) = connection.query_row("SELECT (SELECT count(*) FROM captures WHERE project_id = ?1), (SELECT count(*) FROM knowledge_objects WHERE project_id = ?1)", [INBOX_PROJECT_ID], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((integrity.as_str(), violations), ("ok", 0));
        assert_eq!((captures, objects), (counts_after[0], counts_after[1]), "every capture and every object is in the Inbox");
        let projects: Vec<String> = connection.prepare("SELECT id || '|' || name || '|' || created_at || '|' || ifnull(archived_at, '-') FROM projects").unwrap().query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(projects, [format!("{INBOX_PROJECT_ID}|Inbox|1970-01-01T00:00:00Z|-")]);
        assert_eq!(store.active_project_id().unwrap(), INBOX_PROJECT_ID);
        assert_eq!(store.list().unwrap().len() as i64, counts_after[0]);
        assert_eq!(store.list_knowledge_objects().unwrap().len() as i64, counts_after[1]);
        println!("PROOF upgraded: v5 -> v6 in {elapsed:?}; rows {tables:?} = {counts_after:?}; fingerprint rows {}; integrity {integrity}; fk violations {violations}; inbox {captures} captures + {objects} objects", before.len());

        // 2. The same upgrade done twice is the same Inbox (deterministic) and re-opening changes nothing.
        let second = copy("second.db");
        CaptureStore::open(&second).unwrap();
        let second_projects: Vec<String> = Connection::open(&second).unwrap().prepare("SELECT id || '|' || name || '|' || created_at || '|' || ifnull(archived_at, '-') FROM projects").unwrap().query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(second_projects, projects);
        drop(store);
        for _ in 0..3 {
            CaptureStore::open(&path).unwrap();
        }
        assert_eq!(fingerprint(&Connection::open(&path).unwrap()), before);

        // 3. A failing v6 step rolls back completely on this data and leaves v5 usable.
        let broken = copy("broken.db");
        {
            let connection = Connection::open(&broken).unwrap();
            connection.execute_batch("CREATE TABLE active_project (precious TEXT); INSERT INTO active_project VALUES ('keep me');").unwrap();
        }
        assert!(CaptureStore::open(&broken).is_err());
        let connection = Connection::open(&broken).unwrap();
        assert_eq!(user_version(&connection), 5);
        assert_eq!(fingerprint(&connection), before, "nothing of the failed step survived");
        assert!(!has_object(&connection, "table", "projects"));
        assert!(connection.execute("UPDATE captures SET content = 'x' WHERE 1", []).is_err(), "the v2 immutability trigger is back");
        println!("PROOF rollback: failing v6 step left v5 intact (user_version 5, fingerprint identical, no projects table)");

        // 4. A newer schema is refused without a single byte changing.
        let newer = copy("newer.db");
        Connection::open(&newer).unwrap().pragma_update(None, "user_version", 7).unwrap();
        let bytes = std::fs::read(&newer).unwrap();
        assert!(matches!(CaptureStore::open(&newer), Err(StoreError::Corrupt(_))));
        assert_eq!(std::fs::read(&newer).unwrap(), bytes, "refused untouched");
        println!("PROOF newer-schema: v7 database refused, file bytes unchanged");
    }

    #[test]
    fn project_ownership_is_never_null_and_a_capture_changes_only_its_project() {
        let store = CaptureStore::open_in_memory().unwrap();
        let capture = store.create(CreateCaptureInput { source: "text".into(), content: "hello world".into(), project_id: None }).unwrap();
        store.record_distillation(&capture.id, vec![crate::storage::knowledge_store::NewKnowledgeObject { kind: "note".into(), title: "t".into(), body: "b".into(), source_start: 0, source_end: 5 }]).unwrap();
        let connection = store.connection.lock().unwrap();
        let snapshot = |c: &Connection| -> String { c.query_row("SELECT seq || '|' || id || '|' || source || '|' || content || '|' || created_at FROM captures", [], |r| r.get(0)).unwrap() };
        let before = snapshot(&connection);

        // NULL project: refused on INSERT and on UPDATE, for both tables.
        assert!(connection.execute("INSERT INTO captures (id, source, content, created_at) VALUES ('n', 'text', 'x', '2026-10-05T00:00:00Z')", []).is_err());
        assert!(connection.execute("INSERT INTO knowledge_objects (id, kind, title, body, created_at) VALUES ('n', 'note', 't', 'b', '2026-10-05T00:00:00Z')", []).is_err());
        assert!(connection.execute("UPDATE captures SET project_id = NULL", []).is_err());
        assert!(connection.execute("UPDATE knowledge_objects SET project_id = NULL", []).is_err());
        assert!(connection.execute("UPDATE captures SET project_id = 'missing'", []).is_err(), "foreign key");

        // Every previously immutable capture column is still immutable, one by one.
        for assignment in ["id = 'other'", "seq = 99", "source = 'voice'", "content = 'changed'", "created_at = '2030-01-01T00:00:00Z'"] {
            assert!(connection.execute(&format!("UPDATE captures SET {assignment}"), []).is_err(), "{assignment}");
        }
        // A combined update that also touches project membership is refused too.
        assert!(connection.execute(&format!("UPDATE captures SET project_id = '{INBOX_PROJECT_ID}', content = 'changed'"), []).is_err());
        assert_eq!(snapshot(&connection), before);
        drop(connection);

        // A real move changes the project and nothing else of the capture, and nothing of the object but its project.
        let nexus = store.create_project("Nexus").unwrap();
        let object_before = store.list_knowledge_objects().unwrap().remove(0);
        let revisions_before = store.list_revisions(&object_before.id).unwrap();
        store.move_capture(&capture.id, &nexus.id).unwrap();
        store.move_knowledge_object(&object_before.id, &nexus.id).unwrap();
        let connection = store.connection.lock().unwrap();
        assert_eq!(snapshot(&connection), before);
        drop(connection);
        let object_after = store.list_knowledge_objects().unwrap().remove(0);
        assert_eq!(KnowledgeObjectView::of(&object_after), KnowledgeObjectView::of(&object_before));
        assert_eq!(object_after.project_id, nexus.id);
        assert_eq!(store.list_revisions(&object_before.id).unwrap(), revisions_before, "no revision was created");
    }

    #[derive(Debug, PartialEq)]
    struct KnowledgeObjectView(String, String, String, String, String, crate::storage::knowledge_store::Provenance);
    impl KnowledgeObjectView {
        fn of(o: &crate::storage::knowledge_store::KnowledgeObject) -> Self {
            Self(o.id.clone(), o.kind.clone(), o.title.clone(), o.body.clone(), o.created_at.clone(), o.provenance.clone())
        }
    }

    // ---- v7: Cognitive Recall indexes -----------------------------------------------------------------------------------------

    /// A populated database exactly as M03.2 left it: schema v6 with a second and an archived project, a moved object, an active
    /// project, and everything the v5 fixture carries (revisions beyond the initial ones, a relation, a zero-object run, a failure).
    fn v6_database(path: &std::path::Path) {
        v5_database(path);
        let mut connection = Connection::open(path).unwrap();
        migrate_with(&mut connection, &STEPS[..6]).unwrap();
        connection
            .execute_batch(
                "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Nexus', '2026-10-04T12:00:00Z', '2026-10-04T12:00:00Z');
                 INSERT INTO projects (id, name, created_at, updated_at, archived_at) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Old', '2026-10-04T12:01:00Z', '2026-10-04T12:02:00Z', '2026-10-04T12:02:00Z');
                 UPDATE knowledge_objects SET project_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' WHERE id = '22222222-2222-4222-8222-222222222222';
                 INSERT INTO active_project (id, project_id) VALUES (1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');",
            )
            .unwrap();
        assert_eq!(user_version(&connection), 6);
    }

    /// Everything v7 must leave alone: the v6 fingerprint plus projects, the active project and every row's project.
    fn v6_fingerprint(connection: &Connection) -> Vec<String> {
        let mut rows = fingerprint(connection);
        for (label, sql) in [
            ("project", "SELECT id || '|' || name || '|' || created_at || '|' || updated_at || '|' || ifnull(archived_at, '-') FROM projects ORDER BY seq"),
            ("active", "SELECT project_id FROM active_project"),
            ("capture_project", "SELECT id || '|' || project_id FROM captures ORDER BY seq"),
            ("object_project", "SELECT id || '|' || project_id FROM knowledge_objects ORDER BY seq"),
        ] {
            let mut statement = connection.prepare(sql).unwrap();
            rows.extend(statement.query_map([], |r| r.get::<_, String>(0)).unwrap().map(|row| format!("{label}:{}", row.unwrap())));
        }
        rows
    }

    fn count(connection: &Connection, table: &str) -> i64 {
        connection.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_populated_v6_database_upgrades_to_v7_with_every_authoritative_row_unchanged_and_a_complete_lexical_index() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v6_database(&path);
        let (before, revisions) = {
            let connection = Connection::open(&path).unwrap();
            (v6_fingerprint(&connection), count(&connection, "thought_revisions"))
        };
        assert!(before.len() > 15 && revisions >= 3, "the fixture is populated ({} rows, {revisions} revisions)", before.len());

        let store = CaptureStore::open(&path).unwrap();
        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), 7);
        assert_eq!(v6_fingerprint(&connection), before, "every authoritative row is byte-identical");
        let integrity: String = connection.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        let violations: i64 = connection.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
        assert_eq!((integrity.as_str(), violations), ("ok", 0));
        // The v7 objects exist, are populated exactly where they should be, and nothing semantic was invented.
        for (kind, name) in [("table", "recall_revision_fts"), ("table", "recall_embeddings"), ("table", "recall_meta"), ("trigger", "recall_fts_after_revision_insert"), ("trigger", "recall_fts_after_revision_delete"), ("index", "recall_embeddings_by_model_revision")] {
            assert!(has_object(&connection, kind, name), "{name}");
        }
        assert_eq!(count(&connection, "recall_embeddings"), 0);
        assert_eq!(store.recall_indexed_revision_count().unwrap(), revisions, "one index row per revision, backfilled by the migration");
        store.recall_check_lexical_index().unwrap();
        // The index is usable at once: the Bulgarian object from the fixture is found in its own (Inbox) project.
        let hits = store.recall_lexical_current("{title body}: (\"нещо\")", INBOX_PROJECT_ID, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].object.object_id, "33333333-3333-4333-8333-333333333333");
        // ...and the object that was moved to another project is not found through the Inbox.
        assert!(store.recall_lexical_current("{title body}: (\"thought\")", INBOX_PROJECT_ID, 10).unwrap().is_empty());
        assert_eq!(store.recall_lexical_current("{title body}: (\"thought\")", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 10).unwrap().len(), 1);
        // Repeating changes nothing.
        drop(store);
        for _ in 0..3 {
            CaptureStore::open(&path).unwrap();
        }
        assert_eq!(v6_fingerprint(&Connection::open(&path).unwrap()), before);
    }

    #[test]
    fn the_v7_retrieval_tables_are_rebuildable_projections() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v6_database(&path);
        let before = v6_fingerprint(&Connection::open(&path).unwrap());
        CaptureStore::open(&path).unwrap();

        // Throw every retrieval object away and step the version back: the next open recreates them from authoritative data alone.
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "DROP TRIGGER recall_fts_after_revision_insert; DROP TRIGGER recall_fts_after_revision_delete;
                     DROP TABLE recall_revision_fts; DROP TABLE recall_embeddings; DROP TABLE recall_meta;
                     PRAGMA user_version = 6;",
                )
                .unwrap();
            assert_eq!(v6_fingerprint(&connection), before, "dropping the projections removed no knowledge");
        }
        let store = CaptureStore::open(&path).unwrap();
        assert_eq!(v6_fingerprint(&Connection::open(&path).unwrap()), before);
        let revisions = count(&Connection::open(&path).unwrap(), "thought_revisions");
        assert_eq!(store.recall_indexed_revision_count().unwrap(), revisions);

        // And the index alone can be emptied and regenerated in place.
        store.execute_sql_for_test("INSERT INTO recall_revision_fts(recall_revision_fts) VALUES ('delete-all')");
        assert_eq!(store.recall_indexed_revision_count().unwrap(), 0);
        store.recall_rebuild_lexical_index().unwrap();
        assert_eq!(store.recall_indexed_revision_count().unwrap(), revisions);
        store.recall_check_lexical_index().unwrap();
    }

    #[test]
    fn a_failing_v7_upgrade_rolls_back_completely_and_leaves_v6_usable() {
        for blocker in [
            "CREATE TABLE recall_embeddings (precious TEXT); INSERT INTO recall_embeddings VALUES ('keep me');",
            "CREATE TABLE recall_meta (precious TEXT); INSERT INTO recall_meta VALUES ('keep me');",
            "CREATE TABLE recall_revision_fts (precious TEXT); INSERT INTO recall_revision_fts VALUES ('keep me');",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("arthur.db");
            v6_database(&path);
            Connection::open(&path).unwrap().execute_batch(blocker).unwrap();
            let before = v6_fingerprint(&Connection::open(&path).unwrap());

            assert!(CaptureStore::open(&path).is_err(), "{blocker}");
            let connection = Connection::open(&path).unwrap();
            assert_eq!(user_version(&connection), 6, "still v6");
            assert_eq!(v6_fingerprint(&connection), before, "nothing of the failed step survived");
            assert!(!has_object(&connection, "trigger", "recall_fts_after_revision_insert"), "no half-created trigger");
            // v6 is still fully usable (the project and immutability triggers survive).
            assert!(connection.execute("UPDATE thought_revisions SET title = 'x'", []).is_err());
            let precious: i64 = connection.query_row("SELECT count(*) FROM recall_embeddings", [], |r| r.get(0)).unwrap_or(0) + connection.query_row("SELECT count(*) FROM recall_meta", [], |r| r.get(0)).unwrap_or(0) + connection.query_row("SELECT count(*) FROM recall_revision_fts", [], |r| r.get(0)).unwrap_or(0);
            assert_eq!(precious, 1, "the blocker's own row is intact");
        }
    }

    #[test]
    fn a_v8_database_is_refused_without_a_single_byte_changing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v6_database(&path);
        CaptureStore::open(&path).unwrap();
        Connection::open(&path).unwrap().pragma_update(None, "user_version", 8).unwrap();
        let bytes_before = std::fs::read(&path).unwrap();
        assert!(matches!(CaptureStore::open(&path), Err(StoreError::Corrupt(_))));
        assert_eq!(user_version(&Connection::open(&path).unwrap()), 8);
        assert_eq!(std::fs::read(&path).unwrap(), bytes_before, "refused untouched");
    }

    /// Works on copies; the original is never opened for writing.
    #[test]
    #[ignore = "needs a real v6 database: set ARTHUR_V6_PROOF_DB"]
    fn migration_proof_on_a_real_populated_v6_database() {
        let source = std::env::var("ARTHUR_V6_PROOF_DB").expect("ARTHUR_V6_PROOF_DB");
        let dir = tempfile::tempdir().unwrap();
        let copy = |name: &str| {
            let path = dir.path().join(name);
            std::fs::copy(&source, &path).unwrap();
            path
        };
        let tables = ["projects", "active_project", "captures", "knowledge_objects", "object_sources", "relations", "thought_revisions", "revision_parents", "distillation_runs", "organization_failures"];

        let path = copy("upgraded.db");
        let (before, counts_before) = {
            let connection = Connection::open(&path).unwrap();
            assert_eq!(user_version(&connection), 6, "the proof needs a v6 database");
            (v6_fingerprint(&connection), tables.map(|t| count(&connection, t)))
        };
        let started = std::time::Instant::now();
        let store = CaptureStore::open(&path).unwrap();
        let elapsed = started.elapsed();
        let connection = Connection::open(&path).unwrap();
        let counts_after = tables.map(|t| count(&connection, t));
        assert_eq!(user_version(&connection), 7);
        assert_eq!(v6_fingerprint(&connection), before, "authoritative data: byte-for-byte identical");
        assert_eq!(counts_after, counts_before);
        let integrity: String = connection.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        let violations: i64 = connection.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
        assert_eq!((integrity.as_str(), violations), ("ok", 0));
        let revisions = count(&connection, "thought_revisions");
        assert_eq!(store.recall_indexed_revision_count().unwrap(), revisions);
        store.recall_check_lexical_index().unwrap();
        assert_eq!(count(&connection, "recall_embeddings"), 0);
        println!("PROOF upgraded: v6 -> v7 in {elapsed:?}; rows {tables:?} = {counts_after:?}; fingerprint rows {}; integrity {integrity}; fk violations {violations}; fts rows {revisions} = revisions", before.len());

        // Retrieval tables are rebuildable: empty and regenerate, authoritative data identical throughout.
        store.execute_sql_for_test("INSERT INTO recall_revision_fts(recall_revision_fts) VALUES ('delete-all')");
        store.recall_rebuild_lexical_index().unwrap();
        assert_eq!(store.recall_indexed_revision_count().unwrap(), revisions);
        assert_eq!(v6_fingerprint(&Connection::open(&path).unwrap()), before);
        drop(store);
        for _ in 0..3 {
            CaptureStore::open(&path).unwrap();
        }
        assert_eq!(v6_fingerprint(&Connection::open(&path).unwrap()), before);

        // A failing v7 step rolls back completely on this data.
        let broken = copy("broken.db");
        Connection::open(&broken).unwrap().execute_batch("CREATE TABLE recall_meta (precious TEXT); INSERT INTO recall_meta VALUES ('keep me');").unwrap();
        assert!(CaptureStore::open(&broken).is_err());
        let connection = Connection::open(&broken).unwrap();
        assert_eq!(user_version(&connection), 6);
        assert_eq!(v6_fingerprint(&connection), before);
        assert!(!has_object(&connection, "table", "recall_revision_fts"));
        println!("PROOF rollback: failing v7 step left v6 intact (user_version 6, fingerprint identical, no FTS table)");

        // A newer schema is refused untouched.
        let newer = copy("newer.db");
        Connection::open(&newer).unwrap().pragma_update(None, "user_version", 8).unwrap();
        let bytes = std::fs::read(&newer).unwrap();
        assert!(matches!(CaptureStore::open(&newer), Err(StoreError::Corrupt(_))));
        assert_eq!(std::fs::read(&newer).unwrap(), bytes);
        println!("PROOF newer: a v8 database was refused without modification");
    }

    #[test]
    fn migration_steps_are_ordered_and_end_at_the_declared_version() {
        let versions: Vec<i64> = STEPS.iter().map(|(v, _)| *v).collect();
        assert_eq!(versions, (1..=SCHEMA_VERSION).collect::<Vec<_>>());
        let _ = CreateCaptureInput { source: "text".into(), content: "x".into(), project_id: None };
    }
}
