//! Invalidation-only OS boundary. One explicit worker, one coalesced queue slot.
use super::route_observer::Unavailable as U;
use std::sync::{
    atomic::{AtomicU32, AtomicU64, Ordering},
    mpsc::{sync_channel, Receiver, SyncSender},
    Arc,
};
use std::thread::{self, JoinHandle};
pub(crate) const ROUTE: u32 = 1;
pub(crate) const INTERFACE: u32 = 2;
pub(crate) const ADDRESS: u32 = 4;
pub(crate) const PROFILE: u32 = 8;
pub(crate) const AVAILABLE: u32 = 16;
pub(crate) const LOST: u32 = 32;
pub(crate) const CAPABILITIES: u32 = 64;
pub(crate) const LINK_PROPERTIES: u32 = 128;

pub(crate) struct Signal {
    // Low bit is live; remaining bits are a checked monotonically increasing epoch.
    stamp: AtomicU64,
    kinds: AtomicU32,
    failure: AtomicU32,
    wake: SyncSender<()>,
    #[cfg(test)]
    dropped: std::sync::Mutex<Option<SyncSender<()>>>,
}
#[cfg(test)]
impl Drop for Signal {
    fn drop(&mut self) {
        if let Some(tx) = self.dropped.get_mut().unwrap().take() {
            let _ = tx.send(());
        }
    }
}
#[derive(Clone)]
pub(crate) struct Fence {
    signal: Arc<Signal>,
    stamp: u64,
}
impl Fence {
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub(crate) fn generation(&self) -> u64 {
        self.stamp
    }

    pub(crate) fn valid(&self) -> bool {
        self.signal.snapshot() == Some(self.stamp)
    }
    pub(crate) fn same_registration(&self, other: &Arc<Signal>) -> bool {
        Arc::ptr_eq(&self.signal, other)
    }
}
impl Signal {
    pub(crate) fn channel() -> (Arc<Self>, Receiver<()>) {
        let (tx, rx) = sync_channel(1);
        (
            Arc::new(Self {
                stamp: AtomicU64::new(1),
                kinds: AtomicU32::new(0),
                failure: AtomicU32::new(0),
                wake: tx,
                #[cfg(test)]
                dropped: std::sync::Mutex::new(None),
            }),
            rx,
        )
    }
    pub(crate) fn snapshot(&self) -> Option<u64> {
        let n = self.stamp.load(Ordering::Acquire);
        if n & 1 == 1 {
            Some(n)
        } else {
            None
        }
    }
    pub(crate) fn fence(self: &Arc<Self>) -> Option<Fence> {
        Some(Fence {
            signal: self.clone(),
            stamp: self.snapshot()?,
        })
    }
    pub(crate) fn notify(&self, kind: u32) -> bool {
        let mut n = self.stamp.load(Ordering::Acquire);
        loop {
            if n & 1 == 0 {
                return false;
            }
            let next = n.checked_add(2).unwrap_or(n & !1);
            match self
                .stamp
                .compare_exchange_weak(n, next, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => {
                    self.kinds.fetch_or(kind, Ordering::Relaxed);
                    let _ = self.wake.try_send(());
                    return true;
                }
                Err(current) => n = current,
            }
        }
    }
    pub(crate) fn close(&self) {
        self.stamp.fetch_and(!1, Ordering::AcqRel);
        let _ = self.wake.try_send(());
    }
    pub(crate) fn failed(&self, code: u32) {
        let _ = self
            .failure
            .compare_exchange(0, code.max(1), Ordering::AcqRel, Ordering::Acquire);
        self.close();
    }
    pub(crate) fn kinds(&self) -> u32 {
        self.kinds.load(Ordering::Acquire)
    }
}
pub(crate) struct Monitor {
    pub(crate) signal: Arc<Signal>,
    worker: Option<JoinHandle<()>>,
}
impl Monitor {
    pub(crate) fn start(
        signal: Arc<Signal>,
        rx: Receiver<()>,
        dispatch: impl Fn(&Arc<Signal>) + Send + 'static,
    ) -> Result<Self, U> {
        let (ready_tx, ready_rx) = sync_channel(1);
        let signal_worker = signal.clone();
        let worker = thread::Builder::new()
            .name("arthur-route-invalidation".into())
            .spawn(move || {
                let mut watch = match subscribe(&signal_worker) {
                    Ok(w) => w,
                    Err(e) => {
                        signal_worker.close();
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                if ready_tx.send(Ok(())).is_ok() {
                    while rx.recv().is_ok() {
                        dispatch(&signal_worker);
                        if signal_worker.snapshot().is_none() {
                            break;
                        }
                    }
                }
                signal_worker.close();
                if watch.close().is_err() {
                    signal_worker.failed(1);
                }
            })
            .map_err(|_| U::Unavailable)?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                signal,
                worker: Some(worker),
            }),
            Ok(Err(e)) => {
                signal.close();
                let _ = worker.join();
                Err(e)
            }
            Err(_) => {
                signal.close();
                let _ = worker.join();
                Err(U::Unavailable)
            }
        }
    }
    pub(crate) fn stop(&mut self) -> Result<(), U> {
        self.signal.close();
        if let Some(worker) = self.worker.take() {
            // Executor wake/destructor reentrancy on this worker must not self-join.
            if worker.thread().id() != thread::current().id() && worker.join().is_err() {
                self.signal.failed(1);
            }
        }
        if self.signal.failure.load(Ordering::Acquire) != 0 {
            Err(U::Unavailable)
        } else {
            Ok(())
        }
    }
}
impl Drop for Monitor {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
#[cfg(all(target_os = "android", feature = "android-identity-tests"))]
pub(crate) fn qualify_android(positive: bool) -> crate::sync::security::Result<()> {
    use crate::sync::security::{
        route_candidate::{Candidate, Hint, Origin},
        SecurityError as E,
    };
    let (s, rx) = Signal::channel();
    let (tx, events) = std::sync::mpsc::channel();
    let result = Monitor::start(s.clone(), rx, move |s| {
        let _ = tx.send(s.kinds());
    });
    if !positive {
        return if matches!(result, Err(U::MissingPermission)) {
            Ok(())
        } else {
            Err(E::State)
        };
    }
    let mut monitor = result.map_err(|_| E::PlatformUnverified)?;
    let required = AVAILABLE | CAPABILITIES | LINK_PROPERTIES;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while s.kinds() & required != required {
        events
            .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
            .map_err(|_| E::Expired)?;
    }
    let h = Hint::parse("192.168.1.3:7431", Origin::Manual)?;
    let o = super::route_observer::acquire("192.168.1.3:7431".parse().map_err(|_| E::Invalid)?)
        .map_err(|_| E::PlatformUnverified)?;
    if o.source_selected || Candidate::evaluate(&h, &o, 0).is_ok() {
        return Err(E::Trust);
    }
    let f = s.fence().ok_or(E::State)?;
    monitor.stop().map_err(|_| E::State)?;
    monitor.stop().map_err(|_| E::State)?;
    if f.valid() || s.notify(LOST) {
        return Err(E::State);
    }
    platform::qualify_late_token()?;
    Ok(())
}
#[cfg(windows)]
#[path = "watch_windows.rs"]
mod platform;
#[cfg(target_os = "android")]
#[path = "watch_android.rs"]
mod platform;
#[cfg(any(windows, target_os = "android"))]
fn subscribe(signal: &Arc<Signal>) -> Result<platform::Watch, U> {
    platform::Watch::new(signal)
}
#[cfg(not(any(windows, target_os = "android")))]
fn subscribe(_: &Arc<Signal>) -> Result<Unsupported, U> {
    Err(U::Unsupported)
}
#[cfg(not(any(windows, target_os = "android")))]
struct Unsupported;
#[cfg(not(any(windows, target_os = "android")))]
impl Unsupported {
    fn close(&mut self) -> Result<(), U> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn n7d_actual_monitor_overflow_and_reentrant_shutdown_release_context() {
        use std::sync::Mutex;
        use std::time::Duration;
        for overflow in [false, true] {
            let (s, rx) = Signal::channel();
            let (done, completed) = sync_channel(1);
            *s.dropped.lock().unwrap() = Some(done);
            let slot = Arc::new(Mutex::new(None::<Monitor>));
            let weak = Arc::downgrade(&slot);
            let (stopped, stop_event) = sync_channel(1);
            let m = Monitor::start(s.clone(), rx, move |signal| {
                if signal.snapshot().is_none() || signal.kinds() & PROFILE != 0 {
                    if let Some(slot) = weak.upgrade() {
                        let monitor = slot.lock().unwrap().take();
                        if let Some(mut monitor) = monitor {
                            monitor.stop().unwrap(); // dispatch worker must not self-join
                            drop(monitor);
                            let _ = stopped.send(());
                        }
                    }
                }
            })
            .unwrap();
            *slot.lock().unwrap() = Some(m);
            if overflow {
                s.stamp.store(u64::MAX, Ordering::Release);
            }
            s.notify(PROFILE); // controlled signal, never mutates host network
            stop_event.recv_timeout(Duration::from_secs(10)).unwrap();
            assert!(s.snapshot().is_none());
            assert!(!s.notify(ROUTE));
            drop(s);
            // Signal can drop only after the worker and all native callback
            // contexts/COM sink release it. No timing sleep or weak polling.
            completed.recv_timeout(Duration::from_secs(10)).unwrap();
        }
    }
    #[test]
    fn n7c_bounded_duplicate_reordered_epochs_and_terminal_overflow() {
        let (s, rx) = Signal::channel();
        let old = s.fence().unwrap();
        for kind in [
            PROFILE,
            ROUTE,
            ROUTE,
            ADDRESS,
            INTERFACE,
            LOST,
            AVAILABLE,
            CAPABILITIES,
            LINK_PROPERTIES,
        ] {
            assert!(s.notify(kind));
            assert!(!old.valid());
        }
        assert!(rx.try_recv().is_ok());
        assert!(rx.try_recv().is_err());
        let current = s.fence().unwrap();
        s.close();
        s.close();
        assert!(!current.valid());
        assert!(!s.notify(ROUTE));
        let (s, _) = Signal::channel();
        s.stamp.store(u64::MAX, Ordering::Release);
        assert!(s.notify(ROUTE));
        assert!(s.snapshot().is_none());
        assert!(!s.notify(ROUTE));
    }
    #[test]
    fn n7c_concurrent_signal_close_cannot_restore_eligibility() {
        for _ in 0..32 {
            let (s, _) = Signal::channel();
            let f = s.fence().unwrap();
            std::thread::scope(|scope| {
                for _ in 0..4 {
                    let s = &s;
                    scope.spawn(move || {
                        for _ in 0..128 {
                            s.notify(ROUTE);
                        }
                    });
                }
                s.close();
            });
            assert!(!f.valid());
            assert!(s.snapshot().is_none());
            assert!(!s.notify(PROFILE));
        }
    }
    #[cfg(windows)]
    #[test]
    fn n7c_actual_windows_notifications_and_idempotent_unsubscribe() {
        let (s, rx) = Signal::channel();
        let (tx, events) = std::sync::mpsc::channel();
        let mut m = Monitor::start(s.clone(), rx, move |s| {
            let _ = tx.send(s.kinds());
        })
        .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while s.kinds() & (ROUTE | INTERFACE | ADDRESS) != ROUTE | INTERFACE | ADDRESS {
            events
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .unwrap();
        }
        // These are actual OS InitialNotification callbacks, not route mutations.
        assert!(s.snapshot().is_some());
        m.stop().unwrap();
        m.stop().unwrap();
        assert!(!s.notify(PROFILE));
        let weak = Arc::downgrade(&s);
        drop(m);
        drop(s);
        assert!(weak.upgrade().is_none());
    }
}
