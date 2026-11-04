/**
 * HR-02.5C: atomic file-backed local model state store.
 *
 * Crash-safe writes: serialize -> write temp file in the SAME directory
 * -> flush/close -> rename over the final path. A crash can leave a temp
 * file behind but never half-written final JSON. Parent directories are
 * created safely. Corrupted files raise typed errors and are never
 * auto-deleted or overwritten except by an explicit later mutation.
 *
 * All filesystem access flows through the injected FileSystem seam, so
 * tests never touch the developer's real state file. Same-process
 * mutations serialize through a promise chain (no lost updates);
 * cross-process locking is out of scope.
 *
 * Lifecycle invariants are enforced on every mutation:
 *   ready=true  => installed=true AND configured=true
 *   installed=false => configured=false AND ready=false
 *   validation failed => ready=false, last_validation.status=failed
 *
 * Boundary note: `restoreModelStateInternal` is an @internal rollback primitive
 * for the installation service's staging semantics. It is a method on
 * this class (no store redesign) but is NOT part of the public barrel
 * API surface and must not be used as a general mutation path.
 */

import * as path from 'node:path';

import { ArthurError } from '../../core/errors/errors';
import type { LocalModelKind } from './contracts';
import {
  defaultStateFile,
  parseStateFile,
  serializeStateFile,
  validateLifecycleSnapshot,
  type InstalledModelState,
  type LocalModelStateFile,
  type ValidationStatus,
} from './state_contracts';

export interface StateFileSystem {
  readText(path: string): string | null;
  writeTextAtomic(path: string, content: string): void;
  mkdirp(dir: string): void;
}

export function nodeStateFileSystem(): StateFileSystem {
  // Lazy requires keep this module importable in constrained contexts.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('node:crypto') as typeof import('node:crypto');
  return {
    readText(filePath: string): string | null {
      try {
        return fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (code === 'ENOENT') return null;
        throw new ArthurError('INVALID_CONFIG', 'cannot read local model state ' + filePath + ': ' + String(code ?? err));
      }
    },
    writeTextAtomic(filePath: string, content: string): void {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = filePath + '.tmp-' + String(process.pid) + '-' + crypto.randomBytes(8).toString('hex');
      fs.writeFileSync(tmp, content, { encoding: 'utf8' });
      fs.renameSync(tmp, filePath);
    },
    mkdirp(dir: string): void {
      fs.mkdirSync(dir, { recursive: true });
    },
  };
}

// Deterministic in-memory seam for tests: records atomic-write calls and
// can inject read failures or pre-existing file content.
export function memoryStateFileSystem(initial: Record<string, string> = {}): StateFileSystem & { files: Map<string, string>; atomicWrites: string[] } {
  const files = new Map<string, string>(Object.entries(initial));
  const atomicWrites: string[] = [];
  return {
    files,
    atomicWrites,
    readText(filePath: string): string | null {
      const hit = files.get(filePath);
      return hit === undefined ? null : hit;
    },
    writeTextAtomic(filePath: string, content: string): void {
      atomicWrites.push(filePath);
      files.set(filePath, content);
    },
    mkdirp(): void {},
  };
}

export interface StateStoreOptions {
  statePath: string;
  fs?: StateFileSystem;
}

function cloneState(state: LocalModelStateFile): LocalModelStateFile {
  return JSON.parse(JSON.stringify(state)) as LocalModelStateFile;
}

export class LocalModelStateStore {
  private readonly statePath: string;
  private readonly fs: StateFileSystem;
  private current: LocalModelStateFile;
  private chain: Promise<void> = Promise.resolve();

  private constructor(statePath: string, fs: StateFileSystem, initial: LocalModelStateFile) {
    this.statePath = statePath;
    this.fs = fs;
    this.current = initial;
  }

  static load(options: StateStoreOptions): LocalModelStateStore {
    const fs = options.fs ?? nodeStateFileSystem();
    const raw = fs.readText(options.statePath);
    if (raw === null) return new LocalModelStateStore(options.statePath, fs, defaultStateFile());
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (err) {
      throw new ArthurError('INVALID_CONFIG', 'invalid local model state ' + options.statePath + ': malformed JSON (' + String(err instanceof Error ? err.message : err) + ')');
    }
    return new LocalModelStateStore(options.statePath, fs, parseStateFile(decoded, options.statePath));
  }

  get path(): string {
    return this.statePath;
  }

  snapshot(): LocalModelStateFile {
    return cloneState(this.current);
  }

  // Persist through the atomic seam, then adopt as current. Queued so two
  // same-process mutations cannot interleave into a lost update.
  private mutate(fn: (draft: LocalModelStateFile) => void): Promise<LocalModelStateFile> {
    const run = this.chain.then(() => {
      const draft = cloneState(this.current);
      fn(draft);
      const payload = serializeStateFile(draft);
      this.fs.writeTextAtomic(this.statePath, payload);
      this.current = draft;
      return cloneState(this.current);
    });
    // Keep the chain alive across a rejection so later mutations still run.
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private lifecycle(modelId: string, draft: LocalModelStateFile): InstalledModelState {
    const existing = draft.models[modelId];
    if (existing) return existing;
    const created: InstalledModelState = { model_id: modelId, installed: false, configured: false, ready: false };
    draft.models[modelId] = created;
    return created;
  }

  getModelState(modelId: string): InstalledModelState | null {
    const hit = this.current.models[modelId];
    return hit ? (JSON.parse(JSON.stringify(hit)) as InstalledModelState) : null;
  }

  async markInstalled(modelId: string, installPath?: string, runtimeId?: string): Promise<LocalModelStateFile> {
    return this.mutate((draft) => {
      const entry = this.lifecycle(modelId, draft);
      entry.installed = true;
      if (installPath !== undefined) entry.install_path = installPath;
      if (runtimeId !== undefined) entry.runtime_id = runtimeId;
    });
  }

  async markConfigured(modelId: string): Promise<LocalModelStateFile> {
    return this.mutate((draft) => {
      const entry = this.lifecycle(modelId, draft);
      if (!entry.installed) {
        throw new ArthurError('INVALID_CONFIG', 'cannot mark configured: ' + JSON.stringify(modelId) + ' is not installed');
      }
      entry.configured = true;
    });
  }

  async markValidationPassed(modelId: string, timestamp?: string, reason?: string): Promise<LocalModelStateFile> {
    return this.mutate((draft) => {
      const entry = this.lifecycle(modelId, draft);
      if (!entry.installed || !entry.configured) {
        throw new ArthurError('INVALID_CONFIG', 'cannot mark ready: ' + JSON.stringify(modelId) + ' is not installed and configured');
      }
      entry.ready = true;
      const status: ValidationStatus = 'passed';
      entry.last_validation = { status };
      if (timestamp !== undefined) entry.last_validation.timestamp = timestamp;
      if (reason !== undefined) entry.last_validation.reason = reason;
    });
  }

  async markValidationFailed(modelId: string, timestamp?: string, reason?: string): Promise<LocalModelStateFile> {
    return this.mutate((draft) => {
      const entry = this.lifecycle(modelId, draft);
      entry.ready = false;
      const status: ValidationStatus = 'failed';
      entry.last_validation = { status };
      if (timestamp !== undefined) entry.last_validation.timestamp = timestamp;
      if (reason !== undefined) entry.last_validation.reason = reason;
    });
  }

  // Uninstall clears downstream state: configured=false, ready=false,
  // validation metadata dropped. The model key itself is removed so the
  // file never accumulates dead entries; selection restore is unaffected
  // (selections live in a separate section).
  async removeModelState(modelId: string): Promise<LocalModelStateFile> {
    return this.mutate((draft) => {
      delete draft.models[modelId];
    });
  }

  // INTERNAL rollback primitive for ModelInstallationService staging.
  // Restores the pre-attempt snapshot when a reinstall/replacement fails
  // before promotion. Not a general mutation API: it bypasses the
  // step-by-step lifecycle transitions by design (that IS the rollback),
  // so the snapshot is re-validated against the same lifecycle invariants
  // used by persisted-state parsing. Only the installation service uses
  // this in D1; it is intentionally absent from the public barrel API.
  async restoreModelStateInternal(modelId: string, snapshot: InstalledModelState | null): Promise<LocalModelStateFile> {
    const validated = snapshot === null ? null : validateLifecycleSnapshot(modelId, snapshot, this.statePath + ' (rollback)');
    return this.mutate((draft) => {
      if (validated === null) {
        delete draft.models[modelId];
        return;
      }
      draft.models[modelId] = JSON.parse(JSON.stringify(validated)) as InstalledModelState;
    });
  }

  async select(kind: LocalModelKind, modelId: string): Promise<LocalModelStateFile> {
    return this.mutate((draft) => {
      draft.selections[kind] = { mode: 'manual', model_id: modelId };
    });
  }

  async selectAuto(kind: LocalModelKind): Promise<LocalModelStateFile> {
    return this.mutate((draft) => {
      draft.selections[kind] = { mode: 'auto' };
    });
  }
}
