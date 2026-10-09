//! Deterministic checks on a proposed revision. They run BEFORE any verifier is asked and they only ever reject.
//!
//! What they establish: the draft is well formed, cites only sources the server issued, classifies its change as the resolver
//! authorized, keeps the object's kind, actually changes the text, introduces no number or capitalised name that is not in the
//! inputs, keeps most of what was there, represents the new claim, does not balloon, and does not drop or add negations. What they do
//! NOT establish: that the sentence is TRUE or faithful in meaning. That is the independent verifier's job, and even a PASS from it
//! only allows an already eligible proposal to proceed.
//!
//! The thresholds are conservative HEURISTICS (they trade recall for safety: a false veto only sends the claim to a person), not
//! calibrated constants.

use std::collections::BTreeSet;

use super::{ChangeClass, SynthesisDraft, SynthesisRequest, BASE_SOURCE, NEW_SOURCE};
use crate::recall::query::{interpret, tokens};

pub const MAX_BODY_CHARS: usize = 2_000;
pub const MAX_ASSERTIONS: usize = 12;
pub const MAX_ASSERTION_CHARS: usize = 400;
pub const MAX_SOURCES: usize = 8;
/// The text may grow by at most the new claim's length plus this much.
const GROWTH_SLACK_CHARS: usize = 160;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DraftVeto {
    Malformed,
    Empty,
    Oversized,
    ModelMismatch,
    KindChanged,
    ChangeMismatch,
    ContradictoryMetadata,
    NoAddedAssertion,
    UnknownSource,
    BadSourceUse,
    NoChange,
    UnsupportedNumber,
    UnsupportedEntity,
    OmitsExistingFact,
    ClaimNotRepresented,
    ScopeGrowth,
    NegationChanged,
}

impl DraftVeto {
    /// The name recorded in the identity audit (an allow-listed veto name in `storage::identity_store::VETO_NAMES`).
    pub fn storage_name(self) -> &'static str {
        match self {
            DraftVeto::UnknownSource | DraftVeto::BadSourceUse => "draft_bad_reference",
            DraftVeto::UnsupportedNumber | DraftVeto::UnsupportedEntity => "draft_unsupported_fact",
            DraftVeto::OmitsExistingFact | DraftVeto::ClaimNotRepresented => "draft_omits_fact",
            DraftVeto::ScopeGrowth | DraftVeto::NegationChanged => "draft_scope_change",
            _ => "invalid_draft",
        }
    }
}

/// A draft that passed every deterministic check, with the one thing the server derived from it: which stored evidence row (if any,
/// and only if exactly one is provable) a correction or replacement withdraws.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedDraft {
    pub body: String,
    pub change: ChangeClass,
    pub retracts: Option<(String, i64)>,
}

fn chars(text: &str) -> usize {
    text.chars().count()
}

fn digit_runs(text: &str) -> BTreeSet<String> {
    let mut runs = BTreeSet::new();
    let mut current = String::new();
    for c in text.chars() {
        if c.is_ascii_digit() {
            current.push(c);
        } else if !current.is_empty() {
            runs.insert(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        runs.insert(current);
    }
    runs
}

/// Capitalised words that do not start a sentence: names, products, acronyms the text introduces.
fn inner_capitalised_words(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut sentence_start = true;
    let mut word = String::new();
    let flush = |word: &mut String, sentence_start: bool, found: &mut Vec<String>| {
        if let Some(first) = word.chars().next() {
            if !sentence_start && first.is_uppercase() && word.chars().count() >= 2 {
                found.push(word.to_lowercase());
            }
        }
        word.clear();
    };
    for c in text.chars() {
        if c.is_alphanumeric() {
            word.push(c);
        } else {
            let had_word = !word.is_empty();
            flush(&mut word, sentence_start, &mut found);
            if had_word {
                sentence_start = false;
            }
            if matches!(c, '.' | '!' | '?' | '\n') {
                sentence_start = true;
            }
        }
    }
    flush(&mut word, sentence_start, &mut found);
    found
}

const NEGATIONS: [&str; 10] = ["not", "no", "never", "cannot", "without", "neither", "не", "няма", "никога", "без"];

fn negations(text: &str) -> usize {
    let lower = text.to_lowercase();
    let apostrophe = lower.matches("n't").count() + lower.matches("n’t").count();
    apostrophe + tokens(&lower).iter().filter(|t| NEGATIONS.contains(&t.as_str())).count()
}

/// Share of `text`'s content terms that appear in `in_text` (stem-prefix matching, Bulgarian and English). `None` when `text` has no
/// content terms to compare.
fn term_share(text: &str, in_text: &str) -> Option<f64> {
    let query = interpret(text).ok()?;
    if query.terms.is_empty() {
        return None;
    }
    let words = tokens(in_text);
    let hit = query.terms.iter().filter(|term| words.iter().any(|w| term.matches_token(w))).count();
    Some(hit as f64 / query.terms.len() as f64)
}

/// `false` only when the note has terms the current text lacks and NONE of them reached the result.
fn brings_something_in(claim: &str, base: &str, revised: &str) -> bool {
    let Ok(query) = interpret(claim) else { return true };
    let base_words = tokens(base);
    let new_terms: Vec<_> = query.terms.iter().filter(|term| !base_words.iter().any(|w| term.matches_token(w))).collect();
    if new_terms.is_empty() {
        return true;
    }
    let revised_words = tokens(revised);
    new_terms.iter().any(|term| revised_words.iter().any(|w| term.matches_token(w)))
}

pub fn validate_draft(request: &SynthesisRequest, draft: &SynthesisDraft, expected_model_prefix: &str) -> Result<ValidatedDraft, DraftVeto> {
    if !draft.model.starts_with(expected_model_prefix) {
        return Err(DraftVeto::ModelMismatch);
    }
    let body = draft.revised_body.trim();
    if body.is_empty() {
        return Err(DraftVeto::Empty);
    }
    if chars(body) > MAX_BODY_CHARS {
        return Err(DraftVeto::Oversized);
    }
    if body.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return Err(DraftVeto::Malformed);
    }
    if draft.kind != request.kind {
        return Err(DraftVeto::KindChanged);
    }
    if draft.change != request.change {
        return Err(DraftVeto::ChangeMismatch);
    }

    // references: only server-issued sources, used in the roles they can play
    let known: BTreeSet<&str> = request.sources.iter().map(|s| s.id.as_str()).chain([BASE_SOURCE, NEW_SOURCE]).collect();
    if request.sources.len() > MAX_SOURCES {
        return Err(DraftVeto::Malformed);
    }
    for list in [&draft.retained, &draft.added, &draft.withdrawn] {
        if list.len() > MAX_ASSERTIONS {
            return Err(DraftVeto::Oversized);
        }
        for assertion in list.iter() {
            if assertion.text.trim().is_empty() || chars(&assertion.text) > MAX_ASSERTION_CHARS {
                return Err(DraftVeto::Malformed);
            }
            if !known.contains(assertion.source.as_str()) {
                return Err(DraftVeto::UnknownSource);
            }
        }
    }
    if draft.added.is_empty() {
        return Err(DraftVeto::NoAddedAssertion);
    }
    if draft.added.iter().any(|a| a.source != NEW_SOURCE) || draft.retained.iter().chain(draft.withdrawn.iter()).any(|a| a.source == NEW_SOURCE) {
        return Err(DraftVeto::BadSourceUse);
    }
    match request.change {
        ChangeClass::Additive if !draft.withdrawn.is_empty() => return Err(DraftVeto::ContradictoryMetadata),
        ChangeClass::Correction | ChangeClass::Replacement if draft.withdrawn.is_empty() => return Err(DraftVeto::ContradictoryMetadata),
        _ => {}
    }

    // it must really change the text
    let normal = |text: &str| tokens(text).join(" ");
    if normal(body) == normal(&request.base_body) {
        return Err(DraftVeto::NoChange);
    }

    // nothing new that the inputs do not contain
    let mut allowed_text = format!("{} {} {} {} {}", request.title, request.base_body, request.claim_title, request.claim_body, request.claim_quote);
    for source in &request.sources {
        allowed_text.push(' ');
        allowed_text.push_str(&source.quote);
    }
    let known_numbers = digit_runs(&allowed_text);
    if digit_runs(body).iter().any(|n| !known_numbers.contains(n)) {
        return Err(DraftVeto::UnsupportedNumber);
    }
    let known_words: BTreeSet<String> = tokens(&allowed_text).into_iter().collect();
    if inner_capitalised_words(body).iter().any(|w| !known_words.contains(w.as_str())) {
        return Err(DraftVeto::UnsupportedEntity);
    }

    // keeps what was there (more strictly when the change only adds), and represents the new claim
    let keep = match request.change {
        ChangeClass::Additive => 0.7,
        ChangeClass::Correction => 0.5,
        ChangeClass::Replacement => 0.4,
    };
    if term_share(&request.base_body, body).is_some_and(|share| share < keep) {
        return Err(DraftVeto::OmitsExistingFact);
    }
    // the new note must show up: at least one of the terms it brings (those the current text does not already have) appears in the result.
    // A paraphrase ("will also support desktop" -> "and desktop") passes; a rewrite that ignores the note does not.
    if !brings_something_in(&format!("{} {}", request.claim_title, request.claim_body), &request.base_body, body) {
        return Err(DraftVeto::ClaimNotRepresented);
    }
    if chars(body) > chars(&request.base_body) + chars(&request.claim_body) + GROWTH_SLACK_CHARS {
        return Err(DraftVeto::ScopeGrowth);
    }
    let (base_neg, claim_neg, new_neg) = (negations(&request.base_body), negations(&request.claim_body), negations(body));
    let lower_bound = if request.change == ChangeClass::Additive { base_neg } else { 0 };
    // an additive note that says "not" must still say it in the result: dropping it would turn the note into its opposite
    let claim_negation_lost = request.change == ChangeClass::Additive && claim_neg > 0 && new_neg <= base_neg;
    if new_neg < lower_bound || new_neg > base_neg + claim_neg || claim_negation_lost {
        return Err(DraftVeto::NegationChanged);
    }

    // a withdrawn assertion is traced to a stored evidence row only when exactly one such row is provable
    let retracts = if request.change == ChangeClass::Additive {
        None
    } else {
        let keys: BTreeSet<Option<(String, i64)>> = draft.withdrawn.iter().map(|a| request.sources.iter().find(|s| s.id == a.source).and_then(|s| s.key.clone())).collect();
        match keys.into_iter().collect::<Vec<_>>().as_slice() {
            [Some(key)] => Some(key.clone()),
            _ => None,
        }
    };
    Ok(ValidatedDraft { body: body.to_string(), change: request.change, retracts })
}
