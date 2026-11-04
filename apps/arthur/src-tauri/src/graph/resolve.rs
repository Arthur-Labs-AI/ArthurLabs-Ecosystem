//! Deterministic resolution of VERIFIED relations for one pair of objects (M04.7A.2).
//!
//! The model gives independent yes/no answers; Arthur decides what to persist. The model never breaks a tie.
//!
//! * nothing survives                          -> no edge
//! * exactly one relation survives             -> persist it
//! * several survive                           -> persist NOTHING (ambiguity), unless every other survivor is `related_to`, which the
//!   Graph's own definition makes redundant: `related_to` is defined as "a concrete link where NO stronger kind applies", so a stronger
//!   verified kind subsumes it (this is the only compatibility the existing semantics prove safe)
//!
//! The matrix below classifies every pair of kinds from `semantics.rs`, not from any benchmark output. `Incompatible` kinds cannot both
//! be true of one pair. `Overlapping` kinds can both sound plausible and no rule says which one is the edge. Both are dropped:
//! precision over recall.

use crate::storage::relation_store::{canonical_ends, NewRelation};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Compat {
    /// The second kind adds nothing once the first (stronger) kind is verified. Only `related_to` is ever subsumed.
    Subsumes,
    /// Both cannot be true of the same pair (or the same kind claimed in both directions).
    Incompatible,
    /// Both can plausibly hold, and the Graph semantics do not say which is the edge.
    Overlapping,
}

/// Symmetric in its arguments. Total over `KINDS`.
pub fn compatibility(a: &str, b: &str) -> Compat {
    let pair = |x: &str, y: &str| (a == x && b == y) || (a == y && b == x);
    let one_of = |x: &str, others: &[&str]| {
        (a == x && others.contains(&b)) || (b == x && others.contains(&a))
    };
    if a == b {
        // The same kind claimed in opposite directions (a symmetric kind has one canonical edge, so it never gets here).
        return Compat::Incompatible;
    }
    if a == "related_to" || b == "related_to" {
        return Compat::Subsumes;
    }
    // duplicates: "effectively the same thought" excludes added detail, replacement, conflict, requirement and derivation.
    if a == "duplicates" || b == "duplicates" {
        return Compat::Incompatible;
    }
    if pair("supersedes", "contradicts") {
        return Compat::Overlapping;
    }
    // A replacement or a conflict is not compatible with "B is required / enriched / the source of A".
    if one_of("supersedes", &["extends", "depends_on", "derived_from"])
        || one_of("contradicts", &["extends", "depends_on", "derived_from"])
    {
        return Compat::Incompatible;
    }
    Compat::Overlapping
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    None,
    Persist(NewRelation),
    /// More than one verified relation and no proven-safe way to pick: nothing is persisted. Carries the survivors for reporting.
    Ambiguous(Vec<NewRelation>),
}

fn identity(edge: &NewRelation) -> (String, String, String) {
    let (source, target) =
        canonical_ends(&edge.kind, &edge.source_object_id, &edge.target_object_id);
    (edge.kind.clone(), source, target)
}

/// `survivors`: the relations that both verification passes supported for ONE pair of objects.
pub fn resolve(survivors: Vec<NewRelation>) -> Resolution {
    let mut distinct: Vec<NewRelation> = Vec::new();
    for edge in survivors {
        if !distinct
            .iter()
            .any(|known| identity(known) == identity(&edge))
        {
            distinct.push(edge);
        }
    }
    // A stronger verified kind subsumes related_to (the definition of related_to says so).
    if distinct.iter().any(|edge| edge.kind != "related_to") {
        distinct.retain(|edge| edge.kind != "related_to");
    }
    match distinct.len() {
        0 => Resolution::None,
        1 => Resolution::Persist(distinct.remove(0)),
        _ => Resolution::Ambiguous(distinct),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::relation_store::KINDS;

    const A: &str = "11111111-1111-4111-8111-111111111111";
    const B: &str = "22222222-2222-4222-8222-222222222222";

    fn edge(kind: &str, source: &str, target: &str) -> NewRelation {
        NewRelation {
            kind: kind.into(),
            source_object_id: source.into(),
            target_object_id: target.into(),
        }
    }

    #[test]
    fn the_matrix_is_total_and_symmetric() {
        for a in KINDS {
            for b in KINDS {
                assert_eq!(compatibility(a, b), compatibility(b, a), "{a} / {b}");
            }
        }
    }

    #[test]
    fn the_documented_examples() {
        use Compat::*;
        assert_eq!(compatibility("duplicates", "contradicts"), Incompatible);
        assert_eq!(compatibility("supersedes", "duplicates"), Incompatible);
        assert_eq!(compatibility("depends_on", "derived_from"), Overlapping);
        assert_eq!(compatibility("extends", "depends_on"), Overlapping);
        assert_eq!(compatibility("supersedes", "contradicts"), Overlapping);
        assert_eq!(compatibility("related_to", "extends"), Subsumes);
        assert_eq!(compatibility("depends_on", "depends_on"), Incompatible);
        // only related_to is ever subsumed
        for a in KINDS.iter().filter(|k| **k != "related_to") {
            for b in KINDS.iter().filter(|k| **k != "related_to") {
                assert_ne!(compatibility(a, b), Subsumes, "{a} / {b}");
            }
        }
    }

    #[test]
    fn nothing_one_and_many() {
        assert_eq!(resolve(vec![]), Resolution::None);
        assert_eq!(
            resolve(vec![edge("depends_on", A, B)]),
            Resolution::Persist(edge("depends_on", A, B))
        );
        // duplicates in the input are one survivor
        assert_eq!(
            resolve(vec![edge("depends_on", A, B), edge("depends_on", A, B)]),
            Resolution::Persist(edge("depends_on", A, B))
        );
        for combo in [
            vec![edge("extends", A, B), edge("depends_on", A, B)],
            vec![edge("supersedes", A, B), edge("contradicts", A, B)],
            vec![edge("duplicates", A, B), edge("extends", A, B)],
            vec![edge("depends_on", A, B), edge("depends_on", B, A)],
        ] {
            assert!(matches!(resolve(combo), Resolution::Ambiguous(_)));
        }
    }

    #[test]
    fn a_stronger_kind_subsumes_related_to_but_two_stronger_kinds_still_conflict() {
        assert_eq!(
            resolve(vec![edge("related_to", A, B), edge("extends", A, B)]),
            Resolution::Persist(edge("extends", A, B))
        );
        assert!(matches!(
            resolve(vec![
                edge("related_to", A, B),
                edge("extends", A, B),
                edge("depends_on", A, B)
            ]),
            Resolution::Ambiguous(_)
        ));
        assert_eq!(
            resolve(vec![edge("related_to", A, B)]),
            Resolution::Persist(edge("related_to", A, B))
        );
    }
}
