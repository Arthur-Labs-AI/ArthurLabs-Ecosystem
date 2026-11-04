import { describe, expect, it, vi } from 'vitest';
import { createDeepSeekClientFromHarness } from '../src/sdk.js';
import { buildRestrictedProfilePatch } from '../src/profile.js';

describe('production DeepSeek client facade', () => {
  it('forwards live root events before idle and ignores status notifications', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(
      async (
        _text: string,
        options: {
          sessionId: string;
          onNotification?: (value: { method: string; params: Record<string, unknown> }) => void;
        },
      ) => {
        options.onNotification?.({
          method: 'session.event',
          params: { sessionId: 'session-1', event: { type: 'tool/call', data: { name: 'read' } } },
        });
        options.onNotification?.({
          method: 'session.status',
          params: { sessionId: 'session-1', status: 'running' },
        });
        await gate;
        return { sessionId: 'session-1', finalResponse: 'done', events: [], notifications: [] };
      },
    );
    const client = createDeepSeekClientFromHarness({
      start: async () => {},
      run,
      close: async () => {},
    });
    const session = await client.startSession({ sessionId: 'session-1' });
    const events: unknown[] = [];
    const pending = session.runText('work', undefined, (event) => events.push(event));
    try {
      expect(events).toEqual([{ type: 'tool/call', data: { name: 'read' } }]);
    } finally {
      release();
      await pending;
    }
  });
  it('turns child-session activity into a delegation violation without forwarding its payload', async () => {
    const client = createDeepSeekClientFromHarness({
      start: async () => {},
      close: async () => {},
      run: async (_text, options) => {
        options.onNotification?.({
          method: 'session.event',
          params: {
            sessionId: 'child',
            event: { type: 'tool/call', data: { secret: 'peer-private-data' } },
          },
        });
        return { sessionId: options.sessionId, finalResponse: '', events: [], notifications: [] };
      },
    });
    const events: unknown[] = [];
    const session = await client.startSession({ sessionId: 'root' });
    await session.runText('work', undefined, (value) => events.push(value));
    expect(events).toEqual([{ type: 'subagent.started', data: {} }]);
    expect(JSON.stringify(events)).not.toContain('peer-private-data');
  });
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
