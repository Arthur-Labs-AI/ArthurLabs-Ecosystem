# Recall pipeline

## 1. Shape

The proposed shape was kept, with three deviations (explained in §1.1).

```
ask({ query, scope: { projectId } })
  |
  v
[0] Validate + resolve scope            project exists? archived only if explicitly scoped (read-only)
  |
  v
[1] Query interpretation (no LLM)       normalise, language, content terms, intent WEIGHTS
  |
  +----------------------------+
  v                            v
[2a] Lexical candidates     [2b] Semantic candidates      run concurrently; each independently optional
     FTS5, current revs          query embedding (network)
     project-filtered            + brute-force cosine, project-filtered
  |                            |
  +------------+---------------+
               v
[3] Deterministic hybrid merge (RRF) + admission floors -> seeds (<= 8)
               |
               v
[4] Bounded graph expansion (top 5 seeds, 1 hop, <= 12 + <= 3 external)
               |
               v
[5] Current-revision enrichment + supersession/duplicate/contradiction marking
               |
               v
[6] Selective lineage enrichment (intent-driven, bounded)
               |
               v
[7] Provenance evidence (batched capture excerpts)
               |
               v
[8] Evidence package (stable, testable, no LLM yet)          <- benchmarkable boundary
               |
               v
[9] Context builder (hard token budget, deterministic degradation)
               |
               v
[10] LLM synthesis (strict JSON, evidence only) -> validate refs -> CognitiveAnswer
```

### 1.1 Deviations from the proposed shape

1. **Historical lexical path (new, optional).** The proposal had no path for a thought whose *old* wording is gone from the
   current revision ("how did the voice-only idea change?" when the current text no longer says "voice-only"). Stage 2a has a
   second, gated query over non-current revisions (§6.4). It only nominates **objects**; it never injects old text as current.
2. **Stage 2b starts before 2a finishes.** The query embedding is a network call (~0.3-1.5 s); it is fired first and the
   local lexical work runs under it. Total retrieval latency is the max, not the sum.
3. **Stage 5 marks, it does not just enrich.** `supersedes`, `duplicates` and `contradicts` edges between *candidates* change how
   candidates are presented (an object superseded by another candidate is demoted and labelled), which a plain "enrichment" step
   would miss.

### 1.2 Why not Graph-first

Evaluated alternatives:

| Approach | Verdict |
|---|---|
| Lexical only | Misses paraphrase ("offline-first" vs "works without network"). Necessary as the always-available floor. |
| Semantic only | Fails on exact names/identifiers and on rare tokens; cannot work offline or before embeddings exist; quietly returns nearest-neighbour junk when nothing is relevant. |
| Hybrid (lexical + semantic) | Chosen candidate generator: complementary failure modes, cheap deterministic fusion. |
| Graph-first (start from high-degree/"hub" nodes, walk outward) | Rejected as primary: the graph is sparse and model-proposed, many relevant thoughts have no edges, and hub bias returns the same central ideas for every question. Graph is a **recall-expansion and explanation** mechanism over already-relevant seeds. |
| Hybrid + graph + lineage | Chosen. Each addition must prove its lift ([benchmark-plan.md](benchmark-plan.md)); Graph and Lineage ship default-on only if they pass. |

## 2. Scope semantics

```ts
interface RecallScope { projectId: string }      // v1: exactly one explicit Project
// reserved, NOT implemented in M04:
//   { projectIds: string[] }   selected projects
//   { all: true }              all projects
```

Rules:

1. The caller passes the active project id explicitly. The engine never defaults to "all" and never reads `active_project`
   itself (it is a UI/session concept); a missing/blank id is `recall_invalid_query`.
2. `projectId` unknown -> `project_not_found`. The Inbox is an ordinary project. **Archived projects** are recallable **only
   when explicitly scoped** (the caller passes that project's id): they keep their data and Recall on them is read-only like
   all Recall. The default scope is the active project, which is never archived (archiving it switches to the Inbox), so an
   archived project never appears in the normal path and is never chosen implicitly. A future `selected`/`all` scope **excludes
   archived projects unless they are explicitly listed** (`includeArchived` is reserved, default false, and not in v1).
3. Candidate generation (2a, 2b) is filtered **in SQL** by `knowledge_objects.project_id = ?`. Out-of-scope objects are never
   loaded, scored, or embedded in the query path. This (not prompt instructions) is what guarantees isolation.
4. Objects are scoped by the **object's** project, never its Capture's project (a moved object keeps its provenance capture
   elsewhere; that is fine).
5. The future widening to `selected` / `all` replaces the filter predicate only (`project_id IN (...)`); every other stage is
   scope-agnostic and already handles "evidence from project X". The evidence record carries `project` for exactly this reason.

### 2.1 When a cross-project object may enter the evidence set

A single, closed rule. An object `X` with `X.project_id != scope.projectId` is admitted **iff all** hold:

1. `X` is the far endpoint of a stored relation `R` whose other endpoint `S` is **in scope and is one of the (<= 5) graph-expanding seeds** (an archived scope project is allowed here: the anchor is the scope, the far end must be non-archived);
2. the edge is followed **one hop only**; an external object is never expanded further, never a seed, never produced by FTS or
   semantic retrieval, and never reached through another external object;
3. the far endpoint's project is **not archived**: an archived project's object is never admitted as external evidence, from any
   scope (including from another archived scope), so evidence cannot silently come from a retired project; the exclusion is
   applied in the same batched read (`projects.archived_at IS NULL`) and counted only in `crossProjectOmitted`;
4. at most **3** external objects per query (ranked by the same expansion score);
5. it is labelled `role: "external"` with its own `project {id, name}` and the `via` relation; its body budget is the smallest tier
   (300 chars) and it receives **no lineage and no excerpt** (provenance ids only);
6. it is excluded entirely when the scope project has **zero seeds**: with no in-scope anchor there is nothing to follow, so
   "only cross-project evidence exists" yields `insufficient_evidence` for this project, with no cross-project content and no
   cross-project count (finding them would itself be an unscoped search).

Synthesis rules (evidence-contract.md §3) require the model to say when it relies on external evidence and to attribute it to
its project by name; the deterministic post-check flags any `basedOn` on an external handle in a paragraph that does not say so
(via `temporal`/scope flags, not text parsing; see §3 there).

## 3. Query interpretation (no LLM, weights not routes)

Intent is a **weight vector**, never a gate. Retrieval (2a/2b/3) never reads it; only enrichment (4-7) and presentation do. If
interpretation fails or is wrong, retrieval is identical and the answer is merely less well enriched.

### 3.1 Output

```ts
interface InterpretedQuery {
  raw: string;                    // <= 500 chars (MAX_QUERY_CHARS), trimmed, NFC
  language: "bg" | "en" | "mixed";// by Cyrillic/Latin letter ratio; picks the stopword list
  terms: Term[];                  // content terms after stopword removal (see retrieval-ranking.md §1.3)
  phrase: string | null;          // the entity phrase: raw minus stopwords and intent cue words, for the title-phrase bonus
  intent: IntentWeights;          // each 0..1, several may be non-zero
}
interface IntentWeights {
  factual: number; decision: number; dependency: number; contradiction: number;
  evolution: number; provenance: number; task: number; exploratory: number;   // exploratory = 1 - max(others)
}
```

### 3.2 Rules

Deterministic cue patterns, EN and BG, matched on the folded query. Each matching cue family sets its weight to 1.0 (a second
independent cue in the same family can add nothing; weights are not summed).

| Family | EN cues | BG cues (stems) |
|---|---|---|
| evolution | evolve, change(d), history, over time, develop(ed), how did .* (become|start), earlier, previously | еволюц, промен, развит, развив, история, по-рано, преди, как се е |
| dependency | depend, require, need, prerequisite, blocked by, relies on, builds on | завис, изиска, трябва, нужд, блокир, разчита |
| contradiction | contradict, conflict, disagree, inconsisten, incompatible | противореч, конфликт, несъвмест, не съвпада |
| decision | decide/decision, chose, why did (I\|we), rationale, reason for | реши, решени, избр, защо реш, причина |
| provenance | where .* (come from\|start), original, source, who said, when did I (first)? | откъде, оригинал, източник, кога за пръв, къде съм |
| task | task, todo, action item, next step, to do | задач, да направя, следващ, действ |
| factual | what (is\|do I know\|are), tell me about | какво е, какво знам, разкажи |

Multiple families may fire ("how did X evolve and what does it depend on" -> evolution + dependency). `exploratory` is the
residual. **Why not LLM-classify:** a wrong class would change *which* enrichment runs; with weights, a wrong or absent
classification still returns the correct seeds with default enrichment. An optional LLM-assisted intent (extra request) is
explicitly rejected for v1: it adds latency, cost and a failure mode for a gain not yet shown by the benchmark (`I1`).

### 3.3 What intent changes

| Intent weight >= 0.5 | Graph relation multiplier | Lineage | Provenance excerpts | Kind prior |
|---|---|---|---|---|
| dependency | `depends_on` out x1.5 / in x1.2, other kinds x0.7; allows 2nd hop along `depends_on` | current only | top 3 | none |
| contradiction | `contradicts` x1.6 | current only | top 3 | none |
| decision | `derived_from`,`extends`,`depends_on` x1.2 | + immediate parent of each of top 3 seeds | **top 6, priority** | `decision` x1.15 |
| evolution | `supersedes`,`derived_from`,`extends` x1.3; allows 2nd hop along `supersedes` | **full selective policy** (§6) for top 4 seeds | top 3 | none |
| provenance | `derived_from` out x1.4 | current only | **all packaged seeds, longer excerpt (500)** | none |
| task | `depends_on` in x1.3, `derived_from` in x1.2 (tasks derived from this) | current only | top 3 | `task` x1.15 |
| factual / exploratory | defaults (§5.2) | current only | top 3 | none |

Multiplier stacking: product, clamped to [0.3, 2.0].

## 4. Candidate generation

See [retrieval-ranking.md](retrieval-ranking.md). Output of stage 3: up to **8 seeds**, each with `lexicalRank?`,
`semanticRank?`, `hybridScore` in [0, 1], and an admission reason.

## 5. Graph expansion (bounded, deterministic)

### 5.1 Algorithm

```
input: seeds (ranked), intent weights, scope
E_seeds  = first 5 seeds (by hybridScore)
edges    = ONE query: relations WHERE source_object_id IN E_seeds OR target_object_id IN E_seeds   -- uses by_source / by_target
neighbor = batched read of the far endpoints (WHERE id IN (...)), carrying project_id
for each edge (seed s, far endpoint x, kind k, direction d relative to s):
    skip if x is a seed or already admitted (dedupe; keep the best-scoring `via`, remember up to 3 more as `alsoVia`)
    skip if x.project_id != scope  and  not eligible per §2.1
    score(x) = hybridNorm(s) * W[k][d] * M_intent[k][d] * 0.6          // hop decay 0.6
admission:
    per seed:   <= 4 objects, <= 2 per relation kind
    global:     <= 12 in-scope expanded; <= 3 external
    floor:      score >= 0.25 * score of the weakest seed (never admit a neighbour that outranks nothing)
    order:      score desc, then relation createdAt asc, then object id (deterministic)
second hop (only if intent.dependency >= 0.5 via depends_on out-edges, or intent.evolution >= 0.5 via supersedes edges):
    repeat once with the admitted neighbours as frontier restricted to that single relation kind;
    <= +4 objects, decay 0.6 again; external objects are NEVER a frontier.
cycles: a global `visited` set (seeds + admitted) means no node is expanded or re-admitted twice; A<->B loops and self-reachable paths terminate.
```

### 5.2 Base relation weights (relative to the seed)

Semantics are **unchanged**; direction is read relative to the seed object `s`, with `out` = `s` is the stored source.

| Relation | seed is source (`out`) | seed is target (`in`) | Rationale |
|---|---|---|---|
| `related_to` (sym) | 0.50 | 0.50 | weakest signal; many model-proposed |
| `extends` | 0.70 (`s` extends X: X is the parent context) | 0.60 (X extends `s`: later detail) | |
| `depends_on` | 0.80 (what `s` needs) | 0.60 (what needs `s`) | forward dependencies answer "what does X depend on" |
| `contradicts` (sym) | 0.80 | 0.80 | always worth surfacing |
| `derived_from` | 0.70 (`s`'s origin) | 0.50 (things derived from `s`) | |
| `duplicates` (sym) | 0.40 | 0.40 | included only as a labelled alias; not extra knowledge |
| `supersedes` | 0.70 (X is what `s` replaced) | **0.90** (X replaces `s`: `s` may be obsolete) | the newest replacer is critical to correctness |

Symmetric and directional edges behave differently only through this table: symmetric kinds are stored once with the smaller id
as source, so `out`/`in` is **meaningless** for them and both columns are equal by construction (the engine reads them as one value).

### 5.3 Why 1 hop, 5 seeds, 12 objects

* With a sparse model-proposed graph, hop 2 from 5 seeds can reach >100 objects on a hub; 1 hop at fan-out <= 4 bounds work and
  tokens by construction, regardless of graph density.
* The hop-2 exceptions exist because "what does X depend on" is a *chain* question (X -> Y -> Z) and "evolve" is often a
  `supersedes` chain. They are the only places depth is justified, and they follow one relation kind, so cannot fan out.
* Whether the exceptions earn their cost is benchmark `G1`; the kill criterion is in benchmark-plan.md.

### 5.4 Marking (stage 5)

After expansion, over the admitted set only (no extra reads):

* `supersedes(A -> B)` with both present: B gets `supersededBy: A`, score x0.7 (x1.0 if evolution intent, since history is wanted).
  If only B is present and A is outside the set, a batched existence check still labels B `supersededBy` (one query, <= 13 ids).
* `duplicates(A, B)`: keep the higher-scored as the entry; the other collapses into `aliases: [id]` (no body).
* `contradicts(A, B)` both present: both get `conflictsWith`, plus the relation as `via` so the model sees it is a conflict.

## 6. Thought Lineage policy

Principle: **current knowledge and historical thought state never share a field.** The object entry's `body` is always the
current revision. History lives only in separate `role: "history"` entries, each tagged `status`.

### 6.1 Defaults

Every evidence object carries `revisionCount` and `currentRevisionOrigin` (cheap, from `knowledge_objects` + one grouped count).
No older text is supplied unless the policy below selects it.

### 6.2 Selection (batched; one revisions query + one parents query for <= 4 objects)

For each selected object `O` (selection per §3.3), from `thought_revisions`/`revision_parents`:

1. **current**: already the entry.
2. **parent path:** walk first-parent ancestry from current toward the root, at most **6** revisions (`MAX_PATH`). A merge
   revision includes *all* its parents' immediate revisions (cap 3), flagged `mergeParent`.
3. **significant points inside the walked ancestry:** a revision with >= 2 children (a **branch point**), a revision with >= 2
   parents (a **merge**), a revision with `origin = 'distillation'` and its own provenance (**new-capture revision**), and the
   `initial` revision (root).
4. **non-current heads:** revisions with no children that are not current (abandoned/unadopted branches), at most **2**,
   most recent first, flagged `branch_not_current`.
5. **matched revision:** the historical revision that nominated the object in §6.4, if any.

Union, dedupe, chronological order, hard cap **12 per query** (4 objects x <= 6 typical; evolution intent only). Over cap: keep
current, root, matched, merges, new-capture revisions, branch points, then path by recency.

### 6.3 Presentation

History text is capped at 300 chars (400 for evolution intent). For revision pairs where both are present, a compact **word-level
change summary** (the existing `diffRevisions` algorithm, ported server-side) is preferred over repeating full text when over
budget: `title: "A" -> "B"`; `body: +added / -removed` snippets <= 200 chars.

Each history entry states `status` in {`historical`, `branch_not_current`}, `origin`, `createdAt`, and `leadsToCurrent: boolean`.

### 6.4 Historical nomination path (gated)

Only when `intent.evolution >= 0.5` **or** fewer than 3 seeds were admitted: a second FTS query over **non-current** revisions
of in-scope objects (`o.current_revision_id <> r.id`), top 10, rank-weighted 0.5 in RRF as channel `historical`. A hit nominates
its owning object (so the object enters as a seed with its *current* body) and records the `matchedRevisionId`. It is how
"voice-only" is found though the current text no longer says it. Cost: one extra indexed query (~10 ms).

### 6.5 Avoiding obsolete-as-current

Defence in depth, each independently testable:

1. Retrieval 2a/2b only ever return **current** revisions (`current_revision_id` join; embeddings valid only when
   `revision_id == current_revision_id`).
2. The evidence schema has no field that can hold historical text in a current slot.
3. Branches that are not current are `branch_not_current`, never `current`.
4. `supersededBy` demotion and labelling for objects replaced by a graph `supersedes`.
5. The synthesis prompt requires `temporal` per paragraph; the validator downgrades `current` -> `historical` if every cited
   handle is a history entry, and rejects `current` citing only a `branch_not_current` entry.
6. Benchmark `obsolete-revision traps` measure leakage at retrieval and answer level (hard gate: 0 at retrieval).

## 7. Provenance

Detailed in [evidence-contract.md](evidence-contract.md) §1. Pipeline note: stage 7 collects all `capture_id`s needed by the
packaged objects (initial source + current-revision source) and issues **one** `SELECT ... WHERE id IN (...)`, then slices spans by
code points (the existing `sliceCodePoints` semantics; offsets are code points, not bytes or UTF-16 units; the Rust side already
validates with `validate_span`).

## 8. Expected performance

Target: 10,000 objects, ~50,000 relations, ~30,000 revisions, several projects, scope project up to 5,000 objects. Warm cache,
desktop; mobile budget in parentheses (x2.5).

| Stage | p50 | p95 budget | Mechanism |
|---|---|---|---|
| 1 interpret | <1 ms | 2 ms | pure CPU |
| 2a lexical (FTS5 + project join) | 5 ms | 25 ms (60) | bm25 over matches then project filter; <= 30 rows |
| 2b semantic scan | 10 ms | 40 ms (110) | project-scoped BLOB scan; 5k x 512 f32 = 10 MB, dot products only |
| 2b query embedding | 300 ms | 1,500 ms hard timeout | network, overlapped with 2a |
| 3 merge | <1 ms | 2 ms | |
| 4 expansion | 3 ms | 15 ms (40) | one edge query by index + one `IN` read |
| 5-6 enrichment + lineage | 5 ms | 25 ms (60) | one revisions query + one parents query for <= 4 objects |
| 7 provenance | 3 ms | 15 ms (40) | one `IN` query, <= 20 captures |
| 8-9 evidence + budget | 2 ms | 10 ms | pure CPU |
| **Local retrieval total (excl. network)** | **~30 ms** | **<= 100 ms (250)** | |
| 10 synthesis | 2.5 s | 12 s, 30 s hard timeout | one `complete_json` (<= 2 on invalid structure) |
| **End to end** | **~3 s** | **<= 8 s** | dominated by the two network calls |

Provider calls per `ask`: 1 embedding + 1 chat (+1 chat on a structural retry); 0 embeddings if disabled/unavailable.

### 8.1 N+1 hazards (and the rule that avoids each)

| Hazard | Rule |
|---|---|
| Calling the existing per-object client APIs (`getObjectRelations`, `getObjectLineage`, `getRevisionParents`) in a loop | Recall runs **inside** the native layer on batched SQL; it never goes through `ArthurClient`/IPC per object. |
| Neighbour objects fetched one by one after the edge query | Single `WHERE id IN (...)` for all far endpoints. |
| Lineage walk issuing a query per ancestor | Load all revisions of the <= 4 objects in one query (<= 1,000 each, bounded by `MAX_REVISIONS_PER_OBJECT`) and parents in one query; walk in memory. |
| Captures fetched per object | One `IN` query for the union of capture ids. |
| `project_graph`-style whole-project load | Forbidden in Recall; only seed neighbourhoods are read. |
| Vector read per row in the scan | One prepared statement streaming BLOBs, validated length once; optional per-project in-memory matrix cache only if `p95(2b) > budget` (benchmark `P1`). |
| FTS `LIMIT` applied before project filter returning too few in-scope rows | Query ordered by bm25 with the project join in the same statement and `LIMIT` after filtering (or `LIMIT 200` then filter, whichever the probe shows faster); correctness test with a small project among large ones. |
| Summaries (`revisionCount`) per object | One grouped `COUNT` for the packaged ids. |

Never read the whole Cognitive Store in a query; the only whole-project read is the 2b vector scan, and it reads vectors only.
