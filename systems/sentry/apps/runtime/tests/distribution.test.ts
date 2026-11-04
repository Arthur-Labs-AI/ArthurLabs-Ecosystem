import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runtimeReleaseIdentity } from '../src/distribution.js';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function file(contents?: string) {
  const root = mkdtempSync(join(tmpdir(), 'sentry identity '));
  directories.push(root);
  const path = join(root, 'build-identity.json');
  if (contents !== undefined) writeFileSync(path, contents);
  return pathToFileURL(path);
}
describe('runtime release identity', () => {
  it('keeps legacy source execution without release metadata', () => {
    expect(runtimeReleaseIdentity(file())).toBeUndefined();
  });
  it('reports the actual supplied version and SHA', () => {
    const value = {
      schemaVersion: 1,
      product: 'Sentry',
      version: '0.1.0-beta.1',
      sourceCommit: 'a'.repeat(40),
      runtimeProtocol: 1,
    };
    expect(runtimeReleaseIdentity(file(JSON.stringify(value)))).toEqual(value);
  });
  it('fails closed on malformed metadata rather than inventing source identity', () => {
    expect(() => runtimeReleaseIdentity(file('{'))).toThrow();
    expect(() => runtimeReleaseIdentity(file('{"sourceCommit":"main"}'))).toThrow();
  });
});
