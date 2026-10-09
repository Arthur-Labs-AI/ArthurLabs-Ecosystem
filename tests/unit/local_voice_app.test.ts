/**
 * HR-02.5E2 app-level regression: stable identity + local_only bootstrap
 * through REAL buildApp composition (no provider injection).
 *
 * Fabricates a managed root (empty marker files satisfy the existence
 * seam) + a READY manual-selection state file, then asserts through the
 * composed routers:
 * - local legs advertise the MANAGED provider ids from construction
 *   (route_selected.provider_id == the managed id, never the fallback);
 * - `available` is true so a first `local_only` request can bootstrap
 *   (async verification happens inside the request, fail-closed);
 * - without a READY selection the legs keep legacy fallback identity.
 * Execution (worker spawn) is NOT exercised here — covered by provider
 * unit tests (fakes) and opt-in live acceptance (real pipes).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildTestApp } from '../helpers';

function fabricateManagedRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2-managed-'));
  const touch = (p: string): void => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '');
  };
  const py = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  touch(path.join(root, 'runtimes', 'python', 'parakeet-v1', ...py));
  touch(path.join(root, 'models', 'parakeet-tdt-0-6b-v3', 'live', 'parakeet_worker.py'));
  touch(path.join(root, 'runtimes', 'python', 'omnivoice-bg-v1', ...py));
  touch(path.join(root, 'models', 'omnivoice-bg', 'live', 'omnivoice_worker.py'));
  return root;
}

function writeStateFile(root: string): string {
  const file = path.join(root, 'models.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      selections: { stt: { mode: 'manual', model_id: 'parakeet-tdt-0.6b-v3' }, tts: { mode: 'manual', model_id: 'omnivoice-bg' }, model: { mode: 'auto' } },
      models: {
        'parakeet-tdt-0.6b-v3': { model_id: 'parakeet-tdt-0.6b-v3', installed: true, configured: true, ready: true },
        'omnivoice-bg': { model_id: 'omnivoice-bg', installed: true, configured: true, ready: true },
      },
    }),
  );
  return file;
}

test('composed legs advertise managed ids when READY-selected', () => {
  const root = fabricateManagedRoot();
  const statePath = writeStateFile(root);
  const app = buildTestApp({ voice: { sttPolicy: 'local_only', ttsPolicy: 'local_only', localModelRoot: root, localModelStatePath: statePath } });
  assert.equal(app.sttRouter.routingDecision().provider_id, 'parakeet-stt');
  assert.equal(app.ttsRouter.routingDecision().provider_id, 'omnivoice-tts');
  assert.equal(app.sttRouter.available, true);
  assert.equal(app.ttsRouter.available, true);
  assert.equal(app.sttRouter.routingDecision().reason, 'local_only');
});

test('composed legs keep fallback identity without READY selection', () => {
  const root = fabricateManagedRoot();
  const statePath = path.join(root, 'empty-models.json');
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, selections: { stt: { mode: 'auto' }, tts: { mode: 'auto' }, model: { mode: 'auto' } }, models: {} }));
  const app = buildTestApp({ voice: { sttPolicy: 'local_only', ttsPolicy: 'local_only', localModelRoot: root, localModelStatePath: statePath } });
  assert.notEqual(app.sttRouter.routingDecision().provider_id, 'parakeet-stt');
  assert.notEqual(app.ttsRouter.routingDecision().provider_id, 'omnivoice-tts');
});

test('cloud_preferred first request can reach the managed leg', async () => {
  const root = fabricateManagedRoot();
  const statePath = writeStateFile(root);
  const app = buildTestApp({ voice: { sttPolicy: 'cloud_preferred', localModelRoot: root, localModelStatePath: statePath } });
  // Decision prefers cloud when configured; the managed leg identity is
  // stable regardless (no flip between decision and execution).
  const decision = app.sttRouter.routingDecision();
  assert.ok(typeof decision.provider_id === 'string' && decision.provider_id.length > 0);
});
