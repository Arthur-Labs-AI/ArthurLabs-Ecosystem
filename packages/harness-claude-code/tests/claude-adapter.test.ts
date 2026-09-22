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

function planTurn() {
  return [
    evt('system', { subtype: 'init', session_id: 's', tools: ['Bash', 'Read'], model: 'm' }),
    evt('assistant', {
      message: { content: [{ type: 'text', text: validPlan() }] },
    }),
    evt('result', { is_error: false, usage: { input_tokens: 10, output_tokens: 5 } }),
  ];
}

/** Investigation turn: tool work plus terminal prose (never final JSON). */
function investigationTurn(extra: ClaudeStreamEvent[] = []) {
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
      message: { content: [{ type: 'text', text: 'Investigation complete.' }] },
    }),
    evt('result', {
      is_error: false,
      usage: { input_tokens: 100, output_tokens: 50 },
      subagent_stats: { spawned: 0 },
    }),
  ];
}

/** Reporting turn: exactly one ReportV2 JSON document. */
function reportTurn(reportJson: string) {
  return [
    evt('assistant', {
      message: { content: [{ type: 'text', text: reportJson }] },
    }),
    evt('result', {
      is_error: false,
      usage: { input_tokens: 10, output_tokens: 5 },
      subagent_stats: { spawned: 0 },
    }),
  ];
}

function validReportV2(
  evidence: unknown[] = [
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
) {
  return JSON.stringify({
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
    evidence,
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

/** Three-stage dispatch: plan, then investigation, then report. */
function threeStage(
  plan: ClaudeStreamEvent[],
  investigation: ClaudeStreamEvent[],
  report: ClaudeStreamEvent[],
) {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) return plan;
    if (calls === 2) return investigation;
    return report;
  };
}

describe('ClaudeCodeHarnessAdapter', () => {
  it('fails fast with GLM_TOOL_LOOP on 10 identical failing tool calls', async () => {
    // Regression for the 166x Read-on-directory loop that burned a whole
    // 30-minute run budget: the adapter aborts the phase with a clear
    // diagnostic, surfaced as a terminal run.failed event (never a throw).
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-tool-loop-'));
    roots.push(root);
    const input = await request(root);
    const turn: ClaudeStreamEvent[] = [];
    for (let i = 0; i < 10; i += 1) {
      turn.push(
        evt('assistant', {
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tu-loop-' + i,
                name: 'Read',
                input: { file_path: '/ws/project' },
              },
            ],
          },
        }),
        evt('user', {
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-loop-' + i,
                is_error: true,
                content: [{ type: 'text', text: 'Error: is a directory' }],
              },
            ],
          },
        }),
      );
    }
    turn.push(evt('result', { is_error: false, subagent_stats: { spawned: 0 } }));
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-loop',
        startSession: async () => ({ runText: async () => turn }),
        close: async () => undefined,
      }),
    });
    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(input)) events.push(event);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.failed');
    const failed = events.at(-1) as { failure?: { code?: string; message?: string } };
    expect(failed.failure?.code).toBe('GLM_TOOL_LOOP');
    expect(failed.failure?.message).toContain('10 times with identical arguments');
    // The abort flushes the turn's buffered evidence: tool completions
    // plus the correction warning survive instead of vaporizing.
    const completed = events.filter((e) => e.type === 'tool.completed');
    expect(completed.length).toBeGreaterThanOrEqual(10);
    expect(
      events.some(
        (e) => e.type === 'warning' && (e as { code?: string }).code === 'GLM_TOOL_LOOP_WARNING',
      ),
    ).toBe(true);
  });

  it('fails fast with GLM_TOOL_LOOP on 25 consecutive distinct-path failures', async () => {
    // Regression for the sweep loop (184/190 Reads failing across distinct
    // paths): signature matching never trips, so the rate breaker must.
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-sweep-loop-'));
    roots.push(root);
    const input = await request(root);
    const turn: ClaudeStreamEvent[] = [];
    for (let i = 0; i < 25; i += 1) {
      turn.push(
        evt('assistant', {
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tu-sweep-' + i,
                name: 'Read',
                input: { file_path: '/ws/project/file-' + i + '.ts' },
              },
            ],
          },
        }),
        evt('user', {
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-sweep-' + i,
                is_error: true,
                content: [{ type: 'text', text: 'Error: file not found' }],
              },
            ],
          },
        }),
      );
    }
    turn.push(evt('result', { is_error: false, subagent_stats: { spawned: 0 } }));
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-sweep',
        startSession: async () => ({ runText: async () => turn }),
        close: async () => undefined,
      }),
    });
    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(input)) events.push(event);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.failed');
    const failed = events.at(-1) as { failure?: { code?: string; message?: string } };
    expect(failed.failure?.code).toBe('GLM_TOOL_LOOP');
    expect(failed.failure?.message).toContain('Twenty-five consecutive tool calls failed');
  });

  it('aborts on trailing-window rate despite sparse successes resetting the streak', async () => {
    // Live regression (run_01M325QK0BR8H2SADF4YCJCDVA): 3 successes in
    // ~50 calls kept resetting the consecutive streak while the turn
    // thrashed at ~94% failure. The trailing window (34/40) aborts at
    // the 40th completion regardless of interleaved resets.
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-window-loop-'));
    roots.push(root);
    const input = await request(root);
    const turn: ClaudeStreamEvent[] = [];
    for (let i = 0; i < 60; i += 1) {
      const ok = i % 12 === 11;
      turn.push(
        evt('assistant', {
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tu-win-' + i,
                name: 'Read',
                input: { file_path: '/ws/project/file-' + i + '.ts' },
              },
            ],
          },
        }),
        evt('user', {
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-win-' + i,
                ...(ok ? {} : { is_error: true }),
                content: [{ type: 'text', text: ok ? 'ok' : 'Error: file not found' }],
              },
            ],
          },
        }),
      );
    }
    turn.push(evt('result', { is_error: false, subagent_stats: { spawned: 0 } }));
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-window',
        startSession: async () => ({ runText: async () => turn }),
        close: async () => undefined,
      }),
    });
    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(input)) events.push(event);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.failed');
    const failed = events.at(-1) as { failure?: { code?: string; message?: string } };
    expect(failed.failure?.code).toBe('GLM_TOOL_LOOP');
    expect(failed.failure?.message).toContain('of the last 40');
    // Aborted at the 40th completion, not after all 60.
    expect(events.filter((e) => e.type === 'tool.completed').length).toBeLessThan(60);
  });

  it('does not trip the window on a noisy-but-progressing turn', async () => {
    // Alternating fail/success (50% rate) over 45 completions must NOT
    // abort: the window needs >= 34/40 failures. Guards against
    // false-positives on legitimately difficult investigations.
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-window-noisy-'));
    roots.push(root);
    const input = await request(root);
    const turn: ClaudeStreamEvent[] = [];
    for (let i = 0; i < 45; i += 1) {
      const ok = i % 2 === 1;
      turn.push(
        evt('assistant', {
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tu-noisy-' + i,
                name: 'Read',
                input: { file_path: '/ws/project/file-' + i + '.ts' },
              },
            ],
          },
        }),
        evt('user', {
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-noisy-' + i,
                ...(ok ? {} : { is_error: true }),
                content: [{ type: 'text', text: ok ? 'ok' : 'missing' }],
              },
            ],
          },
        }),
      );
    }
    turn.push(
      evt('assistant', {
        message: { content: [{ type: 'text', text: 'Investigation complete.' }] },
      }),
      evt('result', { is_error: false, subagent_stats: { spawned: 0 } }),
    );
    let calls = 0;
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-noisy',
        startSession: async () => ({
          runText: async () => {
            calls += 1;
            if (calls === 1) return planTurn();
            if (calls === 2) return turn;
            return reportTurn(validReportV2());
          },
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
  });

  it('resets loop state between turns so one turn never dooms the next', async () => {
    // Two planning attempts with 20 distinct failures each: without a
    // per-turn reset the trailing window would accumulate 40/40 and
    // abort attempt 2; with it, attempt 2 parses its plan and the run
    // continues. (Consecutive-25 never trips: each turn has only 20.)
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-window-reset-'));
    roots.push(root);
    const input = await request(root);
    const failingPlan = (tag: string): ClaudeStreamEvent[] => {
      const events: ClaudeStreamEvent[] = [];
      for (let i = 0; i < 20; i += 1) {
        events.push(
          evt('assistant', {
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'tu-' + tag + '-' + i,
                  name: 'Read',
                  input: { file_path: '/ws/project/' + tag + '-' + i + '.ts' },
                },
              ],
            },
          }),
          evt('user', {
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tu-' + tag + '-' + i,
                  is_error: true,
                  content: [{ type: 'text', text: 'missing' }],
                },
              ],
            },
          }),
        );
      }
      return events;
    };
    const planWithFailures = (tag: string): ClaudeStreamEvent[] => [
      ...failingPlan(tag),
      evt('assistant', {
        message: { content: [{ type: 'text', text: validPlan() }] },
      }),
      evt('result', { is_error: false, subagent_stats: { spawned: 0 } }),
    ];
    let calls = 0;
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-reset',
        startSession: async () => ({
          runText: async () => {
            calls += 1;
            // Attempt 1: prose (forces a planning retry, keeps its 20
            // failures in turn state); attempt 2: 20 more failures PLUS
            // a valid plan. Only per-turn reset lets attempt 2 survive.
            if (calls === 1)
              return [
                ...failingPlan('a'),
                evt('assistant', {
                  message: { content: [{ type: 'text', text: 'prose, not JSON' }] },
                }),
                evt('result', { is_error: false, subagent_stats: { spawned: 0 } }),
              ];
            if (calls === 2) return planWithFailures('b');
            if (calls === 3) return investigationTurn();
            return reportTurn(validReportV2());
          },
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
  });

  it('builds the report prompt AFTER investigation with all observed operations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-ledger-timing-'));
    roots.push(root);
    const input = await request(root);
    const prompts: string[] = [];
    let calls = 0;
    const reportJson = JSON.stringify({
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

  it('forbids tool calls during reporting without mutating the frozen ledger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-report-firewall-'));
    roots.push(root);
    const input = await request(root);
    const sneakyReport = [
      evt('assistant', {
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-sneaky',
              name: 'Bash',
              input: { command: 'rm -rf /tmp/x' },
            },
          ],
        },
      }),
      evt('result', { is_error: false, subagent_stats: { spawned: 0 } }),
    ];
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-1',
        startSession: async () => ({
          runText: threeStage(planTurn(), investigationTurn(), sneakyReport),
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'GLM_INVALID_RESULT' },
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'warning', code: 'GLM_REPORT_RETRY' }),
    );
    // Exactly one investigation operation observed; the sneaky reporting
    // call never became one.
    expect(events.filter((e) => e.type === 'tool.started')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'command.executed')).toHaveLength(1);
  });

  it('reports strict-only and never sends --json-schema', async () => {
    // Live removal: the schema path never produced a successful report
    // and killed two runs fighting the provider validator, so report
    // turns never carry a schema — including repair attempts.
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-strict-only-'));
    roots.push(root);
    const input = await request(root);
    let calls = 0;
    const schemaOnAttempt: boolean[] = [];
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-1',
        startSession: async () => ({
          runText: async (text: string, options?: { outputSchema?: unknown }) => {
            calls += 1;
            if (calls <= 2) return calls === 1 ? planTurn() : investigationTurn();
            // Report attempt 1 (strict): unparseable prose. Attempt 2
            // (strict repair with correction): valid report.
            schemaOnAttempt.push(options?.outputSchema !== undefined);
            if (schemaOnAttempt.length === 1) {
              return [
                evt('assistant', { message: { content: [{ type: 'text', text: 'prose' }] } }),
                evt('result', { is_error: false, usage: {} }),
              ];
            }
            return reportTurn(validReportV2());
          },
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(schemaOnAttempt).toEqual([false, false]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'warning', code: 'GLM_REPORT_RETRY' }),
    );
  });

  it('requires report paths to resolve to regular files and repairs a directory reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-report-path-'));
    roots.push(root);
    await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
    const input = await request(root);
    const prompts: string[] = [];
    let calls = 0;
    const directoryEvidence = [
      {
        key: 'readme',
        type: 'code_reference',
        strength: 'strong_code_evidence',
        description: 'Invalid directory reference.',
        relativePath: 'node_modules/.bin',
      },
    ];
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
            if (calls === 2) return investigationTurn();
            if (calls === 3) return reportTurn(validReportV2(directoryEvidence));
            return reportTurn(validReportV2());
          },
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'warning', code: 'GLM_REPORT_RETRY' }),
    );
    expect(prompts[2]).toContain('existing regular file');
    expect(prompts[2]).toContain('never a directory');
    expect(prompts[3]).toContain('Referenced evidence path is not a file: node_modules/.bin');
    expect(prompts[3]).toContain('existing regular file');
  });

  it('recovers from a prose-first plan via bounded planning correction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-planning-retry-'));
    roots.push(root);
    const input = await request(root);
    const prompts: string[] = [];
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
            if (calls === 1)
              return [
                evt('assistant', {
                  message: { content: [{ type: 'text', text: 'Here is my plan: inspect first.' }] },
                }),
                evt('result', { is_error: false, subagent_stats: { spawned: 0 } }),
              ];
            if (calls === 2) return planTurn();
            if (calls === 3) return investigationTurn();
            return reportTurn(validReportV2());
          },
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'warning', code: 'GLM_PLANNING_RETRY' }),
    );
    expect(prompts[1]).toContain('Your plan was rejected');
  });

  it('fails closed when planning stays noncompliant after correction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-planning-fatal-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-1',
        startSession: async () => ({
          runText: async () => [
            evt('assistant', {
              message: { content: [{ type: 'text', text: 'Still just prose.' }] },
            }),
            evt('result', { is_error: false, subagent_stats: { spawned: 0 } }),
          ],
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'GLM_INVALID_RESULT' },
    });
  });

  it('states uniform confidence semantics in the report prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-calibration-'));
    roots.push(root);
    const input = await request(root);
    const prompts: string[] = [];
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-1',
        startSession: async () => ({
          runText: async (text: string) => {
            prompts.push(text);
            if (prompts.length === 1) return planTurn();
            if (prompts.length === 2) return investigationTurn();
            return reportTurn(validReportV2());
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
    const factory: ClaudeClientFactory = async (spec) => {
      seen.push(spec.environment);
      return {
        sessionId: 'session-1',
        startSession: async () => ({
          runText: threeStage(planTurn(), investigationTurn(), reportTurn(validReportV2())),
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
      usage: { inputTokens: 120, outputTokens: 60, turns: 3 },
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
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-1',
        startSession: async () => ({
          runText: threeStage(planTurn(), investigationTurn(), reportTurn(validReportV2())),
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
    const investigationWithBash = () => [
      evt('assistant', {
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-bash',
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
              tool_use_id: 'tu-bash',
              content: [{ type: 'text', text: '12 passed' }],
            },
          ],
        },
      }),
      evt('assistant', {
        message: { content: [{ type: 'text', text: 'Investigation complete.' }] },
      }),
      evt('result', { is_error: false, subagent_stats: { spawned: 0 } }),
    ];
    // V2 command evidence cites op_2 (the investigation Bash); Sentry
    // derives command/exit from the frozen operation.
    const reportWithOp2 = reportTurn(
      JSON.stringify({
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
            operationKey: 'op_2',
          },
        ],
        findings: [],
        limitations: [],
      }),
    );
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
            if (calls === 2) return investigationWithBash();
            return reportWithOp2;
          },
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    // The REPORT prompt (built AFTER investigation) carries the frozen
    // ledger: planning Read as op_1, investigation Bash as op_2
    // (monotonic counter shared across stages — never restarted).
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain('op_1');
    expect(prompts[2]).toContain('op_2');
    expect(prompts[2]).toContain('pnpm test');
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
            if (calls2 === 2) return investigationTurn();
            return reportTurn(
              JSON.stringify({
                schemaVersion: 2,
                summary: 'Bad report.',
                checks: [],
                hypotheses: [],
                evidence: [
                  {
                    key: 'cmd',
                    type: 'command',
                    strength: 'tool_diagnostic',
                    description: 'Tests ran.',
                    operationKey: 'op_99',
                  },
                ],
                findings: [],
                limitations: [],
              }),
            );
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
      [evt('system', { subtype: 'init', tools: ['Bash', 'TaskOutput'] })],
      [evt('system', { subtype: 'init', tools: ['Bash', 'Read', 'TaskStop'] })],
      [
        evt('assistant', {
          message: { content: [{ type: 'tool_use', id: 'tu-x', name: 'Task', input: {} }] },
        }),
      ],
      [
        evt('assistant', {
          message: {
            content: [
              { type: 'tool_use', id: 'tu-x', name: 'TaskOutput', input: { task_id: 'x' } },
            ],
          },
        }),
      ],
      [
        evt('assistant', {
          message: {
            content: [{ type: 'tool_use', id: 'tu-x', name: 'TaskStop', input: {} }],
          },
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
              if (calls === 2) return [...hostile, ...investigationTurn()];
              return reportTurn(validReportV2());
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

  it('persists failed-tool diagnostics without fabricating exit codes', async () => {
    // Definition-of-done 8+9 (run_01M326QHGF26YRV9Z314V4GCN6): a failed
    // tool must persist its bounded redacted reason; is_error:true must
    // NOT become a fabricated exitCode 1. Verified 2.1.276 shapes: Bash
    // 'Exit code 3' keeps its REAL code; Read EACCES carries errorPreview
    // with exitCode undefined. A bwrap bootstrap failure aborts the turn
    // immediately with GLM_SANDBOX_UNAVAILABLE (TASK-0012): it rides in
    // its own turn below, not in this honesty turn.
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-exit-honesty-'));
    roots.push(root);
    const input = await request(root);
    const fail = (id: string, name: string, inputValue: unknown, content: unknown) => [
      evt('assistant', {
        message: { content: [{ type: 'tool_use', id, name, input: inputValue }] },
      }),
      evt('user', {
        message: {
          content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content }],
        },
      }),
    ];
    // A leading success keeps the cold-start preflight (3 completions,
    // zero successes, a Bash failure) from firing: this test exercises
    // exit-code honesty, not the cold-start abort.
    const turn: ClaudeStreamEvent[] = [
      evt('assistant', {
        message: {
          content: [{ type: 'tool_use', id: 'tu-ok', name: 'Bash', input: { command: 'true' } }],
        },
      }),
      evt('user', {
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-ok', content: 'ok' }],
        },
      }),
      ...fail('tu-bash-code', 'Bash', { command: 'exit 3' }, 'Exit code 3'),
      ...fail(
        'tu-read-eacces',
        'Read',
        { file_path: 'locked.txt' },
        "EACCES: permission denied, open 'locked.txt'",
      ),
      // Ordinary nonzero shell failure (the shell RAN and exited 1):
      // keeps its real code, never infrastructure failure.
      ...fail('tu-bash-one', 'Bash', { command: 'false' }, 'Exit code 1'),
      evt('assistant', {
        message: { content: [{ type: 'text', text: 'Investigation complete.' }] },
      }),
      evt('result', { is_error: false, subagent_stats: { spawned: 0 } }),
    ];
    let calls = 0;
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-exit',
        startSession: async () => ({
          runText: async () => {
            calls += 1;
            if (calls === 1) return planTurn();
            if (calls === 2) return turn;
            return reportTurn(validReportV2());
          },
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    const completed = events.filter((e) => e.type === 'tool.completed') as Array<{
      tool?: { name?: string; exitCode?: number; errorPreview?: string };
    }>;
    expect(completed).toHaveLength(4);
    // Real provider-reported codes survive...
    expect(completed[1]?.tool).toMatchObject({ name: 'Bash', exitCode: 3 });
    // ...but non-code failures never fabricate one, and carry the reason.
    expect(completed[2]?.tool?.exitCode).toBeUndefined();
    expect(completed[2]?.tool?.errorPreview).toContain('EACCES');
    expect(completed[3]?.tool).toMatchObject({ name: 'Bash', exitCode: 1 });
    expect(completed[3]?.tool?.errorPreview).toContain('Exit code 1');
    // The reason is also visible as an agent.message (run-history UX).
    const messages = events
      .filter((e) => e.type === 'agent.message')
      .map((e) => (e as { message?: string }).message ?? '');
    expect(messages.some((m) => m.includes('EACCES'))).toBe(true);
  });

  it('aborts cold-start tool-layer failure with a precise code', async () => {
    // run_01M326QHGF26YRV9Z314V4GCN6: `pwd && true` itself failed — the
    // tool layer (permissions/sandbox), not the model choice. Three
    // completions, zero successes, a Bash failure among them →
    // GLM_TOOL_PERMISSION_UNAVAILABLE in seconds, not 25 calls later.
    // NOTE: sandbox/bootstrap markers (bwrap/…) now abort even earlier
    // with GLM_SANDBOX_UNAVAILABLE (TASK-0012), so this permission-shape
    // turn uses plain denial text without bootstrap markers.
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-coldstart-'));
    roots.push(root);
    const input = await request(root);
    const turn: ClaudeStreamEvent[] = [];
    const cmds = ['ls -la', 'pwd && true', 'ls -la .'];
    cmds.forEach((command, i) => {
      turn.push(
        evt('assistant', {
          message: {
            content: [{ type: 'tool_use', id: 'tu-cold-' + i, name: 'Bash', input: { command } }],
          },
        }),
        evt('user', {
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-cold-' + i,
                is_error: true,
                content: 'Exit code 1\npermission denied by tool policy',
              },
            ],
          },
        }),
      );
    });
    turn.push(evt('result', { is_error: false, subagent_stats: { spawned: 0 } }));
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-cold',
        startSession: async () => ({ runText: async () => turn }),
        close: async () => undefined,
      }),
    });
    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(input)) events.push(event);
    await adapter.dispose();
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'GLM_TOOL_PERMISSION_UNAVAILABLE' },
    });
    expect(events.filter((e) => e.type === 'tool.completed')).toHaveLength(3);
  });

  it('aborts a bwrap bootstrap failure on the first Bash call with GLM_SANDBOX_UNAVAILABLE', async () => {
    // TASK-0012 production shape: bubblewrap dies before the shell
    // starts. One proven bootstrap failure aborts immediately — no
    // waiting for two more unrelated failures.
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-coldstart-bwrap-'));
    roots.push(root);
    const input = await request(root);
    const turn: ClaudeStreamEvent[] = [
      evt('assistant', {
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-cold-bwrap',
              name: 'Bash',
              input: { command: 'pwd && true' },
            },
          ],
        },
      }),
      evt('user', {
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-cold-bwrap',
              is_error: true,
              content: 'Exit code 1\nbwrap: sandbox unavailable',
            },
          ],
        },
      }),
      evt('result', { is_error: false, subagent_stats: { spawned: 0 } }),
    ];
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-cold-bwrap',
        startSession: async () => ({ runText: async () => turn }),
        close: async () => undefined,
      }),
    });
    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(input)) events.push(event);
    await adapter.dispose();
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'GLM_SANDBOX_UNAVAILABLE' },
    });
    expect(events.filter((e) => e.type === 'tool.completed')).toHaveLength(1);
  });

  it('fails fast when the init inventory lacks required QA tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-preflight-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-preflight',
        startSession: async () => ({
          runText: async () => [
            evt('system', { subtype: 'init', tools: ['WebFetch'], model: 'm' }),
            evt('result', { is_error: false, subagent_stats: { spawned: 0 } }),
          ],
        }),
        close: async () => undefined,
      }),
    });
    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(input)) events.push(event);
    await adapter.dispose();
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'GLM_TOOL_PERMISSION_UNAVAILABLE' },
    });
  });

  it('fails closed on a live-proven incompatible version, warns on unknown drift', async () => {
    // TASK-0012 version policy: 2.1.276 is live-proven incompatible with
    // the WSL/bubblewrap sandbox → GLM_CLAUDE_VERSION_UNSUPPORTED before
    // any provider budget burns. Unknown newer versions still warn + run.
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-version-'));
    roots.push(root);
    const input = await request(root);
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      executableVersion: '2.1.276 (Claude Code)',
      clientFactory: async () => ({
        sessionId: 'session-version',
        startSession: async () => ({
          runText: threeStage(planTurn(), investigationTurn(), reportTurn(validReportV2())),
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'GLM_CLAUDE_VERSION_UNSUPPORTED' },
    });
    const drifted = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      executableVersion: '9.9.999 (Claude Code)',
      clientFactory: async () => ({
        sessionId: 'session-version-drift',
        startSession: async () => ({
          runText: threeStage(planTurn(), investigationTurn(), reportTurn(validReportV2())),
        }),
        close: async () => undefined,
      }),
    });
    const rootDrift = await mkdtemp(join(tmpdir(), 'sentry-claude-version-drift-'));
    roots.push(rootDrift);
    const driftEvents = await collect(drifted, await request(rootDrift));
    await drifted.dispose();
    expect(driftEvents.at(-1)?.type).toBe('run.completed');
    expect(driftEvents).toContainEqual(
      expect.objectContaining({ type: 'warning', code: 'GLM_CLAUDE_VERSION_UNVERIFIED' }),
    );
    const matching = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      executableVersion: '2.1.270',
      clientFactory: async () => ({
        sessionId: 'session-version-ok',
        startSession: async () => ({
          runText: threeStage(planTurn(), investigationTurn(), reportTurn(validReportV2())),
        }),
        close: async () => undefined,
      }),
    });
    const root2 = await mkdtemp(join(tmpdir(), 'sentry-claude-version-ok-'));
    roots.push(root2);
    const events2 = await collect(matching, await request(root2));
    await matching.dispose();
    expect(
      events2.some((e) => (e as { code?: string }).code === 'GLM_CLAUDE_VERSION_UNVERIFIED'),
    ).toBe(false);
  });

  it('persists tool result text for string, nested, and classic block shapes', async () => {
    // Live regression (run_01M324B2ZGD50VSA48ERJ7HM51): ZERO agent.message
    // events across 68 tool results on 2.1.276 — the extractor only
    // accepted `{type:'text', text}` blocks, so drifted wire shapes went
    // blind. Every structural text carrier below must surface.
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-result-text-'));
    roots.push(root);
    const input = await request(root);
    const shapes: Array<{ id: string; content: unknown }> = [
      { id: 'tu-classic', content: [{ type: 'text', text: 'classic out' }] },
      { id: 'tu-string', content: 'plain string out' },
      { id: 'tu-nested', content: [[{ type: 'text', text: 'nested out' }]] },
    ];
    const turn: ClaudeStreamEvent[] = [];
    for (const shape of shapes) {
      turn.push(
        evt('assistant', {
          message: {
            content: [
              { type: 'tool_use', id: shape.id, name: 'Bash', input: { command: 'echo hi' } },
            ],
          },
        }),
        evt('user', {
          message: {
            content: [{ type: 'tool_result', tool_use_id: shape.id, content: shape.content }],
          },
        }),
      );
    }
    turn.push(
      evt('assistant', {
        message: { content: [{ type: 'text', text: 'Investigation complete.' }] },
      }),
      evt('result', { is_error: false, subagent_stats: { spawned: 0 } }),
    );
    let calls = 0;
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-text',
        startSession: async () => ({
          runText: async () => {
            calls += 1;
            if (calls === 1) return planTurn();
            if (calls === 2) return turn;
            return reportTurn(validReportV2());
          },
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    const messages = events
      .filter((e) => e.type === 'agent.message')
      .map((e) => (e as { message?: string }).message ?? '');
    expect(messages.some((m) => m.includes('classic out'))).toBe(true);
    expect(messages.some((m) => m.includes('plain string out'))).toBe(true);
    expect(messages.some((m) => m.includes('nested out'))).toBe(true);
  });

  it('accepts allowed web QA tools at init without tripping the delegation check', async () => {
    // Live regression: allowing WebFetch/WebSearch in --disallowedTools
    // while the init-event check still rejected them failed the whole
    // agent with GLM_SUBAGENT_FORBIDDEN. Both layers must agree.
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-webtools-'));
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
            if (calls === 1)
              return [
                evt('system', {
                  subtype: 'init',
                  tools: ['Bash', 'Read', 'WebFetch', 'WebSearch'],
                }),
                ...planTurn().filter(
                  (e) => e.type !== 'system' || (e.raw['subtype'] as string) === 'init',
                ),
              ];
            if (calls === 2) return investigationTurn();
            return reportTurn(validReportV2());
          },
        }),
        close: async () => undefined,
      }),
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
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
            if (calls === 2) return investigationTurn();
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
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: {},
      clientFactory: async () => ({
        sessionId: 'session-1',
        startSession: async () => ({
          runText: threeStage(planTurn(), investigationTurn(), reportTurn(validReportV2())),
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

  it('creates a Sentry-owned ephemeral HOME and destroys it with the run', async () => {
    // run_01M33YXNW80W2Q7H1HK5EA5K7Q: inherited Windows HOME poisoned the
    // sandbox. The adapter must mint home/.claude + config/settings before
    // the session starts, hand them to the client, and remove the whole
    // boundary afterwards (stateless AgentRun semantics preserved).
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-home-'));
    roots.push(root);
    const input = await request(root);
    let seenHomeDir: unknown;
    let seenBoundary: unknown;
    let homeExistedDuringRun = false;
    let settingsExistedDuringRun = false;
    const { access } = await import('node:fs/promises');
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: { HOME: '/mnt/c/Users/CodexSandboxOffline' },
      clientFactory: async (spec) => {
        seenHomeDir = (spec as { homeDir?: unknown }).homeDir;
        seenBoundary = join(String((spec as { configDir?: unknown }).configDir ?? ''), '..');
        const home = String((spec as { homeDir?: unknown }).homeDir ?? '');
        try {
          await access(join(home, '.claude'));
          homeExistedDuringRun = true;
        } catch {
          homeExistedDuringRun = false;
        }
        try {
          await access(
            join(String((spec as { configDir?: unknown }).configDir ?? ''), 'sentry-settings.json'),
          );
          settingsExistedDuringRun = true;
        } catch {
          settingsExistedDuringRun = false;
        }
        return {
          sessionId: 'session-home',
          startSession: async () => ({
            runText: threeStage(planTurn(), investigationTurn(), reportTurn(validReportV2())),
          }),
          close: async () => undefined,
        };
      },
    });
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(typeof seenHomeDir).toBe('string');
    expect(String(seenHomeDir)).toContain('.sentry-claude-home');
    expect(String(seenHomeDir)).not.toContain('CodexSandboxOffline');
    expect(homeExistedDuringRun).toBe(true);
    expect(settingsExistedDuringRun).toBe(true);
    // Cleanup destroyed the whole boundary (parent of config + home).
    await expect(access(String(seenBoundary))).rejects.toThrow();
  });
});
