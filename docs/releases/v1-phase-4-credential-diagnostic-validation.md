# Phase 4 credential diagnostic — validation and acceptance handoff

Date: 2026-10-12. Version remains `0.1.0-beta.1`. This is an unsigned review
candidate, not an official release. Phase 4 remains open for supported-host
acceptance; Phase 5 has not started.

## Baseline and scope

Approved `origin/main`: `89365b92f723ba937ab1719e15e329cbe3e27dc1`, after merged
[PR #7](https://github.com/Mert1026/Sentry/pull/7).
[Post-merge CI 38275423611](https://github.com/Mert1026/Sentry/actions/runs/38275423611)
completed successfully in all three jobs before development. Remote references,
open PRs, branching policy, configured identity and local changes were inspected.
Work is isolated on `fix/v1-credential-status-diagnostic`; the owner's dirty main
checkout was preserved without reset, stash or checkout changes.

Implementation: `65d2b32f6253f97b8e67a321db708bbdee86dfda`.
[Draft PR #8](https://github.com/Mert1026/Sentry/pull/8) is the review surface.
[Implementation CI](https://github.com/Mert1026/Sentry/actions/runs/38283276192)
passed quality and both launcher jobs;
[implementation distribution](https://github.com/Mert1026/Sentry/actions/runs/38283276145)
passed both archive jobs. GitGuardian passed. Final documentation-head checks are
recorded on the PR; these implementation receipts do not attest to a later SHA.
Hosted CI used its existing sandbox-capability fallback, so its real sandbox
trust result is UNVERIFIED. The local WSL proof below is separate.

## Reproduction and correction

The old standalone command constructed `ProviderCredentialService` without
Electron's secure-storage bridge. Its tolerant normal-boot loader skipped the
encrypted store and reported three false booleans. Production `providers.status`
IPC already supplied the bridge; this was a diagnostic false negative, not loss
of stored credentials. The prior real Windows DPAPI reproduction is retained in
[the historical final acceptance report](v1-phase-4-final-acceptance.md#deferred-review-finding).

Before editing production code, new tests saved a synthetic credential through
the actual service, cleared environment values, proved a fresh bridged service
returned stored/secure presence, then imported the actual Desktop main entry.
The initial diagnostic matrix produced **15 failures / 2 passing guards**.
The existing focused suite passed 27/27. Additional regressions captured a
diagnostic rewriting the legacy file (1 failure / 20 guards) and a lock probe
focusing the running Desktop (1 failure / 5 guards). All are now green.

Only two production files changed:

- `apps/desktop/src/main/index.ts`: retain `app.whenReady()`, construct the same
  narrow safeStorage adapter used by normal bootstrap, load in strict mode,
  preserve successful output, sanitize failure guidance and return exit 1.
  A diagnostic lock probe does not focus, quit or restart the running Desktop.
- `apps/desktop/src/main/services/provider-credentials.ts`: optional strict
  inspection rejects unavailable secure storage, invalid schema/base64, unreadable
  entries and failed/empty decryption. Normal `load()` remains tolerant and keeps
  its existing migration behavior. Strict inspection does not migrate or rewrite
  the legacy plaintext file; open normal Desktop to perform that existing migration.

Supporting changes are `credential-diagnostic.test.ts`, `quit-lifecycle.test.ts`,
the Windows launcher behavior suite, the new Linux credential-doctor fixture,
`scripts/distribution/smoke.mjs` and `tests/secure-settings.mjs`. No storage format,
provider, runtime, QA pipeline, schema, version or Electron isolation change.

## Public contract and security

Success is exit 0 with exactly one presence line using the existing field names:

```text
SENTRY_CREDENTIAL_STATUS={"opencode":false,"deepseek":true,"glm":false}
```

With an available backend and valid/absent encrypted store, missing credentials
remain false; decrypted credentials and supported process-environment values are
true. An unavailable backend conservatively returns exit 1 even for an empty
profile. Corrupt/unreadable storage and a held instance lock also return exit 1,
without a success prefix. Fixed guidance points to OS secure storage and the
running application's Settings → Providers / Environment, preserving the store.
Raw exceptions, paths, credential values, ciphertext, secret lengths and secret
fragments are not emitted by the diagnostic.

Windows doctor already maps successful booleans to its configured/missing rows;
nonzero, absent or malformed output uses its INFO fallback. Six fixture cases
cover those paths, including nonzero output containing a success prefix. Linux
doctor consumes the presence signal and uses INFO when unavailable; both cases
pass against the production shell function. Release launcher commands do not
consume this diagnostic, and their maintenance/control tests remain passing.

The command does not initialize runtime, QA or provider requests. Tests assert
bootstrap is unused; the real standalone test points runtime at a nonexistent
entry and still succeeds. There is no production encryption implementation or
plaintext fallback added. The unit bridge uses test-only authenticated encryption;
the real acceptance uses Electron's Windows DPAPI under the same test account.
No owner credential store was read, copied or modified in this task. All real
credential operations use explicit disposable `--user-data-dir`, proved by its
DevToolsActivePort before production credential/project IPC. APPDATA alone is
never treated as proof of isolation. Presence does not prove validity, credit or
funded provider readiness; no paid provider calls were made.

## Validation

Windows: Windows 11 Home x64 build 26200, Node 24.13.1, pnpm 9.12.3.
Linux: Ubuntu 26.04 WSL2 x86_64, kernel 6.6.87.2-microsoft-standard-WSL2,
Node 22.23.2, pnpm 9.12.3, functioning user systemd/bubblewrap/socat.

| Gate                                                           | Windows                                      | Ubuntu WSL                                             |
| -------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------ |
| Frozen dependency install                                      | PASS                                         | PASS                                                   |
| repository:check / format:check                                | PASS                                         | PASS                                                   |
| lint / typecheck                                               | PASS (20 / 37 tasks)                         | PASS (20 / 37 tasks)                                   |
| build                                                          | PASS (20 tasks; artifact build forced fresh) | PASS (20 tasks; artifact build forced fresh)           |
| Default concurrent `pnpm test`                                 | FAIL; details below                          | FAIL on two attempts; details below                    |
| Full suite, `pnpm exec turbo run test --concurrency=1 --force` | Not run in this task                         | PASS, 40/40 tasks uncached, 1,179 passed / 16 skipped  |
| Focused credential/control/lifecycle/distribution units        | PASS 49/49                                   | Included in passing full suite                         |
| Full Desktop                                                   | PASS 343 / 2 platform skips                  | PASS 344 / 1 platform skip                             |
| distribution:test                                              | PASS 7 / 23 Linux-only skips                 | PASS 29 / 1 Windows-only skip                          |
| Launcher decision logic                                        | PASS 20/20                                   | Existing shell suites plus hosted decision gate PASS   |
| Windows doctor/smoke/IO/shutdown/maintenance                   | PASS                                         | Not applicable                                         |
| Linux shell suites                                             | Not applicable                               | PASS all 22 test scripts, including new doctor fixture |
| Real sandbox trust                                             | Not a Windows capability claim               | PASS 8/8 uncached, also in full serial run             |

The diagnostic's 21 tests cover each encrypted provider (including both OpenCode
keys), empty/mixed/environment sources, default/explicit profiles, readiness,
unavailable/throwing backend, malformed JSON/schema/entries/base64, failed or
empty decryption, unreadable file, read-only legacy behavior, normal tolerant
boot and lock refusal. Six lifecycle tests include no-focus/no-quit behavior.
No assertions, security requirements or unrelated deadlines were weakened.

### Concurrent-suite limitations

The local default full suites did not pass and are not relabeled by the serial
result. Windows emitted failures in unchanged Claude streaming Tests C (live
delivery, 2-second startup), A (identical-failure abort) and D (activity-aware
timeout, 2-second startup), plus targeted QA's all-three-agents frozen-snapshot
case (5-second timeout) before Turbo stopped. The focused Claude suite passed
11/11 both here and on the prior hardening baseline; the relevant source is
identical to approved main. Focused Windows targeted QA passed 10/10.

WSL attempt one emitted failures in Claude readiness without ANTHROPIC_BASE_URL
(5 seconds), multi-agent cancellation/foreign request and parallel timeout
isolation (5 seconds). Attempt two emitted failures in human-log export
(5 seconds), parallel timeout isolation (5 seconds), runtime OpenCode readiness
(5 seconds), start-identity lock preservation (5 seconds), the following
unpersisted identity case, and targeted instructions/paths and lineage
(5 seconds, with cleanup ENOTEMPTY). These modules are unchanged from baseline.
Focused WSL reruns passed Claude readiness 6/6, closure/parallel/trust 20/20,
runtime/start-identity 15/15 and targeted QA 10/10. The subsequent entire uncached
serial suite passed without changing assertions or timeouts. This supports load
sensitivity but does not establish the cause of every concurrent failure.
The earlier Phase 4 Windows snapshot 5-second timeout remains a historical
limitation; it was not the reported failing case in this task.

### Real Electron and beta continuity

PASS on the prepared Windows 11/WSL2 host, using the actual new extracted ZIP:

1. The archive's Linux bootstrap ran first and repeated setup in disposable
   `/var/tmp/sentry-credential-install-home.FSgITG`. Candidate and active runtime
   handshakes matched the full implementation SHA both times. Distinct deployments
   were retained and a synthetic data sentinel remained byte-identical.
2. Immutable published beta `0e5c10cfa80f6385ebfc88a7306b38ce8a12ce38` seeded
   disposable completed history/finding/evidence/issue/retest fixtures through its
   persistence implementation. Its built source Electron saved a random synthetic
   DeepSeek credential through production IPC into a newly created, explicitly
   verified profile, then stopped cleanly. This was a source beta, not an invented
   earlier beta archive.
3. The actual corrected packaged Desktop reopened that same profile and history.
   Production provider status was stored/secure. A diagnostic launched while it
   held the lock returned exit 1/no prefix/fixed guidance, with Desktop still
   alive and its runtime connected. After graceful shutdown, a fresh standalone
   process returned `{opencode:false,deepseek:true,glm:false}` with exit 0 despite
   an intentionally nonexistent runtime entry.
4. Normal packaged Desktop reopened the same profile again after the diagnostic;
   production credential status, retained beta records, runtime hello, import,
   secure preload/renderer/IPC, single-instance handling and graceful stop passed.
   The standalone diagnostic passed again. The helper scans the profile and
   extracted archive for the synthetic plaintext and checks captured app and
   diagnostic output; all checks passed without printing the credential.

Receipts are `real-setup.windows.log` and `secure-settings.windows.log` in the
ignored evidence directory. The production smoke infrastructure verifies explicit
profile ownership before credential IPC on every launch. This task used only the
fresh test profile and `/var/tmp/sentry-beta-history-5bjcJ6`; it did not reuse the
prior task's profile or access the owner's store. Native CachyOS GUI/keyring
continuity is **ENVIRONMENT UNAVAILABLE**, not inferred from DPAPI.

The newly built source-installed Electron also ran the diagnostic against that
previously verified explicit profile: exit 0, the same exact three booleans and
no runtime dependency, PASS (`source-diagnostic.windows.log`). Default-profile
resolution is covered by deterministic unit tests; no owner default profile was
used for real acceptance. A final scan found zero synthetic credential values in
the captured evidence logs.

## Exact unsigned review artifacts

Both artifacts were built from a clean native checkout at full source SHA
`65d2b32f6253f97b8e67a321db708bbdee86dfda`. Subsequent documentation commits do
not alter those reviewed bytes. Version `0.1.0-beta.1`, runtime protocol 1.
Both fresh builds, inventory verification, SHA256 and extraction checks PASS.
The Windows archive was additionally extracted into a new path containing spaces.
Linux archive version reporting, pinned-update refusal and Ubuntu GUI host-gate
refusal PASS; these are not native CachyOS GUI/keyring evidence.

| Filename                                              | SHA256                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `sentry-0.1.0-beta.1-65d2b32f6253-windows-x64.zip`    | `1a38d0df60534058f54dd4e4985b603e28c54bc384dc7c97caf7006d9d5c31fa` |
| `sentry-0.1.0-beta.1-65d2b32f6253-cachyos-x64.tar.gz` | `2669d4027d80d1657694c3dd73684e6d4c8899635e130786413ef3222eb3fa87` |

Local archives and checksum companions are in `dist/distributions/` in the task
worktree. Linux was built in `/var/tmp/sentry-credential-validation.6wsYhc`, then
copied to that Windows directory and rehashed. Logs are ignored under
`dist/credential-evidence/` on each build host. No archives, profiles, databases,
synthetic credential values or generated binaries are committed. Hosted archives
are separately built review outputs; do not assume their bytes equal local builds.

## Remaining Phase 4 owner acceptance

Use the [existing supported-host procedure](v1-phase-4-final-acceptance.md#exact-remaining-owner-procedure).
Replace every old `d934e676e2a7` filename/directory suffix with `65d2b32f6253` and
verify the exact hashes above. Keep its stopped-backup, separate version directory,
disposable account/home and no-owner-install modification requirements.

| Remaining gate                                                                                                         | Status / required evidence                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native CachyOS GUI/session install, first/repeated setup, matching runtime hello, single instance and idle stop/reopen | ENVIRONMENT UNAVAILABLE; execute the existing CachyOS commands on a disposable graphical test account                                                                                  |
| Native CachyOS secure settings and beta upgrade                                                                        | ENVIRONMENT UNAVAILABLE; same login/keyring context, synthetic credential, production status plus fresh-process diagnostic and normal reopen, retained history/evidence/issues/retests |
| Fresh Windows WSL absent / distro absent / reboot pending                                                              | ENVIRONMENT UNAVAILABLE; independent disposable VM snapshots, record pre-repair guidance/exit, reboot exit 75 where applicable                                                         |
| Fresh Windows missing Node/pnpm/systemd/bubblewrap/socat, then first/repeated setup                                    | ENVIRONMENT UNAVAILABLE; record each prerequisite refusal and matching runtime/GUI after VM-only repair                                                                                |
| Actual active QA cancellation and maintenance refusal, then safe retry                                                 | OWNER ACCEPTANCE REQUIRED; separately authorize funded runs, prove unchanged current/data during refusal and successful retry after work settles                                       |
| Failed candidate/active runtime recovery, rollback and data preservation on supported hosts                            | OWNER ACCEPTANCE REQUIRED; portable fixtures PASS, physical-host fault injection must use a disposable install and compatible stopped backup                                           |

For each secure-storage host, extend the existing beta-upgrade sequence: stop
Desktop cleanly, invoke the extracted executable with the same proven explicit
profile and `--sentry-credential-status`, expect only the three correct booleans
and exit 0, then reopen normal Desktop and verify stored/secure production status.
While Desktop owns that profile, expect exit 1 with Settings guidance, no presence
prefix and no focus/quit/runtime disruption. Never put credentials on a command
line, print them, copy an owner's store/keychain, or use default owner profiles.
Use test-only instrumentation or the reviewed helper to save synthetic credentials
and check plaintext absence without exposing their values.

Prepared Windows/WSL evidence does not substitute for a clean Windows VM or a
native Linux keyring. Portable rollback fixtures do not close physical-host
failure recovery. Complete exact-head CI review and these host gates, then obtain
owner acceptance before recommending the next phase. No main push, merge, tag,
release publication, version bump or Phase 5 implementation is part of this task.

Full diff self-review found no additional introduced correctness, data-loss,
secret-handling, lifecycle or compatibility blocker. The concurrent-suite
failures and unavailable host gates above remain unwaived. `shux contract` is
unavailable on this host; task status, ledger and handoff are maintained directly.
