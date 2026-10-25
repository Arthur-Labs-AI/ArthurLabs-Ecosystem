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
    session: bool,
    idle: u64,
}
impl RawIo {
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
            session: false,
            idle,
        })
    }
    fn evidence(&self) -> super::Result<ConnectedEndpoints> {
        ConnectedEndpoints::inspect_loopback(
            self.socket.as_ref().ok_or(E::Cancelled)?,
            self.identity.as_ref().ok_or(E::Cancelled)?,
        )
    }
    pub(crate) fn abort(&mut self) {
        self.registration.take();
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
    let client = client_socket.connect(selected).await.map_err(io_error)?;
    let (peer, _) = listener.accept().await.map_err(io_error)?;
    drop(listener);
    Ok((RawIo::new(client, permit, timer)?, peer, selected))
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
