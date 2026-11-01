//! Reliability around one POST: bounded concurrency, explicit timeouts, bounded retries with backoff for TRANSPORT failures only,
//! cancellation, per-capture and per-day request budgets, and redacted accounting.
//!
//! A model answer is never a reason to retry: a validation failure, an unexpected model or a disagreeing vote is final.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::Semaphore;

use super::transport::{JevTransport, RawResponse, TransportError};
use super::{JevError, PRICE_PER_INPUT_TOKEN_USD};
use crate::providers::credentials::ApiKey;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Total attempts per request (first try included).
    pub max_attempts: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay: Duration::from_millis(500),
            max_delay: Duration::from_secs(5),
        }
    }
}

/// Request counts and token usage, nothing else: no text, no payload, no header, no key, no request id.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Diagnostics {
    pub requests: u64,
    pub retries: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Answers that carried no usable usage block (their input tokens are estimated from the request size, 4 characters per token).
    pub usage_missing: u64,
    pub estimated_cost_usd: f64,
    pub failures: BTreeMap<&'static str, u64>,
    pub last_latency_ms: Option<u64>,
}

#[derive(Default)]
pub(super) struct Meter {
    requests: AtomicU64,
    retries: AtomicU64,
    input_tokens: AtomicU64,
    output_tokens: AtomicU64,
    usage_missing: AtomicU64,
    last_latency_ms: AtomicU64,
    failures: Mutex<BTreeMap<&'static str, u64>>,
    day: Mutex<(u64, u64)>,
}

impl Meter {
    pub(super) fn fail(&self, code: &'static str) {
        *self
            .failures
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(code)
            .or_insert(0) += 1;
    }

    pub(super) fn usage(&self, input: Option<u64>, output: Option<u64>, estimated_input: u64) {
        match input {
            Some(tokens) => {
                self.input_tokens.fetch_add(tokens, Ordering::Relaxed);
                self.output_tokens
                    .fetch_add(output.unwrap_or(0), Ordering::Relaxed);
            }
            None => {
                self.usage_missing.fetch_add(1, Ordering::Relaxed);
                self.input_tokens
                    .fetch_add(estimated_input, Ordering::Relaxed);
            }
        }
    }

    fn snapshot(&self) -> Diagnostics {
        let input_tokens = self.input_tokens.load(Ordering::Relaxed);
        let last = self.last_latency_ms.load(Ordering::Relaxed);
        Diagnostics {
            requests: self.requests.load(Ordering::Relaxed),
            retries: self.retries.load(Ordering::Relaxed),
            input_tokens,
            output_tokens: self.output_tokens.load(Ordering::Relaxed),
            usage_missing: self.usage_missing.load(Ordering::Relaxed),
            estimated_cost_usd: input_tokens as f64 * PRICE_PER_INPUT_TOKEN_USD,
            failures: self
                .failures
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone(),
            last_latency_ms: (last != u64::MAX).then_some(last),
        }
    }

    /// Counts one request against the rolling UTC-day cap; `false` when the cap is reached.
    fn take_daily(&self, cap: u64) -> bool {
        let today = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() / 86_400)
            .unwrap_or(0);
        let mut day = self.day.lock().unwrap_or_else(|p| p.into_inner());
        if day.0 != today {
            *day = (today, 0);
        }
        if day.1 >= cap {
            return false;
        }
        day.1 += 1;
        true
    }
}

/// Requests one capture may spend (retries included). Shared by every claim of that capture.
pub struct Budget {
    remaining: AtomicU64,
}

impl Budget {
    pub fn new(requests: u64) -> Self {
        Self {
            remaining: AtomicU64::new(requests),
        }
    }

    fn take(&self) -> bool {
        loop {
            let n = self.remaining.load(Ordering::SeqCst);
            if n == 0 {
                return false;
            }
            if self
                .remaining
                .compare_exchange(n, n - 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                return true;
            }
        }
    }
}

pub struct JevClient {
    transport: Arc<dyn JevTransport>,
    retry: RetryPolicy,
    timeout: Duration,
    permits: Arc<Semaphore>,
    meter: Arc<Meter>,
    cancel: Arc<AtomicBool>,
    daily_cap: u64,
}

impl JevClient {
    pub fn new(
        transport: Arc<dyn JevTransport>,
        retry: RetryPolicy,
        timeout: Duration,
        max_in_flight: usize,
        daily_cap: u64,
    ) -> Self {
        let meter = Arc::new(Meter::default());
        meter.last_latency_ms.store(u64::MAX, Ordering::Relaxed);
        Self {
            transport,
            retry,
            timeout,
            permits: Arc::new(Semaphore::new(max_in_flight.max(1))),
            meter,
            cancel: Arc::new(AtomicBool::new(false)),
            daily_cap,
        }
    }

    pub fn diagnostics(&self) -> Diagnostics {
        self.meter.snapshot()
    }

    pub(super) fn meter(&self) -> &Meter {
        &self.meter
    }

    /// Stops new requests and any retry wait. A request already in flight is abandoned when its future is dropped.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn resume(&self) {
        self.cancel.store(false, Ordering::SeqCst);
    }

    /// Waits for `wait` in short slices so a cancel interrupts a long backoff.
    async fn pause(&self, wait: Duration) -> Result<(), JevError> {
        let slice = Duration::from_millis(25);
        let mut left = wait;
        while !left.is_zero() {
            let step = left.min(slice);
            tokio::time::sleep(step).await;
            left -= step;
            if self.cancel.load(Ordering::SeqCst) {
                return Err(JevError::Cancelled);
            }
        }
        Ok(())
    }

    /// One logical request with bounded retries. Returns the 2xx body.
    pub async fn send(
        &self,
        key: &ApiKey,
        body: &str,
        budget: &Budget,
    ) -> Result<String, JevError> {
        let mut last: Option<JevError> = None;
        for attempt in 1..=self.retry.max_attempts.max(1) {
            if self.cancel.load(Ordering::SeqCst) {
                return Err(JevError::Cancelled);
            }
            if !budget.take() || !self.meter.take_daily(self.daily_cap) {
                self.meter.fail("budget_exceeded");
                return Err(JevError::BudgetExceeded);
            }
            if attempt > 1 {
                self.meter.retries.fetch_add(1, Ordering::Relaxed);
            }
            self.meter.requests.fetch_add(1, Ordering::Relaxed);
            let started = Instant::now();
            let outcome = {
                let _permit = self
                    .permits
                    .acquire()
                    .await
                    .map_err(|_| JevError::Cancelled)?;
                tokio::time::timeout(self.timeout, self.transport.post(key, body, self.timeout))
                    .await
            };
            self.meter
                .last_latency_ms
                .store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
            let (error, retry_after) = match outcome {
                Err(_) => (JevError::Timeout, None),
                Ok(Err(TransportError::Timeout)) => (JevError::Timeout, None),
                Ok(Err(TransportError::Network)) => (JevError::Network, None),
                Ok(Err(TransportError::TooLarge)) => (JevError::ResponseTooLarge, None),
                Ok(Ok(RawResponse {
                    status,
                    body,
                    retry_after_secs,
                })) => match status {
                    200..=299 => return Ok(body),
                    401 | 403 => (JevError::Auth, None),
                    400 | 404 | 422 => (JevError::Rejected, None),
                    429 => (JevError::RateLimited, retry_after_secs),
                    529 => (JevError::Overloaded, retry_after_secs),
                    500..=599 => (JevError::Server, retry_after_secs),
                    _ => (JevError::UnexpectedStatus, None),
                },
            };
            self.meter.fail(error.code());
            if !error.retryable() {
                return Err(error);
            }
            last = Some(error);
            if attempt < self.retry.max_attempts {
                let wait = retry_after
                    .map(Duration::from_secs)
                    .unwrap_or_else(|| self.retry.base_delay * 2u32.saturating_pow(attempt - 1))
                    .min(self.retry.max_delay);
                self.pause(wait).await?;
            }
        }
        let last = last.unwrap_or(JevError::Network);
        self.meter.fail("retries_exhausted");
        Err(JevError::RetriesExhausted(last.code()))
    }
}
