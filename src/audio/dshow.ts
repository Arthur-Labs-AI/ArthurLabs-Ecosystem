/**
 * FRS-03: Windows DirectShow device-list parser (pure, deterministic).
 *
 * Parses the bounded text of:
 *
 *   ffmpeg -hide_banner -list_devices true -f dshow -i dummy
 *
 * FFmpeg commonly exits non-zero for this LIST operation, so callers must
 * NOT treat exit codes as discovery failure — parse the output instead.
 * Only `(audio)` entries are returned; `(none)`/video entries (webcams,
 * virtual cameras) are never microphones. Handles Unicode, spaces,
 * parentheses, quotes, duplicate labels, and Alternative names. Bounded:
 * device count, name length, and total input size are capped; malformed
 * lines are skipped, never fatal.
 */

import type { AudioDevice } from './backend';

/** Hard bounds for discovery parsing (never unbounded). */
export const DSHOW_MAX_INPUT_CHARS = 256 * 1024;
export const DSHOW_MAX_DEVICES = 64;
export const DSHOW_MAX_NAME_CHARS = 256;

export interface ParsedDshowDevice {
  name: string;
  alternateName?: string;
}

/** Match `"Name" (audio)` — the canonical dshow list line shape. */
const AUDIO_LINE_RE = /^"((?:[^"\\]|\\.)*)"\s+\(audio\)\s*$/;
/** Match `Alternative name "..."` continuation lines. */
const ALT_NAME_RE = /^Alternative name\s+"((?:[^"\\]|\\.)*)"\s*$/;

function unescapeDshowQuoted(raw: string): string {
  // dshow escapes embedded quotes/backslashes inside the quoted name.
  return raw.replace(/\\(.)/g, '$1');
}

/**
 * Parse ffmpeg dshow list output into audio-input devices (pure).
 * `backend` tags every returned device. Duplicates are preserved in order
 * (the user picks by index); over-limit devices are dropped.
 */
export function parseDshowAudioDevices(output: string, backend: string): AudioDevice[] {
  const text = output.length > DSHOW_MAX_INPUT_CHARS ? output.slice(0, DSHOW_MAX_INPUT_CHARS) : output;
  const devices: AudioDevice[] = [];
  let pending: ParsedDshowDevice | undefined;
  const flush = (): void => {
    if (pending !== undefined) {
      if (pending.name.length > 0 && pending.name.length <= DSHOW_MAX_NAME_CHARS && devices.length < DSHOW_MAX_DEVICES) {
        const device: AudioDevice = { id: pending.name, label: pending.name, backend };
        if (pending.alternateName !== undefined && pending.alternateName !== '') {
          device.alternateName = pending.alternateName;
        }
        devices.push(device);
      }
      pending = undefined;
    }
  };
  for (const rawLine of text.split(/\r?\n/)) {
    // Strip the ffmpeg `[in#0 @ ...]` log prefix when present.
    const line = rawLine.replace(/^\[.+?\]\s*/, '').trim();
    if (line === '') continue;
    const audio = AUDIO_LINE_RE.exec(line);
    if (audio) {
      flush();
      pending = { name: unescapeDshowQuoted(audio[1] as string) };
      continue;
    }
    const alt = ALT_NAME_RE.exec(line);
    if (alt && pending !== undefined && pending.alternateName === undefined) {
      pending.alternateName = unescapeDshowQuoted(alt[1] as string);
      continue;
    }
    // Any other line (video entries, summary, errors) ends the pending device.
    if (line.indexOf('(none)') !== -1 || line.indexOf('(video)') !== -1) {
      flush();
      continue;
    }
  }
  flush();
  return devices;
}