//! Integrated synthetic admission, exact disk recovery, and safe native API smoke.
//! Synthetic envelopes do not certify VFS I/O or physical filesystem-full behavior.
use super::admission::{
    AdmissionError as A, Capacity, ClaimPool, Operation as O, PhysicalAdmissionPolicy as P,
    StorageDemand as D, StoragePressure, MIB,
};
use super::capacity::{CapacityProvider, NativeCapacity, OwnedLocation};
use super::storage::{Fault, JournalError as J, JournalKernel, Limits, Stage, StorageFailure};
use super::storage_tests::{clean, cores, state, upgrade};
use super::writers::WriterError as W;
use crate::storage::{
    capture_store::{CaptureStore, CreateCaptureInput},
    ownership::DataRootOwnership,
};
use std::sync::{Arc, Mutex};
const SNAP: &str = "aaaaaaaa-1111-4111-8111-111111111111";
const NOW: &str = "2026-10-23T12:00:00Z";
fn cap(free: u64) -> Capacity {
    Capacity {
        available: free,
        allocation_unit: 4096,
        volume: "synthetic-volume".into(),
        file_identity: 42,
    }
}
#[derive(Clone)]
struct Fake(Arc<Mutex<Result<Capacity, A>>>);
impl Fake {
    fn new() -> Self {
        Self(Arc::new(Mutex::new(Ok(cap(u64::MAX / 4)))))
    }
    fn free(&self, bytes: u64) {
        self.0.lock().unwrap().as_mut().unwrap().available = bytes;
    }
}
impl CapacityProvider for Fake {
    fn query(&self, _: &OwnedLocation) -> Result<Capacity, A> {
        self.0.lock().unwrap().clone()
    }
}
fn input(text: &str) -> CreateCaptureInput {
    CreateCaptureInput {
        source: "text".into(),
        content: text.into(),
        project_id: None,
    }
}
fn fixture() -> (tempfile::TempDir, CaptureStore) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let s = CaptureStore::open_owned(DataRootOwnership::try_acquire(&root).unwrap()).unwrap();
    upgrade(&s);
    (dir, s)
}
fn activate<'a>(s: &'a CaptureStore, f: &Fake, p: P) -> JournalKernel<'a> {
    JournalKernel::activate_with_admission(
        s,
        Limits::candidate(),
        p,
        Arc::new(f.clone()),
        ClaimPool::new(p.recovery),
    )
    .unwrap()
}
fn rejection<T>(r: Result<T, W>, error: A) {
    assert!(matches!(r,Err(W::Journal(J::Admission(e))) if e==error));
}
fn seed(k: &JournalKernel<'_>) {
    k.write_admitted(O::Capture, |w| {
        w.create_capture(input("Synthetic admitted Capture"))
    })
    .unwrap();
}
fn reopen(
    dir: &tempfile::TempDir,
    s: CaptureStore,
    expected: &Vec<(String, Vec<Vec<rusqlite::types::Value>>)>,
) -> CaptureStore {
    clean(&s);
    assert_eq!(&state(&s), expected);
    drop(s);
    let root = dir.path().canonicalize().unwrap();
    let s = CaptureStore::reopen_candidate_owned_for_test(
        DataRootOwnership::try_acquire(&root).unwrap(),
    )
    .unwrap();
    clean(&s);
    assert_eq!(&state(&s), expected);
    s
}
#[test]
fn b01_calculator_exact_boundary_rounding_claims_and_unknowns() {
    let mut p = P::synthetic_profile_a();
    p.recovery = 1;
    let d = D {
        main: Some(1),
        journal: Some(4097),
        scratch: Some(0),
    };
    let required = 4096 + 4096 + 8192 + 7;
    let c = cap(required);
    let ok = p.evaluate(&c, &c.volume, d, 7).unwrap();
    assert_eq!(ok.required, required);
    assert_eq!(ok.pressure, StoragePressure::Warning);
    assert_eq!(
        p.evaluate(&cap(required - 1), &c.volume, d, 7),
        Err(A::SpaceLow)
    );
    assert_eq!(p.evaluate(&c, "wrong-volume", d, 0), Err(A::VolumeMismatch));
    assert_eq!(
        p.evaluate(
            &Capacity {
                allocation_unit: 0,
                ..c.clone()
            },
            &c.volume,
            d,
            0
        ),
        Err(A::SpaceUnknown)
    );
    assert_eq!(
        p.evaluate(&c, &c.volume, D { main: None, ..d }, 0),
        Err(A::UnknownDemand)
    );
    assert_eq!(
        p.evaluate(
            &cap(u64::MAX),
            &c.volume,
            D {
                main: Some(u64::MAX),
                ..d
            },
            0
        ),
        Err(A::Overflow)
    );
    assert_eq!(
        p.evaluate(&cap(u64::MAX), &c.volume, d, u64::MAX),
        Err(A::Overflow)
    );
    assert_eq!(p.demand(O::Capture, u64::MAX, "delete"), Err(A::Overflow));
    assert_eq!(p.demand(O::Unknown, 1, "delete"), Err(A::UnknownDemand));
    for mode in ["wal", "truncate", "off", "memory"] {
        assert_eq!(p.demand(O::Capture, 1, mode), Err(A::UnsupportedMode));
    }
    p.normal_main = 0;
    assert_eq!(p.demand(O::Capture, 1, "delete"), Err(A::InvalidBounds));
}
#[test]
fn b02_profile_values_and_scoped_competing_claims() {
    let p = P::profile_a_candidate();
    assert_eq!(p.require_bound_evidence(), Err(A::UnverifiedBounds));
    assert_eq!(
        (
            p.recovery,
            p.normal_main,
            p.normal_scratch,
            p.snapshot_main,
            p.snapshot_scratch
        ),
        (32 * MIB, 32 * MIB, 16 * MIB, 128 * MIB, 64 * MIB)
    );
    let d = p.demand(O::Capture, 4096, "delete").unwrap();
    assert_eq!(d.journal, Some(2 * 4096 + MIB));
    let c = cap(p
        .evaluate(&cap(u64::MAX / 4), "synthetic-volume", d, 0)
        .unwrap()
        .required);
    let pool = ClaimPool::new(p.recovery);
    let mut first = pool.claim(p, &c, &c.volume, d).unwrap();
    assert!(matches!(pool.claim(p, &c, &c.volume, d), Err(A::SpaceLow)));
    // Already allocated growth no longer remains an outstanding claim.
    first
        .recheck(
            p,
            &cap(p.recovery),
            D {
                main: Some(0),
                journal: Some(0),
                scratch: Some(0),
            },
        )
        .unwrap();
    drop(first);
    assert!(pool.claim(p, &c, &c.volume, d).is_ok());
}
#[test]
fn b03_activation_pressure_unknown_and_provider_binding_fail_closed() {
    for error in [A::SpaceUnknown, A::SpaceLow] {
        let (_dir, s) = fixture();
        let before = state(&s);
        let f = Fake::new();
        if error == A::SpaceUnknown {
            *f.0.lock().unwrap() = Err(error);
        } else {
            f.free(0);
        }
        let p = P::synthetic_profile_a();
        assert!(
            matches!(JournalKernel::activate_with_admission(&s,Limits::candidate(),p,Arc::new(f),ClaimPool::new(p.recovery)),Err(J::Admission(e)) if e==error)
        );
        assert_eq!(state(&s), before);
        clean(&s);
    }
    let (_dir, s) = fixture();
    let f = Fake::new();
    let p = P::profile_a_candidate();
    let before = state(&s);
    assert!(matches!(
        JournalKernel::activate_with_admission(
            &s,
            Limits::candidate(),
            p,
            Arc::new(f),
            ClaimPool::new(p.recovery)
        ),
        Err(J::Admission(A::UnverifiedBounds))
    ));
    assert_eq!(state(&s), before);
}
#[test]
fn b04_owned_location_mode_and_volume_rejections_do_not_change_configuration() {
    let (_dir, s) = fixture();
    let f = Fake::new();
    let p = P::synthetic_profile_a();
    s.execute_sql_for_test("PRAGMA journal_mode=WAL");
    let before = state(&s);
    assert!(matches!(
        JournalKernel::activate_with_admission(
            &s,
            Limits::candidate(),
            p,
            Arc::new(f.clone()),
            ClaimPool::new(p.recovery)
        ),
        Err(J::Admission(A::UnsupportedMode))
    ));
    assert_eq!(state(&s), before);
    let mode: String = s
        .connection
        .lock()
        .unwrap()
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    let s = CaptureStore::open_in_memory().unwrap();
    upgrade(&s);
    assert!(matches!(
        JournalKernel::activate_with_admission(
            &s,
            Limits::candidate(),
            p,
            Arc::new(f),
            ClaimPool::new(p.recovery)
        ),
        Err(J::Admission(A::SpaceUnknown))
    ));
}
#[test]
fn b05_admitted_capture_checks_before_work_after_sql_and_at_finalization() {
    let (dir, s) = fixture();
    let f = Fake::new();
    let k = activate(&s, &f, P::synthetic_profile_a());
    seed(&k);
    let before = state(&s);
    f.free(0);
    let mut called = false;
    rejection(
        k.write_admitted(O::Capture, |w| {
            called = true;
            w.create_capture(input("Rejected before SQL"))
        }),
        A::SpaceLow,
    );
    assert!(!called);
    assert_eq!(state(&s), before);
    f.free(u64::MAX / 4);
    rejection(
        k.write_admitted(O::Capture, |w| {
            let cap = w.create_capture(input("Real SQL before capacity loss"))?;
            assert_eq!(w.observed_effect_count(), 1);
            f.free(0);
            Ok(cap)
        }),
        A::SpaceLow,
    );
    assert_eq!(state(&s), before);
    f.free(u64::MAX / 4);
    seed(&k);
    let events = cores(&s);
    assert_eq!(events.len(), 2);
    assert_eq!(events[1].origin_seq, "2");
    assert_eq!(
        events[1].previous_event_hash,
        super::codec::hash_hex(&super::codec::journal_event_hash(
            &super::codec::encode_canonical(&events[0]).unwrap()
        ))
    );
    let expected = state(&s);
    drop(k);
    let s = reopen(&dir, s, &expected);
    let k = activate(&s, &f, P::synthetic_profile_a());
    seed(&k);
    assert_eq!(cores(&s)[2].origin_seq, "1");
}
#[test]
fn b06_generic_wrong_and_composed_demand_cannot_bypass_admission() {
    let (_dir, s) = fixture();
    let f = Fake::new();
    let k = activate(&s, &f, P::synthetic_profile_a());
    let before = state(&s);
    let mut called = false;
    rejection(
        k.write(|w| {
            called = true;
            w.create_capture(input("Unknown generic demand"))
        }),
        A::UnknownDemand,
    );
    assert!(!called);
    rejection(
        k.write_admitted(O::Capture, |w| w.create_project("Unknown domain growth")),
        A::UnknownDemand,
    );
    rejection(
        k.write_admitted(O::Capture, |w| {
            w.create_capture(input("First"))?;
            let _ = w.create_capture(input("Second"));
            Ok(())
        }),
        A::UnknownDemand,
    );
    assert_eq!(state(&s), before);
    clean(&s);
}
#[test]
fn b07_snapshot_all_stages_pressure_retry_and_ready_immutability() {
    let (dir, s) = fixture();
    let f = Fake::new();
    let k = activate(&s, &f, P::synthetic_profile_a());
    seed(&k);
    for op in [
        O::SnapshotAllocate,
        O::SnapshotCapture,
        O::SnapshotPack,
        O::SnapshotVerify,
    ] {
        let before = state(&s);
        f.free(0);
        let result = k.write_admitted(op, |w| match op {
            O::SnapshotAllocate => w.snapshot_allocate(SNAP, NOW),
            O::SnapshotCapture => w.snapshot_capture(SNAP, NOW).map(|_| ()),
            O::SnapshotPack => w.snapshot_pack(SNAP),
            _ => w.snapshot_verify(SNAP),
        });
        rejection(result, A::SpaceLow);
        assert_eq!(state(&s), before);
        f.free(u64::MAX / 4);
        k.write_admitted(op, |w| match op {
            O::SnapshotAllocate => w.snapshot_allocate(SNAP, NOW),
            O::SnapshotCapture => w.snapshot_capture(SNAP, NOW).map(|_| ()),
            O::SnapshotPack => w.snapshot_pack(SNAP),
            _ => w.snapshot_verify(SNAP),
        })
        .unwrap();
    }
    let expected = state(&s);
    assert!(matches!(
        k.write_admitted(O::SnapshotAbort, |w| w.snapshot_abort(SNAP)),
        Err(W::Snapshot(super::snapshot::SnapshotError::State))
    ));
    assert_eq!(state(&s), expected);
    assert_eq!(cores(&s).len(), 1);
    drop(k);
    let s = reopen(&dir, s, &expected);
    let k = activate(&s, &f, P::synthetic_profile_a());
    k.write_admitted(O::SnapshotVerify, |w| w.snapshot_verify(SNAP))
        .unwrap();
}
#[test]
fn b08_snapshot_abort_budget_and_metadata_quota_stay_independent() {
    let (_dir, s) = fixture();
    let f = Fake::new();
    let k = activate(&s, &f, P::synthetic_profile_a());
    seed(&k);
    k.write_admitted(O::SnapshotAllocate, |w| w.snapshot_allocate(SNAP, NOW))
        .unwrap();
    k.write_admitted(O::SnapshotCapture, |w| w.snapshot_capture(SNAP, NOW))
        .unwrap();
    let before = state(&s);
    f.free(0);
    rejection(
        k.write_admitted(O::SnapshotAbort, |w| w.snapshot_abort(SNAP)),
        A::SpaceLow,
    );
    assert_eq!(state(&s), before);
    f.free(u64::MAX / 4);
    k.write_admitted(O::SnapshotAbort, |w| w.snapshot_abort(SNAP))
        .unwrap();
    assert_eq!(
        s.query_i64_for_test("SELECT count(*) FROM sync_snapshot_rows"),
        0
    );
    assert_eq!(cores(&s).len(), 1);
    clean(&s);
    let (_dir, t) = fixture();
    let p = P::synthetic_profile_a();
    let limits = Limits {
        metadata: 65536,
        reserve: Some(65536 - 256),
        ..Limits::candidate()
    };
    let k = JournalKernel::activate_with_admission(
        &t,
        limits,
        p,
        Arc::new(f),
        ClaimPool::new(p.recovery),
    )
    .unwrap();
    let before = state(&t);
    assert!(matches!(
        k.write_admitted(O::SnapshotAllocate, |w| w.snapshot_allocate(SNAP, NOW)),
        Err(W::Journal(J::MetadataQuota))
    ));
    assert_eq!(state(&t), before);
}
#[test]
fn b09_main_growth_pager_full_and_preexisting_metadata_quota() {
    let (dir, s) = fixture();
    let f = Fake::new();
    let mut p = P::synthetic_profile_a();
    p.normal_main = 4096;
    let k = activate(&s, &f, p);
    seed(&k);
    let before = state(&s);
    let old = s.query_i64_for_test("PRAGMA max_page_count");
    let result = k.write_admitted(O::Capture, |w| w.create_capture(input(&"A".repeat(20000))));
    assert!(result.is_err());
    assert_eq!(
        result.unwrap_err().classification(),
        StorageFailure::StorageFull
    );
    assert_eq!(state(&s), before);
    assert_eq!(s.query_i64_for_test("PRAGMA max_page_count"), old);
    drop(k);
    reopen(&dir, s, &before);
    let (_dir, t) = fixture();
    let p = P::synthetic_profile_a();
    let k = JournalKernel::activate_with_admission(
        &t,
        Limits {
            metadata: 4096,
            ..Limits::candidate()
        },
        p,
        Arc::new(f),
        ClaimPool::new(p.recovery),
    )
    .unwrap();
    for _ in 0..40 {
        t.connection.lock().unwrap().execute("INSERT INTO sync_origins(origin_id,incarnation,status,opened_at,sealed_at) VALUES(?1,?2,'sealed',?3,?3)",rusqlite::params![uuid::Uuid::new_v4().to_string(),uuid::Uuid::new_v4().to_string(),NOW]).unwrap();
    }
    let before = state(&t);
    let mut called = false;
    assert!(matches!(
        k.write_admitted(O::Capture, |w| {
            called = true;
            w.create_capture(input("No SQL above logical quota"))
        }),
        Err(W::Journal(J::MetadataQuota))
    ));
    assert!(!called);
    assert_eq!(state(&t), before);
}
#[test]
fn b10_admitted_faults_preserve_disk_state_and_poison_only_on_unconfirmed_rollback() {
    for fault in [
        Fault::At(Stage::Domain),
        Fault::At(Stage::Commit),
        Fault::Rollback,
    ] {
        let (dir, s) = fixture();
        let f = Fake::new();
        let k = activate(&s, &f, P::synthetic_profile_a());
        seed(&k);
        let before = state(&s);
        let result = k.write_admitted_fault(O::Capture, fault, |w| {
            w.create_capture(input("LOGICAL_INJECTION"))
        });
        if fault == Fault::Rollback {
            assert!(matches!(result, Err(W::Journal(J::Rollback))));
            assert!(matches!(
                k.write_admitted(O::Capture, |w| w.create_capture(input("Poisoned"))),
                Err(W::Journal(J::Unavailable))
            ));
        } else {
            assert!(matches!(result, Err(W::Journal(J::Injected))));
        }
        drop(k);
        reopen(&dir, s, &before);
    }
}
#[test]
fn b11_admitted_bundle_and_snapshot_trigger_abort_recovery() {
    let (dir, s) = fixture();
    let f = Fake::new();
    let k = activate(&s, &f, P::synthetic_profile_a());
    seed(&k);
    let before = state(&s);
    s.execute_sql_for_test("CREATE TEMP TRIGGER megab_bundle BEFORE INSERT ON sync_bundles BEGIN SELECT RAISE(ABORT,'SQLITE_TRIGGER_ABORT'); END");
    assert!(matches!(
        k.write_admitted(O::Capture, |w| w.create_capture(input("Trigger abort"))),
        Err(W::Journal(J::BundleInsert))
    ));
    assert_eq!(state(&s), before);
    s.execute_sql_for_test("DROP TRIGGER megab_bundle");
    k.write_admitted(O::SnapshotAllocate, |w| w.snapshot_allocate(SNAP, NOW))
        .unwrap();
    let pending = state(&s);
    s.execute_sql_for_test("CREATE TEMP TRIGGER megab_capture BEFORE INSERT ON sync_snapshot_rows WHEN NEW.ordinal=1 AND (SELECT count(*) FROM sync_snapshot_rows)=1 BEGIN SELECT RAISE(ABORT,'SQLITE_TRIGGER_ABORT'); END");
    assert!(matches!(
        k.write_admitted(O::SnapshotCapture, |w| w.snapshot_capture(SNAP, NOW)),
        Err(W::Snapshot(super::snapshot::SnapshotError::Sql))
    ));
    assert_eq!(state(&s), pending);
    s.execute_sql_for_test("DROP TRIGGER megab_capture");
    k.write_admitted(O::SnapshotCapture, |w| w.snapshot_capture(SNAP, NOW))
        .unwrap();
    let before = state(&s);
    s.execute_sql_for_test("CREATE TEMP TRIGGER megab_pack BEFORE UPDATE ON sync_snapshots WHEN NEW.state='ready' BEGIN SELECT RAISE(ABORT,'SQLITE_TRIGGER_ABORT'); END");
    assert!(matches!(
        k.write_admitted(O::SnapshotPack, |w| w.snapshot_pack(SNAP)),
        Err(W::Snapshot(super::snapshot::SnapshotError::Sql))
    ));
    assert_eq!(state(&s), before);
    s.execute_sql_for_test("DROP TRIGGER megab_pack");
    drop(k);
    let s = reopen(&dir, s, &before);
    let k = activate(&s, &f, P::synthetic_profile_a());
    k.write_admitted(O::SnapshotPack, |w| w.snapshot_pack(SNAP))
        .unwrap();
    k.write_admitted(O::SnapshotVerify, |w| w.snapshot_verify(SNAP))
        .unwrap();
}
#[test]
fn b12_provider_identity_and_granularity_changes_reject_before_sql() {
    for change in 0..3 {
        let (_dir, s) = fixture();
        let f = Fake::new();
        let k = activate(&s, &f, P::synthetic_profile_a());
        let before = state(&s);
        {
            let mut value = f.0.lock().unwrap();
            let cap = value.as_mut().unwrap();
            match change {
                0 => cap.volume = "wrong".into(),
                1 => cap.file_identity += 1,
                _ => cap.allocation_unit = 0,
            }
        }
        let expected = if change == 2 {
            A::SpaceUnknown
        } else {
            A::VolumeMismatch
        };
        rejection(
            k.write_admitted(O::Capture, |w| w.create_capture(input("Bad binding"))),
            expected,
        );
        assert_eq!(state(&s), before);
    }
}
#[cfg(windows)]
#[test]
fn b13_windows_native_owned_volume_api_smoke_without_admission_approval() {
    let (_dir, s) = fixture();
    let c = s.connection.lock().unwrap();
    let location = OwnedLocation::bind(&s, &c).unwrap();
    let a = NativeCapacity.query(&location).unwrap();
    let b = NativeCapacity.query(&location).unwrap();
    assert!(a.allocation_unit > 0);
    assert!(!a.volume.is_empty());
    assert_eq!(a.volume, b.volume);
    assert_eq!(a.file_identity, b.file_identity);
    assert_eq!(a.allocation_unit, b.allocation_unit);
    eprintln!(
        "Windows native capacity smoke: available={} allocation_unit={}; observation only",
        a.available, a.allocation_unit
    );
}

#[test]
fn b14_logical_acknowledgement_loss_after_real_commit_requires_reconciliation() {
    let (dir, s) = fixture();
    let f = Fake::new();
    let k = activate(&s, &f, P::synthetic_profile_a());
    seed(&k);
    let first = cores(&s)[0].clone();
    // LOGICAL_INJECTION after successful SQLite COMMIT, NOT IOERR injection.
    let result = k.write_admitted_fault(O::Capture, Fault::AfterCommitUnknown, |w| {
        w.create_capture(input("Committed but caller received no success"))
    });
    assert!(matches!(result, Err(W::Journal(J::CommitUncertain(None)))));
    assert!(matches!(
        k.write_admitted(O::Capture, |w| w
            .create_capture(input("Must reconcile first"))),
        Err(W::Journal(J::Unavailable))
    ));
    let actual = cores(&s);
    assert_eq!(actual.len(), 2);
    assert_eq!(actual[0], first);
    assert_eq!(actual[1].origin_seq, "2");
    let committed = state(&s);
    drop(k);
    let s = reopen(&dir, s, &committed);
    // Reopening establishes actual committed identity/history. Do not blindly
    // retry the old request; a future public layer must reconcile that identity.
    assert_eq!(cores(&s), actual);
    let k = activate(&s, &f, P::synthetic_profile_a());
    seed(&k);
    assert_eq!(cores(&s).len(), 3);
}
#[test]
fn b15_numeric_error_classification_is_not_a_vfs_fault_execution() {
    use super::storage::SqliteCode;
    assert_eq!(
        J::PayloadQuota.classification(),
        StorageFailure::LogicalPayloadFull
    );
    assert_eq!(
        J::MetadataQuota.classification(),
        StorageFailure::LogicalMetadataFull
    );
    assert_eq!(
        J::BundleTooLarge.classification(),
        StorageFailure::OperationTooLarge
    );
    for (extended, expected) in [
        (13, StorageFailure::StorageFull),
        (10, StorageFailure::StorageIo),
        (266, StorageFailure::StorageIo),
    ] {
        let error = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(extended),
            Some("private SQL content must be discarded".into()),
        );
        let actual = J::from(error);
        assert_eq!(actual.classification(), expected);
        assert!(!format!("{actual:?}").contains("private"));
    }
    assert_eq!(
        J::CommitUncertain(Some(SqliteCode {
            primary: 10,
            extended: 266
        }))
        .classification(),
        StorageFailure::CommitUncertain
    );
    assert_eq!(
        J::RecoveryRequired.classification(),
        StorageFailure::RecoveryRequired
    );
}

#[test]
fn b16_capacity_loss_only_after_real_journal_finalization_rolls_back_everything() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Scheduled {
        calls: AtomicUsize,
        fail: AtomicUsize,
    }
    impl CapacityProvider for Scheduled {
        fn query(&self, _: &OwnedLocation) -> Result<Capacity, A> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(cap(if call == self.fail.load(Ordering::SeqCst) {
                0
            } else {
                u64::MAX / 4
            }))
        }
    }
    let (dir, s) = fixture();
    let p = P::synthetic_profile_a();
    let provider = Arc::new(Scheduled {
        calls: AtomicUsize::new(0),
        fail: AtomicUsize::new(usize::MAX),
    });
    let k = JournalKernel::activate_with_admission(
        &s,
        Limits::candidate(),
        p,
        provider.clone(),
        ClaimPool::new(p.recovery),
    )
    .unwrap();
    let before = state(&s);
    let fail_at = provider.calls.load(Ordering::SeqCst) + 3;
    // prepare, after domain SQL, then after actual finalizer append/heads/cleanup.
    provider.fail.store(fail_at, Ordering::SeqCst);
    rejection(
        k.write_admitted(O::Capture, |w| {
            w.create_capture(input("Finalization capacity loss"))
        }),
        A::SpaceLow,
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), fail_at);
    assert_eq!(state(&s), before);
    drop(k);
    reopen(&dir, s, &before);
}
#[test]
fn b17_snapshot_growth_budget_pager_full_preserves_pending_on_disk() {
    let (dir, s) = fixture();
    let f = Fake::new();
    let mut p = P::synthetic_profile_a();
    p.snapshot_main = 4096;
    let k = activate(&s, &f, p);
    k.write_admitted(O::Capture, |w| {
        w.create_capture(input(&format!("A{}", "\u{1}".repeat(19999))))
    })
    .unwrap();
    k.write_admitted(O::SnapshotAllocate, |w| w.snapshot_allocate(SNAP, NOW))
        .unwrap();
    let before = state(&s);
    let result = k.write_admitted(O::SnapshotCapture, |w| w.snapshot_capture(SNAP, NOW));
    assert!(result.is_err());
    assert_eq!(
        result.err().unwrap().classification(),
        StorageFailure::StorageFull
    );
    assert_eq!(state(&s), before);
    drop(k);
    reopen(&dir, s, &before);
}
