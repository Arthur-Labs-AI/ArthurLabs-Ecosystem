import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
  LINEAGE_ERROR_CODES,
  MAX_MERGE_PARENTS,
  MAX_REVISIONS_PER_OBJECT,
  REVISION_ORIGINS,
  describeRevisionChangesProblem,
  diffRevisionContent,
  diffText,
  isLineageErrorPayload,
  isObjectLineage,
  isRevisionDiff,
  isRevisionOrigin,
  isThoughtRevision,
  type DiffSegment,
} from "../../packages/contracts";
import { findRepoRoot } from "../architecture/import_graph";

const O = "11111111-1111-4111-8111-111111111111";
const revision = (id: string, origin: string, parents: string[], extra: Record<string, unknown> = {}) => ({
  id,
  objectId: O,
  kind: "idea",
  title: "Title",
  body: "Body",
  createdAt: "2026-10-04T10:00:00Z",
  origin,
  parentRevisionIds: parents,
  ...extra,
});

// --- deterministic diff ---------------------------------------------------------------------------

interface Case {
  name: string;
  old: string;
  new: string;
  expected: { changed: boolean; segments: DiffSegment[] };
}
const cases = JSON.parse(readFileSync(path.join(findRepoRoot(), "tests/fixtures/revision_diff_cases.json"), "utf8")) as Case[];

test("the diff matches every shared fixture case (the native diff is checked against the same file)", () => {
  assert.ok(cases.length >= 10);
  for (const c of cases) assert.deepEqual(diffText(c.old, c.new), c.expected, c.name);
});

test("a diff always reconstructs both texts, is deterministic, and merges consecutive segments", () => {
  const pairs: [string, string][] = [
    ...cases.map((c): [string, string] => [c.old, c.new]),
    ["The quick brown fox", "A quick red fox jumps"],
    ["a b c d e f g", "g f e d c b a"],
    ["Здравей, свят 😀!", "Здравей свят 😀😀?"],
  ];
  for (const [oldText, newText] of pairs) {
    const diff = diffText(oldText, newText);
    assert.deepEqual(diffText(oldText, newText), diff, "repeatable");
    assert.equal(diff.segments.filter((s) => s.op !== "insert").map((s) => s.text).join(""), oldText);
    assert.equal(diff.segments.filter((s) => s.op !== "delete").map((s) => s.text).join(""), newText);
    diff.segments.forEach((s, i) => {
      assert.ok(s.text.length > 0);
      if (i > 0) assert.notEqual(s.op, diff.segments[i - 1]?.op, "consecutive segments with one op are merged");
    });
    assert.equal(diff.changed, oldText !== newText);
  }
});

test("a revision diff reports kind, title and body independently", () => {
  const a = { id: "r1", kind: "idea" as const, title: "Same", body: "Old body" };
  const diff = diffRevisionContent(a, { id: "r2", kind: "decision", title: "Same", body: "New body" });
  assert.deepEqual(diff.kind, { changed: true, from: "idea", to: "decision" });
  assert.equal(diff.title.changed, false);
  assert.equal(diff.body.changed, true);
  assert.equal(isRevisionDiff(diff), true);
  const none = diffRevisionContent(a, { ...a, id: "r2" });
  assert.deepEqual([none.kind.changed, none.title.changed, none.body.changed], [false, false, false]);
  for (const bad of [null, {}, { ...diff, kind: { changed: true } }, { ...diff, body: { changed: true, segments: [{ op: "move", text: "x" }] } }]) assert.equal(isRevisionDiff(bad), false);
});

// --- contract guards -------------------------------------------------------------------------------

test("origins and limits", () => {
  assert.deepEqual([...REVISION_ORIGINS], ["initial", "user_edit", "distillation", "merge", "system"]);
  for (const origin of REVISION_ORIGINS) assert.equal(isRevisionOrigin(origin), true);
  assert.equal(isRevisionOrigin("revert"), false);
  assert.equal(MAX_MERGE_PARENTS, 8);
  assert.equal(MAX_REVISIONS_PER_OBJECT, 1000);
  for (const code of LINEAGE_ERROR_CODES) assert.equal(isLineageErrorPayload({ code, message: "x" }), true);
  assert.equal(isLineageErrorPayload({ code: "nope", message: "x" }), false);
});

test("a revision's parent count must match its origin: DAG shape rules", () => {
  assert.equal(isThoughtRevision(revision("r1", "initial", [], { provenance: { captureId: "c", sourceStart: 0, sourceEnd: 3 } })), true);
  assert.equal(isThoughtRevision(revision("r2", "user_edit", ["r1"])), true);
  assert.equal(isThoughtRevision(revision("r4", "merge", ["r2", "r3"])), true);
  assert.equal(isThoughtRevision(revision("r5", "merge", ["r2", "r3", "r1"])), true, "more than two parents");
  const bad: unknown[] = [
    null,
    "r",
    revision("r1", "initial", ["r0"]), // an initial revision has no parent
    revision("r2", "user_edit", []), // an edit has exactly one
    revision("r2", "user_edit", ["r1", "r0"]),
    revision("r4", "merge", ["r2"]), // a merge has two or more
    revision("r4", "merge", ["r2", "r2"]), // duplicate parent
    revision("r2", "user_edit", ["r2"]), // self parent
    revision("r2", "revert", ["r1"]),
    revision("r2", "user_edit", ["r1"], { kind: "gizmo" }),
    revision("r2", "user_edit", ["r1"], { title: "  " }),
    revision("r2", "user_edit", ["r1"], { body: "" }),
    revision("", "user_edit", ["r1"]),
    revision("r2", "user_edit", ["r1"], { provenance: { captureId: "", sourceStart: 0, sourceEnd: 3 } }),
  ];
  for (const candidate of bad) assert.equal(isThoughtRevision(candidate), false, JSON.stringify(candidate));
});

test("a lineage is oldest first with every parent before its child, so it cannot contain a cycle", () => {
  const r1 = revision("r1", "initial", []);
  const r2 = revision("r2", "user_edit", ["r1"]);
  const r3 = revision("r3", "user_edit", ["r1"]);
  const r4 = revision("r4", "merge", ["r2", "r3"]);
  assert.equal(isObjectLineage({ objectId: O, currentRevisionId: "r4", revisions: [r1, r2, r3, r4] }), true);
  const bad: unknown[] = [
    { objectId: O, currentRevisionId: "r4", revisions: [] },
    { objectId: O, currentRevisionId: "zzz", revisions: [r1, r2] },
    { objectId: O, currentRevisionId: "r4", revisions: [r1, r4, r2, r3] }, // a parent after its child
    { objectId: O, currentRevisionId: "r1", revisions: [r1, r1] },
    { objectId: "other", currentRevisionId: "r1", revisions: [r1] },
    { objectId: O, currentRevisionId: "r2", revisions: [r2] }, // parent r1 missing
    { currentRevisionId: "r1", revisions: [r1] },
  ];
  for (const candidate of bad) assert.equal(isObjectLineage(candidate), false, JSON.stringify(candidate));
});

test("edit validation: no-ops, unknown fields, blank text and unknown kinds are rejected", () => {
  const base = { kind: "idea", title: "T", body: "B" };
  assert.equal(describeRevisionChangesProblem(base, { title: "T2" }), null);
  assert.equal(describeRevisionChangesProblem(base, { kind: "task" }), null);
  assert.equal(describeRevisionChangesProblem(base, { body: "B2", title: "T2", kind: "note" }), null);
  for (const changes of [null, 3, {}, { title: "T" }, { kind: "idea", title: "T", body: "B" }, { title: "  " }, { body: "" }, { kind: "gizmo" }, { title: "T2", id: "x" }, { title: 5 }]) {
    assert.equal(typeof describeRevisionChangesProblem(base, changes), "string", JSON.stringify(changes));
  }
});
