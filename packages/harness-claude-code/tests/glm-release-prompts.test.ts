import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir as systemTmpdir } from 'node:os';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
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
import { ClaudeCodeHarnessAdapter } from '../src/index.js';

const suiteRoot = mkdtempSync(join(systemTmpdir(), 'sentry-claude-parity-'));
afterAll(() => rm(suiteRoot, { recursive: true, force: true }));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  hermeticRoot = undefined;
});
let hermeticRoot: string | undefined;
function hermeticUsersRoot(): string {
  if (hermeticRoot === undefined) {
    hermeticRoot = mkdtempSync(join(suiteRoot, 'sentry-hermetic-'));
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

function evt(type: string, raw: Record<string, unknown>) {
  return { type, raw };
}

function planTurn() {
  return [
    evt('system', { subtype: 'init', session_id: 's', tools: ['Bash', 'Read'], model: 'm' }),
    evt('assistant', { message: { content: [{ type: 'text', text: validPlan() }] } }),
    evt('result', { is_error: false }),
  ];
}
function investigationTurn() {
  return [
    evt('assistant', { message: { content: [{ type: 'text', text: 'Investigation complete.' }] } }),
    evt('result', { is_error: false }),
  ];
}
function reportTurn() {
  return [
    evt('assistant', { message: { content: [{ type: 'text', text: validReport() }] } }),
    evt('result', { is_error: false }),
  ];
}

// Owner requested the v1.0.2 GLM prompts. Other harnesses deliberately keep
// their newer guidance; cross-harness prompt parity is no longer the GLM spec.
describe('GLM v1.0.2 prompt behavior', () => {
  it('uses the release guidance through real turns and keeps provider safeguards', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const root = await mkdtemp(join(tmpdir(), 'sentry-claude-parity-'));
    roots.push(root);
    const input = await request(root);
    const prompts: string[] = [];
    const stages = [planTurn(), investigationTurn(), reportTurn()];
    const adapter = new ClaudeCodeHarnessAdapter({
      executable: 'claude-test',
      modelId: 'glm-5.3-flash',
      environment: { SENTRY_PARITY_SENTINEL: 'sentry-parity-secret-value' },
      windowsUsersRoot: hermeticUsersRoot(),
      wslMountIsolationOverride: {
        status: 'available',
        backend: 'systemd',
        windowsMountsHidden: true,
        reason: 'scripted prompt fixture: no host preflight needed',
      },
      clientFactory: async () => ({
        sessionId: 'session-parity',
        startSession: async () => ({
          runText: (async (text: string) => {
            prompts.push(text);
            const next = stages[Math.min(prompts.length - 1, stages.length - 1)];
            return next;
          }) as unknown as never,
        }),
        close: async () => undefined,
      }),
    });
    const events = [];
    for await (const event of adapter.run(input)) events.push(event);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(prompts).toHaveLength(3);
    const [planning, investigation, reporting] = prompts as [string, string, string];
    expect(planning).toContain('a listing plus a handful of file reads is enough');
    expect(planning).toContain('Explicit run instructions define intended behavior');
    expect(investigation).toContain('Inspect every applicable area needed for comprehensive QA');
    expect(investigation).toContain(
      'a handful of targeted checks beats dozens of exploratory commands',
    );
    expect(reporting).toContain('operation key');
    expect(reporting).toContain('ONLY authoritative source');
    expect(reporting).toContain('confirmed requires');
    // Provider-specific safeguard preserved (missing-file guidance).
    expect(planning).toContain('Never retry a failed path identically');
    expect(planning).not.toContain(QA_AUTHORITY_HIERARCHY.slice(0, 80));
    expect(planning).not.toContain(QA_PLANNING_RISK_GUIDANCE.slice(0, 80));
    expect(investigation).not.toContain(QA_INVESTIGATION_METHOD.slice(0, 80));
    expect(investigation).not.toContain(QA_INVESTIGATION_REPRODUCTION_GUIDANCE.slice(0, 80));
    expect(investigation).not.toContain(QA_ANTI_SUPERFICIAL_RULES.slice(0, 80));
    expect(investigation).not.toContain(QA_LARGE_PROJECT_GUIDANCE.slice(0, 80));
    expect(reporting).not.toContain(QA_REPORTING_COVERAGE_GUIDANCE.slice(0, 80));
    expect(reporting).not.toContain(REPORT_REPRODUCTION_CONTRACT.slice(0, 80));
    expect(planning).toContain('first character is {');
    expect(planning).toContain('Immutable mission context:');
    expect(planning).toContain('User instructions:');
    expect(investigation).toContain('Frozen plan:');
    expect(investigation).toContain('Small fixture');
    expect(reporting).toContain('frozen after investigation');
    expect(reporting).toContain('No new QA');
    expect(reporting).toContain('do not run commands');
    expect(prompts.join('\n')).not.toContain('sentry-parity-secret-value');
  });
});
