# Retrieval and ranking

Candidate generation is **project-scoped in SQL**, **current-state only**, and every channel is independently optional.

## 1. Lexical retrieval (FTS5)

### 1.1 Decision

SQLite **FTS5**, because it is already compiled into the bundled SQLite on every platform (`libsqlite3-sys` `build.rs` enables
`SQLITE_ENABLE_FTS5`), needs no dependency, supports bm25, prefix queries and incremental updates, and is transactional with the
data. Alternatives considered:

| Option | Verdict |
|---|---|
| `LIKE` / `instr(lower(...))` | **Rejected as primary.** SQLite `lower()` is ASCII-only (probed: `lower('МОБИЛНО')` returns it unchanged), so Cyrillic case-insensitivity silently breaks; also no ranking, full scan. |
| FTS5 `unicode61` | **Chosen.** Probed: folds Cyrillic case; `remove_diacritics 2` handles Latin diacritics. No stemming (so BG inflection is handled at query time, §1.4). |
| FTS5 `porter` | Rejected: English-only stemmer; harms Bulgarian and mixed text. |
| FTS5 `trigram` | Probed: matches `мобилн` inside `Мобилно`/`мобилните` and `идеи` in `Идеите`, i.e. handles inflection without a stemmer, but needs queries >= 3 chars, bigger index, noisier ranking. **Held back**, added as a rebuildable second table only if benchmark `B1` fails (see §1.7). |
| Custom inverted index in Rust | Rejected: reimplements FTS5, no benefit. |

### 1.2 What is indexed

One external-content FTS5 table over **`thought_revisions`** (`title`, `body`), rowid = `thought_revisions.seq`.

* **All revisions are indexed; "current" is decided at query time** by joining `knowledge_objects o ON o.current_revision_id = r.id`.
  Because revisions are immutable (update triggers abort), the index is **insert-only**: an `AFTER INSERT` trigger adds the row,
  nothing ever needs updating, and stale-as-current is structurally impossible (an edit adds a revision and flips
  `current_revision_id`; the old row is automatically "historical").
* Consequences: edit, branch (not current), merge (current or not), project move and archive need **no index maintenance**.
* `kind` is *not* indexed as text (kind words rarely occur in the question). It is a filterable column read from the join; the
  kind prior (§4) uses it.
* **Project ownership is not indexed** (it is mutable). It is a join predicate `o.project_id = ?` using
  `knowledge_objects_by_project`.
* **Captures are not indexed in v1.** The unit of knowledge is the object; raw captures are provenance, not retrieval targets.
  A capture-text fallback table is evaluated only if benchmark class `distillation-miss` shows relevant facts living only in
  undistilled capture text (then `capture_fts`, rebuildable, v8).
* **Historical revisions** are reachable only through the gated nomination path (pipeline.md §6.4), not the current query.

### 1.3 Tokenizer, Unicode, Bulgarian

```
tokenize = 'unicode61 remove_diacritics 2'
```

* Full Unicode case folding including Cyrillic (probed). No `tokenchars` (hyphens and underscores split: `capture-first`
  becomes `capture`, `first`; this is desired for recall).
* Input must be **NFC** at index and query time. Probed: NFC `край` matches (`й` is preserved, not folded to `и`), but an NFD
  query (`и` + U+0306) does **not** match NFC text, so the query normaliser applies NFC (revision text is stored as written;
  the NFC requirement for indexed text is checked by test and, if a decomposed capture ever appears, indexing is done over an
  NFC copy by the trigger-independent rebuild path; see storage-plan.md "NFC risk"). Probed: a stress mark (U+0301) inside
  indexed `ва́жно` still matches the plain query `важно`.
* **Stopwords** are removed from the *query* only (never from the index): small BG and EN lists (e.g. `и, на, в, за, с, да, е,
  се, че, как, какво, the, a, of, to, how, what, did, my`), plus intent cue words (`evolve`, `depend`, `развит`...) so
  they do not dominate bm25. If removal leaves zero terms, the lexical channel is skipped (semantic and `phrase` still run).
* Latin and Cyrillic mixed text works because tokenisation is per Unicode word.

### 1.4 Query construction (and injection safety)

Every term is double-quoted and quote-escaped, so no user text is ever interpreted as FTS5 syntax (`NEAR`, `-`, `*`, column
filters, parentheses):

```
terms -> for each content term t:
           stem(t) = light stem (below)
           token   = len(stem) >= 4 ? "\"" + stem + "\"*"      // prefix match: covers inflections
                                    : "\"" + t + "\""          // exact for short words
query   = token1 OR token2 OR ...                               // OR: recall-first; bm25 restores precision
MATCH   = '{title body}: (' + query + ')'
```

Light stemmer (deterministic, a few dozen rules, no dependency):

* **Bulgarian** (Cyrillic term, len >= 5): strip the longest matching suffix among the definite-article/plural/ending set
  `{ите, ата, ото, ето, ият, ия, ът, ят, ове, ища, та, то, те, ци, ия, и, а, я, о, е}`, keeping a stem of >= 4 letters. Example:
  `идеята`, `идеите`, `идеи` -> `иде*` (matches all; probed: bare `"идея"` matched none of them).
* **English** (Latin term, len >= 5): strip `ing, ed, es, s, ly`, stem >= 4.
* Over-matching risk (`иде*` also matches `идент...`) is accepted: bm25 and the semantic channel correct it; benchmark `B1`
  measures the precision cost.

Known limitation: stemming is heuristic; irregular Bulgarian forms (`ден/дни`, `човек/хора`) are not unified lexically. That is
what the semantic channel is for, and what the trigram fallback would not fix either.

### 1.5 Ranking

```
SELECT o.id, bm25(recall_revision_fts, 8.0, 1.0) AS s        -- title weighted 8x body; bm25 returns smaller = better
FROM recall_revision_fts f
JOIN thought_revisions r ON r.seq = f.rowid
JOIN knowledge_objects o ON o.current_revision_id = r.id     -- current only
WHERE recall_revision_fts MATCH ?1 AND o.project_id = ?2
ORDER BY s LIMIT 30
```

Rank = position in this list (1-based). The raw bm25 value is kept only for diagnostics and the coverage floor; fusion uses rank.
After retrieval, **term coverage** (fraction of distinct content terms with a stem-prefix match in title+body) is computed in
Rust over the <= 30 rows and used for the admission floor (§3.1).

### 1.6 Update strategy

Triggers on `thought_revisions` (`AFTER INSERT`, `AFTER DELETE` for safety), in the same transaction as the revision insert.
The index is therefore **always fresh**; lexical recall of a new object is immediate (including right after distillation, before
any embedding exists). `INSERT INTO recall_revision_fts(recall_revision_fts) VALUES('rebuild')` regenerates it from content;
`'integrity-check'` verifies it. See storage-plan.md.

### 1.7 Fallback and the trigram decision

* **FTS unavailable/corrupt** (integrity check fails or a query errors): a Rust-side scan of the scope project's current objects
  (<= tens of thousands of short rows; ~10 ms for 5k) using `str::to_lowercase()` (full Unicode, unlike SQLite `lower`), the same
  stopwords/stemmer, and a deterministic term-overlap score (title hits x3 + body hits). Slower, lower quality, never wrong
  about scope or currency. The engine reports `lexical: "degraded_scan"`.
* **Trigram:** benchmark `B1`: if Bulgarian-inflection class Recall@10 (lexical channel alone) is below 0.80 or more than
  10 pp under English, add a `trigram` FTS table over the same content (rebuildable, v8) as an additional channel merged by RRF.
  Not shipped in v7 to avoid ~3x index size without evidence.

## 2. Semantic retrieval

Details of storage and lifecycle are in storage-plan.md; ranking-relevant behaviour:

* The query is embedded with the **same model key** as the stored vectors (`purpose = Query`; OpenAI has no asymmetric mode, so
  identical). If no stored vectors exist for the active model key, the channel is `unavailable: no_index`, not an error.
* Vectors are stored **L2-normalised** (f32, little-endian), so similarity is a dot product. Scan:

```
SELECT o.id, e.vector FROM knowledge_objects o
JOIN recall_embeddings e ON e.object_id = o.id AND e.model_key = ?1 AND e.revision_id = o.current_revision_id
WHERE o.project_id = ?2
```

  The `revision_id = current_revision_id` condition makes a **stale vector unusable by construction** (it is simply not
  joined), so an edited-since-embedded object is lexical-only until re-embedded and can never be matched on its old meaning.
* Top 30 by cosine, with `cos >= tau_sem`. **`tau_sem` = 0.40 for `text-embedding-3-small` @ 512 (calibrated live in M04B; the original placeholder was 0.30)** (to be calibrated on the zero-result class;
  `text-embedding-3-small` cosines for unrelated text are typically 0.05-0.25 and for related text 0.35+, but this is not
  guaranteed for Bulgarian; benchmark `S1` sets it per language and records the chosen value in the recall meta table).
* Partial coverage is normal (some objects not yet embedded). It is **reported** (`coverage = embedded/total in scope`), not hidden.
* Historical revisions are **not** embedded in v1: an evolution query reaches old wording through the lexical nomination path
  and lineage, and embedding every revision would multiply cost 3-10x for an unproven gain (benchmark `E2` can reopen this).

## 3. Hybrid merge and ranking (exact v1 semantics)

### 3.1 Admission floors (before fusion)

* Lexical candidate admitted iff `coverage >= 0.5` when the query has >= 3 content terms, else any match.
* Semantic candidate admitted iff `cos >= tau_sem`.
* An object admitted by neither is not a seed. If the union is empty -> `insufficient_evidence` (no synthesis call; see failure-model.md).

### 3.2 Fusion

Reciprocal Rank Fusion, rank-based so incomparable bm25 and cosine scales never mix:

```
rrf(o)  = sum over channels c in {lexical, semantic}: 1 / (K + rank_c(o))          K = 60
        + 0.5 * 1 / (K + rank_historical(o))   if nominated by the gated historical path
active  = number of channels that actually ran and returned >= 1 candidate (1 or 2)
h(o)    = rrf(o) / (active / (K + 1))          // 1.0 = rank 1 in every active channel; comparable across degradations
bonus   = 0.15 if normalise(title(o)) contains normalise(interpreted.phrase)  (and phrase has >= 2 content terms or >= 6 chars)
prior   = kind prior (§3.3)
hybrid(o) = min(1.0, (h(o) + bonus)) * prior
```

Why RRF with `K = 60`: rank-based fusion is parameter-light, robust to the incompatible score distributions, deterministic, and
inspectable ("lexical rank 2, semantic rank 5"). It is also what `src/memory/retrieval/fusion.ts` settled on, so the choice is
consistent and not new risk. A score-normalised weighted sum was rejected for v1: it needs per-corpus calibration of both
distributions and breaks silently when one channel degrades. `K` (30/60/100) is benchmarked (`F1`) but 60 is the default.

### 3.3 Kind prior

Bounded multiplier in [0.85, 1.15], applied only when an intent weight is >= 0.5: `decision` intent x1.15 for `kind=decision`;
`task` intent x1.15 for `kind=task`; otherwise 1.0. Non-matching kinds are **not** penalised (an `idea` explaining a decision
must still surface); the 0.85 floor is reserved and unused in v1.

### 3.4 Recency

**Recency is not a score factor.** An old decision beats a new note if it matches better. It is used only as the **final
tie-break**:

```
order = hybrid desc, then currentRevision.createdAt desc, then knowledge_objects.seq asc, then id asc
```

Replacement of old knowledge by new knowledge is expressed through *explicit* structure: a `supersedes` edge (demotion x0.7, and
the replacer surfaces by expansion weight 0.9) and lineage. Benchmark class `old-decision-vs-new-note` guards this.

### 3.5 Seed selection

```
pool  = fused candidates sorted as above (<= 40 distinct)
seeds = top of pool while hybrid >= 0.5 * hybrid(rank 1), capped at 8, minimum 1
graph-expanding seeds = first 5 of seeds
```

Lexical-only and semantic-only degradations use the same procedure; `h` is normalised by `active`, so thresholds stay meaningful.

### 3.6 What every seed records (for debugging and the evidence package)

`lexicalRank?`, `semanticRank?`, `historicalRank?`, `lexicalCoverage?`, `cosine?`, `hybridScore`, `bonus`, `prior`, `admission`
(`both | lexical | semantic | historical`). These are returned in `evidence[].retrieval`, so ranking is inspectable in the UI debug
view and asserted in tests. No hidden model reranker exists in v1. A reranker is reconsidered only if benchmark `F2` shows
hybrid precision@8 below 0.6 with recall@40 above 0.9, i.e. the right objects are retrieved but mis-ordered.

## 4. Open ranking parameters and what decides them

| Parameter | v1 default | Decided by |
|---|---|---|
| RRF `K` | 60 | `F1` (30 / 60 / 100) |
| Seed cap / relative cutoff | 8 / 0.5 | `F3` (Recall@8 vs context tokens) |
| Lexical title weight | 8x | `B2` (4 / 8 / 16) |
| `tau_sem` | 0.30 (placeholder) | `S1` zero-result + precision sweep, per language |
| Phrase bonus | +0.15 | `F4` (0 / 0.1 / 0.15 / 0.25) |
| Stem-prefix min stem length | 4 | `B1` |
| Embedding dims | 512 | `E1` (512 vs 1536) |
| Trigram channel | off | `B1` |
