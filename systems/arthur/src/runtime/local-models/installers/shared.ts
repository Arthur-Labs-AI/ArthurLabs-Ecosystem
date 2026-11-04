/**
 * HR-02.5E1: shared model-installer helpers (no model-specific facts).
 *
 * Generic staged-install flow used by all three voice installers:
 * paths -> staging -> managed venv -> pinned packages -> model/cache
 * prepare -> smoke validation -> evidence. Installers own the
 * model-specific recipe; this module owns the reusable mechanics.
 *
 * Minimal structured descriptor E2 will consume to construct providers
 * (no provider is instantiated here).
 */

import * as path from 'node:path';

import { ArthurError } from '../../../core/errors/errors';
import type { HardwareProfile } from '../../hardware/contracts';
import { ManagedPathService, toStorageKey } from '../provisioning/paths';
import type { ProvisioningFs } from '../provisioning/staging';
import { commitStagedDirectory, createStagingArea, discardStagingArea } from '../provisioning/staging';
import { runTrustedProcess, type SpawnFn } from '../provisioning/process_runner';
import { ensureEnvironment, installPinnedPackages, type PinnedPackageSet, type PythonRuntimeSpec, type VenvFs } from '../provisioning/python';
import type { InstallationProgressEvent, ModelInstallArtifact, ModelInstallContext } from '../install_contracts';

export interface InstalledModelRuntimeDescriptor {
  model_id: string;
  runtime_id: string;
  install_path: string;
}

export interface InstallerSeams {
  run: SpawnFn;
  fs: ProvisioningFs;
  venvFs: VenvFs;
}

export type WriteFileFn = (filePath: string, content: string | Uint8Array) => void;

export function nodeWriteFile(): WriteFileFn {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  return (filePath, content) => {
    fs.mkdirSync(require('node:path').dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  };
}

export function memoryWriteFile(sink: Map<string, string>): WriteFileFn {
  return (filePath, content) => {
    sink.set(filePath, typeof content === 'string' ? content : Buffer.from(content).toString('binary'));
  };
}

export interface StagedInstall {
  paths: ManagedPathService;
  storageKey: string;
  liveDir: string;
  stagingDir: string;
  runtimeDir: string;
  say: (phase: InstallationProgressEvent['phase'], message: string) => void;
}

export function openStagedInstall(ctx: ModelInstallContext, runtimeId: string): StagedInstall {
  const paths = new ManagedPathService(ctx.managed_root);
  const storageKey = toStorageKey(ctx.model.id);
  const liveDir = paths.liveDir(storageKey);
  const runtimeDir = paths.runtimeDir(runtimeId);
  const say = (phase: InstallationProgressEvent['phase'], message: string): void => {
    try {
      ctx.reportProgress({ model_id: ctx.model.id, phase, message });
    } catch {
      // Progress sinks never break the lifecycle.
    }
  };
  return { paths, storageKey, liveDir, stagingDir: '', runtimeDir, say };
}

export function beginStaging(root: string, fs: ProvisioningFs, liveDir: string, hint: string): string {
  return createStagingArea(root, fs, liveDir, hint).stagingDir;
}

export function abortStaging(root: string, fs: ProvisioningFs, stagingDir: string): void {
  try {
    discardStagingArea(root, fs, stagingDir);
  } catch {
    // Best effort: staging leftovers are swept by recovery scans.
  }
}

export interface VenvSpec {
  runtimeId: string;
  pythonSpec: PythonRuntimeSpec;
  systemPython: string;
  packages: PinnedPackageSet;
}

export async function ensureManagedVenv(args: {
  root: string;
  runtimeDir: string;
  runtimeId: string;
  systemPython: string;
  packages: PinnedPackageSet;
  extraPackageSets?: PinnedPackageSet[];
  signal?: AbortSignal;
  run: SpawnFn;
  venvFs: VenvFs;
}): Promise<{ python_executable: string }> {
  const env = await ensureEnvironment({
    root: args.root,
    runtimeDir: args.runtimeDir,
    systemPython: args.systemPython,
    timeoutMs: 300000,
    signal: args.signal,
    fs: args.venvFs,
    run: args.run,
  });
  // Package sets apply IN ORDER: CUDA-index torch first (deterministic
  // +cu130, no CPU fallback), then the PyPI remainder. Each set keeps
  // its own code-owned indexUrl (or none for default PyPI).
  for (const set of [args.packages, ...(args.extraPackageSets ?? [])]) {
    await installPinnedPackages({ env, packages: set, timeoutMs: 600000, signal: args.signal, run: args.run });
  }
  return { python_executable: env.python_executable };
}

export async function runSmoke(args: {
  run: SpawnFn;
  executable: string;
  argv: readonly string[];
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; detail: string }> {
  if (args.signal && args.signal.aborted) return { ok: false, detail: 'smoke cancelled before start' };
  const result = await runTrustedProcess(args.run, {
    executable: args.executable,
    args: args.argv,
    timeoutMs: args.timeoutMs,
    signal: args.signal,
  });
  if (result.aborted) return { ok: false, detail: 'smoke aborted' };
  if (result.timed_out) return { ok: false, detail: 'smoke timed out' };
  if (result.exit_code !== 0) return { ok: false, detail: 'smoke exit ' + String(result.exit_code) };
  return { ok: true, detail: 'smoke passed' };
}

export function promoteOrFail(args: {
  root: string;
  fs: ProvisioningFs;
  stagingDir: string;
  liveDir: string;
}): { liveDir: string } {
  const result = commitStagedDirectory(args.root, args.fs, args.stagingDir, args.liveDir);
  if (result.outcome !== 'promoted') {
    try {
      discardStagingArea(args.root, args.fs, args.stagingDir);
    } catch {
      // Best effort; leftovers are recovery-visible.
    }
    throw new ArthurError('TOOL_EXECUTION_FAILED', 'promotion failed: ' + String(result.reason ?? 'unknown'));
  }
  return { liveDir: result.live_path };
}

export function checkAborted(ctx: ModelInstallContext): boolean {
  return ctx.signal !== undefined && ctx.signal.aborted;
}

export interface InstallManifest {
  model_id: string;
  installer_id: string;
  backend: string;
  runtime_id: string;
  repo: string;
  revision: string | null;
  snapshot_dir: string | null;
  source_archive_sha256: string | null;
  installed_at: string;
}

export const INSTALL_MANIFEST_FILENAME = 'install.json';

/**
 * Installer-owned live-install manifest: written into staging BEFORE
 * promotion so every live dir carries its own provenance (model,
 * installer, repo/revision/snapshot, source hash, runtime). E2 will
 * read this to construct providers. Deterministic key order.
 */
export function writeInstallManifest(
  writeFile: WriteFileFn,
  stagingDir: string,
  manifest: Omit<InstallManifest, 'installed_at'> & { installed_at?: string },
): string {
  const full: InstallManifest = {
    model_id: manifest.model_id,
    installer_id: manifest.installer_id,
    backend: manifest.backend,
    runtime_id: manifest.runtime_id,
    repo: manifest.repo,
    revision: manifest.revision,
    snapshot_dir: manifest.snapshot_dir,
    source_archive_sha256: manifest.source_archive_sha256,
    installed_at: manifest.installed_at ?? new Date().toISOString(),
  };
  const target = stagingDir + '/' + INSTALL_MANIFEST_FILENAME;
  writeFile(target, JSON.stringify(full, null, 2) + '\n');
  return target;
}

export function toDescriptor(modelId: string, runtimeId: string, installPath: string): InstalledModelRuntimeDescriptor {
  return { model_id: modelId, runtime_id: runtimeId, install_path: installPath };
}

export function artifactFromDescriptor(desc: InstalledModelRuntimeDescriptor, reason: string): ModelInstallArtifact {
  return { installed: true, configured: true, validation: { status: 'passed', reason }, install_path: desc.install_path, runtime_id: desc.runtime_id, detail: reason };
}

export function hardwareSummary(hardware: HardwareProfile): string {
  return hardware.arch + '/' + hardware.os + ' cuda=' + hardware.accelerators.cuda;
}

export { path as installerPath };
