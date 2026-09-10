# Sentry

Local-first, modular, multi-agent AI software QA platform. A user selects a
normal software project folder and independent AI QA agents analyze it:
source inspection, builds, tests, architecture, APIs, frontend behavior,
databases, configuration, evidence collection, fix proposals, verification,
and CI/CD plans.

## What Phase 1 implements

Phase 1 is the **stable domain, schemas, contracts, protocol, repository
structure, and testing foundation** only:

- pnpm workspaces + Turborepo monorepo with strict TypeScript, ESLint, Prettier;
- `@qa/shared`: opaque branded IDs (`proj_…`, `run_…`, `find_…`) and calendar-valid ISO 8601 UTC timestamps;
- `@qa/schemas`: Zod source of truth for every boundary DTO (project, snapshot,
  agent stacks, runs, findings, evidence, issues, verification, fixes, CI/CD,
  artifacts, usage, harness events) with strict `schemaVersion: 1`, centralized IDs and source locations;
- `@qa/domain`: error taxonomy, pure state-transition helpers, stack fixtures,
  parse/serialization boundary, contract fixtures;
- `@qa/harness-protocol`: `HarnessAdapter` semantic contract, metadata,
  capabilities, health, run requests, safe NDJSON/event-sequence validation, `FakeHarnessAdapter`;
- `qa` CLI shell (`--version`, `doctor`);
- contract and lifecycle tests, golden NDJSON streams, docs, ADRs, and repo CI.

## What is NOT implemented yet

- Muse 1.3 Contributor integration: **NOT IMPLEMENTED YET**
- DeepSeek V4 Flash integration: **NOT IMPLEMENTED YET**
- GLM-5.3-Flash integration: **NOT IMPLEMENTED YET**
- No real AI calls, snapshots, Git worktrees, Docker, Playwright, SQLite,
  Electron, REST, MCP, execution, deduplication, synthesis, or CI/CD generation.

## Repository layout

```text
apps/cli                 # qa binary (Phase 1: --version, doctor)
packages/shared          # IDs, timestamps
packages/schemas         # Zod source of truth + inferred types
packages/domain          # errors, transitions, fixtures, parse boundary
packages/harness-protocol# adapter contract, fake adapter, NDJSON helpers
packages/domain/tests/fixtures          # contract fixtures + relationship graph
packages/harness-protocol/tests/fixtures/harness  # golden NDJSON event streams
docs/architecture        # domain-model, agent-stack, harness-protocol, phase-1
docs/adr                 # 0001–0005
.github/workflows/ci.yml# install → format:check → lint → typecheck → test → build
```

## Development commands

```bash
pnpm install        # install workspace dependencies
pnpm build          # build all packages (turbo)
pnpm test           # run all tests (turbo + vitest)
pnpm lint           # eslint all packages
pnpm typecheck      # tsc --noEmit all packages
pnpm format         # prettier write
pnpm format:check   # prettier check
```

Requires Node.js 22+ and pnpm 9.

## Architecture principles

- **Ports & adapters / hexagonal**: UI/CLI/REST/MCP → application → QA domain,
  with infrastructure (adapters, Git, SQLite, Docker, Playwright) pointing inward.
  The domain never imports vendor SDKs, Electron, React, Docker, SQLite, or Git.
- **Agent stacks are configuration**: `AgentStack = Model + Harness + Execution
Requirements + QA Policy + Limits`. No `if (model === 'muse')` branching exists
  anywhere; vendor logic belongs only in future adapters.
- **Stable identity vs replaceable model**: “Muse QA Agent” is the stable stack;
  “Muse 1.3 Contributor + Muse Code” is today's replaceable configuration.
- **Semantic separation**: Finding (one agent's claim) ≠ Evidence (support) ≠
  UnifiedIssue (platform grouping) ≠ VerificationAttempt (independent check) ≠
  FixProposal (proposed modification).
- **References, not embedding**: issues hold `findingIds`, not `Finding[]`;
  large outputs are `ArtifactId` references, never inline blobs.
- **Evidence is discriminated**: every evidence `type` requires exactly its matching
  strict payload; contradictory subtype payloads are rejected.
- **Protocol identity is singular**: submitted Finding/Evidence IDs come only from
  the embedded DTO, usage cost comes only from `AgentUsage`, and collected streams
  enforce one AgentRun plus one final terminal event.
- **Zod at boundaries**: untrusted JSON is validated once, then trusted internally.

## Initial Agent Stacks (configuration fixtures)

| Stack             | Model                | Harness          |
| ----------------- | -------------------- | ---------------- |
| Muse QA Agent     | Muse 1.3 Contributor | Muse Code        |
| DeepSeek QA Agent | DeepSeek V4 Flash    | DeepSeek Harness |
| GLM QA Agent      | GLM-5.3-Flash        | Claude Code      |

These are replaceable configurations (see `docs/architecture/agent-stack.md`).
Future stacks (new models, OpenCode, Kimi, future harnesses) validate without
domain changes — proven by `stack-future.json` + the future-agent test.
