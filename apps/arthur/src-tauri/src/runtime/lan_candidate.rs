//! One dormant candidate coordinator per existing storage runtime. No worker/task/I/O startup.
use crate::sync::security::{
    route_candidate::{Address, Candidate, Hint, Observation},
    route_observer,
    transport_candidate::{Expected, Interrupt, Permit, Pool},
    Result, SecurityError as E,
};
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

pub(crate) struct Coordinator {
    state: Mutex<State>,
    pool: Arc<Pool>,
    clock: Instant,
    owner: Arc<()>,
}
struct State {
    revision: u64,
    closed: bool,
    current: Option<(Hint, Observation)>,
}
pub(crate) struct Selection {
    candidate: Candidate,
    owner: Arc<()>,
}
pub(crate) struct Ticket {
    owner: Arc<()>,
    revision: u64,
    hint: Hint,
    captured: u64,
}
impl Coordinator {
    pub(super) fn new(owner: &super::TransportOwner) -> Self {
        Self {
            state: Mutex::new(State {
                revision: 0,
                closed: false,
                current: None,
            }),
            pool: Arc::new(Pool::new(owner)),
            clock: Instant::now(),
            owner: Arc::new(()),
        }
    }
    fn wake(stops: Vec<Arc<Interrupt>>) {
        for stop in stops {
            stop.cancel();
        }
    }
    /// Also the explicit loss/permission/profile notification seam. Invalidates
    /// before acquisition, including failed reads. A stale completion is refused.
    pub(crate) fn begin(&self, hint: Hint) -> Result<Ticket> {
        let (ticket, stops) = {
            let mut s = self.state.lock().map_err(|_| E::State)?;
            if s.closed {
                return Err(E::Cancelled);
            }
            s.current = None;
            let revision = s.revision.checked_add(1);
            let stops = self.pool.invalidate()?; // sets flags; no executor callbacks
            let Some(revision) = revision else {
                s.closed = true;
                drop(s);
                Self::wake(stops);
                return Err(E::Limit);
            };
            s.revision = revision;
            (
                Ticket {
                    owner: self.owner.clone(),
                    revision: s.revision,
                    hint,
                    captured: self.clock.elapsed().as_secs(),
                },
                stops,
            )
        };
        Self::wake(stops); // never call an executor while holding owner locks
        Ok(ticket)
    }
    pub(crate) fn complete(
        &self,
        ticket: Ticket,
        observed: Result<Observation>,
    ) -> Result<Selection> {
        let mut s = self.state.lock().map_err(|_| E::State)?;
        if !Arc::ptr_eq(&self.owner, &ticket.owner) || s.closed || s.revision != ticket.revision {
            return Err(E::Cancelled);
        }
        let mut o = observed?;
        // Clock/generation originate here, never in a caller or platform callback.
        o.captured = ticket.captured;
        o.generation = ticket.revision;
        let candidate = Candidate::evaluate(&ticket.hint, &o, self.clock.elapsed().as_secs())?;
        s.current = Some((ticket.hint, o));
        Ok(Selection {
            candidate,
            owner: self.owner.clone(),
        })
    }
    pub(crate) fn observe(&self, hint: Hint) -> Result<Selection> {
        let ticket = self.begin(hint)?;
        let observed = match ticket.hint.address {
            Address::Numeric(endpoint) => {
                route_observer::acquire(endpoint).map_err(|_| E::N7PolicyPending)
            }
            Address::Dns(..) => Err(E::N7PolicyPending),
        };
        self.complete(ticket, observed)
    }
    /// Must be repeated with a fresh native observation before an eventual
    /// connection/disclosure. This admits budget candidates ONLY, never trust.
    pub(crate) fn admit(
        &self,
        candidate: &Selection,
        expected: Expected,
        cancel: &Arc<Interrupt>,
    ) -> Result<Permit> {
        let s = self.state.lock().map_err(|_| E::State)?;
        if s.closed {
            return Err(E::Cancelled);
        }
        let (_, o) = s.current.as_ref().ok_or(E::N7PolicyPending)?;
        let now = self.clock.elapsed().as_secs();
        if !Arc::ptr_eq(&self.owner, &candidate.owner) {
            return Err(E::Trust);
        }
        candidate.candidate.revalidate(o, now)?;
        self.pool.admit_cancellable(expected, now, cancel)
    }
    pub(crate) fn shutdown(&self) -> Result<()> {
        let poisoned = {
            let (mut s, poisoned) = match self.state.lock() {
                Ok(s) => (s, false),
                Err(e) => (e.into_inner(), true),
            };
            s.closed = true;
            s.current = None;
            poisoned
        };
        self.pool.shutdown()?;
        if poisoned {
            Err(E::State)
        } else {
            Ok(())
        }
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
        c.complete(c.begin(hint()).unwrap(), Ok(observed()))
            .unwrap()
    }
    #[cfg_attr(test, test)]
    fn n7b_generations_reordered_completion_and_cross_owner() {
        let c = coordinator();
        let other = coordinator();
        let stale = c.begin(hint()).unwrap();
        let current = select(&c);
        assert!(matches!(
            c.complete(stale, Ok(observed())),
            Err(E::Cancelled)
        ));
        let stop = Arc::new(Interrupt::default());
        let permit = c.admit(&current, expected(), &stop).unwrap();
        assert!(other.admit(&current, expected(), &stop).is_err());
        let foreign = other.begin(hint()).unwrap();
        assert!(matches!(
            c.complete(foreign, Ok(observed())),
            Err(E::Cancelled)
        ));
        let pending = c.begin(hint()).unwrap();
        assert!(permit.establish(c.clock.elapsed().as_secs()).is_err());
        assert!(c.admit(&current, expected(), &stop).is_err());
        assert!(c.complete(pending, Err(E::N7PolicyPending)).is_err());
        assert!(c.admit(&current, expected(), &stop).is_err());
        c.shutdown().unwrap();
        c.shutdown().unwrap();
        assert!(c.begin(hint()).is_err());
        let c = coordinator();
        let ticket = c.begin(hint()).unwrap();
        c.shutdown().unwrap();
        assert!(c.complete(ticket, Ok(observed())).is_err());
        let c = coordinator();
        let selected = select(&c);
        let permit = c.admit(&selected, expected(), &Arc::default()).unwrap();
        c.state.lock().unwrap().revision = u64::MAX;
        assert!(c.begin(hint()).is_err());
        assert!(permit.establish(c.clock.elapsed().as_secs()).is_err());
        let c = coordinator();
        let selected = select(&c);
        let permit = c.admit(&selected, expected(), &Arc::default()).unwrap();
        drop(c);
        assert!(permit.establish(0).is_err());
        let c = coordinator();
        let selected = select(&c);
        let permit = c.admit(&selected, expected(), &Arc::default()).unwrap();
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
            let _ = c.complete(ticket, Ok(o));
            assert!(c.admit(&old, expected(), &Arc::default()).is_err());
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
            assert!(c.admit(&selection, expected(), &stop).is_err());
        }
        let barrier = std::sync::Barrier::new(8);
        std::thread::scope(|scope| {
            let workers: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        c.admit(&selection, expected(), &Arc::default())
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
                    c.admit(&s, expected(), &Arc::default())
                });
                barrier.wait();
                c.shutdown().unwrap();
                if let Ok(p) = worker.join().unwrap() {
                    assert!(p.establish(c.clock.elapsed().as_secs()).is_err());
                }
            });
        }
    }
    pub(crate) fn run() -> Result<()> {
        std::panic::catch_unwind(|| {
            n7b_generations_reordered_completion_and_cross_owner();
            n7b_changed_network_permission_endpoint_and_route_refuse();
            n7b_cancelled_admissions_no_refund_shared_limits_and_shutdown_race();
        })
        .map_err(|_| E::State)
    }
}
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) use qualification::run as qualify;
