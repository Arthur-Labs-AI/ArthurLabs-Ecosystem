import { createHash } from 'node:crypto';
import {
  VERIFICATION_RECIPE_VERSION,
  VERIFIER_VERSION,
  type Evidence,
  type Finding,
  type VerificationRecipeStep,
  type VerificationStepType,
} from '@qa/schemas';
import { createVerificationStepId } from '@qa/shared';
import { recipeStepFingerprint } from './signatures.js';

/** Canonical operation record resolved from persisted harness events
 *  (`command.executed` / `test.result` by operationId). The service
 *  layer builds these; the recipe builder never touches prose. */
export interface CanonicalOperation {
  readonly operationId: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly testName?: string;
  readonly testStatus?: 'passed' | 'failed' | 'skipped';
  readonly suite?: string;
}

export interface RecipeInput {
  readonly snapshotId: string;
  readonly clusterId: string;
  readonly findings: readonly Finding[];
  readonly evidenceById: ReadonlyMap<string, Evidence>;
  readonly operationsById: ReadonlyMap<string, CanonicalOperation>;
  /** Original-output signatures by evidence ID (§22): sig2 fingerprints
   *  of canonical stdout/stderr artifacts, resolved by the service.
   *  Absent → no signature comparison is pretended. */
  readonly originalSignatures?: ReadonlyMap<string, string>;
}

export interface BuiltRecipe {
  readonly steps: VerificationRecipeStep[];
  readonly digest: string;
  readonly warnings: { code: string; message: string }[];
}

interface DraftStep {
  type: VerificationStepType;
  fingerprint: string;
  evidenceIds: string[];
  operationIds: string[];
  expected: Record<string, string>;
  nonExecutableInstructions: string[];
}

function draft(
  type: VerificationStepType,
  fingerprint: string,
  evidenceIds: readonly string[],
  operationIds: readonly string[],
  expected: Record<string, string>,
): DraftStep {
  return {
    type,
    fingerprint,
    evidenceIds: [...evidenceIds],
    operationIds: [...operationIds],
    expected,
    nonExecutableInstructions: [],
  };
}

/** Provenance priority (§49): operation evidence first (tests before
 *  plain commands), then source integrity, then unsupported claims.
 *  Priority orders the recipe only; it never decides the outcome. */
const STEP_PRIORITY: Record<VerificationStepType, number> = {
  test_replay: 0,
  command_replay: 1,
  source_integrity: 2,
  environment_check: 3,
  unsupported_claim: 4,
};

function mergeDraft(into: DraftStep, evidenceId: string, operationIds: readonly string[]): void {
  if (!into.evidenceIds.includes(evidenceId)) into.evidenceIds.push(evidenceId);
  for (const id of operationIds) if (!into.operationIds.includes(id)) into.operationIds.push(id);
}

export function buildRecipe(input: RecipeInput): BuiltRecipe {
  const warnings: { code: string; message: string }[] = [];
  const drafts = new Map<string, DraftStep>();
  const instructions = new Set<string>();
  for (const finding of input.findings) {
    for (const step of finding.reproductionSteps ?? []) {
      const trimmed = step.trim();
      if (trimmed.length > 0) instructions.add(trimmed.slice(0, 2000));
    }
  }
  const emit = (step: DraftStep): void => {
    const known = drafts.get(step.fingerprint);
    if (known === undefined) {
      drafts.set(step.fingerprint, step);
      return;
    }
    mergeDraft(known, step.evidenceIds[0] as string, step.operationIds);
    for (const extra of step.evidenceIds.slice(1)) mergeDraft(known, extra, []);
  };
  for (const finding of input.findings) {
    for (const evidenceId of finding.evidenceIds) {
      const evidence = input.evidenceById.get(evidenceId);
      if (evidence === undefined) {
        warnings.push({
          code: 'VERIFIER_EVIDENCE_MISSING',
          message: 'Finding ' + finding.id + ' references unknown evidence ' + evidenceId,
        });
        continue;
      }
      const grounded = evidence.groundingOperationIds.filter((id) => input.operationsById.has(id));
      const dangling = evidence.groundingOperationIds.filter((id) => !input.operationsById.has(id));
      for (const id of dangling) {
        // §97: missing/non-owned operation provenance is never fabricated.
        warnings.push({
          code: 'VERIFIER_OPERATION_UNRESOLVED',
          message: 'Evidence ' + evidence.id + ' references unresolvable operation ' + id,
        });
      }
      switch (evidence.type) {
        case 'command': {
          if (grounded.length === 0) {
            emit(
              draft(
                'unsupported_claim',
                recipeStepFingerprint({
                  type: 'unsupported_claim',
                  operationIds: [],
                  evidenceIds: [evidence.id],
                  path: 'command-without-operation',
                }),
                [evidence.id],
                [],
                { reason: 'command evidence without resolvable operation' },
              ),
            );
            break;
          }
          for (const opId of grounded) {
            const op = input.operationsById.get(opId);
            const command = op?.command ?? evidence.command.command;
            emit(
              draft(
                'command_replay',
                recipeStepFingerprint({
                  type: 'command_replay',
                  command,
                  operationIds: [opId],
                  evidenceIds: [evidence.id],
                }),
                [evidence.id],
                [opId],
                {
                  command,
                  ...(evidence.command.exitCode === undefined
                    ? {}
                    : { exitCode: String(evidence.command.exitCode) }),
                },
              ),
            );
          }
          break;
        }
        case 'test': {
          if (grounded.length === 0) {
            emit(
              draft(
                'unsupported_claim',
                recipeStepFingerprint({
                  type: 'unsupported_claim',
                  operationIds: [],
                  evidenceIds: [evidence.id],
                  path: 'test-without-operation',
                }),
                [evidence.id],
                [],
                { reason: 'test evidence without resolvable operation' },
              ),
            );
            break;
          }
          for (const opId of grounded) {
            const op = input.operationsById.get(opId);
            const label = op?.testName ?? evidence.test.name;
            emit(
              draft(
                'test_replay',
                recipeStepFingerprint({
                  type: 'test_replay',
                  command: op?.command ?? evidence.test.framework,
                  operationIds: [opId],
                  evidenceIds: [evidence.id],
                }),
                [evidence.id],
                [opId],
                {
                  testName: label,
                  testStatus: op?.testStatus ?? evidence.test.status,
                  ...(op?.command === undefined ? {} : { command: op.command }),
                  ...(op?.exitCode === undefined ? {} : { exitCode: String(op.exitCode) }),
                },
              ),
            );
          }
          break;
        }
        case 'code_reference': {
          const ref = evidence.codeReference;
          emit(
            draft(
              'source_integrity',
              recipeStepFingerprint({
                type: 'source_integrity',
                operationIds: [],
                evidenceIds: [evidence.id],
                path: ref.relativePath,
                lines: (ref.startLine ?? '') + '-' + (ref.endLine ?? ''),
              }),
              [evidence.id],
              [],
              {
                relativePath: ref.relativePath,
                ...(ref.startLine === undefined ? {} : { startLine: String(ref.startLine) }),
                ...(ref.endLine === undefined ? {} : { endLine: String(ref.endLine) }),
                ...(ref.contentHash === undefined ? {} : { contentHash: ref.contentHash }),
              },
            ),
          );
          break;
        }
        case 'runtime': {
          if (grounded.length === 0) {
            emit(
              draft(
                'unsupported_claim',
                recipeStepFingerprint({
                  type: 'unsupported_claim',
                  operationIds: [],
                  evidenceIds: [evidence.id],
                  path: 'runtime-without-operation',
                }),
                [evidence.id],
                [],
                { reason: 'runtime evidence without resolvable operation' },
              ),
            );
            break;
          }
          for (const opId of grounded) {
            const op = input.operationsById.get(opId);
            const command = op?.command ?? evidence.runtime.summary ?? '';
            emit(
              draft(
                'command_replay',
                recipeStepFingerprint({
                  type: 'command_replay',
                  command,
                  operationIds: [opId],
                  evidenceIds: [evidence.id],
                }),
                [evidence.id],
                [opId],
                {
                  command,
                  ...(evidence.runtime.exitCode === undefined
                    ? {}
                    : { exitCode: String(evidence.runtime.exitCode) }),
                },
              ),
            );
          }
          break;
        }
        default: {
          // log/browser/static_analysis/manual: no replay semantics in
          // v1 (§24, §90). Manual-only clusters therefore classify
          // inconclusive via the outcome rules, never reproduced.
          emit(
            draft(
              'unsupported_claim',
              recipeStepFingerprint({
                type: 'unsupported_claim',
                operationIds: [],
                evidenceIds: [evidence.id],
                path: 'unsupported-' + evidence.type,
              }),
              [evidence.id],
              [],
              { reason: evidence.type + ' evidence has no v1 replay semantics' },
            ),
          );
          break;
        }
      }
    }
  }
  const ordered = [...drafts.values()].sort((a, b) => {
    const priority = STEP_PRIORITY[a.type] - STEP_PRIORITY[b.type];
    if (priority !== 0) return priority;
    return a.fingerprint < b.fingerprint ? -1 : 1;
  });
  // Natural-language reproduction steps are context only (§31): carried
  // on the first recipe step, never converted into commands (§32).
  if (ordered.length > 0 && instructions.size > 0) {
    const first = ordered[0] as DraftStep;
    first.nonExecutableInstructions = [...instructions].sort();
  }
  const steps: VerificationRecipeStep[] = ordered.map((step) => {
    // Original-output signature (§22): resolved by the service from
    // canonical artifacts, attached when available. Absent → no
    // signature comparison is pretended downstream.
    const originalSignature =
      (step.type === 'command_replay' || step.type === 'test_replay') && step.evidenceIds.length > 0
        ? input.originalSignatures?.get(step.evidenceIds[0] as string)
        : undefined;
    return {
      id: createVerificationStepId(),
      type: step.type,
      recipeFingerprint: step.fingerprint,
      sourceEvidenceIds: [
        ...step.evidenceIds,
      ].sort() as VerificationRecipeStep['sourceEvidenceIds'],
      sourceOperationIds: [
        ...step.operationIds,
      ].sort() as VerificationRecipeStep['sourceOperationIds'],
      expected: {
        ...step.expected,
        ...(originalSignature === undefined ? {} : { originalSignature }),
      },
      nonExecutableInstructions: step.nonExecutableInstructions,
      status: 'queued' as const,
      observationIds: [],
    };
  });
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        verifierVersion: VERIFIER_VERSION,
        recipeVersion: VERIFICATION_RECIPE_VERSION,
        snapshotId: input.snapshotId,
        clusterId: input.clusterId,
        steps: steps.map((step) => ({
          fingerprint: step.recipeFingerprint,
          expected: step.expected,
        })),
      }),
      'utf8',
    )
    .digest('hex');
  return { steps, digest: 'sha256:' + digest, warnings };
}
