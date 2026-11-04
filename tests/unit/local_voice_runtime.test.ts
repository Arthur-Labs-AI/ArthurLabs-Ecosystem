/**
 * HR-02.5E2 unit tests: resolution, factory, managed providers, lazy legs.
 *
 * Fully deterministic: fake hardware fixtures, in-memory state snapshots,
 * fake worker processes (no spawn), fake state files. No CUDA, GPU,
 * network, HF, OpenAI, or downloads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import { ArthurError } from '../../src/core/errors/errors';
import type { HardwareProfile } from '../../src/runtime/hardware/contracts';
import { defaultStateFile } from '../../src/runtime/local-models/state_contracts';
import type { LocalModelStateFile } from '../../src/runtime/local-models/state_contracts';
import { resolveRuntimeTarget } from '../../src/runtime/local-models/runtime/resolution';
import { createLocalSttProvider, createLocalTtsProvider } from '../../src/runtime/local-models/runtime/factory';
import { ManagedParakeetSttProvider } from '../../src/runtime/local-models/runtime/managed_stt';
import { ManagedLocalTtsProvider, makeBgTtsProvider, makeOmniVoiceTtsProvider } from '../../src/runtime/local-models/runtime/managed_tts';
import { LazyLocalSttProvider, LazyLocalTtsProvider } from '../../src/runtime/local-models/runtime/lazy';
import { peekSelectedModelId } from '../../src/runtime/local-models/runtime/selection_id';
import type { SttProvider, TtsProvider } from '../../src/voice/contracts';
import { windowsNvidiaCuda, linuxArm64CpuOnly } from './hardware_fixtures';

const ROOT = path.normalize(path.resolve('/managed-e2'));
const HW = windowsNvidiaCuda();

function codeOf(err: unknown): string {
  assert.ok(err instanceof ArthurError);
  return (err as ArthurError).code;
}

// State snapshot with one READY model + auto selection.
function readyState(modelId: string, kind: 'stt' | 'tts' | 'model' = 'tts'): LocalModelStateFile {
  const base = defaultStateFile();
  return {
    version: base.version,
    selections: { ...base.selections, [kind]: { mode: 'manual' as const, model_id: modelId } },
    models: { [modelId]: { model_id: modelId, installed: true, configured: true, ready: true } },
  };
}

// Existence seam: only managed python + worker paths "exist".
function existsFor(files: string[]): (p: string) => boolean {
  const set = new Set(files.map((f) => f.replace(/\\/g, '/')));
  return (p: string) => set.has(p.replace(/\\/g, '/'));
}

function managedFiles(root: string, modelKey: string, worker: string, runtime: string): string[] {
  return [
    path.join(root, 'runtimes', 'python', runtime, ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'])),
    path.join(root, 'models', modelKey, 'live', worker),
  ];
}

const PARAKEET_FILES = managedFiles(ROOT, 'parakeet-tdt-0-6b-v3', 'parakeet_worker.py', 'parakeet-v1');
const OMNI_FILES = managedFiles(ROOT, 'omnivoice-bg', 'omnivoice_worker.py', 'omnivoice-bg-v1');
const BGTTS_FILES = managedFiles(ROOT, 'bgtts-38m-v2', 'bgtts_worker.py', 'bgtts-38m-v2-v1');

// ---- resolution ---------------------------------------------------------------

test('READY selected parakeet resolves an stt target', () => {
  const target = resolveRuntimeTarget({ kind: 'stt', hardware: HW, state: readyState('parakeet-tdt-0.6b-v3', 'stt'), managedRoot: ROOT, exists: existsFor(PARAKEET_FILES) });
  assert.equal(target.target, 'stt-parakeet');
  assert.ok(target.pythonExecutable.includes('parakeet-v1'));
  assert.ok(target.entrypoint.endsWith('parakeet_worker.py'));
  assert.ok(target.modelEnv.HF_HUB_CACHE.includes('managed-e2'));
  assert.ok(!('HF_HOME' in target.modelEnv));
  assert.ok(!('HF_TOKEN' in target.modelEnv));
  assert.equal(target.extraEnv['PARAKEET_DEVICE'], 'cuda');
});

test('READY selected omnivoice/bgtts resolve tts targets', () => {
  const omni = resolveRuntimeTarget({ kind: 'tts', hardware: HW, state: readyState('omnivoice-bg'), managedRoot: ROOT, exists: existsFor(OMNI_FILES) });
  assert.equal(omni.target, 'tts-omnivoice');
  const bgtts = resolveRuntimeTarget({ kind: 'tts', hardware: HW, state: readyState('bgtts-38m-v2'), managedRoot: ROOT, exists: existsFor(BGTTS_FILES) });
  assert.equal(bgtts.target, 'tts-bgtts');
});

test('resolution rejects non-ready lifecycle states distinctly', () => {
  const mk = (installed: boolean, configured: boolean, ready: boolean): LocalModelStateFile => {
    const base = defaultStateFile();
    return { version: base.version, selections: { ...base.selections, tts: { mode: 'manual', model_id: 'omnivoice-bg' } }, models: { 'omnivoice-bg': { model_id: 'omnivoice-bg', installed, configured, ready } } };
  };
  const ex = { exists: existsFor(OMNI_FILES) };
  assert.throws(() => resolveRuntimeTarget({ kind: 'tts', hardware: HW, state: mk(false, false, false), managedRoot: ROOT, ...ex }), (e: unknown) => codeOf(e) === 'TOOL_CAPABILITY_UNAVAILABLE');
  assert.throws(() => resolveRuntimeTarget({ kind: 'tts', hardware: HW, state: mk(true, false, false), managedRoot: ROOT, ...ex }), (e: unknown) => codeOf(e) === 'TOOL_CAPABILITY_UNAVAILABLE');
  assert.throws(() => resolveRuntimeTarget({ kind: 'tts', hardware: HW, state: mk(true, true, false), managedRoot: ROOT, ...ex }), (e: unknown) => codeOf(e) === 'TOOL_CAPABILITY_UNAVAILABLE');
});

test('resolution rejects missing descriptor, unknown model, missing artifacts', () => {
  // Missing descriptor: selection with no lifecycle entry at all.
  assert.throws(
    () => resolveRuntimeTarget({ kind: 'tts', hardware: HW, state: defaultStateFile(), managedRoot: ROOT, exists: existsFor([]) }),
    (e: unknown) => codeOf(e) === 'TOOL_CAPABILITY_UNAVAILABLE',
  );
  // Unknown model id via catalog override.
  const ghost = resolveRuntimeTargetSafe();
  assert.equal(ghost, 'none-or-throws');
  // Missing runtime artifacts despite ready=true.
  assert.throws(
    () => resolveRuntimeTarget({ kind: 'tts', hardware: HW, state: readyState('omnivoice-bg'), managedRoot: ROOT, exists: existsFor([]) }),
    (e: unknown) => codeOf(e) === 'TOOL_CAPABILITY_UNAVAILABLE',
  );
});

function resolveRuntimeTargetSafe(): string {
  try {
    resolveRuntimeTarget({ kind: 'tts', hardware: HW, state: readyState('ghost-model'), managedRoot: ROOT, exists: existsFor([]) });
    return 'resolved';
  } catch {
    return 'none-or-throws';
  }
}

test('manual selection is respected; incompatible hardware blocks', () => {
  const arm: HardwareProfile = linuxArm64CpuOnly();
  assert.throws(
    () => resolveRuntimeTarget({ kind: 'tts', hardware: arm, state: readyState('omnivoice-bg'), managedRoot: ROOT, exists: existsFor(OMNI_FILES) }),
    (e: unknown) => codeOf(e) === 'TOOL_CAPABILITY_UNAVAILABLE',
  );
});

test('managed cache env stays inside the managed root', () => {
  const target = resolveRuntimeTarget({ kind: 'tts', hardware: HW, state: readyState('omnivoice-bg'), managedRoot: ROOT, exists: existsFor(OMNI_FILES) });
  for (const value of Object.values(target.modelEnv)) {
    assert.ok(value.startsWith(ROOT), value);
  }
});

// ---- managed provider + factory plumbing -------------------------------------------------

test('factory maps READY selections to concrete providers', () => {
  const stt = createLocalSttProvider({ hardware: HW, state: readyState('parakeet-tdt-0.6b-v3', 'stt'), managedRoot: ROOT, exists: existsFor(PARAKEET_FILES) });
  assert.equal(stt.modelId, 'parakeet-tdt-0.6b-v3');
  assert.equal(stt.provider.id(), 'parakeet-stt');
  const tts = createLocalTtsProvider({ hardware: HW, state: readyState('bgtts-38m-v2'), managedRoot: ROOT, exists: existsFor(BGTTS_FILES) });
  assert.equal(tts.modelId, 'bgtts-38m-v2');
  assert.equal(tts.provider.id(), 'bgtts-tts');
  const omni = createLocalTtsProvider({ hardware: HW, state: readyState('omnivoice-bg'), managedRoot: ROOT, exists: existsFor(OMNI_FILES) });
  assert.equal(omni.provider.id(), 'omnivoice-tts');
});

// ---- managed parakeet provider ---------------------------------------------------------------

test('managed parakeet provider builds from the resolved target', () => {
  const target = resolveRuntimeTarget({ kind: 'stt', hardware: HW, state: readyState('parakeet-tdt-0.6b-v3', 'stt'), managedRoot: ROOT, exists: existsFor(PARAKEET_FILES) });
  const provider = new ManagedParakeetSttProvider(target);
  assert.equal(provider.id(), 'parakeet-stt');
  assert.equal(provider.describe().model.id, 'parakeet-tdt-0.6b-v3');
  assert.ok(provider.healthy);
});

test('managed parakeet rejects the wrong target kind', () => {
  const target = resolveRuntimeTarget({ kind: 'tts', hardware: HW, state: readyState('omnivoice-bg'), managedRoot: ROOT, exists: existsFor(OMNI_FILES) });
  assert.throws(() => new ManagedParakeetSttProvider(target as never));
});

// ---- managed TTS providers (protocol unit level) ----------------------------------------------

test('managed TTS providers carry the right identities', () => {
  const omni = resolveRuntimeTarget({ kind: 'tts', hardware: HW, state: readyState('omnivoice-bg'), managedRoot: ROOT, exists: existsFor(OMNI_FILES) });
  const o = makeOmniVoiceTtsProvider(omni);
  assert.equal(o.id(), 'omnivoice-tts');
  const bg = resolveRuntimeTarget({ kind: 'tts', hardware: HW, state: readyState('bgtts-38m-v2'), managedRoot: ROOT, exists: existsFor(BGTTS_FILES) });
  const b = makeBgTtsProvider(bg);
  assert.equal(b.id(), 'bgtts-tts');
  assert.throws(() => makeOmniVoiceTtsProvider(bg as never));
});

test('managed TTS rejects unbounded text and cleans output', async () => {
  const bg = resolveRuntimeTarget({ kind: 'tts', hardware: HW, state: readyState('bgtts-38m-v2'), managedRoot: ROOT, exists: existsFor(BGTTS_FILES) });
  const provider = makeBgTtsProvider(bg);
  await assert.rejects(async () => { for await (const _c of provider.synthesizeStream({ synthesisId: 'x'.repeat(70), text: '', voice: 'v', sampleRateHz: 24000 })) { void _c; } });
  await assert.rejects(async () => { for await (const _c of provider.synthesizeStream({ synthesisId: 's1', text: 'x'.repeat(5000), voice: 'v', sampleRateHz: 24000 })) { void _c; } });
});


// ---- non-ASCII wire regression (bgtts cp1252 death) ---------------------------------------------

function patchSpawn(responder: (written: Buffer[], child: EventEmitter) => void): { restore: () => void; spawns: number } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require('node:child_process') as typeof import('node:child_process');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const stream = require('node:stream') as typeof import('node:stream');
  const orig = cp.spawn;
  let spawns = 0;
  (cp as unknown as Record<string, unknown>).spawn = (...args: unknown[]) => {
    spawns += 1;
    const child = new EventEmitter() as unknown as ChildProcess & { stdinWritten: Buffer[] };
    const written: Buffer[] = [];
    (child as unknown as { stdinWritten: Buffer[] }).stdinWritten = written;
    (child as unknown as { exitCode: number | null }).exitCode = null;
    (child as unknown as { signalCode: null }).signalCode = null;
    (child as unknown as { pid: number }).pid = 9999 + spawns;
    const stdin = new EventEmitter() as unknown as NonNullable<ChildProcess['stdin']>;
    (stdin as unknown as { destroyed: boolean }).destroyed = false;
    (stdin as unknown as { write: (d: unknown, cb?: (e?: Error) => void) => void }).write = (d: unknown, cb?: (e?: Error) => void) => {
      written.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8'));
      if (cb) setImmediate(() => cb());
      setImmediate(() => responder(written, child as unknown as EventEmitter));
      return true;
    };
    (stdin as unknown as { end: () => void }).end = () => {};
    (child as unknown as { stdin: unknown }).stdin = stdin;
    // Real PassThrough streams: readline.createInterface needs a readable.
    (child as unknown as { stdout: unknown }).stdout = new stream.PassThrough();
    (child as unknown as { stderr: unknown }).stderr = new stream.PassThrough();
    child.kill = (() => true) as ChildProcess['kill'];
    void args;
    return child;
  };
  return { restore: () => { (cp as unknown as Record<string, unknown>).spawn = orig; }, get spawns() { return spawns; } };
}

function emitStdoutLine(child: EventEmitter, line: string): void {
  const stdout = (child as unknown as { stdout: { write: (d: Buffer) => void } }).stdout;
  stdout.write(Buffer.from(line + '\n', 'utf8'));
}

test('non-ASCII synthesis text crosses the wire as exact UTF-8 bytes', async () => {
  const bg = resolveRuntimeTarget({ kind: 'tts', hardware: HW, state: readyState('bgtts-38m-v2'), managedRoot: ROOT, exists: existsFor(BGTTS_FILES) });
  const provider = makeBgTtsProvider(bg, { startupTimeoutMs: 1000, synthTimeoutMs: 2000, writeFile: () => {}, readFile: () => Buffer.from([0, 1, 2, 3]), removeFile: () => {} });
  const text = 'Здравей, това е кратка техническа проверка.';
  let captured = Buffer.alloc(0);
  const patch = patchSpawn((written, child) => {
    captured = Buffer.concat(written);
    const req = JSON.parse(captured.toString('utf8')) as { id: string };
    // Canned worker: echo a success envelope with a fake wav path (the
    // injected readFile supplies pcm bytes; output path is untouched).
    emitStdoutLine(child, JSON.stringify({ id: req.id, ok: true, audio_path: '/fake/out.wav', sample_rate_hz: 24000, bytes: 4 }));
  });
  try {
    const chunks: Array<{ data: Uint8Array }> = [];
    for await (const c of provider.synthesizeStream({ synthesisId: 'cyr1', text, voice: 'v', sampleRateHz: 24000 })) chunks.push(c);
    assert.ok(chunks.length > 0);
    // Exact UTF-8 wire bytes: Cyrillic decodes losslessly (cp1252 would
    // mojibake or throw on the worker side).
    const decoded = JSON.parse(captured.toString('utf8')) as { text: string; id: string };
    assert.equal(decoded.text, text);
    assert.ok(/^tts-\d+$/.test(decoded.id));
    // Request id correlates with the worker response (single chunk set).
    assert.equal(patch.spawns, 1);
    await provider.shutdown();
  } finally {
    patch.restore();
  }
});

test('worker exit carries code, signal, and bounded stderr evidence', async () => {
  const bg = resolveRuntimeTarget({ kind: 'tts', hardware: HW, state: readyState('bgtts-38m-v2'), managedRoot: ROOT, exists: existsFor(BGTTS_FILES) });
  const provider = makeBgTtsProvider(bg, { startupTimeoutMs: 1000, synthTimeoutMs: 2000, writeFile: () => {}, readFile: () => Buffer.alloc(0), removeFile: () => {} });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require('node:child_process') as typeof import('node:child_process');
  const orig = cp.spawn;
  (cp as unknown as Record<string, unknown>).spawn = () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    (child as unknown as { exitCode: number | null }).exitCode = null;
    (child as unknown as { signalCode: null }).signalCode = null;
    (child as unknown as { pid: number }).pid = 4243;
    const stdin = new EventEmitter() as unknown as NonNullable<ChildProcess['stdin']>;
    (stdin as unknown as { destroyed: boolean }).destroyed = false;
    (stdin as unknown as { write: (d: unknown, cb?: (e?: Error) => void) => void }).write = (_d: unknown, cb?: (e?: Error) => void) => {
      if (cb) setImmediate(() => cb());
      setImmediate(() => {
        (child as unknown as { fakeErr: { write: (d: Buffer) => void } }).fakeErr.write(Buffer.from('bgtts_worker: synth-failed ValueError'));
        (child as unknown as { exitCode: number | null }).exitCode = 1;
        child.emit('close', 1, null);
      });
      return true;
    };
    (stdin as unknown as { end: () => void }).end = () => {};
    (child as unknown as { stdin: unknown }).stdin = stdin;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const stream2 = require('node:stream') as typeof import('node:stream');
    const fakeErr = new stream2.PassThrough();
    (child as unknown as { stdout: unknown }).stdout = new stream2.PassThrough();
    (child as unknown as { stderr: unknown }).stderr = fakeErr;
    (child as unknown as { fakeErr: unknown }).fakeErr = fakeErr;
    child.kill = (() => true) as ChildProcess['kill'];
    return child;
  };
  try {
    await assert.rejects(
      (async () => { for await (const _c of provider.synthesizeStream({ synthesisId: 'e1', text: 'hi', voice: 'v', sampleRateHz: 24000 })) { void _c; } })(),
      (err: unknown) => {
        const msg = String((err as Error).message);
        return msg.includes('code=1') && msg.includes('bgtts_worker: synth-failed ValueError');
      },
    );
    const evidence = (provider as unknown as { stderrEvidence: () => string }).stderrEvidence();
    assert.ok(evidence.includes('bgtts_worker: synth-failed ValueError'));
  } finally {
    (cp as unknown as Record<string, unknown>).spawn = orig;
  }
});
// ---- lazy legs -------------------------------------------------------------------------

function scriptedStt(id: string, text: string): SttProvider {
  return {
    id: () => id,
    available: true,
    cancel: async () => {},
    transcribeStream: async function* () { yield { type: 'final' as const, text }; },
  };
}

function scriptedTts(id: string): TtsProvider {
  return {
    id: () => id,
    available: true,
    cancel: async () => {},
    synthesizeStream: async function* () { yield { synthesisId: 's', sequence: 0, timestamp_ms: 0, sample_rate_hz: 24000, channels: 1 as const, sample_format: 's16le' as const, duration_ms: 100, data: new Uint8Array([1, 2]), final: true as const }; },
  };
}

test('stable leg advertises the managed id from construction (no flip)', async () => {
  const state = readyState('parakeet-tdt-0.6b-v3', 'stt');
  const real = scriptedStt('parakeet-stt', 'hello');
  const fallback = scriptedStt('local-stt', 'fallback');
  let calls = 0;
  const lazy = new LazyLocalSttProvider(async () => { calls += 1; return real; }, fallback, { kind: 'stt', state });
  assert.equal(lazy.id(), 'parakeet-stt');
  assert.equal(lazy.available, true);
  const texts: string[] = [];
  for await (const e of lazy.transcribeStream((async function* () {})(), { utteranceId: 'u1', maxTranscriptChars: 100 })) {
    if (e.type === 'final') texts.push(e.text);
  }
  assert.deepEqual(texts, ['hello']);
  assert.equal(lazy.id(), 'parakeet-stt');
  assert.equal(lazy.upgraded, true);
  for await (const e of lazy.transcribeStream((async function* () {})(), { utteranceId: 'u2', maxTranscriptChars: 100 })) {
    if (e.type === 'final') texts.push(e.text);
  }
  assert.equal(calls, 1);
  assert.deepEqual(texts, ['hello', 'hello']);
});

test('stable leg fails closed when async verification mismatches', async () => {
  const state = readyState('parakeet-tdt-0.6b-v3', 'stt');
  const wrong = scriptedStt('local-stt', 'wrong');
  const fallback = scriptedStt('local-stt', 'fallback');
  const lazy = new LazyLocalSttProvider(async () => wrong, fallback, { kind: 'stt', state });
  assert.equal(lazy.id(), 'parakeet-stt');
  const events: string[] = [];
  for await (const e of lazy.transcribeStream((async function* () {})(), { utteranceId: 'u1', maxTranscriptChars: 100 })) {
    events.push(e.type);
  }
  assert.deepEqual(events, ['error']);
  assert.equal(lazy.upgraded, false);
  assert.equal(lazy.id(), 'parakeet-stt');
});

test('leg without READY selection is pure fallback (resolver never consulted)', async () => {
  let calls = 0;
  const fallback = scriptedStt('local-stt', 'fb');
  const lazy = new LazyLocalSttProvider(async () => { calls += 1; return scriptedStt('parakeet-stt', 'x'); }, fallback, { kind: 'stt', state: defaultStateFile() });
  assert.equal(lazy.id(), 'local-stt');
  assert.equal(lazy.available, fallback.available);
  const texts: string[] = [];
  for await (const e of lazy.transcribeStream((async function* () {})(), { utteranceId: 'u1', maxTranscriptChars: 100 })) {
    if (e.type === 'final') texts.push(e.text);
  }
  assert.deepEqual(texts, ['fb']);
  assert.equal(calls, 0);
  assert.equal(lazy.id(), 'local-stt');
});

test('lazy STT falls back when resolution yields null', async () => {
  const fallback = scriptedStt('local-stt', 'fb');
  const lazy = new LazyLocalSttProvider(async () => null, fallback);
  const texts: string[] = [];
  for await (const e of lazy.transcribeStream((async function* () {})(), { utteranceId: 'u1', maxTranscriptChars: 100 })) {
    if (e.type === 'final') texts.push(e.text);
  }
  assert.deepEqual(texts, ['fb']);
  assert.equal(lazy.upgraded, false);
  assert.equal(lazy.id(), 'local-stt');
});

test('stable TTS leg advertises the managed id and verifies strictly', async () => {
  const state = readyState('omnivoice-bg');
  const real = scriptedTts('omnivoice-tts');
  const fallback = scriptedTts('local-tts');
  let calls = 0;
  const lazy = new LazyLocalTtsProvider(async () => { calls += 1; return real; }, fallback, { kind: 'tts', state });
  assert.equal(lazy.id(), 'omnivoice-tts');
  assert.equal(lazy.available, true);
  let chunks = 0;
  for await (const _c of lazy.synthesizeStream({ synthesisId: 's1', text: 'hi', voice: 'v', sampleRateHz: 24000 })) { chunks += 1; void _c; }
  assert.equal(chunks, 1);
  assert.equal(lazy.id(), 'omnivoice-tts');
  assert.equal(calls, 1);
  // Second synthesis reuses the verified provider without re-resolving.
  for await (const _c of lazy.synthesizeStream({ synthesisId: 's2', text: 'hi', voice: 'v', sampleRateHz: 24000 })) { chunks += 1; void _c; }
  assert.equal(calls, 1);
  assert.equal(chunks, 2);
});

test('peekSelectedModelId covers override, manual, auto, and none', () => {
  assert.equal(peekSelectedModelId({ kind: 'tts', state: readyState('omnivoice-bg') }), 'omnivoice-bg');
  assert.equal(peekSelectedModelId({ kind: 'tts', state: defaultStateFile() }), null);
  assert.equal(peekSelectedModelId({ kind: 'tts', state: readyState('omnivoice-bg'), env: { ARTHUR_LOCAL_TTS_MODEL: 'bgtts-38m-v2' } }), null);
  const withBgtts = readyState('bgtts-38m-v2');
  assert.equal(peekSelectedModelId({ kind: 'tts', state: withBgtts, env: { ARTHUR_LOCAL_TTS_MODEL: 'bgtts-38m-v2' } }), 'bgtts-38m-v2');
});


// ---- shutdown lifecycle --------------------------------------------------------------

function fakeChild(opts: { exitOnStdinEnd: boolean; exitCode?: number | null }): ChildProcess & { stdinEnded: boolean; killed: boolean; closeEmitted: boolean } {
  const child = new EventEmitter() as unknown as ChildProcess & { stdinEnded: boolean; killed: boolean; closeEmitted: boolean };
  child.stdinEnded = false;
  child.killed = false;
  child.closeEmitted = false;
  (child as unknown as { exitCode: number | null }).exitCode = null;
  (child as unknown as { signalCode: NodeJS.Signals | null }).signalCode = null;
  (child as unknown as { pid: number }).pid = 4242;
  const stdin = new EventEmitter() as unknown as NonNullable<ChildProcess['stdin']>;
  (stdin as unknown as { end: () => void }).end = () => {
    child.stdinEnded = true;
    if (opts.exitOnStdinEnd) {
      setImmediate(() => {
        (child as unknown as { exitCode: number | null }).exitCode = opts.exitCode ?? 0;
        child.closeEmitted = true;
        child.emit('close', opts.exitCode ?? 0, null);
      });
    }
  };
  (child as unknown as { stdin: unknown }).stdin = stdin;
  child.kill = ((_sig?: unknown) => {
    child.killed = true;
    setImmediate(() => {
      (child as unknown as { exitCode: number | null }).exitCode = -1;
      child.closeEmitted = true;
      child.emit('close', null, 'SIGTERM');
    });
    return true;
  }) as ChildProcess['kill'];
  return child;
}

test('shutdownChildGracefully closes stdin and awaits terminal close', async () => {
  const { shutdownChildGracefully } = await import('../../src/voice/process_util');
  const child = fakeChild({ exitOnStdinEnd: true });
  await shutdownChildGracefully(child, 2000, 1000);
  assert.equal(child.stdinEnded, true);
  assert.equal(child.killed, false);
  assert.equal(child.closeEmitted, true);
});

test('shutdownChildGracefully escalates when stdin close is ignored', async () => {
  const { shutdownChildGracefully } = await import('../../src/voice/process_util');
  const child = fakeChild({ exitOnStdinEnd: false });
  const t0 = Date.now();
  await shutdownChildGracefully(child, 50, 50);
  assert.equal(child.stdinEnded, true);
  assert.equal(child.killed, true);
  assert.equal(child.closeEmitted, true);
  assert.ok(Date.now() - t0 < 5000);
});

test('managed TTS shutdown awaits worker termination (no orphan window)', async () => {
  const bg = resolveRuntimeTarget({ kind: 'tts', hardware: HW, state: readyState('bgtts-38m-v2'), managedRoot: ROOT, exists: existsFor(BGTTS_FILES) });
  const provider = makeBgTtsProvider(bg);
  const child = fakeChild({ exitOnStdinEnd: true });
  (provider as unknown as Record<string, unknown>).child = child;
  await provider.shutdown();
  assert.equal(child.stdinEnded, true);
  assert.equal(child.closeEmitted, true);
  assert.equal(provider.healthy, false);
  assert.equal(provider.available, false);
});

test('managed providers expose their resolved targets', () => {
  const bg = resolveRuntimeTarget({ kind: 'tts', hardware: HW, state: readyState('bgtts-38m-v2'), managedRoot: ROOT, exists: existsFor(BGTTS_FILES) });
  const provider = makeBgTtsProvider(bg) as ManagedLocalTtsProvider;
  assert.equal(provider.describe().model.id, 'bgtts-38m-v2');
  assert.ok(provider.healthy);
});
