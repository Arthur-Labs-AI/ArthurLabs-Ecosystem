//! Closed canonical journal codec (M05-P1b-B, design sections 5-7).
//!
//! The wire-independent core has exactly the illustrated fields. Three
//! operation kinds exist: `record.create`, `facet.update`, `relation.remove`.
//! Unknown kinds, versions, entities or fields fail closed.
//!
//! Canonical bytes are produced with the reviewed `serde_jcs =0.1.0`
//! implementation (RFC 8785). Applicability note: `serde_jcs` sorts object
//! keys by serialized byte order. Every object key this codec can emit is a
//! fixed ASCII field name (entity, facet, column and envelope names), for
//! which byte order and RFC 8785 UTF-16 order coincide. User content
//! (Cyrillic, emoji, combining marks, controls) only ever appears in string
//! VALUES, which are never reordered; escaping follows serde_json compact
//! rules (short escapes plus lowercase \\u00xx), matching JCS. Astral
//! characters in object KEYS would sort differently under a strict UTF-16
//! comparison, but this closed vocabulary cannot produce such keys.
//!
//! Integrity: `SHA-256(ASCII(domain-sep) || 0x00 || JCS(core))`.
//! Hashing is integrity evidence only, never authentication.

use std::collections::BTreeMap;
use std::fmt;

use serde_json::{Map, Value};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Domain separation for bundle integrity hashes (design section 7).
pub const DOMAIN_SEP_BUNDLE: &[u8] = b"ARTHUR-M05-LOCAL-BUNDLE-v1";
/// Domain separation for facet/record state hashes.
pub const DOMAIN_SEP_FACET: &[u8] = b"ARTHUR-M05-FACET-v1";
/// Single zero byte between domain separation and canonical bytes.
pub const DOMAIN_SEP_BYTE: u8 = 0x00;

/// Maximum canonical bundle bytes accepted by the future journal path.
/// This bound does NOT apply to current v9 production saves.
pub const MAX_CANONICAL_BYTES: usize = 4 * 1024 * 1024;
/// Maximum observed effects reduced into one event.
pub const MAX_EFFECTS: usize = 4096;
/// Maximum external dependency references carried by one event.
pub const MAX_DEPENDENCIES: usize = 256;
/// Maximum JSON nesting depth accepted when decoding untrusted input.
pub const MAX_JSON_DEPTH: usize = 16;
/// Only operation version in the closed v1 vocabulary.
pub const OPERATION_VERSION: u32 = 1;
/// Fixed local provenance class for pre-pairing cores.
pub const PROVENANCE_LOCAL_COMMITTED: &str = "local_committed";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Typed codec failure. Never logs payloads; carries lengths, never content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodecError {
    UnknownEntity(String),
    UnknownOperationKind(String),
    UnsupportedOperationVersion(u64),
    UnexpectedField(String),
    MissingField(&'static str),
    MalformedKey(String),
    MissingKeyField(&'static str),
    IncompleteImage(&'static str),
    UnexpectedImageField(String),
    InvalidUuid(String),
    InvalidDecimal(String),
    InvalidHash(String),
    InvalidTimestamp(String),
    InvalidEnumValue { field: &'static str, value: String },
    NullForbidden(&'static str),
    FloatForbidden,
    DuplicateKey(String),
    JsonTooDeep,
    MalformedJson(String),
    NotCanonical,
    EmptyOperations,
    TooManyOperations(usize),
    TooManyDependencies(usize),
    OversizeBundle { bytes: usize, limit: usize },
    ImmutableFieldChanged { field: &'static str },
    MissingReviewProof { entity: &'static str },
    InvalidReviewProofIdentity { field: &'static str },
    NonModelRelationRemoval,
    Serialization(String),
}

impl fmt::Display for CodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownEntity(e) => write!(f, "unknown journal entity: {e}"),
            Self::UnknownOperationKind(k) => write!(f, "unknown operation kind: {k}"),
            Self::UnsupportedOperationVersion(v) => {
                write!(f, "unsupported operation version: {v}")
            }
            Self::UnexpectedField(name) => write!(f, "unexpected field: {name}"),
            Self::MissingField(name) => write!(f, "missing field: {name}"),
            Self::MalformedKey(why) => write!(f, "malformed entity key: {why}"),
            Self::MissingKeyField(name) => write!(f, "key disagrees with image field: {name}"),
            Self::IncompleteImage(what) => write!(f, "incomplete row image: {what}"),
            Self::UnexpectedImageField(name) => {
                write!(f, "image carries uncatalogued field: {name}")
            }
            Self::InvalidUuid(_) => write!(f, "invalid canonical UUID"),
            Self::InvalidDecimal(_) => write!(f, "invalid canonical decimal"),
            Self::InvalidHash(_) => write!(f, "invalid lowercase hex hash"),
            Self::InvalidTimestamp(_) => write!(f, "invalid RFC3339 timestamp"),
            Self::InvalidEnumValue { field, .. } => {
                write!(f, "invalid value for closed enum field: {field}")
            }
            Self::NullForbidden(field) => write!(f, "null forbidden for field: {field}"),
            Self::FloatForbidden => write!(f, "floating-point numbers are forbidden"),
            Self::DuplicateKey(k) => write!(f, "duplicate JSON key: {k}"),
            Self::JsonTooDeep => write!(f, "JSON nesting exceeds depth limit"),
            Self::MalformedJson(_) => write!(f, "malformed JSON"),
            Self::NotCanonical => write!(f, "bytes are not canonical JCS form"),
            Self::EmptyOperations => write!(f, "an event must carry at least one operation"),
            Self::TooManyOperations(n) => write!(f, "too many operations: {n}"),
            Self::TooManyDependencies(n) => write!(f, "too many dependencies: {n}"),
            Self::OversizeBundle { bytes, limit } => {
                write!(f, "canonical bundle {bytes} bytes exceeds {limit}")
            }
            Self::ImmutableFieldChanged { field } => {
                write!(f, "immutable field changed in facet update: {field}")
            }
            Self::MissingReviewProof { entity } => write!(
                f,
                "claim/proposal state transition of {entity} needs operation-local review proof"
            ),
            Self::InvalidReviewProofIdentity { field } => write!(
                f,
                "review proof {field} does not identify the transitioned row"
            ),
            Self::NonModelRelationRemoval => {
                write!(f, "relation removal covers original MODEL relations only")
            }
            Self::Serialization(_) => write!(f, "canonical serialization failed"),
        }
    }
}

impl std::error::Error for CodecError {}

// ---------------------------------------------------------------------------
// Closed entity catalog (design section 5)
// ---------------------------------------------------------------------------

/// The twelve authoritative projections. Order is the catalog order, which is
/// also the topological creation order used when sequencing operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EntityKind {
    Projects,
    Captures,
    DistillationRuns,
    KnowledgeObjects,
    ObjectSources,
    ThoughtRevisions,
    RevisionParents,
    Relations,
    IdentityDecisions,
    RevisionEvidence,
    PendingClaims,
    RevisionProposals,
}

impl EntityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Projects => "projects",
            Self::Captures => "captures",
            Self::DistillationRuns => "distillation_runs",
            Self::KnowledgeObjects => "knowledge_objects",
            Self::ObjectSources => "object_sources",
            Self::ThoughtRevisions => "thought_revisions",
            Self::RevisionParents => "revision_parents",
            Self::Relations => "relations",
            Self::IdentityDecisions => "identity_decisions",
            Self::RevisionEvidence => "revision_evidence",
            Self::PendingClaims => "pending_claims",
            Self::RevisionProposals => "revision_proposals",
        }
    }

    pub fn from_str(name: &str) -> Result<Self, CodecError> {
        match name {
            "projects" => Ok(Self::Projects),
            "captures" => Ok(Self::Captures),
            "distillation_runs" => Ok(Self::DistillationRuns),
            "knowledge_objects" => Ok(Self::KnowledgeObjects),
            "object_sources" => Ok(Self::ObjectSources),
            "thought_revisions" => Ok(Self::ThoughtRevisions),
            "revision_parents" => Ok(Self::RevisionParents),
            "relations" => Ok(Self::Relations),
            "identity_decisions" => Ok(Self::IdentityDecisions),
            "revision_evidence" => Ok(Self::RevisionEvidence),
            "pending_claims" => Ok(Self::PendingClaims),
            "revision_proposals" => Ok(Self::RevisionProposals),
            other => Err(CodecError::UnknownEntity(other.to_string())),
        }
    }

    /// Logical key fields, in order. Ordinal keys are decimal strings.
    pub fn key_fields(self) -> &'static [&'static str] {
        match self {
            Self::Projects => &["id"],
            Self::Captures => &["id"],
            Self::DistillationRuns => &["capture_id"],
            Self::KnowledgeObjects => &["id"],
            Self::ObjectSources => &["object_id"],
            Self::ThoughtRevisions => &["id"],
            Self::RevisionParents => &["child_revision_id", "parent_revision_id"],
            Self::Relations => &["id"],
            Self::IdentityDecisions => &["capture_id", "ordinal"],
            Self::RevisionEvidence => &["revision_id", "ordinal"],
            Self::PendingClaims => &["id"],
            Self::RevisionProposals => &["id"],
        }
    }

    /// Full replicated projection fields, in fixed catalog order.
    pub fn all_fields(self) -> &'static [&'static str] {
        match self {
            Self::Projects => &["id", "name", "created_at", "updated_at", "archived_at"],
            Self::Captures => &["id", "source", "content", "created_at", "project_id"],
            Self::DistillationRuns => &["capture_id", "created_at"],
            Self::KnowledgeObjects => &[
                "id",
                "kind",
                "title",
                "body",
                "created_at",
                "current_revision_id",
                "project_id",
            ],
            Self::ObjectSources => &["object_id", "capture_id", "source_start", "source_end"],
            Self::ThoughtRevisions => &[
                "id",
                "object_id",
                "kind",
                "title",
                "body",
                "origin",
                "created_at",
                "capture_id",
                "source_start",
                "source_end",
            ],
            Self::RevisionParents => &["child_revision_id", "parent_revision_id"],
            Self::Relations => &[
                "id",
                "kind",
                "source_object_id",
                "target_object_id",
                "origin",
                "created_at",
            ],
            Self::IdentityDecisions => &[
                "capture_id",
                "ordinal",
                "outcome",
                "unchecked_reason",
                "target_object_id",
                "base_revision_id",
                "result_revision_id",
                "created_object_id",
                "policy_version",
                "model_id",
                "decided_by",
                "vetoes_json",
                "audit_json",
                "decided_at",
            ],
            Self::RevisionEvidence => &[
                "revision_id",
                "ordinal",
                "object_id",
                "capture_id",
                "source_start",
                "source_end",
                "role",
                "retracts_revision_id",
                "retracts_ordinal",
                "interpretation_label",
                "created_at",
            ],
            Self::PendingClaims => &[
                "id",
                "capture_id",
                "ordinal",
                "kind",
                "title",
                "body",
                "source_start",
                "source_end",
                "candidate_ids_json",
                "reasons_json",
                "reframing",
                "state",
                "due_at",
                "created_at",
                "updated_at",
                "deferred_at",
                "resolved_at",
                "resolved_method",
                "resolved_object_id",
                "resolved_revision_id",
            ],
            Self::RevisionProposals => &[
                "id",
                "pending_claim_id",
                "object_id",
                "base_revision_id",
                "change",
                "kind",
                "title",
                "proposed_body",
                "retracts_revision_id",
                "retracts_ordinal",
                "evidence_json",
                "synthesis_model",
                "verifier_model",
                "verification_mode",
                "verification_status",
                "policy_version",
                "state",
                "user_edited",
                "final_body",
                "result_revision_id",
                "created_at",
                "updated_at",
                "reviewed_at",
            ],
        }
    }

    /// Columns encoded as canonical decimal strings (SQLite INTEGER).
    pub fn int_fields(self) -> &'static [&'static str] {
        match self {
            Self::Projects => &[],
            Self::Captures => &[],
            Self::DistillationRuns => &[],
            Self::KnowledgeObjects => &[],
            Self::ObjectSources => &["source_start", "source_end"],
            Self::ThoughtRevisions => &["source_start", "source_end"],
            Self::RevisionParents => &[],
            Self::Relations => &[],
            Self::IdentityDecisions => &["ordinal"],
            Self::RevisionEvidence => {
                &["ordinal", "source_start", "source_end", "retracts_ordinal"]
            }
            Self::PendingClaims => &["ordinal", "source_start", "source_end", "reframing"],
            Self::RevisionProposals => &["retracts_ordinal", "user_edited"],
        }
    }

    /// Columns that may be null (all others must be present and non-null).
    /// Mirrors the verified v9 CHECK/nullability semantics.
    pub fn nullable_fields(self) -> &'static [&'static str] {
        match self {
            Self::Projects => &["archived_at"],
            Self::Captures => &[],
            Self::DistillationRuns => &[],
            Self::KnowledgeObjects => &["current_revision_id"],
            Self::ObjectSources => &[],
            Self::ThoughtRevisions => &["capture_id", "source_start", "source_end"],
            Self::RevisionParents => &[],
            Self::Relations => &[],
            Self::IdentityDecisions => &[
                "unchecked_reason",
                "target_object_id",
                "base_revision_id",
                "result_revision_id",
                "created_object_id",
                "model_id",
            ],
            Self::RevisionEvidence => &[
                "retracts_revision_id",
                "retracts_ordinal",
                "interpretation_label",
            ],
            Self::PendingClaims => &[
                "due_at",
                "deferred_at",
                "resolved_at",
                "resolved_method",
                "resolved_object_id",
                "resolved_revision_id",
            ],
            Self::RevisionProposals => &[
                "retracts_revision_id",
                "retracts_ordinal",
                "final_body",
                "result_revision_id",
                "reviewed_at",
            ],
        }
    }

    /// Whether key element `index` is a decimal ordinal key.
    pub fn key_element_is_decimal(self, index: usize) -> bool {
        matches!(
            (self, index),
            (Self::IdentityDecisions, 1) | (Self::RevisionEvidence, 1)
        )
    }

    /// Entities whose rows may change through facet updates.
    pub fn is_facet_mutable(self) -> bool {
        matches!(
            self,
            Self::Projects
                | Self::Captures
                | Self::KnowledgeObjects
                | Self::PendingClaims
                | Self::RevisionProposals
        )
    }
}

/// One mutable facet: name plus the fields it owns. All other fields of a
/// facet-mutable entity are immutable and must stay byte-equal in updates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FacetDef {
    pub name: &'static str,
    pub fields: &'static [&'static str],
}

/// Facets per facet-mutable entity (design section 6.1).
pub fn facets_of(entity: EntityKind) -> &'static [FacetDef] {
    match entity {
        EntityKind::Projects => &[
            FacetDef {
                name: "record",
                fields: &["name"],
            },
            FacetDef {
                name: "lifecycle",
                fields: &["archived_at"],
            },
        ],
        EntityKind::Captures => &[FacetDef {
            name: "membership",
            fields: &["project_id"],
        }],
        EntityKind::KnowledgeObjects => &[
            FacetDef {
                name: "membership",
                fields: &["project_id"],
            },
            FacetDef {
                name: "head",
                fields: &["current_revision_id", "kind", "title", "body"],
            },
        ],
        EntityKind::PendingClaims => &[FacetDef {
            name: "lifecycle",
            fields: &[
                "state",
                "due_at",
                "deferred_at",
                "resolved_at",
                "resolved_method",
                "resolved_object_id",
                "resolved_revision_id",
                "updated_at",
            ],
        }],
        EntityKind::RevisionProposals => &[FacetDef {
            name: "lifecycle",
            fields: &[
                "state",
                "user_edited",
                "final_body",
                "result_revision_id",
                "reviewed_at",
                "updated_at",
            ],
        }],
        _ => &[],
    }
}

// ---------------------------------------------------------------------------
// Scalar values
// ---------------------------------------------------------------------------

/// Restricted scalar vocabulary: UTF-8 text, canonical decimal string, null.
/// No floating point, no nested maps supplied by callers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldValue {
    Text(String),
    Decimal(String),
    Null,
}

impl FieldValue {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Text(s) => Value::String(s.clone()),
            Self::Decimal(s) => Value::String(s.clone()),
            Self::Null => Value::Null,
        }
    }
}

/// Canonical decimal: "0" or nonzero without leading zeroes, fits u64.
pub fn validate_decimal(text: &str) -> Result<(), CodecError> {
    if text.is_empty() {
        return Err(CodecError::InvalidDecimal(String::new()));
    }
    let bytes = text.as_bytes();
    if bytes.len() > 1 && bytes[0] == b'0' {
        return Err(CodecError::InvalidDecimal(text.to_string()));
    }
    if !bytes.iter().all(|b| b.is_ascii_digit()) {
        return Err(CodecError::InvalidDecimal(text.to_string()));
    }
    text.parse::<u64>()
        .map(|_| ())
        .map_err(|_| CodecError::InvalidDecimal(text.to_string()))
}

/// Canonical UUID: parses as UUID and is already lowercase canonical.
/// Legacy v1-era non-UUID ids are NOT accepted here; row-image id fields use
/// `validate_id_field` instead. Core event/bundle/origin ids must be UUIDs.
pub fn validate_canonical_uuid(text: &str) -> Result<(), CodecError> {
    match uuid::Uuid::try_parse(text) {
        Ok(_) if text == text.to_lowercase() => Ok(()),
        _ => Err(CodecError::InvalidUuid(text.to_string())),
    }
}

/// Row-image id/reference field: canonical lowercase UUID when UUID-shaped,
/// otherwise a non-empty token without whitespace or controls (accepts
/// historical v1 fixtures such as short test ids). Never empty.
pub fn validate_id_field(text: &str) -> Result<(), CodecError> {
    if text.is_empty() {
        return Err(CodecError::InvalidUuid(String::new()));
    }
    if text
        .bytes()
        .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
    {
        return Err(CodecError::InvalidUuid(text.to_string()));
    }
    if text.contains('-') {
        // UUID-shaped values must be canonical lowercase UUIDs.
        return validate_canonical_uuid(text);
    }
    Ok(())
}

/// 64 lowercase hex characters (SHA-256 digest rendering).
pub fn validate_hash_hex(text: &str) -> Result<(), CodecError> {
    if text.len() != 64
        || !text
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(CodecError::InvalidHash(text.to_string()));
    }
    Ok(())
}

/// Original RFC3339 spelling, preserved exactly (never normalized).
pub fn validate_timestamp(text: &str) -> Result<(), CodecError> {
    use time::format_description::well_known::Rfc3339;
    time::OffsetDateTime::parse(text, &Rfc3339)
        .map(|_| ())
        .map_err(|_| CodecError::InvalidTimestamp(text.to_string()))
}

/// Closed enum validation for protocol-declared enum columns.
pub fn validate_enum_value(field: &'static str, value: &str) -> Result<(), CodecError> {
    let allowed: &[&str] = match field {
        "source" => &["text", "voice", "emg"],
        "kind" => &[],           // checked per-entity by validate_kind_value
        "origin" if true => &[], // checked per-entity below
        "origin" if true => &[], // checked per-entity below
        "outcome" => &["new", "revise", "uncertain", "unchecked"],
        "decided_by" => &["gate", "fallback"],
        "unchecked_reason" => &[
            "disabled",
            "invalid_claim",
            "invalid_candidates",
            "no_eligible_candidates",
            "classifier_failed",
            "malformed_signals",
            "review_quota",
        ],
        "role" => &["asserts", "corrects", "replaces"],
        "state" => &[], // checked per-entity below
        "resolved_method" => &["user", "expiry"],
        "change" => &["additive", "correction", "replacement"],
        "verification_mode" => &["independent", "same_family_review"],
        "verification_status" => &["passed"],
        _ => return Ok(()),
    };
    if field == "kind" || field == "origin" || field == "state" {
        return Ok(());
    }
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(CodecError::InvalidEnumValue {
            field,
            value: value.to_string(),
        })
    }
}

fn validate_kind_value(entity: EntityKind, value: &str) -> Result<(), CodecError> {
    let allowed: &[&str] = match entity {
        EntityKind::Relations => &[
            "related_to",
            "extends",
            "depends_on",
            "contradicts",
            "derived_from",
            "duplicates",
            "supersedes",
        ],
        EntityKind::KnowledgeObjects
        | EntityKind::ThoughtRevisions
        | EntityKind::PendingClaims
        | EntityKind::RevisionProposals => &["idea", "task", "decision", "question", "note"],
        _ => return Ok(()),
    };
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(CodecError::InvalidEnumValue {
            field: "kind",
            value: value.to_string(),
        })
    }
}

fn validate_origin_value(entity: EntityKind, value: &str) -> Result<(), CodecError> {
    let allowed: &[&str] = match entity {
        EntityKind::ThoughtRevisions => {
            &["initial", "user_edit", "distillation", "merge", "system"]
        }
        EntityKind::Relations => &["model", "user", "system"],
        _ => return Ok(()),
    };
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(CodecError::InvalidEnumValue {
            field: "origin",
            value: value.to_string(),
        })
    }
}

fn validate_state_value(entity: EntityKind, value: &str) -> Result<(), CodecError> {
    let allowed: &[&str] = match entity {
        EntityKind::PendingClaims => &["open", "deferred", "accepted", "separated"],
        EntityKind::RevisionProposals => &[
            "open",
            "deferred",
            "approved",
            "rejected",
            "separated",
            "superseded",
        ],
        _ => return Ok(()),
    };
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(CodecError::InvalidEnumValue {
            field: "state",
            value: value.to_string(),
        })
    }
}

// ---------------------------------------------------------------------------
// Row images
// ---------------------------------------------------------------------------

/// Complete catalog row image: every catalog field present, nulls explicit.
pub type RowImage = BTreeMap<String, FieldValue>;

/// Validate a complete, correctly typed row image for `entity`.
pub fn validate_row_image(entity: EntityKind, image: &RowImage) -> Result<(), CodecError> {
    let fields = entity.all_fields();
    if image.len() != fields.len() {
        return Err(CodecError::IncompleteImage(entity.as_str()));
    }
    for name in fields {
        let value = image
            .get(*name)
            .ok_or(CodecError::IncompleteImage(entity.as_str()))?;
        validate_field_value(entity, name, value)?;
    }
    for name in image.keys() {
        if !fields.contains(&name.as_str()) {
            return Err(CodecError::UnexpectedImageField(name.clone()));
        }
    }
    // Revision span trio: all three or none (mirrors v9 CHECK).
    if entity == EntityKind::ThoughtRevisions {
        let c = image.get("capture_id");
        let s = image.get("source_start");
        let e = image.get("source_end");
        let any_null = matches!(c, Some(FieldValue::Null))
            || matches!(s, Some(FieldValue::Null))
            || matches!(e, Some(FieldValue::Null));
        let all_null = matches!(c, Some(FieldValue::Null))
            && matches!(s, Some(FieldValue::Null))
            && matches!(e, Some(FieldValue::Null));
        if any_null && !all_null {
            return Err(CodecError::IncompleteImage("thought_revisions span trio"));
        }
    }
    // Provenance spans are half-open code-point ranges: end > start.
    if matches!(
        entity,
        EntityKind::ObjectSources
            | EntityKind::ThoughtRevisions
            | EntityKind::RevisionEvidence
            | EntityKind::PendingClaims
    ) {
        if let (Some(FieldValue::Decimal(start)), Some(FieldValue::Decimal(end))) =
            (image.get("source_start"), image.get("source_end"))
        {
            let start: u64 = start
                .parse()
                .map_err(|_| CodecError::InvalidDecimal(start.clone()))?;
            let end: u64 = end
                .parse()
                .map_err(|_| CodecError::InvalidDecimal(end.clone()))?;
            if end <= start {
                return Err(CodecError::IncompleteImage("span requires end > start"));
            }
        }
    }
    Ok(())
}

fn validate_field_value(
    entity: EntityKind,
    field: &str,
    value: &FieldValue,
) -> Result<(), CodecError> {
    let nullable = entity.nullable_fields().contains(&field);
    match value {
        FieldValue::Null => {
            if nullable {
                Ok(())
            } else {
                Err(CodecError::NullForbidden(field_to_static(field)))
            }
        }
        FieldValue::Decimal(text) => {
            if !entity.int_fields().contains(&field) {
                return Err(CodecError::UnexpectedImageField(field.to_string()));
            }
            validate_decimal(text)?;
            if field == "reframing" || field == "user_edited" {
                if text != "0" && text != "1" {
                    return Err(CodecError::InvalidEnumValue {
                        field: field_to_static(field),
                        value: text.clone(),
                    });
                }
            }
            Ok(())
        }
        FieldValue::Text(text) => {
            if entity.int_fields().contains(&field) {
                return Err(CodecError::UnexpectedImageField(field.to_string()));
            }
            validate_text_field(entity, field, text)
        }
    }
}

fn validate_text_field(entity: EntityKind, field: &str, text: &str) -> Result<(), CodecError> {
    // Id and reference columns.
    if field == "id"
        || field.ends_with("_id")
        || field.ends_with("_ordinal")
        || field == "capture_id"
        || field == "object_id"
        || field == "revision_id"
    {
        // *_json columns stay original strings; everything else is an id ref.
        if !field.ends_with("_json") {
            validate_id_field(text)?;
            return Ok(());
        }
    }
    match field {
        "source" if entity == EntityKind::Captures => validate_enum_value("source", text),
        "kind" => validate_kind_value(entity, text),
        "origin" => validate_origin_value(entity, text),
        "outcome" => validate_enum_value("outcome", text),
        "decided_by" => validate_enum_value("decided_by", text),
        "unchecked_reason" => validate_enum_value("unchecked_reason", text),
        "role" => validate_enum_value("role", text),
        "state" => validate_state_value(entity, text),
        "resolved_method" => validate_enum_value("resolved_method", text),
        "change" => validate_enum_value("change", text),
        "verification_mode" => validate_enum_value("verification_mode", text),
        "verification_status" => validate_enum_value("verification_status", text),
        f if f.ends_with("_at") || f == "created_at" || f == "decided_at" => {
            validate_timestamp(text)
        }
        _ => {
            if text.is_empty() && requires_nonempty(entity, field) {
                return Err(CodecError::IncompleteImage(entity.as_str()));
            }
            Ok(())
        }
    }
}

/// Columns that must be non-empty when present as text (v9 length CHECKs).
fn requires_nonempty(entity: EntityKind, field: &str) -> bool {
    matches!(
        (entity, field),
        (_, "id")
            | (_, "name")
            | (_, "title")
            | (_, "body")
            | (_, "content")
            | (_, "created_at")
            | (_, "updated_at")
            | (_, "decided_at")
            | (_, "policy_version")
            | (EntityKind::Projects, "archived_at")
    )
}

fn field_to_static(field: &str) -> &'static str {
    match field {
        "id" => "id",
        "name" => "name",
        "created_at" => "created_at",
        "updated_at" => "updated_at",
        "archived_at" => "archived_at",
        "source" => "source",
        "content" => "content",
        "project_id" => "project_id",
        "capture_id" => "capture_id",
        "kind" => "kind",
        "title" => "title",
        "body" => "body",
        "current_revision_id" => "current_revision_id",
        "object_id" => "object_id",
        "source_start" => "source_start",
        "source_end" => "source_end",
        "revision_id" => "revision_id",
        "origin" => "origin",
        "child_revision_id" => "child_revision_id",
        "parent_revision_id" => "parent_revision_id",
        "ordinal" => "ordinal",
        "outcome" => "outcome",
        "unchecked_reason" => "unchecked_reason",
        "target_object_id" => "target_object_id",
        "base_revision_id" => "base_revision_id",
        "result_revision_id" => "result_revision_id",
        "created_object_id" => "created_object_id",
        "policy_version" => "policy_version",
        "model_id" => "model_id",
        "decided_by" => "decided_by",
        "vetoes_json" => "vetoes_json",
        "audit_json" => "audit_json",
        "decided_at" => "decided_at",
        "role" => "role",
        "retracts_revision_id" => "retracts_revision_id",
        "retracts_ordinal" => "retracts_ordinal",
        "interpretation_label" => "interpretation_label",
        "reframing" => "reframing",
        "state" => "state",
        "due_at" => "due_at",
        "deferred_at" => "deferred_at",
        "resolved_at" => "resolved_at",
        "resolved_method" => "resolved_method",
        "resolved_object_id" => "resolved_object_id",
        "resolved_revision_id" => "resolved_revision_id",
        "pending_claim_id" => "pending_claim_id",
        "change" => "change",
        "proposed_body" => "proposed_body",
        "evidence_json" => "evidence_json",
        "synthesis_model" => "synthesis_model",
        "verifier_model" => "verifier_model",
        "verification_mode" => "verification_mode",
        "verification_status" => "verification_status",
        "user_edited" => "user_edited",
        "final_body" => "final_body",
        "reviewed_at" => "reviewed_at",
        "source_object_id" => "source_object_id",
        "candidate_ids_json" => "candidate_ids_json",
        "reasons_json" => "reasons_json",
        _ => "field",
    }
}

// ---------------------------------------------------------------------------
// Event model
// ---------------------------------------------------------------------------

/// Reference to a causally prior event, or an explicit legacy baseline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventRef {
    pub origin_id: String,
    pub incarnation: String,
    pub seq: String,
    pub event_id: String,
    pub hash: String,
}

impl EventRef {
    pub fn validate(&self) -> Result<(), CodecError> {
        validate_canonical_uuid(&self.origin_id)?;
        validate_canonical_uuid(&self.incarnation)?;
        validate_decimal(&self.seq)?;
        if self.seq == "0" {
            return Err(CodecError::InvalidDecimal(self.seq.clone()));
        }
        validate_canonical_uuid(&self.event_id)?;
        validate_hash_hex(&self.hash)?;
        Ok(())
    }
}

/// Sorted dependency: entity, logical key, optional causal event ref.
/// A null event ref is an explicit legacy-baseline dependency.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dependency {
    pub entity: EntityKind,
    pub key: Vec<String>,
    pub event_ref: Option<EventRef>,
}

/// Human review actions that may accompany a claim/proposal transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewAction {
    Approve,
    EditAndApprove,
    Reject,
    KeepSeparate,
    Defer,
    Reopen,
    Supersede,
}

impl ReviewAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Approve => "approve",
            Self::EditAndApprove => "edit_and_approve",
            Self::Reject => "reject",
            Self::KeepSeparate => "keep_separate",
            Self::Defer => "defer",
            Self::Reopen => "reopen",
            Self::Supersede => "supersede",
        }
    }

    pub fn from_str(text: &str) -> Result<Self, CodecError> {
        match text {
            "approve" => Ok(Self::Approve),
            "edit_and_approve" => Ok(Self::EditAndApprove),
            "reject" => Ok(Self::Reject),
            "keep_separate" => Ok(Self::KeepSeparate),
            "defer" => Ok(Self::Defer),
            "reopen" => Ok(Self::Reopen),
            "supersede" => Ok(Self::Supersede),
            other => Err(CodecError::InvalidEnumValue {
                field: "review_action",
                value: other.to_string(),
            }),
        }
    }
}

/// How a review outcome was produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewMethod {
    User,
    Expiry,
    DerivedClaimResolution,
}

impl ReviewMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Expiry => "expiry",
            Self::DerivedClaimResolution => "derived_claim_resolution",
        }
    }

    pub fn from_str(text: &str) -> Result<Self, CodecError> {
        match text {
            "user" => Ok(Self::User),
            "expiry" => Ok(Self::Expiry),
            "derived_claim_resolution" => Ok(Self::DerivedClaimResolution),
            other => Err(CodecError::InvalidEnumValue {
                field: "review_method",
                value: other.to_string(),
            }),
        }
    }
}

/// Operation-local review proof for claim/proposal state transitions.
/// Nulls are explicit where inapplicable. This is local factual provenance,
/// never proof of a historical signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewProof {
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

/// Immutable creation of one catalog row with its full final image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordCreate {
    pub entity: EntityKind,
    pub key: Vec<String>,
    pub after: RowImage,
}

/// Mutable facet transition with expected prior states.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FacetUpdate {
    pub entity: EntityKind,
    pub key: Vec<String>,
    pub before: RowImage,
    pub after: RowImage,
    pub expected: BTreeMap<String, ExpectedFacet>,
    pub review_proof: Option<ReviewProof>,
}

/// Expected prior state of one changed facet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedFacet {
    pub event_ref: Option<EventRef>,
    pub before_hash: String,
}

/// Observed removal of a MODEL edge. User/system deletions are rejected by
/// the reducer and never reach this type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelationRemove {
    pub key: Vec<String>,
    pub before: RowImage,
    pub observed_create: ObservedCreate,
}

/// Prior creation evidence for a removed edge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObservedCreate {
    Event(EventRef),
    LegacyHash(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Operation {
    RecordCreate(RecordCreate),
    FacetUpdate(FacetUpdate),
    RelationRemove(RelationRemove),
}

impl Operation {
    pub fn entity(&self) -> EntityKind {
        match self {
            Self::RecordCreate(op) => op.entity,
            Self::FacetUpdate(op) => op.entity,
            Self::RelationRemove(_) => EntityKind::Relations,
        }
    }

    pub fn key(&self) -> &[String] {
        match self {
            Self::RecordCreate(op) => &op.key,
            Self::FacetUpdate(op) => &op.key,
            Self::RelationRemove(op) => &op.key,
        }
    }
}

/// One immutable journal event core, ready for canonical encoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalEvent {
    pub bundle_id: String,
    pub committed_at: String,
    pub dependencies: Vec<Dependency>,
    pub event_id: String,
    pub operation_version: u32,
    pub operations: Vec<Operation>,
    pub origin_id: String,
    pub origin_incarnation: String,
    pub origin_seq: String,
    pub previous_event_hash: String,
    pub provenance_class: String,
    pub raw_effect_count: String,
}

// ---------------------------------------------------------------------------
// Canonical encoding
// ---------------------------------------------------------------------------

fn image_to_json(image: &RowImage) -> Value {
    let mut map = Map::with_capacity(image.len());
    for (key, value) in image {
        map.insert(key.clone(), value.to_json());
    }
    Value::Object(map)
}

fn event_ref_to_json(r: &EventRef) -> Value {
    serde_json::json!({
        "originId": r.origin_id,
        "incarnation": r.incarnation,
        "seq": r.seq,
        "eventId": r.event_id,
        "hash": r.hash,
    })
}

fn dependency_to_json(dep: &Dependency) -> Value {
    serde_json::json!({
        "entity": dep.entity.as_str(),
        "key": dep.key,
        "eventRef": dep.event_ref.as_ref().map(event_ref_to_json).unwrap_or(Value::Null),
    })
}

fn review_proof_to_json(proof: &ReviewProof) -> Value {
    serde_json::json!({
        "action": proof.action.as_str(),
        "proposalId": proof.proposal_id.clone().map(Value::String).unwrap_or(Value::Null),
        "claimId": proof.claim_id.clone().map(Value::String).unwrap_or(Value::Null),
        "objectId": proof.object_id.clone().map(Value::String).unwrap_or(Value::Null),
        "reviewedRevisionId": proof.reviewed_revision_id.clone().map(Value::String).unwrap_or(Value::Null),
        "finalBody": proof.final_body.clone().map(Value::String).unwrap_or(Value::Null),
        "userEdited": proof.user_edited.map(Value::Bool).unwrap_or(Value::Null),
        "resultRevisionId": proof.result_revision_id.clone().map(Value::String).unwrap_or(Value::Null),
        "method": proof.method.map(|m| Value::String(m.as_str().to_string())).unwrap_or(Value::Null),
    })
}

fn operation_to_json(op: &Operation) -> Value {
    match op {
        Operation::RecordCreate(c) => serde_json::json!({
            "kind": "record.create",
            "version": OPERATION_VERSION,
            "entity": c.entity.as_str(),
            "key": c.key,
            "after": image_to_json(&c.after),
        }),
        Operation::FacetUpdate(u) => {
            let mut expected = Map::new();
            for (facet, state) in &u.expected {
                expected.insert(
                    facet.clone(),
                    serde_json::json!({
                        "eventRef": state.event_ref.as_ref().map(event_ref_to_json).unwrap_or(Value::Null),
                        "beforeHash": state.before_hash,
                    }),
                );
            }
            serde_json::json!({
                "kind": "facet.update",
                "version": OPERATION_VERSION,
                "entity": u.entity.as_str(),
                "key": u.key,
                "before": image_to_json(&u.before),
                "after": image_to_json(&u.after),
                "expected": Value::Object(expected),
                "reviewProof": u.review_proof.as_ref().map(review_proof_to_json).unwrap_or(Value::Null),
            })
        }
        Operation::RelationRemove(r) => serde_json::json!({
            "kind": "relation.remove",
            "version": OPERATION_VERSION,
            "entity": "relations",
            "key": r.key,
            "before": image_to_json(&r.before),
            "observedCreate": match &r.observed_create {
                ObservedCreate::Event(e) => event_ref_to_json(e),
                ObservedCreate::LegacyHash(h) => serde_json::json!({ "legacyHash": h }),
            },
        }),
    }
}

/// Validate the logical event without encoding it.
pub fn validate_event(event: &JournalEvent) -> Result<(), CodecError> {
    validate_canonical_uuid(&event.bundle_id)?;
    validate_timestamp(&event.committed_at)?;
    validate_canonical_uuid(&event.event_id)?;
    if event.operation_version != OPERATION_VERSION {
        return Err(CodecError::UnsupportedOperationVersion(
            event.operation_version as u64,
        ));
    }
    if event.operations.is_empty() {
        return Err(CodecError::EmptyOperations);
    }
    if event.operations.len() > MAX_EFFECTS {
        return Err(CodecError::TooManyOperations(event.operations.len()));
    }
    if event.dependencies.len() > MAX_DEPENDENCIES {
        return Err(CodecError::TooManyDependencies(event.dependencies.len()));
    }
    validate_canonical_uuid(&event.origin_id)?;
    validate_canonical_uuid(&event.origin_incarnation)?;
    validate_decimal(&event.origin_seq)?;
    if event.origin_seq == "0" {
        return Err(CodecError::InvalidDecimal(event.origin_seq.clone()));
    }
    // SQL guard parity: origin cursors are int64.
    let seq: u64 = event
        .origin_seq
        .parse()
        .map_err(|_| CodecError::InvalidDecimal(event.origin_seq.clone()))?;
    if seq > i64::MAX as u64 {
        return Err(CodecError::InvalidDecimal(event.origin_seq.clone()));
    }
    validate_hash_hex(&event.previous_event_hash)?;
    if event.provenance_class != PROVENANCE_LOCAL_COMMITTED {
        return Err(CodecError::InvalidEnumValue {
            field: "provenance_class",
            value: event.provenance_class.clone(),
        });
    }
    validate_decimal(&event.raw_effect_count)?;
    // SQL parity (sync_bundles.raw_effect_count BETWEEN 1 AND 4096): the
    // count of observed effects, not the number of reduced operations.
    let raw_count: u64 = event
        .raw_effect_count
        .parse()
        .map_err(|_| CodecError::InvalidDecimal(event.raw_effect_count.clone()))?;
    if raw_count < 1 || raw_count > MAX_EFFECTS as u64 {
        return Err(CodecError::InvalidDecimal(event.raw_effect_count.clone()));
    }
    for dep in &event.dependencies {
        validate_key(dep.entity, &dep.key)?;
        if let Some(r) = &dep.event_ref {
            r.validate()?;
        }
    }
    for op in &event.operations {
        validate_operation(op)?;
    }
    Ok(())
}

fn validate_operation(op: &Operation) -> Result<(), CodecError> {
    match op {
        Operation::RecordCreate(c) => {
            validate_key(c.entity, &c.key)?;
            validate_row_image(c.entity, &c.after)?;
            validate_key_matches_image(c.entity, &c.key, &c.after)?;
        }
        Operation::FacetUpdate(u) => {
            if !u.entity.is_facet_mutable() {
                return Err(CodecError::UnknownEntity(u.entity.as_str().to_string()));
            }
            validate_key(u.entity, &u.key)?;
            validate_row_image(u.entity, &u.before)?;
            validate_row_image(u.entity, &u.after)?;
            validate_key_matches_image(u.entity, &u.key, &u.before)?;
            validate_key_matches_image(u.entity, &u.key, &u.after)?;
            validate_facet_transition(u)?;
            for state in u.expected.values() {
                if let Some(r) = &state.event_ref {
                    r.validate()?;
                }
                validate_hash_hex(&state.before_hash)?;
            }
        }
        Operation::RelationRemove(r) => {
            validate_key(EntityKind::Relations, &r.key)?;
            validate_row_image(EntityKind::Relations, &r.before)?;
            validate_key_matches_image(EntityKind::Relations, &r.key, &r.before)?;
            // Observed-remove tombstones cover original MODEL edges only.
            // Row validation above already enforces the closed origin
            // vocabulary; this rule restricts the operation, never the
            // stored domain rows (user/system creations stay valid).
            if !matches!(r.before.get("origin"), Some(FieldValue::Text(origin)) if origin == "model")
            {
                return Err(CodecError::NonModelRelationRemoval);
            }
            match &r.observed_create {
                ObservedCreate::Event(e) => e.validate()?,
                ObservedCreate::LegacyHash(h) => validate_hash_hex(h)?,
            }
        }
    }
    Ok(())
}

/// Key shape: right length, id fields valid, ordinal keys decimal, and every
/// key element equals the matching image field.
pub fn validate_key(entity: EntityKind, key: &[String]) -> Result<(), CodecError> {
    let fields = entity.key_fields();
    if key.len() != fields.len() {
        return Err(CodecError::MalformedKey(format!(
            "{} expects {} key elements, got {}",
            entity.as_str(),
            fields.len(),
            key.len()
        )));
    }
    for (index, element) in key.iter().enumerate() {
        if entity.key_element_is_decimal(index) {
            validate_decimal(element)?;
        } else {
            validate_id_field(element)?;
        }
    }
    Ok(())
}

fn key_image_field(entity: EntityKind, key_index: usize) -> &'static str {
    entity.key_fields()[key_index]
}

fn validate_key_matches_image(
    entity: EntityKind,
    key: &[String],
    image: &RowImage,
) -> Result<(), CodecError> {
    for (index, element) in key.iter().enumerate() {
        let field = key_image_field(entity, index);
        match image.get(field) {
            Some(FieldValue::Text(t)) if t == element => {}
            Some(FieldValue::Decimal(d)) if d == element => {}
            _ => return Err(CodecError::MissingKeyField(field_to_static(field))),
        }
    }
    Ok(())
}

/// Facet transition rules: changed facets must be known, immutable fields
/// must stay byte-equal, and every changed facet needs an expected entry.
///
/// Project metadata exception: `project_store.rs` persists `updated_at`
/// together with every rename/archive/restore, so a project facet update may
/// carry the accompanying timestamp. `updated_at` is never a standalone
/// causal facet: an isolated timestamp bump without a meaningful project
/// facet change is rejected below.
fn validate_facet_transition(update: &FacetUpdate) -> Result<(), CodecError> {
    let facets = facets_of(update.entity);
    let mut changed: Vec<&FacetDef> = Vec::new();
    for facet in facets {
        let mut differs = false;
        for field in facet.fields {
            if update.before.get(*field) != update.after.get(*field) {
                differs = true;
                break;
            }
        }
        if differs {
            changed.push(facet);
        }
    }
    // Project metadata exception: updated_at accompanies a meaningful
    // project facet transition (rename/archive/restore write both columns).
    let accompanies_project_change = update.entity == EntityKind::Projects
        && !changed.is_empty()
        && update.before.get("updated_at") != update.after.get("updated_at");
    // Immutable fields: every catalog field outside all facets must be equal.
    for field in update.entity.all_fields() {
        let in_facet = facets.iter().any(|f| f.fields.contains(field));
        let is_accompanied = accompanies_project_change && *field == "updated_at";
        if !in_facet && !is_accompanied && update.before.get(*field) != update.after.get(*field) {
            return Err(CodecError::ImmutableFieldChanged {
                field: field_to_static(field),
            });
        }
    }
    if update.entity == EntityKind::Projects
        && changed.is_empty()
        && update.before.get("updated_at") != update.after.get("updated_at")
    {
        // An isolated timestamp bump is not an independent causal update.
        return Err(CodecError::ImmutableFieldChanged {
            field: "updated_at",
        });
    }
    for facet in &changed {
        if !update.expected.contains_key(facet.name) {
            return Err(CodecError::MissingField("expected facet state"));
        }
    }
    // Exact closed vocabulary: every expected key must name a meaningful
    // facet that actually changed in this operation. Unknown names, names
    // from another entity's catalog and valid-but-unchanged facets are all
    // rejected deterministically in map order. The closed ASCII catalog in
    // `facets_of()` is the only source of truth; no second list exists.
    for supplied in update.expected.keys() {
        let catalogued = facets.iter().any(|f| f.name == supplied.as_str());
        let changed_now = changed.iter().any(|f| f.name == supplied.as_str());
        if !catalogued || !changed_now {
            return Err(CodecError::UnexpectedField(format!("expected.{supplied}")));
        }
    }
    // Mandatory operation-local review provenance (shared by encode, strict
    // decode and shape validation: one rule, no per-entry-point divergence).
    // A claim/proposal STATE transition must carry its proof; a metadata-only
    // update needs none and must not invent one; proof anywhere else is
    // misplaced. Never fabricate an action, actor or identity here.
    let is_review_entity = matches!(
        update.entity,
        EntityKind::PendingClaims | EntityKind::RevisionProposals
    );
    let state_changed = update.before.get("state") != update.after.get("state");
    match (&update.review_proof, is_review_entity && state_changed) {
        (None, true) => {
            return Err(CodecError::MissingReviewProof {
                entity: update.entity.as_str(),
            });
        }
        (Some(_), false) => {
            return Err(CodecError::UnexpectedField("reviewProof".to_string()));
        }
        (Some(proof), true) => validate_review_proof(proof, update)?,
        (None, false) => {}
    }
    Ok(())
}

/// Operation-aware review-proof validation: syntax plus identity binding
/// against the actual transitioned row. Only identities verifiable from the
/// operation itself (entity, key, before-image) are enforced here; broader
/// cross-row association belongs to store/closure validation, never to
/// silent fabrication. Nothing is ever invented or rewritten.
fn validate_review_proof(proof: &ReviewProof, update: &FacetUpdate) -> Result<(), CodecError> {
    if !matches!(
        update.entity,
        EntityKind::PendingClaims | EntityKind::RevisionProposals
    ) {
        return Err(CodecError::UnexpectedField("reviewProof".to_string()));
    }
    for id in [
        proof.proposal_id.as_ref(),
        proof.claim_id.as_ref(),
        proof.object_id.as_ref(),
        proof.reviewed_revision_id.as_ref(),
        proof.result_revision_id.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        validate_id_field(id)?;
    }
    let row_id = update.key.first().cloned().unwrap_or_default();
    match update.entity {
        EntityKind::PendingClaims => match &proof.claim_id {
            Some(claim) if claim == &row_id => {}
            _ => {
                return Err(CodecError::InvalidReviewProofIdentity { field: "claimId" });
            }
        },
        EntityKind::RevisionProposals => {
            match &proof.proposal_id {
                Some(proposal) if proposal == &row_id => {}
                _ => {
                    return Err(CodecError::InvalidReviewProofIdentity {
                        field: "proposalId",
                    });
                }
            }
            let actual = update.before.get("pending_claim_id");
            let matches_row = match (&proof.claim_id, actual) {
                (Some(claim), Some(FieldValue::Text(row))) => claim == row,
                _ => false,
            };
            if !matches_row {
                return Err(CodecError::InvalidReviewProofIdentity { field: "claimId" });
            }
        }
        _ => {
            return Err(CodecError::UnexpectedField("reviewProof".to_string()));
        }
    }
    Ok(())
}

/// Validate a facet update shape without encoding (shared with the reducer).
pub fn validate_facet_update_shape(update: &FacetUpdate) -> Result<(), CodecError> {
    validate_key(update.entity, &update.key)?;
    validate_row_image(update.entity, &update.before)?;
    validate_row_image(update.entity, &update.after)?;
    validate_facet_transition(update)?;
    for state in update.expected.values() {
        if let Some(r) = &state.event_ref {
            r.validate()?;
        }
        validate_hash_hex(&state.before_hash)?;
    }
    Ok(())
}

/// Encode the event core to deterministic RFC 8785 canonical bytes.
/// The event value is never mutated: retry encodes identical bytes.
pub fn encode_canonical(event: &JournalEvent) -> Result<Vec<u8>, CodecError> {
    validate_event(event)?;
    let mut operations = Vec::with_capacity(event.operations.len());
    for op in &event.operations {
        operations.push(operation_to_json(op));
    }
    let mut dependencies = Vec::with_capacity(event.dependencies.len());
    for dep in &event.dependencies {
        dependencies.push(dependency_to_json(dep));
    }
    let core = serde_json::json!({
        "bundleId": event.bundle_id,
        "committedAt": event.committed_at,
        "dependencies": dependencies,
        "eventId": event.event_id,
        "operationVersion": event.operation_version,
        "operations": operations,
        "originId": event.origin_id,
        "originIncarnation": event.origin_incarnation,
        "originSeq": event.origin_seq,
        "previousEventHash": event.previous_event_hash,
        "provenanceClass": event.provenance_class,
        "rawEffectCount": event.raw_effect_count,
    });
    let bytes = serde_jcs::to_vec(&core).map_err(|e| CodecError::Serialization(e.to_string()))?;
    if bytes.len() > MAX_CANONICAL_BYTES {
        return Err(CodecError::OversizeBundle {
            bytes: bytes.len(),
            limit: MAX_CANONICAL_BYTES,
        });
    }
    Ok(bytes)
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/// Lowercase hex rendering of a SHA-256 digest.
pub fn hash_hex(digest: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Domain-separated integrity hash over canonical core bytes.
pub fn journal_event_hash(canonical: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(DOMAIN_SEP_BUNDLE);
    hasher.update([DOMAIN_SEP_BYTE]);
    hasher.update(canonical);
    let out = hasher.finalize();
    let mut digest = [0u8; 32];
    digest.copy_from_slice(&out);
    digest
}

/// Facet/record state hash over a versioned JCS projection.
/// The projection shape is part of the hash contract: entity, facet name,
/// logical key, full state image and projection version.
pub fn facet_state_hash(
    entity: EntityKind,
    facet: &str,
    key: &[String],
    state: &RowImage,
) -> Result<[u8; 32], CodecError> {
    for segment in facet.split('.') {
        if segment.is_empty()
            || !segment
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return Err(CodecError::UnexpectedField(facet.to_string()));
        }
    }
    let projection = serde_json::json!({
        "entity": entity.as_str(),
        "facet": facet,
        "key": key,
        "state": image_to_json(state),
        "version": 1,
    });
    let bytes =
        serde_jcs::to_vec(&projection).map_err(|e| CodecError::Serialization(e.to_string()))?;
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(DOMAIN_SEP_FACET);
    hasher.update([DOMAIN_SEP_BYTE]);
    hasher.update(&bytes);
    let out = hasher.finalize();
    let mut digest = [0u8; 32];
    digest.copy_from_slice(&out);
    Ok(digest)
}

// ---------------------------------------------------------------------------
// Strict decoding of untrusted input
// ---------------------------------------------------------------------------

/// Decode canonical bytes back to a typed event, rejecting duplicate keys,
/// over-deep nesting, unknown fields, unsupported versions and any
/// non-canonical rendering (re-encode must reproduce the input bytes).
pub fn decode_core_strict(bytes: &[u8]) -> Result<JournalEvent, CodecError> {
    // Admission before scanning, parsing or materializing: oversized input
    // fails here with the actual received length, never a parser error.
    if bytes.len() > MAX_CANONICAL_BYTES {
        return Err(CodecError::OversizeBundle {
            bytes: bytes.len(),
            limit: MAX_CANONICAL_BYTES,
        });
    }
    scan_json_object_keys(bytes)?;
    let value: Value =
        serde_json::from_slice(bytes).map_err(|e| CodecError::MalformedJson(e.to_string()))?;
    reject_non_integer_numbers(&value)?;
    let event = event_from_json(&value)?;
    validate_event(&event)?;
    let canonical = encode_canonical(&event)?;
    if canonical.as_slice() != bytes {
        return Err(CodecError::NotCanonical);
    }
    Ok(event)
}

/// Reject every JSON number that is not an integer. Our vocabulary encodes
/// integers as decimal strings; the single protocol integer
/// (`operationVersion`) must be exact. Floats, exponents and -0 forms fail.
fn reject_non_integer_numbers(value: &Value) -> Result<(), CodecError> {
    match value {
        Value::Number(n) => {
            if n.is_i64() || n.is_u64() {
                Ok(())
            } else {
                Err(CodecError::FloatForbidden)
            }
        }
        Value::Array(items) => {
            for item in items {
                reject_non_integer_numbers(item)?;
            }
            Ok(())
        }
        Value::Object(map) => {
            for value in map.values() {
                reject_non_integer_numbers(value)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Scan raw JSON bytes: every object key set must be duplicate-free and
/// nesting must stay within `MAX_JSON_DEPTH`. Keys compare by decoded value.
fn scan_json_object_keys(bytes: &[u8]) -> Result<(), CodecError> {
    enum Frame {
        Object { keys: Vec<Vec<u8>> },
        Array,
    }
    let mut stack: Vec<Frame> = Vec::new();
    let mut i = 0usize;

    // Decodes one JSON string starting at bytes[i] == b'"'. Returns the
    // decoded UTF-8 bytes and the index just past the closing quote.
    fn read_string(bytes: &[u8], mut i: usize) -> Result<(Vec<u8>, usize), CodecError> {
        // bytes[i] is the opening quote.
        i += 1;
        let mut out: Vec<u8> = Vec::new();
        loop {
            let b = *bytes
                .get(i)
                .ok_or(CodecError::MalformedJson("eof".to_string()))?;
            if b == b'"' {
                return Ok((out, i + 1));
            }
            if b == b'\\' {
                i += 1;
                let e = *bytes
                    .get(i)
                    .ok_or(CodecError::MalformedJson("eof".to_string()))?;
                match e {
                    b'"' => out.push(b'"'),
                    b'\\' => out.push(b'\\'),
                    b'/' => out.push(b'/'),
                    b'b' => out.push(0x08),
                    b'f' => out.push(0x0c),
                    b'n' => out.push(0x0a),
                    b'r' => out.push(0x0d),
                    b't' => out.push(0x09),
                    b'u' => {
                        if i + 4 >= bytes.len() {
                            return Err(CodecError::MalformedJson("eof".to_string()));
                        }
                        let hex = std::str::from_utf8(&bytes[i + 1..i + 5])
                            .map_err(|_| CodecError::MalformedJson("hex".to_string()))?;
                        let mut unit = u32::from_str_radix(hex, 16)
                            .map_err(|_| CodecError::MalformedJson("hex".to_string()))?;
                        i += 4;
                        // Surrogate pair.
                        if (0xD800..0xDC00).contains(&unit) {
                            if bytes.get(i + 1) != Some(&b'\\') || bytes.get(i + 2) != Some(&b'u') {
                                return Err(CodecError::MalformedJson("pair".to_string()));
                            }
                            if i + 6 >= bytes.len() {
                                return Err(CodecError::MalformedJson("eof".to_string()));
                            }
                            let hex2 = std::str::from_utf8(&bytes[i + 3..i + 7])
                                .map_err(|_| CodecError::MalformedJson("hex".to_string()))?;
                            let low = u32::from_str_radix(hex2, 16)
                                .map_err(|_| CodecError::MalformedJson("hex".to_string()))?;
                            if !(0xDC00..0xE000).contains(&low) {
                                return Err(CodecError::MalformedJson("pair".to_string()));
                            }
                            unit = 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00);
                            i += 6;
                        } else if (0xDC00..0xE000).contains(&unit) {
                            return Err(CodecError::MalformedJson("lone".to_string()));
                        }
                        let ch = char::from_u32(unit)
                            .ok_or(CodecError::MalformedJson("scalar".to_string()))?;
                        let mut buf = [0u8; 4];
                        out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                    }
                    _ => return Err(CodecError::MalformedJson("escape".to_string())),
                }
                i += 1;
            } else if b < 0x20 {
                return Err(CodecError::MalformedJson("control".to_string()));
            } else {
                out.push(b);
                i += 1;
            }
        }
    }

    while i < bytes.len() {
        let b = bytes[i];
        match b {
            b'"' => {
                let (decoded, next) = read_string(bytes, i)?;
                // Determine whether this string is an object key: skip
                // whitespace, then check for ':'.
                let mut j = next;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < bytes.len() && bytes[j] == b':' {
                    // Object key position.
                    match stack.last_mut() {
                        Some(Frame::Object { keys }) => {
                            if keys.contains(&decoded) {
                                let label = String::from_utf8_lossy(&decoded).into_owned();
                                return Err(CodecError::DuplicateKey(label));
                            }
                            keys.push(decoded);
                        }
                        _ => return Err(CodecError::MalformedJson("key".to_string())),
                    }
                }
                i = next;
                continue;
            }
            b'{' => {
                if stack.len() + 1 > MAX_JSON_DEPTH {
                    return Err(CodecError::JsonTooDeep);
                }
                stack.push(Frame::Object { keys: Vec::new() });
            }
            b'}' => match stack.pop() {
                Some(Frame::Object { .. }) => {}
                _ => return Err(CodecError::MalformedJson("brace".to_string())),
            },
            b'[' => {
                if stack.len() + 1 > MAX_JSON_DEPTH {
                    return Err(CodecError::JsonTooDeep);
                }
                stack.push(Frame::Array);
            }
            b']' => match stack.pop() {
                Some(Frame::Array) => {}
                _ => return Err(CodecError::MalformedJson("bracket".to_string())),
            },
            _ => {}
        }
        i += 1;
    }
    if !stack.is_empty() {
        return Err(CodecError::MalformedJson("truncated".to_string()));
    }
    Ok(())
}

fn get_object<'a>(
    value: &'a Value,
    ctx: &'static str,
) -> Result<&'a Map<String, Value>, CodecError> {
    value.as_object().ok_or(CodecError::MissingField(ctx))
}

fn get_str<'a>(map: &'a Map<String, Value>, field: &'static str) -> Result<&'a str, CodecError> {
    map.get(field)
        .and_then(|v| v.as_str())
        .ok_or(CodecError::MissingField(field))
}

fn check_no_extra_fields(
    map: &Map<String, Value>,
    allowed: &[&str],
    ctx: String,
) -> Result<(), CodecError> {
    for key in map.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(CodecError::UnexpectedField(format!("{ctx}.{key}")));
        }
    }
    Ok(())
}

const CORE_FIELDS: &[&str] = &[
    "bundleId",
    "committedAt",
    "dependencies",
    "eventId",
    "operationVersion",
    "operations",
    "originId",
    "originIncarnation",
    "originSeq",
    "previousEventHash",
    "provenanceClass",
    "rawEffectCount",
];

fn event_from_json(value: &Value) -> Result<JournalEvent, CodecError> {
    let map = get_object(value, "core")?;
    check_no_extra_fields(map, CORE_FIELDS, "core".to_string())?;
    let dependencies = map
        .get("dependencies")
        .and_then(|v| v.as_array())
        .ok_or(CodecError::MissingField("dependencies"))?;
    let operations = map
        .get("operations")
        .and_then(|v| v.as_array())
        .ok_or(CodecError::MissingField("operations"))?;
    let operation_version = map
        .get("operationVersion")
        .and_then(|v| v.as_u64())
        .ok_or(CodecError::MissingField("operationVersion"))?;
    if operation_version != OPERATION_VERSION as u64 {
        return Err(CodecError::UnsupportedOperationVersion(operation_version));
    }
    let mut deps = Vec::with_capacity(dependencies.len());
    for dep in dependencies {
        deps.push(dependency_from_json(dep)?);
    }
    let mut ops = Vec::with_capacity(operations.len());
    for op in operations {
        ops.push(operation_from_json(op)?);
    }
    Ok(JournalEvent {
        bundle_id: get_str(map, "bundleId")?.to_string(),
        committed_at: get_str(map, "committedAt")?.to_string(),
        dependencies: deps,
        event_id: get_str(map, "eventId")?.to_string(),
        operation_version: OPERATION_VERSION,
        operations: ops,
        origin_id: get_str(map, "originId")?.to_string(),
        origin_incarnation: get_str(map, "originIncarnation")?.to_string(),
        origin_seq: get_str(map, "originSeq")?.to_string(),
        previous_event_hash: get_str(map, "previousEventHash")?.to_string(),
        provenance_class: get_str(map, "provenanceClass")?.to_string(),
        raw_effect_count: get_str(map, "rawEffectCount")?.to_string(),
    })
}

const DEP_FIELDS: &[&str] = &["entity", "key", "eventRef"];
const REF_FIELDS: &[&str] = &["originId", "incarnation", "seq", "eventId", "hash"];

fn event_ref_from_json(value: &Value) -> Result<EventRef, CodecError> {
    let map = get_object(value, "eventRef")?;
    check_no_extra_fields(map, REF_FIELDS, "eventRef".to_string())?;
    Ok(EventRef {
        origin_id: get_str(map, "originId")?.to_string(),
        incarnation: get_str(map, "incarnation")?.to_string(),
        seq: get_str(map, "seq")?.to_string(),
        event_id: get_str(map, "eventId")?.to_string(),
        hash: get_str(map, "hash")?.to_string(),
    })
}

fn dependency_from_json(value: &Value) -> Result<Dependency, CodecError> {
    let map = get_object(value, "dependency")?;
    check_no_extra_fields(map, DEP_FIELDS, "dependency".to_string())?;
    let entity = EntityKind::from_str(get_str(map, "entity")?)?;
    let key = key_from_json(map.get("key").ok_or(CodecError::MissingField("key"))?)?;
    let event_ref = match map.get("eventRef") {
        None | Some(Value::Null) => None,
        Some(v) => Some(event_ref_from_json(v)?),
    };
    Ok(Dependency {
        entity,
        key,
        event_ref,
    })
}

fn key_from_json(value: &Value) -> Result<Vec<String>, CodecError> {
    let items = value.as_array().ok_or(CodecError::MissingField("key"))?;
    let mut key = Vec::with_capacity(items.len());
    for item in items {
        key.push(
            item.as_str()
                .ok_or(CodecError::MalformedKey(
                    "key elements must be strings".to_string(),
                ))?
                .to_string(),
        );
    }
    Ok(key)
}

fn image_from_json(entity: EntityKind, value: &Value) -> Result<RowImage, CodecError> {
    let map = get_object(value, "image")?;
    let mut image = RowImage::new();
    for (name, item) in map {
        let field = entity
            .all_fields()
            .iter()
            .find(|f| **f == name.as_str())
            .ok_or_else(|| CodecError::UnexpectedImageField(name.clone()))?;
        let stored = if entity.int_fields().contains(field) {
            match item {
                Value::Null => FieldValue::Null,
                Value::String(s) => FieldValue::Decimal(s.clone()),
                _ => return Err(CodecError::UnexpectedImageField(name.clone())),
            }
        } else {
            match item {
                Value::Null => FieldValue::Null,
                Value::String(s) => FieldValue::Text(s.clone()),
                _ => return Err(CodecError::FloatForbidden),
            }
        };
        image.insert(name.clone(), stored);
    }
    Ok(image)
}

const CREATE_FIELDS: &[&str] = &["kind", "version", "entity", "key", "after"];
const UPDATE_FIELDS: &[&str] = &[
    "kind",
    "version",
    "entity",
    "key",
    "before",
    "after",
    "expected",
    "reviewProof",
];
const REMOVE_FIELDS: &[&str] = &[
    "kind",
    "version",
    "entity",
    "key",
    "before",
    "observedCreate",
];

fn operation_from_json(value: &Value) -> Result<Operation, CodecError> {
    let map = get_object(value, "operation")?;
    let kind = get_str(map, "kind")?;
    let version = map
        .get("version")
        .and_then(|v| v.as_u64())
        .ok_or(CodecError::MissingField("version"))?;
    if version != OPERATION_VERSION as u64 {
        return Err(CodecError::UnsupportedOperationVersion(version));
    }
    match kind {
        "record.create" => {
            check_no_extra_fields(map, CREATE_FIELDS, "record.create".to_string())?;
            let entity = EntityKind::from_str(get_str(map, "entity")?)?;
            let key = key_from_json(map.get("key").ok_or(CodecError::MissingField("key"))?)?;
            let after = image_from_json(
                entity,
                map.get("after").ok_or(CodecError::MissingField("after"))?,
            )?;
            Ok(Operation::RecordCreate(RecordCreate { entity, key, after }))
        }
        "facet.update" => {
            check_no_extra_fields(map, UPDATE_FIELDS, "facet.update".to_string())?;
            let entity = EntityKind::from_str(get_str(map, "entity")?)?;
            let key = key_from_json(map.get("key").ok_or(CodecError::MissingField("key"))?)?;
            let before = image_from_json(
                entity,
                map.get("before")
                    .ok_or(CodecError::MissingField("before"))?,
            )?;
            let after = image_from_json(
                entity,
                map.get("after").ok_or(CodecError::MissingField("after"))?,
            )?;
            let expected_map = map
                .get("expected")
                .and_then(|v| v.as_object())
                .ok_or(CodecError::MissingField("expected"))?;
            let mut expected = BTreeMap::new();
            for (facet, state) in expected_map {
                let state_map = state
                    .as_object()
                    .ok_or(CodecError::MissingField("expected facet"))?;
                if state_map.len() != 2
                    || !state_map.contains_key("eventRef")
                    || !state_map.contains_key("beforeHash")
                {
                    return Err(CodecError::UnexpectedField(format!("expected.{facet}")));
                }
                let event_ref = match &state_map["eventRef"] {
                    Value::Null => None,
                    v => Some(event_ref_from_json(v)?),
                };
                let before_hash = state_map["beforeHash"]
                    .as_str()
                    .ok_or(CodecError::MissingField("beforeHash"))?
                    .to_string();
                expected.insert(
                    facet.clone(),
                    ExpectedFacet {
                        event_ref,
                        before_hash,
                    },
                );
            }
            let review_proof = match map.get("reviewProof") {
                None | Some(Value::Null) => None,
                Some(v) => Some(review_proof_from_json(v)?),
            };
            Ok(Operation::FacetUpdate(FacetUpdate {
                entity,
                key,
                before,
                after,
                expected,
                review_proof,
            }))
        }
        "relation.remove" => {
            check_no_extra_fields(map, REMOVE_FIELDS, "relation.remove".to_string())?;
            if get_str(map, "entity")? != "relations" {
                return Err(CodecError::UnknownEntity(
                    get_str(map, "entity")?.to_string(),
                ));
            }
            let key = key_from_json(map.get("key").ok_or(CodecError::MissingField("key"))?)?;
            let before = image_from_json(
                EntityKind::Relations,
                map.get("before")
                    .ok_or(CodecError::MissingField("before"))?,
            )?;
            let observed = map
                .get("observedCreate")
                .ok_or(CodecError::MissingField("observedCreate"))?;
            let observed_create = observed_create_from_json(observed)?;
            Ok(Operation::RelationRemove(RelationRemove {
                key,
                before,
                observed_create,
            }))
        }
        other => Err(CodecError::UnknownOperationKind(other.to_string())),
    }
}

const PROOF_FIELDS: &[&str] = &[
    "action",
    "proposalId",
    "claimId",
    "objectId",
    "reviewedRevisionId",
    "finalBody",
    "userEdited",
    "resultRevisionId",
    "method",
];

fn opt_id(map: &Map<String, Value>, field: &'static str) -> Result<Option<String>, CodecError> {
    match map.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(CodecError::MissingField(field)),
    }
}

fn review_proof_from_json(value: &Value) -> Result<ReviewProof, CodecError> {
    let map = get_object(value, "reviewProof")?;
    check_no_extra_fields(map, PROOF_FIELDS, "reviewProof".to_string())?;
    let user_edited = match map.get("userEdited") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => return Err(CodecError::MissingField("userEdited")),
    };
    let method = match map.get("method") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(ReviewMethod::from_str(s)?),
        Some(_) => return Err(CodecError::MissingField("method")),
    };
    Ok(ReviewProof {
        action: ReviewAction::from_str(get_str(map, "action")?)?,
        proposal_id: opt_id(map, "proposalId")?,
        claim_id: opt_id(map, "claimId")?,
        object_id: opt_id(map, "objectId")?,
        reviewed_revision_id: opt_id(map, "reviewedRevisionId")?,
        final_body: opt_id(map, "finalBody")?,
        user_edited,
        result_revision_id: opt_id(map, "resultRevisionId")?,
        method,
    })
}

fn observed_create_from_json(value: &Value) -> Result<ObservedCreate, CodecError> {
    match value {
        Value::Object(map) if map.len() == 1 && map.contains_key("legacyHash") => {
            let hash = map["legacyHash"]
                .as_str()
                .ok_or(CodecError::MissingField("legacyHash"))?;
            Ok(ObservedCreate::LegacyHash(hash.to_string()))
        }
        Value::Object(_) => Ok(ObservedCreate::Event(event_ref_from_json(value)?)),
        _ => Err(CodecError::MissingField("observedCreate")),
    }
}
