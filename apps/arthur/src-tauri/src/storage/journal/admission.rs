//! Pure checked admission and scoped claims; no platform calls or SQLite here.
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

pub(super) const MIB: u64 = 1024 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AdmissionError {
    SpaceUnknown,
    SpaceLow,
    VolumeMismatch,
    InvalidBounds,
    Overflow,
    UnsupportedMode,
    UnknownDemand,
    UnverifiedBounds,
    GrowthExceeded,
    RecoveryRequired,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Capacity {
    pub available: u64,
    pub allocation_unit: u64,
    pub volume: String,
    pub file_identity: u128,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
// Each variant names an actual adapter, including its internal domain helpers.
// These are candidate capped transactions, NOT universal VFS growth estimates.
// Multiple top-level adapters require a separate composite plan (unsupported).
pub(super) enum Operation {
    Activation,
    Capture,
    AcceptPendingClaim,
    ApplyIntegration,
    ArchiveProject,
    AttachRevisionEvidence,
    CreateProject,
    CreateRelation,
    CreateRevisionFrom,
    DeferClaim,
    EvolveCapture,
    ExecuteDueExpiry,
    InsertProposal,
    MergeRevisions,
    MoveCapture,
    MoveKnowledgeObject,
    RecordDistillation,
    RecordIdentityDecision,
    RecordRelations,
    RenameProject,
    ReopenClaim,
    ResolveClaim,
    RestoreProject,
    RestoreRevision,
    ReviewProposal,
    ReviseFromCapture,
    ReviseIfCurrent,
    SeparatePendingClaim,
    SetActiveProject,
    StageUncertainClaim,
    UpdateObject,
    SnapshotAllocate,
    SnapshotCapture,
    SnapshotPack,
    SnapshotAbort,
    SnapshotVerify,
    Unknown,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct StorageDemand {
    pub main: Option<u64>,
    pub journal: Option<u64>,
    pub scratch: Option<u64>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum StoragePressure {
    Normal,
    Warning,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct AdmissionDecision {
    pub required: u64,
    pub growth: u64,
    pub pressure: StoragePressure,
}
#[derive(Clone, Copy)]
pub(super) struct PhysicalAdmissionPolicy {
    pub recovery: u64,
    pub normal_main: u64,
    pub normal_scratch: u64,
    pub snapshot_main: u64,
    pub snapshot_scratch: u64,
    // Candidate envelopes are NOT verified bounds for arbitrary VFS/temp I/O.
    // Only synthetic integration tests may waive this prerequisite.
    synthetic_bounds: bool,
    #[cfg(test)]
    pub(super) require_vfs: bool,
    #[cfg(test)]
    pub(super) journal_ceiling: Option<u64>,
}
impl PhysicalAdmissionPolicy {
    pub fn profile_a_candidate() -> Self {
        Self {
            recovery: 32 * MIB,
            normal_main: 32 * MIB,
            normal_scratch: 16 * MIB,
            snapshot_main: 128 * MIB,
            snapshot_scratch: 64 * MIB,
            synthetic_bounds: false,
            #[cfg(test)]
            require_vfs: false,
            #[cfg(test)]
            journal_ceiling: None,
        }
    }
    #[cfg(test)]
    pub fn synthetic_profile_a() -> Self {
        Self {
            synthetic_bounds: true,
            ..Self::profile_a_candidate()
        }
    }
    #[cfg(test)]
    pub fn instrumented_profile_a() -> Self {
        Self {
            require_vfs: true,
            ..Self::synthetic_profile_a()
        }
    }
    pub fn require_bound_evidence(self) -> Result<(), AdmissionError> {
        if self.synthetic_bounds {
            Ok(())
        } else {
            Err(AdmissionError::UnverifiedBounds)
        }
    }
    pub fn demand(
        self,
        operation: Operation,
        image: u64,
        mode: &str,
    ) -> Result<StorageDemand, AdmissionError> {
        if mode != "delete" {
            return Err(AdmissionError::UnsupportedMode);
        }
        if operation == Operation::Unknown {
            return Err(AdmissionError::UnknownDemand);
        }
        let (main, scratch) = match operation {
            Operation::SnapshotCapture | Operation::SnapshotPack => {
                (self.snapshot_main, self.snapshot_scratch)
            }
            _ => (self.normal_main, self.normal_scratch),
        };
        if main == 0 || self.recovery == 0 {
            return Err(AdmissionError::InvalidBounds);
        }
        let journal = image
            .checked_mul(2)
            .and_then(|n| n.checked_add(MIB))
            .ok_or(AdmissionError::Overflow)?;
        #[cfg(test)]
        let journal = self.journal_ceiling.map_or(journal, |cap| journal.min(cap));
        Ok(StorageDemand {
            main: Some(main),
            journal: Some(journal),
            scratch: Some(scratch),
        })
    }
    pub fn evaluate(
        self,
        capacity: &Capacity,
        expected_volume: &str,
        demand: StorageDemand,
        claims: u64,
    ) -> Result<AdmissionDecision, AdmissionError> {
        if self.recovery == 0 {
            return Err(AdmissionError::InvalidBounds);
        }
        if capacity.volume != expected_volume {
            return Err(AdmissionError::VolumeMismatch);
        }
        let main = demand.main.ok_or(AdmissionError::UnknownDemand)?;
        let journal = demand.journal.ok_or(AdmissionError::UnknownDemand)?;
        let scratch = demand.scratch.ok_or(AdmissionError::UnknownDemand)?;
        let growth = [main, journal, scratch]
            .into_iter()
            .try_fold(0u64, |sum, n| {
                sum.checked_add(round(n, capacity.allocation_unit)?)
                    .ok_or(AdmissionError::Overflow)
            })?;
        let required = round(self.recovery, capacity.allocation_unit)?
            .checked_add(growth)
            .and_then(|n| n.checked_add(claims))
            .ok_or(AdmissionError::Overflow)?;
        if capacity.available < required {
            return Err(AdmissionError::SpaceLow);
        }
        let pressure = if capacity
            .available
            .checked_sub(required)
            .ok_or(AdmissionError::Overflow)?
            < required
        {
            StoragePressure::Warning
        } else {
            StoragePressure::Normal
        };
        Ok(AdmissionDecision {
            required,
            growth,
            pressure,
        })
    }
}
pub(super) fn round(bytes: u64, unit: u64) -> Result<u64, AdmissionError> {
    if unit == 0 {
        return Err(AdmissionError::SpaceUnknown);
    }
    let rem = bytes % unit;
    if rem == 0 {
        Ok(bytes)
    } else {
        bytes
            .checked_add(unit - rem)
            .ok_or(AdmissionError::Overflow)
    }
}

/// Shared by admitted jobs on a volume. Counts only still-unallocated growth.
/// A pool has one recovery floor, preventing jobs from silently promising
/// incompatible recovery policies. No global registry or OS reservation.
pub(super) struct ClaimPool {
    recovery: u64,
    totals: Mutex<BTreeMap<String, u64>>,
}
impl ClaimPool {
    pub fn new(recovery: u64) -> Arc<Self> {
        Arc::new(Self {
            recovery,
            totals: Mutex::new(BTreeMap::new()),
        })
    }
    pub fn claim(
        self: &Arc<Self>,
        policy: PhysicalAdmissionPolicy,
        cap: &Capacity,
        expected: &str,
        demand: StorageDemand,
    ) -> Result<Claim, AdmissionError> {
        if policy.recovery != self.recovery {
            return Err(AdmissionError::InvalidBounds);
        }
        let mut totals = self
            .totals
            .lock()
            .map_err(|_| AdmissionError::RecoveryRequired)?;
        let total = *totals.get(expected).unwrap_or(&0);
        let decision = policy.evaluate(cap, expected, demand, total)?;
        let new = total
            .checked_add(decision.growth)
            .ok_or(AdmissionError::Overflow)?;
        totals.insert(expected.into(), new);
        Ok(Claim {
            pool: self.clone(),
            volume: expected.into(),
            remaining: decision.growth,
        })
    }
}
pub(super) struct Claim {
    pool: Arc<ClaimPool>,
    volume: String,
    remaining: u64,
}
impl Claim {
    pub fn recheck(
        &mut self,
        policy: PhysicalAdmissionPolicy,
        cap: &Capacity,
        demand: StorageDemand,
    ) -> Result<(), AdmissionError> {
        let mut totals = self
            .pool
            .totals
            .lock()
            .map_err(|_| AdmissionError::RecoveryRequired)?;
        let total = *totals
            .get(&self.volume)
            .ok_or(AdmissionError::RecoveryRequired)?;
        let others = total
            .checked_sub(self.remaining)
            .ok_or(AdmissionError::RecoveryRequired)?;
        let decision = policy.evaluate(cap, &self.volume, demand, others)?;
        totals.insert(
            self.volume.clone(),
            others
                .checked_add(decision.growth)
                .ok_or(AdmissionError::Overflow)?,
        );
        self.remaining = decision.growth;
        Ok(())
    }
}
impl Drop for Claim {
    fn drop(&mut self) {
        if let Ok(mut totals) = self.pool.totals.lock() {
            if let Some(n) = totals.get_mut(&self.volume) {
                if let Some(remaining) = n.checked_sub(self.remaining) {
                    *n = remaining;
                }
            }
        }
    }
}
