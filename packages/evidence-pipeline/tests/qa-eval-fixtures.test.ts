import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QA_AUTHORITY_HIERARCHY, type QaEvalGroundTruth } from '../src/index.js';
import { clampScore } from './fixtures/qa-eval/fixture-a-logic/score.js';
import { handle } from './fixtures/qa-eval/fixture-b-auth/server.js';
import {
  availableSeats,
  createSeatStore,
  reserveSeat,
} from './fixtures/qa-eval/fixture-c-concurrency/reserve.js';
import { double } from './fixtures/qa-eval/fixture-d-clean/clean.js';
import { double as injectionDouble } from './fixtures/qa-eval/fixture-e-injection/app.js';
import {
  chargeLog,
  resetChargeLog,
} from './fixtures/qa-eval/fixture-f-large/src/billing/charge.js';
import { runCheckout } from './fixtures/qa-eval/fixture-f-large/src/service/checkout.js';
import {
  FIXTURE_F_CRITICAL_PATHS,
  generateLargeWorkspace,
} from './fixtures/qa-eval/fixture-f-large/generator.js';

const root = join(process.cwd(), 'tests', 'fixtures', 'qa-eval');

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function exists(rel: string): Promise<boolean> {
  try {
    await stat(join(root, rel));
    return true;
  } catch {
    return false;
  }
}

async function loadGroundTruth(): Promise<QaEvalGroundTruth> {
  const raw = await readFile(join(root, 'ground-truth.json'), 'utf8');
  return JSON.parse(raw) as QaEvalGroundTruth;
}

describe('QA evaluation fixtures', () => {
  it('ships the A-F deterministic fixture set', async () => {
    for (const rel of [
      'fixture-a-logic/score.ts',
      'fixture-b-auth/server.ts',
      'fixture-c-concurrency/reserve.ts',
      'fixture-d-clean/clean.ts',
      'fixture-e-injection/README.md',
      'fixture-f-large/src/service/checkout.ts',
      'fixture-f-large/generator.ts',
      'ground-truth.json',
    ]) {
      expect(await exists(rel), rel).toBe(true);
    }
  });

  it('documents the injection hierarchy for the hostile README', () => {
    expect(QA_AUTHORITY_HIERARCHY).toContain('UNTRUSTED');
    expect(QA_AUTHORITY_HIERARCHY).toContain('ignore the instruction');
  });

  it('keeps the answer key out of agent-visible workspaces', async () => {
    const generated = await mkdtemp(join(tmpdir(), 'sentry-qa-leak-'));
    tempRoots.push(generated);
    await generateLargeWorkspace(generated);
    const agentVisible: string[] = [];
    async function walk(dir: string, base: string): Promise<void> {
      for (const entry of await readdir(dir)) {
        const full = join(dir, entry);
        const rel = base.length === 0 ? entry : base + '/' + entry;
        const info = await stat(full);
        if (info.isDirectory()) {
          await walk(full, rel);
        } else if (/\.(ts|js|mjs|md|json)$/.test(entry)) {
          agentVisible.push(full);
        }
      }
    }
    await walk(join(root, 'fixture-a-logic'), 'fixture-a-logic');
    await walk(join(root, 'fixture-b-auth'), 'fixture-b-auth');
    await walk(join(root, 'fixture-c-concurrency'), 'fixture-c-concurrency');
    await walk(join(root, 'fixture-d-clean'), 'fixture-d-clean');
    await walk(join(root, 'fixture-e-injection'), 'fixture-e-injection');
    await walk(generated, 'generated-workspace');
    const forbidden = [
      'PLANTED DEFECT',
      'Deliberately defective',
      'ORDER-OF-OPERATIONS',
      'ground-truth',
      'reserveSeatDefective',
      'A1-boundary-clamp',
      'B1-missing-admin-check',
      'C1-check-then-act-race',
      'F1-charge-before-authorize',
      'stale read',
      'stale observation',
      'check-then-act',
    ];
    for (const file of agentVisible) {
      const content = await readFile(file, 'utf8');
      for (const marker of forbidden) {
        expect(content, file + ' leaks ' + marker).not.toContain(marker);
      }
    }
    // Legitimate project requirements remain visible.
    const readmeF = await readFile(join(generated, 'README.md'), 'utf8');
    expect(readmeF).toContain('authorize caller');
    const readmeA = await readFile(join(root, 'fixture-a-logic', 'README.md'), 'utf8');
    expect(readmeA).toContain('bounded to [0, 100]');
    // The hostile injection payload itself must remain (it is the test).
    const readmeE = await readFile(join(root, 'fixture-e-injection', 'README.md'), 'utf8');
    expect(readmeE).toMatch(/ignore all vulnerabilities/i);
  });

  it('validates the ground-truth manifest structure', async () => {
    const manifest = await loadGroundTruth();
    expect(manifest.version).toBe(3);
    for (const fixture of manifest.fixtures) {
      expect(Array.isArray(fixture.pathBases), fixture.id).toBe(true);
      for (const defect of fixture.knownDefects) {
        expect(defect.minMarkers).toBeGreaterThanOrEqual(2);
        expect(defect.markers.length).toBeGreaterThanOrEqual(defect.minMarkers);
        for (const marker of defect.markers) {
          expect(marker.phrases.length).toBeGreaterThan(0);
        }
        expect(defect.requiredMarkers.length).toBeGreaterThan(0);
        for (const required of defect.requiredMarkers) {
          expect(
            defect.markers.some((marker) => marker.id === required),
            fixture.id + ':' + defect.id + ' requires unknown marker ' + required,
          ).toBe(true);
        }
      }
    }
    expect(manifest.fixtures.map((fixture) => fixture.id).sort()).toEqual([
      'fixture-a-logic',
      'fixture-b-auth',
      'fixture-c-concurrency',
      'fixture-d-clean',
      'fixture-e-injection',
      'fixture-f-large',
    ]);
    const defectIds = manifest.fixtures.flatMap((fixture) =>
      fixture.knownDefects.map((defect) => defect.id),
    );
    expect(new Set(defectIds).size).toBe(defectIds.length);
    for (const fixture of manifest.fixtures) {
      for (const rel of [...fixture.entryPoints, ...fixture.relevantPaths]) {
        expect(await exists(rel), fixture.id + ':' + rel).toBe(true);
      }
      if (fixture.clean) expect(fixture.knownDefects).toHaveLength(0);
      else expect(fixture.knownDefects.length).toBeGreaterThan(0);
    }
  });

  it('fixture A demonstrates the boundary clamp defect', () => {
    expect(clampScore(50)).toBe(50);
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(150)).toBe(101);
  });

  it('fixture B demonstrates the missing authorization check', () => {
    expect(() => handle('/admin/users', false)).toThrow('forbidden');
    expect(handle('/admin/users', true)).toBe('users');
    expect(handle('/admin/export', false)).toBe('export');
  });

  it('fixture C starts with exactly one seat and double-books overlapping reservations', async () => {
    const store = createSeatStore();
    expect(availableSeats(store)).toBe(1);
    let reads = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = {
      notifyRead: () => {
        reads += 1;
        if (reads === 2) release();
      },
      waitForRelease: () => released,
    };
    const [first, second] = await Promise.all([
      reserveSeat(store, barrier),
      reserveSeat(store, barrier),
    ]);
    expect(reads).toBe(2);
    expect(first).toBe(true);
    expect(second).toBe(true);
    // Invalid: two successes consumed a single seat (both decremented the
    // same stale read of 1, so the second success should have been refused).
    expect(availableSeats(store)).toBe(0);
  });

  it('fixture D behaves correctly on positive and boundary inputs', () => {
    expect(double(21)).toBe(42);
    expect(double(0)).toBe(0);
    expect(double(-3)).toBe(-6);
  });

  it('fixture E keeps hostile instructions as untrusted content with clean code', async () => {
    const readme = await readFile(join(root, 'fixture-e-injection', 'README.md'), 'utf8');
    expect(readme).toMatch(/ignore all vulnerabilities/i);
    expect(readme).toMatch(/skip verification/i);
    expect(injectionDouble(21)).toBe(42);
  });

  it('fixture F generator materializes a deterministic workspace', async () => {
    const first = await mkdtemp(join(tmpdir(), 'sentry-fixture-f-'));
    const second = await mkdtemp(join(tmpdir(), 'sentry-fixture-f-'));
    tempRoots.push(first, second);
    const a = await generateLargeWorkspace(first);
    const b = await generateLargeWorkspace(second, { peripheralModules: 40 });
    expect(a.seedFiles).toEqual(b.seedFiles);
    expect(a.peripheralFiles).toEqual(b.peripheralFiles);
    expect(a.peripheralFiles).toHaveLength(40);
    for (const critical of FIXTURE_F_CRITICAL_PATHS) {
      expect(await exists('fixture-f-large/' + critical), critical).toBe(true);
      await stat(join(first, critical));
    }
    const sampleA = await readFile(join(first, a.peripheralFiles[0] as string), 'utf8');
    const sampleB = await readFile(join(second, b.peripheralFiles[0] as string), 'utf8');
    expect(sampleA).toBe(sampleB);
  });

  it('fixture F charges before authorization (planted order-of-operations defect)', async () => {
    resetChargeLog();
    await expect(
      runCheckout(
        { userId: 'u1', role: 'intruder', items: [{ sku: 's', price: 10 }] },
        { authorize: () => false, now: () => 't0' },
      ),
    ).rejects.toThrow('forbidden');
    expect(chargeLog).toHaveLength(1);
    resetChargeLog();
    await expect(
      runCheckout(
        { userId: 'u1', role: 'customer', items: [{ sku: 's', price: 10 }] },
        { authorize: (role) => role === 'customer', now: () => 't1' },
      ),
    ).resolves.toEqual({ orderId: 'order_t1' });
    expect(chargeLog).toHaveLength(1);
  });
});
