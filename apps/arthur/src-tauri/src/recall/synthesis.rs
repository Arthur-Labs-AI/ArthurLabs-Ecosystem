//! Grounded synthesis: the answer-model abstraction, strict parsing, and deterministic post-generation validation.
//!
//! The model is an UNTRUSTED producer. Nothing it returns reaches the caller until it has been parsed against a strict schema and every
//! citation has been checked against the evidence that was actually supplied. The temporal label of a paragraph is computed from what it
//! cites, never taken from the model.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::package::EvidencePackage;
use crate::async_util::BoxFuture;

pub const MAX_PARAGRAPHS: usize = 6;
pub const MAX_PARAGRAPH_CHARS: usize = 900;
pub const MAX_GAPS: usize = 4;
pub const MAX_GAP_CHARS: usize = 200;

pub struct SynthesisRequest {
    pub system: String,
    pub user: String,
    pub schema: Value,
}

/// Why a synthesis request failed. Never carries provider bodies, keys or evidence text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SynthesisFailure {
    NotConfigured,
    Network,
    Auth(u16),
    Provider(u16),
    Refused,
    Unreadable(String),
}

impl SynthesisFailure {
    pub fn code(&self) -> &'static str {
        match self {
            SynthesisFailure::NotConfigured => "llmNotConfigured",
            SynthesisFailure::Network
            | SynthesisFailure::Auth(_)
            | SynthesisFailure::Provider(_) => "llmFailed",
            SynthesisFailure::Refused => "llmRefused",
            SynthesisFailure::Unreadable(_) => "llmInvalidOutput",
        }
    }
}

/// The answer model. One strict-JSON completion; no tools, no callbacks, no way to read the store.
pub trait AnswerModel: Send + Sync {
    fn model_name(&self) -> String;
    fn complete<'a>(
        &'a self,
        request: &'a SynthesisRequest,
    ) -> BoxFuture<'a, Result<String, SynthesisFailure>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelOutcome {
    Answered,
    InsufficientEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawParagraph {
    text: String,
    based_on: Vec<String>,
    temporal: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawAnswer {
    outcome: String,
    paragraphs: Vec<RawParagraph>,
    gaps: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paragraph {
    pub text: String,
    pub based_on: Vec<String>,
    /// COMPUTED from the citations: `current`, `historical`, `mixed` or `external`.
    pub temporal: &'static str,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ValidationReport {
    pub stripped_refs: usize,
    pub dropped_paragraphs: usize,
    pub temporal_corrected: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Validated {
    pub outcome: ModelOutcome,
    pub paragraphs: Vec<Paragraph>,
    pub gaps: Vec<String>,
    pub report: ValidationReport,
}

/// Structural problems (worth ONE repair attempt). A well-formed answer with weak grounding is not a structural problem: it is downgraded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StructuralProblem(pub String);

pub fn looks_like_uuid(text: &str) -> bool {
    let bytes: Vec<char> = text.chars().collect();
    let pattern = [8usize, 4, 4, 4, 12];
    for start in 0..bytes.len() {
        let mut at = start;
        let mut ok = true;
        for (n, len) in pattern.iter().enumerate() {
            if n > 0 {
                if bytes.get(at) != Some(&'-') {
                    ok = false;
                    break;
                }
                at += 1;
            }
            if !(0..*len).all(|k| bytes.get(at + k).is_some_and(|c| c.is_ascii_hexdigit())) {
                ok = false;
                break;
            }
            at += len;
        }
        if ok {
            return true;
        }
    }
    false
}

fn is_handle_shaped(h: &str) -> bool {
    let rest = match h.strip_prefix('E') {
        Some(rest) => rest,
        None => return false,
    };
    let (num, history) = match rest.split_once(".h") {
        Some((n, k)) => (n, Some(k)),
        None => (rest, None),
    };
    !num.is_empty()
        && num.chars().all(|c| c.is_ascii_digit())
        && history.is_none_or(|k| !k.is_empty() && k.chars().all(|c| c.is_ascii_digit()))
}

type ParsedParagraph = (String, Vec<String>, String);
type ParsedSynthesis = (ModelOutcome, Vec<ParsedParagraph>, Vec<String>);

pub fn parse(raw: &str) -> Result<ParsedSynthesis, StructuralProblem> {
    let answer: RawAnswer = serde_json::from_str(raw)
        .map_err(|_| StructuralProblem("it was not valid JSON for the schema".into()))?;
    let outcome = match answer.outcome.as_str() {
        "answered" => ModelOutcome::Answered,
        "insufficient_evidence" => ModelOutcome::InsufficientEvidence,
        _ => {
            return Err(StructuralProblem(
                "outcome must be answered or insufficient_evidence".into(),
            ))
        }
    };
    if answer.paragraphs.len() > MAX_PARAGRAPHS || answer.gaps.len() > MAX_GAPS {
        return Err(StructuralProblem(format!(
            "at most {MAX_PARAGRAPHS} paragraphs and {MAX_GAPS} gaps"
        )));
    }
    if answer
        .paragraphs
        .iter()
        .any(|p| p.text.chars().count() > MAX_PARAGRAPH_CHARS)
        || answer
            .gaps
            .iter()
            .any(|g| g.chars().count() > MAX_GAP_CHARS)
    {
        return Err(StructuralProblem(format!(
            "a paragraph exceeds {MAX_PARAGRAPH_CHARS} characters"
        )));
    }
    for p in &answer.paragraphs {
        if !["current", "historical", "mixed", "external"].contains(&p.temporal.as_str()) {
            return Err(StructuralProblem(
                "temporal must be current, historical, mixed or external".into(),
            ));
        }
    }
    Ok((
        outcome,
        answer
            .paragraphs
            .into_iter()
            .map(|p| (p.text, p.based_on, p.temporal))
            .collect(),
        answer.gaps,
    ))
}

/// What a handle refers to, for temporal computation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Current,
    Superseded,
    External,
    History,
}

pub fn validate(
    raw: &str,
    package: &EvidencePackage,
    allowed: &HashSet<String>,
) -> Result<Validated, StructuralProblem> {
    let (outcome, paragraphs, gaps) = parse(raw)?;
    // kind and strength of every handle the model could legitimately cite
    let mut kinds: HashMap<&str, (Kind, bool)> = HashMap::new();
    for e in &package.entries {
        let kind = if e.external_project {
            Kind::External
        } else if e.status == "superseded" {
            Kind::Superseded
        } else {
            Kind::Current
        };
        kinds.insert(e.handle.as_str(), (kind, e.strength.level != "weak"));
        for h in e.lineage.iter().flat_map(|l| l.entries.iter()) {
            kinds.insert(h.handle.as_str(), (Kind::History, true));
        }
    }

    let mut report = ValidationReport::default();
    let mut kept: Vec<Paragraph> = Vec::new();
    for (text, based_on, claimed) in paragraphs {
        let mut handles: Vec<String> = Vec::new();
        for handle in based_on {
            // Unknown, hidden, malformed or not-in-context handles are removed, never trusted.
            if is_handle_shaped(&handle)
                && allowed.contains(&handle)
                && kinds.contains_key(handle.as_str())
            {
                if !handles.contains(&handle) {
                    handles.push(handle);
                }
            } else {
                report.stripped_refs += 1;
            }
        }
        if handles.is_empty() || text.trim().is_empty() || looks_like_uuid(&text) {
            report.dropped_paragraphs += 1;
            continue;
        }
        // A paragraph that rests only on weak candidates is not grounded.
        if !handles.iter().any(|h| kinds[h.as_str()].1) {
            report.dropped_paragraphs += 1;
            continue;
        }
        let cited: Vec<Kind> = handles.iter().map(|h| kinds[h.as_str()].0).collect();
        let all = |k: &[Kind]| cited.iter().all(|c| k.contains(c));
        let temporal: &'static str = if all(&[Kind::External]) {
            "external"
        } else if all(&[Kind::History, Kind::Superseded]) {
            "historical"
        } else if all(&[Kind::Current]) {
            "current"
        } else {
            "mixed"
        };
        if temporal != claimed {
            report.temporal_corrected += 1;
        }
        kept.push(Paragraph {
            text,
            based_on: handles,
            temporal,
        });
    }
    if outcome == ModelOutcome::Answered && kept.is_empty() {
        return Err(StructuralProblem(
            "no paragraph cited the supplied evidence".into(),
        ));
    }
    Ok(Validated {
        outcome,
        paragraphs: kept,
        gaps,
        report,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recall::package::*;
    use crate::recall::query::IntentWeights;

    fn strength(level: &'static str) -> EvidenceStrength {
        EvidenceStrength {
            points: 3,
            level,
            sufficient: level != "weak",
            signals: vec![],
        }
    }

    fn entry(
        n: usize,
        status: &'static str,
        external: bool,
        level: &'static str,
        history: usize,
    ) -> CognitiveEvidence {
        let handle = format!("E{n}");
        CognitiveEvidence {
            handle: handle.clone(),
            role: "primary",
            object_id: format!("o{n}"),
            project_id: "p".into(),
            project_name: "P".into(),
            external_project: external,
            kind: "idea".into(),
            title: "t".into(),
            current_body: "b".into(),
            current_revision_id: "r".into(),
            status,
            retrieval: None,
            strength: strength(level),
            graph: None,
            lineage: (history > 0).then(|| LineageEvidence {
                revision_count: 3,
                entries: (1..=history)
                    .map(|k| HistoryEntry {
                        handle: format!("{handle}.h{k}"),
                        revision_id: "x".into(),
                        status: "historical",
                        origin: "user_edit".into(),
                        created_at: "t".into(),
                        title: "old".into(),
                        body: "old".into(),
                        truncated: false,
                        marks: vec![],
                        leads_to_current: true,
                        source: None,
                    })
                    .collect(),
            }),
            provenance: None,
        }
    }

    fn package(entries: Vec<CognitiveEvidence>) -> (EvidencePackage, HashSet<String>) {
        let allowed: HashSet<String> = entries
            .iter()
            .flat_map(|e| {
                std::iter::once(e.handle.clone()).chain(
                    e.lineage
                        .iter()
                        .flat_map(|l| l.entries.iter().map(|h| h.handle.clone())),
                )
            })
            .collect();
        (
            EvidencePackage {
                entries,
                sufficient: true,
                insufficiency: None,
                intent: IntentWeights::default(),
                stats: Default::default(),
            },
            allowed,
        )
    }

    fn answer(paragraphs: &[(&str, &[&str], &str)], outcome: &str) -> String {
        serde_json::json!({ "outcome": outcome, "paragraphs": paragraphs.iter().map(|(t, b, tm)| serde_json::json!({"text": t, "basedOn": b, "temporal": tm})).collect::<Vec<_>>(), "gaps": [] }).to_string()
    }

    #[test]
    fn unknown_hidden_and_malformed_handles_are_stripped_and_uncited_paragraphs_dropped() {
        let (p, allowed) = package(vec![
            entry(1, "current", false, "strong", 0),
            entry(2, "current", false, "sufficient", 0),
        ]);
        let raw = answer(
            &[
                ("Good.", &["E1", "E99", "o1", "E1.h9"], "current"),
                ("Only invented.", &["E77"], "current"),
                ("No cite.", &[], "current"),
            ],
            "answered",
        );
        let v = validate(&raw, &p, &allowed).unwrap();
        assert_eq!(v.paragraphs.len(), 1);
        assert_eq!(v.paragraphs[0].based_on, ["E1"]);
        assert_eq!(
            (v.report.stripped_refs, v.report.dropped_paragraphs),
            (4, 2)
        );
    }

    #[test]
    fn handles_not_in_the_context_are_not_allowed_even_if_they_exist_in_the_package() {
        let (p, mut allowed) = package(vec![
            entry(1, "current", false, "strong", 0),
            entry(2, "current", false, "strong", 0),
        ]);
        allowed.remove("E2");
        let raw = answer(&[("About two.", &["E2"], "current")], "answered");
        assert!(
            validate(&raw, &p, &allowed).is_err(),
            "an answer that cites only what the model could not see is invalid"
        );
    }

    #[test]
    fn temporal_is_computed_from_what_is_cited_never_from_the_model() {
        let (p, allowed) = package(vec![
            entry(1, "current", false, "strong", 2),
            entry(2, "superseded", false, "sufficient", 0),
            entry(3, "current", true, "sufficient", 0),
        ]);
        let raw = answer(
            &[
                ("It used to say this.", &["E1.h1"], "current"),
                ("It changed.", &["E1", "E1.h2"], "current"),
                ("Replaced.", &["E2"], "current"),
                ("Other project.", &["E3"], "current"),
                ("Both.", &["E1", "E3"], "current"),
                ("Plain.", &["E1"], "historical"),
            ],
            "answered",
        );
        let v = validate(&raw, &p, &allowed).unwrap();
        let t: Vec<&str> = v.paragraphs.iter().map(|x| x.temporal).collect();
        assert_eq!(
            t,
            [
                "historical",
                "mixed",
                "historical",
                "external",
                "mixed",
                "current"
            ]
        );
        assert_eq!(
            v.report.temporal_corrected, 6,
            "five wrong `current` labels, and one wrong `historical` label on current evidence"
        );
    }

    #[test]
    fn a_paragraph_resting_only_on_weak_candidates_is_not_grounded() {
        let (p, allowed) = package(vec![
            entry(1, "current", false, "weak", 0),
            entry(2, "current", false, "strong", 0),
        ]);
        let raw = answer(
            &[
                ("From a lookalike.", &["E1"], "current"),
                ("From a real one.", &["E1", "E2"], "current"),
            ],
            "answered",
        );
        let v = validate(&raw, &p, &allowed).unwrap();
        assert_eq!(v.paragraphs.len(), 1);
        assert_eq!(v.paragraphs[0].text, "From a real one.");
        let only_weak = answer(&[("Lookalike.", &["E1"], "current")], "answered");
        assert!(validate(&only_weak, &p, &allowed).is_err());
    }

    #[test]
    fn internal_identifiers_in_the_text_drop_the_paragraph() {
        let (p, allowed) = package(vec![entry(1, "current", false, "strong", 0)]);
        let raw = answer(
            &[
                (
                    "See capture 3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b for details.",
                    &["E1"],
                    "current",
                ),
                ("Fine.", &["E1"], "current"),
            ],
            "answered",
        );
        let v = validate(&raw, &p, &allowed).unwrap();
        assert_eq!(v.paragraphs.len(), 1);
        assert_eq!(v.report.dropped_paragraphs, 1);
    }

    #[test]
    fn structurally_invalid_output_is_rejected() {
        let (p, allowed) = package(vec![entry(1, "current", false, "strong", 0)]);
        for bad in [
            "not json",
            "{}",
            r#"{"outcome":"answered","paragraphs":[],"gaps":[],"extra":1}"#,
            r#"{"outcome":"maybe","paragraphs":[],"gaps":[]}"#,
            r#"{"outcome":"answered","paragraphs":[{"text":"x","basedOn":["E1"],"temporal":"sometimes"}],"gaps":[]}"#,
        ] {
            assert!(validate(bad, &p, &allowed).is_err(), "{bad}");
        }
        let long = "x".repeat(MAX_PARAGRAPH_CHARS + 1);
        assert!(validate(
            &answer(&[(long.as_str(), &["E1"], "current")], "answered"),
            &p,
            &allowed
        )
        .is_err());
        let seven = answer(
            &(0..7)
                .map(|_| ("t", &["E1"][..], "current"))
                .collect::<Vec<_>>(),
            "answered",
        );
        assert!(validate(&seven, &p, &allowed).is_err());
    }

    #[test]
    fn insufficient_evidence_may_carry_what_was_found_and_needs_no_paragraphs() {
        let (p, allowed) = package(vec![entry(1, "current", false, "strong", 0)]);
        let v = validate(&answer(&[], "insufficient_evidence"), &p, &allowed).unwrap();
        assert_eq!(
            (v.outcome, v.paragraphs.len()),
            (ModelOutcome::InsufficientEvidence, 0)
        );
    }

    #[test]
    fn uuid_detection_and_handle_shapes() {
        assert!(looks_like_uuid("x 3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b y"));
        assert!(!looks_like_uuid("E1 and 2026-10-05"));
        assert!(
            is_handle_shaped("E12")
                && is_handle_shaped("E3.h2")
                && !is_handle_shaped("E")
                && !is_handle_shaped("e1")
                && !is_handle_shaped("E1.h")
                && !is_handle_shaped("E1x")
        );
    }
}
