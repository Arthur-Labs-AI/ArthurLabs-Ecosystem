//! E2 signed-import candidate. Same owner/transaction as actual apply; no wire or trust minting.
//! Previously committed prefixes are OS-signed, bounded and reverified against the real ledger.
use super::{
    capture_store::CaptureStore,
    journal::codec,
    registry_verification,
    sync_store::{self, CandidateSyncStore},
};
use crate::sync_api::bootstrap::*;
use crate::sync_api::{
    security::{canonical, identity::*, signed::SignedOriginal},
    *,
};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

type StoredSeal = (String, Vec<u8>, i64, Vec<u8>, Vec<u8>);

pub(crate) struct SignedImportStore<'a> {
    db: CandidateSyncStore<'a>,
}

macro_rules! delegate_store {
    ($($method:ident($session:ident: $session_kind:ty $(, $argument:ident : $kind:ty)*) -> $output:ty;)*) => {
        $(fn $method(&self, $session: $session_kind, $($argument: $kind),*) -> $output {
            self.require_registry($session)?;
            self.db.$method($session, $($argument),*)
        })*
    };
}
impl SyncStore for SignedImportStore<'_> {
    fn profile(&self) -> SyncProfile {
        SyncProfile::SignedOriginalCandidate
    }
    delegate_store! {
        authorize(s: &VerifiedSession, c: &dyn SyncClock, x: &Cancellation) -> Result<()>;
        offered(s: &VerifiedSession, id: &Identity, c: &dyn SyncClock, x: &Cancellation) -> Result<()>;
        receipt(s: &VerifiedSession, r: &Receipt, c: &dyn SyncClock, x: &Cancellation) -> Result<()>;
        outstanding(s: &VerifiedSession, c: &dyn SyncClock, x: &Cancellation) -> Result<Vec<Uuid>>;
        missing(s: &VerifiedSession, c: &dyn SyncClock, x: &Cancellation) -> Result<Vec<Uuid>>;
    }
    fn lookup(
        &self,
        s: &VerifiedSession,
        id: Uuid,
        clock: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<Option<Identity>> {
        self.require_registry(s)?;
        self.db.read(s, clock, x, |c| {
            if let Some(event) = sync_store::load(c, id)? {
                return Ok(s.permits(event.identity.origin).then_some(event.identity));
            }
            Ok(quarantined(c, s, id)?.map(|event| event.identity))
        })
    }
    fn summary(&self, s: &VerifiedSession, c: &dyn SyncClock, x: &Cancellation) -> Result<Summary> {
        self.page(s, None, c, x)
    }
    fn page(
        &self,
        s: &VerifiedSession,
        after: Option<PageKey>,
        clock: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<Summary> {
        self.require_registry(s)?;
        let mut summary = self.db.page(s, after, clock, x)?;
        self.db.read(s, clock, x, |c| {
            let mut q = c
                .prepare("SELECT event FROM e2_quarantine ORDER BY event LIMIT 33")
                .map_err(sql)?;
            let ids = q
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(sql)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sql)?;
            if ids.len() > 32 {
                return Err(Error::StorageLimited);
            }
            for id in &ids {
                quarantined(c, s, Uuid::parse_str(id).map_err(|_| Error::Integrity)?)?
                    .ok_or(Error::Integrity)?;
            }
            if !ids.is_empty() {
                summary.needs_attention = true;
                if matches!(
                    summary.status,
                    SyncStatus::Syncing | SyncStatus::CleanlyApplied
                ) {
                    summary.status = SyncStatus::UnsupportedImportPolicy;
                }
            }
            Ok(())
        })?;
        Ok(summary)
    }
    fn export_signed(
        &self,
        s: &VerifiedSession,
        id: &Identity,
        clock: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<SignedExport> {
        self.require_registry(s)?;
        // Disclosure checks run on the same core again under the write lock.
        let event = self.db.export(s, id, clock, x)?;
        self.db.write(s, clock, x, |c| {
            let current = sync_store::load(c, id.event)?.ok_or(Error::Integrity)?;
            if current.identity != *id || current.bytes != event.bytes { return Err(Error::Integrity); }
            let registry = trust(registry_verification::verified(c))?;
            let owner = registry.origins.get(&id.origin.to_string()).ok_or(Error::Trust)?;
            let author = &registry.members.get(owner).ok_or(Error::Trust)?.key;
            let local: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sync_bundles WHERE event_id=?1)", [id.event.to_string()], |r|r.get(0)).map_err(sql)?;
            let bytes: Vec<u8> = if local {
                if *owner != s.binding().local.to_string() { return Err(Error::Trust); }
                let cached: Option<Vec<u8>> = c.query_row("SELECT envelope FROM e2_export_signatures WHERE event=?1", [id.event.to_string()], |r|r.get(0)).optional().map_err(sql)?;
                if let Some(bytes) = cached { bytes } else {
                    let count: i64 = c.query_row("SELECT count(*) FROM e2_export_signatures", [], |r|r.get(0)).map_err(sql)?;
                    if count >= MAX_EVENTS as i64 { return Err(Error::StorageLimited); }
                    #[cfg(any(windows, target_os = "android"))]
                    let signed = {
                        let (key, public) = trust(super::device_identity_store::bound_key(c, s.binding().local))?;
                        if &public != author { return Err(Error::Trust); }
                        trust(SignedOriginal::sign(registry.root.network, &current, &key))?
                    };
                    #[cfg(not(any(windows, target_os = "android")))]
                    let signed: SignedOriginal = return Err(Error::Trust);
                    let bytes = trust(signed.bytes())?;
                    trust(signed.verify(registry.root.network, &current, author))?;
                    c.execute("INSERT INTO e2_export_signatures VALUES(?1,?2)", params![id.event.to_string(), bytes]).map_err(sql)?;
                    bytes
                }
            } else {
                let accepted = prefix(c, registry.root.network, s.binding().local, id.origin, author)?.ok_or(Error::Trust)?;
                if accepted.incarnation != id.incarnation || accepted.seq < id.seq { return Err(Error::Trust); }
                c.query_row("SELECT envelope FROM e2_originals WHERE event=?1 AND origin=?2 AND seq=?3 AND hash=?4", params![id.event.to_string(),id.origin.to_string(),id.seq,id.hash.as_slice()], |r|r.get(0)).map_err(sql)?
            };
            let signed = trust(SignedOriginal::decode(&bytes))?;
            trust(signed.verify(registry.root.network, &current, author))?;
            Ok(SignedExport { metadata: SignedMetadata { identity: id.clone(), bytes }, event: current })
        })
    }
    fn retain_signed(
        &self,
        s: &VerifiedSession,
        metadata: SignedMetadata,
        event: Envelope,
        clock: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<Receipt> {
        self.require_registry(s)?;
        if metadata.identity != event.identity {
            return Err(Error::Integrity);
        }
        let signed = SignedOriginal::decode(&metadata.bytes).map_err(|_| Error::Integrity)?;
        self.retain(s, &signed, event, clock, x)
    }
    fn settle(
        &self,
        s: &VerifiedSession,
        clock: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<(usize, bool)> {
        self.require_registry(s)?;
        self.db.write(s, clock, x, |c| {
            let mut q=c.prepare("SELECT p.event,p.envelope FROM e2_pending_signatures p JOIN import_events e ON e.event=p.event JOIN import_receipts r ON r.event=e.event WHERE r.peer=?1 AND e.outcome='deferred' ORDER BY e.origin,e.incarnation,e.seq LIMIT ?2").map_err(sql)?;
            let pending=q.query_map(params![s.binding().peer.to_string(),REPROCESS_BATCH as i64],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Vec<u8>>(1)?))).map_err(sql)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql)?;
            drop(q);
            let mut changed=false;
            for (id, bytes) in &pending {
                let event=sync_store::load(c,Uuid::parse_str(id).map_err(|_|Error::Integrity)?)?.ok_or(Error::Integrity)?;
                let signed=trust(SignedOriginal::decode(bytes))?;
                let receipt=retain_in(c,s,&signed,event,clock,x)?;
                changed |= receipt.outcome != Outcome::DeferredDependency;
            }
            Ok((pending.len(),changed))
        })
    }
    fn retained_receipt(
        &self,
        s: &VerifiedSession,
        id: Uuid,
        clock: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<Receipt> {
        self.require_registry(s)?;
        let receipt = self.db.retained_receipt(s, id, clock, x)?;
        if receipt.outcome.is_ack() {
            self.db.read(s, clock, x, |c| {
                let registry = trust(registry_verification::verified(c))?;
                let owner = registry
                    .origins
                    .get(&receipt.identity.origin.to_string())
                    .ok_or(Error::Trust)?;
                let author = &registry.members.get(owner).ok_or(Error::Trust)?.key;
                let accepted = prefix(
                    c,
                    registry.root.network,
                    s.binding().local,
                    receipt.identity.origin,
                    author,
                )?
                .ok_or(Error::Integrity)?;
                if accepted.incarnation != receipt.identity.incarnation
                    || accepted.seq < receipt.identity.seq
                {
                    return Err(Error::Integrity);
                }
                Ok(())
            })?;
        }
        Ok(receipt)
    }
    fn export(
        &self,
        _: &VerifiedSession,
        _: &Identity,
        _: &dyn SyncClock,
        _: &Cancellation,
    ) -> Result<Envelope> {
        Err(Error::Protocol)
    }
    fn retain(
        &self,
        _: &VerifiedSession,
        _: ValidatedEvent,
        _: &dyn SyncClock,
        _: &Cancellation,
    ) -> Result<Receipt> {
        Err(Error::Protocol)
    }
    // Unsigned snapshots cannot carry signed provenance in this profile.
    fn snapshot_capture(
        &self,
        _: &VerifiedSession,
        _: Uuid,
        _: &dyn SyncClock,
        _: &Cancellation,
    ) -> Result<SnapshotExport> {
        Err(Error::Protocol)
    }
    fn snapshot_offer(
        &self,
        _: &VerifiedSession,
        _: &SnapshotOffer,
        _: &dyn SyncClock,
        _: &Cancellation,
    ) -> Result<()> {
        Err(Error::Protocol)
    }
    fn snapshot_chunk(
        &self,
        _: &VerifiedSession,
        _: &SnapshotChunk,
        _: &dyn SyncClock,
        _: &Cancellation,
    ) -> Result<()> {
        Err(Error::Protocol)
    }
    fn snapshot_publish(
        &self,
        _: &VerifiedSession,
        _: &SnapshotOffer,
        _: &dyn SyncClock,
        _: &Cancellation,
    ) -> Result<SnapshotReceipt> {
        Err(Error::Protocol)
    }
    fn snapshot_receipt(
        &self,
        _: &VerifiedSession,
        _: &SnapshotReceipt,
        _: &dyn SyncClock,
        _: &Cancellation,
    ) -> Result<()> {
        Err(Error::Protocol)
    }
}
// Retained does not mean applied. An exact quarantine identity stops discovery
// from requesting the same unsupported original forever; export still requires
// an accepted sealed prefix and cannot forward this quarantine as valid history.
fn quarantined(c: &Connection, session: &VerifiedSession, id: Uuid) -> Result<Option<Envelope>> {
    let row: Option<(Vec<u8>, Vec<u8>, Vec<u8>)> = c
        .query_row(
            "SELECT core,hash,envelope FROM e2_quarantine WHERE event=?1",
            [id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(sql)?;
    let Some((bytes, hash, metadata)) = row else {
        return Ok(None);
    };
    let event = crate::sync_api::bootstrap::envelope(bytes)?;
    if event.identity.event != id || event.identity.hash.as_slice() != hash {
        return Err(Error::Integrity);
    }
    let registry = trust(registry_verification::verified(c))?;
    let member = registry
        .origins
        .get(&event.identity.origin.to_string())
        .ok_or(Error::Trust)?;
    let author = &registry.members.get(member).ok_or(Error::Trust)?.key;
    let value = trust(trust(SignedOriginal::decode(&metadata))?.verify(
        registry.root.network,
        &event,
        author,
    ))?;
    sync_store::authorize_event_scope(session, &value)?;
    Ok(Some(event))
}
fn sql(_: rusqlite::Error) -> Error {
    Error::Storage
}
fn trust<T>(r: crate::sync_api::security::Result<T>) -> Result<T> {
    r.map_err(|_| Error::Trust)
}
impl<'a> SignedImportStore<'a> {
    #[cfg(test)]
    pub(crate) fn admitted_for_test(db: CandidateSyncStore<'a>) -> Self {
        Self { db }
    }
    pub fn production(_: &'a CaptureStore) -> Result<Self> {
        Err(Error::ActivationPending)
    }
    #[cfg(any(
        test,
        all(
            target_os = "android",
            feature = "android-identity-tests",
            debug_assertions
        )
    ))]
    pub fn synthetic(owner: &'a CaptureStore) -> Self {
        Self {
            db: CandidateSyncStore::synthetic(owner),
        }
    }
    fn require_registry(&self, session: &VerifiedSession) -> Result<()> {
        if session.registry_binding().is_none() {
            Err(Error::Trust)
        } else {
            Ok(())
        }
    }
    #[cfg(any(
        test,
        all(
            target_os = "android",
            feature = "android-identity-tests",
            debug_assertions
        )
    ))]
    pub(crate) fn install_qualification(owner: &CaptureStore) -> Result<()> {
        let mut c = owner.connection.lock().map_err(|_| Error::Storage)?;
        let tx = c
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(sql)?;
        tx.execute_batch(include_str!("signed_profile_candidate.sql"))
            .map_err(sql)?;
        tx.commit().map_err(sql)
    }
    pub fn retain(
        &self,
        session: &VerifiedSession,
        signed: &SignedOriginal,
        event: Envelope,
        clock: &dyn SyncClock,
        cancel: &Cancellation,
    ) -> Result<Receipt> {
        // There is no production constructor for either this adapter or VerifiedSession.
        self.db.write(session, clock, cancel, |c| {
            retain_in(c, session, signed, event, clock, cancel)
        })
    }
    #[cfg(test)]
    pub fn retain_with_barrier(
        &self,
        session: &VerifiedSession,
        signed: &SignedOriginal,
        event: Envelope,
        clock: &dyn SyncClock,
        cancel: &Cancellation,
        barrier: impl FnOnce(),
    ) -> Result<Receipt> {
        self.db.write(session, clock, cancel, |c| {
            let receipt = retain_in(c, session, signed, event, clock, cancel)?;
            barrier();
            Ok(receipt)
        })
    }
}
fn seal_bytes(
    network: Uuid,
    origin: Uuid,
    incarnation: Uuid,
    author: &PublicIdentity,
    seq: i64,
    hash: &[u8],
) -> Result<Vec<u8>> {
    trust(canonical(&(
        "accepted-origin-prefix-e2",
        network,
        origin,
        incarnation,
        author,
        seq,
        hash,
    )))
}
fn local_sign(c: &Connection, local: Uuid, bytes: &[u8]) -> Result<Vec<u8>> {
    #[cfg(any(windows, target_os = "android"))]
    {
        let (key, public) = trust(super::device_identity_store::bound_key(c, local))?;
        let signature = trust(key.sign_domain_separated(Domain::OriginalEvent, bytes))?;
        trust(verify(&public, Domain::OriginalEvent, bytes, &signature))?;
        Ok(signature)
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        let _ = (c, local, bytes);
        Err(Error::Trust)
    }
}
struct Prefix {
    incarnation: Uuid,
    seq: i64,
    hash: [u8; 32],
}
fn prefix(
    c: &Connection,
    network: Uuid,
    local: Uuid,
    origin: Uuid,
    author: &PublicIdentity,
) -> Result<Option<Prefix>> {
    let seal: Option<StoredSeal> = c
        .query_row(
            "SELECT incarnation,author,seq,hash,signature FROM e2_origin_seals WHERE origin=?1",
            [origin.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(sql)?;
    let Some((incarnation, key, seq, hash, signature)) = seal else {
        return Ok(None);
    };
    let incarnation = Uuid::parse_str(&incarnation).map_err(|_| Error::Integrity)?;
    if key != author.sec1() || !(1..=MAX_EVENTS as i64).contains(&seq) || hash.len() != 32 {
        return Err(Error::Integrity);
    }
    let bytes = seal_bytes(network, origin, incarnation, author, seq, &hash)?;
    #[cfg(any(windows, target_os = "android"))]
    {
        let (_, public) = trust(super::device_identity_store::bound_key(c, local))?;
        trust(verify(&public, Domain::OriginalEvent, &bytes, &signature))?;
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        let _ = (local, bytes, signature);
        return Err(Error::Trust);
    }
    let mut q = c.prepare("SELECT event,seq,hash,envelope FROM e2_originals WHERE origin=?1 ORDER BY seq LIMIT 257").map_err(sql)?;
    let rows = q
        .query_map([origin.to_string()], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Vec<u8>>(2)?,
                r.get::<_, Vec<u8>>(3)?,
            ))
        })
        .map_err(sql)?;
    let mut count = 0;
    let mut previous = [0; 32];
    for row in rows {
        let (id, position, saved_hash, original) = row.map_err(sql)?;
        count += 1;
        if count > MAX_EVENTS || position != count as i64 {
            return Err(Error::Integrity);
        }
        let id = Uuid::parse_str(&id).map_err(|_| Error::Integrity)?;
        let event = sync_store::load(c, id)?.ok_or(Error::Integrity)?;
        let original = trust(SignedOriginal::decode(&original))?;
        let value = trust(original.verify(network, &event, author))?;
        let accepted: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM import_events WHERE event=?1 AND outcome IN('applied','conflict') AND chain_ok=1)", [id.to_string()], |r| r.get(0)).map_err(sql)?;
        if !accepted
            || event.identity.origin != origin
            || event.identity.incarnation != incarnation
            || event.identity.seq != position
            || event.identity.hash.as_slice() != saved_hash
            || value.core().previous_event_hash != codec::hash_hex(&previous)
        {
            return Err(Error::Integrity);
        }
        previous = saved_hash.try_into().map_err(|_| Error::Integrity)?;
    }
    if count as i64 != seq || previous.as_slice() != hash {
        return Err(Error::Integrity);
    }
    Ok(Some(Prefix {
        incarnation,
        seq,
        hash: hash.try_into().map_err(|_| Error::Integrity)?,
    }))
}
fn unsupported(c: &Connection, signed: &SignedOriginal, event: &Envelope) -> Result<Receipt> {
    let envelope = trust(signed.bytes())?;
    let existing: Option<Vec<u8>> = c
        .query_row(
            "SELECT hash FROM e2_quarantine WHERE event=?1",
            [event.identity.event.to_string()],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    if let Some(hash) = existing {
        if hash != event.identity.hash {
            return Err(Error::Integrity);
        }
    } else {
        let (count, bytes): (i64, i64) = c
            .query_row(
                "SELECT count(*),coalesce(sum(length(core)+length(envelope)),0) FROM e2_quarantine",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(sql)?;
        if count >= 32 || bytes + event.bytes.len() as i64 + envelope.len() as i64 > 4 * 1024 * 1024
        {
            return Err(Error::StorageLimited);
        }
        c.execute(
            "INSERT INTO e2_quarantine VALUES(?1,?2,?3,?4)",
            params![
                event.identity.event.to_string(),
                event.identity.hash.as_slice(),
                event.bytes,
                envelope
            ],
        )
        .map_err(sql)?;
    }
    Ok(Receipt {
        identity: event.identity.clone(),
        outcome: Outcome::UnsupportedImportPolicy,
    })
}
fn retain_in(
    c: &Connection,
    session: &VerifiedSession,
    signed: &SignedOriginal,
    event: Envelope,
    clock: &dyn SyncClock,
    cancel: &Cancellation,
) -> Result<Receipt> {
    if session.registry_binding().is_none() {
        return Err(Error::Trust);
    }
    let registry = trust(registry_verification::verified(c))?;
    let id = &event.identity;
    let owner = registry
        .origins
        .get(&id.origin.to_string())
        .ok_or(Error::Trust)?;
    let member = registry.members.get(owner).ok_or(Error::Trust)?;
    let value = trust(signed.verify(registry.root.network, &event, &member.key))?;
    sync_store::authorize_event_scope(session, &value)?;
    if let Some(prior) = sync_store::load(c, id.event)? {
        if prior.identity != *id || prior.bytes != event.bytes {
            return Err(Error::Integrity);
        }
    }
    let prefix = prefix(
        c,
        registry.root.network,
        session.binding().local,
        id.origin,
        &member.key,
    )?;
    if let Some(prefix) = &prefix {
        if prefix.incarnation != id.incarnation {
            return unsupported(c, signed, &event);
        }
        if id.seq <= prefix.seq {
            let known: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM e2_originals WHERE event=?1 AND origin=?2 AND seq=?3 AND hash=?4)", params![id.event.to_string(),id.origin.to_string(),id.seq,id.hash.as_slice()], |r| r.get(0)).map_err(sql)?;
            if !known {
                return unsupported(c, signed, &event);
            }
            return sync_store::retain_signed_core_in(c, session, &value, clock, cancel);
        }
    }
    let now = i64::try_from(clock.now()).map_err(|_| Error::Trust)?;
    let previous = prefix.as_ref().map_or([0; 32], |p| p.hash);
    let sequence = prefix.as_ref().map_or(1, |p| p.seq + 1);
    let reused: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM e2_origin_seals WHERE incarnation=?1 AND origin<>?2)",
            params![id.incarnation.to_string(), id.origin.to_string()],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if !member.enabled
        || member.expires <= now
        || member.capabilities != 3
        || id.seq != sequence
        || id.seq > MAX_EVENTS as i64
        || reused
        || value.core().previous_event_hash != codec::hash_hex(&previous)
    {
        return unsupported(c, signed, &event);
    }
    let receipt = sync_store::retain_signed_core_in(c, session, &value, clock, cancel)?;
    let profile: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='e2_pending_signatures')",
            [],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if profile
        && matches!(
            receipt.outcome,
            Outcome::DeferredDependency | Outcome::UnsupportedImportPolicy
        )
    {
        let count: i64 = c
            .query_row("SELECT count(*) FROM e2_pending_signatures", [], |r| {
                r.get(0)
            })
            .map_err(sql)?;
        let exists: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM e2_pending_signatures WHERE event=?1)",
                [id.event.to_string()],
                |r| r.get(0),
            )
            .map_err(sql)?;
        if count >= MAX_EVENTS as i64 && !exists {
            return Err(Error::StorageLimited);
        }
        c.execute(
            "INSERT OR IGNORE INTO e2_pending_signatures VALUES(?1,?2)",
            params![id.event.to_string(), trust(signed.bytes())?],
        )
        .map_err(sql)?;
    }
    if receipt.outcome.is_ack() {
        // A receipt for an already-local canonical core is not proof of a
        // foreign import. Seal only an exact chain-verified main-ledger entry.
        let committed: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM import_events WHERE event=?1 AND origin=?2 AND incarnation=?3 AND seq=?4 AND hash=?5 AND bytes=?6 AND chain_ok=1 AND outcome IN('applied','conflict'))",
            params![id.event.to_string(),id.origin.to_string(),id.incarnation.to_string(),id.seq,id.hash.as_slice(),event.bytes],
            |r| r.get(0),
        ).map_err(sql)?;
        if !committed {
            return unsupported(c, signed, &event);
        }
        let bytes = seal_bytes(
            registry.root.network,
            id.origin,
            id.incarnation,
            &member.key,
            id.seq,
            &id.hash,
        )?;
        let signature = local_sign(c, session.binding().local, &bytes)?;
        c.execute("INSERT INTO e2_origin_seals VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(origin) DO UPDATE SET seq=excluded.seq,hash=excluded.hash,signature=excluded.signature", params![id.origin.to_string(),id.incarnation.to_string(),member.key.sec1(),id.seq,id.hash.as_slice(),signature]).map_err(sql)?;
        c.execute(
            "INSERT INTO e2_originals VALUES(?1,?2,?3,?4,?5)",
            params![
                id.event.to_string(),
                id.origin.to_string(),
                id.seq,
                id.hash.as_slice(),
                trust(signed.bytes())?
            ],
        )
        .map_err(sql)?;
        if profile {
            c.execute(
                "DELETE FROM e2_pending_signatures WHERE event=?1",
                [id.event.to_string()],
            )
            .map_err(sql)?;
        }
        c.execute(
            "DELETE FROM e2_quarantine WHERE event=?1",
            [id.event.to_string()],
        )
        .map_err(sql)?;
    }
    Ok(receipt)
}
