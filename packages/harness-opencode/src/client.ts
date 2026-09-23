import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentUsage } from '@qa/schemas';
import { OpenCodeHarnessError } from './errors.js';
import { redactDiagnostic, secretValues } from './redaction.js';

/**
 * OpenCode integration mechanism (verified September 2026 against
 * `opencode-ai@1.18.32` and current OpenCode source):
 *
 * - The `opencode` binary runs headless and non-interactive:
 *   `opencode run [--model <id>] [--format json] "<prompt>"`.
 * - Sentry drives one owned `opencode run` child process per prompt turn
 *   (planning / investigation / report...), with cwd set to the AgentRun's
 *   isolated workspace and a Sentry-built sanitized environment.
 * - Provider auth is file-based, never env-based: the adapter writes the
 *   OpenRouter key to a Sentry-owned `auth.json` (`{"openrouter":
 *   {"type": "api", "key": "..."}}`) in a disposable directory and
 *   points the child at it via `XDG_DATA_HOME` (honored by OpenCode's
 *   global data path). OpenCode passes the stored key to its model SDK as
 *   `options.apiKey`, so `OPENROUTER_API_KEY` appears in NO child
 *   environment — and OpenCode shell tools, which inherit the host
 *   process environment, cannot observe it. Isolation by construction.
 * - No TUI scraping, no shared daemon: each AgentRun owns its processes,
 *   cancellation kills only the owned child, cleanup (including the auth
 *   boundary) is deterministic.
 * - A live smoke (`SENTRY_LIVE_OPENCODE=1`) confirms the exact flags
 *   against the installed binary; see tests/live-opencode.test.ts. If the
 *   installed OpenCode changes its headless flags, the smoke fails loud
 *   and this module is updated — never worked around in the adapter.
 *
 * Tool-call envelopes: `opencode run --format json` emits NDJSON. Only
 * explicitly recognized tool-call envelopes become Sentry tool events
 * (fail-closed: unknown envelopes contribute bounded text, never tool
 * completions — the adapter must never invent tool activity).
 */
export const OPENCODE_RUN_SUBCOMMAND = 'run' as const;
export const OPENCODE_JSON_FORMAT_FLAG = '--format' as const;
export const OPENCODE_MODEL_FLAG = '--model' as const;

export interface OpenCodeObservedToolCall {
  readonly name: string;
  readonly arguments?: unknown;
  readonly output?: string;
  readonly exitCode?: number;
}

export interface OpenCodePromptResult {
  readonly text: string;
  readonly toolCalls: readonly OpenCodeObservedToolCall[];
  readonly usage?: AgentUsage | undefined;
  /** Count of NDJSON envelopes observed (diagnostic only). */
  readonly envelopes: number;
}

export interface OpenCodeRunPromptOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface OpenCodeSessionView {
  runPrompt(prompt: string, options: OpenCodeRunPromptOptions): Promise<OpenCodePromptResult>;
  abort(): void;
}

export interface OpenCodeClientView {
  startSession(input: { readonly sessionId: string }): Promise<OpenCodeSessionView>;
  close(): Promise<void>;
}

export type OpenCodeClientFactory = (input: {
  readonly executable: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly modelId: string;
  readonly provider: string;
  /** Sentry-owned disposable data dir holding the auth boundary file. */
  readonly xdgDataHome: string;
  readonly shutdownTimeoutMs: number;
}) => Promise<OpenCodeClientView>;

const MAX_TEXT = 200_000;
const MAX_TOOL_CALLS = 200;

function boundedAppend(current: string, chunk: string): string {
  if (current.length >= MAX_TEXT) return current;
  return (current + chunk).slice(0, MAX_TEXT);
}

function eventText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Recognize an explicit tool-call envelope. ONLY these shapes map to tool
 * events; everything else is text. Shapes accepted:
 * - { type: 'tool_call'|'tool_use'|'tool-call', name|tool, input|arguments, output?, exitCode? }
 * - { tool_calls: [...] } summary envelopes with the same item shape.
 */
export function extractToolCalls(envelope: unknown): OpenCodeObservedToolCall[] {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return [];
  const record = envelope as Record<string, unknown>;
  const items: unknown[] = [];
  const type = typeof record['type'] === 'string' ? (record['type'] as string) : '';
  if (type === 'tool_call' || type === 'tool_use' || type === 'tool-call') items.push(record);
  const nested = record['tool_calls'];
  if (Array.isArray(nested)) items.push(...nested);
  const out: OpenCodeObservedToolCall[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const name =
      eventText(entry['name']) ?? eventText(entry['tool']) ?? eventText(entry['toolName']);
    if (name === undefined) continue;
    const output = eventText(entry['output']) ?? eventText(entry['result']);
    const exitCode = typeof entry['exitCode'] === 'number' ? entry['exitCode'] : undefined;
    out.push({
      name: name.slice(0, 200),
      ...(entry['input'] === undefined && entry['arguments'] === undefined
        ? {}
        : { arguments: entry['input'] ?? entry['arguments'] }),
      ...(output === undefined ? {} : { output: output.slice(0, 8_000) }),
      ...(exitCode === undefined ? {} : { exitCode }),
    });
    if (out.length >= MAX_TOOL_CALLS) break;
  }
  return out;
}

/**
 * Envelope types carrying private model reasoning. Their fields are NEVER
 * mapped to persisted text: Sentry prohibits exposing or persisting
 * chain-of-thought (only observable execution and product-safe summaries
 * persist). Unknown types stay text-eligible only through the explicit
 * safe-field list below — reasoning-suffixed types are denied first.
 */
const REASONING_ENVELOPE_TYPES = new Set([
  'thinking',
  'reasoning',
  'thought',
  'internal',
  'reasoning_content',
  'thinking_content',
]);

export function extractText(envelope: unknown): string | undefined {
  if (typeof envelope === 'string') return eventText(envelope);
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope))
    return undefined;
  const record = envelope as Record<string, unknown>;
  const type = typeof record['type'] === 'string' ? (record['type'] as string) : '';
  if (type === 'tool_call' || type === 'tool_use' || type === 'tool-call') return undefined;
  if (REASONING_ENVELOPE_TYPES.has(type)) return undefined;
  return (
    eventText(record['text']) ??
    eventText(record['content']) ??
    eventText(record['message']) ??
    eventText(record['output']) ??
    eventText(record['result'])
  );
}

export function extractUsage(envelope: unknown): AgentUsage | undefined {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope))
    return undefined;
  const record = envelope as Record<string, unknown>;
  const usage = record['usage'];
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const view = usage as Record<string, unknown>;
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const out: AgentUsage = {
    ...(num(view['inputTokens']) === undefined ? {} : { inputTokens: num(view['inputTokens']) }),
    ...(num(view['outputTokens']) === undefined ? {} : { outputTokens: num(view['outputTokens']) }),
    ...(num(view['cachedInputTokens']) === undefined
      ? {}
      : { cachedInputTokens: num(view['cachedInputTokens']) }),
    ...(num(view['turns']) === undefined ? {} : { turns: num(view['turns']) }),
    ...(num(view['durationMs']) === undefined ? {} : { durationMs: num(view['durationMs']) }),
  };
  return Object.keys(out).length === 0 ? undefined : out;
}

class ProductionSession implements OpenCodeSessionView {
  private activeChild: ChildProcess | undefined;
  private aborted = false;

  constructor(
    private readonly executable: string,
    private readonly cwd: string,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly modelId: string,
    private readonly xdgDataHome: string,
  ) {}

  abort(): void {
    this.aborted = true;
    try {
      this.activeChild?.kill('SIGTERM');
    } catch {
      // Kill is best-effort; the timeout path below guarantees boundedness.
    }
  }

  runPrompt(prompt: string, options: OpenCodeRunPromptOptions): Promise<OpenCodePromptResult> {
    const secrets = secretValues(this.environment);
    return new Promise((resolve, reject) => {
      if (this.aborted) {
        reject(new OpenCodeHarnessError('OPENCODE_CANCEL_FAILED', 'OpenCode session was aborted.'));
        return;
      }
      let child: ChildProcess;
      try {
        child = spawn(
          this.executable,
          [
            OPENCODE_RUN_SUBCOMMAND,
            OPENCODE_MODEL_FLAG,
            this.modelId,
            OPENCODE_JSON_FORMAT_FLAG,
            'json',
            prompt,
          ],
          {
            cwd: this.cwd,
            env: {
              ...this.environment,
              // Sentry-owned auth scope: OpenCode resolves its provider
              // credential from `<XDG_DATA_HOME>/opencode/auth.json`.
              // The secret itself is in no environment (see auth.ts).
              XDG_DATA_HOME: this.xdgDataHome,
            },
            windowsHide: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
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
      this.activeChild = child;
      let stdout = '';
      let stderr = '';
      let settled = false;
      const settle = (conclude: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (this.activeChild === child) this.activeChild = undefined;
        conclude();
      };
      const onAbort = (): void => {
        settle(() => {
          try {
            child.kill('SIGTERM');
          } catch {
            // Ignored: the run already concluded as cancelled.
          }
          reject(
            new OpenCodeHarnessError('OPENCODE_CANCEL_FAILED', 'OpenCode turn was cancelled.'),
          );
        });
      };
      const timer = setTimeout(() => {
        settle(() => {
          try {
            child.kill('SIGTERM');
          } catch {
            // Ignored: watchdog already owns the outcome.
          }
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
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = boundedAppend(stdout, chunk.toString('utf8'));
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = boundedAppend(stderr, chunk.toString('utf8'));
      });
      child.once('error', (cause: NodeJS.ErrnoException) => {
        settle(() => {
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
          if (code !== 0) {
            const authLike = /auth|credential|sign in|unauthorized|401|api key/i.test(
              stderr + '\n' + stdout,
            );
            reject(
              new OpenCodeHarnessError(
                authLike ? 'OPENCODE_AUTH_FAILED' : 'OPENCODE_START_FAILED',
                redactDiagnostic(
                  stderr || 'OpenCode run exited with code ' + String(code),
                  secrets,
                ),
                !authLike,
              ),
            );
            return;
          }
          resolve(parseRunOutput(stdout));
        });
      });
    });
  }
}

/** Parse `opencode run --format json` NDJSON output (fail-closed). */
export function parseRunOutput(stdout: string): OpenCodePromptResult {
  let text = '';
  let toolCalls: OpenCodeObservedToolCall[] = [];
  let usage: AgentUsage | undefined;
  let envelopes = 0;
  const lines = stdout.split(/\r?\n/);
  let parsedAny = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let envelope: unknown;
    try {
      envelope = JSON.parse(trimmed);
    } catch {
      continue;
    }
    parsedAny = true;
    envelopes += 1;
    const calls = extractToolCalls(envelope);
    if (calls.length > 0) toolCalls = toolCalls.concat(calls).slice(0, MAX_TOOL_CALLS);
    const fragment = extractText(envelope);
    if (fragment !== undefined) text = boundedAppend(text + (text ? '\n' : ''), fragment);
    const observed = extractUsage(envelope);
    if (observed !== undefined) usage = observed;
  }
  if (!parsedAny) text = stdout.trim().slice(0, MAX_TEXT);
  return { text, toolCalls, usage, envelopes };
}

export const createProductionOpenCodeClient: OpenCodeClientFactory = async (input) => {
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
        input.xdgDataHome,
      );
      sessions.add(session);
      return session;
    },
    close: async () => {
      closed = true;
      for (const session of sessions) session.abort();
      sessions.clear();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
};
