import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { IncrementalHarnessEventValidator } from '@qa/harness-protocol';
import { HarnessRunRequestSchema, type HarnessEvent } from '@qa/schemas';
import {
  createAgentRunId,
  createProjectContextSnapshotId,
  createQARunId,
  createSnapshotId,
} from '@qa/shared';
import {
  extractToolCalls,
  OpenCodeHarnessAdapter,
  parseRunOutput,
  type OpenCodeClientFactory,
  type OpenCodePromptResult,
} from '../src/index.js';

const SENTINEL_VALUE = 'sentry-test-sentinel-credential';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function testEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin', OPENROUTER_API_KEY: SENTINEL_VALUE, ...extra };
}

async function request(root: string) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'README.md'), '# Fixture\nimportant line\n');
  return HarnessRunRequestSchema.parse({
    schemaVersion: 1,
    agentRunId: createAgentRunId(),
    qaRunId: createQARunId(),
    agentStackId: 'stack_opencode_main',
    projectContextSnapshotId: createProjectContextSnapshotId(),
    workspace: {
      runtimePath: root,
      snapshotId: createSnapshotId(),
      writable: true,
      isolated: true,
    },
    model: { provider: 'openrouter', modelId: 'anthropic/claude-test' },
    task: { type: 'qa', prompt: 'Inspect the fixture.', policyId: 'qa-standard', policyVersion: 1 },
    executionSafeguards: { runTimeoutMs: 30_000 },
  });
}

async function collect(
  adapter: OpenCodeHarnessAdapter,
  input: Awaited<ReturnType<typeof request>>,
): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of adapter.run(input)) events.push(event);
  return events;
}

function validReportV2() {
  return {
    schemaVersion: 2,
    summary: 'One evidence-backed issue.',
    checks: [{ name: 'Inspect README', status: 'passed' }],
    hypotheses: [
      {
        title: 'Boundary risk',
        rationale: 'The fixture is minimal.',
        relatedPaths: ['README.md'],
        plannedChecks: ['Inspect README'],
      },
    ],
    evidence: [
      {
        key: 'readme',
        type: 'code_reference',
        strength: 'strong_code_evidence',
        description: 'Relevant line.',
        relativePath: 'README.md',
        lineStart: 2,
        lineEnd: 2,
      },
    ],
    findings: [
      {
        title: 'Fixture issue',
        category: 'documentation',
        severity: 'low',
        confidence: 'strong',
        description: 'A deterministic fixture finding.',
        locations: [{ relativePath: 'README.md', lineStart: 2 }],
        evidenceKeys: ['readme'],
        reproductionSteps: ['Open README.md'],
      },
    ],
    limitations: [],
  };
}

function validPlan() {
  return JSON.stringify({
    schemaVersion: 1,
    projectUnderstanding: 'Small fixture',
    criticalFlows: ['Read path'],
    weakPoints: ['Boundary'],
    plannedChecks: ['Inspect README'],
  });
}

function scriptedFactory(script: OpenCodePromptResult[]): OpenCodeClientFactory {
  let calls = 0;
  return async () => ({
    startSession: async () => ({
      runPrompt: async () => {
        const next = script[Math.min(calls, script.length - 1)];
        calls += 1;
        if (next === undefined) throw new Error('Script exhausted');
        return next;
      },
      abort: () => undefined,
    }),
    close: async () => undefined,
  });
}

const textTurn = (text: string): OpenCodePromptResult => ({ text, toolCalls: [], envelopes: 1 });

function validateProtocol(
  events: HarnessEvent[],
  input: Awaited<ReturnType<typeof request>>,
): void {
  const validator = new IncrementalHarnessEventValidator(input.qaRunId, input.agentRunId);
  for (const event of events) validator.accept(event);
  validator.finish();
}

describe('OpenCodeHarnessAdapter', () => {
  it('exposes opencode metadata and openrouter provider identity', async () => {
    const adapter = new OpenCodeHarnessAdapter({
      executable: 'opencode-test',
      modelId: 'anthropic/claude-test',
      environment: testEnv(),
      clientFactory: scriptedFactory([]),
    });
    const metadata = await adapter.getMetadata();
    expect(metadata.adapterId).toBe('opencode');
    expect(metadata.protocolVersion).toBe(1);
    expect(metadata.supportedModelPatterns).toEqual(['anthropic/claude-test']);
    expect(metadata.capabilities.cancellation).toBe(true);
    await adapter.dispose();
  });

  it('fails closed without an OpenRouter credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-nokey-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new OpenCodeHarnessAdapter({
      executable: 'opencode-test',
      modelId: 'anthropic/claude-test',
      environment: { PATH: '/usr/bin' },
      clientFactory: scriptedFactory([]),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'OPENCODE_CREDENTIAL_MISSING' },
    });
    await adapter.dispose();
  });

  it('runs planning, investigation, and reporting to a terminal success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-success-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new OpenCodeHarnessAdapter({
      executable: 'opencode-test',
      modelId: 'anthropic/claude-test',
      environment: testEnv(),
      clientFactory: scriptedFactory([
        textTurn(validPlan()),
        {
          text: 'Investigation complete.',
          toolCalls: [
            { name: 'read', arguments: { path: 'README.md' }, output: 'ok' },
            {
              name: 'bash',
              arguments: { command: 'rg important README.md' },
              output: 'important line',
              exitCode: 0,
            },
          ],
          envelopes: 3,
        },
        textTurn(JSON.stringify(validReportV2())),
      ]),
    });
    const events = await collect(adapter, input);
    validateProtocol(events, input);
    const types = events.map((event) => event.type);
    expect(types[0]).toBe('run.started');
    expect(types).toContain('investigation.plan.created');
    expect(types.filter((type) => type === 'tool.started')).toHaveLength(2);
    expect(types.filter((type) => type === 'tool.completed')).toHaveLength(2);
    // Explicit exit codes are observed; absent codes stay absent (never 0).
    expect(types.filter((type) => type === 'command.executed')).toHaveLength(1);
    expect(types.filter((type) => type === 'finding.submitted')).toHaveLength(1);
    expect(types.filter((type) => type === 'run.completed')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('run.completed');
    // No open operations remain at terminalization (validator asserts this).
    // The sentinel credential never leaks into events.
    expect(JSON.stringify(events)).not.toContain(SENTINEL_VALUE);
    // The ephemeral auth boundary is removed when the run settles.
    const boundaryDir = join(
      dirname(root),
      '.sentry-opencode-auth-' + input.agentRunId.replace(/[^A-Za-z0-9_-]/g, '_'),
    );
    await expect(stat(boundaryDir)).rejects.toThrow();
    await adapter.dispose();
  });

  it('retries planning once after a malformed plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-planretry-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new OpenCodeHarnessAdapter({
      executable: 'opencode-test',
      modelId: 'anthropic/claude-test',
      environment: testEnv(),
      clientFactory: scriptedFactory([
        textTurn('not json at all'),
        textTurn(validPlan()),
        textTurn('Investigation complete.'),
        textTurn(JSON.stringify(validReportV2())),
      ]),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events.some((event) => event.type === 'warning')).toBe(true);
    await adapter.dispose();
  });

  it('fails the run on an invalid report without weakening validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-badreport-'));
    roots.push(root);
    const input = await request(root);
    const bad = { ...validReportV2(), findings: [{ title: 'Missing everything' }] };
    const adapter = new OpenCodeHarnessAdapter({
      executable: 'opencode-test',
      modelId: 'anthropic/claude-test',
      environment: testEnv(),
      clientFactory: scriptedFactory([
        textTurn(validPlan()),
        textTurn('Investigation complete.'),
        textTurn(JSON.stringify(bad)),
      ]),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'OPENCODE_INVALID_RESULT' },
    });
    await adapter.dispose();
  });

  it('rejects evidence outside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-badpath-'));
    roots.push(root);
    const input = await request(root);
    const report = validReportV2();
    const firstEvidence = report.evidence[0];
    if (firstEvidence === undefined) throw new Error('Fixture evidence missing');
    report.evidence[0] = { ...firstEvidence, relativePath: '../escape.txt' };
    const adapter = new OpenCodeHarnessAdapter({
      executable: 'opencode-test',
      modelId: 'anthropic/claude-test',
      environment: testEnv(),
      clientFactory: scriptedFactory([
        textTurn(validPlan()),
        textTurn('Investigation complete.'),
        textTurn(JSON.stringify(report)),
      ]),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)?.type).toBe('run.failed');
    await adapter.dispose();
  });

  it('refuses reporting turns that use tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-reporttools-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new OpenCodeHarnessAdapter({
      executable: 'opencode-test',
      modelId: 'anthropic/claude-test',
      environment: testEnv(),
      clientFactory: scriptedFactory([
        textTurn(validPlan()),
        textTurn('Investigation complete.'),
        {
          text: JSON.stringify(validReportV2()),
          toolCalls: [{ name: 'bash', arguments: { command: 'ls' }, output: 'x' }],
          envelopes: 2,
        },
      ]),
    });
    const events = await collect(adapter, input);
    // Report firewall trips on every attempt: the run fails, never silently
    // incorporates tool output into the report.
    expect(events.at(-1)?.type).toBe('run.failed');
    await adapter.dispose();
  });

  it('forbids subagent delegation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-subagent-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new OpenCodeHarnessAdapter({
      executable: 'opencode-test',
      modelId: 'anthropic/claude-test',
      environment: testEnv(),
      clientFactory: scriptedFactory([
        textTurn(validPlan()),
        {
          text: 'Investigation complete.',
          toolCalls: [{ name: 'spawn_subagent', arguments: {}, output: 'no' }],
          envelopes: 2,
        },
        textTurn(JSON.stringify(validReportV2())),
      ]),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'OPENCODE_SUBAGENT_FORBIDDEN' },
    });
    await adapter.dispose();
  });

  it('redacts the credential from failure diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-redact-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new OpenCodeHarnessAdapter({
      executable: 'opencode-test',
      modelId: 'anthropic/claude-test',
      environment: testEnv(),
      clientFactory: async () => ({
        startSession: async () => ({
          runPrompt: async () => {
            throw new Error('boom ' + SENTINEL_VALUE);
          },
          abort: () => undefined,
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)?.type).toBe('run.failed');
    expect(JSON.stringify(events)).not.toContain(SENTINEL_VALUE);
    await adapter.dispose();
  });

  it('cancels only the owned session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-cancel-'));
    roots.push(root);
    const first = await request(root);
    const second = await request(root);
    const aborted: string[] = [];
    const hangingFactory: OpenCodeClientFactory = async () => ({
      startSession: async (session) => ({
        runPrompt: async (_prompt, options) => {
          await new Promise<void>((resolve) => {
            options.signal?.addEventListener('abort', () => {
              aborted.push(session.sessionId);
              resolve();
            });
          });
          throw new Error('cancelled-mid-turn');
        },
        abort: () => undefined,
      }),
      close: async () => undefined,
    });
    const adapter = new OpenCodeHarnessAdapter({
      executable: 'opencode-test',
      modelId: 'anthropic/claude-test',
      environment: testEnv(),
      clientFactory: hangingFactory,
    });
    const pending = collect(adapter, first);
    // Let the first run register its session, then cancel exactly it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await adapter.cancel(first.agentRunId);
    const firstEvents = await pending;
    expect(firstEvents.at(-1)?.type).toBe('run.failed');
    expect(aborted).toEqual([first.agentRunId]);
    expect(aborted).not.toContain(second.agentRunId);
    await adapter.dispose();
  });

  it('bounds runaway turns with the watchdog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-timeout-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new OpenCodeHarnessAdapter({
      executable: 'opencode-test',
      modelId: 'anthropic/claude-test',
      environment: testEnv(),
      turnTimeoutMs: 50,
      clientFactory: async () => ({
        startSession: async () => ({
          runPrompt: async () => new Promise<never>(() => undefined),
          abort: () => undefined,
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'OPENCODE_START_FAILED' },
    });
    await adapter.dispose();
  });
});

describe('parseRunOutput', () => {
  it('ignores unknown envelopes and never invents tool completions', () => {
    const result = parseRunOutput(
      [
        JSON.stringify({ type: 'thinking', content: 'private reasoning must not persist' }),
        JSON.stringify({ type: 'message', text: 'hello' }),
        'not json',
      ].join('\n'),
    );
    expect(result.toolCalls).toEqual([]);
    expect(result.text).toContain('hello');
    expect(result.text).not.toContain('private reasoning');
  });

  it('maps only explicit tool-call envelopes', () => {
    const result = parseRunOutput(
      JSON.stringify({ type: 'tool_call', name: 'bash', input: { command: 'ls' } }),
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(extractToolCalls({ type: 'message', text: 'x' })).toEqual([]);
  });

  it('falls back to raw text when nothing parses', () => {
    const result = parseRunOutput('plain terminal prose');
    expect(result.text).toBe('plain terminal prose');
    expect(result.toolCalls).toEqual([]);
  });
});
