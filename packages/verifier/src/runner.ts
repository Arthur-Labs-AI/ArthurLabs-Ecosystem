import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, constants, mkdir } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import type { VerificationRecipeStep, VerificationStepOutcome } from '@qa/schemas';
import { diagnosticFingerprint, hasUnsafeTarget, isReplayableCommand } from './signatures.js';
import { findTestIdentity, parseTestOutput } from './frameworks.js';
import type { CanonicalOperation } from './recipe.js';

export interface RunCommandInput {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
}

export type VerificationExecutionFailure =
  | 'executable_unavailable'
  | 'spawn_failed'
  | 'timed_out'
  | 'sandbox_failed'
  | 'process_tree_cleanup_failed';

export interface RunCommandResult {
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly failure?: VerificationExecutionFailure;
}

/** Shell metacharacters requiring a real shell. Recorded commands
 *  containing any of these are NOT executed shell-less (§8): the step
 *  becomes `unsupported` (honest inconclusive), never an ad-hoc shell. */
const SHELL_SYNTAX = /(&&|\|\||[|;&`$<>*?#~]|\\n)/;

/** Split a simple recorded command into argv (POSIX quoting only).
 *  Returns undefined when shell syntax is present. */
export function splitArgv(command: string): string[] | undefined {
  if (SHELL_SYNTAX.test(command)) return undefined;
  const argv: string[] = [];
  let current = '';
  let quote: string | undefined;
  let hasToken = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
      hasToken = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (hasToken) {
        argv.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += char;
    hasToken = true;
  }
  if (quote !== undefined) return undefined;
  if (hasToken) argv.push(current);
  return argv.length > 0 ? argv : undefined;
}

/** Preflight executable resolution (§12): locate the head token on
 *  PATH without spawning a shell. Unresolvable → `unsupported`, never
 *  a shell 127 misread as bug absence (§11). */
export async function resolveExecutable(
  head: string,
  pathValue: string | undefined,
): Promise<string | undefined> {
  const extensions =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())
      : [''];
  const directories = (pathValue ?? '').split(delimiter).filter((d) => d.length > 0);
  const candidates: string[] =
    head.includes('/') || head.includes('\\') ? [head] : directories.map((dir) => join(dir, head));
  for (const candidate of candidates) {
    for (const extension of extensions) {
      const full = candidate + extension;
      try {
        await access(full, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return full;
      } catch {
        // Not this candidate; keep searching.
      }
    }
  }
  return undefined;
}

/** Disposable verifier-owned home (§9): <attemptRoot>/home. HOME,
 *  USERPROFILE, XDG_*, and package-manager config locations all point
 *  inside it. No user configuration is visible to replayed commands. */
export async function prepareDisposableHome(attemptRoot: string): Promise<string> {
  const home = join(attemptRoot, 'home');
  await mkdir(join(home, '.cache'), { recursive: true });
  await mkdir(join(home, '.config'), { recursive: true });
  await mkdir(join(home, '.npm'), { recursive: true });
  return home;
}

/** Minimal allowlisted child env (§10): PATH (+Windows essentials),
 *  LANG, CI marker, disposable HOME. Secrets are never forwarded;
 *  provider credentials cannot reach replayed commands. Real user
 *  HOME is never exposed (§9). */
export function runnerEnv(homeDir: string, pathValue: string | undefined): Record<string, string> {
  const env: Record<string, string> = {
    LANG: 'C.UTF-8',
    CI: '1',
    SENTRY_VERIFICATION: '1',
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: join(homeDir, '.config'),
    XDG_CACHE_HOME: join(homeDir, '.cache'),
    npm_config_cache: join(homeDir, '.npm'),
  };
  if (pathValue !== undefined && pathValue.length > 0) env['PATH'] = pathValue;
  if (process.platform === 'win32') {
    for (const key of ['SystemRoot', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
  }
  return env;
}

/** Real execution environment (§7): shell-less argv spawn inside the
 *  verifier workspace, owned process-group tracking, deterministic
 *  dispose. One instance per attempt; dispose() in finally (§29). */
export class VerificationCommandRunner {
  private readonly groups = new Set<number>();

  constructor(
    private readonly homeDir: string,
    private readonly pathValue: string | undefined = process.env['PATH'],
  ) {}

  async run(input: RunCommandInput): Promise<RunCommandResult> {
    const startedAt = Date.now();
    const done = (partial: Omit<RunCommandResult, 'durationMs'>): RunCommandResult => ({
      ...partial,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
    const head = commandHeadTokenOf(input.command);
    if (head === undefined) {
      return done({ stdout: '', stderr: '', timedOut: false, failure: 'executable_unavailable' });
    }
    const executable = await resolveExecutable(head, this.pathValue);
    if (executable === undefined) {
      return done({ stdout: '', stderr: '', timedOut: false, failure: 'executable_unavailable' });
    }
    const argv = splitArgv(input.command);
    if (argv === undefined || argv.length === 0) {
      return done({ stdout: '', stderr: '', timedOut: false, failure: 'sandbox_failed' });
    }
    let child: ChildProcess;
    try {
      child = spawn(executable, argv.slice(1), {
        cwd: input.cwd,
        env: runnerEnv(this.homeDir, this.pathValue),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch {
      return done({ stdout: '', stderr: '', timedOut: false, failure: 'spawn_failed' });
    }
    // Owned process-group tracking (§30): kill(-pgid) reaches
    // descendants (pnpm test children, servers). Never pkill/killall.
    if (child.pid !== undefined && process.platform !== 'win32') {
      this.groups.add(child.pid);
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
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
    if (child.pid !== undefined) this.groups.delete(child.pid);
    if (timedOut) {
      return done({ stdout, stderr, timedOut: true, failure: 'timed_out' });
    }
    if (exitCode === undefined) {
      return done({ stdout, stderr, timedOut: false, failure: 'spawn_failed' });
    }
    return done({ exitCode, stdout, stderr, timedOut: false });
  }

  /** Deterministic dispose (§29-30): terminate every tracked group.
   *  Reports cleanup failure instead of hiding it. */
  async dispose(): Promise<'clean' | 'process_tree_cleanup_failed'> {
    let failed = false;
    for (const pgid of [...this.groups]) {
      try {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/PID', String(pgid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          await new Promise<void>((resolveDone) => {
            killer.on('error', () => resolveDone());
            killer.on('close', () => resolveDone());
          });
        } else {
          try {
            process.kill(-pgid, 'SIGTERM');
          } catch {
            // Group already gone.
          }
          await sleep(1000);
          try {
            process.kill(-pgid, 'SIGKILL');
          } catch {
            // Group already gone.
          }
        }
      } catch {
        failed = true;
      }
      this.groups.delete(pgid);
    }
    return failed ? 'process_tree_cleanup_failed' : 'clean';
  }
}

function commandHeadTokenOf(command: string): string | undefined {
  const first = command.trim().split(/\s+/, 1)[0];
  if (first === undefined || first.length === 0) return undefined;
  const base = first.replace(/\\/g, '/').split('/').pop() ?? '';
  return base.length > 0 ? base.toLowerCase() : undefined;
}

function killTree(child: ChildProcess): void {
  try {
    if (process.platform === 'win32') {
      if (child.pid === undefined) return;
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).unref?.();
    } else if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          // Owned child already gone.
        }
      }
      setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // Owned child already gone.
          }
        }
      }, 2000).unref?.();
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // Kill best-effort; the close handler settles the result.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export interface FileSystem {
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean }>;
  readLines(
    path: string,
    startLine: number | undefined,
    endLine: number | undefined,
    expectedHash: string | undefined,
  ): Promise<{ present: boolean; hashMatch?: boolean }>;
}

export interface StepExecutionContext {
  readonly workspaceRoot: string;
  readonly fs: FileSystem;
  readonly runner: VerificationCommandRunner;
  readonly operationsById: ReadonlyMap<string, CanonicalOperation>;
  readonly commandTimeoutMs: number;
  readonly redact: (value: string) => string;
}

export interface ExecutedStep {
  readonly outcome: VerificationStepOutcome;
  /** Internal match strength (§21): only strong matches are decisive.
   *  Recorded in detail text; not a persisted probability. */
  readonly matchStrength?: 'strong_match' | 'weak_match';
  readonly warningCode?: 'VERIFIER_TOOL_UNAVAILABLE' | 'VERIFIER_REPLAY_TIMEOUT';
  readonly exitCode?: number;
  readonly diagnosticFingerprint?: string;
  readonly artifactPayloads: { stdout: string; stderr: string }[];
  readonly detail: string;
  readonly sourceCheck?: {
    readonly relativePath: string;
    readonly exists: boolean;
    readonly isRegularFile: boolean;
    readonly lineRangePresent: boolean;
    readonly contentHashMatch?: boolean;
  };
}

function insideWorkspace(workspaceRoot: string, relativePath: string): string | undefined {
  if (relativePath.length === 0 || relativePath.includes('\\')) return undefined;
  if (relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)) return undefined;
  const parts = relativePath.split('/');
  if (parts.includes('') || parts.includes('.') || parts.includes('..')) return undefined;
  return join(workspaceRoot, ...parts);
}

export async function executeSourceIntegrity(
  step: VerificationRecipeStep,
  ctx: StepExecutionContext,
): Promise<ExecutedStep> {
  const relativePath = step.expected['relativePath'] ?? '';
  const absolute = insideWorkspace(ctx.workspaceRoot, relativePath);
  if (absolute === undefined || resolve(absolute) !== absolute) {
    return {
      outcome: 'unsupported',
      artifactPayloads: [],
      detail: 'Path escapes the verifier workspace or is malformed: ' + relativePath.slice(0, 200),
    };
  }
  let stats: { isFile: boolean; isDirectory: boolean };
  try {
    stats = await ctx.fs.stat(absolute);
  } catch {
    return {
      outcome: 'mismatched',
      artifactPayloads: [],
      detail: 'File absent: ' + relativePath,
      sourceCheck: { relativePath, exists: false, isRegularFile: false, lineRangePresent: false },
    };
  }
  // §98: a directory where a regular file is claimed is malformed
  // evidence — unevaluatable, hence unsupported (feeds inconclusive).
  if (!stats.isFile) {
    return {
      outcome: 'unsupported',
      artifactPayloads: [],
      detail: stats.isDirectory
        ? 'Location is a directory, not a regular file: ' + relativePath
        : 'Location is not a regular file: ' + relativePath,
      sourceCheck: { relativePath, exists: true, isRegularFile: false, lineRangePresent: false },
    };
  }
  const startLine =
    step.expected['startLine'] === undefined ? undefined : Number(step.expected['startLine']);
  const endLine =
    step.expected['endLine'] === undefined ? undefined : Number(step.expected['endLine']);
  const lines = await ctx.fs.readLines(absolute, startLine, endLine, step.expected['contentHash']);
  if (!lines.present) {
    return {
      outcome: 'mismatched',
      artifactPayloads: [],
      detail: 'Expected line range absent: ' + relativePath,
      sourceCheck: { relativePath, exists: true, isRegularFile: true, lineRangePresent: false },
    };
  }
  if (lines.hashMatch === false) {
    return {
      outcome: 'mismatched',
      artifactPayloads: [],
      detail: 'Content hash mismatch: ' + relativePath,
      sourceCheck: {
        relativePath,
        exists: true,
        isRegularFile: true,
        lineRangePresent: true,
        contentHashMatch: false,
      },
    };
  }
  return {
    outcome: 'matched',
    artifactPayloads: [],
    detail: 'Source location confirmed.',
    sourceCheck: {
      relativePath,
      exists: true,
      isRegularFile: true,
      lineRangePresent: true,
      ...(lines.hashMatch === true ? { contentHashMatch: true as const } : {}),
    },
  };
}

export interface ReplayExpectation {
  readonly command: string;
  readonly exitCode?: number | undefined;
  readonly testName?: string | undefined;
  readonly testStatus?: 'passed' | 'failed' | 'skipped' | undefined;
}

function expectationOf(step: VerificationRecipeStep): ReplayExpectation {
  const exitRaw = step.expected['exitCode'];
  const parsed = exitRaw === undefined ? undefined : Number(exitRaw);
  return {
    command: step.expected['command'] ?? '',
    ...(parsed === undefined || !Number.isInteger(parsed) ? {} : { exitCode: parsed }),
    ...(step.expected['testName'] === undefined ? {} : { testName: step.expected['testName'] }),
    ...(step.expected['testStatus'] === undefined
      ? {}
      : { testStatus: step.expected['testStatus'] as ReplayExpectation['testStatus'] }),
  };
}

export async function executeReplay(
  step: VerificationRecipeStep,
  ctx: StepExecutionContext,
): Promise<ExecutedStep> {
  const expectation = expectationOf(step);
  if (expectation.command.length === 0) {
    return { outcome: 'unsupported', artifactPayloads: [], detail: 'Replay step has no command.' };
  }
  if (!isReplayableCommand(expectation.command)) {
    // §88 shape: missing/unknown tooling is inconclusive, never
    // not_reproducible. Unknown heads are treated the same way.
    return {
      outcome: 'unsupported',
      artifactPayloads: [],
      detail: 'Command head not in the v1 replay allowlist; refusing ad-hoc execution.',
      warningCode: 'VERIFIER_TOOL_UNAVAILABLE',
    };
  }
  if (hasUnsafeTarget(expectation.command)) {
    return {
      outcome: 'blocked',
      artifactPayloads: [],
      detail: 'Recorded command targets paths outside the verifier workspace; blocked.',
    };
  }
  let result: RunCommandResult;
  try {
    result = await ctx.runner.run({
      command: expectation.command,
      cwd: ctx.workspaceRoot,
      timeoutMs: ctx.commandTimeoutMs,
    });
  } catch (cause) {
    return {
      outcome: 'error',
      artifactPayloads: [],
      detail:
        'Runner error: ' + (cause instanceof Error ? cause.message : String(cause)).slice(0, 300),
    };
  }
  // Redact-before-persist (§24): everything downstream (fingerprint,
  // artifacts, details) derives from redacted text. Raw output never
  // leaves this function.
  const redactedStdout = ctx.redact(result.stdout).slice(0, 65536);
  const redactedStderr = ctx.redact(result.stderr).slice(0, 65536);
  const fingerprint = diagnosticFingerprint(
    redactedStdout + '\n' + redactedStderr,
    ctx.workspaceRoot,
  );
  const payloads = [{ stdout: redactedStdout, stderr: redactedStderr }];
  if (result.failure !== undefined) {
    // Start/tool/timeout/sandbox failures are environment facts,
    // never bug absence (§11-13): error feeds inconclusive.
    const detail =
      result.failure === 'executable_unavailable'
        ? 'Replay tool unavailable in the verification environment.'
        : result.failure === 'timed_out'
          ? 'Replay timed out; environment failure, not bug absence.'
          : 'Replay execution failure (' + result.failure + '); environment failure.';
    return {
      outcome: result.failure === 'executable_unavailable' ? 'unsupported' : 'error',
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      diagnosticFingerprint: fingerprint,
      artifactPayloads: payloads,
      detail,
      ...(result.failure === 'executable_unavailable'
        ? { warningCode: 'VERIFIER_TOOL_UNAVAILABLE' as const }
        : result.failure === 'timed_out'
          ? { warningCode: 'VERIFIER_REPLAY_TIMEOUT' as const }
          : {}),
    };
  }
  const exitCode = result.exitCode ?? 127;
  if (step.type === 'test_replay') {
    return evaluateTestReplay(
      step,
      expectation,
      exitCode,
      fingerprint,
      payloads,
      redactedStdout,
      redactedStderr,
    );
  }
  return evaluateCommandReplay(step, expectation, exitCode, fingerprint, payloads);
}

/** Test replay matching (§16-17): identity-required. The expected test
 *  must observably appear with the expected status (framework-parsed);
 *  exit match alone only ever yields a weak match (§15 adversarial).
 *  Unrecognizable output cannot establish identity → weak at best. */
function evaluateTestReplay(
  step: VerificationRecipeStep,
  expectation: ReplayExpectation,
  exitCode: number,
  fingerprint: string,
  payloads: { stdout: string; stderr: string }[],
  stdout: string,
  stderr: string,
): ExecutedStep {
  const parsed = parseTestOutput(stdout + '\n' + stderr);
  const identity =
    parsed !== undefined && expectation.testName !== undefined
      ? findTestIdentity(parsed, expectation.testName)
      : undefined;
  const expectedStatus = expectation.testStatus;
  if (
    identity !== undefined &&
    expectedStatus !== undefined &&
    identity.status === expectedStatus
  ) {
    return {
      outcome: 'matched',
      matchStrength: 'strong_match',
      exitCode,
      diagnosticFingerprint: fingerprint,
      artifactPayloads: payloads,
      detail:
        'Strong match: expected test "' +
        expectation.testName +
        '" observed with status ' +
        identity.status +
        ' (exit ' +
        exitCode +
        ').',
    };
  }
  if (identity !== undefined && expectedStatus !== undefined) {
    return {
      outcome: 'mismatched',
      exitCode,
      diagnosticFingerprint: fingerprint,
      artifactPayloads: payloads,
      detail:
        'Expected test "' +
        expectation.testName +
        '" observed with status ' +
        identity.status +
        ' (expected ' +
        expectedStatus +
        ', exit ' +
        exitCode +
        ').',
    };
  }
  // No identity: exit agreement is weak evidence only (§15, §20).
  if (expectation.exitCode !== undefined && exitCode === expectation.exitCode) {
    return {
      outcome: 'matched',
      matchStrength: 'weak_match',
      exitCode,
      diagnosticFingerprint: fingerprint,
      artifactPayloads: payloads,
      detail: 'Weak match: exit ' + exitCode + ' agrees but test identity unconfirmed.',
    };
  }
  return {
    outcome: 'mismatched',
    exitCode,
    diagnosticFingerprint: fingerprint,
    artifactPayloads: payloads,
    detail: 'Test identity unconfirmed and exit ' + exitCode + ' does not match expectation.',
  };
}

/** Command replay matching (§20, §22): exit agreement is weak unless
 *  the fresh signature equals the original-evidence signature (strong).
 *  No original signature → weak at most; never pretended (§22). */
function evaluateCommandReplay(
  step: VerificationRecipeStep,
  expectation: ReplayExpectation,
  exitCode: number,
  fingerprint: string,
  payloads: { stdout: string; stderr: string }[],
): ExecutedStep {
  if (expectation.exitCode === undefined || exitCode !== expectation.exitCode) {
    return {
      outcome: 'mismatched',
      exitCode,
      diagnosticFingerprint: fingerprint,
      artifactPayloads: payloads,
      detail:
        expectation.exitCode === undefined
          ? 'Replay executed without an expected failure signature; no match claimed.'
          : 'Expected exit ' + expectation.exitCode + ' but observed ' + exitCode + '.',
    };
  }
  const original = step.expected['originalSignature'];
  if (original !== undefined && original === fingerprint) {
    return {
      outcome: 'matched',
      matchStrength: 'strong_match',
      exitCode,
      diagnosticFingerprint: fingerprint,
      artifactPayloads: payloads,
      detail: 'Strong match: exit ' + exitCode + ' with identical failure signature.',
    };
  }
  return {
    outcome: 'matched',
    matchStrength: 'weak_match',
    exitCode,
    diagnosticFingerprint: fingerprint,
    artifactPayloads: payloads,
    detail:
      original === undefined
        ? 'Weak match: exit ' + exitCode + ' agrees but no original signature exists.'
        : 'Weak match: exit ' + exitCode + ' agrees but failure signature differs.',
  };
}

export function contentHashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
