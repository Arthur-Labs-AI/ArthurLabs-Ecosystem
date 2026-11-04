use super::protocol::*;
use super::{
    codec::{self, JournalEvent, ObservedCreate, Operation},
    reducer,
};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;
// No public unchecked constructor; storage accepts only this validated value.
pub(crate) struct ValidatedEvent {
    envelope: Envelope,
    core: JournalEvent,
}
impl ValidatedEvent {
    pub fn parse(e: Envelope) -> Result<Self> {
        if e.bytes.is_empty() || e.bytes.len() > codec::MAX_CANONICAL_BYTES {
            return Err(Error::Limit);
        }
        let core = codec::decode_core_strict(&e.bytes).map_err(|_| Error::Integrity)?;
        Self::checked(e, core)
    }
    /// Decode a canonical core once, derive its envelope, then apply exactly
    /// the same closed semantic validation as the supplied-envelope entry.
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self> {
        if bytes.is_empty() || bytes.len() > codec::MAX_CANONICAL_BYTES {
            return Err(Error::Limit);
        }
        let core = codec::decode_core_strict(&bytes).map_err(|_| Error::Integrity)?;
        let parse = |v: &str| Uuid::parse_str(v).map_err(|_| Error::Integrity);
        let identity = Identity {
            event: parse(&core.event_id)?,
            bundle: parse(&core.bundle_id)?,
            origin: parse(&core.origin_id)?,
            incarnation: parse(&core.origin_incarnation)?,
            seq: core.origin_seq.parse().map_err(|_| Error::Integrity)?,
            hash: codec::journal_event_hash(&bytes),
        };
        Self::checked(Envelope { identity, bytes }, core)
    }
    fn checked(e: Envelope, core: JournalEvent) -> Result<Self> {
        let parse = |s: &str| Uuid::parse_str(s).map_err(|_| Error::Integrity);
        let actual = Identity {
            event: parse(&core.event_id)?,
            bundle: parse(&core.bundle_id)?,
            origin: parse(&core.origin_id)?,
            incarnation: parse(&core.origin_incarnation)?,
            seq: core.origin_seq.parse().map_err(|_| Error::Integrity)?,
            hash: codec::journal_event_hash(&e.bytes),
        };
        if actual != e.identity
            || core.operations.len()
                > core
                    .raw_effect_count
                    .parse::<usize>()
                    .map_err(|_| Error::Integrity)?
        {
            return Err(Error::Integrity);
        }
        if actual.seq == 1 && core.previous_event_hash != codec::hash_hex(&[0; 32]) {
            return Err(Error::Integrity);
        }
        let mut keys = BTreeSet::new();
        let mut creations = BTreeSet::new();
        for op in &core.operations {
            let key = (op.entity(), op.key().to_vec());
            if !keys.insert(key.clone()) {
                return Err(Error::Integrity);
            }
            if matches!(op, Operation::RecordCreate(_)) {
                creations.insert(key);
            }
        }
        let mut known = BTreeMap::new();
        let mut baselines = BTreeSet::new();
        let mut deps = BTreeSet::new();
        let check_ref = |r: &codec::EventRef| -> Result<()> {
            let sequence = r.seq.parse::<i64>().map_err(|_| Error::Integrity)?;
            if r.event_id == core.event_id
                || (r.origin_id == core.origin_id
                    && r.incarnation == core.origin_incarnation
                    && sequence >= actual.seq)
            {
                return Err(Error::Integrity);
            }
            Ok(())
        };
        for d in &core.dependencies {
            let key = (d.entity, d.key.clone());
            if !deps.insert(key.clone()) || creations.contains(&key) {
                return Err(Error::Integrity);
            }
            if let Some(r) = &d.event_ref {
                check_ref(r)?;
                known.insert(key, r.clone());
            } else {
                baselines.insert(key);
            }
        }
        let mut expected =
            reducer::dependencies_for(&core.operations, &creations, &known, &baselines)
                .map_err(|_| Error::Integrity)?;
        // Mirror the journal kernel's additional closure edges, not merely the
        // base reducer's forward FKs. Missing or invented edges still reject.
        let mut extra = BTreeSet::new();
        let text = |row: &codec::RowImage, key: &str| -> Result<String> {
            match row.get(key) {
                Some(codec::FieldValue::Text(v) | codec::FieldValue::Decimal(v)) => Ok(v.clone()),
                _ => Err(Error::Integrity),
            }
        };
        for op in &core.operations {
            let row = match op {
                Operation::RecordCreate(r) => &r.after,
                Operation::FacetUpdate(u) => &u.after,
                Operation::RelationRemove(r) => &r.before,
            };
            match op.entity() {
                codec::EntityKind::DistillationRuns => {
                    extra.insert((codec::EntityKind::Captures, vec![text(row, "capture_id")?]));
                }
                codec::EntityKind::KnowledgeObjects => {
                    extra.insert((codec::EntityKind::ObjectSources, vec![text(row, "id")?]));
                }
                codec::EntityKind::PendingClaims => {
                    extra.insert((
                        codec::EntityKind::IdentityDecisions,
                        vec![text(row, "capture_id")?, text(row, "ordinal")?],
                    ));
                    let candidates: Vec<String> =
                        serde_json::from_str(&text(row, "candidate_ids_json")?)
                            .map_err(|_| Error::Integrity)?;
                    if candidates.is_empty()
                        || candidates.len() > 4
                        || candidates.iter().collect::<BTreeSet<_>>().len() != candidates.len()
                    {
                        return Err(Error::Integrity);
                    }
                    for id in candidates {
                        extra.insert((codec::EntityKind::KnowledgeObjects, vec![id]));
                    }
                }
                _ => {}
            }
        }
        for (entity, key) in extra {
            if creations.contains(&(entity, key.clone())) {
                continue;
            }
            let event_ref = if let Some(r) = known.get(&(entity, key.clone())) {
                Some(r.clone())
            } else if baselines.contains(&(entity, key.clone())) {
                None
            } else {
                return Err(Error::Integrity);
            };
            expected.push(codec::Dependency {
                entity,
                key,
                event_ref,
            });
        }
        expected.sort_by(|a, b| (a.entity, &a.key).cmp(&(b.entity, &b.key)));
        expected.dedup();
        if expected != core.dependencies {
            return Err(Error::Integrity);
        }
        for op in &core.operations {
            match op {
                Operation::FacetUpdate(u) => {
                    for (facet, prior) in &u.expected {
                        let fields = codec::facets_of(u.entity)
                            .iter()
                            .find(|f| f.name == facet)
                            .ok_or(Error::Integrity)?;
                        let state = fields
                            .fields
                            .iter()
                            .map(|f| {
                                u.before
                                    .get(*f)
                                    .cloned()
                                    .map(|v| ((*f).to_owned(), v))
                                    .ok_or(Error::Integrity)
                            })
                            .collect::<Result<_>>()?;
                        if codec::hash_hex(
                            &codec::facet_state_hash(u.entity, facet, &u.key, &state)
                                .map_err(|_| Error::Integrity)?,
                        ) != prior.before_hash
                        {
                            return Err(Error::Integrity);
                        }
                        if let Some(r) = &prior.event_ref {
                            check_ref(r)?;
                        }
                    }
                }
                Operation::RelationRemove(r) => {
                    if let ObservedCreate::Event(r) = &r.observed_create {
                        check_ref(r)?;
                    }
                }
                _ => {}
            }
        }
        Ok(Self { envelope: e, core })
    }
    pub fn envelope(&self) -> &Envelope {
        &self.envelope
    }
    pub fn into_envelope(self) -> Envelope {
        self.envelope
    }
    pub fn core(&self) -> &JournalEvent {
        &self.core
    }
}
