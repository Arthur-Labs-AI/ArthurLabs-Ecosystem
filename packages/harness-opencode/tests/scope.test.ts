import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
} from '../src/index.js';

const SENTINEL_VALUE = 'sentry-test-sentinel-credential';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('disposable run scope', () => {
  it('creates HOME/XDG scope beside the workspace with no credential material', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-scope-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const scope = await createOpenCodeRunScope({
      workspacePath: workspace,
      runId: 'arun_01K7777777777777777777A8W4',
    });
    try {
      expect(scope.directory.startsWith(root)).toBe(true);
      expect(scope.directory.startsWith(workspace + '/')).toBe(false);
      expect(scope.binDir).toBe(join(scope.directory, 'bin'));
      expect(scope.runTmp).toBe(join(scope.directory, 'run-tmp'));
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

  it('masks project .opencode content to randomized destinations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-mask-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const { mkdir, readdir } = await import('node:fs/promises');
    await mkdir(join(workspace, '.opencode', 'plugins'), { recursive: true });
    await writeFile(join(workspace, '.opencode', 'plugins', 'evil.js'), 'evil');
    await writeFile(join(workspace, 'opencode.json'), '{}');
    await writeFile(join(workspace, 'README.md'), '# hi\n');
    const masked = await maskProjectOpenCodeConfig(workspace);
    expect([...masked].sort()).toEqual(['.opencode', 'opencode.json']);
    // Sources verified gone (lstat: symlinks count too).
    await expect(lstat(join(workspace, '.opencode'))).rejects.toThrow();
    await expect(lstat(join(workspace, 'opencode.json'))).rejects.toThrow();
    // Content preserved under a randomized staging dir, still inspectable.
    const staging = join(workspace, '.sentry-masked-project-config');
    const buckets = await readdir(staging);
    expect(buckets.length).toBeGreaterThanOrEqual(2);
    let found = 0;
    for (const bucket of buckets) {
      try {
        if (
          (await readFile(join(staging, bucket, '.opencode', 'plugins', 'evil.js'), 'utf8')) ===
          'evil'
        )
          found += 1;
      } catch {
        // Other buckets hold other entries.
      }
    }
    expect(found).toBe(1);
    // Product files untouched.
    expect(await readFile(join(workspace, 'README.md'), 'utf8')).toBe('# hi\n');
  });

  it('ignores legacy predictable mask destinations (old bypass inert)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-mask-collision-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(workspace, '.opencode', 'plugins'), { recursive: true });
    await writeFile(join(workspace, '.opencode', 'plugins', 'evil.js'), 'evil');
    // A malicious repo pre-occupying the OLD predictable destination.
    await mkdir(join(workspace, '.opencode.sentry-masked'), { recursive: true });
    await writeFile(join(workspace, '.opencode.sentry-masked', 'decoy'), 'decoy');
    const masked = await maskProjectOpenCodeConfig(workspace);
    expect(masked).toContain('.opencode');
    // Decoy untouched; real config masked elsewhere.
    expect(await readFile(join(workspace, '.opencode.sentry-masked', 'decoy'), 'utf8')).toBe(
      'decoy',
    );
    await expect(lstat(join(workspace, '.opencode'))).rejects.toThrow();
  });

  it('masks symlinked and broken-symlink config entries', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'sentry-mask-link-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspace, { recursive: true });
    await mkdir(join(root, 'real-config'));
    await writeFile(join(root, 'real-config', 'x.json'), '{}');
    await symlink(join(root, 'real-config'), join(workspace, '.opencode'));
    await symlink(join(root, 'does-not-exist'), join(workspace, 'opencode.json'));
    const masked = await maskProjectOpenCodeConfig(workspace);
    expect([...masked].sort()).toEqual(['.opencode', 'opencode.json']);
    await expect(lstat(join(workspace, '.opencode'))).rejects.toThrow();
    await expect(lstat(join(workspace, 'opencode.json'))).rejects.toThrow();
    // The link TARGET outside the workspace is untouched.
    expect(await readFile(join(root, 'real-config', 'x.json'), 'utf8')).toBe('{}');
  });

  it('fails closed when the workspace cannot be inspected', async () => {
    const missing = join(tmpdir(), 'sentry-mask-missing-' + String(Date.now()));
    try {
      await maskProjectOpenCodeConfig(missing);
      expect.unreachable('masking must fail closed');
    } catch (cause) {
      expect((cause as { code?: unknown }).code).toBe('OPENCODE_PROJECT_CONFIG_ISOLATION_FAILED');
    }
  });

  it('leaves nested .opencode directories alone (only root level is discovered)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-mask-nested-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(workspace, 'sub', '.opencode'), { recursive: true });
    await writeFile(join(workspace, 'sub', '.opencode', 'note.md'), 'note');
    const masked = await maskProjectOpenCodeConfig(workspace);
    expect(masked).toEqual([]);
    expect(await readFile(join(workspace, 'sub', '.opencode', 'note.md'), 'utf8')).toBe('note');
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
