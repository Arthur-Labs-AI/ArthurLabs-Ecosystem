//! Platform acceptance for M04B, run by hand on the target runtime (for Android: the emulator) against a REAL v6 database.
//!
//! `ARTHUR_ACCEPT_DB=<path to an arthur.db at schema v6> cargo test --lib recall_platform_acceptance -- --ignored --nocapture`
//!
//! On Android the test binary is cross-compiled and executed on the device with `adb`, so SQLite (with FTS5), the filesystem and the
//! allocator are the real Android ones. The embedding provider is the deterministic double (the device run needs no key and no
//! network), and the report says so; the live OpenAI path is exercised separately.

use std::sync::Arc;

use super::evidence::{LexicalStatus, RetrievalOutcome, SemanticStatus};
use super::service::{RecallService, INDEX_RUN_LIMIT};
use super::settings::SemanticSettings;
use super::testing::{run, ConceptEmbedder, Lab};
use crate::storage::capture_store::CaptureStore;

macro_rules! step {
    ($n:expr, $($arg:tt)*) => {{
        println!("ACCEPT step {:>2} OK  {}", $n, format!($($arg)*));
    }};
}

#[test]
#[ignore = "platform acceptance: needs ARTHUR_ACCEPT_DB (a real v6 database)"]
fn recall_platform_acceptance() {
    let source = std::env::var("ARTHUR_ACCEPT_DB").expect("ARTHUR_ACCEPT_DB");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("arthur.db");
    std::fs::copy(&source, &path).unwrap();
    let (version_before, objects_before, revisions_before, captures_before) =
        crate::storage::recall_store::database_facts_for_test(&path);
    assert_eq!(version_before, 6, "the acceptance needs a v6 database");

    // 1. The existing v6 database upgrades to v7.
    let store = CaptureStore::open(&path).unwrap();
    assert_eq!(
        crate::storage::recall_store::database_facts_for_test(&path),
        (7, objects_before, revisions_before, captures_before)
    );
    assert_eq!(
        store.recall_indexed_revision_count().unwrap(),
        revisions_before
    );
    store.recall_check_lexical_index().unwrap();
    step!(1, "v6 -> v7: {objects_before} objects, {revisions_before} revisions, {captures_before} captures preserved; FTS5 rows == revisions; integrity ok");

    let concepts = [
        ("offline", "nonet"),
        ("network", "net"),
        ("internet", "net"),
        ("telescop", "sky"),
        ("star", "sky"),
        ("звезд", "sky"),
    ];
    let embedder = Arc::new(ConceptEmbedder::new(128, &concepts));
    let settings = Arc::new(SemanticSettings::new(
        dir.path().join("recall").join("semantic.json"),
    ));
    let service = RecallService::new(embedder.clone(), settings);
    let lab = Lab { store };
    let ask = |q: &str, p: &str| run(service.retrieve(&lab.store, q, p)).unwrap();

    // 2. Lexical retrieval finds EXISTING current knowledge of the upgraded database.
    let existing = lab.store.list_knowledge_objects().unwrap();
    let probe = existing.iter().find_map(|o| {
        let word = o
            .title
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.chars().count() >= 6)
            .max_by_key(|w| w.chars().count())?;
        Some((o.clone(), word.to_string()))
    });
    if let Some((object, word)) = probe {
        let result = ask(&word, &object.project_id);
        assert!(
            result.evidence.iter().any(|e| e.object_id == object.id),
            "existing object '{}' not found by '{word}'",
            object.title
        );
        assert_eq!(result.diagnostics.lexical, LexicalStatus::Ok);
        step!(2, "existing object found lexically by '{word}' in its own project ({} objects in the database)", existing.len());
    } else {
        step!(
            2,
            "the database has no object with a long title word; existing-object probe skipped"
        );
    }

    // 3. Bulgarian, inflected and upper-case.
    let a = lab.project("Accept A");
    let b = lab.project("Accept B");
    let bg = lab.object(
        &a,
        "idea",
        "Мобилното приложение",
        "Идеята е приложението да започва със запис.",
    );
    lab.object(
        &b,
        "idea",
        "Мобилен оператор",
        "Да сменя мобилния оператор.",
    );
    for query in ["мобилните приложения", "ИДЕИТЕ", "идеята за запис"]
    {
        assert_eq!(
            ask(query, &a).evidence.first().map(|e| e.object_id.clone()),
            Some(bg.clone()),
            "{query}"
        );
    }
    step!(
        3,
        "Bulgarian inflections and upper case resolve to the right object"
    );

    // 4. Project scope isolates; a move changes it at once.
    let in_a = lab.object(&a, "idea", "Gamma ray detector", "Detect gamma rays.");
    let in_b = lab.object(&b, "idea", "Gamma ray notes", "Gamma rays are interesting.");
    assert_eq!(
        ask("gamma ray", &a)
            .evidence
            .iter()
            .map(|e| e.object_id.clone())
            .collect::<Vec<_>>(),
        [in_a.clone()]
    );
    assert_eq!(
        ask("gamma ray", &b)
            .evidence
            .iter()
            .map(|e| e.object_id.clone())
            .collect::<Vec<_>>(),
        [in_b.clone()]
    );
    lab.store.move_knowledge_object(&in_a, &b).unwrap();
    assert!(ask("gamma ray", &a).evidence.is_empty());
    assert!(ask("gamma ray", &b)
        .evidence
        .iter()
        .any(|e| e.object_id == in_a));
    step!(
        4,
        "scope isolates results; a moved object appears only in its new project"
    );

    // 5. Semantic OFF: zero embedding requests.
    let result = ask("gamma ray", &b);
    assert_eq!(
        (
            result.diagnostics.semantic,
            result.diagnostics.embedding_requests,
            result.diagnostics.uploaded_texts
        ),
        (SemanticStatus::Disabled, 0, 0)
    );
    assert!(
        run(service.index_pending(&lab.store, INDEX_RUN_LIMIT))
            .unwrap()
            .stopped_by_consent
    );
    assert_eq!((embedder.request_count(), embedder.text_count()), (0, 0));
    step!(
        5,
        "semantic OFF: 0 embedding requests, 0 uploaded texts (queries and indexer)"
    );

    // 6. Enable; background indexing; semantic paraphrase retrieval.
    let sky = lab.object(
        &b,
        "idea",
        "Stargazing",
        "Look at the stars on clear nights.",
    );
    lab.object(&b, "idea", "Cooking", "Pasta for dinner.");
    service.settings().set(service.model_key(), true).unwrap();
    let report = run(service.index_pending(&lab.store, INDEX_RUN_LIMIT)).unwrap();
    assert_eq!(report.remaining, Some(0));
    let semantic = ask("telescope", &b);
    assert_eq!(semantic.diagnostics.semantic, SemanticStatus::Ok);
    assert_eq!(semantic.evidence[0].object_id, sky);
    assert!(
        semantic.evidence[0].lexical.is_none() && semantic.evidence[0].semantic.is_some(),
        "found by meaning, not by words"
    );
    step!(6, "enabled; {} objects embedded in {} request(s); paraphrase 'telescope' -> 'Stargazing' via the semantic channel", report.embedded + report.adopted, report.embedding_requests);

    // 7. Edit the current object: the old vector is stale and rejected; re-embedding makes the new one usable.
    lab.edit(&sky, Some("Pasta night"), Some("Boil the pasta."));
    let before = embedder.request_count();
    let stale = ask("telescope", &b);
    assert!(
        stale.evidence.iter().all(|e| e.object_id != sky),
        "the stale vector must not match"
    );
    assert_eq!(
        embedder.request_count(),
        before + 1,
        "rejecting a stale vector cost no provider call (only the query embedding)"
    );
    assert_eq!(
        run(service.index_pending(&lab.store, INDEX_RUN_LIMIT))
            .unwrap()
            .embedded,
        1
    );
    assert_eq!(ask("pasta night", &b).evidence[0].object_id, sky);
    step!(
        7,
        "edit -> stale vector rejected without a provider call -> re-embedded -> usable"
    );

    // 8. Disable: query embedding stops at once, local vectors are ignored, lexical still works.
    let requests = embedder.request_count();
    let stored = lab.store.recall_stored_vector_count(None).unwrap();
    service.settings().set(service.model_key(), false).unwrap();
    let off = ask("telescope", &b);
    assert_eq!(off.diagnostics.semantic, SemanticStatus::Disabled);
    assert!(off.evidence.is_empty(), "the vectors are ignored");
    assert_eq!(embedder.request_count(), requests);
    assert!(
        run(service.index_pending(&lab.store, INDEX_RUN_LIMIT))
            .unwrap()
            .stopped_by_consent
    );
    assert_eq!(
        lab.store.recall_stored_vector_count(None).unwrap(),
        stored,
        "the vectors stay stored"
    );
    assert_eq!(ask("gamma ray", &b).outcome, RetrievalOutcome::Results);
    step!(8, "disabled: no new embedding requests, {stored} local vectors kept but ignored, lexical retrieval unaffected");

    println!("ACCEPT all 8 steps passed on {}", std::env::consts::OS);
}
