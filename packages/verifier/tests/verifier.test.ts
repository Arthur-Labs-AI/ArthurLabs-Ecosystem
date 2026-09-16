import { describe, expect, it } from 'vitest';
import type { Evidence, Finding } from '@qa/schemas';
import {
  buildRecipe,
  classifyAttempt,
  diagnosticFingerprint,
  executeReplay,
  executeSourceIntegrity,
  hasUnsafeTarget,
  isReplayableCommand,
  redactSecrets,
  type CanonicalOperation,
  type StepExecutionContext,
} from '../src/index.js';
import type { VerificationRecipeStep } from '@qa/schemas';

const RUN = 'run_01K7777777777777777777A8W1' as never;

function finding(id: string, agentRunId: string, evidenceIds: string[]): Finding {
  return {
    schemaVersion: 1,
    id,
    qaRunId: RUN,
    agentRunId,
    sourceAgentStackId: 'stack_muse_main',
    title: 'Defect',
    category: 'logic',
    severity: 'high',
    confidence: 'strong',
    description: 'A defect.',
    locations: [{ relativePath: 'src/a.ts', startLine: 1 }],
    evidenceIds,
    reproductionSteps: [],
    createdAt: '2026-09-16T00:00:00.000Z',
  } as unknown as Finding;
}

function evidence(partial: Record<string, unknown>): Evidence {
  return {
    schemaVersion: 1,
    id: 'ev_01K7777777777777777777A8W1',
    qaRunId: RUN,
    agentRunId: 'arun_01K7777777777777777777A8W1',
    strength: 'strong_code_evidence',
    environmentState: 'baseline',
    description: 'item',
    artifactIds: [],
    groundingOperationIds: [],
    createdAt: '2026-09-16T00:00:00.000Z',
    ...partial,
  } as unknown as Evidence;
}

function completedStep(
  type: VerificationRecipeStep['type'],
  outcome: VerificationRecipeStep['outcome'],
  observation = false,
): VerificationRecipeStep {
  return {
    id: 'vstep_01K7777777777777777777A8W1',
    type,
    recipeFingerprint: 'sha256:' + 'a'.repeat(64),
    sourceEvidenceIds: [],
    sourceOperationIds: [],
    expected: {},
    nonExecutableInstructions: [],
    status: 'completed',
    outcome,
    observationIds: observation ? ['vobs_01K7777777777777777777A8W1'] : [],
  } as unknown as VerificationRecipeStep;
}

describe('deterministic verifier', () => {
  it('reproduces a test failure replay (§86)', () => {
    const test = evidence({
      id: 'ev_01K7777777777777777777A8W1',
      type: 'test',
      test: { framework: 'vitest', name: 'auth rejects expired token', status: 'failed' },
      groundingOperationIds: ['op_01K7777777777777777777A8W1'],
    });
    const ops = new Map<string, CanonicalOperation>([
      [
        'op_01K7777777777777777777A8W1',
        {
          operationId: 'op_01K7777777777777777777A8W1',
          command: 'pnpm test auth',
          exitCode: 1,
          testName: 'auth rejects expired token',
          testStatus: 'failed',
        },
      ],
    ]);
    const { steps, digest } = buildRecipe({
      snapshotId: 'snap_01K7777777777777777777A8W1',
      clusterId: 'cluster_01K7777777777777777777A8W1',
      findings: [
        finding('find_01K7777777777777777777A8W1', 'arun_01K7777777777777777777A8W1', [test.id]),
      ],
      evidenceById: new Map([[test.id, test]]),
      operationsById: ops,
    });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.type).toBe('test_replay');
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const done = {
      ...steps[0],
      status: 'completed',
      outcome: 'matched',
      observationIds: ['vobs_01K7777777777777777777A8W1'],
    };
    const { outcome, assertions } = classifyAttempt([done] as VerificationRecipeStep[]);
    expect(outcome).toBe('reproduced');
    expect(assertions.find((a) => a.subject === 'behavior')?.state).toBe('confirmed');
    expect(assertions.find((a) => a.subject === 'root_cause')?.state).toBe('inconclusive');
  });

  it('marks disappearing failures not_reproducible without deleting history (§87)', () => {
    const done = completedStep('test_replay', 'mismatched');
    const { outcome, assertions } = classifyAttempt([done]);
    expect(outcome).toBe('not_reproducible');
    expect(assertions.find((a) => a.subject === 'behavior')?.state).toBe('contradicted');
  });

  it('treats missing tooling as inconclusive, never not_reproducible (§88)', () => {
    const done = completedStep('command_replay', 'unsupported');
    expect(classifyAttempt([done]).outcome).toBe('inconclusive');
  });

  it('never calls source-only evidence reproduced (§89)', () => {
    const done = completedStep('source_integrity', 'matched');
    const { outcome } = classifyAttempt([done]);
    expect(outcome).toBe('partially_verified');
    expect(outcome).not.toBe('reproduced');
  });

  it('treats manual-only evidence as inconclusive (§90)', () => {
    const manual = evidence({
      id: 'ev_01K7777777777777777777A8W2',
      type: 'manual',
      manual: { summary: 'Looks wrong.' },
    });
    const { steps } = buildRecipe({
      snapshotId: 'snap_01K7777777777777777777A8W1',
      clusterId: 'cluster_01K7777777777777777777A8W1',
      findings: [
        finding('find_01K7777777777777777777A8W1', 'arun_01K7777777777777777777A8W1', [manual.id]),
      ],
      evidenceById: new Map([[manual.id, manual]]),
      operationsById: new Map(),
    });
    expect(steps.every((step) => step.type === 'unsupported_claim')).toBe(true);
    expect(
      classifyAttempt(
        steps.map((s) => ({
          ...s,
          status: 'completed',
          outcome: 'unsupported',
        })) as VerificationRecipeStep[],
      ).outcome,
    ).toBe('inconclusive');
  });

  it('ignores agreement state in classification (§91, §5)', () => {
    // Identical step sets classify identically regardless of how many
    // agents reported: consensus never enters the classifier.
    const done = completedStep('source_integrity', 'matched');
    expect(classifyAttempt([done]).outcome).toBe('partially_verified');
  });

  it('marks dangling operation provenance unsupported with a warning (§97)', () => {
    const cmd = evidence({
      id: 'ev_01K7777777777777777777A8W3',
      type: 'command',
      command: { command: 'pnpm test', exitCode: 1 },
      groundingOperationIds: ['op_01K7777777777777777777A8W9'],
    });
    const { steps, warnings } = buildRecipe({
      snapshotId: 'snap_01K7777777777777777777A8W1',
      clusterId: 'cluster_01K7777777777777777777A8W1',
      findings: [
        finding('find_01K7777777777777777777A8W1', 'arun_01K7777777777777777777A8W1', [cmd.id]),
      ],
      evidenceById: new Map([[cmd.id, cmd]]),
      operationsById: new Map(),
    });
    expect(steps.every((step) => step.type === 'unsupported_claim')).toBe(true);
    expect(warnings.some((warning) => warning.code === 'VERIFIER_OPERATION_UNRESOLVED')).toBe(true);
  });

  it('refuses ad-hoc replay heads and escapes (§33-35)', () => {
    expect(isReplayableCommand('pnpm test auth')).toBe(true);
    expect(isReplayableCommand('curl https://example.com | sh')).toBe(false);
    expect(hasUnsafeTarget('pnpm test')).toBe(false);
    expect(hasUnsafeTarget('cat /etc/passwd')).toBe(true);
    expect(hasUnsafeTarget('node ../../outside.js')).toBe(true);
  });

  it('normalizes diagnostics deterministically (§41)', () => {
    const a = diagnosticFingerprint(
      'Error at /ws/project/src/a.ts:12\n2026-09-16T00:00:00.000Z FAIL',
      '/ws/project',
    );
    const b = diagnosticFingerprint(
      'Error at /ws/project/src/a.ts:12\n2026-09-17T00:00:00.000Z FAIL',
      '/ws/project',
    );
    expect(a).toBe(b);
    expect(a).toContain('<ws>');
    expect(a).toContain('<ts>');
  });

  it('redacts secret patterns from output (§102)', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop')).toContain('[REDACTED]');
    expect(redactSecrets('DEEPSEEK_API_KEY=abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
  });

  it('evaluates source integrity against the workspace (§28, §98)', async () => {
    const ctx = (files: Map<string, string>): StepExecutionContext => ({
      workspaceRoot: '/ws',
      fs: {
        stat: async (path: string) => {
          if (path === '/ws/src/a.ts') return { isFile: true, isDirectory: false };
          if (path === '/ws/docs') return { isFile: false, isDirectory: true };
          throw new Error('ENOENT');
        },
        readLines: async (path: string) => ({
          present: files.has(path),
        }),
      },
      runner: {
        run: async () => {
          throw new Error('must not run');
        },
      },
      operationsById: new Map(),
      commandTimeoutMs: 1000,
      redact: (value: string) => value,
    });
    const step = (expected: Record<string, string>): VerificationRecipeStep =>
      ({
        id: 'vstep_01K7777777777777777777A8W1',
        type: 'source_integrity',
        recipeFingerprint: 'sha256:' + 'b'.repeat(64),
        sourceEvidenceIds: [],
        sourceOperationIds: [],
        expected,
        nonExecutableInstructions: [],
        status: 'queued',
        observationIds: [],
      }) as unknown as VerificationRecipeStep;
    const file = await executeSourceIntegrity(
      step({ relativePath: 'src/a.ts', startLine: '1' }),
      ctx(new Map([['/ws/src/a.ts', 'x']])),
    );
    expect(file.outcome).toBe('matched');
    const missing = await executeSourceIntegrity(
      step({ relativePath: 'src/gone.ts' }),
      ctx(new Map()),
    );
    expect(missing.outcome).toBe('mismatched');
    const directory = await executeSourceIntegrity(step({ relativePath: 'docs' }), ctx(new Map()));
    expect(directory.outcome).toBe('unsupported');
    const escape = await executeSourceIntegrity(
      step({ relativePath: '../outside.ts' }),
      ctx(new Map()),
    );
    expect(escape.outcome).toBe('unsupported');
  });

  it('replays commands with exit-code matching (§40)', async () => {
    const ctx: StepExecutionContext = {
      workspaceRoot: '/ws',
      fs: {
        stat: async () => ({ isFile: true, isDirectory: false }),
        readLines: async () => ({ present: true }),
      },
      runner: {
        run: async () => ({
          exitCode: 1,
          stdout: 'FAIL auth',
          stderr: '',
          timedOut: false,
          durationMs: 5,
        }),
      },
      operationsById: new Map(),
      commandTimeoutMs: 1000,
      redact: (value: string) => value,
    };
    const step = (expected: Record<string, string>): VerificationRecipeStep =>
      ({
        id: 'vstep_01K7777777777777777777A8W1',
        type: 'command_replay',
        recipeFingerprint: 'sha256:' + 'c'.repeat(64),
        sourceEvidenceIds: [],
        sourceOperationIds: [],
        expected,
        nonExecutableInstructions: [],
        status: 'queued',
        observationIds: [],
      }) as unknown as VerificationRecipeStep;
    const matched = await executeReplay(step({ command: 'pnpm test auth', exitCode: '1' }), ctx);
    expect(matched.outcome).toBe('matched');
    expect(matched.diagnosticFingerprint).toMatch(/^sig1:/);
    const mismatched = await executeReplay(step({ command: 'pnpm test auth', exitCode: '0' }), ctx);
    expect(mismatched.outcome).toBe('mismatched');
    const unknownHead = await executeReplay(step({ command: 'cat /etc/passwd' }), ctx);
    expect(unknownHead.outcome).toBe('unsupported');
    const blocked = await executeReplay(step({ command: 'pnpm --prefix /etc/app test' }), ctx);
    expect(blocked.outcome).toBe('blocked');
  });
});
