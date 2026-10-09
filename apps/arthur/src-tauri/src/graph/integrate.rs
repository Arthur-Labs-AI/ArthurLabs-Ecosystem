//! The decision pipeline of Automatic Graph Integration: ONE changed object, a bounded candidate pool, and (when its meaning changed)
//! the model relations it already has.
//!
//! This is the M02.1 multiclass strategy (M04.7A.5), narrowed to one changed object and hardened by the M04.7A.1-.4 findings. A binary
//! "judge every kind independently" variant was built and measured (M04.7A.2-.4); it was not better and was removed. The history is in
//! `docs/architecture/m047a-automatic-graph-integration.md`.
//!
//! ```text
//! focus object + <= 12 discovered candidates (+ the other ends of <= 8 model relations to revalidate)
//!   -> Stage A  propose the best supported relation for the focus object, or none                         [request 1]
//!   -> validate structure, keep only proposals that touch the focus, drop edges that already exist, <= 8
//!   -> Stage B  ONE batch = the proposals + the model relations being revalidated; the verifier judges the kind AND the
//!               direction of each, twice, with the pair listed in opposite orders                          [requests 2, 3]
//!   -> judge    the M02.1 gates and the unanimity rule decide which claims SURVIVE (a survivor may be a corrected kind)
//!   -> resolve  per pair, deterministically (`resolve.rs`): 0 survivors -> no edge, 1 -> persist, several -> persist nothing
//!   -> decide   add / remove / replace
//! ```
//!
//! At most `MAX_PROVIDER_REQUESTS_PER_RUN` (3) normal provider requests per integration; a contract-invalid Stage B response may be
//! re-requested (`MAX_CONTRACT_RETRIES` per pass), counted apart. This module only DECIDES; the guarded atomic write is
//! `CaptureStore::apply_integration`.
//!
//! Safety rules kept from the redesign work:
//! * direction comes from the verifier's two orientation ratings and the order they were SENT in, never from Stage A or id order;
//! * a `related_to` is never the fallback of a failed typed claim: a typed proposal that the verifier turns into `related_to`, or a
//!   `related_to` that survives for a pair where a typed relation was claimed or exists, is not persisted;
//! * an existing model `depends_on` is removed only on grounded, two-pass evidence that the dependent's own plan is cancelled or that
//!   its requirement changed; a lone rejection, an unavailable prerequisite, a pause or a lower priority never deletes it;
//! * a new `depends_on` of a plan that its own text cancels is never created;
//! * every other kind is kept only while both passes support it; user relations are never passed in.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::storage::knowledge_store::KnowledgeObject;
use crate::storage::relation_store::{canonical_ends, NewRelation, Relation};

use super::resolve::{resolve, Resolution};
use super::validate::validate_edges;
use super::verify::{combine, dependency_requirement_gone, dependent_plan_cancelled, judge_each, Judgement, Outcome, Presentation, VerifyCandidate};
use super::{GraphService, RelationError, MAX_PROVIDER_REQUESTS_PER_RUN};

/// Stage A proposals that are verified per integration. Mirrors `MAX_INTEGRATION_PROPOSALS` in `packages/contracts/cognitive.ts`.
pub const MAX_INTEGRATION_PROPOSALS: usize = 8;
/// Model relations re-checked when an object's meaning changed. Any others are left untouched until the next change.
pub const MAX_REVALIDATIONS: usize = 8;
/// Extra Stage B requests allowed per verification pass when a response is contract-invalid. Never retried because a well-formed verdict
/// disagrees with anything. When they run out the integration fails (deferred), it is not completed, and the graph is not touched.
pub const MAX_CONTRACT_RETRIES: usize = 2;

/// One model relation to re-check, with the object at its OTHER end.
pub struct Revalidation {
    pub relation: Relation,
    pub other: KnowledgeObject,
}

pub struct IntegrationInput<'a> {
    pub focus: &'a KnowledgeObject,
    /// Discovered nominees: the pool new relations may be proposed against.
    pub candidates: &'a [KnowledgeObject],
    pub revalidate: &'a [Revalidation],
    /// Every relation (any origin) among the focus, the candidates and the revalidation ends. Context for Stage A and the dedupe.
    pub existing: &'a [Relation],
    /// `object id -> when its CURRENT text was last written` (the current revision's `created_at`). Context for the verifier only.
    pub written_at: &'a HashMap<String, String>,
    /// Counts of what the stages did (never text). `None` for callers that do not keep diagnostics.
    pub diagnostics: Option<&'a super::diagnostics::IntegrationDiagnostics>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DecisionReport {
    /// Positive Stage A claims on the focus object (before the cap and the dedupe).
    pub proposed: usize,
    /// Claims that did not touch the focus object (discarded).
    pub off_focus: usize,
    /// Proposals beyond `MAX_INTEGRATION_PROPOSALS` (discarded).
    pub truncated: usize,
    pub skipped_existing: usize,
    /// Claims sent to Stage B (new positives + revalidations).
    pub verified: usize,
    /// Claims that did not survive both passes.
    pub rejected: usize,
    /// Claims that survived both passes (before resolution).
    pub survived: usize,
    /// Pairs with more than one surviving relation and no proven-safe way to choose: nothing new was persisted for them.
    pub surviving_pairs: usize,
    pub ambiguous_pairs: usize,
    /// Surviving claims that were dropped because of such an ambiguity.
    pub ambiguous_dropped: usize,
    pub kept: usize,
    pub replaced: usize,
    pub removed: usize,
    /// New `depends_on` claims blocked because a pass said the dependent's own plan is cancelled (no relation is created for it).
    /// `related_to` survivors NOT persisted because a typed claim for the same pair failed verification (or a typed relation already exists).
    pub related_suppressed: usize,
    pub moot_blocked: usize,
    /// Existing model `depends_on` edges removed because BOTH passes said the dependent's own plan is cancelled, with grounded evidence.
    pub moot_removed: usize,
    /// Existing `depends_on` edges where only ONE pass said so: retained.
    pub moot_unresolved: usize,
    /// Existing `depends_on` edges removed because BOTH passes rejected the dependency and gave grounded evidence that the requirement itself
    /// changed (not that the prerequisite became unavailable).
    pub dependency_invalidated: usize,
    /// Existing `depends_on` edges kept because one pass supports them, or both rejected without grounded evidence of a changed requirement.
    pub dependency_unresolved: usize,
    /// The normal budget: one Stage A request and the two Stage B passes. Never more than `MAX_PROVIDER_REQUESTS_PER_RUN`.
    pub provider_requests: usize,
    /// Stage B responses that broke the output contract (unparseable, or a cancellation claim without evidence). Each is counted, including
    /// the ones whose retry succeeded.
    pub contract_invalid: usize,
    /// Extra Stage B requests made only because a response was contract-invalid (at most `MAX_CONTRACT_RETRIES` per pass). Exceptional, so
    /// counted apart from `provider_requests`.
    pub retry_requests: usize,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Decision {
    pub add: Vec<NewRelation>,
    /// Ids of model relations to delete (removed and replaced ones).
    pub remove: Vec<String>,
    pub report: DecisionReport,
}

type Identity = (String, String, String);

fn identity(kind: &str, source: &str, target: &str) -> Identity {
    let (source, target) = canonical_ends(kind, source, target);
    (kind.to_string(), source, target)
}

fn identity_of(edge: &NewRelation) -> Identity {
    identity(&edge.kind, &edge.source_object_id, &edge.target_object_id)
}

impl GraphService {
    /// One Stage B pass. A response that breaks the output contract is re-requested, a bounded number of times; anything else (a provider
    /// failure, or a well-formed verdict of any kind) is returned as it is.
    async fn verify_pass(
        &self,
        candidates: &[VerifyCandidate],
        presentation: Presentation,
        report: &mut DecisionReport,
        diagnostics: Option<&super::diagnostics::IntegrationDiagnostics>,
    ) -> Result<Vec<super::verify::Verdict>, RelationError> {
        let mut retries = 0;
        loop {
            if let Some(d) = diagnostics {
                d.stage_b_attempted();
            }
            match self.verifier.verify(candidates, presentation).await {
                Err(RelationError::InvalidOutput(_)) if retries < MAX_CONTRACT_RETRIES => {
                    retries += 1;
                    report.contract_invalid += 1;
                    report.retry_requests += 1;
                    if let Some(d) = diagnostics {
                        d.stage_b_failed(true);
                    }
                }
                other => {
                    if let Some(d) = diagnostics {
                        match &other {
                            Ok(_) => d.stage_b_succeeded(),
                            Err(error) => d.stage_b_failed(matches!(error, RelationError::InvalidOutput(_))),
                        }
                    }
                    return other;
                }
            }
        }
    }

    pub async fn decide_integration(&self, input: IntegrationInput<'_>) -> Result<Decision, RelationError> {
        let mut report = DecisionReport::default();
        let focus_id = input.focus.id.as_str();

        // Every object the provider may be shown, each once: the focus, the discovered pool, the revalidation ends.
        let mut objects: Vec<KnowledgeObject> = vec![input.focus.clone()];
        for object in input.candidates.iter().chain(input.revalidate.iter().map(|item| &item.other)) {
            if !objects.iter().any(|known| known.id == object.id) {
                objects.push(object.clone());
            }
        }
        let by_id = |id: &str| objects.iter().find(|object| object.id == id).cloned().ok_or_else(|| RelationError::InvalidOutput("refers to an object that was not supplied".into()));
        let known: HashSet<Identity> = input.existing.iter().map(|r| identity(&r.kind, &r.source_object_id, &r.target_object_id)).collect();
        let other_end = |edge: &NewRelation| if edge.source_object_id == focus_id { edge.target_object_id.clone() } else { edge.source_object_id.clone() };

        // Stage A: the best supported relation for the focus object, or none.
        let mut fresh: Vec<NewRelation> = Vec::new();
        let mut typed_claimed: HashSet<String> = HashSet::new();
        // Pairs that already have a typed relation (any origin): a bare `related_to` adds nothing there.
        let typed_existing: HashSet<String> = input.existing.iter().filter(|r| r.kind != "related_to" && (r.source_object_id == focus_id || r.target_object_id == focus_id)).map(|r| relation_other_end(r, focus_id)).collect();
        if objects.len() >= 2 {
            report.provider_requests += 1;
            if let Some(d) = input.diagnostics {
                d.stage_a_attempted();
            }
            let claims = match self.proposer.propose_for(focus_id, &objects, input.existing).await {
                Ok(claims) => claims,
                Err(error) => {
                    if let Some(d) = input.diagnostics {
                        d.stage_a_failed(matches!(error, RelationError::InvalidOutput(_)));
                    }
                    return Err(error);
                }
            };
            let edges = claims.into_iter().map(|p| NewRelation { kind: p.kind, source_object_id: p.source_object_id, target_object_id: p.target_object_id }).collect();
            let claims = match validate_edges(&objects, edges) {
                Ok(claims) => claims,
                Err(error) => {
                    if let Some(d) = input.diagnostics {
                        d.stage_a_failed(true);
                    }
                    return Err(error);
                }
            };
            if let Some(d) = input.diagnostics {
                d.stage_a_succeeded();
            }
            let (on_focus, off_focus): (Vec<NewRelation>, Vec<NewRelation>) = claims.into_iter().partition(|edge| edge.source_object_id == focus_id || edge.target_object_id == focus_id);
            report.off_focus = off_focus.len();
            report.proposed = on_focus.len();
            // Pairs for which Stage A claimed a stronger, typed relation. If that claim fails verification, `related_to` must not take its place.
            typed_claimed.extend(on_focus.iter().filter(|edge| edge.kind != "related_to").map(&other_end));
            let (new, existing): (Vec<NewRelation>, Vec<NewRelation>) = on_focus.into_iter().partition(|edge| !known.contains(&identity_of(edge)));
            report.skipped_existing = existing.len();
            report.truncated = new.len().saturating_sub(MAX_INTEGRATION_PROPOSALS);
            fresh = new.into_iter().take(MAX_INTEGRATION_PROPOSALS).collect();
        }

        // Stage B: the positives and the relations being revalidated share ONE batch (two votes in total).
        let mut to_verify: Vec<VerifyCandidate> = Vec::with_capacity(fresh.len() + input.revalidate.len());
        for edge in &fresh {
            to_verify.push(VerifyCandidate { index: to_verify.len(), source: by_id(&edge.source_object_id)?, target: by_id(&edge.target_object_id)?, kind: edge.kind.clone(), source_written_at: input.written_at.get(&edge.source_object_id).cloned(), target_written_at: input.written_at.get(&edge.target_object_id).cloned() });
        }
        let first_revalidation = to_verify.len();
        for item in input.revalidate {
            let relation = &item.relation;
            to_verify.push(VerifyCandidate { index: to_verify.len(), source: by_id(&relation.source_object_id)?, target: by_id(&relation.target_object_id)?, kind: relation.kind.clone(), source_written_at: input.written_at.get(&relation.source_object_id).cloned(), target_written_at: input.written_at.get(&relation.target_object_id).cloned() });
        }
        report.verified = to_verify.len();
        if to_verify.is_empty() {
            return Ok(Decision { add: vec![], remove: vec![], report });
        }
        report.provider_requests += 1;
        let first = self.verify_pass(&to_verify, Presentation::LowerIdFirst, &mut report, input.diagnostics).await?;
        report.provider_requests += 1;
        let second = self.verify_pass(&to_verify, Presentation::HigherIdFirst, &mut report, input.diagnostics).await?;
        debug_assert!(report.provider_requests <= MAX_PROVIDER_REQUESTS_PER_RUN);
        // Direction-aware structured signals for `depends_on`, read from the RAW verdicts before they are reduced to judgements. The dependent is
        // the object that was said to NEED the other: for an existing relation that is its source, for a new claim the source of the edge the
        // pass actually named.
        #[derive(Clone, Copy, Default)]
        struct Signal {
            plan_cancelled: bool,
            requirement_gone: bool,
        }
        let mut signals = vec![vec![Signal::default(); to_verify.len()]; 2];
        for (vote, verdicts) in [&first, &second].into_iter().enumerate() {
            for verdict in verdicts {
                let Some(candidate) = to_verify.get(verdict.index) else { continue };
                if verdict.kind != "depends_on" {
                    continue;
                }
                let dependent = if verdict.index >= first_revalidation {
                    &candidate.source
                } else if verdict.source_object_id == candidate.source.id {
                    &candidate.source
                } else {
                    &candidate.target
                };
                signals[vote][verdict.index] = Signal { plan_cancelled: dependent_plan_cancelled(verdict, dependent), requirement_gone: dependency_requirement_gone(verdict, dependent) };
            }
        }
        let votes = match judge_each(&to_verify, vec![first, second]) {
            Ok(votes) => votes,
            Err(error) => {
                if let Some(d) = input.diagnostics {
                    d.stage_b_failed(true);
                }
                return Err(error);
            }
        };

        // Which claims survived both passes, grouped by the pair they are about (the OTHER object; the focus is always one end).
        let mut survivors: BTreeMap<String, Vec<NewRelation>> = BTreeMap::new();
        let mut supported_existing: HashSet<String> = HashSet::new();
        // Existing `depends_on` edges: removed (and why), or kept although no pass-pair fully supports them.
        let mut removed_dependencies: HashSet<String> = HashSet::new();
        let mut held_dependencies: HashSet<String> = HashSet::new();
        // Pairs where no NEW relation may be added this round.
        let mut no_new_edge: HashSet<String> = HashSet::new();
        for position in 0..to_verify.len() {
            let about: Vec<&Judgement> = votes.iter().map(|vote| &vote[position]).collect();
            let outcome = combine(&about);
            if position < first_revalidation {
                match outcome {
                    Outcome::Keep(edge) => {
                        if edge.kind == "related_to" && to_verify[position].kind != "related_to" {
                            // The verifier turned a typed proposal into the weaker `related_to`. A rejected typed relation is never converted.
                            report.related_suppressed += 1;
                            report.rejected += 1;
                            continue;
                        }
                        if edge.kind == "depends_on" && (signals[0][position].plan_cancelled || signals[1][position].plan_cancelled) {
                            // A NEW dependency of a plan that its own text cancels is never created (so a retracted edge cannot come straight back).
                            report.moot_blocked += 1;
                            report.rejected += 1;
                            continue;
                        }
                        report.survived += 1;
                        survivors.entry(other_end(&edge)).or_default().push(edge);
                    }
                    Outcome::Reject(_) | Outcome::Disagree => report.rejected += 1,
                }
                continue;
            }

            let relation = &input.revalidate[position - first_revalidation].relation;
            let pair = relation_other_end(relation, focus_id);
            if relation.kind != "depends_on" {
                // Every other kind keeps the independently tested rule: it stays only if both passes support it.
                if let Outcome::Keep(edge) = outcome {
                    report.survived += 1;
                    if identity_of(&edge) == identity(&relation.kind, &relation.source_object_id, &relation.target_object_id) {
                        supported_existing.insert(relation.id.clone());
                    }
                    survivors.entry(other_end(&edge)).or_default().push(edge);
                } else {
                    report.rejected += 1;
                }
                continue;
            }

            // `depends_on` (M04.7A.3). A rejecting pass alone never deletes an authoritative dependency.
            let this = identity(&relation.kind, &relation.source_object_id, &relation.target_object_id);
            let supports = votes.iter().filter(|vote| matches!(&vote[position], Judgement::Keep(edge) if identity_of(edge) == this)).count();
            let cancelled_both = signals[0][position].plan_cancelled && signals[1][position].plan_cancelled;
            let gone_both = supports == 0 && signals[0][position].requirement_gone && signals[1][position].requirement_gone;
            if cancelled_both {
                // Case 1: both passes confirm the DEPENDENT's own current text cancels its plan. The edge goes; nothing replaces it.
                removed_dependencies.insert(relation.id.clone());
                no_new_edge.insert(pair);
                report.moot_removed += 1;
            } else if gone_both {
                // Case 2: both passes reject the dependency AND give grounded evidence that the requirement itself changed.
                removed_dependencies.insert(relation.id.clone());
                report.dependency_invalidated += 1;
            } else if supports == votes.len() {
                if signals[0][position].plan_cancelled || signals[1][position].plan_cancelled {
                    report.moot_unresolved += 1;
                }
                report.survived += 1;
                supported_existing.insert(relation.id.clone());
                if let Outcome::Keep(edge) = outcome {
                    survivors.entry(other_end(&edge)).or_default().push(edge);
                }
            } else {
                // One pass supports it, or both reject without grounded evidence that the requirement changed (an unavailable or failed
                // prerequisite is still a prerequisite): retained, unresolved. Nothing new is chosen for this pair meanwhile.
                held_dependencies.insert(relation.id.clone());
                no_new_edge.insert(pair);
                report.dependency_unresolved += 1;
                if supports + usize::from(signals[0][position].plan_cancelled) + usize::from(signals[1][position].plan_cancelled) > 0 {
                    report.moot_unresolved += usize::from(signals[0][position].plan_cancelled || signals[1][position].plan_cancelled);
                }
            }
        }

        report.surviving_pairs = survivors.len();

        // Resolve pair by pair.
        let mut pairs: HashSet<String> = survivors.keys().cloned().collect();
        pairs.extend(input.revalidate.iter().map(|item| item.other.id.clone()));
        let mut add: Vec<NewRelation> = Vec::new();
        let mut remove: Vec<String> = Vec::new();
        let mut pairs: Vec<String> = pairs.into_iter().collect();
        pairs.sort();
        for pair in pairs {
            let existing_here: Vec<&Relation> = input.revalidate.iter().filter(|item| item.other.id == pair).map(|item| &item.relation).collect();
            let resolution = resolve(survivors.remove(&pair).unwrap_or_default());
            // The relations on this pair that the resolution keeps as they are.
            let mut kept_here: Vec<&Relation> = Vec::new();
            match &resolution {
                Resolution::None => {}
                Resolution::Persist(edge) => {
                    if let Some(same) = existing_here.iter().find(|r| identity(&r.kind, &r.source_object_id, &r.target_object_id) == identity_of(edge)) {
                        kept_here.push(same);
                    } else if edge.kind == "related_to" && (typed_claimed.contains(&pair) || typed_existing.contains(&pair)) {
                        // M04.7A.4 relation specificity: a stronger typed relation was claimed (or already exists) for this pair, and only the
                        // weaker `related_to` survived. A failed typed verification is never converted into a weaker relation.
                        report.related_suppressed += 1;
                    } else if !known.contains(&identity_of(edge)) && !no_new_edge.contains(&pair) {
                        add.push(edge.clone());
                    }
                }
                Resolution::Ambiguous(list) => {
                    report.ambiguous_pairs += 1;
                    // A relation that is itself still positively supported stays; nothing new is chosen between the survivors.
                    kept_here.extend(existing_here.iter().filter(|r| supported_existing.contains(&r.id)));
                    report.ambiguous_dropped += list.len().saturating_sub(kept_here.len());
                }
            }
            let replaced_here = !add.is_empty() && matches!(resolution, Resolution::Persist(_)) && add.last().is_some_and(|edge| other_end(edge) == pair);
            for relation in existing_here {
                if removed_dependencies.contains(&relation.id) {
                    remove.push(relation.id.clone());
                } else if held_dependencies.contains(&relation.id) || kept_here.iter().any(|kept| kept.id == relation.id) {
                    report.kept += 1;
                } else {
                    remove.push(relation.id.clone());
                    if replaced_here {
                        report.replaced += 1;
                    } else {
                        report.removed += 1;
                    }
                }
            }
        }
        // The deterministic invariants have the last word, whatever the verifier said.
        let add = validate_edges(&objects, add)?;
        Ok(Decision { add, remove, report })
    }
}

fn relation_other_end(relation: &Relation, focus_id: &str) -> String {
    if relation.source_object_id == focus_id { relation.target_object_id.clone() } else { relation.source_object_id.clone() }
}
