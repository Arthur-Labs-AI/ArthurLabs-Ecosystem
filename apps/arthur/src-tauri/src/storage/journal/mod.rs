//! M05-P1b-B: dormant canonical journal codec and typed effect reducer.
//!
//! Transport-independent, event-level journal support. This module compiles
//! into normal production builds but is NOT invoked by any existing
//! production write path: schema stays v9, no `JournalTx` exists yet, and
//! no Tauri command creates a journal context. Activation belongs to a later
//! task that integrates every authoritative writer.
//!
//! Layout:
//!
//! - `codec`: closed operation vocabulary, RFC 8785 canonical bytes and
//!   domain-separated SHA-256 integrity.
//! - `reducer`: typed reduction of observed SQL row effects into logical
//!   operations using a native-owned final-state projection.
//!
//! Privacy: event bodies never enter logs. All fallible entry points return
//! typed errors; panics are never used for validation.

pub mod codec;
pub mod reducer;

#[cfg(test)]
mod tests;
