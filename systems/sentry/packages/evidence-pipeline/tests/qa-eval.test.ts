import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateFixtureReport, evaluateReports, type QaEvalGroundTruth } from '../src/index.js';

async function loadGroundTruth(): Promise<QaEvalGroundTruth> {
  const raw = await readFile(
    join(process.cwd(), 'tests', 'fixtures', 'qa-eval', 'ground-truth.json'),
    'utf8',
  );
  return JSON.parse(raw) as QaEvalGroundTruth;
}

function fixture(id: string, groundTruth: QaEvalGroundTruth) {
  const found = groundTruth.fixtures.find((entry) => entry.id === id);
  if (found === undefined) throw new Error('missing fixture: ' + id);
  return found;
}

function codeEvidence(key: string, strength = 'strong_code_evidence') {
  return {
    key,
    type: 'code_reference',
    strength,
    description: 'Relevant line.',
    relativePath: 'fixture-a-logic/score.ts',
  };
}

function reproducedEvidence(key: string) {
  return {
    key,
    type: 'command',
    strength: 'reproduced_failure',
    description: 'Observed the wrong clamp value.',
    operationKey: 'op_1',
  };
}

describe('deterministic QA evaluation', () => {
  it('counts a location-plus-mechanism finding as a true positive', async () => {
    const groundTruth = await loadGroundTruth();
    const result = evaluateFixtureReport(
      {
        findings: [
          {
            title: 'clampScore upper boundary returns 101',
            category: 'logic',
            severity: 'medium',
            confidence: 'strong',
            description: 'The clamp helper misses its upper bound: values above 100 yield 101.',
            expectedBehavior: 'clampScore(150) === 100',
            actualBehavior: 'clampScore(150) === 101',
            locations: [{ relativePath: 'fixture-a-logic/score.ts' }],
            evidenceKeys: ['a1'],
            reproductionSteps: ['Call clampScore(150)'],
          },
        ],
        evidence: [codeEvidence('a1')],
        checks: [],
        limitations: [],
      } as never,
      fixture('fixture-a-logic', groundTruth),
    );
    expect(result.detected).toEqual(['A1-boundary-clamp']);
    expect(result.missed).toEqual([]);
    expect(result.findings[0]?.verdict).toEqual({
      kind: 'truePositive',
      defectId: 'A1-boundary-clamp',
    });
    expect(result.findings[0]?.sourceOnly).toBe(true);
    expect(result.findings[0]?.overstatedConfidence).toBe(false);
  });

  it('distinguishes reproduced proof from source-only evidence', async () => {
    const groundTruth = await loadGroundTruth();
    const result = evaluateFixtureReport(
      {
        findings: [
          {
            title: 'Boundary clamp off by one above 100',
            category: 'logic',
            severity: 'medium',
            confidence: 'confirmed',
            description: 'Reproduced: clamp yields 101 past the upper boundary.',
            locations: [{ relativePath: 'fixture-a-logic/score.ts' }],
            evidenceKeys: ['cmd1'],
            reproductionSteps: ['node repro.mjs'],
          },
        ],
        evidence: [reproducedEvidence('cmd1')],
        checks: [],
        limitations: [],
      } as never,
      fixture('fixture-a-logic', groundTruth),
    );
    expect(result.findings[0]?.reproduced).toBe(true);
    expect(result.findings[0]?.sourceOnly).toBe(false);
    // Unvalidated reports claim reproduction; only Sentry-validated reports
    // prove it against the frozen ledger.
    expect(result.findings[0]?.reproductionProvenance).toBe('self-reported');
    const trusted = evaluateFixtureReport(
      {
        findings: [
          {
            title: 'Boundary clamp off by one above 100',
            category: 'logic',
            severity: 'medium',
            confidence: 'confirmed',
            description: 'Reproduced: clamp yields 101 past the upper boundary.',
            locations: [{ relativePath: 'fixture-a-logic/score.ts' }],
            evidenceKeys: ['cmd1'],
            reproductionSteps: ['node repro.mjs'],
          },
        ],
        evidence: [reproducedEvidence('cmd1')],
        checks: [],
        limitations: [],
      } as never,
      fixture('fixture-a-logic', groundTruth),
      { trustedProvenance: true },
    );
    expect(trusted.findings[0]?.reproductionProvenance).toBe('sentry-validated');
  });

  it('flags path-only overlap as ambiguous, never as a hit', async () => {
    const groundTruth = await loadGroundTruth();
    const result = evaluateFixtureReport(
      {
        findings: [
          {
            title: 'Helper could use a clearer name',
            category: 'maintainability',
            severity: 'low',
            confidence: 'probable',
            description: 'Style suggestion with no behavioral claim.',
            locations: [{ relativePath: 'fixture-a-logic/score.ts' }],
            evidenceKeys: ['a1'],
            reproductionSteps: [],
          },
        ],
        evidence: [codeEvidence('a1', 'agent_reasoning')],
        checks: [],
        limitations: [],
      } as never,
      fixture('fixture-a-logic', groundTruth),
    );
    expect(result.detected).toEqual([]);
    expect(result.missed).toEqual(['A1-boundary-clamp']);
    expect(result.findings[0]?.verdict.kind).toBe('ambiguous');
  });

  it('marks duplicate, unsupported, overstated, and invalid references', async () => {
    const groundTruth = await loadGroundTruth();
    const result = evaluateFixtureReport(
      {
        findings: [
          {
            title: 'Clamp boundary defect yields 101',
            category: 'logic',
            severity: 'medium',
            confidence: 'strong',
            description: 'Upper clamp boundary is off by one.',
            locations: [{ relativePath: 'fixture-a-logic/score.ts' }],
            evidenceKeys: ['a1'],
            reproductionSteps: [],
          },
          {
            title: 'Same clamp boundary issue restated',
            category: 'logic',
            severity: 'high',
            confidence: 'strong',
            description: 'Duplicate report: values above 100 return 101.',
            locations: [{ relativePath: 'fixture-a-logic/score.ts' }],
            evidenceKeys: ['a1'],
            reproductionSteps: [],
          },
          {
            title: 'Unrelated speculative concern',
            category: 'security',
            severity: 'critical',
            confidence: 'confirmed',
            description: 'Vague worry with no mechanism.',
            locations: [{ relativePath: 'fixture-a-logic/README.md' }],
            evidenceKeys: ['missing'],
            reproductionSteps: [],
          },
        ],
        evidence: [
          // These two matching findings need a real citation to exercise
          // true-positive and duplicate classification. Invalid-only keys
          // are deliberately tested below and must continue to abstain.
          codeEvidence('a1'),
          {
            key: 'm1',
            type: 'manual',
            strength: 'agent_reasoning',
            description: 'Hunch.',
          },
        ],
        checks: [],
        limitations: [],
      } as never,
      fixture('fixture-a-logic', groundTruth),
    );
    expect(result.findings[0]?.verdict).toEqual({
      kind: 'truePositive',
      defectId: 'A1-boundary-clamp',
    });
    expect(result.findings[1]?.verdict).toEqual({
      kind: 'duplicate',
      defectId: 'A1-boundary-clamp',
    });
    expect(result.findings[2]?.verdict.kind).toBe('unsupported');
    expect(result.findings[2]?.invalidEvidenceKeys).toEqual(['missing']);
    expect(result.findings[2]?.overstatedConfidence).toBe(true);
  });

  it('never awards true positives for missing or invalid evidence', async () => {
    const groundTruth = await loadGroundTruth();
    const strongFinding = {
      title: 'Clamp returns 101 above 100',
      category: 'logic',
      severity: 'medium',
      confidence: 'strong',
      description: 'Values above 100 yield 101 in clampScore.',
      locations: [{ relativePath: 'fixture-a-logic/score.ts' }],
      reproductionSteps: [],
    };
    const validEvidence = [codeEvidence('e1')];
    // Exclusively invalid key: ambiguous, never a hit.
    const invalidOnly = evaluateFixtureReport(
      {
        findings: [{ ...strongFinding, evidenceKeys: ['ghost'] }],
        evidence: validEvidence,
        checks: [],
        limitations: [],
      } as never,
      fixture('fixture-a-logic', groundTruth),
    );
    expect(invalidOnly.detected).toEqual([]);
    expect(invalidOnly.findings[0]?.verdict.kind).toBe('ambiguous');
    expect(invalidOnly.findings[0]?.invalidEvidenceKeys).toEqual(['ghost']);
    // Mixed valid and invalid keys: the valid citation sustains the hit.
    const mixed = evaluateFixtureReport(
      {
        findings: [{ ...strongFinding, evidenceKeys: ['e1', 'ghost'] }],
        evidence: validEvidence,
        checks: [],
        limitations: [],
      } as never,
      fixture('fixture-a-logic', groundTruth),
    );
    expect(mixed.detected).toEqual(['A1-boundary-clamp']);
    // An invalid first finding must not consume the defect: the later
    // legitimate finding still earns the true positive (not a duplicate).
    const afterInvalid = evaluateFixtureReport(
      {
        findings: [
          { ...strongFinding, evidenceKeys: ['ghost'] },
          { ...strongFinding, evidenceKeys: ['e1'] },
        ],
        evidence: validEvidence,
        checks: [],
        limitations: [],
      } as never,
      fixture('fixture-a-logic', groundTruth),
    );
    expect(afterInvalid.findings[0]?.verdict.kind).toBe('ambiguous');
    expect(afterInvalid.findings[1]?.verdict).toEqual({
      kind: 'truePositive',
      defectId: 'A1-boundary-clamp',
    });
  });

  it('calibrates confirmed confidence against reproduction evidence', async () => {
    const groundTruth = await loadGroundTruth();
    const base = {
      title: 'Clamp returns 101 above 100',
      category: 'logic',
      severity: 'medium',
      description: 'Values above 100 yield 101 in clampScore.',
      locations: [{ relativePath: 'fixture-a-logic/score.ts' }],
      reproductionSteps: [],
    };
    const source = [codeEvidence('e1')];
    // confirmed + only a source reference: overstated.
    const sourceOnly = evaluateFixtureReport(
      {
        findings: [{ ...base, confidence: 'confirmed', evidenceKeys: ['e1'] }],
        evidence: source,
        checks: [],
        limitations: [],
      } as never,
      fixture('fixture-a-logic', groundTruth),
    );
    expect(sourceOnly.findings[0]?.verdict).toEqual({
      kind: 'truePositive',
      defectId: 'A1-boundary-clamp',
    });
    expect(sourceOnly.findings[0]?.overstatedConfidence).toBe(true);
    // strong + meaningful source evidence: valid.
    const strongSource = evaluateFixtureReport(
      {
        findings: [{ ...base, confidence: 'strong', evidenceKeys: ['e1'] }],
        evidence: source,
        checks: [],
        limitations: [],
      } as never,
      fixture('fixture-a-logic', groundTruth),
    );
    expect(strongSource.findings[0]?.overstatedConfidence).toBe(false);
    // confirmed + self-reported reproduction: not independently confirmed.
    const claimed = evaluateFixtureReport(
      {
        findings: [{ ...base, confidence: 'confirmed', evidenceKeys: ['cmd1'] }],
        evidence: [reproducedEvidence('cmd1')],
        checks: [],
        limitations: [],
      } as never,
      fixture('fixture-a-logic', groundTruth),
    );
    expect(claimed.findings[0]?.overstatedConfidence).toBe(true);
    expect(claimed.findings[0]?.reproductionProvenance).toBe('self-reported');
    // confirmed + Sentry-validated reproduction: valid.
    const validated = evaluateFixtureReport(
      {
        findings: [{ ...base, confidence: 'confirmed', evidenceKeys: ['cmd1'] }],
        evidence: [reproducedEvidence('cmd1')],
        checks: [],
        limitations: [],
      } as never,
      fixture('fixture-a-logic', groundTruth),
      { trustedProvenance: true },
    );
    expect(validated.findings[0]?.overstatedConfidence).toBe(false);
    expect(validated.findings[0]?.reproductionProvenance).toBe('sentry-validated');
    // confirmed + nonexistent evidence: overstated.
    const missing = evaluateFixtureReport(
      {
        findings: [{ ...base, confidence: 'confirmed', evidenceKeys: ['ghost'] }],
        evidence: source,
        checks: [],
        limitations: [],
      } as never,
      fixture('fixture-a-logic', groundTruth),
    );
    expect(missing.findings[0]?.overstatedConfidence).toBe(true);
    // probable + limited evidence: neither inflated nor rejected.
    const modest = evaluateFixtureReport(
      {
        findings: [{ ...base, confidence: 'probable', evidenceKeys: ['ghost'] }],
        evidence: source,
        checks: [],
        limitations: [],
      } as never,
      fixture('fixture-a-logic', groundTruth),
    );
    expect(modest.findings[0]?.overstatedConfidence).toBe(false);
  });

  it('treats clean fixtures with zero findings as valid', async () => {
    const groundTruth = await loadGroundTruth();
    const result = evaluateFixtureReport(
      { findings: [], evidence: [], checks: [], limitations: [] },
      fixture('fixture-d-clean', groundTruth),
    );
    expect(result.detected).toEqual([]);
    expect(result.missed).toEqual([]);
  });

  it('aggregates a multi-fixture summary without inventing metrics', async () => {
    const groundTruth = await loadGroundTruth();
    const report = evaluateReports(
      new Map([
        [
          'fixture-a-logic',
          {
            findings: [],
            evidence: [],
            checks: [{ name: 'run clamp', status: 'not_run' }],
            limitations: ['budget exhausted'],
          },
        ],
        ['fixture-d-clean', { findings: [], evidence: [], checks: [], limitations: [] }],
      ]) as never,
      groundTruth,
    );
    // Absent reports miss every known defect (B1, C1, F1) plus the empty A1
    // report; only the A1 report counts as an incomplete investigation.
    expect(report.summary.missed).toBe(4);
    expect(report.summary.incompleteInvestigations).toBe(1);
    expect(report.summary.detected).toBe(0);
  });
});
