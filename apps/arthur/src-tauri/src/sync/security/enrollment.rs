//! Public signed metadata only. No PAKE implementation or live pairing producer.
use super::{canonical, identity::*, Result, SecurityError as E};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};
#[derive(Clone)]
pub(crate) struct Root {
    pub network: Uuid,
    pub admin: PublicIdentity,
    pub epoch: i64,
    pub digest: [u8; 32],
}
// A read-only registry snapshot; NOT cryptographic channel evidence and cannot
// construct a release VerifiedSession. The owner rechecks it under its SQL lock.
#[derive(Clone)]
pub(crate) struct MembershipBinding {
    pub(crate) root: Root,
    pub(crate) local: Uuid,
    pub(crate) peer: PublicIdentity,
}
impl MembershipBinding {
    pub fn matches(&self, hello: &crate::sync::PeerHello) -> bool {
        hello.network == self.root.network
            && hello.epoch == self.root.epoch
            && hello.local == self.local
            && hello.peer == self.peer.peer_id()
    }
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum Role {
    Admin,
    Member,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub(crate) enum Action {
    Genesis {
        admin: PublicIdentity,
    },
    Grant {
        device: PublicIdentity,
        role: Role,
        capabilities: u8,
        enrollment: Uuid,
        expires: u64,
        origins: Vec<Uuid>,
    },
    Revoke {
        device: PublicIdentity,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Update {
    pub network: Uuid,
    pub epoch: i64,
    pub previous: [u8; 32],
    pub action: Action,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SignedUpdate {
    pub body: Update,
    pub signature: Vec<u8>,
}
impl Update {
    pub fn validate(&self) -> Result<()> {
        if self.network.get_version_num() != 4 || !(1..=4096).contains(&self.epoch) {
            return Err(E::Invalid);
        }
        match &self.action {
            Action::Genesis { admin } => {
                if self.epoch != 1 || self.previous != [0; 32] {
                    return Err(E::Invalid);
                }
                verify_identity(admin)?;
            }
            Action::Grant {
                device,
                role,
                capabilities,
                enrollment,
                expires,
                origins,
            } => {
                verify_identity(device)?;
                if *role != Role::Member
                    || !matches!(capabilities, 1..=3)
                    || enrollment.get_version_num() != 4
                    || *expires == 0
                    || *expires > i64::MAX as u64
                    || origins.len() > 64
                    || origins.iter().any(Uuid::is_nil)
                    || origins
                        .iter()
                        .collect::<std::collections::BTreeSet<_>>()
                        .len()
                        != origins.len()
                {
                    return Err(E::Invalid);
                }
            }
            Action::Revoke { device } => verify_identity(device)?,
        }
        Ok(())
    }
    pub fn hash(&self) -> Result<[u8; 32]> {
        digest(Domain::Registry, &canonical(self)?)
    }
}
impl SignedUpdate {
    pub fn sign(body: Update, identity: &dyn DeviceIdentityStore) -> Result<Self> {
        body.validate()?;
        let signature = identity.sign_domain_separated(Domain::Registry, &canonical(&body)?)?;
        Ok(Self { body, signature })
    }
    pub fn verify(&self, admin: &PublicIdentity) -> Result<()> {
        self.body.validate()?;
        verify(
            admin,
            Domain::Registry,
            &canonical(&self.body)?,
            &self.signature,
        )
    }
    pub fn bytes(&self) -> Result<Vec<u8>> {
        canonical(self)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > 16384 {
            return Err(E::Limit);
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| E::Invalid)?;
        if canonical(&value)? != bytes {
            return Err(E::Invalid);
        }
        value.body.validate()?;
        if value.signature.len() != 64 {
            return Err(E::Signature);
        }
        Ok(value)
    }
}
// No Debug, Clone, Serialize, string formatting or code hash. Six bytes are
// erased on Drop; this is not a guarantee against privileged crash/swap access.
pub(crate) struct SecretCode(Zeroizing<[u8; 6]>);
impl SecretCode {
    pub fn generate() -> Result<Self> {
        Self::with_random(|out| getrandom::fill(out).map_err(|_| E::KeyUnavailable))
    }
    pub(super) fn with_random(mut random: impl FnMut(&mut [u8]) -> Result<()>) -> Result<Self> {
        const LIMIT: u64 = ((u32::MAX as u64 + 1) / 1_000_000) * 1_000_000;
        for _ in 0..128 {
            let mut bytes = Zeroizing::new([0u8; 4]);
            random(bytes.as_mut())?;
            let mut n = u32::from_le_bytes(*bytes);
            if n as u64 >= LIMIT {
                n.zeroize();
                continue;
            }
            n %= 1_000_000;
            let mut digits = Zeroizing::new([b'0'; 6]);
            for digit in digits.iter_mut().rev() {
                *digit += (n % 10) as u8;
                n /= 10;
            }
            n.zeroize();
            return Ok(Self(digits));
        }
        Err(E::KeyUnavailable)
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub fn inspect(&self) -> &[u8; 6] {
        &self.0
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Transcript {
    pub enrollment: Uuid,
    pub network: Uuid,
    pub admin: [u8; 32],
    pub issuer: PublicIdentity,
    pub joiner: PublicIdentity,
    pub suite: String,
    pub issuer_nonce: [u8; 32],
    pub joiner_nonce: [u8; 32],
    pub exporter: [u8; 32],
}
impl Transcript {
    pub fn hash(&self) -> Result<[u8; 32]> {
        verify_identity(&self.issuer)?;
        verify_identity(&self.joiner)?;
        if self.suite != "arthur-enrollment-candidate-v1"
            || self.issuer == self.joiner
            || self.issuer_nonce == [0; 32]
            || self.joiner_nonce == [0; 32]
            || self.issuer_nonce == self.joiner_nonce
            || self.exporter == [0; 32]
        {
            return Err(E::Invalid);
        }
        let mut h = Sha256::new();
        h.update(b"arthur-enrollment-binding-v1\0issuer\0joiner\0");
        h.update(canonical(self)?);
        Ok(h.finalize().into())
    }
}
pub(crate) struct Attempt {
    pub(crate) enrollment: Uuid,
    pub(crate) nonce: Uuid,
    pub(crate) boot: Uuid,
}
pub(crate) struct CandidateProof {
    pub(super) transcript: Transcript,
    pub(super) ticket: Attempt,
}
impl CandidateProof {
    // Synthetic metadata proof ONLY. No release code can turn peer bytes into it.
    #[cfg(test)]
    pub fn fixture(ticket: Attempt, transcript: Transcript) -> Self {
        Self { transcript, ticket }
    }
    pub(crate) fn parts(&self) -> (&Attempt, &Transcript) {
        (&self.ticket, &self.transcript)
    }
}
pub(crate) struct Challenge {
    pub id: Uuid,
    pub(crate) started: u64,
    pub(crate) boot: Uuid,
    pub(crate) code: Option<SecretCode>,
}
impl Challenge {
    pub fn erase(&mut self) {
        self.code.take();
    }
}
pub(crate) fn live_pairing() -> Result<()> {
    Err(E::N1AuditPending)
}
