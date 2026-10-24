//! Separately versioned candidate envelopes. Never modifies canonical core bytes.
//! Not wired into release ingress until N1 and envelope compatibility are reviewed.
use super::{canonical, identity::*, Result, SecurityError as E};
use crate::sync::{Envelope, ValidatedEvent};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OriginalBinding {
    version: u32,
    network: Uuid,
    author: PublicIdentity,
    event: Uuid,
    bundle: Uuid,
    origin: Uuid,
    incarnation: Uuid,
    seq: i64,
    hash: [u8; 32],
}
impl OriginalBinding {
    fn new(network: Uuid, author: PublicIdentity, event: &Envelope) -> Self {
        let e = &event.identity;
        Self {
            version: 1,
            network,
            author,
            event: e.event,
            bundle: e.bundle,
            origin: e.origin,
            incarnation: e.incarnation,
            seq: e.seq,
            hash: e.hash,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SignedOriginal {
    body: OriginalBinding,
    signature: Vec<u8>,
}
impl SignedOriginal {
    pub fn sign(network: Uuid, event: &Envelope, key: &dyn DeviceIdentityStore) -> Result<Self> {
        ValidatedEvent::parse(event.clone()).map_err(|_| E::Invalid)?;
        let body = OriginalBinding::new(network, key.public_identity()?, event);
        let signature = key.sign_domain_separated(Domain::OriginalEvent, &canonical(&body)?)?;
        Ok(Self { body, signature })
    }
    pub fn verify(
        &self,
        network: Uuid,
        event: &Envelope,
        registered_original: &PublicIdentity,
    ) -> Result<ValidatedEvent> {
        if self.body != OriginalBinding::new(network, registered_original.clone(), event) {
            return Err(E::Trust);
        }
        verify(
            registered_original,
            Domain::OriginalEvent,
            &canonical(&self.body)?,
            &self.signature,
        )?;
        ValidatedEvent::parse(event.clone()).map_err(|_| E::Invalid)
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReceiptContext {
    pub network: Uuid,
    pub session: Uuid,
    pub sender: Uuid,
    pub receiver: Uuid,
    pub epoch: i64,
    pub exporter: [u8; 32],
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SignedReceipt {
    context: ReceiptContext,
    counter: u64,
    event: Uuid,
    hash: [u8; 32],
    outcome: String,
    signature: Vec<u8>,
}
impl SignedReceipt {
    pub fn sign(
        context: ReceiptContext,
        counter: u64,
        event: &Envelope,
        outcome: &str,
        key: &dyn DeviceIdentityStore,
    ) -> Result<Self> {
        if context.sender != key.public_identity()?.peer_id()
            || !matches!(outcome, "applied" | "conflict")
            || context.exporter == [0; 32]
        {
            return Err(E::Trust);
        }
        let mut receipt = Self {
            context,
            counter,
            event: event.identity.event,
            hash: event.identity.hash,
            outcome: outcome.into(),
            signature: vec![],
        };
        receipt.signature = key.sign_domain_separated(Domain::SessionReceipt, &receipt.bytes()?)?;
        Ok(receipt)
    }
    fn bytes(&self) -> Result<Vec<u8>> {
        canonical(&(
            &self.context,
            self.counter,
            self.event,
            self.hash,
            &self.outcome,
        ))
    }
}
pub(crate) struct ReceiptVerifier {
    context: ReceiptContext,
    next: u64,
}
impl ReceiptVerifier {
    pub fn new(context: ReceiptContext) -> Self {
        Self { context, next: 0 }
    }
    pub fn accept(
        &mut self,
        r: &SignedReceipt,
        event: &Envelope,
        key: &PublicIdentity,
    ) -> Result<()> {
        if r.context != self.context
            || r.counter != self.next
            || r.context.sender != key.peer_id()
            || r.event != event.identity.event
            || r.hash != event.identity.hash
            || !matches!(r.outcome.as_str(), "applied" | "conflict")
        {
            return Err(E::Trust);
        }
        verify(key, Domain::SessionReceipt, &r.bytes()?, &r.signature)?;
        self.next = self.next.checked_add(1).ok_or(E::Limit)?;
        Ok(())
    }
}
