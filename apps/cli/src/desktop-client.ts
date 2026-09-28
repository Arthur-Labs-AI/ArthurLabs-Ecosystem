// SentryDesktopClient: the production CLI transport. One short-lived named
// pipe connection per CLI invocation, speaking the versioned hello/NDJSON
// protocol to the Electron broker. The CLI never opens SQLite, never owns
// leases, never instantiates harnesses, and never carries provider secrets.
import { createConnection, type Socket } from 'node:net';
import {
  CLI_IPC_LIMITS,
  CLI_IPC_PROTOCOL_VERSION,
  cliPipePath,
  utf8ByteLength,
  type CliIpcLimits,
} from '@qa/shared';

export class DesktopNotRunningError extends Error {
  readonly code = 'SENTRY_DESKTOP_NOT_RUNNING' as const;
  constructor() {
    super('Sentry Desktop is not running. Start it with: sentry open');
    this.name = 'DesktopNotRunningError';
  }
}

export class DesktopProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DesktopProtocolError';
    this.code = code;
  }
}

export interface DesktopClientOptions {
  readonly pipePath?: string;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly timeoutMs?: number;
  readonly limits?: Partial<CliIpcLimits>;
}

const DEFAULT_TIMEOUT_MS = 600_000;
let requestCounter = 0;
export class SentryDesktopClient {
  private socket: Socket | undefined;
  private buffer = '';
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private welcome:
    { protocolVersion: number; product?: { name?: string; version?: string } } | undefined;
  private fatal: Error | undefined;
  private readonly pipePath: string;
  private readonly clientName: string;
  private readonly clientVersion: string | undefined;
  private readonly timeoutMs: number;
  private readonly limits: CliIpcLimits;

  constructor(options: DesktopClientOptions = {}) {
    // SENTRY_CLI_PIPE_PATH is a test hook so the frontend suite can point at
    // a fake broker without touching the user-scoped production pipe.
    this.pipePath = options.pipePath ?? process.env['SENTRY_CLI_PIPE_PATH'] ?? cliPipePath();
    const declared = (
      options.clientName ??
      process.env['SENTRY_CLI_CLIENT_NAME'] ??
      'Sentry CLI'
    ).trim();
    this.clientName = declared.length > 0 ? declared.slice(0, 100) : 'Sentry CLI';
    const version = options.clientVersion ?? process.env['SENTRY_CLI_CLIENT_VERSION'];
    this.clientVersion =
      version === undefined || version.trim().length === 0
        ? undefined
        : version.trim().slice(0, 50);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.limits = { ...CLI_IPC_LIMITS, ...options.limits };
  }

  get productVersion(): string | undefined {
    return this.welcome?.product?.version;
  }

  async connect(): Promise<void> {
    if (this.socket !== undefined) return;
    const socket = createConnection(this.pipePath);
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')));
    socket.on('error', () => {
      /* connect failure surfaces via once-error below; mid-session errors fail pending */
    });
    socket.on('close', () => {
      this.socket = undefined;
      this.failAllPending(
        this.fatal ??
          new DesktopProtocolError(
            'DESKTOP_DISCONNECTED',
            'Sentry Desktop disconnected mid-request',
          ),
      );
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', (error: Error) => reject(toNotRunning(error)));
    });
    this.send({
      type: 'hello',
      protocolVersion: CLI_IPC_PROTOCOL_VERSION,
      client: {
        type: 'cli',
        name: this.clientName,
        ...(this.clientVersion === undefined ? {} : { version: this.clientVersion }),
      },
    });
    const welcome = await this.readFrame('hello');
    if (welcome['type'] === 'error') {
      throw new DesktopProtocolError(
        String(welcome['code'] ?? 'DESKTOP_ERROR'),
        String(welcome['message'] ?? 'Desktop handshake failed'),
      );
    }
    if (welcome['type'] !== 'welcome' || welcome['protocolVersion'] !== CLI_IPC_PROTOCOL_VERSION) {
      throw new DesktopProtocolError('PROTOCOL_VERSION_MISMATCH', 'Desktop CLI protocol mismatch');
    }
    this.welcome = {
      protocolVersion: welcome['protocolVersion'] as number,
      ...((welcome['product'] !== undefined && typeof welcome['product'] === 'object'
        ? { product: welcome['product'] as { name?: string; version?: string } }
        : {}) as { product?: { name?: string; version?: string } }),
    };
  }
  request<T = unknown>(
    command: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    const socket = this.socket;
    if (socket === undefined) return Promise.reject(new DesktopNotRunningError());
    const id = 'q_' + Date.now().toString(36) + '_' + (requestCounter += 1);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new DesktopProtocolError(
            'DESKTOP_TIMEOUT',
            'Sentry Desktop request timed out: ' + command.slice(0, 120),
          ),
        );
      }, timeoutMs ?? this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        socket.write(JSON.stringify({ type: 'request', id, command, payload }) + '\n');
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.failAllPending(new DesktopProtocolError('DESKTOP_DISCONNECTED', 'CLI connection closed'));
    if (socket !== undefined) {
      await new Promise<void>((resolve) => {
        try {
          socket.end(() => resolve());
        } catch {
          resolve();
        }
        setTimeout(() => {
          try {
            socket.destroy();
          } catch {
            /* gone */
          }
          resolve();
        }, 1000).unref?.();
      });
    }
  }

  private send(frame: unknown): void {
    this.socket?.write(JSON.stringify(frame) + '\n');
  }

  private readonly lineQueue: string[] = [];
  private readonly lineWaiters: Array<(line: string) => void> = [];

  private onData(text: string): void {
    this.buffer += text;
    // Defensive bound against a runaway broker: the Desktop is trusted local
    // software, but the CLI must never grow memory without bound.
    if (utf8ByteLength(this.buffer) > this.limits.maxLineBytes + this.limits.maxResponseBytes) {
      this.fatal = new DesktopProtocolError(
        'MESSAGE_TOO_LARGE',
        'Sentry Desktop sent a message exceeding the bounded frame size',
      );
      try {
        this.socket?.destroy();
      } catch {
        /* closing */
      }
      return;
    }
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length > 0) this.routeLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private routeLine(line: string): void {
    try {
      const frame = JSON.parse(line) as {
        type?: unknown;
        id?: unknown;
        ok?: unknown;
        result?: unknown;
        error?: { code?: unknown; message?: unknown };
      };
      if (frame.type === 'response' && typeof frame.id === 'string') {
        const entry = this.pending.get(frame.id);
        if (entry !== undefined) {
          this.pending.delete(frame.id);
          clearTimeout(entry.timer);
          if (frame.ok === true) entry.resolve(frame.result);
          else {
            const code = typeof frame.error?.code === 'string' ? frame.error.code : 'DESKTOP_ERROR';
            const message =
              typeof frame.error?.message === 'string'
                ? frame.error.message
                : 'Desktop operation failed';
            entry.reject(new DesktopProtocolError(code, message));
          }
          return;
        }
      }
    } catch {
      // Non-JSON lines fall through to the waiter queue and surface as
      // MALFORMED_MESSAGE at the read site.
    }
    const waiter = this.lineWaiters.shift();
    if (waiter !== undefined) waiter(line);
    else this.lineQueue.push(line);
  }

  private readFrame(_purpose: string): Promise<Record<string, unknown>> {
    const queued = this.lineQueue.shift();
    if (queued !== undefined) return Promise.resolve(JSON.parse(queued) as Record<string, unknown>);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new DesktopProtocolError('DESKTOP_TIMEOUT', 'Timed out waiting for Sentry Desktop'),
          ),
        30000,
      );
      this.lineWaiters.push((line: string) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(line) as Record<string, unknown>);
        } catch {
          reject(new DesktopProtocolError('MALFORMED_MESSAGE', 'Desktop sent invalid JSON'));
        }
      });
    });
  }

  private failAllPending(error: Error): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
}

function toNotRunning(error: Error): Error {
  const code = (error as NodeJS.ErrnoException).code ?? '';
  if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EPIPE' || code === 'EACCES') {
    return new DesktopNotRunningError();
  }
  return new DesktopProtocolError(
    'DESKTOP_CONNECTION_FAILED',
    'Could not reach Sentry Desktop: ' + error.message.slice(0, 200),
  );
}
