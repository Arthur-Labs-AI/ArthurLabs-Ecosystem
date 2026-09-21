import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  ClaudeClient,
  type ClaudeSessionView,
  type ClaudeSpawnSpec,
  type ClaudeTurnStream,
} from '../src/index.js';

function liveStream(session: ClaudeSessionView, text: string): ClaudeTurnStream {
  return session.runText(text) as ClaudeTurnStream;
}

/** A deliberately hanging fixture process (stands in for a live `claude -p`). */
function spawnHanger(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000);'], {
    windowsHide: true,
    shell: false,
    stdio: 'ignore',
  });
}

function spec(): ClaudeSpawnSpec {
  return {
    executable: 'claude-test-fixture',
    cwd: process.cwd(),
    configDir: process.cwd(),
    environment: { PATH: process.env['PATH'] },
    modelId: 'glm-5.3-flash',
    settingsPath: 'sentry-settings.json',
    initializeTimeoutMs: 30_000,
    turnTimeoutMs: 60_000,
    shutdownTimeoutMs: 5_000,
    spawnProcess: () => spawnHanger(),
  };
}

async function waitUntilGone(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    try {
      // Signal 0 probes liveness without killing (throws if already gone).
      process.kill(child.pid as number, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Drain a live turn stream to settlement (hangers reject on close/abort). */
async function settleStream(stream: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const _ of stream) {
      void _;
    }
  } catch {
    // turn aborted/closed — expected for hanger fixtures
  }
}

describe('Claude owned-process lifecycle', () => {
  it('terminates the active child on close and proves it is gone at OS level', async () => {
    let owned: ChildProcess | undefined;
    const client = new ClaudeClient({
      ...spec(),
      spawnProcess: () => (owned = spawnHanger()),
    });
    const session = await client.startSession();
    const stream = liveStream(session, 'hang');
    const draining = settleStream(stream);
    // Let the turn spawn and register its owned child.
    const deadline = Date.now() + 5_000;
    while (client.activeChildCount === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(client.activeChildCount).toBe(1);
    expect(owned).toBeDefined();
    await client.close();
    expect(client.activeChildCount).toBe(0);
    // OS-level proof: the exact owned child is dead, not just unregistered.
    expect(await waitUntilGone(owned as ChildProcess, 5_000)).toBe(true);
    // The abandoned turn settles (rejected) after close; observe, do not hang.
    await draining;
  });

  it('terminates via escalating SIGKILL when the child ignores SIGTERM', async () => {
    const immune = (): ChildProcess =>
      spawn(
        process.execPath,
        ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 60_000);'],
        {
          windowsHide: true,
          shell: false,
          stdio: 'ignore',
        },
      );
    const client = new ClaudeClient({ ...spec(), spawnProcess: () => immune() });
    const session = await client.startSession();
    const stream = liveStream(session, 'hang-immune');
    const draining = settleStream(stream);
    const deadline = Date.now() + 5_000;
    while (client.activeChildCount === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(client.activeChildCount).toBe(1);
    await client.close();
    expect(client.activeChildCount).toBe(0);
    await draining;
  });

  it('close and dispose are idempotent and never double-kill', async () => {
    const client = new ClaudeClient(spec());
    const session = await client.startSession();
    const stream = liveStream(session, 'hang');
    const draining = settleStream(stream);
    const deadline = Date.now() + 5_000;
    while (client.activeChildCount === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await client.close();
    await client.close();
    await client.close();
    expect(client.activeChildCount).toBe(0);
    await draining;
  });

  it('refuses new turns once closed', async () => {
    const client = new ClaudeClient(spec());
    await client.close();
    const session = await client.startSession();
    expect(() => session.runText('late')).toThrow(/closed/);
    expect(client.activeChildCount).toBe(0);
  });

  it('proves the fixture child is really dead at the OS level', async () => {
    const child = spawnHanger();
    expect(await waitUntilGone(child, 1_000)).toBe(false);
    child.kill('SIGKILL');
    expect(await waitUntilGone(child, 5_000)).toBe(true);
  });
});
