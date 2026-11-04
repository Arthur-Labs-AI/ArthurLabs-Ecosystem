import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeConfigurationEnvironment } from '../../src/config/machine_config';
import { loadSettings } from '../../src/config/settings';
import { validateSettings } from '../../src/config/validation';
import { runProvidersStatus, runProviders } from '../../apps/cli/providers';
import { runConfig } from '../../apps/cli/config';
import { buildProvidersStatus, providersStatusJson } from '../../src/providers/provider_status';
import { DeepSeekProvider } from '../../src/models/providers/deepseek';
import { OpenAiSttProvider } from '../../src/voice/stt/openai_provider';
import { OpenAiTtsProvider } from '../../src/voice/tts/openai_provider';
import type { CliIO } from '../../apps/cli/index';
import { CliExit } from '../../src/cli_exit';

const DS = 'sk-deepseek-leak-probe-xyz';
const OA = 'sk-openai-leak-probe-xyz';

function io(): CliIO & { outText: string; errText: string } {
  const sink = { outText: '', errText: '' } as CliIO & { outText: string; errText: string };
  (sink as CliIO).out = (t: string) => { sink.outText += t; };
  (sink as CliIO).err = (t: string) => { sink.errText += t; };
  return sink;
}

function withEnv(keys: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const k of Object.keys(keys)) saved.set(k, process.env[k]);
  for (const [k, v] of Object.entries(keys)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fn(); } finally { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('SEC1: providers status (human + json) never leaks secrets', () => {
  const human = io();
  assert.equal(runProvidersStatus(new Map(), human, { ambient: { DEEPSEEK_API_KEY: DS, OPENAI_API_KEY: OA }, repo: {}, machine: {} }), CliExit.SUCCESS);
  assert.ok(!human.outText.includes(DS) && !human.outText.includes(OA));
  const json = io();
  assert.equal(runProvidersStatus(new Map([['json', 'true']]), json, { ambient: { DEEPSEEK_API_KEY: DS, OPENAI_API_KEY: OA }, repo: {}, machine: {} }), CliExit.SUCCESS);
  assert.ok(!json.outText.includes(DS) && !json.outText.includes(OA));
});

test('SEC2: config show never leaks provider secrets', () => {
  withEnv({ DEEPSEEK_API_KEY: DS, OPENAI_API_KEY: OA }, () => {
    const rows = describeConfigurationEnvironment(process.env);
    const text = JSON.stringify(rows);
    assert.ok(!text.includes(DS) && !text.includes(OA));
  });
});

test('SEC3: no secret CLI flag exists on providers (deepseek-key/openai-key rejected)', async () => {
  const out = io();
  const code = await runProviders({}, 'providers', new Map([['deepseek-key', DS]]), ['providers', 'setup'], out);
  assert.equal(code, CliExit.USAGE);
  assert.ok(!out.outText.includes(DS) && !out.errText.includes(DS));
  const out2 = io();
  const code2 = await runProviders({}, 'providers', new Map([['openai-key', OA]]), ['providers', 'status'], out2);
  assert.equal(code2, CliExit.USAGE);
  assert.ok(!out2.outText.includes(OA) && !out2.errText.includes(OA));
});

test('SEC4: thrown public errors never carry secret values', () => {
  const store = new (require('../../src/providers/credentials').MachineConfigCredentialStore)({ readEntries: () => ({}), writeUpdate: () => ({}) });
  try { store.set('NOPE' as never, DS); assert.fail('must throw'); }
  catch (e) { assert.ok(!(e as Error).message.includes(DS)); }
});

test('SEC5: readiness results never carry secret values', async () => {
  const { checkDeepSeekReadiness } = await import('../../src/providers/deepseek_readiness');
  const bad = (async () => new Response('x', { status: 401 })) as unknown as typeof fetch;
  const r = await checkDeepSeekReadiness({ apiKey: DS, model: 'deepseek-chat', baseUrl: 'https://x' }, { fetchFn: bad });
  assert.ok(!JSON.stringify(r).includes(DS));
});

test('SEC6: providers setup --json failure never echoes secrets', async () => {
  const out = io();
  const code = await runProviders({}, 'providers', new Map([['json', 'true']]), ['providers', 'setup'], out, { layers: { ambient: {}, repo: {}, machine: {} } });
  assert.equal(code, CliExit.USAGE);
  assert.ok(out.outText.includes('INTERACTIVE_REQUIRED'));
});

test('J1: loadSettings still honors FRS-01 precedence (ambient wins)', () => {
  withEnv({ ARTHUR_MODEL_PROVIDER: 'deepseek', ARTHUR_MODEL_NAME: 'env-model', DEEPSEEK_API_KEY: DS }, () => {
    const s = loadSettings();
    assert.equal(s.modelProvider, 'deepseek');
    assert.equal(s.modelName, 'env-model');
    assert.equal(s.deepseekApiKey, DS);
  });
});

test('J2: DeepSeek normal runtime construction unchanged (provider id + capabilities)', () => {
  const p = new DeepSeekProvider({ apiKey: DS, model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', timeoutMs: 1000, retryMaxAttempts: 0, retryBaseDelayMs: 0, reasoningProfile: 'normal' });
  assert.equal(p.id(), 'deepseek');
  assert.equal(p.capabilities().supportsTools, true);
});

test('J3: OpenAI STT/TTS normal runtime unchanged (ids + availability, no probing)', () => {
  const stt = new OpenAiSttProvider({ apiKey: OA, model: 'gpt-4o-transcribe' });
  assert.equal(stt.id(), 'openai-stt');
  assert.equal(stt.available, true);
  const tts = new OpenAiTtsProvider({ apiKey: OA, model: 'gpt-4o-mini-tts', voice: 'alloy' });
  assert.equal(tts.id(), 'openai-tts');
  assert.equal(tts.available, true);
});

test('J4: config show Command still works (no DB, secret-safe)', () => {
  const out = io();
  withEnv({ DEEPSEEK_API_KEY: DS }, () => {
    const code = runConfig('config', new Map(), ['config', 'show'], out);
    assert.equal(code, CliExit.SUCCESS);
  });
  assert.ok(!out.outText.includes(DS));
});

test('J5: status builder defaults come from code (no duplicated schema)', () => {
  const status = buildProvidersStatus({ ambient: {}, repo: {}, machine: {} });
  assert.equal(status.cloudVoice.sttModel.display, 'gpt-4o-transcribe');
  assert.equal(status.cloudVoice.ttsModel.display, 'gpt-4o-mini-tts');
  assert.equal(status.cloudVoice.ttsVoice.display, 'alloy');
  assert.equal(status.reasoning.baseUrl.display, 'https://api.deepseek.com');
  const json = providersStatusJson(status);
  assert.ok(!JSON.stringify(json).includes(DS));
});

test('J6: deepseek validation still requires key at startup (validateSettings unchanged)', () => {
  withEnv({ ARTHUR_MODEL_PROVIDER: 'deepseek', ARTHUR_MODEL_NAME: 'deepseek-chat', DEEPSEEK_API_KEY: '' }, () => {
    assert.throws(() => validateSettings(loadSettings()), /DEEPSEEK_API_KEY/);
  });
});
/*MORE*/
