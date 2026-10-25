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
    native_fence: Option<super::network_watch::Fence>,
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
            native_fence: None,
        })
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub(super) fn inspect_bound(
        socket: &tokio::net::TcpStream,
        live: &Arc<()>,
        facts: &super::route_candidate::Observation,
        fence: super::network_watch::Fence,
    ) -> Result<Self> {
        let local = socket.local_addr().map_err(|_| E::PlatformUnverified)?;
        let remote = socket.peer_addr().map_err(|_| E::PlatformUnverified)?;
        if !fence.valid() {
            return Err(E::Cancelled);
        }
        if local.port() == 0
            || remote != facts.endpoint
            || local.ip() != facts.local
            || !facts.source_selected
        {
            return Err(E::Trust);
        }
        Ok(Self {
            local,
            remote,
            live: Arc::downgrade(live),
            native_fence: Some(fence),
        })
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub(super) fn require_qualified_binding(&self) -> Result<()> {
        if self.live.upgrade().is_none() || self.native_fence.as_ref().is_none_or(|f| !f.valid()) {
            return Err(E::Cancelled);
        }
        Ok(())
    }
    pub(crate) fn matches(&self, expected: SocketAddr, source: IpAddr) -> Result<()> {
        if self.live.upgrade().is_none() || self.native_fence.as_ref().is_some_and(|f| !f.valid()) {
            return Err(E::Cancelled);
        }
        if self.remote != expected || self.local.ip() != source {
            return Err(E::Trust);
        }
        Ok(())
    }
    pub(crate) fn require_native_lan(&self) -> Result<()> {
        // Debug binding evidence does not approve N7 or create a production capability.
        Err(E::N7PolicyPending)
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub(super) fn addresses(&self) -> (SocketAddr, SocketAddr) {
        (self.local, self.remote)
    }
}

#[cfg(test)]
#[test]
fn r4_bound_endpoint_contradictions_lifetime_and_network_fence() {
    super::native_io_lab::execute(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (socket, peer) = super::native_io_lab::both(
            tokio::net::TcpStream::connect(listener.local_addr().unwrap()),
            listener.accept(),
        )
        .await;
        let socket = socket.unwrap();
        let _peer = peer.unwrap();
        let live = Arc::new(());
        let (signal, _rx) = super::network_watch::Signal::channel();
        let facts = super::route_candidate::Observation {
            generation: 1,
            captured: 0,
            interface: 1,
            network: 1,
            medium: super::route_candidate::Medium::Loopback,
            link: super::route_candidate::Link::Up,
            local: socket.local_addr().unwrap().ip(),
            source_selected: true,
            local_prefix: 8,
            route_interface: 1,
            destination: "127.0.0.0".parse().unwrap(),
            route_prefix: 8,
            next_hop: super::route_candidate::NextHop::Direct,
            endpoint: socket.peer_addr().unwrap(),
            platform: super::route_candidate::Platform::Unknown,
        };
        let evidence =
            ConnectedEndpoints::inspect_bound(&socket, &live, &facts, signal.fence().unwrap())
                .unwrap();
        assert!(evidence.require_qualified_binding().is_ok());
        assert!(evidence.require_native_lan().is_err()); // inspector is not policy approval
        for mode in 0..3 {
            let mut bad = facts.clone();
            match mode {
                0 => bad.local = "192.168.1.2".parse().unwrap(),
                1 => bad.endpoint.set_port(1),
                _ => bad.source_selected = false,
            }
            assert!(ConnectedEndpoints::inspect_bound(
                &socket,
                &live,
                &bad,
                signal.fence().unwrap()
            )
            .is_err());
        }
        signal.notify(super::network_watch::LOST);
        assert!(evidence.require_qualified_binding().is_err());
        assert!(evidence.matches(facts.endpoint, facts.local).is_err());
        let fresh =
            ConnectedEndpoints::inspect_bound(&socket, &live, &facts, signal.fence().unwrap())
                .unwrap();
        drop(live);
        assert!(fresh.require_qualified_binding().is_err());
    });
}
