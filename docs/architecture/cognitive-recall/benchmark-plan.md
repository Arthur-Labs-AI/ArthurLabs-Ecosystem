# Benchmark plan

The benchmark exists to **prove or disprove** each architectural layer (hybrid, Graph, Lineage, budget) before it ships default-on,
and to make ranking inspectable. It is written before implementation and is the acceptance gate for M04B.

## 1. Where it lives and how it runs

* A Rust test target in `apps/arthur/src-tauri` (e.g. `tests/recall_bench/`), fixtures as JSON under the same folder (kept out of
  production code). Runs on an in-memory/temp SQLite built by the **real** store write paths (distillation, edit, branch,
  merge, move, relations) so the corpus exercises the same invariants as production.
* **Offline deterministic tier (CI):** fake embedder (stable hash/bag-of-words projection) + fake synthesizer. Measures everything
  except true semantic quality and LLM quality. Fully reproducible.
* **Live tier (manual / nightly, opt-in key):** real `text-embedding-3-small` vectors (cached to a fixture so reruns are free) and the
  real answer model; measures semantic Recall, grounding, latency, provider calls. Results are recorded as versioned JSON reports.
* Reports are diffable per configuration; a regression gate compares to the stored baseline.

## 2. Datasets

### 2.1 Golden corpus (hand-authored, ~350 objects, ~12 projects)

A believable personal knowledge base (the user's own domains: a hardware/wearable project, the Arthur app, personal planning,
travel, a noisy Inbox), written with realistic distillation-style objects, relations (all seven kinds, all three origins), revisions
(edits, branches not current, merges current and not current, new-capture revisions), moved objects, an archived project, and
captures with exact spans. **Each language mixed in on purpose.**

### 2.2 Scale corpus (generated)

10,000 objects, ~50,000 relations, ~30,000 revisions across 20 projects, with Zipfian project sizes (largest ~5,000), seeded and
reproducible. Used for latency, memory, N+1 and scan-cost measurement, plus precision under distractor load (the golden corpus is
embedded inside it).

### 2.3 Question set (~400 questions)

Each question: `id, class, language, scopeProjectId, query`, graded relevant objects (0-3), `mustNotAppear` (leak/obsolete
traps), expected provenance (captureId + span), required answer facts (for grounding), `expectInsufficient`.

| Class | Count | Tests |
|---|---|---|
| `lex-direct` | 40 | exact names/terms; lexical must be near-perfect |
| `semantic-paraphrase` | 40 | no shared terms ("works without network" vs "offline-first") |
| `dependency` | 35 | "what does X depend on / what depends on X", incl. 2-hop chains |
| `contradiction` | 25 | conflicting decisions across objects |
| `decision-why` | 35 | decision + rationale + predecessors |
| `evolution` | 35 | how an idea changed; branches, merges; old wording absent from current |
| `provenance` | 30 | "where did this come from" -> exact capture span |
| `task-from` | 20 | tasks derived from an idea |
| `project-isolation` | 40 | answer exists ONLY in another project; same terms in several projects |
| `cross-project-edge` | 20 | in-scope seed with an external neighbour (allowed, flagged) vs external-only (forbidden) |
| `obsolete-trap` | 30 | the old revision/object matches better than the current; superseded decisions |
| `old-decision-vs-new-note` | 15 | recency must not beat relevance |
| `zero-result` | 40 | nothing relevant; must say so |
| `bg-lexical` | 45 | Bulgarian inflection/definite article/plurals |
| `en-lexical` | 25 | English baseline for the BG gap |
| `mixed-language` | 35 | BG query over EN objects, EN query over BG, code-switched objects |
| `prompt-injection` | 25 | objects/captures with override text, fake handles, fake JSON |
| `archived-scope` | 20 | explicit Recall on an archived project works (read-only); an archived neighbour of an active-project seed is **never** admitted; archived projects never appear implicitly |
| `consent-off` | 15 | semantic Recall not enabled / switched off: zero embedding requests (counted by the fake provider), retained vectors ignored, lexical metrics identical to `L`; enabling then disabling stops uploads at once |
| `nfc` | 10 | decomposed Cyrillic text and stress marks |
| `distillation-miss` | 15 | fact exists only in raw capture text (decides `capture_fts`) |
| `scale-distractor` | 40 | golden questions re-run inside the 10k corpus |

Classes overlap in language, so every class that matters is run for BG, EN and mixed where applicable.

## 3. Configurations compared

| ID | Pipeline |
|---|---|
| `L` | lexical only (**the default product configuration until the user opts in**) |
| `S` | semantic only |
| `H` | hybrid (L + S, RRF) |
| `HG` | H + bounded Graph expansion |
| `HGL` | HG + selective Lineage + provenance + budgeted context |
| `Full` | HGL + synthesis (live tier) |
| ablations | `HG` with hop 2; `H` with each of K, title weight, phrase bonus, tau_sem, dims 512/1536; `L` +trigram |

## 4. Metrics

Retrieval (against graded relevance):

* **Recall@K** (K = 8 seeds, 20, 40), **MRR**, **nDCG@10**.
* **Evidence precision:** fraction of *supplied* evidence entries that are relevant (grade >= 1), reported with and without
  expanded entries, to show what Graph costs in noise.
* **Evidence recall:** fraction of graded-relevant objects present *anywhere* in the final package (what the model can use).
* **Project leakage rate:** evidence entries with `project != scope` that are not admitted by the §2.1 rule (hard 0), and any
  object/revision from an out-of-scope project appearing in a candidate list.
* **Obsolete-revision leakage:** a non-current revision's text appearing in a `current`-status slot, or a `mustNotAppear`
  object ranked above its replacer. Measured at retrieval (package) and at answer level (judge).
* **Provenance correctness:** evidence `origin` capture/span equals the store; excerpt equals the slice of that capture by code
  points; no provenance for edited text (deterministic, 100%).
* **Zero-result behaviour:** false-answer rate (answered when `expectInsufficient`) and false-refusal rate.
* **Context:** estimated evidence tokens vs budget (never over), truncation steps used, answer-relevant evidence lost to truncation.

Answer-level (live tier):

* **Grounding rate:** share of answer claims supported by supplied evidence (LLM judge with the evidence, spot-audited by hand on
  a 10% sample; kept separate from retrieval metrics so judge noise cannot gate retrieval).
* **Citation validity:** share of raw model `basedOn` handles that exist; after validation must be 100% (see gate).
* **Temporal correctness:** history presented as current (judge) rate.
* **Required facts recalled** per question.
* **Latency** per stage (p50/p95/p99), **provider calls** per ask, **estimated cost**, peak RSS.

## 5. Acceptance thresholds (M04B cannot be called done below these)

### 5.1 Hard gates (any failure blocks)

| Gate | Threshold |
|---|---|
| Project leakage (candidates, evidence) | **0** across `project-isolation` and `cross-project-edge` |
| Obsolete-as-current in the package | **0** across `obsolete-trap` |
| Provenance correctness | **100%** |
| Invalid evidence handles reaching the UI | **0** (stripped by validation); raw model invalid rate <= 3% |
| Context over budget | **0** requests |
| Prompt-injection behavioural change | **0** of 25; zero unknown handles |
| Migration: v6 data fingerprint unchanged | exact |
| Lexical available with semantic Recall off/failing | all `L` metrics unchanged by the failure |
| Consent: embedding requests while semantic Recall is off | **0** (any provider call is a failure) |
| Archived external object admitted as evidence | **0** |

### 5.2 Retrieval thresholds (golden corpus, offline tier unless noted)

| Metric | Threshold |
|---|---|
| `L` Recall@8 on `lex-direct` | >= 0.95 |
| `en-lexical` Recall@8 (`L`) | >= 0.85 |
| `bg-lexical` Recall@8 (`L`) | >= 0.80 and within 10 pp of English, else add trigram (B1) |
| `H` Recall@8 overall | >= max(`L`, `S`) overall + 5 pp, and not worse than the better single channel in **any** class by more than 2 pp |
| `S` or `H` Recall@8 on `semantic-paraphrase` (live) | >= 0.75 |
| `mixed-language` Recall@8 (`H`, live) | >= 0.70 |
| `old-decision-vs-new-note` | the correct (older) object ranked above the newer note in >= 90% |
| `H` MRR | no regression vs `L` in `lex-direct` |
| `scale-distractor` Recall@8 | within 5 pp of the small-corpus value |

### 5.3 Graph and Lineage must earn their place

Each layer is judged **only on the classes it is meant to help**, not on every question (a graph that cannot help a lexical lookup
should not be blamed for it, and cannot hide a regression there either; see the guard rows).

**Graph** (`HG` vs `H`). Graph-dependent classes: `dependency`, `contradiction`, `task-from` (and the graph-derived part of
`obsolete-trap`: `supersedes`/`duplicates` marking).

| Criterion | Threshold |
|---|---|
| Primary lift on graph-dependent classes (pooled, macro-averaged over classes and over languages) | **Evidence Recall@K improves by >= 10 percentage points, OR the Evidence Recall@K error (1 - recall) falls by >= 20% relative** (either suffices) |
| Project-leakage regression | **none**: leakage stays 0 (hard gate) |
| Guard (non-graph classes: `lex-direct`, `semantic-paraphrase`, `zero-result`, `bg-lexical`, `en-lexical`) | no class loses more than 2 pp Recall@8, and `zero-result` false-answer rate does not rise |
| Cost guard | evidence precision loss <= 5 pp, evidence tokens +<= 25% on the graph-dependent classes |

"Evidence Recall@K" is the fraction of graded-relevant objects present in the final evidence package at K = the package's seed +
expanded budget (<= 20 objects). The relative rule exists because on classes where `H` is already strong a 10 pp absolute lift
may be impossible (e.g. 0.90 -> 0.92 removes 20% of the error).
Failing both: graph expansion ships **off by default** (built and tested, enabled per proven intent only if a sub-class passes).

**Lineage** (`HGL` vs `HG`). Lineage-dependent classes: `evolution` (including branches, merges, new-capture revisions) and
`decision-why`.

| Criterion | Threshold |
|---|---|
| Primary lift on those classes (pooled, macro-averaged) | **Required-fact coverage improves by >= 15 percentage points** |
| Obsolete-revision-as-current regressions | **zero** (hard gate; any new case where historical or `branch_not_current` text appears in a `current` slot, at package level or in a judged answer, blocks) |
| Guard | no non-lineage class changes by more than 1 pp Recall@8; evidence tokens within budget (100%) |

Failing: Lineage is restricted to evolution intent only; if it still fails, current-only.

**Other layers**

| Layer | Pass criterion | Otherwise |
|---|---|---|
| 2nd hop exception (`G1`) | >= +5 pp Evidence Recall@K on 2-hop dependency/supersedes chains, precision loss <= 3 pp, leakage 0 | remove 2nd hop |
| Historical nomination (pipeline §6.4) | `evolution` Recall@8 of objects whose old wording is gone from current: **>= +20 pp** vs without | drop the path |
| Intent weights | `HG` with weights vs uniform: **>= +3 pp** Evidence Recall@K on the intent classes | collapse to one default weight set |

### 5.4 Answer thresholds (live tier)

| Metric | Threshold |
|---|---|
| Grounding rate | >= 0.92 (judge), >= 0.90 hand-audit sample |
| Required facts recalled (`Full`) | >= 0.80 on answerable classes |
| `zero-result` false-answer rate | <= 5% (`insufficient_evidence` expected) |
| False-refusal on answerable | <= 8% |
| Temporal errors (history as current, in answers) | <= 2% |
| `project-isolation` answers using out-of-scope facts | 0 |

### 5.5 Performance (scale corpus, desktop reference; mobile reference device x2.5)

| Metric | Threshold |
|---|---|
| Local retrieval (all stages excl. network) p95 | <= 100 ms |
| FTS stage p95 | <= 25 ms; semantic scan p95 (5k in scope) <= 40 ms |
| End-to-end p50 / p95 | <= 4 s / <= 8 s |
| Provider calls per ask | <= 1 embedding + <= 2 chat (typical 1 + 1) |
| Evidence tokens | <= 6,000 est. (100% of requests) |
| Queries issued per ask (SQL) | constant in the number of seeds (no N+1; asserted with a statement counter) |
| FTS backfill, 30k revisions | <= 2 s (else moved post-open) |

## 6. Experiments that decide open choices

| Id | Question | Method | Decision rule |
|---|---|---|---|
| `B1` | Trigram needed for Bulgarian? | `L` vs `L`+trigram on `bg-lexical`, `nfc` | add if `L` BG Recall@8 < 0.80 or > 10 pp below EN |
| `B2` | Title weight 4/8/16 | `L` MRR | best nDCG@10 |
| `E1` | 512 vs 1536 dims | `S` Recall@8, size, scan time | 1536 only if >= +3 pp Recall@8 |
| `E2` | Embed historical revisions? | evolution Recall with/without | only if lexical nomination < threshold and embeddings give >= +10 pp |
| `S1` | `tau_sem` per language | zero-result false-answer vs Recall sweep | smallest tau with false-answer <= 5% and Recall loss <= 2 pp |
| `F1` | RRF `K` 30/60/100 | `H` nDCG | best, ties -> 60 |
| `F2` | Need a reranker? | precision@8 and recall@40 | only if p@8 < 0.6 while recall@40 > 0.9 |
| `F3` | Seed cap / cutoff | Recall@K vs tokens | smallest cap within 1 pp of best |
| `F4` | Phrase bonus | `H` MRR | best |
| `G1` | 2-hop exception | `HG` ablation | §5.3 |
| `I1` | Rule intent vs LLM intent | intent-class evidence recall | LLM intent only if +>= 8 pp for +1 request |
| `P1` | Need in-memory vector matrix cache? | scale p95 | only if semantic scan p95 > budget |
| `D1` | `capture_fts` needed? | `distillation-miss` Recall | add if >= 30% of those facts are lexically absent from objects |

## 7. Process

1. Build fixtures and the harness first (M04B step 0); freeze the question set before tuning (tuning on a held-out 30% split).
2. Implement lexical -> run `L`; add semantic -> run `S`, `H`; add Graph -> `HG`; add Lineage -> `HGL`; each step must clear its gate
   before the next layer is built on it.
3. Every parameter change is recorded with its report; defaults in this folder are updated only from a recorded run.
