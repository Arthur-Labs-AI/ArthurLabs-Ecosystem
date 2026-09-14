/**
 * HR-02.5C: persistent local model state contracts (schema v1).
 *
 * Persisted: machine-local lifecycle facts (installed/configured/ready,
 * install metadata, last validation) and user selection mode per kind.
 * NEVER persisted: compatibility (derived from HR-02.5B on every query),
 * recommendation output (recomputed), secrets/tokens/keys, commands.
 *
 * The schema is closed: unknown lifecycle fields are rejected so a
 * secrets-bearing or future-shape file cannot slip through silently.
 */

import { ArthurError } from '../../core/errors/errors';
import { isLocalModelKind, type LocalModelKind } from './contracts';
import { LOCAL_MODEL_KINDS } from './contracts';

export const LOCAL_MODEL_STATE_VERSION = 1;

export const DEFAULT_LOCAL_MODEL_STATE_PATH = './data/runtime/models.json';

export type SelectionMode = 'auto' | 'manual';

export type SelectionSource = 'override' | 'manual' | 'recommended' | 'none';

export type ValidationStatus = 'passed' | 'failed' | 'unknown';

export interface ModelKindSelection {
  mode: SelectionMode;
  model_id?: string;
}

export interface ModelValidationRecord {
  status: ValidationStatus;
  timestamp?: string;
  reason?: string;
}

export interface InstalledModelState {
  model_id: string;
  installed: boolean;
  configured: boolean;
  ready: boolean;
  install_path?: string;
  runtime_id?: string;
  last_validation?: ModelValidationRecord;
}

export interface LocalModelStateFile {
  version: number;
  selections: Record<LocalModelKind, ModelKindSelection>;
  models: Record<string, InstalledModelState>;
}

export const SELECTION_MODES = ['auto', 'manual'] as const;
export const SELECTION_SOURCES = ['override', 'manual', 'recommended', 'none'] as const;
export const VALIDATION_STATUSES = ['passed', 'failed', 'unknown'] as const;

export function isSelectionMode(value: unknown): value is SelectionMode {
  return value === 'auto' || value === 'manual';
}

export function isSelectionSource(value: unknown): value is SelectionSource {
  return typeof value === 'string' && (SELECTION_SOURCES as readonly string[]).includes(value);
}

export function isValidationStatus(value: unknown): value is ValidationStatus {
  return typeof value === 'string' && (VALIDATION_STATUSES as readonly string[]).includes(value);
}

export function defaultSelections(): Record<LocalModelKind, ModelKindSelection> {
  return {
    stt: { mode: 'auto' },
    tts: { mode: 'auto' },
    model: { mode: 'auto' },
  };
}

export function defaultStateFile(): LocalModelStateFile {
  return { version: LOCAL_MODEL_STATE_VERSION, selections: defaultSelections(), models: {} };
}

function cfg(message: string, path: string): ArthurError {
  return new ArthurError('INVALID_CONFIG', 'invalid local model state ' + path + ': ' + message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkLifecycle(modelId: string, state: InstalledModelState, path: string): void {
  if (state.ready && (!state.installed || !state.configured)) {
    throw cfg('ready=true requires installed=true and configured=true for ' + JSON.stringify(modelId), path);
  }
  if (!state.installed && (state.configured || state.ready)) {
    throw cfg('installed=false requires configured=false and ready=false for ' + JSON.stringify(modelId), path);
  }
}

const KNOWN_LIFECYCLE_KEYS = ['model_id', 'installed', 'configured', 'ready', 'install_path', 'runtime_id', 'last_validation'];

function parseLifecycle(modelId: string, raw: unknown, path: string): InstalledModelState {
  if (!isRecord(raw)) throw cfg('lifecycle entry must be an object for ' + JSON.stringify(modelId), path);
  for (const key of Object.keys(raw)) {
    if (!KNOWN_LIFECYCLE_KEYS.includes(key)) throw cfg('unknown lifecycle field ' + JSON.stringify(key) + ' for ' + JSON.stringify(modelId), path);
  }
  const installed = raw.installed;
  const configured = raw.configured;
  const ready = raw.ready;
  if (typeof installed !== 'boolean' || typeof configured !== 'boolean' || typeof ready !== 'boolean') {
    throw cfg('installed/configured/ready must be booleans for ' + JSON.stringify(modelId), path);
  }
  const out: InstalledModelState = { model_id: modelId, installed, configured, ready };
  if (raw.install_path !== undefined) {
    if (typeof raw.install_path !== 'string' || raw.install_path.trim() === '') {
      throw cfg('install_path must be a non-empty string for ' + JSON.stringify(modelId), path);
    }
    out.install_path = raw.install_path;
  }
  if (raw.runtime_id !== undefined) {
    if (typeof raw.runtime_id !== 'string' || raw.runtime_id.trim() === '') {
      throw cfg('runtime_id must be a non-empty string for ' + JSON.stringify(modelId), path);
    }
    out.runtime_id = raw.runtime_id;
  }
  if (raw.last_validation !== undefined) {
    if (!isRecord(raw.last_validation)) throw cfg('last_validation must be an object for ' + JSON.stringify(modelId), path);
    const lv = raw.last_validation;
    if (!isValidationStatus(lv.status)) throw cfg('last_validation.status must be passed|failed|unknown for ' + JSON.stringify(modelId), path);
    const rec: ModelValidationRecord = { status: lv.status };
    if (lv.timestamp !== undefined) {
      if (typeof lv.timestamp !== 'string' || lv.timestamp.trim() === '') {
        throw cfg('last_validation.timestamp must be a non-empty string for ' + JSON.stringify(modelId), path);
      }
      rec.timestamp = lv.timestamp;
    }
    if (lv.reason !== undefined) {
      if (typeof lv.reason !== 'string' || lv.reason.trim() === '') {
        throw cfg('last_validation.reason must be a non-empty string for ' + JSON.stringify(modelId), path);
      }
      rec.reason = lv.reason;
    }
    out.last_validation = rec;
  }
  checkLifecycle(modelId, out, path);
  return out;
}

function parseSelection(kind: LocalModelKind, raw: unknown, path: string): ModelKindSelection {
  if (!isRecord(raw)) throw cfg('selection must be an object for kind ' + JSON.stringify(kind), path);
  if (!isSelectionMode(raw.mode)) throw cfg('selection mode must be auto|manual for kind ' + JSON.stringify(kind), path);
  if (raw.mode === 'manual') {
    if (typeof raw.model_id !== 'string' || raw.model_id.trim() === '') {
      throw cfg('manual selection requires a non-empty model_id for kind ' + JSON.stringify(kind), path);
    }
    return { mode: 'manual', model_id: raw.model_id };
  }
  if (raw.model_id !== undefined) throw cfg('auto selection must not carry model_id for kind ' + JSON.stringify(kind), path);
  return { mode: 'auto' };
}

// Validate an in-memory lifecycle snapshot with the SAME invariants used
// by persisted-state parsing (round-trips through parseLifecycle so the
// two can never drift). Used by the installation service's internal
// staging rollback; not a general mutation API.
export function validateLifecycleSnapshot(modelId: string, snapshot: unknown, path: string): InstalledModelState {
  return parseLifecycle(modelId, snapshot, path);
}

// Parse + validate a raw decoded JSON value into canonical state. Throws a
// typed INVALID_CONFIG ArthurError naming the file path and reason. The
// corrupted file is NEVER modified or deleted here.
export function parseStateFile(raw: unknown, path: string): LocalModelStateFile {
  if (!isRecord(raw)) throw cfg('top level must be a JSON object', path);
  if (raw.version !== LOCAL_MODEL_STATE_VERSION) {
    throw cfg('unsupported schema version ' + JSON.stringify(raw.version) + ' (expected ' + String(LOCAL_MODEL_STATE_VERSION) + ')', path);
  }
  if (!isRecord(raw.selections)) throw cfg('selections must be an object', path);
  if (!isRecord(raw.models)) throw cfg('models must be an object', path);
  const selections = defaultSelections();
  for (const kind of LOCAL_MODEL_KINDS) {
    const entry = (raw.selections as Record<string, unknown>)[kind];
    if (entry === undefined) continue;
    selections[kind] = parseSelection(kind, entry, path);
  }
  for (const key of Object.keys(raw.selections)) {
    if (!isLocalModelKind(key)) throw cfg('unknown selection kind ' + JSON.stringify(key), path);
  }
  const models: Record<string, InstalledModelState> = {};
  for (const [modelId, entry] of Object.entries(raw.models)) {
    if (modelId.trim() === '') throw cfg('model id must be non-empty', path);
    models[modelId] = parseLifecycle(modelId, entry, path);
  }
  return { version: LOCAL_MODEL_STATE_VERSION, selections, models };
}

// Deterministic serialization: sorted model keys, fixed field order,
// stable 2-space indentation. Same state always yields the same bytes.
export function serializeStateFile(state: LocalModelStateFile): string {
  const models: Record<string, InstalledModelState> = {};
  for (const modelId of Object.keys(state.models).sort()) {
    const entry = state.models[modelId];
    if (!entry) continue;
    const ordered: InstalledModelState = {
      model_id: entry.model_id,
      installed: entry.installed,
      configured: entry.configured,
      ready: entry.ready,
    };
    if (entry.install_path !== undefined) ordered.install_path = entry.install_path;
    if (entry.runtime_id !== undefined) ordered.runtime_id = entry.runtime_id;
    if (entry.last_validation !== undefined) ordered.last_validation = entry.last_validation;
    models[modelId] = ordered;
  }
  const orderedSelections: Record<LocalModelKind, ModelKindSelection> = {
    stt: state.selections.stt.mode === 'manual' ? { mode: 'manual', model_id: state.selections.stt.model_id as string } : { mode: 'auto' },
    tts: state.selections.tts.mode === 'manual' ? { mode: 'manual', model_id: state.selections.tts.model_id as string } : { mode: 'auto' },
    model: state.selections.model.mode === 'manual' ? { mode: 'manual', model_id: state.selections.model.model_id as string } : { mode: 'auto' },
  };
  return JSON.stringify({ version: LOCAL_MODEL_STATE_VERSION, selections: orderedSelections, models }, null, 2) + '\n';
}
