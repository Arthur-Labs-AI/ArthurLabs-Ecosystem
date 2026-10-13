# Version transition for unsigned v1.0.0-rc.1 review

Approved preparation base: `c103509e8f601ef4c4089f9a030711c67348ca32`, tree
`be19e0c691b785ed6ad643dcbe4dd2dbb7fd9597`. Base product/Desktop/runtime/CLI
version0.1.0-beta.1. Intended review version **1.0.0-rc.1**, protocol **1**,
Electron **36.2.1**, pnpm **9.12.3**, standalone Linux Node>=22.

The Phase6.0 instruction permits safe version-specific changes on the review
branch. This patch is applied only to `release-prep/v1.0.0-rc.1`; it does not
create `release/v1.0.0-rc.1`, adopt a recovery policy, activate an update channel,
tag or publish. Metadata review is technically independent of the unresolved
policy decision. Official RC authorization remains pending; the owner may
review/reject the patch without any installed profile/current pointer changing.

## Complete version surface

| Location                                                                        | Transition / authority                                                                                      |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `package.json`                                                                  | Product0.1.0-beta.1→1.0.0-rc.1; primary distribution version                                                |
| `apps/desktop/package.json`                                                     | Electron app metadata/version; must equal root                                                              |
| `apps/runtime/package.json`                                                     | Runtime package metadata; must equal root                                                                   |
| `apps/cli/package.json`                                                         | CLI package metadata; must equal root                                                                       |
| `apps/cli/src/index.ts`                                                         | QA_VERSION / `qa --version` reporting literal                                                               |
| `apps/runtime/src/runtime.ts`                                                   | Source fallback RUNTIME_VERSION; packaged runtime uses validated build identity                             |
| `apps/desktop/src/main/cli-server.ts`                                           | Broker product-version default; protocol/dispatch unchanged                                                 |
| `scripts/launcher/launcher-logic.mjs`                                           | Pure launcher fallback version and release title                                                            |
| `scripts/launcher/SentryLauncher.psm1`                                          | Windows fallback version/title; root package getter remains authoritative                                   |
| `scripts/launcher/linux/lib/common.sh`                                          | Native source fallback version; root package getter unchanged                                               |
| `apps/runtime/scripts/deploy-wsl-runtime.ps1`                                   | Fallback deploy version and current examples                                                                |
| `scripts/launcher/commands.ps1`, `commands2.ps1`                                | Source Windows setup/status/help labels                                                                     |
| `scripts/launcher/linux/launcher.sh`, `commands/setup.sh`, `commands/status.sh` | Native source help/setup/status labels                                                                      |
| CLI version test, runtime shutdown/hello test, Windows launcher smoke           | Update only explicit current-version expectations                                                           |
| `.github/ISSUE_TEMPLATE/bug_report.yml` / README                                | Current review-version/example and full-source attribution; beta release/tag instructions remain historical |
| New version-consistency tests and RC manifest case                              | Cross-component/version/title guard, historical-beta acceptance and RC/beta mismatch refusal                |

No handwritten identity JSON is committed. Existing `build.mjs` derives
schemaVersion1/product/version/full sourceCommit/runtimeProtocol1 from clean
committed input, writes matching root/Desktop/runtime-source identities and
distribution.json, verifies extraction and generates SHA256. Archive names become
`sentry-1.0.0-rc.1-<source12>-windows-x64.zip` and
`sentry-1.0.0-rc.1-<source12>-cachyos-x64.tar.gz`; unique runtime directories also
contain version/source. Desktop/runtime mismatched version or full SHA continues
to refuse readiness. Generated manifests, checksums and full source/tree live in
the preparation PR's final receipt; new bytes never impersonate I1.

Internal `packages/*` versions remain0.1.0; they are private implementation
packages, not separate product releases. Runtime protocol stays1; no database
migration, export format, snapshot hash version, SDK/model/provider pin, dependency
or update-channel change. Frozen `pnpm-lock.yaml` SHA256 remains
`a36aebfc003cd12076ed63613c05b07e6fa416d3c3f52a54d4f86ac3f3e4683a`.
Existing package dependency specifiers remain `workspace:*` and frozen install
accepts the metadata-only changes without a lockfile rewrite.

Historical beta test fixtures/identities, historical release docs, published
tag and I1 archive names/hashes remain untouched. The recovery-backup acceptance
helper intentionally permits only0.1.0-beta.1 historical/I1 identities. Do not
bulk-replace that guard or present it as an RC recovery tool. Proposed Option A
continues to target the exact physically validated corrected I1 pair; adopting
RC binaries as a different recovery target would need separate scope/evidence.

## Verification and eventual cut

Partial root-only bump reproduced two consistency failures; completing all
listed metadata/reporting surfaces passed3/3, while historical-beta identity
and protocol rejection stayed covered. The added real manifest fixture accepts
RC identity and rejects a mixed beta runtime component without changing validators.
Expected-version test edits express the requested version transition, not weaker
functional expectations. Full repository and platform gates are required and
recorded for the exact final review head in its PR receipt.

Build only after committing a clean input, with no tag/publication:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm distribution:test
pnpm distribution:build windows-x64    # native Windows x64 only
# On a separate clean Linux x64 input of the same exact SHA:
pnpm distribution:build cachyos-x64
```

The existing private CI workflow builds both targets from the PR head. Hosted
Ubuntu packaging is not native CachyOS execution. Any local Windows physical
smoke receipt identifies its own archive checksum, even if hosted Windows builds
the same filename with different bytes. Retain archives/sidecars privately past
the seven-day CI expiry.

After owner review/recovery disposition and explicit RC authorization, select
the final approved full commit and rebuild **from that commit**. An owner merge
has a new SHA even if its tree equals the reviewed head. Never rename or relabel
earlier archives. Promotion/tag/publication require separate explicit authority;
none occurs in this preparation task.
