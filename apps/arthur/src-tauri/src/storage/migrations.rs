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

/// v8 (M04.7B Phase 2): durable, auditable storage for Automatic Thought Evolution. ADDITIVE and STORAGE ONLY: three new tables, their
/// indexes and triggers. No v1-v7 table, trigger or row is touched (`thought_revisions` and `knowledge_objects` are NOT rebuilt), no data
/// is backfilled, and nothing in the running app writes these tables until a later phase wires the identity pipeline.
/// Specification and rationale: `docs/architecture/m047b-phase2-schema-v8.md`.
///
/// * `identity_decisions`: ONE immutable decision per distilled claim (capture, ordinal). `unchecked` (identity was NOT established) is a
///   different outcome from `new` (a classifier ran and found no referent): `new` and `revise` require a model id, `unchecked`
///   requires a reason and can never carry one as proof.
/// * `revision_evidence`: the verbatim capture spans behind an automatic (`system`) revision, immutable, with a role (`asserts`,
///   `corrects`, `replaces`) and an optional pointer to the exact earlier evidence it withdraws. A synthesized revision keeps NULL span
///   columns of its own; which evidence is historical, active or withdrawn is DERIVED (never stored) by `evidence_store`.
/// * `pending_claims`: an unresolved identity decision, kept until it is resolved by a real authoritative operation. A terminal state can
///   only be written together with its proof (a committed revision carrying this claim's evidence, or an object created from this
///   claim's span). Rows are never deleted and a terminal row never changes.
///
/// Spans are Unicode code points: SQLite `length()` counts characters, matching `validate_span`.
pub const SCHEMA_V8: &str = "
CREATE TABLE identity_decisions (
    capture_id         TEXT    NOT NULL REFERENCES distillation_runs(capture_id),
    ordinal            INTEGER NOT NULL CHECK (ordinal >= 0),
    outcome            TEXT    NOT NULL CHECK (outcome IN ('new', 'revise', 'uncertain', 'unchecked')),
    unchecked_reason   TEXT    CHECK (unchecked_reason IS NULL OR unchecked_reason IN ('disabled', 'invalid_claim', 'invalid_candidates', 'no_eligible_candidates', 'classifier_failed', 'malformed_signals', 'review_quota')),
    target_object_id   TEXT    REFERENCES knowledge_objects(id),
    base_revision_id   TEXT    REFERENCES thought_revisions(id),
    result_revision_id TEXT    REFERENCES thought_revisions(id),
    created_object_id  TEXT    REFERENCES knowledge_objects(id),
    policy_version     TEXT    NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 64),
    model_id           TEXT    CHECK (model_id IS NULL OR length(model_id) BETWEEN 1 AND 128),
    decided_by         TEXT    NOT NULL CHECK (decided_by IN ('gate', 'fallback')),
    vetoes_json        TEXT    NOT NULL CHECK (json_valid(vetoes_json) AND json_type(vetoes_json) = 'array' AND length(vetoes_json) <= 1024),
    audit_json         TEXT    NOT NULL CHECK (json_valid(audit_json) AND json_type(audit_json) = 'object' AND length(audit_json) <= 4096),
    decided_at         TEXT    NOT NULL CHECK (length(decided_at) > 0),
    PRIMARY KEY (capture_id, ordinal),
    CHECK (
        (outcome = 'new'       AND model_id IS NOT NULL AND unchecked_reason IS NULL     AND created_object_id IS NOT NULL AND target_object_id IS NULL     AND base_revision_id IS NULL     AND result_revision_id IS NULL     AND decided_by = 'gate')
     OR (outcome = 'revise'    AND model_id IS NOT NULL AND unchecked_reason IS NULL     AND created_object_id IS NULL     AND target_object_id IS NOT NULL AND base_revision_id IS NOT NULL AND result_revision_id IS NOT NULL AND decided_by = 'gate')
     OR (outcome = 'uncertain' AND model_id IS NOT NULL AND unchecked_reason IS NULL     AND created_object_id IS NULL     AND target_object_id IS NULL     AND base_revision_id IS NULL     AND result_revision_id IS NULL     AND decided_by = 'gate')
     OR (outcome = 'unchecked' AND unchecked_reason IS NOT NULL                          AND created_object_id IS NOT NULL AND target_object_id IS NULL     AND base_revision_id IS NULL     AND result_revision_id IS NULL     AND decided_by = 'fallback')
    )
);

CREATE INDEX identity_decisions_by_target ON identity_decisions(target_object_id) WHERE target_object_id IS NOT NULL;
CREATE INDEX identity_decisions_by_created_object ON identity_decisions(created_object_id) WHERE created_object_id IS NOT NULL;

CREATE TRIGGER identity_decisions_are_immutable BEFORE UPDATE ON identity_decisions
BEGIN
    SELECT RAISE(ABORT, 'identity decisions are immutable');
END;

CREATE TRIGGER identity_decisions_are_never_deleted BEFORE DELETE ON identity_decisions
BEGIN
    SELECT RAISE(ABORT, 'identity decisions are never deleted');
END;

-- A REVISE is only recorded for a committed automatic revision: a child of the stated base, on the stated object, that carries evidence
-- from THIS capture. So a decision can never describe a revision that does not exist or was made for another object.
CREATE TRIGGER identity_decisions_revise_needs_its_revision BEFORE INSERT ON identity_decisions
WHEN NEW.outcome = 'revise' AND NOT EXISTS (
    SELECT 1 FROM thought_revisions r
    JOIN revision_parents p ON p.child_revision_id = r.id
    JOIN thought_revisions b ON b.id = p.parent_revision_id
    WHERE r.id = NEW.result_revision_id AND r.origin = 'system' AND r.object_id = NEW.target_object_id
      AND b.id = NEW.base_revision_id AND b.object_id = NEW.target_object_id
      AND EXISTS (SELECT 1 FROM revision_evidence e WHERE e.revision_id = r.id AND e.capture_id = NEW.capture_id)
)
BEGIN
    SELECT RAISE(ABORT, 'a revise decision needs a committed automatic revision with evidence from its capture');
END;

CREATE TRIGGER identity_decisions_new_needs_its_object BEFORE INSERT ON identity_decisions
WHEN NEW.outcome IN ('new', 'unchecked') AND NOT EXISTS (SELECT 1 FROM object_sources s WHERE s.object_id = NEW.created_object_id AND s.capture_id = NEW.capture_id)
BEGIN
    SELECT RAISE(ABORT, 'the created object must originate from the decision''s capture');
END;

CREATE TABLE revision_evidence (
    revision_id          TEXT    NOT NULL REFERENCES thought_revisions(id),
    ordinal              INTEGER NOT NULL CHECK (ordinal >= 0),
    object_id            TEXT    NOT NULL REFERENCES knowledge_objects(id),
    capture_id           TEXT    NOT NULL REFERENCES captures(id),
    source_start         INTEGER NOT NULL CHECK (source_start >= 0),
    source_end           INTEGER NOT NULL CHECK (source_end > source_start),
    role                 TEXT    NOT NULL CHECK (role IN ('asserts', 'corrects', 'replaces')),
    retracts_revision_id TEXT,
    retracts_ordinal     INTEGER,
    interpretation_label TEXT    CHECK (interpretation_label IS NULL OR (length(trim(interpretation_label)) > 0 AND length(interpretation_label) <= 200)),
    created_at           TEXT    NOT NULL CHECK (length(created_at) > 0),
    PRIMARY KEY (revision_id, ordinal),
    UNIQUE (revision_id, capture_id, source_start, source_end),
    FOREIGN KEY (retracts_revision_id, retracts_ordinal) REFERENCES revision_evidence(revision_id, ordinal),
    CHECK ((retracts_revision_id IS NULL) = (retracts_ordinal IS NULL)),
    CHECK (retracts_revision_id IS NULL OR role IN ('corrects', 'replaces')),
    CHECK (retracts_revision_id IS NULL OR retracts_revision_id <> revision_id)
);

CREATE INDEX revision_evidence_by_object ON revision_evidence(object_id, revision_id);
CREATE INDEX revision_evidence_by_capture ON revision_evidence(capture_id);

CREATE TRIGGER revision_evidence_is_immutable BEFORE UPDATE ON revision_evidence
BEGIN
    SELECT RAISE(ABORT, 'revision evidence is immutable');
END;

CREATE TRIGGER revision_evidence_is_never_deleted BEFORE DELETE ON revision_evidence
BEGIN
    SELECT RAISE(ABORT, 'revision evidence is never deleted');
END;

-- Evidence attaches only to an AUTOMATIC revision (origin 'system'); a user edit or merge claims no capture, and an initial revision
-- keeps its own span in thought_revisions.
CREATE TRIGGER revision_evidence_needs_an_automatic_revision BEFORE INSERT ON revision_evidence
WHEN (SELECT origin FROM thought_revisions WHERE id = NEW.revision_id) IS NOT 'system'
BEGIN
    SELECT RAISE(ABORT, 'evidence attaches only to an automatic revision');
END;

CREATE TRIGGER revision_evidence_object_matches_its_revision BEFORE INSERT ON revision_evidence
WHEN NEW.object_id IS NOT (SELECT object_id FROM thought_revisions WHERE id = NEW.revision_id)
BEGIN
    SELECT RAISE(ABORT, 'evidence names a different object than its revision');
END;

-- The evidence of a revision is fixed while it is still the newest of its line: once anything builds on it, the support story is closed.
CREATE TRIGGER revision_evidence_only_before_history_moves_on BEFORE INSERT ON revision_evidence
WHEN EXISTS (SELECT 1 FROM revision_parents WHERE parent_revision_id = NEW.revision_id)
BEGIN
    SELECT RAISE(ABORT, 'a revision with descendants cannot gain evidence');
END;

CREATE TRIGGER revision_evidence_span_is_inside_its_capture BEFORE INSERT ON revision_evidence
WHEN ifnull((SELECT length(content) FROM captures WHERE id = NEW.capture_id), -1) < NEW.source_end
BEGIN
    SELECT RAISE(ABORT, 'the evidence span is outside its capture');
END;

-- What a correction or replacement withdraws must be PROVABLE: evidence of a strictly earlier revision of the same line.
CREATE TRIGGER revision_evidence_retracts_only_its_ancestors BEFORE INSERT ON revision_evidence
WHEN NEW.retracts_revision_id IS NOT NULL AND NOT EXISTS (
    WITH RECURSIVE ancestors(id) AS (
        SELECT parent_revision_id FROM revision_parents WHERE child_revision_id = NEW.revision_id
        UNION
        SELECT p.parent_revision_id FROM revision_parents p JOIN ancestors a ON p.child_revision_id = a.id
    )
    SELECT 1 FROM ancestors WHERE id = NEW.retracts_revision_id
)
BEGIN
    SELECT RAISE(ABORT, 'evidence can only withdraw evidence of an earlier revision of the same object');
END;

CREATE TABLE pending_claims (
    seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
    id                  TEXT    NOT NULL UNIQUE CHECK (length(id) > 0),
    capture_id          TEXT    NOT NULL,
    ordinal             INTEGER NOT NULL,
    kind                TEXT    NOT NULL CHECK (kind IN ('idea', 'task', 'decision', 'question', 'note')),
    title               TEXT    NOT NULL CHECK (length(trim(title)) > 0 AND length(title) <= 200),
    body                TEXT    NOT NULL CHECK (length(trim(body)) > 0 AND length(body) <= 2000),
    source_start        INTEGER NOT NULL CHECK (source_start >= 0),
    source_end          INTEGER NOT NULL CHECK (source_end > source_start),
    candidate_ids_json  TEXT    NOT NULL CHECK (json_valid(candidate_ids_json) AND json_type(candidate_ids_json) = 'array' AND json_array_length(candidate_ids_json) BETWEEN 1 AND 4 AND length(candidate_ids_json) <= 400),
    reasons_json        TEXT    NOT NULL CHECK (json_valid(reasons_json) AND json_type(reasons_json) = 'array' AND length(reasons_json) <= 1024),
    reframing           INTEGER NOT NULL CHECK (reframing IN (0, 1)),
    state               TEXT    NOT NULL CHECK (state IN ('open', 'deferred', 'accepted', 'separated')),
    due_at              TEXT    CHECK (due_at IS NULL OR length(due_at) > 0),
    created_at          TEXT    NOT NULL CHECK (length(created_at) > 0),
    updated_at          TEXT    NOT NULL CHECK (length(updated_at) > 0),
    deferred_at         TEXT,
    resolved_at         TEXT,
    resolved_method     TEXT    CHECK (resolved_method IS NULL OR resolved_method IN ('user', 'expiry')),
    resolved_object_id  TEXT    REFERENCES knowledge_objects(id),
    resolved_revision_id TEXT   REFERENCES thought_revisions(id),
    UNIQUE (capture_id, ordinal),
    FOREIGN KEY (capture_id, ordinal) REFERENCES identity_decisions(capture_id, ordinal),
    CHECK (state <> 'deferred' OR deferred_at IS NOT NULL),
    CHECK (
        (state IN ('open', 'deferred') AND resolved_at IS NULL     AND resolved_method IS NULL     AND resolved_object_id IS NULL     AND resolved_revision_id IS NULL)
     OR (state = 'accepted'            AND resolved_at IS NOT NULL AND resolved_method = 'user'    AND resolved_object_id IS NOT NULL AND resolved_revision_id IS NOT NULL)
     OR (state = 'separated'           AND resolved_at IS NOT NULL AND resolved_method IS NOT NULL AND resolved_object_id IS NOT NULL AND resolved_revision_id IS NULL)
    )
);

CREATE INDEX pending_claims_by_state ON pending_claims(state, seq);

CREATE TRIGGER pending_claims_are_never_deleted BEFORE DELETE ON pending_claims
BEGIN
    SELECT RAISE(ABORT, 'a pending claim is never deleted');
END;

CREATE TRIGGER pending_claims_need_an_uncertain_decision BEFORE INSERT ON pending_claims
WHEN NOT EXISTS (SELECT 1 FROM identity_decisions d WHERE d.capture_id = NEW.capture_id AND d.ordinal = NEW.ordinal AND d.outcome = 'uncertain')
BEGIN
    SELECT RAISE(ABORT, 'a pending claim needs an uncertain identity decision');
END;

CREATE TRIGGER pending_claims_start_open BEFORE INSERT ON pending_claims
WHEN NEW.state <> 'open'
BEGIN
    SELECT RAISE(ABORT, 'a pending claim starts open');
END;

CREATE TRIGGER pending_claims_span_is_inside_its_capture BEFORE INSERT ON pending_claims
WHEN ifnull((SELECT length(content) FROM captures WHERE id = NEW.capture_id), -1) < NEW.source_end
BEGIN
    SELECT RAISE(ABORT, 'the claim span is outside its capture');
END;

-- Candidates are existing objects of the capture's own project: a claim cannot point at an unrelated or foreign-project object.
CREATE TRIGGER pending_claims_candidates_are_local_objects BEFORE INSERT ON pending_claims
WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.candidate_ids_json) j
    WHERE NOT EXISTS (
        SELECT 1 FROM knowledge_objects o JOIN captures c ON c.id = NEW.capture_id
        WHERE o.id = j.value AND o.project_id = c.project_id
    )
)
BEGIN
    SELECT RAISE(ABORT, 'a candidate must be an existing object of the capture''s project');
END;

CREATE TRIGGER pending_claims_content_is_immutable BEFORE UPDATE ON pending_claims
WHEN NEW.id IS NOT OLD.id OR NEW.seq IS NOT OLD.seq OR NEW.capture_id IS NOT OLD.capture_id OR NEW.ordinal IS NOT OLD.ordinal OR NEW.kind IS NOT OLD.kind
  OR NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body OR NEW.source_start IS NOT OLD.source_start OR NEW.source_end IS NOT OLD.source_end
  OR NEW.candidate_ids_json IS NOT OLD.candidate_ids_json OR NEW.reasons_json IS NOT OLD.reasons_json OR NEW.reframing IS NOT OLD.reframing
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'a pending claim''s content is immutable');
END;

CREATE TRIGGER pending_claims_terminal_states_are_final BEFORE UPDATE ON pending_claims
WHEN OLD.state IN ('accepted', 'separated')
BEGIN
    SELECT RAISE(ABORT, 'a resolved pending claim cannot change');
END;

CREATE TRIGGER pending_claims_valid_transitions BEFORE UPDATE ON pending_claims
WHEN NEW.state <> OLD.state AND NOT (
       (OLD.state = 'open'     AND NEW.state IN ('deferred', 'accepted', 'separated'))
    OR (OLD.state = 'deferred' AND NEW.state IN ('open', 'accepted', 'separated'))
)
BEGIN
    SELECT RAISE(ABORT, 'invalid pending claim transition');
END;

-- No accepted claim without the revision it produced: a committed automatic revision of a candidate, carrying THIS claim's span as evidence.
CREATE TRIGGER pending_claims_accepted_needs_its_revision BEFORE UPDATE ON pending_claims
WHEN NEW.state = 'accepted' AND NOT EXISTS (
    SELECT 1 FROM thought_revisions r JOIN revision_evidence e ON e.revision_id = r.id
    WHERE r.id = NEW.resolved_revision_id AND r.object_id = NEW.resolved_object_id AND r.origin = 'system'
      AND e.capture_id = NEW.capture_id AND e.source_start = NEW.source_start AND e.source_end = NEW.source_end
      AND EXISTS (SELECT 1 FROM json_each(NEW.candidate_ids_json) j WHERE j.value = NEW.resolved_object_id)
)
BEGIN
    SELECT RAISE(ABORT, 'an accepted claim needs the committed revision it produced');
END;

-- No separated claim without the object created from this claim's span.
CREATE TRIGGER pending_claims_separated_needs_its_object BEFORE UPDATE ON pending_claims
WHEN NEW.state = 'separated' AND NOT EXISTS (
    SELECT 1 FROM object_sources s
    WHERE s.object_id = NEW.resolved_object_id AND s.capture_id = NEW.capture_id AND s.source_start = NEW.source_start AND s.source_end = NEW.source_end
)
BEGIN
    SELECT RAISE(ABORT, 'a separated claim needs the object created from it');
END;
";

/// Schema v9 (M04.7B Phase 5): durable REVISION PROPOSALS, the one thing v8 could not keep. When a draft revision has been synthesized
/// and checked but may not be applied without a person (every same-family review), v8 could only keep the claim as a pending claim and
/// the draft was lost. A proposal is the draft itself plus how it was produced and checked, linked 1:1 to its pending claim.
///
/// Additive only: one table, its indexes and triggers; no existing table is rebuilt or altered, nothing is backfilled.
///
/// * A proposal is created `open`, only for an `open` pending claim, naming one of that claim's candidates and a base revision that is
///   STILL that object's current revision at creation. Its content (draft text, evidence references, models, mode) is immutable.
/// * `approved` is written only together with the committed automatic revision it produced (carrying the claim's span as evidence and
///   having exactly the approved text). `final_body` is what the person approved; `user_edited` says it differs from the draft.
/// * `rejected` dismisses the DRAFT only: the pending claim stays open, so the captured knowledge is never lost.
/// * `superseded` is written by a trigger when the claim is resolved some other way. Terminal states are final; rows are never deleted.
/// * Whether an open proposal is stale (its base revision is no longer current) is derived on read, never stored.
pub const SCHEMA_V9: &str = "
CREATE TABLE revision_proposals (
    seq                  INTEGER PRIMARY KEY AUTOINCREMENT,
    id                   TEXT    NOT NULL UNIQUE CHECK (length(id) > 0),
    pending_claim_id     TEXT    NOT NULL UNIQUE REFERENCES pending_claims(id),
    object_id            TEXT    NOT NULL REFERENCES knowledge_objects(id),
    base_revision_id     TEXT    NOT NULL REFERENCES thought_revisions(id),
    change               TEXT    NOT NULL CHECK (change IN ('additive', 'correction', 'replacement')),
    kind                 TEXT    NOT NULL CHECK (kind IN ('idea', 'task', 'decision', 'question', 'note')),
    title                TEXT    NOT NULL CHECK (length(trim(title)) > 0 AND length(title) <= 200),
    proposed_body        TEXT    NOT NULL CHECK (length(trim(proposed_body)) > 0 AND length(proposed_body) <= 2000),
    retracts_revision_id TEXT,
    retracts_ordinal     INTEGER,
    evidence_json        TEXT    NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'array' AND json_array_length(evidence_json) BETWEEN 1 AND 13 AND length(evidence_json) <= 4096),
    synthesis_model      TEXT    NOT NULL CHECK (length(synthesis_model) BETWEEN 1 AND 128),
    verifier_model       TEXT    NOT NULL CHECK (length(verifier_model) BETWEEN 1 AND 128),
    verification_mode    TEXT    NOT NULL CHECK (verification_mode IN ('independent', 'same_family_review')),
    verification_status  TEXT    NOT NULL CHECK (verification_status IN ('passed')),
    policy_version       TEXT    NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 64),
    state                TEXT    NOT NULL CHECK (state IN ('open', 'deferred', 'approved', 'rejected', 'separated', 'superseded')),
    user_edited          INTEGER NOT NULL DEFAULT 0 CHECK (user_edited IN (0, 1)),
    final_body           TEXT    CHECK (final_body IS NULL OR (length(trim(final_body)) > 0 AND length(final_body) <= 2000)),
    result_revision_id   TEXT    REFERENCES thought_revisions(id),
    created_at           TEXT    NOT NULL CHECK (length(created_at) > 0),
    updated_at           TEXT    NOT NULL CHECK (length(updated_at) > 0),
    reviewed_at          TEXT,
    CHECK ((retracts_revision_id IS NULL) = (retracts_ordinal IS NULL)),
    CHECK (
        (state = 'approved' AND final_body IS NOT NULL AND result_revision_id IS NOT NULL AND reviewed_at IS NOT NULL)
     OR (state <> 'approved' AND final_body IS NULL AND result_revision_id IS NULL AND user_edited = 0)
    ),
    CHECK (state IN ('open', 'deferred') OR reviewed_at IS NOT NULL)
);

CREATE INDEX revision_proposals_by_state ON revision_proposals(state, seq);
CREATE INDEX revision_proposals_by_object ON revision_proposals(object_id);

CREATE TRIGGER revision_proposals_are_never_deleted BEFORE DELETE ON revision_proposals
BEGIN
    SELECT RAISE(ABORT, 'a revision proposal is never deleted');
END;

CREATE TRIGGER revision_proposals_start_open BEFORE INSERT ON revision_proposals
WHEN NEW.state <> 'open'
BEGIN
    SELECT RAISE(ABORT, 'a revision proposal starts open');
END;

-- A proposal belongs to an OPEN pending claim, targets one of that claim's candidates, and is based on that object's current revision.
CREATE TRIGGER revision_proposals_need_an_open_claim_and_a_current_base BEFORE INSERT ON revision_proposals
WHEN NOT EXISTS (
    SELECT 1 FROM pending_claims p
    JOIN knowledge_objects o ON o.id = NEW.object_id
    WHERE p.id = NEW.pending_claim_id AND p.state = 'open'
      AND EXISTS (SELECT 1 FROM json_each(p.candidate_ids_json) j WHERE j.value = NEW.object_id)
      AND o.current_revision_id = NEW.base_revision_id
      AND EXISTS (SELECT 1 FROM thought_revisions r WHERE r.id = NEW.base_revision_id AND r.object_id = NEW.object_id)
)
BEGIN
    SELECT RAISE(ABORT, 'a proposal needs an open claim, one of its candidates and that object''s current revision');
END;

CREATE TRIGGER revision_proposals_content_is_immutable BEFORE UPDATE ON revision_proposals
WHEN NEW.seq IS NOT OLD.seq OR NEW.id IS NOT OLD.id OR NEW.pending_claim_id IS NOT OLD.pending_claim_id OR NEW.object_id IS NOT OLD.object_id
  OR NEW.base_revision_id IS NOT OLD.base_revision_id OR NEW.change IS NOT OLD.change OR NEW.kind IS NOT OLD.kind OR NEW.title IS NOT OLD.title
  OR NEW.proposed_body IS NOT OLD.proposed_body OR NEW.retracts_revision_id IS NOT OLD.retracts_revision_id OR NEW.retracts_ordinal IS NOT OLD.retracts_ordinal
  OR NEW.evidence_json IS NOT OLD.evidence_json OR NEW.synthesis_model IS NOT OLD.synthesis_model OR NEW.verifier_model IS NOT OLD.verifier_model
  OR NEW.verification_mode IS NOT OLD.verification_mode OR NEW.verification_status IS NOT OLD.verification_status OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'a revision proposal''s content is immutable');
END;

CREATE TRIGGER revision_proposals_terminal_states_are_final BEFORE UPDATE ON revision_proposals
WHEN OLD.state IN ('approved', 'rejected', 'separated', 'superseded')
BEGIN
    SELECT RAISE(ABORT, 'a reviewed revision proposal cannot change');
END;

CREATE TRIGGER revision_proposals_valid_transitions BEFORE UPDATE ON revision_proposals
WHEN NEW.state <> OLD.state AND NOT (
       (OLD.state = 'open'     AND NEW.state IN ('deferred', 'approved', 'rejected', 'separated', 'superseded'))
    OR (OLD.state = 'deferred' AND NEW.state IN ('open', 'approved', 'rejected', 'separated', 'superseded'))
)
BEGIN
    SELECT RAISE(ABORT, 'invalid revision proposal transition');
END;

-- No approved proposal without the committed automatic revision it produced: on the proposal's object, carrying THIS claim's span as
-- evidence, and with exactly the text that was approved.
CREATE TRIGGER revision_proposals_approved_needs_its_revision BEFORE UPDATE ON revision_proposals
WHEN NEW.state = 'approved' AND NOT EXISTS (
    SELECT 1 FROM thought_revisions r
    JOIN revision_evidence e ON e.revision_id = r.id
    JOIN pending_claims p ON p.id = NEW.pending_claim_id
    WHERE r.id = NEW.result_revision_id AND r.object_id = NEW.object_id AND r.origin = 'system' AND r.body = NEW.final_body
      AND e.capture_id = p.capture_id AND e.source_start = p.source_start AND e.source_end = p.source_end
)
BEGIN
    SELECT RAISE(ABORT, 'an approved proposal needs the committed revision it produced');
END;

-- No separated proposal without the object created from its claim.
CREATE TRIGGER revision_proposals_separated_needs_its_object BEFORE UPDATE ON revision_proposals
WHEN NEW.state = 'separated' AND NOT EXISTS (
    SELECT 1 FROM pending_claims p JOIN object_sources s ON s.capture_id = p.capture_id AND s.source_start = p.source_start AND s.source_end = p.source_end
    WHERE p.id = NEW.pending_claim_id
)
BEGIN
    SELECT RAISE(ABORT, 'a separated proposal needs the object created from its claim');
END;

-- A claim resolved by any other route closes its still-reviewable proposal, so a proposal can never outlive its claim as reviewable.
CREATE TRIGGER pending_claims_resolution_supersedes_open_proposals AFTER UPDATE OF state ON pending_claims
WHEN NEW.state IN ('accepted', 'separated') AND OLD.state IN ('open', 'deferred')
BEGIN
    UPDATE revision_proposals SET state = 'superseded', reviewed_at = NEW.updated_at, updated_at = NEW.updated_at
    WHERE pending_claim_id = NEW.id AND state IN ('open', 'deferred');
END;
";

pub type Step = (i64, &'static str);

/// Ordered migration steps: `(version after the step, SQL)`.
pub const STEPS: [Step; 9] = [(1, SCHEMA_V1), (2, SCHEMA_V2), (3, SCHEMA_V3), (4, SCHEMA_V4), (5, SCHEMA_V5), (6, SCHEMA_V6), (7, SCHEMA_V7), (8, SCHEMA_V8), (9, SCHEMA_V9)];

/// The version `STEPS` ends at; asserted against `STEPS` by a test.
#[cfg(test)]
pub const SCHEMA_VERSION: i64 = 9;

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
        assert_eq!(user_version(&connection), SCHEMA_VERSION, "opening migrates on to the latest version (v7 added the retrieval tables, v8 adds more; both leave authoritative rows alone)");
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

    /// Removes everything v8 and v9 created (empty tables only), so a test can step a file back to v7.
    pub(crate) const DROP_V8: &str = "DROP TABLE revision_proposals; DROP TABLE pending_claims; DROP TABLE revision_evidence; DROP TABLE identity_decisions;";

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
            connection.execute_batch(DROP_V8).unwrap(); // v8 is separate from the retrieval tables; step the file back past both
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
    fn a_database_one_version_ahead_is_refused_without_a_single_byte_changing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v6_database(&path);
        CaptureStore::open(&path).unwrap();
        Connection::open(&path).unwrap().pragma_update(None, "user_version", SCHEMA_VERSION + 1).unwrap();
        let bytes_before = std::fs::read(&path).unwrap();
        assert!(matches!(CaptureStore::open(&path), Err(StoreError::Corrupt(_))));
        assert_eq!(user_version(&Connection::open(&path).unwrap()), SCHEMA_VERSION + 1);
        assert_eq!(std::fs::read(&path).unwrap(), bytes_before, "refused untouched");
    }

    // ---- v8: identity decisions, revision evidence, pending claims ------------------------------------------------------------

    /// A populated database exactly as M04B left it: the v6 fixture migrated to v7 (so the lexical index is populated).
    fn v7_database(path: &std::path::Path) {
        v6_database(path);
        let mut connection = Connection::open(path).unwrap();
        migrate_with(&mut connection, &STEPS[..7]).unwrap();
        assert_eq!(user_version(&connection), 7);
    }

    /// Everything v8 must leave alone: the v6 fingerprint plus the revision count and the lexical index row count.
    fn v7_fingerprint(connection: &Connection) -> Vec<String> {
        let mut rows = v6_fingerprint(connection);
        rows.push(format!("fts:{}", connection.query_row("SELECT count(*) FROM recall_revision_fts_docsize", [], |r| r.get::<_, i64>(0)).unwrap()));
        rows.push(format!("meta:{}", connection.query_row("SELECT group_concat(key || '=' || value) FROM recall_meta", [], |r| r.get::<_, String>(0)).unwrap()));
        rows
    }

    const V8_OBJECTS: [(&str, &str); 22] = [
        ("table", "identity_decisions"), ("table", "revision_evidence"), ("table", "pending_claims"),
        ("index", "identity_decisions_by_target"), ("index", "identity_decisions_by_created_object"), ("index", "revision_evidence_by_object"), ("index", "revision_evidence_by_capture"), ("index", "pending_claims_by_state"),
        ("trigger", "identity_decisions_are_immutable"), ("trigger", "identity_decisions_are_never_deleted"), ("trigger", "identity_decisions_revise_needs_its_revision"), ("trigger", "identity_decisions_new_needs_its_object"),
        ("trigger", "revision_evidence_is_immutable"), ("trigger", "revision_evidence_is_never_deleted"), ("trigger", "revision_evidence_needs_an_automatic_revision"), ("trigger", "revision_evidence_retracts_only_its_ancestors"),
        ("trigger", "pending_claims_are_never_deleted"), ("trigger", "pending_claims_need_an_uncertain_decision"), ("trigger", "pending_claims_valid_transitions"), ("trigger", "pending_claims_terminal_states_are_final"),
        ("trigger", "pending_claims_accepted_needs_its_revision"), ("trigger", "pending_claims_separated_needs_its_object"),
    ];

    #[test]
    fn a_fresh_database_goes_straight_to_v8_with_every_v8_object_and_empty_v8_tables() {
        let store = CaptureStore::open_in_memory().unwrap();
        let connection = store.connection.lock().unwrap();
        assert_eq!(user_version(&connection), SCHEMA_VERSION);
        for (kind, name) in V8_OBJECTS {
            assert!(has_object(&connection, kind, name), "{kind} {name}");
        }
        for table in ["identity_decisions", "revision_evidence", "pending_claims"] {
            assert_eq!(count(&connection, table), 0);
        }
        let violations: i64 = connection.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
        assert_eq!(violations, 0);
    }

    #[test]
    fn a_populated_v7_database_upgrades_to_v8_with_every_authoritative_row_and_the_search_index_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v7_database(&path);
        let (before, revisions, relations) = {
            let connection = Connection::open(&path).unwrap();
            (v7_fingerprint(&connection), count(&connection, "thought_revisions"), count(&connection, "relations"))
        };
        assert!(before.len() > 15 && revisions >= 3 && relations >= 1, "the fixture is populated ({} rows)", before.len());

        let store = CaptureStore::open(&path).unwrap();
        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), SCHEMA_VERSION);
        assert_eq!(v7_fingerprint(&connection), before, "captures, objects, revisions, parents, relations, projects, provenance, projections and the index are byte-identical");
        for (kind, name) in V8_OBJECTS {
            assert!(has_object(&connection, kind, name), "{kind} {name}");
        }
        for table in ["identity_decisions", "revision_evidence", "pending_claims"] {
            assert_eq!(count(&connection, table), 0, "nothing was backfilled or invented in {table}");
        }
        let integrity: String = connection.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        let violations: i64 = connection.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
        assert_eq!((integrity.as_str(), violations), ("ok", 0));
        // existing behaviour: revisions still immutable, the projection guard and project triggers still fire, FTS still consistent
        assert!(connection.execute("UPDATE thought_revisions SET title = 'x'", []).is_err());
        assert!(connection.execute("UPDATE knowledge_objects SET title = 'x'", []).is_err());
        assert_eq!(store.recall_indexed_revision_count().unwrap(), revisions);
        store.recall_check_lexical_index().unwrap();
        for object in store.list_knowledge_objects().unwrap() {
            store.object_lineage(&object.id).unwrap();
        }
        // the new revision of an old object is searchable and the old behaviour (user edit) still works on the migrated file
        let object = store.list_knowledge_objects().unwrap().remove(0);
        store.update_object(&object.id, crate::storage::lineage_store::Changes { body: Some("a brand new body about quokkas".into()), ..Default::default() }).unwrap();
        store.recall_check_lexical_index().unwrap();
        // repeating changes nothing
        drop(store);
        drop(connection);
        for _ in 0..3 {
            CaptureStore::open(&path).unwrap();
        }
        assert_eq!(user_version(&Connection::open(&path).unwrap()), SCHEMA_VERSION);
    }

    #[test]
    fn a_failing_v8_upgrade_rolls_back_completely_and_leaves_v7_usable() {
        for blocker in [
            "CREATE TABLE identity_decisions (precious TEXT); INSERT INTO identity_decisions VALUES ('keep me');",
            "CREATE TABLE revision_evidence (precious TEXT); INSERT INTO revision_evidence VALUES ('keep me');",
            "CREATE TABLE pending_claims (precious TEXT); INSERT INTO pending_claims VALUES ('keep me');",
            // blocks only the LAST statement of the step: everything before it must roll back too
            "CREATE TRIGGER pending_claims_separated_needs_its_object BEFORE UPDATE ON captures BEGIN SELECT 1; END;",
            "CREATE INDEX pending_claims_by_state ON captures(id);",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("arthur.db");
            v7_database(&path);
            Connection::open(&path).unwrap().execute_batch(blocker).unwrap();
            let before = v7_fingerprint(&Connection::open(&path).unwrap());

            assert!(CaptureStore::open(&path).is_err(), "{blocker}");
            let connection = Connection::open(&path).unwrap();
            assert_eq!(user_version(&connection), 7, "still v7: {blocker}");
            assert_eq!(v7_fingerprint(&connection), before, "{blocker}");
            let leftovers: Vec<&str> = V8_OBJECTS.iter().filter(|(kind, name)| has_object(&connection, kind, name)).map(|(_, name)| *name).collect();
            let expected: &[&str] = if blocker.contains("TABLE identity_decisions") { &["identity_decisions"] } else if blocker.contains("TABLE revision_evidence") { &["revision_evidence"] } else if blocker.contains("TABLE pending_claims") { &["pending_claims"] } else if blocker.contains("TRIGGER") { &["pending_claims_separated_needs_its_object"] } else { &["pending_claims_by_state"] };
            assert_eq!(leftovers, expected, "nothing of the failed step survived except the blocker itself: {blocker}");
            assert!(connection.execute("UPDATE thought_revisions SET title = 'x'", []).is_err(), "v7 triggers still guard the data");
        }
    }

    #[test]
    fn an_interrupted_v8_upgrade_leaves_v7_intact_and_the_next_open_completes_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v7_database(&path);
        let before = v7_fingerprint(&Connection::open(&path).unwrap());
        {
            // A process that dies half way through the step: the transaction is never committed, the connection just goes away.
            let connection = Connection::open(&path).unwrap();
            let half = SCHEMA_V8.split("CREATE TABLE pending_claims").next().unwrap();
            connection.execute_batch(&format!("BEGIN IMMEDIATE; {half}")).unwrap();
            assert!(has_object(&connection, "table", "revision_evidence"), "visible inside the open transaction");
        }
        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), 7);
        assert!(!has_object(&connection, "table", "identity_decisions") && !has_object(&connection, "table", "revision_evidence"), "the half-built step vanished");
        assert_eq!(v7_fingerprint(&connection), before);
        drop(connection);
        CaptureStore::open(&path).unwrap();
        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), SCHEMA_VERSION);
        assert_eq!(v7_fingerprint(&connection), before);
        assert!(V8_OBJECTS.iter().all(|(kind, name)| has_object(&connection, kind, name)));
    }

    #[test]
    fn an_older_binary_refuses_a_v8_database_untouched() {
        // "An older binary" is modelled by the migrator at its previous latest version (7): it must refuse version 8 and write nothing.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v7_database(&path);
        CaptureStore::open(&path).unwrap();
        let bytes_before = std::fs::read(&path).unwrap();
        let mut connection = Connection::open(&path).unwrap();
        let outcome = migrate_with(&mut connection, &STEPS[..7]);
        assert!(matches!(outcome, Err(StoreError::Corrupt(_))), "{outcome:?}");
        drop(connection);
        assert_eq!(std::fs::read(&path).unwrap(), bytes_before, "refused without a single byte changing");
    }

    // ---- v9: revision proposals -----------------------------------------------------------------------------------------------

    /// A populated database exactly as Phase 4 left it: v8, with a real decision and an open pending claim in it.
    fn v8_database(path: &std::path::Path) {
        v7_database(path);
        let mut connection = Connection::open(path).unwrap();
        migrate_with(&mut connection, &STEPS[..8]).unwrap();
        connection
            .execute_batch(
                "INSERT INTO identity_decisions (capture_id, ordinal, outcome, model_id, policy_version, decided_by, vetoes_json, audit_json, decided_at)
                    SELECT capture_id, 99, 'uncertain', 'm-1', 'p-1', 'gate', '[]', '{}', '2026-10-05T00:00:00Z' FROM distillation_runs LIMIT 1;
                 INSERT INTO pending_claims (id, capture_id, ordinal, kind, title, body, source_start, source_end, candidate_ids_json, reasons_json, reframing, state, created_at, updated_at)
                    SELECT 'pc-1', r.capture_id, 99, 'idea', 'T', 'B', 0, 3,
                           json_array((SELECT o.id FROM knowledge_objects o JOIN captures c ON c.id = r.capture_id WHERE o.project_id = c.project_id LIMIT 1)),
                           '[]', 0, 'open', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z' FROM distillation_runs r LIMIT 1;",
            )
            .unwrap();
        assert_eq!(user_version(&connection), 8);
        assert_eq!(count(&connection, "pending_claims"), 1);
    }

    fn v8_fingerprint(connection: &Connection) -> Vec<String> {
        let mut rows = v7_fingerprint(connection);
        for table in ["identity_decisions", "revision_evidence", "pending_claims"] {
            rows.push(format!("{table}:{}", count(connection, table)));
        }
        rows.push(format!("pending:{}", connection.query_row("SELECT group_concat(id || '|' || state || '|' || candidate_ids_json) FROM pending_claims", [], |r| r.get::<_, String>(0)).unwrap()));
        rows
    }

    const V9_OBJECTS: [(&str, &str); 14] = [
        ("table", "revision_proposals"), ("index", "revision_proposals_by_state"), ("index", "revision_proposals_by_object"),
        ("trigger", "revision_proposals_are_never_deleted"), ("trigger", "revision_proposals_start_open"), ("trigger", "revision_proposals_need_an_open_claim_and_a_current_base"),
        ("trigger", "revision_proposals_content_is_immutable"), ("trigger", "revision_proposals_terminal_states_are_final"), ("trigger", "revision_proposals_valid_transitions"),
        ("trigger", "revision_proposals_approved_needs_its_revision"), ("trigger", "revision_proposals_separated_needs_its_object"), ("trigger", "pending_claims_resolution_supersedes_open_proposals"),
        ("trigger", "pending_claims_are_never_deleted"), ("trigger", "pending_claims_accepted_needs_its_revision"),
    ];

    #[test]
    fn a_fresh_database_goes_straight_to_v9_with_every_v9_object_and_an_empty_proposals_table() {
        let store = CaptureStore::open_in_memory().unwrap();
        let connection = store.connection.lock().unwrap();
        assert_eq!(user_version(&connection), 9);
        for (kind, name) in V9_OBJECTS {
            assert!(has_object(&connection, kind, name), "{kind} {name}");
        }
        assert_eq!(count(&connection, "revision_proposals"), 0);
        let violations: i64 = connection.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
        assert_eq!(violations, 0);
    }

    #[test]
    fn a_populated_v8_database_upgrades_to_v9_with_every_existing_row_unchanged_and_no_proposal_invented() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v8_database(&path);
        let before = v8_fingerprint(&Connection::open(&path).unwrap());
        assert!(before.len() > 18, "the fixture is populated ({} rows)", before.len());

        let store = CaptureStore::open(&path).unwrap();
        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), 9);
        assert_eq!(v8_fingerprint(&connection), before, "captures, objects, revisions, relations, projects, identity decisions, pending claims and the search index are byte-identical");
        for (kind, name) in V9_OBJECTS {
            assert!(has_object(&connection, kind, name), "{kind} {name}");
        }
        assert_eq!(count(&connection, "revision_proposals"), 0, "nothing was backfilled: a v8 pending claim has no draft to recover");
        let integrity: String = connection.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        let violations: i64 = connection.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r.get(0)).unwrap();
        assert_eq!((integrity.as_str(), violations), ("ok", 0));
        // v8 behaviour is intact on the migrated file: the pending claim still resolves, history is still immutable
        assert!(connection.execute("UPDATE thought_revisions SET title = 'x'", []).is_err());
        assert!(connection.execute("DELETE FROM pending_claims", []).is_err());
        let claim = store.get_pending_claim("pc-1").unwrap().unwrap();
        assert_eq!(claim.state, "open");
        store.defer_pending_claim("pc-1", None).unwrap();
        store.reopen_pending_claim("pc-1").unwrap();
        drop(store);
        drop(connection);
        for _ in 0..3 {
            CaptureStore::open(&path).unwrap();
        }
        assert_eq!(user_version(&Connection::open(&path).unwrap()), 9);
    }

    #[test]
    fn a_failing_v9_upgrade_rolls_back_completely_and_leaves_v8_usable() {
        for blocker in [
            "CREATE TABLE revision_proposals (precious TEXT); INSERT INTO revision_proposals VALUES ('keep me');",
            // blocks only the LAST statement of the step: everything before it must roll back too
            "CREATE TRIGGER pending_claims_resolution_supersedes_open_proposals BEFORE UPDATE ON captures BEGIN SELECT 1; END;",
            "CREATE INDEX revision_proposals_by_object ON captures(id);",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("arthur.db");
            v8_database(&path);
            Connection::open(&path).unwrap().execute_batch(blocker).unwrap();
            let before = v8_fingerprint(&Connection::open(&path).unwrap());

            assert!(CaptureStore::open(&path).is_err(), "{blocker}");
            let connection = Connection::open(&path).unwrap();
            assert_eq!(user_version(&connection), 8, "still v8: {blocker}");
            assert_eq!(v8_fingerprint(&connection), before, "{blocker}");
            let leftovers: Vec<&str> = V9_OBJECTS[..12].iter().filter(|(kind, name)| has_object(&connection, kind, name)).map(|(_, name)| *name).collect();
            let expected: &[&str] = if blocker.contains("TABLE") { &["revision_proposals"] } else if blocker.contains("TRIGGER") { &["pending_claims_resolution_supersedes_open_proposals"] } else { &["revision_proposals_by_object"] };
            assert_eq!(leftovers, expected, "nothing of the failed step survived except the blocker itself: {blocker}");
            assert_eq!(connection.query_row("SELECT state FROM pending_claims WHERE id = 'pc-1'", [], |r| r.get::<_, String>(0)).unwrap(), "open", "v8 data is usable");
            assert!(connection.execute("UPDATE thought_revisions SET title = 'x'", []).is_err(), "v8 triggers still guard the data");
        }
    }

    #[test]
    fn an_interrupted_v9_upgrade_leaves_v8_intact_and_the_next_open_completes_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v8_database(&path);
        let before = v8_fingerprint(&Connection::open(&path).unwrap());
        {
            let connection = Connection::open(&path).unwrap();
            let half = SCHEMA_V9.split("CREATE TRIGGER revision_proposals_content_is_immutable").next().unwrap();
            connection.execute_batch(&format!("BEGIN IMMEDIATE; {half}")).unwrap();
            assert!(has_object(&connection, "table", "revision_proposals"), "visible inside the open transaction");
        }
        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), 8);
        assert!(!has_object(&connection, "table", "revision_proposals"), "the half-built step vanished");
        assert_eq!(v8_fingerprint(&connection), before);
        drop(connection);
        CaptureStore::open(&path).unwrap();
        let connection = Connection::open(&path).unwrap();
        assert_eq!(user_version(&connection), 9);
        assert_eq!(v8_fingerprint(&connection), before);
        assert!(V9_OBJECTS.iter().all(|(kind, name)| has_object(&connection, kind, name)));
    }

    #[test]
    fn an_older_binary_refuses_a_v9_database_untouched() {
        // "An older binary" is the migrator at its previous latest version (8): it must refuse version 9 and write nothing.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        v8_database(&path);
        CaptureStore::open(&path).unwrap();
        let bytes_before = std::fs::read(&path).unwrap();
        let mut connection = Connection::open(&path).unwrap();
        let outcome = migrate_with(&mut connection, &STEPS[..8]);
        assert!(matches!(outcome, Err(StoreError::Corrupt(_))), "{outcome:?}");
        drop(connection);
        assert_eq!(std::fs::read(&path).unwrap(), bytes_before, "refused without a single byte changing");
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
        assert_eq!(user_version(&connection), SCHEMA_VERSION);
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
        Connection::open(&newer).unwrap().pragma_update(None, "user_version", SCHEMA_VERSION + 1).unwrap();
        let bytes = std::fs::read(&newer).unwrap();
        assert!(matches!(CaptureStore::open(&newer), Err(StoreError::Corrupt(_))));
        assert_eq!(std::fs::read(&newer).unwrap(), bytes);
        println!("PROOF newer: a newer database was refused without modification");
    }

    #[test]
    fn migration_steps_are_ordered_and_end_at_the_declared_version() {
        let versions: Vec<i64> = STEPS.iter().map(|(v, _)| *v).collect();
        assert_eq!(versions, (1..=SCHEMA_VERSION).collect::<Vec<_>>());
        let _ = CreateCaptureInput { source: "text".into(), content: "x".into(), project_id: None };
    }
}
