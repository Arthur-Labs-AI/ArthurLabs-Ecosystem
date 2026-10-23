//! C/G4: actual disposable SQLite I/O; never actual OS exhaustion certification.
use super::{
    admission::{AdmissionError as A, Capacity, StorageDemand as D, MIB},
    capacity::{CapacityProvider, NativeCapacity, OwnedLocation},
    storage::{Fault, JournalError as J, Stage},
    writers::WriterError as W,
};
use super::{
    admission::{ClaimPool, Operation as O, PhysicalAdmissionPolicy as P},
    owned_vfs::*,
    storage::{JournalKernel, Limits},
    storage_tests::{clean, cores, state, upgrade},
};
use crate::storage::{
    capture_store::{CaptureStore, CreateCaptureInput},
    ownership::DataRootOwnership,
};
use rusqlite::ffi;
use std::sync::Arc;
#[derive(Clone)]
struct SimulatedCapacity;
impl CapacityProvider for SimulatedCapacity {
    fn query(&self, _: &OwnedLocation) -> Result<Capacity, A> {
        Ok(Capacity {
            available: 1024 * MIB,
            allocation_unit: 4096,
            volume: "simulated-only".into(),
            file_identity: 1,
        })
    }
}
fn activate(s: &CaptureStore, p: P) -> JournalKernel<'_> {
    JournalKernel::activate_with_admission(
        s,
        Limits::candidate(),
        p,
        Arc::new(SimulatedCapacity),
        ClaimPool::new(p.recovery),
    )
    .unwrap()
}
fn reopen(
    dir: &tempfile::TempDir,
    vfs: &Arc<OwnedVfs>,
    s: CaptureStore,
    expected: &Vec<(String, Vec<Vec<rusqlite::types::Value>>)>,
) -> CaptureStore {
    clean(&s);
    assert_eq!(&state(&s), expected);
    drop(s);
    let root = dir.path().canonicalize().unwrap();
    let s = CaptureStore::open_observed(
        DataRootOwnership::try_acquire(&root).unwrap(),
        vfs.clone(),
        true,
    )
    .unwrap();
    clean(&s);
    assert_eq!(&state(&s), expected);
    s
}
fn fixture() -> (tempfile::TempDir, Arc<OwnedVfs>, CaptureStore) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let vfs = OwnedVfs::new(&root);
    let s = CaptureStore::open_observed(
        DataRootOwnership::try_acquire(&root).unwrap(),
        vfs.clone(),
        false,
    )
    .unwrap();
    upgrade(&s);
    vfs.clear_records();
    (dir, vfs, s)
}
fn input() -> CreateCaptureInput {
    CreateCaptureInput {
        source: "text".into(),
        content: "bounded synthetic capture".into(),
        project_id: None,
    }
}
#[test]
fn c01_owned_vfs_observes_real_main_journal_io_and_leaves_default_connections_alone() {
    let (_dir, vfs, s) = fixture();
    let k = JournalKernel::activate(&s).unwrap();
    k.write(|w| w.create_capture(input())).unwrap();
    let records = vfs.records();
    assert!(records.iter().any(|r| r.class == Class::Main
        && r.boundary == Boundary::Write
        && r.file > 0
        && r.end > 0));
    assert!(records
        .iter()
        .any(|r| r.class == Class::Journal && r.boundary == Boundary::Open));
    assert!(records
        .iter()
        .any(|r| r.class == Class::Journal && r.boundary == Boundary::Sync));
    assert!(records
        .iter()
        .any(|r| r.class == Class::Journal && r.boundary == Boundary::Close));
    let other = tempfile::tempdir().unwrap();
    let c = rusqlite::Connection::open(other.path().join("other.db")).unwrap();
    c.execute_batch("CREATE TABLE unaffected(id INTEGER);INSERT INTO unaffected VALUES(1)")
        .unwrap();
    assert_eq!(records.len(), vfs.records().len());
    clean(&s);
}
#[cfg(windows)]
#[test]
fn c04_readonly_owned_database_fails_capacity_revalidation() {
    let (_dir, _vfs, s) = fixture();
    let location = {
        let c = s.connection.lock().unwrap();
        super::capacity::OwnedLocation::bind(&s, &c).unwrap()
    };
    let path = location.database();
    let before = std::fs::metadata(path).unwrap().permissions();
    let mut readonly = before.clone();
    readonly.set_readonly(true);
    std::fs::set_permissions(path, readonly).unwrap();
    let result = location.validate();
    std::fs::set_permissions(path, before).unwrap();
    assert!(result.is_err());
}
#[test]
fn c02_anonymous_temp_and_subjournal_open_are_explicitly_denied() {
    let (_dir, vfs, s) = fixture();
    let c = s.connection.lock().unwrap();
    let _budget = IoBudget::begin(
        &c,
        D {
            main: Some(MIB),
            journal: Some(MIB),
            scratch: Some(MIB),
        },
        4096,
    )
    .unwrap();
    let name = std::ffi::CString::new(vfs.name()).unwrap();
    let v = unsafe { ffi::sqlite3_vfs_find(name.as_ptr()) };
    for (flag, class) in [
        (ffi::SQLITE_OPEN_TEMP_DB, Class::Temp),
        (ffi::SQLITE_OPEN_SUBJOURNAL, Class::Subjournal),
        (ffi::SQLITE_OPEN_WAL, Class::Other),
    ] {
        let raw =
            unsafe { ffi::sqlite3_malloc64((*v).szOsFile as u64) }.cast::<ffi::sqlite3_file>();
        let mut out = 0;
        let rc = unsafe {
            ((*v).xOpen.unwrap())(
                v,
                std::ptr::null(),
                raw,
                flag | ffi::SQLITE_OPEN_DELETEONCLOSE
                    | ffi::SQLITE_OPEN_READWRITE
                    | ffi::SQLITE_OPEN_CREATE,
                &mut out,
            )
        };
        assert_eq!(rc, ffi::SQLITE_CANTOPEN);
        assert!(unsafe { (*raw).pMethods.is_null() });
        unsafe {
            ffi::sqlite3_free(raw.cast());
        }
        assert!(vfs.records().iter().any(|r| r.class == class
            && r.boundary == Boundary::Open
            && r.rc == ffi::SQLITE_CANTOPEN));
    }
}
#[test]
fn c02_actual_sqlite_temp_spill_cannot_allocate_outside_the_owned_root() {
    let (dir, vfs, s) = fixture();
    let k = activate(&s, P::instrumented_profile_a());
    let before = state(&s);
    let result=k.run_for(O::Capture,|tx|{tx.admit_operation(O::Capture)?;tx.sql().execute_batch("PRAGMA temp_store=FILE; PRAGMA temp.cache_size=1; CREATE TEMP TABLE scratch(body BLOB); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<128) INSERT INTO scratch SELECT zeroblob(16384) FROM n;")?;Ok(())});
    assert!(result.is_err());
    assert!(vfs
        .records()
        .iter()
        .any(|r| r.class == Class::Temp && r.rc == ffi::SQLITE_CANTOPEN));
    drop(k);
    reopen(&dir, &vfs, s, &before);
}
#[cfg(windows)]
#[test]
fn c03_actual_windows_capacity_and_allocation_observed_without_certification() {
    let (_dir, vfs, s) = fixture();
    let location = {
        let c = s.connection.lock().unwrap();
        OwnedLocation::bind(&s, &c).unwrap()
    };
    let a = NativeCapacity.query(&location).unwrap();
    let b = NativeCapacity.query(&location).unwrap();
    assert!(!a.volume.is_empty());
    assert!(a.allocation_unit > 0);
    assert_eq!(a.file_identity, b.file_identity);
    assert_eq!(a.volume, b.volume);
    let p = P::instrumented_profile_a();
    let k = JournalKernel::activate_with_admission(
        &s,
        Limits::candidate(),
        p,
        Arc::new(NativeCapacity),
        ClaimPool::new(p.recovery),
    )
    .unwrap();
    k.write_admitted(O::Capture, |w| w.create_capture(input()))
        .unwrap();
    assert!(vfs
        .records()
        .iter()
        .any(|r| r.boundary == Boundary::Write && r.allocation.is_some()));
    println!("ACTUAL_WINDOWS_NTFS: caller_available={} allocation_unit={}; allocation measured, physical bound UNVERIFIED",a.available,a.allocation_unit);
}
#[test]
fn c05_unknown_release_bounds_and_missing_vfs_cannot_activate() {
    let (_dir, _vfs, s) = fixture();
    let before = state(&s);
    let p = P::profile_a_candidate();
    assert!(matches!(
        JournalKernel::activate_with_admission(
            &s,
            Limits::candidate(),
            p,
            Arc::new(SimulatedCapacity),
            ClaimPool::new(p.recovery)
        ),
        Err(J::Admission(A::UnverifiedBounds))
    ));
    assert_eq!(state(&s), before);
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let s = CaptureStore::open_owned(DataRootOwnership::try_acquire(&root).unwrap()).unwrap();
    upgrade(&s);
    let p = P::instrumented_profile_a();
    assert!(matches!(
        JournalKernel::activate_with_admission(
            &s,
            Limits::candidate(),
            p,
            Arc::new(SimulatedCapacity),
            ClaimPool::new(p.recovery)
        ),
        Err(J::Admission(A::UnverifiedBounds))
    ));
    assert_eq!(s.query_i64_for_test("SELECT count(*) FROM sync_origins"), 0);
}
#[test]
fn c06_actual_write_and_truncate_attempts_are_refused_before_native_growth() {
    let (dir, vfs, s) = fixture();
    let before = state(&s);
    {
        let c = s.connection.lock().unwrap();
        let budget = IoBudget::begin(
            &c,
            D {
                main: Some(0),
                journal: Some(MIB),
                scratch: Some(0),
            },
            4096,
        )
        .unwrap();
        let mut file: *mut ffi::sqlite3_file = std::ptr::null_mut();
        assert_eq!(
            unsafe {
                ffi::sqlite3_file_control(
                    c.handle(),
                    c"main".as_ptr(),
                    ffi::SQLITE_FCNTL_FILE_POINTER,
                    (&mut file as *mut *mut ffi::sqlite3_file).cast(),
                )
            },
            ffi::SQLITE_OK
        );
        let mut size = 0;
        assert_eq!(
            unsafe { ((*(*file).pMethods).xFileSize.unwrap())(file, &mut size) },
            ffi::SQLITE_OK
        );
        // Native preallocation hints must not bypass xWrite/xTruncate accounting.
        for op in [
            ffi::SQLITE_FCNTL_SIZE_HINT,
            ffi::SQLITE_FCNTL_CHUNK_SIZE,
            ffi::SQLITE_FCNTL_MMAP_SIZE,
        ] {
            let mut hint = size + MIB as i64;
            assert_eq!(
                unsafe {
                    ((*(*file).pMethods).xFileControl.unwrap())(
                        file,
                        op,
                        (&mut hint as *mut i64).cast(),
                    )
                },
                ffi::SQLITE_NOTFOUND
            );
        }
        assert_eq!(
            unsafe {
                ((*(*file).pMethods).xWrite.unwrap())(file, [0u8; 4096].as_ptr().cast(), 4096, size)
            },
            ffi::SQLITE_FULL
        );
        assert_eq!(
            unsafe { ((*(*file).pMethods).xTruncate.unwrap())(file, size + 4096) },
            ffi::SQLITE_FULL
        );
        assert_eq!(budget.check(), Err(A::GrowthExceeded));
        assert_eq!(vfs.peak(), Some([0; 3]));
        let mut after = 0;
        unsafe { ((*(*file).pMethods).xFileSize.unwrap())(file, &mut after) };
        assert_eq!(size, after);
    }
    reopen(&dir, &vfs, s, &before);
}
#[test]
fn c06_panic_unwinds_the_single_budget_and_registration_outlives_native_close() {
    let (dir, v, s) = fixture();
    let k = activate(&s, P::instrumented_profile_a());
    let before = state(&s);
    let count = v.counts();
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| k.write_admitted(
            O::Capture,
            |w| -> Result<(), W> {
                w.create_capture(input())?;
                panic!("deliberate test unwind")
            }
        )))
        .is_err()
    );
    assert_eq!(v.counts(), (count.0 + 1, count.1 + 1));
    drop(k);
    drop(s);
    let name = std::ffi::CString::new(v.name()).unwrap();
    let weak = Arc::downgrade(&v);
    drop(v);
    assert!(weak.upgrade().is_none());
    assert!(unsafe { ffi::sqlite3_vfs_find(name.as_ptr()) }.is_null());
    let root = dir.path().canonicalize().unwrap();
    let v = OwnedVfs::new(&root);
    let s = CaptureStore::open_observed(DataRootOwnership::try_acquire(&root).unwrap(), v, true)
        .unwrap();
    assert_eq!(state(&s), before);
    clean(&s);
}
#[test]
fn c07_journal_extent_cannot_borrow_the_main_pager_limit() {
    let (dir, vfs, s) = fixture();
    let mut p = P::instrumented_profile_a();
    p.journal_ceiling = Some(0);
    let before = state(&s);
    let result = JournalKernel::activate_with_admission(
        &s,
        Limits::candidate(),
        p,
        Arc::new(SimulatedCapacity),
        ClaimPool::new(p.recovery),
    );
    assert!(result.is_err());
    drop(result);
    assert!(vfs.records().iter().any(|r| r.class == Class::Journal
        && r.boundary == Boundary::Write
        && r.rc == ffi::SQLITE_FULL));
    reopen(&dir, &vfs, s, &before);
}
#[test]
fn c08_nested_writer_composition_has_one_io_session_through_commit() {
    let (_dir, vfs, s) = fixture();
    let k = activate(&s, P::instrumented_profile_a());
    let before = vfs.counts();
    k.write_admitted(O::Capture, |w| w.create_capture(input()))
        .unwrap();
    assert_eq!(vfs.counts(), (before.0 + 1, before.1 + 1));
    let records = vfs.records();
    let last = records
        .iter()
        .rev()
        .find(|r| r.class == Class::Main && r.boundary == Boundary::Sync)
        .unwrap();
    assert!(last.session > 0);
    assert_eq!(cores(&s).len(), 1);
    clean(&s);
}
// Each call includes real finalization/COMMIT; nested helpers cannot start a
// second IoBudget (begin rejects an already active token).
fn one<T>(
    v: &OwnedVfs,
    k: &JournalKernel<'_>,
    op: O,
    work: impl FnOnce(&mut super::writers::Writers<'_, '_>) -> Result<T, W>,
) -> T {
    let before = v.counts();
    let out = k
        .write_admitted(op, work)
        .unwrap_or_else(|e| panic!("{op:?}: {e:?}"));
    assert_eq!(v.counts(), (before.0 + 1, before.1 + 1));
    out
}
#[test]
fn c08_review_expiry_integration_and_evolution_share_the_outer_io_token() {
    use super::writer_tests::{
        candidate, decision_for, edge, evolution_parts, pending_for, proposal_for, snap,
    };
    use crate::{
        distillation::evolution::{EvolutionLimits, Plan, Planned},
        storage::{
            evidence_store::{EvidenceRole, NewEvidence},
            integration_store::IntegrationWrite,
            proposal_store::{ReviewAction, ReviewRequest},
        },
    };
    let (dir, v, s) = fixture();
    let k = activate(&s, P::instrumented_profile_a());
    let mut i = input();
    i.content = "Alpha Beta Gamma".into();
    let cap = one(&v, &k, O::Capture, |w| w.create_capture(i));
    let objects = one(&v, &k, O::RecordDistillation, |w| {
        w.record_distillation(&cap.id, vec![candidate("A", 0, 4), candidate("B", 5, 9)])
    });
    let id = &objects[0].id;
    let base = s.current_revision_id_of(id).unwrap().unwrap();
    let claim = one(&v, &k, O::StageUncertainClaim, |w| {
        w.stage_uncertain_claim(pending_for(
            decision_for(&cap.id, 0, vec![id.clone()]),
            vec![id.clone()],
        ))
    })
    .0;
    let prop = one(&v, &k, O::InsertProposal, |w| {
        w.insert_proposal(proposal_for(
            &claim.id,
            id,
            &base,
            "Reviewed synthetic body",
            &cap.id,
        ))
    })
    .0;
    let n = cores(&s).len();
    one(&v, &k, O::ReviewProposal, |w| {
        w.review_proposal(ReviewRequest {
            proposal_id: prop.id,
            action: ReviewAction::Approve,
            reviewed_revision_id: Some(base),
        })
    });
    assert_eq!(cores(&s).len(), n + 1);
    let automatic = s.current_revision_id_of(id).unwrap().unwrap();
    one(&v, &k, O::AttachRevisionEvidence, |w| {
        w.attach_revision_evidence(
            &automatic,
            (0..12)
                .map(|n| NewEvidence {
                    capture_id: cap.id.clone(),
                    source_start: n,
                    source_end: n + 2,
                    role: EvidenceRole::Asserts,
                    retracts: None,
                    interpretation_label: None,
                })
                .collect(),
        )
    });
    let due = one(&v, &k, O::StageUncertainClaim, |w| {
        w.stage_uncertain_claim(pending_for(
            decision_for(&cap.id, 1, vec![id.clone()]),
            vec![id.clone()],
        ))
    })
    .0;
    one(&v, &k, O::DeferClaim, |w| {
        w.defer_claim(&due.id, Some("2026-10-22T00:00:00Z"))
    });
    one(&v, &k, O::ExecuteDueExpiry, |w| {
        w.execute_due_expiry(super::expiry::DormantExpiryRequest::candidate(NOW, 32).unwrap())
    });
    let integration = IntegrationWrite {
        focus: snap(&s, id),
        context: vec![snap(&s, &objects[1].id)],
        remove: vec![],
        add: vec![edge("related_to", id, &objects[1].id)],
    };
    one(&v, &k, O::ApplyIntegration, |w| {
        w.apply_integration(integration)
    });
    let fresh = one(&v, &k, O::Capture, |w| w.create_capture(input()));
    one(&v, &k, O::EvolveCapture, |w| {
        w.evolve_capture(
            &fresh.id,
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
    let expected = state(&s);
    drop(k);
    reopen(&dir, &v, s, &expected);
}
#[cfg(windows)]
#[test]
fn c04_native_root_replacement_is_refused_and_original_history_survives() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("owned");
    std::fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let v = OwnedVfs::new(&root);
    let s = CaptureStore::open_observed(
        DataRootOwnership::try_acquire(&root).unwrap(),
        v.clone(),
        false,
    )
    .unwrap();
    upgrade(&s);
    let k = activate(&s, P::instrumented_profile_a());
    one(&v, &k, O::Capture, |w| w.create_capture(input()));
    let expected = state(&s);
    drop(k);
    let location = {
        let c = s.connection.lock().unwrap();
        OwnedLocation::bind(&s, &c).unwrap()
    };
    let original = NativeCapacity.query(&location).unwrap();
    drop(s);
    drop(v);
    let saved = parent.path().join("saved");
    std::fs::rename(&root, &saved).unwrap();
    std::fs::create_dir(&root).unwrap();
    std::fs::copy(saved.join("arthur.db"), root.join("arthur.db")).unwrap();
    assert_eq!(location.validate(), Err(A::VolumeMismatch));
    assert!(NativeCapacity.query(&location).is_err());
    let saved = saved.canonicalize().unwrap();
    let v = OwnedVfs::new(&saved);
    let s = CaptureStore::open_observed(DataRootOwnership::try_acquire(&saved).unwrap(), v, true)
        .unwrap();
    let moved = {
        let c = s.connection.lock().unwrap();
        OwnedLocation::bind(&s, &c).unwrap()
    };
    assert_eq!(
        NativeCapacity.query(&moved).unwrap().file_identity,
        original.file_identity
    );
    assert_eq!(state(&s), expected);
    clean(&s);
}
#[test]
fn c08_maximum_capture_distillation_large_revisions_and_freelist_reuse() {
    use super::writer_tests::{candidate, content};
    use crate::storage::{knowledge_store::MAX_OBJECTS_PER_DISTILLATION, lineage_store::Changes};
    let (dir, v, s) = fixture();
    let k = activate(&s, P::instrumented_profile_a());
    let mut i = input();
    i.content = "🦀".repeat(crate::storage::capture_store::MAX_CAPTURE_CONTENT_CHARS);
    let cap = one(&v, &k, O::Capture, |w| w.create_capture(i));
    let objects = one(&v, &k, O::RecordDistillation, |w| {
        w.record_distillation(
            &cap.id,
            (0..MAX_OBJECTS_PER_DISTILLATION)
                .map(|n| {
                    let mut o = candidate(&format!("Synthetic {n}"), 0, 4);
                    o.body = "🦀".repeat(2_000);
                    o
                })
                .collect(),
        )
    });
    assert_eq!(objects.len(), MAX_OBJECTS_PER_DISTILLATION);
    let id = &objects[0].id;
    let base = s.current_revision_id_of(id).unwrap().unwrap();
    let edit = one(&v, &k, O::UpdateObject, |w| {
        w.update_object(
            id,
            Changes {
                body: Some(format!("{}A", "🦀".repeat(1_999))),
                ..Changes::default()
            },
        )
    });
    let branch = one(&v, &k, O::CreateRevisionFrom, |w| {
        w.create_revision_from(
            id,
            &base,
            Changes {
                body: Some("B".repeat(2_000)),
                ..Changes::default()
            },
            false,
        )
    });
    one(&v, &k, O::MergeRevisions, |w| {
        w.merge_revisions(
            id,
            &[edit.id, branch.id],
            content("Merged synthetic maximum"),
            true,
        )
    });
    one(&v, &k, O::SnapshotAllocate, |w| {
        w.snapshot_allocate(SNAP, NOW)
    });
    one(&v, &k, O::SnapshotCapture, |w| {
        w.snapshot_capture(SNAP, NOW)
    });
    one(&v, &k, O::SnapshotAbort, |w| w.snapshot_abort(SNAP));
    assert!(s.query_i64_for_test("PRAGMA freelist_count") > 0);
    let pages = s.query_i64_for_test("PRAGMA page_count");
    let mut i = input();
    i.content = "🦀".repeat(20_000);
    one(&v, &k, O::Capture, |w| w.create_capture(i));
    assert_eq!(s.query_i64_for_test("PRAGMA page_count"), pages);
    let expected = state(&s);
    let events = cores(&s);
    drop(k);
    let s = reopen(&dir, &v, s, &expected);
    assert_eq!(cores(&s), events);
}
const NOW: &str = "2026-10-23T12:00:00Z";
const SNAP: &str = "aaaaaaaa-1111-4111-8111-111111111111";
fn snapshot_stage(w: &mut super::writers::Writers<'_, '_>, op: O) -> Result<(), W> {
    match op {
        O::SnapshotAllocate => w.snapshot_allocate(SNAP, NOW),
        O::SnapshotCapture => w.snapshot_capture(SNAP, NOW).map(|_| ()),
        O::SnapshotPack => w.snapshot_pack(SNAP),
        O::SnapshotVerify => w.snapshot_verify(SNAP),
        _ => panic!("snapshot stage required"),
    }
}
#[test]
fn c09_14_15_snapshot_stages_have_independent_io_tokens_and_retain_ready_originals() {
    let stages = [
        O::SnapshotAllocate,
        O::SnapshotCapture,
        O::SnapshotPack,
        O::SnapshotVerify,
    ];
    for fail in 0..3 {
        let (dir, v, s) = fixture();
        let k = activate(&s, P::instrumented_profile_a());
        one(&v, &k, O::Capture, |w| w.create_capture(input()));
        for op in &stages[..fail] {
            one(&v, &k, *op, |w| snapshot_stage(w, *op));
        }
        let before = state(&s);
        v.inject(Injection {
            class: Class::Journal,
            boundary: Boundary::Write,
            nth: 1,
            code: ffi::SQLITE_FULL,
        });
        assert!(k
            .write_admitted(stages[fail], |w| snapshot_stage(w, stages[fail]))
            .is_err());
        assert_eq!(state(&s), before);
        clean(&s);
        // Reopen before retrying the failed stage, checking durable rows.
        drop(k);
        let s = reopen(&dir, &v, s, &before);
        let k = activate(&s, P::instrumented_profile_a());
        for op in &stages[fail..] {
            one(&v, &k, *op, |w| snapshot_stage(w, *op));
        }
        let ready = state(&s);
        assert!(k
            .write_admitted(O::SnapshotAbort, |w| w.snapshot_abort(SNAP))
            .is_err());
        assert_eq!(state(&s), ready);
        assert_eq!(cores(&s).len(), 1);
        let p = P::instrumented_profile_a();
        drop(k);
        // Independent logical metadata quota still covers no-effect maintenance.
        let limits = Limits {
            metadata: 1,
            ..Limits::candidate()
        };
        assert!(JournalKernel::activate_with_admission(
            &s,
            limits,
            p,
            Arc::new(SimulatedCapacity),
            ClaimPool::new(p.recovery)
        )
        .is_err());
        reopen(&dir, &v, s, &ready);
    }
}
#[test]
fn c09_abort_and_no_effect_maintenance_remain_admitted() {
    let (dir, v, s) = fixture();
    let k = activate(&s, P::instrumented_profile_a());
    one(&v, &k, O::SnapshotAllocate, |w| {
        w.snapshot_allocate(SNAP, NOW)
    });
    one(&v, &k, O::SnapshotCapture, |w| {
        w.snapshot_capture(SNAP, NOW)
    });
    one(&v, &k, O::SnapshotAbort, |w| w.snapshot_abort(SNAP));
    one(&v, &k, O::ExecuteDueExpiry, |w| {
        w.execute_due_expiry(super::expiry::DormantExpiryRequest::candidate(NOW, 32).unwrap())
    });
    assert!(cores(&s).is_empty());
    let before = state(&s);
    drop(k);
    reopen(&dir, &v, s, &before);
}
#[test]
fn c10_all_kernel_stages_roll_back_domain_core_and_heads_after_reopen() {
    for stage in [
        Stage::Context,
        Stage::Domain,
        Stage::Effects,
        Stage::FinalRead,
        Stage::Priors,
        Stage::Codec,
        Stage::Quota,
        Stage::Bundle,
        Stage::Heads,
        Stage::Cleanup,
        Stage::Commit,
    ] {
        let (dir, v, s) = fixture();
        let k = activate(&s, P::instrumented_profile_a());
        one(&v, &k, O::Capture, |w| w.create_capture(input()));
        let before = state(&s);
        assert!(matches!(
            k.write_admitted_fault(O::Capture, Fault::At(stage), |w| w.create_capture(input())),
            Err(W::Journal(J::Injected))
        ));
        drop(k);
        reopen(&dir, &v, s, &before);
    }
}
#[test]
fn c16_preexisting_wal_cannot_borrow_delete_bounds_or_be_silently_converted() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let s = CaptureStore::open_owned(DataRootOwnership::try_acquire(&root).unwrap()).unwrap();
    upgrade(&s);
    s.execute_sql_for_test("PRAGMA journal_mode=WAL");
    let before = state(&s);
    let p = P::synthetic_profile_a();
    assert!(matches!(
        JournalKernel::activate_with_admission(
            &s,
            Limits::candidate(),
            p,
            Arc::new(SimulatedCapacity),
            ClaimPool::new(p.recovery)
        ),
        Err(J::Admission(A::UnsupportedMode))
    ));
    assert_eq!(
        s.connection
            .lock()
            .unwrap()
            .query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    assert_eq!(state(&s), before);
    drop(s);
    let s = CaptureStore::reopen_candidate_owned_for_test(
        DataRootOwnership::try_acquire(&root).unwrap(),
    )
    .unwrap();
    assert_eq!(state(&s), before);
    clean(&s);
}
#[test]
fn c17_18_fresh_and_populated_v9_rehearse_activation_rollback_reopen_and_downgrade() {
    for populated in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let v = OwnedVfs::new(&root);
        let s = CaptureStore::open_observed(
            DataRootOwnership::try_acquire(&root).unwrap(),
            v.clone(),
            false,
        )
        .unwrap();
        assert_eq!(s.query_i64_for_test("PRAGMA user_version"), 9);
        if populated {
            crate::storage::m05_v10_tests::populated(&s.connection.lock().unwrap());
        }
        let legacy = state(&s);
        upgrade(&s);
        let extended = state(&s);
        for (table, rows) in &legacy {
            assert_eq!(
                extended.iter().find(|(name, _)| name == table).unwrap().1,
                *rows
            );
        }
        let p = P::profile_a_candidate();
        assert!(JournalKernel::activate_with_admission(
            &s,
            Limits::candidate(),
            p,
            Arc::new(SimulatedCapacity),
            ClaimPool::new(p.recovery)
        )
        .is_err());
        assert!(s.create(input()).is_err());
        assert_eq!(state(&s), extended);
        let k = activate(&s, P::instrumented_profile_a());
        let before = state(&s);
        assert!(k
            .write_admitted_fault(O::Capture, Fault::At(Stage::Commit), |w| w
                .create_capture(input()))
            .is_err());
        assert_eq!(state(&s), before);
        one(&v, &k, O::Capture, |w| w.create_capture(input()));
        let events = cores(&s);
        assert_eq!(events.len(), 1);
        let expected = state(&s);
        drop(k);
        let s = reopen(&dir, &v, s, &expected);
        let k = activate(&s, P::instrumented_profile_a());
        one(&v, &k, O::Capture, |w| w.create_capture(input()));
        let events2 = cores(&s);
        assert_eq!(events2.len(), 2);
        assert_ne!(events[0].origin_incarnation, events2[1].origin_incarnation);
        drop(k);
        drop(s);
        let path = root.join("arthur.db");
        let bytes = std::fs::read(&path).unwrap();
        assert!(CaptureStore::open_owned(DataRootOwnership::try_acquire(&root).unwrap()).is_err());
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}
#[test]
fn c19_actual_io_errors_and_numeric_records_do_not_disclose_private_content() {
    let (dir, v, s) = fixture();
    let k = activate(&s, P::instrumented_profile_a());
    let before = state(&s);
    let mut i = input();
    i.content = "PRIVATE_G4_SENTINEL SELECT credentials FROM secrets".into();
    v.inject(Injection {
        class: Class::Journal,
        boundary: Boundary::Write,
        nth: 1,
        code: ffi::SQLITE_IOERR_WRITE,
    });
    let e = k
        .write_admitted(O::Capture, |w| w.create_capture(i))
        .unwrap_err();
    let diagnostic = format!("{e:?} {:?}", v.records());
    for private in [
        "PRIVATE_G4_SENTINEL",
        "SELECT",
        "credentials",
        &dir.path().display().to_string(),
    ] {
        assert!(!diagnostic.contains(private));
    }
    drop(k);
    reopen(&dir, &v, s, &before);
}
#[test]
fn c20_public_owner_still_initializes_only_v9_and_has_no_candidate_ingress() {
    assert_eq!(crate::storage::migrations::SCHEMA_VERSION, 9);
    assert_eq!(
        crate::storage::migrations::STEPS
            .iter()
            .map(|(v, _)| *v)
            .collect::<Vec<_>>(),
        (1..=9).collect::<Vec<_>>()
    );
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let s = CaptureStore::open_owned(DataRootOwnership::try_acquire(&root).unwrap()).unwrap();
    s.create(input()).unwrap();
    assert_eq!(s.query_i64_for_test("PRAGMA user_version"), 9);
    assert_eq!(
        s.query_i64_for_test("SELECT count(*) FROM sqlite_schema WHERE name LIKE 'sync_%'"),
        0
    );
}
fn fingerprint(s: &CaptureStore) -> String {
    use sha2::{Digest, Sha256};
    super::codec::hash_hex(&Sha256::digest(format!("{:?}", state(s)).as_bytes()).into())
}
fn crash_barrier(digest: &str, event: &str, hash: &str) {
    use std::io::{Read, Write};
    println!("C_READY {digest} {event} {hash}");
    std::io::stdout().flush().unwrap();
    let mut byte = [0];
    std::io::stdin().read_exact(&mut byte).unwrap();
    panic!("crash child must be terminated at barrier");
}
#[test]
#[ignore = "private subprocess entry; executed by c13_process_termination_at_deterministic_commit_barriers"]
fn c_crash_child() {
    // A capability marker limits this entry to a parent-created disposable root.
    let root = std::path::PathBuf::from(
        std::env::var_os("ARTHUR_G4_ROOT").expect("parent capability required"),
    )
    .canonicalize()
    .unwrap();
    assert_eq!(
        root.parent().unwrap(),
        std::env::temp_dir().canonicalize().unwrap()
    );
    assert!(root
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("arthur-g4-"));
    let marker = root.join(".g4-disposable");
    assert!(std::fs::symlink_metadata(&marker)
        .unwrap()
        .file_type()
        .is_file());
    assert_eq!(
        std::fs::read_to_string(marker).unwrap(),
        std::env::var("ARTHUR_G4_CAPABILITY").unwrap()
    );
    let v = OwnedVfs::new(&root);
    let s = CaptureStore::open_observed(
        DataRootOwnership::try_acquire(&root).unwrap(),
        v.clone(),
        true,
    )
    .unwrap();
    let k = activate(&s, P::instrumented_profile_a());
    let before = fingerprint(&s);
    s.execute_sql_for_test("PRAGMA cache_size=1; PRAGMA cache_spill=ON");
    v.clear_records();
    let mode = std::env::var("ARTHUR_G4_BARRIER").unwrap();
    let mut i = input();
    i.content = "🦀".repeat(20_000);
    k.write_admitted(O::Capture, |w| {
        let value = w.create_capture(i)?;
        if mode == "before" {
            assert!(v.records().iter().any(|r| r.class == Class::Main
                && r.boundary == Boundary::Write
                && r.session > 0
                && r.rc == ffi::SQLITE_OK));
            assert!(v.records().iter().any(|r| r.class == Class::Journal
                && r.boundary == Boundary::Sync
                && r.rc == ffi::SQLITE_OK));
            crash_barrier(&before, "-", "-");
        }
        Ok(value)
    })
    .unwrap();
    assert_eq!(mode, "after");
    let events = cores(&s);
    let event = events.last().unwrap();
    let bytes = super::codec::encode_canonical(event).unwrap();
    crash_barrier(
        &fingerprint(&s),
        &event.event_id,
        &super::codec::hash_hex(&super::codec::journal_event_hash(&bytes)),
    );
}
#[test]
fn c13_process_termination_at_deterministic_commit_barriers() {
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
        sync::mpsc,
        time::Duration,
    };
    struct ChildGuard(std::process::Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    for mode in ["before", "after"] {
        let dir = tempfile::Builder::new()
            .prefix("arthur-g4-")
            .tempdir()
            .unwrap();
        let root = dir.path().canonicalize().unwrap();
        let capability = uuid::Uuid::new_v4().to_string();
        std::fs::write(root.join(".g4-disposable"), &capability).unwrap();
        let v = OwnedVfs::new(&root);
        let s = CaptureStore::open_observed(
            DataRootOwnership::try_acquire(&root).unwrap(),
            v.clone(),
            false,
        )
        .unwrap();
        upgrade(&s);
        let k = activate(&s, P::instrumented_profile_a());
        one(&v, &k, O::Capture, |w| w.create_capture(input()));
        drop(k);
        drop(s);
        drop(v);
        let mut child = ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "storage::journal::physical_tests::c_crash_child",
                    "--ignored",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env("ARTHUR_G4_ROOT", &root)
                .env("ARTHUR_G4_CAPABILITY", &capability)
                .env("ARTHUR_G4_BARRIER", mode)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let stdout = child.0.stdout.take().unwrap();
        let (send, receive) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Some(at) = line.find("C_READY ") {
                    let _ = send.send(line[at..].to_owned());
                    return;
                }
            }
        });
        let checkpoint = receive
            .recv_timeout(Duration::from_secs(30))
            .expect("child must reach deterministic barrier");
        child.0.kill().unwrap();
        let status = child.0.wait().unwrap();
        assert!(!status.success());
        reader.join().unwrap();
        let fields: Vec<_> = checkpoint.split_whitespace().collect();
        assert_eq!(fields.len(), 4);
        let v = OwnedVfs::new(&root);
        let s =
            CaptureStore::open_observed(DataRootOwnership::try_acquire(&root).unwrap(), v, true)
                .unwrap();
        clean(&s);
        assert_eq!(fingerprint(&s), fields[1]);
        if mode == "before" {
            assert_eq!(cores(&s).len(), 1);
        } else {
            assert_eq!(cores(&s).len(), 2);
            let event = JournalKernel::reconcile_event(
                &s,
                uuid::Uuid::parse_str(fields[2]).unwrap(),
                Limits::candidate().metadata,
            )
            .unwrap()
            .unwrap();
            assert_eq!(event.hash, fields[3]);
        }
    }
}
#[test]
fn c10_11_actual_journal_main_write_and_sync_faults_are_not_acknowledged() {
    for (class, boundary, code) in [
        (Class::Journal, Boundary::Write, ffi::SQLITE_FULL),
        (Class::Main, Boundary::Write, ffi::SQLITE_FULL),
        (Class::Journal, Boundary::Sync, ffi::SQLITE_IOERR_FSYNC),
        (Class::Main, Boundary::Sync, ffi::SQLITE_IOERR_FSYNC),
    ] {
        let (dir, vfs, s) = fixture();
        let k = activate(&s, P::instrumented_profile_a());
        k.write_admitted(O::Capture, |w| w.create_capture(input()))
            .unwrap();
        s.execute_sql_for_test("PRAGMA cache_spill=OFF");
        let before = state(&s);
        let result = k.write_admitted(O::Capture, |w| {
            // Context SQL has completed; arm at the actual domain writer entry.
            vfs.inject(Injection {
                class,
                boundary,
                nth: 1,
                code,
            });
            w.create_capture(input())
        });
        assert!(result.is_err());
        assert!(vfs
            .records()
            .iter()
            .any(|r| r.class == class && r.boundary == boundary && r.rc == code));
        if let Err(W::Journal(J::MutationUncertain { event_id, sqlite })) = result {
            if let Some(sqlite) = sqlite {
                assert_eq!(sqlite.extended, code);
            }
            assert!(k
                .write_admitted(O::Capture, |w| w.create_capture(input()))
                .is_err());
            drop(k);
            let s = reopen(&dir, &vfs, s, &before);
            assert!(
                JournalKernel::reconcile_event(&s, event_id, Limits::candidate().metadata)
                    .unwrap()
                    .is_none()
            );
        } else {
            drop(k);
            reopen(&dir, &vfs, s, &before);
        }
    }
}
#[test]
fn c12_13_uncertain_commit_and_rollback_failure_poison_until_identity_reopen() {
    for fault in [Fault::AfterCommitUnknown, Fault::Rollback] {
        let (dir, vfs, s) = fixture();
        let k = activate(&s, P::instrumented_profile_a());
        let before = state(&s);
        let result = k.write_admitted_fault(O::Capture, fault, |w| {
            let value = w.create_capture(input())?;
            if matches!(fault, Fault::Rollback) {
                return Err(W::Journal(J::Domain));
            }
            Ok(value)
        });
        let event = match result {
            Err(W::Journal(J::MutationUncertain { event_id, .. })) => Some(event_id),
            Err(W::Journal(J::Rollback)) => None,
            other => panic!("expected recovery failure, got {other:?}"),
        };
        assert!(k
            .write_admitted(O::Capture, |w| w.create_capture(input()))
            .is_err());
        let expected = if event.is_some() { state(&s) } else { before };
        drop(k);
        let s = reopen(&dir, &vfs, s, &expected);
        if let Some(id) = event {
            let r = JournalKernel::reconcile_event(&s, id, Limits::candidate().metadata)
                .unwrap()
                .unwrap();
            assert_eq!(
                r.hash,
                super::codec::hash_hex(&super::codec::journal_event_hash(
                    &super::codec::encode_canonical(&cores(&s)[0]).unwrap()
                ))
            );
        }
    }
}
#[test]
fn c11_optional_journal_cleanup_io_failure_cannot_be_acknowledged_as_success() {
    for (boundary, code) in [
        (Boundary::Close, ffi::SQLITE_IOERR_CLOSE),
        (Boundary::Delete, ffi::SQLITE_IOERR_DELETE),
    ] {
        let (dir, v, s) = fixture();
        let k = activate(&s, P::instrumented_profile_a());
        one(&v, &k, O::Capture, |w| w.create_capture(input()));
        let before = state(&s);
        let originals = cores(&s);
        v.inject(Injection {
            class: Class::Journal,
            boundary,
            nth: 1,
            code,
        });
        let result = k.write_admitted(O::Capture, |w| w.create_capture(input()));
        let event = match result {
            Err(W::Journal(J::MutationUncertain { event_id, .. })) => event_id,
            other => panic!("cleanup failure must poison acknowledgement: {other:?}"),
        };
        assert!(v
            .records()
            .iter()
            .any(|r| r.class == Class::Journal && r.boundary == boundary && r.rc == code));
        assert!(k
            .write_admitted(O::Capture, |w| w.create_capture(input()))
            .is_err());
        let after = state(&s);
        drop(k);
        drop(s);
        let root = dir.path().canonicalize().unwrap();
        let s =
            CaptureStore::open_observed(DataRootOwnership::try_acquire(&root).unwrap(), v, true)
                .unwrap();
        clean(&s);
        let actual = state(&s);
        assert!(actual == before || actual == after);
        let events = cores(&s);
        assert_eq!(events[0], originals[0]);
        let found =
            JournalKernel::reconcile_event(&s, event, Limits::candidate().metadata).unwrap();
        match found {
            Some(reference) => {
                assert_eq!(events.len(), 2);
                let bytes = super::codec::encode_canonical(&events[1]).unwrap();
                assert_eq!(
                    reference.hash,
                    super::codec::hash_hex(&super::codec::journal_event_hash(&bytes))
                );
            }
            None => {
                assert_eq!(events, originals);
                assert_eq!(actual, before);
            }
        }
    }
}
