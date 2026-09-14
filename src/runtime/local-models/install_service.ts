/**
 * HR-02.5D1: generic model installation orchestration service.
 *
 * Pipeline per install request:
 *   already_ready? -> preflight (catalog, kind already fixed by lookup,
 *   hardware compatibility, installer availability) -> installer side
 *   effects (preparing/installing) -> persist installed -> configuring ->
 *   persist configured -> validating -> persist ready/passed.
 *
 * Corrected durability semantics (no fake transactional wipe):
 * - failure before durable installation succeeds: no false installed
 *   state is created; pre-existing state is left untouched.
 * - installation succeeds but configuration fails: installed=true,
 *   configured=false, ready=false is PERSISTED (real partial state).
 * - installation+configuration succeed but validation fails:
 *   installed=true, configured=true, ready=false + failed validation
 *   evidence is PERSISTED.
 * - reinstall/update over an existing good installation uses staging
 *   semantics: the previous good state is snapshotted first; failure or
 *   cancellation before successful replacement/promotion restores the
 *   snapshot so the previous installation is unchanged.
 * - cancellation: an already-aborted signal (or abort mid-flight) maps
 *   to `cancelled`; installer-reported cancellation is honored the same
 *   way. Partial durable state created before the abort is preserved
 *   honestly, never fabricated and never wiped to look transactional.
 *
 * Concurrency: per-model in-flight guard. A second same-process install
 * for the same model returns `already_in_progress` deterministically
 * (never a generic exception). Installing an already-ready model without
 * `force: true` returns `already_ready` without side effects.
 */

import { ArthurError } from '../../core/errors/errors';
import { evaluateCompatibility } from './compatibility';
import { isModelInstallerId } from './contracts';
import { getLocalModelCatalog } from './catalog';
import type {
  InstallationProgressEvent,
  InstallationResult,
  InstallRequest,
  InstallerResult,
  ModelInstallArtifact,
} from './install_contracts';
import type { ModelInstallerRegistry } from './install_registry';
import type { LocalModelStateStore } from './state_store';

export const DEFAULT_MANAGED_ROOT = './data/runtime/model-files';

export interface InstallationServiceDeps {
  store: LocalModelStateStore;
  registry: ModelInstallerRegistry;
  catalog?: ReturnType<typeof getLocalModelCatalog>;
}

function emit(
  onProgress: ((event: InstallationProgressEvent) => void) | undefined,
  events: InstallationProgressEvent[] | undefined,
  event: InstallationProgressEvent,
): void {
  if (events !== undefined) events.push(event);
  try {
    if (onProgress) onProgress(event);
  } catch {
    // Progress sinks must never break the lifecycle.
  }
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

export class ModelInstallationService {
  private readonly store: LocalModelStateStore;
  private readonly registry: ModelInstallerRegistry;
  private readonly catalog: ReturnType<typeof getLocalModelCatalog>;
  private readonly inFlight = new Set<string>();

  constructor(deps: InstallationServiceDeps) {
    this.store = deps.store;
    this.registry = deps.registry;
    this.catalog = deps.catalog ?? getLocalModelCatalog();
  }

  installationsInFlight(): string[] {
    return [...this.inFlight].sort();
  }

  async install(request: InstallRequest, collectedEvents?: InstallationProgressEvent[]): Promise<InstallationResult> {
    const modelId = request.model_id;
    const onProgress = request.onProgress;
    const say = (event: InstallationProgressEvent): void => emit(onProgress, collectedEvents, event);

    if (typeof modelId !== 'string' || modelId.trim() === '') {
      return { model_id: String(modelId ?? ''), outcome: 'failed', phase: 'preflight', reason: 'model id must be a non-empty string' };
    }
    if (this.inFlight.has(modelId)) {
      return { model_id: modelId, outcome: 'already_in_progress', phase: 'preflight', reason: 'installation of ' + JSON.stringify(modelId) + ' is already in progress' };
    }
    this.inFlight.add(modelId);
    try {
      return await this.runInstall(request, say);
    } finally {
      this.inFlight.delete(modelId);
    }
  }

  private async runInstall(
    request: InstallRequest,
    say: (event: InstallationProgressEvent) => void,
  ): Promise<InstallationResult> {
    const modelId = request.model_id;
    const managedRoot = request.managed_root ?? DEFAULT_MANAGED_ROOT;
    const signal = request.signal;

    say({ model_id: modelId, phase: 'preflight', message: 'checking compatibility' });
    if (aborted(signal)) {
      say({ model_id: modelId, phase: 'cancelled', message: 'installation cancelled before preflight' });
      return { model_id: modelId, outcome: 'cancelled', phase: 'cancelled', reason: 'installation aborted by caller' };
    }

    const def = this.catalog.find((entry) => entry.id === modelId) ?? null;
    if (!def) {
      return { model_id: modelId, outcome: 'failed', phase: 'preflight', reason: 'unknown model id ' + JSON.stringify(modelId) + ' (not in catalog)' };
    }

    const compat = evaluateCompatibility(def, request.hardware);
    if (!compat.compatible) {
      const blocking = compat.reasons
        .filter((reason) => reason.result === 'fail')
        .map((reason) => reason.requirement + ' | ' + reason.observed)
        .join('; ');
      return { model_id: modelId, outcome: 'incompatible', phase: 'preflight', reason: 'model ' + JSON.stringify(modelId) + ' is incompatible: ' + blocking };
    }

    const descriptor = def.installation;
    if (!descriptor || !isModelInstallerId(descriptor.installer_id)) {
      return { model_id: modelId, outcome: 'unsupported', phase: 'preflight', reason: 'model ' + JSON.stringify(modelId) + ' has no trusted installer yet (installation unavailable)' };
    }

    let installer;
    try {
      installer = this.registry.resolve(descriptor.installer_id);
    } catch (err) {
      const detail = err instanceof ArthurError ? err.message : String(err);
      return { model_id: modelId, outcome: 'unsupported', phase: 'preflight', reason: 'installer ' + JSON.stringify(descriptor.installer_id) + ' is not registered: ' + detail };
    }

    // Idempotency: an already-ready model short-circuits (no side effects)
    // unless the caller explicitly forces reinstallation.
    const existing = this.store.getModelState(modelId);
    if (!request.force && existing && existing.installed && existing.configured && existing.ready) {
      say({ model_id: modelId, phase: 'completed', message: 'already installed and ready' });
      return { model_id: modelId, outcome: 'already_ready', phase: 'completed', reason: 'model ' + JSON.stringify(modelId) + ' is already installed and ready' };
    }
    const previousGood = existing && existing.installed && existing.configured && existing.ready
      ? JSON.parse(JSON.stringify(existing))
      : null;

    say({ model_id: modelId, phase: 'preparing', message: 'preparing runtime' });
    if (aborted(signal)) {
      say({ model_id: modelId, phase: 'cancelled', message: 'installation cancelled during preparation' });
      return { model_id: modelId, outcome: 'cancelled', phase: 'cancelled', reason: 'installation aborted by caller during preparation' };
    }

    say({ model_id: modelId, phase: 'installing', message: 'installing model files' });
    let produced: InstallerResult;
    try {
      produced = await installer.install({
        model: def,
        hardware: request.hardware,
        managed_root: managedRoot,
        signal,
        reportProgress: (event) => say({ model_id: event.model_id, phase: event.phase, message: event.message }),
      });
    } catch (err) {
      // A throwing installer is an installer failure, not a service bug:
      // preserve any pre-existing state honestly and report `failed`.
      return { model_id: modelId, outcome: 'failed', phase: 'installing', reason: 'installer failed: ' + String(err instanceof Error ? err.message : err) };
    }

    if (aborted(signal) || produced.outcome === 'cancelled') {
      say({ model_id: modelId, phase: 'cancelled', message: 'installation cancelled' });
      return { model_id: modelId, outcome: 'cancelled', phase: 'cancelled', reason: produced.reason ?? 'installation aborted by caller' };
    }
    if (produced.outcome === 'auth_required') {
      say({ model_id: modelId, phase: 'failed', message: 'authentication required' });
      return { model_id: modelId, outcome: 'auth_required', phase: 'failed', reason: produced.reason ?? 'installer requires authentication' };
    }
    if (produced.outcome === 'failed' || !produced.artifact || !produced.artifact.installed) {
      // Failed before durable installation: nothing new is persisted, so a
      // staged-over good installation is trivially unchanged (no restore
      // needed — markInstalled was never reached).
      say({ model_id: modelId, phase: 'failed', message: 'installation failed' });
      const base = produced.reason ?? 'installer reported failure before durable installation';
      return previousGood
        ? { model_id: modelId, outcome: 'failed', phase: 'failed', reason: base + '; previous installation left unchanged' }
        : { model_id: modelId, outcome: 'failed', phase: 'failed', reason: base };
    }

    const artifact: ModelInstallArtifact = produced.artifact;
    // Staging: the installer's durable work is promoted into persisted
    // state step by step. `previousGood` restores a staged-over good
    // installation when a later stage fails or is cancelled.
    await this.store.markInstalled(modelId, artifact.install_path, artifact.runtime_id);

    say({ model_id: modelId, phase: 'configuring', message: 'configuring model' });
    if (aborted(signal)) {
      // Honest partial state: installed, not configured, not ready —
      // unless this staged over a good installation, which is restored.
      if (previousGood) await this.store.restoreModelStateInternal(modelId, previousGood);
      say({ model_id: modelId, phase: 'cancelled', message: 'installation cancelled during configuration' });
      return previousGood
        ? { model_id: modelId, outcome: 'cancelled', phase: 'cancelled', reason: 'cancelled during configuration; previous installation left unchanged' }
        : { model_id: modelId, outcome: 'cancelled', phase: 'cancelled', reason: 'cancelled after durable installation; model is installed but not configured' };
    }
    if (!artifact.configured) {
      // Real partial state persists: installed=true, configured=false,
      // ready=false — unless staged over good state, which is restored.
      if (previousGood) {
        await this.store.restoreModelStateInternal(modelId, previousGood);
        say({ model_id: modelId, phase: 'failed', message: 'configuration failed' });
        return { model_id: modelId, outcome: 'failed', phase: 'failed', reason: (produced.reason ?? 'configuration failed') + '; previous installation left unchanged' };
      }
      say({ model_id: modelId, phase: 'failed', message: 'configuration failed' });
      return { model_id: modelId, outcome: 'failed', phase: 'failed', reason: (produced.reason ?? 'configuration failed') + '; model is installed but not configured' };
    }
    await this.store.markConfigured(modelId);

    say({ model_id: modelId, phase: 'validating', message: 'validating installation' });
    if (aborted(signal)) {
      if (previousGood) await this.store.restoreModelStateInternal(modelId, previousGood);
      say({ model_id: modelId, phase: 'cancelled', message: 'installation cancelled during validation' });
      return previousGood
        ? { model_id: modelId, outcome: 'cancelled', phase: 'cancelled', reason: 'cancelled during validation; previous installation left unchanged' }
        : { model_id: modelId, outcome: 'cancelled', phase: 'cancelled', reason: 'cancelled after configuration; model is installed and configured but not validated' };
    }
    const stamp = new Date().toISOString();
    if (artifact.validation && artifact.validation.status === 'failed') {
      // Installed + configured + validation-failed evidence persists.
      if (previousGood) {
        await this.store.restoreModelStateInternal(modelId, previousGood);
        say({ model_id: modelId, phase: 'failed', message: 'validation failed' });
        return { model_id: modelId, outcome: 'failed', phase: 'failed', reason: (artifact.validation.reason ?? produced.reason ?? 'validation failed') + '; previous installation left unchanged' };
      }
      await this.store.markValidationFailed(modelId, stamp, artifact.validation.reason ?? produced.reason ?? 'validation failed');
      say({ model_id: modelId, phase: 'failed', message: 'validation failed' });
      return { model_id: modelId, outcome: 'failed', phase: 'failed', reason: (artifact.validation.reason ?? produced.reason ?? 'validation failed') + '; model is installed and configured but not ready' };
    }
    await this.store.markValidationPassed(modelId, stamp, artifact.detail ?? 'installation completed');
    say({ model_id: modelId, phase: 'completed', message: 'ready' });
    return { model_id: modelId, outcome: 'completed', phase: 'completed', reason: 'model ' + JSON.stringify(modelId) + ' installed, configured, and validated' };
  }
}

// NOTE (HR-02.5D1 scope): no installation-level uninstall operation exists
// here. A state-only uninstall would assert installed=false while real
// artifacts still exist on disk; actual uninstall (artifact/runtime
// cleanup) belongs to D2. `LocalModelStateStore.removeModelState` remains
// available as the low-level HR-02.5C state primitive.
