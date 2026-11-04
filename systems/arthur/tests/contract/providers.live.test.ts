import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkDeepSeekReadiness } from '../../src/providers/deepseek_readiness';
import { checkOpenAiSttReadiness, checkOpenAiTtsReadiness } from '../../src/providers/openai_voice_readiness';

/**
 * Opt-in live provider acceptance (FRS-02 §17). Skipped unless explicitly
 * enabled with credentials present. Never part of the normal suite.
 *
 * DeepSeek live:
 *   ARTHUR_LIVE_DEEPSEEK=1 npm run build:test
 *   ARTHUR_LIVE_DEEPSEEK=1 node --test dist/tests/contract/providers.live.test.js
 *
 * OpenAI live (direct cloud STT + TTS, no local fallback):
 *   ARTHUR_LIVE_OPENAI=1 npm run build:test
 *   ARTHUR_LIVE_OPENAI=1 node --test dist/tests/contract/providers.live.test.js
 *
 * Both:
 *   ARTHUR_LIVE_DEEPSEEK=1 ARTHUR_LIVE_OPENAI=1 node --test dist/tests/contract/providers.live.test.js
 */

const LIVE_DEEPSEEK = process.env.ARTHUR_LIVE_DEEPSEEK === '1' && (process.env.DEEPSEEK_API_KEY ?? '') !== '';
const LIVE_OPENAI = process.env.ARTHUR_LIVE_OPENAI === '1' && (process.env.OPENAI_API_KEY ?? '') !== '';

test('live: DeepSeek minimal completion + tool-capable path', { skip: LIVE_DEEPSEEK ? false : 'set ARTHUR_LIVE_DEEPSEEK=1 with DEEPSEEK_API_KEY to run live acceptance' }, async () => {
  const result = await checkDeepSeekReadiness({
    apiKey: process.env.DEEPSEEK_API_KEY as string,
    model: process.env.ARTHUR_MODEL_NAME || 'deepseek-chat',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  });
  assert.equal(result.ready, true, 'live DeepSeek readiness: ' + JSON.stringify(result.diagnostics));
  assert.equal(result.status, 'ready');
});

test('live: OpenAI direct cloud STT readiness', { skip: LIVE_OPENAI ? false : 'set ARTHUR_LIVE_OPENAI=1 with OPENAI_API_KEY to run live acceptance' }, async () => {
  const result = await checkOpenAiSttReadiness({
    apiKey: process.env.OPENAI_API_KEY as string,
    model: process.env.ARTHUR_CLOUD_STT_MODEL || 'gpt-4o-transcribe',
  });
  assert.equal(result.ready, true, 'live OpenAI STT readiness: ' + JSON.stringify(result.diagnostics));
});

test('live: OpenAI direct cloud TTS readiness', { skip: LIVE_OPENAI ? false : 'set ARTHUR_LIVE_OPENAI=1 with OPENAI_API_KEY to run live acceptance' }, async () => {
  const result = await checkOpenAiTtsReadiness({
    apiKey: process.env.OPENAI_API_KEY as string,
    model: process.env.ARTHUR_CLOUD_TTS_MODEL || 'gpt-4o-mini-tts',
    voice: process.env.ARTHUR_CLOUD_TTS_VOICE || 'alloy',
  });
  assert.equal(result.ready, true, 'live OpenAI TTS readiness: ' + JSON.stringify(result.diagnostics));
});
/*MORE*/
