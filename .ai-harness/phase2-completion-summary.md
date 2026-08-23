# Phase 2 Completion Summary — Memory + Local RAG

Spec: `ARTHUR_Phase_2_Memory_RAG_DeepSeek_Implementation_Spec_v1.0` (extracted to
`.ai-harness/phase2-spec-extracted.txt`).

## Verification (deterministic)

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `npm test` | **182 pass / 0 fail / 1 skip** (skip = live DeepSeek contract test, requires `DEEPSEEK_API_KEY`) |
| `npm run test:integration` | 51 / 51 pass |

Phase 1 regression: the original Phase 1 suite (upgrade migrations, idempotency
state machine, approval token security, redaction, provider validation) all
remain green.

## Storage and embeddings

- Personal store: `./data/memory-personal.db` (config `ARTHUR_MEMORY_PERSONAL_DB_PATH`)
- Business store: `./data/memory-business.db` (config `ARTHUR_MEMORY_BUSINESS_DB_PATH`)
- Embedding provider: `local_multilingual` (FNV-1a n-gram hashing, deterministic, multilingual)
- Embedding model id: `arthur-ngram-v1`, version `1`, default dimensions 384
- Test/offline provider: `fake` (64 dims), selected automatically by `buildTestApp`

Each store has independent versioned migrations, schema validation, WAL, busy
timeout, FTS5 tables, and persistent vector BLOBs. No remote embedding calls;
no dedicated vector database (deviation recorded in `phase2-decisions.md`).

## Isolation evidence (test names and what each proves)

`tests/memory/isolation.test.ts`:

1. **"personal retrieval never returns business memories (sentinel isolation)"** —
   PERSONAL_SENTINEL / BUSINESS_SENTINEL written into their domains; each domain's
   search results never contain the other domain's sentinel or content.
2. **"personal session cannot read or delete a business memory id it knows"** —
   known-ID attack: a personal session deleting a business memory id fails with
   `INVALID_REQUEST`; the business memory remains intact and retrievable in
   business mode.
3. **"client-supplied fake namespace/domain fields are rejected by validation"** —
   `domain`, `database`, `context_key` payload fields are rejected by the strict
   API schema before any store access.
4. **"memory gateway derives the domain only from the trusted session record"** —
   the same operation routed through personal vs business sessions lands in
   different physical stores.
5. **"mode-safe context: DeepSeek payload carries only the active domain memory"** —
   captured provider `ModelRequest`: personal payload contains
   `PERSONAL_SENTINEL` and no `BUSINESS_SENTINEL`; business payload the reverse;
   blocks are labeled `<memory domain="personal">` / `<memory domain="business">`.
6. **"failing personal store degrades personal memory only; business keeps
   working"** — closing the personal store yields zero personal memory (fail
   closed, no exception into the conversation) and the business store never
   serves personal content as fallback.
7. **"model-proposed tool arguments cannot override the memory domain (no memory
   tools exist)"** — a model-proposed `memory_write` tool call is rejected; no
   memory can be written through tool execution.

`tests/memory/prompt_injection.test.ts` adds adversarial coverage: injected