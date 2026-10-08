//! Stage B: semantic verification of proposed relations, and the deterministic gates that decide
//! what a verdict is allowed to do.
//!
//! The verifier (a second, narrowly scoped model call) judges each Stage A candidate from the two
//! objects' own text. It is shown the pair in a NEUTRAL order (by id), not the order Stage A chose, and
//! names the direction itself, so Stage A's orientation cannot anchor it. The whole batch is verified
//! TWICE, with the pair presented in opposite orders, and an edge survives only if both independent votes
//! reach the same kind and direction: a single sample was observed to flip a correct direction, and
//! disagreement means "not defensible". Whether a result counts as "accepted as proposed", "reversed" or
//! "reclassified" is COMPUTED here by comparing with Stage A, not claimed by the model. A verdict is an OPINION. This module turns it into a decision with rules
//! that do not depend on how the model phrased things:
//!
//! * Malformed output (a missing/duplicate/out-of-range verdict, an unknown id or kind, ...) is a TECHNICAL
//!   failure: the whole run is rejected and nothing is written, so the user can simply retry.
//! * A verdict that is well-formed but says "no" (reject, low/medium confidence, no explicit link,
//!   direction not clearly supported, or a decision label that contradicts its own kind) is a SEMANTIC rejection. That is not an error: the candidate is
//!   dropped and the rest of the run proceeds. Prefer zero edges over a questionable one.
//!
//! Gates for an edge the verifier wants to keep (all must hold, otherwise it is rejected):
//!   1. confidence is `high` (medium and low never persist);
//!   2. `explicitLink`: the objects' own text states or implies the link, not mere topic overlap;
//!   3. the output orientation is strongly supported (`forwardSupport == strong`);
//!   4. for a DIRECTIONAL kind, the opposite orientation is not also strong (ambiguous direction);
//!   5. `supersedes` additionally requires the replacement not to be OLDER than what it replaces.
//!
//! Direction is never inferred from id order: lexical ordering is applied afterwards, by the store's
//! canonicalization, to symmetric kinds only.

use std::collections::HashSet;

use serde::Deserialize;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::async_util::BoxFuture;
use crate::storage::knowledge_store::KnowledgeObject;
use crate::storage::relation_store::{canonical_ends, is_symmetric, NewRelation, KINDS};

use super::RelationError;

/// Turns the verifier's two independent ratings into a direction, deterministically.
///
/// The verifier does not PICK a direction (a pick was observed to default to whichever object was listed
/// first). It rates two separate claims: "first KIND second" and "second KIND first". Returns
/// `(first_is_source, support for that orientation, support for the opposite)`.
///
/// * directional kind: the strongly supported orientation wins if the other is not also strong. If both
///   are strong the direction is ambiguous, and if neither is strong there is no defensible direction;
///   both are reported with a support that the gates then reject.
/// * symmetric kind: order is irrelevant; it needs at least one strongly supported claim.
pub fn orient(kind: &str, first_to_second: Support, second_to_first: Support) -> (bool, Support, Support) {
    use Support::Strong;
    if is_symmetric(kind) {
        let best = if first_to_second == Strong || second_to_first == Strong { Strong } else { first_to_second.max_with(second_to_first) };
        return (true, best, Support::None);
    }
    match (first_to_second == Strong, second_to_first == Strong) {
        (true, false) => (true, first_to_second, second_to_first),
        (false, true) => (false, second_to_first, first_to_second),
        // Both strong: ambiguous. Neither: unsupported. The gates reject both, with the right reason.
        _ => (true, first_to_second, second_to_first),
    }
}

impl Support {
    fn max_with(self, other: Support) -> Support {
        match (self, other) {
            (Support::Strong, _) | (_, Support::Strong) => Support::Strong,
            (Support::Weak, _) | (_, Support::Weak) => Support::Weak,
            _ => Support::None,
        }
    }
}

/// One Stage A candidate, with the two objects it joins and the kind Stage A proposed.
#[derive(Debug, Clone)]
pub struct VerifyCandidate {
    pub index: usize,
    pub source: KnowledgeObject,
    pub target: KnowledgeObject,
    pub kind: String,
    /// When each object's CURRENT text was last written (the current revision's `created_at`, NOT the object's creation time). Context for
    /// the binary verifier only; `None` where the caller has no reliable value. Never used to infer cancellation or replacement.
    pub source_written_at: Option<String>,
    pub target_written_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    /// The proposed kind holds between these two objects (in the direction the verifier names).
    Accept,
    /// A different kind is the right one.
    Reclassify,
    Reject,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Support {
    Strong,
    Weak,
    None,
}

/// The verifier's untrusted opinion about one candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub index: usize,
    pub decision: Decision,
    pub kind: String,
    pub source_object_id: String,
    pub target_object_id: String,
    pub confidence: Confidence,
    pub forward_support: Support,
    pub reverse_support: Support,
    pub explicit_link: bool,
    /// M04.7A.3: one object's later decision, cancellation, removal of scope or changed priority makes the OTHER object's action or
    /// requirement unnecessary, rather than asserting an incompatible current fact. A VETO on `contradicts` only.
    pub cancels_or_obsoletes: bool,
    /// Concise evidence for the above, grounded in the two objects' own words.
    pub temporal_evidence: Option<String>,
    /// M04.7A.3: the object whose OWN text states that ITS plan or requirement is cancelled, abandoned or permanently removed (not postponed,
    /// paused, blocked or reprioritised). Resolved by the parser from the verifier's "first"/"second" using the order that was sent. For a
    /// `depends_on` claim it decides nothing unless it is the dependent (source) object.
    pub cancelled_plan_object_id: Option<String>,
    /// M04.7A.3: for a `depends_on` claim, the dependent's OWN current text shows that its requirement itself changed (it no longer needs the
    /// other object). NOT: the other object is unavailable, blocked, rejected, incomplete or cancelled; NOT: the dependent is postponed,
    /// paused or reprioritised. Evidence is `temporal_evidence`.
    pub dependency_no_longer_required: bool,
}

#[cfg(test)]
impl Verdict {
    /// A confident, well-supported verdict that accepts the candidate exactly as proposed.
    pub fn confirming(candidate: &VerifyCandidate) -> Self {
        Verdict {
            index: candidate.index,
            decision: Decision::Accept,
            kind: candidate.kind.clone(),
            source_object_id: candidate.source.id.clone(),
            target_object_id: candidate.target.id.clone(),
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
}

/// The conditional output contract for ACTIONABLE structured signals (M04.7A.3). For a `depends_on` claim two signals can delete an existing
/// edge: the DEPENDENT's plan is cancelled, or its requirement itself changed. Either must carry evidence; a missing or blank statement makes the
/// whole response contract-invalid (never a weaker verdict; evidence is never invented from a flag). A cancellation of the prerequisite, or of
/// anything on a claim that is not `depends_on`, can delete nothing, so it needs no evidence and is parsed as given.
pub fn actionable_signal_lacks_evidence(candidate: &VerifyCandidate, confirmed_kind: &str, oriented_source: &KnowledgeObject, cancelled_plan_object_id: Option<&str>, requirement_gone: bool, evidence: &str) -> bool {
    if !evidence.trim().is_empty() || (candidate.kind != "depends_on" && confirmed_kind != "depends_on") {
        return false;
    }
    let dependent_cancelled = cancelled_plan_object_id.is_some_and(|id| id == candidate.source.id || id == oriented_source.id);
    dependent_cancelled || requirement_gone
}

/// Evidence counts only if it is a short statement sharing at least one content word (4+ letters) with `object`'s OWN current text.
pub fn evidence_grounded_in(evidence: &Option<String>, object: &KnowledgeObject) -> bool {
    let Some(evidence) = evidence.as_deref().map(str::trim).filter(|e| !e.is_empty() && e.chars().count() <= 300) else { return false };
    let words = |text: &str| -> HashSet<String> { crate::recall::query::tokens(text).into_iter().filter(|t| t.chars().count() >= 4).collect() };
    let own = words(&format!("{} {}", object.title, object.body));
    // At least two distinct content words of the object's own text (one, if it has only one): a single shared word proves nothing.
    words(evidence).iter().filter(|word| own.contains(*word)).count() >= own.len().min(2)
}

/// THIS vote says the DEPENDENT object has itself cancelled, abandoned or permanently removed its plan, with evidence grounded in the
/// dependent's own current text. A cancelled prerequisite, a postponed or paused dependent, a lowered priority, or evidence that does not come
/// from the dependent's text never qualifies. `dependent` is the object that was said to NEED the other one.
pub fn dependent_plan_cancelled(verdict: &Verdict, dependent: &KnowledgeObject) -> bool {
    verdict.cancelled_plan_object_id.as_deref() == Some(dependent.id.as_str()) && evidence_grounded_in(&verdict.temporal_evidence, dependent)
}

/// THIS vote says the dependent's own current text shows its REQUIREMENT changed, so it no longer needs the other object, with grounded
/// evidence. Unavailability, failure or cancellation of the prerequisite is not a change of requirement.
pub fn dependency_requirement_gone(verdict: &Verdict, dependent: &KnowledgeObject) -> bool {
    verdict.dependency_no_longer_required && evidence_grounded_in(&verdict.temporal_evidence, dependent)
}

/// A moot verdict counts only if its evidence is grounded: a short statement that shares at least one content word (4+ letters) with the two
/// objects' own text. An empty, oversized or unrelated statement is ignored, so an unsupported temporal claim can never act as proof of anything.
pub fn moot_is_grounded(evidence: &Option<String>, source: &KnowledgeObject, target: &KnowledgeObject) -> bool {
    let Some(evidence) = evidence.as_deref().map(str::trim).filter(|e| !e.is_empty() && e.chars().count() <= 300) else { return false };
    let words = |text: &str| -> HashSet<String> { crate::recall::query::tokens(text).into_iter().filter(|t| t.chars().count() >= 4).collect() };
    let objects = words(&format!("{} {} {} {}", source.title, source.body, target.title, target.body));
    words(evidence).iter().any(|word| objects.contains(word))
}

/// Which way round the two objects of every candidate are listed to the verifier. Neither says anything
/// about direction; the two orders exist so that a verdict cannot be an artefact of one of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presentation {
    LowerIdFirst,
    HigherIdFirst,
}

/// The second cloud-model boundary. One call judges every candidate.
pub trait RelationVerifier: Send + Sync {
    fn verify<'a>(&'a self, candidates: &'a [VerifyCandidate], presentation: Presentation) -> BoxFuture<'a, Result<Vec<Verdict>, RelationError>>;
}

/// Why a well-formed verdict still did not become an edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    /// The verifier itself rejected it.
    Decided,
    NotHighConfidence,
    NoExplicitLink,
    DirectionUnsupported,
    DirectionAmbiguous,
    SupersedesNotNewer,
    /// A grounded `cancelsOrObsoletes` verdict: one object only makes the other unnecessary, which is not a contradiction.
    Obsoleted,
    /// The two independent verification votes did not reach the same kind and direction.
    VotesDisagree,
    /// The verdict contradicted itself (its decision label did not match the kind it named). Not trusted, not an error.
    Inconsistent,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Applied {
    /// Verified, canonical, de-duplicated edges. Not yet persisted.
    pub accepted: Vec<NewRelation>,
    /// `(candidate index, why)` for every semantic rejection.
    pub rejections: Vec<(usize, Rejection)>,
    /// Accepted with the objects swapped relative to Stage A.
    pub reversed: usize,
    /// Accepted as a different kind than Stage A proposed.
    pub reclassified: usize,
    /// Two candidates that ended up as the same verified edge (kept once).
    pub merged: usize,
}

fn malformed(reason: String) -> RelationError {
    RelationError::InvalidOutput(reason)
}

/// What one vote made of one candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Judgement {
    Keep(NewRelation),
    Reject(Rejection),
}

/// One verifier vote over the whole batch, judged candidate by candidate (in candidate order).
/// Malformed output is a technical failure; a well-formed "no" is a `Judgement::Reject`.
fn judge_all(candidates: &[VerifyCandidate], verdicts: Vec<Verdict>) -> Result<Vec<Judgement>, RelationError> {
    if verdicts.len() != candidates.len() {
        return Err(malformed(format!("expected {} verdicts, got {}", candidates.len(), verdicts.len())));
    }
    let mut by_index: Vec<Option<Verdict>> = vec![None; candidates.len()];
    for verdict in verdicts {
        let slot = by_index.get_mut(verdict.index).ok_or_else(|| malformed("a verdict has an index that was not asked about".into()))?;
        if slot.replace(verdict).is_some() {
            return Err(malformed("two verdicts for the same candidate".into()));
        }
    }

    let mut judgements = Vec::with_capacity(candidates.len());
    for (candidate, verdict) in candidates.iter().zip(by_index) {
        let verdict = verdict.ok_or_else(|| malformed("a candidate has no verdict".into()))?;
        let problem = |reason: &str| malformed(format!("verdict {}: {reason}", candidate.index));

        // Structural checks first: any failure here means the output cannot be trusted at all.
        if !KINDS.contains(&verdict.kind.as_str()) {
            return Err(problem("unknown relation kind"));
        }
        let (a, b) = (candidate.source.id.as_str(), candidate.target.id.as_str());
        let (vs, vt) = (verdict.source_object_id.as_str(), verdict.target_object_id.as_str());
        if !((vs == a && vt == b) || (vs == b && vt == a)) {
            return Err(problem("refers to an object that is not in the candidate"));
        }
        // A label that contradicts the kind is a verifier that cannot be trusted on THIS candidate. That is
        // a semantic rejection, not a failure of the whole run: the persisted fact is the kind, which still
        // has to pass every gate, and "accepted/reclassified" is computed from it, never taken from the label.
        let contradicts_itself = match verdict.decision {
            Decision::Accept => verdict.kind != candidate.kind,
            Decision::Reclassify => verdict.kind == candidate.kind,
            Decision::Reject => false,
        };

        // Semantic gates: well-formed, but is it defensible?
        let source = if vs == a { &candidate.source } else { &candidate.target };
        let target = if vs == a { &candidate.target } else { &candidate.source };
        let verdict_kind = verdict.kind.as_str();
        let rejection = if verdict.decision == Decision::Reject {
            Some(Rejection::Decided)
        } else if contradicts_itself {
            Some(Rejection::Inconsistent)
        } else if verdict.kind == "contradicts" && verdict.cancels_or_obsoletes && moot_is_grounded(&verdict.temporal_evidence, &candidate.source, &candidate.target) {
            Some(Rejection::Obsoleted)
        } else if verdict.confidence != Confidence::High {
            Some(Rejection::NotHighConfidence)
        } else if !verdict.explicit_link {
            Some(Rejection::NoExplicitLink)
        } else if verdict.forward_support != Support::Strong {
            Some(Rejection::DirectionUnsupported)
        } else if !is_symmetric(verdict_kind) && verdict.reverse_support == Support::Strong {
            Some(Rejection::DirectionAmbiguous)
        } else if verdict_kind == "supersedes" && !is_not_older(source, target) {
            Some(Rejection::SupersedesNotNewer)
        } else {
            None
        };
        judgements.push(match rejection {
            Some(reason) => Judgement::Reject(reason),
            None => {
                let (edge_source, edge_target) = canonical_ends(verdict_kind, vs, vt);
                Judgement::Keep(NewRelation { kind: verdict.kind, source_object_id: edge_source, target_object_id: edge_target })
            }
        });
    }
    Ok(judgements)
}

/// One vote. Equivalent to `apply_votes` with a single pass.
#[cfg(test)]
pub fn apply_verdicts(candidates: &[VerifyCandidate], verdicts: Vec<Verdict>) -> Result<Applied, RelationError> {
    apply_votes(candidates, vec![verdicts])
}

/// What the independent votes concluded about one candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Every vote kept it and all named the same edge (canonical ends, same kind and direction).
    Keep(NewRelation),
    /// Every vote rejected it, for the same reason.
    Reject(Rejection),
    /// The votes did not agree (some kept, some rejected, or they named different edges). Not a verified decision either way.
    Disagree,
}

/// Combines independent votes into ONE outcome per candidate, in candidate order. A candidate is `Keep` only if EVERY vote keeps it
/// and all votes name the same edge. Malformed output is an error; a well-formed "no" never is.
pub fn judge_votes(candidates: &[VerifyCandidate], votes: Vec<Vec<Verdict>>) -> Result<Vec<Outcome>, RelationError> {
    let judged = judge_each(candidates, votes)?;
    Ok((0..candidates.len()).map(|position| combine(&judged.iter().map(|vote| &vote[position]).collect::<Vec<_>>())).collect())
}

/// Every vote's own judgement of every candidate: `result[vote][candidate]`. Same structural checks and gates as `judge_votes`.
pub fn judge_each(candidates: &[VerifyCandidate], votes: Vec<Vec<Verdict>>) -> Result<Vec<Vec<Judgement>>, RelationError> {
    if votes.is_empty() {
        return Err(malformed("no verification votes".into()));
    }
    votes.into_iter().map(|verdicts| judge_all(candidates, verdicts)).collect()
}

/// The votes about ONE candidate, combined: kept only if every vote kept the same edge.
pub fn combine(votes: &[&Judgement]) -> Outcome {
    let first = votes[0];
    if !votes.iter().all(|vote| *vote == first) {
        return Outcome::Disagree;
    }
    match first {
        Judgement::Keep(edge) => Outcome::Keep(edge.clone()),
        Judgement::Reject(reason) => Outcome::Reject(*reason),
    }
}

/// Combines independent votes. A candidate is kept only if EVERY vote keeps it and all votes name the same
/// edge (same kind, same canonical ends, and for a directional kind the same direction). Anything else is a
/// semantic rejection, never an error.
pub fn apply_votes(candidates: &[VerifyCandidate], votes: Vec<Vec<Verdict>>) -> Result<Applied, RelationError> {
    let outcomes = judge_votes(candidates, votes)?;

    let mut applied = Applied::default();
    let mut seen: HashSet<(String, String, String)> = HashSet::new();
    for (candidate, outcome) in candidates.iter().zip(outcomes) {
        let edge = match outcome {
            Outcome::Keep(edge) => edge,
            Outcome::Reject(reason) => {
                applied.rejections.push((candidate.index, reason));
                continue;
            }
            Outcome::Disagree => {
                applied.rejections.push((candidate.index, Rejection::VotesDisagree));
                continue;
            }
        };
        if !seen.insert((edge.kind.clone(), edge.source_object_id.clone(), edge.target_object_id.clone())) {
            applied.merged += 1;
            continue;
        }
        // Computed, not claimed: a correction is a different kind, or the same directional kind the other way round.
        if edge.kind != candidate.kind {
            applied.reclassified += 1;
        } else if !is_symmetric(&edge.kind) && edge.source_object_id != candidate.source.id {
            applied.reversed += 1;
        }
        applied.accepted.push(edge);
    }
    Ok(applied)
}

/// A replacement cannot be older than what it replaces. Equal times are fine (objects from one
/// distillation share a moment). Unreadable times are treated as "not newer": reject, never guess.
fn is_not_older(replacement: &KnowledgeObject, replaced: &KnowledgeObject) -> bool {
    match (OffsetDateTime::parse(&replacement.created_at, &Rfc3339), OffsetDateTime::parse(&replaced.created_at, &Rfc3339)) {
        (Ok(newer), Ok(older)) => newer >= older,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::knowledge_store::Provenance;

    const A: &str = "11111111-1111-4111-8111-111111111111";
    const B: &str = "22222222-2222-4222-8222-222222222222";
    const C: &str = "33333333-3333-4333-8333-333333333333";
    const D: &str = "44444444-4444-4444-8444-444444444444";

    fn object(id: &str, at: &str) -> KnowledgeObject {
        KnowledgeObject { id: id.into(), kind: "idea".into(), title: id[..2].into(), body: "b".into(), created_at: at.into(), provenance: Provenance { capture_id: "c".into(), source_start: 0, source_end: 1 }, project_id: "p".into() }
    }

    fn candidate(index: usize, kind: &str, source: &str, target: &str) -> VerifyCandidate {
        VerifyCandidate { index, source: object(source, "2026-10-04T10:00:00Z"), target: object(target, "2026-10-04T10:00:00Z"), kind: kind.into(), source_written_at: None, target_written_at: None }
    }

    /// A confident, well-supported verdict that accepts the candidate as proposed.
    fn accept(candidate: &VerifyCandidate) -> Verdict {
        Verdict::confirming(candidate)
    }

    fn one(candidate: &VerifyCandidate, edit: impl FnOnce(&mut Verdict)) -> Result<Applied, RelationError> {
        let mut verdict = accept(candidate);
        edit(&mut verdict);
        apply_verdicts(std::slice::from_ref(candidate), vec![verdict])
    }

    fn rejected_because(result: Result<Applied, RelationError>, reason: Rejection) {
        let applied = result.unwrap();
        assert_eq!(applied.accepted, vec![], "nothing may be kept");
        assert_eq!(applied.rejections, vec![(0, reason)]);
    }

    fn technical(result: Result<Applied, RelationError>) {
        assert!(matches!(result, Err(RelationError::InvalidOutput(_))), "{result:?}");
    }

    // --- acceptance, direction -----------------------------------------------------------------

    #[test]
    fn a_confident_correctly_directed_dependency_is_kept_with_its_direction() {
        let c = candidate(0, "depends_on", A, B);
        let applied = one(&c, |_| {}).unwrap();
        assert_eq!(applied.accepted, vec![NewRelation { kind: "depends_on".into(), source_object_id: A.into(), target_object_id: B.into() }]);
        assert_eq!((applied.reversed, applied.reclassified, applied.rejections.len()), (0, 0, 0));
    }

    #[test]
    fn a_dependency_proposed_backwards_is_corrected_when_the_verifier_is_clear() {
        // Stage A said "B depends_on A". The verifier says it is really "A depends_on B".
        let c = candidate(0, "depends_on", B, A);
        let applied = one(&c, |v| {
            v.source_object_id = A.into();
            v.target_object_id = B.into();
        })
        .unwrap();
        assert_eq!(applied.accepted, vec![NewRelation { kind: "depends_on".into(), source_object_id: A.into(), target_object_id: B.into() }]);
        assert_eq!((applied.reversed, applied.reclassified), (1, 0), "the correction is computed by comparing with Stage A");
    }

    #[test]
    fn the_correction_is_by_meaning_not_by_id_order() {
        // The corrected edge keeps the verifier's direction even where that is the "larger id first" way round.
        let c = candidate(0, "extends", A, B);
        let applied = one(&c, |v| {
            v.source_object_id = B.into();
            v.target_object_id = A.into();
        })
        .unwrap();
        assert_eq!((applied.accepted[0].source_object_id.as_str(), applied.accepted[0].target_object_id.as_str()), (B, A));
    }

    #[test]
    fn every_directional_kind_keeps_the_verified_direction() {
        for kind in ["extends", "depends_on", "derived_from", "supersedes"] {
            let c = candidate(0, kind, B, A);
            let applied = one(&c, |_| {}).unwrap();
            assert_eq!((applied.accepted[0].source_object_id.as_str(), applied.accepted[0].target_object_id.as_str()), (B, A), "{kind}");
            let reversed = one(&c, |v| {
                v.source_object_id = A.into();
                v.target_object_id = B.into();
            })
            .unwrap();
            assert_eq!((reversed.accepted[0].source_object_id.as_str(), reversed.accepted[0].target_object_id.as_str()), (A, B), "{kind} corrected");
        }
    }

    #[test]
    fn an_ambiguous_dependency_is_rejected_when_both_directions_look_equally_plausible() {
        let c = candidate(0, "depends_on", A, B);
        for swapped in [false, true] {
            let result = one(&c, |v| {
                if swapped {
                    v.source_object_id = B.into();
                    v.target_object_id = A.into();
                }
                v.reverse_support = Support::Strong;
            });
            rejected_because(result, Rejection::DirectionAmbiguous);
        }
    }

    #[test]
    fn a_direction_with_no_clear_support_is_rejected_even_if_the_label_says_accept() {
        let c = candidate(0, "extends", A, B);
        for forward in [Support::Weak, Support::None] {
            for reverse in [Support::Weak, Support::None] {
                rejected_because(one(&c, |v| {
                    v.forward_support = forward;
                    v.reverse_support = reverse;
                }), Rejection::DirectionUnsupported);
            }
        }
    }

    #[test]
    fn an_inverted_verdict_whose_own_assessment_favours_the_other_way_is_rejected() {
        // The verifier says accept A->B but rates B->A as the stronger reading: not defensible.
        let c = candidate(0, "depends_on", A, B);
        rejected_because(one(&c, |v| {
            v.forward_support = Support::Weak;
            v.reverse_support = Support::Strong;
        }), Rejection::DirectionUnsupported);
    }

    // --- confidence, explicit link -------------------------------------------------------------

    #[test]
    fn only_high_confidence_survives() {
        let c = candidate(0, "extends", A, B);
        for confidence in [Confidence::Medium, Confidence::Low] {
            rejected_because(one(&c, |v| v.confidence = confidence), Rejection::NotHighConfidence);
        }
        assert_eq!(one(&c, |_| {}).unwrap().accepted.len(), 1);
    }

    #[test]
    fn a_link_resting_on_shared_topic_or_wording_is_rejected_for_every_kind() {
        for kind in KINDS {
            let c = candidate(0, kind, A, B);
            rejected_because(one(&c, |v| v.explicit_link = false), Rejection::NoExplicitLink);
        }
    }

    #[test]
    fn related_to_is_not_a_fallback_a_weak_generic_pair_yields_nothing() {
        let c = candidate(0, "related_to", A, B);
        // "same project" pair: the verifier is unsure and finds no explicit link.
        rejected_because(one(&c, |v| {
            v.confidence = Confidence::Medium;
            v.explicit_link = false;
        }), Rejection::NotHighConfidence);
        rejected_because(one(&c, |v| v.decision = Decision::Reject), Rejection::Decided);
    }

    // --- type discrimination -------------------------------------------------------------------

    #[test]
    fn a_vague_related_to_can_be_reclassified_as_the_stronger_extends() {
        let c = candidate(0, "related_to", A, B);
        let applied = one(&c, |v| {
            v.decision = Decision::Reclassify;
            v.kind = "extends".into();
            v.source_object_id = B.into();
            v.target_object_id = A.into();
        })
        .unwrap();
        assert_eq!(applied.accepted, vec![NewRelation { kind: "extends".into(), source_object_id: B.into(), target_object_id: A.into() }]);
        assert_eq!((applied.reclassified, applied.reversed), (1, 0));
    }

    #[test]
    fn duplicates_that_really_adds_detail_is_reclassified_to_extends_or_dropped() {
        let c = candidate(0, "duplicates", A, B);
        let applied = one(&c, |v| {
            v.decision = Decision::Reclassify;
            v.kind = "extends".into();
        })
        .unwrap();
        assert_eq!(applied.accepted[0].kind, "extends");
        rejected_because(one(&c, |v| v.decision = Decision::Reject), Rejection::Decided);
    }

    #[test]
    fn a_reclassification_still_has_to_pass_every_gate_with_its_own_direction() {
        let c = candidate(0, "related_to", A, B);
        rejected_because(one(&c, |v| {
            v.decision = Decision::Reclassify;
            v.kind = "depends_on".into();
            v.reverse_support = Support::Strong;
        }), Rejection::DirectionAmbiguous);
    }

    #[test]
    fn contradicts_derived_from_and_duplicates_need_the_same_explicit_high_confidence_support() {
        for kind in ["contradicts", "derived_from", "duplicates"] {
            let c = candidate(0, kind, A, B);
            assert_eq!(one(&c, |_| {}).unwrap().accepted.len(), 1, "{kind} accepted when sure");
            rejected_because(one(&c, |v| v.confidence = Confidence::Low), Rejection::NotHighConfidence);
            rejected_because(one(&c, |v| v.explicit_link = false), Rejection::NoExplicitLink);
        }
    }

    #[test]
    fn supersedes_is_not_inferred_from_recency_and_never_points_to_something_newer() {
        let mut newer_target = candidate(0, "supersedes", A, B);
        newer_target.source.created_at = "2026-10-04T10:00:00Z".into();
        newer_target.target.created_at = "2026-10-04T11:00:00Z".into();
        rejected_because(one(&newer_target, |_| {}), Rejection::SupersedesNotNewer);

        let mut newer_source = candidate(0, "supersedes", A, B);
        newer_source.source.created_at = "2026-10-04T11:00:00Z".into();
        assert_eq!(one(&newer_source, |_| {}).unwrap().accepted.len(), 1);
        // Newer alone is not enough: the verifier must still see an explicit replacement.
        rejected_because(one(&newer_source, |v| v.explicit_link = false), Rejection::NoExplicitLink);
        // Equal times (one distillation) do not block it.
        assert_eq!(one(&candidate(0, "supersedes", A, B), |_| {}).unwrap().accepted.len(), 1);
        // The gate looks at the verified orientation: reversing makes the older object the replacement.
        let reversed = one(&newer_source, |v| {
            v.source_object_id = B.into();
            v.target_object_id = A.into();
        });
        rejected_because(reversed, Rejection::SupersedesNotNewer);
    }

    // --- symmetric kinds -----------------------------------------------------------------------

    #[test]
    fn symmetric_kinds_are_judged_on_the_pair_then_canonicalized() {
        for kind in ["related_to", "contradicts", "duplicates"] {
            let c = candidate(0, kind, B, A); // stated "backwards" relative to id order
            let applied = one(&c, |v| v.reverse_support = Support::Strong).unwrap();
            assert_eq!((applied.accepted[0].source_object_id.as_str(), applied.accepted[0].target_object_id.as_str()), (A, B), "{kind}: smaller id first");
            assert_eq!(applied.rejections.len(), 0, "{kind}: reverse support is irrelevant for a symmetric kind");
        }
    }

    // --- malformed verifier output: the whole run fails ----------------------------------------

    #[test]
    fn hallucinated_ids_and_invalid_kinds_are_technical_failures() {
        let c = candidate(0, "depends_on", A, B);
        technical(one(&c, |v| v.source_object_id = D.into()));
        technical(one(&c, |v| v.target_object_id = C.into()));
        technical(one(&c, |v| v.target_object_id = v.source_object_id.clone()));
        technical(one(&c, |v| v.kind = "friends_with".into()));
        technical(one(&c, |v| v.kind = "".into()));
        technical(one(&c, |v| v.kind = "Extends".into()));
        // even a "reject" must still name real objects and a real kind
        technical(one(&c, |v| {
            v.decision = Decision::Reject;
            v.source_object_id = D.into();
        }));
    }

    #[test]
    fn a_verdict_whose_label_contradicts_its_kind_is_dropped_not_fatal() {
        let c = candidate(0, "depends_on", A, B);
        // "accept" but names a different kind; "reclassify" but names the same kind.
        rejected_because(one(&c, |v| v.kind = "extends".into()), Rejection::Inconsistent);
        rejected_because(one(&c, |v| v.decision = Decision::Reclassify), Rejection::Inconsistent);
        // It does not poison the rest of the batch.
        let cs = vec![c.clone(), candidate(1, "extends", C, D)];
        let verdicts = vec![Verdict { kind: "extends".into(), ..accept(&cs[0]) }, accept(&cs[1])];
        let applied = apply_verdicts(&cs, verdicts).unwrap();
        assert_eq!((applied.accepted.len(), applied.rejections), (1, vec![(0, Rejection::Inconsistent)]));
    }

    #[test]
    fn missing_duplicate_or_out_of_range_verdicts_are_technical_failures() {
        let cs = vec![candidate(0, "extends", A, B), candidate(1, "extends", C, D)];
        let ok0 = accept(&cs[0]);
        let ok1 = accept(&cs[1]);
        technical(apply_verdicts(&cs, vec![ok0.clone()]));
        technical(apply_verdicts(&cs, vec![]));
        technical(apply_verdicts(&cs, vec![ok0.clone(), ok0.clone()]));
        technical(apply_verdicts(&cs, vec![ok0.clone(), Verdict { index: 7, ..ok1.clone() }]));
        technical(apply_verdicts(&cs, vec![ok0.clone(), ok1.clone(), ok1.clone()]));
        assert_eq!(apply_verdicts(&cs, vec![ok1, ok0]).unwrap().accepted.len(), 2, "order of verdicts does not matter");
    }

    // --- batches -------------------------------------------------------------------------------

    #[test]
    fn rejected_candidates_do_not_block_accepted_ones() {
        let cs = vec![candidate(0, "related_to", A, B), candidate(1, "depends_on", C, D), candidate(2, "extends", A, C)];
        let verdicts = vec![
            Verdict { decision: Decision::Reject, ..accept(&cs[0]) },
            accept(&cs[1]),
            Verdict { confidence: Confidence::Medium, ..accept(&cs[2]) },
        ];
        let applied = apply_verdicts(&cs, verdicts).unwrap();
        assert_eq!(applied.accepted.len(), 1);
        assert_eq!(applied.accepted[0].kind, "depends_on");
        assert_eq!(applied.rejections, vec![(0, Rejection::Decided), (2, Rejection::NotHighConfidence)]);
    }

    #[test]
    fn unrelated_objects_yield_zero_relations() {
        let cs = vec![candidate(0, "related_to", A, B), candidate(1, "extends", C, D)];
        let verdicts = cs.iter().map(|c| Verdict { decision: Decision::Reject, ..accept(c) }).collect();
        let applied = apply_verdicts(&cs, verdicts).unwrap();
        assert_eq!(applied.accepted, vec![]);
        assert_eq!(applied.rejections.len(), 2);
    }

    #[test]
    fn two_candidates_that_end_up_as_the_same_verified_edge_are_kept_once() {
        // Stage A proposed both "A depends_on B" and "B depends_on A"; the verifier settles both on A->B.
        let cs = vec![candidate(0, "depends_on", A, B), candidate(1, "depends_on", B, A)];
        let verdicts = vec![
            accept(&cs[0]),
            Verdict { source_object_id: A.into(), target_object_id: B.into(), ..accept(&cs[1]) },
        ];
        let applied = apply_verdicts(&cs, verdicts).unwrap();
        assert_eq!(applied.accepted.len(), 1);
        assert_eq!((applied.merged, applied.reversed), (1, 0), "the duplicate is not counted as a correction");
    }

    // --- two independent votes ----------------------------------------------------------------

    fn vote(cs: &[VerifyCandidate], edit: impl Fn(&mut Verdict)) -> Vec<Verdict> {
        cs.iter().map(|c| { let mut v = accept(c); edit(&mut v); v }).collect()
    }

    #[test]
    fn an_edge_needs_both_votes_to_name_the_same_kind_and_direction() {
        let cs = vec![candidate(0, "depends_on", A, B)];
        let agree = apply_votes(&cs, vec![vote(&cs, |_| {}), vote(&cs, |_| {})]).unwrap();
        assert_eq!(agree.accepted.len(), 1);

        // The second, independently ordered vote disagrees about the direction: a correct edge is not
        // overturned by a single sample, and a wrong one is not confirmed by it either.
        let flipped = |v: &mut Verdict| {
            v.source_object_id = B.into();
            v.target_object_id = A.into();
        };
        let split = apply_votes(&cs, vec![vote(&cs, |_| {}), vote(&cs, flipped)]).unwrap();
        assert_eq!(split.accepted, vec![]);
        assert_eq!(split.rejections, vec![(0, Rejection::VotesDisagree)]);
        // Both votes flipping agrees with each other: the corrected direction stands, and is counted as a reversal.
        let both = apply_votes(&cs, vec![vote(&cs, flipped), vote(&cs, flipped)]).unwrap();
        assert_eq!((both.accepted[0].source_object_id.as_str(), both.reversed), (B, 1));
    }

    #[test]
    fn a_vote_that_keeps_and_a_vote_that_rejects_is_a_disagreement() {
        let cs = vec![candidate(0, "extends", A, B)];
        for edit in [|v: &mut Verdict| v.decision = Decision::Reject, |v: &mut Verdict| v.confidence = Confidence::Medium] {
            let result = apply_votes(&cs, vec![vote(&cs, |_| {}), vote(&cs, edit)]).unwrap();
            assert_eq!((result.accepted.len(), result.rejections), (0, vec![(0, Rejection::VotesDisagree)]));
            let reversed_order = apply_votes(&cs, vec![vote(&cs, edit), vote(&cs, |_| {})]).unwrap();
            assert_eq!(reversed_order.accepted.len(), 0);
        }
        // Two votes that both decline keep the specific reason.
        let both = apply_votes(&cs, vec![vote(&cs, |v| v.confidence = Confidence::Low), vote(&cs, |v| v.confidence = Confidence::Low)]).unwrap();
        assert_eq!(both.rejections, vec![(0, Rejection::NotHighConfidence)]);
    }

    #[test]
    fn votes_that_agree_on_a_different_kind_count_as_a_reclassification_and_symmetric_votes_ignore_order() {
        let cs = vec![candidate(0, "related_to", A, B), candidate(1, "duplicates", C, D)];
        let reclassify = |cs: &[VerifyCandidate]| -> Vec<Verdict> {
            vec![Verdict { decision: Decision::Reclassify, kind: "extends".into(), ..accept(&cs[0]) }, accept(&cs[1])]
        };
        let swapped_symmetric = |cs: &[VerifyCandidate]| -> Vec<Verdict> {
            let mut v = reclassify(cs);
            v[1].source_object_id = D.into();
            v[1].target_object_id = C.into();
            v
        };
        let applied = apply_votes(&cs, vec![reclassify(&cs), swapped_symmetric(&cs)]).unwrap();
        assert_eq!((applied.accepted.len(), applied.reclassified, applied.reversed), (2, 1, 0));
    }

    #[test]
    fn malformed_output_in_either_vote_fails_the_whole_run() {
        let cs = vec![candidate(0, "extends", A, B)];
        technical(apply_votes(&cs, vec![vote(&cs, |_| {}), vote(&cs, |v| v.source_object_id = D.into())]));
        technical(apply_votes(&cs, vec![vec![], vote(&cs, |_| {})]));
        technical(apply_votes(&cs, vec![]));
    }

    // --- orientation from two independent ratings ---------------------------------------------

    #[test]
    fn direction_comes_from_the_two_ratings_never_from_a_pick() {
        use Support::{None, Strong, Weak};
        // Directional: exactly one strongly supported orientation wins.
        assert_eq!(orient("depends_on", Strong, None), (true, Strong, None));
        assert_eq!(orient("depends_on", None, Strong), (false, Strong, None));
        assert_eq!(orient("depends_on", Weak, Strong), (false, Strong, Weak));
        assert_eq!(orient("extends", Strong, Weak), (true, Strong, Weak));
        // Both strong: ambiguous. Neither strong: no direction. Both are left for the gates to reject.
        assert_eq!(orient("supersedes", Strong, Strong), (true, Strong, Strong));
        assert_eq!(orient("derived_from", Weak, None), (true, Weak, None));
        assert_eq!(orient("depends_on", None, None), (true, None, None));
        // Symmetric: order is irrelevant, one strong claim is enough.
        for kind in ["related_to", "contradicts", "duplicates"] {
            assert_eq!(orient(kind, Strong, Strong).1, Strong);
            assert_eq!(orient(kind, None, Strong).1, Strong);
            assert_eq!(orient(kind, Weak, None).1, Weak);
            assert_eq!(orient(kind, None, None).1, None);
        }
    }

    #[test]
    fn the_derived_orientation_feeds_the_same_gates() {
        let (_, forward, reverse) = orient("depends_on", Support::Strong, Support::Strong);
        let c = candidate(0, "depends_on", A, B);
        rejected_because(one(&c, |v| { v.forward_support = forward; v.reverse_support = reverse; }), Rejection::DirectionAmbiguous);
        let (_, forward, reverse) = orient("depends_on", Support::None, Support::None);
        rejected_because(one(&c, |v| { v.forward_support = forward; v.reverse_support = reverse; }), Rejection::DirectionUnsupported);
    }

    // ----- M04.7A.3: the temporal "moot" veto -----

    fn moot_pair(kind: &str) -> VerifyCandidate {
        let mut c = candidate(0, kind, A, B);
        c.source.title = "Discontinue the product line".into();
        c.source.body = "The product line is cancelled and will not be produced.".into();
        c.target.title = "Order packaging".into();
        c.target.body = "Order packaging for the product line.".into();
        c
    }

    fn moot(c: &VerifyCandidate, evidence: Option<&str>) -> Verdict {
        Verdict { cancels_or_obsoletes: true, temporal_evidence: evidence.map(String::from), ..accept(c) }
    }

    #[test]
    fn a_grounded_moot_verdict_vetoes_contradicts_in_either_pass() {
        let c = moot_pair("contradicts");
        let grounded = Some("The product line is cancelled, so ordering packaging for it is unnecessary.");
        let plain = vec![accept(&c)];
        // One pass vetoes, the other accepts: not a survivor either way round.
        for votes in [vec![vec![moot(&c, grounded)], plain.clone()], vec![plain.clone(), vec![moot(&c, grounded)]]] {
            let applied = apply_votes(std::slice::from_ref(&c), votes).unwrap();
            assert!(applied.accepted.is_empty());
            assert_eq!(applied.rejections.len(), 1);
        }
        let single = apply_verdicts(std::slice::from_ref(&c), vec![moot(&c, grounded)]).unwrap();
        assert_eq!(single.rejections, vec![(0, Rejection::Obsoleted)]);
    }

    #[test]
    fn an_ungrounded_or_empty_moot_claim_is_ignored_and_never_acts_as_proof_of_anything() {
        let c = moot_pair("contradicts");
        for evidence in [None, Some(""), Some("   "), Some("zzzz qqqq unrelated words entirely"), Some(&"x".repeat(400)[..])] {
            let applied = apply_verdicts(std::slice::from_ref(&c), vec![moot(&c, evidence)]).unwrap();
            assert_eq!(applied.accepted.len(), 1, "{evidence:?}: only a grounded statement vetoes");
        }
    }

    #[test]
    fn the_moot_veto_applies_only_to_contradicts_and_never_converts_or_adds_a_relation() {
        for kind in ["depends_on", "extends", "supersedes", "duplicates", "related_to", "derived_from"] {
            let c = moot_pair(kind);
            let applied = apply_verdicts(std::slice::from_ref(&c), vec![moot(&c, Some("The product line is cancelled."))]).unwrap();
            assert_eq!(applied.accepted.len(), 1, "{kind} is untouched by the veto");
        }
        // A vetoed contradiction is a rejection: nothing is accepted in its place, not even a `supersedes`.
        let c = moot_pair("contradicts");
        let applied = apply_verdicts(std::slice::from_ref(&c), vec![moot(&c, Some("The product line is cancelled."))]).unwrap();
        assert!(applied.accepted.is_empty() && applied.reclassified == 0);
    }

    #[test]
    fn a_genuine_contradiction_without_a_moot_flag_still_passes_every_gate() {
        let c = moot_pair("contradicts");
        assert_eq!(apply_votes(std::slice::from_ref(&c), vec![vec![accept(&c)], vec![accept(&c)]]).unwrap().accepted.len(), 1);
    }

    #[test]
    fn grounding_uses_the_two_objects_own_words() {
        let c = moot_pair("contradicts");
        assert!(moot_is_grounded(&Some("the product line is cancelled".into()), &c.source, &c.target));
        assert!(!moot_is_grounded(&Some("because of the weather".into()), &c.source, &c.target));
        assert!(!moot_is_grounded(&None, &c.source, &c.target));
    }
}
