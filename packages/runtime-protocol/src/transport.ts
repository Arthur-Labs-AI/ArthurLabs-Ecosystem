// Line-framed transport helpers shared by the runtime host (stdio) and the
// desktop client (child stdout). No I/O here: a persistent StringDecoder
// owns chunk boundaries so split multibyte codepoints never corrupt, and
// every bound is enforced in UTF-8 bytes (never JS string length) so the
// runtime RPC shares the CLI IPC byte semantics.
//
// Oversize handling is deterministic, never silent: a complete oversize
// line drops with its response id recovered from a bounded prefix; an
// incomplete frame that outgrows the bound enters an overflow state that
// retains only a bounded prefix, discards until newline, then fails either
// the exact request or the transport. No path leaves a request hanging
// until timeout, and no path parses megabytes of JSON to find an id.
import { StringDecoder } from 'node:string_decoder';
import { parseRpcLine, type RpcMessage } from './protocol.js';

export const MAX_RPC_LINE_BYTES = 8 * 1024 * 1024;

// Bounded metadata retained for one oversized frame: the response head
// (type + id, always ASCII within the first ~100 chars) fits comfortably.
// Retained across calls, so this is the per-connection oversize memory
// ceiling alongside decoder state; transient chunk memory is separate.
export const OVERFLOW_PREFIX_CHARS = 4096;

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
  private transportOverflow = false;
  private readonly maxLineBytes: number;
  private overflowing = false;
  private overflowPrefix = '';

  constructor(maxLineBytes: number = MAX_RPC_LINE_BYTES) {
    this.maxLineBytes = maxLineBytes;
  }

  get droppedOversizeLines(): number {
    return this.droppedOversize;
  }

  /**
   * Ids of dropped oversize RESPONSE lines since the last call. The
   * transport caller must fail exactly those pending requests with a
   * deterministic error instead of leaving them to time out. Oversize
   * notifications (hints only) stay drop-and-count: polling reconciles,
   * and an unroutable frame must not kill healthy requests.
   */
  drainOversizeIds(): string[] {
    const ids = this.oversizeIds;
    this.oversizeIds = [];
    return ids;
  }

  /**
   * True when an oversize frame arrived whose id could not be safely
   * recovered (response without a usable id, or unrecognizable shape).
   * Drains on read. The caller must fail the transport (all pending
   * requests) deterministically; the host side, which tracks no pending
   * requests, keeps drop-and-count. Oversize notifications never set this.
   */
  drainTransportOverflow(): boolean {
    const failed = this.transportOverflow;
    this.transportOverflow = false;
    return failed;
  }
  push(chunk: Buffer | string): RpcMessage[] {
    const out: RpcMessage[] = [];
    let text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (this.overflowing) {
      // Discard without accumulating: only the newline position matters.
      const end = text.indexOf('\n');
      if (end < 0) return out;
      this.finishOverflow();
      text = text.slice(end + 1);
      if (text.length === 0) return out;
    }
    this.pending += text;
    let index = this.pending.indexOf('\n');
    while (index >= 0) {
      const line = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + 1);
      if (byteLength(line) > this.maxLineBytes) {
        this.dropOversizeLine(line);
      } else if (line.trim().length > 0) {
        out.push(parseRpcLine(line));
      }
      index = this.pending.indexOf('\n');
    }
    // The tail has no newline yet: once it outgrows the bound the frame is
    // already oversize, so retain only the bounded prefix and discard until
    // newline instead of accumulating the frame.
    if (byteLength(this.pending) > this.maxLineBytes) {
      this.overflowPrefix = this.pending.slice(0, OVERFLOW_PREFIX_CHARS);
      this.pending = '';
      this.overflowing = true;
      this.droppedOversize += 1;
    }
    return out;
  }

  private dropOversizeLine(line: string): void {
    this.droppedOversize += 1;
    const verdict = classifyOversizeLine(line.slice(0, OVERFLOW_PREFIX_CHARS));
    if (verdict.kind === 'response-id') this.oversizeIds.push(verdict.id);
    else if (verdict.kind === 'unrouted') this.transportOverflow = true;
  }

  private finishOverflow(): void {
    this.overflowing = false;
    const verdict = classifyOversizeLine(this.overflowPrefix);
    this.overflowPrefix = '';
    if (verdict.kind === 'response-id') this.oversizeIds.push(verdict.id);
    else if (verdict.kind === 'unrouted') this.transportOverflow = true;
  }
}

type OversizeVerdict =
  | { readonly kind: 'response-id'; readonly id: string }
  | { readonly kind: 'notification' }
  | { readonly kind: 'unrouted' };

// Bounded classification of an oversize frame from its head only: at most
// OVERFLOW_PREFIX_CHARS are ever inspected, never megabytes of JSON. Only
// a top-level response object whose first two keys are exactly
// type='response' then a plain-ASCII id yields an id; anything else that
// is not clearly a notification is unrouted, so nested user data can never
// be mistaken for the response id.
function classifyOversizeLine(prefix: string): OversizeVerdict {
  const head = prefix.slice(0, OVERFLOW_PREFIX_CHARS);
  const response = /^\s*\{\s*"type"\s*:\s*"response"\s*,\s*"id"\s*:\s*"([^"\\]{1,100})"/.exec(head);
  if (response?.[1] !== undefined) return { kind: 'response-id', id: response[1] };
  if (/^\s*\{\s*"type"\s*:\s*"notification"/.test(head)) return { kind: 'notification' };
  return { kind: 'unrouted' };
}
