# Windows v1.0.0-rc.1 readiness checklist

Current scope, October 15, 2026: **Windows 11 x64 with WSL 2**, Ubuntu preferred.
Native Desktop is **DEFERRED — FUTURE NATIVE LINUX RELEASE**. Shared runtime and
security failures remain Windows blockers. Historical FAIL/UNVERIFIED results
below retain their original meaning and source attribution.

The [Phase 6.3 freeze handoff](v1-phase-6-3-windows-rc-freeze.md) is authoritative.
Selected merged source: `c6d4769bf3179d49bb3718074d6c083f52332626`. The privately
retained ZIP was freshly built from that commit; any later owner merge requires
a new exact-merge build and acceptance before publication.

| Gate                            | Current disposition                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Owner integration               | PASS: PRs #23/#24/#25 merged into dev c6d4769                                                                              |
| Merged-dev CI                   | PASS: run 38685627100, quality and both launcher jobs                                                                      |
| Merged-dev Windows distribution | FAIL: run 38685627221 upload storage quota in attempts 1/2/3; last retry followed verified retirement; build checks passed |
| Local static/build              | PASS: Windows and physical WSL frozen install, hygiene, format, lint, types and build                                      |
| Complete applicable suites      | PASS: bounded WSL full suite 1,288/33 skips, Windows CI Desktop 452/3 skips; initial unbounded WSL timeout retained        |
| Real sandbox trust              | PASS: separate physical WSL systemd/bubblewrap 8 /8                                                                        |
| Distribution tests              | PASS: Windows 32/27 skips; WSL 50/9 skips                                                                                  |
| Private exact-source ZIP        | PASS: archive/manifest/lock hashes,332 inventory files, full external extraction                                           |
| Packaged setup/open/relaunch    | PASS: actual archive commands and runtime; explicit synthetic profile injection disclosed in handoff                       |
| Project import/removal          | PASS: targeted GUI import, Cancel/confirm/source preservation, durable database and fresh renderer reopen                  |
| Secure settings                 | PASS: synthetic DPAPI seed/fresh restart, offline diagnostic, no plaintext fallback                                        |
| WSL maintenance                 | PASS: packaged confirmation/Cancel/Escape; current native helper regressions; no real disk repetition                      |
| Large import                    | PRIOR EVIDENCE: Phase 6.2 packaged1 GiB import; affected import path unchanged                                             |
| Funded agents                   | PRIOR OWNER REPORT: DeepSeek and full 3/3 success; no paid replay authorized                                               |
| Recovery                        | Option A approved for exact historical corrected I1 c78faa7; original-beta G10 remains FAIL                                |
| Native smoke/G10-R              | DEFERRED, not PASS                                                                                                         |
| Release branch / focused PR     | PENDING: successful merged-dev Windows distribution is a prerequisite                                                      |
| Official cut                    | NOT AUTHORIZED: no tag, release, public assets or main promotion                                                           |

Artifact retirement **PASS**: all 88approved obsolete review archives/sidecars
were privately retained, SHA256-verified and reverified, then removed remotely.
Remote inventory91→3; protected Windows/native/I1 candidates and every published
release asset remain intact. The hosted upload still reports quota exhaustion
after retirement; actual workflow success is required before release-branch/PR
creation. A local focused documentation branch preserves this preparation.
The [native import tracker](native-linux-large-import.md) remains OPEN. A shared
defect reproduced through Windows requires a focused correction before release.

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
