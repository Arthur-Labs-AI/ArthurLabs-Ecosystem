import { describe, expect, it } from 'vitest';
import { SENSITIVE_ENV_PATTERN, scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess';
import { buildDeepSeekChildEnvironment } from '../src/index.js';

// Credential-boundary sentinel tests against the pinned DeepSeek Harness
// (`@deepseek-ai/dsh-subprocess@0.1.5-rc.2`). A test-only sentinel stands
// in for the provider credential: the host process may hold it, but the
// runtime scrub plus Sentry's own allowlist must keep it out of
// model-controlled shell/file tooling. Never a real credential here.
const SENTINEL_NAME = 'DEEPSEEK_API_KEY';
const SENTINEL_VALUE = 'sentry-test-sentinel-credential';

describe('DeepSeek credential boundary (pinned scrub)', () => {
  it('the pinned sensitive pattern matches the provider credential shape', () => {
    expect(SENSITIVE_ENV_PATTERN.test(SENTINEL_NAME)).toBe(true);
    expect(SENSITIVE_ENV_PATTERN.test('ANTHROPIC_AUTH_TOKEN')).toBe(true);
    expect(SENSITIVE_ENV_PATTERN.test('PATH')).toBe(false);
  });

  it('the pinned runtime scrub removes the sentinel from the child base', () => {
    process.env[SENTINEL_NAME] = SENTINEL_VALUE;
    try {
      const scrubbed = scrubbedParentEnv();
      expect(Object.keys(scrubbed)).not.toContain(SENTINEL_NAME);
      expect(Object.values(scrubbed)).not.toContain(SENTINEL_VALUE);
      expect(JSON.stringify(scrubbed)).not.toContain(SENTINEL_VALUE);
      // Non-credential runtime names survive so child CLIs run normally.
      expect(scrubbed['PATH']).toBeDefined();
    } finally {
      delete process.env[SENTINEL_NAME];
    }
  });

  it('Sentry never forwards the sentinel beyond the host process boundary', () => {
    const child = buildDeepSeekChildEnvironment({
      source: {
        PATH: '/usr/bin',
        [SENTINEL_NAME]: SENTINEL_VALUE,
      },
    });
    // The host credential is allowlisted ONLY for the DeepSeek host
    // process itself, where the runtime scrub above applies before any
    // model-controlled subprocess is spawned.
    expect(child.environment[SENTINEL_NAME]).toBe(SENTINEL_VALUE);
    expect(child.blockedNames).not.toContain(SENTINEL_NAME);
  });

  it('unrelated secret-shaped names are blocked from the child environment', () => {
    const child = buildDeepSeekChildEnvironment({
      source: {
        PATH: '/usr/bin',
        GITHUB_TOKEN: 'sentry-test-sentinel-unrelated',
        AWS_SECRET_ACCESS_KEY: 'sentry-test-sentinel-unrelated',
        NPM_TOKEN: 'sentry-test-sentinel-unrelated',
      },
    });
    expect(child.environment['GITHUB_TOKEN']).toBeUndefined();
    expect(child.environment['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(child.environment['NPM_TOKEN']).toBeUndefined();
    expect(child.blockedNames).toEqual(
      expect.arrayContaining(['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN']),
    );
  });
});
