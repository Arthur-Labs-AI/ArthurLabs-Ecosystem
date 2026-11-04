//! Bounded Cognitive Graph enrichment (M04A pipeline.md §5). Pure: relations and neighbour details go in, deterministic admissions come
//! out. Nothing here reads a database, calls a model, or changes what any relation means.
//!
//! The graph is an EXPANSION of strong retrieval seeds, never a search engine:
//!
//! ```text
//! seeds        top 5 retrieval seeds that are sufficient evidence on their own
//! reach        1 hop; a 2nd hop only along depends_on (dependency intent) or supersedes (evolution intent)
//! admitted     <= 12 in-scope objects (<= 4 per seed, <= 2 per relation kind per seed), <= 3 external-project objects, <= 4 second-hop
//! score(x)     seedHybrid(<=1) * baseWeight(kind, direction) * intentMultiplier(kind, direction) * 0.6        (2nd hop: * 0.6 again)
//! floor        score >= 0.25 * the weakest expanding seed
//! order        score desc, relation createdAt asc, relation id asc, object id asc
//! ```
//!
//! Direction is read RELATIVE TO THE SEED: `Out` = the seed is the stored source of the edge, `In` = the seed is its target. Symmetric
//! kinds (related_to, contradicts, duplicates) have no direction (`Sym`).
//!
//! Cross-project rule (one closed rule): an object outside the scope project is admitted only if it is the far end of a relation whose
//! other end is an expanding seed, one hop, its project is NOT archived, and fewer than 3 external objects are already admitted. An
//! external object is never a frontier and never a seed. Archived projects' objects are never admitted as external, from any scope.

use std::collections::{HashMap, HashSet};

use super::query::IntentWeights;
use crate::storage::recall_store::{CurrentObject, RelationRow};

pub const EXPANDING_SEEDS: usize = 5;
pub const MAX_GRAPH_OBJECTS: usize = 12;
pub const MAX_EXTERNAL: usize = 3;
pub const MAX_PER_SEED: usize = 4;
pub const MAX_PER_SEED_KIND: usize = 2;
pub const MAX_SECOND_HOP: usize = 4;
pub const HOP_DECAY: f64 = 0.6;
pub const FLOOR_FRACTION: f64 = 0.25;
pub const MULTIPLIER_MIN: f64 = 0.3;
pub const MULTIPLIER_MAX: f64 = 2.0;
/// Intent weights at or above this count as "the question is about this".
pub const INTENT_ON: f64 = 0.5;

const SYMMETRIC: [&str; 3] = ["related_to", "contradicts", "duplicates"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dir {
    Out,
    In,
    Sym,
}

impl Dir {
    pub fn as_str(self) -> &'static str {
        match self {
            Dir::Out => "out",
            Dir::In => "in",
            Dir::Sym => "sym",
        }
    }
}

/// Direction of `relation` as seen from `from_object`.
pub fn direction_from(from_object: &str, relation: &RelationRow) -> Dir {
    if SYMMETRIC.contains(&relation.kind.as_str()) {
        Dir::Sym
    } else if relation.source_object_id == from_object {
        Dir::Out
    } else {
        Dir::In
    }
}

/// M04A base weights. Semantics of the relation kinds are untouched; this only says how worth-adding an adjacent object is.
pub fn base_weight(kind: &str, dir: Dir) -> f64 {
    match (kind, dir) {
        ("related_to", _) => 0.50,
        ("extends", Dir::Out) => 0.70,
        ("extends", _) => 0.60,
        ("depends_on", Dir::Out) => 0.80,
        ("depends_on", _) => 0.60,
        ("contradicts", _) => 0.80,
        ("derived_from", Dir::Out) => 0.70,
        ("derived_from", _) => 0.50,
        ("duplicates", _) => 0.40,
        ("supersedes", Dir::Out) => 0.70,
        // X supersedes the seed: the seed may be obsolete, so the replacer is the most important neighbour.
        ("supersedes", _) => 0.90,
        _ => 0.0,
    }
}

/// M04A intent multipliers, stacked by product and clamped. Applied only for intents that are ON.
pub fn intent_multiplier(kind: &str, dir: Dir, intent: &IntentWeights) -> f64 {
    let mut m: f64 = 1.0;
    if intent.dependency >= INTENT_ON {
        m *= match (kind, dir) {
            ("depends_on", Dir::Out) => 1.5,
            ("depends_on", _) => 1.2,
            _ => 0.7,
        };
    }
    if intent.contradiction >= INTENT_ON && kind == "contradicts" {
        m *= 1.6;
    }
    if intent.decision >= INTENT_ON && matches!(kind, "derived_from" | "extends" | "depends_on") {
        m *= 1.2;
    }
    if intent.evolution >= INTENT_ON && matches!(kind, "supersedes" | "derived_from" | "extends") {
        m *= 1.3;
    }
    if intent.provenance >= INTENT_ON && kind == "derived_from" && dir == Dir::Out {
        m *= 1.4;
    }
    if intent.task >= INTENT_ON {
        if kind == "depends_on" && dir == Dir::In {
            m *= 1.3;
        }
        if kind == "derived_from" && dir == Dir::In {
            m *= 1.2;
        }
    }
    m.clamp(MULTIPLIER_MIN, MULTIPLIER_MAX)
}

/// Whether a 2nd hop along `kind` is allowed for this question.
pub fn second_hop_allowed(kind: &str, intent: &IntentWeights) -> bool {
    (kind == "depends_on" && intent.dependency >= INTENT_ON)
        || (kind == "supersedes" && intent.evolution >= INTENT_ON)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Seed {
    pub object_id: String,
    /// The retrieval hybrid score, capped at 1.
    pub hybrid: f64,
}

/// The far end of an edge, with its project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Far {
    pub object: CurrentObject,
    pub project_name: String,
    pub archived: bool,
    /// Carried through so a graph-added entry can be given provenance without another read.
    pub current_origin: String,
    pub current_source: Option<(String, i64, i64)>,
    pub original_source: Option<(String, i64, i64)>,
    pub revision_count: i64,
}

/// One edge of an evidence path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathEdge {
    pub from_object_id: String,
    pub to_object_id: String,
    pub relation_id: String,
    pub relation_kind: String,
    /// Relative to `from_object_id`.
    pub direction: Dir,
    pub distance: u8,
    pub external_project: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Admission {
    pub object_id: String,
    pub score: f64,
    pub base_weight: f64,
    pub intent_multiplier: f64,
    /// 1 edge for one hop, 2 for the permitted second hop.
    pub path: Vec<PathEdge>,
    /// Other relations that also reach this object from a seed (at most 3).
    pub also_via: Vec<PathEdge>,
    /// The intent multiplier raised the weight: the relation is what the question is about.
    pub intent_relevant: bool,
    pub external_project: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Omissions {
    /// External objects that qualified but were over the cap of 3.
    pub external_over_cap: usize,
    /// Neighbours in archived projects (other than the scope) that were refused.
    pub archived_external: usize,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct FirstHop {
    pub admitted: Vec<Admission>,
    /// `duplicates` neighbours collapsed into an alias note instead of becoming evidence: (the seed, the duplicate object).
    pub aliases: Vec<(String, String)>,
    /// Relations between two RETRIEVED objects (graph support for both): attached to each end, as seen from the other end.
    pub links: Vec<(String, PathEdge)>,
    pub omissions: Omissions,
}

pub struct Context<'a> {
    pub scope_project: &'a str,
    pub intent: &'a IntentWeights,
}

struct Candidate {
    far_id: String,
    seed_index: usize,
    seed_id: String,
    relation: RelationRow,
    dir: Dir,
    base: f64,
    multiplier: f64,
    score: f64,
}

fn edge(
    from: &str,
    to: &str,
    relation: &RelationRow,
    dir: Dir,
    distance: u8,
    external: bool,
) -> PathEdge {
    PathEdge {
        from_object_id: from.to_string(),
        to_object_id: to.to_string(),
        relation_id: relation.id.clone(),
        relation_kind: relation.kind.clone(),
        direction: dir,
        distance,
        external_project: external,
    }
}

/// The first hop from the expanding seeds. `details` must cover the far ends of `relations`; ends missing from it are dangling and skipped.
pub fn first_hop(
    ctx: &Context<'_>,
    seeds: &[Seed],
    relations: &[RelationRow],
    details: &HashMap<String, Far>,
    retrieved: &HashSet<String>,
) -> FirstHop {
    let mut out = FirstHop::default();
    let weakest = seeds.iter().map(|s| s.hybrid).fold(f64::MAX, f64::min);
    let floor = if seeds.is_empty() {
        0.0
    } else {
        FLOOR_FRACTION * weakest
    };

    let mut candidates: Vec<Candidate> = Vec::new();
    for (seed_index, seed) in seeds.iter().enumerate() {
        for relation in relations {
            if relation.source_object_id != seed.object_id
                && relation.target_object_id != seed.object_id
            {
                continue;
            }
            let far_id = if relation.source_object_id == seed.object_id {
                &relation.target_object_id
            } else {
                &relation.source_object_id
            };
            let dir = direction_from(&seed.object_id, relation);
            // Relations between two retrieved objects are graph SUPPORT for both, not new evidence.
            if retrieved.contains(far_id) {
                out.links.push((
                    far_id.clone(),
                    edge(&seed.object_id, far_id, relation, dir, 1, false),
                ));
                // ...and the seed end of the same relation, seen from the far (retrieved) end (deduplicated below).
                out.links.push((
                    seed.object_id.clone(),
                    edge(
                        far_id,
                        &seed.object_id,
                        relation,
                        direction_from(far_id, relation),
                        1,
                        false,
                    ),
                ));
                if relation.kind == "duplicates" {
                    out.aliases.push((seed.object_id.clone(), far_id.clone()));
                }
                continue;
            }
            let base = base_weight(&relation.kind, dir);
            let multiplier = intent_multiplier(&relation.kind, dir, ctx.intent);
            candidates.push(Candidate {
                far_id: far_id.clone(),
                seed_index,
                seed_id: seed.object_id.clone(),
                relation: relation.clone(),
                dir,
                base,
                multiplier,
                score: seed.hybrid * base * multiplier * HOP_DECAY,
            });
        }
    }
    let mut seen_links = HashSet::new();
    out.links.retain(|(object, e)| {
        seen_links.insert((
            object.clone(),
            e.relation_id.clone(),
            e.from_object_id.clone(),
        ))
    });
    candidates.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.relation.created_at.cmp(&b.relation.created_at))
            .then_with(|| a.relation.id.cmp(&b.relation.id))
            .then_with(|| a.far_id.cmp(&b.far_id))
    });

    let mut per_seed: HashMap<usize, usize> = HashMap::new();
    let mut per_seed_kind: HashMap<(usize, String), usize> = HashMap::new();
    let mut external = 0usize;
    for candidate in candidates {
        let Some(far) = details.get(&candidate.far_id) else {
            continue;
        };
        let external_project = far.object.project_id != ctx.scope_project;
        if external_project && far.archived {
            out.omissions.archived_external += 1;
            continue;
        }
        if candidate.relation.kind == "duplicates" {
            // Reduce redundancy: note the alias on the seed, spend no context on a second copy of the same thought.
            out.aliases
                .push((candidate.seed_id.clone(), candidate.far_id.clone()));
            continue;
        }
        if candidate.score < floor {
            continue;
        }
        let path_edge = edge(
            &candidate.seed_id,
            &candidate.far_id,
            &candidate.relation,
            candidate.dir,
            1,
            external_project,
        );
        if let Some(existing) = out
            .admitted
            .iter_mut()
            .find(|a| a.object_id == candidate.far_id)
        {
            if existing.also_via.len() < 3 {
                existing.also_via.push(path_edge);
            }
            continue;
        }
        if out.admitted.iter().filter(|a| !a.external_project).count() >= MAX_GRAPH_OBJECTS
            && !external_project
        {
            continue;
        }
        if *per_seed.get(&candidate.seed_index).unwrap_or(&0) >= MAX_PER_SEED
            || *per_seed_kind
                .get(&(candidate.seed_index, candidate.relation.kind.clone()))
                .unwrap_or(&0)
                >= MAX_PER_SEED_KIND
        {
            continue;
        }
        if external_project {
            if external >= MAX_EXTERNAL {
                out.omissions.external_over_cap += 1;
                continue;
            }
            external += 1;
        }
        *per_seed.entry(candidate.seed_index).or_insert(0) += 1;
        *per_seed_kind
            .entry((candidate.seed_index, candidate.relation.kind.clone()))
            .or_insert(0) += 1;
        out.admitted.push(Admission {
            object_id: candidate.far_id,
            score: candidate.score,
            base_weight: candidate.base,
            intent_multiplier: candidate.multiplier,
            path: vec![path_edge],
            also_via: Vec::new(),
            intent_relevant: candidate.multiplier > 1.0,
            external_project,
        });
    }
    out
}

/// The in-scope first-hop admissions that may seed a second hop: reached by `depends_on` / `supersedes`, and only when the question asks.
pub fn frontier<'a>(ctx: &Context<'_>, first: &'a [Admission]) -> Vec<&'a Admission> {
    first
        .iter()
        .filter(|a| {
            !a.external_project
                && a.path.len() == 1
                && second_hop_allowed(&a.path[0].relation_kind, ctx.intent)
                && a.intent_relevant
        })
        .collect()
}

/// The narrowly allowed second hop: from each frontier object, ONE more edge of the SAME kind in the SAME direction. Far ends must be in
/// scope and not already present; at most `MAX_SECOND_HOP` in total. Both path edges are kept.
pub fn second_hop(
    ctx: &Context<'_>,
    frontier: &[&Admission],
    relations: &[RelationRow],
    details: &HashMap<String, Far>,
    present: &HashSet<String>,
) -> Vec<Admission> {
    let mut candidates: Vec<Admission> = Vec::new();
    for front in frontier {
        let first_edge = &front.path[0];
        for relation in relations
            .iter()
            .filter(|r| r.kind == first_edge.relation_kind && r.id != first_edge.relation_id)
        {
            let dir = direction_from(&front.object_id, relation);
            if dir != first_edge.direction {
                continue;
            }
            let far_id = if relation.source_object_id == front.object_id {
                &relation.target_object_id
            } else {
                &relation.source_object_id
            };
            if far_id == &front.object_id || present.contains(far_id) {
                continue;
            }
            let Some(far) = details.get(far_id) else {
                continue;
            };
            if far.object.project_id != ctx.scope_project
                || (far.archived && far.object.project_id != ctx.scope_project)
            {
                continue;
            }
            let base = base_weight(&relation.kind, dir);
            let multiplier = intent_multiplier(&relation.kind, dir, ctx.intent);
            candidates.push(Admission {
                object_id: far_id.clone(),
                score: front.score * base * multiplier * HOP_DECAY,
                base_weight: base,
                intent_multiplier: multiplier,
                path: vec![
                    first_edge.clone(),
                    edge(&front.object_id, far_id, relation, dir, 2, false),
                ],
                also_via: Vec::new(),
                intent_relevant: multiplier > 1.0,
                external_project: false,
            });
        }
    }
    candidates.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.path[1].relation_id.cmp(&b.path[1].relation_id))
            .then_with(|| a.object_id.cmp(&b.object_id))
    });
    let mut seen = HashSet::new();
    candidates.retain(|c| seen.insert(c.object_id.clone()));
    candidates.truncate(MAX_SECOND_HOP);
    candidates
}

/// What the relations among the objects PRESENT in the package say about them, used to label evidence.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Marks {
    /// object -> the objects that supersede it (it is no longer the current position).
    pub superseded_by: HashMap<String, Vec<String>>,
    /// object -> the objects it supersedes.
    pub supersedes: HashMap<String, Vec<String>>,
    /// object -> the objects that explicitly contradict it.
    pub conflicts_with: HashMap<String, Vec<String>>,
    /// object -> duplicates of it (collapsed, no separate evidence).
    pub aliases: HashMap<String, Vec<String>>,
}

pub fn marks(
    present: &HashSet<String>,
    relations: &[RelationRow],
    aliases: &[(String, String)],
) -> Marks {
    let mut out = Marks::default();
    for relation in relations {
        let (s, t) = (&relation.source_object_id, &relation.target_object_id);
        if !present.contains(s) || !present.contains(t) {
            continue;
        }
        match relation.kind.as_str() {
            "supersedes" => {
                out.superseded_by
                    .entry(t.clone())
                    .or_default()
                    .push(s.clone());
                out.supersedes.entry(s.clone()).or_default().push(t.clone());
            }
            "contradicts" => {
                out.conflicts_with
                    .entry(s.clone())
                    .or_default()
                    .push(t.clone());
                out.conflicts_with
                    .entry(t.clone())
                    .or_default()
                    .push(s.clone());
            }
            _ => {}
        }
    }
    for (seed, alias) in aliases {
        let list = out.aliases.entry(seed.clone()).or_default();
        if !list.contains(alias) {
            list.push(alias.clone());
        }
    }
    for list in out
        .superseded_by
        .values_mut()
        .chain(out.supersedes.values_mut())
        .chain(out.conflicts_with.values_mut())
        .chain(out.aliases.values_mut())
    {
        list.sort();
        list.dedup();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recall::query::interpret;

    fn object(id: &str, project: &str) -> CurrentObject {
        CurrentObject {
            object_id: id.into(),
            project_id: project.into(),
            kind: "idea".into(),
            title: id.into(),
            body: "b".into(),
            current_revision_id: format!("{id}-r"),
            updated_at: "2026-01-01T00:00:00Z".into(),
            seq: 1,
        }
    }

    fn far(id: &str, project: &str, archived: bool) -> (String, Far) {
        (
            id.to_string(),
            Far {
                object: object(id, project),
                project_name: project.to_string(),
                archived,
                current_origin: "initial".into(),
                current_source: None,
                original_source: None,
                revision_count: 1,
            },
        )
    }

    fn rel(id: &str, kind: &str, source: &str, target: &str, at: &str) -> RelationRow {
        RelationRow {
            id: id.into(),
            kind: kind.into(),
            source_object_id: source.into(),
            target_object_id: target.into(),
            origin: "user".into(),
            created_at: at.into(),
        }
    }

    fn seed(id: &str, hybrid: f64) -> Seed {
        Seed {
            object_id: id.into(),
            hybrid,
        }
    }

    fn run(
        intent: &str,
        seeds: &[Seed],
        relations: &[RelationRow],
        details: Vec<(String, Far)>,
    ) -> FirstHop {
        let intent = interpret(intent).unwrap().intent;
        let details: HashMap<String, Far> = details.into_iter().collect();
        let retrieved: HashSet<String> = seeds.iter().map(|s| s.object_id.clone()).collect();
        first_hop(
            &Context {
                scope_project: "P",
                intent: &intent,
            },
            seeds,
            relations,
            &details,
            &retrieved,
        )
    }

    #[test]
    fn exact_base_weights_and_symmetric_kinds_have_no_direction() {
        let table = [
            ("related_to", Dir::Sym, 0.5),
            ("extends", Dir::Out, 0.7),
            ("extends", Dir::In, 0.6),
            ("depends_on", Dir::Out, 0.8),
            ("depends_on", Dir::In, 0.6),
            ("contradicts", Dir::Sym, 0.8),
            ("derived_from", Dir::Out, 0.7),
            ("derived_from", Dir::In, 0.5),
            ("duplicates", Dir::Sym, 0.4),
            ("supersedes", Dir::Out, 0.7),
            ("supersedes", Dir::In, 0.9),
        ];
        for (kind, dir, expected) in table {
            assert_eq!(base_weight(kind, dir), expected, "{kind} {dir:?}");
        }
        let r = rel("r", "contradicts", "a", "b", "t");
        assert_eq!(
            (direction_from("a", &r), direction_from("b", &r)),
            (Dir::Sym, Dir::Sym)
        );
        let d = rel("d", "depends_on", "a", "b", "t");
        assert_eq!(
            (direction_from("a", &d), direction_from("b", &d)),
            (Dir::Out, Dir::In)
        );
    }

    #[test]
    fn exact_intent_multipliers() {
        let w = |q: &str| interpret(q).unwrap().intent;
        assert_eq!(
            intent_multiplier("depends_on", Dir::Out, &w("what does X depend on")),
            1.5
        );
        assert_eq!(
            intent_multiplier("depends_on", Dir::In, &w("what does X depend on")),
            1.2
        );
        assert_eq!(
            intent_multiplier("related_to", Dir::Sym, &w("what does X depend on")),
            0.7
        );
        assert_eq!(
            intent_multiplier("contradicts", Dir::Sym, &w("what conflicts with X")),
            1.6
        );
        assert_eq!(
            intent_multiplier("supersedes", Dir::In, &w("how did X evolve")),
            1.3
        );
        assert_eq!(
            intent_multiplier("related_to", Dir::Sym, &w("tell me about X")),
            1.0,
            "no intent, no change"
        );
        // stacking is clamped
        let both = w("what does X depend on and how did it evolve and why did I decide");
        assert!(intent_multiplier("depends_on", Dir::Out, &both) <= MULTIPLIER_MAX);
    }

    #[test]
    fn the_intent_decides_which_neighbour_wins() {
        let relations = [
            rel("r1", "related_to", "s", "x", "t1"),
            rel("r2", "depends_on", "s", "y", "t2"),
            rel("r3", "contradicts", "s", "z", "t3"),
        ];
        let details = vec![
            far("x", "P", false),
            far("y", "P", false),
            far("z", "P", false),
        ];
        let order = |q: &str| {
            run(q, &[seed("s", 1.0)], &relations, details.clone())
                .admitted
                .iter()
                .map(|a| a.object_id.clone())
                .collect::<Vec<_>>()
        };
        // Scores: seed 1.0 x base x multiplier x 0.6, and anything under the floor 0.25 x weakest seed is not worth adding.
        assert_eq!(
            order("what does s depend on"),
            ["y", "z"],
            "depends_on 0.72 > contradicts 0.34; related_to 0.21 is under the floor"
        );
        assert_eq!(order("what conflicts with s"), ["z", "y", "x"], "contradicts 0.77 > depends_on 0.48 > related_to 0.30 (other kinds are not penalised for this intent)");
        assert_eq!(order("tell me about s"), ["y", "z", "x"], "default: depends_on 0.48 = contradicts 0.48 (the older relation first) > related_to 0.30");
    }

    #[test]
    fn caps_hold_per_seed_per_kind_and_overall() {
        let mut relations = Vec::new();
        let mut details = Vec::new();
        for i in 0..10 {
            relations.push(rel(
                &format!("r{i:02}"),
                "extends",
                "s",
                &format!("x{i:02}"),
                &format!("t{i:02}"),
            ));
            details.push(far(&format!("x{i:02}"), "P", false));
        }
        let hop = run("tell me about s", &[seed("s", 1.0)], &relations, details);
        assert_eq!(
            hop.admitted.len(),
            MAX_PER_SEED_KIND,
            "at most 2 per relation kind per seed"
        );
        // many kinds from one seed: at most 4 per seed
        let kinds = [
            "extends",
            "depends_on",
            "derived_from",
            "related_to",
            "supersedes",
        ];
        let relations: Vec<RelationRow> = kinds
            .iter()
            .flat_map(|k| {
                (0..2).map(move |i| {
                    rel(
                        &format!("{k}{i}"),
                        k,
                        "s",
                        &format!("{k}-{i}"),
                        &format!("t{k}{i}"),
                    )
                })
            })
            .collect();
        let details: Vec<(String, Far)> = kinds
            .iter()
            .flat_map(|k| (0..2).map(move |i| far(&format!("{k}-{i}"), "P", false)))
            .collect();
        assert_eq!(
            run("tell me about s", &[seed("s", 1.0)], &relations, details)
                .admitted
                .len(),
            MAX_PER_SEED
        );
    }

    #[test]
    fn the_global_cap_is_twelve_and_cycles_do_not_loop() {
        let seeds: Vec<Seed> = (0..5).map(|i| seed(&format!("s{i}"), 1.0)).collect();
        let mut relations = Vec::new();
        let mut details = Vec::new();
        for (i, s) in seeds.iter().enumerate() {
            for j in 0..4 {
                let far_id = format!("x{i}{j}");
                relations.push(rel(
                    &format!("r{i}{j}"),
                    ["extends", "depends_on", "derived_from", "related_to"][j],
                    &s.object_id,
                    &far_id,
                    &format!("t{i}{j}"),
                ));
                details.push(far(&far_id, "P", false));
            }
        }
        // a cycle among the seeds themselves adds support links, never admissions
        relations.push(rel("c1", "related_to", "s0", "s1", "tc1"));
        relations.push(rel("c2", "depends_on", "s1", "s0", "tc2"));
        let hop = run("tell me about it", &seeds, &relations, details);
        assert_eq!(hop.admitted.len(), MAX_GRAPH_OBJECTS);
        assert!(hop.admitted.iter().all(|a| !a.object_id.starts_with('s')));
        assert!(!hop.links.is_empty());
    }

    #[test]
    fn external_objects_follow_the_closed_rule() {
        let relations = [
            rel("r1", "depends_on", "s", "e1", "t1"),
            rel("r2", "depends_on", "s", "e2", "t2"),
            rel("r3", "extends", "s", "e3", "t3"),
            rel("r4", "related_to", "s", "e4", "t4"),
            rel("r5", "extends", "s", "arch", "t5"),
            rel("r6", "related_to", "s", "x", "t6"),
        ];
        let details = vec![
            far("e1", "Q", false),
            far("e2", "Q", false),
            far("e3", "R", false),
            far("e4", "S", false),
            far("arch", "OLD", true),
            far("x", "P", false),
        ];
        let hop = run("tell me about s", &[seed("s", 1.0)], &relations, details);
        let external: Vec<&str> = hop
            .admitted
            .iter()
            .filter(|a| a.external_project)
            .map(|a| a.object_id.as_str())
            .collect();
        assert!(external.len() <= MAX_EXTERNAL, "{external:?}");
        assert!(
            !hop.admitted.iter().any(|a| a.object_id == "arch"),
            "an archived project's object never enters, from any scope"
        );
        assert_eq!(hop.omissions.archived_external, 1);
        assert!(
            hop.admitted
                .iter()
                .filter(|a| a.external_project)
                .all(|a| a.path.len() == 1 && a.path[0].external_project),
            "one hop, labelled"
        );
        // a relation between two retrieved objects is support, not admission
        let hop = run(
            "tell me about s",
            &[seed("s", 1.0), seed("t", 0.9)],
            &[rel("r", "extends", "s", "t", "t0")],
            vec![],
        );
        assert!(hop.admitted.is_empty() && hop.links.len() == 2);
    }

    #[test]
    fn duplicates_collapse_into_an_alias_instead_of_a_second_copy() {
        let hop = run(
            "tell me about s",
            &[seed("s", 1.0)],
            &[rel("r", "duplicates", "s", "dup", "t")],
            vec![far("dup", "P", false)],
        );
        assert!(hop.admitted.is_empty());
        assert_eq!(hop.aliases, [("s".to_string(), "dup".to_string())]);
    }

    #[test]
    fn the_second_hop_follows_one_kind_in_one_direction_only_when_the_question_asks() {
        let intent = interpret("what does s depend on").unwrap().intent;
        let ctx = Context {
            scope_project: "P",
            intent: &intent,
        };
        let first = [Admission {
            object_id: "y".into(),
            score: 0.5,
            base_weight: 0.8,
            intent_multiplier: 1.5,
            path: vec![PathEdge {
                from_object_id: "s".into(),
                to_object_id: "y".into(),
                relation_id: "r1".into(),
                relation_kind: "depends_on".into(),
                direction: Dir::Out,
                distance: 1,
                external_project: false,
            }],
            also_via: vec![],
            intent_relevant: true,
            external_project: false,
        }];
        let front = frontier(&ctx, &first);
        assert_eq!(front.len(), 1);
        let relations = [
            rel("r2", "depends_on", "y", "z", "t2"),
            rel("r3", "related_to", "y", "w", "t3"),
            rel("r4", "depends_on", "v", "y", "t4"),
            rel("r1", "depends_on", "s", "y", "t1"),
        ];
        let details: HashMap<String, Far> = vec![
            far("z", "P", false),
            far("w", "P", false),
            far("v", "P", false),
        ]
        .into_iter()
        .collect();
        let present: HashSet<String> = ["s", "y"].iter().map(|s| s.to_string()).collect();
        let hop2 = second_hop(&ctx, &front, &relations, &details, &present);
        assert_eq!(
            hop2.iter()
                .map(|a| a.object_id.as_str())
                .collect::<Vec<_>>(),
            ["z"],
            "same kind, same direction only"
        );
        assert_eq!(hop2[0].path.len(), 2, "both edges are kept");
        assert_eq!(
            (
                hop2[0].path[0].relation_id.as_str(),
                hop2[0].path[1].relation_id.as_str(),
                hop2[0].path[1].distance
            ),
            ("r1", "r2", 2)
        );
        // another question: no second hop at all
        let plain = interpret("tell me about s").unwrap().intent;
        assert!(frontier(
            &Context {
                scope_project: "P",
                intent: &plain
            },
            &first
        )
        .is_empty());
        // supersedes needs the evolution intent, not the dependency one
        assert!(
            !second_hop_allowed("supersedes", &intent)
                && second_hop_allowed(
                    "supersedes",
                    &interpret("how did it evolve").unwrap().intent
                )
        );
    }

    #[test]
    fn marks_label_supersession_and_contradiction() {
        let present: HashSet<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        let relations = [
            rel("r1", "supersedes", "b", "a", "t"),
            rel("r2", "contradicts", "a", "c", "t"),
            rel("r3", "supersedes", "z", "a", "t"),
        ];
        let m = marks(&present, &relations, &[("a".into(), "dup".into())]);
        assert_eq!(m.superseded_by["a"], ["b"], "only present objects count");
        assert_eq!(m.supersedes["b"], ["a"]);
        assert_eq!(
            (m.conflicts_with["a"].clone(), m.conflicts_with["c"].clone()),
            (vec!["c".to_string()], vec!["a".to_string()])
        );
        assert_eq!(m.aliases["a"], ["dup"]);
    }
}
