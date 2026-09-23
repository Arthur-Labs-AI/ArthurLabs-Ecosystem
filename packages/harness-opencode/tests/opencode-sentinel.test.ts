import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildOpenCodeChildEnvironment,
  buildOpenCodeToolEnvironment,
  cleanupOpenCodeAuthBoundary,
  OPENCODE_ALLOWED_SECRET_ENV_NAMES,
  readOpenCodeAuthFile,
  writeOpenCodeAuthBoundary,
} from '../src/index.js';

// Credential-boundary sentinel tests for the OpenCode harness. A test-only
// sentinel stands in for OPENROUTER_API_KEY. The key travels ONLY in the
// Sentry-owned auth boundary file — never in any child environment — so
// model-controlled shell tools (which inherit the host process environment)
// cannot observe it. Never a real credential here.
const SENTINEL_NAME = 'OPENROUTER_API_KEY';
const SENTINEL_VALUE = 'sentry-test-sentinel-credential';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

  it('writes the sentinel only to a Sentry-owned auth file beside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-opencode-auth-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const boundary = await writeOpenCodeAuthBoundary({
      workspacePath: workspace,
      runId: 'arun_01K7777777777777777777A8W4',
      apiKey: SENTINEL_VALUE,
    });
    try {
      // Sibling of the workspace, never inside it.
      expect(boundary.directory.startsWith(root)).toBe(true);
      expect(boundary.authFile).toBe(join(boundary.directory, 'opencode', 'auth.json'));
      const parsed = (await readOpenCodeAuthFile(boundary.authFile)) as Record<string, unknown>;
      expect(parsed).toEqual({
        openrouter: { type: 'api', key: SENTINEL_VALUE },
      });
      // The workspace tree itself never receives the credential.
      expect(boundary.directory.startsWith(workspace + '/')).toBe(false);
    } finally {
      await cleanupOpenCodeAuthBoundary(boundary);
    }
    await expect(stat(boundary.directory)).rejects.toThrow();
  });
});
