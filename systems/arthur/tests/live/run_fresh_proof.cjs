// HR-02.5F fresh-root provider proof: E2 factory over CLI-created state.
// Usage: ARTHUR_FRESH_ROOT=... ARTHUR_FRESH_STATE=... node dist/tests/live/run_fresh_proof.cjs
const path = require('node:path');

let spawnCount = 0;
function patchSpawnCounter() {
  const cp = require('node:child_process');
  const orig = cp.spawn;
  cp.spawn = (...args) => {
    spawnCount += 1;
    const child = orig(...args);
    return child;
  };
}

function silenceFrames(n, seq0) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ sequence: seq0 + i, timestamp_ms: (seq0 + i) * 20, sample_rate_hz: 16000, channels: 1, sample_format: 's16le', duration_ms: 20, data: new Uint8Array(640) });
  }
  return out;
}
async function collect(it) { const out = []; for await (const e of it) out.push(e); return out; }
async function* replay(frames) { for (const f of frames) yield f; }

async function main() {
  patchSpawnCounter();
  const HW = JSON.parse(process.env.ARTHUR_LIVE_HW_JSON || 'null');
  const managedRoot = process.env.ARTHUR_FRESH_ROOT;
  const statePath = process.env.ARTHUR_FRESH_STATE;
  const { SystemHardwareProbe } = require('../../src/runtime/hardware/probe');
  const { LocalModelStateStore } = require('../../src/runtime/local-models/state_store');
  const { createLocalSttProvider, createLocalTtsProvider } = require('../../src/runtime/local-models/runtime/factory');
  const probed = await new SystemHardwareProbe().detect();
  const hardware = HW ? { ...probed, ...HW, memory: { ...probed.memory, ...(HW.memory || {}) }, cpu: { ...probed.cpu, ...(HW.cpu || {}) }, accelerators: { ...probed.accelerators, ...(HW.accelerators || {}) } } : probed;
  const store = LocalModelStateStore.load({ statePath });
  const state = store.snapshot();
  const live = [];
  const { EventEmitter } = require('node:events');
  const track = (child) => { live.push(child); child.on('exit', () => { const i = live.indexOf(child); if (i >= 0) live.splice(i, 1); }); child.on('close', () => { const i = live.indexOf(child); if (i >= 0) live.splice(i, 1); }); };
  const cp = require('node:child_process');
  const origSpawn = cp.spawn;
  // chain: keep counting, add liveness tracking
  cp.spawn = (...args) => { const child = origSpawn(...args); track(child); return child; };
  const stt = createLocalSttProvider({ hardware, state, managedRoot });
  console.log('stt provider: ' + stt.provider.id());
  const t0 = Date.now();
  const events = await collect(stt.provider.transcribeStream(replay(silenceFrames(50, 0)), { utteranceId: 'fresh-u1', maxTranscriptChars: 8000 }));
  console.log('stt: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's finals=' + events.filter((e) => e.type === 'final').length);
  await stt.provider.shutdown();
  const tts = createLocalTtsProvider({ hardware, state, managedRoot });
  console.log('tts provider: ' + tts.provider.id());
  const t1 = Date.now();
  const chunks = await collect(tts.provider.synthesizeStream({ synthesisId: 'fresh-s1', text: 'Здравей, това е кратка техническа проверка.', voice: 'v', sampleRateHz: 24000 }));
  const bytes = chunks.reduce((n, c) => n + (c.data ? c.data.length : 0), 0);
  console.log('tts: ' + ((Date.now() - t1) / 1000).toFixed(1) + 's chunks=' + chunks.length + ' bytes=' + bytes);
  await tts.provider.shutdown();
  console.log('spawns: ' + spawnCount + ' live children: ' + live.length);
  if (spawnCount !== 2 || live.length !== 0 || !chunks.length || !bytes) { console.error('FRESH PROOF FAILED'); process.exitCode = 1; }
  console.log('fresh proof done');
}
main().catch((e) => { console.error('PROOF ERROR: ' + (e && e.stack || e)); process.exitCode = 1; });
