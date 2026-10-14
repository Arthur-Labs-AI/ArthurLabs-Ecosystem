# Phase 6.1 — exact-source RC cut verification

Snapshot: October 14, 2026, Europe/Sofia. **CONDITIONALLY READY**: recovery-policy
decision, exact-RC native scope/verification and explicit official cut authorization
remain. No product correction or additional version bump was necessary.

**RC CUT BLOCKED — RECOVERY POLICY DECISION PENDING**

## Baseline and selected binary input

| Field                                 | Verified value                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Remote stable main                    | `4fd2be9fa3b17370841dbb1d2f0422a2150c62d8`                                                                             |
| Remote dev / selected source          | `8a75e9924a41b98351e46255111fdbfed335f1f0`                                                                             |
| Complete Git tree                     | `417ac8851cf06cda843f4c47b087e826170cc4c8`                                                                             |
| PR #21 reviewed head                  | `ef6ce35cf0eac9c3bdb0fafc8693f78b125ddfad`; complete tree equals selected merge                                        |
| PR integration                        | [PR #21](https://github.com/Mert1026/Sentry/pull/21), owner-merged into dev at `2026-10-14T04:57:52Z`                  |
| Version / protocol                    | Root, Desktop, runtime, CLI: `1.0.0-rc.1`; runtime protocol `1`                                                        |
| Dependency-lock SHA256                | `a36aebfc003cd12076ed63613c05b07e6fa416d3c3f52a54d4f86ac3f3e4683a`                                                     |
| Electron / electron-builder / esbuild | `36.2.1` / `26.0.12` / `0.21.5`                                                                                        |
| Requirements / targets                | Node `>=22`, pnpm `9.12.3`; native x64 packaging for `windows-x64`, `cachyos-x64`                                      |
| Post-merge CI                         | [38514119610](https://github.com/Mert1026/Sentry/actions/runs/38514119610), COMPLETED/SUCCESS, all three required jobs |
| Immutable beta                        | Annotated tag object `e92e3be8d2de21ce5c22508c15de3c08f02cb77a`, source `0e5c10cfa80f6385ebfc88a7306b38ce8a12ce38`     |
| Release/tag/open-PR preflight         | Only published release/tag `v0.1.0-beta.1`; no official RC; no open PR at start                                        |

Executed status/branch/HEAD, fetch/prune, remote ref/tree resolution, recent
history, branches/tags/worktrees, PR merge/open metadata, releases and artifact
inventory. Dev had not advanced beyond the approved merge. Primary checkout
remains on local main `9c57e3f` with pre-existing edits and PROJECT_GUIDE.md
preserved. Remote main and historical beta were untouched.

Inspected the full c103509→ef6ce35 transition and matching merge tree. Production
changes are version/reporting literals and metadata. Direct I1→selected-source
comparison found no change in dependency locks, persistence source/migrations,
agent adapters, run-engine production source or runtime-protocol source. Desktop,
CLI and runtime production differences are the documented version defaults.
No provider/model/SDK, security, schema, protocol or independent-agent behavior
change was introduced. Version consistency and mixed RC/beta rejection pass.

Selected binary input remains **8a75e992**, distinct from this documentation-only
PR head or any eventual documentation merge. Selecting a different full release
SHA requires fresh exact-source builds/verification; equal trees do not make
differently identified archives interchangeable.

## Exact builds and retained archives

Local Windows: Windows 11 Home x64 build 26200, Node `24.13.1`. Local Linux:
Ubuntu 26.04 LTS in WSL2, kernel `6.6.87.2-microsoft-standard-WSL2`, Node `22.23.2`.
Hosted: Node `22.23.3`, Ubuntu 24.04 / Windows Server image `windows-2025-vs2026`.
All use pnpm `9.12.3`. Ubuntu packaging proves the CachyOS target, not native execution.

Each clean selected-source input ran frozen install, build, distribution tests
and its native target build:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm distribution:test
pnpm distribution:build windows-x64     # native Windows
pnpm distribution:build cachyos-x64     # separate native Linux checkout
```

The existing builder additionally forced 20 uncached build tasks, asserted clean
committed input before/during/after packaging and validated extraction. Windows
documentation edits began after archive completion; the Linux checkout remains clean.

Exact filenames (local/hosted copies are retained in separate directories):

- Windows: `sentry-1.0.0-rc.1-8a75e9924a41-windows-x64.zip`.
- Linux: `sentry-1.0.0-rc.1-8a75e9924a41-cachyos-x64.tar.gz`.

| Artifact / provenance                                | Archive SHA256                                                     | distribution.json SHA256                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Local Windows — actual smoke artifact                | `d224cf09e2ba05b7e701c9b6cfa5f132d058680932bdb1d2257cebf3bdc51d96` | `424d8abbc46b00e0cde39a85abe46d8ae747ecd9f1f5b165d773b43179a8873e` |
| Hosted Windows — no physical pass transferred        | `4357b3fb24b6d9273efada9d5a2d6908acfa13fdc9c53c3114435c6895443fd0` | `2807a1738b10f3131144a93d1a77e8d87c5ee28f8789bfadcdb224f2479f1af9` |
| Hosted Linux — proposed native target, smoke pending | `8d906885c10c6fe9be2892f0dff6797e7236c5f85cec18c219f043f7262e75a8` | `463351b08ded6b9a6c3333344431d55f6bd8dae74cb4fb4721bff771e493ace1` |
| Local WSL Linux — separate packaging validation      | `d741cb45d3c426683999c0361336e3082a3793b17f0a34e8f790bbb327c5ff11` | `2d58acd8e25c6d212975ceddc19d1bdfcd97c87367d4d56b5488ce0d69263039` |

All four independently passed SHA256/sidecar comparison, fresh external
extraction, required inventory, every file checksum and forbidden-private-path
validation. Windows has 332 inventory files; Linux 333. Root/Desktop/runtime-source
identities agree on full selected SHA, version `1.0.0-rc.1`, protocol `1`.
Each of those three identity files has SHA256
`21a2ab7efac066d93be2ebd1e52f46ba07cf4459473a52b1018893911e580778`.
All runtime-source lock hashes match above. Extracted Windows PowerShell and both
Linux launcher version checks pass. No beta identity was mixed in or relabeled.

[Distribution 38514834916](https://github.com/Mert1026/Sentry/actions/runs/38514834916)
was dispatched on dev and resolved to selected full SHA; both jobs SUCCESS.
Artifact IDs Windows `11871237707`, Linux `11871202729`, hosted expiry October 21, 2026. All four archives/sidecars and verification receipts are retained privately
outside the repository under `C:\Users\merte\.codex\artifacts\sentry-phase61-20261014`
in `local-windows`, `hosted-windows`, `hosted-linux`, `local-linux`, with matching
`*-receipt.json`. These are unsigned review artifacts, not official assets.
No public release upload occurred. No DB, provider store or identifying host log
is committed. The archived INSTALL.md remains exact selected-source content;
reviewed documentation updates do not silently change retained archive bytes.

## Executed selected-source gates

| Gate                                             | Label      | Evidence                                                                                                                                                    |
| ------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen install / repository:check / format:check | PASS       | Windows and WSL, unchanged lock                                                                                                                             |
| pnpm lint / typecheck / build                    | PASS       | Both hosts: 20 lint / 37 typecheck / 20 build graph tasks                                                                                                   |
| Full applicable suite                            | PASS       | WSL `pnpm exec turbo run test --force --concurrency=1 -- --maxWorkers=1 --no-file-parallelism`: **1,236 passed / 16 skips / 0 failures**, 40 uncached tasks |
| Separate real trust                              | PASS       | WSL `pnpm --filter @qa/run-engine exec vitest run tests/verification-trust.test.ts --maxWorkers=1 --no-file-parallelism`: **8/8**, actual systemd mounts    |
| Windows Desktop                                  | PASS       | `pnpm --filter @qa/desktop exec vitest run --maxWorkers=1 --no-file-parallelism`: **400 passed / 2 skips**, 51 files                                        |
| Distribution/recovery                            | PASS       | `pnpm distribution:test`: WSL **50/1 skip**, Windows **26/25 platform skips**, 51 total each                                                                |
| Windows maintenance / launcher                   | PASS       | `maintenance.test.ps1`, `launcher-smoke.ps1`, extracted PowerShell `version`; selected-source CI includes both full launcher lanes                          |
| git diff --check                                 | PASS       | Both selected-source inputs; final documentation check recorded in review PR                                                                                |
| Selected-source hosted CI                        | PASS       | Three jobs in 38514119610; fallback suite excludes only actual trust file after mount probe fails                                                           |
| Hosted real isolation                            | UNVERIFIED | Fallback is not an isolation pass; actual WSL proof remains separate                                                                                        |
| Both archive targets                             | PASS       | Both local and hosted native-platform builds, independent external verification above                                                                       |
| Windows exact-RC smoke                           | PASS       | Local ZIP only, production GUI/IPC/WSL, synthetic history, DPAPI and two fresh restarts                                                                     |
| Native exact-RC smoke                            | UNVERIFIED | Owner explicitly chose pending during this task                                                                                                             |
| Full native G10-R                                | UNVERIFIED | Historical limitation retained                                                                                                                              |

Full-suite coverage includes independent agents/Full/Targeted selection, protocol,
Desktop IPC, credentials, history/exports, cancellation/recovery and security.
WSL totals include Desktop 401/1, run-engine 86/0, runtime 73/0, CLI 45/0,
DeepSeek 46/0, OpenCode 115/8 and GLM harness 87/7. Skips are existing OpenCode
stub 8, GLM live/provider 7 and Desktop platform 1. Real trust is also in the full
suite; the separate 8/8 run is not added to the 1,236 total. Windows uses applicable
Desktop/distribution/launcher lanes, not a claim that Linux-only systemd tests ran
natively on Windows. No paid-provider execution occurred.

Retained failed preparation attempts: private PowerShell runner initially treated
pnpm DEP0169 stderr as a terminating error; corrected to native exit-code handling.
Private history seeder initially misclassified documented CLI exit 5 (successful
simulation with findings); successful JSON preserved, helper now validates exit 5
and `ok=true`. Smoke then refused a missing receipt before Electron launch.
No product assertions, security gates, deadlines or production code were changed
to obtain a pass. All completed required test/build gates have zero failures.

## Physical compatibility and attribution

Actual Windows smoke is only for local ZIP `d224cf09...c51d96` on the prepared
Windows 11/WSL2 host, not a clean Windows VM or hosted ZIP `4357b3fb...443fd0`.
Verified extraction ran unchanged production bootstrap under a new disposable
Linux HOME/data/runtime root. Owner runtime/current stayed untouched. Candidate,
active and separate runtime checks report `1.0.0-rc.1`, full selected SHA and
protocol 1; actual systemd-user/bubblewrap prerequisites pass.

Packaged Electron ran three fresh processes with a new explicit Windows profile
proved before credential IPC, with inherited provider variables cleared. The
repository smoke assertions were retained in a private harness, adding explicit
protocol and completed synthetic history/three-agent/findings/evidence checks.
This deterministic simulation used no real provider. All three GUI launches
passed secure preload/renderer, IPC validation, matching hello, project import,
history reopen, single-instance behavior and graceful stop. One synthetic DPAPI
credential was saved, decrypted as stored/secure on two fresh restarts, and
presence-only diagnostics passed while preserving busy-profile refusal.
Plaintext was absent from profile/archive/application logs and disposable Linux
data. Private `windows-exact-smoke.log` records the final aggregate PASS and exact
archive hash. This does not replace or extend historical I1 recovery evidence.

Native CachyOS exact archive: **PENDING by explicit owner choice**. Hosted hash
`8d906885...2e75a8` was supplied for possible short checksum/graphical launch/
matching runtime/function/shutdown observations; no operator result was supplied.
Earlier [owner-reported normal functionality](v1-owner-functional-acceptance-2026-10-13.md)
remains valid with its original attribution. No video or paid matrix replay is
required. Ubuntu/WSL evidence is not native execution or native G10-R.

## Recovery and official-cut decisions

Recommend **Option A** strictly in the historical physically validated Windows/I1
scope of the [decision](v1-recovery-policy-decision.md), [contract](v1-g10-recovery-contract.md)
and [G10-R receipt](v1-phase-5-2-g10-recovery-validation.md). Recovery target stays
I1 `c78faa74717b0f430a859730e98c3c4915e7b03f`, Windows archive SHA256
`ec5edec8a6b3f8ef18bafd961e66c59f80669804cc98d30e0cb10ef18c527d1e`.
Do not substitute this RC as the historically tested recovery target.

Require compatible schema, same compatible Windows account/machine/DPAPI context,
matching stopped backup generations, verification before replacement and retained
original backup. No plaintext credential export, automatic DB downgrade,
cross-account/machine encrypted-credential portability or cross-filesystem atomic
replacement is promised. Original-beta G10 stays historical P1 FAIL; native
G10-R stays unverified. Request **one explicit owner choice**:

- **A:** Adopt Option A within its stated tested Windows/I1 scope.
- **B:** Request a separate beta-derived maintenance/recovery implementation.
- **C:** Reject both and retain the recovery release blocker.

Recovery choice: **PENDING / UNDECIDED**. Official cut: **PENDING / NOT AUTHORIZED**.
Owner must separately approve full release SHA, version/protocol, exact archive/
provenance set and limitations (including native pending), and intended visibility/
publication scope. Proposed asset pair is local Windows `d224cf09...` plus hosted
Linux `8d906885...`; selecting hosted Windows needs its own exact-byte physical
evidence. Phase preparation is not policy approval or cut authorization.

Final [release notes](v1.0.0-rc.1.md) SHA256:
`b0e12fa38af8d4f81606dfb1a1074fc1450ba5d81179da8ba2fbe35a732d42a3`;
Git blob `9afae68b8bb28f136350669df508d6627353fc8f`. Review PR records its actual
documentation head; that does not replace selected binary input.

Prepared procedure, **not executed**: fetch/prune; resolve owner-approved full
commit/tree; check `git ls-remote --tags origin refs/tags/v1.0.0-rc.1` and
`gh release view v1.0.0-rc.1 --repo Mert1026/Sentry` for conflicts; rehash approved
assets and inspect manifests; resolve owner gates. Only under a separate explicit
cut instruction, with unchanged configured Git identity, this source's tag commands
would be:

```text
git tag -a v1.0.0-rc.1 8a75e9924a41b98351e46255111fdbfed335f1f0 -m "Sentry v1.0.0-rc.1"
git push origin refs/tags/v1.0.0-rc.1
```

Publication commands must reflect the separately approved visibility. No official
release branch, tag, GitHub Release, official asset upload, main promotion,
self-merge or stable v1.0.0 readiness declaration occurs in this phase.

## Branch hygiene and protocol

Seven historical remote tips are ancestors of selected dev with zero unique
commits. Checked merged PRs, active worktrees and workflow/launcher/runtime name
dependencies; no such named dependencies were found. Nothing was deleted.

| Branch                                 | Behind / unique ahead | Merged PR | Recommendation                       |
| -------------------------------------- | --------------------- | --------- | ------------------------------------ |
| fix/v1-pre-rc-acceptance-preparation   | 21 / 0                | 14        | Eligible only after owner approval   |
| fix/v1-provider-credential-persistence | 16 / 0                | 17        | Eligible only after owner approval   |
| test/v1-owner-acceptance-evidence      | 13 / 0                | 15/16     | Eligible only after owner approval   |
| fix/v1-post-merge-acceptance           | 10 / 0                | 18        | Eligible only after owner approval   |
| fix/v1-g10-recovery-acceptance         | 6 / 0                 | 19        | Eligible only after owner approval   |
| test/v1-final-host-acceptance          | 3 / 0                 | 20        | Eligible only after owner approval   |
| release-prep/v1.0.0-rc.1               | 1 / 0                 | 21        | **Retain: active existing worktree** |

Never delete main/dev, active release/worktree branches or tags. Cleanup does not
delay this handoff. `shux contract` was attempted first but absent on Windows and
WSL; task status, ledger and handoff are maintained directly in the isolated
preparation branch. A managed helper stalled scanning ignored primary-checkout
files; its task-owned scan was stopped and a separate Git worktree used. Build
source and gates were unaffected.

Scoped review found no introduced correctness, data-loss/security, lifecycle or
regression blocker. No new architecture/schema/dependency/application change is
proposed. Remaining gates are bounded owner decisions and disclosed native evidence.
