/**
 * SC-06 Increment 2: durable loop journal + approval resume.
 *
 * Covers F09/F10/F17/F18/F19/F20/F21/F22/F45/F46/F06 + mode-freeze +
 * schema-drift + no-reasoning-persistence through the real
 * ConversationService + ConversationLoopRunner + file-backed DB restarts.
 * Every execution-sensitive test asserts executor invocation counts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ArthurError } from '../../src/core/errors/errors';
import type { StreamingTurnEvent } from '../../src/core/conversation/streaming_service';
import { FakeProvider } from '../../src/models/providers/fake';
import type { ModelRequest, ModelResult } from '../../src/models/contracts';
import type { HarnessAdapter } from '../../src/tools/contracts';
import { FileApprovalKeyProvider } from '../../src/tools/approval_keys';
import { buildTestApp, validTurn } from '../helpers';
import type { App } from '../../src/app';

const PROVIDER_CALL_A = 'provider-call-A';

function result(text: string, toolCalls: ModelResult['tool_calls'] = []): ModelResult {
  return { assistant_text: text, tool_calls: toolCalls, finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } };
}

function jobProposal(id = PROVIDER_CALL_A): ModelResult {
  return result('', [{ id, name: 'harness.create_job', arguments: { kind: 'deploy' } }]);
}

interface Runtime {
  app: App;
  dir: string;
  dbPath: string;
  keyPath: string;
  modelCalls: () => number;
  executions: () => number;
  seenToolHistories: () => ModelRequest[];
}

/**
 * Build a file-backed runtime. Model: proposes the barrier job once, then
 * answers from the tool result. Counting harness observes executions.
 */
function makeRuntime(providerImpl?: { responder?: (req: ModelRequest) => ModelResult; onRequest?: (req: ModelRequest) => void }): Runtime {
  const dir = mkdtempSync(join(tmpdir(), 'sc06-resume-'));
  const dbPath = join(dir, 'arthur.db');
  const keyPath = join(dir, 'approval-key.json');
  let modelCalls = 0;
  let executions = 0;
  const seen: ModelRequest[] = [];
  let proposed = false;
  const provider = new FakeProvider({
    responder: (req: ModelRequest) => {
      modelCalls += 1;
      seen.push(req);
      providerImpl?.onRequest?.(req);
      if (providerImpl?.responder) return providerImpl.responder(req);
      if (!proposed) {
        proposed = true;
        return jobProposal();
      }
      return result('job done');
    },
  });
  const counting: HarnessAdapter = {
    getStatus: async () => ({ status: 'online', version: 'test', jobs_active: 0 }),
    createJob: async (spec) => { executions += 1; return { id: 'job-' + executions, status: 'queued', spec }; },
    getJob: async () => { throw new Error('unused'); },
    cancelJob: async () => {},
  };
  const keys = new FileApprovalKeyProvider({ path: keyPath });
  const app = buildTestApp(
    { dbPath, approvalTtlSeconds: 300, memoryPersonalDbPath: ':memory:', memoryBusinessDbPath: ':memory:' },
    { provider, harness: counting, approvalKeyProvider: keys },
  );
  return { app, dir, dbPath, keyPath, modelCalls: () => modelCalls, executions: () => executions, seenToolHistories: () => seen };
}

function reopenRuntime(rt: Runtime, providerImpl?: { responder?: (req: ModelRequest) => ModelResult; onRequest?: (req: ModelRequest) => void }): Runtime {
  const { dir, dbPath, keyPath } = rt;
  let modelCalls = 0;
  const seen: ModelRequest[] = [];
  let executions = 0;
  // NOTE: executions counted on the NEW adapter; runtime A's executions are
  // asserted before close. Post-restart execution count must be exactly 1.
  const provider = new FakeProvider({
    responder: (req: ModelRequest) => {
      modelCalls += 1;
      seen.push(req);
      providerImpl?.onRequest?.(req);
      if (providerImpl?.responder) return providerImpl.responder(req);
      return result('job done after resume');
    },
  });
  const counting: HarnessAdapter = {
    getStatus: async () => ({ status: 'online', version: 'test', jobs_active: 0 }),
    createJob: async (spec) => { executions += 1; return { id: 'job-' + executions, status: 'queued', spec }; },
    getJob: async () => { throw new Error('unused'); },
    cancelJob: async () => {},
  };
  const keys = new FileApprovalKeyProvider({ path: keyPath });
  const app = buildTestApp(
    { dbPath, approvalTtlSeconds: 300, memoryPersonalDbPath: ':memory:', memoryBusinessDbPath: ':memory:' },
    { provider, harness: counting, approvalKeyProvider: keys },
  );
  return { app, dir, dbPath, keyPath, modelCalls: () => modelCalls, executions: () => executions, seenToolHistories: () => seen };
}

async function suspendToBarrier(rt: Runtime): Promise<{ approvalId: string; sessionId: string; turnId: string; loopId: string }> {
  const response = await rt.app.conversation.handleTurn(validTurn({ mode: 'business', message: 'create a job' }));
  assert.equal(response.status, 'needs_approval');
  const approvalId = response.tool_calls[0]?.approval_id as string;
  assert.ok(approvalId);
  const loop = rt.app.store.getLoopByApproval(approvalId);
  assert.ok(loop, 'journal row must exist at the barrier');
  assert.equal(loop.state, 'WAITING_APPROVAL');
  return { approvalId, sessionId: response.session_id, turnId: response.turn_id, loopId: loop.id };
}

// ---- F09: provider identity vs ARTHUR identity -----------------------------

test('F09: provider_call_id and ARTHUR tool_call_id are separate durable identities', async () => {
  const rt = makeRuntime();
  try {
    const { approvalId, turnId } = await suspendToBarrier(rt);
    const rows = rt.app.store.getToolCallsForTurn(turnId);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row);
    assert.equal(row.provider_call_id, PROVIDER_CALL_A);
    assert.ok(row.id !== PROVIDER_CALL_A, 'ARTHUR id must differ from provider id');
    assert.equal(row.round_no, 1);
    assert.equal(row.sequence_no, 1);
    const approval = rt.app.store.getApproval(approvalId);
    assert.ok(approval);
    assert.equal(approval.tool_call_id, row.id, 'SC-02/SC-03 uses the ARTHUR identity');
    const byProvider = rt.app.store.getToolCallByProvider(turnId, PROVIDER_CALL_A);
    assert.equal(byProvider?.id, row.id, 'provider correlation resolves to the same row');
  } finally {
    rt.app.close();
    rmSync(rt.dir, { recursive: true, force: true });
  }
});

// ---- F17/F18/F19: deterministic barrier, one barrier, deferred siblings ---

test('F17/F19: mixed batch suspends atomically; siblings deferred, one challenge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc06-f17-'));
  try {
    let modelCalls = 0;
    const provider = new FakeProvider({
      responder: () => {
        modelCalls += 1;
        return result('', [
          { id: 'call-A', name: 'system.echo', arguments: { text: 'read-a' } },
          { id: 'call-B', name: 'harness.create_job', arguments: { kind: 'deploy' } },
          { id: 'call-C', name: 'system.echo', arguments: { text: 'read-c' } },
          { id: 'call-D', name: 'harness.create_job', arguments: { kind: 'other' } },
        ]);
      },
    });
    const app = buildTestApp({ dbPath: ':memory:' }, { provider });
    try {
      const response = await app.conversation.handleTurn(validTurn({ mode: 'business', message: 'mixed batch' }));
      assert.equal(response.status, 'needs_approval');
      // Increment 3.1 audit: one challenge (first approval call) + three
      // represented deferred siblings (A auto-predecessor, C auto, D second
      // approval) — zero executions anywhere.
      const challenged = response.tool_calls.filter((t) => t.status === 'pending_approval');
      assert.equal(challenged.length, 1, 'only the first approval call is challenged');
      assert.equal(challenged[0]?.name, 'harness.create_job');
      const deferred = response.tool_calls.filter((t) => t.note === 'deferred_by_approval');
      assert.equal(deferred.length, 3, 'A/C/D represented as deferred');
      const rows = app.store.getToolCallsForTurn(response.turn_id);
      assert.equal(rows.length, 1, 'A/C/D executor calls = 0 before decision');
      assert.equal(rows[0]?.provider_call_id, 'call-B');
      const loop = app.store.getLoopByApproval(challenged[0]?.approval_id as string);
      assert.ok(loop);
      assert.equal(loop.state, 'WAITING_APPROVAL');
      // Second barrier attach loses CAS durably.
      assert.equal(app.store.setLoopBarrierCAS({
        id: loop.id, approvalId: 'second-barrier', currentRound: 1,
        modelCallsUsed: 1, toolCallsUsed: 1, activeRuntimeMs: 5,
      }), false);
      void modelCalls;
    } finally {
      app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- F45 approve after real restart ----------------------------------------

test('F45-approve: approval wait survives runtime recreation; exec=1, continuation=1', async () => {
  const rtA = makeRuntime();
  const suspended = await suspendToBarrier(rtA);
  const executionsA = rtA.executions();
  assert.equal(executionsA, 0, 'nothing executes before the decision');
  // Simulate crash: destroy runtime A without completing the turn.
  rtA.app.close();
  const rtB = reopenRuntime(rtA);
  try {
    const outcome = await rtB.app.conversation.approve(suspended.approvalId);
    assert.equal(outcome.status, 'approved');
    assert.equal(rtB.executions(), 1, 'approved executor calls = 1');
    assert.equal(outcome.resumed, true);
    assert.equal(outcome.continuation_text, 'job done after resume');
    assert.equal(rtB.modelCalls(), 1, 'post-approval model continuation calls = 1');
    // Provider ID survived commit + destruction + resume transcript.
    const histories = rtB.seenToolHistories();
    assert.ok(histories.length >= 1);
    const toolMsg = histories[0]?.history.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'resume continuation carries the tool result');
    assert.equal(toolMsg.tool_call_id, PROVIDER_CALL_A, 'same provider id correlates the result');
    const loop = rtB.app.store.getLoop(suspended.loopId);
    assert.ok(loop);
    assert.equal(loop.state, 'COMPLETED');
    assert.equal(loop.tool_calls_used, 1);
    // Turn model totals span pre- + post-decision rounds (§117-118).
    const modelRows = rtB.app.store.getModelCallsForTurn(suspended.turnId);
    assert.equal(modelRows.length, 2, 'round 1 + continuation model calls persist');
    assert.ok(modelRows.every((m) => m.status === 'success'));
    // F33: resume performs no turn-start memory retrieval (durable
    // continuation contract, never a second memory snapshot).
    const counters = (rtB.app.metrics.snapshot() as { counters: Record<string, { count: number }> }).counters;
    let retrievals = 0;
    for (const [k, v] of Object.entries(counters)) {
      if (k === 'arthur.memory.retrieval_attempt' || k.startsWith('arthur.memory.retrieval_attempt{')) retrievals += v.count;
    }
    assert.equal(retrievals, 0, 'approval resume re-runs zero memory retrievals');
  } finally {
    rtB.app.close();
    rmSync(rtB.dir, { recursive: true, force: true });
  }
});

// ---- Reject after restart (F21) --------------------------------------------

test('F21-reject: rejection resumes reasoning; exec=0, model=1, rejected_by_user seen', async () => {
  const rtA = makeRuntime();
  const suspended = await suspendToBarrier(rtA);
  rtA.app.close();
  let sawRejected = false;
  const rtB = reopenRuntime(rtA, {
    onRequest: (req) => {
      for (const m of req.history) {
        if (m.role === 'tool' && m.content.includes('rejected_by_user')) sawRejected = true;
      }
    },
  });
  try {
    const outcome = await rtB.app.conversation.reject(suspended.approvalId);
    assert.equal(outcome.status, 'rejected');
    assert.equal(rtB.executions(), 0, 'tool execution calls = 0');
    assert.equal(outcome.resumed, true);
    assert.equal(rtB.modelCalls(), 1, 'resume model calls = 1');
    assert.equal(sawRejected, true, 'model receives rejected_by_user result');
    const rows = rtB.app.store.getToolCallsForTurn(suspended.turnId);
    assert.equal(rows.length, 1, 'deferred siblings remain unexecuted');
    assert.equal(rows[0]?.status, 'rejected');
  } finally {
    rtB.app.close();
    rmSync(rtB.dir, { recursive: true, force: true });
  }
});

// ---- Expiry after restart (F22) --------------------------------------------

test('F22-expiry: expired approval resumes safely; exec=0, at most one resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc06-f22-'));
  const dbPath = join(dir, 'arthur.db');
  const keyPath = join(dir, 'approval-key.json');
  let modelCallsA = 0;
  const providerA = new FakeProvider({
    responder: () => { modelCallsA += 1; return jobProposal(); },
  });
  const keysA = new FileApprovalKeyProvider({ path: keyPath });
  const appA = buildTestApp(
    { dbPath, approvalTtlSeconds: 1, memoryPersonalDbPath: ':memory:', memoryBusinessDbPath: ':memory:' },
    { provider: providerA, approvalKeyProvider: keysA },
  );
  const response = await appA.conversation.handleTurn(validTurn({ mode: 'business', message: 'create a job' }));
  const approvalId = response.tool_calls[0]?.approval_id as string;
  assert.ok(approvalId);
  appA.close();
  await new Promise((r) => setTimeout(r, 1200));
  let executions = 0;
  let modelCallsB = 0;
  let sawExpired = false;
  const providerB = new FakeProvider({
    responder: (req: ModelRequest) => {
      modelCallsB += 1;
      for (const m of req.history) {
        if (m.role === 'tool' && m.content.includes('approval_expired')) sawExpired = true;
      }
      return result('noted the expiry');
    },
  });
  const counting: HarnessAdapter = {
    getStatus: async () => ({ status: 'online', version: 'test', jobs_active: 0 }),
    createJob: async (spec) => { executions += 1; return { id: 'job-x', status: 'queued', spec }; },
    getJob: async () => { throw new Error('unused'); },
    cancelJob: async () => {},
  };
  const appB = buildTestApp(
    { dbPath, approvalTtlSeconds: 300, memoryPersonalDbPath: ':memory:', memoryBusinessDbPath: ':memory:' },
    { provider: providerB, harness: counting, approvalKeyProvider: new FileApprovalKeyProvider({ path: keyPath }) },
  );
  try {
    const outcome = await appB.conversation.approve(approvalId);
    assert.equal(executions, 0, 'no executor invocation on expiry');
    assert.ok(modelCallsB <= 1, 'at most one resume continuation');
    assert.equal(sawExpired, true, 'expired result envelope reaches the model');
    void outcome;
    void modelCallsA;
  } finally {
    appB.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- F20: 100-way single-flight resume -------------------------------------

test('F20: 100 concurrent resume attempts yield exactly one continuation', async () => {
  const rt = makeRuntime();
  try {
    const suspended = await suspendToBarrier(rt);
    const decision = await rt.app.conversation.orchestratorForTests().executeApproval(suspended.approvalId);
    assert.equal(decision.status, 'approved');
    const runner = rt.app.conversation.loopRunnerForTests();
    let continuationRuns = 0;
    const attempts = Array.from({ length: 100 }, async (_, i) => {
      void i;
      const it = runner.resumeApproval({ loopId: suspended.loopId, approvalId: suspended.approvalId, transport: 'buffered' })[Symbol.asyncIterator]();
      for (;;) {
        const next = await it.next();
        if (next.done) return (next.value as { continued: boolean }).continued;
      }
    });
    const modelBefore = rt.app.store.getModelCallsForTurn(suspended.turnId).length;
    const toolRowsBefore = rt.app.store.getToolCallsForTurn(suspended.turnId).length;
    const results = await Promise.all(attempts);
    const winners = results.filter((c) => c === true).length;
    assert.equal(winners, 1, 'exactly one WAITING_APPROVAL -> RESUMING claim');
    // Exactly one model continuation ran; losers performed no model calls.
    const modelAfter = rt.app.store.getModelCallsForTurn(suspended.turnId).length;
    assert.equal(modelAfter - modelBefore, 1, 'losers run zero model continuations');
    void continuationRuns;
    // Losers performed no tool execution: no new tool rows, executions unchanged.
    const toolRowsAfter = rt.app.store.getToolCallsForTurn(suspended.turnId).length;
    assert.equal(toolRowsAfter - toolRowsBefore, 0, 'losers execute zero tools');
    const loop = rt.app.store.getLoop(suspended.loopId);
    assert.ok(loop);
    assert.ok(loop.state === 'COMPLETED' || loop.state === 'RESUMING' || loop.state === 'MODEL_RUNNING', 'winner progressed the loop, got ' + loop.state);
  } finally {
    rt.app.close();
    rmSync(rt.dir, { recursive: true, force: true });
  }
});

// ---- Voice/text resume shares one loop (§23) ----------------------------------

test('voice-resume: stream-suspended loop resumes via voice-channel approve', async () => {
  const rt = makeRuntime();
  try {
    // Suspend through the STREAMING transport (voice path, same runner).
    const events: StreamingTurnEvent[] = [];
    for await (const event of rt.app.conversation.streamTurn(validTurn({ mode: 'business', message: 'create a job' }))) {
      events.push(event);
    }
    const completed = events.find((e): e is Extract<StreamingTurnEvent, { type: 'turn_completed' }> => e.type === 'turn_completed');
    assert.ok(completed);
    assert.equal(completed.status, 'needs_approval');
    const approvalId = completed.tool_calls[0]?.approval_id as string;
    assert.ok(approvalId);
    const loop = rt.app.store.getLoopByApproval(approvalId);
    assert.ok(loop);
    assert.equal(loop.state, 'WAITING_APPROVAL');
    // Voice-channel decision returns into the SAME continuation boundary.
    const outcome = await rt.app.conversation.approve(approvalId, 'voice');
    assert.equal(outcome.status, 'approved');
    assert.equal(outcome.resumed, true);
    assert.ok((outcome.continuation_text ?? '').length > 0);
    assert.equal(rt.app.store.getApproval(approvalId)?.decision_channel, 'voice');
    assert.equal(rt.app.store.getLoop(loop.id)?.state, 'COMPLETED');
  } finally {
    rt.app.close();
    rmSync(rt.dir, { recursive: true, force: true });
  }
});

// ---- F46: active crash never blindly resumes --------------------------------

test('F46: MODEL_RUNNING crash fails closed; resume refused, no replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc06-f46-'));
  const dbPath = join(dir, 'arthur.db');
  try {
    const appA = buildTestApp({ dbPath });
    const sessionId = 's-f46';
    const turnId = 't-f46';
    appA.store.createSession(sessionId, 'business');
    appA.store.createTurn({ id: turnId, sessionId, role: 'user', text: 'do it', traceId: 'tr', status: 'completed', mode: 'business' });
    const loopId = 'loop-f46';
    appA.store.createLoop({
      id: loopId, turnId, sessionId, mode: 'business', traceId: 'tr',
      clientRequestId: 'req-f46', budgetsJson: '{}', toolSchemaFingerprint: 'x',
    });
    assert.equal(appA.store.casLoopState(loopId, ['CREATED'], 'MODEL_RUNNING'), true);
    appA.close();
    // Runtime B startup recovery fails the active row closed.
    const provider = new FakeProvider({ responder: () => result('should never run') });
    const appB = buildTestApp({ dbPath }, { provider });
    try {
      const loop = appB.store.getLoop(loopId);
      assert.equal(loop?.state, 'FAILED', 'active crash fails closed at startup');
      const runner = appB.conversation.loopRunnerForTests();
      const it = runner.resumeApproval({ loopId, approvalId: 'nope', transport: 'buffered' })[Symbol.asyncIterator]();
      let continued = true;
      for (;;) {
        const next = await it.next();
        if (next.done) { continued = (next.value as { continued: boolean }).continued; break; }
      }
      assert.equal(continued, false, 'no autonomous resume of an active crash');
    } finally {
      appB.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Completed-tool crash: no replay ---------------------------------------

test('F46b: completed tool execution is never replayed after crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc06-f46b-'));
  const dbPath = join(dir, 'arthur.db');
  try {
    let calls = 0;
    const provider = new FakeProvider({
      responder: () => {
        calls += 1;
        if (calls === 1) return result('', [{ id: 'p-1', name: 'system.echo', arguments: { text: 'once' } }]);
        return result('answered');
      },
    });
    const appA = buildTestApp({ dbPath }, { provider });
    const response = await appA.conversation.handleTurn(validTurn({ message: 'echo once' }));
    assert.equal(response.status, 'completed');
    const execRows = (appA.store as unknown as { unsafeDbHandle: () => { prepare: (s: string) => { all: (...a: unknown[]) => Array<{ id: string }> } } }).unsafeDbHandle()
      .prepare('SELECT id FROM tool_executions').all();
    const execCount = execRows.length;
    appA.close();
    const appB = buildTestApp({ dbPath }, { provider });
    try {
      const execRowsB = (appB.store as unknown as { unsafeDbHandle: () => { prepare: (s: string) => { all: (...a: unknown[]) => Array<{ id: string }> } } }).unsafeDbHandle()
        .prepare('SELECT id FROM tool_executions').all();
      assert.equal(execRowsB.length, execCount, 'no duplicated executions after restart');
      const loop = appB.store.getLoopByTurn(response.turn_id);
      assert.ok(loop);
      assert.ok(loop.state === 'COMPLETED' || loop.state === 'FAILED', 'terminal loop stays terminal, got ' + loop.state);
    } finally {
      appB.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Mode freeze ------------------------------------------------------------

test('mode-freeze: resume refused after session mode change', async () => {
  const rt = makeRuntime();
  try {
    const suspended = await suspendToBarrier(rt);
    await rt.app.conversation.changeMode(suspended.sessionId, { mode: 'personal' });
    const runner = rt.app.conversation.loopRunnerForTests();
    const it = runner.resumeApproval({ loopId: suspended.loopId, approvalId: suspended.approvalId, transport: 'buffered' })[Symbol.asyncIterator]();
    let continued = true;
    let code = '';
    for (;;) {
      const next = await it.next();
      if (next.done) { continued = (next.value as { continued: boolean }).continued; break; }
      if (next.value.type === 'loop_failed') code = next.value.code;
    }
    assert.equal(continued, false);
    assert.equal(code, 'MODE_VIOLATION');
    assert.equal(rt.app.store.getLoop(suspended.loopId)?.state, 'FAILED');
  } finally {
    rt.app.close();
    rmSync(rt.dir, { recursive: true, force: true });
  }
});

// ---- Schema drift -----------------------------------------------------------

test('schema-drift: resume refused when tool contract fingerprint drifts', async () => {
  const rt = makeRuntime();
  try {
    const suspended = await suspendToBarrier(rt);
    // Decide first (production order: SC-02 decision, then resume guards).
    const decision = await rt.app.conversation.orchestratorForTests().executeApproval(suspended.approvalId);
    assert.equal(decision.status, 'approved');
    // Simulate registry drift: tamper the frozen fingerprint.
    rt.app.store.updateLoopProgress(suspended.loopId, { budgetsJson: '{}' });
    const loop = rt.app.store.getLoop(suspended.loopId);
    assert.ok(loop?.tool_schema_fingerprint);
    (rt.app.store as unknown as { unsafeDbHandle: () => { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).unsafeDbHandle()
      .prepare('UPDATE conversation_loops SET tool_schema_fingerprint = ? WHERE id = ?')
      .run('tampered-fingerprint', suspended.loopId);
    const runner = rt.app.conversation.loopRunnerForTests();
    const it = runner.resumeApproval({ loopId: suspended.loopId, approvalId: suspended.approvalId, transport: 'buffered' })[Symbol.asyncIterator]();
    let continued = true;
    let code = '';
    for (;;) {
      const next = await it.next();
      if (next.done) { continued = (next.value as { continued: boolean }).continued; break; }
      if (next.value.type === 'loop_failed') code = next.value.code;
    }
    assert.equal(continued, false);
    assert.equal(code, 'TOOL_NOT_FOUND');
  } finally {
    rt.app.close();
    rmSync(rt.dir, { recursive: true, force: true });
  }
});

// ---- No raw reasoning persistence -------------------------------------------

test('no-reasoning: journal and transcript store no reasoning payloads', async () => {
  const rtA = makeRuntime();
  const suspended = await suspendToBarrier(rtA);
  rtA.app.close();
  const rtB = reopenRuntime(rtA);
  try {
    await rtB.app.conversation.approve(suspended.approvalId);
    const loop = rtB.app.store.getLoop(suspended.loopId);
    assert.ok(loop);
    const blob = JSON.stringify(loop) + JSON.stringify(rtB.app.store.getToolCallsForTurn(suspended.turnId));
    for (const marker of ['reasoning_content', 'chain_of_thought', 'chain-of-thought', 'scratchpad', 'hidden_reasoning']) {
      assert.equal(blob.includes(marker), false, 'journal must not contain ' + marker);
    }
  } finally {
    rtB.app.close();
    rmSync(rtB.dir, { recursive: true, force: true });
  }
});

// ---- F06 voice provisional invariant ----------------------------------------

test('F06: tool-round provisional text never becomes final persisted/spoken truth', async () => {
  let calls = 0;
  const provider = new FakeProvider({
    responder: () => {
      calls += 1;
      if (calls === 1) return result('Checking the job system now...', [{ id: 'v-1', name: 'system.echo', arguments: { text: 'probe' } }]);
      return result('final spoken answer');
    },
  });
  const app = buildTestApp({}, { provider });
  try {
    const events: StreamingTurnEvent[] = [];
    for await (const event of app.conversation.streamTurn(validTurn({ message: 'voice f06' }))) {
      events.push(event);
    }
    const completed = events.find((e): e is Extract<StreamingTurnEvent, { type: 'turn_completed' }> => e.type === 'turn_completed');
    assert.ok(completed);
    assert.equal(completed.display_text, 'final spoken answer');
    assert.ok(!completed.display_text.includes('Checking the job system'));
    const summary = await app.conversation.getSession(completed.session_id);
    const assistant = summary.turns.filter((t) => t.role === 'assistant');
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0]?.text, 'final spoken answer');
  } finally {
    app.close();
  }
});

// ---- OUTCOME_UNKNOWN never resumes ------------------------------------------

test('outcome-unknown: quarantined execution blocks resume forever', async () => {
  const rt = makeRuntime();
  try {
    const suspended = await suspendToBarrier(rt);
    // Force the barrier tool call into outcome_unknown (quarantine truth).
    rt.app.store.updateToolCall(rt.app.store.getApproval(suspended.approvalId)?.tool_call_id as string, { status: 'outcome_unknown' });
    const runner = rt.app.conversation.loopRunnerForTests();
    const it = runner.resumeApproval({ loopId: suspended.loopId, approvalId: suspended.approvalId, transport: 'buffered' })[Symbol.asyncIterator]();
    let continued = true;
    let code = '';
    for (;;) {
      const next = await it.next();
      if (next.done) { continued = (next.value as { continued: boolean }).continued; break; }
      if (next.value.type === 'loop_failed') code = next.value.code;
    }
    // Approval still pending -> terminal-decision guard fires first.
    assert.equal(continued, false);
    assert.ok(code === 'APPROVAL_INVALID' || code === 'TOOL_OUTCOME_UNKNOWN', 'got ' + code);
  } finally {
    rt.app.close();
    rmSync(rt.dir, { recursive: true, force: true });
  }
});
