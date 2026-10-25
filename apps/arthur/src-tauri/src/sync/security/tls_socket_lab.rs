//! Test-only pinned TLS13 -> N7D RawIo -> existing Sync transport. No enrollment.
#[cfg(not(any(
    test,
    all(
        target_os = "android",
        feature = "android-identity-tests",
        debug_assertions
    )
)))]
compile_error!("TLS socket qualification is forbidden outside tests/debug instrumentation");
use super::{
    identity::PublicIdentity,
    native_io_lab::{self, Fault, NativeTimer, RawIo},
    tls_lab,
    transport::MAX_RECORD,
    transport_candidate::{Expected, Pool},
};
use crate::{storage::tls_identity::OwnedTlsKey, sync::*};
use rustls::Connection;
use serde::{Deserialize, Serialize};
use std::task::Poll;
use std::{
    cell::RefCell,
    collections::VecDeque,
    future::poll_fn,
    io::{Read, Write},
    rc::Rc,
    sync::Arc,
    task::Context,
};

const QUEUE: usize = 8;
type Shared = Rc<RefCell<Socket>>;
struct Bounded(Vec<u8>, bool);
impl Write for Bounded {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_FRAME - self.0.len() {
            self.1 = true;
            return Err(std::io::Error::other("lab record limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    hello: PeerHello,
    exporter: [u8; 32],
}
struct Socket {
    raw: RawIo,
    tls: Connection,
    output: VecDeque<Vec<u8>>,
    input: VecDeque<Vec<u8>>,
    ciphertext: Vec<u8>,
    written: usize,
    plain: Vec<u8>,
    assembling: Vec<u8>,
    bound: bool,
    enqueued: usize,
    received: usize,
    failed: Option<Error>,
    corrupt: bool,
    wire_bytes: usize,
}
fn fault(e: Fault) -> Error {
    match e {
        Fault::Cancelled => Error::Cancelled,
        Fault::Expired => Error::Trust,
        Fault::Limit => Error::Limit,
        _ => Error::Disconnected,
    }
}
impl Socket {
    fn new(raw: RawIo, mut tls: Connection) -> Self {
        // One maximum AE01 record plus bounded TLS record overhead.
        tls.set_buffer_limit(Some(MAX_RECORD + 8192));
        Self {
            raw,
            tls,
            output: VecDeque::new(),
            input: VecDeque::new(),
            ciphertext: Vec::new(),
            written: 0,
            plain: Vec::new(),
            assembling: Vec::new(),
            bound: false,
            enqueued: 0,
            received: 0,
            failed: None,
            corrupt: false,
            wire_bytes: 0,
        }
    }
    fn abort(&mut self, e: Error) {
        self.failed = Some(e);
        self.raw.abort();
        self.output.clear();
        self.input.clear();
        self.plain.clear();
        self.assembling.clear();
        self.ciphertext.clear();
    }
    fn queue(&mut self, bytes: Vec<u8>) -> Result<()> {
        if let Some(e) = self.failed {
            return Err(e);
        }
        if bytes.is_empty()
            || bytes.len() > MAX_FRAME
            || self.output.len() >= QUEUE
            || self.output.iter().map(Vec::capacity).sum::<usize>() + bytes.capacity() > MAX_FRAME
        {
            self.abort(Error::Limit);
            return Err(Error::Limit);
        }
        self.output.push_back(bytes);
        self.enqueued += 1;
        Ok(())
    }
    fn poll(&mut self, cx: &mut Context<'_>) -> Result<()> {
        if let Some(e) = self.failed {
            return Err(e);
        }
        // At most one bounded write/read per poll. RawIo owns deadlines/cancellation.
        if self.ciphertext.is_empty() {
            if !self.tls.is_handshaking() && !self.tls.wants_write() {
                if let Some(bytes) = self.output.front_mut() {
                    let n = bytes.len().min(MAX_RECORD);
                    let mut frame = Vec::with_capacity(n + 8);
                    frame.extend_from_slice(b"AE01");
                    frame.extend_from_slice(&(n as u32).to_be_bytes());
                    frame.extend_from_slice(&bytes[..n]);
                    bytes.drain(..n);
                    if bytes.is_empty() {
                        self.output.pop_front();
                    }
                    self.tls
                        .writer()
                        .write_all(&frame)
                        .map_err(|_| Error::Limit)?;
                }
            }
            if self.tls.wants_write() {
                self.tls
                    .write_tls(&mut self.ciphertext)
                    .map_err(|_| Error::Disconnected)?;
                if self.ciphertext.len() > MAX_RECORD + 8192 {
                    return Err(Error::Limit);
                }
                if self.corrupt && !self.ciphertext.is_empty() {
                    let end = self.ciphertext.len() - 1;
                    self.ciphertext[end] ^= 1;
                    self.corrupt = false;
                }
            }
        }
        if !self.ciphertext.is_empty() {
            match self.raw.poll_write(cx, &self.ciphertext[self.written..]) {
                Poll::Ready(Ok(n)) => {
                    self.written += n;
                    self.wire_bytes += n;
                    if self.written == self.ciphertext.len() {
                        self.ciphertext.clear();
                        self.written = 0;
                    }
                    cx.waker().wake_by_ref();
                }
                Poll::Ready(Err(e)) => return Err(fault(e)),
                Poll::Pending => {}
            }
        }
        let mut encrypted = [0; 4096];
        match self.raw.poll_read(cx, &mut encrypted) {
            Poll::Ready(Ok(0)) => return Err(Error::Disconnected),
            Poll::Ready(Ok(n)) => {
                let mut remaining = &encrypted[..n];
                // read_tls can consume LESS than the OS read, especially at a
                // TLS record boundary. Never discard the unconsumed suffix.
                while !remaining.is_empty() {
                    self.tls
                        .read_tls(&mut remaining)
                        .map_err(|_| Error::Integrity)
                        .and_then(|n| if n == 0 { Err(Error::Integrity) } else { Ok(n) })?;
                    self.tls
                        .process_new_packets()
                        .map_err(|_| Error::Integrity)?;
                    loop {
                        let mut bytes = [0; 4096];
                        match self.tls.reader().read(&mut bytes) {
                            Ok(0) => return Err(Error::Disconnected),
                            Ok(n) => {
                                self.plain.extend_from_slice(&bytes[..n]);
                                if self.plain.len() > MAX_RECORD + 8 + 4096 {
                                    return Err(Error::Limit);
                                }
                                self.parse_records()?;
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                            Err(_) => return Err(Error::Integrity),
                        }
                    }
                }
                cx.waker().wake_by_ref();
            }
            Poll::Ready(Err(e)) => return Err(fault(e)),
            Poll::Pending => {}
        }
        Ok(())
    }
    fn parse_records(&mut self) -> Result<()> {
        while self.plain.len() >= 8 {
            if &self.plain[..4] != b"AE01" {
                return Err(Error::Protocol);
            }
            let n = u32::from_be_bytes(self.plain[4..8].try_into().unwrap()) as usize;
            if n == 0 || n > MAX_RECORD {
                return Err(Error::Limit);
            }
            if self.plain.len() < 8 + n {
                break;
            }
            if self.input.len() == QUEUE
                || self.input.iter().map(Vec::capacity).sum::<usize>() + self.assembling.len() + n
                    > MAX_FRAME
            {
                return Err(Error::Limit);
            }
            self.assembling
                .try_reserve_exact(n)
                .map_err(|_| Error::Limit)?;
            self.assembling.extend_from_slice(&self.plain[8..8 + n]);
            self.plain.drain(..8 + n);
            // AE01 records retain their existing 64 KiB ceiling. A bounded
            // native message can span several records without a new header or
            // protocol: JSON's existing complete-value boundary delimits it.
            let complete = if !self.bound {
                true
            } else {
                match serde_json::from_slice::<Message>(&self.assembling) {
                    Ok(_) => true,
                    Err(e) if e.is_eof() => false,
                    Err(_) => return Err(Error::Protocol),
                }
            };
            if complete {
                self.input.push_back(std::mem::take(&mut self.assembling));
                self.received += 1;
            }
            // Preserve the existing per-record idle budget. Partial AE01
            // records do not refresh it; the total session still caps at 60s.
            self.raw.tls_record_complete();
        }
        Ok(())
    }
}

pub(crate) struct TlsTransport {
    socket: Shared,
    hello: PeerHello,
    // Test fault: acknowledgement is lost AFTER encryption and TLS delivery.
    pub(crate) lose_receipts: bool,
}
impl AuthenticatedTransport for TlsTransport {
    fn hello(&self) -> PeerHello {
        self.hello.clone()
    }
    fn send(&mut self, message: Message) -> Result<()> {
        if message.network != self.hello.network
            || message.session != self.hello.session
            || message.from != self.hello.local
            || message.to != self.hello.peer
        {
            return Err(Error::Trust);
        }
        let oversized = match &message.payload {
            Payload::Hello { profile, .. } => profile.len() > 64,
            Payload::Chunk(c) => c.bytes.len() > CHUNK,
            Payload::Summary(s) => s.known.len() > SUMMARY_PAGE || s.progress.len() > MAX_EVENTS,
            Payload::Request(ids) => ids.len() > 32,
            _ => false,
        };
        if oversized {
            self.socket.borrow_mut().abort(Error::Limit);
            return Err(Error::Limit);
        }
        let mut bytes = Bounded(Vec::with_capacity(MAX_RECORD), false);
        if serde_json::to_writer(&mut bytes, &message).is_err() {
            let error = if bytes.1 {
                Error::Limit
            } else {
                Error::Protocol
            };
            self.socket.borrow_mut().abort(error);
            return Err(error);
        }
        bytes.0.shrink_to_fit();
        self.socket.borrow_mut().queue(bytes.0)
    }
    fn receive(&mut self) -> Result<Option<Message>> {
        let mut socket = self.socket.borrow_mut();
        if let Some(e) = socket.failed {
            return Err(e);
        }
        while let Some(bytes) = socket.input.pop_front() {
            let message: Message = match serde_json::from_slice(&bytes) {
                Ok(m) => m,
                Err(_) => {
                    socket.abort(Error::Protocol);
                    return Err(Error::Protocol);
                }
            };
            if message.network != self.hello.network
                || message.session != self.hello.session
                || message.from != self.hello.peer
                || message.to != self.hello.local
            {
                socket.abort(Error::Trust);
                return Err(Error::Trust);
            }
            if self.lose_receipts && matches!(message.payload, Payload::Receipt(_)) {
                continue;
            }
            return Ok(Some(message));
        }
        Ok(None)
    }
}

/// Test driver, not a new runtime/service. Every queued message crosses TLS/OS I/O.
pub(crate) struct Pair {
    sockets: [Shared; 2], // server, client
    pub(crate) pools: [Arc<Pool>; 2],
    stall: bool,
}
#[derive(Clone, Copy)]
pub(crate) enum HandshakeFault {
    Invalid,
    Interrupted,
    Stalled,
    AfterTlsCancelled,
    ExporterMismatch,
}
impl Pair {
    pub(crate) async fn connect(
        server: Arc<OwnedTlsKey>,
        client: Arc<OwnedTlsKey>,
        hellos: [PeerHello; 2],
        pins: [&PublicIdentity; 2],
    ) -> Result<(Self, TlsTransport, TlsTransport)> {
        Self::connect_fault(server, client, hellos, pins, None).await
    }
    pub(crate) async fn connect_fault(
        server: Arc<OwnedTlsKey>,
        client: Arc<OwnedTlsKey>,
        hellos: [PeerHello; 2],
        pins: [&PublicIdentity; 2],
        injection: Option<HandshakeFault>,
    ) -> Result<(Self, TlsTransport, TlsTransport)> {
        Self::connect_checked(server, client, hellos, pins, injection, || Ok(())).await
    }
    /// Debug loopback capability only. Durable membership is checked by the
    /// existing store before publication, then again by SyncEngine/each store IO.
    /// This does not satisfy native LAN route policy or mint production trust.
    pub(crate) async fn connect_checked(
        server: Arc<OwnedTlsKey>,
        client: Arc<OwnedTlsKey>,
        hellos: [PeerHello; 2],
        pins: [&PublicIdentity; 2],
        injection: Option<HandshakeFault>,
        authorize: impl FnOnce() -> Result<()>,
    ) -> Result<(Self, TlsTransport, TlsTransport)> {
        if hellos[0].local != server.identity().peer_id()
            || hellos[1].local != client.identity().peer_id()
            || hellos[0].peer != pins[1].peer_id()
            || hellos[1].peer != pins[0].peer_id()
        {
            return Err(Error::Trust);
        }
        let owners = [server.owner().clone(), client.owner().clone()];
        let (c, s) =
            tls_lab::connections(server, client, pins[0], pins[1]).map_err(|_| Error::Trust)?;
        let stall = matches!(injection, Some(HandshakeFault::Stalled));
        let stops = [Arc::default(), Arc::default()];
        let (spool, sp, st) = owners[0]
            .transport_candidate()
            .admit_loopback_lab(
                Expected {
                    network: hellos[0].network,
                    peer: hellos[0].peer,
                },
                &stops[0],
            )
            .map_err(|_| Error::Trust)?;
        let (cpool, cp, ct) = owners[1]
            .transport_candidate()
            .admit_loopback_lab(
                Expected {
                    network: hellos[1].network,
                    peer: hellos[1].peer,
                },
                &stops[1],
            )
            .map_err(|_| Error::Trust)?;
        let pools = [spool, cpool];
        // Existing timeout fixture ages only its I/O timer, never owner accounting.
        let (st, ct) = if stall {
            let epoch = std::time::Instant::now() - std::time::Duration::from_secs(9);
            (
                NativeTimer::from_origin(epoch),
                NativeTimer::from_origin(epoch),
            )
        } else {
            (st, ct)
        };
        let (client_io, server_io, _) = native_io_lab::pair(cp, ct).await.map_err(fault)?;
        let server_io = RawIo::tls_socket(server_io, sp, st).map_err(fault)?;
        let se = server_io.tls_endpoints().map_err(|_| Error::Trust)?;
        let ce = client_io.tls_endpoints().map_err(|_| Error::Trust)?;
        let (sl, sr) = se.addresses();
        let (cl, cr) = ce.addresses();
        se.matches(cl, sl.ip()).map_err(|_| Error::Trust)?;
        ce.matches(sl, cl.ip()).map_err(|_| Error::Trust)?;
        if sr != cl || cr != sl {
            return Err(Error::Trust);
        }
        let pair = Self {
            sockets: [
                Rc::new(RefCell::new(Socket::new(server_io, s.into()))),
                Rc::new(RefCell::new(Socket::new(client_io, c.into()))),
            ],
            pools,
            stall,
        };
        if matches!(injection, Some(HandshakeFault::Invalid)) {
            pair.corrupt_next_ciphertext(1);
        }
        if matches!(injection, Some(HandshakeFault::Interrupted)) {
            stops[1].cancel();
        }
        pair.drive_until(|| {
            pair.sockets.iter().all(|s| {
                let s = s.borrow();
                !s.tls.is_handshaking() && !s.tls.wants_write() && s.ciphertext.is_empty()
            })
        })
        .await
        .map_err(|e| {
            if e == Error::Integrity {
                Error::Trust
            } else {
                e
            }
        })?;
        if matches!(injection, Some(HandshakeFault::AfterTlsCancelled)) {
            stops[0].cancel();
        }
        let mut exporters = Vec::new();
        for socket in &pair.sockets {
            let mut s = socket.borrow_mut();
            if s.tls.protocol_version() != Some(rustls::ProtocolVersion::TLSv1_3)
                || s.tls.alpn_protocol() != Some(b"arthur-e3a-lab-v1".as_slice())
            {
                return Err(Error::Trust);
            }
            let exporter = s
                .tls
                .export_keying_material([0; 32], b"EXPORTER-Channel-Binding", Some(&[]))
                .map_err(|_| Error::Trust)?;
            if exporter == [0; 32] {
                return Err(Error::Trust);
            }
            exporters.push(exporter);
        }
        for i in 0..2 {
            #[cfg(test)]
            pair.sockets[i].borrow().raw.assert_handshake_accounting();
            let mut exporter = exporters[i];
            if i == 1 && matches!(injection, Some(HandshakeFault::ExporterMismatch)) {
                exporter[0] ^= 1;
            }
            let binding = serde_json::to_vec(&Binding {
                hello: hellos[i].clone(),
                exporter,
            })
            .map_err(|_| Error::Protocol)?;
            pair.sockets[i].borrow_mut().queue(binding)?;
        }
        pair.transfer().await?;
        for i in 0..2 {
            let bytes = pair.sockets[i]
                .borrow_mut()
                .input
                .pop_front()
                .ok_or(Error::Trust)?;
            let received: Binding = serde_json::from_slice(&bytes).map_err(|_| Error::Trust)?;
            let expected = &hellos[i];
            if received.exporter != exporters[i]
                || received.hello.network != expected.network
                || received.hello.session != expected.session
                || received.hello.local != expected.peer
                || received.hello.peer != expected.local
                || received.hello.epoch != expected.epoch
            {
                return Err(Error::Trust);
            }
        }
        authorize()?;
        // Resource accounting, NOT membership authorization. Both peers must
        // finish exporter/context checks before either permit is established.
        for socket in &pair.sockets {
            let mut socket = socket.borrow_mut();
            socket.raw.tls_established().map_err(fault)?;
            socket.bound = true;
        }
        let a = TlsTransport {
            socket: pair.sockets[0].clone(),
            hello: hellos[0].clone(),
            lose_receipts: false,
        };
        let b = TlsTransport {
            socket: pair.sockets[1].clone(),
            hello: hellos[1].clone(),
            lose_receipts: false,
        };
        Ok((pair, a, b))
    }
    async fn drive_until(&self, done: impl Fn() -> bool) -> Result<()> {
        poll_fn(|cx| {
            for (i, socket) in self.sockets.iter().enumerate() {
                if self.stall && i == 1 {
                    continue;
                }
                let result = socket.borrow_mut().poll(cx);
                if let Err(e) = result {
                    self.abort(e);
                    return Poll::Ready(Err(e));
                }
            }
            if done() {
                Poll::Ready(Ok(()))
            } else {
                Poll::Pending
            }
        })
        .await
    }
    pub(crate) async fn transfer(&self) -> Result<()> {
        let targets = [
            self.sockets[1].borrow().enqueued,
            self.sockets[0].borrow().enqueued,
        ];
        self.drive_until(|| (0..2).all(|i| self.sockets[i].borrow().received >= targets[i]))
            .await
    }
    pub(crate) async fn wait_for_failure(&self) -> Result<()> {
        self.drive_until(|| false).await
    }
    pub(crate) fn abort(&self, error: Error) {
        for socket in &self.sockets {
            socket.borrow_mut().abort(error);
        }
    }
    pub(crate) fn corrupt_next_ciphertext(&self, side: usize) {
        self.sockets[side].borrow_mut().corrupt = true;
    }
    pub(crate) fn wire_bytes(&self) -> usize {
        self.sockets.iter().map(|s| s.borrow().wire_bytes).sum()
    }
    pub(crate) fn assert_closed(&self) {
        assert!(self.sockets.iter().all(|s| s.borrow().raw.tls_closed()));
        assert!(self.pools.iter().all(|p| p.active_for_test() == 0));
    }
    pub(crate) fn expire_fixture(&self, total: bool) {
        for s in &self.sockets {
            s.borrow_mut().raw.tls_deadline_fixture(total);
        }
    }
    pub(crate) async fn peer_eof_fixture(&self, reset: bool, partial: bool) -> Error {
        if partial {
            self.sockets[1]
                .borrow_mut()
                .tls
                .writer()
                .write_all(b"AE01\0\0\0\x64x")
                .unwrap();
            self.drive_until(|| !self.sockets[0].borrow().plain.is_empty())
                .await
                .unwrap();
        }
        if reset {
            self.sockets[1].borrow_mut().raw.tls_reset_fixture();
        } else {
            self.sockets[1].borrow_mut().raw.abort();
        }
        let error = poll_fn(|cx| match self.sockets[0].borrow_mut().poll(cx) {
            Err(e) => Poll::Ready(e),
            Ok(()) => Poll::Pending,
        })
        .await;
        self.abort(error);
        error
    }
}
impl Drop for Pair {
    fn drop(&mut self) {
        self.abort(Error::Disconnected);
    }
}

/// Single-process driver of the SAME Socket/TlsTransport for a remote endpoint.
/// No listener, registry or runtime; only the existing bounded IO state.
pub(crate) struct Endpoint {
    socket: Shared,
}
impl Endpoint {
    pub(crate) fn endpoints(&self) -> Result<(std::net::SocketAddr, std::net::SocketAddr)> {
        let evidence = self
            .socket
            .borrow()
            .raw
            .tls_endpoints()
            .map_err(|_| Error::Trust)?;
        assert!(evidence.require_native_lan().is_err());
        Ok(evidence.addresses())
    }

    pub(crate) async fn authenticate(
        raw: RawIo,
        key: Arc<OwnedTlsKey>,
        pin: &PublicIdentity,
        role: super::tls::CertificateRole,
        hello: PeerHello,
        authorize: impl FnOnce() -> Result<()>,
    ) -> Result<(Self, TlsTransport)> {
        if hello.local != key.identity().peer_id() || hello.peer != pin.peer_id() {
            return Err(Error::Trust);
        }
        let tls = match role {
            super::tls::CertificateRole::Server => tls_lab::server(key, pin).map(Connection::from),
            super::tls::CertificateRole::Client => tls_lab::client(key, pin).map(Connection::from),
        }
        .map_err(|_| Error::Trust)?;
        let driver = Self {
            socket: Rc::new(RefCell::new(Socket::new(raw, tls))),
        };
        driver
            .until(|| {
                let s = driver.socket.borrow();
                !s.tls.is_handshaking() && !s.tls.wants_write() && s.ciphertext.is_empty()
            })
            .await?;
        let exporter = {
            let s = driver.socket.borrow();
            if s.tls.protocol_version() != Some(rustls::ProtocolVersion::TLSv1_3)
                || s.tls.alpn_protocol() != Some(b"arthur-e3a-lab-v1".as_slice())
            {
                return Err(Error::Trust);
            }
            s.tls
                .export_keying_material([0; 32], b"EXPORTER-Channel-Binding", Some(&[]))
                .map_err(|_| Error::Trust)?
        };
        if exporter == [0; 32] {
            return Err(Error::Trust);
        }
        driver.socket.borrow_mut().queue(
            serde_json::to_vec(&Binding {
                hello: hello.clone(),
                exporter,
            })
            .map_err(|_| Error::Protocol)?,
        )?;
        driver
            .until(|| !driver.socket.borrow().input.is_empty())
            .await?;
        let binding: Binding = serde_json::from_slice(
            &driver
                .socket
                .borrow_mut()
                .input
                .pop_front()
                .ok_or(Error::Trust)?,
        )
        .map_err(|_| Error::Trust)?;
        if binding.exporter != exporter
            || binding.hello.network != hello.network
            || binding.hello.session != hello.session
            || binding.hello.epoch != hello.epoch
            || binding.hello.local != hello.peer
            || binding.hello.peer != hello.local
        {
            return Err(Error::Trust);
        }
        driver
            .socket
            .borrow_mut()
            .raw
            .tls_revalidate()
            .map_err(fault)?;
        authorize()?;
        {
            let mut s = driver.socket.borrow_mut();
            s.raw.tls_established().map_err(fault)?;
            s.bound = true;
        }
        let transport = TlsTransport {
            socket: driver.socket.clone(),
            hello,
            lose_receipts: false,
        };
        Ok((driver, transport))
    }
    async fn until(&self, ready: impl Fn() -> bool) -> Result<()> {
        poll_fn(|cx| {
            if let Err(e) = self.socket.borrow_mut().poll(cx) {
                return Poll::Ready(Err(e));
            }
            if ready() {
                Poll::Ready(Ok(()))
            } else {
                Poll::Pending
            }
        })
        .await
    }
    pub(crate) async fn step(&self) -> Result<()> {
        let before = {
            let s = self.socket.borrow();
            (s.wire_bytes, s.received)
        };
        self.until(|| {
            let s = self.socket.borrow();
            !s.input.is_empty() || (s.wire_bytes, s.received) != before
        })
        .await
    }
    pub(crate) async fn flush(&self) -> Result<()> {
        self.until(|| {
            let s = self.socket.borrow();
            s.output.is_empty() && s.ciphertext.is_empty() && !s.tls.wants_write()
        })
        .await
    }
}
impl Drop for Endpoint {
    fn drop(&mut self) {
        self.socket.borrow_mut().abort(Error::Disconnected);
    }
}

#[cfg(all(test, windows))]
#[test]
fn r3_single_endpoint_driver_refuses_wrong_key_pin_context_and_membership() {
    use super::tls::CertificateRole;
    use crate::storage::security_tls_tests::Fixture;
    native_io_lab::execute(async {
        for mode in 0..7 {
            let a = Fixture::new().unwrap();
            let b = Fixture::new().unwrap();
            let wrong = Fixture::new().unwrap();
            let mut ah = PeerHello {
                network: uuid::Uuid::new_v4(),
                session: uuid::Uuid::new_v4(),
                local: a.public.peer_id(),
                peer: b.public.peer_id(),
                epoch: 1,
            };
            let mut bh = PeerHello {
                local: ah.peer,
                peer: ah.local,
                ..ah.clone()
            };
            match mode {
                0 => ah.local = wrong.public.peer_id(),
                1 => ah.peer = wrong.public.peer_id(),
                2 => bh.network = uuid::Uuid::new_v4(),
                3 => bh.session = uuid::Uuid::new_v4(),
                4 => bh.epoch = 2,
                5 => bh.peer = wrong.public.peer_id(),
                _ => (),
            }
            let oa = a.owner();
            let ob = b.owner();
            let (ap, permit, timer) = oa
                .transport_candidate()
                .admit_loopback_lab(
                    Expected {
                        network: ah.network,
                        peer: ah.peer,
                    },
                    &Arc::default(),
                )
                .unwrap();
            let (bp, bpermit, btimer) = ob
                .transport_candidate()
                .admit_loopback_lab(
                    Expected {
                        network: bh.network,
                        peer: bh.peer,
                    },
                    &Arc::default(),
                )
                .unwrap();
            let (raw_b, socket, _) = native_io_lab::pair(bpermit, btimer).await.unwrap();
            let raw_a = RawIo::tls_socket(socket, permit, timer).unwrap();
            let authorized = std::cell::Cell::new(0);
            let (sa, sb) = native_io_lab::both(
                Endpoint::authenticate(
                    raw_a,
                    a.key(CertificateRole::Server).unwrap(),
                    if mode == 1 { &wrong.public } else { &b.public },
                    CertificateRole::Server,
                    ah,
                    || {
                        authorized.set(authorized.get() + 1);
                        if mode == 6 {
                            Err(Error::Trust)
                        } else {
                            Ok(())
                        }
                    },
                ),
                Endpoint::authenticate(
                    raw_b,
                    b.key(CertificateRole::Client).unwrap(),
                    &a.public,
                    CertificateRole::Client,
                    bh,
                    || {
                        authorized.set(authorized.get() + 1);
                        Ok(())
                    },
                ),
            )
            .await;
            assert!(sa.is_err());
            if mode < 6 {
                assert!(sb.is_err());
                assert_eq!(authorized.get(), 0);
            }
            drop(sa);
            drop(sb);
            assert_eq!(ap.active_for_test(), 0);
            assert_eq!(bp.active_for_test(), 0);
        }
    });
}

#[cfg(all(test, windows))]
#[test]
fn r4_single_endpoint_stale_completion_after_tls_before_publication() {
    use super::tls::CertificateRole;
    use crate::storage::security_tls_tests::Fixture;
    native_io_lab::execute(async {
        for kind in [
            super::network_watch::LOST,
            super::network_watch::INTERFACE,
            super::network_watch::ROUTE,
        ] {
            let a = Fixture::new().unwrap();
            let b = Fixture::new().unwrap();
            let oa = a.owner();
            let ob = b.owner();
            let signal = oa.transport_candidate().loopback_event_fixture().unwrap();
            let ah = PeerHello {
                network: uuid::Uuid::new_v4(),
                session: uuid::Uuid::new_v4(),
                local: a.public.peer_id(),
                peer: b.public.peer_id(),
                epoch: 1,
            };
            let bh = PeerHello {
                local: ah.peer,
                peer: ah.local,
                ..ah.clone()
            };
            let (ap, permit, timer) = oa
                .transport_candidate()
                .admit_loopback_lab(
                    Expected {
                        network: ah.network,
                        peer: ah.peer,
                    },
                    &Arc::default(),
                )
                .unwrap();
            let (bp, bpermit, btimer) = ob
                .transport_candidate()
                .admit_loopback_lab(
                    Expected {
                        network: bh.network,
                        peer: bh.peer,
                    },
                    &Arc::default(),
                )
                .unwrap();
            let (raw_b, socket, _) = native_io_lab::pair(bpermit, btimer).await.unwrap();
            let raw_a = RawIo::tls_socket(socket, permit, timer).unwrap();
            let (sa, sb) = native_io_lab::both(
                Endpoint::authenticate(
                    raw_a,
                    a.key(CertificateRole::Server).unwrap(),
                    &b.public,
                    CertificateRole::Server,
                    ah,
                    || {
                        assert!(signal.notify(kind));
                        Ok(())
                    },
                ),
                Endpoint::authenticate(
                    raw_b,
                    b.key(CertificateRole::Client).unwrap(),
                    &a.public,
                    CertificateRole::Client,
                    bh,
                    || Ok(()),
                ),
            )
            .await;
            assert!(matches!(sa, Err(Error::Cancelled)));
            drop(sa);
            drop(sb);
            assert_eq!(ap.active_for_test(), 0);
            assert_eq!(bp.active_for_test(), 0);
        }
    });
}
