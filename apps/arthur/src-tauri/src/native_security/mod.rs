//! MEGA E, dormant native boundary. Architecture answers:
//! 1. Truth: OS private key; existing owner's SQLite public registry/abuse ledger.
//! 2. Ownership: DeviceIdentityStore signs; CaptureStore serializes all trust writes.
//! 3. Direction: primitives use leaf contracts; owner adapters consume primitives.
//! 4. Boundary: public keys/signatures/opaque bindings, never private keys or SQL.
//! 5. Failure: typed refusal; PAKE/TLS/routes have no release acceptance constructor.
//! 6. Lifecycle: explicit key creation/deletion, immutable revocations, boot cancellation.
//! 7. Seams: deterministic clock/RNG and explicitly test-only PAKE metadata proofs.
//! 8. Compatibility: test-installed forward-only SQL, no production migration/routing.
//! 9. Observation: categories only; secrets have neither Debug nor Serialize.
//! 10. Security: pinned admin, shared durable attempt reservation, exact-key approval.
#[cfg(target_os = "android")]
#[path = "../sync/security/android.rs"]
pub(crate) mod android;
#[path = "../sync/security/composition.rs"]
pub(crate) mod composition;
#[path = "../sync/security/connected_endpoint.rs"]
pub(crate) mod connected_endpoint;
#[cfg(test)]
#[path = "../storage/security_e2_tests.rs"]
mod e2_tests;
#[path = "../sync/security/enrollment.rs"]
pub(crate) mod enrollment;
#[path = "../sync/security/identity.rs"]
pub(crate) mod identity;
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
#[path = "../sync/security/n7a_tests.rs"]
pub(crate) mod n7a_tests;
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
#[path = "../sync/security/native_io_lab.rs"]
pub(crate) mod native_io_lab;
#[path = "../sync/security/network_watch.rs"]
pub(crate) mod network_watch;
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
#[path = "../sync/security/pake_qualification.rs"]
pub(crate) mod pake_qualification;
#[path = "../sync/security/route_candidate.rs"]
pub(crate) mod route_candidate;
#[path = "../sync/security/route_observer.rs"]
pub(crate) mod route_observer;
#[cfg(test)]
#[path = "../sync/security/tests.rs"]
mod tests;
#[path = "../sync/security/tls.rs"]
pub(crate) mod tls;
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
#[path = "../sync/security/tls_lab.rs"]
pub(crate) mod tls_lab;
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
#[path = "../sync/security/tls_socket_lab.rs"]
pub(crate) mod tls_socket_lab;
#[path = "../sync/security/transport.rs"]
pub(crate) mod transport;
#[cfg(windows)]
#[path = "../sync/security/windows.rs"]
pub(crate) mod windows;

pub(crate) use crate::sync_api::security_error::{canonical, Result, SecurityError};

// Qualification-only composition; never a release dependency on the owner.
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) use crate::runtime::transport_candidate;
#[cfg(test)]
use crate::sync_api::security::signed;
