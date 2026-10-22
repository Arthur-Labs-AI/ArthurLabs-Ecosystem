//! Dormant native historical snapshot capture, packing and verification.
//!
//! A snapshot freezes one consistent image of the twelve replicated
//! projections plus origin, facet-head and retained journal-core metadata
//! under a single `BEGIN IMMEDIATE` transaction. Packing turns the immutable
//! staged rows into deterministic bounded chunks plus a manifest; a later
//! local mutation only appears in subsequent journal catch-up, never in the
//! packed image. No network transmission or incoming import lives here.
//!
//! Bounds (initial candidate policy): 32 MiB logical image, 20 000 records,
//! 256 KiB per staged row, 128 KiB raw whole-core fragment target (stored as
//! hex with JSON envelope under the row bound), 64 KiB chunk target, at most
//! one admitted non-aborted snapshot, and a measured capture watchdog.
//! Every bound is enforced in code with a typed error; the SQL CHECKs are
//! only a backstop.
use super::codec::{self, EntityKind};
use super::sql_effects::{self as sql};
type Result<T> = std::result::Result<T, SnapshotError>;
use rusqlite::{params, Connection};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

pub(super) const SNAPSHOT_PROFILE: &str = "knowledge-v1-full";
pub(super) const CODEC_VERSION: u32 = 1;
pub(super) const MAX_SNAPSHOT_BYTES: u64 = 32 * 1024 * 1024;
pub(super) const MAX_SNAPSHOT_RECORDS: usize = 20_000;
pub(super) const MAX_ROW_BYTES: usize = 256 * 1024;
pub(super) const FRAGMENT_TARGET: usize = 120 * 1024;
pub(super) const CHUNK_TARGET: usize = 64 * 1024;
pub(super) const DEFAULT_CAPTURE_TIMEOUT_SECS: u64 = 2;

#[derive(Clone, Copy)]
pub(super) struct SnapshotPolicy {
    pub max_bytes: u64,
    pub max_records: usize,
    pub max_row_bytes: usize,
    pub capture_timeout: Duration,
}
impl SnapshotPolicy {
    pub fn candidate() -> Self {
        Self {
            max_bytes: MAX_SNAPSHOT_BYTES,
            max_records: MAX_SNAPSHOT_RECORDS,
            max_row_bytes: MAX_ROW_BYTES,
            capture_timeout: Duration::from_secs(DEFAULT_CAPTURE_TIMEOUT_SECS),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SnapshotError {
    WrongSchema,
    Unavailable,
    Sql,
    Exists,
    Limit,
    Timeout,
    Corrupt,
    Incomplete,
    State,
}
impl std::fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "snapshot {self:?}")
    }
}
impl std::error::Error for SnapshotError {}
impl From<rusqlite::Error> for SnapshotError {
    fn from(error: rusqlite::Error) -> Self {
        match error {
            rusqlite::Error::SqliteFailure(_, Some(detail))
                if detail.starts_with("CHECK constraint failed") =>
            {
                Self::Limit
            }
            _ => Self::Sql,
        }
    }
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn check_timeout(start: &Instant, timeout: Duration) -> Result<()> {
    if start.elapsed() >= timeout {
        return Err(SnapshotError::Timeout);
    }
    Ok(())
}

fn ensure_version(c: &Connection) -> Result<()> {
    if c.is_autocommit() {
        return Err(SnapshotError::Unavailable);
    }
    let version: i64 = c
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|_| SnapshotError::WrongSchema)?;
    if version != 10 {
        return Err(SnapshotError::WrongSchema);
    }
    Ok(())
}

fn admitted(c: &Connection) -> Result<()> {
    let live: i64 = c
        .query_row(
            "SELECT count(*) FROM sync_snapshots WHERE state <> 'aborted'",
            [],
            |r| r.get(0),
        )
        .map_err(|_| SnapshotError::Sql)?;
    if live != 0 {
        return Err(SnapshotError::Exists);
    }
    Ok(())
}

fn snapshot_state(c: &Connection, snapshot_id: &str) -> Result<Option<String>> {
    c.query_row(
        "SELECT state FROM sync_snapshots WHERE snapshot_id = ?1",
        [snapshot_id],
        |r| r.get(0),
    )
    .map_err(|_| SnapshotError::Sql)
    .map(Some)
    .or(Ok(None))
}

/// Allocate a pending snapshot. Exactly one non-aborted snapshot is
/// admitted by the initial policy; retry only after aborting the stale one.
pub(super) fn allocate(c: &Connection, snapshot_id: &str, now: &str) -> Result<()> {
    ensure_version(c)?;
    codec::validate_canonical_uuid(snapshot_id).map_err(|_| SnapshotError::Corrupt)?;
    codec::validate_timestamp(now).map_err(|_| SnapshotError::Corrupt)?;
    admitted(c)?;
    c.execute(
        "INSERT INTO sync_snapshots(snapshot_id,state,profile,requested_at) VALUES(?1,'pending',?2,?3)",
        params![snapshot_id, SNAPSHOT_PROFILE, now],
    )
    .map_err(|_| SnapshotError::Sql)?;
    Ok(())
}

/// Mark a pending or materialized snapshot aborted. Retained staged rows of
/// an aborted snapshot may be deleted; the snapshot row itself is kept.
pub(super) fn abort(c: &Connection, snapshot_id: &str) -> Result<()> {
    ensure_version(c)?;
    let changed = c
        .execute(
            "UPDATE sync_snapshots SET state='aborted' WHERE snapshot_id=?1 AND state IN ('pending','materialized')",
            [snapshot_id],
        )
        .map_err(|_| SnapshotError::Sql)?;
    if changed != 1 {
        return Err(SnapshotError::State);
    }
    c.execute(
        "DELETE FROM sync_snapshot_rows WHERE snapshot_id=?1",
        [snapshot_id],
    )
    .map_err(|_| SnapshotError::Sql)?;
    Ok(())
}

fn value_json(value: rusqlite::types::Value) -> Result<serde_json::Value> {
    match value {
        rusqlite::types::Value::Null => Ok(serde_json::Value::Null),
        rusqlite::types::Value::Integer(n) => Ok(serde_json::Value::from(n)),
        rusqlite::types::Value::Real(x) if x.is_finite() => Ok(serde_json::Number::from_f64(x)
            .map_or(serde_json::Value::Null, serde_json::Value::Number)),
        rusqlite::types::Value::Text(s) => Ok(serde_json::Value::String(s)),
        rusqlite::types::Value::Blob(b) => {
            Ok(serde_json::Value::String(codec::hash_hex(&sha256(&b))))
        }
        other => Err(SnapshotError::Corrupt),
    }
}

fn canonical_json(fields: &BTreeMap<String, serde_json::Value>) -> Result<Vec<u8>> {
    serde_jcs::to_vec(fields).map_err(|_| SnapshotError::Corrupt)
}

struct Staged {
    ordinal: i64,
    entity_kind: String,
    entity_key: String,
    row_bytes: Vec<u8>,
    row_hash: [u8; 32],
}

fn push_row(
    staged: &mut Vec<Staged>,
    policy: SnapshotPolicy,
    entity_kind: &str,
    entity_key: &str,
    row_bytes: Vec<u8>,
) -> Result<()> {
    if staged.len() >= policy.max_records || row_bytes.len() > policy.max_row_bytes {
        return Err(SnapshotError::Limit);
    }
    let row_hash = sha256(&row_bytes);
    staged.push(Staged {
        ordinal: staged.len() as i64,
        entity_kind: entity_kind.into(),
        entity_key: entity_key.into(),
        row_bytes,
        row_hash,
    });
    Ok(())
}

fn key_json(key: &[String]) -> Result<String> {
    String::from_utf8(serde_jcs::to_vec(key).map_err(|_| SnapshotError::Corrupt)?)
        .map_err(|_| SnapshotError::Corrupt)
}

/// Read one replicated projection in deterministic key order.
fn projection_rows(
    c: &Connection,
    entity: EntityKind,
    staged: &mut Vec<Staged>,
    policy: SnapshotPolicy,
    start: &Instant,
) -> Result<()> {
    let order = entity.key_fields().join(",");
    let mut q = c
        .prepare(&format!(
            "SELECT * FROM {} ORDER BY {}",
            entity.as_str(),
            order
        ))
        .map_err(|_| SnapshotError::Sql)?;
    let names: Vec<String> = q.column_names().into_iter().map(str::to_owned).collect();
    let mut rows = q.query([]).map_err(|_| SnapshotError::Sql)?;
    while let Some(row) = rows.next().map_err(|_| SnapshotError::Sql)? {
        let mut fields: BTreeMap<String, serde_json::Value> = BTreeMap::new();
        let mut key = Vec::new();
        for (i, name) in names.iter().enumerate() {
            let value: rusqlite::types::Value = row.get(i).map_err(|_| SnapshotError::Sql)?;
            if entity.key_fields().contains(&name.as_str()) {
                key.push(match &value {
                    rusqlite::types::Value::Integer(n) => n.to_string(),
                    rusqlite::types::Value::Text(s) => s.clone(),
                    _ => return Err(SnapshotError::Corrupt),
                });
            }
            fields.insert(name.clone(), value_json(value)?);
        }
        if key.len() != entity.key_fields().len() {
            return Err(SnapshotError::Incomplete);
        }
        let row_bytes = canonical_json(&fields)?;
        push_row(staged, policy, entity.as_str(), &key_json(&key)?, row_bytes)?;
        if staged.len() % 64 == 0 {
            check_timeout(start, policy.capture_timeout)?;
        }
    }
    Ok(())
}

fn origin_rows(
    c: &Connection,
    staged: &mut Vec<Staged>,
    policy: SnapshotPolicy,
    start: &Instant,
) -> Result<Vec<serde_json::Value>> {
    let mut q = c.prepare("SELECT origin_id,incarnation,status,opened_at,sealed_at,last_seq,last_hash FROM sync_origins ORDER BY origin_id,incarnation").map_err(|_| SnapshotError::Sql)?;
    let mut rows = q.query([]).map_err(|_| SnapshotError::Sql)?;
    let mut origins = Vec::new();
    while let Some(r) = rows.next().map_err(|_| SnapshotError::Sql)? {
        let origin_id: String = r.get(0).map_err(|_| SnapshotError::Sql)?;
        let incarnation: String = r.get(1).map_err(|_| SnapshotError::Sql)?;
        let status: String = r.get(2).map_err(|_| SnapshotError::Sql)?;
        let opened: String = r.get(3).map_err(|_| SnapshotError::Sql)?;
        let sealed: Option<String> = r.get(4).map_err(|_| SnapshotError::Sql)?;
        let seq: i64 = r.get(5).map_err(|_| SnapshotError::Sql)?;
        let hash: Vec<u8> = r.get(6).map_err(|_| SnapshotError::Sql)?;
        codec::validate_canonical_uuid(&origin_id).map_err(|_| SnapshotError::Corrupt)?;
        codec::validate_canonical_uuid(&incarnation).map_err(|_| SnapshotError::Corrupt)?;
        let mut fields: BTreeMap<String, serde_json::Value> = BTreeMap::new();
        fields.insert(
            "originId".into(),
            serde_json::Value::String(origin_id.clone()),
        );
        fields.insert(
            "incarnation".into(),
            serde_json::Value::String(incarnation.clone()),
        );
        fields.insert("status".into(), serde_json::Value::String(status.clone()));
        fields.insert("openedAt".into(), serde_json::Value::String(opened));
        fields.insert(
            "sealedAt".into(),
            sealed.map_or(serde_json::Value::Null, serde_json::Value::String),
        );
        fields.insert("lastSeq".into(), serde_json::Value::from(seq));
        fields.insert(
            "lastHash".into(),
            serde_json::Value::String(hex_encode(&hash)),
        );
        origins.push(serde_json::Value::Object(
            fields.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        ));
        push_row(
            staged,
            policy,
            "@origin",
            &key_json(&[origin_id, incarnation])?,
            canonical_json(&fields)?,
        )?;
        check_timeout(start, policy.capture_timeout)?;
    }
    Ok(origins)
}

fn facet_rows(
    c: &Connection,
    staged: &mut Vec<Staged>,
    policy: SnapshotPolicy,
    start: &Instant,
) -> Result<Vec<String>> {
    let mut q = c.prepare("SELECT entity_kind,entity_key,facet,event_id,state_hash FROM sync_entity_heads ORDER BY entity_kind,entity_key,facet").map_err(|_| SnapshotError::Sql)?;
    let mut rows = q.query([]).map_err(|_| SnapshotError::Sql)?;
    let mut lines = Vec::new();
    while let Some(r) = rows.next().map_err(|_| SnapshotError::Sql)? {
        let entity: String = r.get(0).map_err(|_| SnapshotError::Sql)?;
        let key: String = r.get(1).map_err(|_| SnapshotError::Sql)?;
        let facet: String = r.get(2).map_err(|_| SnapshotError::Sql)?;
        let event: String = r.get(3).map_err(|_| SnapshotError::Sql)?;
        let hash: Vec<u8> = r.get(4).map_err(|_| SnapshotError::Sql)?;
        lines.push(format!(
            "{entity}|{key}|{facet}|{event}|{}",
            hex_encode(&hash)
        ));
        let mut fields: BTreeMap<String, serde_json::Value> = BTreeMap::new();
        fields.insert("eventId".into(), serde_json::Value::String(event));
        fields.insert(
            "stateHash".into(),
            serde_json::Value::String(hex_encode(&hash)),
        );
        push_row(
            staged,
            policy,
            "@facet",
            &key_json(&[entity, key, facet])?,
            canonical_json(&fields)?,
        )?;
        if staged.len() % 64 == 0 {
            check_timeout(start, policy.capture_timeout)?;
        }
    }
    Ok(lines)
}

struct BundleCover {
    event_id: String,
    bytes: usize,
    hash: [u8; 32],
}

fn bundle_rows(
    c: &Connection,
    staged: &mut Vec<Staged>,
    policy: SnapshotPolicy,
    start: &Instant,
) -> Result<Vec<BundleCover>> {
    let mut q = c.prepare("SELECT event_id,bundle_id,origin_id,incarnation,origin_seq,canonical_bytes,canonical_hash,previous_hash,raw_effect_count,committed_at FROM sync_bundles ORDER BY rowid").map_err(|_| SnapshotError::Sql)?;
    let mut rows = q.query([]).map_err(|_| SnapshotError::Sql)?;
    let mut covered = Vec::new();
    while let Some(r) = rows.next().map_err(|_| SnapshotError::Sql)? {
        let event: String = r.get(0).map_err(|_| SnapshotError::Sql)?;
        let bundle: String = r.get(1).map_err(|_| SnapshotError::Sql)?;
        let origin: String = r.get(2).map_err(|_| SnapshotError::Sql)?;
        let incarnation: String = r.get(3).map_err(|_| SnapshotError::Sql)?;
        let seq: i64 = r.get(4).map_err(|_| SnapshotError::Sql)?;
        let bytes: Vec<u8> = r.get(5).map_err(|_| SnapshotError::Sql)?;
        let stored_hash: Vec<u8> = r.get(6).map_err(|_| SnapshotError::Sql)?;
        let previous: Vec<u8> = r.get(7).map_err(|_| SnapshotError::Sql)?;
        let raw: i64 = r.get(8).map_err(|_| SnapshotError::Sql)?;
        let committed: String = r.get(9).map_err(|_| SnapshotError::Sql)?;
        let whole = codec::journal_event_hash(&bytes);
        if stored_hash != whole.to_vec() {
            return Err(SnapshotError::Corrupt);
        }
        covered.push(BundleCover {
            event_id: event.clone(),
            bytes: bytes.len(),
            hash: whole,
        });
        let mut header = BTreeMap::new();
        header.insert("bundleId".into(), serde_json::Value::String(bundle));
        header.insert("originId".into(), serde_json::Value::String(origin));
        header.insert(
            "originIncarnation".into(),
            serde_json::Value::String(incarnation),
        );
        header.insert("originSeq".into(), serde_json::Value::from(seq));
        header.insert(
            "previousHash".into(),
            serde_json::Value::String(hex_encode(&previous)),
        );
        header.insert("rawEffectCount".into(), serde_json::Value::from(raw));
        header.insert("committedAt".into(), serde_json::Value::String(committed));
        header.insert(
            "wholeHash".into(),
            serde_json::Value::String(codec::hash_hex(&whole)),
        );
        let fragments: Vec<&[u8]> = bytes.chunks(FRAGMENT_TARGET).collect();
        header.insert(
            "fragmentCount".into(),
            serde_json::Value::from(fragments.len() as i64),
        );
        push_row(
            staged,
            policy,
            "@bundle",
            &key_json(&[event.clone()])?,
            canonical_json(&header)?,
        )?;
        for (index, fragment) in fragments.iter().enumerate() {
            let mut fields: BTreeMap<String, serde_json::Value> = BTreeMap::new();
            fields.insert(
                "fragmentIndex".into(),
                serde_json::Value::from(index as i64),
            );
            fields.insert(
                "fragmentCount".into(),
                serde_json::Value::from(fragments.len() as i64),
            );
            fields.insert(
                "fragmentHex".into(),
                serde_json::Value::String(hex_encode(fragment)),
            );
            fields.insert(
                "wholeHash".into(),
                serde_json::Value::String(codec::hash_hex(&whole)),
            );
            push_row(
                staged,
                policy,
                "@bundle",
                &key_json(&[event.clone(), index.to_string()])?,
                canonical_json(&fields)?,
            )?;
        }
        check_timeout(start, policy.capture_timeout)?;
    }
    Ok(covered)
}

pub(super) struct SnapshotSummary {
    pub row_count: usize,
    pub total_bytes: u64,
}

/// Capture one consistent image: enumerate every projection and metadata
/// family in deterministic order, validate closure, persist immutable
/// staged rows, then transition pending -> materialized with the boundary.
/// All-or-nothing inside the caller's transaction.
pub(super) fn capture(
    c: &Connection,
    snapshot_id: &str,
    policy: SnapshotPolicy,
    now: &str,
) -> Result<SnapshotSummary> {
    ensure_version(c)?;
    codec::validate_timestamp(now).map_err(|_| SnapshotError::Corrupt)?;
    match snapshot_state(c, snapshot_id)? {
        Some(state) if state == "pending" => {}
        _ => return Err(SnapshotError::State),
    }
    let start = Instant::now();
    let mut staged: Vec<Staged> = Vec::new();
    for entity in sql::ENTITIES {
        projection_rows(c, entity, &mut staged, policy, &start)?;
    }

    let origins = origin_rows(c, &mut staged, policy, &start)?;

    let head_lines = facet_rows(c, &mut staged, policy, &start)?;

    let _covered = bundle_rows(c, &mut staged, policy, &start)?;
    check_timeout(&start, policy.capture_timeout)?;
    if staged.len() > policy.max_records {
        return Err(SnapshotError::Limit);
    }
    let total_bytes: u64 = staged.iter().map(|s| s.row_bytes.len() as u64).sum();
    if total_bytes > policy.max_bytes {
        return Err(SnapshotError::Limit);
    }
    let mut heads_digest = String::new();
    for line in &head_lines {
        heads_digest.push_str(line);
        heads_digest.push('\n');
    }
    let heads_digest = codec::hash_hex(&sha256(heads_digest.as_bytes()));
    let mut boundary = BTreeMap::new();
    boundary.insert(
        "profile".into(),
        serde_json::Value::String(SNAPSHOT_PROFILE.into()),
    );
    boundary.insert(
        "codecVersion".into(),
        serde_json::Value::from(CODEC_VERSION),
    );
    boundary.insert("origins".into(), serde_json::Value::Array(origins));
    boundary.insert(
        "headCount".into(),
        serde_json::Value::from(head_lines.len() as i64),
    );
    boundary.insert(
        "headsDigest".into(),
        serde_json::Value::String(heads_digest),
    );
    boundary.insert(
        "rowCount".into(),
        serde_json::Value::from(staged.len() as i64),
    );
    boundary.insert("totalBytes".into(), serde_json::Value::from(total_bytes));
    let boundary_bytes = canonical_json(&boundary)?;
    for s in &staged {
        c.execute(
            "INSERT INTO sync_snapshot_rows(snapshot_id,ordinal,entity_kind,entity_key,row_bytes,row_hash) VALUES(?1,?2,?3,?4,?5,?6)",
            params![snapshot_id, s.ordinal, s.entity_kind, s.entity_key, s.row_bytes, s.row_hash.as_slice()],
        )
        .map_err(|_| SnapshotError::Sql)?;
    }
    let changed = c.execute(
        "UPDATE sync_snapshots SET state='materialized',boundary_bytes=?2,row_count=?3,total_bytes=?4 WHERE snapshot_id=?1 AND state='pending'",
        params![snapshot_id, boundary_bytes, staged.len() as i64, total_bytes as i64],
    ).map_err(|_| SnapshotError::Sql)?;
    if changed != 1 {
        return Err(SnapshotError::State);
    }
    Ok(SnapshotSummary {
        row_count: staged.len(),
        total_bytes,
    })
}

struct Chunk {
    index: usize,
    first_ordinal: i64,
    count: usize,
    bytes: u64,
    hash: [u8; 32],
}

fn chunk_staged(rows: &[(i64, Vec<u8>, [u8; 32])]) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut index = 0usize;
    let mut first = 0i64;
    let mut count = 0usize;
    let mut bytes = 0u64;
    let mut acc = Vec::new();
    for (ordinal, row_bytes, row_hash) in rows {
        if count > 0 && bytes + row_bytes.len() as u64 > CHUNK_TARGET as u64 {
            chunks.push(Chunk {
                index,
                first_ordinal: first,
                count,
                bytes,
                hash: sha256(&acc),
            });
            index += 1;
            first = *ordinal;
            count = 0;
            bytes = 0;
            acc.clear();
        }
        if count == 0 {
            first = *ordinal;
        }
        bytes += row_bytes.len() as u64;
        acc.extend_from_slice(row_hash);
        count += 1;
    }
    if count > 0 {
        chunks.push(Chunk {
            index,
            first_ordinal: first,
            count,
            bytes,
            hash: sha256(&acc),
        });
    }
    chunks
}

struct LoadedSnapshot {
    boundary_bytes: Vec<u8>,
    row_count: i64,
    total_bytes: i64,
    rows: Vec<(i64, String, String, Vec<u8>, [u8; 32])>,
}

fn load_staged(c: &Connection, snapshot_id: &str) -> Result<LoadedSnapshot> {
    let (boundary_bytes, row_count, total_bytes): (Vec<u8>, i64, i64) = c
        .query_row(
            "SELECT boundary_bytes,row_count,total_bytes FROM sync_snapshots WHERE snapshot_id=?1",
            [snapshot_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| SnapshotError::Sql)?;
    let mut q = c.prepare("SELECT ordinal,entity_kind,entity_key,row_bytes,row_hash FROM sync_snapshot_rows WHERE snapshot_id=?1 ORDER BY ordinal").map_err(|_| SnapshotError::Sql)?;
    let mut rows = q.query([snapshot_id]).map_err(|_| SnapshotError::Sql)?;
    let mut out = Vec::new();
    while let Some(r) = rows.next().map_err(|_| SnapshotError::Sql)? {
        let ordinal: i64 = r.get(0).map_err(|_| SnapshotError::Sql)?;
        let entity_kind: String = r.get(1).map_err(|_| SnapshotError::Sql)?;
        let entity_key: String = r.get(2).map_err(|_| SnapshotError::Sql)?;
        let row_bytes: Vec<u8> = r.get(3).map_err(|_| SnapshotError::Sql)?;
        let row_hash: Vec<u8> = r.get(4).map_err(|_| SnapshotError::Sql)?;
        if row_hash.len() != 32 {
            return Err(SnapshotError::Corrupt);
        }
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&row_hash);
        if sha256(&row_bytes) != hash {
            return Err(SnapshotError::Corrupt);
        }
        out.push((ordinal, entity_kind, entity_key, row_bytes, hash));
    }
    Ok(LoadedSnapshot {
        boundary_bytes,
        row_count,
        total_bytes,
        rows: out,
    })
}

fn build_manifest(snapshot_id: &str, loaded: &LoadedSnapshot) -> Result<(Vec<u8>, [u8; 32])> {
    if loaded.rows.len() as i64 != loaded.row_count {
        return Err(SnapshotError::Incomplete);
    }
    let total: u64 = loaded
        .rows
        .iter()
        .map(|(_, _, _, b, _)| b.len() as u64)
        .sum();
    if total as i64 != loaded.total_bytes {
        return Err(SnapshotError::Incomplete);
    }
    let mut ordinals_ok = true;
    for (i, (ordinal, _, _, _, _)) in loaded.rows.iter().enumerate() {
        if *ordinal != i as i64 {
            ordinals_ok = false;
        }
    }
    if !ordinals_ok {
        return Err(SnapshotError::Incomplete);
    }
    let mut rows_concat = Vec::new();
    for (_, _, _, _, hash) in &loaded.rows {
        rows_concat.extend_from_slice(hash);
    }
    let rows_hash = sha256(&rows_concat);
    let row_inputs: Vec<(i64, Vec<u8>, [u8; 32])> = loaded
        .rows
        .iter()
        .map(|(o, _, _, b, h)| (*o, b.clone(), *h))
        .collect();
    let chunks = chunk_staged(&row_inputs);
    let mut chunk_values = Vec::new();
    for chunk in &chunks {
        let mut entry = BTreeMap::new();
        entry.insert("index".into(), serde_json::Value::from(chunk.index as i64));
        entry.insert(
            "firstOrdinal".into(),
            serde_json::Value::from(chunk.first_ordinal),
        );
        entry.insert("count".into(), serde_json::Value::from(chunk.count as i64));
        entry.insert("bytes".into(), serde_json::Value::from(chunk.bytes));
        entry.insert(
            "hash".into(),
            serde_json::Value::String(codec::hash_hex(&chunk.hash)),
        );
        chunk_values.push(serde_json::Value::Object(entry.into_iter().collect()));
    }
    let mut covers = Vec::new();
    for (_, entity_kind, entity_key, row_bytes, _) in &loaded.rows {
        if entity_kind != "@bundle" {
            continue;
        }
        let key: Vec<String> =
            serde_json::from_slice(entity_key.as_bytes()).map_err(|_| SnapshotError::Corrupt)?;
        if key.len() != 1 {
            continue;
        }
        let header: BTreeMap<String, serde_json::Value> =
            serde_json::from_slice(row_bytes).map_err(|_| SnapshotError::Corrupt)?;
        let mut entry = BTreeMap::new();
        entry.insert("eventId".into(), serde_json::Value::String(key[0].clone()));
        for field in [
            "bundleId",
            "originSeq",
            "rawEffectCount",
            "committedAt",
            "wholeHash",
            "fragmentCount",
        ] {
            let value = header
                .get(field)
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            entry.insert(field.into(), value);
        }
        let whole: String = header
            .get("wholeHash")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .into();
        entry.insert(
            "bytes".into(),
            serde_json::Value::from(bundle_bytes_for(&loaded.rows, &key[0])? as i64),
        );
        entry.insert("hash".into(), serde_json::Value::String(whole));
        covers.push(serde_json::Value::Object(entry.into_iter().collect()));
    }
    let mut manifest = BTreeMap::new();
    manifest.insert(
        "snapshotId".into(),
        serde_json::Value::String(snapshot_id.into()),
    );
    manifest.insert(
        "profile".into(),
        serde_json::Value::String(SNAPSHOT_PROFILE.into()),
    );
    manifest.insert(
        "codecVersion".into(),
        serde_json::Value::from(CODEC_VERSION),
    );
    manifest.insert(
        "boundaryHash".into(),
        serde_json::Value::String(codec::hash_hex(&sha256(&loaded.boundary_bytes))),
    );
    manifest.insert("rowCount".into(), serde_json::Value::from(loaded.row_count));
    manifest.insert(
        "totalBytes".into(),
        serde_json::Value::from(loaded.total_bytes),
    );
    manifest.insert(
        "rowsHash".into(),
        serde_json::Value::String(codec::hash_hex(&rows_hash)),
    );
    manifest.insert("chunks".into(), serde_json::Value::Array(chunk_values));
    manifest.insert("coveredCores".into(), serde_json::Value::Array(covers));
    let mut closure_input = Vec::new();
    closure_input.extend_from_slice(&rows_hash);
    closure_input.extend_from_slice(&sha256(&loaded.boundary_bytes));
    manifest.insert(
        "closureDigest".into(),
        serde_json::Value::String(codec::hash_hex(&sha256(&closure_input))),
    );
    let manifest_bytes = canonical_json(&manifest)?;
    if manifest_bytes.len() > MAX_ROW_BYTES {
        return Err(SnapshotError::Limit);
    }
    let manifest_hash = sha256(&manifest_bytes);
    Ok((manifest_bytes, manifest_hash))
}

/// Pack staged rows into a deterministic manifest and transition
/// materialized -> ready. Reads staged rows only, never live domain rows.
pub(super) fn pack(c: &Connection, snapshot_id: &str) -> Result<()> {
    ensure_version(c)?;
    match snapshot_state(c, snapshot_id)? {
        Some(state) if state == "materialized" => {}
        _ => return Err(SnapshotError::State),
    }
    let loaded = load_staged(c, snapshot_id)?;
    let (manifest_bytes, manifest_hash) = build_manifest(snapshot_id, &loaded)?;
    let changed = c.execute(
        "UPDATE sync_snapshots SET state='ready',manifest_bytes=?2,manifest_hash=?3 WHERE snapshot_id=?1 AND state='materialized'",
        params![snapshot_id, manifest_bytes, manifest_hash.as_slice()],
    ).map_err(|_| SnapshotError::Sql)?;
    if changed != 1 {
        return Err(SnapshotError::State);
    }
    Ok(())
}

/// Recompute the manifest from staged rows and compare byte-for-byte.
/// Detects invalid row hashes, missing/extra rows, truncated cores and
/// digest mismatches without touching live domain tables.
pub(super) fn verify_manifest(c: &Connection, snapshot_id: &str) -> Result<()> {
    ensure_version(c)?;
    let (manifest_bytes, manifest_hash): (Option<Vec<u8>>, Option<Vec<u8>>) = c
        .query_row(
            "SELECT manifest_bytes,manifest_hash FROM sync_snapshots WHERE snapshot_id=?1",
            [snapshot_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| SnapshotError::Sql)?;
    let (manifest_bytes, manifest_hash) = match (manifest_bytes, manifest_hash) {
        (Some(b), Some(h)) => (b, h),
        _ => return Err(SnapshotError::State),
    };
    if manifest_hash.len() != 32 || sha256(&manifest_bytes).to_vec() != manifest_hash {
        return Err(SnapshotError::Corrupt);
    }
    let loaded = load_staged(c, snapshot_id)?;
    let (rebuilt, rebuilt_hash) = build_manifest(snapshot_id, &loaded)?;
    if rebuilt != manifest_bytes || rebuilt_hash.to_vec() != manifest_hash {
        return Err(SnapshotError::Corrupt);
    }
    Ok(())
}
fn bundle_bytes_for(
    rows: &[(i64, String, String, Vec<u8>, [u8; 32])],
    event_id: &str,
) -> Result<usize> {
    let mut total = 0usize;
    let mut seen = 0usize;
    for (_, entity_kind, entity_key, row_bytes, _) in rows {
        if entity_kind != "@bundle" {
            continue;
        }
        let key: Vec<String> =
            serde_json::from_slice(entity_key.as_bytes()).map_err(|_| SnapshotError::Corrupt)?;
        if key.first().map(String::as_str) != Some(event_id) || key.len() != 2 {
            continue;
        }
        let fields: BTreeMap<String, serde_json::Value> =
            serde_json::from_slice(row_bytes).map_err(|_| SnapshotError::Corrupt)?;
        let hex = fields
            .get("fragmentHex")
            .and_then(|v| v.as_str())
            .ok_or(SnapshotError::Corrupt)?;
        if hex.len() % 2 != 0 {
            return Err(SnapshotError::Corrupt);
        }
        total += hex.len() / 2;
        seen += 1;
    }
    if seen == 0 {
        return Err(SnapshotError::Corrupt);
    }
    Ok(total)
}
