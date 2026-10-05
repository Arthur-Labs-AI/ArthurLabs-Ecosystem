# M04A: Cognitive Recall Architecture

**Status:** design only. Nothing in this folder is implemented. No schema, client, contract or production code was changed.
**Base:** `feature/cognitive-runtime-v1` @ `cb110d6`, schema v6, Marginalia Desktop + Mobile design-locked, Projects complete.

Recall (Ask Arthur) answers a question from the user's own knowledge while preserving project scope, current thought state,
relationships, history and provenance. It is **not** generic chat over a vector database. It reconstructs knowledge along the
structure Arthur already built:

```
Project -> KnowledgeObjects -> Graph -> Lineage -> Provenance -> grounded answer
```

## Documents

| File | Contents |
|---|---|
| [pipeline.md](pipeline.md) | Stages, scope semantics, query interpretation, graph expansion, lineage policy, performance budgets, N+1 hazards |
| [retrieval-ranking.md](retrieval-ranking.md) | Lexical (FTS5, Bulgarian), semantic, hybrid fusion, exact v1 scoring |
| [evidence-contract.md](evidence-contract.md) | Evidence package, context builder and budgets, synthesis contract, `ArthurClient` boundary, UI contract, security |
| [storage-plan.md](storage-plan.md) | Schema v7, embeddings lifecycle, freshness/invalidation, privacy, rebuild strategy |
| [benchmark-plan.md](benchmark-plan.md) | Dataset, configurations, metrics, acceptance thresholds, what each benchmark decides |
| [failure-model.md](failure-model.md) | Layered failure and degradation behaviour |

No Mermaid: the repo uses plain-text diagrams only, so these do too.

## What inspection found (and how it changed the design)

| Finding | Consequence |
|---|---|
| The store, providers (`providers/chat.rs`), graph and distillation are **native Rust** in `apps/arthur/src-tauri`. React sees only `ArthurClient`. `src/cognitive` is a TypeScript boundary stub with no store; `src/memory` is the older Nexus-side RAG (its own SQLite, TS embeddings, RRF) and is frozen/unused by the app. | The Recall engine is a new Rust module `recall/` beside `graph/` and `distillation/`. It does **not** reuse `src/memory`, honouring "memory is a projection, never the owner" and the "no Nexus CCv2" rule. Its RRF idea is reused conceptually only. |
| `knowledge_objects.kind/title/body` always equal the **current revision**, enforced by trigger `knowledge_objects_equal_their_current_revision`; `current_revision_id` is a column. | "Current knowledge" is simply `knowledge_objects`. Current-state retrieval needs no revision join. Historical state is `thought_revisions` rows that are not current. |
| `thought_revisions` and `revision_parents` are **immutable** (update triggers abort). | A lexical index over revisions is append-only: no update sync, no staleness. |
| `project_id` lives only on `captures` and `knowledge_objects` and is mutable (move). Revisions and relations derive project through the object. | Indexes must never bake in project. Project is always a join/filter at query time. Moving an object needs zero re-indexing. |
| `object_sources` holds the object's **initial** span. A later revision may carry its own span (`revise_from_capture`); edits and merges carry none. | Evidence must distinguish "where the object came from" from "where the current revision came from" and must never claim a Capture for edited text. |
| `relations_by_source` / `relations_by_target` indexes exist; `project_graph` already shows the in-scope + external-endpoint model (`ExternalObject`). | Graph expansion is a batched indexed query; the external-endpoint rule extends an existing concept. |
| Single OpenAI credential (`CredentialSource`), `chat::complete_json` with strict JSON schema, `temperature 0`, no tools, errors never carry provider bodies. No embedding client exists in Rust. | Synthesis reuses `complete_json`. A new `providers/embed.rs` adds one trait + one OpenAI implementation behind it. |
| `rusqlite` `bundled` compiles SQLite **with FTS5** (`SQLITE_ENABLE_FTS5` in `libsqlite3-sys` `build.rs`). I probed SQLite 3.53: `unicode61` case-folds Cyrillic (`"МОБИЛНО"` matches `Мобилно`), **SQLite `lower()` does not** fold Cyrillic, and `"идея"` does **not** match `Идеята`/`Идеите` (no stemming). | FTS5 is available on every platform incl. Android. Case-insensitivity must come from the tokenizer, never `lower()`/`LIKE`. Bulgarian morphology needs query-side stem-prefix matching. |
| Existing precedent: relation inference marks objects as `data, never instructions`, uses fixed JSON framing, and is bounded (`MAX_INFERENCE_CANDIDATES`). `Mod+K` is reserved for Ask Arthur; no nav item. | Same prompt-boundary pattern; Ask Arthur is a command-bar-style surface. |

## Decisions (all explicit; each unresolved item names the benchmark that settles it)

| # | Question | Decision |
|---|---|---|
| D1 | Lexical method | **SQLite FTS5**, one external-content virtual table over `thought_revisions` (append-only). `tokenize='unicode61 remove_diacritics 2'`. bm25 with title weighted 8x body. Query-side OR over content terms with **light BG/EN stem-prefix** expansion. Trigram table is *not* in v7; added later (rebuildable) only if benchmark class `bg-lexical` fails its threshold. |
| D2 | What is indexed lexically | Revision `title` + `body` of **all** revisions; "current" is decided at query time by `o.current_revision_id = r.id`. Captures are **not** indexed in v1. |
| D3 | Embedding strategy | Embed **only the current projection** of each object (`kind: title\nbody`), never historical revisions, never project name. |
| D4 | Embedding provider abstraction | Rust trait `EmbeddingProvider` (`model_key`, `dims`, `embed(texts, purpose)`); v1 impl OpenAI `text-embedding-3-small` at **512 dims** (Matryoshka `dimensions` param). `model_key = "openai:text-embedding-3-small:512:v1"`. A local embedder later = a second impl. |
| D5 | Embedding timing | **Opt-in**, then a **lazy, derivable, bounded background indexer.** No durable queue: the work set is `objects WHERE no embedding for (active model, current revision)`. Lexical is synchronous and in-transaction, so new knowledge is recallable immediately. |
| D6 | Hybrid ranking | **Reciprocal Rank Fusion, k = 60**, over lexical top-30 and semantic top-30, normalised by active channel count, plus a bounded title-phrase bonus (+0.15) and a bounded kind prior (x0.85..x1.15). No model reranker. Recency is **tie-break only**. |
| D7 | Seed K | 8 seeds max (relative cutoff 0.5 x top, min 1). Top **5** seeds expand in the graph. |
| D8 | Graph | **1 hop**, <= 12 expanded objects (<= 4 per seed, <= 2 per relation kind per seed), <= 3 external. A second hop only along `depends_on` (dependency intent) or `supersedes` (evolution intent), <= +4 objects. Batched SQL. Benchmark `G1` decides whether the 2-hop exception stays. |
| D9 | Relation weighting | Direction-aware base weights x intent multipliers (tables in [pipeline.md](pipeline.md)). Symmetric kinds are direction-free. |
| D10 | Lineage | Never the whole DAG. Default: current revision only (+ revision count). Why/decision intent: + immediate parent. Evolution intent: parent path (<= 6 revisions) + branch/merge points + non-current heads (<= 2). Historical revisions are separate evidence entries with `status: historical`, never merged into `currentBody`. |
| D11 | Provenance | Deterministic evidence record per object: initial source span + capture excerpt, current-revision source if any, `editedSinceCapture`, relation `via`. Capture excerpts fetched in one batched query. |
| D12 | Budgets | Total evidence **6,000 est. tokens**; <= 8 seeds, <= 12 expanded, <= 3 external, <= 12 history revisions, <= 6 excerpts. Deterministic degradation order. |
| D13 | Answer contract | Strict JSON: `outcome`, `paragraphs[{text, basedOn[], temporal}]`, `gaps[]`. Every `basedOn` must be a supplied handle (`E1`..). Software validates; unreferenced paragraphs are dropped. One retry on structural invalidity. |
| D14 | Client contract | One method: `ask(CognitiveQuery): Promise<CognitiveAnswer>`. Degraded results **resolve** with a stated `outcome`; only impossible requests reject. |
| D15 | Schema v7 | Additive only: FTS5 table + triggers, `recall_embeddings`, `recall_meta`. All rebuildable. No v1-v6 table is altered. |
| D16 | Rebuild | FTS: `INSERT ... VALUES('rebuild')`. Embeddings: truncate + lazy backfill. Both safe at any time. |
| D17 | Fallback | Embeddings off (default), unavailable or failing -> lexical only. FTS down -> Rust-side Unicode scan. Answer model down -> retrieval-only result (evidence still shown). |
| D18 | v1 interaction | **Single query/result.** No chat session, no persistence of Q&A. |
| D20 | Embedding consent | Off by default; one global local preference outside `recall_*`; off = stop uploads, keep vectors, ignore them; explicit purge action. |
| D21 | Archived projects | Recallable only when explicitly scoped; never admitted as external graph evidence; excluded from future all-project scope by default. |
| D19 | Acceptance | Numeric gates in [benchmark-plan.md](benchmark-plan.md); project leakage = 0 and obsolete-as-current = 0 are hard gates. Graph and Lineage must each *prove* a lift on their own classes or be disabled by default. |

## Product decisions (finalized)

These were open in the first draft and are now fixed. Each is reflected in the other documents.

1. **Cloud embeddings are opt-in.** Having an OpenAI key does **not** enable them. Until the user explicitly turns on
   "semantic Recall", no KnowledgeObject text is sent for embedding and no query is embedded; Recall is lexical (+ graph, lineage,
   provenance) and fully functional. The choice is **one local, global, per-device preference** (no per-project settings),
   stored **outside** the rebuildable `recall_*` tables, in the app-private settings area next to the credentials file (absent
   means off; fail-closed). Enabling starts bounded background indexing. **Turning it off** stops all embedding traffic
   immediately (indexer and query embedding), and existing local vectors are **kept on the device but ignored**: retained so
   re-enabling does not re-upload everything, never used because using them would require embedding the query (an upload) and
   the user said no. A separate explicit "Delete semantic index" action purges them. Details: [storage-plan.md](storage-plan.md) §3.6, §7.
2. **Archived projects are recallable only when explicitly scoped.** They are read-only. The default Recall scope is the
   active project, which is never archived (archiving the active project switches to the Inbox), so archived projects are
   never in the normal path. A future all-project / selected-project Recall **excludes archived projects unless they are
   explicitly listed**. Graph expansion never admits an archived project's object as external evidence, from any scope.
   Explicit Recall against an archived project is valid, stays read-only, and (being archived itself) may still follow
   edges to non-archived external objects under the normal external-admission rule. Details: [pipeline.md](pipeline.md) §2.
3. **Benchmark gates are class-scoped.** Graph is judged on graph-dependent classes; Lineage on evolution/history/why classes;
   thresholds in [benchmark-plan.md](benchmark-plan.md) §5.3.
4. **v1 Ask Arthur is a focused query -> result**, not a conversation (D18; rationale in [evidence-contract.md](evidence-contract.md) §5).
5. **Unchanged:** deterministic evidence package before synthesis; project-scoped retrieval; current knowledge distinct from
   historical revisions; FTS + semantic hybrid with lexical fallback; Graph as bounded expansion; selective Lineage; provenance
   as evidence; no tools or actions in Recall.

## Remaining questions (settled by benchmark, not by product decision)

1. Embedding dimension 512 vs 1536 (`E1`).
2. Trigram index for Bulgarian inflection (`B1`).
3. Relevance floors `tau_sem` and lexical coverage (`S1`).
4. Whether the 2nd graph hop, historical nomination, intent weights, and phrase bonus each earn their cost (`G1`, §5.3, `F4`).
5. **Cancel:** v1 does not cancel an in-flight `ask` natively (cost is bounded to 2 chat + at most 1 embedding request); the UI ignores a superseded result.
6. **Two homes for the engine:** this design puts Recall in native Rust. If the Home Node later runs a TypeScript Cognitive Store,
   the pure stages (interpret, fuse, expand, budget) must port; they are specified as pure functions over plain data.

## Non-goals (M04)

Web search, email/calendar, autonomous agents, tool execution, shared/team knowledge, cloud sync, Nexus/Sentry invocation,
automatic cross-project discovery, general chatbot memory, folders/tags, graph ontology expansion. Recall is retrieval +
synthesis of the user's own Arthur knowledge, with no actions.
