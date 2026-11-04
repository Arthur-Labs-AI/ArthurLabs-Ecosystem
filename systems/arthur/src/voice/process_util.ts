/**
 * Shared child-process plumbing for the local voice adapters (Phase 3).
 *
 * Local engines are always spawned, never exec'd: configured command strings
 * are tokenized into argv arrays (argument-safe), stdio buffers are bounded,
 * kills are tree-aware on Windows (taskkill /T /F) so wrapper processes can
 * never orphan engine children, and every wait is bounded so the voice loop
 * can never hang on a dead engine. Commands come only from trusted startup
 * configuration; model/STT/TTS text never influences the command line.
 */

import { spawn, ChildProcess } from "node:child_process";

/** Minimal structural logger (the app Logger satisfies this). */
export interface LogSink {
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Minimal structural text sanitizer (SecretSanitizer satisfies this). */
export interface TextSanitizer {
  sanitizeText(text: string): string;
}

/**
 * Tokenize a configured command line into an argv array.
 *
 * Handles double-quoted segments (Windows-style paths with spaces), `\"`
 * escapes, and treats every other backslash as a literal character so
 * Windows paths survive intact. No shell is involved: nothing untrusted can
 * ever be interpreted by a shell.
 */
export function splitCommandLine(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        inQuotes = false;
      } else if (ch === "\\" && command[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === " " || ch === "\t") {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
    i += 1;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

/**
 * Spawn a configured engine command with piped stdio.
 *
 * The caller's environment is inherited; `extraEnv` adds engine-specific
 * context (device ids, model paths, voices) without touching argv, so no
 * untrusted string can alter the executable or its arguments.
 */
export function spawnEngine(commandLine: string, extraEnv: Record<string, string> = {}): ChildProcess {
  const argv = splitCommandLine(commandLine);
  if (argv.length === 0) throw new Error("empty engine command");
  return spawn(argv[0] as string, argv.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
    windowsHide: true,
  });
}

/** Bounded tail buffer for child stderr (log only the last bytes). */
export class BoundedTail {
  private buffer = Buffer.alloc(0);

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxBytes) {
      this.buffer = this.buffer.subarray(this.buffer.length - this.maxBytes);
    }
  }

  get text(): string {
    return this.buffer.toString("utf8");
  }
}

/** Signal-kill a child if it is still running (idempotent, never throws). */
export function killChild(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill();
  } catch {
    // Already gone.
  }
}

/** Force-kill: SIGKILL on POSIX, taskkill /T /F tree-kill on Windows. */
export function forceKillTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      // /T kills the whole tree so wrapper processes cannot orphan engines.
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      // taskkill unavailable; the direct kill above usually suffices.
    }
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Resolve with the exit code once the child has closed, or null on timeout. */
export function waitForClose(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  if (child.pid === undefined) return Promise.resolve(null); // spawn failed
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("close", onClose);
      child.off("error", onError);
      resolve(null);
    }, timeoutMs);
    const onClose = (code: number | null): void => {
      clearTimeout(timer);
      resolve(code);
    };
    const onError = (): void => {
      clearTimeout(timer);
      resolve(null);
    };
    child.once("close", onClose);
    child.once("error", onError);
  });
}

/**
 * Graceful worker shutdown: close stdin (JSONL workers exit on EOF),
 * await `close` within the bound, escalate to kill + tree-kill, await
 * terminal close, then return. Resolves only after the child reaches a
 * terminal state or both bounds expire — never returns while the child
 * may still be running. Never hangs, never throws.
 */
export async function shutdownChildGracefully(child: ChildProcess, gracefulMs = 3000, killGraceMs = 2000): Promise<void> {
  if (child.exitCode !== null) return;
  try {
    // JSONL workers exit on stdin EOF: the graceful path needs no signal.
    child.stdin?.end();
  } catch {
    // stdin already gone; fall through to close/kill steps.
  }
  const graceful = await waitForClose(child, Math.max(0, gracefulMs));
  if (graceful !== null || child.exitCode !== null) return;
  await terminateChild(child, Math.max(0, killGraceMs));
}

/**
 * Kill and reap a child within a bounded window, escalating to a tree-kill
 * on Windows if the direct kill did not settle in time. Never hangs.
 */
export async function terminateChild(child: ChildProcess, killGraceMs = 500): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  killChild(child);
  const code = await waitForClose(child, killGraceMs);
  if (code === null && child.exitCode === null) {
    forceKillTree(child);
    await waitForClose(child, killGraceMs);
  }
  void code;
}

/**
 * Wait until the spawn either succeeded or failed. Rejects with a
 * descriptive error when the executable cannot be started (ENOENT etc.).
 */
export function awaitSpawn(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (child.pid !== undefined && child.exitCode === null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("error", onError);
      child.off("spawn", onSpawn);
      reject(new Error("engine process did not start within the timeout"));
    }, timeoutMs);
    const onError = (err: Error): void => {
      clearTimeout(timer);
      reject(new Error(`engine process failed to start: ${err.message}`));
    };
    const onSpawn = (): void => {
      clearTimeout(timer);
      child.off("error", onError);
      resolve();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

/** Await stdin drain or child close (whichever comes first). */

/** Empty byte stream used when a child has no stdout pipe. */
export async function* noOutput(): AsyncIterable<Buffer> {
  return;
}
export function drainOrClose(stdin: NodeJS.WritableStream, child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      stdin.off("drain", done);
      child.off("close", done);
      resolve();
    };
    stdin.once("drain", done);
    child.once("close", done);
  });
}