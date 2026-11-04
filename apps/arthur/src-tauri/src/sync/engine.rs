use crate::sync_api::{
    bootstrap::*,
    protocol::*,
    trust::{TrustVerifier, VerifiedSession},
    validation::ValidatedEvent,
};
use crate::sync_api::{codec, SyncStore};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

struct Assembly {
    id: Identity,
    total: usize,
    count: usize,
    next: usize,
    bytes: Vec<u8>,
}
pub(crate) struct SyncEngine<'a, S: SyncStore + ?Sized, T: AuthenticatedTransport, C: SyncClock> {
    store: &'a S,
    transport: T,
    clock: &'a C,
    cancel: &'a Cancellation,
    session: VerifiedSession,
    negotiated: bool,
    profile: SyncProfile,
    signed_metadata: BTreeMap<Uuid, SignedMetadata>,
    advertised_after: Option<PageKey>,
    advertised_next: Option<PageKey>,
    assemblies: BTreeMap<Uuid, Assembly>,
    in_flight: BTreeSet<Uuid>,
    pub needs_attention: bool,
    pub status: SyncStatus,
    blocked: Option<Error>,
    // One already bounded/captured manifest and its next existing message.
    // Never assemble a second full chunk vector or enqueue the entire image.
    bootstrap: Option<(SnapshotExport, usize)>,
    bootstrap_evidence: Option<SnapshotExport>,
    snapshot_pending: Option<Uuid>,
    snapshot_done: Option<Uuid>,
    // Session-only receipt/request accounting. Canonical bytes, dependencies,
    // outcomes and restart progress remain solely in the existing SQLite ledger.
    deferred: BTreeSet<Uuid>,
    receipt_after: Option<Uuid>,
    requested_dependencies: BTreeSet<Uuid>,
    settle_left: usize,
    settle_scan: usize,
    settle_changed: bool,
}
impl<'a, S: SyncStore + ?Sized, T: AuthenticatedTransport, C: SyncClock> SyncEngine<'a, S, T, C> {
    pub fn start(
        store: &'a S,
        transport: T,
        trust: &dyn TrustVerifier,
        clock: &'a C,
        cancel: &'a Cancellation,
    ) -> Result<Self> {
        let session = trust.verify(&transport.hello())?;
        session.check(clock, cancel)?;
        // Authorize against durable membership/admission before any disclosure.
        let summary = store.summary(&session, clock, cancel)?;
        let profile = store.profile();
        let mut engine = Self {
            store,
            transport,
            clock,
            cancel,
            session,
            negotiated: false,
            profile,
            signed_metadata: BTreeMap::new(),
            advertised_after: None,
            advertised_next: None,
            assemblies: BTreeMap::new(),
            in_flight: BTreeSet::new(),
            needs_attention: summary.needs_attention,
            status: summary.status,
            blocked: None,
            bootstrap: None,
            bootstrap_evidence: None,
            snapshot_pending: None,
            snapshot_done: None,
            deferred: BTreeSet::new(),
            receipt_after: None,
            requested_dependencies: BTreeSet::new(),
            settle_left: 0,
            settle_scan: 0,
            settle_changed: false,
        };
        engine.send(Payload::Hello {
            version: profile.version(),
            required: profile.features(),
            supported: profile.features(),
            profile: profile.name().into(),
        })?;
        Ok(engine)
    }
    /// Cache a consistent source boundary now; disclose only after negotiation.
    pub fn bootstrap(&mut self, id: Uuid) -> Result<()> {
        if self.profile == SyncProfile::SignedOriginalCandidate {
            return Err(Error::Protocol);
        }
        if let Some(e) = self.blocked {
            return Err(e);
        }
        if self.bootstrap.is_some() || self.snapshot_pending.is_some() {
            return Err(Error::Limit);
        }
        let captured = if self.profile == SyncProfile::SignedHistory {
            self.store
                .signed_snapshot_capture(&self.session, id, self.clock, self.cancel)
                .map(|s| {
                    self.bootstrap_evidence = Some(s.evidence);
                    s.image
                })
        } else {
            self.store
                .snapshot_capture(&self.session, id, self.clock, self.cancel)
        };
        let snapshot = match captured {
            Ok(snapshot) => snapshot,
            Err(e) => {
                if matches!(
                    e,
                    Error::SnapshotTooLarge
                        | Error::StorageLimited
                        | Error::Storage
                        | Error::CommitUncertain
                        | Error::CommittedCleanupFailed
                ) {
                    self.status = SyncStatus::StorageLimited;
                    self.needs_attention = true;
                }
                return Err(e);
            }
        };
        self.bootstrap = Some((snapshot, 0));
        if self.negotiated {
            self.send_bootstrap()?;
        }
        Ok(())
    }
    fn send_bootstrap(&mut self) -> Result<()> {
        let Some((snapshot, next)) = self.bootstrap.as_ref() else {
            return Ok(());
        };
        let evidence_chunks = self
            .bootstrap_evidence
            .as_ref()
            .map_or(0, |e| e.offer.chunks);
        let done = *next == snapshot.offer.chunks + evidence_chunks + 1;
        let id = snapshot.offer.id;
        let payload = if let Some(evidence) = self.bootstrap_evidence.as_ref() {
            let offer = SignedSnapshotOffer {
                image: snapshot.offer.clone(),
                evidence: evidence.offer.clone(),
            };
            if *next == 0 {
                Payload::SignedSnapshotOffer(offer)
            } else if done {
                Payload::SignedSnapshotPublish(offer)
            } else if *next <= snapshot.offer.chunks {
                Payload::SignedSnapshotImage(snapshot.chunk(*next - 1).ok_or(Error::Integrity)?)
            } else {
                Payload::SignedSnapshotEvidence(
                    evidence
                        .chunk(*next - snapshot.offer.chunks - 1)
                        .ok_or(Error::Integrity)?,
                )
            }
        } else if *next == 0 {
            Payload::SnapshotOffer(snapshot.offer.clone())
        } else if done {
            Payload::SnapshotPublish(snapshot.offer.clone())
        } else {
            Payload::SnapshotChunk(snapshot.chunk(*next - 1).ok_or(Error::Integrity)?)
        };
        self.send(payload)?;
        if done {
            self.bootstrap = None;
            self.bootstrap_evidence = None;
            self.snapshot_pending = Some(id);
            self.retry()?;
            self.advertise()?;
        } else if let Some((_, next)) = self.bootstrap.as_mut() {
            *next += 1;
        }
        Ok(())
    }
    fn send(&mut self, payload: Payload) -> Result<()> {
        self.session.check(self.clock, self.cancel)?;
        self.store
            .authorize(&self.session, self.clock, self.cancel)?;
        let b = self.session.binding();
        self.transport.send(Message {
            network: b.network,
            session: b.session,
            from: b.local,
            to: b.peer,
            payload,
        })
    }
    fn advertise(&mut self) -> Result<()> {
        let summary = self.store.page(
            &self.session,
            self.advertised_after,
            self.clock,
            self.cancel,
        )?;
        self.advertised_next = summary.next;
        self.needs_attention = summary.needs_attention;
        self.status = summary.status;
        self.send(Payload::Summary(summary))
    }
    /// Explicit reread after a local native commit on an already negotiated
    /// candidate session. Reuses existing bounded inventory and authorization.
    pub(crate) fn refresh(&mut self) -> Result<()> {
        if let Some(e) = self.blocked {
            return Err(e);
        }
        if !self.negotiated || self.advertised_next.is_some() {
            return Err(Error::Protocol);
        }
        self.advertised_after = None;
        self.advertise()
    }
    fn retry(&mut self) -> Result<()> {
        let pending = self
            .store
            .outstanding(&self.session, self.clock, self.cancel)?;
        for id in pending {
            if self.in_flight.len() >= MAX_BATCH {
                break;
            }
            if self.in_flight.contains(&id) {
                continue;
            }
            if let Some(identity) = self
                .store
                .lookup(&self.session, id, self.clock, self.cancel)?
            {
                self.offer(&identity)?;
            }
        }
        Ok(())
    }
    fn offer(&mut self, id: &Identity) -> Result<()> {
        if self.in_flight.contains(&id.event) {
            return Ok(());
        }
        if self.in_flight.len() >= MAX_BATCH {
            return Err(Error::Limit);
        }
        let (e, metadata) = if self.profile.signed() {
            let signed = self
                .store
                .export_signed(&self.session, id, self.clock, self.cancel)?;
            if signed.event.identity != *id
                || signed.metadata.identity != *id
                || signed.metadata.bytes.is_empty()
                || signed.metadata.bytes.len() > MAX_SIGNED_METADATA
            {
                return Err(Error::Integrity);
            }
            (signed.event, Some(signed.metadata))
        } else {
            (
                self.store
                    .export(&self.session, id, self.clock, self.cancel)?,
                None,
            )
        };
        self.store
            .offered(&self.session, id, self.clock, self.cancel)?;
        self.in_flight.insert(id.event);
        if let Some(metadata) = metadata {
            self.send(Payload::SignedMetadata(metadata))?;
        }
        for chunk in chunk_event(&e) {
            self.send(Payload::Chunk(chunk))?;
        }
        Ok(())
    }
    fn settle_tick(&mut self) -> Result<bool> {
        if self.settle_left > 0 {
            let (processed, changed) = self.store.settle(&self.session, self.clock, self.cancel)?;
            self.settle_left -= 1;
            self.settle_scan -= 1;
            self.settle_changed |= changed;
            if changed {
                self.receipt_after = None;
            }
            if processed == 0 || (self.settle_scan == 0 && !self.settle_changed) {
                self.settle_left = 0;
            } else if self.settle_scan == 0 {
                self.settle_scan = MAX_EVENTS.div_ceil(REPROCESS_BATCH);
                self.settle_changed = false;
            }
            return Ok(true);
        }
        let next = self
            .deferred
            .iter()
            .copied()
            .find(|id| self.receipt_after.is_none_or(|after| *id > after));
        if let Some(id) = next {
            self.receipt_after = Some(id);
            let receipt =
                self.store
                    .retained_receipt(&self.session, id, self.clock, self.cancel)?;
            if receipt.outcome != Outcome::DeferredDependency {
                self.send(Payload::Receipt(receipt))?;
                self.deferred.remove(&id);
            }
            return Ok(true);
        }
        let mut request = Vec::new();
        for id in self.store.missing(&self.session, self.clock, self.cancel)? {
            if !self.requested_dependencies.contains(&id)
                && self
                    .store
                    .lookup(&self.session, id, self.clock, self.cancel)?
                    .is_none()
            {
                if self.requested_dependencies.len() == MAX_EVENTS {
                    return Err(Error::Limit);
                }
                self.requested_dependencies.insert(id);
                request.push(id);
                if request.len() == MAX_BATCH {
                    break;
                }
            }
        }
        if !request.is_empty() {
            self.send(Payload::Request(request))?;
            return Ok(true);
        }
        Ok(false)
    }
    /// One bounded network message, with no network callback inside a SQL tx.
    pub fn tick(&mut self) -> Result<bool> {
        if self.cancel.cancelled() {
            self.assemblies.clear();
            self.signed_metadata.clear();
            self.bootstrap = None;
            self.bootstrap_evidence = None;
            self.snapshot_pending = None;
            self.status = SyncStatus::Syncing;
            self.needs_attention = true;
            return Err(Error::Cancelled);
        }
        if let Some(e) = self.blocked {
            return Err(e);
        }
        let result = self.tick_message().and_then(|worked| {
            // The last receipt describes one operation, not the complete
            // history. A later applied event cannot hide retained problems.
            let summary = self.store.summary(&self.session, self.clock, self.cancel)?;
            self.needs_attention = summary.needs_attention;
            if summary.needs_attention || summary.status == SyncStatus::CleanlyApplied {
                self.status = summary.status;
            }
            if !summary.needs_attention
                && (self.bootstrap.is_some()
                    || self.snapshot_pending.is_some()
                    || !self.in_flight.is_empty()
                    || !self.assemblies.is_empty()
                    || !self.signed_metadata.is_empty()
                    || !self.deferred.is_empty()
                    || self.settle_left > 0)
            {
                self.status = SyncStatus::Syncing;
            }
            Ok(worked)
        });
        if let Err(e) = result {
            match e {
                Error::Trust => self.status = SyncStatus::RejectedTrust,
                Error::Integrity | Error::Protocol | Error::Limit => {
                    self.status = SyncStatus::RejectedIntegrity
                }
                Error::SnapshotTooLarge
                | Error::StorageLimited
                | Error::Storage
                | Error::CommitUncertain
                | Error::CommittedCleanupFailed => self.status = SyncStatus::StorageLimited,
                Error::Disconnected | Error::Cancelled => {
                    self.status = SyncStatus::Syncing;
                }
                _ => return result,
            }
            self.needs_attention = true;
            self.blocked = Some(e);
            self.assemblies.clear();
            self.signed_metadata.clear();
            self.bootstrap = None;
            self.bootstrap_evidence = None;
            self.snapshot_pending = None;
        }
        result
    }
    fn tick_message(&mut self) -> Result<bool> {
        if let Err(e) = self.session.check(self.clock, self.cancel) {
            self.assemblies.clear();
            self.signed_metadata.clear();
            return Err(e);
        }
        let Some(message) = self.transport.receive()? else {
            if self.negotiated && self.bootstrap.is_some() {
                self.send_bootstrap()?;
                return Ok(true);
            }
            return if self.negotiated {
                self.settle_tick()
            } else {
                Ok(false)
            };
        };
        let b = self.session.binding();
        if message.network != b.network
            || message.session != b.session
            || message.from != b.peer
            || message.to != b.local
        {
            return Err(Error::Trust);
        }
        if let Payload::Hello {
            version,
            required,
            supported,
            profile,
        } = message.payload
        {
            if self.negotiated
                || version != self.profile.version()
                || required & !self.profile.features() != 0
                || self.profile.features() & !supported != 0
                || profile != self.profile.name()
            {
                return Err(Error::Protocol);
            }
            self.negotiated = true;
            if self.bootstrap.is_some() {
                self.send_bootstrap()?;
            } else {
                self.retry()?;
                self.advertise()?;
            }
            return Ok(true);
        }
        if !self.negotiated {
            return Err(Error::Protocol);
        }
        if self.profile.signed()
            && matches!(
                &message.payload,
                Payload::SnapshotOffer(_)
                    | Payload::SnapshotChunk(_)
                    | Payload::SnapshotPublish(_)
                    | Payload::SnapshotReceipt(_)
            )
        {
            return Err(Error::Protocol);
        }
        let signed_evidence = matches!(&message.payload, Payload::SignedSnapshotEvidence(_));
        match message.payload {
            Payload::SignedSnapshotOffer(o) => {
                if self.profile != SyncProfile::SignedHistory {
                    return Err(Error::Protocol);
                }
                self.store
                    .signed_snapshot_offer(&self.session, &o, self.clock, self.cancel)?;
                self.status = SyncStatus::Syncing;
            }
            Payload::SignedSnapshotImage(ch) | Payload::SignedSnapshotEvidence(ch) => {
                if self.profile != SyncProfile::SignedHistory {
                    return Err(Error::Protocol);
                }
                // The bound descriptors determine which separately staged stream this is.
                let evidence = signed_evidence;
                self.store.signed_snapshot_chunk(
                    &self.session,
                    &ch,
                    evidence,
                    self.clock,
                    self.cancel,
                )?;
                self.status = SyncStatus::Syncing;
            }
            Payload::SignedSnapshotPublish(o) => {
                if self.profile != SyncProfile::SignedHistory {
                    return Err(Error::Protocol);
                }
                let r = self.store.signed_snapshot_publish(
                    &self.session,
                    &o,
                    self.clock,
                    self.cancel,
                )?;
                self.status = r.outcome.into();
                self.needs_attention = self
                    .store
                    .summary(&self.session, self.clock, self.cancel)?
                    .needs_attention
                    || r.outcome != Outcome::CleanlyApplied;
                self.send(Payload::SignedSnapshotReceipt(r))?;
            }
            Payload::SignedSnapshotReceipt(r) => {
                if self.profile != SyncProfile::SignedHistory {
                    return Err(Error::Protocol);
                }
                if self.snapshot_pending != Some(r.offer.image.id)
                    && self.snapshot_done != Some(r.offer.image.id)
                {
                    return Err(Error::Integrity);
                }
                self.store
                    .signed_snapshot_receipt(&self.session, &r, self.clock, self.cancel)?;
                if self.snapshot_pending == Some(r.offer.image.id) {
                    self.snapshot_pending = None;
                    self.snapshot_done = Some(r.offer.image.id);
                }
                self.status = r.outcome.into();
                self.needs_attention = self
                    .store
                    .summary(&self.session, self.clock, self.cancel)?
                    .needs_attention
                    || r.outcome != Outcome::CleanlyApplied;
            }
            Payload::SignedMetadata(metadata) => {
                if !self.profile.signed() {
                    return Err(Error::Protocol);
                }
                if metadata.bytes.is_empty() || metadata.bytes.len() > MAX_SIGNED_METADATA {
                    return Err(Error::Limit);
                }
                if !self.session.permits(metadata.identity.origin) {
                    return Err(Error::Trust);
                }
                if self.signed_metadata.contains_key(&metadata.identity.event)
                    || self.assemblies.contains_key(&metadata.identity.event)
                {
                    return Err(Error::Protocol);
                }
                if self.signed_metadata.len() >= MAX_ASSEMBLIES {
                    return Err(Error::Limit);
                }
                self.signed_metadata
                    .insert(metadata.identity.event, metadata);
                self.status = SyncStatus::Syncing;
            }
            Payload::SnapshotOffer(o) => {
                self.store
                    .snapshot_offer(&self.session, &o, self.clock, self.cancel)?;
                self.status = SyncStatus::Syncing;
            }
            Payload::SnapshotChunk(ch) => {
                self.store
                    .snapshot_chunk(&self.session, &ch, self.clock, self.cancel)?;
                self.status = SyncStatus::Syncing;
            }
            Payload::SnapshotPublish(o) => {
                let receipt =
                    self.store
                        .snapshot_publish(&self.session, &o, self.clock, self.cancel)?;
                self.status = receipt.outcome.into();
                self.needs_attention = self
                    .store
                    .summary(&self.session, self.clock, self.cancel)?
                    .needs_attention
                    || receipt.outcome != Outcome::CleanlyApplied;
                self.send(Payload::SnapshotReceipt(receipt))?;
            }
            Payload::SnapshotReceipt(r) => {
                if self.snapshot_pending != Some(r.offer.id)
                    && self.snapshot_done != Some(r.offer.id)
                {
                    return Err(Error::Integrity);
                }
                self.store
                    .snapshot_receipt(&self.session, &r, self.clock, self.cancel)?;
                if self.snapshot_pending == Some(r.offer.id) {
                    self.snapshot_pending = None;
                    self.snapshot_done = Some(r.offer.id);
                }
                self.status = r.outcome.into();
                self.needs_attention = self
                    .store
                    .summary(&self.session, self.clock, self.cancel)?
                    .needs_attention
                    || r.outcome != Outcome::CleanlyApplied;
            }
            Payload::Page(after) => {
                if self.advertised_next != Some(after) {
                    return Err(Error::Protocol);
                }
                self.advertised_after = Some(after);
                self.advertise()?;
            }
            Payload::Summary(remote) => {
                if remote.known.len() > SUMMARY_PAGE || remote.progress.len() > MAX_EVENTS {
                    return Err(Error::Limit);
                }
                let mut seen = BTreeSet::new();
                let mut previous = None;
                for id in &remote.known {
                    let key = (id.origin, id.incarnation, id.seq);
                    if id.seq <= 0 || !seen.insert(id.event) || previous.is_some_and(|p| p >= key) {
                        return Err(Error::Integrity);
                    }
                    previous = Some(key);
                }
                if remote
                    .next
                    .is_some_and(|n| n.2 <= 0 || previous.is_some_and(|p| p != n))
                    || remote.progress.iter().any(|p| {
                        p.applied < 0 || p.integrated < p.applied || p.stored < p.integrated
                    })
                {
                    return Err(Error::Integrity);
                }
                self.needs_attention = self
                    .store
                    .summary(&self.session, self.clock, self.cancel)?
                    .needs_attention;
                let mut request = Vec::new();
                for id in &remote.known {
                    match self
                        .store
                        .lookup(&self.session, id.event, self.clock, self.cancel)?
                    {
                        Some(local) if local != *id => return Err(Error::Integrity),
                        None if request.len() < MAX_BATCH => request.push(id.event),
                        _ => {}
                    }
                }
                if !request.is_empty() {
                    self.send(Payload::Request(request))?;
                } else if let Some(next) = remote.next {
                    self.send(Payload::Page(next))?;
                }
            }
            Payload::Chunk(chunk) => {
                self.status = SyncStatus::Syncing;
                let id = chunk.identity.event;
                if self.profile.signed() {
                    let metadata = self.signed_metadata.get(&id).ok_or(Error::Protocol)?;
                    if metadata.identity != chunk.identity {
                        return Err(Error::Integrity);
                    }
                }
                let result = self.chunk(chunk);
                let completed = match result {
                    Ok(e) => e,
                    Err(e) => {
                        self.assemblies.remove(&id);
                        return Err(e);
                    }
                };
                if let Some(e) = completed {
                    let validated = ValidatedEvent::parse(e)?;
                    if !self.session.permits(validated.envelope().identity.origin) {
                        return Err(Error::Trust);
                    }
                    let receipt = if self.profile.signed() {
                        let metadata = self.signed_metadata.remove(&id).ok_or(Error::Protocol)?;
                        self.store.retain_signed(
                            &self.session,
                            metadata,
                            validated.into_envelope(),
                            self.clock,
                            self.cancel,
                        )?
                    } else {
                        self.store
                            .retain(&self.session, validated, self.clock, self.cancel)?
                    };
                    self.needs_attention = self
                        .store
                        .summary(&self.session, self.clock, self.cancel)?
                        .needs_attention;
                    self.status = receipt.outcome.into();
                    if receipt.outcome == Outcome::DeferredDependency {
                        if self.deferred.len() == MAX_EVENTS && !self.deferred.contains(&id) {
                            return Err(Error::Limit);
                        }
                        self.deferred.insert(id);
                    } else {
                        self.deferred.remove(&id);
                    }
                    if !self.deferred.is_empty() {
                        self.settle_scan = MAX_EVENTS.div_ceil(REPROCESS_BATCH);
                        self.settle_left = MAX_EVENTS * self.settle_scan;
                        self.settle_changed = false;
                        self.receipt_after = None;
                    }
                    self.send(Payload::Receipt(receipt))?;
                }
            }
            Payload::Receipt(r) => {
                self.status = r.outcome.into();
                self.store
                    .receipt(&self.session, &r, self.clock, self.cancel)?;
                self.in_flight.remove(&r.identity.event);
                self.retry()?;
                self.needs_attention = self
                    .store
                    .summary(&self.session, self.clock, self.cancel)?
                    .needs_attention;
            }
            Payload::Request(ids) => {
                if ids.len() > MAX_BATCH {
                    return Err(Error::Limit);
                }
                for id in ids.into_iter().take(MAX_BATCH) {
                    if self.in_flight.len() >= MAX_BATCH {
                        break;
                    }
                    if let Some(e) =
                        self.store
                            .lookup(&self.session, id, self.clock, self.cancel)?
                    {
                        self.offer(&e)?;
                    }
                }
                self.advertise()?;
            }
            Payload::Hello { .. } => return Err(Error::Protocol),
        }
        Ok(true)
    }
    fn chunk(&mut self, c: Chunk) -> Result<Option<Envelope>> {
        if c.total == 0
            || c.total > codec::MAX_CANONICAL_BYTES
            || c.count != c.total.div_ceil(CHUNK)
            || c.index >= c.count
            || c.bytes.len() > CHUNK
            || c.bytes.len() > MAX_FRAME
            || codec::journal_event_hash(&c.bytes) != c.digest
        {
            return Err(Error::Integrity);
        }
        let expected = (c.total - c.index * CHUNK).min(CHUNK);
        if c.bytes.len() != expected {
            return Err(Error::Integrity);
        }
        if c.index == 0 {
            if self.assemblies.contains_key(&c.identity.event)
                || self.assemblies.len() >= MAX_ASSEMBLIES
            {
                return Err(Error::Limit);
            }
            self.assemblies.insert(
                c.identity.event,
                Assembly {
                    id: c.identity.clone(),
                    total: c.total,
                    count: c.count,
                    next: 0,
                    bytes: Vec::with_capacity(c.total),
                },
            );
        }
        let a = self
            .assemblies
            .get_mut(&c.identity.event)
            .ok_or(Error::Integrity)?;
        if a.id != c.identity || a.total != c.total || a.count != c.count || a.next != c.index {
            return Err(Error::Integrity);
        }
        a.bytes.extend(c.bytes);
        a.next += 1;
        if a.next == a.count {
            let a = self
                .assemblies
                .remove(&c.identity.event)
                .ok_or(Error::Integrity)?;
            if a.bytes.len() != a.total {
                return Err(Error::Integrity);
            }
            return Ok(Some(Envelope {
                identity: a.id,
                bytes: a.bytes,
            }));
        }
        Ok(None)
    }
}
