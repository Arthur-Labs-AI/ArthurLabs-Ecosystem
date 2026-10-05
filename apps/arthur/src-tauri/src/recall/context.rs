//! Bounded context construction: turns the EvidencePackage into the ONE structure the answer model sees.
//!
//! Hard budget (estimated tokens) with deterministic degradation: lower-priority evidence is removed before high-value primary evidence
//! is shortened, and a shortened historical entry stays `historical` (truncation never turns it into a current fact).
//!
//! The model sees handles (`E1`, `E2.h1`), never object, relation, revision or capture ids, paths, SQL or any runtime state. Stored text
//! is carried only inside JSON string values, so nothing a user once wrote can be mistaken for an instruction or break out of its field.

use std::collections::HashSet;

use serde::Serialize;

use super::package::{CognitiveEvidence, EvidencePackage, HistoryEntry};

/// Estimated evidence tokens (the system prompt and the answer are separate).
pub const BUDGET_TOKENS: usize = 6_000;
pub const SEED_BODY_TOP: usize = 1_200;
pub const SEED_BODY_REST: usize = 500;
pub const GRAPH_BODY: usize = 300;
pub const HISTORY_SHORT: usize = 150;
pub const TOP_PRIMARY: usize = 3;

/// Conservative estimate (no tokenizer dependency): Latin about 4 characters per token, other scripts (Cyrillic) about 1.7.
pub fn estimate_tokens(text: &str) -> usize {
    let (mut latin, mut other) = (0usize, 0usize);
    for c in text.chars() {
        if c.is_ascii() {
            latin += 1;
        } else {
            other += 1;
        }
    }
    (latin as f64 / 4.0 + other as f64 / 1.7).ceil() as usize
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dropped {
    pub handle: String,
    pub reason: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Truncation {
    pub step: &'static str,
    pub items: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextReport {
    pub budget_tokens: usize,
    pub estimated_tokens: usize,
    pub entries_included: usize,
    pub history_included: usize,
    pub dropped: Vec<Dropped>,
    pub truncation: Vec<Truncation>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ViaView {
    related_entry: String,
    relation: String,
    /// e.g. "E2 depends_on this entry" or "this entry depends_on E2"; symmetric kinds read "E2 contradicts this entry".
    phrase: String,
    distance: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceView {
    /// How the original words were captured: `typed`, `spoken` or `gesture`.
    captured_as: &'static str,
    /// The person's own original words (a verbatim excerpt of the Capture) that this entry was first interpreted from.
    original_words: Option<String>,
    original_words_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryView {
    handle: String,
    /// `historical` or `branch_not_current`: NEVER current.
    status: &'static str,
    origin: String,
    created_at: String,
    title: String,
    body: String,
    truncated: bool,
    marks: Vec<&'static str>,
    leads_to_current: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryView {
    handle: String,
    /// `retrieved` (found by search) or `graph` (added because it is connected to a retrieved entry).
    found_by: &'static str,
    /// The name of the Project this entry belongs to; `externalProject` is true when it is NOT the Project being asked about.
    project: String,
    external_project: bool,
    kind: String,
    /// `current`, or `superseded` (another entry replaces it: it is not the current position).
    status: &'static str,
    title: String,
    /// The CURRENT text of this entry (null when only the title fits the budget).
    body: Option<String>,
    body_truncated: bool,
    /// strong, sufficient, supporting or weak. A weak entry is a similar-looking candidate that nothing else supports.
    support: &'static str,
    via: Vec<ViaView>,
    superseded_by: Vec<String>,
    supersedes: Vec<String>,
    conflicts_with: Vec<String>,
    /// True when an explicit `contradicts` relation links this entry to another.
    contradictory: bool,
    duplicate_titles: Vec<String>,
    revision_count: i64,
    /// The current text was edited after capture, so the capture excerpt does NOT support it.
    edited_since_capture: bool,
    /// Where this entry originally came from: the person's own captured words.
    original_capture: Option<SourceView>,
    history: Vec<HistoryView>,
}

/// What `build_context` returns.
#[derive(Debug, Clone, PartialEq)]
pub struct Context {
    /// The compact JSON array handed to the model.
    pub evidence_json: String,
    /// Every handle the model may cite (entries and history entries actually present).
    pub allowed_handles: HashSet<String>,
    pub report: ContextReport,
}

fn clip(text: &str, limit: usize) -> (String, bool) {
    if text.chars().count() <= limit {
        (text.to_string(), false)
    } else {
        (text.chars().take(limit).collect(), true)
    }
}

fn phrase(direction: &str, kind: &str, related: &str) -> String {
    match direction {
        "out" => format!("{related} {kind} this entry"),
        "in" => format!("this entry {kind} {related}"),
        _ => format!("{related} {kind} this entry (symmetric)"),
    }
}

fn history_priority(entry: &HistoryEntry) -> u8 {
    const ORDER: [(&str, u8); 8] = [("matched_query", 0), ("parent", 1), ("root", 2), ("merge", 3), ("new_capture", 4), ("branch_point", 5), ("non_current_head", 6), ("path", 7)];
    entry.marks.iter().filter_map(|m| ORDER.iter().find(|(name, _)| name == m).map(|(_, p)| *p)).min().unwrap_or(7)
}

struct Work {
    entries: Vec<EntryView>,
    /// parallel to `entries`: package index
    sources: Vec<usize>,
    dropped: Vec<Dropped>,
    truncation: Vec<Truncation>,
}

fn views(package: &EvidencePackage) -> Work {
    let handle_ok: HashSet<&str> = package.entries.iter().map(|e| e.handle.as_str()).collect();
    let mut entries = Vec::new();
    let mut sources = Vec::new();
    for (index, e) in package.entries.iter().enumerate() {
        let cap = if e.role == "graph" || e.external_project {
            GRAPH_BODY
        } else if e.retrieval.as_ref().is_some_and(|r| r.rank <= TOP_PRIMARY) {
            SEED_BODY_TOP
        } else {
            SEED_BODY_REST
        };
        let (body, truncated) = clip(&e.current_body, cap);
        let via: Vec<ViaView> = e
            .graph
            .iter()
            .flat_map(|g| g.paths.iter())
            .filter(|p| handle_ok.contains(p.from_handle.as_str()))
            .map(|p| ViaView { related_entry: p.from_handle.clone(), relation: p.relation_kind.clone(), phrase: phrase(p.direction, &p.relation_kind, &p.from_handle), distance: p.distance })
            .collect();
        let provenance = e.provenance.as_ref();
        let source = provenance.and_then(|p| p.origin.as_ref()).map(|o| SourceView { captured_as: match o.capture_source.as_str() { "voice" => "spoken", "emg" => "gesture", _ => "typed" }, original_words: o.excerpt.clone(), original_words_truncated: o.excerpt_truncated });
        entries.push(EntryView {
            handle: e.handle.clone(),
            found_by: if e.role == "graph" { "graph" } else { "retrieved" },
            project: e.project_name.clone(),
            external_project: e.external_project,
            kind: e.kind.clone(),
            status: e.status,
            title: e.title.clone(),
            body: Some(body),
            body_truncated: truncated,
            support: e.strength.level,
            via,
            superseded_by: e.graph.as_ref().map(|g| g.superseded_by.clone()).unwrap_or_default(),
            supersedes: e.graph.as_ref().map(|g| g.supersedes.clone()).unwrap_or_default(),
            conflicts_with: e.graph.as_ref().map(|g| g.conflicts_with.clone()).unwrap_or_default(),
            contradictory: e.graph.as_ref().is_some_and(|g| g.contradictory),
            duplicate_titles: e.graph.as_ref().map(|g| g.aliases.iter().map(|a| a.title.clone()).collect()).unwrap_or_default(),
            revision_count: e.lineage.as_ref().map_or(1, |l| l.revision_count),
            edited_since_capture: provenance.is_some_and(|p| p.edited_since_capture),
            original_capture: source,
            history: e
                .lineage
                .iter()
                .flat_map(|l| l.entries.iter())
                .map(|h| HistoryView { handle: h.handle.clone(), status: h.status, origin: h.origin.clone(), created_at: h.created_at.clone(), title: h.title.clone(), body: h.body.clone(), truncated: h.truncated, marks: h.marks.clone(), leads_to_current: h.leads_to_current })
                .collect(),
        });
        sources.push(index);
    }
    Work { entries, sources, dropped: Vec::new(), truncation: Vec::new() }
}

fn tokens(entries: &[EntryView]) -> usize {
    estimate_tokens(&serde_json::to_string(entries).unwrap_or_default())
}

/// Removes references to dropped handles so the model never sees a pointer to something it cannot see.
fn scrub(entries: &mut [EntryView], gone: &str) {
    let prefix = format!("{gone}.");
    for e in entries.iter_mut() {
        e.via.retain(|v| v.related_entry != gone);
        e.superseded_by.retain(|h| h != gone);
        e.supersedes.retain(|h| h != gone);
        e.conflicts_with.retain(|h| h != gone);
        e.history.retain(|h| !h.handle.starts_with(&prefix));
    }
}

/// The deterministic degradation ladder. Each step is applied only while the context is over budget, in this order; the first step that
/// changes anything is the one taken, then the size is measured again.
pub fn build_context(package: &EvidencePackage, budget: usize) -> Context {
    let mut work = views(package);
    let over = |w: &Work| tokens(&w.entries) > budget;
    let rank_of = |package_index: usize| package.entries[package_index].retrieval.as_ref().map_or(usize::MAX, |r| r.rank);

    // 1. historical bodies shrink to a short form (they stay `historical`, flagged truncated)
    if over(&work) {
        let mut n = 0;
        for e in work.entries.iter_mut() {
            for h in e.history.iter_mut() {
                if h.body.chars().count() > HISTORY_SHORT {
                    h.body = h.body.chars().take(HISTORY_SHORT).collect();
                    h.truncated = true;
                    n += 1;
                }
            }
        }
        if n > 0 {
            work.truncation.push(Truncation { step: "historyShortened", items: n });
        }
    }
    // 2. drop history entries, lowest priority first (path, heads, branch points, ...), never the matched revision or the parent last
    while over(&work) {
        let mut candidate: Option<(u8, usize, usize)> = None; // (priority, entry, history index)
        for (ei, e) in work.entries.iter().enumerate() {
            let package_entry = &package.entries[work.sources[ei]];
            for (hi, h) in e.history.iter().enumerate() {
                let source = package_entry.lineage.as_ref().and_then(|l| l.entries.iter().find(|x| x.handle == h.handle));
                let priority = source.map_or(7, history_priority);
                if candidate.is_none_or(|(p, _, _)| priority > p) {
                    candidate = Some((priority, ei, hi));
                }
            }
        }
        let Some((_, ei, hi)) = candidate else { break };
        let removed = work.entries[ei].history.remove(hi);
        work.dropped.push(Dropped { handle: removed.handle, reason: "overBudget:history" });
    }
    // 3. provenance excerpts of everything beyond the top primary entries
    if over(&work) {
        let mut n = 0;
        for (ei, e) in work.entries.iter_mut().enumerate() {
            if rank_of(work.sources[ei]) > TOP_PRIMARY {
                if let Some(s) = e.original_capture.as_mut() {
                    if s.original_words.take().is_some() {
                        n += 1;
                    }
                }
            }
        }
        if n > 0 {
            work.truncation.push(Truncation { step: "excerptsDropped", items: n });
        }
    }
    // 4. graph and external entries keep their title only
    if over(&work) {
        let mut n = 0;
        for e in work.entries.iter_mut().filter(|e| e.found_by == "graph") {
            if e.body.take().is_some() {
                e.body_truncated = true;
                n += 1;
            }
        }
        if n > 0 {
            work.truncation.push(Truncation { step: "graphBodiesToTitles", items: n });
        }
    }
    // 5. drop graph entries: second hop first, then the lowest expansion score, then external ones
    let drop_one = |work: &mut Work, reason: &'static str, pick: &dyn Fn(&CognitiveEvidence) -> Option<(u8, f64)>| -> bool {
        let mut best: Option<(u8, f64, usize)> = None;
        for (ei, _) in work.entries.iter().enumerate() {
            let p = &package.entries[work.sources[ei]];
            if let Some((tier, score)) = pick(p) {
                if best.is_none_or(|(bt, bs, _)| tier > bt || (tier == bt && score < bs)) {
                    best = Some((tier, score, ei));
                }
            }
        }
        let Some((_, _, ei)) = best else { return false };
        let gone = work.entries.remove(ei);
        work.sources.remove(ei);
        scrub(&mut work.entries, &gone.handle);
        work.dropped.push(Dropped { handle: gone.handle, reason });
        true
    };
    while over(&work) {
        let tier = |p: &CognitiveEvidence| -> Option<(u8, f64)> {
            if p.role != "graph" {
                return None;
            }
            let g = p.graph.as_ref()?;
            let second = g.paths.first().is_some_and(|x| x.distance == 2) || g.paths.len() >= 2 && g.paths[1].distance == 2;
            let t = if second { 3 } else if p.external_project { 1 } else { 2 };
            Some((t, g.score.unwrap_or(0.0)))
        };
        if !drop_one(&mut work, "overBudget:graph", &tier) {
            break;
        }
    }
    // 6. shrink the lower retrieved bodies, then drop the weakest of them (never the first)
    if over(&work) {
        let mut n = 0;
        for (ei, e) in work.entries.iter_mut().enumerate() {
            if e.found_by == "retrieved" && rank_of(work.sources[ei]) > TOP_PRIMARY {
                if let Some(b) = e.body.as_mut() {
                    if b.chars().count() > 200 {
                        *b = b.chars().take(200).collect();
                        e.body_truncated = true;
                        n += 1;
                    }
                }
            }
        }
        if n > 0 {
            work.truncation.push(Truncation { step: "lowerBodiesShortened", items: n });
        }
    }
    while over(&work) && work.entries.iter().filter(|e| e.found_by == "retrieved").count() > 1 {
        let weakest = |p: &CognitiveEvidence| -> Option<(u8, f64)> {
            if p.role != "primary" || p.retrieval.as_ref().is_some_and(|r| r.rank == 1) {
                return None;
            }
            // weaker support first, then lower rank (higher rank number)
            Some((u8::MAX - p.strength.points.min(200) as u8, -(p.retrieval.as_ref().map_or(0, |r| r.rank) as f64)))
        };
        if !drop_one(&mut work, "overBudget:weakest", &weakest) {
            break;
        }
    }
    // 7. last resort for the top entries: 600 characters, then 300 (their titles and the strongest entry always stay)
    for limit in [600usize, 300usize] {
        if over(&work) {
            let mut n = 0;
            for e in work.entries.iter_mut().filter(|e| e.found_by == "retrieved") {
                if let Some(b) = e.body.as_mut() {
                    if b.chars().count() > limit {
                        *b = b.chars().take(limit).collect();
                        e.body_truncated = true;
                        n += 1;
                    }
                }
            }
            if n > 0 {
                work.truncation.push(Truncation { step: if limit == 600 { "topBodiesTo600" } else { "topBodiesTo300" }, items: n });
            }
        }
    }

    let mut allowed: HashSet<String> = HashSet::new();
    for e in &work.entries {
        allowed.insert(e.handle.clone());
        for h in &e.history {
            allowed.insert(h.handle.clone());
        }
    }
    let evidence_json = serde_json::to_string(&work.entries).unwrap_or_else(|_| "[]".into());
    let report = ContextReport {
        budget_tokens: budget,
        estimated_tokens: estimate_tokens(&evidence_json),
        entries_included: work.entries.len(),
        history_included: work.entries.iter().map(|e| e.history.len()).sum(),
        dropped: work.dropped,
        truncation: work.truncation,
    };
    Context { evidence_json, allowed_handles: allowed, report }
}
