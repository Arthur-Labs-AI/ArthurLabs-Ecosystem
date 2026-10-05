# Storage plan: schema v7, embeddings, freshness

**Design only. No migration or schema change was made in M04A.**

## 1. Authoritative vs rebuildable

| Authoritative (never derived from Recall) | Rebuildable projection (Recall owns, may be dropped any time) |
|---|---|
| `captures`, `distillation_runs`, `knowledge_objects`, `object_sources`, `relations`, `thought_revisions`, `revision_parents`, `projects`, `active_project`, `organization_failures` | `recall_revision_fts` (FTS5), `recall_embeddings`, `recall_meta` |

Rules:

* Nothing in the left column is read from or written by the right column's lifecycle. Dropping every `recall_*` object and
  rebuilding yields identical **retrieval inputs**; no knowledge is lost.
* The `memory` subsystem (`src/memory`, `memory_items`) is **not** used or extended; Recall's indexes live in the same SQLite file
  as the Cognitive Store so they commit atomically with it (FTS) and can use plain joins, but they are separate tables with no
  foreign key *into* authoritative tables' semantics beyond cascade cleanup.
* Embeddings never decide what an object says. Evidence text is always re-read from `knowledge_objects`/`thought_revisions` at
  query time, never from an index.

## 2. Does M04 need schema v7? Yes.

Reason: FTS5 must be created and backfilled in the store's migration path (so lexical Recall works immediately after upgrade and
stays transactionally fresh), and embeddings need a table. Both are **additive**; all v1-v6 tables, triggers, and data are untouched.
Following the existing migration pattern (`STEPS` with `(7, SCHEMA_V7)`, one transaction with the `user_version` bump, plain
`CREATE` without `IF NOT EXISTS` so conflicts surface, rollback on failure, newer-db refusal unchanged).

### 2.1 Proposed `SCHEMA_V7`

```sql
-- v7 (M04): Cognitive Recall indexes. Every object here is a REBUILDABLE PROJECTION of v1-v6 data.
-- Nothing authoritative changes.

-- Lexical index over revisions. Revisions are immutable, so this index is insert-only; "current" is decided at
-- query time by knowledge_objects.current_revision_id. Project is NOT indexed (it is mutable): it is a join predicate.
CREATE VIRTUAL TABLE recall_revision_fts USING fts5(
    title, body,
    content = 'thought_revisions',
    content_rowid = 'seq',
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER recall_fts_after_revision_insert AFTER INSERT ON thought_revisions
BEGIN
    INSERT INTO recall_revision_fts(rowid, title, body) VALUES (NEW.seq, NEW.title, NEW.body);
END;

CREATE TRIGGER recall_fts_after_revision_delete AFTER DELETE ON thought_revisions   -- never fires today; keeps the index honest
BEGIN
    INSERT INTO recall_revision_fts(recall_revision_fts, rowid, title, body) VALUES ('delete', OLD.seq, OLD.title, OLD.body);
END;

-- (no UPDATE trigger: thought_revisions_are_immutable already aborts every update)

INSERT INTO recall_revision_fts(recall_revision_fts) VALUES ('rebuild');           -- backfill all existing revisions

-- Embeddings of the CURRENT projection of an object. Valid only while revision_id = knowledge_objects.current_revision_id
-- and model_key = the active key. Project is not stored: moving an object never touches this table.
CREATE TABLE recall_embeddings (
    object_id   TEXT    NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
    model_key   TEXT    NOT NULL CHECK (length(model_key) > 0),   -- 'openai:text-embedding-3-small:512:v1'
    revision_id TEXT    NOT NULL REFERENCES thought_revisions(id) ON DELETE CASCADE,
    dims        INTEGER NOT NULL CHECK (dims > 0),
    vector      BLOB    NOT NULL CHECK (length(vector) = dims * 4), -- f32 little-endian, L2-normalised
    text_hash   TEXT    NOT NULL,                                   -- sha-256 of the exact embedded text (re-embed skipping)
    created_at  TEXT    NOT NULL CHECK (length(created_at) > 0),
    PRIMARY KEY (object_id, model_key)
);
CREATE INDEX recall_embeddings_by_model_revision ON recall_embeddings(model_key, revision_id);

-- Small key/value for index facts and calibrated parameters. Rebuildable defaults if empty.
CREATE TABLE recall_meta (
    key   TEXT PRIMARY KEY CHECK (length(key) > 0),
    value TEXT NOT NULL
);
-- keys: active_model_key, tau_sem_<lang>, fts_tokenizer_version,
--       has_non_nfc ('1' if any revision text is not NFC; see §6), index_rebuilt_at
```

Notes:

* `recall_embeddings` primary key `(object_id, model_key)`: two model keys may coexist during a model migration (§4.4).
* The vector column stores exactly `dims * 4` bytes (enforced); `dims` is part of `model_key` and is also stored for validation.
* No project column anywhere in v7. No new trigger on `knowledge_objects` or `relations`.
* Down-migration is not provided (the repo has none); rollback = restore from a pre-upgrade copy, as for v1-v6. Because v7 is
  purely additive, dropping the three `recall_*` tables and two triggers and setting `user_version` back is mechanically safe but
  unsupported by the migrator, and unnecessary.

### 2.2 Migration proof obligations (for M04B, mirroring the v6 tests)

1. A populated v6 database upgrades to v7; **every v6 table fingerprint is byte-identical** (same fingerprint approach as the v6 proof).
2. FTS row count equals `thought_revisions` row count; `integrity-check` passes; a Cyrillic/Latin probe set matches.
3. Re-running the migrator is a no-op; a failing v7 step rolls back to v6 intact (blocker pattern: pre-existing `recall_embeddings`
   table with a `precious` row); a database newer than the code is refused untouched.
4. Backfill cost on a 30,000-revision database is measured and recorded (expected well under 2 s; if over, backfill moves
   out of the migration into a post-open step with lexical reporting `degraded_scan` meanwhile).
5. Deterministic: repeated migrations of the same input produce the same index content hash.

## 3. Embedding design

### 3.1 What is embedded

One vector per KnowledgeObject = embedding of its **current projection**:

```
text = "{kind}: {title}\n{body}"      // exactly the knowledge_objects columns; <= 200 + 2000 chars
```

* **Not** embedded: project name/id (so moves never invalidate), relations, provenance, lineage, historical revisions, captures.
* Embedding only the current projection (vs every revision) is chosen because: (a) Recall answers about *current* thought state
  by default; (b) it keeps the index 1 row per object and bounds provider cost to the number of objects, not revisions;
  (c) a historical vector would risk surfacing obsolete text as a relevant "current" hit; (d) history questions are served by
  lexical nomination and lineage. Reopened only by benchmark `E2` (evolution queries failing on recall of the object).
* Long bodies are within the 2,000-char body cap; no chunking is needed (one object = one vector; the object *is* the chunk).

### 3.2 Model abstraction

```rust
// providers/embed.rs  (proposed)
pub struct ModelKey(String);                 // "openai:text-embedding-3-small:512:v1"
pub enum EmbedPurpose { Document, Query }    // lets a future asymmetric/local model (e5-style prefixes) differ
#[async_trait]  // or the repo's BoxFuture pattern, as graph/openai.rs does
pub trait EmbeddingProvider: Send + Sync {
    fn model_key(&self) -> &ModelKey;
    fn dims(&self) -> usize;
    fn max_batch(&self) -> usize;            // 64
    async fn embed(&self, texts: &[String], purpose: EmbedPurpose) -> Result<Vec<Vec<f32>>, EmbedFailure>;
}
pub enum EmbedFailure { NotConfigured, Network, Auth(u16), Provider(u16), Unreadable(String) }   // mirrors ChatFailure; never carries bodies
```

* v1 implementation: OpenAI `text-embedding-3-small`, request `dimensions: 512`, using the existing `CredentialSource`, the shared
  `reqwest` client builder, no redirects with credentials (same hardening as `chat.rs`), 3 s timeout for queries, 20 s for batches.
* **Version suffix `v1`** in the key covers our own prompt/text-format changes (e.g. changing the embedded text template bumps it).
* A future **local** embedder (e.g. a multilingual e5/bge via ONNX, relevant for Bulgarian) is a second implementation with its
  own key; nothing else changes (storage is keyed by `model_key`, vectors by `dims`).
* Dimensionality: 512 default (storage 2 KB/object: 10k objects = 20 MB). 1536 only if benchmark `E1` shows a >= 3 pp Recall@10
  gain (cost: 61 MB at 10k and ~3x scan time).
* Storage format: f32 LE BLOB, L2-normalised at write time; cosine = dot. Scalar int8 quantisation is a possible later change
  recorded as a new `model_key` revision (`...:512:v1q8`), not needed at this scale.

### 3.3 When embeddings are created

**Only when semantic Recall is enabled (§3.6); then lazily, bounded, derived.** No durable job queue, because the work set is a query:

```
missing_or_stale = SELECT o.id, o.current_revision_id FROM knowledge_objects o
                   LEFT JOIN recall_embeddings e ON e.object_id = o.id AND e.model_key = :active
                   WHERE e.object_id IS NULL OR e.revision_id <> o.current_revision_id
```

An in-process **indexer** (single task per app instance) drains `missing_or_stale` in batches of <= 64 objects (one provider
request per batch):

* **Triggers (non-blocking, never awaited by the user flow):** after distillation commits, after an edit/merge sets a new
  current revision, at app start, when Ask Arthur opens (so a first query is not entirely un-indexed), and on a bounded timer
  while work remains.
* **Backoff on failure:** in-memory exponential backoff (30 s -> 15 min); no failure rows. After restart it simply retries.
* **Rate/cost bound:** at most 256 objects per trigger run; cost is at most (objects x ~600 tokens) once, plus changed objects.
* Embedding failures never fail distillation, editing, or capture. They only leave the semantic channel partial.
* `text_hash` lets the indexer **skip the provider call** when a new current revision has byte-identical embedded text to an
  existing vector (e.g. a merge adopting an existing wording): it rewrites the row's `revision_id` and keeps the vector.

### 3.4 Lifecycle by event

| Event | Embedding effect |
|---|---|
| New KnowledgeObject (distillation) | Row missing -> indexer embeds. Lexical is immediate. |
| User edit (new current revision) | `revision_id` mismatch -> vector **ignored at once** (stale-join), re-embedded by the indexer; lexical sees the new text immediately. |
| **Branch without `makeCurrent`** | `current_revision_id` unchanged -> **no change**, no re-embedding, branch text never embedded. |
| **Merge with `makeCurrent`** | Current changes -> stale -> re-embed (or hash-skip). Merge without `makeCurrent`: no effect. |
| Make-current of an existing revision (future) | Same as an edit: stale-join -> re-embed. |
| **Move to another project** | **Nothing.** Scope is a query-time join on `knowledge_objects.project_id`; the vector and its row are untouched. |
| Project archive / restore | Nothing. Vectors and FTS rows are kept. (Whether an archived project is searched is a query-time scope/graph rule, not an index state.) |
| Relation create / change | Nothing (graph is read live; relations are not embedded). |
| Object delete (not an operation today) | `ON DELETE CASCADE` removes the vector; FTS delete trigger removes revision rows. |
| Model key change | §3.5. |

### 3.5 Migration / re-embedding

* The **active model key** is configuration (`recall_meta.active_model_key`, defaulting to the compiled provider's key). Queries
  use only the active key; vectors for other keys are ignored.
* Changing key: the indexer treats every object as missing for the new key; the old key's rows remain valid for rollback until
  new-key coverage >= 99% of objects, then are garbage-collected in a bounded sweep. During the transition, semantic coverage is
  partial and Recall degrades gracefully (lexical covers; reported `coverage`).
* A rebuild never needs the old vectors; a provider switch never needs a schema change.

### 3.6 Consent: opt-in semantic Recall

* **Preference:** one boolean, `semantic_recall_enabled`, **default false, absent = false**. Global, per device, **no per-project
  setting**. It is a user choice about data leaving the device, so it is **not** stored in `recall_meta` (a rebuildable
  projection that may be dropped); it lives in the app-private local settings area beside the credentials file, read on use,
  written only by an explicit user action. Dropping or rebuilding any `recall_*` table therefore never changes consent, and a
  lost settings file fails closed (off). No schema change is needed for it.
* **Disabled (default):** the indexer never runs; no document or query embedding request is ever made, even if a key exists and
  vectors exist. Diagnostics `semantic: "disabled"`. Distillation, relations, synthesis and everything else are unaffected.
* **Enabling:** explicit action with a plain disclosure: what is sent (each object's kind, title and body, once, plus each
  question), to whom (the configured embedding provider), that vectors stay local, and the count of objects to be indexed. Requires
  a configured key. On enable, bounded background indexing starts (§3.3 limits). Progress is the `semanticCoverage` already
  reported by `ask`; Recall is usable throughout (partial coverage degrades gracefully).
* **Disabling:** takes effect immediately and for everything: the running indexer stops after its in-flight batch (no further
  batches), pending work is simply not started (it is a derived query, not a queue), and query embedding stops. **Existing local
  vectors are retained but ignored.** Rationale (privacy-conservative): vectors never leave the device and are derived data,
  but they are *unusable* while disabled because a semantic search needs the query embedded, which is an upload the user has
  declined; keeping them avoids re-uploading the entire corpus on a later re-enable. Nothing is deleted implicitly, nothing
  is silently reused.
* **Purge:** a separate explicit "Delete semantic index" action deletes all `recall_embeddings` rows (and, if desired,
  disables). The privacy contract: after purge no derived vector of the user's text remains on the device.
* **Re-enabling:** resumes from the derived work set; only missing or stale objects are embedded (stale = revision changed or
  model key changed while it was off); retained valid vectors are used immediately.
* Changing the embedding provider or model key is a new consent surface (a different recipient) and requires the user to
  re-enable, i.e. the preference is bound to the provider id it was granted for (`semantic_recall_provider` stored beside the boolean;
  mismatch = off).

## 4. Freshness / invalidation

| Item | Mechanism | Freshness |
|---|---|---|
| Lexical (FTS) | AFTER INSERT trigger on `thought_revisions`, same transaction | **Exact, immediate**; cannot lag or go stale |
| Which revision counts as current | Query-time join on `knowledge_objects.current_revision_id` | Exact |
| Project filter | Query-time join on `knowledge_objects.project_id` | Exact (moves instant) |
| Embeddings | Valid only if `revision_id = current_revision_id` and key = active | Eventually consistent; **stale vectors are never used**, so they cannot cause wrong results, only fewer semantic hits |
| Graph | Live reads of `relations` | Exact |
| Lineage | Live reads of immutable revisions | Exact |
| Provenance | Live reads of `object_sources`, `captures` | Exact |

There is no cache in v1 whose invalidation could be wrong. (An optional in-memory per-project vector matrix cache, if benchmark
`P1` demands it, is keyed by `(project_id, model_key, embeddings_epoch)` where `embeddings_epoch` is a counter bumped on every
`recall_embeddings` write; a move bumps a `membership_epoch` read from `knowledge_objects` count/max(seq) + a tiny change
counter, or simply bypasses the cache for one query; decided if and when needed.)

## 5. Index rebuild strategy

| Index | Rebuild | When |
|---|---|---|
| FTS | `INSERT INTO recall_revision_fts(recall_revision_fts) VALUES('rebuild')` (single statement, transactional) | Migration backfill; after tokenizer/stemmer-version change; on failed `integrity-check`; a user-visible "Rebuild search index" maintenance action later |
| Embeddings | `DELETE FROM recall_embeddings WHERE model_key = ?` then lazy backfill | Model change; corruption; user toggling embeddings off then on |
| Meta | Recomputed defaults | Always safe |

A startup `integrity-check` is **not** run on every launch (cost); it runs after an unclean shutdown signal, on a query error, and
as part of `doctor`-style diagnostics. A failing check marks lexical `degraded_scan` and triggers an automatic rebuild in the
background.

## 6. NFC risk

SQLite has no Unicode normalisation function, and probing showed an NFD query does not match NFC-indexed text (and vice versa).
Text typed on Android IMEs and the distillation model output are almost always NFC, but this cannot be assumed. Decision:

* The **query** is always NFC.
* At migration/rebuild, Rust scans revision text once (already read for FTS rebuild) and records `recall_meta.has_non_nfc`.
  If true, the query builder also emits the NFD form of each term (`token_nfc OR token_nfd`) and the new-text trigger path
  is unchanged. New non-NFC revisions flip the flag at write time in the Rust store write path (a one-line check there, or
  at the next rebuild at the latest; lexical misses on such text are the only consequence).
* Benchmark includes a decomposed-Cyrillic fixture to prove this.

## 7. Privacy

Principle preserved: **cloud intelligence, locally owned knowledge.**

* Embeddings and the FTS index never leave the device. No sync, no background upload of the index, no whole-database upload.
* Sent to the provider, only: (a) per object, the embedded text `kind: title\nbody` of the **current** revision, once per
  change, batched; (b) per question, the query string (embedding) and the evidence package (synthesis).
* Not sent: project names (except as an evidence label in the synthesis input, see evidence-contract.md), historical revisions
  for embedding, relation graph wholesale, unrelated projects, captures wholesale (excerpts only, <= 20, capped).
* **Semantic Recall is opt-in** (see §3.6). Until the user enables it, nothing is embedded and no query is embedded;
  Recall runs lexical-only and says so (`semantic: "disabled"`).
* The provider abstraction allows a local embedder, which would remove the embedding upload entirely; synthesis remains cloud.
* Logs and diagnostics never include query text or object text, only counts, ids' lengths, timings and codes (matching the
  existing "never carries prompts or provider bodies" convention).

## 8. Size estimates (10,000 objects, 30,000 revisions)

| Item | Size |
|---|---|
| FTS5 index | ~8-15 MB (title+body ~0.6 KB average x 30k revisions; unicode61, no trigram) |
| Embeddings, 512 dims | 20 MB (+ ~10% row overhead) |
| Embeddings, 1536 dims | 61 MB |
| `recall_meta` | < 1 KB |

Acceptable on desktop and Android; `E1` measures the 1536 variant before any change.
