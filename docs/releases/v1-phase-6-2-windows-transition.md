> Historical preparation record, superseded for current release decisions by
> [Phase 6.6 stable readiness](v1-phase-6-6-stable-readiness.md) and
> [v1.0.0 stable notes](v1.0.0.md). Original source/version/hash and test receipts
> below retain their historical scope. No public RC was published.

# Phase 6.2 — Windows-only release transition

Snapshot: October 14, 2026, Europe/Sofia. Review preparation only; no official RC
tag, publication, main promotion or long-lived branch creation is authorized here.

## Verified starting baseline

| Item                  | Observed value                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| Remote main           | `4fd2be9fa3b17370841dbb1d2f0422a2150c62d8`                                                                |
| Remote dev            | `62b474e53ae56a2fc12365c0140b2fa69fad3a51`                                                                |
| Latest integrated PR  | [#22](https://github.com/Mert1026/Sentry/pull/22), owner merge October 14, 2026                           |
| Dev CI                | [38550449757](https://github.com/Mert1026/Sentry/actions/runs/38550449757), completed/success, three jobs |
| CI trust limit        | Hosted quality used its existing sandbox-unavailable lane; actual trust is a separate local gate          |
| Open PRs at preflight | None                                                                                                      |
| Published release/tag | Historical `v0.1.0-beta.1` only; no RC release/tag                                                        |
| Product / protocol    | `1.0.0-rc.1` / `1`, unchanged                                                                             |
| Primary checkout      | Dirty local main `9c57e3f`; owner changes preserved, not committed here                                   |
| Task                  | Isolated `release-prep/v1-windows-only-scope` from latest approved dev; PR targets dev                    |

`shux contract` was attempted before work, but shux is absent on PATH and in WSL.
Protocol task status, append-only ledger and handoff are maintained directly.
The managed worktree helper stalled in repository scanning; a separate normal
Git worktree was used without changing the owner checkout.

## Implemented release contract

Initial supported release target: **Windows 11 x64 with WSL2**, Ubuntu preferred.
Native Linux Desktop: **DEFERRED — FUTURE NATIVE LINUX RELEASE**. Native source,
launcher tests, packaging capability and historical results/failures are retained.
Windows Electron still uses the Linux runtime through WSL2; no production
architecture, provider/model/SDK pins, lockfile, schema or protocol change.

Windows archive generation is its own `Windows release archive` job. The
separate native development archive workflow retains CachyOS-target builds and
extraction checks. Native launcher validation remains on shared integration,
with the frozen Windows release branch excluded from native-only gates.
The Ubuntu `quality` job and every existing shared runtime, harness, persistence,
copy/hash and sandbox prerequisite test remain required. Real sandbox trust
must run on a capable host; hosted fallback is not a containment PASS.
Complete Windows Desktop tests also run in the Windows launcher job.

Official Windows assets are the unsigned online-bootstrap ZIP, trusted SHA256
information and release documentation. Workflows only retain private review/
development artifacts; no workflow publishes a release.

## Deferred native development and recovery

The owner declined GitHub Issues; the dedicated
[native import tracker](native-linux-large-import.md) preserves uncertainty,
post-timeout safety and regression/acceptance criteria. A shared defect proven
on Windows remains a release blocker. No native fix or timeout change is made.

Recovery Option A is already adopted for exact corrected historical I1
`c78faa74717b0f430a859730e98c3c4915e7b03f`, not this RC. Matching stopped backup
generations, full pre-replacement verification, retained originals, compatible
schema and the tested account/machine/DPAPI context remain required. Original-beta
G10 remains FAIL; no plaintext fallback, automatic schema downgrade or key
portability guarantee. Native G10-R is deferred with native release acceptance.

## Executed verification

Tests ran on implementation commit `aced9ccb57b664f5ee38280e8dfc72a8635d58d5`.
Later receipt-only changes do not become that artifact's source identity. Final
review-head CI is recorded in [PR #23](https://github.com/Mert1026/Sentry/pull/23).

| Gate                          | Actual result and evidence                                                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen install                | PASS: `pnpm install --frozen-lockfile` on Windows and native WSL filesystem                                                                                                         |
| Repository/static/build       | PASS: repository:check, format:check, lint, typecheck, build, git diff --check on Windows/WSL; Windows Turbo static/build initially cached, packaging forced all 20 builds uncached |
| Complete applicable suite     | PASS: WSL `pnpm exec turbo run test --force --concurrency=1 -- --maxWorkers=1 --no-file-parallelism`, 1,236 passed / 16 skips, 40 uncached tasks                                    |
| Actual sandbox trust          | PASS: separate `pnpm --filter @qa/run-engine exec vitest run tests/verification-trust.test.ts --maxWorkers=1 --no-file-parallelism`, 8/8 real systemd sandbox cases                 |
| Windows Desktop               | PASS: `vitest run --maxWorkers=1 --minWorkers=1`, 400 passed / 2 existing skips, 51 files                                                                                           |
| Distribution/security         | PASS: `pnpm distribution:test`, Windows 26 passed / 27 platform/capability skips; WSL 50 passed / 3 skips (Windows validator and two unavailable-fish cases)                        |
| Windows launcher              | PASS: Node launcher logic 20/20; PowerShell syntax, smoke, behavior, IO stress, shutdown safety and distribution maintenance                                                        |
| Native/shared shell fixtures  | PASS: all 23 `scripts/launcher/tests/test-*.sh` scripts, including sandbox prerequisites, readiness/tooling and native launcher fixtures                                            |
| Implementation-head CI        | PASS: [38566292232](https://github.com/Mert1026/Sentry/actions/runs/38566292232), quality plus both launchers; hosted real trust remains separately unverified                      |
| Windows archive CI            | PASS: [38566292342](https://github.com/Mert1026/Sentry/actions/runs/38566292342), independent Windows release archive                                                               |
| Native development archive CI | PASS: [38566292740](https://github.com/Mert1026/Sentry/actions/runs/38566292740), development evidence only                                                                         |
| Archive/runtime/GUI           | PASS: complete inventory/extraction, isolated online bootstrap, exact handshake and bounded large import/reopen/shutdown below                                                      |
| Owner merge/post-merge source | UNVERIFIED / pending owner integration; required before long-lived branches and final RC build                                                                                      |

The full suite retains orchestration, Full/Targeted selection, all harnesses,
project copy/hash integrity, persistence, credential handling, history/export,
recovery and cancellation regressions. No assertion or security gate was weakened.
The 16 full-suite skips are 7 Claude harness, 8 OpenCode harness and 1 Desktop
platform/capability cases; Windows Desktop has its separate 2 platform skips.

Retained non-passing attempts: initial Windows workers/PowerShell fixtures exhausted
host memory; after owner cleanup the unchanged tests passed with bounded workers.
A private WSL runner started before clone checkout finished, then passed from the
complete source; its final shell loop needed LF normalization and all 23 shell
fixtures subsequently passed. The first isolated runtime bootstrap was interrupted
on the owner's disk-cleanup pause. Fresh bootstrap passed. GUI observation harness
initially hid its window, then encountered a null body during renderer startup;
both attempts were stopped gracefully before any import. Corrected private harness
then executed exactly one import. These are retained environment/harness attempts,
not reproduced application defects or suppressed failures.

## Exact Windows review artifact

| Field                        | Verified value                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full source                  | `aced9ccb57b664f5ee38280e8dfc72a8635d58d5`                                                                                                               |
| Complete source tree         | `73bb89f777ad4373e7087cdd00de03fc2facf845`                                                                                                               |
| Root/Desktop/runtime version | `1.0.0-rc.1`                                                                                                                                             |
| Runtime protocol             | `1`                                                                                                                                                      |
| Dependency-lock SHA256       | `a36aebfc003cd12076ed63613c05b07e6fa416d3c3f52a54d4f86ac3f3e4683a`                                                                                       |
| Archive filename             | `sentry-1.0.0-rc.1-aced9ccb57b6-windows-x64.zip`                                                                                                         |
| Archive SHA256               | `510ce4c9ca477cc3c5ffe6e5ea20c69cb126d46350cd769c1452d71d7874871d`                                                                                       |
| Manifest SHA256              | `d6746440cc37aed7812645704fd27de106b65636e90c22cbec8a8372a8ed03ca`                                                                                       |
| Build host/toolchain         | Windows 11 x64 build 26200; Node 24.13.1; pnpm 9.12.3; Electron 36.2.1; electron-builder 26.0.12; esbuild 0.21.5                                         |
| Inventory/extraction         | PASS: all 332 per-file SHA256 entries, required files, sidecar, complete extraction and three component identities; archive launcher version revalidated |
| Runtime bootstrap            | PASS: this archive's unchanged frozen Linux bootstrap in a fresh isolated install home; Node 22.23.2; pre-activation and active handshake checks passed  |
| Desktop/runtime handshake    | Same full source above, version rc.1, protocol 1; Linux standalone runtime, not Electron                                                                 |

Required inventory includes root/runtime/Desktop build identities, runtime host
source and lock, bootstrap and validator, Desktop main/preload/renderer/icon,
Sentry.exe and sentry.ps1. The full list and each file hash are in the validated
manifest. This is an **unsigned online-bootstrap review ZIP**, not the final
post-merge RC. Hosted builds are separate bytes; their checksums must not be
substituted for this physically tested local ZIP. Historical `8a75e992` /
`d224cf09...c51d96` evidence remains distinct.

## Bounded packaged Windows large-import receipt

Actual path: Windows packaged Electron → mounted Projects GUI / Add by path →
Desktop IPC → WSL Ubuntu runtime → ProjectManager → managed copy → retained
immutable material and persisted revision. Native Windows input/clicks and
rendered observations were exercised; read-only CDP instrumentation measured
state/response timing. Profile, runtime install home and data root were disposable
and separate from owner stores. No owner credentials or paid provider calls.

| Observation                        | Actual result                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workload                           | 5,000 nested source modules, package.json, README and a fully written deterministic 1 GiB binary                                                                   |
| Included totals                    | 5,003 files, 102 directories, 1,073,875,836 bytes                                                                                                                  |
| Fixture asset SHA256               | `1438e13a5e87f3798f2425fa13a92988825451a9c45c394ef8fa2523508157d1`                                                                                                 |
| Exclusions                         | Default version 2; sentinels in node_modules, dist, .git, nested node_modules and debug.log were all absent from both retained trees                               |
| Start / terminal observation (UTC) | 2026-10-14 14:06:48.657 / 14:07:52.259; native GUI click at 14:06:48.252                                                                                           |
| Import result                      | PASS, 63,601 ms from first pending observation; no timeout or retry                                                                                                |
| UI responsiveness                  | Elapsed display updated; sidebar collapsed while pending; 122 pending observations, maximum read response 56 ms                                                    |
| Automatic project appearance       | PASS: READY card appeared without refresh; one project and zero QA runs                                                                                            |
| Persisted revision                 | `rev_01M4XBSDNMJVYB03G3N5NKF5GE`, hash version 2, matching file/byte totals                                                                                        |
| Material integrity                 | Source, managed copy and immutable material all rescan to `ee0d072d46d99e4b1f540190db067e8096502caca38aef6dfa163611cbc61a3b`; immutable asset has a distinct inode |
| Reopen/history                     | PASS: fresh Desktop/runtime process retains same project, revision/hash and empty run history; reopened dashboard shows the project                                |
| Graceful shutdown                  | PASS twice through supported --sentry-control=stop; exit 0, no task-owned Desktop/runtime left running                                                             |

The fixture source was on the WSL Linux filesystem, supplied through the Windows
GUI. This establishes the complete packaged Windows/IPC/runtime path for that
workload; it does not claim a 1 GiB NTFS-cross-filesystem test, native CachyOS
acceptance or equivalence to the owner's unknown native project contents. The
fixture was initially prepared sparse during the disk pause, then fully written
before this single import; the tested asset was dense. No comparable Windows
import defect was reproduced. The native tracker remains OPEN and deferred.

Private receipts, harnesses and failed attempts are retained under the owner's
local Codex artifacts directory, sentry-phase62-20261014; worktree dist/phase62
and WSL /var/tmp/sentry-phase62-evidence contain gate logs. Only sanitized summary
information is included here.

## Assessment

**CONDITIONALLY READY.** Windows scope transition, review packaging, shared
automated/security gates and the bounded packaged GUI import passed. Scoped
review found no introduced correctness, data-loss/security or lifecycle blocker.
Owner integration, post-merge CI/source approval and a new exact-source Windows
RC build remain. Long-lived branches have not been created from an unapproved
PR head. Official publication and stable promotion still require separate
explicit authorization. Native acceptance is deferred, not converted to PASS.

## Post-merge procedure and stop boundary

1. Owner reviews and merges this scope PR into dev; agents do not self-merge.
2. Fetch the actual merge, verify post-merge Windows/shared gates and record full
   SHA/tree, root/Desktop/runtime versions, protocol and dependency-lock SHA256.
3. Use the [prepared branch commands](../development/branching.md#windows-v1-and-native-development-branch-creation)
   only after source approval and checking existing local/remote refs.
4. On a clean committed Windows x64 checkout of that actual source, run frozen
   install, repository/static/build/tests, real WSL trust and `pnpm distribution:test`,
   then `pnpm distribution:build windows-x64`. The existing builder recompiles
   committed source, refuses dirty input/overwrite, validates every inventory
   checksum and revalidates complete extraction. Record archive/manifest/lock
   hashes, tree, host/toolchain and matching Desktop/runtime identity.
5. Evaluate that new archive through packaged GUI/IPC with disposable data,
   verify revisions/material, reopen/history and graceful shutdown. Keep hashes
   distinct from this PR's review build and any hosted variant.
6. Owner separately authorizes exact RC source/assets/publication. No official
   tag, GitHub Release, asset publication or stable promotion happens in this task.
