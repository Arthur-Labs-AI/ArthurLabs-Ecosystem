import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenCodeRegistration } from '../src/registration.js';
import {
  describeOpenCodeExecutableFailure,
  doctorOpenCode,
  isExecutableFileSync,
  managedOpenCodeExecutable,
  openCodeCredential,
  openCodeCredentialPresent,
  openCodeProviderSpec,
  openCodeUpstreamBaseUrl,
  resolveOpenCodeExecutable,
} from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function managedFixture(prefix: string): Promise<{ root: string; managed: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const managed = managedOpenCodeExecutable(root);
  await mkdir(join(root, 'tools', 'opencode', 'node_modules', '.bin'), { recursive: true });
  await writeFile(managed, '#!/bin/sh\nexit 0\n');
  try {
    await chmod(managed, 0o700);
  } catch {
    // Windows: best-effort.
  }
  return { root, managed };
}

describe('OpenCode executable discovery', () => {
  it('derives the managed binary from any data root without hardcoding home', async () => {
    expect(managedOpenCodeExecutable('/data/sentry')).toBe(
      join('/data/sentry', 'tools', 'opencode', 'node_modules', '.bin', 'opencode'),
    );
    const { managed } = await managedFixture('sentry-managed-bin-');
    expect(isExecutableFileSync(managed)).toBe(true);
  });

  it('refuses an unverified managed path instead of selecting it blindly', () => {
    const resolved = resolveOpenCodeExecutable({
      environment: { PATH: '/usr/bin:/bin' },
      managedExecutable: '/tmp/sentry-managed-absent/node_modules/.bin/opencode',
    });
    expect(resolved.executable).toBe('opencode');
    expect(resolved.source).toBe('path');
  });

  it('selects a verified managed binary when PATH cannot resolve opencode', async () => {
    const { managed } = await managedFixture('sentry-managed-only-');
    const resolved = resolveOpenCodeExecutable({
      environment: { PATH: '/usr/bin:/bin' },
      managedExecutable: managed,
    });
    expect(resolved.executable).toBe(managed);
    expect(resolved.source).toBe('managed');
  });

  it('prefers explicit overrides over a valid managed installation', async () => {
    const { managed } = await managedFixture('sentry-managed-wins-');
    const explicit = resolveOpenCodeExecutable({
      executable: '/tmp/custom-opencode',
      environment: {},
      managedExecutable: managed,
    });
    expect(explicit.executable).toBe('/tmp/custom-opencode');
    expect(explicit.source).toBe('explicit');
    const fromEnv = resolveOpenCodeExecutable({
      environment: { SENTRY_OPENCODE_BINARY: '/tmp/custom-opencode' },
      managedExecutable: managed,
    });
    expect(fromEnv.executable).toBe('/tmp/custom-opencode');
    expect(fromEnv.source).toBe('environment');
  });

  it('never silently falls back past a broken explicit override', () => {
    const resolved = resolveOpenCodeExecutable({
      environment: { SENTRY_OPENCODE_BINARY: '/missing/opencode' },
      managedExecutable: '/also/missing/opencode',
    });
    expect(resolved.executable).toBe('/missing/opencode');
    expect(resolved.source).toBe('environment');
  });

  it('describes every failed candidate without secrets', () => {
    const text = describeOpenCodeExecutableFailure({
      environment: { OPENROUTER_API_KEY: 'sk-live-secret', PATH: '/usr/bin' },
      managedCandidate: '/data/sentry/tools/opencode/node_modules/.bin/opencode',
    });
    expect(text).toContain('SENTRY_OPENCODE_BINARY: not configured');
    expect(text).toContain('/data/sentry/tools/opencode/node_modules/.bin/opencode');
    expect(text).toContain('PATH');
    expect(text).not.toContain('sk-live-secret');
  });

  it('doctor reports the effective binary with its discovery source', async () => {
    const { managed } = await managedFixture('sentry-doctor-managed-');
    const result = await doctorOpenCode({
      modelId: 'anthropic/claude-test',
      environment: {
        PATH: '/usr/bin:/bin',
        OPENROUTER_API_KEY: 'sentry-test-sentinel-credential',
      },
      managedExecutable: managed,
    });
    const executableCheck = result.checks.find((c) => c.name === 'executable');
    expect(executableCheck?.status).toBe('pass');
    expect(executableCheck?.message).toContain(managed);
    expect(executableCheck?.message).toContain('managed');
    expect(result.executable).toBe(managed);
    expect(result.executableSource).toBe('managed');
    const zenMissing = await doctorOpenCode({
      modelId: 'muse-spark-1.3-contributor-free',
      provider: 'opencode',
      environment: { PATH: '/usr/bin' },
    });
    const zenCredential = zenMissing.checks.find((c) => c.name === 'credential');
    expect(zenCredential?.status).toBe('fail');
    expect(zenCredential?.message).toContain('OPENCODE_API_KEY');
    const zenPresent = await doctorOpenCode({
      modelId: 'muse-spark-1.3-contributor-free',
      provider: 'opencode',
      environment: { PATH: '/usr/bin', OPENCODE_API_KEY: 'zen-test-key' },
    });
    expect(zenPresent.checks.find((c) => c.name === 'credential')?.status).toBe('pass');
    expect(JSON.stringify(zenPresent)).not.toContain('zen-test-key');
  });

  it('observes binary override updates without restart (no stale memoization)', async () => {
    const environment: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      SENTRY_OPENCODE_MODEL: 'anthropic/claude-test',
      OPENROUTER_API_KEY: 'sentry-test-sentinel-credential',
      SENTRY_OPENCODE_BINARY: '/missing/opencode-first',
    };
    const registration = createOpenCodeRegistration({ environment });
    const first = await registration.preflight().then(
      () => 'unexpected-pass',
      (cause: unknown) => String((cause as { message?: unknown }).message ?? cause),
    );
    expect(first).toContain('/missing/opencode-first');
    environment['SENTRY_OPENCODE_BINARY'] = '/missing/opencode-second';
    const second = await registration.preflight().then(
      () => 'unexpected-pass',
      (cause: unknown) => String((cause as { message?: unknown }).message ?? cause),
    );
    expect(second).toContain('/missing/opencode-second');
    expect(second).not.toContain('/missing/opencode-first');
  });

  it('resolves credentials and upstreams per provider', () => {
    expect(openCodeProviderSpec('openrouter')?.credentialEnv).toBe('OPENROUTER_API_KEY');
    expect(openCodeProviderSpec('opencode')?.credentialEnv).toBe('OPENCODE_API_KEY');
    expect(openCodeProviderSpec('opencode')?.upstreamBaseUrl).toBe('https://opencode.ai/zen/v1');
    expect(openCodeProviderSpec('nope')).toBeUndefined();
    const env = { OPENROUTER_API_KEY: 'sk-or-x', OPENCODE_API_KEY: 'zen-key' };
    expect(openCodeCredential('openrouter', env)).toBe('sk-or-x');
    expect(openCodeCredential('opencode', env)).toBe('zen-key');
    expect(openCodeCredentialPresent('opencode', {})).toBe(false);
    expect(openCodeUpstreamBaseUrl('opencode')).toBe('https://opencode.ai/zen/v1');
    expect(openCodeUpstreamBaseUrl('opencode', 'http://localhost:9/v1')).toBe(
      'http://localhost:9/v1',
    );
  });
});
