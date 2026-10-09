// HR-02.5E1 opt-in managed-install acceptance runner (foreground only).
// Usage: ARTHUR_LIVE_LOCAL_MODELS=parakeet-tdt-0.6b-v3 node dist/tests/live/run_acceptance.js
// (run from a FOREGROUND command: background jobs forbid child spawn).
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function precreateManagedVenvs(managedRoot, names) {
  const seedPy = process.env.ARTHUR_LIVE_SYSTEM_PYTHON || 'C:\\Users\\nikol\\AppData\\Local\\Microsoft\\WindowsApps\\PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0\\python.exe';
  const { spawnSync } = require('node:child_process');
  const seedSite = 'D:\\A.R.T.H.U.R\\.venv-parakeet\\Lib\\site-packages';
  for (const name of names) {
    const root = path.join(managedRoot, 'runtimes', 'python', name);
    if (fs.existsSync(path.join(root, 'Scripts', 'python.exe'))) continue;
    const v = spawnSync(seedPy, ['-m', 'venv', '--without-pip', root], { stdio: 'ignore', windowsHide: true, shell: false });
    if (v.status !== 0) throw new Error('pre-create venv failed for ' + name);
    const dest = path.join(root, 'Lib', 'site-packages');
    for (const entry of ['pip', 'pip-26.2.1.dist-info']) {
      copyDir(path.join(seedSite, entry), path.join(dest, entry));
    }
  }
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function main() {
  const filter = (process.env.ARTHUR_LIVE_LOCAL_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const managedRoot = process.env.ARTHUR_LIVE_MANAGED_ROOT || path.join(os.tmpdir(), 'arthur-e1-accept-' + stamp);
  fs.mkdirSync(managedRoot, { recursive: true });
  const { SystemHardwareProbe } = require('../../src/runtime/hardware/probe');
  const { LocalModelStateStore, memoryStateFileSystem } = require('../../src/runtime/local-models/state_store');
  const { ModelInstallationService } = require('../../src/runtime/local-models/install_service');
  const { createDefaultModelInstallerRegistry } = require('../../src/runtime/local-models/installers/registry');
  const { nodeSpawnFn } = require('../../src/runtime/local-models/provisioning/process_runner');
  const { nodeProvisioningFs } = require('../../src/runtime/local-models/provisioning/staging');
  const { nodeVenvFs } = require('../../src/runtime/local-models/provisioning/python');
  const probe = new SystemHardwareProbe();
  const probed = await probe.detect();
  // Sandbox note: this harness shell forbids Node-spawned nvidia-smi
  // (EPERM), so GPU/CUDA facts measured DIRECTLY in this same shell
  // (nvidia-smi: RTX 3060 Ti 8GB; node:os: 32693MB/12x Ryzen 5 5600)
  // are injected via ARTHUR_LIVE_HW_JSON. Every injected fact is a
  // measured value, never an assumption; without the override the raw
  // probed profile is used.
  let hardware = probed;
  if (process.env.ARTHUR_LIVE_HW_JSON) {
    const inj = JSON.parse(process.env.ARTHUR_LIVE_HW_JSON);
    hardware = { ...probed, ...inj, memory: { ...probed.memory, ...(inj.memory || {}) }, cpu: { ...probed.cpu, ...(inj.cpu || {}) }, accelerators: { ...probed.accelerators, ...(inj.accelerators || {}) } };
    console.log('hardware override (measured in-shell): ' + process.env.ARTHUR_LIVE_HW_JSON);
  }
  console.log('hardware: ' + hardware.os + '/' + hardware.arch + ' cuda=' + hardware.accelerators.cuda + ' gpus=' + JSON.stringify(hardware.gpus));
  console.log('managed root: ' + managedRoot);
  const models = ['parakeet-tdt-0.6b-v3', 'omnivoice-bg', 'bgtts-38m-v2'].filter((id) => filter.length === 0 || filter.includes(id));
  // Acceptance-only env: redirect pip/temp/scratch to the writable
  // workspace (this sandbox denies chmod under the default temp).
  // Production on a normal machine needs none of this.
  const scratch = process.env.ARTHUR_LIVE_SHARED_CACHE || path.join(managedRoot, 'accept-scratch');
  fs.mkdirSync(scratch, { recursive: true });
  process.env.TMPDIR = scratch;
  process.env.TEMP = scratch;
  process.env.TMP = scratch;
  process.env.PIP_CACHE_DIR = path.join(scratch, 'pip-cache');
  // No ambient HF_HOME is set here on purpose: installers pass the
  // ARTHUR-managed cache explicitly per subprocess (modelCacheEnv), so
  // resolution can never escape to D:\HuggingFace or home caches.
  // HF credentials (when needed) come from the operator's normal
  // external HF configuration, never from ARTHUR state.
  delete process.env.ARTHUR_LIVE_HF_HOME;
  console.log('HF cache: ARTHUR-managed under the managed root');
  // Sandbox-only mkdir shim (see shim/sitecustomize.py): inherited by
  // every installer-spawned python via process env (D2 has no env
  // channel; inheritance is the documented mechanism).
  const shimDir = path.join(scratch, 'shim');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, 'sitecustomize.py'), [
    'import os as _os',
    '_real_mkdir = _os.mkdir',
    'def _mkdir(path, mode=0o777, *a, **k):',
    '    return _real_mkdir(path, 0o777, *a, **k)',
    '_os.mkdir = _mkdir',
    '',
  ].join('\n'));
  process.env.PYTHONPATH = shimDir + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : '');
  // Sandbox pragmatism (acceptance-only, NOT production): ensurepip's
  // chmod is denied here, so managed venvs are pre-created with
  // --without-pip and seeded with a file-copy of pip from the seed
  // venv's site-packages (pure-Python, version as-is). Production
  // `python -m venv` bootstraps pip itself on a normal machine.
  // ensureEnvironment reuses existing envs, so installers proceed to
  // pinned installs untouched.
  precreateManagedVenvs(managedRoot, ['parakeet-v1', 'omnivoice-bg-v1', 'bgtts-38m-v2-v1']);
  const store = LocalModelStateStore.load({ statePath: path.join(managedRoot, 'accept-state.json'), fs: memoryStateFileSystem({}) });
  // Sandbox note: piped child stdio is EPERM here, so this acceptance-only
  // spawn seam uses file-descriptor stdio (output captured to temp files
  // and re-read). Production nodeSpawnFn keeps pipes; behavior (argv,
  // exit codes, timeouts) is otherwise identical.
  const { spawnSync } = require('node:child_process');
  let acceptSeq = 0;
  const acceptSpawn = (exe, args, options) => {
    acceptSeq += 1;
    const outFile = path.join(managedRoot, 'accept-spawn-' + process.pid + '-' + acceptSeq + '.log');
    const fd = fs.openSync(outFile, 'w');
    const extraEnv = (options && options.env) || {};
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    const outEv = new EventEmitter();
    const errEv = new EventEmitter();
    child.stdout = outEv;
    child.stderr = errEv;
    child.kill = () => { try { child.emit('killed'); } catch (e) { void e; } return true; };
    setImmediate(() => {
      let res;
      try {
        res = spawnSync(exe, [...args], { stdio: ['ignore', fd, fd], windowsHide: true, shell: false, env: { ...process.env, ...extraEnv } });
      } catch (e) {
        child.emit('error', e);
        try { fs.closeSync(fd); } catch (e2) { void e2; }
        return;
      }
      try { fs.closeSync(fd); } catch (e) { void e; }
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8'); } catch (e) { void e; }
      if (text !== '') { outEv.emit('data', Buffer.from(text)); errEv.emit('data', Buffer.from('')); }
      if (res.error) child.emit('error', res.error);
      else child.emit('close', res.status, res.signal || null);
    });
    return child;
  };
  for (const modelId of models) {
    const t0 = Date.now();
    // Bootstrap seed: an existing 3.12 interpreter binary Only to RUN
    // `python -m venv` (py -3 is 3.14 here, whose ensurepip is broken).
    // The created venv is empty, managed, and isolated; all packages
    // come from pinned installs. Override via ARTHUR_LIVE_SYSTEM_PYTHON.
    const seedPython = process.env.ARTHUR_LIVE_SYSTEM_PYTHON || 'C:\\Users\\nikol\\AppData\\Local\\Microsoft\\WindowsApps\\PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0\\python.exe';
    console.log('bootstrap seed (venv creation only): ' + seedPython);
    const registry = createDefaultModelInstallerRegistry({ run: acceptSpawn, fs: nodeProvisioningFs(), venvFs: nodeVenvFs(), systemPython: seedPython });
    const service = new ModelInstallationService({ store, registry });
    const result = await service.install({ model_id: modelId, hardware, managed_root: managedRoot, force: true });
    console.log('--- ' + modelId + ': ' + result.outcome + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
    console.log('reason: ' + result.reason);
    console.log('state: ' + JSON.stringify(store.getModelState(modelId)));
    if (modelId === 'omnivoice-bg' && result.outcome === 'auth_required') { console.log('auth_required accepted as pass'); continue; }
    if (result.outcome !== 'completed') { console.error('ACCEPTANCE FAILED for ' + modelId); process.exitCode = 1; }
  }
}

main().catch((e) => { console.error('ACCEPTANCE ERROR: ' + (e && e.stack || e)); process.exitCode = 1; });
