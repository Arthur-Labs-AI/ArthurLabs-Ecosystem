//! Cognitive Graph construction: KnowledgeObjects -> proposed relations -> validated -> persisted.
//!
//! Pipeline (two stages, each followed by deterministic checks; the model never writes to storage):
//!
//! ```text
//! bounded candidate objects (<= 40)
//!   -> Stage A  model proposes relation candidates (<= 20)              [provider request 1]
//!   -> validate  structure: ids, kinds, no self edge, no duplicates, candidate set
//!   -> drop edges that already exist
//!   -> Stage B  model verifies kind + direction of every survivor, one batch, TWICE with the pair
//!               listed in opposite orders (two independent votes)                  [provider requests 2, 3]
//!   -> verify    deterministic gates over each vote, then agreement between the votes
//!   -> validate  the same structural checks again, on the verified set
//!   -> store     one transaction
//! ```
//!
//! Failure policy. MALFORMED output from either stage (bad JSON, hallucinated id, inconsistent verdict,
//! over the caps) and any provider failure reject the whole run: nothing is written and the error is
//! retryable. A candidate the verifier legitimately declines (reject, medium/low confidence, no explicit
//! link, unclear direction) is NOT a failure: it is dropped, and only the verified remainder is persisted.
//! Zero relations is a valid result. Bounds: at most `MAX_RELATION_PROPOSALS` proposals,
//! `MAX_RELATION_PROPOSALS` verifications (each voted on twice), and `MAX_PROVIDER_REQUESTS_PER_RUN` (3) provider requests.
//!
//! This is graph construction only. There is no lineage, no revision mechanics, no recall and no
//! retrieval ranking here.

pub mod candidates;
pub mod openai;
pub mod prompt;
pub mod semantics;
pub mod validate;
pub mod verify;
pub mod verify_prompt;

use std::collections::HashSet;
use std::fmt;
use std::sync::Arc;

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

use crate::async_util::BoxFuture;
use crate::providers::chat::ChatFailure;
use crate::storage::capture_store::{CaptureStore, StoreError};
use crate::storage::knowledge_store::KnowledgeObject;
use crate::storage::relation_store::{NewRelation, Relation};
use verify::{Presentation, RelationVerifier, VerifyCandidate};

/// Mirrors `MAX_RELATION_PROPOSALS` in `packages/contracts/cognitive.ts`.
pub const MAX_RELATION_PROPOSALS: usize = 20;
/// Mirrors `MAX_INFERENCE_REQUESTS` in `packages/contracts/cognitive.ts`: one proposal request and two
/// batched verification votes. Nothing in a run loops over the provider.
pub const MAX_PROVIDER_REQUESTS_PER_RUN: usize = 3;

/// What the model proposed. Untrusted: nothing here is stored as-is, and `reason` is never stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelationCandidate {
    pub source_object_id: String,
    pub target_object_id: String,
    pub kind: String,
    pub reason: String,
}

/// Why a relation attempt failed. `code()` values mirror `RELATION_ERROR_CODES` in
/// `packages/contracts/cognitive.ts`. Messages never contain credentials, prompts or provider bodies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelationError {
    ObjectNotFound,
    InvalidRelation(String),
    NotConfigured,
    Network,
    Auth(u16),
    Provider(u16),
    Refused,
    InvalidOutput(String),
    Storage(String),
}

impl RelationError {
    pub fn code(&self) -> &'static str {
        match self {
            RelationError::ObjectNotFound => "object_not_found",
            RelationError::InvalidRelation(_) => "invalid_relation",
            RelationError::NotConfigured => "llm_not_configured",
            RelationError::Network | RelationError::Auth(_) | RelationError::Provider(_) => "llm_failed",
            RelationError::Refused => "llm_refused",
            RelationError::InvalidOutput(_) => "llm_invalid_output",
            RelationError::Storage(_) => "storage_failed",
        }
    }

    pub fn message(&self) -> String {
        match self {
            RelationError::ObjectNotFound => "One of those knowledge objects no longer exists.".into(),
            RelationError::InvalidRelation(reason) => format!("That relation is not valid: {reason}."),
            RelationError::NotConfigured => "The language model is not configured on this device.".into(),
            RelationError::Network => "Could not reach the language model. Check the connection and try again.".into(),
            RelationError::Auth(_) => "The language model rejected the configured credentials.".into(),
            RelationError::Provider(status) => format!("The language model failed (HTTP {status}). Try again."),
            RelationError::Refused => "The language model declined to process these objects.".into(),
            RelationError::InvalidOutput(reason) => {
                format!("The language model returned something that could not be trusted ({reason}). Nothing was saved. Try again.")
            }
            RelationError::Storage(reason) => format!("The result could not be saved: {reason}"),
        }
    }
}

impl fmt::Display for RelationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

impl std::error::Error for RelationError {}

/// Serialized as `{ code, message }`, matching `RelationErrorPayload`.
impl Serialize for RelationError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("RelationError", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.message())?;
        state.end()
    }
}

impl From<ChatFailure> for RelationError {
    fn from(failure: ChatFailure) -> Self {
        match failure {
            ChatFailure::NotConfigured => RelationError::NotConfigured,
            ChatFailure::Network => RelationError::Network,
            ChatFailure::Auth(status) => RelationError::Auth(status),
            ChatFailure::Provider(status) => RelationError::Provider(status),
            ChatFailure::Refused => RelationError::Refused,
            ChatFailure::Unreadable(reason) => RelationError::InvalidOutput(reason),
        }
    }
}

/// Store errors for something the USER asked for (manual creation).
fn from_user_request(error: StoreError) -> RelationError {
    match error {
        StoreError::Invalid(reason) => RelationError::InvalidRelation(reason),
        StoreError::NotFound(_) => RelationError::ObjectNotFound,
        other => RelationError::Storage(other.to_string()),
    }
}

/// Store errors for something the MODEL proposed: the store rejecting it means the output was untrustworthy.
fn from_model_proposal(error: StoreError) -> RelationError {
    match error {
        StoreError::Invalid(reason) => RelationError::InvalidOutput(reason),
        StoreError::NotFound(_) => RelationError::InvalidOutput("refers to an object that does not exist".into()),
        other => RelationError::Storage(other.to_string()),
    }
}

/// The cloud model boundary: knowledge objects (and the edges they already have) in, untrusted candidates out.
pub trait RelationProposer: Send + Sync {
    fn propose<'a>(&'a self, objects: &'a [KnowledgeObject], existing: &'a [Relation]) -> BoxFuture<'a, Result<Vec<RelationCandidate>, RelationError>>;
}

/// Creates one user-authored relation, atomically. The caller supplies only kind and ends; the id,
/// timestamp and `user` origin are internal, and a symmetric edge is stored in canonical order.
pub fn create_manual_relation(store: &CaptureStore, input: NewRelation) -> Result<Relation, RelationError> {
    store.create_relation(input, "user").map_err(from_user_request)
}

/// What one inference run did. For tests, diagnosis and reporting; not persisted, not shown raw to users.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct InferenceReport {
    /// Valid Stage A candidates.
    pub proposed: usize,
    /// Candidates that were already durable edges (skipped before verification, or after a correction).
    pub skipped_existing: usize,
    /// Candidates sent to the verifier.
    pub verified: usize,
    /// Semantically declined by the verifier or its gates.
    pub rejected: usize,
    /// Kept with the objects swapped relative to Stage A.
    pub reversed: usize,
    /// Kept as a different kind than Stage A proposed.
    pub reclassified: usize,
    /// Candidates that converged on an edge already kept in this run.
    pub merged: usize,
    /// Edges written.
    pub added: usize,
    /// Provider requests made. Never more than `MAX_PROVIDER_REQUESTS_PER_RUN`.
    pub provider_requests: usize,
}

pub struct Inference {
    pub relations: Vec<Relation>,
    /// Read by tests and the live harness; not surfaced to the UI in M02.1.
    #[cfg_attr(not(test), allow(dead_code))]
    pub report: InferenceReport,
}

pub struct GraphService {
    proposer: Arc<dyn RelationProposer>,
    verifier: Arc<dyn RelationVerifier>,
}

impl GraphService {
    pub fn new(proposer: Arc<dyn RelationProposer>, verifier: Arc<dyn RelationVerifier>) -> Self {
        Self { proposer, verifier }
    }

    /// Asks the model for relations among a bounded candidate set, verifies each one twice, and persists the
    /// defensible result.
    ///
    /// `object_ids` are objects that must be in the candidate set (see `candidates`); with none, the
    /// most recent objects are used. Returns only the relations this run ADDED, so running it again
    /// returns an empty list rather than duplicates. Fewer than two candidates means nothing to
    /// relate: no model is called.
    pub async fn infer(&self, store: &CaptureStore, object_ids: &[String]) -> Result<Vec<Relation>, RelationError> {
        Ok(self.infer_with_report(store, object_ids).await?.relations)
    }

    pub async fn infer_with_report(&self, store: &CaptureStore, object_ids: &[String]) -> Result<Inference, RelationError> {
        let mut report = InferenceReport::default();
        let done = |relations: Vec<Relation>, report: InferenceReport| {
            // The structure of the pipeline already guarantees this; the check keeps it true under refactoring.
            debug_assert!(report.provider_requests <= MAX_PROVIDER_REQUESTS_PER_RUN);
            Ok(Inference { relations, report })
        };

        let all = store.list_knowledge_objects().map_err(|error| RelationError::Storage(error.to_string()))?;
        let objects = candidates::select_candidates(all, object_ids)?;
        if objects.len() < 2 {
            return done(vec![], report);
        }

        let in_scope = |relation: &Relation| objects.iter().any(|o| o.id == relation.source_object_id) && objects.iter().any(|o| o.id == relation.target_object_id);
        let existing: Vec<Relation> = store.list_relations().map_err(|error| RelationError::Storage(error.to_string()))?.into_iter().filter(in_scope).collect();

        // Stage A.
        report.provider_requests += 1;
        let proposals = self.proposer.propose(&objects, &existing).await?;
        let proposed = validate::validate_proposals(&objects, proposals)?;
        report.proposed = proposed.len();

        // Edges that already exist need no verification and no write.
        let known: HashSet<(&str, &str, &str)> = existing.iter().map(|r| (r.kind.as_str(), r.source_object_id.as_str(), r.target_object_id.as_str())).collect();
        let (fresh, already): (Vec<NewRelation>, Vec<NewRelation>) =
            proposed.into_iter().partition(|edge| !known.contains(&(edge.kind.as_str(), edge.source_object_id.as_str(), edge.target_object_id.as_str())));
        report.skipped_existing = already.len();
        if fresh.is_empty() {
            return done(vec![], report);
        }

        // Stage B: two batched votes for everything that is left, listing each pair in opposite orders.
        let by_id = |id: &str| objects.iter().find(|o| o.id == id).cloned().ok_or_else(|| RelationError::InvalidOutput("refers to an object that was not supplied".into()));
        let to_verify = fresh
            .iter()
            .enumerate()
            .map(|(index, edge)| Ok(VerifyCandidate { index, source: by_id(&edge.source_object_id)?, target: by_id(&edge.target_object_id)?, kind: edge.kind.clone() }))
            .collect::<Result<Vec<_>, RelationError>>()?;
        report.verified = to_verify.len();
        report.provider_requests += 1;
        let first_vote = self.verifier.verify(&to_verify, Presentation::LowerIdFirst).await?;
        report.provider_requests += 1;
        let second_vote = self.verifier.verify(&to_verify, Presentation::HigherIdFirst).await?;
        let applied = verify::apply_votes(&to_verify, vec![first_vote, second_vote])?;
        report.rejected = applied.rejections.len();
        report.reversed = applied.reversed;
        report.reclassified = applied.reclassified;
        report.merged = applied.merged;

        // The deterministic invariants have the last word, whatever the verifier said.
        let verified = validate::validate_edges(&objects, applied.accepted)?;
        // All-or-nothing. Edges that already exist (e.g. after a correction) are skipped.
        let kept = verified.len();
        let added = store.record_relations(verified, "model").map_err(from_model_proposal)?;
        report.skipped_existing += kept - added.len();
        report.added = added.len();
        done(added, report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::capture_store::CreateCaptureInput;
    use crate::storage::knowledge_store::NewKnowledgeObject;
    use crate::storage::relation_store::canonical_ends;
    use super::verify::{Confidence, Decision, Support, Verdict};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    type Proposed = Result<Vec<RelationCandidate>, RelationError>;

    struct FakeProposer {
        result: Mutex<Proposed>,
        calls: AtomicUsize,
        saw: Mutex<Vec<(Vec<String>, usize)>>,
    }

    impl FakeProposer {
        fn returning(result: Proposed) -> Arc<Self> {
            Arc::new(Self { result: Mutex::new(result), calls: AtomicUsize::new(0), saw: Mutex::new(Vec::new()) })
        }
        fn set(&self, result: Proposed) {
            *self.result.lock().unwrap() = result;
        }
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl RelationProposer for FakeProposer {
        fn propose<'a>(&'a self, objects: &'a [KnowledgeObject], existing: &'a [Relation]) -> BoxFuture<'a, Proposed> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.saw.lock().unwrap().push((objects.iter().map(|o| o.title.clone()).collect(), existing.len()));
                self.result.lock().unwrap().clone()
            })
        }
    }

    /// Three captures, one object each, like the acceptance scenario.
    fn scenario() -> (CaptureStore, Vec<KnowledgeObject>) {
        let store = CaptureStore::open_in_memory().unwrap();
        let mut objects = Vec::new();
        for (text, title) in [
            ("I want Arthur to organize ideas automatically.", "Arthur organizes ideas"),
            ("The Cognitive Graph should connect related ideas instead of showing flat notes.", "Graph connects ideas"),
            ("Before Graph inference works, Thought Distillation has to create KnowledgeObjects.", "Distillation first"),
        ] {
            let capture = store.create(CreateCaptureInput { source: "text".into(), content: text.into() }).unwrap();
            let length = text.chars().count() as i64;
            objects.extend(store.record_distillation(&capture.id, vec![NewKnowledgeObject { kind: "idea".into(), title: title.into(), body: text.into(), source_start: 0, source_end: length }]).unwrap());
        }
        (store, objects)
    }

    fn proposal(kind: &str, source: &str, target: &str) -> RelationCandidate {
        RelationCandidate { source_object_id: source.into(), target_object_id: target.into(), kind: kind.into(), reason: "because".into() }
    }

    type Script = Box<dyn Fn(&[VerifyCandidate]) -> Result<Vec<Verdict>, RelationError> + Send + Sync>;
    use super::verify::Presentation as Order;

    struct FakeVerifier {
        script: Mutex<Script>,
        calls: AtomicUsize,
        saw: Mutex<Vec<Vec<VerifyCandidate>>>,
        orders: Mutex<Vec<Order>>,
    }

    impl FakeVerifier {
        fn scripted(script: Script) -> Arc<Self> {
            Arc::new(Self { script: Mutex::new(script), calls: AtomicUsize::new(0), saw: Mutex::new(Vec::new()), orders: Mutex::new(Vec::new()) })
        }
        /// Confirms every candidate exactly as proposed, with high confidence.
        fn confirming() -> Arc<Self> {
            Self::scripted(Box::new(|candidates| Ok(candidates.iter().map(Verdict::confirming).collect())))
        }
        fn set(&self, script: Script) {
            *self.script.lock().unwrap() = script;
        }
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl RelationVerifier for FakeVerifier {
        fn verify<'a>(&'a self, candidates: &'a [VerifyCandidate], presentation: Order) -> BoxFuture<'a, Result<Vec<Verdict>, RelationError>> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.orders.lock().unwrap().push(presentation);
                self.saw.lock().unwrap().push(candidates.to_vec());
                (self.script.lock().unwrap())(candidates)
            })
        }
    }

    fn service(result: Proposed) -> (GraphService, Arc<FakeProposer>) {
        let (service, proposer, _verifier) = service_with(result, FakeVerifier::confirming());
        (service, proposer)
    }

    fn service_with(result: Proposed, verifier: Arc<FakeVerifier>) -> (GraphService, Arc<FakeProposer>, Arc<FakeVerifier>) {
        let proposer = FakeProposer::returning(result);
        (GraphService::new(proposer.clone(), verifier.clone()), proposer, verifier)
    }

    fn run(service: &GraphService, store: &CaptureStore, ids: &[String]) -> Result<Vec<Relation>, RelationError> {
        tauri::async_runtime::block_on(service.infer(store, ids))
    }

    fn relation_count(store: &CaptureStore) -> usize {
        store.list_relations().unwrap().len()
    }

    #[test]
    fn a_sensible_proposal_is_validated_persisted_and_marked_as_model_origin() {
        let (store, o) = scenario();
        let (service, fake) = service(Ok(vec![proposal("extends", &o[1].id, &o[0].id), proposal("depends_on", &o[1].id, &o[2].id)]));

        let added = run(&service, &store, &[]).unwrap();

        assert_eq!(added.len(), 2);
        assert!(added.iter().all(|r| r.origin == "model"));
        assert_eq!((added[0].kind.as_str(), added[0].source_object_id.as_str(), added[0].target_object_id.as_str()), ("extends", o[1].id.as_str(), o[0].id.as_str()), "direction is kept");
        assert_eq!(store.list_relations().unwrap(), added);
        assert_eq!(fake.calls(), 1);
    }

    #[test]
    fn the_model_sees_only_knowledge_objects_and_never_the_raw_captures() {
        let (store, _o) = scenario();
        let (service, fake) = service(Ok(vec![]));
        run(&service, &store, &[]).unwrap();
        let saw = fake.saw.lock().unwrap();
        assert_eq!(saw[0].0.len(), 3);
        assert_eq!(saw[0].1, 0, "no relations existed yet");
    }

    #[test]
    fn zero_relations_is_a_valid_result_and_writes_nothing() {
        let (store, _o) = scenario();
        let (service, fake) = service(Ok(vec![]));
        assert_eq!(run(&service, &store, &[]).unwrap(), vec![]);
        assert_eq!(relation_count(&store), 0);
        assert_eq!(fake.calls(), 1);
    }

    #[test]
    fn fewer_than_two_objects_means_nothing_to_relate_and_the_model_is_not_called() {
        let store = CaptureStore::open_in_memory().unwrap();
        let (service, fake) = service(Ok(vec![]));
        assert_eq!(run(&service, &store, &[]).unwrap(), vec![]);

        let (store, _o) = {
            let store = CaptureStore::open_in_memory().unwrap();
            let capture = store.create(CreateCaptureInput { source: "text".into(), content: "one thought".into() }).unwrap();
            let objects = store.record_distillation(&capture.id, vec![NewKnowledgeObject { kind: "idea".into(), title: "t".into(), body: "b".into(), source_start: 0, source_end: 3 }]).unwrap();
            (store, objects)
        };
        assert_eq!(run(&service, &store, &[]).unwrap(), vec![]);
        assert_eq!(fake.calls(), 0);
    }

    #[test]
    fn hallucinated_object_ids_reject_the_whole_set() {
        let (store, o) = scenario();
        let ghost = "00000000-0000-4000-8000-000000000000";
        for bad in [proposal("extends", &o[1].id, ghost), proposal("extends", ghost, &o[0].id), proposal("extends", "obj-7", &o[0].id)] {
            let (service, _fake) = service(Ok(vec![proposal("extends", &o[1].id, &o[0].id), bad]));
            let error = run(&service, &store, &[]).unwrap_err();
            assert_eq!(error.code(), "llm_invalid_output");
            assert_eq!(relation_count(&store), 0, "the valid candidate was not written either");
        }
    }

    #[test]
    fn an_existing_object_outside_the_candidate_set_is_rejected_too() {
        let limit = candidates::MAX_INFERENCE_CANDIDATES;
        let (store, objects) = many_objects(limit + 5);
        // The oldest object exists in the database but falls outside the most-recent window.
        let (service, _fake) = service(Ok(vec![proposal("related_to", &objects[limit + 4].id, &objects[0].id)]));

        assert_eq!(run(&service, &store, &[]).unwrap_err().code(), "llm_invalid_output");
        assert_eq!(relation_count(&store), 0);
    }

    #[test]
    fn self_relations_invalid_kinds_and_unsupported_kinds_are_rejected() {
        let (store, o) = scenario();
        for bad in [proposal("extends", &o[0].id, &o[0].id), proposal("friends_with", &o[0].id, &o[1].id), proposal("", &o[0].id, &o[1].id), proposal("Extends", &o[0].id, &o[1].id)] {
            let (service, _fake) = service(Ok(vec![bad]));
            assert_eq!(run(&service, &store, &[]).unwrap_err().code(), "llm_invalid_output");
        }
        assert_eq!(relation_count(&store), 0);
    }

    #[test]
    fn duplicate_candidates_are_rejected_including_a_symmetric_pair_stated_both_ways() {
        let (store, o) = scenario();
        for duplicated in [
            vec![proposal("extends", &o[1].id, &o[0].id), proposal("extends", &o[1].id, &o[0].id)],
            vec![proposal("related_to", &o[1].id, &o[0].id), proposal("related_to", &o[0].id, &o[1].id)],
            vec![proposal("duplicates", &o[1].id, &o[0].id), proposal("duplicates", &o[0].id, &o[1].id)],
        ] {
            let (service, _fake) = service(Ok(duplicated));
            assert_eq!(run(&service, &store, &[]).unwrap_err().code(), "llm_invalid_output");
            assert_eq!(relation_count(&store), 0);
        }
        // Opposite directions of a directional kind are two different edges.
        let (service, _fake) = service(Ok(vec![proposal("depends_on", &o[1].id, &o[0].id), proposal("depends_on", &o[0].id, &o[1].id)]));
        assert_eq!(run(&service, &store, &[]).unwrap().len(), 2);
    }

    #[test]
    fn a_symmetric_proposal_is_stored_in_canonical_order_whichever_way_the_model_stated_it() {
        let (store, o) = scenario();
        let (low, high) = canonical_ends("related_to", &o[0].id, &o[1].id);
        // The model states the edge "backwards" relative to the canonical order.
        let (service, fake) = service(Ok(vec![proposal("related_to", &high, &low)]));

        let stored = run(&service, &store, &[]).unwrap();
        assert_eq!((stored[0].source_object_id.as_str(), stored[0].target_object_id.as_str()), (low.as_str(), high.as_str()));

        // Stating it the other way round on a later run is the same edge: nothing is added.
        fake.set(Ok(vec![proposal("related_to", &low, &high)]));
        assert_eq!(run(&service, &store, &[]).unwrap(), vec![]);
        assert_eq!(relation_count(&store), 1);
    }

    #[test]
    fn one_invalid_candidate_among_valid_ones_writes_nothing() {
        let (store, o) = scenario();
        let (service, _fake) = service(Ok(vec![proposal("extends", &o[1].id, &o[0].id), proposal("depends_on", &o[1].id, &o[2].id), proposal("extends", &o[2].id, &o[2].id)]));
        assert!(run(&service, &store, &[]).is_err());
        assert_eq!(relation_count(&store), 0);
    }

    #[test]
    fn a_database_failure_during_the_write_leaves_no_partial_run() {
        let (store, o) = scenario();
        store.execute_sql_for_test("CREATE TRIGGER poison BEFORE INSERT ON relations WHEN NEW.kind = 'depends_on' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
        let (service, _fake) = service(Ok(vec![proposal("extends", &o[1].id, &o[0].id), proposal("depends_on", &o[1].id, &o[2].id)]));
        assert_eq!(run(&service, &store, &[]).unwrap_err().code(), "storage_failed");
        assert_eq!(relation_count(&store), 0);
    }

    #[test]
    fn running_inference_twice_adds_nothing_the_second_time() {
        let (store, o) = scenario();
        let (service, fake) = service(Ok(vec![proposal("extends", &o[1].id, &o[0].id), proposal("related_to", &o[0].id, &o[2].id)]));

        let first = run(&service, &store, &[]).unwrap();
        let second = run(&service, &store, &[]).unwrap();

        assert_eq!(first.len(), 2);
        assert_eq!(second, vec![], "the model proposed the same edges again; they already exist");
        assert_eq!(store.list_relations().unwrap(), first);
        assert_eq!(fake.saw.lock().unwrap()[1].1, 2, "the second run told the model which edges already exist");
    }

    #[test]
    fn a_manual_edge_is_not_duplicated_or_re_attributed_by_inference() {
        let (store, o) = scenario();
        let manual = create_manual_relation(&store, NewRelation { kind: "extends".into(), source_object_id: o[1].id.clone(), target_object_id: o[0].id.clone() }).unwrap();
        let (service, _fake) = service(Ok(vec![proposal("extends", &o[1].id, &o[0].id), proposal("depends_on", &o[1].id, &o[2].id)]));

        let added = run(&service, &store, &[]).unwrap();

        assert_eq!(added.iter().map(|r| r.kind.as_str()).collect::<Vec<_>>(), ["depends_on"]);
        let all = store.list_relations().unwrap();
        assert_eq!(all[0], manual);
        assert_eq!((all[0].origin.as_str(), all[1].origin.as_str()), ("user", "model"));
    }

    #[test]
    fn a_provider_failure_stores_nothing_and_can_be_retried() {
        let (store, o) = scenario();
        let (service, fake) = service(Err(RelationError::Network));
        assert_eq!(run(&service, &store, &[]).unwrap_err().code(), "llm_failed");
        assert_eq!(relation_count(&store), 0);

        fake.set(Ok(vec![proposal("extends", &o[1].id, &o[0].id)]));
        assert_eq!(run(&service, &store, &[]).unwrap().len(), 1);
    }

    #[test]
    fn requested_objects_must_exist_and_be_well_formed() {
        let (store, o) = scenario();
        let (service, fake) = service(Ok(vec![]));
        assert_eq!(run(&service, &store, &["00000000-0000-4000-8000-000000000000".into()]).unwrap_err(), RelationError::ObjectNotFound);
        assert_eq!(run(&service, &store, &["nope".into()]).unwrap_err().code(), "invalid_relation");
        assert_eq!(run(&service, &store, &[o[0].id.clone()]).unwrap(), vec![]);
        assert_eq!(fake.calls(), 1, "only the valid request reached the model");
    }

    /// `count` single-object captures. Returns the objects oldest first.
    fn many_objects(count: usize) -> (CaptureStore, Vec<KnowledgeObject>) {
        let store = CaptureStore::open_in_memory().unwrap();
        let mut objects = Vec::new();
        for index in 0..count {
            let text = format!("thought number {index}");
            let capture = store.create(CreateCaptureInput { source: "text".into(), content: text.clone() }).unwrap();
            let length = text.chars().count() as i64;
            objects.extend(store.record_distillation(&capture.id, vec![NewKnowledgeObject { kind: "note".into(), title: format!("object {index}"), body: text, source_start: 0, source_end: length }]).unwrap());
        }
        (store, objects)
    }

    #[test]
    fn the_candidate_set_is_the_most_recent_objects_up_to_a_hard_limit() {
        let limit = candidates::MAX_INFERENCE_CANDIDATES;
        let (store, objects) = many_objects(limit + 10);
        let (service, fake) = service(Ok(vec![]));
        run(&service, &store, &[]).unwrap();

        let saw = fake.saw.lock().unwrap();
        assert_eq!(saw[0].0.len(), limit);
        // Newest distillations first: the ten oldest objects are left out.
        let oldest: Vec<String> = objects.iter().take(10).map(|o| o.title.clone()).collect();
        assert!(saw[0].0.iter().all(|title| !oldest.contains(title)));
        assert_eq!(saw[0].0[0], format!("object {}", limit + 9));
    }

    #[test]
    fn requested_objects_are_always_included_and_the_limit_still_holds() {
        let limit = candidates::MAX_INFERENCE_CANDIDATES;
        let (store, objects) = many_objects(limit + 10);
        let (service, fake) = service(Ok(vec![]));
        run(&service, &store, &[objects[0].id.clone(), objects[1].id.clone()]).unwrap();

        let titles = &fake.saw.lock().unwrap()[0].0;
        assert_eq!(titles.len(), limit);
        assert!(titles.contains(&"object 0".to_string()) && titles.contains(&"object 1".to_string()), "the oldest two were asked for");
        assert!(!titles.contains(&"object 2".to_string()), "the next-oldest was not, and it does not fit");
    }

    #[test]
    fn asking_about_more_objects_than_the_limit_is_rejected_before_any_model_call() {
        let (store, objects) = many_objects(candidates::MAX_INFERENCE_CANDIDATES + 2);
        let (service, fake) = service(Ok(vec![]));
        let ids: Vec<String> = objects.iter().map(|o| o.id.clone()).collect();
        assert_eq!(run(&service, &store, &ids).unwrap_err().code(), "invalid_relation");
        assert_eq!(fake.calls(), 0);
    }

    #[test]
    fn too_many_proposals_are_rejected() {
        let (store, o) = scenario();
        let many = (0..=crate::storage::relation_store::MAX_RELATIONS_PER_BATCH).map(|_| proposal("extends", &o[0].id, &o[1].id)).collect();
        let (service, _fake) = service(Ok(many));
        assert_eq!(run(&service, &store, &[]).unwrap_err().code(), "llm_invalid_output");
    }

    #[test]
    fn manual_creation_reports_invalid_and_missing_objects_distinctly() {
        let (store, o) = scenario();
        let make = |kind: &str, a: &str, b: &str| create_manual_relation(&store, NewRelation { kind: kind.into(), source_object_id: a.into(), target_object_id: b.into() });
        assert_eq!(make("extends", &o[0].id, &o[0].id).unwrap_err().code(), "invalid_relation");
        assert_eq!(make("nope", &o[0].id, &o[1].id).unwrap_err().code(), "invalid_relation");
        assert_eq!(make("extends", "bad", &o[1].id).unwrap_err().code(), "invalid_relation");
        assert_eq!(make("extends", &o[0].id, "00000000-0000-4000-8000-000000000000").unwrap_err(), RelationError::ObjectNotFound);
        let made = make("supersedes", &o[1].id, &o[0].id).unwrap();
        assert_eq!(made.origin, "user");
        assert_eq!(make("supersedes", &o[1].id, &o[0].id).unwrap(), made, "idempotent");
    }

    #[test]
    fn errors_serialize_to_the_contract_shape_and_leak_nothing() {
        let value = serde_json::to_value(RelationError::NotConfigured).unwrap();
        assert_eq!(value, serde_json::json!({ "code": "llm_not_configured", "message": "The language model is not configured on this device." }));
        for error in [
            RelationError::ObjectNotFound,
            RelationError::InvalidRelation("x".into()),
            RelationError::Network,
            RelationError::Auth(401),
            RelationError::Provider(500),
            RelationError::Refused,
            RelationError::Storage("x".into()),
            RelationError::InvalidOutput("y".into()),
        ] {
            let message = error.message();
            assert!(!message.contains("sk-"), "{message}");
        }
    }

    // --- Stage B pipeline -----------------------------------------------------------------------

    fn reverse(candidate: &VerifyCandidate) -> Verdict {
        Verdict { source_object_id: candidate.target.id.clone(), target_object_id: candidate.source.id.clone(), ..Verdict::confirming(candidate) }
    }

    fn report_of(service: &GraphService, store: &CaptureStore) -> InferenceReport {
        tauri::async_runtime::block_on(service.infer_with_report(store, &[])).unwrap().report
    }

    #[test]
    fn a_dependency_proposed_backwards_is_corrected_and_the_reverse_edge_is_never_stored() {
        let (store, o) = scenario();
        // o[1] = "Graph connects ideas", o[2] = "Distillation first". Graph inference depends on distillation.
        // Stage A gets it backwards.
        let verifier = FakeVerifier::scripted(Box::new(|cs| Ok(cs.iter().map(reverse).collect())));
        let (service, _proposer, _verifier) = service_with(Ok(vec![proposal("depends_on", &o[2].id, &o[1].id)]), verifier);

        let inference = tauri::async_runtime::block_on(service.infer_with_report(&store, &[])).unwrap();

        let stored = store.list_relations().unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!((stored[0].kind.as_str(), stored[0].source_object_id.as_str(), stored[0].target_object_id.as_str()), ("depends_on", o[1].id.as_str(), o[2].id.as_str()));
        assert!(!stored.iter().any(|r| r.source_object_id == o[2].id && r.kind == "depends_on"), "the inverted edge does not exist");
        assert_eq!((inference.report.reversed, inference.report.added, inference.report.rejected), (1, 1, 0));
    }

    #[test]
    fn an_ambiguous_or_unsupported_direction_writes_nothing() {
        let (store, o) = scenario();
        let verifier = FakeVerifier::scripted(Box::new(|cs| Ok(cs.iter().map(|c| Verdict { reverse_support: Support::Strong, ..Verdict::confirming(c) }).collect())));
        let (service, _p, _v) = service_with(Ok(vec![proposal("depends_on", &o[2].id, &o[1].id)]), verifier);
        let report = report_of(&service, &store);
        assert_eq!((report.rejected, report.added), (1, 0));
        assert_eq!(relation_count(&store), 0);
    }

    #[test]
    fn the_verifier_can_reclassify_a_vague_relation_to_a_stronger_kind() {
        let (store, o) = scenario();
        // The verifier decides o[1] extends o[0], whichever way round Stage A (and the random ids) put the pair.
        let (develops, developed) = (o[1].id.clone(), o[0].id.clone());
        let verifier = FakeVerifier::scripted(Box::new(move |cs| {
            Ok(cs.iter().map(|c| Verdict { decision: Decision::Reclassify, kind: "extends".into(), source_object_id: develops.clone(), target_object_id: developed.clone(), ..Verdict::confirming(c) }).collect())
        }));
        let (service, _p, _v) = service_with(Ok(vec![proposal("related_to", &o[0].id, &o[1].id)]), verifier);

        let report = report_of(&service, &store);

        let stored = store.list_relations().unwrap();
        assert_eq!((stored[0].kind.as_str(), stored[0].source_object_id.as_str(), stored[0].target_object_id.as_str()), ("extends", o[1].id.as_str(), o[0].id.as_str()));
        assert_eq!((report.reclassified, report.added), (1, 1));
    }

    #[test]
    fn weak_candidates_are_rejected_and_do_not_block_the_strong_one() {
        let (store, o) = scenario();
        // Stage A is tempted by a generic same-project pair (related_to) and also finds a real dependency.
        let proposals = vec![proposal("related_to", &o[0].id, &o[1].id), proposal("depends_on", &o[1].id, &o[2].id), proposal("extends", &o[0].id, &o[2].id)];
        let verifier = FakeVerifier::scripted(Box::new(|cs| {
            Ok(cs
                .iter()
                .map(|c| match c.kind.as_str() {
                    "related_to" => Verdict { explicit_link: false, confidence: Confidence::Medium, ..Verdict::confirming(c) },
                    "extends" => Verdict { decision: Decision::Reject, ..Verdict::confirming(c) },
                    _ => Verdict::confirming(c),
                })
                .collect())
        }));
        let (service, _p, _v) = service_with(Ok(proposals), verifier);

        let inference = tauri::async_runtime::block_on(service.infer_with_report(&store, &[])).unwrap();

        assert_eq!(inference.relations.iter().map(|r| r.kind.as_str()).collect::<Vec<_>>(), ["depends_on"]);
        assert_eq!(inference.report, InferenceReport { proposed: 3, skipped_existing: 0, verified: 3, rejected: 2, reversed: 0, reclassified: 0, merged: 0, added: 1, provider_requests: 3 });
    }

    #[test]
    fn unrelated_objects_give_zero_relations() {
        let (store, _o) = scenario();
        let (service, _p, verifier) = service_with(Ok(vec![]), FakeVerifier::confirming());
        let report = report_of(&service, &store);
        assert_eq!((report.added, report.provider_requests), (0, 1), "nothing proposed, so nothing to verify");
        assert_eq!(verifier.calls(), 0);
    }

    #[test]
    fn medium_and_low_confidence_never_persist() {
        let (store, o) = scenario();
        for confidence in [Confidence::Medium, Confidence::Low] {
            let verifier = FakeVerifier::scripted(Box::new(move |cs| Ok(cs.iter().map(|c| Verdict { confidence, ..Verdict::confirming(c) }).collect())));
            let (service, _p, _v) = service_with(Ok(vec![proposal("extends", &o[1].id, &o[0].id)]), verifier);
            assert_eq!(report_of(&service, &store).added, 0);
            assert_eq!(relation_count(&store), 0);
        }
    }

    #[test]
    fn a_provider_failure_while_verifying_writes_nothing_and_can_be_retried() {
        let (store, o) = scenario();
        let verifier = FakeVerifier::scripted(Box::new(|_| Err(RelationError::Network)));
        let (service, _p, verifier) = service_with(Ok(vec![proposal("extends", &o[1].id, &o[0].id), proposal("depends_on", &o[1].id, &o[2].id)]), verifier);

        let error = run(&service, &store, &[]).unwrap_err();

        assert_eq!(error.code(), "llm_failed");
        assert_eq!(relation_count(&store), 0, "zero partial state");
        verifier.set(Box::new(|cs| Ok(cs.iter().map(Verdict::confirming).collect())));
        assert_eq!(run(&service, &store, &[]).unwrap().len(), 2, "a retry just works");
    }

    #[test]
    fn malformed_verifier_output_is_a_technical_failure_with_zero_writes() {
        let (store, o) = scenario();
        let ghost = "00000000-0000-4000-8000-000000000000";
        let cases: Vec<Script> = vec![
            Box::new(|_| Ok(vec![])),
            Box::new(move |cs| Ok(cs.iter().map(|c| Verdict { source_object_id: ghost.into(), ..Verdict::confirming(c) }).collect())),
            Box::new(|cs| Ok(cs.iter().map(|c| Verdict { kind: "friends_with".into(), ..Verdict::confirming(c) }).collect())),
            Box::new(|cs| Ok(cs.iter().map(|c| Verdict { index: 99, ..Verdict::confirming(c) }).collect())),
        ];
        for script in cases {
            let verifier = FakeVerifier::scripted(script);
            let (service, _p, _v) = service_with(Ok(vec![proposal("extends", &o[1].id, &o[0].id), proposal("depends_on", &o[1].id, &o[2].id)]), verifier);
            assert_eq!(run(&service, &store, &[]).unwrap_err().code(), "llm_invalid_output");
            assert_eq!(relation_count(&store), 0);
        }
    }

    #[test]
    fn the_final_write_stays_atomic_after_verification() {
        let (store, o) = scenario();
        store.execute_sql_for_test("CREATE TRIGGER poison BEFORE INSERT ON relations WHEN NEW.kind = 'depends_on' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
        let (service, _p) = service(Ok(vec![proposal("extends", &o[1].id, &o[0].id), proposal("depends_on", &o[1].id, &o[2].id)]));
        assert_eq!(run(&service, &store, &[]).unwrap_err().code(), "storage_failed");
        assert_eq!(relation_count(&store), 0);
    }

    #[test]
    fn already_existing_edges_are_not_verified_again_and_a_repeat_costs_one_request() {
        let (store, o) = scenario();
        let (service, proposer, verifier) = service_with(Ok(vec![proposal("extends", &o[1].id, &o[0].id)]), FakeVerifier::confirming());
        assert_eq!(report_of(&service, &store).provider_requests, 3);

        let repeat = tauri::async_runtime::block_on(service.infer_with_report(&store, &[])).unwrap();

        assert_eq!(repeat.relations, vec![]);
        assert_eq!((repeat.report.skipped_existing, repeat.report.verified, repeat.report.provider_requests), (1, 0, 1));
        assert_eq!((proposer.calls(), verifier.calls()), (2, 2), "the two votes of the first run only: the verifier was not asked about an edge that already exists");
        assert_eq!(relation_count(&store), 1);
    }

    #[test]
    fn a_correction_that_lands_on_an_existing_edge_adds_nothing() {
        let (store, o) = scenario();
        create_manual_relation(&store, NewRelation { kind: "depends_on".into(), source_object_id: o[1].id.clone(), target_object_id: o[2].id.clone() }).unwrap();
        let verifier = FakeVerifier::scripted(Box::new(|cs| Ok(cs.iter().map(reverse).collect())));
        let (service, _p, _v) = service_with(Ok(vec![proposal("depends_on", &o[2].id, &o[1].id)]), verifier);

        let inference = tauri::async_runtime::block_on(service.infer_with_report(&store, &[])).unwrap();

        assert_eq!((inference.report.reversed, inference.report.added, inference.report.skipped_existing), (1, 0, 1));
        assert_eq!(relation_count(&store), 1);
        assert_eq!(store.list_relations().unwrap()[0].origin, "user");
    }

    #[test]
    fn the_verifier_sees_only_the_objects_of_the_candidates_and_only_what_is_needed() {
        let (store, o) = scenario();
        let (service, _p, verifier) = service_with(Ok(vec![proposal("extends", &o[1].id, &o[0].id)]), FakeVerifier::confirming());
        run(&service, &store, &[]).unwrap();

        let saw = verifier.saw.lock().unwrap();
        assert_eq!(saw.len(), 2, "two votes");
        assert_eq!(*verifier.orders.lock().unwrap(), [Order::LowerIdFirst, Order::HigherIdFirst], "listed in opposite orders");
        assert_eq!(saw[0].len(), 1);
        let ids: Vec<&str> = vec![saw[0][0].source.id.as_str(), saw[0][0].target.id.as_str()];
        assert_eq!(ids, [o[1].id.as_str(), o[0].id.as_str()], "the third object was not sent");
        assert_eq!(saw[0][0].kind, "extends");
    }

    #[test]
    fn a_direction_the_two_votes_disagree_on_is_not_persisted() {
        // The failure seen with the real model: a correct proposal that one verifier sample "corrects" wrongly.
        // Vote 1 (lower id listed first) flips it, vote 2 (higher id first) does not.
        let (store, o) = scenario();
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let verifier = FakeVerifier::scripted(Box::new(move |cs| {
            let vote = counter.fetch_add(1, Ordering::SeqCst);
            Ok(cs.iter().map(|c| if vote == 0 { reverse(c) } else { Verdict::confirming(c) }).collect())
        }));
        let (service, _p, _v) = service_with(Ok(vec![proposal("depends_on", &o[1].id, &o[2].id)]), verifier);

        let inference = tauri::async_runtime::block_on(service.infer_with_report(&store, &[])).unwrap();

        assert_eq!(inference.relations, vec![]);
        assert_eq!((inference.report.rejected, inference.report.added, inference.report.provider_requests), (1, 0, 3));
        assert_eq!(relation_count(&store), 0, "neither orientation is stored");
    }

    #[test]
    fn two_votes_that_agree_on_a_correction_persist_only_the_corrected_edge() {
        let (store, o) = scenario();
        let verifier = FakeVerifier::scripted(Box::new(|cs| Ok(cs.iter().map(reverse).collect())));
        let (service, _p, verifier) = service_with(Ok(vec![proposal("depends_on", &o[2].id, &o[1].id)]), verifier);
        let inference = tauri::async_runtime::block_on(service.infer_with_report(&store, &[])).unwrap();
        assert_eq!((inference.relations[0].source_object_id.as_str(), inference.report.reversed), (o[1].id.as_str(), 1));
        assert_eq!(verifier.calls(), 2);
    }

    #[test]
    fn a_failure_in_the_second_vote_also_writes_nothing() {
        let (store, o) = scenario();
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let verifier = FakeVerifier::scripted(Box::new(move |cs| {
            if counter.fetch_add(1, Ordering::SeqCst) == 0 { Ok(cs.iter().map(Verdict::confirming).collect()) } else { Err(RelationError::Network) }
        }));
        let (service, _p, _v) = service_with(Ok(vec![proposal("extends", &o[1].id, &o[0].id)]), verifier);
        assert_eq!(run(&service, &store, &[]).unwrap_err().code(), "llm_failed");
        assert_eq!(relation_count(&store), 0);
    }

    #[test]
    fn a_run_is_bounded_candidates_proposals_verifications_and_provider_requests() {
        let limit = candidates::MAX_INFERENCE_CANDIDATES;
        let (store, objects) = many_objects(limit + 10);
        let newest: Vec<&KnowledgeObject> = objects.iter().rev().take(limit).collect();
        // Propose as many valid relations as are allowed: a chain through the candidate window.
        let proposals: Vec<RelationCandidate> = (0..MAX_RELATION_PROPOSALS).map(|i| proposal("extends", &newest[i].id, &newest[i + 1].id)).collect();
        let (service, proposer, verifier) = service_with(Ok(proposals), FakeVerifier::confirming());

        let inference = tauri::async_runtime::block_on(service.infer_with_report(&store, &[])).unwrap();

        assert!(proposer.saw.lock().unwrap()[0].0.len() <= limit, "candidate objects");
        assert_eq!(inference.report.proposed, MAX_RELATION_PROPOSALS);
        assert!(verifier.saw.lock().unwrap()[0].len() <= MAX_RELATION_PROPOSALS, "verifications");
        assert_eq!(proposer.calls() + verifier.calls(), MAX_PROVIDER_REQUESTS_PER_RUN);
        assert_eq!(inference.report.provider_requests, MAX_PROVIDER_REQUESTS_PER_RUN);
        assert_eq!(inference.relations.len(), MAX_RELATION_PROPOSALS);

        // One proposal over the cap is rejected before the verifier is ever called.
        let (store, objects) = many_objects(limit + 10);
        let ordered: Vec<&KnowledgeObject> = objects.iter().rev().take(limit).collect();
        let too_many: Vec<RelationCandidate> = (0..=MAX_RELATION_PROPOSALS).map(|i| proposal("extends", &ordered[i].id, &ordered[i + 1].id)).collect();
        let (service, proposer, verifier) = service_with(Ok(too_many), FakeVerifier::confirming());
        assert_eq!(run(&service, &store, &[]).unwrap_err().code(), "llm_invalid_output");
        assert_eq!((proposer.calls(), verifier.calls()), (1, 0));
    }

    #[test]
    fn no_run_can_exceed_three_provider_requests_however_the_stages_behave() {
        let (store, o) = scenario();
        for result in [Ok(vec![]), Ok(vec![proposal("extends", &o[1].id, &o[0].id)]), Err(RelationError::Network)] {
            let (service, proposer, verifier) = service_with(result, FakeVerifier::confirming());
            let _ = run(&service, &store, &[]);
            let _ = run(&service, &store, &[]);
            assert!(proposer.calls() <= 2 && verifier.calls() <= 4, "one proposal and two votes per run, over two runs");
            assert!(proposer.calls() + verifier.calls() <= 2 * MAX_PROVIDER_REQUESTS_PER_RUN);
        }
    }

    /// Opt-in: calls the real OpenAI API, several times, on one controlled dataset, and prints what
    /// each stage did. Run with
    /// `ARTHUR_LIVE_KEY_FILE=/path/to/key ARTHUR_LIVE_RUNS=5 cargo test live_ -- --ignored --nocapture`.
    #[test]
    #[ignore = "calls the real OpenAI API; set ARTHUR_LIVE_KEY_FILE"]
    fn live_inference_on_a_controlled_dataset_is_stable_and_directionally_correct() {
        use crate::graph::openai::{OpenAiRelationProposer, OpenAiRelationVerifier};
        use crate::providers::credentials::FileCredentialSource;

        let key_file = std::env::var("ARTHUR_LIVE_KEY_FILE").expect("ARTHUR_LIVE_KEY_FILE");
        let runs: usize = std::env::var("ARTHUR_LIVE_RUNS").ok().and_then(|v| v.parse().ok()).unwrap_or(3);
        let credentials = Arc::new(FileCredentialSource::new(key_file.into()));
        // Wrappers record what each stage really said in THIS run, so the printout is not a different sample.
        struct Recording<T> {
            inner: T,
            proposed: Mutex<Vec<RelationCandidate>>,
            verdicts: Mutex<Vec<Verdict>>,
        }
        impl RelationProposer for Recording<OpenAiRelationProposer> {
            fn propose<'a>(&'a self, objects: &'a [KnowledgeObject], existing: &'a [Relation]) -> BoxFuture<'a, Proposed> {
                Box::pin(async move {
                    let result = self.inner.propose(objects, existing).await;
                    if let Ok(candidates) = &result {
                        *self.proposed.lock().unwrap() = candidates.clone();
                    }
                    result
                })
            }
        }
        impl RelationVerifier for Recording<OpenAiRelationVerifier> {
            fn verify<'a>(&'a self, candidates: &'a [VerifyCandidate], presentation: Order) -> BoxFuture<'a, Result<Vec<Verdict>, RelationError>> {
                Box::pin(async move {
                    let result = self.inner.verify(candidates, presentation).await;
                    if let Ok(verdicts) = &result {
                        self.verdicts.lock().unwrap().extend(verdicts.iter().cloned());
                    }
                    result
                })
            }
        }
        let endpoint = crate::providers::chat::DEFAULT_ENDPOINT;
        let model = |name: &str, default: &str| std::env::var(name).unwrap_or_else(|_| default.to_string());
        let proposer_model = model("ARTHUR_LIVE_PROPOSER_MODEL", crate::providers::chat::DEFAULT_MODEL);
        let verifier_model = model("ARTHUR_LIVE_VERIFIER_MODEL", crate::graph::openai::VERIFIER_MODEL);
        println!("proposer model: {proposer_model} / verifier model: {verifier_model}");
        println!("approx. fixed prompt size: Stage A ~{} tokens, Stage B ~{} tokens per request (plus ~100 tokens per object/candidate)", prompt::system_prompt().len() / 4, verify_prompt::system_prompt().len() / 4);
        let proposer = Arc::new(Recording { inner: OpenAiRelationProposer::with_endpoint(credentials.clone(), endpoint, &proposer_model).unwrap(), proposed: Mutex::new(vec![]), verdicts: Mutex::new(vec![]) });
        let verifier = Arc::new(Recording { inner: OpenAiRelationVerifier::with_endpoint(credentials, endpoint, &verifier_model).unwrap(), proposed: Mutex::new(vec![]), verdicts: Mutex::new(vec![]) });
        let service = GraphService::new(proposer.clone(), verifier.clone());

        type Row = (&'static str, &'static str, &'static str);
        /// (name, objects, forbidden edges as (kind, source title contains, target title contains))
        struct Dataset {
            name: &'static str,
            objects: Vec<Row>,
            /// Edges that must NEVER be persisted: a reversed direction, or a weak catch-all.
            forbidden: Vec<(&'static str, &'static str, &'static str)>,
            /// Edges that would be correct (reported, not required).
            wanted: Vec<(&'static str, &'static str, &'static str)>,
        }
        let datasets = vec![
            Dataset {
                name: "A: the M02 acceptance objects plus weak same-project pairs",
                objects: vec![
                    ("note", "Thought Distillation must create KnowledgeObjects before graph inference", "Thought Distillation must create KnowledgeObjects before graph inference works."),
                    ("idea", "Cognitive Graph connects related ideas", "The Cognitive Graph should connect related ideas instead of showing flat notes."),
                    ("idea", "Arthur should organize ideas automatically", "I want Arthur to organize ideas automatically."),
                    ("idea", "Improve Arthur capture screen", "I want to improve the Arthur capture screen."),
                    ("task", "Email Ignatov about the competition", "Tomorrow I need to email Ignatov about the competition."),
                    ("idea", "Add vibration confirmation to wristband", "The idea is to add vibration confirmation to the wristband."),
                    ("decision", "Wristband prototype vibrates when recording starts", "The wristband prototype should vibrate when recording starts."),
                ],
                forbidden: vec![("depends_on", "Thought Distillation", "Cognitive Graph"), ("related_to", "capture screen", "organize ideas"), ("related_to", "organize ideas", "capture screen")],
                wanted: vec![("depends_on", "Cognitive Graph", "Thought Distillation")],
            },
            Dataset {
                name: "B: relations stated explicitly in the objects' own text",
                objects: vec![
                    ("idea", "Build the Arthur mobile app", "I want to build the Arthur mobile app for Android."),
                    ("task", "Create the local SQLite capture store", "The mobile app cannot save anything until the local SQLite capture store exists, so I have to build the store first."),
                    ("decision", "Use Tailscale for Home Node sync", "We decided to use Tailscale for the Home Node sync."),
                    ("decision", "Replace Tailscale with a LAN-only link", "Update: we are dropping Tailscale; Home Node sync will use a LAN-only WebSocket connection instead."),
                    ("idea", "Add haptic feedback when recording starts", "Add haptic feedback to the wristband when recording starts."),
                    ("idea", "Wristband should vibrate when recording starts", "The wristband should vibrate as soon as recording starts."),
                    ("task", "Email Ignatov about the competition", "Tomorrow I need to email Ignatov about the competition."),
                ],
                forbidden: vec![
                    ("depends_on", "SQLite capture store", "mobile app"),
                    ("supersedes", "Use Tailscale", "Replace Tailscale"),
                    ("depends_on", "Use Tailscale", "Replace Tailscale"),
                    ("related_to", "Email Ignatov", ""),
                    ("related_to", "", "Email Ignatov"),
                ],
                wanted: vec![("depends_on", "mobile app", "SQLite capture store"), ("supersedes", "Replace Tailscale", "Use Tailscale"), ("duplicates", "haptic", "vibrate")],
            },
        ];

        let mut totals = InferenceReport::default();
        let mut violations = Vec::new();
        let mut found_wanted = 0usize;
        let mut possible_wanted = 0usize;
        for dataset in &datasets {
            println!("\n##### dataset {}", dataset.name);
            for run in 1..=runs {
                let store = CaptureStore::open_in_memory().unwrap();
                let mut objects = Vec::new();
                for (kind, title, text) in &dataset.objects {
                    let capture = store.create(CreateCaptureInput { source: "text".into(), content: (*text).into() }).unwrap();
                    let length = text.chars().count() as i64;
                    objects.extend(store.record_distillation(&capture.id, vec![NewKnowledgeObject { kind: (*kind).into(), title: (*title).into(), body: (*text).into(), source_start: 0, source_end: length }]).unwrap());
                }
                let title = |id: &str| objects.iter().find(|o| o.id == id).map(|o| o.title.clone()).unwrap();
                proposer.proposed.lock().unwrap().clear();
                verifier.verdicts.lock().unwrap().clear();
                println!("\n=== run {run} ({}) ===", &dataset.name[..1]);

                match tauri::async_runtime::block_on(service.infer_with_report(&store, &[])) {
                    Ok(inference) => {
                        println!("Stage A proposed {}:", proposer.proposed.lock().unwrap().len());
                        for c in proposer.proposed.lock().unwrap().iter() {
                            println!("  A: {} --{}--> {}", title(&c.source_object_id), c.kind, title(&c.target_object_id));
                        }
                        for v in verifier.verdicts.lock().unwrap().iter() {
                            println!("  B: #{} {:?} {} {} -> {}  conf={:?} fwd={:?} rev={:?} explicit={}", v.index, v.decision, v.kind, title(&v.source_object_id), title(&v.target_object_id), v.confidence, v.forward_support, v.reverse_support, v.explicit_link);
                        }
                        println!("persisted {} (report {:?})", inference.relations.len(), inference.report);
                        let matches = |r: &Relation, rule: &(&str, &str, &str)| r.kind == rule.0 && title(&r.source_object_id).contains(rule.1) && title(&r.target_object_id).contains(rule.2);
                        for r in &inference.relations {
                            println!("  KEPT {} --{}--> {}", title(&r.source_object_id), r.kind, title(&r.target_object_id));
                            if dataset.forbidden.iter().any(|rule| matches(r, rule)) {
                                violations.push(format!("{} run {run}: forbidden edge persisted: {} --{}--> {}", &dataset.name[..1], title(&r.source_object_id), r.kind, title(&r.target_object_id)));
                            }
                        }
                        possible_wanted += dataset.wanted.len();
                        // Symmetric kinds are stored in canonical order, so match either way round for them.
                        found_wanted += dataset.wanted.iter().filter(|rule| inference.relations.iter().any(|r| matches(r, rule) || (crate::storage::relation_store::is_symmetric(rule.0) && r.kind == rule.0 && title(&r.source_object_id).contains(rule.2) && title(&r.target_object_id).contains(rule.1)))).count();
                        let (t, r) = (&mut totals, &inference.report);
                        (t.proposed, t.skipped_existing, t.verified, t.rejected, t.reversed, t.reclassified, t.merged, t.added, t.provider_requests) =
                            (t.proposed + r.proposed, t.skipped_existing + r.skipped_existing, t.verified + r.verified, t.rejected + r.rejected, t.reversed + r.reversed, t.reclassified + r.reclassified, t.merged + r.merged, t.added + r.added, t.provider_requests + r.provider_requests);
                    }
                    Err(error) => {
                        println!("run ERROR {error}");
                        possible_wanted += dataset.wanted.len();
                    }
                }
            }
        }
        println!("\nWANTED edges found: {found_wanted} of {possible_wanted} possible (informational)");
        println!("\nTOTALS over {runs} runs per dataset: {totals:?}");
        println!("VIOLATIONS: {violations:?}");
        assert!(violations.is_empty(), "{violations:?}");
        assert!(totals.provider_requests <= 2 * runs * MAX_PROVIDER_REQUESTS_PER_RUN);
    }
}
