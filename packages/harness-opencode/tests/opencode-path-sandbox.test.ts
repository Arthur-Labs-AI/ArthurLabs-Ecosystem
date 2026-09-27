import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenCodeRegistration } from '../src/registration.js';
import { probeSystemdUser } from '../src/process.js';
import {
  doctorOpenCode,
  probeOpenCodeSandbox,
  probeResolvedOpenCodeExecutable,
} from '../src/discovery.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const isWindows = process.platform === 'win32';

async function fakeBinDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sentry-oc-fakebin-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content);
    if (!isWindows) {
      try {
        await chmod(join(root, name), 0o700);
      } catch {
        // Windows ignores POSIX mode bits.
      }
    }
  }
  return root;
}

async function fakeOpenCodeBinary(dir: string): Promise<string> {
  // Real executable (batch files cannot spawn without a shell on Windows,
  // exactly as in production). POSIX: version-exact shell script. Windows:
  // a node copy named opencode.exe (proves PATH resolution + availability;
  // version policy stays covered by the pure evaluator matrix).
  if (isWindows) {
    const target = join(dir, 'opencode.exe');
    await copyFile(process.execPath, target);
    return target;
  }
  const target = join(dir, 'opencode');
  await writeFile(
    target,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "opencode version 1.18.32"; fi\nexit 0\n',
  );
  await chmod(target, 0o700);
  return target;
}

function withFakePath(fakeDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    PATH: fakeDir + delimiter + (process.env['PATH'] ?? ''),
  };
}

function credentialEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...extra,
    SENTRY_OPENCODE_MODEL: 'opencode-test-model',
    SENTRY_OPENCODE_PROVIDER: 'opencode',
    OPENCODE_API_KEY: 'zen-test-key',
  };
}

describe('PATH-only executable resolution (no mocks)', () => {
  it('resolves opencode from PATH with source=path and a working version probe', async () => {
    const fakeDir = await fakeBinDir({});
    await fakeOpenCodeBinary(fakeDir);
    const env = credentialEnv(withFakePath(fakeDir));
    delete env['SENTRY_OPENCODE_BINARY'];
    const probed = await probeResolvedOpenCodeExecutable({
      environment: env,
      managedExecutable: join('no-such-dir', 'opencode'),
    });
    expect(probed.source).toBe('path');
    expect(probed.executable).toBe('opencode');
    expect(probed.available).toBe(true);
    if (!isWindows) expect(probed.version ?? '').toContain('1.18.32');
    else expect((probed.version ?? '').length).toBeGreaterThan(0);
  });

  it('explicit bad override fails closed without falling back to PATH', async () => {
    const fakeDir = await fakeBinDir({});
    await fakeOpenCodeBinary(fakeDir);
    const env = credentialEnv(
      withFakePath(fakeDir, { SENTRY_OPENCODE_BINARY: join('no-such-dir', 'opencode') }),
    );
    const probed = await probeResolvedOpenCodeExecutable({
      environment: env,
      managedExecutable: join('no-such-dir', 'opencode'),
    });
    expect(probed.source).toBe('environment');
    expect(probed.available).toBe(false);
  });
});

describe('functional systemd probe (no mocks)', () => {
  function systemdFakes(): Record<string, string> {
    if (isWindows) {
      return {
        'systemctl.cmd': '@echo fake-systemctl\r\n',
        'systemd-run.cmd': '@echo systemd-run fake 1.0\r\n',
      };
    }
    return {
      systemctl: '#!/bin/sh\nexit 0\n',
      // --version succeeds but a real transient unit launch fails: the exact
      // false-positive shape the old probe missed.
      'systemd-run':
        '#!/bin/sh\nfor a in "$@"; do if [ "$a" = "--version" ]; then echo "systemd-run fake 1.0"; exit 0; fi; done\nexit 1\n',
    };
  }

  it('systemd-run --version success with failing unit launch reads as unavailable', async () => {
    const fakeDir = await fakeBinDir(systemdFakes());
    const env = withFakePath(fakeDir);
    expect(await probeSystemdUser(5_000)).toBe(false);
    const sandbox = await probeOpenCodeSandbox({ environment: env });
    expect(sandbox.systemdUser).toBe(false);
  });

  it('registration preflight blocks when functional systemd is unavailable', async () => {
    if (process.platform !== 'linux') return;
    const fakeDir = await fakeBinDir(systemdFakes());
    await fakeOpenCodeBinary(fakeDir);
    const env = credentialEnv(withFakePath(fakeDir));
    delete env['SENTRY_OPENCODE_BINARY'];
    const registration = createOpenCodeRegistration({ environment: env });
    await expect(registration.preflight()).rejects.toMatchObject({
      code: 'OPENCODE_SANDBOX_UNAVAILABLE',
    });
  });

  it('doctor reports unavailable when functional systemd is unavailable', async () => {
    const fakeDir = await fakeBinDir(systemdFakes());
    await fakeOpenCodeBinary(fakeDir);
    const env = credentialEnv(withFakePath(fakeDir));
    delete env['SENTRY_OPENCODE_BINARY'];
    const doctor = await doctorOpenCode({ environment: env });
    expect(doctor.readiness).toBe('unavailable');
  });
});

describe('direct dev bypass consistency (no mocks)', () => {
  it('preflight passes under bypass while doctor degrades with an explicit warning', async () => {
    const fakeDir = await fakeBinDir({});
    await fakeOpenCodeBinary(fakeDir);
    const env = credentialEnv(withFakePath(fakeDir, { SENTRY_OPENCODE_ALLOW_DIRECT: '1' }));
    delete env['SENTRY_OPENCODE_BINARY'];
    if (process.platform === 'linux') {
      const registration = createOpenCodeRegistration({ environment: env });
      await registration.preflight();
    }
    const doctor = await doctorOpenCode({ environment: env });
    expect(['degraded', 'unavailable']).toContain(doctor.readiness);
    const warned = (doctor.checks ?? []).some(
      (check) => check.status === 'warn' && (check.message ?? '').includes('ALLOW_DIRECT'),
    );
    const failed = (doctor.checks ?? []).some((check) => check.status === 'fail');
    // Masking uses real fs and passes here, so bypass must warn, never fail hard.
    expect(failed).toBe(false);
    expect(warned).toBe(true);
  });
});
