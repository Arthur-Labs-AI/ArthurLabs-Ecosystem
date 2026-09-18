/** Phase 7 deterministic retest classifier (§18–§22, §27).
 *
 *  Inputs: canonical new evidence from the target revision plus
 *  cross-revision replay/verification observations. Agent consensus alone
 *  NEVER decides (§27): `3/3 say fixed → fixed` is wrong; the verdict must
 *  be grounded in fresh canonical evidence.
 *
 *  - fixed: STRONG active evidence the target behavior no longer occurs
 *    (same target test previously failed, now passes; same deterministic
 *    reproduction no longer reproduces; expected failure signature absent
 *    under compatible replay). Absence of a finding is NOT proof (§19).
 *  - still_reproducible: STRONG observation of the same issue identity on
 *    revision B, grounded in new canonical Evidence/operations (§20).
 *  - partially_fixed: multiple meaningful assertions, only some corrected
 *    (crash fixed but corruption remains; one path passes, another
 *    reproduces). Never collapse into fixed (§21).
 *  - inconclusive: missing runtime/sandbox/service, target test not
 *    observed, evidence cannot safely replay, or decisive evidence is
 *    absent — including agent disagreement without decisive evidence.
 *    Never manufacture a fix verdict (§22).
 */
import type { RetestState } from '@qa/schemas';

export interface RetestAssertionEvidence {
  /** Stable identity of one meaningful assertion within the issue. */
  readonly assertionId: string;
  /** True when fresh canonical evidence shows the assertion still fails on B. */
  readonly reproducesOnTarget: boolean;
  /** True when fresh canonical evidence shows the assertion now passes on B. */
  readonly passesOnTarget: boolean;
}

export interface RetestClassifierInput {
  /** Per-assertion fresh evidence from the target revision. */
  readonly assertions: readonly RetestAssertionEvidence[];
  /** True when the environment could not run the target (missing
   *  runtime, sandbox unavailable, external service down, target test
   *  absent, evidence not safely replayable). Forces inconclusive. */
  readonly targetNotObservable: boolean;
}

export interface RetestClassification {
  readonly result: RetestState;
  readonly rationale: string;
}

export function classifyRetest(input: RetestClassifierInput): RetestClassification {
  if (input.targetNotObservable) {
    return {
      result: 'inconclusive',
      rationale:
        'Target behavior could not be observed on the target revision; no fix verdict is safe.',
    };
  }
  if (input.assertions.length === 0) {
    return {
      result: 'inconclusive',
      rationale:
        'No fresh canonical evidence for any issue assertion; agent silence is not proof of a fix.',
    };
  }
  let reproduced = 0;
  let passed = 0;
  let unknown = 0;
  for (const assertion of input.assertions) {
    if (assertion.reproducesOnTarget) reproduced += 1;
    else if (assertion.passesOnTarget) passed += 1;
    else unknown += 1;
  }
  if (unknown > 0) {
    return {
      result: 'inconclusive',
      rationale:
        unknown +
        ' of ' +
        input.assertions.length +
        ' assertions lack decisive fresh evidence; no fix verdict is safe.',
    };
  }
  if (reproduced > 0 && passed > 0) {
    return {
      result: 'partially_fixed',
      rationale:
        passed +
        ' of ' +
        input.assertions.length +
        ' assertions now pass on the target revision while ' +
        reproduced +
        ' still reproduce.',
    };
  }
  if (reproduced > 0) {
    return {
      result: 'still_reproducible',
      rationale:
        'Fresh canonical evidence shows the target behavior still reproduces on the target revision (' +
        reproduced +
        ' of ' +
        input.assertions.length +
        ' assertions).',
    };
  }
  return {
    result: 'fixed',
    rationale:
      'Strong active evidence: all ' +
      input.assertions.length +
      ' assertions previously failing now pass under compatible replay on the target revision.',
  };
}

/** Cross-revision replay-step comparison (§23–§27, §84–§87).
 *
 *  Compares BEHAVIOR, not match direction: a target step whose expected
 *  record shows the same failure signature the source step confirmed is
 *  still_reproducible evidence; a target step whose expected record shows
 *  healthy behavior where the source confirmed failure is fixed evidence.
 *  Only `command_replay` and `test_replay` steps carry behavioral signal;
 *  `source_integrity` (content trivially changes after any fix) and
 *  `unsupported_claim` steps are excluded. Keys are exact ID-free replay
 *  intent — never fuzzy, never model-judged (§32, §68).
 */
export interface RetestReplayStep {
  readonly type: string;
  readonly expected: Readonly<Record<string, string>>;
  /** 'matched' = observation confirmed the expected record. */
  readonly outcome?: string | undefined;
  readonly matchStrength?: string | undefined;
}

export function retestStepKey(
  step: Pick<RetestReplayStep, 'type' | 'expected'>,
): string | undefined {
  if (step.type === 'command_replay') {
    const command = (step.expected['command'] ?? '').trim();
    if (command.length === 0) return undefined;
    return 'cmd|' + command + '|' + (step.expected['cwdRelative'] ?? '.').trim();
  }
  if (step.type === 'test_replay') {
    const testName = (step.expected['testName'] ?? '').trim();
    if (testName.length === 0) return undefined;
    const command = (step.expected['command'] ?? '').trim();
    return 'test|' + testName + (command.length === 0 ? '' : '|' + command);
  }
  return undefined;
}

function stepShowsFailure(expected: Readonly<Record<string, string>>): boolean {
  const exitCode = Number(expected['exitCode']);
  if (Number.isSafeInteger(exitCode) && exitCode !== 0) return true;
  return (expected['testStatus'] ?? '') === 'failed';
}

function stepShowsHealthy(expected: Readonly<Record<string, string>>): boolean {
  const exitCode = Number(expected['exitCode']);
  if (Number.isSafeInteger(exitCode)) return exitCode === 0;
  const status = expected['testStatus'] ?? '';
  if (status === 'passed') return true;
  return false;
}

function failureSignature(expected: Readonly<Record<string, string>>): string {
  return 'exit=' + (expected['exitCode'] ?? '') + ';test=' + (expected['testStatus'] ?? '');
}

export interface RetestComparison {
  readonly input: RetestClassifierInput;
  readonly limitations: string[];
  /** Source keys that confirmed failure on A (the baseline). */
  readonly baselineKeys: string[];
}

/** Build classifier input from source (revision A) and target (revision B)
 *  replay steps. Source steps must be strong confirmed observations
 *  (`matched` + `strong_match`); anything weaker carries no baseline
 *  signal and is reported as a limitation, never as proof. */
export function compareRetestSteps(input: {
  readonly sourceSteps: readonly RetestReplayStep[];
  readonly targetSteps: readonly RetestReplayStep[];
}): RetestComparison {
  const limitations: string[] = [];
  const baseline = new Map<string, Readonly<Record<string, string>>>();
  for (const step of input.sourceSteps) {
    const key = retestStepKey(step);
    if (key === undefined) continue;
    if (step.outcome === 'matched' && step.matchStrength === 'strong_match') {
      if (!baseline.has(key)) baseline.set(key, step.expected);
    } else {
      limitations.push(
        'Source assertion ' +
          key +
          ' has no strong confirmed observation on revision A; excluded from baseline.',
      );
    }
  }
  const failingBaseline = new Map<string, Readonly<Record<string, string>>>();
  for (const [key, expected] of baseline) {
    if (stepShowsFailure(expected)) failingBaseline.set(key, expected);
  }
  const targetByKey = new Map<string, RetestReplayStep>();
  for (const step of input.targetSteps) {
    const key = retestStepKey(step);
    if (key === undefined) continue;
    if (!targetByKey.has(key)) targetByKey.set(key, step);
  }
  const assertions: RetestAssertionEvidence[] = [];
  if (failingBaseline.size === 0) {
    limitations.push(
      'No confirmed failure baseline on revision A; absence of target failure is not proof of a fix.',
    );
    return {
      input: { assertions, targetNotObservable: false },
      limitations,
      baselineKeys: [],
    };
  }
  for (const [key, sourceExpected] of failingBaseline) {
    const target = targetByKey.get(key);
    if (target === undefined) {
      limitations.push('Target replay for ' + key + ' was not observed on revision B.');
      assertions.push({ assertionId: key, reproducesOnTarget: false, passesOnTarget: false });
      continue;
    }
    const strongTarget = target.outcome === 'matched' && target.matchStrength === 'strong_match';
    if (!strongTarget) {
      limitations.push(
        'Target replay for ' + key + ' lacks a strong confirmed observation on revision B.',
      );
      assertions.push({ assertionId: key, reproducesOnTarget: false, passesOnTarget: false });
      continue;
    }
    if (stepShowsFailure(target.expected)) {
      if (failureSignature(target.expected) === failureSignature(sourceExpected)) {
        assertions.push({ assertionId: key, reproducesOnTarget: true, passesOnTarget: false });
      } else {
        // Closure §54-§55 (conservative): the same target still fails for
        // a materially different reason. The original signature is absent
        // but target behavior is unhealthy, so this is NOT fully fixed.
        // Record it as an indecisive observation so the classifier yields
        // inconclusive (never fixed); a human may refine to partially_fixed
        // when additional assertions show genuine partial correction.
        limitations.push(
          'Target replay for ' +
            key +
            ' still fails on revision B with a different signature: ' +
            failureSignature(target.expected) +
            ' (was ' +
            failureSignature(sourceExpected) +
            '). Original signature absent but target unhealthy; not fixed.',
        );
        assertions.push({ assertionId: key, reproducesOnTarget: false, passesOnTarget: false });
      }
      continue;
    }
    if (stepShowsHealthy(target.expected)) {
      assertions.push({ assertionId: key, reproducesOnTarget: false, passesOnTarget: true });
      continue;
    }
    limitations.push('Target replay for ' + key + ' has an indecisive observation on revision B.');
    assertions.push({ assertionId: key, reproducesOnTarget: false, passesOnTarget: false });
  }
  return {
    input: { assertions, targetNotObservable: false },
    limitations,
    baselineKeys: [...failingBaseline.keys()],
  };
}
