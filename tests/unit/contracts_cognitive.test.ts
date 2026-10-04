import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DISTILLATION_ERROR_CODES,
  KNOWLEDGE_OBJECT_KINDS,
  codePointLength,
  describeSpanProblem,
  isDistillationErrorCode,
  isDistillationErrorPayload,
  isKnowledgeObject,
  isKnowledgeObjectKind,
  isKnowledgeProvenance,
  sliceCodePoints,
} from "../../packages/contracts";

const valid = {
  id: "0b8f3c1e-0000-4000-8000-0000000000bb",
  kind: "task",
  title: "Email Ignatov",
  body: "Email Ignatov about the competition.",
  createdAt: "2026-10-04T12:00:00Z",
  provenance: { captureId: "c1", sourceStart: 3, sourceEnd: 20 },
};

test("every supported kind is a valid kind and nothing else is", () => {
  for (const kind of KNOWLEDGE_OBJECT_KINDS) assert.equal(isKnowledgeObjectKind(kind), true);
  for (const bad of ["Idea", "gizmo", "", null, 3]) assert.equal(isKnowledgeObjectKind(bad), false);
  assert.equal(isKnowledgeObject({ ...valid, kind: "gizmo" }), false);
});

test("a knowledge object must carry well-formed provenance", () => {
  assert.equal(isKnowledgeObject(valid), true);
  for (const bad of [
    null,
    {},
    { ...valid, provenance: undefined },
    { ...valid, provenance: { captureId: "", sourceStart: 0, sourceEnd: 3 } },
    { ...valid, provenance: { captureId: "c1", sourceStart: -1, sourceEnd: 3 } },
    { ...valid, provenance: { captureId: "c1", sourceStart: 5, sourceEnd: 5 } },
    { ...valid, provenance: { captureId: "c1", sourceStart: 9, sourceEnd: 4 } },
    { ...valid, provenance: { captureId: "c1", sourceStart: 1.5, sourceEnd: 4 } },
    { ...valid, provenance: { captureId: "c1", sourceStart: "0", sourceEnd: 4 } },
    { ...valid, title: "  " },
    { ...valid, body: "" },
    { ...valid, id: "" },
    { ...valid, createdAt: "" },
  ]) {
    assert.equal(isKnowledgeObject(bad), false, JSON.stringify(bad));
  }
  assert.equal(isKnowledgeProvenance(valid.provenance), true);
});

test("offsets are code points, so emoji and Cyrillic slice exactly", () => {
  const text = "Здравей 😀 свят";
  assert.equal(codePointLength(text), 14);
  assert.equal(text.length, 15, "UTF-16 length differs, which is why offsets are not UTF-16 units");
  assert.equal(sliceCodePoints(text, 8, 14), "😀 свят");
  assert.equal(sliceCodePoints(text, 0, 7), "Здравей");
});

test("span validation matches the native store", () => {
  const text = "abc   def";
  assert.equal(describeSpanProblem(text, 0, 3), null);
  assert.equal(describeSpanProblem(text, 6, 9), null);
  for (const [start, end] of [[-1, 2], [3, 3], [5, 2], [0, 10], [3, 6], [0.5, 2], ["0", 2]] as const) {
    assert.equal(typeof describeSpanProblem(text, start, end), "string", `${start}..${end}`);
  }
});

test("distillation error guards", () => {
  for (const code of DISTILLATION_ERROR_CODES) assert.equal(isDistillationErrorCode(code), true);
  assert.equal(isDistillationErrorCode("boom"), false);
  assert.equal(isDistillationErrorPayload({ code: "llm_invalid_output", message: "x" }), true);
  for (const bad of [null, "llm_failed", {}, { code: "llm_failed" }, { code: "nope", message: "x" }, { code: "llm_failed", message: 1 }]) {
    assert.equal(isDistillationErrorPayload(bad), false, JSON.stringify(bad));
  }
});
