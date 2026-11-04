//! R8: real Windows CNG/TLS and independently owned disposable SQLite stores.
//! This is never Android hardware or production trust evidence.
use super::{
    enrollment_store::{self, NetworkRegistry},
    journal::sync_fixtures as f,
    security_tls_tests::Fixture,
    signed_import::SignedImportStore,
    sync_store,
};
use crate::sync::SyncEngine;
use crate::sync_api::security::{
    native_io_lab,
    tls::CertificateRole,
    tls_socket_lab::{Pair, TlsTransport},
};
use crate::sync_api::{
    security::{enrollment::*, identity::*, signed::SignedOriginal, windows::WindowsIdentity},
    trust::RegistryTrust,
    *,
};
use std::collections::BTreeSet;
use uuid::Uuid;
#[path = "signed_profile_fault_tests.rs"]
mod faults;
#[path = "signed_history_tests.rs"]
mod history;

struct Clock;
impl SyncClock for Clock {
    fn now(&self) -> u64 {
        10
    }
}
struct Admin(WindowsIdentity);
impl Admin {
    fn new() -> Self {
        let key = WindowsIdentity::slot(Uuid::new_v4());
        key.create_identity().unwrap();
        Self(key)
    }
}
impl Drop for Admin {
    fn drop(&mut self) {
        self.0.invalidate_identity().unwrap();
    }
}
struct Lab {
    a: Fixture,
    b: Fixture,
    admin: Admin,
    history: Vec<SignedUpdate>,
    origins: BTreeSet<Uuid>,
}
impl Lab {
    fn add_forwarding_target(&mut self) -> Fixture {
        let target = Fixture::new().unwrap();
        let last = self.history.last().unwrap();
        let update = SignedUpdate::sign(
            Update {
                network: last.body.network,
                epoch: last.body.epoch + 1,
                previous: last.body.hash().unwrap(),
                action: Action::Grant {
                    device: target.public.clone(),
                    role: Role::Member,
                    capabilities: 3,
                    enrollment: Uuid::new_v4(),
                    expires: 1000,
                    origins: vec![],
                },
            },
            &self.admin.0,
        )
        .unwrap();
        for peer in [&self.a, &self.b] {
            let owner = peer.owner();
            NetworkRegistry::candidate(owner.store())
                .unwrap()
                .apply(&update)
                .unwrap();
            let c = owner.store().connection.lock().unwrap();
            c.execute("UPDATE import_members SET epoch=?1", [update.body.epoch])
                .unwrap();
            c.execute(
                "UPDATE import_origin_permissions SET epoch=?1",
                [update.body.epoch],
            )
            .unwrap();
            c.execute(
                "INSERT INTO import_members VALUES(?1,?2,1)",
                rusqlite::params![target.public.peer_id().to_string(), update.body.epoch],
            )
            .unwrap();
            drop(c);
            sync_store::grant_test_origins(owner.store(), target.public.peer_id(), &self.origins);
            owner
                .store()
                .connection
                .lock()
                .unwrap()
                .execute(
                    "UPDATE import_origin_permissions SET epoch=?1",
                    [update.body.epoch],
                )
                .unwrap();
        }
        self.history.push(update);
        let owner = target.owner();
        f::upgrade(owner.store());
        enrollment_store::accept_qualification_history(
            owner.store(),
            target.public.peer_id(),
            &self.history,
        )
        .unwrap();
        sync_store::install_candidate(
            owner.store(),
            self.history[0].body.network,
            target.public.peer_id(),
            &[(
                self.b.public.peer_id(),
                self.history.last().unwrap().body.epoch,
            )],
        )
        .unwrap();
        f::install_g3(owner.store());
        SignedImportStore::install_qualification(owner.store()).unwrap();
        sync_store::grant_test_origins(owner.store(), self.b.public.peer_id(), &self.origins);
        owner
            .store()
            .connection
            .lock()
            .unwrap()
            .execute(
                "UPDATE import_origin_permissions SET epoch=?1",
                [self.history.last().unwrap().body.epoch],
            )
            .unwrap();
        target
    }
    fn new() -> Self {
        Self::with_review_history(false)
    }
    fn with_review_history(review: bool) -> Self {
        Self::configured(review, None)
    }
    fn configured(
        review: bool,
        seed: Option<fn(&crate::storage::capture_store::CaptureStore)>,
    ) -> Self {
        let a = Fixture::new().unwrap();
        let b = Fixture::new().unwrap();
        let admin = Admin::new();
        let ao = a.owner();
        let bo = b.owner();
        f::upgrade(ao.store());
        f::upgrade(bo.store());
        if let Some(seed) = seed {
            seed(ao.store());
        } else if review {
            f::review_history(ao.store());
        } else {
            f::project_and_capture(
                ao.store(),
                "R8 signed project",
                "R8 committed Windows original 原文 🚀",
            );
        }
        f::captures(bo.store(), &[]);
        let origin = |f: &Fixture| {
            let o = f.owner();
            let c = o.store().connection.lock().unwrap();
            Uuid::parse_str(
                &c.query_row("SELECT origin_id FROM sync_local", [], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
            )
            .unwrap()
        };
        let origins = BTreeSet::from([origin(&a), origin(&b)]);
        let network = Uuid::new_v4();
        let mut history = vec![SignedUpdate::sign(
            Update {
                network,
                epoch: 1,
                previous: [0; 32],
                action: Action::Genesis {
                    admin: admin.0.public_identity().unwrap(),
                },
            },
            &admin.0,
        )
        .unwrap()];
        for peer in [&a, &b] {
            let last = history.last().unwrap();
            history.push(
                SignedUpdate::sign(
                    Update {
                        network,
                        epoch: last.body.epoch + 1,
                        previous: last.body.hash().unwrap(),
                        action: Action::Grant {
                            device: peer.public.clone(),
                            role: Role::Member,
                            capabilities: 3,
                            enrollment: Uuid::new_v4(),
                            expires: 1000,
                            origins: vec![origin(peer)],
                        },
                    },
                    &admin.0,
                )
                .unwrap(),
            );
        }
        for (local, remote) in [(&a, &b), (&b, &a)] {
            let owner = local.owner();
            enrollment_store::accept_qualification_history(
                owner.store(),
                local.public.peer_id(),
                &history,
            )
            .unwrap();
            sync_store::install_candidate(
                owner.store(),
                network,
                local.public.peer_id(),
                &[(remote.public.peer_id(), 3)],
            )
            .unwrap();
            f::install_g3(owner.store());
            if review {
                f::install_history(owner.store());
                f::install_d4(owner.store());
            }
            SignedImportStore::install_qualification(owner.store()).unwrap();
            sync_store::grant_test_origins(owner.store(), remote.public.peer_id(), &origins);
            owner
                .store()
                .connection
                .lock()
                .unwrap()
                .execute("UPDATE import_origin_permissions SET epoch=3", [])
                .unwrap();
        }
        Self {
            a,
            b,
            admin,
            history,
            origins,
        }
    }
    fn trust(&self, local: &Fixture, remote: &Fixture, session: Uuid) -> RegistryTrust {
        let owner = local.owner();
        let registry = NetworkRegistry::candidate(owner.store()).unwrap();
        let binding = registry
            .binding(local.public.peer_id(), &remote.public, 10)
            .unwrap();
        let hello = PeerHello {
            network: binding.root.network,
            epoch: binding.root.epoch,
            session,
            local: local.public.peer_id(),
            peer: remote.public.peer_id(),
        };
        RegistryTrust::qualification(hello, binding, 100, self.origins.clone()).unwrap()
    }
    fn session(&self, local: &Fixture, remote: &Fixture) -> VerifiedSession {
        let session = Uuid::new_v4();
        let t = self.trust(local, remote, session);
        let root = NetworkRegistry::candidate(local.owner().store())
            .unwrap()
            .root()
            .unwrap();
        let hello = PeerHello {
            network: root.network,
            epoch: root.epoch,
            session,
            local: local.public.peer_id(),
            peer: remote.public.peer_id(),
        };
        t.verify(&hello).unwrap()
    }
}
#[test]
fn r8_s01_s03_committed_source_export_has_a_stable_cng_signature() {
    let lab = Lab::new();
    let owner = lab.a.owner();
    let session = lab.session(&lab.a, &lab.b);
    let store = SignedImportStore::synthetic(owner.store());
    let mut events = sync_store::test_events(owner.store());
    events.sort_by_key(|e| e.identity.seq);
    let exported = store
        .export_signed(
            &session,
            &events[0].identity,
            &Clock,
            &Cancellation::default(),
        )
        .unwrap();
    let signed = SignedOriginal::decode(&exported.metadata.bytes).unwrap();
    signed
        .verify(session.binding().network, &events[0], &lab.a.public)
        .unwrap();
    assert_eq!(signed.bytes().unwrap(), exported.metadata.bytes);
    let retry = store
        .export_signed(
            &session,
            &events[0].identity,
            &Clock,
            &Cancellation::default(),
        )
        .unwrap();
    assert_eq!(exported.metadata.bytes, retry.metadata.bytes);
}

fn hello(local: &Fixture, remote: &Fixture, session: Uuid) -> PeerHello {
    let root = NetworkRegistry::candidate(local.owner().store())
        .unwrap()
        .root()
        .unwrap();
    PeerHello {
        network: root.network,
        epoch: root.epoch,
        session,
        local: local.public.peer_id(),
        peer: remote.public.peer_id(),
    }
}
fn message(binding: &PeerHello, payload: Payload) -> Message {
    Message {
        network: binding.network,
        session: binding.session,
        from: binding.local,
        to: binding.peer,
        payload,
    }
}
fn count(f: &Fixture, sql: &str) -> i64 {
    f.owner()
        .store()
        .connection
        .lock()
        .unwrap()
        .query_row(sql, [], |r| r.get(0))
        .unwrap()
}
fn signatures(f: &Fixture) -> Vec<(String, Vec<u8>)> {
    let owner = f.owner();
    let c = owner.store().connection.lock().unwrap();
    let table = super::signed_import::accepted_tables(&c).unwrap().1;
    let mut q=c.prepare(&format!("SELECT event,envelope FROM e2_export_signatures UNION ALL SELECT event,envelope FROM {table} ORDER BY event")).unwrap();
    q.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}
async fn connect(
    lab: &Lab,
    a: &Fixture,
    b: &Fixture,
    session: Uuid,
) -> (Pair, TlsTransport, TlsTransport) {
    let ao = a.owner();
    let bo = b.owner();
    let sa = SignedImportStore::synthetic(ao.store());
    let sb = SignedImportStore::synthetic(bo.store());
    let ah = hello(a, b, session);
    let bh = hello(b, a, session);
    let av = lab.trust(a, b, session).verify(&ah).unwrap();
    let bv = lab.trust(b, a, session).verify(&bh).unwrap();
    Pair::connect_checked(
        a.key(CertificateRole::Server).unwrap(),
        b.key(CertificateRole::Client).unwrap(),
        [ah, bh],
        [&a.public, &b.public],
        None,
        || {
            sa.authorize(&av, &Clock, &Cancellation::default())?;
            sb.authorize(&bv, &Clock, &Cancellation::default())
        },
    )
    .await
    .unwrap()
}
async fn exchange(lab: &Lab, a: &Fixture, b: &Fixture, lose: bool) {
    let ao = a.owner();
    let bo = b.owner();
    let session = Uuid::new_v4();
    let sa = SignedImportStore::synthetic(ao.store());
    let sb = SignedImportStore::synthetic(bo.store());
    let at = lab.trust(a, b, session);
    let bt = lab.trust(b, a, session);
    let av = at.verify(&hello(a, b, session)).unwrap();
    let bv = bt.verify(&hello(b, a, session)).unwrap();
    let (wire, mut ta, tb) = connect(lab, a, b, session).await;
    ta.lose_receipts = lose;
    let cancel = Cancellation::default();
    let mut ea = SyncEngine::start(&sa, ta, &at, &Clock, &cancel).unwrap();
    let mut eb = SyncEngine::start(&sb, tb, &bt, &Clock, &cancel).unwrap();
    for _ in 0..512 {
        wire.transfer().await.unwrap();
        let aa = ea.tick().unwrap();
        let bb = eb.tick().unwrap();
        if !aa && !bb {
            assert!(!ea.needs_attention && !eb.needs_attention);
            assert_eq!(eb.status, SyncStatus::CleanlyApplied);
            if lose {
                assert_eq!(ea.status, SyncStatus::Syncing);
                assert!(!sa.outstanding(&av, &Clock, &cancel).unwrap().is_empty());
            } else {
                assert_eq!(ea.status, SyncStatus::CleanlyApplied);
                assert!(sa.outstanding(&av, &Clock, &cancel).unwrap().is_empty());
                assert!(sb.outstanding(&bv, &Clock, &cancel).unwrap().is_empty());
            }
            assert!(wire.wire_bytes() > 0);
            wire.abort(Error::Disconnected);
            wire.assert_closed();
            return;
        }
    }
    panic!("signed TLS exchange did not quiesce");
}
#[test]
fn r8_s04_s10_s11_s12_real_tls_engine_bidirectional_signed_import_lost_ack_and_restart() {
    native_io_lab::execute(async {
        let mut lab = Lab::new();
        exchange(&lab, &lab.a, &lab.b, true).await;
        assert_eq!(count(&lab.b, "SELECT count(*) FROM e2_originals"), 2);
        assert_eq!(signatures(&lab.a), signatures(&lab.b));
        let before = signatures(&lab.a);
        lab.a.reopen_candidate().unwrap();
        lab.b.reopen_candidate().unwrap();
        exchange(&lab, &lab.a, &lab.b, false).await;
        assert_eq!(before, signatures(&lab.a));
        assert_eq!(before, signatures(&lab.b));
        let project = lab
            .b
            .owner()
            .store()
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT id FROM projects WHERE name='R8 signed project'",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap();
        f::capture_in(
            lab.b.owner().store(),
            &project,
            "Independent CNG peer original → Windows",
        );
        exchange(&lab, &lab.a, &lab.b, false).await;
        assert_eq!(signatures(&lab.a), signatures(&lab.b));
        assert_eq!(signatures(&lab.a).len(), 3);
        assert_eq!(count(&lab.a, "SELECT count(*) FROM captures"), 2);
        assert_eq!(count(&lab.b, "SELECT count(*) FROM captures"), 2);
        let before = signatures(&lab.a);
        lab.a.reopen_candidate().unwrap();
        lab.b.reopen_candidate().unwrap();
        exchange(&lab, &lab.a, &lab.b, false).await;
        assert_eq!(before, signatures(&lab.a));
        assert_eq!(before, signatures(&lab.b));
        for peer in [&lab.a, &lab.b] {
            assert_eq!(
                count(
                    peer,
                    "SELECT count(*) FROM import_events WHERE outcome<>'applied'"
                ),
                0
            );
            let owner = peer.owner();
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
        }
    });
}
fn metadata(lab: &Lab, index: usize) -> (Envelope, SignedMetadata) {
    let owner = lab.a.owner();
    let store = SignedImportStore::synthetic(owner.store());
    let mut events = sync_store::test_events(owner.store());
    events.sort_by_key(|e| e.identity.seq);
    let export = store
        .export_signed(
            &lab.session(&lab.a, &lab.b),
            &events[index].identity,
            &Clock,
            &Cancellation::default(),
        )
        .unwrap();
    (export.event, export.metadata)
}
fn no_publication(peer: &Fixture) {
    for sql in [
        "SELECT count(*) FROM import_events",
        "SELECT count(*) FROM import_g3_commits",
        "SELECT count(*) FROM e2_originals",
        "SELECT count(*) FROM e2_origin_seals",
        "SELECT count(*) FROM captures",
        "SELECT count(*) FROM import_progress WHERE applied>0",
    ] {
        assert_eq!(count(peer, sql), 0, "{sql}");
    }
}
#[test]
fn r8_s05_s06_s07_s08_s09_signed_tls_metadata_corruption_never_publishes_or_acks() {
    native_io_lab::execute(async {
        for mode in 0..14 {
            let lab = Lab::new();
            let session = Uuid::new_v4();
            let (wire, mut source, target) = connect(&lab, &lab.a, &lab.b, session).await;
            let owner = lab.b.owner();
            let store = SignedImportStore::synthetic(owner.store());
            let trust = lab.trust(&lab.b, &lab.a, session);
            let cancel = Cancellation::default();
            let mut receiver = SyncEngine::start(&store, target, &trust, &Clock, &cancel).unwrap();
            let binding = hello(&lab.a, &lab.b, session);
            let p = SyncProfile::SignedOriginalCandidate;
            source
                .send(message(
                    &binding,
                    Payload::Hello {
                        version: p.version(),
                        required: p.features(),
                        supported: p.features(),
                        profile: p.name().into(),
                    },
                ))
                .unwrap();
            wire.transfer().await.unwrap();
            receiver.tick().unwrap();
            let (mut event, mut signed) = metadata(&lab, 0);
            let mut json: serde_json::Value = serde_json::from_slice(&signed.bytes).unwrap();
            match mode {
                0 => {
                    let mut random = [0u8; 64];
                    getrandom::fill(&mut random).unwrap();
                    json["signature"] = serde_json::json!(random.as_slice());
                }
                1 => signed.bytes = metadata(&lab, 1).1.bytes,
                2 => json["body"]["author"] = serde_json::to_value(&lab.b.public).unwrap(),
                3 => json["body"]["network"] = serde_json::json!(Uuid::new_v4()),
                4 => {
                    json["body"]["hash"][0] =
                        serde_json::json!(json["body"]["hash"][0].as_u64().unwrap() ^ 1)
                }
                5 => {
                    event.identity.origin = Uuid::new_v4();
                    signed.identity = event.identity.clone();
                }
                6 => {
                    event.identity.incarnation = Uuid::new_v4();
                    signed.identity = event.identity.clone();
                }
                7 => event.bytes[0] ^= 1,
                8 => {
                    let stranger = Admin::new();
                    signed.bytes = SignedOriginal::sign(binding.network, &event, &stranger.0)
                        .unwrap()
                        .bytes()
                        .unwrap();
                }
                9 => {
                    signed.bytes.insert(0, b' ');
                }
                10 => {
                    json["unknown"] = serde_json::Value::Null;
                    signed.bytes = crate::sync_api::security::canonical(&json).unwrap();
                }
                11 => {
                    signed
                        .bytes
                        .splice(1..1, b"\"signature\":[],".iter().copied());
                }
                12 => {
                    let other = lab.b.owner();
                    let key = crate::storage::device_identity_store::OwnedDeviceIdentity::reopen(
                        other.store(),
                    )
                    .unwrap();
                    signed.bytes = SignedOriginal::sign(binding.network, &event, &key)
                        .unwrap()
                        .bytes()
                        .unwrap();
                }
                _ => {
                    event.identity.hash[0] ^= 1;
                    signed.identity = event.identity.clone();
                }
            }
            if matches!(mode, 0 | 2 | 3 | 4) {
                signed.bytes = crate::sync_api::security::canonical(&json).unwrap();
            }
            if mode == 5 {
                // Registered session scope rejects an invented origin before disclosure.
                source
                    .send(message(&binding, Payload::SignedMetadata(signed)))
                    .unwrap();
                wire.transfer().await.unwrap();
                assert_eq!(receiver.tick(), Err(Error::Trust));
            } else {
                source
                    .send(message(&binding, Payload::SignedMetadata(signed)))
                    .unwrap();
                wire.transfer().await.unwrap();
                receiver.tick().unwrap();
                for chunk in chunk_event(&event) {
                    source
                        .send(message(&binding, Payload::Chunk(chunk)))
                        .unwrap();
                }
                wire.transfer().await.unwrap();
                assert_eq!(
                    receiver.tick(),
                    Err(if matches!(mode, 6 | 7 | 9 | 10 | 11 | 13) {
                        Error::Integrity
                    } else {
                        Error::Trust
                    })
                );
            }
            no_publication(&lab.b);
            wire.transfer().await.unwrap();
            while let Some(m) = source.receive().unwrap() {
                assert!(!matches!(m.payload, Payload::Receipt(_)));
            }
            wire.abort(Error::Disconnected);
            wire.assert_closed();
        }
    });
}

#[test]
fn r8_s13_third_peer_tls_forwarding_preserves_the_original_author_and_signature() {
    native_io_lab::execute(async {
        let mut lab = Lab::new();
        exchange(&lab, &lab.a, &lab.b, false).await;
        let original = signatures(&lab.a);
        let target = lab.add_forwarding_target();
        exchange(&lab, &lab.b, &target, false).await;
        assert_eq!(signatures(&target), original);
        assert_eq!(
            count(&target, "SELECT count(*) FROM e2_export_signatures"),
            0,
            "forwarding must not re-sign imported history"
        );
        assert_eq!(count(&target, "SELECT count(*) FROM e2_originals"), 2);
        for (id, bytes) in original {
            let event = sync_store::test_events(target.owner().store())
                .into_iter()
                .find(|e| e.identity.event.to_string() == id)
                .unwrap();
            SignedOriginal::decode(&bytes)
                .unwrap()
                .verify(lab.history[0].body.network, &event, &lab.a.public)
                .unwrap();
            assert!(SignedOriginal::decode(&bytes)
                .unwrap()
                .verify(lab.history[0].body.network, &event, &lab.b.public)
                .is_err());
        }
    });
}
