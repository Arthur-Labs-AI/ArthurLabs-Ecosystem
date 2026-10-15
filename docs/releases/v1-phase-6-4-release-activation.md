# Phase 6.4 — Windows release branch activation and RC review

October 15, 2026. **CONDITIONALLY READY**: the frozen Windows release branch is
established and the existing preparation is ready for owner PR review. Hosted
delivery and the privileged-helper hardening disposition remain bounded pending
items before broad publication. No official RC publication is authorized.

## Owner exception and branch identity

The owner explicitly authorized branch creation/review preparation despite the
verified artifact-upload quota failure. This supersedes only the Phase 6.3
requirement to await successful hosted upload before branch creation. It does
not waive application/security tests, change workflow conclusions, approve an
alternative delivery path, authorize tags/releases/main promotion or permit
self-merge. Main/dev/default and the published beta tag remain unchanged.

`release/v1.0.0-windows` was created and remotely verified on October 15 at
07:58 UTC, initially and currently pointing to
`c6d4769bf3179d49bb3718074d6c083f52332626`, complete tree
`45e1d84e0eb447f4b93d1193a4421c6aeba1c40b`. No artificial release commit.

The existing `release-prep/v1-phase-6-3-windows-freeze` retains original commits
`fca2d0b04120d9fd6195ba42f342a8685ca02386` and
`036059ae7f799260a7b8558892dc28ccd9c7f0df`. This additive documentation update
reconciles the exception and review findings. Its PR target is exclusively
`release/v1.0.0-windows`; only the owner merges, with no auto-merge.

The full PR diff is limited to documentation and task records: README/changelog,
Windows release notes/checklist/roadmap, installation guide, branching policy,
completed cleanup receipt, Phase 6.3/6.4 handoffs and superharness records.
Product implementation, workflow definitions, versions, lock, protocol, models,
SDKs and migrations are unchanged. No native development branch was created.

## Application verification, archive generation and delivery

These are independent conclusions. The owner exception does not combine them.

| Gate                                                 | Evidence and disposition                                                                                                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Established merged-dev source CI                     | PASS, freshly inspected [38685627100](https://github.com/Mert1026/Sentry/actions/runs/38685627100): three successful jobs at exact c6d4769                                                         |
| Established merged-dev Windows packaging             | PASS for build/tests/extraction/identity/hash stages in attempt 3 of [38685627221](https://github.com/Mert1026/Sentry/actions/runs/38685627221)                                                    |
| Established merged-dev hosted delivery               | FAIL: the same run's actual conclusion remains failure; only failing step was upload-artifact quota                                                                                                |
| Release-branch CI                                    | PASS: automatic run [38702386286](https://github.com/Mert1026/Sentry/actions/runs/38702386286), exact c6d4769; quality and Windows launcher passed, native launcher intentionally skipped          |
| Release-branch archive/delivery                      | FAIL: automatic run [38702386301](https://github.com/Mert1026/Sentry/actions/runs/38702386301), exact c6d4769; build/tests/extraction verified, only upload-artifact failed for quota              |
| New local static/build commands                      | PASS: frozen install, repository hygiene, formatting, lint, typecheck, build and whitespace checks; lint/build 20 cached tasks, types 37 cached tasks                                              |
| New targeted Windows helper/lifecycle/UI regressions | PASS: five files, 43 tests, single worker; actual Windows PowerShell fixtures                                                                                                                      |
| New security review fixtures                         | PASS as observations: five disposable cases described below; no elevation, real WSL commands or VHDX access                                                                                        |
| Prior physical/application acceptance                | Phase 6.3 evidence retained: WSL full suite 1,288 passed/33 skipped; hosted Windows Desktop 452/3 skips; real WSL sandbox trust 8/8; Windows distribution 32/27 skips; WSL distribution 50/9 skips |
| New full local/paid/clean-machine acceptance         | UNVERIFIED / not repeated: documentation-only application diff; prior exact-source evidence remains attributed to its actual executions                                                            |
| Final merged RC source/archive                       | UNVERIFIED until owner merge, fresh exact-merge build and necessary bounded packaged acceptance                                                                                                    |
| Trusted final delivery / official publication        | UNVERIFIED / NOT AUTHORIZED                                                                                                                                                                        |

Required new PR checks are quality (including shared Linux runtime/security),
Windows launcher/Desktop and Windows release archive. Native Desktop launcher
is intentionally skipped for the Windows release target; this does not skip
shared Linux security. Native archive is deferred, not an official Windows asset.
Hosted sandbox capability fallback remains honestly distinguished from physical
WSL trust evidence. No failed upload is relabeled success or repeatedly rerun.
The automatic release archive is classified **PACKAGING VERIFIED — HOSTED
ARTIFACT DELIVERY BLOCKED**. Its actual GitHub conclusion remains failure.

## Separate archive provenance

Version remains `1.0.0-rc.1`; runtime protocol `1`. Selected implementation is
full c6d4769/tree 45e1d84 above. Dependency-lock SHA256:
`a36aebfc003cd12076ed63613c05b07e6fa416d3c3f52a54d4f86ac3f3e4683a`.

Both historical archives have filename
`sentry-1.0.0-rc.1-c6d4769bf317-windows-x64.zip` but different generated bytes:

| Build / availability                                    | SHA256                                                             | Actual acceptance                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Privately retained local ZIP                            | `7388476da46119f3cc33dbb2d14855cd07d4fcf14d638e025b4ce0cbeed17200` | Hash rechecked in Phase 6.4; Phase 6.3 external extraction,332 files, real packaged setup/open/WSL identity/import/removal/synthetic secure storage/stop/relaunch |
| Hosted attempt 3 ZIP, upload rejected                   | `d3aad7b8ee9fb1c159d1a3922ecefc1126ef7a0c78253c8bd1819a4118677cfa` | Runner build/extraction verified; not downloaded or physically tested                                                                                             |
| New release-branch run 38702386301 ZIP, upload rejected | `0d561d98e2ba15268ab4476df79122b5a0919d5820bb77a8782db06e6a3839ae` | Separate c6d4769 runner build/extraction verified; not downloaded or physically tested                                                                            |

Local manifest SHA256 remains
`697a1d0fd343e5d1dfa8ef5f288c62206b45767db7ef70cc610c9a68599bbadd`.
New automatic release/PR build bytes, if generated, have independent run receipts
and checksums. Neither earlier ZIP is renamed or reused as a later commit's
artifact. After owner merge, record the actual full release SHA/tree, compare
application content, build fresh matching bytes, verify complete inventory and
repeat only necessary bounded packaged acceptance.

## Privileged-helper review

**Classification: Narrow hardening recommended before broad publication.**
No supported-profile privilege-boundary exploit was reproduced. This is not a
claim that hostile same-account or broadly writable custom profiles are safe.
No product correction is silently included in this documentation PR.

Reviewed existing helper, reclaimer, maintenance controller and their tests.
Five private disposable fixtures exercised the unchanged dispatcher or library,
with WSL resolution/mutations and elevation replaced at explicit boundaries:

- Wrong expected SID: rejected before shutdown or native compaction.
- Changed registered disk after elevation boundary: rejected before mutation.
- Outside-operation, pre-existing result path: the catch path overwrote the
  disposable file with error JSON; result ancestry/exclusive creation is absent.
- Script substitution at mocked RunAs launch: replacement bytes and a synthetic
  success receipt were accepted by the parent flow. No child was elevated or
  attacker code executed; this characterizes missing authenticity checks.
- Explicitly broadened disposable custom-profile ACL: Everyone write was inherited
  by a CreateNew helper file. Exclusive initial creation does not harden its DACL.

The default maintenance directory was inspected read-only on this laptop:
owner/SYSTEM/Administrators may write; CodexSandboxUsers have read/execute only.
The renderer supplies no script/result/disk path. Initial helper content is fixed,
operation directories and result names are unpredictable, and helper creation is
exclusive. The elevated dispatcher re-resolves exact WSL2 registration, rejects
disk/ancestor reparse paths and compares SID and expected canonical disk path.
These guards do not authenticate a script after a trusted principal replaces it.

Important review findings, within the previously disclosed trust assumption:

1. `wsl-space-reclaimer.ts:24-27` / `wsl-space-helper.ts:166-169`: inherited ACLs
   and user-writable script reloading are relied on; no independent authenticity
   or private-directory/reparse enforcement occurs at the elevation boundary.
2. `wsl-space-helper.ts:173-177,207-212`: result writes are neither contained nor
   exclusive/atomic; parent receipt validation is exit-code plus truthy `ok`,
   not an authenticated per-operation proof. Arbitrary result paths originate
   only from a trusted host/helper in normal Desktop flow.

These observations require control of trusted profile files or caller arguments;
the fixtures do not demonstrate crossing the inspected default profile's DACL
from another principal. Treat private owner-controlled profile/ancestors and
same-account processes as trusted for current optional maintenance. Broadly
writable custom profiles are outside this reviewed operating scope.

Before broad publication, recommend a separate narrowly reviewed hardening change
for private operation-directory ACL/reparse checks, elevation-boundary integrity
and contained exclusive/atomic per-operation receipt creation/validation, or an
explicit owner disposition of this bounded optional-feature trust assumption.
A genuine reproduced supported-boundary defect requires a separate focused fix
with regression coverage; none was established here. This recommendation is not
an application redesign or permission for unreviewed code in the freeze PR.

Existing 43-test regressions additionally cover active-run/shutdown refusal,
other-distro checks before trim and after UAC, sharing-lock deadlines, cancellation,
error propagation and reconnect/resume outcomes. No real administrator operation,
owner VHDX, owner credentials or paid providers were used. The first private ACL
fixture encountered an unavailable PowerShell 5.1 security-module autoload; it was
corrected to use framework ACL APIs and all five final fixtures passed.

## Windows release content and limits

The [draft release notes](v1.0.0-rc.1.md) cover independent OpenCode/DeepSeek/GLM,
one/two/three-agent selection, Full/Targeted QA, immutable snapshots, grounded
findings/evidence, DeepSeek Bash correction, project removal, persistent history,
JSON/log export, secure credentials, packaged setup and shutdown/reconnect, and
optional WSL disk reclamation. Windows 11 x64/WSL2 only, Ubuntu preferred.
Native Desktop remains deferred; Linux execution/runtime security stays required.

Unsigned online-bootstrap ZIP; no auto-update, signed EXE/MSI/MSIX or offline
installer. Usable WSL/systemd/bubblewrap/Linux Node/pinned pnpm and internet are
required. Providers may require accounts and credit. Compaction requires explicit
confirmation/administrator approval, may interrupt WSL and promises no fixed
space recovery. Use only trusted profiles for optional elevated maintenance.

Recovery Option A remains adopted for the exact corrected historical Windows/I1
source `c78faa74717b0f430a859730e98c3c4915e7b03f` and matching stopped backup.
Original-beta executable G10 remains historical FAIL. This RC does not replace
that approved recovery target or promise schema downgrade/DPAPI portability.

## Owner handoff and publication boundary

1. Review the preparation PR and actual quality/Windows/archive conclusions.
   Only the owner merges; no auto-merge or agent self-merge.
2. After owner merge, fetch/record full release merge SHA/tree and required CI;
   select that actual source and build a fresh matching Windows archive.
3. Verify checksum, manifest/inventory, extraction and necessary bounded packaged
   acceptance; retain exact receipts and resolve the helper recommendation.
4. Establish successful trusted delivery or explicitly approve an alternative.
   Quota recovery is proven only by a real successful upload; no extra artifact
   cleanup or repeated expensive reruns are authorized by this phase.
5. Present exact source/assets/evidence/limits and request separate official RC
   tag/release authorization. No automatic publication or stable-main promotion.

Private evidence: `C:/Users/merte/.codex/artifacts/sentry-phase64-20261015`.
The primary checkout/owner files, other worktrees, tags, published release and
protected historical artifacts are preserved. No branch or artifact was deleted
in this phase. `shux contract` was attempted but unavailable; task status, ledger
and handoff maintained directly. Final PR URL/head and completed workflow
conclusions are recorded in the owner report and private final verification.
