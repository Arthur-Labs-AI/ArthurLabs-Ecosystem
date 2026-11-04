/**
 * SC-04 integration tests: filesystem fixtures, adversarial traversal,
 * tool-boundary errors, secret flows, and the full 13-tool catalog.
 *
 * Real NodeLocalFilesystemAdapter over a temp sandbox; app/browser use
 * injected fake launchers (no GUI). All tools run through the secured
 * ToolExecutionService + SC-03 coordinator via ToolOrchestrator.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { ArthurError } from "../../src/core/errors/errors";
import { ArthurMode } from "../../src/core/modes/mode";
import { Logger } from "../../src/observability/logging";
import { InMemoryMetrics } from "../../src/observability/metrics";
import { SecretSanitizer } from "../../src/security/sanitize";
import { SessionStore } from "../../src/sessions/store";
import { HarnessStubAdapter } from "../../src/tools/adapters/harness_stub";
import { NodeLocalApplicationAdapter } from "../../src/tools/adapters/local_applications";
import { NodeLocalBrowserAdapter } from "../../src/tools/adapters/local_browser";
import { NodeLocalFilesystemAdapter } from "../../src/tools/adapters/local_filesystem";
import { NodeLocalSystemAdapter } from "../../src/tools/adapters/local_system";
import { registerBuiltinTools } from "../../src/tools/builtin";
import type { LocalCapabilityHost } from "../../src/tools/local_host";
import { ToolOrchestrator } from "../../src/tools/orchestrator";
import { PermissionService } from "../../src/tools/permissions";
import { ToolRegistry } from "../../src/tools/registry";
import { FilesystemScopeRegistry } from "../../src/tools/scoped_path";

const SIGNING_SECRET = "sc04-integration-secret";

function fixture(): { dir: string; projects: string; documents: string; outside: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "sc04-int-"));
  const projects = path.join(dir, "projects");
  const documents = path.join(dir, "documents");
  const outside = path.join(dir, "outside");
  const alpha = path.join(projects, "alpha");
  const src = path.join(alpha, "src");
  mkdirSync(src, { recursive: true });
  mkdirSync(documents, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(alpha, "README.md"), "# alpha\nhello\n");
  writeFileSync(path.join(src, "app.ts"), "export const x = 1;\n// ToolExecutionService here\n");
  writeFileSync(path.join(outside, "secret.txt"), "outside secret\n");
  writeFileSync(path.join(documents, "private.txt"), "doc secret\n");
  writeFileSync(path.join(projects, ".env"), "KEY=shh\n");
  writeFileSync(path.join(projects, ".env.example"), "KEY=example\n");
  try {
    symlinkSync(path.join(outside, "secret.txt"), path.join(projects, "evil-link"));
    symlinkSync(outside, path.join(projects, "evil-dir"));
    symlinkSync(path.join("nonexistent-target"), path.join(projects, "broken-link"));
  } catch {
    // symlink-restricted platforms: physical tests below skip
  }
  void path;
  return { dir: dir, projects: projects, documents: documents, outside: outside, cleanup: () => undefined };
}

interface World {
  registry: ToolRegistry;
  execution: ReturnType<ToolRegistry["createExecutionService"]>;
  orchestrator: ToolOrchestrator;
  store: SessionStore;
  ctx: Parameters<ToolOrchestrator["handleProposed"]>[1];
  apps: NodeLocalApplicationAdapter;
  browser: NodeLocalBrowserAdapter;
  close: () => void;
}

function buildWorld(fx: ReturnType<typeof fixture>, mode: ArthurMode = ArthurMode.PERSONAL): World {
  const scopes = new FilesystemScopeRegistry([
    { id: "projects", label: "Projects", physical_root: fx.projects, permissions: ["list", "stat", "read", "search"] },
    { id: "documents", label: "Documents", physical_root: fx.documents, permissions: ["list", "stat", "read", "search"] },
  ]);
  const launched: Array<{ exe: string; args: string[] }> = [];
  const opened: string[] = [];
  const apps = new NodeLocalApplicationAdapter(
    [{ id: "firefox", display_name: "Firefox", executable: "/trusted/firefox", args: [] }],
    { launcher: async (exe, args) => { launched.push({ exe: exe, args: args }); }, availability: async () => true },
  );
  const browser = new NodeLocalBrowserAdapter({ launcher: async (url) => { opened.push(url); } });
  const host: LocalCapabilityHost = {
    system: new NodeLocalSystemAdapter(),
    filesystem: new NodeLocalFilesystemAdapter(scopes),
    applications: apps,
    browser: browser,
  };
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, new HarnessStubAdapter({ verificationSecret: SIGNING_SECRET }), { host: host });
  const permissions = new PermissionService();
  const store = new SessionStore(":memory:", new SecretSanitizer([]));
  const execution = registry.createExecutionService(permissions);
  const orchestrator = new ToolOrchestrator({
    registry: registry,
    execution: execution,
    store: store,
    permissions: permissions,
    sanitizer: new SecretSanitizer([]),
    approvalTtlSeconds: 300,
    approvalSigningSecret: SIGNING_SECRET,
    logger: new Logger("error"),
    metrics: new InMemoryMetrics(),
  });
  store.createSession("s1", mode);
  store.createTurn({ id: "t1", sessionId: "s1", role: "user", text: "go", traceId: "tr1", status: "completed", mode: mode });
  return {
    registry: registry,
    execution: execution,
    orchestrator: orchestrator,
    store: store,
    ctx: { session_id: "s1", turn_id: "t1", trace_id: "tr1", mode: mode, approved: false },
    apps: apps,
    browser: browser,
    close: () => store.close(),
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ArthurError);
    return (err as ArthurError).code;
  }
  throw new Error("expected rejection");
}
// ---- catalog ----------------------------------------------------------------

test("SC04 catalog: 13 tools incl. all 10 local tools", async () => {
  const fx = fixture();
  const w = buildWorld(fx);
  try {
    const names = w.registry.list().map((d) => d.name).sort();
    assert.deepEqual(names, [
      "app.launch",
      "app.list",
      "browser.open_url",
      "filesystem.list",
      "filesystem.read_text",
      "filesystem.roots",
      "filesystem.search",
      "filesystem.stat",
      "harness.create_job",
      "harness.status",
      "system.echo",
      "system.status",
      "system.storage",
    ]);
    assert.equal(w.registry.getDefinition("app.launch")?.risk, "low_write");
    assert.equal(w.registry.getDefinition("browser.open_url")?.risk, "low_write");
    assert.equal(w.registry.getExecutionPolicy("app.launch")?.retry.strategy, "off");
    assert.equal(w.registry.getExecutionPolicy("app.launch")?.retry.max_attempts, 1);
    assert.equal(w.registry.getExecutionPolicy("app.launch")?.cancellation, "unsupported");
    assert.equal(w.registry.getExecutionPolicy("browser.open_url")?.retry.strategy, "off");
    assert.equal(w.registry.getExecutionPolicy("browser.open_url")?.cancellation, "unsupported");
    assert.equal(w.registry.getExecutionPolicy("filesystem.search")?.effects, "none");
  } finally {
    w.close();
  }
});

// ---- happy paths --------------------------------------------------------------

test("SC04 happy paths: roots/list/stat/read/search/storage/app/browser", async () => {
  const fx = fixture();
  const w = buildWorld(fx);
  try {
    const roots = await w.execution.execute("filesystem.roots", {}, w.ctx);
    assert.deepEqual(roots.data, { roots: [{ id: "projects", label: "Projects" }, { id: "documents", label: "Documents" }] });
    const json = JSON.stringify(roots.data);
    assert.ok(!json.includes(fx.projects), "no physical path leaks");

    const list = await w.execution.execute("filesystem.list", { root_id: "projects", path: "alpha/src" }, w.ctx);
    assert.deepEqual(list.data, { entries: [{ name: "app.ts", type: "file", size_bytes: (list.data as { entries: Array<{ size_bytes: number }> }).entries[0]?.size_bytes ?? 0 }] });

    const stat = await w.execution.execute("filesystem.stat", { root_id: "projects", path: "alpha/src/app.ts" }, w.ctx);
    assert.equal((stat.data as { type: string }).type, "file");

    const read = await w.execution.execute("filesystem.read_text", { root_id: "projects", path: "alpha/src/app.ts", start_line: 1, max_lines: 120 }, w.ctx);
    assert.ok((read.data as { text: string }).text.includes("ToolExecutionService"));
    assert.equal((read.data as { truncated: boolean }).truncated, false);

    const search = await w.execution.execute("filesystem.search", { root_id: "projects", path: "alpha", query: "ToolExecutionService", mode: "content" }, w.ctx);
    assert.ok(((search.data as { matches: unknown[] }).matches.length >= 1));
    const first = (search.data as { matches: Array<{ root_id: string; relative_path: string }> }).matches[0];
    assert.ok(!(first?.relative_path.includes(":") || first?.relative_path.startsWith("/")), "root-relative match");

    const storage = await w.execution.execute("system.storage", {}, w.ctx);
    assert.ok(Array.isArray((storage.data as { roots: unknown[] }).roots));
    assert.ok(!JSON.stringify(storage.data).includes(fx.projects));

    const apps = await w.execution.execute("app.list", {}, w.ctx);
    assert.deepEqual(apps.data, { applications: [{ id: "firefox", name: "Firefox", available: true }] });

    const launch = await w.execution.execute("app.launch", { app_id: "firefox" }, w.ctx);
    assert.deepEqual(launch.data, { app_id: "firefox", launched: true });

    const opened = await w.execution.execute("browser.open_url", { url: "https://www.youtube.com/" }, w.ctx);
    assert.equal((opened.data as { opened: boolean }).opened, true);
  } finally {
    w.close();
  }
});

// ---- adversarial filesystem ---------------------------------------------------

test("SC04 adversarial: traversal, absolute, scope-crossing blocked", async () => {
  const fx = fixture();
  const w = buildWorld(fx);
  try {
    for (const evil of ["..", "../documents/private.txt", "../../x", "/etc/passwd", "C:\\Windows\\x", "\\\\s\\x"]) {
      assert.equal(await codeOf(w.execution.execute("filesystem.read_text", { root_id: "projects", path: evil }, w.ctx)), "TOOL_SCOPE_VIOLATION");
      assert.equal(await codeOf(w.execution.execute("filesystem.list", { root_id: "projects", path: evil }, w.ctx)), "TOOL_SCOPE_VIOLATION");
    }
    assert.equal(await codeOf(w.execution.execute("filesystem.read_text", { root_id: "projects", path: "../documents/private.txt" }, w.ctx)), "TOOL_SCOPE_VIOLATION");
    assert.equal(await codeOf(w.execution.execute("filesystem.read_text", { root_id: "nope", path: "x" }, w.ctx)), "TOOL_SCOPE_VIOLATION");
    assert.equal(await codeOf(w.execution.execute("filesystem.read_text", { root_id: "projects", path: "missing.txt" }, w.ctx)), "TOOL_RESOURCE_NOT_FOUND");
  } finally {
    w.close();
  }
});

test("SC04 adversarial: symlinks, sensitive, special objects rejected", async () => {
  const fx = fixture();
  const w = buildWorld(fx);
  try {
    const statLink = await w.execution.execute("filesystem.stat", { root_id: "projects", path: "evil-link" }, w.ctx).catch(() => null);
    if (statLink !== null) {
      assert.equal((statLink.data as { type: string }).type, "symlink");
      assert.equal(await codeOf(w.execution.execute("filesystem.read_text", { root_id: "projects", path: "evil-link" }, w.ctx)), "TOOL_SCOPE_VIOLATION");
      assert.equal(await codeOf(w.execution.execute("filesystem.read_text", { root_id: "projects", path: "evil-dir/secret.txt" }, w.ctx)), "TOOL_SCOPE_VIOLATION");
      assert.equal(await codeOf(w.execution.execute("filesystem.list", { root_id: "projects", path: "evil-dir" }, w.ctx)), "TOOL_SCOPE_VIOLATION");
    }
    assert.equal(await codeOf(w.execution.execute("filesystem.read_text", { root_id: "projects", path: ".env" }, w.ctx)), "TOOL_RESOURCE_UNSUPPORTED");
    const example = await w.execution.execute("filesystem.read_text", { root_id: "projects", path: ".env.example" }, w.ctx);
    assert.ok((example.data as { text: string }).text.includes("example"));
    assert.equal(await codeOf(w.execution.execute("filesystem.read_text", { root_id: "projects", path: "alpha" }, w.ctx)), "TOOL_RESOURCE_UNSUPPORTED");
    const brokenStat = await w.execution.execute("filesystem.stat", { root_id: "projects", path: "broken-link" }, w.ctx).catch(() => null);
    if (brokenStat !== null) {
      assert.equal((brokenStat.data as { type: string }).type, "symlink");
      assert.equal(await codeOf(w.execution.execute("filesystem.read_text", { root_id: "projects", path: "broken-link" }, w.ctx)), "TOOL_SCOPE_VIOLATION");
    }
  } finally {
    w.close();
  }
});

test("SC04 adversarial: binary, oversized, paging bounded", async () => {
  const fx = fixture();
  const w = buildWorld(fx);
  try {
    writeFileSync(path.join(fx.projects, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x68, 0x69]));
    assert.equal(await codeOf(w.execution.execute("filesystem.read_text", { root_id: "projects", path: "bin.dat" }, w.ctx)), "TOOL_RESOURCE_UNSUPPORTED");
    writeFileSync(path.join(fx.projects, "big.txt"), "L\n".repeat(5000));
    const page = await w.execution.execute("filesystem.read_text", { root_id: "projects", path: "big.txt", start_line: 1, max_lines: 200 }, w.ctx);
    assert.equal((page.data as { truncated: boolean }).truncated, true);
    assert.ok(Buffer.byteLength((page.data as { text: string }).text, "utf8") <= 12 * 1024);
    assert.equal(await codeOf(w.execution.execute("filesystem.list", { root_id: "projects", path: "alpha", limit: 500 }, w.ctx)), "TOOL_ARGUMENT_INVALID");
    assert.equal(await codeOf(w.execution.execute("filesystem.read_text", { root_id: "projects", path: "big.txt", max_lines: 500 }, w.ctx)), "TOOL_ARGUMENT_INVALID");
    assert.equal(await codeOf(w.execution.execute("filesystem.search", { root_id: "projects", path: "alpha", query: "x".repeat(500) }, w.ctx)), "TOOL_ARGUMENT_INVALID");
  } finally {
    w.close();
  }
});
// ---- app/browser adversarial --------------------------------------------------

test("SC04 adversarial: app injection never spawns", async () => {
  const fx = fixture();
  const w = buildWorld(fx);
  try {
    assert.equal(w.apps.spawnCalls(), 0);
    for (const evil of ["firefox; rm -rf /", "../../bin/sh", "firefox --evil", ""]) {
      const code = await codeOf(w.execution.execute("app.launch", { app_id: evil }, w.ctx));
      assert.ok(code === "TOOL_ARGUMENT_INVALID" || code === "TOOL_CAPABILITY_UNAVAILABLE", evil + " -> " + code);
    }
    assert.equal(await codeOf(w.execution.execute("app.launch", { app_id: "ghost" }, w.ctx)), "TOOL_CAPABILITY_UNAVAILABLE");
    assert.equal(await codeOf(w.execution.execute("app.launch", { app_id: "firefox", executable: "/bin/evil" }, w.ctx)), "TOOL_ARGUMENT_INVALID");
    assert.equal(w.apps.spawnCalls(), 0, "no spawn for rejected proposals");
    await w.execution.execute("app.launch", { app_id: "firefox" }, w.ctx);
    assert.equal(w.apps.spawnCalls(), 1);
  } finally {
    w.close();
  }
});

test("SC04 adversarial: browser dangerous URLs rejected, launcher untouched", async () => {
  const fx = fixture();
  const w = buildWorld(fx);
  try {
    assert.equal(w.browser.openCalls(), 0);
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://x/y", "custom://x"]) {
      assert.equal(await codeOf(w.execution.execute("browser.open_url", { url: bad }, w.ctx)), "TOOL_ARGUMENT_INVALID");
    }
    assert.equal(await codeOf(w.execution.execute("browser.open_url", { url: "https://user:<redacted:nexus-contributor-secret>@example.com/" }, w.ctx)), "TOOL_ARGUMENT_INVALID");
    assert.equal(await codeOf(w.execution.execute("browser.open_url", { url: "https://x.example/" + "a".repeat(5000) }, w.ctx)), "TOOL_ARGUMENT_INVALID");
    assert.equal(w.browser.openCalls(), 0, "launcher never called for rejected URLs");
    await w.execution.execute("browser.open_url", { url: "http://localhost:3000/" }, w.ctx);
    assert.equal(w.browser.openCalls(), 1);
  } finally {
    w.close();
  }
});

test("SC04 secret inheritance: child env carries no ARTHUR secrets", async () => {
  process.env.SUPER_SECRET_CANARY = "canary-sc04";
  const fx = fixture();
  const seen: Array<{ env: NodeJS.ProcessEnv }> = [];
  const scopes = new FilesystemScopeRegistry([
    { id: "projects", label: "P", physical_root: fx.projects, permissions: ["list", "stat", "read", "search"] },
  ]);
  const apps = new NodeLocalApplicationAdapter(
    [{ id: "probe", display_name: "Probe", executable: "/trusted/probe", args: [] }],
    { launcher: async (_exe, _args, env) => { seen.push({ env: env }); }, availability: async () => true },
  );
  const host: LocalCapabilityHost = {
    system: new NodeLocalSystemAdapter(),
    filesystem: new NodeLocalFilesystemAdapter(scopes),
    applications: apps,
    browser: new NodeLocalBrowserAdapter({ launcher: async () => undefined }),
  };
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, new HarnessStubAdapter({ verificationSecret: SIGNING_SECRET }), { host: host });
  const permissions = new PermissionService();
  const store = new SessionStore(":memory:", new SecretSanitizer([]));
  const execution = registry.createExecutionService(permissions);
  store.createSession("s9", ArthurMode.PERSONAL);
  store.createTurn({ id: "t9", sessionId: "s9", role: "user", text: "go", traceId: "t", status: "completed", mode: ArthurMode.PERSONAL });
  const ctx = { session_id: "s9", turn_id: "t9", trace_id: "t", mode: ArthurMode.PERSONAL, approved: false as const };
  try {
    await execution.execute("app.launch", { app_id: "probe" }, ctx);
    assert.equal(seen.length, 1);
    const env = seen[0]?.env ?? {};
    assert.equal(env.SUPER_SECRET_CANARY, undefined);
    assert.equal(env.DEEPSEEK_API_KEY, undefined);
    for (const value of Object.values(env)) {
      if (typeof value === "string") assert.ok(!value.includes("canary-sc04"));
    }
  } finally {
    delete process.env.SUPER_SECRET_CANARY;
    store.close();
  }
});

// ---- model/tool boundary -------------------------------------------------------

test("SC04 model boundary: hostile proposals rejected with zero side effects", async () => {
  const fx = fixture();
  const w = buildWorld(fx);
  try {
    const handling = await w.orchestrator.handleProposed(
      [{ id: "evil-app", name: "app.launch", arguments: { app_id: "firefox; rm -rf /" } }],
      w.ctx,
    );
    assert.equal(handling.summaries[0]?.status, "rejected");
    assert.equal(w.apps.spawnCalls(), 0);
    const handling2 = await w.orchestrator.handleProposed(
      [{ id: "evil-read", name: "filesystem.read_text", arguments: { root_id: "projects", path: "../../secret" } }],
      w.ctx,
    );
    assert.equal(handling2.summaries[0]?.status, "failed");
  } finally {
    w.close();
  }
});

test("SC04 raw capability host is not exposed on the public App", async () => {
  const { buildTestApp } = await import("../helpers");
  const app = buildTestApp();
  try {
    const keys = Object.keys(app);
    for (const forbidden of ["registry", "execution", "orchestrator", "localSystem", "localHost", "localFilesystem", "localBrowser", "localApps", "adapter", "executor", "harness"]) {
      assert.equal(keys.includes(forbidden), false, "App must not expose " + forbidden);
    }
  } finally {
    app.close();
  }
});

test("SC04 no second registry: host has no execute/run/dispatch", async () => {
  const fx = fixture();
  const w = buildWorld(fx);
  try {
    const { readFileSync } = await import("node:fs");
    const hostSource = readFileSync("src/tools/local_host.ts", "utf8");
    const code = hostSource.replace(/\*[\s\S]*?\*/g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.ok(!/\bexecute\s*\(/.test(code), "host must not define execute()");
    assert.ok(!/\brun\s*\(/.test(code), "host must not define run()");
    assert.ok(!/\bdispatch\s*\(/.test(code), "host must not define dispatch()");
  } finally {
    w.close();
  }
});