//! Dormant candidate: SQLite is canonical, CaptureStore owns every transaction.
//! Engine -> typed SyncStore; adapter -> codec/read-only native projections.
//! Boundary values are bounded messages and sealed trust capabilities, never SQL
//! handles/paths. Failures retain original evidence or roll back, never fake ACK.
//! Session cancellation/expiry bounds transient assemblies; reconnect rereads SQL.
//! Test seams are deterministic clock, trust and FakeTransport over two disk DBs.
//! Candidate extension is test-installed, forward-only; v9 startup is unchanged.
//! Outcomes expose needs-attention without logging rows, cores or SQL messages.
//! Release trust/admission constructors fail closed pending signer, G3/G4 review.
mod engine;
pub(crate) mod bootstrap;
#[cfg(test)]
mod fake;
mod protocol;
#[cfg(test)]
#[path = "../storage/sync_tests.rs"]
mod tests;
mod trust;
mod validation;

pub(crate) use engine::{SyncEngine, SyncStore};
pub(crate) use protocol::*;
pub(crate) use trust::{ClosedTrust, TrustVerifier, VerifiedSession};
pub(crate) use validation::ValidatedEvent;
