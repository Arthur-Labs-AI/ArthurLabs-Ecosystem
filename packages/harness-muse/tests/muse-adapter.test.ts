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
                      confidence: 'confirmed',
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
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'usage.updated',
        usage: expect.objectContaining({ inputTokens: 10, outputTokens: 4, turns: 2 }),
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
});
