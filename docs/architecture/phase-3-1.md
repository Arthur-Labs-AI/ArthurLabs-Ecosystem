# Phase 3.1 -- Real agent trust, environment isolation and live Muse validation

Status: IN PROGRESS (implementation landed; live smoke pending prepared host)

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
  MUSE_* / META_* configuration.
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

Generic rules live in @qa/domain (evidence-trust.ts) and @qa/schemas
(agent-result.schema.ts superRefine) so Muse, DeepSeek, GLM, and future
agents share them. Muse-specific tool correlation stays in harness-muse.

- Production findings require at least 1 evidence item (evidenceKeys min 1);
  zero-evidence findings are rejected as MUSE_INVALID_RESULT.
- confirmed requires at least 1 grounded item (reproduced_failure/behavior,
  tool_diagnostic, strong_code_evidence, or command/code_reference/test
  type). Manual/model reasoning alone (agent_reasoning) cannot confirm.
- strong requires grounded source/tool evidence; probable stays
  evidence-backed; speculative may lean on reasoning.
- Command evidence: claimed command + exitCode must equal an observed Muse
  toolCall/userShell execution (normalized pair set). Exit-code mismatch
  is rejected.
- Test evidence: claims without an observed tool operation are downgraded to
  manual/agent_reasoning (never reproduced proof by JSON alone). Observed
  test-named tool calls seed the correlation set.
- Runtime/log evidence without observed tool activity is marked
  agent_reasoning; type preserved, trust weakened.
- Unknown/duplicate evidence keys, path escapes, broken symlinks, external
  symlinks, and out-of-range lines are still rejected. Structured output
  stays strict whole-JSON (no prose scraping).

## Provenance (baseline vs modified_workspace)

- codeReference() compares the workspace file hash against the run baseline:
  equal means baseline (with relativePath, contentHash, lines, excerpt, and
  snapshot identity via the request); different or new means
  modified_workspace (agent-created investigative artifacts included).
- The adapter reads an optional coordinator-written baseline-hashes.json
  sidecar next to the workspace; absent sidecar means conservative
  modified_workspace (never a false baseline). No per-item full-project
  rehash.
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
- unconfigured = model missing; configured = model + binary present (NOT
  proof of auth); ready = real session startup succeeded in this process;
  degraded = partial/warning; unavailable = known failure.
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
- dispose() is idempotent/bounded; on Windows with a known host PID it
  records an observable shutdownNotice() (MUSE_SHUTDOWN_PARTIAL semantics)
  instead of pretending full tree cleanup.

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

## Live Muse validation result (attempt 1, this host)

LIVE MUSE SMOKE TEST NOT RUN
Reason: no Muse executable on PATH, no SENTRY_MUSE_MODEL, no
SENTRY_MUSE_BINARY, and no SENTRY_LIVE_MUSE_TEST opt-in on this development
host. Doctor output on this host: model FAIL (not configured), binary FAIL
(Muse executable was not found: muse), environment PASS (15 allowed, 58
blocked), sdk PASS (0.1.1), sandbox WARN (not yet verified), runtime WARN
(no live session yet); overall status unavailable. This is a purely external
configuration precondition, not a Sentry code failure: all deterministic
gates (CI run 34639562954, status completed, conclusion success) pass. The
live smoke must be re-attempted from an explicitly prepared host with the
binary, exact model, credentials, and SENTRY_LIVE_MUSE_TEST=1 before Phase
3.1 can be declared complete.

## Deferred (explicitly not in 3.1)

DeepSeek, GLM/Claude Code, real merger, verifier, retest execution, UI, and
automatic fixes are untouched. FakeHarnessAdapter stays test-only.
