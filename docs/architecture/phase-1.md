# Phase 1 — Foundation (this phase)

## Phase 1 Status: COMPLETE

Sentry Phase 1 is complete. Harness Protocol v1 and the core domain contracts are
the implementation baseline for Phase 2. Future explicitly versioned migrations
remain possible; this is not a claim of permanent immutability.

## Delivered

Monorepo (pnpm + Turborepo), strict TypeScript (incl. noUncheckedIndexedAccess,
exactOptionalPropertyTypes), ESLint, Prettier, four bounded packages (`shared`,
`schemas`, `domain`, `harness-protocol`) plus the `qa` CLI shell, full domain +
protocol model, strict discriminated Evidence validation, centralized IDs and
source locations, validated event-stream lifecycle/identity, versioned schemas,
fixtures, golden NDJSON streams, FakeHarnessAdapter, docs, ADRs, and repo CI.

## Deferred to Phase 2+ (explicitly not started)

All real integrations and execution: Muse/DeepSeek/Claude-GLM adapters and SDKs,
AI calls, snapshot creation, Git cloning/worktrees, Docker/WSL, Playwright,
SQLite persistence, Electron UI, REST/MCP servers, QA execution, deduplication,
verification/fix execution, AI synthesis, CI/CD generation.

## Exit check

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

plus inspection for `any`, `ts-ignore`, blocking TODOs, unused deps, cycles,
vendor logic in the domain, model branching, unvalidated inputs, absolute paths
in fixtures, and secrets.
