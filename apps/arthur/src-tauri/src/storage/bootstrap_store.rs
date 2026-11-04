//! Private bounded bootstrap staging and atomic owner publication. No DB copying.
use super::{
    journal::{
        codec::{self, EntityKind, FieldValue, Operation, RowImage},
        import_view,
    },
    sync_store::{self, CandidateSyncStore},
};
use crate::sync_api::{bootstrap::*, *};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, Instant},
};
use uuid::Uuid;

type StoredUnit = (String, String, i64, Vec<u8>, i64, i64, String, String);
fn sql(_: rusqlite::Error) -> Error {
    Error::Storage
}
pub(super) fn installed(c: &Connection) -> Result<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='bootstrap_units')",
        [],
        |r| r.get(0),
    )
    .map_err(sql)
}
pub(super) fn unit(
    c: &Connection,
    s: &VerifiedSession,
    o: &SnapshotOffer,
    direction: &str,
) -> Result<String> {
    o.validate()?;
    let row:Option<StoredUnit>=c.query_row("SELECT peer,network,epoch,hash,bytes,chunks,direction,outcome FROM bootstrap_units WHERE id=?1",[o.id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).optional().map_err(sql)?;
    let Some((peer, network, epoch, hash, bytes, chunks, dir, outcome)) = row else {
        return Err(Error::Protocol);
    };
    if peer != s.binding().peer.to_string()
        || network != s.binding().network.to_string()
        || epoch != s.binding().epoch
    {
        return Err(Error::Trust);
    }
    if hash != o.hash || bytes != o.bytes as i64 || chunks != o.chunks as i64 || dir != direction {
        return Err(Error::Integrity);
    }
    Ok(outcome)
}
fn bounds(c: &Connection) -> Result<()> {
    let (units,bytes):(i64,i64)=c.query_row("SELECT count(*),coalesce(sum(coalesce(length(manifest),0)),0)+(SELECT coalesce(sum(length(bytes)),0) FROM bootstrap_chunks) FROM bootstrap_units",[],|r|Ok((r.get(0)?,r.get(1)?))).map_err(sql)?;
    if units > 4 || bytes > 8 * 1024 * 1024 {
        return Err(Error::StorageLimited);
    }
    Ok(())
}
#[derive(Clone, Copy)]
pub(crate) enum Maintenance {
    Interrupt,
    Expire,
    Resume,
    Retire,
}
/// Native maintenance records recovery state only. G7 has not authorized any
/// retirement proof; sender receipts and elapsed time cannot reclaim evidence.
pub(crate) fn maintain(
    store: &CandidateSyncStore<'_>,
    s: &VerifiedSession,
    o: &SnapshotOffer,
    action: Maintenance,
    clock: &dyn SyncClock,
    x: &Cancellation,
) -> Result<()> {
    store.write(s, clock, x, |c| {
        if !super::journal::g3::d4_installed(c)? {
            return Err(Error::ActivationPending);
        }
        let direction: String = c
            .query_row(
                "SELECT direction FROM bootstrap_units WHERE id=?1",
                [o.id.to_string()],
                |r| r.get(0),
            )
            .map_err(sql)?;
        unit(c, s, o, &direction)?;
        let state = match action {
            Maintenance::Interrupt => "interrupted",
            Maintenance::Expire => "expired",
            Maintenance::Resume => "receiving",
            Maintenance::Retire => return Err(Error::ActivationPending),
        };
        c.execute(
            "UPDATE bootstrap_lifecycle SET state=?2 WHERE id=?1",
            params![o.id.to_string(), state],
        )
        .map_err(sql)?;
        Ok(())
    })
}
fn save_unit(
    c: &Connection,
    s: &VerifiedSession,
    o: &SnapshotOffer,
    direction: &str,
    bytes: Option<&[u8]>,
) -> Result<()> {
    o.validate()?;
    c.execute("INSERT INTO bootstrap_units(id,peer,network,epoch,hash,bytes,chunks,direction,session,outcome,manifest) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'staged',?10)",params![o.id.to_string(),s.binding().peer.to_string(),s.binding().network.to_string(),s.binding().epoch,o.hash.as_slice(),o.bytes as i64,o.chunks as i64,direction,s.binding().session.to_string(),bytes]).map_err(sql)?;
    bounds(c)
}
fn image_json(row: &RowImage) -> serde_json::Value {
    serde_json::Value::Object(row.iter().map(|(k, v)| (k.clone(), v.to_json())).collect())
}
fn row(r: &SnapshotRow) -> Result<(EntityKind, RowImage)> {
    let e = EntityKind::from_str(&r.entity).map_err(|_| Error::Integrity)?;
    codec::validate_key(e, &r.key).map_err(|_| Error::Integrity)?;
    if !["m05", "legacy_attested"].contains(&r.provenance.as_str()) {
        return Err(Error::Integrity);
    }
    let fields = r.image.as_object().ok_or(Error::Integrity)?;
    let mut out = RowImage::new();
    if fields.len() != e.all_fields().len() {
        return Err(Error::Integrity);
    }
    for f in e.all_fields() {
        let v = fields.get(*f).ok_or(Error::Integrity)?;
        let field = if v.is_null() {
            FieldValue::Null
        } else {
            let s = v.as_str().ok_or(Error::Integrity)?.to_owned();
            if e.int_fields().contains(f) {
                FieldValue::Decimal(s)
            } else {
                FieldValue::Text(s)
            }
        };
        out.insert((*f).into(), field);
    }
    codec::validate_row_image(e, &out).map_err(|_| Error::Integrity)?;
    super::journal::g3::disclosure_row(e, &out)?;
    for (f, key) in e.key_fields().iter().zip(&r.key) {
        if !matches!(out.get(*f),Some(FieldValue::Text(s)|FieldValue::Decimal(s)) if s==key) {
            return Err(Error::Integrity);
        }
    }
    Ok((e, out))
}
fn graph_checked(
    events: &[Envelope],
    validated: &[ValidatedEvent],
) -> Result<(Vec<usize>, Vec<HighWater>)> {
    let mut refs = BTreeMap::new();
    let mut streams: BTreeMap<(Uuid, Uuid), BTreeMap<i64, usize>> = BTreeMap::new();
    let mut bundle = BTreeSet::new();
    for (i, e) in events.iter().enumerate() {
        if refs.insert(e.identity.event, i).is_some()
            || !bundle.insert(e.identity.bundle)
            || streams
                .entry((e.identity.origin, e.identity.incarnation))
                .or_default()
                .insert(e.identity.seq, i)
                .is_some()
        {
            return Err(Error::Integrity);
        }
    }
    let mut deps = vec![BTreeSet::new(); events.len()];
    let mut high = Vec::new();
    for ((origin, inc), entries) in streams {
        let (mut seq, mut hash) = (0, [0; 32]);
        for (n, i) in entries {
            let v = &validated[i];
            if n != seq + 1 || v.core().previous_event_hash != codec::hash_hex(&hash) {
                return Err(Error::Integrity);
            }
            if n > 1 {
                let prior = events
                    .iter()
                    .position(|e| {
                        e.identity.origin == origin
                            && e.identity.incarnation == inc
                            && e.identity.seq == n - 1
                    })
                    .ok_or(Error::Integrity)?;
                deps[i].insert(prior);
            }
            seq = n;
            hash = events[i].identity.hash;
        }
        high.push(HighWater {
            origin: origin.to_string(),
            incarnation: inc.to_string(),
            seq: seq.to_string(),
            hash: codec::hash_hex(&hash),
        });
    }
    for (i, _e) in events.iter().enumerate() {
        let v = &validated[i];
        let mut references = v
            .core()
            .dependencies
            .iter()
            .filter_map(|d| d.event_ref.as_ref())
            .collect::<Vec<_>>();
        for op in &v.core().operations {
            match op {
                Operation::FacetUpdate(u) => {
                    references.extend(u.expected.values().filter_map(|p| p.event_ref.as_ref()))
                }
                Operation::RelationRemove(r) => {
                    if let codec::ObservedCreate::Event(r) = &r.observed_create {
                        references.push(r)
                    }
                }
                _ => {}
            }
        }
        for r in references {
            let id = Uuid::parse_str(&r.event_id).map_err(|_| Error::Integrity)?;
            let j = *refs.get(&id).ok_or(Error::Integrity)?;
            let other = &events[j].identity;
            if other.origin.to_string() != r.origin_id
                || other.incarnation.to_string() != r.incarnation
                || other.seq.to_string() != r.seq
                || codec::hash_hex(&other.hash) != r.hash
            {
                return Err(Error::Integrity);
            }
            deps[i].insert(j);
        }
    }
    let mut order = Vec::new();
    let mut done = BTreeSet::new();
    while done.len() < events.len() {
        let next = (0..events.len())
            .filter(|i| !done.contains(i) && deps[*i].is_subset(&done))
            .min_by_key(|i| events[*i].identity.event)
            .ok_or(Error::Integrity)?;
        done.insert(next);
        order.push(next);
    }
    Ok((order, high))
}
pub(super) fn capture(
    store: &CandidateSyncStore<'_>,
    s: &VerifiedSession,
    id: Uuid,
    clock: &dyn SyncClock,
    x: &Cancellation,
) -> Result<SnapshotExport> {
    store.write(s, clock, x, |c| {
        if signed_unit(c, id)? {
            return Err(Error::Protocol);
        }
        capture_in(c, s, id)
    })
}
pub(super) fn capture_in(c: &Connection, s: &VerifiedSession, id: Uuid) -> Result<SnapshotExport> {
    capture_validated_in(c, s, id).map(|captured| captured.export)
}
// Only this capture path constructs the context, under the caller's transaction.
// Signed history reuses its fully checked cores instead of decoding them again.
pub(super) struct Captured {
    pub export: SnapshotExport,
    pub image: SnapshotImage,
    pub events: Vec<ValidatedEvent>,
}
pub(super) fn capture_validated_in(
    c: &Connection,
    s: &VerifiedSession,
    id: Uuid,
) -> Result<Captured> {
    let mut trace = super::bootstrap_trace::Capture::new();
    let result = capture_traced(c, s, id, &mut trace);
    trace.report.failure = result.as_ref().err().copied();
    result
}
fn capture_traced(
    c: &Connection,
    s: &VerifiedSession,
    id: Uuid,
    trace: &mut super::bootstrap_trace::Capture,
) -> Result<Captured> {
    if !installed(c)? {
        return Err(Error::ActivationPending);
    }
    // This profile promises a complete image, not a redacted projection. Even
    // sequence-zero origins disclose private identity/incarnation metadata.
    let mut origins = c
        .prepare("SELECT origin_id FROM sync_origins UNION SELECT origin FROM import_events")
        .map_err(sql)?;
    let mut origins = origins.query([]).map_err(sql)?;
    while let Some(r) = origins.next().map_err(sql)? {
        permit(s, &r.get::<_, String>(0).map_err(sql)?)?;
    }
    let prior: Option<(Vec<u8>, i64, i64, Vec<u8>)> = c
        .query_row(
            "SELECT hash,bytes,chunks,manifest FROM bootstrap_units WHERE id=?1",
            [id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(sql)?;
    if let Some((hash, bytes, chunks, payload)) = prior {
        let offer = SnapshotOffer {
            id,
            hash: hash.try_into().map_err(|_| Error::Storage)?,
            bytes: usize::try_from(bytes).map_err(|_| Error::Storage)?,
            chunks: usize::try_from(chunks).map_err(|_| Error::Storage)?,
        };
        unit(c, s, &offer, "out")?;
        let image = decode(&payload)?;
        let events = image
            .cores
            .iter()
            .map(|core| ValidatedEvent::from_bytes(unhex(&core.bytes)?))
            .collect::<Result<Vec<_>>>()?;
        authorize_checked(s, &image, &events)?;
        c.execute(
            "UPDATE bootstrap_units SET session=?2 WHERE id=?1",
            params![id.to_string(), s.binding().session.to_string()],
        )
        .map_err(sql)?;
        return Ok(Captured {
            export: SnapshotExport {
                offer,
                bytes: payload,
            },
            image,
            events,
        });
    }
    for (query, cap) in [
        ("SELECT count(*) FROM sync_origins", 64),
        ("SELECT count(*) FROM import_g3_commits", 64),
        ("SELECT count(*) FROM import_creates", 2048),
        ("SELECT (SELECT count(*) FROM import_conflicts)+(SELECT count(*) FROM import_collisions)", 64),
    ] {
        let n: i64 = c.query_row(query, [], |r| r.get(0)).map_err(sql)?;
        if n > cap { return Err(Error::SnapshotTooLarge); }
    }
    trace.phase("cores")?;
    let mut image = SnapshotImage {
        profile: if super::journal::g3::d4_installed(c)? {
            BOOTSTRAP_D4_PROFILE
        } else {
            BOOTSTRAP_PROFILE
        }
        .into(),
        version: 1,
        id: id.to_string(),
        network: s.binding().network.to_string(),
        row_count: 0,
        core_count: 0,
        rows: Vec::new(),
        cores: Vec::new(),
        high_water: Vec::new(),
        origin_metadata: Vec::new(),
        conflicts: Vec::new(),
    };
    let mut q = c.prepare("SELECT canonical_bytes,'applied',1 FROM sync_bundles UNION ALL SELECT e.bytes,e.outcome,EXISTS(SELECT 1 FROM import_g3_commits g WHERE g.event=e.event) FROM import_events e LIMIT 65").map_err(sql)?;
    let mut rs = q.query([]).map_err(sql)?;
    let mut events = Vec::new();
    let mut checked = Vec::new();
    let mut raw = 0;
    while let Some(r) = rs.next().map_err(sql)? {
        if events.len() >= BOOTSTRAP_EVENTS {
            return Err(Error::SnapshotTooLarge);
        }
        let bytes: Vec<u8> = r.get(0).map_err(sql)?;
        raw += bytes.len();
        trace.report.raw_bytes = raw;
        trace.report.events = events.len() + 1;
        if raw > BOOTSTRAP_BYTES / 2 {
            return Err(Error::SnapshotTooLarge);
        }
        let validated = ValidatedEvent::from_bytes(bytes)?;
        let e = validated.envelope().clone();
        if !s.permits(e.identity.origin) {
            return Err(Error::Trust);
        }
        image.cores.push(SnapshotCore {
            bytes: hex(&e.bytes),
            outcome: r.get(1).map_err(sql)?,
            materialized: r.get(2).map_err(sql)?,
        });
        events.push(e);
        checked.push(validated);
    }
    trace.phase("graph")?;
    image.high_water = graph_checked(&events, &checked)?.1;
    let mut creations = BTreeSet::new();
    for (index, event) in events.iter().enumerate() {
        let validated = &checked[index];
        if image.profile == BOOTSTRAP_D4_PROFILE
            && validated
                .core()
                .operations
                .iter()
                .any(|op| matches!(op,Operation::FacetUpdate(u) if u.review_proof.is_some()))
        {
            image.origin_metadata.push(serde_json::json!({"kind":"review_attestation","event":event.identity.event.to_string(),"provenance":"legacy_attested"}));
        }
        for op in &validated.core().operations {
            if let Operation::RecordCreate(r) = op {
                creations.insert((r.entity, r.key.clone()));
            }
        }
    }
    trace.phase("catalog")?;
    for (entity, key, record) in import_view::catalog(c, BOOTSTRAP_ROWS)? {
        super::journal::g3::disclosure_row(entity, &record)?;
        let provenance = if creations.contains(&(entity, key.clone())) {
            "m05"
        } else {
            "legacy_attested"
        };
        if image.profile == BOOTSTRAP_D4_PROFILE {
            for f in codec::facets_of(entity) {
                let (hash, event) = import_view::facet(c, entity, &key, f.name, &record)?;
                if let Some(event) = event {
                    image.origin_metadata.push(serde_json::json!({"kind":"facet","entity":entity.as_str(),"key":key,"facet":f.name,"event":event,"hash":hash}));
                }
            }
        }
        image.rows.push(SnapshotRow {
            entity: entity.as_str().into(),
            provenance: provenance.into(),
            key,
            image: image_json(&record),
        });
        trace.report.rows = image.rows.len();
        trace.check()?;
    }
    trace.phase("metadata_capture")?;
    let mut q = c.prepare("SELECT origin_id,incarnation,last_seq,last_hash,status,opened_at,sealed_at FROM sync_origins ORDER BY origin_id,incarnation LIMIT 65").map_err(sql)?;
    let mut rs = q.query([]).map_err(sql)?;
    while let Some(r) = rs.next().map_err(sql)? {
        let hash: Vec<u8> = r.get(3).map_err(sql)?;
        image.origin_metadata.push(serde_json::json!({
            "kind": "local_origin", "origin": r.get::<_,String>(0).map_err(sql)?,
            "incarnation": r.get::<_,String>(1).map_err(sql)?,
            "seq": r.get::<_,i64>(2).map_err(sql)?.to_string(), "hash": hex(&hash),
            "status": r.get::<_,String>(4).map_err(sql)?,
            "opened": r.get::<_,String>(5).map_err(sql)?,
            "sealed": r.get::<_,Option<String>>(6).map_err(sql)?
        }));
    }
    if image.profile == BOOTSTRAP_D4_PROFILE {
        let mut q = c
            .prepare("SELECT event FROM import_d4_commits ORDER BY event LIMIT 65")
            .map_err(sql)?;
        let mut rs = q.query([]).map_err(sql)?;
        while let Some(r) = rs.next().map_err(sql)? {
            image.origin_metadata.push(serde_json::json!({"kind":"d4_materialization","event":r.get::<_,String>(0).map_err(sql)?,"version":"1"}));
        }
    }
    let mut q = c
        .prepare("SELECT event,version FROM import_g3_commits ORDER BY event LIMIT 65")
        .map_err(sql)?;
    let mut rs = q.query([]).map_err(sql)?;
    while let Some(r) = rs.next().map_err(sql)? {
        image.origin_metadata.push(serde_json::json!({
            "kind": "materialization", "event": r.get::<_,String>(0).map_err(sql)?,
            "version": r.get::<_,i64>(1).map_err(sql)?.to_string()
        }));
    }
    let mut q = c.prepare("SELECT entity,key_json,event,row_hash FROM import_creates ORDER BY entity,key_json LIMIT 2049").map_err(sql)?;
    let mut rs = q.query([]).map_err(sql)?;
    while let Some(r) = rs.next().map_err(sql)? {
        image.origin_metadata.push(serde_json::json!({
            "kind": "creation", "entity": r.get::<_,String>(0).map_err(sql)?,
            "key": r.get::<_,String>(1).map_err(sql)?, "event": r.get::<_,String>(2).map_err(sql)?,
            "hash": hex(&r.get::<_,Vec<u8>>(3).map_err(sql)?)
        }));
    }
    let mut q = c.prepare("SELECT event,ordinal,entity,key_json,local_row,local_heads FROM import_conflicts ORDER BY event,ordinal LIMIT 65").map_err(sql)?;
    let mut rs = q.query([]).map_err(sql)?;
    while let Some(r) = rs.next().map_err(sql)? {
        image.conflicts.push(serde_json::json!({
            "kind": "conflict", "event": r.get::<_,String>(0).map_err(sql)?,
            "ordinal": r.get::<_,i64>(1).map_err(sql)?.to_string(),
            "entity": r.get::<_,String>(2).map_err(sql)?, "key": r.get::<_,String>(3).map_err(sql)?,
            "row": hex(&r.get::<_,Vec<u8>>(4).map_err(sql)?),
            "heads": hex(&r.get::<_,Vec<u8>>(5).map_err(sql)?)
        }));
    }
    let mut q = c
        .prepare(
            "SELECT event,hash,bytes,reason FROM import_collisions ORDER BY event,hash LIMIT 65",
        )
        .map_err(sql)?;
    let mut rs = q.query([]).map_err(sql)?;
    while let Some(r) = rs.next().map_err(sql)? {
        image.conflicts.push(serde_json::json!({
            "kind": "collision", "event": r.get::<_,String>(0).map_err(sql)?,
            "hash": hex(&r.get::<_,Vec<u8>>(1).map_err(sql)?),
            "bytes": hex(&r.get::<_,Vec<u8>>(2).map_err(sql)?),
            "reason": r.get::<_,String>(3).map_err(sql)?
        }));
    }
    image.row_count = image.rows.len();
    image.core_count = image.cores.len();
    trace.phase("authorize")?;
    authorize_checked(s, &image, &checked)?;
    trace.phase("metadata_verify")?;
    metadata(&image, &events, &checked)?;
    for alternative in &image.conflicts {
        if alternative.get("kind").and_then(|v| v.as_str()) == Some("collision") {
            let e = envelope(unhex(
                alternative["bytes"].as_str().ok_or(Error::Integrity)?,
            )?)?;
            if !s.permits(e.identity.origin) {
                return Err(Error::Trust);
            }
        }
    }
    trace.phase("canonical")?;
    let bytes = serde_jcs::to_vec(&image).map_err(|_| Error::Integrity)?;
    trace.report.image_bytes = bytes.len();
    if bytes.len() > BOOTSTRAP_BYTES {
        return Err(Error::SnapshotTooLarge);
    }
    trace.phase("decode")?;
    decode(&bytes)?;
    trace.phase("stage")?;
    let offer = SnapshotOffer {
        id,
        hash: codec::journal_event_hash(&bytes),
        bytes: bytes.len(),
        chunks: bytes.len().div_ceil(CHUNK),
    };
    save_unit(c, s, &offer, "out", Some(&bytes))?;
    trace.check()?;
    Ok(Captured {
        export: SnapshotExport { offer, bytes },
        image,
        events: checked,
    })
}
pub(super) fn stage_offer(
    store: &CandidateSyncStore<'_>,
    s: &VerifiedSession,
    o: &SnapshotOffer,
    clock: &dyn SyncClock,
    x: &Cancellation,
) -> Result<()> {
    store.write(s, clock, x, |c| stage_offer_in(c, s, o, false))
}
pub(super) fn stage_offer_in(
    c: &Connection,
    s: &VerifiedSession,
    o: &SnapshotOffer,
    signed: bool,
) -> Result<()> {
    if !signed && signed_unit(c, o.id)? {
        return Err(Error::Protocol);
    }
    if !installed(c)? {
        return Err(Error::ActivationPending);
    }
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM bootstrap_units WHERE id=?1)",
            [o.id.to_string()],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if exists {
        unit(c, s, o, "in")?;
        if super::journal::g3::d4_installed(c)? {
            c.execute("UPDATE bootstrap_lifecycle SET state='receiving' WHERE id=?1 AND state IN('interrupted','expired')",[o.id.to_string()]).map_err(sql)?;
        }
        Ok(())
    } else {
        save_unit(c, s, o, "in", None)
    }
}
pub(super) fn stage_chunk(
    store: &CandidateSyncStore<'_>,
    s: &VerifiedSession,
    ch: &SnapshotChunk,
    clock: &dyn SyncClock,
    x: &Cancellation,
) -> Result<()> {
    store.write(s, clock, x, |c| stage_chunk_in(c, s, ch, false))
}
pub(super) fn stage_chunk_in(
    c: &Connection,
    s: &VerifiedSession,
    ch: &SnapshotChunk,
    signed: bool,
) -> Result<()> {
    if !signed && signed_unit(c, ch.offer.id)? {
        return Err(Error::Protocol);
    }
    ch.offer.validate()?;
    if ch.index >= ch.offer.chunks
        || ch.bytes.len() != (ch.offer.bytes - ch.index * CHUNK).min(CHUNK)
        || codec::journal_event_hash(&ch.bytes) != ch.hash
    {
        return Err(Error::Integrity);
    }
    unit(c, s, &ch.offer, "in")?;
    let prior: Option<(Vec<u8>, Vec<u8>)> = c
        .query_row(
            "SELECT hash,bytes FROM bootstrap_chunks WHERE id=?1 AND ordinal=?2",
            params![ch.offer.id.to_string(), ch.index as i64],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(sql)?;
    if let Some((hash, bytes)) = prior {
        if hash != ch.hash || bytes != ch.bytes {
            return Err(Error::Integrity);
        }
    } else {
        c.execute(
            "INSERT INTO bootstrap_chunks VALUES(?1,?2,?3,?4)",
            params![
                ch.offer.id.to_string(),
                ch.index as i64,
                ch.hash.as_slice(),
                ch.bytes
            ],
        )
        .map_err(sql)?;
    }
    bounds(c)
}
fn permit(s: &VerifiedSession, origin: &str) -> Result<()> {
    let origin = Uuid::parse_str(origin).map_err(|_| Error::Integrity)?;
    if !s.permits(origin) {
        return Err(Error::Trust);
    }
    Ok(())
}
/// Scope follows original provenance, never the forwarding transport peer.
/// Apply to new exports, cached exports and received manifests alike.
fn authorize_image(s: &VerifiedSession, image: &SnapshotImage) -> Result<()> {
    let checked = image
        .cores
        .iter()
        .map(|core| ValidatedEvent::parse(envelope(unhex(&core.bytes)?)?))
        .collect::<Result<Vec<_>>>()?;
    authorize_checked(s, image, &checked)
}
fn authorize_checked(
    s: &VerifiedSession,
    image: &SnapshotImage,
    validated: &[ValidatedEvent],
) -> Result<()> {
    for h in &image.high_water {
        permit(s, &h.origin)?;
    }
    let mut local_attestation = false;
    for m in &image.origin_metadata {
        if m.get("kind").and_then(|v| v.as_str()) == Some("local_origin") {
            permit(s, m["origin"].as_str().ok_or(Error::Integrity)?)?;
            local_attestation = true;
        }
    }
    for r in &image.rows {
        let (entity, record) = row(r)?;
        // The single constant migration row contains no user metadata. Every
        // private legacy row needs an explicitly permitted local attestor;
        // an empty origin catalog cannot confer blanket disclosure authority.
        let public_inbox = entity == EntityKind::Projects
            && r.key == [super::migrations::INBOX_PROJECT_ID.to_string()]
            && record
                == RowImage::from([
                    (
                        "id".into(),
                        FieldValue::Text(super::migrations::INBOX_PROJECT_ID.into()),
                    ),
                    ("name".into(), FieldValue::Text("Inbox".into())),
                    (
                        "created_at".into(),
                        FieldValue::Text("1970-01-01T00:00:00Z".into()),
                    ),
                    (
                        "updated_at".into(),
                        FieldValue::Text("1970-01-01T00:00:00Z".into()),
                    ),
                    ("archived_at".into(), FieldValue::Null),
                ]);
        if r.provenance == "legacy_attested" && !local_attestation && !public_inbox {
            return Err(Error::Trust);
        }
    }
    for v in validated {
        super::journal::g3::disclosure_event(v)?;
        permit(s, &v.core().origin_id)?;
        for d in &v.core().dependencies {
            if let Some(r) = &d.event_ref {
                permit(s, &r.origin_id)?;
            }
        }
        for op in &v.core().operations {
            match op {
                Operation::FacetUpdate(u) => {
                    for p in u.expected.values() {
                        if let Some(r) = &p.event_ref {
                            permit(s, &r.origin_id)?;
                        }
                    }
                }
                Operation::RelationRemove(r) => {
                    if let codec::ObservedCreate::Event(r) = &r.observed_create {
                        permit(s, &r.origin_id)?;
                    }
                }
                _ => {}
            }
        }
    }
    for m in &image.conflicts {
        if m.get("kind").and_then(|v| v.as_str()) == Some("collision") {
            let e = envelope(unhex(m["bytes"].as_str().ok_or(Error::Integrity)?)?)?;
            super::journal::g3::disclosure_event(&ValidatedEvent::parse(e.clone())?)?;
            permit(s, &e.identity.origin.to_string())?;
        }
    }
    Ok(())
}
fn metadata(
    image: &SnapshotImage,
    events: &[Envelope],
    validated: &[ValidatedEvent],
) -> Result<()> {
    let start = Instant::now();
    // Bounded borrowed indexes, not another history/projection. Avoid repeated
    // full-image scans and UUID formatting for every facet of 2,048 rows.
    // All original field/hash/provenance checks below remain in force.
    let event_indices: BTreeMap<&str, usize> = validated
        .iter()
        .enumerate()
        .map(|(i, v)| (v.core().event_id.as_str(), i))
        .collect();
    let mut row_index = BTreeMap::new();
    for r in &image.rows {
        if row_index
            .insert((r.entity.as_str(), r.key.clone()), r)
            .is_some()
        {
            return Err(Error::Integrity);
        }
    }
    let mut seen = BTreeSet::new();
    let mut local = BTreeSet::new();
    let mut proofs = BTreeSet::new();
    for m in &image.origin_metadata {
        if start.elapsed() > Duration::from_secs(5) {
            return Err(Error::SnapshotTooLarge);
        }
        let fields = m.as_object().ok_or(Error::Integrity)?;
        let kind = m
            .get("kind")
            .and_then(|v| v.as_str())
            .ok_or(Error::Integrity)?;
        let text = |key: &str| m.get(key).and_then(|v| v.as_str()).ok_or(Error::Integrity);
        let identity = match kind {
            "local_origin" => {
                if fields.len() != 8 {
                    return Err(Error::Integrity);
                }
                let origin = text("origin")?;
                let inc = text("incarnation")?;
                codec::validate_canonical_uuid(origin).map_err(|_| Error::Integrity)?;
                codec::validate_canonical_uuid(inc).map_err(|_| Error::Integrity)?;
                let seq = text("seq")?;
                codec::validate_decimal(seq).map_err(|_| Error::Integrity)?;
                let hash = text("hash")?;
                codec::validate_hash_hex(hash).map_err(|_| Error::Integrity)?;
                codec::validate_timestamp(text("opened")?).map_err(|_| Error::Integrity)?;
                match text("status")? {
                    "active" if m.get("sealed").is_some_and(|v| v.is_null()) => {}
                    "sealed" => {
                        codec::validate_timestamp(text("sealed")?).map_err(|_| Error::Integrity)?
                    }
                    _ => return Err(Error::Integrity),
                }
                if seq == "0" {
                    if hash != codec::hash_hex(&[0; 32]) {
                        return Err(Error::Integrity);
                    }
                } else if !image.high_water.iter().any(|h| {
                    h.origin == origin && h.incarnation == inc && h.seq == seq && h.hash == hash
                }) {
                    return Err(Error::Integrity);
                }
                local.insert((origin.to_owned(), inc.to_owned()));
                format!("origin:{origin}:{inc}")
            }
            "materialization" | "d4_materialization" => {
                if kind == "d4_materialization" && image.profile != BOOTSTRAP_D4_PROFILE {
                    return Err(Error::Integrity);
                }
                if fields.len() != 3 || text("version")? != "1" {
                    return Err(Error::Integrity);
                }
                let id = text("event")?;
                let i = *event_indices.get(id).ok_or(Error::Integrity)?;
                if !image.cores[i].materialized || image.cores[i].outcome != "applied" {
                    return Err(Error::Integrity);
                }
                proofs.insert(id.to_owned());
                format!("{kind}:{id}")
            }
            "facet" => {
                if image.profile != BOOTSTRAP_D4_PROFILE || fields.len() != 6 {
                    return Err(Error::Integrity);
                }
                let entity = EntityKind::from_str(text("entity")?).map_err(|_| Error::Integrity)?;
                let key: Vec<String> =
                    serde_json::from_value(m["key"].clone()).map_err(|_| Error::Integrity)?;
                let facet = text("facet")?;
                let def = codec::facets_of(entity)
                    .iter()
                    .find(|f| f.name == facet)
                    .ok_or(Error::Integrity)?;
                let v = &validated[*event_indices.get(text("event")?).ok_or(Error::Integrity)?];
                let after = v
                    .core()
                    .operations
                    .iter()
                    .find_map(|o| match o {
                        Operation::RecordCreate(r) if r.entity == entity && r.key == key => {
                            Some(&r.after)
                        }
                        Operation::FacetUpdate(u)
                            if u.entity == entity
                                && u.key == key
                                && u.expected.contains_key(facet) =>
                        {
                            Some(&u.after)
                        }
                        _ => None,
                    })
                    .ok_or(Error::Integrity)?;
                let state = def
                    .fields
                    .iter()
                    .map(|f| {
                        after
                            .get(*f)
                            .cloned()
                            .map(|v| ((*f).to_string(), v))
                            .ok_or(Error::Integrity)
                    })
                    .collect::<Result<RowImage>>()?;
                if codec::hash_hex(
                    &codec::facet_state_hash(entity, facet, &key, &state)
                        .map_err(|_| Error::Integrity)?,
                ) != text("hash")?
                {
                    return Err(Error::Integrity);
                }
                let current = row_index
                    .get(&(entity.as_str(), key.clone()))
                    .ok_or(Error::Integrity)?;
                let (_, record) = row(current)?;
                if def.fields.iter().any(|f| record.get(*f) != after.get(*f)) {
                    return Err(Error::Integrity);
                }
                format!(
                    "facet:{}:{}:{facet}",
                    entity.as_str(),
                    serde_json::to_string(&key).map_err(|_| Error::Integrity)?
                )
            }
            "review_attestation" => {
                if image.profile != BOOTSTRAP_D4_PROFILE
                    || fields.len() != 3
                    || text("provenance")? != "legacy_attested"
                {
                    return Err(Error::Integrity);
                }
                let id = text("event")?;
                let v = validated
                    .iter()
                    .find(|v| v.envelope().identity.event.to_string() == id)
                    .ok_or(Error::Integrity)?;
                if !v
                    .core()
                    .operations
                    .iter()
                    .any(|op| matches!(op,Operation::FacetUpdate(u) if u.review_proof.is_some()))
                {
                    return Err(Error::Integrity);
                }
                format!("review_attestation:{id}")
            }
            "creation" => {
                if fields.len() != 5 {
                    return Err(Error::Integrity);
                }
                let id = text("event")?;
                let v = validated
                    .iter()
                    .find(|v| v.envelope().identity.event.to_string() == id)
                    .ok_or(Error::Integrity)?;
                let entity = EntityKind::from_str(text("entity")?).map_err(|_| Error::Integrity)?;
                let key: Vec<String> =
                    serde_json::from_str(text("key")?).map_err(|_| Error::Integrity)?;
                let creation = v
                    .core()
                    .operations
                    .iter()
                    .find_map(|o| match o {
                        Operation::RecordCreate(r) if r.entity == entity && r.key == key => Some(r),
                        _ => None,
                    })
                    .ok_or(Error::Integrity)?;
                if codec::hash_hex(
                    &codec::facet_state_hash(entity, "record", &key, &creation.after)
                        .map_err(|_| Error::Integrity)?,
                ) != text("hash")?
                {
                    return Err(Error::Integrity);
                }
                format!("create:{}:{}", entity.as_str(), text("key")?)
            }
            _ => return Err(Error::Integrity),
        };
        if !seen.insert(identity) {
            return Err(Error::Integrity);
        }
    }
    for (i, e) in events.iter().enumerate() {
        if image.cores[i].materialized
            && !local.contains(&(
                e.identity.origin.to_string(),
                e.identity.incarnation.to_string(),
            ))
            && !proofs.contains(&e.identity.event.to_string())
        {
            return Err(Error::Integrity);
        }
    }
    if image.profile == BOOTSTRAP_D4_PROFILE {
        for v in validated {
            if v.core()
                .operations
                .iter()
                .any(|op| matches!(op,Operation::FacetUpdate(u) if u.review_proof.is_some()))
                && !seen.contains(&format!(
                    "review_attestation:{}",
                    v.envelope().identity.event
                ))
            {
                return Err(Error::Integrity);
            }
        }
        for r in &image.rows {
            if r.provenance == "m05" {
                let (entity, _) = row(r)?;
                for f in codec::facets_of(entity) {
                    let key = serde_json::to_string(&r.key).map_err(|_| Error::Integrity)?;
                    if !seen.contains(&format!("facet:{}:{key}:{}", entity.as_str(), f.name)) {
                        return Err(Error::Integrity);
                    }
                }
            }
        }
    }
    for m in &image.conflicts {
        if start.elapsed() > Duration::from_secs(5) {
            return Err(Error::SnapshotTooLarge);
        }
        let fields = m.as_object().ok_or(Error::Integrity)?;
        let text = |key: &str| m.get(key).and_then(|v| v.as_str()).ok_or(Error::Integrity);
        match text("kind")? {
            "conflict" => {
                if fields.len() != 7 {
                    return Err(Error::Integrity);
                }
                let id = text("event")?;
                if !events.iter().any(|e| e.identity.event.to_string() == id) {
                    return Err(Error::Integrity);
                }
                EntityKind::from_str(text("entity")?).map_err(|_| Error::Integrity)?;
                text("ordinal")?
                    .parse::<usize>()
                    .ok()
                    .filter(|n| *n < 4096)
                    .ok_or(Error::Integrity)?;
                let _: Vec<String> =
                    serde_json::from_str(text("key")?).map_err(|_| Error::Integrity)?;
                let _: serde_json::Value =
                    serde_json::from_slice(&unhex(text("row")?)?).map_err(|_| Error::Integrity)?;
                let _: serde_json::Value = serde_json::from_slice(&unhex(text("heads")?)?)
                    .map_err(|_| Error::Integrity)?;
            }
            "collision" => {
                if fields.len() != 5 || !["identity", "bundle", "stream"].contains(&text("reason")?)
                {
                    return Err(Error::Integrity);
                }
                let e = envelope(unhex(text("bytes")?)?)?;
                if e.identity.event.to_string() != text("event")?
                    || codec::hash_hex(&e.identity.hash) != text("hash")?
                {
                    return Err(Error::Integrity);
                }
            }
            _ => return Err(Error::Integrity),
        }
    }
    Ok(())
}
pub(super) struct VerifiedImage {
    image: SnapshotImage,
    events: Vec<ValidatedEvent>,
    order: Vec<usize>,
    offer: SnapshotOffer,
    signed: bool,
}
impl VerifiedImage {
    pub(super) fn with_signed_provenance(mut self) -> Self {
        self.signed = true;
        self
    }
    pub fn image(&self) -> &SnapshotImage {
        &self.image
    }
    pub fn events(&self) -> &[ValidatedEvent] {
        &self.events
    }
}
pub(super) fn verify(
    c: &Connection,
    s: &VerifiedSession,
    o: &SnapshotOffer,
) -> Result<VerifiedImage> {
    unit(c, s, o, "in")?;
    let mut bytes = Vec::with_capacity(o.bytes);
    let mut q = c
        .prepare(
            "SELECT ordinal,hash,bytes FROM bootstrap_chunks WHERE id=?1 ORDER BY ordinal LIMIT 17",
        )
        .map_err(sql)?;
    let mut rows = q.query([o.id.to_string()]).map_err(sql)?;
    let mut index = 0;
    while let Some(r) = rows.next().map_err(sql)? {
        let n: i64 = r.get(0).map_err(sql)?;
        let hash: Vec<u8> = r.get(1).map_err(sql)?;
        let b: Vec<u8> = r.get(2).map_err(sql)?;
        if index >= o.chunks
            || n != index as i64
            || b.len() != (o.bytes - index * CHUNK).min(CHUNK)
            || codec::journal_event_hash(&b).as_slice() != hash
        {
            return Err(Error::Integrity);
        }
        bytes.extend(b);
        index += 1;
    }
    if index != o.chunks || bytes.len() != o.bytes {
        return Err(Error::Protocol);
    }
    if codec::journal_event_hash(&bytes) != o.hash {
        return Err(Error::Integrity);
    }
    let image = decode(&bytes)?;
    if image.id != o.id.to_string() || image.network != s.binding().network.to_string() {
        return Err(Error::Trust);
    }
    let mut events = Vec::new();
    let mut checked = Vec::new();
    for core in &image.cores {
        Outcome::parse(&core.outcome)?;
        let value = ValidatedEvent::from_bytes(unhex(&core.bytes)?)?;
        let e = value.envelope().clone();
        if !s.permits(e.identity.origin) {
            return Err(Error::Trust);
        }
        events.push(e);
        checked.push(value);
    }
    authorize_checked(s, &image, &checked)?;
    metadata(&image, &events, &checked)?;
    for m in &image.conflicts {
        if m.get("kind").and_then(|v| v.as_str()) == Some("collision") {
            let e = envelope(unhex(m["bytes"].as_str().ok_or(Error::Integrity)?)?)?;
            if !s.permits(e.identity.origin) {
                return Err(Error::Trust);
            }
        }
    }
    let (order, high) = graph_checked(&events, &checked)?;
    if high != image.high_water {
        return Err(Error::Integrity);
    }
    let mut creations = BTreeSet::new();
    for value in &checked {
        for op in &value.core().operations {
            if let Operation::RecordCreate(create) = op {
                creations.insert((create.entity, create.key.clone()));
            }
        }
    }
    let mut seen = BTreeSet::new();
    for r in &image.rows {
        let (e, _) = row(r)?;
        if r.provenance == "m05" && !creations.contains(&(e, r.key.clone())) {
            return Err(Error::Integrity);
        }
        if !seen.insert((e, r.key.clone())) {
            return Err(Error::Integrity);
        }
    }
    Ok(VerifiedImage {
        image,
        events: checked,
        order,
        offer: o.clone(),
        signed: false,
    })
}
pub(super) fn publish(
    store: &CandidateSyncStore<'_>,
    s: &VerifiedSession,
    o: &SnapshotOffer,
    clock: &dyn SyncClock,
    x: &Cancellation,
) -> Result<SnapshotReceipt> {
    store.write(s, clock, x, |c| {
        publish_in(c, s, o, clock, x, false, |c, e| {
            sync_store::retain_in(c, s, e, clock, x)
        })
    })
}
pub(super) fn publish_in(
    c: &Connection,
    s: &VerifiedSession,
    o: &SnapshotOffer,
    clock: &dyn SyncClock,
    x: &Cancellation,
    signed: bool,
    retain: impl FnMut(&Connection, &ValidatedEvent) -> Result<Receipt>,
) -> Result<SnapshotReceipt> {
    let verified = verify(c, s, o)?;
    publish_verified(
        c,
        s,
        o,
        clock,
        x,
        if signed {
            verified.with_signed_provenance()
        } else {
            verified
        },
        retain,
    )
}
pub(super) fn publish_verified(
    c: &Connection,
    s: &VerifiedSession,
    o: &SnapshotOffer,
    clock: &dyn SyncClock,
    x: &Cancellation,
    verified: VerifiedImage,
    mut retain: impl FnMut(&Connection, &ValidatedEvent) -> Result<Receipt>,
) -> Result<SnapshotReceipt> {
    if verified.offer != *o {
        return Err(Error::Integrity);
    }
    let signed = verified.signed;
    let VerifiedImage {
        image,
        events,
        order,
        ..
    } = verified;
    let mut trace = super::bootstrap_trace::Capture::new();
    if !signed && signed_unit(c, o.id)? {
        return Err(Error::Protocol);
    }
    trace.report.phase = "publish_verify";
    trace.report.image_bytes = o.bytes;
    let result = (|| {
        let previous = unit(c, s, o, "in")?;
        trace.report.events = events.len();
        trace.report.rows = image.rows.len();
        trace.restart_budget();
        trace.phase("publish_apply")?;
        if !["staged", "unsupported", "deferred"].contains(&previous.as_str()) {
            return Ok(SnapshotReceipt {
                offer: o.clone(),
                outcome: Outcome::parse(&previous)?,
            });
        }
        let mut outcome = Outcome::CleanlyApplied;
        if image.profile == BOOTSTRAP_D4_PROFILE && !super::journal::g3::d4_installed(c)? {
            outcome = Outcome::UnsupportedImportPolicy;
        }
        if !image.conflicts.is_empty() || image.cores.iter().any(|c| c.outcome == "conflict") {
            outcome = Outcome::ConflictRetained
        } else if image
            .cores
            .iter()
            .any(|c| c.outcome != "applied" || !c.materialized)
        {
            outcome = Outcome::UnsupportedImportPolicy
        }
        // A legacy attestation is never promoted into an invented M05 creation.
        for r in &image.rows {
            let (e, expected) = row(r)?;
            if outcome == Outcome::CleanlyApplied
                && r.provenance == "legacy_attested"
                && import_view::row(c, e, &r.key)?.as_ref() != Some(&expected)
            {
                outcome = Outcome::UnsupportedImportPolicy
            }
        }
        if outcome == Outcome::CleanlyApplied {
            c.execute_batch("SAVEPOINT bootstrap_publish")
                .map_err(sql)?;
            for i in order {
                // Five-second budget per retained event; the event count is
                // capped, so total work stays bounded.
                trace.restart_budget();
                sync_store::authorize(c, s, clock, x)?;
                let r = retain(c, &events[i])?;
                if r.outcome == Outcome::RejectedIntegrity {
                    return Err(Error::Integrity);
                }
                if !r.outcome.is_ack() {
                    outcome = r.outcome;
                } else if r.outcome == Outcome::ConflictRetained {
                    outcome = Outcome::ConflictRetained
                }
                trace.check()?;
            }
            trace.restart_budget();
            trace.phase("publish_projection")?;
            if outcome == Outcome::CleanlyApplied {
                for r in &image.rows {
                    let (e, expected) = row(r)?;
                    if import_view::row(c, e, &r.key)?.as_ref() != Some(&expected) {
                        return Err(Error::Integrity);
                    }
                }
            }
            if outcome != Outcome::CleanlyApplied {
                c.execute_batch("ROLLBACK TO bootstrap_publish")
                    .map_err(sql)?;
            }
            c.execute_batch("RELEASE bootstrap_publish").map_err(sql)?;
        }
        c.execute(
            "UPDATE bootstrap_units SET outcome=?2 WHERE id=?1",
            params![o.id.to_string(), outcome.code()],
        )
        .map_err(sql)?;
        Ok(SnapshotReceipt {
            offer: o.clone(),
            outcome,
        })
    })();
    trace.report.failure = result.as_ref().err().copied();
    result
}
pub(super) fn receipt(
    store: &CandidateSyncStore<'_>,
    s: &VerifiedSession,
    r: &SnapshotReceipt,
    clock: &dyn SyncClock,
    x: &Cancellation,
) -> Result<()> {
    store.write(s, clock, x, |c| receipt_in(c, s, r, false))
}
pub(super) fn receipt_in(
    c: &Connection,
    s: &VerifiedSession,
    r: &SnapshotReceipt,
    signed: bool,
) -> Result<()> {
    if !signed && signed_unit(c, r.offer.id)? {
        return Err(Error::Protocol);
    }
    let prior = unit(c, s, &r.offer, "out")?;
    let session: String = c
        .query_row(
            "SELECT session FROM bootstrap_units WHERE id=?1",
            [r.offer.id.to_string()],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if session != s.binding().session.to_string() {
        return Err(Error::Integrity);
    }
    if Outcome::parse(&prior).is_ok_and(|o| o.is_ack()) && prior != r.outcome.code() {
        return Err(Error::Integrity);
    }
    c.execute(
        "UPDATE bootstrap_units SET outcome=?2 WHERE id=?1",
        params![r.offer.id.to_string(), r.outcome.code()],
    )
    .map_err(sql)?;
    Ok(())
}
#[cfg(any(
    test,
    all(
        target_os = "android",
        feature = "android-identity-tests",
        debug_assertions
    )
))]
pub(crate) fn install(store: &super::capture_store::CaptureStore) -> Result<()> {
    let mut c = store.connection.lock().map_err(|_| Error::Storage)?;
    let tx = c.transaction().map_err(sql)?;
    tx.execute_batch(include_str!("import_bootstrap.sql"))
        .map_err(sql)?;
    tx.commit().map_err(sql)
}

pub(super) fn signed_unit(c: &Connection, id: Uuid) -> Result<bool> {
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='r9_bootstrap_evidence')",
            [],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if !exists {
        return Ok(false);
    }
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM r9_bootstrap_evidence WHERE id=?1)",
        [id.to_string()],
        |r| r.get(0),
    )
    .map_err(sql)
}
