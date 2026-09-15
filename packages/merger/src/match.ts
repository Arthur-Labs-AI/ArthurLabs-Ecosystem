import { jaccardSimilarity, type NormalizedFinding, type NormalizedLocation } from './normalize.js';

/**
 * Deterministic pairwise equivalence (merger v2). Explainable features,
 * four explicit equivalence cases (§8), false-merge-averse. No single
 * magic number: every contributing feature is recorded in MatchReasons
 * for debugging. `sharedTopicToken` is a recorded weak signal only and
 * can NEVER satisfy a case requirement (§9).
 */

/** Generic QA vocabulary (merger v2, versioned): tokens so common in
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
  readonly sharedDistinctiveToken: boolean;
  readonly veryStrongBehavior: boolean;
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
  const aTopic = new Set([...a.titleTokens, ...a.descriptionTokens]);
  const bTopic = new Set([...b.titleTokens, ...b.descriptionTokens]);
  const sharedTopicToken = [...aTopic].some((token) => bTopic.has(token));
  // Distinctive overlap: shared human-authored tokens AFTER removing
  // generic QA vocabulary. {null, empty, payload} counts; {request,
  // handler} or {api, request, handler} does not.
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
    sharedDistinctiveToken,
    veryStrongBehavior,
    evidenceOverlap,
  };
  // Merger v2 equivalence (§8): exactly one of four cases must hold.
  // False merge is worse than under-merge (§7): when uncertain, stay
  // separate. meaningfulTopical is (title AND behavior agreement) OR a
  // shared DISTINCTIVE token — generic vocabulary alone never qualifies
  // (§9). categoryCompatible/categoryEqual/sharedTopicToken stay
  // recorded for debugging but never satisfy a case.
  const meaningfulTopical = (titleSimilar && behaviorSimilar) || sharedDistinctiveToken;
  // CASE A: same file + line overlap + meaningful topical similarity.
  const caseA = location.sameFile && location.lineOverlap && meaningfulTopical;
  // CASE B: same file + same symbol + meaningful topical similarity.
  const caseB = location.sameFile && location.sameSymbol && meaningfulTopical;
  // CASE C: same file + same symbol + strong evidence fingerprint
  // compatibility + meaningful topical similarity.
  const caseC = location.sameFile && location.sameSymbol && evidenceOverlap && meaningfulTopical;
  // CASE D: same file + line nearness + (meaningful topical similarity
  // or very strong behavior similarity).
  const caseD = location.sameFile && location.lineNear && (meaningfulTopical || veryStrongBehavior);
  return { equivalent: caseA || caseB || caseC || caseD, reasons };
}
