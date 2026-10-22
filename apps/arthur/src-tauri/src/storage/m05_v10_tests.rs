//! Dormant SQL proofs only: production remains v9. No JournalTx or codec exists here.
//!
//! Activation audit (Task 06): CaptureStore::from_connection enables FULL/FKs then
//! calls migrations::migrate before returning. NativeRuntime::acquire retains the
//! OS ownership guard through open_owned and only THEN publishes its Arc/Weak.
//! Future activation belongs inside from_connection: migrate with this exact SQL,
//! seal/init a fresh incarnation in a short transaction, establish journal-aware
//! store capability, THEN return/publish. Failure must close the unpublished owner.
//! No current constructor performs domain writes after migrate and before return;
//! lib.rs manages the returned runtime before constructing services/polling tasks.
//! All authoritative public writers and *_in composition seams must ship together.
//! Test-only open/open_in_memory must use that legitimate initialization too.
//!
//! Concrete direct SQL fixtures: storage/identity_store_tests.rs::sql locks the
//! connection and executes raw domain INSERT/UPDATE/DELETE constraint probes;
//! storage/migrations.rs builds latest/legacy fixtures with raw execute_batch.
//! Build historical fixtures at explicit v9 before candidate upgrade; wrap latest
//! constraint probes in a legitimate context so old guards, rather than missing
//! journal context, cause the expected rejection. Fault triggers in
//! storage/revision_cas_tests.rs, distillation/evolution_tests.rs and
//! synthesis/tests.rs need journal-aware outer writers. Shared store constructors
//! also feed storage/{evidence_store_tests,proposal_store_tests}.rs,
//! graph/integration_tests.rs and recall/testing.rs; their successful fixture
//! writes must use production journal-aware APIs after activation.
//! Preserve intentional multi-connection CAS fixtures, never disable observers.
//!
//! Codec review recommendation, NOT approved/installed: serde_jcs = "=0.1.0"
//! (edition 2018, serde/serde_json 1, ryu-js 0.2; no declared MSRV); SHA-256 via
//! RustCrypto sha2 = "=0.10.9" (edition 2018, digest 0.10.7, std, no asm feature).
//! Sources: https://docs.rs/crate/serde_jcs/0.1.0/source/Cargo.toml and
//! https://docs.rs/crate/sha2/0.10.9/source/Cargo.toml . Both MIT OR Apache-2.0.
//! Before selection review exact source/transitives/lock and maintenance/security,
//! compile with project Rust floor 1.89 and Windows MSVC + Android targets; metadata
//! alone proves neither MSRV nor platform compatibility. Pin reviewed features.
//! Independently verify RFC8785 UTF-16 key sorting (BMP vs astral), controls,
//! combining/Cyrillic/emoji unchanged, number vectors, -0/nonfinite/duplicate-key
//! rejection and decimal-string counters >2^53/i64 overflow. Compare bytes to an
//! independent RFC reference, then SHA-256 NIST vectors and domain-separated bundle
//! golden digests. sha2 0.10.9 is already transitive in the current lock; making
//! it a direct API dependency still requires review. No manifests/lock are changed.
//! Ordinary serde_json is used below ONLY for comparing SQL images;
//! synthetic bundle bytes/hashes are explicitly opaque placeholders, not JCS/hash
//! verification or authentication. No dependency or custom crypto is added.
//!
//! Candidate limits in m05_v10.sql/design still need native checked admission and
//! worst-case accepted-write/history/performance evidence: 4MiB core, 4096 effects,
//! 8MiB spool, 256MiB pending payloads, 32MiB/20000 initial snapshot, 256KiB chunks.
//! >256KiB exports need later authenticated atomic staging. SQL count/length tests
//! do not establish aggregate quotas; any quota error must roll back the save.

use super::capture_store::{CaptureStore, CreateCaptureInput};
use super::journal::codec::EntityKind;
use super::migrations::{self, INBOX_PROJECT_ID};
use rusqlite::{params, types::Value, Connection, Error, ErrorCode};
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const CANDIDATE: &str = include_str!("m05_v10.sql");
const NOW: &str = "2026-10-21T00:00:00Z";

const ENTITIES: [EntityKind; 12] = [
    EntityKind::Projects,
    EntityKind::Captures,
    EntityKind::DistillationRuns,
    EntityKind::KnowledgeObjects,
    EntityKind::ObjectSources,
    EntityKind::ThoughtRevisions,
    EntityKind::RevisionParents,
    EntityKind::Relations,
    EntityKind::IdentityDecisions,
    EntityKind::RevisionEvidence,
    EntityKind::PendingClaims,
    EntityKind::RevisionProposals,
];

// Independently extracted with `git show d7729aa8d7ef2f3924423234f038fe3fb112c735:.../migrations.rs`.
// A standalone rustc program materialized those nine Rust literals as bytes;
// Node crypto hashed the resulting files. Expected values never use current SQL.
const LEGACY_SHA256: [&str; 9] = [
    "82d4b6446fa98a5c6238a22d2da7066d2395a50b08f0238df5c3f975014b692d",
    "322f019e9e2574b8d09600103ea40fe6d6baed79b9b82c0df12ba79769e04e10",
    "dd564e90b3bfda40f726264c2b9241c70f9ab51d45d9a1fb2d3e672f107c8aa0",
    "e1520b053b7247bb918a547116f27a40e8ffda3d5336cdb5f6fa12d1b3ad26af",
    "0498f62d4cd58ce7f8a4c71b25eed87756f6781c03802b07d51da962df86fc97",
    "92bf0724e9886b9357844efb14ed1891741277af5750a54c59ec65f5b8f7091b",
    "2821b44269653fbe7bc4afa2d519454e47b07b4b7ce8eeb35adeb2073b7d3c2b",
    "afd1b293a3097fe5de09e20d5ca477cf5c5b846269690e11922e602809be0514",
    "bed6ec7af5168c01f7af4fa06735dcf7c5f255a2d1ead4c0a1f44afed7ba2da5",
];

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[test]
fn all_nine_legacy_migration_bytes_match_the_approved_starting_commit() {
    let sql = [
        migrations::SCHEMA_V1,
        migrations::SCHEMA_V2,
        migrations::SCHEMA_V3,
        migrations::SCHEMA_V4,
        migrations::SCHEMA_V5,
        migrations::SCHEMA_V6,
        migrations::SCHEMA_V7,
        migrations::SCHEMA_V8,
        migrations::SCHEMA_V9,
    ];
    for (index, (sql, expected)) in sql.iter().zip(LEGACY_SHA256).enumerate() {
        assert_eq!(
            digest(sql.as_bytes()),
            expected,
            "historical v{} bytes",
            index + 1
        );
        // Sensitivity control: even one appended whitespace byte must be caught.
        let mut changed = sql.as_bytes().to_vec();
        changed.push(b' ');
        assert_ne!(digest(&changed), expected, "v{} byte mutation", index + 1);
    }
}

fn id(n: u32) -> String {
    format!("{n:08x}-0000-4000-8000-000000000000")
}

fn scalar(c: &Connection, sql: &str) -> i64 {
    c.query_row(sql, [], |r| r.get(0)).unwrap()
}

fn v9() -> Connection {
    // Actual native setup, including the application's FULL/FK connection policy.
    let store = CaptureStore::open_in_memory().unwrap();
    let c = store.connection.into_inner().unwrap();
    assert_eq!(scalar(&c, "PRAGMA user_version"), 9);
    assert_eq!(scalar(&c, "PRAGMA foreign_keys"), 1);
    assert_eq!(scalar(&c, "PRAGMA synchronous"), 2);
    c
}

fn candidate_steps() -> Vec<migrations::Step> {
    let mut steps = migrations::STEPS.to_vec();
    steps.push((10, CANDIDATE));
    steps
}

fn install(c: &mut Connection) {
    migrations::migrate_with(c, &candidate_steps()).unwrap();
}

fn initialized() -> Connection {
    let mut c = v9();
    install(&mut c);
    initialize(&c);
    c
}

fn initialize(c: &Connection) {
    c.execute(
        "INSERT INTO sync_origins(origin_id,incarnation,status,opened_at) VALUES(?1,?2,'active',?3)",
        params![id(1), id(2), NOW],
    ).unwrap();
    c.execute(
        "INSERT INTO sync_local(singleton,origin_id,active_incarnation) VALUES(1,?1,?2)",
        params![id(1), id(2)],
    )
    .unwrap();
}

fn begin(c: &Connection, event: u32) {
    assert!(c.is_autocommit());
    c.execute_batch("BEGIN IMMEDIATE").unwrap();
    c.execute(
        "INSERT INTO sync_write_context(singleton,event_id) VALUES(1,?1)",
        [id(event)],
    )
    .unwrap();
}

fn capture(c: &Connection, n: u32) -> rusqlite::Result<usize> {
    c.execute(
        "INSERT INTO captures(id,source,content,created_at,project_id) VALUES(?1,'text',?2,?3,?4)",
        params![id(n), "Идея 🦀 e\u{301}\u{1}", NOW, INBOX_PROJECT_ID],
    )
}

fn append(c: &Connection, event: u32, seq: i64) -> rusqlite::Result<usize> {
    // SQL structural proof ONLY. These bytes are deliberately NOT a valid core,
    // and these 32 bytes are NOT a computed digest. Native reducer/crypto must
    // validate them before production uses this SQL admission seam.
    c.execute(
        "INSERT INTO sync_bundles VALUES(?1,?2,?3,?4,?5,1,
          (SELECT effect_count FROM sync_write_context),?6,?7,
          (SELECT last_hash FROM sync_origins WHERE status='active'),?8)",
        params![
            id(event),
            id(event + 10000),
            id(1),
            id(2),
            seq,
            b"opaque SQL fixture; not a canonical core".as_slice(),
            [17u8; 32].as_slice(),
            NOW
        ],
    )
}

fn finish(c: &Connection) {
    c.execute_batch("DELETE FROM sync_effects; DELETE FROM sync_write_context; COMMIT")
        .unwrap();
    assert!(c.is_autocommit());
    assert_eq!(scalar(c, "SELECT count(*) FROM sync_write_context"), 0);
    assert_eq!(scalar(c, "SELECT count(*) FROM sync_effects"), 0);
    healthy(c);
}

fn healthy(c: &Connection) {
    assert_eq!(
        c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert!(!c
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .exists([])
        .unwrap());
}

fn rejects(c: &Connection, sql: &str, message: &str) {
    let err = c.execute_batch(sql).expect_err(sql);
    assert!(
        matches!(&err, Error::SqliteFailure(e, _) if e.code == ErrorCode::ConstraintViolation),
        "{sql}: {err}"
    );
    assert!(
        err.to_string().contains(message),
        "{sql}: {err}; expected {message}"
    );
}

// Read the explicitly versioned catalog embedded in the artifact, never discover
// new shareable fields. A separate native PRAGMA equality check detects drift.
fn catalog() -> Vec<(&'static str, Vec<&'static str>, Vec<&'static str>)> {
    CANDIDATE
        .lines()
        .filter_map(|line| {
            let parts: Vec<_> = line.strip_prefix("-- ")?.split(" | ").collect();
            (parts.len() == 3 && !parts[0].contains(' ')).then(|| {
                (
                    parts[0],
                    parts[1].split(',').collect(),
                    parts[2].split(',').collect(),
                )
            })
        })
        .collect()
}

fn fingerprint(c: &Connection) -> Vec<(String, Vec<Vec<Value>>)> {
    catalog()
        .iter()
        .map(|(table, keys, _)| {
            // Preserve every stored domain column, including device-local seq.
            // Catalog projection equality is checked independently below.
            let cols: Vec<String> = c
                .prepare(&format!("PRAGMA table_info({table})"))
                .unwrap()
                .query_map([], |r| r.get(1))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            let mut s = c
                .prepare(&format!(
                    "SELECT {} FROM {table} ORDER BY {}",
                    cols.join(","),
                    keys.join(",")
                ))
                .unwrap();
            let rows = s
                .query_map([], |r| {
                    (0..cols.len())
                        .map(|i| r.get::<_, Value>(i))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            (table.to_string(), rows)
        })
        .collect()
}

fn schema(c: &Connection) -> Vec<(String, String, Option<String>)> {
    c.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn counts(c: &Connection) -> Vec<i64> {
    ENTITIES
        .iter()
        .map(|e| scalar(c, &format!("SELECT count(*) FROM {}", e.as_str())))
        .collect()
}

fn names(c: &Connection, kind: &str, pattern: &str) -> BTreeSet<String> {
    c.prepare("SELECT name FROM sqlite_schema WHERE type=?1 AND name GLOB ?2")
        .unwrap()
        .query_map(params![kind, pattern], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn assert_exact_candidate_catalog(c: &Connection) {
    let set = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<BTreeSet<_>>();
    assert_eq!(
        names(c, "table", "sync_*"),
        set(&[
            "sync_origins",
            "sync_local",
            "sync_bundles",
            "sync_write_context",
            "sync_commit_fences",
            "sync_effects",
            "sync_entity_heads",
            "sync_snapshots",
            "sync_snapshot_rows",
        ])
    );
    assert_eq!(
        names(c, "index", "sync_*"),
        set(&[
            "sync_one_active_origin",
            "sync_effects_by_event",
            "sync_heads_by_event",
        ])
    );
    let expected_observers: BTreeSet<String> = ENTITIES
        .iter()
        .flat_map(|entity| {
            ["insert", "update", "delete"]
                .map(|op| format!("sync_observe_{}_{op}", entity.as_str()))
        })
        .collect();
    assert_eq!(names(c, "trigger", "sync_observe_*"), expected_observers);
    let guards = set(&[
        "sync_context_identity_fixed",
        "sync_fences_no_update",
        "sync_fences_no_delete",
        "sync_bundles_no_update",
        "sync_bundles_no_delete",
        "sync_bundle_admission",
        "sync_origin_cursor_guard",
        "sync_bundle_moves_tip",
        "sync_origin_identity_fixed",
        "sync_origin_seal_final",
        "sync_origins_no_delete",
        "sync_snapshot_rows_no_update",
        "sync_snapshot_rows_insert_pending",
        "sync_snapshot_rows_delete_aborted",
        "sync_snapshots_no_delete",
        "sync_snapshot_transition",
    ]);
    let actual = names(c, "trigger", "sync_*");
    assert_eq!(
        actual
            .difference(&expected_observers)
            .cloned()
            .collect::<BTreeSet<_>>(),
        guards
    );
    // Compare against the frozen independent typed catalog, not SQL comments alone.
    let expected: Vec<_> = ENTITIES
        .iter()
        .map(|entity| {
            (
                entity.as_str(),
                entity.key_fields().to_vec(),
                entity.all_fields().to_vec(),
            )
        })
        .collect();
    assert_eq!(catalog(), expected);
}

fn populated(c: &Connection) {
    // Real v9 invariants: immutable provenance, system evidence BEFORE descendant,
    // stale open proposal and a rejected terminal proposal, then archived project.
    c.execute_batch(&format!(r#"
        INSERT INTO projects(id,name,created_at,updated_at) VALUES('{p}','Synthetic project','{NOW}','{NOW}');
        INSERT INTO captures(id,source,content,created_at,project_id) VALUES
          ('{cap}','text','Идея 🦀 é','{NOW}','{p}'),('{cap2}','voice','Идея 🦀 é','{NOW}','{p}');
        INSERT INTO distillation_runs(capture_id,created_at) VALUES('{cap}','{NOW}'),('{cap2}','{NOW}');
        INSERT INTO knowledge_objects(id,kind,title,body,created_at,project_id)
          VALUES('{obj}','idea','Title','Идея 🦀 é','{NOW}','{p}');
        INSERT INTO object_sources VALUES('{obj}','{cap}',0,4);
        INSERT INTO thought_revisions(id,object_id,kind,title,body,origin,created_at,capture_id,source_start,source_end)
          VALUES('{root}','{obj}','idea','Title','Идея 🦀 é','initial','{NOW}','{cap}',0,4);
        UPDATE knowledge_objects SET current_revision_id='{root}' WHERE id='{obj}';
        INSERT INTO thought_revisions(id,object_id,kind,title,body,origin,created_at)
          VALUES('{sys}','{obj}','idea','Title','System body','system','{NOW}');
        INSERT INTO revision_parents VALUES('{sys}','{root}');
        INSERT INTO revision_evidence(revision_id,ordinal,object_id,capture_id,source_start,source_end,role,created_at)
          VALUES('{sys}',0,'{obj}','{cap}',0,4,'asserts','{NOW}');
        UPDATE knowledge_objects SET body='System body',current_revision_id='{sys}' WHERE id='{obj}';
    "#, p=id(10),cap=id(11),cap2=id(12),obj=id(13),root=id(14),sys=id(15))).unwrap();
    for ordinal in 0..2 {
        use super::proposal_store::{insert_proposal_in, EvidenceRef, NewProposal};
        let proposal = NewProposal {
            pending_claim_id: id(20 + ordinal),
            object_id: id(13),
            base_revision_id: id(15),
            change: "additive".into(),
            kind: "idea".into(),
            title: "Proposal".into(),
            proposed_body: "Draft".into(),
            retracts: None,
            evidence: vec![
                EvidenceRef {
                    role: "existing".into(),
                    capture_id: id(11),
                    start: 0,
                    end: 4,
                },
                EvidenceRef {
                    role: "claim".into(),
                    capture_id: id(12),
                    start: 0,
                    end: 4,
                },
            ],
            synthesis_model: "synthetic-synthesis".into(),
            verifier_model: "synthetic-verifier".into(),
            verification_mode: "same_family_review".into(),
            policy_version: "test".into(),
        };
        let evidence = serde_json::to_string(&proposal.evidence).unwrap();
        c.execute_batch(&format!(r#"
            INSERT INTO identity_decisions(capture_id,ordinal,outcome,policy_version,model_id,decided_by,vetoes_json,audit_json,decided_at)
              VALUES('{cap}',{ordinal},'uncertain','test','fake','gate','[]','{{"candidatesSent":["{obj}"],"excluded":[],"scores":[],"runs":1}}','{NOW}');
            INSERT INTO pending_claims(id,capture_id,ordinal,kind,title,body,source_start,source_end,candidate_ids_json,reasons_json,reframing,state,created_at,updated_at)
              VALUES('{claim}','{cap}',{ordinal},'idea','Pending','Draft',0,4,'["{obj}"]','[]',0,'open','{NOW}','{NOW}');
            INSERT INTO revision_proposals(id,pending_claim_id,object_id,base_revision_id,change,kind,title,proposed_body,evidence_json,synthesis_model,verifier_model,verification_mode,verification_status,policy_version,state,created_at,updated_at)
              VALUES('{proposal}','{claim}','{obj}','{sys}','additive','idea','Proposal','Draft','{evidence}','synthetic-synthesis','synthetic-verifier','same_family_review','passed','test','open','{NOW}','{NOW}');
        "#,cap=id(12),claim=id(20+ordinal),proposal=id(30+ordinal),obj=id(13),sys=id(15))).unwrap();
        // This native helper validates metadata before its idempotent lookup.
        // SQL above retains deterministic historical identities/timestamps.
        let (stored, created) = insert_proposal_in(c, &proposal).unwrap();
        assert!(!created);
        assert_eq!(stored.id, id(30 + ordinal));
        assert_eq!(stored.evidence, proposal.evidence);
    }
    c.execute_batch(&format!(r#"
        UPDATE revision_proposals SET state='rejected',reviewed_at='{NOW}',updated_at='{NOW}' WHERE id='{rejected}';
        INSERT INTO thought_revisions(id,object_id,kind,title,body,origin,created_at)
          VALUES('{child}','{obj}','idea','Title','User body','user_edit','{NOW}');
        INSERT INTO revision_parents VALUES('{child}','{sys}');
        UPDATE knowledge_objects SET body='User body',current_revision_id='{child}' WHERE id='{obj}';
        INSERT INTO thought_revisions(id,object_id,kind,title,body,origin,created_at)
          VALUES('{branch}','{obj}','idea','Branch','Independent branch','user_edit','{NOW}');
        INSERT INTO revision_parents VALUES('{branch}','{root}');
        INSERT INTO thought_revisions(id,object_id,kind,title,body,origin,created_at)
          VALUES('{merge}','{obj}','idea','Merged','Merged body','merge','{NOW}');
        INSERT INTO revision_parents VALUES('{merge}','{child}'),('{merge}','{branch}');
        INSERT INTO thought_revisions(id,object_id,kind,title,body,origin,created_at)
          VALUES('{correction}','{obj}','idea','Corrected','Correction body','system','{NOW}');
        INSERT INTO revision_parents VALUES('{correction}','{merge}');
        INSERT INTO revision_evidence(revision_id,ordinal,object_id,capture_id,source_start,source_end,role,retracts_revision_id,retracts_ordinal,interpretation_label,created_at)
          VALUES('{correction}',0,'{obj}','{cap}',5,9,'corrects','{sys}',0,'Идея 🦀 é','{NOW}');
        INSERT INTO thought_revisions(id,object_id,kind,title,body,origin,created_at)
          VALUES('{descendant}','{obj}','idea','Final','Final descendant','user_edit','{NOW}');
        INSERT INTO revision_parents VALUES('{descendant}','{correction}');
        UPDATE knowledge_objects SET title='Final',body='Final descendant',current_revision_id='{descendant}' WHERE id='{obj}';
        INSERT INTO knowledge_objects(id,kind,title,body,created_at,project_id)
          VALUES('{other}','idea','Other','🦀 é','{NOW}','{p}');
        INSERT INTO object_sources VALUES('{other}','{cap}',5,9);
        INSERT INTO thought_revisions(id,object_id,kind,title,body,origin,created_at,capture_id,source_start,source_end)
          VALUES('{other_root}','{other}','idea','Other','🦀 é','initial','{NOW}','{cap}',5,9);
        UPDATE knowledge_objects SET current_revision_id='{other_root}' WHERE id='{other}';
        INSERT INTO relations(id,kind,source_object_id,target_object_id,origin,created_at)
          VALUES('{relation}','related_to','{obj}','{other}','model','{NOW}');
        UPDATE projects SET archived_at='{NOW}',updated_at='{NOW}' WHERE id='{p}';
    "#,rejected=id(31),child=id(16),obj=id(13),sys=id(15),p=id(10),root=id(14),
        branch=id(17),merge=id(18),correction=id(40),descendant=id(41),cap=id(11),
        other=id(50),other_root=id(51),relation=id(52))).unwrap();
    healthy(c);
}

#[test]
fn production_v9_is_dormant_and_ordinary_native_saves_still_work() {
    assert_eq!(migrations::SCHEMA_VERSION, 9);
    assert_eq!(
        migrations::STEPS.iter().map(|s| s.0).collect::<Vec<_>>(),
        (1..=9).collect::<Vec<_>>()
    );
    assert!(migrations::STEPS
        .iter()
        .all(|(_, sql)| !sql.contains("sync_observe_")));
    assert!(migrations::STEPS
        .iter()
        .all(|(_, sql)| *sql != CANDIDATE && !sql.contains("CREATE TABLE sync_")));
    let store = CaptureStore::open_in_memory().unwrap();
    let saved = store
        .create(CreateCaptureInput {
            source: "text".into(),
            content: "ordinary native save 🦀".into(),
            project_id: None,
        })
        .unwrap();
    assert_eq!(saved.project_id, INBOX_PROJECT_ID);
    assert_eq!(store.query_i64_for_test("SELECT count(*) FROM captures"), 1);
    assert_eq!(store.query_i64_for_test("PRAGMA user_version"), 9);
    assert_eq!(
        store.query_i64_for_test("SELECT count(*) FROM sqlite_schema WHERE name LIKE 'sync_%'"),
        0
    );
}

#[test]
fn fresh_native_candidate_has_exact_closed_catalog_and_bundled_sqlite_features() {
    let mut c = v9();
    let old = schema(&c);
    install(&mut c);
    println!(
        "native bundled SQLite {} / rusqlite {}",
        rusqlite::version(),
        "0.40.2"
    );
    assert_eq!(scalar(&c, "PRAGMA user_version"), 10);
    assert_exact_candidate_catalog(&c);
    assert_eq!(
        scalar(
            &c,
            "SELECT count(*) FROM pragma_table_list WHERE name LIKE 'sync_%' AND strict=1"
        ),
        9
    );
    assert_eq!(scalar(&c, "SELECT count(*) FROM sqlite_schema WHERE type='trigger' AND name LIKE 'sync_observe_%'"), 36);
    assert_eq!(
        scalar(
            &c,
            "SELECT count(*) FROM sqlite_schema WHERE type='trigger' AND name LIKE 'sync_%'"
        ),
        52
    );
    for (kind, name, sql) in old {
        assert!(
            schema(&c).contains(&(kind, name.clone(), sql)),
            "historical object changed: {name}"
        );
    }
    assert_eq!(catalog().len(), 12);
    for (table, _, cols) in catalog() {
        let actual: Vec<String> = c
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(Result::unwrap)
            .filter(|s| s != "seq")
            .collect();
        assert_eq!(actual, cols, "catalog schema drift: {table}");
    }
    assert_eq!(scalar(&c, "SELECT json_valid('{\"a\":[1,null]}')"), 1);
    rejects(
        &c,
        "INSERT INTO sync_local VALUES(1,'short','short',0)",
        "CHECK",
    );
    rejects(&c, &format!("INSERT INTO sync_origins(origin_id,incarnation,status,opened_at,last_seq) VALUES('{}','{}','active','now','bad')",id(1),id(2)), "INTEGER");
    rejects(
        &c,
        &format!("INSERT INTO sync_local VALUES(1,'{}','{}',0)", id(1), id(2)),
        "FOREIGN KEY",
    );
    for forbidden in [
        "sync_attestations",
        "sync_peer_progress",
        "sync_received",
        "sync_compaction_checkpoints",
    ] {
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name=?1",
                [forbidden],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
    healthy(&c);
}

#[test]
fn populated_upgrade_preserves_every_domain_value_and_historical_trigger() {
    let mut c = v9();
    populated(&c);
    let before = fingerprint(&c);
    let old_schema = schema(&c);
    let row_counts = counts(&c);
    assert_eq!(row_counts, vec![2, 2, 2, 2, 2, 8, 7, 1, 2, 2, 2, 2]);
    assert_eq!(
        c.query_row("SELECT content FROM captures WHERE id=?1", [id(11)], |r| {
            r.get::<_, String>(0)
        })
        .unwrap(),
        "Идея 🦀 e\u{301}"
    );
    assert_eq!(c.query_row("SELECT substr(c.content,e.source_start+1,e.source_end-e.source_start) FROM revision_evidence e JOIN captures c ON c.id=e.capture_id WHERE e.revision_id=?1", [id(40)], |r| r.get::<_, String>(0)).unwrap(), "🦀 e\u{301}");
    assert_eq!(scalar(&c, "SELECT count(*) FROM revision_parents p JOIN thought_revisions r ON r.id=p.child_revision_id WHERE r.origin='merge'"), 2);
    assert_eq!(scalar(&c, "SELECT count(*) FROM revision_proposals p JOIN knowledge_objects o ON o.id=p.object_id WHERE p.state='open' AND p.base_revision_id<>o.current_revision_id"), 1);
    assert_eq!(scalar(&c, "SELECT count(*) FROM revision_proposals WHERE state='rejected' AND reviewed_at IS NOT NULL"), 1);
    assert_eq!(
        scalar(
            &c,
            "SELECT count(*) FROM revision_evidence WHERE retracts_revision_id IS NOT NULL"
        ),
        1
    );
    assert_eq!(
        scalar(
            &c,
            "SELECT count(*) FROM projects WHERE archived_at IS NOT NULL"
        ),
        1
    );
    assert_eq!(
        scalar(
            &c,
            &format!("SELECT count(*) FROM projects WHERE id='{INBOX_PROJECT_ID}'")
        ),
        1
    );
    install(&mut c);
    assert_eq!(before, fingerprint(&c));
    assert_eq!(counts(&c), row_counts);
    let after = schema(&c);
    assert!(old_schema.iter().all(|row| after.contains(row)));
    for table in names(&c, "table", "sync_*") {
        assert_eq!(
            scalar(&c, &format!("SELECT count(*) FROM {table}")),
            0,
            "DDL fabricated {table} history"
        );
    }
    c.execute_batch(
        "INSERT INTO recall_revision_fts(recall_revision_fts,rank) VALUES('integrity-check',1)",
    )
    .unwrap();
    healthy(&c);
}

#[test]
fn candidate_ddl_and_version_bump_are_one_transaction_and_forward_only() {
    let mut c = v9();
    populated(&c);
    let before = fingerprint(&c);
    let old_schema = schema(&c);
    // Failure after ALL DDL, even after a version bump, is still rolled back.
    {
        let tx = c.transaction().unwrap();
        tx.execute_batch(CANDIDATE).unwrap();
        tx.pragma_update(None, "user_version", 10).unwrap();
        assert!(tx
            .execute_batch("SELECT missing_migration_fault_function()")
            .is_err());
        tx.rollback().unwrap();
    }
    assert_eq!(schema(&c), old_schema);
    assert_eq!(fingerprint(&c), before);
    assert_eq!(scalar(&c, "PRAGMA user_version"), 9);
    install(&mut c);
    let complete = schema(&c);
    let rows = fingerprint(&c);
    install(&mut c); // version-aware repeat is a no-op.
    assert_eq!(schema(&c), complete);
    assert_eq!(fingerprint(&c), rows);
    {
        let tx = c.transaction().unwrap();
        assert!(tx
            .execute_batch(CANDIDATE)
            .unwrap_err()
            .to_string()
            .contains("already exists"));
        tx.rollback().unwrap();
    }
    assert!(migrations::migrate(&mut c)
        .unwrap_err()
        .to_string()
        .contains("newer"));
    assert_eq!(schema(&c), complete);
    assert_eq!(fingerprint(&c), rows);
    assert_eq!(scalar(&c, "PRAGMA user_version"), 10);
    healthy(&c);
}

#[test]
fn actual_migrator_fault_boundaries_roll_back_all_ddl_and_retry_cleanly() {
    use migrations::MigrationFaultPoint::{AfterDdl, AfterVersionBump};
    // An in-memory suffix injects a late statement failure without editing or
    // maintaining a second copy of the authoritative candidate. Step's static
    // lifetime requires this one test-owned allocation to live until process exit.
    let late_ddl: &'static str =
        Box::leak(format!("{CANDIDATE}\nSELECT task09_late_ddl_fault();").into_boxed_str());
    for (fault, message) in [
        (None, "no such function: task09_late_ddl_fault"),
        (
            Some(AfterDdl),
            "injected AfterDdl: user_version=9, candidate_tables=9",
        ),
        (
            Some(AfterVersionBump),
            "injected AfterVersionBump: user_version=10, candidate_tables=9",
        ),
    ] {
        let mut c = v9();
        populated(&c);
        let before = fingerprint(&c);
        let old_schema = schema(&c);
        let error = if let Some(point) = fault {
            migrations::migrate_with_fault_for_test(&mut c, &candidate_steps(), 10, point)
        } else {
            let mut steps = migrations::STEPS.to_vec();
            steps.push((10, late_ddl));
            migrations::migrate_with(&mut c, &steps)
        }
        .unwrap_err();
        assert!(error.to_string().contains(message), "{fault:?}: {error}");
        assert!(c.is_autocommit(), "failed migrator left a transaction open");
        assert_eq!(scalar(&c, "PRAGMA user_version"), 9);
        assert_eq!(schema(&c), old_schema);
        assert_eq!(fingerprint(&c), before);
        assert!(names(&c, "table", "sync_*").is_empty());
        healthy(&c);
        // Also proves that the scoped fault cannot leak into the next attempt.
        install(&mut c);
        assert_eq!(scalar(&c, "PRAGMA user_version"), 10);
        assert_exact_candidate_catalog(&c);
        assert_eq!(fingerprint(&c), before);
        let installed = schema(&c);
        install(&mut c);
        assert_eq!(schema(&c), installed);
        assert_eq!(fingerprint(&c), before);
        healthy(&c);
    }
}

#[test]
fn late_name_collision_rolls_back_all_earlier_candidate_objects_and_preserves_v9() {
    let mut c = v9();
    populated(&c);
    c.execute_batch("CREATE TABLE sync_snapshot_rows(precious TEXT); INSERT INTO sync_snapshot_rows VALUES('keep me')").unwrap();
    let before = schema(&c);
    let data = fingerprint(&c);
    assert!(migrations::migrate_with(&mut c, &candidate_steps()).is_err());
    assert_eq!(schema(&c), before);
    assert_eq!(fingerprint(&c), data);
    assert_eq!(scalar(&c, "PRAGMA user_version"), 9);
    assert_eq!(
        c.query_row("SELECT precious FROM sync_snapshot_rows", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "keep me"
    );
    assert!(c.is_autocommit());
    healthy(&c);
    // Preserve the unexpected original object while removing only its name collision.
    c.execute_batch("ALTER TABLE sync_snapshot_rows RENAME TO task09_preserved_collision")
        .unwrap();
    install(&mut c);
    assert_eq!(fingerprint(&c), data);
    assert_eq!(
        c.query_row("SELECT precious FROM task09_preserved_collision", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "keep me"
    );
    assert_exact_candidate_catalog(&c);
    let complete = schema(&c);
    install(&mut c);
    assert_eq!(schema(&c), complete);
    healthy(&c);
}

#[test]
fn real_v9_guards_survive_candidate_and_observer_context() {
    let mut c = v9();
    populated(&c);
    install(&mut c);
    initialize(&c);
    begin(&c, 100);
    for sql in [
        format!("UPDATE projects SET name='changed' WHERE id='{INBOX_PROJECT_ID}'"),
        format!("DELETE FROM projects WHERE id='{INBOX_PROJECT_ID}'"),
        format!("UPDATE captures SET content='changed' WHERE id='{}'",id(11)),
        format!("INSERT INTO captures(id,source,content,created_at,project_id) VALUES('{}','text','bad','{NOW}','{}')",id(70),id(10)),
        format!("UPDATE thought_revisions SET body='changed' WHERE id='{}'",id(14)),
        "UPDATE revision_parents SET child_revision_id=child_revision_id".into(),
        "UPDATE identity_decisions SET decided_at=decided_at".into(),
        "DELETE FROM identity_decisions".into(),
        "UPDATE revision_evidence SET role=role".into(),
        "DELETE FROM revision_evidence".into(),
        format!("UPDATE pending_claims SET body='changed' WHERE id='{}'",id(20)),
        format!("UPDATE revision_proposals SET proposed_body='changed' WHERE id='{}'",id(30)),
        format!("UPDATE revision_proposals SET state='open' WHERE id='{}'",id(31)),
    ] {
        assert!(c.execute_batch(&sql).is_err(), "old guard accepted {sql}");
    }
    assert_eq!(scalar(&c, "SELECT effect_count FROM sync_write_context"), 0);
    c.execute_batch("ROLLBACK").unwrap();
    healthy(&c);
}

#[test]
fn missing_uninitialized_sealed_and_already_bundled_contexts_fail_safely() {
    let mut c = v9();
    install(&mut c);
    assert!(capture(&c, 200)
        .unwrap_err()
        .to_string()
        .contains("context missing"));
    begin(&c, 100);
    assert!(capture(&c, 200).is_err()); // context without initialized origin is insufficient.
    c.execute_batch("ROLLBACK").unwrap();
    initialize(&c);
    begin(&c, 100);
    c.execute(
        "UPDATE sync_origins SET status='sealed',sealed_at=?1",
        [NOW],
    )
    .unwrap();
    assert!(capture(&c, 200).is_err());
    c.execute_batch("ROLLBACK").unwrap();
    begin(&c, 100);
    capture(&c, 200).unwrap();
    append(&c, 100, 1).unwrap();
    assert!(capture(&c, 201)
        .unwrap_err()
        .to_string()
        .contains("already sealed"));
    finish(&c);
    assert_eq!(scalar(&c, "SELECT count(*) FROM captures"), 1);
}

#[test]
fn removing_context_cannot_evade_deferred_commit_fence_and_explicit_rollback() {
    let c = initialized();
    begin(&c, 100);
    capture(&c, 200).unwrap();
    assert_eq!(scalar(&c, "SELECT effect_count FROM sync_write_context"), 1);
    assert_eq!(scalar(&c, "SELECT count(*) FROM sync_commit_fences"), 1);
    c.execute_batch("DELETE FROM sync_effects; DELETE FROM sync_write_context")
        .unwrap();
    rejects(&c, "COMMIT", "FOREIGN KEY");
    assert!(!c.is_autocommit()); // SQLite leaves failed deferred COMMIT open.
    c.execute_batch("ROLLBACK").unwrap();
    for table in [
        "captures",
        "sync_commit_fences",
        "sync_effects",
        "sync_write_context",
        "sync_bundles",
    ] {
        assert_eq!(scalar(&c, &format!("SELECT count(*) FROM {table}")), 0);
    }
    assert_eq!(scalar(&c, "SELECT last_seq FROM sync_origins"), 0);
    healthy(&c);
}

#[test]
fn successful_structural_bundle_commits_all_effects_and_leaves_no_transient_rows() {
    let c = initialized();
    begin(&c, 100);
    capture(&c, 200).unwrap();
    capture(&c, 201).unwrap();
    assert_eq!(scalar(&c, "SELECT effect_count FROM sync_write_context"), 2);
    assert_eq!(scalar(&c, "SELECT count(*) FROM sync_commit_fences"), 1);
    append(&c, 100, 1).unwrap();
    finish(&c);
    assert_eq!(scalar(&c, "SELECT count(*) FROM captures"), 2);
    assert_eq!(scalar(&c, "SELECT count(*) FROM sync_bundles"), 1);
    assert_eq!(scalar(&c, "SELECT last_seq FROM sync_origins"), 1);
    // A structural FK pass expressly does NOT certify placeholder payload/hash.
}

#[test]
fn append_failure_rolls_back_domain_spool_fence_and_already_advanced_tip() {
    let c = initialized();
    // AFTER INSERT fault exercises rollback even when the other AFTER trigger may
    // have advanced the tip. Never depend on relative trigger execution ordering.
    c.execute_batch("CREATE TEMP TRIGGER append_fault AFTER INSERT ON sync_bundles BEGIN SELECT RAISE(ABORT,'injected append failure'); END").unwrap();
    begin(&c, 100);
    capture(&c, 200).unwrap();
    assert!(append(&c, 100, 1)
        .unwrap_err()
        .to_string()
        .contains("injected"));
    c.execute_batch("ROLLBACK; DROP TRIGGER append_fault")
        .unwrap();
    for table in [
        "captures",
        "sync_effects",
        "sync_commit_fences",
        "sync_write_context",
        "sync_bundles",
    ] {
        assert_eq!(scalar(&c, &format!("SELECT count(*) FROM {table}")), 0);
    }
    assert_eq!(scalar(&c, "SELECT last_seq FROM sync_origins"), 0);
    begin(&c, 101);
    capture(&c, 201).unwrap();
    append(&c, 101, 1).unwrap();
    finish(&c);
    begin(&c, 102);
    capture(&c, 202).unwrap();
    append(&c, 102, 2).unwrap();
    c.execute_batch("ROLLBACK").unwrap(); // explicit failure AFTER successful append.
    assert_eq!(scalar(&c, "SELECT last_seq FROM sync_origins"), 1);
    assert_eq!(scalar(&c, "SELECT count(*) FROM captures"), 1);
    healthy(&c);
}

#[test]
fn same_value_real_membership_updates_have_no_effects_fences_or_sequence() {
    let c = initialized();
    begin(&c, 100);
    capture(&c, 200).unwrap();
    append(&c, 100, 1).unwrap();
    finish(&c);
    begin(&c, 101);
    c.execute(
        "UPDATE captures SET project_id=project_id WHERE id=?1",
        [id(200)],
    )
    .unwrap();
    assert_eq!(scalar(&c, "SELECT effect_count FROM sync_write_context"), 0);
    assert_eq!(scalar(&c, "SELECT count(*) FROM sync_effects"), 0);
    finish(&c);
    assert_eq!(scalar(&c, "SELECT count(*) FROM sync_commit_fences"), 1);
    assert_eq!(scalar(&c, "SELECT last_seq FROM sync_origins"), 1);
}

#[test]
fn real_claim_resolution_trigger_supersession_is_observed_exactly_once() {
    let mut c = v9();
    populated(&c);
    install(&mut c);
    initialize(&c);
    begin(&c, 100);
    c.execute_batch(&format!(r#"
        UPDATE projects SET archived_at=NULL WHERE id='{p}';
        INSERT INTO knowledge_objects(id,kind,title,body,created_at,project_id)
          VALUES('{obj}','idea','Separate','Draft','{NOW}','{p}');
        INSERT INTO object_sources VALUES('{obj}','{cap}',0,4);
        INSERT INTO thought_revisions(id,object_id,kind,title,body,origin,created_at,capture_id,source_start,source_end)
          VALUES('{rev}','{obj}','idea','Separate','Draft','initial','{NOW}','{cap}',0,4);
        UPDATE knowledge_objects SET current_revision_id='{rev}' WHERE id='{obj}';
        UPDATE pending_claims SET state='separated',resolved_at='{NOW}',resolved_method='user',
          resolved_object_id='{obj}',updated_at='{NOW}' WHERE id='{claim}';
    "#,p=id(10),obj=id(60),cap=id(12),rev=id(61),claim=id(20))).unwrap();
    let effects: Vec<String> = c
        .prepare("SELECT after_json FROM sync_effects WHERE entity_kind='revision_proposals'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(effects.len(), 1);
    let row: Json = serde_json::from_str(&effects[0]).unwrap();
    assert_eq!(row["id"], id(30));
    assert_eq!(row["state"], "superseded");
    assert_eq!(row["reviewed_at"], NOW);
    append(&c, 100, 1).unwrap();
    finish(&c);
}

#[test]
fn immutable_bundle_fence_context_and_origin_guards_reject_all_forbidden_operations() {
    let c = initialized();
    begin(&c, 100);
    rejects(
        &c,
        "UPDATE sync_write_context SET event_id=event_id",
        "identity is fixed",
    );
    rejects(
        &c,
        "UPDATE sync_write_context SET singleton=singleton",
        "identity is fixed",
    );
    capture(&c, 200).unwrap();
    append(&c, 100, 1).unwrap();
    finish(&c);
    for (sql, msg) in [
        (
            "UPDATE sync_bundles SET committed_at=committed_at",
            "bundle is immutable",
        ),
        ("DELETE FROM sync_bundles", "compaction is not enabled"),
        (
            "UPDATE sync_commit_fences SET event_id=event_id",
            "fence is immutable",
        ),
        ("DELETE FROM sync_commit_fences", "fence cannot be deleted"),
        (
            "UPDATE sync_origins SET last_seq=last_seq+1",
            "cursor must advance",
        ),
        (
            "UPDATE sync_origins SET last_hash=zeroblob(32)",
            "cursor must advance",
        ),
        (
            "UPDATE sync_origins SET origin_id=origin_id",
            "identity is immutable",
        ),
        (
            "UPDATE sync_origins SET incarnation=incarnation",
            "identity is immutable",
        ),
        (
            "UPDATE sync_origins SET opened_at=opened_at",
            "identity is immutable",
        ),
        ("DELETE FROM sync_origins", "seals must be retained"),
        ("UPDATE sync_origins SET status='active'", "sealed once"),
    ] {
        rejects(&c, sql, msg);
    }
    c.execute(
        "UPDATE sync_origins SET status='sealed',sealed_at=?1",
        [NOW],
    )
    .unwrap();
    rejects(
        &c,
        "UPDATE sync_origins SET status='active',sealed_at=NULL",
        "sealed once",
    );
    rejects(
        &c,
        "UPDATE sync_origins SET sealed_at=sealed_at",
        "sealed once",
    );
    rejects(
        &c,
        "UPDATE sync_origins SET last_seq=2",
        "cursor must advance",
    );
    healthy(&c);
}

#[test]
fn bundle_admission_prevents_gaps_reuse_wrong_predecessor_and_incomplete_counts() {
    let c = initialized();
    begin(&c, 100);
    capture(&c, 200).unwrap();
    assert!(append(&c, 100, 2).is_err());
    assert!(append(&c, 100, 0).is_err());
    c.execute_batch("UPDATE sync_write_context SET effect_count=2")
        .unwrap();
    assert!(append(&c, 100, 1).is_err());
    c.execute_batch("UPDATE sync_write_context SET effect_count=1; DELETE FROM sync_effects")
        .unwrap();
    assert!(append(&c, 100, 1).is_err());
    c.execute_batch("ROLLBACK").unwrap();
    begin(&c, 101);
    capture(&c, 201).unwrap();
    append(&c, 101, 1).unwrap();
    finish(&c);
    begin(&c, 102);
    capture(&c, 202).unwrap();
    assert!(append(&c, 102, 1).is_err());
    rejects(&c,&format!("INSERT INTO sync_bundles VALUES('{}','{}','{}','{}',2,1,1,x'01',zeroblob(32),zeroblob(32),'{NOW}')",id(102),id(10102),id(1),id(2)),"not the active complete next");
    c.execute_batch("ROLLBACK").unwrap();
    assert_eq!(scalar(&c, "SELECT last_seq FROM sync_origins"), 1);
    healthy(&c);
}

#[test]
fn sql_effect_and_spool_limits_abort_the_entire_observed_statement() {
    for counter in ["effect_count=4096", "staged_bytes=8388608"] {
        let c = initialized();
        begin(&c, 100);
        c.execute_batch(&format!("UPDATE sync_write_context SET {counter}"))
            .unwrap();
        assert!(capture(&c, 200).unwrap_err().to_string().contains("CHECK"));
        assert_eq!(scalar(&c, "SELECT count(*) FROM captures"), 0);
        assert_eq!(scalar(&c, "SELECT count(*) FROM sync_effects"), 0);
        assert_eq!(scalar(&c, "SELECT count(*) FROM sync_commit_fences"), 0);
        c.execute_batch("ROLLBACK").unwrap();
        healthy(&c);
    }
}

#[test]
fn snapshot_rows_and_all_transition_guards_preserve_materialized_image() {
    let c = initialized();
    for n in [300, 301, 302] {
        c.execute("INSERT INTO sync_snapshots(snapshot_id,state,profile,requested_at) VALUES(?1,'pending','knowledge-v1-full',?2)",params![id(n),NOW]).unwrap();
    }
    let row_sql=format!("INSERT INTO sync_snapshot_rows VALUES('{}',0,'captures','[\"synthetic\"]',x'7b7d',zeroblob(32))",id(300));
    c.execute_batch("BEGIN IMMEDIATE").unwrap();
    c.execute_batch(&row_sql).unwrap();
    c.execute_batch("ROLLBACK").unwrap();
    assert_eq!(scalar(&c, "SELECT count(*) FROM sync_snapshot_rows"), 0);
    c.execute_batch(&row_sql).unwrap();
    rejects(
        &c,
        "UPDATE sync_snapshot_rows SET row_bytes=row_bytes",
        "rows are immutable",
    );
    rejects(&c, "DELETE FROM sync_snapshot_rows", "snapshot is retained");
    rejects(
        &c,
        "DELETE FROM sync_snapshots",
        "retirement needs reviewed",
    );
    for set in [
        "state='ready',manifest_bytes=x'01',manifest_hash=zeroblob(32)",
        "state='pending'",
        "snapshot_id='renamed',state='aborted'",
        "profile='other',state='aborted'",
        "requested_at='other',state='aborted'",
    ] {
        rejects(
            &c,
            &format!(
                "UPDATE sync_snapshots SET {set} WHERE snapshot_id='{}'",
                id(300)
            ),
            "invalid snapshot transition",
        );
    }
    c.execute("UPDATE sync_snapshots SET state='materialized',boundary_bytes=x'01',row_count=1,total_bytes=2 WHERE snapshot_id=?1",[id(300)]).unwrap();
    rejects(
        &c,
        &format!(
            "INSERT INTO sync_snapshot_rows VALUES('{}',1,'captures','[]',x'01',zeroblob(32))",
            id(300)
        ),
        "already materialized",
    );
    for set in ["boundary_bytes=x'02'", "row_count=2", "total_bytes=3"] {
        rejects(
            &c,
            &format!(
                "UPDATE sync_snapshots SET state='aborted',{set} WHERE snapshot_id='{}'",
                id(300)
            ),
            "invalid snapshot transition",
        );
    }
    c.execute("UPDATE sync_snapshots SET state='ready',manifest_bytes=x'01',manifest_hash=zeroblob(32) WHERE snapshot_id=?1",[id(300)]).unwrap();
    rejects(&c,&format!("UPDATE sync_snapshots SET state='aborted',manifest_bytes=NULL,manifest_hash=NULL WHERE snapshot_id='{}'",id(300)),"invalid snapshot transition");
    c.execute(
        "UPDATE sync_snapshots SET state='aborted' WHERE snapshot_id=?1",
        [id(301)],
    )
    .unwrap();
    rejects(
        &c,
        &format!(
            "UPDATE sync_snapshots SET state='aborted' WHERE snapshot_id='{}'",
            id(301)
        ),
        "invalid snapshot transition",
    );
    c.execute(
        "UPDATE sync_snapshots SET state='materialized',boundary_bytes=x'01' WHERE snapshot_id=?1",
        [id(302)],
    )
    .unwrap();
    c.execute(
        "UPDATE sync_snapshots SET state='aborted' WHERE snapshot_id=?1",
        [id(302)],
    )
    .unwrap();
    // Abort permits only transient row cleanup, never retained ready images.
    let abort = id(303);
    c.execute("INSERT INTO sync_snapshots(snapshot_id,state,profile,requested_at) VALUES(?1,'pending','knowledge-v1-full',?2)",params![abort,NOW]).unwrap();
    c.execute(
        "INSERT INTO sync_snapshot_rows VALUES(?1,0,'captures','[]',x'01',zeroblob(32))",
        [&abort],
    )
    .unwrap();
    c.execute(
        "UPDATE sync_snapshots SET state='aborted' WHERE snapshot_id=?1",
        [&abort],
    )
    .unwrap();
    c.execute(
        "DELETE FROM sync_snapshot_rows WHERE snapshot_id=?1",
        [&abort],
    )
    .unwrap();
    assert_eq!(scalar(&c, "SELECT count(*) FROM sync_snapshot_rows"), 1);
    healthy(&c);
}

fn projection_fixture(candidate: &'static str) -> (Connection, Connection) {
    let real = v9();
    let mut c = Connection::open_in_memory().unwrap();
    c.pragma_update(None, "foreign_keys", "ON").unwrap();
    // Dedicated projection-only fixture: immutable v9 history intentionally
    // forbids UPDATE/DELETE. Exercise those defensive observer bodies on isolated
    // typed projection tables, without dropping/disabling ANY historical trigger
    // in the real-v9 fixtures. This is structural coverage, not an import bypass.
    for (table, keys, cols) in catalog() {
        let info: Vec<(String, String)> = real
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap()
            .query_map([], |r| Ok((r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let defs: Vec<_> = cols
            .iter()
            .map(|col| {
                format!(
                    "{col} {}{}",
                    info.iter().find(|r| r.0 == *col).unwrap().1,
                    if keys.contains(col) { " NOT NULL" } else { "" }
                )
            })
            .collect();
        c.execute_batch(&format!("CREATE TABLE {table}({}) STRICT", defs.join(",")))
            .unwrap();
    }
    // Use same file/transaction/version seam, not a reconstructed observer copy.
    migrations::migrate_with(&mut c, &[(10, candidate)]).unwrap();
    initialize(&c);
    (real, c)
}

fn assert_accounting(c: &Connection, effects: i64) {
    assert_eq!(
        scalar(c, "SELECT effect_count FROM sync_write_context"),
        effects
    );
    assert_eq!(scalar(c, "SELECT count(*) FROM sync_effects"), effects);
    assert_eq!(scalar(c, "SELECT staged_bytes FROM sync_write_context"), scalar(c,
        "SELECT coalesce(sum(coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)),0) FROM sync_effects"));
    assert_eq!(
        scalar(c, "SELECT count(*) FROM sync_commit_fences"),
        i64::from(effects > 0)
    );
    assert_eq!(scalar(c, "SELECT count(*) FROM sync_effects WHERE event_id=(SELECT event_id FROM sync_write_context)"), effects);
    assert_eq!(scalar(c, "SELECT count(*) FROM sync_commit_fences WHERE event_id=(SELECT event_id FROM sync_write_context)"), i64::from(effects > 0));
}

fn observe_update(
    c: &Connection,
    table: &str,
    field: &str,
    keys: &[&str],
    before: &serde_json::Map<String, Json>,
    value: Value,
) -> serde_json::Map<String, Json> {
    let offset = scalar(c, "SELECT effect_count FROM sync_write_context");
    let mut after = before.clone();
    after.insert(
        field.to_string(),
        match &value {
            Value::Null => Json::Null,
            Value::Integer(n) => json!(n),
            Value::Text(s) => json!(s),
            other => panic!("unsupported projection fixture value {other:?}"),
        },
    );
    c.execute(&format!("UPDATE {table} SET {field}=?1"), [value])
        .unwrap();
    assert_eq!(
        scalar(c, "SELECT effect_count FROM sync_write_context"),
        offset + 1,
        "{table}.{field}: observed update count"
    );
    assert_effect(
        c,
        table,
        offset,
        Some(Json::Object(before.clone())),
        Some(Json::Object(after.clone())),
        keys,
    );
    assert_accounting(c, offset + 1);
    after
}

#[test]
fn all_36_observer_bodies_capture_exact_images_keys_nulls_and_noops_natively() {
    exercise_observer_bodies(CANDIDATE);
}

fn exercise_observer_bodies(candidate: &'static str) {
    let (real, c) = projection_fixture(candidate);
    for (index, (table, keys, cols)) in catalog().into_iter().enumerate() {
        begin(&c, 500 + index as u32);
        let info: Vec<(String, String)> = real
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap()
            .query_map([], |r| Ok((r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let mut expected = serde_json::Map::new();
        let values: Vec<Value> = cols
            .iter()
            .enumerate()
            .map(|(i, col)| {
                if info.iter().find(|r| r.0 == *col).unwrap().1 == "INTEGER" {
                    expected.insert(col.to_string(), json!(i));
                    Value::Integer(i as i64)
                } else if i % 3 == 0 && !keys.contains(col) {
                    expected.insert(col.to_string(), Json::Null);
                    Value::Null
                } else {
                    let s = format!("{col}: Идея 🦀 e\u{301}\u{1}");
                    expected.insert(col.to_string(), json!(s));
                    Value::Text(s)
                }
            })
            .collect();
        let slots = (0..cols.len()).map(|_| "?").collect::<Vec<_>>().join(",");
        c.execute(
            &format!("INSERT INTO {table} VALUES({slots})"),
            rusqlite::params_from_iter(values),
        )
        .unwrap();
        assert_effect(
            &c,
            table,
            0,
            None,
            Some(Json::Object(expected.clone())),
            &keys,
        );
        assert_accounting(&c, 1);
        let assignments = cols
            .iter()
            .map(|col| format!("{col}={col}"))
            .collect::<Vec<_>>()
            .join(",");
        let bytes_before = scalar(&c, "SELECT staged_bytes FROM sync_write_context");
        c.execute_batch(&format!("UPDATE {table} SET {assignments}"))
            .unwrap();
        assert_accounting(&c, 1);
        assert_eq!(
            scalar(&c, "SELECT staged_bytes FROM sync_write_context"),
            bytes_before
        );
        // Each field starts from the same INSERT image. A savepoint rolls back
        // the mutation and observer counters/fence/spool together, not triggers.
        for col in &cols {
            c.execute_batch("SAVEPOINT field_probe").unwrap();
            let value = if info.iter().find(|r| r.0 == *col).unwrap().1 == "INTEGER" {
                Value::Integer(9_007_199_254_740_993)
            } else {
                Value::Text(format!("{col}: changed 🦀 e\u{301}\u{1}"))
            };
            let changed = observe_update(&c, table, col, &keys, &expected, value.clone());
            // Logical keys are explicitly NOT NULL in the projection fixture.
            // Every other isolated column permits both NULL transition directions.
            if !keys.contains(col) {
                let nulled = observe_update(&c, table, col, &keys, &changed, Value::Null);
                observe_update(&c, table, col, &keys, &nulled, value);
            }
            c.execute_batch("ROLLBACK TO field_probe; RELEASE field_probe")
                .unwrap();
            assert_accounting(&c, 1);
        }
        c.execute_batch(&format!("UPDATE {table} SET {}={}", cols[0], cols[0]))
            .unwrap();
        assert_eq!(scalar(&c, "SELECT effect_count FROM sync_write_context"), 1);
        let before = Json::Object(expected.clone());
        let changed = cols
            .iter()
            .find(|col| !keys.contains(col))
            .unwrap_or(&cols[0]);
        // First nonkey is text for every entity except the all-key parent link.
        c.execute(&format!("UPDATE {table} SET {changed}=?1"), ["changed 🦀"])
            .unwrap();
        expected.insert(changed.to_string(), json!("changed 🦀"));
        assert_effect(
            &c,
            table,
            1,
            Some(before),
            Some(Json::Object(expected.clone())),
            &keys,
        );
        c.execute_batch(&format!("DELETE FROM {table}")).unwrap();
        assert_effect(&c, table, 2, Some(Json::Object(expected)), None, &keys);
        assert_eq!(scalar(&c, "SELECT effect_count FROM sync_write_context"), 3);
        assert_eq!(scalar(&c, "SELECT count(*) FROM sync_commit_fences"), 1);
        assert_eq!(scalar(&c,"SELECT staged_bytes FROM sync_write_context"),scalar(&c,"SELECT sum(coalesce(length(CAST(before_json AS BLOB)),0)+coalesce(length(CAST(after_json AS BLOB)),0)) FROM sync_effects"));
        c.execute_batch("ROLLBACK").unwrap();
    }
    healthy(&c);
}

#[test]
#[should_panic(expected = "projects.updated_at: observed update count")]
fn per_field_probe_detects_a_missing_update_predicate_term() {
    // Mutation control exists only in this isolated in-memory schema. The
    // authoritative file and real domain triggers are never edited or disabled.
    let term = " AND OLD.updated_at IS NEW.updated_at";
    assert_eq!(CANDIDATE.matches(term).count(), 3);
    let mutant: &'static str = Box::leak(CANDIDATE.replacen(term, "", 1).into_boxed_str());
    exercise_observer_bodies(mutant);
}

fn assert_effect(
    c: &Connection,
    table: &str,
    offset: i64,
    before: Option<Json>,
    after: Option<Json>,
    keys: &[&str],
) {
    let (kind,key,old,new):(String,String,Option<String>,Option<String>)=c.query_row(
        "SELECT entity_kind,entity_key,before_json,after_json FROM sync_effects ORDER BY effect_no LIMIT 1 OFFSET ?1",[offset],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    assert_eq!(kind, table);
    assert_eq!(
        old.map(|s| serde_json::from_str::<Json>(&s).unwrap()),
        before
    );
    assert_eq!(
        new.map(|s| serde_json::from_str::<Json>(&s).unwrap()),
        after
    );
    let row = after.as_ref().or(before.as_ref()).unwrap();
    let expected: Vec<String> = keys
        .iter()
        .map(|k| match &row[*k] {
            Json::String(s) => s.clone(),
            v => v.to_string(),
        })
        .collect();
    assert_eq!(serde_json::from_str::<Vec<String>>(&key).unwrap(), expected);
    assert!(row.get("seq").is_none());
}

#[test]
fn artifact_retains_reviewed_ddl_without_a_second_executable_source() {
    // The document remains a historical design proposal; exact core/guard
    // agreement prevents accidental divergence during this dormant review slice.
    let design = include_str!("../../../../../docs/architecture/m05-journal-migration-proof.md")
        .replace("\r\n", "\n");
    for label in ["-- candidate-core", "-- candidate-guards"] {
        let block = design
            .split("```sql\n")
            .find(|b| b.starts_with(label))
            .unwrap()
            .split("\n```")
            .next()
            .unwrap();
        assert!(
            CANDIDATE.replace("\r\n", "\n").contains(block),
            "reviewed {label} drift"
        );
    }
    for (table, keys, cols) in catalog() {
        assert!(design.contains(&format!(
            "| {table} | {} | {} |",
            keys.join(","),
            cols.join(",")
        )));
    }
}

#[test]
fn synthetic_disk_upgrade_reopens_and_v9_binary_refuses_without_touching_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("synthetic.db");
    let store = CaptureStore::open(&path).unwrap();
    let mut c = store.connection.into_inner().unwrap();
    populated(&c);
    let before = fingerprint(&c);
    let historical_schema = schema(&c);
    let row_counts = counts(&c);
    install(&mut c);
    let installed_schema = schema(&c);
    drop(c);
    let mut reopened = Connection::open(&path).unwrap();
    reopened.pragma_update(None, "foreign_keys", "ON").unwrap();
    install(&mut reopened);
    install(&mut reopened);
    assert_eq!(schema(&reopened), installed_schema);
    assert!(historical_schema
        .iter()
        .all(|row| installed_schema.contains(row)));
    assert_eq!(fingerprint(&reopened), before);
    assert_eq!(counts(&reopened), row_counts);
    assert_eq!(scalar(&reopened, "PRAGMA user_version"), 10);
    assert_exact_candidate_catalog(&reopened);
    healthy(&reopened);
    drop(reopened);
    // Quiescent file bytes, not a power-loss or packaged-historical-binary proof.
    let bytes = std::fs::read(&path).unwrap();
    let error = match CaptureStore::open(&path) {
        Err(error) => error,
        Ok(_) => panic!("production v9 accepted a future schema"),
    };
    assert!(
        matches!(error, super::capture_store::StoreError::Corrupt(ref message)
        if message == "schema version 10 is newer than the supported version 9")
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    let refused = Connection::open(&path).unwrap();
    refused.pragma_update(None, "foreign_keys", "ON").unwrap();
    assert_eq!(schema(&refused), installed_schema);
    assert_eq!(fingerprint(&refused), before);
    assert_eq!(scalar(&refused, "PRAGMA user_version"), 10);
    healthy(&refused);
}

#[test]
fn bundle_size_version_hash_and_snapshot_json_constraints_are_native_backstops() {
    for (bytes, hash, version, count) in [
        ("zeroblob(0)", "zeroblob(32)", 1, 1),
        ("zeroblob(4194305)", "zeroblob(32)", 1, 1),
        ("x'01'", "zeroblob(31)", 1, 1),
        ("x'01'", "zeroblob(32)", 2, 1),
        ("x'01'", "zeroblob(32)", 1, 4097),
    ] {
        let c = initialized();
        begin(&c, 100);
        capture(&c, 200).unwrap();
        // Over-count may be rejected by admission before its CHECK; either way
        // no bundle/tip is published and the owning transaction must roll back.
        assert!(c.execute_batch(&format!(
            "INSERT INTO sync_bundles VALUES('{}','{}','{}','{}',1,{version},{count},{bytes},{hash},zeroblob(32),'{NOW}')",
            id(100),id(10100),id(1),id(2))).is_err());
        c.execute_batch("ROLLBACK").unwrap();
        assert_eq!(scalar(&c, "SELECT count(*) FROM captures"), 0);
        assert_eq!(scalar(&c, "SELECT last_seq FROM sync_origins"), 0);
        healthy(&c);
    }
    let c = initialized();
    c.execute("INSERT INTO sync_snapshots(snapshot_id,state,profile,requested_at) VALUES(?1,'pending','knowledge-v1-full',?2)",params![id(300),NOW]).unwrap();
    for (ordinal, key, bytes, hash) in [
        (-1, "[]", "x'01'", "zeroblob(32)"),
        (20000, "[]", "x'01'", "zeroblob(32)"),
        (0, "{}", "x'01'", "zeroblob(32)"),
        (0, "not json", "x'01'", "zeroblob(32)"),
        (0, "[]", "zeroblob(262145)", "zeroblob(32)"),
        (0, "[]", "x'01'", "zeroblob(31)"),
    ] {
        rejects(&c,&format!("INSERT INTO sync_snapshot_rows VALUES('{}',{ordinal},'captures','{key}',{bytes},{hash})",id(300)),"CHECK");
    }
    for set in ["row_count=20001", "total_bytes=33554433"] {
        rejects(
            &c,
            &format!("UPDATE sync_snapshots SET state='materialized',boundary_bytes=x'01',{set}"),
            "CHECK",
        );
    }
    healthy(&c);
}

#[test]
fn seal_and_new_incarnation_keep_old_tip_and_cannot_reactivate_it() {
    let c = initialized();
    begin(&c, 100);
    capture(&c, 200).unwrap();
    append(&c, 100, 1).unwrap();
    finish(&c);
    // Test SQL lifecycle only; production activation is intentionally absent.
    c.execute_batch("BEGIN IMMEDIATE").unwrap();
    c.execute(
        "UPDATE sync_origins SET status='sealed',sealed_at=?1",
        [NOW],
    )
    .unwrap();
    c.execute("INSERT INTO sync_origins(origin_id,incarnation,status,opened_at) VALUES(?1,?2,'active',?3)",params![id(1),id(3),NOW]).unwrap();
    c.execute("UPDATE sync_local SET active_incarnation=?1", [id(3)])
        .unwrap();
    c.execute_batch("COMMIT").unwrap();
    assert_eq!(
        scalar(
            &c,
            "SELECT last_seq FROM sync_origins WHERE status='sealed'"
        ),
        1
    );
    assert_eq!(
        scalar(
            &c,
            "SELECT last_seq FROM sync_origins WHERE status='active'"
        ),
        0
    );
    rejects(
        &c,
        "UPDATE sync_origins SET status='active',sealed_at=NULL WHERE status='sealed'",
        "sealed once",
    );
    rejects(&c,&format!("INSERT INTO sync_origins(origin_id,incarnation,status,opened_at) VALUES('{}','{}','active','{NOW}')",id(1),id(4)),"UNIQUE");
    healthy(&c);
}
