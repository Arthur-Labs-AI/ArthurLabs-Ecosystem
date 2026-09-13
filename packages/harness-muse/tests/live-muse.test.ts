import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { validateFindingTrust } from '@qa/domain';
import {
  agentWorkspacePath,
  projectDataPaths,
  scanTree,
  SentryDatabase,
  SentryRepository,
  RuntimeInstanceLease,
} from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { HarnessAdapterRegistry } from '@qa/harness-protocol';
import { RunCoordinator } from '@qa/run-engine';
import { createMuseRegistration, doctorMuse, MUSE_SDK_VERSION } from '../src/index.js';

const liveEnabled = process.env.SENTRY_LIVE_MUSE_TEST === '1';
const modelId = (process.env.SENTRY_MUSE_MODEL ?? '').trim();

async function writeFixture(source: string): Promise<void> {
  await mkdir(join(source, 'src'), { recursive: true });
  await mkdir(join(source, 'tests'), { recursive: true });
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({ name: 'sentry-live-fixture', version: '0.1.0', type: 'module' }, null, 2) +
      '\n',
  );
  await writeFile(
    join(source, 'README.md'),
    '# Sentry live Muse fixture\n\nTiny math helper with one obvious defect.\n',
  );
  await writeFile(
    join(source, 'src', 'math.ts'),
    'export function divide(a: number, b: number): number {\n' +
      '  if (b === 0) return 0; // DEFECT: silently hides division by zero\n' +
      '  return a / b;\n' +
      '}\n' +
      '\n' +
      'export function add(a: number, b: number): number {\n' +
      '  return a + b;\n' +
      '}\n',
  );
  await writeFile(
    join(source, 'tests', 'math.test.ts'),
    "import { describe, expect, it } from 'vitest';\n" +
      "import { add, divide } from '../src/math.js';\n" +
      '\n' +
      "describe('math', () => {\n" +
      "  it('adds numbers', () => {\n" +
      '    expect(add(2, 3)).toBe(5);\n' +
      '  });\n' +
      '\n' +
      "  it('rejects division by zero', () => {\n" +
      '    expect(() => divide(1, 0)).toThrow();\n' +
      '  });\n' +
      '});\n',
  );
}

describe.skipIf(!liveEnabled || modelId.length === 0)(
  'live Muse full-pipeline smoke (explicit network/cost opt-in)',
  () => {
    it('runs ProjectManager -> snapshot -> workspace -> real Muse -> persistence -> exports -> cleanup', async () => {
      const root = await mkdtemp(join(tmpdir(), 'sentry-live-muse-'));
      const source = join(root, 'fixture');
      const dataRoot = join(root, 'data');
      await writeFixture(source);
      const fixtureBefore = await scanTree(source);

      const database = new SentryDatabase({ dataRoot });
      const repository = new SentryRepository(database);
      const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
      lease.start();
      try {
        // Doctor first: record binary/SDK/model truthfully, never credentials.
        const doctor = await doctorMuse({
          modelId,
          environment: process.env as NodeJS.ProcessEnv,
        });
        expect(doctor.modelId).toBe(modelId);
        expect(doctor.sdkVersion).toBe(MUSE_SDK_VERSION);
        expect(JSON.stringify(doctor)).not.toContain('Bearer');
        const museVersion =
          doctor.executableVersion ?? doctor.checks.find((c) => c.name === 'binary')?.message;
        expect(typeof museVersion === 'string' && museVersion.length > 0).toBe(true);

        const manager = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
        const added = await manager.addProject(source);
        expect(added.project.id.startsWith('proj_')).toBe(true);
        const workingCopy = projectDataPaths(dataRoot, added.project.id).workingCopy;
        const baselineBefore = await scanTree(workingCopy);

        const registry = new HarnessAdapterRegistry().register(createMuseRegistration({}));
        const coordinator = new RunCoordinator(dataRoot, repository, lease, registry);
        const details = await coordinator.run(added.project.id, {
          executionKind: 'production',
          agentStackIds: ['stack_muse_main'],
          verificationLevel: 'strict',
          instructions: 'Inspect this tiny math fixture for defects.',
          // Real model turns are slow; leave headroom under the test budget.
          runTimeoutMs: 5_400_000,
        });

        // The live regression gate requires REAL success: a completed run
        // with a completed agent and a run.completed event (and no
        // run.failed). Zero findings remain allowed; failure does not.
        // Failure payloads log for diagnosis either way (no credentials).
        const failedEvent = details.events.find((e) => e.event.type === 'run.failed');
        const agentRun = details.agentRuns[0];
        console.log(
          'LIVE-RESULT:' +
            JSON.stringify({
              runStatus: details.run.status,
              agentStatus: agentRun?.status,
              failure:
                (failedEvent?.type === 'run.failed' ? failedEvent.failure : null) ??
                agentRun?.failure ??
                null,
              usage: agentRun?.usage ?? null,
              evidence: details.evidence.map((e) => e.type + '/' + e.strength),
              findings: details.findings.map((f) => f.confidence + '/' + f.category),
            }).slice(0, 1200),
        );
        console.log('LIVE-EVENTS:' + details.events.map((e) => e.event.type).join(','));
        expect(details.run.status).toBe('completed');
        expect(details.events.some((e) => e.event.type === 'run.completed')).toBe(true);
        expect(failedEvent).toBeUndefined();
        expect(details.run.executionKind).toBe('production');
        expect(details.agentRuns).toHaveLength(1);
        expect(agentRun?.status).toBe('completed');
        expect(agentRun).toBeDefined();
        expect(agentRun?.agentStackId).toBe('stack_muse_main');
        expect(agentRun?.runtimeIdentity?.adapterId).toBe('muse-code');
        expect(agentRun?.runtimeIdentity?.sdkVersion).toBe(MUSE_SDK_VERSION);
        expect(agentRun?.runtimeIdentity?.modelId).toBe(modelId);
        // No fake adapter anywhere near a production run.
        expect(JSON.stringify(details)).not.toContain('fake-harness');
        expect(JSON.stringify(details)).not.toContain('SIMULATED');

        // Planning + execution actually happened.
        const types = details.events.map((e) => e.event.type);
        expect(types).toContain('investigation.plan.created');
        expect(details.events.length).toBeGreaterThan(5);
        const toolOps = details.events.filter(
          (e) => e.event.type === 'tool.completed' || e.event.type === 'command.executed',
        );
        expect(toolOps.length).toBeGreaterThan(0);
        expect(details.events.some((e) => e.event.type === 'investigation.plan.created')).toBe(
          true,
        );

        // Hidden reasoning never persisted.
        const dumped = JSON.stringify([
          details.events,
          details.evidence,
          details.findings,
          details.activities,
        ]).toLowerCase();
        expect(dumped).not.toContain('chain of thought');

        // Evidence/findings: real pipeline output or legitimate no-finding.
        if (details.findings.length > 0) {
          for (const finding of details.findings) {
            expect(finding.evidenceIds.length).toBeGreaterThan(0);
            const verdict = validateFindingTrust(
              { confidence: finding.confidence, evidenceIds: finding.evidenceIds },
              details.evidence,
            );
            expect(verdict).toEqual({ ok: true });
            for (const id of finding.evidenceIds) {
              expect(details.evidence.some((e) => e.id === id)).toBe(true);
            }
          }
          // Provenance: at least the deterministic path check — every
          // code_reference evidence carries a hash and a valid state.
          for (const evidence of details.evidence) {
            if (evidence.type === 'code_reference') {
              expect(evidence.codeReference.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
              expect(['baseline', 'modified_workspace']).toContain(
                evidence.codeReference.sourceState ?? evidence.environmentState,
              );
            }
          }
        }
        // Zero findings stay allowed (nondeterministic model), but the
        // fixture exists to exercise the evidence pipeline: durable
        // evidence must be non-empty on a successful smoke.
        expect(details.evidence.length).toBeGreaterThan(0);

        // Token usage recorded when the SDK reports it (never fabricated).
        const usageEvents = details.events.filter((e) => e.event.type === 'usage.updated');
        if (usageEvents.length > 0) {
          const usage = usageEvents[0]?.event;
          expect(usage?.type === 'usage.updated' && usage.usage.turns).toBe(2);
        }

        // Production exports created (real labels, no fake markers).
        expect(details.exports.map((e) => e.format).sort()).toEqual(['json', 'log']);

        // Workspace deleted after run (normal cleanup behavior).
        if (agentRun !== undefined) {
          const workspacePath = agentWorkspacePath(
            dataRoot,
            added.project.id,
            details.run.id,
            agentRun.id,
          );
          await expect(stat(workspacePath)).rejects.toThrow();
        }

        // Original fixture byte-identical.
        const fixtureAfter = await scanTree(source);
        expect(fixtureAfter.contentHash).toBe(fixtureBefore.contentHash);
        // Managed baseline byte-identical.
        const baselineAfter = await scanTree(workingCopy);
        expect(baselineAfter.contentHash).toBe(baselineBefore.contentHash);

        // Report (no credentials): versions, counts, trust detail, integrity.
        console.log(
          JSON.stringify({
            live: 'LIVE MUSE SMOKE TEST PASSED',
            museVersion,
            sdkVersion: MUSE_SDK_VERSION,
            modelId,
            runId: details.run.id,
            status: details.run.status,
            plans: details.events.filter((e) => e.event.type === 'investigation.plan.created')
              .length,
            toolOperations: toolOps.length,
            evidence: details.evidence.length,
            evidenceDetail: details.evidence.map(
              (e) => e.type + '/' + e.strength + '/' + e.environmentState,
            ),
            findings: details.findings.length,
            findingsDetail: details.findings.map(
              (f) => f.confidence + '/' + f.category + '/' + f.title.slice(0, 80),
            ),
            usage: agentRun?.usage ?? null,
            workspaceCleaned: true,
            fixtureHashMatch: true,
            baselineHashMatch: true,
          }),
        );
      } finally {
        try {
          lease.release();
        } finally {
          database.close();
        }
        await rm(root, { recursive: true, force: true });
      }
    }, 5_700_000);
  },
);
