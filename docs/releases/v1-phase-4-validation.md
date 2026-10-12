# Phase 4 distribution validation — review candidate

2026-10-12. **Implementation available for review; Phase 4 acceptance is not
closed.** No stable release, tag, signing, merge or funded provider execution.
Product/package versions remain `0.1.0-beta.1`; protocol remains 1. OpenCode
1.18.32, DeepSeek SDK 0.1.5-rc.2 and Claude Code 2.1.270 remain pinned.

## Baseline and ownership

Approved `origin/main`: `76257348a86406c8605f8f49cf17652c1dca75fa`, incorporating
owner-merged PR #5. [Main CI 38216565256](https://github.com/Mert1026/Sentry/actions/runs/38216565256)
completed SUCCESS: quality and both launcher jobs. Hosted sandbox mounts were
unavailable; that workflow did not prove real isolation.

Branch `codex/v1-release-packaging` uses the isolated Windows checkout
`C:\Users\merte\.codex\worktrees\v1-release-packaging\Sentry` from that main.
The owner's dirty primary checkout (9c57e3f), unrelated DeepSeek/schema work and
PROJECT_GUIDE.md remain untouched. Configured Git identity is preserved.
Managed checkout creation succeeded, but app attachment failed; the verified
checkout was used directly. `shux contract` was attempted on Windows and Ubuntu
and is unavailable; task status, ledger and handoff are maintained directly.

## Architecture and implementation

The [assessment](v1-phase-4-packaging-assessment.md) was committed before
implementation. Chosen formats: versioned Windows ZIP and CachyOS-targeted Linux
tar.gz, with a self-contained Electron Desktop and explicit **online** Linux
runtime source bootstrap. No tester Git checkout or Windows Node/pnpm is needed.
Linux Node >=22, pnpm 9.12.3, systemd user services, bubblewrap, socat and host
prerequisites remain external. [Installation/acceptance commands](../setup/distribution.md)
cover each supported host, private delivery, repair, migration and uninstall.

| Production/build file                                                             | Change, installation effect and compatibility boundary                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`, `pnpm-lock.yaml`                                                  | Build/test entry points and direct pinned esbuild 0.21.5 dependency; existing dependency pins retained. Maintainer build only.                                                                                                                                                                                                                                                                           |
| `scripts/distribution/build.mjs`                                                  | Native x64, clean committed input; captures SHA before forced transitive build and rejects changed HEAD/tree before receipt. Dedicated dependency-free electron-builder staging; only Electron/Node main externals allowed. Copies tracked payload through `git show`, excludes tests/private/generated files, creates inventory/checksum, extracts and revalidates. Never overwrites a same-SHA output. |
| `scripts/distribution/contract.mjs`                                               | Manifest/identity, required-file, inventory/hash, unsafe-path/private-file/symlink rejection. Shared Node build/install validation, independent of Git.                                                                                                                                                                                                                                                  |
| `scripts/distribution/verify.mjs`, `verify.ps1`                                   | Git-less installed validation; Windows version/install checks require no Node. PowerShell uses .NET SHA256 and terminating errors.                                                                                                                                                                                                                                                                       |
| `scripts/distribution/release.ps1`                                                | Archive Windows commands, existing WSL selection/reboot/config mechanisms, graceful maintenance, separate tool provisioning; update refuses development main. Source launcher unchanged.                                                                                                                                                                                                                 |
| `scripts/distribution/release.sh`                                                 | Archive CachyOS commands, GUI/host checks, packaged control/open, existing managed tool installers; no global source shim replacement. Native execution remains unverified here.                                                                                                                                                                                                                         |
| `scripts/distribution/bootstrap-runtime.sh`                                       | Verify target/prerequisites; stopped-runtime checks, exclusive maintenance lock, unique Linux-owned staging, real candidate hello, atomic current replacement, active hello and rollback. No hidden sudo or data deletion.                                                                                                                                                                               |
| `scripts/distribution/runtime-check.mjs`                                          | Real stdio hello/shutdown on disposable data; protocol/version/full SHA/Linux/non-Electron/Node >=22 checks and bounded output/time. No provider operation.                                                                                                                                                                                                                                              |
| `scripts/distribution/maintenance.mjs`, `maintenance.ps1`, `check-maintenance.sh` | Conservative process refusal including relative runtime entries; Windows requests owned graceful Desktop control and waits. No broad killing. Concurrent source/release maintenance remains prohibited.                                                                                                                                                                                                  |
| `apps/runtime/scripts/deploy-inner.sh`                                            | Validated safe deployment version and optional stage-only mode; release candidates cannot overwrite old destinations. Optional generated identity copied. Existing default source activation retained.                                                                                                                                                                                                   |
| `apps/runtime/src/distribution.ts`                                                | Read/validate generated release identity; missing metadata retains legacy source mode, malformed metadata fails closed.                                                                                                                                                                                                                                                                                  |
| `apps/runtime/src/runtime.ts`                                                     | Release version/SHA in hello; source beta version retained when metadata is absent. No QA/provider/persistence change.                                                                                                                                                                                                                                                                                   |
| `apps/runtime/src/host.ts`                                                        | Refuse launch during release maintenance; explicit validation requires a supplied disposable data root.                                                                                                                                                                                                                                                                                                  |
| `packages/runtime-protocol/src/protocol.ts`                                       | Strict shared release identity and additive optional hello SHA; protocol 1 and legacy source clients retained.                                                                                                                                                                                                                                                                                           |
| `apps/desktop/src/main/distribution.ts`                                           | Preserve `@qa/desktop` userData and require matching release runtime version/full SHA.                                                                                                                                                                                                                                                                                                                   |
| `apps/desktop/src/main/index.ts`                                                  | Packaged identity command, source-beta userData/single-instance scope, ignore development renderer URL in packaged mode. Production resource layout and secure BrowserWindow settings retained.                                                                                                                                                                                                          |
| `apps/desktop/src/main/bootstrap.ts`                                              | Startup/reconnect reject mismatched runtime and stop owned transport; source metadata-free operation retained.                                                                                                                                                                                                                                                                                           |
| `scripts/launcher/linux/lib/agents.sh`                                            | Read SDK source pin when available; otherwise existing pin fallback works in archive layout. Source behavior preserved.                                                                                                                                                                                                                                                                                  |
| `.github/workflows/distribution.yml`                                              | Native Windows/Linux candidate build/extraction fixtures on exact PR head; private unsigned review artifacts, seven-day retention. Read-only contents permission; never releases/tags/pushes. Existing three CI checks unchanged.                                                                                                                                                                        |

`smoke.mjs` executes the actual packaged Windows binary via local CDP with isolated
APPDATA/LOCALAPPDATA/TEMP/TMP and stripped provider variables. Its optional history
receipt exercises retained beta records. `tests/beta-history.mjs` seeds a new temp
database using the published beta implementation; it accepts no existing database.
These acceptance helpers and all tests are excluded from distribution payloads.

The independent-agent pipeline, historical Merger/Verifier compatibility, database
schema, provider versions, encryption and Electron isolation were not refactored.

## Actual artifact receipts

Both reviewed artifacts below were built from
`c2a28c99ba163e22ad988fe8a67ddd783f7a79b0`. Subsequent report
changes do not alter their payloads. CI candidates identify their own later head;
do not substitute CI checksums for these local bytes.

| Actual filename                                       | SHA256                                                             | Build / extraction                                         | Launch / installation                                                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `sentry-0.1.0-beta.1-c2a28c99ba16-windows-x64.zip`    | `96025345f7d998f039a164e26bcedbbb89b419d17b777a7be1b1136737e0dd4a` | PASS, Windows native x64; 332 inventoried payload files    | PASS actual Windows production Electron + actual WSL runtime, temporary data; bootstrap upgrade PASS; fresh Windows provisioning UNVERIFIED |
| `sentry-0.1.0-beta.1-c2a28c99ba16-cachyos-x64.tar.gz` | `125dd6022859185c55934140452ba94462a0d8605a9644b0d04f2f60be46076c` | PASS, Linux x64 under Ubuntu WSL; extracted inventory PASS | Native GUI/install: ENVIRONMENT UNAVAILABLE; portable bootstrap fixtures PASS                                                               |

Windows outputs are in the isolated checkout's ignored `dist/distributions`;
Linux outputs in `/var/tmp/sentry-phase4-validation.9OrWhh/dist/distributions`.
Companion `.sha256` files exist. Archives/binaries are not committed. Earlier
30f9c81/7a13850/ed48586 artifacts were built/extracted too; they are superseded candidates.
No official or public assets were uploaded by these local commands.

Build hosts: Windows 11 Home x64 build 26200, Node 24.13.1/pnpm 9.12.3; Ubuntu
WSL2 x64 kernel 6.6.87.2-microsoft-standard-WSL2, Node 22.23.2/pnpm 9.12.3.
Electron 36.2.1/electron-builder 26.0.12 used on both hosts. Builds force all 20
workspace build tasks, avoiding stale ignored dist. Build provenance is repeatable;
byte-for-byte reproducibility across hosts/tool versions is not claimed.

## Gate results

| Gate / command                               | Result and scope                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`             | PASS Windows and native WSL filesystem checkout                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pnpm repository:check`, `pnpm format:check` | PASS on both hosts at implementation verification; final report formatting checked separately                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm lint`, `pnpm typecheck`                | PASS both hosts: 20 lint / 37 typecheck tasks                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm build`                                 | PASS both hosts: 20 tasks; each reviewed artifact additionally forced all 20 builds                                                                                                                                                                                                                                                                                                                                                                            |
| `pnpm test` on WSL                           | PASS: 40 tasks, 1,155 tests passed / 16 opt-in or platform skips; build dependencies cached, test tasks executed. Runtime 73, Desktop 320/1 skip, engine 86, persistence 30.                                                                                                                                                                                                                                                                                   |
| `pnpm test` on Windows                       | FAIL: unchanged many-file snapshot fixture exceeded 5,000 ms under concurrent execution; initial 28/37 tasks and retry 31/40 before abort. Focused rerun PASS 4/4. Serialized full diagnostic passes snapshot 4/4 but fails engine 6/86 Linux trust cases (systemd user tools unavailable, cleanup EBUSY); 33/37 tasks before abort. These trust cases pass on WSL. No assertions/deadlines/exclusions changed; native Windows full-suite pass is not claimed. |
| Focused Windows Desktop/runtime              | PASS: Desktop 319/2 platform skips, runtime 72/1 platform skip                                                                                                                                                                                                                                                                                                                                                                                                 |
| Existing Windows launcher Node fixtures      | PASS 20/20                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Existing Windows PowerShell suites           | PASS launcher-smoke, launcher-behavior, io-stress, shutdown-safety                                                                                                                                                                                                                                                                                                                                                                                             |
| Existing Linux launcher shell suites         | PASS all 21 `test-*.sh` scripts, including update, deployment, shutdown/desktop, managed tools and sandbox prerequisites                                                                                                                                                                                                                                                                                                                                       |
| New `pnpm distribution:test`                 | Windows PASS 7/10 platform skips; WSL PASS 16/1 platform skip (17 total). Real validators/bootstrap orchestration, fixture host/tool/build/RPC boundaries.                                                                                                                                                                                                                                                                                                     |
| New Windows maintenance / parser             | PASS four maintenance scenarios and all new PowerShell syntax parses                                                                                                                                                                                                                                                                                                                                                                                           |
| Real sandbox                                 | PASS WSL full suite's eight real `verification-trust` tests, including containment/secret/child-process proofs; systemd user and bubblewrap initialization available. Hosted CI mount limitation remains separate.                                                                                                                                                                                                                                             |
| Real packaged Windows smoke                  | PASS reviewed c2a28c9 binary, production file renderer, preload, renderer has no require/process, invalid IPC rejection, exact Linux hello, project import, single instance and graceful control stop                                                                                                                                                                                                                                                          |
| Native CachyOS / clean Windows               | ENVIRONMENT UNAVAILABLE / UNVERIFIED respectively; existing configured Windows host is not a fresh machine                                                                                                                                                                                                                                                                                                                                                     |
| Funded agent integrations                    | UNVERIFIED, not run or authorized by this phase                                                                                                                                                                                                                                                                                                                                                                                                                |

Fixture tests cover Git-less paths with spaces, tampering, missing preload,
unexpected/private entries, malformed identities/platforms, symlinks, first/repeated
setup, wrong architecture/native distro/pnpm, interrupted lock, build failure,
candidate mismatch, active mismatch with rollback, first-install current removal,
preserved old version and byte-identical synthetic data. Windows maintenance tests
cover idle/active/graceful-failure/still-running boundaries. Existing source update
tests retain development-only semantics; archive update always refuses.

## Real installation, upgrade and beta history

Actual bootstrap ran from extracted Windows artifacts in temporary WSL HOME
`/var/tmp/sentry-phase4-install-home.N0kitv`, with real frozen Linux dependency
installation and all 18 transitive runtime builds. First 30f9c81 install passed;
reviewed ed48586 setup from a Windows extraction path containing spaces passed
candidate and active hello, atomically changed current and retained the previous
30f9c81 deployment. No owner's runtime/data/settings were used as fixtures.
After the hosted short-path correction, c2a28c9 was rebuilt on both local hosts,
extracted and revalidated. Its Windows archive passed version validation and a
real setup from a path with spaces: candidate/active hello matched c2a28c9 and
the prior ed48586 deployment was retained. The actual replacement packaged app
also passed the same production smoke and read the retained beta history.

For history acceptance, cloned immutable `v0.1.0-beta.1` commit
`0e5c10cfa80f6385ebfc88a7306b38ce8a12ce38` into a separate Linux temp checkout,
frozen-installed and built its runtime dependencies (18/18). The beta's actual
persistence implementation created a disposable database with synthetic project,
two revisions/snapshots, completed QA/legacy agent, finding/evidence and historical
issue/completed retest. The reviewed packaged Windows app opened that data with
the new real installed runtime. Production project/run/issue/retest IPC read back
the retained records; finding/evidence identity and completed status passed.
It then imported another synthetic project and stopped gracefully. Closing and
reopening against that same database passed again, including revision identity.
No agent was run.

Reproduce using built beta checkout and extracted reviewed Windows archive:

```bash
node scripts/distribution/tests/beta-history.mjs /path/to/built-beta /tmp/history-receipt.json
```

```powershell
# Read dataRoot from that generated receipt; runtimeEntry must be its matching Linux deployment.
node scripts/distribution/smoke.mjs '<archive-root>' '<linux-runtime-entry>' '<disposable-data-root>' '<receipt-visible-to-Windows>'
```

The first helper attempt rejected an incomplete retest fixture; its distinct
revision/snapshot and terminal timestamps were corrected to satisfy the existing
beta schema. The first history smoke identified a missing managed-copy fixture and
wrong project-list DTO key; fixtures/assertions now follow the existing contract.
No production schema or behavior was changed to accommodate the test.
An additional reopen attempt exposed WSL clearing `/tmp` between VM starts;
the fixture helper now creates its unique disposable database under `/var/tmp`.
Both packaged launch checks against that retained fixture passed. Canonical user
data already lives outside `/tmp`; no production data-path change was needed.

This proves synthetic beta records remain readable across the new layout; it does
not prove migration of real encrypted preferences/keychain state or every historical
artifact byte. The supported migration is explicit stop/private backup/side-by-side
setup and acceptance, preserving the source clone and previous runtime. No automatic
database conversion/downgrade or arbitrary source-install discovery is promised.

Failed candidate/build/active validation and rollback are injected fixture proofs;
real network/build failure rollback was not deliberately induced against a live
installation. Repair never erases user data. After any future schema migration,
restore a compatible stopped backup plus matching executable/runtime rather than
claiming binary rollback reverses data migration.

## Review, limitations and GitHub receipts

Complete scoped diff, new scripts/tests, manifest contents and dependency resolution
reviewed for correctness, data loss/security, lifecycle and source compatibility.
No remaining actionable blocker found within the bounded implementation; the
acceptance gaps below prevent a Phase 4 release-readiness claim. Tracked allowlist,
inventory validation and extracted manifests exclude credentials, private config,
user databases/projects/workspaces/logs, Git metadata and source maps. Checksums
provide integrity through a separately trusted delivery channel, not signatures.

Unsigned PE resource editing is disabled: Explorer may retain Electron executable
metadata/icon; the application window uses the packaged Sentry icon and the app
reports generated release identity. ASAR is disabled for transparent inventory
verification; code-signing/fuses/other Phase 5 hardening are not established here.
Package-builder ASAR warnings and Vite large-chunk warning remain disclosed.
Windows status/doctor validate archive/process identity and print WSL checks;
Environment is still the complete runtime/provider readiness surface.

Outstanding Phase 4 acceptance: actual native CachyOS GUI/install/repair/upgrade;
clean Windows WSL prerequisite/reboot provisioning; real encrypted settings continuity;
active funded QA maintenance/cancellation acceptance if separately authorized; full
supported-host manual matrix. Owner commands are in the installation guide. Phase 5
security acceptance, RC/stable release and signing/publication require later approval.

Implementation commits: `9671d98` assessment, `30f9c81` foundation, `7a13850`
tracked-input/runtime hardening, `ed48586` build race/smoke isolation. Acceptance
helper/report `f2e458c` and repeat-launch fixture correction `303d9c1` follow.
[Draft PR #6](https://github.com/Mert1026/Sentry/pull/6) is pushed and attached.
Its [exact-head checks](https://github.com/Mert1026/Sentry/pull/6/checks) and final
delivery receipts are the source of truth for current CI, without changing local
artifact provenance or claiming unavailable target tests passed. Only this branch
was pushed; no main/tag/release/merge operation occurred.

Hosted Windows packaging initially failed at the PowerShell inventory fixture:
the runner's `RUNNER~1` short path and resolved child paths have different prefix
lengths. The validator previously sliced absolute names using the input root's
length. A relative-root regression reproduced the same failure locally (RED).
It now carries relative directory names during traversal (GREEN, Windows 7/10
platform skips), preserving strict inventory/tamper rejection. Replacement
artifact receipts and final exact-head CI supersede that failed candidate.
The three existing checks passed on prior documentation head 0b4e2aa in
[CI 38230504261](https://github.com/Mert1026/Sentry/actions/runs/38230504261).
Corrected-code CI and final documentation-head checks are recorded on PR #6;
neither that prior success nor local artifact receipts substitute for final-head CI.
