import { describe, expect, it } from 'vitest';
import {
  groundingOfEvidence,
  validateFindingTrust,
  isGroundedEvidence,
} from '../src/evidence-trust.js';

describe('generic evidence trust policy', () => {
  it('rejects findings with zero evidence', () => {
    expect(validateFindingTrust({ confidence: 'probable', evidenceIds: [] }, [])).toEqual({
      ok: false,
      reason: expect.stringContaining('no evidence'),
    });
  });

  it('rejects unknown evidence references', () => {
    expect(
      validateFindingTrust({ confidence: 'probable', evidenceIds: ['ev_missing' as never] }, []),
    ).toEqual({ ok: false, reason: expect.stringContaining('unknown') });
  });

  it('requires grounded evidence for confirmed findings', () => {
    const manual = {
      id: 'ev_1' as never,
      type: 'manual' as const,
      strength: 'agent_reasoning' as const,
      groundingOperationIds: [],
    };
    expect(
      validateFindingTrust({ confidence: 'confirmed', evidenceIds: ['ev_1' as never] }, [manual])
        .ok,
    ).toBe(false);
    // Provenance dominates strength: an op-grounded command supports
    // confirmed; the same label without durable operation IDs does not.
    const opIds = ['op_01K7777777777777777777A8W1' as never];
    const command = {
      id: 'ev_1' as never,
      type: 'command' as const,
      strength: 'tool_diagnostic' as const,
      groundingOperationIds: opIds,
    };
    expect(
      validateFindingTrust({ confidence: 'confirmed', evidenceIds: ['ev_1' as never] }, [command]),
    ).toEqual({ ok: true });
    const ungrounded = {
      id: 'ev_1' as never,
      type: 'command' as const,
      strength: 'tool_diagnostic' as const,
      groundingOperationIds: [],
    };
    expect(
      validateFindingTrust({ confidence: 'confirmed', evidenceIds: ['ev_1' as never] }, [
        ungrounded,
      ]).ok,
    ).toBe(false);
  });

  it('requires grounded evidence for strong findings but allows weaker probable ones', () => {
    const manual = {
      id: 'ev_1' as never,
      type: 'manual' as const,
      strength: 'agent_reasoning' as const,
      groundingOperationIds: [],
    };
    expect(
      validateFindingTrust({ confidence: 'strong', evidenceIds: ['ev_1' as never] }, [manual]).ok,
    ).toBe(false);
    expect(
      validateFindingTrust({ confidence: 'probable', evidenceIds: ['ev_1' as never] }, [manual]),
    ).toEqual({ ok: true });
    expect(
      validateFindingTrust({ confidence: 'speculative', evidenceIds: ['ev_1' as never] }, [manual]),
    ).toEqual({ ok: true });
  });

  it('grounds evidence from provenance, never from the strength label', () => {
    const opIds = ['op_01K7777777777777777777A8W1' as never];
    expect(
      isGroundedEvidence({
        type: 'code_reference',
        strength: 'agent_reasoning',
        groundingOperationIds: [],
      }),
    ).toBe(true);
    expect(
      isGroundedEvidence({
        type: 'test',
        strength: 'agent_reasoning',
        groundingOperationIds: opIds,
      }),
    ).toBe(true);
    expect(
      isGroundedEvidence({ type: 'test', strength: 'agent_reasoning', groundingOperationIds: [] }),
    ).toBe(false);
    expect(
      isGroundedEvidence({
        type: 'manual',
        strength: 'agent_reasoning',
        groundingOperationIds: [],
      }),
    ).toBe(false);
    expect(
      isGroundedEvidence({
        type: 'manual',
        strength: 'reproduced_behavior',
        groundingOperationIds: [],
      }),
    ).toBe(false);
  });

  it('accepts strong + code_reference and confirmed + reproduced command failure', () => {
    const code = {
      id: 'ev_1' as never,
      type: 'code_reference' as const,
      strength: 'strong_code_evidence' as const,
      groundingOperationIds: [],
    };
    expect(
      validateFindingTrust({ confidence: 'strong', evidenceIds: ['ev_1' as never] }, [code]),
    ).toEqual({ ok: true });
    const command = {
      id: 'ev_1' as never,
      type: 'command' as const,
      strength: 'reproduced_failure' as const,
      groundingOperationIds: ['op_01K7777777777777777777A8W1' as never],
    };
    expect(
      validateFindingTrust({ confidence: 'confirmed', evidenceIds: ['ev_1' as never] }, [command]),
    ).toEqual({ ok: true });
  });

  it('classifies grounding: reproduced, operation, source, model-reported', () => {
    const opIds = ['op_01K7777777777777777777A8W1' as never];
    expect(
      groundingOfEvidence({
        type: 'command',
        strength: 'reproduced_failure',
        groundingOperationIds: opIds,
      }),
    ).toBe('reproduced');
    expect(
      groundingOfEvidence({
        type: 'command',
        strength: 'tool_diagnostic',
        groundingOperationIds: opIds,
      }),
    ).toBe('operation_observed');
    expect(
      groundingOfEvidence({ type: 'test', strength: 'agent_reasoning', groundingOperationIds: [] }),
    ).toBe('model_reported');
    expect(
      groundingOfEvidence({
        type: 'code_reference',
        strength: 'agent_reasoning',
        groundingOperationIds: [],
      }),
    ).toBe('source_verified');
    expect(
      groundingOfEvidence({
        type: 'manual',
        strength: 'agent_reasoning',
        groundingOperationIds: [],
      }),
    ).toBe('model_reported');
    expect(
      groundingOfEvidence({
        type: 'runtime',
        strength: 'reproduced_behavior',
        groundingOperationIds: opIds,
      }),
    ).toBe('reproduced');
  });
});
