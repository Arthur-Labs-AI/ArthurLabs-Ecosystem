/**
 * Generic evidence-trust policy (Phase 3.1). Agent-neutral: usable by Muse,
 * DeepSeek, GLM, and future agents. Vendor-specific tool correlation stays in
 * the owning harness adapter; these rules speak only the shared Evidence /
 * Finding vocabulary.
 *
 * Guardrails (not a scoring engine):
 * - every durable finding must reference at least one durable evidence item
 * - confirmed requires at least one strongly grounded/reproduced item
 * - strong requires grounded source/tool evidence
 * - probable may include weaker evidence but stays evidence-backed
 * - speculative may rely heavily on reasoning/manual evidence
 */
import type { Evidence, EvidenceStrength, EvidenceType, Finding } from '@qa/schemas';

const GROUNDED_STRENGTHS: ReadonlySet<EvidenceStrength> = new Set([
  'reproduced_failure',
  'reproduced_behavior',
  'tool_diagnostic',
  'strong_code_evidence',
]);

const GROUNDED_TYPES: ReadonlySet<EvidenceType> = new Set([
  'command',
  'code_reference',
  'test',
  'static_analysis',
  'browser',
]);

export function isGroundedEvidence(evidence: Pick<Evidence, 'type' | 'strength'>): boolean {
  if (GROUNDED_STRENGTHS.has(evidence.strength as EvidenceStrength)) return true;
  return GROUNDED_TYPES.has(evidence.type as EvidenceType);
}

export type FindingTrustVerdict =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Deterministic finding validation. Returns ok:false with a stable reason
 * instead of throwing so adapters and coordinators can map it to their own
 * canonical error codes (e.g. MUSE_INVALID_RESULT).
 */
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
  if (finding.confidence === 'confirmed') {
    if (!items.some(isGroundedEvidence)) {
      return {
        ok: false,
        reason: 'Confirmed findings require at least one grounded evidence item',
      };
    }
    return { ok: true };
  }
  if (finding.confidence === 'strong') {
    if (!items.some(isGroundedEvidence)) {
      return {
        ok: false,
        reason: 'Strong findings require grounded source/tool evidence',
      };
    }
    return { ok: true };
  }
  return { ok: true };
}
