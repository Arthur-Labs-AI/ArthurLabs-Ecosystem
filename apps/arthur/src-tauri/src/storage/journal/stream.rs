//! Local activation/replay cache. Rebuilt from retained immutable cores, never a
//! second canonical store. Local bundle rowid is only replay insertion order;
//! it never enters a core, causal reference, or cross-device ordering contract.
use super::codec::{self, EntityKind, EventRef, FieldValue, Operation, RowImage};
use super::reducer::{Baselines, FacetId, FacetPrior, FacetPriors, KnownRefs, ObservedEffect};
use super::sql_effects::{self as sql, Key};
use super::storage::{JournalError as E, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub(super) type HeadKey = (EntityKind, Vec<String>, String);
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Head {
    pub event: EventRef,
    pub hash: [u8; 32],
}
#[derive(Default)]
pub(super) struct History {
    pub records: KnownRefs,
    pub heads: BTreeMap<HeadKey, Head>,
    pub removed: BTreeSet<Key>,
}
pub(super) struct Stream {
    pub origin: String,
    pub incarnation: String,
    pub seq: i64,
    pub hash: [u8; 32],
    pub history: History,
    pub legacy: BTreeMap<Key, BTreeMap<String, [u8; 32]>>,
}

pub(super) fn policy(c: &Connection) -> Result<()> {
    if !c.is_autocommit() {
        return Err(E::Unavailable);
    }
    let version: i64 = c
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|_| E::WrongSchema)?;
    if version != 10 {
        return Err(E::WrongSchema);
    }
    for (pragma, expected) in [
        ("PRAGMA foreign_keys", 1),
        ("PRAGMA synchronous", 2),
        ("PRAGMA query_only", 0),
    ] {
        let actual: i64 = c
            .query_row(pragma, [], |r| r.get(0))
            .map_err(|_| E::Unavailable)?;
        if actual != expected {
            return Err(E::Unavailable);
        }
    }
    empty(c)
}
pub(super) fn empty(c: &Connection) -> Result<()> {
    for table in ["sync_write_context", "sync_effects"] {
        let n: i64 = c
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .map_err(|_| E::Unavailable)?;
        if n != 0 {
            return Err(E::TransientState);
        }
    }
    Ok(())
}

pub(super) fn facet_hash(
    entity: EntityKind,
    key: &[String],
    facet: &str,
    row: &RowImage,
) -> Result<[u8; 32]> {
    let state = match codec::facets_of(entity).iter().find(|f| f.name == facet) {
        Some(def) => def
            .fields
            .iter()
            .map(|f| {
                row.get(*f)
                    .cloned()
                    .map(|v| ((*f).to_owned(), v))
                    .ok_or(E::MissingPrior)
            })
            .collect::<Result<RowImage>>()?,
        None if facet == "record" => row.clone(),
        _ => return Err(E::MissingPrior),
    };
    codec::facet_state_hash(entity, facet, key, &state).map_err(|_| E::Codec)
}

pub(super) fn updates(ops: &[Operation], event: &EventRef) -> Result<BTreeMap<HeadKey, Head>> {
    let mut result = BTreeMap::new();
    for op in ops {
        let (entity, key) = (op.entity(), op.key().to_vec());
        let mut push = |facet: &str, hash: [u8; 32]| {
            result.insert(
                (entity, key.clone(), facet.to_owned()),
                Head {
                    event: event.clone(),
                    hash,
                },
            );
        };
        match op {
            Operation::RecordCreate(c) => {
                push("record", facet_hash(entity, &key, "record", &c.after)?);
                for f in codec::facets_of(entity) {
                    push(f.name, facet_hash(entity, &key, f.name, &c.after)?);
                }
            }
            Operation::FacetUpdate(u) => {
                for facet in u.expected.keys() {
                    push(facet, facet_hash(entity, &key, facet, &u.after)?);
                }
            }
            Operation::RelationRemove(r) => {
                // Versioned local derived tombstone; original creation stays in
                // History.records and in relation.remove.observedCreate.
                let before = codec::facet_state_hash(entity, "record", &key, &r.before)
                    .map_err(|_| E::Codec)?;
                let state = RowImage::from([(
                    "removed_model_v1".into(),
                    FieldValue::Text(codec::hash_hex(&before)),
                )]);
                push(
                    "record",
                    codec::facet_state_hash(entity, "record", &key, &state)
                        .map_err(|_| E::Codec)?,
                );
            }
        }
    }
    Ok(result)
}

impl History {
    pub fn apply(&mut self, ops: &[Operation], event: &EventRef) -> Result<()> {
        for op in ops {
            let key = (op.entity(), op.key().to_vec());
            match op {
                Operation::RecordCreate(_) => {
                    if self.records.contains_key(&key) || self.removed.contains(&key) {
                        return Err(E::CorruptCapability);
                    }
                    self.records.insert(key, event.clone());
                }
                Operation::RelationRemove(_) => {
                    self.removed.insert(key);
                }
                _ => {}
            }
        }
        self.heads.extend(updates(ops, event)?);
        Ok(())
    }
}

pub(super) fn stored_head(c: &Connection, key: &HeadKey) -> Result<Option<(String, Vec<u8>)>> {
    c.query_row("SELECT event_id,state_hash FROM sync_entity_heads WHERE entity_kind=?1 AND entity_key=?2 AND facet=?3",
        params![key.0.as_str(),sql::key_json(&key.1)?,key.2],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_|E::Sql)
}

fn recover_history(c: &Connection, budget: u64) -> Result<History> {
    let mut result = History::default();
    let mut tips: BTreeMap<(String, String), (i64, [u8; 32])> = BTreeMap::new();
    let mut q=c.prepare("SELECT event_id,bundle_id,origin_id,incarnation,origin_seq,canonical_bytes,canonical_hash,previous_hash,raw_effect_count,committed_at FROM sync_bundles ORDER BY rowid").map_err(|_|E::Sql)?;
    let mut rows = q.query([]).map_err(|_| E::Sql)?;
    while let Some(r) = rows.next().map_err(|_| E::Sql)? {
        let bytes: Vec<u8> = r.get(5).map_err(|_| E::CorruptCapability)?;
        let core = codec::decode_core_strict(&bytes).map_err(|_| E::CorruptCapability)?;
        let hash = codec::journal_event_hash(&bytes);
        let expected_hash: Vec<u8> = r.get(6).map_err(|_| E::CorruptCapability)?;
        let previous: Vec<u8> = r.get(7).map_err(|_| E::CorruptCapability)?;
        let event: String = r.get(0).map_err(|_| E::CorruptCapability)?;
        let bundle: String = r.get(1).map_err(|_| E::CorruptCapability)?;
        let origin: String = r.get(2).map_err(|_| E::CorruptCapability)?;
        let incarnation: String = r.get(3).map_err(|_| E::CorruptCapability)?;
        let seq: i64 = r.get(4).map_err(|_| E::CorruptCapability)?;
        let raw: i64 = r.get(8).map_err(|_| E::CorruptCapability)?;
        let committed: String = r.get(9).map_err(|_| E::CorruptCapability)?;
        let tip = tips
            .entry((origin.clone(), incarnation.clone()))
            .or_insert((0, [0; 32]));
        if tip.0.checked_add(1) != Some(seq)
            || previous != tip.1
            || expected_hash != hash
            || core.event_id != event
            || core.bundle_id != bundle
            || core.origin_id != origin
            || core.origin_incarnation != incarnation
            || core.origin_seq != seq.to_string()
            || core.previous_event_hash != codec::hash_hex(&tip.1)
            || core.raw_effect_count != raw.to_string()
            || core.committed_at != committed
        {
            return Err(E::CorruptCapability);
        }
        let reference = EventRef {
            origin_id: origin,
            incarnation,
            seq: seq.to_string(),
            event_id: event,
            hash: codec::hash_hex(&hash),
        };
        result.apply(&core.operations, &reference)?;
        *tip = (seq, hash);
        check_cache_bound(&result, 0, budget)?;
    }
    let mut origins = c
        .prepare(
            "SELECT origin_id,incarnation,last_seq,last_hash,opened_at,sealed_at FROM sync_origins",
        )
        .map_err(|_| E::Sql)?;
    let mut rows = origins.query([]).map_err(|_| E::Sql)?;
    while let Some(r) = rows.next().map_err(|_| E::Sql)? {
        let o: String = r.get(0).map_err(|_| E::CorruptCapability)?;
        let i: String = r.get(1).map_err(|_| E::CorruptCapability)?;
        codec::validate_canonical_uuid(&o).map_err(|_| E::CorruptCapability)?;
        codec::validate_canonical_uuid(&i).map_err(|_| E::CorruptCapability)?;
        let opened: String = r.get(4).map_err(|_| E::CorruptCapability)?;
        codec::validate_timestamp(&opened).map_err(|_| E::CorruptCapability)?;
        let sealed: Option<String> = r.get(5).map_err(|_| E::CorruptCapability)?;
        if let Some(at) = sealed {
            codec::validate_timestamp(&at).map_err(|_| E::CorruptCapability)?;
        }
        let seq: i64 = r.get(2).map_err(|_| E::CorruptCapability)?;
        let hash: Vec<u8> = r.get(3).map_err(|_| E::CorruptCapability)?;
        if (seq, hash)
            != tips
                .remove(&(o, i))
                .map(|(s, h)| (s, h.to_vec()))
                .unwrap_or((0, vec![0; 32]))
        {
            return Err(E::CorruptCapability);
        }
    }
    if !tips.is_empty() {
        return Err(E::CorruptCapability);
    }
    let mut heads = c
        .prepare("SELECT entity_kind,entity_key,facet,event_id,state_hash FROM sync_entity_heads")
        .map_err(|_| E::Sql)?;
    let mut rows = heads.query([]).map_err(|_| E::Sql)?;
    let mut count = 0;
    while let Some(r) = rows.next().map_err(|_| E::Sql)? {
        let e: String = r.get(0).map_err(|_| E::CorruptCapability)?;
        let e = EntityKind::from_str(&e).map_err(|_| E::CorruptCapability)?;
        let k: String = r.get(1).map_err(|_| E::CorruptCapability)?;
        let k = sql::key(e, &k)?;
        let f: String = r.get(2).map_err(|_| E::CorruptCapability)?;
        let expected = result.heads.get(&(e, k, f)).ok_or(E::MissingPrior)?;
        let event: String = r.get(3).map_err(|_| E::CorruptCapability)?;
        let hash: Vec<u8> = r.get(4).map_err(|_| E::CorruptCapability)?;
        if event != expected.event.event_id || hash != expected.hash {
            return Err(E::MissingPrior);
        }
        count += 1;
    }
    if count != result.heads.len() {
        return Err(E::MissingPrior);
    }
    Ok(result)
}

/// Read-only identity reconciliation using the same retained-history validation
/// as activation. No new origin, event, or sequence is allocated here.
pub(super) fn reconcile_event(
    c: &Connection,
    event_id: Uuid,
    budget: u64,
) -> Result<Option<EventRef>> {
    recover_history(c, budget)?;
    c.query_row("SELECT origin_id,incarnation,origin_seq,event_id,canonical_hash FROM sync_bundles WHERE event_id=?1", [event_id.to_string()], |r| {
        let hash: Vec<u8> = r.get(4)?;
        Ok(EventRef { origin_id: r.get(0)?, incarnation: r.get(1)?, seq: r.get::<_, i64>(2)?.to_string(), event_id: r.get(3)?, hash: codec::hash_hex(&hash.try_into().map_err(|_| rusqlite::Error::InvalidQuery)?) })
    }).optional().map_err(|e| e.into())
}

fn check_cache_bound(history: &History, legacy_bytes: u64, budget: u64) -> Result<()> {
    // Explicit conservative memory admission: 1 KiB bookkeeping per record/head
    // plus variable UTF-8 keys. Kept separate from persisted quota accounting.
    let mut n = legacy_bytes;
    for (e, k) in history.records.keys() {
        let _ = e;
        n = n
            .checked_add(1024 + k.iter().map(|s| s.len() as u64).sum::<u64>())
            .ok_or(E::MetadataQuota)?;
    }
    for (_, k, _) in history.heads.keys() {
        n = n
            .checked_add(1024 + k.iter().map(|s| s.len() as u64).sum::<u64>())
            .ok_or(E::MetadataQuota)?;
    }
    for (_, k) in &history.removed {
        n = n
            .checked_add(1024 + k.iter().map(|s| s.len() as u64).sum::<u64>())
            .ok_or(E::MetadataQuota)?;
    }
    if n > budget {
        return Err(E::MetadataQuota);
    }
    Ok(())
}

pub(super) fn initialize(c: &Connection, now: &str, budget: u64) -> Result<Stream> {
    let history = recover_history(c, budget)?;
    let pointer: Option<(String, String)> = c
        .query_row(
            "SELECT origin_id,active_incarnation FROM sync_local WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| E::CorruptCapability)?;
    let active: Option<(String, String)> = c
        .query_row(
            "SELECT origin_id,incarnation FROM sync_origins WHERE status='active'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| E::CorruptCapability)?;
    let count: i64 = c
        .query_row("SELECT count(*) FROM sync_origins", [], |r| r.get(0))
        .map_err(|_| E::Sql)?;
    let origin = match (&pointer, &active) {
        (None, None) if count == 0 => Uuid::new_v4().to_string(),
        (Some(p), Some(a)) if p == a => p.0.clone(),
        _ => return Err(E::CorruptCapability),
    };
    let mut legacy = BTreeMap::new();
    let mut seen = BTreeSet::new();
    let mut legacy_bytes = 0u64;
    for entity in sql::ENTITIES {
        let query = format!(
            "SELECT {} FROM {}",
            entity.key_fields().join(","),
            entity.as_str()
        );
        let mut q = c.prepare(&query).map_err(|_| E::Sql)?;
        let mut rows = q.query([]).map_err(|_| E::Sql)?;
        while let Some(r) = rows.next().map_err(|_| E::Sql)? {
            let mut key = Vec::new();
            for i in 0..entity.key_fields().len() {
                key.push(if entity.key_element_is_decimal(i) {
                    r.get::<_, i64>(i)
                        .map_err(|_| E::InvalidEffect)?
                        .to_string()
                } else {
                    r.get(i).map_err(|_| E::InvalidEffect)?
                });
            }
            let row = sql::reread(c, entity, &key)?.ok_or(E::MissingFinalProjection)?;
            if entity == EntityKind::KnowledgeObjects
                && matches!(row.get("current_revision_id"), Some(FieldValue::Null))
            {
                return Err(E::IncompleteClosure);
            }
            let identity = (entity, key.clone());
            seen.insert(identity.clone());
            if history.removed.contains(&identity) {
                return Err(E::CorruptCapability);
            }
            for facet in codec::facets_of(entity) {
                if let Some(h) = history.heads.get(&(entity, key.clone(), facet.name.into())) {
                    if h.hash != facet_hash(entity, &key, facet.name, &row)? {
                        return Err(E::MissingPrior);
                    }
                }
            }
            if !history.records.contains_key(&identity) {
                let mut hashes = BTreeMap::from([(
                    "#record".into(),
                    codec::facet_state_hash(entity, "record", &key, &row).map_err(|_| E::Codec)?,
                )]);
                for f in codec::facets_of(entity) {
                    hashes.insert(f.name.into(), facet_hash(entity, &key, f.name, &row)?);
                }
                legacy_bytes = legacy_bytes
                    .checked_add(1024 + key.iter().map(|s| s.len() as u64).sum::<u64>())
                    .ok_or(E::MetadataQuota)?;
                check_cache_bound(&history, legacy_bytes, budget)?;
                legacy.insert(identity, hashes);
            } else if !entity.is_facet_mutable() {
                if history
                    .heads
                    .get(&(entity, key.clone(), "record".into()))
                    .ok_or(E::MissingPrior)?
                    .hash
                    != facet_hash(entity, &key, "record", &row)?
                {
                    return Err(E::CorruptCapability);
                }
            }
        }
    }
    if history
        .records
        .keys()
        .any(|k| !seen.contains(k) && !history.removed.contains(k))
    {
        return Err(E::CorruptCapability);
    }
    if let Some((o, i)) = active {
        c.execute("UPDATE sync_origins SET status='sealed',sealed_at=?3 WHERE origin_id=?1 AND incarnation=?2",params![o,i,now]).map_err(|_|E::Sql)?;
    }
    let incarnation = Uuid::new_v4().to_string();
    c.execute("INSERT INTO sync_origins(origin_id,incarnation,status,opened_at) VALUES(?1,?2,'active',?3)",params![origin,incarnation,now]).map_err(|_|E::Sql)?;
    c.execute("INSERT INTO sync_local(singleton,origin_id,active_incarnation,bootstrap_required) VALUES(1,?1,?2,1) ON CONFLICT(singleton) DO UPDATE SET active_incarnation=excluded.active_incarnation",params![origin,incarnation]).map_err(|_|E::Sql)?;
    Ok(Stream {
        origin,
        incarnation,
        seq: 0,
        hash: [0; 32],
        history,
        legacy,
    })
}

impl Stream {
    pub fn admit_cache(
        &self,
        ops: &[Operation],
        heads: &BTreeMap<HeadKey, Head>,
        budget: u64,
    ) -> Result<()> {
        let mut extra = 0u64;
        // Conservative bound includes replacements as temporary allocations.
        for (_, key) in self.legacy.keys() {
            extra = extra
                .checked_add(1024 + key.iter().map(|s| s.len() as u64).sum::<u64>())
                .ok_or(E::MetadataQuota)?;
        }
        for (_, key, _) in heads.keys() {
            extra = extra
                .checked_add(1024 + key.iter().map(|s| s.len() as u64).sum::<u64>())
                .ok_or(E::MetadataQuota)?;
        }
        for op in ops {
            if matches!(
                op,
                Operation::RecordCreate(_) | Operation::RelationRemove(_)
            ) {
                extra = extra
                    .checked_add(1024 + op.key().iter().map(|s| s.len() as u64).sum::<u64>())
                    .ok_or(E::MetadataQuota)?;
            }
        }
        check_cache_bound(&self.history, extra, budget)
    }
    pub fn check(&self, c: &Connection) -> Result<()> {
        let row:(String,String,i64,Vec<u8>)=c.query_row("SELECT o.origin_id,o.incarnation,o.last_seq,o.last_hash FROM sync_local l JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation WHERE l.singleton=1 AND o.status='active'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|_|E::CorruptCapability)?;
        if row
            != (
                self.origin.clone(),
                self.incarnation.clone(),
                self.seq,
                self.hash.to_vec(),
            )
        {
            return Err(E::CorruptCapability);
        }
        Ok(())
    }
    pub fn baselines(&self) -> Baselines {
        self.legacy.keys().cloned().collect()
    }
    pub fn priors(&self, c: &Connection, effects: &[ObservedEffect]) -> Result<FacetPriors> {
        let mut first = BTreeMap::new();
        for e in effects {
            first
                .entry((e.entity, e.key.clone()))
                .or_insert(e.before.as_ref());
        }
        let mut result = FacetPriors::new();
        for ((entity, key), before) in first {
            let Some(before) = before else { continue };
            if !entity.is_facet_mutable() {
                let hash = facet_hash(entity, &key, "record", before)?;
                if let Some(expected) =
                    self.history
                        .heads
                        .get(&(entity, key.clone(), "record".into()))
                {
                    if hash != expected.hash
                        || stored_head(c, &(entity, key.clone(), "record".into()))?
                            != Some((expected.event.event_id.clone(), expected.hash.to_vec()))
                    {
                        return Err(E::MissingPrior);
                    }
                } else if self
                    .legacy
                    .get(&(entity, key.clone()))
                    .and_then(|h| h.get("#record"))
                    != Some(&hash)
                {
                    return Err(E::MissingPrior);
                }
            }
            for f in codec::facets_of(entity) {
                let identity = (entity, key.clone(), f.name.into());
                let stored = stored_head(c, &identity)?;
                let prior = if let Some(expected) = self.history.heads.get(&identity) {
                    if stored != Some((expected.event.event_id.clone(), expected.hash.to_vec()))
                        || expected.hash != facet_hash(entity, &key, f.name, before)?
                    {
                        return Err(E::MissingPrior);
                    }
                    FacetPrior::Event(expected.event.clone())
                } else {
                    if stored.is_some()
                        || self
                            .legacy
                            .get(&(entity, key.clone()))
                            .and_then(|h| h.get(f.name))
                            != Some(&facet_hash(entity, &key, f.name, before)?)
                    {
                        return Err(E::MissingPrior);
                    }
                    FacetPrior::LegacyBaseline
                };
                result.insert(
                    (
                        entity,
                        key.clone(),
                        FacetId::of(entity, f.name).ok_or(E::MissingPrior)?,
                    ),
                    prior,
                );
            }
        }
        Ok(result)
    }
}
