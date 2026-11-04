import { describe, expect, it } from 'vitest';
import {
  assertAgentRunTransition,
  assertManagedProjectCopyTransition,
  assertQARunTransition,
  canTransitionAgentRun,
  canTransitionManagedProjectCopy,
  canTransitionQARun,
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
    expect(canTransitionAgentRun('starting', 'planning')).toBe(true);
    expect(canTransitionAgentRun('planning', 'running')).toBe(true);
    expect(canTransitionAgentRun('starting', 'interrupted')).toBe(true);
    expect(canTransitionAgentRun('running', 'interrupted')).toBe(true);
    expect(canTransitionAgentRun('running', 'timed_out')).toBe(true);
    expect(canTransitionAgentRun('completed', 'running')).toBe(false);
    expect(() => assertAgentRunTransition('failed', 'completed')).toThrow(
      InvalidStateTransitionError,
    );
  });
  it('managed project copy transitions preserve run locking', () => {
    expect(canTransitionManagedProjectCopy('ready', 'updating')).toBe(true);
    expect(canTransitionManagedProjectCopy('ready', 'locked_for_run')).toBe(true);
    expect(canTransitionManagedProjectCopy('locked_for_run', 'ready')).toBe(true);
    expect(canTransitionManagedProjectCopy('locked_for_run', 'updating')).toBe(false);
    expect(canTransitionManagedProjectCopy('error', 'ready')).toBe(true);
    expect(() => assertManagedProjectCopyTransition('updating', 'locked_for_run')).toThrow(
      InvalidStateTransitionError,
    );
  });
});
