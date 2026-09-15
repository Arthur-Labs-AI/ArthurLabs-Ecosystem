import { describe, expect, it, vi } from 'vitest';
import { createDeepSeekClientFromHarness } from '../src/sdk.js';
import { buildRestrictedProfilePatch } from '../src/profile.js';

describe('production DeepSeek client facade', () => {
  it('exposes the SDK startup handshake separately from session construction', async () => {
    const start = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({ sessionId: 'session-1', finalResponse: '', events: [] }));
    const close = vi.fn(async () => undefined);
    const client = createDeepSeekClientFromHarness({ start, run, close });

    const session = await client.startSession({ sessionId: 'session-1' });
    expect(start).not.toHaveBeenCalled();
    await client.start();
    expect(start).toHaveBeenCalledTimes(1);
    await session.runText('planning');
    expect(run).toHaveBeenCalledWith('planning', { sessionId: 'session-1' });
  });

  it('pins workspace-write containment to the per-run workspace (§26)', () => {
    // workspace-write = full writable QA workspace + host containment.
    // The patch is additive: it sets only the sandbox policy and never
    // unmounts shell/session/model capability from the sdk-minimal base.
    const patch = buildRestrictedProfilePatch('/tmp/sentry-ws/arun-1');
    expect(patch).toContain('mode: workspace-write');
    expect(patch).toContain(JSON.stringify('/tmp/sentry-ws/arun-1'));
    expect(patch).not.toMatch(/mode:\s*(read-only|disabled|off)/);
    const other = buildRestrictedProfilePatch('/tmp/sentry-ws/arun-2');
    expect(other).toContain(JSON.stringify('/tmp/sentry-ws/arun-2'));
    expect(other).not.toContain('/tmp/sentry-ws/arun-1');
  });
});
