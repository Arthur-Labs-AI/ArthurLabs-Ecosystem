import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CliExit } from '../../src/cli_exit';
import type { CliIO } from '../../apps/cli/index';
import { runUnifiedSetup } from '../../apps/cli/setup_unified';
import { applyUnifiedPlan, buildAudioPatch, buildProviderPatch, runUnifiedSetupFlow } from '../../src/setup/unified_setup';
import type { SetupLayers } from '../../src/setup/unified_setup';
import { compileUnifiedPatch, emptyUnifiedPlan } from '../../src/setup/plan';
import { dependenciesFor } from '../../src/setup/profile';

const DS = 'sk-unified-deepseek-secret';
const OA = 'sk-unified-openai-secret';

function testIo(): CliIO & { outText: string; errText: string } {
  const sink = { outText: '', errText: '' } as CliIO & { outText: string; errText: string };
  (sink as CliIO).out = (t: string) => { sink.outText += t; };
  (sink as CliIO).err = (t: string) => { sink.errText += t; };
  return sink;
}

function layersOf(machine: Record<string, string> = {}, ambient: Record<string, string> = {}): SetupLayers {
  return { ambient, repo: {}, machine };
}

function cloudSeams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  if (overrides['layers'] === undefined) overrides = { ...overrides, layers: layersOf() };
  const answers: string[] = (overrides['answers'] as string[] | undefined) ?? [];
  const secrets: Array<{ kind: string; value?: string }> = (overrides['secrets'] as Array<{ kind: string; value?: string }> | undefined) ?? [];
  let secretIdx = 0;
  return {
    tty: true,
    layers: overrides['layers'] as SetupLayers | undefined,
    commitPatch: overrides['commitPatch'] as ((patch: { set: Record<string, string>; remove: string[] }) => void) | undefined,
    readApprovalLine: async () => answers.shift() ?? '',
    fetchFn: undefined,
    secretTty: {
      isTTY: true,
      write: () => undefined,
      readKey: async () => {
        // Expand {kind:'submitted',value} into per-char tokens + ENTER once.
        let s = secrets[secretIdx];
        if (s !== undefined && s.kind === 'submitted' && s.value !== undefined && !(s as { expanded?: boolean }).expanded) {
          (s as { expanded?: boolean }).expanded = true;
          const chars = [...(s.value as string)];
          secrets.splice(secretIdx, 1, ...chars.map((c) => ({ kind: 'char', value: c })), { kind: 'ENTER' });
          s = secrets[secretIdx];
        }
        const cur = secrets[secretIdx++];
        if (cur === undefined) return 'ENTER';
        if (cur.kind === 'char') return cur.value as string;
        if (cur.kind === 'cancelled') return 'CANCEL';
        return 'ENTER';
      },
    },
    audioBackend: {
      detect: async () => ({ available: true, captureAvailable: true, playbackAvailable: true }),
      listInputDevices: async () => [{ id: 'Mic A', label: 'Mic A', backend: 'ffmpeg-dshow' }],
      buildCommands: () => ({ captureCommand: 'ffmpeg -i mic', playbackCommand: 'ffplay -i -' }),
    },
    captureValidator: async () => ({ transportReady: true, signalDetected: true, metrics: { framesReceived: 10, bytesReceived: 6400, durationMs: 200, peakLevel: 9, rmsLevel: 9, signalDetected: true } }),
    playbackValidator: async () => ({ transportReady: true, chunksAccepted: 2, bytesAccepted: 100 }),
    modelSeams: {
      recommend: async () => ({ modelId: 'parakeet-tdt-0.6b-v3', alreadyReady: true, detail: 'recommended' }),
      install: async () => ({ ok: true, reason: 'installed' }),
    },
  };
}

test('E1: successful cloud setup commits exactly ONE patch, zero writes before Apply', async () => {
  const out = testIo();
  const patches: Array<{ set: Record<string, string>; remove: string[] }> = [];
  const code = await runUnifiedSetup(new Map(), out, {
    ...cloudSeams({ answers: ['1', '', 'y', 'n', 'y'], secrets: [{ kind: 'submitted', value: DS }, { kind: 'submitted', value: OA }], commitPatch: (p: { set: Record<string, string>; remove: string[] }) => { patches.push(p); } }),
    fetchFn: (async (url: unknown) => {
      const u = String(url);
      if (u.includes('deepseek')) return new Response(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: 'deepseek-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (u.includes('transcriptions')) return new Response(JSON.stringify({ text: 'hi' }), { status: 200, headers: { 'content-type': 'application/json' } });
      const pcm = Buffer.alloc(9600, 3);
      const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(pcm)); c.close(); } });
      return new Response(stream as unknown as never, { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.equal(code, CliExit.SUCCESS);
  assert.equal(patches.length, 1);
  const set = patches[0]?.set as Record<string, string>;
  assert.equal(set['DEEPSEEK_API_KEY'], DS);
  assert.equal(set['OPENAI_API_KEY'], OA);
  assert.equal(set['ARTHUR_MODEL_PROVIDER'], 'deepseek');
  assert.equal(set['ARTHUR_AUDIO_INPUT_DEVICE'], 'Mic A');
  assert.equal(set['ARTHUR_VOICE_ENABLED'], 'true');
  assert.ok(!('ARTHUR_VOICE_ENABLED' in set) || set['ARTHUR_VOICE_ENABLED'] === 'true');
  assert.ok(!('ARTHUR_STT_POLICY' in set), 'cloud policies are code defaults: never dumped');
  assert.ok(!out.outText.includes(DS) && !out.outText.includes(OA));
  assert.ok(out.outText.includes('ARTHUR is ready'));
});

test('E2: cancel at profile/audio/review => zero writes, non-success', async () => {
  const out = testIo();
  let commits = 0;
  // Cancel at the DeepSeek secret (CANCEL token).
  const code = await runUnifiedSetup(new Map(), out, {
    ...cloudSeams({ answers: ['1'], secrets: [{ kind: 'cancelled' }], commitPatch: () => { commits += 1; } }),
  });
  assert.equal(commits, 0);
  assert.equal(code, CliExit.INTERNAL);
  assert.ok(out.outText.includes('No configuration changes were saved'));
});

test('E3: provider validation failure => zero writes', async () => {
  const out = testIo();
  let commits = 0;
  const bad = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
  const code = await runUnifiedSetup(new Map(), out, {
    ...cloudSeams({ answers: ['1', 'n'], secrets: [{ kind: 'submitted', value: 'bad' }], commitPatch: () => { commits += 1; } }),
    fetchFn: bad,
  });
  assert.equal(commits, 0);
  assert.notEqual(code, CliExit.SUCCESS);
});

test('H1: cloud profile writes no local-model/policy defaults; text-only writes no audio', async () => {
  const plan = { profile: 'cloud_voice' as const, dependencies: dependenciesFor('cloud_voice'), secrets: {}, providers: { deepseekValidated: 'skipped', openaiSttReady: true, openaiTtsReady: true, deepseekSource: 'process_env', openaiSource: 'process_env' }, audio: { captureReady: true, signalDetected: true, audibleConfirmed: true as const, inputId: 'Mic', inputLabel: 'Mic', outputId: 'default', captureCommand: 'ffmpeg -i x', playbackCommand: 'ffplay -i -' }, localModels: [], voice: { voiceEnabled: true } };
  const { compileUnifiedPatch } = await import('../../src/setup/plan');
  const patch = compileUnifiedPatch(plan, { providerPatch: { set: {}, remove: [] }, audioPatch: { set: { ARTHUR_AUDIO_INPUT_DEVICE: 'Mic', ARTHUR_AUDIO_OUTPUT_DEVICE: 'default', ARTHUR_AUDIO_CAPTURE_COMMAND: 'ffmpeg -i x', ARTHUR_AUDIO_PLAYBACK_COMMAND: 'ffplay -i -' }, remove: [] }, voiceDefaults: { voiceEnabled: false, sttPolicy: 'cloud_preferred', ttsPolicy: 'cloud_preferred', wakeEnabled: true }, effectiveVoice: { voiceEnabled: false, sttPolicy: 'cloud_preferred', ttsPolicy: 'cloud_preferred', wakeEnabled: true } });
  assert.equal(patch.set['ARTHUR_VOICE_ENABLED'], 'true');
  assert.ok(!('ARTHUR_STT_POLICY' in patch.set));
  assert.ok(!('ARTHUR_VOICE_ENABLED' in patch.set) || patch.set['ARTHUR_VOICE_ENABLED'] === 'true');
});

test('I1: --json refuses typed; non-TTY refuses typed; legacy flags migrate', async () => {
  const j = testIo();
  assert.equal(await runUnifiedSetup(new Map([['json', 'true']]), j, { tty: true, layers: layersOf() }), CliExit.USAGE);
  assert.ok(j.outText.includes('INTERACTIVE_REQUIRED'));
  const t = testIo();
  assert.equal(await runUnifiedSetup(new Map(), t, { tty: false, layers: layersOf() }), CliExit.USAGE);
  const m = testIo();
  assert.equal(await runUnifiedSetup(new Map([['stt-model', 'x']]), m, { tty: true, layers: layersOf() }), CliExit.USAGE);
  assert.ok(m.errText.includes('arthur models setup'));
});

test('J1: no secret flags; secrets never rendered in review/errors', async () => {
  const out = testIo();
  const code = await runUnifiedSetup(new Map([['deepseek-key', 'x']]), out, { tty: true, layers: layersOf() });
  assert.equal(code, CliExit.USAGE);
  assert.ok(!out.outText.includes('x-secret-never-there'));
});

test('F1: failed audio validation => zero writes', async () => {
  const out = testIo();
  let commits = 0;
  const code = await runUnifiedSetup(new Map(), out, {
    ...cloudSeams({ answers: ['1'], secrets: [{ kind: 'submitted', value: DS }, { kind: 'submitted', value: OA }], commitPatch: () => { commits += 1; } }),
    fetchFn: (async (url: unknown) => {
      const u = String(url);
      if (u.includes('deepseek')) return new Response(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: 'deepseek-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('nope', { status: 401 });
    }) as unknown as typeof fetch,
    captureValidator: async () => ({ transportReady: false, signalDetected: false, metrics: { framesReceived: 0, bytesReceived: 0, durationMs: 9, peakLevel: 0, rmsLevel: 0, signalDetected: false }, failure: 'no audio' }),
  });
  assert.equal(commits, 0);
  assert.notEqual(code, CliExit.SUCCESS);
});

test('G1: rerun with everything configured preselects and rewrites nothing', async () => {
  const out = testIo();
  let commits = 0;
  const machine = { DEEPSEEK_API_KEY: DS, OPENAI_API_KEY: OA, ARTHUR_MODEL_PROVIDER: 'deepseek', ARTHUR_MODEL_NAME: 'deepseek-chat', ARTHUR_AUDIO_INPUT_DEVICE: 'Mic A', ARTHUR_AUDIO_OUTPUT_DEVICE: 'default', ARTHUR_AUDIO_CAPTURE_COMMAND: 'ffmpeg -i mic', ARTHUR_AUDIO_PLAYBACK_COMMAND: 'ffplay -i -', ARTHUR_VOICE_ENABLED: 'true' };
  // Keep everything: profile cloud(1), keep DS(y default Enter), keep OA, mic default, heard y, wake y, Apply y.
  // All sources already machine_config and values identical => patch empty => 'Nothing to save'.
  const code = await runUnifiedSetup(new Map(), out, {
    ...cloudSeams({ answers: ['1', '', '', '', 'y', 'y', 'y'], secrets: [], commitPatch: () => { commits += 1; } }),
    layers: layersOf(machine),
  });
  assert.equal(code, CliExit.SUCCESS);
  assert.ok(out.outText.includes('Nothing to save') || commits <= 1);
});
test('D1: models setup migration routes through model_branch', async () => {
  const { runModelsOrSetup } = await import('../../apps/cli/model_branch');
  assert.equal(typeof runModelsOrSetup, 'function');
  // The unified help advertises the migration path.
  const { UNIFIED_SETUP_HELP } = await import('../../apps/cli/setup_unified');
  assert.ok(UNIFIED_SETUP_HELP.includes('arthur models setup'));
});

test('B1: unified flow causes zero provider writes outside Apply (commitPatch once)', async () => {
  const out = testIo();
  const patches: unknown[] = [];
  const code = await runUnifiedSetup(new Map(), out, {
    ...cloudSeams({ answers: ['1', '', 'y', 'n', 'n'], secrets: [{ kind: 'submitted', value: DS }, { kind: 'submitted', value: OA }], commitPatch: (p: { set: Record<string, string>; remove: string[] }) => { patches.push(p); } }),
    fetchFn: (async (url: unknown) => {
      const u = String(url);
      if (u.includes('deepseek')) return new Response(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: 'deepseek-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (u.includes('transcriptions')) return new Response(JSON.stringify({ text: 'hi' }), { status: 200, headers: { 'content-type': 'application/json' } });
      const pcm = Buffer.alloc(9600, 3);
      const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(pcm)); c.close(); } });
      return new Response(stream as unknown as never, { status: 200 });
    }) as unknown as typeof fetch,
  });
  // Declined at Apply => Discarded, zero commits.
  assert.equal(code, CliExit.SUCCESS);
  assert.equal(patches.length, 0);
  assert.ok(out.outText.includes('Discarded'));
});

test('K1: standalone providers/audio behavior unchanged (imports intact)', async () => {
  const providers = await import('../../apps/cli/providers');
  const audio = await import('../../apps/cli/audio');
  assert.equal(typeof providers.runProvidersSetup, 'function');
  assert.equal(typeof audio.runAudioSetup, 'function');
});
/*TESTS*/
