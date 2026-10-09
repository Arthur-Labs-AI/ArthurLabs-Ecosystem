//! Offline tests: a scripted transport stands in for TypeSafe. No key, no internet.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::client::{Budget, JevClient, RetryPolicy};
use super::consent::JevConsent;
use super::protocol::{build_run, parse_run, permutation, Mapping};
use super::provider::{resolver_policy, JevIdentityProvider, JevLimits, TypeSafeCredential};
use super::transport::{JevTransport, RawResponse, ReqwestTransport, TransportError};
use super::*;
use crate::async_util::BoxFuture;
use crate::distillation::evolution::{AsyncIdentityClassifier, EvolutionSettings, Prefetched};
use crate::identity::{resolve, Candidate, ClassifierFailure, Claim, EvidenceSpan, Identity, ObjectLifecycle, Outcome, ProjectState, Relation, RevisionView};
use crate::providers::credentials::{ApiKey, CredentialSource};
use crate::providers::registry::ProviderId;
use crate::providers::secrets::tests::MemorySecretStore;
use crate::providers::secrets::SecretStore;

const SECRET: &str = "tskey-SECRET-SENTINEL-9f3a";
const CLAIM_SECRET: &str = "CLAIMTEXT-sentinel-zq81";
const IDEA_SECRET: &str = "IDEATEXT-sentinel-k4w7";

// --- scripted transport ----------------------------------------------------------------------------------------------------------

enum Step {
    Reply(u16, String, Option<u64>),
    Fail(TransportError),
    Hang,
    Delay(u64, String),
}

struct Fake {
    plan: Mutex<Box<dyn FnMut(usize, &Value) -> Step + Send>>,
    calls: AtomicUsize,
    bodies: Mutex<Vec<String>>,
    keys: Mutex<Vec<String>>,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
    hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl Fake {
    fn new(plan: impl FnMut(usize, &Value) -> Step + Send + 'static) -> Arc<Self> {
        Arc::new(Self {
            plan: Mutex::new(Box::new(plan)),
            calls: AtomicUsize::new(0),
            bodies: Mutex::new(vec![]),
            keys: Mutex::new(vec![]),
            in_flight: AtomicUsize::new(0),
            max_in_flight: AtomicUsize::new(0),
            hook: Mutex::new(None),
        })
    }
    /// Answers every request with a valid reply for `profile`.
    fn valid(profile: Profile) -> Arc<Self> {
        Self::new(move |_, request| Step::Reply(200, reply(request, &profile).to_string(), None))
    }
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
    fn on_call(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self.hook.lock().unwrap() = Some(Arc::new(hook));
    }
    fn raw_bodies(&self) -> Vec<String> {
        self.bodies.lock().unwrap().clone()
    }
    fn bodies(&self) -> Vec<Value> {
        self.bodies.lock().unwrap().iter().map(|b| serde_json::from_str(b).unwrap()).collect()
    }
}

impl JevTransport for Fake {
    fn post<'a>(&'a self, key: &'a ApiKey, body: &'a str, _timeout: Duration) -> BoxFuture<'a, Result<RawResponse, TransportError>> {
        Box::pin(async move {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            self.bodies.lock().unwrap().push(body.to_string());
            self.keys.lock().unwrap().push(key.expose().to_string());
            let hook = self.hook.lock().unwrap().clone();
            if let Some(hook) = hook {
                hook();
            }
            let request: Value = serde_json::from_str(body).unwrap();
            let step = (self.plan.lock().unwrap())(n, &request);
            match step {
                Step::Reply(status, body, retry_after_secs) => Ok(RawResponse { status, body, retry_after_secs }),
                Step::Fail(error) => Err(error),
                Step::Hang => {
                    tokio::time::sleep(Duration::from_secs(3600)).await;
                    Err(TransportError::Network)
                }
                Step::Delay(ms, body) => {
                    let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    self.max_in_flight.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    self.in_flight.fetch_sub(1, Ordering::SeqCst);
                    Ok(RawResponse { status: 200, body, retry_after_secs: None })
                }
            }
        })
    }
}

// --- reply generation: what a well-behaved JEV would answer for a request -----------------------------------------------------------------

#[derive(Clone)]
struct Profile {
    target: Option<&'static str>,
    p: f64,
    reframing: f64,
    /// additive, correction, replacement, subtask, other
    change: [f64; 5],
    referent: f64,
    supersedes: f64,
    model: &'static str,
    usage: bool,
}

impl Profile {
    fn clean(target: &'static str) -> Self {
        Self { target: Some(target), p: 0.97, reframing: 0.02, change: [0.92, 0.04, 0.02, 0.01, 0.01], referent: 0.95, supersedes: 0.02, model: JEV_MODEL, usage: true }
    }
    fn distinct() -> Self {
        Self { target: None, p: 0.0, ..Self::clean("a") }
    }
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

fn choice_answer(mut probs: Vec<(String, f64)>) -> Value {
    for entry in &mut probs {
        entry.1 = round2(entry.1);
    }
    let sum: f64 = probs.iter().map(|e| e.1).sum();
    let top = probs.iter().enumerate().max_by(|a, b| a.1 .1.partial_cmp(&b.1 .1).unwrap()).map(|(i, _)| i).unwrap();
    probs[top].1 = round2(probs[top].1 + (1.0 - sum));
    let (name, confidence) = (probs[top].0.clone(), probs[top].1);
    json!({ "type": "choice", "choice": name, "confidence": confidence, "probabilities": probs.into_iter().map(|(k, v)| (k, json!(v))).collect::<serde_json::Map<_, _>>() })
}

fn reply(request: &Value, profile: &Profile) -> Value {
    let mut answers = serde_json::Map::new();
    for (key, question) in request["questions"].as_object().unwrap() {
        let is_target = |k: &str| profile.target.is_some_and(|t| key.ends_with(&format!("_{t}")) && key.starts_with(k));
        let answer = match key.as_str() {
            "referent" => json!({ "type": "noul", "noul": profile.referent }),
            "supersedes" => json!({ "type": "noul", "noul": profile.supersedes }),
            "relation" => {
                let options: Vec<String> = question["criteria"].as_object().unwrap().keys().cloned().collect();
                let target = profile.target.map(|t| format!("revise_{t}"));
                let probs = options
                    .iter()
                    .map(|o| {
                        let p = if Some(o) == target.as_ref() { profile.p } else if o == "new" { 1.0 - if target.is_some() { profile.p } else { 0.0 } } else { 0.0 };
                        (o.clone(), p)
                    })
                    .collect();
                choice_answer(probs)
            }
            k if k.starts_with("redef_") => json!({ "type": "noul", "noul": if is_target("redef_") { profile.reframing } else { 0.03 } }),
            k if k.starts_with("kind_") => {
                let (r, other) = if is_target("kind_") { (profile.reframing, 0.0) } else { (0.0, 1.0) };
                choice_answer(vec![("detail_update".into(), 1.0 - r - other), ("reframing".into(), r), ("other".into(), other)])
            }
            k if k.starts_with("change_") => {
                let names = ["additive", "correction", "replacement", "subtask", "other"];
                let weights = if is_target("change_") { profile.change } else { [0.0, 0.0, 0.0, 0.0, 1.0] };
                choice_answer(names.iter().zip(weights).map(|(n, w)| (n.to_string(), w)).collect())
            }
            other => panic!("unexpected question {other}"),
        };
        answers.insert(key.clone(), answer);
    }
    let mut out = json!({ "model": profile.model, "answers": answers });
    if profile.usage {
        out["usage"] = json!({ "input_tokens": 600, "output_tokens": 80 });
    }
    out
}

// --- fixtures -----------------------------------------------------------------------------------------------------------------------------

fn project(id: &str) -> ProjectState {
    ProjectState { id: id.into(), archived: false, is_inbox: false }
}

fn idea(id: &str, title: &str, body: &str) -> Candidate {
    Candidate { object_id: id.into(), project: project("arthur"), lifecycle: ObjectLifecycle::Active, current_revision_id: format!("{id}-r1"), revision: RevisionView { id: format!("{id}-r1"), origin: "initial".into(), kind: "idea".into(), title: title.into(), body: body.into() } }
}

fn claim(ordinal: usize, text: &str) -> Claim {
    Claim { ordinal, kind: "idea".into(), title: "Desktop".into(), body: text.into(), evidence: EvidenceSpan { capture_id: "cap".into(), start: 0, end: text.chars().count() as i64 }, evidence_text: text.into(), project: project("arthur") }
}

const TEXT: &str = "Arthur will also support desktop.";

fn items(n_claims: usize, candidates: Vec<Candidate>) -> Vec<(Claim, Vec<Candidate>)> {
    (0..n_claims).map(|i| (claim(i, TEXT), candidates.clone())).collect()
}

fn two() -> Vec<Candidate> {
    vec![idea("obj-a", "Mobile", "Arthur is a mobile application."), idea("obj-b", "Voice", "Arthur needs voice recognition.")]
}

struct Rig {
    provider: Arc<JevIdentityProvider>,
    fake: Arc<Fake>,
    consent: Arc<JevConsent>,
    settings: Arc<EvolutionSettings>,
    secrets: Arc<MemorySecretStore>,
}

fn rig_with(fake: Arc<Fake>, retry: RetryPolicy, timeout: Duration, limits: JevLimits) -> Rig {
    let secrets = Arc::new(MemorySecretStore::default());
    secrets.set(ProviderId::TypeSafe, &ApiKey::parse(SECRET).unwrap()).unwrap();
    let consent = Arc::new(JevConsent::in_memory(true));
    let settings = Arc::new(EvolutionSettings::in_memory(true));
    let client = JevClient::new(fake.clone(), retry, timeout, 2, 100_000);
    let provider = Arc::new(JevIdentityProvider::new(client, Arc::new(TypeSafeCredential::new(secrets.clone())), consent.clone(), settings.clone()).with_limits(limits));
    Rig { provider, fake, consent, settings, secrets }
}

fn fast() -> RetryPolicy {
    RetryPolicy { max_attempts: 3, base_delay: Duration::ZERO, max_delay: Duration::ZERO }
}

fn rig(fake: Arc<Fake>) -> Rig {
    rig_with(fake, fast(), Duration::from_millis(400), JevLimits::default())
}

fn classify(rig: &Rig, items: &[(Claim, Vec<Candidate>)]) -> Vec<Result<ClassifierOutput, ClassifierFailure>> {
    tauri::async_runtime::block_on(rig.provider.classify_capture(items))
}

use crate::identity::ClassifierOutput;

// --- 1. valid answers -----------------------------------------------------------------------------------------------------------------------

#[test]
fn a_valid_answer_becomes_one_signal_per_candidate_with_stable_ids_for_three_runs() {
    let rig = rig(Fake::valid(Profile::clean("a")));
    let out = classify(&rig, &items(1, two())).remove(0).unwrap();
    assert_eq!((out.model_id.as_str(), out.runs.len()), (JEV_MODEL, 3));
    for run in &out.runs {
        assert_eq!(run.iter().map(|s| s.candidate_id.as_str()).collect::<Vec<_>>(), ["obj-a", "obj-b"], "candidate order, original ids");
        assert!(run[0].same_proposition >= 0.95 && run[1].same_proposition <= 0.05);
        assert_eq!((run[0].relation, run[0].referent_resolved, run[0].explicit_supersession), (Some(Relation::AdditiveRefinement), Some(true), Some(false)));
        assert!(run[0].reframing <= 0.05);
    }
    assert_eq!(rig.fake.calls(), 3, "one request per run");
}

#[test]
fn several_candidates_map_back_by_opaque_id_whatever_order_they_were_shown_in() {
    let mut candidates = two();
    candidates.push(idea("obj-c", "Offline", "Arthur needs offline storage."));
    let rig = rig(Fake::valid(Profile::clean("c")));
    let out = classify(&rig, &items(1, candidates)).remove(0).unwrap();
    for run in &out.runs {
        let high: Vec<&str> = run.iter().filter(|s| s.same_proposition > 0.5).map(|s| s.candidate_id.as_str()).collect();
        assert_eq!(high, ["obj-c"], "the target is identified by id, not by position");
    }
}

#[test]
fn the_three_runs_show_the_ideas_and_options_in_different_orders() {
    let rig = rig(Fake::valid(Profile::clean("a")));
    classify(&rig, &items(1, vec![two()[0].clone(), two()[1].clone(), idea("obj-c", "Offline", "Arthur needs offline storage.")]));
    let bodies = rig.fake.bodies();
    let ideas: Vec<Vec<String>> = bodies.iter().map(|b| b["state"]["existing_ideas"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap().to_string()).collect()).collect();
    assert_eq!(ideas[0], ["a", "b", "c"]);
    assert_ne!(ideas[0], ideas[1]);
    assert_ne!(ideas[0], ideas[2]);
    assert_ne!(ideas[1], ideas[2]);
    // the WIRE order of the options (a parsed Value would sort the keys, so read the raw text)
    let wire: Vec<Vec<&str>> = rig.fake.raw_bodies().iter().map(|raw| {
        let block = &raw[raw.find("\"relation\":{").unwrap()..];
        let block = &block[..block.find("\"referent\":").unwrap()];
        let mut found: Vec<(usize, &str)> = ["\"new\":", "\"revise_a\":", "\"revise_b\":", "\"revise_c\":", "\"uncertain\":"].iter().map(|k| (block.find(k).unwrap(), *k)).collect();
        found.sort();
        found.into_iter().map(|(_, k)| k).collect()
    }).collect();
    assert!(wire[0] != wire[1] && wire[1] != wire[2] && wire[0] != wire[2], "the options reach the wire in a different order each run: {wire:?}");
    for b in &bodies {
        assert_eq!(b["model"], JEV_MODEL);
    }
    for n in 1..=4 {
        for run in 0..3 {
            let mut sorted = permutation(n, run);
            sorted.sort();
            assert_eq!(sorted, (0..n).collect::<Vec<_>>(), "every permutation is a permutation");
        }
    }
}

// --- what is sent ------------------------------------------------------------------------------------------------------------------------------

#[test]
fn only_the_minimum_context_is_sent_and_never_ids_projects_or_keys() {
    let rig = rig(Fake::valid(Profile::clean("a")));
    let candidates = vec![idea("11111111-1111-4111-8111-111111111111", "Mobile", "Arthur is a mobile application.")];
    classify(&rig, &items(1, candidates));
    for body in rig.fake.bodies() {
        let text = body.to_string();
        assert!(text.contains(TEXT) && text.contains("Arthur is a mobile application."));
        assert!(!text.contains("11111111-1111") && !text.contains("obj-") && !text.contains("arthur\"") && !text.contains("\"cap\"") && !text.contains(SECRET), "{text}");
        assert_eq!(body["state"]["new_capture"].as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>(), ["exact_words", "text", "title"].map(String::from).into());
        assert_eq!(body["state"]["existing_ideas"][0].as_object().unwrap().keys().cloned().collect::<std::collections::BTreeSet<_>>(), ["id", "text", "title"].map(String::from).into());
    }
    assert!(rig.fake.keys.lock().unwrap().iter().all(|k| k == SECRET), "the key travels only to the transport, as the header value");
}

#[test]
fn a_candidate_from_another_project_is_refused_with_no_request() {
    let rig = rig(Fake::valid(Profile::clean("a")));
    let mut foreign = idea("obj-x", "Foreign", &format!("{IDEA_SECRET} other project"));
    foreign.project = project("orbit");
    let out = classify(&rig, &items(1, vec![two()[0].clone(), foreign]));
    assert_eq!(out[0].clone().unwrap_err(), ClassifierFailure::Unavailable);
    assert_eq!(rig.fake.calls(), 0);
    assert_eq!(rig.provider.diagnostics().failures.get("cross_project"), None, "refused while building, before any request");
}

#[test]
fn oversized_input_and_too_many_candidates_are_refused_before_any_request() {
    let rig = rig(Fake::valid(Profile::clean("a")));
    let big: Vec<Candidate> = (0..4).map(|i| idea(&format!("obj-{i}"), "T", &"x".repeat(2_000))).collect();
    let mut c = claim(0, &"y".repeat(2_000));
    c.title = "t".into();
    let out = classify(&rig, &[(c, big)]);
    assert!(out[0].is_err());
    let five: Vec<Candidate> = (0..5).map(|i| idea(&format!("obj-{i}"), "T", "small")).collect();
    assert!(classify(&rig, &items(1, five))[0].is_err());
    assert_eq!(rig.fake.calls(), 0);
    assert!(matches!(build_run(&claim(0, TEXT), &(0..5).map(|i| idea(&format!("o{i}"), "T", "b")).collect::<Vec<_>>(), 0), Err(JevError::TooManyCandidates)));
    assert!(matches!(build_run(&c_with(&"y".repeat(2_000)), &(0..4).map(|i| idea(&format!("o{i}"), "T", &"x".repeat(2_000))).collect::<Vec<_>>(), 0), Err(JevError::InputTooLarge)));
}

fn c_with(text: &str) -> Claim {
    claim(0, text)
}

// --- untrusted answers -------------------------------------------------------------------------------------------------------------------

fn parse_with(mutate: impl Fn(&mut Value)) -> Result<(), JevError> {
    let candidates = two();
    let plan = build_run(&claim(0, TEXT), &candidates, 0).unwrap();
    let request: Value = serde_json::from_str(&plan.body).unwrap();
    let mut answer = reply(&request, &Profile::clean("a"));
    mutate(&mut answer);
    parse_run(&plan, &["obj-a".to_string(), "obj-b".to_string()], &answer.to_string(), &Mapping::default()).map(|_| ())
}

#[test]
fn a_well_formed_answer_parses_and_the_helper_really_exercises_the_parser() {
    assert_eq!(parse_with(|_| {}), Ok(()));
}

#[test]
fn every_malformed_unexpected_or_inconsistent_answer_is_a_typed_failure() {
    let cases: Vec<(&str, Box<dyn Fn(&mut Value)>)> = vec![
        ("a different model id", Box::new(|v| v["model"] = json!("jev-1.14.0"))),
        ("the jev-latest alias", Box::new(|v| v["model"] = json!("jev-latest"))),
        ("no model", Box::new(|v| { v.as_object_mut().unwrap().remove("model"); })),
        ("an unknown choice", Box::new(|v| v["answers"]["relation"]["choice"] = json!("revise_z"))),
        ("an unknown target identifier in the probabilities", Box::new(|v| { let p = v["answers"]["relation"]["probabilities"].as_object_mut().unwrap(); let x = p.remove("revise_b").unwrap(); p.insert("revise_z".into(), x); })),
        ("a missing probability", Box::new(|v| { v["answers"]["relation"]["probabilities"].as_object_mut().unwrap().remove("new"); })),
        ("an extra option", Box::new(|v| { v["answers"]["relation"]["probabilities"].as_object_mut().unwrap().insert("revise_q".into(), json!(0.0)); })),
        ("a missing noul result", Box::new(|v| { v["answers"].as_object_mut().unwrap().remove("redef_a"); })),
        ("a missing choice result", Box::new(|v| { v["answers"].as_object_mut().unwrap().remove("relation"); })),
        ("an unrequested answer", Box::new(|v| v["answers"]["sneaky"] = json!({ "type": "noul", "noul": 0.5 }))),
        ("the wrong answer type", Box::new(|v| v["answers"]["referent"]["type"] = json!("choice"))),
        ("a noul as a string", Box::new(|v| v["answers"]["referent"]["noul"] = json!("0.9"))),
        ("a null probability", Box::new(|v| v["answers"]["relation"]["probabilities"]["new"] = Value::Null)),
        ("a negative probability", Box::new(|v| v["answers"]["relation"]["probabilities"]["new"] = json!(-0.2))),
        ("a probability above one", Box::new(|v| v["answers"]["redef_a"]["noul"] = json!(1.4))),
        ("an enormous number", Box::new(|v| v["answers"]["supersedes"]["noul"] = json!(1e300))),
        ("probabilities that do not sum to one", Box::new(|v| { v["answers"]["relation"]["probabilities"]["revise_a"] = json!(0.4); v["answers"]["relation"]["probabilities"]["new"] = json!(0.2); })),
        ("a choice that contradicts its own probabilities", Box::new(|v| v["answers"]["relation"]["choice"] = json!("new"))),
        ("a missing confidence", Box::new(|v| { v["answers"]["relation"].as_object_mut().unwrap().remove("confidence"); })),
        ("answers that are not an object", Box::new(|v| v["answers"] = json!([1, 2]))),
        ("the whole answer not an object", Box::new(|v| *v = json!([]))),
    ];
    for (name, mutate) in cases {
        let result = parse_with(&*mutate);
        assert!(matches!(result, Err(JevError::Malformed(_) | JevError::UnexpectedModel)), "{name}: {result:?}");
    }
    let plan = build_run(&claim(0, TEXT), &two(), 0).unwrap();
    for text in ["", "not json", "{", "null", "[]", "{\"model\":\"jev-1.13.0\"}"] {
        assert!(parse_run(&plan, &["a".into(), "b".into()], text, &Mapping::default()).is_err(), "{text:?}");
    }
    assert_eq!(parse_with(|v| v["model"] = json!("jev-latest")), Err(JevError::UnexpectedModel));
}

#[test]
fn a_wrong_answer_is_never_retried_and_fails_closed() {
    for mutate in [|v: &mut Value| v["model"] = json!("jev-1.14.0"), |v: &mut Value| v["answers"]["relation"]["choice"] = json!("zzz")] {
        let fake = Fake::new(move |_, request| {
            let mut answer = reply(request, &Profile::clean("a"));
            mutate(&mut answer);
            Step::Reply(200, answer.to_string(), None)
        });
        let rig = rig(fake);
        let out = classify(&rig, &items(2, two()));
        assert!(out.iter().all(|r| r.as_ref().unwrap_err() == &ClassifierFailure::Unreadable));
        assert_eq!(rig.fake.calls(), 2, "one request per claim, no retry of a wrong answer");
    }
}

#[test]
fn a_mapped_signal_prefers_the_riskier_reading() {
    let mut p = Profile::clean("a");
    p.reframing = 0.35;
    let rig = rig(Fake::valid(p));
    let out = classify(&rig, &items(1, two())).remove(0).unwrap();
    assert_eq!(out.runs[0][0].relation, Some(Relation::Reframing));
    assert!(out.runs[0][0].reframing >= 0.35, "the larger of the Noul and Choice guards");
    let mut q = Profile::clean("a");
    q.change = [0.4, 0.05, 0.4, 0.05, 0.1];
    let rig = rig_with(Fake::valid(q), fast(), Duration::from_millis(400), JevLimits::default());
    assert_eq!(classify(&rig, &items(1, two())).remove(0).unwrap().runs[0][0].relation, Some(Relation::DecisionReplacement));
    let mut r = Profile::clean("a");
    r.referent = 0.4;
    r.supersedes = 0.9;
    let out = classify(&rig_with(Fake::valid(r), fast(), Duration::from_millis(400), JevLimits::default()), &items(1, two())).remove(0).unwrap();
    assert_eq!((out.runs[0][0].referent_resolved, out.runs[0][0].explicit_supersession), (Some(false), Some(true)));
}

// --- the pure resolver on JEV output ---------------------------------------------------------------------------------------------------------

fn resolve_with(profile: Profile) -> Outcome {
    let rig = rig(Fake::valid(profile));
    let it = items(1, two());
    let results = classify(&rig, &it);
    let prefetched = Prefetched::new(&it, results);
    let mut policy = resolver_policy();
    policy.enabled = true;
    resolve(&it[0].0, &it[0].1, &policy, &prefetched).outcome
}

#[test]
fn the_resolver_accepts_a_clean_refinement_and_blocks_reframing_and_ambiguity() {
    assert!(matches!(resolve_with(Profile::clean("a")), Outcome::Revise { relation: Relation::AdditiveRefinement, .. }));
    assert!(matches!(resolve_with(Profile { reframing: 0.6, ..Profile::clean("a") }), Outcome::Uncertain { .. }), "reframing needs a person");
    assert!(matches!(resolve_with(Profile { p: 0.7, ..Profile::clean("a") }), Outcome::Uncertain { .. }), "below the placeholder bar");
    assert!(matches!(resolve_with(Profile::distinct()), Outcome::New { .. }));
    assert!(matches!(resolve_with(Profile { referent: 0.2, ..Profile::clean("a") }), Outcome::Uncertain { .. }));
    // and an answer for a different model id never gets that far
    let out = resolve_with(Profile { model: "jev-9", ..Profile::clean("a") });
    assert!(matches!(out, Outcome::New { reason: crate::identity::NewReason::Unchecked(_) }));
}

#[test]
fn contradictory_votes_across_runs_never_revise() {
    let fake = Fake::new(|n, request| {
        // run 0 and 1 say "a", run 2 says "b"
        let target = if n == 2 { "b" } else { "a" };
        Step::Reply(200, reply(request, &Profile::clean(target)).to_string(), None)
    });
    let rig = rig(fake);
    let it = items(1, two());
    let prefetched = Prefetched::new(&it, classify(&rig, &it));
    let mut policy = resolver_policy();
    policy.enabled = true;
    let resolution = resolve(&it[0].0, &it[0].1, &policy, &prefetched);
    assert!(!resolution.is_revise());
    assert_eq!(resolution.identity, Identity::Ambiguous);
}

// --- failures and retries -----------------------------------------------------------------------------------------------------------------------

#[test]
fn authentication_failure_is_not_retried_and_stops_the_capture() {
    let rig = rig(Fake::new(|_, _| Step::Reply(401, "{\"error\":\"Missing or invalid API key\"}".into(), None)));
    let out = classify(&rig, &items(3, two()));
    assert!(out.iter().all(|r| r.as_ref().unwrap_err() == &ClassifierFailure::Unavailable));
    assert_eq!(rig.fake.calls(), 1, "no retry, and the next claims are not even sent");
    assert_eq!(rig.provider.diagnostics().failures.get("auth"), Some(&1));
}

#[test]
fn rate_limiting_and_overload_are_retried_with_backoff_then_succeed() {
    for status in [429u16, 529] {
        let fake = Fake::new(move |n, request| if n < 2 { Step::Reply(status, "{}".into(), Some(0)) } else { Step::Reply(200, reply(request, &Profile::clean("a")).to_string(), None) });
        let rig = rig(fake);
        let out = classify(&rig, &items(1, two()));
        assert!(out[0].is_ok(), "{status}");
        let d = rig.provider.diagnostics();
        assert_eq!((d.retries, d.requests), (2, 5), "two retries on the first run, then three runs' worth: {status}");
    }
}

#[test]
fn persistent_overload_exhausts_the_retries_and_does_not_hammer_the_next_claims() {
    for (status, code) in [(429u16, "rate_limited"), (529, "overloaded"), (503, "server")] {
        let rig = rig(Fake::new(move |_, _| Step::Reply(status, "{}".into(), None)));
        let out = classify(&rig, &items(3, two()));
        assert!(out.iter().all(|r| r.is_err()));
        assert_eq!(rig.fake.calls(), 3, "max_attempts for the first request, then nothing: {status}");
        let d = rig.provider.diagnostics();
        assert_eq!(d.failures.get("retries_exhausted"), Some(&1));
        assert!(d.failures.contains_key(code));
    }
}

#[test]
fn a_validation_error_and_other_client_errors_are_not_retried() {
    for status in [400u16, 404, 422] {
        let rig = rig(Fake::new(move |_, _| Step::Reply(status, "{\"detail\":\"bad\"}".into(), None)));
        assert!(classify(&rig, &items(1, two()))[0].is_err());
        assert_eq!(rig.fake.calls(), 1, "{status}");
    }
    let rig = rig(Fake::new(|_, _| Step::Reply(302, "".into(), None)));
    assert!(classify(&rig, &items(1, two()))[0].is_err());
    assert_eq!(rig.fake.calls(), 1, "a redirect is not followed or retried");
}

#[test]
fn network_interruption_is_retried_and_then_reported() {
    let net = rig(Fake::new(|_, _| Step::Fail(TransportError::Network)));
    let out = classify(&net, &items(1, two()));
    assert_eq!(out[0].clone().unwrap_err(), ClassifierFailure::Network);
    assert_eq!(net.fake.calls(), 3);
    let big = rig(Fake::new(|_, _| Step::Fail(TransportError::TooLarge)));
    assert!(classify(&big, &items(1, two()))[0].is_err());
    assert_eq!(big.fake.calls(), 1, "an oversized answer is not retried");
}

#[test]
fn a_request_that_never_answers_times_out_and_is_reported_as_a_timeout() {
    let rig = rig_with(Fake::new(|_, _| Step::Hang), RetryPolicy { max_attempts: 1, ..fast() }, Duration::from_millis(60), JevLimits::default());
    assert_eq!(classify(&rig, &items(1, two())).remove(0).unwrap_err(), ClassifierFailure::Timeout);
    let retried = rig_with(Fake::new(|_, _| Step::Hang), fast(), Duration::from_millis(40), JevLimits::default());
    assert_eq!(classify(&retried, &items(1, two())).remove(0).unwrap_err(), ClassifierFailure::Timeout);
    assert_eq!(retried.fake.calls(), 3, "timeouts are retried a bounded number of times");
}

#[test]
fn cancellation_stops_new_requests_and_interrupts_a_long_backoff() {
    let rig = rig(Fake::valid(Profile::clean("a")));
    rig.provider.cancel();
    assert_eq!(classify(&rig, &items(1, two())).remove(0).unwrap_err(), ClassifierFailure::Unavailable);
    assert_eq!(rig.fake.calls(), 0);

    let slow = RetryPolicy { max_attempts: 3, base_delay: Duration::from_secs(30), max_delay: Duration::from_secs(30) };
    let rig = rig_with(Fake::new(|_, _| Step::Reply(429, "{}".into(), None)), slow, Duration::from_millis(400), JevLimits::default());
    let provider = rig.provider.clone();
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        provider.cancel();
    });
    let started = std::time::Instant::now();
    let out = classify(&rig, &items(1, two()));
    canceller.join().unwrap();
    assert!(out[0].is_err() && started.elapsed() < Duration::from_secs(5), "cancel cut the 30 s backoff short");
    assert_eq!(rig.fake.calls(), 1);
}

#[test]
fn budgets_cap_requests_per_capture_and_per_day() {
    let rig = rig_with(Fake::valid(Profile::clean("a")), fast(), Duration::from_millis(400), JevLimits { runs: 3, max_requests_per_capture: 4 });
    let out = classify(&rig, &items(3, two()));
    assert!(out[0].is_ok(), "the first claim fits (3 requests)");
    assert!(out[1].is_err() && out[2].is_err());
    assert_eq!(rig.fake.calls(), 4, "never more than the per-capture budget");

    let daily = JevClient::new(Fake::valid(Profile::clean("a")), fast(), Duration::from_millis(400), 2, 2);
    let secrets = Arc::new(MemorySecretStore::default());
    secrets.set(ProviderId::TypeSafe, &ApiKey::parse(SECRET).unwrap()).unwrap();
    let p = JevIdentityProvider::new(daily, Arc::new(TypeSafeCredential::new(secrets)), Arc::new(JevConsent::in_memory(true)), Arc::new(EvolutionSettings::in_memory(true)));
    assert!(tauri::async_runtime::block_on(p.classify_capture(&items(1, two())))[0].is_err());
    assert_eq!(p.diagnostics().requests, 2, "the daily cap of 2 stopped the third request");
    let budget = Budget::new(0);
    let _ = budget;
}

#[test]
fn concurrency_is_bounded() {
    let fake = Fake::new(|_, request| Step::Delay(40, reply(request, &Profile::clean("a")).to_string()));
    let rig = rig(fake);
    let handles: Vec<_> = (0..6)
        .map(|_| {
            let provider = rig.provider.clone();
            tauri::async_runtime::spawn(async move {
                let it = items(1, two());
                provider.classify_capture(&it).await
            })
        })
        .collect();
    for handle in handles {
        assert!(tauri::async_runtime::block_on(handle).unwrap()[0].is_ok());
    }
    assert!(rig.fake.max_in_flight.load(Ordering::SeqCst) <= 2, "at most 2 requests in flight, saw {}", rig.fake.max_in_flight.load(Ordering::SeqCst));
    assert_eq!(rig.fake.calls(), 18);
}

// --- gates: evolution, consent, credential ---------------------------------------------------------------------------------------------------

#[test]
fn nothing_is_sent_without_evolution_consent_and_a_typesafe_credential() {
    let missing_key = rig(Fake::valid(Profile::clean("a")));
    missing_key.secrets.delete(ProviderId::TypeSafe).unwrap();
    assert!(classify(&missing_key, &items(1, two()))[0].is_err());

    let no_consent = rig(Fake::valid(Profile::clean("a")));
    no_consent.consent.revoke().unwrap();
    assert!(classify(&no_consent, &items(1, two()))[0].is_err());

    let off = rig(Fake::valid(Profile::clean("a")));
    off.settings.set(false).unwrap();
    assert!(classify(&off, &items(1, two()))[0].is_err());

    // only an OpenAI key exists: it is never borrowed
    let other = rig(Fake::valid(Profile::clean("a")));
    other.secrets.delete(ProviderId::TypeSafe).unwrap();
    other.secrets.set(ProviderId::OpenAi, &ApiKey::parse("sk-openai-key").unwrap()).unwrap();
    assert!(classify(&other, &items(1, two()))[0].is_err());

    for r in [&missing_key, &no_consent, &off, &other] {
        assert_eq!(r.fake.calls(), 0);
    }
    assert_eq!(missing_key.provider.diagnostics().failures.get("no_credential"), Some(&1));
    assert_eq!(no_consent.provider.diagnostics().failures.get("no_consent"), Some(&1));
    assert_eq!(off.provider.diagnostics().failures.get("disabled"), Some(&1));
}

#[test]
fn a_key_alone_is_not_consent_and_revocation_stops_the_very_next_request() {
    let rig = rig(Fake::valid(Profile::clean("a")));
    rig.consent.revoke().unwrap();
    assert!(!rig.provider.still_allowed());
    rig.consent.grant().unwrap();
    assert!(rig.provider.still_allowed());
    // revoke in the middle of a classification: no further request is sent
    let consent = rig.consent.clone();
    rig.fake.on_call(move || consent.revoke().unwrap());
    let out = classify(&rig, &items(2, two()));
    assert!(out.iter().all(|r| r.is_err()));
    assert_eq!(rig.fake.calls(), 1, "the first request was already in flight; nothing was sent after the revocation");
}

#[test]
fn consent_is_off_by_default_durable_versioned_and_independent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("evolution").join("jev_consent.json");
    assert!(!JevConsent::new(path.clone()).granted(), "missing file: OFF");
    let consent = JevConsent::new(path.clone());
    consent.grant().unwrap();
    assert!(JevConsent::new(path.clone()).granted(), "survives a restart");
    assert_eq!(consent.state().unwrap().disclosure_version, DISCLOSURE_VERSION);
    consent.revoke().unwrap();
    assert!(!JevConsent::new(path.clone()).granted());
    assert!(!consent.granted());

    let record = |version: u64, provider: &str, disclosure: &str| format!(r#"{{"version":{version},"provider":"{provider}","granted":true,"disclosureVersion":"{disclosure}","changedAt":"x"}}"#);
    // every record is valid EXCEPT for the one thing named, so each case proves its own rule
    let bad = ["{ nope".to_string(), "{}".to_string(), record(1, "openai", DISCLOSURE_VERSION), record(1, "typesafe", "typesafe-2020-old"), record(1, "typesafe", "typesafe-2026-04-v1"), record(9, "typesafe", DISCLOSURE_VERSION)];
    for damaged in bad {
        std::fs::write(&path, &damaged).unwrap();
        assert!(!JevConsent::new(path.clone()).granted(), "{damaged}");
    }
    std::fs::write(&path, record(1, "typesafe", DISCLOSURE_VERSION)).unwrap();
    assert!(JevConsent::new(path.clone()).granted(), "the control: a well-formed current record IS honoured, so the rejections above are real");
    std::fs::remove_file(&path).unwrap();
    // independence: its own file; evolution's switch and the OpenAI slot are unaffected
    let settings = EvolutionSettings::new(dir.path().join("evolution").join("settings.json"));
    consent.grant().unwrap();
    assert!(!settings.enabled(), "consent does not turn Evolution on");
    settings.set(true).unwrap();
    consent.revoke().unwrap();
    assert!(settings.enabled(), "revoking consent does not change Evolution's own setting");
    let secrets = MemorySecretStore::default();
    secrets.set(ProviderId::OpenAi, &ApiKey::parse("sk-openai").unwrap()).unwrap();
    assert!(!JevConsent::in_memory(false).granted() && secrets.has(ProviderId::OpenAi) && !secrets.has(ProviderId::TypeSafe));
}

#[test]
fn the_typesafe_slot_is_separate_from_openai_and_invisible_to_the_ui_commands() {
    let secrets = MemorySecretStore::default();
    secrets.set(ProviderId::TypeSafe, &ApiKey::parse(SECRET).unwrap()).unwrap();
    assert!(!secrets.has(ProviderId::OpenAi));
    assert_eq!(ProviderId::parse("typesafe"), None, "AiService::set_credential / has_credential / delete_credential cannot name it");
    assert!(!ProviderId::ALL.contains(&ProviderId::TypeSafe));
    let credential = TypeSafeCredential::new(Arc::new(secrets));
    assert_eq!(credential.api_key().unwrap().expose(), SECRET);
}

// --- accounting -------------------------------------------------------------------------------------------------------------------------------

#[test]
fn usage_is_accounted_and_missing_usage_is_estimated_not_fatal() {
    let rig = rig(Fake::valid(Profile::clean("a")));
    classify(&rig, &items(1, two()));
    let d = rig.provider.diagnostics();
    assert_eq!((d.requests, d.input_tokens, d.output_tokens, d.usage_missing), (3, 1800, 240, 0));
    assert!((d.estimated_cost_usd - 1800.0 * PRICE_PER_INPUT_TOKEN_USD).abs() < 1e-12);

    let quiet = rig_with(Fake::valid(Profile { usage: false, ..Profile::clean("a") }), fast(), Duration::from_millis(400), JevLimits::default());
    assert!(classify(&quiet, &items(1, two()))[0].is_ok());
    let d = quiet.provider.diagnostics();
    assert_eq!(d.usage_missing, 3);
    assert!(d.input_tokens > 0, "estimated from the request size");
}

// --- redaction ---------------------------------------------------------------------------------------------------------------------------------

#[test]
fn nothing_sensitive_appears_in_errors_diagnostics_or_debug_output() {
    let scenarios: Vec<Arc<Fake>> = vec![
        Fake::new(|_, _| Step::Reply(401, format!("{{\"echo\":\"{SECRET} {CLAIM_SECRET}\"}}"), None)),
        Fake::new(|_, _| Step::Reply(200, format!("not json {SECRET} {CLAIM_SECRET}"), None)),
        Fake::new(|_, _| Step::Reply(500, format!("{CLAIM_SECRET} {IDEA_SECRET}"), None)),
        Fake::new(|_, _| Step::Fail(TransportError::Network)),
    ];
    for fake in scenarios {
        let rig = rig(fake);
        let it = vec![(claim(0, &format!("{CLAIM_SECRET} {TEXT}")), vec![idea("obj-a", "Mobile", &format!("{IDEA_SECRET} body"))])];
        let results = classify(&rig, &it);
        let mut everything = format!("{results:?} {:?} {:?}", rig.provider.diagnostics(), rig.provider);
        for error in [JevError::Auth, JevError::Malformed("x"), JevError::RetriesExhausted("server"), JevError::NoConsent] {
            everything.push_str(&format!("{error} {error:?}"));
        }
        for secret in [SECRET, CLAIM_SECRET, IDEA_SECRET] {
            assert!(!everything.contains(secret), "{secret} leaked: {everything}");
        }
    }
    let key = ApiKey::parse(SECRET).unwrap();
    assert!(!format!("{key:?}").contains(SECRET));
}

// --- the real HTTP transport (localhost, no key) ---------------------------------------------------------------------------------------------------

#[test]
fn the_real_transport_posts_json_with_a_bearer_header_and_never_leaks_the_key_in_errors() {
    let (url, request) = crate::test_support::serve_once("/v1/systemone", "200 OK", "{\"ok\":true}".into());
    let transport = ReqwestTransport::with_endpoint(url);
    let key = ApiKey::parse(SECRET).unwrap();
    let response = tauri::async_runtime::block_on(transport.post(&key, "{\"state\":1}", Duration::from_secs(5))).unwrap();
    assert_eq!((response.status, response.body.as_str()), (200, "{\"ok\":true}"));
    let raw = String::from_utf8_lossy(&request.recv().unwrap()).to_lowercase();
    assert!(raw.starts_with("post /v1/systemone"), "{raw}");
    assert!(raw.contains(&format!("authorization: bearer {}", SECRET.to_lowercase())) && raw.contains("content-type: application/json") && raw.ends_with("{\"state\":1}"));

    let dead = ReqwestTransport::with_endpoint(crate::test_support::dead_endpoint("/v1/systemone"));
    let error = tauri::async_runtime::block_on(dead.post(&key, "{}", Duration::from_secs(2))).unwrap_err();
    assert!(!format!("{error:?}").contains(SECRET));
    assert_eq!(error, TransportError::Network);

    let (big_url, _rx) = crate::test_support::serve_once("/v1/systemone", "200 OK", "x".repeat(300 * 1024));
    let big = ReqwestTransport::with_endpoint(big_url);
    assert_eq!(tauri::async_runtime::block_on(big.post(&key, "{}", Duration::from_secs(5))).unwrap_err(), TransportError::TooLarge);
}

// --- end to end through the real pipeline ------------------------------------------------------------------------------------------------------

mod pipeline {
    use super::*;
    use crate::distillation::evolution::{ClassifierBackend, DraftFailure, EvolutionLimits, EvolutionPipeline, RevisionDraft, RevisionDrafter};
    use crate::distillation::{Candidate as DistilledCandidate, DistillError, DistillationOutcome, DistillationService, Distiller};
    use crate::storage::capture_store::{CaptureStore, CreateCaptureInput};
    use crate::storage::evidence_store::EvidenceRole;
    use crate::storage::knowledge_store::NewKnowledgeObject;
    use crate::storage::lineage_store::{Changes, RevisionContent};

    struct Fixed(Vec<DistilledCandidate>);
    impl Distiller for Fixed {
        fn distill<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<Vec<DistilledCandidate>, DistillError>> {
            let out = self.0.clone();
            Box::pin(async move { Ok(out) })
        }
    }

    struct Drafts;
    impl RevisionDrafter for Drafts {
        fn draft(&self, request: &crate::distillation::evolution::DraftRequest<'_>) -> Result<RevisionDraft, DraftFailure> {
            Ok(RevisionDraft { content: RevisionContent { kind: "idea".into(), title: request.target.revision.title.clone(), body: "Arthur is a mobile and desktop application.".into() }, role: EvidenceRole::Asserts, retracts: None, interpretation_label: None })
        }
    }

    struct World {
        store: Arc<CaptureStore>,
        project: String,
        mobile: String,
        other_project_idea: String,
    }

    fn world() -> World {
        let store = CaptureStore::open_in_memory().unwrap();
        let project = store.create_project("Arthur").unwrap().id;
        let elsewhere = store.create_project("Elsewhere").unwrap().id;
        let seed = |project: &str, text: &str, title: &str| {
            let c = store.create(CreateCaptureInput { source: "text".into(), content: text.into(), project_id: Some(project.into()) }).unwrap();
            store.record_distillation(&c.id, vec![NewKnowledgeObject { kind: "idea".into(), title: title.into(), body: text.into(), source_start: 0, source_end: text.chars().count() as i64 }]).unwrap().remove(0).id
        };
        let mobile = seed(&project, "Arthur is a mobile application.", "Mobile");
        let other_project_idea = seed(&elsewhere, &format!("{IDEA_SECRET} Arthur desktop client in another project."), "Foreign");
        World { store: Arc::new(store), project, mobile, other_project_idea }
    }

    fn service(provider: &Arc<JevIdentityProvider>, settings: &Arc<EvolutionSettings>) -> DistillationService {
        let distiller = Arc::new(Fixed(vec![DistilledCandidate { kind: "idea".into(), title: "Desktop".into(), body: TEXT.into(), evidence: "Arthur will also support desktop".into(), source_start: None, source_end: None }]));
        DistillationService::new(distiller).with_evolution(EvolutionPipeline {
            settings: settings.clone(),
            classifier: ClassifierBackend::Async(provider.clone()),
            still_allowed: Some(provider.gate()),
            drafter: Arc::new(Drafts),
            synthesis: None,
            policy: resolver_policy(),
            limits: EvolutionLimits::default(),
        })
    }

    fn run(service: &DistillationService, w: &World) -> DistillationOutcome {
        let capture = w.store.create(CreateCaptureInput { source: "voice".into(), content: TEXT.into(), project_id: Some(w.project.clone()) }).unwrap();
        tauri::async_runtime::block_on(service.distill_detailed(&w.store, &capture.id)).unwrap()
    }

    fn tables(w: &World) -> [i64; 4] {
        ["thought_revisions", "revision_evidence", "identity_decisions", "pending_claims"].map(|t| w.store.query_i64_for_test(&format!("SELECT count(*) FROM {t}")))
    }

    #[test]
    fn a_clean_refinement_flows_through_the_real_pipeline_to_a_system_revision_and_only_same_project_text_is_sent() {
        let w = world();
        let rig = rig(Fake::valid(Profile::clean("a")));
        let out = run(&service(&rig.provider, &rig.settings), &w);
        assert_eq!((out.revised.len(), out.pending.len(), out.objects.len()), (1, 0, 0));
        assert_eq!(w.store.object_lineage(&w.mobile).unwrap().revisions.last().unwrap().origin, "system");
        assert_eq!(rig.fake.calls(), 3);
        for body in rig.fake.bodies() {
            let text = body.to_string();
            assert!(!text.contains(IDEA_SECRET) && !text.contains("another project") && !text.contains(&w.other_project_idea) && !text.contains(&w.mobile) && !text.contains(&w.project), "{text}");
            assert_eq!(body["state"]["existing_ideas"].as_array().unwrap().len(), 1, "only the capture's own project");
        }
    }

    #[test]
    fn with_evolution_off_or_consent_missing_nothing_is_sent_and_the_old_behaviour_remains() {
        for mutate in [|r: &Rig| r.settings.set(false).unwrap(), |r: &Rig| r.consent.revoke().unwrap()] {
            let w = world();
            let rig = rig(Fake::valid(Profile::clean("a")));
            mutate(&rig);
            let before = tables(&w);
            let out = run(&service(&rig.provider, &rig.settings), &w);
            assert_eq!(rig.fake.calls(), 0);
            assert_eq!(out.revised.len(), 0);
            assert_eq!(w.store.object_lineage(&w.mobile).unwrap().revisions.len(), 1, "no automatic revision");
            let _ = before;
        }
        // evolution OFF: the plain path, not even a decision row
        let w = world();
        let rig = rig(Fake::valid(Profile::clean("a")));
        rig.settings.set(false).unwrap();
        let out = run(&service(&rig.provider, &rig.settings), &w);
        assert_eq!((out.objects.len(), tables(&w)[2], tables(&w)[3]), (1, 0, 0));
    }

    #[test]
    fn a_provider_failure_keeps_the_claim_as_an_unchecked_object_and_the_capture() {
        let w = world();
        let rig = rig(Fake::new(|_, _| Step::Reply(529, "{}".into(), None)));
        let out = run(&service(&rig.provider, &rig.settings), &w);
        assert_eq!((out.objects.len(), out.revised.len()), (1, 0));
        let capture = w.store.list().unwrap().into_iter().find(|c| c.content == TEXT).unwrap();
        let decision = &w.store.identity_decisions_for(&capture.id).unwrap()[0];
        assert_eq!((decision.input.outcome, decision.input.unchecked_reason.as_deref()), (crate::storage::identity_store::DecisionOutcome::Unchecked, Some("classifier_failed")));
    }

    #[test]
    fn no_database_lock_is_held_while_a_request_is_in_flight() {
        let w = world();
        let rig = rig(Fake::valid(Profile::clean("a")));
        // while the "network" is busy, a user edit goes through the same store: it would deadlock if the pipeline held the lock
        let (store, id) = (w.store.clone(), w.mobile.clone());
        rig.fake.on_call(move || {
            let current = store.object_lineage(&id).unwrap();
            if current.revisions.len() == 1 {
                store.update_object(&id, Changes { body: Some("Arthur is a mobile app, written by me.".into()), ..Changes::default() }).unwrap();
            }
        });
        let out = run(&service(&rig.provider, &rig.settings), &w);
        let lineage = w.store.object_lineage(&w.mobile).unwrap();
        assert_eq!(lineage.revisions.iter().map(|r| r.origin.as_str()).collect::<Vec<_>>(), ["initial", "user_edit"]);
        assert_eq!((out.revised.len(), out.pending.len()), (0, 1), "the stale decision became a pending claim");
    }

    #[test]
    fn consent_revoked_while_waiting_means_no_revision_is_written() {
        let w = world();
        let rig = rig(Fake::valid(Profile::clean("a")));
        let consent = rig.consent.clone();
        // revoke during the LAST request: the answer arrives, but it must be discarded
        rig.fake.on_call({
            let calls = Arc::new(AtomicUsize::new(0));
            move || {
                if calls.fetch_add(1, Ordering::SeqCst) == 2 {
                    consent.revoke().unwrap();
                }
            }
        });
        let out = run(&service(&rig.provider, &rig.settings), &w);
        assert_eq!(out.revised.len(), 0);
        assert_eq!(w.store.object_lineage(&w.mobile).unwrap().revisions.len(), 1);
        assert_eq!(out.objects.len() + out.pending.len(), 1, "the claim is kept, as an unchecked object or a pending claim, never lost");
    }
}

// --- the disclosure -------------------------------------------------------------------------------------------------------------------------

#[test]
fn the_disclosure_states_what_is_established_and_is_pinned_to_its_version() {
    let all = DISCLOSURE_POINTS.join(" ").to_lowercase();
    for required in ["third-party", "four of your existing ideas", "not train", "not fully established", "united states", "does not delete", "off until you turn it on", "api key does not turn it on"] {
        assert!(all.contains(required), "the disclosure must say: {required}");
    }
    for promise in ["zero retention", "deleted", "gdpr", "guarantee", "compliant", "never stored"] {
        assert!(!all.contains(promise), "the disclosure must not promise: {promise}");
    }
    // Editing the text without bumping DISCLOSURE_VERSION would let old consent apply to new words: this fails until both change.
    assert_eq!((DISCLOSURE_VERSION, disclosure_checksum()), ("typesafe-optin-2026-10-v1", 14216552626861586578));
}

#[test]
fn consent_never_migrates_from_an_older_disclosure_and_creating_the_provider_creates_no_record() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("jev_consent.json");
    std::fs::write(&path, r#"{"version":1,"provider":"typesafe","granted":true,"disclosureVersion":"typesafe-2026-04-v1","changedAt":"x"}"#).unwrap();
    let before = std::fs::read(&path).unwrap();
    let consent = JevConsent::new(path.clone());
    assert!(!consent.granted() && consent.state().is_none(), "the old grant is ignored");
    assert_eq!(std::fs::read(&path).unwrap(), before, "and reading it rewrites nothing");
    let fresh = dir.path().join("none.json");
    let _ = (JevConsent::new(fresh.clone()), EvolutionSettings::new(dir.path().join("e.json")));
    assert!(!fresh.exists(), "constructing consent or settings never writes a record");
}
