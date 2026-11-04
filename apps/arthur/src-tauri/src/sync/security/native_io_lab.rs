//! Isolated raw OS I/O. Not EncryptedIo, TLS, Sync or LAN route authorization.
#[cfg(not(any(
    test,
    all(
        target_os = "android",
        feature = "android-identity-tests",
        debug_assertions
    )
)))]
compile_error!("native loopback qualification is forbidden outside tests/debug instrumentation");
use super::{
    connected_endpoint::ConnectedEndpoints,
    transport_candidate::{Expected, Permit, Pool, Timer, TimerRegistration},
    SecurityError as E,
};
use std::{
    future::{poll_fn, Future},
    io,
    net::{Ipv4Addr, SocketAddr},
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf},
    net::{TcpSocket, TcpStream},
    time::{Instant, Sleep},
};
const STEP: usize = 4096;
const MAX: usize = 64 * 1024;
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Fault {
    Cancelled,
    Expired,
    Closed,
    Reset,
    Io(io::ErrorKind),
    Truncated,
    Frame,
    Limit,
    State,
}
type R<T> = std::result::Result<T, Fault>;
fn io_error(e: io::Error) -> Fault {
    match e.kind() {
        io::ErrorKind::ConnectionReset
        | io::ErrorKind::ConnectionAborted
        | io::ErrorKind::BrokenPipe => Fault::Reset,
        k => Fault::Io(k),
    }
}
fn security(e: E) -> Fault {
    if e == E::Cancelled {
        Fault::Cancelled
    } else {
        Fault::State
    }
}

/// Uses the existing reactor's monotonic epoch. No timer task is spawned.
pub(crate) struct NativeTimer {
    epoch: Instant,
    active: Arc<AtomicUsize>,
}
struct Registration {
    sleep: Option<Pin<Box<Sleep>>>,
    active: Arc<AtomicUsize>,
}
impl TimerRegistration for Registration {}
impl Drop for Registration {
    fn drop(&mut self) {
        self.sleep.take();
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}
impl NativeTimer {
    pub(crate) fn new() -> Self {
        Self::from_origin(std::time::Instant::now())
    }
    pub(crate) fn from_origin(epoch: std::time::Instant) -> Self {
        Self {
            epoch: Instant::from_std(epoch),
            active: Arc::default(),
        }
    }
    pub(crate) fn now(&self) -> u64 {
        Instant::now()
            .saturating_duration_since(self.epoch)
            .as_secs()
    }
    fn registrations(&self) -> usize {
        self.active.load(Ordering::Acquire)
    }
}
impl Timer for NativeTimer {
    fn poll_until(
        &self,
        cx: &mut Context<'_>,
        deadline: u64,
    ) -> (Poll<u64>, Box<dyn TimerRegistration>) {
        let mut sleep = Box::pin(tokio::time::sleep_until(
            self.epoch + Duration::from_secs(deadline),
        ));
        let poll = sleep.as_mut().poll(cx).map(|_| self.now());
        self.active.fetch_add(1, Ordering::AcqRel);
        (
            poll,
            Box::new(Registration {
                sleep: Some(sleep),
                active: self.active.clone(),
            }),
        )
    }
}

/// One owned socket + existing-Pool attempt. No raw socket implements EncryptedIo.
pub(crate) struct RawIo {
    socket: Option<TcpStream>,
    permit: Option<Permit>,
    timer: NativeTimer,
    registration: Option<Box<dyn TimerRegistration>>,
    identity: Option<Arc<()>>,
    native: Option<super::route_candidate::Observation>,
    session: bool,
    idle: u64,
}
impl RawIo {
    #[cfg(test)]
    pub(super) fn assert_handshake_accounting(&self) {
        assert!(
            !self.session,
            "binding must complete before session accounting"
        );
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub(super) fn tls_socket(socket: TcpStream, permit: Permit, timer: NativeTimer) -> R<Self> {
        Self::new(socket, permit, timer)
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub(super) fn tls_established(&mut self) -> R<()> {
        self.tls_revalidate()?;
        self.begin_lab_session()
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub(super) fn tls_record_complete(&mut self) {
        self.idle = self.timer.now();
    }
    #[cfg(test)]
    pub(super) fn tls_outbound_idle_fixture(&mut self) -> u64 {
        let now = self.timer.now().max(self.idle.saturating_add(5));
        self.timer = NativeTimer::from_origin(std::time::Instant::now() - Duration::from_secs(now));
        self.idle
    }
    #[cfg(test)]
    pub(super) fn tls_idle_for_test(&self) -> u64 {
        self.idle
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub(super) fn tls_deadline_fixture(&mut self, total: bool) {
        self.timer = NativeTimer::from_origin(
            std::time::Instant::now() - Duration::from_secs(if total { 59 } else { 14 }),
        );
        if total {
            self.idle = self.timer.now();
        }
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub(super) fn tls_closed(&self) -> bool {
        self.socket.is_none() && self.permit.is_none() && self.timer.registrations() == 0
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub(super) fn tls_endpoints(&self) -> super::Result<ConnectedEndpoints> {
        self.evidence()
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub(super) fn tls_reset_fixture(&mut self) {
        if let Some(s) = &self.socket {
            s.set_linger(Some(Duration::ZERO)).unwrap();
        }
        self.abort();
    }
    fn new(socket: TcpStream, permit: Permit, timer: NativeTimer) -> R<Self> {
        if !socket.local_addr().map_err(io_error)?.ip().is_loopback()
            || !socket.peer_addr().map_err(io_error)?.ip().is_loopback()
        {
            return Err(Fault::State);
        }
        let idle = timer.now();
        Ok(Self {
            socket: Some(socket),
            permit: Some(permit),
            timer,
            registration: None,
            identity: Some(Arc::new(())),
            native: None,
            session: false,
            idle,
        })
    }
    pub(super) fn tls_revalidate(&mut self) -> R<()> {
        let result = if self.native.is_some() {
            self.evidence().map(|_| ()).map_err(security)
        } else {
            Ok(())
        };
        if result.is_err() {
            self.abort();
        }
        result
    }
    fn evidence(&self) -> super::Result<ConnectedEndpoints> {
        if let Some(original) = &self.native {
            let socket = self.socket.as_ref().ok_or(E::Cancelled)?;
            let fence = self.permit.as_ref().ok_or(E::Cancelled)?.native_fence()?;
            let current = fresh_bound(socket, original, &fence, &self.timer).map_err(|e| {
                if e == Fault::Cancelled {
                    E::Cancelled
                } else {
                    E::Trust
                }
            })?;
            let evidence = ConnectedEndpoints::inspect_bound(
                socket,
                self.identity.as_ref().ok_or(E::Cancelled)?,
                &current,
                fence,
            )?;
            evidence.require_qualified_binding()?;
            return Ok(evidence);
        }
        ConnectedEndpoints::inspect_loopback(
            self.socket.as_ref().ok_or(E::Cancelled)?,
            self.identity.as_ref().ok_or(E::Cancelled)?,
        )
    }
    pub(crate) fn abort(&mut self) {
        self.registration.take();
        self.native.take();
        self.identity.take();
        self.socket.take();
        self.permit.take();
    }
    fn guard(&mut self, cx: &mut Context<'_>) -> R<()> {
        let result = (|| {
            if self.socket.is_none() {
                return Err(Fault::Closed);
            }
            let p = self.permit.as_ref().ok_or(Fault::Closed)?;
            p.register(cx).map_err(security)?;
            let deadline = if self.session {
                (self.idle + 15).min(p.started() + 60)
            } else {
                p.started() + 10
            };
            self.registration.take();
            let (poll, registration) = self.timer.poll_until(cx, deadline);
            self.registration = Some(registration);
            if self.timer.now() >= deadline || poll.is_ready() {
                #[cfg(test)]
                eprintln!("native deadline expired: now={} idle_at={} admission={} deadline={} session={}",self.timer.now(),self.idle,p.started(),deadline,self.session);
                return Err(Fault::Expired);
            }
            Ok(())
        })();
        if result.is_err() {
            self.abort();
        }
        result
    }
    pub(crate) fn poll_read(&mut self, cx: &mut Context<'_>, bytes: &mut [u8]) -> Poll<R<usize>> {
        if let Err(e) = self.guard(cx) {
            return Poll::Ready(Err(e));
        }
        if bytes.is_empty() {
            self.abort();
            return Poll::Ready(Err(Fault::Frame));
        }
        let limit = bytes.len().min(STEP);
        let mut out = ReadBuf::new(&mut bytes[..limit]);
        let result = Pin::new(self.socket.as_mut().unwrap())
            .poll_read(cx, &mut out)
            .map_ok(|_| out.filled().len())
            .map_err(io_error);
        if self.permit.as_ref().is_some_and(|p| p.cancelled()) {
            self.abort();
            return Poll::Ready(Err(Fault::Cancelled));
        }
        if result.is_ready() {
            self.registration.take();
            if let Some(p) = &self.permit {
                p.clear_registration();
            }
        }
        if matches!(&result, Poll::Ready(Err(_))) {
            self.abort();
        }
        result
    }
    pub(crate) fn poll_write(&mut self, cx: &mut Context<'_>, bytes: &[u8]) -> Poll<R<usize>> {
        if let Err(e) = self.guard(cx) {
            return Poll::Ready(Err(e));
        }
        if bytes.is_empty() {
            self.abort();
            return Poll::Ready(Err(Fault::Frame));
        }
        let result = Pin::new(self.socket.as_mut().unwrap())
            .poll_write(cx, &bytes[..bytes.len().min(STEP)])
            .map_err(io_error)
            .map(|r| match r {
                Ok(0) => Err(Fault::Closed),
                other => other,
            });
        if self.permit.as_ref().is_some_and(|p| p.cancelled()) {
            self.abort();
            return Poll::Ready(Err(Fault::Cancelled));
        }
        if result.is_ready() {
            self.registration.take();
            if let Some(p) = &self.permit {
                p.clear_registration();
            }
        }
        if matches!(&result, Poll::Ready(Err(_))) {
            self.abort();
        }
        result
    }
    async fn read(&mut self, b: &mut [u8]) -> R<usize> {
        poll_fn(|cx| self.poll_read(cx, b)).await
    }
    async fn write(&mut self, b: &[u8]) -> R<usize> {
        poll_fn(|cx| self.poll_write(cx, b)).await
    }
    async fn shutdown_write(&mut self) -> R<()> {
        poll_fn(|cx| {
            if let Err(e) = self.guard(cx) {
                return Poll::Ready(Err(e));
            }
            let result = Pin::new(self.socket.as_mut().unwrap())
                .poll_shutdown(cx)
                .map_err(io_error);
            if self.permit.as_ref().is_some_and(|p| p.cancelled()) {
                self.abort();
                return Poll::Ready(Err(Fault::Cancelled));
            }
            if result.is_ready() {
                self.registration.take();
                if let Some(p) = &self.permit {
                    p.clear_registration();
                }
            }
            if matches!(&result, Poll::Ready(Err(_))) {
                self.abort();
            }
            result
        })
        .await
    }
    fn begin_lab_session(&mut self) -> R<()> {
        let p = self.permit.take().ok_or(Fault::Closed)?;
        match p.establish(self.timer.now()) {
            Ok(p) => {
                self.permit = Some(p);
                self.session = true;
                self.idle = self.timer.now();
                Ok(())
            }
            Err(e) => {
                self.abort();
                Err(security(e))
            }
        }
    }
    async fn exact(&mut self, b: &mut [u8]) -> R<()> {
        let mut at = 0;
        while at < b.len() {
            let n = self.read(&mut b[at..]).await?;
            if n == 0 {
                self.abort();
                return Err(Fault::Truncated);
            }
            at += n;
        }
        Ok(())
    }
    /// Synthetic NLAB envelope only. Never accepts AE01 or Sync payload types.
    async fn lab_frame(&mut self) -> R<Vec<u8>> {
        let result = async {
            let mut header = [0; 8];
            self.exact(&mut header).await?;
            if &header[..4] != b"NLAB" {
                return Err(Fault::Frame);
            }
            let len = u32::from_be_bytes(header[4..].try_into().unwrap()) as usize;
            if len == 0 || len > MAX {
                return Err(Fault::Limit);
            }
            let mut out = vec![0; len];
            self.exact(&mut out).await?;
            self.idle = self.timer.now();
            self.registration.take();
            Ok(out)
        }
        .await;
        if result.is_err() {
            self.abort();
        }
        result
    }
}
impl Drop for RawIo {
    fn drop(&mut self) {
        self.abort();
    }
}

/// Both sides are created only here: constant loopback and OS-assigned port.
pub(crate) async fn pair(permit: Permit, timer: NativeTimer) -> R<(RawIo, TcpStream, SocketAddr)> {
    let listener_socket = TcpSocket::new_v4().map_err(io_error)?;
    listener_socket
        .set_recv_buffer_size(4096)
        .map_err(io_error)?;
    listener_socket
        .bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .map_err(io_error)?;
    let listener = listener_socket.listen(4).map_err(io_error)?;
    let selected = listener.local_addr().map_err(io_error)?;
    let client_socket = TcpSocket::new_v4().map_err(io_error)?;
    client_socket.set_send_buffer_size(4096).map_err(io_error)?;
    client_socket
        .bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .map_err(io_error)?;
    let (client, peer) = admitted(
        async {
            let client = client_socket.connect(selected).await.map_err(io_error)?;
            let (peer, _) = listener.accept().await.map_err(io_error)?;
            Ok((client, peer))
        },
        &permit,
        &timer,
    )
    .await?;
    drop(listener);
    Ok((RawIo::new(client, permit, timer)?, peer, selected))
}
async fn admitted<T>(
    work: impl Future<Output = R<T>>,
    permit: &Permit,
    timer: &NativeTimer,
) -> R<T> {
    let mut work = Box::pin(work);
    let mut registration = None;
    let result = poll_fn(|cx| {
        permit.register(cx).map_err(security)?;
        let deadline = permit.started() + 10;
        let (expired, next) = timer.poll_until(cx, deadline);
        registration = Some(next);
        if timer.now() >= deadline || expired.is_ready() {
            return Poll::Ready(Err(Fault::Expired));
        }
        let result = work.as_mut().poll(cx);
        if permit.cancelled() {
            return Poll::Ready(Err(Fault::Cancelled));
        }
        result
    })
    .await;
    drop(registration);
    permit.clear_registration();
    result
}
pub(crate) async fn connect_loopback(
    endpoint: SocketAddr,
    permit: Permit,
    timer: NativeTimer,
) -> R<RawIo> {
    if !endpoint.ip().is_loopback() || endpoint.port() == 0 {
        return Err(Fault::State);
    }
    let socket = admitted(
        async { TcpStream::connect(endpoint).await.map_err(io_error) },
        &permit,
        &timer,
    )
    .await?;
    RawIo::new(socket, permit, timer)
}
pub(crate) async fn accept_loopback(
    listener: tokio::net::TcpListener,
    permit: Permit,
    timer: NativeTimer,
) -> R<RawIo> {
    if !listener.local_addr().map_err(io_error)?.ip().is_loopback() {
        return Err(Fault::State);
    }
    let socket = admitted(
        async { listener.accept().await.map(|x| x.0).map_err(io_error) },
        &permit,
        &timer,
    )
    .await?;
    drop(listener);
    RawIo::new(socket, permit, timer)
}

// Explicit debug qualification only. Normal loopback factories above remain strict.
// The private native facts are attached only after the OS bound this owned socket.
fn native_snapshot(
    endpoint: SocketAddr,
    fence: &super::network_watch::Fence,
    timer: &NativeTimer,
) -> R<super::route_candidate::Observation> {
    use super::route_candidate::{Link, Medium, Platform};
    if !fence.valid() {
        return Err(Fault::Cancelled);
    }
    let mut o = super::route_observer::acquire_native(endpoint)
        .map_err(|_| Fault::State)?
        .into_facts();
    if o.link != Link::Up
        || !matches!(o.medium, Medium::Wifi | Medium::Ethernet)
        || !matches!(
            o.platform,
            Platform::WindowsPrivateProfileObserved
                | Platform::AndroidBroadPermissionObserved
                | Platform::AndroidLegacyInternetObserved
        )
        || o.interface == 0
        || o.network == 0
        || o.route_interface != o.interface
    {
        return Err(Fault::State);
    }
    o.generation = fence.generation();
    o.captured = timer.now();
    if !fence.valid() {
        return Err(Fault::Cancelled);
    }
    Ok(o)
}
#[cfg(windows)]
fn windows_interface(
    raw: std::os::windows::io::RawSocket,
    ipv4: bool,
    interface: u32,
    set: bool,
) -> R<()> {
    use windows_sys::Win32::Networking::WinSock::*;
    // IPv4 sets in network order; gets returns HOST order (Microsoft IP_UNICAST_IF).
    let (level, option, value) = if ipv4 {
        (IPPROTO_IP, IP_UNICAST_IF, interface.to_be())
    } else {
        (IPPROTO_IPV6, IPV6_UNICAST_IF, interface)
    };
    if interface == 0 {
        return Err(Fault::State);
    }
    // Winsock borrows the original owned socket; no duplicated descriptor escapes.
    unsafe {
        if set
            && setsockopt(
                raw as SOCKET,
                level,
                option,
                (&value as *const u32).cast(),
                4,
            ) != 0
        {
            return Err(io_error(io::Error::last_os_error()));
        }
        let mut actual = 0u32;
        let mut size = 4;
        if getsockopt(
            raw as SOCKET,
            level,
            option,
            (&mut actual as *mut u32).cast(),
            &mut size,
        ) != 0
            || size != 4
            || actual != interface
        {
            return Err(Fault::State);
        }
    }
    Ok(())
}
#[cfg(target_os = "android")]
fn android_bind(network: u64, fd: std::os::fd::RawFd) -> R<()> {
    #[link(name = "android")]
    unsafe extern "C" {
        fn android_setsocknetwork(network: u64, fd: std::ffi::c_int) -> std::ffi::c_int;
    }
    // NDK API23+, equivalent to Network.bindSocket(FileDescriptor). The FD is
    // still unconnected, borrowed from TcpSocket, and never transferred to Java.
    if network == 0 || unsafe { android_setsocknetwork(network, fd) } != 0 {
        return Err(io_error(io::Error::last_os_error()));
    }
    Ok(())
}
fn bind_selected(socket: &TcpSocket, o: &super::route_candidate::Observation, port: u16) -> R<()> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawSocket;
        windows_interface(
            socket.as_raw_socket(),
            o.endpoint.is_ipv4(),
            o.interface,
            true,
        )?;
    }
    #[cfg(target_os = "android")]
    {
        use std::os::fd::AsRawFd;
        android_bind(o.network, socket.as_raw_fd())?;
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        return Err(Fault::State);
    }
    // Only Android's explicit fixed client source port needs restart reuse.
    // The Windows listener uses a fresh OS-assigned port without reuse enabled.
    #[cfg(target_os = "android")]
    if port != 0 {
        socket.set_reuseaddr(true).map_err(io_error)?;
    }
    socket
        .bind(SocketAddr::new(o.local, port))
        .map_err(io_error)?;
    if socket.local_addr().map_err(io_error)?.ip() != o.local {
        return Err(Fault::State);
    }
    Ok(())
}
fn fresh_bound(
    socket: &TcpStream,
    original: &super::route_candidate::Observation,
    fence: &super::network_watch::Fence,
    timer: &NativeTimer,
) -> R<super::route_candidate::Observation> {
    use super::route_candidate::{Candidate, Hint, Origin};
    if !fence.valid() {
        return Err(Fault::Cancelled);
    }
    let local = socket.local_addr().map_err(io_error)?;
    let peer = socket.peer_addr().map_err(io_error)?;
    if peer != original.endpoint || local.ip() != original.local || local.port() == 0 {
        return Err(Fault::State);
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawSocket;
        windows_interface(
            socket.as_raw_socket(),
            peer.is_ipv4(),
            original.interface,
            false,
        )?;
    }
    let mut current = native_snapshot(peer, fence, timer)?;
    // This is socket-specific evidence: OS binding succeeded on the same owned
    // socket before connect, actual endpoints match, fresh OS facts agree, and
    // the callback fence has not changed. LinkProperties by itself never sets it.
    current.source_selected = true;
    let mut expected = original.clone();
    expected.captured = current.captured;
    if expected != current {
        return Err(Fault::State);
    }
    Candidate::evaluate_qualification(
        &Hint::parse(&peer.to_string(), Origin::Manual).map_err(security)?,
        &current,
        timer.now(),
    )
    .map_err(security)?;
    if !fence.valid() {
        return Err(Fault::Cancelled);
    }
    Ok(current)
}
fn native_raw(
    socket: TcpStream,
    permit: Permit,
    timer: NativeTimer,
    original: super::route_candidate::Observation,
) -> R<RawIo> {
    let fence = permit.native_fence().map_err(security)?;
    fresh_bound(&socket, &original, &fence, &timer)?;
    let idle = timer.now();
    Ok(RawIo {
        socket: Some(socket),
        permit: Some(permit),
        timer,
        registration: None,
        identity: Some(Arc::new(())),
        native: Some(original),
        session: false,
        idle,
    })
}
pub(crate) async fn connect_native_qualification(
    endpoint: SocketAddr,
    source: std::net::IpAddr,
    source_port: u16,
    permit: Permit,
    timer: NativeTimer,
) -> R<RawIo> {
    use super::route_candidate::{Candidate, Hint, Origin};
    let fence = permit.native_fence().map_err(security)?;
    let mut o = native_snapshot(endpoint, &fence, &timer)?;
    if o.local != source || source.is_unspecified() {
        return Err(Fault::State);
    }
    let socket = if endpoint.is_ipv4() {
        TcpSocket::new_v4()
    } else {
        TcpSocket::new_v6()
    }
    .map_err(io_error)?;
    bind_selected(&socket, &o, source_port)?;
    o.source_selected = true; // Only after OS binding AND explicit source binding succeeded.
    Candidate::evaluate_qualification(
        &Hint::parse(&endpoint.to_string(), Origin::Manual).map_err(security)?,
        &o,
        timer.now(),
    )
    .map_err(security)?;
    if !fence.valid() {
        return Err(Fault::Cancelled);
    }
    let socket = admitted(
        async { socket.connect(endpoint).await.map_err(io_error) },
        &permit,
        &timer,
    )
    .await?;
    native_raw(socket, permit, timer, o)
}
#[cfg(windows)]
pub(crate) fn listen_native_qualification(
    peer: SocketAddr,
    source: std::net::IpAddr,
    permit: &Permit,
    timer: &NativeTimer,
) -> R<tokio::net::TcpListener> {
    use super::route_candidate::{Candidate, Hint, Origin};
    let fence = permit.native_fence().map_err(security)?;
    let o = native_snapshot(peer, &fence, timer)?;
    if source != o.local || source.is_unspecified() {
        return Err(Fault::State);
    }
    // IP Helper selects the source on Windows. Private NLM category and route
    // eligibility are checked BEFORE creating any listening socket.
    Candidate::evaluate_qualification(
        &Hint::parse(&peer.to_string(), Origin::Manual).map_err(security)?,
        &o,
        timer.now(),
    )
    .map_err(security)?;
    let socket = if peer.is_ipv4() {
        TcpSocket::new_v4()
    } else {
        TcpSocket::new_v6()
    }
    .map_err(io_error)?;
    bind_selected(&socket, &o, 0)?;
    if !fence.valid() {
        return Err(Fault::Cancelled);
    }
    socket.listen(1).map_err(io_error)
}
#[cfg(windows)]
pub(crate) async fn accept_native_qualification(
    listener: tokio::net::TcpListener,
    peer: SocketAddr,
    permit: Permit,
    timer: NativeTimer,
) -> R<RawIo> {
    use std::os::windows::io::AsRawSocket;
    let fence = permit.native_fence().map_err(security)?;
    let o = native_snapshot(peer, &fence, &timer)?;
    if listener.local_addr().map_err(io_error)?.ip() != o.local {
        return Err(Fault::State);
    }
    windows_interface(listener.as_raw_socket(), peer.is_ipv4(), o.interface, false)?;
    let socket = admitted(
        async { listener.accept().await.map(|s| s.0).map_err(io_error) },
        &permit,
        &timer,
    )
    .await?;
    drop(listener);
    windows_interface(socket.as_raw_socket(), peer.is_ipv4(), o.interface, true)?;
    native_raw(socket, permit, timer, o)
}

fn expected() -> Expected {
    Expected {
        network: uuid::Uuid::new_v4(),
        peer: uuid::Uuid::new_v4(),
    }
}
async fn fixture() -> (RawIo, TcpStream, SocketAddr, Arc<Pool>) {
    let pool = Arc::new(Pool::default());
    let timer = NativeTimer::new();
    let permit = pool.admit(expected(), timer.now()).unwrap();
    let (io, peer, target) = pair(permit, timer).await.unwrap();
    (io, peer, target, pool)
}
pub(crate) async fn both<A: Future, B: Future>(a: A, b: B) -> (A::Output, B::Output) {
    let mut a = std::pin::pin!(a);
    let mut b = std::pin::pin!(b);
    let mut ra = None;
    let mut rb = None;
    poll_fn(|cx| {
        if ra.is_none() {
            if let Poll::Ready(r) = a.as_mut().poll(cx) {
                ra = Some(r);
            }
        }
        if rb.is_none() {
            if let Poll::Ready(r) = b.as_mut().poll(cx) {
                rb = Some(r);
            }
        }
        if ra.is_some() && rb.is_some() {
            Poll::Ready((ra.take().unwrap(), rb.take().unwrap()))
        } else {
            Poll::Pending
        }
    })
    .await
}
pub(crate) fn execute(f: impl Future<Output = ()>) {
    // JNI instrumentation threads have a limited stack. Keep bounded payloads
    // on the heap and do not copy a large future through runtime wrappers.
    assert!(
        std::mem::size_of_val(&f) <= 32 * 1024,
        "native lab future exceeds stack budget"
    );
    let f = Box::pin(f);
    tauri::async_runtime::block_on(async move {
        tokio::time::timeout(Duration::from_secs(120), f)
            .await
            .expect("native I/O watchdog");
    });
}

#[cfg_attr(test, test)]
fn n7d_actual_fragmentation_bounds_and_half_close() {
    execute(async {
        let (mut raw, mut peer, _, _) = fixture().await;
        let payload = vec![7u8; STEP * 3 + 19];
        let expected_payload = payload.clone();
        let (read, ()) = both(raw.lab_frame(), async {
            for b in b"NLAB" {
                peer.write_all(&[*b]).await.unwrap();
            }
            for b in (payload.len() as u32).to_be_bytes() {
                peer.write_all(&[b]).await.unwrap();
            }
            for part in payload.chunks(13) {
                peer.write_all(part).await.unwrap();
            }
        })
        .await;
        assert_eq!(read.unwrap(), expected_payload);
        assert_eq!(raw.timer.registrations(), 0);
        peer.shutdown().await.unwrap();
        assert_eq!(raw.read(&mut [0; 1]).await.unwrap(), 0);
        assert_eq!(raw.write(b"x").await.unwrap(), 1);
        let mut byte = [0];
        peer.read_exact(&mut byte).await.unwrap();
        assert_eq!(&byte, b"x");
        raw.shutdown_write().await.unwrap();
        assert_eq!(peer.read(&mut [0; 1]).await.unwrap(), 0);
        raw.abort();
        raw.abort();
        assert!(raw.socket.is_none());
        assert_eq!(raw.timer.registrations(), 0);
    });
}
#[cfg_attr(test, test)]
fn n7d_actual_truncation_oversize_zero_and_plain_sync_refusal() {
    execute(async {
        for bytes in [
            b"NLA".to_vec(),
            b"NLAB\0\0\0\x03x".to_vec(),
            b"NLAB\0\0\0\0".to_vec(),
            b"NLAB\0\x01\0\x01".to_vec(),
            b"AE01\0\0\0\x01x".to_vec(),
        ] {
            let (mut raw, mut peer, _, _) = fixture().await;
            peer.write_all(&bytes).await.unwrap();
            peer.shutdown().await.unwrap();
            assert!(matches!(
                raw.lab_frame().await,
                Err(Fault::Truncated | Fault::Frame | Fault::Limit)
            ));
            assert!(raw.socket.is_none());
            assert_eq!(raw.timer.registrations(), 0);
        }
    });
}
#[cfg_attr(test, test)]
fn n7d_actual_endpoint_evidence_is_loopback_only_and_expires() {
    execute(async {
        let (mut raw, mut peer, target, _) = fixture().await;
        let e = raw.evidence().unwrap();
        let (local, remote) = e.addresses();
        assert_eq!(remote, target);
        assert_eq!(peer.peer_addr().unwrap(), local);
        assert!(e.matches(target, Ipv4Addr::LOCALHOST.into()).is_ok());
        assert!(e
            .matches(SocketAddr::from((Ipv4Addr::LOCALHOST, 1)), local.ip())
            .is_err());
        assert!(e.matches(target, "192.168.1.2".parse().unwrap()).is_err());
        assert_eq!(e.require_native_lan(), Err(E::N7PolicyPending));
        raw.abort();
        assert_eq!(e.matches(target, local.ip()), Err(E::Cancelled));
        assert_eq!(peer.read(&mut [0; 1]).await.unwrap(), 0);
    });
}
#[cfg_attr(test, test)]
fn n7d_actual_cancel_pending_read_and_shutdown_close_socket() {
    execute(async {
        for shutdown in [false, true] {
            let (mut raw, mut peer, _, pool) = fixture().await;
            let cancel = raw.permit.as_ref().unwrap().cancellation();
            let (tx, rx) = tokio::sync::oneshot::channel();
            let mut signal = Some(tx);
            let read = async {
                let mut byte = [0];
                poll_fn(|cx| {
                    let p = raw.poll_read(cx, &mut byte);
                    if p.is_pending() {
                        if let Some(tx) = signal.take() {
                            let _ = tx.send(());
                        }
                    }
                    p
                })
                .await
            };
            let (result, ()) = both(read, async {
                rx.await.unwrap();
                if shutdown {
                    pool.shutdown().unwrap();
                } else {
                    cancel.cancel();
                    cancel.cancel();
                }
            })
            .await;
            assert_eq!(result, Err(Fault::Cancelled));
            assert!(raw.socket.is_none());
            assert_eq!(raw.timer.registrations(), 0);
            assert_eq!(peer.read(&mut [0; 1]).await.unwrap(), 0);
        }
    });
}
#[cfg_attr(test, test)]
fn n7d_actual_backpressure_partial_write_cancel_and_reset() {
    execute(async {
        let (mut raw, mut peer, _, _) = fixture().await;
        let cancel = raw.permit.as_ref().unwrap().cancellation();
        let block = vec![9u8; MAX];
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut signal = Some(tx);
        let mut sent = 0;
        let write = async {
            poll_fn(|cx| {
                // Bounded progress yields cooperatively; WouldBlock waits on the reactor.
                match raw.poll_write(cx, &block) {
                    Poll::Ready(Ok(n)) => {
                        assert!(n <= STEP && n < block.len());
                        sent += n;
                        assert!(sent <= 4 * 1024 * 1024);
                        cx.waker().wake_by_ref();
                        Poll::Pending
                    }
                    Poll::Pending => {
                        if let Some(tx) = signal.take() {
                            let _ = tx.send(());
                        }
                        Poll::Pending
                    }
                    Poll::Ready(Err(e)) => Poll::Ready(e),
                }
            })
            .await
        };
        let (error, ()) = both(write, async {
            rx.await.unwrap();
            cancel.cancel();
        })
        .await;
        assert_eq!(error, Fault::Cancelled);
        assert!(sent > 0);
        assert!(raw.socket.is_none());
        assert_eq!(raw.timer.registrations(), 0);
        let mut drained = 0;
        let mut b = [0; STEP];
        loop {
            let n = peer.read(&mut b).await.unwrap();
            if n == 0 {
                break;
            }
            drained += n;
        }
        assert_eq!(drained, sent);
        let (mut raw, peer, _, _) = fixture().await;
        #[allow(deprecated)]
        peer.set_linger(Some(Duration::ZERO)).unwrap();
        drop(peer);
        assert_eq!(raw.read(&mut [0; 1]).await, Err(Fault::Reset));
        assert!(raw.socket.is_none());
    });
}
#[cfg_attr(test, test)]
fn n7d_actual_real_handshake_idle_and_total_deadlines() {
    execute(async {
        let (mut raw, mut peer, _, _) = fixture().await;
        let start = raw.timer.epoch;
        assert_eq!(raw.read(&mut [0; 1]).await, Err(Fault::Expired));
        assert!(start.elapsed() >= Duration::from_secs(10));
        assert_eq!(peer.read(&mut [0; 1]).await.unwrap(), 0);
        assert_eq!(raw.timer.registrations(), 0);
        let (mut raw, mut peer, _, _) = fixture().await;
        raw.begin_lab_session().unwrap();
        let start = raw.timer.epoch;
        let (result, ()) = both(raw.lab_frame(), async {
            peer.write_all(b"N").await.unwrap();
            tokio::time::sleep_until(start + Duration::from_secs(5)).await;
            peer.write_all(b"L").await.unwrap();
            let mut b = [0; 1];
            assert_eq!(peer.read(&mut b).await.unwrap(), 0);
        })
        .await;
        assert_eq!(result, Err(Fault::Expired));
        assert!(start.elapsed() >= Duration::from_secs(15));
        assert_eq!(raw.timer.registrations(), 0);
        let (mut raw, mut peer, _, _) = fixture().await;
        raw.begin_lab_session().unwrap();
        let start = raw.timer.epoch;
        let (result, ()) = both(
            async {
                loop {
                    raw.lab_frame().await?;
                }
                #[allow(unreachable_code)]
                Ok::<(), Fault>(())
            },
            async {
                for i in 0..12 {
                    tokio::time::sleep_until(start + Duration::from_secs(i * 5)).await;
                    peer.write_all(b"NLAB\0\0\0\x01x").await.unwrap();
                }
                assert_eq!(peer.read(&mut [0; 1]).await.unwrap(), 0);
            },
        )
        .await;
        assert_eq!(result, Err(Fault::Expired));
        assert!(start.elapsed() >= Duration::from_secs(60));
        assert_eq!(raw.timer.registrations(), 0);
    });
}
pub(crate) fn qualify_fast() -> super::Result<()> {
    std::panic::catch_unwind(|| {
        n7d_actual_fragmentation_bounds_and_half_close();
        n7d_actual_truncation_oversize_zero_and_plain_sync_refusal();
        n7d_actual_endpoint_evidence_is_loopback_only_and_expires();
        n7d_actual_cancel_pending_read_and_shutdown_close_socket();
        n7d_actual_backpressure_partial_write_cancel_and_reset();
        n7d_actual_shared_admission_limits_never_refund();
        n7d_actual_drop_removes_handle_timer_and_wakers();
    })
    .map_err(|_| E::State)
}
#[cfg_attr(test, test)]
fn n7d_actual_shared_admission_limits_never_refund() {
    execute(async {
        let pool = Arc::new(Pool::default());
        let epoch = std::time::Instant::now();
        let p1 = pool.admit(expected(), 0).unwrap();
        let p2 = pool.admit(expected(), 0).unwrap();
        let (mut a, mut pa, _) = pair(p1, NativeTimer::from_origin(epoch)).await.unwrap();
        let (mut b, mut pb, _) = pair(p2, NativeTimer::from_origin(epoch)).await.unwrap();
        assert!(matches!(pool.admit(expected(), 0), Err(E::Limit)));
        a.begin_lab_session().unwrap();
        assert!(b.begin_lab_session().is_err());
        assert_eq!(pb.read(&mut [0; 1]).await.unwrap(), 0);
        a.abort();
        assert_eq!(pa.read(&mut [0; 1]).await.unwrap(), 0);
        for _ in 0..2 {
            let p = pool.admit(expected(), 0).unwrap();
            let (raw, mut peer, _) = pair(p, NativeTimer::from_origin(epoch)).await.unwrap();
            drop(raw);
            assert_eq!(peer.read(&mut [0; 1]).await.unwrap(), 0);
        }
        assert!(matches!(pool.admit(expected(), 0), Err(E::Limit)));
    });
}
#[cfg_attr(test, test)]
fn n7d_actual_drop_removes_handle_timer_and_wakers() {
    use std::task::{Wake, Waker};
    struct Reenter(Arc<super::transport_candidate::Interrupt>);
    impl Wake for Reenter {
        fn wake(self: Arc<Self>) {}
    }
    impl Drop for Reenter {
        fn drop(&mut self) {
            self.0.cancel();
        }
    }
    execute(async {
        let (mut raw, mut peer, _, _) = fixture().await;
        let active = raw.timer.active.clone();
        let stop = raw.permit.as_ref().unwrap().cancellation();
        let first = Arc::new(Reenter(stop.clone()));
        let weak = Arc::downgrade(&first);
        let waker = Waker::from(first);
        assert!(raw
            .poll_read(&mut Context::from_waker(&waker), &mut [0; 1])
            .is_pending());
        assert_eq!(active.load(Ordering::Acquire), 1);
        drop(waker);
        // Replacement drops the previous registration/waker; its destructor
        // reenters cancellation. A following poll must observe cancellation.
        let next = Waker::from(Arc::new(Reenter(stop.clone())));
        let mut cx = Context::from_waker(&next);
        let _ = raw.poll_read(&mut cx, &mut [0; 1]);
        assert_eq!(
            raw.poll_read(&mut cx, &mut [0; 1]),
            Poll::Ready(Err(Fault::Closed))
        );
        drop(next);
        drop(raw);
        assert!(weak.upgrade().is_none());
        assert_eq!(active.load(Ordering::Acquire), 0);
        assert_eq!(peer.read(&mut [0; 1]).await.unwrap(), 0);

        let (mut raw, mut peer, _, _) = fixture().await;
        let active = raw.timer.active.clone();
        let w = Waker::noop();
        assert!(raw
            .poll_read(&mut Context::from_waker(w), &mut [0; 1])
            .is_pending());
        #[cfg(windows)]
        let handle = {
            use std::os::windows::io::AsRawSocket;
            raw.socket.as_ref().unwrap().as_raw_socket()
        };
        #[cfg(target_os = "android")]
        let handle = {
            use std::os::fd::AsRawFd;
            raw.socket.as_ref().unwrap().as_raw_fd()
        };
        drop(raw);
        // Probe immediately, before creating any replacement socket/fd.
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::Networking::WinSock::*;
            let mut value = 0i32;
            let mut len = std::mem::size_of_val(&value) as i32;
            assert_eq!(
                getsockopt(
                    handle as usize,
                    SOL_SOCKET,
                    SO_TYPE,
                    (&mut value as *mut i32).cast(),
                    &mut len
                ),
                SOCKET_ERROR
            );
            assert_eq!(WSAGetLastError(), WSAENOTSOCK);
        }
        #[cfg(target_os = "android")]
        unsafe {
            assert_eq!(libc::fcntl(handle, libc::F_GETFD), -1);
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::EBADF));
        }
        assert_eq!(active.load(Ordering::Acquire), 0);
        assert_eq!(peer.read(&mut [0; 1]).await.unwrap(), 0);
    });
}
pub(crate) fn qualify_deadlines() -> super::Result<()> {
    std::panic::catch_unwind(n7d_actual_real_handshake_idle_and_total_deadlines)
        .map_err(|_| E::State)
}

#[cfg(all(test, windows))]
#[test]
fn r2_cancelled_connect_cannot_return_socket_or_retain_permit() {
    execute(async {
        let root = tempfile::tempdir().unwrap();
        let owner = crate::runtime::NativeRuntime::acquire(root.path()).unwrap();
        let stop = Arc::new(super::transport_candidate::Interrupt::default());
        let (pool, permit, timer) = owner
            .transport_candidate()
            .admit_loopback_lab(expected(), &stop)
            .unwrap();
        stop.cancel();
        assert!(matches!(pair(permit, timer).await, Err(Fault::Cancelled)));
        assert_eq!(pool.active_for_test(), 0);
    });
}

#[cfg(all(target_os = "android", feature = "android-identity-tests"))]
pub(crate) fn qualify_selected_network(owner: &crate::runtime::NativeRuntime) -> super::Result<()> {
    use super::route_candidate::*;
    use std::os::fd::AsRawFd;
    let c = owner.transport_candidate();
    c.start_monitor().map_err(|_| E::PlatformUnverified)?;
    execute(async {
        let until = Instant::now() + Duration::from_secs(15);
        while c.native_qualification_fence().is_err() {
            assert!(Instant::now() < until, "initial native callbacks missing");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let stop = Arc::new(super::transport_candidate::Interrupt::default());
        let (pool, permit, timer) = c.admit_native_qualification(expected(), &stop).unwrap();
        let fence = permit.native_fence().unwrap();
        let o = native_snapshot("192.168.1.3:7431".parse().unwrap(), &fence, &timer).unwrap();
        assert!(
            !o.source_selected,
            "CM address alone is not socket selection"
        );
        assert!(
            matches!(o.local,std::net::IpAddr::V4(ip) if ip.is_private()),
            "self-interface probe requires a private IPv4 source before listen"
        );
        let listener = tokio::net::TcpListener::bind(SocketAddr::new(o.local, 0))
            .await
            .unwrap();
        let target = listener.local_addr().unwrap();
        let socket = TcpSocket::new_v4().unwrap();
        assert!(android_bind(o.network, -1).is_err(), "invalid FD must fail");
        bind_selected(&socket, &o, 0).unwrap();
        let fd = socket.as_raw_fd();
        assert!(fd >= 0);
        let (client, peer) = admitted(
            async {
                let (client, peer) = both(socket.connect(target), listener.accept()).await;
                Ok((client.map_err(io_error)?, peer.map_err(io_error)?.0))
            },
            &permit,
            &timer,
        )
        .await
        .unwrap();
        drop(listener);
        assert_eq!(
            client.as_raw_fd(),
            fd,
            "connect must retain the OS-bound descriptor"
        );
        assert_eq!(client.local_addr().unwrap().ip(), o.local);
        assert_eq!(client.peer_addr().unwrap(), target);
        assert_eq!(peer.peer_addr().unwrap(), client.local_addr().unwrap());
        let fresh = native_snapshot(o.endpoint, &fence, &timer).unwrap();
        assert_eq!(fresh.network, o.network);
        assert_eq!(fresh.interface, o.interface);
        assert_eq!(fresh.local, o.local);
        let mut self_facts = fresh.clone();
        self_facts.endpoint = target;
        self_facts.source_selected = true;
        assert!(
            Candidate::evaluate_qualification(
                &Hint::parse(&target.to_string(), Origin::Manual).unwrap(),
                &self_facts,
                timer.now()
            )
            .is_err(),
            "self-interface probe is NOT peer LAN eligibility"
        );
        println!("R4 NDK actual FD {fd}, Network {}, interface {}, {:?}, local {}, remote {}; self-interface only, no TLS/Sync claim",o.network,o.interface,o.platform,client.local_addr().unwrap(),target);
        c.stop_monitor().unwrap();
        assert!(!fence.valid());
        assert!(permit.native_fence().is_err());
        assert_eq!(timer.registrations(), 0);
        drop(client);
        drop(peer);
        drop(permit);
        assert_eq!(pool.active_for_test(), 0);
    });
    c.stop_monitor()?;
    Ok(())
}

#[cfg(all(test, windows))]
#[test]
fn r4_native_windows_interface_option_roundtrip_and_endpoints() {
    execute(async {
        use std::os::windows::io::AsRawSocket;
        use windows_sys::Win32::{
            NetworkManagement::IpHelper::GetBestInterfaceEx, Networking::WinSock::*,
        };
        let mut addr = SOCKADDR_IN::default();
        addr.sin_family = AF_INET;
        addr.sin_addr.S_un.S_addr = u32::from_ne_bytes([127, 0, 0, 1]);
        let mut index = 0;
        assert_eq!(
            unsafe { GetBestInterfaceEx((&addr as *const SOCKADDR_IN).cast(), &mut index) },
            0
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let socket = TcpSocket::new_v4().unwrap();
        windows_interface(socket.as_raw_socket(), true, index, true).unwrap();
        socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let (client, peer) = both(
            socket.connect(listener.local_addr().unwrap()),
            listener.accept(),
        )
        .await;
        let client = client.unwrap();
        let peer = peer.unwrap().0;
        windows_interface(client.as_raw_socket(), true, index, false).unwrap();
        assert!(windows_interface(client.as_raw_socket(), true, index + 1, false).is_err());
        assert_eq!(client.local_addr().unwrap(), peer.peer_addr().unwrap());
        assert_eq!(client.peer_addr().unwrap(), peer.local_addr().unwrap());
        // Mechanism-only loopback evidence cannot open the native LAN path.
        assert!(native_snapshot(
            client.peer_addr().unwrap(),
            &super::network_watch::Signal::channel().0.fence().unwrap(),
            &NativeTimer::new()
        )
        .is_err());
    });
}

#[test]
fn r4_n7_before_pending_connect_and_stale_socket_completion_cancel() {
    use super::network_watch::{Signal, INTERFACE, LOST, ROUTE};
    use super::transport_candidate::Interrupt;
    execute(async {
        for kind in [LOST, INTERFACE, ROUTE] {
            for stage in 0..3 {
                let pool = Arc::new(Pool::default());
                let timer = NativeTimer::new();
                let (signal, _events) = Signal::channel();
                let stop = Arc::new(Interrupt::default());
                let permit = pool
                    .admit_observed(expected(), 0, &stop, Some(signal.fence().unwrap()))
                    .unwrap();
                let polled = std::cell::Cell::new(false);
                if stage == 0 {
                    signal.notify(kind);
                    let result = admitted(
                        async {
                            polled.set(true);
                            Ok(())
                        },
                        &permit,
                        &timer,
                    )
                    .await;
                    assert_eq!(result, Err(Fault::Cancelled));
                    assert!(!polled.get());
                } else if stage == 1 {
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    let mut tx = Some(tx);
                    let held = Arc::new(());
                    let weak = Arc::downgrade(&held);
                    let pending = async move {
                        let _held = held;
                        poll_fn(|_| {
                            if let Some(tx) = tx.take() {
                                let _ = tx.send(());
                            }
                            Poll::<R<()>>::Pending
                        })
                        .await
                    };
                    let (result, ()) = both(admitted(pending, &permit, &timer), async {
                        rx.await.unwrap();
                        signal.notify(kind);
                        stop.cancel();
                    })
                    .await;
                    assert_eq!(result, Err(Fault::Cancelled));
                    assert!(weak.upgrade().is_none());
                } else {
                    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                    let peer = std::cell::RefCell::new(None);
                    let result = admitted(
                        async {
                            let (client, accepted) = both(
                                TcpStream::connect(listener.local_addr().unwrap()),
                                listener.accept(),
                            )
                            .await;
                            peer.replace(Some(accepted.unwrap().0));
                            signal.notify(kind);
                            stop.cancel();
                            Ok(client.unwrap()) // Actual connected socket completes after invalidation.
                        },
                        &permit,
                        &timer,
                    )
                    .await;
                    assert!(matches!(result, Err(Fault::Cancelled)));
                    assert_eq!(
                        peer.borrow_mut()
                            .as_mut()
                            .unwrap()
                            .read(&mut [0; 1])
                            .await
                            .unwrap(),
                        0
                    );
                }
                assert_eq!(timer.registrations(), 0);
                assert!(permit.native_fence().is_err());
                drop(permit);
                assert_eq!(pool.active_for_test(), 0);
            }
        }
    });
}
