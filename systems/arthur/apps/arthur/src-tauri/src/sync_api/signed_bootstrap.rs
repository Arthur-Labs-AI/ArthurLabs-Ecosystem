//! Explicit R9 sidecar. Accepted SnapshotImage and original core bytes are unchanged.
use super::{
    bootstrap::*,
    security::{canonical, identity::*, signed::SignedOriginal},
    *,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub(crate) const SIGNED_BOOTSTRAP_PROFILE: &str = "m05-signed-history-candidate-v1";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ManifestBody {
    pub profile: String,
    pub version: u32,
    pub network: Uuid,
    pub epoch: i64,
    pub registry: [u8; 32],
    #[serde(with = "offer_binding")]
    pub image: SnapshotOffer,
    pub high_water: Vec<HighWater>,
    // Exact positional coverage of image.cores, not arbitrary forwarding claims.
    pub originals: Vec<SignedOriginal>,
    pub prefix_signatures: Vec<Vec<u8>>,
    pub signer: PublicIdentity,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SignedManifest {
    pub body: ManifestBody,
    signature: Vec<u8>,
}
// Keep legacy offer wire derives qualification-only. The signed manifest has
// its own explicit versioned descriptor binding, with the same four values.
mod offer_binding {
    use super::*;
    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Binding {
        id: Uuid,
        hash: [u8; 32],
        bytes: usize,
        chunks: usize,
    }
    pub fn serialize<S: serde::Serializer>(
        o: &SnapshotOffer,
        s: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        Binding {
            id: o.id,
            hash: o.hash,
            bytes: o.bytes,
            chunks: o.chunks,
        }
        .serialize(s)
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        d: D,
    ) -> std::result::Result<SnapshotOffer, D::Error> {
        let b = Binding::deserialize(d)?;
        Ok(SnapshotOffer {
            id: b.id,
            hash: b.hash,
            bytes: b.bytes,
            chunks: b.chunks,
        })
    }
}
fn trust<T>(r: super::security::Result<T>) -> Result<T> {
    r.map_err(|_| Error::Trust)
}
impl ManifestBody {
    fn validate(&self) -> Result<()> {
        self.image.validate()?;
        if self.profile != SIGNED_BOOTSTRAP_PROFILE
            || self.version != 1
            || self.epoch < 1
            || self.epoch > 4096
            || self.originals.len() > BOOTSTRAP_EVENTS
            || self.high_water.len() > BOOTSTRAP_EVENTS
            || self.prefix_signatures.len() != self.high_water.len()
            || self.prefix_signatures.iter().any(|s| s.len() != 64)
        {
            return Err(Error::Integrity);
        }
        for original in &self.originals {
            trust(original.bytes())?;
        }
        Ok(())
    }
    fn preimage(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let bytes = serde_jcs::to_vec(self).map_err(|_| Error::Integrity)?;
        if bytes.len() > SIGNED_EVIDENCE_BYTES {
            return Err(Error::Limit);
        }
        trust(canonical(&(
            "m05-signed-bootstrap-manifest-r9-v1",
            super::codec::journal_event_hash(&bytes),
        )))
    }
}
impl SignedManifest {
    pub fn sign(body: ManifestBody, key: &dyn DeviceIdentityStore) -> Result<Self> {
        if trust(key.public_identity())? != body.signer {
            return Err(Error::Trust);
        }
        let signature = trust(key.sign_domain_separated(Domain::OriginalEvent, &body.preimage()?))?;
        let value = Self { body, signature };
        value.bytes()?;
        Ok(value)
    }
    pub fn verify(&self, signer: &PublicIdentity) -> Result<()> {
        if &self.body.signer != signer {
            return Err(Error::Trust);
        }
        trust(verify(
            signer,
            Domain::OriginalEvent,
            &self.body.preimage()?,
            &self.signature,
        ))
    }
    pub fn bytes(&self) -> Result<Vec<u8>> {
        let bytes = serde_jcs::to_vec(self).map_err(|_| Error::Integrity)?;
        if bytes.len() > SIGNED_EVIDENCE_BYTES {
            return Err(Error::Limit);
        }
        Ok(bytes)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.is_empty() || bytes.len() > SIGNED_EVIDENCE_BYTES {
            return Err(Error::Limit);
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| Error::Integrity)?;
        value.body.validate()?;
        if value.bytes()? != bytes {
            return Err(Error::Integrity);
        }
        Ok(value)
    }
}
