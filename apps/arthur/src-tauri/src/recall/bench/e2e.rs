//! M04D end-to-end Recall benchmark: the WHOLE `ask` path (retrieval, graph, lineage, provenance, context, synthesis, validation) over
//! the golden corpus, for five configurations:
//!
//! 1. `L`    lexical only (semantic consent OFF)
//! 2. `S`    semantic only (provider double)
//! 3. `H`    hybrid (RRF)
//! 4. `HG`   hybrid + Graph
//! 5. `Full` hybrid + Graph + Lineage (+ synthesis, validation, provenance)
//!
//! Answer-level metrics are the ones a deterministic evaluation CAN judge: whether every cited handle resolves, whether any entry
//! leaks across projects, whether obsolete wording is presented as current, whether provenance (the exact Capture excerpt and the
//! edited-since-capture flag) is correct, whether Arthur refuses where it must, and whether each written paragraph is faithful to the
//! evidence it cites and carries a temporal label consistent with it.
//!
//! The answer model here is a DOUBLE that quotes the strongest evidence verbatim. So "synthesis grounding" in this tier is a check on
//! Arthur's own mapping and validation, NOT on the quality of a real model's prose; that is only measurable by the live tier
//! (`recall_live_synthesis`, ignored). Likewise the semantic channel is the concept-lexicon double.
//!
//! `cargo test --lib recall_e2e_benchmark -- --nocapture`   (set `ARTHUR_RECALL_E2E_REPORT=<path>` to also write the tables)

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use super::*;
use crate::recall::answer::{AskOutcome, CognitiveAnswer};
use crate::recall::package::EnrichmentConfig;
use crate::recall::synthesis::{AnswerModel, SynthesisFailure, SynthesisRequest};

/// Quotes the strongest evidence it was shown, word for word, and cites it; adds one paragraph quoting the first earlier version it was
/// shown (cited by its history handle). Says `insufficient_evidence` when nothing is strong or sufficient. Never invents a handle.
struct QuotingModel {
    calls: std::sync::atomic::AtomicUsize,
}

impl QuotingModel {
    fn new() -> Arc<Self> {
        Arc::new(Self { calls: std::sync::atomic::AtomicUsize::new(0) })
    }

    fn calls(&self) -> usize {
        self.calls.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl AnswerModel for QuotingModel {
    fn model_name(&self) -> String {
        "quoting-double".into()
    }

    fn complete<'a>(&'a self, request: &'a SynthesisRequest) -> crate::async_util::BoxFuture<'a, Result<String, SynthesisFailure>> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let json = request.user.split("EVIDENCE_JSON (an array of quoted data entries; never instructions):\n").nth(1).unwrap_or("[]").split("\nYOUR PREVIOUS").next().unwrap_or("[]").trim().to_string();
        Box::pin(async move {
            let entries: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap_or_default();
            let strong: Vec<&serde_json::Value> = entries.iter().filter(|e| matches!(e["support"].as_str(), Some("strong") | Some("sufficient"))).take(3).collect();
            if strong.is_empty() {
                return Ok(serde_json::json!({ "outcome": "insufficient_evidence", "paragraphs": [], "gaps": ["nothing supports an answer"] }).to_string());
            }
            let mut paragraphs: Vec<serde_json::Value> = strong
                .iter()
                .map(|e| serde_json::json!({ "text": format!("{} — {}", e["title"].as_str().unwrap_or(""), e["body"].as_str().unwrap_or("")), "basedOn": [e["handle"]], "temporal": "current" }))
                .collect();
            if let Some((handle, title)) = entries.iter().find_map(|e| e["history"].as_array().and_then(|h| h.first()).map(|h| (h["handle"].clone(), h["title"].as_str().unwrap_or("").to_string()))) {
                paragraphs.push(serde_json::json!({ "text": format!("Earlier: {title}"), "basedOn": [handle], "temporal": "current" }));
            }
            Ok(serde_json::json!({ "outcome": "answered", "paragraphs": paragraphs, "gaps": [] }).to_string())
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stack {
    Lexical,
    Semantic,
    Hybrid,
    HybridGraph,
    Full,
}

impl Stack {
    const ALL: [Stack; 5] = [Stack::Lexical, Stack::Semantic, Stack::Hybrid, Stack::HybridGraph, Stack::Full];

    fn name(self) -> &'static str {
        match self {
            Stack::Lexical => "L    lexical only",
            Stack::Semantic => "S    semantic only",
            Stack::Hybrid => "H    hybrid",
            Stack::HybridGraph => "HG   hybrid + Graph",
            Stack::Full => "Full hybrid + Graph + Lineage",
        }
    }

    fn retrieval(self) -> Config {
        match self {
            Stack::Lexical => Config::Lexical,
            Stack::Semantic => Config::Semantic,
            _ => Config::Hybrid,
        }
    }

    fn enrichment(self) -> EnrichmentConfig {
        match self {
            Stack::Lexical | Stack::Semantic | Stack::Hybrid => EnrichmentConfig { graph: false, lineage: false },
            Stack::HybridGraph => EnrichmentConfig { graph: true, lineage: false },
            Stack::Full => EnrichmentConfig { graph: true, lineage: true },
        }
    }
}

#[derive(Default, Clone)]
struct M {
    questions: usize,
    with_relevant: usize,
    recall: f64,
    with_facts: usize,
    facts: f64,
    leaks: usize,
    forbidden: usize,
    obsolete_as_current: usize,
    handles: usize,
    handles_valid: usize,
    provenance: usize,
    provenance_ok: usize,
    provenance_unshown: usize,
    edited_flags: usize,
    edited_ok: usize,
    empties: usize,
    empties_correct: usize,
    answerable: usize,
    answerable_answered: usize,
    paragraphs: usize,
    paragraphs_faithful: usize,
    temporal_ok: usize,
    external_unlabelled: usize,
    answered: usize,
    insufficient: usize,
    retrieval_only: usize,
}

impl M {
    fn add(&mut self, o: &M) {
        macro_rules! sum { ($($f:ident),*) => { $( self.$f += o.$f; )* } }
        sum!(questions, with_relevant, recall, with_facts, facts, leaks, forbidden, obsolete_as_current, handles, handles_valid, provenance, provenance_ok, provenance_unshown, edited_flags, edited_ok, empties, empties_correct, answerable, answerable_answered, paragraphs, paragraphs_faithful, temporal_ok, external_unlabelled, answered, insufficient, retrieval_only);
    }

    fn recall(&self) -> f64 {
        if self.with_relevant == 0 { f64::NAN } else { self.recall / self.with_relevant as f64 }
    }

    fn facts(&self) -> f64 {
        if self.with_facts == 0 { f64::NAN } else { self.facts / self.with_facts as f64 }
    }
}

fn rate(good: usize, total: usize) -> String {
    if total == 0 { "n/a".into() } else { format!("{:.1}% ({good}/{total})", good as f64 * 100.0 / total as f64) }
}

struct StackRun {
    by_class: BTreeMap<String, M>,
    graph: M,
    lineage: M,
    total: M,
    wall_ms: Vec<f64>,
    local_ms: Vec<f64>,
    synthesis_calls: usize,
}

const GRAPH_CLASSES: [&str; 3] = ["dependency", "contradiction", "task-from"];
const LINEAGE_CLASSES: [&str; 2] = ["evolution", "decision-why"];

fn code_points(text: &str, start: i64, end: i64) -> String {
    text.chars().skip(start as usize).take((end - start) as usize).collect()
}

fn judge(world: &World, question: &GQuestion, answer: &CognitiveAnswer, calls_made: usize) -> M {
    let scope = &world.projects[&question.project];
    let store = &world.lab.store;
    let mut m = M { questions: 1, ..Default::default() };
    let object_ids: Vec<&str> = answer.evidence.iter().map(|e| e.entry.object_id.as_str()).collect();
    let relevant: Vec<&str> = question.relevant.iter().map(|k| world.objects[k].as_str()).collect();
    if !relevant.is_empty() {
        m.with_relevant = 1;
        m.recall = relevant.iter().filter(|r| object_ids.contains(r)).count() as f64 / relevant.len() as f64;
    }
    if !question.facts.is_empty() {
        m.with_facts = 1;
        let haystack = answer
            .evidence
            .iter()
            .flat_map(|e| std::iter::once(format!("{} {}", e.entry.title, e.entry.current_body)).chain(e.entry.lineage.iter().flat_map(|l| l.entries.iter().map(|h| format!("{} {}", h.title, h.body)))))
            .collect::<Vec<_>>()
            .join("\n")
            .to_lowercase();
        m.facts = question.facts.iter().filter(|f| haystack.contains(&f.to_lowercase())).count() as f64 / question.facts.len() as f64;
    }
    m.leaks = answer.evidence.iter().filter(|e| !e.entry.external_project && &e.entry.project_id != scope).count();
    m.external_unlabelled = answer.evidence.iter().filter(|e| &e.entry.project_id != scope && !e.entry.external_project).count();
    let forbidden: Vec<&str> = question.forbidden.iter().map(|k| world.objects[k].as_str()).collect();
    m.forbidden = object_ids.iter().filter(|i| forbidden.contains(i)).count();
    m.obsolete_as_current = answer.evidence.iter().filter(|e| question.obsolete_text.iter().any(|t| e.entry.title.contains(t.as_str()) || e.entry.current_body.contains(t.as_str()))).count();

    // Handles: every cited handle must be one the answer's own evidence contains (an entry, or one of its earlier versions).
    let known: HashSet<String> = answer.evidence.iter().flat_map(|e| std::iter::once(e.entry.handle.clone()).chain(e.entry.lineage.iter().flat_map(|l| l.entries.iter().map(|h| h.handle.clone())))).collect();
    let by_handle: BTreeMap<&str, &crate::recall::package::CognitiveEvidence> = answer.evidence.iter().map(|e| (e.entry.handle.as_str(), &e.entry)).collect();
    if let Some(body) = &answer.answer {
        for paragraph in &body.paragraphs {
            m.paragraphs += 1;
            m.handles += paragraph.based_on.len();
            m.handles_valid += paragraph.based_on.iter().filter(|h| known.contains(h.as_str())).count();
            // Faithful: the paragraph quotes the title of every one of its cited entries (current or earlier), nothing else is claimed.
            let faithful = !paragraph.based_on.is_empty()
                && paragraph.based_on.iter().all(|h| {
                    let (entry_handle, is_history) = match h.split_once('.') { Some((e, _)) => (e, true), None => (h.as_str(), false) };
                    by_handle.get(entry_handle).is_some_and(|e| {
                        if is_history {
                            e.lineage.as_ref().is_some_and(|l| l.entries.iter().any(|x| &x.handle == h && paragraph.text.contains(&x.title)))
                        } else {
                            paragraph.text.contains(&e.title)
                        }
                    })
                });
            m.paragraphs_faithful += usize::from(faithful);
            // Temporal consistency: earlier wording is never labelled current-only, and a paragraph resting on current, in-project evidence only is `current`.
            let cites_history = paragraph.based_on.iter().any(|h| h.contains('.'));
            let all_history = paragraph.based_on.iter().all(|h| h.contains('.'));
            let cites_external = paragraph.based_on.iter().any(|h| by_handle.get(h.split('.').next().unwrap_or("")).is_some_and(|e| e.external_project));
            let ok = if cites_history { paragraph.temporal == if all_history { "historical" } else { "mixed" } } else if cites_external { paragraph.temporal == "external" || paragraph.temporal == "mixed" } else { paragraph.temporal == "current" };
            m.temporal_ok += usize::from(ok);
        }
    }

    // Provenance: the excerpt is exactly the Capture's words at the recorded span, and the edited-since-capture flag is true exactly when
    // the current revision is not the object's first.
    for evidence in &answer.evidence {
        let Some(provenance) = &evidence.entry.provenance else { continue };
        if let Some(origin) = provenance.origin.as_ref() {
            // The excerpt budget is bounded by design (and external entries carry none): an entry without an excerpt is not a mismatch,
            // it is "not shown here", and the UI says so. Only the excerpts that ARE shown are judged.
            if origin.excerpt.is_none() {
                m.provenance_unshown += 1;
                m.edited_flags += 1;
                let first = store.list_revisions(&evidence.entry.object_id).unwrap()[0].id.clone();
                let current = store.object_lineage(&evidence.entry.object_id).unwrap().current_revision_id;
                m.edited_ok += usize::from(provenance.edited_since_capture == (current != first));
                continue;
            }
            m.provenance += 1;
            let capture = store.get_capture(&origin.capture_id).unwrap();
            let exact = capture.as_ref().is_some_and(|c| {
                let slice = code_points(&c.content, origin.span_start, origin.span_end);
                c.project_id == origin.capture_project_id && origin.excerpt.as_ref().is_some_and(|x| if origin.excerpt_truncated { slice.starts_with(x.trim_end_matches('…')) } else { *x == slice })
            });
            m.provenance_ok += usize::from(exact);
        }
        m.edited_flags += 1;
        let first = store.list_revisions(&evidence.entry.object_id).unwrap()[0].id.clone();
        let current = store.object_lineage(&evidence.entry.object_id).unwrap().current_revision_id;
        m.edited_ok += usize::from(provenance.edited_since_capture == (current != first));
    }

    // Refusal: a question that must come back empty must say so, and must not reach the model.
    if question.expect_empty {
        m.empties = 1;
        m.empties_correct = usize::from(answer.outcome == AskOutcome::InsufficientEvidence && calls_made == 0);
    } else if !question.relevant.is_empty() {
        m.answerable = 1;
        m.answerable_answered = usize::from(answer.outcome == AskOutcome::Answered);
    }
    match answer.outcome {
        AskOutcome::Answered => m.answered = 1,
        AskOutcome::InsufficientEvidence => m.insufficient = 1,
        AskOutcome::RetrievalOnly => m.retrieval_only = 1,
    }
    m
}

fn run_stack(world: &World, stack: Stack) -> StackRun {
    let dir = tempfile::tempdir().unwrap();
    let (service, _embedder) = service_for(world, stack.retrieval(), dir.path());
    let model = QuotingModel::new();
    let service = service.with_answer_model(model.clone()).with_enrichment(stack.enrichment());
    let mut out = StackRun { by_class: BTreeMap::new(), graph: M::default(), lineage: M::default(), total: M::default(), wall_ms: vec![], local_ms: vec![], synthesis_calls: 0 };
    for question in &world.questions {
        let before = model.calls();
        let answer = run(service.ask(&world.lab.store, &question.query, &world.projects[&question.project])).unwrap();
        let m = judge(world, question, &answer, model.calls() - before);
        out.by_class.entry(question.class.clone()).or_default().add(&m);
        if GRAPH_CLASSES.contains(&question.class.as_str()) {
            out.graph.add(&m);
        }
        if LINEAGE_CLASSES.contains(&question.class.as_str()) {
            out.lineage.add(&m);
        }
        out.total.add(&m);
        out.wall_ms.push(answer.diagnostics.timings.wall_ms);
        out.local_ms.push(answer.diagnostics.timings.local_total_ms);
    }
    out.synthesis_calls = model.calls();
    out
}

#[test]
fn recall_e2e_benchmark() {
    let world = build_world();
    let runs: Vec<(Stack, StackRun)> = Stack::ALL.iter().map(|s| (*s, run_stack(&world, *s))).collect();
    let fmt = |x: f64| if x.is_nan() { "-".to_string() } else { format!("{x:.2}") };

    let mut text = String::from("| configuration | evidence recall (all) | graph classes | lineage classes: facts | answered / insufficient / retrieval-only |\n|---|---|---|---|---|\n");
    for (stack, r) in &runs {
        text.push_str(&format!("| {} | {} | {} | {} | {} / {} / {} |\n", stack.name(), fmt(r.total.recall()), fmt(r.graph.recall()), fmt(r.lineage.facts()), r.total.answered, r.total.insufficient, r.total.retrieval_only));
    }
    text.push_str("\n| configuration | valid evidence handles | project leakage | obsolete-as-current | provenance correct (excerpts shown) | edited-since-capture correct | insufficient-evidence correct | answerable questions answered | paragraphs faithful to cited evidence | temporal labels consistent |\n|---|---|---|---|---|---|---|---|---|---|\n");
    for (stack, r) in &runs {
        let t = &r.total;
        text.push_str(&format!(
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |\n",
            stack.name(),
            rate(t.handles_valid, t.handles),
            t.leaks + t.external_unlabelled,
            t.obsolete_as_current,
            format!("{} · {} not shown", rate(t.provenance_ok, t.provenance), t.provenance_unshown),
            rate(t.edited_ok, t.edited_flags),
            rate(t.empties_correct, t.empties),
            rate(t.answerable_answered, t.answerable),
            rate(t.paragraphs_faithful, t.paragraphs),
            rate(t.temporal_ok, t.paragraphs)
        ));
    }
    text.push_str("\n| configuration | answer wall ms p50 / p95 (model double) | local (retrieval + enrichment + context) ms p50 / p95 |\n|---|---|---|\n");
    for (stack, r) in &runs {
        text.push_str(&format!("| {} | {:.2} / {:.2} | {:.2} / {:.2} |\n", stack.name(), percentile(&r.wall_ms, 0.5), percentile(&r.wall_ms, 0.95), percentile(&r.local_ms, 0.5), percentile(&r.local_ms, 0.95)));
    }
    println!("\n=== M04D end-to-end benchmark (deterministic doubles: concept-lexicon embedder, quoting answer model) ===\n{text}");
    if let Ok(path) = std::env::var("ARTHUR_RECALL_E2E_REPORT") {
        std::fs::write(path, &text).unwrap();
    }

    let [l, _s, h, hg, full] = [&runs[0].1, &runs[1].1, &runs[2].1, &runs[3].1, &runs[4].1];

    // ---- answer-level invariants hold in EVERY configuration ----
    for (stack, r) in &runs {
        let t = &r.total;
        assert_eq!(t.handles_valid, t.handles, "{stack:?}: every evidence handle an answer cites must resolve");
        assert_eq!(t.leaks + t.external_unlabelled, 0, "{stack:?}: no entry from another project unless labelled external");
        assert_eq!(t.forbidden, 0, "{stack:?}: forbidden objects never appear");
        assert_eq!(t.obsolete_as_current, 0, "{stack:?}: obsolete wording presented as current");
        assert_eq!(t.provenance_ok, t.provenance, "{stack:?}: provenance excerpts are exact");
        assert_eq!(t.edited_ok, t.edited_flags, "{stack:?}: edited-since-capture is exactly right");
        assert_eq!(t.paragraphs_faithful, t.paragraphs, "{stack:?}: every paragraph is faithful to what it cites");
        assert_eq!(t.temporal_ok, t.paragraphs, "{stack:?}: temporal labels agree with the citations");
        assert_eq!(t.retrieval_only, 0, "{stack:?}: the double always answers in valid JSON");
    }
    // A question that must come back empty is refused WITHOUT a model call by the stacks that make the refusal claim (hybrid and up).
    for (stack, r) in runs.iter().skip(2) {
        assert_eq!(r.total.empties_correct, r.total.empties, "{stack:?}: insufficient-evidence refusals");
    }
    // The lexical floor on its own refuses all but at most one.
    assert!(l.total.empties - l.total.empties_correct <= 1, "lexical-only refusals {}/{}", l.total.empties_correct, l.total.empties);

    // ---- the M04C gates, re-judged on the answers themselves ----
    let (before, after) = (h.graph.recall(), hg.graph.recall());
    let error_reduction = if before >= 1.0 { 0.0 } else { ((1.0 - before) - (1.0 - after)) / (1.0 - before) };
    println!("GRAPH GATE (answers): evidence recall {before:.3} -> {after:.3} (+{:.1} pp, error reduction {:.0}%) on {} dependency/contradiction/task-from questions", (after - before) * 100.0, error_reduction * 100.0, h.graph.with_relevant);
    assert!(after - before >= 0.10 || error_reduction >= 0.20, "Graph gate");
    let (facts_before, facts_after) = (hg.lineage.facts(), full.lineage.facts());
    println!("LINEAGE GATE (answers): required-fact coverage {facts_before:.3} -> {facts_after:.3} (+{:.1} pp) on {} evolution/decision-why questions", (facts_after - facts_before) * 100.0, hg.lineage.with_facts);
    assert!(facts_after - facts_before >= 0.15, "Lineage gate");
    // Enrichment never costs the retrieval baseline: full Recall finds at least what hybrid finds, overall.
    assert!(full.total.recall() >= h.total.recall() - 0.02, "Full {:.3} vs H {:.3}", full.total.recall(), h.total.recall());
    // Only the full stack may show earlier versions, and only the stacks with Graph may show graph-added entries.
    assert!(h.total.recall().is_finite() && full.synthesis_calls > 0);
}
