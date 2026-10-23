//! One transaction's candidate budget; no SQLite owner or connection is created.
use super::admission::{
    AdmissionError as E, Capacity, Claim, ClaimPool, Operation, PhysicalAdmissionPolicy,
    StorageDemand,
};
use super::capacity::{allocated_bytes, CapacityProvider, OwnedLocation};
use crate::storage::capture_store::CaptureStore;
use rusqlite::Connection;
use std::sync::Arc;

pub(super) struct PhysicalAdmission {
    policy: PhysicalAdmissionPolicy,
    provider: Arc<dyn CapacityProvider>,
    claims: Arc<ClaimPool>,
    location: OwnedLocation,
    binding: Capacity,
}
impl PhysicalAdmission {
    pub fn bind(
        s: &CaptureStore,
        c: &Connection,
        policy: PhysicalAdmissionPolicy,
        provider: Arc<dyn CapacityProvider>,
        claims: Arc<ClaimPool>,
    ) -> Result<Self, E> {
        let location = OwnedLocation::bind(s, c)?;
        let binding = provider.query(&location)?;
        if binding.volume.is_empty() || binding.allocation_unit == 0 {
            return Err(E::SpaceUnknown);
        }
        // No release constructor currently certifies VFS/temp growth bounds.
        // Profile A is implemented, but real admission stays fail-closed until
        // that independent prerequisite is supplied. Synthetic tests opt in.
        policy.require_bound_evidence()?;
        Ok(Self {
            policy,
            provider,
            claims,
            location,
            binding,
        })
    }
    fn capacity(&self) -> Result<Capacity, E> {
        self.location.validate()?;
        let cap = self.provider.query(&self.location)?;
        if cap.volume != self.binding.volume || cap.file_identity != self.binding.file_identity {
            return Err(E::VolumeMismatch);
        }
        if cap.allocation_unit != self.binding.allocation_unit {
            return Err(E::SpaceUnknown);
        }
        Ok(cap)
    }
    pub fn prepare(&self, c: &Connection, operation: Operation) -> Result<Budget<'_>, E> {
        let mode: String = c
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .map_err(|_| E::SpaceUnknown)?;
        let pages = number(c, "PRAGMA page_count")?;
        let size = number(c, "PRAGMA page_size")?;
        if size == 0 {
            return Err(E::InvalidBounds);
        }
        let image = pages.checked_mul(size).ok_or(E::Overflow)?;
        let demand = self.policy.demand(operation, image, &mode)?;
        let cap = self.capacity()?;
        let claim = self
            .claims
            .claim(self.policy, &cap, &self.binding.volume, demand)?;
        let old_max = number(c, "PRAGMA max_page_count")?;
        let max = pages
            .checked_add(demand.main.ok_or(E::UnknownDemand)? / size)
            .ok_or(E::Overflow)?
            .min(old_max);
        let max = i64::try_from(max).map_err(|_| E::Overflow)?;
        let file_start = allocated_bytes(self.location.database(), false)?;
        let journal_start = allocated_bytes(
            &self.location.database().with_file_name("arthur.db-journal"),
            true,
        )?;
        // Last mutating action during preparation. Always restored by the
        // caller before COMMIT or after rollback; no post-COMMIT fallible work.
        c.pragma_update(None, "max_page_count", max)
            .map_err(|_| E::SpaceUnknown)?;
        Ok(Budget {
            admission: self,
            claim,
            demand,
            image,
            file_start,
            journal_start,
            old_max,
        })
    }
}
fn number(c: &Connection, sql: &str) -> Result<u64, E> {
    let n: i64 = c
        .query_row(sql, [], |r| r.get(0))
        .map_err(|_| E::SpaceUnknown)?;
    u64::try_from(n).map_err(|_| E::Overflow)
}
pub(super) struct Budget<'a> {
    admission: &'a PhysicalAdmission,
    claim: Claim,
    demand: StorageDemand,
    image: u64,
    file_start: u64,
    journal_start: u64,
    old_max: u64,
}
impl Budget<'_> {
    pub fn check(&mut self, c: &Connection) -> Result<(), E> {
        let mode: String = c
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .map_err(|_| E::SpaceUnknown)?;
        if mode != "delete" {
            return Err(E::UnsupportedMode);
        }
        let image = number(c, "PRAGMA page_count")?
            .checked_mul(number(c, "PRAGMA page_size")?)
            .ok_or(E::Overflow)?;
        if image.checked_sub(self.image).unwrap_or(0) > self.demand.main.ok_or(E::UnknownDemand)? {
            return Err(E::GrowthExceeded);
        }
        let main_used = allocated_bytes(self.admission.location.database(), false)?
            .checked_sub(self.file_start)
            .unwrap_or(0);
        let journal_used = allocated_bytes(
            &self
                .admission
                .location
                .database()
                .with_file_name("arthur.db-journal"),
            true,
        )?
        .checked_sub(self.journal_start)
        .unwrap_or(0);
        let main = self
            .demand
            .main
            .ok_or(E::UnknownDemand)?
            .checked_sub(main_used)
            .ok_or(E::GrowthExceeded)?;
        let journal = self
            .demand
            .journal
            .ok_or(E::UnknownDemand)?
            .checked_sub(journal_used)
            .ok_or(E::GrowthExceeded)?;
        // Files already allocated reduce F and are removed from this claim.
        self.claim.recheck(
            self.admission.policy,
            &self.admission.capacity()?,
            StorageDemand {
                main: Some(main),
                journal: Some(journal),
                scratch: self.demand.scratch,
            },
        )
    }
    pub fn restore(&self, c: &Connection) -> Result<(), E> {
        c.pragma_update(
            None,
            "max_page_count",
            i64::try_from(self.old_max).map_err(|_| E::RecoveryRequired)?,
        )
        .map_err(|_| E::RecoveryRequired)
    }
}
