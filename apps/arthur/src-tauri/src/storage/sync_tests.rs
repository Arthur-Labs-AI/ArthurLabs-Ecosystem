use super::*;
use super::{fake::FakeTransport, trust::TestTrust};
use crate::storage::{
    capture_store::CaptureStore,
    journal::{codec, sync_fixtures as f},
    ownership::DataRootOwnership,
    sync_store::{install_candidate, test_events, CandidateSyncStore},
};
use std::{cell::Cell, collections::BTreeSet};
use uuid::Uuid;
const NETWORK: Uuid = Uuid::from_u128(100);
const A: Uuid = Uuid::from_u128(101);
const B: Uuid = Uuid::from_u128(102);
const SESSION: Uuid = Uuid::from_u128(103);
#[derive(Default)]
struct Clock(Cell<u64>);
impl SyncClock for Clock {
    fn now(&self) -> u64 {
        self.0.get()
    }
}
struct Peer {
    dir: tempfile::TempDir,
    store: CaptureStore,
    id: Uuid,
    other: Uuid,
}
impl Peer {
    fn new(id: Uuid, other: Uuid) -> Self {
        Self::fixture(id, other, false)
    }
    fn graph(id: Uuid, other: Uuid) -> Self {
        Self::fixture(id, other, true)
    }
    fn fixture(id: Uuid, other: Uuid, graph: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let store =
            CaptureStore::open_owned(DataRootOwnership::try_acquire(&root).unwrap()).unwrap();
        f::seed_legacy(&store);
        if graph {
            f::seed_graph(&store);
        }
        f::upgrade(&store);
        install_candidate(&store, NETWORK, id, &[(other, 1)]).unwrap();
        Self {
            dir,
            store,
            id,
            other,
        }
    }
    fn hello(&self, session: Uuid) -> PeerHello {
        PeerHello {
            network: NETWORK,
            session,
            local: self.id,
            peer: self.other,
            epoch: 1,
        }
    }
    fn trust(&self, session: Uuid, origins: &BTreeSet<Uuid>) -> TestTrust {
        crate::storage::sync_store::grant_test_origins(&self.store, self.other, origins);
        TestTrust {
            hello: self.hello(session),
            expires: 100,
            origins: origins.clone(),
        }
    }
    fn reopen(self) -> Self {
        let Self {
            dir,
            store,
            id,
            other,
        } = self;
        let before = f::state(&store);
        f::clean(&store);
        drop(store);
        let root = dir.path().canonicalize().unwrap();
        let store = f::reopen(DataRootOwnership::try_acquire(&root).unwrap());
        assert_eq!(f::state(&store), before);
        f::clean(&store);
        Self {
            dir,
            store,
            id,
            other,
        }
    }
    fn count(&self, table: &str) -> i64 {
        self.store
            .query_i64_for_test(&format!("SELECT count(*) FROM {table}"))
    }
}
fn origins(a: &Peer, b: &Peer) -> BTreeSet<Uuid> {
    test_events(&a.store)
        .into_iter()
        .chain(test_events(&b.store))
        .map(|e| e.identity.origin)
        .collect()
}
fn context(p: &Peer, origins: &BTreeSet<Uuid>) -> VerifiedSession {
    p.trust(SESSION, origins).verify(&p.hello(SESSION)).unwrap()
}
fn receive(store: &CandidateSyncStore<'_>, s: &VerifiedSession, e: &Envelope) -> Receipt {
    store
        .retain(
            s,
            ValidatedEvent::parse(e.clone()).unwrap(),
            &Clock::default(),
            &Cancellation::default(),
        )
        .unwrap()
}
fn pump<S: SyncStore, T: AuthenticatedTransport, U: AuthenticatedTransport>(
    a: &mut SyncEngine<'_, S, T, Clock>,
    b: &mut SyncEngine<'_, S, U, Clock>,
) {
    for _ in 0..512 {
        let aa = a.tick().unwrap();
        let bb = b.tick().unwrap();
        if !aa && !bb {
            return;
        }
    }
    panic!("exchange did not quiesce within bounded turns")
}
fn run_pair(a: &Peer, b: &Peer, session: Uuid) {
    let origins = origins(a, b);
    let (sa, sb) = (
        CandidateSyncStore::synthetic(&a.store),
        CandidateSyncStore::synthetic(&b.store),
    );
    let (ta, tb, _) = FakeTransport::pair(a.hello(session), b.hello(session));
    let clock = Clock::default();
    let cancel = Cancellation::default();
    let mut ea = SyncEngine::start(&sa, ta, &a.trust(session, &origins), &clock, &cancel).unwrap();
    let mut eb = SyncEngine::start(&sb, tb, &b.trust(session, &origins), &clock, &cancel).unwrap();
    pump(&mut ea, &mut eb);
    assert!(ea.needs_attention && eb.needs_attention);
}
#[test]
fn d01_d02_d03_independent_disks_bidirectional_original_receipts_not_false_projection() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&a.store, &["A1", "A2", "A3", "A4", "A5"]);
    f::captures(&b.store, &["B1", "B2", "B3"]);
    assert_ne!(a.dir.path(), b.dir.path());
    let ae = test_events(&a.store);
    let be = test_events(&b.store);
    assert_ne!(ae[0].identity.origin, be[0].identity.origin);
    run_pair(&a, &b, SESSION);
    assert_eq!((a.count("sync_bundles"), b.count("sync_bundles")), (5, 3));
    assert_eq!((a.count("import_events"), b.count("import_events")), (3, 5));
    assert_eq!((a.count("captures"), b.count("captures")), (5, 3));
    for p in [&a, &b] {
        assert_eq!(
            p.store
                .query_i64_for_test("SELECT coalesce(max(applied),0) FROM import_progress"),
            0
        );
        assert_eq!(
            p.store.query_i64_for_test(
                "SELECT count(*) FROM import_events WHERE outcome='unsupported'"
            ),
            p.count("import_events")
        );
    }
    for e in &ae {
        let received = test_events(&b.store)
            .into_iter()
            .find(|r| r.identity.event == e.identity.event)
            .unwrap();
        assert_eq!(received.bytes, e.bytes);
        assert_eq!(received.identity, e.identity);
    }
    for p in [&a, &b] {
        assert_eq!(
            p.store
                .query_i64_for_test("SELECT coalesce(max(integrated),0) FROM import_delivery"),
            0
        );
    }

    let a = a.reopen();
    let b = b.reopen();
    run_pair(&a, &b, Uuid::from_u128(104));
    assert_eq!((a.count("import_events"), b.count("import_events")), (3, 5));
}
#[test]
fn d04_d07_d08_d14_lost_conflict_ack_reconnect_and_restart_use_durable_outcomes() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::rename(&a.store, "A alternative");
    f::rename(&b.store, "B alternative");
    let origins = origins(&a, &b);
    let (sa, sb) = (
        CandidateSyncStore::synthetic(&a.store),
        CandidateSyncStore::synthetic(&b.store),
    );
    let (ta, tb, link) = FakeTransport::pair(a.hello(SESSION), b.hello(SESSION));
    link.borrow_mut().lose_receipt = 10000;
    let clock = Clock::default();
    let cancel = Cancellation::default();
    let mut ea = SyncEngine::start(&sa, ta, &a.trust(SESSION, &origins), &clock, &cancel).unwrap();
    let mut eb = SyncEngine::start(&sb, tb, &b.trust(SESSION, &origins), &clock, &cancel).unwrap();
    for _ in 0..12 {
        ea.tick().unwrap();
        eb.tick().unwrap();
    }
    assert_eq!((a.count("import_events"), b.count("import_events")), (1, 1));
    assert_eq!(
        (a.count("import_conflicts"), b.count("import_conflicts")),
        (1, 1)
    );
    assert_eq!(
        (a.count("import_delivery"), b.count("import_delivery")),
        (0, 0)
    );
    link.borrow_mut().online = false;
    link.borrow_mut().queues.iter_mut().for_each(|q| q.clear());
    assert_eq!(ea.tick(), Err(Error::Disconnected));
    drop(ea);
    drop(eb);
    drop(sa);
    drop(sb);
    let a = a.reopen();
    let b = b.reopen();
    run_pair(&a, &b, Uuid::from_u128(105));
    for p in [&a, &b] {
        assert_eq!(p.count("import_events"), 1);
        assert_eq!(p.count("import_conflicts"), 1);
        assert_eq!(
            p.store
                .query_i64_for_test("SELECT integrated FROM import_delivery"),
            1
        );
        assert_eq!(
            p.store
                .query_i64_for_test("SELECT applied FROM import_delivery"),
            0
        );
        f::clean(&p.store);
    }
}
#[test]
fn d05_same_event_collision_stream_fork_and_bundle_collision_preserve_all_evidence() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&a.store, &["Original"]);
    let e = test_events(&a.store).remove(0);
    let origins = origins(&a, &b);
    let s = context(&b, &origins);
    let db = CandidateSyncStore::synthetic(&b.store);
    assert_eq!(
        receive(&db, &s, &e).outcome,
        Outcome::UnsupportedImportPolicy
    );
    let before = f::state(&b.store);
    receive(&db, &s, &e);
    assert_eq!(f::state(&b.store), before);
    for kind in 0..3 {
        let mut core = codec::decode_core_strict(&e.bytes).unwrap();
        if let codec::Operation::RecordCreate(row) = &mut core.operations[0] {
            row.after.insert(
                "content".into(),
                codec::FieldValue::Text(format!("Collision {kind}")),
            );
        }
        if kind > 0 {
            core.event_id = Uuid::new_v4().to_string();
        }
        if kind == 1 {
            core.bundle_id = Uuid::new_v4().to_string();
        }
        if kind == 2 {
            core.origin_seq = "2".into();
            core.previous_event_hash = codec::hash_hex(&e.identity.hash);
        }
        let fork = from_core(core);
        assert_eq!(receive(&db, &s, &fork).outcome, Outcome::RejectedIntegrity);
    }
    assert_eq!(b.count("import_collisions"), 3);
    assert_eq!(b.count("import_events"), 1);
    assert_eq!(b.count("captures"), 0);
    b.reopen();
}
fn from_core(core: codec::JournalEvent) -> Envelope {
    let bytes = codec::encode_canonical(&core).unwrap();
    let identity = Identity {
        event: Uuid::parse_str(&core.event_id).unwrap(),
        bundle: Uuid::parse_str(&core.bundle_id).unwrap(),
        origin: Uuid::parse_str(&core.origin_id).unwrap(),
        incarnation: Uuid::parse_str(&core.origin_incarnation).unwrap(),
        seq: core.origin_seq.parse().unwrap(),
        hash: codec::journal_event_hash(&bytes),
    };
    Envelope { identity, bytes }
}
#[test]
fn d06_sequence_gap_never_advances_applied_cursor_and_predecessor_is_rechecked() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&a.store, &["First", "Second"]);
    let events = test_events(&a.store);
    let origins = origins(&a, &b);
    let s = context(&b, &origins);
    let db = CandidateSyncStore::synthetic(&b.store);
    assert_eq!(
        receive(&db, &s, &events[1]).outcome,
        Outcome::DeferredDependency
    );
    assert_eq!(
        b.store
            .query_i64_for_test("SELECT stored FROM import_progress"),
        0
    );
    assert_eq!(
        receive(&db, &s, &events[0]).outcome,
        Outcome::UnsupportedImportPolicy
    );
    assert_eq!(
        b.store
            .query_i64_for_test("SELECT stored FROM import_progress"),
        2
    );
    assert_eq!(
        b.store
            .query_i64_for_test("SELECT applied FROM import_progress"),
        0
    );
    let before = f::state(&b.store);
    drop(db);
    let b = b.reopen();
    assert_eq!(f::state(&b.store), before);
}
#[test]
fn d09_corrupt_noncanonical_invalid_dependency_and_oversized_inputs_do_not_mutate_sql() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&a.store, &["A source"]);
    let e = test_events(&a.store).remove(0);
    let before = f::state(&b.store);
    let mut cases = Vec::new();
    let mut changed = e.clone();
    changed.bytes.push(b' ');
    changed.identity.hash = codec::journal_event_hash(&changed.bytes);
    cases.push(changed);
    let mut changed = e.clone();
    changed.identity.hash[0] ^= 1;
    cases.push(changed);
    let mut core = codec::decode_core_strict(&e.bytes).unwrap();
    core.dependencies.clear();
    cases.push(from_core(core));
    let mut changed = e.clone();
    changed.bytes = vec![b'X'; codec::MAX_CANONICAL_BYTES + 1];
    cases.push(changed);
    for (from, to) in [
        ("record.create", "record.execute"),
        ("\"operationVersion\":1", "\"operationVersion\":2"),
        ("\"originSeq\":\"1\"", "\"originSeq\":\"01\""),
    ] {
        let mut changed = e.clone();
        let text = String::from_utf8(changed.bytes).unwrap();
        assert!(text.contains(from));
        changed.bytes = text.replace(from, to).into_bytes();
        changed.identity.hash = codec::journal_event_hash(&changed.bytes);
        cases.push(changed);
    }
    for invalid in cases {
        assert!(ValidatedEvent::parse(invalid).is_err());
        assert_eq!(f::state(&b.store), before);
    }
}
#[test]
fn d10_release_closed_trust_revocation_wrong_peer_expiry_and_cancellation_fail_closed() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&a.store, &["Private"]);
    let ids = origins(&a, &b);
    let db = CandidateSyncStore::synthetic(&b.store);
    let (ta, tb, link) = FakeTransport::pair(a.hello(SESSION), b.hello(SESSION));
    let clock = Clock::default();
    let cancel = Cancellation::default();
    let before = f::state(&b.store);
    assert!(matches!(
        SyncEngine::start(&db, tb, &ClosedTrust, &clock, &cancel),
        Err(Error::Trust)
    ));
    assert!(link.borrow().queues.iter().all(|q| q.is_empty()));
    drop(ta);
    assert_eq!(f::state(&b.store), before);
    let s = context(&b, &ids);
    clock.0.set(100);
    assert!(matches!(db.summary(&s, &clock, &cancel), Err(Error::Trust)));
    clock.0.set(0);
    b.store
        .execute_sql_for_test("UPDATE import_members SET epoch=2");
    let before = f::state(&b.store);
    assert!(matches!(db.summary(&s, &clock, &cancel), Err(Error::Trust)));
    assert_eq!(f::state(&b.store), before);
    assert!(CandidateSyncStore::production(&b.store).is_err());
    let cancel = Cancellation::default();
    cancel.cancel();
    assert!(matches!(
        db.summary(&s, &clock, &cancel),
        Err(Error::Cancelled)
    ));
}
#[test]
fn d11_native_dependencies_have_no_ui_network_or_provider_execution() {
    for source in [
        include_str!("../sync/engine.rs"),
        include_str!("../sync/protocol.rs"),
        include_str!("../sync/trust.rs"),
        include_str!("../sync/validation.rs"),
    ] {
        for forbidden in [
            "tauri::",
            "std::net",
            "tokio::net",
            "rusqlite",
            "PathBuf",
            "crate::providers",
            "crate::distillation",
            "crate::graph",
            "crate::synthesis",
            "crate::jev",
        ] {
            assert!(
                !source.contains(forbidden),
                "forbidden engine dependency {forbidden}"
            );
        }
    }
    let adapter = include_str!("sync_store.rs");
    for forbidden in [
        ".review_proposal(",
        "accept_pending_claim(",
        "evolve_capture(",
        "crate::providers",
        "crate::distillation",
        "INSERT INTO captures",
        "INSERT INTO projects",
        "sync_write_context(singleton",
    ] {
        assert!(
            !adapter.contains(forbidden),
            "import may not execute {forbidden}"
        );
    }
    assert!(include_str!("../sync/trust.rs")
        .replace("\r\n", "\n")
        .contains("#[cfg(test)]\nimpl TrustVerifier for TestTrust"));
}
#[test]
fn d12_late_ledger_failure_and_expired_commit_roll_back_all_receipts_and_cursors() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&a.store, &["Atomic receipt"]);
    let ids = origins(&a, &b);
    let s = context(&b, &ids);
    let db = CandidateSyncStore::synthetic(&b.store);
    let e = test_events(&a.store).remove(0);
    let before = f::state(&b.store);
    b.store.execute_sql_for_test("CREATE TEMP TRIGGER d12_fail BEFORE INSERT ON import_progress BEGIN SELECT RAISE(ABORT,'controlled receipt failure'); END");
    assert!(matches!(
        db.retain(
            &s,
            ValidatedEvent::parse(e.clone()).unwrap(),
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Storage)
    ));
    assert_eq!(f::state(&b.store), before);
    f::clean(&b.store);
    b.store.execute_sql_for_test("DROP TRIGGER d12_fail");
    struct Expire(Cell<u64>);
    impl SyncClock for Expire {
        fn now(&self) -> u64 {
            let n = self.0.get();
            self.0.set(n + 1);
            if n == 0 {
                0
            } else {
                100
            }
        }
    }
    assert!(matches!(
        db.retain(
            &s,
            ValidatedEvent::parse(e.clone()).unwrap(),
            &Expire(Cell::new(0)),
            &Cancellation::default()
        ),
        Err(Error::Trust)
    ));
    assert_eq!(f::state(&b.store), before);
    assert_eq!(
        receive(&db, &s, &e).outcome,
        Outcome::UnsupportedImportPolicy
    );
}
#[test]
fn d12b_actual_deferred_fk_commit_failure_poisoned_owner_returns_no_receipt() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&a.store, &["Commit failure"]);
    let ids = origins(&a, &b);
    let s = context(&b, &ids);
    let db = CandidateSyncStore::synthetic(&b.store);
    let e = test_events(&a.store).remove(0);
    b.store.execute_sql_for_test("CREATE TABLE d12_deferred(peer TEXT REFERENCES import_members(peer) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER d12_commit AFTER INSERT ON import_progress BEGIN INSERT INTO d12_deferred VALUES('absent'); END");
    let before = f::state(&b.store);
    assert!(matches!(
        db.retain(
            &s,
            ValidatedEvent::parse(e).unwrap(),
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Storage)
    ));
    assert!(matches!(
        db.summary(&s, &Clock::default(), &Cancellation::default()),
        Err(Error::Storage)
    ));
    assert_eq!(f::state(&b.store), before);
    drop(db);
    b.reopen();
}
fn message(hello: &PeerHello, payload: Payload) -> Message {
    Message {
        network: hello.network,
        session: hello.session,
        from: hello.local,
        to: hello.peer,
        payload,
    }
}
fn negotiate_receiver<'a>(
    db: &'a CandidateSyncStore<'a>,
    a: &Peer,
    b: &Peer,
    clock: &'a Clock,
    cancel: &'a Cancellation,
    ids: &BTreeSet<Uuid>,
) -> (
    SyncEngine<'a, CandidateSyncStore<'a>, FakeTransport, Clock>,
    FakeTransport,
) {
    let (mut ta, tb, _) = FakeTransport::pair(a.hello(SESSION), b.hello(SESSION));
    let mut engine = SyncEngine::start(db, tb, &b.trust(SESSION, ids), clock, cancel).unwrap();
    ta.send(message(
        &a.hello(SESSION),
        Payload::Hello {
            version: 1,
            required: FEATURES,
            supported: FEATURES,
            profile: "m05-ledger-candidate".into(),
        },
    ))
    .unwrap();
    assert!(engine.tick().unwrap());
    (engine, ta)
}
#[test]
fn d13_large_real_journal_event_is_atomic_and_all_chunk_faults_are_nonpublication() {
    let a = Peer::new(A, B);
    f::large(&a.store);
    let e = test_events(&a.store).remove(0);
    assert!(e.bytes.len() > MAX_FRAME);
    assert!(e.bytes.len() <= codec::MAX_CANONICAL_BYTES);
    for fault in 0..5 {
        let b = Peer::new(B, A);
        let ids = origins(&a, &b);
        let db = CandidateSyncStore::synthetic(&b.store);
        let clock = Clock::default();
        let cancel = Cancellation::default();
        b.trust(SESSION, &ids); // Provision durable test permissions before the mutation oracle.
        let before = f::state(&b.store);
        let (mut engine, mut ta) = negotiate_receiver(&db, &a, &b, &clock, &cancel, &ids);
        let mut chunks = chunk_event(&e);
        match fault {
            1 => {
                ta.link.borrow_mut().drop_chunk = Some(chunks.len() - 1);
            }
            2 => {
                chunks.swap(0, 1);
            }
            3 => {
                chunks[0].bytes[0] ^= 1;
            }
            4 => {
                ta.link.borrow_mut().duplicate = true;
            }
            _ => {}
        }
        let mut rejected = false;
        for (index, chunk) in chunks.iter().cloned().enumerate() {
            ta.send(message(&a.hello(SESSION), Payload::Chunk(chunk)))
                .unwrap();
            match engine.tick() {
                Ok(_) => {}
                Err(Error::Integrity | Error::Limit) => {
                    rejected = true;
                    break;
                }
                other => panic!("unexpected {other:?}"),
            };
            if fault != 0 || index + 1 < chunks.len() {
                assert_eq!(b.count("import_events"), 0);
            }
        }
        if fault == 0 {
            assert_eq!(b.count("import_events"), 1);
            let received = test_events(&b.store).remove(0);
            assert_eq!(received.bytes, e.bytes);
            assert_eq!(b.count("captures"), 0);
        } else {
            assert_eq!(f::state(&b.store), before);
            if fault > 1 {
                assert!(rejected)
            }
            cancel.cancel();
            assert_eq!(engine.tick(), Err(Error::Cancelled));
        }
        drop(engine);
        drop(db);
        b.reopen();
    }
}
#[test]
fn d13b_fake_transport_reorders_complete_events_without_skipping_a_gap() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&a.store, &["1", "2"]);
    let events = test_events(&a.store);
    let ids = origins(&a, &b);
    let db = CandidateSyncStore::synthetic(&b.store);
    let clock = Clock::default();
    let cancel = Cancellation::default();
    let (mut engine, mut ta) = negotiate_receiver(&db, &a, &b, &clock, &cancel, &ids);
    for i in [1, 0] {
        for chunk in chunk_event(&events[i]) {
            ta.send(message(&a.hello(SESSION), Payload::Chunk(chunk)))
                .unwrap();
            engine.tick().unwrap();
        }
        assert_eq!(
            b.store
                .query_i64_for_test("SELECT stored FROM import_progress"),
            if i == 1 { 0 } else { 2 }
        );
        assert_eq!(
            b.store
                .query_i64_for_test("SELECT applied FROM import_progress"),
            0
        );
    }
}
#[test]
fn d15_frozen_guards_and_historical_review_evidence_archived_children_are_honest() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&a.store, &["Original ID"]);
    let e = test_events(&a.store).remove(0);
    let before = f::state(&b.store);
    assert!(f::guard_refuses_capture(&b.store, &e));
    assert_eq!(f::state(&b.store), before);
    let ids = origins(&a, &b);
    let s = context(&b, &ids);
    let db = CandidateSyncStore::synthetic(&b.store);
    assert_eq!(
        receive(&db, &s, &e).outcome,
        Outcome::UnsupportedImportPolicy
    );
    assert_eq!(b.count("captures"), 0);
    drop(db);
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::project_capture(&a.store);
    f::archive(&b.store);
    let ids = origins(&a, &b);
    let s = context(&b, &ids);
    let db = CandidateSyncStore::synthetic(&b.store);
    let e = test_events(&a.store).remove(0);
    assert_eq!(receive(&db, &s, &e).outcome, Outcome::ConflictRetained);
    assert_eq!(
        b.store
            .query_i64_for_test("SELECT count(*) FROM projects WHERE archived_at IS NOT NULL"),
        1
    );
    assert_eq!(b.count("captures"), 0);
    drop(db);
    b.reopen();
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::review_history(&a.store);
    let ids = origins(&a, &b);
    let s = context(&b, &ids);
    let db = CandidateSyncStore::synthetic(&b.store);
    let events = test_events(&a.store);
    assert!(events.iter().any(|e| ValidatedEvent::parse(e.clone())
        .unwrap()
        .core()
        .operations
        .iter()
        .any(|o| o.entity() == codec::EntityKind::RevisionEvidence)));
    for e in &events {
        assert!(matches!(
            receive(&db, &s, e).outcome,
            Outcome::UnsupportedImportPolicy | Outcome::DeferredDependency
        ));
    }
    assert_eq!(b.count("revision_proposals"), 0);
    assert_eq!(b.count("revision_evidence"), 0);
    assert_eq!(b.count("knowledge_objects"), 0);
    assert_eq!(b.count("import_events"), events.len() as i64);
    drop(db);
    b.reopen();
}
#[test]
fn d16_existing_snapshot_v2_source_verification_rejects_tamper_no_bootstrap_claim() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&a.store, &["Snapshot source"]);
    let id = "bbbbbbbb-1111-4111-8111-111111111111";
    f::snapshot(&a.store, id);
    assert!(f::verify_snapshot(&a.store, id));
    assert!(f::snapshot_tamper_rejected(&a.store, id));
    assert_eq!(b.count("captures"), 0);
    assert_eq!(b.count("import_events"), 0);
    a.reopen();
    b.reopen();
}
#[test]
fn d17_synthetic_extension_limits_immutable_evidence_and_never_registers_production_schema() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&a.store, &["Retained"]);
    let e = test_events(&a.store).remove(0);
    let ids = origins(&a, &b);
    let s = context(&b, &ids);
    let db = CandidateSyncStore::synthetic(&b.store);
    receive(&db, &s, &e);
    assert_eq!(b.store.query_i64_for_test("PRAGMA user_version"), 10);
    assert_eq!(crate::storage::migrations::SCHEMA_VERSION, 9);
    let before = f::state(&b.store);
    assert!(install_candidate(&b.store, NETWORK, B, &[(A, 1)]).is_err());
    assert_eq!(f::state(&b.store), before);
    for statement in [
        "UPDATE import_events SET bytes=x'00'",
        "DELETE FROM import_events",
        "DELETE FROM import_creates",
    ] {
        assert!(crate::storage::sync_store::test_refuses(
            &b.store, statement
        ));
        assert_eq!(f::state(&b.store), before);
    }
    for i in 0..16 {
        let mut core = codec::decode_core_strict(&e.bytes).unwrap();
        if let codec::Operation::RecordCreate(row) = &mut core.operations[0] {
            row.after.insert(
                "content".into(),
                codec::FieldValue::Text(format!("Alternative {i}")),
            );
        }
        let alternative = from_core(core);
        assert_eq!(
            receive(&db, &s, &alternative).outcome,
            Outcome::RejectedIntegrity
        );
    }
    assert_eq!(b.count("import_collisions"), 16);
    let before = f::state(&b.store);
    let mut core = codec::decode_core_strict(&e.bytes).unwrap();
    core.committed_at = "2026-10-01T00:00:00Z".into();
    let more = from_core(core);
    assert!(matches!(
        db.retain(
            &s,
            ValidatedEvent::parse(more).unwrap(),
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::StorageLimited)
    ));
    assert_eq!(f::state(&b.store), before);
    drop(db);
    b.reopen();
}
#[test]
fn d18_wrong_unsent_future_hash_bundle_or_session_ack_never_advances_delivery() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::rename(&a.store, "A version");
    f::rename(&b.store, "B version");
    let ids = origins(&a, &b);
    let sa = context(&a, &ids);
    let sb = context(&b, &ids);
    let da = CandidateSyncStore::synthetic(&a.store);
    let db = CandidateSyncStore::synthetic(&b.store);
    let e = test_events(&a.store).remove(0);
    let clock = Clock::default();
    let cancel = Cancellation::default();
    da.offered(&sa, &e.identity, &clock, &cancel).unwrap();
    assert_eq!(a.count("import_delivery"), 0);
    let before = f::state(&a.store);
    for n in 0..4 {
        let mut bad = e.identity.clone();
        match n {
            0 => bad.event = Uuid::new_v4(),
            1 => bad.seq += 1,
            2 => bad.hash[0] ^= 1,
            _ => bad.bundle = Uuid::new_v4(),
        };
        assert!(matches!(
            da.receipt(
                &sa,
                &Receipt {
                    identity: bad,
                    outcome: Outcome::ConflictRetained
                },
                &clock,
                &cancel
            ),
            Err(Error::Integrity)
        ));
        assert_eq!(f::state(&a.store), before);
    }
    let other_session = a
        .trust(Uuid::from_u128(999), &ids)
        .verify(&a.hello(Uuid::from_u128(999)))
        .unwrap();
    assert!(matches!(
        da.receipt(
            &other_session,
            &Receipt {
                identity: e.identity.clone(),
                outcome: Outcome::ConflictRetained
            },
            &clock,
            &cancel
        ),
        Err(Error::Integrity)
    ));
    assert_eq!(f::state(&a.store), before);
    let receipt = receive(&db, &sb, &e);
    assert_eq!(receipt.outcome, Outcome::ConflictRetained);
    da.receipt(&sa, &receipt, &clock, &cancel).unwrap();
    assert_eq!(
        a.store
            .query_i64_for_test("SELECT integrated FROM import_delivery"),
        1
    );
    assert_eq!(
        a.store
            .query_i64_for_test("SELECT applied FROM import_delivery"),
        0
    );
    let committed = f::state(&a.store);
    da.receipt(&sa, &receipt, &clock, &cancel).unwrap();
    assert_eq!(f::state(&a.store), committed);
    let (mut ta, tb, link) = FakeTransport::pair(a.hello(SESSION), b.hello(SESSION));
    let mut engine = SyncEngine::start(&db, tb, &b.trust(SESSION, &ids), &clock, &cancel).unwrap();
    let mut forged = message(&a.hello(SESSION), Payload::Receipt(receipt));
    forged.from = Uuid::from_u128(1000);
    ta.send(forged).unwrap();
    let before = f::state(&b.store);
    assert_eq!(engine.tick(), Err(Error::Trust));
    assert_eq!(f::state(&b.store), before);
    assert!(link.borrow().queues[0]
        .iter()
        .all(|m| matches!(m.payload, Payload::Hello { .. })));
}
#[test]
fn d19_unsupported_negotiation_discloses_no_summary_and_fake_queue_is_bounded() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&b.store, &["Not disclosed"]);
    let ids = origins(&a, &b);
    let db = CandidateSyncStore::synthetic(&b.store);
    let clock = Clock::default();
    let cancel = Cancellation::default();
    let (mut ta, tb, link) = FakeTransport::pair(a.hello(SESSION), b.hello(SESSION));
    let mut engine = SyncEngine::start(&db, tb, &b.trust(SESSION, &ids), &clock, &cancel).unwrap();
    let before = f::state(&b.store);
    ta.send(message(
        &a.hello(SESSION),
        Payload::Hello {
            version: 1,
            required: 1 << 31,
            supported: FEATURES,
            profile: "m05-ledger-candidate".into(),
        },
    ))
    .unwrap();
    assert_eq!(engine.tick(), Err(Error::Protocol));
    assert_eq!(f::state(&b.store), before);
    assert_eq!(link.borrow().queues[0].len(), 1);
    assert!(matches!(
        link.borrow().queues[0][0].payload,
        Payload::Hello { .. }
    ));
    for _ in 0..64 {
        ta.send(message(&a.hello(SESSION), Payload::Request(vec![])))
            .unwrap();
    }
    assert_eq!(
        ta.send(message(&a.hello(SESSION), Payload::Request(vec![]))),
        Err(Error::Limit)
    );
}
#[test]
fn d20_bad_predecessor_dependency_proof_and_immutable_id_claim_never_integrate() {
    let a = Peer::new(A, B);
    f::captures(&a.store, &["One", "Two"]);
    let events = test_events(&a.store);
    for kind in 0..3 {
        let b = Peer::new(B, A);
        let ids = origins(&a, &b);
        let s = context(&b, &ids);
        let db = CandidateSyncStore::synthetic(&b.store);
        receive(&db, &s, &events[0]);
        let mut core = codec::decode_core_strict(&events[1].bytes).unwrap();
        if kind == 0 {
            core.previous_event_hash = codec::hash_hex(&[9; 32]);
        }
        if kind == 1 {
            core.dependencies[0].event_ref = Some(codec::EventRef {
                origin_id: events[0].identity.origin.to_string(),
                incarnation: events[0].identity.incarnation.to_string(),
                seq: "1".into(),
                event_id: events[0].identity.event.to_string(),
                hash: codec::hash_hex(&events[0].identity.hash),
            });
        }
        if kind == 2 {
            let first = codec::decode_core_strict(&events[0].bytes).unwrap();
            if let (codec::Operation::RecordCreate(row), codec::Operation::RecordCreate(original)) =
                (&mut core.operations[0], &first.operations[0])
            {
                row.key = original.key.clone();
                row.after.insert("id".into(), original.after["id"].clone());
            }
        }
        let bad = from_core(core);
        assert_eq!(receive(&db, &s, &bad).outcome, Outcome::RejectedIntegrity);
        assert_eq!(
            b.store
                .query_i64_for_test("SELECT stored FROM import_progress"),
            1
        );
        assert_eq!(
            b.store
                .query_i64_for_test("SELECT integrated FROM import_progress"),
            0
        );
        assert_eq!(b.count("captures"), 0);
        drop(db);
        b.reopen();
    }
}
#[test]
fn d21_concurrent_thought_heads_and_terminal_reviews_retain_both_original_facts() {
    for review in [false, true] {
        let a = Peer::graph(A, B);
        let b = Peer::graph(B, A);
        if review {
            f::review_shared(&a.store, true);
            f::review_shared(&b.store, false);
        } else {
            f::edit_shared(&a.store, "A branch");
            f::edit_shared(&b.store, "B branch");
        }
        run_pair(&a, &b, SESSION);
        for p in [&a, &b] {
            assert_eq!(p.count("import_events"), 1);
            assert_eq!(
                p.store.query_i64_for_test(
                    "SELECT count(*) FROM import_events WHERE outcome='conflict'"
                ),
                1
            );
            assert!(p.count("import_conflicts") > 0);
            assert_eq!(
                p.store
                    .query_i64_for_test("SELECT integrated FROM import_delivery"),
                1
            );
            assert_eq!(
                p.store
                    .query_i64_for_test("SELECT applied FROM import_delivery"),
                0
            );
        }
        if review {
            assert_eq!(
                a.store.query_i64_for_test(
                    "SELECT count(*) FROM revision_proposals WHERE state='approved'"
                ),
                1
            );
            assert_eq!(
                b.store.query_i64_for_test(
                    "SELECT count(*) FROM revision_proposals WHERE state='rejected'"
                ),
                1
            );
        } else {
            assert_eq!(
                a.store.query_i64_for_test(
                    "SELECT count(*) FROM knowledge_objects WHERE title='A branch'"
                ),
                1
            );
            assert_eq!(
                b.store.query_i64_for_test(
                    "SELECT count(*) FROM knowledge_objects WHERE title='B branch'"
                ),
                1
            );
        }
        a.reopen();
        b.reopen();
    }
}
#[test]
fn d22_original_event_forwarding_and_native_local_echo_ack_never_reoriginate() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&a.store, &["Original forwarded bytes"]);
    let ids = origins(&a, &b);
    let sa = context(&a, &ids);
    let sb = context(&b, &ids);
    let da = CandidateSyncStore::synthetic(&a.store);
    let db = CandidateSyncStore::synthetic(&b.store);
    let original = test_events(&a.store).remove(0);
    receive(&db, &sb, &original);
    let clock = Clock::default();
    let cancel = Cancellation::default();
    let forwarded = db.export(&sb, &original.identity, &clock, &cancel).unwrap();
    assert_eq!(forwarded.bytes, original.bytes);
    assert_eq!(forwarded.identity, original.identity);
    db.offered(&sb, &forwarded.identity, &clock, &cancel)
        .unwrap();
    let (ta, mut tb, _) = FakeTransport::pair(a.hello(SESSION), b.hello(SESSION));
    let mut engine = SyncEngine::start(&da, ta, &a.trust(SESSION, &ids), &clock, &cancel).unwrap();
    tb.send(message(
        &b.hello(SESSION),
        Payload::Hello {
            version: 1,
            required: FEATURES,
            supported: FEATURES,
            profile: "m05-ledger-candidate".into(),
        },
    ))
    .unwrap();
    engine.tick().unwrap();
    for chunk in chunk_event(&forwarded) {
        tb.send(message(&b.hello(SESSION), Payload::Chunk(chunk)))
            .unwrap();
        engine.tick().unwrap();
    }
    let mut acknowledged = false;
    while let Some(m) = tb.receive().unwrap() {
        if let Payload::Receipt(r) = m.payload {
            assert_eq!(r.outcome, Outcome::CleanlyApplied);
            db.receipt(&sb, &r, &clock, &cancel).unwrap();
            acknowledged = true;
        }
    }
    assert!(acknowledged);
    assert_eq!((a.count("sync_bundles"), b.count("sync_bundles")), (1, 0));
    assert_eq!((a.count("import_events"), b.count("import_events")), (0, 1));
    assert_eq!(
        db.summary(&sb, &clock, &cancel).unwrap().known[0],
        original.identity
    );
    assert_eq!(
        da.summary(&sa, &clock, &cancel).unwrap().known[0],
        original.identity
    );
}
#[test]
fn d23_revocation_between_large_event_chunks_stops_further_disclosure() {
    struct Revoke<'a> {
        inner: FakeTransport,
        store: &'a CaptureStore,
        fired: bool,
    }
    impl AuthenticatedTransport for Revoke<'_> {
        fn hello(&self) -> PeerHello {
            self.inner.hello()
        }
        fn receive(&mut self) -> Result<Option<Message>> {
            self.inner.receive()
        }
        fn send(&mut self, m: Message) -> Result<()> {
            let chunk = matches!(&m.payload, Payload::Chunk(_));
            self.inner.send(m)?;
            if chunk && !self.fired {
                self.fired = true;
                self.store
                    .execute_sql_for_test("UPDATE import_members SET epoch=epoch+1");
            }
            Ok(())
        }
    }
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::large(&a.store);
    let ids = origins(&a, &b);
    let da = CandidateSyncStore::synthetic(&a.store);
    let db = CandidateSyncStore::synthetic(&b.store);
    let (ta, tb, link) = FakeTransport::pair(a.hello(SESSION), b.hello(SESSION));
    let clock = Clock::default();
    let cancel = Cancellation::default();
    let mut ea = SyncEngine::start(
        &da,
        Revoke {
            inner: ta,
            store: &a.store,
            fired: false,
        },
        &a.trust(SESSION, &ids),
        &clock,
        &cancel,
    )
    .unwrap();
    let mut eb = SyncEngine::start(&db, tb, &b.trust(SESSION, &ids), &clock, &cancel).unwrap();
    ea.tick().unwrap();
    eb.tick().unwrap();
    ea.tick().unwrap(); // remote summary
    eb.tick().unwrap(); // request advertised source
    assert_eq!(ea.tick(), Err(Error::Trust));
    assert_eq!(
        link.borrow().queues[1]
            .iter()
            .filter(|m| matches!(m.payload, Payload::Chunk(_)))
            .count(),
        1
    );
    assert_eq!(b.count("import_events"), 0);
    assert_eq!(a.count("import_delivery"), 0);
}
#[test]
fn d24_collision_against_a_local_core_keeps_needs_attention_after_restart() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&a.store, &["Local authoritative core"]);
    let ids = origins(&a, &b);
    let s = context(&a, &ids);
    let da = CandidateSyncStore::synthetic(&a.store);
    let original = test_events(&a.store).remove(0);
    let mut core = codec::decode_core_strict(&original.bytes).unwrap();
    core.committed_at = "2026-10-01T00:00:00Z".into();
    let collision = from_core(core);
    assert_eq!(
        receive(&da, &s, &collision).outcome,
        Outcome::RejectedIntegrity
    );
    assert_eq!(a.count("import_events"), 0);
    assert_eq!(a.count("import_collisions"), 1);
    assert!(
        da.summary(&s, &Clock::default(), &Cancellation::default())
            .unwrap()
            .needs_attention
    );
    drop(da);
    let a = a.reopen();
    let da = CandidateSyncStore::synthetic(&a.store);
    assert!(
        da.summary(&s, &Clock::default(), &Cancellation::default())
            .unwrap()
            .needs_attention
    );
}

#[test]
fn g3_15_clean_echo_does_not_create_attention() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&a.store, &["clean"]);
    let event = test_events(&a.store).remove(0);
    let allowed = origins(&a, &b);
    let clock = Clock::default();
    let cancel = Cancellation::default();
    let store = CandidateSyncStore::synthetic(&a.store);
    let (ta, mut tb, _) = FakeTransport::pair(a.hello(SESSION), b.hello(SESSION));
    let mut engine =
        SyncEngine::start(&store, ta, &a.trust(SESSION, &allowed), &clock, &cancel).unwrap();
    let message = |payload| Message {
        network: NETWORK,
        session: SESSION,
        from: B,
        to: A,
        payload,
    };
    tb.send(message(Payload::Hello {
        version: 1,
        required: FEATURES,
        supported: FEATURES,
        profile: "m05-ledger-candidate".into(),
    }))
    .unwrap();
    engine.tick().unwrap();
    for c in chunk_event(&event) {
        tb.send(message(Payload::Chunk(c))).unwrap();
        engine.tick().unwrap();
    }
    assert!(
        !engine.needs_attention,
        "a confirmed already-applied event is clean"
    );
}
#[test]
fn g3_11_large_local_inventory_remains_available() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    let texts = vec!["page"; 257];
    f::captures(&a.store, &texts);
    let allowed = origins(&a, &b);
    let store = CandidateSyncStore::synthetic(&a.store);
    assert!(store
        .summary(
            &context(&a, &allowed),
            &Clock::default(),
            &Cancellation::default()
        )
        .is_ok());
}

#[test]
fn g3_01_02_03_04_07_16_real_domain_union_original_provenance_and_local_continuation() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::install_g3(&a.store);
    f::install_g3(&b.store);
    let (pa, ca) = f::project_and_capture(&a.store, "Project A", "А́ 😀\u{200d}🚀\n原文\tß");
    let (pb, cb) = f::project_and_capture(&b.store, "Project B", "B original");
    let original_a = test_events(&a.store);
    let original_b = test_events(&b.store);
    let allowed = origins(&a, &b);
    let clock = Clock::default();
    let cancel = Cancellation::default();
    {
        let sa = CandidateSyncStore::synthetic(&a.store);
        let sb = CandidateSyncStore::synthetic(&b.store);
        let (ta, tb, link) = FakeTransport::pair(a.hello(SESSION), b.hello(SESSION));
        link.borrow_mut().lose_receipt = 1;
        let mut ea =
            SyncEngine::start(&sa, ta, &a.trust(SESSION, &allowed), &clock, &cancel).unwrap();
        let mut eb =
            SyncEngine::start(&sb, tb, &b.trust(SESSION, &allowed), &clock, &cancel).unwrap();
        pump(&mut ea, &mut eb);
        assert!(!ea.needs_attention && !eb.needs_attention);
        for (s, ctx) in [(&sa, context(&a, &allowed)), (&sb, context(&b, &allowed))] {
            assert!(!s.summary(&ctx, &clock, &cancel).unwrap().needs_attention);
        }
    }
    let a = a.reopen();
    let b = b.reopen();
    for p in [&a, &b] {
        assert_eq!(p.count("captures"), 2);
        assert_eq!(p.count("sync_bundles"), 2);
        assert_eq!(p.count("import_g3_commits"), 2);
        assert_eq!(
            p.store
                .query_i64_for_test("SELECT max(applied) FROM import_progress"),
            2
        );
        assert_eq!(
            p.store.get_capture(&ca).unwrap(),
            a.store.get_capture(&ca).unwrap()
        );
        assert_eq!(
            p.store.get_capture(&cb).unwrap(),
            b.store.get_capture(&cb).unwrap()
        );
        for e in original_a.iter().chain(&original_b) {
            let held = test_events(&p.store)
                .into_iter()
                .find(|r| r.identity == e.identity)
                .unwrap();
            assert_eq!(held.bytes, e.bytes);
        }
    }
    // Local dependencies now cite the FOREIGN creation, never legacy or echo.
    f::capture_in(&b.store, &pa, "local after foreign project");
    f::capture_in(&a.store, &pb, "local after foreign project");
    let after = test_events(&b.store);
    let last = after
        .iter()
        .find(|e| {
            e.identity.origin == original_b[0].identity.origin
                && e.identity.incarnation != original_b[0].identity.incarnation
        })
        .unwrap();
    let core = ValidatedEvent::parse(last.clone()).unwrap();
    assert!(core.core().dependencies.iter().any(|d| d
        .event_ref
        .as_ref()
        .is_some_and(|r| r.event_id == original_a[0].identity.event.to_string())));
    a.reopen();
    b.reopen();
}
#[test]
fn g3_05_10_reprocess_is_atomic_resumable_and_epoch_bound() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&a.store, &["retained before policy"]);
    let event = test_events(&a.store).remove(0);
    let allowed = origins(&a, &b);
    let s = context(&b, &allowed);
    assert_eq!(
        receive(&CandidateSyncStore::synthetic(&b.store), &s, &event).outcome,
        Outcome::UnsupportedImportPolicy
    );
    let b = b.reopen();
    f::install_g3(&b.store);
    assert!(crate::storage::sync_store::test_refuses(
        &b.store,
        "UPDATE import_events SET outcome='applied'"
    ));

    b.store.execute_sql_for_test("CREATE TEMP TRIGGER g3_fault BEFORE UPDATE OF outcome ON import_events WHEN NEW.outcome='applied' BEGIN SELECT RAISE(ABORT,'late fault');END;");
    let adapter = CandidateSyncStore::synthetic(&b.store);
    let before = f::state(&b.store);
    assert!(matches!(
        adapter.reprocess(&s, &Clock::default(), &Cancellation::default()),
        Err(Error::Storage)
    ));
    assert_eq!(before, f::state(&b.store));
    assert_eq!(b.count("captures"), 0);
    b.store.execute_sql_for_test("DROP TRIGGER g3_fault;");
    drop(adapter);
    let b = b.reopen();
    let adapter = CandidateSyncStore::synthetic(&b.store);
    b.store
        .execute_sql_for_test("UPDATE import_members SET enabled=0;");
    assert_eq!(
        adapter.reprocess(&s, &Clock::default(), &Cancellation::default()),
        Err(Error::Trust)
    );
    assert_eq!(b.count("captures"), 0);
    b.store
        .execute_sql_for_test("UPDATE import_members SET enabled=1;");
    assert_eq!(
        adapter
            .reprocess(&s, &Clock::default(), &Cancellation::default())
            .unwrap(),
        1
    );
    assert_eq!(
        adapter
            .reprocess(&s, &Clock::default(), &Cancellation::default())
            .unwrap(),
        0
    );
    assert_eq!(
        receive(&adapter, &s, &event).outcome,
        Outcome::CleanlyApplied
    );
    assert_eq!(b.count("captures"), 1);
    assert_eq!(b.count("sync_bundles"), 0);
    drop(adapter);
    b.reopen();
}
#[test]
fn g3_06_17_guards_dependency_order_and_no_import_privilege_in_local_sql() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::install_g3(&b.store);
    let (project, _) = f::project_and_capture(&a.store, "Causal project", "child");
    let events = test_events(&a.store);
    let allowed = origins(&a, &b);
    let s = context(&b, &allowed);
    let adapter = CandidateSyncStore::synthetic(&b.store);
    assert_eq!(
        receive(&adapter, &s, &events[1]).outcome,
        Outcome::DeferredDependency
    );
    assert_eq!(b.count("captures"), 0);
    assert!(f::guard_refuses_capture(&b.store, &events[1]));
    assert_eq!(
        receive(&adapter, &s, &events[0]).outcome,
        Outcome::CleanlyApplied
    );
    for _ in 0..3 {
        adapter
            .reprocess(&s, &Clock::default(), &Cancellation::default())
            .unwrap();
    }
    assert_eq!(b.count("captures"), 1);
    // The committed observer SQL is EXACTLY the frozen source after exceptions.
    f::assert_insert_observers_frozen(&b.store);
    assert!(crate::storage::sync_store::test_refuses(&b.store,"INSERT INTO captures(id,source,content,created_at,project_id) VALUES('forged','text','x','now','00000000-0000-4000-8000-000000000001')"));
    assert!(crate::storage::sync_store::test_refuses(
        &b.store,
        "SELECT arthur_g3_row('captures','{}')"
    ));
    drop(adapter);
    f::capture_in(&b.store, &project, "ordinary local");
    b.reopen();
}
#[test]
fn g3_07_long_lived_local_kernel_observes_committed_foreign_dependencies() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::install_g3(&b.store);
    let (project, _) = f::project_and_capture(&a.store, "Live owner project", "source");
    let events = test_events(&a.store);
    let s = context(&b, &origins(&a, &b));
    f::held_kernel_continues(&b.store, &project, || {
        let adapter = CandidateSyncStore::synthetic(&b.store);
        assert_eq!(
            receive(&adapter, &s, &events[0]).outcome,
            Outcome::CleanlyApplied
        );
    });
    b.reopen();
}
#[test]
fn g3_11_paginated_257_source_disconnect_resume_and_exact_storage_pause() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::install_g3(&b.store);
    f::captures(&a.store, &vec!["bounded source"; 257]);
    let allowed = origins(&a, &b);
    let clock = Clock::default();
    let cancel = Cancellation::default();
    for session in [SESSION, Uuid::from_u128(700)] {
        let sa = CandidateSyncStore::synthetic(&a.store);
        let sb = CandidateSyncStore::synthetic(&b.store);
        let (ta, tb, link) = FakeTransport::pair(a.hello(session), b.hello(session));
        let mut ea =
            SyncEngine::start(&sa, ta, &a.trust(session, &allowed), &clock, &cancel).unwrap();
        let mut eb =
            SyncEngine::start(&sb, tb, &b.trust(session, &allowed), &clock, &cancel).unwrap();
        let mut paused = false;
        for _ in 0..2048 {
            ea.tick().unwrap();
            match eb.tick() {
                Ok(_) => {}
                Err(Error::StorageLimited) => {
                    paused = true;
                    assert_eq!(eb.status, SyncStatus::StorageLimited);
                    assert!(eb.needs_attention);
                    assert_eq!(eb.tick(), Err(Error::StorageLimited));
                    break;
                }
                Err(e) => panic!("unexpected {e:?}"),
            }
            if session == SESSION && b.count("captures") >= 70 {
                link.borrow_mut().online = false;
                assert_eq!(ea.tick(), Err(Error::Disconnected));
                break;
            }
        }
        if session != SESSION {
            assert!(paused);
        }
    }
    assert_eq!(b.count("import_events"), 256);
    assert_eq!(b.count("captures"), 256);
    assert_eq!(b.count("import_g3_commits"), 256);
    assert_eq!(
        b.store
            .query_i64_for_test("SELECT max(applied) FROM import_progress"),
        256
    );
    assert_eq!(
        a.store.query_i64_for_test(
            "SELECT count(*) FROM import_sent WHERE seq=257 AND outcome='offered'"
        ),
        1
    );
    assert_eq!(
        a.store
            .query_i64_for_test("SELECT coalesce(max(applied),0) FROM import_delivery"),
        256
    );
    b.reopen();
    a.reopen();
}
#[test]
fn g3_12_durable_origin_revocation_blocks_existing_session_before_mutation() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::install_g3(&b.store);
    f::captures(&a.store, &["origin revoked"]);
    let event = test_events(&a.store).remove(0);
    let s = context(&b, &origins(&a, &b));
    b.store
        .execute_sql_for_test("UPDATE import_origin_permissions SET enabled=0;");
    let adapter = CandidateSyncStore::synthetic(&b.store);
    assert!(matches!(
        adapter.retain(
            &s,
            ValidatedEvent::parse(event).unwrap(),
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Trust)
    ));
    assert_eq!(b.count("captures"), 0);
    assert_eq!(b.count("import_events"), 0);
}
#[test]
fn g3_14_recall_polling_after_import_never_embeds_captures_or_calls_models() {
    use crate::recall::{
        settings::SemanticSettings,
        testing::{run, ConceptEmbedder},
        RecallService,
    };
    use std::sync::Arc;
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::install_g3(&b.store);
    f::captures(&a.store, &["no automatic work"]);
    let embedder = Arc::new(ConceptEmbedder::plain(64));
    let settings = Arc::new(SemanticSettings::new(b.dir.path().join("semantic.json")));
    let service = RecallService::new(embedder.clone(), settings);
    service.settings().set(service.model_key(), true).unwrap();
    let s = context(&b, &origins(&a, &b));
    let adapter = CandidateSyncStore::synthetic(&b.store);
    receive(&adapter, &s, &test_events(&a.store)[0]);
    let report = run(service.index_pending(&b.store, 16)).unwrap();
    assert_eq!(report.embedded, 0);
    assert_eq!(embedder.request_count(), 0);
    assert_eq!(b.count("distillation_runs"), 0);
    assert_eq!(b.count("knowledge_objects"), 0);
    assert_eq!(b.count("revision_proposals"), 0);
    // Native importer has no route to command/subscription/provider execution.
    let source = include_str!("journal/g3.rs");
    for forbidden in [
        "crate::providers",
        "crate::commands",
        "crate::jev",
        "crate::distillation",
        "crate::evolution",
        "crate::graph",
        "tauri::",
        "std::process",
        "std::fs",
    ] {
        assert!(!source.contains(forbidden));
    }
}
#[test]
fn g3_05_commit_failure_rolls_back_real_domain_and_poisons_without_applied_ack() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::install_g3(&b.store);
    f::captures(&a.store, &["commit must fail"]);
    let s = context(&b, &origins(&a, &b));
    let adapter = CandidateSyncStore::synthetic(&b.store);
    b.store.execute_sql_for_test("CREATE TABLE g3_deferred(peer TEXT REFERENCES import_members(peer) DEFERRABLE INITIALLY DEFERRED);CREATE TEMP TRIGGER g3_commit AFTER INSERT ON import_progress BEGIN INSERT INTO g3_deferred VALUES('absent');END;");
    let before = f::state(&b.store);
    assert!(matches!(
        adapter.retain(
            &s,
            ValidatedEvent::parse(test_events(&a.store).remove(0)).unwrap(),
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Storage)
    ));
    assert_eq!(f::state(&b.store), before);
    assert_eq!(b.count("captures"), 0);
    assert_eq!(b.count("import_g3_commits"), 0);
    assert_eq!(
        adapter.reprocess(&s, &Clock::default(), &Cancellation::default()),
        Err(Error::Storage)
    );
    drop(adapter);
    b.reopen();
}
#[test]
fn g3_17_exact_native_row_capability_cannot_authorize_trigger_fanout() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::install_g3(&b.store);
    f::captures(&a.store, &["authorized row"]);
    let s = context(&b, &origins(&a, &b));
    let adapter = CandidateSyncStore::synthetic(&b.store);
    b.store.execute_sql_for_test("CREATE TEMP TRIGGER g3_fanout AFTER INSERT ON captures BEGIN INSERT INTO captures(id,source,content,created_at,project_id) VALUES('bbbbbbbb-1111-4111-8111-111111111111','text','forged fanout','2026-10-23T00:00:00Z','00000000-0000-4000-8000-000000000001');END;");
    assert!(matches!(
        adapter.retain(
            &s,
            ValidatedEvent::parse(test_events(&a.store).remove(0)).unwrap(),
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Storage)
    ));
    assert_eq!(b.count("captures"), 0);
    assert_eq!(b.count("import_events"), 0);
    f::assert_insert_observers_frozen(&b.store);
    b.store.execute_sql_for_test("DROP TRIGGER g3_fanout");
    assert_eq!(
        receive(&adapter, &s, &test_events(&a.store)[0]).outcome,
        Outcome::CleanlyApplied
    );
    f::assert_insert_observers_frozen(&b.store);
}
#[test]
fn g3_08_09_18_complex_historical_heads_reviews_and_archived_children_remain_blocked() {
    let a = Peer::graph(A, B);
    let b = Peer::graph(B, A);
    f::install_g3(&b.store);
    f::review_shared(&a.store, true);
    f::review_shared(&b.store, false);
    let s = context(&b, &origins(&a, &b));
    let adapter = CandidateSyncStore::synthetic(&b.store);
    let before = f::domain_state(&b.store);
    assert_eq!(
        receive(&adapter, &s, &test_events(&a.store)[0]).outcome,
        Outcome::ConflictRetained
    );
    assert_eq!(f::domain_state(&b.store), before);
    assert_eq!(b.count("import_g3_commits"), 0);
    drop(adapter);
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::install_g3(&b.store);
    f::project_capture(&a.store);
    f::archive(&b.store);
    let s = context(&b, &origins(&a, &b));
    let adapter = CandidateSyncStore::synthetic(&b.store);
    assert_eq!(
        receive(&adapter, &s, &test_events(&a.store)[0]).outcome,
        Outcome::ConflictRetained
    );
    assert_eq!(b.count("captures"), 0);
    assert!(matches!(
        CandidateSyncStore::production(&b.store),
        Err(Error::ActivationPending)
    ));
    assert!(matches!(
        ClosedTrust.verify(&b.hello(SESSION)),
        Err(Error::Trust)
    ));
}
#[test]
fn g3_10_reprocess_batches_resume_from_disk_without_outcome_only_upgrade() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&a.store, &vec!["later policy"; 33]);
    let events = test_events(&a.store);
    let s = context(&b, &origins(&a, &b));
    {
        let adapter = CandidateSyncStore::synthetic(&b.store);
        for e in &events {
            assert_eq!(
                receive(&adapter, &s, e).outcome,
                Outcome::UnsupportedImportPolicy
            );
        }
    }
    f::install_g3(&b.store);
    {
        let adapter = CandidateSyncStore::synthetic(&b.store);
        assert_eq!(
            adapter
                .reprocess(&s, &Clock::default(), &Cancellation::default())
                .unwrap(),
            REPROCESS_BATCH
        );
    }
    assert_eq!(b.count("captures"), 16);
    assert_eq!(b.count("import_g3_commits"), 16);
    let b = b.reopen();
    let adapter = CandidateSyncStore::synthetic(&b.store);
    assert_eq!(
        adapter
            .reprocess(&s, &Clock::default(), &Cancellation::default())
            .unwrap(),
        16
    );
    assert_eq!(
        adapter
            .reprocess(&s, &Clock::default(), &Cancellation::default())
            .unwrap(),
        1
    );
    assert_eq!(
        adapter
            .reprocess(&s, &Clock::default(), &Cancellation::default())
            .unwrap(),
        0
    );
    assert_eq!(b.count("captures"), 33);
    assert_eq!(b.count("import_g3_commits"), 33);
    assert_eq!(b.count("sync_bundles"), 0);
    assert!(
        !adapter
            .summary(&s, &Clock::default(), &Cancellation::default())
            .unwrap()
            .needs_attention
    );
    drop(adapter);
    b.reopen();
}
#[test]
fn g3_05_12_lease_expiry_immediately_before_commit_rolls_back_materialization() {
    struct Expire(Cell<usize>);
    impl SyncClock for Expire {
        fn now(&self) -> u64 {
            let n = self.0.get();
            self.0.set(n + 1);
            if n < 2 {
                0
            } else {
                100
            }
        }
    }
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&a.store, &["expiry before commit"]);
    let event = test_events(&a.store).remove(0);
    let s = context(&b, &origins(&a, &b));
    let adapter = CandidateSyncStore::synthetic(&b.store);
    receive(&adapter, &s, &event);
    f::install_g3(&b.store);
    let before = f::state(&b.store);
    let clock = Expire(Cell::new(0));
    assert_eq!(
        adapter.reprocess(&s, &clock, &Cancellation::default()),
        Err(Error::Trust)
    );
    assert_eq!(clock.0.get(), 3);
    assert_eq!(before, f::state(&b.store));
    assert_eq!(b.count("captures"), 0);
    assert_eq!(b.count("import_g3_commits"), 0);
    f::assert_insert_observers_frozen(&b.store);
}
#[test]
fn g3_13_original_unicode_span_outside_capture_is_terminally_rejected() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::install_g3(&b.store);
    f::review_history(&a.store);
    let events = test_events(&a.store);
    let s = context(&b, &origins(&a, &b));
    let adapter = CandidateSyncStore::synthetic(&b.store);
    assert_eq!(
        receive(&adapter, &s, &events[0]).outcome,
        Outcome::CleanlyApplied
    );
    let mut core = ValidatedEvent::parse(events[1].clone())
        .unwrap()
        .core()
        .clone();
    let mut changed = false;
    for op in &mut core.operations {
        if let codec::Operation::RecordCreate(row) = op {
            if row.after.contains_key("source_end") {
                row.after.insert(
                    "source_end".into(),
                    codec::FieldValue::Decimal("999999".into()),
                );
                changed = true;
            }
        }
    }
    assert!(changed);
    let bad = from_core(core);
    assert_eq!(
        receive(&adapter, &s, &bad).outcome,
        Outcome::RejectedIntegrity
    );
    assert_eq!(
        adapter
            .reprocess(&s, &Clock::default(), &Cancellation::default())
            .unwrap(),
        0
    );
    assert_eq!(b.count("captures"), 1);
    assert_eq!(b.count("knowledge_objects"), 0);
    assert_eq!(b.count("import_g3_commits"), 1);
    b.reopen();
}
#[test]
fn g3_10_reconnect_refreshes_sender_receipts_after_receiver_policy_upgrade() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&a.store, &vec!["old unsupported receipt"; 5]);
    run_pair(&a, &b, SESSION);
    f::install_g3(&b.store);
    let allowed = origins(&a, &b);
    let context_b = context(&b, &allowed);
    {
        let adapter = CandidateSyncStore::synthetic(&b.store);
        assert_eq!(
            adapter
                .reprocess(&context_b, &Clock::default(), &Cancellation::default())
                .unwrap(),
            5
        );
    }
    let a = a.reopen();
    let b = b.reopen();
    let sa = CandidateSyncStore::synthetic(&a.store);
    let sb = CandidateSyncStore::synthetic(&b.store);
    let clock = Clock::default();
    let cancel = Cancellation::default();
    let session = Uuid::from_u128(4040);
    let (ta, tb, _) = FakeTransport::pair(a.hello(session), b.hello(session));
    let mut ea = SyncEngine::start(&sa, ta, &a.trust(session, &allowed), &clock, &cancel).unwrap();
    let mut eb = SyncEngine::start(&sb, tb, &b.trust(session, &allowed), &clock, &cancel).unwrap();
    pump(&mut ea, &mut eb);
    assert_eq!(
        a.store
            .query_i64_for_test("SELECT count(*) FROM import_sent WHERE outcome='applied'"),
        5
    );
    assert_eq!(
        a.store
            .query_i64_for_test("SELECT max(applied) FROM import_delivery"),
        5
    );
    assert!(!ea.needs_attention && !eb.needs_attention);
    assert_eq!(b.count("captures"), 5);
    assert_eq!(b.count("sync_bundles"), 0);
}
#[test]
fn g3_05_large_chunked_multirow_import_rolls_back_as_one_domain_transaction() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::install_g3(&b.store);
    f::large(&a.store);
    let event = test_events(&a.store).remove(0);
    assert!(event.bytes.len() > MAX_FRAME);
    let allowed = origins(&a, &b);
    let s = context(&b, &allowed);
    let adapter = CandidateSyncStore::synthetic(&b.store);
    b.store.execute_sql_for_test("CREATE TEMP TRIGGER g3_second BEFORE INSERT ON captures WHEN (SELECT count(*) FROM captures)>=1 BEGIN SELECT RAISE(ABORT,'second row failure');END;");
    assert!(matches!(
        adapter.retain(
            &s,
            ValidatedEvent::parse(event.clone()).unwrap(),
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Storage)
    ));
    assert_eq!(b.count("captures"), 0);
    assert_eq!(b.count("import_events"), 0);
    assert_eq!(b.count("import_g3_commits"), 0);
    f::assert_insert_observers_frozen(&b.store);
    b.store.execute_sql_for_test("DROP TRIGGER g3_second;");
    drop(adapter);
    let sa = CandidateSyncStore::synthetic(&a.store);
    let sb = CandidateSyncStore::synthetic(&b.store);
    let clock = Clock::default();
    let cancel = Cancellation::default();
    let (ta, tb, _) = FakeTransport::pair(a.hello(SESSION), b.hello(SESSION));
    let mut ea = SyncEngine::start(&sa, ta, &a.trust(SESSION, &allowed), &clock, &cancel).unwrap();
    let mut eb = SyncEngine::start(&sb, tb, &b.trust(SESSION, &allowed), &clock, &cancel).unwrap();
    pump(&mut ea, &mut eb);
    assert_eq!(b.count("captures"), 60);
    assert_eq!(b.count("import_events"), 1);
    assert_eq!(b.count("import_g3_commits"), 1);
    assert_eq!(b.count("sync_bundles"), 0);
    assert!(!ea.needs_attention && !eb.needs_attention);
    assert_eq!(test_events(&b.store)[0].bytes, event.bytes);
    drop(ea);
    drop(eb);
    drop(sa);
    drop(sb);
    b.reopen();
}
#[test]
fn g3_10_forward_d1_upgrade_never_invents_historical_authorization() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::captures(&a.store, &["old D1 retained original"]);
    let allowed = origins(&a, &b);
    let event = test_events(&a.store).remove(0);
    let s = context(&b, &allowed);
    assert_eq!(
        receive(&CandidateSyncStore::synthetic(&b.store), &s, &event).outcome,
        Outcome::UnsupportedImportPolicy
    );
    // Restore exactly the old D1 schema surface: the D2 epoch/grant tables did
    // not exist. Domain data is untouched; the actual old unsupported core stays.
    b.store.execute_sql_for_test("DROP TRIGGER import_event_epoch_fixed;DROP TRIGGER import_event_epoch_retained;DROP TABLE import_event_epochs;DROP TABLE import_origin_permissions;");
    f::install_g3(&b.store);
    let s = context(&b, &allowed);
    let adapter = CandidateSyncStore::synthetic(&b.store);
    assert_eq!(
        adapter
            .reprocess(&s, &Clock::default(), &Cancellation::default())
            .unwrap(),
        0
    );
    assert_eq!(b.count("import_event_epochs"), 0);
    assert_eq!(b.count("captures"), 0);
    assert_eq!(
        receive(&adapter, &s, &event).outcome,
        Outcome::CleanlyApplied
    );
    assert_eq!(b.count("import_event_epochs"), 1);
    assert_eq!(b.count("captures"), 1);
    assert_eq!(b.count("sync_bundles"), 0);
    assert_eq!(test_events(&b.store)[0].bytes, event.bytes);
    drop(adapter);
    b.reopen();
}

#[path="sync_d3_tests.rs"]
mod d3;

#[path="sync_mvp_tests.rs"]
mod mvp1;

#[cfg(windows)]
#[path="sync_tls_tests.rs"]
mod r1;
