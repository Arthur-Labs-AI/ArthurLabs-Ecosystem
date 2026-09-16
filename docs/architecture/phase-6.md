# Phase 6 — Independent Evidence-First Verifier

## Purpose

Consume a persisted Phase 5 MergeResult and independently check its
FindingClusters against FRESH disposable workspaces created from the
exact immutable ProjectSnapshot used by the original QA run. The
Verifier answers whether Sentry can confirm, reproduce, partially
validate, disprove through clean replay, or not reliably determine
each merged issue from canonical evidence — with NEW observations,
never agent agreement.

## Frozen foundation (non-negotiable)

`packages/harness-muse`, `packages/harness-deepseek`, and
`packages/harness-claude-code` are frozen infrastructure: no prompt,
policy, sandbox, or behavior changes in Phase 6. The Merger stays at
v2. No rerun of the three QA agents as verification, no LLM judge,
no embedding consensus, no majority voting.

## Trust model

Agreement and verification are independent: `agreementState` never
enters the outcome classifier. A single-source finding may reproduce
perfectly; a 3/3 finding may fail clean replay. `inconclusive` is a
first-class honest result — never upgraded from consensus.

## Workspace rule

One fresh disposable workspace per FindingCluster, materialized from
the managed working copy ONLY when it still sits at the snapshot's
revision AND every baseline hash reproduces. Otherwise the attempt
records SNAPSHOT_DRIFT and classifies `inconclusive` — Sentry
verifies snapshot A or refuses; it never mistakes moved-on state B
for A. Agent workspaces are never reused. Workspaces are removed
after each attempt; owned processes are tracked and killed (never
`pkill`/`taskkill /IM`).

Sentry stores hashes, not source duplicates, so post-fix state
cannot be time-traveled: verification after project changes is
honestly inconclusive, not silently wrong. This is an explicit
Phase 6 v1 limitation, not a bug.

## Recipe generation (deterministic, model-free)

`buildRecipe` consumes cluster + source findings + evidence +
canonical operations resolved from persisted `command.executed` /
`test.result` events by `groundingOperationIds`. Never from prose.
Natural-language `reproductionSteps` ride along as
`nonExecutableInstructions` context; converting them into commands
is forbidden.

Step types: `source_integrity` (file/regular-file/lines/hash),
`command_replay`, `test_replay`, `environment_check` (reserved),
`unsupported_claim` (manual/log/browser/static-analysis, dangling
provenance). Same canonical operation from several findings dedupes
to one step (recipe fingerprint). Priority orders the recipe only.

## Execution containment

`VerificationCommandRunner`: cwd locked to the verifier workspace,
allowlisted child env (secrets never forwarded), bounded output,
timeouts kill only the owned child. Replay executes ONLY recorded
commands headed by known test/build tooling (versioned allowlist);
everything else becomes `unsupported`. Recorded host-escape paths
(`..`, `~`, absolute outside workspace/`/tmp`) are `blocked`.
String checks are defense-in-depth; cwd + env + timeouts are the
real boundary.

## Signatures (v1)

Matching compares exit code and test status against canonical
expectations; a normalized diagnostic fingerprint (workspace root,
timestamps, ANSI, temp prefixes stripped; semantic text preserved)
is recorded for audit. Source integrity alone can never yield
`reproduced` — only fresh runtime observation can.

## Outcome semantics

- `reproduced`: decisive independent replay matched, no contradiction.
- `partially_verified`: meaningful matched checks (including
  source-only integrity) without decisive reproduction.
- `not_reproducible`: every decisive replay executed compatibly and
  the bug signature was absent. Environment/tool failures NEVER
  produce this — they produce `inconclusive`.
- `inconclusive`: no replayable steps, errors, blocks, unsupported
  claims, drift, or missing tooling.

Per-assertion dimensions (`behavior`, `source_location`,
`test_failure`, `command_failure`, `root_cause`) stay separate;
`root_cause` is always `inconclusive` in v1.

## Identity, versions, idempotency

`VERIFIER_VERSION = 1`, `RECIPE_VERSION = 1`, `SIGNATURE_VERSION = 1`;
typed `vrun_`/`vattempt_`/`vstep_`/`vobs_` IDs; recipe digests cover
versions + snapshot + cluster + sorted evidence/ops + expectations.
Runs are intentional executions (no global dedup — history matters
for Phase 7); recipes are deterministic for identical input.

## Persistence

Additive migration (v4): `verification_runs`,
`verification_attempts` (ownership-immutable trigger),
`verification_steps`, `verification_observations` (insert-only),
`verification_assertions`. Incremental durability (run → attempt →
step → observation → atomic attempt finalization); crash recovery
marks expired-lease running attempts `interrupted` (to be wired to
the lease monitor — see limitations). Source Findings/Evidence/
Clusters/MergeResults/QARuns are never mutated by verification.

## CLI and exports

Explicit only: `qa verify start <merge-result-id> [--clusters …]`
(exit 0 on successful execution regardless of outcomes; 3 not
found, 4 non-verifiable state) and `qa verify show <run-id>`.
JSON export gains additive `verificationRuns/Attempts/
Observations/Assertions` sections; log export renders outcomes with
agreement visibly separated from verification. Large replay output
lives in the artifact store, never inline JSON.

## Failure isolation and cleanup

Per-attempt failure (one cluster's crash) leaves completed attempts
valid; the run becomes `partial`. QARun/MergeResult status can
never change from verification.

## Phase 7 boundary

Recipes and assertions are designed for future replay against new
revisions, but Phase 6 verifies the historical snapshot ONLY. No
retest, no fix-state tracking, no UI.

## Known limitations (v1, intentional)

Only canonically replayable claims verify; exploratory, browser,
external-service, or prose-only claims stay `inconclusive`. No
concurrent cluster verification (sequential by default). No dynamic
port orchestration (server replays unsupported). Crash recovery
marks interruptions but has no active lease-expiry sweeper yet.
