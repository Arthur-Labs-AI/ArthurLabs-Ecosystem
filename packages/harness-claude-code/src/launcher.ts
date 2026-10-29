/**
 * Claude Code process launcher boundary (TASK-0012 mount isolation).
 *
 * Claude Code under WSL unconditionally enumerates Windows user profiles
 * beneath `/mnt/c/Users` and binds each `<profile>/.claude/ide` into its
 * internal bubblewrap sandbox. A traverse-only profile (e.g. a stale
 * sandbox account) fails EVERY Bash call before the shell starts, and no
 * HOME/CLAUDE_CONFIG_DIR isolation can prevent it — the enumeration does
 * not consult them. The fix launches Claude inside a Sentry-controlled
 * mount namespace where `/mnt/c` is shadowed by an empty tmpfs, so the
 * enumeration finds nothing. Linux workspace, ephemeral HOME, toolchain,
 * provider networking, and Claude's own inner bwrap sandbox are untouched.
 *
 * Design notes (all verified live on the Sentry WSL host):
 * - Minimal `TemporaryFileSystem=/mnt/c` shadow is preferred over an
 *   empty-root namespace: Claude keeps its full Linux environment
 *   (DNS, CA certs, toolchain, HOME, /tmp) with zero re-binding.
 * - `InaccessiblePaths=/mnt/c` is deliberately NOT used: the verifier
 *   history proves it fails unit setup with 226/NAMESPACE on WSL2.
 * - `PrivateNetwork` is deliberately NOT set: Claude needs HTTPS to the
 *   provider endpoint (the verifier uses it only because verification
 *   is model-free).
 * - Secret transport uses `systemd-run --setenv=NAME` (name only,
 *   verified on systemd 259): values are copied from the launcher
 *   process env into the unit, so argv/process listings never carry
 *   secret values. Never `systemctl --user set-environment` (persistent
 *   manager-global state shared between runs).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface ClaudeLaunchInput {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  /** Already-sanitized parent payload (buildClaudeSpawnEnv output). */
  readonly env: NodeJS.ProcessEnv;
  /**
   * Prompt text delivered over the child's stdin (`claude -p` reads it
   * when no positional prompt is given). Keeps the ever-growing prompt
   * out of argv, which is bounded by the OS (E2BIG).
   */
  readonly stdin?: string;
}

/** Write the prompt to the child's stdin and close it; never throws. */
export function feedClaudeStdin(child: ChildProcess, text: string): void {
  const stream = child.stdin;
  if (stream === null || stream === undefined) return;
  stream.on('error', () => {
    // EPIPE when the child exits before reading; its exit is reported elsewhere.
  });
  stream.end(text, 'utf8');
}

export interface OwnedClaudeProcess {
  /** Live child handle (systemd-run client for isolated launches). */
  readonly child: ChildProcess;
  /** Unique transient unit owned by this launch (isolated only). */
  readonly unitName: string | undefined;
  /** Stop the owned unit/cgroup; safe to call when already gone. */
  stopOwnedUnit(): Promise<boolean>;
}

export interface ClaudeProcessLauncher {
  readonly kind: 'direct' | 'wsl-isolated';
  launch(input: ClaudeLaunchInput): OwnedClaudeProcess;
}

/** Direct spawn: normal Linux, native Windows, and all test seams. */
export class DirectClaudeProcessLauncher implements ClaudeProcessLauncher {
  readonly kind = 'direct' as const;

  launch(input: ClaudeLaunchInput): OwnedClaudeProcess {
    const child = spawn(input.executable, [...input.argv], {
      cwd: input.cwd,
      env: input.env,
      windowsHide: true,
      shell: false,
      stdio: [input.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (input.stdin !== undefined) feedClaudeStdin(child, input.stdin);
    return {
      child,
      unitName: undefined,
      stopOwnedUnit: async () => true,
    };
  }
}

const ISOLATED_UNIT_PREFIX = 'sentry-glm-';

/** Deterministic-safe unique unit name: fixed prefix + pid + randomness.
 *  Never embeds prompts, paths, models, or any untrusted content. */
export function mintIsolatedUnitName(): string {
  return (
    ISOLATED_UNIT_PREFIX + String(process.pid) + '-' + randomUUID().slice(0, 8).replace(/-/g, '')
  );
}

/** Remove systemd-run client lifecycle lines (never program output). */
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

/** Stop exactly one Sentry-owned transient unit. Never by process name. */
export async function stopIsolatedUnit(
  systemctl: string,
  unitName: string,
  timeoutMs = 10_000,
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

/**
 * WSL mount-isolated launcher: Claude runs in a transient user unit
 * whose mount namespace shadows `/mnt/c` with an empty tmpfs.
 * Everything else (workspace, HOME, toolchain, network, inner bwrap)
 * behaves exactly like a direct launch.
 */
export class SystemdIsolatedClaudeProcessLauncher implements ClaudeProcessLauncher {
  readonly kind = 'wsl-isolated' as const;

  constructor(
    private readonly options: {
      readonly systemdRun?: string;
      readonly systemctl?: string;
      readonly mintUnitName?: () => string;
    } = {},
  ) {}

  launch(input: ClaudeLaunchInput): OwnedClaudeProcess {
    const systemdRun = this.options.systemdRun ?? 'systemd-run';
    const systemctl = this.options.systemctl ?? 'systemctl';
    const unitName = (this.options.mintUnitName ?? mintIsolatedUnitName)();
    // argv carries --setenv NAMES only: values travel from this process'
    // env into the unit (see launch() env merge below), never through
    // process listings, unit metadata, or logs.
    const argv: string[] = [
      '--user',
      '--wait',
      '--pipe',
      '--collect',
      '--quiet',
      '--unit=' + unitName,
      '-p',
      'TemporaryFileSystem=/mnt/c',
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
    const child = spawn(systemdRun, argv, {
      cwd: input.cwd,
      // Payload values ride in the CLIENT env so --setenv=NAME copies
      // them verbatim; argv itself carries names only. process.env is
      // spread first so bus/config vars survive; payload wins.
      env: { ...process.env, ...input.env },
      windowsHide: true,
      shell: false,
      stdio: [input.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    // --pipe forwards the client's stdin into the unit.
    if (input.stdin !== undefined) feedClaudeStdin(child, input.stdin);
    let stopped = false;
    return {
      child,
      unitName,
      stopOwnedUnit: async () => {
        if (stopped) return true;
        stopped = true;
        return stopIsolatedUnit(systemctl, unitName);
      },
    };
  }
}
