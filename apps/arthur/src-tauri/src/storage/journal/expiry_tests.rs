use super::codec::{self, EntityKind as K, JournalEvent, Operation};
use super::expiry::{self, DormantExpiryRequest as Request};
use super::storage::{Fault, JournalError, JournalKernel, Stage};
use super::writers::{IdentityFailure, WriterError};
use super::{sql_effects as sql, stream};
use crate::storage::capture_store::{Capture, CaptureStore, CreateCaptureInput};
use crate::storage::identity_store::{
    self as identity, DecisionAudit, DecisionOutcome, IdentityDecisionInput, PendingClaim,
    PendingClaimInput,
};
use crate::storage::knowledge_store::{KnowledgeObject, NewKnowledgeObject};
use crate::storage::proposal_store::{EvidenceRef, NewProposal, ReviewAction, ReviewRequest};
use crate::storage::{migrations, proposal_store};
use rusqlite::types::Value;
use std::collections::BTreeMap;

const NOW: &str = "2026-10-23T12:00:00+03:00";
const PAST: &str = "2026-10-22T00:00:00Z";
const FUTURE: &str = "2026-10-23T09:00:01Z";

struct Fixture {
    s: CaptureStore,
    capture: Capture,
    target: KnowledgeObject,
    claims: Vec<PendingClaim>,
}

fn pending(capture: &str, target: &str, ordinal: i64) -> PendingClaimInput {
    PendingClaimInput {
        decision: IdentityDecisionInput {
            capture_id: capture.into(),
            ordinal,
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
                candidates_sent: vec![target.into()],
                runs: 1,
                ..Default::default()
            },
        },
        kind: "idea".into(),
        title: format!("Claim {ordinal}"),
        body: format!("Retained claim {ordinal}"),
        source_start: 0,
        source_end: 4,
        candidate_ids: vec![target.into()],
        due_at: Some(PAST.into()),
    }
}

fn fixture(n: usize) -> Fixture {
    let s = CaptureStore::open_in_memory().unwrap();
    let capture = s
        .create(CreateCaptureInput {
            source: "text".into(),
            content: "Идея 🦀 original capture".into(),
            project_id: None,
        })
        .unwrap();
    let target = s
        .record_distillation(
            &capture.id,
            vec![NewKnowledgeObject {
                kind: "idea".into(),
                title: "Target".into(),
                body: "Original target".into(),
                source_start: 0,
                source_end: 4,
            }],
        )
        .unwrap()
        .remove(0);
    let claims = (0..n)
        .map(|i| {
            s.stage_uncertain_claim(&pending(&capture.id, &target.id, i64::try_from(i).unwrap()))
                .unwrap()
                .0
        })
        .collect();
    Fixture {
        s,
        capture,
        target,
        claims,
    }
}

fn upgrade(s: &CaptureStore) {
    let mut steps = migrations::STEPS.to_vec();
    steps.push((10, include_str!("../m05_v10.sql")));
    migrations::migrate_with(&mut s.connection.lock().unwrap(), &steps).unwrap();
}

fn proposal(f: &Fixture, index: usize) -> NewProposal {
    NewProposal {
        pending_claim_id: f.claims[index].id.clone(),
        object_id: f.target.id.clone(),
        base_revision_id: f.s.current_revision_id_of(&f.target.id).unwrap().unwrap(),
        change: "additive".into(),
        kind: "idea".into(),
        title: "Draft".into(),
        proposed_body: "Preserved draft text".into(),
        retracts: None,
        evidence: vec![EvidenceRef {
            role: "claim".into(),
            capture_id: f.capture.id.clone(),
            start: 0,
            end: 4,
        }],
        synthesis_model: "synthetic".into(),
        verifier_model: "synthetic".into(),
        verification_mode: "same_family_review".into(),
        policy_version: "test".into(),
    }
}

fn run(k: &JournalKernel<'_>, limit: usize) -> Vec<identity::PendingResolution> {
    k.write(|w| w.execute_due_expiry(Request::candidate(NOW, limit)?))
        .unwrap()
}

fn count(s: &CaptureStore, table: &str) -> i64 {
    s.connection
        .lock()
        .unwrap()
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

/// Exact typed snapshots include every domain projection, origin tips, journal,
/// observer metadata, sqlite_sequence and derived indexes, not just row counts.
fn snapshot(s: &CaptureStore) -> Vec<(String, Vec<Vec<Value>>)> {
    let c = s.connection.lock().unwrap();
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
            let n = c
                .prepare(&format!("SELECT * FROM {name}"))
                .unwrap()
                .column_count();
            let order = (1..=n).map(|i| i.to_string()).collect::<Vec<_>>().join(",");
            let mut q = c
                .prepare(&format!("SELECT * FROM {name} ORDER BY {order}"))
                .unwrap();
            let rows = q
                .query_map([], |r| {
                    (0..n)
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

/// Decode actual stored cores, validate hashes/predecessors/dependencies, compare
/// complete final images and independently versioned facet heads with SQL.
fn cores(s: &CaptureStore) -> Vec<JournalEvent> {
    let c = s.connection.lock().unwrap();
    let mut q = c.prepare("SELECT canonical_bytes,canonical_hash,previous_hash,event_id,bundle_id,origin_seq,raw_effect_count FROM sync_bundles ORDER BY rowid").unwrap();
    let mut rows = q.query([]).unwrap();
    let mut cores = Vec::new();
    let mut previous = [0u8; 32];
    let mut known = BTreeMap::new();
    let mut heads: BTreeMap<_, stream::Head> = BTreeMap::new();
    let mut final_rows = BTreeMap::new();
    while let Some(row) = rows.next().unwrap() {
        let bytes: Vec<u8> = row.get(0).unwrap();
        let core = codec::decode_core_strict(&bytes).unwrap();
        let hash = codec::journal_event_hash(&bytes);
        assert_eq!(codec::encode_canonical(&core).unwrap(), bytes);
        assert_eq!(row.get::<_, Vec<u8>>(1).unwrap(), hash);
        assert_eq!(row.get::<_, Vec<u8>>(2).unwrap(), previous);
        assert_eq!(core.previous_event_hash, codec::hash_hex(&previous));
        assert_eq!(core.event_id, row.get::<_, String>(3).unwrap());
        assert_eq!(core.bundle_id, row.get::<_, String>(4).unwrap());
        assert_eq!(core.origin_seq, (cores.len() + 1).to_string());
        assert_eq!(core.origin_seq, row.get::<_, i64>(5).unwrap().to_string());
        assert_eq!(
            core.raw_effect_count,
            row.get::<_, i64>(6).unwrap().to_string()
        );
        for dep in &core.dependencies {
            assert!(sql::reread(&c, dep.entity, &dep.key).unwrap().is_some());
            assert_eq!(
                dep.event_ref.as_ref(),
                known.get(&(dep.entity, dep.key.clone()))
            );
        }
        let reference = codec::EventRef {
            origin_id: core.origin_id.clone(),
            incarnation: core.origin_incarnation.clone(),
            seq: core.origin_seq.clone(),
            event_id: core.event_id.clone(),
            hash: codec::hash_hex(&hash),
        };
        for op in &core.operations {
            let key = (op.entity(), op.key().to_vec());
            let after = match op {
                Operation::RecordCreate(r) => {
                    assert!(known.insert(key.clone(), reference.clone()).is_none());
                    &r.after
                }
                Operation::FacetUpdate(u) => {
                    codec::validate_facet_update_shape(u).unwrap();
                    for (facet, expected) in &u.expected {
                        assert_eq!(
                            expected.before_hash,
                            codec::hash_hex(
                                &stream::facet_hash(u.entity, &u.key, facet, &u.before).unwrap()
                            )
                        );
                        assert_eq!(
                            expected.event_ref.as_ref(),
                            heads
                                .get(&(u.entity, u.key.clone(), facet.clone()))
                                .map(|h| &h.event)
                        );
                    }
                    &u.after
                }
                Operation::RelationRemove(_) => panic!("expiry never removes relations"),
            };
            final_rows.insert(key, after.clone());
        }
        heads.extend(stream::updates(&core.operations, &reference).unwrap());
        previous = hash;
        cores.push(core);
    }
    for ((entity, key), image) in final_rows {
        assert_eq!(sql::reread(&c, entity, &key).unwrap().unwrap(), image);
    }
    for (key, head) in &heads {
        assert_eq!(
            stream::stored_head(&c, key).unwrap(),
            Some((head.event.event_id.clone(), head.hash.to_vec()))
        );
    }
    assert_eq!(
        c.query_row(
            "SELECT last_seq,last_hash FROM sync_origins WHERE status='active'",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
        )
        .unwrap(),
        (i64::try_from(cores.len()).unwrap(), previous.to_vec())
    );
    for table in ["sync_effects", "sync_write_context"] {
        assert_eq!(
            c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    assert!(!c
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
    assert_eq!(
        c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    cores
}

fn assert_resolution(f: &Fixture, out: &identity::PendingResolution) {
    let claim = f.s.get_pending_claim(&out.claim.id).unwrap().unwrap();
    assert!(out.applied);
    assert_eq!(claim.state, "separated");
    assert_eq!(claim.resolved_method.as_deref(), Some("expiry"));
    assert_eq!(
        claim.resolved_object_id.as_deref(),
        Some(out.object_id.as_str())
    );
    assert_eq!(claim.resolved_revision_id, None);
    let object = f.s.get_knowledge_object(&out.object_id).unwrap().unwrap();
    assert_eq!(
        (
            &object.kind,
            &object.title,
            &object.body,
            &object.project_id
        ),
        (&claim.kind, &claim.title, &claim.body, &claim.project_id)
    );
    assert_eq!(
        (
            &object.provenance.capture_id,
            object.provenance.source_start,
            object.provenance.source_end
        ),
        (&claim.capture_id, claim.source_start, claim.source_end)
    );
    let lineage = f.s.object_lineage(&out.object_id).unwrap();
    assert_eq!(lineage.revisions.len(), 1);
    let revision = &lineage.revisions[0];
    assert_eq!(lineage.current_revision_id, revision.id);
    assert_eq!(revision.origin, "initial");
    assert!(revision.parent_revision_ids.is_empty());
    assert_eq!(revision.provenance.as_ref(), Some(&object.provenance));
    assert_eq!(
        f.s.get_capture(&f.capture.id).unwrap().unwrap().content,
        f.capture.content
    );
    assert_eq!(
        f.s.get_knowledge_object(&f.target.id).unwrap().unwrap(),
        f.target
    );
}

#[test]
fn x01_due_selector_matches_public_reporting() {
    let f = fixture(4);
    f.s.connection
        .lock()
        .unwrap()
        .execute(
            "UPDATE pending_claims SET due_at=NULL WHERE id=?1",
            [&f.claims[3].id],
        )
        .unwrap();
    f.s.defer_pending_claim(&f.claims[1].id, None).unwrap();
    f.s.defer_pending_claim(&f.claims[2].id, Some(FUTURE))
        .unwrap();
    let before = snapshot(&f.s);
    for limit in [0, 1, 2, 99] {
        let public = f.s.due_pending_claims(NOW, limit).unwrap();
        assert_eq!(
            public.iter().map(|c| &c.id).collect::<Vec<_>>(),
            f.claims[..limit.min(2)]
                .iter()
                .map(|c| &c.id)
                .collect::<Vec<_>>()
        );
        let c = f.s.connection.lock().unwrap();
        assert_eq!(
            identity::due_pending_claims_in(&c, NOW, limit, identity::DueSelection::Reporting)
                .unwrap(),
            public
        );
        assert_eq!(
            identity::due_pending_claims_in(&c, NOW, limit, identity::DueSelection::Execution)
                .unwrap(),
            public
        );
    }
    assert_eq!(snapshot(&f.s), before);
}

#[test]
fn x02_one_due_claim_has_true_expiry_attribution() {
    let f = fixture(1);
    upgrade(&f.s);
    let k = JournalKernel::activate(&f.s).unwrap();
    let out = run(&k, 1);
    assert_eq!(out.len(), 1);
    assert_resolution(&f, &out[0]);
    let core = cores(&f.s).pop().unwrap();
    let update = core
        .operations
        .iter()
        .find_map(|op| match op {
            Operation::FacetUpdate(u) if u.entity == K::PendingClaims => Some(u),
            _ => None,
        })
        .unwrap();
    let proof = update.review_proof.as_ref().unwrap();
    assert_eq!(proof.action, codec::ReviewAction::KeepSeparate);
    assert_eq!(proof.method, Some(codec::ReviewMethod::Expiry));
    assert_eq!(proof.claim_id.as_deref(), Some(f.claims[0].id.as_str()));
    assert_eq!(proof.object_id.as_deref(), Some(out[0].object_id.as_str()));
    assert_eq!(proof.proposal_id, None);
    assert_eq!(proof.result_revision_id, None);
}

fn linked(deferred: bool) {
    let f = fixture(1);
    let original = f.s.insert_revision_proposal(&proposal(&f, 0)).unwrap().0;
    if deferred {
        f.s.review_revision_proposal(&ReviewRequest {
            proposal_id: original.id.clone(),
            action: ReviewAction::Defer { due_at: None },
            reviewed_revision_id: None,
        })
        .unwrap();
    }
    let original = proposal_store::proposal_in(&f.s.connection.lock().unwrap(), &original.id)
        .unwrap()
        .unwrap();
    upgrade(&f.s);
    let k = JournalKernel::activate(&f.s).unwrap();
    let out = run(&k, 1);
    assert_resolution(&f, &out[0]);
    let c = f.s.connection.lock().unwrap();
    let after = proposal_store::proposal_in(&c, &original.id)
        .unwrap()
        .unwrap();
    assert_eq!(after.state, "superseded");
    assert_eq!(after.reviewed_at, out[0].claim.resolved_at);
    let mut expected = original.clone();
    expected.state = after.state.clone();
    expected.updated_at = after.updated_at.clone();
    expected.reviewed_at = after.reviewed_at.clone();
    assert_eq!(after, expected);
    drop(c);
    let core = cores(&f.s).pop().unwrap();
    let updates: Vec<_> = core
        .operations
        .iter()
        .filter_map(|op| match op {
            Operation::FacetUpdate(u) if u.entity == K::RevisionProposals => Some(u),
            _ => None,
        })
        .collect();
    assert_eq!(updates.len(), 1);
    let proof = updates[0].review_proof.as_ref().unwrap();
    assert_eq!(proof.action, codec::ReviewAction::Supersede);
    assert_eq!(
        proof.method,
        Some(codec::ReviewMethod::DerivedClaimResolution)
    );
    assert_eq!(proof.proposal_id.as_deref(), Some(original.id.as_str()));
    assert_eq!(proof.claim_id.as_deref(), Some(f.claims[0].id.as_str()));
    assert_eq!(core.raw_effect_count, "6");
}

#[test]
fn x03_linked_open_proposal_has_derived_supersession() {
    linked(false);
}

#[test]
fn x04_linked_deferred_proposal_has_derived_supersession() {
    linked(true);
}

#[test]
fn x05_no_proposal_is_invented_and_terminal_drafts_are_preserved() {
    for terminal in [None, Some(ReviewAction::Reject)] {
        let f = fixture(1);
        let proposal = terminal.map(|action| {
            let p = f.s.insert_revision_proposal(&proposal(&f, 0)).unwrap().0;
            f.s.review_revision_proposal(&ReviewRequest {
                proposal_id: p.id.clone(),
                action,
                reviewed_revision_id: None,
            })
            .unwrap();
            proposal_store::proposal_in(&f.s.connection.lock().unwrap(), &p.id)
                .unwrap()
                .unwrap()
        });
        upgrade(&f.s);
        let k = JournalKernel::activate(&f.s).unwrap();
        run(&k, 1);
        let core = cores(&f.s).pop().unwrap();
        assert!(core
            .operations
            .iter()
            .all(|op| op.entity() != K::RevisionProposals));
        if let Some(p) = proposal {
            assert_eq!(
                proposal_store::proposal_in(&f.s.connection.lock().unwrap(), &p.id)
                    .unwrap()
                    .unwrap(),
                p
            );
        } else {
            assert_eq!(count(&f.s, "revision_proposals"), 0);
        }
    }
}

#[test]
fn x06_empty_zero_limit_and_repeated_pass_are_noops() {
    for n in [0, 1] {
        let f = fixture(n);
        upgrade(&f.s);
        let k = JournalKernel::activate(&f.s).unwrap();
        let before = snapshot(&f.s);
        assert!(run(&k, 0).is_empty());
        assert_eq!(snapshot(&f.s), before);
        assert_eq!(run(&k, 1).len(), n);
        let before = snapshot(&f.s);
        assert!(run(&k, 1).is_empty());
        assert_eq!(snapshot(&f.s), before);
        cores(&f.s);
    }
}

#[test]
fn x07_batch_limit_preserves_oldest_insertion_order() {
    let f = fixture(4);
    f.s.defer_pending_claim(&f.claims[0].id, Some("2026-10-22T23:00:00Z"))
        .unwrap();
    upgrade(&f.s);
    let k = JournalKernel::activate(&f.s).unwrap();
    assert!(Request::candidate(NOW, expiry::MAX_EXPIRY_BATCH + 1).is_err());
    let out = run(&k, 2);
    assert_eq!(
        out.iter().map(|r| &r.claim.id).collect::<Vec<_>>(),
        f.claims[..2].iter().map(|c| &c.id).collect::<Vec<_>>()
    );
    assert_eq!(
        f.s.get_pending_claim(&f.claims[2].id)
            .unwrap()
            .unwrap()
            .state,
        "open"
    );
    assert_eq!(run(&k, 2).len(), 2);
    assert!(run(&k, 2).is_empty());
    cores(&f.s);
}

#[test]
fn x08_multiple_resolutions_share_one_complete_bundle() {
    let f = fixture(3);
    upgrade(&f.s);
    let k = JournalKernel::activate(&f.s).unwrap();
    let out = run(&k, 3);
    assert_eq!(out.len(), 3);
    for r in &out {
        assert_resolution(&f, r);
    }
    let events = cores(&f.s);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].operations.len(), 12);
    assert_eq!(events[0].raw_effect_count, "15");
}

#[test]
fn x09_future_boundary_offsets_and_malformed_times() {
    let f = fixture(2);
    f.s.defer_pending_claim(&f.claims[0].id, Some("2026-10-23T11:00:00+02:00"))
        .unwrap();
    f.s.defer_pending_claim(&f.claims[1].id, Some(FUTURE))
        .unwrap();
    assert!(Request::candidate("not-a-time", 1).is_err());
    assert!(f.s.due_pending_claims("not-a-time", 0).is_err());
    upgrade(&f.s);
    let k = JournalKernel::activate(&f.s).unwrap();
    let out = run(&k, 2);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].claim.id, f.claims[0].id);
    let before = snapshot(&f.s);
    assert!(run(&k, 2).is_empty());
    assert_eq!(snapshot(&f.s), before);
    cores(&f.s);
    let malformed = fixture(1);
    upgrade(&malformed.s);
    let k = JournalKernel::activate(&malformed.s).unwrap();
    let before = snapshot(&malformed.s);
    assert_eq!(
        k.run(|tx| {
            tx.sql().execute(
                "UPDATE pending_claims SET due_at='malformed' WHERE id=?1",
                [&malformed.claims[0].id],
            )?;
            assert!(matches!(
                expiry::select(tx.sql(), &Request::candidate(NOW, 1).unwrap()),
                Err(identity::IdentityStoreError::Invalid(_))
            ));
            Err::<(), _>(JournalError::Domain)
        }),
        Err(JournalError::Domain)
    );
    assert_eq!(snapshot(&malformed.s), before);
    // The unchanged public reporter continues to ignore malformed due dates.
    let reporting = fixture(1);
    reporting
        .s
        .connection
        .lock()
        .unwrap()
        .execute(
            "UPDATE pending_claims SET due_at='malformed' WHERE id=?1",
            [&reporting.claims[0].id],
        )
        .unwrap();
    assert!(reporting.s.due_pending_claims(NOW, 1).unwrap().is_empty());
    let malformed = fixture(2);
    let original = malformed
        .s
        .insert_revision_proposal(&proposal(&malformed, 0))
        .unwrap()
        .0;
    malformed.s.connection.lock().unwrap().execute(
        "INSERT INTO revision_proposals(id,pending_claim_id,object_id,base_revision_id,change,kind,title,proposed_body,evidence_json,synthesis_model,verifier_model,verification_mode,verification_status,policy_version,state,user_edited,created_at,updated_at) SELECT ?1,?2,object_id,base_revision_id,change,kind,title,proposed_body,'[{}]',synthesis_model,verifier_model,verification_mode,verification_status,policy_version,'open',0,created_at,updated_at FROM revision_proposals WHERE id=?3",
        rusqlite::params![uuid::Uuid::new_v4().to_string(), malformed.claims[1].id, original.id],
    ).unwrap();
    upgrade(&malformed.s);
    let k = JournalKernel::activate(&malformed.s).unwrap();
    let before = snapshot(&malformed.s);
    assert!(matches!(
        k.write(|w| w.execute_due_expiry(Request::candidate(NOW, 2)?)),
        Err(WriterError::Identity(IdentityFailure::Invalid))
    ));
    assert_eq!(snapshot(&malformed.s), before);
}

#[test]
fn x10_accepted_and_separated_claims_are_not_resolved_again() {
    let f = fixture(4);
    let approved = f.s.insert_revision_proposal(&proposal(&f, 0)).unwrap().0;
    let separated_proposal = f.s.insert_revision_proposal(&proposal(&f, 1)).unwrap().0;
    upgrade(&f.s);
    let k = JournalKernel::activate(&f.s).unwrap();
    k.write(|w| {
        w.review_proposal(ReviewRequest {
            proposal_id: approved.id.clone(),
            action: ReviewAction::Approve,
            reviewed_revision_id: None,
        })
    })
    .unwrap();
    k.write(|w| {
        w.review_proposal(ReviewRequest {
            proposal_id: separated_proposal.id.clone(),
            action: ReviewAction::KeepSeparate,
            reviewed_revision_id: None,
        })
    })
    .unwrap();
    let terminal = [&approved.id, &separated_proposal.id].map(|id| {
        proposal_store::proposal_in(&f.s.connection.lock().unwrap(), id)
            .unwrap()
            .unwrap()
    });
    k.write(|w| w.defer_claim(&f.claims[2].id, None)).unwrap();
    let accepted = f.s.get_pending_claim(&f.claims[0].id).unwrap().unwrap();
    let separated = f.s.get_pending_claim(&f.claims[1].id).unwrap().unwrap();
    let out = run(&k, 4);
    assert_eq!(out.len(), 2);
    assert_eq!(
        f.s.get_pending_claim(&accepted.id).unwrap().unwrap(),
        accepted
    );
    assert_eq!(
        f.s.get_pending_claim(&separated.id).unwrap().unwrap(),
        separated
    );
    for proposal in terminal {
        assert_eq!(
            proposal_store::proposal_in(&f.s.connection.lock().unwrap(), &proposal.id)
                .unwrap()
                .unwrap(),
            proposal
        );
    }
    cores(&f.s);
}

#[test]
fn x11_project_archived_after_preview_is_excluded() {
    let f = fixture(1);
    let p = f.s.create_project("Archive").unwrap();
    f.s.move_capture(&f.capture.id, &p.id).unwrap();
    assert_eq!(f.s.due_pending_claims(NOW, 1).unwrap().len(), 1);
    upgrade(&f.s);
    let k = JournalKernel::activate(&f.s).unwrap();
    k.write(|w| w.archive_project(&p.id)).unwrap();
    let before = snapshot(&f.s);
    assert!(run(&k, 1).is_empty());
    assert_eq!(snapshot(&f.s), before);
    assert_eq!(f.s.list_pending_claims(None, &["open"]).unwrap().len(), 1);
    cores(&f.s);
}

#[test]
fn x12_moved_capture_uses_current_project() {
    let f = fixture(2);
    let p = f.s.create_project("Current").unwrap();
    assert_eq!(f.s.due_pending_claims(NOW, 2).unwrap().len(), 2);
    upgrade(&f.s);
    let k = JournalKernel::activate(&f.s).unwrap();
    k.write(|w| w.move_capture(&f.capture.id, &p.id)).unwrap();
    let out = run(&k, 1);
    assert_eq!(out[0].claim.project_id, p.id);
    assert_resolution(&f, &out[0]);
    k.write(|w| w.archive_project(&p.id)).unwrap();
    let before = snapshot(&f.s);
    assert!(run(&k, 2).is_empty());
    assert_eq!(snapshot(&f.s), before);
    cores(&f.s);
}

#[test]
fn x13_stale_preview_cannot_authorize_execution() {
    let f = fixture(2);
    let preview = f.s.due_pending_claims(NOW, 2).unwrap();
    assert_eq!(preview.len(), 2);
    upgrade(&f.s);
    let k = JournalKernel::activate(&f.s).unwrap();
    k.write(|w| w.defer_claim(&preview[0].id, Some(FUTURE)))
        .unwrap();
    k.write(|w| w.separate_pending_claim(&preview[1].id, "user"))
        .unwrap();
    let before = snapshot(&f.s);
    assert!(run(&k, 2).is_empty());
    assert_eq!(snapshot(&f.s), before);
    cores(&f.s);
}

#[test]
fn x14_later_domain_failure_poison_rolls_back_earlier_claims() {
    let f = fixture(2);
    for i in 0..2 {
        f.s.insert_revision_proposal(&proposal(&f, i)).unwrap();
    }
    upgrade(&f.s);
    let k = JournalKernel::activate(&f.s).unwrap();
    f.s.connection.lock().unwrap().execute_batch("CREATE TEMP TRIGGER expiry_fail_second BEFORE INSERT ON knowledge_objects WHEN NEW.title='Claim 1' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
    let before = snapshot(&f.s);
    assert!(k
        .write(|w| {
            assert!(w.execute_due_expiry(Request::candidate(NOW, 2)?).is_err());
            Ok(())
        })
        .is_err());
    assert_eq!(snapshot(&f.s), before);
    cores(&f.s);
    f.s.connection
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER expiry_fail_second")
        .unwrap();
    assert_eq!(run(&k, 2).len(), 2);
    assert_eq!(cores(&f.s)[0].origin_seq, "1");
}

#[test]
fn x15_journal_finalization_faults_roll_back_the_entire_batch() {
    let f = fixture(2);
    for i in 0..2 {
        f.s.insert_revision_proposal(&proposal(&f, i)).unwrap();
    }
    upgrade(&f.s);
    let k = JournalKernel::activate(&f.s).unwrap();
    for stage in [
        Stage::Effects,
        Stage::Codec,
        Stage::Bundle,
        Stage::Heads,
        Stage::Cleanup,
        Stage::Commit,
    ] {
        let before = snapshot(&f.s);
        let mut domain_finished = false;
        assert!(matches!(
            k.write_fault(Fault::At(stage), |w| {
                let out = w.execute_due_expiry(Request::candidate(NOW, 2)?)?;
                assert_eq!(out.len(), 2);
                assert_eq!(w.observed_effect_count(), 12);
                domain_finished = true;
                Ok(())
            }),
            Err(WriterError::Journal(JournalError::Injected))
        ));
        assert!(domain_finished);
        assert_eq!(snapshot(&f.s), before);
        cores(&f.s);
    }
    assert_eq!(run(&k, 2).len(), 2);
    assert_eq!(cores(&f.s)[0].origin_seq, "1");
}

#[test]
fn x16_actual_stored_core_has_exact_proofs_dependencies_and_facets() {
    let f = fixture(0);
    upgrade(&f.s);
    let k = JournalKernel::activate(&f.s).unwrap();
    let claim = k
        .write(|w| w.stage_uncertain_claim(pending(&f.capture.id, &f.target.id, 0)))
        .unwrap()
        .0;
    let p = NewProposal {
        pending_claim_id: claim.id.clone(),
        object_id: f.target.id.clone(),
        base_revision_id: f.s.current_revision_id_of(&f.target.id).unwrap().unwrap(),
        change: "additive".into(),
        kind: "idea".into(),
        title: "Draft".into(),
        proposed_body: "Preserved draft".into(),
        retracts: None,
        evidence: vec![EvidenceRef {
            role: "claim".into(),
            capture_id: f.capture.id.clone(),
            start: 0,
            end: 4,
        }],
        synthesis_model: "synthetic".into(),
        verifier_model: "synthetic".into(),
        verification_mode: "same_family_review".into(),
        policy_version: "test".into(),
    };
    let p = k.write(|w| w.insert_proposal(p)).unwrap().0;
    let previous = cores(&f.s);
    let claim_event = previous[0].event_id.clone();
    let proposal_event = previous[1].event_id.clone();
    let out = k
        .write(|w| {
            let out = w.execute_due_expiry(Request::candidate(NOW, 1)?)?;
            assert_eq!(w.observed_effect_count(), 6);
            Ok(out)
        })
        .unwrap();
    assert_resolution(&f, &out[0]);
    let events = cores(&f.s);
    assert_eq!(events.len(), 3);
    let core = &events[2];
    assert_eq!(core.raw_effect_count, "6");
    assert_eq!(core.operations.len(), 5);
    let expected: Vec<_> = vec![
        (K::KnowledgeObjects, out[0].object_id.clone()),
        (K::ObjectSources, out[0].object_id.clone()),
        (
            K::ThoughtRevisions,
            f.s.current_revision_id_of(&out[0].object_id)
                .unwrap()
                .unwrap(),
        ),
    ];
    for (entity, id) in expected {
        assert_eq!(core.operations.iter().filter(|op| matches!(op, Operation::RecordCreate(r) if r.entity==entity && r.key==[id.clone()])).count(), 1);
    }
    for (entity, id, from, action, method, prior) in [
        (
            K::PendingClaims,
            &claim.id,
            "open",
            codec::ReviewAction::KeepSeparate,
            codec::ReviewMethod::Expiry,
            claim_event,
        ),
        (
            K::RevisionProposals,
            &p.id,
            "open",
            codec::ReviewAction::Supersede,
            codec::ReviewMethod::DerivedClaimResolution,
            proposal_event,
        ),
    ] {
        let u = core
            .operations
            .iter()
            .find_map(|op| match op {
                Operation::FacetUpdate(u) if u.entity == entity && u.key == [id.clone()] => Some(u),
                _ => None,
            })
            .unwrap();
        assert_eq!(sql::text(&u.before, "state").unwrap(), from);
        assert_eq!(
            sql::text(&u.after, "state").unwrap(),
            if entity == K::PendingClaims {
                "separated"
            } else {
                "superseded"
            }
        );
        assert_eq!(u.expected.len(), 1);
        assert_eq!(
            u.expected["lifecycle"].event_ref.as_ref().unwrap().event_id,
            prior
        );
        let proof = u.review_proof.as_ref().unwrap();
        assert_eq!(proof.action, action);
        assert_eq!(proof.method, Some(method));
        assert_eq!(proof.claim_id.as_deref(), Some(claim.id.as_str()));
        if entity == K::PendingClaims {
            assert_eq!(proof.object_id.as_deref(), Some(out[0].object_id.as_str()));
            assert_eq!(proof.proposal_id, None);
        } else {
            assert_eq!(proof.proposal_id.as_deref(), Some(p.id.as_str()));
        }
    }
    assert!(core
        .dependencies
        .iter()
        .any(|d| d.entity == K::PendingClaims
            && d.key == [claim.id.clone()]
            && d.event_ref
                .as_ref()
                .is_some_and(|r| r.event_id == previous[0].event_id)));
    for (entity, key) in [
        (K::Captures, vec![f.capture.id.clone()]),
        (K::Projects, vec![f.capture.project_id.clone()]),
        (K::IdentityDecisions, vec![f.capture.id.clone(), "0".into()]),
        (K::KnowledgeObjects, vec![f.target.id.clone()]),
        (
            K::ThoughtRevisions,
            vec![f.s.current_revision_id_of(&f.target.id).unwrap().unwrap()],
        ),
    ] {
        assert!(core
            .dependencies
            .iter()
            .any(|d| d.entity == entity && d.key == key));
    }
    assert!(core
        .operations
        .iter()
        .all(|op| !matches!(op, Operation::FacetUpdate(u) if u.entity==K::KnowledgeObjects)));
    assert!(core.operations.iter().all(|op| match op {
        Operation::FacetUpdate(u) => u
            .review_proof
            .as_ref()
            .is_none_or(|p| p.method != Some(codec::ReviewMethod::User)),
        _ => true,
    }));
    assert_eq!(count(&f.s, "revision_parents"), 0);
}

#[test]
fn x17_production_v9_due_query_remains_reporting_only() {
    let f = fixture(1);
    let before = snapshot(&f.s);
    for _ in 0..3 {
        assert_eq!(f.s.due_pending_claims(NOW, 1).unwrap(), f.claims);
    }
    assert_eq!(snapshot(&f.s), before);
    assert_eq!(migrations::SCHEMA_VERSION, 9);
    assert_eq!(
        migrations::STEPS.iter().map(|s| s.0).collect::<Vec<_>>(),
        (1..=9).collect::<Vec<_>>()
    );
    assert!(matches!(
        JournalKernel::activate(&f.s),
        Err(JournalError::WrongSchema)
    ));
}

#[test]
fn x18_executor_has_no_production_callsite_or_scheduler() {
    // The physical-admission integration suites exercise expiry but must stay
    // test-only; its new callsite does not authorize production scheduling.
    assert!(include_str!("mod.rs").replace("\r\n", "\n").contains("#[cfg(test)]\nmod admission_tests;"));
    assert!(include_str!("mod.rs").replace("\r\n", "\n").contains("#[cfg(test)]\nmod physical_tests;"));
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut paths = vec![root];
    while let Some(path) = paths.pop() {
        if path.is_dir() {
            paths.extend(std::fs::read_dir(path).unwrap().map(|e| e.unwrap().path()));
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let name = path.file_name().unwrap().to_str().unwrap();
        if matches!(name, "expiry.rs" | "expiry_tests.rs" | "writers.rs" | "admission_tests.rs" | "physical_tests.rs") {
            continue;
        }
        let source = std::fs::read_to_string(&path).unwrap();
        assert!(
            !source.contains("execute_due_expiry")
                && !source.contains("DormantExpiryRequest")
                && !source.contains("expiry::select")
                && !source.contains("expiry::recheck"),
            "unexpected invocation in {}",
            path.display()
        );
    }
    let source = include_str!("expiry.rs");
    for forbidden in [
        "Connection::open",
        ".lock()",
        "tokio::",
        "std::thread",
        "SystemTime",
        "COMMIT",
        "BEGIN ",
    ] {
        assert!(!source.contains(forbidden), "{forbidden}");
    }
    assert!(include_str!("mod.rs").contains("mod expiry;"));
}
