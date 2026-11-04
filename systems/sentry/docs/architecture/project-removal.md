# Project removal: ownership and implementation plan

Scope: expose existing deletion through Desktop, free managed storage, and allow
explicit removal of database records after their files were manually deleted.
No automatic deletion based on source-folder absence, no owner project removal
during development, no GitHub PR or push. Retain the verified DeepSeek and visible
Windows launcher repairs from baseline `be3431f` on local `codex/project-removal`.

1. Source of truth: SQLite owns project identity/history; files own stored
   materials. A missing original source folder does not erase imported history.
2. Ownership: existing ProjectManager alone mutates lifecycle/files and the
   repository transaction; React requests deletion and rereads canonical queries.
3. Dependencies: renderer → narrow preload IPC → existing service/runtime RPC →
   ProjectManager → persistence/filesystem. No new service or dependency cycle.
4. Boundaries: expose `projects.remove(projectId)` over existing validated
   `projects:delete` / `projects.delete`. No renderer-supplied filesystem paths.
5. Failures: preserve active-project lock and rollback semantics. Only a missing
   managed root is already removed; permission/I/O errors still fail and retain
   the project. Errors remain visible; UI never optimistically removes cards.
6. Lifecycle: ready → deleting → filesystem tombstone → database cascade →
   cleanup, retaining existing crash-recovery journal. Removal requires explicit
   confirmation naming the project and permanent loss of stored history.
7. Test seams: temporary source/store directories, existing deletion fault
   injector, mocked narrow preload calls, mounted React queries with deferred
   mutation promises, and actual packaged UI with disposable runtime/profile.
8. Compatibility: reuse existing foreign-key cascades and deletion operations;
   no migration/version/protocol/provider changes. Old archives remain immutable.
   Database cascade is atomic; filesystem journal supports recovery after crashes.
9. Observability: pending removal, actionable error, committed removal from list
   and Dashboard without restart; real files/history absence checked in fixtures.
10. Security: only Sentry-managed copies, revisions, run workspaces and histories
    are deleted. Original source folders are preserved. Backend lock is final
    authority even if UI state is stale. Never delete owner projects in tests.

Implementation files: typed Desktop contract/preload; reusable confirmation
component on Projects cards and ProjectDetail; existing ProjectManager deletion
handling for missing roots. Tests cover confirm/cancel, pending/failure, active
locks, cross-screen invalidation, filesystem cleanup, missing-root cleanup and
existing crash recovery. Build a paired local Windows/runtime candidate for review.

The supplied DeepSeek log ends with status completed and six findings. This is
owner-provided live acceptance of the previous fix, not independent validation of
the reported findings; all document contents remain untrusted task data.
