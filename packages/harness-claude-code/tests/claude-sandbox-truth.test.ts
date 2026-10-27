import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir as systemTmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { HarnessRunRequestSchema, type HarnessEvent } from '@qa/schemas';
import {
  createAgentRunId,
  createProjectContextSnapshotId,
  createQARunId,
  createSnapshotId,
} from '@qa/shared';
import { ClaudeCodeHarnessAdapter, type ClaudeStreamEvent } from '../src/index.js';

// Scripted clients test tool outcomes independently of the host kernel.
// Explicit mount-isolation override cases below still exercise fail-closed behavior.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, release: () => '6.12.0-fixture' };
});
// Each suite owns its parent: production's sibling ephemeral HOME must
// never collide with a concurrent fixture from another test file.
const suiteRoot = mkdtempSync(join(systemTmpdir(), 'sentry-claude-suite-'));
const tmpdir = () => suiteRoot;
afterAll(() => rm(suiteRoot, { recursive: true, force: true }));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  hermeticRoot = undefined;
});

/** Hermetic Windows-profile root for the sandbox preflight (empty dir
 * never blocks; keeps truthfulness tests deterministic on WSL hosts
 * with traverse-only Windows profiles). */
let hermeticRoot: string | undefined;
function hermeticUsersRoot(): string {
  if (hermeticRoot === undefined) {
    hermeticRoot = mkdtempSync(join(tmpdir(), 'sentry-hermetic-users-'));
    roots.push(hermeticRoot);
  }
  return hermeticRoot;
}

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

function validReportV2() {
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

function bashUse(id: string, command: string) {
  return evt('assistant', {
    message: {
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
    },
  });
}

function bashResult(id: string, content: unknown, isError?: boolean) {
  return evt('user', {
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          ...(isError === undefined ? {} : { is_error: isError }),
          content,
        },
      ],
    },
  });
}

function terminalTurn() {
  return [
    evt('assistant', {
      message: { content: [{ type: 'text', text: 'Investigation complete.' }] },
    }),
    evt('result', { is_error: false, subagent_stats: { spawned: 0 } }),
  ];
}

type CompletedTool = {
  tool?: {
    name?: string;
    exitCode?: number;
    errorPreview?: string;
    infrastructureFailure?: boolean;
  };
};

function completedOf(events: HarnessEvent[]): CompletedTool[] {
  return events.filter((event) => event.type === 'tool.completed') as CompletedTool[];
}

function adapterWithTurns(turns: ClaudeStreamEvent[][]) {
  let calls = 0;
  return new ClaudeCodeHarnessAdapter({
    executable: 'claude-test',
    modelId: 'glm-5.3-flash',
    environment: {},
    windowsUsersRoot: hermeticUsersRoot(),
    clientFactory: async () => ({
      sessionId: 'session-sandbox-truth',
      startSession: async () => ({
        runText: async () => {
          calls += 1;
          return turns[Math.min(calls, turns.length) - 1] as ClaudeStreamEvent[];
        },
      }),
      close: async () => undefined,
    }),
  });
}

describe('Bash outcome truthfulness (bubblewrap bootstrap failures)', () => {
  it('keeps source-search output mentioning sandbox failures as a successful command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-source-search-'));
    roots.push(root);
    const input = await request(root);
    // The failed owner run searched the adapter itself. Its detector source
    // matched the old unanchored bootstrap regex and aborted healthy Bash.
    const output = [
      '110:   * root with controlled permissions). Production never sets this;',
      '163: * the cold-start permission abort share this contract.',
      '346:  if (/bubblewrap.*(permission denied|failed)/i.test(text)) return true;',
      '347:  if (/\\bbwrap:/i.test(text)) return true;',
      '348:  // sandbox unavailable is a bootstrap diagnostic',
    ].join('\n');
    const command = 'grep -n "permission" packages/harness-claude-code/src/adapter.ts';
    const adapter = adapterWithTurns([
      planTurn(),
      [bashUse('tu-search', command), bashResult('tu-search', output), ...terminalTurn()],
      reportTurn(validReportV2()),
    ]);
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(completedOf(events)[0]?.tool).toMatchObject({ name: 'Bash', exitCode: 0 });
    expect(completedOf(events)[0]?.tool?.infrastructureFailure).toBeUndefined();
    expect(events.filter((event) => event.type === 'command.executed')).toMatchObject([
      { command, exitCode: 0 },
    ]);
  });

  it('never records a bwrap bootstrap failure as Bash exit 0', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-bwrap-truth-'));
    roots.push(root);
    const input = await request(root);
    const investigation: ClaudeStreamEvent[] = [
      bashUse('tu-ok', 'printf sentry-bash-ok'),
      bashResult('tu-ok', 'sentry-bash-ok'),
      // Production shape: Claude Code accepts the Bash tool, bubblewrap
      // dies on a Windows-side .claude path, is_error is NOT true, yet the
      // shell command never started.
      bashUse('tu-bad', 'ls -la . && echo OK'),
      bashResult(
        'tu-bad',
        "bwrap: Can't mkdir /mnt/c/Users/CodexSandboxOffline/.claude: Permission denied",
      ),
      ...terminalTurn(),
    ];
    const adapter = adapterWithTurns([planTurn(), investigation, reportTurn(validReportV2())]);
    const events = await collect(adapter, input);
    await adapter.dispose();
    const completed = completedOf(events);
    expect(completed).toHaveLength(2);
    // The genuine success keeps exit 0 ...
    expect(completed[0]?.tool).toMatchObject({ name: 'Bash', exitCode: 0 });
    // ... but the bootstrap failure must NOT fabricate exitCode 0.
    expect(completed[1]?.tool?.exitCode).toBeUndefined();
    expect(completed[1]?.tool?.infrastructureFailure).toBe(true);
    expect(completed[1]?.tool?.errorPreview).toContain('bwrap');
    // Only the proven command becomes reproduced-success evidence.
    const executed = events.filter((event) => event.type === 'command.executed');
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ command: 'printf sentry-bash-ok', exitCode: 0 });
    // A proven bootstrap failure aborts the turn immediately.
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'GLM_SANDBOX_UNAVAILABLE' },
    });
  });

  it('keeps an explicit nonzero shell exit as a failed command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-bash-nonzero-'));
    roots.push(root);
    const input = await request(root);
    const investigation: ClaudeStreamEvent[] = [
      bashUse('tu-ok', 'printf sentry-bash-ok'),
      bashResult('tu-ok', 'sentry-bash-ok'),
      bashUse('tu-code', 'exit 3'),
      bashResult('tu-code', 'Exit code 3', true),
      ...terminalTurn(),
    ];
    const adapter = adapterWithTurns([planTurn(), investigation, reportTurn(validReportV2())]);
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    const completed = completedOf(events);
    expect(completed).toHaveLength(2);
    expect(completed[1]?.tool).toMatchObject({ name: 'Bash', exitCode: 3 });
    expect(completed[1]?.tool?.infrastructureFailure).toBeUndefined();
    const executed = events.filter((event) => event.type === 'command.executed');
    expect(executed).toHaveLength(2);
    expect(executed[1]).toMatchObject({ command: 'exit 3', exitCode: 3 });
  });

  it('aborts immediately on the first bwrap failure with GLM_SANDBOX_UNAVAILABLE', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-bwrap-abort-'));
    roots.push(root);
    const input = await request(root);
    const investigation: ClaudeStreamEvent[] = [
      bashUse('tu-first', 'ls -la . && echo OK'),
      bashResult(
        'tu-first',
        "bwrap: Can't create file at /mnt/c/Users/CodexSandboxOffline/.claude/ide: Permission denied",
        true,
      ),
      ...terminalTurn(),
    ];
    const adapter = adapterWithTurns([planTurn(), investigation, reportTurn(validReportV2())]);
    const events = await collect(adapter, input);
    await adapter.dispose();
    // Exactly one completion (the trigger) — no waiting for two more
    // unrelated failures before failing.
    expect(completedOf(events)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'run.failed',
      failure: { code: 'GLM_SANDBOX_UNAVAILABLE' },
    });
  });

  it('treats an ordinary Read error as a normal tool failure, not infra failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-read-ordinary-'));
    roots.push(root);
    const input = await request(root);
    const investigation: ClaudeStreamEvent[] = [
      evt('assistant', {
        message: {
          content: [{ type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: 'x' } }],
        },
      }),
      evt('user', {
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-read',
              is_error: true,
              content: 'File does not exist: README.md',
            },
          ],
        },
      }),
      ...terminalTurn(),
    ];
    const adapter = adapterWithTurns([planTurn(), investigation, reportTurn(validReportV2())]);
    const events = await collect(adapter, input);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    const completed = completedOf(events);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.tool?.exitCode).toBeUndefined();
    expect(completed[0]?.tool?.infrastructureFailure).toBeUndefined();
    expect(completed[0]?.tool?.errorPreview).toContain('File does not exist');
  });
});
