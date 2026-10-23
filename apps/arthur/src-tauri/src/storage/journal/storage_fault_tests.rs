//! Synthetic v10 only. Provenance is part of every fault-test name.
//! No VFS IOERR, physical filesystem-full, process-kill or power-cut claim.
use super::storage::{
    check_quota_for_test, Fault, JournalError as J, JournalKernel, Limits, Stage,
};
use super::storage_tests::{clean, cores, state, upgrade};
use super::writers::WriterError as W;
use super::{codec, snapshot};
use crate::storage::capture_store::{CaptureStore, CreateCaptureInput, StoreError};
use rusqlite::{types::Value, Connection};
use std::path::Path;

const NOW: &str = "2026-10-23T12:00:00Z";
const SNAP: &str = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER: &str = "bbbbbbbb-2222-4222-8222-222222222222";
const CAP: u64 = 64 * 1024;
type Rows = Vec<(String, Vec<Vec<Value>>)>;

fn fixture() -> (tempfile::TempDir, CaptureStore) {
    let dir = tempfile::tempdir().unwrap();
    let s = CaptureStore::open(&dir.path().join("synthetic-v10.db")).unwrap();
    upgrade(&s);
    (dir, s)
}

fn count(s: &CaptureStore, query: &str) -> i64 {
    s.query_i64_for_test(query)
}

fn text(s: &CaptureStore, query: &str) -> String {
    s.connection
        .lock()
        .unwrap()
        .query_row(query, [], |r| r.get(0))
        .unwrap()
}

fn input(content: &str) -> CreateCaptureInput {
    CreateCaptureInput {
        source: "text".into(),
        content: content.into(),
        project_id: None,
    }
}

fn seed(k: &JournalKernel<'_>) {
    k.write(|w| w.create_capture(input("A real synthetic Capture")))
        .unwrap();
}

// Find the exact threshold by querying the ACTUAL production quota function.
// No SQL column-size accounting is reimplemented here.
fn metadata(s: &CaptureStore) -> u64 {
    let c = s.connection.lock().unwrap();
    let (mut lo, mut hi) = (0, 64 * 1024 * 1024);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        match check_quota_for_test(
            &c,
            Limits {
                metadata: mid,
                ..Limits::candidate()
            },
        ) {
            Ok(()) => hi = mid,
            Err(J::MetadataQuota) => lo = mid + 1,
            other => panic!("quota oracle unexpectedly returned {other:?}"),
        }
    }
    lo
}

fn limited(s: &CaptureStore, headroom: u64) -> JournalKernel<'_> {
    let before = metadata(s);
    // This is deliberately a LOGICAL reserve, not physical disk capacity.
    let reserve = CAP.checked_sub(before + headroom).unwrap();
    let k = JournalKernel::activate_with_policy(
        s,
        Limits {
            metadata: CAP,
            reserve: Some(reserve),
            ..Limits::candidate()
        },
    )
    .unwrap();
    assert!(metadata(s) + reserve <= CAP);
    eprintln!("metadata cap={CAP}, logical reserve={reserve}, used={}, pre-activation headroom={headroom}", metadata(s));
    k
}

fn metadata_error<T>(result: Result<T, W>) {
    assert!(matches!(result, Err(W::Journal(J::MetadataQuota))));
}

// Reopen only AFTER closing the old owner. The production v9 opener intentionally
// refuses v10; this follows the existing k02 synthetic recovery route instead.
fn reopen(path: &Path, before: &Rows) -> CaptureStore {
    let c = Connection::open(path).unwrap();
    assert_eq!(
        c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        10
    );
    c.pragma_update(None, "foreign_keys", true).unwrap();
    c.pragma_update(None, "synchronous", "FULL").unwrap();
    let s = CaptureStore::open_in_memory().unwrap();
    *s.connection.lock().unwrap() = c;
    clean(&s);
    assert_eq!(&state(&s), before);
    s
}

fn close_reopen(dir: &tempfile::TempDir, s: CaptureStore, before: &Rows) -> CaptureStore {
    clean(&s);
    assert_eq!(&state(&s), before);
    drop(s);
    reopen(&dir.path().join("synthetic-v10.db"), before)
}

#[test]
fn q01_no_effects_finalizer_metadata_admission() {
    let (dir, s) = fixture();
    let k = limited(&s, 256);
    let before = state(&s);
    let result = k.run(|t| {
        assert!(!t.sql().is_autocommit());
        t.sql().execute("INSERT INTO sync_origins(origin_id,incarnation,status,opened_at,sealed_at) VALUES(?1,?2,'sealed',?3,?3)", rusqlite::params![SNAP, OTHER, NOW])?;
        assert_eq!(t.sql().query_row("SELECT count(*) FROM sync_origins", [], |r| r.get::<_, i64>(0))?, 2);
        assert_eq!(t.sql().query_row("SELECT count(*) FROM sync_effects", [], |r| r.get::<_, i64>(0))?, 0);
        Ok(())
    });
    assert_eq!(result, Err(J::MetadataQuota));
    drop(k);
    close_reopen(&dir, s, &before);
}

#[test]
fn q02_snapshot_allocate_metadata_quota() {
    let (dir, s) = fixture();
    let k = limited(&s, 256);
    let before = state(&s);
    metadata_error(k.write(|w| w.snapshot_allocate(SNAP, NOW)));
    drop(k);
    close_reopen(&dir, s, &before);
}

#[test]
fn q03_snapshot_capture_metadata_quota_preserves_pending() {
    let (dir, s) = fixture();
    let k = JournalKernel::activate(&s).unwrap();
    seed(&k);
    k.write(|w| w.snapshot_allocate(SNAP, NOW)).unwrap();
    drop(k);
    let k = limited(&s, 256);
    let before = state(&s);
    metadata_error(k.write(|w| w.snapshot_capture(SNAP, NOW)));
    assert_eq!(text(&s, "SELECT state FROM sync_snapshots"), "pending");
    assert_eq!(count(&s, "SELECT count(*) FROM sync_snapshot_rows"), 0);
    drop(k);
    close_reopen(&dir, s, &before);
}

#[test]
fn q04_snapshot_pack_metadata_quota_and_admitted_retry() {
    let (dir, s) = fixture();
    let k = JournalKernel::activate(&s).unwrap();
    seed(&k);
    k.write(|w| w.snapshot_allocate(SNAP, NOW)).unwrap();
    k.write(|w| w.snapshot_capture(SNAP, NOW)).unwrap();
    drop(k);
    let k = limited(&s, 256);
    let before = state(&s);
    metadata_error(k.write(|w| w.snapshot_pack(SNAP)));
    assert_eq!(text(&s, "SELECT state FROM sync_snapshots"), "materialized");
    assert_eq!(state(&s), before);
    drop(k);
    let s = close_reopen(&dir, s, &before);
    let k = JournalKernel::activate_with_policy(&s, Limits::candidate()).unwrap();
    k.write(|w| w.snapshot_pack(SNAP)).unwrap();
    k.write(|w| w.snapshot_verify(SNAP)).unwrap();
    assert_eq!(count(&s, "SELECT count(*) FROM sync_bundles"), 1);
    clean(&s);
}

#[test]
fn q05_healthy_snapshot_v2_lifecycle() {
    let (dir, s) = fixture();
    let k = JournalKernel::activate(&s).unwrap();
    seed(&k);
    let journal = cores(&s);
    k.write(|w| w.snapshot_allocate(SNAP, NOW)).unwrap();
    k.write(|w| w.snapshot_capture(SNAP, NOW)).unwrap();
    k.write(|w| w.snapshot_pack(SNAP)).unwrap();
    k.write(|w| w.snapshot_verify(SNAP)).unwrap();
    let bytes: Vec<u8> = s
        .connection
        .lock()
        .unwrap()
        .query_row("SELECT manifest_bytes FROM sync_snapshots", [], |r| {
            r.get(0)
        })
        .unwrap();
    let manifest: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(manifest["snapshotVersion"], 2);
    assert_eq!(cores(&s), journal);
    let before = state(&s);
    drop(k);
    let s = close_reopen(&dir, s, &before);
    let k = JournalKernel::activate(&s).unwrap();
    k.write(|w| w.snapshot_verify(SNAP)).unwrap();
}

#[test]
fn q06_empty_and_read_only_noop_preserve_exact_state() {
    let (dir, s) = fixture();
    let k = limited(&s, 256);
    let before = state(&s);
    k.run(|_| Ok(())).unwrap();
    assert_eq!(
        k.run(|t| Ok(t
            .sql()
            .query_row("SELECT count(*) FROM projects", [], |r| r.get::<_, i64>(0))?))
            .unwrap(),
        1
    );
    assert_eq!(state(&s), before);
    drop(k);
    close_reopen(&dir, s, &before);
}

#[test]
fn q07_domain_finalizer_parity_and_exact_quota_boundary() {
    let (_dir, s) = fixture();
    let k = JournalKernel::activate(&s).unwrap();
    seed(&k);
    let all = cores(&s);
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].origin_seq, "1");
    assert_eq!(all[0].raw_effect_count, "1");
    assert_eq!(all[0].operations.len(), 1);
    assert_eq!(all[0].operations[0].entity(), codec::EntityKind::Captures);
    let used = metadata(&s);
    let c = s.connection.lock().unwrap();
    let exact = Limits {
        metadata: used,
        ..Limits::candidate()
    };
    assert_eq!(check_quota_for_test(&c, exact), Ok(()));
    assert_eq!(
        check_quota_for_test(
            &c,
            Limits {
                reserve: Some(1),
                ..exact
            }
        ),
        Err(J::MetadataQuota)
    );
    drop(c);
    let before = state(&s);
    k.run(|_| Ok(())).unwrap();
    assert_eq!(state(&s), before);
    clean(&s);
}

#[test]
fn q08_caught_maintenance_errors_cannot_publish_partial_work() {
    let (dir, s) = fixture();
    let k = limited(&s, 256);
    let before = state(&s);
    let mut body_returned_ok = false;
    let result = k.write(|w| {
        // Quota failure occurs AFTER this composition returns, so it cannot
        // be swallowed by catching an adapter result inside the composition.
        let caught = w.snapshot_allocate(SNAP, NOW).or_else(|_| Ok::<_, W>(()));
        assert!(caught.is_ok());
        body_returned_ok = true;
        Ok(())
    });
    assert!(body_returned_ok);
    metadata_error(result);
    assert_eq!(state(&s), before);
    drop(k);
    let k = JournalKernel::activate(&s).unwrap();
    let before = state(&s);
    let result = k.write(|w| {
        w.snapshot_allocate(SNAP, NOW)?;
        assert!(w.snapshot_allocate(OTHER, NOW).is_err());
        Ok(())
    });
    assert!(matches!(
        result,
        Err(W::Snapshot(snapshot::SnapshotError::Exists))
    ));
    drop(k);
    close_reopen(&dir, s, &before);
}

#[test]
fn q09_abort_cleanup_ready_boundary_and_already_over_cap() {
    let (_dir, s) = fixture();
    let k = JournalKernel::activate(&s).unwrap();
    seed(&k);
    k.write(|w| w.snapshot_allocate(SNAP, NOW)).unwrap();
    k.write(|w| w.snapshot_abort(SNAP)).unwrap();
    k.write(|w| w.snapshot_allocate(OTHER, NOW)).unwrap();
    k.write(|w| w.snapshot_capture(OTHER, NOW)).unwrap();
    k.write(|w| w.snapshot_abort(OTHER)).unwrap();
    assert_eq!(count(&s, "SELECT count(*) FROM sync_snapshot_rows"), 0);
    let ready = "cccccccc-3333-4333-8333-333333333333";
    k.write(|w| w.snapshot_allocate(ready, NOW)).unwrap();
    k.write(|w| w.snapshot_capture(ready, NOW)).unwrap();
    k.write(|w| w.snapshot_pack(ready)).unwrap();
    let before = state(&s);
    assert!(matches!(
        k.write(|w| w.snapshot_abort(ready)),
        Err(W::Snapshot(snapshot::SnapshotError::State))
    ));
    assert_eq!(state(&s), before);
    assert_eq!(cores(&s).len(), 1);
    drop(k);

    for headroom in [256, 1024] {
        let (dir, s) = fixture();
        let k = JournalKernel::activate(&s).unwrap();
        seed(&k);
        k.write(|w| w.snapshot_allocate(SNAP, NOW)).unwrap();
        drop(k);
        let base = metadata(&s);
        let k = limited(&s, headroom);
        // Deliberate already-over-cap persisted fixture, not a recovery API:
        // materialize with the REAL snapshot implementation in a fixture-only
        // transaction, bypassing admission solely to construct the bad start.
        {
            let mut c = s.connection.lock().unwrap();
            let tx = c.transaction().unwrap();
            snapshot::capture(&tx, SNAP, snapshot::SnapshotPolicy::candidate(), NOW).unwrap();
            tx.commit().unwrap();
        }
        assert!(metadata(&s) > base + headroom);
        let before = state(&s);
        if headroom == 256 {
            metadata_error(k.write(|w| w.snapshot_abort(SNAP)));
            assert_eq!(state(&s), before); // Reduction alone grants no bypass.
        } else {
            k.write(|w| w.snapshot_abort(SNAP)).unwrap();
            assert_eq!(text(&s, "SELECT state FROM sync_snapshots"), "aborted");
            assert_eq!(count(&s, "SELECT count(*) FROM sync_snapshot_rows"), 0);
            assert!(metadata(&s) <= base + headroom);
        }
        let expected = state(&s);
        drop(k);
        close_reopen(&dir, s, &expected);
    }
}

#[test]
fn q10_retained_seven_table_accounting_and_separate_row_bytes() {
    let (_dir, s) = fixture();
    let k = JournalKernel::activate(&s).unwrap();
    let escaped = format!("A{}", "\u{1}".repeat(19999));
    k.write(|w| w.create_capture(input(&escaped))).unwrap();
    drop(k);
    let k = JournalKernel::activate_with_policy(
        &s,
        Limits {
            metadata: CAP,
            ..Limits::candidate()
        },
    )
    .unwrap();
    k.write(|w| w.snapshot_allocate(SNAP, NOW)).unwrap();
    k.write(|w| w.snapshot_capture(SNAP, NOW)).unwrap();
    k.write(|w| w.snapshot_pack(SNAP)).unwrap();
    k.write(|w| w.snapshot_verify(SNAP)).unwrap();
    for table in [
        "sync_origins",
        "sync_local",
        "sync_bundles",
        "sync_commit_fences",
        "sync_entity_heads",
        "sync_snapshots",
        "sync_snapshot_rows",
    ] {
        assert!(
            count(&s, &format!("SELECT count(*) FROM {table}")) > 0,
            "missing fixture family {table}"
        );
    }
    assert_eq!(
        count(
            &s,
            "SELECT count(*) FROM sync_origins WHERE status='sealed'"
        ),
        1
    );
    assert!(count(&s, "SELECT sum(length(row_bytes)) FROM sync_snapshot_rows") > CAP as i64);
    assert!(count(&s, "SELECT sum(length(canonical_bytes)) FROM sync_bundles") > CAP as i64);
    let used = metadata(&s);
    assert!(used < CAP);
    let c = s.connection.lock().unwrap();
    let exact = Limits {
        metadata: used,
        ..Limits::candidate()
    };
    assert_eq!(check_quota_for_test(&c, exact), Ok(()));
    assert_eq!(
        check_quota_for_test(
            &c,
            Limits {
                metadata: used - 1,
                ..exact
            }
        ),
        Err(J::MetadataQuota)
    );
    assert_eq!(
        check_quota_for_test(
            &c,
            Limits {
                payload: 0,
                ..Limits::candidate()
            }
        ),
        Err(J::PayloadQuota)
    );
    drop(c);
    let before = state(&s);
    k.run(|_| Ok(())).unwrap();
    assert_eq!(state(&s), before);
    clean(&s);
}

#[test]
fn f01_sqlite_pager_full_code13_domain_rollback_and_reopen() {
    let (dir, s) = fixture();
    let k = JournalKernel::activate(&s).unwrap();
    seed(&k);
    let before = state(&s);
    let old_max = count(&s, "PRAGMA max_page_count");
    let pages = count(&s, "PRAGMA page_count");
    s.connection
        .lock()
        .unwrap()
        .pragma_update(None, "max_page_count", pages)
        .unwrap();
    let result = k.write(|w| w.create_capture(input(&"A".repeat(20000))));
    match result {
        Err(W::Store(error)) => match error.as_ref() {
            StoreError::Database(rusqlite::Error::SqliteFailure(code, _)) => {
                assert_eq!(code.code, rusqlite::ErrorCode::DiskFull);
                assert_eq!(code.extended_code, 13);
                eprintln!("SQLITE_PAGER_FULL primary=13 extended=13; max_page_count={pages}; not volume exhaustion");
            }
            other => panic!("expected pager FULL, got {other:?}"),
        },
        other => panic!("expected failed publication, got {other:?}"),
    }
    assert_eq!(state(&s), before);
    clean(&s);
    s.connection
        .lock()
        .unwrap()
        .pragma_update(None, "max_page_count", old_max)
        .unwrap();
    drop(k);
    close_reopen(&dir, s, &before);
}

#[test]
fn f02_logical_injection_after_real_domain_sql_before_publication() {
    let (dir, s) = fixture();
    let k = JournalKernel::activate(&s).unwrap();
    seed(&k);
    let before = state(&s);
    let mut sql_executed = false;
    let result = k.write_fault(Fault::At(Stage::Domain), |w| {
        let cap = w.create_capture(input("Uncommitted domain write"))?;
        assert_eq!(w.observed_effect_count(), 1);
        sql_executed = true;
        Ok(cap)
    });
    assert!(sql_executed);
    assert!(matches!(result, Err(W::Journal(J::Injected))));
    drop(k);
    close_reopen(&dir, s, &before);
}

#[test]
fn f03_sqlite_trigger_abort_during_actual_bundle_insert() {
    let (dir, s) = fixture();
    let k = JournalKernel::activate(&s).unwrap();
    seed(&k);
    s.execute_sql_for_test("CREATE TEMP TRIGGER task14c_bundle_abort BEFORE INSERT ON sync_bundles BEGIN SELECT RAISE(ABORT,'TASK14C_SQLITE_TRIGGER_ABORT'); END");
    let before = state(&s);
    assert!(matches!(
        k.write(|w| w.create_capture(input("Must roll back with its bundle"))),
        Err(W::Journal(J::BundleInsert))
    ));
    assert_eq!(state(&s), before);
    s.execute_sql_for_test("DROP TRIGGER task14c_bundle_abort");
    drop(k);
    close_reopen(&dir, s, &before);
}

#[test]
fn f04_logical_injection_pre_commit_stage_and_disk_reopen() {
    let (dir, s) = fixture();
    let k = JournalKernel::activate(&s).unwrap();
    seed(&k);
    let before = state(&s);
    assert!(matches!(
        k.write_fault(Fault::At(Stage::Commit), |w| w
            .create_capture(input("Finalized but not committed"))),
        Err(W::Journal(J::Injected))
    ));
    // Stage::Commit runs AFTER append/heads/cleanup but BEFORE SQLite COMMIT.
    // This is NOT SQLITE_FULL or IOERR inside COMMIT.
    drop(k);
    close_reopen(&dir, s, &before);
}

#[test]
fn f05_sqlite_trigger_abort_during_snapshot_capture() {
    let (dir, s) = fixture();
    let k = JournalKernel::activate(&s).unwrap();
    seed(&k);
    k.write(|w| w.snapshot_allocate(SNAP, NOW)).unwrap();
    // Fail only once the first actual staged row exists in this transaction.
    s.execute_sql_for_test("CREATE TEMP TRIGGER task14c_capture_abort BEFORE INSERT ON sync_snapshot_rows WHEN NEW.ordinal=1 AND (SELECT count(*) FROM sync_snapshot_rows WHERE snapshot_id=NEW.snapshot_id)=1 BEGIN SELECT RAISE(ABORT,'TASK14C_SQLITE_TRIGGER_ABORT'); END");
    let before = state(&s);
    assert!(matches!(
        k.write(|w| w.snapshot_capture(SNAP, NOW)),
        Err(W::Snapshot(snapshot::SnapshotError::Sql))
    ));
    assert_eq!(text(&s, "SELECT state FROM sync_snapshots"), "pending");
    assert_eq!(count(&s, "SELECT count(*) FROM sync_snapshot_rows"), 0);
    s.execute_sql_for_test("DROP TRIGGER task14c_capture_abort");
    drop(k);
    let s = close_reopen(&dir, s, &before);
    let k = JournalKernel::activate(&s).unwrap();
    k.write(|w| w.snapshot_capture(SNAP, NOW)).unwrap();
    k.write(|w| w.snapshot_pack(SNAP)).unwrap();
    k.write(|w| w.snapshot_verify(SNAP)).unwrap();
}

#[test]
fn f06_sqlite_trigger_abort_at_snapshot_ready_publication() {
    let (dir, s) = fixture();
    let k = JournalKernel::activate(&s).unwrap();
    seed(&k);
    k.write(|w| w.snapshot_allocate(SNAP, NOW)).unwrap();
    k.write(|w| w.snapshot_capture(SNAP, NOW)).unwrap();
    s.execute_sql_for_test("CREATE TEMP TRIGGER task14c_pack_abort BEFORE UPDATE ON sync_snapshots WHEN NEW.state='ready' AND length(NEW.manifest_bytes)>0 BEGIN SELECT RAISE(ABORT,'TASK14C_SQLITE_TRIGGER_ABORT'); END");
    let before = state(&s);
    assert!(matches!(
        k.write(|w| w.snapshot_pack(SNAP)),
        Err(W::Snapshot(snapshot::SnapshotError::Sql))
    ));
    assert_eq!(text(&s, "SELECT state FROM sync_snapshots"), "materialized");
    assert_eq!(
        count(
            &s,
            "SELECT count(*) FROM sync_snapshots WHERE manifest_bytes IS NOT NULL"
        ),
        0
    );
    s.execute_sql_for_test("DROP TRIGGER task14c_pack_abort");
    drop(k);
    let s = close_reopen(&dir, s, &before);
    let k = JournalKernel::activate(&s).unwrap();
    k.write(|w| w.snapshot_pack(SNAP)).unwrap();
    k.write(|w| w.snapshot_verify(SNAP)).unwrap();
    let ready = state(&s);
    drop(k);
    close_reopen(&dir, s, &ready);
}

#[test]
fn f07_logical_injection_rollback_failure_poisons_owner() {
    let (dir, s) = fixture();
    let k = JournalKernel::activate(&s).unwrap();
    seed(&k);
    let before = state(&s);
    assert!(matches!(
        k.write_fault(Fault::Rollback, |w| w.create_capture(input("Poison test"))),
        Err(W::Journal(J::Rollback))
    ));
    assert_eq!(count(&s, "PRAGMA query_only"), 1);
    assert!(matches!(
        k.write(|w| w.create_capture(input("Refused after unconfirmed rollback"))),
        Err(W::Journal(J::Unavailable))
    ));
    // Existing seam performs SQL rollback then injects an unconfirmed result;
    // it proves fail-closed ownership, not a failed hardware rollback.
    drop(k);
    let s = close_reopen(&dir, s, &before);
    assert_eq!(count(&s, "PRAGMA query_only"), 0);
    let k = JournalKernel::activate(&s).unwrap();
    seed(&k);
    clean(&s);
}

#[test]
fn f08_logical_injection_reopen_preserves_ready_snapshot_and_history() {
    let (dir, s) = fixture();
    let k = JournalKernel::activate(&s).unwrap();
    seed(&k);
    k.write(|w| w.snapshot_allocate(SNAP, NOW)).unwrap();
    k.write(|w| w.snapshot_capture(SNAP, NOW)).unwrap();
    k.write(|w| w.snapshot_pack(SNAP)).unwrap();
    let before = state(&s);
    assert!(matches!(
        k.write_fault(Fault::At(Stage::Commit), |w| w.snapshot_verify(SNAP)),
        Err(W::Journal(J::Injected))
    ));
    drop(k);
    let s = close_reopen(&dir, s, &before);
    let k = JournalKernel::activate(&s).unwrap();
    k.write(|w| w.snapshot_verify(SNAP)).unwrap();
    assert_eq!(count(&s, "SELECT count(*) FROM sync_bundles"), 1);
    assert_eq!(text(&s, "SELECT state FROM sync_snapshots"), "ready");
}

#[test]
fn f09_logical_injection_selected_quota_reuses_q03_reopen_proof() {
    // Same mandatory negative proof, not another snapshot implementation.
    q03_snapshot_capture_metadata_quota_preserves_pending();
}

#[test]
fn f10_sqlite_trigger_abort_removed_then_retry_keeps_hash_chain() {
    let (dir, s) = fixture();
    let k = JournalKernel::activate(&s).unwrap();
    seed(&k);
    let first = cores(&s)[0].clone();
    s.execute_sql_for_test("CREATE TEMP TRIGGER task14c_retry_abort BEFORE INSERT ON sync_bundles BEGIN SELECT RAISE(ABORT,'TASK14C_SQLITE_TRIGGER_ABORT'); END");
    let before = state(&s);
    assert!(matches!(
        k.write(|w| w.create_capture(input("Retry only after confirmed rollback"))),
        Err(W::Journal(J::BundleInsert))
    ));
    assert_eq!(state(&s), before);
    clean(&s);
    s.execute_sql_for_test("DROP TRIGGER task14c_retry_abort");
    seed(&k);
    let after = cores(&s);
    assert_eq!(after.len(), 2);
    assert_eq!(after[0], first);
    assert_eq!(after[1].origin_seq, "2");
    assert_eq!(after[1].origin_incarnation, first.origin_incarnation);
    assert_eq!(
        after[1].previous_event_hash,
        codec::hash_hex(&codec::journal_event_hash(
            &codec::encode_canonical(&first).unwrap()
        ))
    );
    let before = state(&s);
    drop(k);
    close_reopen(&dir, s, &before);
}
