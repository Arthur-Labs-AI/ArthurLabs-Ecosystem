# Phase 5 error-redaction correction (Task A)

Date: 2026-10-13. Branch: `fix/v1-error-redaction-hardening` (base: approved `origin/dev`, PR targets `dev`).
Threat model: `docs/security/V1_THREAT_MODEL.md` (finding F2, corrected).

## Starting point

- Approved `origin/dev`: `0c65f7c05e121b09e5f33eeea3be2fa235b4f6e7` (PR #11 merge).
- `origin/main`: `4fd2be9fa3b17370841dbb1d2f0422a2150c62d8` (unmoved).
- Post-merge `dev` CI: all three required jobs success (verified before changes).
- Beta tag `v0.1.0-beta.1` intact. No version, provider-pin, or schema changes.

## Root-cause analysis

Three Desktop error paths applied three different policies to the same
untrusted input (provider/runtime/service exception text):

- `toRouterError()` (renderer IPC): arbitrary codes unbounded; messages capped
  at 1000 chars EXCEPT a nested `Error.message` branch with no cap at all.
- `sanitizeError()` (service RPC fan-out): codes capped at 100, messages at
  1000 — same shape, different bounds, no nesting branch.
- CLI broker catch: codes unbounded, messages capped at 2000.
- `classifyBootFailure()`: code and message unbounded into the fatal screen.

None scrubbed known secret values; none validated codes. A coded exception
carrying a synthetic credential therefore reflected it into mapped responses
and, over a real broker round-trip, onto the wire. This does not prove a
supported provider leaks real keys — it proves the boundary lacked a verified
redaction policy, which Phase 5 had overstated as closed.

## Before-fix reproduction

New `apps/desktop/tests/unit/error-redaction.test.ts` (synthetic secret
`sk-sentry-phase5-redaction-synthetic-only-001`, never a credential) run
against unmodified production code: 8 failed / 4 passed.

- Seven failures: the `toSafeError` boundary did not exist (mapping-level
  redaction impossible).
- One wire-level failure with captured bytes: broker error frame
  `{"code":"PROVIDER_ERROR","message":"upstream 500 with key
sk-sentry-phase5-redaction-synthetic-only-001"}`.
- Four passes pinning existing good behavior (uncoded-path cap, safe
  application error preserved, unexpected-type fallback, presence-only
  diagnostics).

## Changed production files

- `apps/desktop/src/main/desktop-command-router.ts`: new shared `toSafeError()`
  (validated codes `/^[A-Za-z0-9_]{1,100}$/` else `DESKTOP_ERROR`; nested-`Error`
  unwrap; one 1000-char cap on every branch; safe fallbacks); `toRouterError()`
  delegates (signature kept); `CommandRouterHooks.redactErrorText` added.
- `apps/desktop/src/main/services/provider-credentials.ts`: new
  `redactSecretsFromText()` — exact known secret-lane values (memory + env,
  length >= 8), `[REDACTED]` substitution; values never leave the process.
- `apps/desktop/src/main/services/desktop-service.ts`: `sanitizeError()`
  delegates to the shared core; RPC fan-out errors scrubbed with the
  service-owned redactor; public `redactSecretsFromText` passthrough.
- `apps/desktop/src/main/ipc.ts`: failures map with the hooks redactor.
- `apps/desktop/src/main/cli-server.ts`: `redactErrorText` option; dispatch
  catch uses the shared core (was: unbounded codes, 2000 cap).
- `apps/desktop/src/main/boot-failure.ts`: fatal-screen message capped at 1000.
- `apps/desktop/src/main/index.ts`: production redactor wired into IPC hooks
  and CLI server; boot fatal message scrubbed with credentials.
- `apps/desktop/src/main/bootstrap.ts`: config-push failure warning scrubbed.

## Security policy

- Trust boundary, not prefix patterns: exact known-value scrubbing is
  format-agnostic; no API-key regex decides anything.
- Stable application codes pass through unchanged (existing clients keep
  their contract); malformed/oversized codes fall back to `DESKTOP_ERROR`.
- Known safe messages stay actionable and byte-identical; untrusted text is
  scrubbed-then-capped, never reflected verbatim with secrets.
- A failing scrubber never breaks mapping (cap still bounds).
- No credential-storage redesign, no plaintext fallback, no new exposure
  surface: scrubbing happens in main-process memory with values already there.
- Short secrets (< 8 chars) are not scrubbed (documented residual); real
  provider keys are far longer. Boot errors (host/runtime startup, no
  provider-secret path demonstrated) are capped; render-site scrubbing
  applied where credentials are in scope.

## Test matrix

All in `error-redaction.test.ts` against real functions (plus a real broker
socket round-trip and the composed dispatch path): uncoded, coded,
nested-overlong, long-cap, malformed-code set, safe-app preserved, timeout
classification, auth guidance, unexpected types, IPC-mapped, CLI-wire,
diagnostics presence-only. Existing suites pinning prior contracts
(router, CLI broker, boot-failure, credential diagnostics, IPC contract,
desktop service) run unmodified.

## Before/after assertions

- Before: 8 failed / 4 passed (secret on the wire; boundary absent).
- After: 12/12 pass; full desktop suite 48 files / 358 passed / 2 skipped.

## Validation results

- Standard gates (correction worktree): `pnpm install` PASS;
  `repository:check` / `format:check` PASS; desktop `tsc` + `eslint` on all
  touched files PASS; full desktop suite 48 files / 358 passed / 2 skipped;
  error-surface group (redaction, IPC contract/dispatch, CLI server/broker,
  boot-failure, desktop service, credential diagnostics, secure credentials,
  secret surface) 82/82.
- Full `pnpm test` / `build` / `distribution:test`: reported in the delivery
  message (required CI adjudicates concurrently-loaded flakes per the Phase 5
  characterization: environmental trust on Windows, rare contention
  intermittents, all solo-green).
- Exact-candidate real sandbox (prepared WSL2 Ubuntu, node v22.23.2, systemd
  user manager running): 8/8 real transient-unit trust tests PASS against
  WSL clone at `3c31559` (this branch's docs commit; sandbox surface
  untouched by this task — verifier/desktop-runtime code identical to the
  audited baseline; later commits docs-only). Clone status clean.
- PR-head CI + distribution workflows: reported in the delivery message.

## Follow-up hardening (fail-closed redaction, async sanitization, IPC boundary)

A later review found three residual gaps in the merged correction; all are
fixed on branch `fix/v1-error-boundary-final-hardening` (this document extended
rather than rewritten).

1. **Fail-closed redaction.** `safeErrorMessage` kept the original text when
   the scrubber threw, and crashed (`slice` of `undefined`) when it returned
   a non-string. Both reproduced with the synthetic secret (secret retained;
   mapping threw). Now a throwing/misbehaving scrubber yields the fixed
   message `Desktop operation failed` with the validated code preserved;
   mapping itself never throws. The same fail-closed shape was applied to
   the service redactor passthrough (now propagates into the shared core),
   the index hook (no swallowing catch), and the bootstrap push-warning
   catch (fixed fallback).
2. **Async sanitization.** Service `call()` only caught synchronous throws;
   async RPC rejections bypassed it (reproduced: secret-bearing rejection
   reached the caller raw). Now both paths map through the identical
   sanitizer; successes pass through untouched (same promise chain shape,
   no retries, no lifecycle change).
3. **Registered IPC boundary.** The matrix tested dispatch-then-map manually;
   new tests capture the real `ipcMain` handler via `registerDesktopIpc()`
   with a mocked Electron bridge: failing service + secret, failing
   redactor, success passthrough, and unwired-handler bounds are all
   asserted on the actual response objects.

Regression: `error-redaction.test.ts` now 19 tests (4 pre-existing pins + 15
new/strengthened), all green; full desktop suite 48 files green with no
modified unrelated assertions.

## Outstanding host acceptance

- Real DPAPI/keyring acceptance for this candidate: OWNER ACCEPTANCE REQUIRED.
- Packaged launch/rollback: OWNER ACCEPTANCE REQUIRED.
- Native CachyOS, clean Windows VM, funded providers: unchanged from Phase 5
  (ENVIRONMENT UNAVAILABLE / OWNER ACCEPTANCE REQUIRED).

## Compatibility impact

- Renderer/CLI error contract preserved: same `{ok, error:{code,message}}`
  shapes; same stable codes; same actionable safe messages byte-for-byte.
- Only behavioral deltas: previously unbounded nested messages now capped;
  malformed codes now fall back; secret-bearing text scrubbed where the
  production redactor is wired (all production paths). Unwired direct uses
  of `toRouterError` keep prior bounds semantics plus the nested-cap fix.
- No QA, adapter, persistence, or schema changes.
