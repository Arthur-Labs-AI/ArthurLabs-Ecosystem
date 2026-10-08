//! Automatic Thought Evolution (M04.7B), Phase 1: the PURE identity core.
//!
//! Given one validated claim and a few candidate KnowledgeObjects, decide NEW / REVISE / UNCERTAIN.
//!
//! * No network, no SQLite, no Graph: this module imports nothing from `storage`, `graph`, `providers` or an HTTP/DB crate
//!   (enforced by `architecture_tests`). Everything it knows is passed in; the compare-and-set write lives in `storage::lineage_store`.
//! * Identity and permission are SEPARATE decisions. "Same object" does not imply "may change it without asking".
//! * Provider output is untrusted. The deterministic layer can only veto: it never raises anything to REVISE.
//! * Every failure is closed: a provider error, an unknown model, a malformed or incomplete signal yields NEW (unchecked) or
//!   UNCERTAIN, never REVISE. The raw Capture is not this module's business and cannot be lost by it.
//!
//! Not wired to distillation, to a live provider, or to Graph Integration. Default OFF (`policy::DEFAULT_ENABLED`).
//! Specification: `docs/architecture/m047b-phase1-identity-core.md`.

pub mod classifier;
pub mod policy;
pub mod resolver;
pub mod types;

#[cfg(test)]
mod architecture_tests;
#[cfg(test)]
pub mod fake;
#[cfg(test)]
mod tests;

#[allow(unused_imports)]
pub use classifier::{ClassifierFailure, ClassifierOutput, ClassifyRequest, IdentityClassifier};
#[allow(unused_imports)]
pub use policy::ResolverPolicy;
#[allow(unused_imports)]
pub use resolver::{eligible_candidates, resolve, resolve_capture};
#[allow(unused_imports)]
pub use types::*;
