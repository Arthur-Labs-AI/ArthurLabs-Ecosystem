# Windows space after project removal — investigation, October 14, 2026

Owner reports full production QA 3/3 and project removal working, but removing
Nexus did not visibly increase free C: space. This investigation is read-only:
no owner data deletion, database vacuum, WSL shutdown, trim or disk compaction.
Installed runtime remains source `64bff9fdcb5aed2335c4cf1efbe0815a2edcde48`.

## Verified local facts

- Read-only SQLite connection: projects, managed copies, revisions, QA runs,
  agent runs, artifacts and deletion-operation counts are all zero.
- The managed `projects` directory uses 8,192 bytes. No `proj_*` directories or
  `.deleting` tombstones remain. Its small `.claude` metadata directory is not a
  retained project copy. SQLite quick_check is `ok`.
- Original `C:/Users/merte/Documents/GitHub/Nexus` is present, as the removal
  contract requires. Removing an imported project does not remove its source.
- The database file retains 28,295,168 bytes, with 27,729,920 bytes on its free
  list, reusable by future writes. SQL row deletion does not shrink that file.
- WSL 2.6.3.0 / Ubuntu uses a non-sparse dynamically expanding disk file at
  `C:/Users/merte/AppData/Local/wsl/{21d1d563-332b-4442-abd2-749dbeb0bde4}/ext4.vhdx`.
  File length: 41,687,187,456 bytes (38.82 GiB). Ubuntu filesystem usage is
  approximately 38,841,647,104 bytes (36.17 GiB), including all its other files.
  C: had approximately 3.9 GiB free during these readings; concurrent system
  activity means this is not a project-deletion before/after measurement.
- The measured runtime directory occupies 3,416,387,584 bytes and provider tools
  1,203,798,016 bytes. These are separate from removed projects and include shared
  files/hard links; their measurements are not promises of reclaimable space.
  Optional broad `/var/tmp` measurement was stopped after an exact argv check;
  systemd-private directories were inaccessible, so no complete total is claimed.

## Diagnosis and boundary

Project removal completed and cleared both canonical records and managed trees.
Deleting Linux files frees blocks for reuse inside Ubuntu. Windows accounts for
the enclosing `ext4.vhdx` file; a non-sparse dynamically expanding VHD does not
automatically shrink after deletion. The observed lack of immediate C: recovery
matches that storage behavior, not a retained Nexus project.

Microsoft documents both the WSL VHD layout and the dynamic-disk behavior:

- https://learn.microsoft.com/en-us/windows/wsl/disk-space
- https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/compact-vdisk

The original confirmation's phrase "to free disk space" is incomplete for
Windows/WSL: it describes reusable Linux storage, not guaranteed immediate host
space recovery. Future product copy/maintenance should distinguish these values.
An offline host-space maintenance action would stop Sentry and other WSL
workloads, trim Ubuntu's freed blocks, shut down WSL, compact the detached or
read-only virtual disk, then measure and verify again. This was not requested
or executed as part of the investigation. Exact reclaimable bytes are unverified;
there is no pre-removal Nexus measurement and the disk still contains Ubuntu data.

Private read-only receipts/scripts:
`C:/Users/merte/.codex/artifacts/sentry-wsl-space-investigation-20261014`.
No application code changed, so prior source-test results are not claimed as
new test executions. No paid QA, GitHub PR or push. Owner acceptance is reported
as owner-provided evidence. `shux contract` is unavailable; protocol records are
maintained directly. Primary checkout's existing owner edits remain untouched.
