import type { VerificationOutcome, VerificationRecipeStep } from '@qa/schemas';

/** Extension point for future verification strategies (§117). Phase 6
 *  implements ONLY the deterministic evidence-replay strategy; a
 *  model-assisted strategy must never be required for completion. */
export interface VerificationStrategy {
  readonly name: 'evidence-replay';
  classify(steps: readonly VerificationRecipeStep[]): VerificationOutcome;
}
