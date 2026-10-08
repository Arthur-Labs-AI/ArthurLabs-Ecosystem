//! Automatic Graph Integration (M04.7A): knowledge whose meaning changed is integrated into the Cognitive Graph without the user
//! opening Connections.
//!
//! ```text
//! Capture -> Distillation -> KnowledgeObject(s) committed        (already complete, never waits for anything below)
//!                               |  ChangedKnowledge event
//!                               v
//!                      IntegrationService::integrate
//!                        policy  -> discover -> decide -> guarded atomic write -> ledger
//! ```
//!
//! # The boundary
//! Integration receives ONE kind of fact: "this object's authoritative meaning changed" (`ChangedKnowledge`). It does not care whether
//! the change was a new object, a manual edit, a merge that became current, or (M04.7B, later) an automatic revision. Identity
//! resolution is NOT here and nothing here creates a revision.
//!
//! # Which events do graph work
//! | event                                             | graph work                                                                    |
//! |---------------------------------------------------|-------------------------------------------------------------------------------|
//! | `Created`  (distillation committed a new object)  | discover relations                                                            |
//! | `Revised`  (a revision became current, text moved)| discover relations AND revalidate the object's incident MODEL relations       |
//! | `Revised`, wording only (case/punctuation/space)  | none                                                                          |
//! | revision/branch that is NOT current               | none (nothing is notified)                                                    |
//! | `Moved`    (object moved to another project)      | discover relations in the NEW project; nothing is removed (cross-project ones stay) |
//!
//! # Ownership
//! `origin = user` relations are never removed, replaced or rewritten: they are not even read as candidates for change (the store
//! deletes only `WHERE origin = 'model'` and only relations that touch the changed object). They ARE visible to Stage A as context.
//! Automatic relations are stored with `origin = model`, so they stay distinguishable everywhere (Marginalia shows them as proposed).
//!
//! # Failure and retry
//! The object is already committed, so a failure here never touches it. A failed integration is remembered in the ledger and retried
//! a bounded number of times with backoff; nothing runs unattended beyond the slow poll in `commands::integration`.
//! * not configured / rejected credentials: DEFERRED (retried slowly, free, uncounted) so the graph catches up once the key works
//! * network / provider / unreadable output: up to `MAX_ATTEMPTS`, then FAILED (until the object changes again)
//! * no candidates, or the verifier rejects everything: a SUCCESSFUL no-op
//! A provider failure writes nothing: there are never unverified or partial relations.
//!
//! # Idempotence and concurrency
//! The ledger records, per object, the (revision, project) last integrated. The same event twice does no provider work and no write;
//! the store also skips an edge that already exists. Integrations run one at a time (a single gate), and the write is guarded by the
//! focus object's authoritative current revision, so an integration based on stale text writes nothing.
//!
//! The ledger and the on/off switch are app-private JSON files, like semantic Recall's consent. No schema change.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::recall::query::tokens;
use crate::recall::RecallService;
use crate::storage::capture_store::{CaptureStore, StoreError};
use crate::storage::integration_store::{IntegrationWrite, ObjectSnapshot};
use crate::storage::knowledge_store::KnowledgeObject;
use crate::storage::project_store::ProjectError;
use crate::storage::relation_store::Relation;

use super::discover::{discover, DiscoveryReport};
use super::integrate::{DecisionReport, IntegrationInput, Revalidation, MAX_REVALIDATIONS};
use super::{GraphService, RelationError};

/// Counted attempts before an integration is given up on (until the object changes again).
pub const MAX_ATTEMPTS: u32 = 3;
/// Seconds before attempt 2, attempt 3, ...
const BACKOFF_SECONDS: [u64; 3] = [60, 300, 900];
/// Seconds between uncounted retries of a deferred integration (no credentials / rejected credentials).
const DEFERRED_SECONDS: u64 = 600;
/// Integrations the slow poll may start per tick.
pub const MAX_RETRIES_PER_TICK: usize = 2;

/// Automatic integration is OFF by default: the precision gate (>= 0.90, measured against a real model) has not been passed on this
/// build. See `docs/architecture/m047a-automatic-graph-integration.md`. Turning it on is an explicit choice; turning it off stops new
/// inference and deletes nothing.
pub const DEFAULT_ENABLED: bool = false;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeReason {
    Created,
    Revised,
    Moved,
}

/// "This object's authoritative meaning changed." The only input of Graph Integration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedKnowledge {
    pub object_id: String,
    pub previous_revision_id: Option<String>,
    pub current_revision_id: String,
    pub reason: ChangeReason,
}

impl ChangedKnowledge {
    pub fn created(object_id: &str, current_revision_id: &str) -> Self {
        Self { object_id: object_id.into(), previous_revision_id: None, current_revision_id: current_revision_id.into(), reason: ChangeReason::Created }
    }

    pub fn revised(object_id: &str, previous_revision_id: &str, current_revision_id: &str) -> Self {
        Self { object_id: object_id.into(), previous_revision_id: Some(previous_revision_id.into()), current_revision_id: current_revision_id.into(), reason: ChangeReason::Revised }
    }

    pub fn moved(object_id: &str, current_revision_id: &str) -> Self {
        Self { object_id: object_id.into(), previous_revision_id: None, current_revision_id: current_revision_id.into(), reason: ChangeReason::Moved }
    }
}

/// Whether the wording moved enough to matter. Case, punctuation and whitespace do not; a changed, added, removed or re-ordered word
/// does (so does a changed kind). Words are never dropped as "unimportant": "Arthur works" -> "Arthur does not work" is a change.
pub fn meaning_changed(previous: (&str, &str, &str), current: (&str, &str, &str)) -> bool {
    previous.0 != current.0 || tokens(previous.1) != tokens(current.1) || tokens(previous.2) != tokens(current.2)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    Disabled,
    ObjectGone,
    /// A newer revision exists; its own event carries the work.
    Stale,
    ArchivedProject,
    AlreadyIntegrated,
    /// A revision whose words did not change.
    NotMeaningful,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Skipped(Skip),
    /// Ran to completion (including "nothing to relate").
    Integrated,
    /// Did not complete; remembered for a bounded retry. Carries the error code.
    Deferred(&'static str),
    Failed(&'static str),
}

/// What one integration did. Diagnostics, tests and the benchmark; never shown raw to users and never persisted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegrationReport {
    pub object_id: String,
    pub status: Status,
    pub candidates: usize,
    pub discovery: DiscoveryReport,
    pub decision: DecisionReport,
    pub added: usize,
    pub removed: usize,
    pub skipped_stale: usize,
    pub elapsed_ms: u128,
}

impl IntegrationReport {
    fn new(object_id: &str, status: Status) -> Self {
        Self { object_id: object_id.into(), status, candidates: 0, discovery: DiscoveryReport::default(), decision: DecisionReport::default(), added: 0, removed: 0, skipped_stale: 0, elapsed_ms: 0 }
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The on/off switch.

#[derive(Serialize, Deserialize)]
struct SettingsFile {
    enabled: bool,
}

/// The user's switch. App-private JSON; a missing or damaged file means the default.
pub struct IntegrationSettings {
    enabled: AtomicBool,
    path: Option<PathBuf>,
}

impl IntegrationSettings {
    pub fn new(path: PathBuf) -> Self {
        let enabled = std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<SettingsFile>(&bytes).ok()).map(|file| file.enabled).unwrap_or(DEFAULT_ENABLED);
        Self { enabled: AtomicBool::new(enabled), path: Some(path) }
    }

    pub fn in_memory(enabled: bool) -> Self {
        Self { enabled: AtomicBool::new(enabled), path: None }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn set(&self, enabled: bool) -> std::io::Result<()> {
        if let Some(path) = &self.path {
            write_atomically(path, &serde_json::to_vec(&SettingsFile { enabled }).unwrap_or_default())?;
        }
        self.enabled.store(enabled, Ordering::SeqCst);
        Ok(())
    }
}

fn write_atomically(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(&temporary, path)
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The ledger.

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Entry {
    /// The (revision, project) last integrated for this object.
    #[serde(rename_all = "camelCase")]
    Done { revision_id: String, project_id: String },
    /// Not completed; due again at `not_before` (unix seconds). `attempts` counts only real failures.
    #[serde(rename_all = "camelCase")]
    Pending { change: ChangedKnowledge, attempts: u32, not_before: u64, last_error: String },
    /// Gave up after `MAX_ATTEMPTS`. Not retried until the object changes again (or the user runs Find connections).
    #[serde(rename_all = "camelCase")]
    Failed { change: ChangedKnowledge, last_error: String },
}

/// Per-object integration state. In memory, mirrored to an app-private file (best effort: losing it only means some work is redone).
pub struct Ledger {
    entries: Mutex<BTreeMap<String, Entry>>,
    path: Option<PathBuf>,
}

impl Ledger {
    pub fn new(path: PathBuf) -> Self {
        let entries = std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<BTreeMap<String, Entry>>(&bytes).ok()).unwrap_or_default();
        Self { entries: Mutex::new(entries), path: Some(path) }
    }

    pub fn in_memory() -> Self {
        Self { entries: Mutex::new(BTreeMap::new()), path: None }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Entry>> {
        self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn get(&self, object_id: &str) -> Option<Entry> {
        self.lock().get(object_id).cloned()
    }

    pub(super) fn put(&self, object_id: &str, entry: Entry) {
        let mut entries = self.lock();
        entries.insert(object_id.to_string(), entry);
        self.persist(&entries);
    }

    fn persist(&self, entries: &BTreeMap<String, Entry>) {
        if let Some(path) = &self.path {
            let _ = write_atomically(path, &serde_json::to_vec(entries).unwrap_or_default());
        }
    }

    /// Integrations waiting for a retry that are due at `now`, at most `limit`, oldest first.
    pub fn due(&self, now: u64, limit: usize) -> Vec<ChangedKnowledge> {
        self.lock()
            .values()
            .filter_map(|entry| match entry {
                Entry::Pending { change, not_before, .. } if *not_before <= now => Some(change.clone()),
                _ => None,
            })
            .take(limit)
            .collect()
    }

    /// Forgets integrations that never finished (Pending or Failed). Finished ones (Done) are kept, so nothing is redone.
    pub fn discard_unfinished(&self) {
        let mut entries = self.lock();
        entries.retain(|_, entry| matches!(entry, Entry::Done { .. }));
        self.persist(&entries);
    }

    pub fn pending(&self) -> usize {
        self.lock().values().filter(|entry| matches!(entry, Entry::Pending { .. })).count()
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The service.

pub struct IntegrationService {
    graph: GraphService,
    pub settings: Arc<IntegrationSettings>,
    pub ledger: Ledger,
    /// One integration at a time: candidate snapshots never interleave with another integration's write.
    gate: tauri::async_runtime::Mutex<()>,
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn storage(error: StoreError) -> RelationError {
    RelationError::Storage(error.to_string())
}

impl IntegrationService {
    pub fn new(graph: GraphService, settings: IntegrationSettings, ledger: Ledger) -> Self {
        Self { graph, settings: Arc::new(settings), ledger, gate: tauri::async_runtime::Mutex::new(()) }
    }

    /// The user's explicit choice. Persisted first: if the preference cannot be saved nothing changes and the error is returned.
    ///
    /// Turning it ON never resumes old work: integrations that were left Pending or Failed (while it was off, or before) are forgotten, so
    /// enabling cannot launch a backlog. An object is integrated again the next time its meaning changes. Turning it OFF stops new
    /// scheduling and any write that has not happened yet; it deletes nothing.
    pub fn set_enabled(&self, enabled: bool) -> std::io::Result<()> {
        let was = self.settings.enabled();
        self.settings.set(enabled)?;
        if enabled && !was {
            self.ledger.discard_unfinished();
        }
        Ok(())
    }

    pub fn enabled(&self) -> bool {
        self.settings.enabled()
    }

    /// Integrates one change. Never returns an error and never touches the object: whatever happens is in the report and the ledger.
    pub async fn integrate(&self, store: &CaptureStore, recall: &RecallService, change: ChangedKnowledge) -> IntegrationReport {
        if !self.enabled() {
            return IntegrationReport::new(&change.object_id, Status::Skipped(Skip::Disabled));
        }
        let _one_at_a_time = self.gate.lock().await;
        // The switch may have been turned off while this waited its turn.
        if !self.enabled() {
            return IntegrationReport::new(&change.object_id, Status::Skipped(Skip::Disabled));
        }
        let started = Instant::now();
        let mut report = match self.run(store, recall, &change).await {
            Ok(report) => report,
            // Switched off while the provider was working: a failure is not worth remembering, and nothing may be scheduled.
            Err(_) if !self.enabled() => IntegrationReport::new(&change.object_id, Status::Skipped(Skip::Disabled)),
            Err(error) => self.record_failure(&change, &error),
        };
        report.elapsed_ms = started.elapsed().as_millis();
        report
    }

    /// The pending retries that are due now, for the slow poll to start.
    pub fn due_retries(&self, now: u64) -> Vec<ChangedKnowledge> {
        if !self.enabled() {
            return Vec::new();
        }
        self.ledger.due(now, MAX_RETRIES_PER_TICK)
    }

    pub fn due_retries_now(&self) -> Vec<ChangedKnowledge> {
        self.due_retries(unix_seconds())
    }

    fn record_failure(&self, change: &ChangedKnowledge, error: &RelationError) -> IntegrationReport {
        let code = error.code();
        let previous_attempts = match self.ledger.get(&change.object_id) {
            Some(Entry::Pending { change: pending, attempts, .. }) if pending.current_revision_id == change.current_revision_id => attempts,
            _ => 0,
        };
        let message = error.to_string();
        let now = unix_seconds();
        let status = match error {
            // Free and expected until the person configures a provider; retried slowly and never counted.
            RelationError::NotConfigured | RelationError::Auth(_) => {
                self.ledger.put(&change.object_id, Entry::Pending { change: change.clone(), attempts: previous_attempts, not_before: now + DEFERRED_SECONDS, last_error: message });
                Status::Deferred(code)
            }
            RelationError::Refused => {
                self.ledger.put(&change.object_id, Entry::Failed { change: change.clone(), last_error: message });
                Status::Failed(code)
            }
            RelationError::ObjectNotFound => Status::Skipped(Skip::ObjectGone),
            _ => {
                let attempts = previous_attempts + 1;
                if attempts >= MAX_ATTEMPTS {
                    self.ledger.put(&change.object_id, Entry::Failed { change: change.clone(), last_error: message });
                    Status::Failed(code)
                } else {
                    let wait = BACKOFF_SECONDS[(attempts as usize - 1).min(BACKOFF_SECONDS.len() - 1)];
                    self.ledger.put(&change.object_id, Entry::Pending { change: change.clone(), attempts, not_before: now + wait, last_error: message });
                    Status::Deferred(code)
                }
            }
        };
        IntegrationReport::new(&change.object_id, status)
    }

    async fn run(&self, store: &CaptureStore, recall: &RecallService, change: &ChangedKnowledge) -> Result<IntegrationReport, RelationError> {
        let object_id = change.object_id.as_str();
        let skipped = |skip: Skip| Ok(IntegrationReport::new(object_id, Status::Skipped(skip)));

        // Authoritative state NOW. An event can be late: the object may be gone, moved, archived, or already newer.
        let Some(current_revision) = store.current_revision_id_of(object_id).map_err(storage)? else { return skipped(Skip::ObjectGone) };
        if current_revision != change.current_revision_id {
            return skipped(Skip::Stale);
        }
        let Some(project_id) = store.project_of_object(object_id).map_err(|e: ProjectError| RelationError::Storage(e.to_string()))? else { return skipped(Skip::ObjectGone) };
        match store.get_project(&project_id) {
            Ok(project) if project.archived_at.is_some() => return skipped(Skip::ArchivedProject),
            Ok(_) => {}
            Err(error) => return Err(RelationError::Storage(error.to_string())),
        }
        let Some(focus) = store.get_knowledge_object(object_id).map_err(storage)? else { return skipped(Skip::ObjectGone) };

        // Idempotence: this revision, in this project, was already integrated.
        if let Some(Entry::Done { revision_id, project_id: done_project }) = self.ledger.get(object_id) {
            if revision_id == current_revision && done_project == project_id {
                return skipped(Skip::AlreadyIntegrated);
            }
        }

        let done = Entry::Done { revision_id: current_revision.clone(), project_id: project_id.clone() };
        // A wording-only revision needs no graph work.
        let mut revalidate_existing = false;
        if change.reason == ChangeReason::Revised {
            if let Some(previous_id) = &change.previous_revision_id {
                let previous = store.get_revision(previous_id).map_err(storage)?;
                if !meaning_changed((&previous.kind, &previous.title, &previous.body), (&focus.kind, &focus.title, &focus.body)) {
                    self.ledger.put(object_id, done);
                    return skipped(Skip::NotMeaningful);
                }
                revalidate_existing = true;
            }
        }

        // The revisions every decision below is based on, read BEFORE the text and before any provider call. The write re-checks them.
        let revisions = store.project_revisions(&project_id).map_err(storage)?;
        let snapshot = |object: &KnowledgeObject| revisions.get(&object.id).map(|revision_id| ObjectSnapshot { object_id: object.id.clone(), revision_id: revision_id.clone(), project_id: object.project_id.clone() });

        let discovery = discover(store, recall, &focus, &project_id).await?;

        // Model relations to re-check: only same-project, bounded, newest first. Cross-project ones are never revalidated here.
        let mut revalidate: Vec<Revalidation> = Vec::new();
        if revalidate_existing {
            for relation in store.model_relations_touching(object_id).map_err(storage)? {
                if revalidate.len() >= MAX_REVALIDATIONS {
                    break;
                }
                let other_id = if relation.source_object_id == object_id { &relation.target_object_id } else { &relation.source_object_id };
                let Some(other) = store.get_knowledge_object(other_id).map_err(storage)? else { continue };
                if other.project_id != project_id || !revisions.contains_key(&other.id) {
                    continue;
                }
                revalidate.push(Revalidation { relation, other });
            }
        }

        let mut ids: Vec<String> = vec![focus.id.clone()];
        ids.extend(discovery.candidates.iter().map(|object| object.id.clone()));
        ids.extend(revalidate.iter().map(|item| item.other.id.clone()));
        ids.sort();
        ids.dedup();
        let existing: Vec<Relation> = store.relations_among(&ids).map_err(storage)?;

        let mut report = IntegrationReport::new(object_id, Status::Integrated);
        report.candidates = discovery.candidates.len();
        report.discovery = discovery.report.clone();

        let written_at = store.project_current_revision_times(&project_id).map_err(storage)?;
        let decision = self.graph.decide_integration(IntegrationInput { focus: &focus, candidates: &discovery.candidates, revalidate: &revalidate, existing: &existing, written_at: &written_at }).await?;
        report.decision = decision.report.clone();

        // The switch is read again immediately before anything is persisted: an answer that arrives after the person turned Automatic
        // Connections off changes nothing and does not complete the event.
        if !self.enabled() {
            return Ok(IntegrationReport { status: Status::Skipped(Skip::Disabled), ..report });
        }
        if !decision.add.is_empty() || !decision.remove.is_empty() {
            // Every object the decision looked at, as of the snapshot taken before the provider calls.
            let context: Vec<ObjectSnapshot> = discovery.candidates.iter().chain(revalidate.iter().map(|item| &item.other)).filter_map(|object| snapshot(object)).collect();
            let written = store
                .apply_integration(IntegrationWrite { focus: ObjectSnapshot { object_id: focus.id.clone(), revision_id: current_revision.clone(), project_id: project_id.clone() }, context, remove: decision.remove, add: decision.add })
                .map_err(storage)?;
            if written.stale {
                // The object moved on while the provider worked; its own (newer) event carries the work.
                return Ok(IntegrationReport { status: Status::Skipped(Skip::Stale), ..report });
            }
            report.added = written.added.len();
            report.removed = written.removed;
            report.skipped_stale = written.skipped_stale;
        }

        self.ledger.put(object_id, done);
        Ok(report)
    }
}
