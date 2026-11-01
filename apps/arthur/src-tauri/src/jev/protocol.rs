//! Building the JEV request and validating its answer. Pure functions: no I/O, no clock, no credentials.
//!
//! WHAT IS SENT (the minimum): the claim's title and text, the exact words it came from, and at most four candidate ideas (title and
//! text), under opaque ids `a`..`d`. No capture beyond that quote, no Arthur object or revision ids, no project name or id, no other
//! project's ideas (they are refused outright), no timestamps, no credentials. Everything the person wrote travels inside `state` as
//! DATA; the instructions are fixed text that only names the opaque ids.
//!
//! ORDER: the same claim is asked three times (runs 0..2) with the ideas listed in a different order and the choice options permuted
//! (identity, reverse, rotation). Answers are keyed by opaque id, never by position, so the mapping back to candidates is stable.
//! Repetition reduces positional noise only; it is the same model and NOT independent verification.
//!
//! ANSWERS ARE UNTRUSTED: the model id must equal the pinned one, the answer keys must be exactly the questions asked, every number
//! finite and in range, probabilities must cover exactly the offered options and sum to about 1, and the chosen option must be the
//! most probable one. Anything else is a typed `Malformed`, never repaired.

use std::collections::BTreeMap;

use serde::ser::{Serialize, SerializeMap, Serializer};
use serde_json::{json, Value};

use super::{JevError, JEV_MODEL};
use crate::identity::{Candidate, CandidateSignal, Claim, Relation, MAX_CANDIDATES};

pub const MAX_STATE_CHARS: usize = 12_000;
const LETTERS: [&str; MAX_CANDIDATES] = ["a", "b", "c", "d"];
/// Probabilities may be rounded by the provider (two decimals were observed): the sum must be 1 within this.
const SUM_TOLERANCE: f64 = 0.06;
/// The chosen option may trail the top probability by at most this (ties and rounding).
const ARGMAX_TOLERANCE: f64 = 0.011;

/// EXPERIMENTAL, UNCALIBRATED mapping from JEV probabilities to the resolver's signals. Every riskier reading is chosen at a LOW
/// cut-off (any real chance of a riskier relation routes to the stricter gate); the referent and supersession flags need a HIGH one.
#[derive(Debug, Clone, PartialEq)]
pub struct Mapping {
    pub risky_relation: f64,
    pub referent_resolved: f64,
    pub explicit_supersession: f64,
}

impl Default for Mapping {
    fn default() -> Self {
        Self {
            risky_relation: 0.3,
            referent_resolved: 0.7,
            explicit_supersession: 0.7,
        }
    }
}

/// A JSON object whose keys keep the order they were inserted in (serde_json's own map sorts them, which would erase the shuffle).
struct Ordered(Vec<(String, Value)>);

impl Serialize for Ordered {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

/// Serialises a question map with keys in insertion order, criteria in the permuted order.
struct Request {
    state: Value,
    questions: Vec<(String, Question)>,
}

enum Question {
    Noul {
        instructions: String,
        criteria_true: String,
        criteria_false: String,
    },
    Choice {
        instructions: String,
        criteria: Vec<(String, String)>,
    },
}

impl Serialize for Question {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(3))?;
        match self {
            Question::Noul {
                instructions,
                criteria_true,
                criteria_false,
            } => {
                map.serialize_entry("type", "noul")?;
                map.serialize_entry("instructions", instructions)?;
                map.serialize_entry(
                    "criteria",
                    &json!({ "true": criteria_true, "false": criteria_false }),
                )?;
            }
            Question::Choice {
                instructions,
                criteria,
            } => {
                map.serialize_entry("type", "choice")?;
                map.serialize_entry("instructions", instructions)?;
                map.serialize_entry(
                    "criteria",
                    &Ordered(
                        criteria
                            .iter()
                            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                            .collect(),
                    ),
                )?;
            }
        }
        map.end()
    }
}

impl Serialize for Request {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(3))?;
        map.serialize_entry("state", &self.state)?;
        map.serialize_entry("model", JEV_MODEL)?;
        struct Questions<'a>(&'a [(String, Question)]);
        impl Serialize for Questions<'_> {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let mut map = serializer.serialize_map(Some(self.0.len()))?;
                for (key, question) in self.0 {
                    map.serialize_entry(key, question)?;
                }
                map.end()
            }
        }
        map.serialize_entry("questions", &Questions(&self.questions))?;
        map.end()
    }
}

/// A permutation of `0..n` for a run: identity, reverse, then rotations. Deterministic, so a run is reproducible and testable.
pub fn permutation(n: usize, run: usize) -> Vec<usize> {
    let mut order: Vec<usize> = (0..n).collect();
    match run {
        0 => {}
        1 => order.reverse(),
        r => order.rotate_left(r % n.max(1)),
    }
    order
}

/// What is needed to read one run's answer back.
#[derive(Debug, Clone)]
pub struct RunPlan {
    pub body: String,
    candidates: usize,
    relation_options: Vec<String>,
}

fn chars(text: &str) -> usize {
    text.chars().count()
}

pub fn build_run(claim: &Claim, candidates: &[Candidate], run: usize) -> Result<RunPlan, JevError> {
    let n = candidates.len();
    if n == 0 {
        return Err(JevError::Malformed("no candidates"));
    }
    if n > MAX_CANDIDATES {
        return Err(JevError::TooManyCandidates);
    }
    if candidates.iter().any(|c| c.project.id != claim.project.id) {
        return Err(JevError::CrossProject);
    }
    let total = chars(&claim.title)
        + chars(&claim.body)
        + chars(&claim.evidence_text)
        + candidates
            .iter()
            .map(|c| chars(&c.revision.title) + chars(&c.revision.body))
            .sum::<usize>();
    if total > MAX_STATE_CHARS {
        return Err(JevError::InputTooLarge);
    }

    let ideas: Vec<Value> = permutation(n, run).into_iter().map(|i| json!({ "id": LETTERS[i], "title": candidates[i].revision.title, "text": candidates[i].revision.body })).collect();
    let state = json!({ "existing_ideas": ideas, "new_capture": { "title": claim.title, "text": claim.body, "exact_words": claim.evidence_text } });

    // relation options: revise_a.., new, uncertain, in this run's order
    let mut options: Vec<String> = (0..n).map(|i| format!("revise_{}", LETTERS[i])).collect();
    options.push("new".into());
    options.push("uncertain".into());
    let option_order = permutation(options.len(), run);
    let criteria: Vec<(String, String)> = option_order
        .iter()
        .map(|&k| {
            let name = &options[k];
            let text = match name.as_str() {
                "new" => "`new_capture` is a different idea from every idea in `existing_ideas`, even if it shares the topic, project, product, screen or wording.".to_string(),
                "uncertain" => "From the text alone it cannot be determined whether `new_capture` updates an existing idea, or which of several existing ideas it refers to.".to_string(),
                revise => format!("`new_capture` continues, corrects, extends or replaces the idea with id \"{}\" specifically, and no other idea in `existing_ideas` is an equally plausible target.", &revise["revise_".len()..]),
            };
            (name.clone(), text)
        })
        .collect();

    let mut questions: Vec<(String, Question)> = vec![
        ("relation".into(), Question::Choice { instructions: "How does `new_capture` relate to `existing_ideas`?".into(), criteria }),
        (
            "referent".into(),
            Question::Noul {
                instructions: "Does `new_capture` say by itself what it is about, without relying on a pronoun or a missing subject (such as \"it\", \"that\", \"this\") to be understood?".into(),
                criteria_true: "It names or clearly describes what it is about.".into(),
                criteria_false: "What it is about is unclear without more context, or it only says \"it\" or \"that\".".into(),
            },
        ),
        (
            "supersedes".into(),
            Question::Noul {
                instructions: "Does `new_capture` explicitly say that it replaces, drops or switches away from an earlier choice or decision?".into(),
                criteria_true: "It states that something earlier is replaced, dropped or switched from.".into(),
                criteria_false: "It does not state that an earlier choice is replaced.".into(),
            },
        ),
    ];
    for &id in &LETTERS[..n] {
        questions.push((
            format!("redef_{id}"),
            Question::Noul {
                instructions: format!("Does `new_capture` substantially redefine the identity, purpose or scope of the idea with id \"{id}\"?"),
                criteria_true: "It changes what the idea fundamentally is, what it is for, who it is for, or how broadly it applies; or it inverts the role of the idea.".into(),
                criteria_false: "It only continues, corrects or replaces a detail, value, date, name, vendor or implementation choice of the idea, or it is about a different idea.".into(),
            },
        ));
        let kinds = [
            ("detail_update", "`new_capture` continues, corrects or replaces a detail of the idea; the idea stays what it was."),
            ("reframing", "`new_capture` changes what the idea fundamentally is, what it is for, who it is for, or how broadly it applies; or inverts its role."),
            ("other", "`new_capture` is about a different idea, or its relation to the idea is unclear."),
        ];
        questions.push((
            format!("kind_{id}"),
            Question::Choice {
                instructions: format!(
                    "What kind of change does `new_capture` make to the idea with id \"{id}\"?"
                ),
                criteria: permutation(kinds.len(), run)
                    .into_iter()
                    .map(|k| (kinds[k].0.to_string(), kinds[k].1.to_string()))
                    .collect(),
            },
        ));
        let changes = [
            ("additive", "`new_capture` adds detail to the idea; what the idea said earlier stays true."),
            ("correction", "`new_capture` corrects a wrong value, date, name or number of the idea."),
            ("replacement", "`new_capture` replaces an option that had been chosen or decided for the idea with another."),
            ("subtask", "`new_capture` is a step or sub-task toward the idea, not a change of the idea itself."),
            ("other", "`new_capture` is about a different idea, or the relation is unclear."),
        ];
        questions.push((
            format!("change_{id}"),
            Question::Choice {
                instructions: format!(
                    "Which best describes how `new_capture` changes the idea with id \"{id}\"?"
                ),
                criteria: permutation(changes.len(), run)
                    .into_iter()
                    .map(|k| (changes[k].0.to_string(), changes[k].1.to_string()))
                    .collect(),
            },
        ));
    }
    let body = serde_json::to_string(&Request { state, questions })
        .map_err(|_| JevError::Malformed("request"))?;
    Ok(RunPlan {
        body,
        candidates: n,
        relation_options: options,
    })
}

/// Token usage when the provider reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

pub struct ParsedRun {
    pub signals: Vec<CandidateSignal>,
    pub usage: Option<Usage>,
}

fn unit(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|x| x.is_finite() && (0.0..=1.0).contains(x))
}

fn noul(answers: &serde_json::Map<String, Value>, key: &str) -> Result<f64, JevError> {
    let answer = answers
        .get(key)
        .and_then(Value::as_object)
        .ok_or(JevError::Malformed("missing answer"))?;
    if answer.get("type").and_then(Value::as_str) != Some("noul") {
        return Err(JevError::Malformed("wrong answer type"));
    }
    answer
        .get("noul")
        .and_then(unit)
        .ok_or(JevError::Malformed("bad probability"))
}

fn choice(
    answers: &serde_json::Map<String, Value>,
    key: &str,
    options: &[&str],
) -> Result<BTreeMap<String, f64>, JevError> {
    let answer = answers
        .get(key)
        .and_then(Value::as_object)
        .ok_or(JevError::Malformed("missing answer"))?;
    if answer.get("type").and_then(Value::as_str) != Some("choice") {
        return Err(JevError::Malformed("wrong answer type"));
    }
    let chosen = answer
        .get("choice")
        .and_then(Value::as_str)
        .ok_or(JevError::Malformed("missing choice"))?;
    answer
        .get("confidence")
        .and_then(unit)
        .ok_or(JevError::Malformed("bad confidence"))?;
    let raw = answer
        .get("probabilities")
        .and_then(Value::as_object)
        .ok_or(JevError::Malformed("missing probabilities"))?;
    if raw.len() != options.len() || !options.iter().all(|option| raw.contains_key(*option)) {
        return Err(JevError::Malformed(
            "probabilities do not match the options",
        ));
    }
    let mut probabilities = BTreeMap::new();
    for option in options {
        probabilities.insert(
            (*option).to_string(),
            raw.get(*option)
                .and_then(unit)
                .ok_or(JevError::Malformed("bad probability"))?,
        );
    }
    if (probabilities.values().sum::<f64>() - 1.0).abs() > SUM_TOLERANCE {
        return Err(JevError::Malformed("probabilities do not sum to one"));
    }
    let top = probabilities.values().cloned().fold(0.0, f64::max);
    match probabilities.get(chosen) {
        None => Err(JevError::Malformed("unknown choice")),
        Some(p) if top - p > ARGMAX_TOLERANCE => {
            Err(JevError::Malformed("choice contradicts probabilities"))
        }
        Some(_) => Ok(probabilities),
    }
}

fn relation_of(
    kind: &BTreeMap<String, f64>,
    change: &BTreeMap<String, f64>,
    mapping: &Mapping,
) -> Relation {
    let risky = mapping.risky_relation;
    if kind["reframing"] >= risky {
        Relation::Reframing
    } else if change["subtask"] >= risky {
        Relation::Subtask
    } else if change["replacement"] >= risky {
        Relation::DecisionReplacement
    } else if change["other"] >= change["additive"].max(change["correction"]) {
        Relation::DistinctSameProject
    } else if change["correction"] > change["additive"] {
        Relation::Correction
    } else {
        Relation::AdditiveRefinement
    }
}

/// Validates one answer and turns it into one `CandidateSignal` per candidate (in candidate order, ids = `candidate_ids`).
pub fn parse_run(
    plan: &RunPlan,
    candidate_ids: &[String],
    text: &str,
    mapping: &Mapping,
) -> Result<ParsedRun, JevError> {
    let value: Value = serde_json::from_str(text).map_err(|_| JevError::Malformed("not json"))?;
    let root = value
        .as_object()
        .ok_or(JevError::Malformed("not an object"))?;
    if root.get("model").and_then(Value::as_str) != Some(JEV_MODEL) {
        return Err(JevError::UnexpectedModel);
    }
    let answers = root
        .get("answers")
        .and_then(Value::as_object)
        .ok_or(JevError::Malformed("no answers"))?;
    let n = plan.candidates;
    let mut expected: Vec<String> = vec!["relation".into(), "referent".into(), "supersedes".into()];
    for letter in LETTERS.iter().take(n) {
        expected.extend([
            format!("redef_{letter}"),
            format!("kind_{letter}"),
            format!("change_{letter}"),
        ]);
    }
    if answers.len() != expected.len() || !expected.iter().all(|key| answers.contains_key(key)) {
        return Err(JevError::Malformed("answers do not match the questions"));
    }

    let relation_options: Vec<&str> = plan.relation_options.iter().map(String::as_str).collect();
    let relation = choice(answers, "relation", &relation_options)?;
    let referent = noul(answers, "referent")?;
    let supersedes = noul(answers, "supersedes")?;
    let mut signals = Vec::with_capacity(n);
    for (i, letter) in LETTERS.iter().take(n).enumerate() {
        let redef = noul(answers, &format!("redef_{letter}"))?;
        let kind = choice(
            answers,
            &format!("kind_{letter}"),
            &["detail_update", "reframing", "other"],
        )?;
        let change = choice(
            answers,
            &format!("change_{letter}"),
            &["additive", "correction", "replacement", "subtask", "other"],
        )?;
        signals.push(CandidateSignal {
            candidate_id: candidate_ids[i].clone(),
            same_proposition: relation[&format!("revise_{letter}")],
            reframing: redef.max(kind["reframing"]),
            relation: Some(relation_of(&kind, &change, mapping)),
            referent_resolved: Some(referent >= mapping.referent_resolved),
            explicit_supersession: Some(supersedes >= mapping.explicit_supersession),
        });
    }
    let usage = root.get("usage").and_then(Value::as_object).and_then(|u| {
        Some(Usage {
            input_tokens: u.get("input_tokens")?.as_u64()?,
            output_tokens: u.get("output_tokens").and_then(Value::as_u64).unwrap_or(0),
        })
    });
    Ok(ParsedRun { signals, usage })
}
