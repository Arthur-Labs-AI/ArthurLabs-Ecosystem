//! Dormant bounded encrypted-stream seam; no socket/TLS/Sync implementation.
use super::{transport::MAX_RECORD, Result, SecurityError as E};
use crate::sync::Cancellation;
use std::{
    collections::VecDeque,
    io,
    sync::{Arc, Mutex, Weak},
    task::{Context, Poll, Waker},
};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Expected {
    pub network: Uuid,
    pub peer: Uuid,
}
// Expected is local routing metadata, NOT authenticated membership.
#[derive(Default)]
pub(crate) struct Interrupt {
    flag: Cancellation,
    wake: Mutex<Option<Waker>>,
}
impl Interrupt {
    pub(crate) fn cancelled(&self) -> bool {
        self.flag.cancelled()
    }
    pub fn cancel(&self) {
        self.flag.cancel();
        let wake = self.wake.lock().ok().and_then(|mut w| w.take());
        if let Some(w) = wake {
            w.wake();
        }
    }
    fn register(&self, cx: &Context<'_>) -> Result<()> {
        let next = cx.waker().clone();
        let mut wake = self.wake.lock().map_err(|_| E::State)?;
        if self.flag.cancelled() {
            return Err(E::Cancelled);
        }
        let old = wake.replace(next);
        drop(wake);
        drop(old); // executor teardown may reenter
        Ok(())
    }
}
#[derive(Default)]
struct State {
    active: Vec<(u64, Expected, bool, Weak<Interrupt>)>,
    next: u64,
    closed: bool,
    last: u64,
    admissions: VecDeque<u64>,
}
#[cfg_attr(any(test, feature = "android-identity-tests"), derive(Default))]
pub(crate) struct Pool(Mutex<State>);
pub(crate) struct Permit {
    pool: Arc<Pool>,
    id: u64,
    expected: Expected,
    stop: Arc<Interrupt>,
    started: u64,
    fence: Option<super::network_watch::Fence>,
}
impl Pool {
    pub(crate) fn new(_: &crate::runtime::TransportOwner) -> Self {
        Self(Mutex::new(State::default()))
    }
    pub(crate) fn invalidate(&self) -> Result<Vec<Arc<Interrupt>>> {
        let s = self.0.lock().map_err(|_| E::State)?;
        let stops: Vec<_> = s.active.iter().filter_map(|x| x.3.upgrade()).collect();
        for stop in &stops {
            stop.flag.cancel();
        }
        Ok(stops)
    }
    pub(crate) fn admit_observed(
        self: &Arc<Self>,
        expected: Expected,
        now: u64,
        cancel: &Arc<Interrupt>,
        fence: Option<super::network_watch::Fence>,
    ) -> Result<Permit> {
        if fence.as_ref().is_some_and(|f| !f.valid()) {
            return Err(E::Cancelled);
        }
        let mut p = self.admit_with_stop(expected, now, cancel.clone())?;
        p.fence = fence;
        // Caller rechecks after releasing the coordinator lock. Dropping here
        // could run a caller-owned waker destructor under that lock.
        Ok(p)
    }
    pub(crate) fn admit_cancellable(
        self: &Arc<Self>,
        expected: Expected,
        now: u64,
        cancel: &Arc<Interrupt>,
    ) -> Result<Permit> {
        self.admit_with_stop(expected, now, cancel.clone())
    }
    #[cfg(any(test, feature = "android-identity-tests"))]
    pub fn admit(self: &Arc<Self>, expected: Expected, now: u64) -> Result<Permit> {
        self.admit_with_stop(expected, now, Arc::new(Interrupt::default()))
    }
    fn admit_with_stop(
        self: &Arc<Self>,
        expected: Expected,
        now: u64,
        stop: Arc<Interrupt>,
    ) -> Result<Permit> {
        if expected.network.is_nil() || expected.peer.is_nil() || now.checked_add(60).is_none() {
            return Err(E::Invalid);
        }
        let mut s = self.0.lock().map_err(|_| E::State)?;
        if s.closed || stop.flag.cancelled() {
            return Err(E::Cancelled);
        }
        if now < s.last {
            return Err(E::State);
        }
        s.last = now;
        while s.admissions.front().is_some_and(|tick| now - *tick >= 30) {
            s.admissions.pop_front();
        }
        if s.admissions.len() >= 4
            || s.active.iter().filter(|x| !x.2).count() >= 2
            || s.active.iter().any(|x| x.1 == expected)
        {
            return Err(E::Limit);
        }
        s.next = s.next.checked_add(1).ok_or(E::Limit)?;
        let id = s.next;
        s.admissions.push_back(now);
        s.active.push((id, expected, false, Arc::downgrade(&stop)));
        Ok(Permit {
            pool: self.clone(),
            id,
            expected,
            stop,
            started: now,
            fence: None,
        })
    }
    pub fn shutdown(&self) -> Result<()> {
        let (stops, poisoned) = {
            let (mut s, poisoned) = match self.0.lock() {
                Ok(s) => (s, false),
                Err(e) => (e.into_inner(), true),
            };
            s.closed = true;
            let stops: Vec<_> = s.active.iter().filter_map(|x| x.3.upgrade()).collect();
            for stop in &stops {
                stop.flag.cancel();
            }
            (stops, poisoned)
        };
        for stop in stops {
            stop.cancel();
        }
        if poisoned {
            Err(E::State)
        } else {
            Ok(())
        }
    }
}
impl Permit {
    fn cancelled(&self) -> bool {
        self.stop.cancelled() || self.fence.as_ref().is_some_and(|f| !f.valid())
    }
    fn register(&self, cx: &Context<'_>) -> Result<()> {
        self.stop.register(cx)?;
        if self.cancelled() {
            Err(E::Cancelled)
        } else {
            Ok(())
        }
    }
    pub fn establish(self, now: u64) -> Result<Self> {
        {
            let mut s = self.pool.0.lock().map_err(|_| E::State)?;
            if s.closed || self.cancelled() {
                return Err(E::Cancelled);
            }
            if now < s.last {
                return Err(E::State);
            }
            s.last = now;
            if now < self.started || now - self.started >= 10 {
                return Err(E::Expired);
            }
            if s.active.iter().any(|x| x.2) {
                return Err(E::Limit);
            }
            let slot = s
                .active
                .iter_mut()
                .find(|x| x.0 == self.id)
                .ok_or(E::State)?;
            slot.2 = true;
        }
        if self.cancelled() {
            return Err(E::Cancelled);
        }
        Ok(self)
    }
    pub fn cancellation(&self) -> Arc<Interrupt> {
        self.stop.clone()
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        // A retained cancellation handle must not retain a completed task.
        // Drop the waker outside either mutex: executor teardown may reenter.
        self.stop.flag.cancel();
        let retired = self.stop.wake.lock().ok().and_then(|mut w| w.take());
        drop(retired);
        if let Ok(mut s) = self.pool.0.lock() {
            s.active.retain(|x| x.0 != self.id);
        }
    }
}
/// Implementations MUST be nonblocking, register cx on Pending, return bounded
/// byte counts, and abort synchronously by releasing/shutting down owned I/O.
/// A blocking Read/Write adapter does not implement this contract. No live impl.
pub(crate) trait EncryptedIo {
    fn read(&mut self, cx: &mut Context<'_>, bytes: &mut [u8]) -> Poll<io::Result<usize>>;
    fn write(&mut self, cx: &mut Context<'_>, bytes: &[u8]) -> Poll<io::Result<usize>>;
    fn abort(&mut self);
}
/// Timer must register a wake at deadline. Fake timer tests explicitly fire it;
/// a future native executor adapter must supply actual monotonic wakeups.
pub(crate) trait Timer {
    fn poll_until(
        &self,
        cx: &mut Context<'_>,
        deadline: u64,
    ) -> (Poll<u64>, Box<dyn TimerRegistration>);
}
/// Dropping a registration MUST unregister its wake without calling it under
/// an executor lock. Each stream owns at most one registration, removed on
/// completion, failure, transition and Drop. No native timer implementation yet.
pub(crate) trait TimerRegistration {}
/// Budget/lifecycle model only: finish is NOT TLS authentication. No TLS
/// constructor consumes this type and no production transport accepts Framed.
pub(crate) struct Handshake<I: EncryptedIo> {
    io: Option<I>,
    permit: Option<Permit>,
    last: u64,
    timer: Option<Box<dyn TimerRegistration>>,
}
impl<I: EncryptedIo> Handshake<I> {
    pub fn new(io: I, permit: Permit) -> Self {
        let last = permit.started;
        Self {
            io: Some(io),
            permit: Some(permit),
            last,
            timer: None,
        }
    }
    pub fn poll_budget(
        &mut self,
        cx: &mut Context<'_>,
        now: u64,
        timer: &impl Timer,
    ) -> Result<()> {
        let result = (|| {
            let p = self.permit.as_ref().ok_or(E::State)?;
            p.register(cx)?;
            if now < self.last {
                return Err(E::State);
            }
            self.last = now;
            let deadline = p.started + 10;
            self.timer.take();
            if now >= deadline {
                return Err(E::Expired);
            }
            let (poll, registration) = timer.poll_until(cx, deadline);
            self.timer = Some(registration);
            if let Poll::Ready(tick) = poll {
                return Err(if tick >= deadline {
                    E::Expired
                } else {
                    E::State
                });
            }
            Ok(())
        })();
        if result.is_err() {
            self.timer.take();
            if let Some(mut io) = self.io.take() {
                io.abort();
            }
            self.permit.take();
        }
        result
    }
    pub fn finish(mut self, now: u64) -> Result<Framed<I>> {
        self.timer.take();
        if now < self.last {
            return Err(E::State);
        }
        let p = self.permit.take().ok_or(E::State)?;
        let expected = p.expected;
        let p = match p.establish(now) {
            Ok(p) => p,
            Err(e) => {
                if let Some(mut io) = self.io.take() {
                    io.abort();
                }
                return Err(e);
            }
        };
        Framed::new(self.io.take().ok_or(E::State)?, p, expected, now)
    }
}
impl<I: EncryptedIo> Drop for Handshake<I> {
    fn drop(&mut self) {
        if let Some(io) = &mut self.io {
            io.abort();
        }
    }
}
pub(crate) struct Framed<I: EncryptedIo> {
    io: I,
    permit: Option<Permit>,
    last: u64,
    idle: u64,
    total: u64,
    header: [u8; 8],
    offset: usize,
    payload: Option<Vec<u8>>,
    output: Option<Vec<u8>>,
    timer: Option<Box<dyn TimerRegistration>>,
}
impl<I: EncryptedIo> Framed<I> {
    pub fn new(mut io: I, permit: Permit, expected: Expected, now: u64) -> Result<Self> {
        // The permit cannot be transferred to a different expected network/peer.
        if permit.expected != expected || now < permit.started || now - permit.started >= 60 {
            io.abort();
            return Err(E::Trust);
        }
        let session = match permit.pool.0.lock() {
            Ok(s) => {
                !s.closed && !permit.cancelled() && s.active.iter().any(|x| x.0 == permit.id && x.2)
            }
            Err(_) => {
                io.abort();
                return Err(E::State);
            }
        };
        if !session {
            io.abort();
            return Err(E::State);
        }
        let total = permit.started.checked_add(60).ok_or(E::Limit)?;
        let idle = now.checked_add(15).ok_or(E::Limit)?;
        Ok(Self {
            io,
            permit: Some(permit),
            last: now,
            idle,
            total,
            header: [0; 8],
            offset: 0,
            payload: None,
            output: None,
            timer: None,
        })
    }
    fn fail<T>(&mut self, e: E) -> Poll<Result<T>> {
        self.io.abort();
        self.timer.take();
        self.permit.take();
        self.payload = None;
        self.output = None;
        Poll::Ready(Err(e))
    }
    fn guard(&mut self, cx: &mut Context<'_>, now: u64, timer: &impl Timer) -> Result<()> {
        let p = self.permit.as_ref().ok_or(E::State)?;
        p.register(cx)?;
        if now < self.last {
            return Err(E::State);
        }
        self.last = now;
        let deadline = self.idle.min(self.total);
        if now >= deadline {
            return Err(E::Expired);
        }
        self.timer.take();
        let (poll, registration) = timer.poll_until(cx, deadline);
        self.timer = Some(registration);
        if let Poll::Ready(tick) = poll {
            if tick >= deadline {
                return Err(E::Expired);
            }
            return Err(E::State);
        }
        Ok(())
    }
    pub fn receive(
        &mut self,
        cx: &mut Context<'_>,
        now: u64,
        timer: &impl Timer,
    ) -> Poll<Result<Vec<u8>>> {
        if let Err(e) = self.guard(cx, now, timer) {
            return self.fail(e);
        }
        if self.output.is_some() {
            return self.fail(E::State);
        }
        // One nonblocking read per poll prevents a ready stream starving cancel/timer.
        let dst = if let Some(body) = &mut self.payload {
            &mut body[self.offset..]
        } else {
            &mut self.header[self.offset..]
        };
        let capacity = dst.len();
        let result = self.io.read(cx, dst);
        if self.permit.as_ref().is_some_and(|p| p.cancelled()) {
            return self.fail(E::Cancelled);
        }
        match result {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(_)) => self.fail(E::Invalid),
            Poll::Ready(Ok(n)) if n == 0 || n > capacity => self.fail(E::Invalid),
            Poll::Ready(Ok(n)) => {
                self.offset += n;
                // Partial bytes do not extend idle: slow-drip frames expire.
                if self.payload.is_none() && self.offset == 8 {
                    if &self.header[..4] != b"AE01" {
                        return self.fail(E::Invalid);
                    }
                    let len = u32::from_be_bytes(self.header[4..].try_into().unwrap()) as usize;
                    if len == 0 || len > MAX_RECORD {
                        return self.fail(E::Limit);
                    }
                    self.payload = Some(vec![0; len]);
                    self.offset = 0;
                } else if self
                    .payload
                    .as_ref()
                    .is_some_and(|b| self.offset == b.len())
                {
                    let body = self.payload.take().unwrap();
                    self.offset = 0;
                    self.idle = now.saturating_add(15);
                    self.timer.take();
                    return Poll::Ready(Ok(body));
                }
                cx.waker().wake_by_ref();
                Poll::Pending
            }
        }
    }
    pub fn begin_send(&mut self, bytes: Vec<u8>) -> Result<()> {
        if self.permit.is_none()
            || self.output.is_some()
            || self.offset != 0
            || self.payload.is_some()
        {
            return Err(E::State);
        }
        if self.permit.as_ref().is_some_and(|p| p.cancelled()) {
            return Err(E::Cancelled);
        }
        if bytes.is_empty() || bytes.len() > MAX_RECORD || bytes.capacity() > MAX_RECORD {
            return Err(E::Limit);
        }
        let mut frame = Vec::with_capacity(8 + bytes.len());
        frame.extend_from_slice(b"AE01");
        frame.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        frame.extend_from_slice(&bytes);
        self.output = Some(frame);
        Ok(())
    }
    pub fn send(&mut self, cx: &mut Context<'_>, now: u64, timer: &impl Timer) -> Poll<Result<()>> {
        if let Err(e) = self.guard(cx, now, timer) {
            return self.fail(e);
        }
        let Some(out) = self.output.as_ref() else {
            return self.fail(E::State);
        };
        let capacity = out.len() - self.offset;
        let result = self.io.write(cx, &out[self.offset..]);
        if self.permit.as_ref().is_some_and(|p| p.cancelled()) {
            return self.fail(E::Cancelled);
        }
        match result {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(_)) => self.fail(E::Invalid),
            Poll::Ready(Ok(n)) if n == 0 || n > capacity => self.fail(E::Invalid),
            Poll::Ready(Ok(n)) => {
                self.offset += n;
                if self.offset == self.output.as_ref().unwrap().len() {
                    self.output = None;
                    self.offset = 0;
                    self.idle = now.saturating_add(15);
                    self.timer.take();
                    Poll::Ready(Ok(()))
                } else {
                    cx.waker().wake_by_ref();
                    Poll::Pending
                }
            }
        }
    }
}
impl<I: EncryptedIo> Drop for Framed<I> {
    fn drop(&mut self) {
        self.io.abort();
    }
}

#[cfg(test)]
mod n7b_lifecycle_tests {
    use super::*;
    use std::{
        sync::atomic::{AtomicBool, Ordering},
        task::Wake,
    };
    struct Reentrant {
        stop: Weak<Interrupt>,
        released: Arc<AtomicBool>,
    }
    impl Wake for Reentrant {
        fn wake(self: Arc<Self>) {}
    }
    impl Drop for Reentrant {
        fn drop(&mut self) {
            if let Some(stop) = self.stop.upgrade() {
                self.released
                    .store(stop.wake.try_lock().is_ok(), Ordering::SeqCst);
            }
        }
    }
    struct Idle;
    impl Wake for Idle {
        fn wake(self: Arc<Self>) {}
    }
    #[test]
    fn n7b_replaced_waker_destructor_runs_outside_lock() {
        let stop = Arc::new(Interrupt::default());
        let released = Arc::new(AtomicBool::new(false));
        let w = Waker::from(Arc::new(Reentrant {
            stop: Arc::downgrade(&stop),
            released: released.clone(),
        }));
        stop.register(&Context::from_waker(&w)).unwrap();
        drop(w);
        let next = Waker::from(Arc::new(Idle));
        stop.register(&Context::from_waker(&next)).unwrap();
        assert!(released.load(Ordering::SeqCst));
        stop.cancel();
    }
}
