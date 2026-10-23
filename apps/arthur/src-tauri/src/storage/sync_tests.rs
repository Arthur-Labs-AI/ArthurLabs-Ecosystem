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
    assert!(
        include_str!("../sync/trust.rs").contains("#[cfg(test)]\nimpl TrustVerifier for TestTrust")
    );
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
        Err(Error::Limit)
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
