/**
 * HR-02.5E2-C: managed local TTS providers (E1 runtimes, HR-02 interface).
 *
 * Persistent-worker adapters over the versioned JSONL TTS workers
 * (tools/voice/omnivoice_worker.py, tools/voice/bgtts_worker.py): one
 * bounded worker lifecycle per provider instance, request/response ID
 * correlation, startup/synthesis timeouts, crash detection, bounded
 * shutdown, stderr isolated from the JSON protocol. Worker wav output
 * lands in managed temp paths only (containment-checked); the provider
 * streams the file back as bounded `AudioChunk`s and deletes it.
 *
 * No shell, argv only. Reference conditioning uses the deterministic
 * ARTHUR sine fixture materialized into the managed work dir (never a
 * personal reference file). Implements `TtsProvider` — no new
 * application-facing abstraction.
 */

import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { AudioChunk, TtsProvider, TtsRequest } from '../../../voice/contracts';
import { shutdownChildGracefully } from '../../../voice/process_util';
import { VoiceProviderError } from '../../voice_errors';
import { smokeReferenceToneBytes, SMOKE_TONE_RATE_HZ } from '../installers/smoke_fixtures';
import type { LocalRuntimeTarget, RuntimeTargetKind } from './resolution';

export const MANAGED_TTS_STARTUP_TIMEOUT_MS = 300000;
export const MANAGED_TTS_SYNTH_TIMEOUT_MS = 180000;
export const MANAGED_TTS_MAX_TEXT_CHARS = 2000;
export const MANAGED_TTS_MAX_WAV_BYTES = 32 * 1024 * 1024;
export const MANAGED_TTS_CHUNK_MS = 100;

interface PendingSynth {
  resolve: (value: { audioPath: string; sampleRateHz: number; byteCount: number }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function failOf(code: string, message: string): VoiceProviderError {
  return new VoiceProviderError(code as 'provider_protocol_failure', message);
}

function writeWavHeader(pcmBytes: number, sampleRateHz: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBytes, 40);
  return header;
}

export interface ManagedTtsDeps {
  target: LocalRuntimeTarget;
  providerId: string;
  refEnvKey: 'OMNIVOICE_REF_WAV' | 'BGTTS_REF_WAV';
  startupTimeoutMs?: number;
  synthTimeoutMs?: number;
  writeFile?: (p: string, d: Uint8Array) => void;
  readFile?: (p: string) => Buffer;
  removeFile?: (p: string) => void;
}

export class ManagedLocalTtsProvider implements TtsProvider {
  private readonly target: LocalRuntimeTarget;
  private readonly providerId: string;
  private readonly refEnvKey: 'OMNIVOICE_REF_WAV' | 'BGTTS_REF_WAV';
  private readonly startupTimeoutMs: number;
  private readonly synthTimeoutMs: number;
  private readonly writeFile: (p: string, d: Uint8Array) => void;
  private readonly readFile: (p: string) => Buffer;
  private readonly removeFile: (p: string) => void;
  private child: ChildProcess | undefined;
  private starting: Promise<void> | undefined;
  private readonly pending = new Map<string, PendingSynth>();
  private readonly cancelled = new Set<string>();
  private exited = false;
  private requestSeq = 0;
  private refPath: string | undefined;
  private stderrTail = Buffer.alloc(0);
  private readonly maxStderrBytes = 8192;
  private lastExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(deps: ManagedTtsDeps) {
    this.target = deps.target;
    this.providerId = deps.providerId;
    this.refEnvKey = deps.refEnvKey;
    this.startupTimeoutMs = deps.startupTimeoutMs ?? MANAGED_TTS_STARTUP_TIMEOUT_MS;
    this.synthTimeoutMs = deps.synthTimeoutMs ?? MANAGED_TTS_SYNTH_TIMEOUT_MS;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    this.writeFile = deps.writeFile ?? ((p, d) => fs.writeFileSync(p, d));
    this.readFile = deps.readFile ?? ((p) => fs.readFileSync(p));
    this.removeFile = deps.removeFile ?? ((p) => { try { fs.rmSync(p, { force: true }); } catch { /* best effort */ } });
  }

  id(): string {
    return this.providerId;
  }

  get available(): boolean {
    if (this.exited) return false;
    return true;
  }

  get healthy(): boolean {
    return !this.exited;
  }

  describe(): LocalRuntimeTarget {
    return this.target;
  }

  private refWavPath(): string {
    if (!this.refPath) {
      const pcm = smokeReferenceToneBytes();
      const file = path.join(this.target.liveDir, 'smoke_ref.wav');
      this.writeFile(file, Buffer.concat([writeWavHeader(pcm.length, SMOKE_TONE_RATE_HZ), Buffer.from(pcm)]));
      this.refPath = file;
    }
    return this.refPath;
  }

  private ensureWorker(): Promise<void> {
    if (this.child && !this.exited) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.target.pythonExecutable, [this.target.entrypoint], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ...this.target.modelEnv,
            ...this.target.extraEnv,
            [this.refEnvKey]: this.refWavPath(),
          },
          windowsHide: true,
          shell: false,
        });
      } catch (err) {
        this.starting = undefined;
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const fail = (err: Error): void => {
        this.starting = undefined;
        reject(err);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* best effort */ }
        fail(failOf('provider_timeout', this.providerId + ': worker startup timed out'));
      }, this.startupTimeoutMs);
      child.on('error', () => {
        clearTimeout(timer);
        this.onWorkerExit();
        fail(failOf('local_worker_unavailable', this.providerId + ': worker failed to start'));
      });
      if (child.stdout) {
        const lines = createInterface({ input: child.stdout });
        lines.on('line', (line: string) => this.onWorkerLine(line));
      }
      child.stderr?.on('data', (chunk: Buffer) => {
        // Diagnostics only: bounded tail, never protocol, never audio.
        this.stderrTail = Buffer.concat([this.stderrTail, chunk]);
        if (this.stderrTail.length > this.maxStderrBytes) {
          this.stderrTail = this.stderrTail.subarray(this.stderrTail.length - this.maxStderrBytes);
        }
      });
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer);
        this.onWorkerExit(code, signal);
      });
      child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer);
        this.onWorkerExit(code, signal);
      });
      this.child = child;
      this.exited = false;
      // Workers print no ready banner; resolve once spawned. First
      // synthesis validates the stack (fail-closed on missing model).
      setImmediate(() => { clearTimeout(timer); this.starting = undefined; resolve(); });
    });
    return this.starting;
  }

  /** Bounded sanitized stderr tail for failure evidence (diagnostics only). */
  stderrEvidence(): string {
    return this.stderrTail.toString('utf8').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  }

  private exitEvidence(code: number | null, signal: NodeJS.Signals | null): string {
    const tail = this.stderrEvidence().slice(-500);
    return this.providerId + ': worker exited (code=' + String(code) + ' signal=' + String(signal) + ')' + (tail !== '' ? ' stderr: ' + tail : '');
  }

  private onWorkerExit(code: number | null = null, signal: NodeJS.Signals | null = null): void {
    this.exited = true;
    this.child = undefined;
    this.lastExit = { code, signal };
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(failOf('local_worker_crashed', this.exitEvidence(code, signal)));
    }
  }

  private onWorkerLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // non-JSON diagnostics noise: never stall a request.
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj['id'] !== 'string') return;
    const pending = this.pending.get(obj['id'] as string);
    if (!pending) return; // stale/unknown id: never misattribute.
    this.pending.delete(obj['id'] as string);
    clearTimeout(pending.timer);
    if (obj['ok'] === true) {
      if (typeof obj['audio_path'] !== 'string' || typeof obj['sample_rate_hz'] !== 'number' || typeof obj['bytes'] !== 'number') {
        pending.reject(failOf('provider_protocol_failure', this.providerId + ': malformed success envelope'));
        return;
      }
      pending.resolve({ audioPath: obj['audio_path'] as string, sampleRateHz: obj['sample_rate_hz'] as number, byteCount: obj['bytes'] as number });
      return;
    }
    pending.reject(failOf('transcription_failed', this.providerId + ': ' + String(obj['error'] ?? 'synth_failed')));
  }

  private synthAudio(text: string, synthesisId: string, outPath: string): Promise<{ audioPath: string; sampleRateHz: number; byteCount: number }> {
    const child = this.child;
    if (!child || this.exited || !child.stdin || child.stdin.destroyed) {
      return Promise.reject(failOf('local_worker_unavailable', this.providerId + ': worker unavailable'));
    }
    this.requestSeq += 1;
    const id = 'tts-' + String(this.requestSeq);
    // UTF-8 wire bytes: the workers read raw byte stdin and decode UTF-8
    // per line (host console encodings such as cp1252 must never touch
    // non-ASCII synthesis text). Node strings are UTF-16; Buffer
    // serializes exact UTF-8.
    const line = Buffer.from(JSON.stringify({ id, op: 'synthesize', text, output_path: outPath }) + '\n', 'utf8');
    if (line.length > 1024 * 1024) {
      return Promise.reject(failOf('transcription_failed', this.providerId + ': request exceeds bound'));
    }
    void synthesisId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(failOf('provider_timeout', this.providerId + ': synthesis timed out'));
      }, this.synthTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(line, (err) => {
        if (err) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            clearTimeout(pending.timer);
            reject(failOf('local_worker_crashed', this.providerId + ': worker write failed'));
          }
        }
      });
    });
  }

  private outputPath(synthesisId: string): string {
    // Managed temp wav: live dir + sanitized synthesis id (alnum only),
    // never caller-controlled paths.
    const safe = synthesisId.replace(/[^a-zA-Z0-9\-_]/g, '').slice(0, 64) || 'tts';
    return path.join(this.target.liveDir, 'tts-' + safe + '-' + String(Date.now()) + '.wav');
  }

  private *chunksFor(synthesisId: string, pcm: Buffer, sampleRateHz: number): Iterable<AudioChunk> {
    // 24kHz model PCM resampled trivially? No — workers emit the rate
    // they synthesize at; chunks carry it honestly. Downstream playback
    // handles the configured rate (controller contract).
    const bytesPerMs = (sampleRateHz * 2) / 1000;
    const chunkBytes = Math.max(1, Math.floor(bytesPerMs * MANAGED_TTS_CHUNK_MS));
    let sequence = 0;
    let offset = 0;
    let timestampMs = 0;
    while (offset < pcm.length) {
      const slice = pcm.subarray(offset, offset + chunkBytes);
      const durationMs = Math.max(1, Math.round(slice.length / bytesPerMs));
      const last = offset + chunkBytes >= pcm.length;
      yield {
        synthesisId,
        sequence,
        timestamp_ms: timestampMs,
        sample_rate_hz: sampleRateHz,
        channels: 1,
        sample_format: 's16le',
        duration_ms: durationMs,
        data: new Uint8Array(slice),
        ...(last ? { final: true as const } : {}),
      };
      offset += chunkBytes;
      sequence += 1;
      timestampMs += durationMs;
    }
  }

  async *synthesizeStream(request: TtsRequest): AsyncIterable<AudioChunk> {
    const synthesisId = request.synthesisId;
    if (this.cancelled.has(synthesisId)) return;
    if (typeof request.text !== 'string' || request.text === '' || request.text.length > MANAGED_TTS_MAX_TEXT_CHARS) {
      throw new Error('TTS synthesis failed: bounded text required');
    }
    try {
      await this.ensureWorker();
    } catch {
      throw new Error('TTS engine failed to start');
    }
    const outPath = this.outputPath(synthesisId);
    let result: { audioPath: string; sampleRateHz: number; byteCount: number };
    try {
      result = await this.synthAudio(request.text, synthesisId, outPath);
    } catch (err) {
      this.removeFile(outPath);
      throw new Error('TTS synthesis failed: ' + String(err instanceof Error ? err.message : err));
    }
    if (this.cancelled.has(synthesisId)) {
      this.removeFile(outPath);
      return;
    }
    let wav: Buffer;
    try {
      wav = this.readFile(outPath);
    } finally {
      this.removeFile(outPath);
    }
    if (wav.length > MANAGED_TTS_MAX_WAV_BYTES) {
      throw new Error('TTS synthesis failed: output exceeds bound');
    }
    const pcm = wav.length > 44 ? wav.subarray(44) : wav;
    yield* this.chunksFor(synthesisId, Buffer.from(pcm), result.sampleRateHz);
    this.cancelled.delete(synthesisId);
  }

  async cancel(synthesisId: string): Promise<void> {
    this.cancelled.add(synthesisId);
  }

  /**
   * Bounded shutdown: settle pending, close stdin for graceful worker
   * exit, await terminal close with kill escalation. Resolves only
   * after the child is reaped (or both bounds expire) — never orphans.
   */
  async shutdown(): Promise<void> {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(failOf('provider_cancelled', this.providerId + ': shutdown'));
    }
    const child = this.child;
    this.child = undefined;
    if (child) await shutdownChildGracefully(child);
    // Shut down means dead by definition: never report available after.
    this.exited = true;
  }
}

export function makeOmniVoiceTtsProvider(target: LocalRuntimeTarget, opts?: Omit<ManagedTtsDeps, 'target' | 'providerId' | 'refEnvKey'>): ManagedLocalTtsProvider {
  if (target.target !== 'tts-omnivoice') throw new Error('omnivoice provider needs a tts-omnivoice target');
  return new ManagedLocalTtsProvider({ target, providerId: 'omnivoice-tts', refEnvKey: 'OMNIVOICE_REF_WAV', ...opts });
}

export function makeBgTtsProvider(target: LocalRuntimeTarget, opts?: Omit<ManagedTtsDeps, 'target' | 'providerId' | 'refEnvKey'>): ManagedLocalTtsProvider {
  if (target.target !== 'tts-bgtts') throw new Error('bgtts provider needs a tts-bgtts target');
  return new ManagedLocalTtsProvider({ target, providerId: 'bgtts-tts', refEnvKey: 'BGTTS_REF_WAV', ...opts });
}
