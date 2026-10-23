//! Conservative D4 admission. No domain commands, inference or review execution.
use super::*;
use crate::storage::{identity_store::VETO_NAMES, relation_store};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Audit {
    candidates_sent: Vec<String>,
    excluded: Vec<Excluded>,
    scores: Vec<Score>,
    runs: u32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Excluded {
    id: String,
    veto: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Score {
    id: String,
    same_min: f64,
    reframing_max: f64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Evidence {
    role: String,
    capture_id: String,
    start: i64,
    end: i64,
}
fn json<T: serde::de::DeserializeOwned>(r: &codec::RowImage, k: &str) -> Result<T> {
    serde_json::from_str(text(r, k)?).map_err(|_| Error::Integrity)
}
fn vetoes(r: &codec::RowImage, k: &str) -> Result<Vec<String>> {
    let v: Vec<String> = json(r, k)?;
    if v.len() > 16 || v.iter().any(|v| !VETO_NAMES.contains(&v.as_str())) {
        return Err(Error::Integrity);
    }
    Ok(v)
}
fn valid_id(id: &str) -> bool {
    codec::validate_canonical_uuid(id).is_ok()
}
pub(super) fn validate_audit(r: &codec::RowImage) -> Result<()> {
    vetoes(r, "vetoes_json")?;
    let a: Audit = json(r, "audit_json")?;
    let unit = |n: f64| n.is_finite() && (0.0..=1.0).contains(&n);
    if a.runs > 16
        || a.candidates_sent.len() > 16
        || a.excluded.len() > 16
        || a.scores.len() > 16
        || a.candidates_sent.iter().any(|id| !valid_id(id))
        || a.excluded
            .iter()
            .any(|x| !valid_id(&x.id) || !VETO_NAMES.contains(&x.veto.as_str()))
        || a.scores
            .iter()
            .any(|x| !valid_id(&x.id) || !unit(x.same_min) || !unit(x.reframing_max))
    {
        return Err(Error::Integrity);
    }
    Ok(())
}
fn operation_row<'a>(
    v: &'a ValidatedEvent,
    e: EntityKind,
    key: &[String],
) -> Option<&'a codec::RowImage> {
    v.core().operations.iter().find_map(|op| match op {
        Operation::RecordCreate(r) if r.entity == e && r.key == key => Some(&r.after),
        _ => None,
    })
}
fn existing_or_created(
    c: &Connection,
    v: &ValidatedEvent,
    e: EntityKind,
    key: &[String],
) -> Result<Option<codec::RowImage>> {
    if let Some(r) = operation_row(v, e, key) {
        Ok(Some(r.clone()))
    } else {
        sql_effects::reread(c, e, key).map_err(|_| Error::Storage)
    }
}
fn initial(r: &codec::RowImage) -> Result<bool> {
    Ok(text(r, "state")? == "open"
        && r.get("created_at") == r.get("updated_at")
        && [
            "resolved_at",
            "resolved_method",
            "resolved_object_id",
            "resolved_revision_id",
            "deferred_at",
            "reviewed_at",
            "final_body",
            "result_revision_id",
        ]
        .iter()
        .all(|f| r.get(*f).is_none_or(|v| *v == FieldValue::Null)))
}
pub(super) fn admitted(c: &Connection, v: &ValidatedEvent) -> Result<bool> {
    for op in &v.core().operations {
        match op {
            Operation::RecordCreate(r) => match r.entity {
                EntityKind::Relations => {
                    let kind = text(&r.after, "kind")?;
                    let source = text(&r.after, "source_object_id")?;
                    let target = text(&r.after, "target_object_id")?;
                    if relation_store::canonical_ends(kind, source, target)
                        != (source.into(), target.into())
                        || source == target
                    {
                        return Err(Error::Integrity);
                    }
                }
                EntityKind::IdentityDecisions => {
                    validate_audit(&r.after)?;
                    if text(&r.after,"outcome")?=="uncertain" && !v.core().operations.iter().any(|op|matches!(op,Operation::RecordCreate(p) if p.entity==EntityKind::PendingClaims && p.after.get("capture_id")==r.after.get("capture_id") && p.after.get("ordinal")==r.after.get("ordinal"))) {return Ok(false);}
                }
                EntityKind::PendingClaims => {
                    if !initial(&r.after)? {
                        return Ok(false);
                    }
                    let reasons = vetoes(&r.after, "reasons_json")?;
                    let key = vec![
                        text(&r.after, "capture_id")?.into(),
                        match r.after.get("ordinal") {
                            Some(FieldValue::Decimal(n)) => n.clone(),
                            _ => return Err(Error::Integrity),
                        },
                    ];
                    let Some(decision) =
                        existing_or_created(c, v, EntityKind::IdentityDecisions, &key)?
                    else {
                        return Ok(false);
                    };
                    let expected = vetoes(&decision, "vetoes_json")?;
                    let reframing = expected.iter().any(|s| {
                        ["fundamental_reframing", "reframing_signal"].contains(&s.as_str())
                    });
                    if reasons != expected
                        || r.after.get("reframing")
                            != Some(&FieldValue::Decimal(
                                if reframing { "1" } else { "0" }.into(),
                            ))
                    {
                        return Err(Error::Integrity);
                    }
                    let ids: Vec<String> = json(&r.after, "candidate_ids_json")?;
                    if ids.iter().any(|id| !valid_id(id)) {
                        return Err(Error::Integrity);
                    }
                }
                EntityKind::RevisionProposals => {
                    if !initial(&r.after)?
                        || r.after.get("user_edited") != Some(&FieldValue::Decimal("0".into()))
                    {
                        return Ok(false);
                    }
                    let object = text(&r.after, "object_id")?;
                    let base = text(&r.after, "base_revision_id")?;
                    let Some(o) =
                        existing_or_created(c, v, EntityKind::KnowledgeObjects, &[object.into()])?
                    else {
                        return Ok(false);
                    };
                    // v9's historical base guard is not disabled. A stale base
                    // needs a reviewed historical-validation extension first.
                    if o.get("current_revision_id") != Some(&FieldValue::Text(base.into())) {
                        return Ok(false);
                    }
                    let proof: Vec<Evidence> = json(&r.after, "evidence_json")?;
                    if proof.is_empty() || proof.len() > 13 {
                        return Err(Error::Integrity);
                    }
                    let claim = text(&r.after, "pending_claim_id")?;
                    let Some(p) =
                        existing_or_created(c, v, EntityKind::PendingClaims, &[claim.into()])?
                    else {
                        return Ok(false);
                    };
                    let mut claim_evidence = false;
                    for e in proof {
                        if !["claim", "existing"].contains(&e.role.as_str())
                            || e.start < 0
                            || e.end <= e.start
                        {
                            return Err(Error::Integrity);
                        }
                        let Some(cap) = existing_or_created(
                            c,
                            v,
                            EntityKind::Captures,
                            &[e.capture_id.clone()],
                        )?
                        else {
                            return Ok(false);
                        };
                        crate::storage::knowledge_store::validate_span(
                            text(&cap, "content")?,
                            e.start,
                            e.end,
                        )
                        .map_err(|_| Error::Integrity)?;
                        if e.role == "claim" {
                            if p.get("capture_id") != Some(&FieldValue::Text(e.capture_id))
                                || p.get("source_start")
                                    != Some(&FieldValue::Decimal(e.start.to_string()))
                                || p.get("source_end")
                                    != Some(&FieldValue::Decimal(e.end.to_string()))
                            {
                                return Err(Error::Integrity);
                            }
                            claim_evidence = true;
                        } else {
                            let source:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM object_sources WHERE object_id=?1 AND capture_id=?2 AND source_start=?3 AND source_end=?4)",params![object,e.capture_id,e.start,e.end],|r|r.get(0)).map_err(|_|Error::Storage)?;
                            let ancestor:bool=c.query_row("WITH RECURSIVE ancestry(id) AS (SELECT ?1 UNION SELECT p.parent_revision_id FROM revision_parents p JOIN ancestry a ON p.child_revision_id=a.id) SELECT EXISTS(SELECT 1 FROM revision_evidence e JOIN ancestry a ON a.id=e.revision_id WHERE e.object_id=?2 AND e.capture_id=?3 AND e.source_start=?4 AND e.source_end=?5)",params![base,object,e.capture_id,e.start,e.end],|r|r.get(0)).map_err(|_|Error::Storage)?;
                            if !source && !ancestor {
                                return Err(Error::Integrity);
                            }
                        }
                    }
                    if !claim_evidence {
                        return Err(Error::Integrity);
                    }
                    if let Some(FieldValue::Text(retracts)) = r.after.get("retracts_revision_id") {
                        let Some(FieldValue::Decimal(ordinal)) = r.after.get("retracts_ordinal")
                        else {
                            return Err(Error::Integrity);
                        };
                        let proved:bool=c.query_row("WITH RECURSIVE ancestry(id) AS (SELECT ?1 UNION SELECT p.parent_revision_id FROM revision_parents p JOIN ancestry a ON p.child_revision_id=a.id) SELECT EXISTS(SELECT 1 FROM revision_evidence e JOIN ancestry a ON a.id=e.revision_id WHERE e.object_id=?2 AND e.revision_id=?3 AND e.ordinal=?4)",params![base,object,retracts,ordinal],|r|r.get(0)).map_err(|_|Error::Storage)?;
                        if !proved {
                            return Err(Error::Integrity);
                        }
                    }
                }
                _ => {}
            },
            Operation::FacetUpdate(u) => {
                // G5 has no authenticated historical actor/signature contract
                // in this codec. Every review transition stays an original fact.
                if !matches!(
                    u.entity,
                    EntityKind::Projects | EntityKind::Captures | EntityKind::KnowledgeObjects
                ) {
                    return Ok(false);
                }
                // Imported-owned chains only: local head precedence/replay must
                // never be guessed across independently authored histories.
                let local:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sync_entity_heads WHERE entity_kind=?1 AND entity_key=?2)",params![u.entity.as_str(),serde_json::to_string(&u.key).map_err(|_|Error::Integrity)?],|r|r.get(0)).map_err(|_|Error::Storage)?;
                if local {
                    return Ok(false);
                }
                if sql_effects::reread(c, u.entity, &u.key)
                    .map_err(|_| Error::Storage)?
                    .as_ref()
                    != Some(&u.before)
                {
                    return Ok(false);
                }
                for (f, p) in &u.expected {
                    let Some(r) = &p.event_ref else {
                        return Ok(false);
                    };
                    let Some(prior) = crate::storage::sync_store::reference(c, r)? else {
                        return Ok(false);
                    };
                    let previous = prior
                        .operations
                        .iter()
                        .find_map(|op| match op {
                            Operation::RecordCreate(row)
                                if row.entity == u.entity && row.key == u.key =>
                            {
                                Some(&row.after)
                            }
                            Operation::FacetUpdate(row)
                                if row.entity == u.entity && row.key == u.key =>
                            {
                                Some(&row.after)
                            }
                            _ => None,
                        })
                        .ok_or(Error::Integrity)?;
                    if codec::hash_hex(
                        &stream::facet_hash(u.entity, &u.key, f, previous)
                            .map_err(|_| Error::Integrity)?,
                    ) != p.before_hash
                    {
                        return Err(Error::Integrity);
                    }
                }
                if u.entity == EntityKind::Projects {
                    let name = text(&u.after, "name")?;
                    if name.trim() != name || name.is_empty() || name.chars().count() > 80 {
                        return Err(Error::Integrity);
                    }
                }
                if u.entity == EntityKind::KnowledgeObjects && u.expected.contains_key("head") {
                    let revision = text(&u.after, "current_revision_id")?;
                    let Some(r) = existing_or_created(
                        c,
                        v,
                        EntityKind::ThoughtRevisions,
                        &[revision.into()],
                    )?
                    else {
                        return Ok(false);
                    };
                    if r.get("object_id") != u.after.get("id")
                        || ["kind", "title", "body"]
                            .iter()
                            .any(|f| r.get(*f) != u.after.get(*f))
                    {
                        return Err(Error::Integrity);
                    }
                }
            }
            Operation::RelationRemove(r) => {
                let codec::ObservedCreate::Event(reference) = &r.observed_create else {
                    return Ok(false);
                };
                let Some(prior) = crate::storage::sync_store::reference(c, reference)? else {
                    return Ok(false);
                };
                if text(&r.before,"origin")?!="model" || !prior.operations.iter().any(|op|matches!(op,Operation::RecordCreate(row) if row.entity==EntityKind::Relations && row.key==r.key && row.after==r.before)) {return Err(Error::Integrity);}
                let claim: Option<String> = c
                    .query_row(
                        "SELECT event FROM import_creates WHERE entity='relations' AND key_json=?1",
                        [serde_json::to_string(&r.key).map_err(|_| Error::Integrity)?],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|_| Error::Storage)?;
                if claim.as_deref() != Some(reference.event_id.as_str()) {
                    return Ok(false);
                }
                if sql_effects::reread(c, EntityKind::Relations, &r.key)
                    .map_err(|_| Error::Storage)?
                    .as_ref()
                    != Some(&r.before)
                {
                    return Ok(false);
                }
            }
        }
    }
    Ok(true)
}
pub(super) fn apply_transitions(c: &Connection, v: &ValidatedEvent) -> Result<()> {
    for op in &v.core().operations {
        match op {
            Operation::FacetUpdate(u) => {
                scoped_row(c, u.entity, &u.after, Some(&u.before))?;
                if sql_effects::reread(c, u.entity, &u.key)
                    .map_err(|_| Error::Storage)?
                    .as_ref()
                    != Some(&u.after)
                {
                    return Err(Error::Integrity);
                }
            }
            Operation::RelationRemove(r) => {
                scoped_effect(c, EntityKind::Relations, &r.before, Some(&r.before), true)?;
                if sql_effects::reread(c, EntityKind::Relations, &r.key)
                    .map_err(|_| Error::Storage)?
                    .is_some()
                {
                    return Err(Error::Integrity);
                }
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn d4_18_callback_is_single_use_stale_statement_and_rollback_revoke_it() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = Connection::open(dir.path().join("callback.sqlite")).unwrap();
        let tx = c
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        let active = Arc::new(AtomicBool::new(true));
        register(
            &tx,
            Some(Grant {
                active: active.clone(),
                entity: "projects".into(),
                row: serde_json::json!({"id":"exact"}),
                before: None,
                deleting: false,
            }),
        )
        .unwrap();
        let grant = ScopedGrant {
            connection: &tx,
            active: active.clone(),
        };
        let mut statement=tx.prepare("SELECT arthur_g3_row('projects','{\"id\":\"exact\"}',NULL) UNION ALL SELECT arthur_g3_row('projects','{\"id\":\"exact\"}',NULL)").unwrap();
        let mut rows = statement.query([]).unwrap();
        assert_eq!(rows.next().unwrap().unwrap().get::<_, i64>(0).unwrap(), 1);
        // SQLite refuses replacement while this VM is active, but the stale
        // callback has already lost its one-use native capability.
        assert!(grant.revoke().is_err());
        assert!(!active.load(Ordering::SeqCst));
        assert_eq!(rows.next().unwrap().unwrap().get::<_, i64>(0).unwrap(), 0);
        drop(rows);
        drop(statement);
        drop(grant);
        tx.rollback().unwrap();
        assert!(c
            .query_row(
                "SELECT arthur_g3_row('projects','{\"id\":\"exact\"}',NULL)",
                [],
                |r| r.get::<_, i64>(0)
            )
            .is_err());
    }
    #[test]
    fn d4_18_panic_unwind_revokes_native_callback_before_next_transaction() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = Connection::open(dir.path().join("panic.sqlite")).unwrap();
        let active = Arc::new(AtomicBool::new(true));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let tx = c.transaction().unwrap();
            register(
                &tx,
                Some(Grant {
                    active: active.clone(),
                    entity: "projects".into(),
                    row: serde_json::json!({}),
                    before: None,
                    deleting: false,
                }),
            )
            .unwrap();
            let _grant = ScopedGrant {
                connection: &tx,
                active: active.clone(),
            };
            panic!("synthetic cancellation unwind");
        }));
        assert!(result.is_err());
        assert!(c.is_autocommit());
        assert!(!active.load(Ordering::SeqCst));
        let tx = c.transaction().unwrap();
        assert!(tx
            .query_row("SELECT arthur_g3_row('projects','{}',NULL)", [], |r| r
                .get::<_, i64>(0))
            .is_err());
        tx.rollback().unwrap();
    }
    #[test]
    fn d4_18_concurrent_disk_writer_cannot_use_the_owner_callback() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("concurrent.sqlite");
        let mut owner = Connection::open(&path).unwrap();
        owner
            .execute_batch("CREATE TABLE witness(id TEXT)")
            .unwrap();
        let outsider = Connection::open(&path).unwrap();
        outsider.busy_timeout(std::time::Duration::ZERO).unwrap();
        let tx = owner
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        let active = Arc::new(AtomicBool::new(true));
        register(
            &tx,
            Some(Grant {
                active: active.clone(),
                entity: "projects".into(),
                row: serde_json::json!({}),
                before: None,
                deleting: false,
            }),
        )
        .unwrap();
        let grant = ScopedGrant {
            connection: &tx,
            active,
        };
        assert!(outsider
            .query_row("SELECT arthur_g3_row('projects','{}',NULL)", [], |r| r
                .get::<_, i64>(0))
            .is_err());
        assert_eq!(
            outsider
                .execute("INSERT INTO witness VALUES('unauthorized')", [])
                .unwrap_err()
                .sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy)
        );
        drop(grant);
        tx.rollback().unwrap();
        assert_eq!(
            outsider
                .query_row("SELECT count(*) FROM witness", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
