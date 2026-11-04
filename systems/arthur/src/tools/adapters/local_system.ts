/**
 * Local system capability adapter (TASK-0011, Phase 3B).
 *
 * Machine-local capability layer used by registered tools such as
 * `system.status`. This adapter is an IMPLEMENTATION of a capability, not an
 * execution path of its own: it is reachable only through the secured
 * ToolRegistry -> ToolExecutionService boundary, never directly from the
 * model or the conversation pipeline.
 *
 * Read-only host information via Node standard APIs only (node:os /
 * process.*) - no child_process, no shell, no network, no filesystem access.
 * The status contract is deliberately minimal and non-sensitive: no username,
 * hostname, home directory, project paths, environment variables, network
 * addresses, or secrets ever pass through this adapter.
 */

import os from "node:os";

/** Non-sensitive local host status handed to registered tools. */
export interface LocalSystemStatus {
  /** Operating system platform (process.platform), e.g. "win32". */
  platform: string;
  /** CPU architecture (process.arch), e.g. "x64". */
  arch: string;
  /** Node.js version string (process.version), e.g. "v22.5.0". */
  node_version: string;
  /** OS uptime in whole seconds (>= 0). */
  uptime_seconds: number;
  /** Logical CPU count (>= 1). */
  cpu_count: number;
  /** Total physical memory in bytes (>= 0). */
  total_memory_bytes: number;
  /** Free physical memory in bytes (>= 0). */
  free_memory_bytes: number;
}

/**
 * Capability contract for machine-local system information. Tests inject a
 * deterministic fake; production uses NodeLocalSystemAdapter.
 */
export interface LocalSystemAdapter {
  getStatus(): Promise<LocalSystemStatus>;
}

/**
 * Production implementation over Node standard APIs. Field values are
 * clamped to the documented bounds (uptime/cpu/memory >= 0, cpu_count >= 1)
 * so the strict system.status output_schema can never reject real host data.
 */
export class NodeLocalSystemAdapter implements LocalSystemAdapter {
  async getStatus(): Promise<LocalSystemStatus> {
    return {
      platform: process.platform,
      arch: process.arch,
      node_version: process.version,
      uptime_seconds: Math.max(0, Math.floor(os.uptime())),
      cpu_count: Math.max(1, os.cpus().length),
      total_memory_bytes: Math.max(0, os.totalmem()),
      free_memory_bytes: Math.max(0, os.freemem()),
    };
  }
}
