import { describe, expect, it } from 'vitest';
import { computeToolHiddenPaths, normalizeHidePath, renderToolShellWrapper } from '../src/index.js';
import { windowsHiddenPaths, windowsMountPaths } from '../src/toolshell.js';

const MOUNTINFO = [
  '24 1 8:48 / / rw,relatime - ext4 /dev/sdd rw',
  '88 24 0:63 / /mnt/c rw,noatime - 9p C:\\134 rw,aname=drvfs;path=C:\\;uid=1000',
  '90 24 0:64 / /mnt/d rw,noatime - drvfs D:\\ rw,uid=1000',
  '91 24 0:65 / /win/e rw,noatime - 9p E:\\134 rw,aname=drvfs',
  '92 24 0:66 / /run/user/1000 rw - tmpfs tmpfs rw',
  '93 24 0:67 / /mnt/with\\040space rw - 9p F:\\134 rw',
].join('\n');

describe('windows drive hiding', () => {
  it('finds drvfs and 9p mounts wherever the automount root is', () => {
    expect(windowsMountPaths(MOUNTINFO)).toEqual(['/mnt/c', '/mnt/d', '/win/e']);
    expect(windowsMountPaths('')).toEqual([]);
  });

  it('returns only paths that exist, and never fails on a missing mountinfo', async () => {
    const found = await windowsHiddenPaths('/definitely/not/there');
    for (const path of found) expect(['/mnt', '/run/WSL']).toContain(path);
  });

  it('hides extra paths but never the workspace, and unsets the interop socket', () => {
    const hidden = computeToolHiddenPaths({
      scopeDir: '/tmp/.scope',
      workspace: '/tmp/data/w1',
      extra: ['/mnt/c', '/mnt', '/tmp/data/w1'],
    });
    expect(hidden).toContain('/mnt/c');
    expect(hidden).toContain('/mnt');
    expect(hidden).not.toContain('/tmp/data/w1');
    const script = renderToolShellWrapper({
      realShell: '/bin/bash',
      bwrap: '/usr/bin/bwrap',
      hidePaths: hidden,
      runTmp: '/tmp/.scope/tmp',
      scopeHome: '/tmp/.scope/home',
      workspace: '/tmp/data/w1',
    });
    expect(script).toContain("--tmpfs '/mnt/c'");
    expect(script).toContain('--unsetenv WSL_INTEROP');
  });

  it('points XDG_RUNTIME_DIR at the private tmp so .NET can create its lock files', () => {
    const script = renderToolShellWrapper({
      realShell: '/bin/bash',
      bwrap: '/usr/bin/bwrap',
      hidePaths: [],
      runTmp: '/tmp/.scope/tmp',
      scopeHome: '/tmp/.scope/home',
      workspace: '/tmp/data/w1',
    });
    expect(script).toContain('--setenv XDG_RUNTIME_DIR /tmp');
    expect(script.indexOf('--bind "$SENTRY_RUN_TMP" /tmp')).toBeGreaterThan(-1);
  });
});

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
    // Network isolation: model-controlled shells enter a fresh network
    // namespace (no host loopback, no proxy reachability), while the
    // OpenCode parent keeps host networking. No toggle exists by design.
    expect(script).toContain('--unshare-net');
    expect(script).toContain("--tmpfs '/tmp/.sentry-opencode-r1'");
    expect(script).toContain("--tmpfs '/home/user'");
    expect(script).toContain("SENTRY_WORKSPACE='/tmp/data/w1'");
    expect(script).toContain('--bind "$SENTRY_WORKSPACE" "$SENTRY_WORKSPACE"');
    expect(script).toContain('-- "$SENTRY_REAL_SHELL" -o pipefail -c "$SCRIPT"');
    expect(script).toContain('exit 126');
  });
});
