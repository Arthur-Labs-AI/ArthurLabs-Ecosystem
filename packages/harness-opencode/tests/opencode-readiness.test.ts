import { describe, expect, it } from 'vitest';
import {
  doctorOpenCode,
  OPENCODE_TESTED_VERSION,
  openCodeReadinessFromChecks,
  openRouterCredentialPresent,
  resolveOpenCodeRuntime,
} from '../src/index.js';

describe('OpenCode discovery', () => {
  it('requires an explicit model', () => {
    try {
      resolveOpenCodeRuntime({ environment: {} });
      expect.unreachable('Missing model must throw');
    } catch (cause) {
      expect((cause as { code?: unknown }).code).toBe('OPENCODE_MODEL_NOT_CONFIGURED');
    }
    expect(
      resolveOpenCodeRuntime({
        environment: { SENTRY_OPENCODE_MODEL: 'anthropic/claude-test' },
      }).modelId,
    ).toBe('anthropic/claude-test');
  });

  it('defaults the provider to openrouter without coupling the harness to it', () => {
    const resolved = resolveOpenCodeRuntime({
      environment: { SENTRY_OPENCODE_MODEL: 'x/y' },
    });
    expect(resolved.provider).toBe('openrouter');
    expect(
      resolveOpenCodeRuntime({
        environment: { SENTRY_OPENCODE_MODEL: 'x/y', SENTRY_OPENCODE_PROVIDER: 'other' },
      }).provider,
    ).toBe('other');
  });

  it('detects the OpenRouter credential by presence only', () => {
    expect(openRouterCredentialPresent({})).toBe(false);
    expect(openRouterCredentialPresent({ OPENROUTER_API_KEY: '   ' })).toBe(false);
    expect(openRouterCredentialPresent({ OPENROUTER_API_KEY: 'sentinel' })).toBe(true);
  });

  it('reports unconfigured when model or credential is missing', () => {
    expect(
      openCodeReadinessFromChecks({ modelOk: false, credentialOk: false, binaryOk: true })
        .readiness,
    ).toBe('unconfigured');
    expect(
      openCodeReadinessFromChecks({ modelOk: true, credentialOk: false, binaryOk: true }).readiness,
    ).toBe('unconfigured');
    expect(
      openCodeReadinessFromChecks({ modelOk: true, credentialOk: true, binaryOk: false }).readiness,
    ).toBe('unavailable');
  });

  it('doctor reports unavailable for a missing binary without spending credit', async () => {
    const result = await doctorOpenCode({
      executable: '/definitely/missing/opencode-binary',
      modelId: 'anthropic/claude-test',
      environment: {
        PATH: '/usr/bin',
        OPENROUTER_API_KEY: 'sentry-test-sentinel-credential',
      },
    });
    expect(result.status).toBe('unavailable');
    expect(result.readiness).toBe('unavailable');
    expect(result.credentialConfigured).toBe(true);
    // Doctor reports the EFFECTIVE model id (what --model receives).
    expect(result.modelId).toBe('openrouter/anthropic/claude-test');
    expect(result.provider).toBe('openrouter');
    expect(result.testedVersion).toBe(OPENCODE_TESTED_VERSION);
    // No secret value may appear in doctor output.
    expect(JSON.stringify(result)).not.toContain('sentry-test-sentinel-credential');
  });

  it('doctor reports unconfigured credential without a key', async () => {
    const result = await doctorOpenCode({
      executable: '/definitely/missing/opencode-binary',
      modelId: 'anthropic/claude-test',
      environment: { PATH: '/usr/bin' },
    });
    expect(result.credentialConfigured).toBe(false);
    expect(result.readiness).toBe('unconfigured');
  });
});
