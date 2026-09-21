import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HarnessRunRequestSchema, type HarnessEvent } from '@qa/schemas';
import {
  createAgentRunId,
  createProjectContextSnapshotId,
  createQARunId,
  createSnapshotId,
} from '@qa/shared';
import {
  ClaudeClient,
  ClaudeCodeHarnessAdapter,
  isClaudeInitEvent,
  parseStreamJsonLine,
  type ClaudeSessionView,
  type ClaudeSpawnSpec,
  type ClaudeStreamEvent,
  type ClaudeTurnStream,
} from '../src/index.js';

/** Production call sites know the session streams live; narrow the
 *  legacy-compatible union for direct abort()/iteration in tests. */
function liveStream(session: ClaudeSessionView, text: string): ClaudeTurnStream {
  return session.runText(text) as ClaudeTurnStream;
}

/**
 * Production-style streaming/termination proof (TASK-0011 Tests A–F).
 *
 * Every test here drives a REAL owned child process through the
 * production ClaudeClient (spawnProcess seam returns a genuine
 * node fixture child emitting stream-json NDJSON incrementally).
 * Fake-array sessions cannot prove fail-fast behavior; these tests
 * fail against the old whole-turn-buffering implementation because
 * nothing is observable until the fixture exits.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function baseSpec(overrides: Partial<ClaudeSpawnSpec> = {}): ClaudeSpawnSpec {
  return {
    executable: 'claude-test-fixture',
    cwd: process.cwd(),
    configDir: process.cwd(),
    environment: { PATH: process.env['PATH'] },
    modelId: 'glm-5.3-flash',
    settingsPath: 'sentry-settings.json',
    initializeTimeoutMs: 2_000,
    turnTimeoutMs: 30_000,
    shutdownTimeoutMs: 2_000,
    ...overrides,
  };
}

/** Spawn a real fixture child running the given inline script. */
function spawnFixture(script: string): ChildProcess {
  return spawn(process.execPath, ['-e', script], {
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function line(value: unknown): string {
  return JSON.stringify(value);
}

/** Init event every well-behaved fixture emits first. */
function initLine(tools: readonly string[] = ['Bash', 'Read']): string {
  return line({ type: 'system', subtype: 'init', session_id: 's', tools, model: 'm' });
}

async function isGone(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  try {
    process.kill(child.pid as number, 0);
  } catch {
    return true;
  }
  return false;
}

async function waitUntilGone(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isGone(child)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function request(root: string) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'README.md'), '# Fixture\nimportant line\n');
  return HarnessRunRequestSchema.parse({
    schemaVersion: 1,
    agentRunId: createAgentRunId(),
    qaRunId: createQARunId(),
    agentStackId: 'stack_glm_main',
    projectContextSnapshotId: createProjectContextSnapshotId(),
    workspace: {
      runtimePath: root,
      snapshotId: createSnapshotId(),
      writable: true,
      isolated: true,
    },
    model: { provider: 'zai-anthropic', modelId: 'glm-5.3-flash' },
    task: { type: 'qa', prompt: 'Inspect the fixture.', policyId: 'qa-standard', policyVersion: 1 },
    executionSafeguards: { runTimeoutMs: 30_000 },
  });
}

describe('stream-json structural parsing', () => {
  it('recognizes the init signal and skips non-JSON diagnostics', () => {
    const init = parseStreamJsonLine(initLine()) as ClaudeStreamEvent;
    expect(isClaudeInitEvent(init)).toBe(true);
    expect(isClaudeInitEvent({ type: 'assistant', raw: {} })).toBe(false);
    expect(parseStreamJsonLine('[claude-code:marker] noise')).toBeUndefined();
  });
});

describe('Test C — live event delivery while the turn is running', () => {
  it('delivers event 1 before the fixture emits event 3 or exits', async () => {
    let owned: ChildProcess | undefined;
    const script = [
      'const out = (o) => { process.stdout.write(JSON.stringify(o) + "\\n"); };',
      'out(' +
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: 's',
          tools: ['Bash'],
          model: 'm',
        }) +
        ');',
      'let n = 0;',
      'const tick = () => {',
      '  n += 1;',
      '  out({ type: "assistant", message: { content: [{ type: "text", text: "chunk-" + n }] } });',
      '  if (n < 6) setTimeout(tick, 120);',
      '  else setTimeout(() => { out(' +
        JSON.stringify({ type: 'result', is_error: false, subagent_stats: { spawned: 0 } }) +
        '); }, 120);',
      '};',
      'setTimeout(tick, 50);',
    ].join('\n');
    const client = new ClaudeClient({
      ...baseSpec(),
      spawnProcess: () => (owned = spawnFixture(script)),
    });
    const session = await client.startSession();
    const stream = liveStream(session, 'live');
    const seen: ClaudeStreamEvent[] = [];
    let firstAt = 0;
    let thirdAt = 0;
    for await (const event of stream) {
      seen.push(event);
      if (seen.length === 2) firstAt = Date.now();
      if (seen.length === 4) {
        thirdAt = Date.now();
        break;
      }
    }
    // Event 1 (first assistant chunk) arrived while the fixture is still
    // mid-turn: the child must still be alive at that point (buffered
    // implementations can only deliver after exit).
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(firstAt).toBeGreaterThan(0);
    expect(thirdAt).toBeGreaterThanOrEqual(firstAt);
    expect(await isGone(owned as ChildProcess)).toBe(false);
    // Drain + cleanup: abort the still-running turn, then close.
    await stream.abort();
    await client.close();
    expect(await waitUntilGone(owned as ChildProcess, 5_000)).toBe(true);
  });
});

describe('Test A — live identical-failure loop aborts mid-turn', () => {
  it('terminates the fixture around 10 identical failures with GLM_TOOL_LOOP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-live-loop-'));
    roots.push(root);
    const input = await request(root);
    let owned: ChildProcess | undefined;
    // Endless failing Read loop (never exits on its own).
    const script = [
      'const out = (o) => { process.stdout.write(JSON.stringify(o) + "\\n"); };',
      'out(' +
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: 's',
          tools: ['Bash', 'Read'],
          model: 'm',
        }) +
        ');',
      'let i = 0;',
      'const tick = () => {',
      '  const id = "tu-loop-" + i;',
      '  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: "/ws/project" } }] } });',
      '  setTimeout(() => {',
      '    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: [{ type: "text", text: "Error: is a directory" }] }] } });',
      '    i += 1;',
      '    setTimeout(tick, 40);',
      '  }, 10);',
      '};',
      'setTimeout(tick, 50);',
      'setInterval(() => {}, 60_000);',
    ].join('\n');
    const startedAt = Date.now();
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test-fixture',
      modelId: 'glm-5.3-flash',
      environment: {},
      initializeTimeoutMs: 2_000,
      turnTimeoutMs: 60_000,
      shutdownTimeoutMs: 2_000,
      clientFactory: async (spec) =>
        new ClaudeClient({ ...spec, spawnProcess: () => (owned = spawnFixture(script)) }),
    });
    // Single full run: the endless fixture never exits on its own, so a
    // buffered implementation would hang here until the 60s turn timeout.
    // Fail-fast aborts at 10 identical failures (~1s) with GLM_TOOL_LOOP.
    const events: HarnessEvent[] = [];
    for await (const e of adapter.run(input)) events.push(e);
    const elapsed = Date.now() - startedAt;
    await adapter.dispose().catch(() => undefined);
    expect(owned).toBeDefined();
    expect(events.at(-1)?.type).toBe('run.failed');
    expect(JSON.stringify(events.at(-1))).toContain('GLM_TOOL_LOOP');
    const completed = events.filter((e) => e.type === 'tool.completed');
    // Abort lands at the threshold (10), not after 166 wasted calls.
    expect(completed.length).toBeGreaterThanOrEqual(10);
    expect(completed.length).toBeLessThan(30);
    expect(elapsed).toBeLessThan(30_000);
    // Owned child is dead (fail-fast terminates; the old code would leave
    // it looping until the turn timeout).
    expect(await waitUntilGone(owned as ChildProcess, 8_000)).toBe(true);
  });
});

describe('Test D — activity-aware timeout integration', () => {
  it('steady live activity keeps the turn alive; silence kills it', async () => {
    // Steady drip: an event every 120ms against a 400ms silence window
    // must NOT time out (sliding activity deadline earns more time).
    const dripScript = [
      'const out = (o) => { process.stdout.write(JSON.stringify(o) + "\\n"); };',
      'out(' +
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: 's',
          tools: ['Bash'],
          model: 'm',
        }) +
        ');',
      'let n = 0;',
      'const tick = () => {',
      '  n += 1;',
      '  out({ type: "assistant", message: { content: [{ type: "text", text: "drip-" + n }] } });',
      '  if (n < 6) setTimeout(tick, 120);',
      '  else out(' +
        JSON.stringify({ type: 'result', is_error: false, subagent_stats: { spawned: 0 } }) +
        ');',
      '};',
      'setTimeout(tick, 50);',
    ].join('\n');
    const live = new ClaudeClient({
      ...baseSpec({ initializeTimeoutMs: 2_000, turnTimeoutMs: 10_000 }),
      spawnProcess: () => spawnFixture(dripScript),
    });
    const session = await live.startSession();
    const seen: ClaudeStreamEvent[] = [];
    // Sliding window: last event refreshes the deadline. Simulate the
    // coordinator: fail if any 400ms silence gap appears mid-turn.
    let lastAt = Date.now();
    let maxGap = 0;
    for await (const event of liveStream(session, 'drip')) {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - lastAt);
      lastAt = now;
      seen.push(event);
    }
    await live.close();
    expect(seen.some((e) => e.type === 'result')).toBe(true);
    expect(maxGap).toBeLessThan(1_000);
    // Silent turn: init arrives, then nothing — the turn budget (2s)
    // must kill it even though startup succeeded.
    const silentScript = [
      'const out = (o) => { process.stdout.write(JSON.stringify(o) + "\\n"); };',
      'out(' +
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: 's',
          tools: ['Bash'],
          model: 'm',
        }) +
        ');',
      'setInterval(() => {}, 60_000);',
    ].join('\n');
    let owned: ChildProcess | undefined;
    const quiet = new ClaudeClient({
      ...baseSpec({ initializeTimeoutMs: 2_000, turnTimeoutMs: 800 }),
      spawnProcess: () => (owned = spawnFixture(silentScript)),
    });
    const qs = await quiet.startSession();
    await expect(async () => {
      for await (const _ of liveStream(qs, 'quiet')) {
        void _;
      }
    }).rejects.toThrow(/ms budget/);
    expect(await waitUntilGone(owned as ChildProcess, 5_000)).toBe(true);
    await quiet.close();
  });
});

describe('Test E — initialization timeout', () => {
  it('kills a silent fixture near initializeTimeoutMs, not turnTimeoutMs', async () => {
    let owned: ChildProcess | undefined;
    const silent = 'setInterval(() => {}, 60_000);';
    const client = new ClaudeClient({
      ...baseSpec({ initializeTimeoutMs: 400, turnTimeoutMs: 30_000 }),
      spawnProcess: () => (owned = spawnFixture(silent)),
    });
    const session = await client.startSession();
    const startedAt = Date.now();
    await expect(async () => {
      for await (const _ of liveStream(session, 'silent')) {
        void _;
      }
    }).rejects.toThrow(/no initialization event within/);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(10_000);
    expect(await waitUntilGone(owned as ChildProcess, 5_000)).toBe(true);
    await client.close();
  });

  it('enters the normal turn when init arrives before the deadline', async () => {
    const script = [
      'const out = (o) => { process.stdout.write(JSON.stringify(o) + "\\n"); };',
      'setTimeout(() => {',
      '  out(' +
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: 's',
          tools: ['Bash'],
          model: 'm',
        }) +
        ');',
      '  out({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } });',
      '  out(' +
        JSON.stringify({ type: 'result', is_error: false, subagent_stats: { spawned: 0 } }) +
        ');',
      '}, 50);',
    ].join('\n');
    const client = new ClaudeClient({
      ...baseSpec({ initializeTimeoutMs: 5_000, turnTimeoutMs: 30_000 }),
      spawnProcess: () => spawnFixture(script),
    });
    const session = await client.startSession();
    const seen: ClaudeStreamEvent[] = [];
    for await (const event of liveStream(session, 'hello')) seen.push(event);
    expect(seen.some((e) => e.type === 'system')).toBe(true);
    expect(seen.some((e) => e.type === 'result')).toBe(true);
    await client.close();
  });
});

describe('Test F — cancellation while the turn is active', () => {
  it('aborting the live turn kills the owned child', async () => {
    let owned: ChildProcess | undefined;
    const script =
      'setInterval(() => { process.stdout.write("{\\"type\\":\\"assistant\\"}\\n"); }, 100);';
    const client = new ClaudeClient({
      ...baseSpec(),
      spawnProcess: () => (owned = spawnFixture(script)),
    });
    const session = await client.startSession();
    const stream = liveStream(session, 'hang');
    // Let the turn go live.
    const deadline = Date.now() + 5_000;
    while (client.activeChildCount === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(client.activeChildCount).toBe(1);
    await stream.abort();
    expect(await waitUntilGone(owned as ChildProcess, 5_000)).toBe(true);
    await client.close();
    expect(client.activeChildCount).toBe(0);
  });

  it('adapter cancel aborts the in-flight turn and the child dies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-live-cancel-'));
    roots.push(root);
    const input = await request(root);
    let owned: ChildProcess | undefined;
    // Fixture emits observable tool activity (tool_use + successful
    // result pairs): text-only chunks produce no harness events, so a
    // text-only fixture would leave the 3rd iterator next() pending
    // forever and the cancel below untested (pre-existing test bug).
    const script = [
      'const out = (o) => { process.stdout.write(JSON.stringify(o) + "\\n"); };',
      'out(' +
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: 's',
          tools: ['Bash', 'Read'],
          model: 'm',
        }) +
        ');',
      'let i = 0;',
      'setInterval(() => {',
      '  const id = "tu-cancel-" + (i++);',
      '  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "echo hi" } }] } });',
      '  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "hi" }] }] } });',
      '}, 100);',
    ].join('\n');
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test-fixture',
      modelId: 'glm-5.3-flash',
      environment: {},
      initializeTimeoutMs: 2_000,
      turnTimeoutMs: 60_000,
      shutdownTimeoutMs: 2_000,
      clientFactory: async (spec) =>
        new ClaudeClient({ ...spec, spawnProcess: () => (owned = spawnFixture(script)) }),
    });
    const iter = adapter.run(input)[Symbol.asyncIterator]();
    // Consume until live activity proves the turn is running.
    for (let i = 0; i < 6; i += 1) {
      const step = await iter.next();
      if (step.done === true) break;
    }
    expect(owned).toBeDefined();
    expect(await isGone(owned as ChildProcess)).toBe(false);
    await adapter.cancel(input.agentRunId);
    expect(await waitUntilGone(owned as ChildProcess, 8_000)).toBe(true);
    await adapter.dispose().catch(() => undefined);
  });
});

describe('Test B — live distinct-path sweep aborts at the consecutive threshold', () => {
  it('terminates an endless distinct-path sweep at 25 consecutive failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-live-sweep-'));
    roots.push(root);
    const input = await request(root);
    let owned: ChildProcess | undefined;
    // Endless sweep: every failure uses a DISTINCT path, so the
    // identical-signature breaker (10) never trips — only the
    // consecutive-failure rate breaker (25) can stop it.
    const script = [
      'const out = (o) => { process.stdout.write(JSON.stringify(o) + "\\n"); };',
      'out(' +
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: 's',
          tools: ['Bash', 'Read'],
          model: 'm',
        }) +
        ');',
      'let i = 0;',
      'const tick = () => {',
      '  const id = "tu-sweep-" + i;',
      '  const p = "/ws/project/file-" + i + ".ts";',
      '  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: p } }] } });',
      '  setTimeout(() => {',
      '    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: [{ type: "text", text: "Error: file not found" }] }] } });',
      '    i += 1;',
      '    setTimeout(tick, 30);',
      '  }, 10);',
      '};',
      'setTimeout(tick, 50);',
      'setInterval(() => {}, 60_000);',
    ].join('\n');
    const startedAt = Date.now();
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test-fixture',
      modelId: 'glm-5.3-flash',
      environment: {},
      initializeTimeoutMs: 2_000,
      turnTimeoutMs: 60_000,
      shutdownTimeoutMs: 2_000,
      clientFactory: async (spec) =>
        new ClaudeClient({ ...spec, spawnProcess: () => (owned = spawnFixture(script)) }),
    });
    const events: HarnessEvent[] = [];
    for await (const e of adapter.run(input)) events.push(e);
    const elapsed = Date.now() - startedAt;
    await adapter.dispose().catch(() => undefined);
    expect(owned).toBeDefined();
    expect(events.at(-1)?.type).toBe('run.failed');
    expect(JSON.stringify(events.at(-1))).toContain('GLM_TOOL_LOOP');
    expect(JSON.stringify(events.at(-1))).toContain('Twenty-five consecutive');
    const completed = events.filter((e) => e.type === 'tool.completed');
    expect(completed.length).toBeGreaterThanOrEqual(25);
    expect(completed.length).toBeLessThan(60);
    expect(elapsed).toBeLessThan(30_000);
    expect(await waitUntilGone(owned as ChildProcess, 8_000)).toBe(true);
  });
});

describe('live abort wiring via controllable in-process stream (sandbox-safe)', () => {
  it('yields events incrementally while the turn is still producing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-fake-live-'));
    roots.push(root);
    const input = await request(root);
    let abortCalls = 0;
    const seenByCoordinator: HarnessEvent[] = [];
    // Controllable live stream factory: an endless identical-failure
    // loop with small delays (like a real child), records abort().
    const mintStream = (): ClaudeTurnStream => {
      const loop = (async function* (): AsyncGenerator<ClaudeStreamEvent> {
        yield { type: 'system', raw: { subtype: 'init', tools: ['Bash', 'Read'], model: 'm' } };
        let i = 0;
        for (;;) {
          const id = 'tu-loop-' + i + '-' + Math.random().toString(36).slice(2, 6);
          yield {
            type: 'assistant',
            raw: {
              message: {
                content: [
                  { type: 'tool_use', id, name: 'Read', input: { file_path: '/ws/project' } },
                ],
              },
            },
          };
          await new Promise((r) => setTimeout(r, 5));
          yield {
            type: 'user',
            raw: {
              message: {
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: id,
                    is_error: true,
                    content: [{ type: 'text', text: 'Error: is a directory' }],
                  },
                ],
              },
            },
          };
          i += 1;
        }
      })();
      return Object.assign(loop, {
        abort: async () => {
          abortCalls += 1;
          await loop.return?.(undefined);
        },
        initialized: true,
        settled: false,
        done: Promise.resolve(),
      });
    };
    const firstStream = mintStream();
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-fake-live',
        startSession: async () => ({ runText: () => firstStream }),
        close: async () => undefined,
      }),
    });
    const startedAt = Date.now();
    for await (const e of adapter.run(input)) {
      seenByCoordinator.push(e);
      // Incremental-delivery proof: the coordinator observes tool
      // completions while the turn is still producing (the generator is
      // infinite — a buffered implementation would never yield at all).
      if (seenByCoordinator.filter((x) => x.type === 'tool.completed').length >= 3) break;
      if (Date.now() - startedAt > 10_000) break;
    }
    await firstStream.abort();
    await adapter.dispose().catch(() => undefined);
    const completed = seenByCoordinator.filter((e) => e.type === 'tool.completed');
    expect(completed.length).toBeGreaterThanOrEqual(3);
    expect(abortCalls).toBeGreaterThanOrEqual(1);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('full single run aborts the live stream at the threshold with GLM_TOOL_LOOP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-fake-live-full-'));
    roots.push(root);
    const input = await request(root);
    let abortCalls = 0;
    let produced = 0;
    // Finite-at-30 generator: would emit 30 failures if never aborted.
    // The adapter must abort at 10 and surface GLM_TOOL_LOOP.
    const gen = (async function* (): AsyncGenerator<ClaudeStreamEvent> {
      yield { type: 'system', raw: { subtype: 'init', tools: ['Bash', 'Read'], model: 'm' } };
      for (let i = 0; i < 30; i += 1) {
        const id = 'tu-loop-' + i;
        yield {
          type: 'assistant',
          raw: {
            message: {
              content: [
                { type: 'tool_use', id, name: 'Read', input: { file_path: '/ws/project' } },
              ],
            },
          },
        };
        yield {
          type: 'user',
          raw: {
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: id,
                  is_error: true,
                  content: [{ type: 'text', text: 'Error: is a directory' }],
                },
              ],
            },
          },
        };
        produced = i + 1;
      }
      yield { type: 'result', raw: { is_error: false, subagent_stats: { spawned: 0 } } };
    })();
    const fakeStream: ClaudeTurnStream = Object.assign(gen, {
      abort: async () => {
        abortCalls += 1;
        await gen.return?.(undefined);
      },
      initialized: true,
      settled: false,
      done: Promise.resolve(),
    });
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-fake-live-full',
        startSession: async () => ({ runText: () => fakeStream }),
        close: async () => undefined,
      }),
    });
    const events: HarnessEvent[] = [];
    for await (const e of adapter.run(input)) events.push(e);
    await adapter.dispose().catch(() => undefined);
    expect(events.at(-1)?.type).toBe('run.failed');
    expect(JSON.stringify(events.at(-1))).toContain('GLM_TOOL_LOOP');
    // Abort fired mid-stream: the generator never produced all 30.
    expect(abortCalls).toBeGreaterThanOrEqual(1);
    expect(produced).toBeLessThan(30);
    const completed = events.filter((e) => e.type === 'tool.completed');
    expect(completed.length).toBeGreaterThanOrEqual(10);
    expect(completed.length).toBeLessThan(30);
  });
});
