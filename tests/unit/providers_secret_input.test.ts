import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ArthurError } from '../../src/core/errors/errors';
import { readSecret, SECRET_INPUT_MAX_CHARS, SECRET_MASK_GLYPHS, type SecretTty } from '../../src/providers/secret_input';

function fakeTty(script: string[], isTTY = true): SecretTty & { written: string[] } {
  const written: string[] = [];
  let i = 0;
  return {
    isTTY,
    written,
    write: (text: string) => { written.push(text); },
    readKey: async () => {
      if (i >= script.length) return 'EOF';
      return script[i++] as string;
    },
  };
}

test('B1: characters accepted, backspace edits, Enter submits, no echo of value', async () => {
  const tty = fakeTty(['a', 'b', 'BACKSPACE', 'c', 'ENTER']);
  const result = await readSecret(tty, { label: 'DeepSeek API key' });
  assert.deepEqual(result, { kind: 'submitted', value: 'ac' });
  const all = tty.written.join('');
  assert.ok(!all.includes('ac'), 'value must never be echoed');
  assert.ok(!all.includes('ab'), 'intermediate value must never be echoed');
});

test('B2: fixed mask glyph count (no per-character length leakage)', async () => {
  const short = fakeTty(['x', 'ENTER']);
  await readSecret(short, { label: 'K' });
  const long = fakeTty(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'ENTER']);
  await readSecret(long, { label: 'K' });
  const countStars = (w: string[]): number => w.join('').split('*').length - 1;
  assert.equal(countStars(short.written), SECRET_MASK_GLYPHS);
  assert.equal(countStars(long.written), SECRET_MASK_GLYPHS);
});

test('B3: Ctrl+C cancels cleanly with no value', async () => {
  const tty = fakeTty(['a', 'b', 'CANCEL']);
  const result = await readSecret(tty, { label: 'K' });
  assert.deepEqual(result, { kind: 'cancelled' });
});

test('B4: EOF cancels cleanly', async () => {
  const tty = fakeTty(['a', 'EOF']);
  const result = await readSecret(tty, { label: 'K' });
  assert.deepEqual(result, { kind: 'cancelled' });
});

test('B5: empty Enter returns empty (not submitted)', async () => {
  const tty = fakeTty(['ENTER']);
  const result = await readSecret(tty, { label: 'K' });
  assert.deepEqual(result, { kind: 'empty' });
});

test('B6: bounded length enforced with typed error (no value in error)', async () => {
  const tty = fakeTty(['a', 'b', 'c', 'ENTER']);
  await assert.rejects(readSecret(tty, { label: 'K', maxChars: 2 }), (e: unknown) => e instanceof ArthurError && !(e as Error).message.includes('abc'));
});

test('B7: control corruption rejected typed', async () => {
  const tty = fakeTty([String.fromCharCode(0)]);
  await assert.rejects(readSecret(tty, { label: 'K' }), (e: unknown) => e instanceof ArthurError);
});

test('B8: non-TTY rejects typed instead of reading from pipes', async () => {
  const tty = fakeTty(['ENTER'], false);
  await assert.rejects(readSecret(tty, { label: 'K' }), (e: unknown) => e instanceof ArthurError && (e as Error).message.includes('interactive terminal'));
});

test('B9: max bound constant matches machine-config scale', () => {
  assert.equal(SECRET_INPUT_MAX_CHARS, 65536);
});
