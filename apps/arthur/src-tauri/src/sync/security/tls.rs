//! E3A architecture answers:
//! 1. Truth: OS key + existing durable identity anchor; TLS library owns transcript.
//! 2. Ownership: existing CaptureStore serializes signing/invalidation, no second owner.
//! 3. Direction: storage adapter -> pure TLS contract -> platform signer; no UI/wire.
//! 4. Contract: TLS13 CertificateVerify preimage, P256/SHA256, canonical DER signature.
//! 5. Failure: wrong scheme/role/input/key/state refuses without fallback or regeneration.
//! 6. Lifecycle: owned callback retains runtime; each use reopens and checks exact key.
//! 7. Seams: memory-only rustls mutual RPK lab and real disposable CNG/Keystore identities.
//! 8. Migration: none; E2B domains/formats and all production migrations stay frozen.
//! 9. Observation: categorical errors; keys/transcripts/OS exception text never Debug/logged.
//! 10. Security: native possession is not PAKE/membership; no release session constructor.
use super::{identity::PublicIdentity, Result, SecurityError as E};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum CertificateRole {
    Server,
    Client,
}
impl CertificateRole {
    pub fn context(self) -> &'static [u8] {
        match self {
            Self::Server => b"TLS 1.3, server CertificateVerify",
            Self::Client => b"TLS 1.3, client CertificateVerify",
        }
    }
    pub fn id(self) -> i32 {
        match self {
            Self::Server => 0,
            Self::Client => 1,
        }
    }
}
pub(crate) fn validate_message(role: CertificateRole, message: &[u8]) -> Result<()> {
    let prefix = 64 + role.context().len();
    if !matches!(message.len(), 130 | 146)
        || message[..64] != [0x20; 64]
        || &message[64..prefix] != role.context()
        || message[prefix] != 0
    {
        return Err(E::Invalid);
    }
    Ok(())
}
pub(crate) trait NativeTls13 {
    // Message is the full RFC8446 4.4.3 preimage, NOT an application-domain digest.
    fn sign_tls13(&self, role: CertificateRole, message: &[u8]) -> Result<Vec<u8>>;
}
pub(crate) fn verify(
    public: &PublicIdentity,
    role: CertificateRole,
    message: &[u8],
    der: &[u8],
) -> Result<()> {
    validate_message(role, message)?;
    if !(8..=72).contains(&der.len()) {
        return Err(E::Signature);
    }
    ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_ASN1, public.sec1())
        .verify(message, der)
        .map_err(|_| E::Signature)
}
pub(crate) fn spki(public: &PublicIdentity) -> Vec<u8> {
    // RFC5480 id-ecPublicKey + prime256v1 + uncompressed SEC1 BIT STRING.
    let mut encoded = vec![
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
        0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    ];
    encoded.extend_from_slice(public.sec1());
    encoded
}
pub(crate) fn p1363_to_der(signature: &[u8]) -> Result<Vec<u8>> {
    const ORDER: [u8; 32] = [
        0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63,
        0x25, 0x51,
    ];
    if signature.len() != 64 {
        return Err(E::Signature);
    }
    let mut body = Vec::with_capacity(70);
    for scalar in signature.chunks_exact(32) {
        if scalar.iter().all(|b| *b == 0) || scalar >= ORDER.as_slice() {
            return Err(E::Signature);
        }
        let start = scalar.iter().position(|b| *b != 0).ok_or(E::Signature)?;
        let scalar = &scalar[start..];
        let padding = usize::from(scalar[0] & 0x80 != 0);
        body.extend_from_slice(&[2, (scalar.len() + padding) as u8]);
        if padding == 1 {
            body.push(0);
        }
        body.extend_from_slice(scalar);
    }
    let mut der = vec![0x30, body.len() as u8];
    der.extend_from_slice(&body);
    Ok(der)
}
