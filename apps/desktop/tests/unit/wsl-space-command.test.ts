import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import {
  wslSpaceCommand,
  verifyWslSpaceReceipt,
} from '../../src/main/platform/windows/wsl-space-command.js';
import { WSL_SPACE_HELPER } from '../../src/main/platform/windows/wsl-space-helper.js';

const id = '1234567890abcdef1234567890abcdef';
const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
function receipt() {
  const fields = {
    version: 1 as const,
    operationId: id,
    sid: 'S-1-5-21-123-456-789-1001',
    distro: 'Ubuntu',
    disk: 'C:\\fixture\\ext4.vhdx',
    outcome: 'completed' as const,
    message: '',
  };
  const canonical = [
    '1',
    fields.operationId,
    fields.sid,
    fields.distro,
    fields.disk,
    fields.outcome,
    Buffer.from(fields.message).toString('base64'),
  ].join('\n');
  return { ...fields, mac: createHmac('sha256', key).update(canonical).digest('hex') };
}
describe('fixed maintenance command and authenticated receipt', () => {
  it.skipIf(process.platform !== 'win32')(
    'loads the production encoded bootstrap in Windows PowerShell without file execution',
    () => {
      const command = wslSpaceCommand('Inspect', 'Ubuntu', 'C:\\fixture', id, key);
      const library =
        Buffer.from(command, 'base64').toString('utf16le') + " -LibraryOnly\n'bootstrap-loaded'";
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(library, 'utf16le').toString('base64'),
        ],
        {
          encoding: 'utf8',
          timeout: 30000,
          env: { ...process.env, PSModulePath: 'C:\\sentry-nonexistent-module-search-path' },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('bootstrap-loaded');
    },
  );
  it('encodes exactly the trusted helper and opaque arguments within Windows argv limits', () => {
    const command = wslSpaceCommand(
      'Reclaim',
      "Ubuntu';throw 'injected",
      "C:\\profile';throw 'injected",
      id,
      key,
    );
    expect(command.length).toBeLessThan(29000);
    const bootstrap = Buffer.from(command, 'base64').toString('utf16le');
    expect(bootstrap).toContain("$PSModuleAutoLoadingPreference='None'");
    expect(bootstrap).toContain("'Microsoft.PowerShell.Management'");
    expect(bootstrap).toContain("'Microsoft.PowerShell.Utility'");
    const compressed = bootstrap.match(/\$p='([A-Za-z0-9+/=]+)'/)![1]!;
    expect(gunzipSync(Buffer.from(compressed, 'base64')).toString()).toBe(WSL_SPACE_HELPER);
    expect(bootstrap).not.toContain("throw 'injected");
    expect(bootstrap).not.toContain('-File');
  });
  it('accepts only a correlated, authenticated completed outcome', () => {
    expect(() => verifyWslSpaceReceipt(receipt(), id, 'Ubuntu', key)).not.toThrow();
  });
  it.each(['operationId', 'sid', 'distro', 'disk', 'outcome', 'message', 'mac'] as const)(
    'rejects a tampered %s field',
    (field) => {
      expect(() =>
        verifyWslSpaceReceipt(
          {
            ...receipt(),
            [field]:
              field === 'operationId'
                ? 'f'.repeat(32)
                : field === 'mac'
                  ? '0'.repeat(64)
                  : field === 'sid'
                    ? 'S-1-5-21-999-456-789-1001'
                    : field === 'disk'
                      ? 'D:\\fixture\\other.vhdx'
                      : field === 'outcome'
                        ? 'failed'
                        : 'tampered',
          },
          id,
          'Ubuntu',
          key,
        ),
      ).toThrow();
    },
  );
  it('rejects extra fields, truthy legacy acknowledgements, replay and another key', () => {
    expect(() => verifyWslSpaceReceipt({ ...receipt(), ok: true }, id, 'Ubuntu', key)).toThrow();
    expect(() => verifyWslSpaceReceipt({ ok: 'true' }, id, 'Ubuntu', key)).toThrow();
    expect(() => verifyWslSpaceReceipt(receipt(), 'f'.repeat(32), 'Ubuntu', key)).toThrow();
    expect(() => verifyWslSpaceReceipt(receipt(), id, 'Ubuntu', Buffer.alloc(32))).toThrow();
  });
});
