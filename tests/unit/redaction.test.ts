import { test } from "node:test";
import assert from "node:assert/strict";

import { redactDeep, redactText } from "../../src/security/redaction";

test("redacts known secrets from text", () => {
  const secret = "sk-1234567890abcdef";
  const out = redactText(`key is ${secret}`, [secret]);
  assert.equal(out, "key is [REDACTED]");
});

test("redacts generic sk- and bearer patterns even without known secrets", () => {
  const out = redactText("auth: Bearer abcdef123456 and sk-abcdefghijkl", []);
  assert.ok(!out.includes("abcdef123456"));
  assert.ok(!out.includes("sk-abcdefghijkl"));
  assert.ok(out.includes("[REDACTED]"));
});

test("redactDeep handles nested objects and arrays", () => {
  const secret = "top-secret-value-123";
  const input = { nested: { key: secret, list: [secret, "ok"] }, safe: "visible" };
  const out = redactDeep(input, [secret]) as { nested: { key: string; list: string[] }; safe: string };
  assert.equal(out.nested.key, "[REDACTED]");
  assert.equal(out.nested.list[0], "[REDACTED]");
  assert.equal(out.nested.list[1], "ok");
  assert.equal(out.safe, "visible");
});

test("redaction is case-insensitive-safe and does not mangle short values", () => {
  assert.equal(redactText("hello", []), "hello");
  assert.equal(redactText("", []), "");
});

test("redacts secret-like key=value and key: value assignments", () => {
  const a = redactText("password=hunter2", []);
  assert.ok(!a.includes("hunter2"));
  assert.ok(a.includes("[REDACTED]"));

  const b = redactText("DEEPSEEK_API_KEY=abc123", []);
  assert.ok(!b.includes("abc123"));
  assert.ok(b.includes("[REDACTED]"));

  const c = redactText("token: abc-def-ghi", []);
  assert.ok(!c.includes("abc-def-ghi"));
  assert.ok(c.includes("[REDACTED]"));

  assert.equal(redactText("color=blue", []), "color=blue");
});



test("redacts JSON-shaped secret assignments (audit F1)", () => {
  const SECRETS = /REALLOOKINGKEY123456|s3cr3t-value|NESTEDKEY123456789|nested-pw|value with spaces|single-quoted|opaque-token/;
  for (const input of [
    '{"api_key": "REALLOOKINGKEY123456"}',
    '{"api_key" : "REALLOOKINGKEY123456"}',
    '{"password": "s3cr3t-value"}',
    '{"client_secret": "xyz"}',
    '{"credentials": {"api_key": "NESTEDKEY123456789", "password": "nested-pw"}}',
    '{"api_key": "value with spaces"}',
    "{'token': 'single-quoted'}",
    '{"access_token": "opaque-token"}',
  ]) {
    const out = redactText(input, []);
    assert.ok(!SECRETS.test(out), `secret value must be redacted from: ${input}`);
    assert.ok(out.includes("[REDACTED]"), `redaction marker must be present for: ${input}`);
  }
  // The redacted output keeps its JSON shape (key quotes preserved).
  assert.equal(redactText('{"api_key": "REALLOOKINGKEY123456"}', []), '{"api_key": "[REDACTED]"}');
  assert.equal(redactText('{"api_key" : "REALLOOKINGKEY123456"}', []), '{"api_key" : "[REDACTED]"}');
  assert.equal(redactText('{"credentials": {"api_key": "NESTEDKEY123456789"}}', []), '{"credentials": {"api_key": "[REDACTED]"}}');
});

test("JSON usage fields and prose with the word token are not false positives (audit F1)", () => {
  for (const input of [
    '{"input_tokens": 123, "token_budget": 456}',
    '{"token_budget": 200}',
    '{"model": "deepseek-chat", "temperature": 0.7}',
    "the token expired yesterday",
    'he said "the password is swordfish"',
    "color=blue",
    "user likes hiking on weekends",
  ]) {
    assert.equal(redactText(input, []), input, `must be left unchanged: ${input}`);
  }
});

test("redacts GitHub tokens and private-key properties without corrupting usage fields", () => {
  const github = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  assert.equal(redactText(`token ${github}`, []).includes(github), false);
  const value = redactDeep({
    private_key: "key material",
    access_token: "opaque-token",
    input_tokens: 11,
    output_tokens: 7,
    token_budget: 100,
  }, []) as Record<string, unknown>;
  assert.equal(value.private_key, "[REDACTED]");
  assert.equal(value.access_token, "[REDACTED]");
  assert.equal(value.input_tokens, 11);
  assert.equal(value.output_tokens, 7);
  assert.equal(value.token_budget, 100);
});

test("redactDeep replaces values under unconfigured secret-like keys", () => {
  const value = redactDeep({ password: "opaque-value", nested: { customApiKey: "another-value", safe: "ok" } }, []);
  assert.deepEqual(value, { password: "[REDACTED]", nested: { customApiKey: "[REDACTED]", safe: "ok" } });
});
