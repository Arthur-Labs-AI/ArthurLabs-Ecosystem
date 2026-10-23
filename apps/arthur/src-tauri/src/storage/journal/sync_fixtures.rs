//! Synthetic native fixtures only; no production constructor or observer waiver.
use super::{storage::JournalKernel, storage_tests};
use crate::storage::capture_store::{CaptureStore, CreateCaptureInput};
pub(crate) const PROJECT: &str = "aaaaaaaa-1111-4111-8111-111111111111";
pub(crate) fn upgrade(s: &CaptureStore) {
    storage_tests::upgrade(s)
}
pub(crate) fn seed_legacy(s: &CaptureStore) {
    s.execute_sql_for_test("INSERT INTO projects(id,name,created_at,updated_at,archived_at) VALUES('aaaaaaaa-1111-4111-8111-111111111111','Shared historical project','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z',NULL)");
}
pub(crate) fn captures(s: &CaptureStore, texts: &[&str]) {
    let k = JournalKernel::activate(s).unwrap();
    for text in texts {
        k.write(|w| {
            w.create_capture(CreateCaptureInput {
                source: "text".into(),
                content: (*text).into(),
                project_id: None,
            })
        })
        .unwrap();
    }
}
pub(crate) fn rename(s: &CaptureStore, name: &str) {
    let k = JournalKernel::activate(s).unwrap();
    k.write(|w| w.rename_project(PROJECT, name)).unwrap();
}
pub(crate) fn archive(s: &CaptureStore) {
    let k = JournalKernel::activate(s).unwrap();
    k.write(|w| w.archive_project(PROJECT)).unwrap();
}
pub(crate) fn state(s: &CaptureStore) -> Vec<(String, Vec<Vec<rusqlite::types::Value>>)> {
    storage_tests::state(s)
}
pub(crate) fn clean(s: &CaptureStore) {
    storage_tests::clean(s)
}
pub(crate) fn snapshot(s: &CaptureStore, id: &str) {
    let k = JournalKernel::activate(s).unwrap();
    k.write(|w| w.snapshot_allocate(id, "2026-10-23T10:00:00Z"))
        .unwrap();
    k.write(|w| w.snapshot_capture(id, "2026-10-23T10:00:00Z"))
        .unwrap();
    k.write(|w| w.snapshot_pack(id)).unwrap();
    k.write(|w| w.snapshot_verify(id)).unwrap();
}
pub(crate) fn verify_snapshot(s: &CaptureStore, id: &str) -> bool {
    let mut c = s.connection.lock().unwrap();
    let tx = c.transaction().unwrap();
    let result = super::snapshot::verify_manifest(&tx, id).is_ok();
    tx.rollback().unwrap();
    result
}
pub(crate) fn project_capture(s: &CaptureStore) {
    let k = JournalKernel::activate(s).unwrap();
    k.write(|w| {
        w.create_capture(CreateCaptureInput {
            source: "text".into(),
            content: "Historical project child".into(),
            project_id: Some(PROJECT.into()),
        })
    })
    .unwrap();
}
pub(crate) fn large(s: &CaptureStore) {
    let k = JournalKernel::activate(s).unwrap();
    let content = "X".repeat(20000);
    k.write(|w| {
        for _ in 0..60 {
            w.create_capture(CreateCaptureInput {
                source: "text".into(),
                content: content.clone(),
                project_id: None,
            })?;
        }
        Ok(())
    })
    .unwrap();
}
pub(crate) fn guard_refuses_capture(s: &CaptureStore, event: &crate::sync::Envelope) -> bool {
    let v = crate::sync::ValidatedEvent::parse(event.clone()).unwrap();
    let super::codec::Operation::RecordCreate(row) = &v.core().operations[0] else {
        panic!("capture fixture")
    };
    let text = |k| match row.after.get(k).unwrap() {
        super::codec::FieldValue::Text(s) => s.as_str(),
        _ => panic!("capture field"),
    };
    let mut c = s.connection.lock().unwrap();
    let tx = c.transaction().unwrap();
    let rejected = tx
        .execute(
            "INSERT INTO captures(id,source,content,created_at,project_id) VALUES(?1,?2,?3,?4,?5)",
            rusqlite::params![
                text("id"),
                text("source"),
                text("content"),
                text("created_at"),
                text("project_id")
            ],
        )
        .is_err();
    tx.rollback().unwrap();
    rejected
}
pub(crate) fn snapshot_tamper_rejected(s: &CaptureStore, id: &str) -> bool {
    let mut c = s.connection.lock().unwrap();
    let tx = c.transaction().unwrap();
    let mut loaded = super::snapshot::load_staged(&tx, id).unwrap();
    let (bytes, hash): (Vec<u8>, Vec<u8>) = tx
        .query_row(
            "SELECT manifest_bytes,manifest_hash FROM sync_snapshots WHERE snapshot_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    loaded.rows[0].row_bytes.push(b' ');
    super::snapshot::verify_loaded_manifest(id, &loaded, &bytes, &hash).is_err()
}
pub(crate) fn review_history(s: &CaptureStore) {
    use super::writer_tests::{candidate, decision_for, pending_for, proposal_for};
    let k = JournalKernel::activate(s).unwrap();
    let cap = k
        .write(|w| {
            w.create_capture(CreateCaptureInput {
                source: "text".into(),
                content: "Alpha Beta Gamma".into(),
                project_id: None,
            })
        })
        .unwrap();
    let o = k
        .write(|w| w.record_distillation(&cap.id, vec![candidate("Target", 0, 4)]))
        .unwrap();
    let root = s.current_revision_id_of(&o[0].id).unwrap().unwrap();
    let claim = k
        .write(|w| {
            w.stage_uncertain_claim(pending_for(
                decision_for(&cap.id, 0, vec![o[0].id.clone()]),
                vec![o[0].id.clone()],
            ))
        })
        .unwrap()
        .0;
    let proposal = k
        .write(|w| {
            w.insert_proposal(proposal_for(
                &claim.id,
                &o[0].id,
                &root,
                "Approved historical body",
                &cap.id,
            ))
        })
        .unwrap()
        .0;
    k.write(|w| {
        w.review_proposal(crate::storage::proposal_store::ReviewRequest {
            proposal_id: proposal.id,
            action: crate::storage::proposal_store::ReviewAction::Approve,
            reviewed_revision_id: Some(root),
        })
    })
    .unwrap();
}
pub(crate) fn reopen(ownership: crate::storage::ownership::DataRootOwnership) -> CaptureStore {
    CaptureStore::reopen_candidate_owned_for_test(ownership).unwrap()
}
pub(crate) const OBJECT: &str = "cccccccc-1111-4111-8111-111111111111";
pub(crate) const ROOT: &str = "dddddddd-1111-4111-8111-111111111111";
pub(crate) const PROPOSAL: &str = "eeeeeeee-1111-4111-8111-111111111111";
pub(crate) fn seed_graph(s: &CaptureStore) {
    // Identical independently installed legacy fixture, never a copied DB or a
    // remote import. All original v9 guards/FKs are active during insertion.
    let mut c = s.connection.lock().unwrap();
    let tx = c.transaction().unwrap();
    let cap = "ffffffff-1111-4111-8111-111111111111";
    let claim = "99999999-1111-4111-8111-111111111111";
    let now = "2026-10-01T00:00:00Z";
    let candidates = serde_json::json!([OBJECT]).to_string();
    let audit = serde_json::json!({"candidatesSent":[OBJECT],"excluded":[],"scores":[],"runs":1})
        .to_string();
    let evidence =
        serde_json::json!([{"role":"claim","captureId":cap,"start":0,"end":4}]).to_string();
    tx.execute("INSERT INTO captures(id,source,content,created_at,project_id) VALUES(?1,'text','Alpha Beta Gamma',?2,?3)",rusqlite::params![cap,now,PROJECT]).unwrap();
    tx.execute(
        "INSERT INTO distillation_runs(capture_id,created_at) VALUES(?1,?2)",
        rusqlite::params![cap, now],
    )
    .unwrap();
    tx.execute("INSERT INTO knowledge_objects(id,kind,title,body,created_at,project_id) VALUES(?1,'idea','Root','Root body',?2,?3)",rusqlite::params![OBJECT,now,PROJECT]).unwrap();
    tx.execute(
        "INSERT INTO object_sources VALUES(?1,?2,0,4)",
        rusqlite::params![OBJECT, cap],
    )
    .unwrap();
    tx.execute("INSERT INTO thought_revisions(id,object_id,kind,title,body,origin,created_at,capture_id,source_start,source_end) VALUES(?1,?2,'idea','Root','Root body','initial',?3,?4,0,4)",rusqlite::params![ROOT,OBJECT,now,cap]).unwrap();
    tx.execute(
        "UPDATE knowledge_objects SET current_revision_id=?1 WHERE id=?2",
        rusqlite::params![ROOT, OBJECT],
    )
    .unwrap();
    tx.execute("INSERT INTO identity_decisions(capture_id,ordinal,outcome,policy_version,model_id,decided_by,vetoes_json,audit_json,decided_at) VALUES(?1,0,'uncertain','fixture','synthetic','gate','[]',?2,?3)",rusqlite::params![cap,audit,now]).unwrap();
    tx.execute("INSERT INTO pending_claims(id,capture_id,ordinal,kind,title,body,source_start,source_end,candidate_ids_json,reasons_json,reframing,state,created_at,updated_at) VALUES(?1,?2,0,'idea','Claim','Claim body',0,4,?3,'[]',0,'open',?4,?4)",rusqlite::params![claim,cap,candidates,now]).unwrap();
    tx.execute("INSERT INTO revision_proposals(id,pending_claim_id,object_id,base_revision_id,change,kind,title,proposed_body,evidence_json,synthesis_model,verifier_model,verification_mode,verification_status,policy_version,state,created_at,updated_at) VALUES(?1,?2,?3,?4,'additive','idea','Draft','Proposed body',?5,'synthetic','synthetic','independent','passed','fixture','open',?6,?6)",rusqlite::params![PROPOSAL,claim,OBJECT,ROOT,evidence,now]).unwrap();
    tx.commit().unwrap();
}
pub(crate) fn edit_shared(s: &CaptureStore, title: &str) {
    let k = JournalKernel::activate(s).unwrap();
    k.write(|w| w.update_object(OBJECT, super::writer_tests::change(title)))
        .unwrap();
}
pub(crate) fn review_shared(s: &CaptureStore, approve: bool) {
    let k = JournalKernel::activate(s).unwrap();
    k.write(|w| {
        w.review_proposal(crate::storage::proposal_store::ReviewRequest {
            proposal_id: PROPOSAL.into(),
            action: if approve {
                crate::storage::proposal_store::ReviewAction::Approve
            } else {
                crate::storage::proposal_store::ReviewAction::Reject
            },
            reviewed_revision_id: Some(ROOT.into()),
        })
    })
    .unwrap();
}
