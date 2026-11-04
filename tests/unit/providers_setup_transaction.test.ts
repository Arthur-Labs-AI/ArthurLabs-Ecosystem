import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildProvidersStatus, providersStatusJson, renderProvidersStatus } from '../../src/providers/provider_status';
import { compileMachinePatch, emptySetupPlan, isEmptyPlan } from '../../src/providers/setup_plan';
import { runProvidersSetup, runProvidersStatus } from '../../apps/cli/providers';
import { CliExit } from '../../src/cli_exit';
import type { CliIO } from '../../apps/cli/index';
import type { SecretTty } from '../../src/providers/secret_input';

const DS = 'sk-deepseek-plan-secret';
const OA = 'sk-openai-plan-secret';

function io(): CliIO & { outText: string; errText: string } {
  const sink = { outText: '', errText: '' } as CliIO & { outText: string; errText: string };
  (sink as CliIO).out = (t: string) => { sink.outText += t; };
  (sink as CliIO).err = (t: string) => { sink.errText += t; };
  return sink;
}

function layersOf(ambient: Record<string, string> = {}, repo: Record<string, string> = {}, machine: Record<string, string> = {}): { ambient: Record<string, string>; repo: Record<string, string>; machine: Record<string, string> } {
  return { ambient, repo, machine };
}

function deepseekOk(): typeof fetch {
  const fn = (async () => new Response(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: 'deepseek-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  return fn;
}

function openaiOk(): typeof fetch {
  const fn = (async (url: unknown) => {
    const u = String(url);
    if (u.includes('transcriptions')) return new Response(JSON.stringify({ text: 'hi' }), { status: 200, headers: { 'content-type': 'application/json' } });
    const pcm = Buffer.alloc(9600, 3);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(pcm)); c.close(); } });
    return new Response(stream as unknown as never, { status: 200 });
  }) as unknown as typeof fetch;
  return fn;
}

function scriptTty(chars: string): SecretTty {
  const keys = [...chars, 'ENTER'];
  let i = 0;
  return { isTTY: true, write: () => undefined, readKey: async () => keys[i++] ?? 'EOF' };
}

test('H1: status human shows configured/not configured with sources and no secrets', () => {
  const out = io();
  const code = runProvidersStatus(new Map(), out, layersOf({ DEEPSEEK_API_KEY: DS }));
  assert.equal(code, CliExit.SUCCESS);
  assert.ok(out.outText.includes('configured'));
  assert.ok(out.outText.includes('process_env'));
  assert.ok(!out.outText.includes(DS));
  assert.ok(!out.errText.includes(DS));
});

test('I1: status --json is exactly one valid object with no secrets', () => {
  const out = io();
  const code = runProvidersStatus(new Map([['json', 'true']]), out, layersOf({ DEEPSEEK_API_KEY: DS, OPENAI_API_KEY: OA }));
  assert.equal(code, CliExit.SUCCESS);
  const parsed = JSON.parse(out.outText);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'providers status');
  assert.equal(parsed.data.reasoning.api_key.configured, true);
  assert.ok(!JSON.stringify(parsed).includes(DS));
  assert.ok(!JSON.stringify(parsed).includes(OA));
});

test('F1: cancel before Save performs zero mutation and is NOT silent success', async () => {
  const out = io();
  // answers: Configure DeepSeek? yes, then cancel at the secret prompt (EOF-style CANCEL)
  const answers = ['y'];
  let secretCalls = 0;
  const secretTty: SecretTty = { isTTY: true, write: () => undefined, readKey: async () => { secretCalls += 1; return 'CANCEL'; } };
  let commits = 0;
  const code = await runProvidersSetup({}, new Map(), out, {
    tty: true,
    secretTty,
    layers: layersOf(),
    readApprovalLine: async () => answers.shift() ?? '',
    commitPatch: () => { commits += 1; },
    fetchFn: deepseekOk(),
  });
  // Windows-fix contract: cancellation is explicit and non-success (never silent success).
  assert.equal(code, CliExit.INTERNAL);
  assert.notEqual(code, CliExit.SUCCESS);
  assert.equal(secretCalls, 1);
  assert.equal(commits, 0);
  assert.ok(out.outText.includes('Setup cancelled. No changes were saved.'));
  assert.ok(!out.outText.includes(DS));
});

test('F2: declining Save discards the validated plan (zero mutation)', async () => {
  const out = io();
  const answers = ['y', 'n', 'n', 'n'];
  const code = await runProvidersSetup({}, new Map(), out, {
    tty: true,
    secretTty: scriptTty(DS),
    layers: layersOf(),
    readApprovalLine: async () => answers.shift() ?? '',
    commitPatch: () => { throw new Error('must not commit'); },
    fetchFn: (async (url: unknown, init: unknown) => {
      const u = String(url);
      if (String(u).includes('deepseek')) return deepseekOk()(u, init as never);
      return openaiOk()(u, init as never);
    }) as unknown as typeof fetch,
  });
  assert.equal(code, CliExit.SUCCESS);
  assert.ok(out.outText.includes('Discarded'));
});

test('F3: valid new DeepSeek credential commits exactly one atomic patch', async () => {
  const out = io();
  const answers = ['y', 'n', 'y'];
  const patches: Array<{ set: Record<string, string>; remove: string[] }> = [];
  const code = await runProvidersSetup({}, new Map(), out, {
    tty: true,
    secretTty: scriptTty(DS),
    layers: layersOf(),
    readApprovalLine: async () => answers.shift() ?? '',
    commitPatch: (p) => { patches.push(p); },
    fetchFn: deepseekOk(),
  });
  assert.equal(code, CliExit.SUCCESS);
  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.set['DEEPSEEK_API_KEY'], DS);
  assert.equal(patches[0]?.set['ARTHUR_MODEL_PROVIDER'], 'deepseek');
  assert.equal(patches[0]?.set['ARTHUR_MODEL_NAME'], 'deepseek-chat');
  assert.ok(!('ARTHUR_CLOUD_STT_MODEL' in (patches[0]?.set ?? {})));
  assert.ok(!out.outText.includes(DS));
});

test('F4: invalid new credential is NOT persisted (retry declined)', async () => {
  const out = io();
  const bad = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
  const answers = ['y', 'n', 'n', 'n'];
  const patches: unknown[] = [];
  const code = await runProvidersSetup({}, new Map(), out, {
    tty: true,
    secretTty: scriptTty('bad-key'),
    layers: layersOf(),
    readApprovalLine: async () => answers.shift() ?? '',
    commitPatch: (p) => { patches.push(p); },
    fetchFn: bad,
  });
  assert.equal(code, CliExit.SUCCESS);
  assert.equal(patches.length, 0);
  assert.ok(out.outText.includes('NOT saved') || out.outText.includes('NOT saved'.toLowerCase()) || out.outText.includes('NOT saved'.toUpperCase()) || out.outText.includes('was NOT saved'));
});

test('F5: rerun with everything configured saves nothing (idempotent)', async () => {
  const out = io();
  const answers = ['n', 'n'];
  let commits = 0;
  const code = await runProvidersSetup({}, new Map(), out, {
    tty: true,
    layers: layersOf({ DEEPSEEK_API_KEY: DS, OPENAI_API_KEY: OA }),
    readApprovalLine: async () => answers.shift() ?? '',
    commitPatch: () => { commits += 1; },
  });
  assert.equal(code, CliExit.SUCCESS);
  assert.equal(commits, 0);
  assert.ok(out.outText.includes('Nothing to save'));
});

test('F6: compileMachinePatch never dumps code defaults', () => {
  assert.equal(isEmptyPlan(emptySetupPlan()), true);
  const patch = compileMachinePatch({ secrets: { deepseekApiKey: DS }, choices: { modelProvider: 'deepseek', modelName: 'deepseek-chat' } });
  assert.ok(!('ARTHUR_CLOUD_STT_MODEL' in patch.set));
  assert.ok(!('ARTHUR_CLOUD_TTS_MODEL' in patch.set));
  assert.ok(!('ARTHUR_CLOUD_TTS_VOICE' in patch.set));
  assert.ok(!('ARTHUR_VOICE_ENABLED' in patch.set));
});

test('H2: buildProvidersStatus attributes sources per FRS-01 precedence', () => {
  const status = buildProvidersStatus(layersOf({ ARTHUR_MODEL_PROVIDER: 'deepseek' }, { ARTHUR_MODEL_NAME: 'repo-model' }, { ARTHUR_MODEL_NAME: 'machine-model', DEEPSEEK_API_KEY: 'm' }));
  assert.equal(status.reasoning.provider.source, 'process_env');
  assert.equal(status.reasoning.model.display, 'repo-model');
  assert.equal(status.reasoning.model.source, 'repo_env');
  assert.equal(status.reasoning.apiKey.display, 'configured');
  assert.equal(status.cloudVoice.sttModel.source, 'code_default');
});

test('H3: renderProvidersStatus never contains secret values', () => {
  const status = buildProvidersStatus(layersOf({ DEEPSEEK_API_KEY: DS, OPENAI_API_KEY: OA }));
  const text = renderProvidersStatus(status);
  assert.ok(!text.includes(DS));
  assert.ok(!text.includes(OA));
  const json = JSON.stringify(providersStatusJson(status));
  assert.ok(!json.includes(DS));
  assert.ok(!json.includes(OA));
});
/*MORE*/
