//! EvidencePackage v1: the deterministic intermediate representation between retrieval and synthesis.
//!
//! ```text
//! RetrievalResult (M04B seeds)
//!     -> object details (one read)
//!     -> evidence strength (pure)
//!     -> Graph enrichment (<= 4 reads, pure admission)      graph.rs
//!     -> Lineage enrichment (1 read, pure selection)        lineage.rs
//!     -> provenance (1 batched Capture read)
//!     -> EvidencePackage { entries (E1..), sufficiency }
//! ```
//!
//! No model is involved and no prose is generated. The package is plain data: the same store, query and retrieval result give the same
//! package, byte for byte. Current text and historical text never share a field: an entry's `currentBody` is the object's current
//! revision; old revisions live only in `lineage.entries[]`, each tagged `historical` or `branch_not_current`.

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use serde::Serialize;

use super::evidence::{HybridEvidence, LexicalEvidence, MatchedHistorical, RecallError, RetrievalEvidence, RetrievalResult, SemanticEvidence};
use super::graph::{self, Dir, Far, PathEdge, Seed};
use super::revisions::{self as lineage, Mode, Pick};
use super::query::IntentWeights;
use crate::storage::capture_store::{Capture, CaptureStore, StoreError};
use crate::storage::recall_store::{ObjectDetail, RelationRow, RevisionRow};

/// Characters of one historical revision shown (evolution questions get the longer form).
pub const HISTORY_CHARS: usize = 300;
pub const HISTORY_CHARS_EVOLUTION: usize = 400;
/// Provenance excerpts: how many entries get one, and how long.
pub const MAX_EXCERPTS: usize = 6;
pub const MAX_EXCERPTS_PROVENANCE: usize = 8;
pub const EXCERPT_CHARS: usize = 300;
pub const EXCERPT_CHARS_PROVENANCE: usize = 500;
/// How many retrieved entries get lineage enrichment.
pub const LINEAGE_OBJECTS_EVOLUTION: usize = 4;
pub const LINEAGE_OBJECTS_WHY: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnrichmentConfig {
    pub graph: bool,
    pub lineage: bool,
}

impl Default for EnrichmentConfig {
    fn default() -> Self {
        Self { graph: true, lineage: true }
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Evidence strength: an inspectable, additive, deterministic model. Candidate similarity is NOT sufficient evidence.
// ---------------------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrengthSignal {
    pub name: &'static str,
    pub points: u32,
}

/// Points: `lexical` 2, `lexicalMajorityCoverage` +1 (>= 2/3 of the query's terms), `titlePhrase` +1, `semantic` 1, `semanticStrong` +1
/// (cosine >= 0.50), `channelAgreement` +1 (found by BOTH lexical and semantic), `historicalDiscovery` 1 (+1 majority coverage, +1 when the
/// question is about history), `graphSupport` +1 (linked to a sufficient seed), `intentRelation` +1 (the relation is what the question asks
/// about). `provenanceAvailable` is listed with 0 points: every object has an origin, so it cannot tell evidence apart.
///
/// Levels: `strong` >= 4, `sufficient` == 3, `supporting` (a graph-admitted entry with any points), `weak` otherwise.
/// An entry that was RETRIEVED can answer a question on its own only if it is `strong` or `sufficient`. A semantic candidate admitted at the
/// 0.40 cosine floor (1 point) is `weak` until something else supports it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceStrength {
    pub points: u32,
    pub level: &'static str,
    /// Retrieved and `strong`/`sufficient`: enough on its own to justify an answer.
    pub sufficient: bool,
    pub signals: Vec<StrengthSignal>,
}

pub const SUFFICIENT_POINTS: u32 = 3;
pub const STRONG_POINTS: u32 = 4;
pub const STRONG_COSINE: f32 = 0.50;
pub const MAJORITY_COVERAGE: f64 = 2.0 / 3.0;

fn finish(signals: Vec<StrengthSignal>, retrieved: bool, has_graph: bool) -> EvidenceStrength {
    let points: u32 = signals.iter().map(|s| s.points).sum();
    let level = if retrieved && points >= STRONG_POINTS {
        "strong"
    } else if retrieved && points >= SUFFICIENT_POINTS {
        "sufficient"
    } else if has_graph && points >= 1 {
        "supporting"
    } else {
        "weak"
    };
    EvidenceStrength { points, level, sufficient: retrieved && points >= SUFFICIENT_POINTS, signals }
}

fn signal(signals: &mut Vec<StrengthSignal>, name: &'static str, points: u32) {
    signals.push(StrengthSignal { name, points });
}

/// Strength of a RETRIEVED entry from its retrieval signals alone (before any graph support).
pub fn retrieval_signals(entry: &RetrievalEvidence, intent: &IntentWeights) -> Vec<StrengthSignal> {
    let mut signals = Vec::new();
    if let Some(lexical) = &entry.lexical {
        signal(&mut signals, "lexical", 2);
        if lexical.coverage >= MAJORITY_COVERAGE - 1e-9 {
            signal(&mut signals, "lexicalMajorityCoverage", 1);
        }
    }
    if entry.hybrid.bonus > 0.0 {
        signal(&mut signals, "titlePhrase", 1);
    }
    if let Some(semantic) = &entry.semantic {
        signal(&mut signals, "semantic", 1);
        if semantic.cosine >= STRONG_COSINE {
            signal(&mut signals, "semanticStrong", 1);
        }
    }
    if entry.lexical.is_some() && entry.semantic.is_some() {
        signal(&mut signals, "channelAgreement", 1);
    }
    if entry.discovery == "historicalDiscovery" {
        signal(&mut signals, "historicalDiscovery", 1);
        if entry.matched_historical.as_ref().is_some_and(|h| h.coverage >= MAJORITY_COVERAGE - 1e-9) {
            signal(&mut signals, "historicalMajorityCoverage", 1);
        }
        if intent.evolution >= graph::INTENT_ON {
            signal(&mut signals, "historyIntent", 1);
        }
    }
    signals
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The package
// ---------------------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalSignals {
    pub rank: usize,
    pub is_seed: bool,
    pub lexical: Option<LexicalEvidence>,
    pub semantic: Option<SemanticEvidence>,
    pub hybrid: HybridEvidence,
    /// `current` or `historicalDiscovery`.
    pub discovery: &'static str,
    pub matched_historical: Option<MatchedHistorical>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPathView {
    pub from_object_id: String,
    pub from_handle: String,
    pub to_object_id: String,
    pub relation_id: String,
    pub relation_kind: String,
    /// `out` (the `from` object is the stored source), `in` (it is the target) or `sym`.
    pub direction: &'static str,
    pub distance: u8,
    pub external_project: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasView {
    pub object_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEvidence {
    /// `expanded` (added by the graph) or `supported` (retrieved, and linked to another retrieved entry).
    pub role: &'static str,
    /// The expansion score (expanded entries only) and its parts.
    pub score: Option<f64>,
    pub base_weight: Option<f64>,
    pub intent_multiplier: Option<f64>,
    pub intent_relevant: bool,
    /// How it got in, first path first (a second hop has two edges).
    pub paths: Vec<GraphPathView>,
    /// Another entry replaces this one: this is NOT the current position.
    pub superseded_by: Vec<String>,
    /// This entry replaces these.
    pub supersedes: Vec<String>,
    /// Explicitly contradicted by these (handles).
    pub conflicts_with: Vec<String>,
    pub contradictory: bool,
    /// `duplicates` neighbours collapsed into this entry (no second copy of the text).
    pub aliases: Vec<AliasView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    pub capture_id: String,
    pub capture_project_id: String,
    /// `text`, `voice` or `emg`.
    pub capture_source: String,
    pub capture_created_at: String,
    pub span_start: i64,
    pub span_end: i64,
    pub excerpt: Option<String>,
    pub excerpt_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceEvidence {
    /// Where the OBJECT originally came from.
    pub origin: Option<SourceRef>,
    /// Present only when the CURRENT revision itself was interpreted from a Capture span (never for an edit or a merge).
    pub current_revision_source: Option<SourceRef>,
    /// The current text came from a user edit, a merge or the system, so it is not supported by the Capture span.
    pub edited_since_capture: bool,
    /// How the current revision was made: `initial`, `user_edit`, `distillation`, `merge`, `system`.
    pub current_revision_origin: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub handle: String,
    pub revision_id: String,
    /// `historical` or `branch_not_current`. Never `current`.
    pub status: &'static str,
    pub origin: String,
    pub created_at: String,
    pub title: String,
    pub body: String,
    pub truncated: bool,
    pub marks: Vec<&'static str>,
    pub leads_to_current: bool,
    pub source: Option<SourceRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineageEvidence {
    pub revision_count: i64,
    pub entries: Vec<HistoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CognitiveEvidence {
    /// `E1`, `E2`... stable inside one result; the only identifier a model ever sees.
    pub handle: String,
    /// `primary` (retrieved) or `graph` (added by graph expansion).
    pub role: &'static str,
    pub object_id: String,
    pub project_id: String,
    pub project_name: String,
    /// The object belongs to another Project than the one asked about.
    pub external_project: bool,
    pub kind: String,
    pub title: String,
    /// The CURRENT revision's body.
    pub current_body: String,
    pub current_revision_id: String,
    /// `current`, or `superseded` when another present entry replaces this object (it is then not the current position).
    pub status: &'static str,
    pub retrieval: Option<RetrievalSignals>,
    pub strength: EvidenceStrength,
    pub graph: Option<GraphEvidence>,
    pub lineage: Option<LineageEvidence>,
    pub provenance: Option<ProvenanceEvidence>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EnrichmentStats {
    pub graph_ran: bool,
    pub graph_seeds: usize,
    pub relations_read: usize,
    pub graph_admitted: usize,
    pub graph_second_hop: usize,
    pub graph_external: usize,
    pub graph_external_over_cap: usize,
    pub graph_archived_external_refused: usize,
    pub lineage_ran: bool,
    pub lineage_objects: usize,
    pub lineage_entries: usize,
    pub captures_read: usize,
    pub excerpts: usize,
    /// Store calls made by enrichment (each one is one batched statement or two for revisions); never one per object.
    pub sql_reads: u32,
    pub graph_ms: f64,
    pub lineage_ms: f64,
    pub provenance_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidencePackage {
    pub entries: Vec<CognitiveEvidence>,
    /// At least one RETRIEVED entry is strong or sufficient on its own.
    pub sufficient: bool,
    /// Why not (`noEvidence`, `noSufficientEvidence`) when `sufficient` is false.
    pub insufficiency: Option<&'static str>,
    pub intent: IntentWeights,
    pub stats: EnrichmentStats,
}

fn storage(error: StoreError) -> RecallError {
    RecallError::Storage(error.to_string())
}

fn code_points(text: &str, start: i64, end: i64) -> Option<String> {
    if start < 0 || end <= start {
        return None;
    }
    let total = text.chars().count() as i64;
    if end > total {
        return None;
    }
    Some(text.chars().skip(start as usize).take((end - start) as usize).collect())
}

fn clip(text: &str, limit: usize) -> (String, bool) {
    if text.chars().count() <= limit {
        (text.to_string(), false)
    } else {
        (text.chars().take(limit).collect(), true)
    }
}

struct Draft {
    role: &'static str,
    detail: ObjectDetail,
    retrieval: Option<RetrievalSignals>,
    signals: Vec<StrengthSignal>,
    links: Vec<PathEdge>,
    admission: Option<graph::Admission>,
    picks: Vec<(Pick, RevisionRow)>,
}

/// Builds the package from a retrieval result. Every read is batched: the number of store calls does not depend on how many entries
/// there are (object details, relations, far-end details, revisions, captures: a handful in total).
pub fn build_package(store: &CaptureStore, retrieval: &RetrievalResult, config: &EnrichmentConfig) -> Result<EvidencePackage, RecallError> {
    let intent = retrieval.diagnostics.intent;
    let scope = retrieval.scope.project_id.as_str();
    let mut stats = EnrichmentStats::default();
    let primary: Vec<&RetrievalEvidence> = retrieval.evidence.iter().filter(|e| e.is_seed).collect();
    if primary.is_empty() {
        return Ok(EvidencePackage { entries: Vec::new(), sufficient: false, insufficiency: Some("noEvidence"), intent, stats });
    }

    // 1. details of the retrieved entries (one read)
    let ids: Vec<String> = primary.iter().map(|e| e.object_id.clone()).collect();
    let mut details: HashMap<String, ObjectDetail> = store.recall_object_details(&ids).map_err(storage)?.into_iter().map(|d| (d.object.object_id.clone(), d)).collect();
    stats.sql_reads += 1;

    // 2. strength of retrieved entries from retrieval signals alone
    let retrieved_ids: HashSet<String> = ids.iter().cloned().collect();
    let mut drafts: Vec<Draft> = Vec::new();
    for entry in &primary {
        // An entry whose object vanished between retrieval and enrichment is dropped (nothing is invented).
        let Some(detail) = details.remove(&entry.object_id) else { continue };
        drafts.push(Draft {
            role: "primary",
            signals: retrieval_signals(entry, &intent),
            retrieval: Some(RetrievalSignals { rank: entry.rank, is_seed: entry.is_seed, lexical: entry.lexical.clone(), semantic: entry.semantic.clone(), hybrid: entry.hybrid.clone(), discovery: entry.discovery, matched_historical: entry.matched_historical.clone() }),
            detail,
            links: Vec::new(),
            admission: None,
            picks: Vec::new(),
        });
    }
    let pre: HashMap<String, EvidenceStrength> = drafts.iter().map(|d| (d.detail.object.object_id.clone(), finish(d.signals.clone(), true, false))).collect();

    // 3. Graph enrichment
    let mut all_relations: Vec<RelationRow> = Vec::new();
    let mut aliases: Vec<(String, String)> = Vec::new();
    let mut far_details: HashMap<String, Far> = HashMap::new();
    let mut admitted: Vec<graph::Admission> = Vec::new();
    let mut sufficient_seeds: HashSet<String> = HashSet::new();
    if config.graph {
        let started = Instant::now();
        let ctx = graph::Context { scope_project: scope, intent: &intent };
        let seeds: Vec<Seed> = primary
            .iter()
            .filter(|e| pre.get(&e.object_id).is_some_and(|s| s.sufficient))
            .take(graph::EXPANDING_SEEDS)
            .map(|e| Seed { object_id: e.object_id.clone(), hybrid: e.hybrid.score.min(1.0) })
            .collect();
        stats.graph_seeds = seeds.len();
        sufficient_seeds = seeds.iter().map(|s| s.object_id.clone()).collect();
        if !seeds.is_empty() {
            stats.graph_ran = true;
            let seed_ids: Vec<String> = seeds.iter().map(|s| s.object_id.clone()).collect();
            let relations = store.recall_relations_touching(&seed_ids).map_err(storage)?;
            stats.sql_reads += 1;
            stats.relations_read += relations.len();
            far_details = read_far(store, &relations, &retrieved_ids, &mut stats)?;
            let hop = graph::first_hop(&ctx, &seeds, &relations, &far_details, &retrieved_ids);
            stats.graph_external = hop.admitted.iter().filter(|a| a.external_project).count();
            stats.graph_external_over_cap = hop.omissions.external_over_cap;
            stats.graph_archived_external_refused = hop.omissions.archived_external;
            // A duplicate that was itself retrieved is already an entry; only NON-retrieved duplicates become alias notes.
            aliases = hop.aliases.iter().filter(|(_, alias)| !retrieved_ids.contains(alias)).cloned().collect();
            admitted = hop.admitted.clone();
            all_relations.extend(relations);
            for (object, edge) in &hop.links {
                if let Some(draft) = drafts.iter_mut().find(|d| &d.detail.object.object_id == object) {
                    draft.links.push(edge.clone());
                }
            }
            // The narrowly allowed second hop.
            let frontier_ids: Vec<String> = graph::frontier(&ctx, &hop.admitted).iter().map(|a| a.object_id.clone()).collect();
            if !frontier_ids.is_empty() {
                let relations2 = store.recall_relations_touching(&frontier_ids).map_err(storage)?;
                stats.sql_reads += 1;
                stats.relations_read += relations2.len();
                let present: HashSet<String> = retrieved_ids.iter().cloned().chain(hop.admitted.iter().map(|a| a.object_id.clone())).collect();
                let mut known = present.clone();
                known.extend(far_details.keys().cloned());
                let more = read_far_missing(store, &relations2, &known, &mut far_details, &mut stats)?;
                let frontier_refs = graph::frontier(&ctx, &hop.admitted);
                let second = graph::second_hop(&ctx, &frontier_refs, &relations2, &far_details, &present);
                let _ = more;
                stats.graph_second_hop = second.len();
                admitted.extend(second);
                all_relations.extend(relations2);
            }
            stats.graph_admitted = admitted.len();
        }
        stats.graph_ms = started.elapsed().as_secs_f64() * 1000.0;
    }

    // graph-added drafts
    admitted.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.object_id.cmp(&b.object_id)));
    for admission in &admitted {
        let Some(far) = far_details.get(&admission.object_id) else { continue };
        let mut signals = Vec::new();
        signal(&mut signals, "graphSupport", 1);
        if admission.intent_relevant {
            signal(&mut signals, "intentRelation", 1);
        }
        drafts.push(Draft {
            role: "graph",
            detail: ObjectDetail {
                object: far.object.clone(),
                project_name: far.project_name.clone(),
                project_archived: far.archived,
                current_origin: far.current_origin.clone(),
                current_source: far.current_source.clone(),
                original_source: far.original_source.clone(),
                revision_count: far.revision_count,
            },
            retrieval: None,
            signals,
            links: Vec::new(),
            admission: Some(admission.clone()),
            picks: Vec::new(),
        });
    }
    // graph support for retrieved entries that are linked to a sufficient seed
    for draft in drafts.iter_mut().filter(|d| d.role == "primary") {
        let supported = draft.links.iter().any(|e| sufficient_seeds.contains(&e.from_object_id));
        if supported {
            signal(&mut draft.signals, "graphSupport", 1);
            if draft.links.iter().any(|e| graph::intent_multiplier(&e.relation_kind, e.direction, &intent) > 1.0) {
                signal(&mut draft.signals, "intentRelation", 1);
            }
        }
    }

    // 4. Lineage enrichment
    if config.lineage {
        let started = Instant::now();
        let mut targets: Vec<(usize, Mode)> = Vec::new();
        let evolution = intent.evolution >= graph::INTENT_ON;
        let why = intent.decision >= graph::INTENT_ON;
        let mut eligible: Vec<usize> = drafts.iter().enumerate().filter(|(_, d)| d.role == "primary" && finish(d.signals.clone(), true, false).sufficient).map(|(i, _)| i).collect();
        eligible.sort_by_key(|i| drafts[*i].retrieval.as_ref().map_or(usize::MAX, |r| r.rank));
        for (n, i) in eligible.iter().enumerate() {
            if evolution && n < LINEAGE_OBJECTS_EVOLUTION {
                targets.push((*i, Mode::Evolution));
            } else if why && n < LINEAGE_OBJECTS_WHY {
                targets.push((*i, Mode::Why));
            }
        }
        // Old wording that made an object DISCOVERABLE is always explained, whatever the question was about.
        for (i, draft) in drafts.iter().enumerate() {
            if draft.role == "primary" && draft.retrieval.as_ref().is_some_and(|r| r.matched_historical.is_some()) && !targets.iter().any(|(t, _)| *t == i) {
                targets.push((i, Mode::MatchedOnly));
            }
        }
        if !targets.is_empty() {
            stats.lineage_ran = true;
            stats.lineage_objects = targets.len();
            let object_ids: Vec<String> = targets.iter().map(|(i, _)| drafts[*i].detail.object.object_id.clone()).collect();
            let revisions = store.recall_revisions_of(&object_ids).map_err(storage)?;
            stats.sql_reads += 1;
            let mut all: Vec<Pick> = Vec::new();
            for (i, mode) in &targets {
                let object_id = &drafts[*i].detail.object.object_id;
                let own: Vec<RevisionRow> = revisions.iter().filter(|r| &r.object_id == object_id).cloned().collect();
                let matched = drafts[*i].retrieval.as_ref().and_then(|r| r.matched_historical.as_ref()).map(|h| h.revision_id.clone());
                all.extend(lineage::select(&own, &drafts[*i].detail.object.current_revision_id, matched.as_deref(), *mode));
            }
            for pick in lineage::cap_total(all, lineage::MAX_HISTORY_TOTAL) {
                if let Some(draft) = drafts.iter_mut().find(|d| d.detail.object.object_id == pick.object_id) {
                    if let Some(row) = revisions.iter().find(|r| r.id == pick.revision_id) {
                        draft.picks.push((pick, row.clone()));
                    }
                }
            }
            stats.lineage_entries = drafts.iter().map(|d| d.picks.len()).sum();
        }
        stats.lineage_ms = started.elapsed().as_secs_f64() * 1000.0;
    }

    // 5. order, handles, marks
    let primary_len = drafts.iter().filter(|d| d.role == "primary").count();
    let _ = primary_len;
    let handle_of: HashMap<String, String> = drafts.iter().enumerate().map(|(i, d)| (d.detail.object.object_id.clone(), format!("E{}", i + 1))).collect();
    let present: HashSet<String> = handle_of.keys().cloned().collect();
    let marks = graph::marks(&present, &all_relations, &aliases);

    // 6. provenance: one batched Capture read for everything that needs it
    let started = Instant::now();
    let mut capture_ids: Vec<String> = Vec::new();
    let mut want = |id: &str| {
        if !capture_ids.iter().any(|c| c == id) {
            capture_ids.push(id.to_string());
        }
    };
    for draft in &drafts {
        if let Some((c, _, _)) = &draft.detail.original_source {
            want(c);
        }
        if let Some((c, _, _)) = &draft.detail.current_source {
            want(c);
        }
        for (_, row) in &draft.picks {
            if let Some((c, _, _)) = &row.source {
                want(c);
            }
        }
    }
    let captures: HashMap<String, Capture> = if capture_ids.is_empty() { HashMap::new() } else { store.get_captures(&capture_ids).map_err(storage)?.into_iter().map(|c| (c.id.clone(), c)).collect() };
    stats.sql_reads += u32::from(!capture_ids.is_empty());
    stats.captures_read = captures.len();
    let provenance_intent = intent.provenance >= graph::INTENT_ON;
    let (max_excerpts, excerpt_chars) = if provenance_intent { (MAX_EXCERPTS_PROVENANCE, EXCERPT_CHARS_PROVENANCE) } else { (MAX_EXCERPTS, EXCERPT_CHARS) };
    let mut excerpts_left = max_excerpts;

    let history_chars = if evolution_intent(&intent) { HISTORY_CHARS_EVOLUTION } else { HISTORY_CHARS };
    let mut entries: Vec<CognitiveEvidence> = Vec::new();
    for (index, draft) in drafts.into_iter().enumerate() {
        let handle = format!("E{}", index + 1);
        let object_id = draft.detail.object.object_id.clone();
        let external_project = draft.detail.object.project_id != scope;
        let source_ref = |span: &(String, i64, i64), with_excerpt: bool, left: &mut usize| -> Option<SourceRef> {
            let capture = captures.get(&span.0)?;
            let mut excerpt = None;
            let mut truncated = false;
            if with_excerpt && *left > 0 {
                if let Some(text) = code_points(&capture.content, span.1, span.2) {
                    let (clipped, was) = clip(&text, excerpt_chars);
                    excerpt = Some(clipped);
                    truncated = was;
                    *left -= 1;
                }
            }
            Some(SourceRef { capture_id: capture.id.clone(), capture_project_id: capture.project_id.clone(), capture_source: capture.source.clone(), capture_created_at: capture.created_at.clone(), span_start: span.1, span_end: span.2, excerpt, excerpt_truncated: truncated })
        };
        let excerpt_ok = !external_project;
        let origin = draft.detail.original_source.as_ref().and_then(|s| source_ref(s, excerpt_ok, &mut excerpts_left));
        let edited = matches!(draft.detail.current_origin.as_str(), "user_edit" | "merge" | "system");
        let current_revision_source = if edited { None } else { draft.detail.current_source.as_ref().filter(|s| Some(*s) != draft.detail.original_source.as_ref()).and_then(|s| source_ref(s, excerpt_ok, &mut excerpts_left)) };
        if origin.as_ref().is_some_and(|o| o.excerpt.is_some()) {
            stats.excerpts += 1;
        }

        let history: Vec<HistoryEntry> = draft
            .picks
            .iter()
            .enumerate()
            .map(|(n, (pick, row))| {
                let (title, t1) = clip(&row.title, 200);
                let (body, t2) = clip(&row.body, history_chars);
                let mut dummy = 0usize;
                HistoryEntry {
                    handle: format!("{handle}.h{}", n + 1),
                    revision_id: row.id.clone(),
                    status: pick.status,
                    origin: row.origin.clone(),
                    created_at: row.created_at.clone(),
                    title,
                    body,
                    truncated: t1 || t2,
                    marks: pick.marks.clone(),
                    leads_to_current: pick.leads_to_current,
                    source: row.source.as_ref().and_then(|s| source_ref(s, false, &mut dummy)),
                }
            })
            .collect();

        let superseded_by: Vec<String> = marks.superseded_by.get(&object_id).map(|v| v.iter().filter_map(|o| handle_of.get(o).cloned()).collect()).unwrap_or_default();
        let supersedes: Vec<String> = marks.supersedes.get(&object_id).map(|v| v.iter().filter_map(|o| handle_of.get(o).cloned()).collect()).unwrap_or_default();
        let conflicts_with: Vec<String> = marks.conflicts_with.get(&object_id).map(|v| v.iter().filter_map(|o| handle_of.get(o).cloned()).collect()).unwrap_or_default();
        let alias_views: Vec<AliasView> = marks
            .aliases
            .get(&object_id)
            .map(|v| v.iter().map(|o| AliasView { object_id: o.clone(), title: far_details.get(o).map(|f| f.object.title.clone()).unwrap_or_default() }).collect())
            .unwrap_or_default();

        let mut paths: Vec<GraphPathView> = Vec::new();
        let mut view = |e: &PathEdge| GraphPathView {
            from_object_id: e.from_object_id.clone(),
            from_handle: handle_of.get(&e.from_object_id).cloned().unwrap_or_default(),
            to_object_id: e.to_object_id.clone(),
            relation_id: e.relation_id.clone(),
            relation_kind: e.relation_kind.clone(),
            direction: e.direction.as_str(),
            distance: e.distance,
            external_project: e.external_project,
        };
        if let Some(admission) = &draft.admission {
            paths.extend(admission.path.iter().map(&mut view));
            paths.extend(admission.also_via.iter().map(&mut view));
        }
        paths.extend(draft.links.iter().map(&mut view));
        let has_graph_marks = !paths.is_empty() || !superseded_by.is_empty() || !supersedes.is_empty() || !conflicts_with.is_empty() || !alias_views.is_empty();
        let contradictory = !conflicts_with.is_empty() || paths.iter().any(|p| p.relation_kind == "contradicts");
        let graph_evidence = has_graph_marks.then(|| GraphEvidence {
            role: if draft.admission.is_some() { "expanded" } else { "supported" },
            score: draft.admission.as_ref().map(|a| a.score),
            base_weight: draft.admission.as_ref().map(|a| a.base_weight),
            intent_multiplier: draft.admission.as_ref().map(|a| a.intent_multiplier),
            intent_relevant: draft.admission.as_ref().is_some_and(|a| a.intent_relevant) || draft.links.iter().any(|e| graph::intent_multiplier(&e.relation_kind, e.direction, &intent) > 1.0),
            paths,
            superseded_by: superseded_by.clone(),
            supersedes,
            conflicts_with,
            contradictory,
            aliases: alias_views,
        });

        let mut signals = draft.signals.clone();
        if origin.is_some() {
            signal(&mut signals, "provenanceAvailable", 0);
        }
        let retrieved = draft.role == "primary";
        let strength = finish(signals, retrieved, draft.admission.is_some());
        entries.push(CognitiveEvidence {
            handle,
            role: draft.role,
            object_id,
            project_id: draft.detail.object.project_id.clone(),
            project_name: draft.detail.project_name.clone(),
            external_project,
            kind: draft.detail.object.kind.clone(),
            title: draft.detail.object.title.clone(),
            current_body: draft.detail.object.body.clone(),
            current_revision_id: draft.detail.object.current_revision_id.clone(),
            status: if superseded_by.is_empty() { "current" } else { "superseded" },
            retrieval: draft.retrieval,
            strength,
            graph: graph_evidence,
            lineage: (!history.is_empty() || draft.detail.revision_count > 1 && retrieved).then(|| LineageEvidence { revision_count: draft.detail.revision_count, entries: history }),
            provenance: Some(ProvenanceEvidence { origin, current_revision_source, edited_since_capture: edited, current_revision_origin: draft.detail.current_origin.clone() }),
        });
    }
    stats.provenance_ms = started.elapsed().as_secs_f64() * 1000.0;

    let sufficient = entries.iter().any(|e| e.role == "primary" && e.strength.sufficient);
    Ok(EvidencePackage { sufficient, insufficiency: (!sufficient).then_some("noSufficientEvidence"), entries, intent, stats })
}

fn evolution_intent(intent: &IntentWeights) -> bool {
    intent.evolution >= graph::INTENT_ON
}

/// Details of the far ends of `relations` that are not already retrieved, in one read.
fn read_far(store: &CaptureStore, relations: &[RelationRow], retrieved: &HashSet<String>, stats: &mut EnrichmentStats) -> Result<HashMap<String, Far>, RecallError> {
    let mut far_ids: Vec<String> = relations.iter().flat_map(|r| [r.source_object_id.clone(), r.target_object_id.clone()]).filter(|id| !retrieved.contains(id)).collect();
    far_ids.sort();
    far_ids.dedup();
    let mut out = HashMap::new();
    if far_ids.is_empty() {
        return Ok(out);
    }
    stats.sql_reads += 1;
    for detail in store.recall_object_details(&far_ids).map_err(storage)? {
        out.insert(detail.object.object_id.clone(), far_from(detail));
    }
    Ok(out)
}

fn read_far_missing(store: &CaptureStore, relations: &[RelationRow], known: &HashSet<String>, far: &mut HashMap<String, Far>, stats: &mut EnrichmentStats) -> Result<usize, RecallError> {
    let mut missing: Vec<String> = relations.iter().flat_map(|r| [r.source_object_id.clone(), r.target_object_id.clone()]).filter(|id| !known.contains(id) && !far.contains_key(id)).collect();
    missing.sort();
    missing.dedup();
    if missing.is_empty() {
        return Ok(0);
    }
    stats.sql_reads += 1;
    let details = store.recall_object_details(&missing).map_err(storage)?;
    let n = details.len();
    for detail in details {
        far.insert(detail.object.object_id.clone(), far_from(detail));
    }
    Ok(n)
}

fn far_from(detail: ObjectDetail) -> Far {
    Far { project_name: detail.project_name, archived: detail.project_archived, current_origin: detail.current_origin, current_source: detail.current_source, original_source: detail.original_source, revision_count: detail.revision_count, object: detail.object }
}

#[allow(dead_code)]
fn _dir_is_used(_: Dir) {}
