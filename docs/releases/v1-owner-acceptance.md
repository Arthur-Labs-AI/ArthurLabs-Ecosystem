# Sentry v1 owner acceptance procedure

> Historical both-host acceptance campaign. Windows 11 x64/WSL2 is the initial
> v1 release target; native Linux Desktop acceptance is DEFERRED — FUTURE NATIVE
> LINUX RELEASE. Preserve all historical failures and unchecked rows below.
> Use the [current Windows receipt](v1-phase-6-2-windows-transition.md) for release gates.

This procedure finishes the evidence gates for Phases 4 and 5. It does not
authorize Phase 6, provider spending, a version bump, tags, or publication.
The candidate version remains **0.1.0-beta.1**; its full source SHA identifies
the new implementation. The published beta is immutable.

Use [distribution setup](../setup/distribution.md) for prerequisite installation,
activation, repair and rollback commands. Use the [results template](v1-owner-acceptance-results.md)
for evidence and the [v1 checklist](V1_ACCEPTANCE_CHECKLIST.md) for authorization.
The historical beta checklist is not a v1 acceptance receipt.

Current preparation: [Phase5.3](v1-phase-5-3-final-host-acceptance.md), after
owner-merged PR19/dev5c68491 and successful post-merge CI. Use its exact I1 lock,
native operator workflow and separate recovery decision; historical W1/C1 and
original G10 FAIL remain unchanged. Owner policy adoption is still required.

## Evidence and candidate selection

Run each applicable row below separately on Windows/WSL and native CachyOS.
Copy the results template per host and candidate; do not overwrite earlier
attempts. A retest references the failed attempt and the new archive checksum.
Record OS/build, CPU architecture, graphical session, Node/pnpm, systemd,
bubblewrap, secure-storage backend, full SHA, tree SHA, archive filename/SHA256,
manifest identity, Desktop/runtime hello identity, command/action, exit status,
observed behavior, sanitized evidence reference, defect and retest requirement.
Use anonymous host labels (W1, C1); do not commit machine names, private paths,
credentials, account details or raw logs. Screenshots must hide sensitive data.

| Verdict                   | Meaning                                      |
| ------------------------- | -------------------------------------------- |
| PASS                      | Executed successfully with evidence          |
| FAIL                      | Executed and failed                          |
| NOT RUN                   | Not yet executed                             |
| ENVIRONMENT UNAVAILABLE   | Required environment inaccessible            |
| OWNER ACCEPTANCE REQUIRED | Needs an owner-controlled action             |
| BLOCKED                   | Cannot proceed because a prerequisite failed |

Retain failures even if a later attempt passes. Name the blocking test for
BLOCKED, the missing capability for ENVIRONMENT UNAVAILABLE, and the required
owner action for OWNER ACCEPTANCE REQUIRED. A skip is never PASS.

Before distributing bytes, the maintainer records the exact candidate SHA,
tree SHA (`git rev-parse <sha>^{tree}`), CI run URLs/conclusions and both archive
checksums in a receipt. The preparation PR body and its final engineering
handoff carry that receipt. Obtain files through an owner-approved private
channel; workflow artifacts expire after seven days. Preserve the downloaded
archives and checksum sidecars privately for the full acceptance period.

The distribution workflow builds the PR **head SHA**. The quality workflow
normally checks GitHub's proposed merge tree. Record both; do not call a
proposed merge commit the PR source commit. After an owner-approved merge,
record the actual merge SHA/tree, check post-merge CI, and build artifacts at
the selected integrated SHA (existing workflow_dispatch or a clean native
checkout). Verify tree equivalence explicitly if reusing earlier evidence:

```bash
git rev-parse <pr-head>^{tree} <merge-sha>^{tree}
git diff --exit-code <pr-head> <merge-sha>
```

Equal trees support source equivalence; earlier archives still identify the
earlier SHA. They must never be relabelled as built from the merge SHA. If
contents change, rerun affected tests and generate new exact-SHA archives.
Only owner approval selects an accepted candidate. Do not merge or create an RC
branch as part of these instructions.

## A — Distribution integrity (both platforms)

Obtain the approved `sentry-0.1.0-beta.1-<sha12>-windows-x64.zip` or
`sentry-0.1.0-beta.1-<sha12>-cachyos-x64.tar.gz`, its `.sha256`, and the full-SHA
receipt. Follow the checksum/extraction commands in the setup guide. Extract
into a new directory with spaces, outside every source checkout. Run the
archive's own `sentry.ps1 version` or `./sentry version`, using the explicit
relative launcher, never the global source shim.

| Test ID | Procedure and required observation                                                                                                                                                                                                                                                      |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01     | Compare full receipt SHA to root, Desktop and runtime-source build-identity.json and distribution.json. All version/protocol/SHA values agree.                                                                                                                                          |
| A02     | Run Get-FileHash or sha256sum -c against the trusted sidecar. Record filename, expected and actual SHA256. Checksums prove integrity, not publisher authentication; candidates are unsigned.                                                                                            |
| A03     | Extract successfully; run version and record its complete identity and exit 0. Inventory validation and required Electron resources succeed.                                                                                                                                            |
| A04     | Make a disposable copy of the archive, alter a byte, rerun checksum verification and refuse extraction/installation after mismatch. Never repair the checksum to make it pass.                                                                                                          |
| A05     | In a separate extracted copy, change a listed file, then run version; expect nonzero integrity rejection. Repeat with an unexpected file, and with a mismatched identity in build-identity.json. Keep original archive immutable.                                                       |
| A06     | Inspect inventory and extracted names for .env, credentials, logs, databases, .git, workspaces and local development state; expect none. Use existing distribution contract tests for traversal/symlink adversarial coverage; record them as automated, separately from this host test. |
| A07     | From a directory outside the source checkout, use the extracted launcher for setup/open. Desktop loads its packaged resources and the staged Linux runtime; no original checkout or Windows Node/Git/pnpm is needed.                                                                    |
| A08     | Record installed Desktop identity and runtime hello/full SHA after setup. A mismatched Desktop/runtime pair must refuse readiness in a disposable failure fixture, then recover with the matching candidate.                                                                            |

Do not launch tampered copies beyond their integrity gate. Use the untouched
archive for all remaining groups. Integrity failure blocks installation.

## B — Fresh Windows 11 x64 / WSL2

Use a clean Windows account or disposable VM. The primary development profile
must not be reconfigured. Missing-feature, conversion and reboot cases use
separate VM snapshots; do not remove the owner's WSL distribution. Record
`Get-CimInstance Win32_OperatingSystem`, `wsl --version`, `wsl --list --verbose`,
and inside the selected distro `uname -sr`, `node --version`, `pnpm --version`,
`systemctl --user is-system-running`, `command -v bwrap socat systemd-run`.
Keep only sanitized version/capability fields in shared evidence.

Run the setup guide's explicit prerequisite steps. Linux Node >=22 and pnpm
9.12.3 must resolve through **direct WSL execution**, not only a login shell.
Any sudo/Windows feature elevation is a deliberate manual owner action.

```powershell
# From the verified extracted directory in the disposable Windows account:
.\sentry.ps1 setup -Distro Ubuntu
.\sentry.ps1 tools -Distro Ubuntu
.\sentry.ps1 open
.\sentry.ps1 status
.\sentry.ps1 doctor
# Inspect Environment in Desktop before stopping.
.\sentry.ps1 stop
```

| Test ID | Procedure and required observation                                                                                                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B01     | With WSL absent in a disposable VM, setup prints actionable missing-feature guidance; no hidden elevation or apparent success.                                                                              |
| B02     | With no usable distro, verify discovery/selection and account-creation guidance; utility distros are ignored. Record the chosen WSL2 distro.                                                                |
| B03     | Exercise pending-reboot/conversion prerequisites in the VM; expect pause/guidance (exit 75 where documented), then successful explicit rerun after reboot.                                                  |
| B04     | Remove Node/pnpm from a fixture PATH, expect prerequisite guidance, then verify direct wsl -d Ubuntu -- node --version and pinned pnpm after manual repair.                                                 |
| B05     | Verify systemd user manager, bubblewrap and socat. Missing sandbox capability blocks execution; repair prerequisites without disabling sandboxing.                                                          |
| B06     | Run setup from a path with spaces. Record every phase, exit status, release log, unique staged runtime directory and runtime/current target.                                                                |
| B07     | Launch Electron; Environment shows connected WSL runtime with matching full identity and truthful readiness diagnostics. No dev server or original checkout is required.                                    |
| B08     | Run tools and inspect pinned binary versions and provider statuses. Presence/readiness alone does not establish funded success.                                                                             |
| B09     | Import a disposable project from a path with spaces; inspect its managed revision and project doctor. Source bytes remain unchanged.                                                                        |
| B10     | Repeat setup after graceful stop; expect a distinct staged directory, successful validation/activation and preserved existing data/settings.                                                                |
| B11     | Launch a second time while Desktop is open; expect the existing instance, no duplicate runtime or QA execution.                                                                                             |
| B12     | Stop gracefully, confirm owned Desktop/runtime exit, then reopen and verify handshake, projects and history remain.                                                                                         |
| B13     | Leave a disposable pre-existing beta/source installation beside the archive; verify its source files and global shim are preserved. Archive update refuses and does not change channels.                    |
| B14     | Exercise failed/interrupted setup on disposable installation copies; verify actionable logs and recovery using the setup guide's narrowly scoped lock inspection. Never delete a data root to repair setup. |

## C — Native CachyOS x64

The team member must execute this group on the actual CachyOS laptop in a
normal graphical user session. Ubuntu WSL and Ubuntu CI cannot satisfy C rows.
Record `/etc/os-release` ID/version (omit identifying custom fields), `uname -m`,
session type, Node/pnpm versions, `systemctl --user is-system-running`, and
`command -v bwrap socat systemd-run`. Confirm the system package list and
explicit installation commands in the setup guide, including pinned pnpm.

```bash
# From the verified extracted directory in the disposable native user profile:
./sentry version
./sentry setup
./sentry tools
./sentry open
./sentry status
./sentry doctor
./sentry stop
```

| Test ID | Procedure and required observation                                                                                                                                         |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01     | Confirm native CachyOS ID, x86_64 architecture and graphical X11/Wayland session. Record actual session, not simulated environment variables.                              |
| C02     | Confirm required pacman packages, Linux Node >=22 and pnpm 9.12.3. Missing-package diagnostics are actionable, with no hidden sudo.                                        |
| C03     | Confirm running systemd user manager and working bubblewrap/user namespaces; keep Electron and worker sandboxes enabled. Never add --no-sandbox or direct-worker bypasses. |
| C04     | Install the actual CachyOS-targeted archive in a path with spaces; record staging, activation/current target and hello identity.                                           |
| C05     | Launch the packaged GUI and inspect Environment/readiness; no source checkout or development server is involved.                                                           |
| C06     | Import a disposable project, inspect managed revision/doctor and retained source bytes.                                                                                    |
| C07     | Stop, verify owned processes exit, then reopen; handshake, history and settings remain correct.                                                                            |
| C08     | Repeat setup after stop, record unique runtime target and preserved existing installation/data.                                                                            |
| C09     | Launch twice and verify single-instance behavior. Archive update refuses without changing the source channel/global shim.                                                  |
| C10     | In disposable fixtures only, exercise missing graphics/prerequisite and invalid-candidate diagnostics; repair the cause and verify normal launch.                          |
| C11     | Run the real sandbox trust suite from a clean checkout of the candidate on this native host; retain capability/8-case results separately from packaged GUI acceptance.     |

Native C rows remain ENVIRONMENT UNAVAILABLE until this host is accessible.
If a real host prerequisite fails, record FAIL and block its dependent rows.

## D — OS-backed credential privacy (both platforms)

Use an isolated OS account/profile and a conspicuously synthetic credential
such as `synthetic-sentry-storage-test-only-001`. It must never be used in a
provider run. Use Settings → Providers and the normal supported secure-storage
backend. Record backend/availability without logging secret values. Fake enc:
unit fixtures do not prove DPAPI or Linux keyring behavior.

| Test ID | Procedure and required observation                                                                                                                                                      |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D01     | Save the synthetic credential through Desktop; observe secure persistence/presence-only status and actual DPAPI or supported Linux secure backend.                                      |
| D02     | Gracefully stop and relaunch the same account/profile; credential remains available, never displayed as plaintext in status.                                                            |
| D03     | Inspect isolated persistent store bytes privately for the synthetic value; it must be absent. Record only the boolean result, never ciphertext/blob contents.                           |
| D04     | Inspect status, sanitized logs and exported diagnostics for the synthetic value; expect absence. Screenshots hide entry fields.                                                         |
| D05     | In a disposable profile with no key, expect missing. In a copy with an unreadable entry, expect unavailable/unreadable rather than missing or usable. Preserve the original test store. |
| D06     | On an isolated backend-unavailable session, save refuses with secure-storage guidance and no plaintext fallback; record actual host capability or ENVIRONMENT UNAVAILABLE.              |
| D07     | Use a second empty profile/account; verify the first profile's credentials are absent. Do not transfer ciphertext across OS users/keychains and infer decryption continuity.            |
| D08     | Follow G upgrade with the same account/profile/keychain; verify synthetic key and preferences survive compatible upgrade and repeated launch.                                           |

Delete only the synthetic key using the normal UI after testing. Do not alter
the owner's credential store or publish any private logs.

## E — Funded independent-agent QA (both platforms)

Every execution here requires explicit owner authorization for the exact
providers, account, model, run count and spending ceiling. Record approval in
the private host receipt before starting. Stop at the ceiling; this runbook
grants no spending permission. Missing approval/credit means OWNER ACCEPTANCE
REQUIRED. Credentials/readiness checks and fake-provider tests are not substitutes.

Use the same small disposable project revision containing a known deterministic
defect and a bounded test command. Freeze/import it once, then use full and
targeted scopes via Desktop; targeted includes only the chosen relevant paths.

| Test ID | Selected agents           | Modes (separate evidence per mode) |
| ------- | ------------------------- | ---------------------------------- |
| E01     | OpenCode                  | Full, Targeted                     |
| E02     | DeepSeek                  | Full, Targeted                     |
| E03     | GLM                       | Full, Targeted                     |
| E04     | OpenCode + DeepSeek       | Full, Targeted                     |
| E05     | OpenCode + GLM            | Full, Targeted                     |
| E06     | DeepSeek + GLM            | Full, Targeted                     |
| E07     | OpenCode + DeepSeek + GLM | Full, Targeted                     |

For every mode/row record run/operation IDs, snapshot/revision, selected AgentRun
IDs and provider/model attribution, truthful independent progress and terminal
states, findings/evidence links, useful partial results after any failure,
historical persistence after reopen and matching JSON/log exports. Unselected
agents must not execute. There must be no fabricated Merger/Verifier stages,
mandatory legacy orchestration or duplicate paid execution. Capture provider
failure codes safely; do not intentionally spend against an invalid/empty account.
If partial failure is not observed, record its scenario NOT RUN rather than
claiming it from a successful all-agent run.

## F — Cancellation and recovery (both platforms)

Use disposable projects/data, normal cancellation and owned processes. Active
provider scenarios require the E spending approval; coordinate interruptions
with the operator. Do not force-kill unrelated processes or corrupt a real DB.

| Test ID | Procedure and required observation                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F01     | Cancel active QA normally; cancellation is acknowledged, selected agents settle, parent reaches the truthful terminal state, useful history/evidence remains.                                          |
| F02     | Inspect process ownership and retained run IDs; no abandoned owned children, unintended retry or duplicate paid run follows cancellation.                                                              |
| F03     | Stop/reopen after a completed run; run, individual results and exports remain readable and correctly attributed.                                                                                       |
| F04     | Restart the owned runtime in a controlled disposable session; record actual disconnect/reconnect behavior and Environment state. Do not infer automatic reconnect where the product requires relaunch. |
| F05     | Interrupt owned active work under an approved controlled test, reopen and inspect recovery: interrupted, failed, cancelled and completed remain distinct; no fabricated success or replay.             |
| F06     | Attempt setup/repair/update while QA is active; maintenance refuses, active work and runtime/current remain intact. Cancel and settle before retrying maintenance.                                     |
| F07     | Inspect historical issues/retests, run a separately authorized disposable retest if applicable, cancel/reopen it and verify lineage/evidence are retained.                                             |

## G — Beta upgrade, repair and rollback (both platforms)

Actual integrated-candidate [campaign receipt](v1-owner-acceptance-execution.md)
records **G10 FAIL on W1**: restored beta history/ciphertext survived, but beta
could not report the synthetic credential configured. The original-beta track
remains failed. [Separate I1 G10-R](v1-phase-5-2-g10-recovery-validation.md) passed
in the synthetic Windows scope; [owner policy adoption](v1-recovery-policy-decision.md)
is outstanding. The [bounded proposal](v1-beta-rollback-credential-proposal.md)
retains the historical diagnosis.
Preserve this failure; do not treat the procedure below as an already accepted
beta credential recovery path or transfer W1 results to native CachyOS.

Start with a disposable stopped backup derived from the supported
`v0.1.0-beta.1` source-beta layout at full commit
`0e5c10cfa80f6385ebfc88a7306b38ce8a12ce38`. Include database/project material
and same-account Desktop encrypted settings. Do not replace the primary install.
Use the exact backup/data-root and side-by-side procedure in the setup guide.
Where useful, existing `scripts/distribution/tests/beta-history.mjs` and Windows
`secure-settings.mjs` provide synthetic fixtures; execute only after reading
their required arguments. They do not replace the manual target-host checks.

| Test ID | Procedure and required observation                                                                                                                                                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G01     | Stop beta gracefully, record identity, back up actual Linux data root and same-user Desktop appData privately; verify the backup can be read before proceeding.                                                                                             |
| G02     | Inventory projects, revisions, runs, findings/evidence, issues, retests, exports/metadata and preference/credential presence in the disposable beta copy. Record counts and representative IDs, without secrets.                                            |
| G03     | Extract/verify candidate alongside beta; validate it before activation. Global source shim, old executable/runtime and data backup remain available.                                                                                                        |
| G04     | With all components stopped, run candidate setup; runtime/current moves atomically only to a validated target with matching SHA/version.                                                                                                                    |
| G05     | Reopen candidate and compare G02 data/counts/representative lineage and export bytes; confirm no records lost and compatible same-profile credential/preferences continuity.                                                                                |
| G06     | In disposable failure fixtures, reject a corrupted/mismatched candidate before activation; old runtime/current remains available. Verify failed first-install activation leaves no false active runtime.                                                    |
| G07     | Exercise post-activation handshake failure in a disposable test; prior current is restored and user data remains untouched.                                                                                                                                 |
| G08     | Repeat setup/repair after stop; new unique staging directory, correct current identity, retained history and no accidental data deletion.                                                                                                                   |
| G09     | Verify update/setup refusal while active execution runs (F06); gracefully settle before maintenance.                                                                                                                                                        |
| G10     | Exercise documented rollback with stopped components. Never open a migrated DB blindly with an older binary: check schema compatibility, or restore the matching stopped DB/project/profile backup and old runtime/binary together. Reopen and compare G02. |

## Completion and handoff

Review every row and both modes of E. List confirmed defects, failed gates,
owner actions, unavailable environments, non-blocking limitations and deferred
items separately. Link sanitized logs/screenshots and archive receipt per host.
The owner reviews preservation, security and supported-platform reliability
before signing acceptance. Implementation complete, automated verification,
real-machine acceptance and release authorization are four separate gates.
Stop for owner review; Phase 6 remains unauthorized.
