// Same Windows account/DPAPI, two real archives, one fresh isolated appData.
// Only synthetic presence is reported; no credentials are read from the owner.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [
  previousArchive,
  previousRuntime,
  nextArchive,
  nextRuntime,
  disposableData,
  historyReceipt = '',
] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.ok(
  previousArchive &&
    previousRuntime &&
    nextArchive &&
    nextRuntime &&
    disposableData?.startsWith('/'),
  'Usage: secure-settings.mjs previousArchive previousLinuxRuntime nextArchive nextLinuxRuntime disposableLinuxData [historyReceipt]',
);
const session = await mkdtemp(join(tmpdir(), 'sentry secure settings '));
const synthetic = 'synthetic-nonproduction-' + randomUUID();
for (const [archive, runtime, mode] of [
  [previousArchive, previousRuntime, 'seed'],
  [nextArchive, nextRuntime, 'verify'],
]) {
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('../smoke.mjs', import.meta.url)),
      archive,
      runtime,
      disposableData,
      historyReceipt,
      mode,
      session,
    ],
    {
      env: { ...process.env, SENTRY_SMOKE_SYNTHETIC: synthetic },
      stdio: 'inherit',
      timeout: 240000,
    },
  );
}
console.log(
  JSON.stringify({
    encryptedSettingsContinuity: 'PASS',
    backend: 'Windows Electron safeStorage (DPAPI)',
    plaintextAbsent: true,
    productionStatus: 'stored/secure',
    sameAccount: true,
    isolatedAppData: session,
  }),
);
