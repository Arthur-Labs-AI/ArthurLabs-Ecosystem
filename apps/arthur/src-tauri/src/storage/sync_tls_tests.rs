//! Real CNG signatures, real TLS13 sockets, real engine/importer, synthetic membership.
use super::mvp1::{device, no_provider_work, same_supported, scope};
use super::*;
use crate::{
    storage::security_tls_tests::Fixture,
    sync::security::{native_io_lab::execute, tls::CertificateRole, tls_socket_lab::Pair},
};
#[path = "sync_history_tls_tests.rs"]
mod history;

async fn connect(
    a: &Peer,
    b: &Peer,
    ka: &Fixture,
    kb: &Fixture,
    session: u128,
) -> (
    Pair,
    crate::sync::security::tls_socket_lab::TlsTransport,
    crate::sync::security::tls_socket_lab::TlsTransport,
) {
    Pair::connect(
        ka.key(CertificateRole::Server).unwrap(),
        kb.key(CertificateRole::Client).unwrap(),
        [
            a.hello(Uuid::from_u128(session)),
            b.hello(Uuid::from_u128(session)),
        ],
        [&ka.public, &kb.public],
    )
    .await
    .unwrap()
}
async fn exchange(a: &Peer, b: &Peer, ka: &Fixture, kb: &Fixture, session: u128, interrupt: bool) {
    scope(a).unwrap();
    scope(b).unwrap();
    let session_id = Uuid::from_u128(session);
    let allowed = origins(a, b);
    let sa = CandidateSyncStore::synthetic(&a.store);
    let sb = CandidateSyncStore::synthetic(&b.store);
    let (wire, mut ta, tb) = connect(a, b, ka, kb, session).await;
    ta.lose_receipts = interrupt;
    let clock = Clock::default();
    let cancel = Cancellation::default();
    let mut ea =
        SyncEngine::start(&sa, ta, &a.trust(session_id, &allowed), &clock, &cancel).unwrap();
    let mut eb =
        SyncEngine::start(&sb, tb, &b.trust(session_id, &allowed), &clock, &cancel).unwrap();
    for _ in 0..512 {
        wire.transfer().await.unwrap();
        let aa = ea.tick().unwrap();
        let bb = eb.tick().unwrap();
        if interrupt && b.count("captures") == 3 {
            // Deliver the receipt through TLS, then deliberately discard it at A.
            wire.transfer().await.unwrap();
            ea.tick().unwrap();
            assert!(!sa
                .outstanding(&context(a, &allowed), &clock, &cancel)
                .unwrap()
                .is_empty());
            wire.abort(Error::Disconnected);
            assert_eq!(ea.tick(), Err(Error::Disconnected));
            assert_eq!(eb.tick(), Err(Error::Disconnected));
            return;
        }
        if !aa && !bb {
            assert!(!ea.needs_attention && !eb.needs_attention);
            assert_eq!(
                (ea.status, eb.status),
                (SyncStatus::CleanlyApplied, SyncStatus::CleanlyApplied)
            );
            assert!(wire.wire_bytes() > 0);
            for (store, peer) in [(&sa, a), (&sb, b)] {
                assert!(store
                    .outstanding(&context(peer, &allowed), &clock, &cancel)
                    .unwrap()
                    .is_empty());
            }
            return;
        }
    }
    panic!("TLS engine exchange exceeded bounded turns");
}

#[test]
fn r1_tls_socket_project_capture_round_trip_replay_and_both_owners_restart() {
    let mut completed = None;
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = device(ka.public.peer_id(), kb.public.peer_id());
        let b = device(kb.public.peer_id(), ka.public.peer_id());
        let (project, _) =
            f::project_and_capture(&a.store, "encrypted project", "А́ 😀\u{200d}🚀\n原文\tß");
        exchange(&a, &b, &ka, &kb, 2001, false).await;
        f::capture_in(&b.store, &project, "B → A through TLS");
        exchange(&a, &b, &ka, &kb, 2002, false).await;
        same_supported(&a, &b);
        let before = (
            f::domain_state(&a.store),
            f::domain_state(&b.store),
            test_events(&a.store).len(),
            test_events(&b.store).len(),
        );
        exchange(&a, &b, &ka, &kb, 2003, false).await;
        assert_eq!(
            (
                f::domain_state(&a.store),
                f::domain_state(&b.store),
                test_events(&a.store).len(),
                test_events(&b.store).len()
            ),
            before
        );
        f::capture_in(
            &a.store,
            &project,
            "durable before lost encrypted acknowledgement",
        );
        exchange(&a, &b, &ka, &kb, 2004, true).await;
        let a = a.reopen();
        let b = b.reopen();
        same_supported(&a, &b);
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        exchange(&a, &b, &ka, &kb, 2005, false).await;
        same_supported(&a, &b);
        assert_eq!((a.count("captures"), b.count("captures")), (3, 3));
        assert_eq!(
            (
                a.count("sync_bundles"),
                a.count("import_events"),
                b.count("sync_bundles"),
                b.count("import_events")
            ),
            (3, 1, 1, 3)
        );
        completed = Some((a, b));
        println!("R1: real CNG mutual TLS13 + exporter/context binding + OS loopback + engine/G3 + both SQLite owners reopened/resumed PASS; qualification membership only");
    });
    let (a, b) = completed.unwrap();
    no_provider_work(&a);
    no_provider_work(&b);
}

#[test]
fn r1_tls_context_mismatch_and_wrong_pin_refuse_before_database_disclosure() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let wrong = Fixture::new().unwrap();
        let a = device(ka.public.peer_id(), kb.public.peer_id());
        let b = device(kb.public.peer_id(), ka.public.peer_id());
        f::project_and_capture(&a.store, "private", "must not disclose");
        let before = (f::state(&a.store), f::state(&b.store));
        for fault in 0..3 {
            let ah = a.hello(SESSION);
            let mut bh = b.hello(SESSION);
            if fault == 0 {
                bh.network = Uuid::new_v4();
            }
            if fault == 1 {
                bh.session = Uuid::new_v4();
            }
            if fault == 2 {
                bh.peer = wrong.public.peer_id();
            }
            let server_pin = if fault == 2 {
                &wrong.public
            } else {
                &ka.public
            };
            let result = Pair::connect(
                ka.key(CertificateRole::Server).unwrap(),
                kb.key(CertificateRole::Client).unwrap(),
                [ah, bh],
                [server_pin, &kb.public],
            )
            .await;
            assert!(matches!(result, Err(Error::Trust)));
            assert_eq!((f::state(&a.store), f::state(&b.store)), before);
        }
    });
}

#[test]
fn r1_tls_ciphertext_corruption_and_plain_event_corruption_never_publish() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = device(ka.public.peer_id(), kb.public.peer_id());
        f::project_and_capture(&a.store, "source", "secret synthetic capture");
        for cipher in [true, false] {
            let b = device(kb.public.peer_id(), ka.public.peer_id());
            let allowed = origins(&a, &b);
            let session = Uuid::from_u128(2010);
            let (wire, mut ta, tb) = connect(&a, &b, &ka, &kb, 2010).await;
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
            let before = f::state(&b.store);
            let mut original = test_events(&a.store)[0].clone();
            if !cipher {
                original.bytes[0] ^= 1;
            }
            if cipher {
                wire.corrupt_next_ciphertext(0);
            }
            for chunk in chunk_event(&original) {
                ta.send(message(&a.hello(session), Payload::Chunk(chunk)))
                    .unwrap();
            }
            if cipher {
                assert_eq!(wire.transfer().await, Err(Error::Integrity));
                wire.assert_closed();
                assert_eq!(eb.tick(), Err(Error::Integrity));
            } else {
                wire.transfer().await.unwrap();
                assert_eq!(eb.tick(), Err(Error::Integrity));
            }
            assert_eq!(f::state(&b.store), before);
            assert_eq!(b.count("import_g3_commits"), 0);
        }
    });
}

#[test]
fn r1_tls_revoked_membership_refuses_engine_before_hello_or_summary() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = device(ka.public.peer_id(), kb.public.peer_id());
        let b = device(kb.public.peer_id(), ka.public.peer_id());
        f::project_and_capture(&a.store, "private", "no membership no data");
        let (wire, ta, _tb) = connect(&a, &b, &ka, &kb, 2011).await;
        let allowed = origins(&a, &b);
        let trust = a.trust(Uuid::from_u128(2011), &allowed);
        a.store
            .execute_sql_for_test("UPDATE import_members SET enabled=0");
        let before = f::state(&a.store);
        let bytes = wire.wire_bytes();
        let store = CandidateSyncStore::synthetic(&a.store);
        let clock = Clock::default();
        let cancel = Cancellation::default();
        assert!(matches!(
            SyncEngine::start(&store, ta, &trust, &clock, &cancel),
            Err(Error::Trust)
        ));
        wire.transfer().await.unwrap();
        assert_eq!(wire.wire_bytes(), bytes);
        assert_eq!(f::state(&a.store), before);
        assert_eq!(b.count("import_events"), 0);
    });
}

#[test]
fn r1_tls_real_handshake_faults_and_socket_timer_cleanup() {
    use crate::sync::security::tls_socket_lab::HandshakeFault;
    execute(async {
        for injection in [
            HandshakeFault::Invalid,
            HandshakeFault::Interrupted,
            HandshakeFault::Stalled,
        ] {
            let ka = Fixture::new().unwrap();
            let kb = Fixture::new().unwrap();
            let a = device(ka.public.peer_id(), kb.public.peer_id());
            let b = device(kb.public.peer_id(), ka.public.peer_id());
            let result = Pair::connect_fault(
                ka.key(CertificateRole::Server).unwrap(),
                kb.key(CertificateRole::Client).unwrap(),
                [a.hello(SESSION), b.hello(SESSION)],
                [&ka.public, &kb.public],
                Some(injection),
            )
            .await;
            match injection {
                HandshakeFault::Interrupted => assert!(matches!(result, Err(Error::Cancelled))),
                _ => assert!(matches!(result, Err(Error::Trust | Error::Disconnected))),
            }
        }
        for mode in 0..6 {
            let ka = Fixture::new().unwrap();
            let kb = Fixture::new().unwrap();
            let a = device(ka.public.peer_id(), kb.public.peer_id());
            let b = device(kb.public.peer_id(), ka.public.peer_id());
            let (wire, _ta, _tb) = connect(&a, &b, &ka, &kb, 2020 + mode).await;
            match mode {
                0 => {
                    // First poll registers a pending TLS read. Cancellation
                    // then wakes that same future on the existing reactor.
                    let (result, ()) = crate::sync::security::native_io_lab::both(
                        wire.wait_for_failure(),
                        async {
                            tokio::task::yield_now().await;
                            wire.pools[0].shutdown().unwrap();
                        },
                    )
                    .await;
                    assert_eq!(result, Err(Error::Cancelled));
                }
                1 | 2 => {
                    wire.expire_fixture(mode == 2);
                    assert_eq!(wire.wait_for_failure().await, Err(Error::Trust));
                }
                _ => {
                    assert_eq!(
                        wire.peer_eof_fixture(mode == 5, mode == 4).await,
                        Error::Disconnected
                    );
                }
            }
            wire.assert_closed();
        }
    });
}

#[test]
fn r1_tls_record_limit_refuses_without_domain_or_cursor_change() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = device(ka.public.peer_id(), kb.public.peer_id());
        let b = device(kb.public.peer_id(), ka.public.peer_id());
        let (wire, mut ta, _tb) = connect(&a, &b, &ka, &kb, 2030).await;
        let before = f::state(&b.store);
        let oversized = message(
            &a.hello(Uuid::from_u128(2030)),
            Payload::Hello {
                version: 1,
                required: FEATURES,
                supported: FEATURES,
                profile: "x".repeat(65536),
            },
        );
        assert_eq!(ta.send(oversized), Err(Error::Limit));
        assert_eq!(wire.transfer().await, Err(Error::Limit));
        wire.assert_closed();
        assert_eq!(f::state(&b.store), before);
    });
}

#[test]
fn r1_tls_sqlite_full_rolls_back_import_then_both_owners_reopen_and_retry() {
    let mut completed = None;
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = device(ka.public.peer_id(), kb.public.peer_id());
        let b = device(kb.public.peer_id(), ka.public.peer_id());
        let project = f::project_only(&a.store, "disk full");
        exchange(&a, &b, &ka, &kb, 2040, false).await;
        f::capture_in(&a.store, &project, &"x".repeat(6000));
        let allowed = origins(&a, &b);
        let session = Uuid::from_u128(2041);
        let at = a.trust(session, &allowed);
        let bt = b.trust(session, &allowed);
        let pages = b.store.query_i64_for_test("PRAGMA page_count");
        b.store
            .execute_sql_for_test(&format!("PRAGMA max_page_count={pages}"));
        let before = f::state(&b.store);
        {
            let sa = CandidateSyncStore::synthetic(&a.store);
            let sb = CandidateSyncStore::synthetic(&b.store);
            let (wire, ta, tb) = connect(&a, &b, &ka, &kb, 2041).await;
            let clock = Clock::default();
            let cancel = Cancellation::default();
            let mut ea = SyncEngine::start(&sa, ta, &at, &clock, &cancel).unwrap();
            let mut eb = SyncEngine::start(&sb, tb, &bt, &clock, &cancel).unwrap();
            let mut full = false;
            for _ in 0..512 {
                wire.transfer().await.unwrap();
                ea.tick().unwrap();
                match eb.tick() {
                    Err(Error::Storage) => {
                        full = true;
                        break;
                    }
                    Ok(_) => {}
                    other => panic!("unexpected disk-full outcome: {other:?}"),
                }
            }
            assert!(full, "actual SQLite page ceiling must reject the import");
            assert_eq!(f::state(&b.store), before);
            assert_eq!(b.count("captures"), 0);
            assert_eq!(b.count("import_g3_commits"), 1);
        }
        b.store
            .execute_sql_for_test("PRAGMA max_page_count=1073741823");
        let a = a.reopen();
        let b = b.reopen();
        exchange(&a, &b, &ka, &kb, 2042, false).await;
        same_supported(&a, &b);
        assert_eq!(b.count("captures"), 1);
        completed = Some((a, b));
    });
    let (a, b) = completed.unwrap();
    no_provider_work(&a);
    no_provider_work(&b);
}

#[test]
fn r1_tls_original_event_replay_and_contradiction_preserve_committed_rows() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = device(ka.public.peer_id(), kb.public.peer_id());
        let b = device(kb.public.peer_id(), ka.public.peer_id());
        f::project_and_capture(&a.store, "original project", "original capture");
        exchange(&a, &b, &ka, &kb, 2050, false).await;
        let domain = f::domain_state(&b.store);
        let allowed = origins(&a, &b);
        let session = Uuid::from_u128(2051);
        let (wire, mut ta, tb) = connect(&a, &b, &ka, &kb, 2051).await;
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
        let original = test_events(&a.store)[0].clone();
        for chunk in chunk_event(&original) {
            ta.send(message(&a.hello(session), Payload::Chunk(chunk)))
                .unwrap();
        }
        wire.transfer().await.unwrap();
        eb.tick().unwrap();
        assert_eq!(eb.status, SyncStatus::CleanlyApplied);
        assert_eq!(
            (
                b.count("import_events"),
                b.count("import_g3_commits"),
                b.count("captures")
            ),
            (2, 2, 1)
        );
        let mut core = codec::decode_core_strict(&original.bytes).unwrap();
        if let codec::Operation::RecordCreate(row) = &mut core.operations[0] {
            row.after.insert(
                "name".into(),
                codec::FieldValue::Text("contradictory project".into()),
            );
        }
        let contradictory = from_core(core);
        for chunk in chunk_event(&contradictory) {
            ta.send(message(&a.hello(session), Payload::Chunk(chunk)))
                .unwrap();
        }
        wire.transfer().await.unwrap();
        eb.tick().unwrap();
        assert_eq!(eb.status, SyncStatus::RejectedIntegrity);
        assert!(eb.needs_attention);
        assert_eq!(b.count("import_collisions"), 1);
        assert_eq!(f::domain_state(&b.store), domain);
        assert_eq!(b.count("import_g3_commits"), 2);
    });
}

#[test]
fn r1_tls_lab_has_only_test_or_explicit_android_debug_activation_path() {
    let modules = include_str!("../sync/security/mod.rs").replace("\r\n", "\n");
    assert!(modules.contains("#[cfg(any(test, all(target_os = \"android\", feature = \"android-identity-tests\")))]\npub(crate) mod tls_socket_lab;"));
    let lab = include_str!("../sync/security/tls_socket_lab.rs");
    assert!(
        lab.contains("TLS socket qualification is forbidden outside tests/debug instrumentation")
    );
    assert!(!include_str!("../../Cargo.toml").contains("tls_socket_lab"));
    for source in [
        include_str!("../lib.rs"),
        include_str!("../runtime/mod.rs"),
        include_str!("../commands/mod.rs"),
    ] {
        assert!(!source.contains("tls_socket_lab"));
    }
}

#[test]
fn r1_tls_maximum_unicode_capture_crosses_multiple_bounded_records() {
    execute(async {
        let ka = Fixture::new().unwrap();
        let kb = Fixture::new().unwrap();
        let a = device(ka.public.peer_id(), kb.public.peer_id());
        let b = device(kb.public.peer_id(), ka.public.peer_id());
        let body = "🚀".repeat(crate::storage::capture_store::MAX_CAPTURE_CONTENT_CHARS);
        let (_, capture) = f::project_and_capture(&a.store, "maximum native capture", &body);
        assert!(
            test_events(&a.store)[1].bytes.len() > crate::sync::security::transport::MAX_RECORD
        );
        exchange(&a, &b, &ka, &kb, 2060, false).await;
        same_supported(&a, &b);
        assert_eq!(
            b.store.get_capture(&capture).unwrap().unwrap().content,
            body
        );
    });
}
