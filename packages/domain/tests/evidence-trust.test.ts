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
    };
    expect(
      validateFindingTrust({ confidence: 'confirmed', evidenceIds: ['ev_1' as never] }, [manual])
        .ok,
    ).toBe(false);
    const command = {
      id: 'ev_1' as never,
      type: 'command' as const,
      strength: 'tool_diagnostic' as const,
    };
    expect(
      validateFindingTrust({ confidence: 'confirmed', evidenceIds: ['ev_1' as never] }, [command]),
    ).toEqual({ ok: true });
  });

  it('requires grounded evidence for strong findings but allows weaker probable ones', () => {
    const manual = {
      id: 'ev_1' as never,
      type: 'manual' as const,
      strength: 'agent_reasoning' as const,
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

  it('treats tool-grounded types as grounded regardless of label', () => {
    expect(isGroundedEvidence({ type: 'code_reference', strength: 'agent_reasoning' })).toBe(true);
    expect(isGroundedEvidence({ type: 'test', strength: 'agent_reasoning' })).toBe(true);
    expect(isGroundedEvidence({ type: 'manual', strength: 'agent_reasoning' })).toBe(false);
    expect(isGroundedEvidence({ type: 'manual', strength: 'reproduced_behavior' })).toBe(true);
  });

  it('accepts strong + code_reference and confirmed + reproduced command failure', () => {
    const code = {
      id: 'ev_1' as never,
      type: 'code_reference' as const,
      strength: 'strong_code_evidence' as const,
    };
    expect(
      validateFindingTrust({ confidence: 'strong', evidenceIds: ['ev_1' as never] }, [code]),
    ).toEqual({ ok: true });
    const command = {
      id: 'ev_1' as never,
      type: 'command' as const,
      strength: 'reproduced_failure' as const,
    };
    expect(
      validateFindingTrust({ confidence: 'confirmed', evidenceIds: ['ev_1' as never] }, [command]),
    ).toEqual({ ok: true });
  });

  it('classifies grounding: reproduced, operation, source, model-reported', () => {
    expect(groundingOfEvidence({ type: 'command', strength: 'reproduced_failure' })).toBe(
      'reproduced',
    );
    expect(groundingOfEvidence({ type: 'command', strength: 'tool_diagnostic' })).toBe(
      'operation_observed',
    );
    expect(groundingOfEvidence({ type: 'test', strength: 'agent_reasoning' })).toBe(
      'operation_observed',
    );
    expect(groundingOfEvidence({ type: 'code_reference', strength: 'agent_reasoning' })).toBe(
      'source_verified',
    );
    expect(groundingOfEvidence({ type: 'manual', strength: 'agent_reasoning' })).toBe(
      'model_reported',
    );
    expect(groundingOfEvidence({ type: 'runtime', strength: 'reproduced_behavior' })).toBe(
      'reproduced',
    );
  });
});
