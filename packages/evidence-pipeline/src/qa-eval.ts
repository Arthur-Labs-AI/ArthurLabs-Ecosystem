import type { SentryAgentReportV2 } from '@qa/schemas';

/**
 * Deterministic QA evaluation against the fixture ground-truth manifest
 * (tests/fixtures/qa-eval/ground-truth.json).
 *
 * Conservative by design: a finding is a TRUE POSITIVE only when it cites
 * a relevant location (fixture-root-aware canonical path equality) AND
 * describes the failure with at least `minMarkers` distinct behavior
 * markers. Generic keyword overlap, path-only overlap, negated claims,
 * and evidence-free assertions abstain as AMBIGUOUS or fail as
 * UNSUPPORTED — never as hits. The evaluator never executes paid models.
 *
 * Trust boundary: the evaluator sees the parsed report only. A
 * `reproduced_*` strength is a claim the agent made, not proof the
 * evaluator re-ran. `trustedProvenance` marks reports that already passed
 * Sentry's frozen-ledger validation (`sentry-validated`); anything else
 * is `self-reported`. Metric names reflect claims, not independent
 * verification of execution.
 */

export interface QaEvalBehaviorMarker {
  readonly id: string;
  readonly phrases: readonly string[];
}

export interface QaEvalKnownDefect {
  readonly id: string;
  readonly summary: string;
  readonly relevantPaths: readonly string[];
  readonly markers: readonly QaEvalBehaviorMarker[];
  readonly minMarkers: number;
  readonly expectedBehavior: string;
  readonly actualBehavior: string;
  readonly reproduction: string;
}

export interface QaEvalFixtureGroundTruth {
  readonly id: string;
  readonly title: string;
  readonly intendedBehavior: string;
  readonly clean: boolean;
  readonly entryPoints: readonly string[];
  readonly relevantPaths: readonly string[];
  readonly peripheralPrefixes?: readonly string[];
  /**
   * Path prefixes an agent may legitimately use, longest first
   * (repository-relative `fixture-x/` and fixture-root-relative ``).
   * Canonicalization strips exactly one known base; anything else must
   * match literally. Basename-only matching is never performed.
   */
  readonly pathBases: readonly string[];
  readonly knownDefects: readonly QaEvalKnownDefect[];
  readonly adversarialContent?: string;
}

export interface QaEvalGroundTruth {
  readonly version: number;
  readonly fixtures: readonly QaEvalFixtureGroundTruth[];
}

export type QaEvalFindingVerdict =
  | { readonly kind: 'truePositive'; readonly defectId: string }
  | { readonly kind: 'duplicate'; readonly defectId: string }
  | { readonly kind: 'ambiguous'; readonly reason: string }
  | { readonly kind: 'unsupported'; readonly reason: string };

export type QaEvalReproductionProvenance = 'sentry-validated' | 'self-reported' | 'none';

export interface QaEvalFindingAssessment {
  readonly findingTitle: string;
  readonly verdict: QaEvalFindingVerdict;
  /** Report claims behavioral reproduction with operation-linked strength. */
  readonly reproduced: boolean;
  readonly reproductionProvenance: QaEvalReproductionProvenance;
  readonly sourceOnly: boolean;
  readonly invalidEvidenceKeys: readonly string[];
  readonly overstatedConfidence: boolean;
  readonly touchesPeripheralOnly: boolean;
}

export interface QaEvalFixtureResult {
  readonly fixtureId: string;
  readonly detected: readonly string[];
  readonly missed: readonly string[];
  readonly findings: readonly QaEvalFindingAssessment[];
}

export interface QaEvalSummary {
  readonly detected: number;
  readonly missed: number;
  readonly unsupported: number;
  readonly duplicates: number;
  readonly ambiguous: number;
  readonly reproducedFindings: number;
  readonly validatedReproductions: number;
  readonly claimedReproductions: number;
  readonly sourceOnlyFindings: number;
  readonly invalidEvidenceReferences: number;
  readonly overstatedConfidence: number;
  readonly incompleteInvestigations: number;
}

export interface QaEvalReport {
  readonly fixtures: readonly QaEvalFixtureResult[];
  readonly summary: QaEvalSummary;
}

export interface QaEvalOptions {
  /**
   * True when every evaluated report already passed Sentry's
   * frozen-ledger evidence validation. Default false: reproduction
   * strengths are then self-reported claims, not verified executions.
   */
  readonly trustedProvenance?: boolean;
}

function normalizeSeparators(value: string): string {
  return value.trim().replace(/\\/g, '/');
}

/**
 * Canonical fixture-relative path, or undefined when the raw path is
 * invalid (absolute, traversal outside the context, empty). Comparison is
 * case-insensitive; exactly one known base prefix is stripped.
 */
export function canonicalFixturePath(
  rawPath: string,
  pathBases: readonly string[],
): string | undefined {
  const separators = normalizeSeparators(rawPath);
  if (separators.length === 0) return undefined;
  const lower = separators.toLowerCase();
  if (lower.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(separators)) return undefined;
  const bases = [...pathBases].sort((a, b) => b.length - a.length);
  let stripped = lower;
  for (const base of bases) {
    const normalizedBase = normalizeSeparators(base).toLowerCase();
    if (normalizedBase.length > 0 && stripped.startsWith(normalizedBase)) {
      stripped = stripped.slice(normalizedBase.length);
      break;
    }
  }
  const collapsed = stripped.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  const resolved: string[] = [];
  for (const segment of collapsed) {
    if (segment === '..') {
      const parent = resolved.pop();
      if (parent === undefined) return undefined;
    } else {
      resolved.push(segment);
    }
  }
  if (resolved.length === 0) return undefined;
  return resolved.join('/');
}

function findingText(finding: {
  readonly title: string;
  readonly description: string;
  readonly expectedBehavior?: string | undefined;
  readonly actualBehavior?: string | undefined;
}): string {
  return [
    finding.title,
    finding.description,
    finding.expectedBehavior ?? '',
    finding.actualBehavior ?? '',
  ]
    .join('\n')
    .toLowerCase();
}

/** Sentences asserting correct behavior (negating the defect). */
const DENIAL_PATTERNS = [
  /\bcorrectly\b/,
  /\bproperly\b/,
  /\bas (expected|intended)\b/,
  /\bworks correctly\b/,
  /\bhandles correctly\b/,
  /\bno (bug|defect|issue|problem|vulnerability)\b/,
  /\bnot a (bug|defect|issue|problem)\b/,
  /\bnever (returns|fails|throws)\b/,
];

/** Cues that re-assert a failure even when denial words appear. */
const FAILURE_CUE_PATTERN =
  /\binstead\b|\bbut\b|\bhowever\b|\bwrong\b|\bincorrect(ly)?\b|\bfails?\b|\bfailure\b|\bmissing\b|\bviolat(e[sd]?|ion)\b|\bbug\b|\bdefect\b|\bshould\b|\bmust\b|\bneeds? to\b|\bfix\b/;

function isDenialSentence(sentence: string): boolean {
  const denies = DENIAL_PATTERNS.some((pattern) => pattern.test(sentence));
  return denies && !FAILURE_CUE_PATTERN.test(sentence);
}

/**
 * Finding text with denial sentences removed. Marker matches that survive
 * only inside sentences claiming correct behavior do not count: a finding
 * stating the component works cannot also discover its defect.
 */
function assertiveText(text: string): string {
  const sentences = text.split(/[.!?;\n]+/);
  return sentences.filter((sentence) => !isDenialSentence(sentence)).join('\n');
}

function markerMatched(marker: QaEvalBehaviorMarker, text: string): boolean {
  return marker.phrases.some((phrase) => text.includes(phrase.toLowerCase()));
}

function countMarkers(text: string, markers: readonly QaEvalBehaviorMarker[]): number {
  return markers.filter((marker) => markerMatched(marker, text)).length;
}

function canonicalSet(paths: readonly string[], pathBases: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of paths) {
    const canonical = canonicalFixturePath(raw, pathBases);
    if (canonical !== undefined) out.add(canonical);
  }
  return out;
}

function pathOverlaps(
  findingPaths: readonly string[],
  defectPaths: readonly string[],
  pathBases: readonly string[],
): boolean {
  const finding = canonicalSet(findingPaths, pathBases);
  const defects = canonicalSet(defectPaths, pathBases);
  for (const candidate of finding) {
    if (defects.has(candidate)) return true;
  }
  return false;
}

function touchesOnlyPeripheral(
  findingPaths: readonly string[],
  fixture: QaEvalFixtureGroundTruth,
): boolean {
  const prefixes = fixture.peripheralPrefixes;
  if (prefixes === undefined || findingPaths.length === 0) return false;
  const finding = canonicalSet(findingPaths, fixture.pathBases);
  if (finding.size === 0) return false;
  const normalized = canonicalSet(prefixes, fixture.pathBases);
  return [...finding].every((candidate) =>
    [...normalized].some((prefix) => candidate === prefix || candidate.startsWith(prefix + '/')),
  );
}

type ReportShape = Pick<SentryAgentReportV2, 'findings' | 'evidence' | 'checks' | 'limitations'>;

/**
 * Assess every finding of one report against one fixture's known defects.
 * TRUE POSITIVE requires a canonical path overlap AND at least
 * `minMarkers` distinct behavior markers in non-denial sentences AND at
 * least one cited evidence item. Strong mechanism text without a relevant
 * location, path overlap without mechanism detail, negated claims, and
 * evidence-free assertions all abstain or fail — never hit.
 */
export function evaluateFixtureReport(
  report: ReportShape,
  fixture: QaEvalFixtureGroundTruth,
  options?: QaEvalOptions,
): QaEvalFixtureResult {
  const trusted = options?.trustedProvenance === true;
  const evidenceByKey = new Map(report.evidence.map((item) => [item.key, item]));
  const seenDefects = new Set<string>();
  const findings: QaEvalFindingAssessment[] = [];
  for (const finding of report.findings) {
    const findingPaths = finding.locations.map((location) => location.relativePath);
    const text = assertiveText(findingText(finding));
    let best: QaEvalKnownDefect | undefined;
    let bestMarkers = 0;
    let mechanismOnly: QaEvalKnownDefect | undefined;
    let pathOnly: QaEvalKnownDefect | undefined;
    for (const defect of fixture.knownDefects) {
      const overlaps = pathOverlaps(findingPaths, defect.relevantPaths, fixture.pathBases);
      const markers = countMarkers(text, defect.markers);
      const strong = markers >= defect.minMarkers;
      if (overlaps && strong && markers >= bestMarkers) {
        best = defect;
        bestMarkers = markers;
      } else if (overlaps && pathOnly === undefined) {
        pathOnly = defect;
      } else if (!overlaps && strong && mechanismOnly === undefined) {
        mechanismOnly = defect;
      }
    }
    let verdict: QaEvalFindingVerdict;
    if (best !== undefined && finding.evidenceKeys.length > 0) {
      if (seenDefects.has(best.id)) {
        verdict = { kind: 'duplicate', defectId: best.id };
      } else {
        seenDefects.add(best.id);
        verdict = { kind: 'truePositive', defectId: best.id };
      }
    } else if (best !== undefined) {
      verdict = {
        kind: 'ambiguous',
        reason:
          'Finding describes ' +
          best.id +
          ' but cites no supporting evidence; manual review required.',
      };
    } else if (mechanismOnly !== undefined) {
      verdict = {
        kind: 'ambiguous',
        reason:
          'Finding describes the failure mechanism of ' +
          mechanismOnly.id +
          ' but cites no relevant location; manual review required.',
      };
    } else if (pathOnly !== undefined) {
      verdict = {
        kind: 'ambiguous',
        reason:
          'Location overlaps ' +
          pathOnly.id +
          ' but the finding describes no matching failure mechanism; manual review required.',
      };
    } else {
      verdict = {
        kind: 'unsupported',
        reason: 'No known defect matches by location and failure mechanism.',
      };
    }
    const cited = finding.evidenceKeys
      .map((key) => evidenceByKey.get(key))
      .filter((item) => item !== undefined);
    const invalidEvidenceKeys = finding.evidenceKeys.filter((key) => !evidenceByKey.has(key));
    const reproduced = cited.some(
      (item) => item.strength === 'reproduced_failure' || item.strength === 'reproduced_behavior',
    );
    const reproductionProvenance: QaEvalReproductionProvenance = !reproduced
      ? 'none'
      : trusted
        ? 'sentry-validated'
        : 'self-reported';
    const grounded = cited.some(
      (item) =>
        item.strength === 'reproduced_failure' ||
        item.strength === 'reproduced_behavior' ||
        item.strength === 'tool_diagnostic' ||
        item.strength === 'strong_code_evidence' ||
        item.type === 'command' ||
        item.type === 'code_reference' ||
        item.type === 'test',
    );
    const sourceOnly = !reproduced && cited.length > 0 && grounded;
    const overstatedConfidence =
      (finding.confidence === 'confirmed' || finding.confidence === 'strong') && !grounded;
    findings.push({
      findingTitle: finding.title,
      verdict,
      reproduced,
      reproductionProvenance,
      sourceOnly,
      invalidEvidenceKeys,
      overstatedConfidence,
      touchesPeripheralOnly: touchesOnlyPeripheral(findingPaths, fixture),
    });
  }
  const detected = [...seenDefects];
  const missed = fixture.knownDefects
    .map((defect) => defect.id)
    .filter((id) => !seenDefects.has(id));
  return { fixtureId: fixture.id, detected, missed, findings };
}

export function isIncompleteInvestigation(report: ReportShape): boolean {
  return (
    report.limitations.length > 0 ||
    report.checks.some((check) => check.status === 'not_run' || check.status === 'inconclusive')
  );
}

/** Evaluate one report per fixture id (`reportsByFixture`). */
export function evaluateReports(
  reportsByFixture: ReadonlyMap<string, ReportShape>,
  groundTruth: QaEvalGroundTruth,
  options?: QaEvalOptions,
): QaEvalReport {
  const fixtures = groundTruth.fixtures.map((fixture) => {
    const report = reportsByFixture.get(fixture.id);
    if (report === undefined) {
      return {
        fixtureId: fixture.id,
        detected: [],
        missed: fixture.knownDefects.map((defect) => defect.id),
        findings: [],
      } satisfies QaEvalFixtureResult;
    }
    return evaluateFixtureReport(report, fixture, options);
  });
  let detected = 0;
  let missed = 0;
  let unsupported = 0;
  let duplicates = 0;
  let ambiguous = 0;
  let reproducedFindings = 0;
  let validatedReproductions = 0;
  let claimedReproductions = 0;
  let sourceOnlyFindings = 0;
  let invalidEvidenceReferences = 0;
  let overstatedConfidence = 0;
  let incompleteInvestigations = 0;
  for (const fixture of fixtures) {
    detected += fixture.detected.length;
    missed += fixture.missed.length;
    for (const finding of fixture.findings) {
      if (finding.verdict.kind === 'unsupported') unsupported += 1;
      if (finding.verdict.kind === 'duplicate') duplicates += 1;
      if (finding.verdict.kind === 'ambiguous') ambiguous += 1;
      if (finding.reproduced) reproducedFindings += 1;
      if (finding.reproductionProvenance === 'sentry-validated') validatedReproductions += 1;
      if (finding.reproductionProvenance === 'self-reported') claimedReproductions += 1;
      if (finding.sourceOnly) sourceOnlyFindings += 1;
      if (finding.invalidEvidenceKeys.length > 0) invalidEvidenceReferences += 1;
      if (finding.overstatedConfidence) overstatedConfidence += 1;
    }
  }
  const knownIds = new Set(groundTruth.fixtures.map((fixture) => fixture.id));
  for (const [fixtureId, report] of reportsByFixture) {
    if (knownIds.has(fixtureId) && isIncompleteInvestigation(report)) {
      incompleteInvestigations += 1;
    }
  }
  const summary: QaEvalSummary = {
    detected,
    missed,
    unsupported,
    duplicates,
    ambiguous,
    reproducedFindings,
    validatedReproductions,
    claimedReproductions,
    sourceOnlyFindings,
    invalidEvidenceReferences,
    overstatedConfidence,
    incompleteInvestigations,
  };
  return { fixtures, summary };
}
