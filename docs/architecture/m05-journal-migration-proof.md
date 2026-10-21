# M05 P1b — Transactional journal design and migration proof

**IMPLEMENTATION DESIGN — awaiting migration/SQL review**

Audit: 2026-10-21. Branch `feature/nodes-integration`, clean starting HEAD
`b6b2abf2c5cda284174de383de43bc9847f36e67`. Basis: the complete approved
[logical sync contract](m05-sync-contract.md) and [LAN architecture](m05-lan-personal-network.md).
Their approval is architectural; this document does not approve or install SQL, alter a migration,
implement an importer, or establish security/platform acceptance. Only this document is deliverable.

## 1. Decision and scope

Recommend **schema v10**, rechecked against `storage/migrations.rs`: `STEPS` contains exactly
versions 1 through 9, `SCHEMA_VERSION` is 9, and `migrate_with` rejects versions above its last
step before executing a step. Keep every byte of v1-v9 unchanged. Append v10 only in a later
implementation task. Do not enable it in an intermediate binary with uninstrumented writers.

The owning `CaptureStore` remains the only connection owner, reached through P1a
`NativeRuntime::acquire`. One meaningful outer domain transaction produces one immutable bundle.
The journal is native SQLite persistence, independent of Sync settings, pairing, providers and UI.
Local knowledge remains canonical; a journal bundle is immutable replication evidence of its
committed change, not a second independently editable knowledge store.

Central invariant: once v10 is enabled, domain success implies an atomic, durable bundle of the
actual effects. Allocation, encoding, hash, quota, append or commit failure rolls back domain,
sequence, projections and journal together and returns an honest save error. No network, signer,
OS key lookup or model await is permitted inside that transaction.

Recommend a native `JournalTx` plus **SQL coverage fences** rather than relying solely on calls
to `append_event` scattered through commands. AFTER triggers capture actual authoritative row
effects, including nested helpers and proposal triggers. A deferred FK forces each changed
transaction to have a bundle at COMMIT. The fence is not a substitute for validating bundle
content; native effect reduction, canonicalization and regression tests remain mandatory.

## 2. Verified source inventory

Paths in this section are under `apps/arthur/src-tauri/src/`; symbols/line anchors refer to the
audited HEAD. `Connection::transaction()` is DEFERRED today; the proposed journal wrapper uses
IMMEDIATE. Never equate one Tauri command with one transaction.

| Existing entry / helpers | Current boundary, generated identity/time and actual result | Required owning journal seam |
|---|---|---|
| `capture_store.rs:139 create` | UUIDv4 and `now_rfc3339` before the mutex; project lookup, then one autocommit INSERT. Validation/error consumes no stored identity | Replace autocommit with `JournalTx`; project check and INSERT inside it; one Capture create |
| `knowledge_store.rs:73 record_distillation` | One DEFERRED tx. `begin_distillation_in:140` returns Existing without writes, or inserts run with time and deletes local failure. `insert_object_in:155` generates object UUID/time, source and initial revision UUID; initial revision reuses object time | Wrapper finalizes once after all objects. Empty fresh run is a meaningful completion event; repeated run has no event |
| `distillation/evolution.rs:825 commit_with_identity` and `apply` | Classifier/synthesis/verifier outside lock. Empty claims use ordinary record_distillation. Otherwise `in_identity_transaction` runs final permission check, run, identity decisions, new objects/revisions/evidence/pending claims/proposals | Final persisted result of this ONE outer immediate tx; do not journal planning/model output or append from nested helpers |
| `lineage_store.rs:181/193/206/221` update, branch, merge, revise_from_capture | One DEFERRED tx each. `insert_revision` generates UUID/time, inserts parents and optional current projection. Branch with make_current=false still writes history. Ordinary edits are not all exposed expected-head CAS APIs | One bundle containing revision/parents/provenance and actual pointer transition; a new revision counts even if text resembles an old one |
| `lineage_store.rs:243/256/303` revise_if_current, restore, revise_if_current_in | IMMEDIATE wrappers / caller-owned helper. Validate project/current head; CAS refuses identical content. Restore creates a NEW merge revision with current and target parents | Outer wrapper, after evidence if present. Stale/invalid/rejected action emits nothing |
| `evidence_store.rs:177/297` attach_revision_evidence_in / wrapper | Caller tx / IMMEDIATE wrapper; ordinal=max(existing)+1, now per inserted row. Same span+same metadata returns existing item; conflicting same span errors | Include newly attached evidence with the owning revision or one direct-attachment bundle, not one bundle per item |
| `project_store.rs:222/235/253/270` create/rename/archive/restore | DEFERRED tx each. Create UUID/time; rename/transition changes updated_at only when actual transition. Archive ALSO deletes device-local active_project row | One project operation. Repeated archive may only change local active state: no knowledge event |
| `project_store.rs:283/300` move Capture / object | DEFERRED tx; UPDATE project_id even if already equal; SQL affected-row count is not proof of meaningful change. No UUID/time/revision generated | Compare actual before/after membership. Same target => no event. Capture and interpreted object moves remain independent |
| `relation_store.rs:117/130/171` create_relation, record_relations, insert_all | DEFERRED outer tx. Canonicalize symmetric ends and deduplicate semantic key; `Written.created` distinguishes existing edges. New edge gets UUID/time | Only actual new edges. Entire accepted batch is one bundle; no per-helper append |
| `integration_store.rs:112 apply_integration` | DEFERRED tx; stale focus returns without commit/writes. Per-context checks can skip subsets. Physically deletes only eligible model edges, then adds/deduplicates model edges | Capture OLD rows BEFORE removal, exact IDs/origin/creation version, and actual additions/skips; one observed-remove/add bundle. Never tombstone user/system edges merely requested for removal |
| `identity_store.rs:254 record_identity_decision_in` | Caller-owned tx; identity `(capture_id, ordinal)`, decided_at generated only on insert. Equal decision => false/no write; different decision => conflict | Owning identity wrapper; validated audit fields only |
| `identity_store.rs:410 stage_uncertain_claim_in` | Caller tx: decision plus claim UUID/time; existing equal claim => no write | Same bundle as run/decision; no second helper event |
| `identity_store.rs:468/523` accept/separate hooked helpers | Caller IMMEDIATE tx. Accept adds CAS system revision+evidence then hook, then claim accepted. Separate adds object/source/initial revision, hook, then claim separated; method user or expiry. Terminal repeats return applied=false | Capture all final rows, including hook-closed/superseded proposal; no duplicated revision event |
| `identity_store.rs:558-590` defer/reopen / in_identity_transaction | IMMEDIATE outer wrapper. set_open_or_deferred ALWAYS updates updated_at; due_at uses coalesce, so None does not clear prior due date | Journal actual metadata change even when caller's applied flag is false. Do not silently alter these existing semantics in P1b |
| `proposal_store.rs:175/404` insert_proposal_in / wrapper | Caller identity tx; existing claim proposal returns existing even if requested draft differs. New proposal UUID/time, immutable draft/base/evidence/model metadata | Only actual inserted proposal, with its claim/decision closure |
| `proposal_store.rs:594/704/715` review_in, review/resolve wrappers | IMMEDIATE. Terminal repeat of same decision no write; incompatible terminal result errors. Approve hook writes final_body/user_edited/result revision BEFORE claim resolution; direct claim resolution can supersede proposal via trigger. Defer/reopen update timestamps even with unchanged state | Outer finalizer after all hooks/triggers; exact reviewed head, action, final body, resulting revision/evidence and final proposal/claim images |
| `organization_store.rs:39 record_organization_failure` | Autocommit UPSERT guarded by absence of successful run; time/code/safe message | EXCLUDED operational retry state; no replicated event |
| `recall_store.rs:582-647` embedding put/adopt/purge and lexical rebuild/check | Local single-statement writes/rebuild operations; some autocommit. FTS AFTER revision triggers also run inside domain tx | EXCLUDED derived indexes. No provider execution from recording/import |
| `project_store.rs:333 set_active_project` | DEFERRED tx, local preference UPSERT | EXCLUDED; not confused with project ownership |

UUIDs are existing `Uuid::new_v4` values; business timestamps are existing RFC3339 strings from
`now_rfc3339`, copied exactly. Evidence/decision composite keys are not replaced by invented UUIDs.
Local `seq`/sqlite_sequence/FTS rowids never become wire identity or origin ordering.
Writes also originate from pipeline/retry/review/background service paths, not just React.

### 2.1 Triggers and constraints that the implementation must preserve

- v6 Capture insert/move requires a non-null open project; Capture id/seq/source/content/time
  UPDATE is forbidden. Fixed Inbox cannot be renamed, archived or deleted. Name uniqueness is
  an application check, not a SQL UNIQUE constraint.
- v4 revisions/parent links reject UPDATE; same-object, older-local-seq and acyclic parent
  triggers remain. Object kind/title/body/current pointer must agree with the referenced revision.
  Initial object + root + current pointer is assembled within one transaction.
- v8 evidence is immutable/nondeletable, system-only, bounded inside Capture, ancestor-only
  retraction and **before descendants**. Decisions are immutable/nondeletable; claims need an
  uncertain decision, existing same-project candidates and start open. Terminal claim states
  cannot change; accepted/separated states need revision/evidence or source proof.
- v9 proposals start open against an open claim and then-current base. Draft content is immutable;
  terminal states are final; approved state requires exact final body and revision evidence.
  `pending_claims_resolution_supersedes_open_proposals` changes proposal state/reviewed_at/updated_at
  after claim resolution. Capture its final result without relying on AFTER-trigger execution order.
- v7 FTS insert/delete effects and local embedding invalidation are derived, not additional
  knowledge operations. No existing trigger is removed, replaced or globally disabled in v10.

No ordinary production domain deletion API was found other than eligible model relation deletion.
Unexpected new domain deletion shapes must fail encoding/rollback until their operation contract
is reviewed; do not accidentally advertise a generic delete capability.

## 3. Offline identity and restore safety

Keep a random installation-local **origin_id** separate from network device public-key identity.
An **incarnation** is a random UUID for one storage-owner activation, not a wall clock or key id.
On EVERY newly constructed owner (including cold restart/reacquisition after its last Arc drops),
before publishing it to Tauri/workers, seal any active incarnation and create a fresh one at
sequence 0/zero hash, atomically. Reuse of an already-live Arc does not rotate it.

This deliberately rotates more often than only after detected restore. A database cannot prove
that its own counters were not rolled back together with its own restore marker. Persisting one
incarnation across arbitrary restored copies without an independent monotone anchor would permit
sequence reuse. Requiring an OS signing key/remote peer for that anchor would break pre-pairing
offline writes. Fresh CSPRNG incarnation per activation avoids that dependency: old incarnations
are never appended to again. UUID collision resistance is the assumption; a privileged attacker
restoring a live VM including RNG/process state remains outside this protocol guarantee.

| Lifecycle | Required behavior |
|---|---|
| First upgrade before pairing | Initialize local origin and fresh incarnation using local RNG only; writes journal normally with no key, certificate, code, peer or LAN |
| Ordinary restart / crash | New incarnation; retain all previously committed bundles with original identities; no cursor reset or rewriting old bytes |
| Restore while stopped | Restore preserves historical IDs/prefix; next activation MUST use fresh incarnation; no appending at a restored old sequence |
| Attempt to replace DB beneath live runtime | Unsupported; stop/quarantine, never reopen it as the old owner. OS root lock does not make externally replaced private files safe |
| Reinstall / copied restored installation | Fresh install creates new origin; restored copy may carry old origin but gets fresh incarnation. Network identity remains separate and requires explicit re-enrollment |
| Signing-key loss while live | Serialize seal/rotate with writers; local saves continue unsigned. Retain old signatures and their signer attribution; future key may only attest current possession, never impersonate the lost signer |
| Leave A / join B | Explicit sharing consent again; revoke old sessions/cursors and rotate incarnation. Old core bytes retain IDs; B gets a new network-bound attestation or legacy snapshot, never A's grant reused as B authority |
| Compaction | Never reset sequence/hash. Retain authenticated prefix checkpoint and incarnation seals; missing retained payload requires explicit rebootstrap |

Seal record means a LOCAL chain tip, not a trusted cryptographic checkpoint until authenticated.
A restore can lose unexported data that is absent from the backup; this design prevents identity
reuse, not recovery of bytes that no longer exist. No silent success/fork reconciliation.
If a peer already knows a longer prefix of a restored old stream, keep that proof and flag the
truncated local history; a fresh incarnation does not erase old fork/truncation evidence. Do not
sign a restored shorter tip as a claim that no later old-stream event ever existed.

## 4. Candidate v10 tables — proposal, not an installed migration

SQL blocks labelled candidate-core and candidate-guards are a self-contained review proposal.
All tables below are needed in P1b; later delivery/import tables are deliberately separated in §9.
Use ordinary CREATE (not IF NOT EXISTS) and one migration transaction plus user_version bump.
STRICT requires compatible SQLite; validate against the locked bundled native build before landing.
No random IDs, current-time defaults, environment reads, data backfill or key provisioning in DDL.

```sql
-- candidate-core
CREATE TABLE sync_origins (
    origin_id TEXT NOT NULL CHECK(length(origin_id)=36),
    incarnation TEXT NOT NULL CHECK(length(incarnation)=36),
    status TEXT NOT NULL CHECK(status IN ('active','sealed')),
    last_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_seq>=0),
    last_hash BLOB NOT NULL DEFAULT (zeroblob(32)) CHECK(length(last_hash)=32),
    opened_at TEXT NOT NULL CHECK(length(opened_at)>0),
    sealed_at TEXT,
    PRIMARY KEY(origin_id,incarnation),
    CHECK((status='active' AND sealed_at IS NULL) OR (status='sealed' AND sealed_at IS NOT NULL)),
    CHECK(last_seq<>0 OR last_hash=zeroblob(32))
) STRICT;
CREATE UNIQUE INDEX sync_one_active_origin ON sync_origins(status) WHERE status='active';

CREATE TABLE sync_local (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    origin_id TEXT NOT NULL CHECK(length(origin_id)=36),
    active_incarnation TEXT NOT NULL CHECK(length(active_incarnation)=36),
    bootstrap_required INTEGER NOT NULL DEFAULT 1 CHECK(bootstrap_required IN (0,1)),
    FOREIGN KEY(origin_id,active_incarnation) REFERENCES sync_origins(origin_id,incarnation)
) STRICT;

CREATE TABLE sync_bundles (
    event_id TEXT PRIMARY KEY NOT NULL CHECK(length(event_id)=36),
    bundle_id TEXT NOT NULL UNIQUE CHECK(length(bundle_id)=36),
    origin_id TEXT NOT NULL,
    incarnation TEXT NOT NULL,
    origin_seq INTEGER NOT NULL CHECK(origin_seq>0),
    payload_schema INTEGER NOT NULL CHECK(payload_schema=1),
    raw_effect_count INTEGER NOT NULL CHECK(raw_effect_count BETWEEN 1 AND 4096),
    canonical_bytes BLOB NOT NULL CHECK(length(canonical_bytes) BETWEEN 1 AND 4194304),
    canonical_hash BLOB NOT NULL CHECK(length(canonical_hash)=32),
    previous_hash BLOB NOT NULL CHECK(length(previous_hash)=32),
    committed_at TEXT NOT NULL CHECK(length(committed_at)>0),
    UNIQUE(origin_id,incarnation,origin_seq),
    FOREIGN KEY(origin_id,incarnation) REFERENCES sync_origins(origin_id,incarnation)
) STRICT;

CREATE TABLE sync_write_context (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    event_id TEXT NOT NULL UNIQUE CHECK(length(event_id)=36),
    effect_count INTEGER NOT NULL DEFAULT 0 CHECK(effect_count BETWEEN 0 AND 4096),
    staged_bytes INTEGER NOT NULL DEFAULT 0 CHECK(staged_bytes BETWEEN 0 AND 8388608),
    FOREIGN KEY(event_id) REFERENCES sync_bundles(event_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE sync_commit_fences (
    event_id TEXT PRIMARY KEY NOT NULL,
    FOREIGN KEY(event_id) REFERENCES sync_bundles(event_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE sync_effects (
    effect_no INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES sync_commit_fences(event_id),
    entity_kind TEXT NOT NULL,
    entity_key TEXT NOT NULL CHECK(json_valid(entity_key) AND json_type(entity_key)='array'),
    before_json TEXT CHECK(before_json IS NULL OR (json_valid(before_json) AND json_type(before_json)='object')),
    after_json TEXT CHECK(after_json IS NULL OR (json_valid(after_json) AND json_type(after_json)='object')),
    CHECK(before_json IS NOT NULL OR after_json IS NOT NULL)
) STRICT;
CREATE INDEX sync_effects_by_event ON sync_effects(event_id,effect_no);

CREATE TABLE sync_entity_heads (
    entity_kind TEXT NOT NULL,
    entity_key TEXT NOT NULL CHECK(json_valid(entity_key) AND json_type(entity_key)='array'),
    facet TEXT NOT NULL CHECK(facet IN ('record','membership','head','lifecycle')),
    event_id TEXT NOT NULL REFERENCES sync_bundles(event_id),
    state_hash BLOB NOT NULL CHECK(length(state_hash)=32),
    PRIMARY KEY(entity_kind,entity_key,facet)
) STRICT;
CREATE INDEX sync_heads_by_event ON sync_entity_heads(event_id);

CREATE TABLE sync_snapshots (
    snapshot_id TEXT PRIMARY KEY NOT NULL CHECK(length(snapshot_id)=36),
    state TEXT NOT NULL CHECK(state IN ('pending','materialized','ready','aborted')),
    profile TEXT NOT NULL CHECK(profile='knowledge-v1-full'),
    requested_at TEXT NOT NULL CHECK(length(requested_at)>0),
    boundary_bytes BLOB,
    row_count INTEGER NOT NULL DEFAULT 0 CHECK(row_count BETWEEN 0 AND 20000),
    total_bytes INTEGER NOT NULL DEFAULT 0 CHECK(total_bytes BETWEEN 0 AND 33554432),
    manifest_bytes BLOB CHECK(manifest_bytes IS NULL OR length(manifest_bytes) BETWEEN 1 AND 262144),
    manifest_hash BLOB CHECK(manifest_hash IS NULL OR length(manifest_hash)=32),
    CHECK(state NOT IN ('materialized','ready') OR boundary_bytes IS NOT NULL),
    CHECK((state='ready' AND manifest_bytes IS NOT NULL AND manifest_hash IS NOT NULL)
       OR (state<>'ready' AND manifest_bytes IS NULL AND manifest_hash IS NULL))
) STRICT;

CREATE TABLE sync_snapshot_rows (
    snapshot_id TEXT NOT NULL REFERENCES sync_snapshots(snapshot_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 19999),
    entity_kind TEXT NOT NULL,
    entity_key TEXT NOT NULL CHECK(json_valid(entity_key) AND json_type(entity_key)='array'),
    row_bytes BLOB NOT NULL CHECK(length(row_bytes) BETWEEN 1 AND 262144),
    row_hash BLOB NOT NULL CHECK(length(row_hash)=32),
    PRIMARY KEY(snapshot_id,ordinal),
    UNIQUE(snapshot_id,entity_kind,entity_key)
) STRICT;
```

### 4.1 Ownership, columns, indexes and lifecycle

All nine tables are device-private persistence written only by the existing native owner. None
contains a private key, provider secret, address, audio, enrollment code or raw provider reply.
Canonical bytes/effect images/snapshot rows DO contain private knowledge; treat them like the
domain database for backup, access control, erasure and disk accounting. Do not log their bodies.

| Table / columns | Authority and update rule | Keys/index queries and retention |
|---|---|---|
| sync_origins origin_id/incarnation, opened_at | Immutable local stream identity and activation metadata; lowercase canonical UUID validation native in addition to SQL length | Composite PK for stream lookup; partial UNIQUE ensures one active stream. Retain seals across compaction |
| status/sealed_at, last_seq/last_hash | Seal once; cursor advances only for the next inserted bundle and never after seal. Positive seq is SQLite signed 64-bit; exhaustion seals/rotates BEFORE allocation | Existing PK serves tip lookup; no redundant time index |
| sync_local singleton/origin_id/active_incarnation | One installation origin and current writer stream; initialization/rotation atomic before owner publication | Singleton PK; FK prevents dangling active stream; native additionally requires referenced status=active |
| bootstrap_required | Durable local need for a coherent baseline; clearing only with a ready baseline. Retention/pairing may request a fresh snapshot without rewriting old snapshots | Singleton lookup; not a network preference |
| sync_bundles IDs, stream tuple, version, committed_at, raw_effect_count | Immutable committed bundle header. event_id and bundle_id are separate UUIDv4s; exactly one event owns one bundle in v1, operations use array ordinals, not additional origin sequences | UNIQUE stream tuple is the origin-range/catch-up index; unique event/bundle IDs detect collision. No FK to business rows that could erase history |
| canonical_bytes/hash/previous_hash | Immutable network-independent canonical core, SHA-256 integrity and predecessor chain. Hash is not authentication | P1b retains all bundles; quota fails future saves honestly. No pruning implementation or row deletion permission in P1b |
| sync_write_context all columns | Transient, but transaction-persisted, one active wrapper. Insert inside BEGIN; counters increment in triggers; delete before successful COMMIT, even for no-op/local-only work | Singleton and event UNIQUE. FK is deferred so bundle can be inserted after effects. Must be empty after a healthy commit/startup |
| sync_commit_fences event_id | First actual replicated row effect inserts a permanent immutable coverage fence | PK/FK backstop: COMMIT cannot omit its bundle even if the context/spool is deleted incorrectly. No UPDATE/DELETE in P1b |
| sync_effects effect_no/event_id/kind/key/before/after | Transaction-local lossless observation spool; not wire events, not a durable second outbox. Before includes deleted model rows; local seq excluded | by_event streams raw effects in order. Delete only after successful bundle insertion, inside same tx; committed spool must be empty. Budget includes transient duplicate images |
| sync_entity_heads kind/key/facet/event_id/state_hash | Derived causal index, maintained in the SAME domain+journal tx. Before first mutation, missing head means explicit legacy baseline hash, not revision zero | PK finds expected causal writer by logical field group; by_event supports retention pin audit. Rebuild from baseline plus retained events. Deletion remains a tombstoned version entry |
| sync_snapshots identity/profile/requested_at/state | Local baseline job: pending -> materialized -> ready, or pending/materialized -> aborted. ready is immutable; retry failed capture uses a new snapshot ID | PK lookup; at most one non-aborted baseline job admitted natively. No additional state index needed at this bound |
| boundary/count/bytes/manifest/hash | Fixed high-water vector and complete consistent materialization; manifest filled later from immutable rows, never a live reread | Native bounded counters checked against actual rows before state transition. Receiver cannot infer authorization from local ready state |
| sync_snapshot_rows all columns | Immutable consistent logical rows; ordinal is private packaging order, not business identity. Delete only with explicit aborted/retired snapshot cleanup; retain until policy permits | PK ordered packing and UNIQUE entity key; no domain FKs, since snapshot remains unchanged when domain state changes |

Candidate limits are proposals in §8, not measured production capacities. SQL length checks do
not validate UUID syntax, canonical JSON, payload hash, timestamp grammar, proof dependencies,
aggregate quotas, or exact manifest membership; native validation and tests must do that.

## 5. Coverage guards and exact projection catalog

Generate three AFTER triggers per table in the following **closed, versioned catalog**. It is
normative input, not discovery of arbitrary future columns. Reject schema/catalog mismatch at
implementation tests; adding a column never automatically makes it shareable. SQL JSON staging
preserves each listed field, including nulls. `*_json` values remain exact stored strings in row
images; parse and validate their typed content separately without rewriting original text.

| Entity/table | Logical key fields, in order | Replicated projection fields, in fixed order |
|---|---|---|
| projects | id | id,name,created_at,updated_at,archived_at |
| captures | id | id,source,content,created_at,project_id |
| distillation_runs | capture_id | capture_id,created_at |
| knowledge_objects | id | id,kind,title,body,created_at,current_revision_id,project_id |
| object_sources | object_id | object_id,capture_id,source_start,source_end |
| thought_revisions | id | id,object_id,kind,title,body,origin,created_at,capture_id,source_start,source_end |
| revision_parents | child_revision_id,parent_revision_id | child_revision_id,parent_revision_id |
| relations | id | id,kind,source_object_id,target_object_id,origin,created_at |
| identity_decisions | capture_id,ordinal | capture_id,ordinal,outcome,unchecked_reason,target_object_id,base_revision_id,result_revision_id,created_object_id,policy_version,model_id,decided_by,vetoes_json,audit_json,decided_at |
| revision_evidence | revision_id,ordinal | revision_id,ordinal,object_id,capture_id,source_start,source_end,role,retracts_revision_id,retracts_ordinal,interpretation_label,created_at |
| pending_claims | id | id,capture_id,ordinal,kind,title,body,source_start,source_end,candidate_ids_json,reasons_json,reframing,state,due_at,created_at,updated_at,deferred_at,resolved_at,resolved_method,resolved_object_id,resolved_revision_id |
| revision_proposals | id | id,pending_claim_id,object_id,base_revision_id,change,kind,title,proposed_body,retracts_revision_id,retracts_ordinal,evidence_json,synthesis_model,verifier_model,verification_mode,verification_status,policy_version,state,user_edited,final_body,result_revision_id,created_at,updated_at,reviewed_at |

Expansion specification: for each catalog row T with columns C and key K, produce INSERT,
UPDATE and DELETE triggers named `sync_observe_T_insert/update/delete`. INSERT has old=NULL,
DELETE has new=NULL; other images are `json_object('column', OLD.column, ...)` / NEW. Key is
`json_array(NEW.K...)`, or OLD for DELETE. Cast integral composite-key fields to decimal TEXT
inside the key array; keys must have the same representation in native encoders/snapshots.
UPDATE runs only WHEN NOT(all `OLD.C IS NEW.C`), so same-value SQL UPDATE is a no-op. Do not use
`UPDATE OF` alone, affected-row counts, `sqlite3_total_changes`, or RETURNING as trigger closure.

The complete trigger body is this executable Capture INSERT example with only the catalog
identifier, operation, WHEN and three image expressions substituted. No other logic varies.

```sql
-- candidate-capture-example; expand using the exact catalog, not a migration applied today
CREATE TRIGGER sync_observe_captures_insert AFTER INSERT ON captures
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_write_context c
        JOIN sync_local l ON l.singleton=1
        JOIN sync_origins o ON o.origin_id=l.origin_id AND o.incarnation=l.active_incarnation
        WHERE c.singleton=1 AND o.status='active'
          AND NOT EXISTS(SELECT 1 FROM sync_bundles b WHERE b.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal context missing or already sealed') END;
    INSERT INTO sync_commit_fences(event_id)
        SELECT event_id FROM sync_write_context WHERE singleton=1
        ON CONFLICT(event_id) DO NOTHING;
    INSERT INTO sync_effects(event_id,entity_kind,entity_key,before_json,after_json)
        SELECT event_id,'captures',json_array(NEW.id),NULL,
               json_object('id',NEW.id,'source',NEW.source,'content',NEW.content,
                           'created_at',NEW.created_at,'project_id',NEW.project_id)
        FROM sync_write_context WHERE singleton=1;
    UPDATE sync_write_context
       SET effect_count=effect_count+1,
           staged_bytes=staged_bytes+(SELECT
               coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)
               FROM sync_effects ORDER BY effect_no DESC LIMIT 1)
     WHERE singleton=1;
END;
```

The WHERE on INSERT SELECT is deliberate SQLite UPSERT parsing disambiguation. Counters bound
transient effect rows and UTF-8 image bytes. Add native aggregate knowledge quota admission
before domain success. No callbacks/UDF cryptography or extra connection are needed by observers.

```sql
-- candidate-guards
CREATE TRIGGER sync_context_identity_fixed BEFORE UPDATE OF singleton,event_id ON sync_write_context
BEGIN SELECT RAISE(ABORT,'journal context identity is fixed'); END;
CREATE TRIGGER sync_fences_no_update BEFORE UPDATE ON sync_commit_fences
BEGIN SELECT RAISE(ABORT,'journal fence is immutable'); END;
CREATE TRIGGER sync_fences_no_delete BEFORE DELETE ON sync_commit_fences
BEGIN SELECT RAISE(ABORT,'journal fence cannot be deleted'); END;
CREATE TRIGGER sync_bundles_no_update BEFORE UPDATE ON sync_bundles
BEGIN SELECT RAISE(ABORT,'journal bundle is immutable'); END;
CREATE TRIGGER sync_bundles_no_delete BEFORE DELETE ON sync_bundles
BEGIN SELECT RAISE(ABORT,'journal compaction is not enabled'); END;

CREATE TRIGGER sync_bundle_admission BEFORE INSERT ON sync_bundles
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sync_origins o JOIN sync_local l
          ON l.origin_id=o.origin_id AND l.active_incarnation=o.incarnation
        JOIN sync_write_context c ON c.singleton=1 AND c.event_id=NEW.event_id
        JOIN sync_commit_fences f ON f.event_id=c.event_id
        WHERE l.singleton=1 AND o.status='active'
          AND NEW.origin_id=o.origin_id AND NEW.incarnation=o.incarnation
          AND o.last_seq<9223372036854775807 AND NEW.origin_seq=o.last_seq+1
          AND NEW.previous_hash=o.last_hash AND NEW.raw_effect_count=c.effect_count
          AND NEW.raw_effect_count=(SELECT count(*) FROM sync_effects e WHERE e.event_id=c.event_id)
    ) THEN RAISE(ABORT,'journal bundle is not the active complete next transaction') END;
END;
CREATE TRIGGER sync_origin_cursor_guard BEFORE UPDATE OF last_seq,last_hash ON sync_origins
WHEN OLD.status<>'active' OR NEW.last_seq<>OLD.last_seq+1 OR NOT EXISTS (
    SELECT 1 FROM sync_bundles b WHERE b.origin_id=OLD.origin_id AND b.incarnation=OLD.incarnation
      AND b.origin_seq=NEW.last_seq AND b.previous_hash=OLD.last_hash AND b.canonical_hash=NEW.last_hash
)
BEGIN SELECT RAISE(ABORT,'origin cursor must advance through its next bundle'); END;
CREATE TRIGGER sync_bundle_moves_tip AFTER INSERT ON sync_bundles
BEGIN
    UPDATE sync_origins SET last_seq=NEW.origin_seq,last_hash=NEW.canonical_hash
     WHERE origin_id=NEW.origin_id AND incarnation=NEW.incarnation;
END;
CREATE TRIGGER sync_origin_identity_fixed BEFORE UPDATE OF origin_id,incarnation,opened_at ON sync_origins
BEGIN SELECT RAISE(ABORT,'origin identity is immutable'); END;
CREATE TRIGGER sync_origin_seal_final BEFORE UPDATE OF status,sealed_at ON sync_origins
WHEN OLD.status='sealed' OR NEW.status<>'sealed' OR NEW.sealed_at IS NULL
BEGIN SELECT RAISE(ABORT,'an origin may only be sealed once'); END;
CREATE TRIGGER sync_origins_no_delete BEFORE DELETE ON sync_origins
BEGIN SELECT RAISE(ABORT,'origin seals must be retained'); END;

CREATE TRIGGER sync_snapshot_rows_no_update BEFORE UPDATE ON sync_snapshot_rows
BEGIN SELECT RAISE(ABORT,'snapshot rows are immutable'); END;
CREATE TRIGGER sync_snapshot_rows_insert_pending BEFORE INSERT ON sync_snapshot_rows
WHEN (SELECT state FROM sync_snapshots WHERE snapshot_id=NEW.snapshot_id) IS NOT 'pending'
BEGIN SELECT RAISE(ABORT,'snapshot is already materialized'); END;
CREATE TRIGGER sync_snapshot_rows_delete_aborted BEFORE DELETE ON sync_snapshot_rows
WHEN (SELECT state FROM sync_snapshots WHERE snapshot_id=OLD.snapshot_id) IS NOT 'aborted'
BEGIN SELECT RAISE(ABORT,'snapshot is retained'); END;
CREATE TRIGGER sync_snapshots_no_delete BEFORE DELETE ON sync_snapshots
BEGIN SELECT RAISE(ABORT,'snapshot retirement needs reviewed retention'); END;
CREATE TRIGGER sync_snapshot_transition BEFORE UPDATE ON sync_snapshots
WHEN OLD.state IN ('ready','aborted') OR NEW.snapshot_id<>OLD.snapshot_id
  OR NEW.profile<>OLD.profile OR NEW.requested_at<>OLD.requested_at
  OR NOT ((OLD.state='pending' AND NEW.state IN ('materialized','aborted'))
       OR (OLD.state='materialized' AND NEW.state IN ('ready','aborted')))
  OR (OLD.state='materialized' AND (NEW.boundary_bytes IS NOT OLD.boundary_bytes
       OR NEW.row_count<>OLD.row_count OR NEW.total_bytes<>OLD.total_bytes))
BEGIN SELECT RAISE(ABORT,'invalid snapshot transition'); END;
```

Review boundary: these guards defend against ordinary missed instrumentation/invalid writes
through this connection with FK enforcement ON. They are not a sandbox against code allowed to
DROP TRIGGER, turn off foreign keys or forge bundle content. Tighten native connection visibility,
test `PRAGMA foreign_keys=1`/`synchronous=FULL` and forbid raw production domain SQL outside the
reviewed store seams. There is no global import-mode switch.

## 6. Native transaction contract and actual-effect encoding

```text
acquire existing runtime/store mutex; reject a nonempty context/spool as corruption
BEGIN IMMEDIATE (one outer owner; no nested BEGIN, no second store)
  create context with fresh event UUID (and allocate fresh bundle UUID in memory)
  read existing domain/causal preconditions; run existing validation and mutation helpers
  observers capture changed rows and insert deferred coverage fence
  if context.effect_count == 0:
    delete context; commit excluded/local-only work; return existing/idempotent result
  otherwise:
    load ALL bounded effects; reduce by entity identity; reread affected final rows
    validate exact domain closure and supported operation; retain deleted relation before-images
    read prior facet heads (or explicit legacy before-image hash); form dependencies
    choose next origin_seq from current active cursor; do not advance it separately
    encode bounded canonical core including actual IDs/times/expected states/action proof
    compute hash; check logical disk quotas; INSERT sync_bundles (admission checks completeness)
    AFTER INSERT advances origin tip in this same tx
    update derived entity_heads to this event and actual final facet hashes
    delete effects and context; require empty spool/context and check final closure
  COMMIT; only now return success and emit existing invalidations/canonical rereads
outside lock: optional future signer/export scheduler (none implemented by P1b)
```

Native API recommendation: `CaptureStore::with_journal_transaction` owns `Transaction` and a
private `JournalTx` capability. Existing `_in` helpers borrow it/the same connection; they never
lock the store again, BEGIN, finalize or publish UI events. Make the generic identity composition
wrapper delegate to it exactly once. Public standalone evidence/decision/proposal wrappers use
it too. No append in Tauri commands or model tasks; their calls can touch several native txs.

The cfg(test) raw opener/in-memory fixture seam must initialize the local journal capability
for upgraded test stores; it must not bypass v10 observers. Build legacy fixtures at v9 before
upgrading, and inject SQL faults through explicit test seams. Preserve intentional multi-connection
CAS fixtures as tests only; they do not authorize a second shipped owner or a trigger-off mode.

One SQL error is not automatically whole-transaction rollback: RAISE(ABORT) rolls back its
statement, and a deferred-FK COMMIT error leaves the transaction open. Every error path must
return Err and explicitly/drop-roll back; never catch an append error and then commit the domain.
Failure must map through Capture/Project/Review/Distill error types as storage failure, with no
success result or success invalidation. Organization failure may subsequently record a separate
LOCAL retry failure; that cannot turn the rolled-back distillation into successful completion.

Reduction rules:

1. Collect each changed logical key, its first before-image and actual final row; insert+pointer
   initialization becomes one complete object create plus root/parent records. Never export the
   transient null-current object image as a publishable object. AFTER-trigger ordering is immaterial
   because the finalizer rereads every affected key after all hooks/triggers finish.
2. New immutable records carry all original values. Mutable operation facets are project name,
   project archive lifecycle, Capture/object membership, selected revision head, and claim/proposal
   lifecycle. Keep independent facets separate; timestamp alone is not a version or winner.
3. Each mutable op includes expected facet event reference plus canonical before-hash and exact
   after-state. Missing old facet head is `legacy_baseline` plus before-hash. The baseline snapshot
   includes facet heads known at its H. Dependencies also include referenced immutable record IDs;
   locally-known causal event refs are sorted/deduplicated. Do not scan the whole journal per write.
4. For model edge removal, retain deleted id, semantic key, origin and creation/version reference;
   legacy creation without an event uses the exact before-hash. Removal is observed-remove, never
   "delete any edge now matching these endpoints". Remove+re-add with a new UUID retains both facts.
5. Claim acceptance/approval bundles include final_body, user_edited, reviewed base, exact created
   revision/parents/evidence, and final claim/proposal states. No intermediate superseded state is
   invented when the review hook already approved the proposal. A future signature attests a fact,
   not human presence, and importer never invokes a live review command.
6. Idempotence uses actual replicated projection equality, not `applied`, `created` alone, SQL
   changes(), or event counts from nested helpers. Timestamp/due-date updates that really persist
   are included even when applied=false. Local active-project/failure/FTS changes alone are excluded.
7. All meaningful effects must map to a known typed operation. An unexpected net-zero multi-step
   mutation or unsupported delete shape fails with `JOURNAL_UNSUPPORTED_EFFECT_SET` and rollback
   until specified; do not drop observed effects to manufacture a no-op. Current documented
   idempotent paths have zero observed replicated changes.

### 6.1 Closed operation codec v1

The wire-independent core has exactly the illustrated fields in §7. `dependencies` is a sorted
array of `{entity, key, eventRef}`; eventRef is null for an explicit baseline dependency, otherwise
`{originId, incarnation, seq, eventId, hash}`. All keys are arrays of strings, including decimal
ordinal keys. `operations` is a dependency-ordered array of the following discriminated forms;
unknown kind/entity/column/version or additional unnegotiated field rejects encoding/apply.

| kind | Exact operation fields beyond kind/version=1 | Allowed entities and meaning |
|---|---|---|
| record.create | entity, key, after | Any of the twelve catalog entities; after has EVERY catalog field, nulls explicit, no seq. Final complete object row includes its current root reference; no transient projection image |
| facet.update | entity, key, before, after, expected | projects, captures, knowledge_objects, pending_claims, revision_proposals only. before/after are full catalog images; expected is an object keyed by every changed facet with `{eventRef, beforeHash}`. Immutable fields must remain byte-equal |
| relation.remove | entity="relations", key, before, observedCreate | Exact deleted MODEL edge image and prior causal eventRef or `{legacyHash}`. No generic record.delete, no user/system deletion, no endpoint-only removal |

Facets: projects record=(name), lifecycle=(archived_at); captures membership=(project_id);
knowledge_objects membership=(project_id), head=(current_revision_id,kind,title,body);
pending_claims lifecycle=(state,due_at,deferred_at,resolved_at,resolved_method,resolved_object_id,
resolved_revision_id,updated_at); revision_proposals lifecycle=(state,user_edited,final_body,
result_revision_id,reviewed_at,updated_at). Project updated_at accompanies its changed facet as
display metadata, not an ordering authority. Capture created_at/source/content and every other
unlisted immutable field are never facet updates. Record facet is used for immutable creation
and relation existence/tombstones. Head/record hashes are SHA-256 over the same versioned JCS
projection with domain prefix `ARTHUR-M05-FACET-v1` and a zero separator.

A bundle with proposal/claim terminal transition also has a required operation-local
`reviewProof` on that facet.update: `{action, proposalId, claimId, objectId, reviewedRevisionId,
finalBody, userEdited, resultRevisionId, method}` with explicit nulls when inapplicable. Allowed
actions are approve, edit_and_approve, reject, keep_separate, defer, reopen, supersede; method is
user, expiry or derived_claim_resolution. Generated hook/trigger outcome is labelled separately
from deliberate action. This is local factual provenance awaiting later authentication, never
proof of a historical signature. Terminal transition without its required domain rows fails
closure validation. Other facet.update operations have no reviewProof.

One raw transaction can contain multiple operations but one event and sequence. Preserve actual
stored UUIDs/times in all forms; expected state describes what the transaction observed, not a
future user's intention. JSON integer row fields are encoded as decimal strings except booleans
and fixed protocol enums. The reducer must use the closed catalog and codec, not arbitrary SQL
row replication. P2 interprets these facts through validation/reconciliation, never executes them
as peer-selected SQL. The initial snapshot additionally carries legacy records whose lifecycle
cannot be expressed as newly executed user actions.

## 7. Immutable representation, integrity and later authentication

Recommend RFC 8785 JCS with a restricted typed vocabulary: fixed ASCII field names, no floating
point values, no duplicate keys, finite small protocol versions, and exact UTF-8 strings. UUIDs
are canonical lowercase spellings already assigned by native storage; preserve existing valid
legacy IDs including v4-bootstrap v8 revision IDs, not just new UUIDv4. All origin counters,
ordinals and provenance offsets are validated nonnegative decimal strings on any wire/TS seam
(no leading zeroes except "0"); decode with checked native integer conversion. Boolean fields
are booleans. Bytes/hashes use specified lowercase hex strings in the core; SQLite stores binary.

```json
{"bundleId":"<uuid>","committedAt":"<original RFC3339>","dependencies":[],"eventId":"<uuid>","operationVersion":1,"operations":[],"originId":"<local uuid>","originIncarnation":"<activation uuid>","originSeq":"9007199254740993","previousEventHash":"<64 lowercase hex>","provenanceClass":"local_committed","rawEffectCount":"1"}
```

This is a shape illustration, not a valid event fixture: placeholders/empty operations are not
accepted. Each operation has a fixed kind/version, logical key, required immutable closure or
dependency refs, expected facet versions/before-hashes, and actual committed after-values.
Array order: dependency refs sorted by type/id; entity operations topologically ordered with
stable `(kind, logical-key)` ties; parent sets sorted without changing the root/child relationship;
evidence ordinals and source claim ordinals remain original. Hash a domain-separated byte string
`ASCII("ARTHUR-M05-LOCAL-BUNDLE-v1") || 0x00 || JCS(core)` using SHA-256. Core contains previous
hash but not its own hash or signatures. No Unicode normalization; Cyrillic, emoji, combining
marks, escaped controls and code-point offsets must round-trip exactly. Hash identical bytes on
retry; never rebuild bytes from today's mutable domain rows.

Object + initial revision + current pointer form an atomic creation closure (a strongly connected
reference group), not a forbidden revision-ancestry cycle. Order those groups topologically and
their members by stable kind/key, validating the entire group together. Do not demand that every
row-level FK form an acyclic graph. Original business timestamps are copied exactly; the new
committedAt is local finalization metadata, not proof of an exact physical commit instant.

JCS algorithm selection is concrete; Rust library/version, independent golden vectors and the
final typed operation codecs require review before implementation. Ordinary serde_json output
is not automatically a JCS conformance claim. A dependency-free Python/Node restricted-fixture
comparison is only a design probe, not production serializer/security certification.

P1b commits unsigned core bytes and integrity hashes. Signing state is DERIVED: no membership
or no corresponding later attestation => unbound/unsigned; key unavailable => recoverable local
status; verified attached envelope => eligible only under its network policy. Do not add a
mutable signed flag to immutable bundles. Local save never waits for keys or enrollment.

A later envelope binds `networkId, membershipEpoch, signerDeviceId/key fingerprint,
originId/incarnation, eventId/bundleId/seq, coreHash, previousHash, attestationClass, attestedAt`
using an approved domain-separated signing format. `originDeviceId` in the earlier illustrative
wire shape is authenticated through this binding; it must not replace the pre-pairing local
origin UUID or be inferred from an IP/name. Binding is explicit, not an assertion that a local
UUID itself is a cryptographic identity. Network membership/certificates and public-key suite
remain N1/N2 gates; no cryptographic implementation is added here.

Pre-pairing cores later get `local_history_attested`: a currently authorized device attests it
possesses those committed bytes at attestedAt. Historical v9 snapshot records get `legacy_attested`.
Neither claims that the action was signed, authorized by that network or reviewed on the future
device at the historical timestamp. Old signed envelopes retain their original author/network;
a new network attestation does not rewrite them. Unsigned/core-only data never exports as
authenticated knowledge. Crash/key-lock/revocation during signing leaves immutable core intact;
retry signs the same hash or returns needs-attention. No network await within SQLite.

## 8. Candidate resource limits and admission

| Resource | Candidate implementation bound / consequence |
|---|---|
| One local canonical bundle | 4 MiB, 4,096 observed effects, 256 external dependency references, depth 16; exceeding fails the entire local mutation visibly |
| Transaction observation spool | 8 MiB UTF-8 before+after images; no unbounded memory collector; SQL counter checks plus checked native arithmetic |
| Pending bundle payloads | 256 MiB logical bytes per installation, including unsigned/unpaired data; warn at 80%, fail at bound rather than silently discard future changes |
| Other journal metadata | 64 MiB logical budget for headers/fences/heads/incarnations plus allocator reserve; count metadata too, not only payload. Bound aggregate DB free-space requirements natively |
| Baseline image | 32 MiB, 20,000 logical records, each <=256 KiB, capture transaction watchdog 2 seconds candidate; abort/retry rather than expose partial history |
| Snapshot staging | At most one admitted pending/materialized/ready image in the initial implementation; 64 MiB reserve for image+packing scratch; explicit retirement review needed for replacement of retained ready image |
| Chunk/frame | Retain approved 256 KiB snapshot chunk / 1 MiB frame candidates, 64 events/batch additionally bounded by encoded bytes. No event splitting into independently applied transactions |

The earlier 256 KiB **atomic bundle** candidate is NOT silently retained as a universal local-save
limit. A 12-object distillation can duplicate title/body in object + revision records and include
decision/claim/proposal closure; worst-case JSON escaping expands a code point to six bytes.
§13 records fixture sizes. Recommend 4 MiB LOCAL durability, with an explicit G4 decision for
bounded authenticated multi-frame atomic staging of >256 KiB cores. Until approved/implemented,
exporter must retain them and report `EXPORT_LIMIT_UNSUPPORTED`, never truncate/re-origin/split
the business transaction. This changes no currently shipped wire contract because none exists.

Relation batches and several historical collections do not currently have a universal small
batch bound; no honest fixed journal cap can promise acceptance of every arbitrarily large
previously possible request. Proposed journal/quota errors are a storage-contract decision for
SQL review. Measure serialized maximum-domain fixtures and real device latency before fixing
limits. The snapshot watchdog is a candidate responsiveness bound, not a measured guarantee.
Reject oversize with a recoverable local error; local saves can continue when only bootstrap is
oversize, while pending-journal hard exhaustion deliberately fails further replicated mutations.
Never delete existing knowledge or ignore journaling to make space. No unlimited-retention claim.

## 9. Later persistence: explicit migration gates, not v10 objects

Do NOT create the following tables in P1b: no pairing/importer/peer presently owns their rows.
These candidate DDLs define compatibility and review needs rather than speculative empty v10
tables. Each later migration must finalize FKs to its actual trust/receipt tables and validate
authenticated scope before accepting writes. IDs/hashes/seq use the same encoding and bounds.

```sql
-- later-auth-and-delivery, NOT part of candidate-core/v10
CREATE TABLE sync_attestations (
    network_id TEXT NOT NULL,
    event_id TEXT NOT NULL REFERENCES sync_bundles(event_id),
    signer_id TEXT NOT NULL,
    membership_epoch INTEGER NOT NULL CHECK(membership_epoch>=0),
    attestation_class TEXT NOT NULL CHECK(attestation_class IN ('local_history_attested','origin_signed')),
    envelope_bytes BLOB NOT NULL CHECK(length(envelope_bytes) BETWEEN 1 AND 16384),
    envelope_hash BLOB NOT NULL CHECK(length(envelope_hash)=32),
    PRIMARY KEY(network_id,event_id,signer_id,membership_epoch)
) STRICT;
CREATE TABLE sync_peer_progress (
    network_id TEXT NOT NULL,
    peer_id TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    incarnation TEXT NOT NULL,
    ack_seq INTEGER NOT NULL CHECK(ack_seq>=0),
    ack_hash BLOB NOT NULL CHECK(length(ack_hash)=32),
    ack_proof BLOB NOT NULL CHECK(length(ack_proof) BETWEEN 1 AND 16384),
    needs_rebootstrap INTEGER NOT NULL CHECK(needs_rebootstrap IN (0,1)),
    PRIMARY KEY(network_id,peer_id,origin_id,incarnation)
) STRICT;
CREATE TABLE sync_received (
    network_id TEXT NOT NULL,
    origin_id TEXT NOT NULL,
    incarnation TEXT NOT NULL,
    origin_seq INTEGER NOT NULL CHECK(origin_seq>0),
    event_id TEXT NOT NULL,
    bundle_hash BLOB NOT NULL CHECK(length(bundle_hash)=32),
    committed_result TEXT NOT NULL CHECK(committed_result IN ('applied','conflict_retained')),
    receipt_bytes BLOB NOT NULL CHECK(length(receipt_bytes) BETWEEN 1 AND 262144),
    PRIMARY KEY(network_id,origin_id,incarnation,origin_seq),
    UNIQUE(network_id,event_id)
) STRICT;
CREATE TABLE sync_compaction_checkpoints (
    origin_id TEXT NOT NULL,
    incarnation TEXT NOT NULL,
    through_seq INTEGER NOT NULL CHECK(through_seq>0),
    through_hash BLOB NOT NULL CHECK(length(through_hash)=32),
    retained_snapshot_id TEXT NOT NULL REFERENCES sync_snapshots(snapshot_id),
    authenticated_checkpoint BLOB NOT NULL CHECK(length(authenticated_checkpoint)>0),
    PRIMARY KEY(origin_id,incarnation,through_seq)
) STRICT;
```

- Attestations are immutable, append-only, idempotent by composite key + identical envelope hash;
  conflicting bytes for the same envelope identity fail. PK serves eligible envelope lookup;
  native validates membership, signer, exact core hash, attestation time and revocation.
- Peer progress is local delivery truth. PK serves resume and per-peer retention scans; add
  `(origin_id,incarnation,ack_seq)` only when active-peer retention query exists. Monotone contiguous
  ACK requires a real authenticated proof within sent range/hash; retry/session counters belong
  to scheduler metadata, not knowledge. Sending, signing and RAM receipt never advance it.
- Received PK and unique event key detect replay/forks: same identity+hash yields saved receipt,
  mismatch rejects/quarantines; domain apply OR full conflict retention and receipt commit together.
  Retain original incoming bytes/proofs in the future incoming ledger/conflict store before ACK.
  receipt_bytes alone is not that ledger. Reject unsupported materialization without applied ACK.
- Compaction requires every active enrolled peer's committed range OR an authenticated retained
  baseline plus explicit needs_rebootstrap. Retain per-origin identity/hash/revocation checkpoints
  and unresolved conflict proofs. Only a separately reviewed migration/API may lift v10 deletion
  guards, prune fences/cores and redirect derived heads to retained checkpoints. No domain-history
  pruning, FK disabling or unvalidated DELETE bypass. On checkpoint/signing failure keep originals.

## 10. Migration, activation and bounded historical bootstrap

### 10.1 Forward migration and activation are different operations

v10 DDL creates tables, constraints, closed-catalog observers and guards only. It must not walk
historical records, generate business IDs, replay create/review commands, sign actions, alter
archived projects or rewrite v1-v9. The existing migrator wraps the new step and version bump
in one tx; failure leaves v9 usable. Ordinary CREATE detects unexpected name collision instead
of silently adopting unknown tables.

After successful schema open, while holding the P1a owner and before publication, begin a short
native initialization tx: create installation origin if absent, seal prior active incarnation,
insert fresh incarnation, update singleton pointer. Commit; then admit local operations via
JournalTx. If initialization fails, publish no runtime; return storage error. Historical bootstrap
may remain pending indefinitely without making local Capture saves depend on pairing/network.
Observers reject accidental writes without context/active initialization. P1b migration, wrapper
coverage and activation ship together; do not release the schema-only intermediate commit.

Fresh database runs all ordered old steps first (including fixed Inbox), then v10; even a fresh
installation has Inbox baseline state to include. Repeated migration open adds no schema or
business rows, but each NEW owner activation intentionally adds/seals incarnation metadata.

### 10.2 Consistent image, high-water and catch-up

1. Persist a snapshot job with new snapshot UUID, pending state, requested_at and full profile.
   This is local metadata, not a fake historical event. Reserve bounded staging capacity.
2. Acquire existing store mutex and BEGIN IMMEDIATE. Capture the full local per-incarnation tip
   vector H (including sealed tips), plus profile/codec version and facet versions. Within THIS
   SAME transaction enumerate all twelve projections AND the baseline metadata/covered journal
   records specified below in deterministic key order, encode logical rows retaining original
   IDs/times/Unicode, and insert snapshot_rows. No second connection or
   sqlite-file copy. Validate row/byte/time limits and closure, then set materialized with exact
   boundary_bytes/count/bytes. Commit the whole image atomically. Writers wait during this bounded
   capture; no promise of simultaneous mutation on the same connection.
3. Release lock. Pack immutable staged rows, not live rows, into deterministic <=256 KiB chunks.
   Read bounded pages under the same owner; do CPU/chunk I/O outside write transactions. Manifest
   fixes snapshot ID, profile, codec, ordered chunk hashes/counts, entity counts, closure digest,
   baseline facet versions, and H. Native verifies all staging totals and exact manifest coverage,
   then atomically transitions materialized -> ready. No network or provider work in these steps.
4. Writes admitted after capture commit receive later origin seqs in their activation and remain
   journaled while packing proceeds. Export snapshot + events strictly beyond each component of H.
   A restart creates a new incarnation absent in H: export that stream from seq 1. A ready snapshot
   with old tip H remains a coherent image; catch-up reconciles subsequent changes, never rereads
   mutable rows into an old manifest. Boundary duplicates are verified as duplicates, not re-created.
5. Authentication/disclosure is later: snapshot locally covers pre-M05 history as legacy_attested;
   its manifest receives a network-bound envelope only under explicit sharing consent. Signing
   historical state now does not fabricate historical approval signatures. No P1b export exists.

The closed snapshot record catalog extends the twelve domain projections with:

- `@origin`, key `[origin_id,incarnation]`: original identity/sealed tip metadata, with sequence
  strings. H is also fixed in the manifest, not inferred from later local cursors.
- `@facet`, key `[entity_kind,canonical_entity_key,facet]`: causal writer reference and state hash
  as of H, including relation tombstone heads. A hash alone does not authenticate a missing fact.
- `@bundle-fragment`, key `[event_id,decimal_fragment_index]`: all RETAINED local bundle cores at
  or below H, split deterministically into raw fragments of at most 128 KiB, each wrapped as a
  versioned JCS record with event ID, fragment index/count, total core length, whole-core hash and
  base64 fragment bytes. Each encoded row fits 256 KiB; fragments are packaging, not new events.
  Manifest binds complete ordered fragment groups; reassemble/hash/validate the WHOLE original
  core before treating its operations as present. No partial apply or ACK of a fragment.

Including covered cores preserves observed-remove tombstones and local review/mutation facts
that final domain rows alone cannot reconstruct. Absence of a relation from a snapshot is NOT
an observed-remove instruction. P1b prunes nothing, so this is a complete, conservative definition;
future authenticated compaction may replace covered cores only with reviewed equivalent proofs.
The duplicate core history/fragments count against the SAME 32 MiB/20,000-record snapshot budget;
larger histories may therefore require the explicitly deferred larger-image design. Oversize
core export still requires G4 multi-frame atomic staging approval, not a silent protocol change.
Later authenticated envelopes/proofs accompanying those cores belong to the auth/P2 extension.

Local baseline never ships sync preferences, active project, FTS, embeddings, operational failures or keys.
For future incoming origins, H must also include contiguous durably applied/conflict-retained
received watermarks and baseline coverage. That extends the manifest via the P2 reviewed ledger;
do not pretend v10 has received remote operations. Source version vectors do not imply global
truth or remotely applied ACKs.

At 32 MiB/20,000 records/2-second capture budget, an oversized installation gets
`SNAPSHOT_TOO_LARGE`/`SNAPSHOT_CAPTURE_BUDGET`, no partial ready manifest. Local journaling continues.
This intentionally chooses a bounded consistent-image pause over a new MVCC/COW subsystem or
inconsistent multi-transaction scan. A larger installation requires a separately reviewed
resumable visibility/COW design; simply committing pages and reusing the first H is incorrect.

### 10.3 Recovery points

| Death/failure window | Durable state / recovery |
|---|---|
| During DDL/version bump | SQLite transaction rollback; reopening v9 reruns v10, no half schema |
| DDL committed, origin initialization not committed | Tables exist; observers prevent domain writes without active context; next owner initializes a fresh incarnation |
| Domain SQL/effect spool/final encoding/quota/hash/append fails | Roll back entire JournalTx; no successful domain save, sequence or orphan bundle |
| COMMIT fails deferred FK / disk full | Explicit rollback; do not return success while transaction is still open |
| Domain+bundle committed, before invalidation | Data/event survive; reread on next mount/restart; no invented second event |
| Commit before signer/send/ACK | Exact core remains unsigned/pending; later retry identical IDs/hash. No key needed for local recovery |
| Pending snapshot before/during image capture | Pending request survives; capture rows/H/materialized marker all roll back; retry with a new snapshot ID and abort old job |
| Materialized image before/during chunk packing | Fixed immutable rows/H survive; deterministic repack/resume exact manifest; journal catch-up remains available |
| Ready image / lost chunk response | Resume same manifest and chunk hashes; staged receiver data is not publication or applied ACK |
| Snapshot retention/quota cleanup interrupted | Cleanup only permitted aborted transient rows in P1b. Ready retirement/compaction waits for later authenticated policy |
| Storage owner killed / Android _exit | SQLite handles transaction recovery; next owner uses fresh incarnation. No destructor/final network flush assumed |

Local pre-upgrade backup is an optional explicit recovery operation while the app is quiescent,
not a Sync transport. Downgrading a live v10 DB is unsupported; v9 binary must refuse it unchanged.
Forward fix is preferred after new writes. Restore a deliberately chosen backup only with
fresh incarnation and future cursor rebootstrap; never automatically replace current knowledge.

## 11. Historical importer gate — intentionally not implemented

The journal retains facts/proofs that a future importer needs, but a lossless event ledger does
not make ordinary v9 INSERT paths historical import APIs. Older-base proposals, archived project
children, evidence arriving after descendants, and concurrent terminal outcomes still violate
creation-time/projection guards. Capture all original identities and results now, so importer
can later validate a complete dependency closure without calling normal create/review functions.

Specific P2 decisions required:

- An incoming ledger/conflict store retains BOTH concurrent terminal outcomes and signed head
  alternatives; one terminal v9 row cannot represent their union. Do not overwrite its winner.
- Reviewed historical reconstruction must preserve immutability, FK/DAG/spans/review proof and
  distinguish creation-time guards from historical state. No packet-controlled import flag,
  trigger disabling, INSERT OR REPLACE or temporary project unarchive/review command replay.
- v10 observers are local-only by design. P2 needs a forward extension of NEW journal context,
  coverage targets and derived heads so authenticated incoming apply points to its incoming
  receipt/ledger instead of creating a new local-origin event. Change only reviewed new metadata
  guards; do not edit old migration texts or weaken live v1-v9 creation checks. Provenance comes
  from a native validated capability, never a mode chosen directly by a network caller.
- Historical data may require bounded atomic publication or a reviewed resumable visibility model.
  If no correct mechanism is approved, return `IMPORT_POLICY_UNSUPPORTED` for full profile, retain
  unacknowledged originals, and do not advertise partial full synchronization.
- Relation aliases/observed-remove projection, revived archives, approval conflicts and provider
  eligibility suppression remain P2/G3/G6 gates. Imported data cannot trigger AutoOrganize, Graph
  inference or paid semantic indexing, including through existing polling workers with consent ON.

These are explicit later migration boundaries, not reasons to regenerate IDs or omit records now.

## 12. Implementation-ready proof matrix

Status vocabulary: **D** = isolated design SQL/serialization probe possible now; **P1b** = requires
native implementation; **P2/Auth/Platform** = later gate. A D pass is not a P1b runtime test pass.
Use temporary synthetic data only, no paid providers, no real user database.

| ID / gate | Setup and operation | Observable assertion |
|---|---|---|
| M01 D/P1b | Empty database; execute untouched v1-v9 then candidate v10 in ordered transactions | user_version=10 only after full step; Inbox retained; exact new objects; FK/integrity clean |
| M02 D/P1b | Populated v9 fixture: Cyrillic/emoji/combining Capture, source/root/branch/merge, system evidence+descendant, archived project, stale/terminal proposal; migrate | Every original typed row/immutable fingerprint and span identical; no redistillation or synthetic approval |
| M03 D/P1b | Reopen latest twice / create fresh runtime each time | No schema/business duplication; distinct fresh incarnations, sealed old tips; no origin/sequence reuse |
| M04 D/P1b | Inject failure at final DDL, name collision, version bump; reopen | Entire v10 step absent, user_version still 9, original fingerprints equal; retry succeeds |
| M05 D/P1b | Run FK check, integrity check, FTS consistency after fresh/populated upgrade | FK rows empty, integrity ok, derived index still consistent, no history-trigger changes |
| M06 P1b | Old v9 migrator opens populated v10 fixture | Typed future-schema refusal before mutation, unchanged file/fingerprints |
| T01 D/P1b | Valid Capture INSERT with context then fail bundle insertion/hash/quota; rollback | No Capture/fence/spool/bundle/tip change; no success invalidation |
| T02 D/P1b | Valid domain INSERT then delete context and attempt COMMIT without bundle | Deferred fence FK rejects COMMIT; explicit rollback restores all domain state |
| T03 D/P1b | Invalid archived-project/stale CAS/span write after context; rollback | No new event or consumed committed sequence; existing valid state unchanged |
| T04 D/P1b | Two actual mutations then one final append / nested identity helpers | One bundle/one stream seq, all actual rows, evidence/hook/trigger closure captured |
| T05 D/P1b | Same-value move, repeated distillation, same relation, same terminal review | No event for true no-op; repeated defer with changed updated_at/due date DOES journal despite applied=false |
| T06 D/P1b | Two threads use same runtime and release a barrier into create | Exactly two successful unique next seqs; no second owner; failure consumes no committed seq |
| T07 D/P1b | Remove eligible model edge + add replacement with stale/skipped context | Bundle matches actual removed IDs and actual additions; no user edge tombstone; no intent-only deletes |
| T08 D/P1b | Accept claim with/without proposal hook; reject/defer/reopen/separate/expiry | Final claim/proposal/revision/evidence all agree; trigger supersession included exactly once; local failure/FTS excluded |
| T09 D/P1b | Evidence ordinal retry / identical and conflicting same span | Identical evidence no duplicate event; conflict rolls back; preserved scalar offsets and retraction ancestry |
| R01 P1b | Kill child before COMMIT at domain/effect/append boundaries; reopen | Either whole prior state or whole new domain+bundle; no committed orphan; new incarnation |
| R02 P1b/Auth | Kill after COMMIT before signing; restart with signer unavailable then available | Save remains; same event/bundle/core/hash; no key/network required; unsigned not exported authenticated |
| R03 D/P1b | Restore older copied local recovery fixture while stopped; activate | Never append old active incarnation; fresh CSPRNG incarnation at seq1 for next write; stale ACKs cannot authorize new stream |
| B01 D/P1b | Capture image H including covered core fragments/tombstones; mutate source before chunk packing; pack staged rows | Snapshot represents H exactly, later event >H catches change, chunk hashes stable; no mixed image or missing observed remove |
| B02 D/P1b | Kill capture mid-image and packing mid-chunk | No partial materialized/ready image; pending retry or deterministic repack of exact materialized image |
| B03 D/P1b | Oversized image/record count/time budget or storage full | Typed limit, no partial ready baseline; local saves journal until their own quota is reached |
| S01 D/P1b | Counter near 2^53 and i64 max; Unicode/escaped controls/dependency order | Decimal string exactness; checked overflow rotates stream before write; identical canonical bytes/hash across golden fixtures |
| S02 D/P1b | Byte mutation, same tuple different event/hash, bundle UPDATE/DELETE, sequence jump/reuse | Constraint/native error; tip/domain unchanged; same event retry returns prior verified result only |
| A01 Auth/P2 | Pre-pairing events later bound to A, key lost, join B, revoke origin | Explicit local-history/legacy attestation classes; no fabricated past signature, stale proof or implicit re-sharing |
| I01 P2 | Stale-base/archived/evidence-descendant/concurrent terminal historical fixtures | Full validated closure/conflict retention or typed unsupported; no old trigger weakening/provider invocation/premature ACK |
| C01 Auth/P2 | Slow absent peer; authenticated checkpoint then pruning interrupted | Explicit rebootstrap; no data loss, lost fork checkpoints or falsely advanced delivery cursor |
| P01 Platform | Windows then actual Android/Linux process death/disk-full/filesystem flush tests | Platform-scoped evidence only. Process kill is NOT a hardware power-cut proof; test VFS fault injection and device storage behavior separately |

Reuse/extend `migrations.rs` v8/v9 fingerprint, failure, interruption and old-binary tests;
`runtime/tests.rs` child-process/ownership fixtures; `revision_cas_tests.rs`,
`evidence_store_tests.rs`, `identity_store_tests.rs`, `proposal_store_tests.rs`, integration-store
stale/model-edge tests and `distillation/evolution_tests.rs`. Preserve current baseline failures;
never edit expectations/corpus merely to make a gate green.

## 13. Executed design checks and limits

This section records only actual Task 05 checks. Candidate
SQL was exercised only in synthetic in-memory scratch databases, never installed in the app or user data.
Native migration/journal/signing/bootstrap code does not exist yet. Historical P1a results
(901/5/22 native, 881/same5/22 isolated baseline, 561 frontend, 86/2 architecture) remain historical
exceptions accepted for Windows continuation, not evidence of P1b implementation.

Executed using Python 3.14.5 / SQLite 3.50.4, plus Node 24.13.1 for the restricted serialization
comparison. A temporary design validator extracted the four SQL blocks directly from THIS
document, extracted untouched v1-v9 SQL constants directly from migrations.rs, checked the closed
catalog against actual PRAGMA table_info, and expanded all 36 observers using §5. No dependency,
production migration, Rust source, public contract or user database was changed.

| Actual design probe | Result |
|---|---|
| Candidate core/guards/example + 36 catalog observers over populated synthetic v9 | PASS; original twelve projections fingerprint-identical, schema marker 10 in scratch DB only |
| Empty -> existing v1-v9 -> candidate v10 | PASS; original Inbox retained, constraints installed |
| Injected failing DDL inside migration transaction | PASS; rollback leaves version 9 and zero partial sync objects |
| Domain write without active context | PASS; SQL abort, no stored Capture |
| Domain write, delete context, COMMIT without bundle | PASS; deferred fence FK rejects COMMIT, explicit rollback removes domain change |
| Injected BEFORE bundle-insert failure | PASS; domain/effects/fence/sequence all roll back |
| Same-value project membership UPDATE | PASS; zero observed effects, no bundle |
| Sequence gap then rollback and retry | PASS; gap rejected, next valid event uses seq 2 after seq 1, no committed sequence consumed by failure |
| Bundle/fence UPDATE/DELETE attempts | PASS; immutable/no-compaction guards abort |
| Real existing v9 claim-resolution AFTER trigger | PASS; final proposal supersession observed exactly once within the same completed bundle |
| Partial snapshot-image transaction rolled back | PASS; pending job remains, zero partial rows published |
| Snapshot origins + covered-core fragments | PASS; all included pre-H cores reassemble byte-for-byte |
| Fixed staged image then subsequent domain+journal commit | PASS; staged rows unchanged, new event strictly >H and absent from old image |
| SQL seal + fresh incarnation activation | PASS; prior tip retained, fresh active incarnation distinct |
| Later auth/delivery/received/compaction DDL on scratch DB | PASS syntax/FK structure only; no authentication, importer, ACK or compaction executed |
| Final foreign_key_check / integrity_check | PASS: zero FK violations / ok |
| Maximum single-object legacy history: 1,000 revisions | PASS candidate sizing: 13,697,887 bytes / 2,004 domain records; maximum row 120,162 bytes; v9 FK/integrity checks clean |

There are **17 isolated SQL probe groups**, not 17 native runtime tests. The populated fixture
includes original Cyrillic/emoji/combining text, source/root, automatic evidence with a descendant,
an archived project, an older-base open proposal and a rejected terminal proposal. It does not
prove every native historical-import or migration fixture. The capture rollback simulation is
not a child-process kill, power loss, production bootstrap implementation or platform acceptance.
The probe's bundle builder tests SQL admission/atomicity, not the final typed operation codec.

Numeric fixture: twelve maximum-title/body object + source + initial-revision creates, using
valid non-whitespace control characters to exercise six-byte JSON escaping, encode **329,420
bytes for those 36 operation bodies plus core header**, before run/decision/dependency additions.
The associated synthetic v9 objects/Capture/root/source rows satisfy SQLite integrity checks;
native field/span limits are also checked in the fixture. This lower bound alone disproves a
universal 256 KiB local bundle assumption; it does not prove all allowed actions fit 4 MiB.
The 1,000-revision legacy fixture exercises the current per-object history cap with maximum
title/body escaped strings and a 20,000-code-point Capture; it fits the candidate baseline
budgets. It has no post-M05 covered-core history. Multiple such objects, journal duplication and
metadata can exceed the baseline cap; larger-history admission remains an explicit review gate.

Restricted Python/Node golden fixture (fixed ASCII keys, exact strings, no floats):

```json
{"a":"Идея 🦀 é\u0001","counter":"9007199254740993","null":null,"truth":true}
```

Both emitted identical UTF-8 and SHA-256
`7205e06a4185f1ea44952999078ace992134da099c7f2451bacd9b85d7a8efb7`.
This is one interoperability probe, not full JCS conformance/security acceptance. The large
counter stayed a string; code-point content was not normalized. Full Rust/native codecs,
production transaction integration, SQLite build/version matrix, disk-full and process-kill
recovery, representative mobile performance, authentication and historical importer remain
UNVERIFIED. Run matrix §12 after the respective implementation gates, not from historical P1a
counts. Relative links, balanced fences, whitespace and documentation-only staged scope are
checked separately before the optional documentation commit.

## 14. Review decisions and implementation commit breakdown

Review decisions: SQL coverage-fence cost and closed trigger expansion; per-activation incarnation
policy; exact JCS typed codecs/library and SHA-256 dependency; quota/error contract; candidate
4 MiB local bundle versus staged export budget; 32 MiB bounded snapshot pause and larger-history
path. N1/N2 key/membership authentication and G3 historical importer are still explicit separate
gates. No unsafe fallback, blanket trigger bypass, second SQLite owner or network-required save.

Proposed LOCAL implementation sequence after SQL review (not implemented by this document):

1. `feat(m05): add forward journal persistence and migration proofs` — append v10, closed catalog
   observers/guards and table tests; preserve v1-v9 hashes. Include migration/repeat/refusal fixtures.
2. `feat(m05): add transactional journal storage APIs` — private JournalTx, effect reduction,
   canonical codecs/hash vectors, sequence/activation/quotas/derived facet heads; no live key/network.
3. `feat(m05): journal capture project lineage and graph writes` — convert all corresponding
   autocommit/deferred wrappers, not commands; standalone evidence and relation batch coverage.
4. `feat(m05): journal evolution claims and review outcomes` — generic identity owner integration,
   distillation (including zero objects), decisions/proposals/hooks/trigger supersession; no-op proofs.
5. `feat(m05): add bounded historical baseline and restart recovery` — pending/materialized/ready
   snapshot, exact H/chunk manifest, fault/kill/disk-full/restore fixtures and zero-provider spies.

The intermediate migration/API commits are review units, NOT independently releasable binaries.
Ship only once every authoritative writer is instrumented, all mandatory native proofs pass for
supported platforms, and owner-approved limits are honest. Importer/authentication/ACK/retention
implementation belongs to later reviewed commits. P1b work must not auto-start from this design.

## 15. Architecture review answers and primary references

| Question | Answer |
|---|---|
| Source of truth | Native SQLite domain + immutable committed replication facts; heads/indexes are derived |
| Ownership | P1a owner only; JournalTx owns domain commit; signer later appends envelopes, never business rows |
| Dependency direction | Commands/services -> storage contract; encoding has typed values only, no UI/Tauri/network dependency |
| Boundary | Typed operations/core bytes/status; no connection, SQL, paths, credentials or implicit network authority crosses |
| Failure | Transaction rollback and honest save error; unavailable signer/export does not block saves; quotas fail closed |
| Lifecycle | Fresh activation incarnation, sealed tips, immutable core, resumable bounded snapshots; no destructor reliance |
| Test seams | Synthetic stores, injected clock/UUID/hash faults/quotas/commit barriers/child kill; no paid models |
| Compatibility | Forward v10; old binary refusal; v1-v9 unedited; explicit P2 historical reconstruction gate |
| Observability | Counts/bytes/typed failure/last safe boundary; no raw Capture/core/key content in logs |
| Security | Hash is integrity only; later authenticated envelopes; explicit legacy attestation, no export while unsigned |

Primary references consulted for this proposal:
[SQLite deferred foreign keys](https://www.sqlite.org/foreignkeys.html#fk_deferred),
[SQLite triggers and RAISE](https://www.sqlite.org/lang_createtrigger.html),
[SQLite atomic commit and failure assumptions](https://www.sqlite.org/atomiccommit.html),
[RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785).
They support the constraint/canonicalization choices; they do not certify Arthur's future
implementation, selected cryptographic libraries or Android/Linux durability.
