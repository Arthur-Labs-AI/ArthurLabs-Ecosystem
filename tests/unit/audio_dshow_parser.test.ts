import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDshowAudioDevices, DSHOW_MAX_DEVICES } from '../../src/audio/dshow';

const REAL_LIST = [
  '[in#0 @ 0000018e8ab978c0] "Iriun Webcam" (none)',
  '[in#0 @ 0000018e8ab978c0]   Alternative name "@device_pnp_X"',
  '[in#0 @ 0000018e8ab978c0] "Redmi Note 12 Pro+ 5G (Windows Virtual Camera)" (none)',
  '[in#0 @ 0000018e8ab978c0] "OBS Virtual Camera" (none)',
  '[in#0 @ 0000018e8ab978c0] "Microphone (Iriun Webcam)" (audio)',
  '[in#0 @ 0000018e8ab978c0]   Alternative name "@device_cm_wave_{4805}"',
  '[in#0 @ 0000018e8ab978c0] "Microphone (Steam Streaming Microphone)" (audio)',
  '[in#0 @ 0000018e8ab978c0]   Alternative name "@device_cm_wave_{D6F7}"',
  '[in#0 @ 0000018e8ab978c0] "Microphone (High Definition Audio Device)" (audio)',
  '[in#0 @ 0000018e8ab978c0]   Alternative name "@device_cm_wave_{D8F3}"',
  'Error opening input file dummy.',
].join('\n');

test('B1: real list returns audio only (no webcams/cameras)', () => {
  const devices = parseDshowAudioDevices(REAL_LIST, 'ffmpeg-dshow');
  assert.equal(devices.length, 3);
  assert.deepEqual(devices.map((d) => d.id), ['Microphone (Iriun Webcam)', 'Microphone (Steam Streaming Microphone)', 'Microphone (High Definition Audio Device)']);
  assert.equal(devices[0]?.alternateName, '@device_cm_wave_{4805}');
});

test('B2: Unicode / spaces / parentheses / quotes round-trip as labels', () => {
  const out = '"Mikrofon (USB — \u00e4\u00f6\u00fc)" (audio)\n"Cam \\"Pro\\"" (audio)';
  const devices = parseDshowAudioDevices(out, 'b');
  assert.equal(devices.length, 2);
  assert.equal(devices[0]?.id, 'Mikrofon (USB — äöü)');
});

test('B3: duplicate labels preserved in order (user picks by index)', () => {
  const devices = parseDshowAudioDevices('"Mic" (audio)\n"Mic" (audio)', 'b');
  assert.equal(devices.length, 2);
  assert.equal(devices[0]?.id, 'Mic');
  assert.equal(devices[1]?.id, 'Mic');
});

test('B4: malformed lines skipped, never fatal; empty output => none', () => {
  assert.deepEqual(parseDshowAudioDevices('', 'b'), []);
  assert.deepEqual(parseDshowAudioDevices('garbage\n{{{\n', 'b'), []);
  const devices = parseDshowAudioDevices('garbage\n"Good Mic" (audio)\nmore garbage', 'b');
  assert.equal(devices.length, 1);
});

test('B5: device count bounded', () => {
  const lines: string[] = [];
  for (let i = 0; i < 200; i += 1) lines.push('"Mic ' + String(i) + '" (audio)');
  assert.equal(parseDshowAudioDevices(lines.join('\n'), 'b').length, DSHOW_MAX_DEVICES);
});

test('B6: alternative name attaches to the pending device only', () => {
  const devices = parseDshowAudioDevices('"A" (audio)\nAlternative name "alt-a"\n"B" (audio)', 'b');
  assert.equal(devices[0]?.alternateName, 'alt-a');
  assert.equal(devices[1]?.alternateName, undefined);
});
/*MORE*/
