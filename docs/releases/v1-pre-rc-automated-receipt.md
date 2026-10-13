# Phase 5 implementation verification receipt

Executed 2026-10-13. Implementation source
`93a84c3d27f1079480f8ec90d87ee645e4767611`, tree
`73439f04e2ed541fb2f3eb080b071dccf07b6815`, product/Desktop/runtime-source
version 0.1.0-beta.1, runtime protocol 1. This document is a later documentation
receipt; it does not relabel these archives as built from its own commit.
The final PR body records checks/artifacts for the subsequent documentation
head separately. The actual owner-merged commit remains unknown/unaccepted.

## Automated gates

| Gate                                                                                   | Host                                                      | Source                                      | Result and evidence                                                                                      |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| frozen install, repository check, format, lint, typecheck, build                       | Windows 11 build 26200 / Node 24.13.1 / pnpm 9.12.3       | implementation SHA above                    | PASS commands; packaging forced all 20 builds uncached                                                   |
| focused Desktop regressions                                                            | Windows                                                   | same corrected tree                         | PASS 44/44, redaction/boot/lifecycle files                                                               |
| full Desktop serial                                                                    | Windows                                                   | same corrected tree                         | PASS 378, 2 platform skips, 48 files                                                                     |
| default pnpm test                                                                      | Windows                                                   | same corrected tree                         | FAIL six real-mount trust cases; systemd unavailable plus EBUSY cleanup                                  |
| full uncached serial Turbo test, continue after failures                               | Windows                                                   | implementation SHA                          | FAIL 38/40 tasks; six trust cases and one OpenCode fixture timeout; no assertions weakened               |
| isolated trust serial                                                                  | Windows                                                   | same corrected tree                         | FAIL same six, 2 PASS; host lacks systemd user tools                                                     |
| frozen install, build, focused, hygiene, format, lint, typecheck                       | WSL2 Ubuntu / Linux 6.6.87.2 / Node 22.23.2 / pnpm 9.12.3 | exact implementation SHA, clean Linux clone | PASS each command                                                                                        |
| pnpm test                                                                              | WSL2 Ubuntu                                               | exact implementation SHA                    | PASS 40/40 tasks, 1214 tests / 16 skips; 20 build tasks cached, test tasks executed                      |
| isolated real-mount verification-trust                                                 | WSL2 Ubuntu, running systemd user manager                 | exact implementation SHA                    | PASS 8/8, real transient-unit mounts; trust also passed in full suite                                    |
| distribution:test                                                                      | Windows / WSL2 Ubuntu                                     | implementation source                       | PASS commands; Windows 7 PASS/23 SKIP, Ubuntu 29 PASS/1 SKIP                                             |
| Windows launcher logic, smoke, behavior, IO stress, shutdown; distribution maintenance | Windows                                                   | same corrected tree                         | PASS fixtures, no clean-host install inference                                                           |
| all 24 test-*.sh launcher suites                                                       | WSL2 Ubuntu                                               | exact implementation SHA                    | PASS each fixture suite, including startup, safety/channels, sandbox prerequisites and credential doctor |
| three required CI jobs                                                                 | GitHub Ubuntu/Windows                                     | PR head above; proposed merge below         | PASS [CI 38361256576](https://github.com/Mert1026/Sentry/actions/runs/38361256576)                       |
| windows-x64 / cachyos-x64 unsigned archive jobs                                        | GitHub Windows/Ubuntu                                     | exact PR head above                         | Both PASS [distribution 38361256555](https://github.com/Mert1026/Sentry/actions/runs/38361256555)        |
| native CachyOS / fresh Windows install / OS secure-storage acceptance                  | Physical targets                                          | candidate-specific                          | ENVIRONMENT UNAVAILABLE / OWNER ACCEPTANCE REQUIRED; not executed                                        |
| funded-provider matrix                                                                 | Owner-controlled                                          | candidate-specific                          | OWNER ACCEPTANCE REQUIRED; no paid calls                                                                 |

Quality checkout was GitHub proposed merge
`580c2aa67f961c85d4299dd956aaf7aadaba39ef`, parents dev c1d2d58 and head 93a84c3.
Its full tree equals `73439f04e2ed541fb2f3eb080b071dccf07b6815`; git diff head
against this merge was empty. This is not an actual integrated dev merge.
Hosted real mounts remained UNVERIFIED: bare probe exit 0, staged probe exit
226; CI used its explicit capability fallback. Real 8/8 evidence comes from
WSL, never from a skipped hosted lane or a CachyOS simulation.

## Failure dispositions (all at this implementation)

Windows verification-trust failures reproduce in default, full serial and
isolated serial runs. Each reports `sandbox unavailable: sandboxReason=systemd
user tools unavailable`, sometimes followed by EBUSY unlink of SQLite files:

- reproduces a known failing test with strong identity (§50)
- refuses to confirm a different failing test (§52)
- keeps fake secrets out of every persistence layer (§56)
- contains clean commands: project code cannot escape the sandbox (§16, §63)
- replays from the canonical relative cwd in monorepos (§40, §69)
- kills descendant processes that outlive their parent (§26, §67)

Sandbox/runtime/harness/verifier source is byte-identical to approved dev.
Disposition: failed on bare Windows; actual Linux mount-capable rerun 8/8 PASS.
Do not waive or change the trust tests to make bare Windows green.

OpenCode `opencode-path-sandbox.test.ts > direct dev bypass consistency (no
mocks) > preflight passes under bypass while doctor degrades with an explicit
warning` timed out at 5000ms in the full serial run and independent serial file
rerun (17 PASS/1 FAIL), with EPERM removing the still-used fake opencode.exe.
The unchanged single case passed in 1102ms (1 PASS/17 excluded). Harness source
and fixture are unchanged from dev; exact cause of the timing variance remains
unresolved. This is a retained Windows fixture limitation, not a proven new
production defect. WSL's full OpenCode suite passed 115/8 skips. No budgets,
expectations or production behavior were changed to hide it.

Concurrent independent Desktop suites collided on the fixture's default temp
models.json: `desktop RPC adapter > pushes runtime configuration after
credential save`, EPERM rename. Full serial Desktop PASS; credential/service
production unchanged. Avoid simultaneous suites sharing that path. Setup-only
unresolved build dependencies and temporary receipt formatting failures were
corrected and rerun, not counted as regression reproductions.

## Unsigned implementation archives

These are the actual distribution archives inside GitHub artifact wrappers;
wrapper digests are different and must not be substituted for archive SHA256s.
Both downloaded archives were checked against their sidecars, extracted and
inventory/version validated. Full source/version/protocol identities agree.
Windows extraction used a path with spaces; Linux verification ran in WSL,
which establishes archive integrity, not native CachyOS installation acceptance.

| Target / archive                                                  | Archive SHA256                                                   | Workflow artifact                                                                                                    |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| windows-x64 / sentry-0.1.0-beta.1-93a84c3d27f1-windows-x64.zip    | 4036c3335778bc88f1f84b4e7a3c7f2bb40a19045fd6dfca529eb11d690d7cc1 | [11795246379](https://github.com/Mert1026/Sentry/actions/runs/38361256555/artifacts/11795246379), expires 2026-10-20 |
| cachyos-x64 / sentry-0.1.0-beta.1-93a84c3d27f1-cachyos-x64.tar.gz | e3576b7649d531ad716de16e4df6dccfc6000d2072ad268c70ed716c70ea67ca | [11795505715](https://github.com/Mert1026/Sentry/actions/runs/38361256555/artifacts/11795505715), expires 2026-10-20 |

Inventory: Windows 332 files, Linux 333. A separately built local Windows archive
of the same source also verified, SHA256
`2e432a3aac2515af5c23d6fa19c6bc4bf5b8cc20a39b443966dcd6b8d7072673`.
It is a different byte stream/build receipt; do not use the CI archive's checksum
for it. No deterministic-byte-rebuild guarantee or publisher authentication is
claimed. No binaries were published or attached to a release.

## Repository and next owner gate

Obsolete remote fix/v1-error-boundary-final-hardening revalidated 0 unique commits
ahead / 1 merge behind dev, merged PR13 and no open PR; removed remotely.
Its checked-out local worktree/branch was retained. New task branch/PR14 retained.
Remote main4fd2be9, devc1d2d58, beta tag/release and dirty primary checkout preserved.

The subsequent receipt-only commit must retain identical production/test source;
its final PR checks, selected archive source and checksums are recorded separately
in the PR receipt. After owner integration, verify actual merge SHA/tree/CI and
new selected-SHA artifacts. Use the owner runbook's 72 rows on Windows/WSL and
actual native CachyOS. Phase 5 acceptance remains open; Phase 6 NOT AUTHORIZED.
