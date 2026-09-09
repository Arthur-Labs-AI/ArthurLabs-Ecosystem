/**
 * TASK-0011 focused unit tests: local system capability adapter (A, B) and
 * system.status registry availability/contract (C-G).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ArthurMode } from "../../src/core/modes/mode";
import { HarnessStubAdapter } from "../../src/tools/adapters/harness_stub";
import {
  LocalSystemAdapter,
  LocalSystemStatus,
  NodeLocalSystemAdapter,
} from "../../src/tools/adapters/local_system";
import { registerBuiltinTools } from "../../src/tools/builtin";
import { ToolRegistry } from "../../src/tools/registry";

/** Deterministic fake adapter for registry-level tests (no machine variance). */
class FakeLocalSystemAdapter implements LocalSystemAdapter {
  constructor(private readonly status: LocalSystemStatus) {}
  async getStatus(): Promise<LocalSystemStatus> {
    return { ...this.status };
  }
}

const FAKE_STATUS: LocalSystemStatus = {
  platform: "win32",
  arch: "x64",
  node_version: "v22.0.0-fake",
  uptime_seconds: 1234,
  cpu_count: 12,
  total_memory_bytes: 32 * 2 ** 30,
  free_memory_bytes: 16 * 2 ** 30,
};

const EXPECTED_FIELDS = [
  "platform",
  "arch",
  "node_version",
  "uptime_seconds",
  "cpu_count",
  "total_memory_bytes",
  "free_memory_bytes",
] as const;

// ---- A: real adapter returns a valid status shape ---------------------------

test("A: NodeLocalSystemAdapter returns the exact non-sensitive status shape", async () => {
  const status = await new NodeLocalSystemAdapter().getStatus();
  assert.deepEqual(Object.keys(status).sort(), [...EXPECTED_FIELDS].sort());
  assert.equal(status.platform, process.platform);
  assert.equal(status.arch, process.arch);
  assert.equal(status.node_version, process.version);
  assert.equal(Number.isInteger(status.uptime_seconds), true);
  assert.equal(Number.isInteger(status.cpu_count), true);
  assert.equal(Number.isInteger(status.total_memory_bytes), true);
  assert.equal(Number.isInteger(status.free_memory_bytes), true);
  assert.ok(status.uptime_seconds >= 0);
  assert.ok(status.cpu_count >= 1);
  assert.ok(status.total_memory_bytes >= 0);
  assert.ok(status.free_memory_bytes >= 0);
  assert.ok(status.free_memory_bytes <= status.total_memory_bytes);
});

test("A: NodeLocalSystemAdapter clamps values into the declared schema bounds", async () => {
  const status = await new NodeLocalSystemAdapter().getStatus();
  assert.ok(status.uptime_seconds >= 0, "uptime >= 0");
  assert.ok(status.cpu_count >= 1, "cpu_count >= 1");
  assert.ok(status.total_memory_bytes >= 0, "total memory >= 0");
  assert.ok(status.free_memory_bytes >= 0, "free memory >= 0");
});

// ---- B: no env/secret/path-like privileged data -----------------------------

const PRIVILEGED_ENV_NAMES = [
  "USERNAME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "PATH",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMPUTERNAME",
  "USERDOMAIN",
  "SESSIONNAME",
  "TEMP",
  "TMP",
  "PROCESSOR_ARCHITECTURE",
  "COMSPEC",
  "SHELL",
];

test("B: real adapter output contains no environment, secret, or path-like data", async () => {
  const status = await new NodeLocalSystemAdapter().getStatus();
  const json = JSON.stringify(status);

  // String fields are simple identifiers/versions only: no separators, no
  // spaces, no absolute-path syntax.
  for (const field of ["platform", "arch", "node_version"] as const) {
    assert.match(status[field], /^[A-Za-z0-9._-]+$/, field + " must be a plain identifier/version string");
  }

  // No value of any well-known privileged environment variable appears.
  for (const name of PRIVILEGED_ENV_NAMES) {
    const value = process.env[name];
    if (value === undefined || value.length === 0) continue;
    assert.ok(!json.includes(value), "output must not contain value of " + name);
  }

  // No long environment value (>= 8 chars) appears anywhere in the output.
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    assert.ok(!json.includes(value), "output must not contain environment value of " + name);
  }

  // No environment variable NAME is echoed as a value.
  for (const field of ["platform", "arch", "node_version"] as const) {
    assert.equal(Object.values(process.env).includes(status[field]), false, field + " must not be an env value");
  }
});

// ---- C-G: registry availability and strict contract -------------------------

function buildRegistry(adapter: LocalSystemAdapter = new FakeLocalSystemAdapter(FAKE_STATUS)): ToolRegistry {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, new HarnessStubAdapter(), adapter);
  return registry;
}

test("C: system.status is registered as version 1.0.0", () => {
  const registry = buildRegistry();
  assert.equal(registry.has("system.status"), true);
  const definition = registry.getDefinition("system.status");
  assert.ok(definition);
  assert.equal(definition.version, "1.0.0");
});

test("D: system.status is available in PERSONAL mode", () => {
  const registry = buildRegistry();
  const names = registry.listAllowedForMode(ArthurMode.PERSONAL).map((d) => d.name);
  assert.ok(names.includes("system.status"));
});

test("E: system.status is available in BUSINESS mode", () => {
  const registry = buildRegistry();
  const names = registry.listAllowedForMode(ArthurMode.BUSINESS).map((d) => d.name);
  assert.ok(names.includes("system.status"));
});

test("F: system.status risk is read", () => {
  const registry = buildRegistry();
  assert.equal(registry.getDefinition("system.status")?.risk, "read");
});

test("G: system.status declares a strict output schema that is enforced", () => {
  const registry = buildRegistry();
  const definition = registry.getDefinition("system.status");
  assert.ok(definition?.output_schema, "output_schema must be declared");
  assert.equal(definition.output_schema.additionalProperties, false);
  assert.deepEqual(
    [...(definition.output_schema.required as string[])].sort(),
    [...EXPECTED_FIELDS].sort(),
  );

  // Valid data passes.
  assert.equal(registry.validateOutput("system.status", { ...FAKE_STATUS }).valid, true);

  // Extra field: rejected.
  assert.equal(
    registry.validateOutput("system.status", { ...FAKE_STATUS, extra: 1 }).valid,
    false,
    "additionalProperties: false must reject unknown fields",
  );
  // Missing field: rejected.
  const { free_memory_bytes: _omitted, ...missing } = FAKE_STATUS;
  assert.equal(registry.validateOutput("system.status", missing).valid, false);
  // Wrong type: rejected.
  assert.equal(
    registry.validateOutput("system.status", { ...FAKE_STATUS, platform: 123 }).valid,
    false,
  );
  // Out-of-bounds numbers: rejected.
  assert.equal(registry.validateOutput("system.status", { ...FAKE_STATUS, uptime_seconds: -1 }).valid, false);
  assert.equal(registry.validateOutput("system.status", { ...FAKE_STATUS, cpu_count: 0 }).valid, false);
  assert.equal(registry.validateOutput("system.status", { ...FAKE_STATUS, total_memory_bytes: -5 }).valid, false);
  assert.equal(registry.validateOutput("system.status", { ...FAKE_STATUS, free_memory_bytes: -5 }).valid, false);
  // Non-integer cpu/memory: rejected.
  assert.equal(registry.validateOutput("system.status", { ...FAKE_STATUS, cpu_count: 1.5 }).valid, false);

  // Strict input schema: no arguments accepted beyond an empty object.
  assert.equal(registry.validateArgs("system.status", {}).valid, true);
  assert.equal(registry.validateArgs("system.status", { verbose: true }).valid, false);
});

test("G: registry exposes the SC-04 catalog - no exec/shell-like tools", () => {
  const registry = buildRegistry();
  const names = registry.list().map((d) => d.name).sort();
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
  for (const banned of ["shell.exec", "process.exec", "terminal.exec", "filesystem.write", "app.kill", "browser.control", "system.shutdown", "network.request"]) {
    assert.equal(names.includes(banned), false, "must not expose " + banned);
  }
});
