import type { SentryAgentReportV2 } from '@qa/schemas';

/**
 * Deterministic QA evaluation against the fixture ground-truth manifest
 * (tests/fixtures/qa-eval/ground-truth.json).
 *
 * Scope: match agent REPORTS to known defects without model calls.
 * A finding counts as a hit only on path overlap PLUS failure-mechanism
 * overlap. Path-only overlap is reported as ambiguous (manual review),
 * never as a hit. The evaluator never executes paid models.
 */

export interface QaEvalKnownDefect {
  readonly id: string;
  readonly summary: string;
  readonly relevantPaths: readonly string[];
  readonly mechanismKeywords: readonly string[];
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

export interface QaEvalFindingAssessment {
  readonly findingTitle: string;
  readonly verdict: QaEvalFindingVerdict;
  readonly reproduced: boolean;
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
  readonly sourceOnlyFindings: number;
  readonly invalidEvidenceReferences: number;
  readonly overstatedConfidence: number;
  readonly incompleteInvestigations: number;
}

export interface QaEvalReport {
  readonly fixtures: readonly QaEvalFixtureResult[];
  readonly summary: QaEvalSummary;
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/').toLowerCase();
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

function pathOverlaps(findingPaths: readonly string[], defectPaths: readonly string[]): boolean {
  const normalized = findingPaths.map(normalizePath);
  return defectPaths.some((defectPath) => {
    const needle = normalizePath(defectPath);
    return normalized.some((candidate) => candidate === needle || candidate.endsWith('/' + needle));
  });
}

function mechanismHits(text: string, keywords: readonly string[]): number {
  return keywords.filter((keyword) => text.includes(keyword.toLowerCase())).length;
}

function touchesOnlyPeripheral(
  findingPaths: readonly string[],
  peripheralPrefixes: readonly string[] | undefined,
): boolean {
  if (peripheralPrefixes === undefined || findingPaths.length === 0) return false;
  const normalized = peripheralPrefixes.map((prefix) => normalizePath(prefix));
  return findingPaths.every((candidate) =>
    normalized.some((prefix) => normalizePath(candidate).includes(prefix)),
  );
}

type ReportShape = Pick<SentryAgentReportV2, 'findings' | 'evidence' | 'checks' | 'limitations'>;

/**
 * Assess every finding of one report against one fixture's known defects.
 * Matching rule: relevant-path overlap AND at least one mechanism keyword
 * in the finding text. Path overlap alone is ambiguous (manual review).
 */
export function evaluateFixtureReport(
  report: ReportShape,
  fixture: QaEvalFixtureGroundTruth,
): QaEvalFixtureResult {
  const evidenceByKey = new Map(report.evidence.map((item) => [item.key, item]));
  const seenDefects = new Set<string>();
  const findings: QaEvalFindingAssessment[] = [];
  for (const finding of report.findings) {
    const findingPaths = finding.locations.map((location) => location.relativePath);
    const text = findingText(finding);
    let best: QaEvalKnownDefect | undefined;
    let bestHits = 0;
    let pathOnly: QaEvalKnownDefect | undefined;
    for (const defect of fixture.knownDefects) {
      const overlaps = pathOverlaps(findingPaths, defect.relevantPaths);
      const hits = mechanismHits(text, defect.mechanismKeywords);
      if (overlaps && hits > 0 && hits >= bestHits) {
        best = defect;
        bestHits = hits;
      } else if (overlaps && pathOnly === undefined) {
        pathOnly = defect;
      }
    }
    let verdict: QaEvalFindingVerdict;
    if (best !== undefined) {
      if (seenDefects.has(best.id)) {
        verdict = { kind: 'duplicate', defectId: best.id };
      } else {
        seenDefects.add(best.id);
        verdict = { kind: 'truePositive', defectId: best.id };
      }
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
      sourceOnly,
      invalidEvidenceKeys,
      overstatedConfidence,
      touchesPeripheralOnly: touchesOnlyPeripheral(findingPaths, fixture.peripheralPrefixes),
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
    return evaluateFixtureReport(report, fixture);
  });
  let detected = 0;
  let missed = 0;
  let unsupported = 0;
  let duplicates = 0;
  let ambiguous = 0;
  let reproducedFindings = 0;
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
    sourceOnlyFindings,
    invalidEvidenceReferences,
    overstatedConfidence,
    incompleteInvestigations,
  };
  return { fixtures, summary };
}
