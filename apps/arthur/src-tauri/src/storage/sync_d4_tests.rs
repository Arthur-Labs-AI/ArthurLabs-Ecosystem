//! D4 exercises independent, owned, disk-backed databases; no file copying.
use super::*;
fn peer(id: Uuid, other: Uuid) -> Peer {
    let p = bare(id, other);
    f::install_d4(&p.store);
    p
}
fn transfer(a: &Peer, b: &Peer) {
    let s = context(b, &origins(a, b));
    let adapter = CandidateSyncStore::synthetic(&b.store);
    let events = test_events(&a.store);
    for e in &events {
        let r = receive(&adapter, &s, e);
        assert!([Outcome::CleanlyApplied, Outcome::DeferredDependency].contains(&r.outcome));
    }
    for _ in 0..events.len() {
        adapter
            .reprocess(&s, &Clock::default(), &Cancellation::default())
            .unwrap();
    }
    for e in &events {
        assert_eq!(receive(&adapter, &s, e).outcome, Outcome::CleanlyApplied);
    }
}

#[test]
fn d4_01_relations_preserve_original_identity_direction_and_ownership() {
    let a = peer(A, B);
    let b = peer(B, A);
    let (_, one, _) = f::history(&a.store);
    let (_, two, _) = f::history(&a.store);
    let id = f::relation(&a.store, &one, &two);
    transfer(&a, &b);
    let edge = b.store.list_relations().unwrap().remove(0);
    assert_eq!(edge.id, id);
    assert_eq!(edge.origin, "user");
    assert_eq!(edge.source_object_id, one);
    assert_eq!(edge.target_object_id, two);
    assert_eq!(b.count("import_d4_commits"), b.count("import_events"));
    b.reopen();
}
#[test]
fn d4_02_semantic_duplicates_keep_originals_and_user_edge_as_explicit_conflict() {
    let a = peer(A, B);
    let b = peer(B, A);
    let (_, one, _) = f::history(&a.store);
    let (_, two, _) = f::history(&a.store);
    transfer(&a, &b);
    let aid = f::relation_owned(&a.store, &one, &two, "model");
    let bid = f::relation(&b.store, &one, &two);
    assert_ne!(aid, bid);
    let event = f::last_original(&a.store);
    let s = context(&b, &origins(&a, &b));
    let before = f::domain_state(&b.store);
    assert_eq!(
        receive(&CandidateSyncStore::synthetic(&b.store), &s, &event).outcome,
        Outcome::ConflictRetained
    );
    assert_eq!(before, f::domain_state(&b.store));
    assert_eq!(b.count("import_conflicts"), 1);
    assert_eq!(b.store.list_relations().unwrap()[0].id, bid);
    assert_eq!(b.store.list_relations().unwrap()[0].origin, "user");
    assert!(test_events(&b.store).iter().any(|e| e.bytes == event.bytes));
    b.reopen();
}
#[test]
fn d4_03_observed_removal_is_exact_and_replay_cannot_delete_later_add() {
    let a = peer(A, B);
    let b = peer(B, A);
    let (_, one, _) = f::history(&a.store);
    let (_, two, _) = f::history(&a.store);
    let old = f::relation_owned(&a.store, &one, &two, "model");
    transfer(&a, &b);
    f::remove_model(&a.store, &old);
    let removal = f::last_original(&a.store);
    transfer(&a, &b);
    assert_eq!(b.count("relations"), 0);
    let new = f::relation(&b.store, &one, &two);
    assert_ne!(old, new);
    let s = context(&b, &origins(&a, &b));
    assert_eq!(
        receive(&CandidateSyncStore::synthetic(&b.store), &s, &removal).outcome,
        Outcome::CleanlyApplied
    );
    assert_eq!(b.store.list_relations().unwrap()[0].id, new);
    assert_eq!(b.store.list_relations().unwrap()[0].origin, "user");
    b.reopen();
}
#[test]
fn d4_04_05_decisions_claims_and_proposals_materialize_exact_original_rows() {
    let a = peer(A, B);
    let b = peer(B, A);
    let (object, base, claim, proposal) = f::open_proposal(&a.store);
    transfer(&a, &b);
    assert_eq!(b.count("identity_decisions"), 1);
    assert_eq!(b.count("pending_claims"), 1);
    assert_eq!(b.count("revision_proposals"), 1);
    for (entity, id) in [
        (codec::EntityKind::KnowledgeObjects, object),
        (codec::EntityKind::ThoughtRevisions, base),
        (codec::EntityKind::PendingClaims, claim),
        (codec::EntityKind::RevisionProposals, proposal),
    ] {
        f::assert_same_row(&a.store, &b.store, entity, &[id]);
    }
    b.reopen();
}
#[test]
fn d4_06_incomplete_historical_approval_never_executes_a_local_review() {
    let a = peer(A, B);
    let b = peer(B, A);
    f::review_history(&a.store);
    let s = context(&b, &origins(&a, &b));
    let adapter = CandidateSyncStore::synthetic(&b.store);
    let events = test_events(&a.store);
    for e in &events[..events.len() - 1] {
        assert_eq!(receive(&adapter, &s, e).outcome, Outcome::CleanlyApplied);
    }
    let before = f::domain_state(&b.store);
    assert_eq!(
        receive(&adapter, &s, events.last().unwrap()).outcome,
        Outcome::UnsupportedImportPolicy
    );
    assert_eq!(before, f::domain_state(&b.store));
    assert_eq!(
        b.store
            .query_i64_for_test("SELECT count(*) FROM revision_proposals WHERE state='approved'"),
        0
    );
    assert_eq!(
        b.store
            .query_i64_for_test("SELECT count(*) FROM pending_claims WHERE state='open'"),
        1
    );
    assert_eq!(b.count("thought_revisions"), 1);
    drop(adapter);
    b.reopen();
}
#[test]
fn d4_07_09_exact_foreign_rename_chain_and_held_local_writer_dependencies() {
    let a = peer(A, B);
    let b = peer(B, A);
    let (project, _) = f::project_and_capture(&a.store, "Original", "original child");
    transfer(&a, &b);
    f::rename_id(&a.store, &project, "Foreign rename");
    let event = f::last_original(&a.store);
    let s = context(&b, &origins(&a, &b));
    let adapter = CandidateSyncStore::synthetic(&b.store);
    f::held_project_kernel_continues(&b.store, &project, || {
        assert_eq!(
            receive(&adapter, &s, &event).outcome,
            Outcome::CleanlyApplied
        )
    });
    let local = test_events(&b.store)
        .into_iter()
        .find(|e| e.identity.origin != event.identity.origin)
        .unwrap();
    let v = ValidatedEvent::parse(local).unwrap();
    assert!(v.core().operations.iter().any(|op|matches!(op,codec::Operation::FacetUpdate(u) if u.expected.values().any(|p|p.event_ref.as_ref().is_some_and(|r|r.event_id==event.identity.event.to_string())))));
    drop(adapter);
    b.reopen();
}
#[test]
fn d4_07_capture_membership_and_selected_head_apply_exact_causal_changes() {
    let a = peer(A, B);
    let b = peer(B, A);
    let (project, cap) = f::project_and_capture(&a.store, "Move target", "child");
    let (_, object, _) = f::history(&a.store);
    transfer(&a, &b);
    f::move_capture_id(&a.store, &cap, crate::storage::migrations::INBOX_PROJECT_ID);
    f::edit_id(&a.store, &object, "Foreign selected revision");
    transfer(&a, &b);
    assert_eq!(
        a.store.current_revision_id_of(&object).unwrap(),
        b.store.current_revision_id_of(&object).unwrap()
    );
    assert_eq!(
        b.store.query_i64_for_test(&format!(
            "SELECT count(*) FROM captures WHERE id='{cap}' AND project_id='{project}'"
        )),
        0
    );
    b.reopen();
}
#[test]
fn d4_08_concurrent_archive_capture_and_heads_preserve_both_branches() {
    let a = peer(A, B);
    let b = peer(B, A);
    let (project, _) = f::project_and_capture(&a.store, "Concurrent archive", "old child");
    let (_, object, _) = f::history(&a.store);
    transfer(&a, &b);
    f::capture_in(&b.store, &project, "independent concurrent capture");
    f::archive_id(&a.store, &project, false);
    let archive = f::last_original(&a.store);
    let s = context(&b, &origins(&a, &b));
    let adapter = CandidateSyncStore::synthetic(&b.store);
    assert_eq!(
        receive(&adapter, &s, &archive).outcome,
        Outcome::ConflictRetained
    );
    f::edit_id(&a.store, &object, "A branch");
    f::edit_id(&b.store, &object, "B branch");
    let s = context(&b, &origins(&a, &b));
    let head = b.store.current_revision_id_of(&object).unwrap();
    assert_eq!(
        receive(&adapter, &s, &f::last_original(&a.store)).outcome,
        Outcome::ConflictRetained
    );
    assert_eq!(head, b.store.current_revision_id_of(&object).unwrap());
    assert_eq!(
        b.store.query_i64_for_test(&format!(
            "SELECT count(*) FROM projects WHERE id='{project}' AND archived_at IS NULL"
        )),
        1
    );
    assert_eq!(b.count("import_conflicts"), 2);
    drop(adapter);
    b.reopen();
}

#[test]
fn d4_10_empty_origin_is_not_implicit_disclosure_authority() {
    let a = bare(A, B);
    let b = bare(B, A);
    f::captures(&a.store, &["authorized private knowledge"]);
    let s = context(&a, &origins(&a, &b));
    a.store.execute_sql_for_test("INSERT INTO sync_origins(origin_id,incarnation,status,opened_at,sealed_at) VALUES('aaaaaaaa-1111-4111-8111-111111111111','bbbbbbbb-1111-4111-8111-111111111111','sealed','2026-10-23T00:00:00Z','2026-10-23T00:00:00Z')");
    assert!(matches!(
        CandidateSyncStore::synthetic(&a.store).snapshot_capture(
            &s,
            Uuid::from_u128(4001),
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Trust)
    ));
    assert_eq!(a.count("bootstrap_units"), 0);
}

#[test]
fn d4_10_unattributed_legacy_knowledge_cannot_escape_an_empty_scope() {
    let a = Peer::graph(A, B);
    f::install_g3(&a.store);
    f::install_history(&a.store);
    f::install_d4(&a.store);
    assert_eq!(a.count("sync_origins"), 0);
    assert!(a.count("knowledge_objects") > 0);
    let s = context(&a, &BTreeSet::new());
    assert!(matches!(
        CandidateSyncStore::synthetic(&a.store).snapshot_capture(
            &s,
            Uuid::from_u128(4027),
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Trust)
    ));
    assert_eq!(a.count("bootstrap_units"), 0);
}

#[test]
fn d4_10_cached_manifest_rechecks_narrowed_scope_before_disclosure() {
    let a = bare(A, B);
    let b = bare(B, A);
    f::captures(&a.store, &["private project body"]);
    let (snapshot, _, _) = capture(&a, &b, 4002);
    let denied = context(&a, &BTreeSet::new());
    assert!(matches!(
        CandidateSyncStore::synthetic(&a.store).snapshot_capture(
            &denied,
            snapshot.offer.id,
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Trust)
    ));
    assert_eq!(a.count("bootstrap_units"), 1);
}

#[test]
fn d4_11_receiver_rejects_unauthorized_empty_origin_metadata_atomically() {
    let a = bare(A, B);
    let b = bare(B, A);
    f::captures(&a.store, &["allowed"]);
    let (snapshot, _, s) = capture(&a, &b, 4003);
    let mut image = decode(&snapshot.bytes).unwrap();
    image
        .origin_metadata
        .push(serde_json::json!({"kind":"local_origin",
        "origin":"aaaaaaaa-1111-4111-8111-111111111111",
        "incarnation":"bbbbbbbb-1111-4111-8111-111111111111",
        "seq":"0","hash":hex(&[0;32]),"status":"sealed",
        "opened":"2026-10-23T00:00:00Z","sealed":"2026-10-23T00:00:00Z"}));
    let bytes = canonical(&image).unwrap();
    let forged = SnapshotExport {
        offer: SnapshotOffer {
            id: snapshot.offer.id,
            hash: codec::journal_event_hash(&bytes),
            bytes: bytes.len(),
            chunks: bytes.len().div_ceil(CHUNK),
        },
        bytes,
    };
    let adapter = CandidateSyncStore::synthetic(&b.store);
    stage(&adapter, &s, &forged);
    let before = f::state(&b.store);
    assert_eq!(
        adapter
            .snapshot_publish(
                &s,
                &forged.offer,
                &Clock::default(),
                &Cancellation::default()
            )
            .err(),
        Some(Error::Trust)
    );
    assert_eq!(before, f::state(&b.store));
    assert_eq!(b.count("captures"), 0);
    drop(adapter);
    b.reopen();
}

#[test]
fn d4_10_11_populated_foreign_origins_and_creation_proofs_require_original_scope() {
    let a = peer(A, B);
    let b = peer(B, A);
    f::history(&a.store);
    f::captures(&b.store, &["private B original"]);
    transfer(&a, &b);
    assert!(b.count("import_creates") > 0);
    assert!(b.count("import_d4_commits") > 0);
    let local = test_events(&b.store)
        .into_iter()
        .filter(|e| {
            !test_events(&a.store)
                .iter()
                .any(|a| a.identity.event == e.identity.event)
        })
        .map(|e| e.identity.origin)
        .collect();
    let denied = context(&b, &local);
    assert!(matches!(
        CandidateSyncStore::synthetic(&b.store).snapshot_capture(
            &denied,
            Uuid::from_u128(4010),
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Trust)
    ));
    assert_eq!(b.count("bootstrap_units"), 0);
    // The trusted forwarding peer does not substitute for the original origin.
    let c = peer(A, B);
    let no_origins = context(&c, &BTreeSet::new());
    assert!(matches!(
        CandidateSyncStore::synthetic(&c.store).retain(
            &no_origins,
            ValidatedEvent::parse(test_events(&b.store)[0].clone()).unwrap(),
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Trust)
    ));
    assert_eq!(c.count("import_events"), 0);
}
#[test]
fn d4_12_13_supported_snapshot_merges_existing_knowledge_and_foreign_provenance() {
    let a = peer(A, B);
    let b = peer(B, A);
    f::history(&b.store);
    transfer(&b, &a);
    f::open_proposal(&a.store);
    let (snapshot, _, s) = capture(&a, &b, 4012);
    let image = decode(&snapshot.bytes).unwrap();
    assert_eq!(image.profile, BOOTSTRAP_D4_PROFILE);
    assert!(image.origin_metadata.iter().any(|m| m["kind"] == "facet"));
    assert!(image
        .origin_metadata
        .iter()
        .any(|m| m["kind"] == "d4_materialization"));
    let adapter = CandidateSyncStore::synthetic(&b.store);
    stage(&adapter, &s, &snapshot);
    assert_eq!(
        adapter
            .snapshot_publish(
                &s,
                &snapshot.offer,
                &Clock::default(),
                &Cancellation::default()
            )
            .unwrap()
            .outcome,
        Outcome::CleanlyApplied
    );
    assert_eq!(b.count("knowledge_objects"), 2);
    assert_eq!(b.count("revision_proposals"), 1);
    assert_eq!(b.count("sync_bundles"), 5);
    assert_eq!(b.count("bootstrap_units"), 1);
    drop(adapter);
    a.reopen();
    b.reopen();
}
#[test]
fn d4_14_22_unsupported_approval_snapshot_never_partially_publishes() {
    let a = peer(A, B);
    let b = peer(B, A);
    f::review_history(&a.store);
    f::captures(&b.store, &["independent receiver knowledge"]);
    let (snapshot, _, s) = capture(&a, &b, 4014);
    assert!(decode(&snapshot.bytes)
        .unwrap()
        .origin_metadata
        .iter()
        .any(|m| m["kind"] == "review_attestation" && m["provenance"] == "legacy_attested"));
    let adapter = CandidateSyncStore::synthetic(&b.store);
    stage(&adapter, &s, &snapshot);
    let before = f::domain_state(&b.store);
    let receipt = adapter
        .snapshot_publish(
            &s,
            &snapshot.offer,
            &Clock::default(),
            &Cancellation::default(),
        )
        .unwrap();
    assert_eq!(receipt.outcome, Outcome::UnsupportedImportPolicy);
    assert_eq!(before, f::domain_state(&b.store));
    assert_eq!(b.count("import_events"), 0);
    assert_eq!(b.count("import_d4_commits"), 0);
    assert_eq!(
        b.store.query_i64_for_test(
            "SELECT count(*) FROM bootstrap_lifecycle WHERE state='unsupported'"
        ),
        1
    );
    drop(adapter);
    b.reopen();
}
#[test]
fn d4_14_mutable_provenance_tamper_is_rejected_before_publication() {
    let a = peer(A, B);
    let b = peer(B, A);
    let (project, _) = f::project_and_capture(&a.store, "Original", "child");
    f::rename_id(&a.store, &project, "New");
    let (snapshot, _, s) = capture(&a, &b, 4015);
    let mut image = decode(&snapshot.bytes).unwrap();
    let m = image
        .origin_metadata
        .iter_mut()
        .find(|m| m["kind"] == "facet")
        .unwrap();
    m["hash"] = serde_json::json!(hex(&[1; 32]));
    let bytes = canonical(&image).unwrap();
    let bad = SnapshotExport {
        offer: SnapshotOffer {
            id: snapshot.offer.id,
            hash: codec::journal_event_hash(&bytes),
            bytes: bytes.len(),
            chunks: bytes.len().div_ceil(CHUNK),
        },
        bytes,
    };
    let adapter = CandidateSyncStore::synthetic(&b.store);
    stage(&adapter, &s, &bad);
    let before = f::state(&b.store);
    assert_eq!(
        adapter
            .snapshot_publish(&s, &bad.offer, &Clock::default(), &Cancellation::default())
            .err(),
        Some(Error::Integrity)
    );
    assert_eq!(before, f::state(&b.store));
}
#[test]
fn d4_15_16_lifecycle_resume_restart_caps_and_retirement_fail_closed() {
    use crate::storage::bootstrap_store::{maintain, Maintenance};
    let a = peer(A, B);
    let b = peer(B, A);
    f::history(&a.store);
    let (snapshot, _, s) = capture(&a, &b, 4016);
    {
        let adapter = CandidateSyncStore::synthetic(&b.store);
        stage(&adapter, &s, &snapshot);
        maintain(
            &adapter,
            &s,
            &snapshot.offer,
            Maintenance::Interrupt,
            &Clock::default(),
            &Cancellation::default(),
        )
        .unwrap();
        maintain(
            &adapter,
            &s,
            &snapshot.offer,
            Maintenance::Expire,
            &Clock::default(),
            &Cancellation::default(),
        )
        .unwrap();
    }
    let b = b.reopen();
    let adapter = CandidateSyncStore::synthetic(&b.store);
    let before = f::state(&b.store);
    assert_eq!(
        maintain(
            &adapter,
            &s,
            &snapshot.offer,
            Maintenance::Retire,
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::ActivationPending)
    );
    assert_eq!(before, f::state(&b.store));
    assert!(crate::storage::sync_store::test_refuses(
        &b.store,
        "UPDATE bootstrap_lifecycle SET state='unknown'"
    ));
    stage(&adapter, &s, &snapshot);
    maintain(
        &adapter,
        &s,
        &snapshot.offer,
        Maintenance::Resume,
        &Clock::default(),
        &Cancellation::default(),
    )
    .unwrap();
    assert_eq!(
        adapter
            .snapshot_publish(
                &s,
                &snapshot.offer,
                &Clock::default(),
                &Cancellation::default()
            )
            .unwrap()
            .outcome,
        Outcome::CleanlyApplied
    );
    assert_eq!(
        maintain(
            &adapter,
            &s,
            &snapshot.offer,
            Maintenance::Expire,
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Storage)
    );
    assert_eq!(
        adapter
            .snapshot_publish(
                &s,
                &snapshot.offer,
                &Clock::default(),
                &Cancellation::default()
            )
            .unwrap()
            .outcome,
        Outcome::CleanlyApplied
    );
    assert!(crate::storage::sync_store::test_refuses(
        &b.store,
        "DELETE FROM bootstrap_chunks"
    ));
    assert!(crate::storage::sync_store::test_refuses(
        &b.store,
        "DELETE FROM bootstrap_units"
    ));
    for id in 4017..4020 {
        let mut offer = snapshot.offer.clone();
        offer.id = Uuid::from_u128(id);
        adapter
            .snapshot_offer(&s, &offer, &Clock::default(), &Cancellation::default())
            .unwrap();
    }
    let mut fifth = snapshot.offer.clone();
    fifth.id = Uuid::from_u128(4020);
    assert_eq!(
        adapter.snapshot_offer(&s, &fifth, &Clock::default(), &Cancellation::default()),
        Err(Error::StorageLimited)
    );
    assert_eq!(b.count("bootstrap_units"), 4);
    drop(adapter);
    b.reopen();
}
#[test]
fn d4_17_revocation_inside_capture_and_before_import_commit_rolls_back() {
    let a = peer(A, B);
    let b = peer(B, A);
    f::captures(&a.store, &["private body"]);
    let s = context(&a, &origins(&a, &b));
    a.store.execute_sql_for_test("CREATE TEMP TRIGGER revoke_capture AFTER INSERT ON bootstrap_units BEGIN UPDATE import_members SET enabled=0; END;");
    assert!(matches!(
        CandidateSyncStore::synthetic(&a.store).snapshot_capture(
            &s,
            Uuid::from_u128(4021),
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Trust)
    ));
    assert_eq!(a.count("bootstrap_units"), 0);
    b.store.execute_sql_for_test("CREATE TEMP TRIGGER revoke_import AFTER INSERT ON captures BEGIN UPDATE import_members SET enabled=0; END;");
    let s = context(&b, &origins(&a, &b));
    let before = f::state(&b.store);
    assert!(matches!(
        CandidateSyncStore::synthetic(&b.store).retain(
            &s,
            ValidatedEvent::parse(test_events(&a.store)[0].clone()).unwrap(),
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Trust)
    ));
    assert_eq!(before, f::state(&b.store));
    f::assert_insert_observers_frozen(&b.store);
}
#[test]
fn d4_18_invalid_observer_and_recursive_fanout_cannot_borrow_a_row_grant() {
    for corrupt_observer in [false, true] {
        let a = peer(A, B);
        let b = peer(B, A);
        f::captures(&a.store, &["exact authorized row"]);
        if corrupt_observer {
            b.store.execute_sql_for_test("DROP TRIGGER sync_observe_captures_insert; CREATE TRIGGER sync_observe_captures_insert AFTER INSERT ON captures BEGIN SELECT 1; END;");
        } else {
            b.store.execute_sql_for_test("CREATE TEMP TRIGGER recursive_fanout AFTER INSERT ON captures BEGIN INSERT INTO captures(id,source,content,created_at,project_id) VALUES('aaaaaaaa-2222-4222-8222-222222222222','text','unauthorized nested row',NEW.created_at,NEW.project_id); END;");
        }
        let s = context(&b, &origins(&a, &b));
        let before = f::state(&b.store);
        assert!(matches!(
            CandidateSyncStore::synthetic(&b.store).retain(
                &s,
                ValidatedEvent::parse(f::last_original(&a.store)).unwrap(),
                &Clock::default(),
                &Cancellation::default()
            ),
            Err(Error::Storage)
        ));
        assert_eq!(before, f::state(&b.store));
        assert_eq!(b.count("captures"), 0);
    }
}
#[test]
fn d4_19_enabled_recall_never_embeds_imported_selected_head_or_proposal() {
    use crate::recall::{
        settings::SemanticSettings,
        testing::{run, ConceptEmbedder},
        RecallService,
    };
    use std::sync::Arc;
    let a = peer(A, B);
    let b = peer(B, A);
    let (object, _, _, _) = f::open_proposal(&a.store);
    f::edit_id(&a.store, &object, "Selected foreign branch");
    transfer(&a, &b);
    let embedder = Arc::new(ConceptEmbedder::plain(64));
    let service = RecallService::new(
        embedder.clone(),
        Arc::new(SemanticSettings::new(b.dir.path().join("semantic.json"))),
    );
    service.settings().set(service.model_key(), true).unwrap();
    let report = run(service.index_pending(&b.store, 64)).unwrap();
    assert_eq!(report.embedded, 0);
    assert_eq!(report.remaining, Some(0));
    assert_eq!(embedder.request_count(), 0);
    assert_eq!(b.count("revision_proposals"), 1);
    assert_eq!(
        b.store
            .query_i64_for_test("SELECT count(*) FROM revision_proposals WHERE state='open'"),
        1
    );
    b.reopen();
}
#[test]
fn d4_20_publication_failure_rolls_back_expanded_rows_proofs_and_heads() {
    let a = peer(A, B);
    let b = peer(B, A);
    f::open_proposal(&a.store);
    let (snapshot, _, s) = capture(&a, &b, 4022);
    let adapter = CandidateSyncStore::synthetic(&b.store);
    stage(&adapter, &s, &snapshot);
    b.store.execute_sql_for_test("CREATE TEMP TRIGGER publication_fault BEFORE UPDATE OF outcome ON bootstrap_units WHEN NEW.outcome='applied' BEGIN SELECT RAISE(ABORT,'publication failure'); END;");
    let before = f::state(&b.store);
    assert_eq!(
        adapter
            .snapshot_publish(
                &s,
                &snapshot.offer,
                &Clock::default(),
                &Cancellation::default()
            )
            .err(),
        Some(Error::Storage)
    );
    assert_eq!(before, f::state(&b.store));
    assert_eq!(b.count("import_d4_commits"), 0);
    assert_eq!(b.count("pending_claims"), 0);
    b.store
        .execute_sql_for_test("DROP TRIGGER publication_fault;");
    assert_eq!(
        adapter
            .snapshot_publish(
                &s,
                &snapshot.offer,
                &Clock::default(),
                &Cancellation::default()
            )
            .unwrap()
            .outcome,
        Outcome::CleanlyApplied
    );
    drop(adapter);
    b.reopen();
}
#[test]
fn d4_22_stale_proposal_base_is_retained_without_disabling_historical_guard() {
    let a = peer(A, B);
    let b = peer(B, A);
    let (object, base, _, _) = f::open_proposal(&a.store);
    let proposal = f::last_original(&a.store);
    let all = test_events(&a.store);
    let s = context(&b, &origins(&a, &b));
    let adapter = CandidateSyncStore::synthetic(&b.store);
    for e in all.iter().filter(|e| e.identity != proposal.identity) {
        assert_eq!(receive(&adapter, &s, e).outcome, Outcome::CleanlyApplied);
    }
    f::edit_id(&b.store, &object, "Independent local head");
    assert_ne!(b.store.current_revision_id_of(&object).unwrap(), Some(base));
    let before = f::domain_state(&b.store);
    assert_eq!(
        receive(&adapter, &s, &proposal).outcome,
        Outcome::UnsupportedImportPolicy
    );
    assert_eq!(before, f::domain_state(&b.store));
    assert_eq!(b.count("revision_proposals"), 0);
    drop(adapter);
    b.reopen();
}
#[test]
fn d4_20_actual_commit_failure_returns_no_receipt_and_preserves_recovery_unit() {
    let a = peer(A, B);
    let b = peer(B, A);
    f::open_proposal(&a.store);
    let (snapshot, _, s) = capture(&a, &b, 4023);
    let adapter = CandidateSyncStore::synthetic(&b.store);
    stage(&adapter, &s, &snapshot);
    b.store.execute_sql_for_test("CREATE TABLE d4_commit_fault(id TEXT REFERENCES captures(id) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER commit_failure AFTER UPDATE OF outcome ON bootstrap_units WHEN NEW.outcome='applied' BEGIN INSERT INTO d4_commit_fault VALUES('missing'); END;");
    let before = f::state(&b.store);
    assert_eq!(
        adapter
            .snapshot_publish(
                &s,
                &snapshot.offer,
                &Clock::default(),
                &Cancellation::default()
            )
            .err(),
        Some(Error::Storage)
    );
    assert_eq!(before, f::state(&b.store));
    assert_eq!(b.count("import_events"), 0);
    assert_eq!(b.count("revision_proposals"), 0);
    assert!(matches!(
        adapter.summary(&s, &Clock::default(), &Cancellation::default()),
        Err(Error::Storage)
    ));
    drop(adapter);
    b.reopen();
}
#[test]
fn d4_17_membership_epoch_changes_between_offer_and_chunk_fail_closed() {
    let a = peer(A, B);
    let b = peer(B, A);
    f::captures(&a.store, &["Private manifest and body"]);
    let (snapshot, _, s) = capture(&a, &b, 4024);
    let adapter = CandidateSyncStore::synthetic(&b.store);
    adapter
        .snapshot_offer(
            &s,
            &snapshot.offer,
            &Clock::default(),
            &Cancellation::default(),
        )
        .unwrap();
    b.store.execute_sql_for_test(
        "UPDATE import_members SET epoch=2; UPDATE import_origin_permissions SET epoch=2;",
    );
    assert_eq!(
        adapter.snapshot_chunk(
            &s,
            &snapshot.chunks()[0],
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Trust)
    );
    let mut hello = b.hello(SESSION);
    hello.epoch = 2;
    let s2 = TestTrust {
        hello: hello.clone(),
        expires: 100,
        origins: origins(&a, &b),
    }
    .verify(&hello)
    .unwrap();
    assert_eq!(
        adapter.snapshot_chunk(
            &s2,
            &snapshot.chunks()[0],
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Trust)
    );
    assert_eq!(b.count("bootstrap_chunks"), 0);
    assert_eq!(b.count("captures"), 0);
    drop(adapter);
    b.reopen();
}

#[test]
fn d4_11_conflict_alternatives_cannot_disclose_a_revoked_local_origin() {
    let a = peer(A, B);
    let b = peer(B, A);
    let (project, _) = f::project_and_capture(&a.store, "Shared original", "child");
    transfer(&a, &b);
    f::rename_id(&a.store, &project, "A alternative");
    f::rename_id(&b.store, &project, "Private B alternative");
    let event = f::last_original(&a.store);
    let s = context(&b, &origins(&a, &b));
    assert_eq!(
        receive(&CandidateSyncStore::synthetic(&b.store), &s, &event).outcome,
        Outcome::ConflictRetained
    );
    let denied = context(
        &b,
        &test_events(&a.store)
            .iter()
            .map(|e| e.identity.origin)
            .collect(),
    );
    assert!(matches!(
        CandidateSyncStore::synthetic(&b.store).snapshot_capture(
            &denied,
            Uuid::from_u128(4025),
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Trust)
    ));
    assert!(matches!(
        CandidateSyncStore::synthetic(&b.store).summary(
            &denied,
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Trust)
    ));
    assert_eq!(b.count("bootstrap_units"), 0);
    assert_eq!(b.count("import_conflicts"), 1);
}
#[test]
fn d4_05_proposal_existing_evidence_requires_exact_original_source_span() {
    for (span, expected) in [
        ((0, 4), Outcome::CleanlyApplied),
        ((4, 8), Outcome::RejectedIntegrity),
    ] {
        let a = peer(A, B);
        let b = peer(B, A);
        f::open_proposal_with_evidence(&a.store, Some(span));
        let proposal = f::last_original(&a.store);
        let s = context(&b, &origins(&a, &b));
        let adapter = CandidateSyncStore::synthetic(&b.store);
        for e in test_events(&a.store)
            .iter()
            .filter(|e| e.identity != proposal.identity)
        {
            assert_eq!(receive(&adapter, &s, e).outcome, Outcome::CleanlyApplied);
        }
        assert_eq!(receive(&adapter, &s, &proposal).outcome, expected);
        assert_eq!(
            b.count("revision_proposals"),
            if expected == Outcome::CleanlyApplied {
                1
            } else {
                0
            }
        );
        drop(adapter);
        b.reopen();
    }
}
#[test]
fn d4_04_private_provider_payload_in_audit_is_never_materialized_or_forwarded() {
    let a = peer(A, B);
    let b = peer(B, A);
    f::open_proposal(&a.store);
    let events = test_events(&a.store);
    let s = context(&b, &origins(&a, &b));
    let adapter = CandidateSyncStore::synthetic(&b.store);
    for e in &events[..2] {
        assert_eq!(receive(&adapter, &s, e).outcome, Outcome::CleanlyApplied);
    }
    let mut core = ValidatedEvent::parse(events[2].clone())
        .unwrap()
        .core()
        .clone();
    for op in &mut core.operations {
        if let codec::Operation::RecordCreate(r) = op {
            if r.entity == codec::EntityKind::IdentityDecisions {
                r.after.insert(
                    "audit_json".into(),
                    codec::FieldValue::Text(
                        "{\"providerResponse\":\"private raw response\"}".into(),
                    ),
                );
            }
        }
    }
    let bytes = codec::encode_canonical(&core).unwrap();
    let bad = envelope(bytes).unwrap();
    assert_eq!(
        receive(&adapter, &s, &bad).outcome,
        Outcome::RejectedIntegrity
    );
    assert_eq!(b.count("identity_decisions"), 0);
    assert_eq!(b.count("pending_claims"), 0);
    assert!(matches!(
        adapter.export(
            &s,
            &bad.identity,
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Integrity)
    ));
    assert!(matches!(
        adapter.snapshot_capture(
            &s,
            Uuid::from_u128(4026),
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Integrity)
    ));
    assert_eq!(b.count("bootstrap_units"), 0);
    drop(adapter);
    b.reopen();
}

#[test]
fn d4_07_empty_project_archive_restore_chain_is_causal() {
    let a = peer(A, B);
    let b = peer(B, A);
    let project = f::project_only(&a.store, "Empty lifecycle");
    transfer(&a, &b);
    f::archive_id(&a.store, &project, false);
    transfer(&a, &b);
    assert_eq!(
        b.store.query_i64_for_test(&format!(
            "SELECT count(*) FROM projects WHERE id='{project}' AND archived_at IS NOT NULL"
        )),
        1
    );
    f::archive_id(&a.store, &project, true);
    transfer(&a, &b);
    assert_eq!(
        b.store.query_i64_for_test(&format!(
            "SELECT count(*) FROM projects WHERE id='{project}' AND archived_at IS NULL"
        )),
        1
    );
    b.reopen();
}
#[test]
fn d4_08_name_collision_and_move_into_concurrently_archived_project_are_conflicts() {
    let a = peer(A, B);
    let b = peer(B, A);
    let (project, cap) = f::project_and_capture(&a.store, "Original", "child");
    let target = f::project_only(&a.store, "Move destination");
    transfer(&a, &b);
    f::project_only(&b.store, "Concurrent name");
    f::rename_id(&a.store, &project, "Concurrent name");
    let s = context(&b, &origins(&a, &b));
    let adapter = CandidateSyncStore::synthetic(&b.store);
    assert_eq!(
        receive(&adapter, &s, &f::last_original(&a.store)).outcome,
        Outcome::ConflictRetained
    );
    f::archive_id(&b.store, &target, false);
    f::move_capture_id(&a.store, &cap, &target);
    let s = context(&b, &origins(&a, &b));
    assert_eq!(
        receive(&adapter, &s, &f::last_original(&a.store)).outcome,
        Outcome::ConflictRetained
    );
    assert_eq!(
        b.store.query_i64_for_test(&format!(
            "SELECT count(*) FROM captures WHERE id='{cap}' AND project_id='{project}'"
        )),
        1
    );
    assert_eq!(b.count("import_conflicts"), 2);
    drop(adapter);
    b.reopen();
}
