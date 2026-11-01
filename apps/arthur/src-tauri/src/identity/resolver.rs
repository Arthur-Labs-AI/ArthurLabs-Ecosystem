//! The pure decision procedure. Order matters and is the safety argument:
//!
//! 1. disabled / invalid input / no eligible candidate  -> NEW (unchecked), classifier never called
//! 2. classifier failure or any malformed signal         -> NEW (unchecked): fail closed
//! 3. identity from the signals                          -> Distinct | Same(target) | Ambiguous | Unknown
//! 4. permission gates on a unique Same target           -> Automatic | Confirmation(vetoes)
//! 5. capture-level conflicts                            -> downgrade only
//!
//! Only step 4 with an empty veto list produces REVISE. Nothing after the classifier call can turn a worse outcome into a better one.

use std::collections::{BTreeMap, BTreeSet};

use super::classifier::{ClassifierOutput, ClassifyRequest, IdentityClassifier};
use super::policy::{has_supersession_wording, is_user_owned, kinds_compatible, ResolverPolicy};
use super::types::*;

fn audit_for(policy: &ResolverPolicy, claim: &Claim) -> Audit {
    Audit {
        policy_version: policy.version.clone(),
        model_id: None,
        claim_ordinal: claim.ordinal,
        candidates_sent: vec![],
        excluded: vec![],
        scores: vec![],
        runs: 0,
        vetoes: vec![],
    }
}

fn unchecked(reason: UncheckedReason, mut audit: Audit, vetoes: Vec<Veto>) -> Resolution {
    audit.vetoes.extend(vetoes);
    Resolution {
        outcome: Outcome::New {
            reason: NewReason::Unchecked(reason),
        },
        identity: Identity::Unknown,
        permission: Permission::NotApplicable,
        audit,
    }
}

fn claim_problem(claim: &Claim) -> bool {
    let span = &claim.evidence;
    claim.project.id.is_empty()
        || claim.kind.is_empty()
        || !KINDS.contains(&claim.kind.as_str())
        || claim.title.trim().is_empty()
        || claim.body.trim().is_empty()
        || span.capture_id.is_empty()
        || span.start < 0
        || span.end <= span.start
        || claim.evidence_text.is_empty()
        || claim.evidence_text.chars().count() as i64 != span.end - span.start
}

/// Why a candidate may not even be shown to the classifier (and so can never be a target).
fn ineligible(claim: &Claim, candidate: &Candidate) -> Option<Veto> {
    if candidate.object_id.is_empty()
        || candidate.current_revision_id.is_empty()
        || candidate.current_revision_id != candidate.revision.id
    {
        return Some(Veto::InconsistentSnapshot);
    }
    if candidate.project.id != claim.project.id {
        return Some(Veto::ProjectMismatch);
    }
    if candidate.project.archived || claim.project.archived {
        return Some(Veto::ProjectArchived);
    }
    if candidate.lifecycle != ObjectLifecycle::Active {
        return Some(Veto::TargetArchived);
    }
    None
}

/// The candidates the resolver would actually show a classifier: same project, unarchived, consistent snapshot. A caller that fetches
/// classifications before calling `resolve` uses this so exactly the same, already-filtered set is sent (nothing else ever leaves).
pub fn eligible_candidates(claim: &Claim, candidates: &[Candidate]) -> Vec<Candidate> {
    candidates
        .iter()
        .filter(|candidate| ineligible(claim, candidate).is_none())
        .cloned()
        .collect()
}

#[derive(Debug, Clone, Copy)]
struct Aggregate {
    /// Weakest run: unanimity means the target must clear the bar in EVERY run.
    min_same: f64,
    /// Most generous run: a plausible referent to ANY run counts as plausible.
    max_same: f64,
    max_reframing: f64,
    relation: Option<Relation>,
    relation_agrees: bool,
    referent_resolved: bool,
    explicit_supersession: bool,
}

/// Validates untrusted signals against the candidates actually shown and aggregates the runs. `Err` means: fail closed.
fn validate(
    policy: &ResolverPolicy,
    output: &ClassifierOutput,
    sent: &[String],
) -> Result<BTreeMap<String, Aggregate>, Veto> {
    if !policy
        .accepted_models
        .iter()
        .any(|model| model == &output.model_id)
    {
        return Err(Veto::UnknownModel);
    }
    if output.runs.len() < policy.min_runs.max(1) {
        return Err(Veto::TooFewRuns);
    }
    let sent_set: BTreeSet<&str> = sent.iter().map(String::as_str).collect();
    let mut per_candidate: BTreeMap<String, Vec<&CandidateSignal>> = BTreeMap::new();
    for run in &output.runs {
        let mut seen = BTreeSet::new();
        for signal in run {
            if !sent_set.contains(signal.candidate_id.as_str()) {
                return Err(Veto::UnknownCandidateId);
            }
            if !seen.insert(signal.candidate_id.as_str()) {
                return Err(Veto::DuplicateSignal);
            }
            let in_range = |score: f64| score.is_finite() && (0.0..=1.0).contains(&score);
            if !in_range(signal.same_proposition) || !in_range(signal.reframing) {
                return Err(Veto::OutOfRangeScore);
            }
            if signal.same_proposition >= policy.plausible_floor
                && (signal.relation.is_none()
                    || signal.referent_resolved.is_none()
                    || signal.explicit_supersession.is_none())
            {
                return Err(Veto::IncompleteSignals);
            }
            per_candidate
                .entry(signal.candidate_id.clone())
                .or_default()
                .push(signal);
        }
        if seen.len() != sent_set.len() {
            return Err(Veto::IncompleteSignals);
        }
    }
    Ok(per_candidate
        .into_iter()
        .map(|(id, signals)| {
            let relations: BTreeSet<String> = signals
                .iter()
                .map(|s| format!("{:?}", s.relation))
                .collect();
            let aggregate = Aggregate {
                min_same: signals
                    .iter()
                    .map(|s| s.same_proposition)
                    .fold(f64::INFINITY, f64::min),
                max_same: signals
                    .iter()
                    .map(|s| s.same_proposition)
                    .fold(0.0, f64::max),
                max_reframing: signals.iter().map(|s| s.reframing).fold(0.0, f64::max),
                relation: signals[0].relation,
                relation_agrees: relations.len() == 1,
                referent_resolved: signals.iter().all(|s| s.referent_resolved == Some(true)),
                explicit_supersession: signals
                    .iter()
                    .all(|s| s.explicit_supersession == Some(true)),
            };
            (id, aggregate)
        })
        .collect())
}

/// Decides one claim. Never panics, never performs I/O beyond the injected classifier call.
pub fn resolve(
    claim: &Claim,
    candidates: &[Candidate],
    policy: &ResolverPolicy,
    classifier: &dyn IdentityClassifier,
) -> Resolution {
    let mut audit = audit_for(policy, claim);
    if !policy.enabled {
        return unchecked(UncheckedReason::Disabled, audit, vec![]);
    }
    if claim_problem(claim) {
        return unchecked(UncheckedReason::InvalidClaim, audit, vec![]);
    }
    let ids: BTreeSet<&str> = candidates.iter().map(|c| c.object_id.as_str()).collect();
    if candidates.len() > MAX_CANDIDATES || ids.len() != candidates.len() {
        return unchecked(UncheckedReason::InvalidCandidates, audit, vec![]);
    }

    let mut eligible: Vec<Candidate> = Vec::new();
    for candidate in candidates {
        match ineligible(claim, candidate) {
            Some(veto) => audit.excluded.push((candidate.object_id.clone(), veto)),
            None => eligible.push(candidate.clone()),
        }
    }
    if eligible.is_empty() {
        return Resolution {
            outcome: Outcome::New {
                reason: NewReason::Unchecked(UncheckedReason::NoEligibleCandidates),
            },
            identity: Identity::Distinct,
            permission: Permission::NotApplicable,
            audit,
        };
    }
    audit.candidates_sent = eligible.iter().map(|c| c.object_id.clone()).collect();

    let output = match classifier.classify(&ClassifyRequest {
        claim,
        candidates: &eligible,
    }) {
        Ok(output) => output,
        Err(failure) => {
            return unchecked(
                UncheckedReason::ClassifierFailed,
                audit,
                vec![Veto::ClassifierFailed(failure)],
            )
        }
    };
    audit.model_id = Some(output.model_id.clone());
    audit.runs = output.runs.len();
    let aggregates = match validate(policy, &output, &audit.candidates_sent) {
        Ok(aggregates) => aggregates,
        Err(veto) => return unchecked(UncheckedReason::MalformedSignals, audit, vec![veto]),
    };
    audit.scores = aggregates
        .iter()
        .map(|(id, a)| (id.clone(), a.min_same, a.max_reframing))
        .collect();

    let plausible: Vec<&String> = aggregates
        .iter()
        .filter(|(_, a)| a.max_same >= policy.plausible_floor)
        .map(|(id, _)| id)
        .collect();
    if plausible.is_empty() {
        return Resolution {
            outcome: Outcome::New {
                reason: NewReason::Distinct,
            },
            identity: Identity::Distinct,
            permission: Permission::NotApplicable,
            audit,
        };
    }
    let uncertain =
        |audit: Audit, identity: Identity, candidates: Vec<String>, vetoes: Vec<Veto>| {
            let mut audit = audit;
            audit.vetoes.extend(vetoes.iter().copied());
            Resolution {
                outcome: Outcome::Uncertain {
                    candidates,
                    reason: vetoes.clone(),
                },
                identity,
                permission: Permission::Confirmation(vetoes),
                audit,
            }
        };
    let plausible_ids: Vec<String> = plausible.iter().map(|id| (*id).clone()).collect();

    // Identity: exactly one candidate clears the bar in every run, no other candidate is plausible to any run, and the gap is wide.
    let strong: Vec<&String> = aggregates
        .iter()
        .filter(|(_, a)| a.min_same >= policy.min_same_proposition)
        .map(|(id, _)| id)
        .collect();
    if plausible.len() > 1 || strong.len() != 1 {
        let veto = if plausible.len() > 1 {
            Veto::AmbiguousTarget
        } else {
            Veto::WeakEvidence
        };
        return uncertain(audit, Identity::Ambiguous, plausible_ids, vec![veto]);
    }
    let target_id = strong[0].clone();
    let target = aggregates[&target_id];
    let best_other = aggregates
        .iter()
        .filter(|(id, _)| **id != target_id)
        .map(|(_, a)| a.max_same)
        .fold(0.0, f64::max);
    if target.min_same - best_other < policy.min_gap {
        return uncertain(
            audit,
            Identity::Ambiguous,
            plausible_ids,
            vec![Veto::AmbiguousTarget],
        );
    }
    if !target.relation_agrees {
        return uncertain(
            audit,
            Identity::Ambiguous,
            plausible_ids,
            vec![Veto::RunsDisagree],
        );
    }
    let Some(relation) = target.relation else {
        return unchecked(
            UncheckedReason::MalformedSignals,
            audit,
            vec![Veto::IncompleteSignals],
        );
    };
    match relation {
        Relation::DistinctSameProject | Relation::Unrelated => {
            return uncertain(
                audit,
                Identity::Ambiguous,
                plausible_ids,
                vec![Veto::RelationContradictsScore],
            )
        }
        Relation::Subtask => {
            return uncertain(
                audit,
                Identity::Unknown,
                plausible_ids,
                vec![Veto::SubtaskOfTarget],
            )
        }
        _ => {}
    }
    let identity = Identity::Same {
        target_id: target_id.clone(),
        relation,
    };

    // Permission: a separate question from identity. Every gate can only add a veto.
    let candidate = eligible
        .iter()
        .find(|c| c.object_id == target_id)
        .expect("the target is one of the candidates shown");
    let mut vetoes: Vec<Veto> = Vec::new();
    if relation == Relation::Reframing {
        vetoes.push(Veto::FundamentalReframing);
    }
    if target.max_reframing >= policy.max_reframing {
        vetoes.push(Veto::ReframingSignal);
    }
    if !target.referent_resolved {
        vetoes.push(Veto::ReferentUnresolved);
    }
    if !kinds_compatible(&claim.kind, &candidate.revision.kind) {
        vetoes.push(Veto::IncompatibleKind);
    }
    if is_user_owned(&candidate.revision.origin) {
        vetoes.push(Veto::UserOwnedRevision);
    }
    if relation == Relation::DecisionReplacement {
        if candidate.revision.kind != "decision" {
            vetoes.push(Veto::NotAPriorDecision);
        }
        if !target.explicit_supersession || !has_supersession_wording(&claim.evidence_text) {
            vetoes.push(Veto::SupersessionNotExplicit);
        }
    }
    if policy.inbox_requires_confirmation && claim.project.is_inbox {
        vetoes.push(Veto::InboxRequiresConfirmation);
    }
    if !vetoes.is_empty() {
        return uncertain(audit, identity, vec![target_id], vetoes);
    }
    let snapshot = TargetSnapshot {
        object_id: target_id,
        project_id: claim.project.id.clone(),
        base_revision_id: candidate.current_revision_id.clone(),
    };
    Resolution {
        outcome: Outcome::Revise {
            target: snapshot,
            relation,
        },
        identity,
        permission: Permission::Automatic,
        audit,
    }
}

/// Decides every claim of one capture, then removes conflicts: if two claims touch the same object (one revising it while another
/// revises it or lists it as a plausible target), NEITHER may revise it automatically. Conflicts only downgrade.
pub fn resolve_capture(
    items: &[(Claim, Vec<Candidate>)],
    policy: &ResolverPolicy,
    classifier: &dyn IdentityClassifier,
) -> Vec<Resolution> {
    let mut resolutions: Vec<Resolution> = items
        .iter()
        .map(|(claim, candidates)| resolve(claim, candidates, policy, classifier))
        .collect();
    let involved: Vec<BTreeSet<String>> = resolutions
        .iter()
        .map(|r| match &r.outcome {
            Outcome::Revise { target, .. } => BTreeSet::from([target.object_id.clone()]),
            Outcome::Uncertain { candidates, .. } => candidates.iter().cloned().collect(),
            Outcome::New { .. } => BTreeSet::new(),
        })
        .collect();
    for index in 0..resolutions.len() {
        let Outcome::Revise { target, .. } = &resolutions[index].outcome else {
            continue;
        };
        let target_id = target.object_id.clone();
        let clash = (0..resolutions.len())
            .any(|other| other != index && involved[other].contains(&target_id));
        if clash {
            let resolution = &mut resolutions[index];
            resolution.outcome = Outcome::Uncertain {
                candidates: vec![target_id],
                reason: vec![Veto::ConflictingClaims],
            };
            resolution.permission = Permission::Confirmation(vec![Veto::ConflictingClaims]);
            resolution.audit.vetoes.push(Veto::ConflictingClaims);
        }
    }
    resolutions
}
