import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { WslRuntimeClient } from '../../src/main/services/wsl-runtime-client.js';
import { WslMaintenance } from '../../src/main/wsl-maintenance.js';

const entry = process.env['SENTRY_WSL_MAINTENANCE_TEST_ENTRY'];
/** Requires an explicitly staged Linux runtime; no owner data or paid providers. */
describe.runIf(process.platform === 'win32' && entry !== undefined)(
  'WSL maintenance real runtime lifecycle',
  () => {
    it('accepts idle shutdown and reconnects the same real transport after host maintenance', async () => {
      const distro = 'Ubuntu';
      const root = execFileSync(
        'wsl.exe',
        ['-d', distro, '--', 'mktemp', '-d', '/var/tmp/sentry-maintenance-lifecycle.XXXXXXXX'],
        { encoding: 'utf8' },
      ).trim();
      expect(root).toMatch(/^\/var\/tmp\/sentry-maintenance-lifecycle\.[A-Za-z0-9]{8}$/);
      const runtime = new WslRuntimeClient({
        distro,
        runtimeEntry: entry!,
        dataRoot: root + '/data',
      });
      await runtime.start();
      const original = runtime.status.hello?.dataRoot;
      let reclaimed = false;
      const controller = new WslMaintenance({
        runtime,
        hostKind: 'windows',
        distro: async () => distro,
        inspect: async () => undefined,
        reclaim: async () => {
          expect(runtime.status.connected).toBe(false);
          reclaimed = true;
          return {
            distro,
            diskBytesBefore: 100,
            diskBytesAfter: 40,
            windowsFreeBytesBefore: 20,
            windowsFreeBytesAfter: 80,
          };
        },
        reconnect: async () => {
          await runtime.start();
        },
        pause: () => undefined,
        resume: () => undefined,
      });
      try {
        await expect(controller.reclaimSpace()).resolves.toMatchObject({ reconnected: true });
        expect(reclaimed).toBe(true);
        expect(runtime.status.hello?.dataRoot).toBe(original);
        await expect(runtime.request('projects.list')).resolves.toEqual([]);
      } finally {
        await runtime.stop();
      }
      // Small fixture is retained to diagnose the real on-disk lease/reopen boundary.
    }, 60000);
  },
);
