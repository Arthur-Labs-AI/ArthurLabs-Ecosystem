//! R5: existing physical admission/VFS around the actual G3 import transaction.
use super::*;
use crate::{
    storage::{
        journal::sync_fixtures as f,
        sync_store::{self, CandidateSyncStore},
    },
    sync::{
        trust::{TestTrust, TrustVerifier},
        *,
    },
};
use std::{
    collections::BTreeSet,
    sync::atomic::{AtomicU64, Ordering},
};
use uuid::Uuid;

struct Clock;
impl SyncClock for Clock {
    fn now(&self) -> u64 {
        0
    }
}
struct CapacitySwitch(AtomicU64);
impl CapacityProvider for CapacitySwitch {
    fn query(&self, _: &OwnedLocation) -> std::result::Result<Capacity, A> {
        Ok(Capacity {
            available: self.0.load(Ordering::SeqCst),
            allocation_unit: 4096,
            volume: "synthetic-import-volume".into(),
            file_identity: 1,
        })
    }
}
fn session(target: &CaptureStore, events: &[Envelope]) -> VerifiedSession {
    let local = Uuid::new_v4();
    let peer = Uuid::new_v4();
    let network = Uuid::new_v4();
    sync_store::install_candidate(target, network, local, &[(peer, 1)]).unwrap();
    f::install_g3(target);
    f::install_history(target);
    f::install_d4(target);
    let origins: BTreeSet<_> = events.iter().map(|e| e.identity.origin).collect();
    sync_store::grant_test_origins(target, peer, &origins);
    let hello = PeerHello {
        network,
        session: Uuid::new_v4(),
        local,
        peer,
        epoch: 1,
    };
    TestTrust {
        hello: hello.clone(),
        expires: 100,
        origins,
    }
    .verify(&hello)
    .unwrap()
}
fn retain(
    adapter: &CandidateSyncStore<'_>,
    s: &VerifiedSession,
    e: &Envelope,
) -> crate::sync::Result<Receipt> {
    adapter.retain(
        s,
        ValidatedEvent::parse(e.clone()).unwrap(),
        &Clock,
        &Cancellation::default(),
    )
}
fn admitted<'a>(target: &'a CaptureStore, capacity: Arc<CapacitySwitch>) -> CandidateSyncStore<'a> {
    let p = P::instrumented_profile_a();
    let physical = super::super::admission_session::PhysicalAdmission::bind(
        target,
        &target.connection.lock().unwrap(),
        p,
        capacity,
        ClaimPool::new(p.recovery),
    )
    .unwrap();
    CandidateSyncStore::admitted_for_test(target, physical)
}

#[test]
fn r5_import_admission_low_space_has_no_writes_and_capacity_retry_restores_budget() {
    let (_source_dir, _source_vfs, source) = fixture();
    sync_store::install_candidate(&source, Uuid::new_v4(), Uuid::new_v4(), &[]).unwrap();
    let k = JournalKernel::activate(&source).unwrap();
    let capture = k
        .write(|w| {
            w.create_capture(CreateCaptureInput {
                source: "text".into(),
                content: "🚀".repeat(crate::storage::capture_store::MAX_CAPTURE_CONTENT_CHARS),
                project_id: None,
            })
        })
        .unwrap();
    k.write(|w| {
        w.record_distillation(
            &capture.id,
            vec![crate::storage::knowledge_store::NewKnowledgeObject {
                kind: "idea".into(),
                title: "🚀".repeat(crate::storage::knowledge_store::MAX_TITLE_CHARS),
                body: "🚀".repeat(crate::storage::knowledge_store::MAX_BODY_CHARS),
                source_start: 0,
                source_end: crate::storage::capture_store::MAX_CAPTURE_CONTENT_CHARS as i64,
            }],
        )
    })
    .unwrap();
    drop(k);
    let events = sync_store::test_events(&source);
    let (_dir, vfs, target) = fixture();
    let s = session(&target, &events);
    let capacity = Arc::new(CapacitySwitch(AtomicU64::new(0)));
    let adapter = admitted(&target, capacity.clone());
    let before = state(&target);
    let max = target.query_i64_for_test("PRAGMA max_page_count");
    vfs.clear_records();
    assert!(matches!(
        retain(&adapter, &s, &events[0]),
        Err(Error::StorageLimited)
    ));
    assert_eq!(state(&target), before);
    assert!(!vfs.records().iter().any(|r| r.boundary == Boundary::Write));
    capacity.0.store(1024 * MIB, Ordering::SeqCst);
    for e in &events {
        retain(&adapter, &s, e).unwrap();
    }
    assert_eq!(target.query_i64_for_test("PRAGMA max_page_count"), max);
    assert_eq!(
        target.query_i64_for_test("SELECT count(*) FROM thought_revisions"),
        1
    );
    for event in &events {
        for op in &ValidatedEvent::parse(event.clone())
            .unwrap()
            .core()
            .operations
        {
            f::assert_same_row(&source, &target, op.entity(), op.key());
        }
    }
    assert_eq!(vfs.counts().0, vfs.counts().1);
    clean(&target);
}

#[test]
fn r5_import_multi_operation_full_ioerr_commit_rollback_reopen_and_measured_retry() {
    for (class, boundary, code) in [
        (Class::Journal, Boundary::Write, ffi::SQLITE_FULL),
        (Class::Main, Boundary::Write, ffi::SQLITE_IOERR_WRITE),
        (Class::Main, Boundary::Sync, ffi::SQLITE_IOERR_FSYNC),
    ] {
        let (_source_dir, _source_vfs, source) = fixture();
        sync_store::install_candidate(&source, Uuid::new_v4(), Uuid::new_v4(), &[]).unwrap();
        let (capture, _, _) = f::history(&source);
        let events = sync_store::test_events(&source);
        let original = events
            .iter()
            .find(|e| {
                ValidatedEvent::parse((*e).clone())
                    .unwrap()
                    .core()
                    .operations
                    .iter()
                    .any(|op| op.entity() == super::super::codec::EntityKind::KnowledgeObjects)
            })
            .unwrap();
        assert!(
            ValidatedEvent::parse(original.clone())
                .unwrap()
                .core()
                .operations
                .len()
                >= 4
        );
        let precursor = events
            .iter()
            .find(|e| {
                ValidatedEvent::parse((*e).clone())
                    .unwrap()
                    .core()
                    .operations
                    .iter()
                    .any(|op| {
                        op.entity() == super::super::codec::EntityKind::Captures
                            && op.key() == [capture.clone()]
                    })
            })
            .unwrap();
        let (dir, vfs, target) = fixture();
        let s = session(&target, &events);
        let capacity = Arc::new(CapacitySwitch(AtomicU64::new(1024 * MIB)));
        let adapter = admitted(&target, capacity.clone());
        assert_eq!(
            retain(&adapter, &s, precursor).unwrap().outcome,
            Outcome::CleanlyApplied
        );
        let before = state(&target);
        let max = target.query_i64_for_test("PRAGMA max_page_count");
        vfs.clear_records();
        vfs.inject(Injection {
            class,
            boundary,
            nth: 1,
            code,
        });
        assert!(retain(&adapter, &s, original).is_err());
        assert!(vfs
            .records()
            .iter()
            .any(|r| r.class == class && r.boundary == boundary && r.rc == code));
        assert_eq!(state(&target), before);
        assert_eq!(target.query_i64_for_test("PRAGMA max_page_count"), max);
        drop(adapter);
        let target = reopen(&dir, &vfs, target, &before);
        let adapter = admitted(&target, capacity);
        let start = std::fs::metadata(dir.path().join("arthur.db"))
            .unwrap()
            .len();
        vfs.clear_records();
        assert_eq!(
            retain(&adapter, &s, original).unwrap().outcome,
            Outcome::CleanlyApplied
        );
        assert_eq!(
            retain(&adapter, &s, original).unwrap().outcome,
            Outcome::CleanlyApplied
        );
        assert_eq!(
            target.query_i64_for_test("SELECT count(*) FROM knowledge_objects"),
            1
        );
        assert_eq!(
            target.query_i64_for_test("SELECT count(*) FROM thought_revisions"),
            1
        );
        let records = vfs.records();
        let main = records
            .iter()
            .filter(|r| r.class == Class::Main)
            .map(|r| r.end)
            .max()
            .unwrap_or(start)
            .saturating_sub(start);
        let journal = records
            .iter()
            .filter(|r| r.class == Class::Journal)
            .map(|r| r.end)
            .max()
            .unwrap_or(0);
        assert!(main <= 32 * MIB && journal <= start * 2 + MIB);
        assert!(records
            .iter()
            .any(|r| r.class == Class::Main && r.boundary == Boundary::Sync && r.session > 0));
        assert_eq!(vfs.counts().0, vfs.counts().1);
        clean(&target);
        println!("R5 measured G3 multi-operation import: main growth={main}, journal extent={journal}; synthetic admitted DELETE profile, not G4 approval");
    }
}

// Reuse C13's capability-checked subprocess, deterministic pipe barrier and
// kill/reopen owner lifecycle. No separate crash runner or storage owner type.
pub(super) fn crash_import(target: &CaptureStore, vfs: &OwnedVfs, mode: &str) {
    let root = target.owned_data_root().unwrap().join("source");
    std::fs::create_dir(&root).unwrap();
    let source = CaptureStore::open_owned(DataRootOwnership::try_acquire(&root).unwrap()).unwrap();
    upgrade(&source);
    sync_store::install_candidate(&source, Uuid::new_v4(), Uuid::new_v4(), &[]).unwrap();
    f::history(&source);
    let events = sync_store::test_events(&source);
    let s = session(target, &events);
    let adapter = admitted(target, Arc::new(CapacitySwitch(AtomicU64::new(1024 * MIB))));
    retain(&adapter, &s, &events[0]).unwrap();
    let before = fingerprint(target);
    target.execute_sql_for_test("PRAGMA cache_size=1; PRAGMA cache_spill=ON");
    vfs.clear_records();
    adapter
        .write(&s, &Clock, &Cancellation::default(), |c| {
            let receipt = sync_store::retain_in(
                c,
                &s,
                &ValidatedEvent::parse(events[1].clone()).unwrap(),
                &Clock,
                &Cancellation::default(),
            )?;
            assert_eq!(receipt.outcome, Outcome::CleanlyApplied);
            if mode == "import-before" {
                assert!(vfs.records().iter().any(|r| r.class == Class::Main
                    && r.boundary == Boundary::Write
                    && r.rc == ffi::SQLITE_OK));
                crash_barrier(&before, "-", "-");
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(mode, "import-after");
    crash_barrier(&fingerprint(target), "-", "-");
}

pub(super) fn retry_crashed_import(target: &CaptureStore, root: &std::path::Path, mode: &str) {
    let count = target.query_i64_for_test("SELECT count(*) FROM knowledge_objects");
    assert_eq!(count, if mode == "import-before" { 0 } else { 1 });
    assert_eq!(
        cores(target).len(),
        1,
        "foreign history must not become local originals"
    );
    let source = CaptureStore::reopen_candidate_owned_for_test(
        DataRootOwnership::try_acquire(&root.join("source")).unwrap(),
    )
    .unwrap();
    let events = sync_store::test_events(&source);
    let hello = {
        let c = target.connection.lock().unwrap();
        let (network, local): (String, String) = c
            .query_row("SELECT network,local_id FROM import_candidate", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        let peer: String = c
            .query_row("SELECT peer FROM import_members", [], |r| r.get(0))
            .unwrap();
        PeerHello {
            network: Uuid::parse_str(&network).unwrap(),
            local: Uuid::parse_str(&local).unwrap(),
            peer: Uuid::parse_str(&peer).unwrap(),
            session: Uuid::new_v4(),
            epoch: 1,
        }
    };
    let s = TestTrust {
        hello: hello.clone(),
        expires: 100,
        origins: events.iter().map(|e| e.identity.origin).collect(),
    }
    .verify(&hello)
    .unwrap();
    // C13 reopens with the same observed VFS, and the existing admission binds it.
    let adapter = admitted(target, Arc::new(CapacitySwitch(AtomicU64::new(1024 * MIB))));
    assert_eq!(
        retain(&adapter, &s, &events[1]).unwrap().outcome,
        Outcome::CleanlyApplied
    );
    assert_eq!(
        target.query_i64_for_test("SELECT count(*) FROM knowledge_objects"),
        1
    );
    assert_eq!(
        target.query_i64_for_test("SELECT count(*) FROM thought_revisions"),
        1
    );
    clean(target);
    clean(&source);
}

#[test]
fn r6_import_successful_commit_cleanup_failure_is_explicit_and_idempotent_after_reopen() {
    for restore_fault in [false,true] {
    let (_source_dir,_,source)=fixture();
    sync_store::install_candidate(&source,Uuid::new_v4(),Uuid::new_v4(),&[]).unwrap();
    f::history(&source);
    let events=sync_store::test_events(&source);
    let (dir,vfs,target)=fixture();
    let s=session(&target,&events);
    let capacity=Arc::new(CapacitySwitch(AtomicU64::new(1024*MIB)));
    let adapter=admitted(&target,capacity.clone());
    retain(&adapter,&s,&events[0]).unwrap();
    let guard = restore_fault.then(|| f::deny_post_commit_budget_restore(&target));
    if !restore_fault { vfs.inject(Injection {class:Class::Journal,boundary:Boundary::Close,nth:1,code:ffi::SQLITE_IOERR_CLOSE}); }
    let error=retain(&adapter,&s,&events[1]).err().expect("cleanup must block the receipt");
    assert_eq!(target.query_i64_for_test("SELECT count(*) FROM knowledge_objects"),1,"SQLite COMMIT actually succeeded");
    assert_eq!(target.query_i64_for_test("SELECT count(*) FROM import_g3_commits"),2);
    assert_eq!(error,Error::CommittedCleanupFailed);
    if let Some(g) = &guard { assert_eq!(g.hits(),1); }
    drop(guard);
    assert!(retain(&adapter,&s,&events[1]).is_err());
    assert_eq!(vfs.counts().0,vfs.counts().1);
    clean(&target);
    let committed=state(&target);
    drop(adapter);
    let target=reopen(&dir,&vfs,target,&committed);
    let adapter=admitted(&target,capacity);
    assert_eq!(retain(&adapter,&s,&events[1]).unwrap().outcome,Outcome::CleanlyApplied);
    assert_eq!(state(&target),committed);
    // Newly wired foreground settling uses the very same admitted transaction,
    // including when later original events were staged in reverse order.
    assert_eq!(retain(&adapter,&s,&events[4]).unwrap().outcome,Outcome::DeferredDependency);
    retain(&adapter,&s,&events[3]).unwrap();
    retain(&adapter,&s,&events[2]).unwrap();
    for _ in 0..4 { adapter.settle(&s,&Clock,&Cancellation::default()).unwrap(); }
    assert_eq!(target.query_i64_for_test("SELECT count(*) FROM import_events WHERE outcome='applied'"),5);
    assert_eq!(target.query_i64_for_test("SELECT max(applied) FROM import_progress"),5);
    assert_eq!(vfs.counts().0,vfs.counts().1);
    clean(&target);
    }
}
