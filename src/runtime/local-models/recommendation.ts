/**
 * HR-02.5B: deterministic explainable recommendation engine.
 *
 * Operates ONLY on compatible models (compatibility filtering happens
 * first; incompatible candidates are reported but never selected).
 * Ranking is a fixed rule chain — no weights, no opaque scores:
 *
 *   1. profile tier preference (quality: high>balanced>lightweight;
 *      balanced: balanced>high>lightweight; lightweight: reverse);
 *   2. support maturity (validated beats experimental);
 *   3. model id, ascending (final deterministic tie-break).
 *
 * Same inputs always produce the same output. The reason lines render
 * directly into future CLI output (one fact per line).
 */

import type { HardwareProfile } from '../hardware/contracts';
import type { LocalModelDefinition, LocalModelKind, ModelQualityTier, RecommendationProfile } from './contracts';
import type { CompatibilityResult } from './compatibility';
import { evaluateCompatibility } from './compatibility';
import { getLocalModelCatalog } from './catalog';

export interface RecommendationCandidate {
  model: LocalModelDefinition;
  compatibility: CompatibilityResult;
}

export interface ModelRecommendation {
  kind: LocalModelKind;
  profile: RecommendationProfile;
  selected: LocalModelDefinition | null;
  candidates: RecommendationCandidate[];
  reason: string;
}

export interface RecommendArgs {
  kind: LocalModelKind;
  profile: RecommendationProfile;
  hardware: HardwareProfile;
  catalog?: readonly LocalModelDefinition[];
}

const TIER_ORDER: Record<RecommendationProfile, ModelQualityTier[]> = {
  quality: ['high', 'balanced', 'lightweight'],
  balanced: ['balanced', 'high', 'lightweight'],
  lightweight: ['lightweight', 'balanced', 'high'],
};

function tierRank(profile: RecommendationProfile, tier: ModelQualityTier): number {
  return TIER_ORDER[profile].indexOf(tier);
}

function maturityRank(model: LocalModelDefinition): number {
  return model.support.maturity === 'validated' ? 0 : 1;
}

function compareCandidates(profile: RecommendationProfile, a: LocalModelDefinition, b: LocalModelDefinition): number {
  const tier = tierRank(profile, a.quality_tier) - tierRank(profile, b.quality_tier);
  if (tier !== 0) return tier;
  const maturity = maturityRank(a) - maturityRank(b);
  if (maturity !== 0) return maturity;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Deterministic rank order of all models of a kind (profile tier ->
 * maturity -> id), WITHOUT hardware filtering. E2 lazy legs use this
 * synchronously to fix a stable selection identity before the async
 * hardware probe runs; the async path then verifies the advertised
 * model strictly (compatible + ready) and fails closed otherwise —
 * never substituting a different model. Additive helper; recommendModel
 * semantics unchanged.
 */
export function rankModelsOfKind(
  catalog: readonly LocalModelDefinition[],
  kind: LocalModelKind,
  profile: RecommendationProfile,
): LocalModelDefinition[] {
  return catalog.filter((model) => model.kind === kind).sort((a, b) => compareCandidates(profile, a, b));
}

export function recommendModel(args: RecommendArgs): ModelRecommendation {
  const catalog = args.catalog ?? getLocalModelCatalog();
  const ofKind = catalog.filter((model) => model.kind === args.kind);
  const candidates: RecommendationCandidate[] = ofKind.map((model) => ({
    model,
    compatibility: evaluateCompatibility(model, args.hardware),
  }));
  const compatible = candidates.filter((candidate) => candidate.compatibility.compatible);
  compatible.sort((a, b) => compareCandidates(args.profile, a.model, b.model));
  const selected = compatible.length > 0 && compatible[0] ? compatible[0].model : null;

  const lines: string[] = [];
  if (selected === null) {
    lines.push('no compatible ' + args.kind + ' model for this hardware (' + args.profile + ' profile requested)');
    for (const candidate of candidates) {
      const blocking = candidate.compatibility.reasons
        .filter((reason) => reason.result === 'fail')
        .map((reason) => reason.requirement + ' | ' + reason.observed);
      lines.push('- ' + candidate.model.id + ': incompatible (' + blocking.join('; ') + ')');
    }
  } else {
    lines.push('compatible with ' + args.hardware.arch + '/' + args.hardware.os);
    const accelReq = selected.requirements.accelerator;
    if (accelReq !== undefined) {
      lines.push(accelReq === 'cpu' ? 'cpu execution (no accelerator required)' : accelReq + ' available');
    }
    lines.push('hardware requirements satisfied');
    lines.push(args.profile + ' profile requested');
    const rankWord = args.profile === 'quality' ? 'highest' : args.profile === 'balanced' ? 'best-balanced' : 'lightest';
    lines.push(rankWord + ' compatible quality tier: ' + selected.quality_tier + ' (' + selected.support.maturity + ')');
  }

  return {
    kind: args.kind,
    profile: args.profile,
    selected,
    candidates,
    reason: lines.join('\n'),
  };
}
