import { describe, expect, it } from 'vitest';
import { deepSeekReadinessFromChecks, doctorDeepSeek } from '../src/index.js';

// Separate file: runtime verification is process-scoped module state, and
// adapter tests set it via real startSession calls. Here it is guaranteed
// false, so doctor must stay honest about it.
describe('DeepSeek readiness semantics', () => {
  it('reports configured readiness without claiming live verification', async () => {
    const doctor = await doctorDeepSeek({
      executable: process.execPath,
      modelId: 'deepseek-v4-flash',
      environment: {
        SENTRY_DEEPSEEK_MODEL: 'deepseek-v4-flash',
        PATH: '/usr/bin',
        GITHUB_TOKEN: 'do-not-leak',
      },
    });
    expect(doctor.readiness).toBe('configured');
    expect(doctor.configured).toBe(true);
    expect(doctor.binaryAvailable).toBe(true);
    expect(doctor.runtimeVerified).toBe(false);
    expect(doctor.checks).toContainEqual({
      name: 'model-alias',
      status: 'warn',
      message:
        'Configured DeepSeek model uses legacy alias deepseek-v4-flash. Canonical tested route is deepseek-flash.',
    });
    expect(doctor.checks.some((check) => check.name === 'environment')).toBe(true);
    expect(doctor.checks.some((check) => check.name === 'sdk')).toBe(true);
    expect(JSON.stringify(doctor)).not.toContain('do-not-leak');
  });

  it('reports unavailable readiness when the binary is missing', async () => {
    const doctor = await doctorDeepSeek({
      executable: 'deepseek-test-missing-binary',
      modelId: 'deepseek-v4-flash',
      environment: { SENTRY_DEEPSEEK_MODEL: 'deepseek-v4-flash', PATH: '/usr/bin' },
    });
    expect(doctor.readiness).toBe('unavailable');
    expect(doctor.configured).toBe(false);
    expect(doctor.runtimeVerified).toBe(false);
  });

  it('reports unconfigured readiness when the model is missing', async () => {
    const doctor = await doctorDeepSeek({
      executable: process.execPath,
      environment: { PATH: '/usr/bin' },
    });
    expect(doctor.readiness).toBe('unconfigured');
    expect(doctor.configured).toBe(false);
    expect(doctor.runtimeVerified).toBe(false);
  });

  it('computes ready only after runtime verification, degraded only on real warning', () => {
    expect(deepSeekReadinessFromChecks({ modelOk: true, binaryOk: true }).readiness).toBe(
      'configured',
    );
    expect(
      deepSeekReadinessFromChecks({ modelOk: true, binaryOk: true, runtimeVerified: true })
        .readiness,
    ).toBe('ready');
    expect(
      deepSeekReadinessFromChecks({ modelOk: true, binaryOk: true, realWarning: true }).readiness,
    ).toBe('degraded');
    expect(
      deepSeekReadinessFromChecks({
        modelOk: true,
        binaryOk: true,
        runtimeVerified: true,
        realWarning: true,
      }).readiness,
    ).toBe('degraded');
    expect(deepSeekReadinessFromChecks({ modelOk: false, binaryOk: true }).readiness).toBe(
      'unconfigured',
    );
    expect(deepSeekReadinessFromChecks({ modelOk: true, binaryOk: false }).readiness).toBe(
      'unavailable',
    );
  });
});
