import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import net from "node:net";

import { startServer } from "../../apps/api/server";
import { buildTestApp, validTurn } from "../helpers";
import { FakeAudioCapture } from "../../src/voice/audio/capture";
import { FakeAudioPlayback } from "../../src/voice/audio/playback";
import { FakeWakeWordProvider } from "../../src/voice/wake/fake";
import { FakeVadProvider } from "../../src/voice/vad/fake";
import { FakeSttProvider } from "../../src/voice/stt/fake";
import { FakeTtsProvider } from "../../src/voice/tts/fake";
import { FakeProvider } from "../../src/models/providers/fake";
import type { ModelRequest } from "../../src/models/contracts";
import type { ModelStreamEvent } from "../../src/models/contracts";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Shared byte buffer across handshake and frame reads: the handshake and the
 * first server frame can arrive in the same TCP segment, and neither read may
 * drop bytes the other needs.
 */
class WsBuffer {
  private buffer = Buffer.alloc(0);
  private pendingFrames: Frame[] = [];
  private stringWaiters: Array<{
    resolve: (text: string) => void;
    reject: (err: Error) => void;
    marker: string;
    timer: NodeJS.Timeout;
  }> = [];
  private frameWaiters: Array<{
    resolve: (frame: Frame) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => this.push(chunk));
  }

  private push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  private httpMode = true;

  private drain(): void {
    if (this.httpMode) {
      // Before the 101 handshake is seen, the bytes are HTTP headers: never
      // parse them as WebSocket frames.
      this.drainStrings();
      if (this.httpMode) return;
    }
    // Frames first (byte-oriented).
    for (;;) {
      const frame = tryParseServerFrame(this.buffer);
      if (!frame) break;
      this.buffer = this.buffer.subarray(frameBytes(frame));
      const waiter = this.frameWaiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else {
        // Frame arrived before anyone asked for it (e.g. the initial
        // session frame in the same segment as the handshake): queue it.
        this.pendingFrames.push(frame);
      }
    }
    this.drainStrings();
  }

  private drainStrings(): void {
    for (;;) {
      const waiter = this.stringWaiters[0];
      if (!waiter) break;
      const text = this.buffer.toString("utf8");
      const at = text.indexOf(waiter.marker);
      if (at < 0) break;
      this.stringWaiters.shift();
      clearTimeout(waiter.timer);
      const consumed = Buffer.byteLength(text.slice(0, at + waiter.marker.length));
      this.buffer = this.buffer.subarray(consumed);
      waiter.resolve(text.slice(0, at + waiter.marker.length));
      if (this.httpMode && waiter.marker === "\r\n\r\n") {
        this.httpMode = false;
      }
    }
  }

  readString(marker: string, timeoutMs = 3000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stringWaiters = this.stringWaiters.filter((w) => w.reject !== reject);
        reject(new Error("timed out reading: " + this.buffer.toString("utf8").slice(0, 200)));
      }, timeoutMs);
      this.stringWaiters.push({ resolve, reject, marker, timer });
      this.drain();
    });
  }

  readFrame(timeoutMs = 3000): Promise<Frame> {
    const queued = this.pendingFrames.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.frameWaiters = this.frameWaiters.filter((w) => w.reject !== reject);
        reject(new Error("timed out waiting for ws frame"));
      }, timeoutMs);
      this.frameWaiters.push({ resolve, reject, timer });
      this.drain();
    });
  }
}

function frameBytes(frame: Frame): number {
  let size = 2;
  if (frame.payload.length >= 65536) size += 8;
  else if (frame.payload.length >= 126) size += 2;
  return size + frame.payload.length;
}

interface Frame {
  opcode: number;
  payload: Buffer;
}

async function readFrame(socket: net.Socket, timeoutMs = 3000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.off("data", onData);
      reject(new Error("timed out waiting for ws frame"));
    }, timeoutMs);
    function onData(chunk: Buffer): void {
      buffer = Buffer.concat([buffer, chunk]);
      const frame = tryParseServerFrame(buffer);
      if (frame) {
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(frame);
      }
    }
    socket.on("data", onData);
  });
}

function tryParseServerFrame(buffer: Buffer): Frame | undefined {
  if (buffer.length < 2) return undefined;
  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  const opcode = first & 0x0f;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + length) return undefined;
  return { opcode, payload: buffer.subarray(offset, offset + length) };
}

function buildMaskedFrame(opcode: number, payload: Buffer): Buffer {
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  }
  return Buffer.concat([header, mask, masked]);
}

test("realtime websocket handshake validates and accepts, then serves events and commands", async () => {
  const capture = new FakeAudioCapture();
  const playback = new FakeAudioPlayback();
  const wake = new FakeWakeWordProvider();
  const vad = new FakeVadProvider();
  const stt = new FakeSttProvider();
  const tts = new FakeTtsProvider();
  const app = buildTestApp(
    { voice: { voiceEnabled: true, wakeEnabled: true, wakeWord: "arthur", ttsMaxQueueChunks: 8 } },
    {
      provider: new FakeProvider({
        streamResponder: (async function* () {
          yield { type: "text_delta", text: "Hello there!" };
          yield { type: "usage", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } };
          yield { type: "done", finish_reason: "stop" };
        }) as (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>,
      }),
      voice: { capture, playback, wake, vad, stt, tts },
    },
  );
  const { server, port } = await startServer(app, { host: "127.0.0.1", port: 0 });
  const turn = await app.conversation.handleTurn(validTurn());
  try {
    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const reader = new WsBuffer(socket);
    const key = Buffer.from("sample-nonce").toString("base64");
    const expectedAccept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "GET /v1/voice/realtime HTTP/1.1\r\n" +
        "Host: 127.0.0.1:" + port + "\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: " + key + "\r\n" +
        "Sec-WebSocket-Version: 13\r\n\r\n",
    );
    const handshake = await reader.readString("\r\n\r\n");
    assert.ok(handshake.startsWith("HTTP/1.1 101"));
    assert.ok(handshake.includes(expectedAccept), "Sec-WebSocket-Accept must be computed per RFC 6455");

    // First server frame: current voice.session snapshot.
    const initial = await reader.readFrame();
    assert.equal(initial.opcode, 1);
    const initialJson = JSON.parse(initial.payload.toString("utf8")) as { type: string };
    assert.equal(initialJson.type, "voice.session");

    // Send voice.enable and expect a session update + enabled state.
    const command = Buffer.from(JSON.stringify({ type: "voice.enable", arthur_session_id: turn.session_id }));
    socket.write(buildMaskedFrame(1, command));
    let enabled = false;
    for (let i = 0; i < 5 && !enabled; i++) {
      const frame = await reader.readFrame();
      if (frame.opcode !== 1) continue;
      const json = JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
      if (json.type === "voice.session") {
        // IDLE is the enabled listening state; DISABLED is the disabled state.
        enabled = (json.session as { state?: string })?.state === "idle";
      }
    }
    assert.equal(enabled, true, "voice.session must report idle after voice.enable");

    // Ping -> pong.
    socket.write(buildMaskedFrame(9, Buffer.from("ping-payload")));
    const pong = await reader.readFrame();
    assert.equal(pong.opcode, 10);

    // Close handshake.
    socket.write(buildMaskedFrame(8, Buffer.from([0x03, 0xe8])));
    const close = await reader.readFrame();
    assert.equal(close.opcode, 8);
    socket.destroy();
  } finally {
    server.close();
    await app.close();
  }
});

test("realtime upgrade on a wrong path is refused with 404", async () => {
  const app = buildTestApp();
  const { server, port } = await startServer(app, { host: "127.0.0.1", port: 0 });
  try {
    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const reader = new WsBuffer(socket);
    socket.write(
      "GET /v1/voice/other HTTP/1.1\r\n" +
        "Host: 127.0.0.1:\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: a2V5\r\n" +
        "Sec-WebSocket-Version: 13\r\n\r\n",
    );
    const response = await reader.readString("\r\n\r\n");
    assert.ok(response.startsWith("HTTP/1.1 404"));
    socket.destroy();
  } finally {
    server.close();
    await app.close();
  }
});