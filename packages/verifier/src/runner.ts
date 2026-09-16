import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { VerificationRecipeStep, VerificationStepOutcome } from '@qa/schemas';
import { diagnosticFingerprint, hasUnsafeTarget, isReplayableCommand } from './signatures.js';
import type { CanonicalOperation } from './recipe.js';

export interface RunCommandInput {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
}

export interface RunCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

/** Narrow contained command runner (§33): cwd is ALWAYS the verifier
 *  workspace, env is allowlisted (never inherited wholesale), output
 *  is bounded, timeouts kill only the owned child. No shell features
 *  beyond what the platform shell provides for the recorded string. */
export class VerificationCommandRunner {
  async run(input: RunCommandInput): Promise<RunCommandResult> {
    const startedAt = Date.now();
    const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh';
    const args =
      process.platform === 'win32' ? ['/d', '/s', '/c', input.command] : ['-c', input.command];
    const child = spawn(shell, args, {
      cwd: input.cwd,
      env: runnerEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Already exited; the close handler below settles the result.
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Owned child already gone.
        }
      }, 2000).unref?.();
    }, input.timeoutMs);
    if (timer.unref !== undefined) timer.unref();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 65536) stdout += chunk.toString('utf8').slice(0, 65536 - stdout.length);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 65536) stderr += chunk.toString('utf8').slice(0, 65536 - stderr.length);
    });
    const exitCode = await new Promise<number>((resolveExit) => {
      child.on('error', () => resolveExit(127));
      child.on('close', (code) => resolveExit(code ?? 127));
    });
    clearTimeout(timer);
    return {
      exitCode: timedOut ? 124 : exitCode,
      stdout,
      stderr,
      timedOut,
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }
}

/** Minimal allowlisted child env: PATH (+SystemRoot on Windows), LANG,
 *  CI marker. Secrets are never forwarded; the child cannot inherit
 *  provider credentials from the Sentry process. */
function runnerEnv(): Record<string, string> {
  const env: Record<string, string> = {
    LANG: 'C.UTF-8',
    CI: '1',
    SENTRY_VERIFICATION: '1',
  };
  const path = process.env['PATH'];
  if (path !== undefined && path.length > 0) env['PATH'] = path;
  if (process.platform === 'win32') {
    for (const key of ['SystemRoot', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
  } else {
    for (const key of ['HOME', 'TMPDIR']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
  }
  return env;
}

export interface FileSystem {
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean }>;
  readLines(
    path: string,
    startLine?: number,
    endLine?: number,
  ): Promise<{ present: boolean; hashMatch?: boolean; expectedHash?: string }>;
}

export interface StepExecutionContext {
  readonly workspaceRoot: string;
  readonly fs: FileSystem;
  readonly runner: { run(input: RunCommandInput): Promise<RunCommandResult> };
  readonly operationsById: ReadonlyMap<string, CanonicalOperation>;
  readonly commandTimeoutMs: number;
  readonly redact: (value: string) => string;
}

export interface ExecutedStep {
  readonly outcome: VerificationStepOutcome;
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
  const lines = await ctx.fs.readLines(absolute, startLine, endLine);
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
      sourceCheck: { relativePath, exists: true, isRegularFile: true, lineRangePresent: true },
    };
  }
  return {
    outcome: 'matched',
    artifactPayloads: [],
    detail: 'Source location confirmed.',
    sourceCheck: { relativePath, exists: true, isRegularFile: true, lineRangePresent: true },
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
  const redacted = ctx.redact(result.stdout + '\n' + result.stderr);
  const fingerprint = diagnosticFingerprint(redacted, ctx.workspaceRoot);
  const payloads = [
    { stdout: result.stdout.slice(0, 65536), stderr: result.stderr.slice(0, 65536) },
  ];
  if (result.timedOut) {
    return {
      outcome: 'error',
      exitCode: result.exitCode,
      diagnosticFingerprint: fingerprint,
      artifactPayloads: payloads,
      detail: 'Replay timed out; environment failure, not bug absence.',
    };
  }
  if (expectation.testStatus !== undefined) {
    const observed = testStatusOf(result);
    const matched = observed === expectation.testStatus;
    return {
      outcome: matched ? 'matched' : 'mismatched',
      exitCode: result.exitCode,
      diagnosticFingerprint: fingerprint,
      artifactPayloads: payloads,
      detail: matched
        ? 'Test status reproduced: ' + observed + '.'
        : 'Expected test status ' +
          expectation.testStatus +
          ' but observed ' +
          observed +
          ' (exit ' +
          result.exitCode +
          ').',
    };
  }
  if (expectation.exitCode !== undefined) {
    const matched = result.exitCode === expectation.exitCode;
    return {
      outcome: matched ? 'matched' : 'mismatched',
      exitCode: result.exitCode,
      diagnosticFingerprint: fingerprint,
      artifactPayloads: payloads,
      detail: matched
        ? 'Exit code reproduced: ' + result.exitCode + '.'
        : 'Expected exit ' + expectation.exitCode + ' but observed ' + result.exitCode + '.',
    };
  }
  // No expected signature beyond execution: the command ran in a
  // compatible environment without the claimed failure marker, so the
  // step yields no verdict on its own (classifier treats it as
  // non-decisive unless exit/test expectations exist).
  return {
    outcome: 'mismatched',
    exitCode: result.exitCode,
    diagnosticFingerprint: fingerprint,
    artifactPayloads: payloads,
    detail: 'Replay executed without an expected failure signature; no match claimed.',
  };
}

/** Coarse test-status derivation from replay output: explicit pass/fail
 *  markers win; otherwise a zero exit with no failure markers reads as
 *  passed, nonzero as failed. Deterministic and documented; borderline
 *  cases stay mismatched-safe (never invent a match). */
function testStatusOf(result: RunCommandResult): 'passed' | 'failed' | 'skipped' {
  const text = (result.stdout + '\n' + result.stderr).toLowerCase();
  if (/\bskipped\b/.test(text) && !/\bfailed\b/.test(text) && !/\bpassed\b/.test(text)) {
    return 'skipped';
  }
  if (/\b(failed|failure|failing|✗|×)\b/.test(text)) return 'failed';
  if (/\b(passed|passing|ok|✓)\b/.test(text) && result.exitCode === 0) return 'passed';
  return result.exitCode === 0 ? 'passed' : 'failed';
}

export function contentHashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
