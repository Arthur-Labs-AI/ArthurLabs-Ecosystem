import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkOpenAiSttReadiness, checkOpenAiTtsReadiness } from '../../src/providers/openai_voice_readiness';
import { readinessContainsSecret } from '../../src/providers/readiness';
import { silenceFrame } from '../../src/voice/contracts';

const SECRET = 'sk-openai-voice-secret';

function sttOk(): typeof fetch {
  const fn = (async () => new Response(JSON.stringify({ text: 'hello there' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  return fn;
}

function sttEmptyInvalid(): typeof fetch {
  const fn = (async () => new Response(JSON.stringify({ nope: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  return fn;
}

function httpStatus(status: number): typeof fetch {
  const fn = (async () => new Response('boom', { status })) as unknown as typeof fetch;
  return fn;
}

function ttsStream(bytes: Buffer): typeof fetch {
  const fn = (async () => {
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } });
    return new Response(stream as unknown as never, { status: 200 });
  }) as unknown as typeof fetch;
  return fn;
}

test('D1: STT ready on structurally valid final (quality not judged)', async () => {
  const result = await checkOpenAiSttReadiness({ apiKey: SECRET, model: 'gpt-4o-transcribe' }, { fetchFn: sttOk() });
  assert.equal(result.ready, true);
  assert.equal(result.status, 'ready');
  assert.equal(readinessContainsSecret(result, [SECRET]), false);
});

test('D1b: STT silence-hallucinated text is still READY when structurally valid', async () => {
  const fn = (async () => new Response(JSON.stringify({ text: 'thank you for watching' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const result = await checkOpenAiSttReadiness({ apiKey: SECRET, model: 'gpt-4o-transcribe' }, { fetchFn: fn });
  assert.equal(result.ready, true);
});

test('D2: STT 401 maps to auth_failed', async () => {
  const result = await checkOpenAiSttReadiness({ apiKey: SECRET, model: 'gpt-4o-transcribe' }, { fetchFn: httpStatus(401) });
  assert.equal(result.status, 'auth_failed');
  assert.equal(readinessContainsSecret(result, [SECRET]), false);
});

test('D3: STT 500 maps to unavailable', async () => {
  const result = await checkOpenAiSttReadiness({ apiKey: SECRET, model: 'gpt-4o-transcribe' }, { fetchFn: httpStatus(500) });
  assert.equal(result.status, 'unavailable');
});

test('D4: STT structurally invalid response maps to failed', async () => {
  const result = await checkOpenAiSttReadiness({ apiKey: SECRET, model: 'gpt-4o-transcribe' }, { fetchFn: sttEmptyInvalid() });
  assert.equal(result.ready, false);
  assert.equal(result.status, 'unavailable');
});

test('D5: STT missing credential short-circuits without network', async () => {
  let called = false;
  const spy = (async () => { called = true; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  const result = await checkOpenAiSttReadiness({ apiKey: '', model: 'gpt-4o-transcribe' }, { fetchFn: spy });
  assert.equal(result.status, 'not_configured');
  assert.equal(called, false);
});

test('E1: TTS ready on non-empty audio (discarded, not persisted)', async () => {
  const pcm = Buffer.alloc(4800, 7);
  const result = await checkOpenAiTtsReadiness({ apiKey: SECRET, model: 'gpt-4o-mini-tts', voice: 'alloy' }, { fetchFn: ttsStream(pcm) });
  assert.equal(result.ready, true);
  assert.equal(result.status, 'ready');
  assert.equal(readinessContainsSecret(result, [SECRET]), false);
});

test('E2: TTS empty audio maps to failed/empty_result', async () => {
  const fn = (async () => {
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    return new Response(stream as unknown as never, { status: 200 });
  }) as unknown as typeof fetch;
  const result = await checkOpenAiTtsReadiness({ apiKey: SECRET, model: 'gpt-4o-mini-tts', voice: 'alloy' }, { fetchFn: fn });
  assert.equal(result.ready, false);
  assert.equal(result.diagnostics[0]?.category, 'empty_result');
});

test('E3: TTS 401 maps to auth_failed, 500 to unavailable', async () => {
  const auth = await checkOpenAiTtsReadiness({ apiKey: SECRET, model: 'gpt-4o-mini-tts', voice: 'alloy' }, { fetchFn: httpStatus(401) });
  assert.equal(auth.status, 'auth_failed');
  const down = await checkOpenAiTtsReadiness({ apiKey: SECRET, model: 'gpt-4o-mini-tts', voice: 'alloy' }, { fetchFn: httpStatus(500) });
  assert.equal(down.status, 'unavailable');
});

test('E4: TTS invalid model id fails closed as invalid_config without network', async () => {
  let called = false;
  const spy = (async () => { called = true; return new Response('x', { status: 200 }); }) as unknown as typeof fetch;
  const result = await checkOpenAiTtsReadiness({ apiKey: SECRET, model: 'gpt-realtime-nope', voice: 'alloy' }, { fetchFn: spy });
  assert.equal(result.status, 'invalid_config');
  assert.equal(called, false);
});

test('E5: silence fixture frame exists (deterministic STT input)', () => {
  const frame = silenceFrame(0, 0);
  assert.equal(frame.sample_rate_hz, 16000);
  assert.ok(frame.data.byteLength > 0);
});
/*MORE*/
