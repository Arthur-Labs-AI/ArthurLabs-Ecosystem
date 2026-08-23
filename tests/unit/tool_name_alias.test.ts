import { test } from "node:test";
import assert from "node:assert/strict";

import {
  encodeProviderName,
  PROVIDER_SAFE_FUNCTION_NAME_PATTERN,
  ToolNameAliasCollisionError,
  ToolNameAliasInvalidError,
  ToolNameAliasMap,
  ToolNameAliasUnknownError,
} from "../../src/models/providers/tool_name_alias";

// ---- TASK-0006 regression coverage --------------------------------------
// 1. dotted canonical name -> DeepSeek-safe alias
// 2. alias -> canonical roundtrip
// 4. aliases match ^[a-zA-Z0-9_-]+$
// 7. unknown provider alias rejected
// 8. alias for a tool not exposed in that model request rejected
// 9. collision detected before provider request (map construction throws)

test("1: dotted canonical names encode to DeepSeek-safe aliases", () => {
  assert.equal(encodeProviderName("system.echo"), "system__echo");
  assert.equal(encodeProviderName("harness.create_job"), "harness__create_job");
  assert.equal(encodeProviderName("harness.get_job"), "harness__get_job");
  assert.equal(encodeProviderName("memory.remember"), "memory__remember");
  assert.equal(encodeProviderName("memory.search"), "memory__search");
});

test("2: alias -> canonical roundtrip resolves only exposed names", () => {
  const map = ToolNameAliasMap.fromExposedNames([
    "system.echo",
    "harness.create_job",
    "harness.get_job",
    "memory.remember",
    "memory.search",
  ]);
  assert.equal(map.providerToCanonical("system__echo"), "system.echo");
  assert.equal(map.providerToCanonical("harness__create_job"), "harness.create_job");
  assert.equal(map.providerToCanonical("harness__get_job"), "harness.get_job");
  assert.equal(map.providerToCanonical("memory__remember"), "memory.remember");
  assert.equal(map.providerToCanonical("memory__search"), "memory.search");
  // canonicalToProvider must reproduce the alias deterministically.
  assert.equal(map.canonicalToProvider("system.echo"), "system__echo");
});

test("all aliases for the canonical tool set are unique and regex-safe", () => {
  const exposed = ["system.echo", "harness.create_job", "harness.get_job", "memory.remember", "memory.search"];
  const map = ToolNameAliasMap.fromExposedNames(exposed);
  const aliases = map.providerNames();
  assert.equal(aliases.length, exposed.length);
  assert.equal(new Set(aliases).size, exposed.length, "aliases must be unique for the exposed set");
  for (const alias of aliases) {
    assert.match(alias, PROVIDER_SAFE_FUNCTION_NAME_PATTERN);
    assert.ok(!alias.includes("."));
  }
});

test("names without dots pass through unchanged", () => {
  const map = ToolNameAliasMap.fromExposedNames(["echo", "status_check", "job-1"]);
  assert.equal(map.canonicalToProvider("echo"), "echo");
  assert.equal(map.canonicalToProvider("status_check"), "status_check");
  assert.equal(map.canonicalToProvider("job-1"), "job-1");
  assert.equal(map.providerToCanonical("echo"), "echo");
  assert.equal(map.providerToCanonical("status_check"), "status_check");
  assert.equal(map.providerToCanonical("job-1"), "job-1");
});

test("7: unknown provider alias is rejected, even when regex-valid", () => {
  const map = ToolNameAliasMap.fromExposedNames(["system.echo"]);
  assert.throws(() => map.providerToCanonical("totally__made_up"), ToolNameAliasUnknownError);
  assert.throws(() => map.providerToCanonical("echo"), ToolNameAliasUnknownError);
  assert.equal(map.hasProviderName("system__echo"), true);
  assert.equal(map.hasProviderName("memory__remember"), false);
  assert.equal(map.hasCanonicalName("system.echo"), true);
  assert.equal(map.hasCanonicalName("memory.remember"), false);
});

test("8: a name that is not exposed in THIS request is never resolvable", () => {
  // Request A exposes system.echo only.
  const requestA = ToolNameAliasMap.fromExposedNames(["system.echo"]);
  // Request B exposes memory.remember only.
  const requestB = ToolNameAliasMap.fromExposedNames(["memory.remember"]);
  // The alias from request B is meaningless in request A even though it is
  // perfectly regex-valid and maps elsewhere.
  assert.throws(() => requestA.providerToCanonical("memory__remember"), ToolNameAliasUnknownError);
  assert.equal(requestB.providerToCanonical("memory__remember"), "memory.remember");
  // And the canonical name of B is not exposed in A either.
  assert.equal(requestA.hasCanonicalName("memory.remember"), false);
});

test("9: collisions between dotted and pre-encoded names fail closed", () => {
  // a.b -> a__b collides with the canonical a__b.
  assert.throws(
    () => ToolNameAliasMap.fromExposedNames(["a.b", "a__b"]),
    (err: unknown) => err instanceof ToolNameAliasCollisionError && err.message.includes("a.b") && err.message.includes("a__b"),
  );
  // Duplicate exposure of the same canonical name also fails closed.
  assert.throws(
    () => ToolNameAliasMap.fromExposedNames(["a.b", "a.b"]),
    ToolNameAliasCollisionError,
  );
  // Order independence: the same pair collides whichever order is supplied.
  assert.throws(() => ToolNameAliasMap.fromExposedNames(["a__b", "a.b"]), ToolNameAliasCollisionError);
});

test("collisions are detected for deep dotted names too", () => {
  // a.b.c -> a__b__c collides with canonical a__b__c.
  assert.throws(() => ToolNameAliasMap.fromExposedNames(["a.b.c", "a__b__c"]), ToolNameAliasCollisionError);
  // a.b.c -> a__b__c AND a__b.c -> a__b__c: the trailing dot encodes too, so
  // this pair also collides and must fail closed.
  assert.throws(() => ToolNameAliasMap.fromExposedNames(["a.b.c", "a__b.c"]), ToolNameAliasCollisionError);
  // Genuinely distinct: a.b -> a__b and a_b.c -> a_b__c.
  const ok = ToolNameAliasMap.fromExposedNames(["a.b", "a_b.c"]);
  assert.equal(ok.size, 2);
  assert.equal(ok.providerToCanonical("a__b"), "a.b");
  assert.equal(ok.providerToCanonical("a_b__c"), "a_b.c");
});

test("names that cannot be encoded safely are rejected", () => {
  assert.throws(() => ToolNameAliasMap.fromExposedNames([""]), ToolNameAliasInvalidError);
  assert.throws(() => ToolNameAliasMap.fromExposedNames(["has space"]), ToolNameAliasInvalidError);
  assert.throws(() => ToolNameAliasMap.fromExposedNames(["quote\"name"]), ToolNameAliasInvalidError);
});

test("empty exposed set builds an empty map", () => {
  const map = ToolNameAliasMap.fromExposedNames([]);
  assert.equal(map.size, 0);
  assert.deepEqual(map.providerNames(), []);
  assert.throws(() => map.providerToCanonical("anything"), ToolNameAliasUnknownError);
});

test("fromToolSchemas derives the map from the exact request tool set", () => {
  const map = ToolNameAliasMap.fromToolSchemas([{ name: "system.echo" }, { name: "harness.status" }]);
  assert.equal(map.size, 2);
  assert.equal(map.providerToCanonical("system__echo"), "system.echo");
  assert.equal(map.providerToCanonical("harness__status"), "harness.status");
});

test("bijection: every exposed canonical maps to exactly one alias and back", () => {
  const exposed = ["system.echo", "harness.create_job", "harness.get_job", "memory.remember", "memory.search", "plain", "x-y_z"];
  const map = ToolNameAliasMap.fromExposedNames(exposed);
  const canonical = map.canonicalNames();
  assert.equal(canonical.length, exposed.length);
  for (const name of exposed) {
    const alias = map.canonicalToProvider(name);
    assert.match(alias, PROVIDER_SAFE_FUNCTION_NAME_PATTERN);
    assert.equal(map.providerToCanonical(alias), name);
    assert.equal(map.hasProviderName(alias), true);
  }
});
