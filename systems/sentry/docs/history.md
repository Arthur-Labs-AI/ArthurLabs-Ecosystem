# Historical documentation

Current user and maintainer instructions are in the [documentation index](README.md).
Historical preparation reports and screenshots are preserved in the immutable
[v1.0.0 source tree](https://github.com/Mert1026/Sentry/tree/v1.0.0), rather than mixed
with current instructions. Removing these files from the development tree does
not remove their Git history, change the published tag or replace release assets.

The records retain their original source, platform and test scope. Historical
FAIL, DEFERRED and UNVERIFIED findings remain as recorded; archiving does not
turn them into passes. In particular, original-beta credential rollback failed;
Recovery Option A applies only to its tested historical Windows/I1 pair and
same-account/machine/DPAPI boundaries. Native recovery, clean-machine provisioning
and real elevated compaction are not inferred from prepared-host or mocked checks.
See the maintained [recovery decision](releases/v1-recovery-policy-decision.md)
and [security model](security/V1_THREAT_MODEL.md).

## Release preparation and acceptance

- [docs/releases/V1_ACCEPTANCE_CHECKLIST.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/V1_ACCEPTANCE_CHECKLIST.md)
- [docs/releases/V1_RC_READINESS_CHECKLIST.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/V1_RC_READINESS_CHECKLIST.md)
- [docs/releases/V1_ROADMAP.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/V1_ROADMAP.md)
- [docs/releases/deepseek-persistent-shell-evidence-fix.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/deepseek-persistent-shell-evidence-fix.md)
- [docs/releases/local-fixes-and-storage-cleanup.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/local-fixes-and-storage-cleanup.md)
- [docs/releases/native-linux-large-import.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/native-linux-large-import.md)
- [docs/releases/project-removal-local-review.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/project-removal-local-review.md)
- [docs/releases/v0.1.0-beta.1-validation.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v0.1.0-beta.1-validation.md)
- [docs/releases/v0.1.0-beta.1.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v0.1.0-beta.1.md)
- [docs/releases/v1-beta-rollback-credential-proposal.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-beta-rollback-credential-proposal.md)
- [docs/releases/v1-cachyos-rc1-smoke-guide.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-cachyos-rc1-smoke-guide.md)
- [docs/releases/v1-g10-recovery-cachyos-handoff.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-g10-recovery-cachyos-handoff.md)
- [docs/releases/v1-owner-acceptance-c1-d250e4c.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-owner-acceptance-c1-d250e4c.md)
- [docs/releases/v1-owner-acceptance-cachyos-handoff.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-owner-acceptance-cachyos-handoff.md)
- [docs/releases/v1-owner-acceptance-execution.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-owner-acceptance-execution.md)
- [docs/releases/v1-owner-acceptance-results.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-owner-acceptance-results.md)
- [docs/releases/v1-owner-acceptance-w1-d250e4c.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-owner-acceptance-w1-d250e4c.md)
- [docs/releases/v1-owner-acceptance.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-owner-acceptance.md)
- [docs/releases/v1-owner-functional-acceptance-2026-10-13.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-owner-functional-acceptance-2026-10-13.md)
- [docs/releases/v1-owner-run-01M4T9XG-acceptance.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-owner-run-01M4T9XG-acceptance.md)
- [docs/releases/v1-phase-1-validation.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-1-validation.md)
- [docs/releases/v1-phase-2-validation.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-2-validation.md)
- [docs/releases/v1-phase-3-final-polish.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-3-final-polish.md)
- [docs/releases/v1-phase-3-validation.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-3-validation.md)
- [docs/releases/v1-phase-4-credential-diagnostic-validation.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-4-credential-diagnostic-validation.md)
- [docs/releases/v1-phase-4-final-acceptance.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-4-final-acceptance.md)
- [docs/releases/v1-phase-4-packaging-assessment.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-4-packaging-assessment.md)
- [docs/releases/v1-phase-4-validation.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-4-validation.md)
- [docs/releases/v1-phase-5-2-g10-recovery-validation.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-5-2-g10-recovery-validation.md)
- [docs/releases/v1-phase-5-3-cachyos-operator.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-5-3-cachyos-operator.md)
- [docs/releases/v1-phase-5-3-cachyos-results.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-5-3-cachyos-results.md)
- [docs/releases/v1-phase-5-3-candidate-lock.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-5-3-candidate-lock.md)
- [docs/releases/v1-phase-5-3-final-host-acceptance.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-5-3-final-host-acceptance.md)
- [docs/releases/v1-phase-5-3-funded-qa.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-5-3-funded-qa.md)
- [docs/releases/v1-phase-5-3-owner-credential-observation.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-5-3-owner-credential-observation.md)
- [docs/releases/v1-phase-5-error-redaction-correction.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-5-error-redaction-correction.md)
- [docs/releases/v1-phase-5-validation.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-5-validation.md)
- [docs/releases/v1-phase-6-0-rc-readiness.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-6-0-rc-readiness.md)
- [docs/releases/v1-phase-6-1-rc-cut-verification.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-6-1-rc-cut-verification.md)
- [docs/releases/v1-phase-6-2-windows-transition.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-6-2-windows-transition.md)
- [docs/releases/v1-phase-6-3-windows-rc-freeze.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-6-3-windows-rc-freeze.md)
- [docs/releases/v1-phase-6-4-release-activation.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-6-4-release-activation.md)
- [docs/releases/v1-phase-6-5-wsl-helper-hardening.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-6-5-wsl-helper-hardening.md)
- [docs/releases/v1-phase-6-6-stable-readiness.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-6-6-stable-readiness.md)
- [docs/releases/v1-post-merge-acceptance-c78faa7.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-post-merge-acceptance-c78faa7.md)
- [docs/releases/v1-pre-rc-acceptance-preparation.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-pre-rc-acceptance-preparation.md)
- [docs/releases/v1-pre-rc-automated-receipt.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-pre-rc-automated-receipt.md)
- [docs/releases/v1-provider-credential-persistence-validation.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-provider-credential-persistence-validation.md)
- [docs/releases/v1-rc-versioning-plan.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-rc-versioning-plan.md)
- [docs/releases/v1-windows-bootstrap-mode-fix.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-windows-bootstrap-mode-fix.md)
- [docs/releases/v1.0.0-rc.1.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1.0.0-rc.1.md)
- [docs/releases/windows-wsl-space-investigation.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/windows-wsl-space-investigation.md)
- [docs/releases/wsl-compaction-lock-fix.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/wsl-compaction-lock-fix.md)
- [docs/releases/wsl-reclamation-local-review.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/wsl-reclamation-local-review.md)

## Architecture phase records

- [docs/architecture/deferred-gates.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/deferred-gates.md)
- [docs/architecture/phase-1.1.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-1.1.md)
- [docs/architecture/phase-1.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-1.md)
- [docs/architecture/phase-2-1.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-2-1.md)
- [docs/architecture/phase-2-2.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-2-2.md)
- [docs/architecture/phase-2.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-2.md)
- [docs/architecture/phase-3-1-1.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-3-1-1.md)
- [docs/architecture/phase-3-1.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-3-1.md)
- [docs/architecture/phase-3.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-3.md)
- [docs/architecture/phase-4-1.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-4-1.md)
- [docs/architecture/phase-4-2.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-4-2.md)
- [docs/architecture/phase-4-test-history.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-4-test-history.md)
- [docs/architecture/phase-4.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-4.md)
- [docs/architecture/phase-5.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-5.md)
- [docs/architecture/phase-6.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-6.md)
- [docs/architecture/phase-7-closure.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-7-closure.md)
- [docs/architecture/phase-7.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-7.md)
- [docs/architecture/phase-8-agent-telemetry.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-8-agent-telemetry.md)
- [docs/architecture/phase-8-desktop-contract.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-8-desktop-contract.md)
- [docs/architecture/phase-8-handoff.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-8-handoff.md)
- [docs/architecture/phase-8-ui.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/phase-8-ui.md)
- [docs/architecture/v1-phase-1-assessment.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/architecture/v1-phase-1-assessment.md)

## Development transition and beta onboarding

- [docs/beta/getting-started.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/beta/getting-started.md)
- [docs/development/branch-cleanup-2026-10-15.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/development/branch-cleanup-2026-10-15.md)
- [docs/development/dev-branch-hardening-validation.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/development/dev-branch-hardening-validation.md)
- [docs/development/dev-branch-transition.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/development/dev-branch-transition.md)

## Historical screenshots

- [docs/releases/assets/v1-phase-3-active.png](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/assets/v1-phase-3-active.png)
- [docs/releases/assets/v1-phase-3-compact.png](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/assets/v1-phase-3-compact.png)
- [docs/releases/assets/v1-phase-3-empty.png](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/assets/v1-phase-3-empty.png)
- [docs/releases/assets/v1-phase-3-finding.png](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/assets/v1-phase-3-finding.png)
- [docs/releases/assets/v1-phase-3-loading.png](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/assets/v1-phase-3-loading.png)
- [docs/releases/assets/v1-phase-3-offline.png](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/assets/v1-phase-3-offline.png)
- [docs/releases/assets/v1-phase-3-partial.png](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/assets/v1-phase-3-partial.png)
- [docs/releases/assets/v1-phase-3-polish-after-activity.png](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/assets/v1-phase-3-polish-after-activity.png)
- [docs/releases/assets/v1-phase-3-polish-after-checking.png](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/assets/v1-phase-3-polish-after-checking.png)
- [docs/releases/assets/v1-phase-3-polish-after-stages.png](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/assets/v1-phase-3-polish-after-stages.png)
- [docs/releases/assets/v1-phase-3-polish-before-activity.png](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/assets/v1-phase-3-polish-before-activity.png)
- [docs/releases/assets/v1-phase-3-polish-before-checking.png](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/assets/v1-phase-3-polish-before-checking.png)
- [docs/releases/assets/v1-phase-3-polish-before-stages.png](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/assets/v1-phase-3-polish-before-stages.png)
- [docs/releases/evidence/provider-credentials-5207288-restart.png](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/evidence/provider-credentials-5207288-restart.png)
- [docs/releases/evidence/provider-credentials-c78faa7-restart.png](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/evidence/provider-credentials-c78faa7-restart.png)
- [docs/releases/evidence/w1-d250-environment.png](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/evidence/w1-d250-environment.png)

## Removed duplicate redirects

- [docs/private-beta/quickstart.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/private-beta/quickstart.md)
- [docs/private-beta/setup.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/private-beta/setup.md)
- [docs/private-beta/troubleshooting.md](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/private-beta/troubleshooting.md)

## Agent operational history

Agent instructions and .superharness remain active. Their original pre-release
[handoff](https://github.com/Mert1026/Sentry/blob/v1.0.0/.superharness/handoff.md),
[ledger](https://github.com/Mert1026/Sentry/blob/v1.0.0/.superharness/ledger.md) and
[task status](https://github.com/Mert1026/Sentry/blob/v1.0.0/.superharness/task-status.md)
remain available without rewriting earlier failure evidence.
