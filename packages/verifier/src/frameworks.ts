/** Deterministic test-framework output parsers (§19). Conservative
 *  by design: only formats safely recognizable without heuristics.
 *  Unknown output yields no identity — never a fabricated match. */

export interface ParsedTestResult {
  readonly framework: 'vitest' | 'jest' | 'pytest' | 'dotnet';
  readonly tests: ReadonlyArray<{ name: string; status: 'passed' | 'failed' | 'skipped' }>;
  readonly failedCount?: number;
  readonly passedCount?: number;
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function parseVitestJest(text: string, framework: 'vitest' | 'jest'): ParsedTestResult | undefined {
  const tests: { name: string; status: 'passed' | 'failed' | 'skipped' }[] = [];
  let failedCount: number | undefined;
  let passedCount: number | undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const tick = /^(✓|×|✗|↓|-)\s+(.*)$/.exec(trimmed);
    if (tick !== null) {
      const mark = tick[1] as string;
      const name = (tick[2] as string).replace(/\(\d+\s*ms\)\s*$/, '').trim();
      if (name.length === 0) continue;
      tests.push({
        name: normalizeName(name),
        status: mark === '✓' ? 'passed' : mark === '↓' || mark === '-' ? 'skipped' : 'failed',
      });
      continue;
    }
    const summary = /^Tests\s+(.*?)$/i.exec(trimmed);
    if (summary !== null) {
      // Both count-first ("1 failed") and colon ("Failed: 0") shapes.
      const failed =
        /(\d+)\s+failed/i.exec(summary[1] as string) ??
        /failed\s*:\s*(\d+)/i.exec(summary[1] as string);
      const passed =
        /(\d+)\s+passed/i.exec(summary[1] as string) ??
        /passed\s*:\s*(\d+)/i.exec(summary[1] as string);
      // "Failed: 0, Passed: 24" must read as passed (§53): counts,
      // never mere word presence (§18).
      if (failed !== null) failedCount = Number(failed[1]);
      if (passed !== null) passedCount = Number(passed[1]);
    }
  }
  if (tests.length === 0 && failedCount === undefined && passedCount === undefined)
    return undefined;
  return {
    framework,
    tests,
    ...(failedCount === undefined ? {} : { failedCount }),
    ...(passedCount === undefined ? {} : { passedCount }),
  };
}

function parsePytest(text: string): ParsedTestResult | undefined {
  const tests: { name: string; status: 'passed' | 'failed' | 'skipped' }[] = [];
  let failedCount: number | undefined;
  let passedCount: number | undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const verbose = /^(.+?)\s+(PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)\s*$/.exec(trimmed);
    if (verbose !== null) {
      const status = verbose[2] as string;
      tests.push({
        name: normalizeName(verbose[1] as string),
        status:
          status === 'PASSED' || status === 'XPASS'
            ? 'passed'
            : status === 'FAILED' || status === 'ERROR'
              ? 'failed'
              : 'skipped',
      });
      continue;
    }
    const dots = /^([.Fsx]+)\s*$/.exec(trimmed);
    if (dots !== null && /^[.Fsx]+$/.test(dots[1] as string) && (dots[1] as string).length >= 3) {
      for (const char of dots[1] as string) {
        tests.push({
          name: 'pytest-dot-' + tests.length,
          status: char === '.' ? 'passed' : char === 'F' ? 'failed' : 'skipped',
        });
      }
      continue;
    }
    const summary = /^(\d+)\s+(failed|passed)/.exec(trimmed);
    if (summary !== null) {
      const count = Number(summary[1]);
      if (summary[2] === 'failed') failedCount = (failedCount ?? 0) + count;
      else passedCount = (passedCount ?? 0) + count;
    }
  }
  if (tests.length === 0 && failedCount === undefined && passedCount === undefined)
    return undefined;
  return {
    framework: 'pytest',
    tests,
    ...(failedCount === undefined ? {} : { failedCount }),
    ...(passedCount === undefined ? {} : { passedCount }),
  };
}

function parseDotnet(text: string): ParsedTestResult | undefined {
  const tests: { name: string; status: 'passed' | 'failed' | 'skipped' }[] = [];
  let failedCount: number | undefined;
  let passedCount: number | undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const result = /^(Passed|Failed|Skipped)\s+([^\[]+?)(?:\s*\[.*?\])?\s*$/.exec(trimmed);
    if (result !== null) {
      const status = result[1] as string;
      tests.push({
        name: normalizeName(result[2] as string),
        status: status === 'Passed' ? 'passed' : status === 'Failed' ? 'failed' : 'skipped',
      });
      continue;
    }
    const summary =
      /^(Passed|Failed)!?\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+)/.exec(
        trimmed,
      );
    if (summary !== null) {
      failedCount = Number(summary[2]);
      passedCount = Number(summary[3]);
    }
  }
  if (tests.length === 0 && failedCount === undefined && passedCount === undefined)
    return undefined;
  return {
    framework: 'dotnet',
    tests,
    ...(failedCount === undefined ? {} : { failedCount }),
    ...(passedCount === undefined ? {} : { passedCount }),
  };
}

/** Try each known parser in fixed order; first recognition wins.
 *  Returns undefined when no framework format is recognizable. */
export function parseTestOutput(text: string): ParsedTestResult | undefined {
  return (
    parseVitestJest(text, 'vitest') ??
    parseVitestJest(text, 'jest') ??
    parsePytest(text) ??
    parseDotnet(text) ??
    undefined
  );
}

/** Identity check (§17): the expected test name must observably appear
 *  among parsed results. Normalized substring match, deterministic. */
export function findTestIdentity(
  parsed: ParsedTestResult,
  expectedName: string,
): { name: string; status: 'passed' | 'failed' | 'skipped' } | undefined {
  const wanted = normalizeName(expectedName);
  if (wanted.length === 0) return undefined;
  return parsed.tests.find((test) => test.name.includes(wanted) || wanted.includes(test.name));
}
