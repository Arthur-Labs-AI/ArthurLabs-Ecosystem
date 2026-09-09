/**
 * Pure state-transition helpers (no framework). Each entity exposes
 * canTransition* + assert*Transition; illegal moves raise
 * InvalidStateTransitionError.
 */
import type {
  AgentRunStatus,
  FixProposalStatus,
  QARunStatus,
  VerificationStatus,
} from '@qa/schemas';
import { InvalidStateTransitionError } from './errors.js';

const QA_RUN_TRANSITIONS: Readonly<Record<QARunStatus, readonly QARunStatus[]>> = {
  created: ['preflight', 'cancelled'],
  preflight: ['snapshotting', 'failed', 'cancelled'],
  snapshotting: ['baseline', 'failed', 'cancelled'],
  baseline: ['preparing', 'failed', 'cancelled'],
  preparing: ['agents_running', 'failed', 'cancelled'],
  agents_running: ['collecting', 'failed', 'cancelled'],
  collecting: ['normalizing', 'failed', 'cancelled'],
  normalizing: ['clustering', 'failed', 'cancelled'],
  clustering: ['verifying', 'failed', 'cancelled'],
  verifying: ['synthesizing', 'failed', 'cancelled'],
  synthesizing: ['completed', 'partial', 'failed', 'cancelled'],
  completed: [],
  partial: [],
  failed: [],
  cancelled: [],
};

const AGENT_RUN_TRANSITIONS: Readonly<Record<AgentRunStatus, readonly AgentRunStatus[]>> = {
  queued: ['starting', 'cancelled'],
  starting: ['running', 'failed', 'cancelled'],
  running: ['completed', 'failed', 'cancelled', 'timed_out'],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

const VERIFICATION_TRANSITIONS: Readonly<
  Record<VerificationStatus, readonly VerificationStatus[]>
> = {
  pending: ['running', 'cancelled'],
  running: ['verified', 'failed', 'inconclusive', 'cancelled'],
  verified: [],
  failed: [],
  inconclusive: [],
  cancelled: [],
};

const FIX_PROPOSAL_TRANSITIONS: Readonly<Record<FixProposalStatus, readonly FixProposalStatus[]>> =
  {
    proposed: ['validating', 'rejected'],
    validating: ['validated', 'validation_failed', 'conflict'],
    validated: ['applied', 'rejected'],
    validation_failed: ['validating', 'rejected'],
    conflict: ['validating', 'rejected'],
    applied: [],
    rejected: [],
  };

function makeHelpers<S extends string>(table: Readonly<Record<S, readonly S[]>>, entity: string) {
  return {
    canTransition(from: S, to: S): boolean {
      return table[from].includes(to);
    },
    assertTransition(from: S, to: S): void {
      if (!table[from].includes(to)) throw new InvalidStateTransitionError(from, to, entity);
    },
  };
}

const qa = makeHelpers(QA_RUN_TRANSITIONS, 'QARun');
export const canTransitionQARun = qa.canTransition;
export const assertQARunTransition = qa.assertTransition;
export const QARUN_TRANSITIONS = QA_RUN_TRANSITIONS;

const agent = makeHelpers(AGENT_RUN_TRANSITIONS, 'AgentRun');
export const canTransitionAgentRun = agent.canTransition;
export const assertAgentRunTransition = agent.assertTransition;
export const AGENT_RUN_TRANSITIONS_MAP = AGENT_RUN_TRANSITIONS;

const verification = makeHelpers(VERIFICATION_TRANSITIONS, 'VerificationAttempt');
export const canTransitionVerification = verification.canTransition;
export const assertVerificationTransition = verification.assertTransition;
export const VERIFICATION_TRANSITIONS_MAP = VERIFICATION_TRANSITIONS;

const fix = makeHelpers(FIX_PROPOSAL_TRANSITIONS, 'FixProposal');
export const canTransitionFixProposal = fix.canTransition;
export const assertFixProposalTransition = fix.assertTransition;
export const FIX_PROPOSAL_TRANSITIONS_MAP = FIX_PROPOSAL_TRANSITIONS;
