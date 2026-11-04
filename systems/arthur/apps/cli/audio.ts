/**
 * FRS-03: `arthur audio detect|setup|status|test` — machine audio onboarding.
 *
 * Configuration-only like providers/config: never loads the App composition
 * root or SQLite stores, creates no databases or model state. Discovery and
 * validation spawn ffmpeg/ffplay with argv arrays (never shell); device
 * names are untrusted data validated against the spawnEngine tokenizer.
 * Setup builds an in-memory plan and commits ONE atomic FRS-01 patch at
 * final Save — cancel anywhere means zero writes. Never sets
 * ARTHUR_VOICE_ENABLED (FRS-04 owns it) and never performs startup probing.
 */

import * as fs from 'node:fs';

import { ArthurError } from '../../src/core/errors/errors';
import { CliExit } from '../../src/cli_exit';
import { readMachineConfig, updateMachineConfig } from '../../src/config/machine_config';
import {
  AUDIO_SAMPLE_RATE_HZ,
  SYSTEM_DEFAULT_OUTPUT_ID,
  type AudioBackend,
  type AudioDevice,
} from '../../src/audio/backend';
import { createAudioBackendForPlatform } from '../../src/audio/factory';
import { notConfiguredReadiness, type AudioReadiness } from '../../src/audio/readiness';
import { validateCaptureTransport, validatePlaybackTransport } from '../../src/audio/validate';
import type { CliIO } from './index';
import { askConfirm, askSelection, readLine } from './setup_ui';

export const AUDIO_HELP = [
  'ARTHUR audio - machine audio discovery and setup (FRS-03)',
  '',
  'Usage:',
  '  arthur audio detect [--json]',
  '  arthur audio status [--json]',
  '  arthur audio setup [--json]',
  '  arthur audio test [--json]',
  '',
  '  detect   Local backend + microphone discovery (no mutation).',
  '  status   Effective audio config + source (no hardware access).',
  '  setup    Interactive device setup (TTY). One atomic save at the end.',
  '  test     Validate current effective audio config (no mutation).',
  '',
  'Output is the system-default sink in v1 (ffplay has no stable Windows',
  'sink selection); normal startup never probes audio hardware.',
  '',
].join('\n');

function isHelp(flags: Map<string, string>, positionals: string[]): boolean {
  return flags.get('help') === 'true' || positionals.includes('--help') || positionals.includes('-h');
}

export interface AudioDeps {
  backend?: AudioBackend;
  readApprovalLine?: () => Promise<string>;
  tty?: boolean;
  layers?: { ambient: Record<string, string>; repo: Record<string, string>; machine: Record<string, string>; machineConfigPath?: string };
  fetchFn?: never;
  commitPatch?: (patch: { set: Record<string, string>; remove: string[] }) => void;
  captureValidator?: typeof validateCaptureTransport;
  playbackValidator?: typeof validatePlaybackTransport;
  confirmHeard?: (prompt: string) => Promise<boolean>;
}

function backendOf(deps: AudioDeps): AudioBackend {
  return deps.backend !== undefined ? deps.backend : createAudioBackendForPlatform();
}

function snapshotAudioLayers(deps: AudioDeps): { ambient: Record<string, string>; repo: Record<string, string>; machine: Record<string, string>; machineConfigPath?: string } {
  if (deps.layers) return deps.layers;
  const { loadConfigurationEnvironment } = require('../../src/config/machine_config') as typeof import('../../src/config/machine_config');
  const probe: NodeJS.ProcessEnv = {};
  const resolved = loadConfigurationEnvironment({ repoEnvPath: null, env: probe });
  let repo: Record<string, string> = {};
  try {
    const text = fs.readFileSync('.env', 'utf8');
    const { parseEnv } = require('node:util') as typeof import('node:util');
    repo = parseEnv(text) as Record<string, string>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ArthurError('INVALID_CONFIG', 'cannot read repo .env: ' + (err instanceof Error ? err.message : String(err)));
    }
  }
  return { ambient: { ...(process.env as Record<string, string>) }, repo, machine: readMachineConfig(resolved.machineConfigPath), machineConfigPath: resolved.machineConfigPath };
}

function pickEnv(layers: { ambient: Record<string, string>; repo: Record<string, string>; machine: Record<string, string> }, name: string, fallback: string): { value: string; source: string } {
  const ambient = layers.ambient[name];
  if (typeof ambient === 'string' && ambient !== '') return { value: ambient, source: 'process_env' };
  const repo = layers.repo[name];
  if (typeof repo === 'string' && repo !== '') return { value: repo, source: 'repo_env' };
  const machine = layers.machine[name];
  if (typeof machine === 'string' && machine !== '') return { value: machine, source: 'machine_config' };
  return { value: fallback, source: 'code_default' };
}

export async function runAudioDetect(flags: Map<string, string>, io: CliIO, deps: AudioDeps = {}): Promise<number> {
  const json = flags.get('json') === 'true';
  const backend = backendOf(deps);
  const info = await backend.detect();
  const inputs = info.captureAvailable ? await backend.listInputDevices() : [];
  const outputs = await backend.listOutputDevices();
  if (json) {
    io.out(JSON.stringify({ ok: true, command: 'audio detect', data: { backend: info, inputs: inputs.map((d) => ({ id: d.id, label: d.label, backend: d.backend })), outputs: outputs.map((d) => ({ id: d.id, label: d.label })) } }, null, 2) + '\n');
    return CliExit.SUCCESS;
  }
  io.out('Audio backend\n');
  io.out('  ffmpeg: ' + (info.captureAvailable ? 'READY' + (info.captureVersion !== '' ? ' (' + info.captureVersion + ')' : '') : 'MISSING') + '\n');
  io.out('  ffplay: ' + (info.playbackAvailable ? 'READY' + (info.playbackVersion !== '' ? ' (' + info.playbackVersion + ')' : '') : 'MISSING') + '\n');
  io.out('\nMicrophones\n');
  if (inputs.length === 0) { io.out('  none detected\n'); }
  else { inputs.forEach((d, i) => { io.out('  [' + String(i + 1) + '] ' + d.label + '\n'); }); }
  io.out('\nOutput\n  System default\n');
  return CliExit.SUCCESS;
}

export function runAudioStatus(flags: Map<string, string>, io: CliIO, deps: AudioDeps = {}): number {
  const json = flags.get('json') === 'true';
  const layers = snapshotAudioLayers(deps);
  const input = pickEnv(layers, 'ARTHUR_AUDIO_INPUT_DEVICE', '');
  const output = pickEnv(layers, 'ARTHUR_AUDIO_OUTPUT_DEVICE', SYSTEM_DEFAULT_OUTPUT_ID);
  const capture = pickEnv(layers, 'ARTHUR_AUDIO_CAPTURE_COMMAND', '');
  const playback = pickEnv(layers, 'ARTHUR_AUDIO_PLAYBACK_COMMAND', '');
  const data = {
    input: { value: input.value === '' ? '(not configured)' : input.value, source: input.source },
    output: { value: output.value === SYSTEM_DEFAULT_OUTPUT_ID ? 'System default' : output.value, source: output.source },
    capture_command: { configured: capture.value !== '', source: capture.value !== '' ? capture.source : 'absent' },
    playback_command: { configured: playback.value !== '', source: playback.value !== '' ? playback.source : 'absent' },
  };
  if (json) {
    io.out(JSON.stringify({ ok: true, command: 'audio status', data }, null, 2) + '\n');
    return CliExit.SUCCESS;
  }
  io.out('Capture backend: ffmpeg\n');
  io.out('Input: ' + (input.value === '' ? '(not configured)' : input.value) + '  ' + input.source + '\n');
  io.out('Playback backend: ffplay\n');
  io.out('Output: ' + (output.value === SYSTEM_DEFAULT_OUTPUT_ID ? 'System default' : output.value) + '  ' + output.source + '\n');
  io.out('Capture command: ' + (capture.value !== '' ? 'configured' : 'not configured') + '  ' + (capture.value !== '' ? capture.source : 'absent') + '\n');
  io.out('Playback command: ' + (playback.value !== '' ? 'configured' : 'not configured') + '  ' + (playback.value !== '' ? playback.source : 'absent') + '\n');
  return CliExit.SUCCESS;
}

export class AudioSetupCancelled extends Error {
  constructor() { super('Audio setup cancelled. No changes were saved.'); this.name = 'AudioSetupCancelled'; }
}

function isInteractiveAudio(deps: AudioDeps): boolean {
  if (deps.tty !== undefined) return deps.tty;
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

export async function runAudioTest(flags: Map<string, string>, io: CliIO, deps: AudioDeps = {}): Promise<number> {
  const json = flags.get('json') === 'true';
  const layers = snapshotAudioLayers(deps);
  const captureCmd = pickEnv(layers, 'ARTHUR_AUDIO_CAPTURE_COMMAND', '').value;
  const playbackCmd = pickEnv(layers, 'ARTHUR_AUDIO_PLAYBACK_COMMAND', '').value;
  if (captureCmd === '' || playbackCmd === '') {
    const message = 'audio is not configured; run arthur audio setup';
    if (json) { io.out(JSON.stringify({ ok: false, command: 'audio test', code: 'NOT_CONFIGURED', message }, null, 2) + '\n'); }
    else { io.err('error [NOT_CONFIGURED]: ' + message + '\n'); }
    return CliExit.USAGE;
  }
  const captureValidator = deps.captureValidator !== undefined ? deps.captureValidator : validateCaptureTransport;
  const playbackValidator = deps.playbackValidator !== undefined ? deps.playbackValidator : validatePlaybackTransport;
  const capture = await captureValidator(captureCmd, {});
  const playback = await playbackValidator(playbackCmd, {});
  const ready = capture.transportReady && playback.transportReady;
  if (json) {
    io.out(JSON.stringify({ ok: ready, command: 'audio test', data: { capture_transport: capture.transportReady ? 'ready' : 'failed', capture_signal: capture.signalDetected ? 'detected' : 'silent', playback_transport: playback.transportReady ? 'ready' : 'failed', frames_received: capture.metrics.framesReceived, rms_level: capture.metrics.rmsLevel } }, null, 2) + '\n');
    return ready ? CliExit.SUCCESS : CliExit.VALIDATION_FAILED;
  }
  io.out('Capture: ' + (capture.transportReady ? 'READY (' + String(capture.metrics.framesReceived) + ' frames)' : 'FAILED (' + (capture.failure !== undefined ? capture.failure : 'no audio') + ')') + '\n');
  io.out('Signal: ' + (capture.signalDetected ? 'detected' : 'silent/very-low') + '\n');
  io.out('Playback: ' + (playback.transportReady ? 'READY' : 'FAILED (' + (playback.failure !== undefined ? playback.failure : 'player error') + ')') + '\n');
  return ready ? CliExit.SUCCESS : CliExit.VALIDATION_FAILED;
}

export async function runAudioSetup(flags: Map<string, string>, io: CliIO, deps: AudioDeps = {}): Promise<number> {
  if (flags.get('json') === 'true') {
    io.out(JSON.stringify({ ok: false, command: 'audio setup', code: 'INTERACTIVE_REQUIRED', message: 'audio setup requires an interactive terminal; rerun without --json on a TTY' }, null, 2) + '\n');
    return CliExit.USAGE;
  }
  if (!isInteractiveAudio(deps)) {
    io.err('error [INVALID_REQUEST]: arthur audio setup requires an interactive terminal\n');
    return CliExit.USAGE;
  }
  const backend = backendOf(deps);
  const layers = snapshotAudioLayers(deps);
  const ioDeps = deps.readApprovalLine !== undefined ? { readApprovalLine: deps.readApprovalLine } : {};
  const confirmHeard = deps.confirmHeard !== undefined ? deps.confirmHeard : (async (prompt: string) => askConfirm(io, ioDeps, prompt, 'yes'));
  try {
    return await runAudioSetupInteractive(io, deps, backend, layers, ioDeps, confirmHeard);
  } catch (err) {
    if (err instanceof AudioSetupCancelled) { io.out(err.message + '\n'); return CliExit.INTERNAL; }
    throw err;
  }
}

async function runAudioSetupInteractive(io: CliIO, deps: AudioDeps, backend: AudioBackend, layers: { ambient: Record<string, string>; repo: Record<string, string>; machine: Record<string, string>; machineConfigPath?: string }, ioDeps: { readApprovalLine?: () => Promise<string> }, confirmHeard: (prompt: string) => Promise<boolean>): Promise<number> {
  io.out('ARTHUR Audio Setup\n\n');
  const info = await backend.detect();
  io.out('Audio backend\n');
  io.out('  ffmpeg: ' + (info.captureAvailable ? 'READY' : 'MISSING') + '\n');
  io.out('  ffplay: ' + (info.playbackAvailable ? 'READY' : 'MISSING') + '\n\n');
  if (!info.available) {
    io.err('error [BACKEND_MISSING]: ffmpeg/ffplay are required for audio setup\n');
    return CliExit.VALIDATION_FAILED;
  }
  const devices = info.captureAvailable ? await backend.listInputDevices() : [];
  if (devices.length === 0) {
    io.err('error [DEVICE_MISSING]: no microphones detected\n');
    return CliExit.VALIDATION_FAILED;
  }
  const savedInput = layers.machine['ARTHUR_AUDIO_INPUT_DEVICE'];
  const savedIndex = savedInput !== undefined ? devices.findIndex((d) => d.id === savedInput) : -1;
  io.out('Microphones\n');
  devices.forEach((d, i) => {
    const current = i === savedIndex ? ' (current)' : '';
    io.out('  [' + String(i + 1) + '] ' + d.label + current + '\n');
  });
  io.out('\n');
  if (savedInput !== undefined && savedIndex === -1) {
    io.out('Note: configured device ' + JSON.stringify(savedInput) + ' is unavailable; choose a replacement.\n\n');
  }
  const defIndex = savedIndex >= 0 ? savedIndex : 0;
  const picked = await askSelection(io, ioDeps, 'Select microphone', devices.length, defIndex);
  const device = devices[picked] as AudioDevice;
  io.out('\nSelected:\n  ' + device.label + '\n\n');
  const commands = backend.buildCommands(device);
  const captureValidator = deps.captureValidator !== undefined ? deps.captureValidator : validateCaptureTransport;
  const playbackValidator = deps.playbackValidator !== undefined ? deps.playbackValidator : validatePlaybackTransport;
  io.out('Testing microphone...\n');
  io.out('Speak for a moment...\n');
  const capture = await captureValidator(commands.captureCommand, {});
  if (!capture.transportReady) {
    io.out('Microphone test failed (' + (capture.failure !== undefined ? capture.failure : 'no audio') + ').\n');
    const retry = await askConfirm(io, ioDeps, 'Retry microphone test?', 'yes');
    if (retry) {
      const second = await captureValidator(commands.captureCommand, {});
      if (!second.transportReady) {
        const saveAnyway = await askConfirm(io, ioDeps, 'Save anyway (degraded: capture unproven)?', 'no');
        if (!saveAnyway) throw new AudioSetupCancelled();
        return commitAudioPlan(io, ioDeps, deps, layers, device, commands, false, false, true);
      }
      return commitAudioPlan(io, ioDeps, deps, layers, device, commands, true, second.signalDetected, await confirmPlayback(io, playbackValidator, commands, confirmHeard));
    }
    const saveAnyway = await askConfirm(io, ioDeps, 'Save anyway (degraded: capture unproven)?', 'no');
    if (!saveAnyway) throw new AudioSetupCancelled();
    return commitAudioPlan(io, ioDeps, deps, layers, device, commands, false, false, true);
  }
  io.out('ok audio frames received (' + String(capture.metrics.framesReceived) + ' frames)\n');
  io.out(capture.signalDetected ? 'ok signal detected\n' : 'Note: input silent/very-low (transport ready)\n');
  const audible = await confirmPlayback(io, playbackValidator, commands, confirmHeard);
  return commitAudioPlan(io, ioDeps, deps, layers, device, commands, true, capture.signalDetected, audible);
}

async function confirmPlayback(io: CliIO, playbackValidator: typeof validatePlaybackTransport, commands: { captureCommand: string; playbackCommand: string }, confirmHeard: (prompt: string) => Promise<boolean>): Promise<boolean> {
  io.out('\nTesting speaker...\n');
  io.out('Playing test tone...\n');
  const playback = await playbackValidator(commands.playbackCommand, {});
  if (!playback.transportReady) {
    io.out('Speaker test failed (' + (playback.failure !== undefined ? playback.failure : 'player error') + ').\n');
    return false;
  }
  io.out('Tone played.\n');
  return confirmHeard('Did you hear the tone?');
}

async function commitAudioPlan(io: CliIO, ioDeps: { readApprovalLine?: () => Promise<string> }, deps: AudioDeps, layers: { ambient: Record<string, string>; repo: Record<string, string>; machine: Record<string, string>; machineConfigPath?: string }, device: AudioDevice, commands: { captureCommand: string; playbackCommand: string }, captureOk: boolean, signalOk: boolean, audible: boolean): Promise<number> {
  void signalOk;
  io.out('\nReview\n');
  io.out('  Input:  ' + device.label + '\n');
  io.out('  Output: System default\n');
  io.out('  Capture backend: ' + (device.backend === 'ffmpeg-pulse' ? 'ffmpeg/pulse' : 'ffmpeg/dshow') + '\n');
  io.out('  Playback backend: ffplay\n');
  io.out('  Capture:  ' + (captureOk ? 'READY' : 'DEGRADED') + '\n');
  io.out('  Playback: ' + (audible ? 'READY (confirmed)' : 'transport only (not confirmed)') + '\n\n');
  const current: Record<string, string> = layers.machine;
  const unchanged = current['ARTHUR_AUDIO_INPUT_DEVICE'] === device.id && current['ARTHUR_AUDIO_CAPTURE_COMMAND'] === commands.captureCommand && current['ARTHUR_AUDIO_PLAYBACK_COMMAND'] === commands.playbackCommand && current['ARTHUR_AUDIO_OUTPUT_DEVICE'] === SYSTEM_DEFAULT_OUTPUT_ID;
  if (unchanged) {
    io.out('Nothing to save: configuration already matches the requested state.\n');
    return CliExit.SUCCESS;
  }
  const save = await askConfirm(io, ioDeps, 'Save audio configuration?', 'yes');
  if (!save) { io.out('Discarded. No changes were made.\n'); return CliExit.SUCCESS; }
  const patch = {
    set: {
      ARTHUR_AUDIO_INPUT_DEVICE: device.id,
      ARTHUR_AUDIO_OUTPUT_DEVICE: SYSTEM_DEFAULT_OUTPUT_ID,
      ARTHUR_AUDIO_CAPTURE_COMMAND: commands.captureCommand,
      ARTHUR_AUDIO_PLAYBACK_COMMAND: commands.playbackCommand,
    } as Record<string, string>,
    remove: [] as string[],
  };
  try {
    if (deps.commitPatch) { deps.commitPatch(patch); }
    else if (layers.machineConfigPath !== undefined) { updateMachineConfig({ set: patch.set }, layers.machineConfigPath); }
    else { updateMachineConfig({ set: patch.set }); }
  } catch (err) {
    io.err('error [INVALID_CONFIG]: could not save audio configuration: ' + (err instanceof Error ? err.message : String(err)) + '\n');
    return CliExit.INTERNAL;
  }
  io.out('Saved audio configuration.\n');
  return CliExit.SUCCESS;
}

export async function runAudio(holder: { config?: unknown }, command: string, flags: Map<string, string>, positionals: string[], io: CliIO, deps: AudioDeps = {}): Promise<number> {
  void command;
  const sub = positionals[1];
  if (sub === undefined || isHelp(flags, positionals)) {
    if (sub === undefined && !isHelp(flags, positionals)) { io.err('usage: arthur audio <detect|setup|status|test> [--json]\n'); return CliExit.USAGE; }
    io.out(AUDIO_HELP);
    return CliExit.SUCCESS;
  }
  switch (sub) {
    case 'detect': return runAudioDetect(flags, io, deps);
    case 'status': return runAudioStatus(flags, io, deps);
    case 'setup': return runAudioSetup(flags, io, deps);
    case 'test': return runAudioTest(flags, io, deps);
    default: io.err('usage: arthur audio <detect|setup|status|test> [--json]\n'); return CliExit.USAGE;
  }
}
/*MORE3*/
