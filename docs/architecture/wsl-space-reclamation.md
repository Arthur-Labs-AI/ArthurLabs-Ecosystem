# Windows disk-space reclamation

Owner request: a button to return freed WSL storage to Windows. Reclaim unused
physical blocks, without shrinking ext4's maximum capacity or deleting live
files. There is no promised 1 GiB reserve: dynamic storage grows when required.
Scope is a local Windows Desktop change; no GitHub PR or paid QA.

## Architecture review

1. **Truth:** WSL's per-user Lxss registration identifies the selected distro
   and disk. Windows file and volume measurements provide before/after bytes;
   Linux's virtual free capacity is not host free space.
2. **Ownership:** Electron main owns maintenance and runtime lifecycle. A
   bundled, fixed PowerShell helper resolves the registered disk, trims Linux
   free blocks, terminates only that distro, and requests UAC for compaction.
   Renderer supplies confirmation only, never disk paths or command text.
3. **Direction:** renderer -> typed IPC -> host maintenance controller -> OS
   helper. Runtime/domain/storage packages do not depend on Windows maintenance.
4. **Contract:** parameterless `runtime:reclaim-space` returns measured disk
   bytes and volume free bytes, with a reconnect outcome. Renderer-only; CLI
   allowlist excludes it. Runtime status remains readable during maintenance.
5. **Failure:** authoritative runtime shutdown refuses active runs/retests or
   pending mutations. Refusal never invokes trim/termination/compaction. UAC
   cancellation, trim failure, disk-in-use and native API errors are explicit;
   reconnect is attempted after a stopped runtime even if maintenance fails.
   Native compaction is awaited, not killed on an arbitrary timeout.
6. **Lifecycle:** acquire main-process gate synchronously, pause live polling,
   inspect selected registration, gracefully stop owned runtime, invoke helper,
   reconnect with existing identity/configuration checks, release gate. Other
   IPC/CLI operations and application quit are blocked during maintenance.
7. **Tests:** injected inspect/reclaim/runtime/polling seams test ordering,
   concurrent requests, active-work refusal, error recovery and reconnect errors.
   UI tests confirmation/cancellation/disabled state/results and refreshed data.
   Native helper gets real PowerShell parsing/C# compilation checks and mocked
   OS boundary tests. Actual compaction needs a disposable VHD and administrator
   approval; never use the owner's Ubuntu disk as an automated test fixture.
8. **Compatibility:** no database migration, credentials move or protocol
   change. Existing archive/runtime identities remain paired. No experimental
   sparse mode, filesystem resize, zero-fill, unregister or global WSL shutdown.
9. **Observability:** UI explains whole-distro interruption, shows pending state,
   exact measured reclaimed disk bytes and volume free space, and distinguishes
   successful compaction from reconnect failure. Helper receipts remain in the
   Desktop profile's maintenance directory. Zero recovered bytes is valid.
10. **Security:** UAC runs a fixed helper under the same Windows SID. Elevated
    helper re-resolves the registration and requires the expected exact disk.
    Reject ambiguous/non-WSL2 registrations, network/reparse disk paths and
    unexpected file names. Native API errors are numeric, independent of locale;
    no shell interpolation or renderer-provided OS targets.

## Implementation and verification plan

- Desktop main: Windows helper, lifecycle controller, IPC hook and quit gate.
- Shared/preload: narrow typed parameterless bridge.
- Runtime settings: confirmation, operation state and measured result.
- Project removal copy: explain freed Linux space and link to Runtime maintenance.
- Tests: baseline, regression/controller/PowerShell/UI, Desktop suite, static
  checks and build. Native elevated disposable-disk acceptance is reported
  separately if unavailable; source checks do not prove reclaimed bytes.

Microsoft contracts:

- https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-compactvirtualdisk
- https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-openvirtualdisk
- https://learn.microsoft.com/en-us/windows/wsl/basic-commands
