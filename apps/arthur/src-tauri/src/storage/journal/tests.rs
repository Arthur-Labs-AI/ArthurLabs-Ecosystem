//! Deterministic native proofs for the dormant journal codec/reducer.
//!
//! No production write path is exercised: fixtures are synthetic row images
//! and in-memory resolvers. No network, no paid providers, no real database.

use std::collections::{BTreeMap, BTreeSet};

use super::codec::{
    decode_core_strict, encode_canonical, facet_state_hash, hash_hex, journal_event_hash,
    validate_decimal, validate_key, Dependency, EntityKind, EventRef, ExpectedFacet, FacetUpdate,
    FieldValue, JournalEvent, ObservedCreate, Operation, RecordCreate, ReviewAction, ReviewMethod,
    ReviewProof, RowImage, MAX_CANONICAL_BYTES, OPERATION_VERSION, PROVENANCE_LOCAL_COMMITTED,
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
                assert!(matches!(r.observed_create, ObservedCreate::LegacyHash(_)));
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
    let mut reviews: ReviewMap = BTreeMap::new();
    reviews.insert(
        (EntityKind::PendingClaims, vec!["cl".to_string()]),
        ReviewContext {
            action: ReviewAction::Defer,
            proposal_id: Some("p".to_string()),
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
    let v1 = project_row(&id, "Todo", TS0, TS1, None);
    let v2 = project_row(&id, "Todo", TS0, TS2, Some(TS2));
    let rename = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::Projects,
        key: vec![id.clone()],
        before: v0.clone(),
        after: v1.clone(),
        expected: BTreeMap::from([(
            "record".to_string(),
            expected_for(EntityKind::Projects, "record", &[id.clone()], &v0),
        )]),
        review_proof: None,
    });
    let mut archive_expected = BTreeMap::new();
    archive_expected.insert(
        "lifecycle".to_string(),
        ExpectedFacet {
            event_ref: Some(known_ref_b()),
            before_hash: hash_hex(
                &facet_state_hash(EntityKind::Projects, "lifecycle", &[id.clone()], &v1).unwrap(),
            ),
        },
    );
    let archive = Operation::FacetUpdate(FacetUpdate {
        entity: EntityKind::Projects,
        key: vec![id.clone()],
        before: v1,
        after: v2,
        expected: archive_expected,
        review_proof: None,
    });
    let event = sample_event(vec![rename, archive], vec![]);
    let bytes = encode_canonical(&event).unwrap();
    let decoded = decode_core_strict(&bytes).unwrap();
    assert_eq!(decoded, event);
    assert_eq!(encode_canonical(&decoded).unwrap(), bytes);
}
