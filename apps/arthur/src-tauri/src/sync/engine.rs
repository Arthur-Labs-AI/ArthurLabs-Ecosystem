use super::{
    protocol::*,
    trust::{TrustVerifier, VerifiedSession},
    validation::ValidatedEvent,
};
use crate::storage::journal::codec;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub(crate) trait SyncStore {
    fn authorize(&self, s: &VerifiedSession, c: &dyn SyncClock, x: &Cancellation) -> Result<()>;
    fn summary(&self, s: &VerifiedSession, c: &dyn SyncClock, x: &Cancellation) -> Result<Summary>;
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
    assemblies: BTreeMap<Uuid, Assembly>,
    pub needs_attention: bool,
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
        let status = store.summary(&session, clock, cancel)?.needs_attention;
        let mut engine = Self {
            store,
            transport,
            clock,
            cancel,
            session,
            negotiated: false,
            assemblies: BTreeMap::new(),
            needs_attention: status,
        };
        engine.send(Payload::Hello {
            version: 1,
            required: FEATURES,
            supported: FEATURES,
            profile: "m05-ledger-candidate".into(),
        })?;
        Ok(engine)
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
    fn offer(&mut self, id: &Identity) -> Result<()> {
        let e = self
            .store
            .export(&self.session, id, self.clock, self.cancel)?;
        self.store
            .offered(&self.session, id, self.clock, self.cancel)?;
        for chunk in chunk_event(&e) {
            self.send(Payload::Chunk(chunk))?;
        }
        Ok(())
    }
    /// One bounded network message, with no network callback inside a SQL tx.
    pub fn tick(&mut self) -> Result<bool> {
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
            let summary = self.store.summary(&self.session, self.clock, self.cancel)?;
            self.send(Payload::Summary(summary))?;
            return Ok(true);
        }
        if !self.negotiated {
            return Err(Error::Protocol);
        }
        match message.payload {
            Payload::Summary(remote) => {
                if remote.known.len() > MAX_EVENTS || remote.progress.len() > MAX_EVENTS {
                    return Err(Error::Limit);
                }
                let mut seen = BTreeSet::new();
                for id in &remote.known {
                    if id.seq <= 0 || !seen.insert(id.event) {
                        return Err(Error::Integrity);
                    }
                }
                let local = self.store.summary(&self.session, self.clock, self.cancel)?;
                self.needs_attention |= local.needs_attention || remote.needs_attention;
                if remote
                    .progress
                    .iter()
                    .any(|p| p.applied < 0 || p.integrated < p.applied || p.stored < p.integrated)
                {
                    return Err(Error::Integrity);
                }
                let outstanding = self
                    .store
                    .outstanding(&self.session, self.clock, self.cancel)?;
                let mut selected = Vec::new();
                for id in &local.known {
                    if remote.known.iter().any(|r| r.event == id.event && r != id) {
                        return Err(Error::Integrity);
                    }
                    if !remote.known.contains(id) || outstanding.contains(&id.event) {
                        selected.push(id.clone())
                    }
                }
                for id in selected.into_iter().take(MAX_BATCH) {
                    self.offer(&id)?;
                }
                let missing = self.store.missing(&self.session, self.clock, self.cancel)?;
                if !missing.is_empty() {
                    self.send(Payload::Request(missing))?;
                }
            }
            Payload::Chunk(chunk) => {
                self.needs_attention = true;
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
                    self.needs_attention |= receipt.outcome != Outcome::CleanlyApplied;
                    self.send(Payload::Receipt(receipt))?;
                    let summary = self.store.summary(&self.session, self.clock, self.cancel)?;
                    self.send(Payload::Summary(summary))?;
                }
            }
            Payload::Receipt(r) => {
                self.store
                    .receipt(&self.session, &r, self.clock, self.cancel)?;
                self.needs_attention |= r.outcome != Outcome::CleanlyApplied;
            }
            Payload::Request(ids) => {
                if ids.len() > 32 {
                    return Err(Error::Limit);
                }
                let local = self.store.summary(&self.session, self.clock, self.cancel)?;
                for id in ids.into_iter().take(MAX_BATCH) {
                    if let Some(e) = local.known.iter().find(|e| e.event == id) {
                        self.offer(e)?;
                    }
                }
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
            if self.assemblies.contains_key(&c.identity.event) || self.assemblies.len() >= MAX_BATCH
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
