import { describe, expect, it } from 'vitest';
import {
  ContextBudget,
  estimatePromptTokens,
  isContextWindowExceeded,
} from '../src/context-budget.js';

describe('isContextWindowExceeded', () => {
  it('classifies the live DeepSeek provider failure', () => {
    expect(
      isContextWindowExceeded(
        new Error(
          "DeepSeek reporting failed: CONTEXT_WINDOW_EXCEEDED (HTTP 400). This model's maximum context length is 1048576 tokens. However, you requested 1072237 tokens (816237 in the messages, 256000 in the completion).",
        ),
      ),
    ).toBe(true);
  });

  it('classifies vendor phrasings across harnesses', () => {
    expect(isContextWindowExceeded(new Error('prompt is too long: 213462 tokens'))).toBe(true);
    expect(
      isContextWindowExceeded({ code: 'context_length_exceeded', message: 'bad request' }),
    ).toBe(true);
    expect(
      isContextWindowExceeded(
        new Error('outer', { cause: new Error('maximum context length hit') }),
      ),
    ).toBe(true);
  });

  it('does not classify ordinary failures', () => {
    expect(isContextWindowExceeded(new Error('provider request failed: HTTP 500'))).toBe(false);
    expect(isContextWindowExceeded(new Error('turn exceeded its budget'))).toBe(false);
    expect(isContextWindowExceeded(undefined)).toBe(false);
  });
});

describe('ContextBudget', () => {
  it('rotates at the safety ratio and resets for a fresh session', () => {
    const budget = new ContextBudget(1_000_000);
    budget.observeTurn({ inputTokens: 699_999 });
    expect(budget.shouldRotate()).toBe(false);
    budget.observeTurn({ inputTokens: 700_001 });
    expect(budget.shouldRotate()).toBe(true);
    budget.reset();
    expect(budget.peakTokens).toBe(0);
    expect(budget.shouldRotate()).toBe(false);
  });

  it('counts the next prompt against the remaining window', () => {
    const budget = new ContextBudget(1000);
    budget.observeTurn({ inputTokens: 650 });
    expect(budget.shouldRotate(40)).toBe(false);
    expect(budget.shouldRotate(100)).toBe(true);
  });

  it('falls back to prompt-size estimates when usage is unreported', () => {
    const budget = new ContextBudget(1000);
    budget.observePrompt('x'.repeat(2800));
    expect(budget.peakTokens).toBe(estimatePromptTokens('x'.repeat(2800)));
    expect(budget.shouldRotate()).toBe(true);
  });

  it('never rotates when the window is unknown (non-positive)', () => {
    const budget = new ContextBudget(0);
    budget.observeTurn({ inputTokens: 10_000_000 });
    expect(budget.shouldRotate()).toBe(false);
  });
});
