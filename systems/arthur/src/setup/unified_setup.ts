/**
 * FRS-04: unified setup orchestration over SHARED domain planners.
 *
 * No CLI-to-CLI shelling and no second implementations: provider steps use
 * src/providers (credential states, readiness checks, patch compiler),
 * audio steps use src/audio (backend, validators, command builders), and
 * model steps use the HR-02.5 domain services (catalog, recommendation,
 * install/select/status). This module owns ONLY the dependency-driven
 * question flow and the in-memory UnifiedSetupPlan. Presentation lives in
 * apps/cli/setup_unified.ts.
 */

import { resolveCredentialState } from '../providers/credentials';
import { DEEPSEEK_DEFAULT_MODEL } from '../providers/setup_plan';
import { compileMachinePatch, emptySetupPlan } from '../providers/setup_plan';
import { validatePlanSecrets } from '../providers/setup_plan';
import type { EffectiveConfig } from '../providers/setup_plan';
import { dependenciesFor, dependenciesForCustom, deriveCurrentProfile, isSetupProfile } from './profile';
import type { CustomVoiceChoices, ProfileDependencies, SetupProfile } from './profile';
import { compileUnifiedPatch, diffPatchAgainstMachine, emptyUnifiedPlan, isEmptyUnifiedPlanPatch } from './plan';
import type { UnifiedMachinePatch, UnifiedSetupPlan } from './plan';
import { DEFAULT_VOICE_SETTINGS } from '../voice/config';
import { DEEPSEEK_DEFAULT_BASE_URL } from '../models/providers/deepseek';

export class UnifiedSetupCancelled extends Error {
  constructor() { super('Setup cancelled. No configuration changes were saved.'); this.name = 'UnifiedSetupCancelled'; }
}

export interface SetupLayers {
  ambient: Record<string, string>;
  repo: Record<string, string>;
  machine: Record<string, string>;
  machineConfigPath?: string;
}

export interface PromptSeams {
  confirm(prompt: string, def: boolean): Promise<boolean>;
  select(prompt: string, count: number, defIndex: number): Promise<number>;
  secret(label: string): Promise<{ kind: string; value?: string }>;
}

export interface ProviderCheckSeams {
  checkDeepseek(apiKey: string, model: string, baseUrl: string): Promise<{ ready: boolean; category?: string }>;
  checkOpenai(apiKey: string): Promise<{ sttReady: boolean; ttsReady: boolean; category?: string }>;
}

export interface AudioCheckSeams {
  detect(): Promise<{ available: boolean; captureAvailable: boolean; playbackAvailable: boolean }>;
  listInputDevices(): Promise<Array<{ id: string; label: string; backend: string; alternateName?: string }>>;
  buildCommands(device: { id: string; label: string; backend: string; alternateName?: string }): { captureCommand: string; playbackCommand: string };
  validateCapture(command: string): Promise<{ transportReady: boolean; signalDetected: boolean; frames: number; failure?: string }>;
  validatePlayback(command: string): Promise<{ transportReady: boolean; failure?: string }>;
  confirmHeard(prompt: string): Promise<boolean>;
}

export interface ModelPlanSeams {
  recommend(kind: string): Promise<{ modelId: string | null; alreadyReady: boolean; detail: string } | null>;
  install(modelId: string): Promise<{ ok: boolean; reason: string }>;
}

export interface UnifiedSetupSeams {
  prompts: PromptSeams;
  providers: ProviderCheckSeams;
  audio: AudioCheckSeams;
  models: ModelPlanSeams;
  commitPatch?: (patch: UnifiedMachinePatch) => void;
}

export function effectiveConfigOf(layers: SetupLayers): EffectiveConfig {
  const pick = (name: string, fallback: string): string => {
    const a = layers.ambient[name];
    if (typeof a === 'string') { if (a !== '') return a; }
    const r = layers.repo[name];
    if (typeof r === 'string') { if (r !== '') return r; }
    const m = layers.machine[name];
    if (typeof m === 'string') { if (m !== '') return m; }
    return fallback;
  };
  return {
    deepseekApiKey: pick('DEEPSEEK_API_KEY', ''),
    openaiApiKey: pick('OPENAI_API_KEY', ''),
    modelProvider: pick('ARTHUR_MODEL_PROVIDER', 'fake'),
    modelName: pick('ARTHUR_MODEL_NAME', ''),
    deepseekBaseUrl: pick('DEEPSEEK_BASE_URL', DEEPSEEK_DEFAULT_BASE_URL),
    cloudSttModel: pick('ARTHUR_CLOUD_STT_MODEL', DEFAULT_VOICE_SETTINGS.cloudSttModel),
    cloudTtsModel: pick('ARTHUR_CLOUD_TTS_MODEL', DEFAULT_VOICE_SETTINGS.cloudTtsModel),
    cloudTtsVoice: pick('ARTHUR_CLOUD_TTS_VOICE', DEFAULT_VOICE_SETTINGS.cloudTtsVoice),
  };
}

export function effectiveVoiceOf(layers: SetupLayers): { voiceEnabled: boolean; sttPolicy: string; ttsPolicy: string; wakeEnabled: boolean; audioConfigured: boolean } {
  const boolOf = (name: string, fallback: boolean): boolean => {
    const raw = layers.ambient[name] !== undefined ? layers.ambient[name] : layers.repo[name] !== undefined ? layers.repo[name] : layers.machine[name];
    if (raw === undefined || raw === '') return fallback;
    const v = (raw as string).toLowerCase();
    return v === 'true' || v === '1' || v === 'yes' || v === 'on';
  };
  const strOf = (name: string, fallback: string): string => {
    const a = layers.ambient[name];
    if (typeof a === 'string') { if (a !== '') return a; }
    const r = layers.repo[name];
    if (typeof r === 'string') { if (r !== '') return r; }
    const m = layers.machine[name];
    if (typeof m === 'string') { if (m !== '') return m; }
    return fallback;
  };
  return {
    voiceEnabled: boolOf('ARTHUR_VOICE_ENABLED', DEFAULT_VOICE_SETTINGS.voiceEnabled),
    sttPolicy: strOf('ARTHUR_STT_POLICY', DEFAULT_VOICE_SETTINGS.sttPolicy),
    ttsPolicy: strOf('ARTHUR_TTS_POLICY', DEFAULT_VOICE_SETTINGS.ttsPolicy),
    wakeEnabled: boolOf('ARTHUR_WAKE_ENABLED', DEFAULT_VOICE_SETTINGS.wakeEnabled),
    audioConfigured: strOf('ARTHUR_AUDIO_CAPTURE_COMMAND', '') !== '',
  };
}

async function readSecretValue(prompts: PromptSeams, label: string): Promise<string | undefined> {
  const result = await prompts.secret(label);
  if (result.kind === 'cancelled') throw new UnifiedSetupCancelled();
  if (result.kind === 'empty') return undefined;
  return result.value as string;
}

async function ensureDeepseek(plan: UnifiedSetupPlan, layers: SetupLayers, effective: EffectiveConfig, seams: UnifiedSetupSeams, out: (text: string) => void): Promise<void> {
  const state = resolveCredentialState('DEEPSEEK_API_KEY', layers);
  plan.providers.deepseekSource = state.configured ? state.source : 'absent';
  let entered: string | undefined;
  if (state.configured) {
    if (state.machinePersisted) {
      const replace = await seams.prompts.confirm('Replace the saved DeepSeek credential?', false);
      if (replace) entered = await readSecretValue(seams.prompts, 'DeepSeek API key');
    } else {
      const keep = await seams.prompts.confirm('Keep using the current external DeepSeek credential (not saved)?', true);
      if (keep) { plan.providers.deepseekValidated = 'skipped'; return; }
      entered = await readSecretValue(seams.prompts, 'DeepSeek API key');
    }
  } else {
    entered = await readSecretValue(seams.prompts, 'DeepSeek API key');
  }
  if (entered === undefined) {
    // Declining a replacement (or keeping an external credential) means the
    // existing credential stands — not an abort, not an empty entry.
    if (state.configured) { plan.providers.deepseekValidated = 'skipped'; return; }
    out('No key entered; DeepSeek left unconfigured.\n');
    return;
  }
  out('Checking DeepSeek...\n');
  const model = effective.modelName !== '' ? effective.modelName : DEEPSEEK_DEFAULT_MODEL;
  const probe = await seams.providers.checkDeepseek(entered, model, effective.deepseekBaseUrl);
  if (probe.ready) {
    out('ok DeepSeek READY\n');
    plan.secrets.deepseekApiKey = entered;
    plan.providers.deepseekValidated = 'ready';
    plan.providers.deepseekSource = 'machine_config';
    if (effective.modelProvider !== 'deepseek') plan.providers.modelProvider = 'deepseek';
    if (effective.modelName === '') plan.providers.modelName = DEEPSEEK_DEFAULT_MODEL;
    return;
  }
  out('DeepSeek validation failed (' + (probe.category !== undefined ? probe.category : 'network') + '). The key was NOT saved.\n');
  const retry = await seams.prompts.confirm('Retry DeepSeek key entry?', true);
  if (retry) {
    const second = await readSecretValue(seams.prompts, 'DeepSeek API key');
    if (second === undefined) return;
    out('Checking DeepSeek...\n');
    const probe2 = await seams.providers.checkDeepseek(second, model, effective.deepseekBaseUrl);
    if (probe2.ready) {
      out('ok DeepSeek READY\n');
      plan.secrets.deepseekApiKey = second;
      plan.providers.deepseekValidated = 'ready';
      plan.providers.deepseekSource = 'machine_config';
      if (effective.modelProvider !== 'deepseek') plan.providers.modelProvider = 'deepseek';
      if (effective.modelName === '') plan.providers.modelName = DEEPSEEK_DEFAULT_MODEL;
      return;
    }
    out('DeepSeek validation failed again; DeepSeek left unconfigured.\n');
  }
}

async function ensureOpenai(plan: UnifiedSetupPlan, layers: SetupLayers, seams: UnifiedSetupSeams, out: (text: string) => void): Promise<void> {
  const state = resolveCredentialState('OPENAI_API_KEY', layers);
  plan.providers.openaiSource = state.configured ? state.source : 'absent';
  let entered: string | undefined;
  if (state.configured) {
    if (state.machinePersisted) {
      const replace = await seams.prompts.confirm('Replace the saved OpenAI credential?', false);
      if (replace) entered = await readSecretValue(seams.prompts, 'OpenAI API key');
    } else {
      const keep = await seams.prompts.confirm('Keep using the current external OpenAI credential (not saved)?', true);
      if (keep) { plan.providers.openaiSttReady = true; plan.providers.openaiTtsReady = true; return; }
      entered = await readSecretValue(seams.prompts, 'OpenAI API key');
    }
  } else {
    entered = await readSecretValue(seams.prompts, 'OpenAI API key');
  }
  if (entered === undefined) {
    if (state.configured) { plan.providers.openaiSttReady = true; plan.providers.openaiTtsReady = true; return; }
    out('No key entered; OpenAI left unconfigured.\n');
    return;
  }
  out('Checking OpenAI...\n');
  const probe = await seams.providers.checkOpenai(entered);
  out((probe.sttReady ? 'ok' : 'xx') + ' STT provider\n');
  out((probe.ttsReady ? 'ok' : 'xx') + ' TTS provider\n');
  if (probe.sttReady && probe.ttsReady) {
    plan.secrets.openaiApiKey = entered;
    plan.providers.openaiSttReady = true;
    plan.providers.openaiTtsReady = true;
    plan.providers.openaiSource = 'machine_config';
    return;
  }
  out('OpenAI validation failed; the key was NOT saved.\n');
  const retry = await seams.prompts.confirm('Retry OpenAI key entry?', true);
  if (retry) {
    const second = await readSecretValue(seams.prompts, 'OpenAI API key');
    if (second === undefined) return;
    out('Checking OpenAI...\n');
    const probe2 = await seams.providers.checkOpenai(second);
    out((probe2.sttReady ? 'ok' : 'xx') + ' STT provider\n');
    out((probe2.ttsReady ? 'ok' : 'xx') + ' TTS provider\n');
    if (probe2.sttReady && probe2.ttsReady) {
      plan.secrets.openaiApiKey = second;
      plan.providers.openaiSttReady = true;
      plan.providers.openaiTtsReady = true;
      plan.providers.openaiSource = 'machine_config';
      return;
    }
    out('OpenAI validation failed again; OpenAI left unconfigured.\n');
  }
}

async function ensureAudio(plan: UnifiedSetupPlan, layers: SetupLayers, seams: UnifiedSetupSeams, out: (text: string) => void, select: (prompt: string, count: number, defIndex: number) => Promise<number>): Promise<void> {
  out('Detecting audio...\n');
  const info = await seams.audio.detect();
  out('  ffmpeg: ' + (info.captureAvailable ? 'READY' : 'MISSING') + '\n');
  out('  ffplay: ' + (info.playbackAvailable ? 'READY' : 'MISSING') + '\n');
  if (info.available !== true) { out('Audio backend unavailable; voice setup cannot continue.\n'); throw new UnifiedSetupCancelled(); }
  const inputs = await seams.audio.listInputDevices();
  if (inputs.length === 0) { out('No microphones detected.\n'); throw new UnifiedSetupCancelled(); }
  const saved = layers.machine['ARTHUR_AUDIO_INPUT_DEVICE'];
  let defIndex = 0;
  if (typeof saved === 'string') {
    const found = inputs.findIndex((d) => d.id === saved);
    if (found === -1) { out('Note: configured microphone is unavailable; choose a replacement.\n'); }
    else { defIndex = found; }
  }
  inputs.forEach((d, i) => { out('  [' + String(i + 1) + '] ' + d.label + (i === defIndex && typeof saved === 'string' && saved !== '' ? ' (current)' : '') + '\n'); });
  const picked = await select('Select microphone', inputs.length, defIndex);
  const device = inputs[picked] as { id: string; label: string };
  const commands = seams.audio.buildCommands({ id: device.id, label: device.label, backend: (device as { backend?: string }).backend !== undefined ? (device as { backend?: string }).backend as string : 'ffmpeg-dshow', ...(((device as { alternateName?: string }).alternateName !== undefined) ? { alternateName: (device as { alternateName?: string }).alternateName as string } : {}) });
  plan.audio.inputId = device.id;
  plan.audio.inputLabel = device.label;
  plan.audio.outputId = 'default';
  plan.audio.captureCommand = commands.captureCommand;
  plan.audio.playbackCommand = commands.playbackCommand;
  out('Testing microphone...\n');
  const capture = await seams.audio.validateCapture(commands.captureCommand);
  if (capture.transportReady !== true) {
    out('Microphone test failed (' + (capture.failure !== undefined ? capture.failure : 'no audio') + ').\n');
    throw new UnifiedSetupCancelled();
  }
  out('ok audio frames received (' + String(capture.frames) + ' frames)\n');
  plan.audio.captureReady = true;
  plan.audio.signalDetected = capture.signalDetected;
  if (capture.signalDetected !== true) out('Note: input silent/very-low (transport ready)\n');
  out('Testing speaker...\n');
  const playback = await seams.audio.validatePlayback(commands.playbackCommand);
  if (playback.transportReady !== true) {
    out('Speaker test failed (' + (playback.failure !== undefined ? playback.failure : 'player error') + ').\n');
    throw new UnifiedSetupCancelled();
  }
  out('Tone played.\n');
  const heard = await seams.audio.confirmHeard('Did you hear the tone?');
  plan.audio.audibleConfirmed = heard;
  out(heard ? 'ok playback confirmed\n' : 'Note: audible output unconfirmed.\n');
}

async function ensureLocalModels(plan: UnifiedSetupPlan, seams: UnifiedSetupSeams, out: (text: string) => void, select: (prompt: string, count: number, defIndex: number) => Promise<number>): Promise<void> {
  const needed: string[] = [];
  if (plan.dependencies.localSttModel) needed.push('stt');
  if (plan.dependencies.localTtsModel) needed.push('tts');
  for (const kind of needed) {
    const rec = await seams.models.recommend(kind);
    if (rec === null || rec.modelId === null) { out('No compatible local ' + kind.toUpperCase() + ' model for this hardware.\n'); throw new UnifiedSetupCancelled(); }
    out('Local ' + kind.toUpperCase() + ': ' + rec.modelId + (rec.alreadyReady ? ' (already installed)' : ' (download required)') + '\n');
    plan.localModels.push({ kind, modelId: rec.modelId, via: 'recommended', alreadyReady: rec.alreadyReady });
  }
  void select;
}

export interface UnifiedSetupResult {
  exitCode: number;
  plan: UnifiedSetupPlan;
  patch: UnifiedMachinePatch;
  installs: Array<{ modelId: string; ok: boolean; reason: string }>;
  committed: boolean;
  /** True when the semantic config delta was non-empty (a write occurred or was required). */
  configChanged: boolean;
  /** True when at least one model install/download action ran (not already-installed). */
  modelActionsOccurred: boolean;
}

export async function runUnifiedSetupFlow(args: { profile: SetupProfile; custom?: CustomVoiceChoices; layers: SetupLayers; seams: UnifiedSetupSeams; out: (text: string) => void; select: (prompt: string, count: number, defIndex: number) => Promise<number> }): Promise<UnifiedSetupResult> {
  const deps = args.profile === 'custom' && args.custom !== undefined ? dependenciesForCustom(args.custom) : dependenciesFor(args.profile);
  const plan = emptyUnifiedPlan(args.profile, deps);
  const effective = effectiveConfigOf(args.layers);
  const out = args.out;
  const select = args.select;
  // Providers (dependency-driven; irrelevant credentials never asked).
  if (deps.deepseekCredential) {
    out('\nProviders\n');
    await ensureDeepseek(plan, args.layers, effective, args.seams, out);
    if (plan.providers.deepseekValidated !== 'ready' && plan.providers.deepseekValidated !== 'skipped') throw new UnifiedSetupCancelled();
  }
  if (deps.openaiCredential) {
    await ensureOpenai(plan, args.layers, args.seams, out);
    if (plan.providers.openaiSttReady !== true || plan.providers.openaiTtsReady !== true) {
      const needed = args.profile === 'cloud_voice' || (args.custom !== undefined && (args.custom.stt === 'openai' || args.custom.tts === 'openai'));
      if (needed) throw new UnifiedSetupCancelled();
    }
  }
  // Audio.
  if (deps.audio) {
    out('\nAudio\n');
    await ensureAudio(plan, args.layers, args.seams, out, select);
  }
  // Local models (planned now, installed after Apply).
  if (deps.localSttModel || deps.localTtsModel) {
    out('\nLocal models\n');
    await ensureLocalModels(plan, args.seams, out, select);
  }
  // Voice policy mapping (existing keys only).
  const sttLocal = deps.localSttModel;
  const ttsLocal = deps.localTtsModel;
  if (args.profile === 'text_only') {
    if (effectiveVoiceEnabled(args.layers)) plan.voice.voiceEnabled = false;
  } else {
    plan.voice.voiceEnabled = true;
    if (sttLocal) plan.voice.sttPolicy = 'local_only';
    else if (deps.openaiCredential) plan.voice.sttPolicy = 'cloud_preferred';
    if (ttsLocal) plan.voice.ttsPolicy = 'local_only';
    else if (deps.openaiCredential) plan.voice.ttsPolicy = 'cloud_preferred';
  }
  return { exitCode: 0, plan, patch: { set: {}, remove: [] }, installs: [], committed: false, configChanged: false, modelActionsOccurred: false };
}

function effectiveVoiceEnabled(layers: SetupLayers): boolean {
  const raw = layers.ambient['ARTHUR_VOICE_ENABLED'] !== undefined ? layers.ambient['ARTHUR_VOICE_ENABLED'] : layers.repo['ARTHUR_VOICE_ENABLED'] !== undefined ? layers.repo['ARTHUR_VOICE_ENABLED'] : layers.machine['ARTHUR_VOICE_ENABLED'];
  if (raw === undefined || raw === '') return DEFAULT_VOICE_SETTINGS.voiceEnabled;
  const v = raw.toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

export function buildProviderPatch(plan: UnifiedSetupPlan, effective: EffectiveConfig): UnifiedMachinePatch {
  const single = emptySetupPlan();
  if (plan.secrets.deepseekApiKey !== undefined) single.secrets.deepseekApiKey = plan.secrets.deepseekApiKey;
  if (plan.secrets.openaiApiKey !== undefined) single.secrets.openaiApiKey = plan.secrets.openaiApiKey;
  if (plan.providers.modelProvider !== undefined) single.choices.modelProvider = plan.providers.modelProvider;
  if (plan.providers.modelName !== undefined) single.choices.modelName = plan.providers.modelName;
  void effective;
  return compileMachinePatch(single);
}

export function buildAudioPatch(plan: UnifiedSetupPlan): UnifiedMachinePatch {
  if (plan.audio.inputId === undefined || plan.audio.captureCommand === undefined || plan.audio.playbackCommand === undefined) return { set: {}, remove: [] };
  return {
    set: {
      ARTHUR_AUDIO_INPUT_DEVICE: plan.audio.inputId,
      ARTHUR_AUDIO_OUTPUT_DEVICE: 'default',
      ARTHUR_AUDIO_CAPTURE_COMMAND: plan.audio.captureCommand,
      ARTHUR_AUDIO_PLAYBACK_COMMAND: plan.audio.playbackCommand,
    },
    remove: [],
  };
}

export async function applyUnifiedPlan(plan: UnifiedSetupPlan, layers: SetupLayers, seams: UnifiedSetupSeams, out: (text: string) => void): Promise<UnifiedSetupResult> {
  const effective = effectiveConfigOf(layers);
  const voice = effectiveVoiceOf(layers);
  const desired = compileUnifiedPatch(plan, {
    providerPatch: buildProviderPatch(plan, effective),
    audioPatch: buildAudioPatch(plan),
    voiceDefaults: { voiceEnabled: DEFAULT_VOICE_SETTINGS.voiceEnabled, sttPolicy: DEFAULT_VOICE_SETTINGS.sttPolicy, ttsPolicy: DEFAULT_VOICE_SETTINGS.ttsPolicy, wakeEnabled: DEFAULT_VOICE_SETTINGS.wakeEnabled },
    effectiveVoice: { voiceEnabled: voice.voiceEnabled, sttPolicy: voice.sttPolicy, ttsPolicy: voice.ttsPolicy, wakeEnabled: voice.wakeEnabled },
  });
  // Semantic idempotency: prune the desired patch against the persisted
  // MACHINE layer only. "No config changes" never gates model work below.
  const patch = diffPatchAgainstMachine(desired, layers.machine);
  const configChanged = !isEmptyUnifiedPlanPatch(patch);
  // Model installs ALWAYS execute when required (filesystem side effects,
  // honestly reported) — even when the semantic config delta is empty.
  const installs: Array<{ modelId: string; ok: boolean; reason: string }> = [];
  let modelActionsOccurred = false;
  for (const item of plan.localModels) {
    if (item.alreadyReady) { installs.push({ modelId: item.modelId, ok: true, reason: 'already installed' }); continue; }
    modelActionsOccurred = true;
    out('Installing ' + item.modelId + '...\n');
    const result = await seams.models.install(item.modelId);
    installs.push({ modelId: item.modelId, ok: result.ok, reason: result.reason });
    if (result.ok !== true) {
      out('Required model install failed: ' + item.modelId + ' (' + result.reason + '). Configuration was NOT saved.\n');
      return { exitCode: 5, plan, patch, installs, committed: false, configChanged, modelActionsOccurred };
    }
  }
  if (!configChanged) {
    // "No config changes" does not mean "no model work": installs above
    // already ran. Success with committed=false; the CLI renders the
    // already-matches message (worded for whether models were installed).
    return { exitCode: 0, plan, patch, installs, committed: false, configChanged: false, modelActionsOccurred };
  }
  // Exactly ONE atomic config commit after installs succeed.
  try {
    if (seams.commitPatch) seams.commitPatch(patch);
    else {
      const { updateMachineConfig } = require('../config/machine_config') as typeof import('../config/machine_config');
      if (layers.machineConfigPath !== undefined) updateMachineConfig({ set: patch.set, remove: patch.remove.length > 0 ? patch.remove : undefined }, layers.machineConfigPath);
      else updateMachineConfig({ set: patch.set, remove: patch.remove.length > 0 ? patch.remove : undefined });
    }
  } catch (err) {
    out('Setup failed: configuration could not be saved (' + (err instanceof Error ? err.message : String(err)) + '). Installed models were kept.\n');
    return { exitCode: 1, plan, patch, installs, committed: false, configChanged: true, modelActionsOccurred };
  }
  return { exitCode: 0, plan, patch, installs, committed: true, configChanged: true, modelActionsOccurred };
}

export { compileUnifiedPatch, diffPatchAgainstMachine, emptyUnifiedPlan, isEmptyUnifiedPlanPatch };
export type { SetupProfile };
