/**
 * FRS-04: unified `arthur setup` wizard (presentation + prompts only).
 *
 * All business logic lives in src/setup (profiles, plan compiler,
 * orchestration over shared domain planners). This module renders the
 * consumer-facing flow, wires real seams (domain readiness/validators,
 * HR-02.5 model services, FRS-02 secret tap), and performs the single
 * atomic commit. Like providers/audio it never loads App or SQLite.
 */

import { ArthurError } from '../../src/core/errors/errors';
import { CliExit } from '../../src/cli_exit';
import { readMachineConfig, updateMachineConfig } from '../../src/config/machine_config';
import { DEFAULT_VOICE_SETTINGS } from '../../src/voice/config';
import { WindowsFfmpegAudioBackend } from '../../src/audio/ffmpeg_win';
import { validateCaptureTransport, validatePlaybackTransport } from '../../src/audio/validate';
import { checkDeepSeekReadiness } from '../../src/providers/deepseek_readiness';
import { validatePlanSecrets } from '../../src/providers/setup_plan';
import { createNodeSecretTty, readSecret } from '../../src/providers/secret_input';
import { applyUnifiedPlan, effectiveConfigOf, effectiveVoiceOf, runUnifiedSetupFlow, UnifiedSetupCancelled } from '../../src/setup/unified_setup';
import { dependenciesForCustom, deriveCurrentProfile, PROFILE_DESCRIPTIONS, PROFILE_LABELS } from '../../src/setup/profile';
import type { CustomVoiceChoices, SetupProfile } from '../../src/setup/profile';
import type { UnifiedMachinePatch } from '../../src/setup/plan';
import { getLocalModelCatalog } from '../../src/runtime/local-models/catalog';
import { evaluateCompatibility } from '../../src/runtime/local-models/compatibility';
import { recommendModel } from '../../src/runtime/local-models/recommendation';
import { SystemHardwareProbe } from '../../src/runtime/hardware/probe';
import { LocalModelStateStore } from '../../src/runtime/local-models/state_store';
import { ModelInstallationService } from '../../src/runtime/local-models/install_service';
import { createDefaultModelInstallerRegistry } from '../../src/runtime/local-models/installers/registry';
import { nodeSpawnFn } from '../../src/runtime/local-models/provisioning/process_runner';
import { nodeProvisioningFs } from '../../src/runtime/local-models/provisioning/staging';
import { nodeVenvFs } from '../../src/runtime/local-models/provisioning/python';
import { resolveLocalModelPaths } from '../../src/runtime/local-models/provisioning/paths';
import type { Settings } from '../../src/config/settings';
import { loadDotEnv, loadSettings } from '../../src/config/settings';
import { validateSettings } from '../../src/config/validation';
import type { CliIO } from './index';
import { askConfirm, askSelection, readLine, heading } from './setup_ui';

export const UNIFIED_SETUP_HELP = [
  'ARTHUR setup - unified first-run wizard (FRS-04)',
  '',
  'Usage:',
  '  arthur setup [--json]',
  '',
  '  Interactive first-run/reconfiguration: experience profile, providers,',
  '  audio, local models (when required), activation, Review, one atomic',
  '  Apply. Cancel any time before Apply: zero configuration writes.',
  '',
  '  Local model setup moved to: arthur models setup ...',
  '',
].join('\n');

function isHelp(flags: Map<string, string>, positionals: string[]): boolean {
  return flags.get('help') === 'true' || positionals.includes('--help') || positionals.includes('-h');
}

export interface UnifiedSetupDeps {
  readApprovalLine?: () => Promise<string>;
  tty?: boolean;
  layers?: { ambient: Record<string, string>; repo: Record<string, string>; machine: Record<string, string>; machineConfigPath?: string };
  commitPatch?: (patch: UnifiedMachinePatch) => void;
  modelRoot?: string;
  statePath?: string;
  secretTty?: { isTTY: boolean; write(text: string): void; readKey(): Promise<string> };
  fetchFn?: typeof fetch;
  audioBackend?: { detect(): Promise<{ available: boolean; captureAvailable: boolean; playbackAvailable: boolean }>; listInputDevices(): Promise<Array<{ id: string; label: string; backend: string; alternateName?: string }>>; buildCommands(device: { id: string; label: string; backend: string; alternateName?: string }): { captureCommand: string; playbackCommand: string } };
  captureValidator?: typeof validateCaptureTransport;
  playbackValidator?: typeof validatePlaybackTransport;
  modelSeams?: { recommend(kind: string): Promise<{ modelId: string | null; alreadyReady: boolean; detail: string } | null>; install(modelId: string): Promise<{ ok: boolean; reason: string }> };
}

function snapshotUnifiedLayers(deps: UnifiedSetupDeps): { ambient: Record<string, string>; repo: Record<string, string>; machine: Record<string, string>; machineConfigPath?: string } {
  if (deps.layers) return deps.layers;
  const { loadConfigurationEnvironment } = require('../../src/config/machine_config') as typeof import('../../src/config/machine_config');
  const probe: NodeJS.ProcessEnv = {};
  const resolved = loadConfigurationEnvironment({ repoEnvPath: null, env: probe });
  let repo: Record<string, string> = {};
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    const text = fs.readFileSync('.env', 'utf8');
    const { parseEnv } = require('node:util') as typeof import('node:util');
    repo = parseEnv(text) as Record<string, string>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new ArthurError('INVALID_CONFIG', 'cannot read repo .env');
  }
  return { ambient: { ...(process.env as Record<string, string>) }, repo, machine: readMachineConfig(resolved.machineConfigPath), machineConfigPath: resolved.machineConfigPath };
}

function isInteractiveUnified(deps: UnifiedSetupDeps): boolean {
  if (deps.tty !== undefined) return deps.tty;
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

function realProviderSeams(fetchFn: typeof fetch | undefined, effective: { modelName: string; deepseekBaseUrl: string }): { checkDeepseek(apiKey: string, model: string, baseUrl: string): Promise<{ ready: boolean; category?: string }>; checkOpenai(apiKey: string): Promise<{ sttReady: boolean; ttsReady: boolean; category?: string }> } {
  return {
    checkDeepseek: async (apiKey: string, model: string, baseUrl: string) => {
      const probe = await checkDeepSeekReadiness({ apiKey, model, baseUrl }, fetchFn !== undefined ? { fetchFn } : {});
      return { ready: probe.ready, category: probe.diagnostics[0] !== undefined ? probe.diagnostics[0].category : undefined };
    },
    checkOpenai: async (apiKey: string) => {
      const probes = await validatePlanSecrets({ secrets: { openaiApiKey: apiKey }, choices: {} }, { deepseekApiKey: '', openaiApiKey: apiKey, modelProvider: 'deepseek', modelName: effective.modelName, deepseekBaseUrl: effective.deepseekBaseUrl, cloudSttModel: DEFAULT_VOICE_SETTINGS.cloudSttModel, cloudTtsModel: DEFAULT_VOICE_SETTINGS.cloudTtsModel, cloudTtsVoice: DEFAULT_VOICE_SETTINGS.cloudTtsVoice }, fetchFn !== undefined ? { fetchFn } : {});
      return { sttReady: probes.stt !== undefined ? probes.stt.ready : false, ttsReady: probes.tts !== undefined ? probes.tts.ready : false };
    },
  };
}

function realAudioSeams(deps: UnifiedSetupDeps, io: CliIO, ioDeps: { readApprovalLine?: () => Promise<string> }): { detect(): Promise<{ available: boolean; captureAvailable: boolean; playbackAvailable: boolean }>; listInputDevices(): Promise<Array<{ id: string; label: string; backend: string; alternateName?: string }>>; buildCommands(device: { id: string; label: string; backend: string; alternateName?: string }): { captureCommand: string; playbackCommand: string }; validateCapture(command: string): Promise<{ transportReady: boolean; signalDetected: boolean; frames: number; failure?: string }>; validatePlayback(command: string): Promise<{ transportReady: boolean; failure?: string }>; confirmHeard(prompt: string): Promise<boolean> } {
  const backend = deps.audioBackend !== undefined ? deps.audioBackend : new WindowsFfmpegAudioBackend();
  const captureValidator = deps.captureValidator !== undefined ? deps.captureValidator : validateCaptureTransport;
  const playbackValidator = deps.playbackValidator !== undefined ? deps.playbackValidator : validatePlaybackTransport;
  return {
    detect: async () => backend.detect(),
    listInputDevices: async () => backend.listInputDevices(),
    buildCommands: (device: { id: string; label: string; backend: string; alternateName?: string }) => backend.buildCommands(device),
    validateCapture: async (command: string) => {
      const result = await captureValidator(command, {});
      return { transportReady: result.transportReady, signalDetected: result.signalDetected, frames: result.metrics.framesReceived, ...(result.failure !== undefined ? { failure: result.failure } : {}) };
    },
    validatePlayback: async (command: string) => {
      const result = await playbackValidator(command, {});
      return { transportReady: result.transportReady, ...(result.failure !== undefined ? { failure: result.failure } : {}) };
    },
    confirmHeard: async (prompt: string) => askConfirm(io, ioDeps, prompt, 'yes'),
  };
}

function realModelSeams(deps: UnifiedSetupDeps, holder: { config: Settings }, io: CliIO): { recommend(kind: string): Promise<{ modelId: string | null; alreadyReady: boolean; detail: string } | null>; install(modelId: string): Promise<{ ok: boolean; reason: string }> } {
  if (deps.modelSeams) return deps.modelSeams;
  // SAME path policy as `arthur models ...` (modelsContext): explicit voice
  // config (ARTHUR_LOCAL_MODEL_ROOT/STATE env) wins, else ARTHUR_DATA_DIR.
  // This lets an isolated config root reuse canonical managed storage.
  const voice = (holder.config as Settings).voice;
  const { managedRoot, statePath } = resolveLocalModelPaths({
    managedRoot: voice.localModelRoot.trim() !== '' ? voice.localModelRoot : undefined,
    statePath: voice.localModelStatePath.trim() !== '' ? voice.localModelStatePath : undefined,
  });
  return {
    recommend: async (kind: string) => {
      const catalog = getLocalModelCatalog();
      const hardware = await new SystemHardwareProbe().detect();
      const rec = recommendModel({ kind: kind as 'stt' | 'tts', profile: 'quality', hardware, catalog });
      if (!rec.selected) return null;
      const store = LocalModelStateStore.load({ statePath });
      const entry = store.snapshot().models[rec.selected.id];
      const alreadyReady = Boolean(entry && entry.installed && entry.configured && entry.ready);
      return { modelId: rec.selected.id, alreadyReady, detail: rec.reason };
    },
    install: async (modelId: string) => {
      const { runModelsInstall } = await import('./models');
      const { loadSettings } = await import('../../src/config/settings');
      const app = { config: loadSettings() };
      const code = await runModelsInstall(app, { managedRoot, statePath, json: false, io }, modelId, new Map());
      return code === 0 ? { ok: true, reason: 'installed' } : { ok: false, reason: 'install exited ' + String(code) };
    },
  };
}

export async function runUnifiedSetup(flags: Map<string, string>, io: CliIO, deps: UnifiedSetupDeps = {}): Promise<number> {
  if (flags.get('json') === 'true') {
    io.out(JSON.stringify({ ok: false, command: 'setup', code: 'INTERACTIVE_REQUIRED', message: 'arthur setup requires an interactive terminal; rerun without --json on a TTY' }, null, 2) + '\n');
    return CliExit.USAGE;
  }
  for (const key of flags.keys()) {
    const lower = key.toLowerCase();
    if (lower.includes('key') || lower.includes('secret') || lower.includes('token') || lower.includes('password')) {
      io.err('error [INVALID_REQUEST]: provider secrets must be entered interactively, never as command-line flags\n');
      return CliExit.USAGE;
    }
  }
  // Old local-model flags are NOT silently reinterpreted: direct migration.
  for (const legacy of ['stt-model', 'tts-model', 'root', 'state', 'python', 'yes']) {
    if (flags.has(legacy)) {
      io.err('Local model setup moved to: arthur models setup ... (rerun with that command)\n');
      return CliExit.USAGE;
    }
  }
  if (!isInteractiveUnified(deps)) {
    io.err('error [INVALID_REQUEST]: arthur setup requires an interactive terminal\n');
    return CliExit.USAGE;
  }
  const layers = snapshotUnifiedLayers(deps);
  const ioDeps = deps.readApprovalLine !== undefined ? { readApprovalLine: deps.readApprovalLine } : {};
  try {
    return await runUnifiedSetupInteractive(io, deps, layers, ioDeps);
  } catch (err) {
    if (err instanceof UnifiedSetupCancelled) { io.out(err.message + '\n'); return CliExit.INTERNAL; }
    throw err;
  }
}

async function runUnifiedSetupInteractive(io: CliIO, deps: UnifiedSetupDeps, layers: { ambient: Record<string, string>; repo: Record<string, string>; machine: Record<string, string>; machineConfigPath?: string }, ioDeps: { readApprovalLine?: () => Promise<string> }): Promise<number> {
  heading(io, 'ARTHUR Setup');
  io.out('\nSystem\n');
  const backend = deps.audioBackend !== undefined ? deps.audioBackend : new WindowsFfmpegAudioBackend();
  const sysInfo = await backend.detect();
  io.out('  Windows: ' + (process.platform === 'win32' ? 'READY' : 'other (' + process.platform + ')') + '\n');
  io.out('  ffmpeg: ' + (sysInfo.captureAvailable ? 'READY' : 'MISSING') + '\n');
  io.out('  ffplay: ' + (sysInfo.playbackAvailable ? 'READY' : 'MISSING') + '\n');
  const effective = effectiveConfigOf(layers);
  const voice = effectiveVoiceOf(layers);
  // Experience picker with current-state preselection.
  const current = deriveCurrentProfile({ voiceEnabled: voice.voiceEnabled, sttPolicy: voice.sttPolicy, ttsPolicy: voice.ttsPolicy, audioConfigured: voice.audioConfigured });
  const order: SetupProfile[] = ['cloud_voice', 'local_voice', 'text_only', 'custom'];
  io.out('\nExperience\n');
  order.forEach((p, i) => {
    const marker = p === current ? ' (current)' : p === 'cloud_voice' ? ' (recommended)' : '';
    io.out('  [' + String(i + 1) + '] ' + PROFILE_LABELS[p] + marker + '\n');
    io.out('      ' + PROFILE_DESCRIPTIONS[p] + '\n');
  });
  io.out('\n');
  const defProfile = current !== null ? order.indexOf(current) : 0;
  const picked = await askSelection(io, ioDeps, 'Select experience', order.length, defProfile);
  const profile = order[picked] as SetupProfile;
  let custom: CustomVoiceChoices | undefined;
  if (profile === 'custom') {
    io.out('\nCustom\n');
    const sttIdx = await askSelection(io, ioDeps, 'Speech recognition (1: OpenAI, 2: local)', 2, 0);
    const ttsIdx = await askSelection(io, ioDeps, 'Speech output (1: OpenAI, 2: local)', 2, 0);
    custom = { stt: sttIdx === 0 ? 'openai' : 'local', tts: ttsIdx === 0 ? 'openai' : 'local', audio: true };
    if (custom.stt === 'local' || custom.tts === 'local') {
      custom.audio = await askConfirm(io, ioDeps, 'Configure local audio devices?', 'yes');
    } else {
      custom.audio = await askConfirm(io, ioDeps, 'Configure cloud voice audio devices?', 'yes');
    }
  }
  // Shared prompt seams (FRS-02 secret tap reused; closed in finally).
  const tap = deps.secretTty !== undefined ? undefined : createNodeSecretTty();
  const secretTty = deps.secretTty !== undefined ? deps.secretTty : (tap !== undefined ? tap.tty : undefined);
  const prompts = {
    confirm: async (prompt: string, def: boolean) => askConfirm(io, ioDeps, prompt, def ? 'yes' : 'no'),
    select: async (prompt: string, count: number, defIndex: number) => askSelection(io, ioDeps, prompt, count, defIndex),
    secret: async (label: string) => {
      if (!secretTty) throw new ArthurError('INVALID_REQUEST', 'no interactive secret input available');
      io.out('\n');
      return readSecret(secretTty, { label });
    },
  };
  const audioSeams = realAudioSeams(deps, io, ioDeps);
  // Voice path overrides ONLY (ARTHUR_LOCAL_MODEL_ROOT/STATE env): no
  // settings validation here — a fresh machine has no valid settings yet
  // (that is why setup exists). The unified path stays config-only like
  // providers/audio (no App, no DB).
  loadDotEnv();
  const holder = { config: loadSettings() };
  const modelSeams = realModelSeams(deps, holder, io);
  const providerSeams = realProviderSeams(deps.fetchFn, effective);
  let flow;
  try {
    flow = await runUnifiedSetupFlow({
      profile,
      ...(custom !== undefined ? { custom } : {}),
      layers,
      seams: { prompts, providers: providerSeams, audio: audioSeams, models: modelSeams, ...(deps.commitPatch !== undefined ? { commitPatch: deps.commitPatch } : {}) },
      out: (text: string) => io.out(text),
      select: prompts.select,
    });
  } finally {
    try { tap !== undefined ? tap.close() : undefined; } catch { /* cleanup best effort */ }
  }
  // Activation (voice profiles only): PTT default, optional wake.
  if (profile !== 'text_only') {
    io.out('\nActivation\n');
    const wake = await askConfirm(io, ioDeps, 'Enable wake word in addition to push-to-talk?', voice.wakeEnabled ? 'yes' : 'no');
    flow.plan.voice.wakeEnabled = wake;
    if (wake) io.out('Wake word + push-to-talk will be enabled. Wake calibration is a separate step.\n');
    else io.out('Push-to-talk only.\n');
  }
  renderReview(io, flow.plan, profile);
  const apply = await askConfirm(io, ioDeps, 'Apply this setup?', 'yes');
  if (apply !== true) { io.out('Discarded. No changes were made.\n'); return CliExit.SUCCESS; }
  io.out('Applying...\n');
  const commit = deps.commitPatch !== undefined ? deps.commitPatch : (patch: UnifiedMachinePatch) => {
    if (layers.machineConfigPath !== undefined) updateMachineConfig({ set: patch.set, remove: patch.remove.length > 0 ? patch.remove : undefined }, layers.machineConfigPath);
    else updateMachineConfig({ set: patch.set, remove: patch.remove.length > 0 ? patch.remove : undefined });
  };
  const result = await applyUnifiedPlan(flow.plan, layers, { prompts, providers: providerSeams, audio: audioSeams, models: modelSeams, commitPatch: commit }, (text: string) => io.out(text));
  if (result.committed !== true) {
    if (result.installs.some((i) => i.ok !== true)) return CliExit.VALIDATION_FAILED;
    if (result.patch.set !== undefined && Object.keys(result.patch.set).length === 0) { io.out('Nothing to save: configuration already matches the requested state.\n'); return CliExit.SUCCESS; }
    return CliExit.INTERNAL;
  }
  io.out('ok Providers ready\n');
  io.out('ok Audio ' + (flow.plan.dependencies.audio ? 'ready' : 'not required') + '\n');
  io.out('ok Voice ' + (profile === 'text_only' ? 'text only' : 'configured') + '\n');
  io.out('ok Local models ' + (flow.plan.localModels.length === 0 ? 'not required' : 'ready') + '\n');
  io.out('\nARTHUR is ready. Try: arthur voice --mode personal\n');
  return CliExit.SUCCESS;
}

function renderReview(io: CliIO, plan: { profile: SetupProfile; providers: { deepseekSource: string; openaiSource: string }; audio: { inputLabel?: string; captureReady: boolean; audibleConfirmed: boolean | string }; localModels: Array<{ modelId: string; alreadyReady: boolean }> }, profile: SetupProfile): void {
  void profile;
  io.out('\nARTHUR Setup Review\n\n');
  io.out('Experience\n  ' + PROFILE_LABELS[plan.profile] + '\n\n');
  io.out('Reasoning\n  DeepSeek\n  Credential: ' + (plan.providers.deepseekSource === 'absent' ? 'NOT CONFIGURED' : 'configured (' + plan.providers.deepseekSource + ')') + '\n\n');
  const sttText = plan.profile === 'local_voice' ? 'local' : plan.profile === 'custom' ? 'chosen' : plan.profile === 'text_only' ? '(not used)' : 'OpenAI';
  const ttsText = sttText;
  io.out('Speech recognition\n  ' + sttText + '\n\n');
  io.out('Speech output\n  ' + ttsText + '\n\n');
  io.out('Audio\n');
  if (plan.audio.inputLabel !== undefined) {
    io.out('  Input:  ' + plan.audio.inputLabel + '\n');
    io.out('  Output: System default\n');
    io.out('  Capture:  ' + (plan.audio.captureReady ? 'READY' : 'NOT READY') + '\n');
    io.out('  Playback: ' + (plan.audio.audibleConfirmed === true ? 'READY (confirmed)' : plan.audio.audibleConfirmed === false ? 'transport only (not confirmed)' : 'unknown') + '\n');
  } else { io.out('  (not configured)\n'); }
  io.out('\nLocal models\n');
  if (plan.localModels.length === 0) io.out('  None required\n');
  else { for (const m of plan.localModels) io.out('  ' + m.modelId + (m.alreadyReady ? ' (already installed)' : ' (download required)') + '\n'); }
  io.out('\nActivation\n');
  io.out('  Voice: ' + (plan.profile === 'text_only' ? 'disabled' : 'enabled') + '\n');
  io.out('  Mode: ' + (plan.profile === 'text_only' ? '(none)' : 'push-to-talk (+ wake if chosen)') + '\n\n');
}

export async function runSetupCommand(flags: Map<string, string>, positionals: string[], io: CliIO, deps: UnifiedSetupDeps = {}): Promise<number> {
  if (isHelp(flags, positionals)) { io.out(UNIFIED_SETUP_HELP); return CliExit.SUCCESS; }
  return runUnifiedSetup(flags, io, deps);
}
/*DISPATCH*/
