import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyOpenCodeScopeEnvironment,
  buildOpenCodeModelId,
  cleanupOpenCodeRunScope,
  createOpenCodeRunScope,
  createProductionOpenCodeClient,
  doctorOpenCode,
  OPENCODE_TESTED_VERSION,
} from '../src/index.js';

// Opt-in live smoke: never runs in normal CI (no provider credit spent by
// default). Enable with:
//   SENTRY_LIVE_OPENCODE=1 OPENROUTER_API_KEY=... SENTRY_OPENCODE_MODEL=...
//   pnpm --filter @qa/harness-opencode test
// The cheap path verifies binary + config only. A real headless turn runs
// only with SENTRY_LIVE_OPENCODE_RUN=1 (spends a tiny amount of OpenRouter
// credit): it executes the production client path end to end and asserts
// real JSONL parsing (non-empty text, observed session id, clean exit).
const LIVE = process.env['SENTRY_LIVE_OPENCODE'] === '1';
const LIVE_RUN = process.env['SENTRY_LIVE_OPENCODE_RUN'] === '1';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('live OpenCode smoke (opt-in)', () => {
  it('doctor sees the real OpenCode binary and configured model', async () => {
    if (!LIVE) return;
    const result = await doctorOpenCode();
    expect(result.credentialConfigured).toBe(true);
    expect(result.binaryAvailable).toBe(true);
    expect(result.testedVersion).toBe(OPENCODE_TESTED_VERSION);
    console.log(
      'live opencode: version=' +
        (result.executableVersion ?? 'unknown') +
        ' tested=' +
        OPENCODE_TESTED_VERSION,
    );
  });

  it('runs one minimal headless turn through the production path', async () => {
    if (!LIVE || !LIVE_RUN) return;
    const root = await mkdtemp(join(tmpdir(), 'sentry-live-opencode-'));
    roots.push(root);
    await writeFile(join(root, 'README.md'), '# Live probe\n');
    // Production path: file-based auth scope, key in no environment.
    const scope = await createOpenCodeRunScope({
      workspacePath: root,
      runId: 'live-probe',
      apiKey: process.env['OPENROUTER_API_KEY'] ?? '',
    });
    const client = await createProductionOpenCodeClient({
      executable: process.env['SENTRY_OPENCODE_BINARY']?.trim() || 'opencode',
      cwd: root,
      environment: applyOpenCodeScopeEnvironment({ PATH: process.env.PATH ?? '' }, scope),
      modelId: buildOpenCodeModelId(
        process.env['SENTRY_OPENCODE_PROVIDER'],
        process.env['SENTRY_OPENCODE_MODEL'],
      ).effectiveModelId,
      shutdownTimeoutMs: 10_000,
    });
    try {
      const session = await client.startSession();
      const result = await session.runPrompt('Reply with exactly: LIVE-OK', {
        timeoutMs: 300_000,
      });
      expect(result.text).toContain('LIVE-OK');
      expect(result.sessionId).toMatch(/^ses_/);
      expect(result.envelopes).toBeGreaterThan(0);
    } finally {
      await client.close();
      await cleanupOpenCodeRunScope(scope);
    }
  });
});
