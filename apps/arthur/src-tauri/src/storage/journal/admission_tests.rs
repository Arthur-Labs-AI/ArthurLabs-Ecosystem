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
    let event_id = match result {
        Err(W::Journal(J::MutationUncertain {
            event_id,
            sqlite: None,
        })) => event_id,
        other => panic!("expected uncertain event identity, got {other:?}"),
    };
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
    let reconciled = JournalKernel::reconcile_event(&s, event_id, Limits::candidate().metadata)
        .unwrap()
        .unwrap();
    assert_eq!(reconciled.event_id, actual[1].event_id);
    assert_eq!(reconciled.seq, "2");
    assert!(
        JournalKernel::reconcile_event(&s, uuid::Uuid::new_v4(), Limits::candidate().metadata)
            .unwrap()
            .is_none()
    );
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

#[test]
fn b2_main_limit_remains_installed_at_real_commit_and_is_restored_afterwards() {
    let (_dir, s) = fixture();
    let f = Fake::new();
    let mut p = P::synthetic_profile_a();
    p.normal_main = 1024 * 1024;
    let k = activate(&s, &f, p);
    let old = s.query_i64_for_test("PRAGMA max_page_count");
    let pages = s.query_i64_for_test("PRAGMA page_count");
    let size = s.query_i64_for_test("PRAGMA page_size");
    let expected = (pages + (p.normal_main as i64 / size)).min(old);
    assert!(expected < old);
    k.write_admitted_fault(O::Capture, Fault::CommitLimit(expected), |w| {
        w.create_capture(input("Commit retains the pager growth ceiling"))
    })
    .unwrap();
    assert_eq!(s.query_i64_for_test("PRAGMA max_page_count"), old);
    clean(&s);
}

// MEGA B2: every candidate below still uses test-only synthetic VFS bounds.
// The real domain SQL, finalizer, pager and disk reopen are not simulated.
use super::writer_tests::{
    audit, candidate, change, content, decision_for, edge, evolution_parts, pending_for,
    proposal_for, snap,
};
fn admitted<T>(
    s: &CaptureStore,
    k: &JournalKernel<'_>,
    op: O,
    work: impl FnOnce(&mut super::writers::Writers<'_, '_>) -> super::writers::Result<T>,
) -> T {
    let before = cores(s).len();
    let (value, effects) = k
        .write_admitted(op, |w| {
            let value = work(w)?;
            Ok((value, w.observed_effect_count()))
        })
        .unwrap_or_else(|e| panic!("operation {op:?}: {e:?}"));
    assert_eq!(audit(s).len(), before + usize::from(effects > 0));
    clean(s);
    value
}
#[test]
fn b2_projects_distillation_revisions_relations_and_membership_use_exact_plans() {
    use crate::storage::integration_store::IntegrationWrite;
    use crate::storage::lineage_store::{CasOrigin, ExpectedRevision, SourceSpan};
    let (dir, s) = fixture();
    let f = Fake::new();
    let k = activate(&s, &f, P::synthetic_profile_a());
    let p = admitted(&s, &k, O::CreateProject, |w| w.create_project("B2"));
    admitted(&s, &k, O::RenameProject, |w| {
        w.rename_project(&p.id, "B2 renamed")
    });
    admitted(&s, &k, O::SetActiveProject, |w| w.set_active_project(&p.id));
    admitted(&s, &k, O::ArchiveProject, |w| w.archive_project(&p.id));
    admitted(&s, &k, O::RestoreProject, |w| w.restore_project(&p.id));
    let cap = admitted(&s, &k, O::Capture, |w| {
        w.create_capture(input("Alpha Beta Gamma"))
    });
    let objects = admitted(&s, &k, O::RecordDistillation, |w| {
        w.record_distillation(&cap.id, vec![candidate("A", 0, 4), candidate("B", 5, 9)])
    });
    let id = &objects[0].id;
    let root = s.current_revision_id_of(id).unwrap().unwrap();
    let edit = admitted(&s, &k, O::UpdateObject, |w| {
        w.update_object(id, change("Edit"))
    });
    let branch = admitted(&s, &k, O::CreateRevisionFrom, |w| {
        w.create_revision_from(id, &root, change("Branch"), false)
    });
    let merged = admitted(&s, &k, O::MergeRevisions, |w| {
        w.merge_revisions(id, &[edit.id, branch.id], content("Merged"), true)
    });
    let restored = admitted(&s, &k, O::RestoreRevision, |w| {
        w.restore_revision(id, &root, &merged.id)
    });
    admitted(&s, &k, O::ReviseIfCurrent, |w| {
        w.revise_if_current(
            &ExpectedRevision {
                object_id: id,
                project_id: &objects[0].project_id,
                base_revision_id: &restored.id,
            },
            content("CAS"),
            CasOrigin::UserEdit,
        )
    });
    admitted(&s, &k, O::ReviseFromCapture, |w| {
        w.revise_from_capture(
            id,
            None,
            SourceSpan {
                capture_id: cap.id.clone(),
                start: 5,
                end: 9,
            },
            change("From source"),
            true,
        )
    });
    let rel = admitted(&s, &k, O::CreateRelation, |w| {
        w.create_relation(edge("extends", id, &objects[1].id), "model")
    });
    admitted(&s, &k, O::RecordRelations, |w| {
        w.record_relations(vec![edge("depends_on", id, &objects[1].id)], "model")
    });
    let integration = IntegrationWrite {
        focus: snap(&s, id),
        context: vec![snap(&s, &objects[1].id)],
        remove: vec![rel.id],
        add: vec![edge("related_to", id, &objects[1].id)],
    };
    admitted(&s, &k, O::ApplyIntegration, |w| {
        w.apply_integration(integration)
    });
    admitted(&s, &k, O::MoveCapture, |w| w.move_capture(&cap.id, &p.id));
    admitted(&s, &k, O::MoveKnowledgeObject, |w| {
        w.move_knowledge_object(id, &p.id)
    });
    let before = state(&s);
    drop(k);
    reopen(&dir, s, &before);
}
#[test]
fn b2_identity_proposals_nested_resolution_expiry_and_evidence_are_single_events() {
    use crate::storage::{
        evidence_store::{EvidenceRole, NewEvidence},
        identity_store::{AcceptPendingInput, DecisionOutcome},
        proposal_store::{ClaimAction, ReviewAction, ReviewRequest},
    };
    let (dir, s) = fixture();
    let f = Fake::new();
    let k = activate(&s, &f, P::synthetic_profile_a());
    let cap = admitted(&s, &k, O::Capture, |w| {
        w.create_capture(input("Alpha Beta Gamma"))
    });
    let o = admitted(&s, &k, O::RecordDistillation, |w| {
        w.record_distillation(&cap.id, vec![candidate("Target", 0, 4)])
    });
    let id = &o[0].id;
    let base = s.current_revision_id_of(id).unwrap().unwrap();
    let mut decision = decision_for(&cap.id, 10, vec![]);
    decision.outcome = DecisionOutcome::New;
    decision.created_object_id = Some(id.clone());
    decision.audit = Default::default();
    admitted(&s, &k, O::RecordIdentityDecision, |w| {
        w.record_identity_decision(decision)
    });
    let stage = |n| {
        admitted(&s, &k, O::StageUncertainClaim, |w| {
            w.stage_uncertain_claim(pending_for(
                decision_for(&cap.id, n, vec![id.clone()]),
                vec![id.clone()],
            ))
        })
        .0
    };
    let claim = stage(0);
    admitted(&s, &k, O::DeferClaim, |w| w.defer_claim(&claim.id, None));
    admitted(&s, &k, O::ReopenClaim, |w| w.reopen_claim(&claim.id));
    let proposal = admitted(&s, &k, O::InsertProposal, |w| {
        w.insert_proposal(proposal_for(&claim.id, id, &base, "Proposed body", &cap.id))
    })
    .0;
    admitted(&s, &k, O::ResolveClaim, |w| {
        w.resolve_claim(&claim.id, ClaimAction::Defer { due_at: None })
    });
    admitted(&s, &k, O::ResolveClaim, |w| {
        w.resolve_claim(&claim.id, ClaimAction::Reopen)
    });
    admitted(&s, &k, O::ReviewProposal, |w| {
        w.review_proposal(ReviewRequest {
            proposal_id: proposal.id,
            action: ReviewAction::Approve,
            reviewed_revision_id: Some(base.clone()),
        })
    });
    let automatic = s.current_revision_id_of(id).unwrap().unwrap();
    admitted(&s, &k, O::AttachRevisionEvidence, |w| {
        w.attach_revision_evidence(
            &automatic,
            vec![NewEvidence {
                capture_id: cap.id.clone(),
                source_start: 5,
                source_end: 9,
                role: EvidenceRole::Asserts,
                retracts: None,
                interpretation_label: None,
            }],
        )
    });
    let separate = stage(1);
    admitted(&s, &k, O::SeparatePendingClaim, |w| {
        w.separate_pending_claim(&separate.id, "user")
    });
    let accept = stage(2);
    admitted(&s, &k, O::AcceptPendingClaim, |w| {
        w.accept_pending_claim(AcceptPendingInput {
            pending_id: accept.id,
            target_object_id: id.clone(),
            expected_base_revision_id: automatic.clone(),
            content: content("Accepted"),
            role: EvidenceRole::Asserts,
            retracts: None,
            interpretation_label: None,
        })
    });
    let due = stage(3);
    admitted(&s, &k, O::DeferClaim, |w| {
        w.defer_claim(&due.id, Some("2026-10-22T00:00:00Z"))
    });
    let count = admitted(&s, &k, O::ExecuteDueExpiry, |w| {
        w.execute_due_expiry(super::expiry::DormantExpiryRequest::candidate(NOW, 32).unwrap())
    });
    assert!(!count.is_empty());
    let before = state(&s);
    drop(k);
    reopen(&dir, s, &before);
}
#[test]
fn b2_evolution_has_one_explicit_budget_for_its_shared_domain_composition() {
    use crate::distillation::evolution::{Committed, EvolutionLimits, Plan, Planned};
    let (dir, s) = fixture();
    let f = Fake::new();
    let k = activate(&s, &f, P::synthetic_profile_a());
    let cap = admitted(&s, &k, O::Capture, |w| {
        w.create_capture(input("Alpha Beta Gamma"))
    });
    let out = admitted(&s, &k, O::EvolveCapture, |w| {
        w.evolve_capture(
            &cap.id,
            vec![candidate("Fresh", 0, 4)],
            vec![Planned {
                plan: Plan::New(None),
                parts: evolution_parts("test", vec![]),
            }],
            &EvolutionLimits::default(),
            &|| true,
            false,
        )
    });
    assert!(matches!(out, Committed::Fresh { .. }));
    let before = state(&s);
    // A caller cannot relabel another top-level writer, even within one family.
    rejection(
        k.write_admitted(O::CreateProject, |w| {
            let _ = w.rename_project("missing", "Wrong");
            Ok(())
        }),
        A::UnknownDemand,
    );
    rejection(
        k.write_admitted(O::EvolveCapture, |w| w.create_capture(input("Wrong"))),
        A::UnknownDemand,
    );
    rejection(
        k.write_admitted(O::CreateProject, |w| {
            w.create_project("First")?;
            let _ = w.create_project("Second");
            Ok(())
        }),
        A::UnknownDemand,
    );
    assert_eq!(state(&s), before);
    drop(k);
    reopen(&dir, s, &before);
}
#[test]
fn b2_real_commit_busy_rolls_back_full_state_releases_claim_and_can_retry() {
    let (dir, s) = fixture();
    let f = Fake::new();
    let p = P::synthetic_profile_a();
    let claims = ClaimPool::new(p.recovery);
    let k = JournalKernel::activate_with_admission(
        &s,
        Limits::candidate(),
        p,
        Arc::new(f.clone()),
        claims.clone(),
    )
    .unwrap();
    seed(&k);
    s.execute_sql_for_test("PRAGMA busy_timeout=0; PRAGMA cache_spill=OFF");
    let old = s.query_i64_for_test("PRAGMA max_page_count");
    let before = state(&s);
    let reader = rusqlite::Connection::open(dir.path().join("arthur.db")).unwrap();
    reader
        .execute_batch("BEGIN; SELECT * FROM captures")
        .unwrap();
    // REAL_COMMIT_FAILURE: native DELETE VFS cannot upgrade to EXCLUSIVE
    // while the actual second connection holds SHARED. Not IOERR or FULL.
    let result = k.write_admitted(O::Capture, |w| w.create_capture(input("Blocked COMMIT")));
    assert!(matches!(
        result,
        Err(W::Journal(J::CommitFailure(super::storage::SqliteCode {
            primary: 5,
            ..
        })))
    ));
    reader.execute_batch("ROLLBACK").unwrap();
    drop(reader);
    assert_eq!(s.query_i64_for_test("PRAGMA max_page_count"), old);
    assert_eq!(state(&s), before);
    // An exact capacity boundary proves the prior transaction released claims.
    let image = s.query_i64_for_test("PRAGMA page_count") as u64
        * s.query_i64_for_test("PRAGMA page_size") as u64;
    let required = p
        .evaluate(
            &cap(u64::MAX / 4),
            "synthetic-volume",
            p.demand(O::Capture, image, "delete").unwrap(),
            0,
        )
        .unwrap()
        .required;
    f.free(required);
    seed(&k);
    assert_eq!(cores(&s).last().unwrap().origin_seq, "2");
    let after = state(&s);
    drop(k);
    reopen(&dir, s, &after);
}

#[test]
fn b2_vfs_full_and_ioerr_at_actual_commit_poison_and_reconcile_after_reopen() {
    use super::fault_io::{Fault as IoFault, FileFault};
    for fault in [IoFault::WriteFull, IoFault::SyncIo] {
        let (dir, s) = fixture();
        let f = Fake::new();
        let k = activate(&s, &f, P::synthetic_profile_a());
        seed(&k);
        s.execute_sql_for_test("PRAGMA cache_spill=OFF");
        let before = state(&s);
        let old = s.query_i64_for_test("PRAGMA max_page_count");
        // One guard, one live store/connection, no replacement or VFS changes;
        // dropped explicitly before the kernel and store can be closed.
        let shim = unsafe { FileFault::install(&s, fault) };
        let result = k.write_admitted(O::Capture, |w| {
            w.create_capture(input("VFS fault at actual main write or sync"))
        });
        assert_eq!(shim.hits(), 1, "must exercise actual VFS callback");
        drop(shim);
        let (event_id, code) = match result {
            Err(W::Journal(J::MutationUncertain {
                event_id,
                sqlite: Some(code),
            })) => (event_id, code),
            other => panic!("expected actual COMMIT failure, got {other:?}"),
        };
        match fault {
            IoFault::WriteFull => assert_eq!(
                (code.primary, code.extended),
                (13, rusqlite::ffi::SQLITE_FULL)
            ),
            IoFault::SyncIo => assert_eq!(
                (code.primary, code.extended),
                (10, rusqlite::ffi::SQLITE_IOERR_FSYNC)
            ),
        }
        assert_eq!(s.query_i64_for_test("PRAGMA max_page_count"), old);
        assert!(matches!(
            k.write_admitted(O::Capture, |w| w.create_capture(input("No blind retry"))),
            Err(W::Journal(J::Unavailable))
        ));
        assert_eq!(state(&s), before);
        drop(k);
        let s = reopen(&dir, s, &before);
        assert!(
            JournalKernel::reconcile_event(&s, event_id, Limits::candidate().metadata)
                .unwrap()
                .is_none()
        );
        let k = activate(&s, &f, P::synthetic_profile_a());
        seed(&k);
        audit(&s);
    }
}

#[test]
fn b2_empty_or_raw_capability_cannot_claim_a_typed_adapter_budget() {
    let (_dir, s) = fixture();
    let f = Fake::new();
    let k = activate(&s, &f, P::synthetic_profile_a());
    let before = state(&s);
    assert!(matches!(
        k.run_for(O::Capture, |_| Ok(())),
        Err(J::Admission(A::UnknownDemand))
    ));
    assert!(matches!(
        k.run_for(O::Capture, |tx| {
            tx.sql()
                .execute_batch("CREATE TABLE b2_unregistered(id INTEGER)")?;
            Ok(())
        }),
        Err(J::Admission(A::UnknownDemand))
    ));
    assert_eq!(state(&s), before);
}
#[cfg(windows)]
#[test]
fn b2_windows_capacity_missing_replaced_database_has_no_identity_fallback() {
    let (dir, s) = fixture();
    let location = OwnedLocation::bind(&s, &s.connection.lock().unwrap()).unwrap();
    let initial = NativeCapacity.query(&location).unwrap();
    drop(s);
    // All paths are literal children of this disposable synthetic fixture.
    let database = dir.path().join("arthur.db");
    let saved = dir.path().join("saved.db");
    std::fs::rename(&database, &saved).unwrap();
    assert_eq!(NativeCapacity.query(&location), Err(A::SpaceUnknown));
    std::fs::copy(&saved, &database).unwrap();
    let replaced = NativeCapacity.query(&location).unwrap();
    assert_eq!(initial.volume, replaced.volume);
    assert_ne!(initial.file_identity, replaced.file_identity);
    assert_eq!(initial.allocation_unit, replaced.allocation_unit);
}
#[test]
fn b2_pager_contract_reuses_free_pages_and_repeatedly_restores_commit_and_full() {
    use super::admission_session::PhysicalAdmission;
    let (dir, s) = fixture();
    let f = Fake::new();
    let mut p = P::synthetic_profile_a();
    p.normal_main = 4096;
    // Isolated real-pager contract fixture, not an authoritative domain writer.
    s.execute_sql_for_test("CREATE TABLE b2_pages(id INTEGER PRIMARY KEY,data BLOB); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100) INSERT INTO b2_pages SELECT x,zeroblob(4096) FROM n; DELETE FROM b2_pages");
    let before = state(&s);
    {
        let mut c = s.connection.lock().unwrap();
        let physical =
            PhysicalAdmission::bind(&s, &c, p, Arc::new(f), ClaimPool::new(p.recovery)).unwrap();
        let old: i64 = c
            .query_row("PRAGMA max_page_count", [], |r| r.get(0))
            .unwrap();
        let pages: i64 = c.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
        for _ in 0..3 {
            let tx = c.transaction().unwrap();
            let mut budget = physical.prepare(&tx, O::Capture).unwrap();
            tx.execute("INSERT INTO b2_pages VALUES(1,zeroblob(65536))", [])
                .unwrap();
            assert_eq!(
                tx.query_row("PRAGMA page_count", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                pages
            );
            budget.check(&tx).unwrap();
            tx.execute_batch("COMMIT").unwrap();
            budget.restore(&tx).unwrap();
            drop(tx);
            c.execute("DELETE FROM b2_pages", []).unwrap();
            assert_eq!(
                c.query_row("PRAGMA max_page_count", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                old
            );
        }
        let tx = c.transaction().unwrap();
        let budget = physical.prepare(&tx, O::Capture).unwrap();
        let error = tx
            .execute("INSERT INTO b2_pages VALUES(1,zeroblob(2097152))", [])
            .unwrap_err();
        assert!(
            matches!(error,rusqlite::Error::SqliteFailure(code,_) if code.extended_code==rusqlite::ffi::SQLITE_FULL)
        );
        if !tx.is_autocommit() {
            tx.execute_batch("ROLLBACK").unwrap();
        }
        budget.restore(&tx).unwrap();
        assert_eq!(
            tx.query_row("PRAGMA max_page_count", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            old
        );
    }
    assert_eq!(state(&s), before);
    reopen(&dir, s, &before);
}

#[test]
fn b2_distillation_pager_full_keeps_domain_core_and_codes_atomic_on_disk() {
    let (dir, s) = fixture();
    let f = Fake::new();
    let mut p = P::synthetic_profile_a();
    p.normal_main = 4096;
    let k = activate(&s, &f, p);
    let capture = k
        .write_admitted(O::Capture, |w| w.create_capture(input("Alpha Beta Gamma")))
        .unwrap();
    let before = state(&s);
    let old = s.query_i64_for_test("PRAGMA max_page_count");
    let objects = (0..12)
        .map(|i| {
            let mut row = candidate(&format!("Object {i}"), 0, 4);
            row.body = "B".repeat(2000);
            row
        })
        .collect();
    let error = k
        .write_admitted(O::RecordDistillation, |w| {
            w.record_distillation(&capture.id, objects)
        })
        .unwrap_err();
    assert_eq!(error.classification(), StorageFailure::StorageFull);
    assert_eq!(state(&s), before);
    assert_eq!(s.query_i64_for_test("PRAGMA max_page_count"), old);
    drop(k);
    reopen(&dir, s, &before);
}
