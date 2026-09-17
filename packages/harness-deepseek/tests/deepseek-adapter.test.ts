import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestTimeoutError } from '@deepseek-ai/dsh-sdk-client';
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
  deepSeekReadinessFromChecks,
  DeepSeekHarnessError,
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

/** Investigation turn: tool events plus terminal prose (never final JSON). */
function investigationResult(events: unknown[] = []) {
  return executionResult('Investigation complete.', events);
}

/** Reporting turn: exactly one ReportV2 JSON document. */
function reportResult(report: unknown) {
  return executionResult(JSON.stringify(report));
}

/** Three-stage dispatch: plan, then investigation, then report. */
function threeStage(
  plan: DeepSeekRunResult,
  investigation: DeepSeekRunResult,
  report: DeepSeekRunResult,
) {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) return plan;
    if (calls === 2) return investigation;
    return report;
  };
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

describe('DeepSeekHarnessAdapter', () => {
  it('marks runtime verified only after explicit startup succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-runtime-verified-'));
    roots.push(root);
    const input = await request(root);
    const readiness = () =>
      deepSeekReadinessFromChecks({ modelOk: true, binaryOk: true }).runtimeVerified;
    expect(readiness()).toBe(false);

    const failed = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => ({
        start: async () => {
          expect(readiness()).toBe(false);
          throw new DeepSeekHarnessError('DEEPSEEK_AUTH_FAILED', 'Authentication failed.');
        },
        startSession: async () => ({ runText: async () => planResult(validPlan()) }),
        close: async () => undefined,
      }),
    });
    expect((await collect(failed, input)).at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'DEEPSEEK_AUTH_FAILED' },
    });
    await failed.dispose();
    expect(readiness()).toBe(false);

    let sessions = 0;
    const successful = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => ({
        start: async () => {
          expect(readiness()).toBe(false);
        },
        startSession: async () => {
          sessions += 1;
          expect(readiness()).toBe(true);
          return {
            runText: threeStage(
              planResult(validPlan()),
              investigationResult(),
              reportResult(validReportV2()),
            ),
          };
        },
        close: async () => undefined,
      }),
    });
    expect((await collect(successful, input)).at(-1)?.type).toBe('run.completed');
    await successful.dispose();
    expect(sessions).toBe(1);
    expect(readiness()).toBe(true);
  });

  it('never forwards unrelated host secrets to the DeepSeek child environment', async () => {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-env-'));
    roots.push(root);
    const input = await request(root);
    const factory: DeepSeekClientFactory = async (spawnInput) => {
      seen.push(spawnInput.environment);
      return {
        start: async () => undefined,
        startSession: async () => ({
          runText: threeStage(
            planResult(validPlan()),
            investigationResult(),
            reportResult(validReportV2()),
          ),
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
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => ({
        start: async () => undefined,
        startSession: async () => ({
          runText: threeStage(
            planResult(validPlan()),
            investigationResult([
              {
                type: 'tool/call',
                seq: 1,
                time: 1,
                data: {
                  turn: 2,
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
                  turn: 2,
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
                  turn: 2,
                  step: 2,
                  message: { id: 'msg-2', role: 'assistant', content: [], source: {} },
                  stream: [],
                  usage: { inputTokens: 100, outputTokens: 50 },
                },
              },
            ]),
            reportResult({
              schemaVersion: 2,
              summary: 'Tool-backed finding.',
              checks: [],
              hypotheses: [],
              evidence: [
                {
                  key: 'cmd',
                  type: 'command',
                  strength: 'tool_diagnostic',
                  description: 'Tests ran.',
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
          ),
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
      usage: { inputTokens: 100, outputTokens: 50, turns: 3 },
    });
  });

  it('reads shell exit-status markers as observed codes (never defaults nonzero to 0)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-marker-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => ({
        start: async () => undefined,
        startSession: async () => ({
          runText: threeStage(
            planResult(validPlan()),
            // No meta.exitCode, no error field: the marker alone must
            // provide the observed code. The model citing op_1 grounds
            // with the marker-derived code instead of tripping spoofing.
            investigationResult([
              {
                type: 'tool/call',
                seq: 1,
                time: 1,
                data: {
                  turn: 2,
                  step: 1,
                  callId: 'call-1',
                  name: 'pwsh',
                  arguments: JSON.stringify({ command: 'pnpm test' }),
                },
              },
              {
                type: 'tool/result',
                seq: 2,
                time: 2,
                data: {
                  turn: 2,
                  step: 1,
                  message: {
                    id: 'msg-1',
                    role: 'user',
                    content: [
                      {
                        type: 'tool-result',
                        toolCallId: 'call-1',
                        content: [{ type: 'text', text: '1 failed\n[exit code: 1]' }],
                      },
                    ],
                    source: { kind: 'tool', plugin: 'shell', tool: 'pwsh' },
                  },
                },
              },
            ]),
            reportResult({
              schemaVersion: 2,
              summary: 'Tool-backed finding.',
              checks: [],
              hypotheses: [],
              evidence: [
                {
                  key: 'cmd',
                  type: 'command',
                  strength: 'tool_diagnostic',
                  description: 'Suite failed as expected.',
                  operationKey: 'op_1',
                },
              ],
              findings: [
                {
                  title: 'Suite red',
                  category: 'testing',
                  severity: 'info',
                  confidence: 'strong',
                  description: 'Observed red suite.',
                  locations: [{ relativePath: 'README.md' }],
                  evidenceKeys: ['cmd'],
                  reproductionSteps: [],
                },
              ],
              limitations: [],
            }),
          ),
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    const executed = events.filter((e) => e.type === 'command.executed');
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ command: 'pnpm test', exitCode: 1 });
  });

  it('records no code without marker, meta, or error (unknown stays unknown)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-nocode-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => ({
        start: async () => undefined,
        startSession: async () => ({
          runText: threeStage(
            planResult(validPlan()),
            // Clean output, no exit marker, no meta, no error: the op is
            // recorded WITHOUT a code (never default 0), so no
            // command.executed event fires for it.
            investigationResult([
              {
                type: 'tool/call',
                seq: 1,
                time: 1,
                data: {
                  turn: 2,
                  step: 1,
                  callId: 'call-1',
                  name: 'pwsh',
                  arguments: JSON.stringify({ command: 'pnpm test' }),
                },
              },
              {
                type: 'tool/result',
                seq: 2,
                time: 2,
                data: {
                  turn: 2,
                  step: 1,
                  message: {
                    id: 'msg-1',
                    role: 'user',
                    content: [
                      {
                        type: 'tool-result',
                        toolCallId: 'call-1',
                        content: [{ type: 'text', text: 'some output' }],
                      },
                    ],
                    source: { kind: 'tool', plugin: 'shell', tool: 'pwsh' },
                  },
                },
              },
            ]),
            reportResult({
              schemaVersion: 2,
              summary: 'Observed run.',
              checks: [],
              hypotheses: [],
              evidence: [],
              findings: [],
              limitations: [],
            }),
          ),
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events.filter((e) => e.type === 'tool.completed')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'command.executed')).toHaveLength(0);
  });

  it('builds the report prompt AFTER investigation with all observed operations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-ledger-timing-'));
    roots.push(root);
    const input = await request(root);
    const prompts: string[] = [];
    let calls = 0;
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => ({
        start: async () => undefined,
        startSession: async () => ({
          runText: async (text: string) => {
            calls += 1;
            prompts.push(text);
            if (calls === 1) return planResult(validPlan());
            if (calls === 2) {
              // Investigation turn: real tool work, plain terminal prose
              // (NOT final JSON). Creates op_1 during investigation.
              return executionResult('Investigation complete.', [
                {
                  type: 'tool/call',
                  seq: 1,
                  time: 1,
                  data: {
                    turn: 2,
                    step: 1,
                    callId: 'call-ledger',
                    name: 'shell',
                    arguments: JSON.stringify({ command: 'ledger-probe-command' }),
                  },
                },
                {
                  type: 'tool/result',
                  seq: 2,
                  time: 2,
                  data: {
                    turn: 2,
                    step: 1,
                    message: {
                      id: 'msg-ledger',
                      role: 'user',
                      content: [
                        {
                          type: 'tool-result',
                          toolCallId: 'call-ledger',
                          content: [{ type: 'text', text: 'probe ok' }],
                        },
                      ],
                      source: { kind: 'tool', plugin: 'shell', tool: 'shell' },
                    },
                    meta: { exitCode: 0 },
                  },
                },
              ]);
            }
            // Report turn: V2 command evidence citing the
            // investigation-stage op_1 (derived code 0 from meta).
            return reportResult({
              schemaVersion: 2,
              summary: 'Ledger-grounded report.',
              checks: [],
              hypotheses: [],
              evidence: [
                {
                  key: 'cmd',
                  type: 'command',
                  strength: 'tool_diagnostic',
                  description: 'Probe ran.',
                  operationKey: 'op_1',
                },
              ],
              findings: [],
              limitations: [],
            });
          },
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    // The FINAL structured-output prompt (built AFTER investigation)
    // contains the investigation-stage operation.
    expect(prompts.at(-1)).toContain('ledger-probe-command');
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
      const adapter = new DeepSeekHarnessAdapter({
        executable: 'dsh-test',
        modelId: 'deepseek-v4-flash',
        environment: {},
        clientFactory: async () => ({
          start: async () => undefined,
          startSession: async () => ({
            // Hostile signals surface during investigation (tools live
            // there now); the run still fails closed.
            runText: threeStage(
              planResult(validPlan()),
              investigationResult(hostile),
              reportResult(validReportV2()),
            ),
          }),
          close: async () => undefined,
        }),
      });
      const events = await collect(adapter, input);
      await adapter.dispose();
      expect(events.at(-1)).toMatchObject({ type: 'run.failed' });
    }
  });

  it('ignores sandbox policy discussion in assistant text (no false fail-closed)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-sandbox-words-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => ({
        start: async () => undefined,
        startSession: async () => ({
          runText: threeStage(
            planResult(validPlan()),
            // Model text echoing sandbox policy wording (as our own
            // prompts contain "sandbox" + "disabled"): must not trip
            // the denial detector, which is tool-event scoped.
            investigationResult([
              {
                type: 'assistant/message',
                seq: 1,
                time: 1,
                data: {
                  turn: 1,
                  step: 1,
                  message: {
                    id: 'msg-1',
                    role: 'assistant',
                    content: [
                      {
                        type: 'text',
                        text: 'I will work inside the sandbox and never retry with sandbox disabled.',
                      },
                    ],
                    source: {},
                  },
                  stream: [],
                },
              },
            ]),
            reportResult(validReportV2()),
          ),
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
  });

  it('does not treat tool calls as sandbox denials (live bug: two identical production refusals)', async () => {
    // Production evidence (runs run_01M2RAF700V1XZNGRZWG0PWQ4G and
    // run_01M2RB0RTFPD9W59VKB8PRDK2E, native /usr/bin/dsh): the denial
    // detector tripped with zero mapped tool events persisted, i.e. on a
    // `tool/call` request. A call is the model asking — never the runtime
    // refusing — so calls must never trip the detector.
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-call-words-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => ({
        start: async () => undefined,
        startSession: async () => ({
          runText: threeStage(
            planResult(validPlan()),
            investigationResult([
              {
                type: 'tool/call',
                seq: 1,
                time: 1,
                data: {
                  turn: 1,
                  step: 1,
                  callId: 'call-1',
                  name: 'shell',
                  arguments: 'check whether the sandbox is unavailable in this container',
                },
              },
            ]),
            reportResult(validReportV2()),
          ),
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
  });

  it('does not treat successful tool results mentioning sandboxes as denials', async () => {
    // A result WITHOUT structured error that merely discusses a sandbox
    // is observation, not refusal: it must surface as a warning, never
    // fail the run. Only error-carrying results keep fail-closed refusal.
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-result-words-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => ({
        start: async () => undefined,
        startSession: async () => ({
          runText: threeStage(
            planResult(validPlan()),
            investigationResult([
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
                    content: [
                      {
                        type: 'text',
                        text: 'note: sandbox unavailable in this container, skipped that check',
                      },
                    ],
                    source: {},
                  },
                },
              },
            ]),
            reportResult(validReportV2()),
          ),
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events.some((event) => event.type === 'warning')).toBe(true);
  });

  it('forbids tool calls during reporting without mutating the frozen ledger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-report-firewall-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => ({
        start: async () => undefined,
        startSession: async () => ({
          runText: threeStage(
            planResult(validPlan()),
            investigationResult([
              {
                type: 'tool/call',
                seq: 1,
                time: 1,
                data: {
                  turn: 2,
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
                  turn: 2,
                  step: 1,
                  message: {
                    id: 'msg-1',
                    role: 'user',
                    content: [
                      {
                        type: 'tool-result',
                        toolCallId: 'call-1',
                        content: [{ type: 'text', text: 'ok' }],
                      },
                    ],
                    source: { kind: 'tool', plugin: 'shell', tool: 'shell' },
                  },
                  meta: { exitCode: 0 },
                },
              },
            ]),
            // Report turn attempts a fresh tool call: must fail with the
            // firewall error; the investigation op must not be joined by
            // a reporting-stage operation.
            executionResult('Investigating further.', [
              {
                type: 'tool/call',
                seq: 9,
                time: 9,
                data: {
                  turn: 3,
                  step: 1,
                  callId: 'call-sneaky',
                  name: 'shell',
                  arguments: JSON.stringify({ command: 'rm -rf /tmp/x' }),
                },
              },
            ]),
          ),
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'DEEPSEEK_INVALID_RESULT' },
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'warning', code: 'DEEPSEEK_REPORT_RETRY' }),
    );
    // Exactly one investigation operation observed; the sneaky reporting
    // call never became one.
    expect(events.filter((e) => e.type === 'tool.started')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'command.executed')).toHaveLength(1);
  });

  it('repairs a rejected report without rerunning the investigation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-report-repair-'));
    roots.push(root);
    const input = await request(root);
    const prompts: string[] = [];
    let calls = 0;
    const overconfident = {
      schemaVersion: 2,
      summary: 'Overconfident report.',
      checks: [],
      hypotheses: [],
      evidence: [{ key: 'm1', type: 'manual', strength: 'agent_reasoning', description: 'Hunch.' }],
      findings: [
        {
          title: 'Claim',
          category: 'logic',
          severity: 'low',
          confidence: 'confirmed',
          description: 'Ungrounded confirmation.',
          locations: [{ relativePath: 'README.md' }],
          evidenceKeys: ['m1'],
          reproductionSteps: [],
        },
      ],
      limitations: [],
    };
    const corrected = {
      schemaVersion: 2,
      summary: 'Calibrated report.',
      checks: [],
      hypotheses: [],
      evidence: [
        {
          key: 'ref',
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
          description: 'Grounded claim.',
          locations: [{ relativePath: 'README.md', lineStart: 2 }],
          evidenceKeys: ['ref'],
          reproductionSteps: [],
        },
      ],
      limitations: [],
    };
    const toolEvents = [
      {
        type: 'tool/call',
        seq: 1,
        time: 1,
        data: {
          turn: 2,
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
          turn: 2,
          step: 1,
          message: {
            id: 'msg-1',
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-1',
                content: [{ type: 'text', text: 'ok' }],
              },
            ],
            source: { kind: 'tool', plugin: 'shell', tool: 'shell' },
          },
          meta: { exitCode: 0 },
        },
      },
    ];
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => ({
        start: async () => undefined,
        startSession: async () => ({
          runText: async (text: string) => {
            calls += 1;
            prompts.push(text);
            if (calls === 1) return planResult(validPlan());
            if (calls === 2) return investigationResult(toolEvents);
            // Attempt 1: overconfident confirmed on manual evidence.
            // Attempt 2 (correction): calibrated strong on code reference.
            return executionResult(JSON.stringify(calls === 3 ? overconfident : corrected));
          },
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    // Investigation executed once (one tool op); reporting ran twice.
    expect(events.filter((e) => e.type === 'tool.started')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'command.executed')).toHaveLength(1);
    expect(prompts).toHaveLength(4);
    // The correction prompt carries bounded validation feedback.
    expect(prompts[3]).toContain('Correct these report issues');
    expect(prompts[3]).toContain('confirmed');
    // Retry telemetry is observable.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'warning', code: 'DEEPSEEK_REPORT_RETRY' }),
    );
    const usage = events.find((e) => e.type === 'usage.updated');
    expect(usage).toMatchObject({
      type: 'usage.updated',
      usage: expect.objectContaining({ turns: 4 }),
    });
  });

  it('recovers from a prose-first plan via bounded planning correction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-planning-retry-'));
    roots.push(root);
    const input = await request(root);
    const prompts: string[] = [];
    let calls = 0;
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => ({
        start: async () => undefined,
        startSession: async () => ({
          runText: async (text: string) => {
            calls += 1;
            prompts.push(text);
            if (calls === 1) return planResult('Here is my plan: inspect first.');
            if (calls === 2) return planResult(validPlan());
            if (calls === 3) return investigationResult();
            return reportResult(validReportV2());
          },
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'warning', code: 'DEEPSEEK_PLANNING_RETRY' }),
    );
    expect(prompts[1]).toContain('Your plan was rejected');
    const usage = events.find((e) => e.type === 'usage.updated');
    expect(usage).toMatchObject({
      type: 'usage.updated',
      usage: expect.objectContaining({ turns: 4 }),
    });
  });

  it('fails closed when planning stays noncompliant after correction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-planning-fatal-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => ({
        start: async () => undefined,
        startSession: async () => ({
          runText: async () => planResult('Still just prose, never JSON.'),
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'DEEPSEEK_INVALID_RESULT' },
    });
  });

  it('states uniform confidence semantics in the report prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-calibration-'));
    roots.push(root);
    const input = await request(root);
    const prompts: string[] = [];
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => ({
        start: async () => undefined,
        startSession: async () => ({
          runText: async (text: string) => {
            prompts.push(text);
            if (prompts.length === 1) return planResult(validPlan());
            if (prompts.length === 2) return investigationResult();
            return reportResult(validReportV2());
          },
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    const report = prompts.at(-1) ?? '';
    expect(report).toContain('confirmed requires genuinely reproduced');
    expect(report).toContain('strong requires grounded source');
    expect(report).toContain('The ledger below is the ONLY authoritative source');
    expect(report).toContain('Report envelope (exact shapes');
    expect(report).toContain('"checks":[{"name"');
  });

  it('retries explicit startup once with a fresh client before planning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-init-retry-'));
    roots.push(root);
    const input = await request(root);
    const order: string[] = [];
    let factories = 0;
    let firstClosed = false;
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => {
        factories += 1;
        const clientNumber = factories;
        order.push('create:' + clientNumber);
        const runText = threeStage(
          planResult(validPlan()),
          investigationResult(),
          reportResult(validReportV2()),
        );
        return {
          start: async () => {
            order.push('start:' + clientNumber);
            if (clientNumber === 1)
              throw new Error(
                'initialize timed out after 30000ms waiting for dsh profile "sdk-minimal"',
              );
          },
          startSession: async () => ({
            runText: async (...args) => {
              order.push('turn:' + clientNumber);
              return runText(...args);
            },
          }),
          close: async () => {
            order.push('close:' + clientNumber);
            if (clientNumber === 1) firstClosed = true;
          },
        };
      },
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(factories).toBe(2);
    expect(firstClosed).toBe(true);
    expect(order.indexOf('close:1')).toBeLessThan(order.indexOf('create:2'));
    expect(order.indexOf('start:2')).toBeLessThan(order.indexOf('turn:2'));
    expect(
      events.filter((e) => e.type === 'warning' && e.code === 'DEEPSEEK_INIT_RETRY'),
    ).toHaveLength(1);
  });

  it('fails after exactly two explicit initialization timeouts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-init-fatal-'));
    roots.push(root);
    const input = await request(root);
    let factories = 0;
    let closes = 0;
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => {
        factories += 1;
        return {
          start: async () => {
            throw new Error(
              'initialize timed out after 30000ms waiting for dsh profile "sdk-minimal"',
            );
          },
          startSession: async () => ({ runText: async () => planResult(validPlan()) }),
          close: async () => {
            closes += 1;
          },
        };
      },
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'DEEPSEEK_START_FAILED' },
    });
    expect(factories).toBe(2);
    expect(closes).toBe(2);
    expect(
      events.filter((e) => e.type === 'warning' && e.code === 'DEEPSEEK_INIT_RETRY'),
    ).toHaveLength(1);
  });

  it('does not retry a non-initialization startup failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-init-auth-'));
    roots.push(root);
    const input = await request(root);
    let factories = 0;
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => {
        factories += 1;
        return {
          start: async () => {
            throw new DeepSeekHarnessError('DEEPSEEK_AUTH_FAILED', 'Authentication failed.');
          },
          startSession: async () => ({ runText: async () => planResult(validPlan()) }),
          close: async () => undefined,
        };
      },
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'DEEPSEEK_AUTH_FAILED' },
    });
    expect(factories).toBe(1);
    expect(events.some((e) => e.type === 'warning' && e.code === 'DEEPSEEK_INIT_RETRY')).toBe(
      false,
    );
  });

  it('does not retry a typed SDK timeout for another request method', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-session-timeout-'));
    roots.push(root);
    const input = await request(root);
    let factories = 0;
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => {
        factories += 1;
        return {
          start: async () => {
            throw new RequestTimeoutError('session/create timed out after 30000ms waiting for dsh');
          },
          startSession: async () => ({ runText: async () => planResult(validPlan()) }),
          close: async () => undefined,
        };
      },
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'DEEPSEEK_START_FAILED' },
    });
    expect(factories).toBe(1);
    expect(events.some((e) => e.type === 'warning' && e.code === 'DEEPSEEK_INIT_RETRY')).toBe(
      false,
    );
  });

  it('disposes the owned client exactly once across cancel and dispose', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-deepseek-cancel-'));
    roots.push(root);
    const input = await request(root);
    const close = vi.fn(async () => undefined);
    const adapter = new DeepSeekHarnessAdapter({
      executable: 'dsh-test',
      modelId: 'deepseek-v4-flash',
      environment: {},
      clientFactory: async () => ({
        start: async () => undefined,
        startSession: async () => ({
          runText: threeStage(
            planResult(validPlan()),
            investigationResult(),
            reportResult(validReportV2()),
          ),
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
