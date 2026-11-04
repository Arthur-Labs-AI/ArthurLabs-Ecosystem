import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, constants } from 'node:fs/promises';

/**
 * Resolve the first executable candidate (absolute paths checked for
 * executability; bare names resolved optimistically for PATH lookup).
 * Returns undefined when nothing is usable.
 */
export async function findExecutable(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    } else if (candidate.trim().length > 0) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Owned OpenCode process boundary.
 *
 * OpenCode may launch descendants (`opencode → shell → npm test → app
 * server`). Killing only the direct child can orphan the tree, so Sentry
 * owns the full execution boundary:
 *
 * - On Linux with user systemd available: a transient `--user` unit per
 *   turn (`KillMode=control-group`, bounded `TimeoutStopSec`). Stopping
 *   the Sentry-owned unit (by exact name, never by process name) cleans
 *   the whole cgroup. No mount tweaks: unlike the Claude worker, OpenCode
 *   needs no namespace shadowing (HOME/XDG isolation is handled by the
 *   run scope); provider networking stays intact.
 * - Fallback (no systemd, e.g. dev/CI hosts): a detached process group;
 *   cancellation signals the whole group. Best-effort on Windows (group
 *   kill is POSIX-only; there the direct child is killed and a diagnostic
 *   records the weaker guarantee).
 *
 * Cancellation never touches processes outside the owned boundary: no
 * `pkill opencode`, no broad process names. Termination is always
 * TERM → bounded wait → verify → KILL escalate → diagnostic.
 */

export interface OwnedOpenCodeProcess {
  readonly child: ChildProcess;
  readonly kind: 'systemd-unit' | 'process-group' | 'direct';
  /** Sentry-owned unit name (systemd kind only). */
  readonly unitName?: string | undefined;
  /** Stop the owned boundary; resolves true when nothing owned remains. */
  stop(): Promise<boolean>;
}

export interface OpenCodeProcessLauncher {
  readonly kind: OwnedOpenCodeProcess['kind'];
  launch(input: {
    readonly executable: string;
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  }): OwnedOpenCodeProcess;
}

const ISOLATED_UNIT_PREFIX = 'sentry-opencode-';

export function mintIsolatedUnitName(): string {
  return (
    ISOLATED_UNIT_PREFIX + String(process.pid) + '-' + randomUUID().slice(0, 8).replace(/-/g, '')
  );
}

/** systemd-run client lifecycle lines (never program output). */
export function stripSystemdClientChatter(text: string): string {
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

async function stopSystemdUnit(
  systemctl: string,
  unitName: string,
  timeoutMs: number,
): Promise<boolean> {
  let killer: ChildProcess;
  try {
    killer = spawn(systemctl, ['--user', 'stop', unitName], {
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
  } catch {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(
      () => {
        try {
          killer.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        resolve(false);
      },
      Math.max(1, timeoutMs),
    );
    if (timer.unref !== undefined) timer.unref();
    killer.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    killer.on('close', (code) => {
      clearTimeout(timer);
      // 5 means the transient unit was already collected.
      resolve(code === 0 || code === 5);
    });
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
    if (timer.unref !== undefined) timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export interface SystemdLauncherOptions {
  readonly systemdRun?: string;
  readonly systemctl?: string;
  readonly stopTimeoutMs?: number;
  readonly mintUnitName?: () => string;
}

export interface SystemdLaunchInput {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/** Pure argv assembly (unit-tested on every platform; no processes). */
export function buildSystemdRunArgv(input: SystemdLaunchInput, unitName: string): string[] {
  const argv: string[] = [
    '--user',
    '--wait',
    '--pipe',
    '--collect',
    '--quiet',
    '--unit=' + unitName,
    '-p',
    'KillMode=control-group',
    '-p',
    'TimeoutStopSec=10s',
    '-p',
    'WorkingDirectory=' + input.cwd,
  ];
  for (const name of Object.keys(input.env)) {
    if (input.env[name] === undefined) continue;
    argv.push('--setenv=' + name);
  }
  argv.push('--', input.executable, ...input.argv);
  return argv;
}

/** Transient user unit per launch; cgroup owns the whole tree. */
export class SystemdOpenCodeProcessLauncher implements OpenCodeProcessLauncher {
  readonly kind = 'systemd-unit' as const;

  constructor(private readonly options: SystemdLauncherOptions = {}) {}

  launch(input: {
    readonly executable: string;
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  }): OwnedOpenCodeProcess {
    const systemdRun = this.options.systemdRun ?? 'systemd-run';
    const systemctl = this.options.systemctl ?? 'systemctl';
    const stopTimeoutMs = this.options.stopTimeoutMs ?? 10_000;
    const unitName = (this.options.mintUnitName ?? mintIsolatedUnitName)();
    // The transient UNIT receives exactly the sanitized input env via
    // --setenv=NAME (values travel in the client env, never on command
    // lines, never in journald/unit metadata). The CLIENT process itself
    // gets the same sanitized env plus only the bus address it needs to
    // reach the user manager — never raw process.env (which may hold
    // provider secrets or desktop credentials).
    const argv = buildSystemdRunArgv(input, unitName);
    const busEnv: NodeJS.ProcessEnv = {};
    for (const name of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
      const value = process.env[name];
      if (value !== undefined) busEnv[name] = value;
    }
    const child = spawn(systemdRun, argv, {
      cwd: input.cwd,
      env: { ...input.env, ...busEnv },
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stopped = false;
    return {
      child,
      kind: this.kind,
      unitName,
      stop: async () => {
        if (stopped) return true;
        stopped = true;
        const unitStopped = await stopSystemdUnit(systemctl, unitName, stopTimeoutMs);
        const exited = await waitForExit(child, 2_000);
        if (!exited) {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
          return false;
        }
        return unitStopped;
      },
    };
  }
}

export interface DirectLauncherOptions {
  readonly detached?: boolean;
  readonly stopTimeoutMs?: number;
}

/**
 * Terminate an owned Windows process TREE by exact PID (never by name).
 * `taskkill /T` takes down descendants that inherited handles (e.g. an
 * orphaned shell grandchild holding the session database open), which a
 * plain child kill leaves behind.
 */
async function taskkillTree(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let killer: ChildProcess;
    try {
      killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        try {
          killer.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        resolve(false);
      },
      Math.max(1, timeoutMs),
    );
    if (timer.unref !== undefined) timer.unref();
    killer.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
    killer.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * Direct spawn with an owned process group (POSIX) or owned PID tree
 * (Windows via taskkill /T on the exact owned PID).
 */
export class DirectOpenCodeProcessLauncher implements OpenCodeProcessLauncher {
  readonly kind: 'process-group' | 'direct';

  constructor(private readonly options: DirectLauncherOptions = {}) {
    const detached = options.detached ?? process.platform !== 'win32';
    this.kind = detached ? 'process-group' : 'direct';
  }

  launch(input: {
    readonly executable: string;
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  }): OwnedOpenCodeProcess {
    const detached = this.kind === 'process-group';
    const stopTimeoutMs = this.options.stopTimeoutMs ?? 10_000;
    const child = spawn(input.executable, [...input.argv], {
      cwd: input.cwd,
      env: input.env,
      windowsHide: true,
      shell: false,
      // stdin piped: prompts are delivered on stdin (never argv), and a
      // non-TTY stdin is consumed as message input by `opencode run`.
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(detached ? { detached: true as const } : {}),
    });
    let stopped = false;
    const stop = async (): Promise<boolean> => {
      if (stopped) return true;
      stopped = true;
      const useTreeKill = !detached && process.platform === 'win32' && child.pid !== undefined;
      // TERM the owned boundary first.
      try {
        if (useTreeKill) await taskkillTree(child.pid as number, 5_000);
        else if (detached && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        // Already gone; fall through to verification.
      }
      if (await waitForExit(child, stopTimeoutMs)) return true;
      // Escalate within the owned boundary only.
      try {
        if (detached && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else if (child.pid !== undefined && process.platform === 'win32')
          await taskkillTree(child.pid, 5_000);
        else child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      return waitForExit(child, 2_000);
    };
    return { child, kind: this.kind, stop };
  }
}

/**
 * Functional systemd user-unit probe (cheap, non-billable): proves the user
 * manager answers AND a transient user unit actually launches — the exact
 * mechanism production execution depends on. `--version` alone is NOT
 * sufficient (it never contacts the manager). No unit name is supplied so
 * systemd auto-generates one; `--wait --collect` leaves nothing behind.
 */
export async function probeSystemdUser(
  timeoutMs = 5_000,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const runBounded = (executable: string, argv: readonly string[]): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(executable, [...argv], {
          env: environment,
          stdio: 'ignore',
          windowsHide: true,
          shell: false,
        });
      } catch {
        resolve(false);
        return;
      }
      let settled = false;
      const timer = setTimeout(
        () => {
          if (settled) return;
          settled = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignored.
          }
          resolve(false);
        },
        Math.max(1, timeoutMs),
      );
      if (timer.unref !== undefined) timer.unref();
      child.on('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
  if (!(await runBounded('systemctl', ['--user', 'show-environment']))) return false;
  return runBounded('systemd-run', ['--user', '--pipe', '--wait', '--collect', '/usr/bin/true']);
}
