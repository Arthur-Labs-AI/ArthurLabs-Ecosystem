//! R6 extends the existing R1/R5 TLS driver, not the transport or protocol.
use super::*;

#[test]
fn r6_tls_published_bootstrap_without_durable_receipt_is_not_clean() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = history_device(ka.public.peer_id(), kb.public.peer_id());
        let b = history_device(kb.public.peer_id(), ka.public.peer_id());
        f::history(&b.store);
        clean_status(history_exchange(&b, &a, &kb, &ka, 6069, false).await);
        f::history(&a.store);
        let allowed = origins(&a, &b);
        let session = Uuid::from_u128(6070);
        let clock = Clock::default();
        let cancel = Cancellation::default();
        let source = CandidateSyncStore::synthetic(&a.store);
        let (wire, ta, mut tb) = connect(&a, &b, &ka, &kb, 6070).await;
        let mut ea =
            SyncEngine::start(&source, ta, &a.trust(session, &allowed), &clock, &cancel).unwrap();
        ea.bootstrap(Uuid::new_v4()).unwrap();
        tb.send(message(
            &b.hello(session),
            Payload::Hello {
                version: 1,
                required: FEATURES,
                supported: FEATURES,
                profile: "m05-ledger-candidate".into(),
            },
        ))
        .unwrap();
        let mut published = false;
        for _ in 0..64 {
            wire.transfer().await.unwrap();
            let worked = ea.tick().unwrap();
            while let Some(m) = tb.receive().unwrap() {
                if matches!(m.payload, Payload::SnapshotPublish(_)) {
                    published = true;
                }
            }
            if published && !worked {
                break;
            }
        }
        assert!(published);
        assert_eq!(
            ea.status,
            SyncStatus::Syncing,
            "sending publication is not a durable receipt"
        );
        assert_eq!(
            a.store.query_i64_for_test(
                "SELECT count(*) FROM bootstrap_units WHERE direction='out' AND outcome='applied'"
            ),
            0
        );
        wire.abort(Error::Disconnected);
        assert_eq!(ea.tick(), Err(Error::Disconnected));
        assert!(ea.needs_attention);
    });
}

#[test]
fn r6_tls_cross_origin_incremental_child_first_reopen_converges_without_bootstrap() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = history_device(ka.public.peer_id(), kb.public.peer_id());
        let b = history_device(kb.public.peer_id(), ka.public.peer_id());
        f::history(&b.store);
        clean_status(history_exchange(&b, &a, &kb, &ka, 5999, false).await);
        let project = f::project_only(&a.store, "Cross-origin dependencies");
        let (capture, object, root) = f::history(&a.store);
        f::move_capture_id(&a.store, &capture, &project);
        f::evidenced_branch(&a.store, &capture, &object, &root);
        let (_, other, _) = f::history(&a.store);
        f::relation(&a.store, &object, &other);
        let events = test_events(&a.store);
        assert!(origins(&a, &b).len() > 1);
        let local_origin = f::last_original(&a.store).identity.origin;
        let child = events
            .iter()
            .find(|e| {
                e.identity.origin == local_origin
                    && ValidatedEvent::parse((*e).clone())
                        .unwrap()
                        .core()
                        .operations
                        .iter()
                        .any(|op| op.entity() == codec::EntityKind::RevisionParents)
            })
            .unwrap();
        let allowed = origins(&a, &b);
        let session = Uuid::from_u128(6000);
        {
            let (wire, mut ta, tb) = connect(&a, &b, &ka, &kb, 6000).await;
            let source = CandidateSyncStore::synthetic(&a.store);
            let target = CandidateSyncStore::synthetic(&b.store);
            let clock = Clock::default();
            let cancel = Cancellation::default();
            let mut eb =
                SyncEngine::start(&target, tb, &b.trust(session, &allowed), &clock, &cancel)
                    .unwrap();
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
            let s = a
                .trust(session, &allowed)
                .verify(&a.hello(session))
                .unwrap();
            source
                .offered(&s, &child.identity, &clock, &cancel)
                .unwrap();
            for chunk in chunk_event(child) {
                ta.send(message(&a.hello(session), Payload::Chunk(chunk)))
                    .unwrap();
            }
            wire.transfer().await.unwrap();
            eb.tick().unwrap();
            assert_eq!(eb.status, SyncStatus::DeferredDependency);
            assert!(eb.needs_attention);
            assert_eq!(b.count("import_events"), 1);
            assert_eq!(b.count("import_g3_commits"), 0);
            wire.abort(Error::Disconnected);
            assert_eq!(eb.tick(), Err(Error::Disconnected));
        }
        let a = a.reopen();
        let b = b.reopen();
        clean_status(history_exchange(&a, &b, &ka, &kb, 6001, false).await);
        same_supported(&a, &b);
        assert_eq!(a.count("bootstrap_units"), 0);
        assert_eq!(b.count("bootstrap_units"), 0);
        assert_eq!(b.count("import_pending"), 0);
        assert_eq!(b.count("thought_revisions"), 7);
    });
}

#[test]
fn r6_tls_near_four_mib_bootstrap_streams_with_maximum_unicode_records() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = history_device(ka.public.peer_id(), kb.public.peer_id());
        let b = history_device(kb.public.peer_id(), ka.public.peer_id());
        let ascii = "x".repeat(crate::storage::capture_store::MAX_CAPTURE_CONTENT_CHARS);
        let unicode = "🚀".repeat(crate::storage::capture_store::MAX_CAPTURE_CONTENT_CHARS);
        let mut records = vec![ascii.as_str(); 59];
        records.extend([unicode.as_str(); 2]);
        f::captures(&a.store, &records);
        let id = Uuid::new_v4();
        let allowed = origins(&a, &b);
        {
            let clock = Clock::default();
            let cancel = Cancellation::default();
            let snapshot = CandidateSyncStore::synthetic(&a.store)
                .snapshot_capture(&context(&a, &allowed), id, &clock, &cancel)
                .unwrap();
            let session = Uuid::from_u128(6009);
            let (wire, mut ta, tb) = connect(&a, &b, &ka, &kb, 6009).await;
            let target = CandidateSyncStore::synthetic(&b.store);
            let mut eb =
                SyncEngine::start(&target, tb, &b.trust(session, &allowed), &clock, &cancel)
                    .unwrap();
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
                Payload::SnapshotOffer(snapshot.offer.clone()),
            ))
            .unwrap();
            wire.transfer().await.unwrap();
            eb.tick().unwrap();
            for _ in 0..2 {
                ta.send(message(
                    &a.hello(session),
                    Payload::SnapshotChunk(snapshot.chunk(0).unwrap()),
                ))
                .unwrap();
                wire.transfer().await.unwrap();
                eb.tick().unwrap();
            }
            assert_eq!(b.count("bootstrap_chunks"), 1);
            assert_eq!(b.count("captures"), 0);
            wire.abort(Error::Disconnected);
            assert_eq!(eb.tick(), Err(Error::Disconnected));
            assert_ne!(eb.status, SyncStatus::CleanlyApplied);
            assert!(eb.needs_attention);
        }
        let a = a.reopen();
        let b = b.reopen();
        clean_status(history_exchange_snapshot(&a, &b, &ka, &kb, 6010, Some(id)).await);
        let bytes = a
            .store
            .query_i64_for_test("SELECT bytes FROM bootstrap_units WHERE direction='out'")
            as usize;
        assert!(bytes <= crate::sync::bootstrap::BOOTSTRAP_BYTES);
        assert!(
            bytes >= crate::sync::bootstrap::BOOTSTRAP_BYTES - CHUNK,
            "near-limit native manifest was only {bytes} bytes"
        );
        same_supported(&a, &b);
        assert_eq!(b.count("captures"), 61);
        println!("R6 TLS native bootstrap: {bytes} bytes; fixed 4 MiB cap, 256 KiB chunks, 64 KiB records, 1 MiB serialized assembly");
    });
}

#[test]
fn r6_tls_bootstrap_maximum_native_event_and_row_counts() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = history_device(ka.public.peer_id(), kb.public.peer_id());
        let b = history_device(kb.public.peer_id(), ka.public.peer_id());
        // One fixed Inbox row plus 2,047 captures, in exactly 64 native events.
        f::capture_batches(&a.store, 2047, 32);
        assert_eq!(
            test_events(&a.store).len(),
            crate::sync::bootstrap::BOOTSTRAP_EVENTS
        );
        clean_status(history_exchange(&a, &b, &ka, &kb, 6040, true).await);
        same_supported(&a, &b);
        assert_eq!(b.count("captures"), 2047);
        assert_eq!(b.count("import_events"), 64);
    });
}

#[test]
fn r9_bootstrap_observer_scope_count_is_per_event_group_not_per_row() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = history_device(ka.public.peer_id(), kb.public.peer_id());
        let b = history_device(kb.public.peer_id(), ka.public.peer_id());
        f::capture_batches(&a.store, 32, 32);
        let before = f::observer_scopes();
        clean_status(history_exchange(&a, &b, &ka, &kb, 9040, true).await);
        assert_eq!(b.count("captures"), 32);
        assert_eq!(
            f::observer_scopes() - before,
            1,
            "one guarded INSERT observer per event/entity, with individual exact-row grants"
        );
    });
}

#[test]
fn r6_bootstrap_source_event_row_and_byte_limits_refuse_without_publication() {
    let ka = Fixture::new().unwrap();
    let kb = Fixture::new().unwrap();
    for limit in 0..3 {
        let a = history_device(ka.public.peer_id(), kb.public.peer_id());
        let b = history_device(kb.public.peer_id(), ka.public.peer_id());
        match limit {
            0 => f::captures(&a.store, &vec!["event cap"; 65]),
            1 => f::capture_batches(&a.store, 2048, 64),
            _ => f::captures(
                &a.store,
                &vec![
                    "🚀"
                        .repeat(crate::storage::capture_store::MAX_CAPTURE_CONTENT_CHARS)
                        .as_str();
                    18
                ],
            ),
        }
        let before = f::state(&b.store);
        let allowed = origins(&a, &b);
        let source = CandidateSyncStore::synthetic(&a.store);
        assert_eq!(
            source
                .snapshot_capture(
                    &context(&a, &allowed),
                    Uuid::new_v4(),
                    &Clock::default(),
                    &Cancellation::default()
                )
                .err(),
            Some(Error::SnapshotTooLarge)
        );
        assert_eq!(a.count("bootstrap_units"), 0);
        assert_eq!(f::state(&b.store), before);
    }
}

#[test]
fn r6_tls_missing_chunk_and_wrong_offer_never_publish_or_acknowledge() {
    execute(async {
        for wrong_offer in [false, true] {
            let ka = Fixture::new().unwrap();
            let kb = Fixture::new().unwrap();
            let a = history_device(ka.public.peer_id(), kb.public.peer_id());
            let b = history_device(kb.public.peer_id(), ka.public.peer_id());
            f::history(&a.store);
            let allowed = origins(&a, &b);
            let session = Uuid::from_u128(6050);
            let clock = Clock::default();
            let cancel = Cancellation::default();
            let snapshot = CandidateSyncStore::synthetic(&a.store)
                .snapshot_capture(&context(&a, &allowed), Uuid::new_v4(), &clock, &cancel)
                .unwrap();
            let (wire, mut ta, tb) = connect(&a, &b, &ka, &kb, 6050).await;
            let target = CandidateSyncStore::synthetic(&b.store);
            let mut eb =
                SyncEngine::start(&target, tb, &b.trust(session, &allowed), &clock, &cancel)
                    .unwrap();
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
                Payload::SnapshotOffer(snapshot.offer.clone()),
            ))
            .unwrap();
            wire.transfer().await.unwrap();
            eb.tick().unwrap();
            let mut offer = snapshot.offer.clone();
            if wrong_offer {
                offer.hash[0] ^= 1;
            }
            ta.send(message(&a.hello(session), Payload::SnapshotPublish(offer)))
                .unwrap();
            wire.transfer().await.unwrap();
            assert_eq!(
                eb.tick(),
                Err(if wrong_offer {
                    Error::Integrity
                } else {
                    Error::Protocol
                })
            );
            assert_eq!(eb.status, SyncStatus::RejectedIntegrity);
            assert!(eb.needs_attention);
            wire.transfer().await.unwrap();
            while let Some(m) = ta.receive().unwrap() {
                assert!(!matches!(m.payload, Payload::SnapshotReceipt(_)));
            }
            assert_eq!(b.count("captures"), 0);
            assert_eq!(b.count("import_events"), 0);
            f::clean(&b.store);
        }
    });
}

#[test]
fn r6_tls_committed_budget_restore_failure_sends_no_ack_then_reopens_and_converges() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = history_device(ka.public.peer_id(), kb.public.peer_id());
        let b = history_device(kb.public.peer_id(), ka.public.peer_id());
        f::history(&a.store);
        let events = test_events(&a.store);
        let allowed = origins(&a, &b);
        let session = Uuid::from_u128(6020);
        let clock = Clock::default();
        let cancel = Cancellation::default();
        {
            let (wire, mut ta, tb) = connect(&a, &b, &ka, &kb, 6020).await;
            let source = CandidateSyncStore::synthetic(&a.store);
            let target = f::physically_admitted(&b.store);
            let at = a.trust(session, &allowed);
            let av = at.verify(&a.hello(session)).unwrap();
            let bt = b.trust(session, &allowed);
            let bv = bt.verify(&b.hello(session)).unwrap();
            let mut eb = SyncEngine::start(&target, tb, &bt, &clock, &cancel).unwrap();
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
            source
                .offered(&av, &events[0].identity, &clock, &cancel)
                .unwrap();
            for chunk in chunk_event(&events[0]) {
                ta.send(message(&a.hello(session), Payload::Chunk(chunk)))
                    .unwrap();
            }
            wire.transfer().await.unwrap();
            eb.tick().unwrap();
            wire.transfer().await.unwrap();
            while let Some(m) = ta.receive().unwrap() {
                if let Payload::Receipt(r) = m.payload {
                    source.receipt(&av, &r, &clock, &cancel).unwrap();
                }
            }
            assert_eq!(
                a.store
                    .query_i64_for_test("SELECT max(applied) FROM import_delivery"),
                1
            );
            source
                .offered(&av, &events[1].identity, &clock, &cancel)
                .unwrap();
            let guard = f::deny_post_commit_budget_restore(&b.store);
            for chunk in chunk_event(&events[1]) {
                ta.send(message(&a.hello(session), Payload::Chunk(chunk)))
                    .unwrap();
            }
            wire.transfer().await.unwrap();
            assert_eq!(eb.tick(), Err(Error::CommittedCleanupFailed));
            assert_eq!(eb.status, SyncStatus::StorageLimited);
            assert!(eb.needs_attention);
            assert_eq!(guard.hits(), 1);
            drop(guard);
            assert_eq!(b.count("knowledge_objects"), 1);
            assert_eq!(b.count("import_g3_commits"), 2);
            wire.transfer().await.unwrap();
            assert!(ta.receive().unwrap().is_none());
            assert_eq!(
                a.store
                    .query_i64_for_test("SELECT max(applied) FROM import_delivery"),
                1
            );
            assert_eq!(eb.tick(), Err(Error::CommittedCleanupFailed));
            assert!(target.reprocess(&bv, &clock, &cancel).is_err());
            f::clean(&b.store);
        }
        let a = a.reopen();
        let b = b.reopen();
        clean_status(history_exchange(&a, &b, &ka, &kb, 6021, false).await);
        same_supported(&a, &b);
        assert_eq!(b.count("thought_revisions"), 2);
        assert_eq!(
            a.store
                .query_i64_for_test("SELECT max(applied) FROM import_delivery"),
            5
        );
    });
}

#[test]
fn r6_tls_unavailable_original_dependency_quiesces_with_durable_attention() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let kc = Fixture::new().unwrap();
        let a = history_device(ka.public.peer_id(), kb.public.peer_id());
        let b = history_device(kb.public.peer_id(), kc.public.peer_id());
        let c = history_device(kc.public.peer_id(), kb.public.peer_id());
        f::history(&a.store);
        let original = test_events(&a.store)[2].clone();
        let allowed = origins(&a, &b);
        assert_eq!(
            receive(
                &CandidateSyncStore::synthetic(&b.store),
                &context(&b, &allowed),
                &original
            )
            .outcome,
            Outcome::DeferredDependency
        );
        // A is unavailable to this foreground B↔C session. B can forward the
        // retained original child, but cannot supply its missing parent.
        let result = history_exchange(&b, &c, &kb, &kc, 6030, false).await;
        assert_eq!(result, [(SyncStatus::DeferredDependency, true); 2]);
        for p in [&b, &c] {
            assert_eq!(p.count("import_events"), 1);
            assert_eq!(p.count("thought_revisions"), 0);
            assert_eq!(
                p.store
                    .query_i64_for_test("SELECT coalesce(max(applied),0) FROM import_progress"),
                0
            );
            assert!(test_events(&p.store)
                .iter()
                .any(|e| e.identity == original.identity && e.bytes == original.bytes));
            f::clean(&p.store);
        }
        b.reopen();
        c.reopen();
    });
}
