# Local review: remove projects and stored materials

Owner confirmed the previous DeepSeek repair with completed run
`run_01M4XMT2YFVRZCSJ5NP0Q572C7` (six findings). Those findings were not
independently revalidated. This feature continues locally on `codex/project-removal`
from `be3431f`, retaining both the DeepSeek evidence fix and visible Windows launch.
No push or GitHub PR is requested or created.

Projects cards and the project detail page now offer **Remove project**.
Confirmation names the project and explains permanent deletion of Sentry's stored
copy, revisions, run workspaces, findings, evidence and history. The original
source folder is preserved. Cancel is focused by default; Escape cancels before
removal. Pending removal cannot be submitted twice or dismissed. Active run and
project-operation states disable removal, and the backend lock remains final
authority when a view is stale.

The renderer uses a narrow typed preload method over the existing validated
deletion RPC. Existing ProjectManager journaling and atomic SQLite foreign-key
cascades remain canonical; there is no migration, protocol or provider change.
After commit, mounted consumers reread canonical state, including Projects and
Dashboard. Failure preserves the project and displays an error. A removed source
folder alone never silently destroys imported QA history.

Manual deletion previously left a database entry that could not be removed:
renaming the missing managed root raised ENOENT. Only that missing-root condition
is now treated as already removed; normal database deletion continues. Other I/O
failures and active locks remain failures. Crash-recovery behavior is retained.

## Verification before packaging

- Regression RED: two missing-root cases failed with ENOENT; all seven UI cases
  failed because removal was absent. Test harness ambiguity between two zero
  Dashboard metrics was corrected without changing the expected project count.
- GREEN: ProjectManager 17/17, including complete/missing-root cleanup, preserving
  source and another project, active locks, failure rollback and crash recovery.
- New UI/preload checks 8/8: confirm/cancel, committed-state timing, mounted
  Projects/Dashboard synchronization, failure retention, busy states, detail
  navigation and IPC errors.
- Full Windows Desktop suite: 408 pass, two existing platform skips; 53 files.
- Desktop/ProjectManager lint/typecheck and dependencies: 20 uncached tasks pass.
- React review: reusable local confirmation state, canonical React Query reads,
  native dialog semantics, labelled controls, no arbitrary filesystem bridge.
- Full WSL suite: 1,260 passed, 16 existing skips, 40 uncached tasks; includes
  real sandbox trust 8/8, runtime 73/73 and ProjectManager 17/17.
- Windows archive: 20 forced builds pass, 332-file inventory and full extraction
  verified. Windows distribution checks: 32 pass, 27 platform skips.
- The bootstrap's global maintenance preflight correctly refused activation
  while the owner's existing runtime remained open. No guard was bypassed and
  no owner process was stopped. The supported `stage-only` deployment compiled
  the exact verified archive's runtime source under disposable HOME (18 uncached
  build tasks); its release identity handshake passed. Owner installation and
  activation of this new candidate remain unverified until the installer runs.
- Real packaged UI PASS: Add by path, native confirmation with Cancel focused,
  Escape cancellation retaining the project, permanent removal from Projects,
  stored tree/tombstone absence, detail removal after manual managed-root deletion,
  original source preservation and fresh Linux/SQLite reopen with no projects or
  pending deletion operations. Single instance and graceful shutdown also pass.
- Screenshot `project-removal-confirmation.png` inspected in private evidence.
  First smoke attempts exposed harness mistakes: direct bridge import left the
  UI's one-second cached list fresh; nested selector quoting prevented the UI
  path input step. The corrected harness uses actual Add by path, native CDP
  input and JSON-quoted selectors in a fresh store. Earlier logs are retained;
  application/runtime source did not change after candidate packaging.

## Exact local candidate and use

Tested application source: `64bff9fdcb5aed2335c4cf1efbe0815a2edcde48`.
Subsequent QA/receipt commits retain the same application/runtime content.
Archive: `sentry-1.0.0-rc.1-64bff9fdcb5a-windows-x64.zip`.
SHA256: `3be517c2862e610a7e341737b059fa35aee0350e0f02f59a262dae66a12f96a9`.
Version and runtime protocol remain rc.1 / 1. Local candidate; no publication.

Private `install-project-removal.ps1` verifies the ZIP checksum, extracts a new
LocalAppData directory, validates its manifest, uses supported graceful stop and
setup, checks the activated matching runtime identity, then opens Desktop normally.
Syntax and `-VerifyOnly` passed. It does not delete any existing project or start
QA. `open-project-removal.ps1` starts this exact installed candidate in future;
the owner's global development shim and older archive launchers remain separate.

The full paid DeepSeek run supplied by the owner verifies the preceding evidence
fix. No additional paid calls were made for this feature. Populated owner-profile
upgrades and credential persistence were not retested against this candidate.

Architecture decisions: `docs/architecture/project-removal.md`.
Private evidence: `C:/Users/merte/.codex/artifacts/sentry-project-removal-20261014`.
The owner's projects, database and credentials are not used as deletion fixtures.
`shux contract` is unavailable; task status, ledger and handoff are updated directly.
