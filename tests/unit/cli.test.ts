import { test } from "node:test";
import assert from "node:assert/strict";

import { renderCliError } from "../../apps/cli/index";
import { ArthurError, sessionNotFound } from "../../src/core/errors/errors";
import { buildTestApp } from "../helpers";

test("CLI error rendering uses the configured public sanitization boundary", () => {
  const secret = "cli-configured-secret-987";
  const app = buildTestApp({ deepseekApiKey: secret });
  try {
    const output = renderCliError(sessionNotFound(secret), app);
    assert.ok(output.includes("SESSION_NOT_FOUND"));
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes("stack"));
  } finally {
    app.close();
  }
});

test("CLI generic rendering redacts credential shapes and preserves codes", () => {
  const github = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const output = renderCliError(new ArthurError("INVALID_REQUEST", `bad request ${github}`));
  assert.ok(output.includes("INVALID_REQUEST"));
  assert.ok(!output.includes(github));
});
