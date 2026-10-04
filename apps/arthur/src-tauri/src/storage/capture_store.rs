//! App-local SQLite storage for Captures.
//!
//! This is the application/mobile-side store. It is NOT the canonical Home Node
//! Cognitive Store; syncing captures to a Home Node is a later milestone.

use std::fmt;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

/// Mirrors `MAX_CAPTURE_CONTENT_CHARS` in `packages/contracts/capture.ts`.
pub const MAX_CAPTURE_CONTENT_CHARS: usize = 20_000;

/// Mirrors `CAPTURE_SOURCE_KINDS` in `packages/contracts/capture.ts`.
const SOURCES: [&str; 3] = ["text", "voice", "emg"];

const SCHEMA_VERSION: i64 = 1;

/// `seq` gives a total insertion order, so listing is deterministic even when
/// two captures share a timestamp.
const SCHEMA_V1: &str = "
CREATE TABLE IF NOT EXISTS captures (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    id         TEXT    NOT NULL UNIQUE CHECK (length(id) > 0),
    source     TEXT    NOT NULL CHECK (source IN ('text', 'voice', 'emg')),
    content    TEXT    NOT NULL CHECK (length(content) > 0),
    created_at TEXT    NOT NULL CHECK (length(created_at) > 0)
);
";

/// Mirrors `Capture` in `packages/contracts/capture.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub id: String,
    pub source: String,
    pub content: String,
    pub created_at: String,
}

/// Mirrors `CreateCaptureInput` in `packages/contracts/capture.ts`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateCaptureInput {
    pub source: String,
    pub content: String,
}

#[derive(Debug)]
pub enum StoreError {
    /// The caller supplied an invalid capture.
    Invalid(String),
    /// The database holds data this version cannot safely interpret.
    Corrupt(String),
    Database(rusqlite::Error),
    Poisoned,
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Invalid(message) => write!(f, "invalid capture: {message}"),
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
    connection: Mutex<Connection>,
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

    fn from_connection(mut connection: Connection) -> Result<Self, StoreError> {
        // A successful insert must be on disk before `create` returns.
        connection.pragma_update(None, "synchronous", "FULL")?;
        migrate(&mut connection)?;
        Ok(Self { connection: Mutex::new(connection) })
    }

    pub fn create(&self, input: CreateCaptureInput) -> Result<Capture, StoreError> {
        validate_input(&input)?;
        let capture = Capture {
            id: Uuid::new_v4().to_string(),
            source: input.source,
            content: input.content,
            created_at: OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .map_err(|error| StoreError::Corrupt(format!("cannot format timestamp: {error}")))?,
        };
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        // Autocommit: the row is committed (and synced) when this returns.
        connection.execute(
            "INSERT INTO captures (id, source, content, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![capture.id, capture.source, capture.content, capture.created_at],
        )?;
        Ok(capture)
    }

    /// Newest first. Fails as a whole if any stored row is malformed.
    pub fn list(&self) -> Result<Vec<Capture>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let mut statement =
            connection.prepare("SELECT id, source, content, created_at FROM captures ORDER BY seq DESC")?;
        let rows = statement.query_map([], |row| {
            Ok(Capture { id: row.get(0)?, source: row.get(1)?, content: row.get(2)?, created_at: row.get(3)? })
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

fn migrate(connection: &mut Connection) -> Result<(), StoreError> {
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    match version {
        0 => {
            let transaction = connection.transaction()?;
            transaction.execute_batch(SCHEMA_V1)?;
            transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            transaction.commit()?;
            Ok(())
        }
        SCHEMA_VERSION => Ok(()),
        other => Err(StoreError::Corrupt(format!(
            "schema version {other} is newer than the supported version {SCHEMA_VERSION}"
        ))),
    }
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
        CreateCaptureInput { source: "text".into(), content: content.into() }
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
        let b = first.create(CreateCaptureInput { source: "voice".into(), content: "second".into() }).unwrap();
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
            CreateCaptureInput { source: "telepathy".into(), content: "hi".into() },
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
                    "CREATE TABLE captures (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, source TEXT, content TEXT, created_at TEXT);
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
        assert_eq!(keys, ["content", "createdAt", "id", "source"]);
    }

    #[test]
    fn create_input_rejects_unknown_fields() {
        let ok: Result<CreateCaptureInput, _> = serde_json::from_str(r#"{"source":"text","content":"hi"}"#);
        assert!(ok.is_ok());
        let extra: Result<CreateCaptureInput, _> = serde_json::from_str(r#"{"source":"text","content":"hi","id":"forged"}"#);
        assert!(extra.is_err(), "callers cannot choose ids");
    }
}
