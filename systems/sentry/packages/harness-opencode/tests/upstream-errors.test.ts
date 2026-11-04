import { describe, expect, it } from 'vitest';
import { classifyOpenCodeTurnFailure } from '../src/index.js';

const CONTEXT = { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' };

describe('provider error classification', () => {
  it('classifies an upstream 503 as retryable UPSTREAM_FAILED, not START_FAILED', () => {
    const detail = JSON.stringify({
      name: 'APIError',
      data: {
        message: 'Upstream request failed: Endpoint is unavailable.',
        statusCode: 503,
        isRetryable: true,
        responseHeaders: { 'cf-ray': 'abc123', 'x-opencode-log-id': 'log-1' },
      },
    });
    const failure = classifyOpenCodeTurnFailure({ detail, ...CONTEXT });
    expect(failure.code).toBe('OPENCODE_UPSTREAM_FAILED');
    expect(failure.retryable).toBe(true);
    expect(failure.message).toContain('opencode-go');
    expect(failure.message).toContain('muse-spark-1.3-contributor');
    expect(failure.message).toContain('503');
    expect(failure.message).toContain('Endpoint is unavailable');
    expect(failure.message).toContain('abc123');
    expect(failure.message).toContain('log-1');
    expect(failure.message.length).toBeLessThan(600);
  });

  it('keeps 401 authentication failures distinct', () => {
    const detail = JSON.stringify({
      name: 'APIError',
      data: { message: 'Missing Authentication header', statusCode: 401, isRetryable: false },
    });
    const failure = classifyOpenCodeTurnFailure({ detail, ...CONTEXT });
    expect(failure.code).toBe('OPENCODE_AUTH_FAILED');
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain('credential');
  });

  it('keeps proxy policy rejections precise, never provider-auth', () => {
    const failure = classifyOpenCodeTurnFailure({
      detail: 'Model not allowed through this proxy.',
      ...CONTEXT,
    });
    expect(failure.code).not.toBe('OPENCODE_AUTH_FAILED');
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain('proxy');
  });

  it('leaves unknown failures as START_FAILED', () => {
    const failure = classifyOpenCodeTurnFailure({ detail: 'weird local failure', ...CONTEXT });
    expect(failure.code).toBe('OPENCODE_START_FAILED');
  });
});
