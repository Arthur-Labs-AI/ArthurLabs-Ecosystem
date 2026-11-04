import { describe, expect, it } from 'vitest';
import { groundingOfEvidence, validateFindingTrust } from '../src/evidence-trust.js';

const opIds = ['op_01K7777777777777777777A8W1' as never];

describe('provenance dominates strength', () => {
  it('manual + reproduced_behavior is NOT reproduced provenance', () => {
    expect(
      groundingOfEvidence({
        type: 'manual',
        strength: 'reproduced_behavior',
        groundingOperationIds: [],
      }),
    ).toBe('model_reported');
  });

  it('manual + reproduced_failure is NOT reproduced provenance', () => {
    expect(
      groundingOfEvidence({
        type: 'manual',
        strength: 'reproduced_failure',
        groundingOperationIds: [],
      }),
    ).toBe('model_reported');
  });

  it('code_reference + reproduced_failure is source_verified, never reproduced from label', () => {
    expect(
      groundingOfEvidence({
        type: 'code_reference',
        strength: 'reproduced_failure',
        groundingOperationIds: [],
      }),
    ).toBe('source_verified');
  });

  it('operation-backed reproduced evidence with durable IDs is reproduced', () => {
    expect(
      groundingOfEvidence({
        type: 'command',
        strength: 'reproduced_failure',
        groundingOperationIds: opIds,
      }),
    ).toBe('reproduced');
    expect(
      groundingOfEvidence({
        type: 'test',
        strength: 'reproduced_behavior',
        groundingOperationIds: opIds,
      }),
    ).toBe('reproduced');
  });

  it('command/test without durable operation IDs is model_reported even with strong labels', () => {
    expect(
      groundingOfEvidence({
        type: 'command',
        strength: 'tool_diagnostic',
        groundingOperationIds: [],
      }),
    ).toBe('model_reported');
    expect(
      groundingOfEvidence({
        type: 'test',
        strength: 'reproduced_failure',
        groundingOperationIds: [],
      }),
    ).toBe('model_reported');
  });

  it('operation_observed needs durable IDs plus non-reproduced grounding', () => {
    expect(
      groundingOfEvidence({
        type: 'command',
        strength: 'tool_diagnostic',
        groundingOperationIds: opIds,
      }),
    ).toBe('operation_observed');
  });

  it('manual reasoning alone cannot support confirmed', () => {
    const manual = {
      id: 'ev_1' as never,
      type: 'manual' as const,
      strength: 'reproduced_behavior' as const,
      groundingOperationIds: [],
    };
    expect(
      validateFindingTrust({ confidence: 'confirmed', evidenceIds: ['ev_1' as never] }, [manual])
        .ok,
    ).toBe(false);
  });
});
