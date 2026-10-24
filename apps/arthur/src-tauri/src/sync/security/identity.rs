use super::{Result, SecurityError as E};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PublicIdentity {
    key: Vec<u8>,
}
impl PublicIdentity {
    pub fn from_sec1(key: Vec<u8>) -> Result<Self> {
        if key.len() != 65 || key[0] != 4 {
            return Err(E::Invalid);
        }
        let p = Self { key };
        verify_identity(&p)?;
        Ok(p)
    }
    pub fn sec1(&self) -> &[u8] {
        &self.key
    }
    pub fn device_id(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"arthur-device-p256-v1\0");
        h.update(&self.key);
        h.finalize().into()
    }
    pub fn peer_id(&self) -> Uuid {
        let digest = self.device_id();
        Uuid::from_bytes(digest[..16].try_into().expect("fixed digest"))
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum KeyAvailability {
    Available,
    Missing,
    Unavailable,
}
#[derive(Clone, Copy)]
pub(crate) enum Domain {
    Registry,
    EnrollmentReceipt,
    OriginalEvent,
    SessionReceipt,
}
impl Domain {
    fn bytes(self) -> &'static [u8] {
        match self {
            Self::Registry => b"arthur-registry-p256-v1",
            Self::EnrollmentReceipt => b"arthur-enrollment-receipt-v1",
            Self::OriginalEvent => b"arthur-original-envelope-v1",
            Self::SessionReceipt => b"arthur-session-receipt-v1",
        }
    }
}
pub(crate) fn digest(domain: Domain, bytes: &[u8]) -> Result<[u8; 32]> {
    if bytes.len() > 1024 * 1024 {
        return Err(E::Limit);
    }
    let mut h = Sha256::new();
    h.update(domain.bytes());
    h.update([0]);
    h.update((bytes.len() as u64).to_be_bytes());
    h.update(bytes);
    Ok(h.finalize().into())
}
pub(crate) trait DeviceIdentityStore: Send + Sync {
    fn create_identity(&self) -> Result<PublicIdentity>;
    fn public_identity(&self) -> Result<PublicIdentity>;
    fn sign_domain_separated(&self, domain: Domain, bytes: &[u8]) -> Result<Vec<u8>>;
    fn key_availability(&self) -> KeyAvailability;
    fn invalidate_identity(&self) -> Result<()>;
}
pub(crate) fn verify_identity(p: &PublicIdentity) -> Result<()> {
    if p.key.len() != 65 || p.key[0] != 4 {
        return Err(E::Invalid);
    }
    #[cfg(windows)]
    {
        super::windows::validate(p)
    }
    #[cfg(not(windows))]
    {
        Err(E::PlatformUnverified)
    }
}
pub(crate) fn verify(p: &PublicIdentity, d: Domain, bytes: &[u8], signature: &[u8]) -> Result<()> {
    if signature.len() != 64 {
        return Err(E::Signature);
    }
    verify_identity(p)?;
    #[cfg(windows)]
    {
        super::windows::verify(p, &digest(d, bytes)?, signature)
    }
    #[cfg(not(windows))]
    {
        let _ = (d, bytes);
        Err(E::PlatformUnverified)
    }
}
// Android has no Activity-independent signing bridge verified on target yet.
// Provider-secret AES wrapping is deliberately not reused as device identity.
pub(crate) struct UnavailableIdentity;
impl DeviceIdentityStore for UnavailableIdentity {
    fn create_identity(&self) -> Result<PublicIdentity> {
        Err(E::PlatformUnverified)
    }
    fn public_identity(&self) -> Result<PublicIdentity> {
        Err(E::MissingKey)
    }
    fn sign_domain_separated(&self, _: Domain, _: &[u8]) -> Result<Vec<u8>> {
        Err(E::KeyUnavailable)
    }
    fn key_availability(&self) -> KeyAvailability {
        KeyAvailability::Unavailable
    }
    fn invalidate_identity(&self) -> Result<()> {
        Err(E::PlatformUnverified)
    }
}
