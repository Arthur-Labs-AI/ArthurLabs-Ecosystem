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
| MEGA D/D2 native Sync Core | PARTIAL / DORMANT G3 CREATE-ONLY CANDIDATE | Native engine and owner-borrowed ledger; original Project/Capture materialization, bounded pagination/reprocessing, distinct stored/integrated/applied cursors and retained conflicts. Complex historical reconstruction remains unsupported/conflicted; release trust/admission constructors fail closed. See section 11. |
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
- Production LAN/trust and complete historical import profile (separate packages).
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
- Production security/transport/UI/release remain gated; dormant import candidates are scoped in sections 10–12.

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

## 10. MEGA D native Sync Core candidate (2026-10-23)

The native `sync/` engine uses typed transport/store/verifier/clock boundaries.
Two independent owned SQLite fixtures exchange exact original journal bytes,
including a >1 MiB event in 256 KiB chunks; incomplete chunks never publish.
A separate test-installed `import_candidate.sql` extension retains originals,
creation claims, pending dependencies, conflict alternatives, collisions and
per-peer progress. Candidate limits: 256 events, 64 MiB logical evidence,
16 collisions, bounded metadata and two assemblies of at most 4 MiB each.
Lost ACK/reconnect, revocation, forged ACK, rollback/COMMIT failure and reopen
are tested. Conflict-retained ACKs are negotiated separately; staged or
unsupported receipts never advance applied cursors. A native local-core echo
can confirm its already committed identity without creating a foreign bundle.

**PARTIAL:** frozen observers require a local bundle/fence for every domain
write. No foreign domain materialization or receiver snapshot bootstrap is
implemented; clean historical reconstruction needs the reviewed G3 forward
migration. Snapshot v2 source verification/tamper checks are reused unchanged.
`knowledge-v1-full` is not advertised. Release trust verification and store
construction reject; no signer, pairing, LAN, UI or scheduler is wired.
G4 `UnverifiedBounds` remains active. Production schema/registration stays v9;
the separate synthetic extension does not approve a production schema version.

## 11. MEGA D2 G3 create-only candidate (2026-10-23)

Foreign Project/Capture creations now materialize original IDs, Unicode,
timestamps and membership in the owning import transaction, together with
original cores, commit proofs, heads and contiguous applied progress.
The separate test-installed `import_g3.sql` policy admits at most 64 creations
per event. Its native exact-row capability exists only under the owner lock
and IMMEDIATE transaction: scoped INSERT observers retain their frozen local
bodies and are restored before COMMIT; v9 guards and other observers stay active.
Foreign creation references participate in local journal replay and refresh of
an already-active kernel; no local-origin echo or provider command is emitted.
Recall polling with an enabled deterministic embedding spy makes zero calls.

Reprocessing revalidates at most 16 originals per transaction with a durable
cursor and original membership epoch. Revocation/origin permission and lease
are checked under the same lock and before COMMIT. Summary pages hold 64
identities, transfer batches 2 events and reassembly 2 events; reconnect restarts
bounded discovery. The receiver still retains at most 256 events/64 MiB logical
evidence (including G3 heads); event 257 pauses with `StorageLimited`, no ACK.
Attention/status derive from committed outcomes instead of chunk arrival.
Old D1 cores without an admission epoch remain retained until a fresh
authenticated receipt reauthorizes the exact original; no epoch is backfilled.

**PARTIAL:** only clean create-only Project/Capture bundles are supported.
Historical archived children, complex object/revision/evidence/proposal/review
reconstruction and mutable transitions remain unsupported/conflicted; no
`knowledge-v1-full`, receiver snapshot bootstrap or automatic resolution.
Production ingress/signing/pairing and G4 `UnverifiedBounds` remain closed;
physical allocation/durability certification and coordinated activation remain
open. Frozen v10 artifact, codec/reducer, snapshot v2 and production v9 routing
are unchanged. No LAN, UI, scheduler or production schema version is enabled.

## 12. MEGA D3 immutable history and receiver bootstrap candidate (2026-10-23)

**PARTIAL:** the separate test-installed `import_history.sql` adds clean
RecordCreate-only reconstruction for distillation runs, initial objects and
source references, unselected revisions, parents and evidence, alongside
Project/Capture. Initial object/root cycles assemble atomically; revisions use
deterministic topological order. Original cores, immutable guards, code-point
spans, exact-row grants and frozen observers remain authoritative. The only
scoped UPDATE assembles the same-event initial object pointer from NULL to its
original root. A long-lived kernel can reference that foreign history in a
subsequent local object edit and validate it again after disk reopen.

The separate `m05-bootstrap-immutable-v1` profile binds the complete bounded
catalog, exact local AND foreign originals, creation/materialization evidence,
conflict alternatives, row/core counts and high-water hashes. Whole-manifest
hashes bind fixed chunk positions; each staged chunk is also hashed. Accepted
snapshot v2 is unchanged. The receiver retains independent knowledge, resumes
only the exact root and publishes a complete supported unit in one owner
transaction. Legacy-attested rows must already match; they cannot mint M05
creation authority. A conflicted/unsupported source publishes no partial
snapshot projection. Ordinary paginated journal exchange supplies the tail.

Candidate bounds: 4 MiB per manifest, 64 cores, 2,048 domain rows, 16 chunks,
4 retained incoming/outgoing units and 8 MiB staged/cached payload, also charged
to the existing 64 MiB logical quota. Capture/metadata/publication work has
bounded checks and five-second phase budgets; no physical G4 claim is made.
Tests exercise real publication rollback, deferred-FK COMMIT failure, observer
restoration denial, new-entity trigger fanout, lost/stale ACK, exact resume,
revocation during disclosure and an enabled Recall embedding spy (zero calls).
Imported objects stay excluded from background paid embedding, including
later local edits, pending a reviewed G7 opt-in/retirement policy.

Mutable facets, selected-head/lifecycle transitions, stale proposals and
historical review reconstruction remain blocked; relations, identity_decisions,
pending_claims and revision_proposals are not materialized. Concurrent terminal
reviews/heads retain alternatives; unresolved G5/G6 decisions are not inferred.
Production ClosedTrust/store construction, G3 approval, G4 UnverifiedBounds,
G7 retention, signing, OS keys, pairing and authenticated transport remain open.
No full-profile claim, LAN, UI, scheduler or production activation is enabled.

Windows verification: D3 17, Sync 56, Journal 260 and dormant v10 24 PASS.
Full native: 1,241 PASS / the exact five D2 baseline FAIL / 22 ignored;
architecture: 86 PASS / the same two baseline FAIL. Cargo all-targets check,
typecheck and frontend (561 tests plus build) PASS. TTS is unchanged and passes.
Android/Linux targets, real filesystem exhaustion and power-loss remain unverified.

## 13. MEGA D4 guarded history and disclosure (2026-10-23)

**PARTIAL / DORMANT:** test-installed `import_d4.sql` extends creation support to
relations, identity decisions, initial pending claims and open proposals. Original
IDs, immutable audit/draft fields, dependencies and creation proofs survive disk
reopen. Semantic duplicate relation UUIDs retain their original cores as explicit
conflicts; exact observed model removals cannot remove a user edge or later add.
Import-owned Project rename/empty archive/restore, Capture/Object membership and
selected-head chains require exact before-images, predecessor hashes and heads.
Local selections, archive children and divergent operations retain alternatives.

Bootstrap now checks empty/populated local origins, foreign originals, referenced
origins, cached manifests and private legacy attestations against explicit scope.
Unattributed private legacy rows cannot leave an empty scope. Typed audit parsing
blocks raw provider payload forwarding. The separate
`m05-bootstrap-history-d4-v1` profile binds mutable facet provenance and D4 proofs;
unsigned historical reviews remain `legacy_attested` and unsupported. Publication
logically merges independent databases and rolls back domain, ledger and progress
together. The 4 MiB/64-core/4-unit bounds remain; lifecycle states retain all
recovery/conflict evidence, and native retirement returns activation-pending.

G5 review transitions, stale proposal bases, G6 aliases, G7 reclamation and full
populated-v9 convergence remain unsupported. No `knowledge-v1-full` claim is made.
Production STEPS 1–9, schema v9, accepted v10 SQL, codec/reducer, snapshot v2 and
public writer routing are unchanged. ClosedTrust and G4 UnverifiedBounds remain
closed; Android/device and physical-filesystem certification remain unverified.

Windows verification on the final code: D4 **32 PASS**, Sync **85 PASS**, Journal
**263 PASS**, dormant v10 **24 PASS**; full native **1,273 PASS / 5 historical FAIL /
22 ignored**. The five failure identities exactly match the previously recorded
JEV transport, two synthesis architecture, frozen corpus and synthesis permission
cases in [the G4 verification record](m05-g4-quota-reserve-decision.md); the TTS
audio-focus test passes. Cargo locked/offline all-targets check and typecheck PASS;
architecture **86 PASS / the same 2 historical FAIL**; frontend **561 PASS + build**.
`git diff --check` passes. No production activation, push or PR is performed.

## 14. MEGA C physical admission candidate (2026-10-23)

**PARTIAL / DORMANT:** a dedicated non-default, test-only owned VFS now observes
main/DELETE-journal I/O and refuses unaccountable temp/subjournal/WAL opens. Its
outer admission token enforces separate requested-extent limits through real
COMMIT, with deterministic I/O faults, snapshot retries and process-termination
recovery. Windows NTFS capacity/allocation and root-identity checks were executed;
samples do not certify filesystem allocation peaks. See the compact
[MEGA C evidence and gate record](m05-g4-quota-reserve-decision.md#mega-c--scoped-physical-io-and-recovery-evidence-2026-10-23).
Release remains `UnverifiedBounds`; G4-01–G4-09/Profile A are not approved.
Android/Linux/device, actual filesystem-full and hardware power-loss acceptance
remain NOT TESTED. Production schema9/STEPS1–9, accepted v10 SQL, snapshot v2,
codec/reducer, D4 policies, public writer routing and Sync ingress stay frozen.

Windows gates: G4 **24 PASS** (one private subprocess entry run by its parent),
Journal **287 PASS**, dormant v10 **24 PASS**, Sync **86 PASS** (85 original + one
G4 name match), D4 **32 PASS**. Cargo all-targets/typecheck/frontend **561 + build
PASS**; architecture **86 PASS / same 2 FAIL**. Two full-native runs each produced
**1,296 PASS / 6 FAIL / 23 ignored**: the five D4 baseline failures plus the TTS
audio-focus cleanup case; exact isolated TTS **1 PASS**. This additional full-suite
failure remains unresolved; TTS source/assertions are unchanged. No release PASS
or universal physical-bound certification is claimed.

## 15. MEGA E secure identity candidate (2026-10-24)

**PARTIAL / DORMANT.** Windows CNG creates persisted current-user P-256 keys in
the Microsoft Software Key Storage Provider with export policy zero and signing
usage only. A nonsecret slot/public-key anchor uses the existing CaptureStore;
creating/invalidated states and missing keys never regenerate enrolled identity.
Canonical public keys are SEC1 uncompressed points; signatures are P1363 over
domain-separated SHA-256. Native tests cover signing, wrong domains/keys, private
export refusal, RFC 6979 A.2.5 public verification and disk reopen/key loss.
Executed DLLs: ncrypt 10.0.26100.8875, bcryptprimitives 10.0.26100.9711. This is
software KSP evidence, not TPM, FIPS certification or an independent wrapper audit.
See Microsoft's [key creation](https://learn.microsoft.com/en-us/windows/win32/api/ncrypt/nf-ncrypt-ncryptcreatepersistedkey)
and [signing contract](https://learn.microsoft.com/en-us/windows/win32/api/ncrypt/nf-ncrypt-ncryptsignhash).

Direct pins RustRandom getrandom 0.3.4 and RustCrypto zeroize 1.9.0 already existed in Cargo.lock;
no package versions/checksums were added or changed. Both are MIT OR Apache-2.0;
upstream MSRVs 1.63/1.85 fit Rust 1.89. OS RNG rejection sampling preserves six
digits; Zeroizing erases code buffers on drop, without a privileged crash/swap
secrecy guarantee. No audited PAKE/composition was established: RustCrypto
[SPAKE2 explicitly lacks an independent audit](https://github.com/RustCrypto/PAKEs/blob/master/spake2/README.md).
Existing rustls 0.23.45/ring 0.17.14 were evaluated, not newly integrated; rustls
[external signing API](https://docs.rs/rustls/0.23.45/rustls/sign/trait.SigningKey.html)
alone proves neither CNG/Android interoperability nor an audited N1 composition.
Live pairing/listen/dial return `N1_AUDIT_PENDING`; route selection returns
`N7_POLICY_PENDING`. No socket, TLS adapter, discovery or production session
constructor is enabled. Android has no implemented Activity-independent identity
bridge; the existing provider-secret wrapping is not signing evidence.

Test-installed forward-only metadata implements signed single-admin registry
epochs, hash-linked immutable updates, revocation tombstones, exact-key/transcript
approval, channel-bound same-key grant resume/receipt and atomic consumption.
Attempts reserve durably before proof work; restart cancels unresolved challenges
without resetting device-wide counters. The conservative lab limits are five
lifetime reservations/eight issuances, not an approved N3 cooldown policy.
The real import transaction rechecks registry epoch/membership under the same
owner lock before publication/COMMIT; both concurrent revoke/import orders run.
Separate v1 original-event/receipt signatures preserve journal core bytes and
original authorship, but are not wired into release ingress or the Sync wire.

E01–E09/E11–E12/E15–E17/E19/E22 have scoped provider/metadata/parser/storage tests;
E11–E12 use explicitly test-only PAKE proof fixtures. E14 demonstrates closed
entry points only; E18 covers memory leases/cancellation, not socket cleanup.
E21 retains the existing D3/D4 inbound-provider spies in the Sync gate.
E10/E13/E20 remain **BLOCKED**, not fixture-certified. Android target/device,
authenticated loopback/cross-process LAN, native socket timeouts/discovery,
locked OS key behavior and packaged release smoke tests are **UNVERIFIED**.
N1/N2/N3/N7 and G4/G5/G6/G7 remain open; full-filesystem rollback resistance,
admin recovery and restored-origin/incarnation recovery are not certified.
Production schema9/STEPS1–9, accepted v10 SQL, snapshot v2, codec/reducer, D4,
G4 UnverifiedBounds, ClosedTrust and public writer routing remain unchanged.

Windows gates (Cargo used `--locked --offline --manifest-path
apps/arthur/src-tauri/Cargo.toml`; tests used `-- --test-threads=1`):
`check --all-targets` **PASS**; `test --lib sync::security::tests` **20 PASS**;
`test --lib sync` **106 PASS**; `test --lib storage::journal` **287 PASS / 1 ignored**;
`test --lib storage::m05_v10_tests` **24 PASS**; full `test --lib` **FAIL: 1,317 PASS /
5 FAIL / 23 ignored**. The five identities exactly match the historical JEV
transport (Timeout versus Network), two synthesis source-contract checks, frozen
corpus hash and synthesis permission-check cases recorded in the
[G4 gate record](m05-g4-quota-reserve-decision.md). TTS audio-focus passes in this
run; its prior full-suite instability is not declared fixed. `npm run typecheck`
**PASS**; `npm run test:architecture` **FAIL: 86 PASS / same 2 baseline FAIL**
(schema-v6 source check and voice-output DTO check); `npm run arthur:check`
**PASS: 561 tests / 42 files + build**; `git diff --check` **PASS**. No release
readiness claim or waiver of these failing/unverified gates is made.

## 16. MEGA E2 signed trust hardening (2026-10-24)

**PARTIAL / DORMANT.** `DeviceSigningIdentity` is an independent Java AndroidKeyStore
P-256 component using Application context, no Activity/WebView/plugin commands,
and a package/UUID alias supplied by the future native owner's creating record.
It never exports private bytes or regenerates on public/sign/reopen failure.
The owner-coordinated Rust Android bridge remains **UNAVAILABLE**: Java component
source alone is not proof of durable native alias binding or worker integration.
Provider-secret AES wrapping and the Android `_exit` workaround are unchanged.
Keystore usage follows the platform [P-256 signing contract](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec).

Shared preimage is `domain ASCII || NUL || u64-BE(message length) || message`.
All four E domain identifiers, SEC1-65 public points and P1363-64 signatures remain
unchanged. CNG signs SHA256(preimage); Android `SHA256withECDSA` receives preimage,
not its digest. Bounded DER conversion rejects negative/zero/out-of-range scalars,
redundant padding, long/invalid lengths and trailing data; EC operations stay in
platform providers. Public-only CNG and **HOST_JCA_SunEC** fixtures verify both
directions on Windows/JVM, including all domains and the published public vector.
This is **HOST-ONLY INTEROPERABILITY FIXTURE**, not Android interoperability.
`javac --release 8` and the explicit `IdentityFormatHostTest` runner: **64 checks PASS**.

Every registry authorization now reconstructs the complete signed chain from a
separate immutable, locally OS-signed genesis pin (4096 updates / 8 members /
448 origins maximum), verifies root continuity and compares every materialized
member/origin row exactly. Missing/invalid local anchor or mismatched/missing
OS-held key refuses binding and grant delivery. The pin signer must match the
OS-held local anchor; even a complete self-signed SQL registry replacement fails.
Additive `enrollment_e2.sql` is
test-installed only; no accepted E SQL/history or production migration is rewritten.
Reproduced regressions covered chain/projection/pin tampering, absent identity,
observed clock rollback and grant delivery; stored grant bytes must match
the signed update log. Monotone observations expire on regression, while a future
live producer still requires a monotonic boot clock. N3 lab limits remain 5/8.

The separate signed-import candidate validates original origin/key/incarnation,
then runs the existing importer in the same owner transaction. Its locally CNG
signed accepted-prefix seal is checked against original signatures, hash continuity
and real committed import ledger outcomes (bounded to the existing 256-event budget).
An ACK for an already-local canonical core cannot mint foreign original provenance;
the new seam requires an exact chain-verified main-ledger entry before sealing.
Known historical provenance survives revocation; new/ambiguous material is retained
as unsupported in a separate bounded quarantine (32 entries / 4 MiB), without a
domain apply or ACK. Forwarder substitution, incarnation reuse, prefix tampering,
reopen and both concurrent revoke/import commit orders are exercised. This is a
conservative test candidate, not approval of N2's final revoked-origin policy.

**Android evidence: NOT TESTED.** Gradle 9.6.1 / Java 25.0.2 actually ran
`gradlew.bat tasks --all --offline`; configuration **FAILS** because generated
`tauri.settings.gradle` is missing. No build task could be discovered/executed.
Only the Windows Rust target is installed; no configured SDK/adb/device was found.
Android component/instrumentation compilation, process-restart, lock behavior and
E2-01–E2-06 device interoperability remain **UNVERIFIED**. Instrumented test sources
include public-only API/ABI fixture export; Windows E2-06 is explicitly ignored
until an actual device fixture is supplied. JVM compilation is not an Android build.
minSdk 24 / target 37 remain; the test runner uses existing Espresso's runner 1.5.0.

ClosedTrust, production ingress, pairing/listener/dialer and G4 UnverifiedBounds
remain closed. N1/N2/N3/N7 and G4–G7 are unapproved. Full-filesystem rollback,
admin recovery, Android native bridge and packaged release smoke are unverified.
Schema9/STEPS1–9, accepted v10, codec/reducer, snapshot v2, D4 policy and public
writer routing remain frozen. No private keys, enrollment codes or actual user
knowledge are included in the public fixtures or diagnostics.

Final Windows gates used the Arthur Tauri manifest, `--locked --offline` and
`-- --test-threads=1`: Cargo `check --all-targets` **PASS**; explicit E2 filter
**22 PASS / 1 ignored** (actual Android fixture); `--lib sync::security` **42 PASS /
1 ignored**; Sync **128 PASS / 1 ignored**; Journal **287 PASS / 1 ignored**;
dormant v10 **24 PASS**. Full native is **FAIL: 1,339 PASS / 5 historical FAIL /
24 ignored**; all five failure identities match section 15's JEV/synthesis cases.
TTS audio-focus passes; prior intermittence is not declared fixed. Typecheck
**PASS**; architecture **FAIL: 86 PASS / same 2 baseline FAIL**; frontend
**PASS: 561 tests / 42 files + build**; `git diff --check` **PASS**. The failed and
unverified gates are not waived by this safe dormant PARTIAL commit.

## 17. MEGA E2B Android native identity (2026-10-24)

**PARTIAL / DORMANT.** Application bootstrap installs a process-scoped JavaVM and
global Application/class references; Rust workers attach with per-call guards and
local frames. JNI exceptions are cleared into categorical refusals. Signing uses
no Activity, WebView, plugin command or cached Java key object. The Android owner
adapter enforces the existing creating/active/invalidated SQL anchor and serializes
signing with durable invalidation. CNG and provider-secret behavior are unchanged.
JNI lifetime/class-loader handling follows the [Android JNI guidance](https://developer.android.com/ndk/guides/jni-tips).

Tauri CLI 2.12.1 `android init --ci --skip-targets-install`, then `android build
--debug --target x86_64 --apk --ci` regenerate the ignored Gradle integration through
the supported Cargo build script. JBR 21.0.9, NDK 29.0.14206865 and SDK 37 build the
real Rust/Java/Kotlin APK. `gen/android/verify-identity.ps1 -Serial <test-serial>`
adds the explicit debug-only harness and Tauri's supported `debugApplicationIdSuffix`
overlay. It checks APK package IDs before installation, reuses the just-built native
library for Gradle instrumentation, then installs dedicated test APKs for restart
checks. The harness refuses the normal app ID and is forbidden in release builds.
Generated paths, APKs, databases and local device signing fixtures are not committed.

**REAL ANDROID EMULATOR:** read-only Medium_Phone_API_36.1, API 36 / Android 16 /
x86_64: **18 instrumentation PASS + 2 separate process-restart PASS**. Tests cover
native worker signing, exact anchors, key loss/substitution, private export refusal,
creation/invalidation recovery markers after disk reopen, concurrent invalidation,
JNI exception recovery, malformed input, closed bridge references and registry
revocation. CNG signatures verify through the actual Android implementation; a
public-only AndroidKeyStore fixture verifies with Windows CNG (**1 explicit PASS**).
Host-only JCA regression is **67 PASS**. Physical devices, ARM64, release packaging
and hardware-backed key isolation are **UNVERIFIED**, not implied by emulator results.
The dedicated test APK also cold-starts MainActivity successfully; the final default
native library exports bootstrap and excludes the instrumentation entrypoints.

Windows: Cargo `check --locked --offline --all-targets` and typecheck **PASS**;
E2 **22 PASS / 1 ignored**, security **42 PASS / 1 ignored**, Sync **128 PASS /
1 ignored**, Journal **287 PASS / 1 ignored**, dormant v10 **24 PASS**. Full native
**FAIL: 1339 PASS / same 5 historical FAIL / 24 ignored**; architecture **FAIL:
86 PASS / same 2 historical FAIL**. Frontend **561 PASS / 42 files + build** on full
rerun; an initial concurrent run failed the existing retry-card `role=alert` check,
without frontend edits or a claim that intermittence is fixed. TTS audio-focus passes.
N1/N2/N3/N7 and G4–G7 remain unapproved. Schema v9, migrations, codec/reducer,
snapshot v2, D4, public routing and `_exit` are frozen; ClosedTrust, PAKE, mutual TLS,
production ingress, LAN listener and dialer remain CLOSED.

## 18. MEGA E3A cryptographic foundation (2026-10-24)

**PARTIAL / DORMANT. N1_AUDIT_PENDING; recommendation: DO NOT APPROVE N1.**
Scope starts at accepted E2B `17af0790756dd613c7e94fa1793709067a71330f` on
`feature/nodes-integration`. This section is an approval decision package, not
cryptographic approval or a release claim. No PAKE dependency is adopted.

### N1 evidence and decision

| Candidate examined | Version / provenance | Audit and suitability decision |
| --- | --- | --- |
| RustCrypto `spake2` | Stable 0.4.0; 0.5.0-pre.0; MIT OR Apache-2.0. Repository path activity observed at `a35ee6d5f833a3b38e81cf15c0542fb33c456668` (2026-07-16). | Maintainers explicitly report no independent audit. RFC9382 transcript compatibility is questioned in open issue #186. A symmetric PAKE is a natural fit when both devices hold the temporary code, but this implementation does not meet N1. |
| `spake2plus` | 0.1.0, published 2026-10-04; MIT; MSRV 1.85.0. | Explicitly unaudited. Authors report both-role RFC9383 P256/SHA256 and SHA512 vectors. Its optional prover-first confirmation permits offline guessing; that mode is unacceptable here. An augmented verifier-record registration design would need review. |
| `opaque-ke` | Stable 4.0.1, tag commit `75fe4cdddb7946440054da0c8e7cdd73828af3f9`; 4.1.0-pre.2 at `bc588b149eccec77914e38dd29a6a17b47018bfa`; MIT OR Apache-2.0; stable MSRV 1.85. | Strongest independent-audit lineage among these candidates, recommended only for further evaluation. Current RFC9807 implementation is outside the old audit scope; six-digit transient registration and Arthur composition are unapproved. Do not substitute an obsolete audited version. |

Primary sources: [RustCrypto security warning](https://github.com/RustCrypto/PAKEs/blob/master/spake2/README.md),
[RFC transcript issue](https://github.com/RustCrypto/PAKEs/issues/186),
[SPAKE2 stable metadata](https://crates.io/api/v1/crates/spake2/0.4.0),
[SPAKE2+ documentation](https://docs.rs/spake2plus/0.1.0/spake2plus/),
[SPAKE2+ version manifest](https://crates.io/api/v1/crates/spake2plus/0.1.0),
[OPAQUE stable README](https://github.com/facebook/opaque-ke/blob/v4.0.1/README.md),
[stable manifest](https://github.com/facebook/opaque-ke/blob/v4.0.1/Cargo.toml).
Version metadata and tags were checked on 2026-10-24. This is a comparison of
these implementations, not proof that no suitable implementation exists anywhere.

The [NCC report, 2021-12-10 v1.3](https://www.nccgroup.com/media/0uspzge5/_ncc_group_whatsappllc_opaque_report_2021-12-10_v13.pdf)
covers draft03/v0.5.0 (`ba8e940e08a630c0d075e730623ebf0b30d4b9e2`), with primary
retest at v1.2.0 (`6538ee30e118cfc99c1f5bff6d2c151e2eaffd2d`). All eight findings
are marked fixed. Two high findings concern identity-element validation (004)
and reflected OPRF values (010); low findings include MAC timing (006) and
serialization lengths (008). Relevant fix commits are respectively
`a69ad9473aa046c03854ce23534dbfaac24ea2c1`,
`9c28c8597a6ab33d167f3711dab1a297b1be7d6d`,
`3c4b7ce4825031736a04542103ac490d34f9dae2`, and
`f15b37fda4a61ef97025e91f2fcff25ec4d23362`.
The report excludes an in-depth review of v0.6.0/newer protocol revisions.
It cannot establish audit coverage of v4.0.1 or Arthur's composition.

Dependency / secret handling evaluation is source-level, not an executed PAKE
qualification. RustCrypto 0.4.0 (MSRV 1.60) uses curve25519-dalek 4, hkdf 0.12,
rand_core 0.6 and sha2 0.10; full secret erasure
and current RFC vectors are unestablished here. SPAKE2+ uses p256 0.14, sha2 0.11,
hkdf/hmac 0.13, subtle 2.6.1 and zeroize 1.9; its documentation describes drop
zeroization with compiler/caller-copy limitations. OPAQUE 4.0.1 uses voprf 0.5
(`danger` feature), curve25519-dalek 4, elliptic-curve 0.13, rand 0.8,
hkdf/hmac 0.12, subtle 2.6 and zeroize 1.8; optional Argon2 0.5. Default features
are ristretto255/serde; states use zeroize-on-drop. Their pure-Rust/no_std designs
make Windows/Android evaluation plausible, but **no candidate was built or its
RFC vectors executed on either platform in E3A**. Library documentation is not
Arthur portability, constant-time or memory-erasure certification.
OPAQUE's stable source includes [RFC9807 Appendix C vectors](https://github.com/facebook/opaque-ke/blob/v4.0.1/src/tests/rfc9807_vectors.rs);
their presence is source evidence only, not an executed compatibility result.

N1 approval requires an independently reviewed exact maintained revision and
dependency configuration, verified RFC vectors on both targets, and review of
temporary-code generation, transient verifier registration, confirmation order,
online guessing limits, deadline/restart policy and channel binding. Existing
durable enrollment attempt limits must remain authoritative. Never log/store the
six-digit code as a credential or replace PAKE with a code-derived custom MAC.
OPAQUE's historic audit is useful evidence, not permission to activate it.

### Implemented native TLS seam

Direct dependencies are exactly `rustls =0.23.45` (default features disabled,
`ring,std`) and `ring =0.17.14`; both were already locked transitively. Cargo.lock
only adds root dependency edges. Rustls is Apache-2.0 OR ISC OR MIT, MSRV 1.71;
ring retains upstream ISC, Apache-2.0 and MIT license notices and MSRV 1.66.
The selected rustls version meets the fixed range of
[RUSTSEC-2026-0285](https://rustsec.org/advisories/RUSTSEC-2026-0285.html);
this check is not a complete dependency audit. Other dependencies may enable
rustls TLS1.2 features through Cargo unification; the lab configuration itself
explicitly allows **only TLS1.3**.

`OwnedTlsKey` implements rustls `SigningKey`/`Signer`, offering only
`ECDSA_NISTP256_SHA256` (0x0403). Its production constructor always refuses with
ActivationPending. Test constructors are cfg-gated. Every signature rechecks
the existing durable exact-key anchor and OS public key under the original
CaptureStore connection mutex, held through signing and verification. Cached
callbacks cannot outlive invalidation semantics; no second SQLite owner exists.

The callback accepts the full [RFC8446 CertificateVerify preimage](https://www.rfc-editor.org/rfc/rfc8446.html#section-4.4.3):
64 spaces, the exact server/client context, NUL and a 32/48-byte transcript hash.
It rejects other lengths, roles and contexts before OS calls. CNG hashes this
preimage once with SHA256 and calls NCryptSignHash; Android SHA256withECDSA
hashes the supplied preimage once inside JCA. P1363-to-DER conversion validates
P256 scalar bounds and minimal positive INTEGER encoding. Existing application
domain-separated signatures are unchanged and cannot substitute for TLS signing.
Private keys remain non-exportable in CNG/Keystore. Public-only interoperability
fixtures contain no private key, enrollment code or user knowledge.

The cfg-gated memory lab performs real mutual TLS1.3 with RFC7250 raw public keys,
exact SPKI pins and real CertificateVerify verification through rustls/ring.
No accept-all signature verifier is used. No sockets/listener/dialer exist in
the lab. It requires client authentication and the lab ALPN, disables resumption,
tickets and early data, and bounds pumping to 32 rounds / 256 KiB. Its
[RFC9266 tls-exporter](https://www.rfc-editor.org/rfc/rfc9266.html) uses label
`EXPORTER-Channel-Binding`, empty context and 32 bytes, checked equal at both ends.
RPK pins prove fixture key possession, not network membership or approved PKI.
Production certificate/RPK provisioning and trust policy remain N1/N7 work.

### Proposed composition and tested limits

The proposed order is provisional TLS key possession, then an approved PAKE
exchange inside that protected channel, then explicit human approval. Before
approval, no knowledge transfer or membership grant is permitted. The canonical
context includes enrollment UUID, network UUID, admin fingerprint, ordered
issuer/joiner exact public identities, both nonces, fixed versioned suite and
the channel exporter. Roles cannot be swapped. An audited PAKE adapter must
bind this context and require both protocol confirmations with the library's
prescribed ordering. The context hash is metadata binding, not a new PAKE/KDF/MAC.
Any future approval must refer to this exact enrollment and key/role binding;
fresh nonces require OS CSPRNG generation. Neither policy is activated by E3A's
fixed synthetic test nonces or by a generic approval boolean.

E3A tests use **SyntheticPakeConfirmation**, explicitly cfg-gated fixture digests,
with a real TLS exporter. They exercise enrollment/network/admin/key/role/nonce/
suite mutations, cross-channel confirmation reuse, partial confirmation and
consumed-attempt replay. This is not proof of PAKE authentication. Attempt
consumption is memory-local; global replay, filesystem rollback and crash policy
still require approved integration with the existing durable enrollment state.
`audited_pake_adapter()` and even the lab pending-human object's `grant()` always
return N1AuditPending. There is no production VerifiedSession, CandidateProof,
membership or signed-import factory produced by successful TLS or fixture PAKE.

### Executed verification and remaining gates

Results are scoped to E3A on Windows and the dedicated debug Android test
application. Commands use the Tauri manifest and Windows `--locked --offline`.

| Gate | Executed evidence | Result |
| --- | --- | --- |
| Native compile | `cargo check --all-targets` | PASS, including final rerun after formatting |
| E3A CNG / TLS | `cargo test --lib storage::security_tls_tests -- --test-threads=1` | 6 PASS / 1 explicitly ignored device-fixture test |
| Android signature on Windows | `cargo test --lib e3a_07_actual_android_tls_signature_verifies_on_windows -- --ignored --test-threads=1`, with actual public-only device fixture | 1 PASS |
| Full native | `cargo test --lib -- --test-threads=1` | FAIL: 1345 PASS / same 5 historical FAIL / 25 ignored |
| Security / Sync / Journal / dormant v10 | Results selected from that full native run by the respective `sync::security`, `sync`, `storage::journal`, `storage::m05_v10_tests` name filters | 42/128/287/24 PASS; 1/1/1/0 ignored; overlapping groups, not extra executions |
| Root typecheck | `npm run typecheck` | PASS |
| Architecture | `npm run test:architecture` | FAIL: 86 PASS / same 2 historical FAIL |
| Frontend | Full `npm run arthur:check` rerun | PASS: 561 tests / 42 files + typecheck/build |
| Android actual Rust/Java/Kotlin/debug APK | `gen/android/verify-identity.ps1 -Serial emulator-5554` | PASS, 25 instrumentation + 2 process-restart invocations |
| Default Android debug APK | `npm run tauri -- android build --debug --target x86_64 --apk --ci` without harness feature | PASS; generated test app suffix removed |
| Harness exclusion / smoke | NDK `llvm-nm --dynamic --defined-only` on default .so; `adb shell am start -W` on dedicated test APK | PASS: bootstrap exported, no test JNI entrypoints; cold start Status ok |
| Host JCA | JBR `javac --release 8` for IdentityFormat, TlsSignatureFormat and IdentityFormatHostTest, then runner with both existing CNG/JCA public fixtures | 67 checks PASS, host-only |
| Whitespace | `git diff --check` | PASS |

Android environment: read-only Medium_Phone_API_36.1, Android 16 / API 36 /
x86_64, JBR 21.0.9, NDK 29.0.14206865, SDK 37, Tauri CLI 2.12.1. Test APK IDs
are `dev.kaloyan.arthur.identitytest` and `.identitytest.test`. The emulator was
stopped after verification. Instrumentation XML records 25 tests, zero failures,
errors or skips. The two extra invocations verify application AND TLS signing
before/after force-stop with the durable key. Five new Rust/JNI scenarios cover
TLS signatures, schemes/input bounds, lifecycle, mutual TLS and composition;
two new Java cases verify CNG signatures and emit a public-only Keystore fixture.

The five native failure identities are unchanged from accepted E2B:

```text
jev::tests::the_real_transport_posts_json_with_a_bearer_header_and_never_leaks_the_key_in_errors
synthesis::architecture_tests::a_same_family_pass_is_wired_to_hold_for_review_and_the_shipped_verifier_is_not_called_independent
synthesis::architecture_tests::the_real_synthesis_endpoint_is_only_reachable_through_the_production_constructor
synthesis::eval::tests::the_corpus_is_frozen
synthesis::tests::the_commit_time_permission_check_includes_the_synthesis_authorizations
```

The architecture failures remain the schema-v6 project ownership and M04.6
voice-output DTO source assertions. No new native or architecture failure was
observed. Initial concurrent frontend run: 560 PASS / 1 IdeasScreen missing-alert
timeout; full rerun passes without frontend edits or an intermittence-fix claim.
Two initial compile borrow errors in new tests were fixed. An interop compile
collided with the running Windows test executable (LNK1104); its sequential final
rerun passes. These initial failures are not omitted or counted as final PASSes.

Reproduction: set process-local ANDROID_HOME, NDK_HOME and JAVA_HOME, start a
disposable supported emulator, run the verification script. The committed
`androidTest/assets/tls-cng-public.properties` is generated by actual CNG test
`e3a_06_public_cng_tls_fixture_for_android` with `ARTHUR_E3_CNG_TLS_FIXTURE` set.
After connected-test APK cleanup, the script reinstalls checked dedicated APKs.
Run `TlsIdentityTest#prepare_android_public_tls_fixture` with `am instrument -w`;
require `OK (1 test)`, then use `adb exec-out run-as dev.kaloyan.arthur.identitytest
cat no_backup/e3a-android-tls-public.properties` into a local temporary file. Set
`ARTHUR_E3_ANDROID_TLS_FIXTURE` to it for the explicitly ignored Windows test.
Only the public CNG fixture is committed; generated device output and all test
databases/APKs/logs stay outside tracked sources. Rebuild the default APK and
check its dynamic symbols after the harness run.

Interoperability scope is CNG CertificateVerify signatures checked on Android,
and Keystore CertificateVerify signatures checked by ring on Windows. Each OS
also runs its own two-key mutual TLS memory handshake. A mixed-OS live TLS
connection was not run; no production network connection is implied.

Production remains schema v9 / STEPS1–9; dormant v10, journal/codec/reducer,
snapshot v2, D4/G4 and public routing are frozen. E2B JNI bootstrap, existing
application domains and provider credentials are preserved. ClosedTrust,
production PAKE/TLS/LAN, enrollment and knowledge ingress remain CLOSED.
N2/N3/N7 and G4–G7 are independent unapproved gates. Physical Android, ARM64,
release packaging, hardware isolation, production certificate policy and the
composed PAKE protocol are UNVERIFIED. Do not proceed automatically to E3B.

## 19. MEGA E3A2 PAKE qualification and enrollment hardening (2026-10-24)

**PARTIAL / N1_AUDIT_PENDING. Recommendation: DO NOT APPROVE N1.** Accepted
baseline is `bb57a98820f5e2e021b01016f8969b8c634c4299`, same feature branch.
This phase executes a real PAKE qualification harness; it does not approve or
activate PAKE. The historical E3A results above remain historical, not evidence
of an E3A2 gate that did not run.

### Candidate qualification and current advisory evidence

| Exact candidate | Qualification decision / compatibility / maintenance |
| --- | --- |
| `opaque-ke =4.0.1`, crate and stable tag `75fe4cdddb7946440054da0c8e7cdd73828af3f9` | Actual Rust public API executed. MIT OR Apache-2.0, MSRV 1.85. Stable RFC9807 release; 4.1.0-pre.2 exists but is not substituted. Changelog documents protocol/API/dependency changes since the audited drafts. Best audit lineage of these three, but conditional suitability and an unresolved affected dependency prevent N1 approval. |
| Balanced RustCrypto `spake2 0.4.0` | Symmetric shared-code model fits naturally without a verifier registration phase. MIT OR Apache-2.0, MSRV 1.60; curve25519-dalek 4, hkdf 0.12, rand_core 0.6, sha2 0.10. Upstream explicitly has no independent audit; RFC9382 transcript issue #186 remains open. 0.5.0-pre.0 is a different, unqualified revision. No Arthur Windows/Android build or official-vector execution for this candidate. |
| `spake2plus 0.1.0` | MIT, MSRV 1.85; newly published 2026-10-04, no independent audit. p256 0.14, hkdf/hmac 0.13, sha2 0.11, subtle 2.6.1, zeroize 1.9. Upstream reports RFC9383 P256/SHA256 and SHA512 vectors; not executed here. Requires a confidential verifier-registration model; its optional prover-first confirmation exposes offline guessing and is excluded. No Arthur platform qualification claim. |

Primary evidence: [OPAQUE 4.0.1 manifest](https://github.com/facebook/opaque-ke/blob/v4.0.1/Cargo.toml),
[changelog](https://github.com/facebook/opaque-ke/blob/v4.0.1/CHANGELOG.md),
[public API / registration and KSF guidance](https://docs.rs/opaque-ke/4.0.1/opaque_ke/),
[OPAQUE published advisory page](https://github.com/facebook/opaque-ke/security/advisories),
[RustCrypto warning](https://github.com/RustCrypto/PAKEs/blob/master/spake2/README.md),
[open RFC9382 issue](https://github.com/RustCrypto/PAKEs/issues/186),
[SPAKE2+ security documentation](https://docs.rs/spake2plus/0.1.0/spake2plus/).
Direct OSV queries for these three exact package versions returned empty advisory
records on 2026-10-24. That is not a claim about their dependency chains or an audit.

The [NCC report](https://www.nccgroup.com/media/0uspzge5/_ncc_group_whatsappllc_opaque_report_2021-12-10_v13.pdf)
reviewed v0.5.0 (`ba8e940e08a630c0d075e730623ebf0b30d4b9e2`) and primarily
retested v1.2.0 (`6538ee30e118cfc99c1f5bff6d2c151e2eaffd2d`), draft03.
Its fixed findings and exact patches are recorded in section 18. This evidence
does not establish review of 4.0.1, RFC9807, the locked dependency graph or Arthur.

`qualification/verify-dependencies.ps1` executes locked offline Cargo metadata,
then queries OSV using PUBLIC package names/versions. Its committed packages and
advisories JSON record the **69-package all-target/build transitive closure of
OPAQUE and Argon2**, not the whole application's security status. A current
finding remains: [RUSTSEC-2026-0387](https://github.com/rustsec/advisory-db/blob/main/crates/crypto-bigint/RUSTSEC-2026-0387.md),
`opaque-ke 4.0.1 -> elliptic-curve 0.13.8 -> crypto-bigint 0.5.5` (also through
voprf 0.5.0). The advisory identifies timing variability, fixed in >=0.7.6.
The current dependency requirement cannot accept that incompatible version.
No patch/fork/custom arithmetic or advisory waiver is introduced. Reachability
and exploitability through this selected ristretto255 suite are **not established**;
the unresolved graph finding still blocks qualification. This is additional
evidence, not a claim that Arthur's Ristretto execution was exploited.

The initial snapshot also found rand 0.8.5 affected by
[RUSTSEC-2026-0097](https://rustsec.org/advisories/RUSTSEC-2026-0097.html).
It is pinned to patched **0.8.6**; exercises use OsRng, never a custom ThreadRng
logger. The new harness uses `opaque-ke =4.0.1` with only `ristretto255,argon2`,
`rand =0.8.6`, `argon2 =0.5.3` with zeroize, existing sha2 0.10.9 and zeroize 1.9.
Cargo.lock fixes all checksums and transitive versions (including
curve25519-dalek 4.1.3, voprf 0.5.0 with its upstream-required `danger` feature,
hkdf/hmac 0.12, elliptic-curve 0.13.8). The crate's .cargo_vcs_info matches the
stable tag; archive checksum is
`ded22991b43cd15561b62b2e1cf9ace1344a8534eebec96202d5c96a77a6616a`.
These are dev dependencies on Windows and optional Android dependencies enabled
only by `android-identity-tests`. Default Windows AND Android normal/build Cargo
trees contain no opaque-ke, Argon2 or crypto-bigint qualification dependency.

Rustls is narrowly updated **0.23.45 -> 0.23.46** for
[RUSTSEC-2026-0346](https://rustsec.org/advisories/RUSTSEC-2026-0346.html) and
[RUSTSEC-2026-0349](https://rustsec.org/advisories/RUSTSEC-2026-0349.html).
E3A had no custom session-value logging and disabled resumption, limiting those
particular lab paths; the fixed library is used nevertheless. Ring stays 0.17.14.
No other existing dependency versions are opportunistically upgraded.

### Executed PAKE protocol and secret-handling scope

`pake_qualification.rs` uses the ACTUAL opaque-ke library. It registers locally
at the code issuer, retains one ephemeral ServerSetup/password file in memory,
then runs fresh client/server logins. It serializes/deserializes the public
credential messages and requires valid server confirmation before KE3, followed
by valid client confirmation at the server. Only both completions with matching
session keys produce the private-field `ConfirmedExchange` lab type. No code PSK,
code-derived custom MAC, custom group arithmetic or replacement PAKE is added.

Official [RFC9807 Appendix C](https://www.rfc-editor.org/rfc/rfc9807.html#appendix-C)
vectors **C.1.1, C.1.2 and C.2.1** are normalized from the exact upstream source
and retain provenance/hash/license in `qualification/NOTICE.md`. The two real
vectors check registration request/response/upload, KE1/KE2/KE3, export key and
both session keys; the fake-user vector checks KE2. Their Identity KSF is the
published vector configuration, not the enrollment configuration. Public release
API scalar sampling consumes 64 bytes, whereas upstream cfg(test) injects the
published 32-byte scalar: the fixture zero-extends the canonical scalar, without
changing any expected vector value. Initial vector failures identified this
fixture adaptation and were fixed without changing upstream cryptography.
No P256/curve25519/SIGMA-I PAKE-vector compatibility is claimed.

The distinct six-digit exercises use upstream **Argon2id v19, m=19456 KiB, t=2,
p=1**. The upstream OPAQUE KSF supplies a fixed 16-byte zero salt after the
per-record OPRF; this is not a new Arthur password-storage format. Codes have
about 20 bits of entropy. OPAQUE does not make server-setup/password-file theft
immune to offline enumeration, and Argon2 does not prove a 120-second attacker
budget. A balanced PAKE would be simpler when both devices already hold the code.
OPAQUE is only a conditional fit if this local confidential transient registration
and its role mapping receive independent review; no untrusted remote registration
or persistent enrollment-password database is introduced.

Codes remain Zeroizing/borrowed; upstream key/state/record types have drop erasure;
output session keys and unused registration export keys are explicitly cleared.
No wrapper has Debug/Serialize for secrets. Argon2's zeroize feature does not
establish complete clearing of all internally allocated working memory or compiler
copies; privileged memory/swap/crash exposure remains a limitation and N1 review
item. Only public official vector seeds/keys are committed. No actual permanent
OS private key is exported. PAKE ephemerals are Rust memory state, distinct from
the CNG/Keystore device signing key.
The standalone wrong-code/confirmation exercise uses fixed PUBLIC test IDs/code.
The owner/composition scenarios use generated challenge codes, actual native
device keys and real TLS exporters. Their application nonces and monotonic clock
ticks are deterministic fixtures; no live clock producer or nonce policy is approved.

### Revised roles, initial peer pins and durable composition

The E3A reverse-role regression first FAILED, showing the implicit issuer/server
assumption; it passes after the fix. Context now separately records admin public
key/fingerprint, sponsor, code issuer, joiner, TLS server endpoint and both PAKE
endpoints. The supported qualification profile is explicitly **admin-only sponsor
and code issuer**, with OPAQUE client=joiner/server=sponsor; TLS server may be
either device. Admin-only is a constraint, not an assertion that those roles are
universally identical. Non-admin sponsor or delegated issuer returns
**N2PolicyPending**. TCP dial/listen direction confers no authority.

The binding includes exact enrollment/network UUIDs, admin/key fingerprints and
full device public keys, protocol suite, both nonces, role mapping and actual
TLS exporter. OPAQUE authenticates its context; the approval digest additionally
binds the public KE1/KE2/KE3 transcript. Changing channel, network, role, issuer,
candidate or nonce cannot reuse an old confirmation. The context digest is public
metadata binding, not a new PAKE key schedule. Existing E3A synthetic confirmation
tests remain explicitly synthetic and cannot create the actual qualification type.

Initial enrollment has **observed**, untrusted SPKIs, not previously authenticated
peer pins. The cfg-gated TLS lab reports ObservedKeyPossessionOnly and verifies
possession of that exact observed key. No trust-all verifier, remembered trusted
pin, membership or private Sync access results. Actual OPAQUE tests reject
confirmation across different TLS exporters and substituted key/role contexts.
Production bootstrap key acquisition, certificate/RPK policy, confirmation UI
and both endpoints' retry behavior remain unimplemented N1/N3/N7 decisions.
A live mixed-platform bootstrap session has not been run.

The debug/test `record_qualification` adapter consumes actual lab evidence and
uses the ORIGINAL CaptureStore mutex, e_enrollments/e_abuse/e2 clock and native
admin anchor. It stores only the exact candidate and public approval digest.
No new schema, connection, owner, migration or code/verifier/session-key row is
added. Reservation precedes expensive PAKE work; cryptography runs outside the
SQL lock. Proof recording rechecks boot, ticket, key/root and the original
120-second deadline in one transaction. Each reservation consumes budget before
PAKE; wrong-code tests use the original failed-attempt transition without refund.
Five wrong attempts remain locked across startup.

Successful PAKE only reaches pending approval. The lab grant entrypoint still
returns N1AuditPending. Tests invoke the existing separate local approval command
with exact candidate/hash/admin key. A fault after membership application but
before consumed-record commit rolls back registry, grant and membership together.
Restart after KE1 cancels the reservation and preserves abuse counters; transient
PAKE state is never resumed. No additional approval window is silently added.
Concurrent attempts, replayed tickets, consumed challenges, expiry at proof AND
approval, and missing/substituted signing keys before proof AND approval are
covered. Denial of pairing by exhausting five attempts is an accepted availability
cost, not a reason to reset the counter.

### E3A2 verification snapshot

All Windows Cargo commands use `--locked --offline --manifest-path
apps/arthur/src-tauri/Cargo.toml`; tests use `-- --test-threads=1`. The Windows
full run, typecheck, architecture and frontend gates ran sequentially, followed
by Android, fixture interoperability and the default Android build.

| Gate / command | E3A2 executed result |
| --- | --- |
| Pre-change E3A baseline: `cargo test --lib storage::security_tls_tests` | 6 PASS / 1 ignored |
| New focused suite: `cargo test --lib e3a2` | 11 PASS; includes the 3 official RFC vectors |
| `cargo check --all-targets` | PASS |
| `cargo test --lib` | FAIL: **1356 PASS / same 5 historical FAIL / 25 ignored** |
| Security / Sync / Journal / dormant-v10 name groups from that full run | **46/132/287/24 PASS**, 1/1/1/0 ignored; overlapping groups, not additional executions |
| E2B/E3A regressions within full native | Original E2 22 PASS / 1 ignored; TLS module 8 PASS / 1 ignored (6 E3A plus 2 E3A2); all identity/closure assertions pass |
| `npm run typecheck` | PASS |
| `npm run test:architecture` | FAIL: **86 PASS / same 2 historical FAIL** |
| `npm run arthur:check` | PASS first run: **561 tests / 42 files + typecheck/production frontend build** |
| `gen/android/verify-identity.ps1 -Serial emulator-5554` | PASS: actual Rust/Java/Kotlin/debug APK, **34 instrumentation + 2 separate process-restart invocations** |
| Android official vectors | C.1.1/C.1.2/C.2.1 PASS through actual Rust library; counted within one of the 34 instrumentation cases |
| Fresh device public fixtures | `am instrument` explicitly runs the E2 and TLS fixture methods: **2 PASS** repeat executions; public-only output extracted with dedicated-package run-as |
| `cargo test --lib actual_android -- --ignored --test-threads=1` | **2 PASS**: actual Keystore application signatures verified by Windows CNG; actual Keystore CertificateVerify verified by ring on Windows |
| JBR `javac --release 8` / `IdentityFormatHostTest` with CNG, host-JCA and fresh Android public fixtures | **91 checks PASS**, host-only JCA evidence |
| Dedicated test APK `adb shell am start -W` | PASS: Status ok, COLD MainActivity start |
| Default `npm run tauri -- android build --debug --target x86_64 --apk --ci`, no harness feature | PASS, one APK; generated test application suffix removed |
| NDK `llvm-nm --dynamic --defined-only` on default native .so | PASS: bootstrap install exported, no BridgeTest/RestartTest JNI entrypoints |
| Default Cargo normal/build graphs on Windows and Android | PASS: no opaque-ke / Argon2 / crypto-bigint qualification dependencies |
| `qualification/verify-dependencies.ps1` | Executed OSV snapshot: 69 packages / **1 unresolved dependency advisory**, not an approval PASS |
| Scoped new-source rustfmt checks and `git diff --check` | PASS |

Android scope is the task-owned read-only Medium_Phone_API_36.1 emulator,
**API 36 / Android 16 / x86_64**, SDK 37, NDK 29.0.14206865, JBR 21.0.9,
Tauri CLI 2.12.1. Instrumentation XML has 34 tests, zero failures/errors/skips.
The test package is `dev.kaloyan.arthur.identitytest`; only its checked APKs are
installed. All accepted E2B/E3A instrumentation cases rerun, plus nine E3A2 cases.
Restart phase one persists a reserved ticket and starts actual OPAQUE KE1; after
force-stop, phase two reopens the SAME native key, signs TLS, cancels the pending
enrollment and verifies the attempt counter remains one with no grant. The
emulator was stopped after final verification. This is not device certification.

The five native failure identities exactly match section 18 (JEV transport error
classification and the four synthesis assertions). The architecture failures
remain schema-v6 project ownership and M04.6 voice-output DTO source checks.
**No new test regression observed.** The expected red reverse-role regression
and the initial RFC fixture entropy mismatches were corrected; neither expected
vector values nor historical failure expectations were weakened. The dependency
advisory is a newly documented SECURITY QUALIFICATION BLOCKER, independently of
the test counts. Self-review found no new correctness/data-loss/concurrency
defect in the dormant scope; it is not an independent cryptographic audit.

Reproduce Android using the same process-local SDK/NDK/JBR environment and
verification script as sections 17–18. Then explicitly select
`TlsIdentityTest#prepare_android_public_tls_fixture` and
`DeviceSigningIdentityTest#e2_06_prepare_public_only_device_fixture_for_windows`;
require `OK (2 tests)`. Extract `no_backup/e3a-android-tls-public.properties` and
`no_backup/e2-android-public.properties` from ONLY the dedicated package, set
ARTHUR_E3_ANDROID_TLS_FIXTURE / ARTHUR_E2_ANDROID_PUBLIC_FIXTURE respectively,
and run the explicitly ignored Windows filter above. Rebuild the default APK
and inspect its symbols/dependency graph after the harness. Generated device
fixtures, APKs, databases and logs remain untracked. Committed qualification
JSON/NOTICE/license contain only public upstream vectors and package/advisory data.

Approval blockers remain independent: N1 needs an exact independently reviewed
implementation/dependency configuration and composed-protocol review; N2 must
decide sponsorship/delegation; N3 must approve reverse enrollment, retry/startup
and user confirmation flows; N7 must approve production peer/certificate/session
policy. G4–G7 remain unapproved. **No N1 self-approval or E3B continuation.**
Production schema v9, dormant M05, ClosedTrust, live PAKE/mutual TLS/LAN CLOSED,
G4 UnverifiedBounds, frozen journal/codec/reducer/snapshot v2/D4 and public routing
are preserved. ARM64, physical Android, release packaging, hardware certification
and live mixed-platform sessions are **NOT TESTED** unless explicitly recorded.

## 20. MEGA E3A3 N1 qualification closure packet (2026-10-24)

**PARTIAL; N1_AUDIT_PENDING. Recommendation: DO NOT APPROVE N1.** Accepted
baseline `1414dd4ccaf2aa4f8d4762045aa3c80ba531816c`, same feature branch.
The standalone [external review packet](m05-n1-external-review.md) contains the
exact implementation/revisions, dependency graph, comparison/decision, audit
scope, complete roles/messages, threat/compromise model, lifecycle limitations,
advisory analysis and explicit approval/rejection questions. It is an internal
engineering package for an independent reviewer, not an independent audit.

### Findings, correction and disposition

| Classification | Evidence and disposition |
| --- | --- |
| Important, fixed in dormant qualification | `record_qualification` previously accepted a successful PAKE context from a failed reservation under a fresh ticket for the same enrollment. New `e3a3_old_confirmation_cannot_use_a_new_reservation` failed before correction (0/1), passed afterward (1/1). Context now includes a v4 reservation UUID, authenticated by OPAQUE; owner compares it to active ticket.nonce. Suite metadata advances to pending-v2. No DDL/protocol primitive is changed. Both charged attempts remain and no approval/member is created by replay. Same regression is in Android case28. |
| N1 blocker, unresolved | Locked crypto-bigint 0.5.5 remains flagged by RUSTSEC-2026-0387. No compatible upstream fix or supported feature removal exists. No override, fork, custom arithmetic or waiver. New OSV snapshot `qualification/e3a3-advisories.json` retains the finding. |
| N1 blocker, unresolved | Exact implementation and composed enrollment have no applicable independent audit. NCC's older draft03 v0.5.0 / v1.2.0 review is not an audit of opaque-ke4.0.1/RFC9807 or Arthur. |
| Important qualification limitation, documented | Both endpoints and session keys are in one process. Client finish does not prove server received KE3. Initial observed keys, expected admin/network/nonces, transient verifier teardown and distributed final acknowledgment need a live design and independent review. No production behavior is added to imitate the lab oracle. |

Review covered actual PAKE wrapper/composition, owner proof/approval writes and
deadline transactions, native TLS callbacks, CNG/Keystore/JNI lifetime and
cfg boundaries. No additional data-loss/concurrency defect was identified in
these dormant paths; secret persistence review found only public metadata and
signed bytes in the write paths, no secret logging/serialization. This does not
prove complete heap/swap/crash erasure or certify compiler/platform timing.
Upstream KSF/Argon2 buffers and cancellation of a raw lab verifier remain explicit
limitations; no live caller or retry policy is manufactured here.

Architecture impact of the correction: (1) CaptureStore remains ticket truth;
(2) its existing owner alone writes; (3) test adapter -> composition -> library;
(4) only public reservation UUID crosses the existing metadata boundary;
(5) mismatch refuses before SQL mutation; (6) original reservation lifecycle and
terminal teardown stay in place; (7) deterministic ledger clock plus real CNG/
Keystore/TLS/OPAQUE exercise the seam; (8) no migration, old pending suite is
explicitly rejected; (9) categorical errors only; (10) PAKE success grants no
production privilege. No second source of truth, owner or activation is added.

### Dependency reachability and candidate decision

Selected-path source tracing: opaque-ke's Ristretto 3DH implementation uses
dalek; OPRF delegates to voprf's Ristretto implementation, whose elliptic-curve
use is ExpandMsgXmd/Expander. Those inspected functions use SHA/bytes/public
lengths, with no bigint calls. Secret-dependent scalar/point operations execute
in dalek; TLS P256 executes in ring/CNG/JCA. **No selected registration/login
secret path to the advisory's bigint operations was identified.** This is a
bounded static analysis, not binary/target CT proof or an advisory dismissal.
Generic Weierstrass implementations are present but not selected. Changing the
suite/features/dependencies requires a new analysis.

[RustSec](https://github.com/rustsec/advisory-db/blob/main/crates/crypto-bigint/RUSTSEC-2026-0387.md)
identifies fixes starting at 0.7.6; [upstream release/fix links](https://github.com/RustCrypto/crypto-bigint/pull/1365)
cover arithmetic/equality/inversion timing. Registry checks on this date found
crypto-bigint0.7.7 and elliptic-curve0.14.2, but latest compatible 0.5.5/0.13.8
remain unpatched. OPAQUE4.1.0-pre.2 still requires elliptic-curve0.13/voprf0.5.
Both parents require elliptic-curve unconditionally, which requires bigint0.5;
supported curve/default feature selection cannot remove it. The current
69-package OSV result is one unresolved advisory, not an audit PASS.

**Preferred candidate for subsequent independent qualification: balanced
RustCrypto spake2=0.4.0 / Ed25519Group. No candidate currently meets N1.** Both
devices already hold the short-lived code; removing verifier registration fits
that model better. This decision is based on protocol needs, not test counts.
Exact source `3e126d74b692a20d88f6ec62c770ac0c93ab002c`, crate hash and direct
requirements are in the packet. It has no independent audit and open RFC9382
encoding issue #186; mutual confirmation/context profile, locked closure,
vectors and Windows/Android integration must be qualified. No replacement is
installed. OPAQUE4.0.1 remains a lab comparison only; SPAKE2+0.1.0 adds a verifier
without a product need and lacks audit/platform evidence. Its prover-first
confirmation is excluded. N1 remains closed regardless of test success.

`qualification/verify-isolation.ps1` now checks four locked target graphs with
positive controls: default Windows/Android normal+build exclude opaque-ke,
Argon2 and crypto-bigint; Windows dev and Android feature graphs contain them.
This avoids confusing test-only exposure with the shipped dependency graph.

### Verification and remaining gates

Windows commands use `--locked --offline --manifest-path
apps/arthur/src-tauri/Cargo.toml`; native tests use `-- --test-threads=1`.
Resource-intensive gates are sequential. Baseline focused E3A2 ran before edits:
11 PASS. Official vector files/expected values, manifest and lock are unchanged.

| Gate / executed command | E3A3 result |
| --- | --- |
| `cargo check --all-targets` | PASS |
| `cargo test --lib` | FAIL: **1357 PASS / same 5 historical FAIL / 25 ignored**, 348.72s; baseline 1356/5/25 |
| Security / Sync / Journal / dormant-v10 groups from full run | **46/132/287/24 PASS**, 1/1/1/0 ignored; overlapping name groups, not extra executions |
| E2 / TLS / E3A2 / E3A3 groups from full run | **22/8/11/1 PASS**; E2 and TLS each have 1 ignored real-Android fixture test, handled separately below |
| Official RFC9807 vectors | C.1.1/C.1.2/C.2.1 PASS, unchanged expected data/fixture files; within E3A2 count |
| `npm run typecheck` | PASS |
| `npm run test:architecture` | FAIL: **86 PASS / same 2 historical FAIL** |
| `npm run arthur:check` | PASS: **561 tests / 42 files**, typecheck and Vite production build; existing chunk-size warning |
| `qualification/verify-dependencies.ps1 -OutputDirectory $env:TEMP/arthur-e3a3-dependencies` | Completed locked metadata + OSV: **69 packages / 1 unresolved advisory**; package closure matches committed packages.json exactly; security qualification remains FAIL |
| `qualification/verify-isolation.ps1` | PASS: four target graphs, both negative default graphs and positive test/debug controls |
| Actual Tauri Android release build with instrumentation feature | PASS expected rejection: Rust compile exit101 / CLI exit1, both explicit compile_error guards observed; no successful release artifact |
| Scoped changed Rust files `rustfmt --check --edition 2021` and `git diff --check` | PASS |

The five native failure identities exactly match accepted E3A2: JEV real
transport error classification plus the two synthesis architecture assertions,
frozen synthesis corpus and synthesis commit-time authorization source check.
Architecture retains schema-v6 project ownership and M04.6 voice-output DTO
checks. **No new test failure.** The deliberate red reservation regression is
fixed; historical expectations and official vector values were not weakened.

Negative release reproduction (working directory `apps/arthur`, process-local
SDK/NDK/JBR environment as section19): `npm run tauri -- android build --target
x86_64 --apk --ci --features android-identity-tests --config
src-tauri/gen/android/identity-tests.tauri.json`. This actually invokes Cargo
`build --target x86_64-linux-android --lib --release`, not check/source inspection.
Output contains both `android-identity-tests is forbidden in release builds`
and `PAKE qualification is forbidden outside debug instrumentation`. The
unsupported configuration additionally reports eight missing debug-only
slot_for_instrumentation methods. These secondary diagnostics are disclosed;
the explicit guards, not a linker/environment failure, establish rejection.
This negative result does not establish successful release packaging.

Android execution uses the task-owned read-only **API36 / Android16 / x86_64**
Medium_Phone_API_36.1 emulator, SDK37, NDK29.0.14206865 and JBR21.0.9. Commands
and the dedicated `dev.kaloyan.arthur.identitytest` package are the same as
section19. The emulator was stopped after instrumentation/interoperability/smoke.

| Additional executed gate | E3A3 result |
| --- | --- |
| `gen/android/verify-identity.ps1 -Serial emulator-5554` | PASS: actual Rust/Java/Kotlin/debug APK and **35 instrumentation tests**, XML **0 failures / 0 errors / 0 skips**, plus **2 separate process-restart invocations PASS** |
| E3A3 Android regression | `e3a3_old_confirmation_new_reservation_rejected` present and PASS in fresh XML; original E2B/E3A/E3A2 including official vectors rerun |
| Explicit fresh E2/TLS public fixture `am instrument` methods | **2 PASS** repeat executions; only public output extracted by dedicated-package run-as |
| `cargo test --lib actual_android -- --ignored --test-threads=1` with fresh fixture environment paths | **2 PASS**: Keystore application signature -> Windows CNG, Keystore TLS CertificateVerify -> ring on Windows |
| JBR `javac --release 8` / `IdentityFormatHostTest` with CNG/JCA/fresh Android public fixtures | **91 checks PASS**, host-only JCA; source/target8 deprecation warnings |
| Dedicated test APK `adb shell am start -W` after force-stop | PASS: Status ok, LaunchState COLD |
| Default `npm run tauri -- android build --debug --target x86_64 --apk --ci` | PASS: actual default Rust/Gradle/debug APK, no qualification feature; generated test application suffix removed |
| NDK `llvm-nm --dynamic --defined-only` on default x86_64 native library | PASS: security bootstrap install exported; no NativeIdentityBridgeTest/NativeIdentityRestartTest entrypoints |
| Final `verify-isolation.ps1` after default build | PASS: same four graph controls; emulator inventory empty after task-owned shutdown |

Source review and executed tests leave **N1 blocked**. External review must decide
the exact maintained implementation, current audit/dependency scope, six-digit
model, registration/cleanup, two-process final confirmation, initial key/channel
binding and durable human intent. The packet's accept/reject criteria do not
waive the advisory. **No independent audit or N1 approval occurred.** N2/N3/N7
and G4–G7 remain unapproved, and E3B does not start.

Production remains **schema9, dormant M05, ClosedTrust, PAKE/TLS/LAN CLOSED**,
without a production VerifiedSession constructor, live enrollment or second
SQLite owner. G4 UnverifiedBounds and frozen journal/reducer/codec/snapshot2/D4/
public routing remain unchanged. **UNVERIFIED:** ARM64, physical Android,
successful release packaging, hardware certification and live mixed-platform
enrollment. Emulator/JCA/negative release results do not stand in for these.

Changed files (all native paths below are relative to `apps/arthur/src-tauri`):

- `src/sync/security/composition.rs`: reservation binding and pending-v2 metadata.
- `src/sync/security/pake_qualification.rs`: explicit same-process oracle warning.
- `src/storage/enrollment_store.rs`: exact reservation check at lab handoff.
- `src/storage/security_pake_tests.rs`: red/green replay regression, reservation substitution and existing helpers updated.
- `src/storage/security_tls_tests.rs`: public reservation fixture metadata.
- `src/storage/security_android_instrumentation.rs`: native scenario28.
- `gen/android/app/src/androidTest/java/dev/kaloyan/arthur/security/NativeIdentityBridgeTest.java`: scenario28 JUnit entry.
- `src/sync/security/qualification/verify-isolation.ps1`: four locked graphs with positive controls.
- `src/sync/security/qualification/e3a3-advisories.json`: current unresolved OSV snapshot.
- `docs/architecture/m05-n1-external-review.md` (repository root): standalone external packet.
- `docs/architecture/m05-activation-readiness.md` (repository root): this qualification/evidence snapshot.

## 21. MEGA N7A dormant LAN route policy and bounded transport (2026-10-24)

**PARTIAL. N7PolicyPending and N1_AUDIT_PENDING remain.** Baseline
`dea10e2624271036d76a9e8308d94d7786195a23`, feature/nodes-integration.
The [N7A foundation contracts](m05-n7a-foundation.md) record the pre-implementation
architecture answers, exact candidate behavior, limitations and owner decisions.
No socket, resolver, native route/permission acquisition, firewall modification,
new permission, target-SDK reduction or frontend networking/signing API is added.

### Implementation and changed contracts

- `sync/security/route_candidate.rs`: bounded manual/discovery Hint parsing,
  numeric/DNS distinction, typed interface/route/permission observations, fresh
  generation/path selection, pre-/post-connect revalidation and permanently
  closed candidate activation. Windows/Android live observation stubs both
  return N7PolicyPending.
- `sync/security/transport_candidate.rs`: bounded admission/permits, rolling
  retry history, wakeable cancellation, handshake lifecycle guard and incremental
  nonblocking framed I/O with deadlines/drop cleanup. Expected network/peer
  metadata is explicitly NOT authentication. No AuthenticatedTransport or
  VerifiedSession implementation is added.
- `sync/security/transport.rs`: ClosedLan uses bounded Hint validation and still
  refuses dial/listen; selected_route() still always refuses N7. Legacy blocking
  read_exact parser and original simple ResourcePool/Lease are now cfg(test)
  finite regression fixtures, excluded from ordinary/Android feature runtime.
- `sync/security/n7a_tests.rs` and module registration: deterministic route,
  partial-I/O, waker/timer/concurrency and closed-boundary tests; shared Android
  scenario29 runs these with a real disposable owner and verifies no SQL changes.
- `storage/enrollment_store.rs` and `security_pake_tests.rs`: actual qualification
  rejection erases code and cancels only the exact submitted reserved ticket;
  stale ticket cannot cancel the newer reservation. Counters never decrease.
  Existing Android case28 runs the strengthened lifecycle regression.
- `storage/security_android_instrumentation.rs` and Android
  `NativeIdentityBridgeTest.java`: scenario29 test entry only; no main Java/JNI
  signing/permission surface added.
- This readiness section and `m05-n7a-foundation.md`: review/evidence packet.

Manual input rejects URL/scheme/userinfo/path/query/fragment injection, whitespace,
malformed/numeric-ambiguous IPs, unsupported zones, invalid/noncanonical ports,
wildcards, loopback, multicast/broadcast and IPv4-mapped IPv6. ASCII length <=128;
DNS is only an untrusted parsed hint and always pending evaluation policy, never
resolved or passed to a socket. No address can grant membership, disable native
TLS verification, enumerate a registry or authorize ingress.

Candidate policy accepts for classification only explicit fresh direct Wi-Fi/
Ethernet routes with matching selected/actual interface, source subnet, family,
destination prefix and exact endpoint. IPv4 private address alone is insufficient;
gateway/default/public/VPN/cellular/unknown paths refuse. IPv6 ULA and scoped
link-local are classified, with nonzero numeric scope equal to selected interface.
IPv4 subnet endpoints and /31-/32, public on-link IPv6, IPv4 link-local and DNS
remain refused/pending owner policy. Revalidation rejects generation/interface/
route/endpoint/permission changes and mismatching connected local/remote addresses.
Fake observations are not evidence about physical route selection or OS authority.

### Resource safety and review findings

| Candidate budget / contract | Rationale and limits of evidence |
| --- | --- |
| 2 concurrent handshakes / 1 established session, one active expected network+peer | Bound pre-crypto admission and prevent same-key reconnect concurrency; proposed values only, not approved N7 or a change to Sync negotiation |
| Four admissions in rolling 30s per pool | Bounded four-timestamp history, no untrusted-peer map/queue; cancellation/drop does not refund, changing keys cannot bypass that pool's throttle. Future runtime coordinator must own ONE shared pool; no live pool is installed and no multiple-pool process-wide bound is claimed. Restart resets this availability throttle, not the durable enrollment ledger |
| 64KiB record plus 8-byte header; one frame in flight | Header checked before allocation, no oversized body read; no partial message delivery. Send temporary input plus output can peak at about 128KiB logical bytes, not a physical allocator/TLS memory certification |
| Handshake10s / idle15s / total60s from admission | Monotonic timer wake contract; only COMPLETE frames refresh idle, total never extends; partial slow-drip bytes, backwards time and timeout fail closed |
| Nonblocking read/write + readiness wake + synchronous abort | One operation/poll with bounded buffers; cancellation and timer wake pending work, failure/drop abort I/O and release admission. No claim that the old blocking read_exact could interrupt kernel I/O |
| Shutdown | Permanently close this pool, wake all active handles, refuse new admission; next awakened poll/drop aborts resources |

Underlying TLS/OS/Argon2 allocations, actual handshake-byte accounting, OS readiness
and timer registrations remain future adapter responsibilities. The lifecycle
guard is NOT a TLS handshake implementation. Returned payload retention belongs
to the future consumer; no global application-memory bound is claimed. A live
adapter requires measured limits, coalesced timer registrations/cleanup and
actual socket shutdown/cancellation tests; no such adapter is installed.

Two reproducible findings were corrected without weakening expectations:

1. **Important: qualification rejection retained reserved state/code.** The
   strengthened E3A3 regression failed before the owner fix and passed afterward.
   It verifies exact-ticket terminal cleanup, stale-ticket isolation, no grant,
   no budget refund and persistent count2 after restart/new issuance. SQLite
   cleanup failure returns Storage, never false cleanup success; memory code is
   already erased, durable recovery uses existing cancel/startup when storage
   works. No protocol/cryptographic change or new SQL owner/schema.
2. **Important: dropped stream retained task waker through an external cancellation
   handle.** New weak-reference regression failed before Permit Drop cleared its
   registration, then passed. Drop marks it cancelled and retires the waker
   outside both mutexes to avoid executor teardown reentry while locked.

Review of the final candidate found no additional correctness/data-loss issue
within these pure contracts. This is internal engineering review, not independent
security approval. Actual native route/TLS/I/O integrations are not covered by
fake tests and remain BLOCKED.

### Platform readiness and explicit N7 decisions

Windows IP Helper/interface classification, selected-route/socket binding and
private-profile executable-scoped firewall/listening-port policy are abstractions
only. Android remains future dialer, Desktop listener. Native NSD/manual fallback
is specified but unimplemented; discovery addresses are expiring untrusted hints,
never identities. Android target SDK37 permission/picker requirements were checked
against [official guidance](https://developer.android.com/privacy-and-security/local-network-permission)
and [NsdManager](https://developer.android.com/reference/android/net/nsd/NsdManager).
Denial/revocation must invalidate the route and cancel work; no automatic fallback
to public/VPN/cellular routing, permission requests or firewall changes occur.
API36 emulator execution cannot certify API37 permission enforcement.

Owner/security must decide allowed interfaces/ports/profiles, IPv4 link-local and
public on-link IPv6/subnet/scope behavior, DNS resolution/rebinding and native
NSD/picker/manual policy, permission UX and lifecycle, approved concurrency/frame/
handshake-memory/time/retry limits, timer/socket abort integration and actual
multi-homed/roaming/firewall evidence. N7 is NOT self-approved.

Production remains **schema9, dormant M05, ClosedTrust, PAKE/TLS/LAN CLOSED**,
without live enrollment, public listener/dialer, production VerifiedSession,
second SQLite owner or frontend network/signing interfaces. G4 UnverifiedBounds
and frozen journal/reducer/codec/snapshot2/D4/public writer routing are unchanged.
N1/N2/N3/N7 and G4–G7 remain unapproved. **E3B has NOT started.**

### N7A executed verification

Commands use locked offline Cargo manifest `apps/arthur/src-tauri/Cargo.toml`
and sequential native execution `-- --test-threads=1`. Baseline focused legacy
resource test passed before edits. The first full run after initial implementation
was 1367 PASS / same5 FAIL /25 ignored; the waker regression was then added red,
fixed and the full run repeated for the final resource implementation.

| Gate / executed command | N7A result |
| --- | --- |
| Pre-change `cargo test --lib e18_metadata` | PASS |
| Qualification terminal-cleanup regression | FAIL before correction; PASS after; included in full E3A3 regression and Android case28 |
| Waker-retention regression | FAIL before correction; PASS after; weak reference proves dropped task registration is released even while cancellation handle survives |
| `cargo test --lib n7a` | **11 PASS**, deterministic routes/I/O/concurrency plus real disposable owner no-side-effect check |
| Final `cargo check --all-targets` | PASS |
| Final `cargo test --lib` | FAIL: **1368 PASS / same 5 historical FAIL /25 ignored**, 246.03s; accepted baseline 1357/5/25 |
| Security / Sync / Journal / dormant-v10 name groups from full run | **56/142/287/24 PASS**, 1/1/1/0 ignored; overlapping groups, not extra executions |
| E2 / TLS / E3A2 / E3A3 groups from full run | **22/8/11/1 PASS**; E2/TLS each have 1 ignored device-fixture interoperability test |
| `qualification/verify-isolation.ps1` | PASS: default Windows/Android normal/build graphs exclude PAKE qualification packages; Windows dev / Android feature graphs include them as positive controls |
| `npm run typecheck` | PASS |
| `npm run test:architecture` | FAIL: **86 PASS / same 2 historical FAIL**, schema-v6 project ownership and M04.6 voice-output DTO source assertions |
| `npm run arthur:check` | PASS: **561 tests /42 files**, frontend typecheck/Vite production build; existing chunk-size warning |
| Actual Android release build with android-identity-tests | PASS expected rejection: Rust exit101 / CLI exit1; both explicit instrumentation/PAKE compile_error guards observed. Same eight secondary missing debug-only slot methods in forbidden configuration as E3A3; no successful release packaging claim |

The five failure identities match accepted E3A3: JEV real transport error
classification, two synthesis architecture assertions, frozen synthesis corpus
and synthesis commit-time authorization source check. **No new native regression.**
Official RFC vectors, Cargo manifest/lock, migration9, Android permissions,
frozen Sync protocol/codec and journal source are unchanged.

Android used the task-owned read-only Medium_Phone_API_36.1 emulator,
**API36 / Android16 / x86_64**, SDK37/NDK29.0.14206865/JBR21.0.9.

| Additional executed gate | N7A result |
| --- | --- |
| `gen/android/verify-identity.ps1 -Serial emulator-5554` | PASS: actual Rust/Java/Kotlin/debug APK; **36 instrumentation**, fresh XML **0 failures /0 errors /0 skips**, and **2 separate process-restart invocations PASS** |
| N7A Android scenario29 | PASS, all ten pure route/resource scenarios plus real disposable-owner SQL-change/schema9 check; fake routes/I/O, not physical LAN |
| Strengthened Android E3A3 case28 | PASS: stale ticket isolation, terminal rejection cleanup and charged budget retained across startup |
| Explicit public E2/TLS fixture methods via `am instrument` | **2 PASS** repeat executions, fresh public-only output from dedicated package |
| `cargo test --lib actual_android -- --ignored --test-threads=1` | **2 PASS** using those fresh fixtures: application signatures CNG verification / TLS signatures ring verification on Windows |
| Host JBR `javac --release 8` / `IdentityFormatHostTest` | **91 checks PASS**, CNG/JCA/fresh Android public fixtures; host-only, existing source/target8 warnings |
| Dedicated test APK cold start after force-stop | PASS: Status ok, LaunchState COLD |
| Default `npm run tauri -- android build --debug --target x86_64 --apk --ci` | PASS: actual default Rust/Gradle/debug APK, test application suffix removed |
| NDK `llvm-nm --dynamic --defined-only` on default native library | PASS: security bootstrap install exported; no BridgeTest/RestartTest JNI entrypoints |
| Final dependency isolation / formatter / diff checks | PASS: four graph controls after default build; scoped candidate/owner/test Rust formatter and git diff checks; no emulator remains |

**UNVERIFIED / live implementation BLOCKED:** actual Windows/Android route
acquisition and socket binding, real IPv4/IPv6 LAN or mixed-device sessions,
VPN/cellular/multi-homed/roaming route changes during connect, AP isolation and
firewall behavior, API37 permission denial/revocation and NSD picker/manual
integration, prompt kernel read/write cancellation, real TLS handshake-memory/
byte/deadline bounds, ARM64, physical-device and successful release packaging.
Fake observations, API36/JCA execution and negative release rejection do not
establish those properties. N1/N7 approval remains pending independently of all
passing foundation tests; production entrypoints remain CLOSED.

## 22. MEGA N7B — native observations and dormant owner coordination

**PARTIAL — implementation/evidence do not approve N7 or N1.** Accepted N7A
baseline is `f34a1811530514078d58db66342a1d5b8882e8b6`, on existing
`feature/nodes-integration`. The [N7B contract](m05-n7b-native-observation.md)
contains the pre-implementation ten architecture answers, exact OS APIs,
ownership/order/cleanup rules, platform differences and remaining decisions.
It supersedes section21's missing native observation/coordinator implementation
statements; section21's results remain a historical N7A snapshot.

### Implemented scope and security findings

- Read-only Windows GetBestRoute2/GetAdaptersAddresses/GetIfEntry2 adapter, selected
  source/interface/LUID/prefix/route/next-hop/up metadata, conservative physical
  medium mapping and exact adapter-GUID NLM network-category lookup. Bounded
  buffers/iterations and repeated route/interface/profile reads refuse ambiguity
  and changes. No interface/profile is accepted merely from RFC1918/IfType.
- Read-only Android Application-context ConnectivityManager/NetworkCapabilities/
  LinkProperties adapter through existing JNI attach/local-frame/exception rules.
  Reports permission/no-network/stale/incomplete categories and selected Network
  handle where available. The shipped manifest lacks ACCESS_NETWORK_STATE; no
  permission/SDK change or prompt is introduced. Local LinkProperties addresses
  explicitly lack OS-selected-source evidence, keeping eligibility pending.
  API37 broad permission and NSD picker grants remain separate; no picker exists.
- Exactly one passive coordinator/pool per NativeRuntime, reused on Arc
  reacquisition. No production Default pool constructor. Private owner-bound
  consumed tickets and Selection identity, checked monotonic generations,
  invalidation before every acquisition, stale/foreign completion refusal and
  admission revalidation. No automatic worker, callbacks, resolver or socket.
- Caller Interrupt is the same cancellation handle owned by the permit.
  Invalidation/shutdown flags active work before executor callbacks; shutdown,
  poisoned shutdown, generation overflow, coordinator/runtime Drop and races
  cannot reopen admission. Existing 2/1/4-per30s/expected-peer limits and bounded
  frames/deadlines remain candidate policy, without cancellation refunds.
- **Important lifecycle defect, reproduced RED then GREEN:** N7A stale-ticket
  rejection erased the in-memory Challenge while a newer reservation remained
  reserved. Cleanup now preserves a still-issued/reserved current-boot same
  challenge if no exact-ticket row was cancelled. Terminal/successful cleanup
  erases it; unrelated reservations and charged counters are untouched. A new
  actual debug TLS/OPAQUE proof can finish against the newer ticket. Original
  old-proof/new-ticket rejection remains enforced; restart cancels pending
  qualification state without refund or grant.
- **Important lifecycle gaps hardened:** Timer registrations are now owned RAII
  objects and are removed on transition, completion, failure and Drop. Replacing
  an Interrupt waker drops the old executor object outside its mutex; a reentrant
  destructor test checks this. Fake I/O abort also removes its wake. Native
  encrypted I/O/timer adapters remain absent, so no kernel cancellation claim.

### Actual OS evidence versus simulation

Actual Windows acquisition is a separate IP Helper/NLM test. Actual Android
permission evidence is a separate Java plus Rust/JNI instrumentation case;
synthetic route/generation/I/O tests are labelled fake. Neither proves LAN
reachability, mixed-platform transport, continuous OS event handling or API37
permission enforcement.

Android environment: task-owned read-only `Medium_Phone_API_36.1`, Android16 /
**API36 /x86_64**, fingerprint
`google/sdk_gphone64_x86_64/emu64xa:16/BE4B.251210.005/14574095:user/release-keys`.
Build remains SDK37, NDK29.0.14206865, JBR21.0.9, dedicated identitytest package.
Exact final gate results are recorded below after execution.

### Remaining N7 blockers

Native route/profile/permission change subscriptions are not installed. Explicit
refresh invalidates before the next snapshot; <=3s freshness and repeated reads
are not continuous monitoring or proof against unobserved OS ABA changes.
Actual DHCP/roaming/disconnect/reconnect/VPN/multi-homed callbacks, real scoped
IPv6 selection, API37 permission denial/revocation, NSD grants, socket binding,
physical LAN/mixed-device sessions and prompt kernel read/write/timer cancellation
remain UNVERIFIED. Android active-network/link/source facts are blocked by missing
permission and lack of selected-socket-source proof. Windows classification and
NLM profile never imply an open firewall port or authorization. OS/COM snapshot
calls are synchronous; their in-flight cancellation is not implemented.

Owner/security review still must approve interface/profile/port/firewall policy,
Android permission/NSD UX and background behavior, IPv4 link-local/public-onlink
IPv6 and /31-/32 handling, measured TLS memory/handshake byte limits, timers,
retry fairness/backoff and actual event-bound nonblocking adapters.

**Preserved:** production schema9, dormant M05, ClosedTrust, PAKE/TLS/LAN CLOSED,
no production VerifiedSession/live enrollment/listener/dialer/frontend signing or
network API, one existing SQLite owner, G4 UnverifiedBounds, frozen journal/codec/
reducer/snapshot2/D4. OPAQUE is not replaced by SPAKE2. N1/N2/N3/N7 and G4-G7
remain unapproved; **N1 is still blocked and E3B has not started**. Local gates do
not establish hosted CI, ARM64, physical-device or successful release packaging.

### Final Windows/local verification

All Cargo commands use `--locked --offline --manifest-path
apps/arthur/src-tauri/Cargo.toml`; native tests use `--lib -- --test-threads=1`.
The first full run was 1378/5/25 (493.52s, emulator/compilation resource overlap).
After final source/profile/lifecycle changes the full suite was repeated on the
final implementation: **1378 PASS /same5 FAIL /25 ignored, 274.35s**.

| Executed gate | N7B result |
| --- | --- |
| Stale-ticket/new-reservation regression | RED on N7A (1 failed); GREEN after exact-ticket memory/durable cleanup correction, Windows and Android evidence below |
| Final `cargo check --all-targets` with locked dependencies | PASS |
| Final `cargo test --lib n7 -- --test-threads=1 --nocapture` | **21 PASS**, including actual Windows IP Helper/NLM test; synthetic tests are separate names/modules |
| Final full `cargo test --lib` | FAIL: **1378 PASS /same5 historical FAIL /25 ignored**, accepted baseline1368/5/25; ten new passing tests |
| Security / Sync-name / Journal / dormant-v10 groups in full run | **60/146/287/24 PASS**, 1/1/1/0 ignored; overlapping groups, not additional executions |
| E2 / TLS / E3A2 / E3A3 groups in full run | **22/8/11/1 PASS**; E2/TLS each have one ignored actual-device-fixture test, separately executed below |
| `qualification/verify-isolation.ps1` | PASS, four actual resolved graphs: default Windows/Android exclude opaque-ke/argon2/crypto-bigint; Windows dev and Android feature positive controls include them |
| `npm run typecheck` | PASS |
| `npm run test:architecture` | FAIL: **86 PASS /same2 historical FAIL**, schema-v6 project ownership and M04.6 voice-output DTO source assertions |
| Frozen-source diff against N7A | PASS: manifest, production migrations, journal and Sync codec/protocol unchanged |

The five full-native failures are the same JEV Timeout-versus-Network assertion,
two synthesis architecture assertions, frozen synthesis corpus hash and synthesis
commit-time authorization source assertion listed in section21. No assertion or
fixture was weakened to suppress them. Cargo.lock adds only direct references to
already-resolved windows0.62.2/windows-sys0.61.2; no package version/crypto change.

The final actual Windows test acquired OS source/index/LUID/subnet metadata,
**Wi-Fi /Up /Public category0 /local prefix24 /selected default route prefix0 /
gateway next hop**. This observation is ineligible for direct-LAN classification;
no successful Candidate or reachable peer/port is claimed. Address values and
network names are deliberately not logged. NLM profile observation is distinct
from an inferred physical-medium classification and firewall reachability.

| Additional frontend gate | N7B result |
| --- | --- |
| First `npm run arthur:check` | FAIL: 560 PASS /1 failure in unchanged EvolutionScreen deterministic-diff test (`Body changes` absent at assertion); build did not execute after that failure |
| Focused unchanged `EvolutionScreen.test.tsx` rerun | **14 PASS**, no source/expectation edits |
| Full `npm run arthur:check` rerun | **561 PASS /42 files**, app typecheck and Vite production build PASS; existing >500KiB chunk warning |

The initial frontend refusal is retained as transient test evidence, not removed
from this report. No frontend source was changed; the standalone and complete
reruns passed. It is not included among the five historical native/two architecture
failures, nor claimed to be a newly fixed UI defect.

### Executed Android, interoperability and negative release gates

| Executed gate | N7B result |
| --- | --- |
| `gen/android/verify-identity.ps1 -Serial emulator-5554` | PASS: actual feature-enabled Rust/Java/Kotlin/dedicated debug APK and instrumentation; **39 tests /0 failures /0 errors /0 skips**, fresh XML timestamp2026-10-24T18:40:46Z; both separate process-restart invocations `OK (1 test)` |
| Actual N7B Android OS/JNI case32 | PASS: target Application's OS permission check returns PERMISSION_DENIED; Java and Rust/JNI return MissingPermission. This verifies the refusal boundary, **not successful ConnectivityManager route acquisition** |
| Android cases29/31 | PASS: fake routes/I/O/timers/generations/concurrent admission and disposable real-owner SQLite no-effect/schema9 checks; not actual OS route transitions |
| Android case30 plus preserved case28 | PASS: actual Keystore/TLS/OPAQUE debug qualification proves newer-ticket code remains usable, old-confirmation substitution stays rejected, counters/startup recovery remain correct |
| Explicit public E2/TLS fixture instrumentation repeat | **2 PASS**, fresh public-only fixtures from the dedicated test package |
| Windows `cargo test --lib actual_android -- --ignored --test-threads=1` with fresh fixture environment variables | **2 PASS**: actual Android application/TLS signatures verified on Windows; not a LAN session |
| JBR `javac --release 8` and `IdentityFormatHostTest` | **91 host-only JCA checks PASS**, CNG/JCA/fresh Android public fixtures; existing source/target8 warnings |
| Dedicated test APK force-stop /`am start -W` | PASS: Status ok /LaunchState COLD; production app not overwritten |
| Actual `tauri android build --target x86_64 --apk --ci --features android-identity-tests --config src-tauri/gen/android/identity-tests.tauri.json` | Expected rejection PASS: CLI exit1/Cargo101, both explicit `android-identity-tests is forbidden in release builds` and `PAKE qualification is forbidden outside debug instrumentation` observed |

The forbidden release configuration also reports the same eight secondary
missing debug-only slot-method errors seen in N7A/E3A3 (ten errors including the
two guards). This is not a successful release packaging claim or an environmental
failure substituted for those guards. The task-owned read-only emulator was
stopped after the dedicated APK/public-fixture checks; no physical device ran.

| Final default/isolation gate | N7B result |
| --- | --- |
| `tauri android build --debug --target x86_64 --apk --ci` without test feature/config | PASS: actual default native/Gradle/debug APK build |
| NDK `llvm-nm --dynamic --defined-only` on final default `libarthur_lib.so` | PASS: exactly one `Java_dev_kaloyan_arthur_security_*` export, bootstrap `NativeIdentityBridge_install`; no BridgeTest/RestartTest JNI exports |
| Generated default Gradle file /AndroidManifest diff against HEAD | PASS: unchanged after supported default build restored the temporary dedicated-test suffix |
| Final four dependency graph controls | PASS, repeated after default build |
| Scoped Rust `rustfmt --check` /`git diff --check` | PASS; no global formatting claim for unrelated historical files |
| `adb devices` after task cleanup | No running task emulator remains |

Raw local evidence is retained under `%TEMP%/arthur-n7b-*.log` (red, final-focused,
final-native, locked-check, architecture, frontend/frontend-rerun, android,
interop, negative-release and default-android); graph controls are under
`%TEMP%/arthur-n7b-final-isolation`. Public-only fixture exports and host classes
are temporary, not repository artifacts. No keys, databases, APKs or raw logs
are committed. These are local results, **not hosted CI**.

**Delivery status: MEGA N7B PARTIAL.** Read-only observations, runtime ownership,
explicit generation invalidation and debug qualification cleanup are implemented
and locally verified within the stated limits. Live native change subscriptions,
Android positive route/source acquisition, actual sockets/timers/abort, API37,
ARM64/physical devices and successful release packaging remain UNVERIFIED or
blocked. The five native/two architecture historical failures and the initial
transient frontend failure are explicitly retained above. N1 remains blocked,
N7PolicyPending remains enforced and E3B has not started.

## 23. MEGA N7C — event-driven monitoring and fresh validation (2026-10-24–25)

Scope: accepted N7B `0e349a9b1f909995bbba19a794ef95fc99a613e4`, existing
`feature/nodes-integration`. See [N7C platform-monitoring contract](m05-n7c-platform-monitoring.md)
for the ten architecture answers, API contracts, ownership, failure semantics,
security review and Android evidence-level separation. This is dormant foundation
work, not N7 approval. Schema9, ClosedTrust, PAKE/TLS/LAN CLOSED, no live enrollment,
no production VerifiedSession, no listener/dialer, no frontend networking/signing
API, no new SQLite owner and G4 UnverifiedBounds are preserved. N1/N2/N3/N7 and
G4–G7 remain unapproved; N1_AUDIT_PENDING and N7PolicyPending remain. E3B has not started.

### Implementation and review evidence

Windows explicitly owns AF_UNSPEC NotifyRouteChange2, NotifyIpInterfaceChange,
NotifyUnicastIpAddressChange handles and an NLM INetworkEvents connection point.
The dedicated MTA worker performs registration/cleanup; callbacks only advance an
atomic epoch and coalesce a capacity-one notification. Profile/category, address,
interface and route changes revoke eligibility. No callback reads routes, enters
COM/SQLite or invokes an executor. CancelMibChangeNotify2/Unadvise run outside
coordinator/pool locks; cancellation failure retains an inert raw context and
quarantines new subscriptions rather than risking use-after-free.

Android uses Application-owned ConnectivityManager.registerDefaultNetworkCallback
for available/lost/capabilities/link-properties/blocked-state invalidation. JNI
uses at most16 weak signal entries and monotonically unique opaque tokens; no
raw runtime pointer or Activity is retained. Revocation/token removal precedes
Java unregister, and late tokens cannot revive a registration. Failed registration
or cleanup refuses; missing production ACCESS_NETWORK_STATE remains MissingPermission.
The standalone debug-only qualification project is absent from default settings
and has no release variant. It does not approve API37 LAN permissions or picker policy.

Production admission now requires native selection provenance plus an active
registration fence, a fresh exact-endpoint native read outside owner/pool locks,
full route/source/network/profile/permission comparison, and owner revision/event
fence/cancellation/shutdown rechecks around reservation in the same Pool. Failed
refresh clears the matching old generation; it cannot erase a newer selection or
fall back to cached eligibility. Events invalidate permit fences immediately,
then deferred dispatch cancels/wakes waiters outside locks. Rolling limits are
not refunded. Construction stays passive; runtime reacquisition shares monitoring
and final teardown revokes and unregisters it. Reentrant worker shutdown revokes
synchronously and unregisters after dispatch returns, without self-join.

**RED→GREEN:** `n7c_synthetic_selection_cannot_admit_via_production_path` failed on
accepted cached admission (0PASS/1FAIL, `%TEMP%/arthur-n7c-red.log`), then passed with
native provenance/fresh-read enforcement. Existing synthetic tests retain their
checks through named private test/debug-only completion/admission seams. New
regressions cover changed source/route/interface/network/profile/permission/VPN,
failed OS refresh, cancellation/shutdown/replacement/event races, immediate permit
revocation, stale registrations, no-refund history, duplicate/reordered events,
bounded delivery and epoch overflow. Existing waker/timer/no-store/provider/trust
regressions remain passing. A test-development failure initially counted five
reservations in the four-attempt window; correcting the test setup to four
preserved the limit and passed. No production security expectation was weakened.

Separate self-review corrected permit/waker destruction under the owner lock,
cleanup skipped by poisoned-pool error short-circuits, stop/start signal detachment,
terminal dispatch/wakeup and JNI-allocation cleanup after Java registration. These
are implementation review corrections, not separately reproduced baseline defects.
No external independent security audit is claimed.

### Executed local gates

Resource-heavy gates ran sequentially. Group counts below overlap the full native
suite and are not additional executions. No hosted CI claim is made.

| Gate / command | N7C result |
| --- | --- |
| `cargo check --locked --offline --all-targets` (app manifest) | PASS |
| `cargo test --locked --offline --lib -- --test-threads=1` | **1386 PASS /same5 historical FAIL /25 ignored**, 280.51s in final delivery rerun; +8 PASS versus accepted N7B |
| `cargo test --locked --offline --lib n7 -- --test-threads=1` | **29 PASS**, +8 versus21; no ignored/failures |
| Security /Sync-name /Journal /dormant-v10 groups | **63/149/287/24 PASS**, 1/1/1/0 ignored |
| E2 /TLS /E3A2 /E3A3 groups | **22/8/11/1 PASS**; E2/TLS actual-Android public-fixture cases separately ignored in full native run |
| `npm run typecheck` | PASS |
| `npm run test:architecture` | FAIL: **86 PASS /same2 historical FAIL**, schema-v6 project ownership and M04.6 voice-output DTO source assertions |
| `npm run arthur:check` | PASS: **561 tests /42 files**, app typecheck and Vite production build; existing >500KiB chunk warning |

The same five native failures are JEV Timeout-versus-Network, the two synthesis
architecture assertions, frozen synthesis corpus hash and synthesis commit-time
authorization assertion already retained in section22. New failures: **none in
these final gates**. EvolutionScreen's N7B transient failure did not recur; no
frontend source or expectation was edited. The initial N7C focused run had a
new-test setup error noted above; the corrected focused/full runs passed it.

Windows actual integration executed all three OS InitialNotification callbacks,
real NLM Advise/Unadvise, repeated subscribe/stop/restart/final destruction and
native IP Helper/NLM route acquisition. Initial notifications are not manufactured
route changes. Actual host route/profile/VPN transition scenarios are **NOT TESTED**;
deterministic epoch/fact mutations are documented separately as simulated tests.

### Android, interoperability and artifact evidence

| Gate / command | N7C result |
| --- | --- |
| `gen/android/verify-identity.ps1 -Serial emulator-5554` | PASS: actual Rust/Java/Kotlin/dedicated debug APK; **40 instrumentation /0 failures /0 errors /0 skips**, final XML2026-10-24T22:01:21Z; **2 separate process-restart PASS** |
| New actual Android case33 /preserved case32 | PASS: callback registration and route acquisition both return MissingPermission through JNI with the ordinary dedicated manifest lacking ACCESS_NETWORK_STATE |
| `gen/android/verify-network.ps1 -Serial emulator-5554` | PASS on rerun: standalone debug build, checked dedicated package ids, ACCESS_NETWORK_STATE present only here, release variant/task absent; **2 actual instrumentation PASS** |
| Standalone actual acquisition/callback tests | PASS: actual NetworkCapabilities/LinkProperties snapshot, default-network onAvailable/onCapabilitiesChanged/onLinkPropertiesChanged delivery through Java→Rust, unregister/idempotent cleanup and native weak-reference release. Explicit late-token injection is a deterministic rejection test, not an OS-generated late callback |
| Android evidence levels | A MissingPermission PASS; B actual read-only facts PASS in isolated app; C OS-selected source **NOT ESTABLISHED** (`source_selected=false`); D LAN approval **PENDING**, Candidate refuses |
| Fresh public fixture instrumentation repeat | **2 PASS**; public E2/TLS fixtures exported only from the dedicated test package |
| Windows `cargo test --lib actual_android -- --ignored --test-threads=1` using fresh fixture env vars | **2 PASS**, actual Keystore application/TLS signatures verified on Windows; no LAN session |
| JBR `javac --release 8` /`IdentityFormatHostTest` | **91 host JCA checks PASS**, CNG/JCA/fresh Android public fixtures |
| Dedicated Tauri test APK force-stop /`am start -W` | PASS: Status ok /LaunchState COLD; production package not installed/overwritten |
| Actual forbidden-feature release build | Expected refusal PASS: CLI1/Cargo101, both explicit release guards; same8 secondary missing debug-only slot-method errors, ten errors total; **not successful release packaging** |
| Default Android debug APK | PASS from supported Tauri build; final artifact/isolation results below |

Environment: actual Android emulator, **API36 /x86_64 /Android16**,
`google/sdk_gphone64_x86_64/emu64xa:16/BE4B.251210.005/14574095:user/release-keys`.
The standalone project contains no Activity and actual callbacks still worked;
this supports Application ownership but does not claim an executed Activity-
destruction race. No API37, physical device, ARM64 or connected-source evidence.
The task-owned emulator was stopped after fixtures/OS qualification and before
remaining host/build gates. No dummy socket or host network change was used.

The first standalone build passed but installation refused VERSION_DOWNGRADE
because its versionCode1 was below the dedicated Tauri app's1000. The isolated
project was corrected to1000; both checked test-package installs and both tests
then passed. This setup failure is retained in `%TEMP%/arthur-n7c-android-network.log`,
with the successful rerun in `arthur-n7c-android-network-rerun.log`. No production
permission, package, signing identity or test expectation was changed to bypass it.

A final review also found that an already closed monitor with a retained handle
could report a successful idempotent `start_monitor`. It now returns a typed
Unavailable; the actual Windows lifecycle test explicitly closes that registration
and asserts refusal. It also injects a poisoned owner mutex and verifies that explicit stop releases the native registration and returns State, with no join under owner/control locks. Final review moved the last permit cancellation/fence check after unlocking. Locked check, focused and full native gates were repeated
for this correction; Android default APK is rebuilt for the final source. Android 40+2 runtime and standalone2 gates were repeated successfully after the final shared-owner corrections. The instrumented library also contains the final native quarantine registry (confirmed by its DWARF Registry member alongside the weak Signal map). JNI allocation and cancellation failure injection remain NOT TESTED; no error-path runtime PASS is inferred from binary presence.

A repeated full run (before the final poisoned-stop correction) reported
**1385 PASS /6 FAIL /25 ignored**, 292.82s: the five historical failures plus
newly observed `tts::service::tests::the_system_taking_audio_focus_ends_the_session_as_stopped_not_failed`.
Its assertion saw one temporary audio file after Idle instead of zero. The TTS
source is unchanged; its cancellation branch publishes Idle before the local
TransientFile destructor removes the file, which explains a timing-sensitive
assertion window (source review inference, not an N7C fix). The isolated unchanged
test rerun passed1/1. This failure is retained separately from the historical five,
not discarded or relabeled as an approved baseline failure.

The poisoned-stop regression initially returned PlatformUnverified instead of
State when the worker independently observed the poisoned owner and marked its
signal failed (focused28PASS/1FAIL). Stop now consistently preserves the root
State error after completing cleanup; the assertion is unchanged and final
focused29PASS includes this case. The superseded full run launched immediately
after that failed focused gate was stopped; it is not counted as a completed
suite. No TTS or security expectation was weakened. Final full results follow.

| Final artifact / closure gate | Result |
| --- | --- |
| Final native rerun, `arthur-n7c-delivery-native.log` | **1386 PASS /same5 historical FAIL /25 ignored**, 280.51s; TTS focus-loss test PASS in this full rerun as well as its standalone rerun |
| Final focused /locked check | **29 PASS**, including terminal-registration status and poisoned-state cleanup; final all-targets locked/offline check PASS |
| Final Android runtime repeat | **40 instrumentation +2 restart PASS**; final standalone positive OS acquisition/callback repeat **2 PASS**; no skipped/errors/failures |
| Final forbidden-feature release repeat | Expected CLI1/Cargo101 refusal; both explicit guards and same8 secondary errors; no release packaging claim |
| Final `tauri android build --debug --target x86_64 --apk --ci` | PASS: actual Rust/Java/Kotlin/Gradle/default APK from final source |
| APK `apkanalyzer manifest application-id/permissions` | PASS: `dev.kaloyan.arthur`; existing INTERNET, RECORD_AUDIO and app-scoped dynamic-receiver permission only; **no ACCESS_NETWORK_STATE** |
| `:app:processX86_64ReleaseMainManifest -x :app:rustBuildX86_64Release` | PASS (manifest-only): production package, no ACCESS_NETWORK_STATE; standalone permission config absent. This does not build/sign/package a release APK |
| NDK `llvm-nm --dynamic --defined-only` | PASS on **both final target .so and native library extracted from the actual default APK**: exactly NativeIdentityBridge_install and NativeIdentityBridge_networkChanged; no signing/BridgeTest/RestartTest JNI exports |
| Final `qualification/verify-isolation.ps1` | **4 resolved-graph controls PASS**; default Windows/Android exclude opaque-ke/argon2/crypto-bigint; Windows dev/Android test-feature positive controls include them |
| Scoped `rustfmt --check --config skip_children=true` | PASS on eight changed Rust implementation/harness files; no global-format claim for historically unformatted module/test files |
| Default generated Gradle /production manifest /frozen source diff | PASS: default Gradle restored by supported build; shipped manifest, migrations, journal and Sync codec/protocol unchanged |
| `adb devices` after cleanup | No task emulator remains; only task-owned emulators were stopped |

Cargo.lock adds one direct reference to the already resolved windows-core0.62.2;
no package version or cryptographic dependency change. Windows Ole support is
needed by the NLM connection-point sink. No keys, databases, APKs, native binaries
or raw logs are committed. Local evidence is retained under `%TEMP%/arthur-n7c-*`:
red; focused/final-focused/closure-focused/delivery-focused; native/final-native/
closure-native/delivery-native (closure-native was interrupted and is **not** a
completed gate); TTS rerun; typecheck/architecture/frontend; Android/delivery-Android,
network reruns, public fixtures/interop/host-JCA; negative-release repeats, default
builds and release-manifest tasks. Dependency controls are in
`%TEMP%/arthur-n7c-final-isolation`. Final binary inspection also confirmed the
native quarantine registry member; it is not a JNI-failure-injection test.

**Delivery status: MEGA N7C PARTIAL.** Dormant native subscriptions, revocable
event fences, fresh native admission/provenance, shared-owner cleanup and isolated
Android level-B qualification are implemented and locally verified as detailed.
The final full suite retains the five historical native/two architecture failures;
the additional intermittent TTS failure and test-development/setup failures are
retained above with rerun results. The following platform/policy limitations are
not converted into PASS or approval.

Pre-connect observations do not remove TOCTOU: a future socket path must verify
connected local/remote endpoints and current network/profile/permission before
private disclosure. OS API reads are synchronous; freshness deadlines reject
slow results after return, not by preempting OS calls. Native subscription/cancel
failure injection, actual host route/profile/VPN transitions, Android normal-
permission revocation and Activity-destruction-during-callback scenarios remain
NOT TESTED. Physical devices, ARM64, API37 permission behavior, live LAN sessions,
real encrypted I/O/timer adapters, successful release packaging and hosted CI
remain UNVERIFIED. No activation gate is self-approved.

## 24. MEGA N7D — Native I/O and Connected-Endpoint Qualification

Scope: accepted N7C `d8ecd0f3cbe820b5e022c4d973eeb49775628a68`, existing
`feature/nodes-integration`, local Windows verification on 2026-10-25.
Contract, architecture answers, failure semantics and lifecycle review:
[m05-n7d-native-io.md](m05-n7d-native-io.md).

Implemented: explicit compile-time-isolated IPv4 loopback socket laboratory,
real Tauri/Tokio reactor I/O and monotonic Sleep-backed Timer/TimerRegistration,
4096-byte poll bounds, 64 KiB synthetic NLAB frames, actual endpoint inspection,
revocable socket-owner evidence and a fail-closed connected-route coordinator
check. No raw socket implements EncryptedIo. No production constructor can
create ConnectedEndpoints. Loopback/interface-unverified evidence never passes
native LAN attestation. No positive connected LAN result is claimed.

TTS RED→GREEN: `n7d_terminal_status_is_published_after_audio_cleanup` reproduced
one remaining file at exact terminal publication (0 PASS/1 FAIL, 0.04s).
The fix releases the current TempAudio and PlayerHold before natural terminal
publication for focus loss and playback failure. The unchanged assertion passes
for focus loss and both playback-start errors. The initial N7D package passed
7/7 including actual 10/15/60-second deadlines; the expanded focused package
passed 40/40. The full-suite evidence below is authoritative for final source.
N7B's earlier EvolutionScreen observation and N7C's transient TTS observation
remain in their original sections; the new deterministic TTS reproduction is
not discarded as a flake.

The new Windows monitor cases use actual OS registrations plus controlled epoch
overflow/reentrant shutdown. They wait for destruction of the last Signal
reference after all worker/native callback/COM sink ownership is released.
The owner-generation/profile-event/shutdown socket cases use actual loopback
I/O with synthetic route facts/events: they are not real host route transitions.
The new socket limits tests share one existing Pool and verify two handshakes,
one session and no refund after failure/abort. Waker replacement reenters
cancellation; actual Windows SOCKET validity and Android fd validity are checked
immediately after Drop, in addition to peer EOF and zero owned registrations.

Final executed gate results and retained limitations follow.

| Native gate (Windows x86_64) | N7C accepted | N7D executed result |
| --- | --- | --- |
| Full `cargo test --locked --offline --lib -- --test-threads=1` | 1386 PASS /5 FAIL /25 ignored | **1397 PASS /same 5 FAIL /25 ignored**, 708.88s |
| Focused `--lib n7 -- --test-threads=1` | 29 PASS | **40 PASS**; final full-suite n7 subset also **40 PASS** |
| `sync::security::` subset | 63 PASS /1 ignored | **72 PASS /1 ignored** |
| Name-matched `sync` subset | 149 PASS /1 ignored | **158 PASS /1 ignored** |
| `storage::journal::` subset | 287 PASS /1 ignored | **287 PASS /1 ignored** |
| `storage::m05_v10_tests::` subset | 24 PASS | **24 PASS** |
| TTS service file | Prior transient focus-loss failure | **15 PASS**, including the deterministic new regression |

These are overlapping subsets extracted from the completed full run, not extra
independent executions. Focused run log: `%TEMP%/arthur-n7d-final-focused.log`
(90.46s); full run: `%TEMP%/arthur-n7d-native.log`. This initial full run preceded the later Android lab stack fix; it included epoch-relative deadline assertions, explicit loopback client binding and WriteZero closure. No new test-development/implementation failures
occurred in these completed native runs apart from the intentional TTS RED.

The same five historical failures remain:

- `jev::tests::the_real_transport_posts_json_with_a_bearer_header_and_never_leaks_the_key_in_errors`: Timeout versus expected Network.
- `synthesis::architecture_tests::a_same_family_pass_is_wired_to_hold_for_review_and_the_shipped_verifier_is_not_called_independent`.
- `synthesis::architecture_tests::the_real_synthesis_endpoint_is_only_reachable_through_the_production_constructor`.
- `synthesis::eval::tests::the_corpus_is_frozen`: unchanged historical frozen-corpus hash mismatch.
- `synthesis::tests::the_commit_time_permission_check_includes_the_synthesis_authorizations`.

These failures are retained from the user-accepted N7C baseline, not fixed or
self-approved as release readiness. Self-review found no additional blocker in
the changed authorization/data-loss boundaries. The **important** TTS ordering
defect is reproduced and fixed; this is same-agent review, not an independent
N1 audit. No raw socket, frame or endpoint evidence grants trust.

| Host build / frontend gate | N7D result |
| --- | --- |
| `cargo check --locked --offline --all-targets` | **PASS**, final 19.20s; `arthur-n7d-final-check.log` |
| `cargo build --locked --offline --bin arthur` | **PASS**, actual default Windows x86_64 binary, 1m34s; `arthur-n7d-windows-build.log` |
| Root `npm run typecheck` | **PASS**; `arthur-n7d-typecheck.log` |
| `npm run test:architecture` | **86 PASS /same2 historical FAIL**; `arthur-n7d-architecture.log` |
| `npm run arthur:check` | **561 PASS /42 files**, frontend typecheck and Vite build PASS; `arthur-n7d-frontend.log` |

The architecture failures remain schema-v6 project ownership and M04.6 voice
output DTO source assertions. No frontend test failed in this run; the earlier
N7B EvolutionScreen transient is retained as historical evidence, not silently
removed. Existing Vite chunk-size warnings remain warnings. Default Windows
binary compilation is not release installer/signing/packaging evidence.

N7D Android development failure: the first feature APK built, but the first
instrumentation run recorded **35 PASS /1 crashed case /6 not completed**
(XML 36 cases, failures 1, skipped 0; requested 42). The failing new aggregate case
was `n7d_actual_loopback_io_endpoints_and_cleanup`. debuggerd reports a stack
overflow, with the top native frame in Tokio block_on of the backpressure
future. Its inline 64 KiB array was copied through debug runtime wrappers on the
JNI thread. This is a new lab defect, not a historical baseline failure.
The bounded buffer is now a 64 KiB heap Vec; the future is heap-pinned before
runtime wrappers, and a permanent 32 KiB future-size guard prevents regression.
Host post-fix focused verification: **40 PASS**, 92.76s,
`arthur-n7d-stack-focused.log`. The complete Android rerun is reported below.
The failed `arthur-n7d-android.log`, `arthur-n7d-android-red.xml` and
`arthur-n7d-android-crash-logcat.log` remain retained. No skip, timeout increase,
thread-stack change, expectation relaxation or production gate change hides it.

| Android executed gate | Result after stack fix |
| --- | --- |
| Dedicated feature Rust/Java/Kotlin/Gradle/debug APK | **PASS**; `verify-identity.ps1 -Serial emulator-5554` |
| Fresh instrumentation XML,2026-10-25 06:21:06 UTC | **42 PASS /0 FAIL /0 errors /0 skipped** (36 Bridge, 4 DeviceSigning, 2 TLS cases), versus N7C40 |
| `n7d_actual_loopback_io_endpoints_and_cleanup` | **PASS**,0.137s; actual raw I/O, endpoints, handles, shared limits, wakers and timers |
| `n7d_actual_monotonic_deadlines` | **PASS**,85.063s; actual 10/15/60-second monotonic expiration |
| Actual process force-stop/reopen | **2 PASS**, two separate `OK (1 test)` results |
| Dedicated APK cold launch | **PASS**, `Status: ok`, `LaunchState: COLD` |
| Fresh public-only TLS/device fixtures | **2 PASS**, explicitly repeated before export |
| Feature native-library symbol control | **PASS**: native_io_lab symbols exist in the actual feature-built library |

Environment: task-owned read-only/no-window emulator, Android 16/API 36/x86_64,
`google/sdk_gphone64_x86_64/emu64xa:16/BE4B.251210.005/14574095:user/release-keys`.
The normal dedicated package has no ACCESS_NETWORK_STATE permission; raw
loopback I/O requires no new permission. Existing native signing/TLS/PAKE cases
also reran in the 42-case package. The owner socket/fence cases additionally run
through the existing scenario 31 qualification. No physical-device, ARM64,
API37-runtime or cross-device LAN result is inferred.
Logs/XML: `%TEMP%/arthur-n7d-android-green.log`, `arthur-n7d-android-green.xml`,
`arthur-n7d-apk-smoke.log`, `arthur-n7d-public-fixtures.log`,
`arthur-n7d-feature-symbols.log`. The earlier crash remains a failed development
run; the fresh complete rerun is the GREEN evidence for its narrow fix.

Standalone Android network qualification: **2 PASS** after recovery from a full
host disk. The first streamed install was rejected with a v2 content-digest
error; local apksigner verification passed. A subsequent adb push lost its
connection. Inspection found **0 free bytes on host C:**; the emulator later
lost normal ADB authorization. These are retained setup/transport failures,
not accepted runtime PASS and not suppressed signature verification.

After the user freed space, only the task-owned read-only emulator was
restarted. Both dedicated standalone APKs were verified by apksigner, copied
to disposable /data/local/tmp paths, compared by host/device SHA-256, and
installed through standard PackageManager. Both installs succeeded and the
actual two-case native acquisition/callback package returned `OK (2 tests)`.
The temporary APK copies were removed by exact path. No signature check,
permission boundary, host network adapter or firewall setting was disabled.
The standalone debug project remained outside default Tauri settings and its
release variant remained disabled. Its ACCESS_NETWORK_STATE permission is
isolated from the production manifest. The task emulator was then stopped.
Evidence: `arthur-n7d-android-network.log` (initial install refusal),
`arthur-n7d-network-apksigner-red.log` (host verifier PASS),
`arthur-n7d-android-network-checked.log` (failed push), and
`arthur-n7d-android-network-green.log` (matching hashes, normal installs,2 PASS).
The disk exhaustion/ADB interruption and Android stack overflow are distinct
failures with distinct recovery/fix evidence.

| Final isolation / interoperability gate | Result |
| --- | --- |
| Forbidden Android test-feature release compilation | **Expected refusal**, CLI 1/Cargo 101; **3 explicit guards + 8 existing secondary errors = 11**, not successful release packaging |
| Supported default `tauri android build --debug --target x86_64 --apk --ci` | **PASS**, actual final-source default Rust/Java/Kotlin/Gradle/debug APK |
| APK application id /permissions | **PASS**, dev.kaloyan.arthur; only INTERNET, RECORD_AUDIO and app-scoped DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION; no ACCESS_NETWORK_STATE |
| `processX86_64ReleaseMainManifest` excluding Rust build | **PASS manifest-only**, production package, no ACCESS_NETWORK_STATE; not release packaging |
| NDK nm on default target library **and actual APK-extracted library** | **PASS**, exactly NativeIdentityBridge_install and NativeIdentityBridge_networkChanged; no signing/test JNI exports and no native_io_lab symbols |
| PAKE dependency graph controls | **4 PASS**: default Windows/Android exclude opaque-ke/argon2/crypto-bigint; Windows dev and Android qualification positive controls include them |
| Fresh Android-public-fixture Windows native tests (`actual_android --ignored`) | **2 PASS**,0.03s; actual CNG verifies Keystore device/TLS signatures |
| Fresh host JCA (`javac --release 8` plus three public fixtures) | **91 PASS**, host-only evidence |

Default Gradle configuration is restored through the supported default Tauri
build. No permission file was edited. Evidence: `%TEMP%/arthur-n7d-forbidden-release.log`,
`arthur-n7d-default-android.log`, `arthur-n7d-release-manifest.log`,
`arthur-n7d-default-permissions.log`, `arthur-n7d-default-jni.log`,
`arthur-n7d-isolation.log`, `arthur-n7d-final-isolation/`,
`arthur-n7d-interop.log`, `arthur-n7d-javac.log`, `arthur-n7d-jca.log`.
Cargo.lock has no change and no dependency version upgrade is part of N7D.

### Final delivery verification after the Android stack fix

The authoritative final full native rerun is
`%TEMP%/arthur-n7d-final-native.log`: **1397 PASS /the same 5 historical FAIL
/25 ignored**, 809.87 s, Cargo101. Its failure-name set was compared directly
with the accepted N7C delivery log and matches exactly. Final overlapping
subsets are **N7 40 PASS; Security 72 PASS/1 ignored; Sync 158 PASS/1 ignored;
Journal 287 PASS/1 ignored; dormant v10 24 PASS; TTS service 15 PASS**.
Both completed full runs are retained; the earlier 708.88 s run preceded the
Android stack correction and is not substituted for this final-source rerun.

Final `cargo check --locked --offline --all-targets` **PASS**, 19.85 s, and
`cargo build --locked --offline --bin arthur` **PASS**, 2.65 s; evidence:
`arthur-n7d-delivery-check.log` and `arthur-n7d-delivery-windows-build.log`.
Scoped rustfmt with skip_children=true **PASS** on seven changed Rust
implementation/harness files; `arthur-n7d-format.log`. Historically compact
module/fixture/TTS files are not claimed globally formatted. Diff whitespace
check **PASS**. Default generated Gradle, shipped manifest and Cargo.lock
have no diff. The 14-file change inventory is in the N7D contract;
no migration, journal, codec, reducer, snapshot-v2 or D4 source change is part
of this delivery. No raw logs, binaries, public-fixture exports or private keys
are committed. No task-owned emulator remains.

**Delivery status: MEGA N7D — PARTIAL.** The executed Windows/Android
nonblocking raw-I/O, timer, endpoint-address, cancellation, resource and
owner-invalidation foundation is qualified within loopback/test scope.
Two concrete defects have RED→GREEN evidence: TTS terminal cleanup ordering
and the Android lab's inline-future stack overflow. No newly failing native,
architecture or frontend test is left beyond the accepted historical five
native/two architecture failures. The disk-full install/ADB failures remain
recorded separately from the code defects and successful recovery.

Remaining **UNVERIFIED /unapproved**: connected socket interface/network
attestation; actual host profile/route/VPN changes; native unregister/JNI
partial-allocation failure injection and quarantine failure paths; Android
permission revocation/Activity-destruction races; physical devices, ARM64 and
API37 runtime; real TLS-over-socket and authenticated encrypted Sync; successful
release packaging/signing; hosted CI. Runtime-owner shutdown during actual
pending I/O was tested; destruction of the global Tokio executor during live
I/O was not injected. Interoperability uses public fixtures, not a physical
Windows-to-Android LAN session.

M05 remains dormant; schema v9, ClosedTrust, ClosedLan, PAKE/TLS/LAN CLOSED,
no live enrollment/production VerifiedSession/Sync ingress/listener/dialer,
no automatic network startup/frontend network or signing API/second SQLite
owner, and G4 UnverifiedBounds remain unchanged. N1_AUDIT_PENDING and
N7PolicyPending remain unresolved; N1/N2/N3/N7 and G4–G7 remain unapproved.
No E3B work, production v10 activation, main merge or activation approval is
included. The results are local evidence, not a release-readiness declaration
or an independent N1 security audit.
