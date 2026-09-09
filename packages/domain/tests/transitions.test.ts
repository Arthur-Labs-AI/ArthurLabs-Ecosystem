import { describe, expect, it } from 'vitest';
import {
  assertAgentRunTransition,
  assertFixProposalTransition,
  assertQARunTransition,
  assertVerificationTransition,
  canTransitionAgentRun,
  canTransitionFixProposal,
  canTransitionQARun,
  canTransitionVerification,
  InvalidStateTransitionError,
} from '../src/index.js';

describe('state transitions', () => {
  it('qa: created -> preflight valid; completed -> agents_running invalid', () => {
    expect(canTransitionQARun('created', 'preflight')).toBe(true);
    expect(canTransitionQARun('agents_running', 'collecting')).toBe(true);
    expect(canTransitionQARun('completed', 'agents_running')).toBe(false);
    expect(canTransitionQARun('failed', 'completed')).toBe(false);
    expect(() => assertQARunTransition('completed', 'agents_running')).toThrow(
      InvalidStateTransitionError,
    );
  });
  it('qa: terminal states have no exits', () => {
    for (const s of ['completed', 'partial', 'failed', 'cancelled'] as const) {
      expect(() => assertQARunTransition(s, 'preflight')).toThrow(InvalidStateTransitionError);
    }
  });
  it('agent run transitions', () => {
    expect(canTransitionAgentRun('queued', 'starting')).toBe(true);
    expect(canTransitionAgentRun('running', 'timed_out')).toBe(true);
    expect(canTransitionAgentRun('completed', 'running')).toBe(false);
    expect(() => assertAgentRunTransition('failed', 'completed')).toThrow(
      InvalidStateTransitionError,
    );
  });
  it('verification transitions', () => {
    expect(canTransitionVerification('pending', 'running')).toBe(true);
    expect(canTransitionVerification('running', 'inconclusive')).toBe(true);
    expect(canTransitionVerification('verified', 'running')).toBe(false);
    expect(() => assertVerificationTransition('failed', 'verified')).toThrow(
      InvalidStateTransitionError,
    );
  });
  it('fix proposal transitions', () => {
    expect(canTransitionFixProposal('proposed', 'validating')).toBe(true);
    expect(canTransitionFixProposal('validating', 'conflict')).toBe(true);
    expect(canTransitionFixProposal('applied', 'rejected')).toBe(false);
    expect(() => assertFixProposalTransition('rejected', 'applied')).toThrow(
      InvalidStateTransitionError,
    );
  });
});
