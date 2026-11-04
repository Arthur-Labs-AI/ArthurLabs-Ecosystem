//! Adversarial R8 inputs cross the existing TLS driver and receiving engine.
use super::*;

fn signed_hello(binding: &PeerHello) -> Message {
    let p = SyncProfile::SignedOriginalCandidate;
    message(
        binding,
        Payload::Hello {
            version: p.version(),
            required: p.features(),
            supported: p.features(),
            profile: p.name().into(),
        },
    )
}
async fn feed(
    wire: &Pair,
    source: &mut TlsTransport,
    binding: &PeerHello,
    receiver: &mut SyncEngine<'_, SignedImportStore<'_>, TlsTransport, Clock>,
    event: &Envelope,
    metadata: SignedMetadata,
) -> Result<bool> {
    source.send(message(binding, Payload::SignedMetadata(metadata)))?;
    wire.transfer().await?;
    receiver.tick()?;
    let mut result = false;
    for chunk in chunk_event(event) {
        source.send(message(binding, Payload::Chunk(chunk)))?;
        wire.transfer().await?;
        result = receiver.tick()?;
    }
    Ok(result)
}

#[test]
fn r8_signed_deferred_dependency_is_reverified_before_domain_and_seal_commit() {
    native_io_lab::execute(async {
        for corrupt_pending in [false, true] {
            let mut lab = Lab::new();
            exchange(&lab, &lab.a, &lab.b, false).await;
            let project = lab
                .b
                .owner()
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
                lab.b.owner().store(),
                &project,
                "Signed child requires another origin's project",
            );
            let mut target = lab.add_forwarding_target();
            let source_owner = lab.b.owner();
            let local_origin = source_owner
                .store()
                .connection
                .lock()
                .unwrap()
                .query_row("SELECT origin_id FROM sync_local", [], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap();
            let events = sync_store::test_events(source_owner.store());
            let child = events
                .iter()
                .find(|e| e.identity.origin.to_string() == local_origin)
                .unwrap();
            let parent = events
                .iter()
                .find(|e| e.identity.origin.to_string() != local_origin && e.identity.seq == 1)
                .unwrap();
            {
                let session = Uuid::new_v4();
                let binding = hello(&lab.b, &target, session);
                let (wire, mut source, transport) = connect(&lab, &lab.b, &target, session).await;
                let owner = target.owner();
                let store = SignedImportStore::synthetic(owner.store());
                let sender = SignedImportStore::synthetic(source_owner.store());
                let sender_session = lab
                    .trust(&lab.b, &target, session)
                    .verify(&binding)
                    .unwrap();
                let child_signed = sender
                    .export_signed(
                        &sender_session,
                        &child.identity,
                        &Clock,
                        &Cancellation::default(),
                    )
                    .unwrap()
                    .metadata;
                let parent_signed = sender
                    .export_signed(
                        &sender_session,
                        &parent.identity,
                        &Clock,
                        &Cancellation::default(),
                    )
                    .unwrap()
                    .metadata;
                sender
                    .offered(
                        &sender_session,
                        &child.identity,
                        &Clock,
                        &Cancellation::default(),
                    )
                    .unwrap();
                let trust = lab.trust(&target, &lab.b, session);
                let cancel = Cancellation::default();
                let mut receiver =
                    SyncEngine::start(&store, transport, &trust, &Clock, &cancel).unwrap();
                source.send(signed_hello(&binding)).unwrap();
                wire.transfer().await.unwrap();
                receiver.tick().unwrap();
                feed(
                    &wire,
                    &mut source,
                    &binding,
                    &mut receiver,
                    child,
                    child_signed,
                )
                .await
                .unwrap();
                assert_eq!(receiver.status, SyncStatus::DeferredDependency);
                assert_eq!(
                    count(&target, "SELECT count(*) FROM e2_pending_signatures"),
                    1
                );
                assert_eq!(count(&target, "SELECT count(*) FROM e2_origin_seals"), 0);
                if corrupt_pending {
                    owner
                        .store()
                        .connection
                        .lock()
                        .unwrap()
                        .execute("UPDATE e2_pending_signatures SET envelope=x'00'", [])
                        .unwrap();
                }
                feed(
                    &wire,
                    &mut source,
                    &binding,
                    &mut receiver,
                    parent,
                    parent_signed,
                )
                .await
                .unwrap();
                // The parent transaction must not silently materialize the
                // deferred child using only its unsigned retained core.
                assert_eq!(count(&target, "SELECT count(*) FROM captures"), 0);
                assert_eq!(count(&target, "SELECT count(*) FROM e2_originals"), 1);
                if corrupt_pending {
                    assert_eq!(receiver.tick(), Err(Error::Trust));
                    assert_eq!(count(&target, "SELECT count(*) FROM captures"), 0);
                    assert_eq!(count(&target, "SELECT count(*) FROM e2_origin_seals"), 1);
                } else {
                    for _ in 0..512 {
                        wire.transfer().await.unwrap();
                        if !receiver.tick().unwrap() {
                            break;
                        }
                    }
                    assert_eq!(count(&target, "SELECT count(*) FROM captures"), 1);
                    assert_eq!(
                        count(&target, "SELECT count(*) FROM e2_pending_signatures"),
                        0
                    );
                    assert_eq!(count(&target, "SELECT count(*) FROM e2_originals"), 2);
                }
                wire.abort(Error::Disconnected);
                wire.assert_closed();
            }
            target.reopen_candidate().unwrap();
            exchange(&lab, &lab.b, &target, false).await;
            assert_eq!(signatures(&lab.b), signatures(&target));
            assert_eq!(count(&target, "SELECT count(*) FROM captures"), 2);
        }
    });
}

#[test]
fn r8_s20_valid_signed_review_and_foreign_head_cannot_override_local_authority() {
    native_io_lab::execute(async {
        let lab = Lab::with_review_history(true);
        let session = Uuid::new_v4();
        let ao = lab.a.owner();
        let bo = lab.b.owner();
        let sa = SignedImportStore::synthetic(ao.store());
        let sb = SignedImportStore::synthetic(bo.store());
        let at = lab.trust(&lab.a, &lab.b, session);
        let bt = lab.trust(&lab.b, &lab.a, session);
        let (wire, ta, tb) = connect(&lab, &lab.a, &lab.b, session).await;
        let cancel = Cancellation::default();
        let mut a = SyncEngine::start(&sa, ta, &at, &Clock, &cancel).unwrap();
        let mut b = SyncEngine::start(&sb, tb, &bt, &Clock, &cancel).unwrap();
        let mut edited = None;
        let mut finished = false;
        let original = ao
            .store()
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT current_revision_id FROM knowledge_objects",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap();
        for _ in 0..512 {
            wire.transfer().await.unwrap();
            let aa = a.tick().unwrap();
            let bb = b.tick().unwrap();
            if edited.is_none() && count(&lab.b, "SELECT count(*) FROM knowledge_objects") > 0 {
                let object = bo
                    .store()
                    .connection
                    .lock()
                    .unwrap()
                    .query_row("SELECT id FROM knowledge_objects", [], |r| {
                        r.get::<_, String>(0)
                    })
                    .unwrap();
                f::edit_id(bo.store(), &object, "Independent local head");
                let head = bo.store().current_revision_id_of(&object).unwrap().unwrap();
                edited = Some((object, head));
                b.refresh().unwrap();
            } else if !aa && !bb {
                finished = true;
                break;
            }
        }
        assert!(
            finished,
            "signed G5 history must quiesce without a false clean state"
        );
        let (object, head) = edited.unwrap();
        assert_eq!(
            bo.store().current_revision_id_of(&object).unwrap().unwrap(),
            head
        );
        assert_eq!(
            ao.store().current_revision_id_of(&object).unwrap().unwrap(),
            original
        );
        assert_eq!(count(&lab.b,"SELECT count(*) FROM revision_proposals WHERE state IN('approved','edited_approved')"),0);
        assert!(a.needs_attention && b.needs_attention);
        assert_ne!(a.status, SyncStatus::CleanlyApplied);
        assert_ne!(b.status, SyncStatus::CleanlyApplied);
    });
}
async fn no_ack(wire: &Pair, source: &mut TlsTransport) {
    wire.transfer().await.unwrap();
    while let Some(m) = source.receive().unwrap() {
        assert!(!matches!(m.payload,Payload::Receipt(r) if r.outcome.is_ack()));
    }
}

#[test]
fn r8_same_event_id_with_a_different_validly_signed_core_is_integrity_failure() {
    native_io_lab::execute(async {
        let lab = Lab::new();
        exchange(&lab, &lab.a, &lab.b, false).await;
        let (event, _) = metadata(&lab, 0);
        let mut core = crate::sync_api::codec::decode_core_strict(&event.bytes).unwrap();
        let crate::sync_api::codec::Operation::RecordCreate(row) = &mut core.operations[0] else {
            panic!("project create")
        };
        row.after.insert(
            "name".into(),
            crate::sync_api::codec::FieldValue::Text("contradictory signed core".into()),
        );
        let bytes = crate::sync_api::codec::encode_canonical(&core).unwrap();
        let mut forged = event.clone();
        forged.identity.hash = crate::sync_api::codec::journal_event_hash(&bytes);
        forged.bytes = bytes;
        let ao = lab.a.owner();
        let key =
            crate::storage::device_identity_store::OwnedDeviceIdentity::reopen(ao.store()).unwrap();
        let session = Uuid::new_v4();
        let binding = hello(&lab.a, &lab.b, session);
        let signature = SignedOriginal::sign(binding.network, &forged, &key)
            .unwrap()
            .bytes()
            .unwrap();
        let signed = SignedMetadata {
            identity: forged.identity.clone(),
            bytes: signature,
        };
        let (wire, mut source, target) = connect(&lab, &lab.a, &lab.b, session).await;
        let bo = lab.b.owner();
        let store = SignedImportStore::synthetic(bo.store());
        let trust = lab.trust(&lab.b, &lab.a, session);
        let cancel = Cancellation::default();
        let before = signatures(&lab.b);
        let mut receiver = SyncEngine::start(&store, target, &trust, &Clock, &cancel).unwrap();
        source.send(signed_hello(&binding)).unwrap();
        wire.transfer().await.unwrap();
        receiver.tick().unwrap();
        assert_eq!(
            feed(&wire, &mut source, &binding, &mut receiver, &forged, signed).await,
            Err(Error::Integrity)
        );
        assert_eq!(signatures(&lab.b), before);
        no_ack(&wire, &mut source).await;
    });
}

#[test]
fn r8_s04_s19_metadata_is_required_bounded_unique_and_never_unsigned() {
    native_io_lab::execute(async {
        for mode in 0..8 {
            let lab = Lab::new();
            let session = Uuid::new_v4();
            let binding = hello(&lab.a, &lab.b, session);
            let (wire, mut source, target) = connect(&lab, &lab.a, &lab.b, session).await;
            let bo = lab.b.owner();
            let store = SignedImportStore::synthetic(bo.store());
            let trust = lab.trust(&lab.b, &lab.a, session);
            let cancel = Cancellation::default();
            let mut receiver = SyncEngine::start(&store, target, &trust, &Clock, &cancel).unwrap();
            source.send(signed_hello(&binding)).unwrap();
            wire.transfer().await.unwrap();
            receiver.tick().unwrap();
            let (event, signed) = metadata(&lab, 0);
            if mode == 1 {
                source
                    .send(message(
                        &binding,
                        Payload::Chunk(chunk_event(&event).remove(0)),
                    ))
                    .unwrap();
                wire.transfer().await.unwrap();
                assert_eq!(receiver.tick(), Err(Error::Protocol));
            } else if mode == 4 || mode == 5 {
                let mut oversized = signed.clone();
                oversized.bytes = vec![
                    0;
                    if mode == 4 {
                        MAX_SIGNED_METADATA + 1
                    } else {
                        0
                    }
                ];
                assert_eq!(
                    source.send(message(&binding, Payload::SignedMetadata(oversized))),
                    Err(Error::Limit)
                );
                no_publication(&lab.b);
                wire.abort(Error::Disconnected);
                continue;
            } else {
                source
                    .send(message(&binding, Payload::SignedMetadata(signed.clone())))
                    .unwrap();
                wire.transfer().await.unwrap();
                receiver.tick().unwrap();
                match mode {
                    0 => {
                        source
                            .send(message(&binding, Payload::SignedMetadata(signed)))
                            .unwrap();
                        wire.transfer().await.unwrap();
                        assert_eq!(receiver.tick(), Err(Error::Protocol));
                    }
                    2 => {
                        assert!(!receiver.tick().unwrap());
                        assert_eq!(receiver.status, SyncStatus::Syncing);
                    }
                    3 => {
                        let bytes = vec![b' '; CHUNK];
                        source
                            .send(message(
                                &binding,
                                Payload::Chunk(Chunk {
                                    identity: event.identity,
                                    index: 0,
                                    count: 2,
                                    total: CHUNK + 1,
                                    digest: crate::sync_api::codec::journal_event_hash(&bytes),
                                    bytes,
                                }),
                            ))
                            .unwrap();
                        wire.transfer().await.unwrap();
                        receiver.tick().unwrap();
                        assert_eq!(receiver.status, SyncStatus::Syncing);
                    }
                    6 => {
                        let mut next = signed.clone();
                        next.identity.event = Uuid::new_v4();
                        source
                            .send(message(&binding, Payload::SignedMetadata(next)))
                            .unwrap();
                        wire.transfer().await.unwrap();
                        receiver.tick().unwrap();
                        let mut last = signed;
                        last.identity.event = Uuid::new_v4();
                        source
                            .send(message(&binding, Payload::SignedMetadata(last)))
                            .unwrap();
                        wire.transfer().await.unwrap();
                        assert_eq!(receiver.tick(), Err(Error::Limit));
                    }
                    _ => {
                        source
                            .send(message(
                                &binding,
                                Payload::SnapshotOffer(crate::sync_api::bootstrap::SnapshotOffer {
                                    id: Uuid::new_v4(),
                                    hash: [0; 32],
                                    bytes: 1,
                                    chunks: 1,
                                }),
                            ))
                            .unwrap();
                        wire.transfer().await.unwrap();
                        assert_eq!(receiver.tick(), Err(Error::Protocol));
                    }
                }
            }
            no_publication(&lab.b);
            no_ack(&wire, &mut source).await;
            wire.abort(Error::Disconnected);
            wire.assert_closed();
        }
    });
}

#[test]
fn r8_s19_legacy_hello_cannot_downgrade_a_signed_receiver() {
    native_io_lab::execute(async {
        let lab = Lab::new();
        let session = Uuid::new_v4();
        let (wire, mut source, target) = connect(&lab, &lab.a, &lab.b, session).await;
        let owner = lab.b.owner();
        let store = SignedImportStore::synthetic(owner.store());
        let trust = lab.trust(&lab.b, &lab.a, session);
        let cancel = Cancellation::default();
        let mut receiver = SyncEngine::start(&store, target, &trust, &Clock, &cancel).unwrap();
        let p = SyncProfile::LedgerCandidate;
        source
            .send(message(
                &hello(&lab.a, &lab.b, session),
                Payload::Hello {
                    version: p.version(),
                    required: p.features(),
                    supported: p.features(),
                    profile: p.name().into(),
                },
            ))
            .unwrap();
        wire.transfer().await.unwrap();
        assert_eq!(receiver.tick(), Err(Error::Protocol));
        no_publication(&lab.b);
        no_ack(&wire, &mut source).await;
    });
}

#[test]
fn r8_s22_test_trust_is_not_signed_membership_and_production_stays_closed() {
    let lab = Lab::new();
    let owner = lab.a.owner();
    let binding = hello(&lab.a, &lab.b, Uuid::new_v4());
    let fake = crate::sync_api::trust::TestTrust {
        hello: binding.clone(),
        expires: 100,
        origins: lab.origins.clone(),
    }
    .verify(&binding)
    .unwrap();
    let store = SignedImportStore::synthetic(owner.store());
    assert!(matches!(
        store.summary(&fake, &Clock, &Cancellation::default()),
        Err(Error::Trust)
    ));
    assert!(matches!(
        SignedImportStore::production(owner.store()),
        Err(Error::ActivationPending)
    ));
    assert!(ClosedTrust.verify(&binding).is_err());
    assert!(crate::sync_api::security::transport::ClosedLan
        .dial("192.168.1.2:7431")
        .is_err());
    assert_eq!(super::super::migrations::SCHEMA_VERSION, 9);
    assert_eq!(super::super::migrations::STEPS.len(), 9);
}

#[test]
fn r8_s19_signed_metadata_cannot_change_the_legacy_profile() {
    native_io_lab::execute(async {
        let lab = Lab::new();
        let session = Uuid::new_v4();
        let binding = hello(&lab.a, &lab.b, session);
        let (wire, mut source, target) = connect(&lab, &lab.a, &lab.b, session).await;
        let owner = lab.b.owner();
        let store = crate::storage::sync_store::CandidateSyncStore::synthetic(owner.store());
        let trust = lab.trust(&lab.b, &lab.a, session);
        let cancel = Cancellation::default();
        let mut receiver = SyncEngine::start(&store, target, &trust, &Clock, &cancel).unwrap();
        let p = SyncProfile::LedgerCandidate;
        source
            .send(message(
                &binding,
                Payload::Hello {
                    version: p.version(),
                    required: p.features(),
                    supported: p.features(),
                    profile: p.name().into(),
                },
            ))
            .unwrap();
        wire.transfer().await.unwrap();
        receiver.tick().unwrap();
        source
            .send(message(
                &binding,
                Payload::SignedMetadata(metadata(&lab, 0).1),
            ))
            .unwrap();
        wire.transfer().await.unwrap();
        assert_eq!(receiver.tick(), Err(Error::Protocol));
        no_publication(&lab.b);
        no_ack(&wire, &mut source).await;
    });
}

#[test]
fn r8_valid_tls_possession_without_registry_membership_has_no_signed_ingress() {
    native_io_lab::execute(async {
        let lab = Lab::new();
        let stranger = Fixture::new().unwrap();
        let session = Uuid::new_v4();
        let root = NetworkRegistry::candidate(lab.b.owner().store())
            .unwrap()
            .root()
            .unwrap();
        let bh = PeerHello {
            network: root.network,
            epoch: root.epoch,
            session,
            local: lab.b.public.peer_id(),
            peer: stranger.public.peer_id(),
        };
        let sh = PeerHello {
            local: bh.peer,
            peer: bh.local,
            ..bh.clone()
        };
        let (wire, mut source, target) = Pair::connect(
            stranger.key(CertificateRole::Server).unwrap(),
            lab.b.key(CertificateRole::Client).unwrap(),
            [sh, bh.clone()],
            [&stranger.public, &lab.b.public],
        )
        .await
        .unwrap();
        let snapshot = MembershipBinding {
            root,
            local: bh.local,
            peer: stranger.public.clone(),
        };
        let trust = RegistryTrust::qualification(bh, snapshot, 100, lab.origins.clone()).unwrap();
        let owner = lab.b.owner();
        let store = SignedImportStore::synthetic(owner.store());
        let cancel = Cancellation::default();
        assert!(matches!(
            SyncEngine::start(&store, target, &trust, &Clock, &cancel),
            Err(Error::Trust)
        ));
        wire.transfer().await.unwrap();
        assert!(source.receive().unwrap().is_none());
        no_publication(&lab.b);
    });
}

#[test]
fn r8_s08_new_committed_incarnation_is_unsupported_without_overwriting_a_seal() {
    native_io_lab::execute(async {
        let lab = Lab::new();
        exchange(&lab, &lab.a, &lab.b, false).await;
        let before = signatures(&lab.b);
        let first = metadata(&lab, 0).0;
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
            "Genuine local commit after incarnation rotation",
        );
        let newest = owner
            .store()
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT event_id FROM sync_bundles ORDER BY rowid DESC LIMIT 1",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap();
        let event = sync_store::test_events(owner.store())
            .into_iter()
            .find(|e| e.identity.event.to_string() == newest)
            .unwrap();
        assert_ne!(event.identity.incarnation, first.identity.incarnation);
        let store = SignedImportStore::synthetic(owner.store());
        let export = store
            .export_signed(
                &lab.session(&lab.a, &lab.b),
                &event.identity,
                &Clock,
                &Cancellation::default(),
            )
            .unwrap();
        let session = Uuid::new_v4();
        let binding = hello(&lab.a, &lab.b, session);
        let (wire, mut source, target) = connect(&lab, &lab.a, &lab.b, session).await;
        let receiver_owner = lab.b.owner();
        let receiver_store = SignedImportStore::synthetic(receiver_owner.store());
        let trust = lab.trust(&lab.b, &lab.a, session);
        let cancel = Cancellation::default();
        let mut receiver =
            SyncEngine::start(&receiver_store, target, &trust, &Clock, &cancel).unwrap();
        source.send(signed_hello(&binding)).unwrap();
        wire.transfer().await.unwrap();
        receiver.tick().unwrap();
        feed(
            &wire,
            &mut source,
            &binding,
            &mut receiver,
            &export.event,
            export.metadata,
        )
        .await
        .unwrap();
        assert_eq!(receiver.status, SyncStatus::UnsupportedImportPolicy);
        assert_eq!(signatures(&lab.b), before);
        assert_eq!(count(&lab.b, "SELECT count(*) FROM captures"), 1);
        assert_eq!(count(&lab.b, "SELECT max(applied) FROM import_progress"), 2);
        assert_eq!(count(&lab.b, "SELECT seq FROM e2_origin_seals"), 2);
        no_ack(&wire, &mut source).await;
    });
}

#[test]
fn r8_s14_missing_predecessor_never_seals_and_exact_retry_recovers() {
    native_io_lab::execute(async {
        let lab = Lab::new();
        let session = Uuid::new_v4();
        let binding = hello(&lab.a, &lab.b, session);
        let (wire, mut source, target) = connect(&lab, &lab.a, &lab.b, session).await;
        let owner = lab.b.owner();
        let store = SignedImportStore::synthetic(owner.store());
        let trust = lab.trust(&lab.b, &lab.a, session);
        let cancel = Cancellation::default();
        let mut receiver = SyncEngine::start(&store, target, &trust, &Clock, &cancel).unwrap();
        source.send(signed_hello(&binding)).unwrap();
        wire.transfer().await.unwrap();
        receiver.tick().unwrap();
        let (second, signature) = metadata(&lab, 1);
        feed(
            &wire,
            &mut source,
            &binding,
            &mut receiver,
            &second,
            signature.clone(),
        )
        .await
        .unwrap();
        no_publication(&lab.b);
        assert_eq!(count(&lab.b, "SELECT count(*) FROM e2_quarantine"), 1);
        assert_eq!(receiver.status, SyncStatus::UnsupportedImportPolicy);
        no_ack(&wire, &mut source).await;
        let (first, first_signature) = metadata(&lab, 0);
        feed(
            &wire,
            &mut source,
            &binding,
            &mut receiver,
            &first,
            first_signature,
        )
        .await
        .unwrap();
        feed(
            &wire,
            &mut source,
            &binding,
            &mut receiver,
            &second,
            signature,
        )
        .await
        .unwrap();
        assert_eq!(count(&lab.b, "SELECT count(*) FROM e2_originals"), 2);
        assert_eq!(count(&lab.b, "SELECT count(*) FROM e2_quarantine"), 0);
        assert_eq!(count(&lab.b, "SELECT max(applied) FROM import_progress"), 2);
    });
}

#[test]
fn r8_s15_revocation_and_origin_permission_changes_after_tls_refuse_import() {
    native_io_lab::execute(async {
        for origin_only in [true, false] {
            let lab = Lab::new();
            let session = Uuid::new_v4();
            let binding = hello(&lab.a, &lab.b, session);
            let (event, signed) = metadata(&lab, 0);
            let (wire, mut source, target) = connect(&lab, &lab.a, &lab.b, session).await;
            let owner = lab.b.owner();
            let store = SignedImportStore::synthetic(owner.store());
            let trust = lab.trust(&lab.b, &lab.a, session);
            let cancel = Cancellation::default();
            let mut receiver = SyncEngine::start(&store, target, &trust, &Clock, &cancel).unwrap();
            source.send(signed_hello(&binding)).unwrap();
            wire.transfer().await.unwrap();
            receiver.tick().unwrap();
            if origin_only {
                owner
                    .store()
                    .connection
                    .lock()
                    .unwrap()
                    .execute("UPDATE import_origin_permissions SET enabled=0", [])
                    .unwrap();
            } else {
                let registry = NetworkRegistry::candidate(owner.store()).unwrap();
                let update = registry
                    .next(
                        Action::Revoke {
                            device: lab.a.public.clone(),
                        },
                        &lab.admin.0,
                    )
                    .unwrap();
                registry.apply(&update).unwrap();
            }
            let result = feed(&wire, &mut source, &binding, &mut receiver, &event, signed).await;
            assert!(
                matches!(result, Err(Error::Trust | Error::Cancelled)),
                "{result:?}"
            );
            no_publication(&lab.b);
            wire.abort(Error::Disconnected);
            wire.assert_closed();
        }
    });
}

#[test]
fn r8_s16_s17_s18_signed_commit_failures_never_ack_and_reopen_reconciles() {
    native_io_lab::execute(async {
        for committed_cleanup in [false, true] {
            let mut lab = Lab::new();
            let session = Uuid::new_v4();
            let binding = hello(&lab.a, &lab.b, session);
            let (event, signed) = metadata(&lab, 0);
            {
                let (wire, mut source, target) = connect(&lab, &lab.a, &lab.b, session).await;
                let ao = lab.a.owner();
                let bo = lab.b.owner();
                let sender = SignedImportStore::synthetic(ao.store());
                let offered = lab.trust(&lab.a, &lab.b, session).verify(&binding).unwrap();
                let cancel = Cancellation::default();
                sender
                    .offered(&offered, &event.identity, &Clock, &cancel)
                    .unwrap();
                let store = if committed_cleanup {
                    SignedImportStore::admitted_for_test(f::physically_admitted(bo.store()))
                } else {
                    SignedImportStore::synthetic(bo.store())
                };
                let trust = lab.trust(&lab.b, &lab.a, session);
                let mut receiver =
                    SyncEngine::start(&store, target, &trust, &Clock, &cancel).unwrap();
                source.send(signed_hello(&binding)).unwrap();
                wire.transfer().await.unwrap();
                receiver.tick().unwrap();
                if !committed_cleanup {
                    bo.store().connection.lock().unwrap().execute_batch("CREATE TABLE r8_deferred(peer TEXT REFERENCES import_members(peer) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER r8_failed_commit AFTER INSERT ON import_progress BEGIN INSERT INTO r8_deferred VALUES('absent'); END;").unwrap();
                }
                let guard =
                    committed_cleanup.then(|| f::deny_post_commit_budget_restore(bo.store()));
                let expected = if committed_cleanup {
                    Error::CommittedCleanupFailed
                } else {
                    Error::CommitUncertain
                };
                assert_eq!(
                    feed(&wire, &mut source, &binding, &mut receiver, &event, signed).await,
                    Err(expected)
                );
                assert_eq!(receiver.tick(), Err(expected));
                assert_eq!(
                    count(&lab.b, "SELECT count(*) FROM e2_originals"),
                    i64::from(committed_cleanup)
                );
                assert_eq!(
                    count(&lab.b, "SELECT count(*) FROM import_g3_commits"),
                    i64::from(committed_cleanup)
                );
                if let Some(guard) = guard {
                    assert_eq!(guard.hits(), 1);
                    drop(guard);
                }
                assert_eq!(
                    sender.outstanding(&offered, &Clock, &cancel).unwrap(),
                    vec![event.identity.event]
                );
                no_ack(&wire, &mut source).await;
                wire.abort(Error::Disconnected);
                wire.assert_closed();
            }
            lab.a.reopen_candidate().unwrap();
            lab.b.reopen_candidate().unwrap();
            exchange(&lab, &lab.a, &lab.b, false).await;
            assert_eq!(count(&lab.b, "SELECT count(*) FROM e2_originals"), 2);
            assert_eq!(count(&lab.b, "SELECT max(applied) FROM import_progress"), 2);
            assert_eq!(signatures(&lab.a), signatures(&lab.b));
        }
    });
}
