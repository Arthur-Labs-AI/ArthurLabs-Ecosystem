//! Public RFC9807 Appendix C data from opaque-ke v4.0.1, never native key material.
//! Identity KSF is REQUIRED by these vectors; enrollment exercises use Argon2.
use super::{Result, E};
use opaque_ke::*;
use rand::{CryptoRng, RngCore};
use serde_json::Value;

struct VectorSuite;
impl CipherSuite for VectorSuite {
    type OprfCs = Ristretto255;
    type KeyExchange = TripleDh<Ristretto255, sha2::Sha512>;
    type Ksf = ksf::Identity;
}
// Deliberately insecure deterministic bytes, private to official-vector execution.
// Cycling matches upstream's published vector runner for scalar sampling.
struct VectorRng {
    bytes: Vec<u8>,
    position: usize,
}
impl VectorRng {
    fn new(bytes: Vec<u8>) -> Self {
        assert!(!bytes.is_empty());
        Self { bytes, position: 0 }
    }
}
impl CryptoRng for VectorRng {}
impl RngCore for VectorRng {
    fn next_u32(&mut self) -> u32 {
        let mut b = [0; 4];
        self.fill_bytes(&mut b);
        u32::from_le_bytes(b)
    }
    fn next_u64(&mut self) -> u64 {
        let mut b = [0; 8];
        self.fill_bytes(&mut b);
        u64::from_le_bytes(b)
    }
    fn fill_bytes(&mut self, out: &mut [u8]) {
        for b in out {
            *b = self.bytes[self.position % self.bytes.len()];
            self.position += 1;
        }
    }
    fn try_fill_bytes(&mut self, out: &mut [u8]) -> std::result::Result<(), rand::Error> {
        self.fill_bytes(out);
        Ok(())
    }
}
fn bytes(v: &Value, key: &str) -> Vec<u8> {
    let s = v[key].as_str().expect("official field");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("official hex"))
        .collect()
}
fn optional(v: &Value, key: &str) -> Option<Vec<u8>> {
    v.get(key).map(|_| bytes(v, key))
}
// Upstream unit tests inject the published 32-byte scalar via cfg(test).
// The public release API samples a 64-byte wide scalar: zero-extend the same
// canonical scalar for these PUBLIC vectors, with no scalar arithmetic here.
fn blind_entropy(v: &Value, key: &str) -> Vec<u8> {
    let mut b = bytes(v, key);
    b.resize(64, 0);
    b
}
#[track_caller]
fn equal(a: &[u8], b: &[u8]) -> Result<()> {
    if a == b {
        Ok(())
    } else {
        panic!(
            "official vector mismatch: actual={} expected={}",
            a.len(),
            b.len()
        )
    }
}
fn vector(index: usize) -> Result<()> {
    let vectors: Vec<Value> =
        serde_json::from_str(include_str!("qualification/rfc9807-ristretto.json"))
            .map_err(|_| E::Invalid)?;
    let v = &vectors[index];
    let password = optional(v, "password");
    let id = bytes(v, "credential_identifier");
    let client_id = optional(v, "client_identity");
    let server_id = optional(v, "server_identity");
    let ids = Identifiers {
        client: client_id.as_deref(),
        server: server_id.as_deref(),
    };
    let context = bytes(v, "Context");
    let setup = ServerSetup::<VectorSuite>::deserialize(
        &[
            bytes(v, "oprf_seed"),
            bytes(v, "server_private_key"),
            bytes(v, "client_public_key"),
        ]
        .concat(),
    )
    .map_err(|_| E::Invalid)?;
    let record = if let Some(pw) = password.as_ref() {
        let registration = ClientRegistration::<VectorSuite>::start(
            &mut VectorRng::new(blind_entropy(v, "blind_registration")),
            pw,
        )
        .map_err(|_| E::Trust)?;
        equal(
            &registration.message.serialize(),
            &bytes(v, "registration_request"),
        )?;
        let response = ServerRegistration::<VectorSuite>::start(&setup, registration.message, &id)
            .map_err(|_| E::Trust)?;
        equal(
            &response.message.serialize(),
            &bytes(v, "registration_response"),
        )?;
        let upload = registration
            .state
            .finish(
                &mut VectorRng::new(bytes(v, "envelope_nonce")),
                pw,
                response.message,
                ClientRegistrationFinishParameters::new(ids, None),
            )
            .map_err(|_| E::Trust)?;
        equal(
            &upload.message.serialize(),
            &bytes(v, "registration_upload"),
        )?;
        equal(&upload.export_key, &bytes(v, "export_key"))?;
        Some(ServerRegistration::finish(upload.message))
    } else {
        None
    };
    let login = if let Some(pw) = password.as_ref() {
        let login = ClientLogin::<VectorSuite>::start(
            &mut VectorRng::new(
                [
                    blind_entropy(v, "blind_login"),
                    bytes(v, "client_keyshare_seed"),
                    bytes(v, "client_nonce"),
                ]
                .concat(),
            ),
            pw,
        )
        .map_err(|_| E::Trust)?;
        equal(&login.message.serialize(), &bytes(v, "KE1"))?;
        Some(login)
    } else {
        None
    };
    let parameters = ServerLoginParameters {
        context: Some(&context),
        identifiers: ids,
    };
    let server = ServerLogin::<VectorSuite>::start(
        &mut VectorRng::new(
            [
                optional(v, "masking_key").unwrap_or(vec![0; 64]),
                bytes(v, "masking_nonce"),
                bytes(v, "server_keyshare_seed"),
                bytes(v, "server_nonce"),
            ]
            .concat(),
        ),
        &setup,
        record,
        CredentialRequest::deserialize(&bytes(v, "KE1")).map_err(|_| E::Invalid)?,
        &id,
        parameters.clone(),
    )
    .map_err(|_| E::Trust)?;
    equal(&server.message.serialize(), &bytes(v, "KE2"))?;
    if let Some(login) = login {
        let finish = login
            .state
            .finish(
                &mut rand::rngs::OsRng,
                password.as_ref().unwrap(),
                server.message,
                ClientLoginFinishParameters::new(Some(&context), ids, None),
            )
            .map_err(|_| E::Trust)?;
        equal(&finish.message.serialize(), &bytes(v, "KE3"))?;
        equal(&finish.session_key, &bytes(v, "session_key"))?;
        equal(&finish.export_key, &bytes(v, "export_key"))?;
        let server = server
            .state
            .finish(finish.message, parameters)
            .map_err(|_| E::Trust)?;
        equal(&server.session_key, &bytes(v, "session_key"))?;
    }
    Ok(())
}
pub(crate) fn official_vectors() -> Result<()> {
    for index in 0..3 {
        vector(index)?;
    }
    Ok(())
}
#[cfg(test)]
#[test]
fn e3a2_rfc9807_c_1_1() {
    assert!(vector(0).is_ok());
}
#[cfg(test)]
#[test]
fn e3a2_rfc9807_c_1_2() {
    assert!(vector(1).is_ok());
}
#[cfg(test)]
#[test]
fn e3a2_rfc9807_c_2_1() {
    assert!(vector(2).is_ok());
}
