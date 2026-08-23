'use strict';
/**
 * ARTHUR local STT wrapper (Windows v1, zero dependencies).
 *
 * Bridges ARTHUR's stdin/stdout contract to whisper.cpp's whisper-cli
 * (or any compatible engine): ARTHUR writes raw mono s16le PCM to this
 * process's stdin; the wrapper runs the engine and emits exactly one
 * JSON line on stdout: {"text":"...","language":"...","confidence":0.9}.
 *
 * Configuration (env):
 *   WHISPER_CLI                 whisper-cli executable or quoted command line
 *   WHISPER_MODEL               .bin model path (fallback ARTHUR_STT_MODEL_PATH)
 *   ARTHUR_STT_LANGUAGE         "auto" or a whisper language code
 *   WHISPER_EXTRA_ARGS          additional whisper-cli args (quoted)
 *
 * The wrapper never touches the network and never persists audio beyond a
 * temporary WAV file that is deleted before exit.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fail(msg) {
  process.stderr.write('stt_wrapper: ' + msg + '\n');
  process.exit(2);
}

function splitArgs(line) {
  const tokens = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') {
      q = true;
    } else if (ch === ' ' || ch === '\t') {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function wavHeader(sampleRate, dataBytes) {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

function extractWhisperText(out) {
  const parts = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes('-->')) continue;
    const m = /\]\s*(.+)$/.exec(line.trim());
    if (m && m[1]) parts.push(m[1].trim());
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const pcm = Buffer.concat(chunks);
  const cli = process.env.WHISPER_CLI || 'whisper-cli';
  const model = process.env.WHISPER_MODEL || process.env.ARTHUR_STT_MODEL_PATH;
  const lang = process.env.ARTHUR_STT_LANGUAGE || 'auto';
  if (!model) return fail('WHISPER_MODEL (or ARTHUR_STT_MODEL_PATH) is not set');
  const sampleRate = 16000; // ARTHUR internal rate
  const tmp = path.join(os.tmpdir(), 'arthur-stt-' + process.pid + '-' + Date.now() + '.wav');
 const argv = splitArgs(cli).concat(['-m', model, '-f', tmp, '-np']);

if (lang) {
  argv.push('-l', lang);
}
  if (process.env.WHISPER_EXTRA_ARGS) {
    argv.push.apply(argv, splitArgs(process.env.WHISPER_EXTRA_ARGS));
  }
  fs.writeFileSync(tmp, Buffer.concat([wavHeader(sampleRate, pcm.length), pcm]));
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  child.on('error', (e) => {
    try { fs.unlinkSync(tmp); } catch {}
    fail('cannot run ' + argv[0] + ': ' + e.message);
  });
  child.on('close', (code) => {
    try { fs.unlinkSync(tmp); } catch {}
    if (code !== 0) {
      process.stderr.write(err.slice(-4000));
      return fail('whisper-cli exited with code ' + code);
    }
    const text = extractWhisperText(out);
    if (text === undefined) return fail('no transcript found in whisper-cli output');
    const langOut = lang === 'auto' ? undefined : lang;
    process.stdout.write(JSON.stringify({ text: text.trim(), language: langOut, confidence: undefined }) + '\n');
    process.exit(0);
  });
});