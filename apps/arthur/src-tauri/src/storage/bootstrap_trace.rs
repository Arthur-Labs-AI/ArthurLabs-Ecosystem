//! Bounded numeric capture diagnostics. Never retain row/core/key contents.
use crate::sync_api::{Error, Result};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub(super) struct Report {
    pub phase: &'static str,
    pub events: usize,
    pub rows: usize,
    pub raw_bytes: usize,
    pub image_bytes: usize,
    pub elapsed_ms: u128,
    pub failure: Option<Error>,
    pub watchdog: bool,
    pub phases: Vec<(&'static str, u128)>,
}
pub(super) struct Capture {
    start: Instant,
    budget: Instant,
    pub report: Report,
}
impl Capture {
    pub fn new() -> Self {
        Self {
            start: Instant::now(),
            budget: Instant::now(),
            report: Report {
                phase: "admission",
                events: 0,
                rows: 0,
                raw_bytes: 0,
                image_bytes: 0,
                elapsed_ms: 0,
                failure: None,
                watchdog: false,
                phases: Vec::new(),
            },
        }
    }
    pub fn from_start(start: Instant) -> Self {
        let mut trace = Self::new();
        trace.start = start;
        trace.budget = start;
        trace
    }
    pub fn phase(&mut self, phase: &'static str) -> Result<()> {
        if self.report.phases.len() < 16 {
            self.report
                .phases
                .push((self.report.phase, self.start.elapsed().as_millis()));
        }
        self.report.phase = phase;
        self.check()
    }
    pub fn restart_budget(&mut self) {
        self.budget = Instant::now();
    }
    pub fn check(&mut self) -> Result<()> {
        #[cfg(test)]
        let forced = FORCED.with(|p| p.get() == Some(self.report.phase));
        #[cfg(not(test))]
        let forced = false;
        if forced || self.budget.elapsed() > Duration::from_secs(5) {
            self.report.watchdog = true;
            return Err(Error::SnapshotTooLarge);
        }
        Ok(())
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.report.elapsed_ms = self.start.elapsed().as_millis();
        #[cfg(test)]
        {
            if self.report.failure.is_some()
                || std::thread::panicking()
                || std::env::var_os("ARTHUR_R9_CAPTURE_DIAGNOSTICS").is_some()
            {
                // Format in memory once: field-by-field unbuffered stderr
                // writes must not dominate the measured capture on Windows.
                let line = format!("R9 capture {:?}", self.report);
                eprintln!("{line}");
            }
            LAST.with(|r| *r.borrow_mut() = Some(self.report.clone()));
        }
    }
}
#[cfg(test)]
thread_local! {
    static LAST: std::cell::RefCell<Option<Report>> = const { std::cell::RefCell::new(None) };
    static FORCED: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) };
}
#[cfg(test)]
pub(super) fn last() -> Option<Report> {
    LAST.with(|r| r.borrow().clone())
}
#[cfg(test)]
pub(super) fn with_expired<T>(phase: &'static str, work: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            FORCED.with(|p| p.set(None));
        }
    }
    FORCED.with(|p| p.set(Some(phase)));
    let _reset = Reset;
    work()
}
