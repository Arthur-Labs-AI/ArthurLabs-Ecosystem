import { describe, expect, it } from 'vitest';
import {
  MAX_RPC_LINE_BYTES,
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
