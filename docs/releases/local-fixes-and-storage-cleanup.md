# Local fixes and storage cleanup

Publication record: 15 October 2026. Branch: `codex/sentry-local-fixes`.

## Included application changes

The branch preserves the previously committed Windows setup bridge correction,
DeepSeek persistent Bash evidence fix, visible Desktop launch, project removal,
and WSL disk reclamation with the subsequent disk-release lock correction.
Application/archive source is `f9c2a4796f3519d5e6105970a94902fe4dca5a3a`;
the preceding local verification receipt is `d86a401`.

The owner reported a completed DeepSeek run, a successful three-agent run,
working project removal, and a successful reclamation result of 0.03 GiB with
Sentry reconnected. These are owner-reported acceptance results. Earlier
automated/build/package checks remain documented in their individual receipts;
they were not rerun for this documentation-only publication commit.

## Storage investigation and cleanup

On 14 October, old Sentry validation/install fixtures occupied 24.22 GiB in
Ubuntu's `/var/tmp`. Those live files explained why compaction alone reclaimed
little space. Cleanup removed 206 inventoried test environments and 32 retired
runtime versions, freeing 25.48 GiB inside Ubuntu. Filesystem usage fell from
40,023,982,080 to 12,664,504,320 bytes. The canonical database checksum was
unchanged, `quick_check` passed, and the current runtime and provider tools were
retained. Process references, mount boundaries and retained symlink dependencies
were checked before deletion.

The matching Desktop and recovery ZIP were moved from a disposable checkout to
`%LOCALAPPDATA%\Sentry\releases\sentry-1.0.0-rc.1-f9c2a4796f35-windows-x64`.
The global Sentry command and private helper pointers were updated. Distribution
checksums, launcher version/doctor and the paired Linux runtime handshake passed;
the actual relocated executable launched. These installation changes are local
machine state, rather than files distributed by this commit.

Automatic approval review initially blocked remaining Windows deletions after
three copies were removed and two were partly removed. The owner was advised
which folders were obsolete. On 15 October, a read-only publication check found
all 16 inventoried duplicate GitHub folders absent and the original `Sentry`
folder present. No further deletion was performed during publication. C: had
41,027,276,800 bytes free, and Ubuntu's VHDX file length was 15,967,715,328 bytes
(previously 42,342,547,456). These are observed measurements; no additional
compaction operation was executed for this commit.

Complete Git recovery bundles and a verified archive of 10,727 nongenerated
source/receipt files remain private machine-local artifacts. Credentials,
databases, archives, binaries and private logs are not added to Git.

## Publication scope

The original checkout remains on its existing `main` commit, with its older
uncommitted DeepSeek provider-error investigation and project guide preserved.
Only the recent committed fixes and this follow-up record are published on the
task branch. No pull request, merge, tag, release or paid QA run is requested.
`shux contract` was attempted but unavailable; protocol records are maintained
directly.
