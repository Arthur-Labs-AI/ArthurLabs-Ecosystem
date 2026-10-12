# Phase 4 final hardening and acceptance

2026-10-12. **Implemented for owner review; Phase 4 is not fully accepted.**
Version `0.1.0-beta.1`, runtime protocol 1 and provider pins (OpenCode 1.18.32,
DeepSeek SDK 0.1.5-rc.2, Claude Code 2.1.270) are unchanged. No funded calls,
release publication, tagging, main push, merge or Phase 5 implementation.

## Starting point

Fetched origin/branches/tags and inspected open PRs before changes. PR #6 is
[merged](https://github.com/Mert1026/Sentry/pull/6) at
`8ff4c51326e7aa0c4d4a3ce8cfcd86aa3c981ebf`, still current origin/main.
[Post-merge CI 38249464643](https://github.com/Mert1026/Sentry/actions/runs/38249464643)
passed quality and both launcher jobs. Its hosted runner could not mount the
real sandbox; the existing fallback is not a real isolation proof.

New branch `fix/v1-phase-4-release-hardening` starts at that main in
`C:\Users\merte\.codex\worktrees\v1-phase-4-release-hardening\Sentry`.
The primary dirty main checkout at `9c57e3f` and its DeepSeek/schema/protocol/
PROJECT_GUIDE changes were preserved. Existing branches and beta tag were not
rewritten. Git identity remains the owner's configured identity. Managed worktree
creation made the checkout but registration stalled in the ignored AGENTS scan;
the exact owned scanner was stopped, registration/reattachment failed, and the
verified Git checkout was used directly. `shux contract` is unavailable; status,
ledger and handoff are maintained directly in the task worktree.

The foundation remains a self-contained unsigned Electron ZIP/tar.gz, full-SHA
manifest/inventory and online Linux source bootstrap. The existing bootstrap still
checks prerequisites and stopped processes, locks maintenance, stages a unique
candidate, validates hello, atomically activates, validates again and rolls back.
No bootstrap, runtime, schema, orchestration or provider execution code changed.

## Reproductions and corrections

| Finding                                                            | Before                                                                                                                                                                                                                                                             | After / evidence                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: early packaged startup failure — confirmed, important           | A sealed disposable archive whose executable writes an error and exits 42 returned 0 and “Desktop launch requested.” An invalid interpreter also returned 0.                                                                                                       | Observe the owned `setsid --wait` child for ten 0.2s intervals. Confirmed exit reports status and `release-desktop.log`, returns nonzero; exit 0 succeeds only with an existing marked Desktop. Survival reports startup observation, then directs to Environment for runtime/provider readiness.                                              |
| B: unbounded control — confirmed, important                        | A helper ignoring TERM and hanging exceeded the test's 8s outer safety deadline before polling started. Nonzero control also lacked maintenance guidance.                                                                                                          | GNU coreutils timeout bounds only the separately grouped control helper: 45s, then at most 2s before helper-group KILL. Timeout/failure refuses maintenance with guidance. Existing Desktop/runtime/QA receive no forced signals. The existing 45-iteration stopped-process poll remains after successful control.                             |
| Acceptance blocker: packaged profile override — confirmed          | APPDATA environment substitution did not override Windows OS known folders; packaged main also replaced Electron's explicit profile directory with the default. The first encryption test could not find its encrypted store under its purported isolated profile. | Respect Electron `--user-data-dir` before bootstrap/locking. Empty switch retains `appData/@qa/desktop`. All smoke subprocesses pass the same absolute disposable profile, and DevToolsActivePort must appear there before credential/project IPC. Unit regression: 1 RED / 3 guards, then 4 GREEN; real artifact smoke verifies the boundary. |
| Acceptance blocker: encryption loaded before app-ready — confirmed | Beta saved a secure synthetic credential, but the e4b8fca archive reported it missing on the next boot. Bootstrap loaded credentials before Electron safeStorage became available and never reloaded them.                                                         | Await `app.whenReady()` before credential/runtime bootstrap. Deferred-ready unit regression: 1 RED / 4 guards, then 5 GREEN. Final d934e67 beta-to-archive production IPC reports configured / stored / secure on a new boot.                                                                                                                  |

Lifecycle regressions first produced **7 failures / 5 guards passed**. The hang
failed with ETIMEDOUT; immediate exit failed because observed launcher status was 0. A fixture path/mode setup error was corrected before recording that RED run.
The final lifecycle file has **13 PASS**: exit 42, survival, no graphics, missing/
invalid executable, exit-zero handoff, nonzero handoff, exit zero without another
instance, normal/idle stop, failed/hung control, remaining Desktop/runtime and
unchanged current/runtime/data. Separate owned children synchronize through
stdout readiness; no provider credentials or owner installation act as fixtures.
Actual GNU timeout is exercised with an asserted shorter fixture deadline;
remaining-process polling is accelerated only in fixture PATH. Existing Desktop,
runtime and unrelated Electron fixtures remain alive after timeout/refusal.

Distribution files run serially because their intentional machine-wide /proc
checks can observe another file's active-runtime fixture. Never run this suite
concurrently with an actual Sentry runtime. An intermediate validation ran during
a beta smoke and correctly refused maintenance; that failed attempt is retained
in local evidence. No scanner, assertion or security timeout was weakened.

### Initial acceptance mistake and cleanup

The first encrypted-settings attempt used the normal Windows Desktop profile,
despite the helper's APPDATA substitution. It created a new provider store with
only the synthetic DEEPSEEK entry. After verifying the sole entry decrypted to
the generated nonproduction prefix/UUID under the matching encryption context,
that test-created store was removed. No pre-existing provider store/other keys
were removed and no credential value was printed. Chromium profile files were
touched by that initial launch; the initial smoke is not evidence of profile
isolation. The corrected runs require the explicit profile proof before saving
or importing, use fresh synthetic data, and supersede that attempt.

## Changed files and compatibility

| File                                                   | Reason                                                                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/distribution/release.sh`                      | Bounded packaged startup observation and separately bounded graceful-control invocation; all setup/repair/tools failures stop before maintenance mutation.                     |
| `scripts/distribution/tests/lifecycle.test.mjs`        | Sealed archive fixtures exercise the real router/validator/process scanner/timeout without owner processes or data.                                                            |
| `apps/desktop/src/main/distribution.ts`, `index.ts`    | Preserve explicitly selected Electron profile; await Electron readiness before secure credential load; retain default source-beta location and normal single-instance scope.   |
| `apps/desktop/tests/unit/distribution.test.ts`         | Profile override/empty default regression, retaining runtime identity and legacy guards.                                                                                       |
| `apps/desktop/tests/unit/quit-lifecycle.test.ts`       | Deferred app-ready regression proves bootstrap cannot run before OS encryption readiness; existing quit/cancel guards remain.                                                  |
| `scripts/distribution/smoke.mjs`                       | Explicit verified isolated profile for every child, published source-beta seed mode, real secure storage presence checks, plaintext scans, richer retained-history assertions. |
| `scripts/distribution/tests/secure-settings.mjs`       | Same-account beta-to-archive smoke with an in-memory random nonproduction credential; never reads owner credentials.                                                           |
| `scripts/distribution/tests/beta-history.mjs`          | Receipt adds existing agentRun identity so the packaged app verifies completed attributed agent output.                                                                        |
| `package.json`                                         | Serialize process-global distribution fixture files. Product/provider versions and lockfile unchanged.                                                                         |
| Acceptance report, roadmap, task status/ledger/handoff | Exact evidence, limitations and owner follow-up.                                                                                                                               |

Source setup/update/open and Windows release launcher are unchanged. Pinned
release update still refuses development origin/main. Source beta retains its
legacy runtime identity compatibility. Historical deployments are retained;
normal profile location and encryption implementation are unchanged. Explicit
alternate profiles have their own single-instance scope and require coordinated
runtime maintenance, as before. No Electron sandbox flag or host isolation was
disabled. There is no provider readiness or funded-QA claim from process survival.

## Exact implementation artifacts

Final implementation commit: `d934e676e2a77c0f96caab053e9b9cff3cefa8f1`.
Documentation commits after it do not change these bytes. Any final-head CI
archives identify their own later SHA and must not be relabeled as these files.
Earlier 01738e4/2d8c4f1/e4b8fca builds are superseded and excluded from acceptance claims.

| Artifact                                              | SHA256                                                             | Native build / extraction                                                                                                        | Actual execution                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `sentry-0.1.0-beta.1-d934e676e2a7-windows-x64.zip`    | `9c4ab207378769a23bd1d3dd352b95980fd752139b199d0bc07ba94bd28c2609` | PASS, Windows native x64, 332 payload files; extracted again to a path with spaces and PowerShell version verified.              | PASS, real extracted production Electron + prepared WSL runtime, beta history, secure settings, single instance and idle stop. |
| `sentry-0.1.0-beta.1-d934e676e2a7-cachyos-x64.tar.gz` | `4df58e4621f120258ccd6453ffcef9db7eb9507993bb2896a08d328159c53ac1` | PASS, Linux x64 under WSL; 333 payload files, extraction/inventory verified and checksum checked again after copying to Windows. | Native CachyOS: ENVIRONMENT UNAVAILABLE. Ubuntu host-gate refusal is a portable check only.                                    |

Build hosts: Windows 11 Home x64 build 26200, Node 24.13.1/pnpm 9.12.3;
Ubuntu 26.04 WSL2 x64, kernel 6.6.87.2-microsoft-standard-WSL2,
Node 22.23.2/pnpm 9.12.3. Electron 36.2.1/electron-builder 26.0.12 unchanged.
Commands were `pnpm distribution:build windows-x64` / `cachyos-x64` on their
respective native hosts, from clean committed input. Each forces all 20 build
tasks and rechecks HEAD/tree. Windows outputs are under ignored
`dist/distributions`; Linux checkout is `/var/tmp/sentry-hardening-validation.yFSWRB`.
Companion checksums, complete inventory, full identities/version/target, main,
preload, renderer, icon, bootstrap and launcher are checked after extraction.
Private paths, databases, keys, environment files, logs, unexpected files and
symlinks are rejected. Tests and acceptance helpers are excluded from archives.
Unsigned/ASAR-disabled and renderer chunk-size warnings remain disclosed; these
checks establish integrity/provenance, not code signing or byte reproducibility.

## Executed gates

| Command / gate                                                        | Result / evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                      | PASS Windows and native Linux/WSL; no lockfile edit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm repository:check`, `format:check`, `lint`, `typecheck`, `build` | PASS on both hosts: hygiene, formatting, lint 20 tasks, typecheck 37 tasks, build 20 tasks. Final packaging forces 20 uncached builds per host.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm test`, native Linux/WSL                                         | PASS, 40 tasks / 1,157 tests / 16 skips on final implementation (cached tasks disclosed). Final Desktop executed 322 tests / 1 skip; unchanged real sandbox trust rerun uncached at e4b8fca: 8/8 PASS (no runtime changes afterward).                                                                                                                                                                                                                                                                                                                                                                 |
| `pnpm test`, native Windows                                           | FAIL under default concurrent Turbo execution. Last full run (e4b8fca) stops in unchanged Claude streaming initialization timing assertion; unchanged OpenCode/run-engine fixtures also exceed 5s during concurrent runs. Earlier attempt additionally hit CLI selection/EBUSY cleanup. Scoped unchanged reruns PASS; no test deadlines or expectations changed. Native Windows lacks the Linux systemd trust environment, so a Windows full-suite success is not claimed.                                                                                                                            |
| Windows focused reruns                                                | Claude streaming, OpenCode process, CLI stack selection, run-engine parallel/core fixtures all PASS unchanged; snapshot 4/4 PASS. Earlier Phase 4's occasional snapshot 5s timeout remains a known limitation; it was not hidden or relaxed.                                                                                                                                                                                                                                                                                                                                                          |
| Desktop acceptance corrections                                        | Windows 321 PASS / 2 skips on d934e67; Linux result included above. Unit profile 4/4 PASS after RED.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm distribution:test`                                              | PASS: native Windows 7 / 23 Linux-only skips; native Linux/WSL 29 / 1 Windows-only skip. Includes 13 lifecycle regressions; run serially with no actual Sentry runtime active.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Existing source launcher matrices                                     | Windows decision logic 20/20; smoke, behavior, IO stress and shutdown-safety PASS. All 21 Linux test-*.sh files and release shell syntax PASS.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Windows release maintenance / parser                                  | Existing idle/failure/still-running/normal-stop fixtures PASS; parser checks PASS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Contract / rollback / identity / channels                             | Distribution contract and first/repeated deployment, wrong host/arch/pnpm, lock, build/hello/active-failure rollback and first-install recovery fixtures PASS. Source update safety PASS; packaged update refuses.                                                                                                                                                                                                                                                                                                                                                                                    |
| Exact-head GitHub CI / distribution                                   | [Draft PR #7](https://github.com/Mert1026/Sentry/pull/7) tracks the final head. Implementation [CI 38255574234](https://github.com/Mert1026/Sentry/actions/runs/38255574234) and [distribution 38255574069](https://github.com/Mert1026/Sentry/actions/runs/38255574069) passed all three required jobs and both archive jobs at d934e67; subsequent documentation-head checks must complete separately. Hosted quality used the existing sandbox-unverified fallback, not the real isolation suite. Current exact-head results are recorded in the PR handoff, not inferred from prior-head success. |

Local raw command logs and receipt JSON are ignored under
`dist/hardening-evidence` and the Linux checkout's matching directory. Full diff
self-review prioritizes correctness, data loss/secrets, process ownership,
concurrency and compatibility. No remaining introduced production blocker found;
unavailable platform acceptance and native Windows test failures remain explicit.

## Real installation, upgrade and recovery evidence

Actual extracted d934e67 Windows archive bootstrap ran twice in fresh `/var/tmp/sentry-hardening-install-home.npQGsA`. Candidate and active hello matched full SHA/version on both runs. First deployment `0.1.0-beta.1-d934e676e2a7-0104fa11-fee` remains beside current `0.1.0-beta.1-d934e676e2a7-6b58f823-879`. Distinct targets and byte-identical synthetic user data were checked. This proves first/repeated Linux deployment on prepared WSL, not fresh Windows WSL provisioning. Failed-build/candidate/active validation and rollback are fixture proofs, not fault injection against an owner installation.

Published beta `0e5c10cfa80f6385ebfc88a7306b38ce8a12ce38` creates a fresh database
through its actual persistence implementation. The corrected candidate reads
projects, two revisions, completed run, completed attributed agent output,
findings/evidence and historical issue/completed retest through production IPC.
No synthetic agent execution is presented as a funded provider result.

Actual immutable beta Desktop (built Windows source at tag SHA above) saved a
random nonproduction credential through production providers.save using Windows
Electron safeStorage/DPAPI, then stopped. The final extracted d934e67 archive
opened the same isolated profile under the same Windows account and a fresh
process; production providers.status reported configured=true, source=stored,
persistence=secure. That status requires real decryptability, not identical bytes.
The helper scanned the profile, extracted archive and application output for the
synthetic plaintext; all absent. No plaintext fallback was added. Test profile:
`C:\Users\merte\AppData\Local\Temp\sentry secure settings sfKDmu`; retained beta
database: `/var/tmp/sentry-beta-history-v75zwu`. Both beta and archive smoke
receipts passed renderer/preload/isolation/IPC/import/history/hello/single-instance/
graceful-stop checks. The beta seed itself is a built immutable source Desktop,
not a nonexistent prior packaged beta archive; the new candidate is the actual ZIP.

This replaces the failed e4b8fca encrypted-settings attempt: that earlier file was
present but could not be decrypted during early bootstrap. It is not an accepted
artifact. Final log receipts are `real-setup-final.log` and
`secure-settings-final.log` under the ignored evidence directory.

Reproduce on the configured Windows/WSL host with built immutable beta checkouts
and a verified extracted candidate. All arguments below must identify disposable
fixtures; do not substitute an owner database/profile:

```bash
node scripts/distribution/tests/beta-history.mjs /path/to/built-beta /var/tmp/history-receipt.json
```

```powershell
# Read the generated dataRoot from history-receipt.json. Runtime entry must match archive SHA.
node scripts/distribution/smoke.mjs '<extracted-candidate>' '<matching-linux-runtime-entry>' '<disposable-linux-data>' '<receipt-visible-to-Windows>'
node scripts/distribution/tests/secure-settings.mjs 'source-beta:<built-Windows-beta-checkout>' '<published-beta-linux-entry>' '<extracted-candidate>' '<matching-linux-runtime-entry>' '<disposable-linux-data>' '<receipt-visible-to-Windows>'
```

## Supported-host acceptance

PASS below means the stated scope actually ran; fixture results are not native
host acceptance. The Windows machine is an existing configured host, not a clean
provisioning VM. No safe disposable Windows machine or native CachyOS GUI/session
is connected. No WSL feature, distro, owner runtime or system package was removed,
terminated, reconfigured or installed with elevation.

| Gate                                                              | Windows 11 + WSL2         | Native CachyOS          |
| ----------------------------------------------------------------- | ------------------------- | ----------------------- |
| Clean-machine first install / absent prerequisites / reboot       | ENVIRONMENT UNAVAILABLE   | ENVIRONMENT UNAVAILABLE |
| First runtime install in disposable home on prepared host         | PASS                      | ENVIRONMENT UNAVAILABLE |
| Repeated runtime setup                                            | PASS                      | ENVIRONMENT UNAVAILABLE |
| Exact runtime handshake                                           | PASS                      | ENVIRONMENT UNAVAILABLE |
| Actual packaged Desktop launch / single instance / idle stop      | PASS                      | ENVIRONMENT UNAVAILABLE |
| Manual side-by-side beta upgrade / history retention              | PASS                      | ENVIRONMENT UNAVAILABLE |
| Encrypted settings through real OS backend                        | PASS                      | ENVIRONMENT UNAVAILABLE |
| Refusal during actual funded QA / cancellation                    | OWNER ACCEPTANCE REQUIRED | ENVIRONMENT UNAVAILABLE |
| Maintenance refusal with active runtime / failed control          | OWNER ACCEPTANCE REQUIRED | ENVIRONMENT UNAVAILABLE |
| Failed candidate/active validation and rollback on supported host | OWNER ACCEPTANCE REQUIRED | ENVIRONMENT UNAVAILABLE |

The last two Windows gates have passing portable process/rollback fixtures but
no physical-host fault injection claim. Existing prepared WSL real sandbox trust
PASS is distinct from native CachyOS acceptance and the hosted CI fallback.

## Exact remaining owner procedure

### Native CachyOS, disposable graphical session

Use the approved tar.gz and matching trusted checksum in Downloads. Run without
root from your normal graphical session; preserve the original PATH to Linux
Node/pnpm. Do not disable Electron sandboxing or user-service mount isolation.

```bash
cat /etc/os-release
uname -r; uname -m
printf 'session=%s desktop=%s display=%s wayland=%s\n' "$XDG_SESSION_TYPE" "$XDG_CURRENT_DESKTOP" "$DISPLAY" "$WAYLAND_DISPLAY"
node --version; pnpm --version
systemctl --user show-environment
command -v bwrap socat timeout setsid
bwrap --dev-bind / / --proc /proc /usr/bin/true
cd "$HOME/Downloads"
sha256sum -c sentry-0.1.0-beta.1-d934e676e2a7-cachyos-x64.tar.gz.sha256
acceptance=$(mktemp -d "$HOME/sentry-phase4-acceptance.XXXXXX")
tar -xzf sentry-0.1.0-beta.1-d934e676e2a7-cachyos-x64.tar.gz -C "$acceptance"
task_home="$acceptance/home"
mkdir -p "$task_home"
task_sentry() { env HOME="$task_home" XDG_CONFIG_HOME="$task_home/.config" XDG_DATA_HOME="$task_home/.local/share" ./sentry "$@"; }
cd "$acceptance/sentry-0.1.0-beta.1-d934e676e2a7-cachyos-x64"
task_sentry version
task_sentry setup
first=$(readlink "$task_home/.local/share/sentry/runtime/current")
task_sentry setup
second=$(readlink "$task_home/.local/share/sentry/runtime/current")
test "$first" != "$second"
test -d "$task_home/.local/share/sentry/runtime/$first"
task_sentry open
task_sentry open
task_sentry doctor
task_sentry stop
task_sentry open
task_sentry stop
```

Expected: CachyOS/x86_64/graphical session, Node >=22/pnpm 9.12.3, user manager
and bubblewrap succeed; approved full SHA/version and checksum; candidate/active
hello match twice, distinct deployments retained, actual secure window and single
instance, bounded startup observation plus log, Environment distinguishes hello
from selected-provider readiness, graceful idle stop and relaunch work. Record
the exact host/session and results. Missing packages get manual guidance; approve
any privileged package repair separately. Provider tool install is `./sentry tools`
and does not itself authorize a paid run.

For beta history/encryption, first create only synthetic fixtures under the same
test user's account/keychain, stop beta, retain its private backup, then launch
this archive and inspect production history/status. Expect stored/secure credential
presence after a new boot, with no plaintext in logs/artifacts. Never copy a
keychain or owner DB into test fixtures. For active-QA refusal, obtain separate
funded-run authorization; expect maintenance refusal, unchanged current/data and
usable cancellation, then successful maintenance after work settles.

Fault-injection fixtures can be rerun in the reviewed maintainer checkout with
all actual Sentry processes stopped:

```bash
pnpm distribution:test
node --test scripts/distribution/tests/lifecycle.test.mjs
```

Expected: 29 distribution passes/1 Windows-only skip and 13 lifecycle passes.
They cover refused maintenance and pre-/post-activation rollback, but remain
fixtures. Record native physical-host candidate/active fault injection separately
in a disposable install before accepting that row; never corrupt an owner install
or reseal a production archive to conceal tampering. A tampered copy must refuse
validation without moving current. Restoring an old binary/runtime does not undo
a database migration: use the matching stopped compatible backup if needed.

### Fresh Windows 11 VM, independent snapshots

Use a new disposable VM/user, not this owner's WSL distros. Keep snapshots for
WSL absent, WSL present/Ubuntu absent, reboot pending, Ubuntu without Linux Node,
wrong/missing pnpm and unavailable systemd/bwrap/socat. In each variant extract
the same approved ZIP and run setup; record exit/guidance before repairing it.

```powershell
$archive = 'sentry-0.1.0-beta.1-d934e676e2a7-windows-x64.zip'
$expected = ((Get-Content -LiteralPath ($archive + '.sha256')) -split '\s+')[0]
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Checksum mismatch' }
Expand-Archive -LiteralPath $archive -DestinationPath "$env:LOCALAPPDATA\Sentry\acceptance-d934e676e2a7"
cd "$env:LOCALAPPDATA\Sentry\acceptance-d934e676e2a7\sentry-0.1.0-beta.1-d934e676e2a7-windows-x64"
.\sentry.ps1 version
wsl --list --verbose
.\sentry.ps1 setup -NonInteractive
# After explicit VM-only WSL/Ubuntu/reboot/prerequisite repair:
.\sentry.ps1 setup -Distro Ubuntu
.\sentry.ps1 setup -Distro Ubuntu
.\sentry.ps1 open
.\sentry.ps1 open
.\sentry.ps1 doctor
.\sentry.ps1 stop
```

Expected: version works without Git/Windows Node/pnpm; absent prerequisites fail
with actionable guidance and no activation; required reboot returns exit 75 and
rerun is documented. After manual repair, first/repeated setup, full matching
Linux hello, Environment, single-instance GUI and graceful stop pass. Use the
Linux prerequisite commands in [distribution setup](../setup/distribution.md)
inside this VM only. Record the fresh-machine result separately from this report's
configured-host/disposable-home checks. Do not alter an owner distro to simulate
these variants.

## Deferred review finding

**Important, existing diagnostic false negative:** `--sentry-credential-status`
constructs ProviderCredentialService without its Electron safeStorage bridge.
With the e4b8fca test profile containing the synthetic encrypted key, this CLI
reported all presence booleans false. The production providers.status IPC does
supply that bridge; the d934e67 continuity proof above uses that approved path.
Repairing the standalone diagnostic is deferred as a focused follow-up. Do not
interpret its false output as evidence that the encrypted store was lost.
No additional security/runtime redesign or Phase 5 work was performed.

Full branch diff self-review found no remaining introduced blocker in correctness,
data loss/secrets, process ownership or lifecycle; the diagnostic finding and
required platform/test gaps are not waived by that review.

## Outstanding blockers and recommendation

Native CachyOS GUI/install/upgrade/encryption/maintenance/rollback acceptance and
fresh Windows prerequisite/reboot provisioning remain unavailable. Real funded
active-QA maintenance/cancellation and physical-host fault-injection/rollback
acceptance remain owner requirements. Native Windows full-suite failures remain
disclosed diagnostics rather than waived tests. Exact-head CI and owner review
are required for integration; signing/publication and Phase 5 are separate scope.

The reproduced launcher corrections and available artifact checks can be reviewed
now. **Do not mark Phase 4 fully accepted or start Phase 5 solely on these results.**
