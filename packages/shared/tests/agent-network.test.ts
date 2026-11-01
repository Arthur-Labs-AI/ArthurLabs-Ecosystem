import { describe, expect, it } from 'vitest';
import {
  DEPENDENCY_CACHE_DIRNAME,
  PACKAGE_REGISTRY_HOSTS,
  agentNetworkPromptLines,
  dependencyCacheEnvironment,
  hostMatchesAllowlist,
  webAccessEnabled,
} from '../src/index.js';

describe('agent network policy', () => {
  it('matches exact hosts case-insensitively and rejects look-alikes', () => {
    expect(hostMatchesAllowlist('Registry.NPMJS.org.', PACKAGE_REGISTRY_HOSTS)).toBe(true);
    expect(hostMatchesAllowlist('registry.npmjs.org.evil.com', PACKAGE_REGISTRY_HOSTS)).toBe(false);
    expect(hostMatchesAllowlist('evilregistry.npmjs.org', PACKAGE_REGISTRY_HOSTS)).toBe(false);
    expect(hostMatchesAllowlist('', PACKAGE_REGISTRY_HOSTS)).toBe(false);
    expect(hostMatchesAllowlist('example.com', PACKAGE_REGISTRY_HOSTS)).toBe(false);
  });

  it('matches wildcard patterns on subdomains only', () => {
    expect(hostMatchesAllowlist('a.example.com', ['*.example.com'])).toBe(true);
    expect(hostMatchesAllowlist('example.com', ['*.example.com'])).toBe(false);
    expect(hostMatchesAllowlist('badexample.com', ['*.example.com'])).toBe(false);
  });

  it('allowlists only package-registry style hosts', () => {
    expect(PACKAGE_REGISTRY_HOSTS).toContain('pypi.org');
    expect(PACKAGE_REGISTRY_HOSTS).toContain('crates.io');
    expect(PACKAGE_REGISTRY_HOSTS).not.toContain('*');
    expect(
      PACKAGE_REGISTRY_HOSTS.some((host) => /localhost|127\.|openai|anthropic/.test(host)),
    ).toBe(false);
  });

  it('enables web access only on an explicit true', () => {
    expect(webAccessEnabled(undefined)).toBe(false);
    expect(webAccessEnabled({})).toBe(false);
    expect(webAccessEnabled({ webAccess: false })).toBe(false);
    expect(webAccessEnabled({ webAccess: true })).toBe(true);
  });

  it('points package-manager caches inside the workspace', () => {
    const env = dependencyCacheEnvironment('/data/runs/ws/');
    expect(env['npm_config_cache']).toBe('/data/runs/ws/' + DEPENDENCY_CACHE_DIRNAME + '/npm');
    expect(env['PIP_CACHE_DIR']).toContain('/data/runs/ws/.sentry-cache/');
    expect(env['CARGO_HOME']).toBeUndefined();
    // Binary-downloading postinstalls (Electron etc.) would fail on DNS and break the install.
    expect(env['ELECTRON_SKIP_BINARY_DOWNLOAD']).toBe('1');
    expect(env['PUPPETEER_SKIP_DOWNLOAD']).toBe('1');
    expect(Object.entries(env).every(([, value]) => !value.startsWith('/home'))).toBe(true);
  });

  it('gives identical install guidance and web wording per mode', () => {
    const off = agentNetworkPromptLines({ webAccess: false }).join('\n');
    expect(off).toContain('pnpm install --frozen-lockfile');
    expect(off).toContain('never proof');
    expect(off).toContain('--ignore-scripts');
    expect(off).toContain('Web access is disabled');
    const on = agentNetworkPromptLines({ webAccess: true }).join('\n');
    expect(on).toContain('Web access is enabled');
    const noTools = agentNetworkPromptLines({ webAccess: true, webToolsAvailable: false }).join(
      '\n',
    );
    expect(noTools).toContain('Web access is disabled');
  });
});
