/**
 * Host-platform contract for Sentry Desktop (Electron main).
 *
 * Desktop owns one runtime, one Stable Core, one CLI contract, and one
 * renderer. Only the host-specific edges vary: how the runtime process is
 * launched, how project source paths reach Linux, and which host facts
 * the UI/CLI may display. This contract is that edge — two small
 * implementations exist (Windows/WSL2, native CachyOS Linux), never a
 * second Desktop application.
 */
import type {
  ExecutionMode,
  HostDistributionInfo,
  HostKind,
  RuntimeClient,
} from '../runtime/runtime-client.js';

export type { ExecutionMode, HostDistributionInfo, HostKind };

/** Host facts for diagnostics and the Environment/CLI surface. Additive. */
export interface HostRuntimeInfo {
  readonly hostPlatform: HostKind;
  readonly executionMode: ExecutionMode;
  /** WSL distro (Windows only). Retained while Windows UI relies on it. */
  readonly distro?: string;
  /** Native Linux distribution facts (native Linux only). */
  readonly distribution?: HostDistributionInfo;
  /** Resolved runtime entry, when the platform has launched or probed it. */
  readonly runtimeEntry?: string;
  /** Resolved standalone Node binary (native Linux only). */
  readonly node?: { readonly executable: string; readonly version: string };
}

/**
 * Host-specific half of Desktop boot and project operations. Everything
 * else (RPC calls, runs, credentials, live updates, UI/IPC) stays common.
 */
export interface HostPlatform {
  readonly hostKind: HostKind;
  readonly executionMode: ExecutionMode;

  /** Launch (WSL distro resolve) or prepare (native checks) the runtime client. */
  createRuntimeClient(): Promise<RuntimeClient>;

  /**
   * Prepare a renderer-supplied project source path for the runtime.
   * Windows translates drive-letter paths via wslpath; native Linux
   * validates absolute Linux paths unchanged (including /mnt/*).
   */
  prepareSourcePath(path: string): Promise<string>;

  /** Host facts for diagnostics, status, and the CLI surface. */
  runtimeEnvironmentInfo(): Promise<HostRuntimeInfo>;

  /**
   * Runtime target choices for the settings surface. Windows returns the
   * existing WSL distro data; native Linux returns normalized host info
   * (there is no distro to choose).
   */
  runtimeDistros(): Promise<unknown>;

  /**
   * Persist a runtime target choice. Only meaningful on Windows/WSL;
   * native Linux rejects with a typed unsupported-operation error.
   */
  runtimeSelectDistro(distro: string): Promise<unknown>;
}
