import type { AgentUsage } from '@qa/schemas';
import { OpenCodeHarnessError, type OpenCodeHarnessErrorCode } from './errors.js';
import {
  DirectOpenCodeProcessLauncher,
  probeSystemdUser,
  stripSystemdClientChatter,
  SystemdOpenCodeProcessLauncher,
  type OpenCodeProcessLauncher,
  type OwnedOpenCodeProcess,
} from './process.js';
import { redactDiagnostic, secretValues } from './redaction.js';
import { parseOpenCodeTurn, type OpenCodeToolObservation } from './wire.js';

/**
 * OpenCode integration mechanism (verified against opencode-ai 1.18.32:
 * release binary behavior plus the tagged source).
 *
 * - Headless turns: `opencode run --pure --model <provider/model>
 *   --format json [--session <id>]` with the prompt on STDIN (never argv,
 *   so prompts stay out of process listings). One owned child process per
 *   turn; cwd is the AgentRun's isolated workspace.
 * - Session continuity: the first turn creates the session; its
 *   `sessionID` is captured from the JSONL envelopes and passed back via
 *   `--session` on every later turn of the same AgentRun.
 * - Provider auth is file-based (`<XDG_DATA_HOME>/opencode/auth.json`);
 *   the key is in NO environment. Reporting turns additionally set
 *   `OPENCODE_PERMISSION='{"*":"deny"}'`, which removes all tools from
 *   the model (verified: "Available tools: .").
 * - Process ownership: systemd transient unit with
 *   `KillMode=control-group` when available, else an owned process group.
 *   Cancellation stops exactly the owned boundary (never by process name)
 *   with TERM → bounded wait → verify → KILL escalation.
 * - A live smoke (`SENTRY_LIVE_OPENCODE=1`, paid runs only with
 *   `SENTRY_LIVE_OPENCODE_RUN=1`) plus the zero-credit stub suite
 *   (`SENTRY_OPENCODE_STUB_TESTS=1` with a local stub provider) confirm
 *   this contract against the installed binary.
 */
export const OPENCODE_RUN_SUBCOMMAND = 'run' as const;
export const OPENCODE_JSON_FORMAT_FLAG = '--format' as const;
export const OPENCODE_MODEL_FLAG = '--model' as const;
export const OPENCODE_SESSION_FLAG = '--session' as const;
export const OPENCODE_PURE_FLAG = '--pure' as const;

export interface OpenCodePromptResult {
  readonly text: string;
  readonly toolCalls: readonly OpenCodeToolObservation[];
  readonly usage?: AgentUsage | undefined;
  /** Model steps observed (step-finish count). */
  readonly steps: number;
  /** OpenCode-owned session id captured from this turn's envelopes. */
  readonly sessionId?: string | undefined;
  readonly envelopes: number;
}

export interface OpenCodeTurnFailureClassification {
  readonly code: OpenCodeHarnessErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

function extractQuotedField(detail: string, key: string): string | undefined {
  const marker = '"' + key + '":"';
  const start = detail.indexOf(marker);
  if (start < 0) return undefined;
  const end = detail.indexOf('"', start + marker.length);
  if (end < 0) return undefined;
  const value = detail.slice(start + marker.length, end);
  return value.length > 0 && value.length <= 200 ? value : undefined;
}

function extractStatusCode(detail: string): number | undefined {
  const marker = '"statusCode":';
  const start = detail.indexOf(marker);
  if (start < 0) return undefined;
  const rest = detail.slice(start + marker.length).trimStart();
  const digits = /^\d{3}/.exec(rest)?.[0];
  return digits === undefined ? undefined : Number(digits);
}

function extractRetryable(detail: string): boolean | undefined {
  if (detail.includes('"isRetryable":true')) return true;
  if (detail.includes('"isRetryable":false')) return false;
  return undefined;
}

/**
 * Classify a failed turn's error detail (pure, unit-tested). OpenCode
 * STARTED correctly in these cases — the failure happened at the
 * provider/wire layer — so they must not be labeled OPENCODE_START_FAILED:
 * authentication problems become OPENCODE_AUTH_FAILED, Sentry proxy
 * rejections stay precise internal failures, and upstream/gateway failures
 * become OPENCODE_UPSTREAM_FAILED with preserved retryability.
 */
export function classifyOpenCodeTurnFailure(input: {
  readonly detail: string;
  readonly provider: string;
  readonly model: string;
}): OpenCodeTurnFailureClassification {
  const detail = input.detail.slice(0, 4000);
  const lowered = detail.toLowerCase();
  if (
    lowered.includes('sentry_proxy_error') ||
    lowered.includes('proxy_rejected') ||
    lowered.includes('model not allowed through this proxy') ||
    lowered.includes('unknown proxy route')
  ) {
    return {
      code: 'OPENCODE_START_FAILED',
      message: 'OpenCode proxy rejected the request: ' + detail.slice(0, 300),
      retryable: false,
    };
  }
  const status = extractStatusCode(detail);
  const envelopeRetryable = extractRetryable(detail);
  const upstreamMessage = extractQuotedField(detail, 'message');
  const correlation: string[] = [];
  const ray = extractQuotedField(detail, 'cf-ray');
  if (ray !== undefined) correlation.push('cf-ray ' + ray);
  const logId = extractQuotedField(detail, 'x-opencode-log-id');
  if (logId !== undefined) correlation.push('log ' + logId);
  const suffix = correlation.length > 0 ? ' [' + correlation.join(', ') + ']' : '';
  const authLike =
    status === 401 ||
    lowered.includes('unauthorized') ||
    lowered.includes('sign in') ||
    lowered.includes('apicallerror') ||
    lowered.includes('api key') ||
    lowered.includes('apikey') ||
    lowered.includes('credential');
  if (authLike) {
    return {
      code: 'OPENCODE_AUTH_FAILED',
      message:
        'OpenCode ' +
        input.provider +
        ' rejected the credential for ' +
        input.model +
        (status === undefined ? '' : ' (HTTP ' + String(status) + ')') +
        '.' +
        suffix,
      retryable: false,
    };
  }
  const upstreamLike =
    status === 429 ||
    (status !== undefined && status >= 500) ||
    lowered.includes('upstream') ||
    lowered.includes('gateway') ||
    lowered.includes('endpoint is unavailable') ||
    lowered.includes('endpoint unavailable') ||
    lowered.includes('server_error');
  if (upstreamLike) {
    const retryable =
      envelopeRetryable ?? (status === 429 || (status !== undefined && status >= 500));
    return {
      code: 'OPENCODE_UPSTREAM_FAILED',
      message:
        'OpenCode ' +
        input.provider +
        ' failed ' +
        input.model +
        (status === undefined ? '' : ' (HTTP ' + String(status) + ')') +
        (upstreamMessage === undefined ? '.' : ': ' + upstreamMessage) +
        ' Provider marked ' +
        (retryable ? 'retryable' : 'non-retryable') +
        '.' +
        suffix,
      retryable,
    };
  }
  return {
    code: 'OPENCODE_START_FAILED',
    message: 'OpenCode turn failed: ' + detail.slice(0, 300),
    retryable: envelopeRetryable ?? true,
  };
}

export interface OpenCodeRunPromptOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Continue an existing OpenCode session (turns 2+). */
  readonly sessionId?: string;
  /** Provider/model context for truthful provider-error classification. */
  readonly context?: { readonly provider: string; readonly model: string };
  /**
   * Per-turn environment override, merged over the session base (used
   * for turn-scoped Sentry controls such as the reporting permission
   * ruleset). Values never include secrets.
   */
  readonly environment?: NodeJS.ProcessEnv;
}

export interface OpenCodeSessionView {
  runPrompt(prompt: string, options: OpenCodeRunPromptOptions): Promise<OpenCodePromptResult>;
  abort(): void;
  /** Resolve when the owned boundary terminated (optional for test fakes). */
  settled?(): Promise<void>;
}

export interface OpenCodeClientView {
  startSession(): Promise<OpenCodeSessionView>;
  close(): Promise<void>;
}

export type OpenCodeClientFactory = (input: {
  readonly executable: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly modelId: string;
  readonly shutdownTimeoutMs: number;
  readonly launcher?: OpenCodeProcessLauncher;
}) => Promise<OpenCodeClientView>;

// Process-lifetime cache keyed on the minimal environment affecting systemd
// readiness (manager address, binary lookup). Safe because Sentry
// setup/repair always restarts (and redeploys) the runtime after repairing
// the environment, so a freshly started process never inherits a stale
// probe; within one process the manager state does not flap for the
// owned-cgroup decision, and caching avoids a transient-unit spawn per
// session start.
const systemdProbes = new Map<string, Promise<boolean>>();

function systemdProbeKey(environment: NodeJS.ProcessEnv): string {
  return [
    environment['PATH'],
    environment['XDG_RUNTIME_DIR'],
    environment['DBUS_SESSION_BUS_ADDRESS'],
  ]
    .map((value) => value ?? '')
    .join('\u0000');
}

/**
 * Production launcher selection (fail-closed).
 *
 * - Linux with a working systemd user manager → transient unit with
 *   `KillMode=control-group` (owned cgroup per turn).
 * - Anywhere else → direct launcher ONLY with explicit
 *   `SENTRY_OPENCODE_ALLOW_DIRECT=1` (development/test opt-in to weaker
 *   execution) — otherwise OPENCODE_SANDBOX_UNAVAILABLE. Production
 *   Sentry runtime is Linux; silent fallback never happens there.
 */
export async function selectProductionLauncher(
  environment: NodeJS.ProcessEnv,
): Promise<OpenCodeProcessLauncher> {
  if (process.platform === 'linux') {
    const key = systemdProbeKey(environment);
    let cached = systemdProbes.get(key);
    if (cached === undefined) {
      cached = probeSystemdUser(5_000, environment);
      systemdProbes.set(key, cached);
    }
    if (await cached) return new SystemdOpenCodeProcessLauncher();
    if (environment['SENTRY_OPENCODE_ALLOW_DIRECT'] === '1') {
      return new DirectOpenCodeProcessLauncher();
    }
    throw new OpenCodeHarnessError(
      'OPENCODE_SANDBOX_UNAVAILABLE',
      'OpenCode requires a systemd user runtime on Linux; no weaker fallback is permitted in production.',
    );
  }
  return new DirectOpenCodeProcessLauncher();
}

class ProductionSession implements OpenCodeSessionView {
  private owned: OwnedOpenCodeProcess | undefined;
  private aborted = false;

  constructor(
    private readonly executable: string,
    private readonly cwd: string,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly modelId: string,
    private readonly launcher: OpenCodeProcessLauncher,
  ) {}

  private stopPromise: Promise<boolean> | undefined;

  abort(): void {
    this.aborted = true;
    const owned = this.owned;
    this.owned = undefined;
    if (owned !== undefined) {
      this.stopPromise = owned.stop().catch(() => false);
    }
  }

  /** Resolve when the owned boundary has actually terminated. */
  async settled(): Promise<void> {
    await this.stopPromise?.catch(() => undefined);
  }

  runPrompt(prompt: string, options: OpenCodeRunPromptOptions): Promise<OpenCodePromptResult> {
    const secrets = secretValues({ ...this.environment, ...options.environment });
    return new Promise((resolve, reject) => {
      if (this.aborted) {
        reject(new OpenCodeHarnessError('OPENCODE_CANCEL_FAILED', 'OpenCode session was aborted.'));
        return;
      }
      const argv = [
        OPENCODE_RUN_SUBCOMMAND,
        OPENCODE_PURE_FLAG,
        OPENCODE_MODEL_FLAG,
        this.modelId,
        OPENCODE_JSON_FORMAT_FLAG,
        'json',
        ...(options.sessionId === undefined ? [] : [OPENCODE_SESSION_FLAG, options.sessionId]),
      ];
      const turnEnvironment = { ...this.environment, ...options.environment };
      let owned: OwnedOpenCodeProcess;
      try {
        owned = this.launcher.launch({
          executable: this.executable,
          argv,
          cwd: this.cwd,
          env: turnEnvironment,
        });
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException | undefined)?.code;
        reject(
          new OpenCodeHarnessError(
            code === 'ENOENT' ? 'OPENCODE_BINARY_NOT_FOUND' : 'OPENCODE_START_FAILED',
            code === 'ENOENT'
              ? 'OpenCode executable was not found: ' + this.executable
              : redactDiagnostic(cause, secrets),
            code !== 'ENOENT',
          ),
        );
        return;
      }
      this.owned = owned;
      const child = owned.child;
      const stripChatter = owned.kind === 'systemd-unit';
      let stdout = '';
      let stderr = '';
      let settled = false;
      let stdinFailed = false;
      const settle = (conclude: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (this.owned === owned) this.owned = undefined;
        conclude();
      };
      const onAbort = (): void => {
        const stop = owned.stop();
        settle(() => {
          void stop.catch(() => undefined);
          reject(
            new OpenCodeHarnessError('OPENCODE_CANCEL_FAILED', 'OpenCode turn was cancelled.'),
          );
        });
      };
      const timer = setTimeout(() => {
        const stop = owned.stop();
        settle(() => {
          void stop.catch(() => undefined);
          reject(
            new OpenCodeHarnessError(
              'OPENCODE_START_FAILED',
              'OpenCode turn exceeded its ' + String(options.timeoutMs) + ' ms budget.',
              true,
            ),
          );
        });
      }, options.timeoutMs);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted === true) {
        onAbort();
        return;
      }
      // Prompt on stdin: identical semantics to the message positional
      // (`message + "\\n" + piped`) while keeping prompts out of `ps`.
      try {
        if (child.stdin === null || child.stdin === undefined) {
          stdinFailed = true;
        } else {
          child.stdin.on('error', () => {
            stdinFailed = true;
          });
          child.stdin.end(prompt, 'utf8');
        }
      } catch {
        stdinFailed = true;
      }
      if (stdinFailed) {
        settle(() => {
          void owned.stop().catch(() => undefined);
          reject(
            new OpenCodeHarnessError(
              'OPENCODE_START_FAILED',
              'OpenCode turn could not deliver its prompt.',
              true,
            ),
          );
        });
        return;
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdout += stripChatter ? stripSystemdClientChatter(text) : text;
        if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
      });
      child.once('error', (cause: NodeJS.ErrnoException) => {
        const stop = owned.stop();
        settle(() => {
          void stop.catch(() => undefined);
          reject(
            new OpenCodeHarnessError(
              cause.code === 'ENOENT' ? 'OPENCODE_BINARY_NOT_FOUND' : 'OPENCODE_START_FAILED',
              cause.code === 'ENOENT'
                ? 'OpenCode executable was not found: ' + this.executable
                : redactDiagnostic(cause, secrets),
              cause.code !== 'ENOENT',
            ),
          );
        });
      });
      child.once('close', (code, signal) => {
        settle(() => {
          if (signal !== null) {
            reject(
              new OpenCodeHarnessError(
                'OPENCODE_START_FAILED',
                'OpenCode turn terminated by signal ' + signal + '.',
                true,
              ),
            );
            return;
          }
          const parsed = parseOpenCodeTurn(
            stripChatter ? stripSystemdClientChatter(stdout) : stdout,
          );
          // Error envelopes fail the turn even on exit 0: they carry
          // provider/auth failures, never model output. Classified so
          // upstream failures are never mislabeled as startup failures.
          if (parsed.errors.length > 0) {
            const failure = classifyOpenCodeTurnFailure({
              detail: redactDiagnostic(parsed.errors.join('; '), secrets),
              provider: options.context?.provider ?? 'opencode',
              model: options.context?.model ?? this.modelId,
            });
            reject(new OpenCodeHarnessError(failure.code, failure.message, failure.retryable));
            return;
          }
          if (code !== 0) {
            const detail = stderr || 'OpenCode run exited with code ' + String(code);
            const authLike = /auth|credential|sign in|unauthorized|401|api key|apicallerror/i.test(
              detail + '\n' + parsed.text,
            );
            reject(
              new OpenCodeHarnessError(
                authLike ? 'OPENCODE_AUTH_FAILED' : 'OPENCODE_START_FAILED',
                redactDiagnostic(detail, secrets),
                !authLike,
              ),
            );
            return;
          }
          // Fail closed on unparseable output: 'no-content' (valid wire,
          // empty text) still resolves so planning/reporting handle empty
          // text via their correction loops; every other outcome throws
          // OPENCODE_PROTOCOL_INVALID with a bounded redacted sample.
          if (parsed.outcome !== 'ok' && parsed.outcome !== 'no-content') {
            reject(
              new OpenCodeHarnessError(
                'OPENCODE_PROTOCOL_INVALID',
                'OpenCode turn output is not valid OpenCode JSONL (' +
                  parsed.outcome +
                  '): ' +
                  redactDiagnostic(stdout.trim().slice(0, 500), secrets),
              ),
            );
            return;
          }
          resolve({
            text: parsed.text,
            toolCalls: parsed.tools,
            usage: parsed.usage,
            steps: parsed.steps,
            sessionId: parsed.sessionId,
            envelopes: parsed.envelopes,
          });
        });
      });
    });
  }
}

export const createProductionOpenCodeClient: OpenCodeClientFactory = async (input) => {
  const launcher = input.launcher ?? (await selectProductionLauncher(input.environment));
  const sessions = new Set<ProductionSession>();
  let closed = false;
  return {
    startSession: async () => {
      if (closed) {
        throw new OpenCodeHarnessError('OPENCODE_START_FAILED', 'OpenCode client is closed.');
      }
      const session = new ProductionSession(
        input.executable,
        input.cwd,
        input.environment,
        input.modelId,
        launcher,
      );
      sessions.add(session);
      return session;
    },
    close: async () => {
      closed = true;
      for (const session of sessions) session.abort();
      // Await real process termination before releasing the client so
      // scope cleanup never races a dying OpenCode file watcher/DB.
      await Promise.all([...sessions].map((session) => session.settled?.()));
      sessions.clear();
    },
  };
};
