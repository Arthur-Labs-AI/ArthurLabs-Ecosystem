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
Matching archive/runtime and packaged confirmation are pending at this snapshot.
Private evidence: C:/Users/merte/.codex/artifacts/sentry-wsl-lock-fix-20261014.

The first candidate's verification record is historical, not proof of this fix.
Architecture update: docs/architecture/wsl-space-reclamation.md.
Microsoft documents the difference between terminating a distro and shutting
down the WSL VM: https://learn.microsoft.com/en-us/windows/wsl/basic-commands.
