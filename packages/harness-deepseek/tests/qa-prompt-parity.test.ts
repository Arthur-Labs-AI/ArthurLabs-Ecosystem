import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
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
  it('routes shared behavioral guidance through real turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-ds-parity-'));
    roots.push(root);
    const input = await request(root);
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
      environment: {},
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
    expect(prompts).toHaveLength(3);
    const [planning, investigation, reporting] = prompts as [string, string, string];
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
  });
});
