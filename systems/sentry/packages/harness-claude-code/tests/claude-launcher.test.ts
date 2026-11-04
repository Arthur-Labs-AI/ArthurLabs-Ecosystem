import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('direct launcher delivers a multi-megabyte prompt over stdin, not argv (E2BIG)', async () => {
    const prompt = 'x'.repeat(4 * 1024 * 1024);
    const owned = new DirectClaudeProcessLauncher().launch({
      executable: process.execPath,
      argv: [
        '-e',
        'let n=0;process.stdin.on("data",c=>n+=c.length).on("end",()=>console.log("bytes="+n))',
      ],
      stdin: prompt,
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
    });
    let out = '';
    owned.child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
    await new Promise<void>((resolve) => owned.child.on('close', () => resolve()));
    expect(out).toContain('bytes=' + String(prompt.length));
  });

  it.runIf(process.platform !== 'win32')(
    'systemd argv hides /mnt/c with name-only secret transport',
    async () => {
      // An executable argv recorder preserves argument boundaries and uses
      // a real cwd. This validates transport shape, not systemd isolation.
      const cwd = await mkdtemp(join(tmpdir(), 'sentry-claude-argv-'));
      const recorder = join(cwd, 'systemd-run');
      await writeFile(
        recorder,
        '#!' + process.execPath + '\nconsole.log(JSON.stringify(process.argv.slice(2)));\n',
        { mode: 0o700 },
      );
      try {
        const launcher = new SystemdIsolatedClaudeProcessLauncher({
          systemdRun: recorder,
          mintUnitName: () => 'sentry-glm-1-fixed01',
        });
        expect(launcher.kind).toBe('wsl-isolated');
        const owned = launcher.launch({
          executable: '/usr/bin/claude',
          argv: ['-p', 'prompt with spaces'],
          cwd,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: '/tmp/sentry-home',
            ANTHROPIC_AUTH_TOKEN: 'live-test-fake-token',
          },
        });
        expect(owned.unitName).toBe('sentry-glm-1-fixed01');
        let out = '';
        owned.child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          owned.child.once('error', reject);
          owned.child.once('close', resolve);
        });
        expect(exitCode).toBe(0);
        const argv = JSON.parse(out) as string[];
        expect(argv).toContain('--user');
        expect(argv).toContain('--wait');
        expect(argv).toContain('--pipe');
        expect(argv).toContain('--collect');
        expect(argv).toContain('--quiet');
        expect(argv).toContain('--unit=sentry-glm-1-fixed01');
        expect(argv).toContain('TemporaryFileSystem=/mnt/c');
        expect(argv).toContain('KillMode=control-group');
        expect(argv).toContain('WorkingDirectory=' + cwd);
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
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== 'win32')('stopOwnedUnit honors systemctl exit codes', async () => {
    await expect(stopIsolatedUnit('/bin/true', 'sentry-glm-1-gone')).resolves.toBe(true);
    await expect(stopIsolatedUnit('/bin/false', 'sentry-glm-1-gone')).resolves.toBe(false);
  });
});
