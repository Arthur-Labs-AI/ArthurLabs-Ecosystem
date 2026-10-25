//! E3A: REAL WINDOWS CNG / REAL ANDROID Keystore + SYNTHETIC PAKE CONTEXT ONLY.
//! Disposable owners, no sockets, no production credentials or identity.
#![cfg(any(windows, target_os = "android"))]
use crate::{
    runtime::NativeRuntime,
    storage::{device_identity_store::OwnedDeviceIdentity, tls_identity::OwnedTlsKey},
    sync::{
        security::{
            composition::{self, Context},
            identity::*,
            tls::{self, CertificateRole},
            tls_lab, Result, SecurityError as E,
        },
        *,
    },
};
use rustls::{sign::SigningKey, SignatureScheme};
use std::{path::PathBuf, sync::Arc};
use uuid::Uuid;
fn require(value: bool) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(E::State)
    }
}
pub(crate) struct Fixture {
    owner: Option<Arc<NativeRuntime>>,
    root: PathBuf,
    slot: Uuid,
    preserve: bool,
    pub public: PublicIdentity,
}
impl Fixture {
    pub fn new() -> Result<Self> {
        #[cfg(windows)]
        let root = std::env::temp_dir().join(format!("arthur-e3a-{}", Uuid::new_v4()));
        #[cfg(target_os = "android")]
        let root = crate::sync::security::android::bridge()?.test_directory()?;
        Self::at(root, false)
    }
    pub(crate) fn at(root: PathBuf, reopen: bool) -> Result<Self> {
        if !reopen {
            std::fs::create_dir(&root).map_err(|_| E::Storage)?;
        }
        let owner = if reopen {
            NativeRuntime::reopen_candidate_lab(&root)
        } else {
            NativeRuntime::acquire(&root)
        }
        .map_err(|_| E::Storage)?;
        if reopen {
            let public = OwnedDeviceIdentity::reopen(owner.store())?.public_identity()?;
            let slot: String = owner
                .store()
                .connection
                .lock()
                .map_err(|_| E::Storage)?
                .query_row("SELECT slot FROM e_identity", [], |r| r.get(0))
                .map_err(|_| E::Storage)?;
            return Ok(Self {
                owner: Some(owner),
                root,
                slot: Uuid::parse_str(&slot).map_err(|_| E::State)?,
                preserve: false,
                public,
            });
        }
        {
            let c = owner.store().connection.lock().map_err(|_| E::Storage)?;
            c.execute_batch(include_str!("enrollment_candidate.sql"))
                .map_err(|_| E::Storage)?;
            c.execute_batch(include_str!("enrollment_e2.sql"))
                .map_err(|_| E::Storage)?;
        }
        let identity = OwnedDeviceIdentity::initialize(owner.store())?;
        let public = identity.public_identity()?;
        let slot = owner
            .store()
            .connection
            .lock()
            .map_err(|_| E::Storage)?
            .query_row("SELECT slot FROM e_identity", [], |r| r.get::<_, String>(0))
            .map_err(|_| E::Storage)?;
        Ok(Self {
            preserve: false,
            owner: Some(owner),
            root,
            slot: Uuid::parse_str(&slot).map_err(|_| E::State)?,
            public,
        })
    }
    pub(crate) fn preserve_for_restart(&mut self) {
        self.preserve = true;
    }
    pub fn owner(&self) -> Arc<NativeRuntime> {
        self.owner.as_ref().unwrap().clone()
    }
    pub(crate) fn reopen_candidate(&mut self) -> Result<()> {
        let owner = self.owner.take().ok_or(E::State)?;
        if Arc::strong_count(&owner) != 1 {
            self.owner = Some(owner);
            return Err(E::State);
        }
        drop(owner);
        self.owner = Some(NativeRuntime::reopen_candidate_lab(&self.root).map_err(|_| E::Storage)?);
        require(
            OwnedDeviceIdentity::reopen(self.owner.as_ref().unwrap().store())?.public_identity()?
                == self.public,
        )
    }
    pub fn key(&self, role: CertificateRole) -> Result<Arc<OwnedTlsKey>> {
        OwnedTlsKey::lab(self.owner(), self.public.clone(), role)
    }
    fn invalidate(&self) -> Result<()> {
        OwnedDeviceIdentity::reopen(self.owner.as_ref().unwrap().store())?.invalidate_identity()
    }
    pub(crate) fn delete_os(&self) -> Result<()> {
        #[cfg(windows)]
        {
            crate::sync::security::windows::WindowsIdentity::slot(self.slot).invalidate_identity()
        }
        #[cfg(target_os = "android")]
        {
            crate::sync::security::android::AndroidIdentity::slot(self.slot)?.invalidate_identity()
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if !self.preserve {
            let _ = self.delete_os();
        }
        drop(self.owner.take());
        if !self.preserve {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}
pub(crate) fn preimage(role: CertificateRole) -> Vec<u8> {
    let mut m = vec![32; 64];
    m.extend_from_slice(role.context());
    m.push(0);
    m.extend_from_slice(&[0xa5; 32]);
    m
}

pub(crate) fn committed_revocation() -> Result<()> {
    use crate::sync::security::{
        enrollment::{Action, Role},
        transport_candidate::{Expected, Interrupt},
    };
    let a = Fixture::new()?;
    let b = Fixture::new()?;
    let owner = a.owner();
    let identity = OwnedDeviceIdentity::reopen(owner.store())?;
    let registry = crate::storage::enrollment_store::NetworkRegistry::candidate(owner.store())?;
    let root = registry.create_network(&identity)?;
    let grant = registry.next(
        Action::Grant {
            device: b.public.clone(),
            role: Role::Member,
            capabilities: 3,
            enrollment: Uuid::new_v4(),
            expires: 1000,
            origins: vec![Uuid::new_v4()],
        },
        &identity,
    )?;
    registry.apply(&grant)?;
    let stop = Arc::new(Interrupt::default());
    let (_, permit, _) = owner.transport_candidate().admit_loopback_lab(
        Expected {
            network: root.network,
            peer: b.public.peer_id(),
        },
        &stop,
    )?;
    let other_stop = Arc::new(Interrupt::default());
    let (_, other_permit, _) = owner.transport_candidate().admit_loopback_lab(
        Expected {
            network: root.network,
            peer: Uuid::new_v4(),
        },
        &other_stop,
    )?;
    let revoke = registry.next(
        Action::Revoke {
            device: b.public.clone(),
        },
        &identity,
    )?;
    // A rolled-back signed update cannot publish revocation or cancel work.
    owner.store().connection.lock().map_err(|_|E::Storage)?.execute_batch(
        "CREATE TRIGGER r3_abort BEFORE INSERT ON e_updates BEGIN SELECT RAISE(ABORT,'fixture'); END;"
    ).map_err(|_|E::Storage)?;
    require(registry.apply(&revoke).is_err())?;
    require(!stop.cancelled())?;
    registry.binding(a.public.peer_id(), &b.public, 10)?;
    owner
        .store()
        .connection
        .lock()
        .map_err(|_| E::Storage)?
        .execute_batch("DROP TRIGGER r3_abort")
        .map_err(|_| E::Storage)?;
    registry.apply(&revoke)?;
    require(stop.cancelled() && !other_stop.cancelled())?;
    require(registry.binding(a.public.peer_id(), &b.public, 10).is_err())?;
    drop(permit);
    drop(other_permit);
    Ok(())
}
#[cfg(test)]
#[test]
fn r3_committed_registry_revocation_cancels_existing_owner_permit() {
    committed_revocation().unwrap();
}
fn signature(f: &Fixture, role: CertificateRole) -> Result<Vec<u8>> {
    f.key(role)?
        .choose_scheme(&[SignatureScheme::ECDSA_NISTP256_SHA256])
        .ok_or(E::Signature)?
        .sign(&preimage(role))
        .map_err(|_| E::Signature)
}
pub(crate) fn context(a: &Fixture, b: &Fixture) -> Context {
    Context {
        enrollment: Uuid::new_v4(),
        reservation: Uuid::new_v4(),
        network: Uuid::new_v4(),
        admin: a.public.device_id(),
        admin_key: a.public.clone(),
        sponsor: a.public.clone(),
        issuer: a.public.clone(),
        joiner: b.public.clone(),
        issuer_nonce: [1; 32],
        joiner_nonce: [2; 32],
        suite: composition::SUITE.into(),
        tls_server: composition::Endpoint::Sponsor,
        pake_server: composition::Endpoint::Sponsor,
        pake_client: composition::Endpoint::Joiner,
    }
}
pub(crate) fn native_signatures() -> Result<()> {
    let a = Fixture::new()?;
    let b = Fixture::new()?;
    for role in [CertificateRole::Server, CertificateRole::Client] {
        let message = preimage(role);
        let sig = signature(&a, role)?;
        tls::verify(&a.public, role, &message, &sig)?;
        require(tls::verify(&b.public, role, &message, &sig).is_err())?;
        let mut changed = message.clone();
        let last = changed.len() - 1;
        changed[last] ^= 1;
        require(tls::verify(&a.public, role, &changed, &sig).is_err())?;
        require(tls::verify(&a.public, role, &message, &[0; 64]).is_err())?;
        require(verify(&a.public, Domain::Registry, &message, &sig).is_err())?;
        let app = OwnedDeviceIdentity::reopen(a.owner.as_ref().unwrap().store())?
            .sign_domain_separated(Domain::Registry, &message)?;
        require(tls::verify(&a.public, role, &message, &tls::p1363_to_der(&app)?).is_err())?;
    }
    Ok(())
}
pub(crate) fn scheme_input() -> Result<()> {
    let f = Fixture::new()?;
    let key = f.key(CertificateRole::Server)?;
    for scheme in [
        SignatureScheme::RSA_PSS_SHA256,
        SignatureScheme::ED25519,
        SignatureScheme::ECDSA_NISTP384_SHA384,
        SignatureScheme::Unknown(0xffff),
    ] {
        require(key.choose_scheme(&[scheme]).is_none())?;
    }
    require(key.choose_scheme(&[]).is_none())?;
    let signer = key
        .choose_scheme(&[SignatureScheme::ECDSA_NISTP256_SHA256])
        .ok_or(E::Signature)?;
    for bad in [
        vec![],
        vec![0; 130],
        vec![32; 1024 * 1024],
        preimage(CertificateRole::Client),
    ] {
        require(signer.sign(&bad).is_err())?;
    }
    let mut bad = preimage(CertificateRole::Server);
    bad[97] = 1;
    require(signer.sign(&bad).is_err())?;
    for malformed in [vec![], vec![0; 63], vec![0; 64], vec![0xff; 64]] {
        require(tls::p1363_to_der(&malformed).is_err())?;
    }
    let mut small = [0u8; 64];
    small[31] = 1;
    small[63] = 1;
    require(tls::p1363_to_der(&small)? == vec![0x30, 6, 2, 1, 1, 2, 1, 1])?;
    Ok(())
}

pub(crate) fn tls_hash_inputs() -> Result<()> {
    let f = Fixture::new()?;
    for role in [CertificateRole::Server, CertificateRole::Client] {
        let signer = f
            .key(role)?
            .choose_scheme(&[SignatureScheme::ECDSA_NISTP256_SHA256])
            .ok_or(E::Signature)?;
        for size in [31, 32, 33, 47, 48, 49] {
            let mut message = preimage(role);
            message.truncate(98);
            message.resize(98 + size, 0x5a);
            let signature = signer.sign(&message);
            if size == 32 || size == 48 {
                tls::verify(
                    &f.public,
                    role,
                    &message,
                    &signature.map_err(|_| E::Signature)?,
                )?;
            } else {
                require(signature.is_err())?;
            }
        }
    }
    Ok(())
}
#[cfg(windows)]
#[test]
fn e3a2_tls_sha256_sha384_transcript_inputs() {
    assert!(tls_hash_inputs().is_ok());
}
pub(crate) fn lifecycle() -> Result<()> {
    for mode in 0..4 {
        let mut f = Fixture::new()?;
        let key = f.key(CertificateRole::Server)?;
        let signer = key
            .choose_scheme(&[SignatureScheme::ECDSA_NISTP256_SHA256])
            .ok_or(E::Signature)?;
        if mode == 0 {
            f.invalidate()?;
        } else if mode == 1 {
            f.delete_os()?;
        } else if mode == 2 {
            f.owner
                .as_ref()
                .unwrap()
                .store()
                .connection
                .lock()
                .map_err(|_| E::Storage)?
                .execute("UPDATE e_identity SET state='creating'", [])
                .map_err(|_| E::Storage)?;
        } else {
            let other = Fixture::new()?;
            f.owner
                .as_ref()
                .unwrap()
                .store()
                .connection
                .lock()
                .map_err(|_| E::Storage)?
                .execute("UPDATE e_identity SET key=?1", [other.public.sec1()])
                .map_err(|_| E::Storage)?;
        }
        require(signer.sign(&preimage(CertificateRole::Server)).is_err())?;
        drop(signer);
        drop(key);
        drop(f.owner.take());
        let reopened = NativeRuntime::acquire(&f.root).map_err(|_| E::Storage)?;
        require(OwnedDeviceIdentity::reopen(reopened.store()).is_err())?;
        require(OwnedDeviceIdentity::initialize(reopened.store()).is_err())?;
        require(
            OwnedTlsKey::lab(reopened.clone(), f.public.clone(), CertificateRole::Server).is_err(),
        )?;
        f.owner = Some(reopened);
    }
    Ok(())
}
pub(crate) fn mutual_tls() -> Result<()> {
    let a = Fixture::new()?;
    let b = Fixture::new()?;
    let first = tls_lab::pair(
        a.key(CertificateRole::Server)?,
        b.key(CertificateRole::Client)?,
    )?;
    let second = tls_lab::pair(
        a.key(CertificateRole::Server)?,
        b.key(CertificateRole::Client)?,
    )?;
    require(first.exporter() != second.exporter())?;
    require(
        tls_lab::pair_with_pins(
            a.key(CertificateRole::Server)?,
            b.key(CertificateRole::Client)?,
            &b.public,
            &b.public,
        )
        .is_err(),
    )?;
    require(
        tls_lab::pair_with_pins(
            a.key(CertificateRole::Server)?,
            b.key(CertificateRole::Client)?,
            &a.public,
            &a.public,
        )
        .is_err(),
    )?;
    require(
        tls_lab::pair(
            a.key(CertificateRole::Client)?,
            b.key(CertificateRole::Client)?,
        )
        .is_err(),
    )?;
    require(
        OwnedTlsKey::production(a.owner(), a.public.clone(), CertificateRole::Server).is_err(),
    )?;
    let h = PeerHello {
        network: Uuid::new_v4(),
        session: Uuid::new_v4(),
        local: a.public.peer_id(),
        peer: b.public.peer_id(),
        epoch: 1,
    };
    require(ClosedTrust.verify(&h).is_err())?;
    require(
        crate::storage::signed_import::SignedImportStore::production(
            a.owner.as_ref().unwrap().store(),
        )
        .is_err(),
    )?;
    require(
        super::enrollment_store::NetworkRegistry::candidate(a.owner.as_ref().unwrap().store())
            .is_ok(),
    )?;
    require(
        crate::sync::security::transport::ClosedLan
            .listen("127.0.0.1:443")
            .is_err(),
    )?;
    let version = a
        .owner
        .as_ref()
        .unwrap()
        .store()
        .connection
        .lock()
        .map_err(|_| E::Storage)?
        .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
        .map_err(|_| E::Storage)?;
    require(version == 9)
}
pub(crate) fn composition_checks() -> Result<()> {
    use composition::lab::{Attempt, SyntheticPakeConfirmation};
    let a = Fixture::new()?;
    let b = Fixture::new()?;
    let c = Fixture::new()?;
    let channel = tls_lab::pair(
        a.key(CertificateRole::Server)?,
        b.key(CertificateRole::Client)?,
    )?;
    let second = tls_lab::pair(
        a.key(CertificateRole::Server)?,
        b.key(CertificateRole::Client)?,
    )?;
    let expected = context(&a, &b);
    let digest = expected.digest(channel.exporter())?;
    let confirmation = SyntheticPakeConfirmation::fixture(digest, digest);
    let mut attempt = Attempt::new(expected.clone());
    require(
        attempt
            .finish(&expected, &channel, &confirmation)?
            .grant()
            .is_err(),
    )?;
    require(matches!(
        attempt.finish(&expected, &channel, &confirmation),
        Err(E::Replay)
    ))?;
    require(
        Attempt::new(expected.clone())
            .finish(&expected, &second, &confirmation)
            .is_err(),
    )?;
    require(
        Attempt::new(expected.clone())
            .finish(
                &expected,
                &channel,
                &SyntheticPakeConfirmation::fixture(digest, [0; 32]),
            )
            .is_err(),
    )?;
    for mode in 0..10 {
        let mut changed = expected.clone();
        match mode {
            0 => changed.enrollment = Uuid::new_v4(),
            1 => changed.network = Uuid::new_v4(),
            2 => changed.admin = c.public.device_id(),
            3 => changed.issuer = c.public.clone(),
            4 => changed.joiner = c.public.clone(),
            5 => changed.suite = "downgrade".into(),
            6 => changed.issuer_nonce = [3; 32],
            7 => changed.joiner_nonce = [4; 32],
            8 => std::mem::swap(&mut changed.issuer, &mut changed.joiner),
            _ => {
                changed.issuer_nonce = expected.joiner_nonce;
                changed.joiner_nonce = expected.issuer_nonce;
            }
        }
        require(
            Attempt::new(expected.clone())
                .finish(&changed, &channel, &confirmation)
                .is_err(),
        )?;
    }
    require(composition::audited_pake_adapter() == Err(E::N1AuditPending))?;
    Ok(())
}
#[cfg(windows)]
#[test]
fn e3a_01_native_certificate_verify_and_application_separation() {
    assert!(native_signatures().is_ok());
}
#[cfg(windows)]
#[test]
fn e3a_02_scheme_role_malformed_input_and_der_bounds() {
    assert!(scheme_input().is_ok());
}
#[cfg(windows)]
#[test]
fn e3a_03_key_loss_substitution_invalidation_and_recovery() {
    assert!(lifecycle().is_ok());
}
#[cfg(windows)]
#[test]
fn e3a_04_real_mutual_tls13_memory_handshake_and_closed_production() {
    assert!(mutual_tls().is_ok());
}
#[cfg(windows)]
#[test]
fn e3a_05_composition_replay_downgrade_uks_and_channel_binding() {
    assert!(composition_checks().is_ok());
}

pub(crate) fn reverse_tls_roles() -> Result<()> {
    use composition::lab::{Attempt, SyntheticPakeConfirmation};
    let sponsor = Fixture::new()?;
    let joiner = Fixture::new()?;
    let channel = tls_lab::pair(
        joiner.key(CertificateRole::Server)?,
        sponsor.key(CertificateRole::Client)?,
    )?;
    let mut expected = context(&sponsor, &joiner);
    expected.tls_server = composition::Endpoint::Joiner;
    let digest = expected.digest(channel.exporter())?;
    Attempt::new(expected.clone()).finish(
        &expected,
        &channel,
        &SyntheticPakeConfirmation::fixture(digest, digest),
    )?;
    Ok(())
}
#[cfg(windows)]
#[test]
fn e3a2_reverse_tls_roles_do_not_change_enrollment_authority() {
    assert!(reverse_tls_roles().is_ok());
}

#[cfg(windows)]
#[test]
fn e3a_06_public_cng_tls_fixture_for_android() {
    let f = Fixture::new().unwrap();
    let m = preimage(CertificateRole::Server);
    let sig = signature(&f, CertificateRole::Server).unwrap();
    if let Some(path) = std::env::var_os("ARTHUR_E3_CNG_TLS_FIXTURE") {
        fn hex(bytes: &[u8]) -> String {
            bytes.iter().map(|b| format!("{b:02x}")).collect()
        }
        let fixture=format!("# PUBLIC ONLY, REAL WINDOWS CNG\nproducer=WINDOWS_CNG_TLS13\npublic={}\nmessage={}\nsignature={}\n",hex(f.public.sec1()),hex(&m),hex(&sig));
        std::fs::write(path, fixture).unwrap();
    }
    tls::verify(&f.public, CertificateRole::Server, &m, &sig).unwrap();
}
#[cfg(windows)]
#[test]
#[ignore = "Requires a public-only Android Keystore TLS fixture from actual instrumentation"]
fn e3a_07_actual_android_tls_signature_verifies_on_windows() {
    let path =
        std::env::var_os("ARTHUR_E3_ANDROID_TLS_FIXTURE").expect("actual Android fixture required");
    let text = std::fs::read_to_string(path).unwrap();
    let f: std::collections::BTreeMap<_, _> =
        text.lines().filter_map(|l| l.split_once('=')).collect();
    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }
    assert_eq!(f["producer"], "ANDROID_KEYSTORE_TLS13");
    let public = PublicIdentity::from_sec1(hex(f["public"])).unwrap();
    tls::verify(
        &public,
        CertificateRole::Server,
        &hex(f["message"]),
        &hex(f["signature"]),
    )
    .unwrap();
}

// Real signed registry COMMIT must wake the existing encrypted socket owner.
pub(crate) fn revocation_tls() -> Result<()> {
    use crate::sync::security::{
        enrollment::{Action, Role},
        native_io_lab,
        tls_socket_lab::Pair,
    };
    std::panic::catch_unwind(|| {
        native_io_lab::execute(async {
            for mode in 0..4 {
                let mut a = Fixture::new().unwrap();
                let b = Fixture::new().unwrap();
                {
                    let owner = a.owner();
                    let id = OwnedDeviceIdentity::reopen(owner.store()).unwrap();
                    let registry =
                        crate::storage::enrollment_store::NetworkRegistry::candidate(owner.store())
                            .unwrap();
                    let root = registry.create_network(&id).unwrap();
                    let grant = registry
                        .next(
                            Action::Grant {
                                device: b.public.clone(),
                                role: Role::Member,
                                capabilities: 3,
                                enrollment: Uuid::new_v4(),
                                expires: 1000,
                                origins: vec![Uuid::new_v4()],
                            },
                            &id,
                        )
                        .unwrap();
                    registry.apply(&grant).unwrap();
                    let revoke = registry
                        .next(
                            Action::Revoke {
                                device: b.public.clone(),
                            },
                            &id,
                        )
                        .unwrap();
                    let session = Uuid::new_v4();
                    let ah = PeerHello {
                        network: root.network,
                        session,
                        local: a.public.peer_id(),
                        peer: b.public.peer_id(),
                        epoch: 1,
                    };
                    let bh = PeerHello {
                        local: ah.peer,
                        peer: ah.local,
                        ..ah.clone()
                    };
                    if mode == 0 {
                        registry.apply(&revoke).unwrap();
                    }
                    let pair = Pair::connect_checked(
                        a.key(CertificateRole::Server).unwrap(),
                        b.key(CertificateRole::Client).unwrap(),
                        [ah.clone(), bh],
                        [&a.public, &b.public],
                        None,
                        || {
                            if mode == 1 {
                                registry.apply(&revoke).unwrap();
                            }
                            registry
                                .binding(a.public.peer_id(), &b.public, 10)
                                .map(|_| ())
                                .map_err(|_| Error::Trust)
                        },
                    )
                    .await;
                    if mode < 2 {
                        assert!(matches!(pair, Err(Error::Trust)));
                        assert_eq!(owner.transport_candidate().loopback_lab_active(), 0);
                    } else {
                        let (wire, mut transport, _) = pair.unwrap();
                        if mode == 3 {
                            transport
                                .send(Message {
                                    network: root.network,
                                    session,
                                    from: ah.local,
                                    to: ah.peer,
                                    payload: Payload::Hello {
                                        version: 1,
                                        required: FEATURES,
                                        supported: FEATURES,
                                        profile: "qualification".into(),
                                    },
                                })
                                .unwrap();
                            wire.transfer().await.unwrap();
                        }
                        let (failure, ()) = native_io_lab::both(wire.wait_for_failure(), async {
                            tokio::task::yield_now().await;
                            registry.apply(&revoke).unwrap();
                        })
                        .await;
                        assert_eq!(failure, Err(Error::Cancelled));
                        wire.assert_closed();
                    }
                    assert!(registry.binding(a.public.peer_id(), &b.public, 10).is_err());
                }
                // Close the actual v9 owner, then reopen the same revoked registry.
                drop(a.owner.take());
                a.owner = Some(NativeRuntime::acquire(&a.root).unwrap());
                let owner = a.owner();
                assert!(
                    crate::storage::enrollment_store::NetworkRegistry::candidate(owner.store())
                        .unwrap()
                        .binding(a.public.peer_id(), &b.public, 10)
                        .is_err()
                );
            }
        })
    })
    .map_err(|_| E::State)
}
#[cfg(test)]
#[test]
fn r3_signed_revocation_before_after_tls_during_io_and_owner_restart() {
    revocation_tls().unwrap();
}
