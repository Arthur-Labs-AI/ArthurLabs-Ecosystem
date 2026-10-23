use super::*;
use crate::sync::bootstrap::*;
fn bare(id: Uuid, other: Uuid) -> Peer {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let store = CaptureStore::open_owned(DataRootOwnership::try_acquire(&root).unwrap()).unwrap();
    f::upgrade(&store);
    install_candidate(&store, NETWORK, id, &[(other, 1)]).unwrap();
    f::install_g3(&store);
    f::install_history(&store);
    Peer {
        dir,
        store,
        id,
        other,
    }
}
#[test]
fn d3_01_02_03_07_19_initial_history_empty_completion_branch_and_reopen() {
    let a = bare(A, B);
    let b = bare(B, A);
    let (_, object, root) = f::history(&a.store);
    let allowed = origins(&a, &b);
    let s = context(&b, &allowed);
    let adapter = CandidateSyncStore::synthetic(&b.store);
    for e in test_events(&a.store) {
        assert_eq!(receive(&adapter, &s, &e).outcome, Outcome::CleanlyApplied);
    }
    assert_eq!(b.count("distillation_runs"), 2);
    assert_eq!(b.count("knowledge_objects"), 1);
    assert_eq!(b.count("object_sources"), 1);
    assert_eq!(b.count("thought_revisions"), 2);
    assert_eq!(b.count("revision_parents"), 1);
    assert_eq!(
        b.store.current_revision_id_of(&object).unwrap().as_deref(),
        Some(root.as_str())
    );
    assert_eq!(b.count("sync_bundles"), 0);
    drop(adapter);
    let b = b.reopen();
    f::captures(&b.store, &["local continuation"]);
    b.reopen();
}
#[test]
fn d3_08_09_10_13_bootstrap_local_foreign_history_and_tail_union() {
    let a = bare(A, B);
    let b = bare(B, A);
    f::captures(&a.store, &["A original"]);
    f::captures(&b.store, &["B original"]);
    let allowed = origins(&a, &b);
    {
        let sa = CandidateSyncStore::synthetic(&a.store);
        let sb = CandidateSyncStore::synthetic(&b.store);
        receive(&sa, &context(&a, &allowed), &test_events(&b.store)[0]);
        receive(&sb, &context(&b, &allowed), &test_events(&a.store)[0]);
    }
    f::history(&a.store);
    let allowed = origins(&a, &b);
    let sa = CandidateSyncStore::synthetic(&a.store);
    let sb = CandidateSyncStore::synthetic(&b.store);
    let c = Clock::default();
    let x = Cancellation::default();
    let ca = context(&a, &allowed);
    let cb = context(&b, &allowed);
    let id = Uuid::from_u128(800);
    let snap = sa.snapshot_capture(&ca, id, &c, &x).unwrap();
    let decoded = decode(&snap.bytes).unwrap();
    assert!(decoded
        .cores
        .iter()
        .any(|e| e.materialized && e.outcome == "applied"));
    assert_eq!(decoded.cores.len(), test_events(&a.store).len());
    f::captures(&a.store, &["after boundary"]);
    let (ta, tb, _) = FakeTransport::pair(a.hello(SESSION), b.hello(SESSION));
    let mut ea = SyncEngine::start(&sa, ta, &a.trust(SESSION, &allowed), &c, &x).unwrap();
    let mut eb = SyncEngine::start(&sb, tb, &b.trust(SESSION, &allowed), &c, &x).unwrap();
    ea.bootstrap(id).unwrap();
    pump(&mut ea, &mut eb);
    assert_eq!(b.count("knowledge_objects"), 1);
    assert_eq!(b.count("captures"), 5);
    assert_eq!(
        b.store.query_i64_for_test(
            "SELECT count(*) FROM bootstrap_units WHERE direction='in' AND outcome='applied'"
        ),
        1
    );
    assert_eq!(
        a.store.query_i64_for_test(
            "SELECT count(*) FROM bootstrap_units WHERE direction='out' AND outcome='applied'"
        ),
        1
    );
    let _ = cb;
    drop(ea);
    drop(eb);
    drop(sa);
    drop(sb);
    a.reopen();
    b.reopen();
}

fn capture(a: &Peer, b: &Peer, id: u128) -> (SnapshotExport, VerifiedSession, VerifiedSession) {
    let allowed = origins(a, b);
    let sa = context(a, &allowed);
    let sb = context(b, &allowed);
    let export = CandidateSyncStore::synthetic(&a.store)
        .snapshot_capture(
            &sa,
            Uuid::from_u128(id),
            &Clock::default(),
            &Cancellation::default(),
        )
        .unwrap();
    (export, sa, sb)
}
fn stage(store: &CandidateSyncStore<'_>, s: &VerifiedSession, snapshot: &SnapshotExport) {
    store
        .snapshot_offer(
            s,
            &snapshot.offer,
            &Clock::default(),
            &Cancellation::default(),
        )
        .unwrap();
    for ch in snapshot.chunks() {
        store
            .snapshot_chunk(s, &ch, &Clock::default(), &Cancellation::default())
            .unwrap();
    }
}
#[test]
fn d3_03_18_evidence_and_enabled_recall_spy_do_not_execute_providers() {
    use crate::recall::{
        settings::SemanticSettings,
        testing::{run, ConceptEmbedder},
        RecallService,
    };
    use std::sync::Arc;
    let a = bare(A, B);
    let b = bare(B, A);
    let (cap, object, root) = f::history(&a.store);
    let branch = f::evidenced_branch(&a.store, &cap, &object, &root);
    let (snapshot, _, s) = capture(&a, &b, 901);
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
    assert_eq!(b.count("revision_evidence"), 1);
    assert_eq!(b.count("thought_revisions"), 3);
    assert_eq!(b.store.revision_evidence(&branch).unwrap().len(), 1);
    assert_eq!(b.count("import_recall_suppression"), 1);
    let embedder = Arc::new(ConceptEmbedder::plain(64));
    let settings = Arc::new(SemanticSettings::new(b.dir.path().join("semantic.json")));
    let service = RecallService::new(embedder.clone(), settings);
    service.settings().set(service.model_key(), true).unwrap();
    let report = run(service.index_pending(&b.store, 64)).unwrap();
    assert_eq!(report.embedded, 0);
    assert_eq!(report.remaining, Some(0));
    assert_eq!(embedder.request_count(), 0);
    assert_eq!(b.count("revision_proposals"), 0);
    drop(adapter);
    b.reopen();
}
#[test]
fn d3_11_12_chunks_resume_reordered_duplicates_and_tamper_never_partially_publish() {
    let a = bare(A, B);
    let b = bare(B, A);
    let body = "X".repeat(20_000);
    f::captures(&a.store, &vec![body.as_str(); 6]);
    let (snapshot, _, s) = capture(&a, &b, 902);
    let chunks = snapshot.chunks();
    assert!(chunks.len() > 1);
    {
        let adapter = CandidateSyncStore::synthetic(&b.store);
        adapter
            .snapshot_offer(
                &s,
                &snapshot.offer,
                &Clock::default(),
                &Cancellation::default(),
            )
            .unwrap();
        adapter
            .snapshot_chunk(&s, &chunks[1], &Clock::default(), &Cancellation::default())
            .unwrap();
        adapter
            .snapshot_chunk(&s, &chunks[1], &Clock::default(), &Cancellation::default())
            .unwrap();
        assert_eq!(b.count("bootstrap_chunks"), 1);
        assert_eq!(
            adapter
                .snapshot_publish(
                    &s,
                    &snapshot.offer,
                    &Clock::default(),
                    &Cancellation::default()
                )
                .err(),
            Some(Error::Integrity)
        );
        assert_eq!(b.count("captures"), 0);
        let mut changed = chunks[1].clone();
        changed.bytes[0] ^= 1;
        changed.hash = codec::journal_event_hash(&changed.bytes);
        assert_eq!(
            adapter.snapshot_chunk(&s, &changed, &Clock::default(), &Cancellation::default()),
            Err(Error::Integrity)
        );
        assert_eq!(b.count("bootstrap_chunks"), 1);
    }
    let b = b.reopen();
    let adapter = CandidateSyncStore::synthetic(&b.store);
    let mut changed = snapshot.offer.clone();
    changed.hash[0] ^= 1;
    assert_eq!(
        adapter.snapshot_offer(&s, &changed, &Clock::default(), &Cancellation::default()),
        Err(Error::Integrity)
    );
    for ch in chunks.iter().rev() {
        adapter
            .snapshot_chunk(&s, ch, &Clock::default(), &Cancellation::default())
            .unwrap();
        assert_eq!(b.count("captures"), 0);
    }
    let result = adapter
        .snapshot_publish(
            &s,
            &snapshot.offer,
            &Clock::default(),
            &Cancellation::default(),
        )
        .unwrap();
    assert_eq!(result.outcome, Outcome::CleanlyApplied);
    assert_eq!(b.count("captures"), 6);
    assert_eq!(b.count("import_events"), 6);
    assert_eq!(b.count("sync_bundles"), 0);
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
    assert_eq!(b.count("captures"), 6);
    drop(adapter);
    b.reopen();
    // Changed bytes plus a matching chunk digest still fail the immutable root.
    let b = bare(B, A);
    let s = context(&b, &origins(&a, &b));
    let adapter = CandidateSyncStore::synthetic(&b.store);
    adapter
        .snapshot_offer(
            &s,
            &snapshot.offer,
            &Clock::default(),
            &Cancellation::default(),
        )
        .unwrap();
    let mut changed = snapshot.chunks();
    changed[0].bytes[0] ^= 1;
    changed[0].hash = codec::journal_event_hash(&changed[0].bytes);
    for ch in changed {
        adapter
            .snapshot_chunk(&s, &ch, &Clock::default(), &Cancellation::default())
            .unwrap();
    }
    assert_eq!(
        adapter
            .snapshot_publish(
                &s,
                &snapshot.offer,
                &Clock::default(),
                &Cancellation::default()
            )
            .err(),
        Some(Error::Integrity)
    );
    assert_eq!(b.count("captures"), 0);
    assert_eq!(b.count("import_events"), 0);
}
#[test]
fn d3_15_20_authorization_storage_and_oversize_limits_preserve_originals() {
    let a = bare(A, B);
    let b = bare(B, A);
    f::captures(&a.store, &["private"]);
    let (snapshot, _, s) = capture(&a, &b, 903);
    let adapter = CandidateSyncStore::synthetic(&b.store);
    adapter
        .snapshot_offer(
            &s,
            &snapshot.offer,
            &Clock::default(),
            &Cancellation::default(),
        )
        .unwrap();
    b.store
        .execute_sql_for_test("UPDATE import_members SET enabled=0");
    assert_eq!(
        adapter.snapshot_chunk(
            &s,
            &snapshot.chunks()[0],
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::Trust)
    );
    assert_eq!(b.count("bootstrap_chunks"), 0);
    b.store
        .execute_sql_for_test("UPDATE import_members SET enabled=1");
    let cancel = Cancellation::default();
    cancel.cancel();
    assert_eq!(
        adapter.snapshot_chunk(&s, &snapshot.chunks()[0], &Clock::default(), &cancel),
        Err(Error::Cancelled)
    );
    assert_eq!(b.count("captures"), 0);
    for n in 904..907 {
        let mut offer = snapshot.offer.clone();
        offer.id = Uuid::from_u128(n);
        adapter
            .snapshot_offer(&s, &offer, &Clock::default(), &Cancellation::default())
            .unwrap();
    }
    let mut fifth = snapshot.offer.clone();
    fifth.id = Uuid::from_u128(907);
    assert_eq!(
        adapter.snapshot_offer(&s, &fifth, &Clock::default(), &Cancellation::default()),
        Err(Error::StorageLimited)
    );
    assert_eq!(b.count("bootstrap_units"), 4);
    assert_eq!(b.count("captures"), 0);
    let a = bare(A, B);
    let b = bare(B, A);
    f::captures(&a.store, &vec!["source history"; 65]);
    let s = context(&a, &origins(&a, &b));
    assert!(matches!(
        CandidateSyncStore::synthetic(&a.store).snapshot_capture(
            &s,
            Uuid::from_u128(908),
            &Clock::default(),
            &Cancellation::default()
        ),
        Err(Error::SnapshotTooLarge)
    ));
    assert_eq!(a.count("captures"), 65);
    assert_eq!(a.count("sync_bundles"), 65);
    assert_eq!(a.count("bootstrap_units"), 0);
}
#[test]
fn d3_16_publication_sql_failure_rolls_back_domain_ledger_heads_and_progress() {
    let a = bare(A, B);
    let b = bare(B, A);
    f::history(&a.store);
    let (snapshot, _, s) = capture(&a, &b, 909);
    let adapter = CandidateSyncStore::synthetic(&b.store);
    stage(&adapter, &s, &snapshot);
    b.store.execute_sql_for_test("CREATE TEMP TRIGGER bootstrap_fault BEFORE UPDATE OF outcome ON bootstrap_units WHEN NEW.outcome='applied' BEGIN SELECT RAISE(ABORT,'late publication failure');END;");
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
    assert_eq!(b.count("captures"), 0);
    assert_eq!(b.count("import_events"), 0);
    assert_eq!(b.count("import_g3_commits"), 0);
    f::assert_insert_observers_frozen(&b.store);
    b.store.execute_sql_for_test("DROP TRIGGER bootstrap_fault");
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
fn d3_15_forged_manifest_origin_network_and_ack_are_rejected() {
    let a = bare(A, B);
    let b = bare(B, A);
    f::captures(&a.store, &["bound origin"]);
    let (snapshot, sa, sb) = capture(&a, &b, 910);
    let adapter = CandidateSyncStore::synthetic(&b.store);
    let mut image = decode(&snapshot.bytes).unwrap();
    image.network = Uuid::from_u128(999).to_string();
    let bytes = canonical(&image).unwrap();
    let wrong = SnapshotExport {
        offer: SnapshotOffer {
            id: snapshot.offer.id,
            hash: codec::journal_event_hash(&bytes),
            bytes: bytes.len(),
            chunks: bytes.len().div_ceil(CHUNK),
        },
        bytes,
    };
    stage(&adapter, &sb, &wrong);
    assert_eq!(
        adapter
            .snapshot_publish(
                &sb,
                &wrong.offer,
                &Clock::default(),
                &Cancellation::default()
            )
            .err(),
        Some(Error::Trust)
    );
    assert_eq!(b.count("captures"), 0);
    let source = CandidateSyncStore::synthetic(&a.store);
    let mut receipt = SnapshotReceipt {
        offer: snapshot.offer.clone(),
        outcome: Outcome::CleanlyApplied,
    };
    receipt.offer.hash[0] ^= 1;
    assert_eq!(
        source.snapshot_receipt(&sa, &receipt, &Clock::default(), &Cancellation::default()),
        Err(Error::Integrity)
    );
    assert_eq!(
        a.store
            .query_i64_for_test("SELECT count(*) FROM bootstrap_units WHERE outcome='applied'"),
        0
    );
    let b = bare(B, A);
    let sb = context(&b, &origins(&a, &b));
    let mut image = decode(&snapshot.bytes).unwrap();
    let mut core = codec::decode_core_strict(&unhex(&image.cores[0].bytes).unwrap()).unwrap();
    core.origin_id = Uuid::from_u128(5555).to_string();
    image.cores[0].bytes = hex(&codec::encode_canonical(&core).unwrap());
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
    stage(&adapter, &sb, &forged);
    assert_eq!(
        adapter
            .snapshot_publish(
                &sb,
                &forged.offer,
                &Clock::default(),
                &Cancellation::default()
            )
            .err(),
        Some(Error::Trust)
    );
    assert_eq!(b.count("captures"), 0);
}
#[test]
fn d3_04_05_06_unsupported_families_and_conflicts_are_not_partial_materialization() {
    let a = bare(A, B);
    let b = bare(B, A);
    f::review_history(&a.store);
    let s = context(&b, &origins(&a, &b));
    let adapter = CandidateSyncStore::synthetic(&b.store);
    let mut outcomes = Vec::new();
    for e in test_events(&a.store) {
        outcomes.push(receive(&adapter, &s, &e).outcome)
    }
    assert_eq!(b.count("knowledge_objects"), 1);
    assert_eq!(b.count("identity_decisions"), 0);
    assert_eq!(b.count("pending_claims"), 0);
    assert_eq!(b.count("revision_proposals"), 0);
    assert!(outcomes.contains(&Outcome::UnsupportedImportPolicy));
    assert!(outcomes.contains(&Outcome::DeferredDependency));
    // Archive and terminal review conflicts retain all original alternatives.
    let a = Peer::graph(A, B);
    let b = Peer::graph(B, A);
    f::install_g3(&b.store);
    f::install_history(&b.store);
    f::review_shared(&a.store, true);
    f::review_shared(&b.store, false);
    let s = context(&b, &origins(&a, &b));
    let before = f::domain_state(&b.store);
    let r = receive(
        &CandidateSyncStore::synthetic(&b.store),
        &s,
        &test_events(&a.store)[0],
    );
    assert_eq!(r.outcome, Outcome::ConflictRetained);
    assert_eq!(before, f::domain_state(&b.store));
    assert!(b.count("import_conflicts") > 0);
}

#[test]
fn d3_07_19_held_kernel_local_object_edit_references_foreign_original_after_bootstrap() {
    let a = bare(A, B);
    let b = bare(B, A);
    let (_, object, _) = f::history(&a.store);
    let (snapshot, _, s) = capture(&a, &b, 920);
    let adapter = CandidateSyncStore::synthetic(&b.store);
    stage(&adapter, &s, &snapshot);
    f::held_object_kernel_continues(&b.store, &object, || {
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
        )
    });
    let local = test_events(&b.store);
    assert_eq!(local.len(), 6);
    let edit = local
        .iter()
        .find(|e| e.identity.origin != test_events(&a.store)[0].identity.origin)
        .unwrap();
    let core = ValidatedEvent::parse(edit.clone()).unwrap();
    assert!(core.core().dependencies.iter().any(|d| d
        .event_ref
        .as_ref()
        .is_some_and(|r| r.origin_id != edit.identity.origin.to_string())));
    assert_eq!(b.count("sync_bundles"), 1);
    assert_eq!(b.count("thought_revisions"), 3);
    drop(adapter);
    let b = b.reopen();
    f::captures(&b.store, &["continued after reopen"]);
    b.reopen();
}
#[test]
fn d3_14_lost_bootstrap_ack_repeated_offer_and_new_session_are_idempotent() {
    let a = bare(A, B);
    let b = bare(B, A);
    f::history(&a.store);
    let allowed = origins(&a, &b);
    let sa = CandidateSyncStore::synthetic(&a.store);
    let sb = CandidateSyncStore::synthetic(&b.store);
    let clock = Clock::default();
    let cancel = Cancellation::default();
    let id = Uuid::from_u128(921);
    {
        let (ta, tb, link) = FakeTransport::pair(a.hello(SESSION), b.hello(SESSION));
        link.borrow_mut().lose_receipt = 1;
        let mut ea =
            SyncEngine::start(&sa, ta, &a.trust(SESSION, &allowed), &clock, &cancel).unwrap();
        let mut eb =
            SyncEngine::start(&sb, tb, &b.trust(SESSION, &allowed), &clock, &cancel).unwrap();
        ea.bootstrap(id).unwrap();
        pump(&mut ea, &mut eb);
        assert_eq!(b.count("knowledge_objects"), 1);
        assert_eq!(
            a.store.query_i64_for_test(
                "SELECT count(*) FROM bootstrap_units WHERE direction='out' AND outcome='staged'"
            ),
            1
        );
    }
    let next = Uuid::from_u128(922);
    {
        let (ta, tb, _) = FakeTransport::pair(a.hello(next), b.hello(next));
        let mut ea = SyncEngine::start(&sa, ta, &a.trust(next, &allowed), &clock, &cancel).unwrap();
        let mut eb = SyncEngine::start(&sb, tb, &b.trust(next, &allowed), &clock, &cancel).unwrap();
        ea.bootstrap(id).unwrap();
        pump(&mut ea, &mut eb);
        ea.bootstrap(id).unwrap();
        pump(&mut ea, &mut eb);
    }
    assert_eq!(
        a.store
            .query_i64_for_test("SELECT count(*) FROM bootstrap_units WHERE outcome='applied'"),
        1
    );
    assert_eq!(b.count("knowledge_objects"), 1);
    assert_eq!(b.count("import_events"), 5);
    assert_eq!(b.count("sync_bundles"), 0);
    let old = context(&a, &allowed);
    let snapshot = sa
        .snapshot_capture(
            &a.trust(next, &allowed).verify(&a.hello(next)).unwrap(),
            id,
            &clock,
            &cancel,
        )
        .unwrap();
    assert_eq!(
        sa.snapshot_receipt(
            &old,
            &SnapshotReceipt {
                offer: snapshot.offer,
                outcome: Outcome::CleanlyApplied
            },
            &clock,
            &cancel
        ),
        Err(Error::Integrity)
    );
    drop(sa);
    drop(sb);
    a.reopen();
    b.reopen();
}
#[test]
fn d3_06_semantically_duplicate_user_relations_remain_owned_and_blocked() {
    let a = bare(A, B);
    let b = bare(B, A);
    let (_, one, _) = f::history(&a.store);
    let (_, two, _) = f::history(&a.store);
    let allowed = origins(&a, &b);
    let s = context(&b, &allowed);
    let adapter = CandidateSyncStore::synthetic(&b.store);
    for e in test_events(&a.store) {
        assert_eq!(receive(&adapter, &s, &e).outcome, Outcome::CleanlyApplied)
    }
    let aid = f::relation(&a.store, &one, &two);
    let bid = f::relation(&b.store, &one, &two);
    assert_ne!(aid, bid);
    let s = context(&b, &origins(&a, &b));
    let before = f::domain_state(&b.store);
    let original = test_events(&a.store)
        .into_iter()
        .find(|e| {
            ValidatedEvent::parse(e.clone())
                .unwrap()
                .core()
                .operations
                .iter()
                .any(|op| op.entity() == codec::EntityKind::Relations)
        })
        .unwrap();
    let outcome = receive(&adapter, &s, &original).outcome;
    assert_eq!(outcome, Outcome::UnsupportedImportPolicy);
    assert_eq!(f::domain_state(&b.store), before);
    assert_eq!(b.count("relations"), 1);
    assert_eq!(b.store.list_relations().unwrap()[0].id, bid);
    assert_eq!(b.store.list_relations().unwrap()[0].origin, "user");
    drop(adapter);
    b.reopen();
}
#[test]
fn d3_05_19_conflicted_source_bootstrap_preserves_alternatives_without_partial_publication() {
    let a = Peer::graph(A, B);
    let b = Peer::graph(B, A);
    f::install_g3(&a.store);
    f::install_history(&a.store);
    f::install_g3(&b.store);
    f::install_history(&b.store);
    f::review_shared(&a.store, true);
    f::review_shared(&b.store, false);
    let s = context(&b, &origins(&a, &b));
    assert_eq!(
        receive(
            &CandidateSyncStore::synthetic(&b.store),
            &s,
            &test_events(&a.store)[0]
        )
        .outcome,
        Outcome::ConflictRetained
    );
    let receiver = Peer::graph(A, B);
    f::install_g3(&receiver.store);
    f::install_history(&receiver.store);
    let (snapshot, _, s) = capture(&b, &receiver, 923);
    assert!(!decode(&snapshot.bytes).unwrap().conflicts.is_empty());
    let adapter = CandidateSyncStore::synthetic(&receiver.store);
    stage(&adapter, &s, &snapshot);
    let before = f::domain_state(&receiver.store);
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
        Outcome::ConflictRetained
    );
    assert_eq!(before, f::domain_state(&receiver.store));
    assert_eq!(receiver.count("import_events"), 0);
    assert!(
        adapter
            .summary(&s, &Clock::default(), &Cancellation::default())
            .unwrap()
            .needs_attention
    );
    drop(adapter);
    let receiver = receiver.reopen();
    let s = context(&receiver, &origins(&b, &receiver));
    assert!(
        CandidateSyncStore::synthetic(&receiver.store)
            .summary(&s, &Clock::default(), &Cancellation::default())
            .unwrap()
            .needs_attention
    );
}
#[test]
fn d3_16_17_actual_commit_failure_poisoning_and_new_entity_fanout_have_no_ack() {
    let a = bare(A, B);
    let b = bare(B, A);
    f::history(&a.store);
    let (snapshot, _, s) = capture(&a, &b, 924);
    let adapter = CandidateSyncStore::synthetic(&b.store);
    stage(&adapter, &s, &snapshot);
    b.store.execute_sql_for_test("CREATE TABLE d3_deferred(peer TEXT REFERENCES import_members(peer) DEFERRABLE INITIALLY DEFERRED);CREATE TEMP TRIGGER d3_commit AFTER UPDATE OF outcome ON bootstrap_units WHEN NEW.outcome='applied' BEGIN INSERT INTO d3_deferred VALUES('absent');END;");
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
    assert_eq!(f::state(&b.store), before);
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
    drop(adapter);
    b.reopen();
    let b = bare(B, A);
    let s = context(&b, &origins(&a, &b));
    let adapter = CandidateSyncStore::synthetic(&b.store);
    stage(&adapter, &s, &snapshot);
    b.store.execute_sql_for_test("CREATE TEMP TRIGGER d3_fanout AFTER INSERT ON distillation_runs BEGIN INSERT INTO captures(id,source,content,created_at,project_id) VALUES('bbbbbbbb-1111-4111-8111-111111111111','text','forged history fanout','2026-10-23T00:00:00Z','00000000-0000-4000-8000-000000000001');END;");
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
    assert_eq!(f::state(&b.store), before);
    assert_eq!(b.count("knowledge_objects"), 0);
    f::assert_insert_observers_frozen(&b.store);
}

#[test]
fn d3_17_observer_restoration_failure_revokes_capability_and_rolls_back_snapshot() {
    let a = bare(A, B);
    let b = bare(B, A);
    f::history(&a.store);
    let (snapshot, _, s) = capture(&a, &b, 925);
    let adapter = CandidateSyncStore::synthetic(&b.store);
    stage(&adapter, &s, &snapshot);
    let before = f::state(&b.store);
    assert_eq!(
        f::deny_revision_observer_restore(&b.store, || {
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
        }),
        2
    );
    assert_eq!(before, f::state(&b.store));
    f::assert_insert_observers_frozen(&b.store);
    assert!(crate::storage::sync_store::test_refuses(
        &b.store,
        "SELECT arthur_g3_row('captures','{}',NULL)"
    ));
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
fn d3_04_05_archived_children_and_concurrent_selected_heads_remain_explicitly_blocked() {
    let a = Peer::new(A, B);
    let b = Peer::new(B, A);
    f::install_g3(&b.store);
    f::install_history(&b.store);
    f::project_capture(&a.store);
    f::archive(&b.store);
    let s = context(&b, &origins(&a, &b));
    let before = f::domain_state(&b.store);
    assert_eq!(
        receive(
            &CandidateSyncStore::synthetic(&b.store),
            &s,
            &test_events(&a.store)[0]
        )
        .outcome,
        Outcome::ConflictRetained
    );
    assert_eq!(before, f::domain_state(&b.store));
    assert_eq!(b.count("captures"), 0);
    let a = Peer::graph(A, B);
    let b = Peer::graph(B, A);
    f::install_g3(&b.store);
    f::install_history(&b.store);
    f::edit_shared(&a.store, "A selected head");
    f::edit_shared(&b.store, "B selected head");
    let s = context(&b, &origins(&a, &b));
    let before = f::domain_state(&b.store);
    assert_eq!(
        receive(
            &CandidateSyncStore::synthetic(&b.store),
            &s,
            &test_events(&a.store)[0]
        )
        .outcome,
        Outcome::ConflictRetained
    );
    assert_eq!(before, f::domain_state(&b.store));
    assert!(b.count("import_conflicts") > 0);
    b.reopen();
}
#[test]
fn d3_15_noncanonical_manifest_and_minted_legacy_provenance_cannot_publish() {
    let a = Peer::new(A, B);
    let b = bare(B, A);
    f::install_g3(&a.store);
    f::install_history(&a.store);
    f::captures(
        &a.store,
        &["Supported core alongside unattested legacy project"],
    );
    let (snapshot, _, s) = capture(&a, &b, 926);
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
        Outcome::UnsupportedImportPolicy
    );
    assert_eq!(b.count("captures"), 0);
    assert_eq!(b.count("import_events"), 0);
    let mut image = decode(&snapshot.bytes).unwrap();
    image.id = Uuid::from_u128(927).to_string();
    for row in &mut image.rows {
        row.provenance = "m05".into();
    }
    let bytes = canonical(&image).unwrap();
    let forged = SnapshotExport {
        offer: SnapshotOffer {
            id: Uuid::from_u128(927),
            hash: codec::journal_event_hash(&bytes),
            bytes: bytes.len(),
            chunks: bytes.len().div_ceil(CHUNK),
        },
        bytes,
    };
    stage(&adapter, &s, &forged);
    assert_eq!(
        adapter
            .snapshot_publish(
                &s,
                &forged.offer,
                &Clock::default(),
                &Cancellation::default()
            )
            .err(),
        Some(Error::Integrity)
    );
    assert_eq!(b.count("captures"), 0);
    let a = bare(A, B);
    f::captures(&a.store, &["Canonical only"]);
    let (snapshot, _, s) = capture(&a, &b, 928);
    let mut bytes = snapshot.bytes.clone();
    bytes.insert(0, b' ');
    let wrong = SnapshotExport {
        offer: SnapshotOffer {
            id: snapshot.offer.id,
            hash: codec::journal_event_hash(&bytes),
            bytes: bytes.len(),
            chunks: bytes.len().div_ceil(CHUNK),
        },
        bytes,
    };
    stage(&adapter, &s, &wrong);
    assert_eq!(
        adapter
            .snapshot_publish(
                &s,
                &wrong.offer,
                &Clock::default(),
                &Cancellation::default()
            )
            .err(),
        Some(Error::Integrity)
    );
    assert_eq!(b.count("captures"), 0);
}

#[test]
fn d3_15_disclosure_rechecks_revocation_between_offer_and_chunk() {
    struct RevokeAfterOffer<'a> {
        inner: FakeTransport,
        source: &'a CaptureStore,
    }
    impl AuthenticatedTransport for RevokeAfterOffer<'_> {
        fn hello(&self) -> PeerHello {
            self.inner.hello()
        }
        fn receive(&mut self) -> Result<Option<Message>> {
            self.inner.receive()
        }
        fn send(&mut self, m: Message) -> Result<()> {
            let offered = matches!(m.payload, Payload::SnapshotOffer(_));
            self.inner.send(m)?;
            if offered {
                self.source
                    .execute_sql_for_test("UPDATE import_members SET enabled=0");
            }
            Ok(())
        }
    }
    let a = bare(A, B);
    let b = bare(B, A);
    f::captures(&a.store, &["Secret chunk body"]);
    let allowed = origins(&a, &b);
    let sa = CandidateSyncStore::synthetic(&a.store);
    let sb = CandidateSyncStore::synthetic(&b.store);
    let clock = Clock::default();
    let cancel = Cancellation::default();
    let (ta, tb, link) = FakeTransport::pair(a.hello(SESSION), b.hello(SESSION));
    let mut ea = SyncEngine::start(
        &sa,
        RevokeAfterOffer {
            inner: ta,
            source: &a.store,
        },
        &a.trust(SESSION, &allowed),
        &clock,
        &cancel,
    )
    .unwrap();
    let _eb = SyncEngine::start(&sb, tb, &b.trust(SESSION, &allowed), &clock, &cancel).unwrap();
    ea.bootstrap(Uuid::from_u128(929)).unwrap();
    assert_eq!(ea.tick(), Err(Error::Trust));
    assert_eq!(ea.status, SyncStatus::RejectedTrust);
    assert!(link.borrow().queues[1]
        .iter()
        .any(|m| matches!(m.payload, Payload::SnapshotOffer(_))));
    assert!(!link.borrow().queues[1].iter().any(|m| matches!(
        m.payload,
        Payload::SnapshotChunk(_) | Payload::SnapshotPublish(_) | Payload::Summary(_)
    )));
    assert_eq!(b.count("captures"), 0);
}
