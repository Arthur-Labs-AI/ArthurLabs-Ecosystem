//! The frozen-at-construction rules the resolver applies. Thresholds here are PLACEHOLDERS for tests and the experimental build: they are
//! not validated against any corpus (the JEV research thresholds are explicitly not production-validated).

use super::types::KINDS;

/// Automatic Thought Evolution is OFF until the person turns it on. It is independent of Automatic Connections (M04.7A).
pub const DEFAULT_ENABLED: bool = false;
pub const POLICY_VERSION: &str = "identity-core-1";

#[derive(Debug, Clone, PartialEq)]
pub struct ResolverPolicy {
    pub version: String,
    pub enabled: bool,
    /// Classifier model ids this policy was calibrated for. Empty (the default) accepts none, so an uncalibrated model fails closed.
    pub accepted_models: Vec<String>,
    /// Repeated samples of the same model required, all of which must agree (noise reduction, not independent verification).
    pub min_runs: usize,
    /// Every run must score the target at least this high.
    pub min_same_proposition: f64,
    /// A candidate any run scores at or above this is a plausible referent (so a second one makes the claim ambiguous).
    pub plausible_floor: f64,
    /// The target must beat every other candidate's best score by this much.
    pub min_gap: f64,
    /// A reframing score at or above this (any run) blocks automatic revision, even for an "additive" claim.
    pub max_reframing: f64,
    /// In the Inbox, "same project" says little: a revision there is only ever a suggestion.
    pub inbox_requires_confirmation: bool,
}

impl Default for ResolverPolicy {
    fn default() -> Self {
        Self {
            version: POLICY_VERSION.to_string(),
            enabled: DEFAULT_ENABLED,
            accepted_models: Vec::new(),
            min_runs: 3,
            min_same_proposition: 0.9,
            plausible_floor: 0.5,
            min_gap: 0.3,
            max_reframing: 0.3,
            inbox_requires_confirmation: true,
        }
    }
}

/// Knowledge kinds that may describe the same proposition: the same kind, or an idea and a note.
pub fn kinds_compatible(claim: &str, target: &str) -> bool {
    if !KINDS.contains(&claim) || !KINDS.contains(&target) {
        return false;
    }
    claim == target || matches!((claim, target), ("idea", "note") | ("note", "idea"))
}

/// Revisions written by a person (an edit or a merge) are never overwritten automatically.
pub fn is_user_owned(origin: &str) -> bool {
    !matches!(origin, "initial" | "distillation" | "system")
}

const SUPERSESSION_MARKERS: [&str; 14] = [
    "instead of",
    "switch from",
    "switching from",
    "replace",
    "replacing",
    "no longer",
    "dropped",
    "rather than",
    "вместо",
    "сменям",
    "сменихме",
    "заменям",
    "заменяме",
    "вече не",
];

/// A deterministic second look at "the claim says it replaces the earlier choice": the claim's own words must contain a supersession marker.
/// It can only veto; the provider's flag alone never suffices.
pub fn has_supersession_wording(claim_text: &str) -> bool {
    let lower = claim_text.to_lowercase();
    SUPERSESSION_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
}
