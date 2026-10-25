//! Candidate import ledger and narrow native G3 materialization dispatcher.
//! Release construction remains blocked by G4 and identity activation decisions.
use super::{
    capture_store::CaptureStore,
    journal::{
        codec::{self, EntityKind, EventRef, FieldValue, Operation},
        g3, import_view,
    },
};
use crate::sync::*;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::sync::atomic::{AtomicBool, Ordering};
use uuid::Uuid;

pub(crate) struct CandidateSyncStore<'a> {
    store: &'a CaptureStore,
    usable: AtomicBool,
}
impl<'a> CandidateSyncStore<'a> {
    pub fn production(_store: &'a CaptureStore) -> Result<Self> {
        Err(Error::ActivationPending)
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub fn synthetic(store: &'a CaptureStore) -> Self {
        Self {
            store,
            usable: AtomicBool::new(true),
        }
    }
    /// Bounded resumable policy work, on the same owner/transaction as receive.
    pub fn reprocess(
        &self,
        s: &VerifiedSession,
        clock: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<usize> {
        self.write(s, clock, x, |c| {
            let count = refresh(c, s, clock, x)?;
            cursors(c)?;
            Ok(count)
        })
    }
    pub(super) fn read<T>(
        &self,
        s: &VerifiedSession,
        clock: &dyn SyncClock,
        x: &Cancellation,
        work: impl FnOnce(&Connection) -> Result<T>,
    ) -> Result<T> {
        if !self.usable.load(Ordering::SeqCst) {
            return Err(Error::Storage);
        }
        let c = self.store.connection.lock().map_err(|_| Error::Storage)?;
        import_view::ready(&c)?;
        authorize(&c, s, clock, x)?;
        let result = work(&c)?;
        authorize(&c, s, clock, x)?;
        Ok(result)
    }
    pub(super) fn write<T>(
        &self,
        s: &VerifiedSession,
        clock: &dyn SyncClock,
        x: &Cancellation,
        work: impl FnOnce(&Connection) -> Result<T>,
    ) -> Result<T> {
        if !self.usable.load(Ordering::SeqCst) {
            return Err(Error::Storage);
        }
        let mut c = self.store.connection.lock().map_err(|_| Error::Storage)?;
        import_view::ready(&c)?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        let result = authorize(&tx, s, clock, x)
            .and_then(|_| work(&tx))
            .and_then(|v| {
                quota(&tx)?;
                if g3::installed(&tx)? { g3::observers_restored(&tx)?; }
                authorize(&tx, s, clock, x)?;
                Ok(v)
            });
        match result {
            Ok(v) => match tx.commit() {
                Ok(()) => Ok(v),
                Err(_) => {
                    self.usable.store(false, Ordering::SeqCst);
                    let _ = c.pragma_update(None, "query_only", true);
                    Err(Error::Storage)
                }
            },
            Err(e) => {
                if tx.rollback().is_err() {
                    self.usable.store(false, Ordering::SeqCst);
                    let _ = c.pragma_update(None, "query_only", true);
                    return Err(Error::Storage);
                }
                Err(e)
            }
        }
    }
}
fn sql(_: rusqlite::Error) -> Error {
    Error::Storage
}
pub(super) fn authorize(
    c: &Connection,
    s: &VerifiedSession,
    clock: &dyn SyncClock,
    x: &Cancellation,
) -> Result<()> {
    s.check(clock, x)?;
    if let Some(binding) = s.registry_binding() {
        if !binding.matches(s.binding()) {
            return Err(Error::Trust);
        }
        super::enrollment_store::authorize_binding(c, binding, clock.now())
            .map_err(|_| Error::Trust)?;
    }
    let b = s.binding();
    let valid:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM import_candidate i JOIN import_members m ON m.peer=?1 WHERE i.singleton=1 AND i.revision=1 AND i.local_id=?2 AND i.network=?3 AND m.enabled=1 AND m.epoch=?4)",params![b.peer.to_string(),b.local.to_string(),b.network.to_string(),b.epoch],|r|r.get(0)).map_err(sql)?;
    let mut origins = 0;
    for origin in s.origins() {
        origins += 1;
        if origins > MAX_EVENTS {
            return Err(Error::Trust);
        }
        let allowed:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM import_origin_permissions WHERE peer=?1 AND origin=?2 AND epoch=?3 AND enabled=1)",params![b.peer.to_string(),origin.to_string(),b.epoch],|r|r.get(0)).map_err(sql)?;
        if !allowed {
            return Err(Error::Trust);
        }
    }
    if !valid {
        return Err(Error::Trust);
    }
    Ok(())
}
pub(super) fn quota(c: &Connection) -> Result<()> {
    // Logical candidate quotas only. No physical admission bypass is available
    // in release builds: production() cannot construct this adapter.
    let events: i64 = c
        .query_row("SELECT count(*) FROM import_events", [], |r| r.get(0))
        .map_err(sql)?;
    let collisions: i64 = c
        .query_row("SELECT count(*) FROM import_collisions", [], |r| r.get(0))
        .map_err(sql)?;
    let members: i64 = c
        .query_row("SELECT count(*) FROM import_members", [], |r| r.get(0))
        .map_err(sql)?;
    if events > MAX_EVENTS as i64 || collisions > 16 || members > 8 {
        return Err(Error::StorageLimited);
    }
    let mut bytes:i64=c.query_row("SELECT coalesce((SELECT sum(length(bytes)) FROM import_events),0)+coalesce((SELECT sum(length(bytes)) FROM import_collisions),0)+coalesce((SELECT sum(length(local_row)+length(local_heads)+length(CAST(key_json AS BLOB))) FROM import_conflicts),0)+coalesce((SELECT sum(length(CAST(dependency AS BLOB))) FROM import_pending),0)+coalesce((SELECT sum(length(CAST(key_json AS BLOB))+length(entity)+68) FROM import_creates),0)",[],|r|r.get(0)).map_err(sql)?;
    if g3::installed(c)? {
        let (heads,extra):(i64,i64)=c.query_row("SELECT count(*),coalesce(sum(length(CAST(entity AS BLOB))+length(CAST(key_json AS BLOB))+length(facet)+length(event)+length(hash)+16),0) FROM import_g3_heads",[],|r|Ok((r.get(0)?,r.get(1)?))).map_err(sql)?;
        if heads > 65536 {
            return Err(Error::StorageLimited);
        }
        bytes = bytes.checked_add(extra).ok_or(Error::StorageLimited)?;
    }
    if g3::history_installed(c)? {
        let (heads,extra):(i64,i64)=c.query_row("SELECT count(*),coalesce(sum(length(entity)+length(CAST(key_json AS BLOB))+length(facet)+length(event)+length(hash)+16),0)+(SELECT count(*)*64 FROM import_recall_suppression) FROM import_history_heads",[],|r|Ok((r.get(0)?,r.get(1)?))).map_err(sql)?;
        let base: i64 = c
            .query_row("SELECT count(*) FROM import_g3_heads", [], |r| r.get(0))
            .map_err(sql)?;
        if heads + base > 65536 {
            return Err(Error::StorageLimited);
        }
        bytes = bytes.checked_add(extra).ok_or(Error::StorageLimited)?;
    }
    if super::bootstrap_store::installed(c)? {
        let extra:i64=c.query_row("SELECT coalesce((SELECT sum(coalesce(length(manifest),0)+512) FROM bootstrap_units),0)+coalesce((SELECT sum(length(bytes)+128) FROM bootstrap_chunks),0)",[],|r|r.get(0)).map_err(sql)?;
        bytes = bytes.checked_add(extra).ok_or(Error::StorageLimited)?;
    }
    if g3::d4_installed(c)? {
        let (heads,extra):(i64,i64)=c.query_row("SELECT count(*),coalesce(sum(length(entity)+length(CAST(key_json AS BLOB))+length(facet)+length(event)+length(hash)+32),0)+(SELECT count(*)*64 FROM import_d4_commits)+(SELECT count(*)*128 FROM bootstrap_lifecycle) FROM import_d4_heads",[],|r|Ok((r.get(0)?,r.get(1)?))).map_err(sql)?;
        if heads>65536 {return Err(Error::StorageLimited);}
        bytes=bytes.checked_add(extra).ok_or(Error::StorageLimited)?;
    }
    let creates: i64 = c
        .query_row("SELECT count(*) FROM import_creates", [], |r| r.get(0))
        .map_err(sql)?;
    if creates > 65536 {
        return Err(Error::StorageLimited);
    }
    if bytes > 64 * 1024 * 1024 {
        return Err(Error::StorageLimited);
    }
    for table in [
        "import_origin_permissions",
        "import_event_epochs",
        "import_sent",
        "import_progress",
        "import_delivery",
        "import_receipts",
        "import_conflicts",
        "import_pending",
    ] {
        let count: i64 = c
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .map_err(sql)?;
        if count > 2048 {
            return Err(Error::StorageLimited);
        }
    }
    Ok(())
}
fn idrow(r: &rusqlite::Row<'_>) -> rusqlite::Result<Identity> {
    fn uuid(r: &rusqlite::Row<'_>, i: usize) -> rusqlite::Result<Uuid> {
        Uuid::parse_str(&r.get::<_, String>(i)?).map_err(|_| rusqlite::Error::InvalidQuery)
    }
    let hash: Vec<u8> = r.get(5)?;
    Ok(Identity {
        event: uuid(r, 0)?,
        bundle: uuid(r, 1)?,
        origin: uuid(r, 2)?,
        incarnation: uuid(r, 3)?,
        seq: r.get(4)?,
        hash: hash.try_into().map_err(|_| rusqlite::Error::InvalidQuery)?,
    })
}
pub(super) fn inventory_page(
    c: &Connection,
    after: Option<PageKey>,
) -> Result<(Vec<Identity>, Option<PageKey>)> {
    let (origin, inc, seq) = after
        .map(|(o, i, s)| (o.to_string(), i.to_string(), s))
        .unwrap_or_default();
    let mut q=c.prepare("SELECT * FROM (SELECT event_id,bundle_id,origin_id,incarnation,origin_seq,canonical_hash FROM sync_bundles UNION ALL SELECT event,bundle,origin,incarnation,seq,hash FROM import_events WHERE outcome<>'rejected') WHERE (origin_id,incarnation,origin_seq)>(?1,?2,?3) ORDER BY 3,4,5 LIMIT 65").map_err(sql)?;
    let mut rows = q
        .query_map(params![origin, inc, seq], idrow)
        .map_err(sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql)?;
    let more = rows.len() > SUMMARY_PAGE;
    rows.truncate(SUMMARY_PAGE);
    let next = if more {
        rows.last().map(|r| (r.origin, r.incarnation, r.seq))
    } else {
        None
    };
    Ok((rows, next))
}
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
fn inventory(c: &Connection) -> Result<Vec<Identity>> {
    // Test-only whole-fixture helper; production discovery always uses pages.
    let mut all = Vec::new();
    let mut after = None;
    loop {
        let (rows, next) = inventory_page(c, after)?;
        all.extend(rows);
        if next.is_none() {
            break;
        }
        after = next;
    }
    Ok(all)
}
pub(super) fn load(c: &Connection, event: Uuid) -> Result<Option<Envelope>> {
    let result:Option<(Vec<u8>,Vec<u8>)>=c.query_row("SELECT canonical_bytes,canonical_hash FROM sync_bundles WHERE event_id=?1 UNION ALL SELECT bytes,hash FROM import_events WHERE event=?1",[event.to_string()],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql)?;
    result
        .map(|(bytes, hash)| {
            let core = codec::decode_core_strict(&bytes).map_err(|_| Error::Storage)?;
            let parse = |s: &str| Uuid::parse_str(s).map_err(|_| Error::Storage);
            let identity = Identity {
                event: parse(&core.event_id)?,
                bundle: parse(&core.bundle_id)?,
                origin: parse(&core.origin_id)?,
                incarnation: parse(&core.origin_incarnation)?,
                seq: core.origin_seq.parse().map_err(|_| Error::Storage)?,
                hash: hash.try_into().map_err(|_| Error::Storage)?,
            };
            let envelope = Envelope { bytes, identity };
            ValidatedEvent::parse(envelope.clone()).map_err(|_| Error::Storage)?;
            Ok(envelope)
        })
        .transpose()
}
pub(super) fn reference(c: &Connection, r: &EventRef) -> Result<Option<codec::JournalEvent>> {
    let id = Uuid::parse_str(&r.event_id).map_err(|_| Error::Integrity)?;
    let held: Option<(String, i64)> = c
        .query_row(
            "SELECT outcome,chain_ok FROM import_events WHERE event=?1",
            [id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(sql)?;
    if held.is_some_and(|(outcome, chain)| {
        chain != 1 || outcome == "rejected" || outcome == "deferred"
    }) {
        return Ok(None);
    }
    let Some(e) = load(c, id)? else {
        return Ok(None);
    };
    if e.identity.origin.to_string() != r.origin_id
        || e.identity.incarnation.to_string() != r.incarnation
        || e.identity.seq.to_string() != r.seq
        || codec::hash_hex(&e.identity.hash) != r.hash
    {
        return Err(Error::Integrity);
    }
    Ok(Some(ValidatedEvent::parse(e)?.core().clone()))
}
pub(super) fn authorize_event_scope(s:&VerifiedSession,e:&ValidatedEvent)->Result<()> {
    let check=|origin:&str|->Result<()> {
        if !s.permits(Uuid::parse_str(origin).map_err(|_|Error::Integrity)?) {return Err(Error::Trust);}
        Ok(())
    };
    check(&e.core().origin_id)?;
    for d in &e.core().dependencies {if let Some(r)=&d.event_ref {check(&r.origin_id)?;}}
    for op in &e.core().operations {
        match op {
            Operation::FacetUpdate(u)=>for p in u.expected.values() {if let Some(r)=&p.event_ref {check(&r.origin_id)?;}},
            Operation::RelationRemove(r)=>if let codec::ObservedCreate::Event(r)=&r.observed_create {check(&r.origin_id)?;},
            _=>{}
        }
    }
    Ok(())
}
fn pending(c: &Connection, event: Uuid, reason: &str) -> Result<()> {
    c.execute(
        "INSERT OR IGNORE INTO import_pending(event,dependency) VALUES(?1,?2)",
        params![event.to_string(), reason],
    )
    .map_err(sql)?;
    Ok(())
}
fn image_value(row: Option<codec::RowImage>) -> serde_json::Value {
    row.map(|r| serde_json::Value::Object(r.into_iter().map(|(k, v)| (k, v.to_json())).collect()))
        .unwrap_or(serde_json::Value::Null)
}
fn validate_spans(c: &Connection, v: &ValidatedEvent) -> Result<()> {
    for op in &v.core().operations {
        let row = match op {
            Operation::RecordCreate(r) => &r.after,
            Operation::FacetUpdate(u) => &u.after,
            Operation::RelationRemove(r) => &r.before,
        };
        if let (
            Some(FieldValue::Text(capture)),
            Some(FieldValue::Decimal(start)),
            Some(FieldValue::Decimal(end)),
        ) = (
            row.get("capture_id"),
            row.get("source_start"),
            row.get("source_end"),
        ) {
            let body = v.core().operations.iter().find_map(|op| match op {
                Operation::RecordCreate(r)
                    if r.entity == EntityKind::Captures && r.key == [capture.clone()] =>
                {
                    r.after.get("content").cloned()
                }
                _ => None,
            });
            let body = match body {
                Some(b) => Some(b),
                None => import_view::row(c, EntityKind::Captures, &[capture.clone()])?
                    .and_then(|r| r.get("content").cloned()),
            };
            if let Some(FieldValue::Text(body)) = body {
                let start = start.parse::<usize>().map_err(|_| Error::Integrity)?;
                let end = end.parse::<usize>().map_err(|_| Error::Integrity)?;
                if start >= end
                    || end > body.chars().count()
                    || body
                        .chars()
                        .skip(start)
                        .take(end - start)
                        .collect::<String>()
                        .trim()
                        .is_empty()
                {
                    return Err(Error::Integrity);
                }
            }
        }
    }
    Ok(())
}
fn classify(c: &Connection, v: &ValidatedEvent) -> Result<(Outcome, bool)> {
    validate_spans(c, v)?;
    let e = v.envelope();
    let core = v.core();
    let id = e.identity.event;
    c.execute(
        "DELETE FROM import_pending WHERE event=?1",
        [id.to_string()],
    )
    .map_err(sql)?;
    if e.identity.seq > 1 {
        let previous:Option<(String,Vec<u8>)>=c.query_row("SELECT event_id,canonical_hash FROM sync_bundles WHERE origin_id=?1 AND incarnation=?2 AND origin_seq=?3 UNION ALL SELECT event,hash FROM import_events WHERE origin=?1 AND incarnation=?2 AND seq=?3 AND chain_ok=1 AND outcome<>'rejected'",params![core.origin_id,core.origin_incarnation,e.identity.seq-1],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql)?;
        let Some((_, hash)) = previous else {
            pending(
                c,
                id,
                &format!(
                    "predecessor:{}:{}:{}",
                    core.origin_id,
                    core.origin_incarnation,
                    e.identity.seq - 1
                ),
            )?;
            return Ok((Outcome::DeferredDependency, false));
        };
        let hash: [u8; 32] = hash.try_into().map_err(|_| Error::Storage)?;
        if codec::hash_hex(&hash) != core.previous_event_hash {
            return Ok((Outcome::RejectedIntegrity, false));
        }
    }
    let mut missing = false;
    for dep in &core.dependencies {
        if let Some(r) = &dep.event_ref {
            match reference(c,r)? {
                Some(prior)=>if !prior.operations.iter().any(|op|matches!(op,Operation::RecordCreate(row) if row.entity==dep.entity&&row.key==dep.key)){return Err(Error::Integrity)},
                None=>{missing=true;pending(c,id,&format!("event:{}",r.event_id))?;}
            }
        }
        if import_view::row(c, dep.entity, &dep.key)?.is_none() {
            missing = true;
            pending(
                c,
                id,
                &format!(
                    "row:{}:{}",
                    dep.entity.as_str(),
                    serde_json::to_string(&dep.key).map_err(|_| Error::Integrity)?
                ),
            )?;
        }
    }
    let mut conflicts = Vec::new();
    for (ordinal, op) in core.operations.iter().enumerate() {
        let actual = import_view::row(c, op.entity(), op.key())?;
        let mut conflict = false;
        let mut heads = Vec::new();
        let mut related = serde_json::Value::Null;
        match op {
            Operation::RecordCreate(row) => {
                if g3::d4_installed(c)? && row.entity == EntityKind::Relations {
                    conflict |= core.operations.iter().any(|op|matches!(op,Operation::RecordCreate(other) if other.entity==EntityKind::Relations&&other.key!=row.key&&["kind","source_object_id","target_object_id"].iter().all(|f|other.after.get(*f)==row.after.get(*f))));
                    let value = |k: &str| match row.after.get(k) { Some(FieldValue::Text(s)) => Ok(s.as_str()), _=>Err(Error::Integrity) };
                    let existing:Option<String>=c.query_row("SELECT id FROM relations WHERE kind=?1 AND source_object_id=?2 AND target_object_id=?3 AND id<>?4",params![value("kind")?,value("source_object_id")?,value("target_object_id")?,row.key[0]],|r|r.get(0)).optional().map_err(sql)?;
                    if let Some(id)=existing {
                        conflict=true;
                        related=image_value(import_view::row(c,EntityKind::Relations,&[id])?);
                    }
                }
                if let Some(actual) = &actual {
                    let mutable = codec::facets_of(row.entity)
                        .iter()
                        .flat_map(|f| f.fields.iter().copied())
                        .collect::<std::collections::BTreeSet<_>>();
                    if actual
                        .iter()
                        .any(|(k, v)| !mutable.contains(k.as_str()) && row.after.get(k) != Some(v))
                    {
                        return Ok((Outcome::RejectedIntegrity, true));
                    }
                    conflict |= actual != &row.after;
                }
                let key_json = serde_json::to_string(&row.key).map_err(|_| Error::Integrity)?;
                let claim: Option<Vec<u8>> = c
                    .query_row(
                        "SELECT row_hash FROM import_creates WHERE entity=?1 AND key_json=?2",
                        params![row.entity.as_str(), key_json],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(sql)?;
                let row_hash = codec::facet_state_hash(row.entity, "record", &row.key, &row.after)
                    .map_err(|_| Error::Integrity)?;
                if claim.is_some_and(|h| h != row_hash) {
                    return Ok((Outcome::RejectedIntegrity, true));
                }
                if row.entity == EntityKind::Captures {
                    if let Some(FieldValue::Text(project)) = row.after.get("project_id") {
                        let archived: Option<Option<String>> = c
                            .query_row(
                                "SELECT archived_at FROM projects WHERE id=?1",
                                [project],
                                |r| r.get(0),
                            )
                            .optional()
                            .map_err(sql)?;
                        if matches!(archived, Some(Some(_))) {
                            conflict = true;
                            related = image_value(import_view::row(
                                c,
                                EntityKind::Projects,
                                &[project.clone()],
                            )?);
                        }
                    }
                }
                if row.entity == EntityKind::Projects {
                    if let Some(FieldValue::Text(name)) = row.after.get("name") {
                        let other:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE lower(name)=lower(?1) AND id<>?2)",params![name,row.key[0]],|r|r.get(0)).map_err(sql)?;
                        conflict |= other;
                        if other {
                            let other_id:String=c.query_row("SELECT id FROM projects WHERE lower(name)=lower(?1) AND id<>?2 ORDER BY id LIMIT 1",params![name,row.key[0]],|r|r.get(0)).map_err(sql)?;
                            related = image_value(import_view::row(
                                c,
                                EntityKind::Projects,
                                &[other_id],
                            )?);
                        }
                    }
                }
            }
            Operation::FacetUpdate(update) => {
                if let Some(actual) = &actual {
                    if g3::d4_installed(c)? {
                        conflict |= actual != &update.before;
                        if update.entity==EntityKind::Projects {
                            if let Some(FieldValue::Text(name))=update.after.get("name") {
                                let duplicate:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE lower(name)=lower(?1) AND id<>?2)",params![name,update.key[0]],|r|r.get(0)).map_err(sql)?;
                                conflict |= duplicate;
                            }
                        }
                        if matches!(update.entity,EntityKind::Captures|EntityKind::KnowledgeObjects) {
                            if let Some(FieldValue::Text(project))=update.after.get("project_id") {
                                let archived:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND archived_at IS NOT NULL)",[project],|r|r.get(0)).map_err(sql)?;
                                if archived {conflict=true;related=image_value(import_view::row(c,EntityKind::Projects,&[project.clone()])?);}
                            }
                        }
                        if update.entity==EntityKind::Projects && update.after.get("archived_at")!=Some(&FieldValue::Null) && update.before.get("archived_at")==Some(&FieldValue::Null) {
                            // The codec has no archive child-set commitment. A
                            // concurrent Capture must remain a visible conflict.
                            let children:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM captures WHERE project_id=?1 UNION ALL SELECT 1 FROM knowledge_objects WHERE project_id=?1)",[&update.key[0]],|r|r.get(0)).map_err(sql)?;
                            conflict |= children;
                        }
                    }
                    for (facet, expected) in &update.expected {
                        let (hash, head) =
                            import_view::facet(c, op.entity(), op.key(), facet, actual)?;
                        if hash != expected.before_hash
                            || head.as_deref()
                                != expected.event_ref.as_ref().map(|r| r.event_id.as_str())
                        {
                            conflict = true;
                        }
                        heads.push((facet.clone(), head));
                        if let Some(r) = &expected.event_ref {
                            if reference(c, r)?.is_none() {
                                missing = true;
                                pending(c, id, &format!("event:{}", r.event_id))?;
                            }
                        }
                    }
                } else {
                    missing = true;
                    pending(
                        c,
                        id,
                        &format!(
                            "row:{}:{}",
                            op.entity().as_str(),
                            serde_json::to_string(op.key()).map_err(|_| Error::Integrity)?
                        ),
                    )?;
                }
            }
            Operation::RelationRemove(row) => {
                if let Some(actual) = &actual {
                    conflict |= actual != &row.before;
                } else {
                    missing = true;
                }
                if let codec::ObservedCreate::Event(r) = &row.observed_create {
                    if reference(c, r)?.is_none() {
                        missing = true;
                        pending(c, id, &format!("event:{}", r.event_id))?;
                    }
                }
            }
        }
        if conflict {
            let local = serde_json::json!({"record":image_value(actual),"related_project":related});
            conflicts.push((
                ordinal,
                op.entity().as_str(),
                serde_json::to_string(op.key()).map_err(|_| Error::Integrity)?,
                serde_json::to_vec(&local).map_err(|_| Error::Integrity)?,
                serde_json::to_vec(&heads).map_err(|_| Error::Integrity)?,
            ));
        }
    }
    // Missing causal evidence is staged, never an acknowledged conflict.
    if missing {
        return Ok((Outcome::DeferredDependency, true));
    }
    for op in &core.operations {
        if let Operation::RecordCreate(row) = op {
            let hash = codec::facet_state_hash(row.entity, "record", &row.key, &row.after)
                .map_err(|_| Error::Integrity)?;
            c.execute("INSERT OR IGNORE INTO import_creates(entity,key_json,event,row_hash) VALUES(?1,?2,?3,?4)",params![row.entity.as_str(),serde_json::to_string(&row.key).map_err(|_|Error::Integrity)?,id.to_string(),hash.as_slice()]).map_err(sql)?;
        }
    }
    if !conflicts.is_empty() {
        for (ordinal, entity, key, row, heads) in conflicts {
            c.execute("INSERT OR IGNORE INTO import_conflicts(event,ordinal,entity,key_json,local_row,local_heads) VALUES(?1,?2,?3,?4,?5,?6)",params![id.to_string(),ordinal as i64,entity,key,row,heads]).map_err(sql)?;
            quota(c)?;
        }
        return Ok((Outcome::ConflictRetained, true));
    }
    if g3::materialize(c, v)? {
        return Ok((Outcome::CleanlyApplied, true));
    }
    Ok((Outcome::UnsupportedImportPolicy, true))
}
pub(super) fn refresh(
    c: &Connection,
    s: &VerifiedSession,
    clock: &dyn SyncClock,
    x: &Cancellation,
) -> Result<usize> {
    let g3 = g3::installed(c)?;
    let cursor: i64 = if g3 {
        c.query_row("SELECT cursor FROM import_g3_policy", [], |r| r.get(0))
            .map_err(sql)?
    } else {
        0
    };
    let select = |after: i64| -> Result<Vec<(i64, String)>> {
        let mut q=c.prepare("SELECT e.rowid,e.event FROM import_events e JOIN import_event_epochs a ON a.event=e.event WHERE e.peer=?1 AND a.epoch=?2 AND e.rowid>?3 AND (e.outcome='deferred' OR (?4 AND e.outcome='unsupported')) ORDER BY CASE WHEN ?4 THEN e.rowid ELSE 0 END,e.origin,e.incarnation,e.seq LIMIT ?5").map_err(sql)?;
        let rows = q
            .query_map(
                params![
                    s.binding().peer.to_string(),
                    s.binding().epoch,
                    after,
                    g3,
                    REPROCESS_BATCH as i64
                ],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql)?;
        Ok(rows)
    };
    let mut events = select(cursor)?;
    if events.is_empty() && cursor > 0 {
        events = select(0)?
    }
    let mut processed = 0;
    for (rowid, event) in events {
        authorize(c, s, clock, x)?;
        let id = Uuid::parse_str(&event).map_err(|_| Error::Storage)?;
        let v = ValidatedEvent::parse(load(c, id)?.ok_or(Error::Storage)?)?;
        if !s.permits(v.envelope().identity.origin) {
            if g3 {
                c.execute(
                    "UPDATE import_g3_policy SET cursor=?1 WHERE singleton=1",
                    [rowid],
                )
                .map_err(sql)?;
            }
            continue;
        }
        authorize_event_scope(s,&v)?;
        let (outcome, chain) = match classify(c, &v) {
            Ok(result) => result,
            Err(Error::Integrity) => (Outcome::RejectedIntegrity, false),
            Err(e) => return Err(e),
        };
        c.execute(
            "UPDATE import_events SET outcome=?2,chain_ok=?3 WHERE event=?1",
            params![event, outcome.code(), chain],
        )
        .map_err(sql)?;
        if g3 {
            c.execute(
                "UPDATE import_g3_policy SET cursor=?1 WHERE singleton=1",
                [rowid],
            )
            .map_err(sql)?;
        }
        processed += 1;
    }
    Ok(processed)
}
pub(super) fn cursors(c: &Connection) -> Result<()> {
    let groups = {
        let mut q=c.prepare("SELECT DISTINCT r.peer,e.origin,e.incarnation FROM import_receipts r JOIN import_events e ON e.event=r.event").map_err(sql)?;
        let rows = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql)?;
        rows
    };
    for (peer, origin, incarnation) in groups {
        let mut stored = 0i64;
        let mut integrated = 0i64;
        let mut applied = 0i64;
        let mut q=c.prepare("SELECT e.seq,e.outcome,e.chain_ok FROM import_receipts r JOIN import_events e ON e.event=r.event WHERE r.peer=?1 AND e.origin=?2 AND e.incarnation=?3 ORDER BY e.seq").map_err(sql)?;
        let rows = q
            .query_map(params![peer, origin, incarnation], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .map_err(sql)?;
        for row in rows {
            let (seq, outcome, chain) = row.map_err(sql)?;
            if seq != stored + 1 || chain != 1 || outcome == "rejected" {
                break;
            }
            stored = seq;
            if seq == integrated + 1 && Outcome::parse(&outcome)?.is_ack() {
                integrated = seq
            }
            if seq == applied + 1 && outcome == "applied" {
                applied = seq
            }
        }
        c.execute("INSERT INTO import_progress(peer,origin,incarnation,stored,integrated,applied) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(peer,origin,incarnation) DO UPDATE SET stored=excluded.stored,integrated=excluded.integrated,applied=excluded.applied",params![peer,origin,incarnation,stored,integrated,applied]).map_err(sql)?;
    }
    Ok(())
}
impl SyncStore for CandidateSyncStore<'_> {
    fn snapshot_capture(
        &self,
        s: &VerifiedSession,
        id: Uuid,
        c: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<crate::sync::bootstrap::SnapshotExport> {
        super::bootstrap_store::capture(self, s, id, c, x)
    }
    fn snapshot_offer(
        &self,
        s: &VerifiedSession,
        o: &crate::sync::bootstrap::SnapshotOffer,
        c: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<()> {
        super::bootstrap_store::stage_offer(self, s, o, c, x)
    }
    fn snapshot_chunk(
        &self,
        s: &VerifiedSession,
        ch: &crate::sync::bootstrap::SnapshotChunk,
        c: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<()> {
        super::bootstrap_store::stage_chunk(self, s, ch, c, x)
    }
    fn snapshot_publish(
        &self,
        s: &VerifiedSession,
        o: &crate::sync::bootstrap::SnapshotOffer,
        c: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<crate::sync::bootstrap::SnapshotReceipt> {
        super::bootstrap_store::publish(self, s, o, c, x)
    }
    fn snapshot_receipt(
        &self,
        s: &VerifiedSession,
        r: &crate::sync::bootstrap::SnapshotReceipt,
        c: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<()> {
        super::bootstrap_store::receipt(self, s, r, c, x)
    }
    fn authorize(&self, s: &VerifiedSession, c: &dyn SyncClock, x: &Cancellation) -> Result<()> {
        self.read(s, c, x, |_| Ok(()))
    }
    fn summary(
        &self,
        s: &VerifiedSession,
        clock: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<Summary> {
        self.page(s, None, clock, x)
    }
    fn page(
        &self,
        s: &VerifiedSession,
        after: Option<PageKey>,
        clock: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<Summary> {
        self.read(s,clock,x,|c|{
        let (known,next)=inventory_page(c,after)?;
        // Fail closed before disclosing any identity/cursor from a disallowed stream.
        if known.iter().any(|id|!s.permits(id.origin)){return Err(Error::Trust)}
        let mut q=c.prepare("SELECT origin,incarnation,stored,integrated,applied FROM import_progress WHERE peer=?1 ORDER BY origin,incarnation LIMIT 257").map_err(sql)?;
        let progress=q.query_map([s.binding().peer.to_string()],|r|Ok(Progress{origin:Uuid::parse_str(&r.get::<_,String>(0)?).map_err(|_|rusqlite::Error::InvalidQuery)?,incarnation:Uuid::parse_str(&r.get::<_,String>(1)?).map_err(|_|rusqlite::Error::InvalidQuery)?,stored:r.get(2)?,integrated:r.get(3)?,applied:r.get(4)?})).map_err(sql)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql)?;
        if progress.len()>MAX_EVENTS{return Err(Error::Limit)}
        if progress.iter().any(|p| !s.permits(p.origin)) { return Err(Error::Trust); }
        // A later inventory page must not leak through an earlier status/count.
        let mut scopes=c.prepare("SELECT origin_id FROM sync_bundles UNION SELECT origin FROM import_events UNION SELECT origin FROM import_sent").map_err(sql)?;
        let mut scopes=scopes.query([]).map_err(sql)?;
        while let Some(r)=scopes.next().map_err(sql)? {
            if !s.permits(Uuid::parse_str(&r.get::<_,String>(0).map_err(sql)?).map_err(|_|Error::Storage)?) {return Err(Error::Trust);}
        }
        let mut alternatives=c.prepare("SELECT bytes FROM import_collisions LIMIT 17").map_err(sql)?;
        let mut alternatives=alternatives.query([]).map_err(sql)?;
        while let Some(r)=alternatives.next().map_err(sql)? {
            let v=ValidatedEvent::parse(crate::sync::bootstrap::envelope(r.get(0).map_err(sql)?)?)?;
            authorize_event_scope(s,&v)?;
        }
        let mut needs_attention:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM import_events WHERE outcome<>'applied' UNION ALL SELECT 1 FROM import_sent WHERE outcome NOT IN('offered','applied') UNION ALL SELECT 1 FROM import_collisions)",[],|r|r.get(0)).map_err(sql)?;let mut problem:Option<String>=c.query_row("SELECT outcome FROM (SELECT outcome FROM import_events UNION ALL SELECT outcome FROM import_sent WHERE outcome<>'offered' UNION ALL SELECT 'rejected' FROM import_collisions) ORDER BY CASE outcome WHEN 'rejected' THEN 0 WHEN 'conflict' THEN 1 WHEN 'deferred' THEN 2 WHEN 'unsupported' THEN 3 ELSE 4 END LIMIT 1",[],|r|r.get(0)).optional().map_err(sql)?;
        if super::bootstrap_store::installed(c)?{
            let blocked:Option<String>=c.query_row("SELECT outcome FROM bootstrap_units WHERE peer=?1 AND network=?2 AND epoch=?3 AND outcome NOT IN('staged','applied') ORDER BY CASE outcome WHEN 'rejected' THEN 0 WHEN 'conflict' THEN 1 WHEN 'deferred' THEN 2 ELSE 3 END LIMIT 1",params![s.binding().peer.to_string(),s.binding().network.to_string(),s.binding().epoch],|r|r.get(0)).optional().map_err(sql)?;
            if blocked.is_some(){needs_attention=true;if problem.as_deref().is_none_or(|p|p=="applied"){problem=blocked;}}
        }
        let status=problem.as_deref().map(Outcome::parse).transpose()?.map(SyncStatus::from).unwrap_or(SyncStatus::Syncing);
        Ok(Summary{known,next,progress,needs_attention,status})
    })
    }
    fn lookup(
        &self,
        s: &VerifiedSession,
        id: Uuid,
        clock: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<Option<Identity>> {
        self.read(s, clock, x, |c| {
            Ok(load(c, id)?
                .filter(|e| s.permits(e.identity.origin))
                .map(|e| e.identity))
        })
    }
    fn export(
        &self,
        s: &VerifiedSession,
        id: &Identity,
        clock: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<Envelope> {
        self.read(s, clock, x, |c| {
            if !s.permits(id.origin) {
                return Err(Error::Trust);
            }
            let e = load(c, id.event)?.ok_or(Error::Integrity)?;
            if &e.identity != id {
                return Err(Error::Integrity);
            }
            let validated=ValidatedEvent::parse(e.clone())?;
            authorize_event_scope(s,&validated)?;
            g3::disclosure_event(&validated)?;
            Ok(e)
        })
    }
    fn retain(
        &self,
        s: &VerifiedSession,
        e: ValidatedEvent,
        clock: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<Receipt> {
        self.write(s, clock, x, |c| retain_in(c, s, &e, clock, x))
    }

    fn offered(
        &self,
        s: &VerifiedSession,
        id: &Identity,
        clock: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<()> {
        self.write(s,clock,x,|c|{
        if !s.permits(id.origin)||load(c,id.event)?.as_ref().map(|e|&e.identity)!=Some(id){return Err(Error::Integrity)}
        c.execute("INSERT INTO import_sent(peer,event,session,hash,origin,incarnation,seq,outcome) VALUES(?1,?2,?3,?4,?5,?6,?7,'offered') ON CONFLICT(peer,event) DO UPDATE SET session=excluded.session,outcome=CASE WHEN import_sent.outcome IN('applied','conflict') THEN import_sent.outcome ELSE 'offered' END",params![s.binding().peer.to_string(),id.event.to_string(),s.binding().session.to_string(),id.hash.as_slice(),id.origin.to_string(),id.incarnation.to_string(),id.seq]).map_err(sql)?;Ok(())
    })
    }
    fn receipt(
        &self,
        s: &VerifiedSession,
        r: &Receipt,
        clock: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<()> {
        self.write(s,clock,x,|c|{
        let id=&r.identity;
        let offered:Option<(Vec<u8>,String,String,i64,String)>=c.query_row("SELECT hash,origin,incarnation,seq,outcome FROM import_sent WHERE peer=?1 AND event=?2 AND session=?3",params![s.binding().peer.to_string(),id.event.to_string(),s.binding().session.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(sql)?;
        let Some((hash,origin,incarnation,seq,prior))=offered else{return Err(Error::Integrity)};
        if hash!=id.hash||origin!=id.origin.to_string()||incarnation!=id.incarnation.to_string()||seq!=id.seq||load(c,id.event)?.as_ref().map(|e|&e.identity)!=Some(id){return Err(Error::Integrity)}
        if Outcome::parse(&prior).is_ok_and(|p|p.is_ack()) && prior!=r.outcome.code(){return Err(Error::Integrity)}
        c.execute("UPDATE import_sent SET outcome=?3 WHERE peer=?1 AND event=?2",params![s.binding().peer.to_string(),id.event.to_string(),r.outcome.code()]).map_err(sql)?;
        let mut integrated=0i64;let mut applied=0i64;
        let mut q=c.prepare("SELECT seq,outcome FROM import_sent WHERE peer=?1 AND origin=?2 AND incarnation=?3 ORDER BY seq").map_err(sql)?;
        let rows=q.query_map(params![s.binding().peer.to_string(),origin,incarnation],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?))).map_err(sql)?;
        for row in rows{let(seq,outcome)=row.map_err(sql)?;if seq!=integrated+1||!Outcome::parse(&outcome).is_ok_and(|o|o.is_ack()){break}integrated=seq;if seq==applied+1&&outcome=="applied"{applied=seq}}
        c.execute("INSERT INTO import_delivery(peer,origin,incarnation,integrated,applied) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(peer,origin,incarnation) DO UPDATE SET integrated=excluded.integrated,applied=excluded.applied",params![s.binding().peer.to_string(),origin,incarnation,integrated,applied]).map_err(sql)?;Ok(())
    })
    }
    fn outstanding(
        &self,
        s: &VerifiedSession,
        clock: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<Vec<Uuid>> {
        self.read(s,clock,x,|c|{
        let mut q=c.prepare("SELECT event FROM import_sent WHERE peer=?1 AND (outcome='offered' OR (outcome IN('unsupported','deferred') AND session<>?2)) ORDER BY origin,incarnation,seq LIMIT 4").map_err(sql)?;
        let rows=q.query_map(params![s.binding().peer.to_string(),s.binding().session.to_string()],|r|r.get::<_,String>(0)).map_err(sql)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql)?;
        if rows.len()>MAX_EVENTS{return Err(Error::Limit)}rows.into_iter().map(|e|Uuid::parse_str(&e).map_err(|_|Error::Storage)).collect()
    })
    }
    fn missing(
        &self,
        s: &VerifiedSession,
        clock: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<Vec<Uuid>> {
        self.read(s,clock,x,|c|{
        let mut q=c.prepare("SELECT DISTINCT dependency FROM import_pending WHERE dependency LIKE 'event:%' ORDER BY dependency LIMIT 32").map_err(sql)?;
        let rows=q.query_map([],|r|r.get::<_,String>(0)).map_err(sql)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql)?;
        rows.into_iter().map(|e|Uuid::parse_str(&e[6..]).map_err(|_|Error::Storage)).collect()
    })
    }
}
fn collision(c: &Connection, s: &VerifiedSession, e: &Envelope, reason: &str) -> Result<()> {
    c.execute("INSERT OR IGNORE INTO import_collisions(event,hash,bytes,reason,peer) VALUES(?1,?2,?3,?4,?5)",params![e.identity.event.to_string(),e.identity.hash.as_slice(),e.bytes,reason,s.binding().peer.to_string()]).map_err(sql)?;
    Ok(())
}

#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) fn install_candidate(
    store: &CaptureStore,
    network: Uuid,
    local: Uuid,
    members: &[(Uuid, i64)],
) -> Result<()> {
    let mut c = store.connection.lock().map_err(|_| Error::Storage)?;
    import_view::ready(&c)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sql)?;
    tx.execute_batch(include_str!("import_candidate.sql"))
        .map_err(sql)?;
    tx.execute(
        "INSERT INTO import_candidate VALUES(1,1,?1,?2)",
        params![local.to_string(), network.to_string()],
    )
    .map_err(sql)?;
    for (peer, epoch) in members {
        tx.execute(
            "INSERT INTO import_members VALUES(?1,?2,1)",
            params![peer.to_string(), epoch],
        )
        .map_err(sql)?;
    }
    quota(&tx)?;
    tx.commit().map_err(sql)
}

#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) fn test_events(store: &CaptureStore) -> Vec<Envelope> {
    let c = store.connection.lock().unwrap();
    inventory(&c)
        .unwrap()
        .into_iter()
        .map(|id| load(&c, id.event).unwrap().unwrap())
        .collect()
}
#[cfg(test)]
pub(crate) fn test_refuses(store: &CaptureStore, statement: &str) -> bool {
    store
        .connection
        .lock()
        .unwrap()
        .execute_batch(statement)
        .is_err()
}

#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) fn grant_test_origins(
    store: &CaptureStore,
    peer: Uuid,
    origins: &std::collections::BTreeSet<Uuid>,
) {
    let c = store.connection.lock().unwrap();
    for origin in origins {
        c.execute("INSERT OR IGNORE INTO import_origin_permissions(peer,origin,epoch,enabled) VALUES(?1,?2,1,1)",params![peer.to_string(),origin.to_string()]).unwrap();
    }
}

pub(super) fn retain_in(
    c: &Connection,
    s: &VerifiedSession,
    e: &ValidatedEvent,
    clock: &dyn SyncClock,
    x: &Cancellation,
) -> Result<Receipt> {
    let envelope = e.envelope();
    let id = &envelope.identity;
    if !s.permits(id.origin) {
        return Err(Error::Trust);
    }
    authorize_event_scope(s,e)?;
    if let Some(prior) = load(c, id.event)? {
        if prior.identity != *id || prior.bytes != envelope.bytes {
            collision(c, s, envelope, "identity")?;
            return Ok(Receipt {
                identity: id.clone(),
                outcome: Outcome::RejectedIntegrity,
            });
        }
        let outcome: Option<String> = c
            .query_row(
                "SELECT outcome FROM import_events WHERE event=?1",
                [id.event.to_string()],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql)?;
        if outcome.is_none() {
            return Ok(Receipt {
                identity: id.clone(),
                outcome: Outcome::CleanlyApplied,
            });
        }
    } else {
        let fork:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sync_bundles WHERE origin_id=?1 AND incarnation=?2 AND origin_seq=?3 UNION ALL SELECT 1 FROM import_events WHERE origin=?1 AND incarnation=?2 AND seq=?3)",params![id.origin.to_string(),id.incarnation.to_string(),id.seq],|r|r.get(0)).map_err(sql)?;
        let bundle:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sync_bundles WHERE bundle_id=?1 UNION ALL SELECT 1 FROM import_events WHERE bundle=?1)",[id.bundle.to_string()],|r|r.get(0)).map_err(sql)?;
        if fork || bundle {
            collision(c, s, envelope, if fork { "stream" } else { "bundle" })?;
            return Ok(Receipt {
                identity: id.clone(),
                outcome: Outcome::RejectedIntegrity,
            });
        }
        c.execute("INSERT INTO import_events(event,bundle,origin,incarnation,seq,hash,bytes,outcome,chain_ok,peer) VALUES(?1,?2,?3,?4,?5,?6,?7,'deferred',0,?8)",params![id.event.to_string(),id.bundle.to_string(),id.origin.to_string(),id.incarnation.to_string(),id.seq,id.hash.as_slice(),envelope.bytes,s.binding().peer.to_string()]).map_err(sql)?;
    }
    c.execute(
        "INSERT OR IGNORE INTO import_receipts(peer,event) VALUES(?1,?2)",
        params![s.binding().peer.to_string(), id.event.to_string()],
    )
    .map_err(sql)?;
    c.execute(
        "INSERT OR IGNORE INTO import_event_epochs(event,epoch) VALUES(?1,?2)",
        params![id.event.to_string(), s.binding().epoch],
    )
    .map_err(sql)?;
    quota(c)?;
    refresh(c, s, clock, x)?;
    cursors(c)?;
    let outcome: String = c
        .query_row(
            "SELECT outcome FROM import_events WHERE event=?1",
            [id.event.to_string()],
            |r| r.get(0),
        )
        .map_err(sql)?;
    Ok(Receipt {
        identity: id.clone(),
        outcome: Outcome::parse(&outcome)?,
    })
}
