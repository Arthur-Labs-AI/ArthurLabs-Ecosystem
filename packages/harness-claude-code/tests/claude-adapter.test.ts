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
