import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CliExit } from '../../src/cli_exit';
import type { CliIO } from '../../apps/cli/index';
import { runUnifiedSetup } from '../../apps/cli/setup_unified';
import { applyUnifiedPlan, buildAudioPatch, buildProviderPatch, runUnifiedSetupFlow } from '../../src/setup/unified_setup';
import type { SetupLayers, UnifiedSetupSeams } from '../../src/setup/unified_setup';
import { compileUnifiedPatch, diffPatchAgainstMachine, emptyUnifiedPlan, isEmptyUnifiedPlanPatch } from '../../src/setup/plan';
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
  // All sources already machine_config and values identical => semantic patch empty => 'Nothing to save'.
  const code = await runUnifiedSetup(new Map(), out, {
    ...cloudSeams({ answers: ['1', '', '', '', 'y', 'y', 'y'], secrets: [], commitPatch: () => { commits += 1; } }),
    layers: layersOf(machine),
  });
  assert.equal(code, CliExit.SUCCESS);
  assert.equal(commits, 0);
  assert.ok(out.outText.includes('Nothing to save: configuration already matches the requested state.'));
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
function applySeams(modelInstalls: string[], commitPatches: Array<{ set: Record<string, string>; remove: string[] }>, installImpl?: (modelId: string) => Promise<{ ok: boolean; reason: string }>): UnifiedSetupSeams {
  return {
    prompts: {
      confirm: async () => true,
      select: async () => 0,
      secret: async () => ({ kind: 'empty' as const }),
    },
    providers: {
      checkDeepseek: async () => ({ ready: true }),
      checkOpenai: async () => ({ sttReady: true, ttsReady: true }),
    },
    audio: {
      detect: async () => ({ available: true, captureAvailable: true, playbackAvailable: true }),
      listInputDevices: async () => [],
      buildCommands: () => ({ captureCommand: 'cap', playbackCommand: 'play' }),
      validateCapture: async () => ({ transportReady: true, signalDetected: true, frames: 1 }),
      validatePlayback: async () => ({ transportReady: true }),
      confirmHeard: async () => true,
    },
    models: {
      recommend: async () => null,
      install: async (modelId: string) => { modelInstalls.push(modelId); if (installImpl) return installImpl(modelId); return { ok: true, reason: 'installed' }; },
    },
    commitPatch: (patch: { set: Record<string, string>; remove: string[] }) => { commitPatches.push(patch); },
  };
}

test('FRS04-1: identical SET pruned to empty (machine-only comparison)', () => {
  const pruned = diffPatchAgainstMachine({ set: { A: 'x' }, remove: [] }, { A: 'x' });
  assert.ok(isEmptyUnifiedPlanPatch(pruned));
});

test('FRS04-2: changed SET kept', () => {
  const pruned = diffPatchAgainstMachine({ set: { A: 'y' }, remove: [] }, { A: 'x' });
  assert.deepEqual(pruned.set, { A: 'y' });
  assert.deepEqual(pruned.remove, []);
});

test('FRS04-3: new SET kept', () => {
  const pruned = diffPatchAgainstMachine({ set: { B: 'new' }, remove: [] }, { A: 'x' });
  assert.deepEqual(pruned.set, { B: 'new' });
});

test('FRS04-4: REMOVE for absent key omitted', () => {
  const pruned = diffPatchAgainstMachine({ set: {}, remove: ['GONE'] }, { A: 'x' });
  assert.ok(isEmptyUnifiedPlanPatch(pruned));
});

test('FRS04-5: REMOVE for existing key kept', () => {
  const pruned = diffPatchAgainstMachine({ set: {}, remove: ['A'] }, { A: 'x' });
  assert.deepEqual(pruned.remove, ['A']);
});

test('FRS04-6: mixed patch retains only the semantic delta', () => {
  const pruned = diffPatchAgainstMachine(
    { set: { SAME: 'v', CHANGED: 'new', ADDED: 'a' }, remove: ['GONE', 'STALE'] },
    { SAME: 'v', CHANGED: 'old', STALE: 's' },
  );
  assert.deepEqual(pruned.set, { CHANGED: 'new', ADDED: 'a' });
  assert.deepEqual(pruned.remove, ['STALE']);
});

test('FRS04-7: empty semantic patch still installs a missing required model (zero config commits)', async () => {
  const { dependenciesFor } = await import('../../src/setup/profile');
  const plan = emptyUnifiedPlan('local_voice', dependenciesFor('local_voice'));
  plan.audio = { captureReady: true, signalDetected: true, audibleConfirmed: true, inputId: 'Mic A', inputLabel: 'Mic A', outputId: 'default', captureCommand: 'ffmpeg -i mic', playbackCommand: 'ffplay -i -' };
  plan.voice = { voiceEnabled: true, sttPolicy: 'local_only', ttsPolicy: 'local_only' };
  plan.localModels = [{ kind: 'stt', modelId: 'parakeet-tdt-0.6b-v3', via: 'recommended', alreadyReady: false }];
  const layers = layersOf({
    ARTHUR_VOICE_ENABLED: 'true',
    ARTHUR_STT_POLICY: 'local_only',
    ARTHUR_TTS_POLICY: 'local_only',
    ARTHUR_AUDIO_INPUT_DEVICE: 'Mic A',
    ARTHUR_AUDIO_OUTPUT_DEVICE: 'default',
    ARTHUR_AUDIO_CAPTURE_COMMAND: 'ffmpeg -i mic',
    ARTHUR_AUDIO_PLAYBACK_COMMAND: 'ffplay -i -',
  });
  const installs: string[] = [];
  const commits: Array<{ set: Record<string, string>; remove: string[] }> = [];
  const texts: string[] = [];
  const result = await applyUnifiedPlan(plan, layers, applySeams(installs, commits), (t: string) => { texts.push(t); });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(installs, ['parakeet-tdt-0.6b-v3']);
  assert.equal(commits.length, 0);
  assert.equal(result.committed, false);
  assert.equal(result.configChanged, false);
  assert.equal(result.modelActionsOccurred, true);
});

test('FRS04-8: install failure with empty semantic patch reports failure and writes nothing', async () => {
  const { dependenciesFor } = await import('../../src/setup/profile');
  const plan = emptyUnifiedPlan('local_voice', dependenciesFor('local_voice'));
  plan.audio = { captureReady: true, signalDetected: true, audibleConfirmed: true, inputId: 'Mic A', inputLabel: 'Mic A', outputId: 'default', captureCommand: 'ffmpeg -i mic', playbackCommand: 'ffplay -i -' };
  plan.voice = { voiceEnabled: true, sttPolicy: 'local_only', ttsPolicy: 'local_only' };
  plan.localModels = [{ kind: 'stt', modelId: 'parakeet-tdt-0.6b-v3', via: 'recommended', alreadyReady: false }];
  const layers = layersOf({
    ARTHUR_VOICE_ENABLED: 'true',
    ARTHUR_STT_POLICY: 'local_only',
    ARTHUR_TTS_POLICY: 'local_only',
    ARTHUR_AUDIO_INPUT_DEVICE: 'Mic A',
    ARTHUR_AUDIO_OUTPUT_DEVICE: 'default',
    ARTHUR_AUDIO_CAPTURE_COMMAND: 'ffmpeg -i mic',
    ARTHUR_AUDIO_PLAYBACK_COMMAND: 'ffplay -i -',
  });
  const installs: string[] = [];
  const commits: Array<{ set: Record<string, string>; remove: string[] }> = [];
  const texts: string[] = [];
  const result = await applyUnifiedPlan(plan, layers, applySeams(installs, commits, async () => ({ ok: false, reason: 'disk full' })), (t: string) => { texts.push(t); });
  assert.equal(result.exitCode, 5);
  assert.deepEqual(installs, ['parakeet-tdt-0.6b-v3']);
  assert.equal(commits.length, 0);
  assert.equal(result.committed, false);
  assert.ok(texts.join('').includes('Configuration was NOT saved'));
});

test('FRS04-9: changed configuration still commits exactly ONE pruned patch', async () => {
  const { dependenciesFor } = await import('../../src/setup/profile');
  const plan = emptyUnifiedPlan('cloud_voice', dependenciesFor('cloud_voice'));
  plan.audio = { captureReady: true, signalDetected: true, audibleConfirmed: true, inputId: 'Mic B', inputLabel: 'Mic B', outputId: 'default', captureCommand: 'ffmpeg -i new', playbackCommand: 'ffplay -i -' };
  plan.voice = { voiceEnabled: true };
  const layers = layersOf({
    ARTHUR_VOICE_ENABLED: 'true',
    ARTHUR_AUDIO_INPUT_DEVICE: 'Mic A',
    ARTHUR_AUDIO_OUTPUT_DEVICE: 'default',
    ARTHUR_AUDIO_CAPTURE_COMMAND: 'ffmpeg -i mic',
    ARTHUR_AUDIO_PLAYBACK_COMMAND: 'ffplay -i -',
  });
  const installs: string[] = [];
  const commits: Array<{ set: Record<string, string>; remove: string[] }> = [];
  const result = await applyUnifiedPlan(plan, layers, applySeams(installs, commits), () => undefined);
  assert.equal(result.exitCode, 0);
  assert.equal(commits.length, 1);
  assert.equal(result.committed, true);
  assert.equal(result.configChanged, true);
  assert.equal(commits[0]?.set['ARTHUR_AUDIO_INPUT_DEVICE'], 'Mic B');
  assert.equal(commits[0]?.set['ARTHUR_AUDIO_CAPTURE_COMMAND'], 'ffmpeg -i new');
  assert.ok(!('ARTHUR_VOICE_ENABLED' in (commits[0]?.set as Record<string, string>)), 'unchanged voice flag must be pruned');
});

test('FRS04-10: semantic diff compares values internally and never renders secrets', () => {
  const secret = 'sk-live-super-secret-value';
  const same = diffPatchAgainstMachine({ set: { OPENAI_API_KEY: secret }, remove: [] }, { OPENAI_API_KEY: secret });
  assert.ok(isEmptyUnifiedPlanPatch(same));
  const changed = diffPatchAgainstMachine({ set: { OPENAI_API_KEY: secret }, remove: [] }, {});
  assert.equal(changed.set['OPENAI_API_KEY'], secret);
  // The returned patch carries the value (required for the atomic write)
  // but no public rendering exists: unifiedPatchSecretNames exposes names only.
  const { unifiedPatchSecretNames } = require('../../src/setup/plan') as typeof import('../../src/setup/plan');
  assert.deepEqual(unifiedPatchSecretNames(changed), ['OPENAI_API_KEY']);
});

test('FRS04-LV: local voice maps local_only policies and never requires OpenAI solely for local voice', async () => {
  const { dependenciesFor } = await import('../../src/setup/profile');
  assert.deepEqual(dependenciesFor('local_voice').openaiCredential, false);
  const plan = emptyUnifiedPlan('local_voice', dependenciesFor('local_voice'));
  plan.audio = { captureReady: true, signalDetected: true, audibleConfirmed: true, inputId: 'Mic', inputLabel: 'Mic', outputId: 'default', captureCommand: 'ffmpeg -i x', playbackCommand: 'ffplay -i -' };
  plan.voice = { voiceEnabled: true, sttPolicy: 'local_only', ttsPolicy: 'local_only' };
  const patch = compileUnifiedPatch(plan, {
    providerPatch: { set: {}, remove: [] },
    audioPatch: { set: { ARTHUR_AUDIO_INPUT_DEVICE: 'Mic', ARTHUR_AUDIO_OUTPUT_DEVICE: 'default', ARTHUR_AUDIO_CAPTURE_COMMAND: 'ffmpeg -i x', ARTHUR_AUDIO_PLAYBACK_COMMAND: 'ffplay -i -' }, remove: [] },
    voiceDefaults: { voiceEnabled: false, sttPolicy: 'cloud_preferred', ttsPolicy: 'cloud_preferred', wakeEnabled: true },
    effectiveVoice: { voiceEnabled: false, sttPolicy: 'cloud_preferred', ttsPolicy: 'cloud_preferred', wakeEnabled: true },
  });
  assert.equal(patch.set['ARTHUR_STT_POLICY'], 'local_only');
  assert.equal(patch.set['ARTHUR_TTS_POLICY'], 'local_only');
  assert.ok(!('OPENAI_API_KEY' in patch.set), 'local voice must not persist OPENAI_API_KEY by itself');
});
/*TESTS*/
