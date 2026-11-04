/**
 * FRS-05: `arthur doctor` — read-only machine diagnostic.
 *
 * Configuration-only like providers/audio/config: never loads the App
 * composition root or SQLite stores, creates no databases or model state,
 * never calls updateMachineConfig(), never installs models. Default mode
 * performs no network requests, no microphone capture, no audible
 * playback. --live adds bounded active validation (memory-only audio);
 * --live --interactive may additionally play the FRS-03 deterministic
 * test tone and ask for audible confirmation.
 */

import * as fs from 'node:fs';

import { CliExit } from '../../src/cli_exit';
import { readMachineConfig, resolveMachineConfigPath } from '../../src/config/machine_config';
import { createAudioBackendForPlatform, isUnsupportedAudioBackend } from '../../src/audio/factory';
import { validateCaptureTransport, validatePlaybackTransport } from '../../src/audio/validate';
import { checkDeepSeekReadiness } from '../../src/providers/deepseek_readiness';
import { checkOpenAiSttReadiness, checkOpenAiTtsReadiness } from '../../src/providers/openai_voice_readiness';
import { DEEPSEEK_DEFAULT_MODEL } from '../../src/providers/setup_plan';
import { DEEPSEEK_DEFAULT_BASE_URL } from '../../src/models/providers/deepseek';
import { DEFAULT_VOICE_SETTINGS } from '../../src/voice/config';
import { SystemHardwareProbe } from '../../src/runtime/hardware/probe';
import { LocalModelStateStore } from '../../src/runtime/local-models/state_store';
import { resolveLocalModelPaths } from '../../src/runtime/local-models/provisioning/paths';
import { diagnoseDoctor, profileLabel, type DoctorAudioInput, type DoctorFileInput, type DoctorLayerInput, type DoctorLiveSeams, type DoctorModelInput } from '../../src/doctor/diagnose';
import { exitCodeForDoctor } from '../../src/doctor/aggregate';
import type { DoctorArea, DoctorCheck, DoctorReport } from '../../src/doctor/types';
import { PROFILE_LABELS } from '../../src/setup/profile';
import type { CliIO } from './index';
import { askConfirm } from './setup_ui';

export const DOCTOR_HELP = [
  'ARTHUR doctor - read-only machine readiness diagnostic (FRS-05)',
  '',
  'Usage:',
  '  arthur doctor [--json] [--live [--interactive]]',
  '',
  '  (default)  Static checks only: config, credential presence, profile,',
  '             executables, configured device presence, model state,',
  '             policy consistency. No network, no capture, no sound.',
  '  --live     Bounded active validation (provider readiness, capture',
  '             transport, playback TRANSPORT). Memory-only audio.',
  '  --live --interactive',
  '             Also plays the deterministic test tone and asks for',
  '             audible confirmation. Strongest local audio diagnostic.',
  '',
  'Read-only: diagnoses, never repairs. Repair with arthur setup,',
  'arthur providers setup, arthur audio setup, or arthur models setup.',
  '',
].join('\n');

function isHelp(flags: Map<string, string>, positionals: string[]): boolean {
  return flags.get('help') === 'true' || positionals.includes('--help') || positionals.includes('-h');
}

export interface DoctorDeps {
  layers?: DoctorLayerInput;
  file?: DoctorFileInput;
  audio?: DoctorAudioInput;
  models?: DoctorModelInput;
  seams?: DoctorLiveSeams;
  tty?: boolean;
}

function readRepoEnvRecord(repoPath: string | null): Record<string, string> {
  if (repoPath === null) return {};
  let text: string;
  try {
    text = fs.readFileSync(repoPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    const { ArthurError } = require('../../src/core/errors/errors') as typeof import('../../src/core/errors/errors');
    throw new ArthurError('INVALID_CONFIG', 'cannot read repo .env: ' + (err instanceof Error ? err.message : String(err)));
  }
  if (text.indexOf(String.fromCharCode(0)) !== -1) {
    const { ArthurError } = require('../../src/core/errors/errors') as typeof import('../../src/core/errors/errors');
    throw new ArthurError('INVALID_CONFIG', 'repo .env contains NUL');
  }
  try {
    const { parseEnv } = require('node:util') as typeof import('node:util');
    return parseEnv(text) as Record<string, string>;
  } catch (err) {
    const { ArthurError } = require('../../src/core/errors/errors') as typeof import('../../src/core/errors/errors');
    throw new ArthurError('INVALID_CONFIG', 'repo .env is malformed: ' + (err instanceof Error ? err.message.split('\n')[0] : String(err)));
  }
}

function snapshotDoctorLayers(deps: DoctorDeps): DoctorLayerInput {
  if (deps.layers) return deps.layers;
  const machineConfigPath = resolveMachineConfigPath();
  let machine: Record<string, string> = {};
  try {
    machine = readMachineConfig(machineConfigPath);
  } catch {
    machine = {};
  }
  const repo = readRepoEnvRecord('.env');
  return { ambient: { ...process.env }, repo, machine, machineConfigPath };
}

function snapshotDoctorFile(layers: DoctorLayerInput, deps: DoctorDeps): DoctorFileInput {
  if (deps.file) return deps.file;
  const configPath = layers.machineConfigPath;
  let stat: { size: number } | null = null;
  try {
    stat = fs.statSync(configPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { configPath, present: false, readable: true };
    }
    return { configPath, present: true, readable: false, malformed: 'cannot stat machine config' };
  }
  if (stat !== null && stat.size > 1024 * 1024) {
    return { configPath, present: true, readable: true, malformed: 'machine config exceeds the 1 MiB diagnostic bound', sizeBytes: stat.size };
  }
  try {
    const entries = readMachineConfig(configPath);
    return { configPath, present: true, readable: true, entryCount: Object.keys(entries).length, sizeBytes: stat?.size ?? 0 };
  } catch {
    return { configPath, present: true, readable: true, malformed: 'machine config is malformed', sizeBytes: stat?.size ?? 0 };
  }
}

async function snapshotDoctorAudio(layers: DoctorLayerInput, deps: DoctorDeps): Promise<DoctorAudioInput> {
  if (deps.audio) return deps.audio;
  const backend = createAudioBackendForPlatform();
  let info;
  try {
    info = await backend.detect();
  } catch {
    info = { id: backend.id(), platform: process.platform, available: false, captureExecutable: '', playbackExecutable: '', captureAvailable: false, playbackAvailable: false, captureVersion: '', playbackVersion: '' };
  }
  // Capability comes from the backend itself (executables + discovery
  // usable), never from a platform hardcode: an unsupported backend or
  // a backend whose discovery is unavailable reports the boundary.
  const discoverySupported = !isUnsupportedAudioBackend(backend) && info.captureAvailable;
  let inputs: DoctorAudioInput['inputs'] = [];
  if (discoverySupported) {
    try {
      inputs = await backend.listInputDevices();
    } catch {
      inputs = [];
    }
  }
  void layers;
  return { info, inputs, discoverySupported };
}

async function snapshotDoctorModels(layers: DoctorLayerInput, deps: DoctorDeps): Promise<DoctorModelInput> {
  if (deps.models) return deps.models;
  const ambient = layers.ambient as Record<string, string | undefined>;
  const rootOverride = typeof ambient['ARTHUR_LOCAL_MODEL_ROOT'] === 'string' && (ambient['ARTHUR_LOCAL_MODEL_ROOT'] as string).trim() !== '' ? (ambient['ARTHUR_LOCAL_MODEL_ROOT'] as string) : undefined;
  const stateOverride = typeof ambient['ARTHUR_LOCAL_MODEL_STATE'] === 'string' && (ambient['ARTHUR_LOCAL_MODEL_STATE'] as string).trim() !== '' ? (ambient['ARTHUR_LOCAL_MODEL_STATE'] as string) : undefined;
  const stateEnv = typeof ambient['ARTHUR_LOCAL_MODEL_STATE_PATH'] === 'string' && (ambient['ARTHUR_LOCAL_MODEL_STATE_PATH'] as string).trim() !== '' ? (ambient['ARTHUR_LOCAL_MODEL_STATE_PATH'] as string) : undefined;
  const { managedRoot, statePath } = resolveLocalModelPaths({
    ...(rootOverride !== undefined ? { managedRoot: rootOverride } : {}),
    ...(stateOverride !== undefined ? { statePath: stateOverride } : stateEnv !== undefined ? { statePath: stateEnv } : {}),
  });
  let snapshot: DoctorModelInput['snapshot'] = null;
  let statePresent = false;
  let stateError: string | undefined;
  try {
    const store = LocalModelStateStore.load({ statePath });
    snapshot = store.snapshot();
    try {
      fs.accessSync(statePath);
      statePresent = true;
    } catch {
      statePresent = false;
    }
  } catch (err) {
    stateError = err instanceof Error ? err.message.slice(0, 200) : 'unreadable model state';
    snapshot = null;
    try {
      fs.accessSync(statePath);
      statePresent = true;
    } catch {
      statePresent = false;
    }
  }
  let hardware: DoctorModelInput['hardware'];
  try {
    hardware = await new SystemHardwareProbe().detect();
  } catch {
    const { unknownAccelerators } = await import('../../src/runtime/hardware/contracts');
    hardware = { os: 'unknown', arch: 'unknown', memory: { total_mb: null }, cpu: { logical_cores: null, model: null }, gpus: [], accelerators: unknownAccelerators() };
  }
  return { statePath, statePresent, ...(stateError !== undefined ? { stateError } : {}), snapshot, hardware, managedRoot };
}

function realLiveSeams(layers: DoctorLayerInput, io: CliIO): DoctorLiveSeams {
  return {
    probeDeepseek: async (input) => checkDeepSeekReadiness({ apiKey: input.apiKey, model: input.model, baseUrl: input.baseUrl }),
    probeOpenaiStt: async (input) => checkOpenAiSttReadiness({ apiKey: input.apiKey, model: input.model }),
    probeOpenaiTts: async (input) => checkOpenAiTtsReadiness({ apiKey: input.apiKey, model: input.model, voice: input.voice }),
    validateCapture: async (command: string) => validateCaptureTransport(command, {}),
    validatePlayback: async (command: string) => validatePlaybackTransport(command, {}),
    confirmHeard: async (prompt: string) => askConfirm(io, {}, prompt, 'yes'),
  };
}

const AREA_ORDER: DoctorArea[] = ['configuration', 'reasoning', 'speech', 'audio', 'local-models', 'policy'];

const AREA_TITLES: Record<DoctorArea, string> = {
  configuration: 'Configuration',
  reasoning: 'Reasoning',
  speech: 'Speech',
  audio: 'Audio',
  'local-models': 'Local models',
  policy: 'Policy',
};

function sourceSuffix(checkItem: DoctorCheck): string {
  if (checkItem.source) return '  ' + checkItem.source;
  const detailSource = checkItem.details?.['source'];
  if (typeof detailSource === 'string') {
    if (detailSource === 'process_env') return '  environment';
    if (detailSource === 'repo_env') return '  repo .env';
    if (detailSource === 'machine_config') return '  machine config';
  }
  return '';
}

export function renderDoctorHuman(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('ARTHUR Doctor');
  lines.push('');
  for (const area of AREA_ORDER) {
    const items = report.checks.filter((c) => c.area === area);
    if (items.length === 0) continue;
    lines.push(AREA_TITLES[area]);
    if (area === 'configuration') {
      const profileName = report.profile === 'unconfigured' ? 'Not configured' : report.profile === 'partial' ? 'Custom/partial' : PROFILE_LABELS[report.profile];
      if (report.profile === 'local_voice') {
        lines.push('  profile: ' + profileName + ' (Reasoning: DeepSeek cloud; Speech: local)');
      } else if (report.profile === 'cloud_voice' || report.profile === 'text_only' || report.profile === 'custom') {
        lines.push('  profile: ' + profileName);
      } else {
        lines.push('  profile: ' + profileName);
      }
    }
    for (const item of items) {
      if (item.id === 'config.present' && report.profile !== 'unconfigured') continue;
      const mark = item.status === 'pass' ? '\u2713' : item.status === 'fail' ? '\u2717' : '\u2014';
      if (item.status === 'skipped') {
        lines.push('  ' + mark + ' ' + item.message);
      } else {
        lines.push('  ' + mark + ' ' + item.message + sourceSuffix(item));
      }
      if (item.status === 'fail' && item.remediation) {
        lines.push('    Run: ' + item.remediation);
      }
    }
    lines.push('');
  }
  const resultMark = report.ok ? '\u2713' : '\u2717';
  lines.push('Result');
  lines.push('  ' + resultMark + ' ' + (report.ok ? 'ARTHUR is ready' : report.status === 'UNCONFIGURED' ? 'ARTHUR is not configured' : 'ARTHUR needs attention') + ' (' + report.status + ')');
  return lines.join('\n') + '\n';
}

function doctorJson(report: DoctorReport): Record<string, unknown> {
  return {
    ok: report.ok,
    status: report.status,
    profile: doctorProfileId(report.profile),
    live: report.live,
    interactive: report.interactive,
    checks: report.checks.map((c) => {
      const out: Record<string, unknown> = { id: c.id, area: c.area, status: c.status, required: c.required, message: c.message };
      if (c.remediation !== undefined) out['remediation'] = c.remediation;
      if (c.source !== undefined) out['source'] = c.source;
      if (c.details !== undefined) out['details'] = c.details;
      return out;
    }),
  };
}

function doctorProfileId(profile: DoctorReport['profile']): string {
  if (profile === 'unconfigured') return 'unconfigured';
  if (profile === 'partial') return 'custom';
  return profile;
}

export async function runDoctor(flags: Map<string, string>, io: CliIO, deps: DoctorDeps = {}): Promise<number> {
  const knownFlags = new Set(['json', 'live', 'interactive', 'help']);
  for (const key of flags.keys()) {
    if (!knownFlags.has(key)) {
      io.err('usage: arthur doctor [--json] [--live [--interactive]]\n');
      return CliExit.USAGE;
    }
  }
  if (isHelp(flags, [])) {
    io.out(DOCTOR_HELP);
    return CliExit.SUCCESS;
  }
  const json = flags.get('json') === 'true';
  const live = flags.get('live') === 'true';
  const interactive = flags.get('interactive') === 'true';
  if (interactive && !live) {
    io.err('usage: arthur doctor [--json] [--live [--interactive]] (--interactive requires --live)\n');
    return CliExit.USAGE;
  }
  if (interactive && json) {
    io.err('usage: arthur doctor [--json] [--live [--interactive]] (--interactive requires human output)\n');
    return CliExit.USAGE;
  }
  if (interactive && !(deps.tty ?? Boolean(process.stdin.isTTY))) {
    io.err('error [INVALID_REQUEST]: arthur doctor --live --interactive requires an interactive terminal\n');
    return CliExit.USAGE;
  }
  try {
    const layers = snapshotDoctorLayers(deps);
    const file = snapshotDoctorFile(layers, deps);
    const audio = await snapshotDoctorAudio(layers, deps);
    const models = await snapshotDoctorModels(layers, deps);
    const seams = deps.seams ?? (live ? realLiveSeams(layers, io) : undefined);
    const report = await diagnoseDoctor({ layers, file, audio, models, live, interactive, ...(seams !== undefined ? { seams } : {}) });
    void profileLabel;
    void DEEPSEEK_DEFAULT_MODEL;
    void DEEPSEEK_DEFAULT_BASE_URL;
    void DEFAULT_VOICE_SETTINGS;
    if (json) {
      io.out(JSON.stringify(doctorJson(report)) + '\n');
    } else {
      io.out(renderDoctorHuman(report));
    }
    return exitCodeForDoctor(report);
  } catch {
    io.err('error [INTERNAL]: doctor failed unexpectedly\n');
    return CliExit.INTERNAL;
  }
}

export async function runDoctorCommand(flags: Map<string, string>, positionals: string[], io: CliIO, deps: DoctorDeps = {}): Promise<number> {
  const sub = positionals[1];
  if (sub !== undefined) {
    if (sub === '--help' || sub === '-h') {
      io.out(DOCTOR_HELP);
      return CliExit.SUCCESS;
    }
    io.err('usage: arthur doctor [--json] [--live [--interactive]]\n');
    return CliExit.USAGE;
  }
  return runDoctor(flags, io, deps);
}
