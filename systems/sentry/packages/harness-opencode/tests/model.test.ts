import { describe, expect, it } from 'vitest';
import { buildOpenCodeModelId, normalizeOpenCodeProvider } from '../src/index.js';

describe('OpenCode model composition', () => {
  it('composes provider + vendor-qualified model', () => {
    expect(buildOpenCodeModelId('openrouter', 'anthropic/claude-x')).toEqual({
      provider: 'openrouter',
      configuredModel: 'anthropic/claude-x',
      effectiveModelId: 'openrouter/anthropic/claude-x',
    });
  });

  it('composes provider + bare model', () => {
    expect(buildOpenCodeModelId('openrouter', 'gpt-4').effectiveModelId).toBe('openrouter/gpt-4');
  });

  it('never doubles the provider prefix', () => {
    const identity = buildOpenCodeModelId('openrouter', 'openrouter/anthropic/claude-x');
    expect(identity.effectiveModelId).toBe('openrouter/anthropic/claude-x');
    expect(identity.effectiveModelId).not.toContain('openrouter/openrouter');
  });

  it('defaults an empty provider to openrouter for vendor/bare models', () => {
    expect(buildOpenCodeModelId(undefined, 'anthropic/x').provider).toBe('openrouter');
    expect(buildOpenCodeModelId('  ', 'anthropic/x').effectiveModelId).toBe(
      'openrouter/anthropic/x',
    );
  });

  it('infers known OpenCode providers from a qualified model when provider is unset', () => {
    expect(buildOpenCodeModelId(undefined, 'opencode-go/kimi-k3')).toEqual({
      provider: 'opencode-go',
      configuredModel: 'opencode-go/kimi-k3',
      effectiveModelId: 'opencode-go/kimi-k3',
    });
    expect(buildOpenCodeModelId('  ', 'opencode/gpt-5.5')).toEqual({
      provider: 'opencode',
      configuredModel: 'opencode/gpt-5.5',
      effectiveModelId: 'opencode/gpt-5.5',
    });
    expect(normalizeOpenCodeProvider(undefined, 'opencode-go/gemini-4-argon-contributor')).toBe(
      'opencode-go',
    );
  });

  it('rejects missing models', () => {
    for (const model of ['', undefined]) {
      try {
        buildOpenCodeModelId('openrouter', model);
        expect.unreachable('Missing model must throw');
      } catch (cause) {
        expect((cause as { code?: unknown }).code).toBe('OPENCODE_MODEL_NOT_CONFIGURED');
      }
    }
  });

  it('rejects malformed models', () => {
    expect(() => buildOpenCodeModelId('openrouter', 'has space')).toThrow();
    expect(() => buildOpenCodeModelId('openrouter', '/leading')).toThrow();
    expect(() => buildOpenCodeModelId('openrouter', 'trailing/')).toThrow();
    expect(() => buildOpenCodeModelId('openrouter', 'http://x')).toThrow();
    expect(() => buildOpenCodeModelId('open/router', 'x')).toThrow();
  });

  it('normalizes provider case', () => {
    expect(normalizeOpenCodeProvider('OpenRouter')).toBe('openrouter');
  });
});
