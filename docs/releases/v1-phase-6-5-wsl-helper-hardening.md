# Phase 6.5 — Windows privileged-helper hardening

October 15, 2026. The owner selected **v1.0.0 Stable directly for Windows 11 x64
with WSL2**, Ubuntu preferred. **No public prerelease or RC tag will be created.**
Current product version stays `1.0.0-rc.1` during this security correction;
the controlled stable-version transition belongs to the next phase.

## Verified starting state and scope

Owner-merged PR #26: release source
`4e75534b87021c796b5935c817bf56eeba8d4d87`, complete tree
`e60c42a4bef4c59c93f5fffea623f84572d0216c`. Post-merge
[CI 38708938698](https://github.com/Mert1026/Sentry/actions/runs/38708938698)
completed SUCCESS. [Distribution 38708938551](https://github.com/Mert1026/Sentry/actions/runs/38708938551)
completed FAILURE at upload-artifact storage quota; no successful delivery claimed.

Main remains `4fd2be9fa3b17370841dbb1d2f0422a2150c62d8`; dev remains
`c6d4769bf3179d49bb3718074d6c083f52332626`. The fix branch
`fix/v1-wsl-reclaim-elevation-integrity` is based on the actual frozen release
source and its PR targets only `release/v1.0.0-windows`. Only the owner merges.
No shared ref is directly committed, rewritten or force-pushed.

The correction is restricted to Windows maintenance execution/receipts and its
host-owned diagnostic path, permanent security regressions and release/security
documentation. Controller/renderer behavior, agent architecture, schema, provider
pins, dependencies, lock, runtime protocol `1` and version remain unchanged.

## Diagnosis and correction

The [Phase 6.4 review](v1-phase-6-4-release-activation.md#privileged-helper-review)
identified mutable helper-file execution across UAC, arbitrary-profile ACL
inheritance, uncontained/non-exclusive result writes and uncorrelated truthy
acknowledgements. Final review additionally pinned PowerShell module imports,
private native-compiler temporary files and System32 native DLL resolution.
Disposable probes established limitations; they did not
establish an actual exploit against the inspected default profile.

The correction removes script-file execution entirely: the fixed implementation
is passed inline to both PowerShell processes, with an argv-length guard. Private
operation directories live under the Windows home directory, independent of
custom profiles/Temp/AppData, with explicit protected current-SID/SYSTEM/admin
DACLs, trusted ancestry/ownership and repeated reparse checks. No arbitrary result
destination is accepted. Fixed contained result names use CreateNew, flush and
atomic no-replace rename. A strict operation/SID/distro/disk/outcome/message
envelope is authenticated by an ephemeral HMAC key and validated by PowerShell
and Node. See the [complete trust boundary](../security/wsl-maintenance.md).

UAC, user confirmation, registered disk/SID validation, authoritative busy and
shutdown gates, other-distro refusal, bounded lock waiting, no forced detach,
error propagation and safe reconnect remain intact. No feature was disabled.

## Red/green evidence

Before production edits, two permanent regression files ran against the original
implementation: **7 failed / 0 passed**, with actual security assertions:
broad ancestry reached maintenance; mutable script selected for UAC; external
result overwritten; existing operation/result accepted; tampered success accepted;
Node launched a file; Node accepted unsigned/uncorrelated measurements.
The failure log is retained as `security-red.log` in the private evidence root.

After correction, the same assertions passed. A separate two-case red run
(`dependency-boundaries-red.log`) demonstrated unpinned module discovery and
missing private compiler parameters before those corrections; both now pass.
Expanded tests additionally verify
the protected operation DACL, no-replace result/temp files, junction refusal,
generic/full-control ACL rejection, SID/disk changes, replay/field/MAC rejection,
PowerShell/Node signature interoperability and real PowerShell loading of the
fixed encoded bootstrap. Existing cancellation, trim refusal, other-distro,
locking and reconnect regressions retain their safety assertions.

Initial correction testing correctly refused the laptop's broadly writable
Temp/AppData ancestry. Positive disposable fixtures were moved under the private
Windows home, matching the new production diagnostic location; the broad-ACL
negative case remains. Two exploratory generic-ACL fixtures encountered enum
conversion and security-descriptor audit-privilege setup failures; the final
fixture changes only the access DACL through the raw ACL API. An initial lint
failure for an unused destructured receipt was corrected by explicitly returning
the unchanged measurement fields. All failure logs remain retained.

The first correction PR CI passed quality but reported one Windows fixture
timeout: its first real PowerShell case completed in5,707ms against Vitest's
5,000ms default;477other tests passed. The PowerShell subprocess already had a
30-second deadline. OS-fixture test budgets now allow35seconds for that existing
deadline plus setup/cleanup, scoped only to those suites/case. No safety assertion,
production deadline, test selection or retry policy changes. The initial CI
failure remains preserved; corrected exact-head conclusions are in the PR report.

## Executed verification

| Gate                                         | Actual result                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows frozen install/static/build          | PASS: install --frozen-lockfile, repository hygiene, formatting, lint, typecheck, build, diff check; changed Desktop build/types/lint actually executed |
| Complete Windows Desktop suite               | PASS: 478 passed / 3 skipped; 61 passing files, one opt-in integration file skipped in this invocation                                                  |
| Helper/command security coverage             | Included in Windows suite: 42 tests across helper, integrity, reclaimer and command files                                                               |
| Existing maintenance/IPC/UI                  | Included: controller, router, preload, command boundaries and confirmation/Cancel/Escape components                                                     |
| Windows-to-WSL real lifecycle                | PASS: separately enabled disposable runtime transport fixture,1/1; positive shutdown and reconnect, no disk mutation                                    |
| Windows distribution                         | PASS:32 passed /27 platform skips,59 total                                                                                                              |
| Windows launcher                             | PASS: Node decision logic, PowerShell smoke, production-behavior fixtures, IO stress and shutdown safety                                                |
| Linux frozen install/static/build            | PASS: frozen install (ignore-scripts), hygiene, format, lint, types and build in fresh isolated test checkout                                           |
| Complete Linux/shared suite                  | PASS:1,298 passed /49 skipped;40 uncached Turbo tasks, two tasks at a time/one Vitest worker                                                            |
| Physical WSL sandbox trust                   | PASS: separate 8/8 real systemd/bubblewrap trust execution after the complete suite                                                                     |
| Linux distribution                           | PASS:50 passed /9 platform skips,59 total                                                                                                               |
| Exact-head correction PR CI/archive          | Newly triggered checks and final conclusions are recorded in PR/owner report; no manual duplicate workflow retry                                        |
| Real elevated compaction/owner disk mutation | NOT RUN, explicitly prohibited; all elevation/disk mutations in security fixtures substituted                                                           |
| Paid-provider/clean-machine/stable packaging | NOT RUN in this phase; later exact stable-source packaging/acceptance remains required                                                                  |

Linux test source is the exact release baseline plus recorded hashes of the eight
changed production/test files; Windows and Linux overlay hashes are compared.
The fresh checkout uses an isolated home filesystem mount and XDG locations,
cleared provider/live variables and the actual user systemd manager. Windows-only
helper tests are platform skips on Linux, not successful Linux privilege tests.
The 49 skips include 29 Windows helper/integrity cases, two Windows-only reclaimer
cases, one PowerShell bootstrap case, the opt-in WSL transport fixture, plus prior
live/tool/platform skips. No actual sandbox trust file is excluded.

## Remaining limits and owner handoff

The boundary assumes a trusted installed/running application, OS, owner account
and administrator/SYSTEM principals. It does not promise resistance to complete
same-account/process compromise. Unsafe/ambiguous home ACLs fail closed without
rewriting owner permissions. No real UAC/native compaction is claimed; previous
physical disk results are not reassigned to this patch. The optional feature
does not guarantee a number of reclaimed bytes. Normal installation/runtime and
project management remain independent of maintenance availability.

**GO for owner review of this narrow security correction.** After the owner
merges and applicable exact-merge CI is verified, continue to the separately
controlled stable-version phase. This is not a stable-publication GO.
If new PR compilation/tests/packaging fail, investigate before recommending
integration; an upload-only quota failure remains a visible infrastructure failure.

Next phase: reconcile all applicable version metadata to `1.0.0`, build and verify
a fresh exact-source Windows stable ZIP, perform bounded matched-runtime packaged
acceptance, prepare owner-reviewed main promotion, verify actual main source and
final matching distribution, obtain separate immutable `v1.0.0` stable tag/Release
authorization, then propagate approved release changes to dev through review.
None of those future actions is executed here; no RC/prerelease tag is authorized.
Recovery Option A remains the exact historical corrected Windows/I1 c78faa7 scope.

Private evidence: `C:/Users/merte/.codex/artifacts/sentry-phase65-20261015`.
Owner dirty files, other worktrees, tags, published beta and retained artifacts
are preserved. No paid provider call, real elevated operation, extra branch or
artifact deletion, self-merge or publication. `shux contract` was unavailable;
task status, ledger and handoff maintained directly. Final PR URL/head/run receipts
are in the owner report and private final verification.
