use super::{
    bootstrap::*,
    protocol::*,
    trust::{TrustVerifier, VerifiedSession},
    validation::ValidatedEvent,
};
use crate::storage::journal::codec;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub(crate) trait SyncStore {
    fn snapshot_capture(
        &self,
        s: &VerifiedSession,
        id: Uuid,
        c: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<SnapshotExport>;
    fn snapshot_offer(
        &self,
        s: &VerifiedSession,
        o: &SnapshotOffer,
        c: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<()>;
    fn snapshot_chunk(
        &self,
        s: &VerifiedSession,
        ch: &SnapshotChunk,
        c: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<()>;
    fn snapshot_publish(
        &self,
        s: &VerifiedSession,
        o: &SnapshotOffer,
        c: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<SnapshotReceipt>;
    fn snapshot_receipt(
        &self,
        s: &VerifiedSession,
        r: &SnapshotReceipt,
        c: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<()>;
    fn authorize(&self, s: &VerifiedSession, c: &dyn SyncClock, x: &Cancellation) -> Result<()>;
    fn summary(&self, s: &VerifiedSession, c: &dyn SyncClock, x: &Cancellation) -> Result<Summary>;
    fn page(
        &self,
        s: &VerifiedSession,
        after: Option<PageKey>,
        c: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<Summary>;
    fn lookup(
        &self,
        s: &VerifiedSession,
        id: Uuid,
        c: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<Option<Identity>>;
    fn export(
        &self,
        s: &VerifiedSession,
        id: &Identity,
        c: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<Envelope>;
    fn retain(
        &self,
        s: &VerifiedSession,
        e: ValidatedEvent,
        c: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<Receipt>;
    fn offered(
        &self,
        s: &VerifiedSession,
        id: &Identity,
        c: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<()>;
    fn receipt(
        &self,
        s: &VerifiedSession,
        r: &Receipt,
        c: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<()>;
    fn outstanding(
        &self,
        s: &VerifiedSession,
        c: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<Vec<Uuid>>;
    fn missing(
        &self,
        s: &VerifiedSession,
        c: &dyn SyncClock,
        x: &Cancellation,
    ) -> Result<Vec<Uuid>>;
}
struct Assembly {
    id: Identity,
    total: usize,
    count: usize,
    next: usize,
    bytes: Vec<u8>,
}
pub(crate) struct SyncEngine<'a, S: SyncStore, T: AuthenticatedTransport, C: SyncClock> {
    store: &'a S,
    transport: T,
    clock: &'a C,
    cancel: &'a Cancellation,
    session: VerifiedSession,
    negotiated: bool,
    advertised_after: Option<PageKey>,
    advertised_next: Option<PageKey>,
    assemblies: BTreeMap<Uuid, Assembly>,
    in_flight: BTreeSet<Uuid>,
    pub needs_attention: bool,
    pub status: SyncStatus,
    blocked: Option<Error>,
    bootstrap: Option<Uuid>,
}
impl<'a, S: SyncStore, T: AuthenticatedTransport, C: SyncClock> SyncEngine<'a, S, T, C> {
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
        let mut engine = Self {
            store,
            transport,
            clock,
            cancel,
            session,
            negotiated: false,
            advertised_after: None,
            advertised_next: None,
            assemblies: BTreeMap::new(),
            in_flight: BTreeSet::new(),
            needs_attention: summary.needs_attention,
            status: summary.status,
            blocked: None,
            bootstrap: None,
        };
        engine.send(Payload::Hello {
            version: 1,
            required: FEATURES,
            supported: FEATURES,
            profile: "m05-ledger-candidate".into(),
        })?;
        Ok(engine)
    }
    /// Cache a consistent source boundary now; disclose only after negotiation.
    pub fn bootstrap(&mut self, id: Uuid) -> Result<()> {
        if self.bootstrap.is_some() {
            return Err(Error::Limit);
        }
        if let Err(e) = self
            .store
            .snapshot_capture(&self.session, id, self.clock, self.cancel)
        {
            if matches!(
                e,
                Error::SnapshotTooLarge | Error::StorageLimited | Error::Storage
            ) {
                self.status = SyncStatus::StorageLimited;
                self.needs_attention = true;
            }
            return Err(e);
        }
        self.bootstrap = Some(id);
        if self.negotiated {
            self.send_bootstrap()?;
        }
        Ok(())
    }
    fn send_bootstrap(&mut self) -> Result<()> {
        let Some(id) = self.bootstrap.take() else {
            return Ok(());
        };
        let snapshot = self
            .store
            .snapshot_capture(&self.session, id, self.clock, self.cancel)?;
        self.send(Payload::SnapshotOffer(snapshot.offer.clone()))?;
        for chunk in snapshot.chunks() {
            self.send(Payload::SnapshotChunk(chunk))?;
        }
        self.send(Payload::SnapshotPublish(snapshot.offer))
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
        let e = self
            .store
            .export(&self.session, id, self.clock, self.cancel)?;
        self.store
            .offered(&self.session, id, self.clock, self.cancel)?;
        self.in_flight.insert(id.event);
        for chunk in chunk_event(&e) {
            self.send(Payload::Chunk(chunk))?;
        }
        Ok(())
    }
    /// One bounded network message, with no network callback inside a SQL tx.
    pub fn tick(&mut self) -> Result<bool> {
        if self.cancel.cancelled() {
            self.assemblies.clear();
            return Err(Error::Cancelled);
        }
        if let Some(e) = self.blocked {
            return Err(e);
        }
        let result = self.tick_message();
        if let Err(e) = result {
            match e {
                Error::Trust => self.status = SyncStatus::RejectedTrust,
                Error::Integrity | Error::Protocol | Error::Limit => {
                    self.status = SyncStatus::RejectedIntegrity
                }
                Error::SnapshotTooLarge | Error::StorageLimited | Error::Storage => {
                    self.status = SyncStatus::StorageLimited
                }
                _ => return result,
            }
            self.needs_attention = true;
            self.blocked = Some(e);
            self.assemblies.clear();
        }
        result
    }
    fn tick_message(&mut self) -> Result<bool> {
        if let Err(e) = self.session.check(self.clock, self.cancel) {
            self.assemblies.clear();
            return Err(e);
        }
        let Some(message) = self.transport.receive()? else {
            return Ok(false);
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
                || version != 1
                || required & !FEATURES != 0
                || FEATURES & !supported != 0
                || profile != "m05-ledger-candidate"
            {
                return Err(Error::Protocol);
            }
            self.negotiated = true;
            self.send_bootstrap()?;
            self.retry()?;
            self.advertise()?;
            return Ok(true);
        }
        if !self.negotiated {
            return Err(Error::Protocol);
        }
        match message.payload {
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
                self.store
                    .snapshot_receipt(&self.session, &r, self.clock, self.cancel)?;
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
                    let receipt =
                        self.store
                            .retain(&self.session, validated, self.clock, self.cancel)?;
                    self.needs_attention = self
                        .store
                        .summary(&self.session, self.clock, self.cancel)?
                        .needs_attention;
                    self.status = receipt.outcome.into();
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
