//! Privacy-safe diagnostics for Automatic Graph Integration (M04.7A) and the manual "Find connections" run.
//!
//! Why this exists: before it, a run that found nothing, a run whose every candidate was rejected, a provider failure and an event that
//! never arrived were indistinguishable. All of them ended as "nothing happened" (and the manual button says "No new connections found.").
//! This module keeps COUNTS, STAGE NAMES and ERROR CODES only, in memory, for the life of the process:
//!
//! * never capture text, object titles or bodies, prompts, model answers, API keys or headers;
//! * objects appear only as the first eight characters of their id;
//! * nothing is written to disk and nothing is sent anywhere.
//!
//! The overall verdict (`Diagnosis`) names the FIRST point at which the path stopped producing edges, using the codes below.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;

use super::InferenceReport;

/// Recent runs kept (oldest dropped first).
pub const MAX_RUNS: usize = 20;

/// Cumulative counters since the process started. Plain numbers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    /// Events handed to integration by distillation, edits, moves and review decisions (before the on/off check).
    pub events_emitted: u64,
    /// Of those, dropped at the door because Automatic Connections was OFF.
    pub events_dropped_disabled: u64,
    /// Events that reached the integration worker.
    pub events_received: u64,
    /// Received but skipped (disabled again, stale, already integrated, wording-only, object gone, project archived).
    pub events_skipped: u64,
    pub runs_started: u64,
    pub runs_completed: u64,
    pub runs_failed: u64,
    /// Objects of the project that discovery could look at, summed over runs (the changed object excluded).
    pub objects_considered: u64,
    /// Focus-to-candidate pairs that reached Stage A, summed over runs.
    pub candidate_pairs: u64,
    pub stage_a_attempted: u64,
    pub stage_a_succeeded: u64,
    pub stage_a_failed: u64,
    pub stage_b_attempted: u64,
    pub stage_b_succeeded: u64,
    pub stage_b_failed: u64,
    /// Answers that broke the structured-output or validation contract (either stage), including ones a retry fixed.
    pub contract_errors: u64,
    /// Stage A claims that touched the changed object / did not / already existed.
    pub proposed: u64,
    pub off_focus: u64,
    pub skipped_existing: u64,
    pub verified: u64,
    pub survived: u64,
    /// Claims that did not survive both Stage B passes.
    pub rejected: u64,
    /// Policy outcomes after verification.
    pub ambiguous_pairs: u64,
    pub related_suppressed: u64,
    pub plan_cancelled_blocked: u64,
    pub relations_accepted: u64,
    pub relations_persisted: u64,
    pub relations_removed: u64,
    pub persist_failed: u64,
    pub stale_writes: u64,
    /// Updates the UI was told about (an event emitted to the window), and failures to do so.
    pub ui_updates_delivered: u64,
    pub ui_updates_failed: u64,
}

/// What one run ended as. The codes are the ones the user and the tests can rely on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Outcome {
    /// Nothing to compare the changed object with (it is alone in its project, or discovery nominated nobody).
    #[serde(rename = "NO_CANDIDATES")]
    NoCandidates,
    /// Stage A proposed something and Stage B / the policy rejected all of it.
    #[serde(rename = "ALL_REJECTED")]
    AllRejected,
    #[serde(rename = "PROVIDER_FAILED")]
    ProviderFailed,
    #[serde(rename = "PERSISTENCE_FAILED")]
    PersistenceFailed,
    /// Completed correctly and there was nothing new to write (Stage A proposed nothing, or only edges that already exist).
    #[serde(rename = "SUCCESS_NO_NEW_EDGES")]
    SuccessNoNewEdges,
    #[serde(rename = "SUCCESS")]
    Success,
    /// The run was not done: switched off, stale, already integrated, wording-only, object gone, project archived.
    #[serde(rename = "SKIPPED")]
    Skipped,
}

impl Outcome {
    #[cfg(test)]
    pub fn code(self) -> &'static str {
        match self {
            Outcome::NoCandidates => "NO_CANDIDATES",
            Outcome::AllRejected => "ALL_REJECTED",
            Outcome::ProviderFailed => "PROVIDER_FAILED",
            Outcome::PersistenceFailed => "PERSISTENCE_FAILED",
            Outcome::SuccessNoNewEdges => "SUCCESS_NO_NEW_EDGES",
            Outcome::Success => "SUCCESS",
            Outcome::Skipped => "SKIPPED",
        }
    }
}

/// One finished integration, as counts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    /// First eight characters of the object id.
    pub object: String,
    /// `created`, `revised` or `moved`.
    pub reason: &'static str,
    pub outcome: Outcome,
    /// Why it was skipped, or the error code of a failure (`not_configured`, `network`, `invalid_output`, `storage`, ...).
    pub detail: Option<String>,
    pub project_objects: usize,
    pub candidates: usize,
    pub stage_a: &'static str,
    pub stage_b: &'static str,
    pub proposed: usize,
    pub verified: usize,
    pub survived: usize,
    pub rejected: usize,
    pub added: usize,
    pub removed: usize,
    pub at: u64,
}

/// The last manual "Find connections" run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualRecord {
    pub outcome: Outcome,
    /// Objects the run looked at (the most recent ones of the project, at most 40).
    pub considered: usize,
    pub proposed: usize,
    pub already_connected: usize,
    pub verified: usize,
    pub rejected: usize,
    pub added: usize,
    pub provider_requests: usize,
    pub at: u64,
}

/// The first point at which the path stopped producing edges.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    /// `WORKER_NOT_STARTED`, `DISABLED`, `EVENT_NOT_DELIVERED`, `NO_EVENTS_YET`, or the code of the latest run (`NO_CANDIDATES`,
    /// `ALL_REJECTED`, `PROVIDER_FAILED`, `PERSISTENCE_FAILED`, `SUCCESS_NO_NEW_EDGES`, `SUCCESS`, `SKIPPED`).
    pub code: &'static str,
    pub explanation: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub worker_active: bool,
    pub enabled: bool,
    pub diagnosis: Diagnosis,
    pub totals: Totals,
    /// Newest first.
    pub recent_runs: Vec<RunRecord>,
    pub last_manual: Option<ManualRecord>,
}

/// What the run in progress has seen so far (one integration runs at a time, so one scratch is enough).
#[derive(Debug, Clone, Default)]
struct Scratch {
    object: String,
    reason: &'static str,
    project_objects: usize,
    candidates: usize,
    stage_a_attempted: bool,
    stage_a_failed: bool,
    stage_b_attempted: bool,
    stage_b_failed: bool,
    proposed: usize,
    verified: usize,
    survived: usize,
    rejected: usize,
    added: usize,
    removed: usize,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn short(id: &str) -> String {
    id.chars().take(8).collect()
}

pub struct IntegrationDiagnostics {
    worker_started: AtomicBool,
    totals: Mutex<Totals>,
    runs: Mutex<VecDeque<RunRecord>>,
    scratch: Mutex<Scratch>,
    manual: Mutex<Option<ManualRecord>>,
}

impl Default for IntegrationDiagnostics {
    fn default() -> Self {
        Self {
            worker_started: AtomicBool::new(false),
            totals: Mutex::new(Totals::default()),
            runs: Mutex::new(VecDeque::new()),
            scratch: Mutex::new(Scratch::default()),
            manual: Mutex::new(None),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl IntegrationDiagnostics {
    /// The long-lived background task (the retry poll) was started by the app.
    pub fn mark_worker_started(&self) {
        self.worker_started.store(true, Ordering::SeqCst);
    }

    pub fn worker_started(&self) -> bool {
        self.worker_started.load(Ordering::SeqCst)
    }

    fn update(&self, change: impl FnOnce(&mut Totals)) {
        change(&mut lock(&self.totals));
    }

    fn scratch(&self, change: impl FnOnce(&mut Scratch)) {
        change(&mut lock(&self.scratch));
    }

    // ---- the door ------------------------------------------------------------------------------------------------------------

    pub fn event_emitted(&self, enabled: bool) {
        self.update(|t| {
            t.events_emitted += 1;
            if !enabled {
                t.events_dropped_disabled += 1;
            }
        });
    }

    pub fn event_received(&self) {
        self.update(|t| t.events_received += 1);
    }

    pub fn ui_update(&self, delivered: bool) {
        self.update(|t| {
            if delivered {
                t.ui_updates_delivered += 1
            } else {
                t.ui_updates_failed += 1
            }
        });
    }

    // ---- one run -------------------------------------------------------------------------------------------------------------

    pub fn begin_run(&self, object_id: &str, reason: &'static str) {
        self.update(|t| t.runs_started += 1);
        *lock(&self.scratch) = Scratch {
            object: short(object_id),
            reason,
            ..Scratch::default()
        };
    }

    pub fn discovered(&self, project_objects: usize, candidates: usize) {
        self.update(|t| {
            t.objects_considered += project_objects as u64;
            t.candidate_pairs += candidates as u64;
        });
        self.scratch(|s| {
            s.project_objects = project_objects;
            s.candidates = candidates;
        });
    }

    pub fn stage_a_attempted(&self) {
        self.update(|t| t.stage_a_attempted += 1);
        self.scratch(|s| s.stage_a_attempted = true);
    }

    pub fn stage_a_succeeded(&self) {
        self.update(|t| t.stage_a_succeeded += 1);
    }

    pub fn stage_a_failed(&self, contract: bool) {
        self.update(|t| {
            t.stage_a_failed += 1;
            t.contract_errors += u64::from(contract);
        });
        self.scratch(|s| s.stage_a_failed = true);
    }

    pub fn stage_b_attempted(&self) {
        self.update(|t| t.stage_b_attempted += 1);
        self.scratch(|s| s.stage_b_attempted = true);
    }

    pub fn stage_b_succeeded(&self) {
        self.update(|t| t.stage_b_succeeded += 1);
    }

    pub fn stage_b_failed(&self, contract: bool) {
        self.update(|t| {
            t.stage_b_failed += 1;
            t.contract_errors += u64::from(contract);
        });
        self.scratch(|s| s.stage_b_failed = true);
    }

    /// Stage A claims reduced to counts, and the Stage B / policy outcome.
    pub fn decided(&self, report: &super::integrate::DecisionReport, accepted: usize) {
        self.update(|t| {
            t.proposed += report.proposed as u64;
            t.off_focus += report.off_focus as u64;
            t.skipped_existing += report.skipped_existing as u64;
            t.verified += report.verified as u64;
            t.survived += report.survived as u64;
            t.rejected += report.rejected as u64;
            t.ambiguous_pairs += report.ambiguous_pairs as u64;
            t.related_suppressed += report.related_suppressed as u64;
            t.plan_cancelled_blocked += report.moot_blocked as u64;
            t.relations_accepted += accepted as u64;
        });
        self.scratch(|s| {
            s.proposed = report.proposed;
            s.verified = report.verified;
            s.survived = report.survived;
            s.rejected = report.rejected;
        });
    }

    pub fn persisted(&self, added: usize, removed: usize, stale: bool) {
        self.update(|t| {
            t.relations_persisted += added as u64;
            t.relations_removed += removed as u64;
            t.stale_writes += u64::from(stale);
        });
        self.scratch(|s| {
            s.added = added;
            s.removed = removed;
        });
    }

    pub fn persist_failed(&self) {
        self.update(|t| t.persist_failed += 1);
    }

    fn stage_label(attempted: bool, failed: bool) -> &'static str {
        match (attempted, failed) {
            (false, _) => "not_run",
            (true, true) => "failed",
            (true, false) => "ok",
        }
    }

    /// Closes the run in progress.
    pub fn finish_run(&self, outcome: Outcome, detail: Option<String>) {
        let scratch = lock(&self.scratch).clone();
        self.update(|t| match outcome {
            Outcome::ProviderFailed | Outcome::PersistenceFailed => t.runs_failed += 1,
            Outcome::Skipped => t.events_skipped += 1,
            _ => t.runs_completed += 1,
        });
        let record = RunRecord {
            object: scratch.object,
            reason: scratch.reason,
            outcome,
            detail,
            project_objects: scratch.project_objects,
            candidates: scratch.candidates,
            stage_a: Self::stage_label(scratch.stage_a_attempted, scratch.stage_a_failed),
            stage_b: Self::stage_label(scratch.stage_b_attempted, scratch.stage_b_failed),
            proposed: scratch.proposed,
            verified: scratch.verified,
            survived: scratch.survived,
            rejected: scratch.rejected,
            added: scratch.added,
            removed: scratch.removed,
            at: now(),
        };
        let mut runs = lock(&self.runs);
        runs.push_front(record);
        runs.truncate(MAX_RUNS);
    }

    /// A skipped event that never began a run.
    pub fn skipped_at_the_door(&self, object_id: &str, reason: &'static str, detail: &'static str) {
        self.update(|t| t.events_skipped += 1);
        let mut runs = lock(&self.runs);
        runs.push_front(RunRecord {
            object: short(object_id),
            reason,
            outcome: Outcome::Skipped,
            detail: Some(detail.into()),
            project_objects: 0,
            candidates: 0,
            stage_a: "not_run",
            stage_b: "not_run",
            proposed: 0,
            verified: 0,
            survived: 0,
            rejected: 0,
            added: 0,
            removed: 0,
            at: now(),
        });
        runs.truncate(MAX_RUNS);
    }

    // ---- the manual run ------------------------------------------------------------------------------------------------------

    /// Classifies and remembers a "Find connections" run. `considered` is how many objects it looked at.
    pub fn record_manual(&self, considered: usize, report: &InferenceReport) -> ManualRecord {
        let outcome = if considered < 2 {
            Outcome::NoCandidates
        } else if report.added > 0 {
            Outcome::Success
        } else if report.verified > 0 {
            Outcome::AllRejected
        } else {
            Outcome::SuccessNoNewEdges
        };
        let record = ManualRecord {
            outcome,
            considered,
            proposed: report.proposed,
            already_connected: report.skipped_existing,
            verified: report.verified,
            rejected: report.rejected,
            added: report.added,
            provider_requests: report.provider_requests,
            at: now(),
        };
        self.update(|t| {
            t.stage_a_attempted += u64::from(considered >= 2);
            t.stage_a_succeeded += u64::from(considered >= 2);
            t.stage_b_attempted += (report.provider_requests.saturating_sub(1)) as u64;
            t.stage_b_succeeded += (report.provider_requests.saturating_sub(1)) as u64;
            t.verified += report.verified as u64;
            t.rejected += report.rejected as u64;
            t.relations_persisted += report.added as u64;
        });
        *lock(&self.manual) = Some(record.clone());
        record
    }

    /// A manual run that failed before producing a report.
    pub fn manual_failed(&self, contract: bool, persistence: bool) {
        let outcome = if persistence {
            Outcome::PersistenceFailed
        } else {
            Outcome::ProviderFailed
        };
        self.update(|t| {
            if persistence {
                t.persist_failed += 1;
            } else {
                t.stage_a_attempted += 1;
                t.stage_a_failed += 1;
                t.contract_errors += u64::from(contract);
            }
        });
        *lock(&self.manual) = Some(ManualRecord {
            outcome,
            considered: 0,
            proposed: 0,
            already_connected: 0,
            verified: 0,
            rejected: 0,
            added: 0,
            provider_requests: 0,
            at: now(),
        });
    }

    // ---- reading -------------------------------------------------------------------------------------------------------------

    pub fn snapshot(&self, enabled: bool) -> Snapshot {
        let totals = lock(&self.totals).clone();
        let recent_runs: Vec<RunRecord> = lock(&self.runs).iter().cloned().collect();
        let last_manual = lock(&self.manual).clone();
        let worker_active = self.worker_started();
        let diagnosis = diagnose(worker_active, enabled, &totals, recent_runs.first());
        Snapshot {
            worker_active,
            enabled,
            diagnosis,
            totals,
            recent_runs,
            last_manual,
        }
    }
}

/// The first failing point, in path order.
pub fn diagnose(
    worker_active: bool,
    enabled: bool,
    totals: &Totals,
    latest: Option<&RunRecord>,
) -> Diagnosis {
    if !worker_active {
        return Diagnosis { code: "WORKER_NOT_STARTED", explanation: "The background worker was never started in this session, so nothing can be connected automatically." };
    }
    if !enabled {
        return Diagnosis {
            code: "DISABLED",
            explanation: "Automatic Connections is off, so new ideas are not sent for connecting.",
        };
    }
    if totals.events_emitted > 0 && totals.events_received == 0 {
        return Diagnosis {
            code: "EVENT_NOT_DELIVERED",
            explanation: "New ideas were announced but none reached the integration worker.",
        };
    }
    let Some(run) = latest else {
        return Diagnosis {
            code: "NO_EVENTS_YET",
            explanation: "No new or changed idea has been announced since Arthur started.",
        };
    };
    let (code, explanation) = match run.outcome {
        Outcome::NoCandidates => (
            "NO_CANDIDATES",
            "The latest idea had nothing in its project to be compared with.",
        ),
        Outcome::AllRejected => (
            "ALL_REJECTED",
            "Arthur proposed connections for the latest idea and the checks rejected all of them.",
        ),
        Outcome::ProviderFailed => (
            "PROVIDER_FAILED",
            "The AI provider could not be used for the latest idea (see the error code).",
        ),
        Outcome::PersistenceFailed => (
            "PERSISTENCE_FAILED",
            "Connections were accepted but could not be saved.",
        ),
        Outcome::SuccessNoNewEdges => (
            "SUCCESS_NO_NEW_EDGES",
            "The latest idea was fully processed and Arthur found nothing new to connect it to.",
        ),
        Outcome::Success => ("SUCCESS", "The latest idea was connected."),
        Outcome::Skipped => ("SKIPPED", "The latest event was skipped (see the reason)."),
    };
    Diagnosis { code, explanation }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_diagnosis_names_the_first_point_of_failure_in_path_order() {
        let totals = Totals::default();
        assert_eq!(
            diagnose(false, true, &totals, None).code,
            "WORKER_NOT_STARTED"
        );
        assert_eq!(diagnose(true, false, &totals, None).code, "DISABLED");
        let announced = Totals {
            events_emitted: 3,
            ..Totals::default()
        };
        assert_eq!(
            diagnose(true, true, &announced, None).code,
            "EVENT_NOT_DELIVERED"
        );
        assert_eq!(diagnose(true, true, &totals, None).code, "NO_EVENTS_YET");
        let received = Totals {
            events_emitted: 3,
            events_received: 3,
            ..Totals::default()
        };
        assert_eq!(diagnose(true, true, &received, None).code, "NO_EVENTS_YET");
    }

    #[test]
    fn every_outcome_has_its_own_code_and_none_of_them_is_the_generic_empty_message() {
        let d = IntegrationDiagnostics::default();
        d.mark_worker_started();
        let all = [
            Outcome::NoCandidates,
            Outcome::AllRejected,
            Outcome::ProviderFailed,
            Outcome::PersistenceFailed,
            Outcome::SuccessNoNewEdges,
            Outcome::Success,
            Outcome::Skipped,
        ];
        let mut codes = std::collections::BTreeSet::new();
        for outcome in all {
            d.begin_run("0123456789abcdef", "created");
            d.finish_run(outcome, None);
            let snapshot = d.snapshot(true);
            assert_eq!(snapshot.diagnosis.code, outcome.code());
            assert!(!snapshot
                .diagnosis
                .explanation
                .to_lowercase()
                .contains("no new connections found"));
            codes.insert(snapshot.diagnosis.code);
        }
        assert_eq!(codes.len(), all.len());
    }

    #[test]
    fn nothing_but_counts_codes_and_short_ids_is_ever_kept() {
        let d = IntegrationDiagnostics::default();
        d.mark_worker_started();
        d.begin_run("0123456789abcdef0123456789abcdef", "revised");
        d.finish_run(Outcome::ProviderFailed, Some("invalid_output".into()));
        let json = serde_json::to_string(&d.snapshot(true)).unwrap();
        assert!(json.contains("01234567") && !json.contains("0123456789abcdef"));
        assert!(json.contains("invalid_output"));
    }

    #[test]
    fn recent_runs_are_bounded_and_newest_first() {
        let d = IntegrationDiagnostics::default();
        for i in 0..(MAX_RUNS + 5) {
            d.begin_run(&format!("{i:08}"), "created");
            d.finish_run(Outcome::SuccessNoNewEdges, None);
        }
        let snapshot = d.snapshot(true);
        assert_eq!(snapshot.recent_runs.len(), MAX_RUNS);
        assert_eq!(
            snapshot.recent_runs[0].object,
            format!("{:08}", MAX_RUNS + 4)
        );
    }

    #[test]
    fn a_manual_run_is_classified_by_what_actually_happened() {
        let d = IntegrationDiagnostics::default();
        let report = |proposed, skipped_existing, verified, rejected, added| InferenceReport {
            proposed,
            skipped_existing,
            verified,
            rejected,
            added,
            provider_requests: 3,
            ..InferenceReport::default()
        };
        assert_eq!(
            d.record_manual(1, &report(0, 0, 0, 0, 0)).outcome,
            Outcome::NoCandidates
        );
        assert_eq!(
            d.record_manual(4, &report(0, 0, 0, 0, 0)).outcome,
            Outcome::SuccessNoNewEdges
        );
        assert_eq!(
            d.record_manual(4, &report(2, 2, 0, 0, 0)).outcome,
            Outcome::SuccessNoNewEdges
        );
        assert_eq!(
            d.record_manual(4, &report(2, 0, 2, 2, 0)).outcome,
            Outcome::AllRejected
        );
        assert_eq!(
            d.record_manual(4, &report(2, 0, 2, 1, 1)).outcome,
            Outcome::Success
        );
    }
}
