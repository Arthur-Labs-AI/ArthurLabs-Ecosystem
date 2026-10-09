/**
 * HR-02.5F: `arthur models ...` command implementations.
 *
 * Thin adapters over existing services — hardware probe, catalog,
 * compatibility, recommendation, D1 state/install services, E2 runtime
 * resolution, removal service. No second detector/registry/store/router.
 * Every command is an exported async function over injected `ModelsDeps`
 * so tests drive them deterministically (fake probe/state/installer/fs).
 * Rendering: human text by default, stable `{ok,command,data}` JSON with
 * `--json`. Exit codes follow lib/cli_exit.ts (existing conventions).
 */

import type { CliIO } from './index';
import { CliExit, CliErrorCode, exitCodeFor } from '../../src/cli_exit';
import { ArthurError } from '../../src/core/errors/errors';
import type { HardwareProfile } from '../../src/runtime/hardware/contracts';
import { SystemHardwareProbe } from '../../src/runtime/hardware/probe';
import type { LocalModelDefinition, LocalModelKind, RecommendationProfile } from '../../src/runtime/local-models/contracts';
import { getLocalModelCatalog } from '../../src/runtime/local-models/catalog';
import { evaluateCompatibility } from '../../src/runtime/local-models/compatibility';
import { recommendModel } from '../../src/runtime/local-models/recommendation';
import { resolveEffectiveSelection, resolveRunnableSelection } from '../../src/runtime/local-models/selection';
import type { SelectionSource } from '../../src/runtime/local-models/state_contracts';
import { LocalModelStateStore } from '../../src/runtime/local-models/state_store';
import { ModelInstallationService } from '../../src/runtime/local-models/install_service';
import { resolveLocalModelPaths } from '../../src/runtime/local-models/provisioning/paths';
import { createDefaultModelInstallerRegistry } from '../../src/runtime/local-models/installers/registry';
import { nodeSpawnFn } from '../../src/runtime/local-models/provisioning/process_runner';
import { nodeProvisioningFs } from '../../src/runtime/local-models/provisioning/staging';
import { nodeVenvFs } from '../../src/runtime/local-models/provisioning/python';
import { resolveRuntimeTarget } from '../../src/runtime/local-models/runtime/resolution';
import { removeManagedModel, nodeRemovalFs, type RemovalFs } from '../../src/runtime/local-models/removal';
import type { Settings } from '../../src/config/settings';

export interface ModelsDeps {
  probe?: { detect: () => Promise<HardwareProfile> };
  store?: LocalModelStateStore;
  installService?: ModelInstallationService;
  removalFs?: RemovalFs;
  catalog?: readonly LocalModelDefinition[];
  systemPython?: string;
  confirm?: (prompt: string) => Promise<boolean>;
  /** Optional structured progress sink (shared setup/install presenter). Never affects correctness. */
  onProgress?: (event: { model_id: string; phase: string; message: string }) => void;
}

export interface ModelsContext {
  managedRoot: string;
  statePath: string;
  json: boolean;
  io: CliIO;
}

/**
 * HR-02.5F: the ONE CLI path policy — delegates to the canonical
 * resolveLocalModelPaths contract. Precedence per field: explicit flag
 * -> caller configuration (voice.localModelRoot/StatePath) ->
 * ARTHUR_DATA_DIR -> stable OS user-data root. Defaults never depend
 * on process.cwd(); results are always absolute.
 */
export function modelsContext(app: { config: Settings }, flags: Map<string, string>, io: CliIO): ModelsContext {
  const voice = app.config.voice;
  const flagRoot = flags.get('root')?.trim() || undefined;
  const flagState = flags.get('state')?.trim() || undefined;
  const { managedRoot, statePath } = resolveLocalModelPaths({
    managedRoot: flagRoot ?? (voice.localModelRoot.trim() !== '' ? voice.localModelRoot : undefined),
    statePath: flagState ?? (voice.localModelStatePath.trim() !== '' ? voice.localModelStatePath : undefined),
  });
  return { managedRoot, statePath, json: flags.get('json') === 'true', io };
}

/** CLI-facing selection provenance: `recommended` (resolver) -> `recommendation` (contract). */
export type SelectionProvenance = 'environment' | 'manual' | 'recommendation' | 'none';

export function provenanceOf(source: SelectionSource): SelectionProvenance {
  if (source === 'override') return 'environment';
  if (source === 'recommended') return 'recommendation';
  return source;
}

function depsOf(ctx: ModelsContext, deps: ModelsDeps): Required<Pick<ModelsDeps, 'catalog'>> & ModelsDeps {
  return { catalog: deps.catalog ?? getLocalModelCatalog(), ...deps };
}

function emit(ctx: ModelsContext, command: string, data: unknown, text: string): number {
  if (ctx.json) ctx.io.out(JSON.stringify({ ok: true, command, data }, null, 2) + '\n');
  else ctx.io.out(text);
  return CliExit.SUCCESS;
}

function emitFailure(ctx: ModelsContext, command: string, code: string, message: string, details: unknown, exit: number): number {
  if (ctx.json) ctx.io.out(JSON.stringify({ ok: false, command, code, message, details }, null, 2) + '\n');
  else ctx.io.err('error [' + code + ']: ' + message + '\n');
  return exit;
}


// ---- detect -------------------------------------------------------------------------

export function formatHardware(hardware: HardwareProfile): string {
  const lines: string[] = [];
  lines.push('os: ' + hardware.os);
  lines.push('arch: ' + hardware.arch);
  lines.push('cpu: ' + String(hardware.cpu.model ?? 'unknown') + ' (' + String(hardware.cpu.logical_cores ?? 'unknown') + ' cores)');
  lines.push('memory: ' + (hardware.memory.total_mb === null ? 'unknown' : String(hardware.memory.total_mb) + ' MB'));
  if (hardware.gpus.length === 0) {
    lines.push('gpus: none detected');
  } else {
    for (const gpu of hardware.gpus) {
      lines.push('gpu: [' + gpu.vendor + '] ' + gpu.name + ' vram=' + (gpu.vram_mb === null ? 'unknown' : String(gpu.vram_mb) + ' MB'));
    }
  }
  const accel = hardware.accelerators;
  lines.push('cuda: ' + accel.cuda);
  lines.push('rocm: ' + accel.rocm);
  lines.push('vulkan: ' + accel.vulkan);
  lines.push('directml: ' + accel.directml);
  lines.push('npu: ' + accel.npu);
  return lines.join('\n') + '\n';
}

export async function runModelsDetect(app: { config: Settings }, ctx: ModelsContext, deps: ModelsDeps = {}): Promise<number> {
  void app;
  try {
    const probe = deps.probe ?? new SystemHardwareProbe();
    const hardware = await probe.detect();
    return emit(ctx, 'models detect', hardware, formatHardware(hardware));
  } catch (err) {
    return cliErrorExit(ctx, 'models detect', err);
  }
}

// ---- list ---------------------------------------------------------------------------

export interface ModelListRow {
  id: string;
  kind: LocalModelKind;
  quality_tier: string;
  maturity: string;
  compatible: boolean;
  compatibility_note: string;
  installed: boolean;
  configured: boolean;
  ready: boolean;
  selected: boolean;
  /** HR-02.5F: effective-selection provenance for this kind (none when unselected). */
  selection_source: SelectionProvenance;
  runnable: boolean;
}

export async function buildModelList(app: { config: Settings }, ctx: ModelsContext, deps: ModelsDeps = {}): Promise<{ hardware: HardwareProfile; rows: ModelListRow[] }> {
  void app;
  const { catalog } = depsOf(ctx, deps);
  const probe = deps.probe ?? new SystemHardwareProbe();
  const hardware = await probe.detect();
  const store = deps.store ?? LocalModelStateStore.load({ statePath: ctx.statePath });
  const snapshot = store.snapshot();
  const rows: ModelListRow[] = catalog.map((def) => {
    const compat = evaluateCompatibility(def, hardware);
    const entry = snapshot.models[def.id];
    const effective = resolveEffectiveSelection({ kind: def.kind, hardware, state: snapshot, catalog, env: process.env });
    const runnable = resolveRunnableSelection({ kind: def.kind, hardware, state: snapshot, catalog, env: process.env });
    const failed = compat.reasons.filter((r) => r.result === 'fail');
    const blocking = failed.map((r) => r.requirement).join('; ');
    const unknownFacts = failed.filter((r) => r.observed.toLowerCase().includes('unknown')).map((r) => r.requirement).join('; ');
    const isSelected = effective.model?.id === def.id;
    return {
      id: def.id,
      kind: def.kind,
      quality_tier: def.quality_tier,
      maturity: def.support.maturity,
      compatible: compat.compatible,
      compatibility_note: compat.compatible ? 'compatible' : 'incompatible: ' + blocking + (unknownFacts !== '' ? ' (unknown facts: ' + unknownFacts + ')' : ''),
      installed: entry?.installed ?? false,
      configured: entry?.configured ?? false,
      ready: entry?.ready ?? false,
      selected: isSelected,
      selection_source: isSelected ? provenanceOf(effective.source) : 'none',
      runnable: runnable.model?.id === def.id && runnable.runnable,
    };
  });
  return { hardware, rows };
}

export function formatModelList(rows: ModelListRow[]): string {
  const out: string[] = [];
  for (const row of rows) {
    out.push(
      row.id + ' [' + row.kind + '] tier=' + row.quality_tier + ' maturity=' + row.maturity + '\n' +
      '  compatible=' + String(row.compatible) + ' (' + row.compatibility_note + ')\n' +
      '  installed=' + String(row.installed) + ' configured=' + String(row.configured) + ' ready=' + String(row.ready) + '\n' +
      '  selected=' + String(row.selected) + ' source=' + row.selection_source + ' runnable=' + String(row.runnable) + '\n',
    );
  }
  return out.join('');
}

export async function runModelsList(app: { config: Settings }, ctx: ModelsContext, deps: ModelsDeps = {}): Promise<number> {
  try {
    const { rows } = await buildModelList(app, ctx, deps);
    return emit(ctx, 'models list', { models: rows }, formatModelList(rows));
  } catch (err) {
    return cliErrorExit(ctx, 'models list', err);
  }
}

// ---- recommend ----------------------------------------------------------------------

const PROFILES: RecommendationProfile[] = ['quality', 'balanced', 'lightweight'];

export async function runModelsRecommend(app: { config: Settings }, ctx: ModelsContext, flags: Map<string, string>, deps: ModelsDeps = {}): Promise<number> {
  try {
    const { catalog } = depsOf(ctx, deps);
    const rawProfile = flags.get('profile') ?? 'quality';
    if (!(PROFILES as string[]).includes(rawProfile)) {
      return emitFailure(ctx, 'models recommend', 'USAGE', 'unknown profile ' + JSON.stringify(rawProfile) + ' (expected quality|balanced|lightweight)', {}, CliExit.USAGE);
    }
    const profile = rawProfile as RecommendationProfile;
    const rawKind = flags.get('kind');
    if (rawKind !== undefined && rawKind !== 'stt' && rawKind !== 'tts') {
      return emitFailure(ctx, 'models recommend', 'USAGE', 'unknown kind ' + JSON.stringify(rawKind) + ' (expected stt|tts)', {}, CliExit.USAGE);
    }
    const kinds: LocalModelKind[] = rawKind === undefined ? ['stt', 'tts'] : [rawKind as LocalModelKind];
    const probe = deps.probe ?? new SystemHardwareProbe();
    const hardware = await probe.detect();
    const store = deps.store ?? LocalModelStateStore.load({ statePath: ctx.statePath });
    const before = JSON.stringify(store.snapshot());
    const data: Record<string, { model: string | null; reason: string }> = {};
    const text: string[] = [];
    for (const kind of kinds) {
      const rec = recommendModel({ kind, profile, hardware, catalog });
      data[kind] = { model: rec.selected ? rec.selected.id : null, reason: rec.reason };
      text.push(kind + ': ' + (rec.selected ? rec.selected.id : '(none compatible)') + '\n' + rec.reason.split('\n').map((l) => '  ' + l).join('\n') + '\n');
    }
    if (JSON.stringify(store.snapshot()) !== before) {
      return emitFailure(ctx, 'models recommend', 'INTERNAL', 'recommendation mutated state (refusing)', {}, CliExit.INTERNAL);
    }
    void app;
    return emit(ctx, 'models recommend', { profile, recommendations: data }, text.join(''));
  } catch (err) {
    return cliErrorExit(ctx, 'models recommend', err);
  }
}


// ---- install ------------------------------------------------------------------------

export function installExitFor(outcome: string): number {
  switch (outcome) {
    case 'completed':
    case 'already_ready':
    case 'already_in_progress':
      return CliExit.SUCCESS;
    case 'auth_required':
      return CliExit.AUTH_REQUIRED;
    case 'incompatible':
    case 'unsupported':
      return CliExit.INCOMPATIBLE;
    case 'cancelled':
    case 'failed':
    default:
      return CliExit.VALIDATION_FAILED;
  }
}

export function installCodeFor(outcome: string): string {
  switch (outcome) {
    case 'completed':
    case 'already_ready':
    case 'already_in_progress':
      return 'OK';
    case 'auth_required':
      return CliErrorCode.AUTH_REQUIRED;
    case 'incompatible':
    case 'unsupported':
      return CliErrorCode.INCOMPATIBLE;
    case 'cancelled':
    case 'failed':
    default:
      return CliErrorCode.FAILED;
  }
}

export async function runModelsInstall(app: { config: Settings }, ctx: ModelsContext, modelId: string, flags: Map<string, string>, deps: ModelsDeps = {}): Promise<number> {
  void app;
  try {
    const { catalog } = depsOf(ctx, deps);
    if (!modelId || modelId.trim() === '') {
      return emitFailure(ctx, 'models install', 'USAGE', 'usage: arthur models install <model-id> [--reinstall]', {}, CliExit.USAGE);
    }
    const def = catalog.find((entry) => entry.id === modelId) ?? null;
    if (!def) {
      return emitFailure(ctx, 'models install', 'USAGE', 'unknown model id ' + JSON.stringify(modelId) + ' (see `arthur models list`)', {}, CliExit.USAGE);
    }
    const probe = deps.probe ?? new SystemHardwareProbe();
    const hardware = await probe.detect();
    const store = deps.store ?? LocalModelStateStore.load({ statePath: ctx.statePath });
    // Bootstrap interpreter: --python flag, ARTHUR_LOCAL_SYSTEM_PYTHON,
    // or the registry default (py/python3). A space-containing value is
    // rejected fast: argv-only spawn takes one executable, never a line.
    const systemPython = flags.get('python')?.trim() || process.env['ARTHUR_LOCAL_SYSTEM_PYTHON']?.trim() || deps.systemPython;
    if (systemPython && /\s/.test(systemPython)) {
      return emitFailure(ctx, 'models install', 'USAGE', 'invalid --python: a single executable path, not a command line', {}, CliExit.USAGE);
    }
    const service = deps.installService ?? new ModelInstallationService({
      store,
      registry: createDefaultModelInstallerRegistry({ run: nodeSpawnFn(), fs: nodeProvisioningFs(), venvFs: nodeVenvFs(), systemPython }),
    });
    const events: Array<{ phase: string; message: string }> = [];
    // Visible install UX (Part F): human TTY/non-TTY mode drives the SAME
    // shared stage presenter live from structured events; JSON stays silent
    // and an injected onProgress (setup wizard) owns presentation instead.
    const live = !ctx.json && !deps.onProgress;
    const ui = live ? await import('./setup_ui') : null;
    const presenter = ui ? ui.createStagePresenter(ctx.io, { title: 'Installing ' + modelId }) : null;
    const stageStarted: boolean[] = [false, false, false, false, false, false];
    const begin = (i: number): void => { if (presenter && !stageStarted[i]) { stageStarted[i] = true; presenter.start(i); } };
    if (presenter) ctx.io.out('\u2713 Compatibility validated\n');
    const sink = (event: { phase: string; message: string }): void => {
      events.push({ phase: event.phase, message: event.message });
      try {
        if (deps.onProgress) deps.onProgress({ model_id: modelId, phase: event.phase, message: event.message });
      } catch {
        // Progress sinks must never break the lifecycle.
      }
      if (presenter && ui) {
        const idx = ui.stageIndexForPhase(event.phase, event.message);
        for (let i = 0; i < idx; i += 1) { begin(i); presenter.complete(i); }
        begin(idx);
        if (event.phase === 'completed' || event.phase === 'failed' || event.phase === 'cancelled') {
          if (event.phase === 'completed') { for (let i = 0; i <= idx; i += 1) { begin(i); presenter.complete(i); } presenter.finish(); }
          else presenter.fail(idx, event.message);
        }
      }
    };
    const result = await service.install({
      model_id: modelId,
      hardware,
      managed_root: ctx.managedRoot,
      force: flags.get('reinstall') === 'true',
      onProgress: sink,
    });
    if (presenter && (result.outcome === 'completed' || result.outcome === 'already_ready' || result.outcome === 'already_in_progress')) {
      for (let i = 0; i < 6; i += 1) { begin(i); presenter.complete(i); }
      presenter.finish();
    }
    const data = { model_id: result.model_id, outcome: result.outcome, phase: result.phase, reason: result.reason, events };
    const text = modelId + ': ' + result.outcome + '\n  ' + result.reason + '\n';
    if (result.outcome === 'completed' || result.outcome === 'already_ready' || result.outcome === 'already_in_progress') {
      return emit(ctx, 'models install', data, text);
    }
    return emitFailure(ctx, 'models install', installCodeFor(result.outcome), result.reason, data, installExitFor(result.outcome));
  } catch (err) {
    return cliErrorExit(ctx, 'models install', err);
  }
}

// ---- select -------------------------------------------------------------------------

export async function runModelsSelect(app: { config: Settings }, ctx: ModelsContext, modelId: string, deps: ModelsDeps = {}): Promise<number> {
  void app;
  try {
    const { catalog } = depsOf(ctx, deps);
    if (!modelId || modelId.trim() === '') {
      return emitFailure(ctx, 'models select', 'USAGE', 'usage: arthur models select <model-id>', {}, CliExit.USAGE);
    }
    const def = catalog.find((entry) => entry.id === modelId) ?? null;
    if (!def) {
      return emitFailure(ctx, 'models select', 'USAGE', 'unknown model id ' + JSON.stringify(modelId) + ' (see `arthur models list`)', {}, CliExit.USAGE);
    }
    const probe = deps.probe ?? new SystemHardwareProbe();
    const hardware = await probe.detect();
    const store = deps.store ?? LocalModelStateStore.load({ statePath: ctx.statePath });
    const compat = evaluateCompatibility(def, hardware);
    if (!compat.compatible) {
      const blocking = compat.reasons.filter((r) => r.result === 'fail').map((r) => r.requirement + ' | ' + r.observed).join('; ');
      return emitFailure(ctx, 'models select', 'INCOMPATIBLE', 'model ' + JSON.stringify(modelId) + ' is incompatible and cannot be selected: ' + blocking, { model_id: modelId }, CliExit.INCOMPATIBLE);
    }
    // Kind-aware: the selection slot follows the model's own kind (an STT
    // model can never become the TTS selection).
    await store.select(def.kind, modelId);
    const snapshot = store.snapshot();
    const runnable = resolveRunnableSelection({ kind: def.kind, hardware, state: snapshot, catalog });
    const isRunnable = runnable.model?.id === modelId && runnable.runnable;
    const data = { model_id: modelId, kind: def.kind, runnable: isRunnable };
    const text = modelId + ' selected for ' + def.kind + (isRunnable ? ' (runnable)' : ' (selected but not runnable: install/configure/validate first)') + '\n';
    return emit(ctx, 'models select', data, text);
  } catch (err) {
    return cliErrorExit(ctx, 'models select', err);
  }
}

// ---- status -------------------------------------------------------------------------

export interface KindStatus {
  selected: string | null;
  /** HR-02.5F: effective-selection provenance (environment|manual|recommendation|none). */
  selection_source: SelectionProvenance;
  installed: boolean;
  configured: boolean;
  ready: boolean;
  runtime_id: string | null;
  validation: { status: string; reason: string | null } | null;
  artifacts_present: boolean | null;
  runnable: boolean;
}

export async function buildStatus(app: { config: Settings }, ctx: ModelsContext, deps: ModelsDeps = {}): Promise<{ managed_root: string; state_path: string; stt: KindStatus; tts: KindStatus }> {
  void app;
  const { catalog } = depsOf(ctx, deps);
  const probe = deps.probe ?? new SystemHardwareProbe();
  const hardware = await probe.detect();
  const store = deps.store ?? LocalModelStateStore.load({ statePath: ctx.statePath });
  const snapshot = store.snapshot();
  const one = (kind: 'stt' | 'tts'): KindStatus => {
    const effective = resolveEffectiveSelection({ kind, hardware, state: snapshot, catalog, env: process.env });
    const runnable = resolveRunnableSelection({ kind, hardware, state: snapshot, catalog, env: process.env });
    const modelId = effective.model ? effective.model.id : null;
    const entry = modelId ? snapshot.models[modelId] : undefined;
    let artifacts: boolean | null = null;
    if (modelId && entry && entry.installed && entry.configured && entry.ready) {
      try {
        resolveRuntimeTarget({ kind, hardware, state: snapshot, managedRoot: ctx.managedRoot, catalog });
        artifacts = true;
      } catch {
        artifacts = false;
      }
    }
    const validation = entry && entry.last_validation ? { status: entry.last_validation.status, reason: entry.last_validation.reason ?? null } : null;
    return {
      selected: modelId,
      selection_source: provenanceOf(effective.source),
      installed: entry?.installed ?? false,
      configured: entry?.configured ?? false,
      ready: entry?.ready ?? false,
      runtime_id: entry?.runtime_id ?? null,
      validation,
      artifacts_present: artifacts,
      runnable: runnable.model?.id === modelId && runnable.runnable && artifacts !== false,
    };
  };
  return { managed_root: ctx.managedRoot, state_path: ctx.statePath, stt: one('stt'), tts: one('tts') };
}

export function formatStatus(data: { managed_root: string; state_path: string; stt: KindStatus; tts: KindStatus }): string {
  const kind = (name: string, status: KindStatus): string => {
    const lines = [
      name + ' selected: ' + String(status.selected ?? '(none)') + '\n  source: ' + status.selection_source,
      '  installed: ' + String(status.installed),
      '  configured: ' + String(status.configured),
      '  ready: ' + String(status.ready),
      '  runtime: ' + String(status.runtime_id ?? '(none)'),
      '  current validation: ' + (status.validation ? status.validation.status + (status.validation.reason ? ' (' + status.validation.reason + ')' : '') : '(none)'),
    ];
    if (status.artifacts_present === false) lines.push('  WARNING: persisted READY but required runtime artifacts are missing');
    return lines.join('\n') + '\n';
  };
  return 'managed root: ' + data.managed_root + '\nstate: ' + data.state_path + '\n' + kind('STT', data.stt) + kind('TTS', data.tts);
}

export async function runModelsStatus(app: { config: Settings }, ctx: ModelsContext, deps: ModelsDeps = {}): Promise<number> {
  try {
    const data = await buildStatus(app, ctx, deps);
    return emit(ctx, 'models status', data, formatStatus(data));
  } catch (err) {
    return cliErrorExit(ctx, 'models status', err);
  }
}

// ---- validate -----------------------------------------------------------------------

export async function runModelsValidate(app: { config: Settings }, ctx: ModelsContext, modelId: string | undefined, deps: ModelsDeps = {}): Promise<number> {
  void app;
  try {
    const { catalog } = depsOf(ctx, deps);
    const probe = deps.probe ?? new SystemHardwareProbe();
    const hardware = await probe.detect();
    const store = deps.store ?? LocalModelStateStore.load({ statePath: ctx.statePath });
    // No id: validate the selected models (stt + tts effective picks).
    const ids: string[] = [];
    if (modelId) {
      const def = catalog.find((entry) => entry.id === modelId) ?? null;
      if (!def) {
        return emitFailure(ctx, 'models validate', 'USAGE', 'unknown model id ' + JSON.stringify(modelId), {}, CliExit.USAGE);
      }
      ids.push(modelId);
    } else {
      const snapshot = store.snapshot();
      for (const kind of ['stt', 'tts'] as const) {
        const effective = resolveEffectiveSelection({ kind, hardware, state: snapshot, catalog, env: process.env });
        if (effective.model) ids.push(effective.model.id);
      }
      if (ids.length === 0) {
        return emit(ctx, 'models validate', { validated: [] }, 'no selected models to validate\n');
      }
    }
    const results: Array<{ model_id: string; ok: boolean; reason: string }> = [];
    let failed = false;
    for (const id of ids) {
      const def = catalog.find((entry) => entry.id === id);
      const snapshot = store.snapshot();
      const entry = snapshot.models[id];
      if (!def || !entry || !entry.installed || !entry.configured) {
        results.push({ model_id: id, ok: false, reason: 'not installed and configured (nothing to validate)' });
        failed = true;
        continue;
      }
      const compat = evaluateCompatibility(def, hardware);
      if (!compat.compatible) {
        const reason = 'incompatible with current hardware';
        await store.markValidationFailed(id, new Date().toISOString(), reason);
        results.push({ model_id: id, ok: false, reason });
        failed = true;
        continue;
      }
      try {
        // Explicit-id validation answers readiness of THAT model (not the
        // current selection): resolve against a manual-selection override
        // snapshot (pure copy, never persisted). Kind follows the model.
        const kind = def.kind === 'model' ? 'tts' : def.kind;
        const override = { ...snapshot, selections: { ...snapshot.selections, [kind]: { mode: 'manual' as const, model_id: id } } };
        resolveRuntimeTarget({ kind, hardware, state: override, managedRoot: ctx.managedRoot, catalog });
      } catch (err) {
        const reason = 'required runtime artifacts missing: ' + String(err instanceof Error ? err.message : err);
        await store.markValidationFailed(id, new Date().toISOString(), reason);
        results.push({ model_id: id, ok: false, reason });
        failed = true;
        continue;
      }
      await store.markValidationPassed(id, new Date().toISOString(), 'offline readiness re-check passed');
      results.push({ model_id: id, ok: true, reason: 'ready (offline artifact + compatibility check)' });
    }
    const data = { validated: results };
    const text = results.map((r) => r.model_id + ': ' + (r.ok ? 'READY' : 'NOT READY') + ' (' + r.reason + ')\n').join('');
    if (failed) return emitFailure(ctx, 'models validate', 'VALIDATION_FAILED', 'validation failed', data, CliExit.VALIDATION_FAILED);
    return emit(ctx, 'models validate', data, text);
  } catch (err) {
    return cliErrorExit(ctx, 'models validate', err);
  }
}

// ---- remove -------------------------------------------------------------------------

export async function runModelsRemove(app: { config: Settings }, ctx: ModelsContext, modelId: string, flags: Map<string, string>, deps: ModelsDeps = {}): Promise<number> {
  void app;
  try {
    const { catalog } = depsOf(ctx, deps);
    if (!modelId || modelId.trim() === '') {
      return emitFailure(ctx, 'models remove', 'USAGE', 'usage: arthur models remove <model-id> [--yes]', {}, CliExit.USAGE);
    }
    if (!(catalog as readonly LocalModelDefinition[]).some((entry) => entry.id === modelId)) {
      return emitFailure(ctx, 'models remove', 'USAGE', 'unknown model id ' + JSON.stringify(modelId), {}, CliExit.USAGE);
    }
    const store = deps.store ?? LocalModelStateStore.load({ statePath: ctx.statePath });
    const confirmed = flags.get('yes') === 'true' || (deps.confirm ? await deps.confirm('remove ' + modelId + ' and its managed artifacts? [y/N] ') : false);
    if (!confirmed) {
      return emitFailure(ctx, 'models remove', 'USAGE', 'removal not confirmed (pass --yes to confirm)', { model_id: modelId }, CliExit.USAGE);
    }
    const result = await removeManagedModel({ modelId, managedRoot: ctx.managedRoot, store, fs: deps.removalFs ?? nodeRemovalFs(), catalog: catalog as ReturnType<typeof getLocalModelCatalog> });
    const data = { model_id: result.modelId, outcome: result.outcome, reason: result.reason, plan: result.plan };
    const text = modelId + ': ' + result.outcome + '\n  ' + result.reason + '\n';
    if (result.outcome === 'removed' || result.outcome === 'not_installed') {
      return emit(ctx, 'models remove', data, text);
    }
    return emitFailure(ctx, 'models remove', 'FAILED', result.reason, data, CliExit.VALIDATION_FAILED);
  } catch (err) {
    return cliErrorExit(ctx, 'models remove', err);
  }
}

export function cliErrorExit(ctx: ModelsContext, command: string, err: unknown): number {
  const code = err instanceof ArthurError ? err.code : 'INTERNAL';
  const message = err instanceof Error ? err.message : String(err);
  const exit = err instanceof ArthurError ? exitCodeFor(err.code) : CliExit.INTERNAL;
  return emitFailure(ctx, command, code, message, {}, exit);
}
