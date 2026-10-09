//! The synthesis boundary stays a boundary: no database access, no Graph or Recall, no commands, and nothing that ships constructs it.

const FILES: [(&str, &str); 11] = [
    ("mod.rs", include_str!("mod.rs")),
    ("authorization.rs", include_str!("authorization.rs")),
    ("openai.rs", include_str!("openai.rs")),
    ("prompt.rs", include_str!("prompt.rs")),
    ("stage.rs", include_str!("stage.rs")),
    ("validate.rs", include_str!("validate.rs")),
    ("verifier.rs", include_str!("verifier.rs")),
    ("fake.rs", include_str!("fake.rs")),
    ("openai_verifier.rs", include_str!("openai_verifier.rs")),
    ("verdict.rs", include_str!("verdict.rs")),
    ("tests.rs", include_str!("tests.rs")),
];

#[test]
fn synthesis_imports_no_storage_graph_recall_command_or_ui_code() {
    let banned = [["rus", "qlite"].concat(), ["crate::", "storage"].concat(), ["crate::", "graph"].concat(), ["crate::", "commands"].concat(), ["tau", "ri::"].concat(), ["crate::", "jev"].concat()];
    for (name, source) in &FILES[..10] {
        for line in source.lines().filter(|line| !line.trim_start().starts_with("//")) {
            for word in &banned {
                assert!(!line.contains(word.as_str()), "{name}: `{line}` mentions `{word}`");
            }
        }
    }
}

#[test]
fn the_synthesizer_and_verifier_have_no_way_to_name_an_object_a_revision_or_a_span() {
    // Their whole vocabulary is text, assertions that cite server-issued source ids, and a verdict. Spot-check the types.
    let source = include_str!("mod.rs");
    for forbidden in ["object_id", "revision_id", "source_start", "source_end", "current_revision"] {
        let draft_and_verdict = &source[source.find("pub struct SynthesisDraft").unwrap()..];
        assert!(!draft_and_verdict.contains(forbidden), "SynthesisDraft/Verdict must not carry {forbidden}");
    }
}

#[test]
fn no_shipped_code_constructs_or_enables_synthesis() {
    for (name, source) in [
        ("lib.rs", include_str!("../lib.rs")),
        ("commands/distill.rs", include_str!("../commands/distill.rs")),
        ("commands/ai.rs", include_str!("../commands/ai.rs")),
        ("commands/integration.rs", include_str!("../commands/integration.rs")),
        ("distillation/mod.rs", include_str!("../distillation/mod.rs")),
    ] {
        for word in ["OpenAiRevisionSynthesizer", "SynthesisStage", "ProviderAuthorization", "UnconfiguredVerifier", "synthesis::"] {
            assert!(!source.contains(word), "{name} mentions {word}");
        }
    }
}

#[test]
fn the_real_synthesis_endpoint_is_only_reachable_through_the_production_constructor() {
    let source = include_str!("openai.rs");
    assert_eq!(source.matches("DEFAULT_ENDPOINT.to_string()").count(), 1, "one place chooses the endpoint");
    assert!(source.contains("#[cfg(test)]\n    pub fn for_test"), "the test constructor is test-only");
}

#[test]
fn no_glm_or_zai_provider_exists_anywhere_in_shipped_code_or_manifests() {
    let needles = [["api.", "z.ai"].concat(), ["g", "lm"].concat(), ["zh", "ipu"].concat(), ["Za", "i"].concat(), ["ZA", "I_"].concat(), ["z", "ai\""].concat()];
    let others = [("registry.rs", include_str!("../providers/registry.rs")), ("secrets.rs", include_str!("../providers/secrets.rs")), ("Cargo.toml", include_str!("../../Cargo.toml"))];
    for (name, source) in FILES[..10].iter().chain(others.iter()) {
        let lower = source.to_lowercase();
        for needle in &needles {
            assert!(!lower.contains(&needle.to_lowercase()) || needle == &["Za", "i"].concat() && !source.contains(needle.as_str()), "{name} mentions `{needle}`");
        }
    }
}

#[test]
fn a_same_family_pass_is_wired_to_hold_for_review_and_the_shipped_verifier_is_not_called_independent() {
    let stage = include_str!("stage.rs");
    assert!(stage.contains("Verdict::Pass if self.mode == VerificationMode::SameFamilyReview => Err(\"review_required\")"));
    let verifier = include_str!("openai_verifier.rs");
    assert!(verifier.contains("NOT AN INDEPENDENT VERIFIER") && verifier.contains("family: FAMILY") && verifier.contains("pub const FAMILY: &str = \"gpt\""));
    // nothing in the shipped composition root builds a verifier or a stage
    for (name, source) in [("lib.rs", include_str!("../lib.rs")), ("commands/mod.rs", include_str!("../commands/mod.rs"))] {
        for needle in [["OpenAiRevision", "Verifier"].concat(), ["Synthesis", "Stage"].concat()] {
            assert!(!source.contains(&needle), "{name} must not construct `{needle}`");
        }
    }
}
