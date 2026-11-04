/**
 * FRS-02: provider credential storage boundary.
 *
 * Onboarding UX must not hardcode "secrets live forever in config.env", so
 * every credential read/write flows through this narrow interface:
 *
 *   CredentialStore: get / set / remove / has
 *
 * Current backend: MachineConfigCredentialStore, which persists
 * DEEPSEEK_API_KEY / OPENAI_API_KEY through the FRS-01 atomic
 * machine-config update primitive (updateMachineConfig). It never
 * duplicates machine-config write logic and never renders values.
 *
 * Future backend (SC-10): OS credential storage (Windows Credential
 * Manager / Linux Secret Service / macOS Keychain) replaces the backend
 * without rewriting onboarding — the interface is deliberately small.
 *
 * Security: credential VALUES never appear in logs, errors, JSON, or
 * status output. Only names and configured/not-configured booleans leave
 * this module. Ambient process-env / repo .env credentials are recognized
 * as effectively configured (resolveCredentialState) but are never copied
 * silently into machine config.
 */

import { ArthurError } from '../core/errors/errors';
import {
  readMachineConfig,
  resolveMachineConfigPath,
  updateMachineConfig,
  type MachineConfigUpdate,
} from '../config/machine_config';

/** Credentials managed by provider onboarding (closed set, fail closed). */
export const MANAGED_CREDENTIAL_NAMES = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY'] as const;

export type CredentialName = (typeof MANAGED_CREDENTIAL_NAMES)[number];

/** True for exactly the two managed credential names. */
export function isCredentialName(name: string): name is CredentialName {
  return (MANAGED_CREDENTIAL_NAMES as readonly string[]).includes(name);
}

function assertCredentialName(name: string): asserts name is CredentialName {
  if (!isCredentialName(name)) {
    throw new ArthurError('INVALID_REQUEST', 'unknown credential ' + JSON.stringify(name));
  }
}

/**
 * Narrow credential storage boundary (FRS-02 §3). Values are held in
 * memory only while in use and are never rendered by this interface.
 */
export interface CredentialStore {
  /** Machine-persisted value, or undefined when absent/empty. Never logged. */
  get(name: CredentialName): string | undefined;
  /** Persist a secret through the FRS-01 writer. Never logged. */
  set(name: CredentialName, secret: string): void;
  /** Remove the machine-persisted value so lower-precedence sources apply. */
  remove(name: CredentialName): void;
  /** True when a non-empty machine-persisted value exists. */
  has(name: CredentialName): boolean;
}

export interface MachineCredentialStoreDeps {
  /** Override the machine-config read (tests). Default: readMachineConfig. */
  readEntries?: () => Record<string, string>;
  /** Override the FRS-01 writer (tests). Default: updateMachineConfig. */
  writeUpdate?: (update: MachineConfigUpdate) => Record<string, string>;
}

/**
 * Validate a candidate secret BEFORE touching storage. Values are data:
 * non-empty, bounded, no NUL/newline/control injection. The message never
 * contains the value.
 */
function assertUsableSecret(name: CredentialName, secret: string): void {
  if (typeof secret !== 'string' || secret === '') {
    throw new ArthurError('INVALID_REQUEST', 'credential ' + name + ' must be a non-empty secret');
  }
  if (secret.length > 65536) {
    throw new ArthurError('INVALID_CONFIG', 'credential ' + name + ' exceeds the 64 KiB machine-config bound');
  }
  if (secret.indexOf(String.fromCharCode(0)) !== -1 || secret.indexOf('\n') !== -1 || secret.indexOf('\r') !== -1) {
    throw new ArthurError('INVALID_CONFIG', 'credential ' + name + ' must not contain NUL or newline characters');
  }
}

/**
 * Current CredentialStore backend: machine config.env via the FRS-01
 * atomic update primitive. No duplicated write logic, no value rendering.
 * (No in-memory secret retention: values pass through to the writer and
 * are not kept on the instance — JS strings cannot be memory-zeroized, so
 * no zeroization is claimed.)
 */
export class MachineConfigCredentialStore implements CredentialStore {
  private readonly deps: MachineCredentialStoreDeps;
  private readonly configPath: string;

  constructor(deps: MachineCredentialStoreDeps = {}, configPath?: string) {
    this.deps = deps;
    this.configPath = configPath ?? resolveMachineConfigPath();
  }

  private read(): Record<string, string> {
    if (this.deps.readEntries) return this.deps.readEntries();
    return readMachineConfig(this.configPath);
  }

  private write(update: MachineConfigUpdate): void {
    if (this.deps.writeUpdate) {
      this.deps.writeUpdate(update);
      return;
    }
    updateMachineConfig(update, this.configPath);
  }

  get(name: CredentialName): string | undefined {
    assertCredentialName(name);
    const value = this.read()[name];
    if (typeof value !== 'string' || value === '') return undefined;
    return value;
  }

  set(name: CredentialName, secret: string): void {
    assertCredentialName(name);
    assertUsableSecret(name, secret);
    this.write({ set: { [name]: secret } });
  }

  remove(name: CredentialName): void {
    assertCredentialName(name);
    this.write({ remove: [name] });
  }

  has(name: CredentialName): boolean {
    return this.get(name) !== undefined;
  }
}

/** Where an effective credential value comes from (name/source only). */
export type CredentialSource = 'process_env' | 'repo_env' | 'machine_config' | 'absent';

export interface CredentialState {
  /** True when a non-empty value is effective from any layer. */
  configured: boolean;
  /** Highest-precedence layer supplying a non-empty value. */
  source: CredentialSource;
  /** True when machine config holds a non-empty value (persisted). */
  machinePersisted: boolean;
}

export interface CredentialLayers {
  ambient: NodeJS.ProcessEnv | Record<string, string | undefined>;
  repo: Record<string, string>;
  machine: Record<string, string>;
}

function layerValue(layer: NodeJS.ProcessEnv | Record<string, string | undefined> | Record<string, string>, name: string): string | undefined {
  const value = (layer as Record<string, string | undefined>)[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Resolve the effective credential state WITHOUT exposing the value.
 * Precedence: ambient process env > repo .env > machine config. An
 * externally supplied credential reports configured (source: environment
 * layer) while machinePersisted stays false — onboarding must ask before
 * persisting, never copy silently.
 */
export function resolveCredentialState(name: CredentialName, layers: CredentialLayers): CredentialState {
  assertCredentialName(name);
  if (layerValue(layers.ambient, name) !== undefined) {
    return { configured: true, source: 'process_env', machinePersisted: layerValue(layers.machine, name) !== undefined };
  }
  if (layerValue(layers.repo, name) !== undefined) {
    return { configured: true, source: 'repo_env', machinePersisted: layerValue(layers.machine, name) !== undefined };
  }
  if (layerValue(layers.machine, name) !== undefined) {
    return { configured: true, source: 'machine_config', machinePersisted: true };
  }
  return { configured: false, source: 'absent', machinePersisted: false };
}
