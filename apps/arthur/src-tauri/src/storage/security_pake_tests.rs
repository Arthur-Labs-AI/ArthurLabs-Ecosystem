//! Actual opaque-ke + actual native TLS/keys, disposable existing owners only.
#![cfg(any(windows, target_os = "android"))]
use super::{
    device_identity_store::OwnedDeviceIdentity,
    enrollment_store::NetworkRegistry,
    security_tls_tests::{context, Fixture},
};
use crate::sync::security::{
    composition::{self, lab, Endpoint},
    enrollment::*,
    pake_qualification::{Fault, TransientVerifier},
    tls::CertificateRole,
    tls_lab, Result, SecurityError as E,
};
use std::sync::{Arc, Barrier};
use uuid::Uuid;
use zeroize::Zeroizing;
fn require(value: bool) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(E::State)
    }
}
fn pair(a: &Fixture, b: &Fixture, reverse: bool) -> Result<tls_lab::LabChannel> {
    if reverse {
        tls_lab::pair(
            b.key(CertificateRole::Server)?,
            a.key(CertificateRole::Client)?,
        )
    } else {
        tls_lab::pair(
            a.key(CertificateRole::Server)?,
            b.key(CertificateRole::Client)?,
        )
    }
}
fn qualified(
    a: &Fixture,
    b: &Fixture,
    ch: &Challenge,
    ticket: &Attempt,
    network: Uuid,
    reverse: bool,
) -> Result<lab::QualifiedPending> {
    let channel = pair(a, b, reverse)?;
    let mut ctx = context(a, b);
    ctx.enrollment = ch.id;
    ctx.reservation = ticket.nonce;
    ctx.network = network;
    if reverse {
        ctx.tls_server = Endpoint::Joiner;
    }
    let binding = lab::binding(&ctx, &channel)?;
    let code = ch.code.as_ref().ok_or(E::State)?.inspect();
    let verifier = TransientVerifier::new(code, binding.enrollment, binding.code_issuer)?;
    let proof = verifier.authenticate(code, binding, binding, Fault::None)?;
    let pending = lab::Attempt::new(ctx.clone()).finish_qualified(&ctx, &channel, &proof)?;
    require(pending.grant() == Err(E::N1AuditPending))?;
    Ok(pending)
}
fn count(owner: &crate::runtime::NativeRuntime, query: &str) -> Result<i64> {
    let n = owner
        .store()
        .connection
        .lock()
        .map_err(|_| E::Storage)?
        .query_row(query, [], |r| r.get(0))
        .map_err(|_| E::Storage)?;
    Ok(n)
}
pub(crate) fn attempts_and_wrong_code() -> Result<()> {
    let a = Fixture::new()?;
    let b = Fixture::new()?;
    let owner = a.owner();
    let registry = NetworkRegistry::candidate(owner.store())?;
    let admin = OwnedDeviceIdentity::reopen(owner.store())?;
    let root = registry.create_network(&admin)?;
    let boot = registry.startup()?;
    let mut ch = registry.issue_fixture(boot, 10)?;
    let channel = pair(&a, &b, false)?;
    let mut ctx = context(&a, &b);
    ctx.enrollment = ch.id;
    ctx.network = root.network;
    let binding = lab::binding(&ctx, &channel)?;
    for index in 0..5 {
        let ticket = registry.reserve(&mut ch, 11 + index)?;
        let code = Zeroizing::new(*ch.code.as_ref().ok_or(E::State)?.inspect());
        let verifier = TransientVerifier::new(&code, binding.enrollment, binding.code_issuer)?;
        let mut wrong = Zeroizing::new(*code);
        wrong[5] = b'0' + (wrong[5] - b'0' + 1) % 10;
        require(
            verifier
                .authenticate(&wrong, binding, binding, Fault::None)
                .is_err(),
        )?;
        registry.failed(&ticket)?;
        require(registry.failed(&ticket).is_err())?;
    }
    require(matches!(registry.reserve(&mut ch, 17), Err(E::Locked)))?;
    require(ch.code.is_none())?;
    require(count(&owner, "SELECT attempts FROM e_abuse") == Ok(5))?;
    let boot = registry.startup()?;
    require(matches!(registry.issue_fixture(boot, 20), Err(E::Locked)))?;
    require(count(&owner, "SELECT count(*) FROM e_members") == Ok(1))
}
pub(crate) fn concurrent_reservations_and_restart() -> Result<()> {
    let a = Fixture::new()?;
    let owner = a.owner();
    let registry = NetworkRegistry::candidate(owner.store())?;
    let boot = registry.startup()?;
    let mut ch = registry.issue_fixture(boot, 10)?;
    let gate = Arc::new(Barrier::new(3));
    let mut workers = Vec::new();
    for _ in 0..2 {
        let owner = owner.clone();
        let gate = gate.clone();
        let id = ch.id;
        workers.push(std::thread::spawn(move || {
            let r = NetworkRegistry::candidate(owner.store())?;
            let mut copy = Challenge {
                id,
                started: 10,
                boot,
                code: None,
            };
            gate.wait();
            r.reserve(&mut copy, 11)
        }));
    }
    gate.wait();
    let mut winner = None;
    for worker in workers {
        if let Ok(ticket) = worker.join().map_err(|_| E::State)? {
            require(winner.is_none())?;
            winner = Some(ticket);
        }
    }
    let ticket = winner.ok_or(E::State)?;
    require(count(&owner, "SELECT attempts FROM e_abuse") == Ok(1))?;
    // An actual PAKE KE1 is generated after reservation and abandoned pre-proof.
    crate::sync::security::pake_qualification::abandon_after_ke1(
        ch.code.as_ref().ok_or(E::State)?.inspect(),
    )?;
    registry.startup()?;
    require(registry.failed(&ticket).is_err())?;
    require(registry.reserve(&mut ch, 12).is_err())?;
    require(
        count(
            &owner,
            "SELECT count(*) FROM e_enrollments WHERE state='cancelled'",
        ) == Ok(1),
    )?;
    require(count(&owner, "SELECT attempts FROM e_abuse") == Ok(1))
}
pub(crate) fn approval_exact_key_consumed_and_atomic() -> Result<()> {
    for reverse in [false, true] {
        let a = Fixture::new()?;
        let b = Fixture::new()?;
        let other = Fixture::new()?;
        let owner = a.owner();
        let registry = NetworkRegistry::candidate(owner.store())?;
        let admin = OwnedDeviceIdentity::reopen(owner.store())?;
        let root = registry.create_network(&admin)?;
        let boot = registry.startup()?;
        let mut ch = registry.issue_fixture(boot, 10)?;
        let ticket = registry.reserve(&mut ch, 11)?;
        let pending = qualified(&a, &b, &ch, &ticket, root.network, reverse)?;
        let hash = registry.record_qualification(&mut ch, ticket, pending, 12)?;
        require(ch.code.is_none())?;
        require(count(&owner, "SELECT count(*) FROM e_members") == Ok(1))?;
        require(
            registry
                .approve(ch.id, &other.public, hash, 13, &admin)
                .is_err(),
        )?;
        require(
            registry
                .approve(ch.id, &b.public, [0; 32], 13, &admin)
                .is_err(),
        )?;
        // Fail AFTER grant application but BEFORE consumed record commit: all rows roll back.
        owner.store().connection.lock().map_err(|_|E::Storage)?.execute_batch("CREATE TEMP TRIGGER e3a2_approval_fault BEFORE UPDATE OF grant_bytes ON e_enrollments BEGIN SELECT RAISE(ABORT,'qualification fault'); END;").map_err(|_|E::Storage)?;
        require(
            registry
                .approve(ch.id, &b.public, hash, 13, &admin)
                .is_err(),
        )?;
        require(count(&owner, "SELECT count(*) FROM e_members") == Ok(1))?;
        require(count(&owner, "SELECT count(*) FROM e_updates") == Ok(1))?;
        owner
            .store()
            .connection
            .lock()
            .map_err(|_| E::Storage)?
            .execute_batch("DROP TRIGGER e3a2_approval_fault")
            .map_err(|_| E::Storage)?;
        registry.approve(ch.id, &b.public, hash, 14, &admin)?;
        require(count(&owner,"SELECT count(*) FROM e_enrollments WHERE state='consumed' AND grant_bytes IS NOT NULL")==Ok(1))?;
        require(count(&owner, "SELECT count(*) FROM e_members") == Ok(2))?;
        require(registry.reserve(&mut ch, 15).is_err())?;
        require(
            registry
                .approve(ch.id, &b.public, hash, 15, &admin)
                .is_err(),
        )?;
    }
    Ok(())
}
pub(crate) fn expiry_and_native_key_loss() -> Result<()> {
    for mode in 0..6 {
        let a = Fixture::new()?;
        let b = Fixture::new()?;
        let owner = a.owner();
        let registry = NetworkRegistry::candidate(owner.store())?;
        let admin = OwnedDeviceIdentity::reopen(owner.store())?;
        let root = registry.create_network(&admin)?;
        let boot = registry.startup()?;
        let mut ch = registry.issue_fixture(boot, 10)?;
        let ticket = registry.reserve(&mut ch, 11)?;
        let pending = qualified(&a, &b, &ch, &ticket, root.network, false)?;
        if mode == 0 {
            require(matches!(
                registry.record_qualification(&mut ch, ticket, pending, 130),
                Err(E::Expired)
            ))?;
            require(ch.code.is_none())?;
        } else if mode == 1 {
            let hash = registry.record_qualification(&mut ch, ticket, pending, 12)?;
            require(matches!(
                registry.approve(ch.id, &b.public, hash, 130, &admin),
                Err(E::Expired)
            ))?;
        } else if mode >= 4 {
            let hash = registry.record_qualification(&mut ch, ticket, pending, 12)?;
            if mode == 4 {
                a.delete_os()?;
            } else {
                owner
                    .store()
                    .connection
                    .lock()
                    .map_err(|_| E::Storage)?
                    .execute("UPDATE e_identity SET key=?1", [b.public.sec1()])
                    .map_err(|_| E::Storage)?;
            }
            require(
                registry
                    .approve(ch.id, &b.public, hash, 13, &admin)
                    .is_err(),
            )?;
        } else {
            if mode == 2 {
                a.delete_os()?;
            } else {
                owner
                    .store()
                    .connection
                    .lock()
                    .map_err(|_| E::Storage)?
                    .execute("UPDATE e_identity SET key=?1", [b.public.sec1()])
                    .map_err(|_| E::Storage)?;
            }
            require(
                registry
                    .record_qualification(&mut ch, ticket, pending, 12)
                    .is_err(),
            )?;
        }
        require(count(&owner, "SELECT count(*) FROM e_members") == Ok(1))?;
        require(count(&owner, "SELECT count(*) FROM e_updates") == Ok(1))?;
    }
    Ok(())
}
pub(crate) fn actual_context_and_initial_pin_substitution() -> Result<()> {
    let a = Fixture::new()?;
    let b = Fixture::new()?;
    let c = Fixture::new()?;
    let first = pair(&a, &b, false)?;
    let second = pair(&a, &b, false)?;
    let expected = context(&a, &b);
    let binding = lab::binding(&expected, &first)?;
    let verifier = TransientVerifier::new(b"123456", binding.enrollment, binding.code_issuer)?;
    let proof = verifier.authenticate(b"123456", binding, binding, Fault::None)?;
    require(matches!(
        first.assurance(),
        tls_lab::LabAssurance::ObservedKeyPossessionOnly
    ))?;
    require(
        verifier
            .authenticate(
                b"123456",
                lab::binding(&expected, &second)?,
                binding,
                Fault::None,
            )
            .is_err(),
    )?;
    require(
        lab::Attempt::new(expected.clone())
            .finish_qualified(&expected, &second, &proof)
            .is_err(),
    )?;
    for mode in 0..8 {
        let mut changed = expected.clone();
        match mode {
            0 => changed.network = Uuid::new_v4(),
            1 => changed.issuer_nonce = [8; 32],
            2 => changed.tls_server = Endpoint::Joiner,
            3 => changed.pake_server = Endpoint::Joiner,
            4 => changed.sponsor = c.public.clone(),
            6 => changed.pake_client = Endpoint::Sponsor,
            7 => changed.reservation = Uuid::new_v4(),
            _ => {
                changed.admin = c.public.device_id();
                changed.admin_key = c.public.clone();
            }
        }
        if mode == 4 || mode == 5 {
            require(changed.digest(first.exporter()) == Err(E::N2PolicyPending))?;
        }
        if let Ok(changed_binding) = lab::binding(&changed, &first) {
            require(
                verifier
                    .authenticate(b"123456", changed_binding, binding, Fault::None)
                    .is_err(),
            )?;
        }
        require(
            lab::Attempt::new(expected.clone())
                .finish_qualified(&changed, &first, &proof)
                .is_err(),
        )?;
    }
    // Initial enrollment has OBSERVED keys, not an authenticated stored peer pin.
    // A MITM's own valid key/handshake gives a different exporter/key context.
    let intercepted = pair(&c, &b, false)?;
    let attacker_context = context(&c, &b);
    let attacker = lab::binding(&attacker_context, &intercepted)?;
    require(
        verifier
            .authenticate(b"123456", attacker, binding, Fault::None)
            .is_err(),
    )?;
    let mut attempt = lab::Attempt::new(expected.clone());
    attempt.finish_qualified(&expected, &first, &proof)?;
    require(matches!(
        attempt.finish_qualified(&expected, &first, &proof),
        Err(E::Replay)
    ))?;
    require(composition::audited_pake_adapter() == Err(E::N1AuditPending))?;
    crate::sync::security::enrollment::live_pairing()
        .err()
        .ok_or(E::State)?;
    Ok(())
}
#[cfg(windows)]
#[test]
fn e3a3_old_confirmation_cannot_use_a_new_reservation() {
    assert!(reservation_substitution().is_ok());
}
pub(crate) fn reservation_substitution() -> Result<()> {
    let a = Fixture::new()?;
    let b = Fixture::new()?;
    let owner = a.owner();
    let registry = NetworkRegistry::candidate(owner.store())?;
    let admin = OwnedDeviceIdentity::reopen(owner.store())?;
    let root = registry.create_network(&admin)?;
    let boot = registry.startup()?;
    let mut ch = registry.issue_fixture(boot, 10)?;
    let first = registry.reserve(&mut ch, 11)?;
    let pending = qualified(&a, &b, &ch, &first, root.network, false)?;
    registry.failed(&first)?;
    let second = registry.reserve(&mut ch, 12)?;
    require(matches!(
        registry.record_qualification(&mut ch, second, pending, 13),
        Err(E::Trust)
    ))?;
    require(count(&owner, "SELECT attempts FROM e_abuse") == Ok(2))?;
    require(
        count(
            &owner,
            "SELECT count(*) FROM e_enrollments WHERE state='approval'",
        ) == Ok(0),
    )?;
    require(count(&owner, "SELECT count(*) FROM e_members") == Ok(1))
}
#[cfg(windows)]
#[test]
fn e3a2_durable_five_wrong_codes() {
    assert!(attempts_and_wrong_code().is_ok());
}
#[cfg(windows)]
#[test]
fn e3a2_concurrent_attempts_and_restart() {
    assert!(concurrent_reservations_and_restart().is_ok());
}
#[cfg(windows)]
#[test]
fn e3a2_exact_human_approval_atomic_grant_and_consumed() {
    assert!(approval_exact_key_consumed_and_atomic().is_ok());
}
#[cfg(windows)]
#[test]
fn e3a2_expiry_native_key_loss_and_substitution() {
    assert!(expiry_and_native_key_loss().is_ok());
}
#[cfg(windows)]
#[test]
fn e3a2_actual_pake_context_roles_and_untrusted_initial_keys() {
    assert!(actual_context_and_initial_pin_substitution().is_ok());
}
