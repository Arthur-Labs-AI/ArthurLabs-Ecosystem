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
  MAX_KNOWLEDGE_BODY_CHARS,
  MAX_KNOWLEDGE_TITLE_CHARS,
  MAX_OBJECTS_PER_DISTILLATION,
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
  };
  for (const [command, rustFile] of Object.entries(commandSources)) {
    assert.match(ipc, new RegExp(`call\\("${command}"`), `${command} is not called by tauri-ipc.ts`);
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
  const providerModules = /^(providers|stt|distillation)\//;

  for (const { rel, text } of files) {
    if (/\breqwest\b/.test(text)) assert.match(rel, providerModules, `${rel} must not make HTTP calls`);
    if (/openai_api_key|api_key\(\)/.test(text)) assert.match(rel, /^(providers\/|stt\/|distillation\/|lib\.rs$)/, `${rel} must not touch credentials`);
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
  assert.match(migrations, /pub const STEPS: \[Step; 2\] = \[\(1, SCHEMA_V1\), \(2, SCHEMA_V2\)\];/);
  assert.match(migrations, /connection\.transaction\(\)/);
  for (const table of ["distillation_runs", "knowledge_objects", "object_sources"]) assert.match(migrations, new RegExp(`CREATE TABLE ${table}\\b`));
  assert.match(migrations, /REFERENCES captures\(id\)/);
  assert.match(migrations, /captures_are_immutable/);
  assert.match(readText(tauriDir, "src/storage/capture_store.rs"), /foreign_keys/);
  // Other modules never run schema statements.
  for (const file of rustFiles(path.join(tauriDir, "src")).filter((f) => !/storage[\\/]/.test(f))) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /CREATE TABLE|ALTER TABLE|DROP TABLE|PRAGMA user_version/, `${file} must not change the schema`);
  }
});
