import type { Evidence, EvidenceStrength, EvidenceType, Finding } from '@qa/schemas';

export type EvidenceGrounding =
  'model_reported' | 'source_verified' | 'operation_observed' | 'reproduced';

const REPRODUCED_STRENGTHS: ReadonlySet<EvidenceStrength> = new Set([
  'reproduced_failure',
  'reproduced_behavior',
]);

const SOURCE_TYPES: ReadonlySet<EvidenceType> = new Set([
  'code_reference',
  'static_analysis',
  'browser',
]);

/** Provenance is what Sentry verified — never the model-selected label.
 *  Manual reasoning is always model_reported; validated source types are
 *  source_verified; command/test/runtime/log need durable canonical
 *  operation IDs for operation_observed, plus a reproduced strength the
 *  pipeline already vetted for reproduced. A strength label alone
 *  manufactures nothing. */
export function groundingOfEvidence(
  evidence: Pick<Evidence, 'type' | 'strength' | 'groundingOperationIds'>,
): EvidenceGrounding {
  if (evidence.type === 'manual') return 'model_reported';
  if (SOURCE_TYPES.has(evidence.type as EvidenceType)) return 'source_verified';
  const operationGrounded = (evidence.groundingOperationIds?.length ?? 0) > 0;
  if (!operationGrounded) return 'model_reported';
  if (REPRODUCED_STRENGTHS.has(evidence.strength as EvidenceStrength)) return 'reproduced';
  return 'operation_observed';
}

export function isGroundedEvidence(
  evidence: Pick<Evidence, 'type' | 'strength' | 'groundingOperationIds'>,
): boolean {
  return groundingOfEvidence(evidence) !== 'model_reported';
}

export type FindingTrustVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function validateFindingTrust(
  finding: Pick<Finding, 'confidence' | 'evidenceIds'>,
  evidence: ReadonlyArray<Pick<Evidence, 'id' | 'type' | 'strength' | 'groundingOperationIds'>>,
): FindingTrustVerdict {
  if (finding.evidenceIds.length === 0) {
    return { ok: false, reason: 'Finding has no evidence references' };
  }
  const byId = new Map(evidence.map((item) => [item.id, item]));
  for (const id of finding.evidenceIds) {
    if (!byId.has(id)) return { ok: false, reason: 'Finding references unknown evidence: ' + id };
  }
  const items = finding.evidenceIds.map((id) => byId.get(id)) as Array<
    Pick<Evidence, 'id' | 'type' | 'strength' | 'groundingOperationIds'>
  >;
  const groundings = items.map(groundingOfEvidence);
  if (finding.confidence === 'confirmed') {
    const ok = groundings.some(
      (grounding) => grounding === 'reproduced' || grounding === 'operation_observed',
    );
    if (!ok) {
      return {
        ok: false,
        reason:
          'Confirmed findings require reproduced or directly correlated operation evidence; manual/model reasoning alone is insufficient',
      };
    }
    return { ok: true };
  }
  if (finding.confidence === 'strong') {
    if (!groundings.some((grounding) => grounding !== 'model_reported')) {
      return {
        ok: false,
        reason: 'Strong findings require grounded source/tool evidence',
      };
    }
    return { ok: true };
  }
  return { ok: true };
}
