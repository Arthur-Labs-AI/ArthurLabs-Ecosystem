# Windows v1.0.0-rc.1 readiness checklist

Current scope, October 14, 2026: **Windows 11 x64 with WSL2** (Ubuntu preferred).
Native Linux Desktop: **DEFERRED — FUTURE NATIVE LINUX RELEASE**. Its historical
FAIL/UNVERIFIED results below are preserved and do not automatically block the
Windows release. Shared Linux runtime/security failures still block Windows.

The [Phase 6.2 receipt](v1-phase-6-2-windows-transition.md) is the active evidence
record. The former selected source and checksum below are historical only; a new
exact-source archive is required after owner merge of the scope transition.

| Gate                       | Required disposition before Windows RC authorization                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope integration          | Owner-reviewed scope PR to dev, then actual post-merge CI; no self-merge                                                                                           |
| Windows/shared CI          | quality, Windows launcher/Desktop and Windows release archive pass                                                                                                 |
| Real runtime security      | WSL systemd/bubblewrap trust on a capable host; hosted fallback is not PASS                                                                                        |
| Static/build/full suites   | Actual commands, counts, skips and failures in Phase 6.2 receipt                                                                                                   |
| Windows exact archive      | Full source/tree/version/protocol/lock, archive and manifest SHA256, inventory and extraction                                                                      |
| Windows large GUI import   | Approximately 1 GiB included data, nested source files/exclusions, responsive UI, automatic list refresh, persisted material, reopen/history and graceful shutdown |
| Recovery                   | Option A already adopted October 14 for historical corrected Windows/I1; original-beta G10 remains FAIL                                                            |
| Native Desktop smoke/G10-R | DEFERRED; retained implementation and native import tracker, no native PASS inferred                                                                               |
| Branch separation          | After owner merge only: release/v1.0.0-windows and feature/native-linux-support from approved shared source                                                        |
| Official cut               | Separate explicit owner authorization of exact source/assets/limits and publication; no RC published                                                               |

The [native import tracker](native-linux-large-import.md) remains OPEN. A shared
failure reproduced on Windows requires a separate focused correction PR before
release. No blanket funded-provider replay or owner credential access is needed.

## Historical Phase 6.1 checklist (superseded scope)

### Former v1.0.0-rc.1 cut preparation checklist

Active status, October 14, 2026: **NATIVE IMPORT INVESTIGATION OPEN**. See the
[Phase 6.1 provenance receipt](v1-phase-6-1-rc-cut-verification.md).
Binary input is owner merge `8a75e9924a41b98351e46255111fdbfed335f1f0`, tree
`417ac8851cf06cda843f4c47b087e826170cc4c8`, version `1.0.0-rc.1`, protocol `1`.
This release-preparation PR does not substitute its own later SHA as binary input.

| Gate                           | Current evidence / disposition                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration                    | PASS: PR #21 owner-merged; reviewed and merged trees equal                                                                                                      |
| Selected-source CI             | PASS: [38514119610](https://github.com/Mert1026/Sentry/actions/runs/38514119610), all three required jobs; hosted isolation unverified                          |
| Frozen identity/implementation | PASS: root/Desktop/runtime/CLI versions agree; locks, pins, migrations, protocol, orchestration and security unchanged                                          |
| Static/build gates             | PASS: frozen install, hygiene, format, lint, typecheck, build and diff check on Windows/WSL                                                                     |
| Applicable automated suites    | PASS: WSL 1,236/16 skips, 40 uncached tasks; Windows Desktop 400/2 skips                                                                                        |
| Actual sandbox trust           | PASS: separate WSL systemd trust 8/8, distinct from hosted fallback                                                                                             |
| Distribution/recovery          | PASS: WSL 50/1 skip; Windows 26/25 platform skips; maintenance/launcher smoke PASS                                                                              |
| Exact-source archives          | PASS: both local targets and both hosted jobs in [38514834916](https://github.com/Mert1026/Sentry/actions/runs/38514834916); four separate hashes retained      |
| Archive validation             | PASS: sidecars, external extraction, every inventory checksum and full identity; private retention                                                              |
| Windows exact-RC smoke         | PASS for local ZIP `d224cf09...c51d96`: setup, packaged GUI/IPC/hello/import/history/stop, DPAPI plus two restarts, plaintext absence                           |
| Native exact-RC smoke          | UNVERIFIED: setup helper corrected; follow-up owner report shows connected runtime and large-project import timeout; exact-build attribution/root cause pending |
| Native G10-R                   | UNVERIFIED; normal native functionality is not recovery proof                                                                                                   |
| Recovery policy                | OWNER APPROVED: explicit "i choose A", October 14, 2026; only tested historical Windows/I1 scope and stated boundaries                                          |
| Release notes                  | Final [draft](v1.0.0-rc.1.md) prepared with exact source, installation and limitations                                                                          |
| Official cut                   | PENDING / NOT AUTHORIZED: owner approves full SHA/version/protocol, exact assets/provenance/limits and intended visibility/publication scope                    |

The reported native import failure is under investigation; its exact-build
attribution, cause and severity are unverified. Real 1 GiB manager probes passed
on WSL Node 22/26, and the requested AutoPulse folder imported through packaged
Windows RC GUI/IPC in 32.5 seconds. These do not waive the CachyOS failure. No
broad paid replay is required. Original G10 remains FAIL.
Recovery A is adopted within that scope. No tag, release, official assets, active release branch, main
promotion, self-merge or branch deletion occurred.

**RECOVERY DECISION CLOSED — OFFICIAL RC CUT AUTHORIZATION PENDING.**

## Historical Phase 6.0 preparation checklist

Current authority: **Phase6.0 preparation and feature freeze authorized** by the
owner's October13,2026 instruction. **Official RC cut, tag, main promotion and
publication are NOT AUTHORIZED.** This is the active top-level readiness view;
the extensive [Phase5 checklist](V1_ACCEPTANCE_CHECKLIST.md) remains historical
evidence, not a demand to repeat every successful paid/normal-function scenario.

| Release gate                                 | Evidence / current disposition                                                                                                                               | Remaining action                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Owner confirms both supported platforms work | RECORDED: [OWNER-REPORTED FUNCTIONAL ACCEPTANCE](v1-owner-functional-acceptance-2026-10-13.md), including independent agents, selection and Full/Targeted QA | No retrospective recording or blanket14-mode paid replay required                                       |
| Production behavior frozen                   | Reviewed I1→devc103 equivalence; preparation changes only version/reporting literals, metadata, regression coverage and documentation                        | Keep providers/models/SDKs/protocol/schema/orchestration frozen                                         |
| Latest integrated CI                         | PASS: [38460193028](https://github.com/Mert1026/Sentry/actions/runs/38460193028), all3 jobs atc103509                                                        | Final preparation head/proposed-merge results must be recorded in this PR's verification receipt        |
| Exact candidate identity                     | Review version1.0.0-rc.1, protocol1, Electron36.2.1; [complete transition](v1-rc-versioning-plan.md)                                                         | Owner reviews final full SHA/tree and unsigned archive hashes in PR receipt                             |
| Distribution generation                      | Existing full-SHA/manifest/extraction/checksum pipeline retained; no signing/publication/channel activation                                                  | Both final-head private target jobs must PASS; receipts distinguish new RC bytes from I1                |
| Security regressions                         | Existing isolation/credential/launcher/backup gates retained; real WSL trust is separate from hosted fallback                                                | Final exact-head counts/skips and actual trust result required in PR receipt                            |
| Credential persistence                       | Incorporated actual I1 Windows DPAPI/save/restarts/upgrade evidence and correction regressions                                                               | New RC binary smoke, if executed, has a separate exact-byte receipt; no real owner credentials accessed |
| Recovery policy                              | **PENDING — explicit owner decision required**; recommend [Option A](v1-recovery-policy-decision.md), tested Windows I1 scope                                | Adopt A / request separately scoped B / reject both and retain blocker                                  |
| Known release blockers                       | Original-beta G10 P1 FAIL retained; no new current-production blocker established by missing recordings                                                      | Resolve recovery disposition; investigate any actual final-gate failure rather than waive it            |
| Known evidence limitations                   | Exact-build attribution of owner functional report/export, full native G10-R, clean Windows and selected failure scenarios remain unrecorded                 | Owner accepts the stated scope/limits or requests only targeted risk-driven checks                      |
| Version/protocol/data compatibility          | Version-only transition, protocol1 and migrations unchanged; lockfile/model/SDK pins frozen                                                                  | Confirm final review diff and matching Desktop/runtime identities                                       |
| Draft release notes                          | [Prepared](v1.0.0-rc.1.md), explicitly unsigned/review-only with prerequisites and recovery limits                                                           | Owner reviews wording/scope                                                                             |
| Owner RC authorization                       | **PENDING**, separate from preparation and normal functionality confirmation                                                                                 | Approve exact commit/identity and explicitly authorize any later cut; no automatic action               |

Evidence types stay separate: owner-reported functionality, executed automated
checks, recorded physical tests, exact-build attribution and unexecuted cases.
No individual historical A–G row is changed to PASS here. Existing screenshots
are optional supporting material; their absence is not a defect. A confirmed
unresolved P0/P1 production defect would make the recommendation NOT READY.

The final [Phase6.0 report](v1-phase-6-0-rc-readiness.md) and this PR's executed
verification receipt provide the GO/NO-GO snapshot. Healthy final engineering
checks with a discrete pending recovery/authorization decision lead to
**CONDITIONALLY READY**, not a broad new implementation phase.
