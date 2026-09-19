/**
 * Line-framed transport helpers shared by the runtime host (stdio) and the
 * desktop client (child stdout). No I/O here — pure line splitting plus
 * bounded buffering so a hostile peer cannot grow memory without bound.
 */
import { parseRpcLine, type RpcMessage } from './protocol.js';

export const MAX_RPC_LINE_BYTES = 8 * 1024 * 1024;

export class RpcLineBuffer {
  private pending = '';
  private droppedOversize = 0;

  get droppedOversizeLines(): number {
    return this.droppedOversize;
  }

  push(chunk: string): RpcMessage[] {
    this.pending += chunk;
    const out: RpcMessage[] = [];
    let index = this.pending.indexOf('\n');
    while (index >= 0) {
      const line = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + 1);
      if (line.length > MAX_RPC_LINE_BYTES) {
        this.droppedOversize += 1;
      } else if (line.trim().length > 0) {
        out.push(parseRpcLine(line));
      }
      if (this.pending.length > MAX_RPC_LINE_BYTES * 2) {
        this.pending = '';
        this.droppedOversize += 1;
      }
      index = this.pending.indexOf('\n');
    }
    if (this.pending.length > MAX_RPC_LINE_BYTES * 2) {
      this.pending = '';
      this.droppedOversize += 1;
    }
    return out;
  }
}
