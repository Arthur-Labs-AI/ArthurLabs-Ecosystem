import { createHash } from 'node:crypto';
import type { Evidence, Finding } from '@qa/schemas';
import { NORMALIZER_VERSION } from './schemas.js';

/**
 * Deterministic finding normalization (normalizer v1). Pure functions of
 * canonical Finding/Evidence only — no transcripts, no model calls, no
 * locale-sensitive operations (ASCII-only case folding; Unicode NFC is a
 * fixed algorithm, identical on every platform).
 */

export const NORMALIZER_STOP_WORDS: ReadonlySet<string> = new Set(
  (
    'a an the and or of to in on for with is are was were be been it its ' +
    'this that these those as at by from into over after before between ' +
    'when where which while during each other more most such no not only ' +
    'also than then there their they them he she we you your our ours his ' +
    'her hers has have had will would should could may might must shall ' +
    'do does did done but if else because until against among within ' +
    'through out up down off above below under again further once here how ' +
    'all any both few many some own same so too very can just don should now'
  ).split(' '),
);

/** ASCII-only lowercase: deterministic on every platform and locale. */
export function asciiLower(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : value[index];
  }
  return out;
}

export function normalizeText(value: string | undefined): string {
  if (value === undefined) return '';
  return asciiLower(value.normalize('NFC'))
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(value: string | undefined): readonly string[] {
  const normalized = normalizeText(value);
  if (normalized.length === 0) return [];
  return normalized.split(' ').filter((token) => !NORMALIZER_STOP_WORDS.has(token));
}

export function tokenSet(value: string | undefined): ReadonlySet<string> {
  return new Set(tokenize(value));
}

/** Jaccard similarity over normalized non-stop-word token sets. */
export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function normalizePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/\/\.\//g, '/')
    .replace(/\/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/\.\/[^/]+/g, '');
}

export function normalizeSymbol(value: string | undefined): string {
  if (value === undefined) return '';
  return normalizeText(value).replace(/\s+/g, '');
}

export interface NormalizedLocation {
  readonly relativePath: string;
  readonly symbol: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
}

export interface NormalizedFinding {
  readonly sourceFindingId: string;
  readonly agentRunId: string;
  readonly agentStackId: string;
  readonly category: string;
  readonly severity: string;
  readonly confidence: string;
  readonly titleTokens: ReadonlySet<string>;
  readonly descriptionTokens: ReadonlySet<string>;
  readonly expectedTokens: ReadonlySet<string>;
  readonly actualTokens: ReadonlySet<string>;
  readonly rootCauseTokens: ReadonlySet<string>;
  readonly locations: readonly NormalizedLocation[];
  readonly evidenceFingerprints: readonly string[];
  readonly sortKey: string;
}

function fingerprintEvidence(evidence: Evidence): string {
  switch (evidence.type) {
    case 'code_reference':
      return (
        'code:' +
        normalizePath(evidence.codeReference.relativePath) +
        ':' +
        (evidence.codeReference.startLine ?? '') +
        '-' +
        (evidence.codeReference.endLine ?? '') +
        ':' +
        (evidence.codeReference.contentHash ?? '') +
        ':' +
        (evidence.codeReference.sourceState ?? '')
      );
    case 'command':
      return (
        'cmd:' +
        normalizeText(evidence.command.command) +
        ':exit=' +
        evidence.command.exitCode +
        ':ops=' +
        [...evidence.groundingOperationIds].sort().join(',')
      );
    case 'test':
      return (
        'test:' +
        normalizeText(evidence.test.framework) +
        ':' +
        normalizeText(evidence.test.name) +
        ':' +
        evidence.test.status +
        ':ops=' +
        [...evidence.groundingOperationIds].sort().join(',')
      );
    case 'runtime':
      return (
        'runtime:' +
        normalizeText(evidence.runtime.summary ?? '') +
        ':exit=' +
        (evidence.runtime.exitCode ?? '') +
        ':ops=' +
        [...evidence.groundingOperationIds].sort().join(',')
      );
    case 'log':
      return (
        'log:' +
        normalizeText(evidence.log.source) +
        ':' +
        normalizeText(evidence.log.summary ?? '')
      );
    case 'manual':
      return 'manual:' + normalizeText(evidence.manual.summary).slice(0, 200);
    case 'browser':
      return (
        'browser:' + normalizeText(evidence.browser.actionSummary ?? evidence.browser.url ?? '')
      );
    case 'static_analysis':
      return (
        'static:' +
        normalizeText(evidence.staticAnalysis.tool) +
        ':' +
        normalizeText(evidence.staticAnalysis.ruleId ?? '')
      );
  }
}

export function normalizeFinding(
  finding: Finding,
  evidenceById: ReadonlyMap<string, Evidence>,
): NormalizedFinding {
  const fingerprints = finding.evidenceIds
    .map((id) => evidenceById.get(id))
    .filter((item): item is Evidence => item !== undefined)
    .map(fingerprintEvidence)
    .sort();
  return {
    sourceFindingId: finding.id,
    agentRunId: finding.agentRunId,
    agentStackId: finding.sourceAgentStackId,
    category: finding.category,
    severity: finding.severity,
    confidence: finding.confidence,
    titleTokens: tokenSet(finding.title),
    descriptionTokens: tokenSet(finding.description),
    expectedTokens: tokenSet(finding.expectedBehavior),
    actualTokens: tokenSet(finding.actualBehavior),
    rootCauseTokens: tokenSet(finding.rootCause),
    locations: finding.locations.map((location) => ({
      relativePath: normalizePath(location.relativePath),
      symbol: normalizeSymbol(location.symbol),
      ...(location.startLine === undefined ? {} : { lineStart: location.startLine }),
      ...(location.endLine === undefined ? {} : { lineEnd: location.endLine }),
    })),
    evidenceFingerprints: fingerprints,
    sortKey: finding.id,
  };
}

export function normalizerVersion(): number {
  return NORMALIZER_VERSION;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
