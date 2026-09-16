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
  // Escape probe ships with the fixture source (retained material must
  // contain it). Absolute host paths are baked in: dataRoot exists
  // before import. Only the escape test executes this script.
  await writeFile(
    join(source, 'tests', 'escape.mjs'),
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      'const hostMarker = ' + JSON.stringify(join(dataRoot, 'host-only-marker.txt')) + ';',
      'const dataFile = ' + JSON.stringify(join(dataRoot, 'sentry.db')) + ';',
      "const tmpMarker = '/tmp/sentry-escape-marker.txt';",
      'let hostRead = "unread";',
      'try { hostRead = readFileSync(hostMarker, "utf8"); } catch { hostRead = "blocked"; }',
      'console.log("HOST_READ:" + String(hostRead).trim());',
      'let dataRead = "unread";',
      'try { dataRead = readFileSync(dataFile, "utf8").slice(0, 8); } catch { dataRead = "blocked"; }',
      'console.log("DATA_READ:" + dataRead);',
      'let tmpWrite = "unwritten";',
      'try { writeFileSync(tmpMarker, "x"); tmpWrite = "written"; } catch { tmpWrite = "blocked"; }',
      'console.log("TMP_WRITE:" + tmpWrite);',
      'console.log("HOME:" + process.env.HOME);',
      'process.exit(1);',
      '',
    ].join('\n'),
  );
  // Descendant-cleanup probe ships too: parent.mjs spawns a detached
  // child writing a marker after 8s, then exits immediately. The
  // sandbox cgroup must kill the orphan (marker never appears).
  const survivorMarker = join(dataRoot, 'survivor-marker.txt');
  await writeFile(
    join(source, 'tests', 'parent.mjs'),
    [
      "import { spawn } from 'node:child_process';",
      'const marker = ' + JSON.stringify(survivorMarker) + ';',
      'const child = spawn(process.execPath, ["-e", ' +
        JSON.stringify(
          "setTimeout(() => { require('node:fs').writeFileSync(" +
            JSON.stringify(survivorMarker) +
            ', "survived"); }, 8000);',
        ) +
        '], { detached: true, stdio: "ignore" });',
      'child.unref();',
      'console.log("parent done");',
      '',
    ].join('\n'),
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

  it('contains clean commands: project code cannot escape the sandbox (§16, §63)', async () => {
    // escape.mjs is a CLEAN command (no shell syntax): it tries host
    // reads/writes from inside its own code. The sandbox must block
    // every one; the replay must not reproduce.
    const f = await divideFixture();
    const {
      FindingSchema: FSchema,
      EvidenceSchema: ESchema,
      HarnessEventSchema: HSchema,
    } = await schemas();
    const sandboxAgents = f.repository.listAgentRuns(f.runId);
    const sandboxAgent = sandboxAgents.find((a) => a.status === 'completed') ?? sandboxAgents[0];
    if (sandboxAgent === undefined) throw new Error('No agent run');
    // Host-only marker the sandbox must never let project code read.
    await writeFile(join(f.dataRoot, 'host-only-marker.txt'), 'host-secret\n');
    const tmpMarker = '/tmp/sentry-escape-marker.txt';
    const escapeOpId = 'op_01K7777777777777777777A8W6';
    const escapeEvidence = ESchema.parse({
      schemaVersion: 1,
      id: 'ev_01K7777777777777777777A8W6',
      qaRunId: f.runId,
      agentRunId: sandboxAgent.id,
      type: 'command',
      strength: 'strong_code_evidence',
      environmentState: 'baseline',
      description: 'escape probe',
      command: { command: 'node tests/escape.mjs', exitCode: 1 },
      artifactIds: [],
      groundingOperationIds: [escapeOpId],
      createdAt: T,
    });
    f.repository.saveEvidence(escapeEvidence);
    const escapeFinding = FSchema.parse({
      schemaVersion: 1,
      id: 'find_01K7777777777777777777A8W6',
      qaRunId: f.runId,
      agentRunId: sandboxAgent.id,
      sourceAgentStackId: sandboxAgent.agentStackId,
      title: 'Escape probe finding',
      category: 'logic',
      severity: 'medium',
      confidence: 'strong',
      description: 'escape.',
      locations: [{ relativePath: 'src/divide.mjs', startLine: 1 }],
      evidenceIds: [escapeEvidence.id],
      reproductionSteps: [],
      createdAt: T,
    });
    f.repository.saveFinding(escapeFinding);
    f.repository.appendHarnessEvent(
      f.runId,
      HSchema.parse({
        schemaVersion: 1,
        eventId: 'evt_01K7777777777777777777A8W6',
        agentRunId: sandboxAgent.id,
        timestamp: T,
        type: 'command.executed',
        operationId: escapeOpId,
        command: 'node tests/escape.mjs',
        exitCode: 1,
      }),
    );
    const { result: escapeMerge } = mergeRun(f.repository, f.runId);
    const { attempts: escapeAttempts } = await verifyMerge(
      f.repository,
      f.dataRoot,
      escapeMerge.id,
      {
        commandTimeoutMs: 30000,
      },
    );
    const escapeTarget = escapeAttempts.find((a) =>
      a.sourceFindingIds.includes(escapeFinding.id as never),
    );
    expect(escapeTarget?.outcome).not.toBe('reproduced');
    const { resolveInside } = await import('@qa/persistence');
    const { readFile, stat } = await import('node:fs/promises');
    let replayText = '';
    for (const observation of f.repository.listVerificationObservations(
      escapeTarget?.id as never,
    )) {
      for (const artifactId of observation.artifactIds) {
        const artifact = f.repository.getArtifact(artifactId);
        if (artifact === undefined) continue;
        replayText += await readFile(
          resolveInside(f.dataRoot, artifact.relativeStoragePath),
          'utf8',
        );
      }
    }
    expect(replayText).toContain('HOST_READ:blocked');
    expect(replayText).toContain('DATA_READ:blocked');
    expect(replayText).toContain('TMP_WRITE:blocked');
    expect(replayText).not.toContain('host-secret');
    await expect(stat(tmpMarker)).rejects.toThrow();
    f.database.close();
  }, 180000);

  it('replays from the canonical relative cwd in monorepos (§40, §69)', async () => {
    // frontend/tests/test.mjs passes ONLY from frontend/ (reads the
    // sibling package.json). From the root it exits 1. cwdRelative =
    // frontend must therefore yield a matched replay; '.' would not.
    const root = await fixtureBase('sentry-verify-mono-');
    roots.push(root);
    const source = join(root, 'source');
    const dataRoot = join(root, 'data');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(source, 'frontend', 'tests'), { recursive: true });
    await writeFile(
      join(source, 'frontend', 'tests', 'test.mjs'),
      [
        "import { readFileSync } from 'node:fs';",
        'const pkg = JSON.parse(readFileSync("package.json", "utf8"));',
        'if (pkg.name !== "frontend") { console.log("× wrong cwd: " + pkg.name); process.exit(1); }',
        'console.log("✓ frontend cwd");',
        '',
      ].join('\n'),
    );
    await writeFile(join(source, 'frontend', 'package.json'), JSON.stringify({ name: 'frontend' }));
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'root' }));
    const {
      SentryDatabase: DB,
      SentryRepository: Repo,
      RuntimeInstanceLease: Lease,
    } = await import('@qa/persistence');
    const { ProjectManager: PM } = await import('@qa/project-manager');
    const { RunCoordinator: RC, createFakeHarnessRegistry: Fake } = await import('../src/index.js');
    const database = new DB({ dataRoot });
    const repository = new Repo(database);
    const lease = new Lease(repository, { autoHeartbeat: false });
    lease.start();
    const manager = new PM(dataRoot, repository, { runtimeLease: lease });
    const added = await manager.addProject(source);
    const coordinator = new RC(dataRoot, repository, lease, Fake('success'));
    const result = await coordinator.run(added.project.id, { executionKind: 'simulation' });
    const f = { dataRoot, database, repository, runId: result.run.id, source };
    const { FindingSchema: F2, EvidenceSchema: E2, HarnessEventSchema: H2 } = await schemas();
    const agents2 = f.repository.listAgentRuns(f.runId);
    const agent2 = agents2.find((a) => a.status === 'completed') ?? agents2[0];
    if (agent2 === undefined) throw new Error('No agent run');
    const opId = 'op_01K7777777777777777777A8W7';
    const evidence = E2.parse({
      schemaVersion: 1,
      id: 'ev_01K7777777777777777777A8W7',
      qaRunId: f.runId,
      agentRunId: agent2.id,
      type: 'command',
      strength: 'strong_code_evidence',
      environmentState: 'baseline',
      description: 'monorepo test',
      command: { command: 'node tests/test.mjs', cwdRelative: 'frontend', exitCode: 0 },
      artifactIds: [],
      groundingOperationIds: [opId],
      createdAt: T,
    });
    f.repository.saveEvidence(evidence);
    const finding = F2.parse({
      schemaVersion: 1,
      id: 'find_01K7777777777777777777A8W7',
      qaRunId: f.runId,
      agentRunId: agent2.id,
      sourceAgentStackId: agent2.agentStackId,
      title: 'Frontend cwd finding',
      category: 'logic',
      severity: 'medium',
      confidence: 'strong',
      description: 'cwd.',
      locations: [{ relativePath: 'frontend/tests/test.mjs', startLine: 1 }],
      evidenceIds: [evidence.id],
      reproductionSteps: [],
      createdAt: T,
    });
    f.repository.saveFinding(finding);
    f.repository.appendHarnessEvent(
      f.runId,
      H2.parse({
        schemaVersion: 1,
        eventId: 'evt_01K7777777777777777777A8W7',
        agentRunId: agent2.id,
        timestamp: T,
        type: 'command.executed',
        operationId: opId,
        command: 'node tests/test.mjs',
        exitCode: 0,
      }),
    );
    const { result: merge } = mergeRun(f.repository, f.runId);
    const { attempts } = await verifyMerge(f.repository, f.dataRoot, merge.id, {
      commandTimeoutMs: 30000,
    });
    const target = attempts.find((a) => a.sourceFindingIds.includes(finding.id as never));
    // Exit 0 observed from frontend/ with matching exit: weak match
    // (no original signature) → partially_verified. From the wrong cwd
    // the script exits 1 → mismatch. This proves cwd was honored.
    expect(target?.status).toBe('completed');
    expect(target?.outcome).toBe('partially_verified');
    f.database.close();
  }, 180000);

  it('kills descendant processes that outlive their parent (§26, §67)', async () => {
    const f = await divideFixture();
    const { stat, rm } = await import('node:fs/promises');
    const marker = join(f.dataRoot, 'survivor-marker.txt');
    await rm(marker, { force: true });
    const { FindingSchema: F4, EvidenceSchema: E4, HarnessEventSchema: H4 } = await schemas();
    const agents4 = f.repository.listAgentRuns(f.runId);
    const agent4 = agents4.find((a) => a.status === 'completed') ?? agents4[0];
    if (agent4 === undefined) throw new Error('No agent run');
    const opId = 'op_01K7777777777777777777A8W8';
    const evidence = E4.parse({
      schemaVersion: 1,
      id: 'ev_01K7777777777777777777A8W8',
      qaRunId: f.runId,
      agentRunId: agent4.id,
      type: 'command',
      strength: 'strong_code_evidence',
      environmentState: 'baseline',
      description: 'parent spawner',
      command: { command: 'node tests/parent.mjs', exitCode: 0 },
      artifactIds: [],
      groundingOperationIds: [opId],
      createdAt: T,
    });
    f.repository.saveEvidence(evidence);
    const finding = F4.parse({
      schemaVersion: 1,
      id: 'find_01K7777777777777777777A8W8',
      qaRunId: f.runId,
      agentRunId: agent4.id,
      sourceAgentStackId: agent4.agentStackId,
      title: 'Parent spawner',
      category: 'logic',
      severity: 'low',
      confidence: 'strong',
      description: 'spawns.',
      locations: [{ relativePath: 'src/divide.mjs', startLine: 1 }],
      evidenceIds: [evidence.id],
      reproductionSteps: [],
      createdAt: T,
    });
    f.repository.saveFinding(finding);
    f.repository.appendHarnessEvent(
      f.runId,
      H4.parse({
        schemaVersion: 1,
        eventId: 'evt_01K7777777777777777777A8W8',
        agentRunId: agent4.id,
        timestamp: T,
        type: 'command.executed',
        operationId: opId,
        command: 'node tests/parent.mjs',
        exitCode: 0,
      }),
    );
    const { result: merge } = mergeRun(f.repository, f.runId);
    await verifyMerge(f.repository, f.dataRoot, merge.id, { commandTimeoutMs: 30000 });
    // Past the child's 8s delay: cgroup cleanup must have killed it.
    await new Promise((resolve) => setTimeout(resolve, 12000));
    await expect(stat(marker)).rejects.toThrow();
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
