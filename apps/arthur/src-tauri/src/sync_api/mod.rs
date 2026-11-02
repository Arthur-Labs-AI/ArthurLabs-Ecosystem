//! Shared bounded values and ports for the dormant native sync candidate.
pub(crate) mod bootstrap;
pub mod codec;
pub(crate) mod protocol;
pub(crate) use protocol::*;
pub mod reducer;
pub(crate) mod validation;
pub(crate) use validation::ValidatedEvent;
pub(crate) mod revocation;
pub(crate) mod security_error;
