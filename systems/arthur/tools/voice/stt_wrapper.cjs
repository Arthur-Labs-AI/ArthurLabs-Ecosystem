'use strict';
/**
 * ARTHUR local STT wrapper (Windows v2, zero dependencies).
 *
 * Bridges ARTHUR's stdin/stdout contract to whisper.cpp's whisper-cli
 * (or any compatible engine): ARTHUR writes raw mono s16le PCM to this
 * process's stdin; the wrapper runs the engine and emits exactly one
 * JSON line on stdout: {"text":"...","language":"...","confidence":...}.
 *
 * STT Quality v2 (TASK-0008):
 * - Language profiles: ARTHUR_STT_LANGUAGE is forwarded verbatim as
 *   whisper-cli's "-l <language>" ("auto" enables whisper.cpp
 *   auto-detection, which the CLI accepts explicitly). Use an explicit
 *   code (e.g. "en"/"bg") whenever the expected language is known:
 *   auto-detection is unstable for short accented utterances.
 * - Domain initial prompt: ARTHUR_STT_INITIAL_PROMPT is passed as ONE
 *   argument through whisper-cli's "--prompt" flag. The wrapper spawns
 *   the engine with child_process.spawn (no shell), so the prompt is
 *   always data and can never become command syntax. Empty or
 *   whitespace-only values omit the flag entirely; values larger than
 *   MAX_PROMPT_CHARS fail closed; the prompt is never logged.
 * - Language observability: whisper.cpp suppresses its library logs
 *   under -np, including the "auto-detected language" line, so this
 *   wrapper no longer passes -np. In auto mode the detected language is
 *   parsed from the engine's stderr and reported in the JSON line; if
 *   the engine does not report it, "language" stays undefined (never
 *   fabricated). Explicit language profiles are echoed as configured.
 * - Honest confidence: whisper.cpp's stdout/stderr expose no
 *   utterance-level transcript probability (only per-token ANSI colors
 *   via --print-confidence, or per-token probabilities via the
 *   --output-json-full FILE output). Confidence is therefore left
 *   undefined; a language-detection probability is NOT a transcript
 *   confidence and is never substituted.
 *   TODO(STT-Quality-v3): derive a bounded confidence from
 *   --output-json-full per-segment probabilities (requires a JSON
 *   output file lifecycle), or from a quality scorer layered above
 *   this wrapper. A future primary/fallback language policy also
 *   belongs ABOVE this wrapper; the wrapper stays single-shot (no
 *   hidden retries).
 *
 * Configuration (env):
 *   WHISPER_CLI                 whisper-cli executable or quoted command line
 *   WHISPER_MODEL               .bin model path (fallback ARTHUR_STT_MODEL_PATH)
 *   ARTHUR_STT_LANGUAGE         "auto" (default) or a whisper language code
 *   ARTHUR_STT_INITIAL_PROMPT   optional domain vocabulary initial prompt
 *   WHISPER_EXTRA_ARGS          additional whisper-cli args (quoted)
 *
 * The wrapper never touches the network and never persists audio beyond a
 * temporary WAV file that is deleted before exit. Best effort only when the
 * process is force-killed (taskkill /F bypasses JS exit handlers).
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Hard bound for the initial prompt (documented wrapper contract). */
const MAX_PROMPT_CHARS = 2048;
/** Cap on retained engine stderr (diagnostics + language detection only). */
const MAX_STDERR_CHARS = 64 * 1024;

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

/**
 * Parse the language whisper.cpp auto-detected from its library log line
 * ("whisper_full_with_state: auto-detected language: en (p = 0.995679)";
 * older builds used "=" instead of ":"). Returns the last match with a
 * plausible language code and a probability in [0, 1], or undefined.
 * The probability is a LANGUAGE-detection probability, never a transcript
 * confidence, and is not surfaced in the JSON result.
 */
function extractDetectedLanguage(text) {
  const re = /auto-detected language\s*[:=]\s*([A-Za-z]{2,})\s*\(\s*p\s*=\s*([0-9]*\.?[0-9]+)\s*\)/g;
  let m;
  let last = undefined;
  while ((m = re.exec(text)) !== null) {
    last = { language: m[1].toLowerCase(), probability: Number(m[2]) };
  }
  if (!last) return undefined;
  if (!/^[a-z]{2,}$/.test(last.language)) return undefined;
  if (!Number.isFinite(last.probability) || last.probability < 0 || last.probability > 1) return undefined;
  return last;
}

/**
 * Assemble the engine argv (pure; exported for tests).
 *
 * Order: [cli tokens] -m <model> -f <wav> -l <language> [--prompt <p>] [extra]
 * - language "auto" (explicitly accepted by whisper-cli) or any code.
 * - prompt: omitted when empty/whitespace; throws when over the bound so
 *   misconfiguration fails closed instead of silently degrading quality.
 * - WHISPER_EXTRA_ARGS stay last so trusted startup config can override.
 * No shell is ever involved: every value stays a single argv element.
 */
function buildWhisperArgs({ cli, model, wavPath, language, prompt, extraArgs }) {
  const lang = language && language.trim() !== '' ? language.trim() : 'auto';
  if (typeof prompt === 'string' && prompt.length > MAX_PROMPT_CHARS) {
    throw new Error('initial prompt exceeds ' + MAX_PROMPT_CHARS + ' characters (got ' + prompt.length + '); shorten ARTHUR_STT_INITIAL_PROMPT');
  }
  const argv = splitArgs(cli).concat(['-m', model, '-f', wavPath, '-l', lang]);
  if (typeof prompt === 'string' && prompt.length > 0 && prompt.trim() !== '') {
    argv.push('--prompt', prompt);
  }
  if (extraArgs) {
    argv.push.apply(argv, splitArgs(extraArgs));
  }
  return argv;
}

function main() {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const pcm = Buffer.concat(chunks);
    const cli = process.env.WHISPER_CLI || 'whisper-cli';
    const model = process.env.WHISPER_MODEL || process.env.ARTHUR_STT_MODEL_PATH;
    const lang = process.env.ARTHUR_STT_LANGUAGE || 'auto';
    const prompt = process.env.ARTHUR_STT_INITIAL_PROMPT;
    if (!model) return fail('WHISPER_MODEL (or ARTHUR_STT_MODEL_PATH) is not set');
    const sampleRate = 16000; // ARTHUR internal rate
    const tmp = path.join(os.tmpdir(), 'arthur-stt-' + process.pid + '-' + Date.now() + '.wav');

    let argv;
    try {
      argv = buildWhisperArgs({
        cli,
        model,
        wavPath: tmp,
        language: lang,
        prompt,
        extraArgs: process.env.WHISPER_EXTRA_ARGS,
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    // Temp WAV lifecycle: deleted on success, engine failure, and spawn
    // failure; graceful signals are best effort. A forced tree-kill
    // (taskkill /F) bypasses JS handlers and can only leak into the OS
    // temp directory - never into the repo.
    let tmpAlive = true;
    const cleanupTmp = () => {
      if (!tmpAlive) return;
      tmpAlive = false;
      try { fs.unlinkSync(tmp); } catch {}
    };
    process.on('exit', cleanupTmp);
    for (const sig of ['SIGINT', 'SIGTERM']) {
      try {
        process.on(sig, () => {
          cleanupTmp();
          process.exit(2);
        });
      } catch {}
    }

    try {
      fs.writeFileSync(tmp, Buffer.concat([wavHeader(sampleRate, pcm.length), pcm]));
    } catch (err) {
      return fail('cannot write temporary WAV: ' + (err instanceof Error ? err.message : String(err)));
    }
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => {
      err += c;
      if (err.length > MAX_STDERR_CHARS) err = err.slice(-MAX_STDERR_CHARS / 2);
    });
    child.on('error', (e) => {
      cleanupTmp();
      fail('cannot run ' + argv[0] + ': ' + e.message);
    });
    child.on('close', (code) => {
      cleanupTmp();
      if (code !== 0) {
        process.stderr.write(err.slice(-4000));
        return fail('whisper-cli exited with code ' + code);
      }
      const text = extractWhisperText(out);
      if (text === undefined) return fail('no transcript found in whisper-cli output');
      let language;
      if (lang !== 'auto') {
        language = lang;
      } else {
        const detected = extractDetectedLanguage(err + '\n' + out);
        if (detected) language = detected.language;
      }
      // Honest contract: confidence stays undefined (see header); the
      // auto-detection probability is not a transcript confidence.
      const result = JSON.stringify({ text: text.trim(), language, confidence: undefined });
      process.stdout.write(result + '\n', () => process.exit(0));
    });
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  MAX_PROMPT_CHARS,
  buildWhisperArgs,
  extractDetectedLanguage,
  extractWhisperText,
  splitArgs,
  wavHeader,
};
