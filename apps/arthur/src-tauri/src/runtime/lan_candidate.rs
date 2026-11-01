//! Single dormant runtime owner. Explicit event subscriptions; native-only fresh admission.
use crate::sync::security::{
    network_watch::{Fence, Monitor, Signal},
    route_candidate::{Address, Candidate, Hint, Observation},
    route_observer,
    transport_candidate::{Expected, Interrupt, Permit, Pool},
    Result, SecurityError as E,
};
use std::{
    ops::Deref,
    sync::{Arc, Mutex},
    time::Instant,
};
pub(crate) struct Coordinator {
    core: Arc<Core>,
    monitor: Mutex<Option<Monitor>>,
}
pub(crate) struct Core {
    state: Mutex<State>,
    pool: Arc<Pool>,
    clock: Instant,
    owner: Arc<()>,
}
impl Deref for Coordinator {
    type Target = Core;
    fn deref(&self) -> &Core {
        &self.core
    }
}
struct State {
    revision: u64,
    closed: bool,
    current: Option<(Hint, Observation)>,
    signal: Option<Arc<Signal>>,
    event_stamp: Option<u64>,
}
pub(crate) struct Selection {
    candidate: Candidate,
    owner: Arc<()>,
    hint: Hint,
    revision: u64,
    fence: Option<Fence>,
    native: bool,
}
pub(crate) struct Ticket {
    owner: Arc<()>,
    revision: u64,
    hint: Hint,
    captured: u64,
    started: Instant,
    fence: Option<Fence>,
}
impl Core {
    fn invalidate(&self, expected: Option<u64>, event: Option<&Arc<Signal>>) -> Result<()> {
        let stops = {
            let mut s = self.state.lock().map_err(|_| E::State)?;
            if s.closed || expected.is_some_and(|r| r != s.revision) {
                return Ok(());
            }
            if let Some(signal) = event {
                if !s.signal.as_ref().is_some_and(|x| Arc::ptr_eq(x, signal)) {
                    return Ok(());
                }
                let stamp = signal.snapshot();
                if stamp == s.event_stamp {
                    return Ok(());
                }
                s.event_stamp = stamp;
            }
            s.current = None;
            if let Some(next) = s.revision.checked_add(1) {
                s.revision = next;
            } else {
                s.closed = true;
            }
            self.pool.invalidate()?
        };
        Coordinator::wake(stops);
        Ok(())
    }
}
impl Coordinator {
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub(crate) fn native_qualification_fence(&self) -> Result<Fence> {
        let monitor = self.monitor.lock().map_err(|_| E::State)?;
        if monitor.is_none() {
            return Err(E::PlatformUnverified);
        }
        let s = self.state.lock().map_err(|_| E::State)?;
        if s.closed {
            return Err(E::Cancelled);
        }
        let signal = s.signal.as_ref().ok_or(E::PlatformUnverified)?;
        if s.event_stamp != signal.snapshot() {
            return Err(E::PlatformUnverified);
        }
        #[cfg(target_os = "android")]
        if signal.kinds()
            & (crate::sync::security::network_watch::AVAILABLE
                | crate::sync::security::network_watch::CAPABILITIES
                | crate::sync::security::network_watch::LINK_PROPERTIES)
            != (crate::sync::security::network_watch::AVAILABLE
                | crate::sync::security::network_watch::CAPABILITIES
                | crate::sync::security::network_watch::LINK_PROPERTIES)
        {
            return Err(E::PlatformUnverified);
        }
        signal.fence().ok_or(E::Cancelled)
    }
    // Resource accounting only; native_io_lab enforces OS binding/route policy.
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub(crate) fn admit_native_qualification(
        &self,
        expected: Expected,
        stop: &Arc<Interrupt>,
    ) -> Result<(
        Arc<Pool>,
        Permit,
        crate::sync::security::native_io_lab::NativeTimer,
    )> {
        let fence = self.native_qualification_fence()?;
        let permit = self.pool.admit_observed(
            expected,
            self.clock.elapsed().as_secs(),
            stop,
            Some(fence),
        )?;
        if permit.cancellation().cancelled() {
            return Err(E::Cancelled);
        }
        Ok((
            self.pool.clone(),
            permit,
            crate::sync::security::native_io_lab::NativeTimer::from_origin(self.clock),
        ))
    }

    #[cfg(test)]
    pub(crate) fn poison_notification_fixture(&self) {
        self.pool.poison_notification_fixture();
    }

    pub(super) fn bind_store(
        &self,
        store: &crate::storage::capture_store::CaptureStore,
    ) -> std::result::Result<(), crate::storage::capture_store::StoreError> {
        store.bind_transport(&self.pool)
    }
    /// Explicit loopback qualification only. Does not mint route/LAN evidence.
    /// Uses this owner's real clock, budget and event fence; never a fresh Pool.
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub(crate) fn admit_loopback_lab(
        &self,
        expected: Expected,
        cancel: &Arc<Interrupt>,
    ) -> Result<(
        Arc<Pool>,
        Permit,
        crate::sync::security::native_io_lab::NativeTimer,
    )> {
        let s = self.state.lock().map_err(|_| E::State)?;
        if s.closed || cancel.cancelled() {
            return Err(E::Cancelled);
        }
        let fence = s
            .signal
            .as_ref()
            .map(|signal| signal.fence().ok_or(E::Cancelled))
            .transpose()?;
        let permit =
            self.pool
                .admit_observed(expected, self.clock.elapsed().as_secs(), cancel, fence)?;
        drop(s);
        if permit.cancellation().cancelled() {
            return Err(E::Cancelled);
        }
        Ok((
            self.pool.clone(),
            permit,
            crate::sync::security::native_io_lab::NativeTimer::from_origin(self.clock),
        ))
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub(crate) fn invalidate_loopback_lab(&self) -> Result<()> {
        self.core.invalidate(None, None)
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub(crate) fn loopback_lab_active(&self) -> usize {
        self.pool.active_for_test()
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub(crate) fn loopback_event_fixture(&self) -> Result<Arc<Signal>> {
        let (signal, _) = Signal::channel();
        let mut s = self.state.lock().map_err(|_| E::State)?;
        if s.closed || s.signal.is_some() {
            return Err(E::State);
        }
        s.event_stamp = signal.snapshot();
        s.signal = Some(signal.clone());
        Ok(signal)
    }
    pub(super) fn new(owner: &super::TransportOwner) -> Self {
        Self {
            core: Arc::new(Core {
                state: Mutex::new(State {
                    revision: 0,
                    closed: false,
                    current: None,
                    signal: None,
                    event_stamp: None,
                }),
                pool: Arc::new(Pool::new(owner)),
                clock: Instant::now(),
                owner: Arc::new(()),
            }),
            monitor: Mutex::new(None),
        }
    }
    fn wake(stops: Vec<Arc<Interrupt>>) {
        for stop in stops {
            stop.cancel();
        }
    }
    pub(crate) fn start_monitor(&self) -> std::result::Result<(), route_observer::Unavailable> {
        use route_observer::Unavailable as U;
        let mut slot = self.monitor.lock().map_err(|_| U::Unavailable)?;
        if self.state.lock().map_err(|_| U::Unavailable)?.closed {
            return Err(U::Unavailable);
        }
        if let Some(monitor) = slot.as_ref() {
            return if monitor.signal.snapshot().is_some() {
                Ok(())
            } else {
                Err(U::Unavailable)
            };
        }
        let (signal, rx) = Signal::channel();
        let weak = Arc::downgrade(&self.core);
        let monitor = Monitor::start(signal.clone(), rx, move |event| {
            if let Some(core) = weak.upgrade() {
                if core.invalidate(None, Some(event)).is_err() {
                    event.failed(1);
                    let _ = core.pool.shutdown();
                }
            }
        });
        let monitor = match monitor {
            Ok(m) => m,
            Err(e) => {
                drop(slot);
                let _ = self.core.invalidate(None, None);
                return Err(e);
            }
        };
        let mut s = match self.state.lock() {
            Ok(s) => s,
            Err(e) => {
                drop(e.into_inner());
                drop(slot);
                drop(monitor); // join only after releasing both locks
                let _ = self.shutdown();
                return Err(U::Unavailable);
            }
        };
        if s.closed {
            drop(s);
            drop(slot);
            drop(monitor);
            return Err(U::Unavailable);
        }
        s.signal = Some(signal.clone());
        s.event_stamp = signal.snapshot();
        drop(s);
        *slot = Some(monitor);
        drop(slot);
        self.core.invalidate(None, None).map_err(|_| U::Unavailable)
    }
    pub(crate) fn stop_monitor(&self) -> Result<()> {
        let (mut slot, control_poisoned) = match self.monitor.lock() {
            Ok(s) => (s, false),
            Err(e) => (e.into_inner(), true),
        };
        let monitor = slot.take();
        let (signal, state_poisoned) = {
            let (mut s, poisoned) = match self.state.lock() {
                Ok(s) => (s, false),
                Err(e) => (e.into_inner(), true),
            };
            if poisoned || control_poisoned {
                s.closed = true;
                s.current = None;
            }
            s.event_stamp = None;
            (s.signal.take(), poisoned)
        };
        if let Some(signal) = signal {
            signal.close();
        }
        drop(slot);
        let invalidated = if state_poisoned || control_poisoned {
            self.pool.shutdown()
        } else {
            self.core.invalidate(None, None)
        };
        if let Some(mut monitor) = monitor {
            if monitor.stop().is_err() {
                let _ = self.shutdown();
                return Err(if state_poisoned || control_poisoned {
                    E::State
                } else {
                    E::PlatformUnverified
                });
            }
        }
        if state_poisoned || control_poisoned {
            return Err(E::State);
        }
        invalidated?;
        Ok(())
    }
    pub(crate) fn begin(&self, hint: Hint) -> Result<Ticket> {
        let (ticket, stops) = {
            let mut s = self.state.lock().map_err(|_| E::State)?;
            if s.closed {
                return Err(E::Cancelled);
            }
            s.current = None;
            let next = s.revision.checked_add(1);
            let stops = self.pool.invalidate()?;
            let Some(next) = next else {
                s.closed = true;
                drop(s);
                Self::wake(stops);
                return Err(E::Limit);
            };
            s.revision = next;
            let fence = s.signal.as_ref().and_then(|x| x.fence());
            s.event_stamp = s.signal.as_ref().and_then(|x| x.snapshot());
            (
                Ticket {
                    owner: self.owner.clone(),
                    revision: next,
                    hint,
                    captured: self.clock.elapsed().as_secs(),
                    started: Instant::now(),
                    fence,
                },
                stops,
            )
        };
        Self::wake(stops);
        Ok(ticket)
    }
    fn finish_observation(
        &self,
        ticket: Ticket,
        observed: Result<Observation>,
        native: bool,
    ) -> Result<Selection> {
        let mut s = self.state.lock().map_err(|_| E::State)?;
        if !Arc::ptr_eq(&self.owner, &ticket.owner)
            || s.closed
            || s.revision != ticket.revision
            || ticket.fence.as_ref().is_some_and(|f| !f.valid())
        {
            return Err(E::Cancelled);
        }
        if native && ticket.fence.is_none() {
            return Err(E::PlatformUnverified);
        }
        if ticket.started.elapsed() > std::time::Duration::from_secs(3) {
            return Err(E::Expired);
        }
        let mut o = observed?;
        o.captured = ticket.captured;
        o.generation = ticket.revision;
        let candidate = Candidate::evaluate(&ticket.hint, &o, self.clock.elapsed().as_secs())?;
        s.current = Some((ticket.hint.clone(), o));
        Ok(Selection {
            candidate,
            owner: self.owner.clone(),
            hint: ticket.hint,
            revision: ticket.revision,
            fence: ticket.fence,
            native,
        })
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    fn complete_fixture(&self, ticket: Ticket, observed: Result<Observation>) -> Result<Selection> {
        self.finish_observation(ticket, observed, false)
    }
    pub(crate) fn observe(&self, hint: Hint) -> Result<Selection> {
        let ticket = self.begin(hint)?;
        if ticket.fence.is_none() {
            return Err(E::PlatformUnverified);
        }
        let endpoint = match ticket.hint.address {
            Address::Numeric(a) => a,
            _ => return Err(E::N7PolicyPending),
        };
        let observed = route_observer::acquire_native(endpoint)
            .map(|n| n.into_facts())
            .map_err(|_| E::N7PolicyPending);
        self.finish_observation(ticket, observed, true)
    }
    pub(crate) fn admit(
        &self,
        selection: &Selection,
        expected: Expected,
        cancel: &Arc<Interrupt>,
    ) -> Result<Permit> {
        if !selection.native {
            return Err(E::PlatformUnverified);
        }
        self.admit_fresh(selection, expected, cancel, true, |endpoint| {
            route_observer::acquire_native(endpoint)
                .map(|x| x.into_facts())
                .map_err(|_| E::N7PolicyPending)
        })
    }
    /// Reacquire native route facts after connect; endpoint addresses alone
    /// never authorize a route. No permit is created or budget refunded here.
    pub(crate) fn verify_connected(
        &self,
        selection: &Selection,
        endpoints: &crate::sync::security::connected_endpoint::ConnectedEndpoints,
        cancel: &Arc<Interrupt>,
    ) -> Result<()> {
        let check = || -> Result<()> {
            let s = self.state.lock().map_err(|_| E::State)?;
            if s.closed || cancel.cancelled() || selection.fence.as_ref().is_none_or(|f| !f.valid())
            {
                return Err(E::Cancelled);
            }
            if !Arc::ptr_eq(&selection.owner, &self.owner)
                || s.revision != selection.revision
                || s.current.is_none()
            {
                return Err(E::Trust);
            }
            if !selection.native
                || !selection
                    .fence
                    .as_ref()
                    .is_some_and(|f| s.signal.as_ref().is_some_and(|x| f.same_registration(x)))
            {
                return Err(E::PlatformUnverified);
            }
            Ok(())
        };
        check()?;
        let endpoint = match selection.hint.address {
            Address::Numeric(a) => a,
            _ => return Err(E::N7PolicyPending),
        };
        let started = Instant::now();
        let captured = self.clock.elapsed().as_secs();
        let mut current = route_observer::acquire_native(endpoint)
            .map_err(|_| E::N7PolicyPending)?
            .into_facts();
        if started.elapsed() > std::time::Duration::from_secs(3) {
            return Err(E::Expired);
        }
        current.generation = selection.revision;
        current.captured = captured;
        let result =
            selection
                .candidate
                .connected(&current, endpoints, self.clock.elapsed().as_secs());
        check()?;
        result // Present evidence has no native interface binding: remains Pending.
    }
    fn admit_fresh(
        &self,
        selection: &Selection,
        expected: Expected,
        cancel: &Arc<Interrupt>,
        native: bool,
        read: impl FnOnce(std::net::SocketAddr) -> Result<Observation>,
    ) -> Result<Permit> {
        let revision = {
            let s = self.state.lock().map_err(|_| E::State)?;
            if s.closed || cancel.cancelled() {
                return Err(E::Cancelled);
            }
            if !Arc::ptr_eq(&selection.owner, &self.owner)
                || selection.revision != s.revision
                || s.current.is_none()
            {
                return Err(E::Trust);
            }
            if native && (!selection.native || selection.fence.is_none()) {
                return Err(E::PlatformUnverified);
            }
            if selection.fence.as_ref().is_some_and(|f| {
                !f.valid() || !s.signal.as_ref().is_some_and(|x| f.same_registration(x))
            }) {
                return Err(E::Cancelled);
            }
            s.revision
        };
        let endpoint = match selection.hint.address {
            Address::Numeric(a) => a,
            _ => return Err(E::N7PolicyPending),
        };
        let started = Instant::now();
        let captured = self.clock.elapsed().as_secs();
        let mut refreshed = false;
        let result = (|| {
            let mut current = read(endpoint)?; // OS read is OUTSIDE coordinator/pool locks
            if started.elapsed() > std::time::Duration::from_secs(3) {
                return Err(E::Expired);
            }
            current.generation = revision;
            current.captured = captured;
            selection
                .candidate
                .revalidate(&current, self.clock.elapsed().as_secs())?;
            refreshed = true;
            let s = self.state.lock().map_err(|_| E::State)?;
            if s.closed
                || s.revision != revision
                || s.current.is_none()
                || cancel.cancelled()
                || selection.fence.as_ref().is_some_and(|f| !f.valid())
            {
                return Err(E::Cancelled);
            }
            let permit = self.pool.admit_observed(
                expected,
                self.clock.elapsed().as_secs(),
                cancel,
                selection.fence.clone(),
            );
            drop(s); // permit/waker teardown must never run under the owner lock
            let permit = permit?;
            let valid = !cancel.cancelled() && selection.fence.as_ref().is_none_or(|f| f.valid());
            if !valid {
                drop(permit);
                return Err(E::Cancelled);
            }
            Ok(permit)
        })();
        if result.is_err() && !refreshed {
            let _ = self.core.invalidate(Some(revision), None);
        }
        result
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    fn admit_fixture(&self, s: &Selection, e: Expected, c: &Arc<Interrupt>) -> Result<Permit> {
        let o = {
            self.state
                .lock()
                .map_err(|_| E::State)?
                .current
                .as_ref()
                .ok_or(E::State)?
                .1
                .clone()
        };
        self.admit_fresh(s, e, c, false, |_| Ok(o))
    }
    pub(crate) fn shutdown(&self) -> Result<()> {
        let poisoned = {
            let (mut s, p) = match self.state.lock() {
                Ok(s) => (s, false),
                Err(e) => (e.into_inner(), true),
            };
            s.closed = true;
            s.current = None;
            if let Some(signal) = s.signal.take() {
                signal.close();
            }
            p
        };
        let pool = self.pool.shutdown();
        let (monitor, monitor_poisoned) = match self.monitor.lock() {
            Ok(mut s) => (s.take(), false),
            Err(e) => (e.into_inner().take(), true),
        };
        let stopped = if let Some(mut m) = monitor {
            m.stop().map_err(|_| E::PlatformUnverified)
        } else {
            Ok(())
        };
        if poisoned || monitor_poisoned {
            return Err(E::State);
        }
        pool?;
        stopped
    }
}
impl Drop for Coordinator {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
mod qualification {
    use super::*;
    use crate::sync::security::route_candidate::*;
    use uuid::Uuid;
    fn hint() -> Hint {
        Hint::parse("192.168.1.3:7431", Origin::Manual).unwrap()
    }
    fn observed() -> Observation {
        Observation {
            generation: 99,
            captured: 99,
            interface: 3,
            network: 7,
            medium: Medium::Wifi,
            link: Link::Up,
            local: "192.168.1.2".parse().unwrap(),
            source_selected: true,
            local_prefix: 24,
            route_interface: 3,
            destination: "192.168.1.0".parse().unwrap(),
            route_prefix: 24,
            next_hop: NextHop::Direct,
            endpoint: "192.168.1.3:7431".parse().unwrap(),
            platform: Platform::WindowsPrivateProfileObserved,
        }
    }
    fn coordinator() -> Coordinator {
        Coordinator::new(&super::super::TransportOwner(()))
    }
    fn expected() -> Expected {
        Expected {
            network: Uuid::new_v4(),
            peer: Uuid::new_v4(),
        }
    }
    fn select(c: &Coordinator) -> Selection {
        c.complete_fixture(c.begin(hint()).unwrap(), Ok(observed()))
            .unwrap()
    }
    #[cfg_attr(test, test)]
    fn n7b_generations_reordered_completion_and_cross_owner() {
        let c = coordinator();
        let other = coordinator();
        let stale = c.begin(hint()).unwrap();
        let current = select(&c);
        assert!(matches!(
            c.complete_fixture(stale, Ok(observed())),
            Err(E::Cancelled)
        ));
        let stop = Arc::new(Interrupt::default());
        let permit = c.admit_fixture(&current, expected(), &stop).unwrap();
        assert!(other.admit_fixture(&current, expected(), &stop).is_err());
        let foreign = other.begin(hint()).unwrap();
        assert!(matches!(
            c.complete_fixture(foreign, Ok(observed())),
            Err(E::Cancelled)
        ));
        let pending = c.begin(hint()).unwrap();
        assert!(permit.establish(c.clock.elapsed().as_secs()).is_err());
        assert!(c.admit_fixture(&current, expected(), &stop).is_err());
        assert!(c
            .complete_fixture(pending, Err(E::N7PolicyPending))
            .is_err());
        assert!(c.admit_fixture(&current, expected(), &stop).is_err());
        c.shutdown().unwrap();
        c.shutdown().unwrap();
        assert!(c.begin(hint()).is_err());
        let c = coordinator();
        let ticket = c.begin(hint()).unwrap();
        c.shutdown().unwrap();
        assert!(c.complete_fixture(ticket, Ok(observed())).is_err());
        let c = coordinator();
        let selected = select(&c);
        let permit = c
            .admit_fixture(&selected, expected(), &Arc::default())
            .unwrap();
        c.state.lock().unwrap().revision = u64::MAX;
        assert!(c.begin(hint()).is_err());
        assert!(permit.establish(c.clock.elapsed().as_secs()).is_err());
        let c = coordinator();
        let selected = select(&c);
        let permit = c
            .admit_fixture(&selected, expected(), &Arc::default())
            .unwrap();
        drop(c);
        assert!(permit.establish(0).is_err());
        let c = coordinator();
        let selected = select(&c);
        let permit = c
            .admit_fixture(&selected, expected(), &Arc::default())
            .unwrap();
        let _ = std::panic::catch_unwind(|| {
            let _held = c.state.lock().unwrap();
            panic!("qualification poison");
        });
        assert_eq!(c.shutdown(), Err(E::State));
        assert!(permit.establish(0).is_err());
    }
    #[cfg_attr(test, test)]
    fn n7b_changed_network_permission_endpoint_and_route_refuse() {
        for mode in 0..11 {
            let c = coordinator();
            let old = select(&c);
            let ticket = c.begin(hint()).unwrap();
            let mut o = observed();
            match mode {
                0 => o.network += 1,
                1 => o.interface += 1,
                2 => o.local = "192.168.1.9".parse().unwrap(),
                3 => o.platform = Platform::PermissionRevoked,
                4 => o.medium = Medium::Vpn,
                5 => o.medium = Medium::Cellular,
                6 => o.destination = "192.168.2.0".parse().unwrap(),
                7 => o.local = "fd00::1".parse().unwrap(),
                8 => o.endpoint = "192.168.1.4:7431".parse().unwrap(),
                9 => o.link = Link::Down,
                _ => o.platform = Platform::Unknown,
            }
            let _ = c.complete_fixture(ticket, Ok(o));
            assert!(c.admit_fixture(&old, expected(), &Arc::default()).is_err());
        }
        let c = coordinator();
        assert!(c
            .observe(Hint::parse("desktop.local:7431", Origin::Manual).unwrap())
            .is_err());
    }
    #[cfg_attr(test, test)]
    fn n7b_cancelled_admissions_no_refund_shared_limits_and_shutdown_race() {
        let c = coordinator();
        let selection = select(&c);
        for _ in 0..8 {
            let stop = Arc::new(Interrupt::default());
            stop.cancel();
            assert!(c.admit_fixture(&selection, expected(), &stop).is_err());
        }
        let barrier = std::sync::Barrier::new(8);
        std::thread::scope(|scope| {
            let workers: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        c.admit_fixture(&selection, expected(), &Arc::default())
                    })
                })
                .collect();
            let permits: Vec<_> = workers
                .into_iter()
                .filter_map(|w| w.join().unwrap().ok())
                .collect();
            assert_eq!(permits.len(), 2);
            c.shutdown().unwrap();
            for p in permits {
                assert!(p.establish(c.clock.elapsed().as_secs()).is_err());
            }
        });
        for _ in 0..32 {
            let c = coordinator();
            let s = select(&c);
            let barrier = std::sync::Barrier::new(2);
            std::thread::scope(|scope| {
                let worker = scope.spawn(|| {
                    barrier.wait();
                    c.admit_fixture(&s, expected(), &Arc::default())
                });
                barrier.wait();
                c.shutdown().unwrap();
                if let Ok(p) = worker.join().unwrap() {
                    assert!(p.establish(c.clock.elapsed().as_secs()).is_err());
                }
            });
        }
    }
    #[cfg_attr(test, test)]
    fn n7c_synthetic_selection_cannot_admit_via_production_path() {
        let c = coordinator();
        let selected = select(&c);
        assert!(
            c.admit(&selected, expected(), &Arc::default()).is_err(),
            "synthetic cached snapshot bypassed fresh native admission"
        );
    }
    #[cfg_attr(test, test)]
    fn n7c_fresh_exact_read_failure_and_fact_changes_clear_old_selection() {
        for mode in 0..12 {
            let c = coordinator();
            let s = select(&c);
            let result = c.admit_fresh(&s, expected(), &Arc::default(), false, |endpoint| {
                assert_eq!(endpoint, observed().endpoint);
                assert!(c.state.try_lock().is_ok()); // OS acquisition never owns coordinator lock
                let mut o = observed();
                match mode {
                    0 => return Err(E::PlatformUnverified),
                    1 => o.network += 1,
                    2 => o.interface += 1,
                    3 => o.source_selected = false,
                    4 => o.local = "192.168.1.9".parse().unwrap(),
                    5 => o.next_hop = NextHop::Gateway("192.168.1.1".parse().unwrap()),
                    6 => o.platform = Platform::WindowsOtherProfileObserved(0),
                    7 => o.platform = Platform::PermissionRevoked,
                    8 => o.medium = Medium::Vpn,
                    9 => o.route_prefix = 0,
                    10 => o.link = Link::Down,
                    _ => o.endpoint = "192.168.1.4:7431".parse().unwrap(),
                }
                Ok(o)
            });
            assert!(result.is_err());
            assert!(c.state.lock().unwrap().current.is_none());
            assert!(c.admit_fixture(&s, expected(), &Arc::default()).is_err());
        }
    }
    #[cfg_attr(test, test)]
    fn n7c_refresh_races_cancellation_replacement_shutdown_and_event() {
        for mode in 0..4 {
            let c = coordinator();
            let (signal, _) = Signal::channel();
            c.state.lock().unwrap().signal = Some(signal.clone());
            let s = select(&c);
            let cancel = Arc::new(Interrupt::default());
            let result = c.admit_fresh(&s, expected(), &cancel, false, |_| {
                match mode {
                    0 => cancel.cancel(),
                    1 => {
                        let _ = select(&c);
                    }
                    2 => c.shutdown().unwrap(),
                    _ => {
                        signal.notify(crate::sync::security::network_watch::PROFILE);
                    }
                }
                Ok(observed())
            });
            assert!(result.is_err());
        }
    }
    #[cfg_attr(test, test)]
    fn n7c_events_cancel_permits_before_dispatch_and_stale_registration_cannot_restore() {
        let c = coordinator();
        let (signal, _) = Signal::channel();
        c.state.lock().unwrap().signal = Some(signal.clone());
        let s = select(&c);
        let p = c.admit_fixture(&s, expected(), &Arc::default()).unwrap();
        signal.notify(crate::sync::security::network_watch::ROUTE);
        assert!(p.establish(0).is_err());
        assert!(c.admit_fixture(&s, expected(), &Arc::default()).is_err());
        c.core.invalidate(None, Some(&signal)).unwrap();
        let fresh = select(&c);
        let (old, _) = Signal::channel();
        old.notify(crate::sync::security::network_watch::PROFILE);
        c.core.invalidate(None, Some(&old)).unwrap();
        assert!(c.admit_fixture(&fresh, expected(), &Arc::default()).is_ok());
        // Two reservations above plus two more exhaust the four-attempt window.
        for _ in 0..2 {
            let s = select(&c);
            let p = c.admit_fixture(&s, expected(), &Arc::default()).unwrap();
            drop(p);
        }
        let s = select(&c);
        assert!(matches!(
            c.admit_fixture(&s, expected(), &Arc::default()),
            Err(E::Limit)
        ));
    }
    pub(crate) fn run() -> Result<()> {
        std::panic::catch_unwind(|| {
            n7b_generations_reordered_completion_and_cross_owner();
            n7b_changed_network_permission_endpoint_and_route_refuse();
            n7b_cancelled_admissions_no_refund_shared_limits_and_shutdown_race();
            n7c_synthetic_selection_cannot_admit_via_production_path();
            n7c_fresh_exact_read_failure_and_fact_changes_clear_old_selection();
            n7c_refresh_races_cancellation_replacement_shutdown_and_event();
            n7c_events_cancel_permits_before_dispatch_and_stale_registration_cannot_restore();
            n7d_actual_pending_socket_observes_owner_generation_event_and_shutdown();
        })
        .map_err(|_| E::State)
    }
    #[cfg_attr(test, test)]
    fn n7d_actual_pending_socket_observes_owner_generation_event_and_shutdown() {
        use crate::sync::security::native_io_lab::{self as lab, Fault, NativeTimer};
        use tokio::io::AsyncReadExt;
        lab::execute(async {
            for mode in 0..3 {
                let c = coordinator();
                let (signal, _) = Signal::channel();
                c.state.lock().unwrap().signal = Some(signal.clone());
                let selection = select(&c);
                let permit = c
                    .admit_fixture(&selection, expected(), &Arc::default())
                    .unwrap();
                let (mut raw, mut peer, _) = lab::pair(permit, NativeTimer::from_origin(c.clock))
                    .await
                    .unwrap();
                let (tx, rx) = tokio::sync::oneshot::channel();
                let mut tx = Some(tx);
                let mut byte = [0];
                let read = std::future::poll_fn(|cx| {
                    let result = raw.poll_read(cx, &mut byte);
                    if result.is_pending() {
                        if let Some(tx) = tx.take() {
                            let _ = tx.send(());
                        }
                    }
                    result
                });
                let (result, ()) = lab::both(read, async {
                    rx.await.unwrap();
                    match mode {
                        0 => {
                            let _ = c.begin(hint()).unwrap();
                        }
                        1 => {
                            signal.notify(crate::sync::security::network_watch::PROFILE);
                            c.core.invalidate(None, Some(&signal)).unwrap();
                        }
                        _ => {
                            signal.notify(crate::sync::security::network_watch::ROUTE);
                            c.shutdown().unwrap();
                            c.core.invalidate(None, Some(&signal)).unwrap();
                        }
                    }
                })
                .await;
                assert_eq!(result, Err(Fault::Cancelled));
                assert_eq!(peer.read(&mut [0; 1]).await.unwrap(), 0);
                assert!(c
                    .admit_fixture(&selection, expected(), &Arc::default())
                    .is_err());
                c.shutdown().unwrap();
            }
        });
    }
    #[cfg(windows)]
    #[test]
    fn n7c_actual_explicit_monitor_restart_and_final_drop() {
        let c = coordinator();
        assert!(c.monitor.lock().unwrap().is_none());
        c.start_monitor().unwrap();
        c.start_monitor().unwrap();
        let first = c.state.lock().unwrap().signal.clone().unwrap();
        // A terminal registration (e.g. overflow/failure) must not report a
        // successful idempotent start merely because its handle is retained.
        first.close();
        assert_eq!(
            c.start_monitor(),
            Err(route_observer::Unavailable::Unavailable)
        );
        c.stop_monitor().unwrap();
        c.stop_monitor().unwrap();
        assert!(first.snapshot().is_none());
        c.start_monitor().unwrap();
        let second = c.state.lock().unwrap().signal.clone().unwrap();
        assert!(!Arc::ptr_eq(&first, &second));
        assert!(!first.notify(crate::sync::security::network_watch::PROFILE));
        let weak = Arc::downgrade(&second);
        drop(second);
        drop(c);
        assert!(weak.upgrade().is_none());
        let c = coordinator();
        c.start_monitor().unwrap();
        let weak = Arc::downgrade(c.state.lock().unwrap().signal.as_ref().unwrap());
        let _ = std::panic::catch_unwind(|| {
            let _held = c.state.lock().unwrap();
            panic!("qualification monitor poison");
        });
        assert_eq!(c.stop_monitor(), Err(E::State));
        assert!(weak.upgrade().is_none());
        assert!(c.start_monitor().is_err());
    }
}
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) use qualification::run as qualify;
