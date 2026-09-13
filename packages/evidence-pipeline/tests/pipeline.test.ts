import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { HarnessRunRequestSchema } from '@qa/schemas';
import type { SentryAgentEvidenceV1 } from '@qa/schemas';
import {
  createAgentRunId,
  createOperationId,
  createProjectContextSnapshotId,
  createQARunId,
  createSnapshotId,
} from '@qa/shared';
import {
  buildBaselineIndex,
  commandIdentity,
  convertEvidence,
  emptyGrounding,
  isTestCommand,
  normalizeCommandText,
  parseWholeJson,
  summarizeSchemaIssues,
  validateLocation,
  validateProductionFindings,
  type EvidencePipelineContext,
  type ObservedEvidenceGrounding,
} from '../src/index.js';

class PipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineError';
  }
}

const context: EvidencePipelineContext = {
  errors: { invalidResult: (message: string) => new PipelineError(message) },
  authorLabel: 'Test Harness',
  secrets: ['sentry-test-secret'],
  redactDiagnostic: (value: string) => value.replaceAll('sentry-test-secret', '[REDACTED]'),
  redactStructured: (value: unknown) => value,
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-pipeline-'));
  roots.push(root);
  await writeFile(join(root, 'a.ts'), 'line one\nline two\nline three\n');
  return root;
}

function request(root: string) {
  return HarnessRunRequestSchema.parse({
    schemaVersion: 1,
    agentRunId: createAgentRunId(),
    qaRunId: createQARunId(),
    agentStackId: 'stack_muse_main',
    projectContextSnapshotId: createProjectContextSnapshotId(),
    workspace: {
      runtimePath: root,
      snapshotId: createSnapshotId(),
      writable: true,
      isolated: true,
    },
    model: { provider: 'test', modelId: 'test-model' },
    task: { type: 'qa', prompt: 'x', policyId: 'qa-standard', policyVersion: 1 },
    executionSafeguards: { runTimeoutMs: 30_000 },
  });
}

function groundingWithCommand(command: string, exitCode: number): ObservedEvidenceGrounding {
  const base = emptyGrounding();
  const operationId = createOperationId();
  return {
    observedCommands: new Set([commandIdentity(command, exitCode)]),
    operations: new Map([
      [
        'op_1',
        {
          operationId,
          operationKey: 'op_1',
          toolName: 'shell',
          commandText: command,
          exitCode,
          isTestOperation: isTestCommand(command),
        },
      ],
    ]),
  };
}

describe('shared evidence pipeline', () => {
  it('normalizes command text for identity', () => {
    expect(normalizeCommandText('  pnpm   test\n')).toBe('pnpm test');
    expect(commandIdentity('pnpm test', 0)).toBe(commandIdentity('pnpm  test', 0));
    expect(commandIdentity('pnpm test', 0)).not.toBe(commandIdentity('pnpm test', 1));
  });

  it('grounds op-linked command evidence from the observed operation', async () => {
    const root = await workspace();
    const source = {
      key: 'cmd',
      type: 'command',
      strength: 'tool_diagnostic',
      description: 'Suite ran.',
      command: 'pnpm test',
      exitCode: 0,
      operationKey: 'op_1',
    } as SentryAgentEvidenceV1;
    const evidence = await convertEvidence(
      request(root),
      source,
      context,
      groundingWithCommand('pnpm test', 0),
    );
    expect(evidence.type).toBe('command');
    if (evidence.type === 'command') {
      expect(evidence.command.command).toBe('pnpm test');
      expect(evidence.command.exitCode).toBe(0);
    }
  });

  it('rejects exit-code spoofing on a linked operation', async () => {
    const root = await workspace();
    const source = {
      key: 'cmd',
      type: 'command',
      strength: 'tool_diagnostic',
      description: 'Suite ran.',
      command: 'pnpm test',
      exitCode: 0,
      operationKey: 'op_1',
    } as SentryAgentEvidenceV1;
    await expect(
      convertEvidence(request(root), source, context, groundingWithCommand('pnpm test', 1)),
    ).rejects.toThrow(/exit code/);
  });

  it('rejects reproduced text mismatch and downgrades weak mismatch', async () => {
    const root = await workspace();
    const reproduced = {
      key: 'cmd',
      type: 'command',
      strength: 'reproduced_behavior',
      description: 'Reproduced.',
      command: 'pnpm lint',
      exitCode: 0,
      operationKey: 'op_1',
    } as SentryAgentEvidenceV1;
    await expect(
      convertEvidence(request(root), reproduced, context, groundingWithCommand('pnpm test', 0)),
    ).rejects.toThrow(/text does not match/);
    const weak = { ...reproduced, strength: 'tool_diagnostic' } as SentryAgentEvidenceV1;
    const downgraded = await convertEvidence(
      request(root),
      weak,
      context,
      groundingWithCommand('pnpm test', 0),
    );
    expect(downgraded.type).toBe('manual');
  });

  it('rejects reproduced test claims without an operation and downgrades weak ones', async () => {
    const root = await workspace();
    const reproduced = {
      key: 't',
      type: 'test',
      strength: 'reproduced_failure',
      description: 'Failed.',
      framework: 'vitest',
      name: 'x',
      status: 'failed',
    } as SentryAgentEvidenceV1;
    await expect(
      convertEvidence(request(root), reproduced, context, emptyGrounding()),
    ).rejects.toThrow(/correlated observed operation/);
    const weak = { ...reproduced, strength: 'tool_diagnostic' } as SentryAgentEvidenceV1;
    const downgraded = await convertEvidence(request(root), weak, context, emptyGrounding());
    expect(downgraded.type).toBe('manual');
    expect(downgraded.strength).toBe('agent_reasoning');
  });

  it('rejects unknown operation keys', async () => {
    const root = await workspace();
    const source = {
      key: 't',
      type: 'test',
      strength: 'tool_diagnostic',
      description: 'x',
      operationKey: 'op_99',
    } as SentryAgentEvidenceV1;
    await expect(convertEvidence(request(root), source, context, emptyGrounding())).rejects.toThrow(
      /unknown operation/,
    );
  });

  it('contains evidence paths to the workspace including symlink escapes', async () => {
    const root = await workspace();
    await expect(validateLocation(root, 'a.ts', context, 2, 2)).resolves.toContain('a.ts');
    await expect(validateLocation(root, '../outside.ts', context)).rejects.toThrow(/escapes/);
    await expect(validateLocation(root, 'missing.ts', context)).rejects.toThrow(/does not exist/);
    await expect(validateLocation(root, 'a.ts', context, 99)).rejects.toThrow(/line range/);
    const outside = await mkdtemp(join(tmpdir(), 'sentry-pipeline-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'secret.ts'), 'x\n');
    await symlink(join(outside, 'secret.ts'), join(root, 'link.ts'));
    await expect(validateLocation(root, 'link.ts', context)).rejects.toThrow(/outside/);
  });

  it('classifies baseline vs modified provenance from the sidecar', async () => {
    const root = await workspace();
    const { createHash } = await import('node:crypto');
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(join(root, 'a.ts'));
    const hash = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    const req = request(root);
    const sidecarDir = join(root, '..', '.sentry-workspace');
    await mkdir(sidecarDir, { recursive: true });
    roots.push(sidecarDir);
    await writeFile(
      join(sidecarDir, 'baseline-hashes.json'),
      JSON.stringify({
        schemaVersion: 1,
        snapshotId: req.workspace.snapshotId,
        files: { 'a.ts': hash },
      }),
    );
    const index = await buildBaselineIndex(root, req.workspace.snapshotId);
    expect(index?.fileHashByPath.get('a.ts')).toBe(hash);
    const source = {
      key: 'ref',
      type: 'code_reference',
      strength: 'strong_code_evidence',
      description: 'Line.',
      relativePath: 'a.ts',
      lineStart: 1,
      lineEnd: 1,
    } as SentryAgentEvidenceV1;
    const evidence = await convertEvidence(req, source, context, {
      ...emptyGrounding(),
      baseline: index,
    });
    expect(evidence.type).toBe('code_reference');
    if (evidence.type === 'code_reference') {
      expect(evidence.codeReference.sourceState).toBe('baseline');
      expect(evidence.environmentState).toBe('baseline');
    }
  });

  it('gates findings through the generic trust policy', async () => {
    const root = await workspace();
    const req = request(root);
    const source = {
      key: 'ref',
      type: 'code_reference',
      strength: 'strong_code_evidence',
      description: 'Line.',
      relativePath: 'a.ts',
      lineStart: 1,
      lineEnd: 1,
    } as SentryAgentEvidenceV1;
    const evidence = await convertEvidence(req, source, context, emptyGrounding());
    const byKey = new Map([['ref', evidence]]);
    expect(() =>
      validateProductionFindings(
        [{ evidenceKeys: ['ref'], confidence: 'strong' }],
        byKey,
        (message) => new PipelineError(message),
      ),
    ).not.toThrow();
    expect(() =>
      validateProductionFindings(
        [{ evidenceKeys: ['ref'], confidence: 'confirmed' }],
        byKey,
        (message) => new PipelineError(message),
      ),
    ).toThrow(PipelineError);
  });

  it('parses whole JSON and summarizes schema issues without values', () => {
    expect(parseWholeJson('{"a":1}', 'planning', context)).toEqual({ a: 1 });
    expect(() => parseWholeJson('{"a":', 'planning', context)).toThrow(/complete JSON/);
    const summary = summarizeSchemaIssues({
      issues: [{ path: ['evidence', 0, 'type'], message: 'bad' }],
    });
    expect(summary).toContain('evidence.0.type');
    expect(summary).not.toContain('sentry-test-secret');
  });
});
