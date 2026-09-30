/**
 * Platform-neutral contracts for the desktop runtime client (Electron main).
 *
 * The desktop talks to exactly one long-lived Sentry Linux runtime over a
 * stdio NDJSON RPC transport. Which host process carries that runtime is a
 * launcher concern (the Windows host launcher today, a native Linux child
 * next). This module owns the shared shape; it knows nothing about host
 * executables, distributions, or argv construction.
 */
import type { ChildProcess } from 'node:child_process';

export interface RuntimeHello {
  readonly protocolVersion: number;
  readonly runtimeVersion: string;
  readonly platform: string;
  readonly isWsl: boolean;
  readonly nodeVersion: string;
  readonly processExecPath: string;
  readonly distro?: string;
  readonly dataRoot: string;
}

export interface RuntimeStatus {
  readonly connected: boolean;
  /** Host-specific runtime label (the WSL distro on Windows). Optional for compatibility. */
  readonly distro?: string | undefined;
  readonly hello: RuntimeHello | undefined;
  readonly lastError: string | undefined;
}

/**
 * Behavior the desktop relies on, independent of how the runtime process
 * is launched. Implemented once by the stdio transport; specialized only
 * through the launcher seam below.
 */
export interface RuntimeClient {
  readonly status: RuntimeStatus;
  readonly stderrDiagnostics: readonly string[];

  start(): Promise<RuntimeHello>;
  stop(): Promise<void>;

  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;

  onNotification(handler: (event: string, payload: unknown) => void): void;

  onExit(handler: (code: number | null) => void): void;
}

/**
 * Narrow process-creation seam: the platform layer supplies an already
 * spawned child with piped stdio. No shell, no string-built commands —
 * the launcher builds argv arrays and the transport only attaches streams.
 * A native Linux launcher will provide this same seam.
 */
export type RuntimeProcessLauncher = () => ChildProcess;
