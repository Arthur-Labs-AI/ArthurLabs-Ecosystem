import type { Evidence, EvidenceStrength, EvidenceType, Finding } from '@qa/schemas';

export type EvidenceGrounding =
  'model_reported' | 'source_verified' | 'operation_observed' | 'reproduced';

const REPRODUCED_STRENGTHS: ReadonlySet<EvidenceStrength> = new Set([
  'reproduced_failure',
  'reproduced_behavior',
]);

const OPERATION_STRENGTHS: ReadonlySet<EvidenceStrength> = new Set([
  'reproduced_failure',
  'reproduced_behavior',
  'tool_diagnostic',
]);

const SOURCE_TYPES: ReadonlySet<EvidenceType> = new Set([
  'code_reference',
  'static_analysis',
  'browser',
]);

const OPERATION_TYPES: ReadonlySet<EvidenceType> = new Set(['command', 'test']);

export function groundingOfEvidence(
  evidence: Pick<Evidence, 'type' | 'strength'>,
): EvidenceGrounding {
  if (REPRODUCED_STRENGTHS.has(evidence.strength as EvidenceStrength)) return 'reproduced';
  if (
    OPERATION_STRENGTHS.has(evidence.strength as EvidenceStrength) ||
    OPERATION_TYPES.has(evidence.type as EvidenceType)
  )
    return 'operation_observed';
  if (SOURCE_TYPES.has(evidence.type as EvidenceType)) return 'source_verified';
  return 'model_reported';
}

export function isGroundedEvidence(evidence: Pick<Evidence, 'type' | 'strength'>): boolean {
  return groundingOfEvidence(evidence) !== 'model_reported';
}

export type FindingTrustVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function validateFindingTrust(
  finding: Pick<Finding, 'confidence' | 'evidenceIds'>,
  evidence: ReadonlyArray<Pick<Evidence, 'id' | 'type' | 'strength'>>,
): FindingTrustVerdict {
  if (finding.evidenceIds.length === 0) {
    return { ok: false, reason: 'Finding has no evidence references' };
  }
  const byId = new Map(evidence.map((item) => [item.id, item]));
  for (const id of finding.evidenceIds) {
    if (!byId.has(id)) return { ok: false, reason: 'Finding references unknown evidence: ' + id };
  }
  const items = finding.evidenceIds.map((id) => byId.get(id)) as Array<
    Pick<Evidence, 'id' | 'type' | 'strength'>
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
