/**
 * FRS-05: read-only doctor orchestration.
 *
 * Consumes existing domain seams only (FRS-01 config, FRS-02 credentials /
 * readiness, FRS-03 audio, FRS-04 profiles, HR-02.5 selection / resolution).
 * No business logic is reimplemented here: this module derives the current
 * profile's dependency graph and evaluates each dependency through the
 * domain's own functions.
 *
 * STRICTLY READ-ONLY: this module never calls updateMachineConfig(),
 * never installs models, never writes models.json, never initializes DBs,
 * never instantiates App, never spawns the ARTHUR runtime. Filesystem and
 * network access arrive exclusively through the injected inputs / seams;
 * production wiring lives in apps/cli/doctor.ts. Live seams are invoked
 * ONLY when mode.live is true; the audible tone path additionally requires
 * mode.interactive.
 *
 * Every expected diagnostic failure becomes a DoctorCheck result; only
 * structural bugs throw.
 */

import { resolveCredentialState } from '../providers/credentials';
import { DEEPSEEK_DEFAULT_BASE_URL } from '../models/providers/deepseek';
import { DEEPSEEK_DEFAULT_MODEL } from '../providers/setup_plan';
import { failedResult, type ProviderReadiness } from '../providers/readiness';
import { DEFAULT_VOICE_SETTINGS } from '../voice/config';
import { splitCommandLine } from '../voice/process_util';
import {
  dependenciesFor,
  dependenciesForCustom,
  deriveCurrentProfile,
  PROFILE_LABELS,
  type ProfileDependencies,
  type SetupProfile,
} from '../setup/profile';
import { effectiveConfigOf, effectiveVoiceOf, type SetupLayers } from '../setup/unified_setup';
import { resolveEffectiveSelection, resolveRunnableSelection } from '../runtime/local-models/selection';
import { resolveRuntimeTarget } from '../runtime/local-models/runtime/resolution';
import { getLocalModelCatalog } from '../runtime/local-models/catalog';
import type { LocalModelDefinition } from '../runtime/local-models/contracts';
import type { HardwareProfile } from '../runtime/hardware/contracts';
import type { LocalModelStateFile } from '../runtime/local-models/state_contracts';
import type { AudioBackendInfo, AudioDevice } from '../audio/backend';
import type { CaptureValidationResult, PlaybackValidationResult } from '../audio/validate';
import { finalizeDoctorReport } from './aggregate';
import type { DoctorArea, DoctorCheck, DoctorProfile, DoctorReport } from './types';

export const LIVE_CHECK_TIMEOUT_MS = 60_000;

export interface DoctorLayerInput {
  ambient: Record<string, string | undefined>;
  repo: Record<string, string>;
  machine: Record<string, string>;
  machineConfigPath: string;
}

export interface DoctorFileInput {
  configPath: string;
  present: boolean;
  readable: boolean;
  /** Set when the file exists but cannot be parsed (bounded message). */
  malformed?: string;
  entryCount?: number;
  sizeBytes?: number;
}

export interface DoctorAudioInput {
  info: AudioBackendInfo;
  inputs: AudioDevice[];
  /** False on platforms without reliable discovery (e.g. linux/dshow). */
  discoverySupported: boolean;
}

export interface DoctorModelInput {
  statePath: string;
  statePresent: boolean;
  stateError?: string;
  snapshot: LocalModelStateFile | null;
  hardware: HardwareProfile;
  managedRoot: string;
  catalog?: readonly LocalModelDefinition[];
  exists?: (path: string) => boolean;
}

export interface DoctorLiveSeams {
  probeDeepseek?: (input: { apiKey: string; model: string; baseUrl: string }) => Promise<ProviderReadiness>;
  probeOpenaiStt?: (input: { apiKey: string; model: string }) => Promise<ProviderReadiness>;
  probeOpenaiTts?: (input: { apiKey: string; model: string; voice: string }) => Promise<ProviderReadiness>;
  validateCapture?: (command: string) => Promise<CaptureValidationResult>;
  validatePlayback?: (command: string) => Promise<PlaybackValidationResult>;
  confirmHeard?: (prompt: string) => Promise<boolean>;
}

export interface DiagnoseArgs {
  layers: DoctorLayerInput;
  file: DoctorFileInput;
  audio: DoctorAudioInput;
  models: DoctorModelInput;
  live: boolean;
  interactive: boolean;
  seams?: DoctorLiveSeams;
}

function check(
  id: string,
  area: DoctorArea,
  status: DoctorCheck['status'],
  required: boolean,
  message: string,
  extra?: { remediation?: string; details?: Record<string, string | number | boolean>; source?: string },
): DoctorCheck {
  const out: DoctorCheck = { id, area, status, required, message };
  if (extra?.remediation !== undefined) out.remediation = extra.remediation;
  if (extra?.details !== undefined) out.details = extra.details;
  if (extra?.source !== undefined) out.source = extra.source;
  return out;
}

function skipped(id: string, area: DoctorArea, message: string): DoctorCheck {
  return check(id, area, 'skipped', false, message);
}

function layersOf(input: DoctorLayerInput): SetupLayers {
  const ambient: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.ambient)) {
    if (typeof value === 'string') ambient[key] = value;
  }
  return { ambient, repo: { ...input.repo }, machine: { ...input.machine } };
}

function credentialSourceName(source: string): string {
  if (source === 'process_env') return 'environment';
  if (source === 'repo_env') return 'repo .env';
  return 'machine config';
}

async function withLiveTimeout<T>(task: () => Promise<T>, synthesizeTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('live check timed out')), LIVE_CHECK_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return synthesizeTimeout();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function readinessToCheck(
  readiness: ProviderReadiness,
  ids: { passId: string; area: DoctorArea },
  messages: { pass: string; auth: string; missing: string; unreachable: string; invalid: string },
  remediation: string,
): DoctorCheck {
  if (readiness.ready) return check(ids.passId, ids.area, 'pass', true, messages.pass);
  if (readiness.status === 'not_configured') {
    return check(ids.passId, ids.area, 'fail', true, messages.missing, { remediation });
  }
  if (readiness.status === 'auth_failed') {
    return check(ids.passId, ids.area, 'fail', true, messages.auth, { remediation });
  }
  if (readiness.status === 'invalid_config') {
    return check(ids.passId, ids.area, 'fail', true, messages.invalid, { remediation });
  }
  const category = readiness.diagnostics[0]?.category ?? 'network';
  return check(ids.passId, ids.area, 'fail', true, messages.unreachable + ' (' + category + ')');
}

function effectiveCaptureCommand(layers: DoctorLayerInput): string {
  const ambient = layers.ambient['ARTHUR_AUDIO_CAPTURE_COMMAND'];
  if (typeof ambient === 'string' && ambient !== '') return ambient;
  const repo = layers.repo['ARTHUR_AUDIO_CAPTURE_COMMAND'];
  if (typeof repo === 'string' && repo !== '') return repo;
  const machine = layers.machine['ARTHUR_AUDIO_CAPTURE_COMMAND'];
  if (typeof machine === 'string' && machine !== '') return machine;
  return '';
}

function effectivePlaybackCommand(layers: DoctorLayerInput): string {
  const ambient = layers.ambient['ARTHUR_AUDIO_PLAYBACK_COMMAND'];
  if (typeof ambient === 'string' && ambient !== '') return ambient;
  const repo = layers.repo['ARTHUR_AUDIO_PLAYBACK_COMMAND'];
  if (typeof repo === 'string' && repo !== '') return repo;
  const machine = layers.machine['ARTHUR_AUDIO_PLAYBACK_COMMAND'];
  if (typeof machine === 'string' && machine !== '') return machine;
  return '';
}

function effectiveInputId(layers: DoctorLayerInput): string {
  const ambient = layers.ambient['ARTHUR_AUDIO_INPUT_DEVICE'];
  if (typeof ambient === 'string' && ambient !== '') return ambient;
  const repo = layers.repo['ARTHUR_AUDIO_INPUT_DEVICE'];
  if (typeof repo === 'string' && repo !== '') return repo;
  const machine = layers.machine['ARTHUR_AUDIO_INPUT_DEVICE'];
  if (typeof machine === 'string' && machine !== '') return machine;
  return '';
}

/** Extract the device name from a synthesized capture command (existing tokenizer; best effort). */
function captureDeviceOf(command: string): string | null {
  try {
    const argv = splitCommandLine(command);
    const at = argv.indexOf('-i');
    if (at === -1) return null;
    const value = argv[at + 1];
    if (typeof value !== 'string' || !value.startsWith('audio=')) return null;
    return value.slice('audio='.length);
  } catch {
    return null;
  }
}

function depsForProfile(profile: SetupProfile | 'partial', voice: { voiceEnabled: boolean; sttPolicy: string; ttsPolicy: string }): ProfileDependencies {
  if (profile === 'cloud_voice' || profile === 'local_voice' || profile === 'text_only') return dependenciesFor(profile);
  if (profile === 'custom') {
    return dependenciesForCustom({
      stt: voice.sttPolicy === 'local_only' ? 'local' : 'openai',
      tts: voice.ttsPolicy === 'local_only' ? 'local' : 'openai',
      audio: voice.voiceEnabled,
    });
  }
  // Partial: evaluate actual dependencies conservatively from live policy state.
  return {
    deepseekCredential: true,
    openaiCredential: voice.voiceEnabled && (voice.sttPolicy !== 'local_only' || voice.ttsPolicy !== 'local_only'),
    audio: voice.voiceEnabled,
    localSttModel: voice.voiceEnabled && voice.sttPolicy === 'local_only',
    localTtsModel: voice.voiceEnabled && voice.ttsPolicy === 'local_only',
  };
}

export function profileLabel(profile: DoctorProfile): string {
  if (profile === 'unconfigured') return 'Not configured';
  if (profile === 'partial') return 'Custom/partial';
  return PROFILE_LABELS[profile];
}

export async function diagnoseDoctor(args: DiagnoseArgs): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const setupLayers = layersOf(args.layers);
  const effective = effectiveConfigOf(setupLayers);
  const voice = effectiveVoiceOf(setupLayers);

  const derived = deriveCurrentProfile({
    voiceEnabled: voice.voiceEnabled,
    sttPolicy: voice.sttPolicy,
    ttsPolicy: voice.ttsPolicy,
    audioConfigured: effectiveCaptureCommand(args.layers) !== '',
  });

  let profile: DoctorProfile;
  if (!args.file.present) {
    profile = 'unconfigured';
  } else if (derived === null) {
    profile = 'partial';
  } else {
    profile = derived;
  }
  const deps = depsForProfile(profile === 'unconfigured' || profile === 'partial' ? 'partial' : profile, voice);
  const deepseekState = resolveCredentialState('DEEPSEEK_API_KEY', setupLayers);
  const openaiState = resolveCredentialState('OPENAI_API_KEY', setupLayers);

  // ---- Configuration ------------------------------------------------------
  if (!args.file.present) {
    checks.push(
      check('config.present', 'configuration', 'fail', true, 'ARTHUR has not been configured on this machine', {
        remediation: 'arthur setup',
        details: { config_path: args.file.configPath, config_present: false },
      }),
    );
  } else {
    checks.push(
      check('config.present', 'configuration', 'pass', true, 'machine configuration found', {
        details: {
          config_path: args.file.configPath,
          config_present: true,
          ...(args.file.entryCount !== undefined ? { entries: args.file.entryCount } : {}),
        },
      }),
    );
    if (!args.file.readable || args.file.malformed !== undefined) {
      checks.push(
        check('config.parse', 'configuration', 'fail', true, 'machine configuration cannot be read', {
          remediation: 'arthur setup',
          details: { config_path: args.file.configPath },
        }),
      );
    } else {
      checks.push(check('config.parse', 'configuration', 'pass', true, 'machine configuration is valid'));
    }
  }

  // Malformed config: still report credential/config state from effective
  // layers (ambient/repo may carry values), but every required dependency
  // check below runs conservatively against what is known.

  // ---- Reasoning (DeepSeek) ------------------------------------------------
  if (deepseekState.configured) {
    checks.push(
      check('provider.deepseek.credential', 'reasoning', 'pass', true, 'DeepSeek credential configured', {
        source: credentialSourceName(deepseekState.source),
      }),
    );
  } else {
    checks.push(
      check('provider.deepseek.credential', 'reasoning', 'fail', true, 'DeepSeek credential is not configured', {
        remediation: 'arthur providers setup',
        source: 'absent',
      }),
    );
  }
  if (effective.modelProvider === 'deepseek' || effective.modelProvider === 'fake') {
    checks.push(
      check('provider.deepseek.config', 'reasoning', 'pass', true, 'reasoning provider selection is coherent', {
        details: {
          provider: effective.modelProvider,
          model: effective.modelName !== '' ? effective.modelName : '(default)',
        },
      }),
    );
  } else {
    checks.push(
      check('provider.deepseek.config', 'reasoning', 'fail', true, 'unsupported reasoning provider ' + JSON.stringify(effective.modelProvider), {
        remediation: 'arthur providers setup',
        details: { provider: effective.modelProvider },
      }),
    );
  }
  if (args.live) {
    const seams = args.seams ?? {};
    if (seams.probeDeepseek) {
      const model = effective.modelName !== '' ? effective.modelName : DEEPSEEK_DEFAULT_MODEL;
      const baseUrl = effective.deepseekBaseUrl !== '' ? effective.deepseekBaseUrl : DEEPSEEK_DEFAULT_BASE_URL;
      const readiness = await withLiveTimeout(
        () => (seams.probeDeepseek as (input: { apiKey: string; model: string; baseUrl: string }) => Promise<ProviderReadiness>)({
          apiKey: effective.deepseekApiKey,
          model,
          baseUrl,
        }),
        () => failedResult('deepseek', 'reasoning', 'unavailable', 'timeout'),
      );
      checks.push(
        readinessToCheck(
          readiness,
          { passId: 'provider.deepseek.live', area: 'reasoning' },
          {
            pass: 'DeepSeek reachable',
            auth: 'DeepSeek rejected the credential',
            missing: 'DeepSeek credential is not configured',
            unreachable: 'DeepSeek is unreachable',
            invalid: 'DeepSeek rejected the validation request',
          },
          'arthur providers setup',
        ),
      );
    } else {
      checks.push(skipped('provider.deepseek.live', 'reasoning', 'live connectivity not tested'));
    }
  } else {
    checks.push(skipped('provider.deepseek.live', 'reasoning', 'live connectivity not tested'));
  }

  // ---- Speech ---------------------------------------------------------------
  const speechIsLocal = profile === 'local_voice' || (voice.voiceEnabled && voice.sttPolicy === 'local_only' && voice.ttsPolicy === 'local_only');
  if (deps.openaiCredential) {
    if (openaiState.configured) {
      checks.push(
        check('provider.openai.credential', 'speech', 'pass', true, 'OpenAI credential configured', {
          source: credentialSourceName(openaiState.source),
        }),
      );
    } else {
      checks.push(
        check('provider.openai.credential', 'speech', 'fail', true, 'OpenAI credential is not configured', {
          remediation: 'arthur providers setup',
          source: 'absent',
        }),
      );
    }
    if (args.live) {
      const seams = args.seams ?? {};
      if (seams.probeOpenaiStt) {
        const readiness = await withLiveTimeout(
          () => (seams.probeOpenaiStt as (input: { apiKey: string; model: string }) => Promise<ProviderReadiness>)({
            apiKey: effective.openaiApiKey,
            model: effective.cloudSttModel !== '' ? effective.cloudSttModel : DEFAULT_VOICE_SETTINGS.cloudSttModel,
          }),
          () => failedResult('openai-stt', 'cloud_stt', 'unavailable', 'timeout'),
        );
        checks.push(
          readinessToCheck(
            readiness,
            { passId: 'provider.openai.stt.live', area: 'speech' },
            {
              pass: 'OpenAI STT reachable',
              auth: 'OpenAI rejected the credential (STT)',
              missing: 'OpenAI credential is not configured',
              unreachable: 'OpenAI STT is unreachable',
              invalid: 'OpenAI rejected the STT validation request',
            },
            'arthur providers setup',
          ),
        );
      } else {
        checks.push(skipped('provider.openai.stt.live', 'speech', 'STT live check not tested'));
      }
      if (seams.probeOpenaiTts) {
        const readiness = await withLiveTimeout(
          () => (seams.probeOpenaiTts as (input: { apiKey: string; model: string; voice: string }) => Promise<ProviderReadiness>)({
            apiKey: effective.openaiApiKey,
            model: effective.cloudTtsModel !== '' ? effective.cloudTtsModel : DEFAULT_VOICE_SETTINGS.cloudTtsModel,
            voice: effective.cloudTtsVoice !== '' ? effective.cloudTtsVoice : DEFAULT_VOICE_SETTINGS.cloudTtsVoice,
          }),
          () => failedResult('openai-tts', 'cloud_tts', 'unavailable', 'timeout'),
        );
        checks.push(
          readinessToCheck(
            readiness,
            { passId: 'provider.openai.tts.live', area: 'speech' },
            {
              pass: 'OpenAI TTS reachable',
              auth: 'OpenAI rejected the credential (TTS)',
              missing: 'OpenAI credential is not configured',
              unreachable: 'OpenAI TTS is unreachable',
              invalid: 'OpenAI rejected the TTS validation request',
            },
            'arthur providers setup',
          ),
        );
      } else {
        checks.push(skipped('provider.openai.tts.live', 'speech', 'TTS live check not tested'));
      }
    } else {
      checks.push(skipped('provider.openai.stt.live', 'speech', 'STT live check not tested'));
      checks.push(skipped('provider.openai.tts.live', 'speech', 'TTS live check not tested'));
    }
  } else {
    checks.push(skipped('provider.openai.credential', 'speech', 'OpenAI not required'));
    if (speechIsLocal) {
      checks.push(check('speech.provider', 'speech', 'pass', true, 'Speech: local (Reasoning: DeepSeek cloud)'));
    }
    checks.push(skipped('provider.openai.stt.live', 'speech', 'STT live check not tested'));
    checks.push(skipped('provider.openai.tts.live', 'speech', 'TTS live check not tested'));
  }

  // ---- Audio ------------------------------------------------------------------
  const captureCommand = effectiveCaptureCommand(args.layers);
  const playbackCommand = effectivePlaybackCommand(args.layers);
  const inputId = effectiveInputId(args.layers);
  if (deps.audio) {
    checks.push(
      args.audio.info.captureAvailable
        ? check('audio.backend.ffmpeg', 'audio', 'pass', true, 'ffmpeg available')
        : check('audio.backend.ffmpeg', 'audio', 'fail', true, 'ffmpeg is missing', { remediation: 'arthur audio setup' }),
    );
    checks.push(
      args.audio.info.playbackAvailable
        ? check('audio.backend.ffplay', 'audio', 'pass', true, 'ffplay available')
        : check('audio.backend.ffplay', 'audio', 'fail', true, 'ffplay is missing', { remediation: 'arthur audio setup' }),
    );
    checks.push(
      captureCommand !== ''
        ? check('audio.capture.command', 'audio', 'pass', true, 'capture command configured')
        : check('audio.capture.command', 'audio', 'fail', true, 'capture command is not configured', { remediation: 'arthur audio setup' }),
    );
    checks.push(
      playbackCommand !== ''
        ? check('audio.playback.command', 'audio', 'pass', true, 'playback command configured')
        : check('audio.playback.command', 'audio', 'fail', true, 'playback command is not configured', { remediation: 'arthur audio setup' }),
    );
    checks.push(
      inputId !== ''
        ? check('audio.input.config', 'audio', 'pass', true, 'audio input device configured', { details: { input: inputId } })
        : check('audio.input.config', 'audio', 'fail', true, 'audio input device is not configured', { remediation: 'arthur audio setup' }),
    );
    if (inputId === '') {
      checks.push(skipped('audio.input.device', 'audio', 'no configured microphone to verify'));
    } else if (!args.audio.discoverySupported) {
      checks.push(
        check('audio.input.device', 'audio', 'skipped', false, 'microphone discovery is not supported on this platform; presence not verified', {
          details: { input: inputId, platform: args.audio.info.platform },
        }),
      );
    } else {
      const found = args.audio.inputs.some((d) => d.id === inputId);
      checks.push(
        found
          ? check('audio.input.device', 'audio', 'pass', true, 'configured microphone present', { details: { input: inputId } })
          : check('audio.input.device', 'audio', 'fail', true, 'configured microphone is no longer present', {
              remediation: 'arthur audio setup',
              details: { input: inputId },
            }),
      );
    }
    if (!args.audio.discoverySupported) {
      checks.push(skipped('audio.input.discovery', 'audio', 'microphone discovery is not supported on this platform'));
    } else if (args.audio.inputs.length === 0) {
      checks.push(check('audio.input.discovery', 'audio', 'warn', false, 'no microphones detected'));
    } else {
      checks.push(
        check('audio.input.discovery', 'audio', 'pass', false, args.audio.inputs.length + ' microphone(s) detected', {
          details: { count: args.audio.inputs.length },
        }),
      );
    }
    // Live capture (bounded, memory-only). Playback tone stays interactive-only:
    // validatePlaybackTransport inherently plays the deterministic tone.
    if (args.live) {
      const seams = args.seams ?? {};
      if (captureCommand !== '' && seams.validateCapture) {
        const result = await withLiveTimeout(
          () => (seams.validateCapture as (command: string) => Promise<CaptureValidationResult>)(captureCommand),
          () => ({ transportReady: false, signalDetected: false, metrics: { framesReceived: 0, bytesReceived: 0, durationMs: 0, peakLevel: 0, rmsLevel: 0, signalDetected: false }, failure: 'capture check timed out' }),
        );
        if (result.transportReady) {
          checks.push(
            check('audio.capture.transport', 'audio', 'pass', true, 'capture transport ready (' + String(result.metrics.framesReceived) + ' frames)', {
              details: { frames: result.metrics.framesReceived },
            }),
          );
          checks.push(
            result.signalDetected
              ? check('audio.capture.signal', 'audio', 'pass', false, 'microphone signal detected')
              : check('audio.capture.signal', 'audio', 'warn', false, 'input silent/very-low (transport ready)'),
          );
        } else {
          checks.push(
            check('audio.capture.transport', 'audio', 'fail', true, 'capture transport failed' + (result.failure ? ' (' + result.failure + ')' : ''), {
              remediation: 'arthur audio setup',
            }),
          );
          checks.push(skipped('audio.capture.signal', 'audio', 'no audio frames to judge signal'));
        }
      } else if (captureCommand === '') {
        checks.push(skipped('audio.capture.transport', 'audio', 'capture is not configured'));
        checks.push(skipped('audio.capture.signal', 'audio', 'capture is not configured'));
      } else {
        checks.push(skipped('audio.capture.transport', 'audio', 'capture transport not tested'));
        checks.push(skipped('audio.capture.signal', 'audio', 'capture transport not tested'));
      }
      if (args.interactive) {
        if (playbackCommand !== '' && seams.validatePlayback) {
          const playback = await withLiveTimeout(
            () => (seams.validatePlayback as (command: string) => Promise<PlaybackValidationResult>)(playbackCommand),
            () => ({ transportReady: false, chunksAccepted: 0, bytesAccepted: 0, failure: 'playback check timed out' }),
          );
          if (!playback.transportReady) {
            checks.push(
              check('audio.playback.transport', 'audio', 'fail', true, 'playback transport failed' + (playback.failure ? ' (' + playback.failure + ')' : ''), {
                remediation: 'arthur audio setup',
              }),
            );
            checks.push(skipped('audio.playback.audible', 'audio', 'tone never played'));
          } else {
            checks.push(check('audio.playback.transport', 'audio', 'pass', true, 'playback transport ready'));
            if (seams.confirmHeard) {
              let heard = false;
              try {
                heard = await withLiveTimeout(() => (seams.confirmHeard as (prompt: string) => Promise<boolean>)('Did you hear the tone? [Y/n]'), () => false);
              } catch {
                heard = false;
              }
              checks.push(
                heard
                  ? check('audio.playback.audible', 'audio', 'pass', true, 'audible output confirmed')
                  : check('audio.playback.audible', 'audio', 'fail', true, 'audible output not confirmed', { remediation: 'arthur audio setup' }),
              );
            } else {
              checks.push(skipped('audio.playback.audible', 'audio', 'audible output not confirmed'));
            }
          }
        } else if (playbackCommand === '') {
          checks.push(skipped('audio.playback.transport', 'audio', 'playback is not configured'));
          checks.push(skipped('audio.playback.audible', 'audio', 'playback is not configured'));
        } else {
          checks.push(skipped('audio.playback.transport', 'audio', 'playback transport not tested'));
          checks.push(skipped('audio.playback.audible', 'audio', 'audible output not confirmed'));
        }
      } else {
        // Non-interactive --live is specified non-audible: validatePlaybackTransport()
        // inherently plays the FRS-03 tone, so it must never run here.
        // Playback live validation stays skipped (static ffplay/config checks above
        // still pass independently); only --live --interactive may play sound.
        checks.push(skipped('audio.playback.transport', 'audio', 'Audible playback check requires --live --interactive'));
        checks.push(skipped('audio.playback.audible', 'audio', 'Audible playback check requires --live --interactive'));
      }
    } else {
      checks.push(skipped('audio.capture.transport', 'audio', 'capture transport not tested'));
      checks.push(skipped('audio.capture.signal', 'audio', 'capture transport not tested'));
      checks.push(skipped('audio.playback.transport', 'audio', 'Audible playback check requires --live --interactive'));
      checks.push(skipped('audio.playback.audible', 'audio', 'Audible playback check requires --live --interactive'));
    }
  } else {
    checks.push(skipped('audio.backend.ffmpeg', 'audio', 'audio not required'));
    checks.push(skipped('audio.backend.ffplay', 'audio', 'audio not required'));
    checks.push(skipped('audio.capture.command', 'audio', 'audio not required'));
    checks.push(skipped('audio.playback.command', 'audio', 'audio not required'));
    checks.push(skipped('audio.input.config', 'audio', 'audio not required'));
    checks.push(skipped('audio.input.device', 'audio', 'audio not required'));
    checks.push(skipped('audio.input.discovery', 'audio', 'audio not required'));
    checks.push(skipped('audio.capture.transport', 'audio', 'audio not required'));
    checks.push(skipped('audio.capture.signal', 'audio', 'audio not required'));
    checks.push(skipped('audio.playback.transport', 'audio', 'audio not required'));
    checks.push(skipped('audio.playback.audible', 'audio', 'audio not required'));
  }

  // ---- Local models ------------------------------------------------------------
  const needStt = deps.localSttModel;
  const needTts = deps.localTtsModel;
  if (!needStt && !needTts) {
    checks.push(skipped('model.stt.ready', 'local-models', 'local STT model not required'));
    checks.push(skipped('model.tts.ready', 'local-models', 'local TTS model not required'));
  } else {
    if (args.models.snapshot === null) {
      checks.push(
        check('model.state', 'local-models', 'fail', true, 'local model state cannot be read' + (args.models.stateError ? ' (' + args.models.stateError + ')' : ''), {
          remediation: 'arthur models setup',
          details: { state_path: args.models.statePath },
        }),
      );
      if (needStt) checks.push(check('model.stt.ready', 'local-models', 'fail', true, 'local STT model cannot be evaluated without model state', { remediation: 'arthur models setup' }));
      else checks.push(skipped('model.stt.ready', 'local-models', 'local STT model not required'));
      if (needTts) checks.push(check('model.tts.ready', 'local-models', 'fail', true, 'local TTS model cannot be evaluated without model state', { remediation: 'arthur models setup' }));
      else checks.push(skipped('model.tts.ready', 'local-models', 'local TTS model not required'));
    } else {
      const catalog = args.models.catalog ?? getLocalModelCatalog();
      const ambient = args.layers.ambient as NodeJS.ProcessEnv;
      if (needStt) checks.push(evaluateLocalModel('stt', args.models, catalog, ambient));
      else checks.push(skipped('model.stt.ready', 'local-models', 'local STT model not required'));
      if (needTts) checks.push(evaluateLocalModel('tts', args.models, catalog, ambient));
      else checks.push(skipped('model.tts.ready', 'local-models', 'local TTS model not required'));
    }
  }

  // ---- Policy consistency ---------------------------------------------------------
  if (voice.voiceEnabled && voice.sttPolicy === 'local_only') {
    const usable = isLocalModelUsable('stt', args.models, args.layers.ambient as NodeJS.ProcessEnv);
    checks.push(
      usable
        ? check('policy.stt.local', 'policy', 'pass', true, 'local STT policy satisfied')
        : check('policy.stt.local', 'policy', 'fail', true, 'voice requires a local STT model but none is usable', { remediation: 'arthur models setup' }),
    );
  }
  if (voice.voiceEnabled && voice.ttsPolicy === 'local_only') {
    const usable = isLocalModelUsable('tts', args.layers ? args.models : args.models, args.layers.ambient as NodeJS.ProcessEnv);
    checks.push(
      usable
        ? check('policy.tts.local', 'policy', 'pass', true, 'local TTS policy satisfied')
        : check('policy.tts.local', 'policy', 'fail', true, 'voice requires a local TTS model but none is usable', { remediation: 'arthur models setup' }),
    );
  }
  if (!deps.audio && (args.layers.machine['ARTHUR_AUDIO_INPUT_DEVICE'] || args.layers.machine['ARTHUR_AUDIO_CAPTURE_COMMAND'] || args.layers.machine['ARTHUR_AUDIO_PLAYBACK_COMMAND'])) {
    checks.push(check('policy.audio.stale', 'policy', 'warn', false, 'audio configuration present but not used by Text only (ignored)'));
  }
  if (deps.audio && captureCommand !== '' && inputId !== '') {
    const referenced = captureDeviceOf(captureCommand);
    if (referenced !== null) {
      if (referenced === inputId) {
        checks.push(check('policy.capture.device', 'policy', 'pass', false, 'capture command matches the configured device'));
      } else {
        checks.push(check('policy.capture.device', 'policy', 'warn', false, 'capture command does not reference the configured device'));
      }
    }
  }

  const report: DoctorReport = {
    ok: false,
    status: 'NOT_READY',
    profile,
    live: args.live,
    interactive: args.interactive,
    checks,
  };
  return finalizeDoctorReport(report);
}

function evaluateLocalModel(
  kind: 'stt' | 'tts',
  models: DoctorModelInput,
  catalog: readonly LocalModelDefinition[],
  env: NodeJS.ProcessEnv,
): DoctorCheck {
  const id = kind === 'stt' ? 'model.stt.ready' : 'model.tts.ready';
  const label = kind === 'stt' ? 'local STT model' : 'local TTS model';
  if (models.snapshot === null) {
    return check(id, 'local-models', 'fail', true, label + ' cannot be evaluated without model state', { remediation: 'arthur models setup' });
  }
  let effective: { model: { id: string } | null; source: string; reason: string };
  try {
    const selection = resolveEffectiveSelection({ kind, hardware: models.hardware, state: models.snapshot, catalog, env });
    effective = { model: selection.model, source: selection.source, reason: selection.reason };
  } catch (err) {
    return check(id, 'local-models', 'fail', true, label + ' selection is invalid', {
      remediation: 'arthur models setup',
      details: { reason: err instanceof Error ? err.message.slice(0, 200) : 'invalid selection' },
    });
  }
  if (effective.model === null) {
    return check(id, 'local-models', 'fail', true, 'no usable ' + label + ' for this hardware', {
      remediation: 'arthur models setup',
      details: { source: effective.source },
    });
  }
  const modelId = effective.model.id;
  const runnable = resolveRunnableSelection({ kind, hardware: models.hardware, state: models.snapshot, catalog, env });
  if (!runnable.runnable) {
    return check(id, 'local-models', 'fail', true, label + ' ' + JSON.stringify(modelId) + ' is not installed or not ready', {
      remediation: 'arthur models setup',
      details: { model: modelId, source: effective.source },
    });
  }
  // Persisted ready=true is last-known state, not proof: verify the
  // managed artifacts exist (read-only existence probe, never repair).
  try {
    resolveRuntimeTarget({
      kind,
      hardware: models.hardware,
      state: models.snapshot,
      managedRoot: models.managedRoot,
      catalog,
      env,
      ...(models.exists !== undefined ? { exists: models.exists } : {}),
    });
  } catch {
    return check(id, 'local-models', 'fail', true, label + ' ' + JSON.stringify(modelId) + ' reports installed but its runtime artifacts are missing', {
      remediation: 'arthur models setup',
      details: { model: modelId, source: effective.source },
    });
  }
  return check(id, 'local-models', 'pass', true, label + ' ' + JSON.stringify(modelId) + ' ready', {
    details: { model: modelId, source: effective.source },
  });
}

function isLocalModelUsable(kind: 'stt' | 'tts', models: DoctorModelInput, env: NodeJS.ProcessEnv): boolean {
  if (models.snapshot === null) return false;
  try {
    const catalog = models.catalog ?? getLocalModelCatalog();
    const runnable = resolveRunnableSelection({ kind, hardware: models.hardware, state: models.snapshot, catalog, env });
    if (!runnable.runnable || runnable.model === null) return false;
    resolveRuntimeTarget({
      kind,
      hardware: models.hardware,
      state: models.snapshot,
      managedRoot: models.managedRoot,
      catalog,
      env,
      ...(models.exists !== undefined ? { exists: models.exists } : {}),
    });
    return true;
  } catch {
    return false;
  }
}
