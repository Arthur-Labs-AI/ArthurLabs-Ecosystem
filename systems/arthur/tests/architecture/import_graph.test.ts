import { test } from "node:test";
import assert from "node:assert/strict";

import { extractImports, resolveImport } from "./import_graph";

test("extractImports finds every import form and ignores strings and comments", () => {
  const source = `
    import a from "pkg-a";
    import type { B } from "pkg-b";
    import "side-effect";
    export * from "./re-export";
    export { c } from "../c";
    export const local = 1;
    const d = await import("dynamic");
    const e = require("req");
    import f = require("equals");
    type G = import("type-import").G;
    const notAnImport = "not-an-import";
    // import commented from "in-comment";
  `;
  assert.deepEqual(extractImports(source, "x.ts").sort(), [
    "../c",
    "./re-export",
    "dynamic",
    "equals",
    "pkg-a",
    "pkg-b",
    "req",
    "side-effect",
    "type-import",
  ]);
});

test("extractImports parses TSX without being confused by JSX text", () => {
  const source = `
    import { useState } from "react";
    export const View = () => <p>import nothing from "here"</p>;
  `;
  assert.deepEqual(extractImports(source, "view.tsx"), ["react"]);
});

test("resolveImport maps relative paths, extensions and the contracts alias", () => {
  assert.deepEqual(resolveImport("src/capture/service.ts", "../cognitive/store/sqlite_store"), {
    kind: "internal",
    path: "src/cognitive/store/sqlite_store",
  });
  assert.deepEqual(resolveImport("src/sync/service.ts", "./transport/contracts.js"), {
    kind: "internal",
    path: "src/sync/transport/contracts",
  });
  assert.deepEqual(resolveImport("apps/arthur/src/app/App.tsx", "@arthur/contracts"), {
    kind: "internal",
    path: "packages/contracts",
  });
  assert.deepEqual(resolveImport("src/a.ts", "./notes.test"), { kind: "internal", path: "src/notes.test" });
  assert.deepEqual(resolveImport("src/a.ts", "node:fs"), { kind: "package", name: "node:fs" });
  assert.deepEqual(resolveImport("src/a.ts", "@tauri-apps/api/core"), { kind: "package", name: "@tauri-apps/api/core" });
});
