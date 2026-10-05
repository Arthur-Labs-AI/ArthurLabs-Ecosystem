//! The M04B retrieval benchmark: lexical only (L), semantic only (S) and hybrid (H) over a checked-in golden corpus.
//!
//! * CI-safe tier (`recall_benchmark_offline`): deterministic. The "semantic" channel is `ConceptEmbedder`, a hand-declared concept
//!   lexicon hashed into vectors. It exercises the semantic CODE PATH (storage, staleness, scope, fusion) reproducibly; it says NOTHING
//!   about the quality of a real embedding model. Do not read S or H numbers from this tier as semantic quality.
//! * Scale tier (`recall_benchmark_scale`, ignored, run in release): 10,000 objects, latency per stage.
//! * Live tier (`recall_benchmark_live`, ignored): the same golden set with the real provider; needs a key and the network.
//!
//! Graph, Lineage and answer synthesis are NOT benchmarked here: they do not exist yet (M04C+).
//!
//! Run: `cargo test --lib recall_benchmark_offline -- --nocapture`. Set `ARTHUR_RECALL_BENCH_REPORT=<path>` to also write the tables.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;

use super::evidence::{RetrievalResult, SemanticStatus};
use super::service::{RecallService, INDEX_RUN_LIMIT};
use super::settings::SemanticSettings;
use super::testing::{run, ConceptEmbedder, Lab};
use crate::storage::migrations::INBOX_PROJECT_ID;

const GOLDEN: &str = include_str!("bench/golden.json");

#[derive(Deserialize)]
struct Golden {
    projects: Vec<GProject>,
    objects: Vec<GObject>,
    questions: Vec<GQuestion>,
    concepts: Vec<(String, String)>,
}

#[derive(Deserialize)]
struct GProject {
    key: String,
    name: String,
    archived: bool,
}

#[derive(Deserialize)]
struct GObject {
    key: String,
    project: String,
    kind: String,
    title: String,
    body: String,
    history: Vec<GStep>,
}

#[derive(Deserialize)]
struct GStep {
    op: String,
    title: String,
    body: String,
}

#[derive(Deserialize, Clone)]
struct GQuestion {
    id: String,
    class: String,
    lang: String,
    project: String,
    query: String,
    relevant: Vec<String>,
    forbidden: Vec<String>,
    #[serde(rename = "expectEmpty")]
    expect_empty: bool,
    #[serde(rename = "obsoleteText")]
    obsolete_text: Vec<String>,
}

struct World {
    lab: Lab,
    objects: HashMap<String, String>,
    projects: HashMap<String, String>,
    questions: Vec<GQuestion>,
    concepts: Vec<(String, String)>,
}

fn build_world() -> World {
    let golden: Golden = serde_json::from_str(GOLDEN).unwrap();
    let lab = Lab::new();
    let mut projects: HashMap<String, String> = HashMap::new();
    projects.insert("inbox".into(), INBOX_PROJECT_ID.into());
    for project in &golden.projects {
        projects.insert(project.key.clone(), lab.project(&project.name));
    }
    let mut objects = HashMap::new();
    for object in &golden.objects {
        let id = lab.object(&projects[&object.project], &object.kind, &object.title, &object.body);
        let root = lab.root_revision(&id);
        for step in &object.history {
            match step.op.as_str() {
                "edit" => {
                    lab.edit(&id, Some(&step.title), Some(&step.body));
                }
                "branch" => {
                    lab.branch(&id, &root, &step.title, &step.body, false);
                }
                other => panic!("unknown history op {other}"),
            }
        }
        objects.insert(object.key.clone(), id);
    }
    // Archive only after the knowledge is written (an archived project accepts nothing new).
    for project in golden.projects.iter().filter(|p| p.archived) {
        lab.store.archive_project(&projects[&project.key]).unwrap();
    }
    World { lab, objects, projects, questions: golden.questions, concepts: golden.concepts }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Config {
    Lexical,
    Semantic,
    Hybrid,
}

impl Config {
    fn name(self) -> &'static str {
        match self {
            Config::Lexical => "L  lexical only",
            Config::Semantic => "S  semantic only",
            Config::Hybrid => "H  hybrid",
        }
    }
}

fn service_for(world: &World, config: Config, dir: &std::path::Path) -> (RecallService, Arc<ConceptEmbedder>) {
    let concepts: Vec<(&str, &str)> = world.concepts.iter().map(|(p, c)| (p.as_str(), c.as_str())).collect();
    let embedder = Arc::new(ConceptEmbedder::new(128, &concepts));
    let settings = Arc::new(SemanticSettings::new(dir.join("semantic.json")));
    let service = RecallService::new(embedder.clone(), settings);
    match config {
        Config::Lexical => {} // consent stays OFF: the default
        Config::Semantic | Config::Hybrid => {
            service.settings().set(service.model_key(), true).unwrap();
            let report = run(service.index_pending(&world.lab.store, INDEX_RUN_LIMIT)).unwrap();
            assert_eq!(report.remaining, Some(0));
        }
    }
    if config == Config::Semantic {
        service.lexical_enabled.store(false, std::sync::atomic::Ordering::SeqCst);
    }
    (service, embedder)
}

#[derive(Default, Clone)]
struct Metrics {
    questions: usize,
    with_relevant: usize,
    recall1: f64,
    recall5: f64,
    recall8: f64,
    mrr: f64,
    empty_expected: usize,
    false_answers: usize,
    project_leaks: usize,
    obsolete_as_current: usize,
    forbidden_hits: usize,
    uploads: u32,
    provider_requests: u32,
    historical_discoveries: usize,
}

impl Metrics {
    fn add(&mut self, other: &Metrics) {
        self.questions += other.questions;
        self.with_relevant += other.with_relevant;
        self.recall1 += other.recall1;
        self.recall5 += other.recall5;
        self.recall8 += other.recall8;
        self.mrr += other.mrr;
        self.empty_expected += other.empty_expected;
        self.false_answers += other.false_answers;
        self.project_leaks += other.project_leaks;
        self.obsolete_as_current += other.obsolete_as_current;
        self.forbidden_hits += other.forbidden_hits;
        self.uploads += other.uploads;
        self.provider_requests += other.provider_requests;
        self.historical_discoveries += other.historical_discoveries;
    }

    fn mean(&self, total: f64) -> f64 {
        if self.with_relevant == 0 {
            f64::NAN
        } else {
            total / self.with_relevant as f64
        }
    }
}

fn score(world: &World, question: &GQuestion, result: &RetrievalResult) -> Metrics {
    let ids: Vec<&str> = result.evidence.iter().map(|e| e.object_id.as_str()).collect();
    let mut metrics = Metrics { questions: 1, ..Default::default() };
    let relevant: Vec<&str> = question.relevant.iter().map(|k| world.objects[k].as_str()).collect();
    if !relevant.is_empty() {
        metrics.with_relevant = 1;
        let at = |k: usize| relevant.iter().filter(|r| ids.iter().take(k).any(|i| i == *r)).count() as f64 / relevant.len() as f64;
        metrics.recall1 = at(1);
        metrics.recall5 = at(5);
        metrics.recall8 = at(8);
        metrics.mrr = ids.iter().position(|i| relevant.contains(i)).map_or(0.0, |p| 1.0 / (p as f64 + 1.0));
    }
    if question.expect_empty {
        metrics.empty_expected = 1;
        metrics.false_answers = usize::from(!ids.is_empty());
    }
    // Project leakage: any evidence outside the scope, or any forbidden object.
    let scope = &world.projects[&question.project];
    metrics.project_leaks = result.evidence.iter().filter(|e| &e.project_id != scope).count();
    let forbidden: Vec<&str> = question.forbidden.iter().map(|k| world.objects[k].as_str()).collect();
    metrics.forbidden_hits = ids.iter().filter(|i| forbidden.contains(i)).count();
    // Obsolete-as-current: old wording in a CURRENT slot (title/body of an evidence entry).
    metrics.obsolete_as_current = result.evidence.iter().filter(|e| question.obsolete_text.iter().any(|t| e.title.contains(t.as_str()) || e.body.contains(t.as_str()))).count();
    metrics.historical_discoveries = result.evidence.iter().filter(|e| e.discovery == "historicalDiscovery").count();
    metrics.uploads = result.diagnostics.uploaded_texts;
    metrics.provider_requests = result.diagnostics.embedding_requests;
    metrics
}

struct Run {
    by_class: BTreeMap<String, Metrics>,
    by_lang: BTreeMap<String, Metrics>,
    total: Metrics,
    lexical_ms: Vec<f64>,
    semantic_local_ms: Vec<f64>,
    embedding_ms: Vec<f64>,
    merge_ms: Vec<f64>,
    local_total_ms: Vec<f64>,
    failures: Vec<String>,
}

fn run_config(world: &World, config: Config) -> Run {
    let dir = tempfile::tempdir().unwrap();
    let (service, embedder) = service_for(world, config, dir.path());
    let mut outcome = Run { by_class: BTreeMap::new(), by_lang: BTreeMap::new(), total: Metrics::default(), lexical_ms: vec![], semantic_local_ms: vec![], embedding_ms: vec![], merge_ms: vec![], local_total_ms: vec![], failures: vec![] };
    let requests_before = embedder.request_count();
    for question in &world.questions {
        let result = run(service.retrieve(&world.lab.store, &question.query, &world.projects[&question.project])).unwrap();
        if config != Config::Lexical {
            assert_ne!(result.diagnostics.semantic, SemanticStatus::Disabled, "{}", question.id);
        }
        let metrics = score(world, question, &result);
        if (!question.relevant.is_empty() && metrics.recall8 < 1.0) || metrics.false_answers > 0 {
            let got: Vec<String> = result.evidence.iter().take(4).map(|e| format!("{}:{}", e.title.chars().take(24).collect::<String>(), e.hybrid.admission)).collect();
            outcome.failures.push(format!("{} [{}] \"{}\" R@8={:.2} fa={} got {:?}", question.id, question.class, question.query, metrics.recall8, metrics.false_answers, got));
        }
        outcome.by_class.entry(question.class.clone()).or_default().add(&metrics);
        outcome.by_lang.entry(question.lang.clone()).or_default().add(&metrics);
        outcome.total.add(&metrics);
        let t = result.diagnostics.timings;
        outcome.lexical_ms.push(t.lexical_ms + t.historical_ms);
        outcome.semantic_local_ms.push(t.semantic_local_ms);
        outcome.embedding_ms.push(t.query_embedding_ms);
        outcome.merge_ms.push(t.merge_ms);
        outcome.local_total_ms.push(t.total_ms);
    }
    // The provider-request count the benchmark saw must equal what the provider double actually received.
    assert_eq!(embedder.request_count() - requests_before, outcome.total.provider_requests, "{config:?}: reported provider requests equal observed ones");
    outcome
}

fn percentile(values: &[f64], p: f64) -> f64 {
    let mut sorted: Vec<f64> = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[((sorted.len() as f64 - 1.0) * p).round() as usize]
}

fn report(runs: &[(Config, Run)]) -> String {
    let mut out = String::new();
    let classes: Vec<String> = runs[0].1.by_class.keys().cloned().collect();
    out.push_str("| class | n | ");
    for (config, _) in runs {
        out.push_str(&format!("{} R@1 / R@5 / R@8 / MRR | ", config.name().split_whitespace().next().unwrap()));
    }
    out.push_str("\n|---|---|");
    for _ in runs {
        out.push_str("---|");
    }
    out.push('\n');
    let row = |label: &str, pick: &dyn Fn(&Run) -> Metrics| {
        let first = pick(&runs[0].1);
        let mut line = format!("| {label} | {} | ", first.questions);
        for (_, r) in runs {
            let m = pick(r);
            if m.with_relevant == 0 {
                line.push_str(&format!("false answers {}/{} | ", m.false_answers, m.empty_expected));
            } else {
                line.push_str(&format!("{:.2} / {:.2} / {:.2} / {:.2} | ", m.mean(m.recall1), m.mean(m.recall5), m.mean(m.recall8), m.mean(m.mrr)));
            }
        }
        line.push('\n');
        line
    };
    for class in &classes {
        let class = class.clone();
        out.push_str(&row(&class, &|r| r.by_class[&class].clone()));
    }
    for lang in ["en", "bg", "mixed"] {
        out.push_str(&row(&format!("language: {lang}"), &|r| r.by_lang[lang].clone()));
    }
    out.push_str(&row("ALL (with relevant)", &|r| r.total.clone()));
    out.push_str("\n| config | project leaks | forbidden hits | obsolete-as-current | uploaded texts | provider requests | historical discoveries | zero-result false answers |\n|---|---|---|---|---|---|---|---|\n");
    for (config, r) in runs {
        let t = &r.total;
        out.push_str(&format!("| {} | {} | {} | {} | {} | {} | {} | {}/{} |\n", config.name(), t.project_leaks, t.forbidden_hits, t.obsolete_as_current, t.uploads, t.provider_requests, t.historical_discoveries, t.false_answers, t.empty_expected));
    }
    out.push_str("\n| config | lexical ms p50 / p95 | semantic local ms p50 / p95 | query embedding ms p50 (provider double) | merge ms p95 | local total ms p95 |\n|---|---|---|---|---|---|\n");
    for (config, r) in runs {
        out.push_str(&format!(
            "| {} | {:.2} / {:.2} | {:.2} / {:.2} | {:.2} | {:.3} | {:.2} |\n",
            config.name(),
            percentile(&r.lexical_ms, 0.5),
            percentile(&r.lexical_ms, 0.95),
            percentile(&r.semantic_local_ms, 0.5),
            percentile(&r.semantic_local_ms, 0.95),
            percentile(&r.embedding_ms, 0.5),
            percentile(&r.merge_ms, 0.95),
            percentile(&r.local_total_ms, 0.95)
        ));
    }
    out.lines().map(str::trim_end).collect::<Vec<_>>().join("\n") + "\n"
}

fn recall8(run: &Run, class: &str) -> f64 {
    let m = &run.by_class[class];
    m.mean(m.recall8)
}

#[test]
fn recall_benchmark_offline() {
    let world = build_world();
    let runs: Vec<(Config, Run)> = [Config::Lexical, Config::Semantic, Config::Hybrid].into_iter().map(|c| (c, run_config(&world, c))).collect();
    let text = report(&runs);
    println!("\n=== M04B retrieval benchmark (offline tier: provider DOUBLE, not a real embedding model) ===\n{text}");
    for (config, r) in &runs {
        for failure in &r.failures {
            println!("miss {config:?}: {failure}");
        }
    }
    if let Ok(path) = std::env::var("ARTHUR_RECALL_BENCH_REPORT") {
        std::fs::write(path, text).unwrap();
    }
    let (l, s, h) = (&runs[0].1, &runs[1].1, &runs[2].1);

    // ---- hard gates (M04A benchmark-plan.md 5.1) ----
    for (config, r) in &runs {
        assert_eq!(r.total.project_leaks, 0, "{config:?}: project leakage must be 0");
        assert_eq!(r.total.forbidden_hits, 0, "{config:?}: no forbidden object may appear");
        assert_eq!(r.total.obsolete_as_current, 0, "{config:?}: obsolete wording must never appear in a current slot");
    }
    assert_eq!((l.total.uploads, l.total.provider_requests), (0, 0), "consent OFF: not one text and not one request");

    // ---- retrieval thresholds that this tier can honestly judge (lexical behaviour) ----
    assert!(recall8(l, "lex-direct") >= 0.95, "lex-direct {:.2}", recall8(l, "lex-direct"));
    assert!(recall8(l, "bg-lexical") >= 0.80, "bg-lexical {:.2}", recall8(l, "bg-lexical"));
    assert!(recall8(l, "nfc") >= 1.0);
    assert!(recall8(l, "obsolete-trap") >= 1.0, "old wording must still DISCOVER the object");
    assert!(recall8(l, "old-decision-vs-new-note") >= 1.0);
    assert!(recall8(l, "archived-scope") >= 1.0);
    assert!(recall8(l, "project-isolation") >= 1.0);
    assert!(recall8(l, "injection-content") >= 1.0);
    // Semantic channel exercised: it recovers paraphrases lexical cannot (provider double; see the module note).
    assert!(recall8(s, "semantic-paraphrase") > recall8(l, "semantic-paraphrase"), "S must beat L on paraphrase");
    // Hybrid never loses to the better single channel by more than 2 points overall or in any class.
    let overall = |r: &Run| r.total.mean(r.total.recall8);
    assert!(overall(h) >= overall(l).max(overall(s)) - 0.02, "H {:.3} vs L {:.3} S {:.3}", overall(h), overall(l), overall(s));
    for class in h.by_class.keys() {
        if h.by_class[class].with_relevant > 0 {
            assert!(recall8(h, class) >= recall8(l, class).max(recall8(s, class)) - 0.12, "class {class}: H {:.2} L {:.2} S {:.2}", recall8(h, class), recall8(l, class), recall8(s, class));
        }
    }
    // Zero-result behaviour is REPORTED; the lexical floor must hold on its own.
    let zero = &l.by_class["zero-result"];
    assert!(zero.false_answers <= 1, "lexical false answers {}/{}", zero.false_answers, zero.empty_expected);
}

// =====================================================================================================================
// Scale tier
// =====================================================================================================================

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

fn interpret_for_probe(text: &str) -> String {
    super::query::match_expression(&super::query::interpret(text).unwrap()).unwrap()
}

fn rss_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmRSS:")).and_then(|l| l.split_whitespace().nth(1).and_then(|v| v.parse().ok())))
        .unwrap_or(0)
}

/// 10,000 objects over 20 projects (Zipf-sized, the largest ~30% of everything), a third of them edited once or twice (so
/// ~16,000 revisions), embedded with the provider double at 512 dimensions. Measures latency per stage, SQL statements per question,
/// query plans, vector-scan memory, and that stale vectors cost no provider calls.
///
/// `cargo test --release --lib recall_benchmark_scale -- --ignored --nocapture`
#[test]
#[ignore = "scale tier: run in release mode"]
fn recall_benchmark_scale() {
    let total: usize = std::env::var("ARTHUR_RECALL_SCALE").ok().and_then(|v| v.parse().ok()).unwrap_or(10_000);
    let mut rng = Lcg(0x5eed);
    let vocabulary_size: usize = std::env::var("ARTHUR_RECALL_VOCAB").ok().and_then(|v| v.parse().ok()).unwrap_or(500);
    let vocabulary: Vec<String> = (0..vocabulary_size).map(|i| if i % 5 == 0 { format!("дума{}", i * 7) } else { format!("word{}", i * 13) }).collect();
    let lab = Lab::new();
    let project_count = 20;
    let projects: Vec<String> = (0..project_count).map(|i| lab.project(&format!("Project {i}"))).collect();
    // Zipf-ish: project i gets weight 1/(i+1).
    let weights: Vec<f64> = (0..project_count).map(|i| 1.0 / (i as f64 + 1.0)).collect();
    let weight_sum: f64 = weights.iter().sum();
    let pick_project = |rng: &mut Lcg| {
        let mut x = (rng.next() % 1_000_000) as f64 / 1_000_000.0 * weight_sum;
        for (i, w) in weights.iter().enumerate() {
            if x < *w {
                return i;
            }
            x -= w;
        }
        project_count - 1
    };
    let words = |rng: &mut Lcg, n: usize| (0..n).map(|_| vocabulary[(rng.below(vocabulary.len()) * rng.below(vocabulary.len())) % vocabulary.len()].clone()).collect::<Vec<_>>().join(" ");

    let built = std::time::Instant::now();
    let mut ids = Vec::with_capacity(total);
    let mut sizes = vec![0usize; project_count];
    for i in 0..total {
        let p = pick_project(&mut rng);
        sizes[p] += 1;
        let kind = ["idea", "task", "decision", "question", "note"][i % 5];
        ids.push((lab.object(&projects[p], kind, &format!("Topic {}", words(&mut rng, 3)), &words(&mut rng, 24)), p));
    }
    let mut edits = 0;
    for (id, _) in ids.iter().step_by(3) {
        lab.edit(id, Some(&format!("Revised {}", words(&mut rng, 3))), Some(&words(&mut rng, 24)));
        edits += 1;
        if rng.below(3) == 0 {
            lab.edit(id, None, Some(&words(&mut rng, 24)));
            edits += 1;
        }
    }
    let revisions = lab.store.recall_indexed_revision_count().unwrap();
    println!("\n=== scale corpus: {total} objects, vocabulary {vocabulary_size} words, {revisions} revisions ({edits} edits), {project_count} projects; largest {} objects; built in {:?} ===", sizes.iter().max().unwrap(), built.elapsed());

    let embedder = Arc::new(ConceptEmbedder::new(512, &[]));
    let dir = tempfile::tempdir().unwrap();
    let service = RecallService::new(embedder.clone(), Arc::new(SemanticSettings::new(dir.path().join("s.json"))));
    service.settings().set(service.model_key(), true).unwrap();
    let indexing = std::time::Instant::now();
    let mut embedded = 0;
    loop {
        let report = run(service.index_pending(&lab.store, 1_024)).unwrap();
        embedded += report.embedded;
        if report.remaining == Some(0) || report.embedded == 0 {
            break;
        }
    }
    println!("indexed {embedded} vectors (512 dims) with the provider double in {:?}", indexing.elapsed());

    // Query plans of the hot statements.
    let largest = projects[sizes.iter().enumerate().max_by_key(|(_, n)| **n).unwrap().0].clone();
    let lexical_plan = lab.store.recall_explain_for_test("lexical", &largest);
    let semantic_plan = lab.store.recall_explain_for_test("semantic", &largest);
    println!("lexical plan:\n  {}\nsemantic plan:\n  {}", lexical_plan.join("\n  "), semantic_plan.join("\n  "));
    assert!(lexical_plan.iter().any(|l| l.contains("VIRTUAL TABLE INDEX")), "FTS5 drives the lexical query");
    assert!(!lexical_plan.iter().any(|l| l.starts_with("SCAN o") || l.starts_with("SCAN knowledge_objects") || l.starts_with("SCAN cr") || l.starts_with("SCAN thought_revisions")), "the lexical path does not scan authoritative tables: {lexical_plan:?}");
    assert!(semantic_plan.iter().any(|l| l.contains("knowledge_objects_by_project")), "project filtering uses the project index: {semantic_plan:?}");

    // The semantic scan of a SMALL project beside a large one: pinned (shipped) vs the old unpinned form.
    let smallest = projects[sizes.iter().enumerate().filter(|(_, n)| **n > 0).min_by_key(|(_, n)| **n).unwrap().0].clone();
    for (label, project) in [("smallest", &smallest), ("largest", &largest)] {
        for unpinned in [false, true] {
            let c = lab.store.recall_semantic_scan_cost_for_test(unpinned, project, service.model_key().as_str(), 512);
            println!("semantic scan {label} project ({} rows), {}: {} vm steps, {:.2} ms; plan {:?}", c.rows, if unpinned { "UNPINNED (old)" } else { "pinned (shipped)" }, c.vm_steps, c.micros as f64 / 1000.0, c.plan);
        }
    }
    // Where does lexical time go?
    let probe_query = interpret_for_probe("Topic word13 word26");
    for (name, ms, rows) in lab.store.recall_lexical_probe_for_test(&probe_query, &largest) {
        println!("lexical probe [{name}]: {ms:.2} ms, {rows} rows");
    }

    // Questions: 2-3 vocabulary words, in a project chosen like the data (so most questions land in big projects).
    let mut queries: Vec<(String, String)> = Vec::new();
    for _ in 0..300 {
        let count = 2 + rng.below(2);
        let project = projects[pick_project(&mut rng)].clone();
        queries.push((format!("Topic {}", words(&mut rng, count)), project));
    }
    let rss_before = rss_kb();
    let requests_before = embedder.request_count();
    let (mut lexical, mut semantic_local, mut embedding, mut merge, mut local, mut wall, mut reads) = (vec![], vec![], vec![], vec![], vec![], vec![], vec![]);
    let mut empty = 0;
    for (query, project) in &queries {
        let result = run(service.retrieve(&lab.store, query, project)).unwrap();
        let t = result.diagnostics.timings;
        lexical.push(t.lexical_ms + t.historical_ms);
        semantic_local.push(t.semantic_local_ms);
        embedding.push(t.query_embedding_ms);
        merge.push(t.merge_ms);
        local.push(t.total_ms);
        wall.push(t.wall_ms);
        reads.push(result.diagnostics.sql_reads as f64);
        empty += usize::from(result.evidence.is_empty());
        assert!(result.evidence.iter().all(|e| e.project_id == *project), "no leakage at scale");
    }
    let requests = embedder.request_count() - requests_before;
    println!("{} questions ({} empty); provider requests {requests} (= one query embedding each); RSS {} kB -> {} kB", queries.len(), empty, rss_before, rss_kb());
    println!("| stage | p50 ms | p95 ms | p99 ms |\n|---|---|---|---|");
    for (name, values) in [("lexical (+historical)", &lexical), ("semantic local scan+resolve", &semantic_local), ("query embedding (double, NOT network)", &embedding), ("merge", &merge), ("local total (excl. embedding wait)", &local), ("wall", &wall)] {
        println!("| {name} | {:.2} | {:.2} | {:.2} |", percentile(values, 0.5), percentile(values, 0.95), percentile(values, 0.99));
    }
    println!("SQL statements per question: min {} max {}", reads.iter().cloned().fold(f64::MAX, f64::min), reads.iter().cloned().fold(0.0, f64::max));
    assert_eq!(requests as usize, queries.len());
    assert!(reads.iter().all(|r| *r <= 8.0), "a constant, small number of statements per question");

    // Staleness at scale costs no provider call: edit 200 objects, ask again.
    for (id, _) in ids.iter().skip(1).step_by(50).take(200) {
        lab.edit(id, Some("Stale now"), Some("totally different text"));
    }
    let pending = service.semantic_status(&lab.store).unwrap().pending_objects;
    let before = embedder.request_count();
    for (query, project) in queries.iter().take(50) {
        run(service.retrieve(&lab.store, query, project)).unwrap();
    }
    assert_eq!(embedder.request_count() - before, 50, "rejecting {pending} stale vectors needed no provider call beyond the 50 query embeddings");
    println!("stale vectors after {pending} edits: excluded without provider calls (50 questions, 50 requests)");
    assert!(percentile(&local, 0.95) < 100.0, "local retrieval p95 within the 100 ms budget (release)");
}

/// The same golden questions with the REAL embedding provider. Needs `ARTHUR_OPENAI_API_KEY` and the network; never runs in CI.
#[test]
#[ignore = "live tier: needs ARTHUR_OPENAI_API_KEY and the network"]
fn recall_benchmark_live() {
    use crate::providers::credentials::{ApiKey, CredentialSource};
    use crate::providers::embed::OpenAiEmbedder;
    struct EnvKey;
    impl CredentialSource for EnvKey {
        fn api_key(&self) -> Option<ApiKey> {
            std::env::var("ARTHUR_OPENAI_API_KEY").ok().and_then(|k| ApiKey::parse(&k))
        }
    }
    let world = build_world();
    let dir = tempfile::tempdir().unwrap();
    let service = RecallService::new(Arc::new(OpenAiEmbedder::new(Arc::new(EnvKey)).unwrap()), Arc::new(SemanticSettings::new(dir.path().join("s.json"))));
    service.settings().set(service.model_key(), true).unwrap();
    let report = run(service.index_pending(&world.lab.store, INDEX_RUN_LIMIT)).unwrap();
    assert_eq!(report.remaining, Some(0), "{report:?}");
    let mut total = Metrics::default();
    let mut by_class: BTreeMap<String, Metrics> = BTreeMap::new();
    let mut embedding = Vec::new();
    for question in &world.questions {
        let result = run(service.retrieve(&world.lab.store, &question.query, &world.projects[&question.project])).unwrap();
        let metrics = score(&world, question, &result);
        embedding.push(result.diagnostics.timings.query_embedding_ms);
        by_class.entry(question.class.clone()).or_default().add(&metrics);
        total.add(&metrics);
    }
    println!("\n=== LIVE tier: {} ===", service.model_key());
    for (class, m) in &by_class {
        println!("{class}: n={} R@1 {:.2} R@5 {:.2} R@8 {:.2} MRR {:.2} false answers {}/{}", m.questions, m.mean(m.recall1), m.mean(m.recall5), m.mean(m.recall8), m.mean(m.mrr), m.false_answers, m.empty_expected);
    }
    println!("ALL: R@8 {:.2}; leaks {}; obsolete-as-current {}; query embedding p50 {:.0} ms p95 {:.0} ms (network)", total.mean(total.recall8), total.project_leaks, total.obsolete_as_current, percentile(&embedding, 0.5), percentile(&embedding, 0.95));
    assert_eq!((total.project_leaks, total.obsolete_as_current), (0, 0));
}

// =====================================================================================================================
// Live tier: similarity-floor calibration with the REAL embedding provider
// =====================================================================================================================

/// Delegates to a real provider but remembers every text it has embedded, so a threshold sweep re-uses one embedding per text
/// instead of paying for it once per threshold. (Only the sweep harness does this; the product never caches.)
struct CachingProvider {
    inner: Arc<dyn crate::providers::embed::EmbeddingProvider>,
    cache: std::sync::Mutex<HashMap<String, Vec<f32>>>,
    real_requests: std::sync::atomic::AtomicU32,
    real_texts: std::sync::atomic::AtomicU32,
}

impl crate::providers::embed::EmbeddingProvider for CachingProvider {
    fn model_key(&self) -> &crate::providers::embed::ModelKey {
        self.inner.model_key()
    }

    fn dims(&self) -> usize {
        self.inner.dims()
    }

    fn embed<'a>(&'a self, texts: &'a [String], purpose: crate::providers::embed::EmbedPurpose) -> crate::async_util::BoxFuture<'a, Result<Vec<Vec<f32>>, crate::providers::embed::EmbedFailure>> {
        Box::pin(async move {
            let missing: Vec<String> = {
                let cache = self.cache.lock().unwrap();
                texts.iter().filter(|t| !cache.contains_key(*t)).cloned().collect::<std::collections::BTreeSet<_>>().into_iter().collect()
            };
            if !missing.is_empty() {
                for chunk in missing.chunks(self.inner.max_batch()) {
                    self.real_requests.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    self.real_texts.fetch_add(chunk.len() as u32, std::sync::atomic::Ordering::SeqCst);
                    let vectors = self.inner.embed(chunk, purpose).await?;
                    let mut cache = self.cache.lock().unwrap();
                    for (text, vector) in chunk.iter().zip(vectors) {
                        cache.insert(text.clone(), vector);
                    }
                }
            }
            let cache = self.cache.lock().unwrap();
            Ok(texts.iter().map(|t| cache[t].clone()).collect())
        })
    }
}

fn evaluate(world: &World, service: &RecallService) -> (BTreeMap<String, Metrics>, Metrics) {
    let mut by_class: BTreeMap<String, Metrics> = BTreeMap::new();
    let mut total = Metrics::default();
    for question in &world.questions {
        let result = run(service.retrieve(&world.lab.store, &question.query, &world.projects[&question.project])).unwrap();
        let metrics = score(world, question, &result);
        by_class.entry(question.class.clone()).or_default().add(&metrics);
        total.add(&metrics);
    }
    (by_class, total)
}

/// Sweeps the semantic similarity floor against the real provider. Needs `ARTHUR_OPENAI_KEY_FILE` (a file holding the key, as in the
/// app's credentials directory) or `ARTHUR_OPENAI_API_KEY`, and the network. The key is only ever read, never printed.
///
/// `ARTHUR_OPENAI_KEY_FILE=... cargo test --release --lib recall_threshold_sweep -- --ignored --nocapture`
#[test]
#[ignore = "live tier: needs a real OpenAI key and the network"]
fn recall_threshold_sweep() {
    use crate::providers::credentials::{ApiKey, CredentialSource, FileCredentialSource};
    use crate::providers::embed::{EmbedPurpose, EmbeddingProvider, OpenAiEmbedder};
    struct EnvKey;
    impl CredentialSource for EnvKey {
        fn api_key(&self) -> Option<ApiKey> {
            std::env::var("ARTHUR_OPENAI_API_KEY").ok().and_then(|k| ApiKey::parse(&k))
        }
    }
    let credentials: Arc<dyn CredentialSource> = match std::env::var("ARTHUR_OPENAI_KEY_FILE") {
        Ok(path) => Arc::new(FileCredentialSource::new(path.into())),
        Err(_) => Arc::new(EnvKey),
    };
    let world = build_world();
    let provider = Arc::new(CachingProvider { inner: Arc::new(OpenAiEmbedder::new(credentials).unwrap()), cache: Default::default(), real_requests: Default::default(), real_texts: Default::default() });
    let dir = tempfile::tempdir().unwrap();
    let settings = Arc::new(SemanticSettings::new(dir.path().join("s.json")));
    let make = |tau: f32, lexical: bool| {
        let service = RecallService::new(provider.clone(), settings.clone()).with_min_cosine(tau);
        service.lexical_enabled.store(lexical, std::sync::atomic::Ordering::SeqCst);
        service
    };
    let seed = make(0.0, false);
    seed.settings().set(seed.model_key(), true).unwrap();
    assert_eq!(run(seed.index_pending(&world.lab.store, INDEX_RUN_LIMIT)).unwrap().remaining, Some(0));
    // Embed every question once, up front (one provider batch per 64 texts).
    let queries: Vec<String> = world.questions.iter().map(|q| q.query.clone()).collect();
    run(provider.embed(&queries, EmbedPurpose::Query)).unwrap();
    println!("\n=== LIVE threshold sweep: {} ===\nprovider: {} requests, {} texts embedded in total (documents + {} questions); everything after this is cached", seed.model_key(), provider.real_requests.load(std::sync::atomic::Ordering::SeqCst), provider.real_texts.load(std::sync::atomic::Ordering::SeqCst), queries.len());

    // Cosine distributions (floor 0: nothing is hidden). Semantic channel only.
    let open = make(0.0, false);
    let mut relevant_best: Vec<(f32, String)> = Vec::new();
    let mut empty_top: Vec<(f32, String)> = Vec::new();
    for question in &world.questions {
        let result = run(open.retrieve(&world.lab.store, &question.query, &world.projects[&question.project])).unwrap();
        let relevant: Vec<&str> = question.relevant.iter().map(|k| world.objects[k].as_str()).collect();
        if question.expect_empty {
            if let Some(top) = result.evidence.first().and_then(|e| e.semantic.as_ref()) {
                empty_top.push((top.cosine, format!("{} \"{}\"", question.id, question.query)));
            }
        } else if let Some(best) = result.evidence.iter().filter(|e| relevant.contains(&e.object_id.as_str())).filter_map(|e| e.semantic.as_ref()).map(|s| s.cosine).max_by(f32::total_cmp) {
            relevant_best.push((best, format!("{} [{}] \"{}\"", question.id, question.class, question.query)));
        }
    }
    relevant_best.sort_by(|a, b| a.0.total_cmp(&b.0));
    empty_top.sort_by(|a, b| b.0.total_cmp(&a.0));
    println!("\ncosine of the BEST RELEVANT object per answerable question (lowest 12 of {}):", relevant_best.len());
    for (c, name) in relevant_best.iter().take(12) {
        println!("  {c:.3}  {name}");
    }
    println!("top-1 cosine per question that must return NOTHING (highest 13 of {}):", empty_top.len());
    for (c, name) in empty_top.iter().take(13) {
        println!("  {c:.3}  {name}");
    }

    // The sweep.
    let taus = [0.15f32, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55];
    let lexical = evaluate(&world, &make(1.1, true)); // lexical only: a floor above 1 hides the semantic channel
    println!("\n| floor | channel | para R@1/5/8 | ALL R@1/5/8 | MRR | zero-result false pos (8) | all must-be-empty false pos (13) | project leaks | obsolete-as-current | forbidden |\n|---|---|---|---|---|---|---|---|---|---|");
    let row = |floor: &str, channel: &str, (by_class, total): &(BTreeMap<String, Metrics>, Metrics)| {
        let p = &by_class["semantic-paraphrase"];
        println!(
            "| {floor} | {channel} | {:.2} / {:.2} / {:.2} | {:.2} / {:.2} / {:.2} | {:.2} | {}/{} | {}/{} | {} | {} | {} |",
            p.mean(p.recall1), p.mean(p.recall5), p.mean(p.recall8),
            total.mean(total.recall1), total.mean(total.recall5), total.mean(total.recall8), total.mean(total.mrr),
            by_class["zero-result"].false_answers, by_class["zero-result"].empty_expected, total.false_answers, total.empty_expected,
            total.project_leaks, total.obsolete_as_current, total.forbidden_hits
        );
    };
    row("n/a", "L lexical", &lexical);
    for tau in taus {
        row(&format!("{tau:.2}"), "S semantic", &evaluate(&world, &make(tau, false)));
        row(&format!("{tau:.2}"), "H hybrid", &evaluate(&world, &make(tau, true)));
    }
}
