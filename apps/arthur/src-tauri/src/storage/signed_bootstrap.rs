//! R9 composition over the existing owner/bootstrap importer, never a second ledger.
use super::{
    bootstrap_store as boot, registry_verification, signed_import as signed,
    sync_store::CandidateSyncStore,
};
use crate::sync_api::{
    bootstrap::*,
    security::{identity::*, signed::SignedOriginal},
    signed_bootstrap::{ManifestBody, SignedManifest, SIGNED_BOOTSTRAP_PROFILE},
    *,
};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;
fn sql(_: rusqlite::Error) -> Error {
    Error::Storage
}
fn trust<T>(r: crate::sync_api::security::Result<T>) -> Result<T> {
    r.map_err(|_| Error::Trust)
}
fn ready(c: &Connection, s: &VerifiedSession) -> Result<()> {
    if s.registry_binding().is_none() || signed::accepted_tables(c)?.0 != "r9_origin_seals" {
        return Err(Error::Trust);
    }
    Ok(())
}
fn evidence(c: &Connection, image: &SnapshotOffer) -> Result<SnapshotOffer> {
    let (hash, bytes, chunks): (Vec<u8>, i64, i64) = c
        .query_row(
            "SELECT hash,bytes,chunks FROM r9_bootstrap_evidence WHERE id=?1",
            [image.id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(sql)?
        .ok_or(Error::Protocol)?;
    let offer = SnapshotOffer {
        id: image.id,
        hash: hash.try_into().map_err(|_| Error::Integrity)?,
        bytes: usize::try_from(bytes).map_err(|_| Error::Integrity)?,
        chunks: usize::try_from(chunks).map_err(|_| Error::Integrity)?,
    };
    SignedSnapshotOffer {
        image: image.clone(),
        evidence: offer.clone(),
    }
    .validate()?;
    Ok(offer)
}
fn bounded(c: &Connection) -> Result<()> {
    let (units, bytes): (i64, i64) = c.query_row("SELECT count(*),coalesce(sum(coalesce(length(manifest),0)),0)+(SELECT coalesce(sum(length(bytes)),0) FROM r9_evidence_chunks) FROM r9_bootstrap_evidence", [], |r|Ok((r.get(0)?,r.get(1)?))).map_err(sql)?;
    if units > 4 || bytes > (4 * SIGNED_EVIDENCE_BYTES) as i64 {
        return Err(Error::StorageLimited);
    }
    Ok(())
}
fn check_manifest(
    c: &Connection,
    s: &VerifiedSession,
    offer: &SignedSnapshotOffer,
    image: &SnapshotImage,
    events: &[ValidatedEvent],
    bytes: &[u8],
    source: bool,
) -> Result<SignedManifest> {
    if bytes.len() != offer.evidence.bytes
        || crate::sync_api::codec::journal_event_hash(bytes) != offer.evidence.hash
    {
        return Err(Error::Integrity);
    }
    let registry = trust(registry_verification::verified(c))?;
    let manifest = SignedManifest::decode(bytes)?;
    let b = &manifest.body;
    let signer = if source {
        s.binding().local
    } else {
        s.binding().peer
    };
    let member = registry
        .members
        .get(&signer.to_string())
        .ok_or(Error::Trust)?;
    manifest.verify(&member.key)?;
    if b.network != s.binding().network
        || b.epoch != s.binding().epoch
        || b.registry != registry.root.digest
        || b.image != offer.image
        || b.high_water != image.high_water
        || b.originals.len() != events.len()
    {
        return Err(Error::Trust);
    }
    for (event, original) in events.iter().zip(&b.originals) {
        let owner = registry
            .origins
            .get(&event.envelope().identity.origin.to_string())
            .ok_or(Error::Trust)?;
        let author = &registry.members.get(owner).ok_or(Error::Trust)?.key;
        trust(original.verify_validated(b.network, event, author))?;
        super::sync_store::authorize_event_scope(s, event)?;
    }
    for (h, signature) in b.high_water.iter().zip(&b.prefix_signatures) {
        let author = &registry
            .members
            .get(registry.origins.get(&h.origin).ok_or(Error::Trust)?)
            .ok_or(Error::Trust)?
            .key;
        let hash = unhex(&h.hash)?;
        let preimage = signed::seal_bytes(
            b.network,
            Uuid::parse_str(&h.origin).map_err(|_| Error::Integrity)?,
            Uuid::parse_str(&h.incarnation).map_err(|_| Error::Integrity)?,
            author,
            h.seq.parse().map_err(|_| Error::Integrity)?,
            &hash,
        )?;
        trust(verify(
            &member.key,
            Domain::OriginalEvent,
            &preimage,
            signature,
        ))?;
    }
    Ok(manifest)
}
pub(super) fn capture(
    store: &CandidateSyncStore<'_>,
    s: &VerifiedSession,
    id: Uuid,
    clock: &dyn SyncClock,
    x: &Cancellation,
) -> Result<SignedSnapshotExport> {
    store.write(s, clock, x, |c| {
        ready(c, s)?;
        let started = std::time::Instant::now();
        let captured = boot::capture_validated_in(c, s, id)?;
        let image = captured.export;
        // Image, original signatures, manifest and staging share the original
        // five-second capture budget. Boot failures retain their own phase trace.
        let mut trace = super::bootstrap_trace::Capture::from_start(started);
        let result = (|| {
            trace.report.image_bytes = image.bytes.len();
            trace.phase("signed_decode")?;
            let parsed = captured.image;
            trace.report.events = parsed.cores.len();
            trace.report.rows = parsed.rows.len();
            trace.phase("signed_originals")?;
            let events = captured.events;
            if boot::signed_unit(c, id)? {
                let o = evidence(c, &image.offer)?;
                let bytes: Vec<u8> = c
                    .query_row(
                        "SELECT manifest FROM r9_bootstrap_evidence WHERE id=?1",
                        [id.to_string()],
                        |r| r.get(0),
                    )
                    .map_err(sql)?;
                check_manifest(
                    c,
                    s,
                    &SignedSnapshotOffer {
                        image: image.offer.clone(),
                        evidence: o.clone(),
                    },
                    &parsed,
                    &events,
                    &bytes,
                    true,
                )?;
                trace.check()?;
                return Ok(SignedSnapshotExport {
                    image,
                    evidence: SnapshotExport { offer: o, bytes },
                });
            }
            let registry = trust(registry_verification::verified(c))?;
            let mut admission = signed::Admission::new(c, s)?;
            let originals = events
                .iter()
                .map(|event| {
                    trace.check()?;
                    let export = admission.export_validated(&event.envelope().identity, event)?;
                    trust(SignedOriginal::decode(&export.metadata.bytes))
                })
                .collect::<Result<Vec<_>>>()?;
            trace.check()?;
            let mut prefixes = Vec::new();
            for h in &parsed.high_water {
                let author = &registry
                    .members
                    .get(registry.origins.get(&h.origin).ok_or(Error::Trust)?)
                    .ok_or(Error::Trust)?
                    .key;
                let preimage = signed::seal_bytes(
                    registry.root.network,
                    Uuid::parse_str(&h.origin).map_err(|_| Error::Integrity)?,
                    Uuid::parse_str(&h.incarnation).map_err(|_| Error::Integrity)?,
                    author,
                    h.seq.parse().map_err(|_| Error::Integrity)?,
                    &unhex(&h.hash)?,
                )?;
                prefixes.push(signed::local_sign(c, s.binding().local, &preimage)?);
                trace.check()?;
            }
            trace.phase("signed_manifest")?;
            #[cfg(any(windows, target_os = "android"))]
            let manifest = {
                let (key, public) = trust(super::device_identity_store::bound_key(
                    c,
                    s.binding().local,
                ))?;
                SignedManifest::sign(
                    ManifestBody {
                        profile: SIGNED_BOOTSTRAP_PROFILE.into(),
                        version: 1,
                        network: registry.root.network,
                        epoch: registry.root.epoch,
                        registry: registry.root.digest,
                        image: image.offer.clone(),
                        high_water: parsed.high_water,
                        originals,
                        prefix_signatures: prefixes,
                        signer: public,
                    },
                    &key,
                )?
            };
            #[cfg(not(any(windows, target_os = "android")))]
            let manifest: SignedManifest = return Err(Error::Trust);
            let bytes = manifest.bytes()?;
            let o = SnapshotOffer {
                id,
                hash: crate::sync_api::codec::journal_event_hash(&bytes),
                bytes: bytes.len(),
                chunks: bytes.len().div_ceil(CHUNK),
            };
            trace.phase("signed_stage")?;
            c.execute(
                "INSERT INTO r9_bootstrap_evidence VALUES(?1,?2,?3,?4,?5)",
                params![
                    id.to_string(),
                    o.hash.as_slice(),
                    o.bytes as i64,
                    o.chunks as i64,
                    bytes
                ],
            )
            .map_err(sql)?;
            bounded(c)?;
            trace.check()?;
            Ok(SignedSnapshotExport {
                image,
                evidence: SnapshotExport { offer: o, bytes },
            })
        })();
        trace.report.failure = result.as_ref().err().copied();
        result
    })
}

pub(super) fn offer(
    store: &CandidateSyncStore<'_>,
    s: &VerifiedSession,
    o: &SignedSnapshotOffer,
    clock: &dyn SyncClock,
    x: &Cancellation,
) -> Result<()> {
    o.validate()?;
    store.write(s, clock, x, |c| {
        ready(c, s)?;
        let was_signed = boot::signed_unit(c, o.image.id)?;
        // An existing unsigned unit may not be relabelled as signed.
        let exists: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM bootstrap_units WHERE id=?1)",
                [o.image.id.to_string()],
                |r| r.get(0),
            )
            .map_err(sql)?;
        if exists && !was_signed {
            return Err(Error::Protocol);
        }
        boot::stage_offer_in(c, s, &o.image, true)?;
        if was_signed {
            if evidence(c, &o.image)? != o.evidence {
                return Err(Error::Integrity);
            }
        } else {
            c.execute(
                "INSERT INTO r9_bootstrap_evidence VALUES(?1,?2,?3,?4,NULL)",
                params![
                    o.image.id.to_string(),
                    o.evidence.hash.as_slice(),
                    o.evidence.bytes as i64,
                    o.evidence.chunks as i64
                ],
            )
            .map_err(sql)?;
        }
        bounded(c)
    })
}
pub(super) fn chunk(
    store: &CandidateSyncStore<'_>,
    s: &VerifiedSession,
    ch: &SnapshotChunk,
    proof: bool,
    clock: &dyn SyncClock,
    x: &Cancellation,
) -> Result<()> {
    store.write(s, clock, x, |c| {
        ready(c, s)?;
        if !boot::signed_unit(c, ch.offer.id)? {
            return Err(Error::Protocol);
        }
        let (hash, bytes, chunks): (Vec<u8>, i64, i64) = c
            .query_row(
                "SELECT hash,bytes,chunks FROM bootstrap_units WHERE id=?1",
                [ch.offer.id.to_string()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(sql)?;
        let image = SnapshotOffer {
            id: ch.offer.id,
            hash: hash.try_into().map_err(|_| Error::Integrity)?,
            bytes: bytes as usize,
            chunks: chunks as usize,
        };
        boot::unit(c, s, &image, "in")?;
        if !proof {
            if image != ch.offer {
                return Err(Error::Integrity);
            }
            return boot::stage_chunk_in(c, s, ch, true);
        }
        if evidence(c, &image)? != ch.offer
            || ch.index >= ch.offer.chunks
            || ch.bytes.len() != (ch.offer.bytes - ch.index * CHUNK).min(CHUNK)
            || crate::sync_api::codec::journal_event_hash(&ch.bytes) != ch.hash
        {
            return Err(Error::Integrity);
        }
        let prior: Option<(Vec<u8>, Vec<u8>)> = c
            .query_row(
                "SELECT hash,bytes FROM r9_evidence_chunks WHERE id=?1 AND ordinal=?2",
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
                "INSERT INTO r9_evidence_chunks VALUES(?1,?2,?3,?4)",
                params![
                    ch.offer.id.to_string(),
                    ch.index as i64,
                    ch.hash.as_slice(),
                    ch.bytes
                ],
            )
            .map_err(sql)?;
        }
        bounded(c)
    })
}
pub(super) fn publish(
    store: &CandidateSyncStore<'_>,
    s: &VerifiedSession,
    o: &SignedSnapshotOffer,
    clock: &dyn SyncClock,
    x: &Cancellation,
) -> Result<SignedSnapshotReceipt> {
    o.validate()?;
    store.write(s, clock, x, |c| publish_in(c, s, o, clock, x))
}
fn publish_in(
    c: &Connection,
    s: &VerifiedSession,
    o: &SignedSnapshotOffer,
    clock: &dyn SyncClock,
    x: &Cancellation,
) -> Result<SignedSnapshotReceipt> {
    ready(c, s)?;
    if evidence(c, &o.image)? != o.evidence {
        return Err(Error::Integrity);
    }
    let verified = boot::verify(c, s, &o.image)?;
    let image = verified.image();
    let events = verified.events();
    let mut q=c.prepare("SELECT ordinal,hash,bytes FROM r9_evidence_chunks WHERE id=?1 ORDER BY ordinal LIMIT 6").map_err(sql)?;
    let mut rows = q.query([o.image.id.to_string()]).map_err(sql)?;
    let mut bytes = Vec::with_capacity(o.evidence.bytes);
    let mut index = 0;
    while let Some(r) = rows.next().map_err(sql)? {
        let n: i64 = r.get(0).map_err(sql)?;
        let hash: Vec<u8> = r.get(1).map_err(sql)?;
        let chunk: Vec<u8> = r.get(2).map_err(sql)?;
        if index >= o.evidence.chunks
            || n != index as i64
            || chunk.len() != (o.evidence.bytes - index * CHUNK).min(CHUNK)
            || crate::sync_api::codec::journal_event_hash(&chunk).as_slice() != hash
        {
            return Err(Error::Integrity);
        }
        bytes.extend(chunk);
        index += 1;
    }
    if index != o.evidence.chunks {
        return Err(Error::Protocol);
    }
    let manifest = check_manifest(c, s, o, image, events, &bytes, false)?;
    let proof_indices = events
        .iter()
        .enumerate()
        .map(|(i, e)| (e.envelope().identity.event, i))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut admission = signed::Admission::new(c, s)?;
    let receipts = boot::publish_verified(
        c,
        s,
        &o.image,
        clock,
        x,
        verified.with_signed_provenance(),
        |_c, event| {
            let i = *proof_indices
                .get(&event.envelope().identity.event)
                .ok_or(Error::Integrity)?;
            admission.retain_validated(&manifest.body.originals[i], event, clock, x)
        },
    )?;
    if receipts.outcome == Outcome::CleanlyApplied {
        for (id, index) in &proof_indices {
            let event = super::sync_store::load(c, *id)?.ok_or(Error::Integrity)?;
            admission.accepted(&event, &manifest.body.originals[*index])?;
        }
    }
    Ok(SignedSnapshotReceipt {
        offer: o.clone(),
        outcome: receipts.outcome,
    })
}
#[cfg(test)]
pub(super) fn publish_with_barrier(
    store: &CandidateSyncStore<'_>,
    s: &VerifiedSession,
    o: &SignedSnapshotOffer,
    clock: &dyn SyncClock,
    x: &Cancellation,
    barrier: impl FnOnce(&Connection),
) -> Result<SignedSnapshotReceipt> {
    store.write(s, clock, x, |c| {
        let result = publish_in(c, s, o, clock, x)?;
        barrier(c);
        Ok(result)
    })
}
pub(super) fn receipt(
    store: &CandidateSyncStore<'_>,
    s: &VerifiedSession,
    r: &SignedSnapshotReceipt,
    clock: &dyn SyncClock,
    x: &Cancellation,
) -> Result<()> {
    store.write(s, clock, x, |c| {
        ready(c, s)?;
        if evidence(c, &r.offer.image)? != r.offer.evidence {
            return Err(Error::Integrity);
        }
        boot::receipt_in(
            c,
            s,
            &SnapshotReceipt {
                offer: r.offer.image.clone(),
                outcome: r.outcome,
            },
            true,
        )
    })
}
#[cfg(any(
    test,
    all(
        target_os = "android",
        feature = "android-identity-tests",
        debug_assertions
    )
))]
pub(crate) fn install(owner: &super::capture_store::CaptureStore) -> Result<()> {
    let mut c = owner.connection.lock().map_err(|_| Error::Storage)?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(sql)?;
    let local: String = tx
        .query_row(
            "SELECT local_id FROM import_candidate WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if signed::accepted_tables(&tx)?.0 == "r9_origin_seals" {
        signed::check_history_compatibility(
            &tx,
            Uuid::parse_str(&local).map_err(|_| Error::Integrity)?,
        )?;
        return tx.commit().map_err(sql);
    }
    tx.execute_batch(include_str!("signed_profile_r9_candidate.sql"))
        .map_err(sql)?;
    signed::upgrade_history_in(&tx, Uuid::parse_str(&local).map_err(|_| Error::Integrity)?)?;
    tx.commit().map_err(sql)
}
