# Handoff — Phase 4 Three Independent Real AgentStacks

Status: IN PROGRESS. Implementation is complete and pushed to `main`;
deterministic gates and exact-HEAD CI pass; live validation is partially
blocked on provider credentials (see below). No Merger, no Verifier.

Baseline: `0593ece2b6a89cb8a46ad855f4ec59d640d4d09a`

Implemented:

- `@qa/evidence-pipeline`: the single generic trust path (path
  containment, baseline provenance, op-grounding, canonical
  derivation, `validateFindingTrust()` gate). `@qa/harness-muse`
  refactored onto it with zero behavior change.
- `@qa/harness-deepseek` (`@deepseek-ai/dsh-sdk-client@0.1.5-rc.2`,
  `sdk-minimal` + per-run `workspace-write` patch, disposable DSH
  home, allowlisted child env, sentinel tests vs the pinned
  `scrubbedParentEnv`, real `SessionEvent` envelope mapping with
  per-step usage aggregation).
- `@qa/harness-claude-code` (Claude Code `2.1.270` via `-p --verbose
--output-format stream-json`, per-run fail-closed settings,
  `--setting-sources ''`, `--strict-mcp-config`, `dontAsk`+`none`,
  Agent/Task/Web denied, `--session-id`/`--resume`, ephemeral
  `CLAUDE_CONFIG_DIR` destroyed after extraction, forced
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, `subagent_stats.spawned`
  enforcement).
- CLI: `--agents muse,deepseek,glm` (default all three), `agent doctor
muse|deepseek|glm`, three-entry `agent.list`, additive `agentStacks`
  capabilities (contract version stays 1).
- Concurrency proofs: barrier overlap, failure→partial, timeout→partial,
  no peer leakage, fake-adapter exclusion.

Verification:

- `pnpm repository:check`: pass
- `pnpm format:check`: pass
- `pnpm lint`: pass (15/15, verified uncached)
- `pnpm typecheck`: pass (29/29)
- `pnpm test`: all green — evidence-pipeline 10/10, harness-deepseek
  13/13, harness-claude-code 14/14, harness-muse 36/36 (+1 live skip),
  run-engine 18/18 (incl. parallel 5/5), cli 10/10
- `pnpm build`: pass (15/15)
- GitHub Actions: run `34755925782`, `status=completed`,
  `conclusion=success` on exact HEAD `b46b678162579beccedf2ef7523a7134f3f4b48f`
- Live doctors: truthful `unconfigured`/`configured` for all three
  stacks; real binaries detected (Claude Code 2.1.270, dsh 0.1.5-rc.2)
- DeepSeek production factory: verified vs real runtime to provider
  boundary (typed failure, no hang)
- Claude fail-closed sandbox refusal: verified vs real binary
  (`GLM_SANDBOX_UNAVAILABLE`, host lacks `socat`)

Blocked (external, honest — needs a prepared host or user credentials):

- Full DeepSeek smoke: needs `DEEPSEEK_API_KEY` (+ optional
  `SENTRY_DEEPSEEK_MODEL`, default route `deepseek-v4-flash`).
- Full GLM smoke: needs the Z.AI auth token (`ANTHROPIC_AUTH_TOKEN`)
  plus `socat` installed (bubblewrap already present) for the Claude
  native sandbox.
- Three-agent parallel smoke: needs both of the above.

Next: provide credentials and `socat` on the prepared host, then run
the three live smokes (`SENTRY_LIVE_MUSE_TEST=1` pattern per stack)
and the `qa run start --agents muse,deepseek,glm` parallel smoke.
Only then declare Phase 4 COMPLETE. Do not start the Merger.

## Phase 4.2 update (2026-09-14)

All three adapters refactored to planning → investigation → tool-free
reporting with frozen post-investigation ledger, ReportV2
discriminated evidence, bounded report-only repair, and actual turn
accounting. Ledger-timing tests failed pre-refactor on all three
(recorded: ff13172). Exact-head CI green on 06a5a89 (34838416753).
Live validation order: Muse regression, DeepSeek regression, GLM
regression (each must show planning/investigation/reporting stages,
post-investigation ledger, no reporting tool use, cleanup), then ONE
three-agent parallel smoke. Watch for: GLM --json-schema acceptance
on the Z.AI route (fallback warning expected if unsupported), report
repair telemetry, turn counts 3+.

## Phase 5 update (2026-09-15) — COMPLETE pending exact-head CI

Deterministic merger + agreement layer shipped: `@qa/merger`
(normalize → match → complete-link cluster), canonical merge schemas
in `@qa/schemas`, SQLite migration v3, `qa run merge` CLI (exit
3/4/6), JSON merge sections + log cluster rendering, stale-aware
export regeneration (merge-timestamp comparison; supersede, never
mutate). Live proof: `run_01M2K4SNQFV5EBJPKGQBJ0VA9N` 3/3 →
`merge_X7MJ4KN1Q8FBDM5CM1GB775CNM` (5 clusters). Execution paths
(adapters, coordinator, contracts) untouched by the export fix;
only `run-engine/exporters.ts` + one test added.
