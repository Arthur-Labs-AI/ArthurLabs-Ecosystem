//! Shared Windows/Android debug scenario: existing native writers, TLS adapter,
//! engine and G3. Synthetic membership; loopback is never LAN attestation.
#[cfg(not(any(
    test,
    all(
        target_os = "android",
        feature = "android-identity-tests",
        debug_assertions
    )
)))]
compile_error!("Sync qualification is forbidden outside tests/debug instrumentation");
use super::{codec, storage::JournalKernel};
use crate::{
    storage::{
        capture_store::{CaptureStore, CreateCaptureInput},
        migrations,
        security_tls_tests::Fixture,
        sync_store::{self, CandidateSyncStore},
    },
    sync::{
        security::{
            self, native_io_lab,
            tls::CertificateRole,
            tls_socket_lab::{HandshakeFault, Pair},
            transport_candidate::{Expected, Interrupt},
        },
        trust::TestTrust,
        *,
    },
};
use std::{collections::BTreeSet, sync::Arc};
use uuid::Uuid;
const NETWORK: Uuid = Uuid::from_u128(7002);
struct Clock;
impl SyncClock for Clock {
    fn now(&self) -> u64 {
        0
    }
}
fn hello(a: &Fixture, b: &Fixture, session: Uuid) -> PeerHello {
    PeerHello {
        network: NETWORK,
        session,
        local: a.public.peer_id(),
        peer: b.public.peer_id(),
        epoch: 1,
    }
}
fn install(a: &Fixture, b: &Fixture) {
    let owner = a.owner();
    let mut c = owner.store().connection.lock().unwrap();
    let mut steps = migrations::STEPS.to_vec();
    steps.push((10, include_str!("../m05_v10.sql")));
    migrations::migrate_with(&mut c, &steps).unwrap();
    drop(c);
    sync_store::install_candidate(
        owner.store(),
        NETWORK,
        a.public.peer_id(),
        &[(b.public.peer_id(), 1)],
    )
    .unwrap();
    super::g3::install(owner.store()).unwrap();
}
fn trust(a: &Fixture, b: &Fixture, session: Uuid, origins: &BTreeSet<Uuid>) -> TestTrust {
    sync_store::grant_test_origins(a.owner().store(), b.public.peer_id(), origins);
    TestTrust {
        hello: hello(a, b, session),
        expires: 100,
        origins: origins.clone(),
    }
}
fn count(s: &CaptureStore, table: &str) -> i64 {
    s.connection
        .lock()
        .unwrap()
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn same(a: &Fixture, b: &Fixture) {
    let a = a.owner();
    let b = b.owner();
    let ae = sync_store::test_events(a.store());
    let be = sync_store::test_events(b.store());
    assert_eq!(ae.len(), be.len());
    for e in ae {
        let other = be.iter().find(|x| x.identity == e.identity).unwrap();
        assert_eq!(e.bytes, other.bytes);
        for op in &ValidatedEvent::parse(e).unwrap().core().operations {
            assert!(matches!(op, codec::Operation::RecordCreate(_)));
            assert!(matches!(
                op.entity(),
                codec::EntityKind::Projects | codec::EntityKind::Captures
            ));
            assert_eq!(
                super::sql_effects::reread(
                    &a.store().connection.lock().unwrap(),
                    op.entity(),
                    op.key()
                )
                .unwrap(),
                super::sql_effects::reread(
                    &b.store().connection.lock().unwrap(),
                    op.entity(),
                    op.key()
                )
                .unwrap()
            );
        }
    }
    for owner in [&a, &b] {
        let c = owner.store().connection.lock().unwrap();
        assert_eq!(
            c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert!(!c
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .exists([])
            .unwrap());
        assert_eq!(
            count_unlocked(&c, "SELECT count(*) FROM sync_write_context"),
            0
        );
        assert_eq!(
            count_unlocked(
                &c,
                "SELECT count(*) FROM import_events WHERE outcome!='applied'"
            ),
            0
        );
    }
}
fn count_unlocked(c: &rusqlite::Connection, sql: &str) -> i64 {
    c.query_row(sql, [], |r| r.get(0)).unwrap()
}
async fn exchange(a: &Fixture, b: &Fixture, mode: u8) {
    let session = Uuid::new_v4();
    let oa = a.owner();
    let ob = b.owner();
    let allowed = sync_store::test_events(oa.store())
        .into_iter()
        .chain(sync_store::test_events(ob.store()))
        .map(|e| e.identity.origin)
        .collect();
    let at = trust(a, b, session, &allowed);
    let bt = trust(b, a, session, &allowed);
    let av = at.verify(&at.hello).unwrap();
    let bv = bt.verify(&bt.hello).unwrap();
    let sa = CandidateSyncStore::synthetic(oa.store());
    let sb = CandidateSyncStore::synthetic(ob.store());
    let cancel = Cancellation::default();
    let (wire, mut ta, tb) = Pair::connect_checked(
        a.key(CertificateRole::Server).unwrap(),
        b.key(CertificateRole::Client).unwrap(),
        [at.hello.clone(), bt.hello.clone()],
        [&a.public, &b.public],
        None,
        || {
            sa.summary(&av, &Clock, &cancel)?;
            sb.summary(&bv, &Clock, &cancel)?;
            Ok(())
        },
    )
    .await
    .unwrap();
    ta.lose_receipts = mode == 1;
    let mut ea = SyncEngine::start(&sa, ta, &at, &Clock, &cancel).unwrap();
    let mut eb = SyncEngine::start(&sb, tb, &bt, &Clock, &cancel).unwrap();
    for _ in 0..512 {
        wire.transfer().await.unwrap();
        let aa = ea.tick().unwrap();
        let br = eb.tick();
        if mode == 2 && br == Err(Error::Storage) {
            assert!(!sa.outstanding(&av, &Clock, &cancel).unwrap().is_empty());
            wire.abort(Error::Storage);
            wire.assert_closed();
            return;
        }
        let bb = br.unwrap();
        if mode == 1 && count(ob.store(), "captures") == 2 {
            wire.transfer().await.unwrap();
            ea.tick().unwrap();
            assert!(!sa.outstanding(&av, &Clock, &cancel).unwrap().is_empty());
            wire.abort(Error::Disconnected);
            assert_eq!(ea.tick(), Err(Error::Disconnected));
            assert_eq!(eb.tick(), Err(Error::Disconnected));
            wire.assert_closed();
            return;
        }
        if !aa && !bb {
            assert_ne!(mode, 2, "SQLite ceiling must reject the import");
            assert!(!ea.needs_attention && !eb.needs_attention);
            assert_eq!(
                (ea.status, eb.status),
                (SyncStatus::CleanlyApplied, SyncStatus::CleanlyApplied)
            );
            assert!(sa.outstanding(&av, &Clock, &cancel).unwrap().is_empty());
            assert!(sb.outstanding(&bv, &Clock, &cancel).unwrap().is_empty());
            assert!(wire.wire_bytes() > 0);
            wire.abort(Error::Disconnected);
            wire.assert_closed();
            return;
        }
    }
    panic!("bounded encrypted exchange did not quiesce");
}
fn workflow() {
    native_io_lab::execute(async {
        let mut a = Fixture::new().unwrap();
        let mut b = Fixture::new().unwrap();
        install(&a, &b);
        install(&b, &a);
        let oa = a.owner();
        let k = JournalKernel::activate(oa.store()).unwrap();
        let p = k
            .write(|w| w.create_project("R2 native encrypted project"))
            .unwrap();
        let body = "🚀".repeat(crate::storage::capture_store::MAX_CAPTURE_CONTENT_CHARS);
        k.write(|w| {
            w.create_capture(CreateCaptureInput {
                source: "text".into(),
                content: body,
                project_id: Some(p.id.clone()),
            })
        })
        .unwrap();
        exchange(&a, &b, 0).await;
        same(&a, &b);
        exchange(&a, &b, 0).await;
        same(&a, &b); // replay: same exact originals/proofs
        k.write(|w| {
            w.create_capture(CreateCaptureInput {
                source: "text".into(),
                content: "durable lost ACK А́ 原文".into(),
                project_id: Some(p.id),
            })
        })
        .unwrap();
        drop(k);
        drop(oa);
        exchange(&a, &b, 1).await;
        // Both actual Runtime/store/OS ownership handles close before disk reopen.
        a.reopen_candidate().unwrap();
        b.reopen_candidate().unwrap();
        same(&a, &b);
        exchange(&a, &b, 0).await;
        same(&a, &b);
        for f in [&a, &b] {
            let o = f.owner();
            assert_eq!(count(o.store(), "captures"), 2);
            assert_eq!(count(o.store(), "projects"), 2); // inbox + original project
            assert_eq!(
                count(o.store(), "import_events"),
                count(o.store(), "import_g3_commits")
            );
        }
    });
}
fn sqlite_failure() {
    native_io_lab::execute(async {
        let mut a = Fixture::new().unwrap();
        let mut b = Fixture::new().unwrap();
        install(&a, &b);
        install(&b, &a);
        let oa = a.owner();
        let ob = b.owner();
        let k = JournalKernel::activate(oa.store()).unwrap();
        let p = k.write(|w| w.create_project("bounded retry")).unwrap();
        exchange(&a, &b, 0).await;
        k.write(|w| {
            w.create_capture(CreateCaptureInput {
                source: "text".into(),
                content: "🚀".repeat(20_000),
                project_id: Some(p.id),
            })
        })
        .unwrap();
        let before = (
            count(ob.store(), "captures"),
            count(ob.store(), "import_events"),
            count(ob.store(), "import_g3_commits"),
            count_unlocked(
                &ob.store().connection.lock().unwrap(),
                "SELECT coalesce(max(applied),0) FROM import_progress",
            ),
        );
        {
            let c = ob.store().connection.lock().unwrap();
            let pages: i64 = c.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
            c.execute_batch(&format!("PRAGMA max_page_count={pages}"))
                .unwrap();
        }
        exchange(&a, &b, 2).await;
        assert_eq!(
            (
                count(ob.store(), "captures"),
                count(ob.store(), "import_events"),
                count(ob.store(), "import_g3_commits"),
                count_unlocked(
                    &ob.store().connection.lock().unwrap(),
                    "SELECT coalesce(max(applied),0) FROM import_progress"
                )
            ),
            before
        );
        ob.store()
            .connection
            .lock()
            .unwrap()
            .execute_batch("PRAGMA max_page_count=1073741823")
            .unwrap();
        drop(k);
        drop(oa);
        drop(ob);
        a.reopen_candidate().unwrap();
        b.reopen_candidate().unwrap();
        exchange(&a, &b, 0).await;
        same(&a, &b);
        exchange(&a, &b, 0).await;
        same(&a, &b);
        assert_eq!(count(b.owner().store(), "captures"), 1);
    });
}
fn binding_failures() {
    native_io_lab::execute(async {
        for mode in 0..6 {
            let a = Fixture::new().unwrap();
            let b = Fixture::new().unwrap();
            let wrong = Fixture::new().unwrap();
            install(&a, &b);
            install(&b, &a);
            let session = Uuid::new_v4();
            let ah = hello(&a, &b, session);
            let mut bh = hello(&b, &a, session);
            match mode {
                0 => bh.network = Uuid::new_v4(),
                1 => bh.session = Uuid::new_v4(),
                2 => bh.epoch = 2,
                3 => bh.peer = wrong.public.peer_id(),
                _ => {}
            }
            let oa = a.owner();
            let ob = b.owner();
            if mode == 4 {
                ob.store()
                    .connection
                    .lock()
                    .unwrap()
                    .execute("UPDATE import_members SET enabled=0", [])
                    .unwrap();
            }
            let at = trust(&a, &b, session, &BTreeSet::new());
            let bt = trust(&b, &a, session, &BTreeSet::new());
            let result = Pair::connect_checked(
                a.key(CertificateRole::Server).unwrap(),
                b.key(CertificateRole::Client).unwrap(),
                [ah, bh],
                [if mode == 3 { &wrong.public } else { &a.public }, &b.public],
                if mode == 5 {
                    Some(HandshakeFault::ExporterMismatch)
                } else {
                    None
                },
                || {
                    CandidateSyncStore::synthetic(oa.store()).summary(
                        &at.verify(&at.hello)?,
                        &Clock,
                        &Cancellation::default(),
                    )?;
                    CandidateSyncStore::synthetic(ob.store()).summary(
                        &bt.verify(&bt.hello)?,
                        &Clock,
                        &Cancellation::default(),
                    )?;
                    Ok(())
                },
            )
            .await;
            assert!(matches!(result, Err(Error::Trust)));
            assert_eq!(oa.transport_candidate().loopback_lab_active(), 0);
            assert_eq!(ob.transport_candidate().loopback_lab_active(), 0);
            assert_eq!(count(oa.store(), "import_events"), 0);
            assert_eq!(count(ob.store(), "import_events"), 0);
            assert_eq!(count(ob.store(), "import_g3_commits"), 0);
        }
    });
}
fn lifecycle() {
    native_io_lab::execute(async {
        for fault in [
            HandshakeFault::Interrupted,
            HandshakeFault::AfterTlsCancelled,
        ] {
            let a = Fixture::new().unwrap();
            let b = Fixture::new().unwrap();
            let s = Uuid::new_v4();
            assert!(matches!(
                Pair::connect_fault(
                    a.key(CertificateRole::Server).unwrap(),
                    b.key(CertificateRole::Client).unwrap(),
                    [hello(&a, &b, s), hello(&b, &a, s)],
                    [&a.public, &b.public],
                    Some(fault)
                )
                .await,
                Err(Error::Cancelled)
            ));
        }
        for mode in 0..3 {
            let a = Fixture::new().unwrap();
            let b = Fixture::new().unwrap();
            let s = Uuid::new_v4();
            if mode == 1 {
                install(&a, &b);
                install(&b, &a);
            }
            let event = a
                .owner()
                .transport_candidate()
                .loopback_event_fixture()
                .unwrap();
            let (wire, mut ta, _) = Pair::connect(
                a.key(CertificateRole::Server).unwrap(),
                b.key(CertificateRole::Client).unwrap(),
                [hello(&a, &b, s), hello(&b, &a, s)],
                [&a.public, &b.public],
            )
            .await
            .unwrap();
            ta.send(Message {
                network: NETWORK,
                session: s,
                from: a.public.peer_id(),
                to: b.public.peer_id(),
                payload: Payload::Hello {
                    version: 1,
                    required: FEATURES,
                    supported: FEATURES,
                    profile: "qualification".into(),
                },
            })
            .unwrap();
            let owner = a.owner();
            let (result, ()) = native_io_lab::both(wire.wait_for_failure(), async {
                tokio::task::yield_now().await;
                if mode == 0 {
                    event.notify(security::network_watch::ROUTE);
                    owner
                        .transport_candidate()
                        .invalidate_loopback_lab()
                        .unwrap();
                } else if mode == 1 {
                    // Durable revocation and owner invalidation stop pending IO.
                    // No production registry-to-owner notification is claimed.
                    owner
                        .store()
                        .connection
                        .lock()
                        .unwrap()
                        .execute("UPDATE import_members SET enabled=0", [])
                        .unwrap();
                    owner
                        .transport_candidate()
                        .invalidate_loopback_lab()
                        .unwrap();
                } else {
                    owner.transport_candidate().shutdown().unwrap();
                }
            })
            .await;
            assert_eq!(result, Err(Error::Cancelled));
            wire.assert_closed();
        }
        // Duplicate, two pending handshakes, four attempts/30s: shared owner,
        // dropped permits do not refund attempts and closed owners cannot admit.
        let a = Fixture::new().unwrap();
        let owner = a.owner();
        let c = owner.transport_candidate();
        let expected = Expected {
            network: NETWORK,
            peer: Uuid::new_v4(),
        };
        let stop = Arc::new(Interrupt::default());
        let (pool, p, _) = c.admit_loopback_lab(expected, &stop).unwrap();
        assert!(c.admit_loopback_lab(expected, &Arc::default()).is_err());
        let (_, p2, _) = c
            .admit_loopback_lab(
                Expected {
                    peer: Uuid::new_v4(),
                    ..expected
                },
                &Arc::default(),
            )
            .unwrap();
        assert!(c
            .admit_loopback_lab(
                Expected {
                    peer: Uuid::new_v4(),
                    ..expected
                },
                &Arc::default()
            )
            .is_err());
        drop(p);
        drop(p2);
        for _ in 0..2 {
            drop(c.admit_loopback_lab(expected, &Arc::default()).unwrap());
        }
        assert!(c.admit_loopback_lab(expected, &Arc::default()).is_err());
        assert_eq!(pool.active_for_test(), 0);
        stop.cancel();
        assert!(c.admit_loopback_lab(expected, &stop).is_err());
        c.shutdown().unwrap();
        assert!(c.admit_loopback_lab(expected, &Arc::default()).is_err());
    });
}
fn io_failures() {
    native_io_lab::execute(async {
        for mode in 0..9 {
            let a = Fixture::new().unwrap();
            let b = Fixture::new().unwrap();
            let s = Uuid::new_v4();
            if mode == 0 {
                assert!(matches!(
                    Pair::connect_fault(
                        a.key(CertificateRole::Server).unwrap(),
                        b.key(CertificateRole::Client).unwrap(),
                        [hello(&a, &b, s), hello(&b, &a, s)],
                        [&a.public, &b.public],
                        Some(HandshakeFault::Stalled)
                    )
                    .await,
                    Err(Error::Trust)
                ));
                continue;
            }
            let (wire, mut ta, _) = Pair::connect(
                a.key(CertificateRole::Server).unwrap(),
                b.key(CertificateRole::Client).unwrap(),
                [hello(&a, &b, s), hello(&b, &a, s)],
                [&a.public, &b.public],
            )
            .await
            .unwrap();
            match mode {
                1 | 2 => {
                    wire.expire_fixture(mode == 2);
                    assert_eq!(wire.wait_for_failure().await, Err(Error::Trust));
                }
                3..=5 => {
                    assert_eq!(
                        wire.peer_eof_fixture(mode == 5, mode == 4).await,
                        Error::Disconnected
                    );
                }
                _ => {
                    let message = Message {
                        network: NETWORK,
                        session: s,
                        from: a.public.peer_id(),
                        to: b.public.peer_id(),
                        payload: Payload::Hello {
                            version: 1,
                            required: FEATURES,
                            supported: FEATURES,
                            profile: if mode == 6 {
                                "x".repeat(65536)
                            } else {
                                "qualification".into()
                            },
                        },
                    };
                    if mode == 6 {
                        assert_eq!(ta.send(message), Err(Error::Limit));
                        wire.abort(Error::Limit);
                    } else if mode == 7 {
                        wire.corrupt_next_ciphertext(0);
                        ta.send(message).unwrap();
                        assert_eq!(wire.transfer().await, Err(Error::Integrity));
                    } else {
                        ta.send(message).unwrap();
                        a.owner().transport_candidate().shutdown().unwrap();
                        assert_eq!(wire.transfer().await, Err(Error::Cancelled));
                    }
                }
            }
            wire.assert_closed();
        }
    });
}
pub(crate) fn run(case: i32) -> security::Result<()> {
    std::panic::catch_unwind(|| match case {
        37 => workflow(),
        38 => binding_failures(),
        39 => lifecycle(),
        40 => io_failures(),
        41 => sqlite_failure(),
        _ => panic!("unknown qualification case"),
    })
    .map_err(|_| security::SecurityError::State)
}
#[cfg(test)]
#[test]
fn r2_native_keystore_cng_shared_owner_sync_workflow() {
    run(37).unwrap();
}
#[cfg(test)]
#[test]
fn r2_binding_membership_before_transport_publication() {
    run(38).unwrap();
}
#[cfg(test)]
#[test]
fn r2_shared_owner_cancellation_and_attempt_budget() {
    run(39).unwrap();
}
#[cfg(test)]
#[test]
fn r2_actual_tls_io_faults_bounds_and_cleanup() {
    run(40).unwrap();
}

#[cfg(test)]
#[test]
fn r2_android_windows_sqlite_full_no_ack_reopen_retry() {
    run(41).unwrap();
}
