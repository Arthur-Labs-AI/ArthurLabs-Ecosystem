import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseIdentity } from '../contract.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const text = (path) => readFile(join(root, path), 'utf8');
const product = JSON.parse(await text('package.json')).version;

test('stable preparation reports 1.0.0 without a prerelease suffix', () => {
  assert.equal(product, '1.0.0');
});

test('product packages and source reporting fallbacks agree on release version', async () => {
  for (const path of [
    'apps/desktop/package.json',
    'apps/runtime/package.json',
    'apps/cli/package.json',
  ])
    assert.equal(JSON.parse(await text(path)).version, product, path);
  const fallbacks = [
    ['apps/cli/src/index.ts', /QA_VERSION = '([^']+)'/],
    ['apps/runtime/src/runtime.ts', /releaseIdentity\?\.version \?\? '([^']+)'/],
    ['apps/desktop/src/main/cli-server.ts', /options\.productVersion \?\? '([^']+)'/],
    ['scripts/launcher/launcher-logic.mjs', /SENTRY_PRODUCT_VERSION = '([^']+)'/],
    ['scripts/launcher/SentryLauncher.psm1', /\$script:SentryProductVersion = '([^']+)'/],
    ['scripts/launcher/linux/lib/common.sh', /then ver="([^"]+)"; fi/],
    ['apps/runtime/scripts/deploy-wsl-runtime.ps1', /\$product = '([^']+)'/],
  ];
  for (const [path, pattern] of fallbacks)
    assert.equal((await text(path)).match(pattern)?.[1], product, path);
});

test('source launcher titles do not identify the review candidate as the old beta', async () => {
  for (const [path, pattern] of [
    ['scripts/launcher/launcher-logic.mjs', /SENTRY_RELEASE_TITLE = '([^']+)'/],
    ['scripts/launcher/SentryLauncher.psm1', /\$script:SentryReleaseTitle = '([^']+)'/],
  ])
    assert.equal((await text(path)).match(pattern)?.[1], 'Sentry v' + product, path);
  for (const path of [
    'scripts/launcher/commands.ps1',
    'scripts/launcher/commands2.ps1',
    'scripts/launcher/linux/launcher.sh',
    'scripts/launcher/linux/commands/setup.sh',
    'scripts/launcher/linux/commands/status.sh',
  ]) {
    const value = await text(path);
    assert.equal(value.includes('Sentry v0.1 Beta'), false, path);
    assert.ok(value.includes('Sentry v' + product), path);
  }
});

test('stable identity preserves protocol 1 and historical identities remain parseable', async () => {
  const identity = {
    schemaVersion: 1,
    product: 'Sentry',
    version: product,
    sourceCommit: 'a'.repeat(40),
    runtimeProtocol: 1,
  };
  assert.equal(parseIdentity(identity).version, product);
  assert.equal(parseIdentity({ ...identity, version: '0.1.0-beta.1' }).version, '0.1.0-beta.1');
  assert.equal(parseIdentity({ ...identity, version: '1.0.0-rc.1' }).version, '1.0.0-rc.1');
  assert.throws(() => parseIdentity({ ...identity, runtimeProtocol: 2 }));
  assert.match(
    await text('packages/runtime-protocol/src/protocol.ts'),
    /RUNTIME_PROTOCOL_VERSION = 1 as const/,
  );
});
