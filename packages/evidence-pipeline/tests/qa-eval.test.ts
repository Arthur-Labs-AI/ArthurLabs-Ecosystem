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
            description: 'Duplicate of the clamp boundary report.',
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
