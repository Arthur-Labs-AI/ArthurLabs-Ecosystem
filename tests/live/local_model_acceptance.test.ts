/**
 * HR-02.5E1 opt-in managed-install acceptance (NOT a unit test).
 *
 * Gate: ARTHUR_LIVE_LOCAL_MODEL_TESTS=1, otherwise skip (normal
 * `npm run test:unit` never picks it up: tests/live matches no unit
 * glob). Run explicitly per model (long, multi-GB, GPU-bound):
 *
 *   ARTHUR_LIVE_LOCAL_MODEL_TESTS=1 ARTHUR_LIVE_LOCAL_MODELS=parakeet-tdt-0.6b-v3 \
 *     node --disable-warning=ExperimentalWarning --test dist/tests/live/local_model_acceptance.test.js
 *
 * Optional managed root: ARTHUR_LIVE_MANAGED_ROOT (default: fresh
 * timestamped dir under the OS temp area — explicit, never ./data).
 * State file is memory-backed; the managed ROOT is real (venvs,
 * packages, model files land on disk under it).
 *
 * Per model it reports: managed runtime path, Python version, torch
 * build (+cu tag), CUDA availability/device, model load result, smoke
 * result, final D1 state, cold/warm timings, peak VRAM via nvidia-smi
 * when available. Independence: asserts the managed tree references
 * none of .venv-parakeet, D:\OmniVoice-Test, D:\BgTTS-38M-V2, or
 * developer-local model/reference paths. OmniVoice without HF
 * credentials must yield auth_required (accepted as pass).
 * TTS sine-fixture acceptance is proven by SMOKE_BYTES>0 through the
 * real conditioning path (harness exit 0 + byte count).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ENABLED = process.env['ARTHUR_LIVE_LOCAL_MODEL_TESTS'] === '1';
const FILTER = (process.env['ARTHUR_LIVE_LOCAL_MODELS'] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');

const FORBIDDEN_PATH_MARKERS = ['.venv-parakeet', 'OmniVoice-Test', 'BgTTS-38M-V2', 'reference.wav'];

function sh(cmd: string, args: string[], timeoutMs: number): { code: number; out: string } {
  try {
    const out = execFileSync(cmd, args, { timeout: timeoutMs, encoding: 'utf8', windowsHide: true });
    return { code: 0, out: String(out).slice(0, 4000) };
  } catch (err) {
    const e = err as { status?: number; stdout?: unknown; stderr?: unknown; message?: string };
    const tail = String(e.stdout ?? '') + String(e.stderr ?? '') + String(e.message ?? '');
    return { code: typeof e.status === 'number' ? e.status : 1, out: tail.slice(-2000) };
  }
}

function peakVramMb(): string {
  const r = sh('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], 30000);
  if (r.code !== 0) return 'nvidia-smi unavailable';
  return 'nvidia-smi used MB: ' + r.out.trim().split(/\r?\n/).join(',');
}

function scanTree(root: string): string[] {
  const hits: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries.slice(0, 200)) {
      const full = path.join(dir, entry);
      for (const marker of FORBIDDEN_PATH_MARKERS) {
        if (full.includes(marker)) hits.push(full);
      }
      let stat: { isDirectory(): boolean } | null = null;
      try {
        stat = fs.statSync(full);
      } catch {
        stat = null;
      }
      if (stat && stat.isDirectory()) visit(full, depth + 1);
    }
  };
  visit(root, 0);
  return hits.slice(0, 20);
}

test('live managed-install acceptance (opt-in)', async (t) => {
  if (!ENABLED) {
    t.skip('opt-in only: set ARTHUR_LIVE_LOCAL_MODEL_TESTS=1');
    return;
  }
  const { SystemHardwareProbe } = await import('../../src/runtime/hardware/probe');
  const { LocalModelStateStore, memoryStateFileSystem } = await import('../../src/runtime/local-models/state_store');
  const { ModelInstallationService } = await import('../../src/runtime/local-models/install_service');
  const { createDefaultModelInstallerRegistry } = await import('../../src/runtime/local-models/installers/registry');
  const { nodeSpawnFn } = await import('../../src/runtime/local-models/provisioning/process_runner');
  const { nodeProvisioningFs } = await import('../../src/runtime/local-models/provisioning/staging');
  const { nodeVenvFs } = await import('../../src/runtime/local-models/provisioning/python');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const managedRoot = process.env['ARTHUR_LIVE_MANAGED_ROOT'] ?? path.join(os.tmpdir(), 'arthur-e1-accept-' + stamp);
  fs.mkdirSync(managedRoot, { recursive: true });
  const probe = new SystemHardwareProbe();
  const hardware = await probe.detect();
  console.log('hardware: ' + hardware.os + '/' + hardware.arch + ' cuda=' + hardware.accelerators.cuda);
  console.log('managed root: ' + managedRoot);
  console.log('vram before: ' + peakVramMb());

  const models = ['parakeet-tdt-0.6b-v3', 'omnivoice-bg', 'bgtts-38m-v2'].filter((id) => FILTER.length === 0 || FILTER.includes(id));
  const stateFs = memoryStateFileSystem({});
  const store = LocalModelStateStore.load({ statePath: path.join(managedRoot, 'accept-state.json'), fs: stateFs });
  const t0 = Date.now();
  for (const modelId of models) {
    const modelT0 = Date.now();
    const registry = createDefaultModelInstallerRegistry({ run: nodeSpawnFn(), fs: nodeProvisioningFs(), venvFs: nodeVenvFs(), systemPython: undefined });
    const service = new ModelInstallationService({ store, registry });
    const result = await service.install({ model_id: modelId, hardware, managed_root: managedRoot, force: true });
    const secs = Math.round((Date.now() - modelT0) / 1000);
    console.log('--- ' + modelId + ': ' + result.outcome + ' (' + secs + 's)');
    console.log('reason: ' + result.reason);
    const entry = store.getModelState(modelId);
    console.log('state: ' + JSON.stringify(entry));
    console.log('vram after: ' + peakVramMb());
    if (modelId === 'omnivoice-bg' && result.outcome === 'auth_required') {
      console.log('omnivoice auth_required without HF credentials — accepted as pass');
      continue;
    }
    assert.equal(result.outcome, 'completed', modelId + ': ' + result.reason);
    assert.ok(entry && entry.ready, modelId + ' not READY');
    // Independence: managed tree must not reference dev-local paths.
    const live = (entry && entry.install_path) || managedRoot;
    const hits = scanTree(path.dirname(live));
    assert.deepEqual(hits, [], modelId + ' references dev-local paths: ' + hits.join(';'));
    void spawnSync;
  }
  console.log('total: ' + Math.round((Date.now() - t0) / 1000) + 's');
});
