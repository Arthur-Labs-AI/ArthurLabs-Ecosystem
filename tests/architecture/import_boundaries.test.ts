import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import { BOUNDARY_RULES, checkFile } from "./boundary_rules";
import type { BoundaryRule, Violation } from "./boundary_rules";
import { findRepoRoot, listSourceFiles } from "./import_graph";

const root = findRepoRoot();

function scan(rule: BoundaryRule): { files: number; violations: Violation[] } {
  const files = [...new Set(rule.roots.flatMap((dir) => listSourceFiles(root, dir)))];
  const violations = files.flatMap((file) => checkFile(rule, file, readFileSync(path.join(root, file), "utf8")));
  return { files: files.length, violations };
}

for (const rule of BOUNDARY_RULES) {
  test(`boundary "${rule.id}" holds across the repository`, () => {
    const { files, violations } = scan(rule);
    assert.ok(files > 0, `rule ${rule.id} matched no source files; its roots no longer exist (${rule.roots.join(", ")})`);
    assert.deepEqual(
      violations,
      [],
      `${rule.why}\n${violations.map((v) => `  ${v.file}: ${v.detail}`).join("\n")}`,
    );
  });
}

/**
 * Proof that each rule actually detects what it claims to forbid, and still
 * permits what it must allow. Without this a rule that matches nothing would
 * pass forever.
 */
interface RuleCase {
  file: string;
  source: string;
}

const SYNTHETIC: Record<string, { violating: RuleCase[]; allowed: RuleCase[] }> = {
  "contracts-are-pure": {
    violating: [
      { file: "packages/contracts/x.ts", source: 'import React from "react";' },
      { file: "packages/contracts/x.ts", source: 'import { f } from "node:fs";' },
      { file: "packages/contracts/x.ts", source: 'import { m } from "../../src/memory/api";' },
    ],
    allowed: [{ file: "packages/contracts/x.ts", source: 'import { a } from "./capture"; export type T = typeof a;' }],
  },
  "frozen-agentic-does-not-host-new-domains": {
    violating: [
      { file: "src/tools/registry.ts", source: 'import { s } from "../sync/service";' },
      { file: "src/runtime/hybrid/lan/tool_client.ts", source: 'import { c } from "../../../cognitive/service";' },
      { file: "src/tools/registry.ts", source: 'import type { Capture } from "@arthur/contracts";' },
    ],
    allowed: [{ file: "src/tools/registry.ts", source: 'import { m } from "../models/contracts";' }],
  },
  "capture-does-not-reach-cognition": {
    violating: [
      { file: "src/capture/service.ts", source: 'import { store } from "../cognitive/store/sqlite_store";' },
      { file: "src/capture/sources/emg.ts", source: 'import { d } from "../../devices/registry";' },
      { file: "src/capture/service.ts", source: 'import { r } from "../tools/registry";' },
    ],
    allowed: [
      { file: "src/capture/service.ts", source: 'import type { Capture } from "@arthur/contracts";' },
      { file: "src/capture/service.ts", source: 'import { g } from "../models/gateway";' },
    ],
  },
  "devices-do-not-reach-cognition": {
    violating: [
      { file: "src/devices/emg/service.ts", source: 'import { s } from "../../cognitive/service";' },
      { file: "src/devices/emg/service.ts", source: 'import { r } from "../../tools/registry";' },
    ],
    allowed: [{ file: "src/devices/emg/service.ts", source: 'import type { Capture } from "@arthur/contracts";' }],
  },
  "cognitive-works-without-agentic-layer": {
    violating: [
      { file: "src/cognitive/service.ts", source: 'import { ToolRegistry } from "../tools/registry";' },
      { file: "src/cognitive/service.ts", source: 'import { c } from "../runtime/hybrid/lan/tool_client";' },
      { file: "src/cognitive/service.ts", source: 'import { r } from "../runtime/hybrid/tools/attempt_router";' },
      { file: "src/cognitive/service.ts", source: 'import { d } from "../devices/registry";' },
    ],
    allowed: [
      { file: "src/cognitive/index/memory_projection.ts", source: 'import { m } from "../../memory/api";' },
      { file: "src/cognitive/service.ts", source: 'import { c } from "../runtime/hybrid/lan/client";' },
    ],
  },
  "sync-is-not-agentic": {
    violating: [{ file: "src/sync/service.ts", source: 'import { p } from "../runtime/hybrid/tools/attempt_router";' }],
    allowed: [{ file: "src/sync/host/receiver.ts", source: 'import { s } from "../../cognitive/service";' }],
  },
  "sync-protocol-is-transport-independent": {
    violating: [
      { file: "src/sync/service.ts", source: 'import { T } from "./transport/private_overlay";' },
      { file: "src/sync/outbox/worker.ts", source: 'import { T } from "../transport";' },
      { file: "src/sync/client/sync_client.ts", source: 'import ts from "tailscale-client";' },
    ],
    allowed: [
      { file: "src/sync/service.ts", source: 'import type { HomeNodeTransport } from "./transport/contracts";' },
      { file: "src/sync/transport/private_overlay.ts", source: 'import { x } from "tailscale-client";' },
    ],
  },
  "core-does-not-import-product-app": {
    violating: [
      { file: "src/app.ts", source: 'import { App } from "../apps/arthur/src/app/App";' },
      { file: "apps/api/server.ts", source: 'import { v } from "../arthur/vite.config";' },
    ],
    allowed: [{ file: "src/app.ts", source: 'import { s } from "./config/settings";' }],
  },
  "ui-does-not-import-core-or-node": {
    violating: [
      { file: "apps/arthur/src/features/x/y.ts", source: 'import { db } from "../../../../../src/memory/api";' },
      { file: "apps/arthur/src/features/x/y.ts", source: 'import { readFileSync } from "node:fs";' },
      { file: "apps/arthur/src/features/x/y.ts", source: 'import Database from "better-sqlite3";' },
    ],
    allowed: [{ file: "apps/arthur/src/features/x/y.ts", source: 'import { useState } from "react";' }],
  },
  "tauri-api-stays-inside-client-ipc": {
    violating: [
      { file: "apps/arthur/src/features/x/y.ts", source: 'import { invoke } from "@tauri-apps/api/core";' },
      { file: "apps/arthur/src/client/desktop-client.ts", source: 'import { invoke } from "@tauri-apps/api/core";' },
    ],
    allowed: [{ file: "apps/arthur/src/client/tauri-ipc.ts", source: 'import { invoke } from "@tauri-apps/api/core";' }],
  },
  "ui-uses-the-client-interface-only": {
    violating: [
      { file: "apps/arthur/src/features/x/y.tsx", source: 'import { c } from "../../client/desktop-client";' },
      { file: "apps/arthur/src/hooks/h.ts", source: 'import { c } from "../client";' },
    ],
    allowed: [
      { file: "apps/arthur/src/features/x/y.tsx", source: 'import type { ArthurClient } from "../../client/arthur-client";' },
      { file: "apps/arthur/src/app/providers.tsx", source: 'import { createArthurClient } from "../client";' },
      { file: "apps/arthur/src/app/App.test.tsx", source: 'import { c } from "../client/preview-client";' },
    ],
  },
  "ui-has-no-network-details": {
    violating: [
      { file: "apps/arthur/src/features/x/y.ts", source: 'const r = await fetch("/api/ideas");' },
      { file: "apps/arthur/src/features/x/y.ts", source: 'const u = "http://localhost:8080/v1";' },
      { file: "apps/arthur/src/hooks/h.ts", source: 'const s = new WebSocket("ws://100.64.0.1");' },
      { file: "apps/arthur/src/hooks/h.ts", source: 'const h = "arthur-pc.tail1234.ts.net";' },
    ],
    allowed: [
      { file: "apps/arthur/src/features/x/y.ts", source: "const r = fetchRuntimeInfo();" },
      { file: "apps/arthur/src/app/App.test.tsx", source: 'const u = "http://localhost:1420";' },
    ],
  },
};

test("every boundary rule has synthetic violating and allowed cases", () => {
  assert.deepEqual(Object.keys(SYNTHETIC).sort(), BOUNDARY_RULES.map((rule) => rule.id).sort());
});

for (const rule of BOUNDARY_RULES) {
  test(`boundary "${rule.id}" flags violations and permits allowed code`, () => {
    const cases = SYNTHETIC[rule.id];
    assert.ok(cases, `missing synthetic cases for ${rule.id}`);
    assert.ok(cases.violating.length > 0 && cases.allowed.length > 0);

    for (const { file, source } of cases.violating) {
      assert.ok(checkFile(rule, file, source).length > 0, `${file} should violate ${rule.id}: ${source}`);
    }
    for (const { file, source } of cases.allowed) {
      assert.deepEqual(checkFile(rule, file, source), [], `${file} should be allowed by ${rule.id}: ${source}`);
    }
  });
}
