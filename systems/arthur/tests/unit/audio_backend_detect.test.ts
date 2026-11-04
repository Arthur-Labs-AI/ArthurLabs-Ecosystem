import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WindowsFfmpegAudioBackend, FFMPEG_LIST_ARGS } from '../../src/audio/ffmpeg_win';

function runFn(responses: Record<string, { stdout?: string; stderr?: string; exitCode?: number | null; error?: string }>): (exe: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> {
  return async (exe: string, args: string[]) => {
    const key = exe + ' ' + args.join(' ');
    const hit = responses[key] ?? responses[exe];
    if (!hit) return { stdout: '', stderr: '', exitCode: null, error: 'ENOENT: ' + exe };
    return { stdout: hit.stdout ?? '', stderr: hit.stderr ?? '', exitCode: hit.exitCode ?? 0, ...(hit.error !== undefined ? { error: hit.error } : {}) };
  };
}

const VERSION_OUT = 'ffmpeg version 8.1.1-essentials_build-www.gyan.dev Copyright (c) 2000-2026';

test('A1: ffmpeg+ffplay present => available with versions', async () => {
  const backend = new WindowsFfmpegAudioBackend({ runFn: runFn({ 'ffmpeg': { stdout: VERSION_OUT }, 'ffplay': { stdout: 'ffplay version 8.1.1' } }) });
  const info = await backend.detect();
  assert.equal(info.available, true);
  assert.equal(info.captureAvailable, true);
  assert.equal(info.playbackAvailable, true);
  assert.ok(info.captureVersion.includes('ffmpeg version'));
});

test('A2: ffplay missing => playback unavailable, overall not available', async () => {
  const backend = new WindowsFfmpegAudioBackend({ runFn: runFn({ 'ffmpeg': { stdout: VERSION_OUT } }) });
  const info = await backend.detect();
  assert.equal(info.captureAvailable, true);
  assert.equal(info.playbackAvailable, false);
  assert.equal(info.available, false);
});

test('A3: both missing => backend unavailable (no throw)', async () => {
  const backend = new WindowsFfmpegAudioBackend({ runFn: runFn({}) });
  const info = await backend.detect();
  assert.equal(info.available, false);
  assert.equal(info.captureVersion, '');
});

test('A4: discovery uses argv list (no shell) over stderr OR stdout', async () => {
  const seen: string[][] = [];
  const backend = new WindowsFfmpegAudioBackend({
    runFn: async (exe: string, args: string[]) => {
      seen.push([exe, ...args]);
      if (args.includes('-list_devices')) return { stdout: '', stderr: 'dummy', exitCode: 1 };
      return { stdout: VERSION_OUT, stderr: '', exitCode: 0 };
    },
  });
  await backend.listInputDevices();
  const list = seen.find((a) => a.includes('-list_devices'));
  assert.deepEqual(list, ['ffmpeg', ...FFMPEG_LIST_ARGS]);
  assert.ok(!list.join(' ').includes('dummy;') && !list.join(' ').includes('|'));
});
/*MORE*/
