//! The lexical fallback: used only when FTS5 itself fails.
//!
//! A scan of one project's CURRENT objects in Rust. Case-insensitivity comes from `str::to_lowercase` (full Unicode), because
//! SQLite's `lower()` is ASCII-only and would silently break Cyrillic. Same scope and currency rules as the FTS path; lower quality.

use super::query::{tokens, InterpretedQuery};
use super::ranking::CHANNEL_LIMIT;
use crate::storage::recall_store::{CurrentLexicalHit, CurrentObject};

/// Title matches count three times a body match (FTS5 weights the title eight times; this path only needs a stable order).
const TITLE_WEIGHT: f64 = 3.0;

pub fn fallback_scan(
    query: &InterpretedQuery,
    objects: Vec<CurrentObject>,
) -> Vec<CurrentLexicalHit> {
    let mut scored: Vec<(f64, CurrentObject)> = objects
        .into_iter()
        .filter_map(|object| {
            let title = tokens(&object.title);
            let body = tokens(&object.body);
            let score: f64 = query
                .terms
                .iter()
                .map(|term| {
                    (if title.iter().any(|t| term.matches_token(t)) {
                        TITLE_WEIGHT
                    } else {
                        0.0
                    }) + if body.iter().any(|t| term.matches_token(t)) {
                        1.0
                    } else {
                        0.0
                    }
                })
                .sum();
            (score > 0.0).then_some((score, object))
        })
        .collect();
    scored.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then_with(|| a.1.seq.cmp(&b.1.seq))
            .then_with(|| a.1.object_id.cmp(&b.1.object_id))
    });
    scored.truncate(CHANNEL_LIMIT);
    // Mirror bm25's "smaller is better".
    scored
        .into_iter()
        .map(|(score, object)| CurrentLexicalHit {
            object,
            bm25: -score,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recall::query::interpret;

    fn object(id: &str, title: &str, body: &str, seq: i64) -> CurrentObject {
        CurrentObject {
            object_id: id.into(),
            project_id: "p".into(),
            kind: "idea".into(),
            title: title.into(),
            body: body.into(),
            current_revision_id: format!("{id}-r"),
            updated_at: "2026-01-01T00:00:00Z".into(),
            seq,
        }
    }

    #[test]
    fn it_matches_cyrillic_case_insensitively_and_by_stem_and_prefers_titles() {
        let query = interpret("мобилното приложение").unwrap();
        let hits = fallback_scan(
            &query,
            vec![
                object("a", "Нещо", "МОБИЛНИ ПРИЛОЖЕНИЯ", 1),
                object("b", "Мобилно приложение", "x", 2),
                object("c", "Друго", "няма", 3),
            ],
        );
        let ids: Vec<&str> = hits.iter().map(|h| h.object.object_id.as_str()).collect();
        assert_eq!(ids, ["b", "a"]);
    }
}
