import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalFixturePath,
  evaluateFixtureReport,
  type QaEvalGroundTruth,
} from '../src/index.js';

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

function reference(key: string, relativePath: string) {
  return {
    key,
    type: 'code_reference',
    strength: 'strong_code_evidence',
    description: 'Relevant line.',
    relativePath,
  };
}

function reportFor(
  finding: Record<string, unknown>,
  evidence: Array<Record<string, unknown>>,
  relativePath: string,
) {
  return {
    findings: [
      {
        category: 'logic',
        severity: 'medium',
        confidence: 'probable',
        reproductionSteps: [],
        locations: [{ relativePath }],
        evidenceKeys: evidence.map((item) => item['key']),
        ...finding,
      },
    ],
    evidence,
    checks: [],
    limitations: [],
  } as never;
}

describe('adversarial evaluator cases', () => {
  it('Case A: correct location with a style concern is not a true positive', async () => {
    const groundTruth = await loadGroundTruth();
    const result = evaluateFixtureReport(
      reportFor(
        {
          title: 'Clamp helper should have a clearer name',
          description: 'The clamp function name is confusing; rename it for readability.',
        },
        [reference('e1', 'fixture-a-logic/score.ts')],
        'fixture-a-logic/score.ts',
      ),
      fixture('fixture-a-logic', groundTruth),
    );
    expect(result.detected).toEqual([]);
    expect(result.findings[0]?.verdict.kind).not.toBe('truePositive');
  });

  it('Case B: generic keyword overlap without failure detail is not a true positive', async () => {
    const groundTruth = await loadGroundTruth();
    const result = evaluateFixtureReport(
      reportFor(
        {
          title: 'Possible clamp boundary issue',
          description: 'There may be some kind of clamp boundary concern worth a look.',
        },
        [reference('e1', 'fixture-a-logic/score.ts')],
        'fixture-a-logic/score.ts',
      ),
      fixture('fixture-a-logic', groundTruth),
    );
    expect(result.detected).toEqual([]);
    expect(result.findings[0]?.verdict.kind).not.toBe('truePositive');
  });

  it('Case C: alternative wording of the real failure is recognized', async () => {
    const groundTruth = await loadGroundTruth();
    const result = evaluateFixtureReport(
      reportFor(
        {
          title: 'Cap leaks for big values',
          description: 'Large inputs slip past the cap and come back as 101.',
        },
        [reference('e1', 'fixture-a-logic/score.ts')],
        'fixture-a-logic/score.ts',
      ),
      fixture('fixture-a-logic', groundTruth),
    );
    expect(result.detected).toEqual(['A1-boundary-clamp']);
  });

  it('Case D: correct mechanism at the wrong path is not a true positive', async () => {
    const groundTruth = await loadGroundTruth();
    const result = evaluateFixtureReport(
      reportFor(
        {
          title: 'Checkout charges before authorization',
          description:
            'runCheckout charges the card before verifying authorization; unauthorized callers are charged then rejected with forbidden.',
          expectedBehavior: 'Unauthorized callers are rejected before any charge.',
          actualBehavior: 'Unauthorized callers are charged, then rejected.',
        },
        [reference('e1', 'src/api/router.ts')],
        'src/api/router.ts',
      ),
      fixture('fixture-f-large', groundTruth),
    );
    expect(result.detected).toEqual([]);
    expect(result.findings[0]?.verdict).toEqual({
      kind: 'ambiguous',
      reason:
        'Finding describes the failure mechanism of F1-charge-before-authorize but cites no relevant location; manual review required.',
    });
  });

  it('Case E: two independent descriptions yield one hit and one duplicate', async () => {
    const groundTruth = await loadGroundTruth();
    const result = evaluateFixtureReport(
      {
        findings: [
          {
            title: 'Clamp returns 101 above 100',
            category: 'logic',
            severity: 'medium',
            confidence: 'strong',
            description: 'Values above 100 yield 101.',
            locations: [{ relativePath: 'fixture-a-logic/score.ts' }],
            evidenceKeys: ['e1'],
            reproductionSteps: [],
          },
          {
            title: 'Upper bound off by one in clampScore',
            category: 'logic',
            severity: 'medium',
            confidence: 'strong',
            description: 'The upper boundary is off by one: inputs return 101.',
            locations: [{ relativePath: 'score.ts' }],
            evidenceKeys: ['e1'],
            reproductionSteps: [],
          },
        ],
        evidence: [reference('e1', 'fixture-a-logic/score.ts')],
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
  });

  it('Case F: speculative findings on a clean fixture are unsupported', async () => {
    const groundTruth = await loadGroundTruth();
    const result = evaluateFixtureReport(
      reportFor(
        {
          title: 'Potential integer overflow in double',
          category: 'security',
          severity: 'critical',
          confidence: 'speculative',
          description: 'Doubling numbers might overflow for very large inputs.',
        },
        [
          {
            key: 'e1',
            type: 'manual',
            strength: 'agent_reasoning',
            description: 'Hunch.',
          },
        ],
        'fixture-d-clean/clean.ts',
      ),
      fixture('fixture-d-clean', groundTruth),
    );
    expect(result.detected).toEqual([]);
    expect(result.findings[0]?.verdict.kind).toBe('unsupported');
  });

  it('Case G: confirmed confidence without grounding is flagged', async () => {
    const groundTruth = await loadGroundTruth();
    const result = evaluateFixtureReport(
      reportFor(
        {
          title: 'Definitely broken clamp',
          confidence: 'confirmed',
          description: 'Values above 100 return 101, definitely.',
        },
        [
          {
            key: 'e1',
            type: 'manual',
            strength: 'agent_reasoning',
            description: 'Hunch.',
          },
        ],
        'fixture-a-logic/score.ts',
      ),
      fixture('fixture-a-logic', groundTruth),
    );
    expect(result.findings[0]?.overstatedConfidence).toBe(true);
    expect(result.findings[0]?.reproductionProvenance).toBe('none');
  });

  it('Case H: negated claims about the defect are not true positives', async () => {
    const groundTruth = await loadGroundTruth();
    const result = evaluateFixtureReport(
      reportFor(
        {
          title: 'Clamp handles the upper boundary correctly',
          description: 'clampScore correctly returns 100 for inputs above 100.',
        },
        [reference('e1', 'fixture-a-logic/score.ts')],
        'fixture-a-logic/score.ts',
      ),
      fixture('fixture-a-logic', groundTruth),
    );
    expect(result.detected).toEqual([]);
    expect(result.findings[0]?.verdict.kind).not.toBe('truePositive');
  });
});

describe('fixture path contexts', () => {
  it('matches fixture-root-relative, repo-relative, and Windows paths', async () => {
    const groundTruth = await loadGroundTruth();
    const large = fixture('fixture-f-large', groundTruth);
    for (const candidate of [
      'src/service/checkout.ts',
      'fixture-f-large/src/service/checkout.ts',
      'fixture-f-large\\src\\service\\checkout.ts',
    ]) {
      const result = evaluateFixtureReport(
        reportFor(
          {
            title: 'Checkout charges before authorization',
            description:
              'runCheckout charges the card before verifying authorization; unauthorized callers are charged then rejected with forbidden.',
            expectedBehavior: 'Unauthorized callers are rejected before any charge.',
            actualBehavior: 'Unauthorized callers are charged, then rejected.',
          },
          [reference('e1', candidate)],
          candidate,
        ),
        large,
      );
      expect(result.detected, candidate).toEqual(['F1-charge-before-authorize']);
    }
  });

  it('rejects same-basename paths from unrelated roots', () => {
    const bases = ['fixture-f-large/', ''];
    expect(canonicalFixturePath('examples/service/checkout.ts', bases)).toBe(
      'examples/service/checkout.ts',
    );
    expect(canonicalFixturePath('examples/service/checkout.ts', bases)).not.toBe(
      canonicalFixturePath('fixture-f-large/src/service/checkout.ts', bases),
    );
  });

  it('rejects cross-fixture matches', async () => {
    const groundTruth = await loadGroundTruth();
    const result = evaluateFixtureReport(
      reportFor(
        {
          title: 'Clamp returns 101 above 100',
          description: 'Values above 100 yield 101 in clampScore.',
        },
        [reference('e1', 'fixture-a-logic/score.ts')],
        'fixture-a-logic/score.ts',
      ),
      fixture('fixture-b-auth', groundTruth),
    );
    expect(result.detected).toEqual([]);
    expect(result.findings[0]?.verdict.kind).toBe('unsupported');
  });

  it('gives no credit to traversal or absolute paths', async () => {
    const groundTruth = await loadGroundTruth();
    for (const candidate of [
      '../secret.ts',
      'fixture-f-large/../../etc/passwd',
      '/etc/passwd',
      '',
    ]) {
      const result = evaluateFixtureReport(
        reportFor(
          {
            title: 'Checkout charges before authorization',
            description:
              'runCheckout charges the card before verifying authorization; unauthorized callers are charged then rejected with forbidden.',
            expectedBehavior: 'Unauthorized callers are rejected before any charge.',
            actualBehavior: 'Unauthorized callers are charged, then rejected.',
          },
          [reference('e1', candidate)],
          candidate,
        ),
        fixture('fixture-f-large', groundTruth),
      );
      expect(result.detected, candidate).toEqual([]);
    }
  });

  it('marks evidence-free assertions as ambiguous at best', async () => {
    const groundTruth = await loadGroundTruth();
    const report = reportFor(
      {
        title: 'Clamp returns 101 above 100',
        description: 'Values above 100 yield 101 in clampScore.',
      },
      [reference('e1', 'fixture-a-logic/score.ts')],
      'fixture-a-logic/score.ts',
    );
    report.findings[0].evidenceKeys = [];
    const result = evaluateFixtureReport(report, fixture('fixture-a-logic', groundTruth));
    expect(result.detected).toEqual([]);
    expect(result.findings[0]?.verdict.kind).toBe('ambiguous');
  });
});

describe('mandatory failure markers', () => {
  it('rejects generic checkout authorization observations', async () => {
    const groundTruth = await loadGroundTruth();
    const large = fixture('fixture-f-large', groundTruth);
    for (const description of [
      'The checkout authorization flow should be documented for admins.',
      'Checkout authorization needs clearer documentation.',
      'runCheckout may have authorization risks.',
    ]) {
      const result = evaluateFixtureReport(
        reportFor(
          { title: 'Checkout authorization observation', description },
          [reference('e1', 'src/service/checkout.ts')],
          'src/service/checkout.ts',
        ),
        large,
      );
      expect(result.detected, description).toEqual([]);
      expect(result.findings[0]?.verdict.kind, description).not.toBe('truePositive');
    }
  });

  it('detects the charge-before-authorization failure including paraphrase', async () => {
    const groundTruth = await loadGroundTruth();
    const large = fixture('fixture-f-large', groundTruth);
    for (const description of [
      'runCheckout charges the card before verifying authorization; unauthorized callers are charged then rejected with forbidden.',
      'Unauthorized users get charged first, before any authorization.',
    ]) {
      const result = evaluateFixtureReport(
        reportFor(
          {
            title: 'Checkout charges before authorization',
            description,
            expectedBehavior: 'Unauthorized callers are rejected before any charge.',
            actualBehavior: 'Unauthorized callers are charged, then rejected.',
          },
          [reference('e1', 'src/service/checkout.ts')],
          'src/service/checkout.ts',
        ),
        large,
      );
      expect(result.detected, description).toEqual(['F1-charge-before-authorize']);
    }
  });

  it('does not credit claims that the implementation works correctly', async () => {
    const groundTruth = await loadGroundTruth();
    const result = evaluateFixtureReport(
      reportFor(
        {
          title: 'Checkout correctly authorizes before charging',
          description: 'Checkout correctly authorizes before charging.',
        },
        [reference('e1', 'src/service/checkout.ts')],
        'src/service/checkout.ts',
      ),
      fixture('fixture-f-large', groundTruth),
    );
    expect(result.detected).toEqual([]);
    expect(result.findings[0]?.verdict.kind).not.toBe('truePositive');
  });

  it('retains detection for the B and C known defects', async () => {
    const groundTruth = await loadGroundTruth();
    const auth = evaluateFixtureReport(
      reportFor(
        {
          title: 'Admin export lacks an authorization check',
          description:
            'The /admin/export route returns data without verifying isAdmin; unauthorized callers succeed.',
        },
        [reference('e1', 'fixture-b-auth/server.ts')],
        'fixture-b-auth/server.ts',
      ),
      fixture('fixture-b-auth', groundTruth),
    );
    expect(auth.detected).toEqual(['B1-missing-admin-check']);
    const race = evaluateFixtureReport(
      reportFor(
        {
          title: 'Concurrent reservations double-book the last seat',
          description: 'Two overlapping reserve calls both succeed from a single seat.',
        },
        [reference('e1', 'fixture-c-concurrency/reserve.ts')],
        'fixture-c-concurrency/reserve.ts',
      ),
      fixture('fixture-c-concurrency', groundTruth),
    );
    expect(race.detected).toEqual(['C1-check-then-act-race']);
  });

  it('rejects function-name plus generic risk without failure detail', async () => {
    const groundTruth = await loadGroundTruth();
    const result = evaluateFixtureReport(
      reportFor(
        {
          title: 'clampScore may have boundary risks',
          description: 'The clampScore function may have boundary risks worth reviewing.',
        },
        [reference('e1', 'fixture-a-logic/score.ts')],
        'fixture-a-logic/score.ts',
      ),
      fixture('fixture-a-logic', groundTruth),
    );
    expect(result.detected).toEqual([]);
    expect(result.findings[0]?.verdict.kind).not.toBe('truePositive');
  });
});

describe('evidence trust boundary', () => {
  it('labels unvalidated reproduction claims as self-reported', async () => {
    const groundTruth = await loadGroundTruth();
    const input = {
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
      evidence: [
        {
          key: 'cmd1',
          type: 'command',
          strength: 'reproduced_failure',
          description: 'Observed the wrong clamp value.',
          operationKey: 'op_1',
        },
      ],
      checks: [],
      limitations: [],
    } as never;
    const untrusted = evaluateFixtureReport(input, fixture('fixture-a-logic', groundTruth));
    expect(untrusted.findings[0]?.reproduced).toBe(true);
    expect(untrusted.findings[0]?.reproductionProvenance).toBe('self-reported');
    const trusted = evaluateFixtureReport(input, fixture('fixture-a-logic', groundTruth), {
      trustedProvenance: true,
    });
    expect(trusted.findings[0]?.reproductionProvenance).toBe('sentry-validated');
  });

  it('flags missing evidence and invalid keys without inventing grounding', async () => {
    const groundTruth = await loadGroundTruth();
    const result = evaluateFixtureReport(
      {
        findings: [
          {
            title: 'Clamp returns 101 above 100',
            category: 'logic',
            severity: 'strong',
            confidence: 'strong',
            description: 'Values above 100 yield 101 in clampScore.',
            locations: [{ relativePath: 'unrelated/notes.md' }],
            evidenceKeys: ['ghost'],
            reproductionSteps: [],
          },
        ],
        evidence: [],
        checks: [],
        limitations: [],
      } as never,
      fixture('fixture-a-logic', groundTruth),
    );
    expect(result.findings[0]?.invalidEvidenceKeys).toEqual(['ghost']);
    expect(result.findings[0]?.overstatedConfidence).toBe(true);
    expect(result.findings[0]?.sourceOnly).toBe(false);
  });
});
