//! Deterministic fake observations and nonblocking streams; no LAN evidence.
use super::{route_candidate::*, transport_candidate::*, SecurityError as E};
use std::{
    io::{self, Read},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Barrier, Mutex,
    },
    task::{Context, Poll, Wake, Waker},
};
use uuid::Uuid;
fn observation(endpoint: &str) -> Observation {
    Observation {
        generation: 1,
        captured: 10,
        interface: 3,
        medium: Medium::Wifi,
        link: Link::Up,
        local: "192.168.1.2".parse().unwrap(),
        local_prefix: 24,
        route_interface: 3,
        destination: "192.168.1.0".parse().unwrap(),
        route_prefix: 24,
        next_hop: NextHop::Direct,
        endpoint: endpoint.parse().unwrap(),
        platform: Platform::WindowsPrivateProfileObserved,
    }
}
#[cfg_attr(test, test)]
fn n7a_hostile_manual_and_dns_hints() {
    for input in [
        "",
        "http://192.168.1.3:80",
        "user@host:80",
        "host:80/path",
        "host:80?x",
        "host:80#x",
        "host:80\\x",
        " host:80",
        "host:0",
        "host:65536",
        "host:+80",
        "host:0080",
        "host.:80",
        "-x:80",
        "a..b:80",
        "a_b:80",
        "2130706433:80",
        "127.0.0.1:80",
        "0.0.0.0:80",
        "255.255.255.255:80",
        "224.0.0.1:80",
        "[::]:80",
        "[::1]:80",
        "[ff02::1%3]:80",
        "[::ffff:192.168.1.3]:80",
        "[fe80::1]:80",
        "[fe80::1%eth0]:80",
        "[fd00::1%3]:80",
        "fe80::1:80",
    ] {
        assert!(
            Hint::parse(input, Origin::Manual).is_err(),
            "hostile fixture accepted"
        );
    }
    assert!(Hint::parse(&"x".repeat(129), Origin::Manual).is_err());
    let dns = Hint::parse("desktop.local:7431", Origin::Manual).unwrap();
    assert!(matches!(
        Candidate::evaluate(&dns, &observation("192.168.1.3:7431"), 10),
        Err(E::N7PolicyPending)
    ));
    let manual = Hint::parse("192.168.1.3:7431", Origin::Manual).unwrap();
    let discovery = Hint::parse("192.168.1.3:7431", Origin::Discovery).unwrap();
    assert_ne!(manual, discovery);
}
#[cfg_attr(test, test)]
fn n7a_route_selection_changes_and_platform_gate() {
    let hint = Hint::parse("192.168.1.3:7431", Origin::Manual).unwrap();
    let original = observation("192.168.1.3:7431");
    let candidate = Candidate::evaluate(&hint, &original, 10).unwrap();
    assert_eq!(candidate.activate(), Err(E::N7PolicyPending));
    for mode in 0..15 {
        let mut changed = original.clone();
        match mode {
            0 => changed.route_interface = 4,
            1 => changed.medium = Medium::Cellular,
            2 => changed.medium = Medium::Vpn,
            3 => changed.medium = Medium::Loopback,
            4 => changed.medium = Medium::Unknown,
            5 => changed.link = Link::Down,
            6 => changed.next_hop = NextHop::Gateway("192.168.1.1".parse().unwrap()),
            7 => changed.local = "192.168.2.2".parse().unwrap(),
            8 => changed.destination = "192.168.2.0".parse().unwrap(),
            9 => changed.platform = Platform::PermissionDenied,
            10 => changed.platform = Platform::PermissionRevoked,
            11 => changed.platform = Platform::Unknown,
            12 => {
                changed.platform =
                    Platform::AndroidPickerEndpointObserved("192.168.1.4:7431".parse().unwrap())
            }
            13 => changed.endpoint = "192.168.1.4:7431".parse().unwrap(),
            _ => changed.local_prefix = 0,
        }
        assert!(Candidate::evaluate(&hint, &changed, 10).is_err());
        assert!(candidate.revalidate(&changed, 10).is_err());
    }
    let mut changed = original.clone();
    changed.generation = 2;
    assert!(candidate
        .connected(&changed, changed.local, changed.endpoint, 10)
        .is_err());
    assert!(candidate
        .connected(
            &original,
            "192.168.1.9".parse().unwrap(),
            original.endpoint,
            10
        )
        .is_err());
    assert!(Candidate::evaluate(&hint, &original, 9).is_err());
    assert!(Candidate::evaluate(&hint, &original, 14).is_err());
    for ip in ["8.8.8.8:7431", "192.168.1.255:7431", "192.168.1.0:7431"] {
        let h = Hint::parse(ip, Origin::Manual).unwrap();
        assert!(Candidate::evaluate(&h, &observation(ip), 10).is_err());
    }
    let mut fresh = original.clone();
    fresh.captured = 11;
    candidate.revalidate(&fresh, 11).unwrap();
    fresh.platform = Platform::AndroidBroadPermissionObserved;
    assert!(Candidate::evaluate(&hint, &fresh, 11).is_ok());
    fresh.platform = Platform::AndroidPickerEndpointObserved(fresh.endpoint);
    assert!(Candidate::evaluate(&hint, &fresh, 11).is_ok());
    assert!(windows_observation().is_err() && android_observation().is_err());
    // A public address must fail even when the fake direct route is on-link.
    for (endpoint, local, destination, prefix) in [
        ("8.8.8.3:7431", "8.8.8.2", "8.8.8.0", 24),
        ("[2001:db8::3]:7431", "2001:db8::2", "2001:db8::", 64),
    ] {
        let h = Hint::parse(endpoint, Origin::Manual).unwrap();
        let mut o = observation(endpoint);
        o.local = local.parse().unwrap();
        o.destination = destination.parse().unwrap();
        o.local_prefix = prefix;
        o.route_prefix = prefix;
        assert!(Candidate::evaluate(&h, &o, 10).is_err());
    }
    assert_eq!(super::transport::selected_route(), Err(E::N7PolicyPending));
    for h in ["192.168.1.3:7431", "desktop.local:7431"] {
        assert!(super::transport::ClosedLan.dial(h).is_err());
        assert!(super::transport::ClosedLan.listen(h).is_err());
    }
}
#[cfg_attr(test, test)]
fn n7a_ipv6_scope_and_family() {
    let hint = Hint::parse("[fe80::3%3]:7431", Origin::Discovery).unwrap();
    let mut o = observation("[fe80::3%3]:7431");
    o.local = "fe80::2".parse().unwrap();
    o.local_prefix = 64;
    o.destination = "fe80::".parse().unwrap();
    o.route_prefix = 64;
    assert!(Candidate::evaluate(&hint, &o, 10).is_ok());
    o.interface = 4;
    o.route_interface = 4;
    assert!(Candidate::evaluate(&hint, &o, 10).is_err());
    o.interface = 3;
    o.route_interface = 3;
    o.local = "192.168.1.2".parse().unwrap();
    assert!(Candidate::evaluate(&hint, &o, 10).is_err());
    let ula = Hint::parse("[fd00::3]:7431", Origin::Manual).unwrap();
    o.endpoint = "[fd00::3]:7431".parse().unwrap();
    o.local = "fd00::2".parse().unwrap();
    o.destination = "fd00::".parse().unwrap();
    assert!(Candidate::evaluate(&ula, &o, 10).is_ok());
    o.medium = Medium::Ethernet;
    assert!(Candidate::evaluate(&ula, &o, 10).is_ok());
}
#[derive(Default)]
struct Count(AtomicUsize);
impl Wake for Count {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
    fn wake_by_ref(self: &Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
#[derive(Default)]
struct Clock {
    now: AtomicU64,
    wake: Mutex<Option<Waker>>,
}
impl Timer for Clock {
    fn poll_until(&self, cx: &mut Context<'_>, deadline: u64) -> Poll<u64> {
        if self.now.load(Ordering::SeqCst) >= deadline {
            Poll::Ready(self.now.load(Ordering::SeqCst))
        } else {
            *self.wake.lock().unwrap() = Some(cx.waker().clone());
            Poll::Pending
        }
    }
}
impl Clock {
    fn advance(&self, n: u64) {
        self.now.store(n, Ordering::SeqCst);
        let w = self.wake.lock().unwrap().take();
        if let Some(w) = w {
            w.wake();
        }
    }
}
struct Io {
    input: io::Cursor<Vec<u8>>,
    output: Arc<Mutex<Vec<u8>>>,
    calls: Arc<AtomicUsize>,
    aborts: Arc<AtomicUsize>,
    max: usize,
    pending: bool,
    wake: Option<Waker>,
    cancel: Option<Arc<Interrupt>>,
}
impl Io {
    fn new(bytes: Vec<u8>) -> Self {
        Self {
            input: io::Cursor::new(bytes),
            output: Arc::default(),
            calls: Arc::default(),
            aborts: Arc::default(),
            max: 2,
            pending: false,
            wake: None,
            cancel: None,
        }
    }
}
impl EncryptedIo for Io {
    fn read(&mut self, cx: &mut Context<'_>, b: &mut [u8]) -> Poll<io::Result<usize>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(c) = &self.cancel {
            c.cancel();
        }
        if self.pending {
            self.wake = Some(cx.waker().clone());
            return Poll::Pending;
        }
        let len = b.len().min(self.max);
        Poll::Ready(self.input.read(&mut b[..len]))
    }
    fn write(&mut self, cx: &mut Context<'_>, b: &[u8]) -> Poll<io::Result<usize>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.pending {
            self.wake = Some(cx.waker().clone());
            return Poll::Pending;
        }
        let n = b.len().min(self.max);
        self.output.lock().unwrap().extend_from_slice(&b[..n]);
        Poll::Ready(Ok(n))
    }
    fn abort(&mut self) {
        self.aborts.fetch_add(1, Ordering::SeqCst);
    }
}
fn expected() -> Expected {
    Expected {
        network: Uuid::new_v4(),
        peer: Uuid::new_v4(),
    }
}
fn frame(bytes: &[u8]) -> Vec<u8> {
    [
        b"AE01".as_slice(),
        &(bytes.len() as u32).to_be_bytes(),
        bytes,
    ]
    .concat()
}
fn channel(io: Io, pool: &Arc<Pool>, now: u64) -> Framed<Io> {
    let e = expected();
    let p = pool.admit(e, now).unwrap().establish(now).unwrap();
    Framed::new(io, p, e, now).unwrap()
}
#[cfg_attr(test, test)]
fn n7a_partial_frames_writes_and_truncation() {
    let count = Arc::new(Count::default());
    let w = Waker::from(count);
    let mut cx = Context::from_waker(&w);
    let clock = Clock::default();
    let pool = Arc::new(Pool::default());
    let mut stream = channel(Io::new(frame(b"abc")), &pool, 10);
    let mut result = None;
    for _ in 0..20 {
        if let Poll::Ready(r) = stream.receive(&mut cx, 10, &clock) {
            result = Some(r.unwrap());
            break;
        }
    }
    assert_eq!(result, Some(b"abc".to_vec()));
    drop(stream);
    let io = Io::new(vec![]);
    let output = io.output.clone();
    let mut stream = channel(io, &pool, 10);
    stream.begin_send(b"xyz".to_vec()).unwrap();
    for _ in 0..20 {
        if let Poll::Ready(r) = stream.send(&mut cx, 10, &clock) {
            r.unwrap();
            break;
        }
    }
    assert_eq!(*output.lock().unwrap(), frame(b"xyz"));
    drop(stream);
    for bytes in [b"AE01\0\0\0\x03x".to_vec(), b"BAD!\0\0\0\x01x".to_vec()] {
        let p = Arc::new(Pool::default());
        let io = Io::new(bytes);
        let aborted = io.aborts.clone();
        let mut s = channel(io, &p, 10);
        let mut failed = false;
        for _ in 0..20 {
            if let Poll::Ready(Err(_)) = s.receive(&mut cx, 10, &clock) {
                failed = true;
                break;
            }
        }
        assert!(failed && aborted.load(Ordering::SeqCst) > 0);
        assert!(p.admit(expected(), 10).unwrap().establish(10).is_ok());
    }
}
#[cfg_attr(test, test)]
fn n7a_oversize_before_payload_and_bounded_output() {
    let w = Waker::from(Arc::new(Count::default()));
    let mut cx = Context::from_waker(&w);
    let clock = Clock::default();
    for size in [0, super::transport::MAX_RECORD + 1] {
        let pool = Arc::new(Pool::default());
        let mut io = Io::new([b"AE01".as_slice(), &(size as u32).to_be_bytes()].concat());
        io.max = 8;
        let calls = io.calls.clone();
        let mut s = channel(io, &pool, 10);
        assert_eq!(s.receive(&mut cx, 10, &clock), Poll::Ready(Err(E::Limit)));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    let pool = Arc::new(Pool::default());
    let mut s = channel(Io::new(vec![]), &pool, 10);
    assert_eq!(
        s.begin_send(vec![0; super::transport::MAX_RECORD + 1]),
        Err(E::Limit)
    );
}
#[cfg_attr(test, test)]
fn n7a_pending_cancel_shutdown_and_timer_wake() {
    for mode in 0..4 {
        let pool = Arc::new(Pool::default());
        let e = expected();
        let p = pool.admit(e, 10).unwrap().establish(10).unwrap();
        let cancel = p.cancellation();
        let mut io = Io::new(vec![]);
        io.pending = true;
        let aborted = io.aborts.clone();
        let mut s = Framed::new(io, p, e, 10).unwrap();
        let count = Arc::new(Count::default());
        let w = Waker::from(count.clone());
        let mut cx = Context::from_waker(&w);
        let clock = Clock::default();
        if mode == 3 {
            s.begin_send(vec![1]).unwrap();
            assert!(s.send(&mut cx, 10, &clock).is_pending());
        } else {
            assert!(s.receive(&mut cx, 10, &clock).is_pending());
        }
        match mode {
            0 | 3 => cancel.cancel(),
            1 => pool.shutdown().unwrap(),
            _ => clock.advance(25),
        };
        assert!(count.0.load(Ordering::SeqCst) > 0);
        let expected = if mode == 2 { E::Expired } else { E::Cancelled };
        if mode == 3 {
            assert_eq!(s.send(&mut cx, 11, &clock), Poll::Ready(Err(expected)));
        } else {
            assert_eq!(s.receive(&mut cx, 11, &clock), Poll::Ready(Err(expected)));
        }
        assert!(aborted.load(Ordering::SeqCst) > 0);
    }
}
#[cfg_attr(test, test)]
fn n7a_deadlines_scope_and_drop_release() {
    let pool = Arc::new(Pool::default());
    let e = expected();
    assert!(pool.admit(e, 10).unwrap().establish(20).is_err());
    let pool = Arc::new(Pool::default());
    for wrong in [
        Expected {
            network: Uuid::new_v4(),
            ..e
        },
        Expected {
            peer: Uuid::new_v4(),
            ..e
        },
    ] {
        let io = Io::new(vec![]);
        let calls = io.calls.clone();
        let abort = io.aborts.clone();
        let p = pool.admit(e, 10).unwrap().establish(10).unwrap();
        assert!(Framed::new(io, p, wrong, 10).is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(abort.load(Ordering::SeqCst) > 0);
    }
    let io = Io::new(frame(b"abc"));
    let aborted = io.aborts.clone();
    let mut s = channel(io, &pool, 10);
    let w = Waker::from(Arc::new(Count::default()));
    let mut cx = Context::from_waker(&w);
    let clock = Clock::default();
    assert!(s.receive(&mut cx, 24, &clock).is_pending());
    assert_eq!(s.receive(&mut cx, 25, &clock), Poll::Ready(Err(E::Expired)));
    drop(s);
    assert!(aborted.load(Ordering::SeqCst) > 0);
    let pool = Arc::new(Pool::default());
    let mut io = Io::new(frame(b"abc"));
    // Cancellation during a ready read is exercised with the same permit below.
    let e = expected();
    let p = pool.admit(e, 10).unwrap().establish(10).unwrap();
    io.cancel = Some(p.cancellation());
    let mut s = Framed::new(io, p, e, 10).unwrap();
    assert_eq!(
        s.receive(&mut cx, 10, &clock),
        Poll::Ready(Err(E::Cancelled))
    );
}
#[cfg_attr(test, test)]
fn n7a_concurrent_limits_retry_and_shutdown() {
    let pool = Arc::new(Pool::default());
    let start = Arc::new(Barrier::new(9));
    let finish = Arc::new(Barrier::new(9));
    let (tx, rx) = std::sync::mpsc::channel();
    let mut workers = vec![];
    for _ in 0..8 {
        let p = pool.clone();
        let a = start.clone();
        let b = finish.clone();
        let tx = tx.clone();
        workers.push(std::thread::spawn(move || {
            a.wait();
            let permit = p.admit(expected(), 10);
            tx.send(permit.is_ok()).unwrap();
            b.wait();
            drop(permit);
        }));
    }
    start.wait();
    let successes = (0..8).filter(|_| rx.recv().unwrap()).count();
    assert_eq!(successes, 2);
    finish.wait();
    for t in workers {
        t.join().unwrap();
    }
    for _ in 0..2 {
        drop(pool.admit(expected(), 10).unwrap());
    }
    assert!(matches!(pool.admit(expected(), 10), Err(E::Limit)));
    assert!(pool.admit(expected(), 9).is_err());
    let e = expected();
    let p = pool.admit(e, 40).unwrap();
    assert!(pool.admit(e, 40).is_err());
    let p = p.establish(40).unwrap();
    let other = pool.admit(expected(), 40).unwrap();
    assert!(other.establish(40).is_err());
    drop(p);
    pool.shutdown().unwrap();
    assert!(matches!(pool.admit(expected(), 70), Err(E::Cancelled)));
}
#[cfg_attr(test, test)]
fn n7a_handshake_deadline_and_total_session() {
    let count = Arc::new(Count::default());
    let w = Waker::from(count.clone());
    let mut cx = Context::from_waker(&w);
    let timer = Clock::default();
    let pool = Arc::new(Pool::default());
    let io = Io::new(vec![]);
    let abort = io.aborts.clone();
    let e = expected();
    let mut handshake = Handshake::new(io, pool.admit(e, 10).unwrap());
    handshake.poll_budget(&mut cx, 10, &timer).unwrap();
    timer.advance(20);
    assert!(count.0.load(Ordering::SeqCst) > 0);
    assert_eq!(handshake.poll_budget(&mut cx, 20, &timer), Err(E::Expired));
    assert!(abort.load(Ordering::SeqCst) > 0);
    assert!(pool.admit(e, 20).is_ok());
    let pool = Arc::new(Pool::default());
    let mut io = Io::new(frame(b"abc"));
    io.max = 8;
    let p = pool.admit(e, 10).unwrap();
    let mut handshake = Handshake::new(io, p);
    let timer = Clock::default();
    handshake.poll_budget(&mut cx, 10, &timer).unwrap();
    let mut stream = handshake.finish(11).unwrap();
    // Successful full records refresh idle, never the total deadline from admission.
    for tick in [20, 30, 40, 50, 60] {
        if tick == 20 {
            assert!(stream.receive(&mut cx, tick, &timer).is_pending());
            assert_eq!(
                stream.receive(&mut cx, tick, &timer),
                Poll::Ready(Ok(b"abc".to_vec()))
            );
        }
        stream.begin_send(vec![1]).unwrap();
        for _ in 0..10 {
            if let Poll::Ready(result) = stream.send(&mut cx, tick, &timer) {
                result.unwrap();
                break;
            }
        }
    }
    assert_eq!(
        stream.receive(&mut cx, 70, &timer),
        Poll::Ready(Err(E::Expired))
    );
}
#[cfg_attr(test, test)]
fn n7a_drop_releases_cancel_waker_registration() {
    let pool = Arc::new(Pool::default());
    let e = expected();
    let permit = pool.admit(e, 10).unwrap().establish(10).unwrap();
    let cancel = permit.cancellation();
    let mut io = Io::new(vec![]);
    io.pending = true;
    let count = Arc::new(Count::default());
    let weak = Arc::downgrade(&count);
    let w = Waker::from(count.clone());
    let timer = Clock::default();
    {
        let mut stream = Framed::new(io, permit, e, 10).unwrap();
        let mut cx = Context::from_waker(&w);
        assert!(stream.receive(&mut cx, 10, &timer).is_pending());
    }
    drop(w);
    drop(count);
    timer.advance(100);
    assert!(
        weak.upgrade().is_none(),
        "completed stream retained its task through cancellation handle"
    );
    cancel.cancel();
}
pub(crate) fn run() -> super::Result<()> {
    std::panic::catch_unwind(|| {
        n7a_hostile_manual_and_dns_hints();
        n7a_route_selection_changes_and_platform_gate();
        n7a_ipv6_scope_and_family();
        n7a_partial_frames_writes_and_truncation();
        n7a_oversize_before_payload_and_bounded_output();
        n7a_pending_cancel_shutdown_and_timer_wake();
        n7a_deadlines_scope_and_drop_release();
        n7a_concurrent_limits_retry_and_shutdown();
        n7a_handshake_deadline_and_total_session();
        n7a_drop_releases_cancel_waker_registration();
    })
    .map_err(|_| E::State)
}
