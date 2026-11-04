import { test } from "node:test";
import assert from "node:assert/strict";

import { Logger } from "../../src/observability/logging";

test("structured logs redact configured generic and nested credentials", () => {
  const configured = "configured-log-secret-987";
  const github = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const writes: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    new Logger("info", [configured]).error(`failure ${configured} ${github}`, {
      request_id: github,
      nested: { password: "hunter2", input_tokens: 9 },
    });
  } finally {
    process.stderr.write = original;
  }
  const output = writes.join("");
  assert.ok(!output.includes(configured));
  assert.ok(!output.includes(github));
  assert.ok(!output.includes("hunter2"));
  assert.equal((JSON.parse(output) as { nested: { input_tokens: number } }).nested.input_tokens, 9);
});
