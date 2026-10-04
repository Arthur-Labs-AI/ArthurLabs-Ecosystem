import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ARTHUR_PLATFORMS,
  CAPTURE_SOURCE_KINDS,
  KNOWLEDGE_OBJECT_KINDS,
  isArthurPlatform,
  isRuntimeInfo,
} from "../../packages/contracts";
import type { Capture, KnowledgeObject, RuntimeInfo } from "../../packages/contracts";

test("platform guard accepts exactly the declared platforms", () => {
  for (const platform of ARTHUR_PLATFORMS) assert.equal(isArthurPlatform(platform), true);
  for (const bad of ["Linux", "beos", "", null, undefined, 1, {}]) assert.equal(isArthurPlatform(bad), false);
});

test("runtime info guard validates payloads that crossed a process boundary", () => {
  const valid: RuntimeInfo = { appVersion: "0.1.0", platform: "android" };
  assert.equal(isRuntimeInfo(valid), true);
  assert.equal(isRuntimeInfo({ ...valid, extra: true }), true);

  for (const bad of [
    null,
    undefined,
    "0.1.0",
    [],
    {},
    { appVersion: "0.1.0" },
    { platform: "linux" },
    { appVersion: "", platform: "linux" },
    { appVersion: 1, platform: "linux" },
    { appVersion: "0.1.0", platform: "beos" },
  ]) {
    assert.equal(isRuntimeInfo(bad), false, JSON.stringify(bad));
  }
});

test("seed capture and knowledge contracts compile and expose the documented kinds", () => {
  const capture: Capture = { id: "cap-1", source: "voice", content: "benchmark EMG latency", createdAt: new Date(0).toISOString() };
  const idea: KnowledgeObject = {
    id: "k-1",
    kind: "idea",
    title: "EMG capture",
    body: "...",
    createdAt: capture.createdAt,
    provenance: { captureId: capture.id, sourceStart: 0, sourceEnd: 9 },
  };

  assert.deepEqual([...CAPTURE_SOURCE_KINDS], ["text", "voice", "emg"]);
  assert.deepEqual([...KNOWLEDGE_OBJECT_KINDS], ["idea", "task", "decision", "question", "note"]);
  assert.ok(CAPTURE_SOURCE_KINDS.includes(capture.source));
  assert.ok(KNOWLEDGE_OBJECT_KINDS.includes(idea.kind));
});
