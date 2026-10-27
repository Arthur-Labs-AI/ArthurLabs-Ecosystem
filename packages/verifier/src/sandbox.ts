import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, constants, mkdir, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import type { VerificationExecutionFailure } from './runner.js';

let nextUnitSequence = 0;

export interface SandboxAvailability {
  readonly available: boolean;
  readonly backend: 'systemd' | 'none';
  readonly reason?: string;
}

export interface SandboxCommandInput {
  readonly signal?: AbortSignal;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
}

export interface SandboxCommandResult {
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly failure?: VerificationExecutionFailure;
}

export interface SandboxEnvironmentInput {
  readonly attemptRoot: string;
  readonly workspaceRoot: string;
  /** Resolved read-only runtime directories (toolchain locations). */
  readonly runtimeBinds: readonly string[];
  /** Retained for interface stability. Isolation comes from the
   *  empty-root mount (unbound host paths are invisible), not from
   *  this list — runUnit intentionally adds no InaccessiblePaths
   *  mounts (they fail unit setup on some kernels; see runUnit). */
  readonly inaccessiblePaths: readonly string[];
}

/** Generic verification execution boundary (§6-7). Verifier code
 *  depends on this abstraction, never on provider harnesses or raw
 *  spawn. Exactly one environment per attempt; dispose() ends it. */
export interface VerificationSandboxBackend {
  readonly id: 'systemd' | 'none';
  /** Probe real isolation. probeParent must be a bindable directory
   *  on the same filesystem family the verifier will use (the Sentry
   *  dataRoot): the probe creates and removes a temp dir inside it.
   *  os.tmpdir() is not universally bindable (WSL2 private /tmp).
   *  HOME is hidden with tmpfs while explicitly bound workspaces remain visible. */
  preflight(probeParent: string): Promise<SandboxAvailability>;
  createEnvironment(input: SandboxEnvironmentInput): Promise<VerificationExecutionEnvironment>;
}

export interface VerificationExecutionEnvironment {
  readonly sandboxId: string;
  run(input: SandboxCommandInput): Promise<SandboxCommandResult>;
  dispose(): Promise<'clean' | 'process_tree_cleanup_failed'>;
}

/** Probes a binary on PATH without spawning a shell. */
async function probeBinary(name: string): Promise<string | undefined> {
  const pathValue = process.env['PATH'] ?? '';
  for (const dir of pathValue.split(delimiter).filter((d) => d.length > 0)) {
    const full = join(dir, name);
    try {
      await access(full, constants.X_OK);
      return full;
    } catch {
      // Keep searching.
    }
  }
  return undefined;
}

/** systemd transient-service sandbox (§7-12): real mount/user/network
 *  isolation via the user manager. Supported on Linux/WSL2 with a
 *  running user manager; everywhere else preflight reports
 *  unavailable and replay becomes honestly inconclusive (§13).
 *  NEVER falls back to host execution (§71). */
export class SystemdSandboxBackend implements VerificationSandboxBackend {
  readonly id = 'systemd' as const;
  private systemctl: string | undefined;
  private systemdRun: string | undefined;

  async preflight(probeParent: string): Promise<SandboxAvailability> {
    this.systemdRun = await probeBinary('systemd-run');
    this.systemctl = await probeBinary('systemctl');
    if (this.systemdRun === undefined || this.systemctl === undefined) {
      return { available: false, backend: 'none', reason: 'systemd user tools unavailable' };
    }
    try {
      const stats = await stat(probeParent);
      if (!stats.isDirectory()) throw new Error('not a directory');
    } catch {
      return { available: false, backend: 'none', reason: 'probe parent not usable' };
    }
    // Canary isolation proof: the probe root holds work/ (bound
    // writable as the workspace) and secret/ (never exposed). The
    // probe asserts work/ IS visible (execution works) AND secret/ is
    // NOT (isolation works). A single exit 0 proves both.
    // Probe inside probeParent (bindable, same fs family as the data
    // root). Never os.tmpdir() (private to the user manager on WSL2)
    // HOME paths are supported by a private tmpfs plus explicit workspace binds.
    // Execution proof: work/ IS visible. Hiding proofs: an unbound
    // peer beside work/ and a marker under the REAL home are invisible.
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { homedir } = await import('node:os');
    const probeDir = await mkdtemp(join(probeParent, '.sentry-sandbox-probe-'));
    const workDir = join(probeDir, 'work');
    const peerMarker = join(probeDir, 'peer-marker');
    const homeBase = join(homedir(), '.cache', 'sentry-sandbox-probe');
    const probeSuffix = process.pid + '-' + randomUUID().slice(0, 8);
    const marker = join(homeBase, 'host-marker-' + probeSuffix);
    const probeUnitPrefix = 'sentry-probe-' + probeSuffix;
    try {
      await mkdir(workDir, { recursive: true });
      await writeFile(peerMarker, 'peer', 'utf8');
      await mkdir(homeBase, { recursive: true });
      await writeFile(marker, 'host', 'utf8');
      const unitInput = {
        executable: '/usr/bin/test',
        cwd: workDir,
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 15000,
        workspaceRoot: workDir,
        homeDir: workDir,
        sandboxTmp: workDir,
        runtimeBinds: [],
        inaccessiblePaths: [],
      };
      // Bare startup probe (raw systemd-run, NO sandbox mounts):
      // distinguishes "user units cannot start here" from
      // mount/isolation failures in the checks below.
      const bare = await this.runBare(probeUnitPrefix + '-bare');
      if (!bare.ok) {
        return {
          available: false,
          backend: 'none',
          reason: 'sandbox user units cannot start: ' + bare.detail,
        };
      }
      // Shell-free assertions: work/ visible, unbound peer and host
      // HOME markers absent. A read-only host root would fail the peer.
      // Each check reports separately so CI diagnostics name the
      // failing mount instead of lumping all three together.
      const visible = await this.runUnit(probeUnitPrefix + '-exec', {
        ...unitInput,
        args: ['-d', workDir],
      });
      if (visible.exitCode !== 0 || visible.failure !== undefined) {
        return {
          available: false,
          backend: 'none',
          reason:
            'sandbox self-test: bound work dir not visible (exit ' +
            String(visible.exitCode) +
            (visible.failure === undefined ? '' : '/' + visible.failure) +
            '): ' +
            (visible.stderr.trim().slice(0, 300) || 'no stderr'),
        };
      }
      const hidden = await this.runUnit(probeUnitPrefix + '-hide', {
        ...unitInput,
        args: ['!', '-e', marker],
      });
      if (hidden.exitCode !== 0 || hidden.failure !== undefined) {
        return {
          available: false,
          backend: 'none',
          reason:
            'sandbox self-test: real-HOME marker visible (exit ' +
            String(hidden.exitCode) +
            (hidden.failure === undefined ? '' : '/' + hidden.failure) +
            '): ' +
            (hidden.stderr.trim().slice(0, 300) || 'no stderr'),
        };
      }
      const peerHidden = await this.runUnit(probeUnitPrefix + '-peer', {
        ...unitInput,
        args: ['!', '-e', peerMarker],
      });
      if (peerHidden.exitCode !== 0 || peerHidden.failure !== undefined) {
        return {
          available: false,
          backend: 'none',
          reason:
            'sandbox self-test: unbound peer marker visible (exit ' +
            String(peerHidden.exitCode) +
            (peerHidden.failure === undefined ? '' : '/' + peerHidden.failure) +
            '): ' +
            (peerHidden.stderr.trim().slice(0, 300) || 'no stderr'),
        };
      }
      return { available: true, backend: 'systemd' };
    } catch {
      return {
        available: false,
        backend: 'none',
        reason: 'sandbox preflight execution failed',
      };
    } finally {
      await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(marker, { force: true }).catch(() => undefined);
    }
  }

  async createEnvironment(
    input: SandboxEnvironmentInput,
  ): Promise<VerificationExecutionEnvironment> {
    const homeDir = join(input.attemptRoot, 'home');
    await mkdir(join(homeDir, '.cache'), { recursive: true });
    await mkdir(join(homeDir, '.config'), { recursive: true });
    await mkdir(join(homeDir, '.npm'), { recursive: true });
    const sandboxTmp = join(input.attemptRoot, 'tmp');
    await mkdir(sandboxTmp, { recursive: true });
    // Resolve runtime binds to real paths (no symlink escapes).
    const binds: string[] = [];
    for (const dir of input.runtimeBinds) {
      try {
        const stats = await stat(dir);
        if (!stats.isDirectory()) continue;
        binds.push(await realpath(dir));
      } catch {
        // Unresolvable bind source: skip (tool preflight covers absence).
      }
    }
    return new SystemdSandboxEnvironment({
      backend: this,
      workspaceRoot: input.workspaceRoot,
      homeDir,
      sandboxTmp,
      runtimeBinds: binds,
      inaccessiblePaths: input.inaccessiblePaths,
    });
  }

  /** Raw user-unit startup probe: `/usr/bin/true` with NO sandbox
   *  mounts. Proves the user manager accepts transient units here;
   *  mount/isolation failures are diagnosed by the checks below. */
  private async runBare(unitName: string): Promise<{ ok: boolean; detail: string }> {
    if (this.systemdRun === undefined) {
      return { ok: false, detail: 'systemd-run not found' };
    }
    const systemdRun = this.systemdRun;
    const done = (partial: { ok: boolean; detail: string }) => partial;
    let child: ChildProcess;
    try {
      child = spawn(
        systemdRun,
        ['--user', '--wait', '--pipe', '--collect', '--unit=' + unitName, '--', '/usr/bin/true'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
    } catch {
      return done({ ok: false, detail: 'spawn_failed' });
    }
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2048) stderr += chunk.toString('utf8').slice(0, 2048 - stderr.length);
    });
    const exitCode = await new Promise<number | undefined>((resolveExit) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        resolveExit(undefined);
      }, 15000);
      if (timer.unref !== undefined) timer.unref();
      child.on('error', () => {
        clearTimeout(timer);
        resolveExit(undefined);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolveExit(code ?? undefined);
      });
    });
    if (exitCode === 0) return done({ ok: true, detail: '' });
    return done({
      ok: false,
      detail: 'exit ' + String(exitCode) + ': ' + (stderr.trim().slice(0, 300) || 'no stderr'),
    });
  }

  async runUnit(
    unitName: string,
    input: {
      signal?: AbortSignal;
      executable: string;
      args: readonly string[];
      cwd: string;
      env: Record<string, string>;
      timeoutMs: number;
      workspaceRoot: string;
      homeDir: string;
      sandboxTmp: string;
      runtimeBinds: readonly string[];
      inaccessiblePaths: readonly string[];
    },
  ): Promise<SandboxCommandResult> {
    const startedAt = Date.now();
    input.signal?.throwIfAborted();
    const done = (partial: Omit<SandboxCommandResult, 'durationMs'>): SandboxCommandResult => ({
      ...partial,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
    if (this.systemdRun === undefined || this.systemctl === undefined) {
      return done({ stdout: '', stderr: '', timedOut: false, failure: 'sandbox_failed' });
    }
    const systemdRun = this.systemdRun;
    const systemctl = this.systemctl;
    // Start from an empty root, then expose ONLY the read-only system
    // toolchain and the verifier-owned workspace/HOME/tmp. ProtectSystem
    // alone prevents writes but leaves host and peer files readable;
    // combining it with TemporaryFileSystem=/ on WSL2 unexpectedly
    // reveals the host root again (caught by the peer preflight).
    // WSL2 rejects PrivateTmp/TemporaryFileSystem=/tmp with
    // ReadWritePaths (226/NAMESPACE); the empty-root mount succeeds.
    const properties: string[] = [
      'TemporaryFileSystem=/',
      // An inaccessible HOME mount masks explicit child workspace binds on WSL2.
      // A private tmpfs hides host HOME while allowing only our explicit binds.
      'ProtectHome=tmpfs',
      'PrivateNetwork=yes',
      'NoNewPrivileges=yes',
      'KillMode=control-group',
      'TimeoutStopSec=5s',
      'ProtectControlGroups=yes',
      'ProtectKernelTunables=yes',
      'ProtectKernelModules=yes',
      'RestrictSUIDSGID=yes',
      'WorkingDirectory=' + input.cwd,
      'ReadWritePaths=' + input.workspaceRoot,
      'ReadWritePaths=' + input.homeDir,
      'ReadWritePaths=' + input.sandboxTmp,
      'BindPaths=' + input.workspaceRoot,
      'BindPaths=' + input.homeDir,
      'BindPaths=' + input.sandboxTmp,
      'Environment=HOME=' + input.homeDir,
      'Environment=USERPROFILE=' + input.homeDir,
      'Environment=XDG_CONFIG_HOME=' + join(input.homeDir, '.config'),
      'Environment=XDG_CACHE_HOME=' + join(input.homeDir, '.cache'),
      'Environment=npm_config_cache=' + join(input.homeDir, '.npm'),
      'Environment=TMPDIR=' + input.sandboxTmp,
      'Environment=TMP=' + input.sandboxTmp,
      'Environment=TEMP=' + input.sandboxTmp,
    ];
    for (const [key, value] of Object.entries(input.env)) {
      if (key === 'HOME' || key === 'USERPROFILE') continue;
      properties.push('Environment=' + key + '=' + value);
    }
    // The empty root makes all unbound paths (including dataRoot and
    // real HOME) inaccessible already. Re-applying InaccessiblePaths
    // to missing host paths fails unit setup with 226/NAMESPACE on
    // WSL2, so do not add those redundant mounts here.
    for (const systemDir of ['/usr/bin', '/usr/lib', '/usr/share', '/bin', '/lib', '/lib64']) {
      properties.push('BindReadOnlyPaths=' + systemDir);
    }
    for (const bind of input.runtimeBinds) {
      properties.push('BindReadOnlyPaths=' + bind);
    }
    const argv: string[] = ['--user', '--wait', '--pipe', '--collect', '--unit=' + unitName];
    for (const property of properties) argv.push('-p', property);
    argv.push('--', input.executable, ...input.args);
    let child: ChildProcess;
    try {
      child = spawn(systemdRun, argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      return done({ stdout: '', stderr: '', timedOut: false, failure: 'spawn_failed' });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stopPromise: Promise<boolean> | undefined;
    const abort = (): void => {
      stopPromise ??= stopUnit(systemctl, unitName);
      try {
        child.kill('SIGKILL');
      } catch {
        /* Unit stop still owns teardown. */
      }
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    const timer = setTimeout(() => {
      timedOut = true;
      stopPromise = stopUnit(systemctl, unitName);
      try {
        child.kill('SIGKILL');
      } catch {
        // Client already gone; the unit stop owns cleanup.
      }
    }, input.timeoutMs);
    if (timer.unref !== undefined) timer.unref();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 65536) stdout += chunk.toString('utf8').slice(0, 65536 - stdout.length);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 65536) stderr += chunk.toString('utf8').slice(0, 65536 - stderr.length);
    });
    const exitCode = await new Promise<number | undefined>((resolveExit) => {
      child.on('error', () => resolveExit(undefined));
      child.on('close', (code) => resolveExit(code ?? undefined));
    });
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abort);
    if (input.signal?.aborted) {
      if (!(await stopPromise))
        return done({ stdout, stderr, timedOut: false, failure: 'process_tree_cleanup_failed' });
      input.signal.throwIfAborted();
    }
    // systemd-run may propagate its own setup failure as if it were
    // the replayed command's exit status. Namespace/exec/chdir failure
    // is an environment error, never evidence of bug absence.
    const unitSetupFailed = /status=(?:200\/CHDIR|203\/EXEC|226\/NAMESPACE)\b/.test(
      stdout + '\n' + stderr,
    );
    // systemd-run --pipe leaks unit lifecycle chatter on stderr
    // (unit names, invocation IDs — nondeterministic). Strip it so
    // captured output is exactly the replayed program's output.
    stdout = stripUnitChatter(stdout);
    stderr = stripUnitChatter(stderr);
    if (timedOut) {
      const stopped = await (stopPromise ?? stopUnit(systemctl, unitName));
      return done({
        stdout,
        stderr,
        timedOut: true,
        failure: stopped ? 'timed_out' : 'process_tree_cleanup_failed',
      });
    }
    if (unitSetupFailed) {
      return done({ stdout, stderr, timedOut: false, failure: 'sandbox_failed' });
    }
    if (exitCode === undefined) {
      return done({ stdout, stderr, timedOut: false, failure: 'spawn_failed' });
    }
    return done({ exitCode, stdout, stderr, timedOut: false });
  }
}

/** Remove systemd-run client lifecycle lines (never program output):
 *  `Running as unit: ...`, `Finished with result: ...`, and the
 *  indented `Main processes ... / Service runtime ... / CPU time ... /
 *  Memory peak ...` accounting lines. */
function stripUnitChatter(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('Running as unit:')) return false;
      if (trimmed.startsWith('Finished with result:')) return false;
      if (trimmed.startsWith('Main processes terminated with:')) return false;
      if (trimmed.startsWith('Service runtime:')) return false;
      if (trimmed.startsWith('CPU time consumed:')) return false;
      if (trimmed.startsWith('Memory peak:')) return false;
      return true;
    })
    .join('\n');
}

async function stopUnit(systemctl: string, unitName: string): Promise<boolean> {
  try {
    const killer = spawn(systemctl, ['--user', 'stop', unitName], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return await new Promise<boolean>((resolveStop) => {
      const timer = setTimeout(() => {
        killer.kill('SIGKILL');
        resolveStop(false);
      }, 10000);
      killer.on('error', () => {
        clearTimeout(timer);
        resolveStop(false);
      });
      killer.on('close', (code) => {
        clearTimeout(timer);
        // 5 means the transient unit was already collected.
        resolveStop(code === 0 || code === 5);
      });
    });
  } catch {
    return false;
  }
}

class SystemdSandboxEnvironment implements VerificationExecutionEnvironment {
  readonly sandboxId = 'systemd';
  private disposed = false;

  constructor(
    private readonly options: {
      backend: SystemdSandboxBackend;
      workspaceRoot: string;
      homeDir: string;
      sandboxTmp: string;
      runtimeBinds: readonly string[];
      inaccessiblePaths: readonly string[];
    },
  ) {}

  async run(input: SandboxCommandInput): Promise<SandboxCommandResult> {
    if (this.disposed) {
      return { stdout: '', stderr: '', timedOut: false, durationMs: 0, failure: 'sandbox_failed' };
    }
    nextUnitSequence += 1;
    const unitName = 'sentry-verify-' + process.pid + '-' + nextUnitSequence;
    return this.options.backend.runUnit(unitName, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      executable: input.executable,
      args: input.args,
      cwd: input.cwd,
      env: input.env,
      timeoutMs: input.timeoutMs,
      workspaceRoot: this.options.workspaceRoot,
      homeDir: this.options.homeDir,
      sandboxTmp: this.options.sandboxTmp,
      runtimeBinds: this.options.runtimeBinds,
      inaccessiblePaths: this.options.inaccessiblePaths,
    });
  }

  async dispose(): Promise<'clean' | 'process_tree_cleanup_failed'> {
    this.disposed = true;
    // Transient units use --collect (auto-cleanup on exit) and each run
    // stops its unit on timeout; the cgroup owns descendants, so no
    // tracked PIDs can outlive disposal. Nothing further to kill.
    return 'clean';
  }
}

/** Unavailable backend: every replay becomes unsupported (§13, §71).
 *  NEVER falls back to host execution. */
export class UnavailableSandboxBackend implements VerificationSandboxBackend {
  readonly id = 'none' as const;

  constructor(private readonly reason: string) {}

  async preflight(_probeParent: string): Promise<SandboxAvailability> {
    return { available: false, backend: 'none', reason: this.reason };
  }

  async createEnvironment(
    _input: SandboxEnvironmentInput,
  ): Promise<VerificationExecutionEnvironment> {
    throw new Error('Sandbox unavailable: ' + this.reason);
  }
}

/** Constructed sandbox PATH: resolved toolchain dirs + system dirs.
 *  The host PATH is NEVER inherited (WSL interop entries with spaces
 *  break unit setup; Windows dirs must not leak inside). Executable
 *  resolution always happens on the host before entering the sandbox. */
export function sandboxEnv(
  homeDir: string,
  toolchainDirs: readonly string[],
): Record<string, string> {
  const path = [...toolchainDirs, '/usr/bin', '/bin'].filter((d) => d.length > 0).join(':');
  return {
    LANG: 'C.UTF-8',
    CI: '1',
    SENTRY_VERIFICATION: '1',
    PATH: path,
  };
}

export function attemptSandboxPaths(attemptRoot: string): { homeDir: string } {
  return { homeDir: join(attemptRoot, 'home') };
}

export function sandboxParentDir(workspaceRoot: string): string {
  return dirname(workspaceRoot);
}
