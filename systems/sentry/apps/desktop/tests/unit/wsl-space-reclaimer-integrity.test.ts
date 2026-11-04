import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { WslSpaceReclaimer } from '../../src/main/platform/windows/wsl-space-reclaimer.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
const roots: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function output(value: unknown) {
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify(value)));
      child.emit('close', 0);
    });
    return child as never;
  });
}
async function reclaimer() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-reclaimer-integrity-'));
  roots.push(root);
  return new WslSpaceReclaimer(root);
}
describe.skipIf(process.platform !== 'win32')('Windows reclaimer integrity', () => {
  it('executes fixed inline code without any writable helper-file launch', async () => {
    output({ distro: 'Ubuntu', diskBytes: 10, windowsFreeBytes: 100 });
    await (await reclaimer()).inspect('Ubuntu');
    const argv = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(argv).not.toContain('-File');
    expect(argv).toContain('-EncodedCommand');
    expect(argv.join(' ').length).toBeLessThan(30000);
  });

  it('rejects apparently successful measurements with an uncorrelated unsigned receipt', async () => {
    output({
      distro: 'Ubuntu',
      diskBytesBefore: 10,
      diskBytesAfter: 5,
      windowsFreeBytesBefore: 100,
      windowsFreeBytesAfter: 105,
      receipt: {
        ok: true,
        operationId: 'another-operation',
        outcome: 'completed',
        mac: '0'.repeat(64),
      },
    });
    await expect((await reclaimer()).reclaim('Ubuntu')).rejects.toThrow();
  });
});
