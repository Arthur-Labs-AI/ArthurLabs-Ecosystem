//! Explicit dormant expiry candidate. No clock, scheduler or connection owner.
//! Production automatic-expiry policy still requires an owner decision.
use super::{codec, sql_effects as sql};
use crate::storage::identity_store::{self as identity, IdentityStoreError, PendingClaim};
use crate::storage::proposal_store;
use rusqlite::Connection;

type Result<T> = std::result::Result<T, IdentityStoreError>;

/// Engineering safety ceiling only, not an approved scheduling policy. Other
/// existing journal limits can reject an admitted batch atomically as well.
pub(super) const MAX_EXPIRY_BATCH: usize = 32;

pub(super) struct DormantExpiryRequest {
    now: String,
    limit: usize,
}

impl DormantExpiryRequest {
    /// Private explicit request, never constructed from due_at or a method
    /// string. Creating this candidate is not production scheduling approval.
    pub(super) fn candidate(now: &str, limit: usize) -> Result<Self> {
        if limit > MAX_EXPIRY_BATCH || codec::validate_timestamp(now).is_err() {
            return Err(invalid());
        }
        Ok(Self {
            now: now.into(),
            limit,
        })
    }
}

fn invalid() -> IdentityStoreError {
    IdentityStoreError::Invalid("invalid dormant expiry request or persisted closure".into())
}

pub(super) fn select(c: &Connection, request: &DormantExpiryRequest) -> Result<Vec<PendingClaim>> {
    if c.is_autocommit() {
        return Err(invalid());
    }
    identity::due_pending_claims_in(
        c,
        &request.now,
        request.limit,
        identity::DueSelection::Execution,
    )
}

/// Validate actual persisted metadata before resolving. Historical proposal
/// targets may have moved or gained revisions; expiry never applies the draft.
pub(super) fn recheck(
    c: &Connection,
    request: &DormantExpiryRequest,
    id: &str,
) -> Result<Option<PendingClaim>> {
    if c.is_autocommit() {
        return Err(invalid());
    }
    let Some(claim) = identity::due_pending_claim_in(c, id, &request.now)? else {
        return Ok(None);
    };
    let row = sql::reread(c, codec::EntityKind::PendingClaims, &[id.into()])
        .map_err(|_| invalid())?
        .ok_or_else(invalid)?;
    codec::validate_row_image(codec::EntityKind::PendingClaims, &row).map_err(|_| invalid())?;
    let strings = |field| -> Result<Vec<String>> {
        serde_json::from_str(sql::text(&row, field).map_err(|_| invalid())?).map_err(|_| invalid())
    };
    let candidates = strings("candidate_ids_json")?;
    let reasons = strings("reasons_json")?;
    if candidates.is_empty()
        || candidates.len() > identity::MAX_PENDING_CANDIDATES
        || candidates
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != candidates.len()
        || candidates
            .iter()
            .any(|id| codec::validate_id_field(id).is_err())
        || reasons
            .iter()
            .any(|r| !identity::VETO_NAMES.contains(&r.as_str()))
        || claim.resolved_at.is_some()
        || claim.resolved_method.is_some()
        || claim.resolved_object_id.is_some()
        || claim.resolved_revision_id.is_some()
    {
        return Err(invalid());
    }
    if let Some(proposal) = proposal_store::proposal_for_claim_in(c, id)? {
        let row = sql::reread(
            c,
            codec::EntityKind::RevisionProposals,
            std::slice::from_ref(&proposal.id),
        )
        .map_err(|_| invalid())?
        .ok_or_else(invalid)?;
        codec::validate_row_image(codec::EntityKind::RevisionProposals, &row)
            .map_err(|_| invalid())?;
        // The public proposal reader is deliberately tolerant. Execution must
        // reject dropped/malformed evidence entries instead of trusting defaults.
        let evidence: Vec<serde_json::Value> =
            serde_json::from_str(sql::text(&row, "evidence_json").map_err(|_| invalid())?)
                .map_err(|_| invalid())?;
        if evidence.is_empty() || evidence.len() > 13 || evidence.len() != proposal.evidence.len() {
            return Err(invalid());
        }
        for reference in &proposal.evidence {
            if !matches!(reference.role.as_str(), "existing" | "claim") {
                return Err(invalid());
            }
            let content: String = c.query_row(
                "SELECT content FROM captures WHERE id=?1",
                [&reference.capture_id],
                |r| r.get(0),
            )?;
            crate::storage::knowledge_store::validate_span(
                &content,
                reference.start,
                reference.end,
            )
            .map_err(|_| invalid())?;
        }
        let base_matches: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM thought_revisions WHERE id=?1 AND object_id=?2)",
            rusqlite::params![proposal.base_revision_id, proposal.object_id],
            |r| r.get(0),
        )?;
        if proposal.pending_claim_id != claim.id
            || !candidates.contains(&proposal.object_id)
            || !base_matches
            || !matches!(
                proposal.state.as_str(),
                "open" | "deferred" | "rejected" | "superseded"
            )
            || proposal.final_body.is_some()
            || proposal.result_revision_id.is_some()
        {
            return Err(invalid());
        }
    }
    Ok(Some(claim))
}
