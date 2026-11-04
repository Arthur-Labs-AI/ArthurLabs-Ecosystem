import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitCommandLine } from '../../src/voice/process_util';
import { buildWindowsCaptureCommand, buildWindowsPlaybackCommand, buildAudioCommands, resolveCaptureDeviceName } from '../../src/audio/commands';

function inputOf(command: string): string | undefined {
  const argv = splitCommandLine(command);
  const i = argv.indexOf('-i');
  return argv[i + 1];
}

test('C1: normal device generates canonical capture shape', () => {
  const cmd = buildWindowsCaptureCommand('Microphone (High Definition Audio Device)');
  assert.ok(cmd.startsWith('ffmpeg -hide_banner -loglevel error -f dshow -i '));
  assert.ok(cmd.includes('-ac 1 -ar 16000 -f s16le pipe:1'));
  assert.equal(inputOf(cmd), 'audio=Microphone (High Definition Audio Device)');
});

test('C2: spaces/parens/unicode round-trip through the runtime tokenizer', () => {
  for (const name of ['Mic (USB)', 'Mikrofon — äöü', 'A+B=C;D,E.F-G_H']) {
    assert.equal(inputOf(buildWindowsCaptureCommand(name)), 'audio=' + name);
  }
});

test('C3: embedded quotes escape and round-trip', () => {
  const cmd = buildWindowsCaptureCommand('Cam "Pro" Mic');
  assert.equal(inputOf(cmd), 'audio=Cam "Pro" Mic');
});

test('C4: control chars / empty / trailing backslash fail closed', () => {
  assert.throws(() => buildWindowsCaptureCommand(''), /1\.\.256/);
  assert.throws(() => buildWindowsCaptureCommand('Mic\nName'), /control/);
  assert.throws(() => buildWindowsCaptureCommand('Mic\\'), /backslash/);
});

test('C5: playback command is exact current-ffplay shape', () => {
  const cmd = buildWindowsPlaybackCommand();
  assert.equal(cmd, 'ffplay -hide_banner -loglevel error -nodisp -autoexit -f s16le -ar 16000 -ch_layout mono -i -');
  assert.ok(!cmd.includes('-ac 1 -'), 'obsolete -ac 1 - form must not reappear');
});

test('C6: buildAudioCommands pairs capture+playback for a device', () => {
  const built = buildAudioCommands({ id: 'Mic', label: 'Mic', backend: 'ffmpeg-dshow' });
  assert.ok(built.captureCommand.includes('ffmpeg'));
  assert.ok(built.playbackCommand.startsWith('ffplay'));
});
test('C7: comma in primary name prefers the comma-free alternate name', () => {
  const name = resolveCaptureDeviceName({ id: 'Mic, USB', label: 'Mic, USB', backend: 'ffmpeg-dshow', alternateName: '@device_cm_wave_{1234}' });
  assert.equal(name, '@device_cm_wave_{1234}');
  const built = buildAudioCommands({ id: 'Mic, USB', label: 'Mic, USB', backend: 'ffmpeg-dshow', alternateName: '@device_cm_wave_{1234}' });
  assert.ok(built.captureCommand.includes('@device_cm_wave_{1234}'));
});

test('C8: comma without alternate fails closed with explicit guidance', () => {
  assert.throws(() => resolveCaptureDeviceName({ id: 'Mic, USB', label: 'Mic, USB', backend: 'ffmpeg-dshow' }), /comma/);
});
/*MORE*/