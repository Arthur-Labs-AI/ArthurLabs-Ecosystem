/**
 * HR-02.5F8: real managed-model removal (artifacts + state, honestly).
 *
 * D1 deliberately has no lying uninstall: this service performs REAL
 * bounded artifact deletion, then updates D1 state only after the
 * filesystem outcome is known. Every destructive path is derived
 * through ManagedPathService and containment-checked; nothing from
 * persisted/user data ever becomes a delete path without validation.
 *
 * Removal scope per model (all inside the managed root):
 * - models/<key>/ (live + backups + staging residue for that model)
 * - runtimes/python/<name>/ ONLY when no other installed model
 *   references the same runtime dir (reference check over D1 state).
 * Shared hub/xet/assets caches are NEVER deleted (other models and
 * future installs need them; they are content-addressed and cheap to
 * keep). When reference accounting is ambiguous, the runtime is LEFT
 * BEHIND rather than deleted unsafely.
 *
 * State after success: installed=false, configured=false, ready=false,
 * validation cleared (removeModelState drops the entry); the explicit
 * manual selection is PRESERVED (selected-but-not-installed per the C
 * contract — never silently substituted). Partial filesystem failure
 * leaves state untouched and reports honestly.
 */

import { ArthurError } from '../../core/errors/errors';
import { getLocalModelCatalog } from './catalog';
import { ManagedPathService, toStorageKey } from './provisioning/paths';
import type { LocalModelStateFile } from './state_contracts';
import type { LocalModelStateStore } from './state_store';

export interface RemovalFs {
  removeRecursive(target: string): void;
  exists(target: string): boolean;
}

export function nodeRemovalFs(): RemovalFs {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  return {
    removeRecursive(target: string): void {
      fs.rmSync(target, { recursive: true, force: true });
    },
    exists(target: string): boolean {
      try {
        fs.accessSync(target);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export interface RemovalPlan {
  modelId: string;
  storageKey: string;
  modelDir: string;
  runtimeDir: string | null;
  runtimeRemoved: boolean;
  runtimeKeptReason: string | null;
}

export interface RemovalResult {
  modelId: string;
  outcome: 'removed' | 'failed' | 'not_installed';
  plan: RemovalPlan | null;
  reason: string;
}

export interface RemoveModelArgs {
  modelId: string;
  managedRoot: string;
  store: LocalModelStateStore;
  fs?: RemovalFs;
  catalog?: ReturnType<typeof getLocalModelCatalog>;
}

function fail(modelId: string, reason: string): RemovalResult {
  return { modelId, outcome: 'failed', plan: null, reason };
}

export async function removeManagedModel(args: RemoveModelArgs): Promise<RemovalResult> {
  const catalog = args.catalog ?? getLocalModelCatalog();
  const def = catalog.find((entry) => entry.id === args.modelId) ?? null;
  if (!def) {
    throw new ArthurError('INVALID_CONFIG', 'unknown model id ' + JSON.stringify(args.modelId) + ' (not in catalog)');
  }
  const fs = args.fs ?? nodeRemovalFs();
  const snapshot: LocalModelStateFile = args.store.snapshot();
  const entry = snapshot.models[args.modelId];
  if (!entry || !entry.installed) {
    return { modelId: args.modelId, outcome: 'not_installed', plan: null, reason: 'model ' + JSON.stringify(args.modelId) + ' is not installed' };
  }
  let storageKey = '';
  let modelDir = '';
  let runtimeDir = '';
  try {
    const paths = new ManagedPathService(args.managedRoot);
    storageKey = toStorageKey(args.modelId);
    modelDir = paths.modelDir(storageKey);
    const runtimeId = entry.runtime_id ?? null;
    runtimeDir = runtimeId === null ? '' : paths.runtimeDir(runtimeId);
  } catch (err) {
    return fail(args.modelId, 'invalid managed path for ' + JSON.stringify(args.modelId) + ': ' + String(err instanceof Error ? err.message : err));
  }
  // Runtime sharing: another INSTALLED model referencing the same
  // runtime dir keeps it alive. Missing/ambiguous references keep it.
  let runtimeRemoved = false;
  let runtimeKeptReason: string | null = null;
  let runtimeTarget: string | null = runtimeDir === '' ? null : runtimeDir;
  if (runtimeTarget !== null) {
    const sharedBy: string[] = [];
    for (const [id, other] of Object.entries(snapshot.models)) {
      if (id === args.modelId || !other.installed) continue;
      if (other.runtime_id === entry.runtime_id) sharedBy.push(id);
    }
    if (sharedBy.length > 0) {
      runtimeKeptReason = 'runtime still referenced by installed model(s): ' + sharedBy.join(', ');
      runtimeTarget = null;
    }
  } else {
    runtimeKeptReason = 'no runtime recorded for this install; nothing runtime-owned to delete';
  }
  // Filesystem first: model dir, then runtime (if owned). State updates
  // only after a fully successful deletion.
  try {
    if (fs.exists(modelDir)) fs.removeRecursive(modelDir);
    if (runtimeTarget !== null) {
      if (fs.exists(runtimeTarget)) fs.removeRecursive(runtimeTarget);
      runtimeRemoved = true;
    }
  } catch (err) {
    return fail(args.modelId, 'filesystem removal failed (state untouched): ' + String(err instanceof Error ? err.message : err));
  }
  try {
    await args.store.removeModelState(args.modelId);
  } catch (err) {
    return { modelId: args.modelId, outcome: 'failed', plan: { modelId: args.modelId, storageKey, modelDir, runtimeDir: runtimeTarget, runtimeRemoved, runtimeKeptReason }, reason: 'artifacts removed but state update failed: ' + String(err instanceof Error ? err.message : err) };
  }
  return {
    modelId: args.modelId,
    outcome: 'removed',
    plan: { modelId: args.modelId, storageKey, modelDir, runtimeDir: runtimeTarget, runtimeRemoved, runtimeKeptReason },
    reason: 'model ' + JSON.stringify(args.modelId) + ' removed (artifacts deleted, state cleared)' + (runtimeRemoved ? '' : '; runtime kept (' + String(runtimeKeptReason) + ')'),
  };
}
