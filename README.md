# ARTHUR — Phase 1 Core Foundation

ARTHUR is a small, testable conversational core: it accepts a text request,
creates a conversation turn, calls a model through a provider-agnostic
**Model Gateway**, and returns a structured response. Phase 1 implements the
foundation only — clean boundaries over feature count — as specified by
`ARTHUR_Phase_1_Core_DeepSeek_Implementation_Spec_v1.0`.

## What Phase 1 does

- Text chat through **DeepSeek V4 Flash** behind a provider-agnostic
  `ModelGateway` (DeepSeek is replaceable behind an interface).
- A deterministic **FakeProvider** for offline tests and demos.
- Persistent sessions (SQLite) with an explicit **Personal / Business** mode.
- A tool system with JSON-schema validation and an approval skeleton.
- An approval-required **Harness stub** that cannot execute without bound,
  explicit approval.
- An **HTTP API** and a **CLI** that use the same core services.
- Structured logging, tracing, usage capture, and secret redaction.

## Repository layout

```
apps/
  api/                  HTTP entry point
  cli/                  local terminal client
src/
  core/
    conversation/       service, models, context_builder, validation
    modes/              ArthurMode
    errors/             typed error model
  models/               gateway, contracts, providers/{deepseek,fake}
  tools/                registry, contracts, orchestrator, permissions,
                        adapters/harness_stub, builtin
  sessions/             SQLite store + migrations
  observability/        logging, tracing, usage, metrics
  config/               settings, validation
  security/             redaction
tests/
  unit/ integration/ contract/
docs/architecture/      phase1-decisions.md
```

## Requirements

- Node.js **>= 22.5** (uses the built-in `node:sqlite`).

## Setup

```bash
npm install
cp .env.example .env   # optional; edit values
```

With no `.env`, ARTHUR runs against the offline `FakeProvider`. To use DeepSeek,
set `ARTHUR_MODEL_PROVIDER=deepseek` and provide `DEEPSEEK_API_KEY`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARTHUR_ENV` | `development` | Runtime environment |
| `ARTHUR_DB_PATH` | `./data/arthur.db` | SQLite database path |
| `ARTHUR_MODEL_PROVIDER` | `fake` | `deepseek` \| `fake` |
| `ARTHUR_MODEL_NAME` | *(empty)* | Model identifier (e.g. `deepseek-chat`) |
| `DEEPSEEK_API_KEY` | *(empty)* | DeepSeek secret |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek API base |
| `ARTHUR_MODEL_TIMEOUT_SECONDS` | `60` | Connect/read timeout |
| `ARTHUR_HISTORY_MAX_TURNS` | `20` | Prior turns in context |
| `ARTHUR_REASONING_PROFILE` | `normal` | `fast` \| `normal` \| `deep` |
| `ARTHUR_MODEL_RETRY_MAX_ATTEMPTS` | `3` | Retry budget (transient only) |
| `ARTHUR_APPROVAL_TTL_SECONDS` | `300` | Approval expiry |
| `ARTHUR_LOG_LEVEL` | `info` | Log level |
| `ARTHUR_BIND_HOST` | `127.0.0.1` | API bind host (localhost only) |
| `ARTHUR_BIND_PORT` | `8080` | API bind port |
| `ARTHUR_MEMORY_PERSONAL_DB_PATH` | `./data/memory-personal.db` | Personal memory store (SQLite) |
| `ARTHUR_MEMORY_BUSINESS_DB_PATH` | `./data/memory-business.db` | Business memory store (SQLite, physically separate) |
| `ARTHUR_EMBEDDING_PROVIDER` | `local_multilingual` | `local_multilingual` \| `fake` |
| `ARTHUR_EMBEDDING_MODEL` | `arthur-ngram-v1` | Local embedding model id |
| `ARTHUR_EMBEDDING_DIMENSIONS` | `384` | Embedding dimensions (16–2048) |
| `ARTHUR_MEMORY_MAX_RETRIEVAL_CANDIDATES` | `40` | Vector/FTS candidates before fusion |
| `ARTHUR_MEMORY_MAX_RERANKED_RESULTS` | `12` | Memories injected per turn |
| `ARTHUR_MEMORY_MAX_CONTEXT_TOKENS` | `1200` | Memory context token budget |
| `ARTHUR_MEMORY_MAX_SINGLE_CHUNK_TOKENS` | `300` | Max tokens per snippet |
| `ARTHUR_MEMORY_VECTOR_MIN_SIMILARITY` | `0.5` | Minimum cosine for vector candidates |
| `ARTHUR_MEMORY_EXTRACTION_ENABLED` | `false` | Opt-in post-turn extraction |
| `ARTHUR_MEMORY_EXTRACTION_CONFIDENCE_THRESHOLD` | `0.6` | Extraction confidence gate |
| `ARTHUR_MEMORY_EXTRACTION_IMPORTANCE_THRESHOLD` | `0.2` | Extraction importance gate |
| `ARTHUR_MEMORY_TEMPORARY_TTL_SECONDS` | `86400` | TEMPORARY memory TTL |

Configuration is validated at startup; invalid configuration fails with an
actionable message.

## Run

```bash
npm run build

# HTTP API
npm start

# CLI
npm run cli -- chat --mode personal
npm run cli -- status
npm run cli -- session <id>
npm run cli -- approve <approval-id>
npm run cli -- reject <approval-id>
npm run cli -- memory remember --session <id> --type semantic "fact to remember"
npm run cli -- memory search --session <id> "query"
npm run cli -- memory list --session <id>
npm run cli -- memory forget --session <id> <memory-id>
npm run cli -- memory status --session <id>
npm run cli -- documents add --session <id> --file notes.md --title "Notes"
npm run cli -- documents list --session <id>
```

Example API interaction:

```bash
curl http://127.0.0.1:8080/v1/turns \
  -H "content-type: application/json" \
  -d '{"mode":"personal","message":"hello","client_request_id":"1"}'

# Phase 2 memory endpoints (domain is resolved server-side from the session)
curl http://127.0.0.1:8080/v1/memory/remember \
  -H "content-type: application/json" \
  -d '{"session_id":"<id>","client_request_id":"2","text":"remember this","type":"semantic"}'
curl http://127.0.0.1:8080/v1/memory/search \
  -H "content-type: application/json" \
  -d '{"session_id":"<id>","query":"remember"}'
curl "http://127.0.0.1:8080/v1/memory?session_id=<id>"
curl -X DELETE "http://127.0.0.1:8080/v1/memory/<memory-id>?session_id=<id>"
curl http://127.0.0.1:8080/v1/documents \
  -H "content-type: application/json" \
  -d '{"session_id":"<id>","client_request_id":"3","title":"Notes","source_type":"text","content":"..."}'
```

## Test

```bash
npm test              # unit + integration (offline, deterministic)
npm run test:unit
npm run test:integration
npm run test:contract # live DeepSeek test; skipped unless DEEPSEEK_API_KEY is set
```

The normal test suite never depends on external API availability. The live
DeepSeek contract test runs only when `DEEPSEEK_API_KEY` is present.

## Architecture boundaries

- **LLM independence** — no core/business logic imports a DeepSeek SDK; all
  model calls go through `ModelGateway`.
- **Local orchestration** — conversation state, permissions scaffolding, tool
  routing scaffolding, logs, and configuration run locally.
- **Minimal remote payload** — the provider receives only the assembled turn
  context; secrets, environment, databases, and filesystem contents are never
  sent.
- **No silent tool execution** — model output cannot directly execute code,
  shell commands, or network calls; only registered executors run, after
  validation and permission checks.
- **Fail closed** — invalid provider output, invalid tool calls, missing
  permission, or malformed configuration return a controlled error.
- **Phase 2 memory isolation** — two physically separate SQLite stores
  (Personal/Business); the domain is derived only from the trusted server-side
  session record. Clients/models cannot select a domain, database, or
  namespace; any attempt fails closed (Phase 2 spec §5 North Star).
- **Local RAG, remote reasoning** — embeddings, storage, and retrieval
  (hybrid vector + FTS5 + reciprocal rank fusion + local reranker) run
  locally; DeepSeek receives only assembled, budgeted, untrusted-labeled
  memory snippets in a user-role block.
- **Untrusted memory data** — retrieved memory cannot change the system
  contract, mode contract, tool schemas, permissions, or approval rules;
  credential-like content is rejected before persistence, and documents are
  redacted with the Phase 1 sanitizer boundary.

See `docs/architecture/phase1-decisions.md` and
`docs/architecture/phase2-decisions.md` for detailed decisions.

## Phase 1 non-goals

No wake word/voice, real Harness execution (stub only), autonomous agents, or
polished UI. *(RAG/embeddings/memory were Phase 1 non-goals — implemented in
Phase 2.)*