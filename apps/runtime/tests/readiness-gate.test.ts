import { describe, expect, it } from 'vitest';
import { evaluateDeepseekGate, evaluateGlmGate, evaluateOpencodeGate } from '../src/runtime.js';

const OC_SANDBOX = { systemdUser: true, bubblewrap: true, masking: true };

const OC_BASE = {
  credential: true,
  credentialName: 'OPENCODE_API_KEY',
  model: true,
  executable: '/data/sentry/tools/opencode/node_modules/.bin/opencode',
  exists: true,
  version: 'opencode version 1.18.32',
  versionPolicy: 'ready' as const,
  testedVersion: '1.18.32',
  sandboxBypassed: false,
  sandbox: OC_SANDBOX,
  functionalSystemd: true,
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
  endpointValid: true,
  endpointReason: '',
  executable: '/home/u/.local/share/sentry/tools/claude-code/node_modules/.bin/claude',
  windowsMounted: false,
  version: '2.1.270 (Claude Code)',
  versionPolicy: 'ready' as const,
  testedVersion: '2.1.270',
  socat: true,
  bwrap: true,
  sandboxInitOk: true,
  sandboxDetail: 'smoke passed',
  systemdOk: true,
};

describe('pre-run gate: GLM hard local readiness', () => {
  it('endpoint missing -> ready=false', () => {
    const verdict = evaluateGlmGate({
      ...GLM_BASE,
      endpointValid: false,
      endpointReason: 'GLM provider endpoint is not configured',
    });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('endpoint is not configured');
  });

  it('endpoint invalid (default Anthropic route) -> ready=false', () => {
    const verdict = evaluateGlmGate({
      ...GLM_BASE,
      endpointValid: false,
      endpointReason: 'GLM provider endpoint must not use api.anthropic.com',
    });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('api.anthropic.com');
  });

  it('valid endpoint -> endpoint check passes', () => {
    const verdict = evaluateGlmGate(GLM_BASE);
    expect(verdict.ready).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it('tested Claude version -> no version warning/block', () => {
    const verdict = evaluateGlmGate(GLM_BASE);
    expect(verdict.ready).toBe(true);
    expect(verdict.warnings).toEqual([]);
  });

  it('known bad version -> ready=false', () => {
    const verdict = evaluateGlmGate({
      ...GLM_BASE,
      version: '2.1.276',
      versionPolicy: 'blocked' as const,
    });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('known-incompatible');
    expect(verdict.warnings).toEqual([]);
  });

  it('unknown newer version -> ready=true with warning present', () => {
    const verdict = evaluateGlmGate({
      ...GLM_BASE,
      version: '2.1.999',
      versionPolicy: 'unverified' as const,
    });
    expect(verdict.ready).toBe(true);
    expect(verdict.warnings.length).toBeGreaterThan(0);
    expect(verdict.warnings.join(';')).toContain('unverified');
  });

  it('Windows-mounted Claude -> ready=false', () => {
    const verdict = evaluateGlmGate({
      ...GLM_BASE,
      executable: '/mnt/c/tools/claude',
      windowsMounted: true,
    });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('Windows mount');
  });

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

  it('systemd user unavailable -> not ready', () => {
    const verdict = evaluateGlmGate({ ...GLM_BASE, systemdOk: false });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('systemd user isolation unavailable');
  });

  it('all hard prerequisites true with runtimeVerified=false -> ready for first run', () => {
    const verdict = evaluateGlmGate(GLM_BASE);
    expect(verdict.ready).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });
});

describe('pre-run gate: OpenCode hard local readiness', () => {
  it('credential/model/binary good but bwrap unavailable -> ready=false', () => {
    const verdict = evaluateOpencodeGate({
      ...OC_BASE,
      sandbox: { systemdUser: true, bubblewrap: false, masking: true },
    });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('bubblewrap sandbox unavailable');
  });

  it('bwrap binary exists but functional init fails -> ready=false', () => {
    const verdict = evaluateOpencodeGate({
      ...OC_BASE,
      sandbox: { systemdUser: true, bubblewrap: true, masking: true },
      functionalSystemd: false,
    });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('systemd user isolation unavailable');
  });

  it('systemd user unavailable -> ready=false', () => {
    const verdict = evaluateOpencodeGate({
      ...OC_BASE,
      sandbox: { systemdUser: false, bubblewrap: true, masking: true },
      functionalSystemd: false,
    });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('systemd user isolation unavailable');
  });

  it('masking unavailable -> ready=false', () => {
    const verdict = evaluateOpencodeGate({
      ...OC_BASE,
      sandbox: { systemdUser: true, bubblewrap: true, masking: false },
    });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('masking unavailable');
  });

  it('credential/model set but binary missing -> not ready', () => {
    const verdict = evaluateOpencodeGate({ ...OC_BASE, exists: false, version: undefined });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('not found');
  });

  it('explicit bad override fails closed (no silent fallback)', () => {
    const verdict = evaluateOpencodeGate({
      ...OC_BASE,
      executable: '/custom/opencode',
      exists: false,
      version: undefined,
    });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('/custom/opencode');
  });

  it('all hard prerequisites true with runtimeVerified=false -> ready for first run', () => {
    expect(evaluateOpencodeGate(OC_BASE).ready).toBe(true);
  });

  it('dev bypass warns instead of blocking sandbox legs', () => {
    const verdict = evaluateOpencodeGate({
      ...OC_BASE,
      sandboxBypassed: true,
      sandbox: undefined,
      functionalSystemd: true,
    });
    expect(verdict.ready).toBe(true);
    expect(verdict.warnings.join(';')).toContain('ALLOW_DIRECT');
  });

  it('managed binary missing but PATH form resolves -> evaluated, not skipped', () => {
    const verdict = evaluateOpencodeGate({
      ...OC_BASE,
      executable: 'opencode',
      exists: true,
      version: 'opencode version 1.18.32',
      versionPolicy: 'ready' as const,
    });
    expect(verdict.ready).toBe(true);
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

  it('vendor package version mismatch -> not ready', () => {
    const verdict = evaluateDeepseekGate({ ...DS_BASE, dshPackageVersion: '0.1.4' });
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(';')).toContain('SDK pin');
  });

  it('healthy wrapper with resolvable runtime and unverified live session -> first run allowed', () => {
    expect(evaluateDeepseekGate(DS_BASE).ready).toBe(true);
  });
});
