# Phase 2 Architecture Decisions

This document records decisions taken while implementing
`ARTHUR_Phase_2_Memory_RAG_DeepSeek_Implementation_Spec_v1.0`. It exists per
spec section 44 ("Record intentional deviations in
`docs/architecture/phase2-decisions.md`").

## Isolation model

- **Two physically separate SQLite files** (`memory-personal.db`,
  `memory-business.db`) with **independent versioned migrations** per store
  (spec §7, §40 "Both memory DB migrations can start concurrently"). A
  migration table and schema validation exist inside each store; there is no
  shared memory schema.
- **MemoryGateway is the single store-selection point**: an exhaustive explicit
  `selectStore(domain)` branch over the two named store handles. There is no
  generic `getStore(string)` anywhere, so a mistyped or attacker-supplied
  domain string cannot route to a store.
- **The domain always comes from the trusted server-side session record**
  (`memoryContextFromSession`). API schemas are strict and accept no
  `domain`, `database`, `namespace`, or `context_key` field; CLI commands
  take only `--session <id>`.
- **Fail-closed semantics**:
  - Cross-domain delete/read of a known id → `INVALID_REQUEST` (the error is
    identical for "wrong domain" and "unknown id" so the store layout is not
    leakable).
  - Retrieval failure in one domain degrades **only that domain** to a
    no-memory mode; the other store is never queried as fallback.
  - A mode mismatch between session and requested mode in
    `MemoryContextSource` returns no memory and logs an error.
- **Memory retrieval never leaves the domain**: both vector and FTS SQL join
  the domain column, and the retriever picks its store through one explicit
  branch.

## Embeddings

- **Local, deterministic, dependency-free providers** behind an
  `EmbeddingGateway` (`id() = provider:model:version` stamped on every
  item/chunk):
  - `local_multilingual` — FNV-1a n-gram hashing, 384 dims by default,
    unicode-aware for multilingual text.
  - `fake` — deterministic 64-dim provider used by the offline test suite.
- **No remote embedding calls and no dedicated vector database.** Vectors are
  stored as BLOBs (Float32Array) in each memory SQLite database; the
  `VectorSearch` adapter keeps a future vector-engine swap behind the same
  shape (spec §44 "preserve VectorStore abstraction").
- **Similarity guard**: `ARTHUR_MEMORY_VECTOR_MIN_SIMILARITY` (default 0.5)
  drops weak vector candidates; FTS covers exact terms/phrases.

## Retrieval

- **Hybrid pipeline**: local embedding + vector search → FTS5 (`bm25`)
  keyword search → Reciprocal Rank Fusion (k=60) → per-memory collapse →
  lifecycle filters (ACTIVE, non-expired, project/subject/type) → local
  heuristic reranker (importance boost, episodic recency, confidence
  downweight, project match boost) → token-budgeted snippets.
- **FTS query builder is defensive**: only unicode letters/digits survive,
  every term is quoted with prefix `*`, and the full cleaned phrase is tried
  first with an OR disjunction over terms (recall-first; RRF + reranker
  restore precision). Empty/punctuation-only queries produce no FTS clause.
- **Context budget**: `ARTHUR_MEMORY_MAX_CONTEXT_TOKENS` /
  `ARTHUR_MEMORY_MAX_SINGLE_CHUNK_TOKENS` — snippets are truncated
  deterministically (chars/4 token estimate) and selection stops before the
  budget is exceeded.
- **MemoryContextSource emits one labeled UNTRUSTED user-role block**
  (`[Memory context — UNTRUSTED retrieved data…]` + `<memory
  domain="...">`) with XML-escaped items. It is never a system message, and
  `ModelRequest.memory` metadata carries `{domain, context_tokens,
  included}`. A first turn with no session yields no memory.

## Writes, idempotency, crash recovery

- **Three write paths**: explicit remember (sanitize → secret-scan → hash →
  reserve → dedupe → embed → persist), post-turn extraction (schema-validated
  + policy-gated, opt-in, failures never fail the turn), document ingestion
  (sanitize → normalize → hash → reserve → chunk → embed → atomic source +
  item + chunks + FTS write).
- **Idempotency state machine** per domain store:
  `pending → writing → completed/failed` keyed by request id + request hash.
  Same key + same payload replays the existing result; same key + different
  payload is rejected; interrupted rows are resumed on retry; on reopen,
  reconciliation converges rows whose result row already exists (by
  `result_id` or by the request id stamped on `source_id`), backfilling
  `result_id`.
- **Deterministic ids** (`doc-<hash32>`, `mem-doc-<hash32>`,
  `<memId>#<ordinal>`) plus `INSERT OR IGNORE` convergence make concurrent
  duplicate writes collapse to one row instead of throwing UNIQUE constraint
  errors.
- **Dedupe/supersession**: exact `content_hash` → touch provenance; same
  subject+type semantic compare (cosine ≥ 0.85 same fact; content-diff
  stopword rule; ≥ 0.5 related → `USER_EXPLICIT` supersedes). Superseded
  items stay in the store with `SUPERSEDED` status for audit but are excluded
  from every retrieval channel.
- **Expiry**: TEMPORARY memories carry `expires_at`; expiration runs
  opportunistically on open and before retrieval; expired items are excluded
  from vector/FTS SQL and become `EXPIRED`.
- **Deletion**: forget/delete writes `[deleted:<id>]` tombstones (no text
  retention), deletes chunks and FTS rows in one transaction.

## Secrets

- **Explicit remember and extraction candidates reject secret-like content
  before any persistence or embedding** (credential regexes + the Phase 1
  redaction boundary, `hasSecretLikeContent`).
- **Documents are sanitized, not rejected**: content passes through the
  existing `SecretSanitizer` at the store boundary so raw secrets never
  reach SQLite or embeddings.
- Raw vectors, database paths, and the corpus are never included in the
  DeepSeek payload (payload tests assert this).

## Extraction

- `MemoryExtractor` calls the model gateway with a strict single-quoted JSON
  instruction and validates output against a strict zod schema
  (`{"memories":[…]}`); malformed output is discarded. Candidates are then
  policy-gated (confidence/importance thresholds, min/max length,
  secret-scan, `should_store`).
- **`TurnMemoryExtractor` is opt-in** (`ARTHUR_MEMORY_EXTRACTION_ENABLED`,
  default `false`) so Phase 1 model-call accounting stays unchanged; when
  enabled, extraction failures are swallowed and never fail the turn.
- Chain-of-thought is not stored anywhere (spec §44).

## SC-01 freeze (Software Core v1)

- **Status: FROZEN** — Software Core milestone SC-01. Frozen schema version:
  `1` (`CURRENT_MEMORY_SCHEMA_VERSION`).
- **SC-01 implementation commit:** `534ece2f79c9e5342549194c27baa46cdd37171a`
  (`feat(memory): harden and freeze phase 2 memory` — the complete SC-01
  implementation, freeze suite, and this freeze record's first version).
- **Freeze metadata commit:** `docs(memory): record SC-01 freeze SHAs and F16 verdict`
  (docs-only follow-up; HEAD of this freeze sequence — resolve via
  `git log --oneline --decorate`. A commit can never embed its own SHA, so
  this record names the authoritative implementation SHA above and
  identifies the metadata commit by message; the implementation commit SHA
  is the freeze reference and is unaffected by metadata amendments).
- **Freeze invariants (immutable for Software Core v1):**
  - **M1 trusted domain authority** — the domain comes only from the trusted
    server-side session (`memoryContextFromSession`); API schemas stay strict
    with no `domain`/`database`/`namespace`/`context_key` fields (F01 gate).
  - **M2 physical Personal/Business isolation** — separate SQLite files, and
    startup now proves it with `MemoryDbIdentity` physical identity
    (absolute → realpath, nearest-existing-parent fallback, case-insensitive
    on Windows, device/inode comparison when both files exist). Same target
    or same device+inode → startup rejection; broken aliases fail closed.
    Only `:memory:`+`:memory:` is allowed (separate private handles).
    (F02/F03 gates.)
  - **M3 no cross-domain fallback** — a failing store degrades only its own
    domain to no-memory mode (F01 failure-injection gate).
  - **M4 acknowledged memory is durable** — file-backed stores enforce
    `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`,
    `busy_timeout=10000`, verified by reading the effective PRAGMAs back;
    WAL failure on a persistent DB fails startup, never silently downgrades.
    `:memory:` is exempt from WAL (tests only). (F06/F07 gates.)
- **Schema/migration contract (SC-01C)** — `CURRENT_MEMORY_SCHEMA_VERSION`
  is explicit; startup validates columns, primary keys, NOT NULL, the
  `memory_chunks → memory_items` FK with `ON DELETE CASCADE`, the
  `uq_items_active_hash` / `uq_sources_hash` UNIQUE indexes, the FTS5 table,
  the known migration ledger, and per-store domain purity. A newer schema,
  unknown migration, missing table, or wrong-domain row fails closed — never
  downgrade, repair, delete, or recreate. (F04/F05 gates.)
- **Document lifecycle (SC-01D)** — each ingestion mints a fresh memory
  incarnation (`mem-doc-<uuid>`); concurrent identical ingestions converge
  onto one ACTIVE row via `uq_items_active_hash` (chunks/FTS/metadata follow
  the survivor). Delete leaves a tombstone; re-ingestion with either a new
  or the original `client_request_id` creates a fresh ACTIVE incarnation.
  Document write + ingestion completion commit in ONE SQLite transaction
  (`writeDocumentAtomic` + `completion`), so no durable
  (document-exists, ingestion-writing) state survives a crash. (F08/F10.)
- **Integrity verification (SC-01E)** — `verifyMemoryDatabase` asserts
  `integrity_check` is exactly `ok`, `foreign_key_check` finds 0
  violations, chunk↔FTS parity holds with no duplicate FTS chunk entries,
  and wrong-domain rows are 0. Diagnostic/acceptance only, never per turn.
  (F14/F15 gates.)
- **Security boundary (SC-01F)** — explicit remember rejects secret-like
  content with zero embedding calls; document content is sanitized before
  chunk/embed/persist (recording-provider gate proves the raw secret never
  reaches embeddings); direct DB inspection of `memory_items`,
  `memory_chunks`, `memory_fts5`, and `memory_sources` finds no raw marker;
  model-payload regression stays green. (F11 gates.)
- **Retrieval contract (SC-01G)** — ACTIVE retrievable; SUPERSEDED/EXPIRED/
  DELETED excluded from vector, FTS, and hybrid channels (per-channel
  stores plus hybrid end-to-end, fail-closed on foreign ids). (F09/F12.)
- **Hard context budget** — total `estimateTokens` ≤
  `ARTHUR_MEMORY_MAX_CONTEXT_TOKENS` with no margin, and every snippet ≤
  `ARTHUR_MEMORY_MAX_SINGLE_CHUNK_TOKENS` (tightened regression). (F13.)
- **Crash/restart acceptance** — simulated windows (item-before-chunks,
  same-process/restart retry, duplicate concurrent remembers/documents,
  Personal+Business concurrency) plus a file-backed child-process test:
  committed write → child exit → restart → memory exists. (F07/F08.)
- **Freeze suite** — `tests/memory/sc01_freeze.test.ts` (15 tests, F01–F15)
  is deterministic/offline (no DeepSeek API, microphone, wake model, Piper,
  Whisper, or network); symlink tests skip only when the OS truly forbids
  them, hardlink/path-alias coverage is mandatory. Full offline suite
  (unit+memory+integration: 407 tests) passes.
- **SC01-F16 full-repository regression:** `npm test` gives 576 tests —
  530 pass, 36 fail, 10 skipped. All 36 failures are voice-engine
  child-process/stdio tests (capture, STT, TTS, playback, STT wrapper) and
  reproduce byte-identically on the pristine pre-SC-01 tree (verified via
  `git stash` + rerun: same 36, same names). Zero SC-01 regression delta:
  no memory, unit, or integration test fails. Status: PASS with an
explicitly evidenced pre-existing/environment-only exception for the 36
  voice-engine tests; no Memory code was changed and no test was weakened
  to obtain this result.

## Rules after freeze

- Changes to database schema, domain routing, physical isolation, idempotency
  semantics, deletion semantics, secret boundary, or retrieval lifecycle
  semantics require an explicit architecture decision + migration when
  applicable + new regression coverage + SC-01 compatibility verification.
  Bug fixes must not silently change frozen contracts.

## Deviations and notes

- **No dedicated vector database** (spec permits the local interface);
  persistent vectors live in each memory SQLite store.
- **Hash-based embeddings are intentionally weak**; they are deterministic,
  local, and multilingual. Semantic quality depends on the fusion + FTS +
  reranker pipeline; a stronger local embedding model can be swapped in behind
  `EmbeddingGateway` without changing callers.
- **Live DeepSeek payload evidence** is exercised by an offline capture of the
  exact `ModelRequest` handed to the provider (FakeProvider capture), which
  is deterministic and CI-safe; the live contract test runs only with
  `DEEPSEEK_API_KEY`.
- The FTS term conjunction is OR-based for recall; precision is restored by
  RRF and the reranker (documented in `keyword_search.ts`).
