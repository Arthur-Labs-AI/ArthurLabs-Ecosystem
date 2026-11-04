//! R9 real Windows CNG/TLS/owner integration; synthetic knowledge/registry.
use super::*;
use crate::sync_api::bootstrap::*;
use crate::sync_api::signed_bootstrap::{SignedManifest, SIGNED_BOOTSTRAP_PROFILE};

fn capture(lab: &Lab, id: Uuid) -> SignedSnapshotExport {
    let owner = lab.a.owner();
    SignedImportStore::synthetic_history(owner.store())
        .signed_snapshot_capture(
            &lab.session(&lab.a, &lab.b),
            id,
            &Clock,
            &Cancellation::default(),
        )
        .unwrap()
}
fn hello_message(binding: &PeerHello) -> Message {
    let profile = SyncProfile::SignedHistory;
    message(
        binding,
        Payload::Hello {
            version: profile.version(),
            required: profile.features(),
            supported: profile.features(),
            profile: profile.name().into(),
        },
    )
}
async fn deliver(
    wire: &Pair,
    source: &mut TlsTransport,
    binding: &PeerHello,
    receiver: &mut SyncEngine<'_, SignedImportStore<'_>, TlsTransport, Clock>,
    payload: Payload,
) -> Result<bool> {
    source.send(message(binding, payload))?;
    wire.transfer().await?;
    receiver.tick()
}
async fn staged(
    wire: &Pair,
    source: &mut TlsTransport,
    binding: &PeerHello,
    receiver: &mut SyncEngine<'_, SignedImportStore<'_>, TlsTransport, Clock>,
    snapshot: &SignedSnapshotExport,
) {
    deliver(
        wire,
        source,
        binding,
        receiver,
        hello_message(binding).payload,
    )
    .await
    .unwrap();
    deliver(
        wire,
        source,
        binding,
        receiver,
        Payload::SignedSnapshotOffer(snapshot.offer()),
    )
    .await
    .unwrap();
    for chunk in snapshot.image.chunks() {
        deliver(
            wire,
            source,
            binding,
            receiver,
            Payload::SignedSnapshotImage(chunk),
        )
        .await
        .unwrap();
    }
    for chunk in snapshot.evidence.chunks() {
        deliver(
            wire,
            source,
            binding,
            receiver,
            Payload::SignedSnapshotEvidence(chunk),
        )
        .await
        .unwrap();
    }
}
fn no_authoritative(peer: &Fixture) {
    no_publication(peer);
    for table in [
        "r9_originals",
        "r9_origin_seals",
        "knowledge_objects",
        "thought_revisions",
    ] {
        assert_eq!(count(peer, &format!("SELECT count(*) FROM {table}")), 0);
    }
    assert_eq!(
        count(
            peer,
            &format!(
                "SELECT count(*) FROM projects WHERE id<>'{}'",
                crate::storage::migrations::INBOX_PROJECT_ID
            )
        ),
        0
    );
}
async fn no_applied_snapshot_ack(wire: &Pair, source: &mut TlsTransport) {
    wire.transfer().await.unwrap();
    while let Some(m) = source.receive().unwrap() {
        assert!(
            !matches!(&m.payload,Payload::SignedSnapshotReceipt(r) if r.outcome==Outcome::CleanlyApplied)
        );
        assert!(!matches!(&m.payload,Payload::Receipt(r) if r.outcome.is_ack()));
    }
}

fn prepare(lab: &Lab) {
    for peer in [&lab.a, &lab.b] {
        let owner = peer.owner();
        f::install_history(owner.store());
        f::install_d4(owner.store());
        crate::storage::signed_bootstrap::install(owner.store()).unwrap();
    }
}
async fn history_exchange(lab: &Lab, id: Uuid) {
    history_between(lab, &lab.a, &lab.b, id, false).await
}
async fn history_between(lab: &Lab, source: &Fixture, target: &Fixture, id: Uuid, lose: bool) {
    let ao = source.owner();
    let bo = target.owner();
    let a = SignedImportStore::synthetic_history(ao.store());
    let b = SignedImportStore::synthetic_history(bo.store());
    let session = Uuid::new_v4();
    let at = lab.trust(source, target, session);
    let bt = lab.trust(target, source, session);
    let (wire, mut ta, tb) = connect(lab, source, target, session).await;
    ta.lose_receipts = lose;
    let cancel = Cancellation::default();
    let mut ea = SyncEngine::start(&a, ta, &at, &Clock, &cancel).unwrap();
    let mut eb = SyncEngine::start(&b, tb, &bt, &Clock, &cancel).unwrap();
    ea.bootstrap(id).unwrap();
    for _ in 0..512 {
        wire.transfer().await.unwrap();
        let aa = ea.tick().unwrap();
        let bb = eb.tick().unwrap();
        if !aa && !bb {
            assert_eq!(
                ea.status,
                if lose {
                    SyncStatus::Syncing
                } else {
                    SyncStatus::CleanlyApplied
                }
            );
            assert_eq!(eb.status, SyncStatus::CleanlyApplied);
            assert!(!ea.needs_attention && !eb.needs_attention);
            wire.abort(Error::Disconnected);
            wire.assert_closed();
            return;
        }
    }
    panic!("bounded signed historical exchange did not quiesce");
}
#[test]
fn r9_02_03_05_06_real_engine_signed_bootstrap_publishes_original_signatures_atomically() {
    native_io_lab::execute(async {
        let lab = Lab::new();
        prepare(&lab);
        history_exchange(&lab, Uuid::new_v4()).await;
        assert_eq!(signatures(&lab.a), signatures(&lab.b));
        assert_eq!(count(&lab.b, "SELECT count(*) FROM captures"), 1);
        assert_eq!(count(&lab.b, "SELECT count(*) FROM r9_originals"), 2);
    });
}

#[test]
fn r9_13_signed_history_exact_event_and_row_bounds_use_the_actual_tls_engine() {
    native_io_lab::execute(async {
        let lab = Lab::configured(false, Some(|s| f::capture_batches(s, 2047, 32)));
        prepare(&lab);
        let id = Uuid::new_v4();
        history_exchange(&lab, id).await;
        assert_eq!(count(&lab.b, "SELECT count(*) FROM r9_originals"), 64);
        assert_eq!(count(&lab.b, "SELECT count(*) FROM captures"), 2047);
        assert_eq!(signatures(&lab.a), signatures(&lab.b));
    });
}

#[test]
fn r9_03_06_signed_knowledge_history_preserves_originals_and_materialized_rows() {
    native_io_lab::execute(async {
        let lab = Lab::configured(
            false,
            Some(|s| {
                f::history(s);
            }),
        );
        prepare(&lab);
        history_exchange(&lab, Uuid::new_v4()).await;
        assert_eq!(signatures(&lab.a), signatures(&lab.b));
        assert_eq!(
            count(&lab.a, "SELECT count(*) FROM thought_revisions"),
            count(&lab.b, "SELECT count(*) FROM thought_revisions")
        );
        assert_eq!(
            count(&lab.a, "SELECT count(*) FROM knowledge_objects"),
            count(&lab.b, "SELECT count(*) FROM knowledge_objects")
        );
    });
}

#[test]
fn r9_10_11_22_signed_snapshot_lost_ack_both_owners_reopen_and_exact_retry() {
    native_io_lab::execute(async {
        let mut lab = Lab::new();
        prepare(&lab);
        let id = Uuid::new_v4();
        history_between(&lab, &lab.a, &lab.b, id, true).await;
        assert_eq!(
            count(
                &lab.a,
                "SELECT count(*) FROM bootstrap_units WHERE outcome='applied'"
            ),
            0
        );
        assert_eq!(
            count(
                &lab.b,
                "SELECT count(*) FROM bootstrap_units WHERE outcome='applied'"
            ),
            1
        );
        let signatures_before = signatures(&lab.b);
        let snapshot_before = capture(&lab, id);
        lab.a.reopen_candidate().unwrap();
        lab.b.reopen_candidate().unwrap();
        let snapshot_after = capture(&lab, id);
        assert_eq!(snapshot_before.image.bytes, snapshot_after.image.bytes);
        assert_eq!(
            snapshot_before.evidence.bytes,
            snapshot_after.evidence.bytes
        );
        history_exchange(&lab, id).await;
        assert_eq!(signatures(&lab.b), signatures_before);
        assert_eq!(count(&lab.b, "SELECT count(*) FROM captures"), 1);
        assert_eq!(count(&lab.b, "SELECT max(applied) FROM import_progress"), 2);
        assert_eq!(
            count(
                &lab.a,
                "SELECT count(*) FROM bootstrap_units WHERE outcome='applied'"
            ),
            1
        );
    });
}

#[test]
fn r9_10_signed_staging_resumes_after_offer_partial_chunks_and_before_publish() {
    native_io_lab::execute(async {
        for phase in 0..3 {
            let mut lab = Lab::configured(
                false,
                Some(|s| {
                    let content =
                        "x".repeat(crate::storage::capture_store::MAX_CAPTURE_CONTENT_CHARS);
                    f::captures(s, &[content.as_str(); 6]);
                }),
            );
            prepare(&lab);
            let id = Uuid::new_v4();
            let snapshot = capture(&lab, id);
            assert!(snapshot.image.offer.chunks >= 2);
            {
                let session = Uuid::new_v4();
                let binding = hello(&lab.a, &lab.b, session);
                let (wire, mut source, target) = connect(&lab, &lab.a, &lab.b, session).await;
                let owner = lab.b.owner();
                let store = SignedImportStore::synthetic_history(owner.store());
                let trust = lab.trust(&lab.b, &lab.a, session);
                let cancel = Cancellation::default();
                let mut receiver =
                    SyncEngine::start(&store, target, &trust, &Clock, &cancel).unwrap();
                deliver(
                    &wire,
                    &mut source,
                    &binding,
                    &mut receiver,
                    hello_message(&binding).payload,
                )
                .await
                .unwrap();
                deliver(
                    &wire,
                    &mut source,
                    &binding,
                    &mut receiver,
                    Payload::SignedSnapshotOffer(snapshot.offer()),
                )
                .await
                .unwrap();
                if phase > 0 {
                    let count = if phase == 1 {
                        1
                    } else {
                        snapshot.image.offer.chunks
                    };
                    for ch in snapshot.image.chunks().into_iter().take(count) {
                        deliver(
                            &wire,
                            &mut source,
                            &binding,
                            &mut receiver,
                            Payload::SignedSnapshotImage(ch),
                        )
                        .await
                        .unwrap();
                    }
                }
                if phase == 2 {
                    for ch in snapshot.evidence.chunks() {
                        deliver(
                            &wire,
                            &mut source,
                            &binding,
                            &mut receiver,
                            Payload::SignedSnapshotEvidence(ch),
                        )
                        .await
                        .unwrap();
                    }
                }
                no_authoritative(&lab.b);
                no_applied_snapshot_ack(&wire, &mut source).await;
                wire.abort(Error::Disconnected);
                assert_eq!(receiver.tick(), Err(Error::Disconnected));
                wire.assert_closed();
            }
            lab.a.reopen_candidate().unwrap();
            lab.b.reopen_candidate().unwrap();
            history_exchange(&lab, id).await;
            assert_eq!(signatures(&lab.a), signatures(&lab.b));
        }
    });
}

#[test]
fn r9_02_12_single_h_cached_image_does_not_absorb_a_post_h_write() {
    native_io_lab::execute(async {
        let lab = Lab::configured(false, Some(|s| f::captures(s, &[])));
        prepare(&lab);
        let owner = lab.a.owner();
        let series = f::CaptureSeries::new(owner.store());
        series.append("before H");
        let id = Uuid::new_v4();
        let before = capture(&lab, id);
        let image = decode(&before.image.bytes).unwrap();
        assert_eq!(image.cores.len(), 1);
        series.append("after H, separate catch-up");
        let after = capture(&lab, id);
        assert_eq!(before.image.bytes, after.image.bytes);
        assert_eq!(before.evidence.bytes, after.evidence.bytes);
        history_exchange(&lab, id).await;
        assert_eq!(count(&lab.b, "SELECT count(*) FROM captures"), 2);
        assert_eq!(count(&lab.b, "SELECT count(*) FROM r9_originals"), 2);
        assert_eq!(signatures(&lab.a), signatures(&lab.b));
    });
}

#[test]
fn r9_03_forwarded_snapshot_preserves_original_author_signatures() {
    native_io_lab::execute(async {
        let mut lab = Lab::new();
        prepare(&lab);
        history_exchange(&lab, Uuid::new_v4()).await;
        let original = signatures(&lab.a);
        let target = lab.add_forwarding_target();
        {
            let owner = target.owner();
            f::install_history(owner.store());
            f::install_d4(owner.store());
            crate::storage::signed_bootstrap::install(owner.store()).unwrap();
        }
        history_between(&lab, &lab.b, &target, Uuid::new_v4(), false).await;
        assert_eq!(signatures(&target), original);
        assert_eq!(
            count(&target, "SELECT count(*) FROM e2_export_signatures"),
            0
        );
    });
}

fn forge(lab: &Lab, snapshot: &mut SignedSnapshotExport, mode: usize) {
    if matches!(mode, 11 | 18) {
        let mut value: serde_json::Value =
            serde_json::from_slice(&snapshot.evidence.bytes).unwrap();
        if mode == 11 {
            snapshot.evidence.bytes.insert(0, b' ');
        } else {
            value["body"]["originals"][0]["signature"] =
                serde_json::json!(vec![0u8; MAX_SIGNED_METADATA]);
            snapshot.evidence.bytes = serde_jcs::to_vec(&value).unwrap();
        }
    } else {
        let manifest = SignedManifest::decode(&snapshot.evidence.bytes).unwrap();
        let mut body = manifest.body;
        match mode {
            0 => {
                let mut value =
                    serde_json::to_value(SignedManifest::decode(&snapshot.evidence.bytes).unwrap())
                        .unwrap();
                value["signature"][0] =
                    serde_json::json!(value["signature"][0].as_u64().unwrap() ^ 1);
                snapshot.evidence.bytes = serde_jcs::to_vec(&value).unwrap();
            }
            1 => {
                body.originals.pop();
            }
            2 | 3 => {
                let mut value = serde_json::to_value(&body.originals[0]).unwrap();
                if mode == 2 {
                    value["signature"] = serde_json::json!(vec![0u8; 64]);
                } else {
                    value["body"]["author"] = serde_json::to_value(&lab.b.public).unwrap();
                }
                body.originals[0] = serde_json::from_value(value).unwrap();
            }
            4 => body.network = Uuid::new_v4(),
            5 => body.epoch += 1,
            6 => body.registry[0] ^= 1,
            7 => body.high_water[0].hash = "00".repeat(32),
            8 => body.originals[0] = body.originals[1].clone(),
            9 | 10 => {
                let image = decode(&snapshot.image.bytes).unwrap();
                let event = envelope(unhex(&image.cores[0].bytes).unwrap()).unwrap();
                if mode == 9 {
                    let other = Admin::new();
                    body.originals[0] =
                        SignedOriginal::sign(body.network, &event, &other.0).unwrap();
                } else {
                    let owner = lab.b.owner();
                    let key = crate::storage::device_identity_store::OwnedDeviceIdentity::reopen(
                        owner.store(),
                    )
                    .unwrap();
                    body.originals[0] = SignedOriginal::sign(body.network, &event, &key).unwrap();
                }
            }
            12 => body.image.hash[0] ^= 1,
            13 => {
                let mut image = decode(&snapshot.image.bytes).unwrap();
                let row = image
                    .rows
                    .iter_mut()
                    .find(|r| r.entity == "captures")
                    .unwrap();
                row.image["content"] =
                    serde_json::json!("forged projection with genuine unchanged originals");
                snapshot.image.bytes = canonical(&image).unwrap();
                snapshot.image.offer.hash =
                    crate::sync_api::codec::journal_event_hash(&snapshot.image.bytes);
                snapshot.image.offer.bytes = snapshot.image.bytes.len();
                snapshot.image.offer.chunks = snapshot.image.bytes.len().div_ceil(CHUNK);
                body.image = snapshot.image.offer.clone();
            }
            _ => {}
        }
        if mode != 0 {
            let owner = lab.a.owner();
            let key =
                crate::storage::device_identity_store::OwnedDeviceIdentity::reopen(owner.store())
                    .unwrap();
            snapshot.evidence.bytes = SignedManifest::sign(body, &key).unwrap().bytes().unwrap();
        }
    }
    snapshot.evidence.offer.hash =
        crate::sync_api::codec::journal_event_hash(&snapshot.evidence.bytes);
    snapshot.evidence.offer.bytes = snapshot.evidence.bytes.len();
    snapshot.evidence.offer.chunks = snapshot.evidence.bytes.len().div_ceil(CHUNK);
}

#[test]
fn r9_07_08_15_signed_snapshot_tampering_missing_evidence_and_wrong_projection_never_publish() {
    native_io_lab::execute(async {
        for mode in 0..19 {
            let lab = Lab::new();
            prepare(&lab);
            let mut snapshot = capture(&lab, Uuid::new_v4());
            if mode < 14 || mode == 18 {
                forge(&lab, &mut snapshot, mode);
            }
            let session = Uuid::new_v4();
            let binding = hello(&lab.a, &lab.b, session);
            let (wire, mut source, target) = connect(&lab, &lab.a, &lab.b, session).await;
            let owner = lab.b.owner();
            let store = SignedImportStore::synthetic_history(owner.store());
            let trust = lab.trust(&lab.b, &lab.a, session);
            let cancel = Cancellation::default();
            let mut receiver = SyncEngine::start(&store, target, &trust, &Clock, &cancel).unwrap();
            deliver(
                &wire,
                &mut source,
                &binding,
                &mut receiver,
                hello_message(&binding).payload,
            )
            .await
            .unwrap();
            if mode == 14 {
                let mut offer = snapshot.offer();
                offer.evidence.bytes = SIGNED_EVIDENCE_BYTES + 1;
                offer.evidence.chunks = offer.evidence.bytes.div_ceil(CHUNK);
                assert_eq!(
                    deliver(
                        &wire,
                        &mut source,
                        &binding,
                        &mut receiver,
                        Payload::SignedSnapshotOffer(offer)
                    )
                    .await,
                    Err(Error::Limit)
                );
            } else {
                deliver(
                    &wire,
                    &mut source,
                    &binding,
                    &mut receiver,
                    Payload::SignedSnapshotOffer(snapshot.offer()),
                )
                .await
                .unwrap();
                for mut chunk in snapshot.image.chunks() {
                    if mode == 16 {
                        chunk.bytes[0] ^= 1;
                        chunk.hash = crate::sync_api::codec::journal_event_hash(&chunk.bytes);
                    }
                    deliver(
                        &wire,
                        &mut source,
                        &binding,
                        &mut receiver,
                        Payload::SignedSnapshotImage(chunk),
                    )
                    .await
                    .unwrap();
                }
                if mode != 15 {
                    for mut chunk in snapshot.evidence.chunks() {
                        if mode == 17 {
                            chunk.bytes[0] ^= 1;
                            chunk.hash = crate::sync_api::codec::journal_event_hash(&chunk.bytes);
                        }
                        deliver(
                            &wire,
                            &mut source,
                            &binding,
                            &mut receiver,
                            Payload::SignedSnapshotEvidence(chunk),
                        )
                        .await
                        .unwrap();
                    }
                }
                let result = deliver(
                    &wire,
                    &mut source,
                    &binding,
                    &mut receiver,
                    Payload::SignedSnapshotPublish(snapshot.offer()),
                )
                .await;
                let expected = if mode == 15 {
                    Error::Protocol
                } else if matches!(mode, 11 | 13 | 16 | 17) {
                    Error::Integrity
                } else {
                    Error::Trust
                };
                assert_eq!(result, Err(expected), "case {mode}");
            }
            no_authoritative(&lab.b);
            no_applied_snapshot_ack(&wire, &mut source).await;
            wire.abort(Error::Disconnected);
            wire.assert_closed();
        }
    });
}

#[test]
fn r9_04_legacy_or_r8_negotiation_and_unsigned_snapshot_cannot_enter_r9() {
    native_io_lab::execute(async {
        for profile in [
            SyncProfile::LedgerCandidate,
            SyncProfile::SignedOriginalCandidate,
            SyncProfile::SignedHistory,
        ] {
            let lab = Lab::new();
            prepare(&lab);
            let snapshot = capture(&lab, Uuid::new_v4());
            let session = Uuid::new_v4();
            let binding = hello(&lab.a, &lab.b, session);
            let (wire, mut source, target) = connect(&lab, &lab.a, &lab.b, session).await;
            let owner = lab.b.owner();
            let store = SignedImportStore::synthetic_history(owner.store());
            let trust = lab.trust(&lab.b, &lab.a, session);
            let cancel = Cancellation::default();
            let mut receiver = SyncEngine::start(&store, target, &trust, &Clock, &cancel).unwrap();
            let result = deliver(
                &wire,
                &mut source,
                &binding,
                &mut receiver,
                Payload::Hello {
                    version: profile.version(),
                    required: profile.features(),
                    supported: profile.features(),
                    profile: profile.name().into(),
                },
            )
            .await;
            if profile != SyncProfile::SignedHistory {
                assert_eq!(result, Err(Error::Protocol));
            } else {
                result.unwrap();
                assert_eq!(
                    deliver(
                        &wire,
                        &mut source,
                        &binding,
                        &mut receiver,
                        Payload::SnapshotOffer(snapshot.image.offer)
                    )
                    .await,
                    Err(Error::Protocol)
                );
            }
            no_authoritative(&lab.b);
            no_applied_snapshot_ack(&wire, &mut source).await;
        }
    });
}

#[test]
fn r9_14_near_four_mib_image_keeps_its_cap_and_accounts_separate_signed_evidence() {
    native_io_lab::execute(async {
        let lab = Lab::configured(
            false,
            Some(|s| {
                let ascii = "x".repeat(crate::storage::capture_store::MAX_CAPTURE_CONTENT_CHARS);
                let unicode = "🚀".repeat(crate::storage::capture_store::MAX_CAPTURE_CONTENT_CHARS);
                let mut records = vec![ascii.as_str(); 59];
                records.extend([unicode.as_str(); 2]);
                f::captures(s, &records);
            }),
        );
        prepare(&lab);
        let id = Uuid::new_v4();
        let snapshot = capture(&lab, id);
        assert!(snapshot.image.bytes.len() >= BOOTSTRAP_BYTES - CHUNK);
        assert!(snapshot.image.bytes.len() <= BOOTSTRAP_BYTES);
        assert!(snapshot.evidence.bytes.len() <= SIGNED_EVIDENCE_BYTES);
        println!(
            "R9 bounded image={} evidence={} combined={} image_chunks={} evidence_chunks={}",
            snapshot.image.bytes.len(),
            snapshot.evidence.bytes.len(),
            snapshot.image.bytes.len() + snapshot.evidence.bytes.len(),
            snapshot.image.offer.chunks,
            snapshot.evidence.offer.chunks
        );
        history_exchange(&lab, id).await;
        assert_eq!(count(&lab.b, "SELECT count(*) FROM captures"), 61);
        assert_eq!(signatures(&lab.a), signatures(&lab.b));
    });
}

#[test]
fn r9_16_registry_revocation_after_tls_cannot_publish_staged_history() {
    native_io_lab::execute(async {
        let lab = Lab::new();
        prepare(&lab);
        let snapshot = capture(&lab, Uuid::new_v4());
        let session = Uuid::new_v4();
        let binding = hello(&lab.a, &lab.b, session);
        let (wire, mut source, target) = connect(&lab, &lab.a, &lab.b, session).await;
        let owner = lab.b.owner();
        let store = SignedImportStore::synthetic_history(owner.store());
        let trust = lab.trust(&lab.b, &lab.a, session);
        let cancel = Cancellation::default();
        let mut receiver = SyncEngine::start(&store, target, &trust, &Clock, &cancel).unwrap();
        staged(&wire, &mut source, &binding, &mut receiver, &snapshot).await;
        let registry = NetworkRegistry::candidate(owner.store()).unwrap();
        let revoke = registry
            .next(
                Action::Revoke {
                    device: lab.a.public.clone(),
                },
                &lab.admin.0,
            )
            .unwrap();
        registry.apply(&revoke).unwrap();
        assert!(matches!(
            deliver(
                &wire,
                &mut source,
                &binding,
                &mut receiver,
                Payload::SignedSnapshotPublish(snapshot.offer())
            )
            .await,
            Err(Error::Trust | Error::Cancelled)
        ));
        no_authoritative(&lab.b);
        wire.abort(Error::Disconnected);
        wire.assert_closed();
    });
}

#[test]
fn r9_16_final_transaction_permission_recheck_rolls_back_domain_signatures_and_outcome() {
    let lab = Lab::new();
    prepare(&lab);
    let snapshot = capture(&lab, Uuid::new_v4());
    let owner = lab.b.owner();
    let store = SignedImportStore::synthetic_history(owner.store());
    let session = lab.session(&lab.b, &lab.a);
    let cancel = Cancellation::default();
    store
        .signed_snapshot_offer(&session, &snapshot.offer(), &Clock, &cancel)
        .unwrap();
    for ch in snapshot.image.chunks() {
        store
            .signed_snapshot_chunk(&session, &ch, false, &Clock, &cancel)
            .unwrap();
    }
    for ch in snapshot.evidence.chunks() {
        store
            .signed_snapshot_chunk(&session, &ch, true, &Clock, &cancel)
            .unwrap();
    }
    let db = crate::storage::sync_store::CandidateSyncStore::synthetic(owner.store());
    assert!(matches!(
        crate::storage::signed_bootstrap::publish_with_barrier(
            &db,
            &session,
            &snapshot.offer(),
            &Clock,
            &cancel,
            |c| {
                c.execute("UPDATE import_origin_permissions SET enabled=0", [])
                    .unwrap();
            }
        ),
        Err(Error::Trust)
    ));
    no_authoritative(&lab.b);
    assert_eq!(
        count(
            &lab.b,
            "SELECT count(*) FROM bootstrap_units WHERE outcome='applied'"
        ),
        0
    );
}

#[test]
fn r9_23_commit_uncertainty_and_cleanup_failure_send_no_applied_ack_and_reconcile() {
    native_io_lab::execute(async {
        for committed in [false, true] {
            let mut lab = Lab::new();
            prepare(&lab);
            let id = Uuid::new_v4();
            let snapshot = capture(&lab, id);
            {
                let session = Uuid::new_v4();
                let binding = hello(&lab.a, &lab.b, session);
                let (wire, mut source, target) = connect(&lab, &lab.a, &lab.b, session).await;
                let owner = lab.b.owner();
                let store = if committed {
                    SignedImportStore::admitted_history_for_test(f::physically_admitted(
                        owner.store(),
                    ))
                } else {
                    SignedImportStore::synthetic_history(owner.store())
                };
                let trust = lab.trust(&lab.b, &lab.a, session);
                let cancel = Cancellation::default();
                let mut receiver =
                    SyncEngine::start(&store, target, &trust, &Clock, &cancel).unwrap();
                staged(&wire, &mut source, &binding, &mut receiver, &snapshot).await;
                if !committed {
                    owner.store().connection.lock().unwrap().execute_batch("CREATE TABLE r9_commit_fault(peer TEXT REFERENCES import_members(peer) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER r9_commit_failure AFTER UPDATE OF outcome ON bootstrap_units WHEN NEW.outcome='applied' BEGIN INSERT INTO r9_commit_fault VALUES('absent'); END;").unwrap();
                }
                let guard = committed.then(|| f::deny_post_commit_budget_restore(owner.store()));
                let expected = if committed {
                    Error::CommittedCleanupFailed
                } else {
                    Error::CommitUncertain
                };
                assert_eq!(
                    deliver(
                        &wire,
                        &mut source,
                        &binding,
                        &mut receiver,
                        Payload::SignedSnapshotPublish(snapshot.offer())
                    )
                    .await,
                    Err(expected)
                );
                assert_eq!(receiver.tick(), Err(expected));
                assert_eq!(
                    count(&lab.b, "SELECT count(*) FROM r9_originals"),
                    if committed { 2 } else { 0 }
                );
                assert_eq!(
                    count(
                        &lab.b,
                        "SELECT count(*) FROM bootstrap_units WHERE outcome='applied'"
                    ),
                    i64::from(committed)
                );
                if let Some(guard) = guard {
                    assert_eq!(guard.hits(), 1);
                    drop(guard);
                }
                no_applied_snapshot_ack(&wire, &mut source).await;
                wire.abort(Error::Disconnected);
                wire.assert_closed();
            }
            lab.a.reopen_candidate().unwrap();
            lab.b.reopen_candidate().unwrap();
            history_exchange(&lab, id).await;
            assert_eq!(count(&lab.b, "SELECT count(*) FROM captures"), 1);
            assert_eq!(signatures(&lab.a), signatures(&lab.b));
        }
    });
}

#[test]
fn r9_21_e2_history_upgrades_exactly_once_and_remains_immutable_compatibility_evidence() {
    native_io_lab::execute(async {
        let lab = Lab::new();
        exchange(&lab, &lab.a, &lab.b, false).await;
        let before = signatures(&lab.b);
        prepare(&lab);
        assert_eq!(signatures(&lab.b), before);
        let owner = lab.b.owner();
        crate::storage::signed_bootstrap::install(owner.store()).unwrap();
        assert_eq!(count(&lab.b,"SELECT count(*) FROM (SELECT origin,incarnation,author,seq,hash,signature FROM e2_origin_seals EXCEPT SELECT origin,incarnation,author,seq,hash,signature FROM r9_origin_seals)"),0);
        assert!(owner
            .store()
            .connection
            .lock()
            .unwrap()
            .execute("UPDATE e2_origin_seals SET seq=seq", [])
            .is_err());
        assert!(owner
            .store()
            .connection
            .lock()
            .unwrap()
            .execute("DELETE FROM e2_originals", [])
            .is_err());
        assert!(owner
            .store()
            .connection
            .lock()
            .unwrap()
            .execute("UPDATE r9_signed_profile SET version=1", [])
            .is_err());
        assert_eq!(signatures(&lab.b), before);
    });
}

#[test]
fn r9_21_corrupt_e2_prefix_or_original_refuses_upgrade_without_partial_ddl() {
    native_io_lab::execute(async {
        for signature in [false, true] {
            let lab = Lab::new();
            exchange(&lab, &lab.a, &lab.b, false).await;
            let owner = lab.b.owner();
            f::install_history(owner.store());
            f::install_d4(owner.store());
            {
                let c = owner.store().connection.lock().unwrap();
                if signature {
                    c.execute("UPDATE e2_origin_seals SET signature=zeroblob(64)", [])
                        .unwrap();
                } else {
                    c.execute("UPDATE e2_originals SET envelope=x'00'", [])
                        .unwrap();
                }
            }
            assert!(crate::storage::signed_bootstrap::install(owner.store()).is_err());
            assert_eq!(
                count(
                    &lab.b,
                    "SELECT count(*) FROM sqlite_schema WHERE name='r9_signed_profile'"
                ),
                0
            );
            assert_eq!(count(&lab.b, "SELECT count(*) FROM e2_originals"), 2);
            assert_eq!(count(&lab.b, "SELECT count(*) FROM captures"), 1);
        }
    });
}

#[test]
fn r9_17_18_19_new_os_signed_incarnations_remain_blocked_without_overwriting_i1() {
    native_io_lab::execute(async {
        let lab = Lab::new();
        prepare(&lab);
        history_exchange(&lab, Uuid::new_v4()).await;
        let accepted = signatures(&lab.b);
        for _ in 0..2 {
            let owner = lab.a.owner();
            let project = owner
                .store()
                .connection
                .lock()
                .unwrap()
                .query_row(
                    "SELECT id FROM projects WHERE name='R8 signed project'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .unwrap();
            f::capture_in(
                owner.store(),
                &project,
                "Genuine new incarnation requires reviewed rotation proof",
            );
            let event = f::last_original(owner.store());
            let store = SignedImportStore::synthetic_history(owner.store());
            let metadata = store
                .export_signed(
                    &lab.session(&lab.a, &lab.b),
                    &event.identity,
                    &Clock,
                    &Cancellation::default(),
                )
                .unwrap()
                .metadata;
            let session = Uuid::new_v4();
            let binding = hello(&lab.a, &lab.b, session);
            let (wire, mut source, target) = connect(&lab, &lab.a, &lab.b, session).await;
            let bo = lab.b.owner();
            let receiver_store = SignedImportStore::synthetic_history(bo.store());
            let trust = lab.trust(&lab.b, &lab.a, session);
            let cancel = Cancellation::default();
            let mut receiver =
                SyncEngine::start(&receiver_store, target, &trust, &Clock, &cancel).unwrap();
            deliver(
                &wire,
                &mut source,
                &binding,
                &mut receiver,
                hello_message(&binding).payload,
            )
            .await
            .unwrap();
            deliver(
                &wire,
                &mut source,
                &binding,
                &mut receiver,
                Payload::SignedMetadata(metadata),
            )
            .await
            .unwrap();
            for ch in chunk_event(&event) {
                deliver(
                    &wire,
                    &mut source,
                    &binding,
                    &mut receiver,
                    Payload::Chunk(ch),
                )
                .await
                .unwrap();
            }
            assert_eq!(receiver.status, SyncStatus::UnsupportedImportPolicy);
            assert!(receiver.needs_attention);
            assert_eq!(signatures(&lab.b), accepted);
            assert_eq!(count(&lab.b, "SELECT count(*) FROM r9_origin_seals"), 1);
            assert_eq!(count(&lab.b, "SELECT max(applied) FROM import_progress"), 2);
            no_applied_snapshot_ack(&wire, &mut source).await;
        }
        assert_eq!(count(&lab.b, "SELECT count(*) FROM e2_quarantine"), 2);
    });
}

#[test]
fn r9_09_valid_signed_review_snapshot_is_retained_non_clean_without_approval() {
    native_io_lab::execute(async {
        let lab = Lab::with_review_history(true);
        for peer in [&lab.a, &lab.b] {
            crate::storage::signed_bootstrap::install(peer.owner().store()).unwrap();
        }
        let snapshot = capture(&lab, Uuid::new_v4());
        let session = Uuid::new_v4();
        let binding = hello(&lab.a, &lab.b, session);
        let (wire, mut source, target) = connect(&lab, &lab.a, &lab.b, session).await;
        let owner = lab.b.owner();
        let store = SignedImportStore::synthetic_history(owner.store());
        let trust = lab.trust(&lab.b, &lab.a, session);
        let cancel = Cancellation::default();
        let mut receiver = SyncEngine::start(&store, target, &trust, &Clock, &cancel).unwrap();
        staged(&wire, &mut source, &binding, &mut receiver, &snapshot).await;
        deliver(
            &wire,
            &mut source,
            &binding,
            &mut receiver,
            Payload::SignedSnapshotPublish(snapshot.offer()),
        )
        .await
        .unwrap();
        assert_ne!(receiver.status, SyncStatus::CleanlyApplied);
        assert!(receiver.needs_attention);
        assert_eq!(count(&lab.b,"SELECT count(*) FROM revision_proposals WHERE state IN('approved','edited_approved')"),0);
        assert_eq!(count(&lab.b, "SELECT count(*) FROM r9_origin_seals"), 0);
        no_applied_snapshot_ack(&wire, &mut source).await;
    });
}

#[test]
fn r9_13_14_over_limit_signed_images_and_expired_watchdog_do_not_stage_success() {
    for kind in 0..3 {
        let lab = Lab::configured(
            false,
            Some(match kind {
                0 => |s| f::captures(s, &vec!["over event cap"; 65]),
                1 => |s| f::capture_batches(s, 2048, 64),
                _ => |s| {
                    f::captures(
                        s,
                        &vec![
                            "🚀"
                                .repeat(crate::storage::capture_store::MAX_CAPTURE_CONTENT_CHARS)
                                .as_str();
                            18
                        ],
                    )
                },
            }),
        );
        prepare(&lab);
        let owner = lab.a.owner();
        let store = SignedImportStore::synthetic_history(owner.store());
        assert!(matches!(
            store.signed_snapshot_capture(
                &lab.session(&lab.a, &lab.b),
                Uuid::new_v4(),
                &Clock,
                &Cancellation::default()
            ),
            Err(Error::SnapshotTooLarge)
        ));
        assert_eq!(count(&lab.a, "SELECT count(*) FROM bootstrap_units"), 0);
        let trace = crate::storage::bootstrap_trace::last().unwrap();
        assert!(!trace.watchdog);
    }
    let lab = Lab::new();
    prepare(&lab);
    let owner = lab.a.owner();
    let store = SignedImportStore::synthetic_history(owner.store());
    for phase in [
        "cores",
        "signed_originals",
        "signed_manifest",
        "signed_stage",
    ] {
        assert!(matches!(
            crate::storage::bootstrap_trace::with_expired(phase, || store.signed_snapshot_capture(
                &lab.session(&lab.a, &lab.b),
                Uuid::new_v4(),
                &Clock,
                &Cancellation::default()
            )),
            Err(Error::SnapshotTooLarge)
        ));
        let trace = crate::storage::bootstrap_trace::last().unwrap();
        assert_eq!(trace.phase, phase);
        assert!(trace.watchdog);
        assert_eq!(count(&lab.a, "SELECT count(*) FROM bootstrap_units"), 0);
    }
}

#[test]
fn r9_19_20_signed_old_sequence_fork_and_replacement_key_preserve_accepted_history() {
    native_io_lab::execute(async {
        let lab = Lab::new();
        prepare(&lab);
        history_exchange(&lab, Uuid::new_v4()).await;
        let accepted = signatures(&lab.b);
        let (original, _) = metadata(&lab, 0);
        for mode in 0..3 {
            let mut core = crate::sync_api::codec::decode_core_strict(&original.bytes).unwrap();
            if mode == 0 {
                core.event_id = Uuid::new_v4().to_string();
            }
            if mode < 2 {
                let crate::sync_api::codec::Operation::RecordCreate(row) = &mut core.operations[0]
                else {
                    panic!("project create")
                };
                row.after.insert(
                    "name".into(),
                    crate::sync_api::codec::FieldValue::Text(
                        "fork at an already accepted sequence".into(),
                    ),
                );
            }
            let bytes = crate::sync_api::codec::encode_canonical(&core).unwrap();
            let mut event = original.clone();
            event.identity.event = Uuid::parse_str(&core.event_id).unwrap();
            event.identity.hash = crate::sync_api::codec::journal_event_hash(&bytes);
            event.bytes = bytes;
            let ao = lab.a.owner();
            let key =
                crate::storage::device_identity_store::OwnedDeviceIdentity::reopen(ao.store())
                    .unwrap();
            let other = Admin::new();
            let session = Uuid::new_v4();
            let binding = hello(&lab.a, &lab.b, session);
            let signed = if mode == 2 {
                SignedOriginal::sign(binding.network, &event, &other.0)
            } else {
                SignedOriginal::sign(binding.network, &event, &key)
            }
            .unwrap();
            let metadata = SignedMetadata {
                identity: event.identity.clone(),
                bytes: signed.bytes().unwrap(),
            };
            let (wire, mut source, target) = connect(&lab, &lab.a, &lab.b, session).await;
            let bo = lab.b.owner();
            let store = SignedImportStore::synthetic_history(bo.store());
            let trust = lab.trust(&lab.b, &lab.a, session);
            let cancel = Cancellation::default();
            let mut receiver = SyncEngine::start(&store, target, &trust, &Clock, &cancel).unwrap();
            deliver(
                &wire,
                &mut source,
                &binding,
                &mut receiver,
                hello_message(&binding).payload,
            )
            .await
            .unwrap();
            deliver(
                &wire,
                &mut source,
                &binding,
                &mut receiver,
                Payload::SignedMetadata(metadata),
            )
            .await
            .unwrap();
            let mut outcome = Ok(false);
            for ch in chunk_event(&event) {
                outcome = deliver(
                    &wire,
                    &mut source,
                    &binding,
                    &mut receiver,
                    Payload::Chunk(ch),
                )
                .await;
                if outcome.is_err() {
                    break;
                }
            }
            match mode {
                0 => {
                    outcome.unwrap();
                    assert_eq!(receiver.status, SyncStatus::UnsupportedImportPolicy);
                }
                1 => assert_eq!(outcome, Err(Error::Integrity)),
                _ => assert_eq!(outcome, Err(Error::Trust)),
            }
            assert_eq!(signatures(&lab.b), accepted);
            assert_eq!(count(&lab.b, "SELECT count(*) FROM r9_origin_seals"), 1);
            assert_eq!(count(&lab.b, "SELECT max(applied) FROM import_progress"), 2);
            assert_eq!(
                count(
                    &lab.b,
                    "SELECT count(*) FROM projects WHERE name='R8 signed project'"
                ),
                1
            );
            no_applied_snapshot_ack(&wire, &mut source).await;
        }
    });
}

#[test]
fn r9_09_signed_snapshot_cannot_replace_an_independently_selected_local_head() {
    native_io_lab::execute(async {
        let lab = Lab::configured(
            false,
            Some(|s| {
                f::history(s);
            }),
        );
        prepare(&lab);
        history_exchange(&lab, Uuid::new_v4()).await;
        let bo = lab.b.owner();
        let object = bo
            .store()
            .connection
            .lock()
            .unwrap()
            .query_row("SELECT id FROM knowledge_objects", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap();
        f::edit_id(
            bo.store(),
            &object,
            "Independent local selection stays authoritative",
        );
        let local_head = bo.store().current_revision_id_of(&object).unwrap().unwrap();
        let accepted = signatures(&lab.b);
        let snapshot = capture(&lab, Uuid::new_v4());
        let session = Uuid::new_v4();
        let binding = hello(&lab.a, &lab.b, session);
        let (wire, mut source, target) = connect(&lab, &lab.a, &lab.b, session).await;
        let store = SignedImportStore::synthetic_history(bo.store());
        let trust = lab.trust(&lab.b, &lab.a, session);
        let cancel = Cancellation::default();
        let mut receiver = SyncEngine::start(&store, target, &trust, &Clock, &cancel).unwrap();
        staged(&wire, &mut source, &binding, &mut receiver, &snapshot).await;
        assert_eq!(
            deliver(
                &wire,
                &mut source,
                &binding,
                &mut receiver,
                Payload::SignedSnapshotPublish(snapshot.offer())
            )
            .await,
            Err(Error::Integrity)
        );
        assert_eq!(
            bo.store().current_revision_id_of(&object).unwrap().unwrap(),
            local_head
        );
        assert_eq!(signatures(&lab.b), accepted);
        assert!(receiver.needs_attention);
        assert_ne!(receiver.status, SyncStatus::CleanlyApplied);
        assert_eq!(count(&lab.b,"SELECT count(*) FROM revision_proposals WHERE state IN('approved','edited_approved')"),0);
        no_applied_snapshot_ack(&wire, &mut source).await;
    });
}
