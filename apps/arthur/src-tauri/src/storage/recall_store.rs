//! Retrieval reads and index writes for Cognitive Recall (schema v7).
//!
//! This is the only code that touches SQLite on behalf of `recall/`. Everything here is either a READ of authoritative rows
//! (objects, revisions, projects) or a read/write of the rebuildable projections `recall_revision_fts`, `recall_embeddings` and
//! `recall_meta`. Nothing here changes an authoritative row.
//!
//! Invariants the queries rely on (all enforced by the v4/v6 schema):
//! * `knowledge_objects.kind/title/body` equal the object's current revision, so "current knowledge" is `knowledge_objects`.
//! * Revisions are immutable, so the FTS index (insert-only) can never describe text that was later changed.
//! * The project of an object is `knowledge_objects.project_id`; it is a query-time predicate, never copied into an index.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};

use super::capture_store::{now_rfc3339, CaptureStore, StoreError};

/// One current object, exactly as stored (the current revision's text).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentObject {
    pub object_id: String,
    pub project_id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub current_revision_id: String,
    /// When the current revision was created. Used only as a ranking tie-break.
    pub updated_at: String,
    /// Insertion order of the object, the final deterministic tie-break.
    pub seq: i64,
}

/// A lexical hit on a CURRENT revision.
#[derive(Debug, Clone, PartialEq)]
pub struct CurrentLexicalHit {
    pub object: CurrentObject,
    /// FTS5 `bm25`: smaller is better. Diagnostics only; fusion uses rank.
    pub bm25: f64,
}

/// A lexical hit on a revision that is NOT the object's current one. Never usable as current knowledge.
#[derive(Debug, Clone, PartialEq)]
pub struct HistoricalLexicalHit {
    pub object: CurrentObject,
    pub revision_id: String,
    pub revision_title: String,
    pub revision_body: String,
    pub bm25: f64,
}

/// An object whose current projection has no valid vector for the active model key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingEmbedding {
    pub object_id: String,
    pub revision_id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SemanticCoverage {
    pub in_scope_objects: i64,
    /// Objects with a vector for the active model key whose revision is the current one.
    pub embedded_objects: i64,
}

/// A scored vector. Ordered so a `BinaryHeap` pops the WORST first (lowest cosine, then the greater id).
#[derive(Debug, Clone, PartialEq)]
pub struct VectorHit {
    pub object_id: String,
    pub cosine: f32,
}

impl Eq for VectorHit {}

impl Ord for VectorHit {
    fn cmp(&self, other: &Self) -> Ordering {
        // Reverse on cosine so the heap's top is the lowest cosine; ties: the lexicographically greater id is "worse".
        other.cosine.total_cmp(&self.cosine).then_with(|| self.object_id.cmp(&other.object_id))
    }
}

impl PartialOrd for VectorHit {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// How many vectors were examined and how many were the wrong size (corrupt rows are skipped, not trusted).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct VectorScan {
    pub scanned: usize,
    pub skipped_malformed: usize,
}

const CURRENT_COLUMNS: &str = "o.id, o.project_id, o.kind, o.title, o.body, o.current_revision_id, cr.created_at, o.seq";

fn current_object_from_row(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<CurrentObject> {
    Ok(CurrentObject {
        object_id: row.get(offset)?,
        project_id: row.get(offset + 1)?,
        kind: row.get(offset + 2)?,
        title: row.get(offset + 3)?,
        body: row.get(offset + 4)?,
        current_revision_id: row.get(offset + 5)?,
        updated_at: row.get(offset + 6)?,
        seq: row.get(offset + 7)?,
    })
}

/// Little-endian f32 bytes of a vector (the stored format).
pub fn encode_vector(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|value| value.to_le_bytes()).collect()
}

fn lexical_current_sql() -> String {
    format!(
        "SELECT {CURRENT_COLUMNS}, bm25(recall_revision_fts, 8.0, 1.0) AS score \
         FROM recall_revision_fts \
         JOIN thought_revisions cr ON cr.seq = recall_revision_fts.rowid \
         JOIN knowledge_objects o ON o.id = cr.object_id AND o.current_revision_id = cr.id \
         WHERE recall_revision_fts MATCH ?1 AND o.project_id = ?2 \
         ORDER BY score ASC, o.seq ASC LIMIT ?3"
    )
}

// CROSS JOIN pins the order: walk the PROJECT's objects through the project index and probe each vector by primary key. Without it
// the planner starts from `recall_embeddings(model_key)` and reads every project's vectors before filtering (found by the benchmark).
/// One FTS pass returning every matching revision of the project (current or not), best first: the candidate single-pass form.
#[cfg(test)]
fn single_pass_sql(limit: usize) -> String {
    format!(
        "SELECT {CURRENT_COLUMNS}, r.id, r.title, r.body, (o.current_revision_id = r.id) AS is_current, bm25(recall_revision_fts, 8.0, 1.0) AS score \
         FROM recall_revision_fts \
         JOIN thought_revisions r ON r.seq = recall_revision_fts.rowid \
         JOIN knowledge_objects o ON o.id = r.object_id \
         JOIN thought_revisions cr ON cr.id = o.current_revision_id \
         WHERE recall_revision_fts MATCH ?1 AND o.project_id = ?2 ORDER BY score ASC, r.seq DESC LIMIT {limit}"
    )
}

const SEMANTIC_SCAN_SQL: &str = "SELECT e.object_id, e.vector FROM knowledge_objects o \
     CROSS JOIN recall_embeddings e ON e.object_id = o.id AND e.model_key = ?1 AND e.revision_id = o.current_revision_id AND e.dims = ?3 \
     WHERE o.project_id = ?2";

/// Facts about a database FILE without migrating it: `(user_version, objects, revisions, captures)`. Tests only; platform acceptance
/// uses it to prove a real database was at v6 before the app code upgraded it.
#[cfg(test)]
pub fn database_facts_for_test(path: &std::path::Path) -> (i64, i64, i64, i64) {
    let connection = Connection::open(path).unwrap();
    let count = |table: &str| connection.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get::<_, i64>(0)).unwrap();
    (connection.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap(), count("knowledge_objects"), count("thought_revisions"), count("captures"))
}

/// The semantic scan as it was BEFORE the join order was pinned (tests only, to prove the regression test can tell the difference).
#[cfg(test)]
const SEMANTIC_SCAN_SQL_UNPINNED: &str = "SELECT e.object_id, e.vector FROM knowledge_objects o \
     JOIN recall_embeddings e ON e.object_id = o.id AND e.model_key = ?1 AND e.revision_id = o.current_revision_id AND e.dims = ?3 \
     WHERE o.project_id = ?2";

/// What running a semantic-scan statement cost, as SQLite itself counts it.
#[cfg(test)]
#[derive(Debug, Clone)]
pub struct ScanCost {
    pub plan: Vec<String>,
    /// SQLite virtual-machine steps: proportional to the rows the statement visits, including rows it later filters out.
    pub vm_steps: i32,
    pub rows: usize,
    pub micros: u128,
}


/// A knowledge object with what enrichment needs beyond retrieval: its project (name, archived), how its current revision came to be,
/// where the object originally came from, and how many revisions it has. Not scoped by project (a graph neighbour may be elsewhere).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectDetail {
    pub object: CurrentObject,
    pub project_name: String,
    pub project_archived: bool,
    /// `initial`, `user_edit`, `distillation`, `merge` or `system`: how the CURRENT revision was made.
    pub current_origin: String,
    /// The Capture span the CURRENT revision was interpreted from, if it genuinely was (edits and merges have none).
    pub current_source: Option<(String, i64, i64)>,
    /// Where the object originally came from (`object_sources`).
    pub original_source: Option<(String, i64, i64)>,
    pub revision_count: i64,
}

/// One stored relation, as read for enrichment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelationRow {
    pub id: String,
    pub kind: String,
    pub source_object_id: String,
    pub target_object_id: String,
    pub origin: String,
    pub created_at: String,
}

/// One revision with its parents (oldest parent first).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionRow {
    pub id: String,
    pub object_id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub origin: String,
    pub created_at: String,
    pub source: Option<(String, i64, i64)>,
    pub parents: Vec<String>,
}

/// Safety bound on relations read for one expansion step (a hub cannot flood memory).
pub const MAX_RELATIONS_PER_READ: usize = 2_000;

fn marks(n: usize) -> String {
    vec!["?"; n].join(",")
}

impl CaptureStore {
    /// Details of these objects (any project), in one statement. Ids that do not exist are absent.
    pub fn recall_object_details(&self, object_ids: &[String]) -> Result<Vec<ObjectDetail>, StoreError> {
        if object_ids.is_empty() {
            return Ok(Vec::new());
        }
        self.with_connection(|connection| {
            let mut statement = connection.prepare(&format!(
                "SELECT {CURRENT_COLUMNS}, p.name, p.archived_at IS NOT NULL, cr.origin, cr.capture_id, cr.source_start, cr.source_end, \
                        s.capture_id, s.source_start, s.source_end, (SELECT count(*) FROM thought_revisions x WHERE x.object_id = o.id) \
                 FROM knowledge_objects o \
                 JOIN thought_revisions cr ON cr.id = o.current_revision_id \
                 JOIN projects p ON p.id = o.project_id \
                 LEFT JOIN object_sources s ON s.object_id = o.id \
                 WHERE o.id IN ({}) ORDER BY o.seq",
                marks(object_ids.len())
            ))?;
            let rows = statement.query_map(params_from_iter(object_ids.iter()), |row| {
                let span = |a: usize| -> rusqlite::Result<Option<(String, i64, i64)>> {
                    let capture: Option<String> = row.get(a)?;
                    Ok(match capture {
                        Some(capture) => Some((capture, row.get(a + 1)?, row.get(a + 2)?)),
                        None => None,
                    })
                };
                Ok(ObjectDetail {
                    object: current_object_from_row(row, 0)?,
                    project_name: row.get(8)?,
                    project_archived: row.get(9)?,
                    current_origin: row.get(10)?,
                    current_source: span(11)?,
                    original_source: span(14)?,
                    revision_count: row.get(17)?,
                })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// Every relation that has one of these objects as an end, from one statement (the by-source and by-target indexes), oldest first.
    pub fn recall_relations_touching(&self, object_ids: &[String]) -> Result<Vec<RelationRow>, StoreError> {
        if object_ids.is_empty() {
            return Ok(Vec::new());
        }
        self.with_connection(|connection| {
            let list = marks(object_ids.len());
            let mut statement = connection.prepare(&format!(
                "SELECT r.id, r.kind, r.source_object_id, r.target_object_id, r.origin, r.created_at FROM relations r WHERE r.id IN \
                 (SELECT id FROM relations WHERE source_object_id IN ({list}) UNION SELECT id FROM relations WHERE target_object_id IN ({list})) \
                 ORDER BY r.seq ASC LIMIT {MAX_RELATIONS_PER_READ}"
            ))?;
            let both: Vec<&String> = object_ids.iter().chain(object_ids.iter()).collect();
            let rows = statement.query_map(params_from_iter(both), |row| {
                Ok(RelationRow { id: row.get(0)?, kind: row.get(1)?, source_object_id: row.get(2)?, target_object_id: row.get(3)?, origin: row.get(4)?, created_at: row.get(5)? })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// Every revision of these objects with its parents, in two statements (revisions, then parent links), oldest first.
    pub fn recall_revisions_of(&self, object_ids: &[String]) -> Result<Vec<RevisionRow>, StoreError> {
        if object_ids.is_empty() {
            return Ok(Vec::new());
        }
        self.with_connection(|connection| {
            let list = marks(object_ids.len());
            let mut statement = connection.prepare(&format!(
                "SELECT id, object_id, kind, title, body, origin, created_at, capture_id, source_start, source_end FROM thought_revisions \
                 WHERE object_id IN ({list}) ORDER BY seq ASC"
            ))?;
            let mut revisions: Vec<RevisionRow> = statement
                .query_map(params_from_iter(object_ids.iter()), |row| {
                    let capture: Option<String> = row.get(7)?;
                    Ok(RevisionRow {
                        id: row.get(0)?,
                        object_id: row.get(1)?,
                        kind: row.get(2)?,
                        title: row.get(3)?,
                        body: row.get(4)?,
                        origin: row.get(5)?,
                        created_at: row.get(6)?,
                        source: match capture {
                            Some(capture) => Some((capture, row.get(8)?, row.get(9)?)),
                            None => None,
                        },
                        parents: Vec::new(),
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut parents = connection.prepare(&format!(
                "SELECT p.child_revision_id, p.parent_revision_id FROM revision_parents p \
                 JOIN thought_revisions c ON c.id = p.child_revision_id JOIN thought_revisions q ON q.id = p.parent_revision_id \
                 WHERE c.object_id IN ({list}) ORDER BY q.seq ASC"
            ))?;
            let links = parents.query_map(params_from_iter(object_ids.iter()), |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?.collect::<Result<Vec<_>, _>>()?;
            for (child, parent) in links {
                if let Some(revision) = revisions.iter_mut().find(|r| r.id == child) {
                    revision.parents.push(parent);
                }
            }
            Ok(revisions)
        })
    }
}

impl CaptureStore {
    /// Times the pieces of the lexical query (tests only): where does the time go, and would a single pass help?
    #[cfg(test)]
    pub fn recall_lexical_probe_for_test(&self, expression: &str, project_id: &str) -> Vec<(&'static str, f64, usize)> {
        let connection = self.connection.lock().unwrap();
        let mut out = Vec::new();
        let mut time = |name: &'static str, sql: String| {
            let mut statement = connection.prepare(&sql).unwrap();
            let started = std::time::Instant::now();
            let mut rows = statement.query(params![expression, project_id]).unwrap();
            let mut n = 0usize;
            while let Some(row) = rows.next().unwrap() {
                let _ = row.get_ref(0).unwrap();
                n += 1;
            }
            out.push((name, started.elapsed().as_secs_f64() * 1000.0, n));
        };
        time("fts only: matches (count rows, no join)", "SELECT rowid FROM recall_revision_fts WHERE recall_revision_fts MATCH ?1 AND ?2 IS NOT NULL".into());
        time("fts only: top 30 by bm25, no join", "SELECT rowid, bm25(recall_revision_fts, 8.0, 1.0) AS s FROM recall_revision_fts WHERE recall_revision_fts MATCH ?1 AND ?2 IS NOT NULL ORDER BY s LIMIT 30".into());
        time("current query as shipped (joins + project + top 30)", lexical_current_sql().replace("LIMIT ?3", "LIMIT 30"));
        time(
            "historical query as shipped (top 50 rows)",
            format!(
                "SELECT {CURRENT_COLUMNS}, r.id, r.title, r.body, bm25(recall_revision_fts, 8.0, 1.0) AS score FROM recall_revision_fts \
                 JOIN thought_revisions r ON r.seq = recall_revision_fts.rowid JOIN knowledge_objects o ON o.id = r.object_id AND o.current_revision_id <> r.id \
                 JOIN thought_revisions cr ON cr.id = o.current_revision_id WHERE recall_revision_fts MATCH ?1 AND o.project_id = ?2 ORDER BY score ASC, r.seq DESC LIMIT 50"
            ),
        );
        time("SINGLE PASS: current + historical rows together (top 200)", single_pass_sql(200));
        out
    }

    /// Runs the semantic-scan statement (pinned, or the old unpinned form) and reports its plan and SQLite's own work counters.
    #[cfg(test)]
    pub fn recall_semantic_scan_cost_for_test(&self, unpinned: bool, project_id: &str, model_key: &str, dims: usize) -> ScanCost {
        use rusqlite::StatementStatus;
        let sql = if unpinned { SEMANTIC_SCAN_SQL_UNPINNED } else { SEMANTIC_SCAN_SQL };
        let connection = self.connection.lock().unwrap();
        let plan: Vec<String> = {
            let mut statement = connection.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            let rows = statement.query_map(params![model_key, project_id, dims as i64], |row| row.get::<_, String>(3)).unwrap();
            rows.map(|r| r.unwrap()).collect()
        };
        let mut statement = connection.prepare(sql).unwrap();
        let started = std::time::Instant::now();
        let mut rows = statement.query(params![model_key, project_id, dims as i64]).unwrap();
        let mut count = 0;
        while let Some(row) = rows.next().unwrap() {
            assert_eq!(row.get_ref(1).unwrap().as_blob().unwrap().len(), dims * 4);
            count += 1;
        }
        let micros = started.elapsed().as_micros();
        drop(rows);
        ScanCost { plan, vm_steps: statement.get_status(StatementStatus::VmStep), rows: count, micros }
    }

    /// Fault injection for tests (storage owns every schema statement): damages the lexical index or the store in a named way.
    #[cfg(test)]
    pub fn inject_fault_for_test(&self, fault: &str) {
        let sql = match fault {
            // Silent loss: every query answers "no match" without an error.
            "empty-lexical-index" => "INSERT INTO recall_revision_fts(recall_revision_fts) VALUES ('delete-all')",
            // Queries against the index now ERROR.
            "destroy-lexical-index" => "DROP TRIGGER recall_fts_after_revision_insert; DROP TABLE recall_revision_fts_data;",
            // Nothing authoritative is readable.
            "break-authoritative-store" => "ALTER TABLE thought_revisions RENAME TO tr_gone",
            other => panic!("unknown fault {other}"),
        };
        self.connection.lock().unwrap().execute_batch(sql).unwrap();
    }

    /// The query plan of one of the hot statements (tests only): proves which indexes it uses.
    #[cfg(test)]
    pub fn recall_explain_for_test(&self, which: &str, project_id: &str) -> Vec<String> {
        let connection = self.connection.lock().unwrap();
        let (sql, params): (String, Vec<rusqlite::types::Value>) = match which {
            "lexical" => (lexical_current_sql(), vec!["{title body}: (\"x\")".to_string().into(), project_id.to_string().into(), 30i64.into()]),
            "semantic" => (SEMANTIC_SCAN_SQL.to_string(), vec!["k".to_string().into(), project_id.to_string().into(), 4i64.into()]),
            other => panic!("unknown statement {other}"),
        };
        let mut statement = connection.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let rows = statement.query_map(params_from_iter(params), |row| row.get::<_, String>(3)).unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    fn with_connection<T>(&self, work: impl FnOnce(&Connection) -> Result<T, StoreError>) -> Result<T, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        work(&connection)
    }

    /// Lexical hits on CURRENT revisions of objects in `project_id`, best first (bm25: title weighted 8x body).
    ///
    /// `match_expression` must already be a safe FTS5 expression (see `recall::query`). The join goes
    /// revision -> object by primary key and then checks `current_revision_id`, so no table is scanned per hit.
    pub fn recall_lexical_current(&self, match_expression: &str, project_id: &str, limit: usize) -> Result<Vec<CurrentLexicalHit>, StoreError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(&lexical_current_sql())?;
            let rows = statement.query_map(params![match_expression, project_id, limit as i64], |row| {
                Ok(CurrentLexicalHit { object: current_object_from_row(row, 0)?, bm25: row.get(8)? })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// Lexical hits on revisions that are NOT current, one (the best) per object, best first. This is a discovery path only: the
    /// returned object is the CURRENT one and the matched revision is reported separately.
    pub fn recall_lexical_historical(&self, match_expression: &str, project_id: &str, limit: usize) -> Result<Vec<HistoricalLexicalHit>, StoreError> {
        self.with_connection(|connection| {
            // Over-fetch so that several old revisions of one object cannot crowd out other objects before they are collapsed.
            let mut statement = connection.prepare(&format!(
                "SELECT {CURRENT_COLUMNS}, r.id, r.title, r.body, bm25(recall_revision_fts, 8.0, 1.0) AS score \
                 FROM recall_revision_fts \
                 JOIN thought_revisions r ON r.seq = recall_revision_fts.rowid \
                 JOIN knowledge_objects o ON o.id = r.object_id AND o.current_revision_id <> r.id \
                 JOIN thought_revisions cr ON cr.id = o.current_revision_id \
                 WHERE recall_revision_fts MATCH ?1 AND o.project_id = ?2 \
                 ORDER BY score ASC, r.seq DESC LIMIT ?3"
            ))?;
            let rows = statement.query_map(params![match_expression, project_id, (limit * 5) as i64], |row| {
                Ok(HistoricalLexicalHit {
                    object: current_object_from_row(row, 0)?,
                    revision_id: row.get(8)?,
                    revision_title: row.get(9)?,
                    revision_body: row.get(10)?,
                    bm25: row.get(11)?,
                })
            })?;
            let mut seen = std::collections::HashSet::new();
            let mut hits = Vec::new();
            for hit in rows {
                let hit = hit?;
                if seen.insert(hit.object.object_id.clone()) {
                    hits.push(hit);
                    if hits.len() == limit {
                        break;
                    }
                }
            }
            Ok(hits)
        })
    }

    /// Every current object of one project: the lexical FALLBACK (used only when FTS5 itself fails). Bounded by the project.
    pub fn recall_scan_current(&self, project_id: &str) -> Result<Vec<CurrentObject>, StoreError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(&format!(
                "SELECT {CURRENT_COLUMNS} FROM knowledge_objects o JOIN thought_revisions cr ON cr.id = o.current_revision_id \
                 WHERE o.project_id = ?1 ORDER BY o.seq ASC"
            ))?;
            let rows = statement.query_map([project_id], |row| current_object_from_row(row, 0))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// The current objects with these ids that belong to `project_id`, in one statement. Ids outside the project are simply absent.
    pub fn recall_current_objects(&self, object_ids: &[String], project_id: &str) -> Result<Vec<CurrentObject>, StoreError> {
        if object_ids.is_empty() {
            return Ok(Vec::new());
        }
        self.with_connection(|connection| {
            let marks = vec!["?"; object_ids.len()].join(",");
            let mut statement = connection.prepare(&format!(
                "SELECT {CURRENT_COLUMNS} FROM knowledge_objects o JOIN thought_revisions cr ON cr.id = o.current_revision_id \
                 WHERE o.project_id = ? AND o.id IN ({marks})"
            ))?;
            let mut values: Vec<&str> = vec![project_id];
            values.extend(object_ids.iter().map(String::as_str));
            let rows = statement.query_map(params_from_iter(values), |row| current_object_from_row(row, 0))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// Streams the vectors of the objects in `project_id` that are valid for `model_key` (the vector's revision is the object's
    /// CURRENT revision) and keeps the `limit` best by dot product with `query` (vectors are stored L2-normalised, so this is
    /// the cosine). Only rows at or above `min_cosine` are kept. Memory is O(limit), never O(objects). A stale vector is excluded
    /// by the join itself, without any provider call.
    pub fn recall_semantic_scan(&self, project_id: &str, model_key: &str, dims: usize, query: &[f32], limit: usize, min_cosine: f32) -> Result<(Vec<VectorHit>, VectorScan), StoreError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(SEMANTIC_SCAN_SQL)?;
            let mut rows = statement.query(params![model_key, project_id, dims as i64])?;
            let mut heap: BinaryHeap<VectorHit> = BinaryHeap::with_capacity(limit + 1);
            let mut scan = VectorScan::default();
            while let Some(row) = rows.next()? {
                let blob = row.get_ref(1)?.as_blob().map_err(|e| rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Blob, Box::new(e)))?;
                if blob.len() != dims * 4 {
                    scan.skipped_malformed += 1;
                    continue;
                }
                scan.scanned += 1;
                let mut dot = 0.0f32;
                for (chunk, q) in blob.chunks_exact(4).zip(query) {
                    dot += f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) * q;
                }
                if !dot.is_finite() || dot < min_cosine {
                    continue;
                }
                let hit = VectorHit { object_id: row.get(0)?, cosine: dot };
                if heap.len() < limit {
                    heap.push(hit);
                } else if heap.peek().is_some_and(|worst| hit < *worst) {
                    heap.pop();
                    heap.push(hit);
                }
            }
            let mut hits = heap.into_vec();
            // Best first: highest cosine, ties by id for determinism.
            hits.sort_by(|a, b| b.cosine.total_cmp(&a.cosine).then_with(|| a.object_id.cmp(&b.object_id)));
            Ok((hits, scan))
        })
    }

    /// Objects (any project) whose current revision has no vector for `model_key`, oldest first. The work set of the lazy indexer.
    pub fn recall_pending_embeddings(&self, model_key: &str, limit: usize) -> Result<Vec<PendingEmbedding>, StoreError> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT o.id, o.current_revision_id, o.kind, o.title, o.body FROM knowledge_objects o \
                 LEFT JOIN recall_embeddings e ON e.object_id = o.id AND e.model_key = ?1 \
                 WHERE e.object_id IS NULL OR e.revision_id <> o.current_revision_id \
                 ORDER BY o.seq ASC LIMIT ?2",
            )?;
            let rows = statement.query_map(params![model_key, limit as i64], |row| {
                Ok(PendingEmbedding { object_id: row.get(0)?, revision_id: row.get(1)?, kind: row.get(2)?, title: row.get(3)?, body: row.get(4)? })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// How many objects still lack a valid vector for `model_key`.
    pub fn recall_pending_count(&self, model_key: &str) -> Result<i64, StoreError> {
        self.with_connection(|connection| {
            Ok(connection.query_row(
                "SELECT count(*) FROM knowledge_objects o LEFT JOIN recall_embeddings e ON e.object_id = o.id AND e.model_key = ?1 \
                 WHERE e.object_id IS NULL OR e.revision_id <> o.current_revision_id",
                [model_key],
                |row| row.get(0),
            )?)
        })
    }

    /// Hash of the embedded text of the vector currently stored for this object and key (if any).
    pub fn recall_stored_text_hash(&self, object_id: &str, model_key: &str) -> Result<Option<String>, StoreError> {
        self.with_connection(|connection| {
            Ok(connection.query_row("SELECT text_hash FROM recall_embeddings WHERE object_id = ?1 AND model_key = ?2", params![object_id, model_key], |row| row.get(0)).optional()?)
        })
    }

    /// Stores a vector, but ONLY if `revision_id` is still the object's current revision (compare-and-set), so a vector computed
    /// for text that changed meanwhile is never recorded as valid. Returns whether it was stored.
    pub fn recall_put_embedding(&self, object_id: &str, model_key: &str, revision_id: &str, dims: usize, vector: &[f32], text_hash: &str) -> Result<bool, StoreError> {
        let created_at = now_rfc3339()?;
        self.with_connection(|connection| {
            let changed = connection.execute(
                "INSERT OR REPLACE INTO recall_embeddings (object_id, model_key, revision_id, dims, vector, text_hash, created_at) \
                 SELECT o.id, ?2, ?3, ?4, ?5, ?6, ?7 FROM knowledge_objects o WHERE o.id = ?1 AND o.current_revision_id = ?3",
                params![object_id, model_key, revision_id, dims as i64, encode_vector(vector), text_hash, created_at],
            )?;
            Ok(changed == 1)
        })
    }

    /// Re-points an existing vector at a new current revision whose embedded text is byte-identical (no provider call needed).
    pub fn recall_adopt_revision(&self, object_id: &str, model_key: &str, revision_id: &str) -> Result<bool, StoreError> {
        self.with_connection(|connection| {
            let changed = connection.execute(
                "UPDATE recall_embeddings SET revision_id = ?3 WHERE object_id = ?1 AND model_key = ?2 \
                 AND EXISTS (SELECT 1 FROM knowledge_objects o WHERE o.id = ?1 AND o.current_revision_id = ?3)",
                params![object_id, model_key, revision_id],
            )?;
            Ok(changed == 1)
        })
    }

    /// Deletes every stored vector (all model keys). Returns how many rows were removed. Authoritative data is untouched.
    pub fn recall_purge_embeddings(&self) -> Result<usize, StoreError> {
        self.with_connection(|connection| Ok(connection.execute("DELETE FROM recall_embeddings", [])?))
    }

    /// In-scope objects and how many of them have a VALID vector for `model_key`.
    pub fn recall_semantic_coverage(&self, project_id: &str, model_key: &str) -> Result<SemanticCoverage, StoreError> {
        self.with_connection(|connection| {
            let (in_scope, embedded): (i64, i64) = connection.query_row(
                "SELECT count(*), count(e.object_id) FROM knowledge_objects o \
                 LEFT JOIN recall_embeddings e ON e.object_id = o.id AND e.model_key = ?1 AND e.revision_id = o.current_revision_id \
                 WHERE o.project_id = ?2",
                params![model_key, project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            Ok(SemanticCoverage { in_scope_objects: in_scope, embedded_objects: embedded })
        })
    }

    /// How many vectors exist for `model_key` regardless of validity (diagnostics and tests).
    pub fn recall_stored_vector_count(&self, model_key: Option<&str>) -> Result<i64, StoreError> {
        self.with_connection(|connection| {
            Ok(match model_key {
                Some(key) => connection.query_row("SELECT count(*) FROM recall_embeddings WHERE model_key = ?1", [key], |row| row.get(0))?,
                None => connection.query_row("SELECT count(*) FROM recall_embeddings", [], |row| row.get(0))?,
            })
        })
    }

    /// Regenerates the lexical index from `thought_revisions`. Safe at any time; authoritative data is untouched.
    pub fn recall_rebuild_lexical_index(&self) -> Result<(), StoreError> {
        self.with_connection(|connection| {
            connection.execute("INSERT INTO recall_revision_fts(recall_revision_fts) VALUES ('rebuild')", [])?;
            Ok(())
        })
    }

    #[cfg(test)]
    /// FTS5's own consistency check between the index and its content table. `Err` means the index is not trustworthy.
    pub fn recall_check_lexical_index(&self) -> Result<(), StoreError> {
        self.with_connection(|connection| {
            connection.execute("INSERT INTO recall_revision_fts(recall_revision_fts, rank) VALUES ('integrity-check', 1)", [])?;
            Ok(())
        })
    }

    /// Whether the lexical index covers exactly the revisions that exist. An EMPTIED or truncated index answers every query with
    /// "no match" and no error, so this is how silent loss is noticed (two counts, cheap).
    pub fn recall_lexical_index_is_complete(&self) -> Result<bool, StoreError> {
        self.with_connection(|connection| {
            let (indexed, revisions): (i64, i64) = connection.query_row(
                "SELECT (SELECT count(*) FROM recall_revision_fts_docsize), (SELECT count(*) FROM thought_revisions)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            Ok(indexed == revisions)
        })
    }

    #[cfg(test)]
    /// Number of rows in the FTS index (equals the number of revisions when healthy).
    pub fn recall_indexed_revision_count(&self) -> Result<i64, StoreError> {
        self.with_connection(|connection| Ok(connection.query_row("SELECT count(*) FROM recall_revision_fts_docsize", [], |row| row.get(0))?))
    }
}
