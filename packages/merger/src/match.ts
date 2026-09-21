import { jaccardSimilarity, type NormalizedFinding, type NormalizedLocation } from './normalize.js';

/**
 * Deterministic pairwise equivalence (merger v3). False-merge-averse:
 * when uncertain whether two Findings represent the same defect, keep
 * them separate. Location (same file / line overlap / nearness / symbol)
 * is supporting evidence, NEVER proof: no location-only combination is
 * sufficient without strong semantic agreement. A single shared
 * distinctive token is a recorded debug signal only and can NEVER enable
 * equivalence. Same-agent pairs require strictly stronger evidence than
 * cross-agent pairs. No LLM, no embeddings, no network: pure functions
 * of normalized findings. Every contributing feature is recorded in
 * MatchReasons for debugging, plus a deterministic matchCase identifier.
 */

/** Generic QA vocabulary (merger v3, versioned): tokens so common in
 *  finding prose that sharing them proves nothing about sameness
 *  (request, handler, cache, ...). Excluded from distinctiveness, never
 *  from similarity math. */
export const GENERIC_TOPIC_TOKENS: ReadonlySet<string> = new Set(
  (
    'request handler cache parser user api error response service function ' +
    'data input output value values result results system code file files ' +
    'test tests testing method class module component application app process ' +
    'operation operations manager controller client util utils helper helpers ' +
    'line lines defect defects issue issues bug bugs problem problems found ' +
    'reports report detected detection'
  ).split(' '),
);

export type MatchCaseId =
  | 'same_agent_exact_behavior'
  | 'same_agent_overlapping_semantics'
  | 'same_agent_evidence_backed'
  | 'cross_agent_same_location_semantics'
  | 'cross_agent_behavior_rootcause'
  | 'cross_agent_symbol_evidence_behavior'
  | 'cross_agent_evidence_behavior'
  | 'none';

export interface MatchReasons {
  readonly sameFile: boolean;
  readonly sameSymbol: boolean;
  readonly lineOverlap: boolean;
  readonly lineNear: boolean;
  readonly categoryCompatible: boolean;
  readonly categoryEqual: boolean;
  readonly categoryConflict: boolean;
  readonly titleSimilar: boolean;
  readonly behaviorSimilar: boolean;
  readonly rootCauseSimilar: boolean;
  readonly sharedTopicToken: boolean;
  readonly sharedDistinctiveToken: boolean;
  readonly veryStrongBehavior: boolean;
  readonly evidenceOverlap: boolean;
  readonly sameSourceAgent: boolean;
}

export interface MatchVerdict {
  readonly equivalent: boolean;
  readonly reasons: MatchReasons;
  readonly matchCase: MatchCaseId;
}

/** Small explicit versioned category families: same family is a positive
 *  signal, different family is NOT a veto (agents classify differently).
 *  Cross-family disagreement raises the burden of proof (categoryConflict
 *  recorded); it never vetoes strong semantic + location agreement. */
const CATEGORY_FAMILIES: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['security', 'authentication', 'authorization']),
  new Set(['build', 'cicd', 'deployment', 'dependency']),
  new Set(['frontend', 'api']),
  new Set(['logic', 'runtime', 'concurrency', 'performance']),
  new Set(['testing', 'maintainability', 'documentation', 'configuration', 'database', 'other']),
];

function categoryFamily(category: string): number {
  const index = CATEGORY_FAMILIES.findIndex((family) => family.has(category));
  return index === -1 ? CATEGORY_FAMILIES.length : index;
}

function linesOverlap(a: NormalizedLocation, b: NormalizedLocation): boolean {
  // Point locations (single reported line, no range): the exact same
  // reported line overlaps; a point inside the other's range overlaps.
  // Two distinct points never overlap (nearness is the weaker signal).
  if (a.lineStart !== undefined && a.lineEnd === undefined) {
    if (b.lineStart === undefined) return false;
    if (b.lineEnd === undefined) return a.lineStart === b.lineStart;
    return b.lineStart <= a.lineStart && a.lineStart <= b.lineEnd;
  }
  if (b.lineStart !== undefined && b.lineEnd === undefined) {
    if (a.lineStart === undefined || a.lineEnd === undefined) return false;
    return a.lineStart <= b.lineStart && b.lineStart <= a.lineEnd;
  }
  if (a.lineStart === undefined || a.lineEnd === undefined) return false;
  if (b.lineStart === undefined || b.lineEnd === undefined) return false;
  return a.lineStart <= b.lineEnd && b.lineStart <= a.lineEnd;
}

function linesNear(a: NormalizedLocation, b: NormalizedLocation): boolean {
  const NEAR_LINES = 15;
  if (a.lineStart === undefined || b.lineStart === undefined) return false;
  const aEnd = a.lineEnd ?? a.lineStart;
  const bEnd = b.lineEnd ?? b.lineStart;
  return a.lineStart <= bEnd + NEAR_LINES && b.lineStart <= aEnd + NEAR_LINES;
}

export function compareLocations(
  a: readonly NormalizedLocation[],
  b: readonly NormalizedLocation[],
): Pick<MatchReasons, 'sameFile' | 'sameSymbol' | 'lineOverlap' | 'lineNear'> {
  let sameFile = false;
  let sameSymbol = false;
  let lineOverlap = false;
  let lineNear = false;
  for (const left of a) {
    for (const right of b) {
      if (left.relativePath !== right.relativePath) continue;
      sameFile = true;
      if (left.symbol !== '' && left.symbol === right.symbol) sameSymbol = true;
      if (linesOverlap(left, right)) lineOverlap = true;
      else if (linesNear(left, right)) lineNear = true;
    }
  }
  return { sameFile, sameSymbol, lineOverlap, lineNear };
}

/** Evidence fingerprints that encode real evidence identity (command
 *  text + exit + canonical operation, test identity + status, runtime
 *  summary, static tool+rule). Coarse code_reference/log/manual/browser
 *  fingerprints (same file, same broad range, same prose prefix) are
 *  supporting context only and never count as evidenceOverlap here. */
function isMeaningfulEvidenceFingerprint(fingerprint: string): boolean {
  return (
    fingerprint.startsWith('cmd:') ||
    fingerprint.startsWith('test:') ||
    fingerprint.startsWith('runtime:') ||
    fingerprint.startsWith('static:')
  );
}

export function compareFindings(a: NormalizedFinding, b: NormalizedFinding): MatchVerdict {
  const location = compareLocations(a.locations, b.locations);
  const categoryEqual = a.category === b.category;
  const categoryCompatible =
    categoryEqual || categoryFamily(a.category) === categoryFamily(b.category);
  const categoryConflict = !categoryCompatible;
  const sameSourceAgent = a.agentStackId === b.agentStackId;
  // Empty token sets carry no signal: absent behavior text is unknown,
  // not similar. (The empty==empty Jaccard convention would otherwise
  // merge any two undescribed findings.)
  const titleSimilar =
    (a.titleTokens.size > 0 &&
      b.titleTokens.size > 0 &&
      jaccardSimilarity(a.titleTokens, b.titleTokens) >= 0.35) ||
    (a.titleTokens.size > 0 &&
      b.titleTokens.size > 0 &&
      [...a.titleTokens].every((token) => b.titleTokens.has(token))) ||
    (a.titleTokens.size > 0 &&
      b.titleTokens.size > 0 &&
      [...b.titleTokens].every((token) => a.titleTokens.has(token)));
  const behaviorSimilar =
    (a.actualTokens.size > 0 &&
      b.actualTokens.size > 0 &&
      jaccardSimilarity(a.actualTokens, b.actualTokens) >= 0.4) ||
    (a.descriptionTokens.size > 0 &&
      b.descriptionTokens.size > 0 &&
      jaccardSimilarity(a.descriptionTokens, b.descriptionTokens) >= 0.5);
  // Root-cause prose is short and variable across agents, so the bar is
  // 0.4 (still conservative: root cause alone never merges — it only
  // pairs with behavior or title agreement plus location/evidence).
  const rootCauseSimilar =
    a.rootCauseTokens.size > 0 &&
    b.rootCauseTokens.size > 0 &&
    (jaccardSimilarity(a.rootCauseTokens, b.rootCauseTokens) >= 0.4 ||
      [...a.rootCauseTokens].every((token) => b.rootCauseTokens.has(token)) ||
      [...b.rootCauseTokens].every((token) => a.rootCauseTokens.has(token)));
  const aTopic = new Set([...a.titleTokens, ...a.descriptionTokens]);
  const bTopic = new Set([...b.titleTokens, ...b.descriptionTokens]);
  const sharedTopicToken = [...aTopic].some((token) => bTopic.has(token));
  // Distinctive overlap: shared human-authored tokens AFTER removing
  // generic QA vocabulary. {null, empty, payload} counts; {request,
  // handler} or {api, request, handler} does not. DEBUG SIGNAL ONLY:
  // recorded for explainability, never enables equivalence.
  const sharedDistinctiveToken = [...aTopic].some(
    (token) => !GENERIC_TOPIC_TOKENS.has(token) && bTopic.has(token),
  );
  const actualContained =
    (a.actualTokens.size > 0 &&
      b.actualTokens.size > 0 &&
      [...a.actualTokens].every((token) => b.actualTokens.has(token))) ||
    (a.actualTokens.size > 0 &&
      b.actualTokens.size > 0 &&
      [...b.actualTokens].every((token) => a.actualTokens.has(token)));
  const veryStrongBehavior =
    actualContained ||
    (a.actualTokens.size > 0 &&
      b.actualTokens.size > 0 &&
      jaccardSimilarity(a.actualTokens, b.actualTokens) >= 0.6);
  // Strong semantic agreement: title AND behavior must agree together.
  // veryStrongSemanticAgreement additionally binds a very strong
  // behavioral match to a title or root-cause match, so that e.g.
  // "sequence not reset" never merges with "divide by zero".
  const strongSemanticAgreement = titleSimilar && behaviorSimilar;
  const veryStrongSemanticAgreement = veryStrongBehavior && (titleSimilar || rootCauseSimilar);
  const evidenceOverlap = a.evidenceFingerprints.some(
    (fingerprint) =>
      isMeaningfulEvidenceFingerprint(fingerprint) && b.evidenceFingerprints.includes(fingerprint),
  );
  const reasons: MatchReasons = {
    ...location,
    categoryCompatible,
    categoryEqual,
    categoryConflict,
    titleSimilar,
    behaviorSimilar,
    rootCauseSimilar,
    sharedTopicToken,
    sharedDistinctiveToken,
    veryStrongBehavior,
    evidenceOverlap,
    sameSourceAgent,
  };
  // Merger v3 equivalence: exactly one of five cases must hold. Location
  // is supporting evidence only — every case requires strong semantic
  // agreement first. lineNear NEVER enables equivalence on its own; it
  // only narrows an already-established semantic + same-file match.
  // sharedDistinctiveToken is debug-only and appears in NO case.
  // Category conflict raises the bar: conflicting categories require
  // veryStrongSemanticAgreement instead of strongSemanticAgreement.
  const semanticBar = (base: boolean): boolean =>
    categoryConflict ? veryStrongSemanticAgreement : base;
  let matchCase: MatchCaseId = 'none';
  // SAME-AGENT CASE A: same file + overlapping location + title +
  // very strong behavior. Same-agent findings need the strictest proof
  // because one agent deliberately emitted two findings.
  const sameAgentExact =
    sameSourceAgent &&
    location.sameFile &&
    location.lineOverlap &&
    titleSimilar &&
    semanticBar(veryStrongBehavior);
  // SAME-AGENT CASE A2: same file + overlapping location + full
  // title+behavior agreement + root-cause agreement. Paraphrased
  // same-agent duplicates with matching behavior and cause still merge,
  // but location alone or behavior alone never suffices.
  const sameAgentOverlapping =
    sameSourceAgent &&
    location.sameFile &&
    location.lineOverlap &&
    semanticBar(strongSemanticAgreement) &&
    rootCauseSimilar;
  // SAME-AGENT CASE B: same symbol + meaningful evidence overlap +
  // strong semantic similarity (title+behavior, or very-strong bound).
  const sameAgentEvidence =
    sameSourceAgent &&
    location.sameFile &&
    location.sameSymbol &&
    evidenceOverlap &&
    semanticBar(strongSemanticAgreement || veryStrongSemanticAgreement);
  // CROSS-AGENT CASE C: same/overlapping location + (title AND behavior).
  const crossAgentLocation =
    !sameSourceAgent &&
    location.sameFile &&
    (location.lineOverlap || location.lineNear) &&
    semanticBar(strongSemanticAgreement);
  // CROSS-AGENT CASE C2: overlapping location + behavior agreement +
  // root-cause agreement. Covers paraphrased cross-agent duplicates
  // (e.g. rotation vs reuse wording) where titles diverge but behavior
  // and cause agree on the same defect.
  const crossAgentBehaviorCause =
    !sameSourceAgent &&
    location.sameFile &&
    location.lineOverlap &&
    behaviorSimilar &&
    rootCauseSimilar;
  // CROSS-AGENT CASE D: same symbol + very strong behavior +
  // title-or-root-cause agreement.
  const crossAgentSymbol =
    !sameSourceAgent &&
    location.sameFile &&
    location.sameSymbol &&
    semanticBar(veryStrongSemanticAgreement);
  // CROSS-AGENT CASE E: strong evidence fingerprint compatibility +
  // behavior similarity (location-independent duplicate reports).
  // Behavior-only pairs WITHOUT location or evidence stay separate:
  // strong behavior prose alone is not duplicate proof.
  const crossAgentEvidence = !sameSourceAgent && evidenceOverlap && semanticBar(behaviorSimilar);
  const equivalent =
    sameAgentExact ||
    sameAgentOverlapping ||
    sameAgentEvidence ||
    crossAgentLocation ||
    crossAgentBehaviorCause ||
    crossAgentSymbol ||
    crossAgentEvidence;
  if (sameAgentExact) matchCase = 'same_agent_exact_behavior';
  else if (sameAgentOverlapping) matchCase = 'same_agent_overlapping_semantics';
  else if (sameAgentEvidence) matchCase = 'same_agent_evidence_backed';
  else if (crossAgentLocation) matchCase = 'cross_agent_same_location_semantics';
  else if (crossAgentBehaviorCause) matchCase = 'cross_agent_behavior_rootcause';
  else if (crossAgentSymbol) matchCase = 'cross_agent_symbol_evidence_behavior';
  else if (crossAgentEvidence) matchCase = 'cross_agent_evidence_behavior';
  return { equivalent, reasons, matchCase };
}
