import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
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
import { ClaudeCodeHarnessAdapter } from '../src/index.js';

/**
 * Opt-in LIVE tests against the real Claude Code binary (default: skipped).
 *
 * Run with SENTRY_LIVE_CLAUDE=1 on a machine with the `claude` binary and
 * a working sandbox. No provider credentials are needed: a local
 * Anthropic-compatible stub feeds scripted turns (tool + plan text,
 * investigation text, valid empty report). These prove, against the REAL
 * binary (not mocks), that Sentry's generated permission configuration
 * lets trivial Bash execute and known files be read (Tests 2+3), and that
 * forbidden tools stay denied (Test 4 live shape).
 *
 * Read assertions are deterministic (Read never touches bwrap). The Bash
 * smoke requires REAL bwrap execution with exit 0: with the Sentry-owned
 * ephemeral HOME, the sandbox initializes instead of dying on
 * Windows-mounted host profiles. If Bash cannot execute, the GLM stack
 * is not production-ready — this test fails loudly (it is opt-in so a
 * broken TUNNEL machine never blocks normal CI).
 */

// Live tests need a Linux runtime: the `claude` binary, its sandbox, and
// localhost stub networking. On Windows checkouts they skip (run them from
// WSL: `wsl -d Ubuntu -- bash -c 'cd /mnt/c/.../Sentry && SENTRY_LIVE_CLAUDE=1 pnpm ...'`
// or point SENTRY_LIVE_CLAUDE_BIN at a working binary).
const LIVE =
  process.env['SENTRY_LIVE_CLAUDE'] === '1' &&
  (process.platform === 'linux' || process.env['SENTRY_LIVE_CLAUDE_BIN'] !== undefined);
const CLAUDE_BIN = process.env['SENTRY_LIVE_CLAUDE_BIN'] ?? 'claude';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type PlanStep = { tool: string; input: unknown } | { text: string };

/** Minimal scripted provider: serves plan steps in order, then 'done'. */
async function startStub(plan: PlanStep[]): Promise<{ url: string }> {
  let toolServeIds = 0;
  let toolCursor = 0;
  let toolAwaitingResult = false;
  let toolReserves = 0;
  const usedTexts = new Set<PlanStep>();
  const planTexts = plan.filter((s) => !('tool' in s));
  const toolSteps = plan.filter((s) => 'tool' in s);
  const textTurn = (text: string) => [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 's',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    {
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
  // Unique tool_use ids per serve: a re-served retry after the
  // first-turn drop must not collapse into the dropped attempt in
  // adapter-side operation tracking.
  const toolTurn = (tool: string, input: unknown) => {
    toolServeIds += 1;
    const toolUseId = 'to_live_' + toolServeIds;
    return [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: 's',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { id: toolUseId, type: 'tool_use', name: tool, input },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
        },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ];
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url === '/api/hello') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const accept = String(req.headers['accept'] ?? '');
      let streamed = accept.includes('text/event-stream');
      try {
        if ((JSON.parse(body || '{}') as { stream?: unknown }).stream === true) streamed = true;
      } catch {
        // Non-JSON bodies fall back to the Accept-header verdict.
      }
      // Non-streaming requests get a benign text turn WITHOUT consuming
      // plan steps (the CLI issues them around streaming turns).
      if (!streamed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: 's',
            content: [{ type: 'text', text: 'noted' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
        return;
      }
      // Phase-routed serving (robust against auxiliary streamed calls
      // such as session-title generation, and against the first-turn
      // tools=[] race that silently drops a served tool_use): the
      // request body's accumulated conversation identifies the phase,
      // so steps can never be consumed out of order. Planning and
      // reporting serve their designated text idempotently; the
      // investigation turn serves tool steps in order (each until its
      // tool_result arrives, re-served identically when dropped, capped)
      // then its text. Unrecognized calls and exhausted scripts get
      // benign text without consuming anything.
      const bodyHasResult = body.includes('tool_result');
      const phase: 'planning' | 'investigation' | 'reporting' | 'unknown' = body.includes(
        'Serialize the investigation you just completed',
      )
        ? 'reporting'
        : body.includes('Execute the frozen investigation plan below')
          ? 'investigation'
          : body.includes('Create an investigation plan before executing it.')
            ? 'planning'
            : 'unknown';
      let step: PlanStep | undefined;
      if (phase === 'planning') {
        step = planTexts[0];
      } else if (phase === 'reporting') {
        step = planTexts.length > 0 ? planTexts[planTexts.length - 1] : undefined;
      } else if (phase === 'investigation') {
        // Abandon a tool step the worker never executes (cap re-serves:
        // a dropped serve must not pin the turn forever).
        if (toolAwaitingResult && !bodyHasResult && toolReserves >= 4) {
          toolCursor += 1;
          toolAwaitingResult = false;
          toolReserves = 0;
        }
        const current = toolCursor < toolSteps.length ? toolSteps[toolCursor] : undefined;
        if (current === undefined) {
          const followup = planTexts.length > 1 ? planTexts[1] : undefined;
          if (followup !== undefined && !usedTexts.has(followup)) {
            step = followup;
            usedTexts.add(followup);
          }
        } else if (toolAwaitingResult && !bodyHasResult) {
          step = current;
          toolReserves += 1;
        } else {
          if (toolAwaitingResult && bodyHasResult) {
            toolCursor += 1;
            toolAwaitingResult = false;
            toolReserves = 0;
          }
          const next = toolCursor < toolSteps.length ? toolSteps[toolCursor] : undefined;
          if (next !== undefined) {
            step = next;
            toolAwaitingResult = true;
          } else {
            const followup = planTexts.length > 1 ? planTexts[1] : undefined;
            if (followup !== undefined && !usedTexts.has(followup)) {
              step = followup;
              usedTexts.add(followup);
            }
          }
        }
      }
      const chunks =
        step !== undefined && 'tool' in step
          ? toolTurn(step.tool, step.input)
          : textTurn(step !== undefined && 'text' in step ? step.text : 'done');
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.end(
        chunks
          .map(
            (chunk) => 'event: ' + chunk.event + '\ndata: ' + JSON.stringify(chunk.data) + '\n\n',
          )
          .join(''),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string' || address.port === 0) {
    throw new Error('Live stub failed to bind');
  }
  servers.push(server);
  return { url: 'http://127.0.0.1:' + String(address.port) };
}

function validPlanJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    projectUnderstanding: 'Live probe fixture',
    criticalFlows: ['Read path'],
    weakPoints: ['Boundary'],
    plannedChecks: ['Read the known file'],
  });
}

function validEmptyReportJson(): string {
  return JSON.stringify({
    schemaVersion: 2,
    summary: 'Live probe found nothing.',
    checks: [],
    hypotheses: [],
    evidence: [],
    findings: [],
    limitations: [],
  });
}

async function liveRequest(root: string, endpoint: string) {
  await mkdir(join(root, 'project'), { recursive: true });
  await writeFile(join(root, 'project', 'known-file.txt'), 'live probe content\n');
  const request = HarnessRunRequestSchema.parse({
    schemaVersion: 1,
    agentRunId: createAgentRunId(),
    qaRunId: createQARunId(),
    agentStackId: 'stack_glm_main',
    projectContextSnapshotId: createProjectContextSnapshotId(),
    workspace: {
      runtimePath: join(root, 'project'),
      snapshotId: createSnapshotId(),
      writable: true,
      isolated: true,
    },
    model: { provider: 'zai-anthropic', modelId: 'glm-5.3-flash' },
    task: { type: 'qa', prompt: 'Live probe.', policyId: 'qa-standard', policyVersion: 1 },
    executionSafeguards: { runTimeoutMs: 120_000 },
  });
  const adapter = new ClaudeCodeHarnessAdapter({
    executable: CLAUDE_BIN,
    modelId: 'glm-5.3-flash',
    environment: {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      ANTHROPIC_BASE_URL: endpoint,
      ANTHROPIC_AUTH_TOKEN: 'live-test-fake-token',
      SENTRY_GLM_MODEL: 'glm-5.3-flash',
    },
  });
  return { request, adapter };
}

describe.skipIf(!LIVE)('GLM live binary smoke (opt-in)', () => {
  it('reads a known file through the real binary with generated permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-live-'));
    roots.push(root);
    const { url } = await startStub([
      { tool: 'Read', input: { file_path: join(root, 'project', 'known-file.txt') } },
      { text: validPlanJson() },
      { text: 'Investigation complete.' },
      { text: validEmptyReportJson() },
    ]);
    const { request, adapter } = await liveRequest(root, url);
    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(request)) events.push(event);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    const messages = events
      .filter((event) => event.type === 'agent.message')
      .map((event) => (event as { message?: string }).message ?? '');
    // The known file's content reached run history through the REAL binary.
    expect(messages.some((message) => message.includes('live probe content'))).toBe(true);
    const completed = events.filter((event) => event.type === 'tool.completed');
    expect(completed.length).toBeGreaterThanOrEqual(1);
    // Read carries no fabricated exit code (honesty invariant, live shape).
    for (const event of completed) {
      expect((event as { tool?: { exitCode?: number } }).tool?.exitCode).toBeUndefined();
    }
  }, 120_000);

  it('executes Bash through the real bwrap sandbox with exit 0', async () => {
    // Fix-5 proof (run_01M33YXNW80W2Q7H1HK5EA5K7Q): Bash is core QA
    // capability. The ephemeral HOME lets bwrap initialize; printf must
    // run and report exit 0 with observable output. Any bwrap/Can't
    // mkdir/Permission denied/sandbox-unavailable marker fails the test —
    // never tolerated as an environmental flake.
    // TASK-0012 authoritative gate: Desktop Sentry → WSL runtime → real
    // Claude Code → Sentry isolated HOME/config → real bubblewrap → real
    // Bash → `printf sentry-bash-ok` → exit 0. Run from WSL:
    // wsl -d Ubuntu -- bash -c 'cd /mnt/c/.../Sentry && SENTRY_LIVE_CLAUDE=1 pnpm --filter @qa/harness-claude-code test -- tests/claude-live.test.ts -t "real bwrap sandbox"'
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-live-bash-'));
    roots.push(root);
    const { url } = await startStub([
      { tool: 'Bash', input: { command: 'printf sentry-bash-ok' } },
      { text: validPlanJson() },
      { text: 'Investigation complete.' },
      { text: validEmptyReportJson() },
    ]);
    const { request, adapter } = await liveRequest(root, url);
    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(request)) events.push(event);
    await adapter.dispose();
    // No infrastructure short-circuit: sandbox/version gates must not fire
    // on a healthy worker (their codes here mean the gate itself regressed).
    const terminal = events.at(-1) as { failure?: { code?: string } } | undefined;
    expect(terminal?.failure?.code ?? 'none').not.toBe('GLM_SANDBOX_UNAVAILABLE');
    expect(terminal?.failure?.code ?? 'none').not.toBe('GLM_CLAUDE_VERSION_UNSUPPORTED');
    expect(events.at(-1)?.type).toBe('run.completed');
    const completed = events.filter((event) => event.type === 'tool.completed') as Array<{
      tool?: {
        name?: string;
        exitCode?: number;
        errorPreview?: string;
        infrastructureFailure?: boolean;
      };
    }>;
    const bash = completed.filter((event) => event.tool?.name === 'Bash');
    expect(bash.length).toBeGreaterThanOrEqual(1);
    for (const event of bash) {
      expect(event.tool?.exitCode).toBe(0);
      expect(event.tool?.errorPreview).toBeUndefined();
      expect(event.tool?.infrastructureFailure).toBeUndefined();
    }
    const messages = events
      .filter((event) => event.type === 'agent.message')
      .map((event) => (event as { message?: string }).message ?? '');
    expect(messages.some((message) => message.includes('sentry-bash-ok'))).toBe(true);
    const blob = JSON.stringify(events);
    for (const marker of ['bwrap:', "Can't mkdir", 'Permission denied', 'sandbox unavailable']) {
      expect(blob).not.toContain(marker);
    }
  }, 120_000);

  it('hides Windows mounts from Claude: nested bwrap Bash succeeds with sentry-wsl-isolation-ok', async () => {
    // TASK-0012 mount-isolation gate (WSL-only, opt-in live): the REAL
    // adapter must launch Claude through the systemd-isolated launcher
    // (mount namespace shadows /mnt/c), then real Claude inner bwrap
    // runs real Bash. Explicit namespace canary (not inferred from
    // success): `ls /mnt/c/Users` inside Claude Bash must NOT list host
    // profiles. Run from WSL with SENTRY_LIVE_CLAUDE=1 on a host that
    // still has inaccessible profiles (CodexSandboxOffline, WsiAccount)
    // for the strongest proof.
    if (process.platform !== 'linux') return;
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-live-isolation-'));
    roots.push(root);
    const { url } = await startStub([
      {
        tool: 'Bash',
        input: { command: 'ls /mnt/c/Users; printf sentry-wsl-isolation-ok' },
      },
      { text: validPlanJson() },
      { text: 'Investigation complete.' },
      { text: validEmptyReportJson() },
    ]);
    const { request, adapter } = await liveRequest(root, url);
    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(request)) events.push(event);
    await adapter.dispose();
    const terminal = events.at(-1) as { failure?: { code?: string } } | undefined;
    expect(terminal?.failure?.code ?? 'none').not.toBe('GLM_SANDBOX_UNAVAILABLE');
    expect(events.at(-1)?.type).toBe('run.completed');
    const completed = events.filter((event) => event.type === 'tool.completed') as Array<{
      tool?: {
        name?: string;
        exitCode?: number;
        errorPreview?: string;
        infrastructureFailure?: boolean;
      };
    }>;
    const bash = completed.filter((event) => event.tool?.name === 'Bash');
    expect(bash.length).toBeGreaterThanOrEqual(1);
    for (const event of bash) {
      expect(event.tool?.exitCode).toBe(0);
      expect(event.tool?.infrastructureFailure).toBeUndefined();
    }
    const messages = events
      .filter((event) => event.type === 'agent.message')
      .map((event) => (event as { message?: string }).message ?? '');
    expect(messages.some((message) => message.includes('sentry-wsl-isolation-ok'))).toBe(true);
    // Namespace canary: no host Windows profile may appear in Claude
    // Bash output. A visible /mnt/c/Users listing would name them.
    // (Scoped to Bash result text: Sentry's own
    // GLM_WINDOWS_PROFILES_HIDDEN warning legitimately names the host
    // profiles it hid.)
    const bashText = messages
      .filter((message) => message.startsWith('tool Bash result:'))
      .join('\n');
    expect(bashText).toContain('sentry-wsl-isolation-ok');
    for (const marker of [
      'CodexSandboxOffline',
      'WsiAccount',
      'bwrap:',
      "Can't mkdir",
      'Permission denied',
      'sandbox unavailable',
    ]) {
      expect(bashText).not.toContain(marker);
    }
    // Credential redaction boundary holds end to end (adapter redacts
    // the live-test token from every persisted event).
    expect(JSON.stringify(events)).not.toContain('live-test-fake-token');
  }, 120_000);

  /** Live systemd unit inventory (names only): proves owned-unit cleanup. */
  async function liveOwnedUnits(): Promise<string[]> {
    const out = await new Promise<string>((resolve) => {
      execFile(
        'systemctl',
        ['--user', 'list-units', '--type=service', '--no-legend'],
        (error, stdout) => {
          resolve(error ? '' : stdout);
        },
      );
    });
    return out
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0] ?? '')
      .filter((name) => name.startsWith('sentry-glm-'));
  }

  it('cancelling a live isolated turn stops the owned systemd unit', async () => {
    // WSL-only: needs real transient units. The stub orders a 60s
    // Bash sleep inside planning; cancel lands mid-execution, so the
    // cgroup kill (not just the client handle) is what ends the sleep.
    // Afterwards no sentry-glm-* unit may survive and dispose resolves.
    if (process.platform !== 'linux') return;
    const { probeClaudeWslMountIsolation } = await import('../src/index.js');
    const pre = await probeClaudeWslMountIsolation({ executable: CLAUDE_BIN });
    if (pre.status !== 'available') return;
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-live-cancel-'));
    roots.push(root);
    const { url } = await startStub([
      { tool: 'Bash', input: { command: 'sleep 60' } },
      { text: validPlanJson() },
      { text: 'Investigation complete.' },
      { text: validEmptyReportJson() },
    ]);
    const { request, adapter } = await liveRequest(root, url);
    const seen: HarnessEvent[] = [];
    const run = (async () => {
      for await (const event of adapter.run(request)) seen.push(event);
    })();
    // Wait until the sleep is actually executing inside Claude, then cancel.
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (
        seen.some(
          (e) =>
            e.type === 'tool.started' && (e as { tool?: { name?: string } }).tool?.name === 'Bash',
        )
      )
        break;
    }
    expect(
      seen.some((e) => e.type === 'tool.started'),
      'Bash sleep started before cancel',
    ).toBe(true);
    await adapter.cancel(request.agentRunId);
    await run.catch(() => undefined);
    await adapter.dispose().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 3_000));
    expect(await liveOwnedUnits()).toEqual([]);
  }, 180_000);

  it('loop breaker stops the live isolated unit on repeated failures', async () => {
    // Ten identical failing Reads trip GLM_TOOL_LOOP mid-turn; the
    // owned unit must die with the abort (no lingering provider work).
    if (process.platform !== 'linux') return;
    const { probeClaudeWslMountIsolation } = await import('../src/index.js');
    const pre = await probeClaudeWslMountIsolation({ executable: CLAUDE_BIN });
    if (pre.status !== 'available') return;
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-live-loop-'));
    roots.push(root);
    const steps: PlanStep[] = [];
    for (let i = 0; i < 10; i += 1) {
      steps.push({ tool: 'Read', input: { file_path: '/nonexistent-sentry-loop-probe' } });
    }
    steps.push({ text: validPlanJson() });
    steps.push({ text: 'Investigation complete.' });
    steps.push({ text: validEmptyReportJson() });
    const { url } = await startStub(steps);
    const { request, adapter } = await liveRequest(root, url);
    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(request)) events.push(event);
    await adapter.dispose().catch(() => undefined);
    expect(events.at(-1)).toMatchObject({ type: 'run.failed' });
    expect(JSON.stringify(events.at(-1))).toContain('GLM_TOOL_LOOP');
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await liveOwnedUnits()).toEqual([]);
  }, 180_000);

  it('init timeout terminates the live isolated unit with no orphans', async () => {
    // A silent executable never emits the stream-json init event:
    // GLM_INIT_TIMEOUT must fire AND the owned unit must die (a bare
    // client-handle kill would orphan the transient service).
    if (process.platform !== 'linux') return;
    const { probeClaudeWslMountIsolation } = await import('../src/index.js');
    const pre = await probeClaudeWslMountIsolation({ executable: CLAUDE_BIN });
    if (pre.status !== 'available') return;
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-live-init-'));
    roots.push(root);
    const fixture = join(root, 'silent.sh');
    // Answers --version instantly (version self-probe + isolation binary
    // canary stay fast) but otherwise runs silent forever: the turn never
    // emits a stream-json init event, so GLM_INIT_TIMEOUT must fire.
    await writeFile(
      fixture,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9-test"; else sleep 60; fi\n',
      {
        mode: 0o755,
      },
    );
    const { request } = await liveRequest(root, 'http://127.0.0.1:1');
    const { ClaudeCodeHarnessAdapter: Adapter } = await import('../src/index.js');
    const adapter = new Adapter({
      executable: fixture,
      modelId: 'glm-5.3-flash',
      environment: {
        PATH: process.env['PATH'],
        HOME: process.env['HOME'],
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
        ANTHROPIC_AUTH_TOKEN: 'live-test-fake-token',
        SENTRY_GLM_MODEL: 'glm-5.3-flash',
      },
      initializeTimeoutMs: 3_000,
      turnTimeoutMs: 90_000,
    });
    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(request)) events.push(event);
    await adapter.dispose().catch(() => undefined);
    expect(events.at(-1)).toMatchObject({ type: 'run.failed' });
    expect(JSON.stringify(events.at(-1))).toContain('GLM_INIT_TIMEOUT');
    await new Promise((r) => setTimeout(r, 3_000));
    expect(await liveOwnedUnits()).toEqual([]);
  }, 120_000);

  it('planning completes without a permission-denial sweep', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-live-plan-'));
    roots.push(root);
    const { url } = await startStub([
      { text: validPlanJson() },
      { text: 'Investigation complete.' },
      { text: validEmptyReportJson() },
    ]);
    const { request, adapter } = await liveRequest(root, url);
    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(request)) events.push(event);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    // No cold-start permission abort and no loop abort on a clean script.
    expect(
      events.some(
        (event) =>
          (event as { failure?: { code?: string } }).failure?.code ===
            'GLM_TOOL_PERMISSION_UNAVAILABLE' ||
          (event as { failure?: { code?: string } }).failure?.code === 'GLM_TOOL_LOOP',
      ),
    ).toBe(false);
  }, 120_000);
});
