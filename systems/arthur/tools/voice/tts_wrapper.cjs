'use strict';
/**
 * ARTHUR local TTS wrapper (Windows v1, zero dependencies).
 *
 * Bridges ARTHUR's stdin/stdout contract to piper (or any engine that
 * reads text on stdin and writes raw mono s16le PCM on stdout): ARTHUR
 * writes plain speech text to this process's stdin and reads raw PCM
 * from stdout, resampled to the ARTHUR internal sample rate.
 *
 * Configuration (env):
 *   PIPER_EXE                  piper executable (default "piper")
 *   PIPER_MODEL                .onnx voice model (fallback ARTHUR_TTS_MODEL_PATH)
 *   PIPER_VOICE_CONFIG         optional .onnx.json voice config
 *   PIPER_OUTPUT_RATE          native engine output rate (default 22050)
 *   ARTHUR_TTS_SAMPLE_RATE_HZ  target rate set by ARTHUR (default 16000)
 */
const { spawn } = require('node:child_process');

const exe = process.env.PIPER_EXE || 'piper';
const model = process.env.PIPER_MODEL || process.env.ARTHUR_TTS_MODEL_PATH;
const targetRate = Number(process.env.ARTHUR_TTS_SAMPLE_RATE_HZ) || 16000;
const nativeRate = Number(process.env.PIPER_OUTPUT_RATE) || 22050;

if (!model) {
  process.stderr.write('tts_wrapper: PIPER_MODEL (or ARTHUR_TTS_MODEL_PATH) is not set\n');
  process.exit(2);
}

/** Streaming linear-interpolation resampler (s16le mono, chunk-safe). */
class Resampler {
  constructor(fromRate, toRate) {
    this.from = fromRate;
    this.to = toRate;
    this.carry = Buffer.alloc(0);
  }
  push(chunk) {
    if (this.from === this.to) return chunk;
    this.carry = Buffer.concat([this.carry, chunk]);
    const inSamples = Math.floor(this.carry.length / 2);
    const outSamples = Math.floor((inSamples * this.to) / this.from);
    if (outSamples < 1) return Buffer.alloc(0);
    const out = Buffer.alloc(outSamples * 2);
    for (let i = 0; i < outSamples; i++) {
      const pos = (i * this.from) / this.to;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, inSamples - 1);
      const frac = pos - i0;
      const s0 = this.carry.readInt16LE(i0 * 2);
      const s1 = this.carry.readInt16LE(i1 * 2);
      out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
    }
    const lastPos = ((outSamples - 1) * this.from) / this.to;
    const consumed = Math.floor(lastPos) + 1;
    this.carry = this.carry.subarray(consumed * 2);
    return out;
  }
}

const resampler = new Resampler(nativeRate, targetRate);
const argv = [exe, '--model', model, '--output_raw'];
if (process.env.PIPER_VOICE_CONFIG) argv.push('--config', process.env.PIPER_VOICE_CONFIG);
const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
process.stdin.pipe(child.stdin);
child.stdout.on('data', (c) => {
  const out = resampler.push(c);
  if (out.length > 0) process.stdout.write(out);
});
child.stdout.on('end', () => {
  const tail = resampler.push(Buffer.alloc(0));
  if (tail.length > 0) process.stdout.write(tail);
  process.stdout.end();
});
child.stderr.pipe(process.stderr);
child.on('error', (e) => {
  process.stderr.write('tts_wrapper: cannot run ' + exe + ': ' + e.message + '\n');
  process.exit(2);
});
child.on('close', (code) => process.exit(code === null ? 1 : code));