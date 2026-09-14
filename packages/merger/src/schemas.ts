/** Canonical merge boundary schemas live in `@qa/schemas` (see
 *  `merge.schema.ts`); this module re-exports them alongside the
 *  algorithm-owned version constants for merger consumers. */
export {
  AgreementStateSchema,
  FieldDisagreementSchema,
  FindingClusterSchema,
  MERGER_VERSION,
  MergeResultSchema,
  NORMALIZER_VERSION,
  type AgreementState,
  type FieldDisagreement,
  type FindingCluster,
  type MergeResult,
} from '@qa/schemas';
