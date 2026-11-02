//! Compatibility names for native primitives; the engine uses only contracts.
pub(crate) use crate::runtime::transport_candidate;
#[cfg(target_os = "android")]
pub(crate) use crate::sync_api::security::android;
#[cfg(windows)]
pub(crate) use crate::sync_api::security::windows;
pub(crate) use crate::sync_api::security::{
    canonical, composition, connected_endpoint, enrollment, identity, network_watch,
    route_candidate, route_observer, signed, tls, transport, Result, SecurityError,
};
#[path = "compat/n7a_tests.rs"]
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) mod n7a_tests;
#[path = "compat/native_io_lab.rs"]
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) mod native_io_lab;
#[path = "compat/pake_qualification.rs"]
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) mod pake_qualification;
#[path = "compat/tls_lab.rs"]
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) mod tls_lab;
#[path = "compat/tls_socket_lab.rs"]
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) mod tls_socket_lab;
