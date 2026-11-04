pub(crate) mod bootstrap_store;
mod bootstrap_trace;
pub mod capture_store;
#[cfg(windows)]
pub(crate) mod device_identity_store;
#[cfg(target_os = "android")]
#[path = "android_device_identity_store.rs"]
pub(crate) mod device_identity_store;
pub(crate) mod enrollment_store;
pub mod evidence_store;
#[cfg(test)]
mod evidence_store_tests;
pub mod identity_store;
#[cfg(test)]
mod identity_store_tests;
pub mod integration_store;
/// M05-P1b-B dormant journal codec and reducer. Compiled into production
/// builds but invoked by no production write path; schema stays v9.
pub mod journal;
pub mod knowledge_store;
#[cfg(test)]
mod layering_tests;
pub mod lineage_store;
#[cfg(test)]
mod m05_v10_tests;
pub mod migrations;
pub mod organization_store;
pub(crate) mod ownership;
pub mod project_store;
pub mod proposal_store;
#[cfg(test)]
mod proposal_store_tests;
pub mod recall_store;
mod registry_verification;
pub mod relation_store;
#[cfg(test)]
mod revision_cas_tests;
#[cfg(all(target_os = "android", feature = "android-identity-tests"))]
mod security_android_instrumentation;
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) mod security_pake_tests;
#[cfg(any(test, all(target_os = "android", feature = "android-identity-tests")))]
pub(crate) mod security_tls_tests;
pub(crate) mod signed_bootstrap;
pub(crate) mod signed_import;
#[cfg(test)]
#[cfg(windows)]
mod signed_sync_tests;
pub mod summary_store;
pub(crate) mod sync_store;
pub(crate) mod tls_identity;
