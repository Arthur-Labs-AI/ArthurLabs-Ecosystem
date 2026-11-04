/**
 * HR-02.5E1: deterministic non-personal smoke fixtures.
 *
 * - STT probe: 1 s of 16 kHz mono s16le silence (32000 zero bytes) as
 *   base64 — the same valid probe tools/voice/setup_parakeet.ps1 uses.
 *   Empty transcript is acceptable; only a structurally valid worker
 *   response (ok:true with the matching id) counts as success.
 * - TTS phrase: a short neutral Bulgarian sentence owned by ARTHUR
 *   (no personal/reference audio, no quality judgment — operational
 *   correctness only: non-empty PCM out proves the path works).
 * - TTS reference tone: a deterministic 1 s 220 Hz sine at 24 kHz used
 *   ONLY as zero-shot conditioning input for smoke synthesis. It is
 *   synthesized math, not a human voice, and never copied into the repo
 *   as audio — generated at smoke time, deleted afterwards.
 */

export const SMOKE_SAMPLE_RATE_HZ = 16000;
export const SMOKE_SILENCE_BYTES = 32000;
export const SMOKE_REQUEST_ID = 'e1-smoke-probe';

export function smokeSilenceB64(): string {
  return Buffer.alloc(SMOKE_SILENCE_BYTES).toString('base64');
}

export function smokeSttRequest(): string {
  return JSON.stringify({ id: SMOKE_REQUEST_ID, audio_b64: smokeSilenceB64(), sample_rate_hz: SMOKE_SAMPLE_RATE_HZ });
}

export const SMOKE_BG_PHRASE = 'Здравей, това е кратка техническа проверка.';
export const SMOKE_BG_PHRASE_EN = 'Hello, this is a short technical check.';

export const SMOKE_TONE_HZ = 220;
export const SMOKE_TONE_RATE_HZ = 24000;
export const SMOKE_TONE_SECONDS = 1;

// Deterministic 16-bit mono PCM sine (little-endian bytes).
export function smokeReferenceToneBytes(): Uint8Array {
  const samples = SMOKE_TONE_RATE_HZ * SMOKE_TONE_SECONDS;
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i += 1) {
    const v = Math.round(Math.sin((2 * Math.PI * SMOKE_TONE_HZ * i) / SMOKE_TONE_RATE_HZ) * 8000);
    view.setInt16(i * 2, v, true);
  }
  return out;
}

export function isValidSttSmokeResponse(line: string): boolean {
  try {
    const obj = JSON.parse(line) as { id?: unknown; ok?: unknown };
    return obj.id === SMOKE_REQUEST_ID && obj.ok === true;
  } catch {
    return false;
  }
}
