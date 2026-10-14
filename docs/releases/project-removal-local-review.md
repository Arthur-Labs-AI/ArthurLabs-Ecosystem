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
- Frozen local packaging, isolated WSL suites/bootstrap and real packaged UI
  removal are pending in this source-commit record. The smoke extension checks
  native confirmation/cancel, real files, removal after manual folder deletion,
  original preservation and a fresh SQLite connection after shutdown. Only
  guarded disposable `/var/tmp/sentry-project-removal.*` data may be deleted.

Architecture decisions: `docs/architecture/project-removal.md`.
Private evidence: `C:/Users/merte/.codex/artifacts/sentry-project-removal-20261014`.
The owner's projects, database and credentials are not used as deletion fixtures.
`shux contract` is unavailable; task status, ledger and handoff are updated directly.
