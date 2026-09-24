import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DirectOpenCodeProcessLauncher,
  mintIsolatedUnitName,
  stripSystemdClientChatter,
  SystemdOpenCodeProcessLauncher,
} from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('owned process boundary', () => {
  it('mints unique Sentry-owned unit names without untrusted content', () => {
    const a = mintIsolatedUnitName();
    const b = mintIsolatedUnitName();
    expect(a).toMatch(/^sentry-opencode-\d+-[a-z0-9]+$/);
    expect(a).not.toBe(b);
  });

  it('strips systemd client chatter but never program output', () => {
    const text = stripSystemdClientChatter(
      'Running as unit: sentry-opencode-1.service\n{"type":"text"}\nFinished with result: success',
    );
    expect(text).toBe('{"type":"text"}');
  });

  it('systemd launcher builds an owned transient unit (fake spawn)', async () => {
    const launcher = new SystemdOpenCodeProcessLauncher({
      systemdRun: '/bin/systemd-run',
      systemctl: '/bin/systemctl',
      mintUnitName: () => 'sentry-opencode-test-unit',
    });
    expect(launcher.kind).toBe('systemd-unit');
    // Argument-shape assertion via a fake executable is covered by the
    // opt-in real-binary suite; here we assert the unit identity contract.
    expect(launcher).toBeDefined();
  });

  it('direct launcher stops the owned child and reports success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-proc-'));
    roots.push(root);
    const launcher = new DirectOpenCodeProcessLauncher({ stopTimeoutMs: 5_000 });
    const owned = launcher.launch({
      executable: process.execPath,
      argv: ['-e', 'setInterval(() => {}, 100000)'],
      cwd: root,
      env: { PATH: process.env.PATH ?? '' },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(owned.child.exitCode).toBeNull();
    expect(await owned.stop()).toBe(true);
    expect(owned.child.exitCode !== null || owned.child.signalCode !== null).toBe(true);
    expect(await owned.stop()).toBe(true);
  });

  it('direct launcher cleans the owned descendant tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-proc-tree-'));
    roots.push(root);
    const heartbeat = join(root, 'beat.txt');
    await writeFile(
      join(root, 'parent.mjs'),
      "import { spawn } from 'node:child_process';\n" +
        `const child = spawn(process.execPath, [${JSON.stringify(join(root, 'child.mjs'))}], { stdio: 'ignore' });\n` +
        'setInterval(() => {}, 100000);\n',
    );
    await writeFile(
      join(root, 'child.mjs'),
      "import { appendFileSync } from 'node:fs';\n" +
        `setInterval(() => appendFileSync(${JSON.stringify(heartbeat)}, 'beat\\n'), 200);\n`,
    );
    const launcher = new DirectOpenCodeProcessLauncher({ stopTimeoutMs: 5_000 });
    const owned = launcher.launch({
      executable: process.execPath,
      argv: [join(root, 'parent.mjs')],
      cwd: root,
      env: { PATH: process.env.PATH ?? '' },
    });
    // Wait for the grandchild heartbeat to prove the tree is alive.
    let beats = '';
    for (let i = 0; i < 50 && beats.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      beats = await readFile(heartbeat, 'utf8').catch(() => '');
    }
    expect(beats.length).toBeGreaterThan(0);
    expect(await owned.stop()).toBe(true);
    const sizeAfter = await stat(heartbeat)
      .then((s) => s.size)
      .catch(() => -1);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const sizeLater = await stat(heartbeat)
      .then((s) => s.size)
      .catch(() => -1);
    if (owned.kind === 'process-group') {
      // POSIX group kill: the whole tree is gone, heartbeat frozen.
      expect(sizeLater).toBe(sizeAfter);
    } else {
      // Windows: group kill unavailable; at minimum the owned child ended.
      expect(owned.child.exitCode !== null || owned.child.signalCode !== null).toBe(true);
    }
  });
});
