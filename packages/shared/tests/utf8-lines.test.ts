import { describe, expect, it } from 'vitest';
import { Utf8LineBuffer } from '../src/utf8-lines.js';

function splitBytes(value: string, at: number[]): Buffer[] {
  const bytes = Buffer.from(value, 'utf8');
  const out: Buffer[] = [];
  let start = 0;
  for (const end of [...at, bytes.length]) {
    out.push(bytes.subarray(start, end));
    start = end;
  }
  return out;
}

describe('utf8 line buffer', () => {
  it('reassembles a Cyrillic codepoint split between chunks', () => {
    const buffer = new Utf8LineBuffer();
    const text = '{"text":"Проверка на проект"}\n';
    const bytes = Buffer.from(text, 'utf8');
    // Split inside the two-byte UTF-8 sequence of 'П' (D0 9F).
    const first = bytes.indexOf(Buffer.from([0xd0]));
    const lines: string[] = [];
    for (const chunk of [bytes.subarray(0, first + 1), bytes.subarray(first + 1)]) {
      lines.push(...buffer.push(chunk));
    }
    expect(lines).toEqual(['{"text":"Проверка на проект"}']);
    expect(lines[0]).toBe(text.trim());
  });

  it('reassembles an emoji split across three chunks', () => {
    const buffer = new Utf8LineBuffer();
    const text = '{"note":"done 😀 ok"}\n';
    const bytes = Buffer.from(text, 'utf8');
    const emojiAt = bytes.indexOf(Buffer.from([0xf0]));
    const chunks = splitBytes(text, [emojiAt + 1, emojiAt + 3]);
    expect(chunks).toHaveLength(3);
    const lines: string[] = [];
    for (const chunk of chunks) lines.push(...buffer.push(chunk));
    expect(lines).toEqual(['{"note":"done 😀 ok"}']);
  });

  it('accepts strings and tracks pending bytes honestly', () => {
    const buffer = new Utf8LineBuffer();
    expect(buffer.push('{"a":1}\n{"b":"é'));
    expect(buffer.push('"}\n')).toEqual(['{"b":"é"}']);
    expect(buffer.pendingByteLength).toBe(0);
    buffer.push('é');
    expect(buffer.pendingByteLength).toBe(2);
    expect(buffer.flush()).toBe('é');
  });

  it('holds partial lines until the newline arrives', () => {
    const buffer = new Utf8LineBuffer();
    expect(buffer.push(Buffer.from('{"x":', 'utf8'))).toEqual([]);
    expect(buffer.push(Buffer.from('1}\n{"y":2}\n', 'utf8'))).toEqual(['{"x":1}', '{"y":2}']);
  });
});
