//! E3A2 qualification ONLY, never an approved PAKE adapter.
//! Both endpoints run here: comparing session keys is a test oracle, not a
//! message or evidence available to either remote endpoint. Client completion
//! alone cannot establish delivery/acceptance of KE3. There is no live adapter.
//! Architecture review before implementation:
//! 1. Truth: opaque-ke owns PAKE state; CaptureStore owns all attempt/approval rows.
//! 2. Owner: no SQL/network in this harness; one existing owner reserves before work.
//! 3. Direction: owner test adapter -> qualification -> upstream library, never UI.
//! 4. Contract: public context/identifiers in, unforgeable lab confirmation out.
//! 5. Failure: malformed/incorrect/partial confirmations produce categorical refusal.
//! 6. Lifecycle: transient verifier/setup live in memory; upstream states zeroize.
//! 7. Seams: OS CSPRNG for exercises; finite public RFC randomness only for vectors.
//! 8. Compatibility: no DDL/migration; cfg test or explicit Android debug feature.
//! 9. Observation: no Debug/Serialize for wrappers, code/verifier/session not logged.
//! 10. Security: qualification cannot manufacture production trust or grant membership.
#[cfg(all(not(test), not(debug_assertions)))]
compile_error!("PAKE qualification is forbidden outside debug instrumentation");

use super::{canonical, Result, SecurityError as E};
use opaque_ke::{
    CipherSuite, ClientLogin, ClientLoginFinishParameters, ClientRegistration,
    ClientRegistrationFinishParameters, CredentialFinalization, CredentialRequest,
    CredentialResponse, Identifiers, ServerLogin, ServerLoginParameters, ServerRegistration,
    ServerSetup,
};
use rand::rngs::OsRng;
use sha2::{Digest, Sha256, Sha512};
use zeroize::{Zeroize, Zeroizing};

struct EnrollmentSuite;
impl CipherSuite for EnrollmentSuite {
    type OprfCs = opaque_ke::Ristretto255;
    type KeyExchange = opaque_ke::TripleDh<opaque_ke::Ristretto255, Sha512>;
    type Ksf = argon2::Argon2<'static>;
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct Binding {
    pub context: [u8; 32],
    pub enrollment: [u8; 16],
    pub code_issuer: [u8; 32],
}
pub(crate) struct ConfirmedExchange {
    binding: Binding,
    transcript: [u8; 32],
}
impl ConfirmedExchange {
    pub fn matches(&self, expected: Binding) -> bool {
        self.binding == expected
    }
    pub fn approval_digest(&self) -> Result<[u8; 32]> {
        // Public metadata digest, NOT PAKE key derivation or custom confirmation.
        let bytes = canonical(&(
            "arthur-e3a2-pake-confirmed",
            self.binding.context,
            self.transcript,
        ))?;
        Ok(Sha256::digest(bytes).into())
    }
}
pub(crate) enum Fault {
    None,
    Response,
    Finalization,
    ReplayedFinalization,
}
pub(crate) fn abandon_after_ke1(code: &[u8; 6]) -> Result<()> {
    let started = ClientLogin::<EnrollmentSuite>::start(&mut OsRng, code).map_err(|_| E::Trust)?;
    if started.message.serialize().is_empty() {
        return Err(E::State);
    }
    // Drop the upstream state without KE2/KE3 or a confirmation constructor.
    Ok(())
}
pub(crate) struct TransientVerifier {
    setup: ServerSetup<EnrollmentSuite>,
    record: ServerRegistration<EnrollmentSuite>,
    enrollment: [u8; 16],
    issuer: [u8; 32],
}
impl TransientVerifier {
    pub fn new(code: &[u8; 6], enrollment: [u8; 16], issuer: [u8; 32]) -> Result<Self> {
        if !code.iter().all(u8::is_ascii_digit) {
            return Err(E::Invalid);
        }
        let mut rng = OsRng;
        let setup = ServerSetup::<EnrollmentSuite>::new(&mut rng);
        // Local, confidential registration at the code issuer. No registration
        // messages or password file leave this scope or enter SQLite.
        // The joiner's native key may not be known yet: it is bound by login context.
        let client =
            ClientRegistration::<EnrollmentSuite>::start(&mut rng, code).map_err(|_| E::Trust)?;
        let server =
            ServerRegistration::<EnrollmentSuite>::start(&setup, client.message, &enrollment)
                .map_err(|_| E::Trust)?;
        let mut finish = client
            .state
            .finish(
                &mut rng,
                code,
                server.message,
                ClientRegistrationFinishParameters::new(
                    Identifiers {
                        client: None,
                        server: Some(&issuer),
                    },
                    None,
                ),
            )
            .map_err(|_| E::Trust)?;
        finish.export_key.zeroize();
        let record = ServerRegistration::finish(finish.message);
        Ok(Self {
            setup,
            record,
            enrollment,
            issuer,
        })
    }
    pub fn authenticate(
        &self,
        code: &[u8; 6],
        client_binding: Binding,
        server_binding: Binding,
        fault: Fault,
    ) -> Result<ConfirmedExchange> {
        if client_binding.enrollment != self.enrollment
            || server_binding.enrollment != self.enrollment
            || client_binding.code_issuer != self.issuer
            || server_binding.code_issuer != self.issuer
        {
            return Err(E::Trust);
        }
        let mut rng = OsRng;
        let client = ClientLogin::<EnrollmentSuite>::start(&mut rng, code).map_err(|_| E::Trust)?;
        let ke1 = client.message.serialize().to_vec();
        let parameters = ServerLoginParameters {
            context: Some(&server_binding.context),
            identifiers: Identifiers {
                client: None,
                server: Some(&self.issuer),
            },
        };
        let server = ServerLogin::start(
            &mut rng,
            &self.setup,
            Some(self.record.clone()),
            CredentialRequest::deserialize(&ke1).map_err(|_| E::Trust)?,
            &self.enrollment,
            parameters.clone(),
        )
        .map_err(|_| E::Trust)?;
        let mut ke2 = server.message.serialize().to_vec();
        if matches!(fault, Fault::Response) {
            let end = ke2.len() - 1;
            ke2[end] ^= 1;
        }
        // Client must validate server confirmation BEFORE producing KE3.
        let mut client = client
            .state
            .finish(
                &mut rng,
                code,
                CredentialResponse::deserialize(&ke2).map_err(|_| E::Trust)?,
                ClientLoginFinishParameters::new(
                    Some(&client_binding.context),
                    Identifiers {
                        client: None,
                        server: Some(&self.issuer),
                    },
                    None,
                ),
            )
            .map_err(|_| E::Trust)?;
        let mut ke3 = client.message.serialize().to_vec();
        let client_session = Zeroizing::new(client.session_key.clone());
        client.session_key.zeroize();
        client.export_key.zeroize();
        if matches!(fault, Fault::Finalization) {
            let end = ke3.len() - 1;
            ke3[end] ^= 1;
        }
        if matches!(fault, Fault::ReplayedFinalization) {
            let fresh =
                ClientLogin::<EnrollmentSuite>::start(&mut rng, code).map_err(|_| E::Trust)?;
            let fresh_server = ServerLogin::start(
                &mut rng,
                &self.setup,
                Some(self.record.clone()),
                fresh.message,
                &self.enrollment,
                parameters.clone(),
            )
            .map_err(|_| E::Trust)?;
            // A genuine KE3 from another run must fail against a fresh server state.
            return match fresh_server.state.finish(
                CredentialFinalization::deserialize(&ke3).map_err(|_| E::Trust)?,
                parameters,
            ) {
                Err(_) => Err(E::Replay),
                Ok(_) => Err(E::State),
            };
        }
        let mut server = server
            .state
            .finish(
                CredentialFinalization::deserialize(&ke3).map_err(|_| E::Trust)?,
                parameters,
            )
            .map_err(|_| E::Trust)?;
        let equal = *client_session == server.session_key;
        server.session_key.zeroize();
        if !equal || client_binding != server_binding {
            return Err(E::Trust);
        }
        let transcript = Sha256::digest(canonical(&(ke1, ke2, ke3))?).into();
        Ok(ConfirmedExchange {
            binding: client_binding,
            transcript,
        })
    }
}

pub(crate) fn negative_cases() -> Result<()> {
    let code = *b"123456";
    let binding = Binding {
        context: [3; 32],
        enrollment: [4; 16],
        code_issuer: [5; 32],
    };
    let verifier = TransientVerifier::new(&code, binding.enrollment, binding.code_issuer)?;
    verifier.authenticate(&code, binding, binding, Fault::None)?;
    if verifier
        .authenticate(b"123457", binding, binding, Fault::None)
        .is_ok()
    {
        return Err(E::State);
    }
    for fault in [Fault::Response, Fault::Finalization] {
        if verifier
            .authenticate(&code, binding, binding, fault)
            .is_ok()
        {
            return Err(E::State);
        }
    }
    if !matches!(
        verifier.authenticate(&code, binding, binding, Fault::ReplayedFinalization),
        Err(E::Replay)
    ) {
        return Err(E::State);
    }
    let mut changed = binding;
    changed.context[0] ^= 1;
    if verifier
        .authenticate(&code, changed, binding, Fault::None)
        .is_ok()
    {
        return Err(E::State);
    }
    Ok(())
}

#[cfg(test)]
#[test]
fn e3a2_actual_opaque_argon2_wrong_code_confirmations_and_replay() {
    assert!(negative_cases().is_ok());
}

#[path = "qualification_vectors.rs"]
mod vectors;
#[cfg(target_os = "android")]
pub(crate) use vectors::official_vectors;
