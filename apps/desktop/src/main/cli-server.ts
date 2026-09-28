// Local Sentry CLI broker: a Windows named-pipe (POSIX socket) server owned
// by the running Electron main process. External CLI clients handshake and
// issue operational commands; every request dispatches through the shared
// desktop command router with external:true, so CLI and Renderer share one
// behavior and one backend. Runs are owned by the WSL runtime: a dropped
// client connection never cancels anything.
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import {
  CLI_IPC_MAX_LINE_BYTES,
  CLI_IPC_MAX_REQUEST_BYTES,
  CLI_IPC_MAX_RESPONSE_BYTES,
  CLI_IPC_PROTOCOL_VERSION,
  cliPipePath,
  parseHelloMessage,
  parseRequestMessage,
  sanitizeBrokerField,
  type CliClientIdentity,
} from '@qa/shared';

export interface CliServerClient {
  readonly id: string;
  readonly name: string;
  readonly version?: string | undefined;
  readonly connectedAt: string;
}

export interface CliServerStatus {
  readonly started: boolean;
  readonly pipePath: string;
  readonly error?: string | undefined;
  readonly connectedClients: readonly CliServerClient[];
}

export interface CliServerOptions {
  readonly pipePath?: string;
  readonly productVersion?: string;
  readonly dispatch: (command: string, payload: Record<string, unknown>) => Promise<unknown>;
  readonly logger?: (message: string) => void;
  readonly onStatusChange?: (status: CliServerStatus) => void;
}

interface TrackedClient extends CliServerClient {
  socket: Socket;
}
export class SentryCliServer {
  private server: Server | undefined;
  private readonly clients = new Map<string, TrackedClient>();
  private readonly pipePath: string;
  private readonly productVersion: string;
  private readonly dispatchFn: (
    command: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
  private readonly log: (message: string) => void;
  private readonly notify: ((status: CliServerStatus) => void) | undefined;
  private lastError: string | undefined;
  private listening = false;

  constructor(options: CliServerOptions) {
    this.pipePath = options.pipePath ?? cliPipePath();
    this.productVersion = options.productVersion ?? '0.1.0-beta.1';
    this.dispatchFn = options.dispatch;
    this.log = options.logger ?? (() => undefined);
    this.notify = options.onStatusChange;
  }

  get status(): CliServerStatus {
    return {
      started: this.listening,
      pipePath: this.pipePath,
      ...(this.lastError === undefined ? {} : { error: this.lastError }),
      connectedClients: [...this.clients.values()].map((c) => ({
        id: c.id,
        name: c.name,
        ...(c.version === undefined ? {} : { version: c.version }),
        connectedAt: c.connectedAt,
      })),
    };
  }

  async start(): Promise<CliServerStatus> {
    if (this.server !== undefined) return this.status;
    const server = createServer((socket) => this.handleConnection(socket));
    this.server = server;
    server.on('error', (error: Error) => {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      this.lastError =
        code === 'EADDRINUSE'
          ? 'CLI pipe already owned by another Sentry instance'
          : 'CLI broker error: ' + sanitizeBrokerField(error.message);
      this.listening = false;
      this.emit();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.pipePath, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.server = undefined;
      const code = (error as NodeJS.ErrnoException).code ?? '';
      this.lastError =
        code === 'EADDRINUSE'
          ? 'CLI pipe already owned by another Sentry instance'
          : 'CLI broker failed to listen: ' +
            sanitizeBrokerField(error instanceof Error ? error.message : String(error));
      this.emit();
      return this.status;
    }
    this.lastError = undefined;
    this.listening = true;
    this.log('[sentry-cli] listening on ' + this.pipePath);
    this.emit();
    return this.status;
  }

  async stop(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        client.socket.destroy();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    this.listening = false;
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (process.platform !== 'win32') {
      await rm(this.pipePath, { force: true }).catch(() => undefined);
    }
    this.emit();
  }
  private emit(): void {
    try {
      this.notify?.(this.status);
    } catch {
      /* status fan-out never breaks dispatch */
    }
  }

  private handleConnection(socket: Socket): void {
    const id = 'cli_' + randomUUID().slice(0, 8);
    let buffer = '';
    let identity: CliClientIdentity | undefined;
    let closed = false;
    const send = (frame: unknown): boolean => {
      if (closed) return false;
      const line = JSON.stringify(frame) + '\n';
      if (line.length > CLI_IPC_MAX_RESPONSE_BYTES) return false;
      try {
        socket.write(line);
        return true;
      } catch {
        return false;
      }
    };
    const fail = (code: string, message: string): void => {
      send({ type: 'error', code, message: message.slice(0, 500) });
      try {
        socket.end();
      } catch {
        /* closing */
      }
    };
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > CLI_IPC_MAX_LINE_BYTES + CLI_IPC_MAX_REQUEST_BYTES) {
        this.log('[sentry-cli] oversized frame from ' + sanitizeBrokerField(identity?.name ?? id));
        fail('MESSAGE_TOO_LARGE', 'CLI message exceeds the bounded frame size');
        return;
      }
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        this.handleLine({
          line,
          send,
          fail,
          getIdentity: () => identity,
          onHello: (next) => {
            identity = next;
            this.clients.set(id, {
              id,
              name: next.name,
              ...(next.version === undefined ? {} : { version: next.version }),
              connectedAt: new Date().toISOString(),
              socket,
            });
            this.emit();
          },
        });
        if (closed) return;
        index = buffer.indexOf('\n');
      }
    });
    const forget = (): void => {
      closed = true;
      if (identity !== undefined) {
        this.clients.delete(id);
        this.log('[sentry-cli] disconnected ' + sanitizeBrokerField(identity.name));
        this.emit();
      }
    };
    socket.on('close', forget);
    socket.on('error', () => {
      /* disconnect path handles cleanup */
    });
  }
  private handleLine(ctx: {
    line: string;
    send: (frame: unknown) => boolean;
    fail: (code: string, message: string) => void;
    getIdentity: () => CliClientIdentity | undefined;
    onHello: (identity: CliClientIdentity) => void;
  }): void {
    const { line, send, fail, getIdentity, onHello } = ctx;
    if (line.length > CLI_IPC_MAX_LINE_BYTES) {
      fail('MESSAGE_TOO_LARGE', 'CLI message exceeds the bounded frame size');
      return;
    }
    if (line.trim().length === 0) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      fail('MALFORMED_JSON', 'CLI message is not valid JSON');
      return;
    }
    if (getIdentity() === undefined) {
      const hello = parseHelloMessage(raw);
      if (!hello.ok) {
        fail(hello.code, hello.message);
        return;
      }
      onHello(hello.message.client);
      send({
        type: 'welcome',
        protocolVersion: CLI_IPC_PROTOCOL_VERSION,
        product: { name: 'Sentry', version: this.productVersion },
      });
      this.log('[sentry-cli] connected ' + sanitizeBrokerField(hello.message.client.name));
      return;
    }
    const request = parseRequestMessage(raw);
    if (!request.ok) {
      send({
        type: 'response',
        id: undefined,
        ok: false,
        error: { code: request.code, message: request.message },
      });
      return;
    }
    if (JSON.stringify(request.message.payload).length > CLI_IPC_MAX_REQUEST_BYTES) {
      send({
        type: 'response',
        id: request.message.id,
        ok: false,
        error: { code: 'MESSAGE_TOO_LARGE', message: 'Request payload exceeds the bounded size' },
      });
      return;
    }
    void this.dispatchRequest(request.message, send);
  }

  private async dispatchRequest(
    message: { id: string; command: string; payload: Record<string, unknown> },
    send: (frame: unknown) => boolean,
  ): Promise<void> {
    let result: unknown;
    try {
      result = await this.dispatchFn(message.command, message.payload);
    } catch (error) {
      const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : 'DESKTOP_ERROR';
      const text = error instanceof Error ? error.message : String(error);
      send({
        type: 'response',
        id: message.id,
        ok: false,
        error: { code, message: text.slice(0, 2000) },
      });
      return;
    }
    let frame: unknown = { type: 'response', id: message.id, ok: true, result };
    try {
      if (JSON.stringify(frame).length > CLI_IPC_MAX_RESPONSE_BYTES) {
        frame = {
          type: 'response',
          id: message.id,
          ok: false,
          error: {
            code: 'RESPONSE_TOO_LARGE',
            message: 'Response exceeds the bounded size; refine the request',
          },
        };
      }
    } catch {
      frame = {
        type: 'response',
        id: message.id,
        ok: false,
        error: { code: 'DESKTOP_ERROR', message: 'Response is not serializable' },
      };
    }
    send(frame);
  }
}
