# Sentry

A local-first AI software QA system for comprehensive, evidence-backed testing
of local software projects using independent AI Agent Stacks.

Sentry's contracted architecture imports a local folder into a managed project
copy, records immutable project revisions, locks an exact run-start snapshot,
and gives each selected agent a private plan and isolated writable workspace.
Full QA is broad; Retest follows an earlier issue onto the current revision.
Evidence-first reporting preserves disagreement, token usage, and complete
observable run history until the user explicitly deletes it.

## What Phases 2–3 implement

The repository now implements the first real local runtime foundation:

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
- `@qa/persistence`: centralized data root, migrated SQLite repositories,
  filesystem artifacts, deterministic traversal, streamed/bounded copies;
- `@qa/project-manager`: full import, recoverable update, locks, integrity checks,
  storage preflight, progress, cancellation, deletion, and update recovery;
- `@qa/snapshot-engine`: deterministic hashes and streamed NDJSON manifests;
- `@qa/context-builder`: factual context plus progressive material indexes;
- `@qa/workspace-factory`: reflink-first isolated writable copies without hardlinks;
- `@qa/run-engine`: registry-driven real or fake workers, incremental events, activity tree,
  failure isolation, timeouts, recovery, cleanup, and log/JSON exports;
- `@qa/harness-muse`: the isolated Muse Code SDK adapter and structured plan/result boundary;
- `qa` CLI project lifecycle, simulated runs, and one-worker real Muse runs;
- versioned `--json` machine responses, typed errors, stable exit codes,
  lightweight status polling, and truthful capability discovery;
- unit, filesystem, SQLite, integration, recovery, and fake end-to-end tests.

Phase 2.1 hardens this runtime for concurrent local processes and large runs:
durable leases, abandoned-only recovery, atomic project locking, operation
journals, workspace symlink isolation, incremental transactional event ingestion,
live/recovered activity state, and iterator-backed exports. See
[docs/architecture/phase-2-1.md](docs/architecture/phase-2-1.md).

Phase 2.2 makes the CLI a first-class automation interface while preserving the
same application services and read/mutation boundary. See
[docs/architecture/phase-2-2.md](docs/architecture/phase-2-2.md) and
[ADR-0011](docs/adr/0011-headless-cli-automation-contract.md).

Phase 3 adds the first real AgentStack execution path. It pins
`@muse-code/sdk@0.1.1`, requires an exact configured model, and runs one Muse
worker through the same coordinator used by fake simulation. See
[docs/architecture/phase-3.md](docs/architecture/phase-3.md),
[ADR-0012](docs/adr/0012-muse-code-sdk-adapter-boundary.md), and the
[Muse setup guide](docs/setup/muse-code.md).

## What is not implemented yet

- DeepSeek V4 Flash integration: **NOT IMPLEMENTED YET**
- GLM-5.3-Flash integration: **NOT IMPLEMENTED YET**
- No DeepSeek/GLM calls, merger, independent verifier, retest execution,
  automatic fixes, Docker, Playwright, Electron, REST, MCP, deduplication,
  synthesis, or CI/CD generation.

## Repository layout

```text
apps/cli                 # thin qa project/run CLI
packages/shared          # IDs, timestamps
packages/schemas         # Zod source of truth + inferred types
packages/domain          # errors, transitions, fixtures, parse boundary
packages/harness-protocol# adapter contract, fake adapter, NDJSON helpers
packages/harness-muse    # sole @muse-code/sdk integration boundary
packages/persistence     # SQLite, data root, artifacts, filesystem engine
packages/project-manager # managed project lifecycle
packages/snapshot-engine # deterministic streamed snapshots
packages/context-builder # factual context/material index
packages/workspace-factory # isolated writable agent copies
packages/run-engine      # generic coordinator, registry composition, recovery, exports
packages/domain/tests/fixtures          # contract fixtures + relationship graph
packages/harness-protocol/tests/fixtures/harness  # golden NDJSON event streams
docs/architecture        # domain, lifecycle, protocol, Phase 1/1.1/2 baselines
docs/adr                 # 0001–0013
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
- **Zod at boundaries**: untrusted transport and persisted JSON are validated;
  corrupted stored rows fail with an entity-specific error.

## Runtime CLI

```bash
qa doctor
qa capabilities --json
qa agent list --json
qa agent doctor muse --json
qa project add ./sample-project
qa project list --json
qa project show <project-id> --json
qa run simulate <project-id> --scenario success
qa run simulate <project-id> --scenario partial
qa run start <project-id> --mode full --agents muse --wait
qa run list <project-id>
qa run show <run-id>
qa run status <run-id> --json
qa run export <run-id> --format log
qa run export <run-id> --format json --json
qa project update <project-id> ./sample-project
qa project delete <project-id> --yes --json
```

Human-mode simulated runs print `SIMULATED / FAKE HARNESS RUN`; the machine
response contains `"simulated": true`. Simulation is **FAKE / DEVELOPMENT ONLY**.
Real execution requires `SENTRY_MUSE_MODEL` and a separately installed `muse`
binary (or `SENTRY_MUSE_BINARY`); its response contains `"simulated": false`.
Exit 5 means QA completed and found issues, not that Sentry crashed. Set
`SENTRY_DATA_ROOT` to override the OS data location. See
`docs/architecture/phase-2-2.md` for the complete machine contract and deferred
scope.

## Initial Agent Stacks (configuration fixtures)

| Stack             | Model                | Harness          |
| ----------------- | -------------------- | ---------------- |
| Muse QA Agent     | Muse 1.3 Contributor | Muse Code        |
| DeepSeek QA Agent | DeepSeek V4 Flash    | DeepSeek Harness |
| GLM QA Agent      | GLM-5.3-Flash        | Claude Code      |

These are replaceable configurations (see `docs/architecture/agent-stack.md`).
Future stacks (new models, OpenCode, Kimi, future harnesses) validate without
domain changes — proven by `stack-future.json` + the future-agent test.
