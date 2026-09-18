import { describe, expect, it } from 'vitest';
import { createGlmRegistration, doctorGlm, glmReadinessFromChecks } from '../src/index.js';

// Separate file: runtime verification is process-scoped module state, and
// adapter tests set it via real startSession calls. Here it is guaranteed
// false, so doctor must stay honest about it.
describe('GLM readiness semantics', () => {
  it('does not claim a Z.AI route when ANTHROPIC_BASE_URL is absent', async () => {
    const environment = { SENTRY_GLM_MODEL: 'glm-5.3-flash', PATH: '/usr/bin' };
    const doctor = await doctorGlm({ executable: process.execPath, environment });
    expect(doctor.configured).toBe(false);
    expect(doctor.checks).toContainEqual(
      expect.objectContaining({ name: 'endpoint', status: 'fail' }),
    );
    await expect(
      createGlmRegistration({ executable: process.execPath, environment }).preflight?.(),
    ).rejects.toThrow(/ANTHROPIC_BASE_URL/);
  });
  it('does not claim provider authentication when ANTHROPIC_AUTH_TOKEN is absent', async () => {
    const environment = {
      SENTRY_GLM_MODEL: 'glm-5.3-flash',
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      PATH: '/usr/bin',
    };
    const doctor = await doctorGlm({ executable: process.execPath, environment });
    expect(doctor.configured).toBe(false);
    expect(doctor.checks).toContainEqual(
      expect.objectContaining({ name: 'authentication', status: 'fail' }),
    );
    await expect(
      createGlmRegistration({ executable: process.execPath, environment }).preflight?.(),
    ).rejects.toThrow(/ANTHROPIC_AUTH_TOKEN/);
  });
  it('reports configured readiness without claiming live verification', async () => {
    const doctor = await doctorGlm({
      executable: process.execPath,
      modelId: 'glm-5.3-flash',
      environment: {
        SENTRY_GLM_MODEL: 'glm-5.3-flash',
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'test-credential-not-real',
        PATH: '/usr/bin',
        GITHUB_TOKEN: 'do-not-leak',
      },
    });
    expect(doctor.readiness).toBe('configured');
    expect(doctor.configured).toBe(true);
    expect(doctor.binaryAvailable).toBe(true);
    expect(doctor.runtimeVerified).toBe(false);
    expect(doctor.checks.some((check) => check.name === 'environment')).toBe(true);
    expect(doctor.checks.some((check) => check.name === 'sdk')).toBe(true);
    expect(JSON.stringify(doctor)).not.toContain('do-not-leak');
    expect(JSON.stringify(doctor)).not.toContain('test-credential-not-real');
  });

  it('reports unavailable readiness when the binary is missing', async () => {
    const doctor = await doctorGlm({
      executable: 'claude-test-missing-binary',
      modelId: 'glm-5.3-flash',
      environment: {
        SENTRY_GLM_MODEL: 'glm-5.3-flash',
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'test-credential-not-real',
        PATH: '/usr/bin',
      },
    });
    expect(doctor.readiness).toBe('unavailable');
    expect(doctor.configured).toBe(false);
    expect(doctor.runtimeVerified).toBe(false);
  });

  it('reports unconfigured readiness when the model is missing', async () => {
    const doctor = await doctorGlm({
      executable: process.execPath,
      environment: { PATH: '/usr/bin' },
    });
    expect(doctor.readiness).toBe('unconfigured');
    expect(doctor.configured).toBe(false);
    expect(doctor.runtimeVerified).toBe(false);
  });

  it('computes ready only after runtime verification, degraded only on real warning', () => {
    expect(glmReadinessFromChecks({ modelOk: true, binaryOk: true }).readiness).toBe('configured');
    expect(
      glmReadinessFromChecks({ modelOk: true, binaryOk: true, runtimeVerified: true }).readiness,
    ).toBe('ready');
    expect(
      glmReadinessFromChecks({ modelOk: true, binaryOk: true, realWarning: true }).readiness,
    ).toBe('degraded');
    expect(glmReadinessFromChecks({ modelOk: false, binaryOk: true }).readiness).toBe(
      'unconfigured',
    );
    expect(glmReadinessFromChecks({ modelOk: true, binaryOk: false }).readiness).toBe(
      'unavailable',
    );
  });
});
