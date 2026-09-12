# Phase 3.1 -- Real agent trust, environment isolation and live Muse validation

Status: COMPLETE (finalization landed, deterministic gates green, GitHub Actions green on exact HEAD, live Muse smoke PASSED)

Baseline: f6954f0b774c6494f3c8e9345e0657ad22768e5a (Phase 3 complete).
Phase 3 remains the adapter foundation; this phase hardens it without
redesigning the RunCoordinator -> registry -> MuseHarnessAdapter ->
muse-code-sdk -> muse serve architecture. No DeepSeek, GLM, merger,
verifier, retest, or UI work is in scope.

## Child environment isolation

New layer: packages/harness-muse/src/environment.ts

- buildMuseChildEnvironment(source, platform, extraAllowedNames) builds the
  ONLY environment the autonomous worker receives. The SDK replaces the child
  environment wholesale, so raw process.env is never forwarded.
- Allowlist: OS runtime (PATH, PATHEXT, SystemRoot, WINDIR, COMSPEC, TEMP,
  TMP, TMPDIR, HOME, USERPROFILE, LOCALAPPDATA, APPDATA, LANG, LC_ALL, TERM,
  and similar), plus SENTRY_MUSE_BINARY/MODEL selectors and non-secret
  MUSE_* / META_MUSE_* configuration plus two explicit META names
  (META_API_ENDPOINT, META_REGION). No broad META_* prefix.
- Blocked: anything matching secret-name fragments (token, secret, password,
  api-key, authorization, cookie, private-key, credentials, auth) unless
  explicitly listed in MUSE_ALLOWED_SECRET_ENV_NAMES (currently empty: no
  official Muse secret env names are documented; auth rides the existing
  local authenticated state outside the workspace).
- Case-insensitive dedupe (Windows semantics); minimal PATH fallback when the
  source lacks one; only NAMES are ever reported, never values.
- Redaction (redaction.ts) is retained as defense-in-depth: do-not-expose
  plus redact-if-exposed, never expose-and-hope.
- registration.ts --version probe and discovery.ts config reads use the host
  env (local operations, no autonomous code); only run() spawns the worker,
  and only with the sanitized child env.
- No credentials are persisted: SQLite, QARun, AgentRun, runtimeIdentity,
  events, evidence, findings, exports, logs, and doctor carry names and
  statuses only.

## Evidence grounding policy

Trust pipeline (single source of truth):

Model assertion -> harness correlation -> canonical Evidence ->
GENERIC validateFindingTrust() -> Finding -> persist

Generic rules live in @qa/domain (evidence-trust.ts: EvidenceGrounding =
model_reported | source_verified | operation_observed | reproduced, plus
validateFindingTrust) and @qa/schemas (agent-result.schema.ts superRefine
mirrors the same confirmed/strong bar so bad raw JSON never enters).
Muse-specific tool correlation stays in harness-muse; no duplicate
confidence logic lives in the adapter.

- Production findings require at least 1 evidence item (evidenceKeys min 1);
  zero-evidence findings are rejected as MUSE_INVALID_RESULT.
- confirmed requires reproduced or directly correlated operation evidence.
  strong requires grounded source/tool evidence (source_verified or better).
  probable stays evidence-backed; speculative may lean on reasoning.
  Manual/model reasoning alone (agent_reasoning) confirms nothing.
- Operation correlation: the agent contract carries an optional operationKey
  per evidence item; the adapter owns the Muse-item-ID -> OperationId ->
  temporary op-key map (op_1, op_2, ... in execution order). Correlation is
  validated, never trusted: unknown keys rejected, test evidence bound to a
  non-test operation rejected, status/exit mismatch rejected.
- Command evidence: claimed command + exitCode must equal an observed Muse
  toolCall/userShell execution (whitespace-normalized pair identity).
  Exit-code mismatch is rejected.
- Test evidence: tied to its specific observed test operation (generic
  test-command detection, not a /test/ name heuristic). Reproduced strength
  without a correlated operation is rejected as MUSE_INVALID_RESULT (explicit
  misrepresentation); weaker ungrounded test/runtime/log claims downgrade to
  manual/agent_reasoning. An unrelated tool run (e.g. cat README) never
  grounds a claim.
- Runtime/log evidence: must name the concrete operation/artifact via
  operationKey where tool-produced; otherwise downgraded (weak) or rejected
  (reproduced claim). Manual evidence stays agent_reasoning unless
  independently grounded.
- Unknown/duplicate evidence keys, path escapes, broken symlinks, external
  symlinks, and out-of-range lines are still rejected. Structured output
  stays strict whole-JSON (no prose scraping).

## Provenance (baseline vs modified_workspace)

Source of truth: the frozen run ProjectSnapshot (ProjectRevision ->
ProjectSnapshot), never the live source path or post-start working copy.

- SnapshotEngine.baselineFileHashes(snapshotId) streams the stored NDJSON
  manifest (file entries only, no rescan) into a hash map.
- RunCoordinator passes it to WorkspaceFactory.create, which writes
  workspace/.sentry-workspace/baseline-hashes.json {schemaVersion: 1,
  snapshotId, files: {path: sha256:...}} OUTSIDE the agent-visible
  workspace/project tree. No absolute paths, credentials, or host details.
- codeReference() compares per file: workspace hash == baseline hash ->
  baseline (with relativePath, contentHash, lines, excerpt, snapshot
  identity); different or absent from baseline -> modified_workspace.
  Per-file granularity: modifying src/auth.ts leaves src/users.ts baseline.
- The adapter validates the sidecar schemaVersion + snapshotId match before
  use; absent/mismatched sidecar means conservative modified_workspace
  (never a false baseline). Large-repo note: correctness first; the map can
  move to streamed/NDJSON/SQLite lookup later without changing the contract.
- Bounded excerpts (4k) and bounded command summaries; no unlimited
  stdout/stderr inline (artifacts path reserved for larger content).

## Token accounting

- SDK ground truth (msp.d.ts): TurnCompletedParams.usage is the turn Setup
  aggregate token usage, summed across the turn model completions: PER-TURN,
  not cumulative.
- aggregateTurnUsage([planning, execution]) sums input/output/cached tokens
  and durations across both turns; turns counts completed turns with an
  outcome. Unknown stays undefined (never 0). No monetary/cost fields.
- Deterministic tests cover: both turns, one missing usage, durations,
  terminalUnknown, and empty input.

## Runtime readiness

- museReadinessFromChecks() + doctorMuse() report unconfigured, configured,
  ready, degraded, unavailable plus configured, binaryAvailable,
  runtimeVerified, status.
- unconfigured = model (or essential config) missing; unavailable =
  configured but binary cannot execute / hard failure; configured = model +
  binary + SDK local checks pass, no live session yet (sandbox-unverified and
  runtime-unverified are INFORMATIONAL, not degraded); ready = real session
  startup succeeded and no real warning exists; degraded = runtime works but
  a REAL warning exists (probe soft-failure, partial shutdown confidence,
  known restriction). configured is now stable and useful instead of
  permanently degraded.
- The available boolean is kept for CLI contract stability but is no longer
  the whole story; human agent list prints the readiness word and a
  (runtime verified) suffix when true.
- Doctor stays cheap: model, binary + version, SDK version, environment
  policy summary, sandbox honesty (Sandbox: not yet verified until a real
  startup), and runtime-verification state. No QA run is triggered.
- Verification is ephemeral and process-scoped (markMuseRuntimeVerified on
  real startSession); binary/model/SDK/OS changes invalidate it by process
  restart. Nothing global is cached.

## Windows shutdown

- Order preserved: SDK/session graceful shutdown, then host termination,
  then observable notice, then workspace cleanup (coordinator disposes before
  cleanup; cancel -> dispose -> cleanup covered by test).
- The SDK owns the child (stdin EOF, bounded drain, then SIGTERM/SIGKILL).
  On POSIX it signals the SDK-owned process group (grandchildren die with
  the host); on Windows only the child is signaled (SDK FR-017b claims no
  subtree containment). Sentry does NOT shell out, never interpolates
  command strings, and never kills by generic exe name.
- dispose() is idempotent/bounded. The generic HarnessAdapter contract has
  optional getShutdownDiagnostics() (typed code/severity/message/retryable);
  Muse records MUSE_SHUTDOWN_PARTIAL (warning) on Windows, where the SDK
  exposes no host PID and claims no subtree containment (FR-017b) -- no
  PID hacking, no kills by generic exe name, ever. RunCoordinator consumes
  diagnostics after dispose() and persists each as a run warning activity
  before workspace cleanup.

## Live Muse validation

- Opt-in only: SENTRY_LIVE_MUSE_TEST=1 plus binary, model, and credentials;
  never in GitHub CI. Prerequisites: qa agent doctor muse (binary, SDK,
  model, status; no credentials printed).
- Fixture: tiny flawed project (package.json, src/math.ts, tests/math.test.ts,
  README) with one failing behavior, one defect, one passing test.
- Success requires: host start, model response, plan persisted, execution
  with real tool events, real evidence/findings (or legitimate no-finding),
  no persisted reasoning, shutdown, workspace cleanup, fixture and baseline
  hashes unchanged, export created, terminal state -- without forcing a
  specific finding.
- The result is recorded here as LIVE MUSE SMOKE TEST PASSED/FAILED plus the
  reason, with versions, counts, and integrity hashes. Phase 3.1 is not
  complete on a FAILED caused by a Sentry bug; pure-external config failures
  are reported exactly, never faked.

## Live Muse validation result (attempt 1, Windows host)

LIVE MUSE SMOKE TEST NOT RUN on the Windows side (no native Muse binary;
Muse Code is macOS/Linux-only). Validated instead from WSL2 Ubuntu with
Muse Code 1.1.1 installed via the official installer and device-code login.

## Live Muse validation result (final, WSL2 Ubuntu prepared host)

LIVE MUSE SMOKE TEST PASSED

- Muse executable version: Muse Code 1.1.1 (1.1.1-R2514.1)
- SDK version: 0.1.1 (pinned, unchanged)
- Configured model ID: muse-spark-1.3-contributor (exact, no fallback)
- Commit SHA: d3698fd0546c921588973f4ff9a4ca4a6f92559d
- GitHub Actions run ID: 34717527493 (status completed, conclusion success)
- Run ID: run_01M2BNASWGVHXHT6GFCD1V9HM2, terminal status: completed
- Agent status: completed, no failure; InvestigationPlan count: 1
- Tool operations: 10; usage: turns 2, durationMs 117505
- Evidence: 4 (2 code_reference/strong_code_evidence/baseline,
  1 runtime/reproduced_behavior, 1 manual/agent_reasoning from a
  downgraded paraphrased command claim)
- Findings: 1 (confirmed/logic: divide() returns 0 instead of rejecting
  division by zero -- the real fixture defect)
- Workspace cleanup: deleted after run; original fixture hash: match;
  managed baseline hash: match; production exports: json + log created
- No fake labels, no FakeHarnessAdapter involvement, no persisted reasoning

Three live-verified integration fixes were required to get here (all in
this phase, all covered by deterministic tests): host-internal
reminderChild items are skipped, not failed; workspace-scoped approval
auto-decision answers human_pending tool parks (observable via
MUSE_APPROVAL_GRANTED/DENIED warnings); per-turn watchdog bounds turns
because the SDK never times out locally. Two pipeline-hardening fixes came
from the same runs: activity titles truncate model-influenced strings, and
ZodError maps to structured failures without JSON leaks.

## Deferred (explicitly not in 3.1)

DeepSeek, GLM/Claude Code, real merger, verifier, retest execution, UI, and
automatic fixes are untouched. FakeHarnessAdapter stays test-only.
