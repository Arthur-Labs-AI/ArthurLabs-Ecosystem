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
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

import { ARTHUR_PLATFORMS } from "../../packages/contracts";
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

test("the IPC command name agrees between the TypeScript client and the Rust handler", () => {
  assert.match(readText(app, "src/client/tauri-ipc.ts"), /call\("get_runtime_info"\)/);
  assert.match(readText(tauriDir, "src/commands/runtime_info.rs"), /pub fn get_runtime_info\(\)/);
  assert.match(libRs, /commands::runtime_info::get_runtime_info/);
});

test("packages/contracts declares no dependencies", () => {
  const manifest = readJson<Record<string, unknown>>(root, "packages/contracts/package.json");
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    assert.equal(manifest[field], undefined, `contracts must not declare ${field}`);
  }
});
