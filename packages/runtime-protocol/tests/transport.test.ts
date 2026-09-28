import { describe, expect, it } from 'vitest';
import {
  MAX_RPC_LINE_BYTES,
  OVERFLOW_PREFIX_CHARS,
  RUNTIME_EXPORT_MAX_RAW_BYTES,
  RpcLineBuffer,
  encodeRpcLine,
  exportSizeAllowed,
} from '../src/index.js';

describe('runtime RPC transport', () => {
  it('reassembles a multibyte codepoint split across Buffer chunks', () => {
    const buffer = new RpcLineBuffer();
    const line = encodeRpcLine({
      type: 'notification',
      event: 'run.snapshot',
      payload: { note: 'Проверка 😀' },
    } as never);
    const bytes = Buffer.from(line, 'utf8');
    // Split inside the emoji byte sequence and inside Cyrillic text.
    const cut = bytes.indexOf(Buffer.from([0xf0]));
    const first = buffer.push(bytes.subarray(0, cut + 2));
    expect(first).toEqual([]);
    const rest = buffer.push(bytes.subarray(cut + 2));
    expect(rest).toHaveLength(1);
    expect((rest[0] as { payload?: { note?: string } }).payload?.note).toBe('Проверка 😀');
  });

  it('enforces the line bound in UTF-8 bytes, not characters', () => {
    const buffer = new RpcLineBuffer(128);
    // ~107 chars but ~147 UTF-8 bytes: a .length comparison would admit
    // this response, while the byte bound drops it and recovers the id.
    const line =
      JSON.stringify({
        type: 'response',
        id: 'rpc_wide',
        ok: true,
        result: { note: 'é'.repeat(40) },
      }) + '\n';
    expect(line.length).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(line, 'utf8')).toBeGreaterThan(128);
    expect(buffer.push(Buffer.from(line, 'utf8'))).toEqual([]);
    expect(buffer.droppedOversizeLines).toBe(1);
    expect(buffer.drainOversizeIds()).toEqual(['rpc_wide']);
  });

  it('recovers the id from a dropped oversize response for deterministic failure', () => {
    const buffer = new RpcLineBuffer();
    const big = 'x'.repeat(9 * 1024 * 1024);
    const line =
      JSON.stringify({ type: 'response', id: 'rpc_big', ok: true, result: { blob: big } }) + '\n';
    expect(Buffer.byteLength(line, 'utf8')).toBeGreaterThan(MAX_RPC_LINE_BYTES);
    expect(buffer.push(Buffer.from(line, 'utf8'))).toEqual([]);
    expect(buffer.droppedOversizeLines).toBe(1);
    expect(buffer.drainOversizeIds()).toEqual(['rpc_big']);
    expect(buffer.drainOversizeIds()).toEqual([]);
  });

  it('drops oversize notifications without inventing request failures', () => {
    const buffer = new RpcLineBuffer();
    const big = 'y'.repeat(9 * 1024 * 1024);
    const line =
      JSON.stringify({ type: 'notification', event: 'run.snapshot', payload: { blob: big } }) +
      '\n';
    expect(buffer.push(Buffer.from(line, 'utf8'))).toEqual([]);
    expect(buffer.droppedOversizeLines).toBe(1);
    expect(buffer.drainOversizeIds()).toEqual([]);
  });

  it('fails a huge chunked response without unbounded accumulation', () => {
    const buffer = new RpcLineBuffer();
    const head = JSON.stringify({
      type: 'response',
      id: 'rpc_huge',
      ok: true,
      result: { blob: '' },
    });
    const filler = 'x'.repeat(1024 * 1024);
    const chunks: Buffer[] = [Buffer.from(head.slice(0, 40), 'utf8')];
    for (let i = 0; i < 20; i += 1) chunks.push(Buffer.from(filler, 'utf8'));
    chunks.push(Buffer.from('"}}\n', 'utf8'));
    let messages = 0;
    for (const chunk of chunks) messages += buffer.push(chunk).length;
    expect(messages).toBe(0);
    expect(buffer.droppedOversizeLines).toBe(1);
    expect(buffer.drainOversizeIds()).toEqual(['rpc_huge']);
    expect(buffer.drainTransportOverflow()).toBe(false);
    // Framing resyncs: the next normal frame parses fine.
    const next = buffer.push(Buffer.from('{"type":"notification","event":"e"}\n', 'utf8'));
    expect(next).toHaveLength(1);
  });

  it('drops a chunked oversized notification without touching healthy requests', () => {
    const buffer = new RpcLineBuffer();
    const head = JSON.stringify({
      type: 'notification',
      event: 'run.snapshot',
      payload: { blob: '' },
    });
    const filler = 'y'.repeat(1024 * 1024);
    let messages = 0;
    for (const chunk of [
      head.slice(0, 40),
      filler,
      filler,
      filler,
      filler,
      filler,
      filler,
      filler,
      filler,
      filler,
      '"}}\n',
    ]) {
      messages += buffer.push(Buffer.from(chunk, 'utf8')).length;
    }
    expect(messages).toBe(0);
    expect(buffer.droppedOversizeLines).toBe(1);
    expect(buffer.drainOversizeIds()).toEqual([]);
    expect(buffer.drainTransportOverflow()).toBe(false);
    const next = buffer.push(Buffer.from('{"type":"notification","event":"e"}\n', 'utf8'));
    expect(next).toHaveLength(1);
  });

  it('recovers the id from the bounded prefix without parsing megabytes', () => {
    const buffer = new RpcLineBuffer();
    // Valid anchored head, then garbage that no JSON parser would accept:
    // recovery must come from the prefix scan alone.
    const head = '{"type":"response","id":"rpc_prefix",';
    expect(head.length).toBeLessThan(OVERFLOW_PREFIX_CHARS);
    const chunks = [head, '!!!not-json!!!'.repeat(1000), 'z'.repeat(9 * 1024 * 1024), '\n'];
    let messages = 0;
    for (const chunk of chunks) messages += buffer.push(Buffer.from(chunk, 'utf8')).length;
    expect(messages).toBe(0);
    expect(buffer.droppedOversizeLines).toBe(1);
    expect(buffer.drainOversizeIds()).toEqual(['rpc_prefix']);
  });

  it('fails the transport when an oversize id cannot be recovered', () => {
    const garbage = new RpcLineBuffer();
    const nineMb = 'z'.repeat(9 * 1024 * 1024);
    for (const chunk of [nineMb, 'zzz\n']) {
      garbage.push(Buffer.from(chunk, 'utf8'));
    }
    expect(garbage.droppedOversizeLines).toBe(1);
    expect(garbage.drainOversizeIds()).toEqual([]);
    expect(garbage.drainTransportOverflow()).toBe(true);
    expect(garbage.drainTransportOverflow()).toBe(false);
    const noId = new RpcLineBuffer();
    const head = JSON.stringify({ type: 'response', ok: true, result: {} });
    for (const chunk of [head, 'w'.repeat(9 * 1024 * 1024), '\n']) {
      noId.push(Buffer.from(chunk, 'utf8'));
    }
    expect(noId.drainOversizeIds()).toEqual([]);
    expect(noId.drainTransportOverflow()).toBe(true);
  });

  it('bounds canonical exports so base64 always fits the line limit', () => {
    expect(exportSizeAllowed(RUNTIME_EXPORT_MAX_RAW_BYTES)).toBe(true);
    expect(exportSizeAllowed(RUNTIME_EXPORT_MAX_RAW_BYTES + 1)).toBe(false);
    expect(exportSizeAllowed(-1)).toBe(false);
    expect(exportSizeAllowed(Number.NaN)).toBe(false);
    // Worst case on the wire: base64 (4/3, ASCII) plus envelope slack.
    const worst = 4 * Math.ceil(RUNTIME_EXPORT_MAX_RAW_BYTES / 3) + 4096;
    expect(worst).toBeLessThan(MAX_RPC_LINE_BYTES);
  });
});
