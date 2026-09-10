# Phase 1 — Foundation (this phase)

## Phase 1 Status: COMPLETE (extended by Phase 1.1)

The original Phase 1 foundation remains complete. Phase 1.1 corrects and extends
its pre-production contracts; see `phase-1.1.md` for the final Phase 2 baseline.

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
verification execution, advisory fix generation, AI synthesis, CI/CD generation.
Automatic fix execution/application is not part of the product baseline.

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
