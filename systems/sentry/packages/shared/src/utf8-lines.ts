// Central UTF-8 NDJSON framing: accepts Buffer or string chunks and owns a
// persistent StringDecoder, so a multibyte codepoint split across two OS
// chunks never becomes a replacement character. Size caps stay with the
// callers (measured with utf8ByteLength); this class only frames lines.
import { StringDecoder } from 'node:string_decoder';

export class Utf8LineBuffer {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';

  /** Complete lines (without the newline); the remainder stays buffered. */
  push(chunk: Buffer | string): string[] {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const out: string[] = [];
    let index = this.pending.indexOf('\n');
    while (index >= 0) {
      out.push(this.pending.slice(0, index));
      this.pending = this.pending.slice(index + 1);
      index = this.pending.indexOf('\n');
    }
    return out;
  }

  /** Buffered but incomplete bytes, measured honestly in UTF-8 bytes. */
  get pendingByteLength(): number {
    return Buffer.byteLength(this.pending, 'utf8');
  }

  /** Flush decoded remainder (call only at stream end; may be partial). */
  flush(): string {
    const tail = this.pending + this.decoder.end();
    this.pending = '';
    return tail;
  }
}
