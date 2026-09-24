import { z } from 'zod';
import type { AgentUsage } from '@qa/schemas';

/**
 * Typed parser for the real `opencode run --format json` wire protocol
 * (verified against opencode-ai 1.18.32: CLI JSONL envelopes plus the
 * official SDK part types).
 *
 * Wire envelope (one JSON object per stdout line):
 *
 * ```json
 * { "type": "text", "timestamp": 1790198345477, "sessionID": "ses_...",
 *   "part": { "type": "text", "text": "...", "time": { "start": 1, "end": 2 }, ... } }
 * ```
 *
 * - `type` is one of: `text`, `tool_use`, `step_start`, `step_finish`,
 *   `reasoning`, `error`. Anything else is ignored (fail-closed: never
 *   evidence, never persisted text).
 * - `part` carries the SDK part object, always with its own `sessionID`.
 * - Tool parts: `{ type: "tool", tool: "<name>", callID: "...", state }`
 *   where `state.status` is `completed` (with `output`) or `error` (with
 *   an `error` string). There is NO top-level exit code; bash-family exit
 *   codes live ONLY in `state.metadata.exit` when the tool reports one.
 * - Usage arrives ONLY on `step-finish` parts as
 *   `tokens: { input, output, reasoning, cache: { read, write }, total }`.
 * - Reasoning parts (`type: "reasoning"`) are ALWAYS dropped: the CLI only
 *   emits them with `--thinking`, which Sentry never passes, and private
 *   model reasoning must never persist regardless.
 *
 * Schemas are intentionally tolerant of unknown extra keys (forward
 * compatibility across patch releases) but strict about the fields Sentry
 * consumes. OpenCode-native types never leave this package.
 */

const FiniteNumber = z.number().finite();

const TextPartSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
    time: z.object({ start: FiniteNumber, end: FiniteNumber.optional() }).optional(),
  })
  .passthrough();

export type OpenCodeTextPart = z.infer<typeof TextPartSchema>;

const ReasoningPartSchema = z.object({ type: z.literal('reasoning') }).passthrough();

const ToolStateCompletedSchema = z
  .object({
    status: z.literal('completed'),
    input: z.record(z.string(), z.unknown()),
    output: z.string(),
    title: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    time: z.object({ start: FiniteNumber, end: FiniteNumber.optional() }).optional(),
  })
  .passthrough();

const ToolStateErrorSchema = z
  .object({
    status: z.literal('error'),
    input: z.record(z.string(), z.unknown()),
    error: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    time: z.object({ start: FiniteNumber, end: FiniteNumber.optional() }).optional(),
  })
  .passthrough();

const ToolPartSchema = z
  .object({
    type: z.literal('tool'),
    tool: z.string().min(1),
    callID: z.string().min(1),
    state: z.union([ToolStateCompletedSchema, ToolStateErrorSchema]),
  })
  .passthrough();

export type OpenCodeToolPart = z.infer<typeof ToolPartSchema>;

const StepFinishTokensSchema = z
  .object({
    input: FiniteNumber.optional(),
    output: FiniteNumber.optional(),
    reasoning: FiniteNumber.optional(),
    total: FiniteNumber.optional(),
    cache: z.object({ read: FiniteNumber.optional(), write: FiniteNumber.optional() }).optional(),
  })
  .passthrough();

const StepFinishPartSchema = z
  .object({
    type: z.literal('step-finish'),
    reason: z.string(),
    tokens: StepFinishTokensSchema.optional(),
    cost: FiniteNumber.optional(),
  })
  .passthrough();

const StepStartPartSchema = z.object({ type: z.literal('step-start') }).passthrough();

const WirePartSchema = z.union([
  TextPartSchema,
  ReasoningPartSchema,
  ToolPartSchema,
  StepFinishPartSchema,
  StepStartPartSchema,
  // Any other part type: recognized as "known-unknown" and ignored.
  z.object({ type: z.string() }).passthrough(),
]);

export type OpenCodeWirePart = z.infer<typeof WirePartSchema>;

const WireEnvelopeSchema = z
  .object({
    type: z.string().min(1),
    timestamp: FiniteNumber.optional(),
    sessionID: z.string().min(1).optional(),
    part: WirePartSchema.optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

export type OpenCodeWireEnvelope = z.infer<typeof WireEnvelopeSchema>;

/** A single observed terminal tool execution (completed or error state). */
export interface OpenCodeToolObservation {
  readonly callID: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly status: 'completed' | 'error';
  readonly output?: string | undefined;
  readonly error?: string | undefined;
  /** ONLY from `state.metadata.exit` when it is a finite number. Never defaulted. */
  readonly exitCode?: number | undefined;
  readonly title?: string | undefined;
  readonly durationMs?: number | undefined;
}

export interface ParsedOpenCodeTurn {
  /** Concatenated finished assistant text parts (user echoes never appear on this wire). */
  readonly text: string;
  readonly tools: readonly OpenCodeToolObservation[];
  /** Summed step-finish token usage; fields OpenCode omits stay omitted. */
  readonly usage?: AgentUsage | undefined;
  /** Model steps observed this turn (step-finish count). */
  readonly steps: number;
  /** First sessionID observed on any envelope (turn-level continuity). */
  readonly sessionId?: string | undefined;
  /** Top-level error envelopes (provider/auth failures). */
  readonly errors: readonly string[];
  readonly envelopes: number;
  readonly skippedLines: number;
}

const MAX_TEXT = 200_000;
const MAX_TOOL_OBSERVATIONS = 200;

function boundedAppend(current: string, chunk: string): string {
  if (current.length >= MAX_TEXT) return current;
  return (current + chunk).slice(0, MAX_TEXT);
}

function finiteExit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.trunc(value);
}

function partExitCode(part: OpenCodeToolPart): number | undefined {
  const metadata = part.state.metadata;
  if (metadata === undefined) return undefined;
  return finiteExit(metadata['exit']);
}

function partDurationMs(part: OpenCodeToolPart): number | undefined {
  const time = part.state.time;
  if (time?.end === undefined) return undefined;
  const duration = time.end - time.start;
  if (!Number.isFinite(duration) || duration < 0) return undefined;
  return Math.trunc(duration);
}

function sumUsageInto(
  total: AgentUsage | undefined,
  tokens: z.infer<typeof StepFinishTokensSchema>,
): AgentUsage | undefined {
  const add = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined ? b : b === undefined ? a : a + b;
  const cached =
    tokens.cache === undefined ? undefined : add(tokens.cache.read, tokens.cache.write);
  const merged: AgentUsage = {
    ...(total?.inputTokens === undefined && tokens.input === undefined
      ? {}
      : { inputTokens: add(total?.inputTokens, tokens.input) }),
    ...(total?.outputTokens === undefined && tokens.output === undefined
      ? {}
      : { outputTokens: add(total?.outputTokens, tokens.output) }),
    ...(total?.cachedInputTokens === undefined && cached === undefined
      ? {}
      : { cachedInputTokens: add(total?.cachedInputTokens, cached) }),
  };
  return Object.keys(merged).length === 0 ? total : merged;
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 2000);
  try {
    return JSON.stringify(value).slice(0, 2000);
  } catch {
    return 'OpenCode reported an error envelope.';
  }
}

/** Parse one `opencode run --format json` turn (fail-closed, typed). */
export function parseOpenCodeTurn(stdout: string): ParsedOpenCodeTurn {
  let text = '';
  const tools: OpenCodeToolObservation[] = [];
  let usage: AgentUsage | undefined;
  let steps = 0;
  let sessionId: string | undefined;
  const errors: string[] = [];
  let envelopes = 0;
  let skippedLines = 0;
  let parsedAny = false;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      skippedLines += 1;
      continue;
    }
    const envelope = WireEnvelopeSchema.safeParse(raw);
    if (!envelope.success) {
      skippedLines += 1;
      continue;
    }
    parsedAny = true;
    envelopes += 1;
    const env = envelope.data;
    if (sessionId === undefined && env.sessionID !== undefined) sessionId = env.sessionID;
    if (env.type === 'error') {
      errors.push(errorText(env.error));
      continue;
    }
    const part = env.part;
    if (part === undefined) continue;
    if (sessionId === undefined) {
      const maybeSession = (part as unknown as { sessionID?: unknown }).sessionID;
      if (typeof maybeSession === 'string' && maybeSession.length > 0) sessionId = maybeSession;
    }
    if (part.type === 'reasoning') continue;
    if (part.type === 'text' && 'text' in part) {
      const fragment = (part as OpenCodeTextPart).text.trim();
      if (fragment.length > 0) text = boundedAppend(text + (text ? '\n' : ''), fragment);
      continue;
    }
    if (part.type === 'tool' && 'state' in part) {
      const tool = part as OpenCodeToolPart;
      if (tools.length >= MAX_TOOL_OBSERVATIONS) continue;
      const observation: OpenCodeToolObservation = {
        callID: tool.callID,
        tool: tool.tool.slice(0, 200),
        input: tool.state.input,
        status: tool.state.status,
        ...(tool.state.status === 'completed'
          ? { output: tool.state.output.slice(0, 8_000) }
          : { error: tool.state.error.slice(0, 2_000) }),
        ...(partExitCode(tool) === undefined ? {} : { exitCode: partExitCode(tool) as number }),
        ...(tool.state.status === 'completed' && tool.state.title !== undefined
          ? { title: tool.state.title.slice(0, 300) }
          : {}),
        ...(partDurationMs(tool) === undefined
          ? {}
          : { durationMs: partDurationMs(tool) as number }),
      };
      tools.push(observation);
      continue;
    }
    if (part.type === 'step-finish') {
      steps += 1;
      const tokens = (part as unknown as { tokens?: unknown }).tokens;
      if (tokens !== null && typeof tokens === 'object' && !Array.isArray(tokens)) {
        const parsedTokens = StepFinishTokensSchema.safeParse(tokens);
        if (parsedTokens.success) usage = sumUsageInto(usage, parsedTokens.data);
      }
    }
    // step-start, snapshot/patch/agent/retry/compaction and any future
    // part type: observed for session continuity only, never evidence.
  }
  if (!parsedAny) text = stdout.trim().slice(0, MAX_TEXT);
  return { text, tools, usage, steps, sessionId, errors, envelopes, skippedLines };
}
