//! Typed effect reducer (M05-P1b-B, design section 6).
//!
//! Accepts observed SQL row effects (trigger spool images), resolves every
//! affected logical key to its actual final state through a native-owned
//! projection, and reduces them to closed-vocabulary operations for the
//! future `JournalTx` finalizer.
//!
//! The reducer never opens a SQLite connection. The future `JournalTx` will
//! supply a resolver bound to the owning transaction; tests use an explicit
//! in-memory map. Effects never carry an `applied` flag: only actual
//! before/after row equality decides no-ops, so persisted timestamp changes
//! are kept even when a legacy API reported `applied=false`.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use super::codec::{
    facet_state_hash, hash_hex, validate_hash_hex, validate_id_field, validate_key,
    validate_row_image, Dependency, EntityKind, EventRef, ExpectedFacet, FacetUpdate, FieldValue,
    JournalEvent, ObservedCreate, Operation, RecordCreate, RelationRemove, ReviewAction,
    ReviewMethod, ReviewProof, RowImage, MAX_DEPENDENCIES, MAX_EFFECTS, OPERATION_VERSION,
    PROVENANCE_LOCAL_COMMITTED,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReducerError {
    TooManyEffects(usize),
    TooManyDependencies(usize),
    Codec(super::codec::CodecError),
    InconsistentEffectChain {
        entity: &'static str,
    },
    MissingFinalProjection {
        entity: &'static str,
    },
    UnsupportedDeletion {
        entity: &'static str,
    },
    NonModelEdgeDeletion,
    NetZeroWithIntermediateMutations {
        entity: &'static str,
    },
    IncompleteDependencyClosure {
        entity: &'static str,
    },
    MissingFacetPrior {
        entity: &'static str,
        facet: &'static str,
    },
    MissingCreationProvenance {
        entity: &'static str,
    },
    ContradictoryProvenance {
        entity: &'static str,
    },
    MissingReviewProof {
        entity: &'static str,
    },
    InvalidReviewContext(String),
    TerminalClosureViolation(String),
    JournalUnsupportedEffectSet(String),
}

impl fmt::Display for ReducerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooManyEffects(n) => write!(f, "too many observed effects: {n}"),
            Self::TooManyDependencies(n) => write!(f, "too many dependencies: {n}"),
            Self::Codec(e) => write!(f, "codec: {e}"),
            Self::InconsistentEffectChain { entity } => {
                write!(f, "inconsistent effect chain for {entity}")
            }
            Self::MissingFinalProjection { entity } => {
                write!(f, "missing final projection for {entity}")
            }
            Self::UnsupportedDeletion { entity } => {
                write!(f, "unsupported deletion of {entity}: JOURNAL_UNSUPPORTED_EFFECT_SET")
            }
            Self::NonModelEdgeDeletion => write!(
                f,
                "only MODEL edge removals are observable: JOURNAL_UNSUPPORTED_EFFECT_SET"
            ),
            Self::NetZeroWithIntermediateMutations { entity } => write!(
                f,
                "net-zero multi-step mutation of {entity} is not a no-op: JOURNAL_UNSUPPORTED_EFFECT_SET"
            ),
            Self::IncompleteDependencyClosure { entity } => {
                write!(f, "incomplete dependency closure for {entity}")
            }
            Self::MissingFacetPrior { entity, facet } => write!(
                f,
                "missing causal prior for {entity}.{facet}: supply an explicit facet state"
            ),
            Self::MissingCreationProvenance { entity } => write!(
                f,
                "missing creation provenance for {entity}: neither a journal event nor a legacy baseline"
            ),
            Self::ContradictoryProvenance { entity } => write!(
                f,
                "contradictory creation provenance for {entity}: known journal event and legacy baseline"
            ),
            Self::MissingReviewProof { entity } => {
                write!(f, "state transition of {entity} needs review proof")
            }
            Self::InvalidReviewContext(why) => write!(f, "invalid review context: {why}"),
            Self::TerminalClosureViolation(why) => {
                write!(f, "terminal state violates domain closure: {why}")
            }
            Self::JournalUnsupportedEffectSet(why) => {
                write!(f, "JOURNAL_UNSUPPORTED_EFFECT_SET: {why}")
            }
        }
    }
}

impl std::error::Error for ReducerError {}

impl From<super::codec::CodecError> for ReducerError {
    fn from(value: super::codec::CodecError) -> Self {
        Self::Codec(value)
    }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/// One observed row effect: trigger spool images for a single row mutation.
/// `before` is None for INSERT, `after` is None for DELETE.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedEffect {
    pub entity: EntityKind,
    pub key: Vec<String>,
    pub before: Option<RowImage>,
    pub after: Option<RowImage>,
}

/// Final-state projection owned by native code (future: the owning
/// `JournalTx` transaction). The reducer performs no IO itself.
pub trait FinalStateResolver {
    fn resolve(&self, entity: EntityKind, key: &[String]) -> Option<RowImage>;
}

/// Deterministic in-memory resolver for tests and fixtures.
#[derive(Debug, Default, Clone)]
pub struct MapResolver {
    rows: BTreeMap<(EntityKind, Vec<String>), RowImage>,
}

impl MapResolver {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, entity: EntityKind, key: Vec<String>, image: RowImage) {
        self.rows.insert((entity, key), image);
    }
}

impl FinalStateResolver for MapResolver {
    fn resolve(&self, entity: EntityKind, key: &[String]) -> Option<RowImage> {
        self.rows.get(&(entity, key.to_vec())).cloned()
    }
}

/// Last known creation/reference event per logical record. This answers the
/// record-existence question (same-event, known or explicit baseline) used by
/// dependency closure. It is NOT the causal writer of a mutable facet.
///
/// For immutable catalog records the stored reference identifies the
/// creation event: relations, revisions, evidence and decisions never change,
/// so no "latest update" exists. Relation removal consumes this entry as
/// the observed-create provenance; facet priors are never consulted for it.
pub type KnownRefs = BTreeMap<(EntityKind, Vec<String>), EventRef>;
/// Explicitly acknowledged legacy-baseline records (null event refs).
pub type Baselines = BTreeSet<(EntityKind, Vec<String>)>;

/// Closed per-facet identity. Maps onto the `facet` column of the dormant
/// `sync_entity_heads` table (`record | membership | head | lifecycle`),
/// qualified by entity so the same SQL facet name on different entities
/// stays a distinct causal version. Prefer this over raw facet strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FacetId {
    ProjectRecord,
    ProjectLifecycle,
    CaptureMembership,
    ObjectMembership,
    ObjectHead,
    ClaimLifecycle,
    ProposalLifecycle,
}

impl FacetId {
    /// Closed mapping from a catalog facet name to its identity.
    /// Unknown (entity, facet) pairs are rejected: facets are never invented.
    pub fn of(entity: EntityKind, facet: &str) -> Option<Self> {
        match (entity, facet) {
            (EntityKind::Projects, "record") => Some(Self::ProjectRecord),
            (EntityKind::Projects, "lifecycle") => Some(Self::ProjectLifecycle),
            (EntityKind::Captures, "membership") => Some(Self::CaptureMembership),
            (EntityKind::KnowledgeObjects, "membership") => Some(Self::ObjectMembership),
            (EntityKind::KnowledgeObjects, "head") => Some(Self::ObjectHead),
            (EntityKind::PendingClaims, "lifecycle") => Some(Self::ClaimLifecycle),
            (EntityKind::RevisionProposals, "lifecycle") => Some(Self::ProposalLifecycle),
            _ => None,
        }
    }

    /// Owning entity of this facet.
    pub fn entity(self) -> EntityKind {
        match self {
            Self::ProjectRecord | Self::ProjectLifecycle => EntityKind::Projects,
            Self::CaptureMembership => EntityKind::Captures,
            Self::ObjectMembership | Self::ObjectHead => EntityKind::KnowledgeObjects,
            Self::ClaimLifecycle => EntityKind::PendingClaims,
            Self::ProposalLifecycle => EntityKind::RevisionProposals,
        }
    }

    /// SQL `sync_entity_heads.facet` spelling for the future JournalTx
    /// finalizer, which maintains one head row per (entity, key, facet).
    pub fn sql_facet(self) -> &'static str {
        match self {
            Self::ProjectRecord => "record",
            Self::ProjectLifecycle => "lifecycle",
            Self::CaptureMembership => "membership",
            Self::ObjectMembership => "membership",
            Self::ObjectHead => "head",
            Self::ClaimLifecycle => "lifecycle",
            Self::ProposalLifecycle => "lifecycle",
        }
    }
}

/// Prior causal state of one mutable facet. A committed journal event, or an
/// explicitly established legacy baseline. There is no implicit third case:
/// a missing entry is a typed failure, never a silent baseline grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FacetPrior {
    Event(EventRef),
    LegacyBaseline,
}

/// Independent prior states keyed by (entity, logical key, facet). The future
/// JournalTx finalizer derives these from `sync_entity_heads`: one row per
/// facet, advanced only when that facet is written. A rename must never
/// advance the lifecycle head, and a project move must never advance head.
pub type FacetPriors = BTreeMap<(EntityKind, Vec<String>, FacetId), FacetPrior>;

/// Review context for one claim/proposal state transition. The future
/// `JournalTx` derives this from the owning review call; tests supply it
/// explicitly. Field names mirror `ReviewProof`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewContext {
    pub action: ReviewAction,
    pub proposal_id: Option<String>,
    pub claim_id: Option<String>,
    pub object_id: Option<String>,
    pub reviewed_revision_id: Option<String>,
    pub final_body: Option<String>,
    pub user_edited: Option<bool>,
    pub result_revision_id: Option<String>,
    pub method: Option<ReviewMethod>,
}

impl ReviewContext {
    /// Build the operation-local proof for the transitioned record. Identity
    /// requirements are entity-aware, matching the real domain writers:
    ///
    /// - A state-changing `pending_claims` row needs its real claim ID, which
    ///   must equal the transitioned key. The proposal ID stays explicit when
    ///   a proposal took part (`resolve_unresolved_claim` updates it only if
    ///   one exists) and is null for standalone defer/reopen.
    /// - A state-changing `revision_proposals` row needs its real proposal ID
    ///   (equal to the transitioned key) and the associated claim ID, which
    ///   must equal the row's actual `pending_claim_id`.
    ///
    /// Anything else is a typed failure. No ID is ever invented here.
    fn into_proof_for(
        self,
        entity: EntityKind,
        key: &[String],
        before: &RowImage,
    ) -> Result<ReviewProof, ReducerError> {
        for id in [
            self.proposal_id.as_ref(),
            self.claim_id.as_ref(),
            self.object_id.as_ref(),
            self.reviewed_revision_id.as_ref(),
            self.result_revision_id.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            validate_id_field(id).map_err(ReducerError::Codec)?;
        }
        let row_id = key.first().cloned().unwrap_or_default();
        match entity {
            EntityKind::PendingClaims => match &self.claim_id {
                None => {
                    return Err(ReducerError::InvalidReviewContext(
                        "claim transitions require the real claim id".to_string(),
                    ));
                }
                Some(claim) if claim != &row_id => {
                    return Err(ReducerError::InvalidReviewContext(format!(
                        "claim id {claim} does not identify the transitioned row {row_id}"
                    )));
                }
                _ => {}
            },
            EntityKind::RevisionProposals => {
                match &self.proposal_id {
                    None => {
                        return Err(ReducerError::InvalidReviewContext(
                            "proposal transitions require the real proposal id".to_string(),
                        ));
                    }
                    Some(proposal) if proposal != &row_id => {
                        return Err(ReducerError::InvalidReviewContext(format!(
                            "proposal id {proposal} does not identify the transitioned row {row_id}"
                        )));
                    }
                    _ => {}
                }
                if self.claim_id.is_none() {
                    return Err(ReducerError::InvalidReviewContext(
                        "proposal transitions require the associated claim id".to_string(),
                    ));
                }
                let actual = before.get("pending_claim_id");
                let matches_row = match (&self.claim_id, actual) {
                    (Some(claim), Some(FieldValue::Text(row))) => claim == row,
                    _ => false,
                };
                if !matches_row {
                    return Err(ReducerError::InvalidReviewContext(format!(
                        "proposal proof claim {:?} does not match row {:?}",
                        self.claim_id, actual
                    )));
                }
            }
            _ => {
                return Err(ReducerError::InvalidReviewContext(
                    "review context applies only to claim/proposal transitions".to_string(),
                ));
            }
        }
        Ok(ReviewProof {
            action: self.action,
            proposal_id: self.proposal_id,
            claim_id: self.claim_id,
            object_id: self.object_id,
            reviewed_revision_id: self.reviewed_revision_id,
            final_body: self.final_body,
            user_edited: self.user_edited,
            result_revision_id: self.result_revision_id,
            method: self.method,
        })
    }
}

/// Review contexts keyed by the transitioned logical key.
pub type ReviewMap = BTreeMap<(EntityKind, Vec<String>), ReviewContext>;

// ---------------------------------------------------------------------------
// Reduction
// ---------------------------------------------------------------------------

struct KeyGroup<'a> {
    entity: EntityKind,
    key: Vec<String>,
    effects: Vec<&'a ObservedEffect>,
}

/// Reduce observed effects to deterministic logical operations.
///
/// Ordering of the returned operations is stable: record creates first (in
/// catalog order), then facet updates, then relation removals; ties break by
/// entity and logical key. Creation closures validate as a group afterwards.
///
/// `priors` carries one independent prior per changed mutable facet. Only
/// changed facets are looked up; record-level `known`/`baselines` keep
/// answering the separate existence question for dependency closure.
pub fn reduce_effects(
    effects: &[ObservedEffect],
    resolver: &dyn FinalStateResolver,
    known: &KnownRefs,
    baselines: &Baselines,
    reviews: &ReviewMap,
    priors: &FacetPriors,
) -> Result<Vec<Operation>, ReducerError> {
    if effects.len() > MAX_EFFECTS {
        return Err(ReducerError::TooManyEffects(effects.len()));
    }
    // Group by logical key, preserving first-seen order.
    let mut order: Vec<(EntityKind, Vec<String>)> = Vec::new();
    let mut groups: BTreeMap<(EntityKind, Vec<String>), KeyGroup<'_>> = BTreeMap::new();
    for effect in effects {
        validate_key(effect.entity, &effect.key)?;
        if let Some(before) = &effect.before {
            validate_row_image(effect.entity, before)?;
        }
        if let Some(after) = &effect.after {
            validate_row_image(effect.entity, after)?;
        }
        let id = (effect.entity, effect.key.clone());
        if !groups.contains_key(&id) {
            order.push(id.clone());
            groups.insert(
                id.clone(),
                KeyGroup {
                    entity: effect.entity,
                    key: effect.key.clone(),
                    effects: Vec::new(),
                },
            );
        }
        groups.get_mut(&id).expect("group").effects.push(effect);
    }

    // First pass: per-key operations plus the same-event creation set.
    let mut operations: Vec<Operation> = Vec::new();
    let mut creations: BTreeSet<(EntityKind, Vec<String>)> = BTreeSet::new();
    for id in &order {
        let group = groups.get(id).expect("group");
        validate_chain(group)?;
        let first_before = group.effects.first().and_then(|e| e.before.clone());
        let last_after = group.effects.last().and_then(|e| e.after.clone());
        let saw_delete_boundary = group.effects.iter().any(|e| e.after.is_none());
        let final_image = resolver.resolve(group.entity, &group.key);
        match (first_before, last_after, final_image) {
            (None, None, _) => {
                // Insert followed by delete in one transaction: intermediate
                // mutations existed, so this is not a silent no-op.
                return Err(ReducerError::NetZeroWithIntermediateMutations {
                    entity: group.entity.as_str(),
                });
            }
            (Some(_), None, final_image) => {
                if final_image.is_some() {
                    // A delete was observed but the final row exists: the
                    // transaction deleted then re-created the key.
                    return Err(ReducerError::JournalUnsupportedEffectSet(format!(
                        "{} deleted then re-created in one transaction",
                        group.entity.as_str()
                    )));
                }
                operations.push(reduce_delete(group, known, baselines)?);
            }
            (Some(before), Some(_), Some(final_image)) => {
                if group.effects.len() == 1 && Some(&before) == group.effects[0].after.as_ref() {
                    // Genuine idempotent no-op: one observed effect with
                    // identical before/after images.
                    continue;
                }
                if before == final_image {
                    return Err(ReducerError::NetZeroWithIntermediateMutations {
                        entity: group.entity.as_str(),
                    });
                }
                if saw_delete_boundary {
                    return Err(ReducerError::JournalUnsupportedEffectSet(format!(
                        "{} deleted then re-created in one transaction",
                        group.entity.as_str()
                    )));
                }
                operations.push(reduce_update(
                    group,
                    &before,
                    &final_image,
                    reviews,
                    priors,
                )?);
            }
            (None, Some(_), Some(final_image)) => {
                if saw_delete_boundary {
                    return Err(ReducerError::JournalUnsupportedEffectSet(format!(
                        "{} deleted then re-created in one transaction",
                        group.entity.as_str()
                    )));
                }
                operations.push(reduce_create(group, &final_image)?);
                creations.insert((group.entity, group.key.clone()));
            }
            (_, _, None) => {
                return Err(ReducerError::MissingFinalProjection {
                    entity: group.entity.as_str(),
                });
            }
        }
    }

    // Creation-closure validation: object/revision/parent/source/evidence
    // groups must reference records created in this same event or acknowledged
    // through known refs / explicit baselines.
    let mut ctx = ClosureCtx {
        creations: &creations,
        known,
        baselines,
    };
    for op in &operations {
        validate_closure(op, &mut ctx)?;
    }

    // Dependencies: same-event creations need no dep; known refs contribute
    // event refs; explicit baselines contribute null-ref deps.
    let mut dep_list: Vec<Dependency> = Vec::new();
    for op in &operations {
        for target in referenced_records(op) {
            match ctx.resolve(&target.0, &target.1)? {
                RefKind::SameEvent => {}
                RefKind::Known(event_ref) => dep_list.push(Dependency {
                    entity: target.0,
                    key: target.1.clone(),
                    event_ref: Some(event_ref),
                }),
                RefKind::Baseline => dep_list.push(Dependency {
                    entity: target.0,
                    key: target.1.clone(),
                    event_ref: None,
                }),
            }
        }
    }

    // Stable operation order: creates, updates, removals; ties by entity/key.
    operations
        .sort_by(|a, b| (op_rank(a), a.entity(), a.key()).cmp(&(op_rank(b), b.entity(), b.key())));
    // Stable dependency order: entity, key, then event-ref rendering.
    dep_list.sort_by(|a, b| {
        (a.entity, &a.key, ref_render(&a.event_ref)).cmp(&(
            b.entity,
            &b.key,
            ref_render(&b.event_ref),
        ))
    });
    dep_list.dedup_by(|a, b| {
        a.entity == b.entity
            && a.key == b.key
            && ref_render(&a.event_ref) == ref_render(&b.event_ref)
    });
    if dep_list.len() > MAX_DEPENDENCIES {
        return Err(ReducerError::TooManyDependencies(dep_list.len()));
    }
    Ok(operations)
}

/// Attach dependencies computed alongside reduction. The reducer returns
/// operations only; dependency assembly for the future finalizer reuses
/// `dependencies_for` so both paths share one implementation.
pub fn dependencies_for(
    operations: &[Operation],
    creations: &BTreeSet<(EntityKind, Vec<String>)>,
    known: &KnownRefs,
    baselines: &Baselines,
) -> Result<Vec<Dependency>, ReducerError> {
    let ctx = ClosureCtx {
        creations,
        known,
        baselines,
    };
    let mut dep_list: Vec<Dependency> = Vec::new();
    for op in operations {
        for target in referenced_records(op) {
            match ctx.resolve(&target.0, &target.1)? {
                RefKind::SameEvent => {}
                RefKind::Known(event_ref) => dep_list.push(Dependency {
                    entity: target.0,
                    key: target.1.clone(),
                    event_ref: Some(event_ref),
                }),
                RefKind::Baseline => dep_list.push(Dependency {
                    entity: target.0,
                    key: target.1.clone(),
                    event_ref: None,
                }),
            }
        }
    }
    dep_list.sort_by(|a, b| {
        (a.entity, &a.key, ref_render(&a.event_ref)).cmp(&(
            b.entity,
            &b.key,
            ref_render(&b.event_ref),
        ))
    });
    dep_list.dedup_by(|a, b| {
        a.entity == b.entity
            && a.key == b.key
            && ref_render(&a.event_ref) == ref_render(&b.event_ref)
    });
    if dep_list.len() > MAX_DEPENDENCIES {
        return Err(ReducerError::TooManyDependencies(dep_list.len()));
    }
    Ok(dep_list)
}

fn op_rank(op: &Operation) -> u8 {
    match op {
        Operation::RecordCreate(_) => 0,
        Operation::FacetUpdate(_) => 1,
        Operation::RelationRemove(_) => 2,
    }
}

fn ref_render(r: &Option<EventRef>) -> String {
    match r {
        None => String::new(),
        Some(e) => format!(
            "{}:{}:{}:{}:{}",
            e.origin_id, e.incarnation, e.seq, e.event_id, e.hash
        ),
    }
}

/// Consecutive images must chain: after[i] equals before[i+1], and no effect
/// may follow a delete except a re-insert, which the classifier rejects.
fn validate_chain(group: &KeyGroup<'_>) -> Result<(), ReducerError> {
    for pair in group.effects.windows(2) {
        let (first, second) = (&pair[0], &pair[1]);
        if first.after != second.before {
            return Err(ReducerError::InconsistentEffectChain {
                entity: group.entity.as_str(),
            });
        }
    }
    Ok(())
}

fn reduce_create(group: &KeyGroup<'_>, final_image: &RowImage) -> Result<Operation, ReducerError> {
    validate_row_image(group.entity, final_image)?;
    Ok(Operation::RecordCreate(RecordCreate {
        entity: group.entity,
        key: group.key.clone(),
        after: final_image.clone(),
    }))
}

fn reduce_delete(
    group: &KeyGroup<'_>,
    known: &KnownRefs,
    baselines: &Baselines,
) -> Result<Operation, ReducerError> {
    if group.entity != EntityKind::Relations {
        return Err(ReducerError::UnsupportedDeletion {
            entity: group.entity.as_str(),
        });
    }
    let before = group.effects.first().and_then(|e| e.before.clone()).ok_or(
        ReducerError::UnsupportedDeletion {
            entity: "relations",
        },
    )?;
    let origin = before.get("origin").and_then(|v| match v {
        FieldValue::Text(s) => Some(s.as_str()),
        _ => None,
    });
    if origin != Some("model") {
        // Observed-remove covers MODEL edges only; user/system deletions
        // must never be tombstoned by model results. This policy check stays
        // before provenance resolution so new provenance logic can never
        // bypass it.
        return Err(ReducerError::NonModelEdgeDeletion);
    }
    if !matches!(before.get("id"), Some(FieldValue::Text(_))) {
        return Err(ReducerError::UnsupportedDeletion {
            entity: "relations",
        });
    }
    // Record-level provenance (FIX-02 separation): a known journal creation
    // event wins only when no legacy baseline claims the same record; both
    // or neither is a typed failure, never a silent legacy grant and never
    // a manufactured reference.
    let id = (group.entity, group.key.clone());
    let observed_create = match (known.get(&id), baselines.contains(&id)) {
        (Some(creation), false) => ObservedCreate::Event(creation.clone()),
        (None, true) => {
            let digest = facet_state_hash(EntityKind::Relations, "record", &group.key, &before)?;
            ObservedCreate::LegacyHash(hash_hex(&digest))
        }
        (None, false) => {
            return Err(ReducerError::MissingCreationProvenance {
                entity: group.entity.as_str(),
            });
        }
        (Some(_), true) => {
            return Err(ReducerError::ContradictoryProvenance {
                entity: group.entity.as_str(),
            });
        }
    };
    Ok(Operation::RelationRemove(RelationRemove {
        key: group.key.clone(),
        before,
        observed_create,
    }))
}

fn reduce_update(
    group: &KeyGroup<'_>,
    first_before: &RowImage,
    final_image: &RowImage,
    reviews: &ReviewMap,
    priors: &FacetPriors,
) -> Result<Operation, ReducerError> {
    if !group.entity.is_facet_mutable() {
        // Immutable catalog rows never update: any observed change is an
        // unsupported effect set (new immutable rows carry new UUIDs).
        return Err(ReducerError::JournalUnsupportedEffectSet(format!(
            "{} is immutable",
            group.entity.as_str()
        )));
    }
    let update = FacetUpdate {
        entity: group.entity,
        key: group.key.clone(),
        before: first_before.clone(),
        after: final_image.clone(),
        expected: BTreeMap::new(),
        review_proof: None,
    };
    // Reuse codec transition validation for unknown/immutable drift.
    let mut probe = update;
    // Build one expected entry per changed facet from its OWN prior. An
    // unrelated facet writer is never borrowed: each facet version advances
    // only when that facet is written. A missing prior is a typed failure,
    // never a silent legacy grant.
    let changed = changed_facets(group.entity, first_before, final_image);
    if changed.is_empty() {
        // No meaningful facet changed (e.g. an isolated accompanying-metadata
        // bump): leave expected empty and let codec validation report the
        // immutable drift with its existing typed error.
    }
    for facet in &changed {
        let id = FacetId::of(group.entity, facet).ok_or_else(|| {
            ReducerError::JournalUnsupportedEffectSet(format!(
                "unknown facet {facet} on {}",
                group.entity.as_str()
            ))
        })?;
        let prior = priors.get(&(group.entity, group.key.clone(), id)).ok_or(
            ReducerError::MissingFacetPrior {
                entity: group.entity.as_str(),
                facet,
            },
        )?;
        let state = ExpectedFacet {
            event_ref: match prior {
                FacetPrior::Event(event_ref) => Some(event_ref.clone()),
                FacetPrior::LegacyBaseline => None,
            },
            before_hash: hash_hex(&facet_state_hash(
                group.entity,
                facet,
                &group.key,
                &facet_projection(group.entity, facet, first_before),
            )?),
        };
        probe.expected.insert(facet.to_string(), state);
    }
    // State transitions on claims/proposals require review context.
    if matches!(
        group.entity,
        EntityKind::PendingClaims | EntityKind::RevisionProposals
    ) && lifecycle_state_changed(&probe)
    {
        let context = reviews
            .get(&(group.entity, group.key.clone()))
            .cloned()
            .ok_or(ReducerError::MissingReviewProof {
                entity: group.entity.as_str(),
            })?;
        validate_terminal_closure(group.entity, first_before, final_image, &context)?;
        probe.review_proof =
            Some(context.into_proof_for(group.entity, &group.key, first_before)?);
    }
    // Codec-level enforcement: unknown facets, immutable drift, missing
    // expected entries all fail here.
    super::codec::validate_facet_update_shape(&probe)?;
    Ok(Operation::FacetUpdate(probe))
}

fn changed_facets(entity: EntityKind, before: &RowImage, after: &RowImage) -> Vec<&'static str> {
    let mut out = Vec::new();
    for facet in super::codec::facets_of(entity) {
        if facet.fields.iter().any(|f| before.get(*f) != after.get(*f)) {
            out.push(facet.name);
        }
    }
    out
}

fn lifecycle_state_changed(update: &FacetUpdate) -> bool {
    update.before.get("state") != update.after.get("state")
}

/// Project the rows owned by one facet into a standalone image for hashing.
fn facet_projection(entity: EntityKind, facet: &str, image: &RowImage) -> RowImage {
    let def = super::codec::facets_of(entity)
        .iter()
        .find(|f| f.name == facet);
    let mut out = RowImage::new();
    if let Some(def) = def {
        for field in def.fields {
            if let Some(value) = image.get(*field) {
                out.insert(field.to_string(), value.clone());
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Terminal closure (v9 CHECK parity for claim/proposal lifecycle)
// ---------------------------------------------------------------------------

fn text_of<'a>(image: &'a RowImage, field: &str) -> Option<&'a str> {
    match image.get(field) {
        Some(FieldValue::Text(s)) => Some(s.as_str()),
        _ => None,
    }
}

fn is_null(image: &RowImage, field: &str) -> bool {
    matches!(image.get(field), Some(FieldValue::Null) | None)
}

/// Enforce the v9 terminal CHECKs on the final image so a terminal
/// transition without its required domain rows fails closure validation.
fn validate_terminal_closure(
    entity: EntityKind,
    before: &RowImage,
    after: &RowImage,
    context: &ReviewContext,
) -> Result<(), ReducerError> {
    let state = text_of(after, "state").ok_or_else(|| {
        ReducerError::TerminalClosureViolation("terminal transition without state".to_string())
    })?;
    // O6: the review action must agree with the observed before/after
    // transition. Metadata-only updates carry no review and never reach
    // this check through reduce_update (no state change, no context).
    let from = text_of(before, "state").ok_or_else(|| {
        ReducerError::TerminalClosureViolation("transition without before state".to_string())
    })?;
    if from != state {
        let agrees = matches!(
            (entity, from, state, context.action),
            (EntityKind::PendingClaims, "open", "deferred", ReviewAction::Defer)
                | (EntityKind::PendingClaims, "deferred", "open", ReviewAction::Reopen)
                | (EntityKind::PendingClaims, _, "accepted", ReviewAction::Approve)
                | (EntityKind::PendingClaims, _, "accepted", ReviewAction::EditAndApprove)
                | (EntityKind::PendingClaims, _, "separated", ReviewAction::KeepSeparate)
                | (EntityKind::RevisionProposals, _, "approved", ReviewAction::Approve)
                | (EntityKind::RevisionProposals, _, "approved", ReviewAction::EditAndApprove)
                | (EntityKind::RevisionProposals, _, "rejected", ReviewAction::Reject)
                | (EntityKind::RevisionProposals, _, "separated", ReviewAction::KeepSeparate)
                | (EntityKind::RevisionProposals, _, "superseded", ReviewAction::Supersede)
                | (EntityKind::RevisionProposals, "open", "deferred", ReviewAction::Defer)
                | (EntityKind::RevisionProposals, "deferred", "open", ReviewAction::Reopen)
        );
        if !agrees {
            return Err(ReducerError::InvalidReviewContext(
                "review action disagrees with observed transition".to_string(),
            ));
        }
    }
    match entity {
        EntityKind::PendingClaims => match state {
            "open" | "deferred" => {
                if !is_null(after, "resolved_at")
                    || !is_null(after, "resolved_method")
                    || !is_null(after, "resolved_object_id")
                    || !is_null(after, "resolved_revision_id")
                {
                    return Err(ReducerError::TerminalClosureViolation(
                        "open/deferred claim carries resolution".to_string(),
                    ));
                }
                Ok(())
            }
            "accepted" => {
                if is_null(after, "resolved_at")
                    || text_of(after, "resolved_method") != Some("user")
                    || is_null(after, "resolved_object_id")
                    || is_null(after, "resolved_revision_id")
                {
                    return Err(ReducerError::TerminalClosureViolation(
                        "accepted claim needs user resolution rows".to_string(),
                    ));
                }
                Ok(())
            }
            "separated" => {
                if is_null(after, "resolved_at")
                    || is_null(after, "resolved_method")
                    || is_null(after, "resolved_object_id")
                    || !is_null(after, "resolved_revision_id")
                {
                    return Err(ReducerError::TerminalClosureViolation(
                        "separated claim needs object resolution rows".to_string(),
                    ));
                }
                Ok(())
            }
            other => Err(ReducerError::TerminalClosureViolation(format!(
                "unknown claim state {other}"
            ))),
        },
        EntityKind::RevisionProposals => match state {
            "open" | "deferred" => {
                if !is_null(after, "final_body")
                    || !is_null(after, "result_revision_id")
                    || is_null(after, "reviewed_at") && state == "open"
                {
                    // Open proposals carry no result; deferred keeps reviewed_at.
                    if !is_null(after, "final_body") || !is_null(after, "result_revision_id") {
                        return Err(ReducerError::TerminalClosureViolation(
                            "reviewable proposal carries a result".to_string(),
                        ));
                    }
                }
                Ok(())
            }
            "approved" => {
                if is_null(after, "final_body")
                    || is_null(after, "result_revision_id")
                    || is_null(after, "reviewed_at")
                {
                    return Err(ReducerError::TerminalClosureViolation(
                        "approved proposal needs its committed revision".to_string(),
                    ));
                }
                Ok(())
            }
            "rejected" | "separated" | "superseded" => {
                if is_null(after, "reviewed_at") {
                    return Err(ReducerError::TerminalClosureViolation(
                        "terminal proposal needs reviewed_at".to_string(),
                    ));
                }
                Ok(())
            }
            other => Err(ReducerError::TerminalClosureViolation(format!(
                "unknown proposal state {other}"
            ))),
        },
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Creation closure and references
// ---------------------------------------------------------------------------

enum RefKind {
    SameEvent,
    Known(EventRef),
    Baseline,
}

struct ClosureCtx<'a> {
    creations: &'a BTreeSet<(EntityKind, Vec<String>)>,
    known: &'a KnownRefs,
    baselines: &'a Baselines,
}

impl ClosureCtx<'_> {
    fn resolve(&self, entity: &EntityKind, key: &[String]) -> Result<RefKind, ReducerError> {
        let id = (*entity, key.to_vec());
        if self.creations.contains(&id) {
            return Ok(RefKind::SameEvent);
        }
        if let Some(r) = self.known.get(&id) {
            return Ok(RefKind::Known(r.clone()));
        }
        if self.baselines.contains(&id) {
            return Ok(RefKind::Baseline);
        }
        Err(ReducerError::IncompleteDependencyClosure {
            entity: entity.as_str(),
        })
    }
}

fn ref_id(image: &RowImage, field: &str) -> Option<String> {
    match image.get(field) {
        Some(FieldValue::Text(s)) => Some(s.clone()),
        Some(FieldValue::Decimal(s)) => Some(s.clone()),
        _ => None,
    }
}

/// Foreign references carried by one operation's images. Every target must
/// resolve to a same-event creation, a known ref, or an explicit baseline.
fn referenced_records(op: &Operation) -> Vec<(EntityKind, Vec<String>)> {
    let mut out: Vec<(EntityKind, Vec<String>)> = Vec::new();
    let mut push = |entity: EntityKind, key: Vec<String>| {
        if !out.iter().any(|(e, k)| *e == entity && *k == key) {
            out.push((entity, key));
        }
    };
    match op {
        Operation::RecordCreate(c) => {
            image_refs(c.entity, &c.after, &mut push);
        }
        Operation::FacetUpdate(u) => {
            image_refs(u.entity, &u.after, &mut push);
        }
        Operation::RelationRemove(r) => {
            image_refs(EntityKind::Relations, &r.before, &mut push);
        }
    }
    out
}

fn image_refs(entity: EntityKind, image: &RowImage, push: &mut dyn FnMut(EntityKind, Vec<String>)) {
    // Membership always implies the owning project.
    if matches!(entity, EntityKind::Captures | EntityKind::KnowledgeObjects) {
        if let Some(project) = ref_id(image, "project_id") {
            push(EntityKind::Projects, vec![project]);
        }
    }
    match entity {
        EntityKind::KnowledgeObjects => {
            if let Some(rev) = ref_id(image, "current_revision_id") {
                push(EntityKind::ThoughtRevisions, vec![rev]);
            }
        }
        EntityKind::ObjectSources => {
            if let Some(o) = ref_id(image, "object_id") {
                push(EntityKind::KnowledgeObjects, vec![o]);
            }
            if let Some(c) = ref_id(image, "capture_id") {
                push(EntityKind::Captures, vec![c]);
            }
        }
        EntityKind::ThoughtRevisions => {
            if let Some(o) = ref_id(image, "object_id") {
                push(EntityKind::KnowledgeObjects, vec![o]);
            }
            if let Some(c) = ref_id(image, "capture_id") {
                push(EntityKind::Captures, vec![c]);
            }
        }
        EntityKind::RevisionParents => {
            if let Some(c) = ref_id(image, "child_revision_id") {
                push(EntityKind::ThoughtRevisions, vec![c]);
            }
            if let Some(p) = ref_id(image, "parent_revision_id") {
                push(EntityKind::ThoughtRevisions, vec![p]);
            }
        }
        EntityKind::Relations => {
            if let Some(s) = ref_id(image, "source_object_id") {
                push(EntityKind::KnowledgeObjects, vec![s]);
            }
            if let Some(t) = ref_id(image, "target_object_id") {
                push(EntityKind::KnowledgeObjects, vec![t]);
            }
        }
        EntityKind::IdentityDecisions => {
            if let Some(c) = ref_id(image, "capture_id") {
                push(EntityKind::DistillationRuns, vec![c]);
            }
            for field in ["target_object_id", "created_object_id"] {
                if let Some(o) = ref_id(image, field) {
                    push(EntityKind::KnowledgeObjects, vec![o]);
                }
            }
            for field in ["base_revision_id", "result_revision_id"] {
                if let Some(r) = ref_id(image, field) {
                    push(EntityKind::ThoughtRevisions, vec![r]);
                }
            }
        }
        EntityKind::RevisionEvidence => {
            if let Some(r) = ref_id(image, "revision_id") {
                push(EntityKind::ThoughtRevisions, vec![r]);
            }
            if let Some(o) = ref_id(image, "object_id") {
                push(EntityKind::KnowledgeObjects, vec![o]);
            }
            if let Some(c) = ref_id(image, "capture_id") {
                push(EntityKind::Captures, vec![c]);
            }
            if let Some(r) = ref_id(image, "retracts_revision_id") {
                if let Some(FieldValue::Decimal(o)) = image.get("retracts_ordinal") {
                    push(EntityKind::RevisionEvidence, vec![r, o.clone()]);
                }
            }
        }
        EntityKind::PendingClaims => {
            if let Some(c) = ref_id(image, "capture_id") {
                push(EntityKind::Captures, vec![c]);
            }
            if let Some(o) = ref_id(image, "resolved_object_id") {
                push(EntityKind::KnowledgeObjects, vec![o]);
            }
            if let Some(r) = ref_id(image, "resolved_revision_id") {
                push(EntityKind::ThoughtRevisions, vec![r]);
            }
        }
        EntityKind::RevisionProposals => {
            if let Some(p) = ref_id(image, "pending_claim_id") {
                push(EntityKind::PendingClaims, vec![p]);
            }
            if let Some(o) = ref_id(image, "object_id") {
                push(EntityKind::KnowledgeObjects, vec![o]);
            }
            for field in ["base_revision_id", "result_revision_id"] {
                if let Some(r) = ref_id(image, field) {
                    push(EntityKind::ThoughtRevisions, vec![r]);
                }
            }
        }
        _ => {}
    }
}

/// Creation-closure validation for one operation: every referenced record
/// must be created in this same event or acknowledged via known/baseline.
/// In particular an object with a current pointer needs its revision, a
/// parent row needs both revisions, and evidence needs its revision.
fn validate_closure(op: &Operation, ctx: &ClosureCtx<'_>) -> Result<(), ReducerError> {
    for target in referenced_records(op) {
        ctx.resolve(&target.0, &target.1)?;
    }
    if let Operation::RecordCreate(c) = op {
        if c.entity == EntityKind::KnowledgeObjects {
            if let Some(FieldValue::Text(rev)) = c.after.get("current_revision_id") {
                ctx.resolve(&EntityKind::ThoughtRevisions, &[rev.clone()])?;
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Event assembly helper (shared by the future finalizer and tests)
// ---------------------------------------------------------------------------

/// Assemble a validated event shell around reduced operations. Id/bundle
/// allocation and sequencing stay with the future `JournalTx` finalizer.
#[allow(clippy::too_many_arguments)]
pub fn assemble_event(
    bundle_id: String,
    event_id: String,
    origin_id: String,
    origin_incarnation: String,
    origin_seq: u64,
    previous_event_hash: String,
    committed_at: String,
    raw_effect_count: u64,
    operations: Vec<Operation>,
    dependencies: Vec<Dependency>,
) -> Result<JournalEvent, ReducerError> {
    if origin_seq == 0 || origin_seq > i64::MAX as u64 {
        return Err(ReducerError::Codec(
            super::codec::CodecError::InvalidDecimal(origin_seq.to_string()),
        ));
    }
    validate_hash_hex(&previous_event_hash).map_err(ReducerError::Codec)?;
    Ok(JournalEvent {
        bundle_id,
        committed_at,
        dependencies,
        event_id,
        operation_version: OPERATION_VERSION,
        operations,
        origin_id,
        origin_incarnation,
        origin_seq: origin_seq.to_string(),
        previous_event_hash,
        provenance_class: PROVENANCE_LOCAL_COMMITTED.to_string(),
        raw_effect_count: raw_effect_count.to_string(),
    })
}
