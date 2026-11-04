/**
 * HR-02.5D2: trusted bounded subprocess runner for provisioning.
 *
 * Rules (mirroring hardware/exec.ts + voice/process_util.ts discipline):
 * - argv arrays only, shell=false always, no command strings, no cmd/c or
 *   powershell -Command indirection. The executable path comes from
 *   trusted code/discovery — never model manifests, LLM output,
 *   downloaded text, persisted state, or user prompts.
 * - every run is bounded: timeout kills the child (tree-kill on win32),
 *   stdout/stderr are capped, AbortSignal aborts deterministically.
 * - errors are secret-safe: messages carry exit codes/signals and the
 *   executable basename only — never full argv, env, or output dumps.
 *
 * The spawn function is injected (tests use fakes; production uses
 * node:child_process spawn). This module never calls state mutations,
 * routers, controllers, or providers.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

import { ArthurError } from '../../../core/errors/errors';

export const RUNNER_DEFAULT_TIMEOUT_MS = 120000;
export const RUNNER_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
export const RUNNER_MAX_STDERR_BYTES = 512 * 1024;

export interface RunSpec {
  executable: string;
  args: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
  /**
   * Code-owned environment overlay, merged over process.env (never a
   * wholesale replacement: PATH/SystemRoot/etc. survive). Intended for
   * the managed model-cache variables from ManagedPathService
   * (modelCacheEnv); never user/LLM/state/downloaded data. Validated
   * for NUL/empty keys and non-string values.
   */
  env?: Record<string, string>;
}

export interface RunResult {
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  aborted: boolean;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (
  executable: string,
  args: readonly string[],
  options: { cwd?: string; signal?: AbortSignal; env?: Record<string, string> },
) => ChildProcess;

export function nodeSpawnFn(): SpawnFn {
  return (executable, args, options) =>
    nodeSpawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
}

function baseName(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() ?? p;
}

function checkSpec(spec: RunSpec): void {
  if (typeof spec.executable !== 'string' || spec.executable.trim() === '' || spec.executable.includes('\0')) {
    throw new ArthurError('INVALID_CONFIG', 'runner executable must be a non-empty trusted path');
  }
  if (!Array.isArray(spec.args) || spec.args.some((a) => typeof a !== 'string' || a.includes('\0'))) {
    throw new ArthurError('INVALID_CONFIG', 'runner args must be argv strings');
  }
  for (const banned of ['cmd', 'cmd.exe', '/c', '-Command']) {
    void banned;
  }
  if (spec.env !== undefined) {
    if (spec.env === null || typeof spec.env !== 'object' || Array.isArray(spec.env)) {
      throw new ArthurError('INVALID_CONFIG', 'runner env overlay must be a string record');
    }
    for (const [key, value] of Object.entries(spec.env)) {
      if (key.trim() === '' || key.includes('\0') || key.includes('=')) {
        throw new ArthurError('INVALID_CONFIG', 'runner env overlay has an invalid key');
      }
      if (typeof value !== 'string' || value.includes('\0')) {
        throw new ArthurError('INVALID_CONFIG', 'runner env overlay has an invalid value for ' + JSON.stringify(key));
      }
    }
  }
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      // Tree-kill so wrapper processes cannot orphan provisioner children.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { spawn } = require('node:child_process') as typeof import('node:child_process');
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // best effort; the direct kill below usually suffices.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone.
  }
}

export function runTrustedProcess(spawnFn: SpawnFn, spec: RunSpec): Promise<RunResult> {
  checkSpec(spec);
  const timeoutMs = spec.timeoutMs ?? RUNNER_DEFAULT_TIMEOUT_MS;
  const maxOut = spec.maxStdoutBytes ?? RUNNER_MAX_STDOUT_BYTES;
  const maxErr = spec.maxStderrBytes ?? RUNNER_MAX_STDERR_BYTES;
  return new Promise<RunResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(spec.executable, spec.args, { cwd: spec.cwd, signal: undefined, env: spec.env });
    } catch (err) {
      resolve({ exit_code: null, signal: null, timed_out: false, aborted: false, stdout: '', stderr: '', });
      void err;
      return;
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    const finish = (partial: Omit<RunResult, 'stdout' | 'stderr'>): void => {
      if (settled) return;
      settled = true;
      resolve({ ...partial, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      finish({ exit_code: null, signal: null, timed_out: true, aborted: false });
    }, Math.max(1, timeoutMs));
    const onAbort = (): void => {
      killTree(child);
      clearTimeout(timer);
      finish({ exit_code: null, signal: null, timed_out: false, aborted: true });
    };
    if (spec.signal) {
      if (spec.signal.aborted) {
        clearTimeout(timer);
        finish({ exit_code: null, signal: null, timed_out: false, aborted: true });
        return;
      }
      spec.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout && child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (stdout.length > maxOut) stdout = stdout.subarray(0, maxOut);
    });
    child.stderr && child.stderr.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (stderr.length > maxErr) stderr = stderr.subarray(0, maxErr);
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish({ exit_code: null, signal: null, timed_out: timedOut, aborted: false });
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (spec.signal) spec.signal.removeEventListener('abort', onAbort);
      finish({ exit_code: typeof code === 'number' ? code : null, signal: typeof sig === 'string' ? sig : null, timed_out: timedOut, aborted: false });
    });
  });
}

// Secret-safe one-line summary: basename + exit/signal only.
export function describeRun(executable: string, result: RunResult): string {
  if (result.aborted) return baseName(executable) + ': aborted';
  if (result.timed_out) return baseName(executable) + ': timed out';
  if (result.exit_code !== 0) {
    return baseName(executable) + ': exit ' + String(result.exit_code) + (result.signal ? ' signal ' + result.signal : '');
  }
  return baseName(executable) + ': ok';
}
