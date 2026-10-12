import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { assertRuntimeIdentity, sourceUserDataPath } from '../../src/main/distribution.js';

const identity = {
  schemaVersion: 1 as const,
  product: 'Sentry' as const,
  version: '0.1.0-beta.1',
  sourceCommit: 'a'.repeat(40),
  runtimeProtocol: 1 as const,
};
describe('release identity', () => {
  it('preserves the source credential location across product renaming', () => {
    expect(sourceUserDataPath('/appdata')).toBe(join('/appdata', '@qa', 'desktop'));
  });
  it('accepts only the matching release runtime', () => {
    expect(() =>
      assertRuntimeIdentity(identity, {
        runtimeVersion: identity.version,
        sourceCommit: identity.sourceCommit,
      }),
    ).not.toThrow();
    expect(() =>
      assertRuntimeIdentity(identity, {
        runtimeVersion: identity.version,
        sourceCommit: 'b'.repeat(40),
      }),
    ).toThrow('identity mismatch');
    expect(() =>
      assertRuntimeIdentity(identity, {
        runtimeVersion: '0.1.0',
        sourceCommit: identity.sourceCommit,
      }),
    ).toThrow('identity mismatch');
    expect(() => assertRuntimeIdentity(identity, { runtimeVersion: identity.version })).toThrow(
      'identity mismatch',
    );
  });
  it('keeps legacy source runtime compatibility', () => {
    expect(() => assertRuntimeIdentity(undefined, { runtimeVersion: '0.1.0' })).not.toThrow();
  });
});
