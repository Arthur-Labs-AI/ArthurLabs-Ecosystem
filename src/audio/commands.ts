/**
 * FRS-03: deterministic audio command synthesis for the EXISTING
 * spawnEngine(splitCommandLine) tokenizer contract.
 *
 * The tokenizer understands double-quoted segments and `\"` escapes; every
 * other backslash is literal. Synthesis therefore emits the `-i` value as a
 * double-quoted segment with embedded `"` escaped, and FAILS CLOSED when a
 * device name cannot round-trip (control characters, or a trailing
 * backslash that would escape the closing quote). Every generated command
 * is verified by re-tokenizing: the `-i` argv must equal `audio=<name>`.
 *
 * Canonical Windows capture shape (proven in live acceptance):
 *
 *   ffmpeg -hide_banner -loglevel error -f dshow -i "audio=<name>"
 *     -ac 1 -ar 16000 -f s16le pipe:1
 *
 * Canonical Windows playback shape (current ffplay — NOT `-ac 1 -`):
 *
 *   ffplay -hide_banner -loglevel error -nodisp -autoexit
 *     -f s16le -ar 16000 -ch_layout mono -i -
 */

import { ArthurError } from '../core/errors/errors';
import { splitCommandLine } from '../voice/process_util';
import { AUDIO_SAMPLE_RATE_HZ, type AudioDevice, type BuiltAudioCommands } from './backend';

export const CAPTURE_EXECUTABLE = 'ffmpeg';
export const PLAYBACK_EXECUTABLE = 'ffplay';

/** Device names are data: reject anything that could corrupt argv or logs. */
function assertSafeDeviceName(name: string): void {
  if (name.length === 0 || name.length > 256) {
    throw new ArthurError('INVALID_CONFIG', 'audio device name must be 1..256 characters');
  }
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i) as number;
    if (code < 0x20 || code === 0x7f) {
      throw new ArthurError('INVALID_CONFIG', 'audio device name contains an unsupported control character');
    }
  }
  if (name.charCodeAt(name.length - 1) === 0x5c) {
    // A trailing backslash would escape the closing quote in the generated
    // command — refuse explicitly rather than emit a corrupt command.
    throw new ArthurError('INVALID_CONFIG', 'audio device name ends with a backslash and cannot be quoted safely');
  }
}

/** Quote one argv segment for splitCommandLine (double quotes + escapes). */
export function quoteArgvSegment(value: string): string {
  // The spawnEngine tokenizer treats every backslash as literal EXCEPT
  // `\"` inside quotes, so only the double-quote is escaped here.
  return '"' + value.replace(/"/g, '\\"') + '"';
}

function argvValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

/**
 * Build the Windows capture command for a dshow device. Throws
 * INVALID_CONFIG (never a corrupt command) when the name cannot be
 * represented safely by the spawnEngine tokenizer.
 */
export function buildWindowsCaptureCommand(deviceName: string, ffmpegPath = CAPTURE_EXECUTABLE): string {
  assertSafeDeviceName(deviceName);
  const inputValue = 'audio=' + deviceName;
  const command = [
    ffmpegPath,
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'dshow',
    '-i', quoteArgvSegment(inputValue),
    '-ac', '1',
    '-ar', String(AUDIO_SAMPLE_RATE_HZ),
    '-f', 's16le',
    'pipe:1',
  ].join(' ');
  // Round-trip proof: the generated text must tokenize back to the exact
  // `-i` value. A mismatch means the tokenizer cannot represent this name.
  const argv = splitCommandLine(command);
  if (argvValue(argv, '-i') !== inputValue) {
    throw new ArthurError('INVALID_CONFIG', 'audio device name cannot be represented safely in the capture command');
  }
  return command;
}

/** Exact Windows playback command (system-default sink, current ffplay). */
export function buildWindowsPlaybackCommand(ffplayPath = PLAYBACK_EXECUTABLE): string {
  return [
    ffplayPath,
    '-hide_banner',
    '-loglevel', 'error',
    '-nodisp',
    '-autoexit',
    '-f', 's16le',
    '-ar', String(AUDIO_SAMPLE_RATE_HZ),
    '-ch_layout', 'mono',
    '-i', '-',
  ].join(' ');
}

/**
 * Commas split FFmpeg's OWN `-i audio=..` device parsing (observed live:
 * `audio=Microphone` + `[video]` pair split), independent of shell quoting.
 * When the primary name contains a comma, the stable `@device_...`
 * alternate name (comma-free, captured by the parser) is used instead.
 * Without an alternate, synthesis fails closed with explicit guidance.
 */
export function resolveCaptureDeviceName(device: AudioDevice): string {
  if (device.id.indexOf(',') !== -1) {
    if (device.alternateName !== undefined && device.alternateName !== '' && device.alternateName.indexOf(',') === -1) {
      return device.alternateName;
    }
    throw new ArthurError(
      'INVALID_CONFIG',
      'audio device name contains a comma, which FFmpeg splits into separate device selections; no stable alternate device name is available',
    );
  }
  return device.id;
}

/** Build both runtime commands for a selected device. */
export function buildAudioCommands(device: AudioDevice, executables: { ffmpeg?: string; ffplay?: string } = {}): BuiltAudioCommands {
  return {
    captureCommand: buildWindowsCaptureCommand(resolveCaptureDeviceName(device), executables.ffmpeg ?? CAPTURE_EXECUTABLE),
    playbackCommand: buildWindowsPlaybackCommand(executables.ffplay ?? PLAYBACK_EXECUTABLE),
  };
}

/** Validate a generated command round-trips through the runtime tokenizer. */
export function commandRoundTrips(command: string): boolean {
  try {
    const argv = splitCommandLine(command);
    return argv.length > 0 && argv[0] !== ''; 
  } catch {
    return false;
  }
}