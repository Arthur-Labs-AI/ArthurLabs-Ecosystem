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
  aggregateTurnUsage,
  buildMuseChildEnvironment,
  MuseHarnessAdapter,
  MUSE_APPROVAL_MODE,
  MUSE_HOST_ARGUMENTS,
  type MuseFoldedItem,
  type MuseTurnOutcome,
  redactDiagnostic,
  redactStructured,
  type MuseClientFactory,
  type MuseTurnView,
} from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function completed(
  usage = { inputTokens: 10, outputTokens: 4, cachedTokens: 2, reasoningTokens: 0 },
): MuseTurnOutcome {
  return {
    kind: 'completed',
    observedStart: true,
    params: {
      sessionId: 'session',
      turnId: 'turn',
      terminal: 'completed',
      sourceRange: { from: 1, to: 1 },
      viewCursor: 'cursor',
      usage,
    },
  } as MuseTurnOutcome;
}

function turn(items: readonly unknown[], outcome: TurnOutcome = completed()): MuseTurnView {
  return {
    items: async function* () {
      for (const item of items) yield item as MuseFoldedItem;
    },
    completed: Promise.resolve(outcome),
  };
}

async function request(root: string) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'README.md'), '# Fixture\nimportant line\n');
  return HarnessRunRequestSchema.parse({
    schemaVersion: 1,
    agentRunId: createAgentRunId(),
    qaRunId: createQARunId(),
    agentStackId: 'stack_muse_main',
    projectContextSnapshotId: createProjectContextSnapshotId(),
    workspace: {
      runtimePath: root,
      snapshotId: createSnapshotId(),
      writable: true,
      isolated: true,
    },
    model: { provider: 'meta', modelId: 'muse-spark-1.3-contributor' },
    task: { type: 'qa', prompt: 'Inspect the fixture.', policyId: 'qa-standard', policyVersion: 1 },
    executionSafeguards: { runTimeoutMs: 30_000 },
  });
}

async function collect(adapter: MuseHarnessAdapter, input: Awaited<ReturnType<typeof request>>) {
  const events: HarnessEvent[] = [];
  for await (const event of adapter.run(input)) events.push(event);
  return events;
}

describe('MuseHarnessAdapter', () => {
  it('uses one session for plan and execution, maps tool events, owns ids, and drops reasoning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-muse-'));
    roots.push(root);
    const input = await request(root);
    const prompts: string[] = [];
    let turnIndex = 0;
    const close = vi.fn(async () => undefined);
    const factory: MuseClientFactory = async () => ({
      serverVersion: '1.3.7',
      startSession: async ({ workspaceRoot, modelId }) => {
        expect(workspaceRoot).toBe(root);
        expect(modelId).toBe('muse-spark-1.3-contributor');
        return {
          sendText: async (text) => {
            prompts.push(text);
            turnIndex += 1;
            if (turnIndex === 1) {
              return turn([
                {
                  itemId: 'plan-message',
                  revision: 1,
                  kind: 'agentMessage',
                  status: 'completed',
                  turnId: 'plan',
                  text: JSON.stringify({
                    schemaVersion: 1,
                    projectUnderstanding: 'Small fixture',
                    criticalFlows: ['Read path'],
                    weakPoints: ['Boundary'],
                    plannedChecks: ['Inspect README'],
                  }),
                },
              ]);
            }
            return turn([
              {
                itemId: 'reasoning',
                revision: 1,
                kind: 'reasoning',
                status: 'completed',
                turnId: 'run',
                text: 'hidden chain of thought',
              },
              {
                itemId: 'future-item',
                revision: 1,
                kind: 'futureUnknownItem',
                status: 'completed',
                turnId: 'run',
              },
              {
                itemId: 'tool-1',
                revision: 1,
                kind: 'toolCall',
                status: 'inProgress',
                turnId: 'run',
                tool: 'read_file',
                args: '{"path":"README.md"}',
              },
              {
                itemId: 'tool-1',
                revision: 2,
                kind: 'toolCall',
                status: 'completed',
                turnId: 'run',
                tool: 'read_file',
                args: '{"path":"README.md"}',
                durationMs: 3,
              },
              {
                itemId: 'shell-1',
                revision: 1,
                kind: 'userShell',
                status: 'inProgress',
                turnId: 'run',
                commandText: 'pnpm test',
              },
              {
                itemId: 'shell-1',
                revision: 2,
                kind: 'userShell',
                status: 'completed',
                turnId: 'run',
                commandText: 'pnpm test',
                exitCode: 0,
                durationMs: 12,
              },
              {
                itemId: 'result-message',
                revision: 1,
                kind: 'agentMessage',
                status: 'completed',
                turnId: 'run',
                text: JSON.stringify({
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
                    {
                      key: 'tests',
                      type: 'command',
                      strength: 'tool_diagnostic',
                      description: 'The test command completed successfully.',
                      command: 'pnpm test',
                      exitCode: 0,
                    },
                  ],
                  findings: [
                    {
                      title: 'Fixture issue',
                      category: 'documentation',
                      severity: 'low',
                      // Source-verified code reference grounds strong, not
                      // confirmed (confirmed needs reproduced/operation proof).
                      confidence: 'strong',
                      description: 'A deterministic fixture finding.',
                      locations: [{ relativePath: 'README.md', lineStart: 2 }],
                      evidenceKeys: ['readme'],
                      reproductionSteps: ['Open README.md'],
                    },
                  ],
                  limitations: [],
                }),
              },
            ]);
          },
        };
      },
      close,
    });
    const adapter = new MuseHarnessAdapter({
      executable: 'muse-test',
      modelId: 'muse-spark-1.3-contributor',
      clientFactory: factory,
      environment: {},
    });
    const events = await collect(adapter, input);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Frozen plan');
    expect(events.findIndex((event) => event.type === 'investigation.plan.created')).toBeLessThan(
      events.findIndex((event) => event.type === 'finding.submitted'),
    );
    expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'command.executed')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('hidden chain of thought');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'agent.message', message: 'One evidence-backed issue.' }),
    );
    // Both turns report identical usage in this fixture, so the aggregate
    // doubles the single-turn fixture values (per-turn semantics, summed).
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'usage.updated',
        usage: expect.objectContaining({ inputTokens: 20, outputTokens: 8, turns: 2 }),
      }),
    );
    const evidence = events.find((event) => event.type === 'evidence.submitted');
    expect(evidence?.type === 'evidence.submitted' && evidence.evidence.id).toMatch(/^ev_/);
    expect(
      evidence?.type === 'evidence.submitted' &&
        evidence.evidence.type === 'code_reference' &&
        evidence.evidence.codeReference.contentHash,
    ).toMatch(/^sha256:[a-f0-9]{64}$/);
    const finding = events.find((event) => event.type === 'finding.submitted');
    expect(finding?.type === 'finding.submitted' && finding.finding.evidenceIds[0]).toBe(
      evidence?.type === 'evidence.submitted' ? evidence.evidence.id : undefined,
    );
    expect(events.at(-1)?.type).toBe('run.completed');
    await adapter.cancel(input.agentRunId);
    await adapter.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('uses the documented noninteractive mode without sandbox-disable host flags', () => {
    expect(MUSE_HOST_ARGUMENTS).toEqual(['serve']);
    expect(MUSE_HOST_ARGUMENTS).not.toContain('--yolo');
    expect(MUSE_HOST_ARGUMENTS).not.toContain('--disable-sandbox');
    expect(MUSE_APPROVAL_MODE).toBe('allowAll');
  });

  it.each([
    ['authentication', 'authentication credentials unavailable', 'MUSE_AUTH_FAILED'],
    ['sandbox', 'sandbox enforcement unavailable', 'MUSE_SANDBOX_UNAVAILABLE'],
    ['transport', undefined, 'MUSE_INVALID_RESULT'],
  ])('classifies %s turn failure', async (_name, message, expectedCode) => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-muse-failure-'));
    roots.push(root);
    const input = await request(root);
    const outcome =
      message === undefined
        ? ({ kind: 'terminalUnknown' } as MuseTurnOutcome)
        : ({
            kind: 'completed',
            observedStart: true,
            params: {
              terminal: 'failed',
              error: { kind: 'runtimeError', message },
            },
          } as MuseTurnOutcome);
    const adapter = new MuseHarnessAdapter({
      executable: 'muse-test',
      modelId: 'model',
      environment: {},
      clientFactory: async () => ({
        startSession: async () => ({ sendText: async () => turn([], outcome) }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    expect(events.at(-1)).toMatchObject({ type: 'run.failed', failure: { code: expectedCode } });
    await adapter.dispose();
  });

  it('maps SDK startup exceptions and malformed plans to stable failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-muse-start-'));
    roots.push(root);
    const input = await request(root);
    const startup = new MuseHarnessAdapter({
      executable: 'muse-test',
      modelId: 'model',
      environment: {},
      clientFactory: async () => {
        throw new Error('transport refused');
      },
    });
    expect((await collect(startup, input)).at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'MUSE_START_FAILED' },
    });

    const malformed = new MuseHarnessAdapter({
      executable: 'muse-test',
      modelId: 'model',
      environment: {},
      clientFactory: async () => ({
        startSession: async () => ({
          sendText: async () =>
            turn([
              {
                itemId: 'bad-plan',
                revision: 1,
                kind: 'agentMessage',
                status: 'completed',
                text: '{not-json}',
              },
            ]),
        }),
        close: async () => undefined,
      }),
    });
    expect((await collect(malformed, input)).at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'MUSE_INVALID_RESULT' },
    });
    await malformed.dispose();
  });

  it('fails closed on traversal, malformed structured output, and subagent fanout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-muse-invalid-'));
    roots.push(root);
    const input = await request(root);
    const plan = turn([
      {
        itemId: 'p',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          projectUnderstanding: 'x',
          criticalFlows: [],
          weakPoints: [],
          plannedChecks: ['x'],
        }),
      },
    ]);
    for (const execution of [
      turn([
        { itemId: 'r', revision: 1, kind: 'agentMessage', status: 'completed', text: '{not-json}' },
      ]),
      turn([{ itemId: 's', revision: 1, kind: 'subagent', status: 'completed' }]),
      turn([
        {
          itemId: 't',
          revision: 1,
          kind: 'agentMessage',
          status: 'completed',
          text: JSON.stringify({
            schemaVersion: 1,
            summary: 'invalid path',
            checks: [],
            hypotheses: [],
            evidence: [
              {
                key: 'escape',
                type: 'code_reference',
                strength: 'strong_code_evidence',
                description: 'escape',
                relativePath: '../outside.txt',
              },
            ],
            findings: [],
            limitations: [],
          }),
        },
      ]),
    ]) {
      let index = 0;
      const adapter = new MuseHarnessAdapter({
        executable: 'muse-test',
        modelId: 'model',
        environment: {},
        clientFactory: async () => ({
          startSession: async () => ({ sendText: async () => (++index === 1 ? plan : execution) }),
          close: async () => undefined,
        }),
      });
      const events = await collect(adapter, input);
      const failed = events.at(-1);
      expect(failed?.type).toBe('run.failed');
      expect(failed?.type === 'run.failed' && failed.failure.code).toMatch(
        /^MUSE_(INVALID_RESULT|SUBAGENT_FORBIDDEN)$/,
      );
    }
  });

  it('redacts configured and inline secrets from diagnostics', () => {
    expect(
      redactDiagnostic('Authorization: Bearer topsecret and api_key=topsecret', ['topsecret']),
    ).toBe('Authorization: Bearer [REDACTED] and api_key=[REDACTED]');
    expect(redactStructured({ summary: 'token=topsecret' }, ['topsecret'])).toEqual({
      summary: 'token=[REDACTED]',
    });
  });

  it('never forwards unrelated host secrets to the Muse child environment', async () => {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    const root = await mkdtemp(join(tmpdir(), 'sentry-muse-env-'));
    roots.push(root);
    const input = await request(root);
    const factory: MuseClientFactory = async (spawnInput) => {
      seen.push(spawnInput.environment);
      return {
        startSession: async () => ({
          sendText: async () =>
            turn([
              {
                itemId: 'p',
                revision: 1,
                kind: 'agentMessage',
                status: 'completed',
                text: JSON.stringify({
                  schemaVersion: 1,
                  projectUnderstanding: 'x',
                  criticalFlows: [],
                  weakPoints: [],
                  plannedChecks: ['x'],
                }),
              },
            ]),
        }),
        close: async () => undefined,
      };
    };
    const adapter = new MuseHarnessAdapter({
      executable: 'muse-test',
      modelId: 'model',
      environment: {
        PATH: '/usr/bin:/bin',
        HOME: '/home/qa',
        LANG: 'en_US.UTF-8',
        UNRELATED_SECRET: 'do-not-leak',
        GITHUB_TOKEN: 'do-not-leak',
        OPENAI_API_KEY: 'do-not-leak',
        DATABASE_URL: 'do-not-leak',
        Path: '/windows-merge',
        SENTRY_MUSE_MODEL: 'model',
      },
      clientFactory: factory,
    });
    await collect(adapter, input);
    await adapter.dispose();
    expect(seen).toHaveLength(1);
    const child = seen[0] as Record<string, string>;
    expect(child['UNRELATED_SECRET']).toBeUndefined();
    expect(child['GITHUB_TOKEN']).toBeUndefined();
    expect(child['OPENAI_API_KEY']).toBeUndefined();
    expect(child['DATABASE_URL']).toBeUndefined();
    expect(child['PATH']).toBeDefined();
    expect(child['HOME']).toBeDefined();
    expect(child['LANG']).toBeDefined();
    expect(child['SENTRY_MUSE_MODEL']).toBe('model');
    expect(Object.keys(child)).not.toContain('UNRELATED_SECRET');
  });

  it('sanitizes Windows-like and Linux-like environments case-insensitively', () => {
    const windowsLike = buildMuseChildEnvironment({
      source: {
        Path: 'C:\\Windows\\System32',
        SYSTEMROOT: 'C:\\Windows',
        temp: 'C:\\Temp',
        Github_Token: 'do-not-leak',
        Aws_Secret_Access_Key: 'do-not-leak',
      },
      platform: 'win32',
    });
    expect(windowsLike.environment['Github_Token']).toBeUndefined();
    expect(windowsLike.environment['Aws_Secret_Access_Key']).toBeUndefined();
    expect(windowsLike.blockedNames).toContain('Github_Token');
    expect(Object.keys(windowsLike.environment).length).toBeGreaterThan(0);
    const linuxLike = buildMuseChildEnvironment({
      source: { PATH: '/usr/bin', HOME: '/root', NEON_DATABASE_URL: 'do-not-leak' },
      platform: 'linux',
    });
    expect(linuxLike.environment['NEON_DATABASE_URL']).toBeUndefined();
    expect(linuxLike.environment['PATH']).toBe('/usr/bin');
    expect(linuxLike.environment['HOME']).toBe('/root');
  });

  it('aggregates planning + execution usage without double counting', () => {
    const planning = completed({
      inputTokens: 10,
      outputTokens: 4,
      cachedTokens: 2,
      reasoningTokens: 0,
    });
    const execution = completed({
      inputTokens: 7,
      outputTokens: 3,
      cachedTokens: 5,
      reasoningTokens: 0,
    });
    expect(aggregateTurnUsage([{ outcome: planning }, { outcome: execution }])).toEqual({
      inputTokens: 17,
      outputTokens: 7,
      cachedInputTokens: 7,
      turns: 2,
    });
    const noUsage = {
      kind: 'completed',
      observedStart: true,
      params: { terminal: 'completed' },
    } as MuseTurnOutcome;
    expect(aggregateTurnUsage([{ outcome: planning }, { outcome: noUsage }])).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: 2,
      turns: 2,
    });
    const withDuration = {
      kind: 'completed',
      observedStart: true,
      params: { terminal: 'completed', durationMs: 12 },
    } as MuseTurnOutcome;
    expect(aggregateTurnUsage([{ outcome: withDuration }])).toEqual({ turns: 1, durationMs: 12 });
    expect(
      aggregateTurnUsage([{ outcome: { kind: 'terminalUnknown' } as MuseTurnOutcome }]),
    ).toBeUndefined();
    expect(aggregateTurnUsage([])).toBeUndefined();
  });

  it('reports aggregated planning + execution usage on real runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-muse-usage-'));
    roots.push(root);
    const input = await request(root);
    let index = 0;
    const plan = (usage: unknown) =>
      turn(
        [
          {
            itemId: 'p',
            revision: 1,
            kind: 'agentMessage',
            status: 'completed',
            text: JSON.stringify({
              schemaVersion: 1,
              projectUnderstanding: 'x',
              criticalFlows: [],
              weakPoints: [],
              plannedChecks: ['x'],
            }),
          },
        ],
        usage as MuseTurnOutcome,
      );
    const adapter = new MuseHarnessAdapter({
      executable: 'muse-test',
      modelId: 'muse-spark-1.3-contributor',
      environment: {},
      clientFactory: async () => ({
        startSession: async () => ({
          sendText: async () => {
            index += 1;
            if (index === 1)
              return plan(
                completed({
                  inputTokens: 10,
                  outputTokens: 4,
                  cachedTokens: 2,
                  reasoningTokens: 0,
                }),
              );
            return turn(
              [
                {
                  itemId: 'r',
                  revision: 1,
                  kind: 'agentMessage',
                  status: 'completed',
                  text: JSON.stringify({
                    schemaVersion: 1,
                    summary: 'usage check',
                    checks: [],
                    hypotheses: [],
                    evidence: [],
                    findings: [],
                    limitations: [],
                  }),
                },
              ],
              completed({ inputTokens: 7, outputTokens: 3, cachedTokens: 5, reasoningTokens: 0 }),
            );
          },
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'usage.updated',
        usage: expect.objectContaining({ inputTokens: 17, outputTokens: 7, turns: 2 }),
      }),
    );
  });

  it('rejects production findings with no evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-muse-noev-'));
    roots.push(root);
    const input = await request(root);
    const plan = turn([
      {
        itemId: 'p',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          projectUnderstanding: 'x',
          criticalFlows: [],
          weakPoints: [],
          plannedChecks: ['x'],
        }),
      },
    ]);
    const execution = turn([
      {
        itemId: 'r',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          summary: 'no evidence',
          checks: [],
          hypotheses: [],
          evidence: [],
          findings: [
            {
              title: 'Orphan',
              category: 'logic',
              severity: 'low',
              confidence: 'probable',
              description: 'no backing evidence',
              locations: [{ relativePath: 'README.md' }],
              evidenceKeys: [],
              reproductionSteps: [],
            },
          ],
          limitations: [],
        }),
      },
    ]);
    let index = 0;
    const adapter = new MuseHarnessAdapter({
      executable: 'muse-test',
      modelId: 'model',
      environment: {},
      clientFactory: async () => ({
        startSession: async () => ({ sendText: async () => (++index === 1 ? plan : execution) }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'MUSE_INVALID_RESULT' },
    });
  });

  it('rejects confirmed findings backed only by manual reasoning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-muse-manual-'));
    roots.push(root);
    const input = await request(root);
    const plan = turn([
      {
        itemId: 'p',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          projectUnderstanding: 'x',
          criticalFlows: [],
          weakPoints: [],
          plannedChecks: ['x'],
        }),
      },
    ]);
    const execution = turn([
      {
        itemId: 'r',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          summary: 'manual only',
          checks: [],
          hypotheses: [],
          evidence: [
            { key: 'm1', type: 'manual', strength: 'agent_reasoning', description: 'I think so' },
          ],
          findings: [
            {
              title: 'Claim',
              category: 'logic',
              severity: 'low',
              confidence: 'confirmed',
              description: 'ungrounded confirmation',
              locations: [{ relativePath: 'README.md' }],
              evidenceKeys: ['m1'],
              reproductionSteps: [],
            },
          ],
          limitations: [],
        }),
      },
    ]);
    let index = 0;
    const adapter = new MuseHarnessAdapter({
      executable: 'muse-test',
      modelId: 'model',
      environment: {},
      clientFactory: async () => ({
        startSession: async () => ({ sendText: async () => (++index === 1 ? plan : execution) }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'MUSE_INVALID_RESULT' },
    });
  });

  it('rejects reproduced test evidence without a correlated operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-muse-spoof-'));
    roots.push(root);
    const input = await request(root);
    const plan = turn([
      {
        itemId: 'p',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          projectUnderstanding: 'x',
          criticalFlows: [],
          weakPoints: [],
          plannedChecks: ['x'],
        }),
      },
    ]);
    const execution = turn([
      {
        itemId: 'r',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          summary: 'spoofed test',
          checks: [],
          hypotheses: [],
          evidence: [
            {
              key: 't1',
              type: 'test',
              strength: 'reproduced_failure',
              description: 'claimed failure',
              framework: 'vitest',
              name: 'suite',
              status: 'failed',
            },
          ],
          findings: [
            {
              title: 'Spoofed failure',
              category: 'testing',
              severity: 'high',
              confidence: 'probable',
              description: 'model-claimed failure with no tool run',
              locations: [{ relativePath: 'README.md' }],
              evidenceKeys: ['t1'],
              reproductionSteps: [],
            },
          ],
          limitations: [],
        }),
      },
    ]);
    let index = 0;
    const adapter = new MuseHarnessAdapter({
      executable: 'muse-test',
      modelId: 'model',
      environment: {},
      clientFactory: async () => ({
        startSession: async () => ({ sendText: async () => (++index === 1 ? plan : execution) }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    // Reproduced strength with no correlated operation is an explicit
    // misrepresentation: rejected, not silently downgraded.
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'MUSE_INVALID_RESULT' },
    });
  });

  it('accepts test evidence tied to its specific observed operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-muse-testop-'));
    roots.push(root);
    const input = await request(root);
    const plan = turn([
      {
        itemId: 'p',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          projectUnderstanding: 'x',
          criticalFlows: [],
          weakPoints: [],
          plannedChecks: ['x'],
        }),
      },
    ]);
    const execution = turn([
      {
        itemId: 'shell-1',
        revision: 1,
        kind: 'userShell',
        status: 'completed',
        commandText: 'pnpm test',
        exitCode: 1,
      },
      {
        itemId: 'r',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          summary: 'correlated test',
          checks: [],
          hypotheses: [],
          evidence: [
            {
              key: 't1',
              type: 'test',
              strength: 'reproduced_failure',
              description: 'pnpm test failed',
              framework: 'vitest',
              name: 'suite',
              status: 'failed',
              operationKey: 'op_1',
            },
          ],
          findings: [
            {
              title: 'Real failure',
              category: 'testing',
              severity: 'high',
              confidence: 'confirmed',
              description: 'observed test failure',
              locations: [{ relativePath: 'README.md' }],
              evidenceKeys: ['t1'],
              reproductionSteps: [],
            },
          ],
          limitations: [],
        }),
      },
    ]);
    let index = 0;
    const adapter = new MuseHarnessAdapter({
      executable: 'muse-test',
      modelId: 'model',
      environment: {},
      clientFactory: async () => ({
        startSession: async () => ({ sendText: async () => (++index === 1 ? plan : execution) }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    const evidenceEvents = events.filter((event) => event.type === 'evidence.submitted');
    expect(evidenceEvents).toHaveLength(1);
    const only = evidenceEvents[0];
    expect(only?.type === 'evidence.submitted' && only.evidence.type).toBe('test');
    expect(only?.type === 'evidence.submitted' && only.evidence.strength).toBe(
      'reproduced_failure',
    );
  });

  it('rejects test evidence bound to an unrelated non-test operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-muse-unrelated-'));
    roots.push(root);
    const input = await request(root);
    const plan = turn([
      {
        itemId: 'p',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          projectUnderstanding: 'x',
          criticalFlows: [],
          weakPoints: [],
          plannedChecks: ['x'],
        }),
      },
    ]);
    const execution = turn([
      {
        itemId: 'shell-1',
        revision: 1,
        kind: 'userShell',
        status: 'completed',
        commandText: 'cat README.md',
        exitCode: 0,
      },
      {
        itemId: 'r',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          summary: 'unrelated grounding attempt',
          checks: [],
          hypotheses: [],
          evidence: [
            {
              key: 't1',
              type: 'test',
              strength: 'reproduced_failure',
              description: 'Database race reproduced',
              framework: 'vitest',
              name: 'race',
              status: 'failed',
              operationKey: 'op_1',
            },
          ],
          findings: [],
          limitations: [],
        }),
      },
    ]);
    let index = 0;
    const adapter = new MuseHarnessAdapter({
      executable: 'muse-test',
      modelId: 'model',
      environment: {},
      clientFactory: async () => ({
        startSession: async () => ({ sendText: async () => (++index === 1 ? plan : execution) }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'MUSE_INVALID_RESULT' },
    });
  });

  it('rejects evidence with an unknown operation correlation key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-muse-unknownop-'));
    roots.push(root);
    const input = await request(root);
    const plan = turn([
      {
        itemId: 'p',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          projectUnderstanding: 'x',
          criticalFlows: [],
          weakPoints: [],
          plannedChecks: ['x'],
        }),
      },
    ]);
    const execution = turn([
      {
        itemId: 'r',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          summary: 'unknown op',
          checks: [],
          hypotheses: [],
          evidence: [
            {
              key: 't1',
              type: 'runtime',
              strength: 'reproduced_behavior',
              description: 'claimed runtime',
              operationKey: 'op_99',
            },
          ],
          findings: [],
          limitations: [],
        }),
      },
    ]);
    let index = 0;
    const adapter = new MuseHarnessAdapter({
      executable: 'muse-test',
      modelId: 'model',
      environment: {},
      clientFactory: async () => ({
        startSession: async () => ({ sendText: async () => (++index === 1 ? plan : execution) }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'MUSE_INVALID_RESULT' },
    });
  });

  it('downgrades weak ungrounded runtime/log claims but keeps manual reasoning valid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-muse-downgrade-'));
    roots.push(root);
    const input = await request(root);
    const plan = turn([
      {
        itemId: 'p',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          projectUnderstanding: 'x',
          criticalFlows: [],
          weakPoints: [],
          plannedChecks: ['x'],
        }),
      },
    ]);
    const execution = turn([
      {
        itemId: 'shell-1',
        revision: 1,
        kind: 'userShell',
        status: 'completed',
        commandText: 'cat README.md',
        exitCode: 0,
      },
      {
        itemId: 'r',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          summary: 'mixed grounding',
          checks: [],
          hypotheses: [],
          evidence: [
            {
              key: 'rt',
              type: 'runtime',
              strength: 'tool_diagnostic',
              description: 'server started',
            },
            {
              key: 'lg',
              type: 'log',
              strength: 'agent_reasoning',
              description: 'saw something',
            },
            {
              key: 'm1',
              type: 'manual',
              strength: 'agent_reasoning',
              description: 'architectural concern',
            },
          ],
          findings: [
            {
              title: 'Suspected race',
              category: 'concurrency',
              severity: 'medium',
              confidence: 'probable',
              description: 'needs follow-up',
              locations: [{ relativePath: 'README.md' }],
              evidenceKeys: ['m1'],
              reproductionSteps: [],
            },
          ],
          limitations: [],
        }),
      },
    ]);
    let index = 0;
    const adapter = new MuseHarnessAdapter({
      executable: 'muse-test',
      modelId: 'model',
      environment: {},
      clientFactory: async () => ({
        startSession: async () => ({ sendText: async () => (++index === 1 ? plan : execution) }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    // Weak ungrounded runtime/log claims downgrade to manual/agent_reasoning
    // while the manual-backed probable finding still passes.
    expect(events.at(-1)?.type).toBe('run.completed');
    const downgraded = events.filter((event) => event.type === 'evidence.submitted');
    expect(downgraded).toHaveLength(3);
    expect(downgraded[0]?.type === 'evidence.submitted' && downgraded[0].evidence.type).toBe(
      'manual',
    );
    expect(downgraded[1]?.type === 'evidence.submitted' && downgraded[1].evidence.type).toBe(
      'manual',
    );
  });

  it('still rejects mismatched command evidence against observed exit codes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-muse-cmdspoof-'));
    roots.push(root);
    const input = await request(root);
    const plan = turn([
      {
        itemId: 'p',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          projectUnderstanding: 'x',
          criticalFlows: [],
          weakPoints: [],
          plannedChecks: ['x'],
        }),
      },
    ]);
    const execution = turn([
      {
        itemId: 'shell-1',
        revision: 1,
        kind: 'userShell',
        status: 'completed',
        commandText: 'pnpm test',
        exitCode: 0,
      },
      {
        itemId: 'r',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          summary: 'exit mismatch',
          checks: [],
          hypotheses: [],
          evidence: [
            {
              key: 'c1',
              type: 'command',
              strength: 'tool_diagnostic',
              description: 'claimed failure',
              command: 'pnpm test',
              exitCode: 1,
            },
          ],
          findings: [],
          limitations: [],
        }),
      },
    ]);
    let index = 0;
    const adapter = new MuseHarnessAdapter({
      executable: 'muse-test',
      modelId: 'model',
      environment: {},
      clientFactory: async () => ({
        startSession: async () => ({ sendText: async () => (++index === 1 ? plan : execution) }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'MUSE_INVALID_RESULT' },
    });
  });

  it('falls back to modified_workspace without a baseline sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-muse-prov-'));
    roots.push(root);
    const input = await request(root);
    await writeFile(join(root, 'generated.txt'), 'agent artifact\n');
    const plan = turn([
      {
        itemId: 'p',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          projectUnderstanding: 'x',
          criticalFlows: [],
          weakPoints: [],
          plannedChecks: ['x'],
        }),
      },
    ]);
    const execution = turn([
      {
        itemId: 'shell-1',
        revision: 1,
        kind: 'userShell',
        status: 'completed',
        commandText: 'pnpm test',
        exitCode: 0,
      },
      {
        itemId: 'r',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          summary: 'provenance',
          checks: [],
          hypotheses: [],
          evidence: [
            {
              key: 'base',
              type: 'code_reference',
              strength: 'strong_code_evidence',
              description: 'unchanged file',
              relativePath: 'README.md',
              lineStart: 1,
              lineEnd: 1,
            },
            {
              key: 'gen',
              type: 'code_reference',
              strength: 'strong_code_evidence',
              description: 'new file',
              relativePath: 'generated.txt',
              lineStart: 1,
              lineEnd: 1,
            },
          ],
          findings: [],
          limitations: [],
        }),
      },
    ]);
    let index = 0;
    const adapter = new MuseHarnessAdapter({
      executable: 'muse-test',
      modelId: 'model',
      environment: {},
      clientFactory: async () => ({
        startSession: async () => ({ sendText: async () => (++index === 1 ? plan : execution) }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    const submitted = events.filter((event) => event.type === 'evidence.submitted');
    expect(submitted).toHaveLength(2);
    // Without a baseline sidecar the adapter stays conservative: both modified.
    for (const event of submitted) {
      expect(event.type === 'evidence.submitted' && event.evidence.environmentState).toBe(
        'modified_workspace',
      );
    }
  });

  it('classifies baseline sidecar files: unchanged baseline, modified, and new', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'sentry-muse-sidecar-'));
    roots.push(scratch);
    // Mirror the production layout: <ws>/workspace/project is agent-visible,
    // <ws>/.sentry-workspace holds the coordinator-written sidecar.
    const project = join(scratch, 'workspace', 'project');
    const input = await request(project);
    // request() wrote README.md; simulate the coordinator-written sidecar.
    const { createHash } = await import('node:crypto');
    const { readFile, mkdir } = await import('node:fs/promises');
    const readmeBytes = await readFile(join(project, 'README.md'));
    const readmeHash = 'sha256:' + createHash('sha256').update(readmeBytes).digest('hex');
    await writeFile(join(project, 'modified.txt'), 'original\n');
    const modifiedOriginalHash =
      'sha256:' +
      createHash('sha256')
        .update(await readFile(join(project, 'modified.txt')))
        .digest('hex');
    await writeFile(join(project, 'modified.txt'), 'changed by agent\n');
    await writeFile(join(project, 'generated.txt'), 'agent artifact\n');
    const sidecarDir = join(scratch, 'workspace', '.sentry-workspace');
    await mkdir(sidecarDir, { recursive: true });
    await writeFile(
      join(sidecarDir, 'baseline-hashes.json'),
      JSON.stringify({
        schemaVersion: 1,
        snapshotId: input.workspace.snapshotId,
        files: { 'README.md': readmeHash, 'modified.txt': modifiedOriginalHash },
      }),
      'utf8',
    );
    const plan = turn([
      {
        itemId: 'p',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          projectUnderstanding: 'x',
          criticalFlows: [],
          weakPoints: [],
          plannedChecks: ['x'],
        }),
      },
    ]);
    const execution = turn([
      {
        itemId: 'shell-1',
        revision: 1,
        kind: 'userShell',
        status: 'completed',
        commandText: 'pnpm test',
        exitCode: 0,
      },
      {
        itemId: 'r',
        revision: 1,
        kind: 'agentMessage',
        status: 'completed',
        text: JSON.stringify({
          schemaVersion: 1,
          summary: 'provenance',
          checks: [],
          hypotheses: [],
          evidence: [
            {
              key: 'base',
              type: 'code_reference',
              strength: 'strong_code_evidence',
              description: 'unchanged file',
              relativePath: 'README.md',
              lineStart: 1,
              lineEnd: 1,
            },
            {
              key: 'mod',
              type: 'code_reference',
              strength: 'strong_code_evidence',
              description: 'modified file',
              relativePath: 'modified.txt',
              lineStart: 1,
              lineEnd: 1,
            },
            {
              key: 'gen',
              type: 'code_reference',
              strength: 'strong_code_evidence',
              description: 'new file',
              relativePath: 'generated.txt',
              lineStart: 1,
              lineEnd: 1,
            },
          ],
          findings: [],
          limitations: [],
        }),
      },
    ]);
    let index = 0;
    const adapter = new MuseHarnessAdapter({
      executable: 'muse-test',
      modelId: 'model',
      environment: {},
      clientFactory: async () => ({
        startSession: async () => ({ sendText: async () => (++index === 1 ? plan : execution) }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    const submitted = events.filter((event) => event.type === 'evidence.submitted');
    expect(submitted).toHaveLength(3);
    const stateOf = (n: number) =>
      submitted[n]?.type === 'evidence.submitted' && submitted[n].evidence.environmentState;
    expect(stateOf(0)).toBe('baseline');
    expect(stateOf(1)).toBe('modified_workspace');
    expect(stateOf(2)).toBe('modified_workspace');
  });

  it('exposes Windows shutdown diagnostics through the generic contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-muse-shutdown-'));
    roots.push(root);
    const input = await request(root);
    const close = async () => undefined;
    const adapter = new MuseHarnessAdapter({
      executable: 'muse-test',
      modelId: 'model',
      environment: {},
      clientFactory: async () => ({
        startSession: async () => ({
          sendText: async () =>
            turn([
              {
                itemId: 'p',
                revision: 1,
                kind: 'agentMessage',
                status: 'completed',
                text: JSON.stringify({
                  schemaVersion: 1,
                  projectUnderstanding: 'x',
                  criticalFlows: [],
                  weakPoints: [],
                  plannedChecks: ['x'],
                }),
              },
            ]),
        }),
        close,
      }),
    });
    // Drive run() far enough to create a real client (planning fails closed
    // on the single-turn fixture, but the client exists for dispose()).
    await collect(adapter, input);
    await adapter.dispose();
    const diagnostics = adapter.getShutdownDiagnostics();
    if (process.platform === 'win32') {
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ code: 'MUSE_SHUTDOWN_PARTIAL', severity: 'warning' });
    } else {
      expect(diagnostics).toHaveLength(0);
    }
  });
});
