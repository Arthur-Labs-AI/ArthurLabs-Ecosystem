/**
 * HR-02.5E1: default trusted installer registry for real voice models.
 *
 * In-process construction only (no dynamic loading, no discovered
 * modules). The three E1 installers are wired to their catalog models;
 * D1 ModelInstallationService resolves them by installer id from the
 * catalog descriptors. Seams (run/fs/venvFs/systemPython) are injected
 * so unit tests use fakes; production passes node-backed primitives.
 */

import { nodeProvisioningFs } from '../provisioning/staging';
import { nodeSpawnFn } from '../provisioning/process_runner';
import { nodeVenvFs } from '../provisioning/python';
import { nodeDownloadFs, nodeHttpTransport, type DownloadFs, type HttpTransport } from '../provisioning/downloader';
import { nodeVerifyFs, type VerifyFs } from '../provisioning/verification';
import type { Pathoscopy } from '../provisioning/paths';
import { ModelInstallerRegistry } from '../install_registry';
import { BGTTS_MODEL_ID, makeBgTts38mInstaller } from './bgtts_38m';
import { OMNIVOICE_MODEL_ID, makeOmniVoiceBgInstaller } from './omnivoice_bg';
import { PARAKEET_MODEL_ID, makeParakeetInstaller } from './parakeet';
import type { SpawnFn } from '../provisioning/process_runner';
import type { ProvisioningFs } from '../provisioning/staging';
import type { VenvFs } from '../provisioning/python';

export interface DefaultInstallerDeps {
  run?: SpawnFn;
  fs?: ProvisioningFs;
  venvFs?: VenvFs;
  systemPython?: string;
  workerSourceDir?: string;
  harnessSourceDir?: string;
  readSourceFile?: (filePath: string) => string;
  writeFile?: (filePath: string, content: string | Uint8Array) => void;
  transport?: HttpTransport;
  downloadFs?: DownloadFs;
  verifyFs?: VerifyFs;
  scope?: Pathoscopy | null;
}

function trustedSystemPython(explicit: string | undefined): string {
  // Production bootstrap interpreter: code-owned candidate, never model
  // metadata or user input. Override is a TEST seam (same-process).
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  return process.platform === 'win32' ? 'py' : 'python3';
}

export function createDefaultModelInstallerRegistry(deps: DefaultInstallerDeps = {}): ModelInstallerRegistry {
  const registry = new ModelInstallerRegistry();
  const run = deps.run ?? nodeSpawnFn();
  const fs = deps.fs ?? nodeProvisioningFs();
  const venvFs = deps.venvFs ?? nodeVenvFs();
  const systemPython = trustedSystemPython(deps.systemPython);
  registry.register(makeParakeetInstaller({ run, fs, venvFs, systemPython, workerSourceDir: deps.workerSourceDir, readSourceFile: deps.readSourceFile, writeFile: deps.writeFile }));
  registry.register(makeOmniVoiceBgInstaller({ run, fs, venvFs, systemPython, harnessSourceDir: deps.harnessSourceDir, writeFile: deps.writeFile }));
  registry.register(makeBgTts38mInstaller({ run, fs, venvFs, systemPython, harnessSourceDir: deps.harnessSourceDir, writeFile: deps.writeFile, transport: deps.transport, downloadFs: deps.downloadFs, verifyFs: deps.verifyFs, scope: deps.scope ?? null }));
  return registry;
}

export const DEFAULT_INSTALLER_MODEL_IDS = [PARAKEET_MODEL_ID, OMNIVOICE_MODEL_ID, BGTTS_MODEL_ID];
