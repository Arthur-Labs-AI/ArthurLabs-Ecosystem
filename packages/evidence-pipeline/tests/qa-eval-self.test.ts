import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateFixtureReport, type QaEvalGroundTruth } from '../src/index.js';

async function selfFixture() {
  const raw = await readFile(
    join(process.cwd(), 'tests', 'fixtures', 'qa-eval', 'sentry-self-known-defects.json'),
    'utf8',
  );
  const truth = JSON.parse(raw) as QaEvalGroundTruth;
  const fixture = truth.fixtures[0];
  if (fixture === undefined) throw new Error('missing sentry-self fixture');
  return fixture;
}

const evidence = [
  {
    key: 'e1',
    type: 'command',
    strength: 'reproduced_behavior',
    description: 'Probe output.',
    operationKey: 'op_1',
  },
];

/** The two findings run_01M6BV04 reported, as the report agent worded them. */
const REAL_FINDINGS = [
  {
    title:
      'Snapshot backslash filenames collapse into slash paths causing manifest collision and wrong restore',
    category: 'logic',
    severity: 'medium',
    confidence: 'confirmed',
    description:
      'On Linux a file named back\\slash.txt is recorded as back/slash.txt, duplicating a real nested path and restoring as a nested dir/file instead of the original name.',
    locations: [{ relativePath: 'packages/persistence/src/filesystem.ts' }],
    evidenceKeys: ['e1'],
    reproductionSteps: ['run walkTree probe'],
  },
  {
    title:
      'Workspace cleanup deletes arbitrary inside-root paths instead of refusing non-workspace shapes',
    category: 'security',
    severity: 'medium',
    confidence: 'confirmed',
    description:
      'cleanup() removes dataRoot itself and inner managed-copy dirs, contradicting only-removes-workspace-shaped-parent. Non-workspace-shaped paths are removed with cleaned:true.',
    locations: [{ relativePath: 'packages/workspace-factory/src/index.ts' }],
    evidenceKeys: ['e1'],
    reproductionSteps: ['call cleanup with the data root'],
  },
];

describe('recall against the Sentry self-test manifest', () => {
  it('scores the real run_01M6BV04 findings as both known defects detected', async () => {
    const result = evaluateFixtureReport(
      { findings: REAL_FINDINGS, evidence, checks: [], limitations: [] } as never,
      await selfFixture(),
    );
    expect(result.detected.sort()).toEqual([
      'S1-backslash-filename-collapse',
      'S2-cleanup-no-shape-check',
    ]);
    expect(result.missed).toEqual([]);
  });

  it('scores an all-green report (runs 01M6BWBR, 01M6BY1N, 01M6BZF9) as zero recall', async () => {
    const result = evaluateFixtureReport(
      { findings: [], evidence: [], checks: [], limitations: [] } as never,
      await selfFixture(),
    );
    expect(result.detected).toEqual([]);
    expect(result.missed.sort()).toEqual([
      'S1-backslash-filename-collapse',
      'S2-cleanup-no-shape-check',
    ]);
  });

  it('does not credit a finding that only mentions the file', async () => {
    const result = evaluateFixtureReport(
      {
        findings: [
          {
            title: 'Unrelated style issue',
            category: 'logic',
            severity: 'low',
            confidence: 'probable',
            description: 'Naming in this file is inconsistent.',
            locations: [{ relativePath: 'packages/persistence/src/filesystem.ts' }],
            evidenceKeys: ['e1'],
            reproductionSteps: [],
          },
        ],
        evidence,
        checks: [],
        limitations: [],
      } as never,
      await selfFixture(),
    );
    expect(result.detected).toEqual([]);
  });
});
