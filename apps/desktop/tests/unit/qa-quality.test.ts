import { describe, expect, it } from 'vitest';
import { coverageLabel, proofLabel } from '../../src/renderer/lib/qa-quality.js';
describe('QA proof and coverage labels', () => {
  it('never turns confidence or a code reference into behavioral proof', () => {
    expect(proofLabel([])).toBe('Unconfirmed');
    expect(proofLabel([{ type: 'code_reference', strength: 'reproduced_behavior' }])).toBe(
      'Source-supported',
    );
    expect(proofLabel([{ type: 'command', strength: 'strong_code_evidence' }])).toBe('Unconfirmed');
    expect(proofLabel([{ type: 'test', strength: 'reproduced_behavior' }])).toBe(
      'Behavior reproduced',
    );
  });
  it('keeps old runs unknown and process completion separate from coverage', () => {
    const marker = {
      type: 'agent.message',
      message: 'QA_DEPTH_V1: independent validation enabled.',
    };
    expect(coverageLabel([], 'completed')).toBe('Analysis coverage unknown');
    expect(coverageLabel([marker], 'completed')).toBe('Planned checks reported');
    expect(
      coverageLabel([marker, { type: 'warning', code: 'QA_COVERAGE_PARTIAL' }], 'completed'),
    ).toBe('Partial analysis');
  });
});
