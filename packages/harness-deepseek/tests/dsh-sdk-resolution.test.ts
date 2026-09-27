import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { DEEPSEEK_SDK_VERSION } from '../src/sdk.js';

const requirePkg = createRequire(import.meta.url);

describe('vendor SDK self-resolution (no mocks, no spawn, no network)', () => {
  it('E: constructing a harness without dshBin resolves the pinned runtime (would throw if unresolvable)', async () => {
    // resolveDshLaunch runs inside the constructor and version-checks the
    // manifests: success proves local resolvability, not a live startup.
    // No subprocess is spawned and no provider request is made here.
    const harness = new DeepSeekHarness({});
    expect(harness).toBeDefined();
    await harness.close();
  });

  it('F: installed dsh package version matches the harness pin', () => {
    const manifest = requirePkg('@deepseek-ai/dsh/package.json') as { version?: unknown };
    expect(manifest.version).toBe(DEEPSEEK_SDK_VERSION);
  });
});
