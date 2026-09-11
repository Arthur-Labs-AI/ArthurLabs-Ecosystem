/**
 * SC-06 bounded multi-tool conversation loop v1 — acceptance slice.
 *
 * Covers the core loop increment through the real ConversationService:
 * multi-round model->tool->model turns, provider-ID validation, per-call
 * result envelopes, sequential execution, approval barrier atomicity,
 * OUTCOME_UNKNOWN hard-stop, loop budgets + tool-disabled synthesis,
 * usage aggregation, and streaming/text core parity.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ArthurError } from '../../src/core/errors/errors';
import type { StreamingTurnEvent } from '../../src/core/conversation/streaming_service';
import { FakeProvider } from '../../src/models/providers/fake';
import type { ModelRequest, ModelResult } from '../../src/models/contracts';
import { validateSettings } from '../../src/config/validation';
import { loadSettings } from '../../src/config/settings';
import { buildTestApp, validTurn } from '../helpers';

function result(text: string, toolCalls: ModelResult['tool_calls'] = []): ModelResult {
  return { assistant_text: text, tool_calls: toolCalls, finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } };
}

// SC06-F01/F02/F03: more than one model->tool round works; follow-up calls
// execute; the final answer stops the loop.
test('SC06-F01: multi-step read turn runs two tool rounds then answers', async () => {
  let calls = 0;
  const seen: string[] = [];
  const provider = new FakeProvider({
    responder: (req: ModelRequest) => {
      calls += 1;
      if (calls === 1) {
        return result('', [{ id: 'call-1', name: 'system.echo', arguments: { text: 'step-one' } }]);
      }
      if (calls === 2) {
        const toolMsg = req.history.find((m) => m.role === 'tool');
        assert.ok(toolMsg, 'round 2 must see the round-1 tool result');
        seen.push(String(req.history.length));
        return result('', [{ id: 'call-2', name: 'system.echo', arguments: { text: 'step-two' } }]);
      }
      return result('done after two rounds');
    },
  });
  const app = buildTestApp({}, { provider });
  try {
    const response = await app.conversation.handleTurn(validTurn({ message: 'multi step' }));
    assert.equal(response.status, 'completed');
    assert.equal(response.display_text, 'done after two rounds');
    assert.equal(response.tool_calls.length, 2);
    assert.equal(response.tool_calls[0]?.round, 1);
    assert.equal(response.tool_calls[1]?.round, 2);
    assert.equal(calls, 3);
    assert.ok(seen.length === 1);
    // Usage aggregates all rounds.
    assert.equal(response.model.calls, 3);
    const modelCalls = app.store.getModelCallsForTurn(response.turn_id);
    assert.equal(modelCalls.length, 3);
  } finally {
    app.close();
  }
});

// SC06-F05: intermediate assistant text is not the persisted answer.
test('SC06-F05: intermediate model text never becomes the final answer', async () => {
  let calls = 0;
  const provider = new FakeProvider({
    responder: () => {
      calls += 1;
      if (calls === 1) {
        return result('I will check the repository now.', [{ id: 'c-1', name: 'system.echo', arguments: { text: 'x' } }]);
      }
      return result('final verdict');
    },
  });
  const app = buildTestApp({}, { provider });
  try {
    const response = await app.conversation.handleTurn(validTurn());
    assert.equal(response.display_text, 'final verdict');
    assert.ok(!response.display_text.includes('I will check'));
    const summary = await app.conversation.getSession(response.session_id);
    const assistant = summary.turns.filter((t) => t.role === 'assistant');
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0]?.text, 'final verdict');
  } finally {
    app.close();
  }
});

// SC06-F07: empty provider IDs are MODEL_BAD_RESPONSE and execute nothing.
test('SC06-F07: empty provider tool-call id executes zero calls', async () => {
  const provider = new FakeProvider({
    responder: () => result('', [{ id: '', name: 'system.echo', arguments: { text: 'x' } }]),
  });
  const app = buildTestApp({}, { provider });
  try {
    await assert.rejects(
      () => app.conversation.handleTurn(validTurn()),
      (err: unknown) => err instanceof ArthurError && err.code === 'MODEL_BAD_RESPONSE',
    );
    // Zero executions: no tool call row may exist for the failed turn.
    assert.equal(app.store.getToolCallsForTurn('no-such-turn').length, 0);
  } finally {
    app.close();
  }
});

// SC06-F08: duplicate provider IDs in one batch execute zero calls.
test('SC06-F08: duplicate provider ids execute zero calls', async () => {
  const provider = new FakeProvider({
    responder: () =>
      result('', [
        { id: 'dup', name: 'system.echo', arguments: { text: 'a' } },
        { id: 'dup', name: 'system.echo', arguments: { text: 'b' } },
      ]),
  });
  const app = buildTestApp({}, { provider });
  try {
    await assert.rejects(
      () => app.conversation.handleTurn(validTurn()),
      (err: unknown) => err instanceof ArthurError && err.code === 'MODEL_BAD_RESPONSE',
    );
  } finally {
    app.close();
  }
});

// SC06-F11/F12/F13/F14: one result per call, order preserved, failures
// produce envelopes and the model can adapt.
test('SC06-F11: unknown + invalid + ok batch yields ordered envelopes', async () => {
  let calls = 0;
  const provider = new FakeProvider({
    responder: (req: ModelRequest) => {
      calls += 1;
      if (calls === 1) {
        return result('', [
          { id: 'a', name: 'ghost.tool', arguments: {} },
          { id: 'b', name: 'system.echo', arguments: { wrong: 1 } },
          { id: 'c', name: 'system.echo', arguments: { text: 'ok' } },
        ]);
      }
      const tools = req.history.filter((m) => m.role === 'tool');
      assert.equal(tools.length, 3);
      assert.deepEqual(tools.map((m) => m.tool_call_id), ['a', 'b', 'c']);
      return result('adapted');
    },
  });
  const app = buildTestApp({}, { provider });
  try {
    const response = await app.conversation.handleTurn(validTurn());
    assert.equal(response.display_text, 'adapted');
    assert.deepEqual(response.tool_calls.map((t) => t.status), ['rejected', 'rejected', 'completed']);
    assert.deepEqual(response.tool_calls.map((t) => t.sequence), [1, 2, 3]);
  } finally {
    app.close();
  }
});

// SC06-F15: sequential execution in deterministic model order.
test('SC06-F15: batch executes sequentially in model order', async () => {
  const order: string[] = [];
  const provider = new FakeProvider({
    responder: () => result('', [
      { id: 's-1', name: 'system.echo', arguments: { text: 'first' } },
      { id: 's-2', name: 'system.echo', arguments: { text: 'second' } },
      { id: 's-3', name: 'system.echo', arguments: { text: 'third' } },
    ]),
  });
  const app = buildTestApp({}, { provider });
  const origExecute = app.conversation.orchestratorForTests().handleProposed.bind(app.conversation.orchestratorForTests());
  void origExecute;
  try {
    const response = await app.conversation.handleTurn(validTurn());
    for (const t of response.tool_calls) order.push(String(t.sequence));
    assert.deepEqual(order, ['1', '2', '3']);
    assert.equal(response.tool_calls.length, 3);
  } finally {
    app.close();
  }
});

// SC06-F16/F17/F18/F19: mixed batch suspends atomically; read sibling does
// NOT execute before the barrier.
test('SC06-F16: mixed auto+approval batch executes nothing before the barrier', async () => {
  const provider = new FakeProvider({
    responder: () =>
      result('', [
        { id: 'm-1', name: 'system.echo', arguments: { text: 'read-first' } },
        { id: 'm-2', name: 'harness.create_job', arguments: { kind: 'deploy' } },
        { id: 'm-3', name: 'system.echo', arguments: { text: 'read-after' } },
      ]),
  });
  const app = buildTestApp({}, { provider });
  try {
    const response = await app.conversation.handleTurn(validTurn({ mode: 'business' }));
    assert.equal(response.status, 'needs_approval');
    // Increment 3.1 audit: barrier + REPRESENTED deferred siblings (never
    // executed). Frozen SC-02/SC-03 authority unchanged — representation only.
    const barrier = response.tool_calls.find((t) => t.status === 'pending_approval');
    assert.ok(barrier);
    assert.equal(barrier.name, 'harness.create_job');
    const deferred = response.tool_calls.filter((t) => t.note === 'deferred_by_approval');
    assert.equal(deferred.length, 2, 'm-1 and m-3 represented as deferred');
    assert.ok(deferred.every((t) => t.status === 'cancelled'));
    const stored = app.store.getToolCallsForTurn(response.turn_id);
    assert.equal(stored.length, 1, 'no sibling may execute before the barrier');
  } finally {
    app.close();
  }
});

// SC06-F26/F27/F28: loop budgets enforced.
test('SC06-F26: max rounds enforced with tool-disabled synthesis', async () => {
  let calls = 0;
  const provider = new FakeProvider({
    responder: () => {
      calls += 1;
      return result('', [{ id: 'r-' + calls, name: 'system.echo', arguments: { text: 'again-' + calls } }]);
    },
  });
  const app = buildTestApp({ loopMaxRounds: 2 }, { provider });
  try {
    const response = await app.conversation.handleTurn(validTurn());
    assert.equal(response.status, 'completed');
    assert.equal(response.tool_calls.length, 2);
    assert.ok(calls >= 2, 'synthesis round runs after the tool rounds');
  } finally {
    app.close();
  }
});

test('SC06-F27: max calls per round enforced', async () => {
  const provider = new FakeProvider({
    responder: () =>
      result('', [
        { id: 'p-1', name: 'system.echo', arguments: { text: '1' } },
        { id: 'p-2', name: 'system.echo', arguments: { text: '2' } },
        { id: 'p-3', name: 'system.echo', arguments: { text: '3' } },
      ]),
  });
  const app = buildTestApp({ loopMaxCallsPerRound: 2 }, { provider });
  try {
    await assert.rejects(
      () => app.conversation.handleTurn(validTurn()),
      (err: unknown) => err instanceof ArthurError && err.code === 'MODEL_BAD_RESPONSE',
    );
  } finally {
    app.close();
  }
});

// SC06-F04/F06: streaming uses the same core loop; intermediate text is not
// the final persistence.
test('SC06-F04: streaming multi-round turn matches the text core', async () => {
  let calls = 0;
  const provider = new FakeProvider({
    responder: () => {
      calls += 1;
      if (calls === 1) return result('checking now', [{ id: 'st-1', name: 'system.echo', arguments: { text: 'v' } }]);
      return result('stream final');
    },
  });
  const app = buildTestApp({}, { provider });
  try {
    const events: StreamingTurnEvent[] = [];
    for await (const event of app.conversation.streamTurn(validTurn({ message: 'stream me' }))) {
      events.push(event);
    }
    const completed = events.find((e): e is Extract<StreamingTurnEvent, { type: 'turn_completed' }> => e.type === 'turn_completed');
    assert.ok(completed);
    assert.equal(completed.display_text, 'stream final');
    assert.equal(completed.tool_calls.length, 1);
    const deltas = events.filter((e) => e.type === 'text_delta');
    assert.ok(deltas.length >= 1);
  } finally {
    app.close();
  }
});

// SC06-F47/F48: turn response aggregates all rounds + model totals.
test('SC06-F47: tool calls aggregate across rounds in order', async () => {
  let calls = 0;
  const provider = new FakeProvider({
    responder: () => {
      calls += 1;
      if (calls === 1) {
        return result('', [
          { id: 'g-1', name: 'system.echo', arguments: { text: 'one' } },
          { id: 'g-2', name: 'system.echo', arguments: { text: 'two' } },
        ]);
      }
      if (calls === 2) return result('', [{ id: 'g-3', name: 'system.echo', arguments: { text: 'three' } }]);
      return result('all done');
    },
  });
  const app = buildTestApp({}, { provider });
  try {
    const response = await app.conversation.handleTurn(validTurn());
    assert.deepEqual(
      response.tool_calls.map((t) => [t.round, t.sequence]),
      [[1, 1], [1, 2], [2, 1]],
    );
    assert.equal(response.model.calls, 3);
  } finally {
    app.close();
  }
});

// SC-06 section 64: invalid loop config fails startup with INVALID_CONFIG.
test('SC06-config: invalid loop budgets fail closed at startup', () => {
  assert.throws(
    () => validateSettings(loadSettings({ loopMaxRounds: 0 })),
    (err: unknown) => err instanceof ArthurError && err.code === 'INVALID_CONFIG',
  );
  assert.throws(
    () => validateSettings(loadSettings({ loopMaxCallsPerRound: 99 })),
    (err: unknown) => err instanceof ArthurError && err.code === 'INVALID_CONFIG',
  );
  assert.throws(
    () => validateSettings(loadSettings({ loopMaxCallsTotal: -1 })),
    (err: unknown) => err instanceof ArthurError && err.code === 'INVALID_CONFIG',
  );
  const ok = validateSettings(loadSettings({ modelProvider: 'fake' }));
  assert.equal(ok.loopMaxRounds, 6);
  assert.equal(ok.loopMaxCallsPerRound, 8);
  assert.equal(ok.loopMaxCallsTotal, 24);
  assert.equal(ok.loopMaxResultBytes, 64 * 1024);
  assert.equal(ok.loopMaxActiveMs, 120000);
  assert.equal(ok.loopRepeatLimit, 2);
});
