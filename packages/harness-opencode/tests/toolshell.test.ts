import { describe, expect, it } from 'vitest';
import { computeToolHiddenPaths, normalizeHidePath, renderToolShellWrapper } from '../src/index.js';

describe('tool shell wrapper', () => {
  it('rejects roots and empties from the hide list', () => {
    expect(normalizeHidePath('')).toBeUndefined();
    expect(normalizeHidePath('/')).toBeUndefined();
    expect(normalizeHidePath('C:')).toBeUndefined();
    expect(normalizeHidePath('/tmp/x/')).toBe('/tmp/x');
  });

  it('hides scope, parent, and home but never the workspace', () => {
    const hidden = computeToolHiddenPaths({
      scopeDir: '/tmp/.sentry-opencode-r1',
      workspace: '/tmp/data/w1',
      realHome: '/home/user',
    });
    expect(hidden).toContain('/tmp/.sentry-opencode-r1');
    expect(hidden).toContain('/tmp/data');
    expect(hidden).toContain('/home/user');
    expect(hidden).not.toContain('/tmp/data/w1');
    expect(hidden).not.toContain('/');
  });

  it('renders a strict wrapper with namespace mounts', () => {
    const script = renderToolShellWrapper({
      realShell: '/bin/bash',
      bwrap: '/usr/bin/bwrap',
      hidePaths: ['/tmp/.sentry-opencode-r1', '/home/user'],
      runTmp: '/tmp/.sentry-opencode-r1/run-tmp',
      scopeHome: '/tmp/.sentry-opencode-r1/home',
      workspace: '/tmp/data/w1',
    });
    expect(script).toContain('--ro-bind / /');
    expect(script).toContain("--tmpfs '/tmp/.sentry-opencode-r1'");
    expect(script).toContain("--tmpfs '/home/user'");
    expect(script).toContain("SENTRY_WORKSPACE='/tmp/data/w1'");
    expect(script).toContain('--bind "$SENTRY_WORKSPACE" "$SENTRY_WORKSPACE"');
    expect(script).toContain('-- "$SENTRY_REAL_SHELL" -c "$SCRIPT"');
    expect(script).toContain('exit 126');
  });
});
