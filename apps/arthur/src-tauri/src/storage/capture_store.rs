//! App-local SQLite storage for Captures.
//!
//! This is the application/mobile-side store. It is NOT the canonical Home Node
//! Cognitive Store; syncing captures to a Home Node is a later milestone.

use std::fmt;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

use super::migrations::{migrate, INBOX_PROJECT_ID};
#[cfg(test)]
use super::migrations::SCHEMA_VERSION;

/// Mirrors `MAX_CAPTURE_CONTENT_CHARS` in `packages/contracts/capture.ts`.
pub const MAX_CAPTURE_CONTENT_CHARS: usize = 20_000;

/// Mirrors `CAPTURE_SOURCE_KINDS` in `packages/contracts/capture.ts`.
const SOURCES: [&str; 3] = ["text", "voice", "emg"];

/// Mirrors `Capture` in `packages/contracts/capture.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub id: String,
    pub source: String,
    pub content: String,
    pub created_at: String,
    /// The project this capture belongs to (schema v6). Organizational context: changing it never rewrites the content.
    pub project_id: String,
}

/// Mirrors `MAX_CAPTURE_LOOKUP` in `packages/contracts/capture.ts`.
pub const MAX_CAPTURE_LOOKUP: usize = 1_000;

/// Mirrors `CreateCaptureInput` in `packages/contracts/capture.ts`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateCaptureInput {
    pub source: String,
    pub content: String,
    /// The project to capture into. Omitted means the Inbox. The UI always sends the active project.
    #[serde(default)]
    pub project_id: Option<String>,
}

#[derive(Debug)]
pub enum StoreError {
    /// The caller supplied something invalid (a capture, an object, a relation).
    Invalid(String),
    /// The caller referred to a knowledge object that does not exist.
    NotFound(String),
    /// The caller referred to a revision that does not exist.
    MissingRevision(String),
    /// The database holds data this version cannot safely interpret.
    Corrupt(String),
    Database(rusqlite::Error),
    Poisoned,
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Invalid(message) => write!(f, "invalid capture: {message}"),
            StoreError::NotFound(message) => write!(f, "not found: {message}"),
            StoreError::MissingRevision(message) => write!(f, "revision not found: {message}"),
            StoreError::Corrupt(message) => write!(f, "capture database is unreadable: {message}"),
            StoreError::Database(error) => write!(f, "capture database error: {error}"),
            StoreError::Poisoned => write!(f, "capture store is unavailable"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        StoreError::Database(error)
    }
}

pub struct CaptureStore {
    pub(super) connection: Mutex<Connection>,
}

impl CaptureStore {
    /// Opens (creating if needed) the database at `path` and brings its schema
    /// up to date. Safe to call on every launch.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        Self::from_connection(Connection::open(path)?)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    /// Lets other modules' tests inject faults (triggers, corruption) without owning the connection.
    #[cfg(test)]
    pub fn execute_sql_for_test(&self, sql: &str) {
        self.connection.lock().unwrap().execute_batch(sql).unwrap();
    }

    /// Test helper: the single integer a query returns.
    #[cfg(test)]
    pub fn query_i64_for_test(&self, sql: &str) -> i64 {
        self.connection.lock().unwrap().query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn from_connection(mut connection: Connection) -> Result<Self, StoreError> {
        // A successful insert must be on disk before `create` returns.
        connection.pragma_update(None, "synchronous", "FULL")?;
        // SQLite ignores foreign keys unless asked, per connection.
        connection.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&mut connection)?;
        Ok(Self { connection: Mutex::new(connection) })
    }

    pub fn create(&self, input: CreateCaptureInput) -> Result<Capture, StoreError> {
        validate_input(&input)?;
        let project_id = input.project_id.unwrap_or_else(|| INBOX_PROJECT_ID.to_string());
        let capture = Capture {
            id: Uuid::new_v4().to_string(),
            source: input.source,
            content: input.content,
            created_at: now_rfc3339()?,
            project_id,
        };
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        // The project must exist and be open. Checked here for a precise message; the schema repeats it as a trigger.
        match connection.query_row("SELECT archived_at IS NOT NULL FROM projects WHERE id = ?1", [&capture.project_id], |row| row.get::<_, bool>(0)).optional()? {
            None => return Err(StoreError::Invalid("project does not exist".into())),
            Some(true) => return Err(StoreError::Invalid("project is archived".into())),
            Some(false) => {}
        }
        // Autocommit: the row is committed (and synced) when this returns.
        connection.execute(
            "INSERT INTO captures (id, source, content, created_at, project_id) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![capture.id, capture.source, capture.content, capture.created_at, capture.project_id],
        )?;
        Ok(capture)
    }

    pub fn get_capture(&self, id: &str) -> Result<Option<Capture>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let found = connection
            .query_row("SELECT id, source, content, created_at, project_id FROM captures WHERE id = ?1", [id], |row| {
                Ok(Capture { id: row.get(0)?, source: row.get(1)?, content: row.get(2)?, created_at: row.get(3)?, project_id: row.get(4)? })
            })
            .map(Some)
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        if let Some(capture) = &found {
            validate_stored(capture)?;
        }
        Ok(found)
    }

    /// The captures with these ids, in no particular order, from one query. Unknown ids are simply absent. Not scoped by
    /// project: provenance must open the original Capture wherever the idea derived from it now lives.
    pub fn get_captures(&self, ids: &[String]) -> Result<Vec<Capture>, StoreError> {
        if ids.len() > MAX_CAPTURE_LOOKUP {
            return Err(StoreError::Invalid(format!("more than {MAX_CAPTURE_LOOKUP} ids")));
        }
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let sql = format!(
            "SELECT id, source, content, created_at, project_id FROM captures WHERE id IN ({}) ORDER BY seq DESC",
            vec!["?"; ids.len()].join(",")
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(rusqlite::params_from_iter(ids.iter()), |row| {
            Ok(Capture { id: row.get(0)?, source: row.get(1)?, content: row.get(2)?, created_at: row.get(3)?, project_id: row.get(4)? })
        })?;
        let mut captures = Vec::new();
        for row in rows {
            let capture = row?;
            validate_stored(&capture)?;
            captures.push(capture);
        }
        Ok(captures)
    }

    /// Newest first. Fails as a whole if any stored row is malformed.
    #[allow(dead_code)] // the unscoped form; the app itself always names a project
    pub fn list(&self) -> Result<Vec<Capture>, StoreError> {
        self.list_in(None)
    }

    /// Newest first, optionally only the captures of one project (an indexed lookup).
    pub fn list_in(&self, project_id: Option<&str>) -> Result<Vec<Capture>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT id, source, content, created_at, project_id FROM captures WHERE (?1 IS NULL OR project_id = ?1) ORDER BY seq DESC",
        )?;
        let rows = statement.query_map([project_id], |row| {
            Ok(Capture { id: row.get(0)?, source: row.get(1)?, content: row.get(2)?, created_at: row.get(3)?, project_id: row.get(4)? })
        })?;
        let mut captures = Vec::new();
        for row in rows {
            let capture = row?;
            validate_stored(&capture)?;
            captures.push(capture);
        }
        Ok(captures)
    }
}

pub(super) fn now_rfc3339() -> Result<String, StoreError> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| StoreError::Corrupt(format!("cannot format timestamp: {error}")))
}

fn validate_input(input: &CreateCaptureInput) -> Result<(), StoreError> {
    if !SOURCES.contains(&input.source.as_str()) {
        return Err(StoreError::Invalid(format!("unknown source \"{}\"", input.source)));
    }
    if input.content.trim().is_empty() {
        return Err(StoreError::Invalid("content is empty".into()));
    }
    if input.content.chars().count() > MAX_CAPTURE_CONTENT_CHARS {
        return Err(StoreError::Invalid(format!("content exceeds {MAX_CAPTURE_CONTENT_CHARS} characters")));
    }
    Ok(())
}

fn validate_stored(capture: &Capture) -> Result<(), StoreError> {
    let corrupt = |reason: &str| StoreError::Corrupt(format!("row {:?}: {reason}", capture.id));
    if capture.id.is_empty() {
        return Err(corrupt("empty id"));
    }
    if !SOURCES.contains(&capture.source.as_str()) {
        return Err(corrupt("unknown source"));
    }
    if capture.content.trim().is_empty() {
        return Err(corrupt("empty content"));
    }
    if capture.project_id.is_empty() {
        return Err(corrupt("no project"));
    }
    if OffsetDateTime::parse(&capture.created_at, &Rfc3339).is_err() {
        return Err(corrupt("created_at is not RFC 3339"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn text(content: &str) -> CreateCaptureInput {
        CreateCaptureInput { source: "text".into(), content: content.into(), project_id: None }
    }

    #[test]
    fn an_empty_database_lists_nothing() {
        assert_eq!(CaptureStore::open_in_memory().unwrap().list().unwrap(), vec![]);
    }

    #[test]
    fn create_returns_the_stored_capture_and_list_returns_it() {
        let store = CaptureStore::open_in_memory().unwrap();
        let created = store.create(text("  benchmark EMG latency\n")).unwrap();

        assert_eq!(created.source, "text");
        assert_eq!(created.content, "  benchmark EMG latency\n", "raw content is stored untouched");
        assert!(OffsetDateTime::parse(&created.created_at, &Rfc3339).is_ok());
        assert_eq!(store.list().unwrap(), vec![created]);
    }

    #[test]
    fn list_is_newest_first_and_deterministic_even_with_identical_timestamps() {
        let store = CaptureStore::open_in_memory().unwrap();
        let ids: Vec<String> = ["a", "b", "c"].iter().map(|c| store.create(text(c)).unwrap().id).collect();

        let listed: Vec<String> = store.list().unwrap().into_iter().map(|c| c.id).collect();
        let expected: Vec<String> = ids.into_iter().rev().collect();
        assert_eq!(listed, expected);
        assert_eq!(store.list().unwrap(), store.list().unwrap());
    }

    #[test]
    fn ids_are_unique() {
        let store = CaptureStore::open_in_memory().unwrap();
        let ids: HashSet<String> = (0..50).map(|i| store.create(text(&format!("n{i}"))).unwrap().id).collect();
        assert_eq!(ids.len(), 50);
    }

    #[test]
    fn captures_survive_closing_and_reopening_the_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");

        let first = CaptureStore::open(&path).unwrap();
        let a = first.create(text("first thought")).unwrap();
        let b = first.create(CreateCaptureInput { source: "voice".into(), content: "second".into(), project_id: None }).unwrap();
        drop(first);

        let reopened = CaptureStore::open(&path).unwrap();
        assert_eq!(reopened.list().unwrap(), vec![b, a]);
    }

    #[test]
    fn initialisation_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        let created = CaptureStore::open(&path).unwrap().create(text("keep me")).unwrap();

        for _ in 0..3 {
            CaptureStore::open(&path).unwrap();
        }
        let connection = Connection::open(&path).unwrap();
        let version: i64 = connection.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(CaptureStore::open(&path).unwrap().list().unwrap(), vec![created]);
    }

    #[test]
    fn invalid_input_is_rejected_and_nothing_is_stored() {
        let store = CaptureStore::open_in_memory().unwrap();
        let too_long = "x".repeat(MAX_CAPTURE_CONTENT_CHARS + 1);
        for bad in [
            text(""),
            text("   \n\t"),
            text(&too_long),
            CreateCaptureInput { source: "telepathy".into(), content: "hi".into(), project_id: None },
        ] {
            assert!(matches!(store.create(bad), Err(StoreError::Invalid(_))));
        }
        assert!(store.list().unwrap().is_empty());
        assert!(store.create(text(&"x".repeat(MAX_CAPTURE_CONTENT_CHARS))).is_ok());
    }

    #[test]
    fn a_malformed_row_fails_the_listing_instead_of_returning_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        {
            // A database from a faulty writer: right version, but no CHECK constraints.
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE captures (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, source TEXT, content TEXT, created_at TEXT);
                     INSERT INTO captures (id, source, content, created_at) VALUES ('x1', 'carrier-pigeon', 'hi', 'not a date');
                     PRAGMA user_version = 1;",
                )
                .unwrap();
        }
        let store = CaptureStore::open(&path).unwrap();
        assert!(matches!(store.list(), Err(StoreError::Corrupt(_))));
    }

    #[test]
    fn a_database_from_a_newer_version_is_refused_not_modified() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("arthur.db");
        Connection::open(&path).unwrap().pragma_update(None, "user_version", 99).unwrap();

        assert!(matches!(CaptureStore::open(&path), Err(StoreError::Corrupt(_))));
        let version: i64 = Connection::open(&path).unwrap().query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 99);
    }

    #[test]
    fn capture_serializes_to_the_contract_shape() {
        let store = CaptureStore::open_in_memory().unwrap();
        let value = serde_json::to_value(store.create(text("hi")).unwrap()).unwrap();
        let mut keys: Vec<&String> = value.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["content", "createdAt", "id", "projectId", "source"]);
    }

    #[test]
    fn create_input_rejects_unknown_fields() {
        let ok: Result<CreateCaptureInput, _> = serde_json::from_str(r#"{"source":"text","content":"hi"}"#);
        assert!(ok.is_ok());
        let extra: Result<CreateCaptureInput, _> = serde_json::from_str(r#"{"source":"text","content":"hi","id":"forged"}"#);
        assert!(extra.is_err(), "callers cannot choose ids");
    }
}
