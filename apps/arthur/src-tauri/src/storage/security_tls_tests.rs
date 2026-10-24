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
    pub public: PublicIdentity,
}
impl Fixture {
    pub fn new() -> Result<Self> {
        #[cfg(windows)]
        let root = std::env::temp_dir().join(format!("arthur-e3a-{}", Uuid::new_v4()));
        #[cfg(target_os = "android")]
        let root = crate::sync::security::android::bridge()?.test_directory()?;
        std::fs::create_dir(&root).map_err(|_| E::Storage)?;
        let owner = NativeRuntime::acquire(&root).map_err(|_| E::Storage)?;
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
            owner: Some(owner),
            root,
            slot: Uuid::parse_str(&slot).map_err(|_| E::State)?,
            public,
        })
    }
    pub fn owner(&self) -> Arc<NativeRuntime> {
        self.owner.as_ref().unwrap().clone()
    }
    pub fn key(&self, role: CertificateRole) -> Result<Arc<OwnedTlsKey>> {
        OwnedTlsKey::lab(self.owner(), self.public.clone(), role)
    }
    fn invalidate(&self) -> Result<()> {
        OwnedDeviceIdentity::reopen(self.owner.as_ref().unwrap().store())?.invalidate_identity()
    }
    fn delete_os(&self) -> Result<()> {
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
        let _ = self.delete_os();
        drop(self.owner.take());
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
pub(crate) fn preimage(role: CertificateRole) -> Vec<u8> {
    let mut m = vec![32; 64];
    m.extend_from_slice(role.context());
    m.push(0);
    m.extend_from_slice(&[0xa5; 32]);
    m
}
fn signature(f: &Fixture, role: CertificateRole) -> Result<Vec<u8>> {
    f.key(role)?
        .choose_scheme(&[SignatureScheme::ECDSA_NISTP256_SHA256])
        .ok_or(E::Signature)?
        .sign(&preimage(role))
        .map_err(|_| E::Signature)
}
fn context(a: &Fixture, b: &Fixture) -> Context {
    Context {
        enrollment: Uuid::new_v4(),
        network: Uuid::new_v4(),
        admin: a.public.device_id(),
        issuer: a.public.clone(),
        joiner: b.public.clone(),
        issuer_nonce: [1; 32],
        joiner_nonce: [2; 32],
        suite: composition::SUITE.into(),
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
