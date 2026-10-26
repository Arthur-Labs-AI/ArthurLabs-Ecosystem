import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  it('routes shared behavioral guidance through real planning/investigation/reporting turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-oc-parity-'));
    roots.push(root);
    const input = await request(root);
    const prompts: string[] = [];
    const factory: OpenCodeClientFactory = async () => ({
      startSession: async () => ({
        runPrompt: async (prompt: string) => {
          prompts.push(prompt);
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
      environment: { PATH: '/usr/bin', OPENROUTER_API_KEY: 'x' },
      clientFactory: factory,
      launcherSelector: async () => new DirectOpenCodeProcessLauncher(),
      toolShellBuilder: async () => undefined,
    });
    const events = [];
    for await (const event of adapter.run(input)) events.push(event);
    await adapter.dispose();
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(prompts).toHaveLength(3);
    const [planning, investigation, reporting] = prompts as [string, string, string];
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
  });
});
