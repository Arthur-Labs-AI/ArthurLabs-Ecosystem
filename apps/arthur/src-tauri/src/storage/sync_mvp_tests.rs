//! Disposable native vertical slice. Qualification trust is NOT network authentication.
use super::*;

const CAPABILITY: &str = "m05-project-capture-mvp";

fn device(id: Uuid, other: Uuid) -> Peer {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let store = CaptureStore::open_owned(DataRootOwnership::try_acquire(&root).unwrap()).unwrap();
    f::upgrade(&store);
    install_candidate(&store, NETWORK, id, &[(other, 1)]).unwrap();
    f::install_g3(&store);
    Peer {
        dir,
        store,
        id,
        other,
    }
}

// Refuse the entire attempt, never omit unsupported links from an origin chain.
// This is deliberately only test orchestration, not production negotiation.
fn scope(peer: &Peer) -> std::result::Result<(), Outcome> {
    for envelope in test_events(&peer.store) {
        let event = ValidatedEvent::parse(envelope).map_err(|_| Outcome::RejectedIntegrity)?;
        if event.core().operations.iter().any(|op| {
            !matches!(op, codec::Operation::RecordCreate(_))
                || !matches!(
                    op.entity(),
                    codec::EntityKind::Projects | codec::EntityKind::Captures
                )
        }) {
            return Err(Outcome::UnsupportedImportPolicy);
        }
    }
    Ok(())
}

fn exchange(a: &Peer, b: &Peer, session: u128) -> std::result::Result<(), Outcome> {
    scope(a)?;
    scope(b)?;
    let session = Uuid::from_u128(session);
    let allowed = origins(a, b);
    let sa = CandidateSyncStore::synthetic(&a.store);
    let sb = CandidateSyncStore::synthetic(&b.store);
    let (ta, tb, _) = FakeTransport::pair(a.hello(session), b.hello(session));
    let clock = Clock::default();
    let cancel = Cancellation::default();
    let mut ea = SyncEngine::start(&sa, ta, &a.trust(session, &allowed), &clock, &cancel).unwrap();
    let mut eb = SyncEngine::start(&sb, tb, &b.trust(session, &allowed), &clock, &cancel).unwrap();
    pump(&mut ea, &mut eb);
    assert!(!ea.needs_attention && !eb.needs_attention);
    assert_eq!(
        (ea.status, eb.status),
        (SyncStatus::CleanlyApplied, SyncStatus::CleanlyApplied)
    );
    for (store, peer) in [(&sa, a), (&sb, b)] {
        assert!(
            !store
                .summary(&context(peer, &allowed), &clock, &cancel)
                .unwrap()
                .needs_attention
        );
        assert!(store
            .outstanding(&context(peer, &allowed), &clock, &cancel)
            .unwrap()
            .is_empty());
    }
    Ok(())
}

fn same_supported(a: &Peer, b: &Peer) {
    let ae = test_events(&a.store);
    let be = test_events(&b.store);
    assert_eq!(ae.len(), be.len());
    for event in ae {
        let held = be.iter().find(|e| e.identity == event.identity).unwrap();
        assert_eq!(held.bytes, event.bytes);
        let validated = ValidatedEvent::parse(event).unwrap();
        for op in &validated.core().operations {
            f::assert_same_row(&a.store, &b.store, op.entity(), op.key());
        }
    }
    for peer in [a, b] {
        f::clean(&peer.store);
        assert_eq!(peer.count("import_events"), peer.count("import_g3_commits"));
        assert_eq!(
            peer.store
                .query_i64_for_test("SELECT count(*) FROM import_events WHERE outcome<>'applied'"),
            0
        );
    }
}

fn no_provider_work(peer: &Peer) {
    use crate::recall::{
        settings::SemanticSettings,
        testing::{run, ConceptEmbedder},
        RecallService,
    };
    use std::sync::Arc;
    let embedder = Arc::new(ConceptEmbedder::plain(64));
    let settings = Arc::new(SemanticSettings::new(peer.dir.path().join("semantic.json")));
    let service = RecallService::new(embedder.clone(), settings);
    service.settings().set(service.model_key(), true).unwrap();
    assert_eq!(
        run(service.index_pending(&peer.store, 16))
            .unwrap()
            .embedded,
        0
    );
    assert_eq!(embedder.request_count(), 0);
    for table in [
        "distillation_runs",
        "knowledge_objects",
        "revision_proposals",
    ] {
        assert_eq!(peer.count(table), 0);
    }
}

#[test]
fn mvp1_round_trip_repeated_sync_disconnect_restart_both_owners() {
    let a = device(A, B);
    let b = device(B, A);
    assert_ne!(a.dir.path(), b.dir.path());
    for peer in [&a, &b] {
        assert!(DataRootOwnership::try_acquire(&peer.dir.path().canonicalize().unwrap()).is_err());
    }
    let (project, capture) =
        f::project_and_capture(&a.store, "MVP project", "А́ 😀\u{200d}🚀\n原文\tß");
    exchange(&a, &b, 1001).unwrap();
    assert_eq!(
        b.store.get_capture(&capture).unwrap(),
        a.store.get_capture(&capture).unwrap()
    );
    assert_eq!(b.count("captures"), 1);
    f::capture_in(&b.store, &project, "B → A, imported project");
    exchange(&a, &b, 1002).unwrap();
    same_supported(&a, &b);
    let counts = |p: &Peer| {
        (
            p.count("captures"),
            p.count("sync_bundles"),
            p.count("import_events"),
            p.count("import_g3_commits"),
        )
    };
    let before = (counts(&a), counts(&b));
    exchange(&a, &b, 1003).unwrap();
    assert_eq!((counts(&a), counts(&b)), before);
    // An explicit canonical event replay uses the same real importer, not only inventory deduplication.
    let original = test_events(&a.store)[0].clone();
    let allowed = origins(&a, &b);
    assert_eq!(
        receive(
            &CandidateSyncStore::synthetic(&b.store),
            &context(&b, &allowed),
            &original
        )
        .outcome,
        Outcome::CleanlyApplied
    );
    assert_eq!((counts(&a), counts(&b)), before);
    same_supported(&a, &b);

    f::capture_in(&a.store, &project, "committed before lost receipt");
    {
        let session = Uuid::from_u128(1004);
        let allowed = origins(&a, &b);
        let sa = CandidateSyncStore::synthetic(&a.store);
        let sb = CandidateSyncStore::synthetic(&b.store);
        let (ta, tb, link) = FakeTransport::pair(a.hello(session), b.hello(session));
        link.borrow_mut().lose_receipt = 1000;
        let clock = Clock::default();
        let cancel = Cancellation::default();
        let mut ea =
            SyncEngine::start(&sa, ta, &a.trust(session, &allowed), &clock, &cancel).unwrap();
        let mut eb =
            SyncEngine::start(&sb, tb, &b.trust(session, &allowed), &clock, &cancel).unwrap();
        for _ in 0..512 {
            ea.tick().unwrap();
            eb.tick().unwrap();
            if b.count("captures") == 3 {
                break;
            }
        }
        assert_eq!(b.count("captures"), 3);
        // The receiver committed; the sender has not received its durable acknowledgement.
        assert!(!sa
            .outstanding(&context(&a, &allowed), &clock, &cancel)
            .unwrap()
            .is_empty());
        link.borrow_mut().online = false;
        assert_eq!(ea.tick(), Err(Error::Disconnected));
        assert_eq!(eb.tick(), Err(Error::Disconnected));
    }
    let a = a.reopen();
    let b = b.reopen();
    same_supported(&a, &b);
    exchange(&a, &b, 1005).unwrap();
    exchange(&a, &b, 1006).unwrap();
    same_supported(&a, &b);
    assert_eq!((counts(&a), counts(&b)), ((3, 3, 1, 1), (3, 1, 3, 3)));
    for peer in [&a, &b] {
        no_provider_work(peer);
    }
    println!("{CAPABILITY}: A→B project/capture; B→A capture; exact rows/events; repeat/replay; disconnect; both owners reopened; durable resume; zero provider requests PASS (test fixture, no encrypted LAN)");
}

#[test]
fn mvp1_unsupported_mutation_refuses_whole_attempt_without_partial_success() {
    let a = device(A, B);
    let b = device(B, A);
    let (project, _) = f::project_and_capture(&a.store, "local", "local capture");
    f::rename_id(&a.store, &project, "local update unsupported by MVP");
    let before = (f::state(&a.store), f::state(&b.store));
    assert_eq!(
        exchange(&a, &b, 1007),
        Err(Outcome::UnsupportedImportPolicy)
    );
    assert_eq!((f::state(&a.store), f::state(&b.store)), before);
    assert_eq!(b.count("captures"), 0);
}

#[test]
fn mvp1_wrong_peer_network_and_corrupt_payload_cannot_mutate_receiver() {
    let a = device(A, B);
    f::project_and_capture(&a.store, "source", "unaltered original");
    for fault in 0..3 {
        let b = device(B, A);
        let allowed = origins(&a, &b);
        let db = CandidateSyncStore::synthetic(&b.store);
        let clock = Clock::default();
        let cancel = Cancellation::default();
        let (mut engine, mut sender) = negotiate_receiver(&db, &a, &b, &clock, &cancel, &allowed);
        let before = f::state(&b.store);
        let mut chunks = chunk_event(&test_events(&a.store)[0]);
        assert_eq!(chunks.len(), 1);
        let mut packet = message(&a.hello(SESSION), Payload::Chunk(chunks.remove(0)));
        match fault {
            0 => packet.from = Uuid::from_u128(9999),
            1 => packet.network = Uuid::from_u128(9999),
            _ => {
                if let Payload::Chunk(chunk) = &mut packet.payload {
                    chunk.bytes[0] ^= 1;
                }
            }
        }
        sender.send(packet).unwrap();
        let expected = if fault == 2 {
            Error::Integrity
        } else {
            Error::Trust
        };
        assert_eq!(engine.tick(), Err(expected));
        assert!(engine.needs_attention);
        assert_eq!(
            engine.status,
            if fault == 2 {
                SyncStatus::RejectedIntegrity
            } else {
                SyncStatus::RejectedTrust
            }
        );
        assert_eq!(f::state(&b.store), before);
        assert_eq!(b.count("captures"), 0);
        assert_eq!(engine.tick(), Err(expected));
    }
}

#[test]
fn mvp1_out_of_order_capture_is_pending_until_original_project_arrives() {
    let a = device(A, B);
    let b = device(B, A);
    f::project_and_capture(&a.store, "dependency", "held pending original project");
    let events = test_events(&a.store);
    let allowed = origins(&a, &b);
    let db = CandidateSyncStore::synthetic(&b.store);
    let clock = Clock::default();
    let cancel = Cancellation::default();
    let (mut engine, mut sender) = negotiate_receiver(&db, &a, &b, &clock, &cancel, &allowed);
    for chunk in chunk_event(&events[1]) {
        sender
            .send(message(&a.hello(SESSION), Payload::Chunk(chunk)))
            .unwrap();
        engine.tick().unwrap();
    }
    assert_eq!(engine.status, SyncStatus::DeferredDependency);
    assert!(engine.needs_attention);
    assert_eq!(b.count("captures"), 0);
    assert_eq!(b.count("import_g3_commits"), 0);
    for chunk in chunk_event(&events[0]) {
        sender
            .send(message(&a.hello(SESSION), Payload::Chunk(chunk)))
            .unwrap();
        engine.tick().unwrap();
    }
    db.reprocess(&context(&b, &allowed), &clock, &cancel)
        .unwrap();
    same_supported(&a, &b);
    assert_eq!(b.count("captures"), 1);
    assert!(
        !db.summary(&context(&b, &allowed), &clock, &cancel)
            .unwrap()
            .needs_attention
    );
}
