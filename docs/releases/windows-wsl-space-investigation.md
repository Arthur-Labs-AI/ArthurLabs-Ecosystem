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
  The optional `/var/tmp` walk completed before its exact-argv stop guard ran.
  Accessible contents totaled 24,377,204,736 bytes (22.70 GiB); protected
  systemd-private directories were inaccessible, so this is not an exhaustive
  total. A separate top-level scan observed 25,475,842,048 bytes (23.73 GiB)
  under `/var/tmp`; this invocation counts shared hard links differently and
  returned status 1, so it is not an exhaustive storage audit. Much of the area
  consists of retained Sentry validation fixtures, separate from the live store.
- Large observed validation directories include
  `sentry-hardening-validation.yFSWRB` (2,230,321,152 bytes),
  `sentry-phase4-validation.9OrWhh` (2,227,318,784 bytes),
  `sentry-phase62-gui-data.Jj3t3I` (2,190,290,944 bytes), and
  `sentry-beta-deploy.BjKLL0` (1,665,150,976 bytes). The Phase 6.2 synthetic
  `sentry-phase62-large-project` is 1,094,692,864 bytes. These retained validation
  materials contribute to storage pressure even after an owner project is
  removed. No fixture is automatically classified as safe to delete solely by
  name; retained recovery/history evidence must be reviewed before cleanup.

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
An offline host-space maintenance action would first review and clean obsolete
validation fixtures while preserving required evidence and active data, then stop
Sentry and other WSL workloads, trim Ubuntu's freed blocks, shut down WSL, compact
the detached or read-only virtual disk, then measure and verify again. This was not requested
or executed as part of the investigation. Exact reclaimable bytes are unverified;
there is no pre-removal Nexus measurement and the disk still contains Ubuntu data.

Private read-only receipts/scripts:
`C:/Users/merte/.codex/artifacts/sentry-wsl-space-investigation-20261014`.
No application code changed, so prior source-test results are not claimed as
new test executions. No paid QA, GitHub PR or push. Owner acceptance is reported
as owner-provided evidence. `shux contract` is unavailable; protocol records are
maintained directly. Primary checkout's existing owner edits remain untouched.
