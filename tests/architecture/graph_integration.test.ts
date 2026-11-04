/**
 * Architecture rules of Automatic Graph Integration (M04.7A), pinned as source checks so a later change cannot quietly break them:
 * user relations are protected in SQL, integration never creates revisions, never widens Recall consent, never runs inside the
 * Capture/Distillation transaction, stays inside the existing relation semantics and schema, and keeps its provider budget.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

import { findRepoRoot } from "./import_graph";

const root = findRepoRoot();
const src = path.join(root, "apps/arthur/src-tauri/src");
const read = (relative: string): string => readFileSync(path.join(src, relative), "utf8");

/** Rust source without comments and without `#[cfg(test)]` modules, so only the shipped code is judged. */
function shipped(relative: string): string {
  let text = read(relative);
  const cut = text.indexOf("#[cfg(test)]");
  if (cut >= 0) text = text.slice(0, cut);
  return text.replace(/\/\/.*$/gm, "");
}

function rustFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? rustFiles(path.join(dir, entry.name)) : entry.name.endsWith(".rs") ? [path.join(dir, entry.name)] : []));
}

const INTEGRATION_FILES = ["graph/integration.rs", "graph/integrate.rs", "graph/discover.rs", "commands/integration.rs", "storage/integration_store.rs"];

test("a user relation can never be deleted by integration: the only relation DELETE is model-only, in one place", () => {
  const deleters = rustFiles(src)
    .filter((file) => !/_tests?\.rs$|integration_bench\.rs$/.test(file))
    .filter((file) => /DELETE\s+FROM\s+relations/i.test(shipped(path.relative(src, file))))
    .map((file) => path.relative(src, file).split(path.sep).join("/"));
  assert.deepEqual(deleters, ["storage/integration_store.rs"], "nothing else may delete a relation");
  const store = shipped("storage/integration_store.rs");
  const statements = [...store.matchAll(/DELETE FROM relations[^"]*"/g)].map((m) => m[0]);
  assert.ok(statements.length > 0 && statements.every((s) => s.includes("origin = 'model'")), "every DELETE is guarded by origin = 'model'");
  assert.match(store, /origin != "model"/, "the removal path checks the origin before deleting");
  assert.match(store, /r\.origin = 'model'/, "revalidation candidates are read model-only");
  assert.match(store, /touch the changed object/, "added relations must touch the changed object");
});

test("automatic relations are stored as origin model", () => {
  assert.match(shipped("storage/integration_store.rs"), /insert_all\(transaction, edges, "model"\)/);
  for (const file of INTEGRATION_FILES) assert.doesNotMatch(shipped(file), /"user"/, `${file} must never write a user relation`);
});

test("integration never creates or changes a revision, a capture or a knowledge object (automatic revisions are M04.7B)", () => {
  const forbidden = /\b(update_object|create_revision_from|merge_revisions|revise_from_capture|record_distillation|insert_revision|create_initial_revision|move_knowledge_object|move_capture|archive_project)\b/;
  for (const file of INTEGRATION_FILES) assert.doesNotMatch(shipped(file), forbidden, `${file} must not write knowledge, revisions or projects`);
  assert.doesNotMatch(shipped("storage/integration_store.rs"), /\b(INSERT INTO|UPDATE)\s+(knowledge_objects|thought_revisions|revision_parents|captures|projects)/i);
});

test("integration respects semantic Recall consent and leaves the Recall floor alone", () => {
  const discover = shipped("graph/discover.rs");
  assert.match(discover, /if recall\.semantic_enabled\(\)/, "the semantic channel is gated by the user's consent");
  assert.doesNotMatch(discover + shipped("graph/integration.rs"), /settings\(\)\.set|index_pending|\.embed\(|purge_semantic/, "integration never enables, indexes or embeds by itself");
  assert.match(read("recall/service.rs"), /pub const DEFAULT_MIN_COSINE: f32 = 0\.40;/, "the Recall cosine floor is unchanged");
});

test("integration does not depend on synthesis, Ask Arthur or Recall ranking internals", () => {
  for (const file of ["graph/integration.rs", "graph/integrate.rs", "graph/discover.rs"]) {
    assert.doesNotMatch(shipped(file), /recall::(synthesis|answer|package|prompt|context|ranking|graph|revisions)\b/, `${file} depends on Ask Arthur internals`);
  }
});

test("the graph layer has no Tauri dependency; only commands/integration.rs spawns the work", () => {
  for (const file of ["graph/integration.rs", "graph/integrate.rs", "graph/discover.rs", "storage/integration_store.rs"]) {
    assert.doesNotMatch(shipped(file), /AppHandle|tauri::(State|Manager|Emitter)/, `${file} must stay testable without a Tauri app`);
  }
  assert.match(shipped("commands/integration.rs"), /tauri::async_runtime::spawn/);
});

test("Capture and Distillation know nothing about integration; the command notifies only AFTER the objects are committed", () => {
  // Distillation may NAME the event vocabulary (`ChangedKnowledge`, built only from a committed outcome) but never the service, its settings or its ledger.
  for (const file of rustFiles(path.join(src, "distillation")).filter((candidate) => !candidate.endsWith("_tests.rs"))) {
    const text = readFileSync(file, "utf8").split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n").replace(/crate::graph::integration::(ChangedKnowledge|ChangeReason)/g, "").replace(/graph::integration::(ChangedKnowledge|ChangeReason)/g, "");
    assert.doesNotMatch(text, /IntegrationService|IntegrationSettings|Ledger|commands::integration|integration::notify/, `${file} must not know about graph integration`);
  }
  const command = shipped("commands/distill.rs");
  assert.ok(command.indexOf("distillation.distill_detailed(") < command.indexOf("integration::notify("), "notify comes after distill");
  assert.match(command, /distillation\.distill_detailed\(&store, &capture_id\)\.await\?;/, "a distillation failure returns before any notification");
  assert.doesNotMatch(command, /integration[^;]*\.await/, "the command never awaits the integration");
});

test("only authoritative current revisions notify: edits, current branches and merges, moves", () => {
  const lineage = shipped("commands/lineage.rs");
  for (const command of ["update_knowledge_object", "create_revision_from", "merge_revisions"]) assert.match(lineage, new RegExp(`fn ${command}\\(\\s*app: AppHandle`), `${command} reports its change`);
  assert.equal([...lineage.matchAll(/integration::notify_revised\(/g)].length, 3);
  const integration = shipped("commands/integration.rs");
  assert.match(integration, /if previous != current/, "a revision that did not become current notifies nothing");
  assert.match(shipped("commands/projects.rs"), /ChangedKnowledge::moved\(/);
});

test("the provider budget: one focused proposal and two verification passes; only a contract-invalid response is re-requested, boundedly", () => {
  const integrate = shipped("graph/integrate.rs");
  assert.equal([...integrate.matchAll(/\.propose_for\(/g)].length, 1);
  assert.equal([...integrate.matchAll(/\.verify_pass\(/g)].length, 2, "two verification passes");
  assert.equal([...integrate.matchAll(/\.verifier\.verify\(/g)].length, 1, "the only verifier call site is the retry helper");
  assert.match(integrate, /Err\(RelationError::InvalidOutput\(_\)\) if retries < MAX_CONTRACT_RETRIES/, "only contract-invalid output, only while retries remain");
  assert.match(integrate, /pub const MAX_CONTRACT_RETRIES: usize = \d+;/);
  assert.doesNotMatch(integrate, /\b(for|while)\b[^{]*\{[^}]*\.(propose_for|verify_pass|verify)\(/s, "no provider call inside a for/while loop");
  assert.match(integrate, /Presentation::LowerIdFirst/);
  assert.match(integrate, /Presentation::HigherIdFirst/);
});

test("integration stays on the existing relation semantics and schema, and is off by default", () => {
  assert.match(read("storage/migrations.rs"), /pub const SCHEMA_VERSION: i64 = 9;/); // integration itself added none; v8 and v9 belong to Thought Evolution
  assert.match(read("graph/integration.rs"), /pub const DEFAULT_ENABLED: bool = false;/);
  const semantics = read("graph/semantics.rs");
  for (const kind of ["related_to", "extends", "depends_on", "contradicts", "derived_from", "duplicates", "supersedes"]) assert.match(semantics, new RegExp(`kind: "${kind}"`));
  assert.doesNotMatch(read("storage/integration_store.rs") + read("graph/integration.rs"), /CREATE TABLE|ALTER TABLE|user_version/);
});

test("the integration test and benchmark modules are compiled only under cfg(test)", () => {
  const mod = read("graph/mod.rs");
  for (const name of ["integration_tests", "integration_bench"]) assert.match(mod, new RegExp(`#\\[cfg\\(test\\)\\]\\s*mod ${name};`), `${name} must be a test-only module`);
});
