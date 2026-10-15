# Phase 5 validation report — Security & Testing

Finalization follow-up (2026-10-13): see [pre-RC preparation](v1-pre-rc-acceptance-preparation.md)
for remaining error-access/IPC-fidelity corrections, reproduced fatal-screen
scrubbing correction and new verification receipts. Historical results below
retain their original source identities; they do not establish acceptance for
the new candidate. Use the [owner runbook](v1-owner-acceptance.md) and
[results template](v1-owner-acceptance-results.md) for actual supported hosts.
Phase 5 acceptance remains open; Phase 6 is not authorized.

Date: 2026-10-13. Branch: `codex/v1-security-testing`.
Threat model: `docs/security/V1_THREAT_MODEL.md` (read first).

## Baseline

- Starting approved `dev`: `d628837cd876a9787409759239040ff5ffa2d414` (PR #10 merge).
- `main`: `4fd2be9fa3b17370841dbb1d2f0422a2150c62d8` (unmoved; verified before, during, and after).
- Post-merge `dev` CI (run 38301466871): `quality`, `launcher (windows, no WSL)`,
  `launcher (linux, no CachyOS)` — all success.
- Beta tag `v0.1.0-beta.1` intact. No provider version, product version, or
  schema changes in this phase (no migration).
- Scope: audit + evidence + two bounded corrections below. No pipeline
  redesign, no new providers, no restored Merger/Verifier orchestration
  (historical compatibility untouched), no automatic retries, no RC tagging.
- Hosts used: Windows 11 (this machine) for fixture suites; WSL2 Ubuntu
  (node v22.23.2, systemd user manager running, pnpm 9.12.3) for real-mount
  sandbox evidence; Ubuntu GitHub Actions via PR CI. No native CachyOS host,
  no clean Windows VM, no paid-provider runs in this phase.

## Threat model

Twelve boundaries assessed against the implementation (see the threat model
for controls and evidence per boundary). Consolidated outcome:

- No P0 reproduced (no exploitable data loss, secret exposure, isolation
  bypass, or unsafe execution).
- No P1 production defect reproduced. F5 real-mount evidence VERIFIED 8/8 on
  prepared WSL Ubuntu; F6/F7 remain OWNER ACCEPTANCE REQUIRED.
- F1 corrected (test margins, no production change). F2 closed by a
  consolidated regression plus one real precision fix (below). F3/F4
  documented as designed/polish with no change.

## Implemented corrections

### C1 — strict credential diagnostic preserves entry-level verdicts (production)

- Original behavior: `ProviderCredentialService.load({ strict: true })` threw
  `Credential store unreadable` for every strict failure — including a single
  undecryptable entry — because the outer catch remapped the inner
  `Credential entry unreadable` throw. Operators could not distinguish a
  broken store from one bad entry; the Phase 4 presence-vs-absence contract
  held (fail-closed), but entry precision was lost.
- Reproduction: new `secret-surface.test.ts` strict test with a wrong-key
  backend — failed before the fix (`expected 'Credential store unreadable' to
contain 'Credential entry unreadable'`).
- Root cause: outer catch classified by errno only, discarding the inner
  verdict.
- Correction: inner strict throws carry `code: 'CREDENTIAL_ENTRY_UNREADABLE'`;
  the outer catch rethrows coded entry verdicts unchanged and only maps
  unclassified failures to the store-level message. Failure stays closed:
  still throws, still claims no absence, still logs no values.
- Regression: `secret-surface.test.ts` (3 tests) green; all 21 pre-existing
  `credential-diagnostic.test.ts` tests green unmodified (no weakening).
- Compatibility: messages unchanged for every previously covered case; only
  the wrong-key/corrupt-entry strict path gains precision. Normal (non-strict)
  boot tolerant path untouched.

### C2 — event-silence drip margins (test-only, no production change)

- Original: drip worker (6 events, 40ms gaps, 240ms span) against a 100ms
  silence window flaked under concurrent and serial Windows load (2 observed
  failures across full-suite runs; passes focused). No wrong terminal state
  ever observed — scheduling jitter near the gap size, not a race.
- Correction: silence window 100ms -> 300ms for the drip leg only (span 360ms
  preserved, so a flat non-sliding clock still kills at 300ms; absolute cap
  scales to 600ms automatically). Silent-worker leg untouched (robust by
  construction). Production `consumeWithTimeout` untouched.
- Regression: repeated focused passes green (3/3 runs, 21/21 files in the
  group); full-suite comparison below.
- Compatibility: test-only; no production, timeout, or protocol change.

## Security results

- Sandbox isolation: 8/8 real systemd-mount trust tests pass on WSL2 Ubuntu
  against pristine `d628837` (each test drives real transient units: host and
  peer markers hidden, work visible, secrets absent from persistence, cwd
  containment, descendant cleanup, shell-escape refusal, missing-tool
  inconclusive-with-warning). Windows/local runs report sandbox-unavailable
  honestly and run the remainder. No `--no-sandbox`, no weakened mounts.
- Workspace containment: per-agent private copies, inert-unsafe links,
  cleanup escape refusal, blocked-link metadata namespace — fixture suites
  green (`workspace`, `snapshot`, `project-manager`).
- Credential privacy: encrypted store round-trip, unavailable-encryption
  refusal, strict/normal diagnostic separation, migration deletion, profile
  isolation, ciphertext-only disk bytes, statuses presence-only, global
  console tripwire on diagnostics, consolidated surface test — all green;
  synthetic credentials only; owner keys never touched.
- Electron/IPC: sandbox+isolation flags source-asserted; strict per-channel
  zod; CLI allowlist excludes secrets/distro/dialogs; reveal allowlist;
  dialog-owned destinations; atomic export writes. Suites green.
- Process ownership: owned-adapter cancel/dispose, cancel-wins races, no
  broad termination (marker-scoped), no duplicate paid runs
  (`RUN_MAY_HAVE_STARTED`), stale-recovery honesty — regressions green.
- Runtime recovery: lease/heartbeat ownership, journal idempotency,
  interrupted-not-fake-cancelled recovery, failed-activation rollback,
  maintenance refusal — regressions green.
- Distribution integrity: adversarial contract tests (tamper, missing,
  unlisted, secrets, SHA/version mismatch, traversal, symlinks) green;
  install/lifecycle/maintenance/beta-history/secure-settings suites green;
  update-channel isolation + ancestry preflight preserved (no changes).
  Unsigned-artifact limitation documented (integrity vs publisher auth).

## Testing

- Default concurrent suite (Windows, this worktree): all packages pass
  except `@qa/run-engine` — 6 verification-trust failures (all `systemd user
tools unavailable` + Windows EBUSY cleanup: capability-environmental) and
  the pre-fix drip timing flake. Post-fix concurrent outcome recorded in the
  gate table below.
- Uncached serial suite (`turbo run test --concurrency=1 --force`, Windows):
  same 6 environmental trust failures + the pre-fix drip flake; everything
  else green (30/37 tasks ok pre-fix baseline pattern).
- Focused: `run-engine.test.ts` + `parallel-execution.test.ts` 21/21 across
  repeated runs post-fix; credential group 44/44; desktop unit suites green.
- Skipped: platform-gated cases (e.g., POSIX-only symlink test on Windows)
  report as skipped, never as passed.
- Capability-dependent: real-mount trust only where systemd mounts work (WSL
  Ubuntu here; unverified-but-honest elsewhere).
- Packaged-app results for this candidate: not executed (no clean VM / native
  host in this phase); fixture-level distribution evidence only.
- Every significant receipt names host + SHA in the gate table.

## Release acceptance

- Windows/WSL (prepared): real-mount 8/8 on WSL Ubuntu for `d628837`;
  packaged Electron launch, handshake, credential continuity, beta history,
  shutdown/recovery on a real host: OWNER ACCEPTANCE REQUIRED (not run).
- Fresh Windows installation: ENVIRONMENT UNAVAILABLE (no disposable VM;
  primary PC never destructively manipulated).
- Native CachyOS: ENVIRONMENT UNAVAILABLE (no native host; Ubuntu CI/WSL not
  presented as CachyOS evidence).
- Paid providers: OWNER ACCEPTANCE REQUIRED (no funded runs triggered;
  fixture/fake-provider coverage only).
- Remaining Phase 4 gates carried forward: packaged acceptance trio above.
- Remaining Phase 5 blockers: none in code — acceptance evidence (F6/F7).

## Conclusion

Phase 5 is **implemented with outstanding owner acceptance**: boundaries
audited with evidence, two bounded corrections regression-backed, real
8/8 sandbox containment proven on prepared WSL Ubuntu, concurrency
characterized honestly (serial + concurrent reported separately), and no
release published or tagged. Remaining before Phase 6: owner acceptance of
packaged launch/rollback (Windows + CachyOS), real-profile credential
continuity (DPAPI/keyring), and funded multi-agent QA on an exact candidate.
Do not begin Phase 6 in this task.

## Gate table

Host A: Windows 11 (this machine). Host B: WSL2 Ubuntu (node v22.23.2,
systemd user manager running, pnpm 9.12.3). Worktree HEAD is the Phase 5
head unless noted (production diff: one service file; test-only otherwise).

- `pnpm install --frozen-lockfile` (A): PASS.
- `pnpm repository:check` (A): PASS. `pnpm format:check` (A): PASS.
- `pnpm lint` (A): PASS (20/20). `pnpm typecheck` (A): PASS (37/37).
- `pnpm build` (A): PASS (20/20). `pnpm distribution:test` (A): PASS.
- `pnpm test` concurrent (A): FAIL, confined — `@qa/run-engine`: 6
  verification-trust failures, every one `systemd user tools unavailable`
  (+ Windows EBUSY fixture cleanup): capability-environmental, honest by
  design; plus rare single-test intermittents in untouched files across
  runs (opencode cancel x2 — fixed by turn-entry sync; CASE C probe x1;
  systemd-probe x1; targeted S114 x1; parallel-timeout x1 historical), each
  green in every solo/serial/focused rerun. Zero failures in changed areas;
  drip green in all runs since the margin fix.
- `pnpm test` serial uncached `--concurrency=1 --force` (A): same 6
  environmental trust failures + the pre-fix drip flake; all else green.
- Focused (A): timing pair 21/21 x4 runs; credential group 44/44;
  opencode pair 39/39; targeted 10/10; surface 3/3; desktop unit suites green.
- Real trust (B, pristine `d628837`, clean status, real transient units):
  8/8 PASS (S50, S52, S56, S16/S63, S40/S69, S26/S67, S57, S54).
- Launcher suites (A, Task A head — untouched in this phase, CI reruns on
  the PR): behavior BEHAVIOR-OK, channels 23/23, safety OK, smoke OK,
  logic 20/20, io-stress OK; `test-desktop-startup.sh` fails on Windows
  git-bash (`setsid` unavailable; files identical to base — pre-existing).
- PR CI (Ubuntu/Windows runners): reported in the delivery message;
  mount-capable lanes adjudicate trust there, fallback stays honest.
