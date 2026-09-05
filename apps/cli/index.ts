/**
 * ARTHUR CLI (spec section 14) and Developer Console (DEV-CLI-1).
 *
 * A thin entry point over the same core services the HTTP API uses. It contains
 * no second implementation of orchestration, never invokes tool executors, and
 * exposes no raw registry, execution service, adapter, or approval secret:
 * every turn and every tool action flows through
 *
 *   apps/cli -> buildApp() -> ConversationService -> ToolOrchestrator
 *            -> ToolExecutionService
 *
 * exactly like the HTTP path. The developer console is OBSERVABILITY, not
 * authority: CLI visibility != permission, CLI command != tool authorization,
 * tool catalog != executable handle, verbose mode != debug secret dump. There
 * are deliberately no bypass flags (--unsafe/--force/--skip-approval/...).
 *
 *   arthur chat --mode personal|business [--session <id>] [--verbose]
 *   arthur ask --mode personal|business [--verbose] [--json] "<message>"
 *   arthur voice --mode personal|business [--session <id>] [--verbose]
 *   arthur tools [--mode personal|business] [--json]
 *   arthur tools inspect <tool-name> [--json]
 *   arthur status [--json]
 *   arthur session <id> [--json]
 *   arthur approve <approval-id>
 *   arthur reject <approval-id>
 *   arthur memory ... / arthur documents ...
 */

import { createInterface } from "node:readline";

import { buildApp } from "../../src/app";
import { ArthurError, sanitizePublicError } from "../../src/core/errors/errors";
import { isSecretLikeKey } from "../../src/security/redaction";
import { SecretSanitizer } from "../../src/security/sanitize";
import { isArthurMode, ArthurMode } from "../../src/core/modes/mode";
import { loadDotEnv } from "../../src/config/settings";
import { newId } from "../../src/observability/tracing";
import { parseTypeLabel } from "../../src/memory/api";
import type { MemoryStatusReport } from "../../src/memory/contracts";
import type { ToolCallSummary } from "../../src/core/conversation/models";
import type { ToolDefinition } from "../../src/tools/contracts";
import type { App } from "../../src/app";
import type { VoiceTurnController } from "../../src/voice/controller";
import type { VoiceClientEvent } from "../../src/voice/events";
import { VoiceState } from "../../src/voice/contracts";

/**
 * Output boundary for every CLI command. The real CLI writes to the process
 * streams; tests inject capturing sinks so command behavior stays
 * deterministic and free of process-global side effects.
 */
export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

const PROCESS_IO: CliIO = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
  positionals: string[];
}

/** Flags that never consume the following token (arthur ask --verbose "msg"). */
const BOOLEAN_FLAGS = new Set(["verbose", "json", "help"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const name = arg.slice(2);
        const next = argv[i + 1];
        if (BOOLEAN_FLAGS.has(name)) {
          flags.set(name, "true");
        } else if (next && !next.startsWith("--")) {
          flags.set(name, next);
          i++;
        } else {
          flags.set(name, "true");
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command: positionals[0] ?? "", flags, positionals };
}

const HELP = `ARTHUR CLI

Usage:
  arthur chat --mode personal|business [--session <id>] [--verbose]
  arthur ask --mode personal|business [--verbose] [--json] "<message>"
  arthur voice --mode personal|business [--session <id>] [--verbose]
  arthur tools [--mode personal|business] [--json]
  arthur tools inspect <tool-name> [--json]
  arthur status [--json]
  arthur session <id> [--json]
  arthur approve <approval-id>                            Approve one pending tool action
  arthur reject <approval-id>                             Reject one pending tool action
  arthur memory remember --session <id> [--type <t>] [--subject <k>] [--project <k>] "<text>"
  arthur memory search --session <id> "<query>"
  arthur memory list --session <id>
  arthur memory forget --session <id> <memory-id>
  arthur memory status --session <id>
  arthur documents add --session <id> --file <path> [--title <t>] [--project <k>]
  arthur documents list --session <id>

Interactive chat commands (inside "arthur chat"): type /help.
`;

const INTERACTIVE_HELP = `Interactive commands:
  /help              Show this command list
  /status            Show safe runtime status (mode, session, provider, model, memory)
  /session           Show the current session id and mode
  /tools             List tools available in the current mode
  /tool <name>       Show a tool's safe manifest (no executor/adapter internals)
  /new               Start a new conversation on the next message (old session kept)
  /exit              Leave the console (also: "exit")
`;

function startupSanitizer(): SecretSanitizer {
  const secrets = Object.entries(process.env)
    .filter(([key, value]) => isSecretLikeKey(key) && Boolean(value))
    .map(([, value]) => value as string);
  return new SecretSanitizer(secrets);
}

export function renderCliError(err: unknown, app?: App): string {
  const publicError = app ? app.sanitizePublicError(err) : sanitizePublicError(err, startupSanitizer());
  return `error [${publicError.body.error.code}]: ${publicError.body.error.message}\n`;
}

function printError(err: unknown, app?: App, io: CliIO = PROCESS_IO): void {
  io.err(renderCliError(err, app));
}

function printJson(value: unknown, io: CliIO = PROCESS_IO): void {
  io.out(`${JSON.stringify(value, null, 2)}\n`);
}

// ---- rendering helpers (DEV-CLI-1 sections 2, 7, 8) -----------------------

function byToolName(a: ToolDefinition, b: ToolDefinition): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Compact safe table: NAME / VERSION / RISK / MODES. */
export function renderToolCatalogTable(definitions: ToolDefinition[]): string {
  const headers = ["NAME", "VERSION", "RISK", "MODES"];
  const rows = definitions.map((d) => [d.name, d.version, d.risk, d.allowed_modes.join(",")]);
  const widths = headers.map((header, col) => {
    const widest = rows.reduce((max, row) => Math.max(max, (row[col] ?? "").length), 0);
    return Math.max(header.length, widest) + 2;
  });
  const renderRow = (cells: string[]) =>
    cells
      .map((cell, col) => (col === cells.length - 1 ? cell : cell.padEnd(widths[col] ?? 0)))
      .join("");
  return [renderRow(headers), ...rows.map(renderRow)].join("\n");
}

/**
 * Developer-verbose lifecycle block for one returned ToolCallSummary. Only
 * fields the runtime already sanitized are printed: name, status, risk,
 * result summary, and (for pending actions) the approval id - never executor
 * exceptions, stack traces, tokens/signatures, or provider payloads.
 */
export function renderVerboseToolCall(call: ToolCallSummary): string[] {
  const lines = [`[tool] ${call.name}`, `       status: ${call.status}`, `       risk: ${call.risk}`];
  if (call.status === "pending_approval" && call.approval_id !== undefined) {
    lines.push(`       approval: ${call.approval_id}`);
  }
  if (call.result_summary !== undefined) {
    lines.push(`       summary: ${call.result_summary}`);
  }
  return lines;
}

/** All tool calls of a turn in the compact (non-verbose) chat rendering. */
export function renderCompactToolCalls(calls: readonly ToolCallSummary[]): string {
  const lines: string[] = [];
  for (const call of calls) {
    if (call.status === "pending_approval") {
      lines.push(`        [pending approval] ${call.name} -> approve ${call.approval_id}`);
    } else if (call.status === "rejected") {
      lines.push(`        [rejected] ${call.name}: ${call.result_summary ?? ""}`);
    } else {
      const summary = call.result_summary !== undefined ? ": " + call.result_summary : "";
      lines.push(`        [tool] ${call.name} ${call.status} (${call.risk})${summary}`);
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * All tool calls of a turn in verbose rendering, including the exact
 * "how to continue" hint for pending approvals (DEV-CLI-1 section 12).
 */
export function renderVerboseToolCalls(calls: readonly ToolCallSummary[]): string {
  const lines: string[] = [];
  for (const call of calls) {
    lines.push(...renderVerboseToolCall(call));
    if (call.status === "pending_approval" && call.approval_id !== undefined) {
      lines.push("[pending approval]", call.name, "approve with:", `npm run cli -- approve ${call.approval_id}`);
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function modelLabel(model: string): string {
  return model !== "" ? model : "(default)";
}

function renderConsoleStatus(app: App, mode: ArthurMode, sessionId: string | undefined): string {
  const status = app.conversation.getStatus();
  return [
    `Mode: ${mode.toUpperCase()}`,
    `Session: ${sessionId ?? "new"}`,
    `Provider: ${status.provider}`,
    `Model: ${modelLabel(status.model)}`,
    `Memory: ${app.config.memoryExtractionEnabled ? "enabled" : "disabled"}`,
  ].join("\n") + "\n";
}

// ---- command runners ------------------------------------------------------

export interface ChatOptions {
  mode: ArthurMode;
  /** Existing session to continue; undefined starts a new one. */
  sessionId?: string;
  verbose?: boolean;
  io?: CliIO;
  /** Line source: the readline interface in production, arrays in tests. */
  lines: Iterable<string> | AsyncIterable<string>;
  /** Called to redisplay the prompt (TTY only; injected by main). */
  prompt?: () => void;
}

export async function runChat(app: App, opts: ChatOptions): Promise<number> {
  const io = opts.io ?? PROCESS_IO;
  const verbose = opts.verbose === true;
  let currentSessionId = opts.sessionId;
  const status = app.conversation.getStatus();
  const banner = [
    "ARTHUR Developer Console",
    `Mode: ${opts.mode.toUpperCase()}`,
    `Provider: ${status.provider}`,
    `Model: ${modelLabel(status.model)}`,
    `Session: ${currentSessionId ?? "new"}`,
    `Verbose: ${verbose ? "ON" : "OFF"}`,
    "",
    "Type /help for commands.",
  ].join("\n");
  io.out(`${banner}\n`);
  opts.prompt?.();

  for await (const line of opts.lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      opts.prompt?.();
      continue;
    }
    if (trimmed === "exit" || trimmed === "/exit") {
      break;
    }

    if (trimmed.startsWith("/")) {
      const name = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
      const arg = trimmed.slice(name.length).trim();
      switch (name) {
        case "/help": {
          io.out(`${INTERACTIVE_HELP}\n`);
          break;
        }
        case "/status": {
          io.out(renderConsoleStatus(app, opts.mode, currentSessionId));
          break;
        }
        case "/session": {
          io.out(`Session: ${currentSessionId ?? "new"}\nMode: ${opts.mode.toUpperCase()}\n`);
          break;
        }
        case "/tools": {
          try {
            const definitions = app.conversation.listTools(opts.mode);
            io.out(`${renderToolCatalogTable(definitions)}\n`);
          } catch (err) {
            printError(err, app, io);
          }
          break;
        }
        case "/tool": {
          if (arg === "") {
            io.err("usage: /tool <name>\n");
            break;
          }
          try {
            const definition = app.conversation.getToolDefinition(arg);
            if (definition === undefined) {
              throw new ArthurError("TOOL_NOT_FOUND", `Unknown tool: ${arg}`);
            }
            printJson(definition, io);
          } catch (err) {
            printError(err, app, io);
          }
          break;
        }
        case "/new": {
          io.out(
            currentSessionId !== undefined
              ? `Session cleared. The next message starts a new conversation (previous session ${currentSessionId} is kept).\n`
              : "No active session; the next message starts a new conversation.\n",
          );
          currentSessionId = undefined;
          break;
        }
        default: {
          io.err(`unknown command: ${name} (type /help for commands)\n`);
        }
      }
      opts.prompt?.();
      continue;
    }

    try {
      const response = await app.conversation.handleTurn({
        session_id: currentSessionId,
        mode: opts.mode,
        message: trimmed,
        client_request_id: newId(),
        metadata: { client_type: "cli" },
      });
      const firstTurnOfSession = currentSessionId === undefined;
      currentSessionId = response.session_id;
      if (verbose) {
        io.out(`[session] ${response.session_id}\n`);
        io.out(renderVerboseToolCalls(response.tool_calls));
        io.out(`arthur> ${response.display_text}\n`);
      } else {
        if (firstTurnOfSession) {
          // First turn of a brand-new session: surface the id so memory
          // commands can target it (e.g. arthur memory remember --session <id>).
          io.out(`[session id: ${response.session_id}]\n`);
        }
        io.out(`arthur> ${response.display_text}\n`);
        io.out(renderCompactToolCalls(response.tool_calls));
      }
    } catch (err) {
      printError(err, app, io);
    }
    opts.prompt?.();
  }
  return 0;
}

export interface AskOptions {
  mode: ArthurMode;
  message: string;
  verbose?: boolean;
  json?: boolean;
  io?: CliIO;
}

/** One-shot turn through the same ConversationService (DEV-CLI-1 section 9). */
export async function runAsk(app: App, opts: AskOptions): Promise<number> {
  const io = opts.io ?? PROCESS_IO;
  try {
    const response = await app.conversation.handleTurn({
      session_id: undefined,
      mode: opts.mode,
      message: opts.message,
      client_request_id: newId(),
      metadata: { client_type: "cli" },
    });
    if (opts.json === true) {
      printJson(response, io);
      return 0;
    }
    if (opts.verbose === true) {
      io.out(`[session] ${response.session_id}\n`);
      io.out(renderVerboseToolCalls(response.tool_calls));
    }
    io.out(`${response.display_text}\n`);
    return 0;
  } catch (err) {
    printError(err, app, io);
    return 1;
  }
}

// ---- voice console (DEV-VOICE-CLI-1) ----------------------------------------

export type VoiceStatus = ReturnType<VoiceTurnController["status"]>;

/**
 * Deterministic renderer for the voice console. It renders ONLY the existing
 * VoiceClientEvent vocabulary (one event protocol everywhere) and derives
 * nothing from internal tool/runtime state. Assistant text is buffered across
 * deltas and flushed once at speech start (or turn completion when TTS never
 * starts), so the console output stays natural. No raw audio, provider
 * payload, approval token, stack trace, or structured tool payload is ever
 * printed: the renderer only sees the controller's sanitized event surface.
 */
export class VoiceConsoleRenderer {
  private assistantBuffer = "";
  private assistantFlushed = true;

  constructor(
    private readonly io: CliIO,
    private readonly verbose: boolean,
  ) {}

  onEvent(event: VoiceClientEvent): void {
    switch (event.type) {
      case "voice.state":
        if (this.verbose) {
          this.io.out("[state] " + event.state + (event.reason ? " (" + event.reason + ")" : "") + "\n");
        }
        break;
      case "voice.session":
        if (this.verbose) {
          this.io.out("[voice session] state=" + event.session.state + " arthur=" + (event.session.arthur_session_id || "-") + "\n");
        }
        break;
      case "wake.detected":
        this.io.out("[wake] Arthur\n");
        break;
      case "stt.partial":
        if (this.verbose) {
          this.io.out("[stt.partial] " + event.text + "\n");
        }
        break;
      case "stt.final":
        if (this.verbose) {
          this.io.out("[stt.final] " + event.text + "\n");
        }
        this.io.out("you> " + event.text + "\n");
        break;
      case "assistant.text.delta":
        // Buffer for the natural "arthur> <answer>" line; verbose also tags
        // each delta for developer visibility.
        this.assistantBuffer += event.text;
        this.assistantFlushed = false;
        if (this.verbose) {
          this.io.out("[assistant] " + event.text + "\n");
        }
        break;
      case "assistant.speech.started":
        this.flushAssistant();
        this.io.out(this.verbose ? "[tts] started\n" : "[speaking]\n");
        break;
      case "assistant.speech.ended":
        this.io.out(this.verbose ? "[tts] ended\n" : "[speaking done]\n");
        break;
      case "assistant.turn.completed":
        this.flushAssistant();
        if (this.verbose) {
          this.io.out("[turn] " + event.status + "\n");
        }
        break;
      case "approval.required":
        // Render the id + tool name ONLY; never any token/signature material.
        this.io.out("[approval required]\nTool: " + event.tool_name + "\nApproval ID: " + event.approval_id + "\n");
        break;
      case "approval.ambiguous":
        this.io.out("[approval ambiguous] " + event.pending_count + " pending; name the approval id to resolve\n");
        break;
      case "approval.outcome":
        this.io.out("[approval " + event.status + "] " + event.approval_id + "\n");
        break;
      case "voice.error":
        // The controller sanitizes the message before emitting.
        this.io.err("[voice error] " + event.message + "\n");
        break;
    }
  }

  /** Print the buffered assistant answer exactly once. */
  flushAssistant(): void {
    if (this.assistantFlushed || this.assistantBuffer === "") return;
    this.io.out("arthur> " + this.assistantBuffer + "\n");
    this.assistantBuffer = "";
    this.assistantFlushed = true;
  }
}

/** Startup banner derived from the controller's OWN component status. */
export function renderVoiceStartup(
  status: VoiceStatus,
  opts: { mode: ArthurMode; sessionId: string; verbose: boolean },
): string {
  const wakeWord = status.wake_word.charAt(0).toUpperCase() + status.wake_word.slice(1);
  const lines = [
    "ARTHUR Voice Console",
    "Mode: " + opts.mode.toUpperCase(),
    "Session: " + opts.sessionId,
    "Wake word: " + wakeWord,
    "Wake: " + (status.wake.available ? "READY" : "UNAVAILABLE"),
    "Microphone: " + (status.audio_input.available ? "READY" : "UNAVAILABLE"),
    "TTS: " + (status.tts.available ? "READY" : "UNAVAILABLE"),
    "",
    "Say \"" + wakeWord + "\" to start.",
    "Press Enter for push-to-talk.",
    "Ctrl+C to exit.",
    "",
  ];
  return lines.join("\n") + "\n";
}

/** Normalize sync/async line sources into one async iterable. */
async function* toAsyncLines(lines: AsyncIterable<string> | Iterable<string>): AsyncIterable<string> {
  if (Symbol.asyncIterator in (lines as object)) {
    yield* lines as AsyncIterable<string>;
  } else {
    yield* lines as Iterable<string>;
  }
}

export interface VoiceOptions {
  mode: ArthurMode;
  /** Existing session id; when omitted a NEW legitimate session is created. */
  sessionId?: string;
  verbose?: boolean;
  io?: CliIO;
  /** Voice has no JSON mode; --json fails cleanly with INVALID_REQUEST. */
  json?: boolean;
  /**
   * Input line source. Production passes a readline interface over stdin;
   * tests pass deterministic async iterables. Only EMPTY lines (Enter) act
   * as push-to-talk toggles.
   */
  lines: AsyncIterable<string> | Iterable<string>;
  /** Optional hook re-drawing the prompt after each processed line (TTY). */
  prompt?: () => void;
  /**
   * Returns a promise resolved when shutdown is requested (SIGINT / Ctrl+C).
   * Tests resolve it deterministically; production resolves it from the
   * readline SIGINT event and process signal handling.
   */
  requestShutdown?: () => Promise<void>;
}

/**
 * Voice developer console over the EXISTING VoiceTurnController runtime
 * (DEV-VOICE-CLI-1). A thin surface: it bootstraps a legitimate session via
 * the narrow conversation API, subscribes to the existing voice event stream,
 * toggles PTT through voice.pttStart()/pttStop(), and shuts down gracefully.
 * It never touches the model provider, tool registry/execution, or the
 * session store, and has no approval bypass flags.
 */
export async function runVoice(app: App, opts: VoiceOptions): Promise<number> {
  const io = opts.io ?? PROCESS_IO;
  const verbose = opts.verbose === true;
  if (opts.json === true) {
    throw new ArthurError("INVALID_REQUEST", "arthur voice does not support --json");
  }

  // ---- session bootstrap (fail-closed; no raw store exposure) ----
  let sessionId: string;
  if (opts.sessionId !== undefined) {
    const session = await app.conversation.getSession(opts.sessionId);
    if (session.mode !== opts.mode) {
      throw new ArthurError(
        "INVALID_REQUEST",
        "Session " + opts.sessionId + " is in " + session.mode.toUpperCase() + " mode; requested " + opts.mode.toUpperCase() + ". Voice console does not switch modes.",
      );
    }
    sessionId = opts.sessionId;
  } else {
    sessionId = (await app.conversation.createSession(opts.mode)).session_id;
  }

  // Subscribe BEFORE enable so startup errors are rendered.
  const renderer = new VoiceConsoleRenderer(io, verbose);
  const unsubscribe = app.voice.subscribe((event) => renderer.onEvent(event));

  let pttActive = false;
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return; // repeated shutdown is safe/idempotent
    shuttingDown = true;
    renderer.flushAssistant();
    unsubscribe(); // stop rendering voice events
    await app.voice.disable(); // stops mic, wake detector, playback (idempotent)
  };

  try {
    app.voice.setSession(sessionId);
    await app.voice.enable();

    const status = app.voice.status();
    io.out(renderVoiceStartup(status, { mode: opts.mode, sessionId, verbose }));
    if (status.wake.available === false) {
      io.out("Wake word unavailable.\nPush-to-talk remains available.\n");
    }
    if (app.voice.state === VoiceState.DISABLED) {
      // enable() failed closed (e.g. no microphone): the sanitized error was
      // already rendered through voice.error; nothing pretends to run.
      io.err("Voice console could not start.\n");
      return 1;
    }

    // ---- input loop: Enter toggles PTT; shutdown exits ----
    const input = toAsyncLines(opts.lines)[Symbol.asyncIterator]();
    const shutdownPromise = (opts.requestShutdown ?? (() => new Promise<void>(() => undefined)))();
    for (;;) {
      const next = await Promise.race([
        input.next(),
        shutdownPromise.then(() => null),
      ]);
      if (next === null || next.done) break;
      const line = (typeof next.value === "string" ? next.value : "").trim();
      if (line !== "") {
        io.err("voice console: only Enter (push-to-talk toggle) is supported here\n");
        continue;
      }
      const startPtt: boolean = !pttActive;
      try {
        if (startPtt) {
          await app.voice.pttStart();
        } else {
          await app.voice.pttStop();
        }
        pttActive = startPtt;
        io.out("[ptt] " + (startPtt ? "START" : "STOP") + "\n");
      } catch (err) {
        // e.g. VOICE_BUSY; the controller also emitted a sanitized voice.error.
        printError(err, app, io);
      }
      opts.prompt?.();
    }
    return 0;
  } finally {
    await shutdown();
  }
}

export interface ToolsOptions {
  mode?: ArthurMode;
  json?: boolean;
  io?: CliIO;
}

/** Safe catalog listing; no registry, executor, or adapter is reachable here. */
export function runTools(app: App, opts: ToolsOptions): number {
  const io = opts.io ?? PROCESS_IO;
  try {
    const definitions = [...app.conversation.listTools(opts.mode)].sort(byToolName);
    if (opts.json === true) {
      printJson({ tools: definitions }, io);
    } else {
      io.out(`${renderToolCatalogTable(definitions)}\n`);
    }
    return 0;
  } catch (err) {
    printError(err, app, io);
    return 1;
  }
}

export interface ToolsInspectOptions {
  name: string;
  json?: boolean;
  io?: CliIO;
}

/** Safe manifest inspection only (DEV-CLI-1 section 4). */
export function runToolsInspect(app: App, opts: ToolsInspectOptions): number {
  const io = opts.io ?? PROCESS_IO;
  try {
    const definition = app.conversation.getToolDefinition(opts.name);
    if (definition === undefined) {
      throw new ArthurError("TOOL_NOT_FOUND", `Unknown tool: ${opts.name}`);
    }
    // The manifest IS the output in both modes: a single safe JSON document.
    printJson(definition, io);
    return 0;
  } catch (err) {
    printError(err, app, io);
    return 1;
  }
}

export interface StatusOptions {
  json?: boolean;
  io?: CliIO;
}

/** Unchanged output (single safe JSON document); --json is accepted for it. */
export function runStatus(app: App, opts: StatusOptions = {}): number {
  printJson(app.conversation.getStatus(), opts.io ?? PROCESS_IO);
  return 0;
}

export interface SessionOptions {
  id: string;
  json?: boolean;
  io?: CliIO;
}

export async function runSession(app: App, opts: SessionOptions): Promise<number> {
  const io = opts.io ?? PROCESS_IO;
  try {
    printJson(await app.conversation.getSession(opts.id), io);
    return 0;
  } catch (err) {
    printError(err, app, io);
    return 1;
  }
}

export interface ApprovalOptions {
  id: string;
  io?: CliIO;
}

export async function runApprove(app: App, opts: ApprovalOptions): Promise<number> {
  const io = opts.io ?? PROCESS_IO;
  try {
    printJson(await app.conversation.approve(opts.id), io);
    return 0;
  } catch (err) {
    printError(err, app, io);
    return 1;
  }
}

export async function runReject(app: App, opts: ApprovalOptions): Promise<number> {
  const io = opts.io ?? PROCESS_IO;
  try {
    printJson(await app.conversation.reject(opts.id), io);
    return 0;
  } catch (err) {
    printError(err, app, io);
    return 1;
  }
}

export async function runMemoryCommands(
  app: App,
  command: string,
  flags: Map<string, string>,
  positionals: string[],
  io: CliIO = PROCESS_IO,
): Promise<void> {
  const sessionId = flags.get("session");
  if (!sessionId) {
    io.err("usage: arthur memory <command> --session <id> ...\n");
    return;
  }
  switch (command) {
    case "remember": {
      // positionals = [command, subcommand, text...]
      const text = positionals[2];
      if (!text) {
        io.err('usage: arthur memory remember --session <id> [--type semantic] "<text>"\n');
        return;
      }
      const rawType = flags.get("type") ?? "semantic";
      const item = await app.memory.remember(sessionId, {
        text,
        type: parseTypeLabel(rawType),
        subject_key: flags.get("subject"),
        project_key: flags.get("project"),
        client_request_id: newId(),
      });
      printJson({ memory_id: item.id, status: item.status, type: item.type, text: item.display_text }, io);
      return;
    }
    case "search": {
      const query = positionals[2];
      if (!query) {
        io.err('usage: arthur memory search --session <id> "<query>"\n');
        return;
      }
      const memories = await app.memory.search(sessionId, { query_text: query, top_k: 8 });
      printJson({ memories }, io);
      return;
    }
    case "list": {
      const memories = await app.memory.list(sessionId, { domain: "personal", limit: 100 });
      printJson({ memories }, io);
      return;
    }
    case "forget": {
      const memoryId = positionals[2];
      if (!memoryId) {
        io.err("usage: arthur memory forget --session <id> <memory-id>\n");
        return;
      }
      await app.memory.forget(sessionId, memoryId);
      printJson({ status: "deleted", memory_id: memoryId }, io);
      return;
    }
    case "status": {
      const report: MemoryStatusReport = app.memory.status(sessionId);
      printJson(report, io);
      return;
    }
    default: {
      io.err(`unknown memory command: ${command}\n`);
      process.exitCode = 1;
    }
  }
}

export async function runDocumentCommands(
  app: App,
  command: string,
  flags: Map<string, string>,
  positionals: string[],
  io: CliIO = PROCESS_IO,
): Promise<void> {
  const sessionId = flags.get("session");
  if (!sessionId) {
    io.err("usage: arthur documents <command> --session <id> ...\n");
    return;
  }
  switch (command) {
    case "add": {
      const filePath = flags.get("file");
      if (!filePath) {
        io.err("usage: arthur documents add --session <id> --file <path> [--title <t>]\n");
        return;
      }
      const fs = require("node:fs") as typeof import("node:fs");
      const content = fs.readFileSync(filePath, "utf8");
      const title = flags.get("title") ?? filePath.split(/[\\/]/).pop() ?? filePath;
      const document = await app.memory.ingestDocument(
        sessionId,
        { title, source_type: "text", content, project_key: flags.get("project") },
        newId(),
      );
      printJson(document, io);
      return;
    }
    case "list": {
      const documents = await app.memory.listDocuments(sessionId);
      printJson({ documents }, io);
      return;
    }
    default: {
      io.err(`unknown documents command: ${command}\n`);
      process.exitCode = 1;
    }
  }
}

function resolveModeFlag(
  raw: string | undefined,
  fallback: ArthurMode | undefined,
  app: App,
  io: CliIO,
): ArthurMode | undefined {
  const value = raw ?? fallback;
  if (isArthurMode(value)) {
    return value;
  }
  printError(new ArthurError("INVALID_REQUEST", "Invalid mode; expected personal or business"), app, io);
  return undefined;
}

async function main(): Promise<void> {
  const { command, flags, positionals } = parseArgs(process.argv.slice(2));

  if (command === "" || command === "help" || command === "--help" || flags.get("help") === "true") {
    process.stdout.write(HELP);
    return;
  }

  let app: App;
  try {
    loadDotEnv();
    app = buildApp();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printError(new ArthurError("INVALID_CONFIG", message));
    process.exitCode = 1;
    return;
  }

  const io = PROCESS_IO;
  const json = flags.get("json") === "true";
  const verbose = flags.get("verbose") === "true";
  const rawMode = flags.get("mode");

  try {
    switch (command) {
      case "chat": {
        const mode = resolveModeFlag(rawMode, "personal", app, io);
        if (mode === undefined) {
          process.exitCode = 1;
          return;
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const interactive = Boolean(process.stdin.isTTY);
        if (interactive) {
          rl.setPrompt("you> ");
        }
        try {
          process.exitCode = await runChat(app, {
            mode,
            sessionId: flags.get("session"),
            verbose,
            io,
            lines: rl,
            prompt: interactive ? () => rl.prompt() : undefined,
          });
        } finally {
          rl.close();
        }
        break;
      }
      case "ask": {
        const mode = resolveModeFlag(rawMode, "personal", app, io);
        if (mode === undefined) {
          process.exitCode = 1;
          return;
        }
        const message = positionals.slice(1).join(" ").trim();
        if (message === "") {
          io.err('usage: arthur ask --mode personal|business [--verbose] [--json] "<message>"\n');
          process.exitCode = 1;
          return;
        }
        process.exitCode = await runAsk(app, { mode, message, verbose, json, io });
        break;
      }
      case "voice": {
        const mode = resolveModeFlag(rawMode, "personal", app, io);
        if (mode === undefined) {
          process.exitCode = 1;
          return;
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        let requestShutdown: () => void = () => undefined;
        const shutdownRequested = new Promise<void>((resolve) => {
          requestShutdown = resolve;
        });
        const interactive = Boolean(process.stdin.isTTY);
        if (interactive) {
          // readline emits SIGINT on Ctrl+C for TTY input.
          rl.on("SIGINT", () => requestShutdown());
        }
        const onProcessSigint = () => requestShutdown();
        process.on("SIGINT", onProcessSigint);
        try {
          process.exitCode = await runVoice(app, {
            mode,
            sessionId: flags.get("session"),
            verbose,
            json,
            io,
            lines: rl,
            requestShutdown: () => shutdownRequested,
          });
        } finally {
          process.removeListener("SIGINT", onProcessSigint);
          rl.close();
        }
        break;
      }
      case "tools": {
        const mode = rawMode === undefined ? undefined : resolveModeFlag(rawMode, undefined, app, io);
        if (rawMode !== undefined && mode === undefined) {
          process.exitCode = 1;
          return;
        }
        const sub = positionals[1];
        if (sub === "inspect") {
          const name = positionals[2];
          if (!name) {
            io.err("usage: arthur tools inspect <tool-name> [--json]\n");
            process.exitCode = 1;
            return;
          }
          process.exitCode = runToolsInspect(app, { name, json, io });
        } else if (sub === undefined) {
          process.exitCode = runTools(app, { mode, json, io });
        } else {
          io.err("usage: arthur tools [--mode personal|business] [--json]\n       arthur tools inspect <tool-name> [--json]\n");
          process.exitCode = 1;
          return;
        }
        break;
      }
      case "status": {
        process.exitCode = runStatus(app, { json, io });
        break;
      }
      case "session": {
        const id = positionals[1];
        if (!id) {
          io.err("usage: arthur session <id> [--json]\n");
          return;
        }
        process.exitCode = await runSession(app, { id, json, io });
        break;
      }
      case "approve": {
        const id = positionals[1];
        if (!id) {
          io.err("usage: arthur approve <approval-id>\n");
          return;
        }
        process.exitCode = await runApprove(app, { id, io });
        break;
      }
      case "reject": {
        const id = positionals[1];
        if (!id) {
          io.err("usage: arthur reject <approval-id>\n");
          return;
        }
        process.exitCode = await runReject(app, { id, io });
        break;
      }
      case "memory": {
        await runMemoryCommands(app, positionals[1] ?? "", flags, positionals, io);
        break;
      }
      case "documents": {
        await runDocumentCommands(app, positionals[1] ?? "", flags, positionals, io);
        break;
      }
      default: {
        io.err(`unknown command: ${command}\n\n${HELP}`);
        process.exitCode = 1;
      }
    }
  } catch (err) {
    printError(err, app, io);
    process.exitCode = 1;
  } finally {
    app.close();
  }
}

if (require.main === module) {
  void main();
}
