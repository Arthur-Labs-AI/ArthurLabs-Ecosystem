# Windows WSL maintenance privilege boundary

Phase 6.5 correction, October 15, 2026. Applies only to optional Windows WSL
disk reclamation. Normal installation, runtime execution and project management
are unchanged. The feature still needs user confirmation and administrator consent.

## Executable code

Electron owns the fixed `WSL_SPACE_HELPER` implementation. Both the initial
PowerShell process and the administrator-approved child receive that implementation
as a compressed, UTF-16 encoded command. Neither process executes a script from
the profile or operation directory. The compressed payload is captured in memory
before elevation; no later file-content check is used as a substitute for integrity.
Only opaque base64 path/distro arguments, an operation ID and an ephemeral receipt
key cross this boundary. Command length is bounded below the Windows argv limit.
Both bootstraps disable automatic module discovery and import the Management and
Utility modules by absolute manifest paths under the installed PowerShell home.
Native interop is compiled from the fixed source using private operation-directory
compiler temporary files, with native DLL resolution restricted to System32.
Custom module search paths and general temporary folders do not supply executable
dependencies to the elevated operation.

This protects against helper-file substitution in an otherwise trusted running
application. It does not certify a replaced application installation, malicious
administrator/SYSTEM, debugger/process injection or complete compromise of the
owner's account. Encoding is transport, not publisher authentication; the fixed
trusted application constant is the executable source of truth.

## Private operation state

Maintenance diagnostics now live under the Windows home directory at
`.sentry-wsl-maintenance/reclaim-<random operation ID>/`. They are independent of
custom Electron profiles and the general Temp/AppData directory. Historical
profile-maintenance diagnostics remain untouched and are not consumed as new
operation state.

The helper validates local canonical paths, rejects reparse/junction ancestors,
requires trusted ownership and rejects ancestor permissions that let other
principals replace directories or change their security. New operation directories
have an explicit protected DACL: current user SID, SYSTEM and Administrators only.
Arbitrary custom-profile permissions are never inherited into operation state.
Existing operation IDs are refused. Ownership, ancestry and private DACL checks
repeat at the elevated boundary and when publishing/reading a receipt.

Managed or unusual home-directory ACLs/ownership may cause a fail-closed refusal.
Sentry does not change an existing home/profile ACL to make maintenance work.
The controller resumes a connected runtime or attempts reconnection after accepted
shutdown; unrelated normal app operations remain available.

## Result protocol

There is no caller-supplied `ResultFile` destination. The fixed names `result.tmp`
and `result.json` are derived inside the validated operation directory. Both must
be absent before mutation. A receipt is written with CreateNew, flushed, then
renamed within that directory without replacing an existing destination. A
pre-existing file or reparse path is never silently overwritten, including on
the error path.

The exact envelope contains `version`, `operationId`, `sid`, `distro`, `disk`,
`outcome`, `message` and `mac`. A per-operation 32-byte memory-only key authenticates
the version, operation identity, SID, distro, canonical registered disk path,
explicit completed/failed outcome and message with HMAC-SHA256. The message is
base64 encoded in the canonical newline-delimited signing input. The signing key
is not written to retained receipts. PowerShell validates exact keys/types and
identity plus MAC; Node independently validates the strict envelope, request
correlation, MAC with timing-safe comparison and completed/empty-message outcome.
Measurements or a truthy legacy `ok` cannot substitute for completion proof.

HMAC is operation correlation/integrity within the stated principal boundary,
not protection against a principal that controls the entire parent process/key.
Before/after byte measurements remain parent-side OS observations; space recovery
is neither guaranteed nor inferred from a receipt alone.

## Existing safety controls retained

- The runtime remains authoritative for busy/lease refusal and must positively
  acknowledge shutdown before host maintenance.
- Same Windows SID and exact WSL2 registration/canonical disk path are revalidated
  after UAC. Reparse disk paths and unsupported registrations remain refused.
- Other distributions are checked before trim and again after administrator approval.
- Whole-VM shutdown follows consent; disk release has a bounded wait, no forced
  detachment and no WSL repoll that restarts the VM before compaction.
- UAC cancellation, uncertain shutdown, file/OS errors and failed authentication
  propagate; the existing controller attempts safe reconnect and releases its gate.

## Ownership and architecture review

| Question             | Answer                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Source of truth      | Fixed Electron code, Windows registry disk identity and runtime lifecycle authority; Node owns request ID/key                  |
| Writers              | Only the operation's user/SYSTEM/admin directory principals; elevated helper publishes completion, parent consumes             |
| Dependency direction | Controller → Windows reclaimer → command/receipt utility → fixed helper/OS; no cycles or new service                           |
| Contract             | Opaque input arguments and strict authenticated receipt; no renderer code/path destination or live object                      |
| Failure              | Refuse unsafe identity/ACL/reparse/collision/schema/MAC; propagate error, retain existing reconnect semantics                  |
| Lifecycle            | Fresh private directory, memory-bound code/key, exclusive temporary receipt and no-replace atomic rename; diagnostic retention |
| Test seams           | Real Windows PowerShell/ACL/cryptography with disposable files and mocked registration/elevation/native mutations              |
| Compatibility        | Internal helper/receipt update ships together; no database migration/version/protocol/pin change; old diagnostics retained     |
| Observability        | Explicit refusal/authentication errors, actual exit status, measured bytes and reconnect outcome                               |
| Security scope       | Closes mutable-file and result-destination boundary; does not claim protection against complete trusted-principal compromise   |

Executed regression evidence and remaining release steps are recorded in the
[Phase 6.5 handoff](https://github.com/Mert1026/Sentry/blob/v1.0.0/docs/releases/v1-phase-6-5-wsl-helper-hardening.md).
