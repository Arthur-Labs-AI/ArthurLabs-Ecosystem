import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarnessRunRequestSchema, type HarnessEvent } from '@qa/schemas';
import {
  createAgentRunId,
  createProjectContextSnapshotId,
  createQARunId,
  createSnapshotId,
} from '@qa/shared';
import {
  buildDeepSeekChildEnvironment,
  DEEPSEEK_ALLOWED_SECRET_ENV_NAMES,
  DeepSeekHarnessAdapter,
  type DeepSeekClientFactory,
  type DeepSeekRunResult,
} from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function request(root: string) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'README.md'), '# Fixture\nimportant line\n');
  return HarnessRunRequestSchema.parse({
    schemaVersion: 1,
    agentRunId: createAgentRunId(),
    qaRunId: createQARunId(),
    agentStackId: 'stack_deepseek_main',
    projectContextSnapshotId: createProjectContextSnapshotId(),
    workspace: {
      runtimePath: root,
      snapshotId: createSnapshotId(),
      writable: true,
      isolated: true,
    },
    model: { provider: 'deepseek', modelId: 'deepseek-v4-flash' },
    task: { type: 'qa', prompt: 'Inspect the fixture.', policyId: 'qa-standard', policyVersion: 1 },
    executionSafeguards: { runTimeoutMs: 30_000 },
  });
}

async function collect(
  adapter: DeepSeekHarnessAdapter,
  input: Awaited<ReturnType<typeof request>>,
) {
  const events: HarnessEvent[] = [];
  for await (const event of adapter.run(input)) events.push(event);
  return events;
}

function planResult(text = 'plan') {
  return {
    sessionId: 'session-1',
    finalResponse: text,
    events: [],
    notifications: [],
  } satisfies DeepSeekRunResult;
}

function executionResult(finalResponse: string, events: unknown[] = []) {
  return {
    sessionId: 'session-1',
    finalResponse,
    events: events as DeepSeekRunResult['events'],
    notifications: [],
  } satisfies DeepSeekRunResult;
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

function validExecution() {
  return JSON.stringify({
    schemaVersion: 1,
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
  });
}

describe('DeepSeekHarnessAdapter', () => {
  it('never forwards unrelated host secrets to the DeepSeek child environment', async () => {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-env-'));
    roots.push(root);
    const input = await request(root);
    let calls = 0;
    const factory: DeepSeekClientFactory = async (spawnInput) => {
      seen.push(spawnInput.environment);
      return {
        startSession: async () => ({
          runText: async () => {
            calls += 1;
            return calls === 1 ? planResult(validPlan()) : executionResult(validExecution());
          },
        }),
        close: async () => undefined,
      };
    };
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {
        PATH: '/usr/bin:/bin',
        HOME: '/home/qa',
        UNRELATED_SECRET: 'do-not-leak',
        GITHUB_TOKEN: 'do-not-leak',
        AWS_SECRET_ACCESS_KEY: 'do-not-leak',
        SENTRY_DEEPSEEK_MODEL: 'deepseek-v4-flash',
      },
      clientFactory: factory,
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(seen).toHaveLength(1);
    const child = seen[0] as Record<string, string>;
    expect(child['UNRELATED_SECRET']).toBeUndefined();
    expect(child['GITHUB_TOKEN']).toBeUndefined();
    expect(child['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(child['PATH']).toBeDefined();
    expect(child['SENTRY_DEEPSEEK_MODEL']).toBe('deepseek-v4-flash');
  });

  it('allows only the documented host credential and blocks everything else secret-shaped', () => {
    expect(DEEPSEEK_ALLOWED_SECRET_ENV_NAMES).toEqual(['DEEPSEEK_API_KEY']);
    const child = buildDeepSeekChildEnvironment({
      source: {
        PATH: '/usr/bin',
        DEEPSEEK_API_KEY: 'host-credential',
        DEEPSEEK_API_SECRET: 'do-not-leak',
        OPENAI_API_KEY: 'do-not-leak',
      },
    });
    expect(child.environment['DEEPSEEK_API_KEY']).toBe('host-credential');
    expect(child.environment['DEEPSEEK_API_SECRET']).toBeUndefined();
    expect(child.environment['OPENAI_API_KEY']).toBeUndefined();
  });

  it('maps session tool events to operations and grounds command evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-tools-'));
    roots.push(root);
    const input = await request(root);
    let calls = 0;
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => ({
        startSession: async () => ({
          runText: async () => {
            calls += 1;
            if (calls === 1) return planResult(validPlan());
            return executionResult(
              JSON.stringify({
                schemaVersion: 1,
                summary: 'Tool-backed finding.',
                checks: [],
                hypotheses: [],
                evidence: [
                  {
                    key: 'cmd',
                    type: 'command',
                    strength: 'tool_diagnostic',
                    description: 'Tests ran.',
                    command: 'pnpm test',
                    exitCode: 0,
                    operationKey: 'op_1',
                  },
                ],
                findings: [
                  {
                    title: 'Suite green',
                    category: 'testing',
                    severity: 'info',
                    confidence: 'strong',
                    description: 'Observed green suite.',
                    locations: [{ relativePath: 'README.md' }],
                    evidenceKeys: ['cmd'],
                    reproductionSteps: [],
                  },
                ],
                limitations: [],
              }),
              [
                {
                  type: 'tool/call',
                  seq: 1,
                  time: 1,
                  data: {
                    turn: 1,
                    step: 1,
                    callId: 'call-1',
                    name: 'shell',
                    arguments: JSON.stringify({ command: 'pnpm test' }),
                  },
                },
                {
                  type: 'tool/result',
                  seq: 2,
                  time: 2,
                  data: {
                    turn: 1,
                    step: 1,
                    message: {
                      id: 'msg-1',
                      role: 'user',
                      content: [
                        {
                          type: 'tool-result',
                          toolCallId: 'call-1',
                          content: [{ type: 'text', text: '12 passed' }],
                        },
                      ],
                      source: { kind: 'tool', plugin: 'shell', tool: 'shell' },
                    },
                    meta: { exitCode: 0 },
                  },
                },
                {
                  type: 'assistant/message',
                  seq: 3,
                  time: 3,
                  data: {
                    turn: 1,
                    step: 2,
                    message: { id: 'msg-2', role: 'assistant', content: [], source: {} },
                    stream: [],
                    usage: { inputTokens: 100, outputTokens: 50 },
                  },
                },
                // Unknown shapes are ignored for evidence, never trusted.
                { type: 'session/future-unknown', seq: 4, time: 4, data: { anything: true } },
              ],
            );
          },
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events.filter((e) => e.type === 'tool.started')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool.completed')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'command.executed')).toHaveLength(1);
    const usage = events.find((e) => e.type === 'usage.updated');
    expect(usage).toMatchObject({
      type: 'usage.updated',
      usage: { inputTokens: 100, outputTokens: 50, turns: 2 },
    });
  });

  it('fails closed on subagent fanout and sandbox denials', async () => {
    for (const hostile of [
      [{ type: 'subagent/started', seq: 1, time: 1, data: { child: 'x' } }],
      [
        {
          type: 'tool/result',
          seq: 1,
          time: 1,
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'msg-1',
              role: 'user',
              content: [{ type: 'text', text: 'sandbox denied: workspace-write unavailable' }],
              source: {},
            },
            error: { name: 'SandboxDenied', code: 'SANDBOX_DENIED' },
          },
        },
      ],
    ]) {
      const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-hostile-'));
      roots.push(root);
      const input = await request(root);
      let calls = 0;
      const adapter = new DeepSeekHarnessAdapter({
        executable: 'dsh-test',
        modelId: 'deepseek-v4-flash',
        environment: {},
        clientFactory: async () => ({
          startSession: async () => ({
            runText: async () => {
              calls += 1;
              return calls === 1
                ? planResult(validPlan())
                : executionResult(validExecution(), hostile);
            },
          }),
          close: async () => undefined,
        }),
      });
      const events = await collect(adapter, input);
      await adapter.dispose();
      expect(events.at(-1)).toMatchObject({ type: 'run.failed' });
    }
  });

  it('disposes the owned client exactly once across cancel and dispose', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-cancel-'));
    roots.push(root);
    const input = await request(root);
    const close = vi.fn(async () => undefined);
    let calls = 0;
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => ({
        startSession: async () => ({
          runText: async () =>
            calls++ === 0 ? planResult(validPlan()) : executionResult(validExecution()),
        }),
        close,
      }),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)?.type).toBe('run.completed');
    await adapter.cancel(input.agentRunId);
    await adapter.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
