//! Behavioural tests of Automatic Graph Integration against a real store built through the real write paths, with a SCRIPTED model.
//!
//! The double is not a language model. It answers from a declared set of facts ("these edges hold"), so these tests prove the
//! pipeline's policy (what is admitted, protected, removed, retried, bounded), not the quality of a real model's judgement. That is
//! measured only by the live tier (`graph::integration_bench`, ignored).

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::integration::*;
use super::verify::{Confidence, Decision, Presentation, RelationVerifier, Support, Verdict, VerifyCandidate};
use super::{GraphService, RelationCandidate, RelationError, RelationProposer};
use crate::async_util::BoxFuture;
use crate::recall::settings::SemanticSettings;
use crate::recall::testing::{run, ConceptEmbedder, Lab};
use crate::recall::RecallService;
use crate::storage::knowledge_store::KnowledgeObject;
use crate::storage::relation_store::{canonical_ends, Relation};

/// An edge the world holds: `(kind, source title contains, target title contains)`.
pub type Fact = (&'static str, &'static str, &'static str);

/// Stage A and Stage B in one scripted object. Verdicts follow `facts`; everything else is rejected.
pub struct Double {
    pub facts: Mutex<Vec<Fact>>,
    /// Extra proposals that are NOT facts (weak or wrong), by `(kind, source contains, target contains)`.
    pub noise: Mutex<Vec<Fact>>,
    /// Propose directional facts the wrong way round.
    pub reverse_proposals: Mutex<bool>,
    /// In the first vote, state directional facts the wrong way round (the two votes then disagree).
    pub flip_first_vote: Mutex<bool>,
    /// Errors returned by the next provider calls, in order.
    pub fail_with: Mutex<Vec<RelationError>>,
    /// Errors returned by the next Stage B (verifier) requests only, in order.
    pub fail_verifier: Mutex<Vec<RelationError>>,
    pub proposer_calls: AtomicUsize,
    pub verifier_calls: AtomicUsize,
    pub pools: Mutex<Vec<Vec<String>>>,
    pub verified: Mutex<Vec<Vec<(String, String, String)>>>,
    /// Called once at the start of Stage A (to simulate the world changing while a provider call is in flight).
    pub during_provider_call: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    /// Replaces the scripted verdict of every candidate (to build votes that disagree in specific ways).
    /// When a scripted `depends_on` claim is rejected because the world no longer holds it, also say (with evidence taken from the dependent's own
    /// title) that its REQUIREMENT changed. Off by default: an unexplained rejection must not delete an authoritative dependency.
    pub requirement_gone: Mutex<bool>,
    pub vote_override: Mutex<Option<Box<dyn Fn(&VerifyCandidate, Presentation) -> Verdict + Send + Sync>>>,
    pub active: AtomicUsize,
    pub max_active: AtomicUsize,
}

impl Double {
    pub fn new(facts: &[Fact]) -> Arc<Self> {
        Arc::new(Self {
            facts: Mutex::new(facts.to_vec()),
            noise: Mutex::new(vec![]),
            reverse_proposals: Mutex::new(false),
            flip_first_vote: Mutex::new(false),
            fail_with: Mutex::new(vec![]),
            fail_verifier: Mutex::new(vec![]),
            proposer_calls: AtomicUsize::new(0),
            verifier_calls: AtomicUsize::new(0),
            pools: Mutex::new(vec![]),
            verified: Mutex::new(vec![]),
            during_provider_call: Mutex::new(None),
            requirement_gone: Mutex::new(false),
            vote_override: Mutex::new(None),
            active: AtomicUsize::new(0),
            max_active: AtomicUsize::new(0),
        })
    }

    pub fn calls(&self) -> usize {
        self.proposer_calls.load(Ordering::SeqCst) + self.verifier_calls.load(Ordering::SeqCst)
    }

    pub fn set_facts(&self, facts: &[Fact]) {
        *self.facts.lock().unwrap() = facts.to_vec();
    }

    fn enter(&self) {
        let now = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(now, Ordering::SeqCst);
    }

    fn leave(&self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }

    fn next_failure(&self) -> Option<RelationError> {
        let mut failures = self.fail_with.lock().unwrap();
        (!failures.is_empty()).then(|| failures.remove(0))
    }

    fn find<'a>(objects: &'a [KnowledgeObject], needle: &str) -> Vec<&'a KnowledgeObject> {
        objects.iter().filter(|o| !needle.is_empty() && o.title.contains(needle)).collect()
    }

    fn edges_among(&self, objects: &[KnowledgeObject], list: &[Fact]) -> Vec<RelationCandidate> {
        let mut out = Vec::new();
        for (kind, source, target) in list {
            for s in Self::find(objects, source) {
                for t in Self::find(objects, target) {
                    if s.id != t.id {
                        out.push(RelationCandidate { source_object_id: s.id.clone(), target_object_id: t.id.clone(), kind: (*kind).into(), reason: "scripted".into() });
                    }
                }
            }
        }
        out
    }
}

impl RelationProposer for Double {
    fn propose<'a>(&'a self, objects: &'a [KnowledgeObject], _existing: &'a [Relation]) -> BoxFuture<'a, Result<Vec<RelationCandidate>, RelationError>> {
        Box::pin(async move {
            self.proposer_calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.edges_among(objects, &self.facts.lock().unwrap()))
        })
    }

    fn propose_for<'a>(&'a self, focus_id: &'a str, objects: &'a [KnowledgeObject], _existing: &'a [Relation]) -> BoxFuture<'a, Result<Vec<RelationCandidate>, RelationError>> {
        Box::pin(async move {
            self.enter();
            self.proposer_calls.fetch_add(1, Ordering::SeqCst);
            self.pools.lock().unwrap().push(objects.iter().map(|o| o.id.clone()).collect());
            if let Some(hook) = self.during_provider_call.lock().unwrap().as_ref() {
                hook();
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
            self.leave();
            if let Some(error) = self.next_failure() {
                return Err(error);
            }
            // Deliberately NOT narrowed to the focus object: the pipeline must filter, whatever the proposer does.
            let _ = focus_id;
            let mut proposed = self.edges_among(objects, &self.facts.lock().unwrap());
            if *self.reverse_proposals.lock().unwrap() {
                for edge in proposed.iter_mut().filter(|e| !crate::storage::relation_store::is_symmetric(&e.kind)) {
                    std::mem::swap(&mut edge.source_object_id, &mut edge.target_object_id);
                }
            }
            proposed.extend(self.edges_among(objects, &self.noise.lock().unwrap()));
            Ok(proposed)
        })
    }
}

impl RelationVerifier for Double {
    fn verify<'a>(&'a self, candidates: &'a [VerifyCandidate], presentation: Presentation) -> BoxFuture<'a, Result<Vec<Verdict>, RelationError>> {
        Box::pin(async move {
            self.enter();
            self.verifier_calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(2)).await;
            self.leave();
            {
                let mut queue = self.fail_verifier.lock().unwrap();
                if !queue.is_empty() {
                    return Err(queue.remove(0));
                }
            }
            if let Some(error) = self.next_failure() {
                return Err(error);
            }
            if presentation == Presentation::LowerIdFirst {
                self.verified.lock().unwrap().push(candidates.iter().map(|c| (c.kind.clone(), c.source.title.clone(), c.target.title.clone())).collect());
            }
            if let Some(script) = self.vote_override.lock().unwrap().as_ref() {
                return Ok(candidates.iter().map(|candidate| script(candidate, presentation)).collect());
            }
            let facts = self.facts.lock().unwrap().clone();
            let flip = *self.flip_first_vote.lock().unwrap() && presentation == Presentation::LowerIdFirst;
            Ok(candidates
                .iter()
                .map(|candidate| {
                    let mut holding: Option<(&str, &KnowledgeObject, &KnowledgeObject)> = None;
                    for (kind, source, target) in &facts {
                        for (a, b) in [(&candidate.source, &candidate.target), (&candidate.target, &candidate.source)] {
                            if a.title.contains(source) && b.title.contains(target) && (*kind == candidate.kind || holding.is_none()) {
                                // Prefer the fact whose kind the candidate proposed.
                                holding = Some((kind, a, b));
                            }
                        }
                    }
                    match holding {
                        Some((kind, mut source, mut target)) => {
                            if flip && !crate::storage::relation_store::is_symmetric(kind) {
                                std::mem::swap(&mut source, &mut target);
                            }
                            Verdict {
                                index: candidate.index,
                                decision: if kind == candidate.kind { Decision::Accept } else { Decision::Reclassify },
                                kind: kind.into(),
                                source_object_id: source.id.clone(),
                                target_object_id: target.id.clone(),
                                confidence: Confidence::High,
                                forward_support: Support::Strong,
                                reverse_support: Support::None,
                                explicit_link: true,
                                cancels_or_obsoletes: false,
                                temporal_evidence: None,
                                cancelled_plan_object_id: None,
                                dependency_no_longer_required: false,
                            }
                        }
                        None if candidate.kind == "depends_on" && *self.requirement_gone.lock().unwrap() => Verdict {
                            index: candidate.index,
                            decision: Decision::Reject,
                            kind: candidate.kind.clone(),
                            source_object_id: candidate.source.id.clone(),
                            target_object_id: candidate.target.id.clone(),
                            confidence: Confidence::High,
                            forward_support: Support::None,
                            reverse_support: Support::None,
                            explicit_link: false,
                            cancels_or_obsoletes: false,
                            temporal_evidence: Some(format!("{} no longer needs it.", candidate.source.title)),
                            cancelled_plan_object_id: None,
                            dependency_no_longer_required: true,
                        },
                        None => Verdict {
                            index: candidate.index,
                            decision: Decision::Reject,
                            kind: candidate.kind.clone(),
                            source_object_id: candidate.source.id.clone(),
                            target_object_id: candidate.target.id.clone(),
                            confidence: Confidence::Low,
                            forward_support: Support::None,
                            reverse_support: Support::None,
                            explicit_link: false,
                            cancels_or_obsoletes: false,
                            temporal_evidence: None,
                            cancelled_plan_object_id: None,
                            dependency_no_longer_required: false,
                        },
                    }
                })
                .collect())
        })
    }
}

pub struct Rig {
    pub lab: Arc<Lab>,
    pub double: Arc<Double>,
    pub service: IntegrationService,
    pub recall: RecallService,
    pub embedder: Arc<ConceptEmbedder>,
    pub project: String,
    _dir: tempfile::TempDir,
}

impl Rig {
    pub fn new(facts: &[Fact]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let embedder = Arc::new(ConceptEmbedder::new(64, &[]));
        let recall = RecallService::new(embedder.clone(), Arc::new(SemanticSettings::new(dir.path().join("semantic.json"))));
        let double = Double::new(facts);
        let service = IntegrationService::new(GraphService::new(double.clone(), double.clone()), IntegrationSettings::in_memory(true), Ledger::in_memory());
        let lab = Arc::new(Lab::new());
        let project = lab.project("Arthur");
        Self { lab, double, service, recall, embedder, project, _dir: dir }
    }

    pub fn add(&self, kind: &str, title: &str, body: &str) -> String {
        self.lab.object(&self.project, kind, title, body)
    }

    pub fn created(&self, object_id: &str) -> ChangedKnowledge {
        ChangedKnowledge::created(object_id, &self.lab.current_revision(object_id))
    }

    pub fn integrate(&self, change: ChangedKnowledge) -> IntegrationReport {
        run(self.service.integrate(&self.lab.store, &self.recall, change))
    }

    /// Edit, then report the change exactly as the command layer does.
    pub fn edit(&self, object_id: &str, title: Option<&str>, body: Option<&str>) -> ChangedKnowledge {
        let before = self.lab.current_revision(object_id);
        let after = self.lab.edit(object_id, title, body);
        ChangedKnowledge::revised(object_id, &before, &after)
    }

    pub fn relations(&self) -> Vec<Relation> {
        self.lab.store.list_relations().unwrap()
    }

    pub fn title_of(&self, id: &str) -> String {
        self.lab.store.get_knowledge_object(id).unwrap().unwrap().title
    }

    /// `kind source -> target` for every relation, by title, sorted.
    pub fn edges(&self) -> Vec<String> {
        let mut edges: Vec<String> = self.relations().iter().map(|r| format!("{} {} -> {} [{}]", r.kind, self.title_of(&r.source_object_id), self.title_of(&r.target_object_id), r.origin)).collect();
        edges.sort();
        edges
    }
}

fn base(rig: &Rig) -> (String, String, String) {
    (
        rig.add("idea", "Arthur on mobile and desktop", "Arthur should work on mobile and desktop."),
        rig.add("decision", "Use Tauri v2", "Use Tauri v2 for the unified client."),
        rig.add("task", "Android voice capture", "Implement Android voice capture."),
    )
}

#[test]
fn a_new_object_is_connected_to_what_it_really_relates_to_and_only_that() {
    let rig = Rig::new(&[("extends", "Phone works offline", "Arthur on mobile"), ("depends_on", "Phone works offline", "Local persistence")]);
    let (_idea, _decision, _task) = base(&rig);
    rig.add("task", "Local persistence", "Keep captures in local SQLite persistence.");
    let new = rig.add("idea", "Phone works offline", "The phone should still work when the PC is offline.");
    let report = rig.integrate(rig.created(&new));
    assert_eq!(report.status, Status::Integrated);
    assert_eq!(rig.edges(), vec!["depends_on Phone works offline -> Local persistence [model]", "extends Phone works offline -> Arthur on mobile and desktop [model]"]);
    assert_eq!((report.added, report.removed), (2, 0));
    // The provider budget: one proposal + two votes.
    assert_eq!((rig.double.proposer_calls.load(Ordering::SeqCst), rig.double.verifier_calls.load(Ordering::SeqCst)), (1, 2));
}

#[test]
fn nothing_uncertain_is_ever_persisted_and_unrelated_objects_stay_unrelated() {
    let rig = Rig::new(&[]);
    base(&rig);
    // The proposer insists on weak edges; the verifier (which holds no such fact) rejects them.
    *rig.double.noise.lock().unwrap() = vec![("related_to", "Cooking", "Arthur on mobile"), ("depends_on", "Cooking", "Use Tauri")];
    let new = rig.add("idea", "Cooking pasta", "Boil water for pasta.");
    let report = rig.integrate(rig.created(&new));
    assert_eq!(report.status, Status::Integrated, "the verifier rejecting everything is a successful no-op");
    assert!(rig.relations().is_empty());
    assert_eq!(rig.service.ledger.get(&new), Some(Entry::Done { revision_id: rig.lab.current_revision(&new), project_id: rig.project.clone() }));
}

#[test]
fn only_relations_that_touch_the_changed_object_are_admitted() {
    // Two TRUE facts, but only one involves the new object: the proposer (which ignores the focus) proposes both.
    let rig = Rig::new(&[("depends_on", "Android voice capture", "Use Tauri"), ("extends", "Phone works offline", "Arthur on mobile")]);
    base(&rig);
    let new = rig.add("idea", "Phone works offline", "The phone should still work offline.");
    rig.integrate(rig.created(&new));
    assert_eq!(rig.edges(), vec!["extends Phone works offline -> Arthur on mobile and desktop [model]"]);
}

#[test]
fn direction_is_decided_by_the_verifier_not_by_the_proposer_and_a_flip_flopping_verifier_admits_nothing() {
    let facts: &[Fact] = &[("depends_on", "Offline phone operation", "Local SQLite storage")];
    let rig = Rig::new(facts);
    rig.add("decision", "Local SQLite storage", "Store knowledge in local SQLite storage on the phone.");
    let new = rig.add("idea", "Offline phone operation", "The phone should keep working offline.");

    // Stage A proposes the WRONG way round; the verifier, shown both orders, states the correct direction.
    *rig.double.reverse_proposals.lock().unwrap() = true;
    rig.integrate(rig.created(&new));
    assert_eq!(rig.edges(), vec!["depends_on Offline phone operation -> Local SQLite storage [model]"], "never 'storage depends_on offline operation'");

    // A verifier whose two votes name opposite directions is not defensible: nothing is written.
    let rig = Rig::new(facts);
    rig.add("decision", "Local SQLite storage", "Store knowledge in local SQLite storage on the phone.");
    let new = rig.add("idea", "Offline phone operation", "The phone should keep working offline.");
    *rig.double.flip_first_vote.lock().unwrap() = true;
    rig.integrate(rig.created(&new));
    assert!(rig.relations().is_empty());
}

#[test]
fn every_automatic_relation_is_model_origin_and_never_user_origin() {
    let rig = Rig::new(&[("related_to", "Phone works offline", "Arthur on mobile"), ("contradicts", "Phone works offline", "Use Tauri"), ("supersedes", "Phone works offline", "Android voice")]);
    base(&rig);
    let new = rig.add("idea", "Phone works offline", "The phone should still work offline.");
    rig.integrate(rig.created(&new));
    assert_eq!(rig.relations().len(), 3);
    assert!(rig.relations().iter().all(|r| r.origin == "model"));
}

#[test]
fn integrating_the_same_change_twice_changes_nothing_and_does_no_provider_work_the_second_time() {
    let rig = Rig::new(&[("extends", "Phone works offline", "Arthur on mobile")]);
    base(&rig);
    let new = rig.add("idea", "Phone works offline", "The phone should still work offline.");
    let change = rig.created(&new);
    rig.integrate(change.clone());
    let (graph, calls) = (rig.relations(), rig.double.calls());
    let again = rig.integrate(change.clone());
    assert_eq!(again.status, Status::Skipped(Skip::AlreadyIntegrated));
    assert_eq!((rig.relations(), rig.double.calls()), (graph.clone(), calls));

    // Even with a lost ledger (a fresh service), the graph does not grow and the verifier is not asked again.
    let fresh = IntegrationService::new(GraphService::new(rig.double.clone(), rig.double.clone()), IntegrationSettings::in_memory(true), Ledger::in_memory());
    let verifier_before = rig.double.verifier_calls.load(Ordering::SeqCst);
    let report = run(fresh.integrate(&rig.lab.store, &rig.recall, change));
    assert_eq!(report.status, Status::Integrated);
    assert_eq!(rig.relations(), graph, "same relations, same ids, same timestamps");
    assert_eq!(rig.double.verifier_calls.load(Ordering::SeqCst), verifier_before, "an edge that exists is not verified again");
}

#[test]
fn a_user_relation_is_never_changed_by_integration() {
    let rig = Rig::new(&[("extends", "Phone works offline", "Arthur on mobile")]);
    let (idea, decision, _task) = base(&rig);
    let new = rig.add("idea", "Phone works offline", "The phone should still work offline.");
    // The user related the new object to the decision, and also (explicitly) to the idea in a different kind.
    let user_a = rig.lab.relate("contradicts", &new, &decision);
    let user_b = rig.lab.relate("related_to", &new, &idea);
    let snapshot: Vec<Relation> = rig.relations();
    rig.integrate(rig.created(&new));
    // Revised: the verifier would reject everything the world no longer holds, but user relations are never even offered to it.
    rig.double.set_facts(&[]);
    let change = rig.edit(&new, Some("Phone works offline"), Some("Completely different: the phone is a thin client."));
    rig.integrate(change);
    let after = rig.relations();
    for user in snapshot {
        assert!(after.contains(&user), "user relation {} survived unchanged", user.id);
    }
    assert!(after.iter().any(|r| r.id == user_a) && after.iter().any(|r| r.id == user_b));
    assert!(after.iter().filter(|r| r.origin == "user").count() == 2);
    assert!(after.iter().all(|r| r.origin != "model"), "the model relation was removed when the world stopped holding it");
}

#[test]
fn a_revision_that_changes_meaning_removes_the_model_relation_that_no_longer_holds_and_nothing_else() {
    let rig = Rig::new(&[("depends_on", "Arthur", "Android"), ("extends", "Arthur", "Roadmap")]);
    let android = rig.add("decision", "Android", "Arthur ships on Android first.");
    let roadmap = rig.add("idea", "Roadmap", "A roadmap for Arthur.");
    let other_a = rig.add("note", "Cooking", "Boil water for pasta.");
    let other_b = rig.add("note", "Gardening", "Water the tomatoes in the evening.");
    let arthur = rig.add("idea", "Arthur platform", "Arthur requires Android.");
    rig.integrate(rig.created(&arthur));
    // An unrelated model relation elsewhere in the project.
    rig.lab.store.create_relation(crate::storage::relation_store::NewRelation { kind: "related_to".into(), source_object_id: other_a.clone(), target_object_id: other_b.clone() }, "model").unwrap();
    assert_eq!(rig.relations().len(), 3);

    // R2: Arthur is platform independent; Android is one client. The dependency no longer holds; the extension still does.
    rig.double.set_facts(&[("extends", "Arthur", "Roadmap")]);
    *rig.double.requirement_gone.lock().unwrap() = true; // the verifier explains that Arthur's own requirement changed
    let change = rig.edit(&arthur, None, Some("Arthur is platform independent; Android is just one client."));
    let report = rig.integrate(change);
    assert_eq!(report.status, Status::Integrated);
    let edges = rig.edges();
    assert!(!edges.iter().any(|e| e.contains("depends_on")), "{edges:?}");
    assert!(edges.iter().any(|e| e.starts_with("extends Arthur platform -> Roadmap")), "kept: {edges:?}");
    assert!(edges.iter().any(|e| e.starts_with("related_to") && e.contains("Cooking") && e.contains("Gardening")), "an unrelated region is untouched: {edges:?}");
    assert_eq!((report.decision.kept, report.decision.dependency_invalidated, report.removed), (1, 1, 1));
    let _ = (android, roadmap);
}

#[test]
fn a_model_relation_whose_kind_changed_is_replaced_in_one_step_never_duplicated() {
    let rig = Rig::new(&[("related_to", "Report", "Data")]);
    rig.add("task", "Data", "Collect the data.");
    let report = rig.add("task", "Report", "Write the report from the collected data.");
    rig.integrate(rig.created(&report));
    assert_eq!(rig.relations().len(), 1);
    assert_eq!(rig.relations()[0].kind, "related_to");

    rig.double.set_facts(&[("depends_on", "Report", "Data")]);
    let change = rig.edit(&report, None, Some("Write the report. It cannot start until the data has been collected."));
    let outcome = rig.integrate(change);
    assert_eq!(outcome.decision.replaced, 1);
    assert_eq!(rig.edges(), vec!["depends_on Report -> Data [model]"], "exactly one relation, the right one, the right way round");
}

#[test]
fn when_one_pass_names_the_other_direction_an_existing_dependency_is_kept_unresolved() {
    let rig = Rig::new(&[("depends_on", "Report", "Data")]);
    rig.add("task", "Data", "Collect the data.");
    let report = rig.add("task", "Report", "Write the report from the data.");
    rig.integrate(rig.created(&report));
    assert_eq!(rig.relations().len(), 1);
    *rig.double.flip_first_vote.lock().unwrap() = true;
    let outcome = rig.integrate(rig.edit(&report, None, Some("Write the report, then review it.")));
    assert_eq!((outcome.decision.dependency_unresolved, outcome.decision.removed), (1, 0), "{:?}", outcome.decision);
    assert_eq!(rig.relations().len(), 1, "a rejecting or disagreeing pass alone never deletes an authoritative dependency");
}

#[test]
fn several_verified_relations_for_one_pair_persist_nothing_but_related_to_is_subsumed() {
    // extends AND depends_on both pass for the same pair: no rule says which is the edge.
    let rig = Rig::new(&[("extends", "Plan with goals", "Plan"), ("depends_on", "Plan with goals", "Plan")]);
    rig.add("idea", "Plan", "A weekly plan.");
    let new = rig.add("idea", "Plan with goals", "The weekly plan, plus three goals.");
    let report = rig.integrate(rig.created(&new));
    assert!(rig.relations().is_empty());
    assert_eq!((report.decision.survived, report.decision.ambiguous_pairs, report.decision.ambiguous_dropped), (2, 1, 2));

    // related_to is redundant once a stronger kind is verified: the stronger one is the edge.
    let rig = Rig::new(&[("extends", "Plan with goals", "Plan"), ("related_to", "Plan with goals", "Plan")]);
    rig.add("idea", "Plan", "A weekly plan.");
    let new = rig.add("idea", "Plan with goals", "The weekly plan, plus three goals.");
    rig.integrate(rig.created(&new));
    assert_eq!(rig.edges(), vec!["extends Plan with goals -> Plan [model]"]);
}

#[test]
fn a_supported_existing_relation_stays_when_a_competing_relation_also_survives_and_nothing_new_is_added() {
    let rig = Rig::new(&[("depends_on", "Report", "Data")]);
    rig.add("task", "Data", "Collect the data.");
    let report = rig.add("task", "Report", "Write the report from the data.");
    rig.integrate(rig.created(&report));
    rig.double.set_facts(&[("depends_on", "Report", "Data"), ("extends", "Report", "Data")]);
    let outcome = rig.integrate(rig.edit(&report, None, Some("Write the report using the collected data, in detail.")));
    assert_eq!((outcome.decision.kept, outcome.decision.ambiguous_pairs), (1, 1));
    assert_eq!(rig.edges(), vec!["depends_on Report -> Data [model]"]);
}

#[test]
fn a_wording_only_revision_does_no_graph_work_and_a_negation_does() {
    let rig = Rig::new(&[("depends_on", "Arthur", "Android")]);
    rig.add("decision", "Android", "Arthur ships on Android.");
    let arthur = rig.add("idea", "Arthur platform", "Arthur requires Android.");
    rig.integrate(rig.created(&arthur));
    let calls = rig.double.calls();
    let report = rig.integrate(rig.edit(&arthur, None, Some("  arthur REQUIRES android!  ")));
    assert_eq!(report.status, Status::Skipped(Skip::NotMeaningful));
    assert_eq!(rig.double.calls(), calls);
    assert!(meaning_changed(("idea", "t", "Arthur works"), ("idea", "t", "Arthur does not work")));
    assert!(meaning_changed(("idea", "t", "A depends on B"), ("idea", "t", "B depends on A")), "word order is meaning");
    assert!(meaning_changed(("idea", "t", "x"), ("task", "t", "x")), "a changed kind is a change");
    assert!(!meaning_changed(("idea", "Hello, World", "x  y"), ("idea", "hello world", "X y.")));
}

#[test]
fn an_event_for_a_revision_that_is_not_current_does_nothing() {
    let rig = Rig::new(&[("extends", "Phone", "Arthur on mobile")]);
    base(&rig);
    let new = rig.add("idea", "Phone works offline", "Phone offline.");
    let root = rig.lab.root_revision(&new);
    let branch = rig.lab.branch(&new, &root, "Phone branch", "An alternative wording.", false);
    // A branch is not current: the event for it is stale, and so is the event for the superseded original once the edit lands.
    let report = rig.integrate(ChangedKnowledge::revised(&new, &root, &branch));
    assert_eq!(report.status, Status::Skipped(Skip::Stale));
    assert_eq!(rig.double.calls(), 0);
    assert!(rig.relations().is_empty());
}

#[test]
fn a_late_event_for_an_object_that_changed_again_is_stale_and_the_newer_event_carries_the_work() {
    let rig = Rig::new(&[("extends", "Phone", "Arthur on mobile")]);
    base(&rig);
    let new = rig.add("idea", "Phone works offline", "Phone offline.");
    let first = rig.created(&new);
    let second = rig.edit(&new, None, Some("The phone keeps working offline for Arthur on mobile."));
    assert_eq!(rig.integrate(first).status, Status::Skipped(Skip::Stale));
    assert_eq!(rig.integrate(second).status, Status::Integrated);
    assert_eq!(rig.relations().len(), 1);
}

#[test]
fn an_object_edited_while_the_provider_was_working_is_not_written_from_stale_text() {
    let rig = Rig::new(&[("extends", "Phone", "Arthur on mobile")]);
    base(&rig);
    let new = rig.add("idea", "Phone works offline", "Phone offline.");
    let change = rig.created(&new);
    let lab = rig.lab.clone();
    let new_id = new.clone();
    *rig.double.during_provider_call.lock().unwrap() = Some(Box::new(move || {
        lab.edit(&new_id, None, Some("Edited during the provider call."));
    }));
    let report = rig.integrate(change);
    assert_eq!(report.status, Status::Skipped(Skip::Stale));
    assert!(rig.relations().is_empty());
}

#[test]
fn a_candidate_edited_while_the_provider_was_working_is_skipped_not_trusted() {
    let rig = Rig::new(&[("extends", "Phone", "Arthur on mobile")]);
    let (idea, _, _) = base(&rig);
    let new = rig.add("idea", "Phone works offline", "Phone offline.");
    let lab = rig.lab.clone();
    *rig.double.during_provider_call.lock().unwrap() = Some(Box::new(move || {
        lab.edit(&idea, None, Some("Rewritten meanwhile."));
    }));
    let report = rig.integrate(rig.created(&new));
    assert_eq!(report.skipped_stale, 1);
    assert!(rig.relations().is_empty());
}

#[test]
fn discovery_stays_inside_the_project_and_never_reads_an_archived_one() {
    let rig = Rig::new(&[("extends", "Phone works offline", "Arthur on mobile"), ("related_to", "Phone works offline", "Elsewhere mobile")]);
    base(&rig);
    let other = rig.lab.project("Other");
    rig.lab.object(&other, "idea", "Elsewhere mobile", "Another project's note about mobile and desktop.");
    let new = rig.add("idea", "Phone works offline", "Phone offline on mobile and desktop.");
    let report = rig.integrate(rig.created(&new));
    assert_eq!(report.status, Status::Integrated);
    let titles: HashSet<String> = rig.double.pools.lock().unwrap().iter().flatten().map(|id| rig.title_of(id)).collect();
    assert!(!titles.contains("Elsewhere mobile"), "project leakage: {titles:?}");
    assert!(rig.edges().iter().all(|e| !e.contains("Elsewhere")));

    // An object in an archived project is skipped outright.
    let archived = rig.lab.project("Old");
    let old = rig.lab.object(&archived, "idea", "Old thought", "Something old.");
    let change = ChangedKnowledge::created(&old, &rig.lab.current_revision(&old));
    rig.lab.store.archive_project(&archived).unwrap();
    assert_eq!(rig.integrate(change).status, Status::Skipped(Skip::ArchivedProject));
}

#[test]
fn moving_an_object_integrates_it_in_its_new_project_and_keeps_existing_cross_project_relations() {
    let rig = Rig::new(&[("extends", "Phone works offline", "Beta idea")]);
    let a = rig.project.clone();
    let b = rig.lab.project("Beta");
    let beta = rig.lab.object(&b, "idea", "Beta idea", "A beta idea.");
    let new = rig.lab.object(&a, "idea", "Phone works offline", "Phone offline.");
    // A pre-existing cross-project relation (made by the user, or by an earlier explicit run).
    let cross = rig.lab.store.create_relation(crate::storage::relation_store::NewRelation { kind: "related_to".into(), source_object_id: new.clone(), target_object_id: beta.clone() }, "model").unwrap();
    rig.integrate(rig.created(&new));
    assert!(rig.relations().iter().all(|r| r.id == cross.id), "nothing in project A to connect to");

    rig.lab.store.move_knowledge_object(&new, &b).unwrap();
    let report = rig.integrate(ChangedKnowledge::moved(&new, &rig.lab.current_revision(&new)));
    assert_eq!(report.status, Status::Integrated);
    assert!(rig.relations().iter().any(|r| r.id == cross.id), "an existing relation is never destroyed by a move");
    assert!(rig.edges().iter().any(|e| e.starts_with("extends Phone works offline -> Beta idea")));
}

#[test]
fn the_candidate_pool_is_bounded_whatever_the_size_of_the_project() {
    let rig = Rig::new(&[]);
    for index in 0..120 {
        rig.add("idea", &format!("Topic {index}"), &format!("Generic filler about gardening number {index}."));
    }
    let new = rig.add("idea", "Phone works offline", "Mobile phone keeps working offline with SQLite storage.");
    rig.integrate(rig.created(&new));
    for pool in rig.double.pools.lock().unwrap().iter() {
        assert!(pool.len() <= 1 + super::discover::MAX_DISCOVERED, "pool of {}", pool.len());
    }
    assert_eq!(rig.double.proposer_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn candidates_are_chosen_by_relevance_not_recency_and_work_with_semantic_recall_off() {
    let rig = Rig::new(&[("extends", "Phone works offline", "Local SQLite storage")]);
    let wanted = rig.add("decision", "Local SQLite storage", "Keep captures in local SQLite storage on the phone.");
    for index in 0..60 {
        rig.add("note", &format!("Filler {index}"), &format!("Unrelated gardening filler note {index} about tomatoes."));
    }
    let new = rig.add("idea", "Phone works offline", "The phone should keep SQLite storage working offline.");
    rig.integrate(rig.created(&new));
    // The wanted object is 60 objects old: the manual (recency) window of 40 would never have seen it.
    assert!(rig.double.pools.lock().unwrap()[0].contains(&wanted));
    assert_eq!(rig.edges(), vec!["extends Phone works offline -> Local SQLite storage [model]"]);
    assert_eq!(rig.embedder.request_count(), 0, "semantic Recall is off: no embedding request, whatever credentials exist");
}

#[test]
fn semantic_discovery_runs_only_with_consent_and_uses_the_unchanged_recall_floor() {
    let dir = tempfile::tempdir().unwrap();
    let embedder = Arc::new(ConceptEmbedder::new(64, &[("phone", "device"), ("mobile", "device"), ("handset", "device")]));
    let recall = RecallService::new(embedder.clone(), Arc::new(SemanticSettings::new(dir.path().join("s.json"))));
    let double = Double::new(&[]);
    let service = IntegrationService::new(GraphService::new(double.clone(), double.clone()), IntegrationSettings::in_memory(true), Ledger::in_memory());
    let lab = Lab::new();
    let project = lab.project("P");
    for index in 0..20 {
        lab.object(&project, "note", &format!("Filler {index}"), &format!("Gardening filler {index}."));
    }
    let new = lab.object(&project, "idea", "Handset resilience", "The handset must remain usable offline.");
    let change = ChangedKnowledge::created(&new, &lab.current_revision(&new));
    run(service.integrate(&lab.store, &recall, change.clone()));
    assert_eq!(embedder.request_count(), 0, "no consent, no embedding request");

    recall.settings().set(recall.model_key(), true).unwrap();
    let again = ChangedKnowledge::revised(&new, &lab.current_revision(&new), &lab.edit(&new, None, Some("The handset must remain usable when offline, always.")));
    run(service.integrate(&lab.store, &recall, again));
    assert_eq!(embedder.request_count(), 1, "exactly one query embedding, under the user's consent");
    assert_eq!(crate::recall::service::DEFAULT_MIN_COSINE, 0.40, "the Recall cosine floor is untouched");
}

#[test]
fn provider_failures_never_touch_knowledge_and_are_retried_a_bounded_number_of_times() {
    let rig = Rig::new(&[("extends", "Phone works offline", "Arthur on mobile")]);
    base(&rig);
    let new = rig.add("idea", "Phone works offline", "The phone works offline.");
    let change = rig.created(&new);
    let objects_before = rig.lab.store.list_knowledge_objects().unwrap();

    rig.double.fail_with.lock().unwrap().push(RelationError::Network);
    let report = rig.integrate(change.clone());
    assert_eq!(report.status, Status::Deferred("llm_failed"));
    assert!(rig.relations().is_empty(), "no partial or unverified relation");
    assert_eq!(rig.lab.store.list_knowledge_objects().unwrap(), objects_before, "the object is untouched");
    assert!(matches!(rig.service.ledger.get(&new), Some(Entry::Pending { attempts: 1, .. })));
    assert!(rig.service.due_retries(0).is_empty(), "not due before its backoff");
    let due = rig.service.due_retries(u64::MAX);
    assert_eq!(due, vec![change.clone()]);

    // The retry succeeds.
    let retried = rig.integrate(due[0].clone());
    assert_eq!(retried.status, Status::Integrated);
    assert_eq!(rig.relations().len(), 1);
    assert!(matches!(rig.service.ledger.get(&new), Some(Entry::Done { .. })));

    // Persistent failure ends in Failed after MAX_ATTEMPTS, and Failed is not retried by the poll.
    let rig = Rig::new(&[]);
    base(&rig);
    let object = rig.add("idea", "Another", "Another idea.");
    let change = rig.created(&object);
    for _ in 0..MAX_ATTEMPTS {
        rig.double.fail_with.lock().unwrap().push(RelationError::InvalidOutput("garbage".into()));
        rig.integrate(change.clone());
    }
    assert!(matches!(rig.service.ledger.get(&object), Some(Entry::Failed { .. })));
    assert!(rig.service.due_retries(u64::MAX).is_empty());
}

#[test]
fn a_missing_credential_defers_without_counting_and_a_refusal_fails_at_once() {
    let rig = Rig::new(&[]);
    base(&rig);
    let object = rig.add("idea", "Another", "Another idea.");
    let change = rig.created(&object);
    for _ in 0..5 {
        rig.double.fail_with.lock().unwrap().push(RelationError::NotConfigured);
        assert_eq!(rig.integrate(change.clone()).status, Status::Deferred("llm_not_configured"));
    }
    assert!(matches!(rig.service.ledger.get(&object), Some(Entry::Pending { attempts: 0, .. })), "uncounted");
    rig.double.fail_with.lock().unwrap().push(RelationError::Refused);
    assert_eq!(rig.integrate(change).status, Status::Failed("llm_refused"));
}

#[test]
fn the_switch_stops_new_inference_and_deletes_nothing() {
    let rig = Rig::new(&[("extends", "Phone works offline", "Arthur on mobile")]);
    base(&rig);
    let first = rig.add("idea", "Phone works offline", "Phone offline.");
    rig.integrate(rig.created(&first));
    let graph = rig.relations();
    assert_eq!(graph.len(), 1);

    rig.service.settings.set(false).unwrap();
    let second = rig.add("idea", "Another thought", "Something else about Arthur on mobile.");
    let calls = rig.double.calls();
    assert_eq!(rig.integrate(rig.created(&second)).status, Status::Skipped(Skip::Disabled));
    assert_eq!(rig.double.calls(), calls);
    assert_eq!(rig.relations(), graph);
    assert!(rig.service.due_retries(u64::MAX).is_empty());
}

#[test]
fn concurrent_integrations_never_duplicate_a_relation_and_never_overlap() {
    let facts: &[Fact] = &[("related_to", "Alpha", "Beta"), ("related_to", "Beta", "Gamma"), ("related_to", "Alpha", "Gamma"), ("extends", "Delta", "Alpha")];
    let rig = Arc::new(Rig::new(facts));
    let ids: Vec<String> = ["Alpha", "Beta", "Gamma", "Delta"].iter().map(|name| rig.add("idea", name, &format!("{name} is an idea about the shared topic."))).collect();
    let handles: Vec<_> = ids
        .iter()
        .map(|id| {
            let rig = rig.clone();
            let change = rig.created(id);
            tauri::async_runtime::spawn(async move { rig.service.integrate(&rig.lab.store, &rig.recall, change).await })
        })
        .collect();
    let reports: Vec<IntegrationReport> = run(async move {
        let mut out = Vec::new();
        for handle in handles {
            out.push(handle.await.unwrap());
        }
        out
    });
    assert!(reports.iter().all(|r| r.status == Status::Integrated), "{:?}", reports.iter().map(|r| &r.status).collect::<Vec<_>>());
    assert_eq!(rig.double.max_active.load(Ordering::SeqCst), 1, "one integration at a time");
    let relations = rig.relations();
    let unique: HashSet<(String, String, String)> = relations.iter().map(|r| (r.kind.clone(), r.source_object_id.clone(), r.target_object_id.clone())).collect();
    assert_eq!(unique.len(), relations.len(), "no duplicate relation");
    assert_eq!(relations.len(), 4, "every true fact exists exactly once: {:?}", rig.edges());
    assert!(relations.iter().all(|r| canonical_ends(&r.kind, &r.source_object_id, &r.target_object_id) == (r.source_object_id.clone(), r.target_object_id.clone())));
}

#[test]
fn the_provider_budget_is_three_requests_at_most_and_zero_when_there_is_nothing_to_do() {
    // Nothing to propose against and nothing to revalidate: no provider request at all.
    let rig = Rig::new(&[]);
    let alone = rig.add("idea", "Alone", "The only thought.");
    rig.integrate(rig.created(&alone));
    assert_eq!(rig.double.calls(), 0);

    // New object with candidates: 1 proposal + 2 votes only when something survives to verification.
    let rig = Rig::new(&[("extends", "Phone", "Arthur on mobile")]);
    base(&rig);
    let new = rig.add("idea", "Phone works offline", "Phone offline.");
    rig.integrate(rig.created(&new));
    assert_eq!(rig.double.calls(), 3);

    // A proposal that finds nothing costs one request, not three.
    let rig = Rig::new(&[]);
    base(&rig);
    let quiet = rig.add("idea", "Cooking pasta", "Boil water.");
    rig.integrate(rig.created(&quiet));
    assert_eq!((rig.double.proposer_calls.load(Ordering::SeqCst), rig.double.verifier_calls.load(Ordering::SeqCst)), (1, 0));

    // Revalidation shares the batch with new proposals: still three.
    let rig = Rig::new(&[("extends", "Phone", "Arthur on mobile")]);
    base(&rig);
    let object = rig.add("idea", "Phone works offline", "Phone offline.");
    rig.integrate(rig.created(&object));
    let before = rig.double.calls();
    rig.double.set_facts(&[("extends", "Phone", "Arthur on mobile"), ("depends_on", "Phone", "Use Tauri")]);
    rig.integrate(rig.edit(&object, None, Some("Phone offline, built with Tauri.")));
    assert_eq!(rig.double.calls() - before, 3);
    assert_eq!(rig.relations().len(), 2);
}

#[test]
fn integration_failing_never_fails_distillation() {
    use crate::distillation::{Candidate, DistillError, DistillationService, Distiller};
    struct OneObject;
    impl Distiller for OneObject {
        fn distill<'a>(&'a self, capture: &'a str) -> BoxFuture<'a, Result<Vec<Candidate>, DistillError>> {
            Box::pin(async move { Ok(vec![Candidate { kind: "idea".into(), title: "Phone works offline".into(), body: capture.into(), evidence: capture.into(), source_start: None, source_end: None }]) })
        }
    }
    let rig = Rig::new(&[]);
    base(&rig);
    rig.double.fail_with.lock().unwrap().push(RelationError::Network);
    let capture = rig.lab.store.create(crate::storage::capture_store::CreateCaptureInput { source: "text".into(), content: "The phone works offline.".into(), project_id: Some(rig.project.clone()) }).unwrap();
    let distillation = DistillationService::new(Arc::new(OneObject));
    let objects = run(distillation.distill(&rig.lab.store, &capture.id)).unwrap();
    assert_eq!(objects.len(), 1);
    let report = rig.integrate(rig.created(&objects[0].id));
    assert!(matches!(report.status, Status::Deferred(_)));
    assert_eq!(rig.lab.store.list_knowledge_objects_in(Some(&rig.project)).unwrap().len(), 4, "the committed object is still there");
}

#[test]
fn the_ledger_and_the_switch_survive_a_restart_and_damage_means_the_default() {
    let dir = tempfile::tempdir().unwrap();
    let ledger = Ledger::new(dir.path().join("ledger.json"));
    ledger.put("o1", Entry::Done { revision_id: "r1".into(), project_id: "p".into() });
    ledger.put("o2", Entry::Pending { change: ChangedKnowledge::created("o2", "r2"), attempts: 1, not_before: 5, last_error: "x".into() });
    let reopened = Ledger::new(dir.path().join("ledger.json"));
    assert_eq!(reopened.get("o1"), ledger.get("o1"));
    assert_eq!(reopened.due(10, 5), vec![ChangedKnowledge::created("o2", "r2")]);

    let settings = IntegrationSettings::new(dir.path().join("graph").join("settings.json"));
    assert_eq!(settings.enabled(), DEFAULT_ENABLED);
    assert!(!DEFAULT_ENABLED, "automatic integration stays OFF until the precision gate has passed against a real model");
    settings.set(true).unwrap();
    assert!(IntegrationSettings::new(dir.path().join("graph").join("settings.json")).enabled());
    std::fs::write(dir.path().join("graph").join("settings.json"), "{not json").unwrap();
    assert_eq!(IntegrationSettings::new(dir.path().join("graph").join("settings.json")).enabled(), DEFAULT_ENABLED);
    std::fs::write(dir.path().join("ledger.json"), "garbage").unwrap();
    assert!(Ledger::new(dir.path().join("ledger.json")).get("o1").is_none());
}

#[test]
fn regression_a_stale_duplicates_edge_is_removed_when_replacement_is_ambiguous() {
    // The A/B finding: the old `duplicates` was kept because the votes could not agree what replaced it. Now both `supersedes` and
    // `contradicts` are verified claims for the pair, neither is `duplicates`: the stale edge goes and NO replacement is persisted.
    let rig = Rig::new(&[("duplicates", "Offline mode", "Works offline")]);
    rig.add("idea", "Works offline", "The phone works without the PC.");
    let subject = rig.add("idea", "Offline mode", "Offline mode: the phone works even when the PC is off.");
    rig.integrate(rig.created(&subject));
    assert_eq!(rig.relations().len(), 1);
    assert_eq!(rig.relations()[0].kind, "duplicates");

    rig.double.set_facts(&[("supersedes", "Offline mode", "Works offline"), ("contradicts", "Offline mode", "Works offline")]);
    let report = rig.integrate(rig.edit(&subject, None, Some("Offline mode is dropped: the phone is a thin client that needs the PC for everything.")));
    assert_eq!((report.decision.removed, report.decision.ambiguous_pairs), (1, 1), "{:?}", report.decision);
    assert!(rig.relations().is_empty(), "the stale duplicates edge is gone and NO replacement was persisted: {:?}", rig.edges());
}

#[test]
fn a_stale_edge_is_replaced_when_exactly_one_relation_survives_resolution() {
    let rig = Rig::new(&[("duplicates", "Offline mode", "Works offline")]);
    rig.add("idea", "Works offline", "The phone works without the PC.");
    let subject = rig.add("idea", "Offline mode", "Offline mode: the phone works even when the PC is off.");
    rig.integrate(rig.created(&subject));
    rig.double.set_facts(&[("contradicts", "Offline mode", "Works offline")]);
    let report = rig.integrate(rig.edit(&subject, None, Some("Offline mode is dropped: the phone is a thin client that needs the PC for everything.")));
    assert_eq!(report.decision.replaced, 1);
    assert_eq!(rig.relations().len(), 1);
    assert_eq!(rig.relations()[0].kind, "contradicts");
}

#[test]
fn a_user_relation_survives_the_same_ambiguity() {
    let rig = Rig::new(&[("supersedes", "Offline mode", "Works offline"), ("contradicts", "Offline mode", "Works offline")]);
    let other = rig.add("idea", "Works offline", "The phone works without the PC.");
    let subject = rig.add("idea", "Offline mode", "Offline mode: the phone works even when the PC is off.");
    let user = rig.lab.relate("duplicates", &subject, &other);
    rig.integrate(rig.edit(&subject, None, Some("Completely different content now.")));
    assert!(rig.relations().iter().any(|r| r.id == user && r.origin == "user"));
}

#[test]
fn a_cancelled_plan_is_not_persisted_as_a_contradiction_and_no_relation_replaces_it() {
    let rig = Rig::new(&[("contradicts", "Discontinue the line", "Order packaging")]);
    rig.add("task", "Order packaging", "Order packaging for the spring product line.");
    let new = rig.add("decision", "Discontinue the line", "The spring product line is cancelled and will not be produced.");
    *rig.double.vote_override.lock().unwrap() = Some(Box::new(|candidate, _| {
        let mut verdict = verdict_for(candidate, &candidate.kind, Confidence::High);
        verdict.cancels_or_obsoletes = true;
        verdict.temporal_evidence = Some("The spring product line is cancelled, so ordering packaging is unnecessary.".into());
        verdict
    }));
    let report = rig.integrate(rig.created(&new));
    assert_eq!(report.status, Status::Integrated);
    assert!(rig.relations().is_empty(), "no contradicts, and nothing converted into supersedes: {:?}", rig.edges());
}

#[test]
fn an_existing_contradiction_that_is_now_moot_is_removed_but_a_user_one_is_not() {
    let rig = Rig::new(&[("contradicts", "Discontinue the line", "Order packaging")]);
    let other = rig.add("task", "Order packaging", "Order packaging for the spring product line.");
    let subject = rig.add("decision", "Discontinue the line", "The spring product line is under review.");
    rig.integrate(rig.created(&subject));
    assert_eq!(rig.relations().len(), 1);
    let user = rig.lab.relate("related_to", &subject, &other);
    *rig.double.vote_override.lock().unwrap() = Some(Box::new(|candidate, _| {
        let mut verdict = verdict_for(candidate, &candidate.kind, Confidence::High);
        verdict.cancels_or_obsoletes = true;
        verdict.temporal_evidence = Some("The spring product line is now cancelled, so the packaging order is unnecessary.".into());
        verdict
    }));
    rig.integrate(rig.edit(&subject, None, Some("The spring product line is cancelled and will not be produced.")));
    let left = rig.relations();
    assert!(left.iter().all(|r| r.kind != "contradicts"), "the stale contradiction is gone: {:?}", rig.edges());
    assert!(left.iter().any(|r| r.id == user && r.origin == "user"), "the user relation is untouched");
}

#[test]
fn a_real_contradiction_with_no_moot_flag_is_persisted() {
    let rig = Rig::new(&[("contradicts", "Pay on delivery", "Pay in advance")]);
    rig.add("decision", "Pay in advance", "Customers pay in advance.");
    let new = rig.add("decision", "Pay on delivery", "Customers pay on delivery only.");
    rig.integrate(rig.created(&new));
    assert_eq!(rig.edges().len(), 1);
}

fn verdict_for(candidate: &VerifyCandidate, kind: &str, confidence: Confidence) -> Verdict {
    Verdict {
        index: candidate.index,
        decision: if kind == candidate.kind { Decision::Accept } else { Decision::Reclassify },
        kind: kind.into(),
        source_object_id: candidate.source.id.clone(),
        target_object_id: candidate.target.id.clone(),
        confidence,
        forward_support: Support::Strong,
        reverse_support: Support::None,
        explicit_link: true,
        cancels_or_obsoletes: false,
        temporal_evidence: None,
        cancelled_plan_object_id: None,
        dependency_no_longer_required: false,
    }
}

// ----- M04.7A.3: direction-aware moot revalidation of `depends_on` -----

#[derive(Clone, Copy, PartialEq, Eq)]
enum Plan {
    Dependent,
    Prerequisite,
    Neither,
}

/// Both passes (or only the named ones) say `plan` has its own plan cancelled, with `evidence`.
fn flag(rig: &Rig, plan: Plan, passes: [bool; 2], evidence: &'static str) {
    *rig.double.vote_override.lock().unwrap() = Some(Box::new(move |candidate, presentation| {
        let mut verdict = verdict_for(candidate, &candidate.kind, Confidence::High);
        let pass = if presentation == Presentation::LowerIdFirst { 0 } else { 1 };
        if passes[pass] {
            verdict.cancelled_plan_object_id = match plan {
                Plan::Dependent => Some(candidate.source.id.clone()),
                Plan::Prerequisite => Some(candidate.target.id.clone()),
                Plan::Neither => None,
            };
            verdict.temporal_evidence = Some(evidence.into());
        }
        verdict
    }));
}

const CANCELLED: &str = "The store is cancelled; we will not open it.";

/// A dependent task "Open the store" with a model-created `depends_on` its prerequisite "Sign the lease".
fn dependency() -> (Rig, String, String, String) {
    let rig = Rig::new(&[("depends_on", "Open the store", "Sign the lease")]);
    let prerequisite = rig.add("task", "Sign the lease", "Sign the lease for the shop.");
    let dependent = rig.add("task", "Open the store", "Open the store in June, once the lease is signed.");
    rig.integrate(rig.created(&dependent));
    let relation = rig.relations();
    assert_eq!(relation.len(), 1, "{:?}", rig.edges());
    assert_eq!((relation[0].kind.as_str(), relation[0].source_object_id.as_str()), ("depends_on", dependent.as_str()));
    let id = relation[0].id.clone();
    (rig, dependent, prerequisite, id)
}

#[test]
fn a_dependent_whose_own_plan_is_cancelled_loses_its_model_dependency_and_nothing_replaces_it() {
    let (rig, dependent, _, _) = dependency();
    flag(&rig, Plan::Dependent, [true, true], "The store is cancelled.");
    let report = rig.integrate(rig.edit(&dependent, None, Some(CANCELLED)));
    assert_eq!((report.decision.moot_removed, report.decision.moot_unresolved), (1, 0), "{:?}", report.decision);
    assert!(rig.relations().is_empty(), "removed, with no replacement: {:?}", rig.edges());
}

#[test]
fn a_cancelled_prerequisite_does_not_retract_the_dependency() {
    let (rig, dependent, _, _) = dependency();
    flag(&rig, Plan::Prerequisite, [true, true], "The lease is cancelled.");
    let report = rig.integrate(rig.edit(&dependent, None, Some("Open the store in June, but the lease is cancelled and unavailable.")));
    assert_eq!(report.decision.moot_removed, 0);
    assert_eq!(rig.relations().len(), 1, "B being cancelled or unavailable is not A being cancelled");
}

#[test]
fn a_postponed_paused_or_reprioritised_dependent_keeps_its_dependency() {
    for text in ["Opening the store is postponed until next year.", "The store opening is paused for now.", "The store is now a low priority; do it after the release."] {
        let (rig, dependent, _, _) = dependency();
        // The verifier does not call any of these a cancelled plan.
        flag(&rig, Plan::Neither, [true, true], "The store opening is postponed.");
        let report = rig.integrate(rig.edit(&dependent, None, Some(text)));
        assert_eq!(report.decision.moot_removed, 0, "{text}");
        assert_eq!(rig.relations().len(), 1, "{text}");
    }
}

#[test]
fn both_passes_are_required_and_one_dissenting_pass_leaves_the_dependency_in_place() {
    for passes in [[true, false], [false, true]] {
        let (rig, dependent, _, _) = dependency();
        flag(&rig, Plan::Dependent, passes, "The store is cancelled.");
        let report = rig.integrate(rig.edit(&dependent, None, Some(CANCELLED)));
        assert_eq!((report.decision.moot_removed, report.decision.moot_unresolved), (0, 1), "{passes:?}");
        assert_eq!(rig.relations().len(), 1, "{passes:?}");
    }
}

#[test]
fn evidence_must_come_from_the_dependents_own_current_text() {
    for evidence in ["", "weather forecast", "Signing was withdrawn."] {
        let (rig, dependent, _, _) = dependency();
        // None of these words is in the DEPENDENT's own current text, so none of them grounds a claim about it.
        *rig.double.vote_override.lock().unwrap() = Some(Box::new(move |candidate, _| {
            let mut verdict = verdict_for(candidate, &candidate.kind, Confidence::High);
            verdict.cancelled_plan_object_id = Some(candidate.source.id.clone());
            verdict.temporal_evidence = Some(evidence.into()).filter(|e: &String| !e.is_empty());
            verdict
        }));
        rig.integrate(rig.edit(&dependent, None, Some("The store is cancelled; we will not open it.")));
        assert_eq!(rig.relations().len(), 1, "ungrounded evidence {evidence:?} removes nothing");
    }
}

#[test]
fn a_user_created_dependency_is_never_retracted() {
    let rig = Rig::new(&[]);
    let prerequisite = rig.add("task", "Sign the lease", "Sign the lease for the shop.");
    let dependent = rig.add("task", "Open the store", "Open the store in June, once the lease is signed.");
    let user = rig.lab.relate("depends_on", &dependent, &prerequisite);
    flag(&rig, Plan::Dependent, [true, true], "The store is cancelled.");
    rig.integrate(rig.edit(&dependent, None, Some(CANCELLED)));
    assert!(rig.relations().iter().any(|r| r.id == user && r.origin == "user"));
}

#[test]
fn an_edit_during_verification_means_no_stale_retraction() {
    let (rig, dependent, _, _) = dependency();
    flag(&rig, Plan::Dependent, [true, true], "The store is cancelled.");
    let change = rig.edit(&dependent, None, Some(CANCELLED));
    let lab = rig.lab.clone();
    let id = dependent.clone();
    *rig.double.during_provider_call.lock().unwrap() = Some(Box::new(move || {
        lab.edit(&id, None, Some("Actually the store is back on and opens in June."));
    }));
    let report = rig.integrate(change);
    assert_eq!(report.status, Status::Skipped(Skip::Stale));
    assert_eq!(rig.relations().len(), 1, "the dependency was not retracted from a revision that is no longer current");
}

#[test]
fn a_retracted_dependency_cannot_be_recreated_while_the_plan_stays_cancelled_but_reactivation_is_inferred_afresh() {
    let (rig, dependent, _, old_id) = dependency();
    flag(&rig, Plan::Dependent, [true, true], "The store is cancelled.");
    rig.integrate(rig.edit(&dependent, None, Some(CANCELLED)));
    assert!(rig.relations().is_empty());

    // Still cancelled, text changed again: Stage A re-proposes the dependency, and the new claim is blocked.
    let report = rig.integrate(rig.edit(&dependent, None, Some("The store is cancelled for good; we will not open it, whatever the lease says.")));
    assert!(report.decision.moot_blocked >= 1, "{:?}", report.decision);
    assert!(rig.relations().is_empty(), "no immediate recreation");

    // Reactivated: nothing cancels the plan any more. A new relation is inferred and verified; the old one is not restored.
    *rig.double.vote_override.lock().unwrap() = None;
    rig.integrate(rig.edit(&dependent, None, Some("We changed our minds: the store will open in June, once the lease is signed.")));
    let after = rig.relations();
    assert_eq!(after.len(), 1);
    assert_ne!(after[0].id, old_id, "a fresh, verified relation, not a silent restore");
}

// ----- M04.7A.3: the `depends_on` revalidation policy (split votes, availability, evidence) -----

fn reject_verdict(candidate: &VerifyCandidate) -> Verdict {
    Verdict { decision: Decision::Reject, confidence: Confidence::High, forward_support: Support::None, explicit_link: false, ..verdict_for(candidate, &candidate.kind, Confidence::High) }
}

/// Per-pass scripted behaviour for the `depends_on` claim: `accept`, or `reject` with optional structured signals.
#[derive(Clone, Copy)]
struct Pass {
    supports: bool,
    plan_cancelled: Option<Plan>,
    requirement_gone: bool,
    evidence: &'static str,
}

const ACCEPT: Pass = Pass { supports: true, plan_cancelled: None, requirement_gone: false, evidence: "" };
const REJECT: Pass = Pass { supports: false, plan_cancelled: None, requirement_gone: false, evidence: "" };

fn script(rig: &Rig, first: Pass, second: Pass) {
    *rig.double.vote_override.lock().unwrap() = Some(Box::new(move |candidate, presentation| {
        let pass = if presentation == Presentation::LowerIdFirst { first } else { second };
        let mut verdict = if pass.supports { verdict_for(candidate, &candidate.kind, Confidence::High) } else { reject_verdict(candidate) };
        verdict.cancelled_plan_object_id = match pass.plan_cancelled {
            Some(Plan::Dependent) => Some(candidate.source.id.clone()),
            Some(Plan::Prerequisite) => Some(candidate.target.id.clone()),
            _ => None,
        };
        verdict.dependency_no_longer_required = pass.requirement_gone;
        verdict.temporal_evidence = Some(pass.evidence.to_string()).filter(|e| !e.is_empty());
        verdict
    }));
}

fn edit_dependent(rig: &Rig, dependent: &str, text: &str) -> IntegrationReport {
    rig.integrate(rig.edit(dependent, None, Some(text)))
}

#[test]
fn one_rejecting_pass_never_deletes_an_active_dependency() {
    for passes in [(ACCEPT, REJECT), (REJECT, ACCEPT)] {
        let (rig, dependent, _, id) = dependency();
        script(&rig, passes.0, passes.1);
        let report = edit_dependent(&rig, &dependent, "Open the store in June, with a bigger opening party.");
        assert_eq!((report.decision.dependency_unresolved, report.decision.removed), (1, 0), "{:?}", report.decision);
        assert!(rig.relations().iter().any(|r| r.id == id), "retained, unresolved");
    }
}

#[test]
fn both_passes_rejecting_because_the_prerequisite_is_unavailable_keeps_the_dependency() {
    let (rig, dependent, _, id) = dependency();
    // The landlord rejected the lease: B is unavailable. The verifiers reject the claim as stated but do not say the REQUIREMENT changed.
    script(&rig, REJECT, REJECT);
    let report = edit_dependent(&rig, &dependent, "Open the store in June, but the landlord rejected the lease.");
    assert_eq!((report.decision.dependency_unresolved, report.decision.dependency_invalidated, report.decision.moot_removed), (1, 0, 0));
    assert!(rig.relations().iter().any(|r| r.id == id));
    // Even a (wrong) "requirement gone" flag whose evidence is not in the dependent's own text proves nothing.
    script(&rig, Pass { requirement_gone: true, evidence: "Signing fell through.", ..REJECT }, Pass { requirement_gone: true, evidence: "Signing fell through.", ..REJECT });
    let report = edit_dependent(&rig, &dependent, "Open the store in June, but the landlord rejected the lease, again.");
    assert_eq!(report.decision.dependency_invalidated, 0);
    assert!(rig.relations().iter().any(|r| r.id == id), "ungrounded evidence is not proof");
}

#[test]
fn both_rejecting_because_the_dependent_is_cancelled_removes_it_only_with_confirmed_cancellation() {
    // Both passes confirm the dependent's cancellation, even though both also reject the dependency: removed, nothing replaces it.
    let (rig, dependent, _, _) = dependency();
    let both = Pass { plan_cancelled: Some(Plan::Dependent), evidence: "The store is cancelled.", ..REJECT };
    script(&rig, both, both);
    let report = edit_dependent(&rig, &dependent, CANCELLED);
    assert_eq!((report.decision.moot_removed, report.decision.removed), (1, 0), "{:?}", report.decision);
    assert!(rig.relations().is_empty());

    // Only ONE pass confirms it: not confirmed. The edge stays, unresolved.
    let (rig, dependent, _, id) = dependency();
    script(&rig, both, REJECT);
    let report = edit_dependent(&rig, &dependent, CANCELLED);
    assert_eq!((report.decision.moot_removed, report.decision.dependency_unresolved), (0, 1));
    assert!(rig.relations().iter().any(|r| r.id == id));

    // The CANCELLED object is the prerequisite: not the dependent. Retained.
    let (rig, dependent, _, id) = dependency();
    let prerequisite_cancelled = Pass { plan_cancelled: Some(Plan::Prerequisite), evidence: "The lease is cancelled.", ..REJECT };
    script(&rig, prerequisite_cancelled, prerequisite_cancelled);
    edit_dependent(&rig, &dependent, "Open the store in June; the lease is cancelled and unavailable.");
    assert!(rig.relations().iter().any(|r| r.id == id));
}

#[test]
fn both_rejecting_with_grounded_evidence_that_the_requirement_itself_changed_removes_the_dependency() {
    let (rig, dependent, _, _) = dependency();
    let gone = Pass { requirement_gone: true, evidence: "The store no longer needs a lease: it opens inside the partner's shop.", ..REJECT };
    script(&rig, gone, gone);
    let report = edit_dependent(&rig, &dependent, "Open the store inside the partner's shop in June; no lease is needed any more.");
    assert_eq!((report.decision.dependency_invalidated, report.decision.moot_removed), (1, 0), "{:?}", report.decision);
    assert!(rig.relations().is_empty(), "removed: the old model relation became invalid");

    // One pass saying so is not enough.
    let (rig, dependent, _, id) = dependency();
    script(&rig, gone, REJECT);
    edit_dependent(&rig, &dependent, "Open the store inside the partner's shop in June; no lease is needed any more.");
    assert!(rig.relations().iter().any(|r| r.id == id));
}

#[test]
fn a_supporting_pass_wins_over_a_dependent_cancelled_flag_from_the_other_pass_alone() {
    let (rig, dependent, _, id) = dependency();
    script(&rig, Pass { plan_cancelled: Some(Plan::Dependent), evidence: "The store is cancelled.", ..ACCEPT }, ACCEPT);
    let report = edit_dependent(&rig, &dependent, CANCELLED);
    assert_eq!((report.decision.moot_removed, report.decision.moot_unresolved), (0, 1));
    assert!(rig.relations().iter().any(|r| r.id == id));
}

#[test]
fn the_other_relation_kinds_keep_the_both_passes_must_support_rule() {
    // The stale `duplicates` regression is covered above; here a rejecting pass still removes an `extends`.
    let rig = Rig::new(&[("extends", "Plan with goals", "Plan")]);
    rig.add("idea", "Plan", "A weekly plan.");
    let new = rig.add("idea", "Plan with goals", "The weekly plan, plus three goals.");
    rig.integrate(rig.created(&new));
    assert_eq!(rig.relations().len(), 1);
    rig.double.set_facts(&[]);
    rig.integrate(rig.edit(&new, None, Some("Something else entirely now.")));
    assert!(rig.relations().is_empty());
}

// ----- M04.7A.3: the Stage B output contract and its bounded retry -----

fn invalid_output() -> RelationError {
    RelationError::InvalidOutput("a cancelledPlan verdict has no temporalEvidence".into())
}

#[test]
fn a_contract_invalid_verifier_response_is_retried_counted_and_kept_apart_from_the_normal_budget() {
    let (rig, dependent, _, _) = dependency();
    let both = Pass { plan_cancelled: Some(Plan::Dependent), evidence: "The store is cancelled.", ..ACCEPT };
    script(&rig, both, both);
    rig.double.fail_verifier.lock().unwrap().push(invalid_output());
    let before = rig.double.verifier_calls.load(Ordering::SeqCst);
    let report = edit_dependent(&rig, &dependent, CANCELLED);
    assert_eq!(report.status, Status::Integrated);
    assert_eq!((report.decision.contract_invalid, report.decision.retry_requests), (1, 1), "{:?}", report.decision);
    assert_eq!(report.decision.provider_requests, 3, "the normal budget is unchanged");
    assert_eq!(rig.double.verifier_calls.load(Ordering::SeqCst) - before, 3, "two passes plus one exceptional retry");
    assert_eq!(report.decision.moot_removed, 1, "the retried response was used");
    assert!(rig.relations().is_empty());
}

#[test]
fn exhausted_contract_retries_leave_the_graph_alone_and_the_event_unfinished() {
    let (rig, dependent, prerequisite, id) = dependency();
    let user = rig.lab.relate("related_to", &dependent, &prerequisite);
    let both = Pass { plan_cancelled: Some(Plan::Dependent), evidence: "The store is cancelled.", ..ACCEPT };
    script(&rig, both, both);
    for _ in 0..=super::integrate::MAX_CONTRACT_RETRIES {
        rig.double.fail_verifier.lock().unwrap().push(invalid_output());
    }
    let graph_before = rig.relations();
    let change = rig.edit(&dependent, None, Some(CANCELLED));
    let report = rig.integrate(change.clone());
    assert_eq!(report.status, Status::Deferred("llm_invalid_output"), "failed/deferred, not successful");
    assert_eq!(rig.relations(), graph_before, "no graph mutation at all");
    assert!(rig.relations().iter().any(|r| r.id == id));
    assert!(rig.relations().iter().any(|r| r.id == user && r.origin == "user"));
    assert!(matches!(rig.service.ledger.get(&dependent), Some(Entry::Pending { .. })), "not recorded as done in the idempotence ledger");
    // A later retry of the same event, with a valid response, completes it.
    let retried = rig.integrate(change);
    assert_eq!(retried.status, Status::Integrated);
    assert!(matches!(rig.service.ledger.get(&dependent), Some(Entry::Done { .. })));
}

#[test]
fn valid_split_votes_are_never_retried() {
    let (rig, dependent, _, id) = dependency();
    script(&rig, ACCEPT, REJECT);
    let before = rig.double.verifier_calls.load(Ordering::SeqCst);
    let report = edit_dependent(&rig, &dependent, "Open the store in June, with a bigger opening party.");
    assert_eq!(rig.double.verifier_calls.load(Ordering::SeqCst) - before, 2, "a well-formed disagreement is a verdict, not a failure");
    assert_eq!((report.decision.contract_invalid, report.decision.retry_requests, report.decision.dependency_unresolved), (0, 0, 1));
    assert!(rig.relations().iter().any(|r| r.id == id));
}

#[test]
fn a_provider_outage_is_not_a_contract_failure_and_is_not_retried_in_place() {
    let (rig, dependent, _, _) = dependency();
    rig.double.fail_verifier.lock().unwrap().push(RelationError::Network);
    let before = rig.double.verifier_calls.load(Ordering::SeqCst);
    let report = edit_dependent(&rig, &dependent, "Open the store in June, with a bigger opening party.");
    assert_eq!(report.status, Status::Deferred("llm_failed"));
    assert_eq!(rig.double.verifier_calls.load(Ordering::SeqCst) - before, 1);
}

#[test]
fn a_cancelled_prerequisite_without_evidence_is_a_complete_integration_with_no_retry_and_no_deletion() {
    let (rig, dependent, _, id) = dependency();
    // What the verifier really sends when the PREREQUISITE is the cancelled one: the flag, with no evidence, and a rejection of the claim.
    script(&rig, Pass { plan_cancelled: Some(Plan::Prerequisite), evidence: "", ..REJECT }, Pass { plan_cancelled: Some(Plan::Prerequisite), evidence: "", ..REJECT });
    let before = rig.double.verifier_calls.load(Ordering::SeqCst);
    let report = edit_dependent(&rig, &dependent, "Open the store in June; the lease decision is cancelled and unavailable.");
    assert_eq!(report.status, Status::Integrated, "completed, not deferred");
    assert_eq!((report.decision.contract_invalid, report.decision.retry_requests, report.decision.moot_removed, report.decision.dependency_invalidated), (0, 0, 0, 0));
    assert_eq!(rig.double.verifier_calls.load(Ordering::SeqCst) - before, 2, "no duplicate retries");
    assert!(rig.relations().iter().any(|r| r.id == id), "the dependency stays");
    assert!(matches!(rig.service.ledger.get(&dependent), Some(Entry::Done { .. })));
}

// ----- M04.7A.4: relation specificity -----

#[test]
fn a_failed_typed_claim_is_never_replaced_by_related_to_for_the_same_pair() {
    // Stage A claims depends_on AND related_to; the verifier supports only related_to (the typed claim failed).
    let rig = Rig::new(&[("related_to", "Pairing", "Local identity")]);
    rig.add("task", "Local identity", "Each device keeps a local identity key.");
    let new = rig.add("task", "Pairing", "Pairing devices.");
    *rig.double.noise.lock().unwrap() = vec![("depends_on", "Pairing", "Local identity")];
    let report = rig.integrate(rig.created(&new));
    assert!(rig.relations().is_empty(), "no weaker fallback: {:?}", rig.edges());
    assert!(report.decision.related_suppressed >= 1, "{:?}", report.decision);
}

#[test]
fn a_standalone_justified_related_to_is_still_persisted() {
    // Nothing typed was claimed for the pair: related_to stands on its own.
    let rig = Rig::new(&[("related_to", "Garden herbs", "Pasta recipes")]);
    rig.add("note", "Pasta recipes", "Simple pasta recipes with fresh basil.");
    let new = rig.add("idea", "Garden herbs", "Grow basil on the balcony.");
    let report = rig.integrate(rig.created(&new));
    assert_eq!(rig.relations().len(), 1);
    assert_eq!((rig.relations()[0].kind.as_str(), report.decision.related_suppressed), ("related_to", 0));
}

#[test]
fn related_to_is_not_added_beside_an_existing_typed_relation_and_manual_related_to_is_kept() {
    let rig = Rig::new(&[("related_to", "Plan with goals", "Plan")]);
    let plan = rig.add("idea", "Plan", "A weekly plan.");
    let new = rig.add("idea", "Plan with goals", "The weekly plan, plus three goals.");
    let typed = rig.lab.relate("extends", &new, &plan);
    let report = rig.integrate(rig.created(&new));
    assert_eq!(rig.relations().len(), 1, "{:?}", rig.edges());
    assert_eq!(rig.relations()[0].id, typed);
    assert_eq!(report.decision.related_suppressed, 1);

    // A relation the USER made is never touched, whatever the policy says.
    let rig = Rig::new(&[("related_to", "Garden herbs", "Pasta recipes")]);
    let a = rig.add("note", "Pasta recipes", "Simple pasta recipes with fresh basil.");
    let b = rig.add("idea", "Garden herbs", "Grow basil on the balcony.");
    let user = rig.lab.relate("related_to", &a, &b);
    *rig.double.noise.lock().unwrap() = vec![("depends_on", "Garden herbs", "Pasta recipes")];
    rig.integrate(rig.created(&b));
    assert!(rig.relations().iter().any(|r| r.id == user && r.origin == "user"));
}

#[test]
fn a_typed_relation_that_survives_still_subsumes_related_to_as_before() {
    let rig = Rig::new(&[("extends", "Plan with goals", "Plan"), ("related_to", "Plan with goals", "Plan")]);
    rig.add("idea", "Plan", "A weekly plan.");
    let new = rig.add("idea", "Plan with goals", "The weekly plan, plus three goals.");
    let report = rig.integrate(rig.created(&new));
    assert_eq!(rig.edges(), vec!["extends Plan with goals -> Plan [model]"]);
    assert_eq!(report.decision.related_suppressed, 0);
}

// ----- M04.7A.6: the user's switch -----

fn service_in(dir: &std::path::Path, double: &Arc<Double>) -> IntegrationService {
    IntegrationService::new(GraphService::new(double.clone(), double.clone()), IntegrationSettings::new(dir.join("graph").join("settings.json")), Ledger::new(dir.join("graph").join("ledger.json")))
}

#[test]
fn it_is_off_until_the_person_turns_it_on_and_the_choice_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(&[("extends", "Phone works offline", "Arthur on mobile")]);
    base(&rig);
    let new = rig.add("idea", "Phone works offline", "The phone works offline.");
    let service = service_in(dir.path(), &rig.double);
    assert!(!service.enabled(), "a person who never opted in has it OFF");
    let report = run(service.integrate(&rig.lab.store, &rig.recall, rig.created(&new)));
    assert_eq!(report.status, Status::Skipped(Skip::Disabled));
    assert_eq!(rig.double.calls(), 0, "OFF means no provider request at all");

    service.set_enabled(true).unwrap();
    assert!(service_in(dir.path(), &rig.double).enabled(), "the explicit choice is read back after a restart");
    assert_eq!(run(service.integrate(&rig.lab.store, &rig.recall, rig.created(&new))).status, Status::Integrated);

    service.set_enabled(false).unwrap();
    assert!(!service_in(dir.path(), &rig.double).enabled(), "and so is turning it off");
}

#[test]
fn a_preference_that_cannot_be_saved_is_an_error_and_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("blocker"), "a file, not a directory").unwrap();
    let service = IntegrationService::new(GraphService::new(Double::new(&[]), Double::new(&[])), IntegrationSettings::new(dir.path().join("blocker").join("settings.json")), Ledger::in_memory());
    assert!(service.set_enabled(true).is_err());
    assert!(!service.enabled(), "the requested state is not reported as saved");
}

#[test]
fn turning_it_off_while_a_request_is_in_flight_writes_nothing_and_completes_nothing() {
    let rig = Rig::new(&[("extends", "Phone works offline", "Arthur on mobile")]);
    let (idea, _, _) = base(&rig);
    let new = rig.add("idea", "Phone works offline", "The phone works offline.");
    let user = rig.lab.relate("related_to", &new, &idea);
    let before = rig.relations();
    let settings = rig.service.settings.clone();
    // The person switches it off while the model is still working.
    *rig.double.during_provider_call.lock().unwrap() = Some(Box::new(move || settings.set(false).unwrap()));
    let report = rig.integrate(rig.created(&new));
    assert_eq!(report.status, Status::Skipped(Skip::Disabled));
    assert_eq!(rig.relations(), before, "no automatic mutation after disabling; existing relations, including the user's, are untouched");
    assert!(rig.relations().iter().any(|r| r.id == user && r.origin == "user"));
    assert!(rig.service.ledger.get(&new).is_none(), "the event was not completed, and no failure was remembered");
    assert!(rig.service.due_retries(u64::MAX).is_empty(), "nothing is scheduled while it is off");
}

#[test]
fn a_failure_after_switching_off_is_not_remembered() {
    let rig = Rig::new(&[]);
    base(&rig);
    let new = rig.add("idea", "Another", "Another idea.");
    let settings = rig.service.settings.clone();
    *rig.double.during_provider_call.lock().unwrap() = Some(Box::new(move || settings.set(false).unwrap()));
    rig.double.fail_with.lock().unwrap().push(RelationError::Network);
    let report = rig.integrate(rig.created(&new));
    assert_eq!(report.status, Status::Skipped(Skip::Disabled));
    assert!(rig.service.ledger.get(&new).is_none());
}

#[test]
fn turning_it_back_on_does_not_resume_a_backlog() {
    let rig = Rig::new(&[("extends", "Phone works offline", "Arthur on mobile")]);
    base(&rig);
    let pending = rig.add("idea", "Phone works offline", "The phone works offline.");
    rig.double.fail_with.lock().unwrap().push(RelationError::Network);
    assert!(matches!(rig.integrate(rig.created(&pending)).status, Status::Deferred(_)));
    let finished = rig.add("idea", "Phone works offline too", "Offline phone, again.");
    rig.integrate(rig.created(&finished));
    assert_eq!(rig.service.ledger.pending(), 1);

    rig.service.set_enabled(false).unwrap();
    assert!(rig.service.due_retries(u64::MAX).is_empty(), "off: nothing is retried");
    let calls = rig.double.calls();
    rig.service.set_enabled(true).unwrap();
    assert_eq!(rig.service.ledger.pending(), 0, "on again: unfinished work is forgotten, not resumed");
    assert!(rig.service.due_retries(u64::MAX).is_empty(), "no backlog starts");
    assert_eq!(rig.double.calls(), calls, "enabling itself sends nothing to the provider");
    assert!(matches!(rig.service.ledger.get(&finished), Some(Entry::Done { .. })), "what was finished stays finished");
    // The forgotten object is integrated the next time its meaning changes.
    let change = rig.edit(&pending, None, Some("The phone keeps working offline for Arthur on mobile."));
    assert_eq!(rig.integrate(change).status, Status::Integrated);
}

#[test]
fn enabling_does_not_backfill_existing_objects() {
    let rig = Rig::new(&[("extends", "Phone works offline", "Arthur on mobile")]);
    rig.service.settings.set(false).unwrap();
    base(&rig);
    rig.add("idea", "Phone works offline", "The phone works offline.");
    rig.service.set_enabled(true).unwrap();
    assert_eq!(rig.double.calls(), 0);
    assert!(rig.relations().is_empty(), "objects that already exist are not integrated just because the switch was turned on");
}

#[test]
fn the_same_event_arriving_twice_at_once_is_integrated_once() {
    let rig = Arc::new(Rig::new(&[("extends", "Phone works offline", "Arthur on mobile")]));
    base(&rig);
    let new = rig.add("idea", "Phone works offline", "The phone works offline.");
    let change = rig.created(&new);
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let (rig, change) = (rig.clone(), change.clone());
            tauri::async_runtime::spawn(async move { rig.service.integrate(&rig.lab.store, &rig.recall, change).await })
        })
        .collect();
    let statuses: Vec<Status> = run(async move {
        let mut out = Vec::new();
        for handle in handles {
            out.push(handle.await.unwrap().status);
        }
        out
    });
    assert_eq!(statuses.iter().filter(|s| **s == Status::Integrated).count(), 1, "{statuses:?}");
    assert_eq!(statuses.iter().filter(|s| **s == Status::Skipped(Skip::AlreadyIntegrated)).count(), 1);
    assert_eq!(rig.relations().len(), 1);
    assert_eq!(rig.double.proposer_calls.load(Ordering::SeqCst), 1, "one set of provider requests, not two");
}

#[test]
fn a_provider_that_is_not_configured_defers_without_touching_knowledge() {
    let rig = Rig::new(&[]);
    base(&rig);
    let new = rig.add("idea", "Another", "Another idea.");
    rig.double.fail_with.lock().unwrap().push(RelationError::NotConfigured);
    let before = rig.lab.store.list_knowledge_objects().unwrap();
    assert_eq!(rig.integrate(rig.created(&new)).status, Status::Deferred("llm_not_configured"));
    assert_eq!(rig.lab.store.list_knowledge_objects().unwrap(), before, "Capture and Distillation results are never affected");
}
