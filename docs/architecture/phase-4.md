# Sentry Phase 4 — Three Independent Real AgentStacks

Status: COMPLETE (three-agent parallel smoke `run_01M2G9C6H4YVYX4F75CH1DHA36`
passed live: completed 3/3 with 9 findings, 22 evidence, 152 events;
see `phase-4-1.md` and `phase-4-test-history.md` for the full record).
Phase 5 builds the deterministic Merger on top; execution behavior is
frozen.

Baseline: `0593ece2b6a89cb8a46ad855f4ec59d640d4d09a` (Phase 3.1.1 closed).

## Objective

Turn the single-real-AgentStack architecture into a trustworthy
three-AgentStack execution system. Each stack independently performs the
same full QA mission against the same immutable project snapshot. No
Merger, no Verifier — Phase 4 ends at trustworthy independent outputs.

```text
IMMUTABLE PROJECT SNAPSHOT
  |        |        |
  v        v        v
MUSE   DEEPSEEK    GLM
  |        |        |
  v        v        v
RAW INDEPENDENT RESULTS (separate plans, workspaces, evidence, findings)
```

## Stable AgentStacks (model-version independent)

| Stack ID              | Display           | Harness package           | Harness                                                                            | Model (configured)                                                     |
| --------------------- | ----------------- | ------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `stack_muse_main`     | Muse QA Agent     | `@qa/harness-muse`        | Muse Code (`@muse-code/sdk@0.1.1`)                                                 | `SENTRY_MUSE_MODEL`                                                    |
| `stack_deepseek_main` | DeepSeek QA Agent | `@qa/harness-deepseek`    | DeepSeek Harness (`@deepseek-ai/dsh-sdk-client@0.1.5-rc.2`, `sdk-minimal` profile) | `SENTRY_DEEPSEEK_MODEL` (Flash line, e.g. `deepseek-v4-flash`)         |
| `stack_glm_main`      | GLM QA Agent      | `@qa/harness-claude-code` | Claude Code `2.1.270` via Z.AI Anthropic-compatible endpoint                       | `SENTRY_GLM_MODEL` (intended `GLM-5.3-Flash`; §"Model identity" below) |

## Same full QA mission

Every stack receives the complete QA responsibility class (understand,
build/lint/typecheck, existing + generated tests, runtime, APIs,
frontend, data, auth/security, config, dependencies, logic, errors,
concurrency, performance, CI/CD, edge cases, evidence, findings,
limitations). No specialist roles are assigned; independent
investigation paths are expected and desirable.

## Independence boundary

Before the future Merger, no AgentStack receives another agent's plan,
findings, evidence, tool history, messages, workspace, usage, progress,
hypotheses, or failures. Common inputs are only the immutable mission
inputs (ProjectSnapshot, ProjectContextSnapshot, RunInstructions,
QAPolicy); harness-specific operational instructions differ only where
the harness requires it. Proven by the no-peer-leakage concurrency
test (each `HarnessRunRequest` names exactly one stack).

Each agent produces its own immutable `SentryInvestigationPlanV1`
(`AgentInvestigationPlan`) before execution; later discoveries become
`EmergentHypothesis`. All three normalize into `SentryAgentResultV1`
→ canonical Evidence → canonical Findings.

## One trust pipeline

New package `@qa/evidence-pipeline`: the single generic path every
adapter shares (path containment incl. symlink escapes, baseline
provenance via the snapshot sidecar, operation-specific grounding,
canonical derivation, `validateFindingTrust()` gate). Adapters own only
tool correlation from their vendor events. `@qa/harness-muse` was
refactored onto it with zero behavior change (36/36 deterministic tests
unchanged).

## Parallel execution

`RunCoordinator` was already concurrent (`Promise.allSettled` over
per-agent workers, per-agent validators, transactional event
persistence) and already isolated failures via
`aggregateAgentRunOutcome` (completed / partial / failed). Phase 4
proves it with barrier tests: three workers overlap (fails if
sequential), one failure → partial with peers completed, one timeout →
partial without cancelling peers. Persistence: WAL + busy_timeout +
`BEGIN IMMEDIATE` short transactions; no DB lock is held across model
calls. Each adapter instance owns exactly one AgentRun (no shared
operation maps, sessions, or approval state); cleanup disposes only the
owned client/session.

## DeepSeek security boundary

- Restricted composition over the `sdk-minimal` base: a per-run
  generated `sentry-restricted.cordis.yml` pins
  `dsh-sandbox-policy` to `workspace-write` with the Sentry-owned
  isolated workspace root. No web search, no subagents/goal agents,
  no fanout, no scheduling, no `danger-full-access`.
- Sandbox denials observed in session events fail closed
  (`DEEPSEEK_SANDBOX_UNAVAILABLE`).
- Child environment: `buildDeepSeekChildEnvironment()` allowlist; the
  host credential (`DEEPSEEK_API_KEY`) enters host-process memory only,
  and the pinned runtime scrub (`scrubbedParentEnv`,
  `@deepseek-ai/dsh-subprocess@0.1.5-rc.2`, pattern
  `/KEY|PASSWORD|SECRET|TOKEN/i`) strips it before model-controlled
  subprocesses. Verified by sentinel tests against the pinned package.
- Subagent/delegation vocabulary in session events fails the run
  (`DEEPSEEK_SUBAGENT_FORBIDDEN`); no mid-turn cancel exists on the
  wire, so cancellation closes the owned runtime.
- Sentry-owned disposable `DSH_HOME` per run (never `~/.dsh`).
- No internal JSONL/session-storage parsing: integration uses the
  documented SDK client (`DeepSeekHarness` run API over stdio JSON-RPC)
  and the documented `SessionEvent` envelope vocabulary.

## Claude Code security boundary

- Spawn: `claude -p --verbose --output-format stream-json --model …
--settings <per-run fail-closed JSON> --setting-sources ''
--strict-mcp-config --permission-mode dontAsk --permission-prompts
none --disallowedTools Agent,Task,WebFetch,WebSearch,Skill,Cron…
--session-id <uuid> [--resume <uuid>]` (flags verified on 2.1.270).
- Settings pin `sandbox.enabled/failIfUnavailable` true and
  `allowUnsandboxedCommands` false plus `disableBypassPermissionsMode`.
  Never `--dangerously-skip-permissions`.
- Ephemeral `CLAUDE_CONFIG_DIR` per run, destroyed after extraction;
  only canonical observable data persists.
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` forced on every spawn (caller
  cannot override); the Z.AI credential (`ANTHROPIC_AUTH_TOKEN`)
  enters parent-process memory only. Deterministic tests prove the flag
  is forced; live Bash absence is verified with a sentinel during smoke.
- Subagent proof is observable: init tool inventory must not list
  Agent/Task, `tool_use` with those names fails the run, and the
  terminal `result.subagent_stats.spawned` must stay zero.
- Machine output is parsed structurally (NDJSON `stream-json`); no
  terminal scraping. Planning and execution share one logical session
  via `--session-id`/`--resume`.

## Model identity (honest)

- DeepSeek: runtime identity records configured/requested model
  (`deepseek-v4-flash` at implementation time); the host exposes no
  authoritative provider-level execution proof, documented as such.
- GLM: the 2.1.270 binary emits `[claude-code:unrecognized_model]` for
  bare `glm-5.3-flash` (routing is provider-side via the Z.AI
  Anthropic-compatible endpoint + auth). Completion requires proving
  on the prepared host that the configured path accepts the intended
  mapping to the strongest degree the provider exposes; only
  configured/requested identity is claimed otherwise. No silent
  fallback model is ever accepted as GLM-5.3-Flash.

## Runtime identity, usage, tokens

Per AgentRun: stable stack ID, display name, provider,
configured/requested model, harness + versions, SDK/executable
versions, platform, sandbox verification, warnings. No credentials.
Token usage (input/output/cached/turns/duration) is recorded where
upstream exposes it; unknown stays unknown, never zero; run totals
aggregate canonically. No monetary cost tracking, no hard token
budgets; adapters follow compact-map → reconnaissance → targeted
reads → deterministic tools, and never dump the repo into prompts.
`InvestigationDepth` remains a future concept; nothing in Phase 4
blocks it.

## Failure isolation and timeouts

Completed/partial/failed per existing semantics; one adapter failure
never terminates healthy peers. Per-adapter turn timeouts plus the
run-level guard; a hung DeepSeek turn or Claude session does not stop
the others. Preflight resolves all selected stacks before locking the
project; post-preflight provider failures are isolated AgentRun
failures. Safe pre-session retries are bounded; after useful output
exists, partial state is preserved, never silently re-run.

## Exports and integrity

Exports preserve per-agent identity (which agent, which evidence,
which operations, which runtime). No hidden harness reasoning enters
durable history; ephemeral transcript/config state is destroyed.
Original project and managed baseline hashes are verified equal
before/after; agent workspaces diverge independently and are removed.
Process cleanup terminates only owned trees/sessions (SDK `close()`
ladders, per-turn child handles); never by generic process name.

## What Phase 4 does NOT include

Merger, Verifier, agreement scoring, consensus, deduplication, retest
or targeted execution, desktop UI, automatic source fixes, monetary
cost tracking, hard token budgets, full Adaptive InvestigationDepth.

## Verification state

- Deterministic gates: hygiene, format, lint, typecheck, test, build
  (see final report for exact totals).
- Exact-HEAD CI: see final report.
- Live (2026-09-13, Windows native host for DeepSeek; WSL2 Ubuntu for tooling):
  - `qa agent doctor deepseek|glm` truthful: `unconfigured` without
    model/binary, `configured` with real binaries (Claude Code
    `2.1.270 (Claude Code)` detected; DeepSeek runtime `0.1.5-rc.2`
    executes); no credential leaks; SDK pins reported.
  - **DeepSeek individual smoke PASSED** (`run_01M2DVW6BG7Y7BCXDHEB80QRSV`):
    status `completed`, agent `completed`, model `deepseek-v4-flash`,
    SDK `0.1.5-rc.2`, runtime `0.1.5-rc.2`, 2 `confirmed` findings (real
    divide-by-zero defect + testing finding, each backed by 3 evidence
    including `reproduced_failure`/`reproduced_behavior`), 6 evidence
    (2 code_reference/baseline + reproduced command/runtime), usage
    5014 in / 26350 out / 40832 cached / 2 turns, workspace cleaned,
    `json` + `log` exports. Four preceding runs each caught a real
    discrepancy and drove a system fix (lazy registration, error-code
    passthrough, EFTYPE probe hardening, sandbox-detector scoping,
    marker observation, op ledger, calibration).
  - Claude Code fail-closed path verified against the real `2.1.270`
    binary: host lacks `socat` (bubblewrap present), so the binary
    refuses to start with `sandbox.failIfUnavailable`; the adapter
    maps this to `GLM_SANDBOX_UNAVAILABLE` exactly per spec.
  - **GLM individual smoke PASSED** (`run_01M2EBSC5XCPEKTT8TH6DJREM3`, WSL2):
    status `completed`, agent `completed`, model `glm-5.3-flash`
    (verified served on the key via the Z.AI models endpoint — exact
    intended model, no fallback), Claude Code `2.1.270`, provider
    `zai-anthropic`, 4 findings (strong/logic defect + testing +
    2 probable/logic), 7 evidence (4 code_reference/baseline +
    command/manual with `groundingOperationIds` populated), usage
    40691 in / 19627 out / 194496 cached / 2 turns, `subagent_stats`
    spawned 0, sandbox enforced (failIfUnavailable, socat present),
    credential sentinel: zero token-shape hits in persisted data,
    workspace + ephemeral Claude home removed, no stray processes,
    fixture intact, `json` + `log` exports. Four preceding runs each
    drove a genuine fix (planning contract, resume-flag shape,
    evidence-field guard, execution contract).
  - REMAINING: three-agent parallel smoke (Muse + DeepSeek + GLM).
    No fallback model was substituted; no success was faked.
  - Phase 4.2 (see `phase-4-2.md`): two-stage investigation/reporting
    caused repeated live serialization failures because Sentry-owned
    operation identities were created during the same turn in which the
    model had to cite them. Phase 4.2 separates investigation from
    reporting and provides the frozen post-investigation operation
    ledger to the final report turn. All three adapters now run
    planning → investigation → tool-free reporting with ReportV2
    discriminated evidence, bounded report-only repair, actual turn
    accounting, and unchanged strict validation.
  - GLM Phase-4.2 regression PASSED (`run_01M2G2BZ3HKBFT724XAM1W70W6`):
    completed/completed in 3 turns (planning + investigation + ONE
    schema-armed report, no correction needed) — proving `--json-schema`
    works on the Z.AI route (no STRUCTURED_OUTPUT_UNSUPPORTED fallback).
    4 strong findings, 13 evidence incl. reproduced_behavior command
    items with canonical groundingOperationIds, 121659/16687/342208
    tokens, json+log exports.
  - Muse Phase-4.2 regression PASSED (`run_01M2G4QXJAMPFT4EE9C2VFZP0S`):
    completed/completed in 3 turns, model muse-spark-1.3-contributor
    via Muse Code 1.2.1, 2 strong findings, 4 evidence, 43 events,
    json+log exports.
  - DeepSeek Phase-4.2 regression PASSED (`run_01M2G4YWHDJWDR3EENGPD4RMQS`):
    completed/completed in 3 turns, model deepseek-v4-flash via
    0.1.5-rc.2 runtime, 1 strong finding, 2 code_reference evidence,
    honest usage (5918/22789/45440), 40 events, json+log exports.
  - Muse solo re-run PASSED (`run_01M2G93HSA5HEFYVK2M8JS3TH5`):
    completed/completed in 3 turns (129s), 2 strong findings,
    4 evidence, 37 events — proving the parallel-run hang was
    transient Meta-side stalls, not systematic.
  - **THREE-AGENT PARALLEL SMOKE PASSED** (`run_01M2G9C6H4YVYX4F75CH1DHA36`):
    `completed`, production, 3/3 agents `completed` with zero repairs
    needed (3 turns each): Muse (muse-spark-1.3-contributor, 180s),
    DeepSeek (deepseek-v4-flash, 5845/18086/36736 tokens), GLM
    (glm-5.3-flash via Claude Code 2.1.270, 120542/10736/142592).
    9 findings (8 strong, 1 probable; no agreement required), 22
    evidence incl. op-grounded command items with canonical
    groundingOperationIds, 152 events with real overlap, same snapshot
    `snap_01M2G9C6J2FTM4PFTAXGCCX6YB`, separate per-agent workspaces
    (all removed), no stray processes, fixture intact, zero secret
    hits in persisted data, `json` + `log` exports.
  - DeepSeek model migration (2026-09-15, provider-verified): the official
    DeepSeek API docs list `deepseek-flash` (MODEL VERSION
    DeepSeek-V4.1-Flash) as canonical; `deepseek-v4-flash` is a retired
    legacy alias still served by V4.1-Flash. The alias route hung a solo
    run for the full 30-minute watchdog (`run_01M2GTX9T75A17MP4KZ47QSCAW`);
    the canonical route completed normally (`run_01M2HPBXPEV1WT5A9G860GFJXZ`:
    completed/completed, 3 turns, 2 strong findings, 7 evidence incl.
    op-grounded runtime items, 6377/27235/62848 tokens, 55 events,
    json+log exports). Historical `deepseek-v4-flash` entries above
    remain as observed: that configured ID was valid at the time and the
    provider served V4.1-Flash behind it. No adapter or contract changes
    were needed — model identity stays in environment configuration.
