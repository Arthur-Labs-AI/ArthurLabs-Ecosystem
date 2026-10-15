# Local Windows disk reclamation candidate

The owner's project removal works, but freed Linux blocks remain in Ubuntu's
growing VHDX on C:. Settings -> Runtime now offers **Reclaim Windows disk space**.
The confirmation identifies the connected distribution, warns to save/close
other applications using it, explains administrator approval and allows Cancel
or Escape. Active QA or an unavailable runtime disables the action.

Main synchronously gates other IPC/CLI operations and application quit, pauses
polling, verifies idle QA and the registered disk, and requires an explicit
successful runtime.shutdown acknowledgement before OS maintenance. Shutdown
refusal, timeout or invalid acknowledgement never authorizes WSL termination.
The helper syncs/trims free ext4 blocks, terminates only the selected distribution,
then requests UAC. Under the same Windows SID it rechecks the exact registered
disk, refuses in-use files and invokes Windows OpenVirtualDisk/CompactVirtualDisk.
Native error codes avoid parsing localized DiskPart messages. Sentry reconnects
using the existing release identity/configuration path after success or failure.

No file deletion, filesystem resize, sparse conversion, global WSL shutdown or
1 GiB reserve. The virtual disk retains its maximum capacity and can grow again.
The UI reports actual allocated file bytes via GetCompressedFileSizeW, separately
from volume free bytes; other Windows activity can affect the latter. Zero
recovered bytes is a valid result. Compaction cannot reclaim space occupied by
the retained validation fixtures identified in the earlier investigation.
Project-removal confirmation now explains this separate Windows action.

## Executed verification before packaging

- Baseline: existing router/runtime settings 14/14.
- Regression RED: missing UI/router/gate produced eight failures, one expected
  native Linux absence pass. GREEN new UI/router 9/9; lifecycle 17/17, preload1.
- Real Windows PowerShell 5.1 helper checks 8/8: C# compilation/ABI sizes/native
  nonexistent-path refusal, exact WSL2 registration, unsupported locations,
  locked file refusal, complete argv/order, and no termination after trim failure.
- Read-only helper inspection of the real registered Ubuntu disk PASS. No trim,
  termination, UAC or compaction of that distribution was invoked.
- Native disposable 64 MiB dynamic VHDX: CreateVirtualDisk succeeded; production
  CompactVirtualDisk wrapper succeeded twice, reopening its metadata. Disk never
  attached/mounted; empty disk remained4MiB allocated, correctly reclaiming zero.
- Real staged WSL runtime lifecycle PASS: separate fresh /var/tmp data root,
  acknowledged idle shutdown, transport stop/restart, same data root and empty
  project read after reconnect. Host reclamation substituted; no owner workload
  stopped, no providers called. This integration test requires an explicitly
  staged entry; default runs skip it with that prerequisite stated.
- Full Windows Desktop suite: 444 passed/3 skipped,59files. Two existing Linux
  platform skips and the opt-in real WSL lifecycle gate; that gate passed separately.
- Dependency static checks: 50 uncached build/lint/typecheck tasks PASS. Desktop
  lint and changed-file format PASS. Desktop main/preload/renderer build PASS.
- Final shared active-runs query-key adjustment: affected removal/reclamation
  UI14/14 PASS. Canonical AppShell/Dashboard query is reused.
- Repository hygiene and diff check PASS. React checklist: narrow reusable
  component, shared React Query read, native dialog/Cancel focus/Escape semantics,
  disabled pending controls, measured result and refreshed reads after settlement.

The first broad run exposed outdated quit-test doubles missing the new Electron
profile/host access. The doubles were completed and a real main-process quit gate
regression was added; expectations were retained. An initial helper test's
PowerShell array concatenation precedence was corrected; input refusal semantics
were retained. Initial pnpm test option syntax was corrected to direct vitest.

## Packaged candidate and remaining acceptance

Application/archive source: `304d9d08898b6dd14ed63c677af3145279fc6c95`.
Archive: `sentry-1.0.0-rc.1-304d9d08898b-windows-x64.zip`.
SHA256: `ace840e8886fc5ac770e867f31d9fa53fd92607acb0ecfa3d84555e689ae3113`.
Receipt-only commits after that source do not change the application candidate.

| Gate                                    | Result     | Evidence                                                                                                                                              |
| --------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automated Desktop                       | PASS       | 444 passed/3 prerequisite/platform skips; opt-in real WSL lifecycle separately passed                                                                 |
| Static checks                           | PASS       | 50 uncached dependency tasks; final Desktop lint, changed-file format/hygiene/diff                                                                    |
| Windows artifact                        | PASS       | 20 forced builds, manifest/inventory and extraction verified                                                                                          |
| Windows distribution checks             | PASS       | 32 passed/27 platform skips                                                                                                                           |
| Exact archive Linux runtime             | PASS       | Supported stage-only deployment,18 uncached builds, paired release handshake; owner current unchanged                                                 |
| Packaged GUI                            | PASS       | Production entry/preload/IPC, native confirmation, Cancel focus, Escape, runtime remains connected, project import, single instance and graceful stop |
| Native Windows compaction API           | PASS       | Isolated empty64MiB VHDX compacted/reopened twice,0 reclaimed expected                                                                                |
| Installer helper                        | PASS       | PowerShell syntax and VerifyOnly checksum; no owner installation executed                                                                             |
| Owner upgrade and UAC/real disk reclaim | UNVERIFIED | Requires owner installer and explicit maintenance confirmation/Windows approval                                                                       |

Screenshot `wsl-reclamation-confirmation.png` was inspected. Packaged smoke uses
an explicit disposable profile and Linux data root; it never confirms maintenance
against the owner's distribution. Private `install-wsl-reclamation.ps1` installs
the exact paired archive/runtime via supported stop/setup/open. It does not
compact the disk. `open-wsl-reclamation.ps1` opens that exact installed candidate;
the older global Sentry shim still points at its separate development build.

Actual Windows UAC consent/cancellation plus trim and compaction of the owner's
populated Ubuntu disk remain UNVERIFIED. These require
an explicit user action through the new confirmation and Windows approval; empty
fixture API success does not establish reclaimed bytes on the owner's disk.

No GitHub PR/push or paid QA. Installed64bff9f is unchanged. Local branch
codex/wsl-space-reclamation. Architecture: docs/architecture/wsl-space-reclamation.md.
Private receipts: C:/Users/merte/.codex/artifacts/sentry-wsl-reclamation-20261014.
shux contract is unavailable; task status/ledger/handoff maintained directly.
