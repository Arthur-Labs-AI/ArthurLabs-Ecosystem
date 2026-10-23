use super::codec;
use super::snapshot::{self, SnapshotPolicy};
use super::storage::{JournalError as J, JournalKernel};
use super::writers::WriterError as E;
use crate::storage::{capture_store::CaptureStore, migrations};
use rusqlite::{params, Connection};
use std::collections::BTreeMap;

fn upgraded() -> CaptureStore {
    let store = CaptureStore::open_in_memory().unwrap();
    let mut steps = migrations::STEPS.to_vec();
    steps.push((10, include_str!("../m05_v10.sql")));
    migrations::migrate_with(&mut store.connection.lock().unwrap(), &steps).unwrap();
    store
}

fn lock_id() -> String {
    "aaaaaaaa-1111-4111-8111-111111111111".into()
}

fn bundle_key(event: &str, index: Option<usize>) -> String {
    match index {
        Some(i) => serde_json::to_string(&vec![event.to_string(), i.to_string()]).unwrap(),
        None => serde_json::to_string(&vec![event.to_string()]).unwrap(),
    }
}

fn query_count(s: &CaptureStore, sql: &str) -> i64 {
    let _ = 1;
    s.connection
        .lock()
        .unwrap()
        .query_row(sql, [], |r| r.get(0))
        .unwrap()
}

fn snapshot_state(s: &CaptureStore, id: &str) -> String {
    s.connection
        .lock()
        .unwrap()
        .query_row(
            "SELECT state FROM sync_snapshots WHERE snapshot_id=?1",
            [id],
            |r| r.get::<_, String>(0),
        )
        .unwrap()
}

fn populate(s: &CaptureStore, k: &JournalKernel) {
    use crate::storage::identity_store::{
        DecisionAudit, DecisionOutcome, IdentityDecisionInput, PendingClaimInput,
    };
    use crate::storage::lineage_store::ExpectedRevision;
    use crate::storage::proposal_store::{EvidenceRef, NewProposal};
    let cap = k
        .write(|w| {
            w.create_capture(crate::storage::capture_store::CreateCaptureInput {
                source: "text".into(),
                content: "Capture text for snapshot".into(),
                project_id: None,
            })
        })
        .unwrap();
    let objects = k
        .write(|w| {
            w.record_distillation(
                &cap.id,
                vec![crate::storage::knowledge_store::NewKnowledgeObject {
                    kind: "idea".into(),
                    title: "Object".into(),
                    body: "Body text".into(),
                    source_start: 0,
                    source_end: 7,
                }],
            )
        })
        .unwrap();
    let o = &objects[0];
    let decision = IdentityDecisionInput {
        capture_id: cap.id.clone(),
        ordinal: 0,
        outcome: DecisionOutcome::Uncertain,
        unchecked_reason: None,
        target_object_id: None,
        base_revision_id: None,
        result_revision_id: None,
        created_object_id: None,
        policy_version: "test".into(),
        model_id: Some("synthetic".into()),
        vetoes: vec![],
        audit: DecisionAudit {
            candidates_sent: vec![o.id.clone()],
            runs: 1,
            ..DecisionAudit::default()
        },
    };
    let claim = k
        .write(|w| {
            w.stage_uncertain_claim(PendingClaimInput {
                decision,
                kind: "idea".into(),
                title: "Pending".into(),
                body: "Body".into(),
                source_start: 0,
                source_end: 7,
                candidate_ids: vec![o.id.clone()],
                due_at: None,
            })
        })
        .unwrap()
        .0;
    let base = s.current_revision_id_of(&o.id).unwrap().unwrap();
    k.write(|w| {
        w.insert_proposal(NewProposal {
            pending_claim_id: claim.id.clone(),
            object_id: o.id.clone(),
            base_revision_id: base,
            change: "additive".into(),
            kind: "idea".into(),
            title: "Draft".into(),
            proposed_body: "Draft body".into(),
            retracts: None,
            evidence: vec![EvidenceRef {
                role: "claim".into(),
                capture_id: cap.id.clone(),
                start: 0,
                end: 7,
            }],
            synthesis_model: "synthetic".into(),
            verifier_model: "synthetic".into(),
            verification_mode: "independent".into(),
            policy_version: "test".into(),
        })
    })
    .unwrap();
}

#[test]
fn s01_snapshot_capture_freezes_exact_history_with_closure() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    populate(&s, &k);
    let bundles_before = query_count(&s, "SELECT count(*) FROM sync_bundles");
    assert!(bundles_before > 0);
    let id = lock_id();
    k.write(|w| w.snapshot_allocate(&id, "2026-10-22T00:00:00Z"))
        .unwrap();
    assert_eq!(snapshot_state(&s, &id), "pending");
    let summary = k
        .write(|w| w.snapshot_capture(&id, "2026-10-22T00:00:01Z"))
        .unwrap();
    assert_eq!(snapshot_state(&s, &id), "materialized");
    assert!(summary.row_count > 0);
    assert!(summary.total_bytes > 0);
    let staged: i64 = query_count(
        &s,
        &format!("SELECT count(*) FROM sync_snapshot_rows WHERE snapshot_id='{id}'"),
    );
    assert_eq!(staged as usize, summary.row_count);
    let row_count: i64 = s
        .connection
        .lock()
        .unwrap()
        .query_row(
            "SELECT row_count FROM sync_snapshots WHERE snapshot_id=?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(row_count as usize, summary.row_count);
    for entity in [
        "projects",
        "captures",
        "distillation_runs",
        "knowledge_objects",
        "object_sources",
        "thought_revisions",
        "revision_parents",
        "relations",
        "identity_decisions",
        "revision_evidence",
        "pending_claims",
        "revision_proposals",
    ] {
        let n: i64 = s.connection.lock().unwrap().query_row(&format!("SELECT count(*) FROM sync_snapshot_rows WHERE snapshot_id=?1 AND entity_kind=?2", ), params![id, entity], |r| r.get(0)).unwrap();
        let live: i64 = query_count(&s, &format!("SELECT count(*) FROM {entity}"));
        assert_eq!(n, live, "entity {entity} fully staged");
    }
    for pseudo in ["@origin", "@facet", "@bundle"] {
        let n: i64 = s
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM sync_snapshot_rows WHERE snapshot_id=?1 AND entity_kind=?2",
                params![id, pseudo],
                |r| r.get(0),
            )
            .unwrap();
        assert!(n > 0, "{pseudo} metadata present");
    }
    let boundary: Vec<u8> = s
        .connection
        .lock()
        .unwrap()
        .query_row(
            "SELECT boundary_bytes FROM sync_snapshots WHERE snapshot_id=?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    let boundary_json: serde_json::Value = serde_json::from_slice(&boundary).unwrap();
    assert_eq!(
        boundary_json["profile"],
        serde_json::Value::String(super::snapshot::SNAPSHOT_PROFILE.into())
    );
    assert_eq!(boundary_json["codecVersion"], serde_json::Value::from(1));
    assert_eq!(
        boundary_json["rowCount"],
        serde_json::Value::from(summary.row_count as i64)
    );
}

#[test]
fn s02_snapshot_pack_produces_verified_ready_manifest() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    populate(&s, &k);
    let id = lock_id();
    k.write(|w| w.snapshot_allocate(&id, "2026-10-22T00:00:00Z"))
        .unwrap();
    let summary = k
        .write(|w| w.snapshot_capture(&id, "2026-10-22T00:00:01Z"))
        .unwrap();
    k.write(|w| w.snapshot_pack(&id)).unwrap();
    assert_eq!(snapshot_state(&s, &id), "ready");
    k.write(|w| w.snapshot_verify(&id)).unwrap();
    let manifest_bytes: Vec<u8> = s
        .connection
        .lock()
        .unwrap()
        .query_row(
            "SELECT manifest_bytes FROM sync_snapshots WHERE snapshot_id=?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes).unwrap();
    assert_eq!(manifest["snapshotId"].as_str(), Some(id.as_str()));
    assert_eq!(
        manifest["rowCount"].as_i64(),
        Some(summary.row_count as i64)
    );
    assert_eq!(
        manifest["totalBytes"].as_i64(),
        Some(summary.total_bytes as i64)
    );
    let chunks = manifest["chunks"].as_array().expect("chunks");
    assert!(!chunks.is_empty());
    let chunked: usize = chunks
        .iter()
        .map(|c| c["count"].as_u64().unwrap() as usize)
        .sum();
    assert_eq!(chunked, summary.row_count);
    let covered = manifest["coveredCores"].as_array().expect("covered cores");
    let bundles: i64 = query_count(&s, "SELECT count(*) FROM sync_bundles");
    assert_eq!(covered.len() as i64, bundles);
    assert!(manifest["closureDigest"].as_str().is_some());
}

#[test]
fn s03_writes_after_capture_appear_only_in_catch_up() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    populate(&s, &k);
    let id = lock_id();
    k.write(|w| w.snapshot_allocate(&id, "2026-10-22T00:00:00Z"))
        .unwrap();
    let summary = k
        .write(|w| w.snapshot_capture(&id, "2026-10-22T00:00:01Z"))
        .unwrap();
    k.write(|w| w.snapshot_pack(&id)).unwrap();
    k.write(|w| w.snapshot_verify(&id)).unwrap();
    let bundles_packed: i64 = query_count(&s, "SELECT count(*) FROM sync_bundles");
    k.write(|w| {
        w.create_capture(crate::storage::capture_store::CreateCaptureInput {
            source: "text".into(),
            content: "Later note".into(),
            project_id: None,
        })
    })
    .unwrap();
    let bundles_now: i64 = query_count(&s, "SELECT count(*) FROM sync_bundles");
    assert!(bundles_now > bundles_packed);
    k.write(|w| w.snapshot_verify(&id)).unwrap();
    let staged: i64 = query_count(
        &s,
        &format!("SELECT count(*) FROM sync_snapshot_rows WHERE snapshot_id='{id}'"),
    );
    assert_eq!(staged as usize, summary.row_count);
}
#[test]
fn s04_snapshot_bounds_and_admission_fail_closed() {
    use super::snapshot::SnapshotPolicy;
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    populate(&s, &k);
    let id = lock_id();
    k.write(|w| w.snapshot_allocate(&id, "2026-10-22T00:00:00Z"))
        .unwrap();
    assert!(matches!(
        k.write(|w| w.snapshot_allocate(
            "bbbbbbbb-2222-4222-8222-222222222222",
            "2026-10-22T00:00:00Z"
        )),
        Err(super::writers::WriterError::Snapshot(
            super::snapshot::SnapshotError::Exists
        ))
    ));
    let mut tiny = SnapshotPolicy::candidate();
    tiny.max_records = 1;
    assert!(matches!(
        k.write(|w| w.snapshot_capture_with(&id, "2026-10-22T00:00:01Z", tiny)),
        Err(super::writers::WriterError::Snapshot(
            super::snapshot::SnapshotError::Limit
        ))
    ));
    assert_eq!(snapshot_state(&s, &id), "pending");
    let mut instant = SnapshotPolicy::candidate();
    instant.capture_timeout = std::time::Duration::from_nanos(0);
    assert!(matches!(
        k.write(|w| w.snapshot_capture_with(&id, "2026-10-22T00:00:01Z", instant)),
        Err(super::writers::WriterError::Snapshot(
            super::snapshot::SnapshotError::Timeout
        ))
    ));
    assert_eq!(snapshot_state(&s, &id), "pending");
    let staged: i64 = query_count(
        &s,
        &format!("SELECT count(*) FROM sync_snapshot_rows WHERE snapshot_id='{id}'"),
    );
    assert_eq!(staged, 0);
}

#[test]
fn s05_interrupted_capture_recovers_through_abort_and_retry() {
    use super::storage::Fault;
    use super::storage::Stage;
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    populate(&s, &k);
    let id = lock_id();
    k.write(|w| w.snapshot_allocate(&id, "2026-10-22T00:00:00Z"))
        .unwrap();
    assert!(matches!(
        k.write_fault(Fault::At(Stage::Commit), |w| w
            .snapshot_capture(&id, "2026-10-22T00:00:01Z")),
        Err(super::writers::WriterError::Journal(
            super::storage::JournalError::Injected
        ))
    ));
    assert_eq!(snapshot_state(&s, &id), "pending");
    let staged: i64 = query_count(
        &s,
        &format!("SELECT count(*) FROM sync_snapshot_rows WHERE snapshot_id='{id}'"),
    );
    assert_eq!(staged, 0);
    k.write(|w| w.snapshot_abort(&id)).unwrap();
    assert_eq!(snapshot_state(&s, &id), "aborted");
    let id2 = "bbbbbbbb-2222-4222-8222-222222222222";
    k.write(|w| w.snapshot_allocate(id2, "2026-10-22T00:00:02Z"))
        .unwrap();
    let summary = k
        .write(|w| w.snapshot_capture(id2, "2026-10-22T00:00:03Z"))
        .unwrap();
    assert!(summary.row_count > 0);
    assert_eq!(snapshot_state(&s, id2), "materialized");
}
#[test]
fn s06_interrupted_pack_retries_without_losing_staged_rows() {
    use super::storage::{Fault, Stage};
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    populate(&s, &k);
    let id = lock_id();
    k.write(|w| w.snapshot_allocate(&id, "2026-10-22T00:00:00Z"))
        .unwrap();
    k.write(|w| w.snapshot_capture(&id, "2026-10-22T00:00:01Z"))
        .unwrap();
    assert_eq!(snapshot_state(&s, &id), "materialized");
    let staged: i64 = query_count(
        &s,
        &format!("SELECT count(*) FROM sync_snapshot_rows WHERE snapshot_id='{id}'"),
    );
    assert!(staged > 0);
    assert!(matches!(
        k.write_fault(Fault::At(Stage::Commit), |w| w.snapshot_pack(&id)),
        Err(super::writers::WriterError::Journal(
            super::storage::JournalError::Injected
        ))
    ));
    assert_eq!(snapshot_state(&s, &id), "materialized");
    k.write(|w| w.snapshot_pack(&id)).unwrap();
    assert_eq!(snapshot_state(&s, &id), "ready");
    k.write(|w| w.snapshot_verify(&id)).unwrap();
}
#[test]
fn s07_tampered_manifest_is_detected_not_trusted() {
    use sha2::Digest;
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    populate(&s, &k);
    let id = lock_id();
    k.write(|w| w.snapshot_allocate(&id, "2026-10-22T00:00:00Z"))
        .unwrap();
    k.write(|w| w.snapshot_capture(&id, "2026-10-22T00:00:01Z"))
        .unwrap();
    // A corrupt packer writes garbage through the allowed transition.
    s.connection.lock().unwrap().execute(
        "UPDATE sync_snapshots SET state='ready',manifest_bytes=randomblob(32),manifest_hash=randomblob(32) WHERE snapshot_id=?1 AND state='materialized'",
        [&id],
    ).unwrap();
    assert_eq!(snapshot_state(&s, &id), "ready");
    assert!(matches!(
        k.write(|w| w.snapshot_verify(&id)),
        Err(super::writers::WriterError::Snapshot(
            super::snapshot::SnapshotError::Corrupt
        ))
    ));
}

#[test]
fn s07b_well_formed_wrong_manifest_fails_rebuild_comparison() {
    use sha2::Digest;
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    populate(&s, &k);
    let t = upgraded();
    let kt = JournalKernel::activate(&t).unwrap();
    populate(&t, &kt);
    let id2 = "bbbbbbbb-2222-4222-8222-222222222222";
    k.write(|w| w.snapshot_allocate(id2, "2026-10-22T00:00:02Z"))
        .unwrap();
    k.write(|w| w.snapshot_capture(id2, "2026-10-22T00:00:03Z"))
        .unwrap();
    let id3 = "cccccccc-3333-4333-8333-333333333333";
    kt.write(|w| w.snapshot_allocate(id3, "2026-10-22T00:00:04Z"))
        .unwrap();
    kt.write(|w| w.snapshot_capture(id3, "2026-10-22T00:00:05Z"))
        .unwrap();
    kt.write(|w| w.snapshot_pack(id3)).unwrap();
    kt.write(|w| w.snapshot_verify(id3)).unwrap();
    let good: Vec<u8> = t
        .connection
        .lock()
        .unwrap()
        .query_row(
            "SELECT manifest_bytes FROM sync_snapshots WHERE snapshot_id=?1",
            [id3],
            |r| r.get(0),
        )
        .unwrap();
    let mut manifest: serde_json::Value = serde_json::from_slice(&good).unwrap();
    manifest["snapshotId"] = serde_json::Value::String(id2.into());
    manifest["rowCount"] = serde_json::Value::from(999999i64);
    let tampered = serde_jcs::to_vec(&manifest).unwrap();
    let mut hasher = sha2::Sha256::new();
    hasher.update(&tampered);
    let digest: Vec<u8> = hasher.finalize().to_vec();
    s.connection.lock().unwrap().execute(
        "UPDATE sync_snapshots SET state='ready',manifest_bytes=?1,manifest_hash=?2 WHERE snapshot_id=?3 AND state='materialized'",
        rusqlite::params![tampered, digest, id2],
    ).unwrap();
    assert_eq!(snapshot_state(&s, id2), "ready");
    assert!(matches!(
        k.write(|w| w.snapshot_verify(id2)),
        Err(super::writers::WriterError::Snapshot(
            super::snapshot::SnapshotError::Corrupt
        ))
    ));
}

#[test]
fn s08_cold_activation_seals_prior_incarnation_and_restarts_sequence() {
    let s = upgraded();
    let first = {
        let k = JournalKernel::activate(&s).unwrap();
        k.write(|w| {
            w.create_capture(crate::storage::capture_store::CreateCaptureInput {
                source: "text".into(),
                content: "First".into(),
                project_id: None,
            })
        })
        .unwrap();
        let cores: Vec<super::codec::JournalEvent> = {
            let c = s.connection.lock().unwrap();
            let mut q = c
                .prepare("SELECT canonical_bytes FROM sync_bundles ORDER BY rowid")
                .unwrap();
            q.query_map([], |r| r.get::<_, Vec<u8>>(0))
                .unwrap()
                .map(|b| codec::decode_core_strict(&b.unwrap()).unwrap())
                .collect::<Vec<_>>()
        };
        assert_eq!(cores[0].origin_seq, "1");
        cores
    };
    let incarnation_before: String = s
        .connection
        .lock()
        .unwrap()
        .query_row(
            "SELECT active_incarnation FROM sync_local WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let second = {
        let k = JournalKernel::activate(&s).unwrap();
        k.write(|w| {
            w.create_capture(crate::storage::capture_store::CreateCaptureInput {
                source: "text".into(),
                content: "Second".into(),
                project_id: None,
            })
        })
        .unwrap();
        let cores: Vec<super::codec::JournalEvent> = {
            let c = s.connection.lock().unwrap();
            let mut q = c
                .prepare("SELECT canonical_bytes FROM sync_bundles ORDER BY rowid")
                .unwrap();
            q.query_map([], |r| r.get::<_, Vec<u8>>(0))
                .unwrap()
                .map(|b| codec::decode_core_strict(&b.unwrap()).unwrap())
                .collect::<Vec<_>>()
        };
        cores
    };
    let incarnation_after: String = s
        .connection
        .lock()
        .unwrap()
        .query_row(
            "SELECT active_incarnation FROM sync_local WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_ne!(incarnation_before, incarnation_after);
    assert_eq!(second.len(), 2);
    assert_eq!(second[0], first[0]);
    assert_eq!(second[1].origin_seq, "1");
    assert_ne!(second[1].origin_incarnation, second[0].origin_incarnation);
    let sealed: i64 = s
        .connection
        .lock()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM sync_origins WHERE status='sealed'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(sealed, 1);
}

#[test]
fn s09_production_schema_stays_v9_and_rejects_snapshot_work() {
    let s = CaptureStore::open_in_memory().unwrap();
    let version: i64 = s
        .connection
        .lock()
        .unwrap()
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 9);
    let k = JournalKernel::activate(&s);
    assert!(matches!(k, Err(J::WrongSchema)));
    let id = lock_id();
    let direct: Result<(), super::snapshot::SnapshotError> = (|| {
        let mut c = s.connection.lock().unwrap();
        let tx = c.transaction().unwrap();
        let out = snapshot::allocate(&tx, &id, "2026-10-22T00:00:00Z");
        let _ = tx.rollback();
        out
    })();
    assert!(matches!(
        direct,
        Err(super::snapshot::SnapshotError::WrongSchema)
    ));
}

fn staged_fixture(s: &CaptureStore, k: &JournalKernel<'_>) -> (String, Vec<super::snapshot::Staged>) {
    populate(s, k);
    let id = lock_id();
    k.write(|w| w.snapshot_allocate(&id, "2026-10-22T00:00:00Z")).unwrap();
    k.write(|w| w.snapshot_capture(&id, "2026-10-22T00:00:01Z")).unwrap();
    let rows = {
        let c = s.connection.lock().unwrap();
        super::snapshot::read_staged_rows(&c, &id).unwrap()
    };
    assert!(!rows.is_empty());
    (id, rows)
}

fn envelope_of(rows: &[super::snapshot::Staged]) -> Vec<[u8; 32]> {
    super::snapshot::verify_rows(rows).unwrap().into_iter().map(|r| r.envelope).collect()
}

#[test]
fn s10_changed_entity_kind_invalidates_envelope_and_manifest() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    let (_id, rows) = staged_fixture(&s, &k);
    let good = envelope_of(&rows);
    let mut tampered = rows.clone();
    let target = tampered.iter().position(|r| r.entity_kind == "projects").expect("projects row");
    tampered[target].entity_kind = "captures".into();
    let tampered_verified = super::snapshot::verify_rows(&tampered).unwrap();
    let bad: Vec<[u8; 32]> = tampered_verified.into_iter().map(|r| r.envelope).collect();
    assert_ne!(good, bad, "envelope must bind entity type");
    let mut swapped = rows.clone();
    let other = swapped.iter().position(|r| r.entity_kind == "@bundle" && r.entity_key == "[\"00000000-0000-4000-8000-000000000001\"]").unwrap_or_else(|| swapped.iter().position(|r| r.entity_kind == "@origin").expect("origin row"));
    swapped.swap(0, other);
    assert!(super::snapshot::verify_rows(&swapped).is_err(), "reordered ordinals must fail");
}

#[test]
fn s11_changed_logical_key_invalidates_envelope() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    let (_id, rows) = staged_fixture(&s, &k);
    let good = envelope_of(&rows);
    let mut tampered = rows.clone();
    let target = tampered.iter().position(|r| r.entity_kind == "projects").expect("projects row");
    let key: Vec<String> = serde_json::from_str(&tampered[target].entity_key).unwrap();
    assert_eq!(key.len(), 1);
    tampered[target].entity_key = serde_json::to_string(&vec!["ffffffff-ffff-4fff-8fff-ffffffffffff".to_string()]).unwrap();
    let bad: Vec<[u8; 32]> = super::snapshot::verify_rows(&tampered).unwrap().into_iter().map(|r| r.envelope).collect();
    assert_ne!(good, bad, "envelope must bind logical key");
    tampered[target].entity_key = "not-json".into();
    assert!(super::snapshot::verify_rows(&tampered).is_err(), "malformed key must fail");
}

#[test]
fn s12_reordered_rows_fail_ordinal_binding() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    let (_id, rows) = staged_fixture(&s, &k);
    assert!(rows.len() > 2);
    let mut swapped = rows.clone();
    swapped.swap(0, 1);
    assert!(super::snapshot::verify_rows(&swapped).is_err(), "swapped ordinals must fail");
    let mut renumbered = rows.clone();
    let first = renumbered[0].clone();
    renumbered[0] = renumbered[1].clone();
    renumbered[1] = first;
    renumbered[0].ordinal = 0;
    renumbered[1].ordinal = 1;
    assert!(super::snapshot::verify_rows(&renumbered).is_ok(), "renumbered fixture stays internally consistent");
    let good = envelope_of(&rows);
    let moved: Vec<[u8; 32]> = super::snapshot::verify_rows(&renumbered).unwrap().into_iter().map(|r| r.envelope).collect();
    assert_ne!(good, moved, "relocated rows change envelope order");
}

fn bundle_event_id(s: &CaptureStore) -> String {
    s.connection.lock().unwrap().query_row("SELECT event_id FROM sync_bundles ORDER BY rowid LIMIT 1", [], |r| r.get(0)).unwrap()
}

fn verified_fixture(s: &CaptureStore, k: &JournalKernel<'_>) -> (String, Vec<super::snapshot::VerifiedRow>) {
    populate(s, k);
    let id = lock_id();
    k.write(|w| w.snapshot_allocate(&id, "2026-10-22T00:00:00Z")).unwrap();
    k.write(|w| w.snapshot_capture(&id, "2026-10-22T00:00:01Z")).unwrap();
    let rows = {
        let c = s.connection.lock().unwrap();
        let staged = super::snapshot::read_staged_rows(&c, &id).unwrap();
        super::snapshot::verify_rows(&staged).unwrap()
    };
    (id, rows)
}

#[test]
fn s13_missing_fragment_is_rejected_despite_valid_hex() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    let (id, rows) = verified_fixture(&s, &k);
    let event: String = bundle_event_id(&s);
    let full_len = rows.len();
    let frag0 = serde_json::to_string(&vec![event.clone(), "0".to_string()]).unwrap();
    let reduced: Vec<super::snapshot::VerifiedRow> = rows.into_iter().filter(|r| !(r.entity_kind == "@bundle" && r.entity_key == frag0)).collect();
    assert_eq!(reduced.len() + 1, full_len);
    assert!(super::snapshot::reconstruct_bundle(&reduced, &event).is_err(), "missing fragment must fail");
    let _ = id;
}

#[test]
fn s14_duplicate_or_reordered_fragments_are_rejected() {
    use sha2::Digest;
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    let (_id, rows) = verified_fixture(&s, &k);
    let event: String = bundle_event_id(&s);
    let mut duplicated = rows.clone();
    let first_fragment = rows.iter().find(|r| r.entity_kind == "@bundle" && r.entity_key == bundle_key(&event, Some(0))).expect("fragment 0").clone();
    duplicated.push(first_fragment);
    assert!(super::snapshot::reconstruct_bundle(&duplicated, &event).is_err(), "duplicated fragment must fail");
    let header_row = rows.iter().find(|r| r.entity_kind == "@bundle" && r.entity_key == format!("[\"{}\"]", event)).expect("bundle header").clone();
    let frag_row = rows.iter().find(|r| r.entity_kind == "@bundle" && r.entity_key == bundle_key(&event, Some(0))).expect("fragment row");
    let header_fields: BTreeMap<String, serde_json::Value> = serde_json::from_slice(&header_row.row_bytes).unwrap();
    let fields: BTreeMap<String, serde_json::Value> = serde_json::from_slice(&frag_row.row_bytes).unwrap();
    let hex = fields.get("fragmentHex").and_then(|v| v.as_str()).unwrap().to_owned();
    assert!(!hex.is_empty());
    let (left, right) = hex.split_at(hex.len() / 2 - (hex.len() / 2 % 2));
    let mut make_fragment = |index: usize, part: &str| -> super::snapshot::Staged {
        let mut entry = BTreeMap::new();
        entry.insert("fragmentIndex".to_string(), serde_json::Value::from(index as i64));
        entry.insert("fragmentCount".to_string(), serde_json::Value::from(2i64));
        entry.insert("fragmentHex".to_string(), serde_json::Value::String(part.to_string()));
        entry.insert("wholeHash".to_string(), header_fields.get("wholeHash").cloned().unwrap());
        let row_bytes = serde_jcs::to_vec(&entry).unwrap();
        let row_hash = sha2::Sha256::digest(&row_bytes);
        let mut row_hash_fixed = [0u8; 32];
        row_hash_fixed.copy_from_slice(&row_hash);
        let key = serde_json::to_string(&vec![event.clone(), index.to_string()]).unwrap();
        super::snapshot::Staged { ordinal: 0, entity_kind: "@bundle".into(), entity_key: key, row_bytes, row_hash: row_hash_fixed }
    };
    let f0 = make_fragment(0, left);
    let f1 = make_fragment(1, right);
    let mut split_header_fields: BTreeMap<String, serde_json::Value> = serde_json::from_slice(&header_row.row_bytes).unwrap();
    split_header_fields.insert("fragmentCount".to_string(), serde_json::Value::from(2i64));
    let header_bytes = serde_jcs::to_vec(&split_header_fields).unwrap();
    let header_hash = sha2::Sha256::digest(&header_bytes);
    let mut header_hash_fixed = [0u8; 32];
    header_hash_fixed.copy_from_slice(&header_hash);
    let header_key = serde_json::to_string(&vec![event.clone()]).unwrap();
    let header_staged = super::snapshot::Staged { ordinal: 0, entity_kind: "@bundle".into(), entity_key: header_key, row_bytes: header_bytes, row_hash: header_hash_fixed };
    let mut split_rows = vec![header_staged, f0, f1];
    for (i, row) in split_rows.iter_mut().enumerate() { row.ordinal = i as i64; }
    let split_verified = super::snapshot::verify_rows(&split_rows).expect("split fixture verifies");
    assert!(super::snapshot::reconstruct_bundle(&split_verified, &event).is_ok(), "honest split must reassemble");
    let mut swapped = split_verified.clone();
    let tmp = swapped[1].row_bytes.clone();
    swapped[1].row_bytes = swapped[2].row_bytes.clone();
    swapped[2].row_bytes = tmp;
    assert!(super::snapshot::reconstruct_bundle(&swapped, &event).is_err(), "swapped fragment bytes must fail");
}

#[test]
fn s15_altered_fragment_content_fails_whole_core_verification() {
    use sha2::Digest;
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    let (_id, rows) = verified_fixture(&s, &k);
    let event: String = bundle_event_id(&s);
    let mut tampered: Vec<super::snapshot::Staged> = rows.iter().map(|r| super::snapshot::Staged { ordinal: r.ordinal, entity_kind: r.entity_kind.clone(), entity_key: r.entity_key.clone(), row_bytes: r.row_bytes.clone(), row_hash: {
        let mut h = sha2::Sha256::new();
        h.update(&r.row_bytes);
        let mut out = [0u8; 32];
        out.copy_from_slice(&h.finalize());
        out
    } }).collect();
    let target = tampered.iter().position(|r| r.entity_kind == "@bundle" && r.entity_key == bundle_key(&event, Some(0))).expect("fragment 0");
    let mut fields: BTreeMap<String, serde_json::Value> = serde_json::from_slice(&tampered[target].row_bytes).unwrap();
    let hex = fields["fragmentHex"].as_str().unwrap().to_owned();
    assert!(!hex.is_empty());
    let mut altered = hex.into_bytes();
    altered[0] = if altered[0] == b'0' { b'1' } else { b'0' };
    fields.insert("fragmentHex".into(), serde_json::Value::String(String::from_utf8(altered).unwrap()));
    tampered[target].row_bytes = serde_jcs::to_vec(&fields).unwrap();
    let mut hasher = sha2::Sha256::new();
    hasher.update(&tampered[target].row_bytes);
    tampered[target].row_hash.copy_from_slice(&hasher.finalize());
    let reverified = super::snapshot::verify_rows(&tampered).expect("tampered row stays internally consistent");
    assert!(super::snapshot::reconstruct_bundle(&reverified, &event).is_err(), "altered fragment must fail whole-core check");
}

#[test]
fn s16_snapshot_manifest_is_deterministic_across_later_writes() {
    let s = upgraded();
    let k = JournalKernel::activate(&s).unwrap();
    populate(&s, &k);
    let id = lock_id();
    k.write(|w| w.snapshot_allocate(&id, "2026-10-22T00:00:00Z")).unwrap();
    k.write(|w| w.snapshot_capture(&id, "2026-10-22T00:00:01Z")).unwrap();
    k.write(|w| w.snapshot_pack(&id)).unwrap();
    k.write(|w| w.snapshot_verify(&id)).unwrap();
    let manifest_before: Vec<u8> = s.connection.lock().unwrap().query_row("SELECT manifest_bytes FROM sync_snapshots WHERE snapshot_id=?1", [&id], |r| r.get(0)).unwrap();
    let boundary_before: Vec<u8> = s.connection.lock().unwrap().query_row("SELECT boundary_bytes FROM sync_snapshots WHERE snapshot_id=?1", [&id], |r| r.get(0)).unwrap();
    k.write(|w| w.create_capture(crate::storage::capture_store::CreateCaptureInput { source: "text".into(), content: "Later".into(), project_id: None })).unwrap();
    k.write(|w| w.snapshot_verify(&id)).unwrap();
    let manifest_after: Vec<u8> = s.connection.lock().unwrap().query_row("SELECT manifest_bytes FROM sync_snapshots WHERE snapshot_id=?1", [&id], |r| r.get(0)).unwrap();
    let boundary_after: Vec<u8> = s.connection.lock().unwrap().query_row("SELECT boundary_bytes FROM sync_snapshots WHERE snapshot_id=?1", [&id], |r| r.get(0)).unwrap();
    assert_eq!(manifest_before, manifest_after);
    assert_eq!(boundary_before, boundary_after);
}
