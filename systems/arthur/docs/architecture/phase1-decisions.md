# Phase 1 Architecture Decisions

This document records decisions taken while implementing
`ARTHUR_Phase_1_Core_DeepSeek_Implementation_Spec_v1.0`. It exists per spec
section 22 ("Do not silently change the architecture").

## Language and runtime

- **TypeScript on Node.js >= 22.5**, matching the existing harness ecosystem and
  the spec's typed domain-object contracts.
- **CommonJS module system.** Chosen for simplest `tsc` build output that runs
  directly under `node` without ESM extension gymnastics. No runtime-only
  assumptions; `node:sqlite` is imported as a built-in.

## Persistence

- **`node:sqlite` (`DatabaseSync`)** instead of a native dependency such as
  `better-sqlite3`. It is built into Node 22, ships no native build step, and
  supports the Phase 1 SQL schema with WAL + foreign keys. Migrations are a
  versioned table (`schema_migrations`) applied in a transaction.
- An **`approvals` table** was added beyond the spec's four minimum entities
  (`sessions`, `turns`, `model_calls`, `tool_calls`). Pending approvals must
  survive restart for `/v1/approvals/{id}/approve` to be meaningful, and the
  spec requires approval binding + expiry, so approvals are first-class rows.
- Runtime multi-row transitions are explicit SQLite transactions: session +
  first turn + idempotency binding, assistant turn + replay cache, mode + boundary,
  and tool-call + approval creation/completion. Migrations use `BEGIN IMMEDIATE`,
  WAL, a busy timeout, foreign keys, unique constraints, and fail-closed recovery.
- No API keys or full sensitive tool results are stored. The store sanitizes all
  text/JSON at its own boundary and tool results are truncated to a safe summary.


## Final Phase 1 release remediation

- Released migration versions are immutable. Versions 1 (base conversation schema) and 2 (approval persistence) retain their original definitions; migration 5 performs a forward-only secure-schema reconciliation.
- Migration 5 rebuilds the Phase 1 tables inside the serialized migration transaction, backfills each legacy turn's mode from its session, preserves valid legacy rows, creates the idempotency table, installs current checks/foreign keys/unique constraints/indexes, and runs schema plus foreign-key validation before commit. A failed rebuild rolls back all schema and migration-version changes.
- Every HTTP, CLI, and direct public error representation passes through the centralized public-error sanitizer. Stable ARTHUR codes remain visible; messages and nested details are recursively redacted and stacks/causes are omitted.
- JSON body endpoints require a JSON media type. Turn and mode payloads are strict, and session/approval route identifiers have explicit character and length constraints.

## Model gateway and providers

- **`ModelGateway` delegates to one `ModelProvider`** and maps provider-level
  errors (`ProviderTimeoutError`, `ProviderAuthError`, `ProviderUnavailableError`,
  `ProviderBadResponseError`) into typed `ArthurError`s at the service boundary.
- **`FakeProvider`** is the offline default (`ARTHUR_MODEL_PROVIDER=fake` when
  unset). `.env.example` documents `deepseek` as the production choice. The
  default is `fake` so the app runs offline with one command; choosing `deepseek`
  without a key fails startup with an actionable message.
- **DeepSeek provider** speaks the OpenAI-compatible `/chat/completions` API.
  Payload assembly and response normalization are pure, exported functions so
  they are unit-testable without network access.

## Reasoning profile

- `fast` -> `temperature 0, max_tokens 512`; `normal` -> `temperature 0.7`;
  `deep` -> `temperature 0.7, max_tokens 8192`. The mapping lives inside the
  provider only; the rest of ARTHUR sees an opaque `ReasoningProfile`.

## Retry and timeout

- Retry only transient failures (network, 408, 429, 5xx) with bounded
  exponential backoff + jitter (`ARTHUR_MODEL_RETRY_MAX_ATTEMPTS`,
  `ARTHUR_MODEL_RETRY_BASE_DELAY_MS`).
- **Timeouts are not retried**: a finite connect/read timeout returns
  `MODEL_TIMEOUT` promptly rather than multiplying latency across attempts. This
  keeps the "provider timeout does not corrupt state" behavior deterministic.

## Tool system and permissions

- Three built-in tools: `system.echo` (read), `harness.status` (read),
  `harness.create_job` (approval_required, business-only).
- Risk mapping: `read`/`low_write` auto-execute (if the mode allows the tool),
  `approval_required` creates a pending approval, `high_risk` is rejected by
  default in Phase 1.
- **Approval binding**: an approval stores tool name + canonicalized (key-sorted)
  arguments/digest + session + turn + tool-call + risk + expiry. Execution
  re-validates current mode, registry metadata, schema, every persisted binding,
  and an HMAC token before an atomic pending -> executing claim. Executing rows
  are never automatically retried after an uncertain crash; Harness adapters use
  the approval id as their durable external idempotency key.

## Response loop

- The orchestrator executes auto (read) tools and, when at least one executed,
  performs **exactly one** bounded follow-up model round to feed results back
  (`ContextBuilder.buildFollowup`). This satisfies the "result is available to
  response loop" acceptance scenario without building a full agent loop.

## Mode

- Mode is stored server-side on the session. A turn that mismatches the
  session's mode returns `MODE_VIOLATION`; changes go through
  `POST /v1/sessions/{id}/mode`, which also writes a `system` boundary turn.
- Personal and business histories are separated by session mode from the first
  implementation; there is no cross-mode retrieval.

## Observability and security

- Structured JSON logs with component + correlation fields. A centralized secret
  sanitizer protects inbound text, provider payloads, persistence, tool arguments
  and summaries, HTTP/CLI responses, and exception text; logger redaction remains
  an independent second line of defense.
- Metrics are behind a `Metrics` interface with an in-memory implementation so
  an external observability system can be added later without changing call
  sites.
- API binds to `127.0.0.1` by default; strict zod schemas + size limits validate
  all external input; SQL uses parameterized statements.

## Testing

- **Node built-in test runner** (`node --test`) with
  `--experimental-test-isolation=none`, compiled by `tsc`. Chosen over a
  bundler-based runner to keep the dependency tree pure-JS and to respect the
  execution environment's child-process constraints. The same `tsc` compiler
  validates types for the whole tree including tests.

## Deliberately deferred (non-goals)

- Voice, RAG/embeddings/memory, mesh networking, real Harness execution (stub
  only), autonomous agents, and a polished UI are all out of scope for Phase 1
  per the spec.
