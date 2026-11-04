/**
 * Native Linux runtime client: Electron Desktop -> native Node.js child
 * -> Sentry Linux Runtime (CachyOS only).
 *
 * As thin as WslRuntimeClient: the ONLY native concerns are the Node
 * executable, argv construction, and native error text. Transport
 * ownership (framing, handshake, shutdown, reconnect lifecycle) stays in
 * the shared StdioRuntimeClient. Argv only — never a shell, never
 * `process.execPath` (which may point at Electron when packaged).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { StdioRuntimeClient } from '../../runtime/stdio-runtime-client.js';
import type {
  HostDistributionInfo,
  RuntimeClient,
  RuntimeHello,
  RuntimeProcessLauncher,
  RuntimeStatus,
} from '../../runtime/runtime-client.js';

export type { RuntimeProcessLauncher };

export interface NativeLinuxRuntimeClientOptions {
  /** Standalone Node.js binary (PATH-resolved `node` or explicit override). */
  readonly nodeExecutable: string;
  readonly runtimeEntry: string;
  readonly dataRoot?: string;
  readonly distribution?: HostDistributionInfo;
  /** Test seam: override child creation (production always spawns Node). */
  readonly launcher?: RuntimeProcessLauncher;
}

/**
 * Argv for `<node> <runtimeEntry> --stdio [--data-root <path>]`.
 * The entry is a native absolute Linux path; secrets travel via
 * runtime.configure AFTER the handshake — never argv.
 */
export function buildNativeArgs(runtimeEntry: string, dataRoot?: string): string[] {
  if (dataRoot === undefined) {
    return [runtimeEntry, '--stdio'];
  }
  return [runtimeEntry, '--stdio', '--data-root', dataRoot];
}

/** Native Linux specialization: standalone Node over the shared transport. */
export class NativeLinuxRuntimeClient implements RuntimeClient {
  private readonly inner: StdioRuntimeClient;
  private readonly distribution: HostDistributionInfo | undefined;

  constructor(options: NativeLinuxRuntimeClientOptions) {
    this.distribution = options.distribution;
    const nodeExecutable = options.nodeExecutable;
    const entry = options.runtimeEntry;
    const dataRoot = options.dataRoot;
    const launcher =
      options.launcher ??
      ((): ChildProcess => {
        return spawn(nodeExecutable, buildNativeArgs(entry, dataRoot), {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      });
    this.inner = new StdioRuntimeClient({
      launch: launcher,
      spawnErrorPrefix: 'Native runtime spawn failed: ',
      offlineMessage: 'Native runtime unavailable',
      electronGuardMessage: 'Runtime runs under Electron — native host boundary violated',
    });
  }

  onNotification(handler: (event: string, payload: unknown) => void): void {
    this.inner.onNotification(handler);
  }

  onExit(handler: (code: number | null) => void): void {
    this.inner.onExit(handler);
  }

  get status(): RuntimeStatus {
    const base = this.inner.status;
    return {
      connected: base.connected,
      distro: undefined,
      hello: base.hello,
      lastError: base.lastError,
      hostPlatform: 'linux',
      executionMode: 'native-linux',
      ...(this.distribution === undefined ? {} : { distribution: this.distribution }),
    };
  }

  get stderrDiagnostics(): readonly string[] {
    return this.inner.stderrDiagnostics;
  }

  /** Spawn the runtime and complete the handshake. Rejects on timeout/mismatch. */
  start(): Promise<RuntimeHello> {
    return this.inner.start();
  }

  /** Graceful shutdown; falls back to kill after a bounded wait. */
  stop(): Promise<void> {
    return this.inner.stop();
  }

  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.inner.request(method, params, timeoutMs);
  }
}
