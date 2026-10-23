# M05 Production Activation Readiness

Status: DORMANT NATIVE ADAPTERS IMPLEMENTED (MA-01/MA-02 and Task 14A). Production automatic-expiry policy remains OWNER APPROVAL PENDING; scheduler wiring NOT IMPLEMENTED. Activation NOT performed. Production remains schema v9.

## 1. Readiness checklist

| Requirement | Status | Evidence |
|---|---|---|
| Every authoritative write entrypoint accounted for | COMPLETE | `m05-authoritative-writers.md` matrix; 12/12 entity kinds journaled |
| No uninstrumented writer reachable under future v10 | COMPLETE (private adapters) / PUBLIC V9 UNCHANGED | Private `Writers` adapters include the explicit dormant `execute_due_expiry` candidate; production expiry scheduling still requires a separate owner decision; existing public v9 methods still follow v10-dormant v9 behavior and do NOT call JournalKernel yet. No public JournalTx is published. Raw SQL entry is `#[cfg(test)]` only. |
| Dormant due/expiry selection and writer | IMPLEMENTED AND TESTED (synthetic v10) | `due_pending_claims_in`, `due_pending_claim_in`, `Writers::execute_due_expiry`; expiry_tests::x01-x18, one owning transaction and rollback proofs |
| Actual production automatic-expiry policy | OWNER APPROVAL PENDING | `due_at` remains reporting-only; a past date is not permission to resolve a claim |
| Production scheduler wiring | NOT IMPLEMENTED | No runtime/startup/timer invokes `DormantExpiryRequest` or `execute_due_expiry` (x18) |
| Production v10 activation | NOT PERFORMED | `SCHEMA_VERSION=9`, STEPS 1-9; x17 |
| Exactly one runtime/storage owner | COMPLETE | `CaptureStore.connection` mutex; kernel borrows, never opens a second connection |
| JournalKernel activates before any v10 owner publication | PENDING OWNER APPROVAL | Activation call site is a future coordination task (see plan below) |
| Every new owner receives a fresh incarnation | COMPLETE | `stream::initialize` seals prior + mints UUID on every activation; s08 proves rotation |
| v9 historical data byte/row preserving after upgrade | COMPLETE | `migrated fixture` + `synthetic_disk_upgrade` tests; upgrade path only ADDS tables/triggers |
| Old v9 binary refuses a v10 database | COMPLETE | `PRAGMA user_version` gate; old code expects 9, v10 file reports 10 |
| Full-profile operations work on synthetic v10 | COMPLETE | journal + 24 v10 + 24 evolution tests green on synthetic v10 (see final report for exact totals) |
| Historical snapshot has complete causal closure | COMPLETE | s01 captures all 12 projections + @origin/@facet/@bundle with envelope-bound rows; s02 packs rebuild-verified manifests; s10-s16 cover tamper rejection; snapshot format v2 (envelope binding) |
| Transient rows cleaned after successful tx | COMPLETE | `stream::empty` + context/effects cleanup asserted in every `cores` audit |
| No signer/pairing/network needed for local saves | COMPLETE | journal/storage/snapshot import only `std`, `serde_*`, `rusqlite`, `uuid`, `time` |
| Aggregate G4 quota/reserve policy | OWNER APPROVAL REQUIRED / NOT ACTIVATED | [Task 14B decision package](m05-g4-quota-reserve-decision.md): source audit, synthetic measurements and individual G4-01–G4-09 proposals. `Limits.reserve` is logical metadata accounting, not filesystem capacity admission; physical enforcement and platform durability remain open. |
| G4-F01 maintenance logical-quota bypass | FIXED AND TESTED (DORMANT) | Task 14C: no-effects finalization calls the existing `quota()` before COMMIT. Q01–Q10 and F01–F10 exercise real kernel/snapshot paths on synthetic v10; see the dated decision-package addendum. |
| MEGA B physical admission infrastructure | DORMANT CANDIDATE / VERIFIED GROWTH BOUNDS BLOCKED | Separate checked calculator, scoped claims, owned-volume providers and kernel/snapshot integration. Profile A runs in synthetic tests only; non-test admission rejects `UnverifiedBounds`. Windows API smoke executed; Android/Linux device evidence absent. |
| MEGA B2 writer admission and recovery | PARTIAL / DORMANT | Exact top-level adapter plans; one budget for internal review/expiry/evolution composition; pager ceiling held through COMMIT and restored afterwards. Test-only per-main-file VFS FULL/IOERR callbacks and actual COMMIT BUSY, exact disk-state/reopen and event-identity reconciliation. Release VFS growth gate unchanged. |
| Platform crash/background gates | PLATFORM EVIDENCE REQUIRED | Synthetic fault injection only (Fault::At/Rollback/Exhausted/DeferredCommit); no OS kill evidence claimed |

## 2. Proposed coordinated activation patch (NOT APPLIED)

Order of operations:

1. Land a single migration step 10 that (a) creates the dormant `sync_*` tables, observers and guards from the exact accepted `m05_v10.sql`, and (b) flips `SCHEMA_VERSION` 9 -> 10 in the same `migrate_with` call. No other migration edits.
2. In the single application owner startup path (one place, behind the existing single-owner guard), construct `JournalKernel::activate` immediately after a successful v10 open and before any writer runs. Activation failure must abort startup, never fall back to unjournaled writes.
3. Publish exactly one reviewed `JournalTx` execution entry for the already-integrated authoritative writers (no new writers in the activation patch).
4. Keep all existing v9 read paths byte-identical; add no Tauri commands in the activation patch.
5. Failure boundaries: activation error -> process does not serve writes; mid-upgrade crash -> v9 file untouched until the v10 commit lands (migration atomicity via the existing `migrate_with` transaction); post-activation rollback is a restore-from-backup operation, never a downgrade write.
6. Verification before merge: full native suite (5 known historical failures only), architecture suite (2 known failures only), typecheck, arthur:check, plus a fresh-store and a populated-v9-upgrade end-to-end journal smoke test.

## 3. Explicitly out of scope for activation

- Security / enrollment workstream (separate package).
- LAN transport and incoming sync importer (separate packages).
- Production signing, pairing, authenticated replication.
- Snapshot transmission (local preparation only in this package).
- Platform-specific crash durability beyond synthetic fault injection.
- Live automatic-expiry policy and scheduler wiring: dormant executor tested, owner approval pending; no timer or runtime invocation.
- G4 physical-disk quota approval.

## 4. Post-implementation corrections (MA-01 / MA-02)

- MA-01: the private `Writers::evolve_capture` adapter now receives the caller-owned `EvolutionLimits` and a commit-time `allowed` callback and forwards both unchanged to the existing `evolution::apply`. No default limits or permanently-true permission remain in the journal path. Revoked permission yields the original legitimate fallback (uncertain claim / unchecked object, or pending claim instead of a stored proposal), never an automatic revision or proposal.
- MA-02: the snapshot manifest binds the complete staged-row envelope `SHA256(domain || JCS([ordinal, kind, key, contentHash]))` under domain `M05-SNAP-ROW-v1` (`snapshotVersion: 2`; no v1 snapshot was ever packed in production). `verify_rows` enforces content hashes, contiguous ordinals, canonical keys with exact arity and no duplicates. `reconstruct_bundle` reassembles every covered core from its staged fragments, verifies fragment coverage/order/hex, re-checks `journal_event_hash` and header/core identity, and only then contributes byte counts to the manifest. The SQL guards and immutable staged rows are unchanged.
- Neither correction changes the wire format, the codec, the reducer, the schema, or any domain business logic. Production remains v9 and dormant; JournalKernel remains unpublished to production callers.

## 5. Standing boundaries (unchanged)

- Existing public v9 methods follow v9 behavior; only the private adapters are journal-aware.
- Dormant expiry execution adapter: IMPLEMENTED AND TESTED under synthetic v10; production automatic-expiry policy remains OWNER APPROVAL PENDING and production scheduler wiring is NOT IMPLEMENTED.
- G4 physical-disk quota/reserve: still requires owner approval.
- Platform crash/background gates: still require platform evidence beyond synthetic fault injection.
- Snapshot retention/retirement policy: initial single-snapshot admission only; no retirement redesign in this package.
- Security/importer/transport/UI/release: separate workstreams, not started.

## 6. Task 14A execution evidence and remaining decisions

The explicit private `DormantExpiryRequest` is an execution candidate, not a
production permission. `Writers::execute_due_expiry` selects and revalidates due
claims inside its owning `JournalKernel::write()` transaction. It reuses the
existing expiry-aware resolver and real v9 proposal-supersession trigger;
claim proofs use Expiry, proposal proofs use DerivedClaimResolution. No draft
is approved, rejected or deleted by expiry. The engineering batch ceiling of
32 is not the final production scheduling policy. A successful batch creates
one canonical event; empty/repeated passes create none. Any domain or finalizer
failure rolls back all selected changes and consumes no committed sequence.

X01-X18 exercise public query parity, parsed offset/equality boundaries, current
project membership, stale previews, legitimate terminal drafts, malformed
persisted metadata, deterministic limits, exact stored core/dependencies/facet
heads, and rollback at six journal stages. Synthetic fault injection proves
transaction atomicity only; platform process-death/power-loss durability is
still unverified. The production source scan confirms no runtime scheduler
callsite; it is not a substitute for future coordinated activation review.

Remaining owner/platform gates are unchanged: actual automatic-expiry policy
and scheduler wiring; G4 physical-disk quota/reserve approval; platform
crash/durability proof; snapshot retention/retirement policy; coordinated
activation approval; future importer/security/LAN/UI work. Production v10
activation has NOT been performed. No readiness claim here closes these gates.

## 7. Task 14C scope and evidence boundary (2026-10-23)

G4-F01 maintenance logical-quota bypass: **FIXED AND TESTED (DORMANT)**.
The no-effects branch preserves context cleanup and `stream::empty()`, then
checks the same persisted logical quota before returning to the owning COMMIT.
Effect-bearing finalization, quota arithmetic, snapshot v2, SQL guards and
candidate limits are unchanged. Snapshot-only work emits no domain event.

The new test-only storage-fault suite uses actual adapters, full typed SQL-row
comparisons, integrity/FK checks and close/reopen of disposable synthetic v10
files. Pager `max_page_count` produces observed SQLITE_FULL code13; TEMP trigger
aborts and pre-COMMIT/rollback-result injections are separately classified.
These are controlled failures, not physical filesystem durability acceptance.
Already-over-cap maintenance is admitted only if its final state satisfies
the existing quota; a reduction still above the cap rolls back without a bypass.

**G4 PHYSICAL POLICY: OWNER APPROVAL PENDING. Physical free-space admission:
NOT IMPLEMENTED. Real filesystem-full and VFS IOERR tests: NOT EXECUTED.
Production v10 activation: NOT PERFORMED.** Profile A, G4-01–G4-09,
Windows/Android/Linux durability acceptance, snapshot retention/retirement,
live expiry policy/scheduler, coordinated activation and future
importer/security/LAN/UI remain independent open gates.

## 8. MEGA B candidate infrastructure (2026-10-23)

Separate physical policy/demand/capacity types now cover activation, one typed
Capture or snapshot step, finalization and pre-COMMIT checks. Unknown/composed
domain demand and unsupported SQLite modes fail closed. Synthetic Profile A
tests enforce a temporary main-page growth ceiling and inspect journal growth;
logical quotas remain independent. Scoped outstanding claims exclude observed
allocated growth. Numeric FULL/IOERR classification and an explicitly logical
post-COMMIT acknowledgement-loss test preserve recovery-required behavior.

This milestone is **PARTIAL**: candidate DELETE/scratch envelopes are not verified
VFS bounds. The non-test constructor rejects `UnverifiedBounds`; no approval or
production bypass is provided. Completing that boundary needs an independently
reviewed per-connection VFS/growth contract. Windows capacity smoke passes;
Android provider source uses existing libc but has not been target-compiled or
device-tested; Linux provider explicitly fails closed pending target/dependency
support. Real filesystem FULL/IOERR and device durability remain unexecuted.
Production remains v9; startup/public writer routing, expiry scheduler and v10
activation are unchanged. Profile A remains an owner-approval candidate.

## 9. MEGA B2 closure candidate (2026-10-23)

All private authoritative adapter families now declare exact operations; a
mismatched, repeated, unknown or unregistered top-level operation fails closed.
Nested domain helpers share the named operation's candidate envelope and the
single owner/finalizer. This does not establish a universal growth bound.
The real pager ceiling stays installed through COMMIT, is read back, and is
restored after COMMIT/rollback. Tests cover freelist reuse, repeated claims,
SQLITE_PAGER_FULL, SQLITE_TRIGGER_ABORT, REAL_COMMIT_FAILURE (BUSY), and
SQLITE_VFS_FULL / SQLITE_VFS_IOERR (one-shot main xWrite/xSync test shim).
Uncertain COMMIT reports the event UUID; read-only reconciliation validates
retained history/heads before looking up that identity. Not recorded is not
permission to blindly retry. No successful-save acknowledgement precedes COMMIT.

**PARTIAL:** DELETE journal, subjournal/temp and allocation growth still require
a reviewed, enforced per-file VFS contract; non-test admission continues to
reject `UnverifiedBounds` for every operation/platform. Pager bounds and the
[SQLite temporary-file model](https://sqlite.org/tempfiles.html) do not prove
those bounds. The test shim uses documented [file-control pointers](https://sqlite.org/c3ref/c_fcntl_begin_atomic_write.html)
and restores native methods before recovery; it does not simulate OS exhaustion
or certify device durability. REAL_FILESYSTEM_FULL and process/power-loss tests
remain NOT TESTED. Windows native identity/missing/replaced-path tests execute;
Android Rust target and NDK are unavailable here (the SDK is installed), so
Android and Linux targets remain NOT TESTED (Linux provider fails closed).
Profile A remains **CANDIDATE — OWNER APPROVAL PENDING**; production remains v9.
