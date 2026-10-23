# M05 Production Activation Readiness

Status: NATIVE IMPLEMENTATION COMPLETE (MA-01/MA-02 corrected). Activation NOT performed. Production remains schema v9.

## 1. Readiness checklist

| Requirement | Status | Evidence |
|---|---|---|
| Every authoritative write entrypoint accounted for | COMPLETE | `m05-authoritative-writers.md` matrix; 12/12 entity kinds journaled |
| No uninstrumented writer reachable under future v10 | COMPLETE (private adapters) / PUBLIC V9 UNCHANGED | Private `Writers` adapters cover every authoritative writer for the future coordinated activation; existing public v9 methods still follow v10-dormant v9 behavior and do NOT call JournalKernel yet. No public JournalTx is published. Raw SQL entry is `#[cfg(test)]` only. |
| Exactly one runtime/storage owner | COMPLETE | `CaptureStore.connection` mutex; kernel borrows, never opens a second connection |
| JournalKernel activates before any v10 owner publication | PENDING OWNER APPROVAL | Activation call site is a future coordination task (see plan below) |
| Every new owner receives a fresh incarnation | COMPLETE | `stream::initialize` seals prior + mints UUID on every activation; s08 proves rotation |
| v9 historical data byte/row preserving after upgrade | COMPLETE | `migrated fixture` + `synthetic_disk_upgrade` tests; upgrade path only ADDS tables/triggers |
| Old v9 binary refuses a v10 database | COMPLETE | `PRAGMA user_version` gate; old code expects 9, v10 file reports 10 |
| Full-profile operations work on synthetic v10 | COMPLETE | journal + 24 v10 + 24 evolution tests green on synthetic v10 (see final report for exact totals) |
| Historical snapshot has complete causal closure | COMPLETE | s01 captures all 12 projections + @origin/@facet/@bundle with envelope-bound rows; s02 packs rebuild-verified manifests; s10-s16 cover tamper rejection; snapshot format v2 (envelope binding) |
| Transient rows cleaned after successful tx | COMPLETE | `stream::empty` + context/effects cleanup asserted in every `cores` audit |
| No signer/pairing/network needed for local saves | COMPLETE | journal/storage/snapshot import only `std`, `serde_*`, `rusqlite`, `uuid`, `time` |
| Aggregate G4 quota/reserve policy | OWNER APPROVAL REQUIRED | `Limits{core,payload,metadata,reserve}` enforced; G4 physical-disk admission explicitly NOT approved (kernel `PolicyPending` without reserve) |
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
- Proposal expiry scheduler adapter (BLOCKED item in the writer matrix).
- G4 physical-disk quota approval.

## 4. Post-implementation corrections (MA-01 / MA-02)

- MA-01: the private `Writers::evolve_capture` adapter now receives the caller-owned `EvolutionLimits` and a commit-time `allowed` callback and forwards both unchanged to the existing `evolution::apply`. No default limits or permanently-true permission remain in the journal path. Revoked permission yields the original legitimate fallback (uncertain claim / unchecked object, or pending claim instead of a stored proposal), never an automatic revision or proposal.
- MA-02: the snapshot manifest binds the complete staged-row envelope `SHA256(domain || JCS([ordinal, kind, key, contentHash]))` under domain `M05-SNAP-ROW-v1` (`snapshotVersion: 2`; no v1 snapshot was ever packed in production). `verify_rows` enforces content hashes, contiguous ordinals, canonical keys with exact arity and no duplicates. `reconstruct_bundle` reassembles every covered core from its staged fragments, verifies fragment coverage/order/hex, re-checks `journal_event_hash` and header/core identity, and only then contributes byte counts to the manifest. The SQL guards and immutable staged rows are unchanged.
- Neither correction changes the wire format, the codec, the reducer, the schema, or any domain business logic. Production remains v9 and dormant; JournalKernel remains unpublished to production callers.

## 5. Standing boundaries (unchanged)

- Existing public v9 methods follow v9 behavior; only the private adapters are journal-aware.
- Proposal-expiry scheduler: still BLOCKED, still requires a scheduler-owned adapter reusing review proofs.
- G4 physical-disk quota/reserve: still requires owner approval.
- Platform crash/background gates: still require platform evidence beyond synthetic fault injection.
- Snapshot retention/retirement policy: initial single-snapshot admission only; no retirement redesign in this package.
- Security/importer/transport/UI/release: separate workstreams, not started.