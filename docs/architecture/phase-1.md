# Phase 1 — Foundation (this phase)

## Delivered

Monorepo (pnpm + Turborepo), strict TypeScript (incl. noUncheckedIndexedAccess,
exactOptionalPropertyTypes), ESLint, Prettier, four bounded packages (`shared`,
`schemas`, `domain`, `harness-protocol`) plus the `qa` CLI shell, full domain +
protocol model, Zod validation, versioned schemas, fixtures, golden NDJSON
streams, FakeHarnessAdapter, 71 tests, docs, ADRs, and repo CI.

## Deferred to Phase 2+ (explicitly not started)

All real integrations and execution: Muse/DeepSeek/Claude-GLM adapters and SDKs,
AI calls, snapshot creation, Git cloning/worktrees, Docker/WSL, Playwright,
SQLite persistence, Electron UI, REST/MCP servers, QA execution, deduplication,
verification/fix execution, AI synthesis, CI/CD generation.

## Exit check

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

plus inspection for `any`, `ts-ignore`, blocking TODOs, unused deps, cycles,
vendor logic in the domain, model branching, unvalidated inputs, absolute paths
in fixtures, and secrets.
