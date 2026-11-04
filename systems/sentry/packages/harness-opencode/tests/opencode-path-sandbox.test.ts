import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeSystemdUser } from '../src/process.js';
import { createOpenCodeRegistration } from '../src/registration.js';
import { selectProductionLauncher } from '../src/client.js';
import {
  classifyOpenCodeVersion,
  doctorOpenCode,
  isBlockingContainmentFailure,
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
    expect(await probeSystemdUser(5_000, env)).toBe(false);
    const sandbox = await probeOpenCodeSandbox({ environment: env });
    expect(sandbox.systemdUser).toBe(false);
  });

  it('functional systemd success reads as available (positive control)', async () => {
    const fakeDir = await (async () => {
      const dir = await fakeBinDir({});
      if (isWindows) {
        await writeFile(join(dir, 'systemctl.cmd'), '@echo fake-systemctl\r\n');
        await writeFile(join(dir, 'systemd-run.cmd'), '@echo ok\r\n');
      } else {
        await writeFile(join(dir, 'systemctl'), '#!/bin/sh\nexit 0\n');
        await chmod(join(dir, 'systemctl'), 0o700);
        await writeFile(join(dir, 'systemd-run'), '#!/bin/sh\nexit 0\n');
        await chmod(join(dir, 'systemd-run'), 0o700);
      }
      return dir;
    })();
    // Positive control only proves the fake can spawn: unit launch exit 0.
    // (On Windows the extensionless fakes cannot spawn, so this asserts the
    // probe shape rather than true availability there.)
    const env = withFakePath(fakeDir);
    const result = await probeSystemdUser(5_000, env);
    if (!isWindows) expect(result).toBe(true);
    else expect(typeof result).toBe('boolean');
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

  it('registration preflight blocks when bubblewrap is missing (systemd healthy)', async () => {
    // Missing-bwrap fail-closed, isolated from systemd state: working
    // systemd fakes plus a PATH containing ONLY the fake dir (no bwrap
    // anywhere) proves the bwrap prerequisite blocks on its own.
    if (process.platform !== 'linux') return;
    const fakeDir = await fakeBinDir({});
    await writeFile(join(fakeDir, 'systemctl'), '#!/bin/sh\nexit 0\n');
    await chmod(join(fakeDir, 'systemctl'), 0o700);
    await writeFile(join(fakeDir, 'systemd-run'), '#!/bin/sh\nexit 0\n');
    await chmod(join(fakeDir, 'systemd-run'), 0o700);
    await fakeOpenCodeBinary(fakeDir);
    const env = credentialEnv({ PATH: fakeDir });
    delete env['SENTRY_OPENCODE_BINARY'];
    const sandbox = await probeOpenCodeSandbox({ environment: env });
    expect(sandbox.systemdUser).toBe(true);
    expect(sandbox.bubblewrap).toBe(false);
    const registration = createOpenCodeRegistration({ environment: env });
    await expect(registration.preflight()).rejects.toMatchObject({
      code: 'OPENCODE_SANDBOX_UNAVAILABLE',
    });
    const doctor = await doctorOpenCode({ environment: env });
    expect(doctor.checks?.find((check) => check.name === 'tool-namespace')?.status).toBe('fail');
    expect(doctor.readiness).toBe('unavailable');
  });
});

describe('direct dev bypass consistency (no mocks)', () => {
  it('preflight passes under bypass while doctor degrades with an explicit warning', async () => {
    const fakeDir = await fakeBinDir({});
    await fakeOpenCodeBinary(fakeDir);
    const env = credentialEnv(
      withFakePath(fakeDir, {
        SENTRY_OPENCODE_ALLOW_DIRECT: '1',
        SENTRY_OPENCODE_ALLOW_UNTESTED_VERSION: '1',
      }),
    );
    delete env['SENTRY_OPENCODE_BINARY'];
    if (process.platform === 'linux') {
      const registration = createOpenCodeRegistration({ environment: env });
      await registration.preflight();
    }
    const doctor = await doctorOpenCode({ environment: env });
    expect(doctor.status).toBe('degraded');
    expect(doctor.readiness).toBe('degraded');
    const warned = (doctor.checks ?? []).some(
      (check) => check.status === 'warn' && (check.message ?? '').includes('ALLOW_DIRECT'),
    );
    const directMode = (doctor.checks ?? []).find((check) => check.name === 'direct-mode');
    const failed = (doctor.checks ?? []).some((check) => check.status === 'fail');
    // Masking uses real fs and passes here, so bypass must warn, never fail hard.
    expect(failed).toBe(false);
    expect(warned).toBe(true);
    expect(directMode?.status).toBe('warn');
  });

  it('masking failure under bypass still blocks everywhere', async () => {
    const fakeDir = await fakeBinDir({});
    await fakeOpenCodeBinary(fakeDir);
    const deadTmp = join(fakeDir, 'no-such-tmp');
    const env = credentialEnv(
      withFakePath(fakeDir, {
        SENTRY_OPENCODE_ALLOW_DIRECT: '1',
        SENTRY_OPENCODE_ALLOW_UNTESTED_VERSION: '1',
        TMPDIR: deadTmp,
        TEMP: deadTmp,
        TMP: deadTmp,
      }),
    );
    delete env['SENTRY_OPENCODE_BINARY'];
    const sandbox = await probeOpenCodeSandbox({ environment: env });
    expect(sandbox.masking).toBe(false);
    const doctor = await doctorOpenCode({ environment: env });
    expect(doctor.status).toBe('unavailable');
    expect(doctor.readiness).toBe('unavailable');
    if (process.platform === 'linux') {
      const registration = createOpenCodeRegistration({ environment: env });
      await expect(registration.preflight()).rejects.toMatchObject({
        code: 'OPENCODE_SANDBOX_UNAVAILABLE',
      });
    }
  });
});

describe('containment blocking policy (pure)', () => {
  it('healthy host without bypass never blocks', () => {
    expect(
      isBlockingContainmentFailure({
        bypassed: false,
        toolNamespace: 'pass',
        processBoundary: 'pass',
        configMasking: 'pass',
      }),
    ).toBe(false);
  });

  it('healthy probes with direct bypass do not block (warning path)', () => {
    expect(
      isBlockingContainmentFailure({
        bypassed: true,
        toolNamespace: 'pass',
        processBoundary: 'pass',
        configMasking: 'pass',
      }),
    ).toBe(false);
  });

  it('failed probes with direct bypass do not block except masking', () => {
    expect(
      isBlockingContainmentFailure({
        bypassed: true,
        toolNamespace: 'warn',
        processBoundary: 'warn',
        configMasking: 'pass',
      }),
    ).toBe(false);
    expect(
      isBlockingContainmentFailure({
        bypassed: true,
        toolNamespace: 'pass',
        processBoundary: 'pass',
        configMasking: 'fail',
      }),
    ).toBe(true);
  });

  it('failed probes without bypass block', () => {
    expect(
      isBlockingContainmentFailure({
        bypassed: false,
        toolNamespace: 'fail',
        processBoundary: 'pass',
        configMasking: 'pass',
      }),
    ).toBe(true);
    expect(
      isBlockingContainmentFailure({
        bypassed: false,
        toolNamespace: 'pass',
        processBoundary: 'fail',
        configMasking: 'pass',
      }),
    ).toBe(true);
  });
});

describe('launcher selection uses the host environment (no mocks)', () => {
  async function busSensitiveDir(): Promise<string> {
    const dir = await fakeBinDir({});
    if (isWindows) return dir;
    await writeFile(join(dir, 'systemctl'), '#!/bin/sh\nexit 0\n');
    await chmod(join(dir, 'systemctl'), 0o700);
    // Bus-sensitive like production: without a session bus address the
    // user manager is unreachable even though the binaries exist.
    await writeFile(
      join(dir, 'systemd-run'),
      '#!/bin/sh\nif [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then exit 1; fi\nexit 0\n',
    );
    await chmod(join(dir, 'systemd-run'), 0o700);
    return dir;
  }

  it('selects the systemd launcher with bus vars, throws without them', async () => {
    if (process.platform !== 'linux') return;
    const fakeDir = await busSensitiveDir();
    const withBus = withFakePath(fakeDir, {
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_RUNTIME_DIR: '/run/user/1000',
    });
    const launcher = await selectProductionLauncher(withBus);
    expect(launcher.kind).toBe('systemd-unit');
    const scrubbed = withFakePath(fakeDir);
    delete scrubbed['DBUS_SESSION_BUS_ADDRESS'];
    delete scrubbed['XDG_RUNTIME_DIR'];
    await expect(selectProductionLauncher(scrubbed)).rejects.toMatchObject({
      code: 'OPENCODE_SANDBOX_UNAVAILABLE',
    });
  });
});

describe('version policy matrix (no mocks)', () => {
  it('classifier: tested, blocked, override-allowed', () => {
    expect(classifyOpenCodeVersion('opencode version 1.18.32', {})).toBe('tested');
    expect(classifyOpenCodeVersion('opencode version 1.19.0', {})).toBe('blocked');
    expect(
      classifyOpenCodeVersion('opencode version 1.19.0', {
        SENTRY_OPENCODE_ALLOW_UNTESTED_VERSION: '1',
      }),
    ).toBe('override-allowed');
  });

  async function versionFixture(version: string): Promise<{
    dir: string;
    env: NodeJS.ProcessEnv;
  }> {
    const dir = await fakeBinDir({});
    if (isWindows) {
      await copyFile(process.execPath, join(dir, 'opencode.exe'));
    } else {
      await writeFile(
        join(dir, 'opencode'),
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "' + version + '"; fi\nexit 0\n',
      );
      await chmod(join(dir, 'opencode'), 0o700);
    }
    const env = credentialEnv(withFakePath(dir));
    delete env['SENTRY_OPENCODE_BINARY'];
    return { dir, env };
  }

  it('CASE B: untested version without override blocks everywhere', async () => {
    const { env } = await versionFixture('opencode version 1.19.0');
    const doctor = await doctorOpenCode({ environment: env });
    expect(doctor.checks?.find((check) => check.name === 'version')?.status).toBe('fail');
    expect(doctor.readiness).toBe('unavailable');
    if (process.platform === 'linux') {
      const registration = createOpenCodeRegistration({ environment: env });
      await expect(registration.preflight()).rejects.toMatchObject({
        code: 'OPENCODE_VERSION_MISMATCH',
      });
    }
  });

  it('CASE C: untested version with override degrades but allows', async () => {
    const { env } = await versionFixture('opencode version 1.19.0');
    env['SENTRY_OPENCODE_ALLOW_UNTESTED_VERSION'] = '1';
    // Isolate version policy from host sandbox state.
    env['SENTRY_OPENCODE_ALLOW_DIRECT'] = '1';
    const doctor = await doctorOpenCode({ environment: env });
    const versionCheck = doctor.checks?.find((check) => check.name === 'version');
    expect(versionCheck?.status).toBe('warn');
    expect(versionCheck?.message ?? '').toContain('SENTRY_OPENCODE_ALLOW_UNTESTED_VERSION=1');
    expect(doctor.status).toBe('degraded');
    expect(doctor.readiness).toBe('degraded');
    if (process.platform === 'linux') {
      const registration = createOpenCodeRegistration({ environment: env });
      await registration.preflight();
    }
  });

  it('CASE A: tested version passes version policy', async () => {
    if (isWindows) {
      // No exact-version fixture possible without a real binary; the
      // classifier unit test above covers the tested mapping on Windows.
      expect(classifyOpenCodeVersion('opencode version 1.18.32', {})).toBe('tested');
      return;
    }
    const { env } = await versionFixture('opencode version 1.18.32');
    const doctor = await doctorOpenCode({ environment: env });
    expect(doctor.checks?.find((check) => check.name === 'version')?.status).toBe('pass');
    // Version policy must not depend on unrelated host sandbox state: a
    // restricted CI host without systemd/bubblewrap reports containment
    // failures elsewhere, but the VERSION verdict stays 'pass'. Prove the
    // tested version itself never blocks preflight by isolating containment
    // with the explicit dev bypass (version + containment interaction is
    // covered separately by the preflight/doctor sandbox tests above).
    if (process.platform === 'linux') {
      const isolated = { ...env, SENTRY_OPENCODE_ALLOW_DIRECT: '1' };
      const registration = createOpenCodeRegistration({ environment: isolated });
      await registration.preflight();
    }
  });
});
