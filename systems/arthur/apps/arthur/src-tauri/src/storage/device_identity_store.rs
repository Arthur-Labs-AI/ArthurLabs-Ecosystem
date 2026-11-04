//! Durable nonsecret CNG slot/public-key anchor, through the existing owner.
//! Creating/invalidation states survive crashes; neither state regenerates a key.
use super::capture_store::CaptureStore;
use crate::sync_api::security::{
    identity::*, windows::WindowsIdentity, Result, SecurityError as E,
};
use rusqlite::{params, TransactionBehavior};
use uuid::Uuid;
// Concrete OS operation under the owner's transaction; no callback or second lock.
pub(super) fn bound_key(
    c: &rusqlite::Connection,
    local: Uuid,
) -> Result<(WindowsIdentity, PublicIdentity)> {
    let (slot, key, state): (String, Option<Vec<u8>>, String) = c
        .query_row(
            "SELECT slot,key,state FROM e_identity WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| E::Trust)?;
    if state != "active" {
        return Err(E::Trust);
    }
    let expected = PublicIdentity::from_sec1(key.ok_or(E::Trust)?)?;
    if expected.peer_id() != local {
        return Err(E::Trust);
    }
    let native = WindowsIdentity::slot(Uuid::parse_str(&slot).map_err(|_| E::Trust)?);
    if native.public_identity()? != expected {
        return Err(E::Trust);
    }
    Ok((native, expected))
}
pub(crate) struct OwnedDeviceIdentity<'a> {
    owner: &'a CaptureStore,
    key: WindowsIdentity,
    expected: PublicIdentity,
}
impl<'a> OwnedDeviceIdentity<'a> {
    pub fn initialize(owner: &'a CaptureStore) -> Result<Self> {
        let slot = Uuid::new_v4();
        {
            let mut c = owner.connection.lock().map_err(|_| E::Storage)?;
            let tx = c
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| E::Storage)?;
            let enrolled: bool = tx
                .query_row("SELECT EXISTS(SELECT 1 FROM e_registry)", [], |r| r.get(0))
                .map_err(|_| E::Storage)?;
            if enrolled {
                return Err(E::State);
            }
            tx.execute(
                "INSERT INTO e_identity VALUES(1,?1,NULL,'creating')",
                [slot.to_string()],
            )
            .map_err(|_| E::State)?;
            tx.commit().map_err(|_| E::Storage)?;
        }
        // Persist the recovery marker BEFORE touching the OS key. A failure leaves
        // 'creating', not an invitation to silently replace a partially created key.
        let key = WindowsIdentity::slot(slot);
        let expected = key.create_identity()?;
        {
            let c = owner.connection.lock().map_err(|_| E::Storage)?;
            if c.execute("UPDATE e_identity SET key=?2,state='active' WHERE singleton=1 AND slot=?1 AND state='creating'",params![slot.to_string(),expected.sec1()]).map_err(|_|E::Storage)?!=1{return Err(E::State);}
        }
        Ok(Self {
            owner,
            key,
            expected,
        })
    }
    pub fn reopen(owner: &'a CaptureStore) -> Result<Self> {
        let (slot, bytes, state): (String, Option<Vec<u8>>, String) = {
            let c = owner.connection.lock().map_err(|_| E::Storage)?;
            c.query_row(
                "SELECT slot,key,state FROM e_identity WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|_| E::State)?
        };
        if state != "active" {
            return Err(E::State);
        }
        let expected = PublicIdentity::from_sec1(bytes.ok_or(E::State)?)?;
        let key = WindowsIdentity::slot(Uuid::parse_str(&slot).map_err(|_| E::State)?);
        if key.public_identity()? != expected {
            return Err(E::Trust);
        }
        Ok(Self {
            owner,
            key,
            expected,
        })
    }
    fn check(&self) -> Result<()> {
        let c = self.owner.connection.lock().map_err(|_| E::Storage)?;
        self.check_locked(&c)
    }
    fn check_locked(&self, c: &rusqlite::Connection) -> Result<()> {
        let valid:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM e_identity WHERE singleton=1 AND slot=?1 AND key=?2 AND state='active')",params![self.key_slot().to_string(),self.expected.sec1()],|r|r.get(0)).map_err(|_|E::Storage)?;
        if !valid {
            return Err(E::State);
        }
        if self.key.public_identity()? != self.expected {
            return Err(E::Trust);
        }
        Ok(())
    }
    fn key_slot(&self) -> Uuid {
        self.key.metadata_slot()
    }
    #[cfg(test)]
    pub(crate) fn slot_for_test(&self) -> Uuid {
        self.key_slot()
    }
}
impl DeviceIdentityStore for OwnedDeviceIdentity<'_> {
    fn create_identity(&self) -> Result<PublicIdentity> {
        Err(E::AlreadyExists)
    }
    fn public_identity(&self) -> Result<PublicIdentity> {
        self.check()?;
        Ok(self.expected.clone())
    }
    fn sign_domain_separated(&self, d: Domain, bytes: &[u8]) -> Result<Vec<u8>> {
        // Serialize explicit invalidation with the complete protected signing
        // operation, not merely a prior availability observation.
        let c = self.owner.connection.lock().map_err(|_| E::Storage)?;
        self.check_locked(&c)?;
        let signature = self.key.sign_domain_separated(d, bytes)?;
        crate::sync_api::security::identity::verify(&self.expected, d, bytes, &signature)?;
        Ok(signature)
    }
    fn key_availability(&self) -> KeyAvailability {
        if self.check().is_err() {
            return KeyAvailability::Unavailable;
        }
        self.key.key_availability()
    }
    fn invalidate_identity(&self) -> Result<()> {
        // Write the durable invalidation marker first. Any key-deletion failure is
        // still closed on reopen, and the owner never silently creates a replacement.
        {
            let c = self.owner.connection.lock().map_err(|_| E::Storage)?;
            if c.execute(
                "UPDATE e_identity SET state='invalidated' WHERE singleton=1 AND slot=?1",
                [self.key_slot().to_string()],
            )
            .map_err(|_| E::Storage)?
                != 1
            {
                return Err(E::State);
            }
        }
        self.key.invalidate_identity()
    }
}
