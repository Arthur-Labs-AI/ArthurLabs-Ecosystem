//! Deterministic native proofs for the dormant journal codec/reducer.
//!
//! No production write path is exercised: fixtures are synthetic row images
//! and in-memory resolvers. No network, no paid providers, no real database.

use std::collections::{BTreeMap, BTreeSet};

use super::codec::{
    decode_core_strict, encode_canonical, facet_state_hash, hash_hex, journal_event_hash,
    validate_decimal, validate_event, validate_facet_update_shape, validate_key, Dependency,
    EntityKind, EventRef, ExpectedFacet, FacetUpdate, FieldValue, JournalEvent, ObservedCreate,
    Operation, RecordCreate, RelationRemove, ReviewAction, ReviewMethod, ReviewProof, RowImage,
    MAX_CANONICAL_BYTES, OPERATION_VERSION, PROVENANCE_LOCAL_COMMITTED,
};
use super::reducer::{
    assemble_event, dependencies_for, reduce_effects, Baselines, FacetId, FacetPrior, FacetPriors,
    KnownRefs, MapResolver, ObservedEffect, ReducerError, ReviewContext, ReviewMap,
};

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const TS0: &str = "2026-10-21T00:00:00Z";
const TS1: &str = "2026-10-21T00:00:01Z";
const BUNDLE: &str = "11111111-1111-4111-8111-111111111111";
const EVENT: &str = "22222222-2222-4222-8222-222222222222";
const ORIGIN: &str = "33333333-3333-4333-8333-333333333333";
const INCARNATION: &str = "44444444-4444-4444-8444-444444444444";
const PREV: &str = "abababababababababababababababababababababababababababababababab";
const INBOX: &str = "00000000-0000-4000-8000-000000000001";

fn uid(n: u32) -> String {
    format!("{n:08x}-1234-4abc-8def-{n:012x}")
}

fn txt(s: &str) -> FieldValue {
    FieldValue::Text(s.to_string())
}

fn dec(n: u64) -> FieldValue {
    FieldValue::Decimal(n.to_string())
}

fn null() -> FieldValue {
    FieldValue::Null
}

fn img(pairs: Vec<(&str, FieldValue)>) -> RowImage {
    pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

fn capture_img(id: &str, project: &str, content: &str) -> RowImage {
    img(vec![
        ("id", txt(id)),
        ("source", txt("text")),
        ("content", txt(content)),
        ("created_at", txt(TS0)),
        ("project_id", txt(project)),
    ])
}

fn run_img(capture: &str) -> RowImage {
    img(vec![("capture_id", txt(capture)), ("created_at", txt(TS0))])
}

fn object_img(id: &str, project: &str, current: Option<&str>) -> RowImage {
    img(vec![
        ("id", txt(id)),
        ("kind", txt("note")),
        ("title", txt("t")),
        ("body", txt("b")),
        ("created_at", txt(TS0)),
        ("current_revision_id", current.map(txt).unwrap_or_else(null)),
        ("project_id", txt(project)),
    ])
}

fn source_img(object: &str, capture: &str) -> RowImage {
    img(vec![
        ("object_id", txt(object)),
        ("capture_id", txt(capture)),
        ("source_start", dec(0)),
        ("source_end", dec(5)),
    ])
}

fn revision_img(id: &str, object: &str, origin: &str, capture: Option<&str>) -> RowImage {
    img(vec![
        ("id", txt(id)),
        ("object_id", txt(object)),
        ("kind", txt("note")),
        ("title", txt("t")),
        ("body", txt("b")),
        ("origin", txt(origin)),
        ("created_at", txt(TS0)),
        ("capture_id", capture.map(txt).unwrap_or_else(null)),
        (
            "source_start",
            if capture.is_some() { dec(0) } else { null() },
        ),
        (
            "source_end",
            if capture.is_some() { dec(5) } else { null() },
        ),
    ])
}

fn parents_img(child: &str, parent: &str) -> RowImage {
    img(vec![
        ("child_revision_id", txt(child)),
        ("parent_revision_id", txt(parent)),
    ])
}

fn relation_img(id: &str, kind: &str, s: &str, t: &str, origin: &str) -> RowImage {
    img(vec![
        ("id", txt(id)),
        ("kind", txt(kind)),
        ("source_object_id", txt(s)),
        ("target_object_id", txt(t)),
        ("origin", txt(origin)),
        ("created_at", txt(TS0)),
    ])
}

fn decision_new_img(capture: &str, ordinal: u64, object: &str) -> RowImage {
    img(vec![
        ("capture_id", txt(capture)),
        ("ordinal", dec(ordinal)),
        ("outcome", txt("new")),
        ("unchecked_reason", null()),
        ("target_object_id", null()),
        ("base_revision_id", null()),
        ("result_revision_id", null()),
        ("created_object_id", txt(object)),
        ("policy_version", txt("v1")),
        ("model_id", txt("m")),
        ("decided_by", txt("gate")),
        ("vetoes_json", txt("[]")),
        ("audit_json", txt("{}")),
        ("decided_at", txt(TS0)),
    ])
}

fn claim_img(id: &str, capture: &str, ordinal: u64, state: &str, resolved: bool) -> RowImage {
    img(vec![
        ("id", txt(id)),
        ("capture_id", txt(capture)),
        ("ordinal", dec(ordinal)),
        ("kind", txt("idea")),
        ("title", txt("claim")),
        ("body", txt("claim body")),
        ("source_start", dec(0)),
        ("source_end", dec(5)),
        ("candidate_ids_json", txt("[\"o\"]")),
        ("reasons_json", txt("[]")),
        ("reframing", dec(0)),
        ("state", txt(state)),
        ("due_at", null()),
        ("created_at", txt(TS0)),
        ("updated_at", txt(if resolved { TS1 } else { TS0 })),
        (
            "deferred_at",
            if state == "deferred" || resolved {
                txt(TS1)
            } else {
                null()
            },
        ),
        ("resolved_at", if resolved { txt(TS1) } else { null() }),
        (
            "resolved_method",
            if resolved { txt("user") } else { null() },
        ),
        (
            "resolved_object_id",
            if resolved { txt("o") } else { null() },
        ),
        (
            "resolved_revision_id",
            if resolved && state == "accepted" {
                txt("r")
            } else {
                null()
            },
        ),
    ])
}

fn proposal_img(id: &str, claim: &str, object: &str, base: &str, state: &str) -> RowImage {
    let terminal = !matches!(state, "open" | "deferred");
    let approved = state == "approved";
    img(vec![
        ("id", txt(id)),
        ("pending_claim_id", txt(claim)),
        ("object_id", txt(object)),
        ("base_revision_id", txt(base)),
        ("change", txt("additive")),
        ("kind", txt("note")),
        ("title", txt("draft")),
        ("proposed_body", txt("draft body")),
        ("retracts_revision_id", null()),
        ("retracts_ordinal", null()),
        ("evidence_json", txt("[{\"span\":0}]")),
        ("synthesis_model", txt("s")),
        ("verifier_model", txt("v")),
        ("verification_mode", txt("independent")),
        ("verification_status", txt("passed")),
        ("policy_version", txt("v1")),
        ("state", txt(state)),
        ("user_edited", dec(0)),
        ("final_body", if approved { txt("final") } else { null() }),
        (
            "result_revision_id",
            if approved { txt("rr") } else { null() },
        ),
        ("created_at", txt(TS0)),
        ("updated_at", txt(if terminal { TS1 } else { TS0 })),
        ("reviewed_at", if terminal { txt(TS1) } else { null() }),
    ])
}

fn effect(
    entity: EntityKind,
    key: Vec<String>,
    before: Option<RowImage>,
    after: Option<RowImage>,
) -> ObservedEffect {
    ObservedEffect {
        entity,
        key,
        before,
        after,
    }
}

fn resolver_with(pairs: Vec<(EntityKind, Vec<String>, RowImage)>) -> MapResolver {
    let mut r = MapResolver::new();
    for (e, k, image) in pairs {
        r.insert(e, k, image);
    }
    r
}

fn known_ref() -> EventRef {
    EventRef {
        origin_id: ORIGIN.to_string(),
        incarnation: INCARNATION.to_string(),
        seq: "7".to_string(),
        event_id: EVENT.to_string(),
        hash: PREV.to_string(),
    }
}

fn review_ctx(action: ReviewAction, proposal: &str, claim: &str) -> ReviewContext {
    ReviewContext {
        action,
        proposal_id: Some(proposal.to_string()),
        claim_id: Some(claim.to_string()),
        object_id: Some("o".to_string()),
        reviewed_revision_id: Some("r".to_string()),
        final_body: None,
        user_edited: Some(false),
        result_revision_id: None,
        method: Some(ReviewMethod::DerivedClaimResolution),
    }
}

fn sample_event(operations: Vec<Operation>, dependencies: Vec<Dependency>) -> JournalEvent {
    JournalEvent {
        bundle_id: BUNDLE.to_string(),
        committed_at: TS0.to_string(),
        dependencies,
        event_id: EVENT.to_string(),
        operation_version: OPERATION_VERSION,
        operations: operations.clone(),
        origin_id: ORIGIN.to_string(),
        origin_incarnation: INCARNATION.to_string(),
        origin_seq: "1".to_string(),
        previous_event_hash: PREV.to_string(),
        provenance_class: PROVENANCE_LOCAL_COMMITTED.to_string(),
        raw_effect_count: operations.len().to_string(),
    }
}

fn capture_create_op(id: &str, content: &str) -> Operation {
    Operation::RecordCreate(RecordCreate {
        entity: EntityKind::Captures,
        key: vec![id.to_string()],
        after: capture_img(id, INBOX, content),
    })
}

// ---------------------------------------------------------------------------
// 1. Identical typed input produces byte-identical canonical output
// ---------------------------------------------------------------------------

#[test]
fn identical_input_produces_identical_canonical_bytes() {
    let event = sample_event(vec![capture_create_op("c1", "hello")], vec![]);
    let first = encode_canonical(&event).unwrap();
    let second = encode_canonical(&event).unwrap();
    assert_eq!(first, second);
    assert!(!first.is_empty());
    let decoded = decode_core_strict(&first).unwrap();
    assert_eq!(decoded, event);
}

// ---------------------------------------------------------------------------
// 2. Independent RFC 8785 golden vectors
// ---------------------------------------------------------------------------

#[test]
fn rfc8785_golden_vectors() {
    // Hand-written expectations per RFC 8785 section 3 (JSON parsing of the
    // left literal must canonicalize to the right literal).
    let cases = [
        ("{\"2\":2,\"10\":10,\"1\":1}", "{\"1\":1,\"10\":10,\"2\":2}"),
        (
            "{\"b\":[3,2,1],\"a\":{\"d\":4,\"c\":3}}",
            "{\"a\":{\"c\":3,\"d\":4},\"b\":[3,2,1]}",
        ),
        ("{}", "{}"),
        ("{\"a\":[]}", "{\"a\":[]}"),
        ("{\"n\":-17}", "{\"n\":-17}"),
        ("{\"n\":0}", "{\"n\":0}"),
        ("[1,true,null,\"x\"]", "[1,true,null,\"x\"]"),
    ];
    for (input, expected) in cases {
        let value: serde_json::Value = serde_json::from_str(input).unwrap();
        let canonical = serde_jcs::to_string(&value).unwrap();
        assert_eq!(canonical, expected, "input {input}");
    }
    // No whitespace is ever emitted outside strings.
    let value: serde_json::Value = serde_json::from_str("{\"a\": {\"b\": [1, 2]}}").unwrap();
    let canonical = serde_jcs::to_string(&value).unwrap();
    assert_eq!(canonical, "{\"a\":{\"b\":[1,2]}}");
}

// ---------------------------------------------------------------------------
// 3. Exact domain-separated SHA-256 results
// ---------------------------------------------------------------------------

#[test]
fn sha256_domain_separation_is_exact() {
    use sha2::Digest;
    // NIST anchor validates the hash library itself.
    let digest = sha2::Sha256::digest(b"abc");
    let mut expected = [0u8; 32];
    expected.copy_from_slice(&digest);
    assert_eq!(
        hash_hex(&expected),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    // Domain-separated event hash: recompute the preimage independently.
    let event = sample_event(vec![capture_create_op("c1", "hello")], vec![]);
    let canonical = encode_canonical(&event).unwrap();
    let mut preimage = Vec::new();
    preimage.extend_from_slice(b"ARTHUR-M05-LOCAL-BUNDLE-v1");
    preimage.push(0x00);
    preimage.extend_from_slice(&canonical);
    let direct = sha2::Sha256::digest(&preimage);
    let mut direct_bytes = [0u8; 32];
    direct_bytes.copy_from_slice(&direct);
    assert_eq!(journal_event_hash(&canonical), direct_bytes);
    // Preimage structure: separator, zero byte, then the canonical core.
    assert_eq!(&preimage[..26], b"ARTHUR-M05-LOCAL-BUNDLE-v1");
    assert_eq!(preimage[26], 0x00);
    assert_eq!(&preimage[27..], canonical.as_slice());
    // A different separator must give a different digest.
    let mut other = sha2::Sha256::new();
    other.update(b"ARTHUR-M05-FACET-v1");
    other.update([0u8]);
    other.update(&canonical);
    let other = other.finalize();
    assert_ne!(&other[..], &direct_bytes[..]);
}

// ---------------------------------------------------------------------------
// 4. Cyrillic, emoji, combining sequences and escaped controls
// ---------------------------------------------------------------------------

#[test]
fn unicode_round_trips_byte_exact() {
    let content = "БГ мисъл 😀 café\u{0001}\u{001f} e\u{301}";
    let event = sample_event(vec![capture_create_op("c1", content)], vec![]);
    let bytes = encode_canonical(&event).unwrap();
    let text = std::str::from_utf8(&bytes).unwrap();
    // Cyrillic, emoji and precomposed é stay raw UTF-8, never \\u-escaped.
    assert!(text.contains("БГ мисъл"));
    assert!(text.contains("😀"));
    assert!(text.contains("café"));
    // Controls use short lowercase \\u00xx escapes.
    assert!(text.contains("\\u0001"));
    assert!(text.contains("\\u001f"));
    let decoded = decode_core_strict(&bytes).unwrap();
    assert_eq!(decoded, event);
    // Combining sequence is preserved code point by code point.
    let Operation::RecordCreate(create) = &decoded.operations[0] else {
        panic!("expected create");
    };
    assert_eq!(
        create.after.get("content"),
        Some(&FieldValue::Text(content.to_string()))
    );
}

// ---------------------------------------------------------------------------
// 5. No Unicode normalization or UTF-16 provenance conversion
// ---------------------------------------------------------------------------

#[test]
fn no_normalization_or_utf16_conversion() {
    let precomposed = "é"; // U+00E9
    let decomposed = "e\u{301}"; // U+0065 U+0301
    assert_ne!(precomposed, decomposed);
    let first = encode_canonical(&sample_event(
        vec![capture_create_op("c1", precomposed)],
        vec![],
    ))
    .unwrap();
    let second = encode_canonical(&sample_event(
        vec![capture_create_op("c1", decomposed)],
        vec![],
    ))
    .unwrap();
    assert_ne!(
        first, second,
        "normalization must not merge distinct spellings"
    );
    for pair in [(&first, precomposed), (&second, decomposed)] {
        let decoded = decode_core_strict(pair.0).unwrap();
        match &decoded.operations[0] {
            Operation::RecordCreate(create) => assert_eq!(
                create.after.get("content"),
                Some(&FieldValue::Text(pair.1.to_string()))
            ),
            _ => panic!("expected create"),
        }
    }
}

// ---------------------------------------------------------------------------
// 6. Decimal-string encoding and checked boundaries
// ---------------------------------------------------------------------------

#[test]
fn decimal_strings_are_checked() {
    assert!(validate_decimal("0").is_ok());
    assert!(validate_decimal("9007199254740993").is_ok());
    assert!(validate_decimal("18446744073709551615").is_ok());
    assert!(validate_decimal("").is_err());
    assert!(validate_decimal("01").is_err());
    assert!(validate_decimal("-1").is_err());
    assert!(validate_decimal("1.0").is_err());
    assert!(validate_decimal("18446744073709551616").is_err());
    // Ordinal key elements must be decimal.
    assert!(validate_key(
        EntityKind::IdentityDecisions,
        &["c".to_string(), "0".to_string()]
    )
    .is_ok());
    assert!(validate_key(
        EntityKind::IdentityDecisions,
        &["c".to_string(), "01".to_string()]
    )
    .is_err());
    // Origin sequence: nonzero and int64.
    let mut event = sample_event(vec![capture_create_op("c1", "x")], vec![]);
    event.origin_seq = "0".to_string();
    assert!(encode_canonical(&event).is_err());
    event.origin_seq = "9223372036854775808".to_string();
    assert!(encode_canonical(&event).is_err());
    event.origin_seq = "9223372036854775807".to_string();
    assert!(encode_canonical(&event).is_ok());
}

// ---------------------------------------------------------------------------
// 7. Stable dependency and operation ordering
// ---------------------------------------------------------------------------

#[test]
fn ordering_is_stable() {
    let cap = uid(1);
    let obj = uid(2);
    let rev = uid(3);
    let _rel = uid(4);
    let ops = vec![
        Operation::RecordCreate(RecordCreate {
            entity: EntityKind::ThoughtRevisions,
            key: vec![rev.clone()],
            after: revision_img(&rev, &obj, "user_edit", None),
        }),
        capture_create_op(&cap, "x"),
    ];
    let e1 = sample_event(ops.clone(), vec![]);
    let mut reversed = ops;
    reversed.reverse();
    let e2 = sample_event(reversed, vec![]);
    // Same multiset of operations encodes through one deterministic order
    // once sorted by the reducer; codec preserves given order verbatim.
    let b1 = encode_canonical(&e1).unwrap();
    let b2 = encode_canonical(&e2).unwrap();
    assert_ne!(b1, b2, "codec preserves caller order");
    // The reducer imposes the stable order: captures before revisions.
    let effects = vec![
        effect(
            EntityKind::ThoughtRevisions,
            vec![rev.clone()],
            None,
            Some(revision_img(&rev, &obj, "user_edit", None)),
        ),
        effect(
            EntityKind::Captures,
            vec![cap.clone()],
            None,
            Some(capture_img(&cap, INBOX, "x")),
        ),
    ];
    let mut known: KnownRefs = BTreeMap::new();
    known.insert(
        (EntityKind::KnowledgeObjects, vec![obj.clone()]),
        known_ref(),
    );
    let mut baselines: Baselines = BTreeSet::new();
    baselines.insert((EntityKind::Projects, vec![INBOX.to_string()]));
    baselines.insert((EntityKind::Captures, vec!["cap".to_string()]));
    let resolver = resolver_with(vec![
        (
            EntityKind::ThoughtRevisions,
            vec![rev.clone()],
            revision_img(&rev, &obj, "user_edit", None),
        ),
        (
            EntityKind::Captures,
            vec![cap.clone()],
            capture_img(&cap, INBOX, "x"),
        ),
    ]);
    let forward = reduce_effects(
        &effects,
        &resolver,
        &known,
        &baselines,
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .unwrap();
    let mut backward = effects;
    backward.reverse();
    let reversed_ops = reduce_effects(
        &backward,
        &resolver,
        &known,
        &baselines,
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(forward, reversed_ops);
    assert!(
        matches!(forward[0], Operation::RecordCreate(ref c) if c.entity == EntityKind::Captures)
    );
}

// ---------------------------------------------------------------------------
// 8. Unknown kinds, versions and fields fail closed
// ---------------------------------------------------------------------------

#[test]
fn unknown_vocabulary_fails_closed() {
    let mut event = sample_event(vec![capture_create_op("c1", "x")], vec![]);
    let bytes = encode_canonical(&event).unwrap();
    // Unknown operation kind.
    let tampered =
        String::from_utf8(bytes.clone())
            .unwrap()
            .replacen("record.create", "record.delete", 1);
    assert!(decode_core_strict(tampered.as_bytes()).is_err());
    // Unknown entity.
    let tampered = String::from_utf8(bytes.clone())
        .unwrap()
        .replacen("captures", "starships", 1);
    assert!(decode_core_strict(tampered.as_bytes()).is_err());
    // Unsupported operation version on decode.
    let tampered =
        String::from_utf8(bytes.clone())
            .unwrap()
            .replacen("\"version\":1", "\"version\":2", 1);
    assert!(decode_core_strict(tampered.as_bytes()).is_err());
    // Extra envelope field.
    let tampered = String::from_utf8(bytes).unwrap().replacen(
        "{\"bundleId\"",
        "{\"bundleId\"".replace("bundleId", "bundleIdx").as_str(),
        1,
    );
    assert!(decode_core_strict(tampered.as_bytes()).is_err());
    // Unsupported operation version on encode.
    event.operation_version = 2;
    assert!(encode_canonical(&event).is_err());
    // Duplicate keys are rejected even when the last value would win.
    let dup = b"{\"a\":1,\"a\":2}";
    assert!(decode_core_strict(dup).is_err());
    // Floats are forbidden.
    let float = b"{\"a\":1.5}";
    assert!(decode_core_strict(float).is_err());
}

// ---------------------------------------------------------------------------
// 9. Capture insert reduces to one complete creation
// ---------------------------------------------------------------------------

#[test]
fn capture_insert_reduces_to_one_create() {
    let image = capture_img("c1", INBOX, "hello");
    let effects = vec![effect(
        EntityKind::Captures,
        vec!["c1".to_string()],
        None,
        Some(image.clone()),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::Captures,
        vec!["c1".to_string()],
        image.clone(),
    )]);
    let mut baselines: Baselines = BTreeSet::new();
    baselines.insert((EntityKind::Projects, vec![INBOX.to_string()]));
    let ops = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &baselines,
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(ops.len(), 1);
    let Operation::RecordCreate(create) = &ops[0] else {
        panic!("expected create")
    };
    assert_eq!(create.entity, EntityKind::Captures);
    assert_eq!(create.after, image);
    let deps = dependencies_for(
        &ops,
        &BTreeSet::from([(EntityKind::Captures, vec!["c1".to_string()])]),
        &BTreeMap::new(),
        &baselines,
    )
    .unwrap();
    assert_eq!(deps.len(), 1);
    assert_eq!(deps[0].entity, EntityKind::Projects);
    assert!(
        deps[0].event_ref.is_none(),
        "project is an explicit baseline"
    );
}

// ---------------------------------------------------------------------------
// 10. Object + root revision + current pointer form one creation closure
// ---------------------------------------------------------------------------

#[test]
fn object_closure_reduces_without_transient_null() {
    let obj = uid(1);
    let rev = uid(2);
    let cap = uid(3);
    let transient = object_img(&obj, INBOX, None);
    let mut pointed = transient.clone();
    pointed.insert("current_revision_id".to_string(), txt(&rev));
    let effects = vec![
        effect(
            EntityKind::KnowledgeObjects,
            vec![obj.clone()],
            None,
            Some(transient),
        ),
        effect(
            EntityKind::ThoughtRevisions,
            vec![rev.clone()],
            None,
            Some(revision_img(&rev, &obj, "initial", None)),
        ),
        effect(
            EntityKind::ObjectSources,
            vec![obj.clone()],
            None,
            Some(source_img(&obj, &cap)),
        ),
        effect(
            EntityKind::KnowledgeObjects,
            vec![obj.clone()],
            Some(object_img(&obj, INBOX, None)),
            Some(pointed.clone()),
        ),
    ];
    let resolver = resolver_with(vec![
        (
            EntityKind::KnowledgeObjects,
            vec![obj.clone()],
            pointed.clone(),
        ),
        (
            EntityKind::ThoughtRevisions,
            vec![rev.clone()],
            revision_img(&rev, &obj, "initial", None),
        ),
        (
            EntityKind::ObjectSources,
            vec![obj.clone()],
            source_img(&obj, &cap),
        ),
    ]);
    let mut baselines: Baselines = BTreeSet::new();
    baselines.insert((EntityKind::Projects, vec![INBOX.to_string()]));
    baselines.insert((EntityKind::Captures, vec![cap.clone()]));
    let ops = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &baselines,
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(ops.len(), 3);
    // Exactly one object creation, carrying the final current pointer.
    let objects: Vec<_> = ops
        .iter()
        .filter(|op| matches!(op, Operation::RecordCreate(c) if c.entity == EntityKind::KnowledgeObjects))
        .collect();
    assert_eq!(objects.len(), 1);
    let Operation::RecordCreate(create) = objects[0] else {
        unreachable!()
    };
    assert_eq!(
        create.after.get("current_revision_id"),
        Some(&FieldValue::Text(rev.clone())),
        "no transient null-current image may be published"
    );
}

// ---------------------------------------------------------------------------
// 11. Branch revision without head selection stays meaningful
// ---------------------------------------------------------------------------

#[test]
fn branch_revision_without_head_is_still_an_event() {
    let obj = uid(1);
    let base = uid(2);
    let branch = uid(3);
    let effects = vec![
        effect(
            EntityKind::ThoughtRevisions,
            vec![branch.clone()],
            None,
            Some(revision_img(&branch, &obj, "user_edit", None)),
        ),
        effect(
            EntityKind::RevisionParents,
            vec![branch.clone(), base.clone()],
            None,
            Some(parents_img(&branch, &base)),
        ),
    ];
    let mut known: KnownRefs = BTreeMap::new();
    known.insert(
        (EntityKind::KnowledgeObjects, vec![obj.clone()]),
        known_ref(),
    );
    known.insert(
        (EntityKind::ThoughtRevisions, vec![base.clone()]),
        known_ref(),
    );
    let resolver = resolver_with(vec![
        (
            EntityKind::ThoughtRevisions,
            vec![branch.clone()],
            revision_img(&branch, &obj, "user_edit", None),
        ),
        (
            EntityKind::RevisionParents,
            vec![branch.clone(), base.clone()],
            parents_img(&branch, &base),
        ),
    ]);
    let ops = reduce_effects(
        &effects,
        &resolver,
        &known,
        &BTreeSet::new(),
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(ops.len(), 2);
    // No facet.update on the object: the head pointer did not move.
    assert!(ops
        .iter()
        .all(|op| !matches!(op, Operation::FacetUpdate(_))));
}

// ---------------------------------------------------------------------------
// 12. Model edge removal retains creation evidence; user edges are refused
// ---------------------------------------------------------------------------

#[test]
fn model_edge_removal_keeps_observed_create() {
    let a = uid(1);
    let b = uid(2);
    let edge = uid(3);
    let fresh = uid(4);
    let before = relation_img(&edge, "related_to", &a, &b, "model");
    let effects = vec![
        effect(
            EntityKind::Relations,
            vec![edge.clone()],
            Some(before.clone()),
            None,
        ),
        effect(
            EntityKind::Relations,
            vec![fresh.clone()],
            None,
            Some(relation_img(&fresh, "related_to", &a, &b, "model")),
        ),
    ];
    let resolver = resolver_with(vec![(
        EntityKind::Relations,
        vec![fresh.clone()],
        relation_img(&fresh, "related_to", &a, &b, "model"),
    )]);
    let mut baselines: Baselines = BTreeSet::new();
    baselines.insert((EntityKind::KnowledgeObjects, vec![a.clone()]));
    baselines.insert((EntityKind::KnowledgeObjects, vec![b.clone()]));
    // The removed edge models pre-journal history: explicit legacy baseline.
    baselines.insert((EntityKind::Relations, vec![edge.clone()]));
    let ops = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &baselines,
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(ops.len(), 2);
    // Removal and re-add are not collapsed into a generic update.
    let mut saw_remove = false;
    let mut saw_create = false;
    for op in &ops {
        match op {
            Operation::RelationRemove(r) => {
                saw_remove = true;
                assert_eq!(r.key, vec![edge.clone()]);
                assert_eq!(r.before, before);
                let expected = hash_hex(
                    &facet_state_hash(EntityKind::Relations, "record", &[edge.clone()], &before)
                        .unwrap(),
                );
                assert_eq!(r.observed_create, ObservedCreate::LegacyHash(expected));
            }
            Operation::RecordCreate(c) => {
                saw_create = true;
                assert_eq!(c.key, vec![fresh.clone()]);
            }
            _ => panic!("unexpected op"),
        }
    }
    assert!(saw_remove && saw_create);

    // A user-owned edge must never be tombstoned by model results.
    let user_before = relation_img(&edge, "related_to", &a, &b, "user");
    let effects = vec![effect(
        EntityKind::Relations,
        vec![edge.clone()],
        Some(user_before),
        None,
    )];
    let err = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &baselines,
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .expect_err("user edge deletion must fail");
    assert_eq!(err, ReducerError::NonModelEdgeDeletion);
}

// ---------------------------------------------------------------------------
// 13. Proposal supersession uses the final persisted state
// ---------------------------------------------------------------------------

#[test]
fn proposal_supersession_uses_final_state() {
    let before = proposal_img("p", "cl", "o", "base", "open");
    let after = proposal_img("p", "cl", "o", "base", "superseded");
    let effects = vec![effect(
        EntityKind::RevisionProposals,
        vec!["p".to_string()],
        Some(before),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::RevisionProposals,
        vec!["p".to_string()],
        after.clone(),
    )]);
    let mut known: KnownRefs = BTreeMap::new();
    known.insert(
        (EntityKind::PendingClaims, vec!["cl".to_string()]),
        known_ref(),
    );
    known.insert(
        (EntityKind::KnowledgeObjects, vec!["o".to_string()]),
        known_ref(),
    );
    known.insert(
        (EntityKind::ThoughtRevisions, vec!["base".to_string()]),
        known_ref(),
    );
    let mut reviews: ReviewMap = BTreeMap::new();
    reviews.insert(
        (EntityKind::RevisionProposals, vec!["p".to_string()]),
        review_ctx(ReviewAction::Supersede, "p", "cl"),
    );
    let mut priors: FacetPriors = BTreeMap::new();
    priors.insert(
        (
            EntityKind::RevisionProposals,
            vec!["p".to_string()],
            FacetId::ProposalLifecycle,
        ),
        FacetPrior::Event(known_ref()),
    );
    let ops = reduce_effects(
        &effects,
        &resolver,
        &known,
        &BTreeSet::new(),
        &reviews,
        &priors,
    )
    .unwrap();
    assert_eq!(ops.len(), 1);
    let Operation::FacetUpdate(update) = &ops[0] else {
        panic!("expected update")
    };
    assert_eq!(
        update.after.get("state"),
        Some(&FieldValue::Text("superseded".to_string()))
    );
    let proof = update.review_proof.as_ref().expect("review proof required");
    assert_eq!(proof.action, ReviewAction::Supersede);
    assert!(update.expected.contains_key("lifecycle"));
    assert_eq!(update.expected["lifecycle"].event_ref, Some(known_ref()));
    // Missing review context fails instead of emitting an unattested event.
    // Priors are present here so the failure is genuinely about review proof.
    let err = reduce_effects(
        &effects,
        &resolver,
        &known,
        &BTreeSet::new(),
        &BTreeMap::new(),
        &priors,
    )
    .expect_err("review proof is required");
    assert_eq!(
        err,
        ReducerError::MissingReviewProof {
            entity: "revision_proposals"
        }
    );
}

// ---------------------------------------------------------------------------
// 14. Persisted timestamp changes are kept even with applied=false legacy
// ---------------------------------------------------------------------------

#[test]
fn timestamp_only_claim_update_is_kept() {
    let before = claim_img("cl", "cap", 0, "open", false);
    let mut after = before.clone();
    after.insert("state".to_string(), txt("deferred"));
    after.insert("deferred_at".to_string(), txt(TS1));
    after.insert("updated_at".to_string(), txt(TS1));
    let effects = vec![effect(
        EntityKind::PendingClaims,
        vec!["cl".to_string()],
        Some(before),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::PendingClaims,
        vec!["cl".to_string()],
        after.clone(),
    )]);
    let mut baselines: Baselines = BTreeSet::new();
    baselines.insert((EntityKind::Captures, vec!["cap".to_string()]));
    // Standalone defer: no proposal exists, so none is invented.
    let mut reviews: ReviewMap = BTreeMap::new();
    reviews.insert(
        (EntityKind::PendingClaims, vec!["cl".to_string()]),
        ReviewContext {
            action: ReviewAction::Defer,
            proposal_id: None,
            claim_id: Some("cl".to_string()),
            object_id: None,
            reviewed_revision_id: None,
            final_body: None,
            user_edited: None,
            result_revision_id: None,
            method: Some(ReviewMethod::User),
        },
    );
    // The pre-journal claim contributes an explicit legacy baseline facet.
    let mut priors: FacetPriors = BTreeMap::new();
    priors.insert(
        (
            EntityKind::PendingClaims,
            vec!["cl".to_string()],
            FacetId::ClaimLifecycle,
        ),
        FacetPrior::LegacyBaseline,
    );
    // Effects carry no applied flag at all: actual row difference decides.
    let ops = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &baselines,
        &reviews,
        &priors,
    )
    .unwrap();
    assert_eq!(ops.len(), 1);
    let Operation::FacetUpdate(update) = &ops[0] else {
        panic!("expected update")
    };
    assert!(update.expected.contains_key("lifecycle"));
    assert_eq!(update.expected["lifecycle"].event_ref, None);
}

// ---------------------------------------------------------------------------
// 15. Genuine idempotent no-ops produce nothing encodable
// ---------------------------------------------------------------------------

#[test]
fn genuine_noop_produces_no_operations() {
    let image = capture_img("c1", INBOX, "hello");
    let effects = vec![effect(
        EntityKind::Captures,
        vec!["c1".to_string()],
        Some(image.clone()),
        Some(image.clone()),
    )];
    let resolver = resolver_with(vec![(EntityKind::Captures, vec!["c1".to_string()], image)]);
    let ops = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &BTreeSet::new(),
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .unwrap();
    assert!(ops.is_empty());
    let event = sample_event(vec![], vec![]);
    assert_eq!(
        encode_canonical(&event),
        Err(super::codec::CodecError::EmptyOperations)
    );
}

// ---------------------------------------------------------------------------
// 16. Unsupported deletions and net-zero mutations fail
// ---------------------------------------------------------------------------

#[test]
fn unsupported_effect_sets_fail() {
    let resolver = MapResolver::new();
    // Capture deletion is not an observable journal fact.
    let effects = vec![effect(
        EntityKind::Captures,
        vec!["c1".to_string()],
        Some(capture_img("c1", INBOX, "x")),
        None,
    )];
    let err = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &BTreeSet::new(),
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .expect_err("capture deletion must fail");
    assert_eq!(
        err,
        ReducerError::UnsupportedDeletion { entity: "captures" }
    );
    // Insert followed by delete in one transaction is not a silent no-op.
    let image = capture_img("c1", INBOX, "x");
    let effects = vec![
        effect(
            EntityKind::Captures,
            vec!["c1".to_string()],
            None,
            Some(image.clone()),
        ),
        effect(
            EntityKind::Captures,
            vec!["c1".to_string()],
            Some(image),
            None,
        ),
    ];
    let err = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &BTreeSet::new(),
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .expect_err("net-zero insert+delete must fail");
    assert_eq!(
        err,
        ReducerError::NetZeroWithIntermediateMutations { entity: "captures" }
    );
}

// ---------------------------------------------------------------------------
// 17. Missing projections and open closures fail
// ---------------------------------------------------------------------------

#[test]
fn missing_projections_and_closures_fail() {
    // Resolver has no final row while the last image exists.
    let image = capture_img("c1", INBOX, "x");
    let effects = vec![effect(
        EntityKind::Captures,
        vec!["c1".to_string()],
        None,
        Some(image),
    )];
    let err = reduce_effects(
        &effects,
        &MapResolver::new(),
        &BTreeMap::new(),
        &BTreeSet::new(),
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .expect_err("missing projection must fail");
    assert_eq!(
        err,
        ReducerError::MissingFinalProjection { entity: "captures" }
    );
    // Parent revision unknown to the event, known refs and baselines.
    let effects = vec![effect(
        EntityKind::RevisionParents,
        vec!["new".to_string(), "ghost".to_string()],
        None,
        Some(parents_img("new", "ghost")),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::RevisionParents,
        vec!["new".to_string(), "ghost".to_string()],
        parents_img("new", "ghost"),
    )]);
    let mut known: KnownRefs = BTreeMap::new();
    known.insert(
        (EntityKind::ThoughtRevisions, vec!["new".to_string()]),
        known_ref(),
    );
    let err = reduce_effects(
        &effects,
        &resolver,
        &known,
        &BTreeSet::new(),
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .expect_err("open closure must fail");
    assert_eq!(
        err,
        ReducerError::IncompleteDependencyClosure {
            entity: "thought_revisions"
        }
    );
}

// ---------------------------------------------------------------------------
// 18. Bundle-size boundary: one below, at, and above 4 MiB
// ---------------------------------------------------------------------------

#[test]
fn bundle_size_boundary_is_enforced() {
    // Overhead is stable for a fixed envelope: measure once with 1-byte content.
    let one = sample_event(vec![capture_create_op("c1", "x")], vec![]);
    let overhead = encode_canonical(&one).unwrap().len() - 1;
    assert!(overhead < MAX_CANONICAL_BYTES);
    for (delta, ok) in [("below", true), ("at", true), ("above", false)] {
        let pad = MAX_CANONICAL_BYTES - overhead;
        let len = match delta {
            "below" => pad - 1,
            "at" => pad,
            _ => pad + 1,
        };
        let content = "x".repeat(len);
        let event = sample_event(vec![capture_create_op("c1", &content)], vec![]);
        let encoded = encode_canonical(&event);
        if ok {
            let bytes = encoded.expect("boundary case must encode");
            assert!(bytes.len() <= MAX_CANONICAL_BYTES);
        } else {
            match encoded {
                Err(super::codec::CodecError::OversizeBundle { bytes, limit }) => {
                    assert!(bytes > limit);
                    assert_eq!(limit, MAX_CANONICAL_BYTES);
                }
                other => panic!("expected oversize, got {other:?}"),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 19. Retry never regenerates business ids or metadata
// ---------------------------------------------------------------------------

#[test]
fn repeated_encoding_regenerates_nothing() {
    let before = claim_img("cl", "cap", 0, "open", false);
    let mut after = before.clone();
    after.insert("state".to_string(), txt("deferred"));
    after.insert("deferred_at".to_string(), txt(TS1));
    after.insert("updated_at".to_string(), txt(TS1));
    let event = JournalEvent {
        bundle_id: BUNDLE.to_string(),
        committed_at: TS0.to_string(),
        dependencies: vec![Dependency {
            entity: EntityKind::Captures,
            key: vec!["cap".to_string()],
            event_ref: None,
        }],
        event_id: EVENT.to_string(),
        operation_version: OPERATION_VERSION,
        operations: vec![Operation::FacetUpdate(FacetUpdate {
            entity: EntityKind::PendingClaims,
            key: vec!["cl".to_string()],
            before: before.clone(),
            after: after.clone(),
            expected: BTreeMap::from([(
                "lifecycle".to_string(),
                ExpectedFacet {
                    event_ref: None,
                    before_hash: hash_hex(
                        &facet_state_hash(
                            EntityKind::PendingClaims,
                            "lifecycle",
                            &["cl".to_string()],
                            &before,
                        )
                        .unwrap(),
                    ),
                },
            )]),
            review_proof: Some(ReviewProof {
                action: ReviewAction::Defer,
                proposal_id: Some("p".to_string()),
                claim_id: Some("cl".to_string()),
                object_id: None,
                reviewed_revision_id: None,
                final_body: None,
                user_edited: None,
                result_revision_id: None,
                method: Some(ReviewMethod::User),
            }),
        })],
        origin_id: ORIGIN.to_string(),
        origin_incarnation: INCARNATION.to_string(),
        origin_seq: "9".to_string(),
        previous_event_hash: PREV.to_string(),
        provenance_class: PROVENANCE_LOCAL_COMMITTED.to_string(),
        raw_effect_count: "1".to_string(),
    };
    let snapshot = event.clone();
    let first = encode_canonical(&event).unwrap();
    assert_eq!(event, snapshot, "encoding must not mutate the event");
    let second = encode_canonical(&event).unwrap();
    assert_eq!(first, second);
    assert_eq!(decode_core_strict(&first).unwrap(), event);
}

// ---------------------------------------------------------------------------
// 20. Synthetic large-domain regression fixture
// ---------------------------------------------------------------------------

#[test]
fn large_domain_fixture_regresses_cleanly() {
    let cap = uid(100);
    let mut effects: Vec<ObservedEffect> = Vec::new();
    let mut finals: Vec<(EntityKind, Vec<String>, RowImage)> = Vec::new();
    let push_create =
        |entity: EntityKind,
         key: Vec<String>,
         image: RowImage,
         effects: &mut Vec<ObservedEffect>,
         finals: &mut Vec<(EntityKind, Vec<String>, RowImage)>| {
            effects.push(effect(entity, key.clone(), None, Some(image.clone())));
            finals.push((entity, key, image));
        };
    push_create(
        EntityKind::Captures,
        vec![cap.clone()],
        capture_img(&cap, INBOX, "distill me 😀"),
        &mut effects,
        &mut finals,
    );
    push_create(
        EntityKind::DistillationRuns,
        vec![cap.clone()],
        run_img(&cap),
        &mut effects,
        &mut finals,
    );
    for n in 0..12u32 {
        let obj = uid(1000 + n);
        let rev = uid(2000 + n);
        push_create(
            EntityKind::KnowledgeObjects,
            vec![obj.clone()],
            object_img(&obj, INBOX, Some(&rev)),
            &mut effects,
            &mut finals,
        );
        push_create(
            EntityKind::ThoughtRevisions,
            vec![rev.clone()],
            revision_img(&rev, &obj, "system", Some(cap.as_str())),
            &mut effects,
            &mut finals,
        );
        let mut span = source_img(&obj, &cap);
        span.insert(
            "source_end".to_string(),
            FieldValue::Decimal((n as u64 + 1).to_string()),
        );
        push_create(
            EntityKind::ObjectSources,
            vec![obj.clone()],
            span,
            &mut effects,
            &mut finals,
        );
        push_create(
            EntityKind::IdentityDecisions,
            vec![cap.clone(), n.to_string()],
            decision_new_img(&cap, n as u64, &obj),
            &mut effects,
            &mut finals,
        );
    }
    let mut baselines: Baselines = BTreeSet::new();
    baselines.insert((EntityKind::Projects, vec![INBOX.to_string()]));
    let resolver = resolver_with(finals);
    let ops = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &baselines,
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .unwrap();
    // 1 capture + 1 run + 12 x (object, revision, source, decision).
    assert_eq!(ops.len(), 2 + 12 * 4);
    let deps = dependencies_for(
        &ops,
        &ops.iter()
            .filter_map(|op| match op {
                Operation::RecordCreate(c) => Some((c.entity, c.key.clone())),
                _ => None,
            })
            .collect(),
        &BTreeMap::new(),
        &baselines,
    )
    .unwrap();
    assert!(deps.iter().all(|d| d.event_ref.is_none()));
    let event = assemble_event(
        BUNDLE.to_string(),
        EVENT.to_string(),
        ORIGIN.to_string(),
        INCARNATION.to_string(),
        42,
        PREV.to_string(),
        TS0.to_string(),
        effects.len() as u64,
        ops,
        deps,
    )
    .unwrap();
    let bytes = encode_canonical(&event).unwrap();
    assert!(bytes.len() < MAX_CANONICAL_BYTES);
    let round_trip = decode_core_strict(&bytes).unwrap();
    assert_eq!(round_trip, event);
    let again = encode_canonical(&round_trip).unwrap();
    assert_eq!(bytes, again);
}

// ---------------------------------------------------------------------------
// FIX-01: project updated_at is accompanying metadata, not a causal facet
// ---------------------------------------------------------------------------

const TS2: &str = "2026-10-21T00:00:02Z";
const TS_EARLIER: &str = "2026-10-20T00:00:00Z";

fn project_row(
    id: &str,
    name: &str,
    created: &str,
    updated: &str,
    archived: Option<&str>,
) -> RowImage {
    img(vec![
        ("id", txt(id)),
        ("name", txt(name)),
        ("created_at", txt(created)),
        ("updated_at", txt(updated)),
        ("archived_at", archived.map(txt).unwrap_or_else(null)),
    ])
}

fn expected_for(
    entity: EntityKind,
    facet: &str,
    key: &[String],
    before: &RowImage,
) -> ExpectedFacet {
    let def = super::codec::facets_of(entity)
        .iter()
        .find(|f| f.name == facet)
        .expect("facet");
    let mut state = RowImage::new();
    for field in def.fields {
        state.insert(
            field.to_string(),
            before.get(*field).expect("field").clone(),
        );
    }
    ExpectedFacet {
        event_ref: None,
        before_hash: hash_hex(&facet_state_hash(entity, facet, key, &state).unwrap()),
    }
}

fn project_update_event(
    before: &RowImage,
    after: &RowImage,
    key: Vec<String>,
    facet: &str,
) -> JournalEvent {
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::Projects,
        key: key.clone(),
        before: before.clone(),
        after: after.clone(),
        expected: BTreeMap::from([(
            facet.to_string(),
            expected_for(EntityKind::Projects, facet, &key, before),
        )]),
        review_proof: None,
    });
    sample_event(vec![op], vec![])
}

// Test A: rename changes record facet and carries the real timestamp.
#[test]
fn project_rename_keeps_accompanying_timestamp() {
    let id = uid(50);
    let before = project_row(&id, "Work", TS0, TS0, None);
    let after = project_row(&id, "Todo", TS0, TS1, None);
    let mut priors: FacetPriors = BTreeMap::new();
    priors.insert(
        (
            EntityKind::Projects,
            vec![id.clone()],
            FacetId::ProjectRecord,
        ),
        FacetPrior::Event(known_ref()),
    );
    let effects = vec![effect(
        EntityKind::Projects,
        vec![id.clone()],
        Some(before.clone()),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::Projects,
        vec![id.clone()],
        after.clone(),
    )]);
    let ops = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &BTreeSet::new(),
        &BTreeMap::new(),
        &priors,
    )
    .unwrap();
    assert_eq!(ops.len(), 1);
    let Operation::FacetUpdate(update) = &ops[0] else {
        panic!("expected update")
    };
    assert!(update.expected.contains_key("record"));
    assert!(!update.expected.contains_key("lifecycle"));
    assert_eq!(update.expected["record"].event_ref, Some(known_ref()));
    assert_eq!(
        update.after.get("updated_at"),
        Some(&FieldValue::Text(TS1.to_string()))
    );
    let event = sample_event(ops, vec![]);
    let bytes = encode_canonical(&event).unwrap();
    let decoded = decode_core_strict(&bytes).unwrap();
    assert_eq!(decoded, event);
}

// Test B: archive changes lifecycle facet and carries the real timestamp.
#[test]
fn project_archive_keeps_accompanying_timestamp() {
    let id = uid(51);
    let before = project_row(&id, "Work", TS0, TS0, None);
    let after = project_row(&id, "Work", TS0, TS1, Some(TS1));
    let mut priors: FacetPriors = BTreeMap::new();
    priors.insert(
        (
            EntityKind::Projects,
            vec![id.clone()],
            FacetId::ProjectLifecycle,
        ),
        FacetPrior::Event(known_ref_b()),
    );
    let effects = vec![effect(
        EntityKind::Projects,
        vec![id.clone()],
        Some(before.clone()),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::Projects,
        vec![id.clone()],
        after.clone(),
    )]);
    let ops = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &BTreeSet::new(),
        &BTreeMap::new(),
        &priors,
    )
    .unwrap();
    assert_eq!(ops.len(), 1);
    let Operation::FacetUpdate(update) = &ops[0] else {
        panic!("expected update")
    };
    assert!(update.expected.contains_key("lifecycle"));
    assert!(!update.expected.contains_key("record"));
    assert_eq!(update.expected["lifecycle"].event_ref, Some(known_ref_b()));
    assert_eq!(
        update.after.get("archived_at"),
        Some(&FieldValue::Text(TS1.to_string()))
    );
    assert_eq!(
        update.after.get("updated_at"),
        Some(&FieldValue::Text(TS1.to_string()))
    );
}

// Test C: restore works with no wall-clock ordering assumptions.
#[test]
fn project_restore_needs_no_clock_ordering() {
    let id = uid(52);
    let before = project_row(&id, "Work", TS0, TS1, Some(TS1));
    let after = project_row(&id, "Work", TS0, TS_EARLIER, None);
    let mut priors: FacetPriors = BTreeMap::new();
    priors.insert(
        (
            EntityKind::Projects,
            vec![id.clone()],
            FacetId::ProjectLifecycle,
        ),
        FacetPrior::Event(known_ref_b()),
    );
    let effects = vec![effect(
        EntityKind::Projects,
        vec![id.clone()],
        Some(before.clone()),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::Projects,
        vec![id.clone()],
        after.clone(),
    )]);
    let ops = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &BTreeSet::new(),
        &BTreeMap::new(),
        &priors,
    )
    .unwrap();
    assert_eq!(ops.len(), 1);
    let Operation::FacetUpdate(update) = &ops[0] else {
        panic!("expected update")
    };
    assert!(update.expected.contains_key("lifecycle"));
    assert!(!update.expected.contains_key("record"));
    assert_eq!(update.expected["lifecycle"].event_ref, Some(known_ref_b()));
    assert_eq!(update.after.get("archived_at"), Some(&FieldValue::Null));
}

// Test D: rename plus archive in one transaction keeps the final state.
#[test]
fn project_combined_transition_keeps_final_state() {
    let id = uid(53);
    let first = project_row(&id, "Work", TS0, TS0, None);
    let middle = project_row(&id, "Todo", TS0, TS1, None);
    let last = project_row(&id, "Todo", TS0, TS2, Some(TS2));
    let effects = vec![
        effect(
            EntityKind::Projects,
            vec![id.clone()],
            Some(first),
            Some(middle.clone()),
        ),
        effect(
            EntityKind::Projects,
            vec![id.clone()],
            Some(middle),
            Some(last.clone()),
        ),
    ];
    let resolver = resolver_with(vec![(EntityKind::Projects, vec![id.clone()], last.clone())]);
    let mut priors: FacetPriors = BTreeMap::new();
    priors.insert(
        (
            EntityKind::Projects,
            vec![id.clone()],
            FacetId::ProjectRecord,
        ),
        FacetPrior::Event(known_ref()),
    );
    priors.insert(
        (
            EntityKind::Projects,
            vec![id.clone()],
            FacetId::ProjectLifecycle,
        ),
        FacetPrior::Event(known_ref_b()),
    );
    let ops = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &BTreeSet::new(),
        &BTreeMap::new(),
        &priors,
    )
    .unwrap();
    assert_eq!(ops.len(), 1);
    let Operation::FacetUpdate(update) = &ops[0] else {
        panic!("expected update")
    };
    assert!(update.expected.contains_key("record"));
    assert!(update.expected.contains_key("lifecycle"));
    assert_eq!(
        update.expected.len(),
        2,
        "updated_at creates no third facet"
    );
    assert_eq!(update.expected["record"].event_ref, Some(known_ref()));
    assert_eq!(update.expected["lifecycle"].event_ref, Some(known_ref_b()));
    assert_eq!(
        update.after.get("name"),
        Some(&FieldValue::Text("Todo".to_string()))
    );
    assert_eq!(
        update.after.get("archived_at"),
        Some(&FieldValue::Text(TS2.to_string()))
    );
    assert_eq!(
        update.after.get("updated_at"),
        Some(&FieldValue::Text(TS2.to_string()))
    );
}

// Test E: genuinely immutable project fields still fail.
#[test]
fn project_immutable_fields_still_fail() {
    let id = uid(54);
    let before = project_row(&id, "Work", TS0, TS0, None);
    let after = project_row(&id, "Work", TS0, TS1, None);
    let mut tampered = after.clone();
    tampered.insert("created_at".to_string(), txt("2020-01-01T00:00:00Z"));
    let effects = vec![effect(
        EntityKind::Projects,
        vec![id.clone()],
        Some(before),
        Some(tampered.clone()),
    )];
    let resolver = resolver_with(vec![(EntityKind::Projects, vec![id.clone()], tampered)]);
    let err = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &BTreeSet::new(),
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .expect_err("created_at must fail");
    assert!(matches!(
        err,
        ReducerError::Codec(super::codec::CodecError::ImmutableFieldChanged { .. })
    ));
}

// Test F: an isolated timestamp bump is not a standalone causal update.
#[test]
fn project_timestamp_only_update_is_rejected() {
    let id = uid(55);
    let before = project_row(&id, "Work", TS0, TS0, None);
    let after = project_row(&id, "Work", TS0, TS1, None);
    let effects = vec![effect(
        EntityKind::Projects,
        vec![id.clone()],
        Some(before),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(EntityKind::Projects, vec![id.clone()], after)]);
    let err = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &BTreeSet::new(),
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .expect_err("timestamp-only must fail");
    assert!(matches!(
        err,
        ReducerError::Codec(super::codec::CodecError::ImmutableFieldChanged { .. })
    ));
}

// Test G: direct codec validation accepts rename and archive updates.
#[test]
fn project_codec_accepts_valid_facet_updates() {
    let id = uid(56);
    let before = project_row(&id, "Work", TS0, TS0, None);
    let renamed = project_row(&id, "Todo", TS0, TS1, None);
    let event = project_update_event(&before, &renamed, vec![id.clone()], "record");
    let bytes = encode_canonical(&event).unwrap();
    let decoded = decode_core_strict(&bytes).unwrap();
    assert_eq!(decoded, event);
    let archived = project_row(&id, "Todo", TS0, TS2, Some(TS2));
    let event = project_update_event(&renamed, &archived, vec![id.clone()], "lifecycle");
    let bytes = encode_canonical(&event).unwrap();
    assert_eq!(decode_core_strict(&bytes).unwrap(), event);
}

// Test H: images built from the real v9 project store reduce correctly.
#[test]
fn real_project_store_rename_reduces() {
    use super::super::capture_store::CaptureStore;
    let store = CaptureStore::open_in_memory().expect("memory store");
    let created = store.create_project("Work").expect("create");
    let renamed = store.rename_project(&created.id, "Todo").expect("rename");
    let before = project_row(
        &created.id,
        &created.name,
        &created.created_at,
        &created.updated_at,
        created.archived_at.as_deref(),
    );
    let after = project_row(
        &renamed.id,
        &renamed.name,
        &renamed.created_at,
        &renamed.updated_at,
        renamed.archived_at.as_deref(),
    );
    assert_eq!(
        before.get("name"),
        Some(&FieldValue::Text("Work".to_string()))
    );
    assert_eq!(
        after.get("name"),
        Some(&FieldValue::Text("Todo".to_string()))
    );
    let effects = vec![effect(
        EntityKind::Projects,
        vec![created.id.clone()],
        Some(before),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::Projects,
        vec![created.id.clone()],
        after,
    )]);
    // The store row predates the journal: explicit legacy baseline facet.
    let mut priors: FacetPriors = BTreeMap::new();
    priors.insert(
        (
            EntityKind::Projects,
            vec![created.id.clone()],
            FacetId::ProjectRecord,
        ),
        FacetPrior::LegacyBaseline,
    );
    let ops = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &BTreeSet::new(),
        &BTreeMap::new(),
        &priors,
    )
    .unwrap();
    assert_eq!(ops.len(), 1);
    let Operation::FacetUpdate(update) = &ops[0] else {
        panic!("expected update")
    };
    assert!(update.expected.contains_key("record"));
}

// ---------------------------------------------------------------------------
// FIX-02 test-first: entity-level refs cannot express per-facet writers
// ---------------------------------------------------------------------------

fn prev_b_hash() -> String {
    ["cd"; 32].concat()
}

fn known_ref_b() -> EventRef {
    EventRef {
        origin_id: ORIGIN.to_string(),
        incarnation: INCARNATION.to_string(),
        seq: "9".to_string(),
        event_id: "99999999-9999-4999-8999-999999999999".to_string(),
        hash: prev_b_hash(),
    }
}

// Test A: a rename must reference the record writer, not the lifecycle one.
#[test]
fn facet_project_record_uses_record_writer() {
    let id = uid(70);
    let before = project_row(&id, "Work", TS0, TS0, None);
    let after = project_row(&id, "Todo", TS0, TS1, None);
    let effects = vec![effect(
        EntityKind::Projects,
        vec![id.clone()],
        Some(before),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(EntityKind::Projects, vec![id.clone()], after)]);
    let known: KnownRefs = BTreeMap::new();
    let mut priors: FacetPriors = BTreeMap::new();
    priors.insert(
        (
            EntityKind::Projects,
            vec![id.clone()],
            FacetId::ProjectRecord,
        ),
        FacetPrior::Event(known_ref()),
    );
    priors.insert(
        (
            EntityKind::Projects,
            vec![id.clone()],
            FacetId::ProjectLifecycle,
        ),
        FacetPrior::Event(known_ref_b()),
    );
    let ops = reduce_effects(
        &effects,
        &resolver,
        &known,
        &BTreeSet::new(),
        &BTreeMap::new(),
        &priors,
    )
    .unwrap();
    let Operation::FacetUpdate(update) = &ops[0] else {
        panic!("expected update")
    };
    assert_eq!(update.expected["record"].event_ref, Some(known_ref()));
    assert!(!update.expected.contains_key("lifecycle"));
}

// Test B: an archive after a rename must keep the lifecycle writer.
#[test]
fn facet_project_archive_keeps_lifecycle_writer() {
    let id = uid(71);
    let before = project_row(&id, "Todo", TS0, TS1, None);
    let after = project_row(&id, "Todo", TS0, TS2, Some(TS2));
    let effects = vec![effect(
        EntityKind::Projects,
        vec![id.clone()],
        Some(before),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(EntityKind::Projects, vec![id.clone()], after)]);
    let known: KnownRefs = BTreeMap::new();
    let mut priors: FacetPriors = BTreeMap::new();
    priors.insert(
        (
            EntityKind::Projects,
            vec![id.clone()],
            FacetId::ProjectRecord,
        ),
        FacetPrior::Event(known_ref()),
    );
    priors.insert(
        (
            EntityKind::Projects,
            vec![id.clone()],
            FacetId::ProjectLifecycle,
        ),
        FacetPrior::Event(known_ref_b()),
    );
    let ops = reduce_effects(
        &effects,
        &resolver,
        &known,
        &BTreeSet::new(),
        &BTreeMap::new(),
        &priors,
    )
    .unwrap();
    let Operation::FacetUpdate(update) = &ops[0] else {
        panic!("expected update")
    };
    assert_eq!(update.expected["lifecycle"].event_ref, Some(known_ref_b()));
    assert!(!update.expected.contains_key("record"));
}

// Test C: a combined transition needs two independent expected entries.
#[test]
fn facet_project_combined_uses_both_writers() {
    let id = uid(72);
    let before = project_row(&id, "Work", TS0, TS0, None);
    let after = project_row(&id, "Todo", TS0, TS1, Some(TS1));
    let effects = vec![effect(
        EntityKind::Projects,
        vec![id.clone()],
        Some(before),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(EntityKind::Projects, vec![id.clone()], after)]);
    let known: KnownRefs = BTreeMap::new();
    let mut priors: FacetPriors = BTreeMap::new();
    priors.insert(
        (
            EntityKind::Projects,
            vec![id.clone()],
            FacetId::ProjectRecord,
        ),
        FacetPrior::Event(known_ref()),
    );
    priors.insert(
        (
            EntityKind::Projects,
            vec![id.clone()],
            FacetId::ProjectLifecycle,
        ),
        FacetPrior::Event(known_ref_b()),
    );
    let ops = reduce_effects(
        &effects,
        &resolver,
        &known,
        &BTreeSet::new(),
        &BTreeMap::new(),
        &priors,
    )
    .unwrap();
    let Operation::FacetUpdate(update) = &ops[0] else {
        panic!("expected update")
    };
    assert_eq!(update.expected["record"].event_ref, Some(known_ref()));
    assert_eq!(update.expected["lifecycle"].event_ref, Some(known_ref_b()));
    assert_eq!(update.expected.len(), 2);
}

// Test D1: moving an object references the membership writer only.
#[test]
fn facet_object_membership_uses_membership_writer() {
    let obj = uid(73);
    let rev = uid(74);
    let dest = uid(75);
    let before = object_img(&obj, INBOX, Some(&rev));
    let mut after = before.clone();
    after.insert("project_id".to_string(), txt(&dest));
    let effects = vec![effect(
        EntityKind::KnowledgeObjects,
        vec![obj.clone()],
        Some(before),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::KnowledgeObjects,
        vec![obj.clone()],
        after,
    )]);
    let mut known: KnownRefs = BTreeMap::new();
    known.insert(
        (EntityKind::ThoughtRevisions, vec![rev.clone()]),
        known_ref(),
    );
    let mut priors: FacetPriors = BTreeMap::new();
    priors.insert(
        (
            EntityKind::KnowledgeObjects,
            vec![obj.clone()],
            FacetId::ObjectMembership,
        ),
        FacetPrior::Event(known_ref_b()),
    );
    priors.insert(
        (
            EntityKind::KnowledgeObjects,
            vec![obj.clone()],
            FacetId::ObjectHead,
        ),
        FacetPrior::Event(known_ref()),
    );
    let mut baselines: Baselines = BTreeSet::new();
    baselines.insert((EntityKind::Projects, vec![INBOX.to_string()]));
    baselines.insert((EntityKind::Projects, vec![dest.clone()]));
    let ops = reduce_effects(
        &effects,
        &resolver,
        &known,
        &baselines,
        &BTreeMap::new(),
        &priors,
    )
    .unwrap();
    let Operation::FacetUpdate(update) = &ops[0] else {
        panic!("expected update")
    };
    assert!(update.expected.contains_key("membership"));
    assert!(!update.expected.contains_key("head"));
    assert_eq!(update.expected["membership"].event_ref, Some(known_ref_b()));
}

// Test D2: advancing the head references the head writer only.
#[test]
fn facet_object_head_uses_head_writer() {
    let obj = uid(76);
    let rev1 = uid(77);
    let rev2 = uid(78);
    let mut before = object_img(&obj, INBOX, Some(&rev1));
    before.insert("title".to_string(), txt("old"));
    let mut after = object_img(&obj, INBOX, Some(&rev2));
    after.insert("title".to_string(), txt("new"));
    let effects = vec![effect(
        EntityKind::KnowledgeObjects,
        vec![obj.clone()],
        Some(before),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::KnowledgeObjects,
        vec![obj.clone()],
        after,
    )]);
    let mut known: KnownRefs = BTreeMap::new();
    known.insert(
        (EntityKind::ThoughtRevisions, vec![rev2.clone()]),
        known_ref(),
    );
    let mut priors: FacetPriors = BTreeMap::new();
    priors.insert(
        (
            EntityKind::KnowledgeObjects,
            vec![obj.clone()],
            FacetId::ObjectMembership,
        ),
        FacetPrior::Event(known_ref_b()),
    );
    priors.insert(
        (
            EntityKind::KnowledgeObjects,
            vec![obj.clone()],
            FacetId::ObjectHead,
        ),
        FacetPrior::Event(known_ref()),
    );
    let mut baselines: Baselines = BTreeSet::new();
    baselines.insert((EntityKind::Projects, vec![INBOX.to_string()]));
    let ops = reduce_effects(
        &effects,
        &resolver,
        &known,
        &baselines,
        &BTreeMap::new(),
        &priors,
    )
    .unwrap();
    let Operation::FacetUpdate(update) = &ops[0] else {
        panic!("expected update")
    };
    assert!(update.expected.contains_key("head"));
    assert!(!update.expected.contains_key("membership"));
    assert_eq!(update.expected["head"].event_ref, Some(known_ref()));
}

// Test E: an explicit legacy facet encodes a null ref with the right hash.
#[test]
fn facet_explicit_legacy_baseline_encodes() {
    let id = uid(79);
    let before = project_row(&id, "Work", TS0, TS0, None);
    let after = project_row(&id, "Todo", TS0, TS1, None);
    let effects = vec![effect(
        EntityKind::Projects,
        vec![id.clone()],
        Some(before.clone()),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::Projects,
        vec![id.clone()],
        after.clone(),
    )]);
    let mut priors: FacetPriors = BTreeMap::new();
    priors.insert(
        (
            EntityKind::Projects,
            vec![id.clone()],
            FacetId::ProjectRecord,
        ),
        FacetPrior::LegacyBaseline,
    );
    let ops = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &BTreeSet::new(),
        &BTreeMap::new(),
        &priors,
    )
    .unwrap();
    let Operation::FacetUpdate(update) = &ops[0] else {
        panic!("expected update")
    };
    assert_eq!(update.expected["record"].event_ref, None);
    assert_eq!(update.expected["record"].before_hash.len(), 64);
    let event = sample_event(ops, vec![]);
    let bytes = encode_canonical(&event).unwrap();
    assert_eq!(decode_core_strict(&bytes).unwrap(), event);
}

// Test F: an unknown prior facet must fail, never silently baseline.
#[test]
fn facet_missing_prior_fails() {
    let id = uid(80);
    let before = project_row(&id, "Work", TS0, TS0, None);
    let after = project_row(&id, "Todo", TS0, TS1, None);
    let effects = vec![effect(
        EntityKind::Projects,
        vec![id.clone()],
        Some(before),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(EntityKind::Projects, vec![id.clone()], after)]);
    let err = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &BTreeSet::new(),
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .expect_err("unknown prior must fail");
    assert_eq!(
        err,
        ReducerError::MissingFacetPrior {
            entity: "projects",
            facet: "record"
        }
    );
}

// Test G: a journal-created record has no automatic legacy history.
#[test]
fn facet_new_record_has_no_automatic_baseline() {
    let id = uid(81);
    let image = project_row(&id, "Work", TS0, TS0, None);
    let effects = vec![effect(
        EntityKind::Projects,
        vec![id.clone()],
        None,
        Some(image.clone()),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::Projects,
        vec![id.clone()],
        image.clone(),
    )]);
    let ops = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &BTreeSet::new(),
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(ops.len(), 1);
    let renamed = project_row(&id, "Todo", TS0, TS1, None);
    let effects = vec![effect(
        EntityKind::Projects,
        vec![id.clone()],
        Some(image),
        Some(renamed.clone()),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::Projects,
        vec![id.clone()],
        renamed.clone(),
    )]);
    let err = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &BTreeSet::new(),
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .expect_err("uninitialized facet must fail");
    assert_eq!(
        err,
        ReducerError::MissingFacetPrior {
            entity: "projects",
            facet: "record"
        }
    );
    // The JournalTx initialization policy: every applicable mutable facet
    // of a new record starts at the creation event. Afterwards the rename
    // resolves its record writer without touching lifecycle.
    let mut priors: FacetPriors = BTreeMap::new();
    priors.insert(
        (
            EntityKind::Projects,
            vec![id.clone()],
            FacetId::ProjectRecord,
        ),
        FacetPrior::Event(known_ref()),
    );
    priors.insert(
        (
            EntityKind::Projects,
            vec![id.clone()],
            FacetId::ProjectLifecycle,
        ),
        FacetPrior::Event(known_ref()),
    );
    let ops = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &BTreeSet::new(),
        &BTreeMap::new(),
        &priors,
    )
    .unwrap();
    assert_eq!(ops.len(), 1);
    let Operation::FacetUpdate(update) = &ops[0] else {
        panic!("expected update")
    };
    assert_eq!(update.expected["record"].event_ref, Some(known_ref()));
    assert!(!update.expected.contains_key("lifecycle"));
}

// Test H: independent expected refs survive a strict round-trip.
#[test]
fn facet_independent_refs_round_trip() {
    let id = uid(82);
    let v0 = project_row(&id, "Work", TS0, TS0, None);
    let v2 = project_row(&id, "Todo", TS0, TS2, Some(TS2));
    // ONE reduced transaction: rename (record) plus archive (lifecycle)
    // together, with the accompanying updated_at preserved in the images.
    // The reducer merges same-key effects; two same-key facet updates must
    // never simulate one transaction.
    let mut record_expected = expected_for(EntityKind::Projects, "record", &[id.clone()], &v0);
    record_expected.event_ref = Some(known_ref());
    let mut lifecycle_expected =
        expected_for(EntityKind::Projects, "lifecycle", &[id.clone()], &v0);
    lifecycle_expected.event_ref = Some(known_ref_b());
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::Projects,
        key: vec![id.clone()],
        before: v0.clone(),
        after: v2.clone(),
        expected: BTreeMap::from([
            ("record".to_string(), record_expected),
            ("lifecycle".to_string(), lifecycle_expected),
        ]),
        review_proof: None,
    });
    let event = sample_event(vec![op], vec![]);
    let bytes = encode_canonical(&event).unwrap();
    // BEFORE decoding: two distinct writers and facet-only before-hashes.
    let Operation::FacetUpdate(update) = &event.operations[0] else {
        panic!("expected update")
    };
    assert_eq!(update.expected["record"].event_ref, Some(known_ref()));
    assert_eq!(update.expected["lifecycle"].event_ref, Some(known_ref_b()));
    assert_ne!(
        update.expected["record"].event_ref,
        update.expected["lifecycle"].event_ref
    );
    let record_state = RowImage::from([("name".to_string(), FieldValue::Text("Work".to_string()))]);
    let lifecycle_state = RowImage::from([("archived_at".to_string(), FieldValue::Null)]);
    assert_eq!(
        update.expected["record"].before_hash,
        hash_hex(
            &facet_state_hash(EntityKind::Projects, "record", &[id.clone()], &record_state)
                .unwrap()
        )
    );
    assert_eq!(
        update.expected["lifecycle"].before_hash,
        hash_hex(
            &facet_state_hash(
                EntityKind::Projects,
                "lifecycle",
                &[id.clone()],
                &lifecycle_state
            )
            .unwrap()
        )
    );
    // The old regression hashed the whole row for lifecycle: that digest
    // must NOT match the facet-only hash asserted above.
    assert_ne!(
        update.expected["lifecycle"].before_hash,
        hash_hex(&facet_state_hash(EntityKind::Projects, "lifecycle", &[id.clone()], &v0).unwrap())
    );
    assert_eq!(
        update.after.get("updated_at"),
        Some(&FieldValue::Text(TS2.to_string()))
    );
    let decoded = decode_core_strict(&bytes).unwrap();
    assert_eq!(decoded, event);
    // AFTER strict decoding: the same distinct refs and exact hashes.
    let Operation::FacetUpdate(back) = &decoded.operations[0] else {
        panic!("expected update")
    };
    assert_eq!(back.expected["record"].event_ref, Some(known_ref()));
    assert_eq!(back.expected["lifecycle"].event_ref, Some(known_ref_b()));
    assert_eq!(
        back.expected["record"].before_hash,
        update.expected["record"].before_hash
    );
    assert_eq!(
        back.expected["lifecycle"].before_hash,
        update.expected["lifecycle"].before_hash
    );
    assert_eq!(encode_canonical(&decoded).unwrap(), bytes);
}

// ---------------------------------------------------------------------------
// FIX-03 test-first: relation.remove must keep actual creation provenance
// ---------------------------------------------------------------------------

fn creation_ref() -> EventRef {
    EventRef {
        origin_id: ORIGIN.to_string(),
        incarnation: INCARNATION.to_string(),
        seq: "3".to_string(),
        event_id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa".to_string(),
        hash: ["ef"; 32].concat(),
    }
}

// Test A: a modern MODEL deletion keeps its journal creation ref.
#[test]
fn relation_modern_deletion_keeps_creation_ref() {
    let a = uid(90);
    let b = uid(91);
    let edge = uid(92);
    let before = relation_img(&edge, "related_to", &a, &b, "model");
    let effects = vec![effect(
        EntityKind::Relations,
        vec![edge.clone()],
        Some(before.clone()),
        None,
    )];
    let resolver = MapResolver::new();
    let mut known: KnownRefs = BTreeMap::new();
    known.insert((EntityKind::Relations, vec![edge.clone()]), creation_ref());
    let mut baselines: Baselines = BTreeSet::new();
    baselines.insert((EntityKind::KnowledgeObjects, vec![a.clone()]));
    baselines.insert((EntityKind::KnowledgeObjects, vec![b.clone()]));
    let ops = reduce_effects(
        &effects,
        &resolver,
        &known,
        &baselines,
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(ops.len(), 1);
    let Operation::RelationRemove(remove) = &ops[0] else {
        panic!("expected remove")
    };
    assert_eq!(remove.key, vec![edge.clone()]);
    assert_eq!(remove.before, before);
    assert_eq!(
        remove.observed_create,
        ObservedCreate::Event(creation_ref())
    );
}

// Test B: a true legacy deletion keeps the domain-separated image hash.
#[test]
fn relation_legacy_deletion_keeps_image_hash() {
    let a = uid(93);
    let b = uid(94);
    let edge = uid(95);
    let before = relation_img(&edge, "related_to", &a, &b, "model");
    let effects = vec![effect(
        EntityKind::Relations,
        vec![edge.clone()],
        Some(before.clone()),
        None,
    )];
    let resolver = MapResolver::new();
    let mut baselines: Baselines = BTreeSet::new();
    baselines.insert((EntityKind::KnowledgeObjects, vec![a.clone()]));
    baselines.insert((EntityKind::KnowledgeObjects, vec![b.clone()]));
    baselines.insert((EntityKind::Relations, vec![edge.clone()]));
    let ops = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &baselines,
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(ops.len(), 1);
    let Operation::RelationRemove(remove) = &ops[0] else {
        panic!("expected remove")
    };
    let expected = hash_hex(
        &facet_state_hash(EntityKind::Relations, "record", &[edge.clone()], &before).unwrap(),
    );
    assert_eq!(remove.observed_create, ObservedCreate::LegacyHash(expected));
}

// Test C: missing provenance fails closed, never a silent legacy grant.
#[test]
fn relation_missing_provenance_fails() {
    let a = uid(96);
    let b = uid(97);
    let edge = uid(98);
    let before = relation_img(&edge, "related_to", &a, &b, "model");
    let effects = vec![effect(
        EntityKind::Relations,
        vec![edge.clone()],
        Some(before),
        None,
    )];
    let resolver = MapResolver::new();
    let mut baselines: Baselines = BTreeSet::new();
    baselines.insert((EntityKind::KnowledgeObjects, vec![a.clone()]));
    baselines.insert((EntityKind::KnowledgeObjects, vec![b.clone()]));
    let err = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &baselines,
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .expect_err("missing provenance must fail");
    assert_eq!(
        err,
        ReducerError::MissingCreationProvenance {
            entity: "relations"
        }
    );
}

// Test D: contradictory known+baseline provenance fails closed.
#[test]
fn relation_contradictory_provenance_fails() {
    let a = uid(99);
    let b = uid(100);
    let edge = uid(101);
    let before = relation_img(&edge, "related_to", &a, &b, "model");
    let effects = vec![effect(
        EntityKind::Relations,
        vec![edge.clone()],
        Some(before),
        None,
    )];
    let resolver = MapResolver::new();
    let mut known: KnownRefs = BTreeMap::new();
    known.insert((EntityKind::Relations, vec![edge.clone()]), creation_ref());
    let mut baselines: Baselines = BTreeSet::new();
    baselines.insert((EntityKind::KnowledgeObjects, vec![a.clone()]));
    baselines.insert((EntityKind::KnowledgeObjects, vec![b.clone()]));
    baselines.insert((EntityKind::Relations, vec![edge.clone()]));
    let err = reduce_effects(
        &effects,
        &resolver,
        &known,
        &baselines,
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .expect_err("contradictory provenance must fail");
    assert_eq!(
        err,
        ReducerError::ContradictoryProvenance {
            entity: "relations"
        }
    );
}

// Test E: replacement keeps the old creation ref and the new identity.
#[test]
fn relation_replacement_keeps_both_provenances() {
    let a = uid(102);
    let b = uid(103);
    let old = uid(104);
    let fresh = uid(105);
    let before = relation_img(&old, "related_to", &a, &b, "model");
    let created = relation_img(&fresh, "related_to", &a, &b, "model");
    let effects = vec![
        effect(
            EntityKind::Relations,
            vec![old.clone()],
            Some(before.clone()),
            None,
        ),
        effect(
            EntityKind::Relations,
            vec![fresh.clone()],
            None,
            Some(created.clone()),
        ),
    ];
    let resolver = resolver_with(vec![(
        EntityKind::Relations,
        vec![fresh.clone()],
        created.clone(),
    )]);
    let mut known: KnownRefs = BTreeMap::new();
    known.insert((EntityKind::Relations, vec![old.clone()]), creation_ref());
    let mut baselines: Baselines = BTreeSet::new();
    baselines.insert((EntityKind::KnowledgeObjects, vec![a.clone()]));
    baselines.insert((EntityKind::KnowledgeObjects, vec![b.clone()]));
    let ops = reduce_effects(
        &effects,
        &resolver,
        &known,
        &baselines,
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(ops.len(), 2);
    let mut saw_remove = false;
    let mut saw_create = false;
    for op in &ops {
        match op {
            Operation::RelationRemove(r) => {
                saw_remove = true;
                assert_eq!(r.key, vec![old.clone()]);
                assert_eq!(r.before, before);
                assert_eq!(r.observed_create, ObservedCreate::Event(creation_ref()));
            }
            Operation::RecordCreate(c) => {
                saw_create = true;
                assert_eq!(c.key, vec![fresh.clone()]);
                assert_eq!(c.after, created);
            }
            _ => panic!("unexpected op"),
        }
    }
    assert!(saw_remove && saw_create);
}

// Test F: user/system edges still fail through the MODEL-only policy.
#[test]
fn relation_user_edge_still_refused() {
    let a = uid(106);
    let b = uid(107);
    let edge = uid(108);
    let before = relation_img(&edge, "related_to", &a, &b, "user");
    let effects = vec![effect(
        EntityKind::Relations,
        vec![edge.clone()],
        Some(before),
        None,
    )];
    let resolver = MapResolver::new();
    let mut baselines: Baselines = BTreeSet::new();
    baselines.insert((EntityKind::KnowledgeObjects, vec![a.clone()]));
    baselines.insert((EntityKind::KnowledgeObjects, vec![b.clone()]));
    let err = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &baselines,
        &BTreeMap::new(),
        &BTreeMap::new(),
    )
    .expect_err("user edge must fail");
    assert_eq!(err, ReducerError::NonModelEdgeDeletion);
}

// Test G: modern and legacy removals survive strict round-trips.
#[test]
fn relation_removal_round_trips() {
    let a = uid(109);
    let b = uid(110);
    let edge = uid(111);
    let before = relation_img(&edge, "related_to", &a, &b, "model");
    assert_eq!(
        before.get("created_at"),
        Some(&FieldValue::Text(TS0.to_string()))
    );
    let modern = Operation::RelationRemove(RelationRemove {
        key: vec![edge.clone()],
        before: before.clone(),
        observed_create: ObservedCreate::Event(creation_ref()),
    });
    let event = sample_event(vec![modern], vec![]);
    let bytes = encode_canonical(&event).unwrap();
    let decoded = decode_core_strict(&bytes).unwrap();
    assert_eq!(decoded, event);
    assert_eq!(encode_canonical(&decoded).unwrap(), bytes);
    let legacy_hash = hash_hex(
        &facet_state_hash(EntityKind::Relations, "record", &[edge.clone()], &before).unwrap(),
    );
    let legacy = Operation::RelationRemove(RelationRemove {
        key: vec![edge.clone()],
        before: before.clone(),
        observed_create: ObservedCreate::LegacyHash(legacy_hash),
    });
    let event = sample_event(vec![legacy], vec![]);
    let bytes = encode_canonical(&event).unwrap();
    let decoded = decode_core_strict(&bytes).unwrap();
    assert_eq!(decoded, event);
    assert_eq!(encode_canonical(&decoded).unwrap(), bytes);
}

// ---------------------------------------------------------------------------
// FIX-04 test-first: state transitions require operation-local reviewProof
// ---------------------------------------------------------------------------

fn defer_proof(proposal: &str, claim: &str) -> ReviewProof {
    ReviewProof {
        action: ReviewAction::Defer,
        proposal_id: Some(proposal.to_string()),
        claim_id: Some(claim.to_string()),
        object_id: None,
        reviewed_revision_id: None,
        final_body: None,
        user_edited: None,
        result_revision_id: None,
        method: Some(ReviewMethod::User),
    }
}

fn supersede_proof(proposal: &str, claim: &str) -> ReviewProof {
    ReviewProof {
        action: ReviewAction::Supersede,
        proposal_id: Some(proposal.to_string()),
        claim_id: Some(claim.to_string()),
        object_id: None,
        reviewed_revision_id: None,
        final_body: None,
        user_edited: None,
        result_revision_id: None,
        method: Some(ReviewMethod::DerivedClaimResolution),
    }
}

fn approve_proof(proposal: &str, claim: &str, object: &str) -> ReviewProof {
    ReviewProof {
        action: ReviewAction::Approve,
        proposal_id: Some(proposal.to_string()),
        claim_id: Some(claim.to_string()),
        object_id: Some(object.to_string()),
        reviewed_revision_id: Some("r2".to_string()),
        final_body: Some("final".to_string()),
        user_edited: Some(false),
        result_revision_id: Some("rr".to_string()),
        method: Some(ReviewMethod::User),
    }
}

// Test A: a claim state change without proof is rejected.
#[test]
fn claim_transition_without_proof_fails() {
    let before = claim_img("cl", "cap", 0, "open", false);
    let after = claim_img("cl", "cap", 0, "deferred", false);
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::PendingClaims,
        key: vec!["cl".to_string()],
        before: before.clone(),
        after: after.clone(),
        expected: BTreeMap::from([(
            "lifecycle".to_string(),
            expected_for(
                EntityKind::PendingClaims,
                "lifecycle",
                &["cl".to_string()],
                &before,
            ),
        )]),
        review_proof: None,
    });
    let event = sample_event(vec![op], vec![]);
    let err = encode_canonical(&event).expect_err("claim state change needs review proof");
    assert_eq!(
        err,
        super::codec::CodecError::MissingReviewProof {
            entity: "pending_claims"
        }
    );
}

// Test B: a proposal state change without proof is rejected.
#[test]
fn proposal_transition_without_proof_fails() {
    let before = proposal_img("p", "cl", "o", "base", "open");
    let after = proposal_img("p", "cl", "o", "base", "superseded");
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::RevisionProposals,
        key: vec!["p".to_string()],
        before: before.clone(),
        after: after.clone(),
        expected: BTreeMap::from([(
            "lifecycle".to_string(),
            expected_for(
                EntityKind::RevisionProposals,
                "lifecycle",
                &["p".to_string()],
                &before,
            ),
        )]),
        review_proof: None,
    });
    let event = sample_event(vec![op], vec![]);
    let err = encode_canonical(&event).expect_err("proposal state change needs review proof");
    assert_eq!(
        err,
        super::codec::CodecError::MissingReviewProof {
            entity: "revision_proposals"
        }
    );
}

// Test C: strict decoding rejects a canonical event with a null proof.
#[test]
fn strict_decode_rejects_canonical_null_proof() {
    for (entity, before, after, proof) in [
        (
            EntityKind::PendingClaims,
            claim_img("c1", "cap", 0, "open", false),
            claim_img("c1", "cap", 0, "deferred", false),
            defer_proof("p1", "c1"),
        ),
        (
            EntityKind::RevisionProposals,
            proposal_img("p2", "cl2", "o2", "base2", "open"),
            proposal_img("p2", "cl2", "o2", "base2", "superseded"),
            supersede_proof("p2", "cl2"),
        ),
    ] {
        let key = match entity {
            EntityKind::PendingClaims => vec!["c1".to_string()],
            _ => vec!["p2".to_string()],
        };
        let op = Operation::FacetUpdate(FacetUpdate {
            entity,
            key: key.clone(),
            before: before.clone(),
            after: after.clone(),
            expected: BTreeMap::from([(
                "lifecycle".to_string(),
                expected_for(entity, "lifecycle", &key, &before),
            )]),
            review_proof: Some(proof),
        });
        let event = sample_event(vec![op], vec![]);
        let bytes = encode_canonical(&event).unwrap();
        // Surgical tamper: null only the proof, then re-canonicalize in-test
        // so the input stays syntactically valid and canonical.
        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["operations"][0]["reviewProof"] = serde_json::Value::Null;
        let tampered = serde_jcs::to_vec(&value).unwrap();
        let err = decode_core_strict(&tampered).expect_err("null proof must fail");
        let want = match entity {
            EntityKind::PendingClaims => "pending_claims",
            _ => "revision_proposals",
        };
        assert_eq!(
            err,
            super::codec::CodecError::MissingReviewProof { entity: want }
        );
        // The attested original still round-trips.
        assert_eq!(decode_core_strict(&bytes).unwrap(), event);
    }
}

// Test D: correctly attested transitions keep working end to end.
#[test]
fn valid_review_proofs_round_trip() {
    let claim_before = claim_img("c1", "cap", 0, "open", false);
    let claim_after = claim_img("c1", "cap", 0, "deferred", false);
    let claim_op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::PendingClaims,
        key: vec!["c1".to_string()],
        before: claim_before.clone(),
        after: claim_after.clone(),
        expected: BTreeMap::from([(
            "lifecycle".to_string(),
            expected_for(
                EntityKind::PendingClaims,
                "lifecycle",
                &["c1".to_string()],
                &claim_before,
            ),
        )]),
        review_proof: Some(defer_proof("p1", "c1")),
    });
    let prop_before = proposal_img("p2", "cl2", "o2", "base2", "open");
    let prop_after = proposal_img("p2", "cl2", "o2", "base2", "approved");
    let prop_op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::RevisionProposals,
        key: vec!["p2".to_string()],
        before: prop_before.clone(),
        after: prop_after.clone(),
        expected: BTreeMap::from([(
            "lifecycle".to_string(),
            expected_for(
                EntityKind::RevisionProposals,
                "lifecycle",
                &["p2".to_string()],
                &prop_before,
            ),
        )]),
        review_proof: Some(approve_proof("p2", "cl2", "o2")),
    });
    let event = sample_event(vec![claim_op, prop_op], vec![]);
    let bytes = encode_canonical(&event).unwrap();
    let decoded = decode_core_strict(&bytes).unwrap();
    assert_eq!(decoded, event);
    assert_eq!(encode_canonical(&decoded).unwrap(), bytes);
}

// Test E: metadata-only lifecycle updates need no fictitious approval.
#[test]
fn metadata_only_lifecycle_update_needs_no_proof() {
    let before = claim_img("c1", "cap", 0, "open", false);
    let mut after = before.clone();
    after.insert("updated_at".to_string(), txt(TS1));
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::PendingClaims,
        key: vec!["c1".to_string()],
        before: before.clone(),
        after: after.clone(),
        expected: BTreeMap::from([(
            "lifecycle".to_string(),
            expected_for(
                EntityKind::PendingClaims,
                "lifecycle",
                &["c1".to_string()],
                &before,
            ),
        )]),
        review_proof: None,
    });
    let event = sample_event(vec![op], vec![]);
    let bytes = encode_canonical(&event).unwrap();
    let decoded = decode_core_strict(&bytes).unwrap();
    assert_eq!(decoded, event);
    assert_eq!(decoded.operations.len(), 1);
}

// Test F: proof on a non-transition is rejected, not silently kept.
#[test]
fn misplaced_review_proof_fails() {
    // Proof on a project update: wrong entity entirely.
    let before = project_row(&uid(120), "Work", TS0, TS0, None);
    let after = project_row(&uid(120), "Todo", TS0, TS1, None);
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::Projects,
        key: vec![uid(120)],
        before: before.clone(),
        after: after.clone(),
        expected: BTreeMap::from([(
            "record".to_string(),
            expected_for(EntityKind::Projects, "record", &[uid(120)], &before),
        )]),
        review_proof: Some(defer_proof("p", "cl")),
    });
    encode_canonical(&sample_event(vec![op], vec![])).expect_err("project proof must fail");
    // Proof on a claim update whose state did not change.
    let before = claim_img("c2", "cap", 0, "open", false);
    let mut after = before.clone();
    after.insert("updated_at".to_string(), txt(TS1));
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::PendingClaims,
        key: vec!["c2".to_string()],
        before: before.clone(),
        after: after.clone(),
        expected: BTreeMap::from([(
            "lifecycle".to_string(),
            expected_for(
                EntityKind::PendingClaims,
                "lifecycle",
                &["c2".to_string()],
                &before,
            ),
        )]),
        review_proof: Some(defer_proof("p", "c2")),
    });
    let err = encode_canonical(&sample_event(vec![op], vec![]))
        .expect_err("non-transition proof must fail");
    assert_eq!(
        err,
        super::codec::CodecError::UnexpectedField("reviewProof".to_string())
    );
}

// Test G: shape and event validators share one mandatory-proof rule.
#[test]
fn mandatory_proof_validators_agree() {
    let before = claim_img("c3", "cap", 0, "open", false);
    let after = claim_img("c3", "cap", 0, "deferred", false);
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::PendingClaims,
        key: vec!["c3".to_string()],
        before,
        after,
        expected: BTreeMap::from([(
            "lifecycle".to_string(),
            expected_for(
                EntityKind::PendingClaims,
                "lifecycle",
                &["c3".to_string()],
                &claim_img("c3", "cap", 0, "open", false),
            ),
        )]),
        review_proof: None,
    });
    let Operation::FacetUpdate(update) = &op else {
        panic!("expected update")
    };
    let shape_err =
        validate_facet_update_shape(update).expect_err("shape must reject missing proof");
    let event_err = validate_event(&sample_event(vec![op], vec![]))
        .expect_err("event must reject missing proof");
    assert_eq!(
        shape_err,
        super::codec::CodecError::MissingReviewProof {
            entity: "pending_claims"
        }
    );
    assert_eq!(shape_err, event_err);
}

// ---------------------------------------------------------------------------
// FIX-05 test-first: standalone claim defer/reopen without fabricated IDs
// ---------------------------------------------------------------------------

fn standalone_defer_ctx(claim: &str) -> ReviewContext {
    ReviewContext {
        action: ReviewAction::Defer,
        proposal_id: None,
        claim_id: Some(claim.to_string()),
        object_id: None,
        reviewed_revision_id: None,
        final_body: None,
        user_edited: None,
        result_revision_id: None,
        method: Some(ReviewMethod::User),
    }
}

fn standalone_reopen_ctx(claim: &str) -> ReviewContext {
    ReviewContext {
        action: ReviewAction::Reopen,
        proposal_id: None,
        claim_id: Some(claim.to_string()),
        object_id: None,
        reviewed_revision_id: None,
        final_body: None,
        user_edited: None,
        result_revision_id: None,
        method: Some(ReviewMethod::User),
    }
}

fn claim_priors(claim: &str, prior: FacetPrior) -> FacetPriors {
    BTreeMap::from([(
        (
            EntityKind::PendingClaims,
            vec![claim.to_string()],
            FacetId::ClaimLifecycle,
        ),
        prior,
    )])
}

fn claim_baselines(capture: &str) -> Baselines {
    BTreeSet::from([(EntityKind::Captures, vec![capture.to_string()])])
}

// Test A: standalone defer without a proposal reduces with a null proposalId.
#[test]
fn standalone_claim_defer_needs_no_proposal() {
    let before = claim_img("c1", "cap", 0, "open", false);
    let mut after = claim_img("c1", "cap", 0, "deferred", false);
    after.insert("updated_at".to_string(), txt(TS1));
    let effects = vec![effect(
        EntityKind::PendingClaims,
        vec!["c1".to_string()],
        Some(before),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::PendingClaims,
        vec!["c1".to_string()],
        after.clone(),
    )]);
    let mut reviews: ReviewMap = BTreeMap::new();
    reviews.insert(
        (EntityKind::PendingClaims, vec!["c1".to_string()]),
        standalone_defer_ctx("c1"),
    );
    let priors = claim_priors("c1", FacetPrior::LegacyBaseline);
    let ops = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &claim_baselines("cap"),
        &reviews,
        &priors,
    )
    .unwrap();
    assert_eq!(ops.len(), 1);
    let Operation::FacetUpdate(update) = &ops[0] else {
        panic!("expected update")
    };
    let proof = update.review_proof.as_ref().expect("proof required");
    assert_eq!(proof.action, ReviewAction::Defer);
    assert_eq!(proof.proposal_id, None);
    assert_eq!(proof.claim_id, Some("c1".to_string()));
    assert_eq!(proof.method, Some(ReviewMethod::User));
}

// Test B: standalone reopen without a proposal keeps real v9 columns.
#[test]
fn standalone_claim_reopen_needs_no_proposal() {
    let mut before = claim_img("c2", "cap", 0, "deferred", false);
    before.insert("updated_at".to_string(), txt(TS1));
    // Real reopen preserves deferred_at and due_at; only state moves.
    let mut after = claim_img("c2", "cap", 0, "open", false);
    after.insert("deferred_at".to_string(), txt(TS1));
    after.insert("updated_at".to_string(), txt(TS2));
    let effects = vec![effect(
        EntityKind::PendingClaims,
        vec!["c2".to_string()],
        Some(before),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::PendingClaims,
        vec!["c2".to_string()],
        after.clone(),
    )]);
    let mut reviews: ReviewMap = BTreeMap::new();
    reviews.insert(
        (EntityKind::PendingClaims, vec!["c2".to_string()]),
        standalone_reopen_ctx("c2"),
    );
    let priors = claim_priors("c2", FacetPrior::LegacyBaseline);
    let ops = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &claim_baselines("cap"),
        &reviews,
        &priors,
    )
    .unwrap();
    assert_eq!(ops.len(), 1);
    let Operation::FacetUpdate(update) = &ops[0] else {
        panic!("expected update")
    };
    let proof = update.review_proof.as_ref().expect("proof required");
    assert_eq!(proof.action, ReviewAction::Reopen);
    assert_eq!(proof.proposal_id, None);
    assert_eq!(proof.claim_id, Some("c2".to_string()));
    assert_eq!(
        update.after.get("deferred_at"),
        Some(&FieldValue::Text(TS1.to_string()))
    );
}

// Test C: standalone defer/reopen round-trip with null proposalId.
#[test]
fn standalone_claim_proof_round_trips() {
    for (id, state, ctx) in [
        ("c3", "deferred", standalone_defer_ctx("c3")),
        ("c4", "open", standalone_reopen_ctx("c4")),
    ] {
        let (before, after) = if state == "deferred" {
            let mut after = claim_img("c3", "cap", 0, "deferred", false);
            after.insert("updated_at".to_string(), txt(TS1));
            (claim_img("c3", "cap", 0, "open", false), after)
        } else {
            let mut before = claim_img("c4", "cap", 0, "deferred", false);
            before.insert("updated_at".to_string(), txt(TS1));
            let mut after = claim_img("c4", "cap", 0, "open", false);
            after.insert("deferred_at".to_string(), txt(TS1));
            after.insert("updated_at".to_string(), txt(TS2));
            (before, after)
        };
        let effects = vec![effect(
            EntityKind::PendingClaims,
            vec![id.to_string()],
            Some(before),
            Some(after.clone()),
        )];
        let resolver = resolver_with(vec![(
            EntityKind::PendingClaims,
            vec![id.to_string()],
            after.clone(),
        )]);
        let mut reviews: ReviewMap = BTreeMap::new();
        reviews.insert((EntityKind::PendingClaims, vec![id.to_string()]), ctx);
        let priors = claim_priors(id, FacetPrior::LegacyBaseline);
        let ops = reduce_effects(
            &effects,
            &resolver,
            &BTreeMap::new(),
            &claim_baselines("cap"),
            &reviews,
            &priors,
        )
        .unwrap();
        let event = sample_event(ops, vec![]);
        let bytes = encode_canonical(&event).unwrap();
        let decoded = decode_core_strict(&bytes).unwrap();
        assert_eq!(decoded, event);
        assert_eq!(encode_canonical(&decoded).unwrap(), bytes);
    }
}

// Test D: a claim with a real proposal keeps both operation-local proofs.
#[test]
fn claim_with_real_proposal_keeps_both_proofs() {
    let claim_before = claim_img("c9", "cap", 0, "open", false);
    let mut claim_after = claim_img("c9", "cap", 0, "deferred", false);
    claim_after.insert("updated_at".to_string(), txt(TS1));
    let prop_before = proposal_img("p9", "c9", "o9", "b9", "open");
    // Real set_proposal_open_or_deferred() writes state AND updated_at.
    let mut prop_after = proposal_img("p9", "c9", "o9", "b9", "deferred");
    prop_after.insert("updated_at".to_string(), txt(TS1));
    let effects = vec![
        effect(
            EntityKind::PendingClaims,
            vec!["c9".to_string()],
            Some(claim_before),
            Some(claim_after.clone()),
        ),
        effect(
            EntityKind::RevisionProposals,
            vec!["p9".to_string()],
            Some(prop_before),
            Some(prop_after.clone()),
        ),
    ];
    let resolver = resolver_with(vec![
        (
            EntityKind::PendingClaims,
            vec!["c9".to_string()],
            claim_after.clone(),
        ),
        (
            EntityKind::RevisionProposals,
            vec!["p9".to_string()],
            prop_after.clone(),
        ),
    ]);
    let mut known: KnownRefs = BTreeMap::new();
    known.insert(
        (EntityKind::KnowledgeObjects, vec!["o9".to_string()]),
        known_ref(),
    );
    known.insert(
        (EntityKind::ThoughtRevisions, vec!["b9".to_string()]),
        known_ref(),
    );
    let mut reviews: ReviewMap = BTreeMap::new();
    reviews.insert(
        (EntityKind::PendingClaims, vec!["c9".to_string()]),
        ReviewContext {
            action: ReviewAction::Defer,
            proposal_id: Some("p9".to_string()),
            claim_id: Some("c9".to_string()),
            object_id: None,
            reviewed_revision_id: None,
            final_body: None,
            user_edited: None,
            result_revision_id: None,
            method: Some(ReviewMethod::User),
        },
    );
    reviews.insert(
        (EntityKind::RevisionProposals, vec!["p9".to_string()]),
        ReviewContext {
            action: ReviewAction::Defer,
            proposal_id: Some("p9".to_string()),
            claim_id: Some("c9".to_string()),
            object_id: None,
            reviewed_revision_id: None,
            final_body: None,
            user_edited: None,
            result_revision_id: None,
            method: Some(ReviewMethod::User),
        },
    );
    let mut priors: FacetPriors = BTreeMap::new();
    priors.insert(
        (
            EntityKind::PendingClaims,
            vec!["c9".to_string()],
            FacetId::ClaimLifecycle,
        ),
        FacetPrior::LegacyBaseline,
    );
    priors.insert(
        (
            EntityKind::RevisionProposals,
            vec!["p9".to_string()],
            FacetId::ProposalLifecycle,
        ),
        FacetPrior::LegacyBaseline,
    );
    // Both rows predate the journal; the proposal also references its claim.
    let mut row_baselines = claim_baselines("cap");
    row_baselines.insert((EntityKind::PendingClaims, vec!["c9".to_string()]));
    let ops = reduce_effects(
        &effects,
        &resolver,
        &known,
        &row_baselines,
        &reviews,
        &priors,
    )
    .unwrap();
    assert_eq!(ops.len(), 2);
    for op in &ops {
        let Operation::FacetUpdate(update) = op else {
            panic!("expected update")
        };
        let proof = update.review_proof.as_ref().expect("proof required");
        assert_eq!(proof.claim_id, Some("c9".to_string()));
        assert_eq!(proof.proposal_id, Some("p9".to_string()));
        // The actual persisted final timestamp survives on both rows.
        assert_eq!(
            update.after.get("updated_at"),
            Some(&FieldValue::Text(TS1.to_string()))
        );
    }
}

// Test E: missing or mismatched claim identity fails with a typed error.
#[test]
fn claim_transition_without_identity_fails() {
    let before = claim_img("c5", "cap", 0, "open", false);
    let mut after = claim_img("c5", "cap", 0, "deferred", false);
    after.insert("updated_at".to_string(), txt(TS1));
    let effects = vec![effect(
        EntityKind::PendingClaims,
        vec!["c5".to_string()],
        Some(before),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::PendingClaims,
        vec!["c5".to_string()],
        after,
    )]);
    let priors = claim_priors("c5", FacetPrior::LegacyBaseline);
    // No claim id at all.
    let mut reviews: ReviewMap = BTreeMap::new();
    reviews.insert(
        (EntityKind::PendingClaims, vec!["c5".to_string()]),
        ReviewContext {
            action: ReviewAction::Defer,
            proposal_id: None,
            claim_id: None,
            object_id: None,
            reviewed_revision_id: None,
            final_body: None,
            user_edited: None,
            result_revision_id: None,
            method: Some(ReviewMethod::User),
        },
    );
    let err = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &claim_baselines("cap"),
        &reviews,
        &priors,
    )
    .expect_err("missing claim id must fail");
    assert!(matches!(err, ReducerError::InvalidReviewContext(_)));
    // A claim id that contradicts the transitioned row.
    let mut reviews: ReviewMap = BTreeMap::new();
    reviews.insert(
        (EntityKind::PendingClaims, vec!["c5".to_string()]),
        ReviewContext {
            action: ReviewAction::Defer,
            proposal_id: None,
            claim_id: Some("other".to_string()),
            object_id: None,
            reviewed_revision_id: None,
            final_body: None,
            user_edited: None,
            result_revision_id: None,
            method: Some(ReviewMethod::User),
        },
    );
    let err = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &claim_baselines("cap"),
        &reviews,
        &priors,
    )
    .expect_err("contradictory claim id must fail");
    assert!(matches!(err, ReducerError::InvalidReviewContext(_)));
}

// Test F: proposal identity stays mandatory and exact.
#[test]
fn proposal_transition_identity_stays_mandatory() {
    let before = proposal_img("p6", "c6", "o6", "b6", "open");
    let after = proposal_img("p6", "c6", "o6", "b6", "superseded");
    let effects = vec![effect(
        EntityKind::RevisionProposals,
        vec!["p6".to_string()],
        Some(before),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::RevisionProposals,
        vec!["p6".to_string()],
        after,
    )]);
    let mut known: KnownRefs = BTreeMap::new();
    known.insert(
        (EntityKind::PendingClaims, vec!["c6".to_string()]),
        known_ref(),
    );
    known.insert(
        (EntityKind::KnowledgeObjects, vec!["o6".to_string()]),
        known_ref(),
    );
    known.insert(
        (EntityKind::ThoughtRevisions, vec!["b6".to_string()]),
        known_ref(),
    );
    let priors: FacetPriors = BTreeMap::from([(
        (
            EntityKind::RevisionProposals,
            vec!["p6".to_string()],
            FacetId::ProposalLifecycle,
        ),
        FacetPrior::LegacyBaseline,
    )]);
    // Missing proposal id.
    let mut reviews: ReviewMap = BTreeMap::new();
    reviews.insert(
        (EntityKind::RevisionProposals, vec!["p6".to_string()]),
        ReviewContext {
            action: ReviewAction::Supersede,
            proposal_id: None,
            claim_id: Some("c6".to_string()),
            object_id: None,
            reviewed_revision_id: None,
            final_body: None,
            user_edited: None,
            result_revision_id: None,
            method: Some(ReviewMethod::DerivedClaimResolution),
        },
    );
    let err = reduce_effects(
        &effects,
        &resolver,
        &known,
        &claim_baselines("cap"),
        &reviews,
        &priors,
    )
    .expect_err("missing proposal id must fail");
    assert!(matches!(err, ReducerError::InvalidReviewContext(_)));
    // An unrelated proposal id is not silently adopted.
    let mut reviews: ReviewMap = BTreeMap::new();
    reviews.insert(
        (EntityKind::RevisionProposals, vec!["p6".to_string()]),
        ReviewContext {
            action: ReviewAction::Supersede,
            proposal_id: Some("unrelated".to_string()),
            claim_id: Some("c6".to_string()),
            object_id: None,
            reviewed_revision_id: None,
            final_body: None,
            user_edited: None,
            result_revision_id: None,
            method: Some(ReviewMethod::DerivedClaimResolution),
        },
    );
    let err = reduce_effects(
        &effects,
        &resolver,
        &known,
        &claim_baselines("cap"),
        &reviews,
        &priors,
    )
    .expect_err("unrelated proposal id must fail");
    assert!(matches!(err, ReducerError::InvalidReviewContext(_)));
}

// Test G: metadata-only defer/reopen stays proof-free and observable.
#[test]
fn metadata_only_claim_update_stays_proof_free() {
    // Repeated defer: state stays deferred, updated_at and due_at move.
    let mut before = claim_img("c7", "cap", 0, "deferred", false);
    before.insert("updated_at".to_string(), txt(TS1));
    let mut after = before.clone();
    after.insert("updated_at".to_string(), txt(TS2));
    after.insert("due_at".to_string(), txt("2026-10-22T00:00:00Z"));
    let effects = vec![effect(
        EntityKind::PendingClaims,
        vec!["c7".to_string()],
        Some(before),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::PendingClaims,
        vec!["c7".to_string()],
        after,
    )]);
    let priors = claim_priors("c7", FacetPrior::LegacyBaseline);
    let ops = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &claim_baselines("cap"),
        &BTreeMap::new(),
        &priors,
    )
    .unwrap();
    assert_eq!(ops.len(), 1);
    let Operation::FacetUpdate(update) = &ops[0] else {
        panic!("expected update")
    };
    assert!(update.review_proof.is_none());
    assert_eq!(
        update.after.get("updated_at"),
        Some(&FieldValue::Text(TS2.to_string()))
    );
    assert_eq!(
        update.after.get("due_at"),
        Some(&FieldValue::Text("2026-10-22T00:00:00Z".to_string()))
    );
    // Repeated reopen: state stays open, updated_at moves.
    let mut before = claim_img("c8", "cap", 0, "open", false);
    before.insert("updated_at".to_string(), txt(TS1));
    let mut after = before.clone();
    after.insert("updated_at".to_string(), txt(TS2));
    let effects = vec![effect(
        EntityKind::PendingClaims,
        vec!["c8".to_string()],
        Some(before),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::PendingClaims,
        vec!["c8".to_string()],
        after,
    )]);
    let priors = claim_priors("c8", FacetPrior::LegacyBaseline);
    let ops = reduce_effects(
        &effects,
        &resolver,
        &BTreeMap::new(),
        &claim_baselines("cap"),
        &BTreeMap::new(),
        &priors,
    )
    .unwrap();
    let Operation::FacetUpdate(update) = &ops[0] else {
        panic!("expected update")
    };
    assert!(update.review_proof.is_none());
    assert_eq!(
        update.after.get("updated_at"),
        Some(&FieldValue::Text(TS2.to_string()))
    );
}

// Test H: the shared codec still rejects proof-less state transitions.
#[test]
fn codec_still_rejects_proofless_state_change() {
    let before = claim_img("c9", "cap", 0, "open", false);
    let mut after = claim_img("c9", "cap", 0, "deferred", false);
    after.insert("updated_at".to_string(), txt(TS1));
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::PendingClaims,
        key: vec!["c9".to_string()],
        before: before.clone(),
        after: after.clone(),
        expected: BTreeMap::from([(
            "lifecycle".to_string(),
            expected_for(
                EntityKind::PendingClaims,
                "lifecycle",
                &["c9".to_string()],
                &before,
            ),
        )]),
        review_proof: None,
    });
    let err = validate_facet_update_shape(match &op {
        Operation::FacetUpdate(u) => u,
        _ => unreachable!(),
    })
    .expect_err("shape must reject");
    assert_eq!(
        err,
        super::codec::CodecError::MissingReviewProof {
            entity: "pending_claims"
        }
    );
    // A legitimate standalone proof passes the same shared validator.
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::PendingClaims,
        key: vec!["c9".to_string()],
        before: before.clone(),
        after: after.clone(),
        expected: BTreeMap::from([(
            "lifecycle".to_string(),
            expected_for(
                EntityKind::PendingClaims,
                "lifecycle",
                &["c9".to_string()],
                &before,
            ),
        )]),
        review_proof: Some(ReviewProof {
            action: ReviewAction::Defer,
            proposal_id: None,
            claim_id: Some("c9".to_string()),
            object_id: None,
            reviewed_revision_id: None,
            final_body: None,
            user_edited: None,
            result_revision_id: None,
            method: Some(ReviewMethod::User),
        }),
    });
    let event = sample_event(vec![op], vec![]);
    let bytes = encode_canonical(&event).unwrap();
    assert_eq!(decode_core_strict(&bytes).unwrap(), event);
}

// FIX-05A test-first: a proposal proof must name the row's actual claim.
#[test]
fn proposal_proof_bound_to_actual_claim() {
    let before = proposal_img("p6", "c6", "o6", "b6", "open");
    let after = proposal_img("p6", "c6", "o6", "b6", "superseded");
    let effects = vec![effect(
        EntityKind::RevisionProposals,
        vec!["p6".to_string()],
        Some(before),
        Some(after.clone()),
    )];
    let resolver = resolver_with(vec![(
        EntityKind::RevisionProposals,
        vec!["p6".to_string()],
        after,
    )]);
    let mut known: KnownRefs = BTreeMap::new();
    known.insert(
        (EntityKind::PendingClaims, vec!["c6".to_string()]),
        known_ref(),
    );
    known.insert(
        (EntityKind::KnowledgeObjects, vec!["o6".to_string()]),
        known_ref(),
    );
    known.insert(
        (EntityKind::ThoughtRevisions, vec!["b6".to_string()]),
        known_ref(),
    );
    let priors: FacetPriors = BTreeMap::from([(
        (
            EntityKind::RevisionProposals,
            vec!["p6".to_string()],
            FacetId::ProposalLifecycle,
        ),
        FacetPrior::LegacyBaseline,
    )]);
    // Both IDs are valid, but the claim is not the row's actual claim.
    let mut reviews: ReviewMap = BTreeMap::new();
    reviews.insert(
        (EntityKind::RevisionProposals, vec!["p6".to_string()]),
        ReviewContext {
            action: ReviewAction::Supersede,
            proposal_id: Some("p6".to_string()),
            claim_id: Some("other".to_string()),
            object_id: None,
            reviewed_revision_id: None,
            final_body: None,
            user_edited: None,
            result_revision_id: None,
            method: Some(ReviewMethod::DerivedClaimResolution),
        },
    );
    let err = reduce_effects(
        &effects,
        &resolver,
        &known,
        &claim_baselines("cap"),
        &reviews,
        &priors,
    )
    .expect_err("mismatched claim must fail");
    assert!(matches!(err, ReducerError::InvalidReviewContext(_)));
}

// ---------------------------------------------------------------------------
// FIX-06 test-first: expected keys must equal exactly the changed facets
// ---------------------------------------------------------------------------

fn rename_op(id: &str, expected: BTreeMap<String, ExpectedFacet>) -> Operation {
    let before = project_row(id, "Work", TS0, TS0, None);
    let after = project_row(id, "Todo", TS0, TS1, None);
    Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::Projects,
        key: vec![id.to_string()],
        before,
        after,
        expected,
        review_proof: None,
    })
}

// Test A: an unchanged but valid facet must not ride along.
#[test]
fn rename_with_extra_lifecycle_expected_fails() {
    let id = uid(130);
    let before = project_row(&id, "Work", TS0, TS0, None);
    let mut expected = BTreeMap::new();
    expected.insert(
        "record".to_string(),
        expected_for(EntityKind::Projects, "record", &[id.clone()], &before),
    );
    expected.insert(
        "lifecycle".to_string(),
        expected_for(EntityKind::Projects, "lifecycle", &[id.clone()], &before),
    );
    let err = encode_canonical(&sample_event(vec![rename_op(&id, expected)], vec![]))
        .expect_err("extra lifecycle must fail");
    assert_eq!(
        err,
        super::codec::CodecError::UnexpectedField("expected.lifecycle".to_string())
    );
}

// Test B: the mirror image for an archive carrying an unchanged record.
#[test]
fn archive_with_extra_record_expected_fails() {
    let id = uid(131);
    let before = project_row(&id, "Work", TS0, TS0, None);
    let after = project_row(&id, "Work", TS0, TS1, Some(TS1));
    let mut expected = BTreeMap::new();
    expected.insert(
        "lifecycle".to_string(),
        expected_for(EntityKind::Projects, "lifecycle", &[id.clone()], &before),
    );
    expected.insert(
        "record".to_string(),
        expected_for(EntityKind::Projects, "record", &[id.clone()], &before),
    );
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::Projects,
        key: vec![id.clone()],
        before,
        after,
        expected,
        review_proof: None,
    });
    let err =
        encode_canonical(&sample_event(vec![op], vec![])).expect_err("extra record must fail");
    assert_eq!(
        err,
        super::codec::CodecError::UnexpectedField("expected.record".to_string())
    );
}

// Test C: a missing required changed facet keeps its typed failure.
#[test]
fn combined_transition_missing_facet_still_fails() {
    let id = uid(132);
    let before = project_row(&id, "Work", TS0, TS0, None);
    let after = project_row(&id, "Todo", TS0, TS1, Some(TS1));
    let mut expected = BTreeMap::new();
    expected.insert(
        "record".to_string(),
        expected_for(EntityKind::Projects, "record", &[id.clone()], &before),
    );
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::Projects,
        key: vec![id.clone()],
        before,
        after,
        expected,
        review_proof: None,
    });
    let err =
        encode_canonical(&sample_event(vec![op], vec![])).expect_err("missing facet must fail");
    assert_eq!(
        err,
        super::codec::CodecError::MissingField("expected facet state")
    );
}

// Test D: an exact combined transition stays valid with distinct refs.
#[test]
fn combined_transition_exact_expected_round_trips() {
    let id = uid(133);
    let before = project_row(&id, "Work", TS0, TS0, None);
    let after = project_row(&id, "Todo", TS0, TS2, Some(TS2));
    let mut expected = BTreeMap::new();
    let mut record = expected_for(EntityKind::Projects, "record", &[id.clone()], &before);
    record.event_ref = Some(known_ref());
    let mut lifecycle = expected_for(EntityKind::Projects, "lifecycle", &[id.clone()], &before);
    lifecycle.event_ref = Some(known_ref_b());
    expected.insert("record".to_string(), record);
    expected.insert("lifecycle".to_string(), lifecycle);
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::Projects,
        key: vec![id.clone()],
        before,
        after: after.clone(),
        expected,
        review_proof: None,
    });
    let event = sample_event(vec![op], vec![]);
    let bytes = encode_canonical(&event).unwrap();
    let decoded = decode_core_strict(&bytes).unwrap();
    assert_eq!(decoded, event);
    let Operation::FacetUpdate(back) = &decoded.operations[0] else {
        panic!("expected update")
    };
    assert_eq!(back.expected.len(), 2);
    assert_eq!(back.expected["record"].event_ref, Some(known_ref()));
    assert_eq!(back.expected["lifecycle"].event_ref, Some(known_ref_b()));
    assert_eq!(
        back.after.get("updated_at"),
        Some(&FieldValue::Text(TS2.to_string()))
    );
    assert_eq!(encode_canonical(&decoded).unwrap(), bytes);
}

// Test E: an unknown ASCII facet name is rejected by name, not by hash.
#[test]
fn unknown_ascii_facet_name_fails() {
    let id = uid(134);
    let before = project_row(&id, "Work", TS0, TS0, None);
    let mut expected = BTreeMap::new();
    expected.insert(
        "record".to_string(),
        expected_for(EntityKind::Projects, "record", &[id.clone()], &before),
    );
    expected.insert(
        "custom".to_string(),
        ExpectedFacet {
            event_ref: Some(known_ref()),
            before_hash: prev_b_hash(),
        },
    );
    let err = encode_canonical(&sample_event(vec![rename_op(&id, expected)], vec![]))
        .expect_err("unknown facet must fail");
    assert_eq!(
        err,
        super::codec::CodecError::UnexpectedField("expected.custom".to_string())
    );
}

// Test F: non-ASCII facet names are outside the closed vocabulary.
#[test]
fn unicode_facet_names_fail() {
    for name in ["ключ", "😀"] {
        let id = uid(135);
        let before = project_row(&id, "Work", TS0, TS0, None);
        let mut expected = BTreeMap::new();
        expected.insert(
            "record".to_string(),
            expected_for(EntityKind::Projects, "record", &[id.clone()], &before),
        );
        expected.insert(
            name.to_string(),
            ExpectedFacet {
                event_ref: None,
                before_hash: prev_b_hash(),
            },
        );
        let err = encode_canonical(&sample_event(vec![rename_op(&id, expected)], vec![]))
            .expect_err("unicode facet must fail");
        assert_eq!(
            err,
            super::codec::CodecError::UnexpectedField(format!("expected.{name}"))
        );
    }
}

// Test G: a facet name from another entity is rejected.
#[test]
fn foreign_entity_facet_name_fails() {
    let id = uid(136);
    let before = project_row(&id, "Work", TS0, TS0, None);
    let mut expected = BTreeMap::new();
    expected.insert(
        "record".to_string(),
        expected_for(EntityKind::Projects, "record", &[id.clone()], &before),
    );
    expected.insert(
        "membership".to_string(),
        ExpectedFacet {
            event_ref: None,
            before_hash: prev_b_hash(),
        },
    );
    let err = encode_canonical(&sample_event(vec![rename_op(&id, expected)], vec![]))
        .expect_err("foreign facet must fail");
    assert_eq!(
        err,
        super::codec::CodecError::UnexpectedField("expected.membership".to_string())
    );
    let before = capture_img("cc", INBOX, "x");
    let mut after = before.clone();
    after.insert("project_id".to_string(), txt(&uid(137)));
    let mut expected = BTreeMap::new();
    expected.insert(
        "membership".to_string(),
        expected_for(
            EntityKind::Captures,
            "membership",
            &["cc".to_string()],
            &before,
        ),
    );
    expected.insert(
        "head".to_string(),
        ExpectedFacet {
            event_ref: None,
            before_hash: prev_b_hash(),
        },
    );
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::Captures,
        key: vec!["cc".to_string()],
        before,
        after,
        expected,
        review_proof: None,
    });
    let err =
        encode_canonical(&sample_event(vec![op], vec![])).expect_err("foreign head must fail");
    assert_eq!(
        err,
        super::codec::CodecError::UnexpectedField("expected.head".to_string())
    );
}

// Test H: KnowledgeObject facets stay independent and exact.
#[test]
fn object_facets_exact_and_independent() {
    let obj = uid(138);
    let rev = uid(139);
    let dest = uid(140);
    let before = object_img(&obj, INBOX, Some(&rev));
    let mut moved = before.clone();
    moved.insert("project_id".to_string(), txt(&dest));
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::KnowledgeObjects,
        key: vec![obj.clone()],
        before: before.clone(),
        after: moved.clone(),
        expected: BTreeMap::from([(
            "membership".to_string(),
            expected_for(
                EntityKind::KnowledgeObjects,
                "membership",
                &[obj.clone()],
                &before,
            ),
        )]),
        review_proof: None,
    });
    let event = sample_event(vec![op], vec![]);
    let bytes = encode_canonical(&event).unwrap();
    assert_eq!(decode_core_strict(&bytes).unwrap(), event);
    let mut extra = BTreeMap::new();
    extra.insert(
        "membership".to_string(),
        expected_for(
            EntityKind::KnowledgeObjects,
            "membership",
            &[obj.clone()],
            &before,
        ),
    );
    extra.insert(
        "head".to_string(),
        ExpectedFacet {
            event_ref: None,
            before_hash: prev_b_hash(),
        },
    );
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::KnowledgeObjects,
        key: vec![obj.clone()],
        before,
        after: moved,
        expected: extra,
        review_proof: None,
    });
    let err =
        encode_canonical(&sample_event(vec![op], vec![])).expect_err("unchanged head must fail");
    assert_eq!(
        err,
        super::codec::CodecError::UnexpectedField("expected.head".to_string())
    );
    // A. Head-only update with exactly expected.head.
    let obj2 = uid(150);
    let rev_a = uid(151);
    let rev_b = uid(152);
    let before = object_img(&obj2, INBOX, Some(&rev_a));
    let mut headed = before.clone();
    headed.insert("current_revision_id".to_string(), txt(&rev_b));
    headed.insert("title".to_string(), txt("new"));
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::KnowledgeObjects,
        key: vec![obj2.clone()],
        before: before.clone(),
        after: headed.clone(),
        expected: BTreeMap::from([(
            "head".to_string(),
            expected_for(
                EntityKind::KnowledgeObjects,
                "head",
                &[obj2.clone()],
                &before,
            ),
        )]),
        review_proof: None,
    });
    let event = sample_event(vec![op], vec![]);
    let bytes = encode_canonical(&event).unwrap();
    assert_eq!(decode_core_strict(&bytes).unwrap(), event);
    // B. The unchanged membership facet must not ride along.
    let mut extra = BTreeMap::new();
    extra.insert(
        "head".to_string(),
        expected_for(
            EntityKind::KnowledgeObjects,
            "head",
            &[obj2.clone()],
            &before,
        ),
    );
    extra.insert(
        "membership".to_string(),
        ExpectedFacet {
            event_ref: None,
            before_hash: prev_b_hash(),
        },
    );
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::KnowledgeObjects,
        key: vec![obj2.clone()],
        before,
        after: headed,
        expected: extra,
        review_proof: None,
    });
    let err = encode_canonical(&sample_event(vec![op], vec![]))
        .expect_err("unchanged membership must fail");
    assert_eq!(
        err,
        super::codec::CodecError::UnexpectedField("expected.membership".to_string())
    );
    // C. Combined move plus head change carries both independent refs.
    let obj3 = uid(153);
    let rev_c = uid(154);
    let rev_d = uid(155);
    let dest = uid(156);
    let before = object_img(&obj3, INBOX, Some(&rev_c));
    let mut after = before.clone();
    after.insert("project_id".to_string(), txt(&dest));
    after.insert("current_revision_id".to_string(), txt(&rev_d));
    after.insert("title".to_string(), txt("new"));
    let mut both = BTreeMap::new();
    let mut membership = expected_for(
        EntityKind::KnowledgeObjects,
        "membership",
        &[obj3.clone()],
        &before,
    );
    membership.event_ref = Some(known_ref());
    let mut head = expected_for(
        EntityKind::KnowledgeObjects,
        "head",
        &[obj3.clone()],
        &before,
    );
    head.event_ref = Some(known_ref_b());
    both.insert("membership".to_string(), membership);
    both.insert("head".to_string(), head);
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::KnowledgeObjects,
        key: vec![obj3.clone()],
        before,
        after: after.clone(),
        expected: both,
        review_proof: None,
    });
    let event = sample_event(vec![op], vec![]);
    let bytes = encode_canonical(&event).unwrap();
    let decoded = decode_core_strict(&bytes).unwrap();
    assert_eq!(decoded, event);
    let Operation::FacetUpdate(back) = &decoded.operations[0] else {
        panic!("expected update")
    };
    assert_eq!(back.expected.len(), 2);
    assert_eq!(back.expected["membership"].event_ref, Some(known_ref()));
    assert_eq!(back.expected["head"].event_ref, Some(known_ref_b()));
    assert_eq!(encode_canonical(&decoded).unwrap(), bytes);
}

// Test I: a Capture move requires exactly the membership facet.
#[test]
fn capture_move_requires_exact_membership() {
    let before = capture_img("cc", INBOX, "x");
    let mut after = before.clone();
    after.insert("project_id".to_string(), txt(&uid(141)));
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::Captures,
        key: vec!["cc".to_string()],
        before: before.clone(),
        after: after.clone(),
        expected: BTreeMap::from([(
            "membership".to_string(),
            expected_for(
                EntityKind::Captures,
                "membership",
                &["cc".to_string()],
                &before,
            ),
        )]),
        review_proof: None,
    });
    let event = sample_event(vec![op], vec![]);
    let bytes = encode_canonical(&event).unwrap();
    assert_eq!(decode_core_strict(&bytes).unwrap(), event);
    let mut extra = BTreeMap::new();
    extra.insert(
        "membership".to_string(),
        expected_for(
            EntityKind::Captures,
            "membership",
            &["cc".to_string()],
            &before,
        ),
    );
    extra.insert(
        "record".to_string(),
        ExpectedFacet {
            event_ref: None,
            before_hash: prev_b_hash(),
        },
    );
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::Captures,
        key: vec!["cc".to_string()],
        before,
        after,
        expected: extra,
        review_proof: None,
    });
    let err =
        encode_canonical(&sample_event(vec![op], vec![])).expect_err("extra record must fail");
    assert_eq!(
        err,
        super::codec::CodecError::UnexpectedField("expected.record".to_string())
    );
}

// A truthful standalone claim proof: no proposal exists, none is invented.
fn standalone_claim_proof(claim: &str) -> ReviewProof {
    ReviewProof {
        action: ReviewAction::Defer,
        proposal_id: None,
        claim_id: Some(claim.to_string()),
        object_id: None,
        reviewed_revision_id: None,
        final_body: None,
        user_edited: None,
        result_revision_id: None,
        method: Some(ReviewMethod::User),
    }
}

// Test J: claim/proposal lifecycle stays exact with and without proof.
#[test]
fn claim_proposal_lifecycle_exactness() {
    let before = claim_img("cj", "cap", 0, "open", false);
    let mut after = claim_img("cj", "cap", 0, "deferred", false);
    after.insert("updated_at".to_string(), txt(TS1));
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::PendingClaims,
        key: vec!["cj".to_string()],
        before: before.clone(),
        after: after.clone(),
        expected: BTreeMap::from([(
            "lifecycle".to_string(),
            expected_for(
                EntityKind::PendingClaims,
                "lifecycle",
                &["cj".to_string()],
                &before,
            ),
        )]),
        review_proof: Some(standalone_claim_proof("cj")),
    });
    let event = sample_event(vec![op], vec![]);
    let bytes = encode_canonical(&event).unwrap();
    assert_eq!(decode_core_strict(&bytes).unwrap(), event);
    let mut extra = BTreeMap::new();
    extra.insert(
        "lifecycle".to_string(),
        expected_for(
            EntityKind::PendingClaims,
            "lifecycle",
            &["cj".to_string()],
            &before,
        ),
    );
    extra.insert(
        "record".to_string(),
        ExpectedFacet {
            event_ref: None,
            before_hash: prev_b_hash(),
        },
    );
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::PendingClaims,
        key: vec!["cj".to_string()],
        before,
        after,
        expected: extra,
        review_proof: Some(standalone_claim_proof("cj")),
    });
    let err =
        encode_canonical(&sample_event(vec![op], vec![])).expect_err("extra claim facet must fail");
    assert_eq!(
        err,
        super::codec::CodecError::UnexpectedField("expected.record".to_string())
    );
    let before = claim_img("ck", "cap", 0, "open", false);
    let mut after = before.clone();
    after.insert("updated_at".to_string(), txt(TS1));
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::PendingClaims,
        key: vec!["ck".to_string()],
        before: before.clone(),
        after: after.clone(),
        expected: BTreeMap::from([(
            "lifecycle".to_string(),
            expected_for(
                EntityKind::PendingClaims,
                "lifecycle",
                &["ck".to_string()],
                &before,
            ),
        )]),
        review_proof: None,
    });
    let event = sample_event(vec![op], vec![]);
    let bytes = encode_canonical(&event).unwrap();
    assert_eq!(decode_core_strict(&bytes).unwrap(), event);
    // A real proposal transition: open -> superseded with its own proof.
    let prop_before = proposal_img("pk", "ck2", "ok", "bk", "open");
    let prop_after = proposal_img("pk", "ck2", "ok", "bk", "superseded");
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::RevisionProposals,
        key: vec!["pk".to_string()],
        before: prop_before.clone(),
        after: prop_after.clone(),
        expected: BTreeMap::from([(
            "lifecycle".to_string(),
            expected_for(
                EntityKind::RevisionProposals,
                "lifecycle",
                &["pk".to_string()],
                &prop_before,
            ),
        )]),
        review_proof: Some(supersede_proof("pk", "ck2")),
    });
    let event = sample_event(vec![op], vec![]);
    let bytes = encode_canonical(&event).unwrap();
    let decoded = decode_core_strict(&bytes).unwrap();
    assert_eq!(decoded, event);
    let Operation::FacetUpdate(back) = &decoded.operations[0] else {
        panic!("expected update")
    };
    assert_eq!(back.expected.len(), 1);
    assert!(back.expected.contains_key("lifecycle"));
    assert_eq!(encode_canonical(&decoded).unwrap(), bytes);
    // The same transition with a structurally valid extra facet is rejected.
    let mut extra = BTreeMap::new();
    extra.insert(
        "lifecycle".to_string(),
        expected_for(
            EntityKind::RevisionProposals,
            "lifecycle",
            &["pk".to_string()],
            &prop_before,
        ),
    );
    extra.insert(
        "record".to_string(),
        ExpectedFacet {
            event_ref: None,
            before_hash: prev_b_hash(),
        },
    );
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::RevisionProposals,
        key: vec!["pk".to_string()],
        before: prop_before,
        after: prop_after,
        expected: extra,
        review_proof: Some(supersede_proof("pk", "ck2")),
    });
    let err = encode_canonical(&sample_event(vec![op], vec![]))
        .expect_err("extra proposal facet must fail");
    assert_eq!(
        err,
        super::codec::CodecError::UnexpectedField("expected.record".to_string())
    );
}

// Test K: canonical tampering with expected keys is rejected by name.
#[test]
fn canonical_tampered_expected_keys_fail() {
    let id = uid(142);
    let before = project_row(&id, "Work", TS0, TS0, None);
    let after = project_row(&id, "Todo", TS0, TS1, None);
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::Projects,
        key: vec![id.clone()],
        before: before.clone(),
        after: after.clone(),
        expected: BTreeMap::from([(
            "record".to_string(),
            expected_for(EntityKind::Projects, "record", &[id.clone()], &before),
        )]),
        review_proof: None,
    });
    let bytes = encode_canonical(&sample_event(vec![op], vec![])).unwrap();
    for extra in ["lifecycle", "custom"] {
        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["operations"][0]["expected"][extra] =
            serde_json::json!({"eventRef": null, "beforeHash": prev_b_hash()});
        let tampered = serde_jcs::to_vec(&value).unwrap();
        let err = decode_core_strict(&tampered).expect_err("tampered expected must fail");
        assert_eq!(
            err,
            super::codec::CodecError::UnexpectedField(format!("expected.{extra}"))
        );
    }
}

// Test L: shape, event, encode and decode agree on exact-set rejection.
#[test]
fn expected_exactness_parity_across_validators() {
    let id = uid(143);
    let before = project_row(&id, "Work", TS0, TS0, None);
    let after = project_row(&id, "Todo", TS0, TS1, None);
    let mut expected = BTreeMap::new();
    expected.insert(
        "record".to_string(),
        expected_for(EntityKind::Projects, "record", &[id.clone()], &before),
    );
    expected.insert(
        "lifecycle".to_string(),
        expected_for(EntityKind::Projects, "lifecycle", &[id.clone()], &before),
    );
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::Projects,
        key: vec![id.clone()],
        before,
        after,
        expected,
        review_proof: None,
    });
    let want = super::codec::CodecError::UnexpectedField("expected.lifecycle".to_string());
    let Operation::FacetUpdate(update) = &op else {
        panic!("expected update")
    };
    assert_eq!(
        validate_facet_update_shape(update).expect_err("shape must reject"),
        want
    );
    assert_eq!(
        validate_event(&sample_event(vec![op.clone()], vec![])).expect_err("event must reject"),
        want
    );
    assert_eq!(
        encode_canonical(&sample_event(vec![op], vec![])).expect_err("encode must reject"),
        want
    );
    let bytes = encode_canonical(&sample_event(
        vec![rename_op(
            &id,
            BTreeMap::from([(
                "record".to_string(),
                expected_for(
                    EntityKind::Projects,
                    "record",
                    &[id.clone()],
                    &project_row(&id, "Work", TS0, TS0, None),
                ),
            )]),
        )],
        vec![],
    ))
    .unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    value["operations"][0]["expected"]["lifecycle"] =
        serde_json::json!({"eventRef": null, "beforeHash": prev_b_hash()});
    let tampered = serde_jcs::to_vec(&value).unwrap();
    assert_eq!(decode_core_strict(&tampered).unwrap_err(), want);
}

// Test M: no changed facet means no expected entry at all.
#[test]
fn unchanged_facets_reject_any_expected() {
    let id = uid(144);
    let image = project_row(&id, "Work", TS0, TS0, None);
    let op = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::Projects,
        key: vec![id.clone()],
        before: image.clone(),
        after: image.clone(),
        expected: BTreeMap::from([(
            "record".to_string(),
            expected_for(EntityKind::Projects, "record", &[id.clone()], &image),
        )]),
        review_proof: None,
    });
    let err =
        encode_canonical(&sample_event(vec![op], vec![])).expect_err("stale expected must fail");
    assert_eq!(
        err,
        super::codec::CodecError::UnexpectedField("expected.record".to_string())
    );
}

// ---------------------------------------------------------------------------
// FIX-07 test-first: relation.remove is MODEL-only in the codec itself
// ---------------------------------------------------------------------------

fn remove_op(edge: &str, before: RowImage, observed: ObservedCreate) -> Operation {
    Operation::RelationRemove(RelationRemove {
        key: vec![edge.to_string()],
        before,
        observed_create: observed,
    })
}

// Test A: direct USER removal is rejected even with a valid EventRef.
#[test]
fn direct_user_removal_fails() {
    let before = relation_img(&uid(150), "related_to", &uid(151), &uid(152), "user");
    let op = remove_op(&uid(150), before, ObservedCreate::Event(creation_ref()));
    let event = sample_event(vec![op], vec![]);
    let want = super::codec::CodecError::NonModelRelationRemoval;
    assert_eq!(
        validate_event(&event).expect_err("user removal must fail"),
        want
    );
    assert_eq!(
        encode_canonical(&event).expect_err("user removal must fail"),
        want
    );
}

// Test B: direct SYSTEM removal is rejected even with a valid legacy hash.
#[test]
fn direct_system_removal_fails() {
    let edge = uid(153);
    let before = relation_img(&edge, "related_to", &uid(154), &uid(155), "system");
    let legacy = hash_hex(
        &facet_state_hash(EntityKind::Relations, "record", &[edge.clone()], &before).unwrap(),
    );
    let op = remove_op(&edge, before, ObservedCreate::LegacyHash(legacy));
    let event = sample_event(vec![op], vec![]);
    let want = super::codec::CodecError::NonModelRelationRemoval;
    assert_eq!(
        validate_event(&event).expect_err("system removal must fail"),
        want
    );
    assert_eq!(
        encode_canonical(&event).expect_err("system removal must fail"),
        want
    );
}

// Test C: a valid modern MODEL removal round-trips untouched.
#[test]
fn modern_model_removal_round_trips() {
    let edge = uid(156);
    let before = relation_img(&edge, "related_to", &uid(157), &uid(158), "model");
    let op = remove_op(&edge, before.clone(), ObservedCreate::Event(creation_ref()));
    let event = sample_event(vec![op], vec![]);
    validate_event(&event).unwrap();
    let bytes = encode_canonical(&event).unwrap();
    let decoded = decode_core_strict(&bytes).unwrap();
    assert_eq!(decoded, event);
    let Operation::RelationRemove(back) = &decoded.operations[0] else {
        panic!("expected remove")
    };
    assert_eq!(back.observed_create, ObservedCreate::Event(creation_ref()));
    assert_eq!(back.before, before);
    assert_eq!(encode_canonical(&decoded).unwrap(), bytes);
}

// Test D: a valid legacy MODEL removal round-trips untouched.
#[test]
fn legacy_model_removal_round_trips() {
    let edge = uid(159);
    let before = relation_img(&edge, "related_to", &uid(160), &uid(161), "model");
    let legacy = hash_hex(
        &facet_state_hash(EntityKind::Relations, "record", &[edge.clone()], &before).unwrap(),
    );
    let op = remove_op(
        &edge,
        before.clone(),
        ObservedCreate::LegacyHash(legacy.clone()),
    );
    let event = sample_event(vec![op], vec![]);
    validate_event(&event).unwrap();
    let bytes = encode_canonical(&event).unwrap();
    let decoded = decode_core_strict(&bytes).unwrap();
    assert_eq!(decoded, event);
    let Operation::RelationRemove(back) = &decoded.operations[0] else {
        panic!("expected remove")
    };
    assert_eq!(back.observed_create, ObservedCreate::LegacyHash(legacy));
    assert_eq!(encode_canonical(&decoded).unwrap(), bytes);
}

// Test E: strict decoding rejects a canonical USER removal by policy.
#[test]
fn strict_decode_rejects_canonical_user_removal() {
    let edge = uid(162);
    let before = relation_img(&edge, "related_to", &uid(163), &uid(164), "model");
    let legacy = hash_hex(
        &facet_state_hash(EntityKind::Relations, "record", &[edge.clone()], &before).unwrap(),
    );
    let op = remove_op(&edge, before, ObservedCreate::LegacyHash(legacy));
    let bytes = encode_canonical(&sample_event(vec![op], vec![])).unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    value["operations"][0]["before"]["origin"] = serde_json::Value::String("user".to_string());
    let user_before = relation_img(&edge, "related_to", &uid(163), &uid(164), "user");
    let user_hash = hash_hex(
        &facet_state_hash(
            EntityKind::Relations,
            "record",
            &[edge.clone()],
            &user_before,
        )
        .unwrap(),
    );
    value["operations"][0]["observedCreate"]["legacyHash"] = serde_json::Value::String(user_hash);
    let recanonical = serde_jcs::to_vec(&value).unwrap();
    let err = decode_core_strict(&recanonical).expect_err("tampered user removal must fail");
    assert_eq!(err, super::codec::CodecError::NonModelRelationRemoval);
}

// Test F: strict decoding rejects a canonical SYSTEM removal by policy.
#[test]
fn strict_decode_rejects_canonical_system_removal() {
    let edge = uid(165);
    let before = relation_img(&edge, "related_to", &uid(166), &uid(167), "model");
    let op = remove_op(&edge, before, ObservedCreate::Event(creation_ref()));
    let bytes = encode_canonical(&sample_event(vec![op], vec![])).unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    value["operations"][0]["before"]["origin"] = serde_json::Value::String("system".to_string());
    let recanonical = serde_jcs::to_vec(&value).unwrap();
    let err = decode_core_strict(&recanonical).expect_err("tampered system removal must fail");
    assert_eq!(err, super::codec::CodecError::NonModelRelationRemoval);
}

// Test G: an unknown origin stays a row-shape error, not a policy pass.
#[test]
fn unknown_origin_stays_row_error() {
    let edge = uid(168);
    let mut before = relation_img(&edge, "related_to", &uid(169), &uid(170), "model");
    before.insert("origin".to_string(), txt("external"));
    let op = remove_op(&edge, before, ObservedCreate::LegacyHash(prev_b_hash()));
    let err =
        validate_event(&sample_event(vec![op], vec![])).expect_err("unknown origin must fail");
    assert!(matches!(
        err,
        super::codec::CodecError::InvalidEnumValue {
            field: "origin",
            ..
        }
    ));
}

// Test H: USER and SYSTEM creations remain valid record.create operations.
#[test]
fn user_system_creations_stay_valid() {
    for origin in ["user", "system"] {
        let edge = uid(171);
        let image = relation_img(&edge, "related_to", &uid(172), &uid(173), origin);
        let op = Operation::RecordCreate(RecordCreate {
            entity: EntityKind::Relations,
            key: vec![edge],
            after: image.clone(),
        });
        let event = sample_event(vec![op], vec![]);
        validate_event(&event).unwrap();
        let bytes = encode_canonical(&event).unwrap();
        let decoded = decode_core_strict(&bytes).unwrap();
        assert_eq!(decoded, event);
    }
}

// Test I: the reducer still refuses USER/SYSTEM deletion itself.
#[test]
fn reducer_still_refuses_non_model_deletion() {
    for origin in ["user", "system"] {
        let edge = uid(174);
        let before = relation_img(&edge, "related_to", &uid(175), &uid(176), origin);
        let effects = vec![effect(
            EntityKind::Relations,
            vec![edge],
            Some(before),
            None,
        )];
        let resolver = MapResolver::new();
        let mut baselines: Baselines = BTreeSet::new();
        baselines.insert((EntityKind::KnowledgeObjects, vec![uid(175)]));
        baselines.insert((EntityKind::KnowledgeObjects, vec![uid(176)]));
        let err = reduce_effects(
            &effects,
            &resolver,
            &BTreeMap::new(),
            &baselines,
            &BTreeMap::new(),
            &BTreeMap::new(),
        )
        .expect_err("non-model must fail");
        assert_eq!(err, ReducerError::NonModelEdgeDeletion);
    }
}

// ---------------------------------------------------------------------------
// FIX-08 test-first: raw count range and early decode size admission
// ---------------------------------------------------------------------------

fn count_event(count: &str) -> JournalEvent {
    let mut event = sample_event(vec![capture_create_op("cnt", "x")], vec![]);
    event.raw_effect_count = count.to_string();
    event
}

// Test A: raw_effect_count "0" is below the SQL range.
#[test]
fn raw_count_zero_is_rejected() {
    let event = count_event("0");
    let want = super::codec::CodecError::InvalidDecimal("0".to_string());
    assert_eq!(
        validate_event(&event).expect_err("zero count must fail"),
        want
    );
    assert_eq!(
        encode_canonical(&event).expect_err("zero count must fail"),
        want
    );
}

// Test B: the lowest valid boundary round-trips.
#[test]
fn raw_count_one_is_accepted() {
    let event = count_event("1");
    validate_event(&event).unwrap();
    let bytes = encode_canonical(&event).unwrap();
    assert_eq!(decode_core_strict(&bytes).unwrap(), event);
}

// Test C: the highest valid boundary with a single reduced operation.
// Multiple raw SQL effects may reduce to fewer logical operations, so the
// count is intentionally NOT equal to operations.len() here.
#[test]
fn raw_count_max_is_accepted() {
    let event = count_event("4096");
    validate_event(&event).unwrap();
    let bytes = encode_canonical(&event).unwrap();
    assert_eq!(decode_core_strict(&bytes).unwrap(), event);
}

// Test D: the first invalid upper boundary fails.
#[test]
fn raw_count_above_max_is_rejected() {
    let event = count_event("4097");
    let want = super::codec::CodecError::InvalidDecimal("4097".to_string());
    assert_eq!(
        validate_event(&event).expect_err("over-max count must fail"),
        want
    );
    assert_eq!(
        encode_canonical(&event).expect_err("over-max count must fail"),
        want
    );
}

// Test E: large canonical decimals outside the field range fail.
#[test]
fn raw_count_large_decimals_are_rejected() {
    for count in ["9223372036854775807", "18446744073709551615"] {
        let event = count_event(count);
        let want = super::codec::CodecError::InvalidDecimal(count.to_string());
        assert_eq!(
            validate_event(&event).expect_err("large count must fail"),
            want
        );
        assert_eq!(
            encode_canonical(&event).expect_err("large count must fail"),
            want
        );
    }
}

// Test F: overflow and malformed decimals fail without panic or wrapping.
#[test]
fn raw_count_malformed_decimals_are_rejected() {
    for count in ["18446744073709551616", "-1", "+1", "01", "1.0", ""] {
        let event = count_event(count);
        validate_event(&event).expect_err("malformed count must fail");
        encode_canonical(&event).expect_err("malformed count must fail");
    }
}

// Test G: canonical count tampering is rejected by range, not by shape.
#[test]
fn strict_decode_rejects_tampered_count() {
    for count in ["0", "4097"] {
        let bytes = encode_canonical(&count_event("1")).unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["rawEffectCount"] = serde_json::Value::String(count.to_string());
        let tampered = serde_jcs::to_vec(&value).unwrap();
        let err = decode_core_strict(&tampered).expect_err("tampered count must fail");
        assert_eq!(
            err,
            super::codec::CodecError::InvalidDecimal(count.to_string())
        );
    }
}

// Test H: the raw count is not the reduced operation count.
#[test]
fn raw_count_is_not_operation_count() {
    let event = count_event("2");
    validate_event(&event).unwrap();
    let bytes = encode_canonical(&event).unwrap();
    let decoded = decode_core_strict(&bytes).unwrap();
    assert_eq!(decoded, event);
    assert_eq!(decoded.raw_effect_count, "2".to_string());
    assert_eq!(decoded.operations.len(), 1);
}

// Test I: oversized malformed input fails before scanning or parsing.
#[test]
fn oversized_malformed_input_fails_first() {
    let input = vec![0xFFu8; MAX_CANONICAL_BYTES + 1];
    let err = decode_core_strict(&input).expect_err("oversized input must fail");
    assert_eq!(
        err,
        super::codec::CodecError::OversizeBundle {
            bytes: MAX_CANONICAL_BYTES + 1,
            limit: MAX_CANONICAL_BYTES
        }
    );
}

// Test J: oversized but syntactically valid JSON fails with the size error.
#[test]
fn oversized_valid_json_fails_first() {
    let value = serde_json::json!({"pad": "x".repeat(MAX_CANONICAL_BYTES + 1)});
    let input = serde_jcs::to_vec(&value).unwrap();
    assert!(input.len() > MAX_CANONICAL_BYTES);
    let err = decode_core_strict(&input).expect_err("oversized JSON must fail");
    assert_eq!(
        err,
        super::codec::CodecError::OversizeBundle {
            bytes: input.len(),
            limit: MAX_CANONICAL_BYTES
        }
    );
}

// Test K: the inclusive upper boundary admits exact-limit canonical events.
#[test]
fn exact_size_boundary_decodes() {
    let one = sample_event(vec![capture_create_op("kz", "x")], vec![]);
    let overhead = encode_canonical(&one).unwrap().len() - 1;
    let content = "x".repeat(MAX_CANONICAL_BYTES - overhead);
    let event = sample_event(vec![capture_create_op("kz", &content)], vec![]);
    let bytes = encode_canonical(&event).unwrap();
    assert_eq!(bytes.len(), MAX_CANONICAL_BYTES);
    assert_eq!(decode_core_strict(&bytes).unwrap(), event);
    let mut over = bytes;
    over.push(b' ');
    let err = decode_core_strict(&over).expect_err("one byte over must fail");
    assert_eq!(
        err,
        super::codec::CodecError::OversizeBundle {
            bytes: MAX_CANONICAL_BYTES + 1,
            limit: MAX_CANONICAL_BYTES
        }
    );
}

// Test L: size takes precedence over every parser error.
#[test]
fn size_error_precedes_parser_errors() {
    let input = vec![b'{'; MAX_CANONICAL_BYTES + 1];
    let err = decode_core_strict(&input).expect_err("deep oversized input must fail");
    assert_eq!(
        err,
        super::codec::CodecError::OversizeBundle {
            bytes: MAX_CANONICAL_BYTES + 1,
            limit: MAX_CANONICAL_BYTES
        }
    );
    let small = b"{\"a\":1,\"a\":2}";
    let err = decode_core_strict(small).expect_err("small duplicate must fail");
    assert_eq!(err, super::codec::CodecError::DuplicateKey("a".to_string()));
}

// Test M: ordinary events keep byte-identical round-trips.
#[test]
fn ordinary_events_round_trip_identically() {
    let event = count_event("7");
    let bytes = encode_canonical(&event).unwrap();
    assert_eq!(decode_core_strict(&bytes).unwrap(), event);
    assert_eq!(
        encode_canonical(&decode_core_strict(&bytes).unwrap()).unwrap(),
        bytes
    );
}
