/**
 * FRS-03.1: canonical audio backend factory.
 *
 * One platform switch for every CLI surface (audio, unified setup,
 * doctor) so Linux can never silently receive the Windows DirectShow
 * backend again:
 *
 *   win32 -> WindowsFfmpegAudioBackend (DirectShow)
 *   linux -> LinuxFfmpegAudioBackend (Pulse/PipeWire compat)
 *   other -> UnsupportedAudioBackend (explicit typed failure)
 *
 * Injected test backends still override the factory: pass
 * `{ backend }` (audio CLI) or `{ audioBackend }` (setup) / `{ audio }`
 * (doctor) and the factory is never consulted.
 */

import { SYSTEM_DEFAULT_OUTPUT_ID, type AudioBackend, type AudioBackendInfo, type BuiltAudioCommands } from './backend';
import { WindowsFfmpegAudioBackend, type WindowsBackendDeps } from './ffmpeg_win';
import { LinuxFfmpegAudioBackend, type LinuxBackendDeps } from './ffmpeg_linux';

export const UNSUPPORTED_AUDIO_BACKEND_ID = 'unsupported';

export interface AudioBackendFactoryDeps {
  platform?: NodeJS.Platform;
  windows?: WindowsBackendDeps;
  linux?: LinuxBackendDeps;
}

export class UnsupportedAudioBackend implements AudioBackend {
  private readonly platform: string;

  constructor(platform: string) {
    this.platform = platform;
  }

  id(): string {
    return UNSUPPORTED_AUDIO_BACKEND_ID;
  }

  async detect(): Promise<AudioBackendInfo> {
    return {
      id: UNSUPPORTED_AUDIO_BACKEND_ID,
      platform: this.platform,
      available: false,
      captureExecutable: '',
      playbackExecutable: '',
      captureAvailable: false,
      playbackAvailable: false,
      captureVersion: '',
      playbackVersion: '',
    };
  }

  async listInputDevices(): Promise<never[]> {
    return [];
  }

  async listOutputDevices(): Promise<never[]> {
    return [];
  }

  buildCommands(): BuiltAudioCommands {
    throw new Error('audio is not supported on this platform: ' + this.platform);
  }
}

/** Canonical factory: exactly one platform switch for all CLI surfaces. */
export function createAudioBackendForPlatform(deps: AudioBackendFactoryDeps = {}): AudioBackend {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { platform: _ignored, ...rest } = deps.windows ?? {};
    void _ignored;
    return new WindowsFfmpegAudioBackend({ ...(Object.keys(rest).length > 0 ? { pathOverride: (rest as WindowsBackendDeps).pathOverride, runFn: (rest as WindowsBackendDeps).runFn, spawnFn: (rest as WindowsBackendDeps).spawnFn } : {}), platform });
  }
  if (platform === 'linux') {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { platform: _ignored, ...rest } = deps.linux ?? {};
    void _ignored;
    return new LinuxFfmpegAudioBackend({ ...(Object.keys(rest).length > 0 ? { pathOverride: (rest as LinuxBackendDeps).pathOverride, runFn: (rest as LinuxBackendDeps).runFn } : {}), platform });
  }
  return new UnsupportedAudioBackend(platform);
}

/** True for the explicit unsupported backend (capability failure, not zero devices). */
export function isUnsupportedAudioBackend(backend: AudioBackend): boolean {
  return backend.id() === UNSUPPORTED_AUDIO_BACKEND_ID;
}

export { SYSTEM_DEFAULT_OUTPUT_ID };
