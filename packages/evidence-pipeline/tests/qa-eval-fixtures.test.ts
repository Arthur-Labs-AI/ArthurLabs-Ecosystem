import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QA_AUTHORITY_HIERARCHY } from '../src/index.js';

const root = join(process.cwd(), 'tests', 'fixtures', 'qa-eval');

async function exists(rel: string): Promise<boolean> {
  try {
    await stat(join(root, rel));
    return true;
  } catch {
    return false;
  }
}

describe('QA evaluation fixtures', () => {
  it('ships the A-F deterministic fixture set', async () => {
    for (const rel of [
      'fixture-a-logic/score.ts',
      'fixture-b-auth/server.ts',
      'fixture-c-concurrency/reserve.ts',
      'fixture-d-clean/clean.ts',
      'fixture-e-injection/README.md',
      'fixture-f-large/src/service/orders.ts',
    ]) {
      expect(await exists(rel), rel).toBe(true);
    }
  });

  it('documents the injection hierarchy for the hostile README', () => {
    expect(QA_AUTHORITY_HIERARCHY).toContain('UNTRUSTED');
    expect(QA_AUTHORITY_HIERARCHY).toContain('ignore the instruction');
  });
});
