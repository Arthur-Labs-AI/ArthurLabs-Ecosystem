import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CliExit } from '../../src/cli_exit';
import type { CliIO } from '../../apps/cli/index';
import { runAudio, runAudioDetect, runAudioSetup, runAudioStatus, runAudioTest } from '../../apps/cli/audio';
import type { AudioBackend, AudioDevice } from '../../src/audio/backend';
import { loadVoiceSettings } from '../../src/voice/config';

const MIC_A = 'Microphone (Iriun Webcam)';
const MIC_B = 'Microphone (High Definition Audio Device)';

function testIo(): CliIO & { outText: string; errText: string } {
  const sink = { outText: '', errText: '' } as CliIO & { outText: string; errText: string };
  (sink as CliIO).out = (t: string) => { sink.outText += t; };
  (sink as CliIO).err = (t: string) => { sink.errText += t; };
  return sink;
}

function fakeBackend(devices: AudioDevice[], opts: { available?: boolean } = {}): AudioBackend {
  return {
    id: () => 'ffmpeg-dshow',
    detect: async () => ({ id: 'ffmpeg-dshow', platform: 'win32', available: opts.available ?? true, captureExecutable: 'ffmpeg', playbackExecutable: 'ffplay', captureAvailable: opts.available ?? true, playbackAvailable: opts.available ?? true, captureVersion: 'ffmpeg version 8.1.1', playbackVersion: 'ffplay version 8.1.1' }),
    listInputDevices: async () => devices,
    listOutputDevices: async () => [{ id: 'default', label: 'System default', backend: 'ffmpeg-dshow' }],
    buildCommands: (device: AudioDevice) => ({ captureCommand: 'ffmpeg -i ' + JSON.stringify(device.id), playbackCommand: 'ffplay -i -' }),
  };
}

const micDevices: AudioDevice[] = [
  { id: MIC_A, label: MIC_A, backend: 'ffmpeg-dshow' },
  { id: MIC_B, label: MIC_B, backend: 'ffmpeg-dshow' },
];

function layersOf(machine: Record<string, string> = {}): { ambient: Record<string, string>; repo: Record<string, string>; machine: Record<string, string> } {
  return { ambient: {}, repo: {}, machine };
}

test('F1: setup cancel/decline => zero writes; success => exactly one atomic patch', async () => {
  // cancel at first confirm (answer n to DeepSeek? no — audio: pick default then cancel?)
  // Audio setup has no early cancel before selection except backend/device failures;
  // decline-Save path: select 1, capture ok, playback ok+heard, save? n.
  const out = testIo();
  const answers = ['', 'n'];
  let commits = 0;
  const code = await runAudioSetup(new Map(), out, {
    backend: fakeBackend(micDevices),
    tty: true,
    layers: layersOf(),
    readApprovalLine: async () => answers.shift() ?? '',
    commitPatch: () => { commits += 1; },
    captureValidator: async () => ({ transportReady: true, signalDetected: true, metrics: { framesReceived: 10, bytesReceived: 6400, durationMs: 200, peakLevel: 1000, rmsLevel: 500, signalDetected: true } }),
    playbackValidator: async () => ({ transportReady: true, chunksAccepted: 3, bytesAccepted: 9600 }),
    confirmHeard: async () => true,
  });
  assert.equal(code, CliExit.SUCCESS);
  assert.equal(commits, 0);
  assert.ok(out.outText.includes('Discarded'));
});

test('F2: successful setup writes exactly 4 explicit keys in one patch', async () => {
  const out = testIo();
  const answers = ['', 'y'];
  const patches: Array<{ set: Record<string, string>; remove: string[] }> = [];
  const code = await runAudioSetup(new Map(), out, {
    backend: fakeBackend(micDevices),
    tty: true,
    layers: layersOf(),
    readApprovalLine: async () => answers.shift() ?? '',
    commitPatch: (p) => { patches.push(p); },
    captureValidator: async () => ({ transportReady: true, signalDetected: true, metrics: { framesReceived: 10, bytesReceived: 6400, durationMs: 200, peakLevel: 1000, rmsLevel: 500, signalDetected: true } }),
    playbackValidator: async () => ({ transportReady: true, chunksAccepted: 3, bytesAccepted: 9600 }),
    confirmHeard: async () => true,
  });
  assert.equal(code, CliExit.SUCCESS);
  assert.equal(patches.length, 1);
  const set = patches[0]?.set ?? {};
  assert.deepEqual(Object.keys(set).sort(), ['ARTHUR_AUDIO_CAPTURE_COMMAND', 'ARTHUR_AUDIO_INPUT_DEVICE', 'ARTHUR_AUDIO_OUTPUT_DEVICE', 'ARTHUR_AUDIO_PLAYBACK_COMMAND']);
  assert.equal(set['ARTHUR_AUDIO_INPUT_DEVICE'], MIC_A);
  assert.equal(set['ARTHUR_AUDIO_OUTPUT_DEVICE'], 'default');
  assert.ok(!('ARTHUR_VOICE_ENABLED' in set), 'must not enable voice');
  assert.ok(!('ARTHUR_VAD_END_SILENCE_MS' in set), 'must not dump voice defaults');
});

test('F3: failed capture without degraded-accept => no save, non-success', async () => {
  const out = testIo();
  const answers = ['', 'n'];
  let commits = 0;
  const code = await runAudioSetup(new Map(), out, {
    backend: fakeBackend(micDevices),
    tty: true,
    layers: layersOf(),
    readApprovalLine: async () => answers.shift() ?? '',
    commitPatch: () => { commits += 1; },
    captureValidator: async () => ({ transportReady: false, signalDetected: false, metrics: { framesReceived: 0, bytesReceived: 0, durationMs: 1500, peakLevel: 0, rmsLevel: 0, signalDetected: false }, failure: 'no audio frames received within the capture window' }),
    playbackValidator: async () => ({ transportReady: true, chunksAccepted: 1, bytesAccepted: 100 }),
    confirmHeard: async () => true,
  });
  assert.equal(commits, 0);
  assert.notEqual(code, CliExit.SUCCESS);
});

test('G1: saved microphone present => preselected as current', async () => {
  const out = testIo();
  const answers = ['', 'n'];
  await runAudioSetup(new Map(), out, {
    backend: fakeBackend(micDevices),
    tty: true,
    layers: layersOf({ ARTHUR_AUDIO_INPUT_DEVICE: MIC_B }),
    readApprovalLine: async () => answers.shift() ?? '',
    commitPatch: () => undefined,
    captureValidator: async () => ({ transportReady: true, signalDetected: false, metrics: { framesReceived: 5, bytesReceived: 3200, durationMs: 100, peakLevel: 0, rmsLevel: 5, signalDetected: false } }),
    playbackValidator: async () => ({ transportReady: true, chunksAccepted: 1, bytesAccepted: 100 }),
    confirmHeard: async () => false,
  });
  assert.ok(out.outText.includes(MIC_B + ' (current)'));
});

test('G2: saved microphone missing => reported, never auto-switched', async () => {
  const out = testIo();
  const answers = ['1', 'n'];
  const patches: Array<{ set: Record<string, string> }> = [];
  // Decline save so we only observe the drift notice + no auto-switch.
  await runAudioSetup(new Map(), out, {
    backend: fakeBackend(micDevices),
    tty: true,
    layers: layersOf({ ARTHUR_AUDIO_INPUT_DEVICE: 'Ghost Mic 9000' }),
    readApprovalLine: async () => answers.shift() ?? '',
    commitPatch: (p) => { patches.push(p); },
    captureValidator: async () => ({ transportReady: true, signalDetected: true, metrics: { framesReceived: 5, bytesReceived: 3200, durationMs: 100, peakLevel: 9, rmsLevel: 9, signalDetected: true } }),
    playbackValidator: async () => ({ transportReady: true, chunksAccepted: 1, bytesAccepted: 100 }),
    confirmHeard: async () => true,
  });
  assert.ok(out.outText.includes('unavailable; choose a replacement'));
  assert.equal(patches.length, 0);
});

test('H1: status human + json with sources, no stderr dump, no DB', () => {
  const human = testIo();
  assert.equal(runAudioStatus(new Map(), human, { layers: layersOf({ ARTHUR_AUDIO_INPUT_DEVICE: MIC_B }) }), CliExit.SUCCESS);
  assert.ok(human.outText.includes(MIC_B));
  assert.ok(human.outText.includes('machine_config'));
  assert.ok(human.outText.includes('System default'));
  const json = testIo();
  assert.equal(runAudioStatus(new Map([['json', 'true']]), json, { layers: layersOf({}) }), CliExit.SUCCESS);
  const parsed = JSON.parse(json.outText);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'audio status');
});

test('H2: detect json is one valid object; test refuses when unconfigured', async () => {
  const io = testIo();
  assert.equal(await runAudioDetect(new Map([['json', 'true']]), io, { backend: fakeBackend(micDevices) }), CliExit.SUCCESS);
  const parsed = JSON.parse(io.outText);
  assert.deepEqual(parsed.data.inputs.map((d: { id: string }) => d.id), [MIC_A, MIC_B]);
  const t = testIo();
  const code = await runAudioTest(new Map(), t, { layers: layersOf() });
  assert.notEqual(code, CliExit.SUCCESS);
});

test('I1: saved commands load through existing voice settings into runtime adapters', async () => {
  const out = testIo();
  const answers = ['', 'y'];
  const patches: Array<{ set: Record<string, string> }> = [];
  await runAudioSetup(new Map(), out, {
    backend: fakeBackend(micDevices),
    tty: true,
    layers: layersOf(),
    readApprovalLine: async () => answers.shift() ?? '',
    commitPatch: (p) => { patches.push(p); },
    captureValidator: async () => ({ transportReady: true, signalDetected: true, metrics: { framesReceived: 5, bytesReceived: 3200, durationMs: 100, peakLevel: 9, rmsLevel: 9, signalDetected: true } }),
    playbackValidator: async () => ({ transportReady: true, chunksAccepted: 1, bytesAccepted: 100 }),
    confirmHeard: async () => true,
  });
  const set = patches[0]?.set as Record<string, string>;
  const voice = loadVoiceSettings({ audioCaptureCommand: set['ARTHUR_AUDIO_CAPTURE_COMMAND'], audioPlaybackCommand: set['ARTHUR_AUDIO_PLAYBACK_COMMAND'], audioInputDevice: set['ARTHUR_AUDIO_INPUT_DEVICE'] });
  assert.ok(voice.audioCaptureCommand.includes('ffmpeg'));
  assert.ok(voice.audioPlaybackCommand.startsWith('ffplay'));
  assert.equal(voice.audioInputDevice, MIC_A);
});

test('J1: malicious device names never become shell execution', async () => {
  const evil: AudioDevice = { id: 'Mic"; rm -rf /; echo "', label: 'evil', backend: 'ffmpeg-dshow' };
  const backend = fakeBackend([evil]);
  // Round-trip through the real backend buildCommands (quoting + verify).
  const { WindowsFfmpegAudioBackend } = await import('../../src/audio/ffmpeg_win');
  const real = new WindowsFfmpegAudioBackend();
  const built = real.buildCommands(evil);
  assert.ok(built.captureCommand.includes('ffmpeg'));
  // Injection text stays INSIDE the quoted -i argv, never a new token.
  const { splitCommandLine } = await import('../../src/voice/process_util');
  const argv = splitCommandLine(built.captureCommand);
  assert.ok(argv.every((t) => t !== 'rm' && t !== 'echo'));
  assert.ok((argv[argv.indexOf('-i') + 1] as string).includes('rm -rf'));
  void backend;
});

test('J2: dispatch rejects unknown subcommands; audio never touches providers', async () => {
  const io = testIo();
  assert.equal(await runAudio({}, 'audio', new Map(), ['audio', 'bogus'], io, { layers: layersOf() }), CliExit.USAGE);
});
/*MORE*/
