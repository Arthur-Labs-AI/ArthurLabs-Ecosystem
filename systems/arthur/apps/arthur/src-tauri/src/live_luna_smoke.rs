//! LIVE GPT-6 Luna compatibility smoke tests: three real, paid OpenAI requests with SYNTHETIC text only (one per migrated role).
//! Never part of the default suite (`#[ignore]`). It is an API-compatibility check, not an accuracy benchmark.
//!
//! ```text
//! ARTHUR_LUNA_LIVE_SMOKE=yes ARTHUR_OPENAI_API_KEY=<key> cargo test --offline --lib live_luna_smoke::distillation -- --ignored --nocapture --test-threads=1
//! ```
//! (and `::synthesis`, `::stage_b`). The key is read from the environment into memory only and is never printed; the output is fixed
//! facts (status, models, effort, finish reason, token counts, cost, validation flags) and, for the synthesis check, the synthetic revised
//! sentence. No retries, no fallback model, no database, no Graph writes.

use std::sync::Arc;
use std::time::Duration;

use crate::providers::chat::{last_call, LUNA_MODEL, LUNA_PRICE_IN, LUNA_PRICE_OUT};
use crate::providers::credentials::{ApiKey, CredentialSource};

struct EnvKey;
impl CredentialSource for EnvKey {
    fn api_key(&self) -> Option<ApiKey> {
        std::env::var("ARTHUR_OPENAI_API_KEY")
            .ok()
            .and_then(|raw| ApiKey::parse(&raw))
    }
}

/// The explicit authorization for ONE paid request. Anything but exactly `yes` keeps the test from touching the network, so running
/// the ignored tests by accident (`--ignored`, `--include-ignored`) cannot spend money. Checked BEFORE the key is even read.
const GATE: &str = "ARTHUR_LUNA_LIVE_SMOKE";

fn gate_open(value: Option<&str>) -> bool {
    value == Some("yes")
}

fn guard() {
    assert!(
        gate_open(std::env::var(GATE).ok().as_deref()),
        "set {GATE}=yes to confirm one paid request (synthetic text only)"
    );
    assert!(
        EnvKey.api_key().is_some(),
        "ARTHUR_OPENAI_API_KEY must hold a key"
    );
}

// --- the gate itself is tested WITHOUT any network or key (these run in the default suite) ---

#[test]
fn the_paid_requests_need_an_exact_explicit_yes() {
    assert!(gate_open(Some("yes")));
    for not_enough in [
        None,
        Some(""),
        Some("1"),
        Some("true"),
        Some("YES"),
        Some("Yes"),
        Some("yes "),
        Some("no"),
    ] {
        assert!(!gate_open(not_enough), "{not_enough:?}");
    }
}

#[test]
fn all_three_live_tests_are_ignored_by_default_and_check_the_gate_first_and_persist_nothing() {
    let source = include_str!("live_luna_smoke.rs");
    for name in ["distillation", "synthesis", "stage_b"] {
        // the definition at the start of a line (not this test's own mention of the names)
        let at = source
            .find(&format!("\nfn {name}() {{"))
            .unwrap_or_else(|| panic!("{name} exists"));
        let before = &source[..at];
        let attribute = before.rfind("#[test]").expect("a test attribute");
        assert!(
            before[attribute..].contains("#[ignore"),
            "{name} must be #[ignore]d"
        );
        let body = &source[at..];
        let guard_at = body.find("guard();").expect("the gate is called");
        assert!(
            guard_at
                < body
                    .find("EnvKey")
                    .unwrap_or(usize::MAX)
                    .min(body.find("block_on").unwrap_or(usize::MAX)),
            "{name}: the gate comes before any key use or request"
        );
    }
    // nothing is written to disk and no secret is embedded
    let code: String = source
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    // (needles are assembled so this test does not match itself)
    for persisting in [
        ["fs::", "write"].concat(),
        ["File::", "create"].concat(),
        ["Open", "Options"].concat(),
        ["to_", "writer"].concat(),
    ] {
        let own_lines = code.lines().filter(|l| l.contains("concat()")).count();
        assert_eq!(
            code.matches(persisting.as_str()).count(),
            0,
            "the smoke tests must not persist anything: {persisting} ({own_lines})"
        );
    }
    assert!(
        !source.contains(&["sk-", "proj-"].concat()) && !source.contains(&["Bearer", " "].concat())
    );
}

fn report(test: &str, effort: &str, pass: bool, checks: &[(&str, bool)]) {
    let record = last_call::take().unwrap_or_default();
    let (input, output, reasoning) = (
        record.prompt_tokens.unwrap_or(0),
        record.completion_tokens.unwrap_or(0),
        record.reasoning_tokens,
    );
    let cost = input as f64 * LUNA_PRICE_IN + output as f64 * LUNA_PRICE_OUT;
    println!("==== {test}: {}", if pass { "PASS" } else { "FAIL" });
    println!("  http status        : {:?}", record.status);
    println!("  requested model    : {LUNA_MODEL}");
    println!("  returned model     : {:?}", record.model);
    println!("  reasoning effort   : {effort}");
    println!("  finish reason      : {:?}", record.finish_reason);
    println!(
        "  tokens in/out/reas : {input} / {output} / {reasoning:?}  (output includes reasoning)"
    );
    println!("  estimated cost USD : {cost:.6}");
    for (name, ok) in checks {
        println!(
            "  check {:<44}: {}",
            name,
            if *ok { "ok" } else { "FAILED" }
        );
    }
    if !pass || record.status.is_some_and(|s| !(200..300).contains(&s)) {
        println!(
            "  provider error     : message={:?} param={:?}",
            record.error_message, record.error_param
        );
    }
}

#[test]
#[ignore = "one real paid request; see the module docs"]
fn distillation() {
    guard();
    use crate::distillation::openai::OpenAiDistiller;
    use crate::distillation::{resolve, Distiller};
    const CAPTURE: &str = "Arthur is a mobile application that stores notes locally.";
    let distiller = OpenAiDistiller::new(Arc::new(EnvKey)).expect("client");
    let outcome = tauri::async_runtime::block_on(distiller.distill(CAPTURE));
    let (mut strict_json, mut spans_resolve, mut fields_valid) = (false, false, false);
    if let Ok(candidates) = &outcome {
        strict_json = true; // parse_candidates is a deny-unknown-fields parse of the strict schema
        fields_valid = !candidates.is_empty()
            && candidates.iter().all(|c| {
                !c.title.trim().is_empty()
                    && !c.body.trim().is_empty()
                    && !c.evidence.trim().is_empty()
                    && crate::identity::KINDS.contains(&c.kind.as_str())
            });
        spans_resolve = resolve::resolve_candidates(CAPTURE, candidates.clone()).is_ok();
        println!("  objects returned   : {}", candidates.len());
    } else {
        println!(
            "  error              : {:?}",
            outcome.as_ref().err().map(|e| e.code())
        );
    }
    let record = last_call::LAST.lock().unwrap().clone().unwrap_or_default();
    let complete = record.finish_reason.as_deref() == Some("stop");
    let model_ok = record
        .model
        .as_deref()
        .is_some_and(|m| crate::providers::chat::model_matches(m, LUNA_MODEL));
    let pass =
        outcome.is_ok() && strict_json && fields_valid && spans_resolve && complete && model_ok;
    report(
        "1 distillation",
        "none",
        pass,
        &[
            ("strict JSON parsed", strict_json),
            ("expected fields valid", fields_valid),
            ("evidence resolves to exact spans", spans_resolve),
            ("finished with `stop` (no truncation)", complete),
            ("returned model is the requested model", model_ok),
        ],
    );
    assert!(pass);
}

#[test]
#[ignore = "one real paid request; see the module docs"]
fn synthesis() {
    guard();
    use crate::synthesis::authorization::{ProviderAuthorization, Purpose};
    use crate::synthesis::openai::OpenAiRevisionSynthesizer;
    use crate::synthesis::validate::validate_draft;
    use crate::synthesis::{
        ChangeClass, RevisionSynthesizer, SourceRef, SynthesisRequest, BASE_SOURCE, NEW_SOURCE,
    };
    let request = SynthesisRequest {
        kind: "idea".into(),
        title: "Mobile".into(),
        base_body: "Arthur is a mobile application.".into(),
        change: ChangeClass::Additive,
        sources: vec![SourceRef {
            id: "s1".into(),
            quote: "Arthur is a mobile application.".into(),
            capture_id: "synthetic".into(),
            start: 0,
            end: 31,
            key: None,
        }],
        claim_title: "Desktop".into(),
        claim_body: "Arthur will also support desktop.".into(),
        claim_quote: "Arthur will also support desktop".into(),
    };
    let synthesizer = OpenAiRevisionSynthesizer::new(
        Arc::new(EnvKey),
        Arc::new(ProviderAuthorization::in_memory(
            "openai",
            Purpose::Synthesis,
            true,
        )),
        Duration::from_secs(90),
    )
    .expect("client")
    .single_attempt();
    let outcome = tauri::async_runtime::block_on(synthesizer.synthesize(&request));
    let (mut schema_ok, mut ids_ok, mut deterministic_ok, mut preserves_mobile, mut adds_desktop) =
        (false, false, false, false, false);
    match &outcome {
        Ok(draft) => {
            schema_ok = true; // parse_draft is an exact-keys, typed parse of the strict schema
            let known = [BASE_SOURCE, "s1", NEW_SOURCE];
            ids_ok = draft
                .retained
                .iter()
                .chain(&draft.added)
                .chain(&draft.withdrawn)
                .all(|a| known.contains(&a.source.as_str()));
            deterministic_ok = validate_draft(&request, draft, LUNA_MODEL).is_ok();
            let body = draft.revised_body.to_lowercase();
            preserves_mobile = body.contains("mobile");
            adds_desktop = body.contains("desktop");
            println!("  synthetic revision : {:?}", draft.revised_body);
            println!(
                "  change/assertions  : {} / retained {} added {} withdrawn {}",
                draft.change.as_str(),
                draft.retained.len(),
                draft.added.len(),
                draft.withdrawn.len()
            );
            if let Err(veto) = validate_draft(&request, draft, LUNA_MODEL) {
                println!("  deterministic veto : {veto:?}");
            }
        }
        Err(failure) => println!("  error              : {failure:?}"),
    }
    let record = last_call::LAST.lock().unwrap().clone().unwrap_or_default();
    let complete = record.finish_reason.as_deref() == Some("stop");
    let model_ok = record
        .model
        .as_deref()
        .is_some_and(|m| crate::providers::chat::model_matches(m, LUNA_MODEL));
    let usage = synthesizer.usage();
    println!(
        "  adapter requests   : {} (retries {})",
        usage.requests, usage.retries
    );
    let pass = outcome.is_ok()
        && schema_ok
        && ids_ok
        && deterministic_ok
        && complete
        && model_ok
        && usage.requests == 1;
    report(
        "2 revision synthesis",
        "low",
        pass,
        &[
            ("strict structured response parsed", schema_ok),
            ("evidence ids are server-issued", ids_ok),
            (
                "deterministic validation (no unsupported fact)",
                deterministic_ok,
            ),
            ("keeps mobile", preserves_mobile),
            ("adds desktop", adds_desktop),
            ("finished with `stop` (no truncation)", complete),
            ("returned model is the requested model", model_ok),
        ],
    );
    assert!(pass);
}

#[test]
#[ignore = "one real paid request; see the module docs"]
fn stage_b() {
    guard();
    use crate::graph::openai::OpenAiRelationVerifier;
    use crate::graph::verify::{Presentation, RelationVerifier, VerifyCandidate};
    use crate::storage::knowledge_store::{KnowledgeObject, Provenance};
    const FIRST: &str = "11111111-1111-4111-8111-111111111111";
    const SECOND: &str = "22222222-2222-4222-8222-222222222222";
    let object = |id: &str, title: &str, body: &str| KnowledgeObject {
        id: id.into(),
        kind: "task".into(),
        title: title.into(),
        body: body.into(),
        created_at: "2026-10-04T10:00:00Z".into(),
        provenance: Provenance {
            capture_id: "synthetic".into(),
            source_start: 0,
            source_end: 1,
        },
        project_id: "synthetic".into(),
    };
    let candidate = VerifyCandidate {
        index: 0,
        source: object(
            FIRST,
            "Export invoices as PDF",
            "The invoice PDF export needs the billing database schema to exist first.",
        ),
        target: object(
            SECOND,
            "Create the billing database schema",
            "Design and create the tables for invoices and payments.",
        ),
        kind: "depends_on".into(),
        source_written_at: None,
        target_written_at: None,
    };
    let verifier = OpenAiRelationVerifier::new(Arc::new(EnvKey)).expect("client");
    let outcome =
        tauri::async_runtime::block_on(verifier.verify(&[candidate], Presentation::LowerIdFirst));
    let (mut parsed, mut policy_valid, mut ids_known) = (false, false, false);
    if let Ok(verdicts) = &outcome {
        parsed = verdicts.len() == 1; // parse_verdicts: deny-unknown-fields, exact index set, decision and kind enums, signal/evidence contract
        policy_valid = verdicts.iter().all(|v| {
            [
                "depends_on",
                "extends",
                "related_to",
                "contradicts",
                "derived_from",
                "duplicates",
                "supersedes",
                "none",
            ]
            .contains(&v.kind.as_str())
                || v.kind.is_empty()
        });
        ids_known = verdicts.iter().all(|v| {
            [FIRST, SECOND].contains(&v.source_object_id.as_str())
                && [FIRST, SECOND].contains(&v.target_object_id.as_str())
        });
        for v in verdicts {
            println!("  verdict            : decision={:?} kind={} confidence={:?} forward={:?} reverse={:?} explicit={}", v.decision, v.kind, v.confidence, v.forward_support, v.reverse_support, v.explicit_link);
        }
    } else {
        println!(
            "  error              : {:?}",
            outcome.as_ref().err().map(|e| e.code())
        );
    }
    let record = last_call::LAST.lock().unwrap().clone().unwrap_or_default();
    let complete = record.finish_reason.as_deref() == Some("stop");
    let model_ok = record
        .model
        .as_deref()
        .is_some_and(|m| crate::providers::chat::model_matches(m, LUNA_MODEL));
    let pass = outcome.is_ok() && parsed && policy_valid && ids_known && complete && model_ok;
    report(
        "3 automatic connections stage B",
        "none",
        pass,
        &[
            ("strict JSON parsed by the production parser", parsed),
            ("relation kind valid", policy_valid),
            ("object ids are the two sent", ids_known),
            ("finished with `stop` (no truncation)", complete),
            ("returned model is the requested model", model_ok),
        ],
    );
    assert!(pass);
}
