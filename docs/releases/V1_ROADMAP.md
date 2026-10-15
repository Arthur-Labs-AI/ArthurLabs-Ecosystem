# Sentry v1.0.0 roadmap

Released baseline: `v0.1.0-beta.1`. Preserve the working independent OpenCode,
DeepSeek and GLM system throughout. This roadmap is sequencing, not permission
to implement later phases or publish a release. Each phase is a bounded PR
with owner review and accurate validation under the
[branch policy](../development/branching.md). The
[architecture contract](../architecture/v1-pipeline.md) applies to every phase.

> Branching transition (integrated via owner-merged PR #9, 2026-10-12):
> completed phases merged into `main` under the old trunk policy (their PR
> records stand as written). New work targets `dev`: Phase 5 will branch from
> approved `origin/dev` and open its PR to `dev`. See
> [dev-branch-transition](../development/dev-branch-transition.md).

## Phase 6.3 — Windows release freeze and final integration verification

Initial v1 target: **Windows 11 x64 with WSL2**, Ubuntu preferred. Linux runtime,
systemd/bubblewrap isolation and shared security tests remain required. Native
Desktop is **DEFERRED — FUTURE NATIVE LINUX RELEASE**; its implementation and
[unresolved import evidence](native-linux-large-import.md) remain intact.

PRs #23/#24/#25 are owner-merged into dev c6d4769. Current exact-source identity,
local/hosted gate results, private archive and remaining work are in the
[Phase 6.3 freeze handoff](v1-phase-6-3-windows-rc-freeze.md). The
[Phase 6.4 owner exception](v1-phase-6-4-release-activation.md) authorized creation
of `release/v1.0.0-windows` at exact c6d4769 despite upload-only quota failure.
That branch is now active. Source/security verification, trusted delivery and
official publication authorization remain separate gates. Focused release
correction/documentation PRs target that branch; only the owner merges. Do not start the native feature branch until after Windows publication
and a fresh approved shared-source selection.

The [Phase 6.2 receipt](v1-phase-6-2-windows-transition.md) remains attributed
historical large-import evidence. Recovery A remains adopted for corrected
historical Windows/I1 source c78faa7; original-beta G10 stays FAIL. Official cut,
tag, release, public assets and main promotion require separate authorization.

## Phase 1 — Foundation and architectural cleanup

- **Objective:** align development policy, documentation and presentation with
  immutable snapshots and independent agents.
- **Expected changes:** branching/PR guidance, architecture assessment/contract,
  retired pipeline text cleanup, graph/compatibility regressions and this roadmap.
- **Acceptance:** bounded PR to main; supported automated gates pass; unavailable
  target/security checks disclosed; owner work, beta version, historical data,
  issues/retests and all three harnesses preserved. No automatic PR merge.
- **Dependencies:** approved origin/main, current CI and beta acceptance record.
- **Risks:** accidentally removing historical dependencies or treating generic
  CI as real-host/provider acceptance; private-plan protection is procedural.
- **Branch:** `codex/v1-phase-1-cleanup` (current task).

## Phase 2 — Three-agent reliability

- **Objective:** make existing execution reliable across success, failure and restart.
- **Expected changes:** only reproduced defects in timeouts, provider errors,
  cancellation, partial completion, child disposal, crash recovery and persistence.
- **Acceptance:** deterministic failure/recovery regressions; each selected agent
  has an accurate terminal state and retains valid output; cancellation settles
  owned processes; restart preserves history and unlocks stale work; prepared
  Windows/WSL and CachyOS hosts repeat three-agent acceptance with funded providers.
- **Dependencies:** reviewed Phase 1 contract, reproducible fixtures, prepared
  hosts and owner-controlled provider credentials/credit for live checks.
- **Risks:** orphaned processes, duplicate paid runs, lost partial evidence,
  misleading transport errors, provider-version drift. Review the separate
  uncommitted DeepSeek provider-error patch independently before including it.
- **Branch:** `codex/v1-runtime-reliability`.
- **Progress (2026-10-09):** reproduced and fixed request identity association
  under real run/retest concurrency, cancellation during adapter creation, and
  structured DeepSeek provider failures. Added selected-agent and real subprocess
  crash/reconnect regressions; WSL full suite passed 1,085 tests with 16 skips,
  including all eight real sandbox trust cases. See
  [Phase 2 validation](v1-phase-2-validation.md). Owner review/integration and
  fresh supported-host/live-provider acceptance remain; this is not phase closure.

## Phase 3 — Desktop usability

- **Objective:** make progress, results and failures easy to understand.
- **Expected changes:** focused improvements to agent progress, result/evidence
  inspection, error handling, reporting and navigation using the existing state.
- **Acceptance:** owner-reviewed rendered UI on both hosts; Full/Targeted start,
  per-agent inspection, cancellation, history and JSON/log export are clear and
  functional; no fabricated stages, confidence or telemetry; accessibility and
  existing IPC/security regressions pass.
- **Dependencies:** reliable Phase 2 lifecycle and agreed usability priorities.
- **Risks:** rendering derived state as authoritative, obscuring partial failure,
  losing attribution or navigation to retained issue/retest records.
- **Branch:** `codex/v1-desktop-improvements`.
- **Progress (2026-10-10):** owner-merged Phase 2 baseline `9da3cbe`, merge CI
  38040773408 PASS. Bounded renderer changes reconcile canonical snapshots after
  observed reconnect, keep cached reports readable offline, reject stale hint
  replacement, show all selected agents and clarify observed stages and partial
  results. Deterministic regressions and Windows Electron fixture screenshots
  are in [Phase 3 validation](v1-phase-3-validation.md). Draft PR/exact-head CI
  and owner review precede integration. Direct evidence drill-down, broader
  history/accessibility work, dead-process automatic reconnect and fresh target
  acceptance remain; this is not complete Phase 3 closure.
- **Final polish (2026-10-12):** PR #4 integrated at `c07c76d`; main CI
  38213233386 PASS. New `fix/v1-desktop-status-truth` correction distinguishes
  initial Checking runtime from confirmed offline, categorizes generic output
  as Message and labels missing AgentRun milestones Not observed. Waiting/Not
  started placeholders, explicit completion, canonical reconnect and cached
  reports are preserved. See [final polish validation](v1-phase-3-final-polish.md)
  for regression, rendered before/after and exact-commit CI evidence. Native
  CachyOS/live-provider acceptance, compact accessibility and automatic dead-runtime
  recovery remain unverified/deferred; this does not close Phase 3.

## Phase 4 — Installation and distribution

- **Objective:** reproducible fresh installation and versioned updates.
- **Expected changes:** Windows 11/WSL2 and CachyOS packaging, prerequisites,
  install/update diagnostics and distribution documentation; select artifact
  formats based on tested host needs rather than promising unbuilt installers.
- **Acceptance:** clean-machine install, repeated setup, launch/handshake,
  graceful maintenance refusal, upgrade from beta and documented recovery on
  both supported hosts; actual distributed artifacts tested and traceable to SHA.
- **Dependencies:** stable runtime/UI, target hosts, distribution/signing decisions
  and access to the private repository or approved delivery channel.
- **Risks:** native dependencies, systemd/sandbox prerequisites, platform package
  changes, signing/access constraints, updates during active work or dirty trees.
- **Branch:** `codex/v1-release-packaging`.
- **Progress (2026-10-12):** real unsigned Windows ZIP and CachyOS-targeted Linux
  archive built/extracted with version/full-SHA manifests, self-contained Desktop,
  online Linux bootstrap and atomic verified runtime activation/rollback. Actual
  Windows packaged Electron/WSL smoke and synthetic published-beta history reopen
  passed; full WSL suite 1,155 PASS / 16 skips including real trust 8/8. See
  [Phase 4 validation](v1-phase-4-validation.md) and [installation guide](../setup/distribution.md).
  Native CachyOS acceptance is ENVIRONMENT UNAVAILABLE; clean Windows provisioning,
  real encrypted-settings migration and remaining supported-host acceptance are
  outstanding. Windows full-suite snapshot timeout is disclosed separately from
  its unchanged focused pass. Draft PR/exact-head CI and owner review precede
  integration; this is a distribution foundation, not Phase 4 closure.
- **Final hardening follow-up (2026-10-12):** PR #6 merged at `8ff4c51`, main CI
  38249464643 PASS. New `fix/v1-phase-4-release-hardening` reproduces and corrects
  packaged early startup failure and unbounded graceful-control invocation, with
  13 lifecycle regressions. Demonstrated acceptance blockers also required
  preserving Electron's explicit profile directory and awaiting Electron readiness
  before encrypted credential load, while keeping the default beta location.
  Exact d934e67 Windows/Linux archives and real prepared-Windows/WSL beta history
  plus DPAPI credential continuity passed. Native Windows concurrent full-suite
  timing failures remain disclosed, with unchanged focused reruns passing. Fresh exact-implementation archives, available-host acceptance,
  the initial test-profile mistake/cleanup, encrypted-settings results and
  remaining gates are recorded in [final acceptance](v1-phase-4-final-acceptance.md)
  and [draft PR #7](https://github.com/Mert1026/Sentry/pull/7). Native CachyOS,
  clean Windows provisioning and remaining physical-host maintenance/rollback
  acceptance are outstanding. Phase 4 remains implemented with outstanding
  supported-host acceptance; Phase 5 has not started.

- **Credential diagnostic correction (2026-10-12):** PR #7 merged at `89365b9`,
  post-merge CI 38275423611 PASS. `fix/v1-credential-status-diagnostic` supplies
  Electron safeStorage after readiness, distinguishes unavailable/unreadable
  storage from missing credentials, preserves the launcher boolean protocol and
  avoids disturbing an existing Desktop. The reproduced failures are corrected:
  21 diagnostic cases and 49 focused Desktop cases PASS. Exact `65d2b32` unsigned
  Windows/Linux artifacts and the detailed gate/host results are recorded in
  [credential diagnostic validation](v1-phase-4-credential-diagnostic-validation.md)
  and [draft PR #8](https://github.com/Mert1026/Sentry/pull/8). Local concurrent
  full-suite failures remain disclosed; the uncached serial WSL full suite passed
  1,179 tests / 16 skips, including real sandbox trust 8/8. Native CachyOS,
  clean Windows provisioning and actual active-execution/recovery acceptance
  remain outstanding. Phase 4 is not closed and Phase 5 has not started.

## Phase 5 — Security and testing

Phase5.3: PR19 is owner-merged at dev `5c68491`; post-merge CI38451742628
SUCCESS in all3 jobs. [Final host preparation](v1-phase-5-3-final-host-acceptance.md)
preserves exact I1 bytes after direct executable-source comparison, supplies a
unified native operator package/partial template, explicit recovery decision and
owner-controlled credential/funded plans, and records newly executed Windows
observations. Native/clean-host/D06/live-provider/owner-profile acceptance and
policy adoption remain open. Phase6 NOT AUTHORIZED. Earlier entries are historical.

Phase5.2: PR18 is owner-merged at dev `8bbe8ba`, post-merge CI38439418803
SUCCESS. [Corrected-binary recovery validation](v1-phase-5-2-g10-recovery-validation.md)
demonstrates Windows G10-R with populated beta history, actual JSON/log exports,
DPAPI credentials, preferences and repeated restart/restore. Original-beta G10
remains historical P1 FAIL. This is a validated proposed recovery candidate
pending owner adoption, not a replacement rollback policy. Native CachyOS and
remaining release/owner gates stay open; Phase6 NOT AUTHORIZED.

Current consolidation (2026-10-13): owner-merged PR17 credential correction and
PR16 owner Full3/3 evidence are integrated at `c78faa7`; post-merge CI38411670558
SUCCESS. [Phase5.1](v1-post-merge-acceptance-c78faa7.md) records fresh integrated
verification, distinct exact-source unsigned artifacts and disposable Windows
DPAPI acceptance. Earlier phase progress below is historical. Native/clean-host,
funded matrix, real-profile and historical beta G10 gates remain open; Phase6
is NOT AUTHORIZED. No additional production correction was justified.

- **Objective:** substantiate isolation and regression claims on real hosts.
- **Expected changes:** close demonstrated sandbox/credential isolation gaps,
  extend meaningful regressions and record reproducible real-host acceptance.
- **Acceptance:** all required CI gates pass; actual systemd mount/replay and
  credential/peer-workspace isolation proofs run; full regression and manual
  acceptance records on Windows/WSL and CachyOS; no hidden quarantine or waived
  security gate presented as passed. Review exported diagnostics for secrets.
- **Dependencies:** candidate packaging, prepared sandbox-capable hosts and
  explicit owner scope for paid-provider and security acceptance runs.
- **Risks:** mock-only security claims, sandbox capability differences, secret
  leakage in artifacts, historical compatibility or upgrade coverage gaps.
- **Branch:** `codex/v1-security-testing` (based on approved `origin/dev`, PR targets `dev`).
- **Progress (2026-10-13):** threat model (`docs/security/V1_THREAT_MODEL.md`) and
  validation report (`docs/releases/v1-phase-5-validation.md`) written; two
  bounded corrections (strict credential entry precision, event-silence test
  margins); real systemd-mount trust 8/8 on prepared WSL Ubuntu; packaged
  launch/rollback, real-profile credentials, and funded QA remain
  owner-acceptance items. No P0/P1 production defects reproduced.
- **Follow-up (error redaction):** `fix/v1-error-redaction-hardening` unifies Desktop
  error mapping (`toSafeError`: validated codes, consistent 1000 cap, exact
  known-value scrubbing on IPC/CLI/service/boot-warning paths) with a wire-level
  regression matrix; see `docs/releases/v1-phase-5-error-redaction-correction.md`.
- **Follow-up (final hardening):** `fix/v1-error-boundary-final-hardening` makes
  scrubbing fail closed (fixed fallback, never raw text), sanitizes async RPC
  rejections identically to sync throws, and covers the registered IPC handler;
  same correction record extended.

## Phase 6 — Release candidate

**Preparation authorized October13,2026; official cut/tag/publication not
authorized.** PR20 is owner-merged at devc103509 with post-mergeCI38460193028
SUCCESS/all3. The [owner reports normal functionality](v1-owner-functional-acceptance-2026-10-13.md)
working on Windows/WSL2 and native CachyOS, including independent agents,
selection and Full/Targeted QA. Feature development is frozen. The
[Phase6.0 report](v1-phase-6-0-rc-readiness.md),
[version plan](v1-rc-versioning-plan.md), [draft notes](v1.0.0-rc.1.md) and
[simplified RC checklist](V1_RC_READINESS_CHECKLIST.md) define bounded preparation.
No retrospective recordings or blanket paid replay are required. Historical
case results/build-attribution limits remain; recovery-policy adoption was completed October 14 for Windows/I1; exact-source
owner RC authorization remains pending.

- **Objective:** freeze features and stabilize an explicit v1.0 candidate.
- **Expected changes:** owner-approved RC versioning, migration/upgrade tests,
  final bug fixes, release notes and artifact/checksum validation. No unrelated
  features after freeze; do not rewrite the published beta tag.
- **Acceptance:** exact candidate SHA passes CI and applicable real-host gates;
  upgrade from beta preserves projects/history/evidence/issues/retests; rollback
  is documented; owner approves the immutable annotated RC tag and actual assets.
- **Dependencies:** Phases 2–5 acceptance and owner feature-freeze authorization.
- **Risks:** last-minute scope expansion, version/artifact mismatch, data migration
  loss, environment/provider differences and regression after acceptance.
- **Branch:** `release-prep/v1.0.0-rc.1` for this review; the Phase 6.2 `release/v1.0.0-windows` branch follows owner merge of the scope PR.

## Phase 7 — Sentry v1.0.0

- **Objective:** publish the explicitly approved stable distribution.
- **Expected changes:** final release notes, verified distribution assets and
  checksums, approved immutable annotated `v1.0.0` tag and stable publication.
- **Acceptance:** owner approves the exact final commit and publication; CI and
  supported-host acceptance are recorded for those bytes; installation/update
  guidance and known limitations match the shipped product. Confirm published
  assets resolve to the approved tag. No automatic publication from Phase 1.
- **Dependencies:** accepted RC, final owner release authorization, tested assets
  and completed [release checklist](RELEASE_CHECKLIST.md).
- **Risks:** publishing untested binaries, changing approved bytes, accidentally
  exposing private data or overstating platform/security/provider validation.
- **Branch:** `release/v1.0.0`.
