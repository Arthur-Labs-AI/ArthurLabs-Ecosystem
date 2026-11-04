/**
 * TASK-0011B-F1: when the follow-up model call fails, BOTH the normal
 * handleTurn and the streaming streamTurn paths degrade to the concise
 * ToolCallSummary.result_summary of the completed tools - never the
 * model-facing ChatMessage.content structured payload. The model itself must
 * still have received the structured payload before the failure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ArthurMode } from "../../src/core/modes/mode";
import type { StreamingTurnEvent } from "../../src/core/conversation/streaming_service";
import { FakeProvider } from "../../src/models/providers/fake";
import type { ModelRequest, ModelResult } from "../../src/models/contracts";
import type {
  LocalSystemAdapter,
  LocalSystemStatus,
} from "../../src/tools/adapters/local_system";
import { buildTestApp, validTurn } from "../helpers";

const FAKE_STATUS: LocalSystemStatus = {
  platform: "win32",
  arch: "x64",
  node_version: "v22.18.0",
  uptime_seconds: 12345,
  cpu_count: 12,
  total_memory_bytes: 32 * 2 ** 30,
  free_memory_bytes: 16 * 2 ** 30,
};

const EXPECTED_SUMMARY = "Local system: win32 x64, Node v22.18.0, 12 CPUs, 32 GB RAM";

/** Fragments of the structured payload that must never reach display text. */
const PAYLOAD_FRAGMENTS = [
  "uptime_seconds",
  "total_memory_bytes",
  "free_memory_bytes",
  "cpu_count",
  "node_version",
  "data_omitted",
  "tool_result_payload_too_large",
  '"summary"',
];

/** Raw uptime value: present in the payload data, absent from the summary. */
const UPTIME_SECONDS = 12345;

class FakeLocalSystemAdapter implements LocalSystemAdapter {
  constructor(private readonly status: LocalSystemStatus) {}
  async getStatus(): Promise<LocalSystemStatus> {
    return { ...this.status };
  }
}

/**
 * Provider that proposes system.status on round 1 and FAILS the follow-up
 * call on round 2. The round-2 request is captured first so the test can
 * prove the model did receive the structured payload before the failure.
 */
function failingFollowupProvider(followupRequests: ModelRequest[]): FakeProvider {
  let round = 0;
  return new FakeProvider({
    responder: (request: ModelRequest): ModelResult => {
      round += 1;
      if (round === 1) {
        return {
          assistant_text: "",
          tool_calls: [{ id: "call-fb", name: "system.status", arguments: {} }],
          finish_reason: "tool_calls",
        };
      }
      followupRequests.push(request);
      throw new Error("follow-up provider unreachable");
    },
  });
}

function assertModelToolMessageCarriesData(request: ModelRequest | undefined): void {
  const toolMessage = request?.history.find((m) => m.role === "tool");
  assert.ok(toolMessage, "follow-up request must carry the role=tool message");
  const payload = JSON.parse(toolMessage.content ?? "") as {
    summary?: string;
    data?: { uptime_seconds?: number };
  };
  assert.equal(payload.summary, EXPECTED_SUMMARY);
  assert.equal(
    payload.data?.uptime_seconds,
    UPTIME_SECONDS,
    "uptime_seconds must still be present in the MODEL tool message",
  );
}

function assertNoPayloadExposure(text: string, label: string): void {
  assert.ok(text.includes(EXPECTED_SUMMARY), `${label} must contain the concise summary`);
  for (const fragment of PAYLOAD_FRAGMENTS) {
    assert.equal(text.includes(fragment), false, `${label} must not expose: ${fragment}`);
  }
  assert.equal(text.includes(String(UPTIME_SECONDS)), false, `${label} must not expose the uptime value`);
}

test("F1-1: normal follow-up failure degrades to the concise summary, never the payload", async () => {
  const followupRequests: ModelRequest[] = [];
  const provider = failingFollowupProvider(followupRequests);
  const app = buildTestApp({}, { provider, localSystem: new FakeLocalSystemAdapter(FAKE_STATUS) });
  try {
    const response = await app.conversation.handleTurn(validTurn({ message: "status?" }));
    assert.equal(response.status, "completed");
    assertNoPayloadExposure(response.display_text, "display_text");
    // system.status pair: uptime_seconds is absent from the fallback display
    // (asserted above) and still present in the model tool message:
    assertModelToolMessageCarriesData(followupRequests[0]);
  } finally {
    app.close();
  }
});

test("F1-2: streaming follow-up failure degrades to the concise summary in the final event", async () => {
  const followupRequests: ModelRequest[] = [];
  const provider = failingFollowupProvider(followupRequests);
  const app = buildTestApp({}, { provider, localSystem: new FakeLocalSystemAdapter(FAKE_STATUS) });
  try {
    const events: StreamingTurnEvent[] = [];
    for await (const event of app.conversation.streamTurn(validTurn({ message: "status?" }))) {
      events.push(event);
    }
    const completed = events.find(
      (e): e is Extract<StreamingTurnEvent, { type: "turn_completed" }> => e.type === "turn_completed",
    );
    assert.ok(completed, "stream must reach turn_completed");
    assert.equal(completed.status, "completed");
    assertNoPayloadExposure(completed.display_text, "turn_completed.display_text");

    // No event anywhere in the stream may carry structured payload fragments
    // (covers text_delta, summaries, usage, and every other event type).
    const streamJson = JSON.stringify(events) ?? "";
    for (const fragment of ["uptime_seconds", "total_memory_bytes", "free_memory_bytes", "data_omitted"]) {
      assert.equal(streamJson.includes(fragment), false, `stream must not expose: ${fragment}`);
    }

    // system.status pair: uptime_seconds is absent from the fallback display
    // (asserted above) and still present in the model tool message:
    assertModelToolMessageCarriesData(followupRequests[0]);
  } finally {
    app.close();
  }
});
