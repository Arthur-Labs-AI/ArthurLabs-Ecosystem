# Phase 6.3 — Windows RC freeze and authorization handoff

October 15, 2026. **CONDITIONALLY READY**: local artifact and prepared-host
acceptance passed, but the required merged-dev Windows distribution workflow
still fails at artifact upload for storage quota after verified retirement.
Local results do not waive the hosted gate. The release branch and its review PR
remain pending that prerequisite; official cut authorization is premature.

This is preparation for an unsigned Windows review candidate. No official RC tag,
GitHub Release, public release asset, main promotion or default-branch change is
authorized or performed. Only the owner merges review PRs.

## Selected integration and scope

| Reference                                 | Verified identity                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| Remote main / default                     | `4fd2be9fa3b17370841dbb1d2f0422a2150c62d8`; default remains main                         |
| Owner-merged dev / selected binary source | `c6d4769bf3179d49bb3718074d6c083f52332626`                                               |
| Selected Git tree                         | `45e1d84e0eb447f4b93d1193a4421c6aeba1c40b`                                               |
| Planned release branch / initial SHA      | `release/v1.0.0-windows` / selected c6d4769; NOT CREATED while hosted gate fails         |
| Documentation review branch               | `codex/v1-phase-6-3-windows-freeze`, based on selected c6d4769; PR awaits release target |
| PR23 merge / reviewed head                | `59ba800fc25ee61f1aff93a4401e0f70e3125270` / `16b47d83da58fc8091df94131be64891a0b467a0`  |
| PR24 merge / reviewed head                | `5aedbc24e7a0dddcd0a155abc243a6e3c0e273d5` / `be7708e131ee28309c11e2ac3bf24a16609f436d`  |
| PR25 merge / reviewed head                | selected c6d4769 / `982048d29977842c83e5d1acd84da7c9f28b93d1`                            |
| Published release                         | Immutable historical `v0.1.0-beta.1`; no official RC published                           |

Initial v1 supports **Windows 11 x64 with WSL 2**, Ubuntu preferred. Windows
Electron retains the Linux execution runtime, systemd user services, bubblewrap,
protocol validation and shared security gates. Native Desktop is **DEFERRED —
FUTURE NATIVE LINUX RELEASE**. Its implementation, prior results and
[unresolved import investigation](native-linux-large-import.md) are preserved.
A shared import/security defect reproduced through Windows remains a blocker.

Feature freeze permits reproduced Windows blockers, security/data-loss fixes,
packaging corrections, regressions and release documentation. This preparation
changes no product behavior, schema, dependency lock, model pin, version or protocol.
The owner's dirty primary checkout and its older provider-error patch are excluded.

## Frozen identity and pins

| Component                             | Selected value                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| Product / Desktop / runtime / CLI     | `1.0.0-rc.1`                                                                        |
| Runtime protocol                      | `1`                                                                                 |
| Lock SHA256                           | `a36aebfc003cd12076ed63613c05b07e6fa416d3c3f52a54d4f86ac3f3e4683a`                  |
| Electron / electron-builder / esbuild | `36.2.1` / `26.0.12` / `0.21.5`                                                     |
| Node requirement / CI baseline        | Node >=22 / Node 22                                                                 |
| Executed Windows build Node           | `v24.13.1`                                                                          |
| Executed Ubuntu WSL Node              | `v22.23.2`, standalone `/usr/bin/node`                                              |
| pnpm                                  | `9.12.3`, frozen lockfile                                                           |
| OpenCode tool                         | `1.18.32`; OpenRouter model comes from configured settings, no invented fixed model |
| DeepSeek SDK/tool and model           | `0.1.5-rc.2`; `deepseek/deepseek-v4-flash`                                          |
| GLM tool and model                    | Claude Code `2.1.270`; `zai/glm-5.3-flash`                                          |

The active stacks remain independent OpenCode, DeepSeek and GLM. Historical
merger/verifier/issue-lineage implementation does not imply an active Desktop
merger/verifier ingestion stage. No funded provider replay was started.
OpenCode and GLM use their pinned CLI tools without a vendor SDK dependency;
DeepSeek's client and subprocess packages are both pinned to `0.1.5-rc.2`.

## Gates executed against c6d4769

| Gate                                    | Status and evidence                                                                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actual merged-dev CI                    | **PASS**: [38685627100](https://github.com/Mert1026/Sentry/actions/runs/38685627100), quality and Windows/Linux launcher jobs                                                                                             |
| Actual merged-dev Windows distribution  | **FAIL**: [38685627221](https://github.com/Mert1026/Sentry/actions/runs/38685627221), attempts 1/2/3 fail at upload-artifact storage quota; attempt 3 followed verified retirement; build/tests/archive generation passed |
| Release-branch CI / archive             | **UNVERIFIED**: release branch creation is gated on merged-dev distribution success                                                                                                                                       |
| Focused review PR / checks              | **UNVERIFIED**: PR target does not yet exist; no substitute PR to dev/main                                                                                                                                                |
| Windows static/build                    | **PASS**: frozen install, repository:check, format:check, lint, typecheck, build;20 build tasks,19cached                                                                                                                  |
| Windows Desktop                         | **PASS**: local suite exit0; exact merged-dev hosted Windows job independently records452 passed/3 skipped                                                                                                                |
| Windows distribution tests              | **PASS**:32 passed/27 platform skips,59 total                                                                                                                                                                             |
| WSL static/build                        | **PASS**: frozen install, repository hygiene, format, lint, types and build in isolated Linux home/cache/data                                                                                                             |
| Complete WSL suite                      | **PASS**: `turbo run test --force --concurrency=2 -- --maxWorkers=1 --minWorkers=1`;40 successful uncached tasks,1,288 passed/33 skipped, no excluded package/test                                                        |
| Physical sandbox trust                  | **PASS**: separate `verification-trust.test.ts`,8/8; real Ubuntu WSL systemd and bubblewrap, independent of hosted fallback                                                                                               |
| WSL distribution tests                  | **PASS**:50 passed/9 platform skips,59 total                                                                                                                                                                              |
| Fresh Windows archive                   | **PASS**: clean committed c6 source; forced 20 uncached production builds; external extraction, sidecar, manifest and 332 inventory files verified                                                                        |
| Packaged prepared-host acceptance       | **PASS**, bounded checks detailed below; this is not clean-machine provisioning                                                                                                                                           |
| Native physical smoke / native recovery | **UNVERIFIED / DEFERRED**, not a Windows-only release gate                                                                                                                                                                |
| Fresh paid provider campaign            | **UNVERIFIED**, not repeated; prior owner success retained with attribution                                                                                                                                               |
| Official publication / promotion        | **UNVERIFIED / NOT AUTHORIZED**                                                                                                                                                                                           |

WSL skips:7 opt-in Claude live tests,8 OpenCode stub tests,16 Windows helper cases,
one native-runtime prerequisite case and one Windows maintenance process case.
The Windows skips are native/platform/prerequisite cases. Distribution skip totals
are platform-specific; they are not successful real-host operations.

The first unbounded `pnpm test` had one 5-second timeout in runtime
`start-identity.test.ts`, during highly parallel collection. Its failure log is
retained. The isolated7-case file and the complete bounded suite passed without
changing assertions, timeouts or test selection. No failed test was silently
excluded. Hosted sandbox fallback is not physical isolation evidence.
The isolated Linux verification checkout used frozen installation with
`--ignore-scripts`; it does not establish native Electron provisioning. Actual
packaged WSL setup separately performed its production runtime installation/build.

## Exact private Windows archive

`sentry-1.0.0-rc.1-c6d4769bf317-windows-x64.zip`

| Receipt                             | SHA256 / result                                                             |
| ----------------------------------- | --------------------------------------------------------------------------- |
| Archive / trusted sidecar           | `7388476da46119f3cc33dbb2d14855cd07d4fcf14d638e025b4ce0cbeed17200`          |
| `distribution.json`                 | `697a1d0fd343e5d1dfa8ef5f288c62206b45767db7ef70cc610c9a68599bbadd`          |
| External extraction                 | PASS, including a Windows path with spaces                                  |
| Inventory / forbidden private files | PASS,332 checksummed files; distribution verifier exclusion checks          |
| Identity                            | PASS, full selected source, rc.1, protocol 1, windows-x64, matching runtime |

Retained privately under
`C:/Users/merte/.codex/artifacts/sentry-phase63-20261015/retained-release/`,
with checksum, external extraction and `artifact-receipt.json`. Private host logs
and generated archives are not committed to Git. Retention is independent of
seven-day Actions expiry. This is an unsigned online-bootstrap ZIP, not a signed
EXE/MSI/MSIX, offline installer or automatic update channel.

This archive was built from **c6d4769**, not from a later documentation PR or its
future merge. After owner integration, record the actual merged release SHA/tree,
run its applicable CI, build fresh bytes, verify/extract them and repeat bounded
packaged acceptance before requesting publication of those exact assets.

## Prepared Windows 11 / Ubuntu WSL acceptance

- Actual extracted `sentry.ps1 setup -Distro Ubuntu -NonInteractive` performed
  the real WSL bootstrap, Linux dependency/build work, preactivation/active runtime
  checks and distro preference synchronization. No inner bootstrap substitute.
- Actual supported `open`, `stop`, fresh `open` and `stop` succeeded. A visible
  production renderer and IPC confirmed Ubuntu, source c6d4769, rc.1, protocol 1,
  standalone Linux Node 22.23.2 and the isolated runtime data root on both launches.
- The private harness added explicit `--user-data-dir` and CDP arguments only at
  Electron process creation. Installation, process creation and shutdown remained
  real; archive scripts were unchanged. This injection is disclosed because
  `APPDATA` alone does not override Electron's Windows known-folder profile.
- A disposable GUI project import passed. Removal Cancel/Escape preserved it;
  confirmation removed managed files and associated records while retaining the
  original source. Missing-managed-folder detail removal passed. A fresh SQLite
  process and a fresh renderer reopen both showed no resurrected project.
  Active-operation/lease refusals are covered by the executed complete suite.
- Synthetic DPAPI seed and a fresh process verified stored/secure status,
  plaintext absence, busy-profile diagnostic refusal and an offline credential
  diagnostic that did not start a runtime. No real provider values were used as
  fixtures, inspected or exported; no funded requests were made.
- Packaged WSL maintenance bridge/dialog passed Ubuntu identity, administrator
  and other-application wording, Cancel focus, Escape and continued connection.
  It never confirmed reclamation. Current Windows helper regressions ran in the
  hosted Windows suite using actual PowerShell and native API fixtures; populated
  owner-disk reclamation remains attributed prior evidence, not a new disk test.
- Prior Phase 6.2 GUI import at aced9cc retained5,003 files/102 directories,
  1,073,875,836 included bytes,63,601ms and matching source/managed/immutable hash
  `ee0d072d46d99e4b1f540190db067e8096502caca38aef6dfa163611cbc61a3b`.
  The aced9cc→c6 project-manager production diff only changes removal ENOENT
  handling; import/update materialization is unchanged. This is reused historical
  Linux-filesystem input through Windows GUI evidence, not a new1 GiB NTFS test.
- The owner's prior successful DeepSeek run and full 3/3 report remain owner
  observations of the earlier fixes. They are not reattributed to this new ZIP.

An initial private launcher harness used an invalid runtime path ending in `n`
and counted a visible fatal screen as readiness. Its APPDATA-only override did
not isolate Electron, so that attempt could load the normal stored credentials
during bootstrap. No secret values were inspected or logged, and no paid calls
were started. No credential migration or replacement was requested. That receipt
was corrected and is not a passing gate.
Later attempts exposed private proxy/CDP timing mistakes; failures are retained.
The passing setup/open receipt proves an explicit profile, matching handshake and
real shutdown; the fresh renderer check correlates CDP replies and awaits preload.

Private evidence root: `C:/Users/merte/.codex/artifacts/sentry-phase63-20261015`.
Key receipts: `packaged-entrypoints-isolated-receipt.json`,
`remaining-packaged-acceptance-receipt.json`, `linux-package-test-counts.json`,
`linux-bounded-gates.log`, `windows-archive-build.log` and the merged-source logs.
Isolated WSL root: `/var/tmp/sentry-phase63.vr7fZ6Xu`; owner runtime/data retained.

## Integration review and maintenance boundaries

Reviewed PR23/24/25 implementation and regression coverage on the actual merged
source. No new product blocker was reproduced by the passing bounded checks.
DeepSeek strong findings still require grounded tool/source evidence; explicit
persistent Bash completion is recognized only for shell-family results and valid
exit codes. Unknown outcomes remain unknown. Project removal retains canonical
database transactions, runtime leases, durable operations, cascade semantics,
source preservation and UI invalidation/reread. Only missing-folder ENOENT is
accepted; unrelated I/O failures remain fatal.

WSL maintenance requires connected Windows runtime, no active work, positive
runtime shutdown acknowledgement and reconnect/resume cleanup. Helper registry
selection requires an exact unique WSL 2 distro and canonical registered ext4.vhdx,
rejects reparse paths and rechecks SID/disk after UAC. Other running distros are
refused before trim and after UAC; global shutdown follows explicit consent.
Disk release polls are bounded, sharing errors32/33 are handled, and no forced
detach is used. UAC cancellation/error paths remain fail closed.

Per-operation helper creation is exclusive and result names are unpredictable.
The inspected default maintenance directory grants the owner/SYSTEM/admin write
access, with sandbox users read/execute only. Arbitrary custom-profile ACLs and
adversarial same-account helper/result replacement between checks were not proven
safe. The elevated helper accepts a result path and does not independently enforce
its ancestry/ACL or atomic receipt creation. Keep the profile/operator-controlled
maintenance directory trusted; this receipt does not certify hostile same-user
or broadly writable profile setups. No real disk/UAC race was deliberately run.

The c6 source-paired native helper also passed a real read-only `Inspect` against
registered Ubuntu: disk bytes 16,953,376,768 and Windows free bytes 24,160,817,152
at that check. This was inspection only; no trim, UAC, shutdown or compaction.
Dev branch protection was rechecked on October 15: GitHub returned 403 requiring Pro
or a public repository. Owner-only merges remain procedural, not server-enforced.

## Recovery policy retained

Recovery Option A remains owner-approved for the exact corrected historical I1
Desktop/runtime source `c78faa74717b0f430a859730e98c3c4915e7b03f`. Retain its
matching archive and verified stopped profile/data generation. Compatible schema,
same compatible Windows account/machine/DPAPI context, retained originals and
complete validation before replacement remain mandatory. No automatic schema
downgrade, plaintext fallback or cross-account encrypted-key portability.
Cross-filesystem replacement is not atomic; inspect interrupted swaps while
stopped. Original-beta G10 remains historical **FAIL**. Native G10-R is deferred.

## Artifact retirement and hosted upload blocker

Inventory:91 Actions review artifacts totaling10,677,587,345 bytes. The owner
separately approved private backup and removal of exactly 88 obsolete artifacts,
10,320,287,696 bytes. **PASS: all 88 original archives/sidecars were privately
retained, SHA256-verified and reverified before the approved remote deletion.**
Remote inventory changed91→3; published release assets are unchanged. A transient
DELETE failure interrupted the first 55 deletions; the durable receipt was inspected
and the remaining 33 completed without changing the approved inventory. Exact
inventory and receipts are private under the evidence root:
`retired-artifacts-proposal.json`, `ci-artifact-backup-receipts.json` and
`ci-artifact-retirement-receipt.json`.

Always retain remote artifact 11931760737(latest native at inventory),11930808555(latest Windows at inventory)
and11824624394(corrected Windows I1), plus every published release asset. Artifact
retirement does not authorize deleting workflow logs, Git branches or releases.
After verified retirement, attempt 3 again failed only at upload (07:00:46 UTC).
GitHub still reports exhausted storage and a 6–12 hour accounting refresh. This
does not prove when quota will become available; no extra artifacts, releases or
other repositories are authorized for cleanup. Local archive
success or retirement approval does not establish hosted success.

## Branches and owner review

The focused documentation branch preserves this reviewable preparation;
no PR is opened against an incorrect base.
`release/v1.0.0-windows` is not created while merged-dev distribution is failed.
After that exact-source run succeeds, recheck dev/main/source/tree and absent local
and remote release refs, create/push the release branch at c6d4769, and inspect its
required checks. Corrections/documentation use a focused task branch and a PR
targeting that release branch. Only the owner merges; do not directly commit to
the shared branch. Propagate accepted corrections back to dev through review.

Do not create `feature/native-linux-support` now. After Windows publication and
owner authorization, select the then-approved shared dev source, record full
SHA/tree, verify refs absent and create the native branch from that source. Do not
discard the retained native implementation or historical evidence.

## Remaining authorization steps

1. Artifact retirement is complete; retain all verified private copies and receipts.
2. Obtain actual merged-source Windows distribution SUCCESS; then create the
   release branch and open the focused documentation/review PR into it.
3. Owner reviews and merges that PR; agents do not self-merge or enable auto-merge.
4. Rebuild/verify/retest the actual merged release SHA and record new hashes.
5. Owner separately authorizes the exact source/assets, support scope, bounded
   risks and intended publication visibility before any tag/release/main action.

Prepared-host checks do not establish clean-machine provisioning. Internet,
usable WSL 2, Linux prerequisites, provider accounts/tools/credit and trusted
unsigned-archive delivery remain operational requirements. Native physical
acceptance, paid replay and real-disk repetition are explicitly not new PASS gates.
`shux contract` was attempted but unavailable; task status, ledger and handoff are
maintained directly. The original primary checkout remains untouched by this phase.
