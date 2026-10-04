import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RELATION_DIRECTIONS,
  RELATION_ERROR_CODES,
  RELATION_KINDS,
  RELATION_ORIGINS,
  SYMMETRIC_RELATION_KINDS,
  canonicalRelationEnds,
  describeCreateRelationInputProblem,
  isCognitiveRelation,
  isRelationDirection,
  isRelationErrorPayload,
  isRelationKind,
  isRelationOrigin,
  isSymmetricRelationKind,
} from "../../packages/contracts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const valid = { id: "r1", kind: "extends", sourceObjectId: B, targetObjectId: A, createdAt: "2026-10-04T12:00:00Z", origin: "user" };

test("the seven architecture-defined relation kinds, and nothing else, are valid", () => {
  assert.deepEqual([...RELATION_KINDS], ["related_to", "extends", "depends_on", "contradicts", "derived_from", "duplicates", "supersedes"]);
  for (const kind of RELATION_KINDS) assert.equal(isRelationKind(kind), true);
  for (const bad of ["RELATED", "related", "Extends", "", null, 3, "friends_with"]) assert.equal(isRelationKind(bad), false);
});

test("exactly related_to, contradicts and duplicates are symmetric", () => {
  assert.deepEqual([...SYMMETRIC_RELATION_KINDS].sort(), ["contradicts", "duplicates", "related_to"]);
  for (const kind of RELATION_KINDS) assert.equal(isSymmetricRelationKind(kind), (SYMMETRIC_RELATION_KINDS as readonly string[]).includes(kind));
});

test("origins and directions", () => {
  assert.deepEqual([...RELATION_ORIGINS], ["model", "user", "system"]);
  assert.equal(isRelationOrigin("model"), true);
  assert.equal(isRelationOrigin("robot"), false);
  assert.deepEqual([...RELATION_DIRECTIONS], ["incoming", "outgoing", "any"]);
  assert.equal(isRelationDirection("any"), true);
  assert.equal(isRelationDirection("both"), false);
});

test("symmetric edges are canonicalized by object id; directional ones keep their direction", () => {
  for (const kind of SYMMETRIC_RELATION_KINDS) {
    assert.deepEqual(canonicalRelationEnds(kind, A, B), { sourceObjectId: A, targetObjectId: B });
    assert.deepEqual(canonicalRelationEnds(kind, B, A), { sourceObjectId: A, targetObjectId: B }, kind);
  }
  for (const kind of ["extends", "depends_on", "derived_from", "supersedes"] as const) {
    assert.deepEqual(canonicalRelationEnds(kind, B, A), { sourceObjectId: B, targetObjectId: A }, kind);
    assert.deepEqual(canonicalRelationEnds(kind, A, B), { sourceObjectId: A, targetObjectId: B }, kind);
  }
});

test("a relation guard accepts a well-formed edge and rejects every malformed one", () => {
  assert.equal(isCognitiveRelation(valid), true);
  assert.equal(isCognitiveRelation({ ...valid, kind: "related_to", sourceObjectId: A, targetObjectId: B }), true);
  const bad: unknown[] = [
    null,
    "edge",
    {},
    { ...valid, id: "" },
    { ...valid, kind: "friends_with" },
    { ...valid, sourceObjectId: "" },
    { ...valid, targetObjectId: undefined },
    { ...valid, targetObjectId: valid.sourceObjectId },
    { ...valid, createdAt: "" },
    { ...valid, origin: "robot" },
    { ...valid, kind: "related_to" }, // symmetric, but not in canonical order (B before A)
  ];
  for (const candidate of bad) assert.equal(isCognitiveRelation(candidate), false, JSON.stringify(candidate));
});

test("manual relation input problems", () => {
  assert.equal(describeCreateRelationInputProblem({ kind: "extends", sourceObjectId: A, targetObjectId: B }), null);
  for (const input of [null, 3, {}, { kind: "nope", sourceObjectId: A, targetObjectId: B }, { kind: "extends", sourceObjectId: "", targetObjectId: B }, { kind: "extends", sourceObjectId: A }, { kind: "extends", sourceObjectId: A, targetObjectId: A }]) {
    assert.equal(typeof describeCreateRelationInputProblem(input), "string", JSON.stringify(input));
  }
});

test("relation error guards", () => {
  for (const code of RELATION_ERROR_CODES) assert.equal(isRelationErrorPayload({ code, message: "x" }), true);
  for (const bad of [null, "llm_failed", {}, { code: "llm_failed" }, { code: "nope", message: "x" }, { code: "llm_failed", message: 1 }]) {
    assert.equal(isRelationErrorPayload(bad), false, JSON.stringify(bad));
  }
});
