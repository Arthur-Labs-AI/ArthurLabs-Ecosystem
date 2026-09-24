import { describe, expect, it } from 'vitest';
import {
  RUNTIME_PROTOCOL_VERSION,
  RpcFramingError,
  RpcLineBuffer,
  RuntimeConfigureParamsSchema,
  encodeRpcLine,
  parseRpcLine,
} from '../src/index.js';

describe('runtime protocol framing', () => {
  it('exposes protocol version 1', () => {
    expect(RUNTIME_PROTOCOL_VERSION).toBe(1);
  });

  it('round-trips request/response/notification', () => {
    const request = { type: 'request', id: 'rpc_1', method: 'runs.list', params: {} };
    expect(parseRpcLine(encodeRpcLine(request as never).trim())).toMatchObject({
      type: 'request',
      id: 'rpc_1',
    });
    const response = { type: 'response', id: 'rpc_1', ok: true, result: { runs: [] } };
    expect(parseRpcLine(encodeRpcLine(response as never).trim())).toMatchObject({ ok: true });
    const error = {
      type: 'response',
      id: 'rpc_1',
      ok: false,
      error: { code: 'RUN_NOT_FOUND', message: 'missing' },
    };
    expect(parseRpcLine(encodeRpcLine(error as never).trim())).toMatchObject({ ok: false });
    const note = { type: 'notification', event: 'run.snapshot', payload: { runId: 'x' } };
    expect(parseRpcLine(encodeRpcLine(note as never).trim())).toMatchObject({
      type: 'notification',
    });
  });

  it('rejects malformed JSON and unknown shapes', () => {
    expect(() => parseRpcLine('{nope')).toThrow(RpcFramingError);
    expect(() => parseRpcLine('{"type":"bogus"}')).toThrow(RpcFramingError);
    expect(() =>
      parseRpcLine('{"type":"response","id":"a","ok":true,"error":{"code":"X","message":"Y"}}'),
    ).toThrow(RpcFramingError);
    expect(() => parseRpcLine('{"type":"response","id":"a","ok":false}')).toThrow(RpcFramingError);
  });

  it('accepts the deprecated muse model field but ignores it (v1 compat)', () => {
    const parsed = RuntimeConfigureParamsSchema.parse({
      models: { muse: 'muse-spark-1.3-contributor', opencode: 'anthropic/x' },
      providers: {},
    });
    expect(parsed.models.muse).toBe('muse-spark-1.3-contributor');
    expect(parsed.models.opencode).toBe('anthropic/x');
    expect(RUNTIME_PROTOCOL_VERSION).toBe(1);
  });

  it('accepts harness binary overrides without a version bump', () => {
    const parsed = RuntimeConfigureParamsSchema.parse({
      models: {},
      providers: {},
      binaries: { opencode: '/home/u/tools/opencode' },
    });
    expect(parsed.binaries?.opencode).toBe('/home/u/tools/opencode');
    expect(parsed.binaries?.deepseek).toBeUndefined();
    expect(RUNTIME_PROTOCOL_VERSION).toBe(1);
  });

  it('leaves binaries undefined when the sender omits the block', () => {
    const parsed = RuntimeConfigureParamsSchema.parse({ models: {}, providers: {} });
    expect(parsed.binaries).toBeUndefined();
  });

  it('buffers partial lines and drops oversize input', () => {
    const buffer = new RpcLineBuffer();
    const first = buffer.push('{"type":"notifica');
    expect(first).toHaveLength(0);
    const second = buffer.push('tion","event":"run.created"}\n');
    expect(second).toHaveLength(1);
    const huge = buffer.push('x'.repeat(9 * 1024 * 1024) + '\n');
    expect(huge).toHaveLength(0);
    expect(buffer.droppedOversizeLines).toBeGreaterThan(0);
  });
});
