//! MEGA E, dormant native boundary. Architecture answers:
//! 1. Truth: OS private key; existing owner's SQLite public registry/abuse ledger.
//! 2. Ownership: DeviceIdentityStore signs; CaptureStore serializes all trust writes.
//! 3. Direction: security -> typed owner adapters; pure engine semantics unchanged.
//! 4. Boundary: public keys/signatures/opaque bindings, never private keys or SQL.
//! 5. Failure: typed refusal; PAKE/TLS/routes have no release acceptance constructor.
//! 6. Lifecycle: explicit key creation/deletion, immutable revocations, boot cancellation.
//! 7. Seams: deterministic clock/RNG and explicitly test-only PAKE metadata proofs.
//! 8. Compatibility: test-installed forward-only SQL, no production migration/routing.
//! 9. Observation: categories only; secrets have neither Debug nor Serialize.
//! 10. Security: pinned admin, shared durable attempt reservation, exact-key approval.
#[cfg(target_os = "android")]
pub(crate) mod android;
pub(crate) mod composition;
pub(crate) mod connected_endpoint;
#[cfg(test)]
#[path = "../../storage/security_e2_tests.rs"]
mod e2_tests;
pub(crate) mod enrollment;
pub(crate) mod identity;
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) mod n7a_tests;
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) mod native_io_lab;
pub(crate) mod network_watch;
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) mod pake_qualification;
pub(crate) mod route_candidate;
pub(crate) mod route_observer;
pub(crate) mod signed;
#[cfg(test)]
mod tests;
pub(crate) mod tls;
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) mod tls_lab;
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) mod tls_socket_lab;
pub(crate) mod transport;
pub(crate) mod transport_candidate;
#[cfg(windows)]
pub(crate) mod windows;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SecurityError {
    N1AuditPending,
    N2PolicyPending,
    N7PolicyPending,
    PlatformUnverified,
    MissingKey,
    KeyUnavailable,
    AlreadyExists,
    Invalid,
    Signature,
    Trust,
    Replay,
    Fork,
    Limit,
    State,
    Expired,
    Locked,
    Storage,
    ActivationPending,
    Cancelled,
}
pub(crate) type Result<T> = std::result::Result<T, SecurityError>;
pub(crate) fn canonical<T: serde::Serialize>(value: &T) -> Result<Vec<u8>> {
    let b = serde_jcs::to_vec(value).map_err(|_| SecurityError::Invalid)?;
    if b.len() > 16384 {
        return Err(SecurityError::Limit);
    }
    Ok(b)
}
