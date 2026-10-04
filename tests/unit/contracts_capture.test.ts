import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_CAPTURE_CONTENT_CHARS,
  describeCreateCaptureInputProblem,
  isCapture,
  isCaptureSourceKind,
  isCaptureTimestamp,
  isVoiceCaptureErrorCode,
  isVoiceCaptureErrorPayload,
} from "../../packages/contracts";

const valid = { id: "0b8f3c1e-0000-4000-8000-000000000001", source: "text", content: "idea", createdAt: "2026-10-04T12:00:00.123456789Z" };

test("create input: accepts valid requests, including raw whitespace and the length limit", () => {
  assert.equal(describeCreateCaptureInputProblem({ source: "text", content: "  hello\n" }), null);
  assert.equal(describeCreateCaptureInputProblem({ source: "voice", content: "x".repeat(MAX_CAPTURE_CONTENT_CHARS) }), null);
  // The limit counts characters, not UTF-16 units.
  assert.equal(describeCreateCaptureInputProblem({ source: "text", content: "😀".repeat(MAX_CAPTURE_CONTENT_CHARS) }), null);
});

test("create input: rejects everything else with a reason", () => {
  for (const bad of [
    null,
    "text",
    [],
    {},
    { source: "text" },
    { content: "x" },
    { source: "mind", content: "x" },
    { source: "text", content: 5 },
    { source: "text", content: "" },
    { source: "text", content: " \n\t" },
    { source: "text", content: "x".repeat(MAX_CAPTURE_CONTENT_CHARS + 1) },
  ]) {
    assert.equal(typeof describeCreateCaptureInputProblem(bad), "string", JSON.stringify(bad));
  }
});

test("capture guard accepts a well-formed capture and rejects malformed ones", () => {
  assert.equal(isCapture(valid), true);
  assert.equal(isCapture({ ...valid, createdAt: "2026-10-04T12:00:00+03:00" }), true);

  for (const bad of [
    null,
    undefined,
    "capture",
    {},
    { ...valid, id: "" },
    { ...valid, id: 1 },
    { ...valid, source: "carrier-pigeon" },
    { ...valid, content: "  " },
    { ...valid, content: undefined },
    { ...valid, createdAt: "yesterday" },
    { ...valid, createdAt: "2026-13-45T99:00:00Z" },
    { ...valid, createdAt: 1759579200000 },
  ]) {
    assert.equal(isCapture(bad), false, JSON.stringify(bad));
  }
});

test("source and timestamp guards", () => {
  assert.equal(isCaptureSourceKind("emg"), true);
  assert.equal(isCaptureSourceKind("EMG"), false);
  assert.equal(isCaptureTimestamp("2026-10-04T12:00:00Z"), true);
  assert.equal(isCaptureTimestamp("2026-10-04"), false);
});

test("voice capture error guards", () => {
  assert.equal(isVoiceCaptureErrorCode("microphone_permission_denied"), true);
  assert.equal(isVoiceCaptureErrorCode("stt_failed"), true);
  assert.equal(isVoiceCaptureErrorCode("boom"), false);

  assert.equal(isVoiceCaptureErrorPayload({ code: "stt_failed", message: "Could not reach the speech service." }), true);
  for (const bad of [null, "stt_failed", {}, { code: "stt_failed" }, { code: "nope", message: "x" }, { code: "stt_failed", message: 1 }]) {
    assert.equal(isVoiceCaptureErrorPayload(bad), false, JSON.stringify(bad));
  }
});
