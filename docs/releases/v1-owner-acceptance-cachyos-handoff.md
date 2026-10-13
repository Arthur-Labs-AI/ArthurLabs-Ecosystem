# Native CachyOS operator handoff — candidate D

Historical D handoff retained unchanged below. For the current exact I1
campaign use the [Phase5.3 native package](v1-phase-5-3-cachyos-operator.md)
and its partial receipt; do not substitute D bytes or overwrite C1 results.

Status: **ENVIRONMENT UNAVAILABLE to the agent; no native cases executed**.
Return a completed copy of [C1 receipt](v1-owner-acceptance-c1-d250e4c.md), using
the existing [runbook](v1-owner-acceptance.md) requirements. No WSL or Ubuntu
result passes a native case. Phase6 remains unauthorized.

## Exact private input

Use `sentry-0.1.0-beta.1-d250e4cabdae-cachyos-x64.tar.gz` and its original SHA256
sidecar from the privately retained `dist/owner-campaign/ci-cachyos-x64` bundle.
Expected archive SHA256:
`216feca40136f64a101e63fbc20d44e04eca293496027cdae21d2618acca2d9e`.
Full source `d250e4cabdae7735af5905146db8d7806fe4427c`, tree
`a86a2c8ea160eef13cb2783568594de10955d158`; version0.1.0-beta.1, protocol1.
[Distribution38366622239](https://github.com/Mert1026/Sentry/actions/runs/38366622239),
artifact11796573381 expires October20 08:05:35Z; already preserved locally.
An owner with repository access can also download that exact artifact using
`gh run download 38366622239 --repo Mert1026/Sentry --name unsigned-review-cachyos-x64-d250e4cabdae7735af5905146db8d7806fe4427c`.
Recheck trusted checksum after transfer. Do not use a later evidence-branch build
or the old42c archive for this receipt. All artifacts are unsigned.

## Isolate and verify the real host

Prefer a disposable **OS account in an actual graphical CachyOS session**. A
temporary HOME/APPDATA alone does not prove Electron/keychain isolation. Do not
alter the owner's real install/profile, disable security, or invoke a graphical
app as root. Record anonymous C1 only; retain private raw logs locally.

```bash
cat /etc/os-release                 # must be actual CachyOS
uname -sm                          # Linux x86_64; omit hostname
printf 'session=%s\n' "$XDG_SESSION_TYPE"
loginctl show-session "$XDG_SESSION_ID" -p Type -p Active
node --version                     # standalone Linux >=22
pnpm --version                     # exactly 9.12.3
systemctl --user is-system-running
command -v systemd-run bwrap socat curl
bwrap --dev-bind / / --proc /proc /usr/bin/true
pacman -Q nodejs npm systemd bubblewrap socat curl ca-certificates
```

Confirm that the current session actually displays GUI windows; environment
variables alone do not establish that fact. If a required capability is absent,
record its nonzero exit and sanitized guidance, mark dependent cases BLOCKED,
and stop that track. Use [manual setup prerequisites](../setup/distribution.md)
to repair with the operator's normal package-management permission; do not hide
sudo or spoof distro/graphics checks. Node/pnpm are needed to install/build the
runtime. No source checkout is needed to run the packaged Desktop.

## Archive installation and actual GUI

In the disposable graphical account, put archive/sidecar in a private work
directory and run these commands there. Stop on any mismatch/nonzero result.
Record exit codes and phases; do not continue down the list after failure.

```bash
sha256sum sentry-0.1.0-beta.1-d250e4cabdae-cachyos-x64.tar.gz
sha256sum -c sentry-0.1.0-beta.1-d250e4cabdae-cachyos-x64.tar.gz.sha256
mkdir 'C1 acceptance with spaces'
tar -xzf sentry-0.1.0-beta.1-d250e4cabdae-cachyos-x64.tar.gz -C 'C1 acceptance with spaces'
cd 'C1 acceptance with spaces/sentry-0.1.0-beta.1-d250e4cabdae-cachyos-x64'
./sentry version
./sentry setup
./sentry status
./sentry doctor
./sentry tools
./sentry open
```

Expected `version`: complete D source identity, version0.1.0-beta.1, protocol1,
exit0. Inventory should validate333 files. Record candidate staging/current
targets privately and compare full runtime hello to Desktop/root identities.
Observe the actual loaded Environment, readiness and provider presence. Import a
small disposable project in a path with spaces; verify managed revision/doctor,
source bytes unchanged, History navigation, no renderer Node access. Tools/readiness
are not evidence of funded success. Configure only synthetic credentials for D.

While open, invoke `./sentry open` again: existing instance should be retained,
without duplicate runtime/work. Then `./sentry stop`, verify only owned processes
exit, `./sentry open`, verify same profile/history and secure credential presence.
Stop again; repeat `./sentry setup`, record new unique validated current target,
previous target and retained data. Inspect `./sentry update` refusal; source shim
must remain untouched. Run A04/A05 only on separately named disposable archive
and extraction copies; never alter the original or invent a replacement checksum.

For D01–D08 record the **actual native secure-storage backend**. Save a synthetic
value through Desktop, relaunch same OS account/keychain, check secure presence,
and inspect persistent bytes/status/diagnostics privately for plaintext absence.
Do not publish values or ciphertext. If the backend is unavailable, record the
real save refusal and no plaintext fallback; do not force a basic-text backend
to manufacture a pass. Test missing/unreadable copies and second empty profiles
without touching the accepted profile. Native keychain evidence is independent
of Windows DPAPI results.

## Separate exact-source native sandbox trust

Use a separate clean source checkout at full D (not the evidence PR head):

```bash
git clone --no-checkout https://github.com/Mert1026/Sentry.git sentry-c1-trust
cd sentry-c1-trust
git checkout --detach d250e4cabdae7735af5905146db8d7806fe4427c
git rev-parse HEAD 'HEAD^{tree}'
git status --porcelain
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @qa/run-engine exec vitest run tests/verification-trust.test.ts --maxWorkers=1 --minWorkers=1
```

Record each actual case and capability/exit separately; a skip is not PASS:

| Native trust case                                  | C1 result before operator execution |
| -------------------------------------------------- | ----------------------------------- |
| Reproduces known failing test with strong identity | ENVIRONMENT UNAVAILABLE             |
| Refuses confirmation of a different failing test   | ENVIRONMENT UNAVAILABLE             |
| Fake secrets absent in every persistence layer     | ENVIRONMENT UNAVAILABLE             |
| Project clean commands cannot escape sandbox       | ENVIRONMENT UNAVAILABLE             |
| Canonical relative replay cwd in monorepos         | ENVIRONMENT UNAVAILABLE             |
| Descendant processes terminated after parent       | ENVIRONMENT UNAVAILABLE             |
| Shell-escaped replay refused without execution     | ENVIRONMENT UNAVAILABLE             |
| Missing tools produce inconclusive warning         | ENVIRONMENT UNAVAILABLE             |

Do not set the hosted trust-exclusion fallback, disable namespaces, or substitute
direct execution. A missing systemd mount capability blocks C11; retain the
failure and repair the real prerequisite.

## Provider, recovery and upgrade remainder

All14 native E combinations/modes remain OWNER ACCEPTANCE REQUIRED. The owner
supplied a successful Windows/WSL Full all-three export, reviewed in the separate
[owner-run receipt](v1-owner-run-01M4T9XG-acceptance.md). It grants no native credit
or agent-funded calls, and does not execute the other13 cases. Collect anonymous
account/model labels, host/archive
identity, run/AgentRun/snapshot IDs, per-agent outcomes/findings/evidence,
persisted history and matching exports, no duplicate work. Partial failure,
cancellation and interruption need separate actual evidence; do not infer them
from success. F01/F02/F05/F06/F07/G09 need approved active-work scope.

For G use private disposable **matching stopped beta data/project/profile**
backups and a side-by-side exact candidate. Inventory IDs/counts, preferences,
and populated exports before upgrade; compare after. Keep original installation
and previous valid runtime. Follow the runbook's candidate rejection, repair
and atomic activation cases. Do not open a migrated DB with the older binary.
**G10 beta credential rollback failed on W1**: see the
[bounded correction proposal](v1-beta-rollback-credential-proposal.md). Do not
present it as an accepted recovery path. Native G10 remains unexecuted, pending
owner disposition of the rollback target/procedure; do not transfer W1's FAIL
or its DPAPI positives into a native result.

Return all58 C1 rows using canonical verdicts and full source/archive/checksum,
commands/actions, exits, sanitized observations, defect/retest references. Include
anonymous OS/session/backend facts, loaded screenshots with identifiers/inputs
hidden, separate eight trust results and failed attempts. Raw logs, DB backups,
provider stores, usernames, home paths and machine identifiers stay private.
Review the [checklist](V1_ACCEPTANCE_CHECKLIST.md) with the owner afterward;
neither operator execution nor CI creates Phase6 authorization.
