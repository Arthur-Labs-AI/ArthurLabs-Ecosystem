import { describe, expect, it } from 'vitest';
import {
  buildOpenCodeChildEnvironment,
  buildOpenCodeToolEnvironment,
  OPENCODE_ALLOWED_SECRET_ENV_NAMES,
  OpenCodeHarnessAdapter,
} from '../src/index.js';

// Credential-boundary sentinel tests for the OpenCode harness. Test-only
// sentinels stand in for provider keys (OPENROUTER_API_KEY, OPENCODE_API_KEY).
// Keys travel ONLY in Sentry runtime/proxy memory — never in any child
// environment — so model-controlled shells cannot observe them.
// Never a real credential here.
const SENTINEL_NAME = 'OPENROUTER_API_KEY';
const SENTINEL_VALUE = 'sentry-test-sentinel-credential';
const ZEN_SENTINEL_NAME = 'OPENCODE_API_KEY';
const ZEN_SENTINEL_VALUE = 'sentry-test-sentinel-zen-credential';

describe('OpenCode credential boundary', () => {
  it('allows no secret-bearing names into any child environment', () => {
    expect([...OPENCODE_ALLOWED_SECRET_ENV_NAMES]).toEqual([]);
  });

  it('blocks the sentinel from the OpenCode host environment', () => {
    const child = buildOpenCodeChildEnvironment({
      source: { PATH: '/usr/bin', [SENTINEL_NAME]: SENTINEL_VALUE },
    });
    expect(child.environment[SENTINEL_NAME]).toBeUndefined();
    expect(child.blockedNames).toContain(SENTINEL_NAME);
    expect(JSON.stringify(child.environment)).not.toContain(SENTINEL_VALUE);
  });

  it('blocks the OpenCode Zen key from host and tool environments', () => {
    const child = buildOpenCodeChildEnvironment({
      source: { PATH: '/usr/bin', [ZEN_SENTINEL_NAME]: ZEN_SENTINEL_VALUE },
    });
    expect(child.environment[ZEN_SENTINEL_NAME]).toBeUndefined();
    expect(child.blockedNames).toContain(ZEN_SENTINEL_NAME);
    expect(JSON.stringify(child.environment)).not.toContain(ZEN_SENTINEL_VALUE);
    const tools = buildOpenCodeToolEnvironment({
      PATH: '/usr/bin',
      [ZEN_SENTINEL_NAME]: ZEN_SENTINEL_VALUE,
    });
    expect(tools.environment[ZEN_SENTINEL_NAME]).toBeUndefined();
    expect(JSON.stringify(tools.environment)).not.toContain(ZEN_SENTINEL_VALUE);
  });

  it('blocks user OpenCode control variables and scope-owned HOME/XDG', () => {
    const child = buildOpenCodeChildEnvironment({
      source: {
        PATH: '/usr/bin',
        HOME: '/home/user',
        XDG_DATA_HOME: '/home/user/.local/share',
        OPENCODE_CONFIG_CONTENT: '{"plugin":[]}',
        OPENCODE_PERMISSION: '{"*":"allow"}',
        OPENCODE_DISABLE_PROJECT_CONFIG: '0',
      },
    });
    expect(child.environment['HOME']).toBeUndefined();
    expect(child.environment['XDG_DATA_HOME']).toBeUndefined();
    expect(child.environment['OPENCODE_CONFIG_CONTENT']).toBeUndefined();
    expect(child.environment['OPENCODE_PERMISSION']).toBeUndefined();
    expect(child.environment['OPENCODE_DISABLE_PROJECT_CONFIG']).toBeUndefined();
  });

  it('blocks unrelated secret-shaped names from the host environment', () => {
    const child = buildOpenCodeChildEnvironment({
      source: {
        PATH: '/usr/bin',
        GITHUB_TOKEN: 'sentry-test-sentinel-unrelated',
        AWS_SECRET_ACCESS_KEY: 'sentry-test-sentinel-unrelated',
      },
    });
    expect(child.environment['GITHUB_TOKEN']).toBeUndefined();
    expect(child.environment['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(child.blockedNames).toEqual(
      expect.arrayContaining(['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN']),
    );
  });

  it('keeps the tool environment secret-free', () => {
    const host = buildOpenCodeChildEnvironment({
      source: { PATH: '/usr/bin', [SENTINEL_NAME]: SENTINEL_VALUE },
    }).environment;
    const tool = buildOpenCodeToolEnvironment(host);
    expect(tool.environment[SENTINEL_NAME]).toBeUndefined();
    expect(JSON.stringify(tool.environment)).not.toContain(SENTINEL_VALUE);
    expect(tool.environment['PATH']).toBe('/usr/bin');
  });

  it('the adapter tool boundary never exposes the sentinel', () => {
    const adapter = new OpenCodeHarnessAdapter({
      executable: 'opencode-test',
      modelId: 'anthropic/claude-test',
      environment: { PATH: '/usr/bin', [SENTINEL_NAME]: SENTINEL_VALUE },
      clientFactory: async () => ({
        startSession: async () => ({
          runPrompt: async () => ({ text: '', toolCalls: [], steps: 0, envelopes: 0 }),
          abort: () => undefined,
        }),
        close: async () => undefined,
      }),
    });
    const tool = adapter.toolEnvironmentNames();
    // The credential never reaches adapter-held environments at all, so
    // neither list names it — and no value may leak anywhere.
    expect(tool.allowed).not.toContain(SENTINEL_NAME);
    expect(JSON.stringify(tool)).not.toContain(SENTINEL_VALUE);
  });
});
