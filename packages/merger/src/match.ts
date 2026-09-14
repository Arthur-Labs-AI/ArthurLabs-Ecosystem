import { jaccardSimilarity, type NormalizedFinding, type NormalizedLocation } from './normalize.js';

/**
 * Deterministic pairwise equivalence (merger v1). Explainable features,
 * conservative rule, strong-anchor requirement. No single magic number:
 * every contributing feature is recorded in MatchReasons for debugging.
 */

export interface MatchReasons {
  readonly sameFile: boolean;
  readonly sameSymbol: boolean;
  readonly lineOverlap: boolean;
  readonly lineNear: boolean;
  readonly categoryCompatible: boolean;
  readonly categoryEqual: boolean;
  readonly titleSimilar: boolean;
  readonly behaviorSimilar: boolean;
  readonly sharedTopicToken: boolean;
  readonly evidenceOverlap: boolean;
}

export interface MatchVerdict {
  readonly equivalent: boolean;
  readonly reasons: MatchReasons;
}

/** Small explicit versioned category families: same family is a positive
 *  signal, different family is NOT a veto (agents classify differently). */
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

export function compareFindings(a: NormalizedFinding, b: NormalizedFinding): MatchVerdict {
  const location = compareLocations(a.locations, b.locations);
  const categoryEqual = a.category === b.category;
  const categoryCompatible =
    categoryEqual || categoryFamily(a.category) === categoryFamily(b.category);
  const titleSimilar =
    jaccardSimilarity(a.titleTokens, b.titleTokens) >= 0.35 ||
    (a.titleTokens.size > 0 &&
      b.titleTokens.size > 0 &&
      [...a.titleTokens].every((token) => b.titleTokens.has(token))) ||
    (a.titleTokens.size > 0 &&
      b.titleTokens.size > 0 &&
      [...b.titleTokens].every((token) => a.titleTokens.has(token)));
  const behaviorSimilar =
    jaccardSimilarity(a.actualTokens, b.actualTokens) >= 0.4 ||
    jaccardSimilarity(a.descriptionTokens, b.descriptionTokens) >= 0.5;
  const aTopic = new Set([...a.titleTokens, ...a.descriptionTokens]);
  const bTopic = new Set([...b.titleTokens, ...b.descriptionTokens]);
  const sharedTopicToken = [...aTopic].some((token) => bTopic.has(token));
  const evidenceOverlap = a.evidenceFingerprints.some((fingerprint) =>
    b.evidenceFingerprints.includes(fingerprint),
  );
  const reasons: MatchReasons = {
    ...location,
    categoryCompatible,
    categoryEqual,
    titleSimilar,
    behaviorSimilar,
    sharedTopicToken,
    evidenceOverlap,
  };
  // Conservative equivalence: a strong anchor (same symbol, overlapping
  // lines, or shared evidence fingerprint on the same file) PLUS at
  // least one corroborating topical signal. Same file alone, title
  // similarity alone, or category alone never merges.
  const strongAnchor =
    (location.sameFile && location.sameSymbol) ||
    (location.sameFile && location.lineOverlap) ||
    (location.sameFile && evidenceOverlap) ||
    (location.sameFile && location.lineNear && behaviorSimilar);
  const corroboration =
    titleSimilar || behaviorSimilar || categoryEqual || evidenceOverlap || sharedTopicToken;
  return { equivalent: strongAnchor && corroboration, reasons };
}
