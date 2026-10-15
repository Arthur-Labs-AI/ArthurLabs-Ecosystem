> Historical preparation record, superseded for current release decisions by
> [Phase 6.6 stable readiness](v1-phase-6-6-stable-readiness.md) and
> [v1.0.0 stable notes](v1.0.0.md). Original source/version/hash and test receipts
> below retain their historical scope. No public RC was published.

# Phase6.0 — unsigned RC preparation and readiness

Integration update, October 14, 2026: the owner merged [PR #21](https://github.com/Mert1026/Sentry/pull/21)
into dev at `8a75e9924a41b98351e46255111fdbfed335f1f0`, tree
`417ac8851cf06cda843f4c47b087e826170cc4c8`, identical to reviewed head
`ef6ce35cf0eac9c3bdb0fafc8693f78b125ddfad`. [Post-merge CI](https://github.com/Mert1026/Sentry/actions/runs/38514119610)
completed successfully in all three required jobs; hosted sandbox isolation was
unverified. The [Phase 6.1 receipt](v1-phase-6-1-rc-cut-verification.md) now governs
exact merged-source builds and the owner cut handoff. The remainder of this
document records Phase 6.0's historical preparation baseline and results.
The owner subsequently adopted recovery Option A within its tested Windows/I1
scope on October 14, 2026; see the [decision](v1-recovery-policy-decision.md).
Official RC cut authorization remains pending.

This task prepares a reviewable **1.0.0-rc.1** version transition and release
package under the owner's explicit Phase6.0 preparation authority. Feature
development is frozen. It does not cut/tag/publish an RC, promote main, merge
its own PR, adopt recovery policy or authorize provider spending.

The final GO/NO-GO and exact-head gate results are recorded in this preparation
PR's final verification receipt. With healthy final checks and the remaining
discrete policy/authorization decisions, the recommendation is **CONDITIONALLY
READY**. A missing historical recording is not a new production defect.

## Verified baseline

| Reference                                                                               | Actual full identity / conclusion                                                                       |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| origin/main                                                                             | `4fd2be9fa3b17370841dbb1d2f0422a2150c62d8`                                                              |
| Approved origin/dev                                                                     | `c103509e8f601ef4c4089f9a030711c67348ca32`                                                              |
| dev tree                                                                                | `be19e0c691b785ed6ad643dcbe4dd2dbb7fd9597`                                                              |
| PR20 actual owner merge                                                                 | c103509, merged2026-10-13T20:06:32Z; head `9f690bc9a130615e252dbc0b79f0a7500ece9b5b` reachable from dev |
| [Post-merge CI38460193028](https://github.com/Mert1026/Sentry/actions/runs/38460193028) | COMPLETED/SUCCESS: quality, launcher(windows,noWSL), launcher(linux,noCachyOS)                          |
| Open PRs at preparation baseline                                                        | None                                                                                                    |
| Published release                                                                       | v0.1.0-beta.1 only, immutable historical source `0e5c10cfa80f6385ebfc88a7306b38ce8a12ce38`              |

Fetched origin/pruned and inspected status, worktrees, branches,15-commit history,
tags, merged/open PRs, CI and workflow artifacts. PR20 head and actual merge
have equal trees. Six historical task branches are audited below; none deleted.
Owner's dirty primary checkout remains untouched. The previously clean isolated
task worktree now uses `release-prep/v1.0.0-rc.1` based on approved dev. Configured
Git identity is preserved. `shux contract` is unavailable; task/ledger/handoff are
maintained directly.

## Source freeze, version scope and candidate attribution

Actual complete diffs were inspected for I1→Phase5.2/dev5c68491,
5c68491→Phase5.3/devc103509, and PR20 head→actual merge. Before this preparation,
apps/dependencies/lockfile/distribution implementation/provider-model settings/
migrations/protocol/security implementation match I1. Changes since I1 are
documentation, excluded recovery test utilities and the excluded cancellation
test synchronization correction. This is file/tree comparison, not inference
from commit messages.

This review intentionally changes product version0.1.0-beta.1→1.0.0-rc.1 across
root/Desktop/runtime/CLI metadata, source reporting defaults and launcher labels.
See the [complete version plan](v1-rc-versioning-plan.md). Production diff review
must confirm only those literal/metadata changes: no orchestration, adapter,
security handling, transport, migration or model/SDK behavior changes. Protocol
remains1; Electron36.2.1 and pnpm9.12.3 remain pinned. Dependency-lock SHA256:
`a36aebfc003cd12076ed63613c05b07e6fa416d3c3f52a54d4f86ac3f3e4683a`.

The final preparation commit/tree, actual artifact names/hashes, manifests and
build provenance are locked in the PR final receipt after committed builds.
Root/Desktop/runtime-source full SHA/version/protocol must agree. New RC archives
are unsigned review candidates and never relabelled I1 or official release assets.
Final release bytes must be rebuilt from the eventually authorized exact commit,
including any owner merge's distinct source SHA.

I1 historical physical identity remains source
`c78faa74717b0f430a859730e98c3c4915e7b03f`, tree
`8bbaab4a5d1f7830dcf4ed7b4c40362c62f8d71d`, product0.1.0-beta.1/protocol1.
Its retained Windows SHA256 is
`ec5edec8a6b3f8ef18bafd961e66c59f80669804cc98d30e0cb10ef18c527d1e`;
hosted Ubuntu CachyOS-targeted SHA256 is
`5bd3642ed392607a010078be35885d1cff45db162a2841ee374be228275e89d8`.
[Full manifests/retention](v1-phase-5-3-candidate-lock.md) stand. PR20's separate
beta-version archives from9f690bc remain available in private
[distribution38458750150](https://github.com/Mert1026/Sentry/actions/runs/38458750150),
artifacts11845087776/11844492424 until2026-10-20. They are not RC bytes.

## Owner acceptance and evidence reconciliation

The [October13 owner record](v1-owner-functional-acceptance-2026-10-13.md)
accurately records working normal functionality on Windows/WSL2 and native
CachyOS, independent agents, selection and Full/Targeted QA. Overall designation:
**OWNER-REPORTED FUNCTIONAL ACCEPTANCE**. This materially advances supported-host
functional confidence without invented screenshots, exact build attribution,
backend facts, provider costs or individual case outcomes.

Preserve W1/C1 and Phase5.3 case matrices, Windows G10-R physical receipts,
original G10 FAIL and prior automated evidence. The owner Full3/3 export still
has10 findings/38 evidence,609 validated schema records, warnings and absent
producing Sentry build/archive attribution. Do not reassign it to RC or assume
that all14 combinations ran. No broad paid rerun or retrospective recording is
requested. New exact-RC pairing/identity smoke is a bounded version-transition
check, separate from the already reported normal-function success.

## Recovery disposition

Recommend [Option A](v1-recovery-policy-decision.md): exact compatible corrected
I1 pair plus verified stopped matching data/profile backup, tested Windows
account/machine/DPAPI context and compatible schema. Windows G10-R preserved
populated history/lineage/material, four real JSON/log exports, four synthetic
encrypted keys/preferences, two fresh restarts and repeated restore. Original
beta G10 remains historical P1 FAIL; original-beta executable rollback remains
unsupported for reliable credential availability.

**Adoption is PENDING.** Explicit owner choices: adopt A in its stated scope;
request a separately scoped B; or reject both and retain the recovery release
blocker. Native normal-function acceptance does not prove native G10-R. No
plaintext fallback, automatic schema downgrade or cross-account/keychain
portability; cross-filesystem data/profile replacement is not atomic. Existing
acceptance backup verifier stays fixed to historical beta/I1 identities and is
not silently broadened for RC restoration.

## Verification and security review

Executed early checks: frozen Windows install with unchanged lockfile; new
version-consistency regression RED2/3 under a root-only partial bump, then GREEN3/3
after coherent metadata/title changes; Windows distribution26PASS/25platform
skips out of51; Windows launcher smoke PASS. The added manifest case validates
RC identity and refuses a mixed beta runtime component. Historical fixtures and
existing security assertions remain intact; no check is weakened for a pass.

The final exact-head receipt must include frozen install, hygiene/format/lint/
typecheck/build/diff, full uncached supported suite, Desktop and runtime counts,
distribution/recovery/launcher/credential/security tests, all relevant CI jobs
and both archive builds. Separate actual WSL systemd/bwrap trust is executed
where available; hosted fallback is disclosed as unverified isolation. Any
failure is retained, diagnosed and corrected only with relevant regression
coverage before a successful final recommendation.

Only synthetic disposable profiles/data may be used for new binary smoke.
No real owner credential/profile, raw DB, encrypted store, private source,
unsanitized provider response or identifying host log is committed. Review
source/archive inclusion, full-SHA selection, exact version tuple and unchanged
profile/data paths. Source identity comparison does not transfer earlier
physical results to materially different/newly versioned bytes automatically.

## Branch hygiene

All six remote task tips were verified ancestors of dev with zero unique commits,
merged PRs and no active worktree usage. A search of workflows/launcher/runtime
scripts found no dependency on their names. Original commits and PR receipts
stay reachable from dev. Cleanup remains owner-controlled; nothing was deleted.

| Eligible remote branch                 | Merged PR |
| -------------------------------------- | --------- |
| fix/v1-pre-rc-acceptance-preparation   | 14        |
| fix/v1-provider-credential-persistence | 17        |
| test/v1-owner-acceptance-evidence      | 15/16     |
| fix/v1-post-merge-acceptance           | 18        |
| fix/v1-g10-recovery-acceptance         | 19        |
| test/v1-final-host-acceptance          | 20        |

Do not delete main/dev/current preparation, any active release branch, annotated
tags or historical evidence. No branch deletion or force push is performed.
Existing main/dev protection limitations remain procedural; never claim server
enforcement from unavailable protection APIs.

## Decisions before an official cut

Use the [simplified checklist](V1_RC_READINESS_CHECKLIST.md) and
[draft notes](v1.0.0-rc.1.md). Remaining discrete decisions are recovery policy,
review/acceptance of the version patch and exact artifact/evidence scope, and
explicit authorization of an eventual exact RC commit/cut. Native RC-specific
binary/recovery attribution and other historical failure scenarios remain
unexecuted unless the final receipt supplies them. Owner may accept clearly
stated limitations or request a targeted check for a material risk; no blanket
recording/paid-matrix demand is introduced.

No new current-production P0/P1 blocker has been established by this review.
The unresolved historical rollback disposition is explicit, not documentation
converted to success. Stop after the focused review PR and final GO/NO-GO
receipt. No tag, public asset, main change, policy adoption or RC publication.
