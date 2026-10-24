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
