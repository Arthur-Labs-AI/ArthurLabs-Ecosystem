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
  MAX_CAPTURE_CONTENT_CHARS,
  MAX_INFERENCE_CANDIDATES,
  MAX_INFERENCE_REQUESTS,
  MAX_KNOWLEDGE_BODY_CHARS,
  MAX_KNOWLEDGE_TITLE_CHARS,
  MAX_OBJECTS_PER_DISTILLATION,
  MAX_RELATIONS_PER_INFERENCE,
  MAX_RELATION_PROPOSALS,
  RELATION_ERROR_CODES,
  RELATION_KINDS,
  RELATION_ORIGINS,
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
  };
  for (const [command, rustFile] of Object.entries(commandSources)) {
    assert.match(ipc, new RegExp(`(?:call|relationCall)\\(\\s*"${command}"`), `${command} is not called by tauri-ipc.ts`);
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
  assert.match(migrations, /pub const STEPS: \[Step; 3\] = \[\(1, SCHEMA_V1\), \(2, SCHEMA_V2\), \(3, SCHEMA_V3\)\];/);
  assert.match(migrations, /connection\.transaction\(\)/);
  for (const table of ["distillation_runs", "knowledge_objects", "object_sources", "relations"]) assert.match(migrations, new RegExp(`CREATE TABLE ${table}\\b`));
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

test("graph schema: foreign keys to knowledge objects, canonical identity, indexes, and no lineage tables yet", () => {
  const migrations = readText(tauriDir, "src/storage/migrations.rs");
  const v3 = migrations.slice(migrations.indexOf("pub const SCHEMA_V3"), migrations.indexOf("pub type Step"));
  assert.equal([...v3.matchAll(/REFERENCES knowledge_objects\(id\) ON DELETE CASCADE/g)].length, 2, "both ends are foreign keys that cascade, so an edge can never dangle");
  assert.match(v3, /UNIQUE \(kind, source_object_id, target_object_id\)/);
  assert.match(v3, /CHECK \(source_object_id <> target_object_id\)/);
  assert.match(v3, /CREATE INDEX relations_by_source ON relations\(source_object_id\)/);
  assert.match(v3, /CREATE INDEX relations_by_target ON relations\(target_object_id\)/);
  // Graph relations and Capture provenance are separate systems: a relation never points at a capture.
  assert.doesNotMatch(v3, /captures/);
  // Out of scope for M02.
  assert.doesNotMatch(migrations, /lineage|revision|embedding|outbox/i);
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
