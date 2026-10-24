//! REAL WINDOWS CNG + SYNTHETIC SECURITY TESTS; never Android/device evidence.
#![cfg(windows)]
use crate::runtime::NativeRuntime;
use crate::storage::{
    device_identity_store::OwnedDeviceIdentity,
    enrollment_store::{self, NetworkRegistry},
};
use crate::storage::{journal::sync_fixtures as f, signed_import::SignedImportStore, sync_store};
use crate::sync::security::{enrollment::*, identity::*, windows::WindowsIdentity};
use crate::sync::{security::signed::SignedOriginal, trust::TestTrust, *};
use rusqlite::params;
use std::collections::BTreeSet;
use std::sync::Arc;
use uuid::Uuid;

struct Key(WindowsIdentity);
impl Key {
    fn new() -> Self {
        let key = Self(WindowsIdentity::slot(Uuid::new_v4()));
        key.0.create_identity().unwrap();
        key
    }
    fn public(&self) -> PublicIdentity {
        self.0.public_identity().unwrap()
    }
}
impl Drop for Key {
    fn drop(&mut self) {
        if self.0.key_availability() == KeyAvailability::Available {
            self.0.invalidate_identity().unwrap();
        }
    }
}
struct Fixture {
    owner: Arc<NativeRuntime>,
    admin: Key,
    peer: Key,
    other: Key,
    origin: Uuid,
    _dir: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        Self::with_peer(Uuid::new_v4(), Key::new())
    }
    fn with_peer(origin: Uuid, peer: Key) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let owner = NativeRuntime::acquire(&dir.path().canonicalize().unwrap()).unwrap();
        enrollment_store::install(owner.store());
        let identity = OwnedDeviceIdentity::initialize(owner.store()).unwrap();
        let admin = Key(WindowsIdentity::slot(identity.slot_for_test()));
        drop(identity);
        let other = Key::new();
        let registry = NetworkRegistry::candidate(owner.store()).unwrap();
        registry.create_network(&admin.0).unwrap();
        for (key, origins) in [(&peer, vec![origin]), (&other, vec![])] {
            let grant = registry
                .next(
                    Action::Grant {
                        device: key.public(),
                        role: Role::Member,
                        capabilities: 3,
                        enrollment: Uuid::new_v4(),
                        expires: 1000,
                        origins,
                    },
                    &admin.0,
                )
                .unwrap();
            registry.apply(&grant).unwrap();
        }
        Self {
            owner,
            admin,
            peer,
            other,
            origin,
            _dir: dir,
        }
    }
    fn binding(&self) -> MembershipBinding {
        NetworkRegistry::candidate(self.owner.store())
            .unwrap()
            .binding(self.admin.public().peer_id(), &self.peer.public(), 10)
            .unwrap()
    }
    fn authorize(&self, binding: &MembershipBinding) -> crate::sync::security::Result<()> {
        enrollment_store::with_test_connection(self.owner.store(), |c| {
            enrollment_store::authorize_binding(c, binding, 10)
        })
    }
}
#[test]
fn e2_08_intermediate_signature_tampering_refuses_authorization() {
    let f = Fixture::new();
    let binding = f.binding();
    enrollment_store::with_test_connection(f.owner.store(), |c| {
        let bytes: Vec<u8> = c
            .query_row("SELECT bytes FROM e_updates WHERE epoch=2", [], |r| {
                r.get(0)
            })
            .unwrap();
        let mut update = SignedUpdate::decode(&bytes).unwrap();
        update.signature[0] ^= 1;
        c.execute_batch("DROP TRIGGER e_updates_immutable_update")
            .unwrap();
        c.execute(
            "UPDATE e_updates SET bytes=?1 WHERE epoch=2",
            [update.bytes().unwrap()],
        )
        .unwrap();
    });
    assert!(
        f.authorize(&binding).is_err(),
        "authorization must verify every signature"
    );
}
#[test]
fn e2_08_complete_self_signed_registry_replacement_cannot_change_the_pinned_admin() {
    let f = Fixture::new();
    let root = NetworkRegistry::candidate(f.owner.store())
        .unwrap()
        .root()
        .unwrap();
    let genesis = SignedUpdate::sign(
        Update {
            network: root.network,
            epoch: 1,
            previous: [0; 32],
            action: Action::Genesis {
                admin: f.other.public(),
            },
        },
        &f.other.0,
    )
    .unwrap();
    let local_enrollment = Uuid::new_v4();
    let peer_enrollment = Uuid::new_v4();
    let local = SignedUpdate::sign(
        Update {
            network: root.network,
            epoch: 2,
            previous: genesis.body.hash().unwrap(),
            action: Action::Grant {
                device: f.admin.public(),
                role: Role::Member,
                capabilities: 3,
                enrollment: local_enrollment,
                expires: 1000,
                origins: vec![],
            },
        },
        &f.other.0,
    )
    .unwrap();
    let peer = SignedUpdate::sign(
        Update {
            network: root.network,
            epoch: 3,
            previous: local.body.hash().unwrap(),
            action: Action::Grant {
                device: f.peer.public(),
                role: Role::Member,
                capabilities: 3,
                enrollment: peer_enrollment,
                expires: 1000,
                origins: vec![f.origin],
            },
        },
        &f.other.0,
    )
    .unwrap();
    enrollment_store::with_test_connection(f.owner.store(), |c| {
        c.execute_batch("DROP TRIGGER e2_pin_no_update; DROP TRIGGER e_updates_immutable_update; DROP TRIGGER e_updates_immutable_delete; DELETE FROM e_origins; DELETE FROM e_members; DELETE FROM e_updates;").unwrap();
        c.execute(
            "UPDATE e2_network_pin SET genesis=?1",
            [genesis.bytes().unwrap()],
        )
        .unwrap();
        for update in [&genesis, &local, &peer] {
            c.execute(
                "INSERT INTO e_updates VALUES(?1,?2)",
                params![update.body.epoch, update.bytes().unwrap()],
            )
            .unwrap();
        }
        c.execute(
            "UPDATE e_registry SET admin=?1,digest=?2",
            params![
                f.other.public().sec1(),
                peer.body.hash().unwrap().as_slice()
            ],
        )
        .unwrap();
        c.execute(
            "INSERT INTO e_members VALUES(?1,?2,NULL,1,?3,3)",
            params![
                f.other.public().peer_id().to_string(),
                f.other.public().sec1(),
                i64::MAX
            ],
        )
        .unwrap();
        for (key, enrollment) in [(&f.admin, local_enrollment), (&f.peer, peer_enrollment)] {
            c.execute(
                "INSERT INTO e_members VALUES(?1,?2,?3,1,1000,3)",
                params![
                    key.public().peer_id().to_string(),
                    key.public().sec1(),
                    enrollment.to_string()
                ],
            )
            .unwrap();
        }
        c.execute(
            "INSERT INTO e_origins VALUES(?1,?2)",
            params![f.origin.to_string(), f.peer.public().peer_id().to_string()],
        )
        .unwrap();
    });
    assert!(
        NetworkRegistry::candidate(f.owner.store())
            .unwrap()
            .binding(f.admin.public().peer_id(), &f.peer.public(), 10)
            .is_err(),
        "a self-signed replacement cannot replace the locally selected admin"
    );
    let bytes = crate::sync::security::canonical(&(
        "locally-confirmed-network-e2",
        genesis.bytes().unwrap(),
    ))
    .unwrap();
    let signature = f
        .other
        .0
        .sign_domain_separated(Domain::Registry, &bytes)
        .unwrap();
    enrollment_store::with_test_connection(f.owner.store(), |c| {
        c.execute(
            "UPDATE e2_network_pin SET local_key=?1,signature=?2",
            params![f.other.public().sec1(), signature],
        )
        .unwrap();
    });
    assert!(
        NetworkRegistry::candidate(f.owner.store())
            .unwrap()
            .binding(f.admin.public().peer_id(), &f.peer.public(), 10)
            .is_err(),
        "a coherent attacker pin still does not match the OS-held local anchor"
    );
}
#[test]
fn e2_09_missing_or_reordered_history_refuses_authorization() {
    for missing in [true, false] {
        let f = Fixture::new();
        let binding = f.binding();
        enrollment_store::with_test_connection(f.owner.store(), |c| {
            c.execute_batch(
                "DROP TRIGGER e_updates_immutable_delete; DROP TRIGGER e_updates_immutable_update;",
            )
            .unwrap();
            if missing {
                c.execute("DELETE FROM e_updates WHERE epoch=2", [])
                    .unwrap();
            } else {
                c.execute("UPDATE e_updates SET bytes=(SELECT bytes FROM e_updates WHERE epoch=3) WHERE epoch=2", []).unwrap();
            }
        });
        assert!(
            f.authorize(&binding).is_err(),
            "unsigned root cannot bypass the chain"
        );
    }
}
#[test]
fn e2_10_unsigned_member_cannot_gain_authority() {
    let f = Fixture::new();
    let attacker = Key::new();
    enrollment_store::with_test_connection(f.owner.store(), |c| {
        c.execute(
            "INSERT INTO e_members VALUES(?1,?2,?3,1,1000,3)",
            params![
                attacker.public().peer_id().to_string(),
                attacker.public().sec1(),
                Uuid::new_v4().to_string()
            ],
        )
        .unwrap();
    });
    assert!(
        NetworkRegistry::candidate(f.owner.store())
            .unwrap()
            .binding(f.admin.public().peer_id(), &attacker.public(), 10)
            .is_err(),
        "member rows need signed provenance"
    );
}
#[test]
fn e2_11_unsigned_origin_projection_cannot_replace_author() {
    let f = Fixture::new();
    enrollment_store::with_test_connection(f.owner.store(), |c| {
        c.execute(
            "UPDATE e_origins SET device=?1",
            [f.other.public().peer_id().to_string()],
        )
        .unwrap()
    });
    assert!(
        NetworkRegistry::candidate(f.owner.store())
            .unwrap()
            .original_author(f.origin)
            .is_err(),
        "origin rows need signed provenance"
    );
}
#[test]
fn e2_12_missing_local_identity_refuses_enabled_membership() {
    let f = Fixture::new();
    let binding = f.binding();
    f.owner
        .store()
        .execute_sql_for_test("DELETE FROM e_identity");
    assert!(
        f.authorize(&binding).is_err(),
        "a caller UUID is not a local identity"
    );
}
#[test]
fn e2_13_invalidated_mismatched_and_missing_os_key_refuse_after_reopen() {
    for mode in 0..3 {
        let fixture = Fixture::new();
        let binding = fixture.binding();
        if mode == 0 {
            fixture
                .owner
                .store()
                .execute_sql_for_test("UPDATE e_identity SET state='invalidated'");
        }
        if mode == 1 {
            enrollment_store::with_test_connection(fixture.owner.store(), |c| {
                c.execute(
                    "UPDATE e_identity SET key=?1",
                    [fixture.other.public().sec1()],
                )
                .unwrap();
            });
        }
        if mode == 2 {
            fixture.admin.0.invalidate_identity().unwrap();
        }
        let Fixture {
            owner,
            admin,
            peer,
            other,
            origin: _,
            _dir,
        } = fixture;
        drop(owner);
        let owner = NativeRuntime::acquire(&_dir.path().canonicalize().unwrap()).unwrap();
        assert!(OwnedDeviceIdentity::reopen(owner.store()).is_err());
        assert!(enrollment_store::with_test_connection(owner.store(), |c| {
            enrollment_store::authorize_binding(c, &binding, 10)
        })
        .is_err());
        drop((admin, peer, other));
    }
}
#[test]
fn e2_18_os_creation_before_sql_publication_leaves_creating_state() {
    let dir = tempfile::tempdir().unwrap();
    let owner = NativeRuntime::acquire(&dir.path().canonicalize().unwrap()).unwrap();
    enrollment_store::install(owner.store());
    owner.store().execute_sql_for_test("CREATE TRIGGER fail_publish BEFORE UPDATE ON e_identity BEGIN SELECT RAISE(ABORT,'synthetic publication failure'); END;");
    assert!(OwnedDeviceIdentity::initialize(owner.store()).is_err());
    let slot = enrollment_store::with_test_connection(owner.store(), |c| {
        c.query_row(
            "SELECT slot FROM e_identity WHERE state='creating'",
            [],
            |r| r.get::<_, String>(0),
        )
        .unwrap()
    });
    let key = Key(WindowsIdentity::slot(Uuid::parse_str(&slot).unwrap()));
    let original = key.public().device_id();
    drop(owner);
    let owner = NativeRuntime::acquire(&dir.path().canonicalize().unwrap()).unwrap();
    assert!(OwnedDeviceIdentity::reopen(owner.store()).is_err());
    assert!(OwnedDeviceIdentity::initialize(owner.store()).is_err());
    assert_eq!(key.public().device_id(), original);
}
#[test]
fn e2_18_owned_identity_creates_network_without_owner_lock_reentry() {
    let dir = tempfile::tempdir().unwrap();
    let owner = NativeRuntime::acquire(&dir.path().canonicalize().unwrap()).unwrap();
    enrollment_store::install(owner.store());
    let identity = OwnedDeviceIdentity::initialize(owner.store()).unwrap();
    let r = NetworkRegistry::candidate(owner.store()).unwrap();
    assert_eq!(
        r.create_network(&identity).unwrap().admin.device_id(),
        identity.public_identity().unwrap().device_id()
    );
    identity.invalidate_identity().unwrap();
}
fn proof(f: &Fixture, ch: &Challenge, ticket: Attempt) -> CandidateProof {
    let root = NetworkRegistry::candidate(f.owner.store())
        .unwrap()
        .root()
        .unwrap();
    CandidateProof::fixture(
        ticket,
        Transcript {
            enrollment: ch.id,
            network: root.network,
            admin: root.admin.device_id(),
            issuer: root.admin,
            joiner: f.other.public(),
            suite: "arthur-enrollment-candidate-v1".into(),
            issuer_nonce: [1; 32],
            joiner_nonce: [2; 32],
            exporter: [3; 32],
        },
    )
}
#[test]
fn e2_20_observed_clock_rollback_cannot_extend_enrollment() {
    let f = Fixture::new();
    let r = NetworkRegistry::candidate(f.owner.store()).unwrap();
    let boot = r.startup().unwrap();
    let mut ch = r.issue_fixture(boot, 10).unwrap();
    let ticket = r.reserve(&mut ch, 100).unwrap();
    let proof = proof(&f, &ch, ticket);
    assert!(matches!(
        r.record_proof(&mut ch, proof, 90),
        Err(crate::sync::security::SecurityError::Expired)
    ));
    assert!(ch.code.is_none());
}

struct Clock;
impl SyncClock for Clock {
    fn now(&self) -> u64 {
        10
    }
}
struct Integration {
    f: Fixture,
    _source: Arc<NativeRuntime>,
    _dir: tempfile::TempDir,
    events: Vec<Envelope>,
}
impl Integration {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let source = NativeRuntime::acquire(&dir.path().canonicalize().unwrap()).unwrap();
        enrollment_store::install(source.store());
        let identity = OwnedDeviceIdentity::initialize(source.store()).unwrap();
        let remote = Key(WindowsIdentity::slot(identity.slot_for_test()));
        drop(identity);
        f::upgrade(source.store());
        f::captures(
            source.store(),
            &["Synthetic E2 first", "Synthetic E2 second"],
        );
        sync_store::install_candidate(
            source.store(),
            Uuid::new_v4(),
            remote.public().peer_id(),
            &[],
        )
        .unwrap();
        let mut events = sync_store::test_events(source.store());
        events.sort_by_key(|e| e.identity.seq);
        let f = Fixture::with_peer(events[0].identity.origin, remote);
        f::upgrade(f.owner.store());
        let r = NetworkRegistry::candidate(f.owner.store()).unwrap();
        let root = r.root().unwrap();
        sync_store::install_candidate(
            f.owner.store(),
            root.network,
            f.admin.public().peer_id(),
            &[(f.other.public().peer_id(), root.epoch)],
        )
        .unwrap();
        f::install_g3(f.owner.store());
        sync_store::grant_test_origins(
            f.owner.store(),
            f.other.public().peer_id(),
            &BTreeSet::from([f.origin]),
        );
        Self::refresh_epoch(&f);
        Self {
            f,
            _source: source,
            _dir: dir,
            events,
        }
    }
    fn refresh_epoch(f: &Fixture) {
        let epoch = NetworkRegistry::candidate(f.owner.store())
            .unwrap()
            .root()
            .unwrap()
            .epoch;
        enrollment_store::with_test_connection(f.owner.store(), |c| {
            c.execute("UPDATE import_members SET epoch=?1", [epoch])
                .unwrap();
            c.execute("UPDATE import_origin_permissions SET epoch=?1", [epoch])
                .unwrap();
        });
    }
    fn session(&self) -> VerifiedSession {
        let r = NetworkRegistry::candidate(self.f.owner.store()).unwrap();
        let root = r.root().unwrap();
        let hello = PeerHello {
            network: root.network,
            session: Uuid::new_v4(),
            local: self.f.admin.public().peer_id(),
            peer: self.f.other.public().peer_id(),
            epoch: root.epoch,
        };
        TestTrust {
            hello: hello.clone(),
            expires: 100,
            origins: BTreeSet::from([self.f.origin]),
        }
        .verify(&hello)
        .unwrap()
        .with_registry(r.binding(hello.local, &self.f.other.public(), 10).unwrap())
    }
    fn signed(&self, index: usize) -> SignedOriginal {
        let network = NetworkRegistry::candidate(self.f.owner.store())
            .unwrap()
            .root()
            .unwrap()
            .network;
        SignedOriginal::sign(network, &self.events[index], &self.f.peer.0).unwrap()
    }
    fn revoke(&self) {
        let r = NetworkRegistry::candidate(self.f.owner.store()).unwrap();
        let update = r
            .next(
                Action::Revoke {
                    device: self.f.peer.public(),
                },
                &self.f.admin.0,
            )
            .unwrap();
        r.apply(&update).unwrap();
        Self::refresh_epoch(&self.f);
    }
}
#[test]
fn e2_16_forwarder_signature_cannot_replace_the_original_author() {
    let i = Integration::new();
    let session = i.session();
    let wrong =
        SignedOriginal::sign(session.binding().network, &i.events[0], &i.f.other.0).unwrap();
    let store = SignedImportStore::synthetic(i.f.owner.store());
    assert!(store
        .retain(
            &session,
            &wrong,
            i.events[0].clone(),
            &Clock,
            &Cancellation::default()
        )
        .is_err());
    assert_eq!(
        i.f.owner
            .store()
            .query_i64_for_test("SELECT count(*) FROM captures"),
        0
    );
    let receipt = store
        .retain(
            &session,
            &i.signed(0),
            i.events[0].clone(),
            &Clock,
            &Cancellation::default(),
        )
        .unwrap();
    assert_eq!(receipt.outcome, Outcome::CleanlyApplied);
    assert_eq!(
        i.f.owner
            .store()
            .query_i64_for_test("SELECT count(*) FROM captures"),
        1
    );
    f::clean(i.f.owner.store());
}
#[test]
fn e2_16_rejected_fork_does_not_seal_a_prefix() {
    let i = Integration::new();
    let session = i.session();
    // Existing D4 import is valid but has no separately signed E2 prefix yet.
    let ordinary = sync_store::CandidateSyncStore::synthetic(i.f.owner.store());
    ordinary
        .retain(
            &session,
            ValidatedEvent::parse(i.events[0].clone()).unwrap(),
            &Clock,
            &Cancellation::default(),
        )
        .unwrap();
    let fork = changed_core(&i.events[0], i.f.origin, i.events[0].identity.incarnation);
    let signed = SignedOriginal::sign(session.binding().network, &fork, &i.f.peer.0).unwrap();
    let store = SignedImportStore::synthetic(i.f.owner.store());
    let receipt = store
        .retain(&session, &signed, fork, &Clock, &Cancellation::default())
        .unwrap();
    assert_eq!(receipt.outcome, Outcome::RejectedIntegrity);
    assert_eq!(
        i.f.owner
            .store()
            .query_i64_for_test("SELECT count(*) FROM e2_origin_seals"),
        0
    );
    assert_eq!(
        i.f.owner
            .store()
            .query_i64_for_test("SELECT count(*) FROM captures"),
        1
    );
    assert_eq!(
        i.f.owner
            .store()
            .query_i64_for_test("SELECT count(*) FROM e2_quarantine"),
        0
    );
}
#[test]
fn e2_16_existing_local_core_receipt_cannot_mint_original_import_provenance() {
    let i = Integration::new();
    f::captures(
        i.f.owner.store(),
        &["Synthetic existing receiver-local core"],
    );
    let event = sync_store::test_events(i.f.owner.store()).remove(0);
    let claimant = Key::new();
    let r = NetworkRegistry::candidate(i.f.owner.store()).unwrap();
    let grant = r
        .next(
            Action::Grant {
                device: claimant.public(),
                role: Role::Member,
                capabilities: 3,
                enrollment: Uuid::new_v4(),
                expires: 1000,
                origins: vec![event.identity.origin],
            },
            &i.f.admin.0,
        )
        .unwrap();
    r.apply(&grant).unwrap();
    Integration::refresh_epoch(&i.f);
    let root = r.root().unwrap();
    enrollment_store::with_test_connection(i.f.owner.store(), |c| {
        c.execute(
            "INSERT INTO import_origin_permissions VALUES(?1,?2,?3,1)",
            params![
                i.f.other.public().peer_id().to_string(),
                event.identity.origin.to_string(),
                root.epoch
            ],
        )
        .unwrap();
    });
    let hello = PeerHello {
        network: root.network,
        session: Uuid::new_v4(),
        local: i.f.admin.public().peer_id(),
        peer: i.f.other.public().peer_id(),
        epoch: root.epoch,
    };
    let session = TestTrust {
        hello: hello.clone(),
        expires: 100,
        origins: BTreeSet::from([i.f.origin, event.identity.origin]),
    }
    .verify(&hello)
    .unwrap()
    .with_registry(r.binding(hello.local, &i.f.other.public(), 10).unwrap());
    let signed = SignedOriginal::sign(root.network, &event, &claimant.0).unwrap();
    let receipt = SignedImportStore::synthetic(i.f.owner.store())
        .retain(&session, &signed, event, &Clock, &Cancellation::default())
        .unwrap();
    assert_eq!(receipt.outcome, Outcome::UnsupportedImportPolicy);
    assert_eq!(
        i.f.owner
            .store()
            .query_i64_for_test("SELECT count(*) FROM e2_origin_seals"),
        0
    );
    assert_eq!(
        i.f.owner
            .store()
            .query_i64_for_test("SELECT count(*) FROM captures"),
        1
    );
    assert_eq!(
        i.f.owner
            .store()
            .query_i64_for_test("SELECT count(*) FROM e2_quarantine"),
        1
    );
}
#[test]
fn e2_17_revoked_author_keeps_known_prefix_but_unknown_tail_is_unsupported() {
    let i = Integration::new();
    let store = SignedImportStore::synthetic(i.f.owner.store());
    let cancel = Cancellation::default();
    store
        .retain(
            &i.session(),
            &i.signed(0),
            i.events[0].clone(),
            &Clock,
            &cancel,
        )
        .unwrap();
    i.revoke();
    let r = NetworkRegistry::candidate(i.f.owner.store()).unwrap();
    assert_eq!(
        r.original_author(i.f.origin).unwrap().device_id(),
        i.f.peer.public().device_id()
    );
    assert_eq!(
        store
            .retain(
                &i.session(),
                &i.signed(0),
                i.events[0].clone(),
                &Clock,
                &cancel
            )
            .unwrap()
            .outcome,
        Outcome::CleanlyApplied
    );
    assert_eq!(
        store
            .retain(
                &i.session(),
                &i.signed(1),
                i.events[1].clone(),
                &Clock,
                &cancel
            )
            .unwrap()
            .outcome,
        Outcome::UnsupportedImportPolicy
    );
    assert_eq!(
        i.f.owner
            .store()
            .query_i64_for_test("SELECT count(*) FROM captures"),
        1
    );
    assert_eq!(
        i.f.owner
            .store()
            .query_i64_for_test("SELECT count(*) FROM e2_quarantine"),
        1
    );
    assert_eq!(
        i.f.owner
            .store()
            .query_i64_for_test("SELECT count(*) FROM e2_originals"),
        1
    );
    f::clean(i.f.owner.store());
}
#[test]
fn e2_14_15_signed_import_and_revocation_have_one_commit_order() {
    for revoke_first in [true, false] {
        let i = Integration::new();
        let session = i.session();
        let signed = i.signed(0);
        let store = SignedImportStore::synthetic(i.f.owner.store());
        let r = NetworkRegistry::candidate(i.f.owner.store()).unwrap();
        let update = r
            .next(
                Action::Revoke {
                    device: i.f.peer.public(),
                },
                &i.f.admin.0,
            )
            .unwrap();
        if revoke_first {
            std::thread::scope(|scope| scope.spawn(|| r.apply(&update).unwrap()).join().unwrap());
            assert!(store
                .retain(
                    &session,
                    &signed,
                    i.events[0].clone(),
                    &Clock,
                    &Cancellation::default()
                )
                .is_err());
            assert_eq!(
                i.f.owner
                    .store()
                    .query_i64_for_test("SELECT count(*) FROM captures"),
                0
            );
            assert_eq!(
                i.f.owner
                    .store()
                    .query_i64_for_test("SELECT count(*) FROM e2_originals"),
                0
            );
        } else {
            std::thread::scope(|scope| {
                let (ready_tx, ready_rx) = std::sync::mpsc::channel();
                let (waiting_tx, waiting_rx) = std::sync::mpsc::channel();
                let registry = &r;
                let update = &update;
                let revoke = scope.spawn(move || {
                    ready_rx.recv().unwrap();
                    waiting_tx.send(()).unwrap();
                    registry.apply(update).unwrap();
                });
                let receipt = store
                    .retain_with_barrier(
                        &session,
                        &signed,
                        i.events[0].clone(),
                        &Clock,
                        &Cancellation::default(),
                        || {
                            ready_tx.send(()).unwrap();
                            waiting_rx.recv().unwrap();
                        },
                    )
                    .unwrap();
                assert_eq!(receipt.outcome, Outcome::CleanlyApplied);
                revoke.join().unwrap();
            });
            assert_eq!(
                i.f.owner
                    .store()
                    .query_i64_for_test("SELECT count(*) FROM captures"),
                1
            );
            assert_eq!(
                i.f.owner
                    .store()
                    .query_i64_for_test("SELECT count(*) FROM e2_originals"),
                1
            );
        }
        f::clean(i.f.owner.store());
    }
}
#[test]
fn e2_17_unsigned_prefix_cannot_authorize_history() {
    let i = Integration::new();
    let store = SignedImportStore::synthetic(i.f.owner.store());
    store
        .retain(
            &i.session(),
            &i.signed(0),
            i.events[0].clone(),
            &Clock,
            &Cancellation::default(),
        )
        .unwrap();
    enrollment_store::with_test_connection(i.f.owner.store(), |c| {
        c.execute("UPDATE e2_origin_seals SET signature=zeroblob(64)", [])
            .unwrap();
    });
    assert!(store
        .retain(
            &i.session(),
            &i.signed(0),
            i.events[0].clone(),
            &Clock,
            &Cancellation::default()
        )
        .is_err());
    assert_eq!(
        i.f.owner
            .store()
            .query_i64_for_test("SELECT count(*) FROM captures"),
        1
    );
}
fn changed_core(event: &Envelope, origin: Uuid, incarnation: Uuid) -> Envelope {
    let mut core = crate::storage::journal::codec::decode_core_strict(&event.bytes).unwrap();
    core.event_id = Uuid::new_v4().to_string();
    core.bundle_id = Uuid::new_v4().to_string();
    core.origin_id = origin.to_string();
    core.origin_incarnation = incarnation.to_string();
    let bytes = crate::storage::journal::codec::encode_canonical(&core).unwrap();
    let identity = Identity {
        event: Uuid::parse_str(&core.event_id).unwrap(),
        bundle: Uuid::parse_str(&core.bundle_id).unwrap(),
        origin,
        incarnation,
        seq: core.origin_seq.parse().unwrap(),
        hash: crate::storage::journal::codec::journal_event_hash(&bytes),
    };
    let event = Envelope { identity, bytes };
    ValidatedEvent::parse(event.clone()).unwrap();
    event
}
#[test]
fn e2_17_origin_collision_and_incarnation_reuse_are_unsupported() {
    let i = Integration::new();
    let store = SignedImportStore::synthetic(i.f.owner.store());
    store
        .retain(
            &i.session(),
            &i.signed(0),
            i.events[0].clone(),
            &Clock,
            &Cancellation::default(),
        )
        .unwrap();
    let network = i.session().binding().network;
    let changed = changed_core(&i.events[0], i.f.origin, Uuid::new_v4());
    let signed = SignedOriginal::sign(network, &changed, &i.f.peer.0).unwrap();
    assert_eq!(
        store
            .retain(
                &i.session(),
                &signed,
                changed,
                &Clock,
                &Cancellation::default()
            )
            .unwrap()
            .outcome,
        Outcome::UnsupportedImportPolicy
    );
    let fresh = Key::new();
    let origin = Uuid::new_v4();
    let r = NetworkRegistry::candidate(i.f.owner.store()).unwrap();
    let collision = r
        .next(
            Action::Grant {
                device: fresh.public(),
                role: Role::Member,
                capabilities: 3,
                enrollment: Uuid::new_v4(),
                expires: 1000,
                origins: vec![i.f.origin],
            },
            &i.f.admin.0,
        )
        .unwrap();
    assert!(r.apply(&collision).is_err());
    let grant = r
        .next(
            Action::Grant {
                device: fresh.public(),
                role: Role::Member,
                capabilities: 3,
                enrollment: Uuid::new_v4(),
                expires: 1000,
                origins: vec![origin],
            },
            &i.f.admin.0,
        )
        .unwrap();
    r.apply(&grant).unwrap();
    Integration::refresh_epoch(&i.f);
    let epoch = r.root().unwrap().epoch;
    enrollment_store::with_test_connection(i.f.owner.store(), |c| {
        c.execute(
            "INSERT INTO import_origin_permissions VALUES(?1,?2,?3,1)",
            params![
                i.f.other.public().peer_id().to_string(),
                origin.to_string(),
                epoch
            ],
        )
        .unwrap();
    });
    let mut hello = i.session().binding().clone();
    hello.session = Uuid::new_v4();
    let session = TestTrust {
        hello: hello.clone(),
        expires: 100,
        origins: BTreeSet::from([i.f.origin, origin]),
    }
    .verify(&hello)
    .unwrap()
    .with_registry(r.binding(hello.local, &i.f.other.public(), 10).unwrap());
    let reused = changed_core(&i.events[0], origin, i.events[0].identity.incarnation);
    let signed = SignedOriginal::sign(network, &reused, &fresh.0).unwrap();
    assert_eq!(
        store
            .retain(&session, &signed, reused, &Clock, &Cancellation::default())
            .unwrap()
            .outcome,
        Outcome::UnsupportedImportPolicy
    );
    assert_eq!(
        i.f.owner
            .store()
            .query_i64_for_test("SELECT count(*) FROM captures"),
        1
    );
    assert_eq!(
        i.f.owner
            .store()
            .query_i64_for_test("SELECT count(*) FROM e2_origin_seals"),
        1
    );
}
#[test]
fn e2_17_sealed_prefix_and_original_signatures_verify_after_disk_reopen() {
    let i = Integration::new();
    let store = SignedImportStore::synthetic(i.f.owner.store());
    let signed = i.signed(0);
    store
        .retain(
            &i.session(),
            &signed,
            i.events[0].clone(),
            &Clock,
            &Cancellation::default(),
        )
        .unwrap();
    i.revoke();
    let session = i.session();
    let expected = f::state(i.f.owner.store());
    drop(store);
    let Integration {
        f: fixture,
        _source,
        _dir: source_dir,
        events,
    } = i;
    let Fixture {
        owner,
        admin,
        peer,
        other,
        origin: _,
        _dir,
    } = fixture;
    let root = owner.data_root().to_path_buf();
    drop(owner);
    let reopened =
        f::reopen(crate::storage::ownership::DataRootOwnership::try_acquire(&root).unwrap());
    assert!(
        f::state(&reopened) == expected,
        "sealed state changed after reopen"
    );
    assert_eq!(
        SignedImportStore::synthetic(&reopened)
            .retain(
                &session,
                &signed,
                events[0].clone(),
                &Clock,
                &Cancellation::default()
            )
            .unwrap()
            .outcome,
        Outcome::CleanlyApplied
    );
    f::clean(&reopened);
    drop((admin, peer, other, _source, source_dir));
}
#[test]
fn e2_19_20_lost_receipt_and_consumption_survive_real_owner_reopen() {
    let f = Fixture::new();
    let joining = Key::new();
    let r = NetworkRegistry::candidate(f.owner.store()).unwrap();
    let root = r.root().unwrap();
    let boot = r.startup().unwrap();
    let mut ch = r.issue_fixture(boot, 10).unwrap();
    let ticket = r.reserve(&mut ch, 11).unwrap();
    let transcript = Transcript {
        enrollment: ch.id,
        network: root.network,
        admin: root.admin.device_id(),
        issuer: root.admin,
        joiner: joining.public(),
        suite: "arthur-enrollment-candidate-v1".into(),
        issuer_nonce: [1; 32],
        joiner_nonce: [2; 32],
        exporter: [3; 32],
    };
    let hash = r
        .record_proof(&mut ch, CandidateProof::fixture(ticket, transcript), 12)
        .unwrap();
    let grant = r
        .approve(ch.id, &joining.public(), hash, 13, &f.admin.0)
        .unwrap();
    let request =
        crate::sync::security::canonical(&(root.network, ch.id, joining.public(), [9u8; 32]))
            .unwrap();
    let signature = joining
        .0
        .sign_domain_separated(Domain::EnrollmentReceipt, &request)
        .unwrap();
    drop(r);
    let Fixture {
        owner,
        admin,
        peer,
        other,
        origin: _,
        _dir,
    } = f;
    drop(owner);
    let owner = NativeRuntime::acquire(&_dir.path().canonicalize().unwrap()).unwrap();
    let r = NetworkRegistry::candidate(owner.store()).unwrap();
    let boot = r.startup().unwrap();
    for _ in 0..3 {
        assert_eq!(
            r.resume(ch.id, &joining.public(), 14, [9; 32], &signature)
                .unwrap(),
            grant
        );
    }
    assert!(r.reserve(&mut ch, 14).is_err());
    assert!(r
        .approve(ch.id, &joining.public(), hash, 14, &admin.0)
        .is_err());
    assert_eq!(
        owner
            .store()
            .query_i64_for_test("SELECT attempts FROM e_abuse"),
        1
    );
    assert_eq!(
        owner
            .store()
            .query_i64_for_test("SELECT issued FROM e_abuse"),
        1
    );
    assert_eq!(
        owner
            .store()
            .query_i64_for_test("SELECT count(*) FROM e_updates"),
        4
    );
    enrollment_store::with_test_connection(owner.store(), |c| {
        c.execute(
            "UPDATE e_enrollments SET grant_bytes=?1 WHERE id=?2",
            params![b"invalid".as_slice(), ch.id.to_string()],
        )
        .unwrap();
    });
    assert!(
        r.resume(ch.id, &joining.public(), 14, [9; 32], &signature)
            .is_err(),
        "stored grant bytes must match signed registry history"
    );
    enrollment_store::with_test_connection(owner.store(), |c| {
        c.execute(
            "UPDATE e_enrollments SET grant_bytes=?1 WHERE id=?2",
            params![&grant, ch.id.to_string()],
        )
        .unwrap();
    });
    assert!(r.issue_fixture(boot, 15).is_ok());
    owner
        .store()
        .execute_sql_for_test("UPDATE e_identity SET state='invalidated'");
    assert!(
        r.resume(ch.id, &joining.public(), 16, [9; 32], &signature)
            .is_err(),
        "grant delivery also requires the active local identity"
    );
    drop((peer, other));
}
#[test]
fn e2_21_24_signed_metadata_cannot_construct_release_trust_or_activate_schema() {
    let f = Fixture::new();
    let binding = f.binding();
    let hello = PeerHello {
        network: binding.root.network,
        session: Uuid::new_v4(),
        local: binding.local,
        peer: binding.peer.peer_id(),
        epoch: binding.root.epoch,
    };
    assert!(ClosedTrust.verify(&hello).is_err());
    assert!(matches!(
        SignedImportStore::production(f.owner.store()),
        Err(Error::ActivationPending)
    ));
    assert_eq!(enrollment_store::schema_version(f.owner.store()), 9);
    assert!(crate::sync::security::enrollment::live_pairing().is_err());
    assert!(crate::sync::security::transport::ClosedLan
        .dial("192.168.1.2:7431")
        .is_err());
}
#[test]
fn e2_22_diagnostics_are_categories_and_no_android_frontend_signing_api_exists() {
    assert_eq!(
        format!("{:?}", crate::sync::security::SecurityError::Trust),
        "Trust"
    );
    let component=include_str!("../../gen/android/app/src/main/java/dev/kaloyan/arthur/security/DeviceSigningIdentity.java");
    for forbidden in [
        "@Command",
        "@TauriPlugin",
        "Log.",
        "System.out",
        "printStackTrace",
        "getEncoded(",
        "import android.app.Activity",
    ] {
        assert!(!component.contains(forbidden));
    }
}
fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}
fn verify_public_fixture(text: &str, producer: &str) {
    let fields: std::collections::BTreeMap<_, _> = text
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect();
    assert_eq!(fields.get("producer"), Some(&producer));
    let public = PublicIdentity::from_sec1(hex(fields["public"])).unwrap();
    let message = hex(fields["message"]);
    for (name, domain) in [
        ("Registry", Domain::Registry),
        ("EnrollmentReceipt", Domain::EnrollmentReceipt),
        ("OriginalEvent", Domain::OriginalEvent),
        ("SessionReceipt", Domain::SessionReceipt),
    ] {
        let signature = hex(fields[name]);
        verify(&public, domain, &message, &signature).unwrap();
        let mut changed = message.clone();
        changed[0] ^= 1;
        assert!(verify(&public, domain, &changed, &signature).is_err());
    }
}
#[test]
fn e2_04_07_public_cng_and_host_jca_vectors_verify_on_windows() {
    verify_public_fixture(
        include_str!("../../gen/android/app/src/androidTest/assets/identity-cng-public.properties"),
        "WINDOWS_CNG_NONEXPORTABLE",
    );
    verify_public_fixture(
        include_str!(
            "../../gen/android/app/src/androidTest/assets/identity-host-jca-public.properties"
        ),
        "HOST_JCA_SunEC",
    );
}
#[test]
#[ignore = "Requires public-only fixture from an actual Android device/emulator; E2-06 NOT TESTED on Windows alone"]
fn e2_06_actual_android_public_fixture_verifies_on_windows() {
    let path = std::env::var_os("ARTHUR_E2_ANDROID_PUBLIC_FIXTURE")
        .expect("actual device fixture path required");
    let text = std::fs::read_to_string(path).unwrap();
    verify_public_fixture(&text, "ANDROID_KEYSTORE_DEVICE");
}
