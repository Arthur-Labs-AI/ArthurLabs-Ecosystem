//! Dormant G3 policy: bounded original-history reconstruction.
//! Canonical cores remain in import_events. The commit proof is authoritative;
//! foreign heads are derived, never inserted into the local-origin journal.
use super::{
    codec::{self, EntityKind, FieldValue, Operation},
    sql_effects, stream,
};
use crate::sync_api::{Error, Result, ValidatedEvent};
use rusqlite::{ffi, params, Connection, OptionalExtension};
#[path = "g3_d4.rs"]
mod d4;
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
fn image(row: &codec::RowImage) -> Result<serde_json::Value> {
    // Observer JSON uses SQLite integers; wire decimals remain strings in cores.
    Ok(serde_json::Value::Object(
        row.iter()
            .map(|(k, v)| {
                Ok((
                    k.clone(),
                    match v {
                        FieldValue::Decimal(s) => serde_json::Value::Number(
                            s.parse::<i64>().map_err(|_| Error::Integrity)?.into(),
                        ),
                        _ => v.to_json(),
                    },
                ))
            })
            .collect::<Result<serde_json::Map<String, serde_json::Value>>>()?,
    ))
}
fn supported(v: &ValidatedEvent, history: bool, d4: bool) -> Result<bool> {
    if v.core().operations.len() > 64 {
        return Ok(false);
    }
    for op in &v.core().operations {
        let Operation::RecordCreate(row) = op else {
            if d4 {
                continue;
            } else {
                return Ok(false);
            }
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
            EntityKind::KnowledgeObjects | EntityKind::ThoughtRevisions if history => {
                let title = text(&row.after, "title")?;
                let body = text(&row.after, "body")?;
                if title.trim().is_empty()
                    || title.chars().count() > super::super::knowledge_store::MAX_TITLE_CHARS
                    || body.trim().is_empty()
                    || body.chars().count() > super::super::knowledge_store::MAX_BODY_CHARS
                {
                    return Err(Error::Integrity);
                }
            }
            EntityKind::DistillationRuns
            | EntityKind::ObjectSources
            | EntityKind::RevisionParents
            | EntityKind::RevisionEvidence
                if history => {}
            EntityKind::Relations
            | EntityKind::IdentityDecisions
            | EntityKind::PendingClaims
            | EntityKind::RevisionProposals
                if d4 => {}
            _ => return Ok(false),
        }
    }
    Ok(true)
}
pub(in crate::storage) fn d4_installed(c: &Connection) -> Result<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='import_d4_policy' AND type='table')",
        [],
        |r| r.get(0),
    )
    .map_err(|_| Error::Storage)
}
pub(in crate::storage) fn disclosure_row(entity: EntityKind, row: &codec::RowImage) -> Result<()> {
    if entity == EntityKind::IdentityDecisions {
        d4::validate_audit(row)?;
    }
    Ok(())
}
pub(in crate::storage) fn disclosure_event(v: &ValidatedEvent) -> Result<()> {
    for op in &v.core().operations {
        let row = match op {
            Operation::RecordCreate(r) => &r.after,
            Operation::FacetUpdate(u) => &u.after,
            Operation::RelationRemove(r) => &r.before,
        };
        disclosure_row(op.entity(), row)?;
    }
    Ok(())
}
// SQLite owns this allocation from create_function_v2 until replacement/removal.
// It contains only the exact validated row currently being mutated. No SQL,
// network, callbacks into providers, or peer-supplied identifiers execute here.
struct Grant {
    active: Arc<AtomicBool>,
    entity: String,
    row: serde_json::Value,
    before: Option<serde_json::Value>,
    deleting: bool,
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
        if n != 3 {
            return false;
        }
        let args = std::slice::from_raw_parts(args, 3);
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
        let allowed = ffi::sqlite3_get_autocommit(ffi::sqlite3_context_db_handle(ctx)) == 0
            && g.active.load(Ordering::SeqCst)
            && read(0) == Some(g.entity.as_str())
            && (if g.deleting {
                ffi::sqlite3_value_type(args[1]) == ffi::SQLITE_NULL
            } else {
                read(1)
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                    .as_ref()
                    == Some(&g.row)
            })
            && match &g.before {
                Some(b) => {
                    read(2)
                        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                        .as_ref()
                        == Some(b)
                }
                None => ffi::sqlite3_value_type(args[2]) == ffi::SQLITE_NULL,
            };
        allowed && g.active.swap(false, Ordering::SeqCst)
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
            3,
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
pub(in crate::storage) fn history_installed(c: &Connection) -> Result<bool> {
    c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='import_history_policy' AND type='table')",[],|r|r.get(0)).map_err(|_|Error::Storage)
}
fn observer(entity: EntityKind, verb: &str) -> Result<String> {
    // Names come exclusively from the closed native catalog, never raw input.
    let action = match verb {
        "update" => "UPDATE",
        "insert" => "INSERT",
        "delete" => "DELETE",
        _ => return Err(Error::Storage),
    };
    let marker = format!(
        "CREATE TRIGGER sync_observe_{}_{verb} AFTER {action} ON {}",
        entity.as_str(),
        entity.as_str()
    );
    let source = include_str!("../m05_v10.sql");
    let tail = &source[source.find(&marker).ok_or(Error::Storage)?..];
    Ok(tail[..tail.find("\nEND;").ok_or(Error::Storage)? + 5].into())
}
fn sql_value(v: &FieldValue) -> Result<rusqlite::types::Value> {
    Ok(match v {
        FieldValue::Null => rusqlite::types::Value::Null,
        FieldValue::Text(s) => rusqlite::types::Value::Text(s.clone()),
        FieldValue::Decimal(s) => {
            rusqlite::types::Value::Integer(s.parse().map_err(|_| Error::Integrity)?)
        }
    })
}
pub(in crate::storage) fn observers_restored(c: &Connection) -> Result<()> {
    for e in sql_effects::ENTITIES {
        for verb in ["insert", "update", "delete"] {
            let name = format!("sync_observe_{}_{verb}", e.as_str());
            let actual: String = c
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?1",
                    [name],
                    |r| r.get(0),
                )
                .map_err(|_| Error::Storage)?;
            if actual.trim_end_matches(';') != observer(e, verb)?.trim_end_matches(';') {
                return Err(Error::Storage);
            }
        }
    }
    Ok(())
}
fn insert_row(c: &Connection, e: EntityKind, row: &codec::RowImage) -> Result<usize> {
    let fields = e.all_fields();
    let sql = format!(
        "INSERT INTO {}({}) VALUES({})",
        e.as_str(),
        fields.join(","),
        (1..=fields.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(",")
    );
    let values = fields
        .iter()
        .map(|f| sql_value(row.get(*f).ok_or(Error::Integrity)?))
        .collect::<Result<Vec<_>>>()?;
    c.execute(&sql, rusqlite::params_from_iter(values))
        .map_err(|_| Error::Storage)
}
fn mutate_row(
    c: &Connection,
    e: EntityKind,
    row: &codec::RowImage,
    before: &codec::RowImage,
    deleting: bool,
) -> Result<usize> {
    let changed = e
        .all_fields()
        .iter()
        .filter(|f| row.get(**f) != before.get(**f))
        .copied()
        .collect::<Vec<_>>();
    let mut values = Vec::new();
    if !deleting {
        for f in &changed {
            values.push(sql_value(row.get(*f).ok_or(Error::Integrity)?)?);
        }
    }
    let offset = values.len();
    for f in e.all_fields() {
        values.push(sql_value(before.get(*f).ok_or(Error::Integrity)?)?);
    }
    let predicate = e
        .all_fields()
        .iter()
        .enumerate()
        .map(|(i, f)| format!("{f} IS ?{}", offset + i + 1))
        .collect::<Vec<_>>()
        .join(" AND ");
    let sql = if deleting {
        format!("DELETE FROM {} WHERE {predicate}", e.as_str())
    } else {
        if changed.is_empty() {
            return Err(Error::Integrity);
        }
        let assignments = changed
            .iter()
            .enumerate()
            .map(|(i, f)| format!("{f}=?{}", i + 1))
            .collect::<Vec<_>>()
            .join(",");
        format!("UPDATE {} SET {assignments} WHERE {predicate}", e.as_str())
    };
    c.execute(&sql, rusqlite::params_from_iter(values))
        .map_err(|_| Error::Storage)
}
fn scoped_row(
    c: &Connection,
    e: EntityKind,
    row: &codec::RowImage,
    before: Option<&codec::RowImage>,
) -> Result<()> {
    scoped_effect(c, e, row, before, false)
}
fn scoped_effect(
    c: &Connection,
    e: EntityKind,
    row: &codec::RowImage,
    before: Option<&codec::RowImage>,
    deleting: bool,
) -> Result<()> {
    if c.is_autocommit() {
        return Err(Error::Storage);
    }
    let update = before.is_some();
    let verb = if deleting {
        "delete"
    } else if update {
        "update"
    } else {
        "insert"
    };
    let original = observer(e, verb)?;
    let name = format!("sync_observe_{}_{verb}", e.as_str());
    let installed: String = c
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name=?1 AND type='trigger'",
            [&name],
            |r| r.get(0),
        )
        .map_err(|_| Error::Storage)?;
    if installed.trim_end_matches(';') != original.trim_end_matches(';') {
        return Err(Error::Storage);
    }
    let json = |prefix: &str| {
        format!(
            "json_object({})",
            e.all_fields()
                .iter()
                .map(|f| format!("'{f}',{prefix}.{f}"))
                .collect::<Vec<_>>()
                .join(",")
        )
    };
    let prior = if update { json("OLD") } else { "NULL".into() };
    let after = if deleting { "NULL".into() } else { json("NEW") };
    let predicate = format!("arthur_g3_row('{}',{},{} )=0", e.as_str(), after, prior);
    let guarded = if update && !deleting {
        original.replacen("\nWHEN ", &format!("\nWHEN ({predicate}) AND "), 1)
    } else {
        original.replacen("\nBEGIN", &format!("\nWHEN {predicate}\nBEGIN"), 1)
    };
    let active = Arc::new(AtomicBool::new(true));
    register(
        c,
        Some(Grant {
            active: active.clone(),
            entity: e.as_str().into(),
            row: image(row)?,
            before: before.map(image).transpose()?,
            deleting,
        }),
    )?;
    let scoped = ScopedGrant {
        connection: c,
        active,
    };
    let drop_sql = format!("DROP TRIGGER sync_observe_{}_{};", e.as_str(), verb);
    c.execute_batch(&drop_sql)
        .and_then(|_| c.execute_batch(&guarded))
        .map_err(|_| Error::Storage)?;
    let result = if update || deleting {
        mutate_row(c, e, row, before.ok_or(Error::Integrity)?, deleting)
    } else {
        insert_row(c, e, row)
    };
    c.execute_batch(&drop_sql)
        .and_then(|_| c.execute_batch(&original))
        .map_err(|_| Error::Storage)?;
    scoped.revoke()?;
    let restored: String = c
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name=?1 AND type='trigger'",
            [&name],
            |r| r.get(0),
        )
        .map_err(|_| Error::Storage)?;
    if restored.trim_end_matches(';') != original.trim_end_matches(';') {
        return Err(Error::Storage);
    }
    if result? != 1 {
        return Err(Error::Integrity);
    }
    Ok(())
}
pub(in crate::storage) fn materialize(c: &Connection, v: &ValidatedEvent) -> Result<bool> {
    let d4 = d4_installed(c)?;
    if !installed(c)? || !supported(v, history_installed(c)?, d4)? || (d4 && !d4::admitted(c, v)?) {
        return Ok(false);
    }
    if c.is_autocommit() {
        return Err(Error::Storage);
    }
    let rows = v
        .core()
        .operations
        .iter()
        .filter_map(|o| match o {
            Operation::RecordCreate(r) => Some(r),
            _ => None,
        })
        .collect::<Vec<_>>();
    for row in &rows {
        if sql_effects::reread(c, row.entity, &row.key)
            .map_err(|_| Error::Storage)?
            .is_some()
        {
            return Ok(false);
        }
    }
    if rows
        .iter()
        .filter(|r| r.entity == EntityKind::KnowledgeObjects)
        .count()
        > super::super::knowledge_store::MAX_OBJECTS_PER_DISTILLATION
    {
        return Err(Error::Integrity);
    }
    for r in rows
        .iter()
        .filter(|r| r.entity == EntityKind::RevisionParents)
    {
        if !rows
            .iter()
            .any(|rev| rev.entity == EntityKind::ThoughtRevisions && rev.key[0] == r.key[0])
        {
            return Ok(false);
        }
    }
    for r in rows
        .iter()
        .filter(|r| r.entity == EntityKind::ObjectSources)
    {
        if !rows
            .iter()
            .any(|object| object.entity == EntityKind::KnowledgeObjects && object.key == r.key)
        {
            return Ok(false);
        }
    }
    for rev in rows
        .iter()
        .filter(|r| r.entity == EntityKind::ThoughtRevisions)
    {
        let parents = rows
            .iter()
            .filter(|r| r.entity == EntityKind::RevisionParents && r.key[0] == rev.key[0])
            .count();
        let origin = text(&rev.after, "origin")?;
        if (origin == "initial" && parents != 0)
            || (origin == "merge"
                && !(2..=super::super::lineage_store::MAX_MERGE_PARENTS).contains(&parents))
            || (!["initial", "merge"].contains(&origin) && parents != 1)
        {
            return Err(Error::Integrity);
        }
        if origin == "initial"
            && !rows.iter().any(|r| {
                r.entity == EntityKind::KnowledgeObjects
                    && r.after.get("current_revision_id") == rev.after.get("id")
            })
        {
            return Ok(false);
        }
        if origin == "system" && rev.after.get("capture_id") != Some(&FieldValue::Null) {
            return Err(Error::Integrity);
        }
        if origin == "system"
            && !rows
                .iter()
                .any(|r| r.entity == EntityKind::RevisionEvidence && r.key[0] == rev.key[0])
        {
            return Ok(false);
        }
        let object = text(&rev.after, "object_id")?;
        let stored: i64 = c
            .query_row(
                "SELECT count(*) FROM thought_revisions WHERE object_id=?1",
                [object],
                |r| r.get(0),
            )
            .map_err(|_| Error::Storage)?;
        let incoming = rows
            .iter()
            .filter(|r| {
                r.entity == EntityKind::ThoughtRevisions
                    && r.after.get("object_id") == rev.after.get("object_id")
            })
            .count();
        if stored as usize + incoming > super::super::lineage_store::MAX_REVISIONS_PER_OBJECT {
            return Err(Error::Integrity);
        }
    }
    // Validate the complete initial-object cycle before any mutation.
    for row in rows
        .iter()
        .filter(|r| r.entity == EntityKind::KnowledgeObjects)
    {
        let root = text(&row.after, "current_revision_id")?;
        let Some(revision) = rows
            .iter()
            .find(|r| r.entity == EntityKind::ThoughtRevisions && r.key == [root.to_owned()])
        else {
            return Ok(false);
        };
        let Some(source) = rows
            .iter()
            .find(|r| r.entity == EntityKind::ObjectSources && r.key == row.key)
        else {
            return Ok(false);
        };
        if text(&revision.after, "origin")? != "initial"
            || text(&revision.after, "object_id")? != row.key[0]
            || ["kind", "title", "body", "created_at"]
                .iter()
                .any(|k| row.after.get(*k) != revision.after.get(*k))
            || ["capture_id", "source_start", "source_end"]
                .iter()
                .any(|k| source.after.get(*k) != revision.after.get(*k))
        {
            return Err(Error::Integrity);
        }
    }
    // Explicit revision DAG, deterministic UUID tie-break; no wall-clock order.
    let mut remaining = rows
        .iter()
        .filter(|r| r.entity == EntityKind::ThoughtRevisions)
        .copied()
        .collect::<Vec<_>>();
    remaining.sort_by(|a, b| a.key.cmp(&b.key));
    let mut revisions = Vec::new();
    while !remaining.is_empty() {
        let ready = remaining.iter().position(|r| {
            !rows.iter().any(|p| {
                p.entity == EntityKind::RevisionParents
                    && p.key[0] == r.key[0]
                    && remaining.iter().any(|other| other.key[0] == p.key[1])
            })
        });
        let Some(i) = ready else {
            return Err(Error::Integrity);
        };
        revisions.push(remaining.remove(i));
    }
    for row in rows
        .iter()
        .filter(|r| r.entity == EntityKind::RevisionEvidence)
    {
        let descendant: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM revision_parents WHERE parent_revision_id=?1)",
                [&row.key[0]],
                |r| r.get(0),
            )
            .map_err(|_| Error::Storage)?;
        if descendant {
            return Ok(false);
        }
    }
    for e in [
        EntityKind::Projects,
        EntityKind::Captures,
        EntityKind::DistillationRuns,
        EntityKind::KnowledgeObjects,
        EntityKind::ObjectSources,
    ] {
        for row in rows.iter().filter(|r| r.entity == e) {
            let mut image = row.after.clone();
            if e == EntityKind::KnowledgeObjects {
                image.insert("current_revision_id".into(), FieldValue::Null);
            }
            scoped_row(c, e, &image, None)?;
        }
    }
    // Evidence for existing parents is fixed before any new descendants.
    for row in rows.iter().filter(|r| {
        r.entity == EntityKind::RevisionEvidence
            && !revisions.iter().any(|rev| rev.key[0] == r.key[0])
    }) {
        scoped_row(c, row.entity, &row.after, None)?;
    }
    for rev in revisions {
        scoped_row(c, rev.entity, &rev.after, None)?;
        for row in rows
            .iter()
            .filter(|r| r.entity == EntityKind::RevisionParents && r.key[0] == rev.key[0])
        {
            scoped_row(c, row.entity, &row.after, None)?;
        }
        for row in rows
            .iter()
            .filter(|r| r.entity == EntityKind::RevisionEvidence && r.key[0] == rev.key[0])
        {
            scoped_row(c, row.entity, &row.after, None)?;
        }
    }
    for row in rows
        .iter()
        .filter(|r| r.entity == EntityKind::KnowledgeObjects)
    {
        let mut prior = row.after.clone();
        prior.insert("current_revision_id".into(), FieldValue::Null);
        scoped_row(c, row.entity, &row.after, Some(&prior))?;
    }
    for e in [
        EntityKind::Relations,
        EntityKind::IdentityDecisions,
        EntityKind::PendingClaims,
        EntityKind::RevisionProposals,
    ] {
        for row in rows.iter().filter(|r| r.entity == e) {
            scoped_row(c, e, &row.after, None)?;
        }
    }
    if d4 {
        d4::apply_transitions(c, v)?;
    }
    for row in rows {
        if sql_effects::reread(c, row.entity, &row.key)
            .map_err(|_| Error::Storage)?
            .as_ref()
            != Some(&row.after)
        {
            return Err(Error::Integrity);
        }
    }
    for row in v
        .core()
        .operations
        .iter()
        .filter(|o| o.entity() == EntityKind::KnowledgeObjects)
    {
        c.execute(
            "INSERT OR IGNORE INTO import_recall_suppression(object_id) VALUES(?1)",
            [&row.key()[0]],
        )
        .map_err(|_| Error::Storage)?;
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
    if d4 {
        c.execute(
            "INSERT INTO import_d4_commits VALUES(?1)",
            [id.event.to_string()],
        )
        .map_err(|_| Error::Storage)?;
    }
    for ((e, k, f), head) in
        stream::updates(&v.core().operations, &reference).map_err(|_| Error::Storage)?
    {
        let query = if d4 {
            "INSERT INTO import_d4_heads(entity,key_json,facet,event,hash) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(entity,key_json,facet) DO UPDATE SET event=excluded.event,hash=excluded.hash"
        } else if matches!(e, EntityKind::Projects | EntityKind::Captures) {
            "INSERT INTO import_g3_heads(entity,key_json,facet,event,hash) VALUES(?1,?2,?3,?4,?5)"
        } else {
            "INSERT INTO import_history_heads(entity,key_json,facet,event,hash) VALUES(?1,?2,?3,?4,?5)"
        };
        c.execute(
            query,
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
    let query = if d4_installed(c).map_err(|_| super::storage::JournalError::Sql)? {
        "SELECT event,hash FROM import_d4_heads WHERE entity=?1 AND key_json=?2 AND facet=?3"
    } else if history_installed(c).map_err(|_| super::storage::JournalError::Sql)? {
        "SELECT event,hash FROM import_g3_heads WHERE entity=?1 AND key_json=?2 AND facet=?3 UNION ALL SELECT event,hash FROM import_history_heads WHERE entity=?1 AND key_json=?2 AND facet=?3"
    } else {
        "SELECT event,hash FROM import_g3_heads WHERE entity=?1 AND key_json=?2 AND facet=?3"
    };
    c.query_row(
        query,
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
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) fn install(store: &super::super::capture_store::CaptureStore) -> Result<()> {
    let mut c = store.connection.lock().map_err(|_| Error::Storage)?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| Error::Storage)?;
    tx.execute_batch(include_str!("../import_g3.sql"))
        .map_err(|_| Error::Storage)?;
    tx.commit().map_err(|_| Error::Storage)
}

#[cfg(any(
    test,
    all(
        target_os = "android",
        feature = "android-identity-tests",
        debug_assertions
    )
))]
pub(crate) fn install_history(store: &super::super::capture_store::CaptureStore) -> Result<()> {
    let mut c = store.connection.lock().map_err(|_| Error::Storage)?;
    let tx = c.transaction().map_err(|_| Error::Storage)?;
    tx.execute_batch(include_str!("../import_history.sql"))
        .map_err(|_| Error::Storage)?;
    tx.commit().map_err(|_| Error::Storage)
}

#[cfg(any(
    test,
    all(
        target_os = "android",
        feature = "android-identity-tests",
        debug_assertions
    )
))]
pub(crate) fn install_d4(store: &super::super::capture_store::CaptureStore) -> Result<()> {
    let mut c = store.connection.lock().map_err(|_| Error::Storage)?;
    let tx = c.transaction().map_err(|_| Error::Storage)?;
    tx.execute_batch(include_str!("../import_d4.sql"))
        .map_err(|_| Error::Storage)?;
    tx.commit().map_err(|_| Error::Storage)
}
