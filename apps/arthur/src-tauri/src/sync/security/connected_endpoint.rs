//! Sealed socket facts, never caller-declared source/interface authorization.
use super::{Result, SecurityError as E};
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
use std::sync::Arc;
use std::{
    net::{IpAddr, SocketAddr},
    sync::Weak,
};
pub(crate) struct ConnectedEndpoints {
    local: SocketAddr,
    remote: SocketAddr,
    live: Weak<()>,
}
impl ConnectedEndpoints {
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub(super) fn inspect_loopback(socket: &tokio::net::TcpStream, live: &Arc<()>) -> Result<Self> {
        let local = socket.local_addr().map_err(|_| E::PlatformUnverified)?;
        let remote = socket.peer_addr().map_err(|_| E::PlatformUnverified)?;
        if !local.ip().is_loopback()
            || !remote.ip().is_loopback()
            || local.port() == 0
            || remote.port() == 0
        {
            return Err(E::Trust);
        }
        Ok(Self {
            local,
            remote,
            live: Arc::downgrade(live),
        })
    }
    pub(crate) fn matches(&self, expected: SocketAddr, source: IpAddr) -> Result<()> {
        if self.live.upgrade().is_none() {
            return Err(E::Cancelled);
        }
        if self.remote != expected || self.local.ip() != source {
            return Err(E::Trust);
        }
        Ok(())
    }
    pub(crate) fn require_native_lan(&self) -> Result<()> {
        // The only available constructor is a loopback qualification inspector.
        // Socket addresses do NOT prove selected interface/network/profile or permission.
        Err(E::N7PolicyPending)
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub(super) fn addresses(&self) -> (SocketAddr, SocketAddr) {
        (self.local, self.remote)
    }
}
