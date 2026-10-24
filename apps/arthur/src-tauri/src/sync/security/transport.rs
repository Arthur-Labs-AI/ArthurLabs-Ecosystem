//! No socket is opened until reviewed TLS/external signing and route policy exist.
//! The bounded record parser is a future TLS-stream seam, NOT plaintext Sync.
use super::{Result, SecurityError as E};
use crate::sync::Cancellation;
use std::{
    io::Read,
    net::SocketAddr,
    sync::{Arc, Mutex},
};
pub(crate) const MAX_RECORD: usize = 64 * 1024;
pub(crate) struct ClosedLan;
impl ClosedLan {
    pub fn listen(&self, hint: &str) -> Result<()> {
        validate_hint(hint)?;
        Err(E::N1AuditPending)
    }
    pub fn dial(&self, hint: &str) -> Result<()> {
        validate_hint(hint)?;
        Err(E::N1AuditPending)
    }
}
fn validate_hint(hint: &str) -> Result<()> {
    if hint.len() > 128 {
        return Err(E::Limit);
    }
    let a: SocketAddr = hint.parse().map_err(|_| E::Invalid)?;
    if a.ip().is_unspecified() || a.port() == 0 {
        return Err(E::Invalid);
    }
    Ok(())
}
// RFC1918 is not route/interface proof. N7 has no caller-supplied approval bool.
pub(crate) fn selected_route() -> Result<()> {
    Err(E::N7PolicyPending)
}
pub(crate) fn read_record(reader: &mut impl Read, cancel: &Cancellation) -> Result<Vec<u8>> {
    if cancel.cancelled() {
        return Err(E::Cancelled);
    }
    let mut header = [0u8; 8];
    reader.read_exact(&mut header).map_err(|_| E::Invalid)?;
    if &header[..4] != b"AE01" {
        return Err(E::Invalid);
    }
    let length = u32::from_be_bytes(header[4..].try_into().unwrap()) as usize;
    if length == 0 || length > MAX_RECORD {
        return Err(E::Limit);
    }
    if cancel.cancelled() {
        return Err(E::Cancelled);
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).map_err(|_| E::Invalid)?;
    if cancel.cancelled() {
        return Err(E::Cancelled);
    }
    Ok(bytes)
}
#[derive(Clone, Copy)]
pub(crate) enum LeaseKind {
    Handshake,
    Session,
}
#[derive(Default)]
pub(crate) struct ResourcePool(Mutex<[usize; 2]>);
pub(crate) struct Lease {
    pool: Arc<ResourcePool>,
    slot: usize,
}
impl ResourcePool {
    pub fn acquire(self: &Arc<Self>, kind: LeaseKind, cancel: &Cancellation) -> Result<Lease> {
        if cancel.cancelled() {
            return Err(E::Cancelled);
        }
        let slot = match kind {
            LeaseKind::Handshake => 0,
            LeaseKind::Session => 1,
        };
        let maximum = [2, 1][slot];
        let mut counts = self.0.lock().map_err(|_| E::State)?;
        if counts[slot] >= maximum {
            return Err(E::Limit);
        }
        counts[slot] += 1;
        Ok(Lease {
            pool: self.clone(),
            slot,
        })
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut counts) = self.pool.0.lock() {
            counts[self.slot] -= 1;
        }
    }
}
