//! Dormant owner-borrowed journal kernel; no application constructor calls it.
//! Raw SQL access is test-only. Later typed writer integration is a separate gate.
//! Quotas count persisted logical UTF-8/BLOB bytes and eight bytes per INTEGER.
//! Payloads are separate from headers/heads/fences/origins/snapshot metadata.
//! An explicit metadata reserve policy is required; zero reserve is ONLY a
//! synthetic test profile. G4/physical disk admission remains unapproved.
//! Supported closure: capture/project, initial object/source/root, user/merge
//! lineage, memberships, claim metadata, and MODEL relations. New identity,
//! automatic evidence/revisions, proposal effects and reviews fail closed until
//! their complete native provenance is integrated in a later phase.
use super::codec::{self, Dependency, EntityKind, EventRef, FieldValue, JournalEvent, Operation};
use super::reducer::FinalStateResolver;
use super::reducer::{self, ReviewContext, ReviewMap};
use super::sql_effects::{self as sql, Key};
use super::stream::{self, Head, HeadKey, Stream};
use crate::storage::capture_store::{now_rfc3339, CaptureStore};
use rusqlite::{params, Connection, DropBehavior, Transaction, TransactionBehavior};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use uuid::Uuid;

pub(super) type Result<T> = std::result::Result<T, JournalError>;
// No wrapped codec/SQL strings: those may disclose private row values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum JournalError {
    WrongSchema,
    Unavailable,
    CorruptCapability,
    TransientState,
    InvalidEffect,
    UnsupportedEffects,
    MissingFinalProjection,
    MissingPrior,
    IncompleteClosure,
    ReviewContext,
    UnsupportedReview,
    Codec,
    BundleTooLarge,
    EffectLimit,
    SpoolLimit,
    PayloadQuota,
    MetadataQuota,
    PolicyPending,
    StreamExhausted,
    Sql,
    FinalRead,
    BundleInsert,
    HeadUpdate,
    Cleanup,
    Commit,
    Rollback,
    Domain,
    #[cfg(test)]
    Injected,
}
impl std::fmt::Display for JournalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "journal {self:?}")
    }
}
impl std::error::Error for JournalError {}
impl From<rusqlite::Error> for JournalError {
    fn from(error: rusqlite::Error) -> Self {
        // Classify only fixed candidate CHECK identities; never retain row text.
        match error {
            rusqlite::Error::SqliteFailure(_, Some(detail))
                if detail == "CHECK constraint failed: effect_count BETWEEN 0 AND 4096" =>
            {
                Self::EffectLimit
            }
            rusqlite::Error::SqliteFailure(_, Some(detail))
                if detail == "CHECK constraint failed: staged_bytes BETWEEN 0 AND 8388608" =>
            {
                Self::SpoolLimit
            }
            _ => Self::Sql,
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct Limits {
    pub core: u64,
    pub payload: u64,
    pub metadata: u64,
    pub reserve: Option<u64>,
}
impl Limits {
    #[cfg(test)]
    pub fn candidate() -> Self {
        Self {
            core: codec::MAX_CANONICAL_BYTES as u64,
            payload: 256 * 1024 * 1024,
            metadata: 64 * 1024 * 1024,
            reserve: Some(0),
        }
    }
    fn validate(self) -> Result<()> {
        if self.reserve.is_none() {
            return Err(JournalError::PolicyPending);
        }
        if self.core > codec::MAX_CANONICAL_BYTES as u64
            || self.payload > 256 * 1024 * 1024
            || self.metadata > 64 * 1024 * 1024
        {
            return Err(JournalError::PolicyPending);
        }
        Ok(())
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Stage {
    Context,
    Domain,
    Effects,
    FinalRead,
    Priors,
    Codec,
    Quota,
    Bundle,
    Heads,
    Cleanup,
    Commit,
    Init,
}
#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Fault {
    At(Stage),
    DeferredCommit,
    Rollback,
    Exhausted,
}
#[derive(Default)]
struct Hooks {
    #[cfg(test)]
    fault: Option<Fault>,
}
impl Hooks {
    fn at(&self, _stage: Stage) -> Result<()> {
        #[cfg(test)]
        if self.fault == Some(Fault::At(_stage)) {
            return Err(JournalError::Injected);
        }
        Ok(())
    }
}
struct State {
    stream: Stream,
    usable: bool,
}
pub(super) struct JournalKernel<'a> {
    store: &'a CaptureStore,
    state: Mutex<State>,
    limits: Limits,
}
pub(super) struct JournalTx<'a> {
    connection: &'a Connection,
    reviews: ReviewMap,
    context_bytes: usize,
    depth: usize,
    fatal: bool,
}
struct Pending {
    core: JournalEvent,
    reference: EventRef,
    hash: [u8; 32],
    heads: BTreeMap<HeadKey, Head>,
}

impl<'a> JournalKernel<'a> {
    #[cfg(test)]
    pub(super) fn activate(store: &'a CaptureStore) -> Result<Self> {
        Self::activate_with_policy(store, Limits::candidate())
    }
    pub(super) fn activate_with_policy(store: &'a CaptureStore, limits: Limits) -> Result<Self> {
        Self::activate_inner(store, limits, Hooks::default())
    }
    fn activate_inner(store: &'a CaptureStore, limits: Limits, hooks: Hooks) -> Result<Self> {
        limits.validate()?;
        let mut c = store
            .connection
            .lock()
            .map_err(|_| JournalError::Unavailable)?;
        stream::policy(&c)?;
        quota(&c, limits, 0)?;
        let mut tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = (|| {
            let now = now_rfc3339().map_err(|_| JournalError::Unavailable)?;
            let stream = stream::initialize(&tx, &now, limits.metadata)?;
            quota(&tx, limits, 0)?;
            hooks.at(Stage::Init)?;
            Ok(stream)
        })();
        let stream = match result {
            Ok(s) => match commit(&mut tx) {
                Ok(()) => s,
                Err(e) => {
                    rollback(&mut tx, &hooks)?;
                    return Err(e);
                }
            },
            Err(e) => {
                rollback(&mut tx, &hooks)?;
                return Err(e);
            }
        };
        Ok(Self {
            store,
            state: Mutex::new(State {
                stream,
                usable: true,
            }),
            limits,
        })
    }
    pub(super) fn run<T>(&self, work: impl FnOnce(&mut JournalTx<'_>) -> Result<T>) -> Result<T> {
        self.run_inner(work, Hooks::default())
    }
    fn run_inner<T>(
        &self,
        work: impl FnOnce(&mut JournalTx<'_>) -> Result<T>,
        hooks: Hooks,
    ) -> Result<T> {
        // Fixed lock order; the original CaptureStore remains the sole owner.
        let mut state = self.state.lock().map_err(|_| JournalError::Unavailable)?;
        if !state.usable {
            return Err(JournalError::Unavailable);
        }
        let mut c = self
            .store
            .connection
            .lock()
            .map_err(|_| JournalError::Unavailable)?;
        stream::policy(&c)?;
        state.stream.check(&c)?;
        let mut tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = (|| {
            state.stream.check(&tx)?;
            hooks.at(Stage::Context)?;
            let event = Uuid::new_v4().to_string();
            let bundle = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO sync_write_context(singleton,event_id) VALUES(1,?1)",
                [&event],
            )?;
            let mut capability = JournalTx {
                connection: &tx,
                reviews: ReviewMap::new(),
                context_bytes: 0,
                depth: 0,
                fatal: false,
            };
            let value = work(&mut capability)?;
            if capability.fatal {
                return Err(JournalError::UnsupportedEffects);
            }
            hooks.at(Stage::Domain)?;
            #[cfg(test)]
            if hooks.fault == Some(Fault::DeferredCommit) {
                tx.execute_batch("DELETE FROM sync_effects; DELETE FROM sync_write_context")?;
                return Ok((value, None));
            }
            let pending = finalize(
                &tx,
                &state.stream,
                self.limits,
                &event,
                &bundle,
                &capability.reviews,
                &hooks,
            )?;
            Ok((value, pending))
        })();
        let (value, pending) = match result {
            Ok(v) => v,
            Err(e) => {
                if rollback(&mut tx, &hooks).is_err() {
                    state.usable = false;
                    return Err(JournalError::Rollback);
                }
                return Err(e);
            }
        };
        if let Err(e) = hooks.at(Stage::Commit).and_then(|_| commit(&mut tx)) {
            if rollback(&mut tx, &hooks).is_err() {
                state.usable = false;
                return Err(JournalError::Rollback);
            }
            return Err(e);
        }
        // No fallible operation after COMMIT. Publish the derived cache last.
        if let Some(p) = pending {
            for op in &p.core.operations {
                let key = (op.entity(), op.key().to_vec());
                match op {
                    Operation::RecordCreate(_) => {
                        state
                            .stream
                            .history
                            .records
                            .insert(key, p.reference.clone());
                    }
                    Operation::RelationRemove(_) => {
                        state.stream.history.removed.insert(key);
                    }
                    _ => {}
                }
            }
            state.stream.history.heads.extend(p.heads);
            state.stream.seq += 1;
            state.stream.hash = p.hash;
        }
        Ok(value)
    }
    #[cfg(test)]
    pub fn run_fault<T>(
        &self,
        fault: Fault,
        work: impl FnOnce(&mut JournalTx<'_>) -> Result<T>,
    ) -> Result<T> {
        self.run_inner(work, Hooks { fault: Some(fault) })
    }
    #[cfg(test)]
    pub fn init_fault(store: &'a CaptureStore) -> Result<Self> {
        Self::activate_inner(
            store,
            Limits::candidate(),
            Hooks {
                fault: Some(Fault::At(Stage::Init)),
            },
        )
    }
    #[cfg(test)]
    pub fn remove_legacy_for_test(&self, key: &Key) {
        self.state.lock().unwrap().stream.legacy.remove(key);
    }
    #[cfg(test)]
    pub fn contradict_provenance_for_test(&self, key: Key) {
        self.state
            .lock()
            .unwrap()
            .stream
            .legacy
            .insert(key, BTreeMap::new());
    }
}

impl JournalTx<'_> {
    /// Journal-internal scoped seam for typed native writer adapters. No SQL
    /// handle escapes this module boundary; an ignored writer error poisons the
    /// capability so partial domain work cannot accidentally be committed.
    pub(super) fn with_domain<T, E>(
        &mut self,
        work: impl FnOnce(&Connection) -> std::result::Result<T, E>,
    ) -> std::result::Result<T, E> {
        let result = work(self.connection);
        if result.is_err() {
            self.fatal = true;
        }
        result
    }

    #[cfg(test)]
    pub fn sql(&self) -> &Connection {
        self.connection
    }
    pub(super) fn has_registered(&self, entity: EntityKind, key: Vec<String>) -> bool {
        self.reviews.contains_key(&(entity, key))
    }
    pub(super) fn register_review(
        &mut self,
        entity: EntityKind,
        key: Vec<String>,
        context: ReviewContext,
    ) -> Result<()> {
        let bytes = [
            &context.final_body,
            &context.proposal_id,
            &context.claim_id,
            &context.object_id,
            &context.reviewed_revision_id,
            &context.result_revision_id,
        ]
        .into_iter()
        .map(|s| s.as_ref().map_or(0, String::len))
        .chain(key.iter().map(String::len))
        .try_fold(1024usize, |sum, n| sum.checked_add(n));
        let Some(bytes) = bytes else {
            self.fatal = true;
            return Err(JournalError::ReviewContext);
        };
        if !matches!(
            entity,
            EntityKind::PendingClaims | EntityKind::RevisionProposals
        ) || codec::validate_key(entity, &key).is_err()
            || self.reviews.contains_key(&(entity, key.clone()))
            || self
                .context_bytes
                .checked_add(bytes)
                .filter(|n| *n <= sql::SPOOL_LIMIT as usize)
                .is_none()
        {
            self.fatal = true;
            return Err(JournalError::ReviewContext);
        }
        self.context_bytes += bytes;
        self.reviews.insert((entity, key), context);
        Ok(())
    }
    pub(super) fn savepoint<T>(&mut self, work: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        if self.depth >= codec::MAX_JSON_DEPTH {
            self.fatal = true;
            return Err(JournalError::ReviewContext);
        }
        self.connection.execute_batch("SAVEPOINT journal_scope")?;
        self.depth += 1;
        let parent = std::mem::take(&mut self.reviews);
        let bytes = self.context_bytes;
        let result = work(self);
        let inner = std::mem::replace(&mut self.reviews, parent);
        self.depth -= 1;
        match result {
            Ok(value) if !inner.keys().any(|k| self.reviews.contains_key(k)) => {
                if self
                    .connection
                    .execute_batch("RELEASE journal_scope")
                    .is_err()
                {
                    self.fatal = true;
                    return Err(JournalError::Sql);
                }
                self.reviews.extend(inner);
                Ok(value)
            }
            other => {
                self.context_bytes = bytes;
                if self
                    .connection
                    .execute_batch("ROLLBACK TO journal_scope; RELEASE journal_scope")
                    .is_err()
                {
                    self.fatal = true;
                    return Err(JournalError::Rollback);
                }
                let e = match other {
                    Err(e) => e,
                    _ => JournalError::ReviewContext,
                };
                if e != JournalError::Domain {
                    self.fatal = true;
                }
                Err(e)
            }
        }
    }
}

fn commit(tx: &mut Transaction<'_>) -> Result<()> {
    tx.execute_batch("COMMIT")
        .map_err(|_| JournalError::Commit)?;
    if !tx.is_autocommit() {
        return Err(JournalError::Commit);
    }
    tx.set_drop_behavior(DropBehavior::Ignore);
    Ok(())
}
fn rollback(tx: &mut Transaction<'_>, _hooks: &Hooks) -> Result<()> {
    let result = if tx.is_autocommit() {
        Ok(())
    } else {
        tx.execute_batch("ROLLBACK")
    };
    #[cfg(test)]
    let injected = _hooks.fault == Some(Fault::Rollback);
    #[cfg(not(test))]
    let injected = false;
    if result.is_err() || !tx.is_autocommit() || injected {
        let _ = tx.pragma_update(None, "query_only", true);
        return Err(JournalError::Rollback);
    }
    tx.set_drop_behavior(DropBehavior::Ignore);
    Ok(())
}

fn quota(c: &Connection, limits: Limits, additional: u64) -> Result<()> {
    let payload: i64 = c
        .query_row(
            "SELECT coalesce(sum(length(canonical_bytes)),0) FROM sync_bundles",
            [],
            |r| r.get(0),
        )
        .map_err(|_| JournalError::PayloadQuota)?;
    if payload < 0
        || (payload as u64)
            .checked_add(additional)
            .filter(|n| *n <= limits.payload)
            .is_none()
    {
        return Err(JournalError::PayloadQuota);
    }
    let mut metadata = limits.reserve.ok_or(JournalError::PolicyPending)?;
    for table in [
        "sync_origins",
        "sync_local",
        "sync_bundles",
        "sync_commit_fences",
        "sync_entity_heads",
        "sync_snapshots",
        "sync_snapshot_rows",
    ] {
        let mut info = c.prepare(&format!("PRAGMA table_info({table})"))?;
        let cols = info
            .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let terms = cols
            .iter()
            .filter(|(n, _)| !matches!(n.as_str(), "canonical_bytes" | "row_bytes"))
            .map(|(n, t)| {
                if t == "INTEGER" {
                    format!("CASE WHEN {n} IS NULL THEN 0 ELSE 8 END")
                } else {
                    format!("coalesce(length(CAST({n} AS BLOB)),0)")
                }
            })
            .collect::<Vec<_>>();
        let n: i64 = c
            .query_row(
                &format!("SELECT coalesce(sum({}),0) FROM {table}", terms.join("+")),
                [],
                |r| r.get(0),
            )
            .map_err(|_| JournalError::MetadataQuota)?;
        metadata = metadata
            .checked_add(u64::try_from(n).map_err(|_| JournalError::MetadataQuota)?)
            .ok_or(JournalError::MetadataQuota)?;
        if metadata > limits.metadata {
            return Err(JournalError::MetadataQuota);
        }
    }
    Ok(())
}

fn reducer_error(e: reducer::ReducerError) -> JournalError {
    use reducer::ReducerError::*;
    match e {
        TooManyEffects(_) => JournalError::EffectLimit,
        TooManyDependencies(_) | IncompleteDependencyClosure { .. } => {
            JournalError::IncompleteClosure
        }
        MissingFacetPrior { .. }
        | MissingCreationProvenance { .. }
        | ContradictoryProvenance { .. } => JournalError::MissingPrior,
        MissingFinalProjection { .. } => JournalError::MissingFinalProjection,
        MissingReviewProof { .. } | InvalidReviewContext(_) | TerminalClosureViolation(_) => {
            JournalError::ReviewContext
        }
        Codec(_) => JournalError::Codec,
        _ => JournalError::UnsupportedEffects,
    }
}

fn finalize(
    c: &Connection,
    stream: &Stream,
    limits: Limits,
    event: &str,
    bundle: &str,
    reviews: &ReviewMap,
    hooks: &Hooks,
) -> Result<Option<Pending>> {
    if c.is_autocommit() {
        return Err(JournalError::Unavailable);
    }
    hooks.at(Stage::Effects)?;
    let effects = sql::effects(c, event)?;
    let total: i64 = c.query_row("SELECT count(*) FROM sync_effects", [], |r| r.get(0))?;
    let fences: i64 = c.query_row(
        "SELECT count(*) FROM sync_commit_fences WHERE event_id=?1",
        [event],
        |r| r.get(0),
    )?;
    if total != effects.len() as i64 || fences != i64::from(!effects.is_empty()) {
        return Err(JournalError::InvalidEffect);
    }
    if effects.is_empty() {
        if !reviews.is_empty() {
            return Err(JournalError::ReviewContext);
        }
        c.execute("DELETE FROM sync_write_context WHERE event_id=?1", [event])
            .map_err(|_| JournalError::Cleanup)?;
        stream::empty(c)?;
        return Ok(None);
    }
    hooks.at(Stage::FinalRead)?;
    let resolver = sql::final_map(c, &effects)?;
    let mut last = BTreeMap::new();
    for e in &effects {
        last.insert((e.entity, e.key.clone()), &e.after);
    }
    for ((entity, key), after) in last {
        if resolver.resolve(entity, &key).as_ref() != after.as_ref() {
            return Err(JournalError::MissingFinalProjection);
        }
    }
    hooks.at(Stage::Priors)?;
    let priors = stream.priors(c, &effects)?;
    let baselines = stream.baselines();
    // Identity, claim, proposal and evidence creates, state transitions and
    // registered reviews now flow into the reducer: closure is enforced by
    // validate_closure/extra_closure, proofs by the shared codec rule, and
    // terminal/action agreement by validate_terminal_closure. Unconsumed
    // review registrations are rejected after reduction below.
    let operations = reducer::reduce_effects(
        &effects,
        &resolver,
        &stream.history.records,
        &baselines,
        reviews,
        &priors,
    )
    .map_err(reducer_error)?;
    if operations.is_empty() {
        return Err(JournalError::UnsupportedEffects);
    }
    for id in reviews.keys() {
        let consumed = operations.iter().any(|op| {
            matches!(op, Operation::FacetUpdate(u) if u.review_proof.is_some())
                && (op.entity(), op.key().to_vec()) == (id.0, id.1.clone())
        });
        if !consumed {
            return Err(JournalError::ReviewContext);
        }
    }
    let creations: BTreeSet<Key> = operations
        .iter()
        .filter_map(|op| match op {
            Operation::RecordCreate(r) => Some((r.entity, r.key.clone())),
            _ => None,
        })
        .collect();
    if creations.iter().any(|k| {
        stream.history.records.contains_key(k)
            || stream.legacy.contains_key(k)
            || stream.history.removed.contains(k)
    }) {
        return Err(JournalError::UnsupportedEffects);
    }
    let mut dependencies =
        reducer::dependencies_for(&operations, &creations, &stream.history.records, &baselines)
            .map_err(reducer_error)?;
    extra_closure(c, &operations, &creations, stream, &mut dependencies)?;
    for dep in &dependencies {
        if sql::reread(c, dep.entity, &dep.key)?.is_none() {
            return Err(JournalError::IncompleteClosure);
        }
    }
    dependencies.sort_by(|a, b| (a.entity, &a.key).cmp(&(b.entity, &b.key)));
    dependencies.dedup_by(|a, b| a == b);
    if dependencies.len() > codec::MAX_DEPENDENCIES {
        return Err(JournalError::IncompleteClosure);
    }
    #[cfg(test)]
    let cursor = if hooks.fault == Some(Fault::Exhausted) {
        i64::MAX
    } else {
        stream.seq
    };
    #[cfg(not(test))]
    let cursor = stream.seq;
    let seq = next_sequence(cursor)?;
    hooks.at(Stage::Codec)?;
    let core = reducer::assemble_event(
        bundle.into(),
        event.into(),
        stream.origin.clone(),
        stream.incarnation.clone(),
        seq as u64,
        codec::hash_hex(&stream.hash),
        now_rfc3339().map_err(|_| JournalError::Unavailable)?,
        effects.len() as u64,
        operations,
        dependencies,
    )
    .map_err(reducer_error)?;
    let bytes = codec::encode_canonical(&core).map_err(|e| match e {
        codec::CodecError::OversizeBundle { .. } => JournalError::BundleTooLarge,
        _ => JournalError::Codec,
    })?;
    if bytes.len() as u64 > limits.core {
        return Err(JournalError::BundleTooLarge);
    }
    let hash = codec::journal_event_hash(&bytes);
    let reference = EventRef {
        origin_id: stream.origin.clone(),
        incarnation: stream.incarnation.clone(),
        seq: seq.to_string(),
        event_id: event.into(),
        hash: codec::hash_hex(&hash),
    };
    let heads = stream::updates(&core.operations, &reference)?;
    hooks.at(Stage::Quota)?;
    stream.admit_cache(&core.operations, &heads, limits.metadata)?;
    quota(c, limits, bytes.len() as u64)?;
    hooks.at(Stage::Bundle)?;
    #[cfg(test)]
    if hooks.fault == Some(Fault::Rollback) {
        return Err(JournalError::Injected);
    }
    c.execute("INSERT INTO sync_bundles(event_id,bundle_id,origin_id,incarnation,origin_seq,payload_schema,raw_effect_count,canonical_bytes,canonical_hash,previous_hash,committed_at) VALUES(?1,?2,?3,?4,?5,1,?6,?7,?8,?9,?10)",params![event,bundle,stream.origin,stream.incarnation,seq,effects.len() as i64,bytes,hash.as_slice(),stream.hash.as_slice(),core.committed_at]).map_err(|_|JournalError::BundleInsert)?;
    let tip: (i64, Vec<u8>) = c.query_row(
        "SELECT last_seq,last_hash FROM sync_origins WHERE origin_id=?1 AND incarnation=?2",
        params![stream.origin, stream.incarnation],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if tip != (seq, hash.to_vec()) {
        return Err(JournalError::CorruptCapability);
    }
    hooks.at(Stage::Heads)?;
    for (key, head) in &heads {
        c.execute("INSERT INTO sync_entity_heads(entity_kind,entity_key,facet,event_id,state_hash) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(entity_kind,entity_key,facet) DO UPDATE SET event_id=excluded.event_id,state_hash=excluded.state_hash",params![key.0.as_str(),sql::key_json(&key.1)?,key.2,event,head.hash.as_slice()]).map_err(|_|JournalError::HeadUpdate)?;
        if stream::stored_head(c, key)? != Some((event.into(), head.hash.to_vec())) {
            return Err(JournalError::HeadUpdate);
        }
    }
    quota(c, limits, 0)?;
    hooks.at(Stage::Cleanup)?;
    c.execute("DELETE FROM sync_effects WHERE event_id=?1", [event])
        .map_err(|_| JournalError::Cleanup)?;
    c.execute("DELETE FROM sync_write_context WHERE event_id=?1", [event])
        .map_err(|_| JournalError::Cleanup)?;
    stream::empty(c)?;
    Ok(Some(Pending {
        core,
        reference,
        hash,
        heads,
    }))
}

pub(super) fn next_sequence(cursor: i64) -> Result<i64> {
    if cursor < 0 {
        return Err(JournalError::CorruptCapability);
    }
    cursor.checked_add(1).ok_or(JournalError::StreamExhausted)
}

fn extra_closure(
    c: &Connection,
    ops: &[Operation],
    creations: &BTreeSet<Key>,
    stream: &Stream,
    deps: &mut Vec<Dependency>,
) -> Result<()> {
    let mut add = |entity: EntityKind, key: Vec<String>| -> Result<()> {
        if sql::reread(c, entity, &key)?.is_none() {
            return Err(JournalError::IncompleteClosure);
        }
        if creations.contains(&(entity, key.clone())) {
            return Ok(());
        }
        let reference = if let Some(r) = stream.history.records.get(&(entity, key.clone())) {
            Some(r.clone())
        } else if stream.legacy.contains_key(&(entity, key.clone())) {
            None
        } else {
            return Err(JournalError::IncompleteClosure);
        };
        deps.push(Dependency {
            entity,
            key,
            event_ref: reference,
        });
        if deps.len() > codec::MAX_DEPENDENCIES * 4 {
            return Err(JournalError::IncompleteClosure);
        }
        Ok(())
    };
    let mut evidenced: BTreeSet<String> = BTreeSet::new();
    for op in ops {
        if let Operation::RecordCreate(c) = op {
            if c.entity == EntityKind::RevisionEvidence {
                if let Some(FieldValue::Text(revision)) = c.after.get("revision_id") {
                    evidenced.insert(revision.clone());
                }
            }
        }
    }
    for op in ops {
        let row = match op {
            Operation::RecordCreate(r) => &r.after,
            Operation::FacetUpdate(u) => &u.after,
            Operation::RelationRemove(r) => &r.before,
        };
        match op.entity() {
            EntityKind::DistillationRuns => add(
                EntityKind::Captures,
                vec![sql::text(row, "capture_id")?.into()],
            )?,
            EntityKind::KnowledgeObjects => {
                let id = sql::text(row, "id")?;
                let source = sql::reread(c, EntityKind::ObjectSources, &[id.into()])?
                    .ok_or(JournalError::IncompleteClosure)?;
                add(EntityKind::ObjectSources, vec![id.into()])?;
                let count:i64=c.query_row("SELECT count(*) FROM thought_revisions WHERE object_id=?1 AND origin='initial'",[id],|r|r.get(0))?;
                if count != 1 || matches!(row.get("current_revision_id"), Some(FieldValue::Null)) {
                    return Err(JournalError::IncompleteClosure);
                }
                let valid:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM thought_revisions WHERE object_id=?1 AND origin='initial' AND capture_id=?2 AND source_start=?3 AND source_end=?4)",params![id,sql::text(&source,"capture_id")?,sql::text(&source,"source_start")?,sql::text(&source,"source_end")?],|r|r.get(0))?;
                if !valid {
                    return Err(JournalError::IncompleteClosure);
                }
            }
            EntityKind::ThoughtRevisions => {
                let n: i64 = c.query_row(
                    "SELECT count(*) FROM revision_parents WHERE child_revision_id=?1",
                    [sql::text(row, "id")?],
                    |r| r.get(0),
                )?;
                let valid = match sql::text(row, "origin")? {
                    "initial" => n == 0,
                    "merge" => (2..=8).contains(&n),
                    _ => n == 1,
                };
                if !valid {
                    return Err(JournalError::IncompleteClosure);
                }
                if sql::text(row, "origin")? == "system" && !evidenced.contains(sql::text(row, "id")?) {
                    return Err(JournalError::IncompleteClosure);
                }
            }
            EntityKind::PendingClaims => {
                let capture = sql::text(row, "capture_id")?;
                let ordinal = sql::text(row, "ordinal")?;
                let decision = sql::reread(
                    c,
                    EntityKind::IdentityDecisions,
                    &[capture.into(), ordinal.into()],
                )?
                .ok_or(JournalError::IncompleteClosure)?;
                if sql::text(&decision, "outcome")? != "uncertain" {
                    return Err(JournalError::IncompleteClosure);
                }
                add(
                    EntityKind::IdentityDecisions,
                    vec![capture.into(), ordinal.into()],
                )?;
                let ids: Vec<String> = serde_json::from_str(sql::text(row, "candidate_ids_json")?)
                    .map_err(|_| JournalError::IncompleteClosure)?;
                if ids.is_empty()
                    || ids.len() > 4
                    || ids.iter().collect::<BTreeSet<_>>().len() != ids.len()
                {
                    return Err(JournalError::IncompleteClosure);
                }
                let audit: serde_json::Value =
                    serde_json::from_str(sql::text(&decision, "audit_json")?)
                        .map_err(|_| JournalError::IncompleteClosure)?;
                let sent = audit
                    .get("candidatesSent")
                    .and_then(|v| v.as_array())
                    .ok_or(JournalError::IncompleteClosure)?;
                if ids
                    .iter()
                    .any(|id| !sent.iter().any(|v| v.as_str() == Some(id)))
                {
                    return Err(JournalError::IncompleteClosure);
                }
                for id in ids {
                    add(EntityKind::KnowledgeObjects, vec![id])?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}
