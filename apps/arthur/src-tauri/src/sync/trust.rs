use super::protocol::*;
use std::collections::BTreeSet;
use uuid::Uuid;
// Only this module can mint a context; there is no release trusted=true input.
pub(crate) struct VerifiedSession {
    hello: PeerHello,
    expires: u64,
    origins: BTreeSet<Uuid>,
    registry: Option<super::security::enrollment::MembershipBinding>,
}
impl VerifiedSession {
    pub fn binding(&self) -> &PeerHello {
        &self.hello
    }
    pub fn origins(&self) -> impl Iterator<Item = Uuid> + '_ {
        self.origins.iter().copied()
    }
    pub fn permits(&self, origin: Uuid) -> bool {
        self.origins.contains(&origin)
    }
    pub fn check(&self, clock: &dyn SyncClock, cancel: &Cancellation) -> Result<()> {
        if cancel.cancelled() {
            return Err(Error::Cancelled);
        }
        if clock.now() >= self.expires {
            return Err(Error::Trust);
        }
        Ok(())
    }
    pub(crate) fn registry_binding(
        &self,
    ) -> Option<&super::security::enrollment::MembershipBinding> {
        self.registry.as_ref()
    }
    #[cfg(test)]
    pub(crate) fn with_registry(
        mut self,
        b: super::security::enrollment::MembershipBinding,
    ) -> Self {
        self.registry = Some(b);
        self
    }
}
pub(crate) trait TrustVerifier {
    fn verify(&self, hello: &PeerHello) -> Result<VerifiedSession>;
}
pub(crate) struct ClosedTrust;
impl TrustVerifier for ClosedTrust {
    fn verify(&self, _: &PeerHello) -> Result<VerifiedSession> {
        Err(Error::Trust)
    }
}
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) struct TestTrust {
    pub hello: PeerHello,
    pub expires: u64,
    pub origins: BTreeSet<Uuid>,
}
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
impl TrustVerifier for TestTrust {
    fn verify(&self, hello: &PeerHello) -> Result<VerifiedSession> {
        if hello != &self.hello {
            return Err(Error::Trust);
        }
        Ok(VerifiedSession {
            hello: hello.clone(),
            expires: self.expires,
            origins: self.origins.clone(),
            registry: None,
        })
    }
}

impl crate::native_security::enrollment::MembershipBinding {
    pub fn matches(&self, hello: &crate::sync_api::PeerHello) -> bool {
        hello.network == self.root.network
            && hello.epoch == self.root.epoch
            && hello.local == self.local
            && hello.peer == self.peer.peer_id()
    }
}
