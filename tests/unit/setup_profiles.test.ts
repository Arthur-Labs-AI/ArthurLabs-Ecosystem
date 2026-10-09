import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dependenciesFor, dependenciesForCustom, deriveCurrentProfile, isSetupProfile } from '../../src/setup/profile';

test('A1: cloud voice needs DeepSeek + OpenAI + audio, no local models', () => {
  assert.deepEqual(dependenciesFor('cloud_voice'), { deepseekCredential: true, openaiCredential: true, audio: true, localSttModel: false, localTtsModel: false });
});

test('A2: local voice needs DeepSeek + audio + local STT/TTS, no OpenAI', () => {
  assert.deepEqual(dependenciesFor('local_voice'), { deepseekCredential: true, openaiCredential: false, audio: true, localSttModel: true, localTtsModel: true });
});

test('A3: text only needs DeepSeek only', () => {
  assert.deepEqual(dependenciesFor('text_only'), { deepseekCredential: true, openaiCredential: false, audio: false, localSttModel: false, localTtsModel: false });
});

test('A4: custom derives exact selected dependencies', () => {
  assert.deepEqual(dependenciesForCustom({ stt: 'local', tts: 'openai', audio: true }), { deepseekCredential: true, openaiCredential: true, audio: true, localSttModel: true, localTtsModel: false });
  assert.deepEqual(dependenciesForCustom({ stt: 'openai', tts: 'openai', audio: false }), { deepseekCredential: true, openaiCredential: true, audio: false, localSttModel: false, localTtsModel: false });
});

test('A5: profile vocabulary is closed; current-state derivation', () => {
  assert.equal(isSetupProfile('cloud_voice'), true);
  assert.equal(isSetupProfile('offline'), false);
  assert.equal(deriveCurrentProfile({ voiceEnabled: false, sttPolicy: 'cloud_preferred', ttsPolicy: 'cloud_preferred', audioConfigured: false }), 'text_only');
  assert.equal(deriveCurrentProfile({ voiceEnabled: true, sttPolicy: 'cloud_preferred', ttsPolicy: 'cloud_preferred', audioConfigured: true }), 'cloud_voice');
  assert.equal(deriveCurrentProfile({ voiceEnabled: true, sttPolicy: 'local_only', ttsPolicy: 'local_only', audioConfigured: true }), 'local_voice');
  assert.equal(deriveCurrentProfile({ voiceEnabled: true, sttPolicy: 'local_only', ttsPolicy: 'cloud_preferred', audioConfigured: true }), null);
});
/*MORE*/
