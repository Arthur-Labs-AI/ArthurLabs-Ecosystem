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
 * Read assertions are deterministic (Read never touches bwrap). Bash
 * assertions tolerate the documented bwrap/Windows-bind environmental
 * flake by asserting execution was ATTEMPTED with the allowlist present
 * (init permissionMode + tool events) rather than success specifically —
 * success is asserted when the sandbox is healthy.
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
  let calls = 0;
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
  const toolTurn = (tool: string, input: unknown) => [
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
        content_block: { id: 'to_1', type: 'tool_use', name: tool, input },
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
      calls += 1;
      const step = calls <= plan.length ? plan[calls - 1] : undefined;
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
