use super::protocol::*;
use std::collections::BTreeSet;
use uuid::Uuid;
// Only this module can mint a context; there is no release trusted=true input.
pub(crate) struct VerifiedSession {
    hello: PeerHello,
    expires: u64,
    origins: BTreeSet<Uuid>,
}
impl VerifiedSession {
    pub fn binding(&self) -> &PeerHello {
        &self.hello
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
#[cfg(test)]
pub(super) struct TestTrust {
    pub hello: PeerHello,
    pub expires: u64,
    pub origins: BTreeSet<Uuid>,
}
#[cfg(test)]
impl TrustVerifier for TestTrust {
    fn verify(&self, hello: &PeerHello) -> Result<VerifiedSession> {
        if hello != &self.hello {
            return Err(Error::Trust);
        }
        Ok(VerifiedSession {
            hello: hello.clone(),
            expires: self.expires,
            origins: self.origins.clone(),
        })
    }
}
