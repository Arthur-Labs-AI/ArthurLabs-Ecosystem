# WSL compaction lock-release correction

The owner installed the304d9d0 candidate and tried reclaim three times. Elevated
receipts at22:21:17,22:22:40 and22:22:54 on October14 report File.Open sharing
violations. Same-SID/administrator checks had succeeded; compaction had not run.
The earlier helper terminated Ubuntu and checked that the distro was stopped,
then immediately required exclusive disk access. Stopped was not proof that the
WSL VM had released its VHDX. The prior detached empty-disk test did not cover
that boundary. This is a defect in the first local compaction candidate.

The corrected confirmation explicitly covers WSL VM shutdown, Docker and WSL
terminals. Inspect and reclaim refuse another running distribution before
stopping the owned runtime/trim; the elevated helper rechecks after UAC. Only
after approval, with no other distro running, it calls wsl --shutdown. It does
not issue WSL queries afterward, and waits up to30seconds for exclusive disk
availability. Only Windows sharing/lock errors32/33 are retried. Persistent lock
returns guidance to close applications restarting WSL; unrelated I/O failures
remain immediate. Nothing forcibly detaches or unmounts a disk. Existing idle-QA,
positive runtime shutdown acknowledgement, IPC/CLI/quit gates and release-paired
reconnection stay in place. UAC cancellation now occurs before any VM shutdown.

## Verification before packaging

- RED: new other-distro guard regression reached unsafe trim on the old helper;
  real transient file-lock regression failed at the same File.Open sharing error.
  Both failures reproduced before the repair; old helper8checks still passed.
- GREEN: Windows PowerShell helper15/15 and UI7/7. A separate Windows child holds
  a real exclusive file lock; the first observed probe signals its release,
  and native entry is reached only after availability. No guessed release sleep.
- Added checks cover another distro starting during UAC, VM shutdown order/no
  WSL re-poll, bounded persistent-lock deadline, non-sharing failure without retry,
  cancellation without VM shutdown, and explicit confirmation scope.
- Full Windows Desktop:451pass/3existing prerequisite/platform skips,59files.
- Desktop lint/typecheck and main build PASS; format/diff/hygiene checked.
- Production native wrapper compacted/reopened a newly created detached64MiB
  dynamic VHDX twice. Empty disk remained4MiB allocated,0bytesrecovered as expected.

The tests substitute WSL shutdown commands. The owner's live WSL VM is not
stopped as an automated fixture. Actual corrected populated-Ubuntu compaction
and reclaimed byte count remain UNVERIFIED until the owner confirms the new
button and Windows approval. No owner file cleanup, paid QA, GitHub PR or push.
Private evidence: C:/Users/merte/.codex/artifacts/sentry-wsl-lock-fix-20261014.

The first candidate's verification record is historical, not proof of this fix.
Architecture update: docs/architecture/wsl-space-reclamation.md.
Microsoft documents the difference between terminating a distro and shutting
down the WSL VM: https://learn.microsoft.com/en-us/windows/wsl/basic-commands.

## Exact candidate and installer acceptance

Application/archive source: `f9c2a4796f3519d5e6105970a94902fe4dca5a3a`.
Archive: `sentry-1.0.0-rc.1-f9c2a4796f35-windows-x64.zip`.
SHA256: `f1d3cdf392b32a339b8135374ed84ad18037f849b55341d92bdf6ffe3817a5c3`.

| Gate                                          | Status     | Executed evidence                                                                                                                                         |
| --------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop tests                                 | PASS       | 451pass/3prerequisite/platform skips; helper15/UI7                                                                                                        |
| Static checks                                 | PASS       | Desktop lint/typecheck/main build, changed formatting, hygiene/diff                                                                                       |
| Windows archive                               | PASS       | 20forced builds,332-file inventory and extraction verification                                                                                            |
| Distribution tests                            | PASS       | 32pass/27platform skips                                                                                                                                   |
| Exact native Linux runtime                    | PASS       | Supported stage-only build,18uncached tasks, paired identity                                                                                              |
| Packaged confirmation                         | PASS       | Native dialog/Cancel focus/Escape, updated WSL shutdown/Docker text screenshot inspected; connected runtime/import/single instance/graceful stop          |
| Native compaction wrapper                     | PASS       | Empty detached64MiB VHDX compact/reopen twice,0reclaimedexpected; real sharing error classified and bounded timeout before native entry                   |
| Low-space installer                           | PASS       | PS/Bash syntax, ZIP+full extracted inventory VerifyOnly; same-filesystem native relocation and identity/reopen; isolated atomic activation/repeat install |
| Owner installation and populated-disk reclaim | UNVERIFIED | Owner runs installer then confirms updated button/Windows approval                                                                                        |

The first isolated activation test correctly refused the owner's open304d9d0
runtime. No guard was bypassed or process killed. After the owner closed Sentry,
the exact helper passed under a disposable HOME, including repeat activation and
identity checks. Owner current remained `1.0.0-rc.1-304d9d08898b-da31adf8-de9`.
Packaged GUI used its own profile/data root and never confirmed VM shutdown.

C: became very low during packaging. Private `install-wsl-lock-fix.ps1` therefore
reuses the already verified extracted Desktop and already built Linux runtime.
It stops Sentry through the existing launcher, runs the release's global
maintenance/prerequisite/identity checks, takes its standard maintenance lock,
requires exact source/path/owner and same filesystem, renames only this task's
native candidate into the normal runtime base, probes before and after atomic
current activation with rollback, saves the Ubuntu preference, and opens Desktop.
Existing releases/data are preserved. It neither copies dependencies/rebuilds nor
compacts/shuts down WSL. The explicit button confirmation remains necessary.
Private helper: `promote-verified-runtime.sh`; future open: `open-wsl-lock-fix.ps1`.
This is a local installation aid, not a new published distribution command.
