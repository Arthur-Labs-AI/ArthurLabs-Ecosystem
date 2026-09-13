import { describe, expect, it } from 'vitest';
import { buildClaudeChildEnvironment, buildClaudeSpawnEnv } from '../src/index.js';

// Credential-boundary sentinel tests for the Claude Code stack. A test-only
// sentinel stands in for the Z.AI authorization credential: the Claude
// parent process may hold it, but model-controlled Bash/hooks/MCP children
// must not inherit it (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` is forced on every
// spawn; live absence is verified with a sentinel Bash probe during the
// GLM smoke). Never a real credential here.
const SENTINEL_VALUE = 'sentry-test-sentinel-credential';

describe('Claude credential boundary', () => {
  it('forces the subprocess scrub flag on every spawn, ignoring overrides', () => {
    const env = buildClaudeSpawnEnv({
      executable: 'claude-test',
      cwd: '/tmp/ws',
      configDir: '/tmp/claude-home',
      environment: {
        PATH: '/usr/bin',
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0',
        ANTHROPIC_AUTH_TOKEN: SENTINEL_VALUE,
      },
      modelId: 'glm-5.3-flash',
      settingsPath: '/tmp/claude-home/sentry-settings.json',
      initializeTimeoutMs: 30_000,
      turnTimeoutMs: 60_000,
    });
    expect(env['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB']).toBe('1');
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/tmp/claude-home');
    // The parent legitimately carries the credential; the scrub flag is
    // what keeps it out of model-controlled children.
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBe(SENTINEL_VALUE);
  });

  it('blocks unrelated secret-shaped names from the child environment', () => {
    const child = buildClaudeChildEnvironment({
      source: {
        PATH: '/usr/bin',
        ANTHROPIC_AUTH_TOKEN: SENTINEL_VALUE,
        GITHUB_TOKEN: 'sentry-test-sentinel-unrelated',
        AWS_SECRET_ACCESS_KEY: 'sentry-test-sentinel-unrelated',
        ANTHROPIC_API_KEY: 'sentry-test-sentinel-unrelated',
      },
    });
    expect(child.environment['ANTHROPIC_AUTH_TOKEN']).toBe(SENTINEL_VALUE);
    expect(child.environment['GITHUB_TOKEN']).toBeUndefined();
    expect(child.environment['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(child.environment['ANTHROPIC_API_KEY']).toBeUndefined();
  });
});
