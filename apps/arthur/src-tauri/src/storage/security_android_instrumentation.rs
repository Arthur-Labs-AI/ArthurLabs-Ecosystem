//! REAL ANDROID instrumentation only; never a frontend API or release feature.
#[cfg(not(debug_assertions))]
compile_error!("android-identity-tests is forbidden in release builds");
use crate::sync::security::{
    android::{self, AndroidIdentity},
    identity::*,
    Result, SecurityError as E,
};
use crate::{runtime::NativeRuntime, storage::device_identity_store::OwnedDeviceIdentity};
use jni::{
    objects::JClass,
    sys::{jboolean, jint},
    JNIEnv,
};
use std::sync::{Arc, Barrier};
use uuid::Uuid;

fn require(value: bool) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(E::State)
    }
}
struct Key(AndroidIdentity);
impl Key {
    fn new() -> Result<Self> {
        Ok(Self(AndroidIdentity::slot(Uuid::new_v4())?))
    }
}
impl Drop for Key {
    fn drop(&mut self) {
        let _ = self.0.invalidate_identity();
    }
}
fn disposable(work: impl FnOnce(&Arc<NativeRuntime>) -> Result<()>) -> Result<()> {
    let root = android::bridge()?.test_directory()?;
    std::fs::create_dir(&root).map_err(|_| E::Storage)?;
    let outcome = (|| {
        let owner = NativeRuntime::acquire(&root).map_err(|_| E::Storage)?;
        // Explicit disposable fixture installation only. No production migration.
        owner
            .store()
            .connection
            .lock()
            .map_err(|_| E::Storage)?
            .execute_batch(include_str!("enrollment_candidate.sql"))
            .map_err(|_| E::Storage)?;
        owner
            .store()
            .connection
            .lock()
            .map_err(|_| E::Storage)?
            .execute_batch(include_str!("enrollment_e2.sql"))
            .map_err(|_| E::Storage)?;
        work(&owner)
    })();
    // root is generated here under the dedicated test application's cache only.
    let _ = std::fs::remove_dir_all(root);
    outcome
}
fn scenario(case: jint) -> Result<()> {
    // Even a debug harness refuses the user's production app id/data root.
    android::bridge()?.test_directory()?;
    match case {
        1 => std::thread::spawn(|| {
            // EB01-06/09/14/15/18: native-created thread, no Activity/WebView.
            let key = Key::new()?;
            let public = key.0.create_identity()?;
            require(public.sec1().len() == 65)?;
            require(key.0.public_identity()? == public)?;
            let reopened = AndroidIdentity::slot(key.0.metadata_slot())?;
            require(reopened.public_identity()? == public)?;
            let message = [0, 1, 127, 128, 255, 0];
            let other = Key::new()?;
            let other_public = other.0.create_identity()?;
            for domain in [
                Domain::Registry,
                Domain::EnrollmentReceipt,
                Domain::OriginalEvent,
                Domain::SessionReceipt,
            ] {
                let signature = reopened.sign_domain_separated(domain, &message)?;
                verify(&public, domain, &message, &signature)?;
                require(verify(&public, domain, &[1], &signature).is_err())?;
                require(verify(&other_public, domain, &message, &signature).is_err())?;
                let wrong = match domain {
                    Domain::Registry => Domain::OriginalEvent,
                    _ => Domain::Registry,
                };
                require(verify(&public, wrong, &message, &signature).is_err())?;
                let mut modified = signature;
                modified[0] ^= 1;
                require(verify(&public, domain, &message, &modified).is_err())?;
            }
            require(
                reopened
                    .sign_domain_separated(Domain::Registry, &vec![0; 1024 * 1024 + 1])
                    .is_err(),
            )?;
            require(AndroidIdentity::slot(Uuid::nil()).is_err())?;
            require(PublicIdentity::from_sec1(vec![4; 65]).is_err())?;
            key.0.invalidate_identity()?;
            require(matches!(reopened.public_identity(), Err(E::KeyUnavailable)))?;
            require(
                reopened
                    .sign_domain_separated(Domain::Registry, &message)
                    .is_err(),
            )?;
            // An exception must have been cleared; the next independent call succeeds.
            require(other.0.public_identity()? == other_public)
        })
        .join()
        .map_err(|_| E::State)?,
        2 => disposable(|owner| {
            // EB03/08/10: exact SQL/OS anchor and invalidation of cached handles.
            let identity = OwnedDeviceIdentity::initialize(owner.store())?;
            let cleanup = Key(AndroidIdentity::slot(identity.slot_for_instrumentation())?);
            let public = identity.public_identity()?;
            require(matches!(
                identity.sign_domain_separated(Domain::Registry, &vec![0; 1024 * 1024 + 1]),
                Err(E::Limit)
            ))?;
            let reopened = OwnedDeviceIdentity::reopen(owner.store())?;
            require(reopened.public_identity()? == public)?;
            let wrong = Key::new()?;
            let wrong_public = wrong.0.create_identity()?;
            {
                let c = owner.store().connection.lock().map_err(|_| E::Storage)?;
                c.execute(
                    "UPDATE e_identity SET slot=?1",
                    [wrong.0.metadata_slot().to_string()],
                )
                .map_err(|_| E::Storage)?;
            }
            require(
                reopened
                    .sign_domain_separated(Domain::Registry, b"synthetic")
                    .is_err(),
            )?;
            require(OwnedDeviceIdentity::reopen(owner.store()).is_err())?;
            require(wrong.0.public_identity()? == wrong_public)?;
            {
                let c = owner.store().connection.lock().map_err(|_| E::Storage)?;
                c.execute(
                    "UPDATE e_identity SET slot=?1",
                    [cleanup.0.metadata_slot().to_string()],
                )
                .map_err(|_| E::Storage)?;
            }
            identity.invalidate_identity()?;
            require(
                reopened
                    .sign_domain_separated(Domain::Registry, b"synthetic")
                    .is_err(),
            )?;
            require(OwnedDeviceIdentity::reopen(owner.store()).is_err())?;
            require(OwnedDeviceIdentity::initialize(owner.store()).is_err())
        }),
        3 => disposable(|owner| {
            // EB11: OS create succeeds, SQL publication fails, marker survives.
            owner.store().connection.lock().map_err(|_| E::Storage)?.execute_batch(
                "CREATE TRIGGER e2b_fail_activation BEFORE UPDATE ON e_identity BEGIN SELECT RAISE(ABORT,'fixture'); END;"
            ).map_err(|_| E::Storage)?;
            require(OwnedDeviceIdentity::initialize(owner.store()).is_err())?;
            let slot: String = owner
                .store()
                .connection
                .lock()
                .map_err(|_| E::Storage)?
                .query_row(
                    "SELECT slot FROM e_identity WHERE state='creating'",
                    [],
                    |r| r.get(0),
                )
                .map_err(|_| E::Storage)?;
            let cleanup = Key(AndroidIdentity::slot(
                Uuid::parse_str(&slot).map_err(|_| E::Invalid)?,
            )?);
            let original = cleanup.0.public_identity()?;
            require(OwnedDeviceIdentity::reopen(owner.store()).is_err())?;
            require(OwnedDeviceIdentity::initialize(owner.store()).is_err())?;
            require(cleanup.0.public_identity()? == original)
        }),
        4 => disposable(|owner| {
            // EB11: a marker without an OS key is recovery, never re-creation.
            let slot = Uuid::new_v4();
            owner
                .store()
                .connection
                .lock()
                .map_err(|_| E::Storage)?
                .execute(
                    "INSERT INTO e_identity VALUES(1,?1,NULL,'creating')",
                    [slot.to_string()],
                )
                .map_err(|_| E::Storage)?;
            require(OwnedDeviceIdentity::reopen(owner.store()).is_err())?;
            require(OwnedDeviceIdentity::initialize(owner.store()).is_err())?;
            require(AndroidIdentity::slot(slot)?.public_identity().is_err())
        }),
        5 => disposable(|owner| {
            // EB12: crash after invalidation marker, before OS deletion.
            let identity = OwnedDeviceIdentity::initialize(owner.store())?;
            let cleanup = Key(AndroidIdentity::slot(identity.slot_for_instrumentation())?);
            let public = cleanup.0.public_identity()?;
            owner
                .store()
                .connection
                .lock()
                .map_err(|_| E::Storage)?
                .execute("UPDATE e_identity SET state='invalidated'", [])
                .map_err(|_| E::Storage)?;
            require(cleanup.0.public_identity()? == public)?;
            require(
                identity
                    .sign_domain_separated(Domain::Registry, b"synthetic")
                    .is_err(),
            )?;
            require(OwnedDeviceIdentity::reopen(owner.store()).is_err())?;
            require(OwnedDeviceIdentity::initialize(owner.store()).is_err())
        }),
        6 => disposable(|owner| {
            // EB13: both calls start together; owner lock orders complete sign vs marker.
            let identity = OwnedDeviceIdentity::initialize(owner.store())?;
            let _cleanup = Key(AndroidIdentity::slot(identity.slot_for_instrumentation())?);
            let public = identity.public_identity()?;
            let start = Barrier::new(2);
            std::thread::scope(|scope| -> Result<()> {
                let signing = scope.spawn(|| {
                    start.wait();
                    identity.sign_domain_separated(Domain::Registry, b"synthetic")
                });
                start.wait();
                identity.invalidate_identity()?;
                if let Ok(signature) = signing.join().map_err(|_| E::State)? {
                    verify(&public, Domain::Registry, b"synthetic", &signature)?;
                }
                require(
                    identity
                        .sign_domain_separated(Domain::Registry, b"synthetic")
                        .is_err(),
                )
            })
        }),
        7 => {
            // EB16: independent global refs, explicit close, no stale JNI handle use.
            let isolated = android::bridge()?.isolated()?;
            let key = Key::new()?;
            let public = key.0.create_identity()?;
            isolated.validate(public.sec1())?;
            isolated.close();
            require(isolated.validate(public.sec1()).is_err())?;
            require(key.0.public_identity()? == public)
        }
        8 => {
            // EB17: actual Android implementation verifies committed CNG public fixture.
            let fields: std::collections::BTreeMap<_, _> = include_str!(
                "../../gen/android/app/src/androidTest/assets/identity-cng-public.properties"
            )
            .lines()
            .filter_map(|l| l.split_once('='))
            .collect();
            fn hex(s: &str) -> Vec<u8> {
                (0..s.len())
                    .step_by(2)
                    .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
                    .collect()
            }
            let key = PublicIdentity::from_sec1(hex(fields["public"]))?;
            for (name, domain) in [
                ("Registry", Domain::Registry),
                ("EnrollmentReceipt", Domain::EnrollmentReceipt),
                ("OriginalEvent", Domain::OriginalEvent),
                ("SessionReceipt", Domain::SessionReceipt),
            ] {
                verify(&key, domain, &hex(fields["message"]), &hex(fields[name]))?;
            }
            Ok(())
        }
        9 => disposable(|owner| {
            // EB20: real bridge/key availability cannot mint channel authorization.
            let identity = OwnedDeviceIdentity::initialize(owner.store())?;
            let _cleanup = Key(AndroidIdentity::slot(identity.slot_for_instrumentation())?);
            let peer = identity.public_identity()?.peer_id();
            require(
                crate::sync::TrustVerifier::verify(
                    &crate::sync::ClosedTrust,
                    &crate::sync::PeerHello {
                        network: Uuid::new_v4(),
                        session: Uuid::new_v4(),
                        local: peer,
                        peer,
                        epoch: 1,
                    },
                )
                .is_err(),
            )?;
            require(crate::sync::security::enrollment::live_pairing().is_err())?;
            require(
                crate::sync::security::transport::ClosedLan
                    .dial("192.168.1.2:7431")
                    .is_err(),
            )?;
            require(
                owner
                    .store()
                    .connection
                    .lock()
                    .map_err(|_| E::Storage)?
                    .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .map_err(|_| E::Storage)?
                    == 9,
            )
        }),
        10 => disposable(|owner| {
            // EB09: an active SQL anchor cannot regenerate a missing OS key.
            let identity = OwnedDeviceIdentity::initialize(owner.store())?;
            let cleanup = Key(AndroidIdentity::slot(identity.slot_for_instrumentation())?);
            cleanup.0.invalidate_identity()?;
            require(identity.public_identity().is_err())?;
            require(
                identity
                    .sign_domain_separated(Domain::Registry, b"synthetic")
                    .is_err(),
            )?;
            require(OwnedDeviceIdentity::reopen(owner.store()).is_err())?;
            require(OwnedDeviceIdentity::initialize(owner.store()).is_err())?;
            require(cleanup.0.public_identity().is_err())
        }),
        11 => disposable(|owner| {
            // EB08/15: malformed durable slot and public anchor are refused.
            let identity = OwnedDeviceIdentity::initialize(owner.store())?;
            let cleanup = Key(AndroidIdentity::slot(identity.slot_for_instrumentation())?);
            owner
                .store()
                .connection
                .lock()
                .map_err(|_| E::Storage)?
                .execute(
                    "UPDATE e_identity SET slot=?1",
                    [cleanup.0.metadata_slot().simple().to_string()],
                )
                .map_err(|_| E::Storage)?;
            require(OwnedDeviceIdentity::reopen(owner.store()).is_err())?;
            owner
                .store()
                .connection
                .lock()
                .map_err(|_| E::Storage)?
                .execute(
                    "UPDATE e_identity SET slot=?1,key=zeroblob(65)",
                    [cleanup.0.metadata_slot().to_string()],
                )
                .map_err(|_| E::Storage)?;
            require(OwnedDeviceIdentity::reopen(owner.store()).is_err())?;
            require(
                identity
                    .sign_domain_separated(Domain::Registry, b"synthetic")
                    .is_err(),
            )
        }),
        12 => disposable(|owner| {
            // Real Android registry reconstruction, local OS binding and revocation.
            use crate::sync::security::enrollment::{Action, Role};
            let identity = OwnedDeviceIdentity::initialize(owner.store())?;
            let _cleanup = Key(AndroidIdentity::slot(identity.slot_for_instrumentation())?);
            let peer = Key::new()?;
            let public = peer.0.create_identity()?;
            let local = identity.public_identity()?.peer_id();
            let registry =
                crate::storage::enrollment_store::NetworkRegistry::candidate(owner.store())?;
            registry.create_network(&identity)?;
            let grant = registry.next(
                Action::Grant {
                    device: public.clone(),
                    role: Role::Member,
                    capabilities: 3,
                    enrollment: Uuid::new_v4(),
                    expires: 1000,
                    origins: vec![Uuid::new_v4()],
                },
                &identity,
            )?;
            registry.apply(&grant)?;
            registry.binding(local, &public, 10)?;
            let revoke = registry.next(
                Action::Revoke {
                    device: public.clone(),
                },
                &identity,
            )?;
            registry.apply(&revoke)?;
            require(registry.binding(local, &public, 10).is_err())?;
            identity.invalidate_identity()?;
            require(registry.binding(local, &public, 10).is_err())
        }),
        13 => {
            // EB11/12: actual owner/connection teardown and disk reopen for each marker.
            for mode in 0..3 {
                let root = android::bridge()?.test_directory()?;
                std::fs::create_dir(&root).map_err(|_| E::Storage)?;
                let result = (|| {
                    let cleanup = Key::new()?;
                    let mut original = None;
                    {
                        let owner = NativeRuntime::acquire(&root).map_err(|_| E::Storage)?;
                        let c = owner.store().connection.lock().map_err(|_| E::Storage)?;
                        c.execute_batch(include_str!("enrollment_candidate.sql"))
                            .map_err(|_| E::Storage)?;
                        c.execute(
                            "INSERT INTO e_identity VALUES(1,?1,NULL,'creating')",
                            [cleanup.0.metadata_slot().to_string()],
                        )
                        .map_err(|_| E::Storage)?;
                        drop(c);
                        if mode > 0 {
                            original = Some(cleanup.0.create_identity()?);
                        }
                        if mode == 2 {
                            owner
                                .store()
                                .connection
                                .lock()
                                .map_err(|_| E::Storage)?
                                .execute(
                                    "UPDATE e_identity SET key=?1,state='invalidated'",
                                    [original.as_ref().ok_or(E::State)?.sec1()],
                                )
                                .map_err(|_| E::Storage)?;
                        }
                    }
                    let owner = NativeRuntime::acquire(&root).map_err(|_| E::Storage)?;
                    require(OwnedDeviceIdentity::reopen(owner.store()).is_err())?;
                    require(OwnedDeviceIdentity::initialize(owner.store()).is_err())?;
                    match original {
                        Some(public) => require(cleanup.0.public_identity()? == public),
                        None => require(cleanup.0.public_identity().is_err()),
                    }
                })();
                let _ = std::fs::remove_dir_all(root);
                result?;
            }
            Ok(())
        }
        14 => super::security_tls_tests::native_signatures(),
        15 => super::security_tls_tests::scheme_input(),
        16 => super::security_tls_tests::lifecycle(),
        17 => super::security_tls_tests::mutual_tls(),
        18 => super::security_tls_tests::composition_checks(),
        _ => Err(E::Invalid),
    }
}
#[no_mangle]
pub extern "system" fn Java_dev_kaloyan_arthur_security_NativeIdentityBridgeTest_runScenario(
    env: JNIEnv<'_>,
    _: JClass<'_>,
    case: jint,
) -> jboolean {
    let result = std::panic::catch_unwind(|| scenario(case));
    if env.exception_check().unwrap_or(true) {
        let _ = env.exception_clear();
        return 0;
    }
    u8::from(matches!(result, Ok(Ok(()))))
}

fn restart_tls(owner: Arc<NativeRuntime>, public: PublicIdentity) -> Result<()> {
    use crate::sync::security::tls::{self, CertificateRole};
    let key =
        super::tls_identity::OwnedTlsKey::lab(owner, public.clone(), CertificateRole::Server)?;
    let message = super::security_tls_tests::preimage(CertificateRole::Server);
    let signature = rustls::sign::Signer::sign(key.as_ref(), &message).map_err(|_| E::Signature)?;
    tls::verify(&public, CertificateRole::Server, &message, &signature)
}

// Two explicitly selected instrumentation invocations, separated by force-stop.
// This database exists only beneath the dedicated test application's cache.
fn restart(phase: jint) -> Result<()> {
    let generated = android::bridge()?.test_directory()?;
    let root = generated
        .parent()
        .ok_or(E::State)?
        .join("e2b-process-restart");
    if phase == 1 {
        std::fs::create_dir(&root).map_err(|_| E::Storage)?;
        let owner = NativeRuntime::acquire(&root).map_err(|_| E::Storage)?;
        owner
            .store()
            .connection
            .lock()
            .map_err(|_| E::Storage)?
            .execute_batch(include_str!("enrollment_candidate.sql"))
            .map_err(|_| E::Storage)?;
        let identity = OwnedDeviceIdentity::initialize(owner.store())?;
        let public = identity.public_identity()?;
        let signature = identity.sign_domain_separated(Domain::Registry, b"synthetic restart")?;
        verify(&public, Domain::Registry, b"synthetic restart", &signature)?;
        restart_tls(owner.clone(), public)
    } else if phase == 2 {
        let outcome = (|| {
            let owner = NativeRuntime::acquire(&root).map_err(|_| E::Storage)?;
            let identity = OwnedDeviceIdentity::reopen(owner.store())?;
            let cleanup = Key(AndroidIdentity::slot(identity.slot_for_instrumentation())?);
            let public = identity.public_identity()?;
            let signature =
                identity.sign_domain_separated(Domain::Registry, b"synthetic restart")?;
            verify(&public, Domain::Registry, b"synthetic restart", &signature)?;
            restart_tls(owner.clone(), public)?;
            identity.invalidate_identity()?;
            require(cleanup.0.public_identity().is_err())
        })();
        let _ = std::fs::remove_dir_all(root);
        outcome
    } else {
        Err(E::Invalid)
    }
}
#[no_mangle]
pub extern "system" fn Java_dev_kaloyan_arthur_security_NativeIdentityRestartTest_runPhase(
    env: JNIEnv<'_>,
    _: JClass<'_>,
    phase: jint,
) -> jboolean {
    let result = std::panic::catch_unwind(|| restart(phase));
    if env.exception_check().unwrap_or(true) {
        let _ = env.exception_clear();
        return 0;
    }
    u8::from(matches!(result, Ok(Ok(()))))
}
