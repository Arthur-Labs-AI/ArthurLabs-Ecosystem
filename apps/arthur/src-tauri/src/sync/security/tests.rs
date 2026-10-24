//! E-series acceptance: OS crypto is real; PAKE proofs below are metadata fixtures.
//! E10/E13/E20 are BLOCKED, never credited using these fixtures.
use super::{enrollment::*, identity::*, signed::*, transport::*, *};
use crate::sync::{trust::TestTrust, *};
use crate::{
    runtime::NativeRuntime,
    storage::{
        enrollment_store::{self, NetworkRegistry},
        journal::sync_fixtures as f,
        sync_store::{install_candidate, test_events, CandidateSyncStore},
    },
};
use sha2::Digest;
use std::{collections::BTreeSet, sync::Arc};
use uuid::Uuid;
#[cfg(windows)]
struct Key(windows::WindowsIdentity);
#[cfg(windows)]
impl Key {
    fn new() -> Self {
        let k = Self(windows::WindowsIdentity::slot(Uuid::new_v4()));
        k.0.create_identity().unwrap();
        k
    }
}
#[cfg(windows)]
impl std::ops::Deref for Key {
    type Target = windows::WindowsIdentity;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
#[cfg(windows)]
impl Drop for Key {
    fn drop(&mut self) {
        if self.0.key_availability() == KeyAvailability::Available {
            self.0.invalidate_identity().unwrap();
        }
    }
}
fn owner() -> (tempfile::TempDir, Arc<NativeRuntime>) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let owner = NativeRuntime::acquire(&root).unwrap();
    enrollment_store::install(owner.store());
    (dir, owner)
}
#[cfg(windows)]
fn transcript(root: &enrollment_store::Root, ch: &Challenge, joiner: &Key) -> Transcript {
    Transcript {
        enrollment: ch.id,
        network: root.network,
        admin: root.admin.device_id(),
        issuer: root.admin.clone(),
        joiner: joiner.public_identity().unwrap(),
        suite: "arthur-enrollment-candidate-v1".into(),
        issuer_nonce: [1; 32],
        joiner_nonce: [2; 32],
        exporter: [3; 32],
    }
}
#[cfg(windows)]
#[test]
fn e09_expired_proof_and_approval_commit_expired_state() {
    let (_dir, o) = owner();
    let admin = Key::new();
    let joiner = Key::new();
    let r = NetworkRegistry::candidate(o.store()).unwrap();
    let root = r.create_network(&admin.0).unwrap();
    let boot = r.startup().unwrap();
    let mut ch = r.issue_fixture(boot, 10).unwrap();
    let ticket = r.reserve(&mut ch, 11).unwrap();
    let proof = CandidateProof::fixture(ticket, transcript(&root, &ch, &joiner));
    assert_eq!(
        r.record_proof(&mut ch, proof, 130),
        Err(SecurityError::Expired)
    );
    assert_eq!(
        o.store()
            .query_i64_for_test("SELECT count(*) FROM e_enrollments WHERE state='expired'"),
        1
    );
    assert!(ch.code.is_none());
    let mut ch = r.issue_fixture(boot, 200).unwrap();
    let ticket = r.reserve(&mut ch, 201).unwrap();
    let proof = CandidateProof::fixture(ticket, transcript(&root, &ch, &joiner));
    let hash = r.record_proof(&mut ch, proof, 202).unwrap();
    assert_eq!(
        r.approve(
            ch.id,
            &joiner.public_identity().unwrap(),
            hash,
            320,
            &admin.0
        ),
        Err(SecurityError::Expired)
    );
    assert_eq!(
        o.store()
            .query_i64_for_test("SELECT count(*) FROM e_enrollments WHERE state='expired'"),
        2
    );
    assert_eq!(r.root().unwrap().epoch, 1);
}
#[cfg(windows)]
#[test]
fn e01_real_cng_persisted_nonexportable_key_signs_and_verifies() {
    let k = Key::new();
    let p = k.public_identity().unwrap();
    let reopened = windows::WindowsIdentity::slot(k.0.slot_id());
    assert_eq!(
        reopened.public_identity().unwrap().device_id(),
        p.device_id()
    );
    let sig = k
        .sign_domain_separated(Domain::Registry, b"synthetic public metadata")
        .unwrap();
    verify(&p, Domain::Registry, b"synthetic public metadata", &sig).unwrap();
    assert!(verify(
        &p,
        Domain::OriginalEvent,
        b"synthetic public metadata",
        &sig
    )
    .is_err());
    assert!(verify(&p, Domain::Registry, b"changed", &sig).is_err());
    assert!(k.private_export_refused());
    assert!(matches!(
        k.create_identity(),
        Err(SecurityError::AlreadyExists)
    ));
}
#[test]
fn e03_missing_platform_key_and_live_authentication_fail_closed() {
    let k = UnavailableIdentity;
    assert_eq!(k.key_availability(), KeyAvailability::Unavailable);
    assert!(k.create_identity().is_err());
    assert!(k.sign_domain_separated(Domain::Registry, b"x").is_err());
    assert_eq!(live_pairing(), Err(SecurityError::N1AuditPending));
    assert_eq!(
        ClosedLan.dial("192.168.1.2:7431"),
        Err(SecurityError::N1AuditPending)
    );
    assert_eq!(
        ClosedLan.listen("0.0.0.0:7431"),
        Err(SecurityError::Invalid)
    );
    assert_eq!(selected_route(), Err(SecurityError::N7PolicyPending));
    let hello = PeerHello {
        network: Uuid::new_v4(),
        session: Uuid::new_v4(),
        local: Uuid::new_v4(),
        peer: Uuid::new_v4(),
        epoch: 1,
    };
    assert!(ClosedTrust.verify(&hello).is_err());
}
#[cfg(windows)]
#[test]
fn e03_deleted_key_cannot_silently_regenerate() {
    let k = Key::new();
    let p = k.public_identity().unwrap();
    k.invalidate_identity().unwrap();
    assert_eq!(k.key_availability(), KeyAvailability::Missing);
    assert!(k.public_identity().is_err());
    assert!(k.sign_domain_separated(Domain::Registry, b"x").is_err());
    assert_eq!(p.sec1().len(), 65);
}
#[cfg(windows)]
#[test]
fn e04_e05_signed_registry_replay_fork_wrong_network_and_forged_revoke() {
    let (_dir, o) = owner();
    let a = Key::new();
    let b = Key::new();
    let attacker = Key::new();
    let r = NetworkRegistry::candidate(o.store()).unwrap();
    let root = r.create_network(&a.0).unwrap();
    let grant = r
        .next(
            Action::Grant {
                device: b.public_identity().unwrap(),
                role: Role::Member,
                capabilities: 3,
                enrollment: Uuid::new_v4(),
                expires: 1000,
                origins: vec![],
            },
            &a.0,
        )
        .unwrap();
    r.apply(&grant).unwrap();
    let state = f::state(o.store());
    assert_eq!(r.apply(&grant), Err(SecurityError::Replay));
    let mut fork = r
        .next(
            Action::Revoke {
                device: b.public_identity().unwrap(),
            },
            &a.0,
        )
        .unwrap();
    fork.body.previous = [8; 32];
    fork = SignedUpdate::sign(fork.body, &a.0).unwrap();
    assert_eq!(r.apply(&fork), Err(SecurityError::Fork));
    let mut wrong = fork.clone();
    wrong.body.network = Uuid::new_v4();
    assert_eq!(r.apply(&wrong), Err(SecurityError::Trust));
    let forged = SignedUpdate::sign(
        r.next(
            Action::Revoke {
                device: b.public_identity().unwrap(),
            },
            &a.0,
        )
        .unwrap()
        .body,
        &attacker.0,
    )
    .unwrap();
    assert!(r.apply(&forged).is_err());
    assert_eq!(f::state(o.store()), state);
    assert_eq!(root.network, r.root().unwrap().network);
}
#[test]
fn e07_rejection_sampling_preserves_zeroes_and_rejects_the_biased_tail() {
    let mut draws = [u32::MAX, 42].into_iter();
    let code = SecretCode::with_random(|b| {
        b.copy_from_slice(&draws.next().unwrap().to_le_bytes());
        Ok(())
    })
    .unwrap();
    assert_eq!(code.inspect(), b"000042");
    assert!(SecretCode::with_random(|b| {
        b.copy_from_slice(&u32::MAX.to_le_bytes());
        Ok(())
    })
    .is_err());
    let code = SecretCode::generate().unwrap();
    assert!(code.inspect().iter().all(u8::is_ascii_digit));
}
#[cfg(windows)]
#[test]
fn e08_e09_attempt_reservation_is_durable_global_and_restart_does_not_reset_it() {
    let (dir, o) = owner();
    let r = NetworkRegistry::candidate(o.store()).unwrap();
    let boot = r.startup().unwrap();
    let mut ch = r.issue_fixture(boot, 10).unwrap();
    for _ in 0..5 {
        let ticket = r.reserve(&mut ch, 11).unwrap();
        assert!(r.reserve(&mut ch, 11).is_err());
        r.failed(&ticket).unwrap();
    }
    assert!(r.reserve(&mut ch, 11).is_err());
    r.cancel(&mut ch).unwrap();
    let boot = r.startup().unwrap();
    assert!(r.issue_fixture(boot, 12).is_err());
    assert_eq!(
        o.store().query_i64_for_test("SELECT attempts FROM e_abuse"),
        5
    );
    drop(r);
    drop(o);
    let reopened = NativeRuntime::acquire(&dir.path().canonicalize().unwrap()).unwrap();
    let r = NetworkRegistry::candidate(reopened.store()).unwrap();
    let boot = r.startup().unwrap();
    assert!(matches!(
        r.issue_fixture(boot, 13),
        Err(SecurityError::Locked)
    ));
    assert_eq!(
        reopened
            .store()
            .query_i64_for_test("SELECT attempts FROM e_abuse"),
        5
    );
}
#[cfg(windows)]
#[test]
fn e09_expiry_backward_clock_and_cancel_erase_code_without_clearing_abuse() {
    let (_dir, o) = owner();
    let r = NetworkRegistry::candidate(o.store()).unwrap();
    let boot = r.startup().unwrap();
    let mut ch = r.issue_fixture(boot, 10).unwrap();
    assert!(matches!(
        r.reserve(&mut ch, 130),
        Err(SecurityError::Expired)
    ));
    r.cancel(&mut ch).unwrap();
    assert!(ch.code.is_none());
    let mut ch = r.issue_fixture(boot, 140).unwrap();
    assert!(r.reserve(&mut ch, 139).is_err());
    r.cancel(&mut ch).unwrap();
}
#[cfg(windows)]
#[test]
fn e11_e12_metadata_approval_exact_key_transcript_and_same_key_receipt_resume() {
    let (_dir, o) = owner();
    let a = Key::new();
    let b = Key::new();
    let wrong = Key::new();
    let r = NetworkRegistry::candidate(o.store()).unwrap();
    let root = r.create_network(&a.0).unwrap();
    let boot = r.startup().unwrap();
    let mut ch = r.issue_fixture(boot, 10).unwrap();
    let t = transcript(&root, &ch, &b);
    let ticket = r.reserve(&mut ch, 11).unwrap();
    let hash = r
        .record_proof(&mut ch, CandidateProof::fixture(ticket, t), 12)
        .unwrap();
    assert!(ch.code.is_none());
    let before = f::state(o.store());
    assert!(r
        .approve(ch.id, &wrong.public_identity().unwrap(), hash, 13, &a.0)
        .is_err());
    assert!(r
        .approve(ch.id, &b.public_identity().unwrap(), [9; 32], 13, &a.0)
        .is_err());
    assert_eq!(f::state(o.store()), before);
    let p = b.public_identity().unwrap();
    let grant = r.approve(ch.id, &p, hash, 13, &a.0).unwrap();
    assert!(r.approve(ch.id, &p, hash, 13, &a.0).is_err());
    let channel = [4; 32];
    let request = canonical(&(root.network, ch.id, &p, channel)).unwrap();
    let sig = b
        .sign_domain_separated(Domain::EnrollmentReceipt, &request)
        .unwrap();
    assert_eq!(r.resume(ch.id, &p, 14, channel, &sig).unwrap(), grant);
    assert!(r.resume(ch.id, &p, 14, [5; 32], &sig).is_err());
    assert!(r
        .resume(ch.id, &wrong.public_identity().unwrap(), 14, channel, &sig)
        .is_err());
    let receipt = canonical(&(
        root.network,
        ch.id,
        &p,
        sha2::Sha256::digest(&grant).to_vec(),
        channel,
    ))
    .unwrap();
    let sig = b
        .sign_domain_separated(Domain::EnrollmentReceipt, &receipt)
        .unwrap();
    r.receipt(ch.id, &p, &grant, 14, channel, &sig).unwrap();
    assert!(r.receipt(ch.id, &p, &grant, 5000, channel, &sig).is_err());
    assert_eq!(
        o.store()
            .query_i64_for_test("SELECT count(*) FROM e_updates"),
        2
    );
}
#[test]
fn e17_bounded_record_rejects_oversize_before_reading_payload() {
    struct Header {
        header: std::io::Cursor<Vec<u8>>,
        reads: usize,
    }
    impl std::io::Read for Header {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            self.reads += 1;
            if self.reads > 1 {
                panic!("oversized payload read")
            }
            self.header.read(b)
        }
    }
    let mut h = Header {
        header: std::io::Cursor::new([b"AE01".as_slice(), &u32::MAX.to_be_bytes()].concat()),
        reads: 0,
    };
    assert_eq!(
        read_record(&mut h, &Cancellation::default()),
        Err(SecurityError::Limit)
    );
    assert!(read_record(
        &mut std::io::Cursor::new(b"AE01\0\0\0\x03x"),
        &Cancellation::default()
    )
    .is_err());
}
#[test]
fn e18_metadata_resource_leases_release_and_cancellation_refuses_work() {
    let pool = Arc::new(ResourcePool::default());
    let cancel = Cancellation::default();
    let a = pool.acquire(LeaseKind::Handshake, &cancel).unwrap();
    let b = pool.acquire(LeaseKind::Handshake, &cancel).unwrap();
    assert!(pool.acquire(LeaseKind::Handshake, &cancel).is_err());
    drop(a);
    drop(b);
    let s = pool.acquire(LeaseKind::Session, &cancel).unwrap();
    assert!(pool.acquire(LeaseKind::Session, &cancel).is_err());
    drop(s);
    cancel.cancel();
    assert!(pool.acquire(LeaseKind::Session, &cancel).is_err());
    assert_eq!(
        read_record(&mut std::io::Cursor::new([]), &cancel),
        Err(SecurityError::Cancelled)
    );
}
#[test]
fn e19_e22_registry_uses_runtime_owner_and_production_remains_closed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let a = NativeRuntime::acquire(&root).unwrap();
    let b = NativeRuntime::acquire(&root).unwrap();
    assert!(Arc::ptr_eq(&a, &b));
    assert!(matches!(
        NetworkRegistry::candidate(a.store()),
        Err(SecurityError::ActivationPending)
    ));
    assert!(matches!(
        CandidateSyncStore::production(a.store()),
        Err(Error::ActivationPending)
    ));
    assert_eq!(crate::storage::migrations::SCHEMA_VERSION, 9);
    assert_eq!(enrollment_store::schema_version(a.store()), 9);
}
#[test]
fn e09_memory_deadline_cannot_extend_the_durable_challenge() {
    let (_dir, o) = owner();
    let r = NetworkRegistry::candidate(o.store()).unwrap();
    let boot = r.startup().unwrap();
    let mut ch = r.issue_fixture(boot, 10).unwrap();
    ch.started = 130;
    assert!(r.reserve(&mut ch, 130).is_err());
}
#[test]
fn e08_parallel_addresses_share_one_durable_reservation() {
    let (_dir, o) = owner();
    let r = NetworkRegistry::candidate(o.store()).unwrap();
    let boot = r.startup().unwrap();
    let mut challenge = r.issue_fixture(boot, 10).unwrap();
    let id = challenge.id;
    let barrier = std::sync::Barrier::new(5);
    let attempts = std::thread::scope(|scope| {
        let mut tasks = vec![];
        for _ in 0..5 {
            let shared = &barrier;
            let registry = &r;
            tasks.push(scope.spawn(move || {
                let mut request = Challenge {
                    id,
                    started: 10,
                    boot,
                    code: None,
                };
                shared.wait();
                registry.reserve(&mut request, 11)
            }));
        }
        tasks
            .into_iter()
            .filter_map(|t| t.join().unwrap().ok())
            .collect::<Vec<_>>()
    });
    assert_eq!(attempts.len(), 1);
    assert_eq!(
        o.store().query_i64_for_test("SELECT attempts FROM e_abuse"),
        1
    );
    r.failed(&attempts[0]).unwrap();
    r.cancel(&mut challenge).unwrap();
    assert_eq!(
        o.store().query_i64_for_test("SELECT attempts FROM e_abuse"),
        1
    );
}
#[cfg(windows)]
#[test]
fn e01_e03_owned_identity_anchor_reopens_and_never_replaces_a_lost_key() {
    use crate::storage::device_identity_store::OwnedDeviceIdentity;
    let (dir, o) = owner();
    let identity = OwnedDeviceIdentity::initialize(o.store()).unwrap();
    let p = identity.public_identity().unwrap();
    let slot = identity.slot_for_test();
    drop(identity);
    drop(o);
    let o = NativeRuntime::acquire(&dir.path().canonicalize().unwrap()).unwrap();
    let identity = OwnedDeviceIdentity::reopen(o.store()).unwrap();
    assert_eq!(
        identity.public_identity().unwrap().device_id(),
        p.device_id()
    );
    assert!(OwnedDeviceIdentity::initialize(o.store()).is_err());
    windows::WindowsIdentity::slot(slot)
        .invalidate_identity()
        .unwrap();
    assert!(OwnedDeviceIdentity::reopen(o.store()).is_err());
    assert!(identity
        .sign_domain_separated(Domain::Registry, b"must fail after loss")
        .is_err());
    assert!(OwnedDeviceIdentity::initialize(o.store()).is_err());
    assert!(identity.invalidate_identity().is_err());
    assert!(OwnedDeviceIdentity::reopen(o.store()).is_err());
}
#[cfg(windows)]
#[test]
fn e05_revocation_tombstone_blocks_old_key_and_expired_membership() {
    let (_dir, o) = owner();
    let a = Key::new();
    let b = Key::new();
    let r = NetworkRegistry::candidate(o.store()).unwrap();
    r.create_network(&a.0).unwrap();
    let grant = r
        .next(
            Action::Grant {
                device: b.public_identity().unwrap(),
                role: Role::Member,
                capabilities: 3,
                enrollment: Uuid::new_v4(),
                expires: 20,
                origins: vec![],
            },
            &a.0,
        )
        .unwrap();
    r.apply(&grant).unwrap();
    assert!(r
        .binding(
            a.public_identity().unwrap().peer_id(),
            &b.public_identity().unwrap(),
            20
        )
        .is_err());
    let revoke = r
        .next(
            Action::Revoke {
                device: b.public_identity().unwrap(),
            },
            &a.0,
        )
        .unwrap();
    r.apply(&revoke).unwrap();
    let before = f::state(o.store());
    let mut old_key = grant.body.action.clone();
    if let Action::Grant { enrollment, .. } = &mut old_key {
        *enrollment = Uuid::new_v4();
    }
    let again = r.next(old_key, &a.0).unwrap();
    assert!(r.apply(&again).is_err());
    assert_eq!(f::state(o.store()), before);
    assert_eq!(r.root().unwrap().epoch, 3);
}
#[cfg(windows)]
#[test]
fn e01_published_rfc6979_p256_public_verification_vector() {
    // RFC 6979 A.2.5, SHA-256("sample"). Public point and signature ONLY.
    // CNG nonce generation is NOT claimed to implement RFC 6979.
    fn bytes(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }
    let p = PublicIdentity::from_sec1(bytes(concat!(
        "04",
        "60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6",
        "7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"
    )))
    .unwrap();
    let sig = bytes(concat!(
        "EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716",
        "F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8"
    ));
    windows::verify(&p, &sha2::Sha256::digest(b"sample").into(), &sig).unwrap();
    assert!(windows::verify(&p, &[0; 32], &sig).is_err());
    assert!(PublicIdentity::from_sec1([vec![4], vec![0; 64]].concat()).is_err());
}
#[cfg(windows)]
#[test]
fn e02_public_registry_has_no_private_key_or_code_material_and_survives_reopen() {
    let (dir, o) = owner();
    let a = Key::new();
    let r = NetworkRegistry::candidate(o.store()).unwrap();
    r.create_network(&a.0).unwrap();
    let boot = r.startup().unwrap();
    let mut ch = r.issue_fixture(boot, 1).unwrap();
    r.cancel(&mut ch).unwrap();
    let expected = f::state(o.store());
    drop(r);
    drop(o);
    let o = NativeRuntime::acquire(&dir.path().canonicalize().unwrap()).unwrap();
    assert_eq!(f::state(o.store()), expected);
    let r = NetworkRegistry::candidate(o.store()).unwrap();
    assert_eq!(
        r.root().unwrap().admin.device_id(),
        a.public_identity().unwrap().device_id()
    );
    let schema = include_str!("../../storage/enrollment_candidate.sql");
    for forbidden in ["private_key", "password", "code_hash", "secret", "pake"] {
        assert!(!schema.contains(forbidden));
    }
}
#[cfg(windows)]
#[test]
fn e15_e16_original_author_survives_forwarding_and_receipts_bind_sender_session_and_counter() {
    let (_dir, o) = owner();
    f::upgrade(o.store());
    f::captures(o.store(), &["Synthetic original event"]);
    let network = Uuid::new_v4();
    install_candidate(o.store(), network, Uuid::new_v4(), &[]).unwrap();
    let event = test_events(o.store()).remove(0);
    let a = Key::new();
    let forwarder = Key::new();
    let signed = SignedOriginal::sign(network, &event, &a.0).unwrap();
    signed
        .verify(network, &event, &a.public_identity().unwrap())
        .unwrap();
    assert!(signed
        .verify(network, &event, &forwarder.public_identity().unwrap())
        .is_err());
    assert!(signed
        .verify(Uuid::new_v4(), &event, &a.public_identity().unwrap())
        .is_err());
    let context = ReceiptContext {
        network,
        session: Uuid::new_v4(),
        sender: a.public_identity().unwrap().peer_id(),
        receiver: forwarder.public_identity().unwrap().peer_id(),
        epoch: 1,
        exporter: [1; 32],
    };
    let receipt = SignedReceipt::sign(context.clone(), 0, &event, "applied", &a.0).unwrap();
    let mut wrong = context.clone();
    wrong.session = Uuid::new_v4();
    assert!(ReceiptVerifier::new(wrong)
        .accept(&receipt, &event, &a.public_identity().unwrap())
        .is_err());
    let mut verifier = ReceiptVerifier::new(context);
    assert!(verifier
        .accept(&receipt, &event, &forwarder.public_identity().unwrap())
        .is_err());
    verifier
        .accept(&receipt, &event, &a.public_identity().unwrap())
        .unwrap();
    assert!(verifier
        .accept(&receipt, &event, &a.public_identity().unwrap())
        .is_err());
}
struct Clock;
impl SyncClock for Clock {
    fn now(&self) -> u64 {
        10
    }
}
#[cfg(windows)]
#[test]
fn e06_durable_revocation_and_real_import_share_one_owner_commit_order() {
    for revoke_first in [true, false] {
        let (_target_dir, target) = owner();
        f::upgrade(target.store());
        let (_source_dir, source) = owner();
        f::upgrade(source.store());
        f::captures(source.store(), &["Synthetic authorized original"]);
        let admin = Key::new();
        let remote = Key::new();
        let r = NetworkRegistry::candidate(target.store()).unwrap();
        let network = r.create_network(&admin.0).unwrap().network;
        install_candidate(
            source.store(),
            network,
            remote.public_identity().unwrap().peer_id(),
            &[],
        )
        .unwrap();
        let event = test_events(source.store()).remove(0);
        let origins = BTreeSet::from([event.identity.origin]);
        let grant = r
            .next(
                Action::Grant {
                    device: remote.public_identity().unwrap(),
                    role: Role::Member,
                    capabilities: 3,
                    enrollment: Uuid::new_v4(),
                    expires: 1000,
                    origins: origins.iter().copied().collect(),
                },
                &admin.0,
            )
            .unwrap();
        r.apply(&grant).unwrap();
        assert_eq!(
            r.original_author(event.identity.origin)
                .unwrap()
                .device_id(),
            remote.public_identity().unwrap().device_id()
        );
        let epoch = r.root().unwrap().epoch;
        let local = admin.public_identity().unwrap().peer_id();
        let peer = remote.public_identity().unwrap().peer_id();
        install_candidate(target.store(), network, local, &[(peer, epoch)]).unwrap();
        f::install_g3(target.store());
        crate::storage::sync_store::grant_test_origins(target.store(), peer, &origins);
        target
            .store()
            .execute_sql_for_test("UPDATE import_origin_permissions SET epoch=2");
        let hello = PeerHello {
            network,
            session: Uuid::new_v4(),
            local,
            peer,
            epoch,
        };
        let session = TestTrust {
            hello: hello.clone(),
            expires: 100,
            origins,
        }
        .verify(&hello)
        .unwrap()
        .with_registry(
            r.binding(local, &remote.public_identity().unwrap(), 10)
                .unwrap(),
        );
        let revoke = r
            .next(
                Action::Revoke {
                    device: remote.public_identity().unwrap(),
                },
                &admin.0,
            )
            .unwrap();
        let cancel = Cancellation::default();
        let db = CandidateSyncStore::synthetic(target.store());
        if revoke_first {
            std::thread::scope(|scope| {
                scope.spawn(|| r.apply(&revoke).unwrap()).join().unwrap();
            });
            assert!(db
                .retain(
                    &session,
                    ValidatedEvent::parse(event.clone()).unwrap(),
                    &Clock,
                    &cancel
                )
                .is_err());
            assert_eq!(
                target
                    .store()
                    .query_i64_for_test("SELECT count(*) FROM captures"),
                0
            );
        } else {
            let receipt = std::thread::scope(|scope| {
                let (ready_tx, ready_rx) = std::sync::mpsc::channel();
                let (waiting_tx, waiting_rx) = std::sync::mpsc::channel();
                let registry = &r;
                let update = &revoke;
                let thread = scope.spawn(move || {
                    ready_rx.recv().unwrap();
                    waiting_tx.send(()).unwrap();
                    registry.apply(update).unwrap();
                });
                let receipt = enrollment_store::import_with_barrier(
                    target.store(),
                    &session,
                    ValidatedEvent::parse(event.clone()).unwrap(),
                    &Clock,
                    &cancel,
                    || {
                        ready_tx.send(()).unwrap();
                        waiting_rx.recv().unwrap();
                    },
                )
                .unwrap();
                thread.join().unwrap();
                receipt
            });
            assert_eq!(receipt.outcome, Outcome::CleanlyApplied);
            assert_eq!(
                target
                    .store()
                    .query_i64_for_test("SELECT count(*) FROM captures"),
                1
            );
            assert!(db.summary(&session, &Clock, &cancel).is_err());
        }
        assert!(r
            .binding(local, &remote.public_identity().unwrap(), 10)
            .is_err());
        f::clean(target.store());
        let expected = f::state(target.store());
        drop(db);
        drop(r);
        let root = target.data_root().to_path_buf();
        drop(target);
        let reopened =
            f::reopen(crate::storage::ownership::DataRootOwnership::try_acquire(&root).unwrap());
        assert_eq!(f::state(&reopened), expected);
        f::clean(&reopened);
    }
}
