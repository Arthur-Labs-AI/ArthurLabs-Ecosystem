# M05 Phase 0 — Logical Sync Contract v1

**ARCHITECTURE APPROVED — implementation/security evidence gates remain**

Audit date: 2026-10-21 (Europe/Sofia). No Sync implementation, migration, dependency or public API change is authorized by this document. Companion: [LAN personal network design](m05-lan-personal-network.md).

## 1. Scope, evidence and baseline

The current user-approved target is **Arthur Desktop ↔ Arthur Android on a reachable local Wi-Fi/LAN**. Desktop listens and Android normally dials; those are connection roles, not data-authority ranks. Both installations retain authoritative local commits and work offline. Arthur Box, a separate Linux Home Node, NetBird/Tailscale, sidecars, relays, internet sync, new AI features, Graph v2 and EMG are outside v1. Future adapters must fit the same engine; none is implemented in P0.

Labels used below:

- **VERIFIED:** source or command output inspected during this audit.
- **RECOMMENDED:** concrete design for owner review, not implemented behavior.
- **GATE:** a decision or technical proof required before the affected implementation.

VERIFIED Git baseline after `git fetch origin`:

| Item | Observed value |
|---|---|
| Required working branch | `feature/nodes-integration` |
| HEAD | `e1879f6fa2e34d2e54367c301a372a6bd6b56b44` |
| `origin/dev` | `214e8a815a754609d28225c8f5e29825852db2fe` |
| `origin/dev...HEAD` left/right commit count | `0 / 6` |
| Initial status | Clean; up to date with `origin/feature/nodes-integration` |
| Existing files at these two proposed document paths | Absent before this task |

The six commits change Thoughtspace UI, appearance, fonts, screenshots and design notes. They do not implement M05. [src/sync](../../src/sync/README.md) and [index.ts](../../src/sync/index.ts) are boundary-only. There is no native outbox, validated peer importer, pairing, discovery, listener or background sync worker.

Historical drift: the [v1 closure](cognitive-runtime-v1-final.md) still says the feature branch is not merged, although its code is in the audited integration ancestry. Recall is implemented despite older README summaries. References to a canonical Home Node describe an earlier deployment intention and do not decide v1 authority. `providers/secrets.rs` uses Android Keystore through an adapter, but desktop currently uses `FileSecretStore` (plaintext app-private files, Unix mode 0600; Windows uses `fs::write`). Do not reuse that desktop implementation for Sync private keys or claim a platform keychain already exists.

## 2. Canonical ownership and architectural seams

VERIFIED: `lib.rs` opens one `CaptureStore` on app-data `arthur.db`; its Rust store modules share `Mutex<rusqlite::Connection>`. Opening enables foreign keys and `synchronous=FULL`. Migrations use `PRAGMA user_version`, with nine ordered steps and refusal of future schema versions. Normal UI access is `ArthurClient → desktop/mobile adapter → tauri-ipc.ts → Rust commands → store`.

RECOMMENDED dependency arrangement (names/locations require G1 approval):

```text
React feature → ArthurClient → controlled Tauri IPC → native composition root
                                                      |
                          +---------------------------+---------------------+
                          v                           v                     v
                    Sync coordinator             LAN adapter          OS scheduler
                          |                           |                     |
                          v                           v                     |
                    pure Rust engine ← authenticated transport contract ←--+
                          |
                    SyncStore trait
                          |
                 CaptureStore-owned adapter → same serialized connection → SQLite

packages/contracts: pure UI/wire shapes and validation vocabulary
src/sync: TS boundary/reference contracts and conformance fixtures; no runtime DB owner
```

Use one native Rust engine for both platforms, independent of Tauri handles, sockets and provider services. Initially it may live under `apps/arthur/src-tauri/src/sync/`, composed by `lib.rs`, with a store adapter inside `storage/`; a future crate extraction is optional. Root TypeScript must not import the app or open the app DB. Do not embed Node, duplicate the engine in TypeScript, or route Sync through `apps/api` or hybrid tools. Native traits take validated values, not a connection/path supplied by React or a peer.

`tests/architecture/boundary_rules.ts` already requires pure contracts, excludes frozen agentic imports and permits only `src/sync/transport/contracts` above the concrete transport layer. Those tests cover TS imports; add equivalent Rust dependency tests in implementation. Do not claim the present TS rules police Rust. UI remains network-free; production CSP stays limited to IPC.

### Legacy LAN reuse audit

VERIFIED: `src/runtime/hybrid/lan/protocol.ts` describes HR-03D model transport; `server.ts` serves model generation/streaming and optional explicitly bound tool execution. `auth.ts` extracts a pre-shared bearer token and compares fixed-size hashes using Node crypto. `client.ts` restricts non-loopback HTTP and rejects redirects. Those modules depend on Node buffers/HTTP, model gateway registries and frozen tool routes; none owns the native Tauri knowledge store or provides device membership, PAKE, logical journals or importer semantics. Reuse the **design lessons** (bounded reads, versioned typed errors, no redirects, nonlogged auth), not its endpoints, bearer trust model or imports. Any future extracted primitive needs a separate dependency/license/security review; v1 Sync does not import this subsystem.

Local authority is per installation and transaction. Replicated signed operations retain origin authority; causality, validation and explicit resolution determine their materialized view. No device may unilaterally rewrite another origin's immutable content. Network admin controls membership, not knowledge truth.

## 3. Verified native write-path inventory

Paths below are relative to `apps/arthur/src-tauri/src/`. Line references identify the audited HEAD and may drift. Every listed local operation that changes replicated data needs an event **inside its existing owning transaction**, including operations invoked without a UI command.

| Source and operation | Writes / identity and time | Existing atomic boundary | Required journal insertion point / dependencies |
|---|---|---|---|
| `storage/capture_store.rs:124` `create` | Capture UUIDv4 and RFC3339 now; original source/content | Single autocommit INSERT, guarded project lookup | Convert to one explicit domain+event transaction after approval; project exists/open |
| `storage/knowledge_store.rs:73` `record_distillation` | Run plus objects, source spans and initial revisions; object and revision UUIDs generated locally | One transaction; returns existing result if already distilled | One commit bundle after actual inserts, before commit; capture/project first; include zero-object completion |
| `knowledge_store.rs:140,155` `begin_distillation_in`, `insert_object_in` | Run time; deletes local failure; creates objects and initial lineage | Caller owns transaction | Cover identity-aware caller too; do not emit again in each nested helper |
| `distillation/evolution.rs` `commit_with_identity` | Decisions, objects or pending claims and proposals | `in_identity_transaction`, after slow provider work | Journal final persisted outcome only; no network while DB lock is held |
| `storage/lineage_store.rs:181,193,206,221` `update_object`, `create_revision_from`, `merge_revisions`, `revise_from_capture` | New UUID/time, parents, optional current pointer and text projection | One transaction per public operation | Capture actual old/new head; journal branches even when `make_current=false` |
| `lineage_store.rs:243,303` `revise_if_current`, `revise_if_current_in` | New revision if object/project/open-project/base guards pass | Immediate transaction, or caller's immediate transaction | Bundle with evidence and review proof at outer commit; stale failure emits nothing |
| `lineage_store.rs:256` `restore_revision` | New merge revision with current and restored target parents; no history deletion | Immediate transaction; expected-current guard | One revision/head event; source revision must exist |
| `storage/evidence_store.rs:177,297` `attach_revision_evidence_in`, `attach_revision_evidence` | `(revision_id, ordinal)` evidence identity, local created time; no UUID | Caller transaction or immediate wrapper | Include with owning revision before descendants; preserve retraction references |
| `storage/project_store.rs:222,235,253,270` create/rename/archive/restore | Project UUID at create; updated/archive times on transitions | One transaction; archive also clears device-local active project | Journal domain transition only; active-project row stays local |
| `project_store.rs:283,300` move Capture / KnowledgeObject | Project association changes; content/history unchanged | One transaction per move | Separate membership operation with prior version; never infer that Capture and object move together |
| `storage/relation_store.rs:117,130,171` create/record/`insert_all` | New edge UUID/time, kind/endpoints/origin; canonical logical-key dedup | Single transaction for batch; existing edge unchanged | Emit only created edges; endpoint identities required; record canonical semantic key |
| `storage/integration_store.rs:112` `apply_integration` | Adds model edges AND physically deletes/replaces model edges | One guarded transaction; focus/context revision checks | Journal real removals as tombstones and additions together; user/system edges excluded from deletion |
| `storage/identity_store.rs:254,410` decision and uncertain claim staging | Decision key `(capture_id, ordinal)` and time; claim UUID/time | `*_in` functions in immediate outer transaction | Include required run/decision/candidate closure; never forward raw provider payload |
| `identity_store.rs:468,523` hooked accept/separate | CAS revision+evidence+claim state, or new object/source/initial revision+claim state | Caller transaction; wrappers use `in_identity_transaction` at :586 | One complete bundle including proposal hook, not a second event per helper |
| `identity_store.rs` defer/reopen | Claim state/due/deferred/update time | Immediate wrapper or caller-owned transaction | Versioned state transition, not a replacement immutable claim |
| `storage/proposal_store.rs:175` `insert_proposal_in` | Proposal UUID/time, immutable draft, base and verification metadata | Caller identity transaction | Claim and proposal together; creation requires open claim/current base |
| `proposal_store.rs:594,704,715` `review_in`, review/resolve wrappers | Approve/edit-approve/reject/separate/defer/reopen; approval result and user-edited flag | One immediate transaction, idempotent terminal result | Capture reviewed head, actor, exact approved body/result revision; journal trigger-produced supersession too |
| `storage/organization_store.rs:39` failure record | Last local retry failure/time, no business identity | Autocommit UPSERT | Excluded operational state; never journal as shared knowledge |
| `storage/recall_store.rs` index/FTS/meta writes | Rebuildable search projections | Local storage operations / schema triggers | Excluded; local deterministic index maintenance only on import |

Local create helpers are **not import APIs**: `create`, `insert_object_in`, `insert_revision`, `insert_all`, uncertain-claim staging, proposal creation and claim separation generate replacement UUIDs and/or timestamps. A dedicated store-owned importer must accept validated original identifiers; it must not call these helpers unchanged.

## 4. Replication profile and exclusions

RECOMMENDED: negotiate an indivisible `knowledge-v1-full` capability for the initial release. A partial development harness may test captures alone but must identify itself as incomplete, never advertise full Sync. Share all knowledge projects of one installation, including archived history, only after explicit enrollment disclosure; per-project selection is deferred and needs a separate scope/dependency design (G2).

| Entity | v1 proposal | Source of truth / dependencies / exclusion reason |
|---|---|---|
| Projects, rename/archive/restore and Capture/object moves | Include | Stable IDs; fixed Inbox; explicit mutable operation versions |
| Captures | Include | Original UUID/source/content/time; project association separate |
| KnowledgeObjects and `object_sources` | Include | Stable object/source identity; current text is revision projection |
| Thought revisions, parent links, head decisions | Include | Immutable snapshots/DAG; explicit head ops, no clock winner |
| `revision_evidence` and retractions | Include | Exact source spans plus ancestry; preserve all ordinals |
| Relations | Include | Kind/direction/origin; also model-edge removal history/tombstones |
| `distillation_runs` | Include completion fact | Needed for dependency FKs and to prevent import re-distillation, including successful empty result |
| `identity_decisions` | Include validated domain audit fields | Required for pending claims; not whole model response or transport log |
| Pending claims, revision proposals, approval history | Include as one feature group | Preserve draft/review lineage and signed origin facts; no remote command execution |
| `seq` columns | Exclude from wire identity | Device-local insertion order; allocate locally, topologically |
| Recall FTS/embeddings/meta, counts, staleness, organization `running`/failure | Exclude | Rebuildable or local operational state; no provider work on import |
| Active project, appearance, Graph ledger/switch, AI/provider consent/config | Exclude | Device preferences and authorizations |
| Provider credentials, device/admin private keys, pairing code, local paths/audio | Exclude | Secrets/device-private state; never knowledge payloads |
| Sync cursors, retry schedule, AutoSync/Background preferences | Exclude from knowledge replication | Device-local operational truth |
| Public membership certificates and signed revocations | Separate security control plane | Deliberate authenticated distribution, not knowledge replication; private keys never leave their device |

## 5. Schema-v9 invariants and import blockers

VERIFIED constraints in `storage/migrations.rs` and matching native validators:

1. Capture identity/content/source/time are immutable; only `project_id` may change. Inbox has fixed ID `00000000-0000-4000-8000-000000000001` and cannot be renamed/archived/deleted. Inserts and moves require open projects.
2. `thought_revisions` and parent links refuse updates. Parent object must match; parent **local sequence** must precede child; cycles are rejected. Wire timestamps cannot establish this ordering. Existing object text/head must equal the referenced revision.
3. A normal edit/branch/merge reads and writes under the store lock/transaction but does not accept a caller's expected head. `revise_if_current_in` and restore explicitly check expected revision and project. Do not describe every existing edit as an exposed CAS API; adding UI stale-edit protection is a separate reviewed contract change if needed.
4. Evidence is immutable, attaches only to `system` revisions, has valid code-point spans/retraction ancestry, and cannot be added after a revision has descendants.
5. Pending claims depend on immutable identity decisions and valid same-project candidates at creation. They start open; accepted/separated states require committed proof. Proposals start open against the then-current base; terminal states cannot be overwritten. Claim-resolution triggers may supersede open proposals.
6. Relations are unique by canonical `(kind, source, target)`, not merely UUID. Independent creates can produce two UUIDs for the same semantic edge. `apply_integration` physically deletes only model edges, so final rows alone cannot reproduce all future removals.

**G3 — historical import is not solved by topological row order alone.** A stale historical proposal cannot be newly inserted with its old base into the ordinary v9 path. A previously archived project cannot accept its historical children as normal new writes. Evidence arriving after existing descendants also violates a creation-time guard. Concurrent accepted/rejected proposals cannot both fit one terminal-state row.

Recommendation: retain original signed operations in a durable incoming ledger and materialize only a structurally valid, reconciled domain view. Bootstrap stages a complete dependency closure and validates it before publication. Design a reviewed forward-only migration that distinguishes **historical reconstruction** from **new local mutation** for these specific creation-time checks. Preserve immutability, FK/span/DAG/approval proof checks in both modes; all existing live paths retain their stricter guards. The import context must be native-owned and transaction-scoped, never a wire flag, public SQL capability or global trigger-disable switch. A detailed SQL/validator proof and adversarial regression suite is required before selecting this mechanism. If that cannot be demonstrated without weakening v1, keep the affected profile unsupported and return `IMPORT_POLICY_UNSUPPORTED`; do not ship a silently partial full profile. No v1-v9 migration text is edited in P0 or proposed to be rewritten later.

## 6. Protocol v1 proposal

Transport supplies an authenticated, encrypted, bounded channel bound to `(networkId, peerDeviceId, membershipEpoch)`. An address, discovery result or TLS connection alone is insufficient. No 0-RTT mutations. Membership is checked before any private hello, manifest or cursor is disclosed.

Proposed message vocabulary: `Hello`, `Capabilities`, `MembershipUpdate`, `Summary`, `SnapshotOffer`, `SnapshotChunk`, `SnapshotCommit`, `Events`, `Ack`, `DependencyNeeded`, `ConflictSummary`, `Bye`, `Error`. Only pairing has a narrowly bounded pre-membership exchange, specified in Document B.

`Hello` negotiates protocol major/minor, payload schema, `knowledge-v1-full`, limits and membership epoch. App SQL schema version is diagnostic, not a wire version. A schema-v9-only binary has no Sync capability. Major mismatch, unknown required feature/operation/field, or unsupported profile fails closed without writes or cursor movement. Minor evolution requires explicit negotiation; no best-effort ignoring of approval/security fields. Require strict typed decode, reject duplicate JSON keys and invalid numbers; extensions use a negotiated namespace.

Illustrative event record (not a new public contract):

```text
networkId, protocolMajor=1, payloadSchema=1,
originDeviceId, originIncarnation, originSeq, eventId,
bundleId, operationKind, dependencies[], expectedVersions,
payload, previousEventHash, canonicalHash, originSignature
```

Use CSPRNG UUID event/bundle IDs, a never-reused per-device incarnation and transaction-allocated increasing sequence. Encode 64-bit counters as validated decimal strings at the JS boundary. Bind signatures to a domain-separated canonical encoding of network/incarnation/sequence/dependencies/payload; specify one canonicalization algorithm and cross-language golden vectors before implementation. Hashes detect collision/tampering; only authenticated signatures bind origin. `createdAt` is preserved content metadata, never a global ordering rule. Hash-chain checkpoints detect origin forks/truncation; restoration of a stale DB must rotate incarnation and rebootstrap rather than reuse a signed sequence.

Initial proposed limits (G4, measured with maximum-domain fixtures): 1 MiB encoded frame, 256 KiB atomic event bundle, 64 events/batch, 256 dependency IDs/event, nesting 16, maximum two active authenticated peer sessions per installation and one per peer. Existing limits such as 20,000 code points/Capture, 12 objects/distillation, 1,000 revisions/object and 8 merge parents still apply. Count UTF-8 bytes for transport and code points for domain fields; do not split one logical commit into partially applied fragments. Oversize valid historical bundles need a reviewed bounded staging format, not truncation. Bound pending bytes/disk and transfer time; pause with a visible storage-limit error instead of dropping unacknowledged knowledge.

## 7. Outbox, transactional durability and delivery

Recommendation: one event bundle per meaningful local domain transaction; it may contain several inseparable operations. Record actual generated IDs, previous versions and trigger effects, not the caller's intended request. Idempotent local no-ops produce no new event. Local canonical writes continue when Sync is OFF; changes are still journaled once the approved journal schema is installed so later catch-up is complete.

```text
LOCAL WRITE (same serialized CaptureStore owner):
  BEGIN IMMEDIATE
  validate existing local rules; perform domain mutation
  if mutation happened:
    reserve origin sequence; form canonical operation bundle
    persist immutable bundle + integrity/signature + delivery metadata
  COMMIT
  emit content invalidation; schedule peer work outside transaction
```

Signing-key unavailability must not lose a Capture or force networking into the write lock. Recommended variant: commit an immutable canonical bundle plus hash atomically, then sign it locally before transmission; unsigned events cannot be sent or ACKed as delivered. Signatures cover committed bytes and do not change domain truth. G4 must choose the signing strategy and test crash/key-lock windows. Journal disk failure rolls back the domain transaction and returns an honest save error; it does not return a false successful Capture. Disable Sync closes networking, not local recording.

Maintain per-peer, per-origin-incarnation contiguous applied cursors plus selective receipt/rejection metadata. Sending or receipt in RAM never advances an applied cursor. Lost ACK retries identical event IDs/bytes. A relayed original event is not re-originated or assigned new business IDs; membership permits future relay only through a new adapter policy, not internet routing in v1. Echo suppression uses origin/event identity.

`Ack` binds session, network, peer, origin/incarnation, committed high-water and bundle hashes. Verify the ACK is within data actually sent; persist sender delivery state transactionally. A socket write is not delivery proof. Keep conflict-retained ACK distinct from clean projection: a conflict can count as durably integrated only when its complete original data/proofs and a visible unresolved conflict are committed and the capability negotiates this meaning. Rejected or merely staged chunks are not applied ACKs.

## 8. Bootstrap, retention and recovery

For pre-Sync v9 data, generate a **logical** snapshot, never an on-disk DB copy. It includes all negotiated entities and immutable history, original IDs/times and locally attestable legacy provenance. A new device signature attests what it imported from its local legacy DB; it cannot prove historical human actions were cryptographically signed before M05 existed. Mark `legacy_attested` distinctly (G5).

Under the same store ownership, capture a consistent read image plus all per-origin high-water marks and a local change boundary. Spool bounded chunks to private temporary staging and release the DB lock before network I/O. Concurrent writes after that boundary remain in the journal. Manifest binds snapshot ID, profile, network, entity counts, chunk hashes, dependency closure and high-water vector. Reject missing/extra/altered chunks. Resume only the exact manifest; a changed source creates a new snapshot ID. Staging persistence is not publication.

Receiver validates all chunks and identities, then commits a coherent snapshot/merge through the store. For large histories, chunk staging plus one bounded publication transaction is the initial recommendation; an oversized publication must stop with `SNAPSHOT_TOO_LARGE` until a reviewed resumable visibility design exists. Do not expose half an object's DAG or a proposal without its proof. Concurrent receiver writes must be reconciled under version checks, never replaced by the sender's snapshot. Catch up strictly after captured high-water marks; duplicates at the boundary are harmless. Initial sync is bidirectional: neither side clears its existing DB.

Prune journal payloads only after every active enrolled peer has committed the relevant range OR a retained authenticated snapshot covers it and that peer is explicitly marked `needs_rebootstrap`. Pruning never prunes domain history, conflict evidence, revocation high-water or the identity/hash checkpoints needed to reject replays. An absent peer cannot force unlimited retention; proposed limits/cooldown and user-visible rebootstrap are G4 decisions. Keep a signed origin-history checkpoint and membership revocations across compaction. DB restore/key loss/reset must invalidate stale cursors and incarnation; do not treat old ACKs as proof for a new device.

Crash matrix:

| Crash point | Required recovery |
|---|---|
| Before local commit / journal failure | No domain success or orphan event |
| After local commit, before signing/send | Bundle remains; sign/send later without regenerating business IDs |
| Receiver staging only | No applied ACK; discard/resume bounded staging |
| During import | Entire logical bundle rolls back |
| After import commit, before ACK | Replay verifies same hash and returns the committed result |
| After ACK sent, before sender cursor commit | Sender retries; receiver no-op |
| After conflict retained | Original alternatives/proofs survive; UI remains needs-attention |
| Process death / network change / OS pause | Release session lease; restart from durable state, not an in-memory queue |

## 9. Validated importer and authenticated approvals

```text
receive bounded frame on authenticated session
validate schema, network, membership, origin signature, hash and dependency limits
BEGIN IMMEDIATE using existing native store owner
  recheck trust epoch, session cancellation and origin incarnation
  if event identity exists:
    equal hash => return previous committed result; different hash => reject/quarantine
  require predecessor/dependencies or return typed deferred dependency result
  validate immutable equality, Unicode spans, DAG, edge ownership and review proof
  stage/insert original identities via dedicated native import functions
  materialize causally safe changes OR retain complete alternatives + conflict record
  persist received identity/hash/result and cursor in same transaction
COMMIT
invalidate affected queries; send committed ACK
```

No `INSERT OR REPLACE`, regenerated IDs, arbitrary SQL, imported local paths or trigger disabling. Dependency order includes project/Capture → run → object+source+initial revision → topologically ordered revisions **with their evidence before descendants** → identity decisions → pending claims → proposals/review transition proofs; edges require endpoints. Cyclic object/current-root FKs are assembled within one transaction using the existing initial-object pattern and verified before commit. Some bundles span several groups; dependency graph validation, not a blanket table order, is authoritative.

Pure text checks operate on unnormalized original Unicode scalar/code-point sequences; do not NFC-normalize Capture content or compute UTF-16 offsets. Validate span bounds/non-empty content and exact supporting text against original Capture. Local `seq` is newly allocated; parent insertion order, not source wall-clock time, satisfies v9's older-parent trigger. Parent arrays need a deterministic topological/causal order with stable-ID tie-breaks; independent branch arrival order may differ locally and is never authority.

Approval replication carries a signed **past fact**: actor device/membership, proposal/claim/object/base IDs, reviewed revision, action, exact final body hash, `user_edited`, resulting immutable revision/evidence, and timestamp metadata. Validate that result content and ancestry match the proof. Never dispatch `reviewRevisionProposal` or `accept_pending_claim` from a packet, and never infer approval from `verification_status=passed` or `origin=system`. Import the approved revision as history; selecting it as local head is a separate guarded causal decision. Cryptographic device attestation does not prove an uncompromised human was physically present; a compromised enrolled device remains a documented trust risk. Legacy approval rows are marked as legacy attestations, not newly signed historical interactions.

On import, emit `KnowledgeInvalidated` through a proposed ArthurClient subscription and re-read canonical queries on every mounted affected surface. Use separate event origin/reason (`replication`) so `AutoOrganize`'s local-Capture subscription never treats imports as new user capture actions. Do not call distillation, JEV, Graph inference or semantic provider embedding because of arrival. Rebuild local lexical indexes deterministically; queue paid semantic work only after a separate explicit user action/approved policy. The existing polling Recall indexer must also be considered: imported objects must not become provider jobs accidentally, even if local semantic consent is ON. Define an exclusion/eligibility marker in the implementation review; consent alone is not import authorization.

## 10. Conflict contract

Causality comes from predecessor/event version and dependency references; timestamps are display-only. Mutable fields use explicit expected-version operations; immutable records merge by identity and equality. Persist all candidate operations and their original provenance. No global Desktop authority and no wall-clock LWW.

| Situation | Recommended outcome |
|---|---|
| Concurrent edits / competing head selections | Preserve both DAG branches and signed head candidates. Keep each local selected head until explicit resolution; show conflict. A resolver reviews the full known head set and emits a guarded resolution event. A later unseen branch reopens conflict |
| A causally newer revision/head op with no local divergence | Advance projection only after expected-head/project checks; never discard ancestors |
| Approve on A, edit old base on B | Retain approval proof/revision and B branch. Do not run local review or force current head; explicit reconciliation |
| Conflicting terminal reviews of same proposal | Preserve both signed outcomes in conflict ledger; never overwrite immutable terminal row. Single-row projection needs G3 design; block dependent head updates pending resolution |
| Capture/object moved independently | Separate membership versions; original evidence and object identity untouched |
| Concurrent moves/rename/archive/restore | Preserve both operations and block conflicting field projection; user chooses, no timestamp priority |
| Offline Capture arrives for an archived project | Preserve full event in durable conflict inbox; do not delete/reject the user's data as success or silently unarchive/move it. Resolution may explicitly restore the project or choose Inbox; source evidence unchanged |
| Two new projects share a display name | IDs stay distinct; native `ensure_name_free` is application-level, not a SQL UNIQUE. Mark name conflict and require a reviewed display/rename policy, not ID merging |
| Same immutable ID, different content / different initial root for one object | Reject atomically as integrity collision, retain bounded diagnostic/quarantine reference; no replacement |
| Same semantic relation, different UUIDs | Preserve origin records and alias mapping; project one canonical edge. Prefer user ownership when user/model collide; never rewrite the user's edge. G6 approves deterministic representative and alias format |
| Model relation removed/replaced concurrently | Signed observed-remove tombstone references exact model-edge creation/version. A stale remove cannot delete a user edge or a later independent add; preserve unresolved alternatives |
| Missing dependency or incompatible version | Typed failure/dependency request; no dangling rows, cursor advance or pretend up-to-date status |

Resolution is a user action on explicit known versions/head set. The UI must expose unresolved conflicts before claiming clean synchronization. Convergence of the operation set is required even while device-local selected-head projections differ visibly. Do not claim an automatic CRDT proof or full conflict UI already exists.

## 11. Proposed persistence extension and compatibility

G3/G4 must approve the actual next schema number after rechecking the integration baseline; `v10` is a candidate only. No SQL is added in P0. Keep v1-v9 step text untouched; add reviewed forward steps and populated-v9 tests.

| Proposed state | Classification / key constraints | Query/index purpose |
|---|---|---|
| `sync_events` / commit bundles | Immutable committed change facts, unique event ID and `(origin, incarnation, seq)`; canonical hash and payload size checks | Origin sequence range scan for incremental catch-up |
| `sync_received` | Durable import result/hash, same unique origin-event tuple | Replay collision lookup; atomic with domain apply |
| `sync_peer_progress` | Device-local per-peer/origin/incarnation cursor; nonnegative monotone | Resume and retention queries by peer |
| `sync_conflicts` and alternatives | Durable unresolved knowledge/proofs; unique causal conflict identity | Needs-attention list and dependent-apply lookup |
| `sync_relation_aliases` / tombstones | Mapping original UUIDs and observed removes to canonical edge | Canonical-key dedup and stale-removal protection |
| `sync_snapshot_staging` | Bounded transient private data, hashed manifest/chunk keys | Resume exact snapshot; expiry/cleanup |
| Settings / public trust registry / consumed pairing challenges | Local control plane owned by the same native runtime; private key handles only | Atomic preference revisions, attempts, revocation/session checks |

Co-locate transaction-coupled Sync metadata with `arthur.db` under the same owner; separate secure OS key handles remain unavoidable. Define key-provisioning states (`pending_key`, `ready`, `unavailable`) and fail closed across DB/keystore crashes. A public signed registry is deliberately shared as security metadata; provider consent/preferences remain local. `sync_events` contains private knowledge: use app-private access controls, bounded retention and the same user data deletion/backup policy; never call it harmless telemetry.

Migration tests must cover empty→latest, populated v9→latest, repeat open, failure at last DDL/trigger, process interruption, FK/integrity checks, old binary refusal, immutable row fingerprints and historical import guards. Rollback means aborting an uncommitted step, or restoring an explicit pre-upgrade backup with new incarnation/rebootstrap; do not downgrade a live newer-schema DB with an old binary. Forward fix is preferred once new writes exist. Backup is local recovery only, never a DB-transfer sync design. User data deletion/trust reset must invalidate sessions and distinguish clearing trust from deleting knowledge.

## 12. Architecture review answers

| Question | Proposed answer |
|---|---|
| Source of truth | Per-device committed SQLite domain data plus authenticated immutable origin operations; one native materializer. Device preferences/trust are separate local control state |
| Write ownership | Existing CaptureStore/native runtime owns every DB mutation, including import. No UI, socket handler or Kotlin SQL writer |
| Dependency direction | Tauri/platform adapters depend on pure engine/traits and shared shapes; core never imports app UI, concrete LAN or frozen tools |
| Service boundaries | Typed authenticated envelopes, SyncStore and Transport traits; no SQL handles, provider credentials or implicit globals cross |
| Failure semantics | Atomic commit/no-op/visible conflict; bounded retries/dependencies, no networking needed for local success |
| State lifecycle | Persist bundles/cursors/attempt budgets; ephemeral sessions expire/cancel; crash replay is idempotent |
| Test seams | Injectable clock, CSPRNG, signer, transport, trust view and temp-store failure hooks; no real provider or sleep-dependent assertions |
| Migration | Reviewed new forward steps, compatibility negotiation, explicit historical-import gate, backup/forward-fix |
| Observability | Counts/status codes/opaque run IDs and local conflict summaries; private data stays behind authenticated UI, not logs |
| Security | Enrollment/membership gates before data, signed origin evidence, separate provider consent, secure private-key storage and bounded hostile inputs |

## 13. Acceptance matrix — future tests, not P0 results

| ID | Required deterministic or platform evidence |
|---|---|
| S01 | Offline Capture reaches other DB with identical ID/content/source/time/project; Cyrillic, emoji and combining sequences preserve exact spans |
| S02 | Domain/journal last-write fault rolls back both; crash after commit retains event; unsigned-event recovery preserves IDs |
| S03 | Lost ACK, duplicate batch, reordered predecessor and same-ID/different-hash: one apply or typed rejection, correct per-peer cursor |
| S04 | Populated-v9 bootstrap including archived projects, historical/stale proposals, evidence with descendants and empty distillation; no trigger bypass or partial publication |
| S05 | Snapshot boundary under concurrent writes, resume after lost chunk, disk full, tampered manifest and catch-up; complete union of data |
| S06 | Two offline edits, concurrent moves/archive, same-name projects and conflicting reviews retain originals and show needs-attention |
| S07 | Signed approval import preserves history without invoking review, wrong actor/result/body fails; legacy attestation labeled |
| S08 | Canonical symmetric/directional relation identities, independent UUID collision, user/model conflict and model remove/re-add never erase user ownership |
| S09 | Unknown peer/network/version/incarnation, forged ACK, revoked origin, oversized/deep/duplicate-key input produces no unauthorized mutation |
| S10 | Sync OFF leaves Capture/edit/Recall/manual review usable; no import-triggered AI calls even with local provider consents ON |
| S11 | Mounted Home/Ideas/Graph/Lineage/Review views reread after import, failures change neither view nor DB; restart is durability test only |
| S12 | Android ↔ Desktop bidirectional manual/auto sessions and all scheduler/pairing cases in Document B; no Home Node/Box acceptance requirement |
| S13 | Fresh/populated/repeated/interrupted migration and old-binary refusal; no data loss, future-schema modification or premature ACK |

## 14. Open owner decisions and next slice

| Gate | Recommendation and rationale | Approval / evidence needed |
|---|---|---|
| G1 | Native Rust engine and one process-wide store owner; TS boundary stays reference-only | Kaloyan approves native/root ownership and later Android runtime extraction |
| G2 | Full personal-installation profile, all projects/approved history, explicit disclosure | Kaloyan confirms sharing scope and whether staged partial releases are allowed |
| G3 | Reviewed historical-import semantics; never weaken ordinary creation/review guards | Owner + storage/security review of exact new migration and validator design; blocker for full importer |
| G4 | Bundle identity/signing, limits, snapshot/retention and applied-vs-conflict ACK | Approve numeric budgets and signing/key-lock behavior; prove maximum-size fixtures |
| G5 | Replicate authenticated past approvals, distinguish legacy attestation, retain concurrent outcomes | Confirm human-authority semantics and trusted-device threat model |
| G6 | Relation alias/tombstone model; explicit conflict resolution for heads/projects/reviews | Approve deterministic projection rules and required UX |
| G7 | Personal network, PAKE library, trust lifecycle, LAN permissions and background design | Separate owner/security gates in Document B |

After approval, first implement a narrow native runtime/store seam and deterministic transaction/journal tests; pairing, transport and UI follow only their own reviewed contracts. No dependency or migration implementation starts solely because this proposal exists.

## 15. Fresh verification and limits of this audit

Environment observed: Windows NT `10.0.26200.0`, Node `v24.13.1`, npm `11.8.0`; neither root nor app `node_modules` exists, Cargo is absent from PATH.

| Check actually attempted | Fresh result on 2026-10-21 |
|---|---|
| Git status/branch/log/HEAD; fetch; baseline and branch diff | Confirmed values in §1; fetch succeeded; no merge/rebase/switch |
| `npm run typecheck` | UNVERIFIED gate: command exits 1 because `tsc` is unavailable; typechecking did not execute |
| `npm run test:architecture` | UNVERIFIED gate: command exits 1 at `build:test` because `tsc` is unavailable; tests did not execute |
| `npm run arthur:check` | UNVERIFIED gate: command exits 1 at `vitest run` because `vitest` is unavailable; app tests/build did not execute |
| `cargo check --manifest-path apps/arthur/src-tauri/Cargo.toml` | UNVERIFIED: could not start, command not found |
| `cargo test --manifest-path apps/arthur/src-tauri/Cargo.toml` | UNVERIFIED: could not start, command not found |
| `git diff --check` and `git diff --exit-code HEAD` | PASS: no tracked-file whitespace errors or tracked-file changes; these commands alone do not inspect new untracked documents |
| Inline dependency-free `node` document check | PASS: both proposal markers, balanced fenced blocks, no trailing whitespace, existing relative-link targets; LAN interval table contains exactly `5,10,15,30,45,60,120,240,480,720` |
| Final `git status --short --branch` | Only these two new architecture documents are untracked; original tracked tree and HEAD unchanged |

The historical 887 Rust passes/22 ignored, 559 frontend passes and 88 architecture passes belong to the v1 closure, not this run. No provider, app listener, Android build/device, PAKE, migration or Sync acceptance test was executed. Document consistency and final Git hygiene are reported with the delivery; no runtime success is implied.
