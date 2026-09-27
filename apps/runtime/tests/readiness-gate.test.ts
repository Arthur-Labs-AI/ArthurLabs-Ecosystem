import { describe, expect, it } from 'vitest';
import { evaluateDeepseekGate, evaluateGlmGate, evaluateOpencodeGate } from '../src/runtime.js';

const OC_BASE = {
  credential: true,
  credentialName: 'OPENCODE_API_KEY',
  model: true,
  executable: '/data/sentry/tools/opencode/node_modules/.bin/opencode',
  exists: true,
  version: 'opencode version 1.18.32',
  testedVersion: '1.18.32',
  sandboxBwrap: true,
};

const DS_BASE = {
  credential: true,
  model: true,
  wrapperPath: '/data/sentry/tools/deepseek/bin/dsh',
  wrapperExists: true,
  wrapperVersion: '0.1.5-rc.2',
  expectedVersion: '0.1.5-rc.2',
  dshPackageVersion: '0.1.5-rc.2',
};

const GLM_BASE = {
  credential: true,
  model: true,
  executable: '/home/u/.local/share/sentry/tools/claude-code/node_modules/.bin/claude',
  windowsMounted: false,
  version: '2.1.270 (Claude Code)',
  testedVersion: '2.1.270',
  knownBadVersions: ['2.1.276'] as readonly string[],
  socat: true,
  bwrap: true,
  sandboxInitOk: true,
  sandboxDetail: 'smoke passed',
  systemdOk: true,
};

describe('pre-run gate: GLM hard local readiness', () => {
  it('credential+model+binary but socat missing -> not ready, names socat', () => {
    const verdict = evaluateGlmGate({ ...GLM_BASE, socat: false });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('socat is not installed');
  });

  it('socat present but bwrap missing -> not ready, names bubblewrap', () => {
    const verdict = evaluateGlmGate({ ...GLM_BASE, bwrap: false });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('bubblewrap is not installed');
  });

  it('binaries present but init smoke failed -> not ready, names sandbox', () => {
    const verdict = evaluateGlmGate({
      ...GLM_BASE,
      sandboxInitOk: false,
      sandboxDetail: 'user-namespaces-or-mounts-unavailable',
    });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('Claude sandbox unavailable');
  });

  it('all hard prerequisites true with runtimeVerified=false -> ready for first run', () => {
    const verdict = evaluateGlmGate(GLM_BASE);
    expect(verdict.ready).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it('windows-mounted executable is rejected', () => {
    const verdict = evaluateGlmGate({
      ...GLM_BASE,
      executable: '/mnt/c/tools/claude',
      windowsMounted: true,
    });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('Windows mount');
  });

  it('known-incompatible version is rejected', () => {
    const verdict = evaluateGlmGate({ ...GLM_BASE, version: '2.1.276' });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('known-incompatible');
  });
});

describe('pre-run gate: OpenCode hard local readiness', () => {
  it('credential/model set but binary missing -> not ready', () => {
    const verdict = evaluateOpencodeGate({ ...OC_BASE, exists: false, version: undefined });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('not found');
  });

  it('hard sandbox unavailable -> not ready', () => {
    const verdict = evaluateOpencodeGate({ ...OC_BASE, sandboxBwrap: false });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('bubblewrap is not installed');
  });

  it('all hard prerequisites true with runtimeVerified=false -> ready for first run', () => {
    expect(evaluateOpencodeGate(OC_BASE).ready).toBe(true);
  });
});

describe('pre-run gate: DeepSeek hard local readiness', () => {
  it('credential/model set but managed runtime hard failure -> not ready', () => {
    const verdict = evaluateDeepseekGate({
      ...DS_BASE,
      wrapperExists: false,
      wrapperVersion: undefined,
      dshPackageVersion: undefined,
    });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('managed DeepSeek wrapper unavailable');
  });

  it('healthy wrapper with resolvable runtime and unverified live session -> first run allowed', () => {
    expect(evaluateDeepseekGate(DS_BASE).ready).toBe(true);
  });
});
