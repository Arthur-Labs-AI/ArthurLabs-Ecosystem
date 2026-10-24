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
pub(crate) const SUITE: &str =
    "arthur-e3a2-opaque401-ristretto255-3dh-sha512-argon2id-tls13-p256-pending-v1";
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum Endpoint {
    Sponsor,
    Joiner,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Context {
    pub enrollment: Uuid,
    pub network: Uuid,
    pub admin: [u8; 32],
    pub admin_key: PublicIdentity,
    pub sponsor: PublicIdentity,
    // Explicitly the code issuer, NOT an implicit TLS or PAKE role.
    pub issuer: PublicIdentity,
    pub joiner: PublicIdentity,
    pub issuer_nonce: [u8; 32],
    pub joiner_nonce: [u8; 32],
    pub suite: String,
    pub tls_server: Endpoint,
    pub pake_server: Endpoint,
    pub pake_client: Endpoint,
}
impl Context {
    pub fn digest(&self, exporter: &[u8; 32]) -> Result<[u8; 32]> {
        for id in [self.enrollment, self.network] {
            if id.get_version_num() != 4 || id.get_variant() != uuid::Variant::RFC4122 {
                return Err(E::Invalid);
            }
        }
        for key in [&self.admin_key, &self.sponsor, &self.issuer] {
            verify_identity(key)?;
        }
        verify_identity(&self.joiner)?;
        if self.admin != self.admin_key.device_id()
            || self.issuer == self.joiner
            || self.suite != SUITE
            || self.issuer_nonce == [0; 32]
            || self.joiner_nonce == [0; 32]
            || self.issuer_nonce == self.joiner_nonce
            || *exporter == [0; 32]
            || self.pake_server != Endpoint::Sponsor
            || self.pake_client != Endpoint::Joiner
        {
            return Err(E::Invalid);
        }
        // This is an explicit ADMIN-ONLY qualification profile. Delegation is N2,
        // not inferred from a sponsor, TLS role, code possession or prior membership.
        if self.sponsor != self.admin_key || self.issuer != self.sponsor {
            return Err(E::N2PolicyPending);
        }
        let bytes = canonical(&(
            "admin-only-sponsorship",
            "code-issuer",
            "joining-device",
            self,
            exporter,
        ))?;
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
    use crate::sync::security::pake_qualification::{Binding, ConfirmedExchange};
    use crate::sync::security::tls_lab::LabChannel;
    pub fn binding(context: &Context, channel: &LabChannel) -> Result<Binding> {
        let (server, client) = match context.tls_server {
            Endpoint::Sponsor => (&context.sponsor, &context.joiner),
            Endpoint::Joiner => (&context.joiner, &context.sponsor),
        };
        if server != channel.server() || client != channel.client() {
            return Err(E::Trust);
        }
        Ok(Binding {
            context: context.digest(channel.exporter())?,
            enrollment: *context.enrollment.as_bytes(),
            code_issuer: context.issuer.device_id(),
        })
    }
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
    // Only actual upstream mutual confirmation can produce this lab-only type.
    pub struct QualifiedPending {
        context: Context,
        digest: [u8; 32],
    }
    impl QualifiedPending {
        pub fn grant(&self) -> Result<()> {
            Err(E::N1AuditPending)
        }
        pub(crate) fn into_lab_parts(self) -> (Context, [u8; 32]) {
            (self.context, self.digest)
        }
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
                || binding(received, channel).is_err()
                || pake.issuer != expected
                || pake.joiner != expected
            {
                return Err(E::Trust);
            }
            Ok(PendingHumanApproval { _binding: expected })
        }
        pub fn finish_qualified(
            &mut self,
            received: &Context,
            channel: &LabChannel,
            pake: &ConfirmedExchange,
        ) -> Result<QualifiedPending> {
            if self.used {
                return Err(E::Replay);
            }
            self.used = true;
            let expected = binding(&self.expected, channel)?;
            if expected != binding(received, channel)? || !pake.matches(expected) {
                return Err(E::Trust);
            }
            Ok(QualifiedPending {
                context: received.clone(),
                digest: pake.approval_digest()?,
            })
        }
    }
}
