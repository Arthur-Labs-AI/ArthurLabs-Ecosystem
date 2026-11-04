/**
 * FRS-03: Windows ffmpeg/ffplay audio backend (production quality).
 *
 * Capture: DirectShow (dshow). Executables detected independently via
 * argv-spawn (never shell interpolation, never assumed co-located):
 * `ffmpeg -version` / `ffplay -version` with bounded output. Device
 * discovery runs `ffmpeg -hide_banner -list_devices true -f dshow -i dummy`
 * with argv-spawn and parses EITHER stream structurally — FFmpeg commonly
 * exits non-zero for this LIST operation, so the exit code is NEVER the
 * discovery signal; parsed audio devices are.
 *
 * Output policy (FRS-03 v1): ffplay targets the system-default sink, so
 * listOutputDevices() returns the single logical System-default entry.
 */

import { spawn } from 'node:child_process';

import { SYSTEM_DEFAULT_OUTPUT_ID, type AudioBackend, type AudioBackendInfo, type AudioDevice, type BuiltAudioCommands } from './backend';
import { buildAudioCommands } from './commands';
import { parseDshowAudioDevices } from './dshow';

export const FFMPEG_WINDOWS_BACKEND_ID = 'ffmpeg-dshow';
export const FFMPEG_LIST_ARGS = ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];
export const FFMPEG_VERSION_ARGS = ['-version'];
const MAX_PROBE_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 15000;

export interface WindowsBackendDeps {
  platform?: NodeJS.Platform;
  pathOverride?: { ffmpeg?: string; ffplay?: string };
  spawnFn?: (exe: string, args: string[]) => { stdout: Buffer; stderr: Buffer; exitCode: number | null; error?: string };
  runFn?: (exe: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }>;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/)[0] as string;
  return line.slice(0, 200);
}

/** Async argv-spawn probe with bounded output and timeout (no shell). */
export function spawnProbe(exe: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ stdout: '', stderr: '', exitCode: null, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* kill best effort */ }
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), exitCode: null, error: 'probe timed out' });
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: '', exitCode: null, error: err instanceof Error ? err.message : String(err) });
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (outBytes < MAX_PROBE_BYTES) { out.push(chunk); outBytes += chunk.length; }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes < MAX_PROBE_BYTES) { err.push(chunk); errBytes += chunk.length; }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), exitCode: code });
    });
  });
}

export class WindowsFfmpegAudioBackend implements AudioBackend {
  private readonly deps: WindowsBackendDeps;

  constructor(deps: WindowsBackendDeps = {}) {
    this.deps = deps;
  }

  id(): string {
    return FFMPEG_WINDOWS_BACKEND_ID;
  }

  private ffmpegExe(): string {
    return this.deps.pathOverride?.ffmpeg ?? 'ffmpeg';
  }

  private ffplayExe(): string {
    return this.deps.pathOverride?.ffplay ?? 'ffplay';
  }

  private async run(exe: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> {
    if (this.deps.runFn) return this.deps.runFn(exe, args);
    return spawnProbe(exe, args, PROBE_TIMEOUT_MS);
  }

  async detect(): Promise<AudioBackendInfo> {
    const [cap, play] = await Promise.all([
      this.run(this.ffmpegExe(), FFMPEG_VERSION_ARGS),
      this.run(this.ffplayExe(), FFMPEG_VERSION_ARGS),
    ]);
    const captureAvailable = cap.error === undefined && (cap.stdout !== '' || cap.stderr !== '');
    const playbackAvailable = play.error === undefined && (play.stdout !== '' || play.stderr !== '');
    return {
      id: FFMPEG_WINDOWS_BACKEND_ID,
      platform: this.deps.platform ?? process.platform,
      available: captureAvailable && playbackAvailable,
      captureExecutable: this.ffmpegExe(),
      playbackExecutable: this.ffplayExe(),
      captureAvailable,
      playbackAvailable,
      captureVersion: captureAvailable ? firstLine(cap.stdout !== '' ? cap.stdout : cap.stderr) : '',
      playbackVersion: playbackAvailable ? firstLine(play.stdout !== '' ? play.stdout : play.stderr) : '',
    };
  }

  async listInputDevices(): Promise<AudioDevice[]> {
    const result = await this.run(this.ffmpegExe(), FFMPEG_LIST_ARGS);
    if (result.error !== undefined) return [];
    // Exit code is NOT the signal (FFmpeg exits non-zero for LIST).
    // Parse both streams structurally; audio entries are the signal.
    const combined = result.stdout + '\n' + result.stderr;
    return parseDshowAudioDevices(combined, FFMPEG_WINDOWS_BACKEND_ID);
  }

  async listOutputDevices(): Promise<AudioDevice[]> {
    // FRS-03 v1 output policy: ffplay targets the system-default sink.
    return [{ id: SYSTEM_DEFAULT_OUTPUT_ID, label: 'System default', backend: FFMPEG_WINDOWS_BACKEND_ID }];
  }

  buildCommands(device: AudioDevice): BuiltAudioCommands {
    if (device.backend !== FFMPEG_WINDOWS_BACKEND_ID) {
      throw new Error('device belongs to a different audio backend: ' + device.backend);
    }
    return buildAudioCommands(device, { ffmpeg: this.ffmpegExe(), ffplay: this.ffplayExe() });
  }
}

export function selectAudioBackend(deps: WindowsBackendDeps = {}): AudioBackend {
  return new WindowsFfmpegAudioBackend(deps);
}