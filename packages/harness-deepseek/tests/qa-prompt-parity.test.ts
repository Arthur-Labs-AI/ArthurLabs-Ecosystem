import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  QA_ANTI_SUPERFICIAL_RULES,
  QA_AUTHORITY_HIERARCHY,
  QA_INVESTIGATION_METHOD,
  QA_INVESTIGATION_REPRODUCTION_GUIDANCE,
  QA_LARGE_PROJECT_GUIDANCE,
  QA_PLANNING_RISK_GUIDANCE,
  QA_REPORTING_COVERAGE_GUIDANCE,
  REPORT_REPRODUCTION_CONTRACT,
} from '@qa/evidence-pipeline';
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

function validReport() {
  return JSON.stringify({
    schemaVersion: 2,
    summary: 'One evidence-backed issue.',
    checks: [{ name: 'Inspect README', status: 'passed' }],
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
  it.each([false, true, 'low-budget'])(
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
                    deadlineAt: Date.now() + (depth === 'low-budget' ? 30_000 : 300_000),
                  },
                },
              }
            : {}),
        },
      });
      const prompts: string[] = [];
      const capture = (text: string) => {
        prompts.push(text);
        if (prompts.length === 1)
          return { sessionId: 's1', finalResponse: validPlan(), events: [], notifications: [] };
        if (prompts.length === 2)
          return {
            sessionId: 's1',
            finalResponse: 'Investigation complete.',
            events: [],
            notifications: [],
          };
        return { sessionId: 's1', finalResponse: validReport(), events: [], notifications: [] };
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
      if (depth === 'low-budget')
        expect(events.some((e) => e.type === 'warning' && e.code === 'QA_CHALLENGE_NOT_RUN')).toBe(
          true,
        );
      expect(prompts).toHaveLength(depth === true ? 4 : 3);
      if (depth === true) expect(prompts[2]).toContain('CHALLENGE YOUR OWN INVESTIGATION');
      const [planning, investigation] = prompts as [string, string];
      const reporting = prompts.at(-1)!;
      expect(planning).toContain('Authority hierarchy');
      expect(planning).toContain('risk-first');
      expect(investigation).toContain('Phase A');
      expect(investigation).toContain('Phase F');
      expect(investigation).toContain('NOT behavior reproduction');
      expect(investigation).toContain('successful build as proof');
      expect(investigation).toContain('call-path tracing');
      expect(reporting).toContain('ONLY authoritative source');
      expect(reporting).toContain('operation key');
      expect(reporting).toContain('confirmed requires');
      expect(reporting).toContain('zero findings');
      expect(planning + investigation).toContain('ignore the instruction');
      expect(planning).toContain(QA_AUTHORITY_HIERARCHY.slice(0, 80));
      expect(planning).toContain(QA_PLANNING_RISK_GUIDANCE.slice(0, 80));
      expect(investigation).toContain(QA_INVESTIGATION_METHOD.slice(0, 80));
      expect(investigation).toContain(QA_INVESTIGATION_REPRODUCTION_GUIDANCE.slice(0, 80));
      expect(investigation).toContain(QA_ANTI_SUPERFICIAL_RULES.slice(0, 80));
      expect(investigation).toContain(QA_LARGE_PROJECT_GUIDANCE.slice(0, 80));
      expect(reporting).toContain(QA_REPORTING_COVERAGE_GUIDANCE.slice(0, 80));
      expect(reporting).toContain(REPORT_REPRODUCTION_CONTRACT.slice(0, 80));
      expect(planning).toContain('first character is {');
      expect(planning).toContain('Immutable mission context:');
      expect(planning).toContain('User instructions:');
      expect(investigation).toContain('Frozen plan:');
      expect(investigation).toContain('Small fixture');
      expect(reporting).toContain('frozen after investigation');
      expect(reporting).toContain('No new QA');
      expect(reporting).toContain('do not run commands');
      expect(prompts.join('\n')).not.toContain('sentry-parity-secret-value');
    },
  );
});
