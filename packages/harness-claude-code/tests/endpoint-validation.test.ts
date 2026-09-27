import { describe, expect, it } from 'vitest';
import {
  assertGlmEndpointConfigured,
  validateGlmEndpoint,
} from '../src/discovery.js';

describe('validateGlmEndpoint agrees with the adapter assertion', () => {
  it('accepts a trusted Z.AI-compatible endpoint', () => {
    const env = { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } as NodeJS.ProcessEnv;
    expect(() => assertGlmEndpointConfigured(env)).not.toThrow();
    expect(validateGlmEndpoint(env)).toEqual({ valid: true });
  });

  it('rejects a missing endpoint without throwing', () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(() => assertGlmEndpointConfigured(env)).toThrow();
    const result = validateGlmEndpoint(env);
    expect(result.valid).toBe(false);
    expect(result.reason ?? '').toContain('endpoint');
  });

  it('rejects the default api.anthropic.com route', () => {
    const env = { ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1' } as NodeJS.ProcessEnv;
    expect(() => assertGlmEndpointConfigured(env)).toThrow();
    expect(validateGlmEndpoint(env).valid).toBe(false);
  });

  it('rejects URLs carrying user credentials', () => {
    const env = { ANTHROPIC_BASE_URL: 'https://user:pass@example.com/v1' } as NodeJS.ProcessEnv;
    expect(() => assertGlmEndpointConfigured(env)).toThrow();
    expect(validateGlmEndpoint(env).valid).toBe(false);
  });

  it('rejects non-URL values', () => {
    const env = { ANTHROPIC_BASE_URL: 'not-a-url' } as NodeJS.ProcessEnv;
    expect(() => assertGlmEndpointConfigured(env)).toThrow();
    expect(validateGlmEndpoint(env).valid).toBe(false);
  });
});
