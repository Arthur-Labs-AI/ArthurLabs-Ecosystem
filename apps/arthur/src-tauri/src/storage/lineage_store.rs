//! Thought Lineage: a DAG of immutable revisions for each knowledge object.
//!
//! The object keeps one stable id. A revision is an immutable snapshot of its kind/title/body. History is a DAG:
//! the initial revision has no parent; an edit or a branch has exactly one; a merge has two or more.
//!
//! AUTHORITY. `thought_revisions` is the history and `knowledge_objects.current_revision_id` picks the revision the
//! object currently is. The object's kind/title/body columns remain, as a PROJECTION of that revision: a database
//! trigger refuses any write that would make them differ from it, every mutation here updates both in ONE
//! transaction, and every read re-verifies it. So the two cannot drift.
//!
//! Every mutation goes through `insert_revision`, which checks everything before the first write and either commits
//! the revision, its parent links and (optionally) the current pointer together, or changes nothing.
//!
//! This is NOT the Cognitive Graph and not Capture provenance. A revision's own source span is set only when its text
//! was genuinely interpreted from that Capture: the initial revision keeps the object's original span, a user edit or a
//! merge has none (edited text is never claimed to come from a Capture), and only a revision created from a NEW Capture
//! carries that Capture's span. Graph relations hang off the object, not a revision, and are never touched here.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

use super::capture_store::{now_rfc3339, CaptureStore, StoreError};
use super::knowledge_store::{validate_span, Provenance, KINDS, MAX_BODY_CHARS, MAX_TITLE_CHARS};
use crate::lineage::diff::{diff_revisions, Content, RevisionDiff};

/// Mirrors `REVISION_ORIGINS` in `packages/contracts/lineage.ts`.
pub const ORIGINS: [&str; 5] = ["initial", "user_edit", "distillation", "merge", "system"];
/// Mirrors the limits in `packages/contracts/lineage.ts`.
pub const MAX_MERGE_PARENTS: usize = 8;
pub const MAX_REVISIONS_PER_OBJECT: usize = 1_000;

/// Mirrors `ThoughtRevision`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub id: String,
    pub object_id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub created_at: String,
    pub origin: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<Provenance>,
    /// Oldest first.
    pub parent_revision_ids: Vec<String>,
}

/// Mirrors `ObjectLineage`. Revisions are oldest first, so a parent always precedes its children.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lineage {
    pub object_id: String,
    pub current_revision_id: String,
    pub revisions: Vec<Revision>,
}

/// Mirrors `RevisionChanges`: a partial change relative to a parent revision.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Changes {
    pub kind: Option<String>,
    pub title: Option<String>,
    pub body: Option<String>,
}

/// A complete revision body, as supplied for a merge.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevisionContent {
    pub kind: String,
    pub title: String,
    pub body: String,
}

/// A span of a raw capture that a revision was interpreted from (Unicode code points, half-open).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceSpan {
    pub capture_id: String,
    pub start: i64,
    pub end: i64,
}

/// What `revise_if_current` is allowed to be applied to: the state a decision was made for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedRevision<'a> {
    pub object_id: &'a str,
    pub project_id: &'a str,
    pub base_revision_id: &'a str,
}

/// Who a compare-and-set revision is attributed to. Only these two exist: it can never mint an `initial`, `merge` or span-bearing
/// `distillation` revision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))] // no production caller yet (Phase 3 wires the pipeline)
pub enum CasOrigin {
    /// A revision Arthur made on its own (shown as "Created by Arthur").
    System,
    UserEdit,
}

impl CasOrigin {
    fn as_str(self) -> &'static str {
        match self {
            CasOrigin::System => "system",
            CasOrigin::UserEdit => "user_edit",
        }
    }
}

/// Why a compare-and-set revision was refused. Every variant means nothing was written.
#[derive(Debug)]
#[cfg_attr(not(test), allow(dead_code))] // fields are read by tests and by the Phase 3 pipeline
pub enum ReviseConflict {
    ObjectNotFound,
    ProjectMismatch { actual: String },
    ProjectArchived,
    /// The object moved on since the decision: someone else's revision is current.
    Stale { expected: String, actual: String },
    /// The content or lineage rules refuse it (empty, unchanged, over a limit, ...).
    Rejected(String),
    Store(StoreError),
}

impl From<StoreError> for ReviseConflict {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Invalid(reason) => ReviseConflict::Rejected(reason),
            StoreError::NotFound(_) => ReviseConflict::ObjectNotFound,
            other => ReviseConflict::Store(other),
        }
    }
}

const REVISION_COLUMNS: &str = "r.id, r.object_id, r.kind, r.title, r.body, r.origin, r.created_at, r.capture_id, r.source_start, r.source_end, length(c.content)";
const REVISION_FROM: &str = "thought_revisions r LEFT JOIN captures c ON c.id = r.capture_id";

type Row = (String, String, String, String, String, String, String, Option<String>, Option<i64>, Option<i64>, Option<i64>);

impl CaptureStore {
    /// The whole history of one object, oldest first, and which revision is current. Fails as a whole if anything
    /// stored is malformed or the object does not equal its current revision.
    pub fn object_lineage(&self, object_id: &str) -> Result<Lineage, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        lineage_in(&connection, object_id)
    }

    /// Same revisions as `object_lineage`, without the current pointer.
    pub fn list_revisions(&self, object_id: &str) -> Result<Vec<Revision>, StoreError> {
        Ok(self.object_lineage(object_id)?.revisions)
    }

    pub fn get_revision(&self, revision_id: &str) -> Result<Revision, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        revision_in(&connection, revision_id)
    }

    /// The direct parents of a revision, oldest first.
    pub fn revision_parents(&self, revision_id: &str) -> Result<Vec<Revision>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let revision = revision_in(&connection, revision_id)?;
        revision.parent_revision_ids.iter().map(|id| revision_in(&connection, id)).collect()
    }

    /// The revisions that name this one as a parent, oldest first.
    pub fn revision_children(&self, revision_id: &str) -> Result<Vec<Revision>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        revision_in(&connection, revision_id)?;
        let mut statement = connection.prepare("SELECT p.child_revision_id FROM revision_parents p JOIN thought_revisions r ON r.id = p.child_revision_id WHERE p.parent_revision_id = ?1 ORDER BY r.seq")?;
        let ids = statement.query_map([revision_id], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        ids.iter().map(|id| revision_in(&connection, id)).collect()
    }

    /// Edits an object: a new revision whose parent is the current one, which becomes current. The old revision is
    /// untouched. A change that changes nothing is rejected.
    pub fn update_object(&self, object_id: &str, changes: Changes) -> Result<Revision, StoreError> {
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction()?;
        let current = current_revision_in(&transaction, object_id)?;
        let content = apply_changes(&current, &changes)?;
        let created = insert_revision(&transaction, NewRevision { object_id, content, origin: "user_edit", provenance: None, parents: vec![current.id], make_current: true, created_at: None })?;
        transaction.commit()?;
        Ok(created)
    }

    /// A revision continuing from ANY revision of the object, including an old one (a branch). It does not become
    /// current unless `make_current` is set, so a branch never silently replaces the object's state.
    pub fn create_revision_from(&self, object_id: &str, parent_revision_id: &str, changes: Changes, make_current: bool) -> Result<Revision, StoreError> {
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction()?;
        ensure_object(&transaction, object_id)?;
        let parent = own_revision_in(&transaction, object_id, parent_revision_id)?;
        let content = apply_changes(&parent, &changes)?;
        let created = insert_revision(&transaction, NewRevision { object_id, content, origin: "user_edit", provenance: None, parents: vec![parent.id], make_current, created_at: None })?;
        transaction.commit()?;
        Ok(created)
    }

    /// Merges two or more revisions of one object into a NEW revision with all of them as parents. The caller supplies
    /// the merged content; nothing is merged automatically.
    pub fn merge_revisions(&self, object_id: &str, parent_revision_ids: &[String], result: RevisionContent, make_current: bool) -> Result<Revision, StoreError> {
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction()?;
        ensure_object(&transaction, object_id)?;
        let created = insert_revision(&transaction, NewRevision { object_id, content: result, origin: "merge", provenance: None, parents: parent_revision_ids.to_vec(), make_current, created_at: None })?;
        transaction.commit()?;
        Ok(created)
    }

    /// Evolves an object from a NEW capture the user chose: the new revision is interpreted from `span` of that capture
    /// and is the only kind of later revision that carries Capture provenance. `parent_revision_id` defaults to the
    /// current revision.
    // A domain capability (the storage invariant is the point of M03); no UI or command yet, and no automatic matching
    // of captures to objects. Exercised by the tests below.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn revise_from_capture(&self, object_id: &str, parent_revision_id: Option<&str>, span: SourceSpan, changes: Changes, make_current: bool) -> Result<Revision, StoreError> {
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction()?;
        ensure_object(&transaction, object_id)?;
        let parent = match parent_revision_id {
            Some(id) => own_revision_in(&transaction, object_id, id)?,
            None => current_revision_in(&transaction, object_id)?,
        };
        let content = apply_changes(&parent, &changes)?;
        let created = insert_revision(&transaction, NewRevision { object_id, content, origin: "distillation", provenance: Some(span), parents: vec![parent.id], make_current, created_at: None })?;
        transaction.commit()?;
        Ok(created)
    }

    /// Compare-and-set revision (M04.7B Phase 1): creates a child of `expected.base_revision_id` and makes it current ONLY IF, inside
    /// one write transaction, the object still exists, still belongs to `expected.project_id`, that project is not archived, and
    /// `base_revision_id` is STILL the current revision. Anything else is a typed conflict and nothing is written (the transaction is
    /// rolled back). A concurrent edit therefore produces `Stale`, never a silent overwrite.
    ///
    /// The writer never sets Capture provenance (no span is invented for text it did not quote) and never touches relations, the
    /// graph, or any retrieval index. It is not called by any command or by distillation yet.
    #[cfg_attr(not(test), allow(dead_code))] // no production caller yet (Phase 3 wires the pipeline)
    pub fn revise_if_current(&self, expected: &ExpectedRevision<'_>, content: RevisionContent, origin: CasOrigin) -> Result<Revision, ReviseConflict> {
        let mut connection = self.connection.lock().map_err(|_| ReviseConflict::Store(StoreError::Poisoned))?;
        // IMMEDIATE takes the write lock before the first read, so the check and the write cannot be separated by another connection.
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| ReviseConflict::Store(e.into()))?;
        let created = revise_if_current_in(&transaction, expected, content, origin)?;
        transaction.commit().map_err(|e| ReviseConflict::Store(e.into()))?;
        Ok(created)
    }

    /// A deterministic diff between two revisions of the same object.
    pub fn diff_revisions(&self, old_revision_id: &str, new_revision_id: &str) -> Result<RevisionDiff, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let old = revision_in(&connection, old_revision_id)?;
        let new = revision_in(&connection, new_revision_id)?;
        if old.object_id != new.object_id {
            return Err(StoreError::Invalid("revisions of different objects cannot be compared".into()));
        }
        Ok(diff_revisions(&content_of(&old), &content_of(&new)))
    }
}

fn content_of(revision: &Revision) -> Content<'_> {
    Content { id: &revision.id, kind: &revision.kind, title: &revision.title, body: &revision.body }
}

/// The compare-and-set body, for composing into a larger transaction. The CALLER owns the transaction and must have begun it IMMEDIATE;
/// on any error it must roll back (dropping the transaction does). Writes nothing when it returns an error.
pub fn revise_if_current_in(connection: &Connection, expected: &ExpectedRevision<'_>, content: RevisionContent, origin: CasOrigin) -> Result<Revision, ReviseConflict> {
    let row: Option<(String, Option<String>)> = connection
        .query_row("SELECT project_id, current_revision_id FROM knowledge_objects WHERE id = ?1", [expected.object_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()
        .map_err(|e| ReviseConflict::Store(e.into()))?;
    let (project_id, current) = row.ok_or(ReviseConflict::ObjectNotFound)?;
    if project_id != expected.project_id {
        return Err(ReviseConflict::ProjectMismatch { actual: project_id });
    }
    let archived: Option<bool> = connection
        .query_row("SELECT archived_at IS NOT NULL FROM projects WHERE id = ?1", [&project_id], |row| row.get(0))
        .optional()
        .map_err(|e| ReviseConflict::Store(e.into()))?;
    if archived != Some(false) {
        return Err(ReviseConflict::ProjectArchived);
    }
    let current = current.ok_or_else(|| ReviseConflict::Store(StoreError::Corrupt(format!("knowledge object {:?} has no current revision", expected.object_id))))?;
    if current != expected.base_revision_id {
        return Err(ReviseConflict::Stale { expected: expected.base_revision_id.to_string(), actual: current });
    }
    let base = own_revision_in(connection, expected.object_id, &current)?;
    if (content.kind.as_str(), content.title.as_str(), content.body.as_str()) == (base.kind.as_str(), base.title.as_str(), base.body.as_str()) {
        return Err(ReviseConflict::Rejected("nothing changed".into()));
    }
    Ok(insert_revision(
        connection,
        NewRevision { object_id: expected.object_id, content, origin: origin.as_str(), provenance: None, parents: vec![base.id], make_current: true, created_at: None },
    )?)
}

/// Creates an object's initial revision and makes it current. Called inside the transaction that inserts the
/// object, so an object never exists without its first revision.
pub(super) fn create_initial_revision(
    connection: &Connection,
    object_id: &str,
    (kind, title, body): (&str, &str, &str),
    created_at: &str,
    source: Option<(&str, i64, i64)>,
) -> Result<(), StoreError> {
    let provenance = source.map(|(capture_id, start, end)| SourceSpan { capture_id: capture_id.to_string(), start, end });
    insert_revision(
        connection,
        NewRevision {
            object_id,
            content: RevisionContent { kind: kind.into(), title: title.into(), body: body.into() },
            origin: "initial",
            provenance,
            parents: vec![],
            make_current: true,
            created_at: Some(created_at.to_string()),
        },
    )?;
    Ok(())
}

struct NewRevision<'a> {
    object_id: &'a str,
    content: RevisionContent,
    origin: &'static str,
    provenance: Option<SourceSpan>,
    parents: Vec<String>,
    make_current: bool,
    created_at: Option<String>,
}

/// The one way a revision comes into existence. Validates everything first, then writes the revision, its parent
/// links and (optionally) the object's current pointer. The caller owns the transaction.
fn insert_revision(connection: &Connection, new: NewRevision<'_>) -> Result<Revision, StoreError> {
    let invalid = |reason: &str| StoreError::Invalid(reason.to_string());
    ensure_object(connection, new.object_id)?;
    let existing: i64 = connection.query_row("SELECT count(*) FROM thought_revisions WHERE object_id = ?1", [new.object_id], |row| row.get(0))?;
    if existing as usize >= MAX_REVISIONS_PER_OBJECT {
        return Err(StoreError::Invalid(format!("an object has at most {MAX_REVISIONS_PER_OBJECT} revisions")));
    }
    validate_content(&new.content).map_err(StoreError::Invalid)?;

    // Parent rules by origin: initial has none, a merge has two or more, everything else exactly one.
    let allowed = match new.origin {
        "initial" => 0..=0,
        "merge" => 2..=MAX_MERGE_PARENTS,
        _ => 1..=1,
    };
    if !allowed.contains(&new.parents.len()) {
        return Err(StoreError::Invalid(match new.origin {
            "initial" => "an initial revision has no parent".to_string(),
            "merge" => format!("a merge needs between 2 and {MAX_MERGE_PARENTS} parent revisions"),
            _ => "this revision needs exactly one parent".to_string(),
        }));
    }
    if new.parents.iter().collect::<HashSet<_>>().len() != new.parents.len() {
        return Err(invalid("a parent revision is listed twice"));
    }
    for parent in &new.parents {
        own_revision_in(connection, new.object_id, parent)?;
    }

    if let Some(span) = &new.provenance {
        let content: Option<String> = connection.query_row("SELECT content FROM captures WHERE id = ?1", [&span.capture_id], |row| row.get(0)).optional()?;
        let content = content.ok_or_else(|| invalid("the source capture does not exist"))?;
        validate_span(&content, span.start, span.end).map_err(StoreError::Invalid)?;
    }

    let id = Uuid::new_v4().to_string();
    let created_at = match new.created_at {
        Some(at) => at,
        None => now_rfc3339()?,
    };
    let (capture_id, start, end) = match &new.provenance {
        Some(span) => (Some(span.capture_id.as_str()), Some(span.start), Some(span.end)),
        None => (None, None, None),
    };
    connection.execute(
        "INSERT INTO thought_revisions (id, object_id, kind, title, body, origin, created_at, capture_id, source_start, source_end) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![id, new.object_id, new.content.kind, new.content.title, new.content.body, new.origin, created_at, capture_id, start, end],
    )?;
    for parent in &new.parents {
        // A brand-new revision has no descendants, so this is always false here; the check is the same one that
        // guards any edge, and the database refuses a cycle independently (see schema v4).
        if would_create_cycle(connection, &id, parent)? {
            return Err(invalid("a revision cannot be its own ancestor"));
        }
        connection.execute("INSERT INTO revision_parents (child_revision_id, parent_revision_id) VALUES (?1, ?2)", params![id, parent])?;
    }
    if new.make_current {
        // The projection guard accepts this only because the revision just inserted equals these values.
        connection.execute(
            "UPDATE knowledge_objects SET kind = ?1, title = ?2, body = ?3, current_revision_id = ?4 WHERE id = ?5",
            params![new.content.kind, new.content.title, new.content.body, id, new.object_id],
        )?;
    }
    revision_in(connection, &id)
}

/// Would making `parent` a parent of `child` put `child` among its own ancestors? True when `parent` is `child` or
/// descends from it.
pub(super) fn would_create_cycle(connection: &Connection, child: &str, parent: &str) -> Result<bool, StoreError> {
    let found: Option<i64> = connection
        .query_row(
            "WITH RECURSIVE descendants(id) AS (
                 SELECT ?1
                 UNION
                 SELECT p.child_revision_id FROM revision_parents p JOIN descendants d ON p.parent_revision_id = d.id
             )
             SELECT 1 FROM descendants WHERE id = ?2 LIMIT 1",
            params![child, parent],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

fn validate_content(content: &RevisionContent) -> Result<(), String> {
    if !KINDS.contains(&content.kind.as_str()) {
        return Err(format!("unknown kind \"{}\"", content.kind));
    }
    if content.title.trim().is_empty() {
        return Err("title is empty".into());
    }
    if content.title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!("title exceeds {MAX_TITLE_CHARS} characters"));
    }
    if content.body.trim().is_empty() {
        return Err("body is empty".into());
    }
    if content.body.chars().count() > MAX_BODY_CHARS {
        return Err(format!("body exceeds {MAX_BODY_CHARS} characters"));
    }
    Ok(())
}

/// `base` with `changes` applied. Rejects an empty change and a change that leaves everything as it was.
fn apply_changes(base: &Revision, changes: &Changes) -> Result<RevisionContent, StoreError> {
    if changes.kind.is_none() && changes.title.is_none() && changes.body.is_none() {
        return Err(StoreError::Invalid("nothing to change".into()));
    }
    let content = RevisionContent {
        kind: changes.kind.clone().unwrap_or_else(|| base.kind.clone()),
        title: changes.title.clone().unwrap_or_else(|| base.title.clone()),
        body: changes.body.clone().unwrap_or_else(|| base.body.clone()),
    };
    validate_content(&content).map_err(StoreError::Invalid)?;
    if content.kind == base.kind && content.title == base.title && content.body == base.body {
        return Err(StoreError::Invalid("nothing changed".into()));
    }
    Ok(content)
}

fn ensure_object(connection: &Connection, object_id: &str) -> Result<(), StoreError> {
    let exists = connection.query_row("SELECT 1 FROM knowledge_objects WHERE id = ?1", [object_id], |_| Ok(())).optional()?.is_some();
    if exists { Ok(()) } else { Err(StoreError::NotFound("object does not exist".into())) }
}

/// A revision that must belong to `object_id`.
fn own_revision_in(connection: &Connection, object_id: &str, revision_id: &str) -> Result<Revision, StoreError> {
    let revision = revision_in(connection, revision_id)?;
    if revision.object_id != object_id {
        return Err(StoreError::Invalid("that revision belongs to a different object".into()));
    }
    Ok(revision)
}

fn current_revision_in(connection: &Connection, object_id: &str) -> Result<Revision, StoreError> {
    let current: Option<Option<String>> = connection.query_row("SELECT current_revision_id FROM knowledge_objects WHERE id = ?1", [object_id], |row| row.get(0)).optional()?;
    let current = current.ok_or_else(|| StoreError::NotFound("object does not exist".into()))?;
    let id = current.ok_or_else(|| StoreError::Corrupt(format!("knowledge object {object_id:?} has no current revision")))?;
    revision_in(connection, &id)
}

/// A revision by id, verified like every read.
pub(super) fn revision_for(connection: &Connection, revision_id: &str) -> Result<Revision, StoreError> {
    revision_in(connection, revision_id)
}

fn revision_in(connection: &Connection, revision_id: &str) -> Result<Revision, StoreError> {
    let row = connection
        .query_row(&format!("SELECT {REVISION_COLUMNS} FROM {REVISION_FROM} WHERE r.id = ?1"), [revision_id], |row| row_tuple(row))
        .optional()?;
    let row = row.ok_or_else(|| StoreError::MissingRevision("revision does not exist".into()))?;
    revision_from_row(connection, row)
}

fn row_tuple(row: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?))
}

fn parents_of(connection: &Connection, revision_id: &str) -> Result<Vec<String>, StoreError> {
    let mut statement = connection.prepare("SELECT p.parent_revision_id FROM revision_parents p JOIN thought_revisions r ON r.id = p.parent_revision_id WHERE p.child_revision_id = ?1 ORDER BY r.seq")?;
    let parents = statement.query_map([revision_id], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
    Ok(parents)
}

/// A stored revision is re-checked on every read: nothing malformed is ever handed out.
fn revision_from_row(connection: &Connection, row: Row) -> Result<Revision, StoreError> {
    let (id, object_id, kind, title, body, origin, created_at, capture_id, start, end, capture_len) = row;
    let corrupt = |reason: &str| StoreError::Corrupt(format!("revision {id:?}: {reason}"));
    if !KINDS.contains(&kind.as_str()) {
        return Err(corrupt("unknown kind"));
    }
    if !ORIGINS.contains(&origin.as_str()) {
        return Err(corrupt("unknown origin"));
    }
    if title.trim().is_empty() || body.trim().is_empty() {
        return Err(corrupt("empty title or body"));
    }
    if OffsetDateTime::parse(&created_at, &Rfc3339).is_err() {
        return Err(corrupt("created_at is not RFC 3339"));
    }
    let provenance = match (capture_id, start, end) {
        (None, None, None) => None,
        (Some(capture_id), Some(source_start), Some(source_end)) => {
            if source_start < 0 || source_end <= source_start || capture_len.is_none_or(|length| source_end > length) {
                return Err(corrupt("source span is outside its capture"));
            }
            Some(Provenance { capture_id, source_start, source_end })
        }
        _ => return Err(corrupt("incomplete source span")),
    };
    let parent_revision_ids = parents_of(connection, &id)?;
    let shape_ok = match origin.as_str() {
        "initial" => parent_revision_ids.is_empty(),
        "merge" => parent_revision_ids.len() >= 2,
        _ => parent_revision_ids.len() == 1,
    };
    if !shape_ok {
        return Err(corrupt("its parents do not match its origin"));
    }
    Ok(Revision { id, object_id, kind, title, body, created_at, origin, provenance, parent_revision_ids })
}

fn lineage_in(connection: &Connection, object_id: &str) -> Result<Lineage, StoreError> {
    let object: Option<(String, String, String, Option<String>)> = connection
        .query_row("SELECT kind, title, body, current_revision_id FROM knowledge_objects WHERE id = ?1", [object_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .optional()?;
    let (kind, title, body, current) = object.ok_or_else(|| StoreError::NotFound("object does not exist".into()))?;
    let corrupt = |reason: &str| StoreError::Corrupt(format!("lineage of {object_id:?}: {reason}"));
    let current = current.ok_or_else(|| corrupt("the object has no current revision"))?;

    let mut statement = connection.prepare(&format!("SELECT {REVISION_COLUMNS} FROM {REVISION_FROM} WHERE r.object_id = ?1 ORDER BY r.seq"))?;
    let rows = statement.query_map([object_id], |row| row_tuple(row))?.collect::<Result<Vec<_>, _>>()?;
    let revisions = rows.into_iter().map(|row| revision_from_row(connection, row)).collect::<Result<Vec<_>, _>>()?;

    if revisions.first().is_none_or(|first| first.origin != "initial") {
        return Err(corrupt("the history does not start with its initial revision"));
    }
    // Every parent exists, belongs to this object and is older than its child: so the history is acyclic.
    for (index, revision) in revisions.iter().enumerate() {
        for parent in &revision.parent_revision_ids {
            if !revisions[..index].iter().any(|earlier| &earlier.id == parent) {
                return Err(corrupt("a parent is missing, belongs to another object, or is not older than its child"));
            }
        }
    }
    let head = revisions.iter().find(|r| r.id == current).ok_or_else(|| corrupt("the current revision is not part of the history"))?;
    if (head.kind.as_str(), head.title.as_str(), head.body.as_str()) != (kind.as_str(), title.as_str(), body.as_str()) {
        return Err(corrupt("the object differs from its current revision"));
    }
    Ok(Lineage { object_id: object_id.to_string(), current_revision_id: current, revisions })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::capture_store::{Capture, CreateCaptureInput};
    use crate::storage::knowledge_store::{KnowledgeObject, NewKnowledgeObject};
    use crate::storage::relation_store::NewRelation;

    const TEXT: &str = "Arthur should organize my ideas automatically.";

    /// One capture, distilled into one object (and so one initial revision).
    fn setup() -> (CaptureStore, Capture, KnowledgeObject) {
        let store = CaptureStore::open_in_memory().unwrap();
        let capture = store.create(CreateCaptureInput { source: "text".into(), content: TEXT.into(), project_id: None }).unwrap();
        let object = store
            .record_distillation(&capture.id, vec![NewKnowledgeObject { kind: "idea".into(), title: "Organize ideas".into(), body: TEXT.into(), source_start: 0, source_end: 46 }])
            .unwrap()
            .remove(0);
        (store, capture, object)
    }

    fn change(title: Option<&str>, body: Option<&str>, kind: Option<&str>) -> Changes {
        Changes { title: title.map(Into::into), body: body.map(Into::into), kind: kind.map(Into::into) }
    }

    fn body(text: &str) -> Changes {
        change(None, Some(text), None)
    }

    fn content(kind: &str, title: &str, text: &str) -> RevisionContent {
        RevisionContent { kind: kind.into(), title: title.into(), body: text.into() }
    }

    fn count(store: &CaptureStore, sql: &str) -> i64 {
        store.connection.lock().unwrap().query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn current(store: &CaptureStore, object: &KnowledgeObject) -> String {
        store.object_lineage(&object.id).unwrap().current_revision_id
    }

    /// R1 (initial), R2 (edit of R1, current), R3 (branch from R1).
    fn r1_r2_r3() -> (CaptureStore, Capture, KnowledgeObject, Revision, Revision, Revision) {
        let (store, capture, object) = setup();
        let r1 = store.object_lineage(&object.id).unwrap().revisions.remove(0);
        let r2 = store.update_object(&object.id, body("Arthur should organize my ideas automatically and connect related ideas.")).unwrap();
        let r3 = store.create_revision_from(&object.id, &r1.id, body("Arthur should organize my ideas automatically without changing the original notes."), false).unwrap();
        (store, capture, object, r1, r2, r3)
    }

    // --- the initial revision ---------------------------------------------------------------------------

    #[test]
    fn distilling_creates_an_initial_revision_that_keeps_the_original_source_span() {
        let (store, capture, object) = setup();

        let lineage = store.object_lineage(&object.id).unwrap();

        assert_eq!(lineage.revisions.len(), 1);
        let r1 = &lineage.revisions[0];
        assert_eq!(lineage.current_revision_id, r1.id);
        assert_eq!((r1.origin.as_str(), r1.parent_revision_ids.len()), ("initial", 0));
        assert_eq!((r1.kind.as_str(), r1.title.as_str(), r1.body.as_str(), r1.created_at.as_str()), ("idea", "Organize ideas", TEXT, object.created_at.as_str()));
        assert_eq!(r1.provenance, Some(Provenance { capture_id: capture.id.clone(), source_start: 0, source_end: 46 }));
        assert_eq!(r1.provenance.as_ref().unwrap(), &object.provenance, "the revision's span is the object's original span");
        assert_eq!(Uuid::parse_str(&r1.id).unwrap().get_version_num(), 4);
        assert_eq!(count(&store, "SELECT count(*) FROM thought_revisions"), 1);
    }

    // --- edits ------------------------------------------------------------------------------------------

    #[test]
    fn an_edit_creates_a_new_immutable_revision_whose_parent_is_the_previous_current_one() {
        let (store, _capture, object) = setup();
        let r1 = store.object_lineage(&object.id).unwrap().revisions.remove(0);

        let r2 = store.update_object(&object.id, body("Arthur should organize my ideas automatically and connect related ideas.")).unwrap();

        assert_eq!((r2.origin.as_str(), r2.parent_revision_ids.clone()), ("user_edit", vec![r1.id.clone()]));
        assert_eq!(Uuid::parse_str(&r2.id).unwrap().get_version_num(), 4);
        assert!(OffsetDateTime::parse(&r2.created_at, &Rfc3339).is_ok());
        assert_ne!(r2.id, r1.id);
        let lineage = store.object_lineage(&object.id).unwrap();
        assert_eq!(lineage.current_revision_id, r2.id, "the edit is current");
        assert_eq!(lineage.revisions, vec![r1.clone(), r2.clone()]);
        assert_eq!(store.get_revision(&r1.id).unwrap(), r1, "the old revision is exactly as it was");
        // The object projection shows the new text.
        let listed = store.list_knowledge_objects().unwrap();
        assert_eq!((listed[0].title.as_str(), listed[0].body.as_str()), ("Organize ideas", r2.body.as_str()));
    }

    #[test]
    fn title_only_body_only_and_kind_only_edits_change_exactly_that_field() {
        let (store, _capture, object) = setup();
        let base = store.object_lineage(&object.id).unwrap().revisions.remove(0);

        let t = store.update_object(&object.id, change(Some("New title"), None, None)).unwrap();
        assert_eq!((t.title.as_str(), t.body.as_str(), t.kind.as_str()), ("New title", base.body.as_str(), "idea"));
        let b = store.update_object(&object.id, body("New body")).unwrap();
        assert_eq!((b.title.as_str(), b.body.as_str(), b.kind.as_str()), ("New title", "New body", "idea"));
        let k = store.update_object(&object.id, change(None, None, Some("decision"))).unwrap();
        assert_eq!((k.title.as_str(), k.body.as_str(), k.kind.as_str()), ("New title", "New body", "decision"));
        assert_eq!(store.object_lineage(&object.id).unwrap().revisions.len(), 4);
        assert_eq!(store.list_knowledge_objects().unwrap()[0].kind, "decision");
    }

    #[test]
    fn a_no_op_or_invalid_edit_is_rejected_and_changes_nothing() {
        let (store, _capture, object) = setup();
        let before = store.object_lineage(&object.id).unwrap();
        let rejected = [
            Changes::default(),
            change(Some("Organize ideas"), None, None),
            change(Some("Organize ideas"), Some(TEXT), Some("idea")),
            change(Some("   "), None, None),
            body(""),
            change(None, None, Some("gizmo")),
            change(None, None, Some("Idea")),
            change(Some(&"t".repeat(201)), None, None),
            body(&"b".repeat(2_001)),
        ];
        for changes in rejected {
            assert!(matches!(store.update_object(&object.id, changes.clone()), Err(StoreError::Invalid(_))), "{changes:?}");
        }
        assert_eq!(store.object_lineage(&object.id).unwrap(), before);
        assert!(matches!(store.update_object("00000000-0000-4000-8000-000000000000", body("x")), Err(StoreError::NotFound(_))));
    }

    #[test]
    fn revision_rows_cannot_be_rewritten_or_have_their_parents_changed() {
        let (store, _capture, object, r1, r2, _r3) = r1_r2_r3();
        let connection = store.connection.lock().unwrap();
        assert!(connection.execute("UPDATE thought_revisions SET title = 'tampered' WHERE id = ?1", [&r1.id]).is_err());
        assert!(connection.execute("UPDATE thought_revisions SET created_at = 'x' WHERE id = ?1", [&r1.id]).is_err());
        assert!(connection.execute("UPDATE thought_revisions SET origin = 'merge' WHERE id = ?1", [&r2.id]).is_err());
        assert!(connection.execute("UPDATE revision_parents SET parent_revision_id = ?1 WHERE child_revision_id = ?2", [&r2.id, &r2.id]).is_err());
        assert!(connection.execute("DELETE FROM thought_revisions WHERE id = ?1", [&r2.id]).is_err(), "the current revision cannot be deleted from under its object");
        drop(connection);
        assert_eq!(store.get_revision(&r1.id).unwrap(), r1);
        let _ = object;
    }

    // --- branches, merges and the DAG -----------------------------------------------------------------

    #[test]
    fn a_branch_from_an_old_revision_does_not_become_current_or_erase_the_other_continuation() {
        let (store, _capture, object, r1, r2, r3) = r1_r2_r3();

        assert_eq!(r3.parent_revision_ids, vec![r1.id.clone()]);
        let lineage = store.object_lineage(&object.id).unwrap();
        assert_eq!(lineage.current_revision_id, r2.id, "creating the branch left R2 current");
        assert_eq!(lineage.revisions.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), [r1.id.clone(), r2.id.clone(), r3.id.clone()]);
        let children = store.revision_children(&r1.id).unwrap();
        assert_eq!(children.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), [r2.id.clone(), r3.id.clone()], "one revision, several continuations");
        assert_eq!(store.list_knowledge_objects().unwrap()[0].body, r2.body, "the object still shows R2");
        assert_eq!(store.revision_parents(&r3.id).unwrap(), vec![r1.clone()]);
        assert!(store.revision_parents(&r1.id).unwrap().is_empty());
    }

    #[test]
    fn a_branch_can_ask_to_become_current_and_the_projection_follows() {
        let (store, _capture, object) = setup();
        let r1 = store.object_lineage(&object.id).unwrap().revisions.remove(0);
        let r2 = store.create_revision_from(&object.id, &r1.id, body("Branch text"), true).unwrap();
        assert_eq!(current(&store, &object), r2.id);
        assert_eq!(store.list_knowledge_objects().unwrap()[0].body, "Branch text");
        // A child of the current revision made as a branch (not current) leaves the pointer alone.
        let r3 = store.create_revision_from(&object.id, &r2.id, body("Later text"), false).unwrap();
        assert_eq!(current(&store, &object), r2.id);
        assert_eq!(r3.parent_revision_ids, vec![r2.id]);
    }

    #[test]
    fn a_merge_has_all_its_parents_and_does_not_become_current_unless_asked() {
        let (store, _capture, object, r1, r2, r3) = r1_r2_r3();

        let r4 = store.merge_revisions(&object.id, &[r2.id.clone(), r3.id.clone()], content("idea", "Organize ideas", "Organize and connect ideas without changing the original notes."), false).unwrap();

        assert_eq!((r4.origin.as_str(), r4.parent_revision_ids.clone()), ("merge", vec![r2.id.clone(), r3.id.clone()]));
        assert_eq!(r4.provenance, None, "merged text is not claimed to come from a capture");
        assert_eq!(current(&store, &object), r2.id, "an unrequested merge leaves the current revision alone");
        let merged_current = store.merge_revisions(&object.id, &[r3.id.clone(), r2.id.clone()], content("idea", "Organize ideas", "Merged again."), true).unwrap();
        assert_eq!(current(&store, &object), merged_current.id);
        assert_eq!(store.list_knowledge_objects().unwrap()[0].body, "Merged again.");
        assert_eq!(merged_current.parent_revision_ids, vec![r2.id.clone(), r3.id.clone()], "parents are ordered by age, not by the order given");
        for id in [&r2.id, &r3.id] {
            assert!(store.revision_children(id).unwrap().iter().any(|c| c.id == r4.id));
        }
        let _ = r1;
    }

    #[test]
    fn a_merge_may_have_more_than_two_parents_up_to_a_limit() {
        let (store, _capture, object, r1, r2, r3) = r1_r2_r3();
        let three = store.merge_revisions(&object.id, &[r1.id.clone(), r2.id.clone(), r3.id.clone()], content("idea", "Three way", "Combined."), false).unwrap();
        assert_eq!(three.parent_revision_ids.len(), 3);
        // Up to MAX_MERGE_PARENTS distinct revisions are allowed.
        let mut ids = vec![r1.id.clone(), r2.id.clone(), r3.id.clone(), three.id.clone()];
        while ids.len() < MAX_MERGE_PARENTS {
            let extra = store.create_revision_from(&object.id, &r1.id, body(&format!("Branch {}", ids.len())), false).unwrap();
            ids.push(extra.id);
        }
        assert!(store.merge_revisions(&object.id, &ids, content("idea", "Many", "All of them."), false).is_ok());
        let extra = store.create_revision_from(&object.id, &r1.id, body("One too many"), false).unwrap();
        ids.push(extra.id);
        assert!(matches!(store.merge_revisions(&object.id, &ids, content("idea", "Too many", "No."), false), Err(StoreError::Invalid(_))));
    }

    #[test]
    fn invalid_parents_are_rejected_for_every_operation() {
        let (store, capture, object, r1, r2, _r3) = r1_r2_r3();
        let other = store
            .record_distillation(&store.create(CreateCaptureInput { source: "text".into(), content: "A second object here".into(), project_id: None }).unwrap().id, vec![NewKnowledgeObject { kind: "note".into(), title: "Other".into(), body: "Other".into(), source_start: 0, source_end: 5 }])
            .unwrap()
            .remove(0);
        let foreign = store.object_lineage(&other.id).unwrap().revisions.remove(0);
        let before = count(&store, "SELECT count(*) FROM thought_revisions");
        let ghost = "00000000-0000-4000-8000-000000000000".to_string();

        // Foreign-object parent.
        assert!(matches!(store.create_revision_from(&object.id, &foreign.id, body("x"), false), Err(StoreError::Invalid(_))));
        assert!(matches!(store.merge_revisions(&object.id, &[r1.id.clone(), foreign.id.clone()], content("idea", "t", "b"), false), Err(StoreError::Invalid(_))));
        // Unknown revision.
        assert!(matches!(store.create_revision_from(&object.id, &ghost, body("x"), false), Err(StoreError::MissingRevision(_))));
        assert!(matches!(store.merge_revisions(&object.id, &[r1.id.clone(), ghost.clone()], content("idea", "t", "b"), false), Err(StoreError::MissingRevision(_))));
        // Unknown object.
        assert!(matches!(store.create_revision_from(&ghost, &r1.id, body("x"), false), Err(StoreError::NotFound(_))));
        // A merge needs two or more DISTINCT parents.
        assert!(matches!(store.merge_revisions(&object.id, &[r1.id.clone()], content("idea", "t", "b"), false), Err(StoreError::Invalid(_))));
        assert!(matches!(store.merge_revisions(&object.id, &[], content("idea", "t", "b"), false), Err(StoreError::Invalid(_))));
        assert!(matches!(store.merge_revisions(&object.id, &[r2.id.clone(), r2.id.clone()], content("idea", "t", "b"), false), Err(StoreError::Invalid(reason)) if reason.contains("twice")));
        // Invalid merged content.
        for bad in [content("gizmo", "t", "b"), content("idea", " ", "b"), content("idea", "t", "")] {
            assert!(matches!(store.merge_revisions(&object.id, &[r1.id.clone(), r2.id.clone()], bad, false), Err(StoreError::Invalid(_))));
        }
        assert_eq!(count(&store, "SELECT count(*) FROM thought_revisions"), before, "nothing was written by any rejected call");
        let _ = capture;
    }

    // --- cycles ------------------------------------------------------------------------------------------

    /// R1 <- R2 <- R3 <- R4 (a chain), all of one object.
    fn chain() -> (CaptureStore, KnowledgeObject, Vec<Revision>) {
        let (store, _capture, object) = setup();
        let mut revisions = store.object_lineage(&object.id).unwrap().revisions;
        for n in 2..=4 {
            revisions.push(store.update_object(&object.id, body(&format!("version {n}"))).unwrap());
        }
        (store, object, revisions)
    }

    #[test]
    fn the_cycle_check_sees_through_several_levels() {
        let (store, _object, r) = chain();
        let connection = store.connection.lock().unwrap();
        // R1 as a child of R4 would close a 4-level loop; R2 and R3 likewise; a revision as its own parent too.
        for ancestor in 0..4 {
            assert!(would_create_cycle(&connection, &r[ancestor].id, &r[3].id).unwrap(), "R{} <- R4 must be refused", ancestor + 1);
        }
        assert!(would_create_cycle(&connection, &r[1].id, &r[1].id).unwrap());
        assert!(would_create_cycle(&connection, &r[0].id, &r[2].id).unwrap(), "two levels");
        // The legitimate direction is fine.
        assert!(!would_create_cycle(&connection, &r[3].id, &r[0].id).unwrap());
        assert!(!would_create_cycle(&connection, &r[2].id, &r[1].id).unwrap());
    }

    #[test]
    fn the_database_itself_refuses_self_duplicate_cyclic_cross_object_and_backwards_parent_edges() {
        let (store, _object, r) = chain();
        let other_capture = store.create(CreateCaptureInput { source: "text".into(), content: "Something else entirely".into(), project_id: None }).unwrap();
        let other = store.record_distillation(&other_capture.id, vec![NewKnowledgeObject { kind: "note".into(), title: "O".into(), body: "O".into(), source_start: 0, source_end: 5 }]).unwrap().remove(0);
        let foreign = store.object_lineage(&other.id).unwrap().revisions.remove(0);
        let connection = store.connection.lock().unwrap();
        let link = |child: &str, parent: &str| connection.execute("INSERT INTO revision_parents (child_revision_id, parent_revision_id) VALUES (?1, ?2)", [child, parent]);

        assert!(link(&r[1].id, &r[1].id).is_err(), "self parent");
        assert!(link(&r[1].id, &r[0].id).is_err(), "duplicate edge");
        assert!(link(&r[0].id, &r[1].id).is_err(), "direct cycle");
        assert!(link(&r[0].id, &r[3].id).is_err(), "cycle across three levels");
        assert!(link(&r[1].id, &r[3].id).is_err(), "cycle across two levels");
        assert!(link(&r[3].id, &foreign.id).is_err(), "a parent from another object");
        assert!(link(&foreign.id, &r[0].id).is_err(), "a child in another object");
        assert!(link(&r[1].id, &r[2].id).is_err(), "a parent that is newer than its child");
        // An extra, forward edge that keeps the graph acyclic is allowed by the database (the store never makes one).
        assert!(link(&r[3].id, &r[0].id).is_ok());
        assert_eq!(connection.query_row::<i64, _, _>("SELECT count(*) FROM revision_parents", [], |row| row.get(0)).unwrap(), 4);
    }

    #[test]
    fn the_cycle_guard_holds_even_if_the_ordering_guard_is_removed() {
        let (store, _object, r) = chain();
        store.execute_sql_for_test("DROP TRIGGER revision_parents_parent_is_older");
        let connection = store.connection.lock().unwrap();
        let attempt = connection.execute("INSERT INTO revision_parents (child_revision_id, parent_revision_id) VALUES (?1, ?2)", [&r[0].id, &r[3].id]);
        assert!(attempt.is_err(), "the explicit cycle trigger still refuses R1 <- R4");
        assert!(format!("{:?}", attempt.unwrap_err()).contains("own ancestor"));
    }

    // --- current state: the projection cannot drift ---------------------------------------------------

    #[test]
    fn an_object_can_never_differ_from_its_current_revision() {
        let (store, _capture, object, r1, r2, r3) = r1_r2_r3();
        let connection = store.connection.lock().unwrap();
        let update = |sql: &str, args: &[&dyn rusqlite::ToSql]| connection.execute(sql, args);

        assert!(update("UPDATE knowledge_objects SET title = 'drift' WHERE id = ?1", &[&object.id]).is_err(), "text edited behind the revision's back");
        assert!(update("UPDATE knowledge_objects SET body = 'drift' WHERE id = ?1", &[&object.id]).is_err());
        assert!(update("UPDATE knowledge_objects SET kind = 'task' WHERE id = ?1", &[&object.id]).is_err());
        assert!(update("UPDATE knowledge_objects SET current_revision_id = ?1 WHERE id = ?2", &[&r1.id, &object.id]).is_err(), "pointer moved without the text");
        assert!(update("UPDATE knowledge_objects SET current_revision_id = ?1 WHERE id = ?2", &[&r3.id, &object.id]).is_err());
        assert!(update("UPDATE knowledge_objects SET current_revision_id = NULL WHERE id = ?1", &[&object.id]).is_err());
        assert!(update("UPDATE knowledge_objects SET current_revision_id = 'nope' WHERE id = ?1", &[&object.id]).is_err());
        drop(connection);
        assert_eq!(current(&store, &object), r2.id);
        assert_eq!(store.list_knowledge_objects().unwrap()[0].body, r2.body);
    }

    #[test]
    fn a_pointer_to_another_objects_revision_is_refused() {
        let (store, _capture, object) = setup();
        let other_capture = store.create(CreateCaptureInput { source: "text".into(), content: "Totally different".into(), project_id: None }).unwrap();
        let other = store.record_distillation(&other_capture.id, vec![NewKnowledgeObject { kind: "idea".into(), title: "Organize ideas".into(), body: TEXT.into(), source_start: 0, source_end: 5 }]).unwrap().remove(0);
        let foreign = store.object_lineage(&other.id).unwrap().revisions.remove(0);
        // Same text on purpose: only the ownership check can refuse this.
        let attempt = store.connection.lock().unwrap().execute("UPDATE knowledge_objects SET current_revision_id = ?1 WHERE id = ?2", [&foreign.id, &object.id]);
        assert!(attempt.is_err());
    }

    #[test]
    fn a_projection_that_diverged_anyway_fails_every_read() {
        let (store, _capture, object, _r1, _r2, _r3) = r1_r2_r3();
        // A faulty writer that disabled the guard.
        store.execute_sql_for_test("DROP TRIGGER knowledge_objects_equal_their_current_revision; UPDATE knowledge_objects SET title = 'drifted';");
        assert!(matches!(store.list_knowledge_objects(), Err(StoreError::Corrupt(reason)) if reason.contains("current revision")));
        assert!(matches!(store.object_lineage(&object.id), Err(StoreError::Corrupt(_))));
    }

    #[test]
    fn an_object_without_a_current_revision_fails_reads_instead_of_inventing_one() {
        let (store, _capture, object) = setup();
        store.execute_sql_for_test("DROP TRIGGER knowledge_objects_equal_their_current_revision; UPDATE knowledge_objects SET current_revision_id = NULL;");
        assert!(matches!(store.list_knowledge_objects(), Err(StoreError::Corrupt(_))));
        assert!(matches!(store.object_lineage(&object.id), Err(StoreError::Corrupt(_))));
        assert!(matches!(store.update_object(&object.id, body("x")), Err(StoreError::Corrupt(_))));
    }

    #[test]
    fn a_history_that_breaks_the_dag_shape_fails_the_read() {
        let (store, _capture, object, _r1, r2, _r3) = r1_r2_r3();
        // An edit with no parent (a faulty writer removed the edge).
        store.connection.lock().unwrap().execute("DELETE FROM revision_parents WHERE child_revision_id = ?1", [&r2.id]).unwrap();
        assert!(matches!(store.object_lineage(&object.id), Err(StoreError::Corrupt(reason)) if reason.contains("parents do not match")));
    }

    // --- atomicity ---------------------------------------------------------------------------------------

    #[test]
    fn a_failure_while_writing_leaves_the_lineage_exactly_as_it_was() {
        for poison in [
            "CREATE TRIGGER poison BEFORE INSERT ON revision_parents BEGIN SELECT RAISE(ABORT, 'boom'); END;",
            "CREATE TRIGGER poison BEFORE UPDATE ON knowledge_objects BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        ] {
            let (store, _capture, object, r1, r2, _r3) = r1_r2_r3();
            let before = store.object_lineage(&object.id).unwrap();
            let revisions = count(&store, "SELECT count(*) FROM thought_revisions");
            store.execute_sql_for_test(poison);

            assert!(matches!(store.update_object(&object.id, body("never")), Err(StoreError::Database(_))), "{poison}");
            assert!(matches!(store.merge_revisions(&object.id, &[r1.id.clone(), r2.id.clone()], content("idea", "t", "never"), true), Err(StoreError::Database(_))));
            assert!(matches!(store.create_revision_from(&object.id, &r1.id, body("never"), true), Err(StoreError::Database(_))));

            assert_eq!(count(&store, "SELECT count(*) FROM thought_revisions"), revisions, "no stray revision row");
            store.execute_sql_for_test("DROP TRIGGER poison");
            assert_eq!(store.object_lineage(&object.id).unwrap(), before, "revisions, parents and the pointer are all unchanged");
        }
    }

    #[test]
    fn an_object_cannot_have_more_than_the_maximum_number_of_revisions() {
        let (store, _capture, object) = setup();
        for n in 1..MAX_REVISIONS_PER_OBJECT {
            store.update_object(&object.id, body(&format!("v{n}"))).unwrap();
        }
        assert_eq!(store.object_lineage(&object.id).unwrap().revisions.len(), MAX_REVISIONS_PER_OBJECT);
        assert!(matches!(store.update_object(&object.id, body("one more")), Err(StoreError::Invalid(reason)) if reason.contains("at most")));
    }

    // --- provenance --------------------------------------------------------------------------------------

    #[test]
    fn edits_never_inherit_the_original_source_span_and_the_original_capture_stays_untouched() {
        let (store, capture, object, r1, r2, r3) = r1_r2_r3();
        let r4 = store.merge_revisions(&object.id, &[r2.id.clone(), r3.id.clone()], content("idea", "Merged", "Merged text."), false).unwrap();

        assert!(r1.provenance.is_some(), "the history keeps the original span");
        for later in [&r2, &r3, &r4] {
            assert_eq!(later.provenance, None, "{} does not claim to come from the capture", later.origin);
        }
        assert_eq!(store.get_capture(&capture.id).unwrap(), Some(capture.clone()), "the raw capture is untouched");
        assert!(store.connection.lock().unwrap().execute("UPDATE captures SET content = 'changed' WHERE id = ?1", [&capture.id]).is_err());
        // M01D: the object's own provenance (where it ORIGINALLY came from) still resolves to the original text.
        let listed = &store.list_knowledge_objects().unwrap()[0];
        let p = &listed.provenance;
        assert_eq!(p, r1.provenance.as_ref().unwrap());
        let original: String = capture.content.chars().skip(p.source_start as usize).take((p.source_end - p.source_start) as usize).collect();
        assert_eq!(original, TEXT.chars().take(46).collect::<String>());
        assert_ne!(listed.body, original, "the text was edited, the origin is not rewritten");
    }

    #[test]
    fn a_revision_from_a_new_capture_carries_that_captures_span_and_nothing_else_does() {
        let (store, capture, object) = setup();
        let r1 = store.object_lineage(&object.id).unwrap().revisions.remove(0);
        let later = "Update: Arthur must also connect related ideas into a graph.";
        let new_capture = store.create(CreateCaptureInput { source: "voice".into(), content: later.into(), project_id: None }).unwrap();

        let r2 = store
            .revise_from_capture(&object.id, None, SourceSpan { capture_id: new_capture.id.clone(), start: 8, end: 59 }, change(Some("Organize and connect ideas"), Some("Arthur should organize ideas and connect them into a graph."), None), true)
            .unwrap();

        assert_eq!((r2.origin.as_str(), r2.parent_revision_ids.clone()), ("distillation", vec![r1.id.clone()]));
        assert_eq!(r2.provenance, Some(Provenance { capture_id: new_capture.id.clone(), source_start: 8, source_end: 59 }), "points at the NEW capture");
        assert_eq!(current(&store, &object), r2.id);
        let lineage = store.object_lineage(&object.id).unwrap();
        assert_eq!(lineage.revisions[0].provenance.as_ref().unwrap().capture_id, capture.id, "the initial revision still points at the first capture");
        assert_eq!(store.get_capture(&new_capture.id).unwrap().unwrap().content, later);
        // A branch from an old revision, from yet another capture, with an explicit parent.
        let third = store.create(CreateCaptureInput { source: "text".into(), content: "Keep the original notes unchanged".into(), project_id: None }).unwrap();
        let r3 = store.revise_from_capture(&object.id, Some(&r1.id), SourceSpan { capture_id: third.id.clone(), start: 0, end: 33 }, body("Arthur should leave my notes unchanged."), false).unwrap();
        assert_eq!((r3.parent_revision_ids, current(&store, &object)), (vec![r1.id.clone()], r2.id.clone()));
    }

    #[test]
    fn a_revision_from_a_capture_needs_a_real_capture_and_a_valid_span() {
        let (store, capture, object) = setup();
        let before = count(&store, "SELECT count(*) FROM thought_revisions");
        let ghost = "00000000-0000-4000-8000-000000000000".to_string();
        let length = TEXT.chars().count() as i64;
        for span in [
            SourceSpan { capture_id: ghost, start: 0, end: 3 },
            SourceSpan { capture_id: capture.id.clone(), start: -1, end: 3 },
            SourceSpan { capture_id: capture.id.clone(), start: 5, end: 5 },
            SourceSpan { capture_id: capture.id.clone(), start: 9, end: 3 },
            SourceSpan { capture_id: capture.id.clone(), start: 0, end: length + 1 },
        ] {
            assert!(matches!(store.revise_from_capture(&object.id, None, span.clone(), body("x"), true), Err(StoreError::Invalid(_))), "{span:?}");
        }
        assert!(matches!(store.revise_from_capture(&object.id, None, SourceSpan { capture_id: capture.id.clone(), start: 0, end: 3 }, Changes::default(), true), Err(StoreError::Invalid(_))));
        assert_eq!(count(&store, "SELECT count(*) FROM thought_revisions"), before);
    }

    #[test]
    fn spans_count_code_points_so_bulgarian_text_and_emoji_resolve_exactly() {
        let store = CaptureStore::open_in_memory().unwrap();
        let first = store.create(CreateCaptureInput { source: "text".into(), content: "Идея 😀 за запис".into(), project_id: None }).unwrap();
        let object = store.record_distillation(&first.id, vec![NewKnowledgeObject { kind: "idea".into(), title: "Идея".into(), body: "Идея за запис".into(), source_start: 0, source_end: 4 }]).unwrap().remove(0);
        let next = store.create(CreateCaptureInput { source: "text".into(), content: "Допълнение 🎉 тук".into(), project_id: None }).unwrap();
        let length = next.content.chars().count() as i64;
        assert_eq!(length, 16, "the emoji is ONE code point (two UTF-16 units, four bytes)");
        // "🎉 тук" is code points 11..16.
        let revised = store.revise_from_capture(&object.id, None, SourceSpan { capture_id: next.id.clone(), start: 11, end: 16 }, body("Идея за запис с допълнение"), true).unwrap();
        assert_eq!(revised.provenance.as_ref().map(|p| (p.source_start, p.source_end)), Some((11, 16)));
        assert!(store.revise_from_capture(&object.id, None, SourceSpan { capture_id: next.id.clone(), start: 11, end: 17 }, body("Друго допълнение"), true).is_err(), "one past the end");
        assert!(store.revise_from_capture(&object.id, None, SourceSpan { capture_id: next.id.clone(), start: 0, end: length + 1 }, body("Друго"), true).is_err());
    }

    // --- the graph is separate -------------------------------------------------------------------------

    #[test]
    fn graph_relations_survive_edits_branches_and_merges_untouched() {
        let (store, _capture, object, r1, r2, r3) = r1_r2_r3();
        let other_capture = store.create(CreateCaptureInput { source: "text".into(), content: "A related thought".into(), project_id: None }).unwrap();
        let other = store.record_distillation(&other_capture.id, vec![NewKnowledgeObject { kind: "idea".into(), title: "Related".into(), body: "Related".into(), source_start: 0, source_end: 5 }]).unwrap().remove(0);
        let extends = store.create_relation(NewRelation { kind: "extends".into(), source_object_id: other.id.clone(), target_object_id: object.id.clone() }, "user").unwrap();
        let supersedes = store.create_relation(NewRelation { kind: "supersedes".into(), source_object_id: other.id.clone(), target_object_id: object.id.clone() }, "user").unwrap();
        let before = store.list_relations().unwrap();

        store.update_object(&object.id, body("An edit after the relations exist")).unwrap();
        store.merge_revisions(&object.id, &[r2.id.clone(), r3.id.clone()], content("idea", "M", "Merged"), true).unwrap();
        store.update_object(&other.id, change(Some("Related, renamed"), None, None)).unwrap();

        assert_eq!(store.list_relations().unwrap(), before, "no edge was deleted, rewritten or re-targeted");
        assert!(before.contains(&extends) && before.contains(&supersedes));
        // The graph's `supersedes` (object replaces object) is not a revision parent link, and vice versa.
        let relation_endpoints: Vec<&String> = before.iter().flat_map(|r| [&r.source_object_id, &r.target_object_id]).collect();
        assert!(relation_endpoints.iter().all(|id| **id == object.id || **id == other.id), "relations name objects, never revisions");
        assert_eq!(count(&store, "SELECT count(*) FROM thought_revisions WHERE object_id NOT IN (SELECT id FROM knowledge_objects)"), 0);
        let revisions: Vec<String> = store.object_lineage(&object.id).unwrap().revisions.into_iter().map(|r| r.id).collect();
        assert!(!revisions.contains(&other.id), "another object never appears in this object's history");
        assert_eq!(store.object_lineage(&other.id).unwrap().revisions.len(), 2, "each object has its own history");
        let _ = r1;
    }

    #[test]
    fn the_lineage_and_graph_stores_do_not_reference_each_other() {
        let code = |source: &str| -> String { source.split("#[cfg(test)]").next().unwrap().lines().filter(|line| !line.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n") };
        let lineage = code(include_str!("lineage_store.rs"));
        assert!(!lineage.contains("relations") && !lineage.contains("relation_store"), "lineage code never touches graph relations");
        let graph = code(include_str!("relation_store.rs"));
        assert!(!graph.contains("thought_revisions") && !graph.contains("revision_parents") && !graph.contains("lineage_store"), "graph code never touches revisions");
    }

    // --- reads and the diff ---------------------------------------------------------------------------

    #[test]
    fn one_hop_reads_and_unknown_ids() {
        let (store, _capture, object, r1, r2, r3) = r1_r2_r3();
        let r4 = store.merge_revisions(&object.id, &[r2.id.clone(), r3.id.clone()], content("idea", "M", "Merged"), true).unwrap();
        assert_eq!(store.revision_parents(&r4.id).unwrap().iter().map(|r| r.id.clone()).collect::<Vec<_>>(), [r2.id.clone(), r3.id.clone()]);
        assert_eq!(store.revision_children(&r2.id).unwrap().iter().map(|r| r.id.clone()).collect::<Vec<_>>(), [r4.id.clone()]);
        assert!(store.revision_children(&r4.id).unwrap().is_empty());
        assert_eq!(store.list_revisions(&object.id).unwrap().len(), 4);
        let ghost = "00000000-0000-4000-8000-000000000000";
        assert!(matches!(store.get_revision(ghost), Err(StoreError::MissingRevision(_))));
        assert!(matches!(store.revision_parents(ghost), Err(StoreError::MissingRevision(_))));
        assert!(matches!(store.revision_children(ghost), Err(StoreError::MissingRevision(_))));
        assert!(matches!(store.object_lineage(ghost), Err(StoreError::NotFound(_))));
        let _ = r1;
    }

    #[test]
    fn the_diff_between_revisions_is_deterministic_and_limited_to_one_object() {
        let (store, _capture, object, r1, r2, _r3) = r1_r2_r3();

        let diff = store.diff_revisions(&r1.id, &r2.id).unwrap();

        assert_eq!(diff, store.diff_revisions(&r1.id, &r2.id).unwrap(), "repeatable");
        assert!(!diff.kind.changed && !diff.title.changed && diff.body.changed);
        let inserted: String = diff.body.segments.iter().filter(|s| s.op == crate::lineage::diff::Op::Insert).map(|s| s.text.as_str()).collect();
        assert_eq!(inserted, " and connect related ideas");
        assert!(!store.diff_revisions(&r1.id, &r1.id).unwrap().body.changed);
        let other_capture = store.create(CreateCaptureInput { source: "text".into(), content: "Another".into(), project_id: None }).unwrap();
        let other = store.record_distillation(&other_capture.id, vec![NewKnowledgeObject { kind: "idea".into(), title: "O".into(), body: "O".into(), source_start: 0, source_end: 3 }]).unwrap().remove(0);
        let foreign = store.object_lineage(&other.id).unwrap().revisions.remove(0);
        assert!(matches!(store.diff_revisions(&r1.id, &foreign.id), Err(StoreError::Invalid(_))));
        assert!(matches!(store.diff_revisions(&r1.id, "00000000-0000-4000-8000-000000000000"), Err(StoreError::MissingRevision(_))));
        let _ = object;
    }

    // --- persistence and shape ---------------------------------------------------------------------------

    #[test]
    fn lineage_survives_closing_and_reopening_the_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        let (before, object_id) = {
            let store = CaptureStore::open(&path).unwrap();
            let capture = store.create(CreateCaptureInput { source: "text".into(), content: TEXT.into(), project_id: None }).unwrap();
            let object = store.record_distillation(&capture.id, vec![NewKnowledgeObject { kind: "idea".into(), title: "T".into(), body: TEXT.into(), source_start: 0, source_end: 46 }]).unwrap().remove(0);
            let r1 = store.object_lineage(&object.id).unwrap().revisions.remove(0);
            let r2 = store.update_object(&object.id, body("Edited")).unwrap();
            let r3 = store.create_revision_from(&object.id, &r1.id, body("Branched"), false).unwrap();
            store.merge_revisions(&object.id, &[r2.id, r3.id], content("idea", "T", "Merged"), true).unwrap();
            (store.object_lineage(&object.id).unwrap(), object.id)
        };
        let reopened = CaptureStore::open(&path).unwrap();
        assert_eq!(reopened.object_lineage(&object_id).unwrap(), before);
        assert_eq!(before.revisions.len(), 4);
        assert_eq!(before.revisions[3].parent_revision_ids.len(), 2);
    }

    #[test]
    fn revisions_serialize_to_the_contract_shape() {
        let (store, _capture, object, r1, r2, _r3) = r1_r2_r3();
        let keys = |value: serde_json::Value| -> Vec<String> {
            let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
            keys.sort();
            keys
        };
        assert_eq!(keys(serde_json::to_value(&r1).unwrap()), ["body", "createdAt", "id", "kind", "objectId", "origin", "parentRevisionIds", "provenance", "title"]);
        assert_eq!(keys(serde_json::to_value(&r2).unwrap()), ["body", "createdAt", "id", "kind", "objectId", "origin", "parentRevisionIds", "title"], "no provenance key at all when there is none");
        let lineage = serde_json::to_value(store.object_lineage(&object.id).unwrap()).unwrap();
        assert_eq!(keys(lineage), ["currentRevisionId", "objectId", "revisions"]);
        assert!(serde_json::from_str::<Changes>(r#"{"title":"x","id":"evil"}"#).is_err(), "unknown fields are refused");
    }
}
