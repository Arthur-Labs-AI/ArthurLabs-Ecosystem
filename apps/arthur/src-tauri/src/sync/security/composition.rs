//! Proposed composition metadata, NOT a PAKE implementation, grant or channel proof factory.
//! Audited PAKE must confirm this context inside provisional TLS before HUMAN approval.
use super::{
    canonical,
    identity::{verify_identity, PublicIdentity},
    Result, SecurityError as E,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
pub(crate) const SUITE: &str = "arthur-enrollment-e3a-tls13-p256-pake-pending-v1";
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Context {
    pub enrollment: Uuid,
    pub network: Uuid,
    pub admin: [u8; 32],
    pub issuer: PublicIdentity,
    pub joiner: PublicIdentity,
    pub issuer_nonce: [u8; 32],
    pub joiner_nonce: [u8; 32],
    pub suite: String,
}
impl Context {
    pub fn digest(&self, exporter: &[u8; 32]) -> Result<[u8; 32]> {
        for id in [self.enrollment, self.network] {
            if id.get_version_num() != 4 || id.get_variant() != uuid::Variant::RFC4122 {
                return Err(E::Invalid);
            }
        }
        verify_identity(&self.issuer)?;
        verify_identity(&self.joiner)?;
        if self.admin != self.issuer.device_id()
            || self.issuer == self.joiner
            || self.suite != SUITE
            || self.issuer_nonce == [0; 32]
            || self.joiner_nonce == [0; 32]
            || self.issuer_nonce == self.joiner_nonce
            || *exporter == [0; 32]
        {
            return Err(E::Invalid);
        }
        let bytes = canonical(&("issuer", "joiner", self, exporter))?;
        let mut hash = Sha256::new();
        hash.update(b"arthur-enrollment-composition-e3a\0");
        hash.update(bytes);
        Ok(hash.finalize().into())
    }
}
pub(crate) fn audited_pake_adapter() -> Result<()> {
    Err(E::N1AuditPending)
}

#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) mod lab {
    use super::*;
    use crate::sync::security::tls_lab::LabChannel;
    // This is explicitly synthetic, not bool-based production authentication.
    pub struct SyntheticPakeConfirmation {
        issuer: [u8; 32],
        joiner: [u8; 32],
    }
    impl SyntheticPakeConfirmation {
        pub fn fixture(issuer: [u8; 32], joiner: [u8; 32]) -> Self {
            Self { issuer, joiner }
        }
    }
    pub struct Attempt {
        expected: Context,
        used: bool,
    }
    pub struct PendingHumanApproval {
        _binding: [u8; 32],
    }
    impl PendingHumanApproval {
        // No bool, UUID or successful TLS handshake can turn this into a grant.
        pub fn grant(&self) -> Result<()> {
            Err(E::N1AuditPending)
        }
    }
    impl Attempt {
        pub fn new(expected: Context) -> Self {
            Self {
                expected,
                used: false,
            }
        }
        pub fn finish(
            &mut self,
            received: &Context,
            channel: &LabChannel,
            pake: &SyntheticPakeConfirmation,
        ) -> Result<PendingHumanApproval> {
            if self.used {
                return Err(E::Replay);
            }
            self.used = true;
            let expected = self.expected.digest(channel.exporter())?;
            if expected != received.digest(channel.exporter())?
                || received.issuer != *channel.server()
                || received.joiner != *channel.client()
                || pake.issuer != expected
                || pake.joiner != expected
            {
                return Err(E::Trust);
            }
            Ok(PendingHumanApproval { _binding: expected })
        }
    }
}
