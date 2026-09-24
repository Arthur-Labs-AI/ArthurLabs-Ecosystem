import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyOpenCodeScopeEnvironment,
  applyOpenCodeTurnEnvironment,
  buildOpenCodeChildEnvironment,
  buildOpenCodeProviderConfig,
  cleanupOpenCodeRunScope,
  createOpenCodeRunScope,
  maskProjectOpenCodeConfig,
  readOpenCodeAuthFile,
} from '../src/index.js';

const SENTINEL_VALUE = 'sentry-test-sentinel-credential';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('disposable run scope', () => {
  it('creates HOME/XDG scope with the auth file outside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-scope-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const scope = await createOpenCodeRunScope({
      workspacePath: workspace,
      runId: 'arun_01K7777777777777777777A8W4',
      apiKey: SENTINEL_VALUE,
    });
    try {
      expect(scope.directory.startsWith(root)).toBe(true);
      expect(scope.directory.startsWith(workspace + '/')).toBe(false);
      expect(scope.authFile).toBe(join(scope.dataHome, 'opencode', 'auth.json'));
      const parsed = (await readOpenCodeAuthFile(scope.authFile)) as Record<string, unknown>;
      expect(parsed).toEqual({ openrouter: { type: 'api', key: SENTINEL_VALUE } });
      const env = applyOpenCodeScopeEnvironment({ PATH: '/usr/bin' }, scope);
      expect(env['HOME']).toBe(scope.home);
      expect(env['XDG_DATA_HOME']).toBe(scope.dataHome);
      expect(env['XDG_CONFIG_HOME']).toBe(scope.configHome);
      expect(JSON.stringify(env)).not.toContain(SENTINEL_VALUE);
    } finally {
      await cleanupOpenCodeRunScope(scope);
    }
    await expect(stat(scope.directory)).rejects.toThrow();
  });

  it('masks project .opencode content by rename (readable, undiscoverable)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-mask-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(workspace, '.opencode', 'plugins'), { recursive: true });
    await writeFile(join(workspace, '.opencode', 'plugins', 'evil.js'), 'evil');
    await writeFile(join(workspace, 'opencode.json'), '{}');
    await writeFile(join(workspace, 'README.md'), '# hi\n');
    const masked = await maskProjectOpenCodeConfig(workspace);
    expect(masked.sort()).toEqual(['.opencode', 'opencode.json']);
    // Renamed, not deleted: QA can still inspect the content.
    expect(
      await readFile(join(workspace, '.opencode.sentry-masked', 'plugins', 'evil.js'), 'utf8'),
    ).toBe('evil');
    // Product files untouched.
    expect(await readFile(join(workspace, 'README.md'), 'utf8')).toBe('# hi\n');
    await expect(stat(join(workspace, '.opencode'))).rejects.toThrow();
  });

  it('never inherits user OpenCode control variables or HOME/XDG', () => {
    const child = buildOpenCodeChildEnvironment({
      source: {
        PATH: '/usr/bin',
        HOME: '/home/user',
        XDG_DATA_HOME: '/home/user/.local/share',
        XDG_CONFIG_HOME: '/home/user/.config',
        OPENROUTER_API_KEY: SENTINEL_VALUE,
        OPENCODE_CONFIG: '/home/user/custom.json',
        OPENCODE_CONFIG_CONTENT: '{"plugin":[]}',
        OPENCODE_AUTH_CONTENT: '{"openrouter":{}}',
        OPENCODE_PERMISSION: '{"*":"allow"}',
        OPENCODE_PURE: '0',
        OPENCODE_DISABLE_PROJECT_CONFIG: '0',
      },
    });
    expect(child.environment['HOME']).toBeUndefined();
    expect(child.environment['XDG_DATA_HOME']).toBeUndefined();
    expect(child.environment['OPENROUTER_API_KEY']).toBeUndefined();
    expect(child.environment['OPENCODE_CONFIG']).toBeUndefined();
    expect(child.environment['OPENCODE_CONFIG_CONTENT']).toBeUndefined();
    expect(child.environment['OPENCODE_AUTH_CONTENT']).toBeUndefined();
    expect(child.environment['OPENCODE_PERMISSION']).toBeUndefined();
    expect(child.environment['OPENCODE_PURE']).toBeUndefined();
    expect(child.environment['OPENCODE_DISABLE_PROJECT_CONFIG']).toBeUndefined();
    expect(child.blockedNames).toEqual(
      expect.arrayContaining([
        'HOME',
        'XDG_DATA_HOME',
        'OPENROUTER_API_KEY',
        'OPENCODE_CONFIG',
        'OPENCODE_CONFIG_CONTENT',
        'OPENCODE_AUTH_CONTENT',
        'OPENCODE_PERMISSION',
      ]),
    );
    expect(JSON.stringify(child.environment)).not.toContain(SENTINEL_VALUE);
  });

  it('sets Sentry-owned turn controls including the reporting deny-all', () => {
    const base = { PATH: '/usr/bin' };
    const configContent = buildOpenCodeProviderConfig({ provider: 'openrouter' });
    expect(JSON.parse(configContent)).toEqual({ provider: { openrouter: {} } });
    const normal = applyOpenCodeTurnEnvironment(base, { configContent });
    expect(normal['OPENCODE_CONFIG_CONTENT']).toBe(configContent);
    expect(normal['OPENCODE_DISABLE_PROJECT_CONFIG']).toBe('1');
    expect(normal['OPENCODE_PERMISSION']).toBeUndefined();
    const reporting = applyOpenCodeTurnEnvironment(base, { configContent, forbidTools: true });
    expect(JSON.parse(reporting['OPENCODE_PERMISSION'] as string)).toEqual({ '*': 'deny' });
  });
});
