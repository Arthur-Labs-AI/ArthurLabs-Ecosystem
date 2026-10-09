# Sentry v1.0.0 roadmap

Released baseline: `v0.1.0-beta.1`. Preserve the working independent OpenCode,
DeepSeek and GLM system throughout. This roadmap is sequencing, not permission
to implement later phases or publish a release. Each phase is a bounded PR
with owner review and accurate validation under the
[branch policy](../development/branching.md). The
[architecture contract](../architecture/v1-pipeline.md) applies to every phase.

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

## Phase 5 — Security and testing

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
- **Branch:** `codex/v1-security-testing`.

## Phase 6 — Release candidate

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
- **Branch:** `release/v1.0.0-rc.1`.

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
