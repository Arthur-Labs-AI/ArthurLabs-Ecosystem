//! Dormant rustls callback bound to ONE existing native owner. No TLS/socket factory.
use crate::{
    runtime::NativeRuntime,
    sync::security::{
        identity::PublicIdentity,
        tls::{self, CertificateRole, NativeTls13},
        Result, SecurityError as E,
    },
};
use rustls::{
    sign::{Signer, SigningKey},
    SignatureAlgorithm, SignatureScheme,
};
use std::{fmt, sync::Arc};

#[derive(Clone)]
pub(crate) struct OwnedTlsKey {
    owner: Arc<NativeRuntime>,
    public: PublicIdentity,
    role: CertificateRole,
    spki: Vec<u8>,
}
impl fmt::Debug for OwnedTlsKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("OwnedTlsKey")
    }
}
impl OwnedTlsKey {
    pub fn production(
        _: Arc<NativeRuntime>,
        _: PublicIdentity,
        _: CertificateRole,
    ) -> Result<Arc<Self>> {
        Err(E::ActivationPending)
    }
    #[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
    pub fn lab(
        owner: Arc<NativeRuntime>,
        public: PublicIdentity,
        role: CertificateRole,
    ) -> Result<Arc<Self>> {
        let key = Self {
            owner,
            spki: tls::spki(&public),
            public,
            role,
        };
        key.check()?;
        Ok(Arc::new(key))
    }
    fn check(&self) -> Result<()> {
        #[cfg(any(windows, target_os = "android"))]
        {
            let c = self
                .owner
                .store()
                .connection
                .lock()
                .map_err(|_| E::Storage)?;
            let (_, actual) = super::device_identity_store::bound_key(&c, self.public.peer_id())?;
            if actual != self.public {
                return Err(E::Trust);
            }
            Ok(())
        }
        #[cfg(not(any(windows, target_os = "android")))]
        Err(E::PlatformUnverified)
    }
    pub(crate) fn identity(&self) -> &PublicIdentity {
        &self.public
    }
    fn sign_bound(&self, message: &[u8]) -> Result<Vec<u8>> {
        tls::validate_message(self.role, message)?;
        #[cfg(any(windows, target_os = "android"))]
        {
            let c = self
                .owner
                .store()
                .connection
                .lock()
                .map_err(|_| E::Storage)?;
            let (key, actual) = super::device_identity_store::bound_key(&c, self.public.peer_id())?;
            if actual != self.public {
                return Err(E::Trust);
            }
            let signature = key.sign_tls13(self.role, message)?;
            tls::verify(&self.public, self.role, message, &signature)?;
            Ok(signature)
        }
        #[cfg(not(any(windows, target_os = "android")))]
        Err(E::PlatformUnverified)
    }
}
impl SigningKey for OwnedTlsKey {
    fn choose_scheme(&self, offered: &[SignatureScheme]) -> Option<Box<dyn Signer>> {
        if offered.contains(&SignatureScheme::ECDSA_NISTP256_SHA256) {
            Some(Box::new(self.clone()))
        } else {
            None
        }
    }
    fn public_key(&self) -> Option<rustls::pki_types::SubjectPublicKeyInfoDer<'_>> {
        Some(self.spki.as_slice().into())
    }
    fn algorithm(&self) -> SignatureAlgorithm {
        SignatureAlgorithm::ECDSA
    }
}
impl Signer for OwnedTlsKey {
    fn sign(&self, message: &[u8]) -> std::result::Result<Vec<u8>, rustls::Error> {
        self.sign_bound(message)
            .map_err(|_| rustls::Error::General("native_tls_signing_unavailable".into()))
    }
    fn scheme(&self) -> SignatureScheme {
        SignatureScheme::ECDSA_NISTP256_SHA256
    }
}
