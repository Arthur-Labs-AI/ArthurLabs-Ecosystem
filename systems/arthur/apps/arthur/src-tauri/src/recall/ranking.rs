//! Deterministic hybrid ranking (M04A retrieval-ranking.md §3). Pure functions over plain data: no database, no clock, no network.
//!
//! ```text
//! rrf(o)    = sum over channels c in {lexical, semantic} of 1 / (K + rank_c(o))                     K = 60
//!           + 0.5 / (K + rank_historical(o))   ONLY if the object has no admitted CURRENT lexical match
//! active    = number of channels that ran and returned at least one candidate (at least 1)
//! h(o)      = rrf(o) / (active / (K + 1))      1.0 = first in every active channel; comparable across degradations
//! bonus     = 0.15 if the title contains the query's entity phrase
//! prior     = kind prior (decision / task intent only), in [1.0, 1.15]
//! hybrid(o) = min(1, h + bonus) * prior
//! order     = hybrid desc, then current revision createdAt desc, then object seq asc, then id asc   (recency is a tie-break ONLY)
//! ```
//!
//! No reranker, no learned score, no graph or lineage signal.

use std::cmp::Ordering;
use std::collections::HashMap;

use super::query::{term_coverage, title_has_phrase, InterpretedQuery};
use crate::storage::recall_store::{CurrentLexicalHit, CurrentObject, HistoricalLexicalHit};

/// Reciprocal-rank-fusion constant.
pub const RRF_K: f64 = 60.0;
/// Weight of the historical-discovery contribution relative to a current channel.
pub const HISTORICAL_WEIGHT: f64 = 0.5;
pub const TITLE_PHRASE_BONUS: f64 = 0.15;
pub const KIND_PRIOR: f64 = 1.15;
/// Candidates per channel and the size of the fused pool.
pub const CHANNEL_LIMIT: usize = 30;
pub const POOL_LIMIT: usize = 40;
/// Seeds: those within `SEED_CUTOFF` of the best, at most `MAX_SEEDS`, at least one.
pub const MAX_SEEDS: usize = 8;
pub const SEED_CUTOFF: f64 = 0.5;
/// Historical nomination: how many non-current hits are considered, and when the path may run.
pub const HISTORICAL_LIMIT: usize = 10;
pub const HISTORICAL_MIN_CURRENT: usize = 3;

#[derive(Debug, Clone, PartialEq)]
pub struct LexicalSignal {
    pub rank: usize,
    pub bm25: f64,
    pub coverage: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SemanticSignal {
    pub rank: usize,
    pub cosine: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HistoricalSignal {
    pub rank: usize,
    pub revision_id: String,
    pub revision_title: String,
    pub revision_body: String,
    pub coverage: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    Both,
    Lexical,
    Semantic,
    Historical,
}

impl Admission {
    pub fn as_str(self) -> &'static str {
        match self {
            Admission::Both => "both",
            Admission::Lexical => "lexical",
            Admission::Semantic => "semantic",
            Admission::Historical => "historical",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Ranked {
    pub object: CurrentObject,
    pub lexical: Option<LexicalSignal>,
    pub semantic: Option<SemanticSignal>,
    pub historical: Option<HistoricalSignal>,
    pub rrf: f64,
    pub normalized: f64,
    pub bonus: f64,
    pub prior: f64,
    pub hybrid: f64,
    pub admission: Admission,
    /// True when a historical match contributed to this object being found (it has no admitted current lexical match).
    pub historical_discovery: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Fused {
    /// Best first, at most `POOL_LIMIT`.
    pub pool: Vec<Ranked>,
    /// How many of the leading pool entries are seeds.
    pub seed_count: usize,
    pub active_channels: usize,
}

fn rank_term(rank: usize) -> f64 {
    1.0 / (RRF_K + rank as f64)
}

fn round9(value: f64) -> f64 {
    (value * 1e9).round() / 1e9
}

/// Lexical admission floor: coverage >= 0.5 when the query has 3 or more content terms, otherwise any match.
pub fn lexical_admitted(query: &InterpretedQuery, coverage: f64) -> bool {
    if query.terms.len() >= 3 {
        coverage >= 0.5
    } else {
        coverage > 0.0
    }
}

/// Turns raw FTS hits (already best-first) into admitted, 1-ranked signals. Rank counts admitted hits only.
pub fn admit_lexical(
    query: &InterpretedQuery,
    hits: Vec<CurrentLexicalHit>,
) -> Vec<(CurrentObject, LexicalSignal)> {
    let mut admitted = Vec::new();
    for hit in hits {
        let coverage = term_coverage(query, &format!("{} {}", hit.object.title, hit.object.body));
        if lexical_admitted(query, coverage) {
            let rank = admitted.len() + 1;
            admitted.push((
                hit.object,
                LexicalSignal {
                    rank,
                    bm25: hit.bm25,
                    coverage,
                },
            ));
        }
    }
    admitted
}

/// Same floor, measured on the matched OLD revision's own text.
pub fn admit_historical(
    query: &InterpretedQuery,
    hits: Vec<HistoricalLexicalHit>,
) -> Vec<(CurrentObject, HistoricalSignal)> {
    let mut admitted = Vec::new();
    for hit in hits {
        let coverage = term_coverage(
            query,
            &format!("{} {}", hit.revision_title, hit.revision_body),
        );
        if lexical_admitted(query, coverage) {
            let rank = admitted.len() + 1;
            admitted.push((
                hit.object,
                HistoricalSignal {
                    rank,
                    revision_id: hit.revision_id,
                    revision_title: hit.revision_title,
                    revision_body: hit.revision_body,
                    coverage,
                },
            ));
        }
    }
    admitted
}

fn kind_prior(query: &InterpretedQuery, kind: &str) -> f64 {
    if (query.intent.decision >= 0.5 && kind == "decision")
        || (query.intent.task >= 0.5 && kind == "task")
    {
        KIND_PRIOR
    } else {
        1.0
    }
}

/// Whether the historical path may run: the question is about evolution, or current retrieval produced too little.
pub fn historical_path_allowed(query: &InterpretedQuery, admitted_current: usize) -> bool {
    query.intent.evolution >= 0.5 || admitted_current < HISTORICAL_MIN_CURRENT
}

pub fn fuse(
    query: &InterpretedQuery,
    lexical: Vec<(CurrentObject, LexicalSignal)>,
    semantic: Vec<(CurrentObject, SemanticSignal)>,
    historical: Vec<(CurrentObject, HistoricalSignal)>,
) -> Fused {
    let active_channels = usize::from(!lexical.is_empty()) + usize::from(!semantic.is_empty());
    let divisor = active_channels.max(1) as f64 / (RRF_K + 1.0);

    let mut by_id: HashMap<String, Ranked> = HashMap::new();
    let blank = |object: CurrentObject| Ranked {
        object,
        lexical: None,
        semantic: None,
        historical: None,
        rrf: 0.0,
        normalized: 0.0,
        bonus: 0.0,
        prior: 1.0,
        hybrid: 0.0,
        admission: Admission::Historical,
        historical_discovery: false,
    };
    for (object, signal) in lexical {
        let entry = by_id
            .entry(object.object_id.clone())
            .or_insert_with(|| blank(object));
        entry.rrf += rank_term(signal.rank);
        entry.lexical = Some(signal);
    }
    for (object, signal) in semantic {
        let entry = by_id
            .entry(object.object_id.clone())
            .or_insert_with(|| blank(object));
        entry.rrf += rank_term(signal.rank);
        entry.semantic = Some(signal);
    }
    for (object, signal) in historical {
        let entry = by_id
            .entry(object.object_id.clone())
            .or_insert_with(|| blank(object));
        // Current-first: an object that already matches in its CURRENT text gets nothing from its history.
        if entry.lexical.is_none() {
            entry.rrf += HISTORICAL_WEIGHT * rank_term(signal.rank);
            entry.historical_discovery = true;
        }
        entry.historical = Some(signal);
    }

    let mut pool: Vec<Ranked> = by_id.into_values().collect();
    for ranked in &mut pool {
        ranked.admission = match (ranked.lexical.is_some(), ranked.semantic.is_some()) {
            (true, true) => Admission::Both,
            (true, false) => Admission::Lexical,
            (false, true) => Admission::Semantic,
            (false, false) => Admission::Historical,
        };
        ranked.normalized = round9(ranked.rrf / divisor);
        ranked.bonus = if title_has_phrase(query, &ranked.object.title) {
            TITLE_PHRASE_BONUS
        } else {
            0.0
        };
        ranked.prior = kind_prior(query, &ranked.object.kind);
        ranked.hybrid = round9((ranked.normalized + ranked.bonus).min(1.0) * ranked.prior);
    }
    pool.sort_by(compare);
    pool.truncate(POOL_LIMIT);

    let seed_count = match pool.first() {
        None => 0,
        Some(top) => pool
            .iter()
            .take(MAX_SEEDS)
            .take_while(|r| r.hybrid >= SEED_CUTOFF * top.hybrid)
            .count()
            .max(1),
    };
    Fused {
        pool,
        seed_count,
        active_channels,
    }
}

fn compare(a: &Ranked, b: &Ranked) -> Ordering {
    b.hybrid
        .total_cmp(&a.hybrid)
        .then_with(|| b.object.updated_at.cmp(&a.object.updated_at))
        .then_with(|| a.object.seq.cmp(&b.object.seq))
        .then_with(|| a.object.object_id.cmp(&b.object.object_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recall::query::interpret;

    fn object(id: &str, kind: &str, title: &str, updated_at: &str, seq: i64) -> CurrentObject {
        CurrentObject {
            object_id: id.into(),
            project_id: "p".into(),
            kind: kind.into(),
            title: title.into(),
            body: "b".into(),
            current_revision_id: format!("{id}-r"),
            updated_at: updated_at.into(),
            seq,
        }
    }

    fn lex(rank: usize) -> LexicalSignal {
        LexicalSignal {
            rank,
            bm25: -1.0,
            coverage: 1.0,
        }
    }

    fn sem(rank: usize) -> SemanticSignal {
        SemanticSignal { rank, cosine: 0.5 }
    }

    fn ids(fused: &Fused) -> Vec<&str> {
        fused
            .pool
            .iter()
            .map(|r| r.object.object_id.as_str())
            .collect()
    }

    #[test]
    fn golden_rrf_k60_normalised_by_active_channels() {
        let query = interpret("zebra").unwrap();
        let a = object("a", "idea", "Zzz", "2026-01-01T00:00:00Z", 1);
        let b = object("b", "idea", "Zzz", "2026-01-01T00:00:00Z", 2);
        let c = object("c", "idea", "Zzz", "2026-01-01T00:00:00Z", 3);
        // a: lexical 1 + semantic 3; b: lexical 2 + semantic 1; c: semantic only (2)
        let fused = fuse(
            &query,
            vec![(a.clone(), lex(1)), (b.clone(), lex(2))],
            vec![
                (b.clone(), sem(1)),
                (c.clone(), sem(2)),
                (a.clone(), sem(3)),
            ],
            vec![],
        );
        assert_eq!(fused.active_channels, 2);
        let score = |id: &str| {
            fused
                .pool
                .iter()
                .find(|r| r.object.object_id == id)
                .unwrap()
                .hybrid
        };
        let max = 2.0 / 61.0;
        let expect = |r: f64| ((r / max) * 1e9).round() / 1e9;
        assert_eq!(score("a"), expect(1.0 / 61.0 + 1.0 / 63.0));
        assert_eq!(score("b"), expect(1.0 / 62.0 + 1.0 / 61.0));
        assert_eq!(score("c"), expect(1.0 / 62.0));
        assert_eq!(ids(&fused), ["b", "a", "c"]);
        assert_eq!(fused.pool[0].admission, Admission::Both);
        assert_eq!(fused.pool[2].admission, Admission::Semantic);
    }

    #[test]
    fn a_degraded_channel_keeps_scores_comparable_because_normalisation_follows_the_active_channels(
    ) {
        let query = interpret("zebra").unwrap();
        let a = object("a", "idea", "Zzz", "2026-01-01T00:00:00Z", 1);
        let both = fuse(
            &query,
            vec![(a.clone(), lex(1))],
            vec![(a.clone(), sem(1))],
            vec![],
        );
        let only_lexical = fuse(&query, vec![(a.clone(), lex(1))], vec![], vec![]);
        assert_eq!(both.pool[0].hybrid, 1.0);
        assert_eq!(
            only_lexical.pool[0].hybrid, 1.0,
            "first in every active channel is 1.0 whatever the channel count"
        );
        assert_eq!(only_lexical.active_channels, 1);
    }

    #[test]
    fn ties_break_by_recency_then_insertion_order_then_id_and_never_by_input_order() {
        let query = interpret("zebra").unwrap();
        let old = object("old", "idea", "Zzz", "2025-01-01T00:00:00Z", 1);
        let new = object("new", "idea", "Zzz", "2026-01-01T00:00:00Z", 2);
        let same_a = object("a", "idea", "Zzz", "2026-01-01T00:00:00Z", 5);
        let same_b = object("b", "idea", "Zzz", "2026-01-01T00:00:00Z", 5);
        // Four objects tied at lexical rank 1 (as if equal): force equal scores through four separate single-rank candidates.
        let lexical = |objects: Vec<CurrentObject>| {
            objects.into_iter().map(|o| (o, lex(1))).collect::<Vec<_>>()
        };
        let forward = fuse(
            &query,
            lexical(vec![
                old.clone(),
                new.clone(),
                same_a.clone(),
                same_b.clone(),
            ]),
            vec![],
            vec![],
        );
        let reverse = fuse(
            &query,
            lexical(vec![same_b, same_a, new, old]),
            vec![],
            vec![],
        );
        // Equal scores: newest current revision first; the same timestamp falls to insertion order, then id; `old` is last.
        assert_eq!(ids(&forward), ["new", "a", "b", "old"]);
        assert_eq!(ids(&forward), ids(&reverse));
    }

    #[test]
    fn recency_never_beats_relevance() {
        let query = interpret("zebra").unwrap();
        let old_decision = object("old", "decision", "Zzz", "2020-01-01T00:00:00Z", 1);
        let new_note = object("new", "note", "Zzz", "2026-10-01T00:00:00Z", 2);
        let fused = fuse(
            &query,
            vec![(old_decision, lex(1)), (new_note, lex(2))],
            vec![],
            vec![],
        );
        assert_eq!(ids(&fused), ["old", "new"]);
    }

    #[test]
    fn the_title_phrase_bonus_and_kind_prior_are_bounded_and_apply_only_when_earned() {
        let query = interpret("why did I decide the arthur mobile plan").unwrap();
        let titled = object("t", "note", "Arthur mobile plan", "2026-01-01T00:00:00Z", 1);
        let decision = object("d", "decision", "Other words", "2026-01-01T00:00:00Z", 2);
        let fused = fuse(
            &query,
            vec![(decision.clone(), lex(1)), (titled.clone(), lex(2))],
            vec![],
            vec![],
        );
        let get = |id: &str| {
            fused
                .pool
                .iter()
                .find(|r| r.object.object_id == id)
                .unwrap()
        };
        assert_eq!(get("t").bonus, TITLE_PHRASE_BONUS);
        assert_eq!(get("d").bonus, 0.0);
        assert_eq!(
            get("d").prior,
            KIND_PRIOR,
            "decision intent lifts a decision"
        );
        assert_eq!(get("t").prior, 1.0, "a note is not penalised");
        assert!(get("d").hybrid <= KIND_PRIOR && get("t").hybrid <= KIND_PRIOR);
        let neutral = interpret("arthur mobile plan").unwrap();
        let fused = fuse(&neutral, vec![(decision, lex(1))], vec![], vec![]);
        assert_eq!(fused.pool[0].prior, 1.0, "no intent, no prior");
    }

    #[test]
    fn a_historical_match_only_helps_an_object_with_no_current_lexical_match() {
        let query = interpret("zebra").unwrap();
        let current = object("cur", "idea", "Zzz", "2026-01-01T00:00:00Z", 1);
        let recovered = object("rec", "idea", "Zzz", "2026-01-01T00:00:00Z", 2);
        let history = |rank: usize, id: &str| HistoricalSignal {
            rank,
            revision_id: id.into(),
            revision_title: "old".into(),
            revision_body: "old".into(),
            coverage: 1.0,
        };
        let fused = fuse(
            &query,
            vec![(current.clone(), lex(1))],
            vec![],
            vec![
                (current.clone(), history(1, "cur-old")),
                (recovered.clone(), history(2, "rec-old")),
            ],
        );
        let get = |id: &str| {
            fused
                .pool
                .iter()
                .find(|r| r.object.object_id == id)
                .unwrap()
        };
        assert!(
            !get("cur").historical_discovery,
            "current wording wins; history adds nothing"
        );
        assert_eq!(get("cur").admission, Admission::Lexical);
        assert!(get("rec").historical_discovery);
        assert_eq!(get("rec").admission, Admission::Historical);
        assert!(
            get("cur").hybrid > get("rec").hybrid,
            "a current match always outranks a recovered one at similar rank"
        );
        assert_eq!(
            get("rec").object.title,
            "Zzz",
            "the object is reported by its CURRENT title"
        );
    }

    #[test]
    fn seeds_are_within_half_of_the_best_capped_at_eight_and_never_empty() {
        let query = interpret("zebra").unwrap();
        let many: Vec<(CurrentObject, LexicalSignal)> = (1..=12)
            .map(|i| {
                (
                    object(
                        &format!("o{i:02}"),
                        "idea",
                        "Zzz",
                        "2026-01-01T00:00:00Z",
                        i,
                    ),
                    lex(i as usize),
                )
            })
            .collect();
        let fused = fuse(&query, many, vec![], vec![]);
        assert_eq!(
            fused.seed_count, 8,
            "rank 12 is still above half of rank 1 under RRF, so the cap decides"
        );
        let one = fuse(
            &query,
            vec![(
                object("x", "idea", "Zzz", "2026-01-01T00:00:00Z", 1),
                lex(1),
            )],
            vec![],
            vec![],
        );
        assert_eq!(one.seed_count, 1);
        assert_eq!(fuse(&query, vec![], vec![], vec![]).seed_count, 0);
    }

    #[test]
    fn the_historical_path_is_gated() {
        assert!(historical_path_allowed(
            &interpret("how did the idea evolve").unwrap(),
            5
        ));
        assert!(historical_path_allowed(
            &interpret("offline sync").unwrap(),
            2
        ));
        assert!(!historical_path_allowed(
            &interpret("offline sync").unwrap(),
            3
        ));
    }

    #[test]
    fn the_same_inputs_always_give_the_same_order() {
        let query = interpret("zebra stripes").unwrap();
        let objects: Vec<CurrentObject> = (0..20)
            .map(|i| {
                object(
                    &format!("o{i:02}"),
                    "idea",
                    "Zzz",
                    &format!("2026-01-{:02}T00:00:00Z", 1 + i % 5),
                    i,
                )
            })
            .collect();
        let build = |shift: usize| {
            let lexical = objects
                .iter()
                .cloned()
                .enumerate()
                .map(|(i, o)| (o, lex(1 + (i + shift) % 7)))
                .collect::<Vec<_>>();
            let semantic = objects
                .iter()
                .cloned()
                .rev()
                .enumerate()
                .map(|(i, o)| (o, sem(1 + i % 5)))
                .collect::<Vec<_>>();
            fuse(&query, lexical, semantic, vec![])
        };
        assert_eq!(build(0), build(0));
    }
}
