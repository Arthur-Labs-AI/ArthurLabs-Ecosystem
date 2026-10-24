use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Barrier};
use std::thread;
use std::time::Duration;

use super::{owners, Entry, NativeRuntime, Reservation, RuntimeError};
use crate::storage::capture_store::{CaptureStore, CreateCaptureInput};
use crate::storage::knowledge_store::NewKnowledgeObject;
use crate::storage::lineage_store::Changes;
use crate::storage::ownership::fixtures::{mark_future_schema, schema_version};
use crate::storage::ownership::{DataRootOwnership, OwnershipError, OWNER_FILE};

fn text(content: &str) -> CreateCaptureInput {
    CreateCaptureInput {
        source: "text".into(),
        content: content.into(),
        project_id: None,
    }
}

#[test]
fn first_acquisition_and_reuse_share_the_same_store() {
    let dir = tempfile::tempdir().unwrap();
    let first = NativeRuntime::acquire(dir.path()).unwrap();
    let capture = first.create(text("A thought saved locally.")).unwrap();
    let second = NativeRuntime::acquire(dir.path()).unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    assert!(std::ptr::eq(first.store(), second.store()));
    assert_eq!(second.list().unwrap(), vec![capture]);
    assert_eq!(schema_version(&first), 9);
    assert_eq!(first.query_i64_for_test("PRAGMA foreign_keys"), 1);
    assert_eq!(first.query_i64_for_test("PRAGMA synchronous"), 2);
}

#[test]
fn canonical_path_aliases_reuse_the_owner() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("child")).unwrap();
    let first = NativeRuntime::acquire(dir.path()).unwrap();
    let alias = dir.path().join("child").join("..");
    let second = NativeRuntime::acquire(&alias).unwrap();
    assert!(Arc::ptr_eq(&first, &second));
}

#[cfg(windows)]
#[test]
fn windows_case_and_verbatim_path_aliases_reuse_the_owner() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("MixedCaseRoot");
    let first = NativeRuntime::acquire(&root).unwrap();
    let different_case = dir.path().join("mixedcaseroot");
    let second = NativeRuntime::acquire(&different_case).unwrap();
    let verbatim = NativeRuntime::acquire(first.data_root()).unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    assert!(Arc::ptr_eq(&first, &verbatim));
}

#[cfg(unix)]
#[test]
fn symlinked_root_aliases_reuse_the_owner() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("root");
    let first = NativeRuntime::acquire(&root).unwrap();
    let alias = dir.path().join("alias");
    std::os::unix::fs::symlink(&root, &alias).unwrap();
    let second = NativeRuntime::acquire(&alias).unwrap();
    assert!(Arc::ptr_eq(&first, &second));
}

#[test]
fn relative_roots_are_rejected_before_any_open() {
    assert!(matches!(
        NativeRuntime::acquire(Path::new("relative-root")),
        Err(RuntimeError::RelativeDataRoot)
    ));
}

#[test]
fn a_missing_private_root_is_created_without_ui() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("new").join("private");
    let runtime = NativeRuntime::acquire(&root).unwrap();
    assert_eq!(runtime.data_root(), fs::canonicalize(&root).unwrap());
    assert!(root.join("arthur.db").is_file());
    assert!(runtime.list().unwrap().is_empty());
}

#[test]
fn concurrent_acquisitions_never_create_independent_owners() {
    let dir = tempfile::tempdir().unwrap();
    let barrier = Arc::new(Barrier::new(8));
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let root = dir.path().to_path_buf();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                NativeRuntime::acquire(&root)
            })
        })
        .collect();
    // Keep every returned handle alive until all racers have completed.
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    let successes: Vec<_> = results
        .iter()
        .filter_map(|result| result.as_ref().ok())
        .collect();
    assert!(!successes.is_empty());
    for runtime in &successes {
        assert!(Arc::ptr_eq(successes[0], runtime));
    }
    for result in &results {
        assert!(result.is_ok() || matches!(result, Err(RuntimeError::Initializing)));
    }
    let reused = NativeRuntime::acquire(dir.path()).unwrap();
    assert!(Arc::ptr_eq(successes[0], &reused));
}

#[test]
fn an_in_progress_reservation_is_retryable_and_does_not_block_other_roots() {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    owners()
        .lock()
        .unwrap()
        .insert(root.clone(), Entry::Initializing);
    let reservation = Reservation {
        root,
        published: false,
    };
    assert!(matches!(
        NativeRuntime::acquire(dir.path()),
        Err(RuntimeError::Initializing)
    ));
    let independent = tempfile::tempdir().unwrap();
    let other = NativeRuntime::acquire(independent.path()).unwrap();
    assert!(other.list().unwrap().is_empty());
    drop(reservation);
    assert!(NativeRuntime::acquire(dir.path()).is_ok());
}

#[test]
fn independent_roots_do_not_share_data_or_locks() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let first = NativeRuntime::acquire(a.path()).unwrap();
    let second = NativeRuntime::acquire(b.path()).unwrap();
    assert!(!Arc::ptr_eq(&first, &second));
    first.create(text("Only in A.")).unwrap();
    assert!(second.list().unwrap().is_empty());
}

#[test]
fn an_independent_lock_owner_is_refused_and_retry_succeeds_after_release() {
    let dir = tempfile::tempdir().unwrap();
    let canonical = fs::canonicalize(dir.path()).unwrap();
    let independent = DataRootOwnership::try_acquire(&canonical).unwrap();
    assert!(matches!(
        NativeRuntime::acquire(dir.path()),
        Err(RuntimeError::Ownership(OwnershipError::InUse))
    ));
    assert!(
        !dir.path().join("arthur.db").exists(),
        "the rejected owner must not open SQLite"
    );
    assert!(
        matches!(
            DataRootOwnership::try_acquire(&canonical),
            Err(OwnershipError::InUse)
        ),
        "a failed contender must not release the established owner's lock"
    );
    drop(independent);
    assert!(NativeRuntime::acquire(dir.path()).is_ok());
}

#[test]
fn the_store_holds_the_lock_until_the_last_runtime_handle_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let first = NativeRuntime::acquire(dir.path()).unwrap();
    let second = first.clone();
    let canonical = first.data_root().to_path_buf();
    drop(first);
    assert!(matches!(
        DataRootOwnership::try_acquire(&canonical),
        Err(OwnershipError::InUse)
    ));
    drop(second);
    let lock = DataRootOwnership::try_acquire(&canonical).unwrap();
    drop(lock);
    assert!(
        dir.path().join(OWNER_FILE).exists(),
        "an unlocked leftover file is not stale ownership"
    );
    assert!(NativeRuntime::acquire(dir.path()).is_ok());
}

#[test]
fn a_failed_store_open_preserves_the_file_and_releases_both_reservation_and_lock() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("arthur.db");
    let invalid = b"Not a SQLite database";
    fs::write(&db, invalid).unwrap();
    assert!(matches!(
        NativeRuntime::acquire(dir.path()),
        Err(RuntimeError::Storage(_))
    ));
    assert_eq!(fs::read(&db).unwrap(), invalid);
    // This file belongs only to the temporary fixture; no production recovery deletes a DB.
    fs::remove_file(&db).unwrap();
    let reopened = NativeRuntime::acquire(dir.path()).unwrap();
    assert_eq!(schema_version(&reopened), 9);
}

#[test]
fn future_schema_refusal_leaves_no_stale_owner() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("arthur.db");
    let fixture = CaptureStore::open(&db).unwrap();
    mark_future_schema(&fixture);
    drop(fixture);
    let before = fs::read(&db).unwrap();
    for _ in 0..2 {
        assert!(matches!(
            NativeRuntime::acquire(dir.path()),
            Err(RuntimeError::Storage(_))
        ));
        assert_eq!(fs::read(&db).unwrap(), before);
    }
    assert!(DataRootOwnership::try_acquire(&fs::canonicalize(dir.path()).unwrap()).is_ok());
}

#[test]
fn a_directory_in_place_of_the_lock_is_refused_without_opening_sqlite() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join(OWNER_FILE)).unwrap();
    assert!(matches!(
        NativeRuntime::acquire(dir.path()),
        Err(RuntimeError::Ownership(OwnershipError::InvalidPath))
    ));
    assert!(!dir.path().join("arthur.db").exists());
    fs::remove_dir(dir.path().join(OWNER_FILE)).unwrap();
    assert!(NativeRuntime::acquire(dir.path()).is_ok());
}

#[cfg(unix)]
#[test]
fn symlinked_database_files_cannot_alias_an_independent_root() {
    use std::os::unix::fs::symlink;
    let first_dir = tempfile::tempdir().unwrap();
    let second_dir = tempfile::tempdir().unwrap();
    let owner = NativeRuntime::acquire(first_dir.path()).unwrap();
    symlink(
        first_dir.path().join("arthur.db"),
        second_dir.path().join("arthur.db"),
    )
    .unwrap();
    assert!(matches!(
        NativeRuntime::acquire(second_dir.path()),
        Err(RuntimeError::Ownership(OwnershipError::InvalidPath))
    ));
    assert!(owner.list().unwrap().is_empty());
}

#[test]
fn existing_v9_captures_provenance_and_revision_history_are_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("arthur.db");
    let fixture = CaptureStore::open(&db).unwrap();
    let source = "Идея за Arthur 🦀";
    let capture = fixture.create(text(source)).unwrap();
    let object = fixture
        .record_distillation(
            &capture.id,
            vec![NewKnowledgeObject {
                kind: "idea".into(),
                title: "Arthur".into(),
                body: source.into(),
                source_start: 0,
                source_end: source.chars().count() as i64,
            }],
        )
        .unwrap()
        .remove(0);
    fixture
        .update_object(
            &object.id,
            Changes {
                body: Some("A reviewed local edit.".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let objects = fixture.list_knowledge_objects().unwrap();
    let lineage = fixture.object_lineage(&object.id).unwrap();
    drop(fixture);
    let before = fs::read(&db).unwrap();
    let runtime = NativeRuntime::acquire(dir.path()).unwrap();
    assert_eq!(runtime.list().unwrap(), vec![capture]);
    assert_eq!(runtime.list_knowledge_objects().unwrap(), objects);
    assert_eq!(runtime.object_lineage(&object.id).unwrap(), lineage);
    assert_eq!(schema_version(&runtime), 9);
    drop(runtime);
    assert_eq!(
        fs::read(&db).unwrap(),
        before,
        "acquisition must not rewrite a v9 database"
    );
}

#[test]
fn acquisition_creates_only_storage_not_provider_or_background_service_state() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = NativeRuntime::acquire(dir.path()).unwrap();
    // No Activity/AppHandle, executor, provider configuration, credentials or service factory is
    // passed to acquisition. Check its filesystem effects as well as its storage-only type seam.
    let mut names: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    names.sort();
    let mut expected = vec![
        std::ffi::OsString::from(OWNER_FILE),
        std::ffi::OsString::from("arthur.db"),
    ];
    expected.sort();
    assert_eq!(names, expected);
    assert!(runtime.list().unwrap().is_empty());
}

#[test]
fn capture_validation_and_restart_durability_are_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = NativeRuntime::acquire(dir.path()).unwrap();
    assert!(runtime.create(text(" \n\t")).is_err());
    let capture = runtime
        .create(text("Kept across runtime lifetimes."))
        .unwrap();
    drop(runtime);
    let reopened = NativeRuntime::acquire(dir.path()).unwrap();
    assert_eq!(reopened.list().unwrap(), vec![capture]);
}

const PROBE_ROOT: &str = "ARTHUR_OWNERSHIP_TEST_ROOT";
const PROBE_MODE: &str = "ARTHUR_OWNERSHIP_TEST_MODE";
const READY: &str = "ARTHUR_TEST_OWNER_READY";

/// Invoked in a separate copy of this test binary, never in the real application or on user data.
#[test]
fn ownership_subprocess_probe() {
    let Some(root) = std::env::var_os(PROBE_ROOT) else {
        return;
    };
    match std::env::var(PROBE_MODE).unwrap().as_str() {
        "refuse" => assert!(matches!(
            NativeRuntime::acquire(Path::new(&root)),
            Err(RuntimeError::Ownership(OwnershipError::InUse))
        )),
        "hold" => {
            let runtime = NativeRuntime::acquire(Path::new(&root)).unwrap();
            println!("{READY}");
            std::io::stdout().flush().unwrap();
            let mut release = [0u8];
            let _ = std::io::stdin().read_exact(&mut release);
            drop(runtime);
        }
        _ => panic!("unknown ownership test mode"),
    }
}

struct Probe(Child);

impl Probe {
    fn spawn(root: &Path, mode: &str) -> Self {
        Self(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "runtime::tests::ownership_subprocess_probe",
                    "--nocapture",
                ])
                .env(PROBE_ROOT, root)
                .env(PROBE_MODE, mode)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        )
    }

    fn wait_for_owner(&mut self) {
        let stdout = self.0.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut reported_ready = false;
            // Keep draining after READY: closing the pipe early makes the child's test harness
            // fail with BrokenPipe when an otherwise graceful shutdown prints its result.
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if !reported_ready && line.contains(READY) {
                    let _ = tx.send(true);
                    reported_ready = true;
                }
            }
            if !reported_ready {
                let _ = tx.send(false);
            }
        });
        assert!(
            rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            "child never acquired ownership"
        );
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

#[test]
fn a_second_process_cannot_acquire_a_live_owner() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = NativeRuntime::acquire(dir.path()).unwrap();
    let mut probe = Probe::spawn(dir.path(), "refuse");
    assert!(probe.0.wait().unwrap().success());
    assert!(runtime.list().unwrap().is_empty());
}

#[test]
fn process_termination_releases_ownership_without_cleanup_or_pid_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let mut probe = Probe::spawn(dir.path(), "hold");
    probe.wait_for_owner();
    assert!(matches!(
        NativeRuntime::acquire(dir.path()),
        Err(RuntimeError::Ownership(OwnershipError::InUse))
    ));
    probe.0.kill().unwrap();
    probe.0.wait().unwrap();
    let recovered = NativeRuntime::acquire(dir.path()).unwrap();
    assert!(recovered.list().unwrap().is_empty());
}

#[test]
fn graceful_child_shutdown_releases_ownership() {
    let dir = tempfile::tempdir().unwrap();
    let mut probe = Probe::spawn(dir.path(), "hold");
    probe.wait_for_owner();
    assert!(matches!(
        NativeRuntime::acquire(dir.path()),
        Err(RuntimeError::Ownership(OwnershipError::InUse))
    ));
    probe.0.stdin.take().unwrap().write_all(&[1]).unwrap();
    assert!(probe.0.wait().unwrap().success());
    let recovered = NativeRuntime::acquire(dir.path()).unwrap();
    assert!(recovered.list().unwrap().is_empty());
}

#[test]
fn n7b_runtime_reacquisition_shares_coordinator_and_drop_cancels() {
    let dir = tempfile::tempdir().unwrap();
    let first = NativeRuntime::acquire(dir.path()).unwrap();
    let second = NativeRuntime::acquire(dir.path()).unwrap();
    assert!(std::ptr::eq(
        first.transport_candidate(),
        second.transport_candidate()
    ));
    first.transport_candidate().shutdown().unwrap();
    let h = crate::sync::security::route_candidate::Hint::parse(
        "192.168.1.3:7431",
        crate::sync::security::route_candidate::Origin::Manual,
    )
    .unwrap();
    assert!(second.transport_candidate().begin(h.clone()).is_err());
    drop(first);
    drop(second);
    let replacement = NativeRuntime::acquire(dir.path()).unwrap();
    assert!(replacement.transport_candidate().begin(h).is_ok());
}
