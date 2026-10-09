//! Bounded, reproducible safety evaluation for revision synthesis + independent verification (M04.7B Phase 4C).
//!
//! WHAT THIS IS: a small, frozen, hand-authored corpus (English, Bulgarian, mixed, Unicode/emoji) run through (1) the identity resolver's
//! policy gate with SCRIPTED classifier signals, (2) the deterministic draft validator, and (3) the verifier adapter over a localhost
//! fixture. WHAT IT IS NOT: a measurement of any model. The labels were written by the implementer (an AI assistant) in this milestone and
//! are NOT independent ground truth; the scripted classifier signals are not a classifier; the mock transport answers from the label, so its
//! "verifier" cannot be wrong. Real-model numbers exist only if the ignored, doubly-gated test below is run with a key; none are in this repo.
//!
//! DISCIPLINE: `corpus/CHECKSUMS` pins every corpus file (SHA-256). The holdout is evaluated by the same code as the dev set and nothing is
//! tuned to it: no threshold, prompt or heuristic in this crate was changed after the first holdout run. A run with the environment variable
//! `ARTHUR_EVAL_WRITE` set writes the report; ordinary test runs only check invariants.

mod metrics;
mod report;
mod runner;
mod sha256;

use serde::Deserialize;

pub const DEV_REVISION: &str = include_str!("corpus/dev_revision.json");
pub const HOLDOUT_REVISION: &str = include_str!("corpus/holdout_revision.json");
pub const DEV_IDENTITY: &str = include_str!("corpus/dev_identity.json");
pub const HOLDOUT_IDENTITY: &str = include_str!("corpus/holdout_identity.json");
pub const CHECKSUMS: &str = include_str!("corpus/CHECKSUMS");

#[derive(Debug, Clone, Deserialize)]
pub struct AssertionRow {
    pub text: String,
    pub source: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DraftRow {
    pub revised_body: String,
    pub retained: Vec<AssertionRow>,
    pub added: Vec<AssertionRow>,
    pub withdrawn: Vec<AssertionRow>,
}

/// One proposed revision and the implementer's label for it. `label` is "safe" (acceptable) or "unsafe" (must not be applied).
#[derive(Debug, Clone, Deserialize)]
pub struct RevCase {
    pub id: String,
    pub lang: String,
    pub change: String,
    pub base: String,
    pub claim: String,
    pub draft: DraftRow,
    pub label: String,
    pub unsafe_class: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SignalRow {
    pub id: String,
    pub same: f64,
    pub reframing: f64,
    pub relation: String,
    pub referent: bool,
    pub supersession: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IdCase {
    pub id: String,
    pub lang: String,
    pub claim: String,
    pub candidates: Vec<String>,
    pub runs: Vec<Vec<SignalRow>>,
    /// `revise:<id>`, `new` or `uncertain`.
    pub expect: String,
}

pub fn load<T: for<'de> Deserialize<'de>>(json: &str) -> Vec<T> {
    serde_json::from_str(json).expect("corpus file parses")
}

#[cfg(test)]
mod tests;
