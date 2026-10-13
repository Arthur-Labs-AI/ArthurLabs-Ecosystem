# v1.0.0-rc.1 preparation checklist

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
