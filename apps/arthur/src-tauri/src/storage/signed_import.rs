//! E2 signed-import candidate. Same owner/transaction as actual apply; no wire or trust minting.
//! Previously committed prefixes are OS-signed, bounded and reverified against the real ledger.
use super::{
    capture_store::CaptureStore,
    journal::codec,
    registry_verification,
    sync_store::{self, CandidateSyncStore},
};
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
fn sql(_: rusqlite::Error) -> Error {
    Error::Storage
}
fn trust<T>(r: crate::sync_api::security::Result<T>) -> Result<T> {
    r.map_err(|_| Error::Trust)
}
impl<'a> SignedImportStore<'a> {
    pub fn production(_: &'a CaptureStore) -> Result<Self> {
        Err(Error::ActivationPending)
    }
    #[cfg(test)]
    pub fn synthetic(owner: &'a CaptureStore) -> Self {
        Self {
            db: CandidateSyncStore::synthetic(owner),
        }
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
            return sync_store::retain_in(c, session, &value, clock, cancel);
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
    let receipt = sync_store::retain_in(c, session, &value, clock, cancel)?;
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
    }
    Ok(receipt)
}
