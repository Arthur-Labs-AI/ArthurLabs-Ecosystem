import { describe, expect, it } from 'vitest';
import {
  DirectClaudeProcessLauncher,
  mintIsolatedUnitName,
  stopIsolatedUnit,
  stripSystemdClientChatter,
  SystemdIsolatedClaudeProcessLauncher,
} from '../src/index.js';

describe('Claude process launcher boundary', () => {
  it('mints unique unit names with a safe fixed alphabet', () => {
    const a = mintIsolatedUnitName();
    const b = mintIsolatedUnitName();
    expect(a).toMatch(/^sentry-glm-\d+-[0-9a-f]+$/);
    expect(a).not.toBe(b);
    // Never embeds prompts, paths, or model ids: only pid + randomness.
    expect(a).not.toContain('/');
    expect(a).not.toContain(' ');
  });

  it('strips systemd-run client chatter without touching program output', () => {
    const mixed =
      'Running as unit: sentry-glm-1-abc.service; invocation ID: x\n' +
      '{"type":"system","subtype":"init"}\n' +
      'Finished with result: success\n' +
      'Main processes terminated with: code=exited, status=0/SUCCESS\n' +
      'Service runtime: 70ms\n' +
      'CPU time consumed: 33ms\n' +
      'Memory peak: 3.7M (swap: 0B)\n' +
      'bwrap: real error stays\n';
    const stripped = stripSystemdClientChatter(mixed);
    expect(stripped).toContain('{"type":"system","subtype":"init"}');
    expect(stripped).toContain('bwrap: real error stays');
    expect(stripped).not.toContain('Running as unit:');
    expect(stripped).not.toContain('Finished with result:');
    expect(stripped).not.toContain('Main processes');
    expect(stripped).not.toContain('Service runtime:');
    expect(stripped).not.toContain('CPU time consumed:');
    expect(stripped).not.toContain('Memory peak:');
  });

  it('direct launcher spawns the executable with argv and no unit', async () => {
    const launcher = new DirectClaudeProcessLauncher();
    expect(launcher.kind).toBe('direct');
    const owned = launcher.launch({
      executable: process.execPath,
      argv: ['-e', 'console.log("hello-direct")'],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
    });
    expect(owned.unitName).toBeUndefined();
    let out = '';
    owned.child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
    await new Promise<void>((resolve) => owned.child.on('close', () => resolve()));
    expect(out).toContain('hello-direct');
    await expect(owned.stopOwnedUnit()).resolves.toBe(true);
  });

  it.runIf(process.platform !== 'win32')(
    'systemd argv hides /mnt/c with name-only secret transport',
    async () => {
      // The fake systemd-run is /bin/echo: it prints our argv, proving
      // shape without starting units. Secret VALUES must never appear;
      // only --setenv=NAME entries do.
      const launcher = new SystemdIsolatedClaudeProcessLauncher({
        systemdRun: '/bin/echo',
        mintUnitName: () => 'sentry-glm-1-fixed01',
      });
      expect(launcher.kind).toBe('wsl-isolated');
      const owned = launcher.launch({
        executable: '/usr/bin/claude',
        argv: ['-p', 'prompt with spaces'],
        cwd: '/tmp/sentry-ws',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/tmp/sentry-home',
          ANTHROPIC_AUTH_TOKEN: 'live-test-fake-token',
        },
      });
      expect(owned.unitName).toBe('sentry-glm-1-fixed01');
      let out = '';
      owned.child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
      await new Promise<void>((resolve) => owned.child.on('close', () => resolve()));
      const argv = out.trim().split(/\s+/);
      expect(argv).toContain('--user');
      expect(argv).toContain('--wait');
      expect(argv).toContain('--pipe');
      expect(argv).toContain('--collect');
      expect(argv).toContain('--quiet');
      expect(argv).toContain('--unit=sentry-glm-1-fixed01');
      expect(argv).toContain('TemporaryFileSystem=/mnt/c');
      expect(argv).toContain('KillMode=control-group');
      expect(argv).toContain('WorkingDirectory=/tmp/sentry-ws');
      expect(argv).toContain('--setenv=PATH');
      expect(argv).toContain('--setenv=HOME');
      expect(argv).toContain('--setenv=ANTHROPIC_AUTH_TOKEN');
      expect(out).not.toContain('live-test-fake-token');
      expect(out).not.toContain('/tmp/sentry-home');
      // Prompt stays a separate argv element (never shell-joined).
      expect(argv).toContain('prompt with spaces');
      expect(argv).toContain('/usr/bin/claude');
      // No PrivateNetwork (Claude needs provider HTTPS) and no
      // InaccessiblePaths (226/NAMESPACE history on WSL2).
      expect(out).not.toContain('PrivateNetwork');
      expect(out).not.toContain('InaccessiblePaths');
    },
  );

  it.runIf(process.platform !== 'win32')('stopOwnedUnit honors systemctl exit codes', async () => {
    await expect(stopIsolatedUnit('/bin/true', 'sentry-glm-1-gone')).resolves.toBe(true);
    await expect(stopIsolatedUnit('/bin/false', 'sentry-glm-1-gone')).resolves.toBe(false);
  });
});
