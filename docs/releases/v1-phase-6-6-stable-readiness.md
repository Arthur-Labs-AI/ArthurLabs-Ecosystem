# Phase 6.6 — Windows v1.0.0 stable readiness

## A. Selected baseline

Owner-merged security PR [#27](https://github.com/Mert1026/Sentry/pull/27):
`2fa19152a63f0886d14f2f2e81db9598ec878f86`, complete tree
`7245d16460de8842a21afc6a92bf94d567d0fe60`. This was the exact initial
`origin/release/v1.0.0-windows`; its tree equals the final reviewed security head.
No unexpected intervening changes were present. Main remained
`4fd2be9fa3b17370841dbb1d2f0422a2150c62d8`; dev remained
`c6d4769bf3179d49bb3718074d6c083f52332626`.

| Merged-source workflow                                                                 | Actual conclusion | Disposition                                                                          |
| -------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------ |
| [CI38729929416](https://github.com/Mert1026/Sentry/actions/runs/38729929416)           | SUCCESS           | Quality and Windows passed; native launcher intentionally skipped for Windows target |
| [Distribution38729929436](https://github.com/Mert1026/Sentry/actions/runs/38729929436) | FAILURE           | Build/tests/packaging/extraction passed; only upload-artifact quota failed           |

Gate A passed under the owner's upload-only exception. No product/security or
packaging failure was waived. The primary checkout's existing changes and other
worktrees were preserved. `shux contract` was attempted but unavailable; task,
ledger and handoff records were maintained directly.

## B. Version transition

The complete tracked search classified132 `rc.1` matches before edits. Active
product identities and current expectations changed from `1.0.0-rc.1` to `1.0.0`:

| Files                                                                                                                                                                           | Purpose                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `package.json`; `apps/desktop/package.json`; `apps/runtime/package.json`; `apps/cli/package.json`                                                                               | Root/product application versions                                |
| `apps/cli/src/index.ts`; `apps/desktop/src/main/cli-server.ts`; `apps/runtime/src/runtime.ts`                                                                                   | CLI, Desktop broker and runtime reporting fallbacks              |
| `apps/runtime/scripts/deploy-wsl-runtime.ps1`                                                                                                                                   | Source-runtime deployment version fallback and examples          |
| `scripts/launcher/SentryLauncher.psm1`; `scripts/launcher/launcher-logic.mjs`                                                                                                   | Windows/common source launcher product version/title             |
| `scripts/launcher/commands.ps1`; `scripts/launcher/commands2.ps1`                                                                                                               | Windows source setup/status/doctor titles                        |
| `scripts/launcher/linux/launcher.sh`; `scripts/launcher/linux/lib/common.sh`; `scripts/launcher/linux/commands/setup.sh`; `scripts/launcher/linux/commands/status.sh`           | Retained source launcher reporting; no native release activation |
| `apps/cli/tests/cli.test.ts`; `apps/runtime/tests/shutdown-safety.test.ts`; `scripts/launcher/tests/launcher-smoke.ps1`; `scripts/distribution/tests/windows-launcher.test.mjs` | Current-version expectations/packaged setup fixture              |
| `.github/ISSUE_TEMPLATE/bug_report.yml`                                                                                                                                         | Current-version example only; Issues settings unchanged          |

`scripts/distribution/tests/version-consistency.test.mjs` now pins stable1.0.0,
still parses historical beta/RC identities and enforces protocol1. The new stable
contract regression in `scripts/distribution/tests/contract.test.mjs` rejects a
stale RC runtime even after resealing inventory. Stable-version assertion was
demonstrated RED before reconciliation and GREEN afterward. Changed expectations
follow the explicitly authorized version specification; no assertion was weakened.

Archive filenames/manifests derive from committed root identity; Desktop embeds
matching package/build metadata and runtime consumes release identity. No cosmetic
ZIP rename or separate identity path was introduced. Internal library packages
retain their existing0.1.0 versions; they are not independently released products.

Pinned pnpm9.12.3 lock-only reconciliation produced **no lockfile change**. Frozen
installation passed. Lock SHA256 remains
`a36aebfc003cd12076ed63613c05b07e6fa416d3c3f52a54d4f86ac3f3e4683a`.
Runtime protocol remains **1**. Schemas, migrations, provider/model/SDK/tool pins,
RPC, credentials, history and orchestration production contracts are unchanged.

README, active install guide, changelog and branching examples now describe direct
stable preparation. [Stable notes](v1.0.0.md) cover requirements and limitations.
Historical RC handoffs gained a supersession notice; original historical bodies,
source identities and hashes remain byte-identical suffixes. Beta notes and adopted
recovery-policy record are unchanged. No public RC existed or is planned.

## C. Validation

All figures below are newly executed in Phase6.6, rather than copied Phase6.5 counts.
The private audit retains commands, outputs, source-overlay hashes and failure logs.

| Gate                                                      | Actual result        | Execution evidence                                                                                                                              |
| --------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen install, hygiene, format, lint, types, build, diff | PASS                 | Windows gate receipts; fresh isolated WSL gate log                                                                                              |
| Complete Windows Desktop                                  | PASS478 / SKIP3      | `pnpm --filter @qa/desktop exec vitest run --maxWorkers=2 --minWorkers=1`; all42 maintenance helper/command cases included                      |
| Windows distribution                                      | PASS34 / SKIP27      | `pnpm distribution:test`; platform skips retained, packaged PowerShell WSL forwarding included                                                  |
| Windows launchers / DeepSeek selection                    | PASS                 | Decision-logic, PowerShell smoke/behavior/IO/shutdown and dsh selection/SDK fixtures                                                            |
| Complete Linux/shared suite                               | PASS1298 / SKIP49    | `pnpm exec turbo run test --force --concurrency=2 -- --maxWorkers=1 --minWorkers=1`;40 uncached tasks, no excluded package/trust file           |
| Actual WSL systemd/bubblewrap trust                       | PASS8/8              | `pnpm --filter @qa/run-engine exec vitest run tests/verification-trust.test.ts --maxWorkers=1 --minWorkers=1`, separately and within full suite |
| Linux distribution                                        | PASS52 / SKIP9       | `pnpm distribution:test` on Ubuntu/WSL                                                                                                          |
| Real Windows→WSL maintenance lifecycle                    | PASS1/1              | Explicit disposable runtime entry; shutdown/reconnect same transport/data, OS compaction mocked                                                 |
| Initial stable-head hosted CI                             | SUCCESS              | [CI38732769947](https://github.com/Mert1026/Sentry/actions/runs/38732769947), source `40ae67c6581acdfcc16583e7c9fe7b0f46b0cc1e`                 |
| Initial stable-head hosted distribution                   | FAILURE: upload only | [Run38732769921](https://github.com/Mert1026/Sentry/actions/runs/38732769921); packaging/extraction passed                                      |

The Linux test install used `--ignore-scripts`; this shared-runtime check does not
claim native Electron provisioning. Hosted quality could not mount actual sandbox
trust; capable local WSL supplied the real8/8 proof. Documented platform/live skips
were preserved; no funded provider campaign was run.

The actual new ZIP passed packaged setup with explicit `wsl` mode, visible Electron
launch, matched stable1.0.0/fullSHA/protocol1, graceful stop and fresh reopen. Private
process arguments added only explicit Electron profile/CDP and a bwrap home bind;
archive code, actual bootstrap/build/activation and runtime RPC were unchanged.
An inode equality assertion proves the empty Linux home bind before setup.

Production renderer/preload/IPC and disposable data passed import/list refresh,
removal Cancel and confirm, managed-file cleanup, missing-folder removal, original
source preservation, fresh-process empty list and two-import history continuity.
Synthetic Windows DPAPI settings persisted through restart; encrypted storage,
no plaintext in profile/archive/output, and fresh credential diagnostics passed.
Maintenance confirmation/Cancel/Escape retained a connected runtime; no OS
maintenance was confirmed. The actual packaged helper/encoded-command function
passed read-only Ubuntu disk inspection and nonexistent-registration refusal.

Phase6.5 fixed inline execution, private ACL/owner/reparse checks, strict correlated
HMAC receipts, exclusive CreateNew/atomic no-replace publication, SID/disk checks and
busy/cancellation/reconnect guards are unchanged and covered by the Windows suite.
No real elevation, trim, shutdown-for-compaction or compact operation was invoked.

One private harness failure was corrected: a dot-sourced launcher redefined the
WSL proxy, initially selecting the normal runtime directory. The previous
`runtime/current` target `1.0.0-rc.1-f9c2a4796f35-isolated` was restored exactly
after stopped-process checks; the newly staged directory/log were retained.
No owner project/credential data was used. A concurrent lifecycle attempt correctly
refused during that installer maintenance lock; it passed after setup completed.
This is retained as failed isolation/fixture evidence, not hidden as a product pass.

Previous owner-reported3/3 agent success and working removal retain their original
pre-transition attribution in [local-fix acceptance](local-fixes-and-storage-cleanup.md).
Prior large-project evidence is reused only for unchanged behavior. **Clean Windows
machine provisioning and real elevated compaction are UNVERIFIED in this phase**;
prepared-host acceptance and mocked privilege fixtures do not substitute for them.

## D. Stable artifact and provenance completion rule

The first physically accepted stable archive was built from clean committed input:

| Field                       | Initial accepted stable review candidate                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full source                 | `40ae67c6581acdfcc16583e7c9fe7b0f46b0cc1e`                                                                                                           |
| Complete tree               | `6322dab8cff61d912c187be503d9ee4b30d98bbf`                                                                                                           |
| Filename                    | `sentry-1.0.0-40ae67c6581a-windows-x64.zip`                                                                                                          |
| ZIP SHA256                  | `bd6be725124f1341926c87dc5222e040ea2d77195b9627344df6f8d5b9a91912`                                                                                   |
| Manifest SHA256             | `97cf5c2871444a455809ddca8469a313e9557840ed74181c2a7750b7843c5b90`                                                                                   |
| Inventory                   | 332 files; full validation PASS                                                                                                                      |
| Version / protocol / target | 1.0.0 /1 /windows-x64                                                                                                                                |
| Extraction                  | Complete external extraction, matching sidecar/manifest/components, required source inclusion/private-file exclusion, no stale RC product components |
| Physical scope              | Prepared Windows11 + Ubuntu WSL; real packaged setup/visible launch/reopen, disposable UI/DPAPI/history, read-only helper/refusal                    |
| Availability                | Private local archive; not a successfully hosted download or official asset                                                                          |

This tracked receipt update creates a different commit from the archive above.
**It must receive a fresh final-PR-head build, extraction, matched-runtime and
bounded packaged acceptance before review completion.** The final exact-head full
SHA/tree, filename, ZIP/manifest hashes, inventory, acceptance and CI are recorded
in [PR28's final companion receipt](https://github.com/Mert1026/Sentry/pull/28)
and private `sentry-phase66-20261015/artifact-receipt.json` / `final-verification.json`.
Those are post-commit records, avoiding a self-referential commit/hash/rebuild loop.
They must identify the final PR head, rather than relabel the first archive above.

Neither PR-head archive is the final public distribution. Owner merge, later main
promotion and actual final-source rebuild require new matching bytes/hashes.

## E. Open risks and trusted delivery

No confirmed unresolved stable-product/security/data-integrity/packaging defect
was found by these checks. GitHub Actions delivery remains blocked: upload quota
failed after successful extraction. Actual distribution conclusions remain FAILURE.
Billing inspection returned404/missing user scope; repository read/push/admin
permissions do not prove asset-upload success. No token-scope/settings change,
additional artifact/branch deletion, workflow disabling or manual quota rerun occurred.

If the final automatic workflow still fails only upload, retain its logs and the
separately verified private final-head archive. Later, after explicit publication
authorization and final-main source verification, authenticated `gh release upload`
can be attempted for the authorized stable Release ZIP/sidecar without overwriting
assets. Download them through the real published route, rehash against the trusted
receipt and validate inventory/source. This alternative is **UNVERIFIED** until
actual permitted upload/download succeed; no public asset was uploaded now.
Trusted delivery remains a hard publication requirement.

Known limitations: unsigned ZIP, online WSL bootstrap, manual prerequisites/updates,
no signed MSI/MSIX/EXE installer, no automatic updater and native Desktop deferred.
Third-party provider charges may apply; reclaimable disk space is not guaranteed.
Adopted Recovery Option A remains historical corrected Windows/I1 source
`c78faa74717b0f430a859730e98c3c4915e7b03f`, paired stopped backups and same-account,
same-machine/DPAPI scope. No schema/profile migration, credential deletion,
cross-account assumption or automatic downgrade was introduced. Original-beta
credential rollback remains FAIL; native recovery remains separately unverified.

## F. PR status

[PR28](https://github.com/Mert1026/Sentry/pull/28),
`release-prep/v1.0.0-stable` → `release/v1.0.0-windows`.
Changes are version/reporting metadata, two version/identity regressions, active
release documentation and preserved-history task receipts. Lock/pins/security
production code are unchanged. Final exact-head CI/delivery conclusions live in
the companion receipt after this documentation commit. Owner review and merge
are required; no self-merge or auto-merge is enabled.

## G. Final recommendation

**CONDITIONALLY READY**: engineering and prepared-host acceptance passed for the
initial stable candidate. Complete the final-head provenance/acceptance receipt;
hosted trusted delivery remains blocked or unverified until an actual successful
upload/download. Publication is a later owner decision. This is not a claim that
all release/publication gates passed.

After owner stable-preparation merge: verify actual release SHA/tree and CI,
fresh archive, review release-versus-main without losing main-only changes, and
prepare the later owner-reviewed promotion PR. After owner main merge, verify and
build that exact source. Only separately explicit Phase6.8 authorization may create
the annotated `v1.0.0` tag and stable GitHub Release/assets, verify download and
propagate approved changes to dev. None of those actions was performed here.
