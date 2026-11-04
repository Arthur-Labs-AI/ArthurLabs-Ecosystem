import { describe, expect, it } from 'vitest';
import { sanitizeRpcValue } from '../src/runtime.js';

// Regression: the RPC redactor replaced the whole run-status `tokens` usage
// object with '[REDACTED]' (the key contains TOKEN), which broke every
// strict consumer of runs.status, including sentry cli run status/result.
// Secret strings are still redacted; only non-string leaves pass through.
describe('runtime RPC redaction', () => {
  it('preserves token usage counters while redacting secret strings', () => {
    const status = sanitizeRpcValue({
      runId: 'run_01K7777777777777777777A8W3',
      status: 'completed',
      agents: { configured: 1 },
      findings: { total: 4 },
      tokens: { inputTokens: 303, outputTokens: 120, totalTokens: 423, turns: 6 },
    });
    expect(status).toMatchObject({
      runId: 'run_01K7777777777777777777A8W3',
      tokens: { inputTokens: 303, outputTokens: 120, totalTokens: 423, turns: 6 },
    });
  });

  it('redacts credential strings under secret-shaped keys, nested or not', () => {
    expect(sanitizeRpcValue({ deepseekApiKey: 'sk-live-secret' })).toEqual({
      deepseekApiKey: '[REDACTED]',
    });
    expect(sanitizeRpcValue({ providers: { openRouterApiKey: 'sk-x', count: 3 } })).toEqual({
      providers: { openRouterApiKey: '[REDACTED]', count: 3 },
    });
    expect(sanitizeRpcValue({ items: [{ authToken: 't' }, { n: 1 }] })).toEqual({
      items: [{ authToken: '[REDACTED]' }, { n: 1 }],
    });
  });

  it('scrubs embedded credential assignments in free text', () => {
    expect(sanitizeRpcValue({ note: 'failed; DEEPSEEK_API_KEY=hunter2 ok' })).toEqual({
      note: 'failed; DEEPSEEK_API_KEY=[REDACTED] ok',
    });
  });
});
