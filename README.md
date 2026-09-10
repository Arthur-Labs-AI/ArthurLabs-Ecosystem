# Sentry

A local-first AI software QA system for comprehensive, evidence-backed testing
of local software projects using independent AI Agent Stacks.

Sentry's contracted architecture imports a local folder into a managed project
copy, records immutable project revisions, locks an exact run-start snapshot,
and gives each selected agent a private plan and isolated writable workspace.
Full QA is broad; Retest follows an earlier issue onto the current revision.
Evidence-first reporting preserves disagreement, token usage, and complete
observable run history until the user explicitly deletes it.

## What Phase 1 + Phase 1.1 implement

The repository implements the **contracted architecture**, not the execution
runtime:

- pnpm workspaces + Turborepo monorepo with strict TypeScript, ESLint, Prettier;
- `@qa/shared`: centralized opaque branded IDs and calendar-valid ISO UTC timestamps;
- `@qa/schemas`: strict Zod contracts for managed copies, revisions, snapshots,
  context, instructions, runs/retests, independent plans and hypotheses,
  activities, findings, evidence, issues, advisory fixes, exports, and events;
- `@qa/domain`: error taxonomy, pure state-transition helpers, stack fixtures,
  relationship/outcome/usage helpers, parse boundary, coherent fixtures;
- `@qa/harness-protocol`: `HarnessAdapter` semantic contract, metadata,
  private single-agent requests, correlated operations, safe NDJSON/sequence
  validation, investigation events, and `FakeHarnessAdapter`;
- `qa` CLI shell (`--version`, `doctor`);
- contract and lifecycle tests, golden NDJSON streams, docs, ADRs, and repo CI.

## What is not implemented yet

- Muse 1.3 Contributor integration: **NOT IMPLEMENTED YET**
- DeepSeek V4 Flash integration: **NOT IMPLEMENTED YET**
- GLM-5.3-Flash integration: **NOT IMPLEMENTED YET**
- No real folder import/copy/update engine, hashing pipeline, snapshot builder,
  context builder, run coordinator, activity store/projector, log/JSON exporter,
  or crash recovery.
- No real AI calls, Git worktrees, Docker, Playwright, SQLite, Electron, REST,
  MCP, execution, deduplication, synthesis, verification, or CI/CD generation.

## Repository layout

```text
apps/cli                 # qa binary (Phase 1: --version, doctor)
packages/shared          # IDs, timestamps
packages/schemas         # Zod source of truth + inferred types
packages/domain          # errors, transitions, fixtures, parse boundary
packages/harness-protocol# adapter contract, fake adapter, NDJSON helpers
packages/domain/tests/fixtures          # contract fixtures + relationship graph
packages/harness-protocol/tests/fixtures/harness  # golden NDJSON event streams
docs/architecture        # domain, lifecycle, protocol, Phase 1/1.1 baselines
docs/adr                 # 0001–0006
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
Requirements + QA Policy`, with optional operational `ExecutionSafeguards`. No `if (model === 'muse')` branching exists
  anywhere; vendor logic belongs only in future adapters.
- **Stable identity vs replaceable model**: “Muse QA Agent” is the stable stack;
  “Muse 1.3 Contributor + Muse Code” is today's replaceable configuration.
- **Semantic separation**: Finding (one agent's claim) ≠ Evidence (support) ≠
  UnifiedIssue (platform grouping) ≠ VerificationAttempt (independent check) ≠
  FixProposal (advice only; never automatic application).
- **References, not embedding**: issues hold `findingIds`, not `Finding[]`;
  large outputs are `ArtifactId` references, never inline blobs.
- **Evidence is discriminated**: every evidence `type` requires exactly its matching
  strict payload; contradictory subtype payloads are rejected.
- **Protocol identity is singular**: submitted Finding/Evidence IDs come only from
  the embedded DTO, usage is token/runtime data only, and collected streams
  enforce one AgentRun plus one final terminal event.
- **Agent independence is structural**: an individual harness request names one
  AgentRun and one AgentStack and contains no peer agents, plans, findings, or evidence.
- **Local trusted product boundary**: local folders only; no Sentry auth, RBAC,
  multitenancy, billing, quotas, cloud import, or project-size cap.
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
