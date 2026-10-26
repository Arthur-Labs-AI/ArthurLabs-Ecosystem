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
// D2 fixtures always create originals through native authoritative adapters.
pub(crate) fn install_g3(s: &CaptureStore) {
    super::g3::install(s).unwrap()
}
pub(crate) fn project_and_capture(s: &CaptureStore, name: &str, body: &str) -> (String, String) {
    let k = JournalKernel::activate(s).unwrap();
    let p = k.write(|w| w.create_project(name)).unwrap();
    let capture = k
        .write(|w| {
            w.create_capture(CreateCaptureInput {
                source: "text".into(),
                content: body.into(),
                project_id: Some(p.id.clone()),
            })
        })
        .unwrap();
    (p.id, capture.id)
}
pub(crate) fn capture_in(s: &CaptureStore, project: &str, body: &str) {
    let k = JournalKernel::activate(s).unwrap();
    k.write(|w| {
        w.create_capture(CreateCaptureInput {
            source: "text".into(),
            content: body.into(),
            project_id: Some(project.into()),
        })
    })
    .unwrap();
}
pub(crate) fn assert_insert_observers_frozen(s: &CaptureStore) {
    let c = s.connection.lock().unwrap();
    for table in super::sql_effects::ENTITIES.iter().map(|e| e.as_str()) {
        let name = format!("sync_observe_{table}_insert");
        let sql: String = c
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name=?1",
                [&name],
                |r| r.get(0),
            )
            .unwrap();
        assert!(include_str!("../m05_v10.sql").contains(&sql));
    }
}
pub(crate) fn held_kernel_continues(s: &CaptureStore, project: &str, import: impl FnOnce()) {
    let k = JournalKernel::activate(s).unwrap();
    import();
    k.write(|w| {
        w.create_capture(CreateCaptureInput {
            source: "text".into(),
            content: "held local kernel".into(),
            project_id: Some(project.into()),
        })
    })
    .unwrap();
}
pub(crate) fn domain_state(s: &CaptureStore) -> Vec<(String, Vec<Vec<rusqlite::types::Value>>)> {
    state(s)
        .into_iter()
        .filter(|(name, _)| {
            !name.starts_with("import_")
                && !name.starts_with("sync_")
                && !name.starts_with("bootstrap_")
        })
        .collect()
}

pub(crate) fn install_history(s: &CaptureStore) {
    super::g3::install_history(s).unwrap();
    crate::storage::bootstrap_store::install(s).unwrap();
}
pub(crate) async fn with_import_fault(
    s: &CaptureStore,
    sync_io: bool,
    work: impl std::future::Future<Output = ()>,
) {
    let fault = if sync_io { super::fault_io::Fault::SyncIo } else { super::fault_io::Fault::WriteFull };
    // Store remains borrowed until the future and callback guard are dropped.
    let guard = unsafe { super::fault_io::FileFault::install(s, fault) };
    work.await;
    assert_eq!(guard.hits(), 1);
}
pub(crate) fn install_d4(s:&CaptureStore) { super::g3::install_d4(s).unwrap(); }
pub(crate) fn assert_same_row(a:&CaptureStore,b:&CaptureStore,e:super::codec::EntityKind,key:&[String]) {
    let source=a.connection.lock().unwrap(); let target=b.connection.lock().unwrap();
    assert_eq!(super::sql_effects::reread(&source,e,key).unwrap(),super::sql_effects::reread(&target,e,key).unwrap());
}
pub(crate) fn last_original(s:&CaptureStore)->crate::sync::Envelope {
    let c=s.connection.lock().unwrap();
    let bytes=c.query_row("SELECT canonical_bytes FROM sync_bundles ORDER BY rowid DESC LIMIT 1",[],|r|r.get::<_,Vec<u8>>(0)).unwrap();
    crate::sync::bootstrap::envelope(bytes).unwrap()
}
pub(crate) fn held_project_kernel_continues(s:&CaptureStore,id:&str,import:impl FnOnce()) {
    let k=JournalKernel::activate(s).unwrap();
    import();
    k.write(|w|w.rename_project(id,"Local after foreign transition")).unwrap();
}
pub(crate) fn history(s: &CaptureStore) -> (String, String, String) {
    history_inner(s, false)
}
pub(crate) fn history_with_selected_edit(s: &CaptureStore) -> (String, String, String) {
    history_inner(s, true)
}
fn history_inner(s: &CaptureStore, select_edit: bool) -> (String, String, String) {
    use crate::storage::{knowledge_store::NewKnowledgeObject, lineage_store::Changes};
    let k = JournalKernel::activate(s).unwrap();
    let c = k
        .write(|w| {
            w.create_capture(CreateCaptureInput {
                source: "text".into(),
                content: "Alpha Бета 😀 original".into(),
                project_id: None,
            })
        })
        .unwrap();
    let object = k
        .write(|w| {
            w.record_distillation(
                &c.id,
                vec![NewKnowledgeObject {
                    kind: "idea".into(),
                    title: "Original object".into(),
                    body: "Original body".into(),
                    source_start: 0,
                    source_end: 5,
                }],
            )
        })
        .unwrap()
        .remove(0);
    let root = s.current_revision_id_of(&object.id).unwrap().unwrap();
    k.write(|w| {
        w.create_revision_from(
            &object.id,
            &root,
            Changes {
                kind: None,
                title: None,
                body: Some("Unselected immutable branch".into()),
            },
            false,
        )
    })
    .unwrap();
    let empty = k
        .write(|w| {
            w.create_capture(CreateCaptureInput {
                source: "text".into(),
                content: "Empty completion".into(),
                project_id: None,
            })
        })
        .unwrap();
    k.write(|w| w.record_distillation(&empty.id, vec![]))
        .unwrap();
    if select_edit {
        k.write(|w| w.update_object(&object.id, super::writer_tests::change("Selected native history"))).unwrap();
    }
    (c.id, object.id, root)
}
// An unselected automatic branch generated inside the actual local journal
// kernel. v9 guards, observers and native closure validation all execute.
pub(crate) fn evidenced_branch(
    s: &CaptureStore,
    capture: &str,
    object: &str,
    parent: &str,
) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let k = JournalKernel::activate(s).unwrap();
    k.run(|tx|{
        tx.sql().execute("INSERT INTO thought_revisions(id,object_id,kind,title,body,origin,created_at,capture_id,source_start,source_end) VALUES(?1,?2,'idea','Evidence branch','Automatic unselected history','system','2026-10-23T00:00:00Z',NULL,NULL,NULL)",rusqlite::params![id,object])?;
        tx.sql().execute("INSERT INTO revision_parents VALUES(?1,?2)",rusqlite::params![id,parent])?;
        tx.sql().execute("INSERT INTO revision_evidence(revision_id,ordinal,object_id,capture_id,source_start,source_end,role,created_at) VALUES(?1,0,?2,?3,0,5,'asserts','2026-10-23T00:00:00Z')",rusqlite::params![id,object,capture])?;Ok(())
    }).unwrap();
    id
}

pub(crate) fn held_object_kernel_continues(s: &CaptureStore, object: &str, import: impl FnOnce()) {
    let k = JournalKernel::activate(s).unwrap();
    import();
    k.write(|w| {
        w.update_object(
            object,
            super::writer_tests::change("Local edit after foreign bootstrap"),
        )
    })
    .unwrap();
}
pub(crate) fn relation(s: &CaptureStore, source: &str, target: &str) -> String {
    relation_owned(s, source, target, "user")
}
pub(crate) fn relation_owned(s: &CaptureStore, source: &str, target: &str, origin: &str) -> String {
    let k = JournalKernel::activate(s).unwrap();
    k.write(|w| {
        w.create_relation(
            crate::storage::relation_store::NewRelation {
                kind: "extends".into(),
                source_object_id: source.into(),
                target_object_id: target.into(),
            },
            origin,
        )
    })
    .unwrap()
    .id
}
pub(crate) fn remove_model(s:&CaptureStore,id:&str) {
    use crate::storage::integration_store::{ObjectSnapshot,IntegrationWrite};
    let edge=s.list_relations().unwrap().into_iter().find(|r|r.id==id).unwrap();
    let snapshot=|id:&str|{
        let object=s.get_knowledge_object(id).unwrap().unwrap();
        ObjectSnapshot{object_id:id.into(),revision_id:s.current_revision_id_of(id).unwrap().unwrap(),project_id:object.project_id}
    };
    let write=IntegrationWrite{focus:snapshot(&edge.source_object_id),context:vec![snapshot(&edge.target_object_id)],remove:vec![id.into()],add:vec![]};
    assert_eq!(JournalKernel::activate(s).unwrap().write(|w|w.apply_integration(write)).unwrap().removed,1);
}
pub(crate) fn rename_id(s:&CaptureStore,id:&str,name:&str) {
    JournalKernel::activate(s).unwrap().write(|w|w.rename_project(id,name)).unwrap();
}
pub(crate) fn project_only(s:&CaptureStore,name:&str)->String {
    JournalKernel::activate(s).unwrap().write(|w|w.create_project(name)).unwrap().id
}
pub(crate) fn archive_id(s:&CaptureStore,id:&str,restore:bool) {
    JournalKernel::activate(s).unwrap().write(|w|if restore {w.restore_project(id)} else {w.archive_project(id)}).unwrap();
}
pub(crate) fn move_capture_id(s:&CaptureStore,id:&str,project:&str) {
    JournalKernel::activate(s).unwrap().write(|w|w.move_capture(id,project)).unwrap();
}
pub(crate) fn edit_id(s:&CaptureStore,id:&str,title:&str) {
    JournalKernel::activate(s).unwrap().write(|w|w.update_object(id,super::writer_tests::change(title))).unwrap();
}
pub(crate) fn open_proposal(s:&CaptureStore)->(String,String,String,String) {
    open_proposal_with_evidence(s,None)
}
pub(crate) fn open_proposal_with_evidence(s:&CaptureStore,existing:Option<(i64,i64)>)->(String,String,String,String) {
    use super::writer_tests::{candidate,decision_for,pending_for,proposal_for};
    let k=JournalKernel::activate(s).unwrap();
    let cap=k.write(|w|w.create_capture(CreateCaptureInput{source:"text".into(),content:"Alpha Beta Gamma".into(),project_id:None})).unwrap();
    let object=k.write(|w|w.record_distillation(&cap.id,vec![candidate("Target",0,4)])).unwrap().remove(0);
    let base=s.current_revision_id_of(&object.id).unwrap().unwrap();
    let claim=k.write(|w|w.stage_uncertain_claim(pending_for(decision_for(&cap.id,0,vec![object.id.clone()]),vec![object.id.clone()]))).unwrap().0;
    let mut input=proposal_for(&claim.id,&object.id,&base,"Original draft",&cap.id);
    if let Some((start,end))=existing {input.evidence.push(crate::storage::proposal_store::EvidenceRef{role:"existing".into(),capture_id:cap.id.clone(),start,end});}
    let proposal=k.write(|w|w.insert_proposal(input)).unwrap().0;
    (object.id,base,claim.id,proposal.id)
}

// Actual SQLite authorization failure while restoring the frozen revision
// observer. The callback is test-only and removed even if the test unwinds.
pub(crate) fn deny_revision_observer_restore(s: &CaptureStore, work: impl FnOnce()) -> usize {
    use rusqlite::ffi;
    use std::{
        cell::Cell,
        ffi::{c_char, c_int, c_void, CStr},
    };
    unsafe extern "C" fn deny(
        p: *mut c_void,
        action: c_int,
        name: *const c_char,
        _: *const c_char,
        _: *const c_char,
        _: *const c_char,
    ) -> c_int {
        if action == ffi::SQLITE_CREATE_TRIGGER
            && !name.is_null()
            && CStr::from_ptr(name).to_bytes() == b"sync_observe_thought_revisions_insert"
        {
            let n = &*p.cast::<Cell<usize>>();
            n.set(n.get() + 1);
            if n.get() == 2 {
                return ffi::SQLITE_DENY;
            }
        }
        ffi::SQLITE_OK
    }
    let count = Box::new(Cell::new(0usize));
    {
        let c = s.connection.lock().unwrap();
        assert_eq!(
            unsafe {
                ffi::sqlite3_set_authorizer(
                    c.handle(),
                    Some(deny),
                    (&*count as *const Cell<usize>).cast_mut().cast(),
                )
            },
            ffi::SQLITE_OK
        );
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(work));
    {
        let c = s.connection.lock().unwrap();
        assert_eq!(
            unsafe { ffi::sqlite3_set_authorizer(c.handle(), None, std::ptr::null_mut()) },
            ffi::SQLITE_OK
        );
    }
    if let Err(p) = result {
        std::panic::resume_unwind(p)
    }
    count.get()
}
