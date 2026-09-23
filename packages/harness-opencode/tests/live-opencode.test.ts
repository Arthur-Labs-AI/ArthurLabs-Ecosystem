import { describe, expect, it } from 'vitest';
import { doctorOpenCode, OPENCODE_TESTED_VERSION } from '../src/index.js';

// Opt-in live smoke: never runs in normal CI (no provider credit spent by
// default). Enable with:
//   SENTRY_LIVE_OPENCODE=1 OPENROUTER_API_KEY=... SENTRY_OPENCODE_MODEL=... pnpm --filter @qa/harness-opencode test
// The cheap path verifies binary + config only. A real headless turn runs
// only with SENTRY_LIVE_OPENCODE_RUN=1 (spends OpenRouter credit).
const LIVE = process.env['SENTRY_LIVE_OPENCODE'] === '1';
const LIVE_RUN = process.env['SENTRY_LIVE_OPENCODE_RUN'] === '1';

describe('live OpenCode smoke (opt-in)', () => {
  it('doctor sees the real OpenCode binary and configured model', async () => {
    if (!LIVE) return;
    const result = await doctorOpenCode();
    expect(result.modelId).toBe(process.env['SENTRY_OPENCODE_MODEL']);
    expect(result.credentialConfigured).toBe(true);
    expect(result.binaryAvailable).toBe(true);
    console.log(
      'live opencode: version=' +
        (result.executableVersion ?? 'unknown') +
        ' tested=' +
        OPENCODE_TESTED_VERSION,
    );
  });

  it('runs one minimal headless turn', async () => {
    if (!LIVE || !LIVE_RUN) return;
    const { OpenCodeHarnessAdapter } = await import('../src/index.js');
    const adapter = new OpenCodeHarnessAdapter({});
    const metadata = await adapter.getMetadata();
    expect(metadata.adapterId).toBe('opencode');
    await adapter.dispose();
  });
});
