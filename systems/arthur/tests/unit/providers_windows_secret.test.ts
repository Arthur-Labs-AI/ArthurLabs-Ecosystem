import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { CliExit } from '../../src/cli_exit';
import type { CliIO } from '../../apps/cli/index';
import { ProvidersSetupCancelled, runProvidersSetup } from '../../apps/cli/providers';
import {
  createNodeSecretTty,
  readSecret,
  tokenizeSecretBytes,
} from '../../src/providers/secret_input';

/**
 * FRS-02 Windows interactive fix: deterministic regression tests for the
 * real PowerShell repro (prompt printed, Enter pressed, silent exit 0).
 *
 * Root causes covered:
 *  1. stdin.once('data') per key WITHOUT resume() — after readline closes,
 *     stdin is paused so 'data' never fires (hung promise, drained loop,
 *     silent exit 0). The tap resumes + buffers + tokenizes.
 *  2. Multi-char Windows chunks ('abc123\r\n' in ONE event) classified as
 *     EOF -> false 'cancelled' -> exit SUCCESS. The tokenizer splits them.
 *
 * All tests use injected seams/events — no real console required. Secret
 * values below are test-only fixtures; every leakage assertion proves they
 * never reach stdout/stderr/errors/diagnostics.
 */

const SECRET = 'abc123';
const LONG_SECRET = 'sk-test-windows-paste-secret-0123456789';

/** Fake stdin: EventEmitter with TTY flags, raw-mode + resume/pause recording. */
class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw: boolean | undefined = false;
  setRawCalls: boolean[] = [];
  resumed = false;
  paused = false;
  setRawMode(mode: boolean): void {
    this.setRawCalls.push(mode);
    this.isRaw = mode;
  }
  resume(): this {
    this.resumed = true;
    return this;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
}

function fakeStdout(): NodeJS.WriteStream & { chunks: string[] } {
  const chunks: string[] = [];
  const stream = new EventEmitter() as unknown as NodeJS.WriteStream & { chunks: string[] };
  (stream as { isTTY?: boolean }).isTTY = true;
  stream.write = ((text: string) => { chunks.push(String(text)); return true; }) as NodeJS.WriteStream['write'];
  stream.chunks = chunks;
  return stream;
}

function emitBytes(stdin: FakeStdin, text: string): void {
  stdin.emit('data', Buffer.from(text, 'utf8'));
}

async function readWithChunks(chunks: Array<Buffer | string>, opts: { label?: string } = {}): Promise<{ kind: string; value?: string }> {
  const stdin = new FakeStdin();
  const stdout = fakeStdout();
  const handle = createNodeSecretTty({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream });
  try {
    const pending = readSecret(handle.tty, { label: opts.label ?? 'DeepSeek API key' });
    for (const chunk of chunks) stdin.emit('data', typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    return (await pending) as { kind: string; value?: string };
  } finally {
    handle.close();
  }
}

// ---- 1–6: Enter variants, paste, char-by-char, backspace ------------------

test('W1: CR submits (secret + CR returns secret)', async () => {
  const result = await readWithChunks([SECRET + '\r']);
  assert.deepEqual(result, { kind: 'submitted', value: SECRET });
});

test('W2: LF submits (secret + LF returns secret)', async () => {
  const result = await readWithChunks([SECRET + '\n']);
  assert.deepEqual(result, { kind: 'submitted', value: SECRET });
});

test('W3: CRLF is ONE submit (no empty second event)', async () => {
  const stdin = new FakeStdin();
  const stdout = fakeStdout();
  const handle = createNodeSecretTty({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream });
  try {
    const first = readSecret(handle.tty, { label: 'K' });
    emitBytes(stdin, SECRET + '\r\n');
    assert.deepEqual(await first, { kind: 'submitted', value: SECRET });
    // A second prompt must NOT see a ghost ENTER (would return 'empty').
    const second = readSecret(handle.tty, { label: 'K2' });
    emitBytes(stdin, 'z\n');
    assert.deepEqual(await second, { kind: 'submitted', value: 'z' });
  } finally {
    handle.close();
  }
});

test('W4: Windows paste chunk (whole secret + CRLF in ONE data event)', async () => {
  const result = await readWithChunks([Buffer.from(LONG_SECRET + '\r\n', 'utf8')]);
  assert.deepEqual(result, { kind: 'submitted', value: LONG_SECRET });
});

test('W5: character-by-character input gives the same result as paste', async () => {
  const perChar = [...LONG_SECRET].map((c) => Buffer.from(c, 'utf8')).concat([Buffer.from('\r\n', 'utf8')]);
  const result = await readWithChunks(perChar);
  assert.deepEqual(result, { kind: 'submitted', value: LONG_SECRET });
});

test('W6: backspace supports BS 0x08 and DEL 0x7f', async () => {
  const bs = await readWithChunks(['a', 'b', Buffer.from([0x08]), 'c\n']);
  assert.deepEqual(bs, { kind: 'submitted', value: 'ac' });
  const del = await readWithChunks(['a', 'b', Buffer.from([0x7f]), 'c\r']);
  assert.deepEqual(del, { kind: 'submitted', value: 'ac' });
});

// ---- 7–10: Ctrl+C, EOF, listener + raw-mode cleanup -----------------------

test('W7: Ctrl+C cancels typed and restores terminal', async () => {
  const stdin = new FakeStdin();
  const stdout = fakeStdout();
  const handle = createNodeSecretTty({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream });
  const pending = readSecret(handle.tty, { label: 'K' });
  emitBytes(stdin, 'ab');
  stdin.emit('data', Buffer.from([0x03]));
  assert.deepEqual(await pending, { kind: 'cancelled' });
  handle.close();
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdin.listenerCount('end'), 0);
  assert.deepEqual(stdin.setRawCalls[stdin.setRawCalls.length - 1], false);
  assert.equal(stdin.paused, true);
});

test('W8: EOF (end event) cancels cleanly and restores terminal', async () => {
  const stdin = new FakeStdin();
  const stdout = fakeStdout();
  const handle = createNodeSecretTty({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream });
  const pending = readSecret(handle.tty, { label: 'K' });
  stdin.emit('end');
  assert.deepEqual(await pending, { kind: 'cancelled' });
  handle.close();
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdin.paused, true);
});

test('W9: no dangling data/end listeners after success', async () => {
  const stdin = new FakeStdin();
  const stdout = fakeStdout();
  const handle = createNodeSecretTty({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream });
  const pending = readSecret(handle.tty, { label: 'K' });
  emitBytes(stdin, SECRET + '\n');
  assert.deepEqual(await pending, { kind: 'submitted', value: SECRET });
  handle.close();
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdin.listenerCount('end'), 0);
});

test('W10: prior raw state restored and resume() called on open', async () => {
  const stdin = new FakeStdin();
  stdin.isRaw = false;
  const stdout = fakeStdout();
  const before = stdin.listenerCount('data');
  const handle = createNodeSecretTty({ stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream });
  assert.equal(stdin.resumed, true);
  assert.deepEqual(stdin.setRawCalls[0], true);
  const pending = readSecret(handle.tty, { label: 'K' });
  emitBytes(stdin, 'x\n');
  await pending;
  handle.close();
  assert.deepEqual(stdin.setRawCalls[stdin.setRawCalls.length - 1], false);
  assert.equal(stdin.listenerCount('data'), before);
  // Double close is idempotent.
  handle.close();
  assert.equal(handle.closed, true);
});

// ---- tokenizer unit coverage (pure, no streams) ---------------------------

test('W11a: tokenizer splits paste chunk and collapses CRLF', () => {
  const { tokens, rest } = tokenizeSecretBytes(Buffer.from('abc123\r\n', 'utf8'));
  assert.deepEqual(tokens, ['a', 'b', 'c', '1', '2', '3', 'ENTER']);
  assert.equal(rest.length, 0);
});

test('W11b: tokenizer maps lone CR, lone LF, BS, DEL, ETX', () => {
  assert.deepEqual(tokenizeSecretBytes(Buffer.from('\r', 'utf8')).tokens, ['ENTER']);
  assert.deepEqual(tokenizeSecretBytes(Buffer.from('\n', 'utf8')).tokens, ['ENTER']);
  assert.deepEqual(tokenizeSecretBytes(Buffer.from([0x08])).tokens, ['BACKSPACE']);
  assert.deepEqual(tokenizeSecretBytes(Buffer.from([0x7f])).tokens, ['BACKSPACE']);
  assert.deepEqual(tokenizeSecretBytes(Buffer.from([0x03])).tokens, ['CANCEL']);
});

// ---- 11–13: CLI setup cancellation + success continuation + leakage ------

function testIo(): CliIO & { outText: string; errText: string } {
  const sink = { outText: '', errText: '' } as CliIO & { outText: string; errText: string };
  (sink as CliIO).out = (t: string) => { sink.outText += t; };
  (sink as CliIO).err = (t: string) => { sink.errText += t; };
  return sink;
}

function emptyLayers(): { ambient: Record<string, string>; repo: Record<string, string>; machine: Record<string, string> } {
  return { ambient: {}, repo: {}, machine: {} };
}

test('W11: CLI setup cancellation => zero writes and NOT exit-success', async () => {
  const out = testIo();
  const answers = ['y'];
  let commits = 0;
  const code = await runProvidersSetup({}, new Map(), out, {
    tty: true,
    secretTty: { isTTY: true, write: () => undefined, readKey: async () => 'CANCEL' },
    layers: emptyLayers(),
    readApprovalLine: async () => answers.shift() ?? '',
    commitPatch: () => { commits += 1; },
  });
  assert.equal(commits, 0);
  assert.equal(code, CliExit.INTERNAL);
  assert.notEqual(code, CliExit.SUCCESS);
  assert.ok(out.outText.includes('Setup cancelled. No changes were saved.'));
});

test('W12: successful secret entry continues to provider validation (no instant return)', async () => {
  const out = testIo();
  // DeepSeek yes -> valid key -> validation runs (Checking DeepSeek...) ->
  // voice no -> review -> save yes. Fetch proves validation was reached.
  const answers = ['y', 'n', 'y'];
  let fetchCalls = 0;
  const fetchFn = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: 'deepseek-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const chars = [...LONG_SECRET, 'ENTER'];
  let i = 0;
  const patches: Array<{ set: Record<string, string>; remove: string[] }> = [];
  const code = await runProvidersSetup({}, new Map(), out, {
    tty: true,
    secretTty: { isTTY: true, write: () => undefined, readKey: async () => chars[i++] ?? 'EOF' },
    layers: emptyLayers(),
    readApprovalLine: async () => answers.shift() ?? '',
    commitPatch: (p) => { patches.push(p); },
    fetchFn,
  });
  assert.ok(fetchCalls >= 1, 'setup must reach provider validation, not return to shell');
  assert.ok(out.outText.includes('Checking DeepSeek...'));
  assert.ok(out.outText.includes('Review'));
  assert.equal(code, CliExit.SUCCESS);
  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.set['DEEPSEEK_API_KEY'], LONG_SECRET);
});

test('W13: entered secret absent from stdout/stderr/public errors/diagnostics', async () => {
  const out = testIo();
  const answers = ['y', 'n', 'n', 'n'];
  const bad = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
  const chars = [...LONG_SECRET, 'ENTER'];
  let i = 0;
  const code = await runProvidersSetup({}, new Map(), out, {
    tty: true,
    secretTty: { isTTY: true, write: () => undefined, readKey: async () => chars[i++] ?? 'EOF' },
    layers: emptyLayers(),
    readApprovalLine: async () => answers.shift() ?? '',
    commitPatch: () => { throw new Error('must not commit invalid key'); },
    fetchFn: bad,
  });
  assert.equal(code, CliExit.SUCCESS);
  assert.ok(!out.outText.includes(LONG_SECRET));
  assert.ok(!out.errText.includes(LONG_SECRET));
  assert.ok(out.outText.includes('was NOT saved'));
  // The typed cancellation error itself carries no secret.
  const cancel = new ProvidersSetupCancelled();
  assert.ok(!cancel.message.includes(LONG_SECRET));
  assert.equal(cancel.name, 'ProvidersSetupCancelled');
});
/*MORE*/
