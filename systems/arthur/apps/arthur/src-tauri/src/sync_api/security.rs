//! Shared security metadata keeps the existing native validation and seals.
#[cfg(target_os = "android")]
pub(crate) use crate::native_security::android;
#[cfg(windows)]
pub(crate) use crate::native_security::windows;
pub(crate) use crate::native_security::{
    canonical, composition, connected_endpoint, enrollment, identity, network_watch,
    route_candidate, route_observer, tls, transport, Result, SecurityError,
};
#[path = "../sync/security/signed.rs"]
pub(crate) mod signed;
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) use crate::native_security::n7a_tests;
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) use crate::native_security::native_io_lab;
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) use crate::native_security::pake_qualification;
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) use crate::native_security::tls_lab;
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) use crate::native_security::tls_socket_lab;
