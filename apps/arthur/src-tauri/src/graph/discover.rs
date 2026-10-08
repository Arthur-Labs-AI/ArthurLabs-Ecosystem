//! Candidate discovery for Automatic Graph Integration (M04.7A): which objects of the SAME project might the changed object relate to.
//!
//! Discovery only NOMINATES. It never decides a relation, and similarity here is never a reason to persist anything: every nominee
//! still needs a proposal, two independent verifications and the deterministic admission policy (`graph::integrate`).
//!
//! Channels (all Project-local, current revisions only; archived projects never reach this code):
//!
//! 1. LEXICAL, always on. The changed object's own title + body are interpreted exactly like a Recall query (`recall::query::interpret`:
//!    NFC, stopwords, Bulgarian/English stem-prefixes, at most 12 content terms). Each other object of the project is scored by the
//!    IDF-weighted share of those terms it contains. An object is nominated if it shares at least two terms (one, when the changed
//!    object has a single term) and the weighted share is at least `MIN_LEXICAL_SHARE`. The IDF weight keeps a word every object in the
//!    project uses ("Arthur") from nominating everything.
//! 2. SEMANTIC, only when the user has opted in to semantic Recall (`RecallService::semantic_enabled`). It is the existing Recall
//!    retrieval with its unchanged cosine floor (0.40); only evidence that the SEMANTIC channel found is used. It sends the changed
//!    object's text to the embedding provider exactly as an Ask question would, under the same consent. With semantic Recall off no
//!    embedding request is made, whatever credentials exist.
//! 3. NEIGHBOURHOOD: objects one hop from the best few nominees through ANY existing relation, same project, capped.
//! 4. A FLOOR: when fewer than `MIN_CANDIDATES` were nominated, the most recent objects of the project pad the set. A paraphrase
//!    ("phone" for "mobile", a Bulgarian reformulation) shares no word, and in a small project the verifier is a better judge than
//!    vocabulary overlap.
//!
//! The set is bounded: at most `MAX_RANKED` ranked nominees + `MAX_NEIGHBOURS` neighbours = `MAX_DISCOVERED`, whatever the project
//! size. (The manual "find connections" run keeps its larger recency window of 40; integration runs on every new thought, so its
//! window is smaller and chosen by relevance.)

use std::collections::{HashMap, HashSet};

use crate::recall::query::{interpret, tokens, InterpretedQuery, MAX_QUERY_CHARS};
use crate::recall::RecallService;
use crate::storage::capture_store::CaptureStore;
use crate::storage::knowledge_store::KnowledgeObject;
use crate::storage::relation_store::Direction;

use super::RelationError;

/// Ranked nominees (lexical + semantic) kept.
pub const MAX_RANKED: usize = 8;
/// Graph-neighbourhood objects added.
pub const MAX_NEIGHBOURS: usize = 4;
/// Hard bound on the discovered set. The model sees these plus the changed object.
pub const MAX_DISCOVERED: usize = MAX_RANKED + MAX_NEIGHBOURS;
/// Below this many, the most recent objects pad the set.
pub const MIN_CANDIDATES: usize = 6;
/// How many of the best nominees contribute neighbours.
const NEIGHBOUR_SEEDS: usize = 3;
/// Minimum IDF-weighted share of the changed object's terms that a nominee must contain.
pub const MIN_LEXICAL_SHARE: f64 = 0.15;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DiscoveryReport {
    /// Objects in the project, the changed object excluded.
    pub project_objects: usize,
    pub lexical: usize,
    pub semantic: usize,
    pub neighbours: usize,
    pub padded: usize,
    /// Semantic discovery ran (consent given and the provider answered).
    pub semantic_ran: bool,
}

#[derive(Debug, Clone)]
pub struct Discovery {
    pub candidates: Vec<KnowledgeObject>,
    pub report: DiscoveryReport,
}

/// The text a changed object is searched with: its title first (the strongest signal), then its body, within the Recall query limit.
fn search_text(focus: &KnowledgeObject) -> String {
    format!("{}. {}", focus.title, focus.body).chars().take(MAX_QUERY_CHARS).collect()
}

fn idf(total: usize, document_frequency: usize) -> f64 {
    (1.0 + total as f64 / (1.0 + document_frequency as f64)).ln()
}

/// Lexical nominees: `(index into others, share)`, best first, ties broken by recency (a lower index is newer).
pub fn rank_lexical(query: &InterpretedQuery, others: &[KnowledgeObject]) -> Vec<(usize, f64)> {
    if query.terms.is_empty() || others.is_empty() {
        return Vec::new();
    }
    let documents: Vec<Vec<String>> = others.iter().map(|object| tokens(&format!("{} {}", object.title, object.body))).collect();
    let matches = |term: &crate::recall::query::Term, document: &[String]| document.iter().any(|token| term.matches_token(token));
    let weights: Vec<f64> = query.terms.iter().map(|term| idf(others.len(), documents.iter().filter(|document| matches(term, document)).count())).collect();
    let total: f64 = weights.iter().sum();
    let needed = query.terms.len().min(2);

    let mut ranked: Vec<(usize, f64)> = documents
        .iter()
        .enumerate()
        .filter_map(|(index, document)| {
            let hit: Vec<usize> = (0..query.terms.len()).filter(|&t| matches(&query.terms[t], document)).collect();
            let share = hit.iter().map(|&t| weights[t]).sum::<f64>() / total;
            (hit.len() >= needed && share >= MIN_LEXICAL_SHARE).then_some((index, share))
        })
        .collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    ranked
}

/// Nominates candidates for `focus` from its own project. `others` are the project's objects in `list_knowledge_objects` order
/// (most recent first); the changed object may be among them and is ignored.
pub async fn discover(store: &CaptureStore, recall: &RecallService, focus: &KnowledgeObject, project_id: &str) -> Result<Discovery, RelationError> {
    let storage = |error: crate::storage::capture_store::StoreError| RelationError::Storage(error.to_string());
    let others: Vec<KnowledgeObject> = store.list_knowledge_objects_in(Some(project_id)).map_err(storage)?.into_iter().filter(|object| object.id != focus.id).collect();
    let mut report = DiscoveryReport { project_objects: others.len(), ..DiscoveryReport::default() };
    if others.len() <= MAX_DISCOVERED {
        // Nothing to rank: the whole (small) project is the candidate set.
        return Ok(Discovery { candidates: others, report });
    }

    let text = search_text(focus);
    let mut chosen: Vec<usize> = Vec::new();
    let position: HashMap<&str, usize> = others.iter().enumerate().map(|(index, object)| (object.id.as_str(), index)).collect();

    let lexical: Vec<usize> = match interpret(&text) {
        Ok(query) => rank_lexical(&query, &others).into_iter().map(|(index, _)| index).collect(),
        Err(_) => Vec::new(),
    };
    let mut semantic: Vec<usize> = Vec::new();
    if recall.semantic_enabled() {
        // A failure here only means the semantic channel is unavailable this time; lexical discovery is unaffected.
        if let Ok(result) = recall.retrieve(store, &text, project_id).await {
            report.semantic_ran = matches!(result.diagnostics.semantic, crate::recall::evidence::SemanticStatus::Ok | crate::recall::evidence::SemanticStatus::Partial);
            semantic = result.evidence.iter().filter(|e| e.semantic.is_some()).filter_map(|e| position.get(e.object_id.as_str()).copied()).collect();
        }
    }
    report.lexical = lexical.len().min(MAX_RANKED);
    report.semantic = semantic.len().min(MAX_RANKED);

    // Found by both channels first, then the channels alternate (lexical first), so neither crowds the other out.
    let semantic_set: HashSet<usize> = semantic.iter().copied().collect();
    let lexical_set: HashSet<usize> = lexical.iter().copied().collect();
    let push = |index: usize, chosen: &mut Vec<usize>| {
        if chosen.len() < MAX_RANKED && !chosen.contains(&index) {
            chosen.push(index);
        }
    };
    for &index in lexical.iter().filter(|index| semantic_set.contains(index)) {
        push(index, &mut chosen);
    }
    let (mut l, mut s) = (lexical.iter().filter(|i| !semantic_set.contains(i)), semantic.iter().filter(|i| !lexical_set.contains(i)));
    loop {
        let (a, b) = (l.next(), s.next());
        if a.is_none() && b.is_none() {
            break;
        }
        for index in [a, b].into_iter().flatten() {
            push(*index, &mut chosen);
        }
    }

    // One hop from the best few, inside the project.
    let seeds: Vec<usize> = chosen.iter().take(NEIGHBOUR_SEEDS).copied().collect();
    for seed in seeds {
        let neighbours = store.object_neighbors(&others[seed].id, Direction::Any, None).map_err(storage)?;
        for neighbour in neighbours {
            if report.neighbours >= MAX_NEIGHBOURS {
                break;
            }
            if let Some(&index) = position.get(neighbour.id.as_str()) {
                if !chosen.contains(&index) {
                    chosen.push(index);
                    report.neighbours += 1;
                }
            }
        }
    }

    // The floor: recency, for paraphrases that share no word.
    let mut index = 0;
    while chosen.len() < MIN_CANDIDATES && index < others.len() {
        if !chosen.contains(&index) {
            chosen.push(index);
            report.padded += 1;
        }
        index += 1;
    }

    chosen.sort_unstable();
    let candidates = chosen.into_iter().map(|index| others[index].clone()).collect();
    Ok(Discovery { candidates, report })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(id: &str, title: &str, body: &str) -> KnowledgeObject {
        KnowledgeObject {
            id: id.into(),
            kind: "idea".into(),
            title: title.into(),
            body: body.into(),
            created_at: "2026-10-04T10:00:00Z".into(),
            provenance: crate::storage::knowledge_store::Provenance { capture_id: "c".into(), source_start: 0, source_end: 1 },
            project_id: "p".into(),
        }
    }

    fn rank(focus: &KnowledgeObject, others: &[KnowledgeObject]) -> Vec<usize> {
        rank_lexical(&interpret(&search_text(focus)).unwrap(), others).into_iter().map(|(index, _)| index).collect()
    }

    #[test]
    fn shared_vocabulary_nominates_and_a_ubiquitous_word_alone_does_not() {
        let focus = object("f", "Offline phone storage", "The phone keeps SQLite storage working offline.");
        let others = vec![
            object("a", "Arthur roadmap", "Arthur needs a roadmap."),
            object("b", "Arthur colours", "Arthur uses warm paper colours."),
            object("c", "SQLite storage layer", "Local SQLite storage for captures."),
            object("d", "Arthur naming", "Arthur is a good name."),
        ];
        assert_eq!(rank(&focus, &others), vec![2]);
    }

    #[test]
    fn a_single_shared_word_is_not_enough_when_the_object_has_several_terms() {
        let focus = object("f", "Home Node synchronisation protocol", "Design the synchronisation protocol between phone and home node.");
        let others = vec![object("a", "Protocol for naming", "A protocol for naming things."), object("b", "Synchronisation later", "The synchronisation protocol is a later milestone.")];
        assert_eq!(rank(&focus, &others), vec![1]);
    }

    #[test]
    fn bulgarian_inflection_matches_by_stem_and_english_stemming_is_not_applied_to_it() {
        let focus = object("f", "Телефонът работи локално", "Телефонът пази знанията локално в SQLite.");
        let others = vec![object("a", "Локално пазене на знания", "Знанията се пазят локално на телефона."), object("b", "Unrelated shopping", "Buy milk and bread.")];
        assert_eq!(rank(&focus, &others), vec![0]);
    }

    #[test]
    fn ties_prefer_the_more_recent_object() {
        let focus = object("f", "Voice capture pipeline", "Voice capture pipeline design.");
        let others = vec![object("new", "Voice capture pipeline notes", "pipeline"), object("old", "Voice capture pipeline notes", "pipeline")];
        assert_eq!(rank(&focus, &others), vec![0, 1]);
    }

    #[test]
    fn a_focus_with_no_content_terms_nominates_nothing() {
        let focus = object("f", "It is", "to be or not");
        assert!(rank_lexical(&interpret("It is. to be or not").unwrap(), &[object("a", "It is", "to be")]).is_empty());
        assert!(rank(&focus, &[]).is_empty());
    }
}
