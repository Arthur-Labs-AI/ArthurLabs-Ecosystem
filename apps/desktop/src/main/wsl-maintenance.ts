import type { RuntimeClient } from './runtime/runtime-client.js';
import type { WslSpaceResult } from '../shared/ipc-contract.js';

export interface WslMaintenanceDeps {
  readonly runtime: RuntimeClient;
  readonly hostKind: string;
  distro(): Promise<string>;
  inspect(distro: string): Promise<void>;
  reclaim(distro: string): Promise<Omit<WslSpaceResult, 'reconnected'>>;
  reconnect(): Promise<void>;
  pause(): void;
  resume(): void;
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** A host lifecycle operation. The runtime remains authoritative for busy refusal. */
export class WslMaintenance {
  private running = false;
  constructor(private readonly deps: WslMaintenanceDeps) {}
  get active(): boolean {
    return this.running;
  }

  async reclaimSpace(): Promise<WslSpaceResult> {
    if (this.running) throw failure('RUNTIME_MAINTENANCE', 'Disk reclamation is already running.');
    if (this.deps.hostKind !== 'windows')
      throw failure('HOST_UNSUPPORTED', 'Disk reclamation requires Windows and WSL2.');
    if (!this.deps.runtime.status.connected)
      throw failure('RUNTIME_OFFLINE', 'Reconnect Sentry before reclaiming Windows disk space.');
    this.running = true;
    let stopped = false;
    let result: Omit<WslSpaceResult, 'reconnected'> | undefined;
    let error: unknown;
    let reconnected = true;
    try {
      this.deps.pause();
      const active = await this.deps.runtime.request('system.activeRuns', {});
      if (!Array.isArray(active))
        throw failure('RUNTIME_INVALID_RESULT', 'Cannot verify that QA is idle.');
      if (active.length > 0)
        throw failure('RUNTIME_BUSY', 'Finish or cancel active QA before reclaiming disk space.');
      const distro = await this.deps.distro();
      await this.deps.inspect(distro);
      // Require a positive shutdown acknowledgement. The normal stop() also
      // tolerates broken transports; that fallback cannot authorize WSL termination.
      const accepted = await this.deps.runtime.request('runtime.shutdown', {}, 5000);
      if (
        typeof accepted !== 'object' ||
        accepted === null ||
        (accepted as { shuttingDown?: unknown }).shuttingDown !== true
      ) {
        throw failure(
          'RUNTIME_INVALID_RESULT',
          'Runtime did not confirm safe shutdown. Compaction was not attempted.',
        );
      }
      stopped = true;
      await this.deps.runtime.stop();
      result = await this.deps.reclaim(distro);
    } catch (caught) {
      error = caught;
    } finally {
      if (stopped) {
        try {
          await this.deps.reconnect();
        } catch {
          reconnected = false;
        }
      }
      this.running = false;
      if (this.deps.runtime.status.connected) this.deps.resume();
    }
    if (error !== undefined) {
      if (!reconnected)
        throw failure(
          'MAINTENANCE_RECOVERY_FAILED',
          'Disk reclamation did not complete and the runtime could not reconnect. Restart Sentry; check Environment.',
        );
      throw error;
    }
    if (result === undefined)
      throw failure('MAINTENANCE_INVALID_RESULT', 'Disk reclamation returned no measurements.');
    return { ...result, reconnected };
  }
}
