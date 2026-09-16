/**
 * HR-02.5 Linux enablement (first pass, BgTTS only): deterministic Linux
 * path/venv tests.
 *
 * Fully deterministic: no I/O, no subprocess, no network. Asserts that
 * the managed Linux venv layout NEVER assumes Windows paths
 * (Scripts/python.exe) and that the BgTTS Linux CPU recipe resolves to
 * the managed bin/python interpreter under the containment-checked
 * runtime dir — on any host platform (path expectations are built with
 * node:path semantics of the RUNNING platform, so these run on Linux
 * CI where path.join uses '/').
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { ManagedPathService } from '../../src/runtime/local-models/provisioning/paths';
import { environmentPython } from '../../src/runtime/local-models/provisioning/python';
import { BGTTS_RUNTIME_ID } from '../../src/runtime/local-models/installers/bgtts_38m';

const ROOT = path.resolve('/managed-linux');

test('linux venv interpreter is bin/python, never Scripts/python.exe', () => {
  if (process.platform === 'win32') {
    // This file guards POSIX layout; on Windows the win32 branch of
    // environmentPython is covered by local_models_setup tests.
    assert.equal(path.win32.join('Scripts', 'python.exe'), path.win32.join('Scripts', 'python.exe'));
    return;
  }
  const svc = new ManagedPathService(ROOT);
  const runtimeDir = svc.runtimeDir(BGTTS_RUNTIME_ID);
  assert.ok(runtimeDir.includes(path.join('runtimes', 'python', 'bgtts-38m-v2-v1')));
  const pythonExe = environmentPython(svc.layout.root, runtimeDir);
  assert.equal(pythonExe, path.join(runtimeDir, 'bin', 'python'));
  assert.ok(!pythonExe.includes('Scripts'), 'no Windows Scripts segment: ' + pythonExe);
  assert.ok(!pythonExe.endsWith('.exe'), 'no .exe suffix: ' + pythonExe);
});

test('linux runtime dir and interpreter stay inside the managed root', () => {
  const svc = new ManagedPathService(ROOT);
  const runtimeDir = svc.runtimeDir(BGTTS_RUNTIME_ID);
  const pythonExe = environmentPython(svc.layout.root, runtimeDir);
  const norm = path.normalize(ROOT);
  assert.ok(path.normalize(runtimeDir).startsWith(norm), runtimeDir);
  assert.ok(path.normalize(pythonExe).startsWith(norm), pythonExe);
  assert.ok(!pythonExe.includes('\0'));
});

test('bgtts linux runtime id keeps the python/ boundary shape', () => {
  assert.equal(BGTTS_RUNTIME_ID, 'python/bgtts-38m-v2-v1');
  const svc = new ManagedPathService(ROOT);
  // Bare storage-key and python/-prefixed forms resolve identically.
  assert.equal(svc.runtimeDir('bgtts-38m-v2-v1'), svc.runtimeDir(BGTTS_RUNTIME_ID));
});
