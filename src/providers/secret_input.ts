/**
 * FRS-02: reusable masked interactive secret reader.
 *
 * Two layers:
 *
 * 1. readSecret(tty) — pure per-key logic over the injected SecretTty seam.
 *    Unit tests drive it with fakes (no real TTY required).
 *
 * 2. createNodeSecretTty() — the production Windows/POSIX-correct backend.
 *    A persistent buffered stdin tap (ONE 'data' listener, explicit resume,
 *    raw-mode save/restore, guaranteed cleanup) whose readKey() tokenizes
 *    the byte stream: CR, LF, and CRLF all submit; BS (0x08) and DEL (0x7f)
 *    backspace; Ctrl+C (0x03) cancels; multi-byte UTF-8 and whole pasted
 *    chunks (e.g. 'abc123\r\n' in ONE data event — the normal Windows
 *    conhost/paste shape) are split into ordered per-key tokens.
 *
 * Windows root cause fixed here (FRS-02 fix task): the previous backend
 * attached stdin.once('data') per key WITHOUT resume() — after readline
 * (askConfirm) closed, stdin is paused, so 'data' never fired: the promise
 * hung, the loop drained, and the process exited 0 silently. It also
 * classified any multi-char chunk as EOF, turning a normal pasted Enter
 * into a silent successful 'cancel'. Both defects are gone: the tap
 * resumes stdin once, buffers everything, and tokenizes correctly.
 *
 * Display: no secret echo — a fixed '*' marker rendered ONCE regardless of
 * length (no per-character length leakage). The prompt keeps the fixed
 * '[hidden]' UX; the value never appears in prompts, errors, or output.
 */

import { ArthurError } from '../core/errors/errors';

/** Maximum accepted secret length (matches the machine-config 64 KiB bound). */
export const SECRET_INPUT_MAX_CHARS = 65536;
/** Fixed mask glyph count rendered while typing (never the real length). */
export const SECRET_MASK_GLYPHS = 8;

export type SecretPromptResult =
  | { kind: 'submitted'; value: string }
  | { kind: 'cancelled' }
  | { kind: 'empty' };

export interface SecretTty {
  /** True when masked interactive entry is allowed (real TTY). */
  isTTY: boolean;
  /** Write one output chunk (prompt text, mask glyphs, newlines). */
  write(text: string): void;
  /**
   * Read one key event. Resolves to a single printable char, 'ENTER',
   * 'BACKSPACE', 'CANCEL' (Ctrl+C), or 'EOF'. Must never echo the secret.
   */
  readKey(): Promise<string>;
}

export interface SecretInputOptions {
  /** Prompt label WITHOUT the value, e.g. 'DeepSeek API key'. */
  label: string;
  /** Bounded maximum length (default SECRET_INPUT_MAX_CHARS). */
  maxChars?: number;
  /** Allow empty submission (default false → empty Enter returns 'empty'). */
  allowEmpty?: boolean;
}

/**
 * Read one secret interactively over an injected TTY seam. The secret is
 * held in a local buffer only; the terminal shows a fixed mask. Throws
 * INVALID_REQUEST (never the secret) on misuse: non-TTY, oversized,
 * or corrupt input. CANCEL/EOF resolve to 'cancelled' (the CALLER decides
 * exit semantics — see apps/cli/providers.ts).
 */
export async function readSecret(tty: SecretTty, options: SecretInputOptions): Promise<SecretPromptResult> {
  if (!tty.isTTY) {
    throw new ArthurError(
      'INVALID_REQUEST',
      'credential entry requires an interactive terminal; refusing to read a secret from a non-interactive stream',
    );
  }
  const maxChars = options.maxChars ?? SECRET_INPUT_MAX_CHARS;
  const label = options.label.trim() === '' ? 'API key' : options.label;
  // Fixed hint: the value itself never appears in the prompt or after it.
  tty.write(label + ': [hidden] ');
  let buffer = '';
  let maskShown = false;
  for (;;) {
    const key = await tty.readKey();
    if (key === 'CANCEL' || key === 'EOF') {
      tty.write('\n');
      return { kind: 'cancelled' };
    }
    if (key === 'ENTER') {
      tty.write('\n');
      if (buffer === '' && options.allowEmpty !== true) return { kind: 'empty' };
      return { kind: 'submitted', value: buffer };
    }
    if (key === 'BACKSPACE') {
      if (buffer.length > 0) buffer = buffer.slice(0, buffer.length - 1);
      continue;
    }
    if (typeof key !== 'string' || key.length !== 1) {
      throw new ArthurError('INVALID_REQUEST', 'credential entry was cancelled: unreadable input');
    }
    const code = key.charCodeAt(0);
    if (code === 0 || code === 10 || code === 13 || (code < 32 && code !== 9) || code === 127) {
      throw new ArthurError('INVALID_REQUEST', 'credential entry rejected: unsupported control character');
    }
    if (buffer.length + 1 > maxChars) {
      throw new ArthurError('INVALID_REQUEST', 'credential entry exceeds the maximum accepted length');
    }
    buffer += key;
    // Fixed visual marker: rendered ONCE no matter how many chars follow,
    // so the terminal never reveals the real length.
    if (!maskShown) {
      maskShown = true;
      tty.write('*'.repeat(SECRET_MASK_GLYPHS));
    }
  }
}

// ---------------------------------------------------------------------------
// Production Node backend: persistent buffered stdin tap
// ---------------------------------------------------------------------------

export interface NodeSecretTtyHandle {
  tty: SecretTty;
  /** Detach the tap and restore terminal state. Idempotent; also runs via finally. */
  close(): void;
  /** True after close(). */
  readonly closed: boolean;
}

export interface NodeSecretTtyDeps {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

/**
 * Tokenize buffered bytes into readKey() tokens. Pure (unit-testable):
 * consumes whole pasted chunks, collapses CRLF to ONE ENTER, maps BS/DEL,
 * surfaces ETX as CANCEL. Returns unconsumed remainder + tokens.
 */
export function tokenizeSecretBytes(input: Buffer<ArrayBufferLike>): { tokens: string[]; rest: Buffer<ArrayBufferLike> } {
  const tokens: string[] = [];
  // Walk raw bytes for control classification; decode one UTF-8 character
  // per step for everything else, so multi-byte glyphs and whole pasted
  // chunks split into ordered per-key tokens. A trailing incomplete UTF-8
  // sequence stays in `rest` until more bytes arrive.
  let byteIndex = 0;
  const bytes = input;
  while (byteIndex < bytes.length) {
    const byte = bytes[byteIndex] as number;
    if (byte === 0x03) {
      // Ctrl+C (ETX): cancel. Everything before it stays queued? No —
      // cancellation discards the line: emit CANCEL and drop the rest of
      // THIS chunk (a paste containing ETX is operator abort, not data).
      tokens.push('CANCEL');
      return { tokens, rest: Buffer.alloc(0) };
    }
    if (byte === 0x0d) {
      // CR: submit. A directly following LF belongs to the same keypress.
      tokens.push('ENTER');
      byteIndex += 1;
      if ((bytes[byteIndex] as number | undefined) === 0x0a) {
        byteIndex += 1;
      }
      continue;
    }
    if (byte === 0x0a) {
      tokens.push('ENTER');
      byteIndex += 1;
      continue;
    }
    if (byte === 0x08 || byte === 0x7f) {
      tokens.push('BACKSPACE');
      byteIndex += 1;
      continue;
    }
    if (byte === 0x04) {
      // EOT (Ctrl+D / Ctrl+Z-as-EOF marker): only EOF when it is the SOLE
      // remaining byte; otherwise treat as data boundary (never silently
      // swallow a typed line).
      if (byteIndex === 0 && bytes.length === 1) {
        tokens.push('EOF');
        return { tokens, rest: Buffer.alloc(0) };
      }
      byteIndex += 1;
      continue;
    }
    if (byte < 0x20 && byte !== 0x09) {
      // Other control bytes (but NOT NUL — NUL must reach readSecret so it
      // throws the typed corruption error instead of vanishing).
      if (byte === 0x00) {
        tokens.push('\0');
        byteIndex += 1;
        continue;
      }
      byteIndex += 1;
      continue;
    }
    // One full UTF-8 character starting at byteIndex.
    const slice = bytes.subarray(byteIndex);
    const decoded = slice.toString('utf8');
    const first = decoded[0] as string;
    const firstLen = Buffer.byteLength(first, 'utf8');
    // Incomplete trailing sequence: wait for more bytes.
    if (first === '\ufffd' && firstLen === 1 && slice.length < 4) {
      break;
    }
    tokens.push(first);
    byteIndex += firstLen;
  }
  return { tokens, rest: bytes.subarray(byteIndex) };
}
/**
 * Create the production secret TTY: one persistent tap over the real
 * stdin/stdout with guaranteed cleanup. The caller MUST call close()
 * (normally in finally) — close() removes the listener, restores the
 * prior raw mode, and pauses stdin. Reads resolve per-key tokens from an
 * internal queue fed by every data event, so pasted/line-buffered Windows
 * chunks can never be lost or misread.
 *
 * EOF: the 'end' event (or a lone EOT) resolves pending reads as EOF once
 * queued input drains. No secret bytes are ever written anywhere.
 */
export function createNodeSecretTty(deps: NodeSecretTtyDeps = {}): NodeSecretTtyHandle {
  const stdin = (deps.stdin ?? process.stdin) as NodeJS.ReadStream;
  const stdout = (deps.stdout ?? process.stdout) as NodeJS.WriteStream;
  const ttyNow = Boolean(stdin.isTTY) && Boolean(stdout.isTTY);
  let queue: string[] = [];
  let rest: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let waiters: Array<(token: string) => void> = [];
  let ended = false;
  let closedState = false;
  const canRaw = typeof (stdin as { setRawMode?: unknown }).setRawMode === 'function' && Boolean(stdin.isTTY);
  let prevRaw: boolean | undefined;
  try {
    prevRaw = (stdin as { isRaw?: boolean }).isRaw;
  } catch { prevRaw = undefined; }

  const pump = (chunk: Buffer): void => {
    if (closedState) return;
    const combined = Buffer.concat([rest, chunk]);
    const { tokens, rest: leftover } = tokenizeSecretBytes(combined);
    rest = leftover;
    for (const token of tokens) {
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(token);
      else queue.push(token);
    }
  };
  const onData = (chunk: Buffer | string): void => {
    pump(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  };
  const onEnd = (): void => {
    ended = true;
    // Drain: leftover partial bytes are dropped (incomplete sequence);
    // pending readers resolve EOF.
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) waiter('EOF');
  };
  try {
    stdin.on('data', onData);
    stdin.on('end', onEnd);
  } catch { /* attach best effort */ }
  try {
    if (canRaw) (stdin as unknown as { setRawMode(mode: boolean): void }).setRawMode(true);
  } catch { /* raw mode best effort */ }
  try {
    if (typeof (stdin as { resume?: unknown }).resume === 'function') (stdin as unknown as { resume(): void }).resume();
  } catch { /* resume best effort */ }

  const handle: NodeSecretTtyHandle = {
    tty: {
      isTTY: ttyNow,
      write: (text: string) => {
        try { stdout.write(text); } catch { /* write best effort */ }
      },
      readKey: () => {
        const next = queue.shift();
        if (next !== undefined) return Promise.resolve(next);
        if (ended && rest.length === 0) return Promise.resolve('EOF');
        return new Promise<string>((resolve) => {
          waiters.push(resolve);
        });
      },
    },
    close: () => {
      if (closedState) return;
      closedState = true;
      try { stdin.removeListener('data', onData); } catch { /* noop */ }
      try { stdin.removeListener('end', onEnd); } catch { /* noop */ }
      try {
        if (canRaw && prevRaw !== undefined) (stdin as unknown as { setRawMode(mode: boolean): void }).setRawMode(prevRaw);
        else if (canRaw) (stdin as unknown as { setRawMode(mode: boolean): void }).setRawMode(false);
      } catch { /* restore best effort */ }
      try {
        if (typeof (stdin as { pause?: unknown }).pause === 'function') (stdin as unknown as { pause(): void }).pause();
      } catch { /* pause best effort */ }
      // Unblock any stranded readers as EOF so no promise hangs forever.
      const pending = waiters;
      waiters = [];
      queue = [];
      rest = Buffer.alloc(0);
      for (const waiter of pending) {
        try { waiter('EOF'); } catch { /* noop */ }
      }
    },
    get closed(): boolean { return closedState; },
  };
  return handle;
}

/**
 * Legacy adapter (kept for API compatibility; no in-repo callers).
 * Prefer createNodeSecretTty() with explicit close() in finally.
 */
export function nodeSecretTty(label: string): { tty: SecretTty; label: string } {
  const handle = createNodeSecretTty();
  return { tty: handle.tty, label };
}
/*END*/
