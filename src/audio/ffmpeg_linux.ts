/**
 * FRS-03.1: Linux ffmpeg/ffplay audio backend (PipeWire/Pulse compat).
 *
 * Capture: FFmpeg pulse demuxer (`-f pulse -i <source-name>`) against
 * the Pulse-compatibility server (PipeWire's pulse/native socket on
 * modern desktops, native PulseAudio elsewhere). Discovery prefers the
 * structured JSON of `pactl -f json list sources` and falls back to
 * `pactl list short sources`; monitor loopbacks are excluded by the
 * parser. Output policy matches FRS-03 v1: ffplay targets the
 * system-default sink, so listOutputDevices() returns the single logical
 * System-default entry.
 *
 * All probes are argv-spawn (never shell), bounded in time and output.
 * detect() distinguishes ffmpeg-missing / ffplay-missing /
 * pulse-unsupported / discovery-unavailable / ready instead of
 * collapsing to "zero microphones".
 */

import { SYSTEM_DEFAULT_OUTPUT_ID, type AudioBackend, type AudioBackendInfo, type AudioDevice, type BuiltAudioCommands } from './backend';
import { buildLinuxAudioCommands } from './commands';
import { spawnProbe } from './ffmpeg_win';
import { parsePulseAudioSources, parsePulseShortSources } from './pulse';

export const FFMPEG_LINUX_BACKEND_ID = 'ffmpeg-pulse';
export const FFMPEG_VERSION_ARGS = ['-version'];
export const PACTL_JSON_SOURCES_ARGS = ['-f', 'json', 'list', 'sources'];
export const PACTL_SHORT_SOURCES_ARGS = ['list', 'short', 'sources'];
const LINUX_PROBE_TIMEOUT_MS = 15000;

export interface LinuxBackendDeps {
  platform?: NodeJS.Platform;
  pathOverride?: { ffmpeg?: string; ffplay?: string; pactl?: string };
  runFn?: (exe: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }>;
}

export interface LinuxCapabilityDetail {
  ffmpegPresent: boolean;
  ffplayPresent: boolean;
  pulseSupported: boolean;
  discoveryUsable: boolean;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/)[0] as string;
  return line.slice(0, 200);
}

export class LinuxFfmpegAudioBackend implements AudioBackend {
  private readonly deps: LinuxBackendDeps;

  constructor(deps: LinuxBackendDeps = {}) {
    this.deps = deps;
  }

  id(): string {
    return FFMPEG_LINUX_BACKEND_ID;
  }

  private ffmpegExe(): string {
    return this.deps.pathOverride?.ffmpeg ?? 'ffmpeg';
  }

  private ffplayExe(): string {
    return this.deps.pathOverride?.ffplay ?? 'ffplay';
  }

  private pactlExe(): string {
    return this.deps.pathOverride?.pactl ?? 'pactl';
  }

  private async run(exe: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> {
    if (this.deps.runFn) return this.deps.runFn(exe, args);
    return spawnProbe(exe, args, LINUX_PROBE_TIMEOUT_MS);
  }

  /** Structured capability behind detect(): tested independently of device listing. */
  async capability(): Promise<LinuxCapabilityDetail & { ffmpegVersion: string; ffplayVersion: string }> {
    const [cap, play, devices] = await Promise.all([
      this.run(this.ffmpegExe(), FFMPEG_VERSION_ARGS),
      this.run(this.ffplayExe(), FFMPEG_VERSION_ARGS),
      this.run(this.ffmpegExe(), ['-hide_banner', '-devices']),
    ]);
    const ffmpegPresent = cap.error === undefined && (cap.stdout !== '' || cap.stderr !== '');
    const ffplayPresent = play.error === undefined && (play.stdout !== '' || play.stderr !== '');
    const deviceText = (devices.stdout !== '' ? devices.stdout : devices.stderr);
    const pulseSupported = devices.error === undefined && /(^|\s)pulse(\s|$)/m.test(deviceText);
    let discoveryUsable = false;
    if (ffmpegPresent && pulseSupported) {
      const jsonProbe = await this.run(this.pactlExe(), PACTL_JSON_SOURCES_ARGS);
      if (jsonProbe.error === undefined && jsonProbe.stdout.trim() !== '') {
        discoveryUsable = true;
      } else {
        const shortProbe = await this.run(this.pactlExe(), PACTL_SHORT_SOURCES_ARGS);
        discoveryUsable = shortProbe.error === undefined && shortProbe.stdout.trim() !== '';
      }
    }
    return {
      ffmpegPresent,
      ffplayPresent,
      pulseSupported,
      discoveryUsable,
      ffmpegVersion: ffmpegPresent ? firstLine(cap.stdout !== '' ? cap.stdout : cap.stderr) : '',
      ffplayVersion: ffplayPresent ? firstLine(play.stdout !== '' ? play.stdout : play.stderr) : '',
    };
  }

  async detect(): Promise<AudioBackendInfo> {
    const detail = await this.capability();
    const captureAvailable = detail.ffmpegPresent && detail.pulseSupported && detail.discoveryUsable;
    const playbackAvailable = detail.ffplayPresent;
    return {
      id: FFMPEG_LINUX_BACKEND_ID,
      platform: this.deps.platform ?? process.platform,
      available: captureAvailable && playbackAvailable,
      captureExecutable: this.ffmpegExe(),
      playbackExecutable: this.ffplayExe(),
      captureAvailable,
      playbackAvailable,
      captureVersion: detail.ffmpegVersion,
      playbackVersion: detail.ffplayVersion,
    };
  }

  async listInputDevices(): Promise<AudioDevice[]> {
    const jsonProbe = await this.run(this.pactlExe(), PACTL_JSON_SOURCES_ARGS);
    if (jsonProbe.error === undefined && jsonProbe.stdout.trim() !== '') {
      const parsed = parsePulseAudioSources(jsonProbe.stdout, FFMPEG_LINUX_BACKEND_ID);
      // A successful pactl call that yields zero microphones is a real
      // empty result ONLY when at least one source entry existed (e.g.
      // monitor-only hardware). If JSON is structurally unusable, try
      // the short fallback before reporting empty.
      if (parsed.length > 0) return parsed;
      let shape: unknown = null;
      try {
        shape = JSON.parse(jsonProbe.stdout.length > 1024 * 1024 ? jsonProbe.stdout.slice(0, 1024 * 1024) : jsonProbe.stdout);
      } catch {
        shape = null;
      }
      if (Array.isArray(shape)) return parsed;
    }
    const shortProbe = await this.run(this.pactlExe(), PACTL_SHORT_SOURCES_ARGS);
    if (shortProbe.error !== undefined) return [];
    return parsePulseShortSources(shortProbe.stdout, FFMPEG_LINUX_BACKEND_ID);
  }

  async listOutputDevices(): Promise<AudioDevice[]> {
    // FRS-03 v1 output policy: ffplay targets the system-default sink.
    return [{ id: SYSTEM_DEFAULT_OUTPUT_ID, label: 'System default', backend: FFMPEG_LINUX_BACKEND_ID }];
  }

  buildCommands(device: AudioDevice): BuiltAudioCommands {
    if (device.backend !== FFMPEG_LINUX_BACKEND_ID) {
      throw new Error('device belongs to a different audio backend: ' + device.backend);
    }
    return buildLinuxAudioCommands(device, { ffmpeg: this.ffmpegExe(), ffplay: this.ffplayExe() });
  }
}
