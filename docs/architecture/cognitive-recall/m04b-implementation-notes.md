# M04B implementation notes: the retrieval core

Status: implemented on `feature/cognitive-runtime-v1` (uncommitted at the time of writing). This records what was built, where it
differs from the M04A design, and what was measured. The M04A documents remain the architecture; where this file disagrees with
them, this file describes the code.

## What exists

| Area | Where |
|---|---|
| Schema v7 (FTS5 over `thought_revisions`, `recall_embeddings`, `recall_meta`) | `storage/migrations.rs` (`SCHEMA_V7`) |
| Retrieval reads and index writes (the only SQLite code for Recall) | `storage/recall_store.rs` |
| Query interpretation, stem-prefixes, FTS expression, intent weights | `recall/query.rs` |
| Deterministic RRF ranking and seed selection (pure) | `recall/ranking.rs` |
| Evidence contract and errors | `recall/evidence.rs` |
| Lexical fallback scan | `recall/lexical.rs` |
| Consent (app-private, fails closed) | `recall/settings.rs` |
| Orchestration, overlap of lexical and query embedding, lazy indexer | `recall/service.rs` |
| Embedding provider abstraction + OpenAI `text-embedding-3-small` @ 512 | `providers/embed.rs` |
| Native commands (debug retrieval, consent, purge) | `commands/recall.rs` |
| Tests, benchmark, platform acceptance | `recall/service_tests.rs`, `recall/bench.rs` (+ `bench/golden.json`), `recall/acceptance.rs`, `recall/testing.rs` |

No `ArthurClient` method, contract type or React code was added. `recall_retrieve` is an explicitly debug/test native command that
returns ranked evidence and diagnostics; it produces no answer and calls no model.

## Deviations from M04A (and why)

1. **Historical contribution is stricter than specified.** M04A added `0.5/(K+rank)` for any object nominated by the historical
   path. Implemented: only for objects with **no admitted current lexical match**. An object whose current text already matches
   gets nothing from its history, which is the "current wins" rule stated without exception (test:
   `when_the_current_wording_matches_current_wins_and_history_adds_nothing`).
2. **No `has_non_nfc` flag.** The query always emits both the NFC and the NFD form of each token (only where they differ), so
   decomposed stored text is found without tracking a flag (test: Bulgarian decomposed `й`).
3. **`recall_meta` holds only `fts_tokenizer_version`.** No `active_model_key`/`tau_sem` rows: the active key is the compiled
   provider's, and `tau_sem` is a constant until benchmark `S1`. Consent is **not** in the database.
4. **Consent is bound to the model key** (`provider:model:dims:template`), as the README's decision described. A saved "yes" for
   another key is not consent for this one.
5. **Indexer triggers.** M04A listed "after distillation and after edits". Implemented as: app start, after enabling, after a
   retrieval that found partial coverage, and a 60 s poll. Distillation and Lineage commands are **not modified**, so those systems
   stay unaware of Recall (an architecture guard asserts it). Cost: a new object's vector can appear up to 60 s later; lexical
   recall is immediate.
6. **Semantic scan SQL pins the join order with `CROSS JOIN`** (so that unrelated projects' vectors are NOT read). Without it the
   planner started from `recall_embeddings(model_key)`, i.e. every vector of the model in every project, probed each owning object,
   and only then dropped other projects' rows. `CROSS JOIN` forces the order the other way: scoped `knowledge_objects` through
   `knowledge_objects_by_project`, then one primary-key probe per vector. See "Hardening pass" for the measured proof.
7. **Silent index loss is detected.** An emptied FTS index answers every query with "no match" and no error. An empty current
   result now verifies `docsize` rows == `thought_revisions` rows; if not, the fallback scan answers (`degradedScan`) and the
   index is rebuilt once per process. (Added to the failure model.)
8. **Dependency:** `unicode-normalization` (pure Rust) for NFC. It is the only new production dependency.
9. **Evidence returns the whole fused pool (<= 40) with `isSeed`** rather than only seeds, so Recall@K is measurable and a later
   enrichment stage can choose its own cut.
10. **Benchmark size.** 78 questions over a 35-object golden corpus (4 projects including one archived, Inbox, BG/EN/mixed,
    history, branches), not the ~400 questions of M04A. It covers every class M04B asked for; the remaining classes (graph,
    lineage, provenance excerpts, answer grounding) depend on code that does not exist yet.
11. **FTS stage latency exceeds M04A's 25 ms p95** on the synthetic 10,000-object corpus (below). Local retrieval as a whole is
    within 100 ms p95. Candidate optimisation (not done): one FTS pass that returns current and historical hits together.

## Behaviour worth knowing

* Retrieval is `retrieve(store, query, projectId)`: one explicit project, never widened. An archived project is recallable only
  by being passed explicitly and the result says `scope.archived`.
* `title`/`body` of an evidence entry are always the **current** revision. Old wording appears only in `matchedHistorical`
  (status `historical`), and only for objects discovered through it.
* Semantic Recall is **off** until the user turns it on. Off means: no document embedding, no query embedding, vectors kept
  but ignored. `purge_semantic_index` deletes them. A missing, damaged, wrong-version or other-provider settings file means off.
* Degradation resolves, it does not reject: `semantic: disabled | unavailable(reason) | noIndex | partial`,
  `lexical: ok | degradedScan | skippedNoTerms`. A store that cannot be read is `storage_failed`, never "no match".

## Offline benchmark (`cargo test --lib recall_benchmark_offline -- --nocapture`)

**Read this correctly.** The semantic channel here is `ConceptEmbedder`, a hand-declared concept lexicon hashed into vectors. It
exercises the semantic *code path* deterministically. It says nothing about the quality of a real embedding model, and its
zero-result false answers reflect hash collisions under the placeholder floor `tau_sem = 0.30`, not a verdict on the design.
Lexical (L) numbers are real.

R@K = fraction of the relevant objects found in the top K; MRR over the first relevant.

| class | n | L R@1 / R@5 / R@8 / MRR | S R@1 / R@5 / R@8 / MRR | H R@1 / R@5 / R@8 / MRR |
|---|---|---|---|---|
| archived-scope | 4 | 0.75 / 1.00 / 1.00 / 1.00 | 0.75 / 0.75 / 0.75 / 1.00 | 0.75 / 1.00 / 1.00 / 1.00 |
| bg-lexical | 10 | 0.95 / 1.00 / 1.00 / 1.00 | 0.60 / 0.60 / 0.60 / 0.60 | 0.95 / 1.00 / 1.00 / 1.00 |
| contradiction | 2 | 0.50 / 1.00 / 1.00 / 1.00 | 0.50 / 1.00 / 1.00 / 1.00 | 0.50 / 1.00 / 1.00 / 1.00 |
| decision-why | 2 | 1.00 / 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 / 1.00 |
| dependency | 2 | 0.50 / 1.00 / 1.00 / 0.62 | 0.50 / 0.50 / 0.50 / 0.50 | 0.50 / 1.00 / 1.00 / 0.62 |
| evolution | 2 | 1.00 / 1.00 / 1.00 / 1.00 | 0.50 / 0.50 / 0.50 / 0.50 | 1.00 / 1.00 / 1.00 / 1.00 |
| injection-content | 2 | 1.00 / 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 / 1.00 |
| lex-direct | 16 | 0.97 / 1.00 / 1.00 / 1.00 | 0.91 / 1.00 / 1.00 / 0.97 | 0.97 / 1.00 / 1.00 / 1.00 |
| mixed-language | 5 | 0.40 / 0.70 / 0.70 / 0.80 | 0.40 / 0.50 / 0.50 / 0.80 | 0.40 / 0.70 / 0.70 / 0.80 |
| nfc | 2 | 1.00 / 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 / 1.00 |
| obsolete-trap | 4 | 1.00 / 1.00 / 1.00 / 1.00 | 0.50 / 0.50 / 0.50 / 0.50 | 0.75 / 1.00 / 1.00 / 0.83 |
| old-decision-vs-new-note | 1 | 1.00 / 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 / 1.00 |
| project-isolation | 8 | 1.00 / 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 / 1.00 |
| provenance | 1 | 1.00 / 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 / 1.00 |
| semantic-paraphrase | 8 | 0.00 / 0.00 / 0.00 / 0.00 | 0.69 / 0.81 / 0.81 / 0.81 | 0.69 / 0.81 / 0.81 / 0.81 |
| task-from | 1 | 1.00 / 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 / 1.00 |
| zero-result | 8 | false answers 0/8 | false answers 4/8 | false answers 4/8 |
| language: en | 56 | 0.76 / 0.82 / 0.82 / 0.81 | 0.79 / 0.87 / 0.87 / 0.87 | 0.86 / 0.97 / 0.97 / 0.94 |
| language: bg | 17 | 0.97 / 1.00 / 1.00 / 1.00 | 0.73 / 0.73 / 0.73 / 0.73 | 0.97 / 1.00 / 1.00 / 1.00 |
| language: mixed | 5 | 0.40 / 0.70 / 0.70 / 0.80 | 0.40 / 0.50 / 0.50 / 0.80 | 0.40 / 0.70 / 0.70 / 0.80 |
| ALL (with relevant) | 78 | 0.78 / 0.85 / 0.85 / 0.85 | 0.75 / 0.81 / 0.81 / 0.83 | 0.85 / 0.95 / 0.95 / 0.94 |

| config | project leaks | forbidden hits | obsolete-as-current | uploaded texts | provider requests | historical discoveries | zero-result false answers |
|---|---|---|---|---|---|---|---|
| L  lexical only | 0 | 0 | 0 | 0 | 0 | 2 | 0/13 |
| S  semantic only | 0 | 0 | 0 | 78 | 78 | 0 | 6/13 |
| H  hybrid | 0 | 0 | 0 | 78 | 78 | 2 | 6/13 |

| config | lexical ms p50 / p95 | semantic local ms p50 / p95 | query embedding ms p50 (provider double) | merge ms p95 | local total ms p95 |
|---|---|---|---|---|---|
| L  lexical only | 1.64 / 2.86 | 0.00 / 0.00 | 0.00 | 0.190 | 3.25 |
| S  semantic only | 0.00 / 0.00 | 0.49 / 0.72 | 0.20 | 0.143 | 1.20 |
| H  hybrid | 1.32 / 2.19 | 0.45 / 0.63 | 1.42 | 0.178 | 3.22 |

Hard gates in this tier (all asserted): project leakage 0, forbidden hits 0, obsolete wording in a current slot 0, consent-off
uploads and provider requests 0, `L` lex-direct R@8 >= 0.95 (got 1.00), `L` bg-lexical R@8 >= 0.80 (got 1.00), `L` finds every
obsolete-trap object through history (1.00), and hybrid is never more than 2 points below the better single channel overall.

Note: the offline tier still returns something for 4 of 8 zero-result questions with the toy embedder; that reflects hash collisions
in the double, not the product. The real-model floor was calibrated live (Hardening pass, section 2). Lexical alone returns nothing for all 8.

## Scale benchmark (release, 10,000 objects)

`cargo test --release --lib recall_benchmark_scale -- --ignored --nocapture`: 10,000 objects over 20 projects (largest 2,741),
14,413 revisions (4,413 edits), real store write paths, 512-dim vectors from the provider double for every object, 300 questions.

| | vocabulary 500 words (dense) | vocabulary 5,000 words |
|---|---|---|
| lexical (+historical) p50 / p95 / p99 | 23.1 / 43.2 / 65.8 ms | 21.1 / 38.5 / 45.5 ms |
| semantic local scan + resolve p50 / p95 / p99 | 8.7 / 29.4 / 37.1 ms | 7.7 / 26.3 / 32.0 ms |
| merge p95 | 0.6 ms | 0.3 ms |
| local total (excluding the embedding wait) p50 / p95 / p99 | 36.9 / 68.5 / 96.7 ms | 33.7 / 53.7 / 64.1 ms |
| SQL statements per question | 5 | 5-6 |

(Numbers are from the hardening pass on an otherwise idle machine. The first M04B run, 52/89/96 ms and 41/86/114 ms local total,
overlapped with other builds, which inflated it. The lexical stage is still above M04A's 25 ms p95 target; the overall 100 ms
budget holds with margin.)

* Query plans (asserted; see "Hardening pass" for the semantic one): the lexical statement is driven by the FTS5 virtual table and probes `thought_revisions` and
  `knowledge_objects` by primary key (no scan of an authoritative table); the semantic statement walks
  `knowledge_objects_by_project` and probes vectors by primary key (no other project's vectors are read).
* Statements per question are constant (<= 6) however many objects match; no N+1.
* After 200 edits made 200 vectors stale, 50 further questions made exactly 50 provider requests (the query embeddings): rejecting
  stale vectors costs no provider call.
* Indexing 10,000 vectors with the double took 5.5-6.2 s; building the corpus through the real write paths took 12-22 s.
* The "query embedding" row printed by this test is the **provider double**, not a network; a real embedding adds a network wait
  that overlaps the lexical work and is reported separately (`queryEmbeddingMs`).

## Platform acceptance

Against a **real v6 database pulled from the Android emulator** (Pixel_10 x86_64, API 37, 16 KB pages; 64 objects, 86 revisions,
27 captures, 55 relations, an archived project):

* **The installed app upgraded its own database v6 -> v7**: after the app started, the database pulled back had `user_version 7`,
  every authoritative table byte-identical to the v6 copy (10 tables compared row by row), FTS rows 86 == revisions 86,
  `integrity_check` ok, 0 foreign-key violations.
* **The real app, real OpenAI embeddings, driven through the WebView debugger** (calls the native commands; 20 checks, all pass):
  lexical retrieval of existing knowledge; Bulgarian inflection and upper case; project isolation; a moved object appearing only in
  its new project; explicit archived-project scope; semantic OFF by default with 0 embedding requests and 0 uploaded texts;
  enabling indexed 64 objects in 6 s; a paraphrase with no shared words found the object by meaning (rank 2, cosine 0.50); editing the
  object made exactly one vector stale and the stale vector produced no semantic hit; the re-embedding landed in the background
  within 2 s and was valid for the new text; disabling stopped query embedding at once (`embeddingRequests 0`), kept 64 vectors but
  ignored them, and lexical retrieval still worked; purge removed every vector. Query embedding over the emulator's network took
  ~1.3 s, local retrieval ~47 ms, reported separately.
* **On-device native run** (the test binary cross-compiled for `x86_64-linux-android` and run by `adb`): all 382 unit tests pass on
  the Android runtime (11.6 s), the real-database v6 -> v7 proof passes (17.7 ms, fingerprint of 504 rows identical, rollback and
  newer-schema refusal), and the 8-step deterministic acceptance (`recall_platform_acceptance`) passes using the provider double.
  The test binary needs `-Wl,-z,max-page-size=16384` on this 16 KB-page emulator image (the app's `cdylib` already has it).

The emulator's database was restored to its original v6 bytes afterwards.

## Hardening pass (pre-commit)

### 1. The semantic scan reads only the scoped project's vectors

**Cause of the earlier cross-project scan.** The first form of the statement was
`FROM knowledge_objects o JOIN recall_embeddings e ON e.object_id = o.id AND e.model_key = ? AND e.revision_id = o.current_revision_id
AND e.dims = ? WHERE o.project_id = ?`. SQLite is free to reorder an inner join, and its plan was
`SEARCH e USING INDEX recall_embeddings_by_model_revision (model_key=?)` then `SEARCH o USING INDEX sqlite_autoindex_knowledge_objects_1 (id=?)`:
it enumerated **every vector of the model, in every project**, looked up each owner, and filtered by project last. Results were
correct (only the scoped rows came out), which is why result checks alone could not catch it. (An earlier sentence in this file's
first draft read as if `CROSS JOIN` caused that; it is the opposite: the unpinned join caused it and `CROSS JOIN` removes it.)

**Shipped statement.** `FROM knowledge_objects o CROSS JOIN recall_embeddings e ON ... WHERE o.project_id = ?` (a `CROSS JOIN` makes
SQLite keep the written order). `project_id` stays only on `knowledge_objects`; nothing is copied into `recall_embeddings`.

| | plan |
|---|---|
| before | `SEARCH e USING INDEX recall_embeddings_by_model_revision (model_key=?)` -> `SEARCH o USING INDEX sqlite_autoindex_knowledge_objects_1 (id=?)` |
| after | `SEARCH o USING INDEX knowledge_objects_by_project (project_id=?)` -> `SEARCH e USING INDEX sqlite_autoindex_recall_embeddings_1 (object_id=? AND model_key=?)` |

**Proof that it is observable, not just correct** (`a_semantic_query_for_one_project_never_reads_the_vectors_of_unrelated_projects`).
A 20-object project alone vs the same 20 objects beside a 2,000-object project, counting SQLite's own virtual-machine steps
(`sqlite3_stmt_status(VM_STEP)`, which grows with every row a statement visits, including rows it later filters out):

| statement | small project alone | small project beside 2,000 unrelated vectors |
|---|---|---|
| shipped (pinned) | 352 steps | 353 steps (independent of unrelated size) |
| old (unpinned) | n/a | 30,333 steps (86x), 35.7 ms vs 0.26 ms in a debug build |

The test also asserts the plan lines (a `SEARCH` of the project index, a primary-key probe of the vector, no `SCAN`, and that the old
form really does start from `recall_embeddings_by_model_revision`, so the assertion can tell the two apart).

At 10,000 objects (release): the smallest project (117 objects) scans in **2,001 steps / 0.5-0.6 ms** pinned vs **100,715 steps /
29-41 ms** unpinned; the largest project (2,741) in 46,610 steps / 8.5-11.3 ms vs 116,459 steps / 31-45 ms.

### 2. Similarity-floor calibration (live, real `text-embedding-3-small` @ 512)

`recall_threshold_sweep`, run on the host against the real provider on the existing golden corpus (35 objects, 78 questions; 3
provider requests, 109 texts; the key was read from the environment and never printed). Semantic-only (S) and hybrid (H) per floor:

| floor | channel | para R@1/5/8 | ALL R@1/5/8 | MRR | zero-result false pos (8) | all must-be-empty false pos (13) | project leaks | obsolete-as-current | forbidden |
|---|---|---|---|---|---|---|---|---|---|
| n/a | L lexical | 0.00 / 0.00 / 0.00 | 0.78 / 0.85 / 0.85 | 0.85 | 0/8 | 0/13 | 0 | 0 | 0 |
| 0.15 | S semantic | 0.94 / 1.00 / 1.00 | 0.88 / 0.98 / 1.00 | 0.97 | 6/8 | 11/13 | 0 | 0 | 1 |
| 0.15 | H hybrid | 0.94 / 1.00 / 1.00 | 0.89 / 1.00 / 1.00 | 0.98 | 6/8 | 11/13 | 0 | 0 | 1 |
| 0.20 | S semantic | 0.94 / 1.00 / 1.00 | 0.88 / 0.98 / 1.00 | 0.97 | 3/8 | 7/13 | 0 | 0 | 1 |
| 0.20 | H hybrid | 0.94 / 1.00 / 1.00 | 0.89 / 1.00 / 1.00 | 0.98 | 3/8 | 7/13 | 0 | 0 | 1 |
| 0.25 | S semantic | 0.94 / 1.00 / 1.00 | 0.88 / 0.98 / 1.00 | 0.97 | 2/8 | 5/13 | 0 | 0 | 1 |
| 0.25 | H hybrid | 0.94 / 1.00 / 1.00 | 0.89 / 1.00 / 1.00 | 0.98 | 2/8 | 5/13 | 0 | 0 | 1 |
| 0.30 | S semantic | 0.94 / 1.00 / 1.00 | 0.88 / 0.97 / 0.98 | 0.96 | 1/8 | 1/13 | 0 | 0 | 0 |
| 0.30 | H hybrid | 0.94 / 1.00 / 1.00 | 0.88 / 1.00 / 1.00 | 0.98 | 1/8 | 1/13 | 0 | 0 | 0 |
| 0.35 | S semantic | 0.94 / 0.94 / 0.94 | 0.87 / 0.95 / 0.96 | 0.95 | 0/8 | 0/13 | 0 | 0 | 0 |
| 0.35 | H hybrid | 0.94 / 0.94 / 0.94 | 0.89 / 0.99 / 0.99 | 0.98 | 0/8 | 0/13 | 0 | 0 | 0 |
| 0.40 | S semantic | 0.94 / 0.94 / 0.94 | 0.81 / 0.88 / 0.90 | 0.89 | 0/8 | 0/13 | 0 | 0 | 0 |
| 0.40 | H hybrid | 0.94 / 0.94 / 0.94 | 0.89 / 0.98 / 0.98 | 0.98 | 0/8 | 0/13 | 0 | 0 | 0 |
| 0.45 | S semantic | 0.62 / 0.62 / 0.62 | 0.74 / 0.78 / 0.78 | 0.80 | 0/8 | 0/13 | 0 | 0 | 0 |
| 0.45 | H hybrid | 0.62 / 0.62 / 0.62 | 0.85 / 0.92 / 0.94 | 0.93 | 0/8 | 0/13 | 0 | 0 | 0 |
| 0.50 | S semantic | 0.38 / 0.38 / 0.38 | 0.66 / 0.70 / 0.70 | 0.71 | 0/8 | 0/13 | 0 | 0 | 0 |
| 0.50 | H hybrid | 0.38 / 0.38 / 0.38 | 0.82 / 0.91 / 0.91 | 0.90 | 0/8 | 0/13 | 0 | 0 | 0 |
| 0.55 | S semantic | 0.25 / 0.25 / 0.25 | 0.57 / 0.60 / 0.60 | 0.62 | 0/8 | 0/13 | 0 | 0 | 0 |
| 0.55 | H hybrid | 0.25 / 0.25 / 0.25 | 0.79 / 0.89 / 0.89 | 0.87 | 0/8 | 0/13 | 0 | 0 | 0 |

Cosine evidence behind the curve (floor 0, semantic channel only):

* Best relevant object per answerable question, lowest: 0.279 (`postgres`, a single bare word that lexical + history already
  cover), 0.339 (`flutter`), 0.351, 0.360, 0.379, 0.396, 0.405, **0.406 (paraphrase `where does personal information get saved`)**,
  0.434 (paraphrase), ...
* Top-1 cosine of the questions that must return nothing, highest: **0.336** (`blockchain consensus protocol`), 0.278, 0.273,
  0.267, 0.255, 0.240, 0.219, 0.200, ... 0.106.

**Chosen floor: 0.40** (`DEFAULT_MIN_COSINE`, for `openai:text-embedding-3-small:512:v1` only). 0.35 and 0.40 both give, on this
corpus: project leakage 0, obsolete-as-current 0, forbidden hits 0, **zero-result false positives 0/8 (0/13 for all must-be-empty
questions)**, and paraphrase R@8 0.94. 0.40 widens the separation from the highest observed false-evidence cosine (0.336) from 0.014
(at 0.35) to **0.064**, at a measured cost of about 1 point of hybrid R@5/R@8 (0.98 vs 0.99; MRR unchanged at 0.98). That margin is
preferred for a production admission floor calibrated on a single corpus. Below 0.35 false evidence appears (1/8 at 0.30, 2/8 at
0.25, 6/8 at 0.15, plus a forbidden hit at <= 0.25); above 0.40 paraphrase recall collapses (0.62 at 0.45, 0.38 at 0.50).

**Caveats, stated plainly.**

* 0.35 would also meet every gate but leaves only 0.014 above the highest false cosine; 0.40 was chosen for the 0.064 margin. A
  larger benchmark may move it.
* One corpus of 78 questions and one embedding model. The floor belongs to the model key
  (`openai:text-embedding-3-small:512:v1`); a different model needs its own sweep.
* Does zero false positives conflict materially with paraphrase recall? **No, not on this corpus**: there is a clean plateau
  (0.35-0.40) where both hold. But the separation is not wide: a relevant single-word hit (0.339) sits next to an irrelevant
  same-domain one (0.336), so cosine alone cannot distinguish "related" from "answers the question" near the floor.

**Recommendation for M04C (not implemented).** Keep M04B as one floor, but treat `candidate similarity` (what retrieval returns)
and `sufficient evidence to answer` (what synthesis may rely on) as separate decisions: a candidate admitted only by a cosine
within ~0.05 of the floor, with no lexical support, should be marked weak and not by itself justify an answer. That needs a
larger benchmark to tune, and belongs with the evidence package for synthesis.

### 3. Lexical single-pass investigation: not adopted

Probes on the 10,000-object corpus (release, largest project, `ms`):

| statement | 500-word vocabulary | 5,000-word vocabulary |
|---|---|---|
| FTS5 match only, no join, no ranking (10,0xx rows) | 3.2 | 2.1 |
| FTS5 top 30 by bm25, no join | 17.7 | 13.7 |
| **current query as shipped** (joins, project filter, top 30) | **24.3** | **17.4** |
| historical query as shipped (top 50 rows) | 29.7 | 24.9 |
| single pass, current + historical together (top 200 rows) | **60.4** | **44.0** |

Matching is cheap (2-3 ms); **bm25 scoring of ~10,000 matching rows is the cost** (about 14-18 ms of the 17-24 ms), and the joins add
~4-7 ms. The single pass is *slower* than the current query alone and no faster than current + historical run back to back, because
it must score and sort current and non-current rows together and over-fetch to be sure of 30 current hits. It would also make
"which rows are current" depend on a post-filter and a truncation limit, which is harder to prove than the two explicit statements.
**Reverted / not adopted.** The probe code is kept as test-only tooling. Measured debt: lexical p95 38-43 ms on this deliberately
dense synthetic corpus (every query term matches ~10,000 revisions) against M04A's 25 ms stage target; local retrieval p95 is
54-69 ms against the 100 ms budget. Any further gain must come from reducing the matching set (stricter coverage before scoring,
or a per-project index), not from merging the two queries.
