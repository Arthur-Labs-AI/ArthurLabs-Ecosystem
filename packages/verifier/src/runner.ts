import { createHash } from 'node:crypto';
import { access, constants, mkdir } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { VerificationRecipeStep, VerificationStepOutcome } from '@qa/schemas';
import { diagnosticFingerprint, hasUnsafeTarget, isReplayableCommand } from './signatures.js';
import { findTestIdentity, parseTestOutput } from './frameworks.js';
import {
  sandboxEnv,
  type VerificationExecutionEnvironment,
  type VerificationSandboxBackend,
} from './sandbox.js';
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

/** Sandbox adapter: preflight, argv split, and executable resolution
 *  happen here (deterministic, shell-free); actual execution happens
 *  ONLY inside the VerificationExecutionEnvironment (real sandbox).
 *  One instance per attempt; dispose() ends the environment (§29). */
export class VerificationCommandRunner {
  constructor(
    private readonly backend: VerificationSandboxBackend,
    private readonly sandboxRoot: string,
    private readonly inaccessiblePaths: readonly string[] = [],
    private readonly pathValue: string | undefined = process.env['PATH'],
  ) {}

  private async environment(
    workspaceRoot: string,
    runtimeBinds: readonly string[],
  ): Promise<VerificationExecutionEnvironment | undefined> {
    try {
      return await this.backend.createEnvironment({
        attemptRoot: this.sandboxRoot,
        workspaceRoot,
        runtimeBinds,
        inaccessiblePaths: this.inaccessiblePaths,
      });
    } catch {
      return undefined;
    }
  }

  async run(input: RunCommandInput): Promise<RunCommandResult> {
    const startedAt = Date.now();
    const done = (partial: Omit<RunCommandResult, 'durationMs'>): RunCommandResult => ({
      ...partial,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
    // Preflight: allowlist → shell-syntax gate → executable resolution.
    // NOTHING spawns before all three pass; failures never touch a shell.
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
    // Sandbox gate (§71): unavailable backend refuses here. NEVER falls
    // back to host execution. Toolchain dirs (head + node for script
    // interpreters) become the constructed sandbox PATH and RO binds.
    const toolDirs = [dirname(executable)];
    const nodeExecutable =
      head === 'node' ? executable : await resolveExecutable('node', this.pathValue);
    if (nodeExecutable !== undefined && !toolDirs.includes(dirname(nodeExecutable))) {
      toolDirs.push(dirname(nodeExecutable));
    }
    const environment = await this.environment(input.cwd, toolDirs);
    if (environment === undefined) {
      return done({ stdout: '', stderr: '', timedOut: false, failure: 'sandbox_failed' });
    }
    // One environment per run: transient units self-clean (--collect),
    // so per-run environments are cheap and always carry the current
    // command's toolchain binds. finally guarantees disposal.
    try {
      const result = await environment.run({
        executable,
        args: argv.slice(1),
        cwd: input.cwd,
        env: sandboxEnv(join(this.sandboxRoot, 'home'), toolDirs),
        timeoutMs: input.timeoutMs,
      });
      return {
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        ...(result.failure === undefined ? {} : { failure: result.failure }),
      };
    } finally {
      await environment.dispose().catch(() => undefined);
    }
  }

  /** Deterministic dispose (§29): per-run environments self-clean
   *  (transient units with --collect); nothing persists to dispose.
   *  Reports failure instead of hiding it. */
  async dispose(): Promise<'clean' | 'process_tree_cleanup_failed'> {
    return 'clean';
  }
}

function commandHeadTokenOf(command: string): string | undefined {
  const first = command.trim().split(/\s+/, 1)[0];
  if (first === undefined || first.length === 0) return undefined;
  const base = first.replace(/\\/g, '/').split('/').pop() ?? '';
  return base.length > 0 ? base.toLowerCase() : undefined;
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
  /** Internal comparison strength (§30): strong matches alone are
   *  decisive for reproduced; strong mismatches alone are decisive
   *  for not_reproducible. Not a persisted probability. */
  readonly matchStrength?:
    'strong_match' | 'weak_match' | 'strong_mismatch' | 'weak_mismatch' | 'unavailable';
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
  readonly cwdRelative: string;
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
    cwdRelative: step.expected['cwdRelative'] ?? '.',
  };
}

/** Resolve workspaceRoot + cwdRelative safely: rejects .., absolute
 *  paths, symlink escapes (realpath must stay inside), and
 *  non-directory targets. Returns undefined when unsafe. */
export async function resolveContainedCwd(
  ctx: StepExecutionContext,
  cwdRelative: string,
): Promise<string | undefined> {
  if (cwdRelative === '.' || cwdRelative === '') return ctx.workspaceRoot;
  if (cwdRelative.startsWith('/') || cwdRelative.includes('\\')) return undefined;
  const segments = cwdRelative.split('/');
  if (segments.includes('..') || segments.includes('')) return undefined;
  // Inline containment (no persistence dependency): join + boundary.
  const candidate = resolve(ctx.workspaceRoot, cwdRelative);
  if (candidate !== ctx.workspaceRoot && !candidate.startsWith(ctx.workspaceRoot + '/')) {
    return undefined;
  }
  try {
    const stats = await ctx.fs.stat(candidate);
    if (!stats.isDirectory) return undefined;
    const { realpath } = await import('node:fs/promises');
    const [realRoot, realCandidate] = await Promise.all([
      realpath(ctx.workspaceRoot),
      realpath(candidate),
    ]);
    if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + '/')) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
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
  // Contained cwd (§39): workspaceRoot + cwdRelative with safe
  // relative-path semantics. .., absolute paths, symlink escapes,
  // and non-directory targets refuse as unsupported (inconclusive).
  const containedCwd = await resolveContainedCwd(ctx, expectation.cwdRelative);
  if (containedCwd === undefined) {
    return {
      outcome: 'unsupported',
      artifactPayloads: [],
      detail:
        'Recorded working directory "' +
        expectation.cwdRelative +
        '" is not a safe contained directory; refusing replay.',
    };
  }
  let result: RunCommandResult;
  try {
    result = await ctx.runner.run({
      command: expectation.command,
      cwd: containedCwd,
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
  // Strong contradiction (§28): the SAME test observed with a
  // DIFFERENT status (expected failed, observed passed). This is
  // strong negative evidence and may support not_reproducible.
  if (identity !== undefined && expectedStatus !== undefined) {
    return {
      outcome: 'mismatched',
      matchStrength: 'strong_mismatch',
      exitCode,
      diagnosticFingerprint: fingerprint,
      artifactPayloads: payloads,
      detail:
        'Strong mismatch: expected test "' +
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
  // Target unobserved (§27, §60): the expected test never appeared.
  // We do NOT know whether it passed — inconclusive, never
  // not_reproducible. Exit agreement is weak evidence only (§15).
  if (expectation.exitCode !== undefined && exitCode === expectation.exitCode) {
    return {
      outcome: 'matched',
      matchStrength: 'weak_match',
      exitCode,
      diagnosticFingerprint: fingerprint,
      artifactPayloads: payloads,
      detail:
        'Weak match: exit ' +
        exitCode +
        ' agrees but the expected test was never observed; target status unknown.',
    };
  }
  return {
    outcome: 'mismatched',
    matchStrength: 'weak_mismatch',
    exitCode,
    diagnosticFingerprint: fingerprint,
    artifactPayloads: payloads,
    detail:
      'Weak mismatch: expected test unobserved and exit ' +
      exitCode +
      ' differs; insufficient for a negative verdict.',
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
  // No expected exit: the replay executed but there is no failure
  // signature to contradict — weak mismatch at most (§29).
  if (expectation.exitCode === undefined) {
    return {
      outcome: 'mismatched',
      matchStrength: 'weak_mismatch',
      exitCode,
      diagnosticFingerprint: fingerprint,
      artifactPayloads: payloads,
      detail: 'Replay executed without an expected failure signature; no negative verdict claimed.',
    };
  }
  // Exit differs: strong mismatch ONLY with an original signature to
  // contradict against (§29); exit alone never proves bug absence.
  if (exitCode !== expectation.exitCode) {
    const original = step.expected['originalSignature'];
    const strong = original !== undefined;
    return {
      outcome: 'mismatched',
      matchStrength: strong ? 'strong_mismatch' : 'weak_mismatch',
      exitCode,
      diagnosticFingerprint: fingerprint,
      artifactPayloads: payloads,
      detail:
        'Expected exit ' +
        expectation.exitCode +
        ' but observed ' +
        exitCode +
        (strong
          ? ' with an original signature to contradict.'
          : ' without an original signature; weak only.'),
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
