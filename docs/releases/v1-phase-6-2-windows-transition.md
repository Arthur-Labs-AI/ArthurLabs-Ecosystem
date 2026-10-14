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

## Executed verification and review artifact

Verification is in progress. Required gates, counts/skips, exact review artifact
identity and packaged Windows large-import observations will be recorded before
owner handoff. Earlier `8a75e992` / `d224cf09...c51d96` bytes remain historical,
not the new artifact identity. No final Windows-only source is selected before
the scope PR is owner-merged.

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
