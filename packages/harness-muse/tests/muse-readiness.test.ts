import { describe, expect, it } from 'vitest';
import { doctorMuse } from '../src/index.js';

// Separate file: runtime verification is process-scoped module state, and
// adapter tests in muse-adapter.test.ts set it via real startSession calls.
// Here it is guaranteed false, so doctor must stay honest about it.
describe('Muse readiness semantics', () => {
  it('reports configured readiness without claiming live verification', async () => {
    // process.execPath --version exits 0, so the binary probe passes without
    // any Muse installation; model + binary present but no live session yet.
    const doctor = await doctorMuse({
      executable: process.execPath,
      modelId: 'model',
      environment: {
        SENTRY_MUSE_MODEL: 'model',
        PATH: '/usr/bin',
        GITHUB_TOKEN: 'do-not-leak',
      },
    });
    expect(doctor.readiness).toBe('degraded');
    expect(doctor.configured).toBe(true);
    expect(doctor.binaryAvailable).toBe(true);
    expect(doctor.runtimeVerified).toBe(false);
    expect(doctor.checks.some((check) => check.name === 'environment')).toBe(true);
    expect(doctor.checks.some((check) => check.name === 'sdk')).toBe(true);
    expect(JSON.stringify(doctor)).not.toContain('do-not-leak');
  });

  it('reports unavailable readiness when the binary is missing', async () => {
    const doctor = await doctorMuse({
      executable: 'muse-test-missing-binary',
      modelId: 'model',
      environment: { SENTRY_MUSE_MODEL: 'model', PATH: '/usr/bin' },
    });
    expect(doctor.readiness).toBe('unavailable');
    expect(doctor.configured).toBe(false);
    expect(doctor.runtimeVerified).toBe(false);
  });

  it('reports unconfigured readiness when the model is missing', async () => {
    const doctor = await doctorMuse({
      executable: process.execPath,
      environment: { PATH: '/usr/bin' },
    });
    expect(doctor.readiness).toBe('unconfigured');
    expect(doctor.configured).toBe(false);
    expect(doctor.runtimeVerified).toBe(false);
  });
});
