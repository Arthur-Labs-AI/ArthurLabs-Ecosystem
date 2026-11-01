//! R5: existing D3/D4 policies over the R1 TLS adapter. Qualification only.
use super::*;
#[path = "sync_r6_tests.rs"]
mod r6;

fn history_device(id: Uuid, other: Uuid) -> Peer {
    let p = device(id, other);
    f::install_history(&p.store);
    f::install_d4(&p.store);
    p
}

// The candidate policy, not the create-only MVP preflight, decides outcomes.
// No operation is filtered out of an origin chain.
async fn history_exchange(
    a: &Peer,
    b: &Peer,
    ka: &Fixture,
    kb: &Fixture,
    session: u128,
    bootstrap: bool,
) -> [(SyncStatus, bool); 2] {
    history_exchange_snapshot(a, b, ka, kb, session, bootstrap.then(Uuid::new_v4)).await
}
async fn history_exchange_snapshot(
    a: &Peer,
    b: &Peer,
    ka: &Fixture,
    kb: &Fixture,
    session: u128,
    bootstrap: Option<Uuid>,
) -> [(SyncStatus, bool); 2] {
    let allowed = origins(a, b);
    let sa = CandidateSyncStore::synthetic(&a.store);
    let sb = CandidateSyncStore::synthetic(&b.store);
    let (wire, ta, tb) = connect(a, b, ka, kb, session).await;
    let clock = Clock::default();
    let cancel = Cancellation::default();
    let mut ea = SyncEngine::start(
        &sa,
        ta,
        &a.trust(Uuid::from_u128(session), &allowed),
        &clock,
        &cancel,
    )
    .unwrap();
    let mut eb = SyncEngine::start(
        &sb,
        tb,
        &b.trust(Uuid::from_u128(session), &allowed),
        &clock,
        &cancel,
    )
    .unwrap();
    if let Some(id) = bootstrap {
        ea.bootstrap(id).unwrap();
    }
    for _ in 0..512 {
        wire.transfer().await.unwrap();
        let aa = ea.tick().unwrap();
        let bb = eb.tick().unwrap();
        if !aa && !bb {
            assert!(wire.wire_bytes() > 0);
            return [
                (ea.status, ea.needs_attention),
                (eb.status, eb.needs_attention),
            ];
        }
    }
    panic!("history exchange exceeded bounded turns");
}

fn clean_status(result: [(SyncStatus, bool); 2]) {
    assert_eq!(result, [(SyncStatus::CleanlyApplied, false); 2]);
}

#[test]
fn r5_tls_bidirectional_knowledge_history_bootstrap_replay_and_restart() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = history_device(ka.public.peer_id(), kb.public.peer_id());
        let b = history_device(kb.public.peer_id(), ka.public.peer_id());
        let project = f::project_only(&a.store, "Knowledge history");
        let (cap, object, root) = f::history(&a.store);
        f::move_capture_id(&a.store, &cap, &project);
        let evidence = f::evidenced_branch(&a.store, &cap, &object, &root);
        let (_, second, _) = f::history(&a.store);
        let edge = f::relation(&a.store, &object, &second);
        f::rename_id(&a.store, &project, "Historical rename");
        clean_status(history_exchange(&a, &b, &ka, &kb, 5001, true).await);
        same_supported(&a, &b);
        assert_eq!(b.store.revision_evidence(&evidence).unwrap().len(), 1);
        assert_eq!(b.store.list_relations().unwrap()[0].id, edge);
        assert_eq!(
            b.store.current_revision_id_of(&object).unwrap(),
            Some(root.clone())
        );

        // B adds a native immutable branch to A's imported object.
        let reverse = f::evidenced_branch(&b.store, &cap, &object, &root);
        // D4 permits selected-head transitions at the receiving owner only
        // when it has no independently authored head for that object.
        f::history_with_selected_edit(&b.store);
        clean_status(history_exchange(&a, &b, &ka, &kb, 5002, false).await);
        same_supported(&a, &b);
        assert_eq!(a.store.revision_evidence(&reverse).unwrap().len(), 1);
        let before = (f::state(&a.store), f::state(&b.store));
        clean_status(history_exchange(&a, &b, &ka, &kb, 5003, false).await);
        assert_eq!((f::state(&a.store), f::state(&b.store)), before);
        let a = a.reopen();
        let b = b.reopen();
        // The original bootstrap and incremental tail both survive reopening.
        clean_status(history_exchange(&a, &b, &ka, &kb, 5004, false).await);
        same_supported(&a, &b);
        assert_eq!(b.count("thought_revisions"), 9);
        assert_eq!(b.count("revision_evidence"), 2);
        assert_eq!(b.count("bootstrap_units"), 1);
    });
}

#[test]
fn r5_tls_competing_heads_retain_originals_and_never_report_clean() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = history_device(ka.public.peer_id(), kb.public.peer_id());
        let b = history_device(kb.public.peer_id(), ka.public.peer_id());
        let (_, object, _) = f::history(&a.store);
        clean_status(history_exchange(&a, &b, &ka, &kb, 5010, false).await);
        f::edit_id(&a.store, &object, "A competing head");
        f::edit_id(&b.store, &object, "B competing head");
        let heads = (
            a.store.current_revision_id_of(&object).unwrap(),
            b.store.current_revision_id_of(&object).unwrap(),
        );
        let originals = (f::last_original(&a.store), f::last_original(&b.store));
        let result = history_exchange(&a, &b, &ka, &kb, 5011, false).await;
        for (status, attention) in result {
            assert!(attention);
            assert_ne!(status, SyncStatus::CleanlyApplied);
        }
        for (p, original) in [(&a, &originals.1), (&b, &originals.0)] {
            assert!(p.count("import_conflicts") > 0);
            assert!(test_events(&p.store)
                .iter()
                .any(|e| e.identity == original.identity && e.bytes == original.bytes));
            f::clean(&p.store);
        }
        assert_eq!(
            (
                a.store.current_revision_id_of(&object).unwrap(),
                b.store.current_revision_id_of(&object).unwrap()
            ),
            heads
        );
        a.reopen();
        b.reopen();
    });
}

#[test]
fn r5_tls_multi_operation_commit_full_ioerr_no_receipt_restart_retry() {
    execute(async {
        for sync_io in [false, true] {
            let ka = Fixture::new().unwrap();
            let kb = Fixture::new().unwrap();
            let a = history_device(ka.public.peer_id(), kb.public.peer_id());
            let b = history_device(kb.public.peer_id(), ka.public.peer_id());
            f::history(&a.store);
            // history() uses one native kernel: Capture then multi-row distillation.
            let events = test_events(&a.store);
            let allowed = origins(&a, &b);
            let session = Uuid::from_u128(5020);
            let (wire, mut ta, tb) = connect(&a, &b, &ka, &kb, 5020).await;
            let db = CandidateSyncStore::synthetic(&b.store);
            let clock = Clock::default();
            let cancel = Cancellation::default();
            let mut eb =
                SyncEngine::start(&db, tb, &b.trust(session, &allowed), &clock, &cancel).unwrap();
            ta.send(message(
                &a.hello(session),
                Payload::Hello {
                    version: 1,
                    required: FEATURES,
                    supported: FEATURES,
                    profile: "m05-ledger-candidate".into(),
                },
            ))
            .unwrap();
            wire.transfer().await.unwrap();
            eb.tick().unwrap();
            for chunk in chunk_event(&events[0]) {
                ta.send(message(&a.hello(session), Payload::Chunk(chunk)))
                    .unwrap();
            }
            wire.transfer().await.unwrap();
            eb.tick().unwrap();
            wire.transfer().await.unwrap();
            while ta.receive().unwrap().is_some() {}
            let before = f::state(&b.store);
            assert!(
                ValidatedEvent::parse(events[1].clone())
                    .unwrap()
                    .core()
                    .operations
                    .len()
                    >= 4
            );
            f::with_import_fault(&b.store, sync_io, async {
                for chunk in chunk_event(&events[1]) {
                    ta.send(message(&a.hello(session), Payload::Chunk(chunk)))
                        .unwrap();
                }
                wire.transfer().await.unwrap();
                assert_eq!(eb.tick(), Err(Error::CommitUncertain));
                assert_eq!(eb.status, SyncStatus::StorageLimited);
                assert!(eb.needs_attention);
            })
            .await;
            wire.transfer().await.unwrap();
            assert!(
                ta.receive().unwrap().is_none(),
                "failed COMMIT must not send a receipt"
            );
            assert_eq!(f::state(&b.store), before);
            assert_eq!(b.count("knowledge_objects"), 0);
            f::clean(&b.store);
            drop(eb);
            drop(db);
            drop(wire);
            let a = a.reopen();
            let b = b.reopen();
            clean_status(history_exchange(&a, &b, &ka, &kb, 5021, true).await);
            same_supported(&a, &b);
        }
    });
}

#[test]
fn r5_tls_pending_dependency_survives_later_applied_event_without_false_clean() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = history_device(ka.public.peer_id(), kb.public.peer_id());
        let b = history_device(kb.public.peer_id(), ka.public.peer_id());
        f::history(&a.store);
        let events = test_events(&a.store);
        let allowed = origins(&a, &b);
        let session = Uuid::from_u128(5030);
        let (wire, mut ta, tb) = connect(&a, &b, &ka, &kb, 5030).await;
        let db = CandidateSyncStore::synthetic(&b.store);
        let clock = Clock::default();
        let cancel = Cancellation::default();
        let mut eb =
            SyncEngine::start(&db, tb, &b.trust(session, &allowed), &clock, &cancel).unwrap();
        ta.send(message(
            &a.hello(session),
            Payload::Hello {
                version: 1,
                required: FEATURES,
                supported: FEATURES,
                profile: "m05-ledger-candidate".into(),
            },
        ))
        .unwrap();
        wire.transfer().await.unwrap();
        eb.tick().unwrap();
        // Branch before its object; then an unrelated valid Capture. The latter
        // receipt must not hide the former's durable dependency gap.
        for event in [&events[2], &events[0]] {
            for chunk in chunk_event(event) {
                ta.send(message(&a.hello(session), Payload::Chunk(chunk)))
                    .unwrap();
            }
            wire.transfer().await.unwrap();
            eb.tick().unwrap();
        }
        assert!(eb.needs_attention);
        assert_eq!(eb.status, SyncStatus::DeferredDependency);
        assert_eq!(b.count("thought_revisions"), 0);
        assert_eq!(b.count("import_pending") > 0, true);
        f::clean(&b.store);
    });
}

#[test]
fn r5_tls_approval_history_remains_unsupported_without_automatic_review() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = history_device(ka.public.peer_id(), kb.public.peer_id());
        let b = history_device(kb.public.peer_id(), ka.public.peer_id());
        f::review_history(&a.store);
        let result = history_exchange(&a, &b, &ka, &kb, 5040, false).await;
        for (status, attention) in result {
            assert!(attention);
            assert_ne!(status, SyncStatus::CleanlyApplied);
        }
        assert_eq!(
            b.store.query_i64_for_test(
                "SELECT count(*) FROM revision_proposals WHERE state='approved'"
            ),
            0
        );
        assert!(
            b.store.query_i64_for_test(
                "SELECT count(*) FROM import_events WHERE outcome='unsupported'"
            ) > 0
        );
        f::clean(&b.store);
    });
}

#[test]
fn r5_tls_window_drains_more_than_one_batch_without_dropping_history() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = history_device(ka.public.peer_id(), kb.public.peer_id());
        let b = history_device(kb.public.peer_id(), ka.public.peer_id());
        f::captures(
            &a.store,
            &["one", "two", "three", "four", "five", "six", "seven"],
        );
        clean_status(history_exchange(&a, &b, &ka, &kb, 5050, false).await);
        same_supported(&a, &b);
        assert_eq!(b.count("captures"), 7);
    });
}

#[test]
fn r5_tls_new_knowledge_requires_author_scope_and_current_membership() {
    execute(async {
        for revoke in [false, true] {
            let ka = Fixture::new().unwrap();
            let kb = Fixture::new().unwrap();
            let a = history_device(ka.public.peer_id(), kb.public.peer_id());
            let b = history_device(kb.public.peer_id(), ka.public.peer_id());
            f::history(&a.store);
            let events = test_events(&a.store);
            let allowed = if revoke {
                origins(&a, &b)
            } else {
                BTreeSet::new()
            };
            let session = Uuid::from_u128(5060);
            let (wire, mut ta, tb) = connect(&a, &b, &ka, &kb, 5060).await;
            let db = CandidateSyncStore::synthetic(&b.store);
            let clock = Clock::default();
            let cancel = Cancellation::default();
            let mut eb =
                SyncEngine::start(&db, tb, &b.trust(session, &allowed), &clock, &cancel).unwrap();
            ta.send(message(
                &a.hello(session),
                Payload::Hello {
                    version: 1,
                    required: FEATURES,
                    supported: FEATURES,
                    profile: "m05-ledger-candidate".into(),
                },
            ))
            .unwrap();
            wire.transfer().await.unwrap();
            eb.tick().unwrap();
            if revoke {
                b.store
                    .execute_sql_for_test("UPDATE import_members SET enabled=0");
            }
            let before = f::state(&b.store);
            for chunk in chunk_event(&events[1]) {
                ta.send(message(&a.hello(session), Payload::Chunk(chunk)))
                    .unwrap();
            }
            wire.transfer().await.unwrap();
            assert_eq!(eb.tick(), Err(Error::Trust));
            assert_eq!(eb.status, SyncStatus::RejectedTrust);
            assert_eq!(f::state(&b.store), before);
            assert_eq!(b.count("knowledge_objects"), 0);
        }
    });
}

#[test]
fn r5_tls_foreign_selected_head_cannot_overwrite_locally_authored_head() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = history_device(ka.public.peer_id(), kb.public.peer_id());
        let b = history_device(kb.public.peer_id(), ka.public.peer_id());
        let (_, object, root) = f::history(&a.store);
        clean_status(history_exchange(&a, &b, &ka, &kb, 5070, true).await);
        f::edit_id(
            &b.store,
            &object,
            "Foreign selection requires policy approval",
        );
        let original = f::last_original(&b.store);
        let result = history_exchange(&a, &b, &ka, &kb, 5071, false).await;
        assert_eq!(result[0], (SyncStatus::UnsupportedImportPolicy, true));
        assert_eq!(a.store.current_revision_id_of(&object).unwrap(), Some(root));
        assert!(test_events(&a.store)
            .iter()
            .any(|e| e.identity == original.identity && e.bytes == original.bytes));
        f::clean(&a.store);
    });
}

#[test]
fn r5_tls_tampered_bootstrap_chunk_never_publishes_or_acknowledges() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = history_device(ka.public.peer_id(), kb.public.peer_id());
        let b = history_device(kb.public.peer_id(), ka.public.peer_id());
        f::history(&a.store);
        let allowed = origins(&a, &b);
        let session = Uuid::from_u128(5080);
        let clock = Clock::default();
        let cancel = Cancellation::default();
        let export = CandidateSyncStore::synthetic(&a.store)
            .snapshot_capture(&context(&a, &allowed), Uuid::new_v4(), &clock, &cancel)
            .unwrap();
        let (wire, mut ta, tb) = connect(&a, &b, &ka, &kb, 5080).await;
        let db = CandidateSyncStore::synthetic(&b.store);
        let mut eb =
            SyncEngine::start(&db, tb, &b.trust(session, &allowed), &clock, &cancel).unwrap();
        ta.send(message(
            &a.hello(session),
            Payload::Hello {
                version: 1,
                required: FEATURES,
                supported: FEATURES,
                profile: "m05-ledger-candidate".into(),
            },
        ))
        .unwrap();
        wire.transfer().await.unwrap();
        eb.tick().unwrap();
        ta.send(message(
            &a.hello(session),
            Payload::SnapshotOffer(export.offer.clone()),
        ))
        .unwrap();
        wire.transfer().await.unwrap();
        eb.tick().unwrap();
        let before = f::domain_state(&b.store);
        let mut chunk = export.chunks().remove(0);
        chunk.bytes[0] ^= 1;
        ta.send(message(&a.hello(session), Payload::SnapshotChunk(chunk)))
            .unwrap();
        wire.transfer().await.unwrap();
        assert_eq!(eb.tick(), Err(Error::Integrity));
        assert_eq!(eb.status, SyncStatus::RejectedIntegrity);
        assert!(eb.needs_attention);
        wire.transfer().await.unwrap();
        while let Some(m) = ta.receive().unwrap() {
            assert!(!matches!(m.payload, Payload::SnapshotReceipt(_)));
        }
        assert_eq!(f::domain_state(&b.store), before);
        assert_eq!(b.count("import_g3_commits"), 0);
        f::clean(&b.store);
    });
}
