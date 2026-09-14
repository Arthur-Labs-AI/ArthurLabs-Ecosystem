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
  buildClaudeChildEnvironment,
  buildClaudeSettings,
  CLAUDE_ALLOWED_SECRET_ENV_NAMES,
  ClaudeCodeHarnessAdapter,
  parseStreamJsonLine,
  type ClaudeClientFactory,
  type ClaudeStreamEvent,
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

async function collect(
  adapter: ClaudeCodeHarnessAdapter,
  input: Awaited<ReturnType<typeof request>>,
) {
  const events: HarnessEvent[] = [];
  for await (const event of adapter.run(input)) events.push(event);
  return events;
}

function evt(type: string, raw: Record<string, unknown>): ClaudeStreamEvent {
  return { type, raw };
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

function planTurn() {
  return [
    evt('system', { subtype: 'init', session_id: 's', tools: ['Bash', 'Read'], model: 'm' }),
    evt('assistant', {
      message: { content: [{ type: 'text', text: validPlan() }] },
    }),
    evt('result', { is_error: false, usage: { input_tokens: 10, output_tokens: 5 } }),
  ];
}

function executionTurnWithEvidence(evidence: unknown[]) {
  return [
    evt('assistant', {
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu-1',
            name: 'Bash',
            input: { command: 'pnpm test' },
          },
        ],
      },
    }),
    evt('user', {
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-1',
            content: [{ type: 'text', text: '12 passed' }],
          },
        ],
      },
    }),
    evt('assistant', {
      message: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              schemaVersion: 1,
              summary: 'Tool-backed finding.',
              checks: [],
              hypotheses: [],
              evidence,
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
          },
        ],
      },
    }),
    evt('result', {
      is_error: false,
      usage: { input_tokens: 100, output_tokens: 50 },
      subagent_stats: { spawned: 0 },
    }),
  ];
}

function executionTurn(extra: ClaudeStreamEvent[] = []) {
  return [
    evt('assistant', {
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu-1',
            name: 'Bash',
            input: { command: 'pnpm test' },
          },
        ],
      },
    }),
    evt('user', {
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-1',
            content: [{ type: 'text', text: '12 passed' }],
          },
        ],
      },
    }),
    ...extra,
    evt('assistant', {
      message: { content: [{ type: 'text', text: validExecution() }] },
    }),
    evt('result', {
      is_error: false,
      usage: { input_tokens: 100, output_tokens: 50 },
      subagent_stats: { spawned: 0 },
    }),
  ];
}

describe('ClaudeCodeHarnessAdapter', () => {
  it('builds the report prompt AFTER investigation with all observed operations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-ledger-timing-'));
    roots.push(root);
    const input = await request(root);
    const prompts: string[] = [];
    let calls = 0;
    const reportJson = JSON.stringify({
      schemaVersion: 1,
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
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-1',
        startSession: async () => ({
          runText: async (text: string) => {
            calls += 1;
            prompts.push(text);
            if (calls === 1) return planTurn();
            if (calls === 2) {
              // Investigation turn: real tool work, terminal prose (NOT
              // final JSON). Creates op_1 during investigation.
              return [
                evt('assistant', {
                  message: {
                    content: [
                      {
                        type: 'tool_use',
                        id: 'tu-ledger',
                        name: 'Bash',
                        input: { command: 'ledger-probe-command' },
                      },
                    ],
                  },
                }),
                evt('user', {
                  message: {
                    content: [
                      {
                        type: 'tool_result',
                        tool_use_id: 'tu-ledger',
                        content: [{ type: 'text', text: 'probe ok' }],
                      },
                    ],
                  },
                }),
                evt('assistant', {
                  message: { content: [{ type: 'text', text: 'Investigation complete.' }] },
                }),
                evt('result', { is_error: false, subagent_stats: { spawned: 0 } }),
              ];
            }
            return [
              evt('assistant', {
                message: { content: [{ type: 'text', text: reportJson }] },
              }),
              evt('result', { is_error: false, subagent_stats: { spawned: 0 } }),
            ];
          },
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    // The FINAL structured-output prompt must contain the
    // investigation-stage operation. Today's two-turn architecture builds
    // it before investigation, so this fails.
    expect(prompts.at(-1)).toContain('ledger-probe-command');
  });

  it('parses stream-json structurally and skips non-JSON diagnostics', () => {
    expect(parseStreamJsonLine('{"type":"assistant"}')?.type).toBe('assistant');
    expect(parseStreamJsonLine('')).toBeUndefined();
    expect(parseStreamJsonLine('[claude-code:unrecognized_model] {"a":1}')).toBeUndefined();
    expect(parseStreamJsonLine('not json')).toBeUndefined();
    expect(parseStreamJsonLine('[1,2]')).toBeUndefined();
  });

  it('writes fail-closed sandbox settings', () => {
    expect(buildClaudeSettings()).toMatchObject({
      sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false },
      disableBypassPermissionsMode: 'disable',
    });
  });

  it('never forwards unrelated host secrets to the Claude child environment', async () => {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-env-'));
    roots.push(root);
    const input = await request(root);
    let calls = 0;
    const factory: ClaudeClientFactory = async (spec) => {
      seen.push(spec.environment);
      return {
        sessionId: 'session-1',
        startSession: async () => ({
          runText: async () => {
            calls += 1;
            return calls === 1 ? planTurn() : executionTurn();
          },
        }),
        close: async () => undefined,
      };
    };
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {
        PATH: '/usr/bin:/bin',
        HOME: '/home/qa',
        UNRELATED_SECRET: 'do-not-leak',
        GITHUB_TOKEN: 'do-not-leak',
        ANTHROPIC_API_KEY: 'do-not-leak',
        SENTRY_GLM_MODEL: 'glm-5.3-flash',
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
    expect(child['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(child['PATH']).toBeDefined();
    expect(child['SENTRY_GLM_MODEL']).toBe('glm-5.3-flash');
    const usage = events.find((e) => e.type === 'usage.updated');
    expect(usage).toMatchObject({
      usage: { inputTokens: 110, outputTokens: 55, turns: 2 },
    });
  });

  it('allows only the documented parent credential and blocks other secrets', () => {
    expect(CLAUDE_ALLOWED_SECRET_ENV_NAMES).toEqual(['ANTHROPIC_AUTH_TOKEN']);
    const child = buildClaudeChildEnvironment({
      source: {
        PATH: '/usr/bin',
        ANTHROPIC_AUTH_TOKEN: 'host-credential',
        ANTHROPIC_API_KEY: 'do-not-leak',
        ZAI_API_KEY: 'do-not-leak',
      },
    });
    expect(child.environment['ANTHROPIC_AUTH_TOKEN']).toBe('host-credential');
    expect(child.environment['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(child.environment['ZAI_API_KEY']).toBeUndefined();
  });

  it('maps tool_use/result pairs to operations and grounds evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-tools-'));
    roots.push(root);
    const input = await request(root);
    let calls = 0;
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-1',
        startSession: async () => ({
          runText: async () => {
            calls += 1;
            return calls === 1 ? planTurn() : executionTurn();
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
    // Ephemeral config home destroyed after extraction.
    const { access } = await import('node:fs/promises');
    await expect(access(join(root, '..', '.sentry-claude-home'))).rejects.toThrow();
  });

  it('numbers operations monotonically across turns and grounds the ledger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-ledger-'));
    roots.push(root);
    const input = await request(root);
    const prompts: string[] = [];
    const planningWithRead = () => [
      evt('assistant', {
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-read',
              name: 'Read',
              input: { file_path: 'README.md' },
            },
          ],
        },
      }),
      evt('user', {
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-read',
              content: [{ type: 'text', text: '# Fixture' }],
            },
          ],
        },
      }),
      ...planTurn().filter((e) => e.type !== 'system' || (e.raw['subtype'] as string) === 'init'),
    ];
    let calls = 0;
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-1',
        startSession: async () => ({
          runText: async (text: string) => {
            calls += 1;
            prompts.push(text);
            if (calls === 1) return planningWithRead();
            // Execution references op_2 (its own Bash op), NOT a restarted op_1.
            return executionTurnWithEvidence([
              {
                key: 'cmd',
                type: 'command',
                strength: 'tool_diagnostic',
                description: 'Tests ran.',
                command: 'pnpm test',
                exitCode: 0,
                operationKey: 'op_2',
              },
            ]);
          },
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    // The execution prompt carried the authoritative ledger with the
    // planning Read as op_1; the execution Bash then minted op_2
    // (monotonic counter shared across turns — never restarted).
    // Evidence citing op_2 grounds against that execution operation.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('op_1: Read');
    expect(prompts[1]).not.toContain('op_2:');
    expect(prompts[1]).toContain('NEVER restart numbering at op_1');
    const executed = events.filter((e) => e.type === 'command.executed');
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ command: 'pnpm test', exitCode: 0 });
    // Fabricated keys still fail closed.
    const root2 = await mkdtemp(join(tmpdir(), 'sentry-claude-ledger-bad-'));
    roots.push(root2);
    const input2 = await request(root2);
    let calls2 = 0;
    const bad = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-1',
        startSession: async () => ({
          runText: async () => {
            calls2 += 1;
            if (calls2 === 1) return planTurn();
            return executionTurnWithEvidence([
              {
                key: 'cmd',
                type: 'command',
                strength: 'tool_diagnostic',
                description: 'Tests ran.',
                command: 'pnpm test',
                exitCode: 0,
                operationKey: 'op_99',
              },
            ]);
          },
        }),
        close: async () => undefined,
      }),
    });
    expect((await collect(bad, input2)).at(-1)).toMatchObject({ type: 'run.failed' });
    await bad.dispose();
  });

  it('refuses forbidden tools at init and subagent use mid-turn', async () => {
    for (const hostile of [
      [evt('system', { subtype: 'init', tools: ['Bash', 'Agent'] })],
      [
        evt('assistant', {
          message: { content: [{ type: 'tool_use', id: 'tu-x', name: 'Task', input: {} }] },
        }),
      ],
      [evt('result', { is_error: false, subagent_stats: { spawned: 1 } })],
    ]) {
      const root = await mkdtemp(join(tmpdir(), 'sentry-claude-hostile-'));
      roots.push(root);
      const input = await request(root);
      let calls = 0;
      const adapter = new ClaudeCodeHarnessAdapter({
        executable: 'claude-test',
        modelId: 'glm-5.3-flash',
        environment: {},
        clientFactory: async () => ({
          sessionId: 'session-1',
          startSession: async () => ({
            runText: async () => {
              calls += 1;
              if (calls === 1) return planTurn();
              return [...hostile, ...executionTurn()];
            },
          }),
          close: async () => undefined,
        }),
      });
      const events = await collect(adapter, input);
      await adapter.dispose();
      expect(events.at(-1)).toMatchObject({ type: 'run.failed' });
      expect(JSON.stringify(events.at(-1))).toMatch(/GLM_SUBAGENT_FORBIDDEN/);
    }
  });

  it('maps authentication failures to GLM_AUTH_FAILED', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-auth-'));
    roots.push(root);
    const input = await request(root);
    let calls = 0;
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-1',
        startSession: async () => ({
          runText: async () => {
            calls += 1;
            if (calls === 1) return planTurn();
            return [
              evt('result', {
                is_error: true,
                result: 'Not logged in · Please run /login',
              }),
            ];
          },
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)).toMatchObject({ type: 'run.failed' });
    expect(JSON.stringify(events.at(-1))).toMatch(/GLM_AUTH_FAILED/);
  });

  it('disposes the owned client exactly once across cancel and dispose', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-cancel-'));
    roots.push(root);
    const input = await request(root);
    const close = vi.fn(async () => undefined);
    let calls = 0;
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-1',
        startSession: async () => ({
          runText: async () => {
            calls += 1;
            return calls === 1 ? planTurn() : executionTurn();
          },
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
