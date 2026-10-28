import { QA_SESSION_CONTRACT } from '@qa/evidence-pipeline';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HarnessRunRequestSchema } from '@qa/schemas';
import {
  createAgentRunId,
  createProjectContextSnapshotId,
  createQARunId,
  createSnapshotId,
} from '@qa/shared';
import { DeepSeekHarnessAdapter } from '../src/index.js';

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

function validPlan() {
  return JSON.stringify({
    schemaVersion: 1,
    projectUnderstanding: 'Small fixture',
    criticalFlows: ['Read path'],
    weakPoints: ['Boundary'],
    plannedChecks: ['Inspect README'],
  });
}

function validReport(alias = false) {
  return JSON.stringify({
    schemaVersion: 2,
    summary: 'One evidence-backed issue.',
    checks: [{ name: alias ? 'check_1' : 'Inspect README', status: 'passed' }],
    hypotheses: [],
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

describe('DeepSeek QA prompt parity', () => {
  it.each(['investigation', 'report', 'cancel', 'shutdown-failure', 'exhausted'])(
    'protects reporting reserve when %s blocks',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'sentry-ds-reserve-'));
      roots.push(root);
      const base = await request(root);
      vi.useFakeTimers();
      const input = HarnessRunRequestSchema.parse({
        ...base,
        task: { ...base.task, context: { qaDepth: { version: 1, deadlineAt: Date.now() + 9000 } } },
      });
      let reached!: () => void;
      const blocked = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let rejectOwned: ((cause: Error) => void) | undefined;
      const prompts: string[] = [];
      let clients = 0;
      const adapter: DeepSeekHarnessAdapter = new DeepSeekHarnessAdapter({
        executable: 'dsh-test',
        modelId: 'deepseek-v4-flash',
        environment: {},
        clientFactory: async () => {
          clients += 1;
          if (clients === 2 && mode === 'cancel') await adapter.cancel(input.agentRunId);
          return {
            start: async () => {},
            startSession: async () => ({
              runText: async (text: string) => {
                prompts.push(text);
                const shouldBlock =
                  mode === 'exhausted'
                    ? prompts.length >= 2
                    : mode === 'report'
                      ? prompts.length === 3
                      : prompts.length === 2;
                if (shouldBlock) {
                  reached();
                  return await new Promise<never>((_, reject) => {
                    rejectOwned = reject;
                  });
                }
                return {
                  sessionId: 'fixture',
                  finalResponse:
                    prompts.length === 1
                      ? validPlan()
                      : prompts.length === 2
                        ? 'Investigation complete.'
                        : validReport(true),
                  events: [],
                  notifications: [],
                };
              },
            }),
            close: async () => {
              if (mode === 'shutdown-failure') throw new Error('Owned shutdown failed');
              rejectOwned?.(new Error('Owned client stopped'));
            },
          };
        },
      });
      const events = [];
      try {
        const running = (async () => {
          for await (const event of adapter.run(input)) events.push(event);
        })();
        await blocked;
        await vi.advanceTimersByTimeAsync(
          mode === 'exhausted' ? 9000 : mode === 'report' ? 4050 : 6000,
        );
        await running;
        if (mode === 'exhausted') {
          expect(events.at(-1)).toMatchObject({
            type: 'run.failed',
            failure: { code: 'QA_REPORT_DEADLINE' },
          });
          expect(prompts).toHaveLength(4);
          expect(clients).toBe(3);
        } else if (mode === 'cancel' || mode === 'shutdown-failure') {
          expect(events.at(-1)?.type).toBe('run.failed');
          expect(prompts).toHaveLength(2);
          expect(clients).toBe(mode === 'cancel' ? 2 : 1);
        } else {
          expect(events.at(-1)?.type).toBe('run.completed');
          expect(clients).toBe(2);
          expect(prompts.at(-1)).toContain('REPORT-ONLY RECOVERY');
          expect(prompts.at(-1)).toContain('schemaVersion');
          expect(events.filter((e) => e.type === 'finding.submitted')).toHaveLength(1);
          expect(events.filter((e) => e.type === 'report.checkpoint')).toHaveLength(1);
        }
      } finally {
        vi.useRealTimers();
        await adapter.dispose().catch(() => {});
      }
    },
  );
  it.each([false, true, 'low-budget', 'review-failure', 'refinement-failure', 'review-unchanged'])(
    'routes independent depth policy enabled=%s',
    async (depth) => {
      const root = await mkdtemp(join(tmpdir(), 'sentry-ds-parity-'));
      roots.push(root);
      const base = await request(root);
      const input = HarnessRunRequestSchema.parse({
        ...base,
        task: {
          ...base.task,
          ...(depth
            ? {
                context: {
                  qaDepth: {
                    version: 1,
                    deadlineAt: Date.now() + (depth === 'low-budget' ? 30_000 : 1_800_000),
                  },
                },
              }
            : {}),
        },
      });
      const prompts: string[] = [];
      const capture = (text: string) => {
        prompts.push(text);
        if (depth === 'review-unchanged' && text.includes('CHALLENGE YOUR OWN INVESTIGATION'))
          return {
            sessionId: 's1',
            finalResponse: '{"reportNeedsUpdate":false}',
            events: [],
            notifications: [],
          };
        if (depth === 'refinement-failure' && prompts.length === 5)
          throw new Error('scripted refinement failure');
        if (depth === 'review-failure' && text.includes('CHALLENGE YOUR OWN INVESTIGATION'))
          throw new Error('scripted review failure');
        if (prompts.length === 1)
          return { sessionId: 's1', finalResponse: validPlan(), events: [], notifications: [] };
        if (prompts.length === 2)
          return {
            sessionId: 's1',
            finalResponse: 'Investigation complete.',
            events: [],
            notifications: [],
          };
        return {
          sessionId: 's1',
          finalResponse: validReport(Boolean(depth)),
          events: [],
          notifications: [],
        };
      };
      const adapter = new DeepSeekHarnessAdapter({
        executable: 'dsh-test',
        modelId: 'deepseek-v4-flash',
        environment: { SENTRY_PARITY_SENTINEL: 'sentry-parity-secret-value' },
        clientFactory: async () => ({
          start: async () => undefined,
          startSession: async () => ({ runText: async (text: string) => capture(text) }),
          close: async () => undefined,
        }),
      });
      const events = [];
      for await (const event of adapter.run(input)) events.push(event);
      await adapter.dispose();
      expect(events.at(-1)?.type).toBe('run.completed');
      expect(events.filter((e) => e.type === 'report.checkpoint')).toHaveLength(depth ? 1 : 0);
      if (depth)
        expect(
          events.some((e) => e.type === 'agent.message' && e.message.includes('Inspect README')),
        ).toBe(true);
      const usageEvent = events.find((e) => e.type === 'usage.updated');
      expect(usageEvent?.type === 'usage.updated' ? usageEvent.usage.turns : undefined).toBe(
        depth === true || depth === 'refinement-failure'
          ? 5
          : depth === 'review-failure' || depth === 'review-unchanged'
            ? 4
            : 3,
      );
      expect(events.filter((e) => e.type === 'finding.submitted')).toHaveLength(1);
      if (depth === 'low-budget')
        expect(events.some((e) => e.type === 'warning' && e.code === 'QA_CHALLENGE_NOT_RUN')).toBe(
          true,
        );
      expect(prompts).toHaveLength(
        depth === true || depth === 'refinement-failure'
          ? 5
          : depth === 'review-failure' || depth === 'review-unchanged'
            ? 4
            : 3,
      );
      if (depth === true) expect(prompts[3]).toContain('CHALLENGE YOUR OWN INVESTIGATION');
      const [planning, investigation] = prompts as [string, string];
      const reporting = prompts[2]!;
      if (depth === 'review-failure' || depth === 'refinement-failure')
        expect(
          events.some((e) => e.type === 'warning' && e.code === 'QA_VALIDATION_INCOMPLETE'),
        ).toBe(true);
      expect(planning).toContain(QA_SESSION_CONTRACT);
      expect(planning).toContain('No tests, builds, lint, typecheck');
      expect(planning).toContain('future actions');
      expect(planning).toContain('User instructions:');
      expect(planning).toContain('Immutable mission context');
      expect(investigation).toContain('STAGE 2');
      expect(investigation).toContain('Do not repeat completed checks');
      expect(investigation).toContain('counterexample');
      expect(investigation).toContain('Small fixture');
      expect(investigation).not.toContain(QA_SESSION_CONTRACT);
      expect(reporting).toContain('No tools');
      expect(reporting).toContain('ONLY authoritative source');
      expect(reporting).toContain('confirmed requires');
      expect(reporting).toContain('not product findings');
      expect(reporting).toContain('check_1');
      expect(reporting).not.toContain(QA_SESSION_CONTRACT);
      expect(prompts.join('\n').split(QA_SESSION_CONTRACT)).toHaveLength(2);
      expect(prompts.join('\n')).not.toContain('sentry-parity-secret-value');
    },
  );
});
