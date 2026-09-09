/**
 * SC-04 unit tests: scoped path pipeline, sensitive policy, browser URL
 * policy, child env sanitizer, config validation, fake adapters.
 *
 * Deterministic, no real GUI: filesystem tests use a temp sandbox, app
 * and browser adapters use injected fake launchers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { ArthurError } from "../../src/core/errors/errors";
import { validateBrowserUrl } from "../../src/tools/browser_policy";
import { assertChildEnvClean, buildChildEnv } from "../../src/tools/child_env";
import { validateApplicationEntry, validateLocalCapabilityConfig } from "../../src/tools/local_config";
import {
  assertNotSensitive,
  FilesystemScopeRegistry,
  resolveLexical,
} from "../../src/tools/scoped_path";
import { NodeLocalApplicationAdapter } from "../../src/tools/adapters/local_applications";
import { NodeLocalBrowserAdapter } from "../../src/tools/adapters/local_browser";

function codeOf(err: unknown): string {
  assert.ok(err instanceof ArthurError);
  return (err as ArthurError).code;
}

function sandbox(): { dir: string; projects: string; outside: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "sc04-"));
  const projects = path.join(dir, "projects");
  const outside = path.join(dir, "outside");
  mkdirSync(projects, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { dir: dir, projects: projects, outside: outside };
}

function registryFor(projects: string, extra: Array<{ id: string; root: string }> = []): FilesystemScopeRegistry {
  return new FilesystemScopeRegistry([
    { id: "projects", label: "Projects", physical_root: projects, permissions: ["list", "stat", "read", "search"] },
    ...extra.map((e) => ({ id: e.id, label: e.id, physical_root: e.root, permissions: ["list", "stat", "read", "search"] as Array<"list" | "stat" | "read" | "search"> })),
  ]);
}

// ---- lexical traversal ------------------------------------------------

test("lexical escape (../) is rejected", () => {
  const { projects } = sandbox();
  const reg = registryFor(projects);
  const scope = reg.get("projects");
  for (const evil of ["..", "../outside", "a/../../b", "..\\..\\secret"]) {
    assert.throws(() => resolveLexical("projects", scope.physical_root, evil), (e: unknown) => codeOf(e) === "TOOL_SCOPE_VIOLATION");
  }
});

test("absolute, drive, and UNC paths are rejected", () => {
  const { projects } = sandbox();
  const reg = registryFor(projects);
  const scope = reg.get("projects");
  for (const evil of ["/etc/passwd", "C:\\Windows\\x", "C:/Windows/x", "\\\\server\\share", "//server/share"]) {
    assert.throws(() => resolveLexical("projects", scope.physical_root, evil), (e: unknown) => codeOf(e) === "TOOL_SCOPE_VIOLATION");
  }
});

test("unknown root_id is a scope violation", () => {
  const { projects } = sandbox();
  const reg = registryFor(projects);
  assert.throws(() => reg.get("nope"), (e: unknown) => codeOf(e) === "TOOL_SCOPE_VIOLATION");
  assert.throws(() => reg.realRoot("nope"), (e: unknown) => codeOf(e) === "TOOL_SCOPE_VIOLATION");
});

// ---- sensitive policy -------------------------------------------------

test("sensitive basenames blocked, examples allowed", () => {
  assert.throws(() => assertNotSensitive("projects", ".env"), (e: unknown) => codeOf(e) === "TOOL_RESOURCE_UNSUPPORTED");
  assert.throws(() => assertNotSensitive("projects", "sub/.env"), (e: unknown) => codeOf(e) === "TOOL_RESOURCE_UNSUPPORTED");
  assert.throws(() => assertNotSensitive("projects", "id_rsa"), (e: unknown) => codeOf(e) === "TOOL_RESOURCE_UNSUPPORTED");
  assert.doesNotThrow(() => assertNotSensitive("projects", ".env.example"));
  assert.doesNotThrow(() => assertNotSensitive("projects", ".env.sample"));
  assert.doesNotThrow(() => assertNotSensitive("projects", "README.md"));
});

// ---- browser URL policy -----------------------------------------------

test("browser policy allows http/https incl. localhost", () => {
  assert.ok(validateBrowserUrl("https://www.youtube.com/").startsWith("https://"));
  assert.ok(validateBrowserUrl("http://localhost:3000/").includes("localhost"));
});

test("browser policy rejects dangerous schemes and credentials", () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,<h1>x</h1>", "file:///etc/passwd", "ftp://x/y", "customprotocol://x"]) {
    assert.throws(() => validateBrowserUrl(bad), /Only http and https/);
  }
  assert.throws(() => validateBrowserUrl("https://user:pass@example.com/"), /credentials/);
  assert.throws(() => validateBrowserUrl("not a url"), /Malformed/);
  assert.throws(() => validateBrowserUrl("https://x.example/\nHEADER: injected"), /control/);
  assert.throws(() => validateBrowserUrl("https://x.example/" + "a".repeat(5000)), /exceeds/);
});

// ---- child env --------------------------------------------------------

test("child env strips secrets, keeps session plumbing", () => {
  const child = buildChildEnv({
    DEEPSEEK_API_KEY: "sk-live-secret",
    SUPER_SECRET_CANARY: "canary",
    ARTHUR_PRIVATE: "x",
    MY_TOKEN: "tok",
    PATH: "/usr/bin",
    DISPLAY: ":0",
    LANG: "en_US.UTF-8",
  } as NodeJS.ProcessEnv);
  assert.equal(child.DEEPSEEK_API_KEY, undefined);
  assert.equal(child.SUPER_SECRET_CANARY, undefined);
  assert.equal(child.ARTHUR_PRIVATE, undefined);
  assert.equal(child.MY_TOKEN, undefined);
  assert.equal(child.PATH, "/usr/bin");
  assert.equal(child.DISPLAY, ":0");
  assert.equal(child.LANG, "en_US.UTF-8");
  assertChildEnvClean(child, ["sk-live-secret", "canary"]);
  assert.throws(() => assertChildEnvClean({ SUPER_SECRET_CANARY: "canary" }, ["canary"]));
});

// ---- config validation ------------------------------------------------

test("duplicate scope ids and app ids fail closed", () => {
  const { projects, outside } = sandbox();
  assert.throws(() =>
    new FilesystemScopeRegistry([
      { id: "projects", label: "A", physical_root: projects, permissions: ["list"] },
      { id: "projects", label: "B", physical_root: outside, permissions: ["list"] },
    ]), /Duplicate filesystem scope id/);
  assert.throws(() => validateApplicationEntry({ id: "Bad Id", display_name: "x", executable: "/bin/x", args: [] }), /application id/);
  assert.throws(() =>
    validateLocalCapabilityConfig({
      filesystem_roots: [{ id: "a", label: "A", physical_root: projects, permissions: ["list"] }],
      applications: [
        { id: "firefox", display_name: "Firefox", executable: "/bin/fx", args: [] },
        { id: "firefox", display_name: "Dup", executable: "/bin/fx", args: [] },
      ],
    }), /Duplicate application id/);
  assert.throws(() =>
    validateLocalCapabilityConfig({
      filesystem_roots: [{ id: "BAD", label: "A", physical_root: projects, permissions: ["list"] }],
      applications: [],
    }), /scope id/);
});

// ---- app/browser adapter seams ---------------------------------------

test("unknown app_id never spawns", async () => {
  let calls = 0;
  const adapter = new NodeLocalApplicationAdapter([], {
    launcher: async () => { calls += 1; },
  });
  await assert.rejects(adapter.launch("firefox; rm -rf /"), (e: unknown) => codeOf(e) === "TOOL_CAPABILITY_UNAVAILABLE");
  assert.equal(calls, 0);
  assert.equal(adapter.spawnCalls(), 0);
});

test("app launch uses the trusted catalog entry, not model args", async () => {
  const seen: Array<{ exe: string; args: string[] }> = [];
  const adapter = new NodeLocalApplicationAdapter(
    [{ id: "firefox", display_name: "Firefox", executable: "/trusted/firefox", args: ["--safe"] }],
    { launcher: async (exe, args) => { seen.push({ exe: exe, args: args }); }, availability: async () => true },
  );
  const out = await adapter.launch("firefox");
  assert.deepEqual(out, { app_id: "firefox", launched: true });
  assert.deepEqual(seen, [{ exe: "/trusted/firefox", args: ["--safe"] }]);
  const listed = await adapter.list();
  assert.deepEqual(listed, [{ id: "firefox", name: "Firefox", available: true }]);
});

test("browser adapter forwards the validated URL only", async () => {
  const seen: string[] = [];
  const adapter = new NodeLocalBrowserAdapter({ launcher: async (url) => { seen.push(url); } });
  const out = await adapter.openUrl("https://www.youtube.com/");
  assert.deepEqual(out, { url: "https://www.youtube.com/", opened: true });
  assert.deepEqual(seen, ["https://www.youtube.com/"]);
  assert.equal(adapter.openCalls(), 1);
});

test("symlink fixtures resolve for registry construction", () => {
  const { projects, outside } = sandbox();
  writeFileSync(path.join(outside, "secret.txt"), "nope");
  try {
    symlinkSync(path.join(outside, "secret.txt"), path.join(projects, "evil-link"));
  } catch {
    return;
  }
  const reg = registryFor(projects);
  assert.ok(reg.realRoot("projects").length > 0);
});
