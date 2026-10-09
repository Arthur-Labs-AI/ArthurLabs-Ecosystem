//! Turns untrusted candidates into validated objects with exact provenance.
//!
//! Offsets are never taken from the model on trust. Each candidate carries a verbatim
//! `evidence` quote; this module finds it in the raw capture and computes the span itself.
//! Model-supplied offsets are only a tie-breaker, accepted solely when the text at those
//! offsets is exactly the evidence. Anything that cannot be resolved rejects the whole set.

use crate::storage::knowledge_store::{NewKnowledgeObject, MAX_OBJECTS_PER_DISTILLATION};

use super::{Candidate, DistillError};

fn invalid(index: usize, reason: &str) -> DistillError {
    DistillError::InvalidOutput(format!("object {index}: {reason}"))
}

/// All code-point offsets at which `needle` occurs in `haystack`.
fn occurrences(haystack: &[char], needle: &[char]) -> Vec<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return Vec::new();
    }
    (0..=haystack.len() - needle.len()).filter(|&start| haystack[start..start + needle.len()] == *needle).collect()
}

pub fn resolve_candidates(content: &str, candidates: Vec<Candidate>) -> Result<Vec<NewKnowledgeObject>, DistillError> {
    if candidates.len() > MAX_OBJECTS_PER_DISTILLATION {
        return Err(DistillError::InvalidOutput(format!("more than {MAX_OBJECTS_PER_DISTILLATION} objects")));
    }
    let text: Vec<char> = content.chars().collect();
    let mut resolved: Vec<NewKnowledgeObject> = Vec::with_capacity(candidates.len());

    for (index, candidate) in candidates.into_iter().enumerate() {
        // Whitespace around a quote is formatting, not evidence.
        let evidence: Vec<char> = candidate.evidence.trim().chars().collect();
        if evidence.is_empty() {
            return Err(invalid(index, "evidence is empty"));
        }

        let found = occurrences(&text, &evidence);
        let start = match found.as_slice() {
            [] => return Err(invalid(index, "evidence is not a verbatim quote of the capture")),
            [only] => *only,
            several => {
                // Same words appear more than once: only the model's hint can choose, and only if exact.
                let hinted = candidate
                    .source_start
                    .and_then(|hint| usize::try_from(hint).ok())
                    .filter(|hint| several.contains(hint) && candidate.source_end == Some((*hint + evidence.len()) as i64));
                hinted.ok_or_else(|| invalid(index, "evidence appears more than once and its position is ambiguous"))?
            }
        };

        let object = NewKnowledgeObject {
            kind: candidate.kind,
            title: candidate.title.trim().to_string(),
            body: candidate.body.trim().to_string(),
            source_start: start as i64,
            source_end: (start + evidence.len()) as i64,
        };
        // The same thought twice is one object.
        let duplicate = resolved.iter().any(|existing| {
            existing.kind == object.kind
                && existing.title.to_lowercase() == object.title.to_lowercase()
                && existing.source_start == object.source_start
                && existing.source_end == object.source_end
        });
        if !duplicate {
            resolved.push(object);
        }
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(kind: &str, title: &str, evidence: &str) -> Candidate {
        Candidate { kind: kind.into(), title: title.into(), body: "Body.".into(), evidence: evidence.into(), source_start: None, source_end: None }
    }

    const TEXT: &str = "I want to improve the Arthur capture screen. Tomorrow I also need to email Ignatov about the competition.";

    #[test]
    fn evidence_resolves_to_the_exact_span_of_the_raw_text() {
        let resolved = resolve_candidates(
            TEXT,
            vec![candidate("idea", "Improve capture screen", "improve the Arthur capture screen"), candidate("task", "Email Ignatov", "email Ignatov about the competition")],
        )
        .unwrap();

        let chars: Vec<char> = TEXT.chars().collect();
        let slice = |o: &NewKnowledgeObject| chars[o.source_start as usize..o.source_end as usize].iter().collect::<String>();
        assert_eq!(slice(&resolved[0]), "improve the Arthur capture screen");
        assert_eq!(slice(&resolved[1]), "email Ignatov about the competition");
    }

    #[test]
    fn offsets_are_code_points_not_bytes_or_utf16_units() {
        let text = "Здравей 😀 свят, ще пиша на Игнатов";
        let resolved = resolve_candidates(text, vec![candidate("task", "Пиша", "ще пиша на Игнатов")]).unwrap();
        let chars: Vec<char> = text.chars().collect();
        assert_eq!(chars[resolved[0].source_start as usize..resolved[0].source_end as usize].iter().collect::<String>(), "ще пиша на Игнатов");
        assert_eq!(resolved[0].source_start, 16, "after one emoji and Cyrillic: counted in code points");
    }

    #[test]
    fn the_models_own_offsets_are_never_trusted() {
        let mut lying = candidate("idea", "t", "capture screen");
        lying.source_start = Some(0);
        lying.source_end = Some(5);
        let resolved = resolve_candidates(TEXT, vec![lying]).unwrap();
        assert_eq!((resolved[0].source_start, resolved[0].source_end), (29, 43), "computed from the text, not from the hint");
    }

    #[test]
    fn evidence_that_is_not_in_the_capture_rejects_everything() {
        for evidence in ["a paraphrase of it", "IMPROVE THE ARTHUR CAPTURE SCREEN", "improve  the Arthur", "something invented", ""] {
            let result = resolve_candidates(TEXT, vec![candidate("idea", "ok", "improve the Arthur capture screen"), candidate("note", "bad", evidence)]);
            assert!(matches!(result, Err(DistillError::InvalidOutput(reason)) if reason.starts_with("object 1:")), "{evidence:?}");
        }
    }

    #[test]
    fn repeated_evidence_needs_an_exact_hint_to_be_resolved() {
        let text = "email Ana, then email Boris";
        assert!(resolve_candidates(text, vec![candidate("task", "t", "email")]).is_err(), "ambiguous without a hint");

        let mut hinted = candidate("task", "t", "email");
        hinted.source_start = Some(16);
        hinted.source_end = Some(21);
        assert_eq!(resolve_candidates(text, vec![hinted]).unwrap()[0].source_start, 16);

        let mut wrong = candidate("task", "t", "email");
        wrong.source_start = Some(4); // text at 4..9 is "Ana, " not "email"
        wrong.source_end = Some(9);
        assert!(resolve_candidates(text, vec![wrong]).is_err(), "a hint that does not point at the evidence is useless");
    }

    #[test]
    fn surrounding_whitespace_in_the_quote_is_ignored_but_inner_text_is_exact() {
        let resolved = resolve_candidates(TEXT, vec![candidate("idea", "  Improve  ", "  capture screen \n")]).unwrap();
        assert_eq!(resolved[0].title, "Improve");
        assert_eq!(resolved[0].source_end - resolved[0].source_start, "capture screen".chars().count() as i64);
    }

    #[test]
    fn exact_duplicates_collapse_to_one_object() {
        let resolved = resolve_candidates(TEXT, vec![candidate("idea", "Improve it", "capture screen"), candidate("idea", "IMPROVE IT", "capture screen")]).unwrap();
        assert_eq!(resolved.len(), 1);
        let two_kinds = resolve_candidates(TEXT, vec![candidate("idea", "x", "capture screen"), candidate("task", "x", "capture screen")]).unwrap();
        assert_eq!(two_kinds.len(), 2, "same words, different kind, is not a duplicate");
    }

    #[test]
    fn zero_candidates_is_a_valid_result_and_too_many_is_not() {
        assert_eq!(resolve_candidates(TEXT, vec![]).unwrap(), vec![]);
        let many = (0..=MAX_OBJECTS_PER_DISTILLATION).map(|i| candidate("note", &format!("t{i}"), "capture screen")).collect();
        assert!(resolve_candidates(TEXT, many).is_err());
    }
}
