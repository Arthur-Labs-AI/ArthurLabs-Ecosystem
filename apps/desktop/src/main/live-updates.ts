import type { BrowserWindow } from 'electron';
import type { DesktopApplicationService } from './services/desktop-service.js';
import type { RunUpdatePayload } from '../shared/ipc-contract.js';

export interface LiveUpdateOptions {
  readonly activeIntervalMs?: number;
  readonly idleIntervalMs?: number;
}

interface WatchedRun {
  readonly runId: string;
  lastPayload: string;
}

interface WatchedRetest {
  readonly retestRunId: string;
  lastPayload: string;
}

/**
 * Persisted-truth live updates: poll the repository at a bounded cadence
 * (500 ms for watched active runs, 5 s idle sweep) and push normalized
 * snapshots to the renderer. Backend truth always wins — no optimistic
 * status is ever emitted.
 */
export class DesktopLiveUpdates {
  private readonly watchedRuns = new Map<string, WatchedRun>();
  private readonly watchedRetests = new Map<string, WatchedRetest>();
  private activeTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly window: () => BrowserWindow | undefined,
    private readonly service: DesktopApplicationService,
    private readonly options: LiveUpdateOptions = {},
  ) {}

  get activeIntervalMs(): number {
    return this.options.activeIntervalMs ?? 500;
  }

  get idleIntervalMs(): number {
    return this.options.idleIntervalMs ?? 5000;
  }

  start(): void {
    this.stop();
    this.activeTimer = setInterval(() => void this.pollWatched(), this.activeIntervalMs);
    this.activeTimer.unref?.();
    this.idleTimer = setInterval(() => void this.pollIdle(), this.idleIntervalMs);
    this.idleTimer.unref?.();
  }

  stop(): void {
    if (this.activeTimer !== undefined) clearInterval(this.activeTimer);
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer);
    this.activeTimer = undefined;
    this.idleTimer = undefined;
  }

  watchRun(runId: string): void {
    if (!this.watchedRuns.has(runId)) this.watchedRuns.set(runId, { runId, lastPayload: '' });
    void this.pollWatched();
  }

  unwatchRun(runId: string): void {
    this.watchedRuns.delete(runId);
  }

  watchRetest(retestRunId: string): void {
    if (!this.watchedRetests.has(retestRunId))
      this.watchedRetests.set(retestRunId, { retestRunId, lastPayload: '' });
    void this.pollWatched();
  }

  unwatchRetest(retestRunId: string): void {
    this.watchedRetests.delete(retestRunId);
  }

  notifyRunCreated(runId: string, operationId?: string | undefined): void {
    this.watchRun(runId);
    this.emit({
      kind: 'run-created',
      runId,
      ...(operationId === undefined ? {} : { operationId }),
    });
  }

  notifyRetestCreated(retestRunId: string, operationId?: string | undefined): void {
    this.watchRetest(retestRunId);
    this.emit({
      kind: 'retest-created',
      retestRunId,
      ...(operationId === undefined ? {} : { operationId }),
    });
  }

  private async pollWatched(): Promise<void> {
    for (const watched of this.watchedRuns.values()) {
      try {
        const snapshot = this.service.runSnapshot(watched.runId);
        const payload = JSON.stringify(snapshot);
        if (payload === watched.lastPayload) continue;
        this.watchedRuns.set(watched.runId, { ...watched, lastPayload: payload });
        const status = (snapshot.run as { status?: string }).status;
        if (['completed', 'partial', 'failed', 'cancelled'].includes(status ?? '')) {
          this.watchedRuns.delete(watched.runId);
        }
        this.emit({ kind: 'run-snapshot', runId: watched.runId, snapshot });
      } catch {
        // Run may vanish mid-poll; the next renderer read reconciles.
      }
    }
    for (const watched of this.watchedRetests.values()) {
      try {
        const snapshot = this.service.retestSnapshot(watched.retestRunId);
        const payload = JSON.stringify(snapshot);
        if (payload === watched.lastPayload) continue;
        this.watchedRetests.set(watched.retestRunId, { ...watched, lastPayload: payload });
        const status = (snapshot.retestRun as { status?: string }).status;
        if (['completed', 'partial', 'failed', 'cancelled'].includes(status ?? '')) {
          this.watchedRetests.delete(watched.retestRunId);
        }
        this.emit({ kind: 'retest-snapshot', retestRunId: watched.retestRunId, snapshot });
      } catch {
        // Retest may vanish mid-poll; the next renderer read reconciles.
      }
    }
  }

  private async pollIdle(): Promise<void> {
    try {
      const active = this.service.activeRuns();
      const win = this.window();
      if (win !== undefined && !win.isDestroyed()) {
        win.webContents.send('sentry:active-runs', active);
      }
      // Auto-watch newly active runs so the global strip stays truthful.
      for (const item of active) {
        if (!this.watchedRuns.has(item.runId)) {
          this.watchedRuns.set(item.runId, { runId: item.runId, lastPayload: '' });
        }
      }
    } catch {
      // Idle sweep failures never break the active stream.
    }
  }

  private emit(payload: RunUpdatePayload): void {
    const win = this.window();
    if (win === undefined || win.isDestroyed()) return;
    win.webContents.send('sentry:run-update', payload);
  }
}
