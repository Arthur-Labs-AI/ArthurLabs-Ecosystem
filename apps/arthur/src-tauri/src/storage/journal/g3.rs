//! Dormant G3 policy: create-only Project/Capture reconstruction.
//! Canonical cores remain in import_events. The commit proof is authoritative;
//! foreign heads are derived, never inserted into the local-origin journal.
use super::{
    codec::{self, EntityKind, FieldValue, Operation},
    sql_effects, stream,
};
use crate::sync::{Error, Result, ValidatedEvent};
use rusqlite::{ffi, params, Connection, OptionalExtension};
use std::{
    ffi::c_void,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

pub(in crate::storage) fn installed(c: &Connection) -> Result<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='import_g3_policy')",
        [],
        |r| r.get::<_, bool>(0),
    )
    .map_err(|_| Error::Storage)
    .and_then(|yes| {
        if !yes {
            Ok(false)
        } else {
            c.query_row(
                "SELECT version=1 FROM import_g3_policy WHERE singleton=1",
                [],
                |r| r.get(0),
            )
            .map_err(|_| Error::Storage)
        }
    })
}
fn text<'a>(r: &'a codec::RowImage, k: &str) -> Result<&'a str> {
    match r.get(k) {
        Some(FieldValue::Text(s)) => Ok(s),
        _ => Err(Error::Integrity),
    }
}
fn image(row: &codec::RowImage) -> serde_json::Value {
    serde_json::Value::Object(row.iter().map(|(k, v)| (k.clone(), v.to_json())).collect())
}
fn supported(v: &ValidatedEvent) -> Result<bool> {
    if v.core().operations.len() > 64 {
        return Ok(false);
    }
    for op in &v.core().operations {
        let Operation::RecordCreate(row) = op else {
            return Ok(false);
        };
        match row.entity {
            EntityKind::Projects => {
                let name = text(&row.after, "name")?;
                if name.trim() != name || name.is_empty() || name.chars().count() > 80 {
                    return Err(Error::Integrity);
                }
                if row.after.get("archived_at") != Some(&FieldValue::Null)
                    || text(&row.after, "created_at")? != text(&row.after, "updated_at")?
                {
                    return Ok(false);
                }
            }
            EntityKind::Captures => {
                let body = text(&row.after, "content")?;
                if body.trim().is_empty()
                    || body.chars().count() > super::super::capture_store::MAX_CAPTURE_CONTENT_CHARS
                    || !["text", "voice", "emg"].contains(&text(&row.after, "source")?)
                {
                    return Err(Error::Integrity);
                }
            }
            _ => return Ok(false),
        }
    }
    Ok(true)
}
// SQLite owns this allocation from create_function_v2 until replacement/removal.
// It contains only the exact validated row currently being inserted. No SQL,
// network, callbacks into providers, or peer-supplied identifiers execute here.
struct Grant {
    active: Arc<AtomicBool>,
    entity: String,
    row: serde_json::Value,
}
unsafe extern "C" fn destroy(p: *mut c_void) {
    drop(Box::from_raw(p.cast::<Grant>()));
}
unsafe extern "C" fn permits(
    ctx: *mut ffi::sqlite3_context,
    n: i32,
    args: *mut *mut ffi::sqlite3_value,
) {
    let answer = std::panic::catch_unwind(|| {
        if n != 2 {
            return false;
        }
        let args = std::slice::from_raw_parts(args, 2);
        let read = |i: usize| -> Option<&str> {
            if ffi::sqlite3_value_type(args[i]) != ffi::SQLITE_TEXT {
                return None;
            }
            let p = ffi::sqlite3_value_text(args[i]);
            if p.is_null() {
                return None;
            }
            std::str::from_utf8(std::slice::from_raw_parts(
                p,
                ffi::sqlite3_value_bytes(args[i]) as usize,
            ))
            .ok()
        };
        let g = &*ffi::sqlite3_user_data(ctx).cast::<Grant>();
        g.active.load(Ordering::SeqCst)
            && read(0) == Some(g.entity.as_str())
            && read(1)
                .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                .as_ref()
                == Some(&g.row)
    })
    .unwrap_or(false);
    ffi::sqlite3_result_int(ctx, i32::from(answer));
}
fn register(c: &Connection, grant: Option<Grant>) -> Result<()> {
    let p = grant
        .map(|g| Box::into_raw(Box::new(g)).cast::<c_void>())
        .unwrap_or(std::ptr::null_mut());
    // SAFETY: owner mutex and IMMEDIATE tx are held; SQLite owns p, including on
    // registration failure (v2 destructor contract). No pointer outlives SQLite.
    let rc = unsafe {
        ffi::sqlite3_create_function_v2(
            c.handle(),
            c"arthur_g3_row".as_ptr(),
            2,
            ffi::SQLITE_UTF8,
            p,
            if p.is_null() { None } else { Some(permits) },
            None,
            None,
            if p.is_null() { None } else { Some(destroy) },
        )
    };
    if rc != ffi::SQLITE_OK {
        return Err(Error::Storage);
    }
    Ok(())
}
/// Revocation precedes function removal, including error unwinds. Even if
/// SQLite cannot remove a prepared function, a surviving callback denies all
/// rows after this scope. SQLite alone owns/destructs its boxed callback data.
struct ScopedGrant<'a> {
    connection: &'a Connection,
    active: Arc<AtomicBool>,
}
impl ScopedGrant<'_> {
    fn revoke(&self) -> Result<()> {
        self.active.store(false, Ordering::SeqCst);
        register(self.connection, None)
    }
}
impl Drop for ScopedGrant<'_> {
    fn drop(&mut self) {
        let _ = self.revoke();
    }
}
fn observer(entity: EntityKind) -> Result<String> {
    // Trusted frozen artifact; never compose a SQL name from incoming text.
    let marker = match entity {
        EntityKind::Projects => {
            "CREATE TRIGGER sync_observe_projects_insert AFTER INSERT ON projects"
        }
        EntityKind::Captures => {
            "CREATE TRIGGER sync_observe_captures_insert AFTER INSERT ON captures"
        }
        _ => return Err(Error::Integrity),
    };
    let source = include_str!("../m05_v10.sql");
    let tail = &source[source.find(marker).ok_or(Error::Storage)?..];
    Ok(tail[..tail.find("\nEND;").ok_or(Error::Storage)? + 5].into())
}
pub(in crate::storage) fn materialize(c: &Connection, v: &ValidatedEvent) -> Result<bool> {
    if !installed(c)? || !supported(v)? {
        return Ok(false);
    }
    if c.is_autocommit() {
        return Err(Error::Storage);
    }
    // All operations and dependencies have been checked before the first INSERT.
    // Existing row identity is never adopted as proof of successful import.
    for op in &v.core().operations {
        if sql_effects::reread(c, op.entity(), op.key())
            .map_err(|_| Error::Storage)?
            .is_some()
        {
            return Ok(false);
        }
    }
    for entity in [EntityKind::Projects, EntityKind::Captures] {
        for op in &v.core().operations {
            let Operation::RecordCreate(row) = op else {
                return Err(Error::Integrity);
            };
            if row.entity != entity {
                continue;
            }
            let original = observer(entity)?;
            let fields = entity.all_fields();
            let json = format!(
                "json_object({})",
                fields
                    .iter()
                    .map(|f| format!("'{f}',NEW.{f}"))
                    .collect::<Vec<_>>()
                    .join(",")
            );
            let guarded = original.replacen(
                "\nBEGIN",
                &format!(
                    "\nWHEN arthur_g3_row('{}',{json})=0\nBEGIN",
                    entity.as_str()
                ),
                1,
            );
            let active = Arc::new(AtomicBool::new(true));
            register(
                c,
                Some(Grant {
                    active: active.clone(),
                    entity: entity.as_str().into(),
                    row: image(&row.after),
                }),
            )?;
            let scoped = ScopedGrant {
                connection: c,
                active,
            };
            let drop_sql = match entity {
                EntityKind::Projects => "DROP TRIGGER sync_observe_projects_insert;",
                _ => "DROP TRIGGER sync_observe_captures_insert;",
            };
            // Scoped observer replacement, never global trigger disabling. Its
            // ordinary-local body is copied byte-for-byte from frozen v10.
            c.execute_batch(drop_sql)
                .and_then(|_| c.execute_batch(&guarded))
                .map_err(|_| Error::Storage)?;
            let result=match entity{
                EntityKind::Projects=>c.execute("INSERT INTO projects(id,name,created_at,updated_at,archived_at) VALUES(?1,?2,?3,?4,NULL)",params![text(&row.after,"id")?,text(&row.after,"name")?,text(&row.after,"created_at")?,text(&row.after,"updated_at")?]),
                _=>c.execute("INSERT INTO captures(id,source,content,created_at,project_id) VALUES(?1,?2,?3,?4,?5)",params![text(&row.after,"id")?,text(&row.after,"source")?,text(&row.after,"content")?,text(&row.after,"created_at")?,text(&row.after,"project_id")?])
            };
            // Restore BEFORE any other native operation/COMMIT. Failure rolls
            // back transactional DDL and domain rows together in owning write().
            c.execute_batch(drop_sql)
                .and_then(|_| c.execute_batch(&original))
                .map_err(|_| Error::Storage)?;
            scoped.revoke()?;
            result.map_err(|_| Error::Storage)?;
            if sql_effects::reread(c, entity, &row.key)
                .map_err(|_| Error::Storage)?
                .as_ref()
                != Some(&row.after)
            {
                return Err(Error::Integrity);
            }
        }
    }
    let id = &v.envelope().identity;
    c.execute(
        "INSERT INTO import_g3_commits(event,version) VALUES(?1,1)",
        [id.event.to_string()],
    )
    .map_err(|_| Error::Storage)?;
    let reference = codec::EventRef {
        origin_id: id.origin.to_string(),
        incarnation: id.incarnation.to_string(),
        seq: id.seq.to_string(),
        event_id: id.event.to_string(),
        hash: codec::hash_hex(&id.hash),
    };
    for ((e, k, f), head) in
        stream::updates(&v.core().operations, &reference).map_err(|_| Error::Storage)?
    {
        c.execute(
            "INSERT INTO import_g3_heads(entity,key_json,facet,event,hash) VALUES(?1,?2,?3,?4,?5)",
            params![
                e.as_str(),
                serde_json::to_string(&k).map_err(|_| Error::Integrity)?,
                f,
                id.event.to_string(),
                head.hash.as_slice()
            ],
        )
        .map_err(|_| Error::Storage)?;
    }
    Ok(true)
}
pub(super) fn replay(c: &Connection) -> super::storage::Result<stream::History> {
    use super::storage::JournalError as E;
    let mut history = stream::History::default();
    if !installed(c).map_err(|_| E::CorruptCapability)? {
        return Ok(history);
    }
    let mut q=c.prepare("SELECT e.bytes,e.hash,e.event,e.chain_ok,e.outcome FROM import_g3_commits g JOIN import_events e ON e.event=g.event ORDER BY g.rowid LIMIT 257").map_err(|_|E::Sql)?;
    let mut rows = q.query([]).map_err(|_| E::Sql)?;
    let mut count = 0;
    while let Some(r) = rows.next().map_err(|_| E::Sql)? {
        count += 1;
        if count > 256 {
            return Err(E::MetadataQuota);
        }
        let bytes: Vec<u8> = r.get(0).map_err(|_| E::Sql)?;
        let core = codec::decode_core_strict(&bytes).map_err(|_| E::CorruptCapability)?;
        let hash = codec::journal_event_hash(&bytes);
        if r.get::<_, Vec<u8>>(1).map_err(|_| E::Sql)? != hash
            || r.get::<_, String>(2).map_err(|_| E::Sql)? != core.event_id
            || r.get::<_, i64>(3).map_err(|_| E::Sql)? != 1
            || r.get::<_, String>(4).map_err(|_| E::Sql)? != "applied"
        {
            return Err(E::CorruptCapability);
        }
        let reference = codec::EventRef {
            origin_id: core.origin_id,
            incarnation: core.origin_incarnation,
            seq: core.origin_seq,
            event_id: core.event_id,
            hash: codec::hash_hex(&hash),
        };
        history.apply(&core.operations, &reference)?;
    }
    Ok(history)
}
pub(super) fn head(
    c: &Connection,
    key: &stream::HeadKey,
) -> super::storage::Result<Option<(String, Vec<u8>)>> {
    if !installed(c).map_err(|_| super::storage::JournalError::Sql)? {
        return Ok(None);
    }
    c.query_row(
        "SELECT event,hash FROM import_g3_heads WHERE entity=?1 AND key_json=?2 AND facet=?3",
        params![
            key.0.as_str(),
            serde_json::to_string(&key.1).map_err(|_| super::storage::JournalError::Sql)?,
            key.2
        ],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(|_| super::storage::JournalError::Sql)
}
#[cfg(test)]
pub(crate) fn install(store: &super::super::capture_store::CaptureStore) -> Result<()> {
    let mut c = store.connection.lock().map_err(|_| Error::Storage)?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| Error::Storage)?;
    tx.execute_batch(include_str!("../import_g3.sql"))
        .map_err(|_| Error::Storage)?;
    tx.commit().map_err(|_| Error::Storage)
}
