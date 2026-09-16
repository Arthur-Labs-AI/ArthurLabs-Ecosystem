import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bindable fixture base: sandboxed units need a host path the sandbox
 *  backend can bind. os.tmpdir() is invisible on WSL2 (private /tmp in
 *  the user manager) and $HOME holes clash with ProtectHome, so
 *  fixtures live repo-local (same fs family as real dataRoots) and are
 *  removed in afterEach. */
async function fixtureBase(prefix: string): Promise<string> {
  const base = join(fileURLToPath(new URL('../../../.tmp-sentry-test-fixtures', import.meta.url)));
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, prefix));
}
import { afterEach, describe, expect, it } from 'vitest';
import { SentryDatabase, SentryRepository, RuntimeInstanceLease } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { createFakeHarnessRegistry, mergeRun, RunCoordinator, verifyMerge } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

const T = '2026-09-16T00:00:00.000Z';

/** Deterministic fixture project with a KNOWN failing test (pure node,
 *  zero dependencies): `node tests/run-tests.mjs` exits 1 naming the
 *  failing test. No network, no installs. */
async function divideFixture() {
  const root = await fixtureBase('sentry-verify-trust-');
  roots.push(root);
  const source = join(root, 'source');
  const dataRoot = join(root, 'data');
  await mkdir(join(source, 'src'), { recursive: true });
  await mkdir(join(source, 'tests'), { recursive: true });
  // Intentionally buggy: mirrors the real divide-by-zero sentinel defect.
  await writeFile(
    join(source, 'src', 'divide.mjs'),
    'export function divide(a, b) { if (b === 0) return 0; return a / b; }\n',
  );
  await writeFile(
    join(source, 'tests', 'run-tests.mjs'),
    [
      "import { divide } from '../src/divide.mjs';",
      'const failures = [];',
      'try { const r = divide(1, 0); if (r !== Infinity) failures.push("divide by zero must be Infinity"); } catch (e) { failures.push("divide by zero threw"); }',
      'if (failures.length > 0) { for (const f of failures) console.log("× " + f); process.exit(1); }',
      'console.log("✓ divide");',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({ name: 'divide-fixture', type: 'module' }),
  );
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
  lease.start();
  const manager = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
  const added = await manager.addProject(source);
  const coordinator = new RunCoordinator(
    dataRoot,
    repository,
    lease,
    createFakeHarnessRegistry('success'),
  );
  const result = await coordinator.run(added.project.id, { executionKind: 'simulation' });
  return { dataRoot, database, repository, runId: result.run.id, source };
}

async function schemas() {
  return import('@qa/schemas');
}

describe('verifier trust fixtures', () => {
  it('reproduces a known failing test with strong identity (§50)', async () => {
    const f = await divideFixture();
    const { FindingSchema, EvidenceSchema, HarnessEventSchema } = await schemas();
    const agents = f.repository.listAgentRuns(f.runId);
    const agent = agents.find((a) => a.status === 'completed') ?? agents[0];
    if (agent === undefined) throw new Error('No agent run');
    const opId = 'op_01K7777777777777777777A8W1';
    const evidence = EvidenceSchema.parse({
      schemaVersion: 1,
      id: 'ev_01K7777777777777777777A8W1',
      qaRunId: f.runId,
      agentRunId: agent.id,
      type: 'test',
      strength: 'strong_code_evidence',
      environmentState: 'baseline',
      description: 'failing test',
      test: { framework: 'node', name: 'divide by zero must be Infinity', status: 'failed' },
      artifactIds: [],
      groundingOperationIds: [opId],
      createdAt: T,
    });
    f.repository.saveEvidence(evidence);
    const finding = FindingSchema.parse({
      schemaVersion: 1,
      id: 'find_01K7777777777777777777A8W1',
      qaRunId: f.runId,
      agentRunId: agent.id,
      sourceAgentStackId: agent.agentStackId,
      title: 'Divide by zero not Infinity',
      category: 'logic',
      severity: 'high',
      confidence: 'strong',
      description: 'divide(1,0) must be Infinity.',
      locations: [{ relativePath: 'src/divide.mjs', startLine: 1 }],
      evidenceIds: [evidence.id],
      reproductionSteps: [],
      createdAt: T,
    });
    f.repository.saveFinding(finding);
    f.repository.appendHarnessEvent(
      f.runId,
      HarnessEventSchema.parse({
        schemaVersion: 1,
        eventId: 'evt_01K7777777777777777777A8W1',
        agentRunId: agent.id,
        timestamp: T,
        type: 'command.executed',
        operationId: opId,
        command: 'node tests/run-tests.mjs',
        exitCode: 1,
      }),
    );
    const { result: merge } = mergeRun(f.repository, f.runId);
    const { run, attempts } = await verifyMerge(f.repository, f.dataRoot, merge.id, {
      commandTimeoutMs: 30000,
    });
    const target = attempts.find((a) => a.sourceFindingIds.includes(finding.id as never));
    expect(target).toBeDefined();
    expect(target?.status).toBe('completed');
    // Strong identity: same test name + same failure status, fresh run.
    expect(target?.outcome).toBe('reproduced');
    expect(run.status).not.toBe('failed');
    f.database.close();
  }, 180000);

  it('refuses to confirm a different failing test (§52)', async () => {
    // Original: Test A fails. Fresh replay: Test A passes, Test B fails,
    // same exit. Exit-only agreement must NOT reproduce.
    const f = await divideFixture();
    const { FindingSchema, EvidenceSchema, HarnessEventSchema } = await schemas();
    const agents = f.repository.listAgentRuns(f.runId);
    const agent = agents.find((a) => a.status === 'completed') ?? agents[0];
    if (agent === undefined) throw new Error('No agent run');
    const opId = 'op_01K7777777777777777777A8W2';
    const evidence = EvidenceSchema.parse({
      schemaVersion: 1,
      id: 'ev_01K7777777777777777777A8W2',
      qaRunId: f.runId,
      agentRunId: agent.id,
      type: 'test',
      strength: 'strong_code_evidence',
      environmentState: 'baseline',
      description: 'failing test',
      test: { framework: 'node', name: 'divide handles negatives', status: 'failed' },
      artifactIds: [],
      groundingOperationIds: [opId],
      createdAt: T,
    });
    f.repository.saveEvidence(evidence);
    const finding = FindingSchema.parse({
      schemaVersion: 1,
      id: 'find_01K7777777777777777777A8W2',
      qaRunId: f.runId,
      agentRunId: agent.id,
      sourceAgentStackId: agent.agentStackId,
      title: 'Divide negatives broken',
      category: 'logic',
      severity: 'high',
      confidence: 'strong',
      description: 'negatives fail.',
      locations: [{ relativePath: 'src/divide.mjs', startLine: 1 }],
      evidenceIds: [evidence.id],
      reproductionSteps: [],
      createdAt: T,
    });
    f.repository.saveFinding(finding);
    f.repository.appendHarnessEvent(
      f.runId,
      HarnessEventSchema.parse({
        schemaVersion: 1,
        eventId: 'evt_01K7777777777777777777A8W2',
        agentRunId: agent.id,
        timestamp: T,
        type: 'command.executed',
        operationId: opId,
        command: 'node tests/run-tests.mjs',
        exitCode: 1,
      }),
    );
    const { result: merge } = mergeRun(f.repository, f.runId);
    const { attempts } = await verifyMerge(f.repository, f.dataRoot, merge.id, {
      commandTimeoutMs: 30000,
    });
    const target = attempts.find((a) => a.sourceFindingIds.includes(finding.id as never));
    // The replayed suite fails on the DIVIDE test, not the expected
    // negatives test: identity unconfirmed → never reproduced.
    expect(target?.outcome).not.toBe('reproduced');
    f.database.close();
  }, 180000);

  it('keeps fake secrets out of every persistence layer (§56)', async () => {
    const f = await divideFixture();
    const { FindingSchema, EvidenceSchema, HarnessEventSchema } = await schemas();
    const agents = f.repository.listAgentRuns(f.runId);
    const agent = agents.find((a) => a.status === 'completed') ?? agents[0];
    if (agent === undefined) throw new Error('No agent run');
    const opId = 'op_01K7777777777777777777A8W4';
    // The replayed script prints a fake Bearer token: the redaction
    // boundary must scrub it before ANY persistence layer.
    await writeFile(
      join(f.source, 'tests', 'leak.mjs'),
      'console.log("Authorization: Bearer faketoken1234567890abcdef");\nprocess.exit(1);\n',
    );
    const evidence = EvidenceSchema.parse({
      schemaVersion: 1,
      id: 'ev_01K7777777777777777777A8W4',
      qaRunId: f.runId,
      agentRunId: agent.id,
      type: 'command',
      strength: 'strong_code_evidence',
      environmentState: 'baseline',
      description: 'leaky command',
      command: { command: 'node tests/leak.mjs', exitCode: 1 },
      artifactIds: [],
      groundingOperationIds: [opId],
      createdAt: T,
    });
    f.repository.saveEvidence(evidence);
    const finding = FindingSchema.parse({
      schemaVersion: 1,
      id: 'find_01K7777777777777777777A8W4',
      qaRunId: f.runId,
      agentRunId: agent.id,
      sourceAgentStackId: agent.agentStackId,
      title: 'Leaky suite',
      category: 'logic',
      severity: 'medium',
      confidence: 'strong',
      description: 'prints secret.',
      locations: [{ relativePath: 'src/divide.mjs', startLine: 1 }],
      evidenceIds: [evidence.id],
      reproductionSteps: [],
      createdAt: T,
    });
    f.repository.saveFinding(finding);
    f.repository.appendHarnessEvent(
      f.runId,
      HarnessEventSchema.parse({
        schemaVersion: 1,
        eventId: 'evt_01K7777777777777777777A8W4',
        agentRunId: agent.id,
        timestamp: T,
        type: 'command.executed',
        operationId: opId,
        command: 'node tests/leak.mjs',
        exitCode: 1,
      }),
    );
    const { result: merge } = mergeRun(f.repository, f.runId);
    const { attempts } = await verifyMerge(f.repository, f.dataRoot, merge.id, {
      commandTimeoutMs: 30000,
    });
    const SECRET = 'faketoken1234567890abcdef';
    const { resolveInside } = await import('@qa/persistence');
    const { readFile } = await import('node:fs/promises');
    for (const attempt of attempts) {
      for (const step of f.repository.listVerificationSteps(attempt.id)) {
        expect(JSON.stringify(step)).not.toContain(SECRET);
      }
      for (const observation of f.repository.listVerificationObservations(attempt.id)) {
        expect(JSON.stringify(observation)).not.toContain(SECRET);
        for (const artifactId of observation.artifactIds) {
          const artifact = f.repository.getArtifact(artifactId);
          expect(artifact).toBeDefined();
          if (artifact !== undefined) {
            const bytes = await readFile(
              resolveInside(f.dataRoot, artifact.relativeStoragePath),
              'utf8',
            );
            expect(bytes).not.toContain(SECRET);
          }
        }
      }
      for (const assertion of f.repository.listVerificationAssertions(attempt.id)) {
        expect(JSON.stringify(assertion)).not.toContain(SECRET);
      }
    }
    f.database.close();
  }, 180000);

  it('refuses shell-escaped replay without executing (§57)', async () => {
    const f = await divideFixture();
    const { FindingSchema, EvidenceSchema, HarnessEventSchema } = await schemas();
    const agents = f.repository.listAgentRuns(f.runId);
    const agent = agents.find((a) => a.status === 'completed') ?? agents[0];
    if (agent === undefined) throw new Error('No agent run');
    const opId = 'op_01K7777777777777777777A8W5';
    const marker = join(f.dataRoot, 'escape-marker.txt');
    const evidence = EvidenceSchema.parse({
      schemaVersion: 1,
      id: 'ev_01K7777777777777777777A8W5',
      qaRunId: f.runId,
      agentRunId: agent.id,
      type: 'command',
      strength: 'strong_code_evidence',
      environmentState: 'baseline',
      description: 'escaped command',
      command: { command: 'node tests/run-tests.mjs && touch ' + marker, exitCode: 1 },
      artifactIds: [],
      groundingOperationIds: [opId],
      createdAt: T,
    });
    f.repository.saveEvidence(evidence);
    const finding = FindingSchema.parse({
      schemaVersion: 1,
      id: 'find_01K7777777777777777777A8W5',
      qaRunId: f.runId,
      agentRunId: agent.id,
      sourceAgentStackId: agent.agentStackId,
      title: 'Escaped suite',
      category: 'logic',
      severity: 'medium',
      confidence: 'strong',
      description: 'escaped.',
      locations: [{ relativePath: 'src/divide.mjs', startLine: 1 }],
      evidenceIds: [evidence.id],
      reproductionSteps: [],
      createdAt: T,
    });
    f.repository.saveFinding(finding);
    f.repository.appendHarnessEvent(
      f.runId,
      HarnessEventSchema.parse({
        schemaVersion: 1,
        eventId: 'evt_01K7777777777777777777A8W5',
        agentRunId: agent.id,
        timestamp: T,
        type: 'command.executed',
        operationId: opId,
        command: 'node tests/run-tests.mjs && touch ' + marker,
        exitCode: 1,
      }),
    );
    const { result: merge } = mergeRun(f.repository, f.runId);
    const { attempts } = await verifyMerge(f.repository, f.dataRoot, merge.id, {
      commandTimeoutMs: 30000,
    });
    const target = attempts.find((a) => a.sourceFindingIds.includes(finding.id as never));
    expect(target?.outcome).not.toBe('reproduced');
    // The escape never executed: marker absent.
    const { stat } = await import('node:fs/promises');
    await expect(stat(marker)).rejects.toThrow();
    f.database.close();
  }, 180000);

  it('marks missing tools inconclusive with a warning (§54)', async () => {
    const f = await divideFixture();
    const { FindingSchema, EvidenceSchema, HarnessEventSchema } = await schemas();
    const agents = f.repository.listAgentRuns(f.runId);
    const agent = agents.find((a) => a.status === 'completed') ?? agents[0];
    if (agent === undefined) throw new Error('No agent run');
    const opId = 'op_01K7777777777777777777A8W3';
    const evidence = EvidenceSchema.parse({
      schemaVersion: 1,
      id: 'ev_01K7777777777777777777A8W3',
      qaRunId: f.runId,
      agentRunId: agent.id,
      type: 'command',
      strength: 'strong_code_evidence',
      environmentState: 'baseline',
      description: 'node suite fails',
      command: { command: 'node tests/run-tests.mjs', exitCode: 1 },
      artifactIds: [],
      groundingOperationIds: [opId],
      createdAt: T,
    });
    f.repository.saveEvidence(evidence);
    const finding = FindingSchema.parse({
      schemaVersion: 1,
      id: 'find_01K7777777777777777777A8W3',
      qaRunId: f.runId,
      agentRunId: agent.id,
      sourceAgentStackId: agent.agentStackId,
      title: 'Node suite fails',
      category: 'logic',
      severity: 'high',
      confidence: 'strong',
      description: 'node fails.',
      locations: [{ relativePath: 'src/divide.mjs', startLine: 1 }],
      evidenceIds: [evidence.id],
      reproductionSteps: [],
      createdAt: T,
    });
    f.repository.saveFinding(finding);
    f.repository.appendHarnessEvent(
      f.runId,
      HarnessEventSchema.parse({
        schemaVersion: 1,
        eventId: 'evt_01K7777777777777777777A8W3',
        agentRunId: agent.id,
        timestamp: T,
        type: 'command.executed',
        operationId: opId,
        command: 'node tests/run-tests.mjs',
        exitCode: 1,
      }),
    );
    const { result: merge } = mergeRun(f.repository, f.runId);
    // Hermetic tool absence: empty PATH makes even node unresolvable.
    // Preflight must refuse without spawning (§12); the outcome must
    // never be not_reproducible from tool absence (§11).
    const savedPath = process.env['PATH'];
    process.env['PATH'] = join(f.dataRoot, 'empty-bin');
    let attempts;
    let run;
    try {
      ({ run, attempts } = await verifyMerge(f.repository, f.dataRoot, merge.id, {
        commandTimeoutMs: 30000,
      }));
    } finally {
      if (savedPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = savedPath;
    }
    const target = attempts.find((a) => a.sourceFindingIds.includes(finding.id as never));
    expect(target?.outcome).toBe('inconclusive');
    expect(target?.outcome).not.toBe('not_reproducible');
    expect(run.warnings.some((w) => w.code === 'VERIFIER_TOOL_UNAVAILABLE')).toBe(true);
    f.database.close();
  }, 180000);
});
