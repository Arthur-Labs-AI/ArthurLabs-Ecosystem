//! Runs the corpus through the three layers and turns outcomes into metric rows.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use super::metrics::{Rate, Rows};
use super::{IdCase, RevCase};
use crate::identity::classifier::{
    ClassifierFailure, ClassifierOutput, ClassifyRequest, IdentityClassifier,
};
use crate::identity::fake::MODEL as ID_MODEL;
use crate::identity::{
    resolve, Candidate, CandidateSignal, Claim, EvidenceSpan, ObjectLifecycle, Outcome,
    ProjectState, Relation, ResolverPolicy, RevisionView,
};
use crate::providers::credentials::{ApiKey, CredentialSource};
use crate::synthesis::authorization::{ProviderAuthorization, Purpose};
use crate::synthesis::openai_verifier::OpenAiRevisionVerifier;
use crate::synthesis::validate::validate_draft;
use crate::synthesis::verdict::CHECKS;
use crate::synthesis::{
    Assertion, ChangeClass, RevisionVerifier, SynthesisDraft, SynthesisRequest, Verdict,
    VerifyRequest,
};

pub const SYNTH_MODEL: &str = "gpt-6-luna";

pub fn request_of(case: &RevCase) -> SynthesisRequest {
    SynthesisRequest {
        kind: "idea".into(),
        title: "Idea".into(),
        base_body: case.base.clone(),
        change: ChangeClass::parse(&case.change).expect("change"),
        sources: vec![],
        claim_title: "Note".into(),
        claim_body: case.claim.clone(),
        claim_quote: case.claim.trim_end_matches('.').into(),
    }
}

pub fn draft_of(case: &RevCase) -> SynthesisDraft {
    let rows = |list: &[super::AssertionRow]| {
        list.iter()
            .map(|a| Assertion {
                text: a.text.clone(),
                source: a.source.clone(),
            })
            .collect::<Vec<_>>()
    };
    SynthesisDraft {
        kind: "idea".into(),
        revised_body: case.draft.revised_body.clone(),
        change: ChangeClass::parse(&case.change).expect("change"),
        retained: rows(&case.draft.retained),
        added: rows(&case.draft.added),
        withdrawn: rows(&case.draft.withdrawn),
        model: format!("{SYNTH_MODEL}-20260922"),
    }
}

/// `Err(storage name)` when the deterministic validator stops the draft.
pub fn deterministic(case: &RevCase) -> Result<(), &'static str> {
    validate_draft(&request_of(case), &draft_of(case), SYNTH_MODEL)
        .map(|_| ())
        .map_err(|veto| veto.storage_name())
}

/// What happened to one case end to end.
#[derive(Debug, Clone)]
pub struct Outcome4 {
    pub id: String,
    pub lang: String,
    pub safe: bool,
    pub class: Option<String>,
    /// Stopped by the deterministic validator (never reached the verifier).
    pub stopped_by_validator: bool,
    /// `Some` only when the draft reached the verifier.
    pub verdict: Option<Verdict>,
}

impl Outcome4 {
    /// The draft would be applied: it passed the validator AND (when a verifier is part of the layer) the verifier said Pass.
    pub fn accepted(&self, with_verifier: bool) -> bool {
        if self.stopped_by_validator {
            return false;
        }
        !with_verifier || self.verdict == Some(Verdict::Pass)
    }
}

pub fn run_validator(cases: &[RevCase]) -> Vec<Outcome4> {
    cases
        .iter()
        .map(|c| Outcome4 {
            id: c.id.clone(),
            lang: c.lang.clone(),
            safe: c.label == "safe",
            class: c.unsafe_class.clone(),
            stopped_by_validator: deterministic(c).is_err(),
            verdict: None,
        })
        .collect()
}

struct Key;
impl CredentialSource for Key {
    fn api_key(&self) -> Option<ApiKey> {
        ApiKey::parse("sk-EVAL-FIXTURE-KEY-0001")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mock {
    /// Answers from the implementer's label: cannot be wrong. Shows that the plumbing carries a correct verdict through.
    Oracle,
    /// Says pass to everything: shows how much safety rests on the verifier once a draft is past the validator.
    AlwaysPass,
    /// Every answer is unusable: nothing may be accepted.
    Garbage,
    /// The endpoint is down for every request.
    Outage,
}

fn pass_text() -> String {
    let checks: serde_json::Map<String, serde_json::Value> = CHECKS
        .iter()
        .map(|(n, _)| (n.to_string(), serde_json::json!(false)))
        .collect();
    serde_json::json!({ "verdict": "pass", "checks": checks }).to_string()
}

fn veto_text(class: &str) -> String {
    let checks: serde_json::Map<String, serde_json::Value> = CHECKS
        .iter()
        .map(|(n, _)| (n.to_string(), serde_json::json!(*n == class)))
        .collect();
    serde_json::json!({ "verdict": "veto", "checks": checks }).to_string()
}

fn envelope(content: &str) -> String {
    serde_json::json!({ "model": "gpt-6-luna-20260922", "choices": [{ "finish_reason": "stop", "message": { "content": content } }], "usage": { "prompt_tokens": 1, "completion_tokens": 1 } }).to_string()
}

/// Runs every draft that gets past the validator through the REAL (Luna) verifier adapter, against a localhost fixture scripted by `mock`.
pub fn run_with_mock_verifier(cases: &[RevCase], mock: Mock) -> Vec<Outcome4> {
    let mut outcomes = run_validator(cases);
    let reaching: Vec<usize> = (0..cases.len())
        .filter(|i| !outcomes[*i].stopped_by_validator)
        .collect();
    let replies: Vec<(&'static str, String)> = reaching
        .iter()
        .map(|i| match mock {
            Mock::Oracle if cases[*i].label == "safe" => ("200 OK", envelope(&pass_text())),
            Mock::Oracle => (
                "200 OK",
                envelope(&veto_text(
                    cases[*i].unsafe_class.as_deref().unwrap_or("contradiction"),
                )),
            ),
            Mock::AlwaysPass => ("200 OK", envelope(&pass_text())),
            Mock::Garbage => ("200 OK", envelope("looks fine")),
            Mock::Outage => ("503 Service Unavailable", "{}".into()),
        })
        .collect();
    let (url, _rx) = crate::test_support::serve_sequence(
        "/v1/chat/completions",
        if mock == Mock::Outage {
            replies
                .iter()
                .flat_map(|r| [r.clone(), r.clone()])
                .collect()
        } else {
            replies
        },
    );
    let verifier = OpenAiRevisionVerifier::for_test(
        Arc::new(Key),
        Arc::new(ProviderAuthorization::in_memory(
            "openai",
            Purpose::Verification,
            true,
        )),
        url,
        Duration::from_secs(5),
    );
    for i in reaching {
        let request = VerifyRequest {
            request: request_of(&cases[i]),
            draft: draft_of(&cases[i]),
        };
        outcomes[i].verdict = Some(tauri::async_runtime::block_on(verifier.verify(&request)));
    }
    outcomes
}

fn is(o: &Outcome4, classes: &[&str]) -> bool {
    o.class.as_deref().is_some_and(|c| classes.contains(&c))
}

/// Revision-faithfulness rows for one layer configuration.
pub fn revision_rows(outcomes: &[Outcome4], with_verifier: bool) -> Rows {
    let mut rows = Rows::default();
    let unsafe_all: Vec<&Outcome4> = outcomes.iter().filter(|o| !o.safe).collect();
    let safe_all: Vec<&Outcome4> = outcomes.iter().filter(|o| o.safe).collect();
    let acc = |list: &[&Outcome4]| list.iter().filter(|o| o.accepted(with_verifier)).count();
    rows.push(
        "unsafe drafts accepted (all classes)",
        Rate::of(acc(&unsafe_all), unsafe_all.len()),
    );
    let groups: [(&str, &[&str]); 9] = [
        (
            "unsupported-assertion acceptance (new fact / date / number / entity)",
            &[
                "unsupported_new_fact",
                "unsupported_date_quantity_or_entity",
            ],
        ),
        (
            "omission acceptance (dropped existing fact)",
            &["dropped_existing_fact"],
        ),
        (
            "incorrect-correction acceptance",
            &["wrong_correction_behaviour"],
        ),
        (
            "negation/qualifier change acceptance",
            &["negation_or_qualifier_changed"],
        ),
        ("scope expansion acceptance", &["scope_expanded"]),
        ("certainty increase acceptance", &["certainty_increased"]),
        ("contradiction acceptance", &["contradiction"]),
        (
            "ambiguous-reference acceptance",
            &["ambiguous_reference_guessed"],
        ),
        (
            "evidence-misattribution acceptance",
            &["evidence_misattributed"],
        ),
    ];
    for (name, classes) in groups {
        let list: Vec<&Outcome4> = unsafe_all
            .iter()
            .copied()
            .filter(|o| is(o, classes))
            .collect();
        rows.push(name, Rate::of(acc(&list), list.len()));
    }
    rows.push(
        "safe drafts rejected (false veto, end to end)",
        Rate::of(safe_all.len() - acc(&safe_all), safe_all.len()),
    );
    if with_verifier {
        let reached =
            |list: &[&Outcome4]| list.iter().copied().filter(|o| o.verdict.is_some()).count();
        let verdict = |list: &[&Outcome4], f: fn(&Verdict) -> bool| {
            list.iter()
                .filter(|o| o.verdict.as_ref().is_some_and(f))
                .count()
        };
        rows.push(
            "verifier false-PASS (unsafe drafts that reached it and passed)",
            Rate::of(
                verdict(&unsafe_all, |v| *v == Verdict::Pass),
                reached(&unsafe_all),
            ),
        );
        rows.push(
            "verifier false-VETO (safe drafts that reached it and were vetoed)",
            Rate::of(
                verdict(&safe_all, |v| matches!(v, Verdict::Veto(_))),
                reached(&safe_all),
            ),
        );
        let all: Vec<&Outcome4> = outcomes.iter().collect();
        rows.push(
            "verifier unavailable/unreadable (of drafts that reached it)",
            Rate::of(
                verdict(&all, |v| matches!(v, Verdict::Unavailable(_))),
                reached(&all),
            ),
        );
    }
    rows.push(
        "safe drafts stopped by the deterministic validator",
        Rate::of(
            safe_all.iter().filter(|o| o.stopped_by_validator).count(),
            safe_all.len(),
        ),
    );
    let mut by_lang: BTreeMap<&str, (usize, usize, usize, usize)> = BTreeMap::new();
    for o in outcomes {
        let e = by_lang.entry(o.lang.as_str()).or_default();
        if o.safe {
            e.2 += 1;
            e.3 += usize::from(!o.accepted(with_verifier));
        } else {
            e.0 += 1;
            e.1 += usize::from(o.accepted(with_verifier));
        }
    }
    for (lang, (u, ua, s, sr)) in by_lang {
        rows.push(format!("[{lang}] unsafe accepted"), Rate::of(ua, u));
        rows.push(format!("[{lang}] safe rejected"), Rate::of(sr, s));
    }
    rows
}

// ---- identity ---------------------------------------------------------------------------------------------------------------------

struct Scripted(Vec<Vec<CandidateSignal>>);
impl IdentityClassifier for Scripted {
    fn classify(&self, _: &ClassifyRequest<'_>) -> Result<ClassifierOutput, ClassifierFailure> {
        Ok(ClassifierOutput {
            model_id: ID_MODEL.into(),
            runs: self.0.clone(),
        })
    }
}

fn relation(name: &str) -> Relation {
    match name {
        "additive_refinement" => Relation::AdditiveRefinement,
        "correction" => Relation::Correction,
        "decision_replacement" => Relation::DecisionReplacement,
        "reframing" => Relation::Reframing,
        "subtask" => Relation::Subtask,
        _ => Relation::DistinctSameProject,
    }
}

pub fn identity_result(case: &IdCase) -> String {
    let project = || ProjectState {
        id: "p".into(),
        archived: false,
        is_inbox: false,
    };
    let claim = Claim {
        ordinal: 0,
        kind: "idea".into(),
        title: "Note".into(),
        body: case.claim.clone(),
        evidence: EvidenceSpan {
            capture_id: "c".into(),
            start: 0,
            end: case.claim.chars().count() as i64,
        },
        evidence_text: case.claim.clone(),
        project: project(),
    };
    let candidates: Vec<Candidate> = case
        .candidates
        .iter()
        .map(|id| Candidate {
            object_id: id.clone(),
            project: project(),
            lifecycle: ObjectLifecycle::Active,
            current_revision_id: format!("{id}-r1"),
            revision: RevisionView {
                id: format!("{id}-r1"),
                origin: "initial".into(),
                kind: "idea".into(),
                title: "Idea".into(),
                body: "Existing text.".into(),
            },
        })
        .collect();
    let runs = case
        .runs
        .iter()
        .map(|run| {
            run.iter()
                .map(|s| CandidateSignal {
                    candidate_id: s.id.clone(),
                    same_proposition: s.same,
                    reframing: s.reframing,
                    relation: Some(relation(&s.relation)),
                    referent_resolved: Some(s.referent),
                    explicit_supersession: Some(s.supersession),
                })
                .collect()
        })
        .collect();
    let policy = ResolverPolicy {
        enabled: true,
        accepted_models: vec![ID_MODEL.into()],
        ..ResolverPolicy::default()
    };
    match resolve(&claim, &candidates, &policy, &Scripted(runs)).outcome {
        Outcome::Revise { target, .. } => format!("revise:{}", target.object_id),
        Outcome::New { .. } => "new".into(),
        Outcome::Uncertain { .. } => "uncertain".into(),
    }
}

pub fn identity_rows(cases: &[IdCase]) -> Rows {
    let results: Vec<(&IdCase, String)> = cases.iter().map(|c| (c, identity_result(c))).collect();
    let mut rows = Rows::default();
    let not_revise: Vec<_> = results
        .iter()
        .filter(|(c, _)| !c.expect.starts_with("revise:"))
        .collect();
    let should_revise: Vec<_> = results
        .iter()
        .filter(|(c, _)| c.expect.starts_with("revise:"))
        .collect();
    let revised: Vec<_> = results
        .iter()
        .filter(|(_, r)| r.starts_with("revise:"))
        .collect();
    rows.push(
        "identity false-revision rate (should not revise, did)",
        Rate::of(
            not_revise
                .iter()
                .filter(|(_, r)| r.starts_with("revise:"))
                .count(),
            not_revise.len(),
        ),
    );
    rows.push(
        "identity recall (should revise that target, did)",
        Rate::of(
            should_revise.iter().filter(|(c, r)| &c.expect == r).count(),
            should_revise.len(),
        ),
    );
    rows.push(
        "incorrect-target rate (revised, wrong object)",
        Rate::of(
            revised
                .iter()
                .filter(|(c, r)| !c.expect.starts_with("revise:") || &c.expect != r)
                .count(),
            revised.len(),
        ),
    );
    rows.push(
        "UNCERTAIN rate (all cases)",
        Rate::of(
            results.iter().filter(|(_, r)| r == "uncertain").count(),
            results.len(),
        ),
    );
    rows.push(
        "outcome differs from implementer's expectation",
        Rate::of(
            results.iter().filter(|(c, r)| &c.expect != r).count(),
            results.len(),
        ),
    );
    let mut langs: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    for (c, r) in &results {
        let e = langs.entry(c.lang.as_str()).or_default();
        e.0 += 1;
        e.1 += usize::from(&c.expect != r);
    }
    for (lang, (n, bad)) in langs {
        rows.push(
            format!("[{lang}] outcome differs from expectation"),
            Rate::of(bad, n),
        );
    }
    rows
}

pub fn unavailable_is_never_accepted(outcomes: &[Outcome4]) -> bool {
    outcomes
        .iter()
        .all(|o| !matches!(o.verdict, Some(Verdict::Unavailable(_))) || !o.accepted(true))
}
