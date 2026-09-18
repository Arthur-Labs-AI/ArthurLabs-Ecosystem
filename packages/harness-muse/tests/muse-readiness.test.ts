import { describe, expect, it } from 'vitest';
import {
  doctorMuse,
  isMuseCodeVersion,
  museReadinessFromChecks,
  probeMuseExecutable,
} from '../src/index.js';

// Separate file: runtime verification is process-scoped module state, and
// adapter tests in muse-adapter.test.ts set it via real startSession calls.
// Here it is guaranteed false, so doctor must stay honest about it.
describe('Muse readiness semantics', () => {
  it('recognizes the Muse Code host version, but not the Linux music sequencer', () => {
    expect(isMuseCodeVersion('Muse Code 1.3.0 (1.3.0-R3057.1)')).toBe(true);
    expect(isMuseCodeVersion('MusE 4.2.1')).toBe(false);
    expect(isMuseCodeVersion('v22.23.2')).toBe(false);
  });
  it('rejects an unrelated program that responds to --version', async () => {
    await expect(probeMuseExecutable(process.execPath)).rejects.toThrow(/Muse Code CLI/);
  });
  it('reports an unrelated executable as unavailable without claiming live verification', async () => {
    // Node --version exits 0, but it is not the Muse Code host.
    const doctor = await doctorMuse({
      executable: process.execPath,
      modelId: 'model',
      environment: {
        SENTRY_MUSE_MODEL: 'model',
        PATH: '/usr/bin',
        GITHUB_TOKEN: 'do-not-leak',
      },
    });
    expect(doctor.readiness).toBe('unavailable');
    expect(doctor.configured).toBe(false);
    expect(doctor.binaryAvailable).toBe(false);
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

  it('computes ready only after runtime verification, degraded only on real warning', () => {
    expect(museReadinessFromChecks({ modelOk: true, binaryOk: true }).readiness).toBe('configured');
    expect(
      museReadinessFromChecks({ modelOk: true, binaryOk: true, runtimeVerified: true }).readiness,
    ).toBe('ready');
    expect(
      museReadinessFromChecks({ modelOk: true, binaryOk: true, realWarning: true }).readiness,
    ).toBe('degraded');
    expect(
      museReadinessFromChecks({
        modelOk: true,
        binaryOk: true,
        runtimeVerified: true,
        realWarning: true,
      }).readiness,
    ).toBe('degraded');
    expect(museReadinessFromChecks({ modelOk: false, binaryOk: true }).readiness).toBe(
      'unconfigured',
    );
    expect(museReadinessFromChecks({ modelOk: true, binaryOk: false }).readiness).toBe(
      'unavailable',
    );
  });
});
