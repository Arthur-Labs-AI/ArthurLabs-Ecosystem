// Line-framed transport helpers shared by the runtime host (stdio) and the
// desktop client (child stdout). No I/O here: a persistent StringDecoder
// owns chunk boundaries so split multibyte codepoints never corrupt, and
// every bound is enforced in UTF-8 bytes (never JS string length) so the
// runtime RPC shares the CLI IPC byte semantics.
import { StringDecoder } from 'node:string_decoder';
import { parseRpcLine, type RpcMessage } from './protocol.js';

export const MAX_RPC_LINE_BYTES = 8 * 1024 * 1024;

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

// True wire ceiling for one canonical export carried inline: the base64
// body (4/3 expansion, JSON-safe alphabet, 1 byte per char) plus envelope
// slack (~id, filename, mime fields) must fit MAX_RPC_LINE_BYTES with
// margin. 6,000,000 raw bytes -> exactly 8,000,000 base64 chars; even with
// 4 KiB of framing the worst case is 8,004,096, safely below 8,388,608.
// Enforced before materializing export bytes.
export const RUNTIME_EXPORT_MAX_RAW_BYTES = 6_000_000;

export function exportSizeAllowed(sizeBytes: number): boolean {
  return (
    Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 && sizeBytes <= RUNTIME_EXPORT_MAX_RAW_BYTES
  );
}

export class RpcLineBuffer {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private droppedOversize = 0;
  private oversizeIds: string[] = [];
  private readonly maxLineBytes: number;

  constructor(maxLineBytes: number = MAX_RPC_LINE_BYTES) {
    this.maxLineBytes = maxLineBytes;
  }

  get droppedOversizeLines(): number {
    return this.droppedOversize;
  }

  /**
   * Ids extracted from dropped oversize RESPONSE lines since the last
   * call. The transport caller must fail exactly those pending requests
   * with a deterministic error instead of leaving them to time out.
   * Oversize notifications (hints only) stay drop-and-count: polling
   * reconciles, and an unroutable frame must not kill healthy requests.
   */
  drainOversizeIds(): string[] {
    const ids = this.oversizeIds;
    this.oversizeIds = [];
    return ids;
  }

  push(chunk: Buffer | string): RpcMessage[] {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const out: RpcMessage[] = [];
    let index = this.pending.indexOf('\n');
    while (index >= 0) {
      const line = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + 1);
      if (byteLength(line) > this.maxLineBytes) {
        this.droppedOversize += 1;
        const id = oversizeResponseId(line);
        if (id !== undefined) this.oversizeIds.push(id);
      } else if (line.trim().length > 0) {
        out.push(parseRpcLine(line));
      }
      if (byteLength(this.pending) > this.maxLineBytes * 2) {
        this.pending = '';
        this.droppedOversize += 1;
      }
      index = this.pending.indexOf('\n');
    }
    if (byteLength(this.pending) > this.maxLineBytes * 2) {
      this.pending = '';
      this.droppedOversize += 1;
    }
    return out;
  }
}

// Best-effort id recovery from an oversize line: the line is complete
// (newline-terminated) but too big to parse fully. A bounded prefix scan
// for a response id lets the caller fail exactly one request. Anything
// unparseable stays drop-and-count.
function oversizeResponseId(line: string): string | undefined {
  if (!line.includes('"response"')) return undefined;
  try {
    const raw = JSON.parse(line) as { type?: unknown; id?: unknown };
    if (
      raw.type === 'response' &&
      typeof raw.id === 'string' &&
      raw.id.length > 0 &&
      raw.id.length <= 100
    ) {
      return raw.id;
    }
  } catch {
    // Unparseable oversize frame: no safe routing possible.
  }
  return undefined;
}
