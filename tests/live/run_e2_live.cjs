// HR-02.5E2 opt-in RUNTIME acceptance with REAL pipes (NOT unit tests).
//
// RUN THIS FROM A NORMAL USER POWERSHELL SESSION (not the constrained
// agent sandbox, where piped child stdio returns EPERM):
//
//   $env:ARTHUR_LIVE_HW_JSON='{"gpus":[{"vendor":"nvidia","name":"NVIDIA GeForce RTX 3060 Ti","vram_mb":8192}],"memory":{"total_mb":32693},"cpu":{"logical_cores":12,"model":"AMD Ryzen 5 5600 6-Core Processor"},"accelerators":{"cuda":"available"}}'
//   node dist/tests/live/run_e2_live.cjs
//
// Optional: ARTHUR_LIVE_E2_MODELS=parakeet-tdt-0.6b-v3,bgtts-38m-v2
// (default), ARTHUR_LIVE_E2_PARAKEET_ROOT / _OMNI_ROOT / _BGTTS_ROOT
// (default E1-managed roots under .tmp/e1-accept). State snapshots are
// built in-memory (manual READY selections); nothing is installed or
// mutated. Two sequential requests per provider prove ONE persistent
// worker (spawn count == 1) with cold/warm latencies; providers shut
// down boundedly afterwards (no orphans: child PIDs reaped).
const path = require('node:path');
const fs = require('node:fs');

let spawnCount = 0;
const liveChildren = new Set();

function patchSpawnCounter() {
  // Observer only: counts real pipe spawns and tracks live children.
  // The ACTUAL transport stays node:child_process spawn with pipes.
  const cp = require('node:child_process');
  const orig = cp.spawn;
  cp.spawn = (...args) => {
    spawnCount += 1;
    const child = orig(...args);
    liveChildren.add(child);
    child.on('exit', () => liveChildren.delete(child));
    child.on('close', () => liveChildren.delete(child));
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
  const filter = (process.env.ARTHUR_LIVE_E2_MODELS || 'parakeet-tdt-0.6b-v3,bgtts-38m-v2').split(',').map((s) => s.trim()).filter(Boolean);
  const ROOTS = {
    'parakeet-tdt-0.6b-v3': process.env.ARTHUR_LIVE_E2_PARAKEET_ROOT || 'D:\\A.R.T.H.U.R\\.tmp\\e1-accept\\parakeet',
    'omnivoice-bg': process.env.ARTHUR_LIVE_E2_OMNI_ROOT || 'D:\\A.R.T.H.U.R\\.tmp\\e1-accept\\omni',
    'bgtts-38m-v2': process.env.ARTHUR_LIVE_E2_BGTTS_ROOT || 'D:\\A.R.T.H.U.R\\.tmp\\e1-accept\\bgtts2',
  };
  const { SystemHardwareProbe } = require('../../src/runtime/hardware/probe');
  const { defaultStateFile } = require('../../src/runtime/local-models/state_contracts');
  const { createLocalSttProvider, createLocalTtsProvider } = require('../../src/runtime/local-models/runtime/factory');
  const probed = await new SystemHardwareProbe().detect();
  const hardware = HW ? { ...probed, ...HW, memory: { ...probed.memory, ...(HW.memory || {}) }, cpu: { ...probed.cpu, ...(HW.cpu || {}) }, accelerators: { ...probed.accelerators, ...(HW.accelerators || {}) } } : probed;
  console.log('hardware: ' + hardware.os + '/' + hardware.arch + ' cuda=' + hardware.accelerators.cuda);
  const base = defaultStateFile();
  const mkState = (modelId, kind) => ({
    version: base.version,
    selections: { ...base.selections, [kind]: { mode: 'manual', model_id: modelId } },
    models: { [modelId]: { model_id: modelId, installed: true, configured: true, ready: true } },
  });
  for (const modelId of filter) {
    const kind = modelId === 'parakeet-tdt-0.6b-v3' ? 'stt' : 'tts';
    const managedRoot = ROOTS[modelId];
    const state = mkState(modelId, kind);
    const before = spawnCount;
    if (kind === 'stt') {
      const ref = createLocalSttProvider({ hardware, state, managedRoot });
      console.log('--- ' + modelId + ' provider: ' + ref.provider.id() + ' target: ' + ref.target.target);
      console.log('python: ' + ref.target.pythonExecutable);
      console.log('entrypoint: ' + ref.target.entrypoint);
      for (let round = 1; round <= 2; round += 1) {
        const t0 = Date.now();
        const events = await collect(ref.provider.transcribeStream(replay(silenceFrames(50, (round - 1) * 50)), { utteranceId: 'e2-u' + round, maxTranscriptChars: 8000 }));
        const finals = events.filter((e) => e.type === 'final');
        console.log('round ' + round + ': ' + ((Date.now() - t0) / 1000).toFixed(1) + 's finals=' + finals.length + ' text=' + JSON.stringify(finals.length ? finals[0].text : null));
        if (finals.length !== 1) { console.error('STT ACCEPTANCE FAILED for ' + modelId); process.exitCode = 1; }
      }
      await ref.provider.shutdown();
    } else {
      const ref = createLocalTtsProvider({ hardware, state, managedRoot });
      console.log('--- ' + modelId + ' provider: ' + ref.provider.id() + ' target: ' + ref.target.target);
      console.log('python: ' + ref.target.pythonExecutable);
      console.log('entrypoint: ' + ref.target.entrypoint);
      const text = 'Здравей, това е кратка техническа проверка.';
      for (let round = 1; round <= 2; round += 1) {
        const t0 = Date.now();
        const chunks = await collect(ref.provider.synthesizeStream({ synthesisId: 'e2-s' + round, text, voice: 'v', sampleRateHz: 24000 }));
        const bytes = chunks.reduce((n, c) => n + (c.data ? c.data.length : 0), 0);
        console.log('round ' + round + ': ' + ((Date.now() - t0) / 1000).toFixed(1) + 's chunks=' + chunks.length + ' bytes=' + bytes);
        if (!chunks.length || !bytes) { console.error('TTS ACCEPTANCE FAILED for ' + modelId); process.exitCode = 1; }
      }
      await ref.provider.shutdown();
    }
    const used = spawnCount - before;
    console.log('spawns for ' + modelId + ': ' + used + ' (expect 1: one persistent worker)');
    if (used !== 1) { console.error('REUSE CHECK FAILED for ' + modelId); process.exitCode = 1; }
    console.log('live children after shutdown: ' + liveChildren.size + ' (expect 0: no orphans)');
    if (liveChildren.size !== 0) { console.error('ORPHAN CHECK FAILED for ' + modelId); process.exitCode = 1; }
  }
  console.log('E2 live acceptance done');
}

main().catch((e) => { console.error('ACCEPTANCE ERROR: ' + (e && e.stack || e)); process.exitCode = 1; });
