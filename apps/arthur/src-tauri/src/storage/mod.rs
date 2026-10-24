pub mod capture_store;
pub(crate) mod ownership;
pub mod knowledge_store;
pub mod migrations;
pub mod relation_store;
pub mod lineage_store;
pub mod organization_store;
pub mod summary_store;
pub mod project_store;
pub mod recall_store;
pub mod integration_store;
#[cfg(test)]
mod revision_cas_tests;
pub mod identity_store;
pub mod evidence_store;
pub mod proposal_store;
/// M05-P1b-B dormant journal codec and reducer. Compiled into production
/// builds but invoked by no production write path; schema stays v9.
pub mod journal;
pub(crate) mod sync_store;
pub(crate) mod bootstrap_store;
pub(crate) mod enrollment_store;
#[cfg(windows)]
pub(crate) mod device_identity_store;
#[cfg(test)]
mod identity_store_tests;
#[cfg(test)]
mod proposal_store_tests;
#[cfg(test)]
mod evidence_store_tests;
#[cfg(test)]
mod m05_v10_tests;
