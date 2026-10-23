use super::codec::{EntityKind as K, FieldValue, Operation};
use super::reducer::ReviewContext;
use super::storage::{
    next_sequence, Fault, JournalError as E, JournalKernel, JournalTx, Limits, Stage,
};
use super::{codec, sql_effects as sql, stream};
use crate::storage::{capture_store::CaptureStore, migrations};
use rusqlite::{params, types::Value, Connection};

const NOW: &str = "2026-10-22T00:00:00Z";
fn id(n: u32) -> String {
    format!("{n:08x}-1234-4abc-8def-{n:012x}")
}
pub(super) fn upgrade(store: &CaptureStore) {
    let mut c = store.connection.lock().unwrap();
    let mut steps = migrations::STEPS.to_vec();
    steps.push((10, include_str!("../m05_v10.sql")));
    migrations::migrate_with(&mut c, &steps).unwrap();
}

fn upgraded() -> CaptureStore {
    let store = CaptureStore::open_in_memory().unwrap();
    upgrade(&store);
    store
}

fn historical() -> CaptureStore {
    let store = CaptureStore::open_in_memory().unwrap();
    crate::storage::m05_v10_tests::populated(&store.connection.lock().unwrap());
    upgrade(&store);
    store
}
fn scalar(store: &CaptureStore, query: &str) -> i64 {
    store
        .connection
        .lock()
        .unwrap()
        .query_row(query, [], |r| r.get(0))
        .unwrap()
}
fn insert(tx: &JournalTx<'_>, n: u32) -> Result<(), E> {
    insert_text(tx, n, "Идея 🦀 e\u{301}\u{1}")
}
fn insert_text(tx: &JournalTx<'_>, n: u32, text: &str) -> Result<(), E> {
    tx.sql().execute(
        "INSERT INTO captures(id,source,content,created_at,project_id) VALUES(?1,'text',?2,?3,?4)",
        params![id(n), text, NOW, migrations::INBOX_PROJECT_ID],
    )?;
    Ok(())
}
pub(super) fn cores(store: &CaptureStore) -> Vec<codec::JournalEvent> {
    let c = store.connection.lock().unwrap();
    let mut q = c
        .prepare(
            "SELECT canonical_bytes,canonical_hash,previous_hash FROM sync_bundles ORDER BY rowid",
        )
        .unwrap();
    q.query_map([], |r| {
        Ok((
            r.get::<_, Vec<u8>>(0)?,
            r.get::<_, Vec<u8>>(1)?,
            r.get::<_, Vec<u8>>(2)?,
        ))
    })
    .unwrap()
    .map(|r| {
        let (bytes, hash, prev) = r.unwrap();
        let core = codec::decode_core_strict(&bytes).unwrap();
        assert_eq!(codec::encode_canonical(&core).unwrap(), bytes);
        assert_eq!(codec::journal_event_hash(&bytes).as_slice(), hash);
        assert_eq!(
            core.previous_event_hash,
            codec::hash_hex(&prev.try_into().unwrap())
        );
        core
    })
    .collect()
}
pub(super) fn clean(store: &CaptureStore) {
    let c = store.connection.lock().unwrap();
    assert!(c.is_autocommit());
    for t in ["sync_effects", "sync_write_context"] {
        assert_eq!(
            c.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    assert_eq!(
        c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert!(!c
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
}
pub(super) fn state(store: &CaptureStore) -> Vec<(String, Vec<Vec<Value>>)> {
    let c = store.connection.lock().unwrap();
    let names = c
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    names
        .into_iter()
        .map(|name| {
            let count = c
                .prepare(&format!("SELECT * FROM {name}"))
                .unwrap()
                .column_count();
            let order = (1..=count)
                .map(|i| i.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let mut q = c
                .prepare(&format!("SELECT * FROM {name} ORDER BY {order}"))
                .unwrap();
            let rows = q
                .query_map([], |r| {
                    (0..count)
                        .map(|i| r.get(i))
                        .collect::<rusqlite::Result<Vec<Value>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            (name, rows)
        })
        .collect()
}
fn fixture_id(n: u32) -> String {
    format!("{n:08x}-0000-4000-8000-000000000000")
}
fn review(claim: String) -> ReviewContext {
    ReviewContext {
        action: codec::ReviewAction::Defer,
        proposal_id: None,
        claim_id: Some(claim),
        object_id: None,
        reviewed_revision_id: None,
        final_body: None,
        user_edited: None,
        result_revision_id: None,
        method: Some(codec::ReviewMethod::User),
    }
}
fn head(
    store: &CaptureStore,
    entity: K,
    key: Vec<String>,
    facet: &str,
) -> Option<(String, Vec<u8>)> {
    stream::stored_head(
        &store.connection.lock().unwrap(),
        &(entity, key, facet.into()),
    )
    .unwrap()
}

#[test]
fn k01_wrong_schema_policy_pointer_and_committed_transients_are_rejected() {
    let v9 = CaptureStore::open_in_memory().unwrap();
    assert!(matches!(JournalKernel::activate(&v9), Err(E::WrongSchema)));
    let store = upgraded();
    let k = JournalKernel::activate(&store).unwrap();
    store.execute_sql_for_test("DELETE FROM sync_local");
    assert_eq!(k.run(|_| Ok(())), Err(E::CorruptCapability));
    assert_eq!(scalar(&store, "SELECT count(*) FROM sync_local"), 0);
    for probe in ["PRAGMA synchronous=NORMAL", "PRAGMA query_only=ON"] {
        let s = upgraded();
        s.execute_sql_for_test(probe);
        assert!(matches!(JournalKernel::activate(&s), Err(E::Unavailable)));
    }
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    s.execute_sql_for_test(&format!("INSERT INTO sync_origins(origin_id,incarnation,status,opened_at,sealed_at) VALUES('{}','{}','sealed','{NOW}','{NOW}'); UPDATE sync_local SET active_incarnation='{}'",scalar_uuid(&s),id(999),id(999)));
    assert_eq!(k.run(|_| Ok(())), Err(E::CorruptCapability));
    assert!(matches!(
        JournalKernel::activate(&s),
        Err(E::CorruptCapability)
    ));
    for table in ["sync_write_context", "sync_effects"] {
        let s = upgraded();
        let k = JournalKernel::activate(&s).unwrap();
        k.run(|t| insert(t, 1)).unwrap();
        if table == "sync_write_context" {
            s.execute_sql_for_test("INSERT INTO sync_write_context(singleton,event_id) SELECT 1,event_id FROM sync_bundles");
        } else {
            s.execute_sql_for_test("INSERT INTO sync_effects(event_id,entity_kind,entity_key,after_json) SELECT event_id,'captures','[]','{}' FROM sync_bundles");
        }
        assert_eq!(k.run(|_| Ok(())), Err(E::TransientState));
        assert!(matches!(
            JournalKernel::activate(&s),
            Err(E::TransientState)
        ));
        assert_eq!(scalar(&s, &format!("SELECT count(*) FROM {table}")), 1);
    }
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    s.execute_sql_for_test(&format!(
        "UPDATE sync_origins SET status='sealed',sealed_at='{NOW}'"
    ));
    assert_eq!(k.run(|_| Ok(())), Err(E::CorruptCapability));
}
fn scalar_uuid(s: &CaptureStore) -> String {
    s.connection
        .lock()
        .unwrap()
        .query_row("SELECT origin_id FROM sync_local", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn k02_cold_activation_rotates_live_reuse_does_not_and_failed_init_rolls_back() {
    let s = upgraded();
    let before = state(&s);
    assert!(matches!(JournalKernel::init_fault(&s), Err(E::Injected)));
    assert_eq!(state(&s), before);
    let k = JournalKernel::activate(&s).unwrap();
    let origin = scalar_uuid(&s);
    k.run(|t| insert(t, 1)).unwrap();
    let first = cores(&s)[0].clone();
    k.run(|_| Ok(())).unwrap();
    assert_eq!(scalar(&s, "SELECT count(*) FROM sync_origins"), 1);
    let newer = JournalKernel::activate(&s).unwrap();
    assert_eq!(scalar_uuid(&s), origin);
    assert_eq!(
        scalar(
            &s,
            "SELECT count(*) FROM sync_origins WHERE status='sealed'"
        ),
        1
    );
    assert_eq!(
        scalar(
            &s,
            "SELECT last_seq FROM sync_origins WHERE status='active'"
        ),
        0
    );
    assert_eq!(k.run(|t| insert(t, 2)), Err(E::CorruptCapability));
    newer.run(|t| insert(t, 2)).unwrap();
    let all = cores(&s);
    assert_eq!(all[0], first);
    assert_ne!(all[0].origin_incarnation, all[1].origin_incarnation);
    assert_eq!(all[1].origin_seq, "1");
    clean(&s);
}

#[test]
fn k02_restored_older_synthetic_disk_uses_a_fresh_incarnation() {
    fn reopen(path: &std::path::Path) -> CaptureStore {
        let c = Connection::open(path).unwrap();
        c.pragma_update(None, "foreign_keys", true).unwrap();
        c.pragma_update(None, "synchronous", "FULL").unwrap();
        let s = CaptureStore::open_in_memory().unwrap();
        *s.connection.lock().unwrap() = c;
        upgrade(&s);
        s
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("synthetic.db");
    let s = CaptureStore::open(&path).unwrap();
    upgrade(&s);
    let k = JournalKernel::activate(&s).unwrap();
    k.run(|t| insert(t, 1)).unwrap();
    let first = cores(&s)[0].clone();
    drop(k);
    drop(s);
    let older = std::fs::read(&path).unwrap();
    let s = reopen(&path);
    let k = JournalKernel::activate(&s).unwrap();
    k.run(|t| insert(t, 2)).unwrap();
    let lost = cores(&s)[1].origin_incarnation.clone();
    drop(k);
    drop(s);
    std::fs::write(&path, older).unwrap();
    let s = reopen(&path);
    let k = JournalKernel::activate(&s).unwrap();
    k.run(|t| insert(t, 3)).unwrap();
    let all = cores(&s);
    assert_eq!(all[0], first);
    assert_ne!(all[1].origin_incarnation, lost);
    assert_ne!(all[1].origin_incarnation, first.origin_incarnation);
    assert_eq!(all[1].origin_seq, "1");
    clean(&s);
}

#[test]
fn k03_actual_capture_commits_one_complete_canonical_bundle() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    k.run(|t| insert(t, 3)).unwrap();
    assert_eq!(scalar(&s, "SELECT count(*) FROM captures"), 1);
    assert_eq!(scalar(&s, "SELECT count(*) FROM sync_bundles"), 1);
    assert_eq!(scalar(&s, "SELECT count(*) FROM sync_commit_fences"), 1);
    assert_eq!(
        scalar(
            &s,
            "SELECT last_seq FROM sync_origins WHERE status='active'"
        ),
        1
    );
    let core = cores(&s).pop().unwrap();
    assert_eq!(core.raw_effect_count, "1");
    assert_eq!(core.origin_seq, "1");
    assert_eq!(core.previous_event_hash, "0".repeat(64));
    let row = sql::reread(&s.connection.lock().unwrap(), K::Captures, &[id(3)])
        .unwrap()
        .unwrap();
    assert!(matches!(&core.operations[0],Operation::RecordCreate(c) if c.after==row));
    assert_eq!(core.dependencies.len(), 1);
    assert!(core.dependencies[0].event_ref.is_none());
    clean(&s);
}

#[test]
fn k04_multi_effect_creation_uses_final_object_state_and_one_outer_finalizer() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    let object = k
        .run(|t| {
            insert(t, 4)?;
            crate::storage::knowledge_store::begin_distillation_in(t.sql(), &id(4))
                .map_err(|_| E::Domain)?;
            let object = crate::storage::knowledge_store::insert_object_in(
                t.sql(),
                &id(4),
                migrations::INBOX_PROJECT_ID,
                crate::storage::knowledge_store::NewKnowledgeObject {
                    kind: "idea".into(),
                    title: "Идея".into(),
                    body: "🦀 e\u{301}".into(),
                    source_start: 5,
                    source_end: 9,
                },
            )
            .map_err(|_| E::Domain)?;
            Ok(object)
        })
        .unwrap();
    let core = cores(&s).pop().unwrap();
    assert_eq!(core.raw_effect_count, "6");
    assert_eq!(core.operations.len(), 5);
    assert_eq!(scalar(&s, "SELECT count(*) FROM sync_bundles"), 1);
    let row = sql::reread(
        &s.connection.lock().unwrap(),
        K::KnowledgeObjects,
        &[object.id.clone()],
    )
    .unwrap()
    .unwrap();
    assert!(!matches!(
        row.get("current_revision_id"),
        Some(FieldValue::Null)
    ));
    assert!(core.operations.iter().any(|op|matches!(op,Operation::RecordCreate(r) if r.entity==K::KnowledgeObjects && r.after==row)));
    for f in ["record", "membership", "head"] {
        assert_eq!(
            head(&s, K::KnowledgeObjects, vec![object.id.clone()], f)
                .unwrap()
                .0,
            core.event_id
        );
    }
    // A zero-object completion still includes its Capture dependency.
    k.run(|t| {
        crate::storage::knowledge_store::begin_distillation_in(t.sql(), &id(4))
            .map_err(|_| E::Domain)?;
        Ok(())
    })
    .unwrap();
    assert_eq!(cores(&s).len(), 1);
    clean(&s);
}

#[test]
fn k05_noops_local_only_timestamps_and_net_zero_are_distinct() {
    let s = historical();
    let k = JournalKernel::activate(&s).unwrap();
    k.run(|t| insert(t, 777)).unwrap();
    k.run(|t| {
        t.sql().execute(
            "UPDATE active_project SET project_id=?1",
            [migrations::INBOX_PROJECT_ID],
        )?;
        t.sql().execute(
            "UPDATE captures SET project_id=project_id WHERE id=?1",
            [id(777)],
        )?;
        Ok(false)
    })
    .unwrap();
    assert_eq!(cores(&s).len(), 1);
    k.run(|t| {
        t.sql().execute(
            "UPDATE pending_claims SET updated_at='2026-10-23T00:00:00Z' WHERE id=?1",
            [fixture_id(20)],
        )?;
        Ok(false)
    })
    .unwrap();
    assert_eq!(cores(&s).len(), 2);
    let before = state(&s);
    let result = k.run(|t| {
        t.sql().execute(
            "UPDATE projects SET name='Temporary' WHERE id=?1",
            [fixture_id(10)],
        )?;
        t.sql().execute(
            "UPDATE projects SET name='Synthetic project' WHERE id=?1",
            [fixture_id(10)],
        )?;
        Ok(())
    });
    assert_eq!(result, Err(E::UnsupportedEffects));
    assert_eq!(state(&s), before);
    clean(&s);
}

#[test]
fn k06_stored_core_hash_predecessor_and_restart_replay_are_exact() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    k.run(|t| insert(t, 6)).unwrap();
    k.run(|t| insert(t, 7)).unwrap();
    let all = cores(&s);
    assert_eq!(all[1].origin_seq, "2");
    assert_eq!(
        all[1].previous_event_hash,
        codec::hash_hex(&codec::journal_event_hash(
            &codec::encode_canonical(&all[0]).unwrap()
        ))
    );
    drop(k);
    let k = JournalKernel::activate(&s).unwrap();
    k.run(|t| insert(t, 8)).unwrap();
    assert_eq!(cores(&s)[..2], all);
    clean(&s);
}

#[test]
fn k08_independent_project_and_membership_facets_and_corrupt_priors() {
    let s = historical();
    let k = JournalKernel::activate(&s).unwrap();
    let p = fixture_id(10);
    let o = fixture_id(13);
    k.run(|t| {
        t.sql().execute(
            "UPDATE projects SET name='Renamed',updated_at=?1 WHERE id=?2",
            params![NOW, p],
        )?;
        Ok(())
    })
    .unwrap();
    let record = head(&s, K::Projects, vec![p.clone()], "record").unwrap();
    assert!(head(&s, K::Projects, vec![p.clone()], "lifecycle").is_none());
    k.run(|t| {
        t.sql().execute(
            "UPDATE projects SET archived_at=NULL,updated_at=?1 WHERE id=?2",
            params![NOW, p],
        )?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        head(&s, K::Projects, vec![p.clone()], "record").unwrap(),
        record
    );
    k.run(|t| {
        t.sql().execute(
            "UPDATE captures SET project_id=?1 WHERE id=?2",
            params![migrations::INBOX_PROJECT_ID, fixture_id(11)],
        )?;
        t.sql().execute(
            "UPDATE knowledge_objects SET project_id=?1 WHERE id=?2",
            params![migrations::INBOX_PROJECT_ID, o],
        )?;
        Ok(())
    })
    .unwrap();
    assert!(head(&s, K::KnowledgeObjects, vec![o], "head").is_none());
    assert!(head(&s, K::Captures, vec![fixture_id(11)], "record").is_none());
    s.execute_sql_for_test(
        "UPDATE sync_entity_heads SET state_hash=zeroblob(32) WHERE entity_kind='projects' AND facet='record'",
    );
    let before = state(&s);
    assert_eq!(
        k.run(|t| {
            t.sql()
                .execute("UPDATE projects SET name='Wrong prior' WHERE id=?1", [&p])?;
            Ok(())
        }),
        Err(E::MissingPrior)
    );
    assert_eq!(state(&s), before);
    s.execute_sql_for_test(
        "DELETE FROM sync_entity_heads WHERE entity_kind='projects' AND facet='record'",
    );
    let before = state(&s);
    assert_eq!(
        k.run(|t| {
            t.sql()
                .execute("UPDATE projects SET name='Again' WHERE id=?1", [p])?;
            Ok(())
        }),
        Err(E::MissingPrior)
    );
    assert_eq!(state(&s), before);
    assert!(matches!(JournalKernel::activate(&s), Err(E::MissingPrior)));
}

#[test]
fn k09_every_finalizer_fault_rolls_back_domain_journal_tip_and_heads() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    k.run(|t| insert(t, 9)).unwrap();
    let before = state(&s);
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
        assert_eq!(
            k.run_fault(Fault::At(stage), |t| insert(t, 10)),
            Err(E::Injected)
        );
        assert_eq!(state(&s), before);
        clean(&s);
    }
    assert_eq!(
        k.run(|t| {
            insert(t, 10)?;
            Err::<(), _>(E::Domain)
        }),
        Err(E::Domain)
    );
    assert_eq!(state(&s), before);
    // Real SQLite statement failures, not just stage checkpoints.
    for (table, event, error) in [
        ("sync_bundles", "INSERT", E::BundleInsert),
        ("sync_entity_heads", "INSERT", E::HeadUpdate),
        ("sync_effects", "DELETE", E::Cleanup),
    ] {
        s.execute_sql_for_test(&format!("CREATE TEMP TRIGGER task10_fault BEFORE {event} ON {table} BEGIN SELECT RAISE(ABORT,'synthetic fault'); END"));
        let before = state(&s);
        assert_eq!(k.run(|t| insert(t, 10)), Err(error));
        assert_eq!(state(&s), before);
        s.execute_sql_for_test("DROP TRIGGER task10_fault");
        clean(&s);
    }
    assert_eq!(
        k.run_fault(Fault::Rollback, |t| insert(t, 10)),
        Err(E::Rollback)
    );
    assert_eq!(k.run(|_| Ok(())), Err(E::Unavailable));
    assert_eq!(scalar(&s, "PRAGMA query_only"), 1);
}

#[test]
fn k10_failed_deferred_commit_without_bundle_is_explicitly_rolled_back() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    let before = state(&s);
    assert_eq!(
        k.run_fault(Fault::DeferredCommit, |t| insert(t, 10)),
        Err(E::CommitFailure(super::storage::SqliteCode { primary: 19, extended: rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY }))
    );
    assert_eq!(state(&s), before);
    clean(&s);
    k.run(|t| insert(t, 10)).unwrap();
    assert_eq!(cores(&s)[0].origin_seq, "1");
}

#[test]
fn k11_same_owner_threads_commit_consecutive_sequences_and_failure_consumes_none() {
    use std::sync::{Arc, Barrier, Condvar, Mutex};
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    let barrier = Arc::new(Barrier::new(5));
    let turn = Arc::new((Mutex::new(0), Condvar::new()));
    std::thread::scope(|scope| {
        let mut workers = Vec::new();
        for i in 0..5 {
            let barrier = barrier.clone();
            let turn = turn.clone();
            let kernel = &k;
            workers.push(scope.spawn(move || {
                barrier.wait();
                let (mutex, cv) = &*turn;
                let mut ticket = mutex.lock().unwrap();
                while *ticket != i {
                    ticket = cv.wait(ticket).unwrap();
                }
                let result = kernel.run(|t| {
                    assert!(!t.sql().is_autocommit());
                    insert(t, 100 + i)?;
                    if i == 2 {
                        Err(E::Domain)
                    } else {
                        Ok(t.sql() as *const Connection as usize)
                    }
                });
                *ticket += 1;
                cv.notify_all();
                result
            }));
        }
        let results = workers
            .into_iter()
            .map(|w| w.join().unwrap())
            .collect::<Vec<_>>();
        let pointers = results
            .iter()
            .filter_map(|r| r.as_ref().ok())
            .collect::<Vec<_>>();
        assert!(pointers.iter().all(|p| *p == pointers[0]));
        assert_eq!(results[2], Err(E::Domain));
    });
    let all = cores(&s);
    assert_eq!(
        all.iter()
            .map(|c| c.origin_seq.as_str())
            .collect::<Vec<_>>(),
        vec!["1", "2", "3", "4"]
    );
    assert_eq!(scalar(&s, "SELECT count(*) FROM captures"), 4);
    clean(&s);
}

#[test]
fn k12_review_proved_transitions_commit_while_deletions_fail_closed() {
    let s = historical();
    let k = JournalKernel::activate(&s).unwrap();
    let before = state(&s);
    let change = |t: &mut JournalTx<'_>| -> Result<(), E> {
        t.sql().execute(
            "UPDATE pending_claims SET state='deferred',deferred_at=?1,updated_at=?1 WHERE id=?2",
            params![NOW, fixture_id(20)],
        )?;
        Ok(())
    };
    assert_eq!(k.run(change), Err(E::ReviewContext));
    assert_eq!(state(&s), before);
    assert_eq!(
        k.run(|t| {
            t.register_review(K::PendingClaims, vec![fixture_id(20)], review(id(999)))?;
            change(t)
        }),
        Err(E::ReviewContext)
    );
    k.run(|t| {
            t.register_review(
                K::PendingClaims,
                vec![fixture_id(20)],
                review(fixture_id(20)),
            )?;
            change(t)
        })
        .unwrap();
    let core = cores(&s).pop().expect("proved defer emits one bundle");
    assert_eq!(core.operations.len(), 1);
    let Operation::FacetUpdate(update) = &core.operations[0] else {
        panic!("expected update");
    };
    assert_eq!(update.entity, K::PendingClaims);
    assert_eq!(update.key, vec![fixture_id(20)]);
    let proof = update.review_proof.as_ref().expect("defer carries proof");
    assert_eq!(proof.action, codec::ReviewAction::Defer);
    assert_eq!(proof.claim_id, Some(fixture_id(20)));
    let before = state(&s);
    let deletion = upgraded();
    let dk = JournalKernel::activate(&deletion).unwrap();
    dk.run(|t| insert(t, 120)).unwrap();
    let ds = state(&deletion);
    assert_eq!(
        dk.run(|t| {
            t.sql()
                .execute("DELETE FROM captures WHERE id=?1", [id(120)])?;
            Ok(())
        }),
        Err(E::UnsupportedEffects)
    );
    assert_eq!(state(&deletion), ds);
    k.remove_legacy_for_test(&(K::Relations, vec![fixture_id(52)]));
    assert_eq!(
        k.run(|t| {
            t.sql()
                .execute("DELETE FROM relations WHERE id=?1", [fixture_id(52)])?;
            Ok(())
        }),
        Err(E::MissingPrior)
    );
    assert_eq!(state(&s), before);
}

#[test]
fn k12_modern_model_removal_retains_creation_and_non_model_deletion_is_rejected() {
    let s = historical();
    let k = JournalKernel::activate(&s).unwrap();
    // New edges are created normally in the same owner transaction.
    k.run(|t| {
        crate::storage::relation_store::insert_all(
            t.sql(),
            vec![crate::storage::relation_store::NewRelation {
                kind: "depends_on".into(),
                source_object_id: fixture_id(13),
                target_object_id: fixture_id(50),
            }],
            "model",
        )
        .map_err(|_| E::Domain)?;
        Ok(())
    })
    .unwrap();
    let edge: String = s
        .connection
        .lock()
        .unwrap()
        .query_row(
            "SELECT id FROM relations WHERE kind='depends_on'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let created = cores(&s)[0].clone();
    k.contradict_provenance_for_test((K::Relations, vec![edge.clone()]));
    let before = state(&s);
    assert_eq!(
        k.run(|t| {
            t.sql()
                .execute("DELETE FROM relations WHERE id=?1", [&edge])?;
            Ok(())
        }),
        Err(E::MissingPrior)
    );
    assert_eq!(state(&s), before);
    drop(k);
    let k = JournalKernel::activate(&s).unwrap();
    k.run(|t| {
        t.sql()
            .execute("DELETE FROM relations WHERE id=?1", [&edge])?;
        Ok(())
    })
    .unwrap();
    assert!(
        matches!(&cores(&s)[1].operations[0],Operation::RelationRemove(r) if matches!(&r.observed_create,codec::ObservedCreate::Event(e) if e.event_id==created.event_id))
    );
    assert!(head(&s, K::Relations, vec![edge], "record").is_some());
    for origin in ["user", "system"] {
        let s = CaptureStore::open_in_memory().unwrap();
        crate::storage::m05_v10_tests::populated(&s.connection.lock().unwrap());
        // Historical relations are immutable: use a distinct valid v9 INSERT.
        s.execute_sql_for_test(&format!("INSERT INTO relations(id,kind,source_object_id,target_object_id,origin,created_at) VALUES('{}','depends_on','{}','{}','{origin}','{NOW}')",id(900),fixture_id(13),fixture_id(50)));
        upgrade(&s);
        let k = JournalKernel::activate(&s).unwrap();
        let before = state(&s);
        assert_eq!(
            k.run(|t| {
                t.sql().execute("DELETE FROM relations", [])?;
                Ok(())
            }),
            Err(E::UnsupportedEffects)
        );
        assert_eq!(state(&s), before);
    }
}

#[test]
fn k13_savepoint_discards_rolled_back_effects_counters_and_review_context() {
    let s = historical();
    let k = JournalKernel::activate(&s).unwrap();
    k.run(|t| {
        let result=t.savepoint(|nested| {nested.register_review(K::PendingClaims,vec![fixture_id(20)],review(fixture_id(20)))?;nested.sql().execute("UPDATE pending_claims SET state='deferred',deferred_at=?1,updated_at=?1 WHERE id=?2",params![NOW,fixture_id(20)])?;Err::<(),_>(E::Domain)});
        assert_eq!(result,Err(E::Domain));insert(t,13)
    }).unwrap();
    let core = cores(&s).pop().unwrap();
    assert_eq!(core.raw_effect_count, "1");
    assert_eq!(core.operations.len(), 1);
    assert_eq!(core.operations[0].entity(), K::Captures);
    clean(&s);
}

#[test]
fn k14_native_limits_quotas_size_and_exhaustion_roll_back() {
    assert_eq!(next_sequence(i64::MAX - 1), Ok(i64::MAX));
    assert_eq!(next_sequence(i64::MAX), Err(E::StreamExhausted));
    assert_eq!(next_sequence(-1), Err(E::CorruptCapability));
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    let before = state(&s);
    assert_eq!(
        k.run_fault(Fault::Exhausted, |t| insert(t, 14)),
        Err(E::StreamExhausted)
    );
    assert_eq!(state(&s), before);
    drop(k);
    for (limits, error) in [
        (
            Limits {
                core: 0,
                ..Limits::candidate()
            },
            E::BundleTooLarge,
        ),
        (
            Limits {
                payload: 0,
                ..Limits::candidate()
            },
            E::PayloadQuota,
        ),
        (
            Limits {
                metadata: 1200,
                ..Limits::candidate()
            },
            E::MetadataQuota,
        ),
        // Persisted metadata rejection with ample cache budget: the reserve
        // leaves room for initialization, but not bundle headers/fence/heads.
        (
            Limits {
                reserve: Some(64 * 1024 * 1024 - 350),
                ..Limits::candidate()
            },
            E::MetadataQuota,
        ),
    ] {
        let s = upgraded();
        let k = JournalKernel::activate_with_policy(&s, limits).unwrap();
        let before = state(&s);
        assert_eq!(k.run(|t| insert(t, 14)), Err(error));
        assert_eq!(state(&s), before);
        clean(&s);
    }
    let s = upgraded();
    assert!(matches!(
        JournalKernel::activate_with_policy(
            &s,
            Limits {
                reserve: None,
                ..Limits::candidate()
            }
        ),
        Err(E::PolicyPending)
    ));
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    let text = format!("A{}", "\u{1}".repeat(19999));
    k.run(|t| {
        for n in 0..34 {
            insert_text(t, 1000 + n, &text)?;
        }
        Ok(())
    })
    .unwrap();
    let before = state(&s);
    assert_eq!(
        k.run(|t| {
            for n in 0..35 {
                insert_text(t, 2000 + n, &text)?;
            }
            Ok(())
        }),
        Err(E::BundleTooLarge)
    );
    assert_eq!(state(&s), before);
    clean(&s);
}

#[test]
fn k14_raw_effect_4096_is_admitted_and_4097_rolls_back_every_capture() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    k.run(|t| {
        for n in 0..4096 {
            insert_text(t, 10000 + n, "A")?;
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(cores(&s)[0].raw_effect_count, "4096");
    let before = state(&s);
    assert_eq!(
        k.run(|t| {
            for n in 0..4097 {
                insert_text(t, 20000 + n, "A")?;
            }
            Ok(())
        }),
        Err(E::EffectLimit)
    );
    assert_eq!(state(&s), before);
    assert_eq!(scalar(&s, "SELECT count(*) FROM captures"), 4096);
    clean(&s);
}

#[test]
fn k01_valid_upgraded_owner_can_initialize_private_kernel() {
    let store = upgraded();
    assert!(JournalKernel::activate(&store).is_ok());
}

#[test]
fn k14_dependency_256_admitted_257_rejected_and_context_memory_is_bounded() {
    let s = CaptureStore::open_in_memory().unwrap();
    for n in 0..257 {
        s.execute_sql_for_test(&format!(
            "INSERT INTO projects(id,name,created_at,updated_at) VALUES('{}','Historical','{NOW}','{NOW}')", id(40000+n)
        ));
    }
    upgrade(&s);
    let k = JournalKernel::activate(&s).unwrap();
    let write = |t: &mut JournalTx<'_>, count, offset| -> Result<(), E> {
        for n in 0..count {
            t.sql().execute("INSERT INTO captures(id,source,content,created_at,project_id) VALUES(?1,'text','A',?2,?3)",params![id(offset+n),NOW,id(40000+n)])?;
        }
        Ok(())
    };
    k.run(|t| write(t, 256, 41000)).unwrap();
    assert_eq!(cores(&s)[0].dependencies.len(), 256);
    let before = state(&s);
    assert_eq!(k.run(|t| write(t, 257, 42000)), Err(E::IncompleteClosure));
    assert_eq!(state(&s), before);
    assert_eq!(
        k.run(|t| {
            insert(t, 43000)?;
            let mut context = review(id(43001));
            context.final_body = Some("x".repeat(sql::SPOOL_LIMIT as usize));
            t.register_review(K::PendingClaims, vec![id(43001)], context)
        }),
        Err(E::ReviewContext)
    );
    assert_eq!(state(&s), before);
    clean(&s);
}

#[test]
fn k12_proposal_context_identity_is_bound_to_surviving_row() {
    let s = historical();
    let k = JournalKernel::activate(&s).unwrap();
    let before = state(&s);
    let change = |t: &mut JournalTx<'_>| -> Result<(), E> {
        t.sql().execute("UPDATE revision_proposals SET state='deferred',updated_at=?1,reviewed_at=?1 WHERE id=?2",params![NOW,fixture_id(30)])?;
        Ok(())
    };
    assert_eq!(k.run(change), Err(E::ReviewContext));
    assert_eq!(
        k.run(|t| {
            let mut context = review(fixture_id(20));
            context.proposal_id = Some(id(999));
            t.register_review(K::RevisionProposals, vec![fixture_id(30)], context)?;
            change(t)
        }),
        Err(E::ReviewContext)
    );
    assert_eq!(state(&s), before);
    k.run(|t| {
        t.sql().execute(
            "UPDATE revision_proposals SET updated_at='2026-10-23T00:00:00Z' WHERE id=?1",
            [fixture_id(30)],
        )?;
        Ok(())
    })
    .unwrap();
    let core = cores(&s).pop().expect("metadata update emits one bundle");
    assert_eq!(core.operations.len(), 1);
    let Operation::FacetUpdate(update) = &core.operations[0] else {
        panic!("expected update");
    };
    assert_eq!(update.entity, K::RevisionProposals);
    let before = state(&s);
    assert!(update.review_proof.is_none());
    assert_eq!(k.run(|t| {
        t.sql().execute("INSERT INTO thought_revisions(id,object_id,kind,title,body,origin,created_at) VALUES(?1,?2,'idea','Automatic','Body','system',?3)",params![id(44000),fixture_id(13),NOW])?;
        t.sql().execute("INSERT INTO revision_parents(child_revision_id,parent_revision_id) VALUES(?1,?2)",params![id(44000),fixture_id(41)])?;
        Ok(())
    }),Err(E::IncompleteClosure));
    assert_eq!(state(&s), before);
    clean(&s);
}

#[test]
fn k07_all_twelve_actual_observer_images_and_closed_conversion_failures() {
    use super::reducer::FinalStateResolver;
    let (real, c) =
        crate::storage::m05_v10_tests::projection_fixture(include_str!("../m05_v10.sql"));
    crate::storage::m05_v10_tests::populated(&real);
    for (i, entity) in sql::ENTITIES.into_iter().enumerate() {
        let key = real
            .query_row(
                &format!(
                    "SELECT {} FROM {} LIMIT 1",
                    entity.key_fields().join(","),
                    entity.as_str()
                ),
                [],
                |r| {
                    (0..entity.key_fields().len())
                        .map(|j| {
                            if entity.key_element_is_decimal(j) {
                                r.get::<_, i64>(j).map(|n| n.to_string())
                            } else {
                                r.get(j)
                            }
                        })
                        .collect::<rusqlite::Result<Vec<String>>>()
                },
            )
            .unwrap();
        let mut expected = sql::reread(&real, entity, &key).unwrap().unwrap();
        if entity == K::ObjectSources {
            expected.insert(
                "source_start".into(),
                FieldValue::Decimal("9007199254740993".into()),
            );
            expected.insert(
                "source_end".into(),
                FieldValue::Decimal("9007199254740994".into()),
            );
        }
        if entity.all_fields().contains(&"title") {
            expected.insert(
                "title".into(),
                FieldValue::Text("Идея 🦀 e\u{301}\u{1}\n".into()),
            );
        }
        if entity == K::IdentityDecisions {
            expected.insert(
                "audit_json".into(),
                FieldValue::Text(" { \"raw\" : [1, 2] } ".into()),
            );
        }
        let values = entity
            .all_fields()
            .iter()
            .map(|f| match &expected[*f] {
                FieldValue::Null => Value::Null,
                FieldValue::Decimal(s) => Value::Integer(s.parse().unwrap()),
                FieldValue::Text(s) => Value::Text(s.clone()),
            })
            .collect::<Vec<_>>();
        c.execute_batch("BEGIN IMMEDIATE").unwrap();
        let event = id(700 + i as u32);
        c.execute(
            "INSERT INTO sync_write_context(singleton,event_id) VALUES(1,?1)",
            [&event],
        )
        .unwrap();
        let slots = vec!["?"; values.len()].join(",");
        c.execute(
            &format!("INSERT INTO {} VALUES({slots})", entity.as_str()),
            rusqlite::params_from_iter(values),
        )
        .unwrap();
        let effects = sql::effects(&c, &event).unwrap();
        assert_eq!(effects.len(), 1);
        assert_eq!(effects[0].after.as_ref(), Some(&expected));
        assert_eq!(effects[0].key, key);
        assert_eq!(
            sql::final_map(&c, &effects).unwrap().resolve(entity, &key),
            Some(expected.clone())
        );
        let raw: String = c
            .query_row("SELECT after_json FROM sync_effects", [], |r| r.get(0))
            .unwrap();
        let mut json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        json.as_object_mut().unwrap().remove(entity.all_fields()[0]);
        assert_eq!(sql::image(entity, &json.to_string()), Err(E::InvalidEffect));
        let mut json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        json["unknown"] = serde_json::json!(null);
        assert_eq!(sql::image(entity, &json.to_string()), Err(E::InvalidEffect));
        assert_eq!(sql::image(entity, "[]"), Err(E::InvalidEffect));
        assert_eq!(sql::key(entity, "[]"), Err(E::InvalidEffect));
        for field in entity.int_fields() {
            for invalid in [
                serde_json::json!(1.0),
                serde_json::json!("1"),
                serde_json::json!(-1),
                serde_json::json!(9223372036854775808u64),
            ] {
                let mut json: serde_json::Value = serde_json::from_str(&raw).unwrap();
                json[*field] = invalid;
                assert_eq!(sql::image(entity, &json.to_string()), Err(E::InvalidEffect));
            }
        }
        c.execute("UPDATE sync_effects SET entity_kind='unknown'", [])
            .unwrap();
        assert!(matches!(sql::effects(&c, &event), Err(E::InvalidEffect)));
        c.execute_batch("ROLLBACK").unwrap();
    }
    assert_eq!(
        sql::key(K::IdentityDecisions, &format!("[\"{}\",\"01\"]", id(1))),
        Err(E::InvalidEffect)
    );
    assert_eq!(
        sql::key(
            K::IdentityDecisions,
            &format!("[\"{}\",\"9223372036854775808\"]", id(1))
        ),
        Err(E::InvalidEffect)
    );
}

#[test]
fn k09_counter_drift_invalid_images_missing_projection_and_sql_read_failure_roll_back() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    let before = state(&s);
    for sql_text in [
        "UPDATE sync_write_context SET effect_count=0",
        "UPDATE sync_write_context SET staged_bytes=0",
        "UPDATE sync_effects SET entity_kind='unknown'",
        "UPDATE sync_effects SET entity_key='[]'",
        "UPDATE sync_effects SET after_json='{}'",
    ] {
        assert_eq!(
            k.run(|t| {
                insert(t, 901)?;
                t.sql().execute(sql_text, [])?;
                Ok(())
            }),
            Err(E::InvalidEffect)
        );
        assert_eq!(state(&s), before);
        clean(&s);
    }
    assert_eq!(k.run(|t|{insert(t,901)?;t.sql().execute("UPDATE sync_effects SET after_json=json_set(after_json,'$.content','forged')",[])?;t.sql().execute("UPDATE sync_write_context SET staged_bytes=(SELECT sum(length(CAST(after_json AS BLOB))) FROM sync_effects)",[])?;Ok(())}),Err(E::MissingFinalProjection));
    assert_eq!(state(&s), before);
    // An actual failed SELECT is an error, never apparent absence. DDL is rolled
    // back by the same owner transaction, restoring the domain table as well.
    assert_eq!(
        k.run(|t| {
            insert(t, 901)?;
            t.sql().execute_batch(
                "ALTER TABLE captures RENAME COLUMN content TO synthetic_unavailable",
            )?;
            Ok(())
        }),
        Err(E::FinalRead)
    );
    assert_eq!(state(&s), before);
    clean(&s);
    assert_eq!(
        sql::reread(&s.connection.lock().unwrap(), K::Captures, &[id(999)]),
        Ok(None)
    );
}

#[test]
fn k12_identity_creates_commit_while_orphan_objects_fail_closed() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    k.run(|t|{insert(t,910)?;t.sql().execute("INSERT INTO distillation_runs(capture_id,created_at) VALUES(?1,?2)",params![id(910),NOW])?;t.sql().execute("INSERT INTO identity_decisions(capture_id,ordinal,outcome,policy_version,model_id,decided_by,vetoes_json,audit_json,decided_at) VALUES(?1,0,'uncertain','test','fake','gate','[]','{}',?2)",params![id(910),NOW])?;Ok(())}).unwrap();
    let core = cores(&s).pop().expect("decision bundle commits");
    let before = state(&s);
    assert_eq!(core.operations.len(), 3);
    assert_eq!(k.run(|t|{t.sql().execute("INSERT INTO knowledge_objects(id,kind,title,body,created_at,project_id) VALUES(?1,'idea','Title','Body',?2,?3)",params![id(911),NOW,migrations::INBOX_PROJECT_ID])?;Ok(())}),Err(E::IncompleteClosure));
    assert_eq!(state(&s), before);
    clean(&s);
}

#[test]
fn k14_exact_spool_boundary_adapter_and_real_domain_overflow_rollback() {
    // Isolated projections distinguish observer/image structure from v9 content
    // limits. Whitespace padding affects staged bytes without altering images.
    let (_, c) = crate::storage::m05_v10_tests::projection_fixture(include_str!("../m05_v10.sql"));
    let event = id(920);
    c.execute_batch("BEGIN IMMEDIATE").unwrap();
    c.execute(
        "INSERT INTO sync_write_context(singleton,event_id) VALUES(1,?1)",
        [&event],
    )
    .unwrap();
    c.execute(
        "INSERT INTO captures(id,source,content,created_at,project_id) VALUES(?1,'text','A',?2,?3)",
        params![id(921), NOW, migrations::INBOX_PROJECT_ID],
    )
    .unwrap();
    let mut raw: String = c
        .query_row("SELECT after_json FROM sync_effects", [], |r| r.get(0))
        .unwrap();
    raw.push_str(&" ".repeat(sql::SPOOL_LIMIT as usize - raw.len()));
    c.execute("UPDATE sync_effects SET after_json=?1", [&raw])
        .unwrap();
    c.execute(
        "UPDATE sync_write_context SET staged_bytes=?1",
        [sql::SPOOL_LIMIT as i64],
    )
    .unwrap();
    assert_eq!(sql::effects(&c, &event).unwrap().len(), 1);
    raw.push(' ');
    c.execute("UPDATE sync_effects SET after_json=?1", [&raw])
        .unwrap();
    assert!(matches!(sql::effects(&c, &event), Err(E::SpoolLimit)));
    c.execute_batch("ROLLBACK").unwrap();
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    let before = state(&s);
    let body = "A".repeat(20000);
    assert_eq!(
        k.run(|t| {
            for n in 0..420 {
                insert_text(t, 30000 + n, &body)?;
            }
            Ok(())
        }),
        Err(E::SpoolLimit)
    );
    assert_eq!(state(&s), before);
    clean(&s);
}
