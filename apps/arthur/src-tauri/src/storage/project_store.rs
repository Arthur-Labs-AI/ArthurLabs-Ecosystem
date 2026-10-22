//! Projects (Knowledge Spaces): the domain boundary that owns Captures and KnowledgeObjects.
//!
//! A project is a real domain object, not a UI filter. Ownership lives in `captures.project_id` and
//! `knowledge_objects.project_id` and nowhere else: a thought revision belongs to the project of its object, a
//! relation derives the projects of its two endpoints, and provenance (`object_sources`) never depends on membership.
//!
//! MOVE SEMANTICS (deliberate):
//! * Moving a KnowledgeObject changes one column. It does not rewrite the Capture, the provenance or the lineage, makes
//!   no revision and does not clone anything, so the object keeps its identity.
//! * Moving a Capture does NOT move its already-distilled objects. An object may have been moved on purpose, one capture can
//!   yield objects for several projects, and provenance and membership are separate. Only objects distilled AFTER the
//!   move inherit the capture's new project.
//!
//! There is no hard delete: projects are archived. An archived project keeps its rows, accepts no new ones, and is never
//! the active project.

use std::fmt;

use rusqlite::{params, Connection, OptionalExtension};
use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

use super::capture_store::{now_rfc3339, Capture, CaptureStore, StoreError};
use super::knowledge_store::{get_object_in, KnowledgeObject};
use super::migrations::INBOX_PROJECT_ID;
use super::relation_store::{read_relations, Relation, RELATION_COLUMNS, RELATION_JOINS};

/// Mirrors `MAX_PROJECT_NAME_CHARS` in `packages/contracts/projects.ts`.
pub const MAX_PROJECT_NAME_CHARS: usize = 80;

/// Mirrors `Project` in `packages/contracts/projects.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    /// The system Inbox: always present, never archived, deleted or renamed.
    pub is_inbox: bool,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub capture_count: i64,
    pub object_count: i64,
}

/// Mirrors `ExternalObject`: the far end of a cross-project relation, enough to mark it and name its project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalObject {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub project_id: String,
    pub project_name: String,
}

/// Mirrors `ProjectGraph`. `objects` are the project's own; `relations` touch at least one of them; `external_objects`
/// are only the other endpoints of cross-project relations, never the rest of the other projects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGraph {
    pub project_id: String,
    pub objects: Vec<KnowledgeObject>,
    pub relations: Vec<Relation>,
    pub external_objects: Vec<ExternalObject>,
}

/// Why a project operation failed. `code()` mirrors `PROJECT_ERROR_CODES` in `packages/contracts/projects.ts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectError {
    ProjectNotFound,
    CaptureNotFound,
    ObjectNotFound,
    InvalidName(String),
    NameTaken,
    ProjectArchived,
    InboxProtected,
    Storage(String),
}

impl ProjectError {
    pub fn code(&self) -> &'static str {
        match self {
            ProjectError::ProjectNotFound => "project_not_found",
            ProjectError::CaptureNotFound => "capture_not_found",
            ProjectError::ObjectNotFound => "object_not_found",
            ProjectError::InvalidName(_) => "invalid_project",
            ProjectError::NameTaken => "project_name_taken",
            ProjectError::ProjectArchived => "project_archived",
            ProjectError::InboxProtected => "inbox_protected",
            ProjectError::Storage(_) => "storage_failed",
        }
    }

    pub fn message(&self) -> String {
        match self {
            ProjectError::ProjectNotFound => "That project no longer exists.".into(),
            ProjectError::CaptureNotFound => "That capture no longer exists.".into(),
            ProjectError::ObjectNotFound => "That idea no longer exists.".into(),
            ProjectError::InvalidName(reason) => format!("That project name is not valid: {reason}."),
            ProjectError::NameTaken => "Another project already has that name.".into(),
            ProjectError::ProjectArchived => "That project is archived. Restore it first.".into(),
            ProjectError::InboxProtected => "The Inbox cannot be renamed or archived.".into(),
            ProjectError::Storage(reason) => format!("The project could not be saved: {reason}"),
        }
    }
}

impl fmt::Display for ProjectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

impl std::error::Error for ProjectError {}

/// Serialized as `{ code, message }`, matching `ProjectErrorPayload`.
impl Serialize for ProjectError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("ProjectError", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.message())?;
        state.end()
    }
}

impl From<StoreError> for ProjectError {
    fn from(error: StoreError) -> Self {
        ProjectError::Storage(error.to_string())
    }
}

impl From<rusqlite::Error> for ProjectError {
    fn from(error: rusqlite::Error) -> Self {
        ProjectError::Storage(error.to_string())
    }
}

type Res<T> = std::result::Result<T, ProjectError>;

const PROJECT_SELECT: &str = "SELECT p.id, p.name, p.created_at, p.updated_at, p.archived_at, \
     (SELECT count(*) FROM captures c WHERE c.project_id = p.id), \
     (SELECT count(*) FROM knowledge_objects o WHERE o.project_id = p.id) \
     FROM projects p";

fn project_from_row(row: &rusqlite::Row) -> rusqlite::Result<Project> {
    let id: String = row.get(0)?;
    Ok(Project {
        is_inbox: id == INBOX_PROJECT_ID,
        id,
        name: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        archived_at: row.get(4)?,
        capture_count: row.get(5)?,
        object_count: row.get(6)?,
    })
}

fn project_in(connection: &Connection, id: &str) -> Res<Project> {
    connection
        .query_row(&format!("{PROJECT_SELECT} WHERE p.id = ?1"), [id], project_from_row)
        .optional()?
        .ok_or(ProjectError::ProjectNotFound)
}

/// A project that exists and accepts new rows.
fn open_project_in(connection: &Connection, id: &str) -> Res<Project> {
    let project = project_in(connection, id)?;
    if project.archived_at.is_some() {
        return Err(ProjectError::ProjectArchived);
    }
    Ok(project)
}

fn clean_name(name: &str) -> Res<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ProjectError::InvalidName("it is empty".into()));
    }
    if name.chars().count() > MAX_PROJECT_NAME_CHARS {
        return Err(ProjectError::InvalidName(format!("it is longer than {MAX_PROJECT_NAME_CHARS} characters")));
    }
    if name.chars().any(char::is_control) {
        return Err(ProjectError::InvalidName("it contains control characters".into()));
    }
    Ok(name.to_string())
}

/// Names are unique ignoring case (and across archived projects, so restoring one can never collide).
fn ensure_name_free(connection: &Connection, name: &str, except_id: Option<&str>) -> Res<()> {
    let wanted = name.to_lowercase();
    let mut statement = connection.prepare("SELECT id, name FROM projects")?;
    let taken = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .into_iter()
        .any(|(id, existing)| Some(id.as_str()) != except_id && existing.to_lowercase() == wanted);
    if taken {
        Err(ProjectError::NameTaken)
    } else {
        Ok(())
    }
}

impl CaptureStore {
    /// The Inbox first, then the others by name. Counts come from the same single query (indexed by `project_id`).
    pub fn list_projects(&self, include_archived: bool) -> Res<Vec<Project>> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let mut statement = connection.prepare(&format!(
            "{PROJECT_SELECT} WHERE (?1 OR p.archived_at IS NULL) ORDER BY (p.id = ?2) DESC, p.name COLLATE NOCASE ASC, p.seq ASC"
        ))?;
        let rows = statement.query_map(params![include_archived, INBOX_PROJECT_ID], project_from_row)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn get_project(&self, id: &str) -> Res<Project> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        project_in(&connection, id)
    }

    pub fn create_project(&self, name: &str) -> Res<Project> {
        let name = clean_name(name)?;
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction()?;
        let result = create_project_in(&transaction, &name)?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn rename_project(&self, id: &str, name: &str) -> Res<Project> {
        let name = clean_name(name)?;
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction()?;
        let result = rename_project_in(&transaction, id, &name)?;
        transaction.commit()?;
        Ok(result)
    }

    /// Archives a project. Idempotent. If it was the active project the active project becomes the Inbox.
    pub fn archive_project(&self, id: &str) -> Res<Project> {
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction()?;
        let result = archive_project_in(&transaction, id)?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn restore_project(&self, id: &str) -> Res<Project> {
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction()?;
        let result = restore_project_in(&transaction, id)?;
        transaction.commit()?;
        Ok(result)
    }

    /// Moves a capture. Its content, source and time are untouched, and so are the objects already distilled from it.
    pub fn move_capture(&self, capture_id: &str, project_id: &str) -> Res<Capture> {
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction()?;
        let result = move_capture_in(&transaction, capture_id, project_id)?;
        transaction.commit()?;
        Ok(result)
    }

    /// Moves a knowledge object. One column changes: no revision, no provenance rewrite, no copy, same id.
    pub fn move_knowledge_object(&self, object_id: &str, project_id: &str) -> Res<KnowledgeObject> {
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction()?;
        let result = move_knowledge_object_in(&transaction, object_id, project_id)?;
        transaction.commit()?;
        Ok(result)
    }

    /// The project of an object, or `None` when the object does not exist.
    pub fn project_of_object(&self, object_id: &str) -> Res<Option<String>> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        Ok(connection.query_row("SELECT project_id FROM knowledge_objects WHERE id = ?1", [object_id], |row| row.get(0)).optional()?)
    }

    /// The active project. Falls back to the Inbox when none is stored or the stored one is archived or missing.
    pub fn active_project_id(&self) -> Res<String> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let stored: Option<String> = connection
            .query_row(
                "SELECT a.project_id FROM active_project a JOIN projects p ON p.id = a.project_id WHERE p.archived_at IS NULL",
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(stored.unwrap_or_else(|| INBOX_PROJECT_ID.to_string()))
    }

    /// Persists the active project (durably: the store syncs on commit). Rejects a missing or archived project.
    pub fn set_active_project(&self, project_id: &str) -> Res<String> {
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.transaction()?;
        let result = set_active_project_in(&transaction, project_id)?;
        transaction.commit()?;
        Ok(result)
    }

    /// The graph projection of one project: its objects, every relation touching them, and the far ends of the
    /// cross-project ones (marked with their project). Other projects' remaining objects are never loaded.
    pub fn project_graph(&self, project_id: &str) -> Res<ProjectGraph> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        project_in(&connection, project_id)?;
        drop(connection);

        let objects = self.list_knowledge_objects_in(Some(project_id))?;
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let relations = read_relations(
            &connection,
            &format!(
                // Driven from the project's own objects through the by-source / by-target indexes, so the cost follows the
                // size of the project and not of the whole graph.
                "SELECT {RELATION_COLUMNS} FROM {RELATION_JOINS} \
                 WHERE r.id IN (SELECT r1.id FROM knowledge_objects o JOIN relations r1 ON r1.source_object_id = o.id WHERE o.project_id = ?1 \
                                UNION SELECT r2.id FROM knowledge_objects o JOIN relations r2 ON r2.target_object_id = o.id WHERE o.project_id = ?1) \
                 ORDER BY r.seq ASC"
            ),
            [project_id],
        )?;
        let mut statement = connection.prepare(
            "SELECT DISTINCT x.id, x.kind, x.title, x.project_id, p.name \
             FROM relations r \
             JOIN knowledge_objects s ON s.id = r.source_object_id \
             JOIN knowledge_objects t ON t.id = r.target_object_id \
             JOIN knowledge_objects x ON x.id = CASE WHEN s.project_id = ?1 THEN t.id ELSE s.id END \
             JOIN projects p ON p.id = x.project_id \
             WHERE r.id IN (SELECT r1.id FROM knowledge_objects o JOIN relations r1 ON r1.source_object_id = o.id WHERE o.project_id = ?1 \
                            UNION SELECT r2.id FROM knowledge_objects o JOIN relations r2 ON r2.target_object_id = o.id WHERE o.project_id = ?1) \
               AND (s.project_id = ?1) <> (t.project_id = ?1) \
             ORDER BY x.seq ASC",
        )?;
        let external_objects = statement
            .query_map([project_id], |row| {
                Ok(ExternalObject { id: row.get(0)?, kind: row.get(1)?, title: row.get(2)?, project_id: row.get(3)?, project_name: row.get(4)? })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(ProjectGraph { project_id: project_id.to_string(), objects, relations, external_objects })
    }
}

/// Shared domain body; the caller owns transaction and commit.
pub(super) fn create_project_in(connection: &Connection, name: &str) -> Res<Project> {
    let name = clean_name(name)?;
    ensure_name_free(connection, &name, None)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_rfc3339()?;
    connection.execute(
        "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        params![id, name, now],
    )?;
    let project = project_in(connection, &id)?;
    Ok(project)
}

/// Shared domain body; the caller owns transaction and commit.
pub(super) fn rename_project_in(connection: &Connection, id: &str, name: &str) -> Res<Project> {
    let name = clean_name(name)?;
    let current = project_in(connection, id)?;
    if current.is_inbox {
        return Err(ProjectError::InboxProtected);
    }
    ensure_name_free(connection, &name, Some(id))?;
    if current.name != name {
        connection.execute(
            "UPDATE projects SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now_rfc3339()?],
        )?;
    }
    let project = project_in(connection, id)?;
    Ok(project)
}

/// Shared domain body; the caller owns transaction and commit.
pub(super) fn archive_project_in(connection: &Connection, id: &str) -> Res<Project> {
    let current = project_in(connection, id)?;
    if current.is_inbox {
        return Err(ProjectError::InboxProtected);
    }
    if current.archived_at.is_none() {
        let now = now_rfc3339()?;
        connection.execute(
            "UPDATE projects SET archived_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
    }
    connection.execute("DELETE FROM active_project WHERE project_id = ?1", [id])?;
    let project = project_in(connection, id)?;
    Ok(project)
}

/// Shared domain body; the caller owns transaction and commit.
pub(super) fn restore_project_in(connection: &Connection, id: &str) -> Res<Project> {
    let current = project_in(connection, id)?;
    if current.archived_at.is_some() {
        connection.execute(
            "UPDATE projects SET archived_at = NULL, updated_at = ?2 WHERE id = ?1",
            params![id, now_rfc3339()?],
        )?;
    }
    let project = project_in(connection, id)?;
    Ok(project)
}

/// Shared domain body; the caller owns transaction and commit.
pub(super) fn move_capture_in(
    connection: &Connection,
    capture_id: &str,
    project_id: &str,
) -> Res<Capture> {
    open_project_in(connection, project_id)?;
    let moved = connection.execute(
        "UPDATE captures SET project_id = ?2 WHERE id = ?1",
        params![capture_id, project_id],
    )?;
    if moved == 0 {
        return Err(ProjectError::CaptureNotFound);
    }
    let capture = connection.query_row(
        "SELECT id, source, content, created_at, project_id FROM captures WHERE id = ?1",
        [capture_id],
        |row| {
            Ok(Capture {
                id: row.get(0)?,
                source: row.get(1)?,
                content: row.get(2)?,
                created_at: row.get(3)?,
                project_id: row.get(4)?,
            })
        },
    )?;
    Ok(capture)
}

/// Shared domain body; the caller owns transaction and commit.
pub(super) fn move_knowledge_object_in(
    connection: &Connection,
    object_id: &str,
    project_id: &str,
) -> Res<KnowledgeObject> {
    open_project_in(connection, project_id)?;
    let moved = connection.execute(
        "UPDATE knowledge_objects SET project_id = ?2 WHERE id = ?1",
        params![object_id, project_id],
    )?;
    if moved == 0 {
        return Err(ProjectError::ObjectNotFound);
    }
    let object = get_object_in(connection, object_id)?.ok_or(ProjectError::ObjectNotFound)?;
    Ok(object)
}

/// Shared domain body; the caller owns transaction and commit.
pub(super) fn set_active_project_in(connection: &Connection, project_id: &str) -> Res<String> {
    open_project_in(connection, project_id)?;
    connection.execute(
        "INSERT INTO active_project (id, project_id) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id",
        [project_id],
    )?;
    Ok(project_id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::capture_store::CreateCaptureInput;
    use crate::storage::knowledge_store::NewKnowledgeObject;
    use crate::storage::lineage_store::Changes;
    use crate::storage::relation_store::NewRelation;

    fn store() -> CaptureStore {
        CaptureStore::open_in_memory().unwrap()
    }

    fn capture_in(store: &CaptureStore, project: Option<&str>, text: &str) -> Capture {
        store.create(CreateCaptureInput { source: "text".into(), content: text.into(), project_id: project.map(str::to_string) }).unwrap()
    }

    fn distill(store: &CaptureStore, capture: &Capture, titles: &[&str]) -> Vec<KnowledgeObject> {
        let length = capture.content.chars().count() as i64;
        let objects = titles.iter().map(|t| NewKnowledgeObject { kind: "idea".into(), title: (*t).into(), body: "body".into(), source_start: 0, source_end: length }).collect();
        store.record_distillation(&capture.id, objects).unwrap()
    }

    #[test]
    fn a_new_store_has_exactly_the_inbox_and_it_is_active() {
        let store = store();
        let projects = store.list_projects(true).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!((projects[0].id.as_str(), projects[0].name.as_str(), projects[0].is_inbox, projects[0].archived_at.clone()), (INBOX_PROJECT_ID, "Inbox", true, None));
        assert_eq!(store.active_project_id().unwrap(), INBOX_PROJECT_ID);
    }

    #[test]
    fn projects_can_be_created_listed_renamed_and_read() {
        let store = store();
        let nexus = store.create_project("  Nexus  ").unwrap();
        assert_eq!(nexus.name, "Nexus", "the name is trimmed");
        assert!(!nexus.is_inbox && nexus.archived_at.is_none());
        assert_eq!((nexus.capture_count, nexus.object_count), (0, 0));
        store.create_project("Arthur").unwrap();

        let names: Vec<String> = store.list_projects(false).unwrap().into_iter().map(|p| p.name).collect();
        assert_eq!(names, ["Inbox", "Arthur", "Nexus"], "the Inbox first, then by name");

        let renamed = store.rename_project(&nexus.id, "Nexus Core").unwrap();
        assert_eq!(renamed.name, "Nexus Core");
        assert_eq!(store.get_project(&nexus.id).unwrap().name, "Nexus Core");
        assert_eq!(renamed.id, nexus.id, "identity is stable");
        assert_eq!(store.get_project("missing"), Err(ProjectError::ProjectNotFound));
    }

    #[test]
    fn names_are_validated_and_unique_ignoring_case() {
        let store = store();
        store.create_project("Nexus").unwrap();
        for bad in ["", "   ", "\u{0007}bell", &"x".repeat(MAX_PROJECT_NAME_CHARS + 1)] {
            assert!(matches!(store.create_project(bad), Err(ProjectError::InvalidName(_))), "{bad:?}");
        }
        assert_eq!(store.create_project("nexus"), Err(ProjectError::NameTaken));
        assert_eq!(store.create_project("INBOX"), Err(ProjectError::NameTaken), "nobody can shadow the Inbox");
        assert!(store.create_project(&"x".repeat(MAX_PROJECT_NAME_CHARS)).is_ok());
        let school = store.create_project("Училище").unwrap();
        assert_eq!(store.create_project("училище"), Err(ProjectError::NameTaken), "Cyrillic case is folded too");
        assert_eq!(store.rename_project(&school.id, "NEXUS"), Err(ProjectError::NameTaken));
        assert!(store.rename_project(&school.id, "училище").is_ok(), "renaming a project to its own name in another case is fine");
    }

    #[test]
    fn the_inbox_is_protected() {
        let store = store();
        assert_eq!(store.archive_project(INBOX_PROJECT_ID), Err(ProjectError::InboxProtected));
        assert_eq!(store.rename_project(INBOX_PROJECT_ID, "Elsewhere"), Err(ProjectError::InboxProtected));
        let inbox = store.get_project(INBOX_PROJECT_ID).unwrap();
        assert_eq!((inbox.name.as_str(), inbox.archived_at), ("Inbox", None));
        assert_eq!(store.restore_project(INBOX_PROJECT_ID).unwrap().id, INBOX_PROJECT_ID, "restoring an open project is a no-op");
        assert_eq!(store.list_projects(false).unwrap().len(), 1);
    }

    #[test]
    fn archiving_hides_a_project_keeps_its_rows_and_restoring_brings_it_back() {
        let store = store();
        let nexus = store.create_project("Nexus").unwrap();
        let capture = capture_in(&store, Some(&nexus.id), "an idea about nexus");
        let objects = distill(&store, &capture, &["Nexus idea"]);

        let archived = store.archive_project(&nexus.id).unwrap();
        assert!(archived.archived_at.is_some());
        assert_eq!(store.archive_project(&nexus.id).unwrap().archived_at, archived.archived_at, "idempotent");
        assert!(store.list_projects(false).unwrap().iter().all(|p| p.id != nexus.id));
        assert!(store.list_projects(true).unwrap().iter().any(|p| p.id == nexus.id));
        assert_eq!((archived.capture_count, archived.object_count), (1, 1), "nothing is deleted");
        assert_eq!(store.list_knowledge_objects_in(Some(&nexus.id)).unwrap(), objects, "its knowledge is still readable");

        // It accepts nothing new.
        assert!(matches!(store.create(CreateCaptureInput { source: "text".into(), content: "x".into(), project_id: Some(nexus.id.clone()) }), Err(StoreError::Invalid(_))));
        let other = capture_in(&store, None, "inbox thought");
        assert_eq!(store.move_capture(&other.id, &nexus.id), Err(ProjectError::ProjectArchived));
        assert_eq!(store.set_active_project(&nexus.id), Err(ProjectError::ProjectArchived));

        let restored = store.restore_project(&nexus.id).unwrap();
        assert!(restored.archived_at.is_none());
        assert_eq!(store.move_capture(&other.id, &nexus.id).unwrap().project_id, nexus.id);
    }

    #[test]
    fn the_active_project_persists_and_falls_back_to_the_inbox() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        let nexus = {
            let store = CaptureStore::open(&path).unwrap();
            let nexus = store.create_project("Nexus").unwrap();
            assert_eq!(store.set_active_project(&nexus.id).unwrap(), nexus.id);
            nexus
        };
        let reopened = CaptureStore::open(&path).unwrap();
        assert_eq!(reopened.active_project_id().unwrap(), nexus.id, "it survives a relaunch");

        assert_eq!(reopened.set_active_project("missing"), Err(ProjectError::ProjectNotFound));
        assert_eq!(reopened.active_project_id().unwrap(), nexus.id, "a rejected switch changes nothing");

        reopened.archive_project(&nexus.id).unwrap();
        assert_eq!(reopened.active_project_id().unwrap(), INBOX_PROJECT_ID, "archived: back to the Inbox");
        // Even if a faulty writer left an archived project selected, the read still falls back.
        reopened.execute_sql_for_test(&format!("UPDATE projects SET archived_at = NULL WHERE id = '{}'; INSERT INTO active_project (id, project_id) VALUES (1, '{}'); UPDATE projects SET archived_at = '2026-10-05T00:00:00Z' WHERE id = '{}'", nexus.id, nexus.id, nexus.id));
        assert_eq!(reopened.active_project_id().unwrap(), INBOX_PROJECT_ID);
    }

    #[test]
    fn a_capture_belongs_to_the_project_it_was_made_in_and_distillation_inherits_it() {
        let store = store();
        let nexus = store.create_project("Nexus").unwrap();
        let inbox_capture = capture_in(&store, None, "no project given");
        let nexus_capture = capture_in(&store, Some(&nexus.id), "made while Nexus was active");
        assert_eq!(inbox_capture.project_id, INBOX_PROJECT_ID);
        assert_eq!(nexus_capture.project_id, nexus.id);
        assert_eq!(store.get_capture(&nexus_capture.id).unwrap().unwrap().project_id, nexus.id);

        let objects = distill(&store, &nexus_capture, &["First", "Second"]);
        assert!(objects.iter().all(|o| o.project_id == nexus.id), "the objects are born in the capture's project");
        assert!(store.list_knowledge_objects().unwrap().iter().filter(|o| o.project_id == nexus.id).count() == 2);
        assert_eq!(store.create(CreateCaptureInput { source: "text".into(), content: "x".into(), project_id: Some("missing".into()) }).unwrap_err().to_string(), "invalid capture: project does not exist");
    }

    #[test]
    fn lists_are_scoped_by_project_and_unscoped_lists_still_return_everything() {
        let store = store();
        let nexus = store.create_project("Nexus").unwrap();
        let a = capture_in(&store, None, "inbox capture");
        let b = capture_in(&store, Some(&nexus.id), "nexus capture");
        distill(&store, &a, &["Inbox idea"]);
        let nexus_objects = distill(&store, &b, &["Nexus idea"]);

        assert_eq!(store.list_in(Some(&nexus.id)).unwrap(), vec![b.clone()]);
        assert_eq!(store.list_in(Some(INBOX_PROJECT_ID)).unwrap(), vec![a.clone()]);
        assert_eq!(store.list().unwrap().len(), 2);
        assert_eq!(store.list_knowledge_objects_in(Some(&nexus.id)).unwrap(), nexus_objects);
        assert_eq!(store.list_knowledge_objects().unwrap().len(), 2);
        assert_eq!(store.list_organization_states_in(Some(&nexus.id)).unwrap().iter().map(|s| s.capture_id.clone()).collect::<Vec<_>>(), vec![b.id.clone()]);
        assert_eq!(store.knowledge_summaries_in(None, Some(&nexus.id)).unwrap().iter().map(|s| s.object_id.clone()).collect::<Vec<_>>(), vec![nexus_objects[0].id.clone()]);
        let both: Vec<String> = store.list_knowledge_objects().unwrap().into_iter().map(|o| o.id).collect();
        assert_eq!(store.knowledge_summaries_in(Some(&both), Some(&nexus.id)).unwrap().len(), 1, "ids and project combine");
        assert_eq!(store.knowledge_summaries(Some(&both)).unwrap().len(), 2);
        let counts: Vec<(String, i64, i64)> = store.list_projects(false).unwrap().into_iter().map(|p| (p.name, p.capture_count, p.object_count)).collect();
        assert_eq!(counts, [("Inbox".to_string(), 1, 1), ("Nexus".to_string(), 1, 1)]);
    }

    #[test]
    fn moving_an_object_changes_only_its_project() {
        let store = store();
        let (arthur, nexus) = (store.create_project("Arthur").unwrap(), store.create_project("Nexus").unwrap());
        let capture = capture_in(&store, None, "Improve capture. Email Ignatov.");
        let objects = distill(&store, &capture, &["Idea A", "Task B"]);
        // Give one object a real history first.
        store.update_object(&objects[0].id, Changes { title: Some("Idea A, sharper".into()), ..Changes::default() }).unwrap();
        let (revisions_before, lineage_before) = (store.list_revisions(&objects[0].id).unwrap(), store.object_lineage(&objects[0].id).unwrap());
        let before = store.get_capture(&capture.id).unwrap().unwrap();
        let provenance_before = store.list_knowledge_objects().unwrap().into_iter().find(|o| o.id == objects[0].id).unwrap().provenance;

        let moved = store.move_knowledge_object(&objects[0].id, &arthur.id).unwrap();
        let moved_too = store.move_knowledge_object(&objects[1].id, &nexus.id).unwrap();

        assert_eq!((moved.id.as_str(), moved.project_id.as_str()), (objects[0].id.as_str(), arthur.id.as_str()), "same identity, new project");
        assert_eq!(moved_too.project_id, nexus.id);
        assert_eq!(moved.title, "Idea A, sharper", "content is untouched");
        assert_eq!(moved.provenance, provenance_before, "provenance is untouched");
        assert_eq!(store.list_revisions(&objects[0].id).unwrap(), revisions_before, "no revision was made");
        assert_eq!(store.object_lineage(&objects[0].id).unwrap(), lineage_before, "the lineage is unchanged");
        let after = store.get_capture(&capture.id).unwrap().unwrap();
        assert_eq!((after.content.as_str(), after.project_id.as_str()), (before.content.as_str(), INBOX_PROJECT_ID), "the Capture is not rewritten or moved");
        assert_eq!(store.list_knowledge_objects().unwrap().len(), 2, "nothing was cloned");
        assert_eq!(store.move_knowledge_object("missing", &arthur.id), Err(ProjectError::ObjectNotFound));
        assert_eq!(store.move_knowledge_object(&objects[0].id, "missing"), Err(ProjectError::ProjectNotFound));
        // Provenance still resolves to the original capture text.
        assert_eq!(moved.provenance.capture_id, capture.id);
    }

    #[test]
    fn moving_a_capture_does_not_move_its_objects_and_later_objects_follow_the_capture() {
        let store = store();
        let nexus = store.create_project("Nexus").unwrap();
        let capture = capture_in(&store, None, "something to organize later");
        let objects = {
            let other = capture_in(&store, None, "an already organized thought");
            distill(&store, &other, &["Already"])
        };
        let moved = store.move_capture(&capture.id, &nexus.id).unwrap();
        assert_eq!((moved.id.as_str(), moved.content.as_str(), moved.created_at.as_str(), moved.project_id.as_str()), (capture.id.as_str(), capture.content.as_str(), capture.created_at.as_str(), nexus.id.as_str()));
        assert_eq!(store.move_capture("missing", &nexus.id), Err(ProjectError::CaptureNotFound));
        assert_eq!(store.move_capture(&capture.id, "missing"), Err(ProjectError::ProjectNotFound));

        // Objects distilled AFTER the move inherit the capture's NEW project...
        let later = distill(&store, &moved, &["Later"]);
        assert_eq!(later[0].project_id, nexus.id);
        // ...and moving a capture AFTER distillation leaves its objects exactly where they are.
        let other_capture = store.list().unwrap().into_iter().find(|c| c.content.starts_with("an already")).unwrap();
        store.move_capture(&other_capture.id, &nexus.id).unwrap();
        assert_eq!(store.list_knowledge_objects().unwrap().into_iter().find(|o| o.id == objects[0].id).unwrap().project_id, INBOX_PROJECT_ID);
    }

    #[test]
    fn one_capture_can_yield_objects_in_several_projects_and_the_capture_text_stays_whole() {
        let store = store();
        let (arthur, nexus, school) = (store.create_project("Arthur").unwrap(), store.create_project("Nexus").unwrap(), store.create_project("School").unwrap());
        let capture = capture_in(&store, None, "idea. task. decision.");
        let objects = distill(&store, &capture, &["Idea A", "Task B", "Decision C"]);
        for (object, project) in objects.iter().zip([&arthur, &nexus, &school]) {
            store.move_knowledge_object(&object.id, &project.id).unwrap();
        }
        let by_project: Vec<(String, usize)> = [&arthur, &nexus, &school].iter().map(|p| (p.name.clone(), store.list_knowledge_objects_in(Some(&p.id)).unwrap().len())).collect();
        assert_eq!(by_project, [("Arthur".to_string(), 1), ("Nexus".to_string(), 1), ("School".to_string(), 1)]);
        assert_eq!(store.distillation_for(&capture.id).unwrap().unwrap().len(), 3, "the capture's distillation is one set, wherever its objects live");
        assert!(store.list_knowledge_objects().unwrap().iter().all(|o| o.provenance.capture_id == capture.id));
    }

    #[test]
    fn a_cross_project_relation_is_valid_and_the_project_graph_marks_the_far_end() {
        let store = store();
        let (arthur, nexus, school) = (store.create_project("Arthur").unwrap(), store.create_project("Nexus").unwrap(), store.create_project("School").unwrap());
        let make = |project: &str, title: &str| {
            let capture = capture_in(&store, Some(project), &format!("{title} text"));
            distill(&store, &capture, &[title]).remove(0)
        };
        let (a1, a2) = (make(&arthur.id, "Arthur one"), make(&arthur.id, "Arthur two"));
        let (n1, n2) = (make(&nexus.id, "Nexus capability"), make(&nexus.id, "Nexus unrelated"));
        let s1 = make(&school.id, "School essay");
        let relate = |kind: &str, from: &KnowledgeObject, to: &KnowledgeObject| {
            store.create_relation(NewRelation { kind: kind.into(), source_object_id: from.id.clone(), target_object_id: to.id.clone() }, "user").unwrap()
        };
        let internal = relate("extends", &a2, &a1);
        let cross = relate("depends_on", &a1, &n1);
        let _elsewhere = relate("related_to", &n1, &n2);
        let _other_project_pair = relate("related_to", &n2, &s1);

        let graph = store.project_graph(&arthur.id).unwrap();

        assert_eq!(graph.project_id, arthur.id);
        assert_eq!(graph.objects.iter().map(|o| o.id.clone()).collect::<Vec<_>>().len(), 2);
        assert!(graph.objects.iter().all(|o| o.project_id == arthur.id));
        assert_eq!(graph.relations, vec![internal, cross.clone()], "internal edges and the cross-project edge, nothing else");
        assert_eq!(graph.external_objects, vec![ExternalObject { id: n1.id.clone(), kind: "idea".into(), title: "Nexus capability".into(), project_id: nexus.id.clone(), project_name: "Nexus".into() }]);
        // The graph did not expand into the other project: Nexus unrelated and School essay are absent.
        assert!(graph.external_objects.iter().all(|o| o.id != n2.id && o.id != s1.id));

        // The same edge seen from the other side.
        let nexus_graph = store.project_graph(&nexus.id).unwrap();
        assert!(nexus_graph.relations.iter().any(|r| r.kind == "depends_on"));
        assert_eq!(nexus_graph.external_objects.iter().map(|o| (o.title.as_str(), o.project_name.as_str())).collect::<Vec<_>>(), [("Arthur one", "Arthur"), ("School essay", "School")]);

        // Moving the far end changes which side is external, and the edge itself is untouched.
        store.move_knowledge_object(&n1.id, &arthur.id).unwrap();
        let after = store.project_graph(&arthur.id).unwrap();
        assert_eq!(after.external_objects.iter().map(|o| o.title.as_str()).collect::<Vec<_>>(), ["Nexus unrelated"], "now the edge to Nexus unrelated crosses instead");
        assert!(after.relations.iter().any(|r| r.id == cross.id), "the same relation, now internal");
        assert_eq!(store.project_graph("missing"), Err(ProjectError::ProjectNotFound));
    }

    #[test]
    fn an_empty_project_has_an_empty_graph() {
        let store = store();
        let nexus = store.create_project("Nexus").unwrap();
        let graph = store.project_graph(&nexus.id).unwrap();
        assert!((graph.objects.is_empty(), graph.relations.is_empty(), graph.external_objects.is_empty()) == (true, true, true));
    }

    #[test]
    fn captures_can_be_fetched_by_id_in_one_query_wherever_they_live() {
        let store = store();
        let nexus = store.create_project("Nexus").unwrap();
        let (a, b) = (capture_in(&store, None, "in the inbox"), capture_in(&store, Some(&nexus.id), "in nexus"));
        let found = store.get_captures(&[a.id.clone(), b.id.clone(), "unknown".into()]).unwrap();
        assert_eq!(found, vec![b.clone(), a.clone()], "unknown ids are absent; every project is searched");
        assert_eq!(store.get_captures(&[]).unwrap(), vec![]);
        assert!(matches!(store.get_captures(&vec!["x".to_string(); 1001]), Err(StoreError::Invalid(_))));
    }

    #[test]
    fn contracts_serialize_in_camel_case() {
        let store = store();
        let project = store.create_project("Nexus").unwrap();
        let value = serde_json::to_value(&project).unwrap();
        let mut keys: Vec<&String> = value.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["archivedAt", "captureCount", "createdAt", "id", "isInbox", "name", "objectCount", "updatedAt"]);
        assert!(value["archivedAt"].is_null());
        let error = serde_json::to_value(ProjectError::NameTaken).unwrap();
        assert_eq!(error["code"], "project_name_taken");
        let graph = serde_json::to_value(store.project_graph(&project.id).unwrap()).unwrap();
        let mut graph_keys: Vec<&String> = graph.as_object().unwrap().keys().collect();
        graph_keys.sort();
        assert_eq!(graph_keys, ["externalObjects", "objects", "projectId", "relations"]);
    }

    /// Bounded queries: project lists, scoped lists and the project graph stay fast and do not scale per object.
    /// `cargo test project_read_timings -- --ignored --nocapture`: scoped reads on a few thousand synthetic objects.
    #[test]
    #[ignore = "timing report, not a pass/fail test"]
    fn project_read_timings() {
        use std::time::Instant;
        let store = store();
        let projects: Vec<Project> = (0..5).map(|i| store.create_project(&format!("Project {i}")).unwrap()).collect();
        let mut ids = Vec::new();
        let started = Instant::now();
        for n in 0..500 {
            let project = &projects[n % 5];
            let capture = capture_in(&store, Some(&project.id), &format!("synthetic capture number {n} about topic {}", n % 17));
            let titles: Vec<String> = (0..4).map(|k| format!("Idea {n}.{k}")).collect();
            let titles: Vec<&str> = titles.iter().map(String::as_str).collect();
            ids.extend(distill(&store, &capture, &titles).into_iter().map(|o| o.id));
        }
        let built = started.elapsed();
        for k in 0..1500 {
            let (a, b) = (&ids[(k * 7) % ids.len()], &ids[(k * 13 + 1) % ids.len()]);
            if a != b {
                let _ = store.create_relation(NewRelation { kind: "related_to".into(), source_object_id: a.clone(), target_object_id: b.clone() }, "user");
            }
        }
        let target = &projects[0].id;
        let time = |label: &str, work: &mut dyn FnMut() -> usize| {
            work();
            let runs = 20;
            let started = Instant::now();
            let mut size = 0;
            for _ in 0..runs {
                size = work();
            }
            println!("TIMING {label}: {:.2} ms/run ({size} rows)", started.elapsed().as_secs_f64() * 1000.0 / runs as f64);
        };
        println!("TIMING setup: {} objects, {} relations in {built:?}", ids.len(), store.list_relations().unwrap().len());
        time("list_projects (counts, 5 projects)", &mut || store.list_projects(true).unwrap().len());
        time("list_captures_in(project)", &mut || store.list_in(Some(target)).unwrap().len());
        time("list_knowledge_objects_in(project)", &mut || store.list_knowledge_objects_in(Some(target)).unwrap().len());
        time("list_knowledge_objects (ALL, for comparison)", &mut || store.list_knowledge_objects().unwrap().len());
        time("list_organization_states_in(project)", &mut || store.list_organization_states_in(Some(target)).unwrap().len());
        time("knowledge_summaries_in(project)", &mut || store.knowledge_summaries_in(None, Some(target)).unwrap().len());
        time("project_graph(project)", &mut || store.project_graph(target).unwrap().relations.len());
        time("get_captures(100 ids)", &mut || store.get_captures(&store.list_in(Some(target)).unwrap().into_iter().take(100).map(|c| c.id).collect::<Vec<_>>()).unwrap().len());
        let graph = store.project_graph(target).unwrap();
        println!("TIMING project_graph shape: {} own objects, {} touching relations, {} external ends", graph.objects.len(), graph.relations.len(), graph.external_objects.len());
        let connection = store.connection.lock().unwrap();
        for sql in [
            "SELECT id FROM captures WHERE project_id = 'p' ORDER BY seq DESC",
            "SELECT o.id FROM knowledge_objects o WHERE o.project_id = 'p'",
            "SELECT r.id FROM relations r WHERE r.id IN (SELECT r1.id FROM knowledge_objects o JOIN relations r1 ON r1.source_object_id = o.id WHERE o.project_id = 'p' UNION SELECT r2.id FROM knowledge_objects o JOIN relations r2 ON r2.target_object_id = o.id WHERE o.project_id = 'p')",
        ] {
            let mut statement = connection.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            let plan: Vec<String> = statement.query_map([], |r| r.get::<_, String>(3)).unwrap().map(|r| r.unwrap()).collect();
            println!("PLAN {sql}\n     -> {}", plan.join(" | "));
        }
    }

    #[test]
    fn scoped_reads_use_the_project_index() {
        let store = store();
        let plan = |sql: &str| -> String {
            let connection = store.connection.lock().unwrap();
            let mut statement = connection.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            statement.query_map([], |r| r.get::<_, String>(3)).unwrap().map(|r| r.unwrap()).collect::<Vec<_>>().join(" | ")
        };
        assert!(plan("SELECT id FROM captures WHERE project_id = 'p' ORDER BY seq DESC").contains("captures_by_project"));
        assert!(plan("SELECT id FROM knowledge_objects WHERE project_id = 'p'").contains("knowledge_objects_by_project"));
        assert!(plan("SELECT count(*) FROM knowledge_objects WHERE project_id = 'p'").contains("knowledge_objects_by_project"));
    }
}
