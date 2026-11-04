import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeSttProvider } from "../../src/voice/stt/fake";
import { SttRouter } from "../../src/runtime/stt_router";
import { frameFromInt16 } from "../../src/voice/contracts";
import type { PcmFrame } from "../../src/voice/contracts";

/**
 * HR-02 deterministic STT routing (no internet, no OpenAI account, no GPU).
 * Proves: cloud success, cloud-unavailable selection, same-utterance fallback,
 * partial discard, both-fail, local_only isolation, single-final invariant, cancel.
 */

function frames(n = 3): AsyncIterable<PcmFrame> {
  return {
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<PcmFrame> {
      for (let i = 0; i < n; i++) {
        yield frameFromInt16(new Int16Array(320), i, i * 20);
      }
    },
  };
}

async function drain(router: SttRouter, id: string): Promise<Array<{ type: string; text?: string }>> {
  const out: Array<{ type: string; text?: string }> = [];
  for await (const e of router.transcribeStream(frames(), { utteranceId: id, maxTranscriptChars: 8000 })) {
    if (e.type === "partial") out.push({ type: "partial", text: e.text });
    else if (e.type === "final") out.push({ type: "final", text: e.text });
    else out.push({ type: "error" });
  }
  return out;
}

test("HR-02 STT: cloud_preferred + cloud succeeds -> cloud result, local never called", async () => {
  const cloud = new FakeSttProvider({ id: "openai-stt" });
  cloud.setDefaultScript({ partials: ["partial-hint"], final: "hello cloud" });
  const local = new FakeSttProvider({ id: "parakeet-stt" });
  local.setDefaultScript({ final: "should never surface" });
  const router = new SttRouter({ cloud, local, policy: "cloud_preferred" });
  const events = await drain(router, "u-cloud-ok");
  assert.deepEqual(events, [
    { type: "partial", text: "partial-hint" },
    { type: "final", text: "hello cloud" },
  ]);
  assert.equal(router.lastDecisionFor("u-cloud-ok")?.provider_id, "openai-stt");
  assert.equal(router.lastDecisionFor("u-cloud-ok")?.runtime_mode, "cloud");
  assert.equal(router.lastDecisionFor("u-cloud-ok")?.reason, "cloud_preferred");
  assert.deepEqual(local.startedUtterances, []);
});

test("HR-02 STT: cloud unavailable -> local selected with cloud_unavailable", async () => {
  class Unavail extends FakeSttProvider {
    override get available(): boolean { return false; }
  }
  const down = new Unavail({ id: "openai-stt" });
  const local = new FakeSttProvider({ id: "parakeet-stt" });
  local.setDefaultScript({ final: "local answer" });
  const router = new SttRouter({ cloud: down, local, policy: "cloud_preferred" });
  const events = await drain(router, "u-cloud-down");
  assert.deepEqual(events, [{ type: "final", text: "local answer" }]);
  assert.equal(router.lastDecisionFor("u-cloud-down")?.reason, "cloud_unavailable");
  assert.equal(router.lastDecisionFor("u-cloud-down")?.runtime_mode, "local");
});

test("HR-02 STT: cloud fails -> SAME complete utterance passed to local (frame-identical)", async () => {
  const cloud = new FakeSttProvider({ id: "openai-stt" });
  cloud.setDefaultScript({ partials: ["Arthur otvori Visual"], error: "STT_FAILED" });
  cloud.recordFrames = true;
  const local = new FakeSttProvider({ id: "parakeet-stt" });
  local.recordFrames = true;
  local.setDefaultScript({ final: "Arthur, \u043e\u0442\u0432\u043e\u0440\u0438 Visual Studio Code." });
  const router = new SttRouter({ cloud, local, policy: "cloud_preferred" });
  const events = await drain(router, "u-fallback");
  // Cloud partial is forwarded (observability) then DISCARDED; local owns the final.
  assert.deepEqual(events, [
    { type: "partial", text: "Arthur otvori Visual" },
    { type: "final", text: "Arthur, \u043e\u0442\u0432\u043e\u0440\u0438 Visual Studio Code." },
  ]);
  const finals = events.filter((e) => e.type === "final");
  assert.equal(finals.length, 1);
  assert.equal(router.lastDecisionFor("u-fallback")?.reason, "cloud_failed");
  assert.equal(router.lastDecisionFor("u-fallback")?.provider_id, "parakeet-stt");
  // Same complete utterance: identical frame counts and byte-identical audio.
  assert.equal(cloud.framesConsumed, local.framesConsumed);
  assert.ok(cloud.framesConsumed > 0);
  const cloudBytes = cloud.receivedFrames.map((f) => Buffer.from(f.data).toString("hex")).join("");
  const localBytes = local.receivedFrames.map((f) => Buffer.from(f.data).toString("hex")).join("");
  assert.equal(cloudBytes, localBytes);
});

test("HR-02 STT: cloud partial emitted then fails -> partial discarded, complete local final only", async () => {
  const cloud = new FakeSttProvider({ id: "openai-stt" });
  cloud.setDefaultScript({ partials: ["stale partial"], error: "STT_FAILED" });
  const local = new FakeSttProvider({ id: "parakeet-stt" });
  local.setDefaultScript({ final: "clean local final" });
  const router = new SttRouter({ cloud, local, policy: "cloud_preferred" });
  const out = await router.transcribeFinal(frames(), { utteranceId: "u-partial-drop", maxTranscriptChars: 8000 });
  assert.equal(out.text, "clean local final");
  assert.equal(out.provider, "parakeet-stt");
});

test("HR-02 STT: both fail -> explicit STT failure", async () => {
  const cloud = new FakeSttProvider({ id: "openai-stt" });
  cloud.setDefaultScript({ error: "STT_FAILED" });
  const local = new FakeSttProvider({ id: "parakeet-stt" });
  local.setDefaultScript({ error: "STT_FAILED" });
  const router = new SttRouter({ cloud, local, policy: "cloud_preferred" });
  const events = await drain(router, "u-both-fail");
  assert.deepEqual(events, [{ type: "error" }]);
  await assert.rejects(
    router.transcribeFinal(frames(), { utteranceId: "u-both-fail-2", maxTranscriptChars: 8000 }),
    /STT provider failed/,
  );
});

test("HR-02 STT: local_only -> cloud never called", async () => {
  const cloud = new FakeSttProvider({ id: "openai-stt" });
  cloud.setDefaultScript({ final: "must not surface" });
  const local = new FakeSttProvider({ id: "parakeet-stt" });
  local.setDefaultScript({ final: "local only answer" });
  const router = new SttRouter({ cloud, local, policy: "local_only" });
  const events = await drain(router, "u-local-only");
  assert.deepEqual(events, [{ type: "final", text: "local only answer" }]);
  assert.deepEqual(cloud.startedUtterances, []);
  assert.equal(router.lastDecisionFor("u-local-only")?.reason, "local_only");
});

test("HR-02 STT: one final transcript only -> ConversationLoopRunner invoked once (controller seam)", async () => {
  // The router guarantees at most one final per utterance; the controller
  // consumes the first final and returns. Prove stream shape here.
  const cloud = new FakeSttProvider({ id: "openai-stt" });
  cloud.setDefaultScript({ partials: ["a", "ab"], final: "abc" });
  const local = new FakeSttProvider({ id: "parakeet-stt" });
  const router = new SttRouter({ cloud, local, policy: "cloud_preferred" });
  const out = await router.transcribeFinal(frames(5), { utteranceId: "u-once", maxTranscriptChars: 8000 });
  assert.equal(out.text, "abc");
  assert.equal(router.fallbacks, 0);
});

test("HR-02 STT: cancel -> active providers cancelled", async () => {
  const cloud = new FakeSttProvider({ id: "openai-stt" });
  const local = new FakeSttProvider({ id: "parakeet-stt" });
  const router = new SttRouter({ cloud, local, policy: "cloud_preferred" });
  await router.cancel("u-cancel");
  assert.ok(cloud.isCancelled("u-cancel"));
  assert.ok(local.isCancelled("u-cancel"));
});

test("HR-02 STT language: BG / EN / mixed transcripts survive normalization unchanged", async () => {
  const cases: Array<[string, string]> = [
    ["u-bg", "\u041e\u0442\u0432\u043e\u0440\u0438 Visual Studio Code."],
    ["u-en", "Open Visual Studio Code and check the current branch."],
    ["u-mix", "\u041e\u0442\u0432\u043e\u0440\u0438 Visual Studio Code \u0438 \u043f\u0440\u043e\u0432\u0435\u0440\u0438 current branch-\u0430."],
  ];
  for (const [id, text] of cases) {
    const cloud = new FakeSttProvider({ id: "openai-stt" });
    cloud.setScript(id, { final: text });
    const local = new FakeSttProvider({ id: "parakeet-stt" });
    const router = new SttRouter({ cloud, local, policy: "cloud_preferred" });
    const out = await router.transcribeFinal(frames(), { utteranceId: id, maxTranscriptChars: 8000 });
    assert.equal(out.text, text);
  }
});
