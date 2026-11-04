/**
 * FRS-03: provider-neutral audio backend abstraction.
 *
 * One narrow discovery/setup layer between the CLI (orchestration) and
 * platform specifics (DirectShow/ALSA/AVFoundation). The CLI never parses
 * FFmpeg output and never synthesizes commands; each backend owns its
 * platform: detection, device listing, command generation, and transport
 * validation. Runtime consumption stays unchanged: generated commands flow
 * through existing voice settings into LocalAudioCapture/LocalAudioPlayback,
 * and normal ARTHUR startup performs NO discovery (explicit CLI only).
 */

export const AUDIO_SAMPLE_RATE_HZ = 16000;
export const AUDIO_CHANNELS = 1 as const;
export const AUDIO_SAMPLE_FORMAT = 's16le' as const;
export const AUDIO_FRAME_DURATION_MS = 20;

/** A discovered or configured audio device (label = untrusted local string). */
export interface AudioDevice {
  /** Stable selection identity: the dshow/backend device name. */
  id: string;
  /** Human label (same as id for dshow; backends may differ). */
  label: string;
  /** Backend that owns this device (e.g. 'ffmpeg-dshow'). */
  backend: string;
  /** Alternate backend name where present (dshow Alternative name). */
  alternateName?: string;
}

export interface AudioBackendInfo {
  /** Backend id, e.g. 'ffmpeg-dshow'. */
  id: string;
  /** 'windows' | 'linux' | 'darwin'. */
  platform: string;
  /** True when BOTH capture and playback executables resolved. */
  available: boolean;
  captureExecutable: string;
  playbackExecutable: string;
  captureAvailable: boolean;
  playbackAvailable: boolean;
  /** Safe version strings (bounded first-line banners) or ''. */
  captureVersion: string;
  playbackVersion: string;
}

export interface BuiltAudioCommands {
  captureCommand: string;
  playbackCommand: string;
}

export interface AudioBackend {
  /** Backend id. */
  id(): string;
  /** Detect executables (bounded, argv-spawn only, no shell). */
  detect(): Promise<AudioBackendInfo>; 
  /** Discovered input devices (audio only — never video). */
  listInputDevices(): Promise<AudioDevice[]>;
  /** Output capability (v1 Windows: single System-default entry). */
  listOutputDevices(): Promise<AudioDevice[]>;
  /** Synthesize runtime commands for a selected device (fail closed). */
  buildCommands(device: AudioDevice): BuiltAudioCommands;
}

/** Logical system-default output device (FRS-03 v1 output policy). */
export const SYSTEM_DEFAULT_OUTPUT_ID = 'default';

export function systemDefaultOutput(backend: string): AudioDevice {
  return { id: SYSTEM_DEFAULT_OUTPUT_ID, label: 'System default', backend };
}