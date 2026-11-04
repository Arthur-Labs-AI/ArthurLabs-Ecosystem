/**
 * Minimal dependency-free WebDuplex server (RFC 6455) for the local
 * realtime voice channel (Phase 3 spec section 23).
 *
 * Implements: handshake, masked client text frames, server text frames,
 * ping/pong, close handshake, and defensive cleanup on any socket error -
 * a broken client never crashes the voice loop (spec section 43).
 */

import { createHash, randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import type { IncomingMessage, Server as HttpServer } from "node:http";

import type { VoiceClientEvent } from "../events";
import { VoiceClientCommand } from "../events";
import { VoiceTurnController } from "../controller";
import type { Logger } from "../../observability/logging";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptKey(key: string): string {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeCloseFrame(code = 1000, reason = ""): Buffer {
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
  payload.writeUInt16BE(code, 0);
  payload.write(reason, 2);
  return Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
}

export class RealtimeVoiceServer {
  private readonly clients = new Set<Duplex>();
  private readonly controller: VoiceTurnController;
  private readonly logger: Logger;
  private attached = false;

  constructor(controller: VoiceTurnController, logger: Logger) {
    this.controller = controller;
    this.logger = logger.child("voice-ws");
  }

  /** Attach to an http.Server and handle upgrades at /v1/voice/realtime. */
  attach(server: HttpServer): void {
    if (this.attached) return;
    this.attached = true;
    server.on("upgrade", (req, socket, head) => {
      try {
        this.handleUpgrade(req, socket, head);
      } catch {
        socket.destroy();
      }
    });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0] ?? "/";
    if (pathname !== "/v1/voice/realtime") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    const version = req.headers["sec-websocket-version"];
    if (typeof key !== "string" || version !== "13") {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        "",
        "",
      ].join("\r\n"),
    );
    this.clients.add(socket);
    const unsubscribe = this.controller.subscribe((event) => this.broadcast(event));
    let buffer = Buffer.alloc(0);
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      unsubscribe();
      this.clients.delete(socket);
    };
    socket.on("error", () => cleanup());
    socket.on("close", () => cleanup());
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = this.tryParseFrame(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.bytesConsumed);
        if (parsed.opcode === 8) {
          // Close handshake.
          try { socket.write(encodeCloseFrame()); } catch { /* noop */ }
          cleanup();
          socket.destroy();
          return;
        }
        if (parsed.opcode === 9) {
          // Ping -> pong (unmasked, echo payload).
          const pong = Buffer.concat([Buffer.from([0x8a, parsed.payload.length]), parsed.payload]);
          try { socket.write(pong); } catch { /* noop */ }
          continue;
        }
        if (parsed.opcode === 1 && parsed.payload.length > 0) {
          void this.dispatchCommand(parsed.payload.toString("utf8"), socket);
        }
        // Fragments/continuation and binary frames are ignored defensively.
      }
    });
    if (head.length > 0) {
      socket.emit("data", head);
    }
    // Send the current state immediately so clients sync on connect.
    try {
      socket.write(
        encodeTextFrame(
          JSON.stringify({
            type: "voice.session",
            session: this.controller.voiceSession(),
            ts: new Date().toISOString(),
          }),
        ),
      );
    } catch { /* noop */ }
  }

  private tryParseFrame(buffer: Buffer): { opcode: number; payload: Buffer; bytesConsumed: number } | undefined {
    if (buffer.length < 2) return undefined;
    const first = buffer[0] ?? 0;
    const second = buffer[1] ?? 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return undefined;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return undefined;
      const big = buffer.readBigUInt64BE(2);
      if (big > BigInt(1 << 30)) return undefined; // defensive cap
      length = Number(big);
      offset = 10;
    }
    const maskOffset = masked ? 4 : 0;
    if (buffer.length < offset + maskOffset + length) return undefined;
    let payload = buffer.subarray(offset + maskOffset, offset + maskOffset + length);
    if (masked) {
      const mask = buffer.subarray(offset, offset + 4);
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        unmasked[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
      }
      payload = unmasked;
    }
    return { opcode, payload, bytesConsumed: offset + maskOffset + length };
  }

  private async dispatchCommand(raw: string, socket: Duplex): Promise<void> {
    let command: VoiceClientCommand;
    try {
      const parsed: unknown = JSON.parse(raw);
      command = parsed as VoiceClientCommand;
      if (!command || typeof command !== "object" || typeof (command as { type?: unknown }).type !== "string") {
        throw new Error("invalid command");
      }
      await this.controller.handleClientCommand(command);
    } catch (err) {
      const message = err instanceof Error ? err.message : "command failed";
      this.logger.warn("realtime command failed", { message });
      try {
        socket.write(
          encodeTextFrame(JSON.stringify({ type: "voice.error", code: "VOICE_STATE_INVALID", message, ts: new Date().toISOString() })),
        );
      } catch { /* noop */ }
    }
  }

  private broadcast(event: VoiceClientEvent): void {
    const frame = encodeTextFrame(JSON.stringify(event));
    for (const socket of this.clients) {
      try {
        socket.write(frame);
      } catch {
        this.clients.delete(socket);
        socket.destroy();
      }
    }
  }

  close(): void {
    for (const socket of this.clients) {
      try { socket.destroy(); } catch { /* noop */ }
    }
    this.clients.clear();
  }
}