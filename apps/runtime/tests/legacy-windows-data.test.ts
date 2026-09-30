import { afterEach, describe, expect, it, vi } from 'vitest';
import { legacyWindowsCandidates } from '../src/runtime.js';

/** Paths the probe attempted (sees only the fs seam, never real disks). */
const probed: string[] = [];

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: async (path: unknown) => {
      probed.push(String(path));
      throw new Error('no such file');
    },
  };
});

const { SentryRuntimeHost } = await import('../src/runtime.js');

const WSL_ENV = { WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/WSL/interop' };

function withoutWslMarkers<T>(run: () => Promise<T>): Promise<T> {
  const savedDistro = process.env['WSL_DISTRO_NAME'];
  const savedInterop = process.env['WSL_INTEROP'];
  delete process.env['WSL_DISTRO_NAME'];
  delete process.env['WSL_INTEROP'];
  return run().finally(() => {
    if (savedDistro !== undefined) process.env['WSL_DISTRO_NAME'] = savedDistro;
    if (savedInterop !== undefined) process.env['WSL_INTEROP'] = savedInterop;
  });
}

async function tempHost(): Promise<{
  host: InstanceType<typeof SentryRuntimeHost>;
  dataRoot: string;
}> {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dataRoot = await mkdtemp(join(tmpdir(), 'sentry-legacy-wsl-'));
  const host = new SentryRuntimeHost(join(dataRoot, 'data'), () => undefined);
  await host.recover();
  return { host, dataRoot };
}

afterEach(() => {
  probed.length = 0;
});

describe('legacy windows data probing', () => {
  it('builds no candidates outside WSL', () => {
    expect(legacyWindowsCandidates(false)).toEqual([]);
  });

  it('builds the /mnt/c and /mnt/d candidates under WSL', () => {
    expect(legacyWindowsCandidates(true)).toEqual([
      '/mnt/c/Temp/sentry-live-data/sentry.db',
      '/mnt/c/Sentry/.sentry-live/sentry.db',
      '/mnt/d/Temp/sentry-live-data/sentry.db',
      '/mnt/d/Sentry/.sentry-live/sentry.db',
    ]);
  });

  it('skips the /mnt probe on native Linux', async () => {
    await withoutWslMarkers(async () => {
      const { host, dataRoot } = await tempHost();
      try {
        const report = (await host.legacyWindowsData()) as {
          detected: string[];
          migrated: boolean;
          note: string;
        };
        expect(report).toMatchObject({ detected: [], migrated: false });
        expect(report.note).toContain('No legacy Windows-runtime data detected.');
        expect(probed).toEqual([]);
      } finally {
        host.close();
        const { rm } = await import('node:fs/promises');
        await rm(dataRoot, { recursive: true, force: true });
      }
    });
  });

  // Needs real Linux: the runtime WSL probe reads process.platform and
  // /proc/version alongside env markers, which cannot be faked on Windows.
  // Ubuntu CI executes this; the pure candidate tests above run everywhere.
  it.runIf(process.platform === 'linux')(
    'probes the legacy locations under WSL markers',
    async () => {
      process.env['WSL_DISTRO_NAME'] = WSL_ENV.WSL_DISTRO_NAME;
      process.env['WSL_INTEROP'] = WSL_ENV.WSL_INTEROP;
      try {
        const { host, dataRoot } = await tempHost();
        try {
          const report = (await host.legacyWindowsData()) as {
            detected: string[];
            migrated: boolean;
          };
          expect(report).toMatchObject({ detected: [], migrated: false });
          expect(probed).toEqual(legacyWindowsCandidates(true));
        } finally {
          host.close();
          const { rm } = await import('node:fs/promises');
          await rm(dataRoot, { recursive: true, force: true });
        }
      } finally {
        delete process.env['WSL_DISTRO_NAME'];
        delete process.env['WSL_INTEROP'];
      }
    },
  );
});
