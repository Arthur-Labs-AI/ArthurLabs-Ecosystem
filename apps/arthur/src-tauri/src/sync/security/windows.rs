//! CNG P-256 / SHA-256, public SEC1 points and IEEE P1363 signatures.
//! No private export API. Persisted current-user Microsoft Software KSP keys;
//! hardware isolation, OS-build certification and TLS external signing are NOT claimed.
use super::{identity::*, Result, SecurityError as E};
use std::{ffi::c_void, ptr};
use uuid::Uuid;
#[link(name = "ncrypt")]
extern "system" {
    fn NCryptOpenStorageProvider(out: *mut usize, name: *const u16, flags: u32) -> i32;
    fn NCryptCreatePersistedKey(
        provider: usize,
        out: *mut usize,
        algorithm: *const u16,
        name: *const u16,
        legacy: u32,
        flags: u32,
    ) -> i32;
    fn NCryptOpenKey(
        provider: usize,
        out: *mut usize,
        name: *const u16,
        legacy: u32,
        flags: u32,
    ) -> i32;
    fn NCryptSetProperty(
        key: usize,
        name: *const u16,
        value: *const u8,
        len: u32,
        flags: u32,
    ) -> i32;
    fn NCryptGetProperty(
        key: usize,
        name: *const u16,
        value: *mut u8,
        len: u32,
        written: *mut u32,
        flags: u32,
    ) -> i32;
    fn NCryptFinalizeKey(key: usize, flags: u32) -> i32;
    fn NCryptExportKey(
        key: usize,
        export: usize,
        kind: *const u16,
        params: *const c_void,
        out: *mut u8,
        len: u32,
        written: *mut u32,
        flags: u32,
    ) -> i32;
    fn NCryptSignHash(
        key: usize,
        padding: *const c_void,
        hash: *const u8,
        len: u32,
        out: *mut u8,
        cap: u32,
        written: *mut u32,
        flags: u32,
    ) -> i32;
    fn NCryptFreeObject(key: usize) -> i32;
    fn NCryptDeleteKey(key: usize, flags: u32) -> i32;
}
#[link(name = "bcrypt")]
extern "system" {
    fn BCryptOpenAlgorithmProvider(
        out: *mut usize,
        name: *const u16,
        implementation: *const u16,
        flags: u32,
    ) -> i32;
    fn BCryptCloseAlgorithmProvider(handle: usize, flags: u32) -> i32;
    fn BCryptImportKeyPair(
        algorithm: usize,
        import: usize,
        kind: *const u16,
        out: *mut usize,
        bytes: *const u8,
        len: u32,
        flags: u32,
    ) -> i32;
    fn BCryptDestroyKey(key: usize) -> i32;
    fn BCryptVerifySignature(
        key: usize,
        padding: *const c_void,
        hash: *const u8,
        len: u32,
        sig: *const u8,
        sig_len: u32,
        flags: u32,
    ) -> i32;
}
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
fn ok(s: i32) -> Result<()> {
    if s == 0 {
        Ok(())
    } else {
        Err(E::KeyUnavailable)
    }
}
struct Handle(usize);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            NCryptFreeObject(self.0);
        }
    }
}
struct Algorithm(usize);
impl Drop for Algorithm {
    fn drop(&mut self) {
        unsafe {
            BCryptCloseAlgorithmProvider(self.0, 0);
        }
    }
}
struct PublicKey(usize);
impl Drop for PublicKey {
    fn drop(&mut self) {
        unsafe {
            BCryptDestroyKey(self.0);
        }
    }
}
pub(crate) struct WindowsIdentity {
    slot: Uuid,
}
impl WindowsIdentity {
    pub fn slot(slot: Uuid) -> Self {
        Self { slot }
    }
    pub(crate) fn metadata_slot(&self) -> Uuid {
        self.slot
    }
    #[cfg(test)]
    pub fn slot_id(&self) -> Uuid {
        self.slot
    }
    fn name(&self) -> Vec<u16> {
        wide(&format!("Arthur.Sync.Identity.v1.{}", self.slot))
    }
    fn provider() -> Result<Handle> {
        let mut p = 0;
        ok(unsafe {
            NCryptOpenStorageProvider(
                &mut p,
                wide("Microsoft Software Key Storage Provider").as_ptr(),
                0,
            )
        })?;
        Ok(Handle(p))
    }
    fn open(&self) -> Result<Handle> {
        let p = Self::provider()?;
        let mut k = 0;
        let rc = unsafe { NCryptOpenKey(p.0, &mut k, self.name().as_ptr(), 0, 0x40) };
        if rc as u32 == 0x80090016 {
            return Err(E::MissingKey);
        }
        ok(rc)?;
        let k = Handle(k);
        check_policy(&k)?;
        Ok(k)
    }
    #[cfg(test)]
    pub fn private_export_refused(&self) -> bool {
        let Ok(k) = self.open() else { return false };
        let mut size = 0;
        unsafe {
            NCryptExportKey(
                k.0,
                0,
                wide("ECCPRIVATEBLOB").as_ptr(),
                ptr::null(),
                ptr::null_mut(),
                0,
                &mut size,
                0x40,
            ) != 0
        }
    }
}
fn check_policy(k: &Handle) -> Result<()> {
    let mut value = 0u32;
    let mut n = 0;
    ok(unsafe {
        NCryptGetProperty(
            k.0,
            wide("Export Policy").as_ptr(),
            (&mut value as *mut u32).cast(),
            4,
            &mut n,
            0x40,
        )
    })?;
    if n != 4 || value != 0 {
        return Err(E::KeyUnavailable);
    }
    Ok(())
}
fn public(k: &Handle) -> Result<PublicIdentity> {
    let mut blob = [0u8; 72];
    let mut n = 0;
    ok(unsafe {
        NCryptExportKey(
            k.0,
            0,
            wide("ECCPUBLICBLOB").as_ptr(),
            ptr::null(),
            blob.as_mut_ptr(),
            72,
            &mut n,
            0x40,
        )
    })?;
    if n != 72
        || u32::from_le_bytes(blob[..4].try_into().unwrap()) != 0x31534345
        || u32::from_le_bytes(blob[4..8].try_into().unwrap()) != 32
    {
        return Err(E::Invalid);
    }
    let mut key = vec![4];
    key.extend_from_slice(&blob[8..]);
    PublicIdentity::from_sec1(key)
}
impl DeviceIdentityStore for WindowsIdentity {
    fn create_identity(&self) -> Result<PublicIdentity> {
        let p = Self::provider()?;
        let mut k = 0;
        let rc = unsafe {
            NCryptCreatePersistedKey(
                p.0,
                &mut k,
                wide("ECDSA_P256").as_ptr(),
                self.name().as_ptr(),
                0,
                0,
            )
        };
        if rc as u32 == 0x8009000f {
            return Err(E::AlreadyExists);
        }
        ok(rc)?;
        let k = Handle(k);
        let zero = 0u32;
        let usage = 2u32;
        let result = (|| {
            ok(unsafe {
                NCryptSetProperty(
                    k.0,
                    wide("Export Policy").as_ptr(),
                    (&zero as *const u32).cast(),
                    4,
                    0,
                )
            })?;
            ok(unsafe {
                NCryptSetProperty(
                    k.0,
                    wide("Key Usage").as_ptr(),
                    (&usage as *const u32).cast(),
                    4,
                    0,
                )
            })?;
            ok(unsafe { NCryptFinalizeKey(k.0, 0x40) })?;
            check_policy(&k)?;
            public(&k)
        })();
        if result.is_err() {
            let rc = unsafe { NCryptDeleteKey(k.0, 0x40) };
            if rc == 0 {
                std::mem::forget(k);
            }
        }
        result
    }
    fn public_identity(&self) -> Result<PublicIdentity> {
        public(&self.open()?)
    }
    fn sign_domain_separated(&self, d: Domain, bytes: &[u8]) -> Result<Vec<u8>> {
        let k = self.open()?;
        let hash = digest(d, bytes)?;
        let mut signature = vec![0; 64];
        let mut n = 0;
        ok(unsafe {
            NCryptSignHash(
                k.0,
                ptr::null(),
                hash.as_ptr(),
                32,
                signature.as_mut_ptr(),
                64,
                &mut n,
                0x40,
            )
        })?;
        if n != 64 {
            return Err(E::Signature);
        }
        Ok(signature)
    }
    fn key_availability(&self) -> KeyAvailability {
        match self.open() {
            Ok(_) => KeyAvailability::Available,
            Err(E::MissingKey) => KeyAvailability::Missing,
            _ => KeyAvailability::Unavailable,
        }
    }
    fn invalidate_identity(&self) -> Result<()> {
        let k = self.open()?;
        ok(unsafe { NCryptDeleteKey(k.0, 0x40) })?;
        std::mem::forget(k);
        Ok(())
    }
}
fn import(p: &PublicIdentity) -> Result<(Algorithm, PublicKey)> {
    if p.sec1().len() != 65 || p.sec1()[0] != 4 {
        return Err(E::Invalid);
    }
    let mut a = 0;
    ok(unsafe {
        BCryptOpenAlgorithmProvider(&mut a, wide("ECDSA_P256").as_ptr(), ptr::null(), 0)
    })?;
    let a = Algorithm(a);
    let mut blob = Vec::from(0x31534345u32.to_le_bytes());
    blob.extend_from_slice(&32u32.to_le_bytes());
    blob.extend_from_slice(&p.sec1()[1..]);
    let mut key = 0;
    ok(unsafe {
        BCryptImportKeyPair(
            a.0,
            0,
            wide("ECCPUBLICBLOB").as_ptr(),
            &mut key,
            blob.as_ptr(),
            72,
            0,
        )
    })?;
    Ok((a, PublicKey(key)))
}
impl super::tls::NativeTls13 for WindowsIdentity {
    fn sign_tls13(&self, role: super::tls::CertificateRole, message: &[u8]) -> Result<Vec<u8>> {
        use sha2::{Digest, Sha256};
        super::tls::validate_message(role, message)?;
        let key = self.open()?;
        // TLS callback supplies the CertificateVerify PREIMAGE. Hash exactly once.
        let hash: [u8; 32] = Sha256::digest(message).into();
        let mut signature = [0u8; 64];
        let mut written = 0;
        ok(unsafe {
            NCryptSignHash(
                key.0,
                ptr::null(),
                hash.as_ptr(),
                32,
                signature.as_mut_ptr(),
                64,
                &mut written,
                0x40,
            )
        })?;
        if written != 64 {
            return Err(E::Signature);
        }
        super::tls::p1363_to_der(&signature)
    }
}
pub(super) fn validate(p: &PublicIdentity) -> Result<()> {
    let (_algorithm, _key) = import(p)?;
    Ok(())
}
pub(super) fn verify(p: &PublicIdentity, hash: &[u8; 32], sig: &[u8]) -> Result<()> {
    let (_a, k) = import(p)?;
    if unsafe {
        BCryptVerifySignature(
            k.0,
            ptr::null(),
            hash.as_ptr(),
            32,
            sig.as_ptr(),
            sig.len() as u32,
            0,
        )
    } != 0
    {
        return Err(E::Signature);
    }
    Ok(())
}
