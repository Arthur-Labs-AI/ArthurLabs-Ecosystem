/**
 * Generic stdio runtime RPC transport (Electron main).
 *
 * Owns every behavior that is NOT inherently host-specific: child
 * stdin/stdout/stderr attachment, NDJSON framing, pending requests,
 * timeouts, oversized-frame recovery, notifications, bounded stderr
 * diagnostics, exit handling, handshake validation, and graceful shutdown.
 *
 * The ONLY host-specific input is the launcher seam that supplies the
 * child process. This file must never reference host executables,
 * distributions, or platform argv construction — those live in the
 * platform wrapper.
 */
import type { ChildProcess } from 'node:child_process';
import {
  RUNTIME_PROTOCOL_VERSION,
  RpcLineBuffer,
  encodeRpcLine,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
} from '@qa/runtime-protocol';
import type {
  RuntimeClient,
  RuntimeHello,
  RuntimeProcessLauncher,
  RuntimeStatus,
} from './runtime-client.js';

export const STDIO_REQUEST_TIMEOUT_MS = 60_000;
export const STDIO_START_TIMEOUT_MS = 120_000;
/**
 * Methods whose legitimate work scales with project size (full tree copy +
 * content scan: a 60k-file project takes minutes) get a long window; every
 * other method stays at 60 s. The runtime itself has no arbitrary deadline
 * (poll-until-settled), so these windows only bound truly hung transports.
 */
export const STDIO_ROW_CREATION_TIMEOUT_MS = 600_000;
export const STDIO_ROW_CREATION_METHODS: ReadonlySet<string> = new Set([
  'runs.start',
  'retests.start',
  'projects.add',
  'projects.update',
]);

export const STDIO_SHUTDOWN_GRACE_MS = 5000;
export const STDIO_STDERR_TAIL_MAX_LINES = 50;
export const STDIO_STDERR_LINE_MAX_CHARS = 500;
export const STDIO_SPAWN_ERROR_PREVIEW_CHARS = 300;

/** Resolve the effective timeout for a method (explicit override wins). */
export function resolveRequestTimeout(method: string, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  return STDIO_ROW_CREATION_METHODS.has(method)
    ? STDIO_ROW_CREATION_TIMEOUT_MS
    : STDIO_REQUEST_TIMEOUT_MS;
}

function nextId(prefix: string): string {
  return prefix + '_' + Date.now().toString(36) + Math.floor(Math.random() * 0xffffff).toString(36);
}

export interface StdioRuntimeClientOptions {
  /** Platform-supplied child creation (host launcher today, native node next). */
  readonly launch: RuntimeProcessLauncher;
  /** Prefix for spawn-failure diagnostics (host executable name lives here). */
  readonly spawnErrorPrefix?: string;
  /** Offline error message when no child is running. */
  readonly offlineMessage?: string;
  /** Guard message when the runtime unexpectedly runs under Electron. */
  readonly electronGuardMessage?: string;
}

const DEFAULT_SPAWN_ERROR_PREFIX = 'Runtime spawn failed: ';
const DEFAULT_OFFLINE_MESSAGE = 'Runtime unavailable';
const DEFAULT_ELECTRON_GUARD_MESSAGE = 'Runtime runs under Electron — host boundary violated';

export class StdioRuntimeClient implements RuntimeClient {
  private child: ChildProcess | undefined;
  private buffer = new RpcLineBuffer();
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private notificationHandler: ((event: string, payload: unknown) => void) | undefined;
  private exitHandler: ((code: number | null) => void) | undefined;
  private stderrTail: string[] = [];
  private hello: RuntimeHello | undefined;
  private lastError: string | undefined;
  /**
   * Connection generation, bumped for every spawned child. A late event
   * from a replaced child carries an older generation and must never
   * mutate the active connection's framing, status, or pending requests.
   */
  private generation = 0;
  private readonly launch: RuntimeProcessLauncher;
  private readonly spawnErrorPrefix: string;
  private readonly offlineMessage: string;
  private readonly electronGuardMessage: string;

  constructor(options: StdioRuntimeClientOptions) {
    this.launch = options.launch;
    this.spawnErrorPrefix = options.spawnErrorPrefix ?? DEFAULT_SPAWN_ERROR_PREFIX;
    this.offlineMessage = options.offlineMessage ?? DEFAULT_OFFLINE_MESSAGE;
    this.electronGuardMessage = options.electronGuardMessage ?? DEFAULT_ELECTRON_GUARD_MESSAGE;
  }

  onNotification(handler: (event: string, payload: unknown) => void): void {
    this.notificationHandler = handler;
  }

  onExit(handler: (code: number | null) => void): void {
    this.exitHandler = handler;
  }

  get status(): RuntimeStatus {
    return {
      connected: this.child !== undefined && this.hello !== undefined,
      hello: this.hello,
      lastError: this.lastError,
    };
  }

  get stderrDiagnostics(): readonly string[] {
    return this.stderrTail;
  }

  /** Spawn the runtime and complete the handshake. Rejects on timeout/mismatch. */
  async start(): Promise<RuntimeHello> {
    if (this.child !== undefined) {
      if (this.hello !== undefined) return this.hello;
      throw Object.assign(new Error('Runtime is starting'), { code: 'RUNTIME_STARTING' });
    }
    const child = this.launch();
    this.generation += 1;
    const generation = this.generation;
    // Framing state belongs to one runtime process: every spawned child
    // gets a fresh decoder before any stdout handler can feed it, so stale
    // bytes from a previous child can never merge with the new handshake.
    this.buffer = new RpcLineBuffer();
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (generation !== this.generation) return;
      this.onStdout(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (generation !== this.generation) return;
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        this.stderrTail.push(trimmed.slice(0, STDIO_STDERR_LINE_MAX_CHARS));
        if (this.stderrTail.length > STDIO_STDERR_TAIL_MAX_LINES) this.stderrTail.shift();
      }
    });
    child.on('error', (error: Error) => {
      if (generation !== this.generation) return;
      this.lastError =
        this.spawnErrorPrefix + error.message.slice(0, STDIO_SPAWN_ERROR_PREVIEW_CHARS);
      this.failAllPending(new Error(this.lastError));
      this.child = undefined;
      this.exitHandler?.(null);
    });
    child.on('exit', (code) => {
      if (generation !== this.generation) return;
      if (this.hello === undefined && this.lastError === undefined) {
        this.lastError = 'Runtime exited before handshake (code ' + String(code) + ')';
      }
      this.failAllPending(new Error(this.lastError ?? 'Runtime exited'));
      this.child = undefined;
      this.hello = undefined;
      this.exitHandler?.(code);
    });
    try {
      const hello = (await this.request(
        'runtime.hello',
        {},
        STDIO_START_TIMEOUT_MS,
      )) as RuntimeHello;
      if (hello.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
        throw Object.assign(
          new Error(
            'Runtime protocol mismatch: got ' +
              String(hello.protocolVersion) +
              ', want ' +
              String(RUNTIME_PROTOCOL_VERSION),
          ),
          { code: 'RUNTIME_PROTOCOL_MISMATCH' },
        );
      }
      if (hello.platform !== 'linux') {
        throw Object.assign(new Error('Runtime is not Linux: ' + hello.platform), {
          code: 'RUNTIME_NOT_LINUX',
        });
      }
      // The runtime's own isElectron signal is authoritative when present
      // (works on every OS regardless of executable naming). Legacy
      // runtimes omit it, so the execPath guard stays as a fallback — but a
      // positively detected Electron host is never allowed silently.
      const electronExecPath =
        typeof hello.processExecPath === 'string' &&
        hello.processExecPath.toLowerCase().endsWith('electron.exe');
      if (hello.isElectron === true || (hello.isElectron === undefined && electronExecPath)) {
        throw Object.assign(new Error(this.electronGuardMessage), {
          code: 'RUNTIME_UNDER_ELECTRON',
        });
      }
      this.hello = hello;
      this.lastError = undefined;
      return hello;
    } catch (error) {
      // Deterministic cleanup: when start() rejects, the failed child has
      // fully exited (or been killed) before the error propagates, so it
      // can never linger into — or corrupt — a replacement connection.
      await this.stop();
      throw error;
    }
  }

  /** Graceful shutdown; falls back to kill after a bounded wait. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.hello = undefined;
    this.failAllPending(new Error('Runtime stopped'));
    if (child === undefined) return;
    try {
      child.stdin?.write(
        JSON.stringify({
          type: 'request',
          id: nextId('rpc'),
          method: 'runtime.shutdown',
          params: {},
        }) + '\n',
      );
    } catch {
      // transport already broken
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        resolve();
      }, STDIO_SHUTDOWN_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<unknown> {
    const child = this.child;
    if (child === undefined || child.stdin === undefined) {
      return Promise.reject(
        Object.assign(new Error(this.offlineMessage), { code: 'RUNTIME_OFFLINE' }),
      );
    }
    const id = nextId('rpc');
    const message: RpcRequest = { type: 'request', id, method, params };
    const effectiveTimeout = resolveRequestTimeout(method, timeoutMs);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          Object.assign(new Error('Runtime request timed out: ' + method), {
            code: 'RUNTIME_TIMEOUT',
          }),
        );
      }, effectiveTimeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin?.write(encodeRpcLine(message as never));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onStdout(chunk: Buffer | string): void {
    let messages: ReturnType<RpcLineBuffer['push']>;
    try {
      messages = this.buffer.push(chunk);
    } catch {
      return;
    }
    // An oversize response frame must fail its request deterministically
    // instead of hanging until RUNTIME_TIMEOUT: the id is recovered from a
    // bounded prefix so exactly the affected request fails. An unroutable
    // oversize frame fails the transport (all remaining pending requests)
    // deterministically.
    for (const id of this.buffer.drainOversizeIds()) {
      const entry = this.pending.get(id);
      if (entry === undefined) continue;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(
        Object.assign(
          new Error(
            'Runtime response exceeded the bounded transport size; refine the request (large run exports are capped)',
          ),
          { code: 'RUNTIME_MESSAGE_TOO_LARGE' },
        ),
      );
    }
    if (this.buffer.drainTransportOverflow()) {
      this.failAllPending(
        Object.assign(
          new Error('Runtime transport overflow: oversized frame without recoverable id'),
          {
            code: 'RUNTIME_MESSAGE_TOO_LARGE',
          },
        ),
      );
    }
    for (const message of messages) {
      if (message.type === 'response') {
        const entry = this.pending.get((message as RpcResponse).id);
        if (entry === undefined) continue;
        this.pending.delete((message as RpcResponse).id);
        clearTimeout(entry.timer);
        const response = message as RpcResponse;
        if (response.ok) entry.resolve(response.result);
        else {
          entry.reject(
            Object.assign(new Error(response.error?.message ?? 'Runtime error'), {
              code: response.error?.code ?? 'RUNTIME_ERROR',
            }),
          );
        }
      } else if (message.type === 'notification') {
        const note = message as RpcNotification;
        this.notificationHandler?.(note.event, note.payload);
      }
    }
  }

  /**
   * Settle every outstanding request. Only ever called for the active
   * connection (detach in stop(), or a generation-guarded child event),
   * so a stale child can never reject requests belonging to its replacement.
   */
  private failAllPending(error: Error): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
}
