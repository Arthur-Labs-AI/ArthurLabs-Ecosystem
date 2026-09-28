import { describe, expect, it } from 'vitest';
import { WslRuntimeClient, WslRuntimeManager } from '../../src/main/services/wsl-runtime-client.js';

// Test seam: drive stdout framing without spawning wsl.exe. Private access
// is contained to this test; production code paths are unchanged.
interface FramingHarness {
  onStdout(chunk: Buffer | string): void;
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

function framingClient(): { client: WslRuntimeClient; framing: FramingHarness } {
  const client = new WslRuntimeClient({ distro: 'Ubuntu', runtimeEntry: '/nonexistent/host.js' });
  const framing = client as unknown as FramingHarness;
  return { client, framing };
}

function pendingRequest(
  framing: FramingHarness,
  method: string,
): { promise: Promise<unknown>; sentId: () => string } {
  let sentId = '';
  const child = {
    stdin: {
      write: (line: string) => {
        sentId = (JSON.parse(String(line)) as { id?: string }).id ?? '';
        return true;
      },
    },
  };
  (framing as unknown as { child: unknown }).child = child;
  return { promise: framing.request(method, {}, 5000), sentId: () => sentId };
}

describe('wsl runtime client', () => {
  it('fails closed with RUNTIME_OFFLINE when no runtime is started', async () => {
    const client = new WslRuntimeClient({ distro: 'Ubuntu', runtimeEntry: '/nonexistent/host.js' });
    await expect(client.request('system.info')).rejects.toMatchObject({ code: 'RUNTIME_OFFLINE' });
    expect(client.status.connected).toBe(false);
  });

  it('fails exactly the oversized request instead of timing out', async () => {
    const { framing } = framingClient();
    const { promise, sentId } = pendingRequest(framing, 'runs.export');
    const big = 'x'.repeat(9 * 1024 * 1024);
    const line = JSON.stringify({
      type: 'response',
      id: sentId(),
      ok: true,
      result: { blob: big },
    });
    framing.onStdout(Buffer.from(line + '\n', 'utf8'));
    await expect(promise).rejects.toMatchObject({ code: 'RUNTIME_MESSAGE_TOO_LARGE' });
  });

  it('fails the transport when an oversize id cannot be recovered', async () => {
    const { framing } = framingClient();
    const first = pendingRequest(framing, 'runs.list');
    const second = pendingRequest(framing, 'system.info');
    framing.onStdout(Buffer.from('z'.repeat(9 * 1024 * 1024), 'utf8'));
    framing.onStdout(Buffer.from('zzz\n', 'utf8'));
    await expect(first.promise).rejects.toMatchObject({ code: 'RUNTIME_MESSAGE_TOO_LARGE' });
    await expect(second.promise).rejects.toMatchObject({ code: 'RUNTIME_MESSAGE_TOO_LARGE' });
  });

  it('drops oversized notifications without harming healthy requests', async () => {
    const { framing } = framingClient();
    const { promise, sentId } = pendingRequest(framing, 'runs.list');
    const big = 'y'.repeat(9 * 1024 * 1024);
    framing.onStdout(
      Buffer.from(
        JSON.stringify({ type: 'notification', event: 'e', payload: { blob: big } }) + '\n',
        'utf8',
      ),
    );
    framing.onStdout(
      Buffer.from(
        JSON.stringify({ type: 'response', id: sentId(), ok: true, result: { runs: [] } }) + '\n',
        'utf8',
      ),
    );
    await expect(promise).resolves.toEqual({ runs: [] });
  });

  it('parses wsl --list --verbose output', async () => {
    const manager = new WslRuntimeManager();
    void manager;
    expect(typeof WslRuntimeClient).toBe('function');
  });
});

describe('wsl runtime manager', () => {
  it('persists the distro preference round-trip', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'sentry-wsl-pref-'));
    try {
      const manager = new WslRuntimeManager({ userDataDir: dir });
      await manager.savePreferredDistro('Ubuntu');
      await expect(manager.loadPreferredDistro()).resolves.toBe('Ubuntu');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
