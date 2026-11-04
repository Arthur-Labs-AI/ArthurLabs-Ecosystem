/**
 * FRS-03.1: Linux audio backend tests (deterministic, no hardware).
 *
 * Covers the §14 matrix: factory routing, Pulse JSON/short parsing
 * (monitors excluded, stable names, unicode, duplicates, malformed,
 * bounds), stable identities, detect() capability semantics, Linux
 * command generation + tokenizer safety, audio CLI on Linux, unified
 * setup factory use, doctor capability logic, and Windows regressions
 * by reference (existing FRS-03 suite must stay green).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AudioDevice } from '../../src/audio/backend';
import { createAudioBackendForPlatform, UnsupportedAudioBackend, isUnsupportedAudioBackend } from '../../src/audio/factory';
import { WindowsFfmpegAudioBackend } from '../../src/audio/ffmpeg_win';
import { LinuxFfmpegAudioBackend } from '../../src/audio/ffmpeg_linux';
import { parsePulseAudioSources, parsePulseShortSources } from '../../src/audio/pulse';
import { buildLinuxCaptureCommand, buildLinuxAudioCommands } from '../../src/audio/commands';
import { splitCommandLine } from '../../src/voice/process_util';
import { diagnoseDoctor } from '../../src/doctor/diagnose';
import { defaultStateFile } from '../../src/runtime/local-models/state_contracts';
import type { HardwareProfile } from '../../src/runtime/hardware/contracts';

type RunResult = { stdout: string; stderr: string; exitCode: number | null; error?: string };

function runFn(responses: Record<string, { stdout?: string; stderr?: string; exitCode?: number | null; error?: string }>): (exe: string, args: string[]) => Promise<RunResult> {
  return async (exe: string, args: string[]) => {
    const key = exe + ' ' + args.join(' ');
    const hit = responses[key] ?? responses[exe];
    if (!hit) return { stdout: '', stderr: '', exitCode: null, error: 'ENOENT: ' + exe };
    return { stdout: hit.stdout ?? '', stderr: hit.stderr ?? '', exitCode: hit.exitCode ?? 0, ...(hit.error !== undefined ? { error: hit.error } : {}) };
  };
}

const VERSION_OUT = 'ffmpeg version n9.0.1 Copyright (c) 2000-2026';
const DEVICES_OUT = 'Demuxers:\n D pulse           Pulse audio output\n D alsa            ALSA audio output';
const DEVICES_NO_PULSE = 'Demuxers:\n D alsa            ALSA audio output';

const JSON_SOURCES = JSON.stringify([
  { index: 52, name: 'alsa_input.pci-0000_05_00.6.analog-stereo', description: 'Ryzen HD Audio Controller Analog Stereo', properties: { 'device.class': 'sound' } },
  { index: 51, name: 'alsa_output.pci-0000_05_00.6.analog-stereo.monitor', description: 'Monitor of Ryzen HD Audio Controller Analog Stereo', properties: { 'device.class': 'monitor' } },
]);

const SHORT_SOURCES = '51\talsa_output.pci-0000_05_00.6.analog-stereo.monitor\tPipeWire\ts32le 2ch 48000Hz\tSUSPENDED\n52\talsa_input.pci-0000_05_00.6.analog-stereo\tPipeWire\ts32le 2ch 48000Hz\tSUSPENDED\n';

function readyLinuxRunFn(): (exe: string, args: string[]) => Promise<RunResult> {
  return runFn({
    'ffmpeg': { stdout: VERSION_OUT },
    'ffplay': { stdout: 'ffplay version n9.0.1' },
    'ffmpeg -hide_banner -devices': { stdout: DEVICES_OUT },
    'pactl -f json list sources': { stdout: JSON_SOURCES },
    'pactl list short sources': { stdout: SHORT_SOURCES },
  });
}

const TEST_HARDWARE: HardwareProfile = {
  os: 'linux',
  arch: 'x64',
  memory: { total_mb: 16384 },
  cpu: { logical_cores: 8, model: 'Test CPU' },
  gpus: [],
  accelerators: { cuda: 'unavailable', rocm: 'unavailable', vulkan: 'unknown', directml: 'unavailable', npu: 'unknown' },
};

// ---- A. platform factory ----------------------------------------------------------

test('A1: win32 routes to the Windows DirectShow backend', () => {
  const backend = createAudioBackendForPlatform({ platform: 'win32' });
  assert.ok(backend instanceof WindowsFfmpegAudioBackend);
  assert.equal(backend.id(), 'ffmpeg-dshow');
});

test('A2: linux routes to the Linux Pulse backend', () => {
  const backend = createAudioBackendForPlatform({ platform: 'linux' });
  assert.ok(backend instanceof LinuxFfmpegAudioBackend);
  assert.equal(backend.id(), 'ffmpeg-pulse');
});

test('A3: unsupported platform yields the explicit unsupported backend', async () => {
  const backend = createAudioBackendForPlatform({ platform: 'darwin' });
  assert.ok(backend instanceof UnsupportedAudioBackend);
  assert.ok(isUnsupportedAudioBackend(backend));
  assert.equal(isUnsupportedAudioBackend(createAudioBackendForPlatform({ platform: 'win32' })), false);
  const info = await backend.detect();
  assert.equal(info.available, false);
  assert.equal(info.captureAvailable, false);
  assert.deepEqual(await backend.listInputDevices(), []);
  assert.throws(() => backend.buildCommands(), /not supported/);
});

// ---- B. Linux discovery parser -------------------------------------------------------

test('B1: JSON list yields the microphone and excludes the monitor loopback', () => {
  const devices = parsePulseAudioSources(JSON_SOURCES, 'ffmpeg-pulse');
  assert.equal(devices.length, 1);
  assert.equal(devices[0]?.id, 'alsa_input.pci-0000_05_00.6.analog-stereo');
  assert.equal(devices[0]?.label, 'Ryzen HD Audio Controller Analog Stereo');
  assert.equal(devices[0]?.backend, 'ffmpeg-pulse');
});

test('B2: multiple microphones, unicode labels, duplicates preserved', () => {
  const out = JSON.stringify([
    { name: 'mic-a', description: 'Микрофон USB 🎙️' },
    { name: 'mic-b', description: 'Second mic' },
    { name: 'mic-a', description: 'Микрофон USB 🎙️' },
  ]);
  const devices = parsePulseAudioSources(out, 'ffmpeg-pulse');
  assert.equal(devices.length, 3);
  assert.equal(devices[0]?.label, 'Микрофон USB 🎙️');
  assert.equal(devices[2]?.id, 'mic-a');
});

test('B3: malformed JSON and non-array shapes yield empty (never throw)', () => {
  assert.deepEqual(parsePulseAudioSources('not json{{{', 'ffmpeg-pulse'), []);
  assert.deepEqual(parsePulseAudioSources('{"a":1}', 'ffmpeg-pulse'), []);
  assert.deepEqual(parsePulseAudioSources('', 'ffmpeg-pulse'), []);
});

test('B4: bounded input — oversized payload truncated, device cap honored', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ name: 'mic-' + String(i), description: 'Mic ' + String(i) }));
  const devices = parsePulseAudioSources(JSON.stringify(many), 'ffmpeg-pulse');
  assert.ok(devices.length <= 64);
  const huge = 'x'.repeat(2 * 1024 * 1024);
  assert.deepEqual(parsePulseAudioSources(huge, 'ffmpeg-pulse'), []);
});

test('B5: short fallback excludes monitors and never persists numeric indices', () => {
  const devices = parsePulseShortSources(SHORT_SOURCES, 'ffmpeg-pulse');
  assert.equal(devices.length, 1);
  assert.equal(devices[0]?.id, 'alsa_input.pci-0000_05_00.6.analog-stereo');
});

test('B6: device.class monitor excluded even without .monitor suffix', () => {
  const out = JSON.stringify([{ name: 'weird-loopback', description: 'Loop', properties: { 'device.class': 'monitor' } }]);
  assert.deepEqual(parsePulseAudioSources(out, 'ffmpeg-pulse'), []);
});

// ---- C. stable identities -----------------------------------------------------------------

test('C1: persisted identity is the stable source name, not the numeric index', async () => {
  const backend = new LinuxFfmpegAudioBackend({ runFn: readyLinuxRunFn() });
  const devices = await backend.listInputDevices();
  assert.equal(devices.length, 1);
  assert.ok(!(devices[0]?.id ?? '').match(/^[0-9]+$/));
  assert.equal(devices[0]?.id, 'alsa_input.pci-0000_05_00.6.analog-stereo');
});

// ---- D. detect() capability semantics ----------------------------------------------------------

test('D1: fully ready Linux backend reports available', async () => {
  const backend = new LinuxFfmpegAudioBackend({ runFn: readyLinuxRunFn() });
  const info = await backend.detect();
  assert.equal(info.available, true);
  assert.equal(info.captureAvailable, true);
  assert.equal(info.playbackAvailable, true);
  assert.equal(info.id, 'ffmpeg-pulse');
});

test('D2: ffmpeg missing => capture unavailable (not zero microphones)', async () => {
  const backend = new LinuxFfmpegAudioBackend({
    runFn: runFn({
      'ffplay': { stdout: 'ffplay version n9.0.1' },
      'ffmpeg -hide_banner -devices': { stdout: DEVICES_OUT },
      'pactl -f json list sources': { stdout: JSON_SOURCES },
    }),
  });
  const info = await backend.detect();
  assert.equal(info.captureAvailable, false);
  assert.equal(info.available, false);
});

test('D3: ffplay missing => playback unavailable only', async () => {
  const backend = new LinuxFfmpegAudioBackend({
    runFn: runFn({
      'ffmpeg': { stdout: VERSION_OUT },
      'ffmpeg -hide_banner -devices': { stdout: DEVICES_OUT },
      'pactl -f json list sources': { stdout: JSON_SOURCES },
      'pactl list short sources': { stdout: SHORT_SOURCES },
    }),
  });
  const info = await backend.detect();
  assert.equal(info.captureAvailable, true);
  assert.equal(info.playbackAvailable, false);
  assert.equal(info.available, false);
});

test('D4: FFmpeg without pulse demuxer => capture unavailable', async () => {
  const backend = new LinuxFfmpegAudioBackend({
    runFn: runFn({
      'ffmpeg': { stdout: VERSION_OUT },
      'ffplay': { stdout: 'ffplay version n9.0.1' },
      'ffmpeg -hide_banner -devices': { stdout: DEVICES_NO_PULSE },
      'pactl -f json list sources': { stdout: JSON_SOURCES },
    }),
  });
  const info = await backend.detect();
  assert.equal(info.captureAvailable, false);
  assert.equal(info.available, false);
});

test('D5: pactl missing / Pulse unavailable => capture unavailable', async () => {
  const backend = new LinuxFfmpegAudioBackend({
    runFn: runFn({
      'ffmpeg': { stdout: VERSION_OUT },
      'ffplay': { stdout: 'ffplay version n9.0.1' },
      'ffmpeg -hide_banner -devices': { stdout: DEVICES_OUT },
    }),
  });
  const info = await backend.detect();
  assert.equal(info.captureAvailable, false);
  assert.equal(info.available, false);
  assert.deepEqual(await backend.listInputDevices(), []);
});

// ---- E. command generation --------------------------------------------------------------------------

test('E1: Linux capture command shape (pulse, mono, 16k, s16le, pipe:1)', () => {
  const cmd = buildLinuxCaptureCommand('alsa_input.pci-0000_05_00.6.analog-stereo');
  assert.ok(cmd.startsWith('ffmpeg '));
  assert.ok(cmd.includes('-f pulse'));
  assert.ok(cmd.includes('-ac 1'));
  assert.ok(cmd.includes('-ar 16000'));
  assert.ok(cmd.includes('-f s16le'));
  assert.ok(cmd.endsWith('pipe:1'));
  const argv = splitCommandLine(cmd);
  assert.equal(argv[argv.indexOf('-i') + 1], 'alsa_input.pci-0000_05_00.6.analog-stereo');
});

test('E2: pair builder emits playback for the system-default sink', () => {
  const device: AudioDevice = { id: 'mic-a', label: 'Mic A', backend: 'ffmpeg-pulse' };
  const pair = buildLinuxAudioCommands(device);
  assert.ok(pair.playbackCommand.startsWith('ffplay '));
  assert.ok(pair.playbackCommand.includes('-i -'));
  assert.ok(pair.captureCommand.includes('mic-a'));
});

test('E3: hostile source names cannot inject shell args (quoted + verified)', () => {
  const hostile = 'mic; rm -rf / | evil $(x)';
  const cmd = buildLinuxCaptureCommand(hostile);
  const argv = splitCommandLine(cmd);
  assert.equal(argv[argv.indexOf('-i') + 1], hostile);
  assert.ok(!argv.includes('rm'));
  assert.throws(() => buildLinuxCaptureCommand('bad\u0000name'), /NUL|control|1\.\.256/);
  assert.throws(() => buildLinuxCaptureCommand('trailing\\'), /backslash/);
  const backend = new LinuxFfmpegAudioBackend({ runFn: readyLinuxRunFn() });
  assert.throws(() => backend.buildCommands({ id: 'x', label: 'x', backend: 'ffmpeg-dshow' }), /different audio backend/);
});

// ---- F. audio CLI on Linux --------------------------------------------------------------------------------

test('F1: Linux detect returns mocked sources; setup saves exactly four keys', async () => {
  const { runAudioDetect, runAudioSetup } = await import('../../apps/cli/audio');
  const out: string[] = [];
  const io = { out: (t: string) => { out.push(t); }, err: (t: string) => { out.push('ERR:' + t); } };
  const backend = new LinuxFfmpegAudioBackend({ runFn: readyLinuxRunFn() });
  const detectCode = await runAudioDetect(new Map(), io, { backend });
  assert.equal(detectCode, 0);
  assert.ok(out.join('').includes('Ryzen HD Audio Controller Analog Stereo'));
  const saved: { set: Record<string, string>; remove: string[] }[] = [];
  const answers = ['1', 'yes'];
  let answerAt = 0;
  const setupIo = { out: (t: string) => { void t; }, err: (t: string) => { void t; } };
  const setupCode = await runAudioSetup(new Map(), setupIo, {
    backend,
    tty: true,
    readApprovalLine: async () => answers[answerAt++] ?? 'yes',
    layers: { ambient: {}, repo: {}, machine: {} },
    commitPatch: (patch) => { saved.push(patch); },
    captureValidator: async () => ({ transportReady: true, signalDetected: true, metrics: { framesReceived: 40, bytesReceived: 25600, durationMs: 1500, peakLevel: 1000, rmsLevel: 500, signalDetected: true } }),
    playbackValidator: async () => ({ transportReady: true, chunksAccepted: 5, bytesAccepted: 1000 }),
    confirmHeard: async () => true,
  });
  assert.equal(setupCode, 0);
  assert.equal(saved.length, 1);
  const keys = Object.keys(saved[0]?.set ?? {}).sort();
  assert.deepEqual(keys, ['ARTHUR_AUDIO_CAPTURE_COMMAND', 'ARTHUR_AUDIO_INPUT_DEVICE', 'ARTHUR_AUDIO_OUTPUT_DEVICE', 'ARTHUR_AUDIO_PLAYBACK_COMMAND']);
  assert.ok((saved[0]?.set['ARTHUR_AUDIO_CAPTURE_COMMAND'] ?? '').includes('-f pulse'));
  assert.equal(saved[0]?.set['ARTHUR_AUDIO_INPUT_DEVICE'], 'alsa_input.pci-0000_05_00.6.analog-stereo');
});

test('F2: decline-Save and failed capture without degraded-accept write nothing', async () => {
  const { runAudioSetup } = await import('../../apps/cli/audio');
  const quiet = { out: (t: string) => { void t; }, err: (t: string) => { void t; } };
  const backend = new LinuxFfmpegAudioBackend({ runFn: readyLinuxRunFn() });
  let writes = 0;
  // Decline at Save ('', select default; 'n', discard): zero writes.
  const declineAnswers = ['', 'n'];
  await runAudioSetup(new Map(), quiet, {
    backend,
    tty: true,
    readApprovalLine: async () => declineAnswers.shift() ?? '',
    layers: { ambient: {}, repo: {}, machine: {} },
    commitPatch: () => { writes += 1; },
    captureValidator: async () => ({ transportReady: true, signalDetected: true, metrics: { framesReceived: 1, bytesReceived: 64, durationMs: 10, peakLevel: 1, rmsLevel: 1, signalDetected: true } }),
    playbackValidator: async () => ({ transportReady: true, chunksAccepted: 1, bytesAccepted: 10 }),
    confirmHeard: async () => true,
  });
  assert.equal(writes, 0);
  // Failed capture, no retry, no degraded-accept: no save, non-success.
  const failAnswers = ['', 'n'];
  const failCode = await runAudioSetup(new Map(), quiet, {
    backend,
    tty: true,
    readApprovalLine: async () => failAnswers.shift() ?? '',
    layers: { ambient: {}, repo: {}, machine: {} },
    commitPatch: () => { writes += 1; },
    captureValidator: async () => ({ transportReady: false, signalDetected: false, metrics: { framesReceived: 0, bytesReceived: 0, durationMs: 1500, peakLevel: 0, rmsLevel: 0, signalDetected: false }, failure: 'no audio frames received within the capture window' }),
    playbackValidator: async () => ({ transportReady: true, chunksAccepted: 1, bytesAccepted: 10 }),
    confirmHeard: async () => true,
  });
  assert.equal(writes, 0);
  assert.notEqual(failCode, 0);
});

// ---- G. unified setup uses the factory --------------------------------------------------------------------

test('G1: no direct Windows backend construction remains in audio/setup/doctor CLIs', async () => {
  const fs = await import('node:fs');
  for (const file of ['apps/cli/audio.ts', 'apps/cli/setup_unified.ts', 'apps/cli/doctor.ts']) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes('new WindowsFfmpegAudioBackend'), file + ' must use the factory');
    assert.ok(text.includes('createAudioBackendForPlatform'), file + ' must import the factory');
  }
});

// ---- H. doctor capability logic ----------------------------------------------------------------------------------

function doctorArgs(overrides: Record<string, unknown> = {}): Parameters<typeof diagnoseDoctor>[0] {
  return {
    layers: { ambient: {}, repo: {}, machine: { DEEPSEEK_API_KEY: 'k', OPENAI_API_KEY: 'k2', ARTHUR_VOICE_ENABLED: 'true', ARTHUR_STT_POLICY: 'cloud_preferred', ARTHUR_TTS_POLICY: 'cloud_preferred', ARTHUR_AUDIO_INPUT_DEVICE: 'mic-a', ARTHUR_AUDIO_CAPTURE_COMMAND: 'ffmpeg -f pulse -i mic-a -ac 1 -ar 16000 -f s16le pipe:1', ARTHUR_AUDIO_PLAYBACK_COMMAND: 'ffplay -i -' }, machineConfigPath: '/d' },
    file: { configPath: '/d', present: true, readable: true, entryCount: 8 },
    audio: {
      info: { id: 'ffmpeg-pulse', platform: 'linux', available: true, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: true, playbackAvailable: true, captureVersion: 'v', playbackVersion: 'v' },
      inputs: [{ id: 'mic-a', label: 'Mic A', backend: 'ffmpeg-pulse' }],
      discoverySupported: true,
    },
    models: { statePath: '/s', statePresent: false, snapshot: defaultStateFile(), hardware: TEST_HARDWARE, managedRoot: '/m', exists: () => true },
    live: false,
    interactive: false,
    ...overrides,
  } as Parameters<typeof diagnoseDoctor>[0];
}

function checkStatus(report: { checks: { id: string; status: string }[] }, id: string): string {
  const hit = report.checks.find((c) => c.id === id);
  assert.ok(hit, 'missing check ' + id);
  return (hit as { status: string }).status;
}

test('H1: Linux supported + device present passes without Windows wording', async () => {
  const report = await diagnoseDoctor(doctorArgs());
  assert.equal(checkStatus(report, 'audio.input.device'), 'pass');
  assert.ok(!JSON.stringify(report).toLowerCase().includes('dshow'));
});

test('H2: Linux supported + saved device gone detects drift', async () => {
  const report = await diagnoseDoctor(doctorArgs({
    audio: {
      info: { id: 'ffmpeg-pulse', platform: 'linux', available: true, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: true, playbackAvailable: true, captureVersion: 'v', playbackVersion: 'v' },
      inputs: [{ id: 'other-mic', label: 'Other', backend: 'ffmpeg-pulse' }],
      discoverySupported: true,
    },
  }));
  assert.equal(checkStatus(report, 'audio.input.device'), 'fail');
  const hit = report.checks.find((c) => c.id === 'audio.input.device');
  assert.equal((hit as { remediation?: string })?.remediation, 'arthur audio setup');
});

test('H3: backend unavailable reports capability failure, not zero microphones', async () => {
  const report = await diagnoseDoctor(doctorArgs({
    audio: {
      info: { id: 'ffmpeg-pulse', platform: 'linux', available: false, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: false, playbackAvailable: true, captureVersion: 'v', playbackVersion: 'v' },
      inputs: [],
      discoverySupported: false,
    },
  }));
  const device = report.checks.find((c) => c.id === 'audio.input.device');
  assert.equal((device as { status: string })?.status, 'skipped');
  assert.match((device as { message: string })?.message ?? '', /not supported/);
  assert.ok(!JSON.stringify(report).includes('No microphones detected'));
});
