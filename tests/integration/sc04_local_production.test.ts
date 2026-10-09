/**
 * TASK-0025 production-path regression: ARTHUR_LOCAL_CONFIG -> buildApp.
 *
 * Uses the SAME normal configuration/loading path as CLI/API (env setting
 * ARTHUR_LOCAL_CONFIG plus buildApp with NO deps.localConfig injection).
 * Proves:
 *   - no local config       -> app.list is empty, default workspace
 *     filesystem behavior unchanged;
 *   - valid trusted config  -> the configured application appears through
 *     app.list with no physical path leak, and filesystem scopes/bounds
 *     come from the same file;
 *   - invalid configured file -> startup fails closed with INVALID_CONFIG.
 *
 * We never inject deps.localConfig: that would repeat the gap this
 * regression closes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { ArthurError } from "../../src/core/errors/errors";
import { buildApp } from "../../src/app";
import { loadSettings } from "../../src/config/settings";
import {
  LOCAL_CONFIG_MAX_BYTES,
  loadLocalCapabilityConfigFromFile,
} from "../../src/tools/local_config_file";

/** Env-backed production build: same path as apps/cli + apps/api (buildApp, no deps). */
function buildProductionApp(): ReturnType<typeof buildApp> {
  return buildApp({
    dbPath: ":memory:",
    modelProvider: "fake",
    logLevel: "error",
    memoryPersonalDbPath: ":memory:",
    memoryBusinessDbPath: ":memory:",
    embeddingProvider: "fake",
  });
}

function withEnv(key: string, value: string | undefined, run: () => void): void {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    run();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

function withEnvAsync(key: string, value: string | undefined, run: () => Promise<void>): Promise<void> {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return run().finally(() => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  });
}

const EXEC_CTX = { session_id: "s", turn_id: "t", trace_id: "tr", mode: "personal", approved: false } as const;

async function executeProductionTool(
  app: ReturnType<typeof buildApp>,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; data: unknown }> {
  const { PermissionService } = await import("../../src/tools/permissions");
  const execution = app.conversation.registryForTests().createExecutionService(new PermissionService());
  const result = await execution.execute(tool, args, { ...EXEC_CTX });
  assert.equal(result.ok, true, tool + " must succeed");
  return result as { ok: boolean; data: unknown };
}

/** Absolute fixture executable: the running Node binary (exists, executable). */
function fixtureExecutable(): string {
  assert.ok(path.isAbsolute(process.execPath), "test harness needs an absolute executable");
  return process.execPath;
}

function writeConfigFile(dir: string, name: string, config: unknown): string {
  const file = path.join(dir, name);
  writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config));
  return file;
}

function validConfig(scopeRoot: string): Record<string, unknown> {
  return {
    filesystem_roots: [
      { id: "workspace", label: "Workspace", physical_root: scopeRoot, permissions: ["list", "stat", "read", "search"] },
    ],
    applications: [
      { id: "test_app", display_name: "Test App", executable: fixtureExecutable(), args: [] as string[] },
    ],
  };
}

test("production startup without ARTHUR_LOCAL_CONFIG lists zero applications with default workspace behavior", async () => {
  const savedLocal = process.env.ARTHUR_LOCAL_CONFIG;
  const savedGit = process.env.ARTHUR_GIT_CONFIG;
  delete process.env.ARTHUR_LOCAL_CONFIG;
  delete process.env.ARTHUR_GIT_CONFIG;
  try {
    const app = buildProductionApp();
    try {
      const listed = await executeProductionTool(app, "app.list", {});
      const applications = (listed.data as { applications: Array<{ id: string; name: string; available: boolean }> })
        .applications;
      assert.deepEqual(applications, [], "no config must mean an empty application catalog");
      const roots = await executeProductionTool(app, "filesystem.roots", {});
      assert.deepEqual((roots.data as { roots: unknown }).roots, [{ id: "workspace", label: "Workspace" }]);
    } finally {
      app.close();
    }
  } finally {
    if (savedLocal === undefined) delete process.env.ARTHUR_LOCAL_CONFIG;
    else process.env.ARTHUR_LOCAL_CONFIG = savedLocal;
    if (savedGit === undefined) delete process.env.ARTHUR_GIT_CONFIG;
    else process.env.ARTHUR_GIT_CONFIG = savedGit;
  }
});

test("loadSettings maps ARTHUR_LOCAL_CONFIG into localConfigPath (env + override parity)", () => {
  withEnv("ARTHUR_LOCAL_CONFIG", ".arthur-local.json", () => {
    assert.equal(loadSettings({ modelProvider: "fake" }).localConfigPath, ".arthur-local.json");
  });
  withEnv("ARTHUR_LOCAL_CONFIG", undefined, () => {
    assert.equal(
      loadSettings({ modelProvider: "fake", localConfigPath: ".arthur-local.json" }).localConfigPath,
      ".arthur-local.json",
    );
    assert.equal(loadSettings({ modelProvider: "fake" }).localConfigPath, "");
  });
});

test("production startup with a valid trusted config exposes the configured app with no path leak", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sc04-prodreg-"));
  try {
    const configPath = writeConfigFile(dir, "local.json", validConfig(dir));
    await withEnvAsync("ARTHUR_LOCAL_CONFIG", configPath, async () => {
      const app = buildProductionApp();
      try {
        const listed = await executeProductionTool(app, "app.list", {});
        const applications = (listed.data as { applications: Array<Record<string, unknown>> }).applications;
        assert.equal(applications.length, 1);
        assert.deepEqual(applications[0], { id: "test_app", name: "Test App", available: true });
        const leaked = JSON.stringify(listed);
        assert.ok(!leaked.includes(fixtureExecutable()), "app.list must not leak the physical executable path");
      } finally {
        app.close();
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("production filesystem scopes and bounds come from the same trusted local config", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sc04-prodfs-"));
  try {
    const scopeRoot = path.join(dir, "scope");
    mkdirSync(scopeRoot, { recursive: true });
    writeFileSync(path.join(scopeRoot, "note.txt"), "hello production scope\n");
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(path.join(scopeRoot, "needle-" + i + ".txt"), "content\n");
    }
    const configPath = writeConfigFile(dir, "local.json", {
      filesystem_roots: [
        { id: "custom", label: "Custom", physical_root: scopeRoot, permissions: ["list", "stat", "read", "search"] },
      ],
      applications: [{ id: "test_app", display_name: "Test App", executable: fixtureExecutable(), args: [] as string[] }],
      filesystem_bounds: {
        list_limit_max: 200,
        read_max_lines: 200,
        read_max_bytes: 12288,
        search_max_results: 2,
        search_max_files: 5000,
        search_max_bytes_per_file: 1048576,
        search_max_total_bytes: 52428800,
      },
    });
    await withEnvAsync("ARTHUR_LOCAL_CONFIG", configPath, async () => {
      const app = buildProductionApp();
      try {
        // Scope identity comes from the file (not the process-cwd default).
        const roots = await executeProductionTool(app, "filesystem.roots", {});
        assert.deepEqual((roots.data as { roots: unknown }).roots, [{ id: "custom", label: "Custom" }]);
        // Reads flow through the configured scope.
        const read = await executeProductionTool(app, "filesystem.read_text", {
          root_id: "custom",
          path: "note.txt",
        });
        assert.ok((read.data as { text: string }).text.includes("hello production scope"));
        // The default workspace scope is gone (replaced, not duplicated).
        const { PermissionService } = await import("../../src/tools/permissions");
        const execution = app.conversation.registryForTests().createExecutionService(new PermissionService());
        await assert.rejects(
          execution.execute("filesystem.list", { root_id: "workspace", path: "." }, { ...EXEC_CTX }),
          (err: unknown) => err instanceof ArthurError && err.code === "TOOL_SCOPE_VIOLATION",
        );
        // Adapter search bounds come from the same file (2, not the default 50).
        const search = await executeProductionTool(app, "filesystem.search", {
          root_id: "custom",
          path: ".",
          query: "needle",
          mode: "filename",
          max_results: 50,
        });
        assert.equal((search.data as { matches: unknown[] }).matches.length, 2);
      } finally {
        app.close();
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("production startup fails closed (INVALID_CONFIG) on a bad configured local file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sc04-prodbad-"));
  try {
    const cases: Array<{ name: string; body: string }> = [
      { name: "bad.json", body: "{ not json" },
      { name: "relative-exe.json", body: JSON.stringify({ ...validConfig(dir), applications: [{ id: "test_app", display_name: "Test App", executable: "relative/app.exe", args: [] }] }) },
      { name: "duplicate-ids.json", body: JSON.stringify({ ...validConfig(dir), applications: [{ id: "test_app", display_name: "A", executable: fixtureExecutable(), args: [] }, { id: "test_app", display_name: "B", executable: fixtureExecutable(), args: [] }] }) },
      { name: "shell-field.json", body: JSON.stringify({ ...validConfig(dir), applications: [{ id: "test_app", display_name: "Test App", executable: fixtureExecutable(), args: [], shell: true }] }) },
      { name: "relative-root.json", body: JSON.stringify({ ...validConfig(dir), filesystem_roots: [{ id: "workspace", label: "W", physical_root: "relative/path", permissions: ["list"] }] }) },
    ];
    for (const c of cases) {
      const file = writeConfigFile(dir, c.name, c.body);
      withEnv("ARTHUR_LOCAL_CONFIG", file, () => {
        assert.throws(
          () => {
            const app = buildProductionApp();
            app.close();
          },
          (err: unknown) => err instanceof ArthurError && err.code === "INVALID_CONFIG",
          c.name + " must fail closed",
        );
      });
    }
    const missing = path.join(dir, "does-not-exist.json");
    withEnv("ARTHUR_LOCAL_CONFIG", missing, () => {
      assert.throws(
        () => {
          const app = buildProductionApp();
          app.close();
        },
        (err: unknown) => err instanceof ArthurError && err.code === "INVALID_CONFIG",
        "missing file must fail closed",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local config loader is BOM-tolerant and size-bounded", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sc04-prodloader-"));
  try {
    const bomFile = path.join(dir, "bom.json");
    writeFileSync(bomFile, "\ufeff" + JSON.stringify(validConfig(dir)));
    const loaded = loadLocalCapabilityConfigFromFile(bomFile);
    assert.equal(loaded.applications[0]?.id, "test_app");
    const bigFile = path.join(dir, "big.json");
    writeFileSync(bigFile, "x".repeat(LOCAL_CONFIG_MAX_BYTES + 1));
    assert.throws(
      () => loadLocalCapabilityConfigFromFile(bigFile),
      (err: unknown) => err instanceof ArthurError && err.code === "INVALID_CONFIG",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
