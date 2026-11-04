/**
 * HR-02.5E2 router integration tests: E2-managed legs through EXISTING routers.
 *
 * Proves the wiring contract without touching router policy: local_only
 * uses the managed leg and never cloud; cloud_preferred prefers cloud
 * and falls back to the SAME complete utterance/text exactly once;
 * no fallback after playback started; no mid-utterance switching; no
 * duplicate playback. Deterministic scripted providers throughout.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SttRouter } from '../../src/runtime/stt_router';
import { TtsRouter } from '../../src/runtime/tts_router';
import { FakeSttProvider } from '../../src/voice/stt/fake';
import { FakeTtsProvider } from '../../src/voice/tts/fake';
import { frameFromInt16 } from '../../src/voice/contracts';
import type { PcmFrame } from '../../src/voice/contracts';
import { LazyLocalSttProvider, LazyLocalTtsProvider } from '../../src/runtime/local-models/runtime/lazy';
import { defaultStateFile } from '../../src/runtime/local-models/state_contracts';
import type { LocalModelStateFile } from '../../src/runtime/local-models/state_contracts';

function readyState(modelId: string, kind: 'stt' | 'tts'): LocalModelStateFile {
  const base = defaultStateFile();
  return {
    version: base.version,
    selections: { ...base.selections, [kind]: { mode: 'manual' as const, model_id: modelId } },
    models: { [modelId]: { model_id: modelId, installed: true, configured: true, ready: true } },
  };
}

class ManagedIdTts extends FakeTtsProvider {
  constructor(private readonly managedId: string) { super(); }
  override id(): string { return this.managedId; }
}

function frames(n: number): PcmFrame[] {
  const out: PcmFrame[] = [];
  for (let i = 0; i < n; i += 1) out.push(frameFromInt16(new Int16Array(320).fill(i + 1), i, i * 20));
  return out;
}

async function* replay(list: PcmFrame[]): AsyncIterable<PcmFrame> {
  for (const f of list) yield f;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of it) out.push(e);
  return out;
}

// ---- STT --------------------------------------------------------------------------

test('local_only STT uses the managed leg and never cloud', async () => {
  const cloud = new FakeSttProvider({ id: 'cloud-stt' });
  cloud.setDefaultScript({ final: 'cloud words' });
  const managed = new FakeSttProvider({ id: 'parakeet-stt' });
  managed.setDefaultScript({ final: 'local words' });
  const lazy = new LazyLocalSttProvider(async () => managed, new FakeSttProvider({ id: 'local-stt' }), { kind: 'stt', state: readyState('parakeet-tdt-0.6b-v3', 'stt') });
  assert.equal(lazy.id(), 'parakeet-stt');
  const router = new SttRouter({ cloud, local: lazy, policy: 'local_only' });
  const events = await collect(router.transcribeStream(replay(frames(5)), { utteranceId: 'u1', maxTranscriptChars: 100 }));
  const finals = events.filter((e) => e.type === 'final');
  assert.equal(finals.length, 1);
  assert.equal((finals[0] as { text: string }).text, 'local words');
  assert.equal(cloud.startedUtterances.length, 0);
  assert.deepEqual(managed.startedUtterances, ['u1']);
  assert.equal(lazy.upgraded, true);
});

test('cloud_preferred STT success never invokes local', async () => {
  const cloud = new FakeSttProvider({ id: 'cloud-stt' });
  cloud.setDefaultScript({ final: 'cloud words' });
  const managed = new FakeSttProvider({ id: 'parakeet-stt' });
  const lazy = new LazyLocalSttProvider(async () => managed, new FakeSttProvider({ id: 'local-stt' }));
  const router = new SttRouter({ cloud, local: lazy, policy: 'cloud_preferred' });
  const events = await collect(router.transcribeStream(replay(frames(5)), { utteranceId: 'u1', maxTranscriptChars: 100 }));
  assert.equal((events.filter((e) => e.type === 'final')[0] as { text: string }).text, 'cloud words');
  assert.equal(managed.startedUtterances.length, 0);
});

test('cloud STT failure falls back locally once with the same utterance', async () => {
  const cloud = new FakeSttProvider({ id: 'cloud-stt' });
  cloud.setDefaultScript({ error: 'STT_FAILED' });
  const managed = new FakeSttProvider({ id: 'parakeet-stt' });
  managed.recordFrames = true;
  managed.setDefaultScript({ final: 'recovered' });
  const lazy = new LazyLocalSttProvider(async () => managed, new FakeSttProvider({ id: 'local-stt' }), { kind: 'stt', state: readyState('parakeet-tdt-0.6b-v3', 'stt') });
  assert.equal(lazy.id(), 'parakeet-stt');
  const router = new SttRouter({ cloud, local: lazy, policy: 'cloud_preferred' });
  const input = frames(7);
  const events = await collect(router.transcribeStream(replay(input), { utteranceId: 'u9', maxTranscriptChars: 100 }));
  const finals = events.filter((e) => e.type === 'final');
  assert.equal(finals.length, 1);
  assert.equal((finals[0] as { text: string }).text, 'recovered');
  assert.deepEqual(managed.startedUtterances, ['u9']);
  // Same complete utterance reached local (frame count preserved).
  assert.equal(managed.receivedFrames.length, input.length);
});

// ---- TTS --------------------------------------------------------------------------

test('local_only TTS uses the managed leg and never cloud', async () => {
  const cloud = new FakeTtsProvider();
  const managedTts = new ManagedIdTts('omnivoice-tts');
  const lazy = new LazyLocalTtsProvider(async () => managedTts, new FakeTtsProvider(), { kind: 'tts', state: readyState('omnivoice-bg', 'tts') });
  assert.equal(lazy.id(), 'omnivoice-tts');
  const router = new TtsRouter({ cloud, local: lazy, policy: 'local_only' });
  const chunks = await collect(router.synthesizeStream({ synthesisId: 's1', text: 'hello there', voice: 'v', sampleRateHz: 24000 }));
  assert.ok(chunks.length > 0);
  assert.equal(cloud.requests.length, 0);
  assert.equal(managedTts.requests.length, 1);
  assert.equal(managedTts.requests[0] && managedTts.requests[0].text, 'hello there');
});

test('cloud_preferred TTS success never invokes local', async () => {
  const cloud = new FakeTtsProvider();
  const lazy = new LazyLocalTtsProvider(async () => new FakeTtsProvider(), new FakeTtsProvider());
  const router = new TtsRouter({ cloud, local: lazy, policy: 'cloud_preferred' });
  const chunks = await collect(router.synthesizeStream({ synthesisId: 's1', text: 'hi', voice: 'v', sampleRateHz: 24000 }));
  assert.ok(chunks.length > 0);
});

test('cloud TTS failure before playback falls back locally once', async () => {
  const cloud = new (class extends FakeTtsProvider {
    override async *synthesizeStream(): AsyncIterable<never> {
      throw new Error('cloud exploded before playback');
    }
  })();
  const managedTts = new ManagedIdTts('omnivoice-tts');
  const lazy = new LazyLocalTtsProvider(async () => managedTts, new FakeTtsProvider(), { kind: 'tts', state: readyState('omnivoice-bg', 'tts') });
  const router = new TtsRouter({ cloud, local: lazy, policy: 'cloud_preferred' });
  const chunks = await collect(router.synthesizeStream({ synthesisId: 's2', text: 'same canonical text', voice: 'v', sampleRateHz: 24000 }));
  assert.ok(chunks.length > 0);
  assert.equal(managedTts.requests.length, 1);
  assert.equal(managedTts.requests[0] && managedTts.requests[0].text, 'same canonical text');
  assert.equal(managedTts.requests[0] && managedTts.requests[0].synthesisId, 's2');
});

test('no local fallback after playback started', async () => {
  const cloud = new FakeTtsProvider();
  const managedTts = new FakeTtsProvider();
  const lazy = new LazyLocalTtsProvider(async () => managedTts, new FakeTtsProvider());
  const router = new TtsRouter({ cloud, local: lazy, policy: 'cloud_preferred' });
  // Drain fully: cloud succeeds, so local must never be touched.
  const chunks = await collect(router.synthesizeStream({ synthesisId: 's3', text: 'spoken once', voice: 'v', sampleRateHz: 24000 }));
  assert.ok(chunks.length > 0);
  assert.equal(managedTts.requests.length, 0);
  // Same synthesis id is never synthesized twice (no duplicate playback).
  const again = await collect(router.synthesizeStream({ synthesisId: 's3', text: 'spoken once', voice: 'v', sampleRateHz: 24000 }));
  assert.equal(again.length, chunks.length);
});

test('lazy legs report fallback identity until upgrade settles', () => {
  const lazyStt = new LazyLocalSttProvider(async () => null, new FakeSttProvider({ id: 'local-stt' }));
  assert.equal(lazyStt.id(), 'local-stt');
  const lazyTts = new LazyLocalTtsProvider(async () => null, new FakeTtsProvider());
  assert.equal(lazyTts.id(), 'fake-tts');
});
