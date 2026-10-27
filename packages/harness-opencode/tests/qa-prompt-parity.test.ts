import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPORT_REPRODUCTION_CONTRACT } from '@qa/evidence-pipeline';
import {
  QA_ANTI_SUPERFICIAL_RULES,
  QA_AUTHORITY_HIERARCHY,
  QA_INVESTIGATION_METHOD,
  QA_INVESTIGATION_REPRODUCTION_GUIDANCE,
  QA_LARGE_PROJECT_GUIDANCE,
  QA_PLANNING_RISK_GUIDANCE,
  QA_REPORTING_COVERAGE_GUIDANCE,
} from '@qa/evidence-pipeline';
import { HarnessRunRequestSchema } from '@qa/schemas';
import {
  createAgentRunId,
  createProjectContextSnapshotId,
  createQARunId,
  createSnapshotId,
} from '@qa/shared';
import {
  DirectOpenCodeProcessLauncher,
  OpenCodeHarnessAdapter,
  type OpenCodeClientFactory,
  type OpenCodePromptResult,
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
    agentStackId: 'stack_opencode_main',
    projectContextSnapshotId: createProjectContextSnapshotId(),
    workspace: {
      runtimePath: root,
      snapshotId: createSnapshotId(),
      writable: true,
      isolated: true,
    },
    model: { provider: 'openrouter', modelId: 'anthropic/claude-test' },
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

const textTurn = (text: string): OpenCodePromptResult => ({
  text,
  toolCalls: [],
  steps: 1,
  sessionId: 'ses_test_111',
  envelopes: 2,
});

describe('OpenCode QA prompt parity', () => {
  it.each([false, true, 'low-budget', 'review-failure', 'refinement-failure', 'review-unchanged'])(
    'routes independent depth policy enabled=%s',
    async (depth) => {
      const root = await mkdtemp(join(tmpdir(), 'sentry-oc-parity-'));
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
      const factory: OpenCodeClientFactory = async () => ({
        startSession: async () => ({
          runPrompt: async (prompt: string) => {
            prompts.push(prompt);
            if (depth === 'review-unchanged' && prompt.includes('CHALLENGE YOUR OWN INVESTIGATION'))
              return textTurn('{"reportNeedsUpdate":false}');
            if (depth === 'refinement-failure' && prompts.length === 5)
              throw new Error('scripted refinement failure');
            if (depth === 'review-failure' && prompt.includes('CHALLENGE YOUR OWN INVESTIGATION'))
              throw new Error('scripted review failure');
            if (prompts.length === 1) return textTurn(validPlan());
            if (prompts.length === 2) return textTurn('Investigation complete.');
            return textTurn(validReport());
          },
          abort: () => undefined,
        }),
        close: async () => undefined,
      });
      const adapter = new OpenCodeHarnessAdapter({
        executable: 'opencode-test',
        modelId: 'anthropic/claude-test',
        environment: { PATH: '/usr/bin', OPENROUTER_API_KEY: 'sentry-parity-secret-credential' },
        // Sentinel: prompts must never leak host credentials (asserted below).
        clientFactory: factory,
        launcherSelector: async () => new DirectOpenCodeProcessLauncher(),
        toolShellBuilder: async () => undefined,
      });
      const events = [];
      for await (const event of adapter.run(input)) events.push(event);
      await adapter.dispose();
      expect(events.at(-1)?.type).toBe('run.completed');
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
      // Planning: risk-first, authority hierarchy, schema preserved.
      expect(planning).toContain('Authority hierarchy');
      expect(planning).toContain('UNTRUSTED');
      expect(planning).toContain('risk-first');
      expect(planning).toContain('do not inventory every file');
      expect(planning).toContain('"schemaVersion":1');
      // Investigation: adaptive method, anti-superficial, large-project, reproduction.
      expect(investigation).toContain('Phase A');
      expect(investigation).toContain('Phase F');
      expect(investigation).toContain('NOT behavior reproduction');
      expect(investigation).toContain('frozen ledger');
      expect(investigation).toContain('successful build as proof');
      expect(investigation).toContain('call-path tracing');
      expect(investigation).toContain('Do NOT produce the final Sentry JSON report yet');
      // Reporting: shared contracts plus honest coverage, still tool-free.
      expect(reporting).toContain('ONLY authoritative source');
      expect(reporting).toContain('operation key');
      expect(reporting).toContain('confirmed requires');
      expect(reporting).toContain('zero findings');
      expect(reporting).toContain('schemaVersion 2');
      // Prompt-injection boundary present in the real turn.
      expect(planning + investigation).toContain('ignore the instruction');
      // Shared guidance pinned via the exported constants themselves, not
      // arbitrary substrings: the turns must carry the canonical text.
      expect(planning).toContain(QA_AUTHORITY_HIERARCHY.slice(0, 80));
      expect(planning).toContain(QA_PLANNING_RISK_GUIDANCE.slice(0, 80));
      expect(investigation).toContain(QA_INVESTIGATION_METHOD.slice(0, 80));
      expect(investigation).toContain(QA_INVESTIGATION_REPRODUCTION_GUIDANCE.slice(0, 80));
      expect(investigation).toContain(QA_ANTI_SUPERFICIAL_RULES.slice(0, 80));
      expect(investigation).toContain(QA_LARGE_PROJECT_GUIDANCE.slice(0, 80));
      expect(reporting).toContain(QA_REPORTING_COVERAGE_GUIDANCE.slice(0, 80));
      expect(reporting).toContain(REPORT_REPRODUCTION_CONTRACT.slice(0, 80));
      // Stage contracts: planning output contract, mission context, frozen
      // plan in investigation, frozen ledger + tool-free reporting.
      expect(planning).toContain('first character is {');
      expect(planning).toContain('Immutable mission context:');
      expect(planning).toContain('User instructions:');
      expect(investigation).toContain('Frozen plan:');
      expect(investigation).toContain('Small fixture');
      expect(reporting).toContain('frozen after investigation');
      expect(reporting).toContain('No new QA');
      expect(reporting).toContain('do not run commands');
      // No host credentials leak into prompts.
      expect(prompts.join('\n')).not.toContain('sentry-parity-secret-credential');
    },
  );
});
