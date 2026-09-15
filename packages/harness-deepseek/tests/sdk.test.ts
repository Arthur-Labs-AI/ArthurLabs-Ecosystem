import { describe, expect, it, vi } from 'vitest';
import { createDeepSeekClientFromHarness } from '../src/sdk.js';

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
});
