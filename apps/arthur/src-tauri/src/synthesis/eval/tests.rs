use super::metrics::Rate;
use super::report::{review_packet, table};
use super::runner::*;
use super::*;

fn files() -> [(&'static str, &'static str); 4] {
    [("dev_revision.json", DEV_REVISION), ("holdout_revision.json", HOLDOUT_REVISION), ("dev_identity.json", DEV_IDENTITY), ("holdout_identity.json", HOLDOUT_IDENTITY)]
}

#[test]
fn sha256_matches_the_published_test_vectors() {
    assert_eq!(sha256::hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert_eq!(sha256::hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert_eq!(sha256::hex(&[b'a'; 1000]), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
}

#[test]
fn the_corpus_is_frozen() {
    for (name, text) in files() {
        let line = CHECKSUMS.lines().find(|l| l.ends_with(name)).unwrap_or_else(|| panic!("{name} has no recorded checksum"));
        assert_eq!(line.split_whitespace().next().unwrap(), sha256::hex(text.as_bytes()), "{name} changed after it was frozen: record a new evaluation instead of editing the corpus");
    }
}

#[test]
fn dev_and_holdout_share_no_case_and_cover_every_language_and_class() {
    let (dev, hold): (Vec<RevCase>, Vec<RevCase>) = (load(DEV_REVISION), load(HOLDOUT_REVISION));
    for d in &dev {
        assert!(hold.iter().all(|h| h.id != d.id && (h.base != d.base || h.claim != d.claim)), "{} appears in both splits", d.id);
    }
    for set in [&dev, &hold] {
        for lang in ["en", "bg", "mixed", "unicode"] {
            assert!(set.iter().any(|c| c.lang == lang), "language {lang} missing");
        }
        assert!(set.iter().any(|c| c.label == "safe") && set.iter().any(|c| c.label == "unsafe"));
        assert!(set.iter().all(|c| (c.label == "unsafe") == c.unsafe_class.is_some()));
        assert!(set.iter().filter_map(|c| c.unsafe_class.as_deref()).all(|k| crate::synthesis::zai::CHECKS.iter().any(|(n, _)| *n == k)));
    }
}

fn evaluate(label: &str, revision: &[RevCase], identity: &[IdCase], out: &mut String) {
    out.push_str(&format!("### {label} ({} revision cases: {} safe / {} unsafe; {} identity cases)\n\n", revision.len(), revision.iter().filter(|c| c.label == "safe").count(), revision.iter().filter(|c| c.label == "unsafe").count(), identity.len()));
    out.push_str(&table("Identity gate with SCRIPTED classifier signals (policy check, not classifier accuracy)", &identity_rows(identity)));
    out.push_str(&table("Layer A — deterministic validator only (no model)", &revision_rows(&run_validator(revision), false)));
    for (name, mock) in [("oracle", Mock::Oracle), ("always-pass", Mock::AlwaysPass), ("garbage answers", Mock::Garbage), ("endpoint outage", Mock::Outage)] {
        let outcomes = run_with_mock_verifier(revision, mock);
        assert!(unavailable_is_never_accepted(&outcomes));
        if matches!(mock, Mock::Garbage | Mock::Outage) {
            assert!(outcomes.iter().all(|o| !o.accepted(true)), "{name}: nothing may be accepted when the verifier is unusable");
        }
        out.push_str(&table(&format!("Layer B — validator + real adapter over mock transport: {name} (plumbing, NOT model quality)"), &revision_rows(&outcomes, true)));
    }
    out.push_str("#### Layer C — real model (GLM `glm-5.3` via Z.ai)\n\nNOT RUN. No Z.ai credential or provider authorization exists; no paid request was made. No real-model metric is reported.\n\n");
}

#[test]
fn the_evaluation_runs_and_its_safety_invariants_hold() {
    let (dev, hold): (Vec<RevCase>, Vec<RevCase>) = (load(DEV_REVISION), load(HOLDOUT_REVISION));
    let (idev, ihold): (Vec<IdCase>, Vec<IdCase>) = (load(DEV_IDENTITY), load(HOLDOUT_IDENTITY));
    let mut report = String::from("## Evaluation output\n\n");
    evaluate("Dev split", &dev, &idev, &mut report);
    evaluate("Frozen holdout (evaluated once, nothing tuned to it)", &hold, &ihold, &mut report);
    // the identity gate must never revise anything the implementer expected to stay separate or uncertain
    for rows in [identity_rows(&idev), identity_rows(&ihold)] {
        assert_eq!(rows.get("identity false-revision rate (should not revise, did)").num, 0);
        assert_eq!(rows.get("incorrect-target rate (revised, wrong object)").num, 0);
    }
    if let Ok(dir) = std::env::var("ARTHUR_EVAL_WRITE") {
        assert!(!dir.contains("corpus") && !dir.contains("eval"), "reports are never written next to the frozen corpus");
        std::fs::write(format!("{dir}/m047b-phase4c-evaluation-output.md"), &report).unwrap();
        std::fs::write(format!("{dir}/m047b-phase4c-review-packet.md"), review_packet(&[("dev", &dev), ("holdout", &hold)], &[("dev", &idev), ("holdout", &ihold)])).unwrap();
    }
    assert!(Rate::of(1, 4).wilson().unwrap().0 < 0.25);
}

#[test]
fn rates_with_no_denominator_are_not_printed_as_percentages() {
    assert!(Rate::of(0, 0).show().contains("n/a"));
    let (lo, hi) = Rate::of(0, 20).wilson().unwrap();
    assert!(lo == 0.0 && hi > 0.1 && hi < 0.2, "zero of twenty is still compatible with ~16%: {hi}");
}

/// The only test that can spend money. It never runs by default: it needs `--ignored`, an explicit gate and a key in the environment, sends
/// at most one request per draft that passes the validator (both splits together are bounded below), and prints only counts.
#[test]
#[ignore = "paid: sends the corpus to Z.ai; needs ARTHUR_ZAI_EVAL=yes and ARTHUR_ZAI_API_KEY"]
fn real_model_verifier_evaluation() {
    use crate::synthesis::authorization::{ProviderAuthorization, Purpose};
    use crate::synthesis::zai::ZaiRevisionVerifier;
    use crate::synthesis::{RevisionVerifier, Verdict, VerifyRequest};
    use std::sync::Arc;
    if std::env::var("ARTHUR_ZAI_EVAL").as_deref() != Ok("yes") {
        return;
    }
    struct EnvKey;
    impl crate::providers::credentials::CredentialSource for EnvKey {
        fn api_key(&self) -> Option<crate::providers::credentials::ApiKey> {
            std::env::var("ARTHUR_ZAI_API_KEY").ok().and_then(|k| crate::providers::credentials::ApiKey::parse(&k))
        }
    }
    let mut all: Vec<RevCase> = load(DEV_REVISION);
    all.extend(load::<RevCase>(HOLDOUT_REVISION));
    let reaching: Vec<&RevCase> = all.iter().filter(|c| deterministic(c).is_ok()).collect();
    assert!(reaching.len() <= 60, "bounded: at most 60 paid requests");
    let verifier = ZaiRevisionVerifier::new(Arc::new(EnvKey), Arc::new(ProviderAuthorization::in_memory("zai", Purpose::Verification, true)), std::time::Duration::from_secs(120)).unwrap();
    let (mut false_pass, mut false_veto, mut unavailable, mut unsafe_n, mut safe_n) = (0, 0, 0, 0, 0);
    for c in reaching {
        let verdict = tauri::async_runtime::block_on(verifier.verify(&VerifyRequest { request: request_of(c), draft: draft_of(c) }));
        let safe = c.label == "safe";
        if safe { safe_n += 1 } else { unsafe_n += 1 }
        match verdict {
            Verdict::Pass if !safe => false_pass += 1,
            Verdict::Veto(_) if safe => false_veto += 1,
            Verdict::Unavailable(_) => unavailable += 1,
            _ => {}
        }
    }
    let usage = verifier.usage();
    println!("REAL-MODEL RESULT (labels are the implementer's): false-PASS {false_pass}/{unsafe_n}, false-VETO {false_veto}/{safe_n}, unavailable {unavailable}, requests {}, est. cost ${:.4}", usage.requests, usage.estimated_cost_usd);
}
