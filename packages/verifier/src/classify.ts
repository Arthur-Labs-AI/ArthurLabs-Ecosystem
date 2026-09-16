import type {
  VerificationAssertion,
  VerificationAssertionState,
  VerificationOutcome,
  VerificationRecipeStep,
  VerificationStepOutcome,
} from '@qa/schemas';
import type { EvidenceId, VerificationObservationId } from '@qa/shared';

/** Step outcomes that terminate evaluation (no observation pending). */
function isTerminal(outcome: VerificationStepOutcome | undefined): boolean {
  return outcome === 'matched' || outcome === 'mismatched';
}

/** A decisive step independently reproduces runtime behavior:
 *  command/test replay, outcome matched, STRONG identity (§21),
 *  fresh observation present. Weak matches (exit-only, unconfirmed
 *  identity) are never decisive. Source integrity alone is NEVER
 *  decisive (§28, §89). */
function isDecisive(step: VerificationRecipeStep): boolean {
  return (
    (step.type === 'command_replay' || step.type === 'test_replay') &&
    step.outcome === 'matched' &&
    step.matchStrength === 'strong_match' &&
    step.observationIds.length > 0
  );
}

export interface ClassifiedAttempt {
  readonly outcome: VerificationOutcome;
  readonly assertions: Omit<VerificationAssertion, 'schemaVersion' | 'verificationAttemptId'>[];
}

/** Deterministic outcome derivation (§46-47):
 *
 * - reproduced: ≥1 decisive independent reproduction, no required
 *   contradiction. Agreement count plays no role (§5).
 * - partially_verified: meaningful matched checks (incl. source-only
 *   integrity, §89) but no decisive reproduction.
 * - not_reproducible: ≥1 decisive-class replay step, ALL such steps
 *   terminally evaluated, none matched, no errors/blocks/unsupported
 *   anywhere (compatible environment executed the recipe and the bug
 *   signature was absent, §23).
 * - inconclusive: everything else — no replayable steps, errors,
 *   blocks, unsupported claims, or environment/tool failures (§24).
 */
export function classifyAttempt(steps: readonly VerificationRecipeStep[]): ClassifiedAttempt {
  const decisive = steps.filter(
    (step) => step.type === 'command_replay' || step.type === 'test_replay',
  );
  const matched = steps.filter((step) => step.outcome === 'matched');
  const mismatched = steps.filter((step) => step.outcome === 'mismatched');
  const unresolved = steps.filter(
    (step) =>
      step.outcome === undefined ||
      step.outcome === 'blocked' ||
      step.outcome === 'error' ||
      step.outcome === 'unsupported',
  );
  const hasDecisiveReproduction = steps.some(isDecisive);
  const decisiveTerminal = decisive.filter((step) => isTerminal(step.outcome));
  let outcome: VerificationOutcome;
  if (hasDecisiveReproduction && mismatched.length === 0) {
    outcome = 'reproduced';
  } else if (
    decisive.length > 0 &&
    decisiveTerminal.length === decisive.length &&
    decisive.every((step) => step.outcome === 'mismatched') &&
    unresolved.length === 0
  ) {
    outcome = 'not_reproducible';
  } else if (matched.length > 0) {
    outcome = 'partially_verified';
  } else {
    outcome = 'inconclusive';
  }
  return { outcome, assertions: deriveAssertions(steps, outcome) };
}

/** Assertion derivation (§53-54): behavior/location/runtime dimensions
 *  stay separate. Root cause is ALWAYS inconclusive in v1 — the
 *  verifier reproduces behavior, never adjudicates disputed causes.
 *  Agreement never appears in any assertion (§5). */
function deriveAssertions(
  steps: readonly VerificationRecipeStep[],
  outcome: VerificationOutcome,
): ClassifiedAttempt['assertions'] {
  const assertions: ClassifiedAttempt['assertions'] = [];
  const byType = (type: VerificationRecipeStep['type']) => steps.filter((s) => s.type === type);
  const integrity = byType('source_integrity');
  const commands = byType('command_replay');
  const tests = byType('test_replay');
  const stateOf = (relevant: readonly VerificationRecipeStep[]): VerificationAssertionState => {
    if (relevant.some((s) => s.outcome === 'matched')) return 'confirmed';
    if (
      relevant.length > 0 &&
      relevant.every((s) => s.outcome === 'mismatched') &&
      outcome === 'not_reproducible'
    ) {
      return 'contradicted';
    }
    return 'inconclusive';
  };
  if (integrity.length > 0) {
    assertions.push({
      subject: 'source_location',
      state: stateOf(integrity),
      detail: describeCount(integrity, 'source integrity check'),
      sourceEvidenceIds: collectEvidence(integrity),
      observationIds: collectObservations(integrity),
    });
  }
  if (commands.length > 0) {
    assertions.push({
      subject: 'command_failure',
      state: stateOf(commands),
      detail: describeCount(commands, 'command replay'),
      sourceEvidenceIds: collectEvidence(commands),
      observationIds: collectObservations(commands),
    });
  }
  if (tests.length > 0) {
    assertions.push({
      subject: 'test_failure',
      state: stateOf(tests),
      detail: describeCount(tests, 'test replay'),
      sourceEvidenceIds: collectEvidence(tests),
      observationIds: collectObservations(tests),
    });
  }
  assertions.push({
    subject: 'behavior',
    state:
      outcome === 'reproduced'
        ? 'confirmed'
        : outcome === 'not_reproducible'
          ? 'contradicted'
          : 'inconclusive',
    detail:
      outcome === 'reproduced'
        ? 'Independent fresh-workspace observation reproduced the claimed behavior.'
        : outcome === 'not_reproducible'
          ? 'Compatible replay executed without the claimed behavior.'
          : 'No independent behavior observation supports or refutes the claim.',
    sourceEvidenceIds: collectEvidence(steps),
    observationIds: collectObservations(steps),
  });
  assertions.push({
    subject: 'root_cause',
    state: 'inconclusive',
    detail: 'Phase 6 v1 reproduces behavior only; disputed root causes are never adjudicated.',
    sourceEvidenceIds: [],
    observationIds: [],
  });
  return assertions;
}

function describeCount(steps: readonly VerificationRecipeStep[], label: string): string {
  const matched = steps.filter((s) => s.outcome === 'matched').length;
  return matched + '/' + steps.length + ' ' + label + (steps.length === 1 ? '' : 's') + ' matched.';
}

function collectEvidence(steps: readonly VerificationRecipeStep[]): EvidenceId[] {
  return [...new Set(steps.flatMap((s) => s.sourceEvidenceIds))].sort() as EvidenceId[];
}

function collectObservations(
  steps: readonly VerificationRecipeStep[],
): VerificationObservationId[] {
  return [...new Set(steps.flatMap((s) => s.observationIds))].sort() as VerificationObservationId[];
}
