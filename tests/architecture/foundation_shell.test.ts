/**
 * Static consistency checks for the Tauri + React + Vite shell in apps/arthur.
 *
 * The native layer cannot be compiled in every environment (it needs a Rust
 * toolchain), so these tests pin the wiring that breaks silently: versions,
 * the dev/build handoff between Tauri and Vite, mobile-build prerequisites and
 * agreement between the Rust platform names and packages/contracts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

import {
  ARTHUR_PLATFORMS,
  CAPTURE_SOURCE_KINDS,
  DISTILLATION_ERROR_CODES,
  KNOWLEDGE_OBJECT_KINDS,
  LINEAGE_ERROR_CODES,
  MICROPHONE_PERMISSION_STATES,
  ORGANIZATION_STATUSES,
  MAX_CAPTURE_CONTENT_CHARS,
  MAX_INFERENCE_CANDIDATES,
  MAX_INFERENCE_REQUESTS,
  MAX_KNOWLEDGE_BODY_CHARS,
  MAX_KNOWLEDGE_TITLE_CHARS,
  MAX_MERGE_PARENTS,
  MAX_OBJECTS_PER_DISTILLATION,
  MAX_RELATIONS_PER_INFERENCE,
  INBOX_PROJECT_ID,
  MAX_CAPTURE_LOOKUP,
  MAX_PROJECT_NAME_CHARS,
  MAX_SUMMARY_IDS,
  PROJECT_ERROR_CODES,
  MAX_RELATION_PROPOSALS,
  MAX_REVISIONS_PER_OBJECT,
  RELATION_ERROR_CODES,
  RELATION_KINDS,
  RELATION_ORIGINS,
  REVISION_ORIGINS,
  SYMMETRIC_RELATION_KINDS,
  VOICE_CAPTURE_ERROR_CODES,
} from "../../packages/contracts";
import { findRepoRoot } from "./import_graph";

const root = findRepoRoot();
const app = path.join(root, "apps/arthur");
const tauriDir = path.join(app, "src-tauri");

const readText = (...segments: string[]): string => readFileSync(path.join(...segments), "utf8");
const readJson = <T>(...segments: string[]): T => JSON.parse(readText(...segments)) as T;

interface TauriConfig {
  version: string;
  identifier: string;
  build: { devUrl: string; frontendDist: string; beforeDevCommand: string; beforeBuildCommand: string };
  app: {
    windows: Array<{ label?: string }>;
    security: { csp: Record<string, string>; devCsp: Record<string, string> };
  };
  bundle: { icon: string[] };
}

const tauriConfig = readJson<TauriConfig>(tauriDir, "tauri.conf.json");
const cargoManifest = readText(tauriDir, "Cargo.toml");
const viteConfig = readText(app, "vite.config.ts");
const libRs = readText(tauriDir, "src/lib.rs");

function cargoValue(key: string): string | undefined {
  return new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(cargoManifest)?.[1];
}

test("app, Tauri config and Cargo manifest declare the same version", () => {
  const { version } = readJson<{ version: string }>(app, "package.json");
  assert.equal(tauriConfig.version, version);
  assert.equal(cargoValue("version"), version);
});

test("the Tauri identifier is a lowercase reverse-domain id that is valid as an Android package", () => {
  assert.match(tauriConfig.identifier, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
  assert.ok(!tauriConfig.identifier.endsWith(".app"), "an identifier ending in .app conflicts with the macOS bundle extension");
});

test("Tauri serves what Vite builds and talks to the port Vite pins", () => {
  assert.equal(tauriConfig.build.frontendDist, "../dist");
  assert.doesNotMatch(viteConfig, /outDir/, "Vite must keep its default dist/ output directory");

  const port = new URL(tauriConfig.build.devUrl).port;
  assert.match(viteConfig, new RegExp(`port:\\s*${port}\\b`));
  assert.match(viteConfig, /strictPort:\s*true/);

  assert.equal(tauriConfig.build.beforeDevCommand, "npm run dev");
  assert.equal(tauriConfig.build.beforeBuildCommand, "npm run build");
});

test("the production CSP is strict and the dev CSP loosens only what Vite needs", () => {
  const { csp, devCsp } = tauriConfig.app.security;

  // The built page has no inline scripts and loads nothing from the network except IPC.
  assert.equal(csp["default-src"], "'self'");
  assert.equal(csp["script-src"], undefined);
  assert.deepEqual(
    Object.entries(csp).filter(([, value]) => value.includes("'unsafe-inline'")).map(([directive]) => directive),
    ["style-src"],
  );
  assert.doesNotMatch(Object.values(csp).join(" "), /unsafe-eval|\bws:|\bhttps?:(?!\/\/ipc\.localhost)/);

  // `csp` is also injected in dev unless `devCsp` exists. Vite serves an inline React Refresh
  // script and an HMR WebSocket (also over a LAN address for `tauri android dev`).
  assert.match(devCsp["script-src"] ?? "", /'unsafe-inline'/);
  assert.match(devCsp["connect-src"] ?? "", /\bws:/);
  for (const source of ["ipc:", "http://ipc.localhost"]) {
    assert.ok(devCsp["connect-src"]?.includes(source), `devCsp must keep ${source} so IPC works in dev`);
  }
});

test("every bundle icon exists", () => {
  assert.ok(tauriConfig.bundle.icon.length > 0);
  for (const icon of tauriConfig.bundle.icon) {
    assert.ok(existsSync(path.join(tauriDir, icon)), `missing icon ${icon}`);
  }
});

test("the crate is buildable for Android and iOS, not only desktop", () => {
  const crateTypes = /crate-type\s*=\s*\[([^\]]*)\]/.exec(cargoManifest)?.[1] ?? "";
  for (const required of ["staticlib", "cdylib", "rlib"]) {
    assert.match(crateTypes, new RegExp(`"${required}"`), `[lib] crate-type is missing ${required}`);
  }
  assert.match(cargoManifest, /^name\s*=\s*"arthur_lib"/m);

  assert.match(libRs, /#\[cfg_attr\(mobile,\s*tauri::mobile_entry_point\)\]\s*pub fn run\(\)/);
  assert.match(readText(tauriDir, "src/main.rs"), /arthur_lib::run\(\)/);
});

test("capabilities only target windows that Tauri creates", () => {
  const labels = new Set(tauriConfig.app.windows.map((window) => window.label ?? "main"));
  const capability = readJson<{ windows: string[]; permissions: string[] }>(tauriDir, "capabilities/default.json");

  assert.ok(capability.windows.length > 0);
  for (const label of capability.windows) {
    assert.ok(labels.has(label), `capability targets unknown window "${label}"`);
  }
  assert.ok(capability.permissions.includes("core:default"));
});

test("the Rust platform names are exactly the contract's ArthurPlatform values", () => {
  const platformRs = readText(tauriDir, "src/platform/mod.rs");
  const implementation = platformRs.slice(0, platformRs.indexOf("#[cfg(test)]"));
  const returned = [...implementation.matchAll(/^\s*"([a-z]+)"\s*$/gm)].map((match) => match[1]);

  assert.deepEqual([...new Set(returned)].sort(), [...ARTHUR_PLATFORMS].sort());
});

test("every IPC command agrees between the TypeScript client and the Rust handlers", () => {
  const ipc = readText(app, "src/client/tauri-ipc.ts");
  const commandSources: Record<string, string> = {
    get_runtime_info: "src/commands/runtime_info.rs",
    create_capture: "src/commands/captures.rs",
    list_captures: "src/commands/captures.rs",
    start_voice_capture: "src/commands/voice.rs",
    finish_voice_capture: "src/commands/voice.rs",
    cancel_voice_capture: "src/commands/voice.rs",
    distill_capture: "src/commands/distill.rs",
    list_knowledge_objects: "src/commands/distill.rs",
    create_relation: "src/commands/graph.rs",
    list_relations: "src/commands/graph.rs",
    get_object_relations: "src/commands/graph.rs",
    get_object_neighbors: "src/commands/graph.rs",
    infer_relations: "src/commands/graph.rs",
    get_object_lineage: "src/commands/lineage.rs",
    list_revisions: "src/commands/lineage.rs",
    get_revision: "src/commands/lineage.rs",
    get_revision_parents: "src/commands/lineage.rs",
    get_revision_children: "src/commands/lineage.rs",
    update_knowledge_object: "src/commands/lineage.rs",
    create_revision_from: "src/commands/lineage.rs",
    merge_revisions: "src/commands/lineage.rs",
    diff_revisions: "src/commands/lineage.rs",
    get_captures: "src/commands/captures.rs",
    list_projects: "src/commands/projects.rs",
    get_project: "src/commands/projects.rs",
    create_project: "src/commands/projects.rs",
    rename_project: "src/commands/projects.rs",
    archive_project: "src/commands/projects.rs",
    restore_project: "src/commands/projects.rs",
    move_capture: "src/commands/projects.rs",
    move_knowledge_object: "src/commands/projects.rs",
    get_active_project: "src/commands/projects.rs",
    set_active_project: "src/commands/projects.rs",
    get_project_graph: "src/commands/projects.rs",
    list_organization_states: "src/commands/distill.rs",
    get_knowledge_summaries: "src/commands/distill.rs",
    retry_voice_transcription: "src/commands/voice.rs",
  };
  for (const [command, rustFile] of Object.entries(commandSources)) {
    assert.match(ipc, new RegExp(`(?:call|relationCall|lineageCall|projectCall|invokeWith)\\(\\s*(?:call,\\s*)?"${command}"`), `${command} is not called by tauri-ipc.ts`);
    assert.match(readText(tauriDir, rustFile), new RegExp(`pub (async )?fn ${command}\\(`));
    assert.match(libRs, new RegExp(`commands::\\w+::${command}\\b`), `${command} is not registered in lib.rs`);
  }
});

function rustFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? rustFiles(path.join(dir, entry.name)) : entry.name.endsWith(".rs") ? [path.join(dir, entry.name)] : [],
  );
}

test("SQLite is confined to the native storage module", () => {
  const users = rustFiles(path.join(tauriDir, "src"))
    .filter((file) => /\brusqlite\b/.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(path.join(tauriDir, "src"), file).split(path.sep).join("/"));
  assert.ok(users.length > 0, "expected the storage module to use rusqlite");
  for (const file of users) assert.match(file, /^storage\//, `${file} must not touch SQLite directly`);
});

test("the native capture store enforces the same limits and sources as the contract", () => {
  const store = readText(tauriDir, "src/storage/capture_store.rs");
  assert.equal(Number(/MAX_CAPTURE_CONTENT_CHARS: usize = ([\d_]+);/.exec(store)?.[1]?.replaceAll("_", "")), MAX_CAPTURE_CONTENT_CHARS);

  const sources = /const SOURCES: \[&str; \d+\] = \[([^\]]*)\];/.exec(store)?.[1] ?? "";
  assert.deepEqual([...sources.matchAll(/"([a-z]+)"/g)].map((m) => m[1]), [...CAPTURE_SOURCE_KINDS]);
  assert.match(readText(tauriDir, "src/storage/migrations.rs"), /CHECK \(source IN \('text', 'voice', 'emg'\)\)/);
});

test("packages/contracts declares no dependencies", () => {
  const manifest = readJson<Record<string, unknown>>(root, "packages/contracts/package.json");
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    assert.equal(manifest[field], undefined, `contracts must not declare ${field}`);
  }
});

const androidSrc = path.join(tauriDir, "gen/android/app/src/main");
const manifest = readText(androidSrc, "AndroidManifest.xml");
const audioPlugin = readText(androidSrc, "java/dev/kaloyan/arthur/AudioPlugin.kt");

test("the Android manifest asks for the microphone and network, and for nothing that enables background recording or file access", () => {
  const permissions = [...manifest.matchAll(/<uses-permission android:name="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(permissions, ["android.permission.INTERNET", "android.permission.RECORD_AUDIO"]);
  assert.match(manifest, /android\.hardware\.microphone"\s+android:required="false"/, "devices without a microphone can still install");
  assert.doesNotMatch(manifest, /foregroundServiceType|<service\b/);
});

test("app data (captures, credentials) is excluded from Android cloud backup", () => {
  assert.match(manifest, /<application[^>]*android:allowBackup="false"/);
});

test("the Kotlin recorder is foreground-only, cache-confined and requests the permission at use", () => {
  assert.match(audioPlugin, /override fun onPause\(\)/, "recording must stop when the app leaves the foreground");
  assert.match(audioPlugin, /cacheDir/);
  assert.doesNotMatch(audioPlugin, /getExternalFilesDir|getExternalStorage|ExternalCacheDir|MediaStore|Service\b/);
  assert.match(audioPlugin, /requestPermissionForAlias\(MICROPHONE/);
  assert.match(audioPlugin, /Manifest\.permission\.RECORD_AUDIO/);
  assert.match(libRs, /audio::android::init\(\)/, "the plugin must be registered on Android");
});

test("voice error codes agree across the contract, the Rust service and the Kotlin plugin", () => {
  const rust = readText(tauriDir, "src/audio/error.rs");
  const rustCodes = [...rust.slice(rust.indexOf("pub fn code"), rust.indexOf("pub fn message")).matchAll(/=> "([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...rustCodes].sort(), [...VOICE_CAPTURE_ERROR_CODES].sort());

  const kotlinCodes = [...audioPlugin.matchAll(/invoke\.reject\([^,]+,\s*"([a-z_]+)"/g)].map((m) => m[1] as string);
  assert.ok(kotlinCodes.length > 0);
  for (const code of kotlinCodes) assert.ok((VOICE_CAPTURE_ERROR_CODES as readonly string[]).includes(code), `Kotlin rejects with unknown code ${code}`);

  // recording_failed is the bridge's default arm; every other code must be mapped explicitly.
  const bridge = readText(tauriDir, "src/audio/android.rs");
  for (const code of new Set(kotlinCodes)) {
    if (code !== "recording_failed") assert.match(bridge, new RegExp(`"${code}"`), `${code} is not mapped by the Rust bridge`);
  }
});

test("HTTP, credentials and the microphone are confined to their modules", () => {
  const src = path.join(tauriDir, "src");
  const files = rustFiles(src).map((file) => ({ rel: path.relative(src, file).split(path.sep).join("/"), text: readFileSync(file, "utf8") }));
  const providerModules = /^(providers|stt|distillation|graph)\//;

  for (const { rel, text } of files) {
    if (/\breqwest\b/.test(text)) assert.match(rel, providerModules, `${rel} must not make HTTP calls`);
    if (/openai_api_key|api_key\(\)/.test(text)) assert.match(rel, /^(providers\/|stt\/|distillation\/|graph\/|lib\.rs$)/, `${rel} must not touch credentials`);
    if (/run_mobile_plugin/.test(text)) assert.equal(rel, "audio/android.rs", `${rel} must not call the microphone plugin`);
  }

  // Nothing that handles the API key, the user's speech or their thoughts may log.
  for (const { rel, text } of files.filter((f) => providerModules.test(f.rel) && !f.rel.endsWith("test_support.rs"))) {
    const production = text.slice(0, text.indexOf("#[cfg(test)]") === -1 ? undefined : text.indexOf("#[cfg(test)]"));
    assert.doesNotMatch(production, /\b(println|eprintln|dbg|print|eprint)!|\btracing::|\blog::/, `${rel} must not log`);
  }
});

test("the model never writes to storage: the provider client cannot reach the store", () => {
  for (const file of ["src/distillation/openai.rs", "src/distillation/prompt.rs"]) {
    assert.doesNotMatch(readText(tauriDir, file), /\bstorage::|rusqlite|CaptureStore/, `${file} must not touch storage`);
  }
  // Only the service persists, and only through the all-or-nothing store call.
  const service = readText(tauriDir, "src/distillation/mod.rs");
  assert.match(service, /store\.record_distillation\(/);
  assert.doesNotMatch(service.slice(0, service.indexOf("#[cfg(test)]")), /INSERT|UPDATE|DELETE|\.execute\(/);
});

test("knowledge kinds, limits and error codes agree across the contract, Rust, SQL and the model schema", () => {
  const store = readText(tauriDir, "src/storage/knowledge_store.rs");
  const rustKinds = /pub const KINDS: \[&str; \d+\] = \[([^\]]*)\];/.exec(store)?.[1] ?? "";
  assert.deepEqual([...rustKinds.matchAll(/"([a-z]+)"/g)].map((m) => m[1]), [...KNOWLEDGE_OBJECT_KINDS]);

  const sqlList = [...KNOWLEDGE_OBJECT_KINDS].map((kind) => `'${kind}'`).join(", ");
  assert.ok(readText(tauriDir, "src/storage/migrations.rs").includes(`kind IN (${sqlList})`), "the SQL CHECK lists the same kinds");

  const schema = readText(tauriDir, "src/distillation/prompt.rs");
  const enumList = /"enum": \[([^\]]*)\]/.exec(schema)?.[1] ?? "";
  assert.deepEqual([...enumList.matchAll(/"([a-z]+)"/g)].map((m) => m[1]), [...KNOWLEDGE_OBJECT_KINDS], "the model is offered exactly these kinds");

  const limit = (name: string): number => Number(new RegExp(`pub const ${name}: usize = ([\\d_]+);`).exec(store)?.[1]?.replaceAll("_", ""));
  assert.equal(limit("MAX_TITLE_CHARS"), MAX_KNOWLEDGE_TITLE_CHARS);
  assert.equal(limit("MAX_BODY_CHARS"), MAX_KNOWLEDGE_BODY_CHARS);
  assert.equal(limit("MAX_OBJECTS_PER_DISTILLATION"), MAX_OBJECTS_PER_DISTILLATION);

  const distill = readText(tauriDir, "src/distillation/mod.rs");
  const codes = distill.slice(distill.indexOf("pub fn code"), distill.indexOf("pub fn message"));
  assert.deepEqual([...new Set([...codes.matchAll(/=> "([a-z_]+)"/g)].map((m) => m[1]))].sort(), [...DISTILLATION_ERROR_CODES].sort());
});

test("the schema is changed only through ordered, transactional migration steps", () => {
  const migrations = readText(tauriDir, "src/storage/migrations.rs");
  assert.match(migrations, /pub const STEPS: \[Step; 7\] = \[\(1, SCHEMA_V1\), \(2, SCHEMA_V2\), \(3, SCHEMA_V3\), \(4, SCHEMA_V4\), \(5, SCHEMA_V5\), \(6, SCHEMA_V6\), \(7, SCHEMA_V7\)\];/);
  assert.match(migrations, /connection\.transaction\(\)/);
  for (const table of ["distillation_runs", "knowledge_objects", "object_sources", "relations", "thought_revisions", "revision_parents"]) assert.match(migrations, new RegExp(`CREATE TABLE ${table}\\b`));
  assert.match(migrations, /REFERENCES captures\(id\)/);
  assert.match(migrations, /captures_are_immutable/);
  assert.match(readText(tauriDir, "src/storage/capture_store.rs"), /foreign_keys/);
  // Other modules never run schema statements.
  for (const file of rustFiles(path.join(tauriDir, "src")).filter((f) => !/storage[\\/]/.test(f))) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /CREATE TABLE|ALTER TABLE|DROP TABLE|PRAGMA user_version/, `${file} must not change the schema`);
  }
});

/** Rust source before its test module, with comment lines removed, so prose cannot trip a code check. */
const productionCode = (source: string): string =>
  (source.indexOf("#[cfg(test)]") === -1 ? source : source.slice(0, source.indexOf("#[cfg(test)]")))
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

const nativeConst = (source: string, name: string): string => new RegExp(`pub const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\];`).exec(source)?.[1] ?? "";
const quoted = (list: string): string[] => [...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);

test("relation kinds, symmetry, origins and limits agree across the contract, Rust, SQL and the model schema", () => {
  const store = readText(tauriDir, "src/storage/relation_store.rs");
  assert.deepEqual(quoted(nativeConst(store, "KINDS")), [...RELATION_KINDS]);
  assert.deepEqual(quoted(nativeConst(store, "SYMMETRIC_KINDS")), [...SYMMETRIC_RELATION_KINDS]);
  assert.deepEqual(quoted(nativeConst(store, "ORIGINS")), [...RELATION_ORIGINS]);

  const sql = readText(tauriDir, "src/storage/migrations.rs");
  const list = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(", ");
  assert.ok(sql.includes(`kind IN (${list(RELATION_KINDS)})`), "the SQL CHECK lists the same relation kinds");
  assert.ok(sql.includes(`kind NOT IN (${list(SYMMETRIC_RELATION_KINDS)})`), "the SQL canonical-order CHECK lists the same symmetric kinds");
  assert.ok(sql.includes(`origin IN (${list(RELATION_ORIGINS)})`));

  const prompt = readText(tauriDir, "src/graph/prompt.rs");
  const offered = /"kind": \{ "type": "string", "enum": \[([^\]]*)\]/.exec(prompt)?.[1] ?? "";
  assert.deepEqual(quoted(offered), [...RELATION_KINDS], "the model is offered exactly these kinds");
  const verifyPrompt = readText(tauriDir, "src/graph/verify_prompt.rs");
  const verifierKinds = /"kind": \{ "type": "string", "enum": \[([^\]]*)\]/.exec(verifyPrompt)?.[1] ?? "";
  assert.deepEqual(quoted(verifierKinds), [...RELATION_KINDS], "the verifier is offered exactly these kinds");
  const semantics = readText(tauriDir, "src/graph/semantics.rs");
  assert.deepEqual([...semantics.matchAll(/kind: "([a-z_]+)",/g)].map((m) => m[1]), [...RELATION_KINDS], "one shared definition per kind, in contract order");

  assert.equal(Number(/pub const MAX_INFERENCE_CANDIDATES: usize = ([\d_]+);/.exec(readText(tauriDir, "src/graph/candidates.rs"))?.[1]?.replaceAll("_", "")), MAX_INFERENCE_CANDIDATES);
  assert.equal(Number(/pub const MAX_RELATIONS_PER_BATCH: usize = ([\d_]+);/.exec(store)?.[1]?.replaceAll("_", "")), MAX_RELATIONS_PER_INFERENCE);

  const graph = readText(tauriDir, "src/graph/mod.rs");
  assert.equal(Number(/pub const MAX_RELATION_PROPOSALS: usize = ([\d_]+);/.exec(graph)?.[1]), MAX_RELATION_PROPOSALS);
  assert.equal(Number(/pub const MAX_PROVIDER_REQUESTS_PER_RUN: usize = ([\d_]+);/.exec(graph)?.[1]), MAX_INFERENCE_REQUESTS);
  const codes = graph.slice(graph.indexOf("pub fn code"), graph.indexOf("pub fn message"));
  assert.deepEqual([...new Set([...codes.matchAll(/=> "([a-z_]+)"/g)].map((m) => m[1]))].sort(), [...RELATION_ERROR_CODES].sort());
});

test("graph schema: foreign keys to knowledge objects, canonical identity, indexes, and no lineage in it", () => {
  const migrations = readText(tauriDir, "src/storage/migrations.rs");
  const v3 = migrations.slice(migrations.indexOf("pub const SCHEMA_V3"), migrations.indexOf("/// v4 (M03)"));
  assert.equal([...v3.matchAll(/REFERENCES knowledge_objects\(id\) ON DELETE CASCADE/g)].length, 2, "both ends are foreign keys that cascade, so an edge can never dangle");
  assert.match(v3, /UNIQUE \(kind, source_object_id, target_object_id\)/);
  assert.match(v3, /CHECK \(source_object_id <> target_object_id\)/);
  assert.match(v3, /CREATE INDEX relations_by_source ON relations\(source_object_id\)/);
  assert.match(v3, /CREATE INDEX relations_by_target ON relations\(target_object_id\)/);
  // Graph relations and Capture provenance are separate systems: a relation never points at a capture.
  assert.doesNotMatch(v3, /captures/);
  // Out of scope for v1-v6: embeddings and an outbox. v7 (M04B) adds retrieval indexes ONLY (checked in the v7 test below).
  const beforeV7 = migrations.slice(0, migrations.indexOf("/// v7 (M04B)"));
  assert.doesNotMatch(beforeV7, /embedding|outbox/i);
  assert.doesNotMatch(migrations, /outbox/i);
  // The graph schema does not know about revisions.
  assert.doesNotMatch(v3, /revision/i);
});

test("the model never writes to the graph: the provider client and prompt cannot reach the store", () => {
  for (const file of ["src/graph/openai.rs", "src/graph/prompt.rs", "src/graph/validate.rs", "src/graph/candidates.rs", "src/graph/verify.rs", "src/graph/verify_prompt.rs", "src/graph/semantics.rs"]) {
    const production = productionCode(readText(tauriDir, file));
    assert.doesNotMatch(production, /rusqlite|CaptureStore|record_relations|create_relation|\.execute\(/, `${file} must not write to storage`);
  }
  // Only the service persists, and only through the all-or-nothing store call, after validation.
  const production = productionCode(readText(tauriDir, "src/graph/mod.rs"));
  assert.match(production, /store\.record_relations\(verified, "model"\)/);
  // Stage A -> structural validation -> Stage B votes -> gates -> final validation -> persistence.
  const steps = ["self.proposer.propose", "validate::validate_proposals", "self.verifier.verify", "verify::apply_votes", "validate::validate_edges", "store.record_relations"];
  const positions = steps.map((step) => production.indexOf(step));
  assert.ok(positions.every((at) => at >= 0), `a pipeline step is missing: ${steps.filter((_, i) => (positions[i] as number) < 0).join(", ")}`);
  assert.deepEqual([...positions].sort((x, y) => x - y), positions, `pipeline steps are out of order: ${steps.join(" -> ")}`);
  assert.equal([...production.matchAll(/self\.verifier\.verify\(/g)].length, 2, "exactly two verification votes: a fixed request count, no loop over the provider");
  assert.equal([...production.matchAll(/self\.proposer\.propose\(/g)].length, 1);
  assert.doesNotMatch(production, /\bfor\b[^\n]*\.(verify|propose)\(|\bloop\b|\bwhile\b/, "no provider call can sit inside a loop");
  assert.doesNotMatch(production, /INSERT|UPDATE|DELETE|\.execute\(/);
  // The provider reply is parsed strictly: unknown fields are an error, not silently ignored.
  assert.match(readText(tauriDir, "src/graph/openai.rs"), /deny_unknown_fields/);
});

test("relation inference sends knowledge objects only, never raw captures", () => {
  for (const file of ["src/graph/prompt.rs", "src/graph/verify_prompt.rs"]) {
    const production = productionCode(readText(tauriDir, file));
    assert.doesNotMatch(production, /provenance|capture_id|\.content/, `${file} does not read capture text or provenance`);
  }
});

test("the verifier is shown no direction and no Stage A reasoning", () => {
  const production = productionCode(readText(tauriDir, "src/graph/verify_prompt.rs"));
  assert.doesNotMatch(production, /"source":|"target":/, "the candidate JSON has first/second, not source/target");
  assert.doesNotMatch(production, /\.reason\b/, "Stage A's reason is not forwarded");
  // Direction is derived from ratings in native code, never from lexical id order.
  const verify = productionCode(readText(tauriDir, "src/graph/verify.rs"));
  assert.match(verify, /pub fn orient\(/);
  assert.doesNotMatch(verify, /\.id\s*[<>]=?\s*[a-z_.]*\.id|source_object_id\s*[<>]|target_object_id\s*[<>]/, "no id-order comparison decides a direction in the verifier");
});

test("graph relations are never derived from Capture provenance in code", () => {
  const knowledge = productionCode(readText(tauriDir, "src/storage/knowledge_store.rs"));
  assert.doesNotMatch(knowledge, /relations/, "distillation does not write graph edges");
  const production = productionCode(readText(tauriDir, "src/storage/relation_store.rs"));
  assert.doesNotMatch(production, /object_sources|captures/, "the graph store does not read provenance or captures");
});

test("the Cognitive Graph UI depends only on React, the contracts and the ArthurClient interface", () => {
  const graphDir = path.join(app, "src/features/graph");
  const files = readdirSync(graphDir).filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name));
  assert.ok(files.length >= 4, "expected the graph feature files");
  for (const file of files) {
    const source = readText(graphDir, file);
    for (const [, specifier] of source.matchAll(/from "([^"]+)"/g)) {
      assert.match(
        specifier as string,
        /^(react|@arthur\/contracts|\.{1,2}\/.*)$/,
        `${file} imports "${specifier}"; the graph UI may use only react, @arthur/contracts and relative modules`,
      );
      assert.doesNotMatch(specifier as string, /client\/(tauri-ipc|desktop-client|mobile-client|preview-client)|storage|distillation|providers/, `${file} reaches below the ArthurClient interface`);
    }
    assert.doesNotMatch(source, /invoke\(|@tauri-apps|sqlite|rusqlite|openai|chat\/completions/i, `${file} must not touch the native layer, storage or a provider`);
  }
  // The graph is drawn with plain SVG: no graph library was added for this milestone.
  const manifest = readJson<{ dependencies: Record<string, string> }>(app, "package.json");
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["@tauri-apps/api", "react", "react-dom"]);
});

// --- Thought Lineage (M03) ---------------------------------------------------------------------------------------

const v4Sql = (): string => {
  const migrations = readText(tauriDir, "src/storage/migrations.rs");
  return migrations.slice(migrations.indexOf("pub const SCHEMA_V4"), migrations.indexOf("pub type Step"));
};

test("revision origins, limits and error codes agree across the contract, Rust and SQL", () => {
  const store = readText(tauriDir, "src/storage/lineage_store.rs");
  assert.deepEqual(quoted(nativeConst(store, "ORIGINS")), [...REVISION_ORIGINS]);
  const list = [...REVISION_ORIGINS].map((origin) => `'${origin}'`).join(", ");
  assert.ok(v4Sql().includes(`origin IN (${list})`), "the SQL CHECK lists the same origins");
  const limit = (name: string): number => Number(new RegExp(`pub const ${name}: usize = ([\\d_]+);`).exec(store)?.[1]?.replaceAll("_", ""));
  assert.equal(limit("MAX_MERGE_PARENTS"), MAX_MERGE_PARENTS);
  assert.equal(limit("MAX_REVISIONS_PER_OBJECT"), MAX_REVISIONS_PER_OBJECT);

  const lineage = readText(tauriDir, "src/lineage/mod.rs");
  const codes = lineage.slice(lineage.indexOf("pub fn code"), lineage.indexOf("pub fn message"));
  assert.deepEqual([...new Set([...codes.matchAll(/=> "([a-z_]+)"/g)].map((m) => m[1]))].sort(), [...LINEAGE_ERROR_CODES].sort());
});

test("schema v4: an append-only revision DAG with a guarded projection and a deterministic bootstrap", () => {
  const sql = v4Sql();
  for (const table of ["thought_revisions", "revision_parents"]) assert.match(sql, new RegExp(`CREATE TABLE ${table}\\b`));
  assert.match(sql, /object_id\s+TEXT\s+NOT NULL REFERENCES knowledge_objects\(id\) ON DELETE CASCADE/);
  assert.match(sql, /capture_id\s+TEXT\s+REFERENCES captures\(id\)/);
  assert.match(sql, /PRIMARY KEY \(child_revision_id, parent_revision_id\)/, "a duplicate parent edge is impossible");
  assert.match(sql, /CHECK \(child_revision_id <> parent_revision_id\)/, "a revision cannot be its own parent");
  assert.match(sql, /CREATE UNIQUE INDEX one_initial_revision_per_object ON thought_revisions\(object_id\) WHERE origin = 'initial'/);
  assert.match(sql, /CREATE INDEX thought_revisions_by_object/);
  assert.match(sql, /CREATE INDEX revision_parents_by_parent/);
  assert.match(sql, /ALTER TABLE knowledge_objects ADD COLUMN current_revision_id TEXT REFERENCES thought_revisions\(id\)/);
  for (const trigger of ["thought_revisions_are_immutable", "revision_parents_are_immutable", "revision_parents_same_object", "revision_parents_parent_is_older", "revision_parents_are_acyclic", "knowledge_objects_equal_their_current_revision"]) {
    assert.match(sql, new RegExp(`CREATE TRIGGER ${trigger}\\b`), trigger);
  }
  // Bootstrap: exactly one initial revision per existing object, derived without any random source.
  assert.match(sql, /substr\(o\.id, 1, 14\) \|\| '8' \|\| substr\(o\.id, 16\)/);
  assert.doesNotMatch(sql, /random\(|randomblob|hex\(|uuid/i);
  // Revisions never reference the graph; provenance on a revision is its own, optional, all-or-nothing span.
  assert.doesNotMatch(sql, /relations/);
  assert.match(sql, /capture_id IS NULL AND source_start IS NULL AND source_end IS NULL/);
});

test("lineage is a separate system: it neither reads nor writes graph relations or Capture provenance, and vice versa", () => {
  const lineage = productionCode(readText(tauriDir, "src/storage/lineage_store.rs"));
  assert.doesNotMatch(lineage, /\brelations\b|relation_store|NewRelation/, "lineage code does not touch graph relations");
  assert.doesNotMatch(lineage, /object_sources/, "lineage code does not rewrite object-level provenance");
  assert.doesNotMatch(lineage, /UPDATE captures|DELETE FROM captures/, "captures stay immutable");
  const graph = productionCode(readText(tauriDir, "src/storage/relation_store.rs"));
  assert.doesNotMatch(graph, /thought_revisions|revision_parents|lineage_store/, "graph code does not touch revisions");
  for (const file of ["src/graph/mod.rs", "src/graph/validate.rs", "src/graph/verify.rs"]) {
    assert.doesNotMatch(productionCode(readText(tauriDir, file)), /thought_revisions|revision_parents|lineage/, `${file} does not know about lineage`);
  }
  // Only the storage module writes revisions; commands go through the store's semantic operations.
  for (const file of rustFiles(path.join(tauriDir, "src")).filter((f) => !/storage[\\/]/.test(f))) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /INSERT INTO thought_revisions|INSERT INTO revision_parents|UPDATE knowledge_objects/, `${file} must not write lineage tables`);
  }
  // The only code that points an object at a revision is the single insertion path.
  assert.equal([...lineage.matchAll(/UPDATE knowledge_objects SET/g)].length, 1, "one place moves the current pointer");
  assert.equal([...lineage.matchAll(/INSERT INTO thought_revisions/g)].length, 1, "one place creates a revision");
  assert.equal([...lineage.matchAll(/INSERT INTO revision_parents/g)].length, 1, "one place links a parent");
});

test("the TypeScript and native diffs are checked against the same shared fixture file", () => {
  assert.ok(existsSync(path.join(root, "tests/fixtures/revision_diff_cases.json")));
  assert.match(readText(tauriDir, "src/lineage/diff.rs"), /include_str!\("[./]*tests\/fixtures\/revision_diff_cases\.json"\)/);
  assert.match(readText(root, "tests/unit/contracts_lineage.test.ts"), /revision_diff_cases\.json/);
  // No model anywhere near the canonical diff.
  const diff = productionCode(readText(tauriDir, "src/lineage/diff.rs"));
  assert.doesNotMatch(diff, /reqwest|chat::|openai|providers|async/i);
});

test("the lineage UI depends only on React, the contracts and the ArthurClient interface", () => {
  const dir = path.join(app, "src/features/lineage");
  const files = readdirSync(dir).filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name));
  assert.ok(files.length >= 4, "expected the lineage feature files");
  for (const file of files) {
    const source = readText(dir, file);
    for (const [, specifier] of source.matchAll(/from "([^"]+)"/g)) {
      assert.match(specifier as string, /^(react|@arthur\/contracts|\.{1,2}\/.*)$/, `${file} imports "${specifier}"`);
      assert.doesNotMatch(specifier as string, /client\/(tauri-ipc|desktop-client|mobile-client|preview-client)|storage|distillation|providers/, `${file} reaches below the ArthurClient interface`);
    }
    assert.doesNotMatch(source, /invoke\(|@tauri-apps|sqlite|rusqlite|openai|chat\/completions/i, `${file} must not touch the native layer, storage or a provider`);
  }
});

test("M03 adds no dependency and no later-milestone machinery", () => {
  const manifest = readJson<{ dependencies: Record<string, string> }>(app, "package.json");
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["@tauri-apps/api", "react", "react-dom"]);
  const sources = rustFiles(path.join(tauriDir, "src")).filter((f) => /lineage/.test(f)).map((f) => productionCode(readFileSync(f, "utf8"))).join("\n");
  assert.doesNotMatch(sources, /embedding|vector|recall|outbox|tailscale/i);
});

test("microphone permission states agree across the contract, the Rust enum and the Kotlin plugin", () => {
  const recorder = readText(tauriDir, "src/audio/recorder.rs");
  const variants = [...recorder.slice(recorder.indexOf("pub enum MicrophonePermission")).split("}")[0]!.matchAll(/^\s+([A-Z][A-Za-z]+),/gm)].map((m) => (m[1] as string).replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase());
  assert.deepEqual([...variants].sort(), [...MICROPHONE_PERMISSION_STATES].sort(), "Rust variants (snake_case on the wire)");

  const kotlinStates = [...audioPlugin.slice(audioPlugin.indexOf("fun getMicrophonePermission")).split("openAppSettings")[0]!.matchAll(/-> "([a-z_]+)"/g)].map((m) => m[1] as string);
  assert.deepEqual([...new Set(kotlinStates)].sort(), [...MICROPHONE_PERMISSION_STATES].filter((state) => state !== "unknown" || kotlinStates.includes("unknown")).sort());
  assert.match(readText(tauriDir, "src/audio/android.rs"), /"denied_permanently" => MicrophonePermission::DeniedPermanently/);
});

test("the microphone is only ever READ by the permission query, and Open Settings exposes no intent to the UI", () => {
  assert.doesNotMatch(audioPlugin.slice(audioPlugin.indexOf("fun getMicrophonePermission"), audioPlugin.indexOf("fun openAppSettings")), /requestPermission|requestPermissionForAlias/);
  const uiFiles = uiSourceFiles(path.join(app, "src"));
  for (const { rel, text } of uiFiles) assert.doesNotMatch(text, /android\.settings|Intent\(|ACTION_APPLICATION_DETAILS_SETTINGS|dev\.kaloyan\.arthur"/, `${rel} must not know about intents or package names`);
});

test("organization states, durable failures and summaries agree across the contract, Rust and SQL", () => {
  const store = readText(tauriDir, "src/storage/organization_store.rs");
  const statuses = [...new Set([...store.slice(0, store.indexOf("#[cfg(test)]")).matchAll(/"(pending|running|succeeded|failed)"/g)].map((m) => m[1]))];
  const service = readText(tauriDir, "src/distillation/mod.rs");
  const all = new Set([...statuses, ...(service.includes('"running"') ? ["running"] : [])]);
  assert.deepEqual([...all].sort(), [...ORGANIZATION_STATUSES].sort());

  const migrations = readText(tauriDir, "src/storage/migrations.rs");
  const failures = migrations.slice(migrations.indexOf("CREATE TABLE organization_failures"));
  const sqlCodes = [...failures.slice(0, failures.indexOf(");")).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...sqlCodes].sort(), DISTILLATION_ERROR_CODES.filter((code) => code !== "capture_not_found").sort(), "the failures table accepts exactly the storable distillation codes");

  const summaries = readText(tauriDir, "src/storage/summary_store.rs");
  assert.match(summaries, new RegExp(`MAX_SUMMARY_IDS: usize = ${String(MAX_SUMMARY_IDS).replace(/(\d)(?=(\d{3})+$)/g, "$1_")}`));
});

/** Every TypeScript and CSS source file (not tests) under a directory, as { rel, text }. */
function uiSourceFiles(dir: string): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push({ rel: path.relative(dir, full), text: readFileSync(full, "utf8") });
    }
  };
  walk(dir);
  return out;
}

test("Back at the root sends Arthur to the background, and the process never ends through exit() with the WebView alive", () => {
  const activity = readText(androidSrc, "java/dev/kaloyan/arthur/MainActivity.kt");
  assert.match(activity, /override fun onBackPressed\(\)\s*\{\s*moveTaskToBack\(true\)\s*\}/, "root Back backgrounds the task");
  assert.doesNotMatch(activity.replace(/\/\*[\s\S]*?\*\//g, ""), /\bfinish\(|finishAffinity|super\.onBackPressed/, "root Back must not finish the Activity");

  const lifecycle = readText(tauriDir, "src/lifecycle.rs");
  assert.match(lifecycle, /libc::_exit\(0\)/, "the exit path skips the destructors that abort the process");
  assert.match(readText(tauriDir, "src/lib.rs"), /RunEvent::Exit[\s\S]*lifecycle::leave_process\(\)/);
  assert.match(readText(tauriDir, "Cargo.toml"), /\[target\.'cfg\(target_os = "android"\)'\.dependencies\]\s*libc/);
});

test("temporary audio is bounded, app-private, never logged and never stored", () => {
  const voice = readText(tauriDir, "src/audio/voice_capture.rs");
  const production = voice.slice(0, voice.indexOf("#[cfg(test)]"));
  assert.match(production, /RETRY_TTL: Duration = Duration::from_secs\(15 \* 60\)/, "15 minutes");
  assert.doesNotMatch(production, /\b(println|eprintln|dbg|print|eprint)!|\btracing::|\blog::/, "audio handling must not log");
  assert.doesNotMatch(production, /rusqlite|INSERT INTO|execute\(/, "audio is never written to the database");
  // The only way a path leaves the module is as a file name sent to speech-to-text; commands never return one.
  const commands = readText(tauriDir, "src/commands/voice.rs");
  assert.doesNotMatch(commands, /PathBuf|\.path|display\(\)/);
  assert.match(production, /purge_stale_recordings\(&recordings_dir\)/, "stale audio is purged at startup");
  // Backups are off, so the cache directory is not copied anywhere.
  assert.match(readText(androidSrc, "AndroidManifest.xml"), /android:allowBackup="false"/);
});

test("schema v6: projects own captures and objects, and nothing else carries a project", () => {
  const migrations = readText(tauriDir, "src/storage/migrations.rs");
  const v6 = /pub const SCHEMA_V6: &str = "([\s\S]*?)";\n/.exec(migrations)?.[1] ?? "";
  assert.ok(v6.length > 0, "SCHEMA_V6 exists");
  assert.match(v6, /CREATE TABLE projects \(/);
  assert.match(v6, /ALTER TABLE captures ADD COLUMN project_id TEXT REFERENCES projects\(id\)/);
  assert.match(v6, /ALTER TABLE knowledge_objects ADD COLUMN project_id TEXT REFERENCES projects\(id\)/);
  // Ownership is on those two tables only: revisions, relations, provenance and organization state derive it.
  for (const table of ["thought_revisions", "revision_parents", "relations", "object_sources", "distillation_runs", "organization_failures"]) {
    assert.doesNotMatch(v6, new RegExp(`ALTER TABLE ${table}\\b`), `${table} gets no project column`);
    assert.doesNotMatch(migrations.slice(0, migrations.indexOf("/// The id of the system Inbox project")), /project_id/, "no earlier schema step knows about projects");
  }
  // The Inbox: one fixed id, shared by the contract, the migration and the Rust constant; protected by triggers.
  assert.ok(v6.includes(INBOX_PROJECT_ID), "the migration creates the Inbox with the contract's id");
  assert.ok(migrations.includes(`pub const INBOX_PROJECT_ID: &str = "${INBOX_PROJECT_ID}";`));
  assert.match(v6, /BEFORE DELETE ON projects/);
  assert.match(v6, /archived_at IS NOT NULL/);
  assert.match(v6, /CREATE INDEX captures_by_project ON captures\(project_id, seq\)/);
  assert.match(v6, /CREATE INDEX knowledge_objects_by_project ON knowledge_objects\(project_id, seq\)/);
  // Only membership may change on a capture; its content stays immutable.
  assert.match(v6, /BEFORE UPDATE OF id, seq, source, content, created_at ON captures/);
  // The backfill is deterministic: everything goes to the Inbox, with no model and no randomness.
  assert.match(v6, /UPDATE captures SET project_id = '00000000-0000-4000-8000-000000000001'/);
  assert.match(v6, /UPDATE knowledge_objects SET project_id = '00000000-0000-4000-8000-000000000001'/);
  assert.doesNotMatch(v6, /random|randomblob|uuid/i);

  const projects = readText(tauriDir, "src/storage/project_store.rs");
  assert.equal(Number(/MAX_PROJECT_NAME_CHARS: usize = (\d+);/.exec(projects)?.[1]), MAX_PROJECT_NAME_CHARS);
  const codes = projects.slice(projects.indexOf("pub fn code"), projects.indexOf("pub fn message"));
  assert.deepEqual([...new Set([...codes.matchAll(/=> "([a-z_]+)"/g)].map((m) => m[1]))].sort(), [...PROJECT_ERROR_CODES].sort());
  assert.equal(Number(/MAX_CAPTURE_LOOKUP: usize = ([\d_]+);/.exec(readText(tauriDir, "src/storage/capture_store.rs"))?.[1]?.replaceAll("_", "")), MAX_CAPTURE_LOOKUP);
  // There is no hard delete: projects are archived, so rows can never be orphaned by the API.
  assert.doesNotMatch(productionCode(projects), /DELETE FROM projects|DROP TABLE/);
});

test("projects are a domain boundary the model never decides: distillation and inference prompts know nothing of them", () => {
  for (const file of ["src/distillation/prompt.rs", "src/distillation/openai.rs", "src/distillation/resolve.rs", "src/graph/prompt.rs", "src/graph/verify_prompt.rs", "src/graph/openai.rs", "src/graph/validate.rs"]) {
    assert.doesNotMatch(productionCode(readText(tauriDir, file)), /project_id|projectId|\bProject(Id|Scope)?\b/, `${file} must not mention projects: the model does not choose them`);
  }
  // Inheritance happens in the store, in the same transaction as the distillation run.
  const knowledge = productionCode(readText(tauriDir, "src/storage/knowledge_store.rs"));
  assert.match(knowledge, /SELECT content, project_id FROM captures WHERE id = \?1/);
  assert.match(knowledge, /INSERT INTO knowledge_objects \(id, kind, title, body, created_at, project_id\)/);
  // Inference candidates are project-local by construction.
  const graph = productionCode(readText(tauriDir, "src/graph/mod.rs"));
  assert.match(graph, /store\.list_knowledge_objects_in\(Some\(&project_id\)\)/);
  assert.doesNotMatch(graph, /store\.list_knowledge_objects\(\)/, "inference never reads every project's objects");
});

test("M04C: Recall reads only through the store, writes only its own projections, and the answer model cannot reach the store or any tool", () => {
  // The one answer-producing method on ArthurClient is `ask`: no search/query/recall methods, no history or conversation.
  const client = readText(app, "src/client/arthur-client.ts");
  assert.equal([...client.matchAll(/^\s*(ask|recall\w*|query\w*|search\w*)\(/gm)].map((m) => m[1]).join(","), "ask");
  assert.doesNotMatch(client, /conversation|chatSession|askHistory/i);
  const lib = readText(tauriDir, "src/lib.rs");
  assert.match(lib, /commands::recall::ask,/);
  // Recall's native code: no graph/lineage/distillation services, no tool or process execution, no HTTP of its own, no vendor.
  const recallDir = path.join(tauriDir, "src", "recall");
  const recallFiles = rustFiles(recallDir).filter((f) => !/(bench|acceptance|service_tests|ask_tests|testing)/.test(f));
  const recall = recallFiles.map((f) => productionCode(readFileSync(f, "utf8"))).join("\n");
  assert.doesNotMatch(recall, /providers::chat|complete_json|crate::graph|crate::lineage|crate::distillation|std::process|Command::new|reqwest|openai/i);
  // The word "tool" appears only in the synthesis prompt (which tells the model it has none).
  const withoutPrompt = recallFiles.filter((f) => !/prompt\.rs$/.test(f)).map((f) => productionCode(readFileSync(f, "utf8"))).join("\n");
  assert.doesNotMatch(withoutPrompt, /\btools?\b/i);
  // Recall reads authoritative tables only through the store module, and writes only its own projections.
  assert.doesNotMatch(recall, /rusqlite|execute\(|INSERT|UPDATE |DELETE FROM/);
  const store = productionCode(readText(tauriDir, "src/storage/recall_store.rs"));
  for (const statement of store.match(/(INSERT OR REPLACE INTO|INSERT INTO|UPDATE|DELETE FROM)\s+\w+/g) ?? []) {
    assert.match(statement, /recall_/, `${statement}: Recall writes only its own projections`);
  }
  // The answer model: a request is exactly system + user + schema (no tools, no callbacks), and the vendor module cannot reach the store.
  const synthesis = productionCode(readText(tauriDir, "src/recall/synthesis.rs"));
  assert.match(synthesis, /pub struct SynthesisRequest \{\s*pub system: String,\s*pub user: String,\s*pub schema: Value,\s*\}/);
  const vendor = productionCode(readText(tauriDir, "src/providers/answer.rs"));
  assert.doesNotMatch(vendor, /CaptureStore|storage::|rusqlite|crate::graph|crate::lineage/);
  assert.doesNotMatch(readText(tauriDir, "src/recall/prompt.rs"), /"tools"|"functions"|tool_choice/);
  // Nothing about a question or answer is persisted: schema stays at v7 and has no history/conversation tables.
  const migrations = readText(tauriDir, "src/storage/migrations.rs");
  const v7 = migrations.slice(migrations.indexOf("pub const SCHEMA_V7"), migrations.indexOf("pub type Step"));
  assert.doesNotMatch(migrations, /ask_history|conversation|chat_session|recall_history|recall_answers/i);
  assert.match(migrations, /pub const SCHEMA_VERSION: i64 = 7;/);
  // v7 adds retrieval indexes and nothing else: no existing table is altered, no project copied into an index, no consent in the database.
  assert.doesNotMatch(v7, /ALTER TABLE|DROP |UPDATE |DELETE FROM/);
  assert.deepEqual([...v7.matchAll(/CREATE (?:VIRTUAL )?TABLE (\w+)/g)].map((m) => m[1]), ["recall_revision_fts", "recall_embeddings", "recall_meta"]);
  assert.doesNotMatch(v7, /project_id/);
  assert.doesNotMatch(v7, /consent|enabled/i);
  // The semantic candidate floor stays at the calibrated 0.40.
  assert.match(readText(tauriDir, "src/recall/service.rs"), /pub const DEFAULT_MIN_COSINE: f32 = 0\.40;/);
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

test("M04D: Ask Arthur is a UI over `ask`: one place builds the scope, nothing is persisted, consent is the user's choice and not an API key", () => {
  const src = path.join(app, "src");
  const shipped = sourceFiles(src).filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes(`${path.sep}test${path.sep}`));
  const code = (file: string): string =>
    readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");

  // Exactly one UI file calls `ask`, and it is the one that always attaches the active project: React cannot omit the scope.
  const callers = shipped.filter((f) => /\bclient\.ask\(/.test(code(f))).map((f) => path.relative(src, f));
  assert.deepEqual(callers, [path.join("features", "recall", "ask-context.tsx")]);
  const context = code(path.join(src, "features/recall/ask-context.tsx"));
  assert.match(context, /scope:\s*\{\s*projectId:\s*project\.id\s*\}/);
  assert.doesNotMatch(context, /allProjects|projectId:\s*(null|undefined)|scope:\s*(null|undefined)/);

  // The Recall UI keeps nothing: no browser storage writes, no cookies, no database. (The only storage touch is reading a developer flag.)
  const recallUi = shipped.filter((f) => f.includes(`${path.sep}features${path.sep}recall${path.sep}`));
  const recallCode = recallUi.map(code).join("\n");
  assert.doesNotMatch(recallCode, /setItem|removeItem|sessionStorage|indexedDB|document\.cookie|openDatabase/);
  assert.ok([...recallCode.matchAll(/localStorage\.(\w+)/g)].every((m) => m[1] === "getItem"), "localStorage is only read, for the developer flag");
  // React never re-implements Recall: no ranking, similarity, thresholds, vendor or provider names.
  assert.doesNotMatch(recallCode, /cosine|\brrf\b|DEFAULT_MIN_COSINE|MIN_COSINE|0\.40|embedding-3|openai|fetch\(/i);
  // Semantic consent reads and writes one setting through the client. It never looks at an API key.
  const consent = ["features/recall/use-semantic-recall.ts", "features/recall/SemanticRecallSettings.tsx"].map((f) => code(path.join(src, f))).join("\n");
  assert.doesNotMatch(consent, /api[_-]?key|OPENAI|secret|token/i);
  assert.match(consent, /setSemanticRecallEnabled/);
  assert.match(consent, /purgeSemanticIndex/);

  // Mobile keeps its five primary tabs: Ask Arthur is a pushed page reached from Home, never a sixth tab.
  const mobile = code(path.join(src, "features/mobile/MobileApp.tsx"));
  assert.equal([...mobile.matchAll(/\{ screen: "\w+", label: "[A-Za-z ]+", icon: "\w+" \}/g)].length, 4, "four tabs plus the central Capture action");
  assert.match(mobile, /kind === "ask"/);
  // An archived project opened read-only is never made the active project; it only supplies the scope of Ask.
  const projectsState = code(path.join(src, "features/projects/use-projects.ts"));
  const open = projectsState.slice(projectsState.indexOf("const openArchived"), projectsState.indexOf("const closeArchived"));
  assert.doesNotMatch(open, /setActiveProject|client\./);
  assert.match(context, /readOnlyProject \?\? liveProject/);
  // The scripted demo exists only in development builds.
  assert.match(code(path.join(src, "client/index.ts")), /import\.meta\.env\.DEV[^;]*recallDemo/);
  // Schema is still v7 (checked in full by the M04C guard above); and the native Recall floor is untouched.
  assert.match(readText(tauriDir, "src/recall/service.rs"), /pub const DEFAULT_MIN_COSINE: f32 = 0\.40;/);
});
