import { hostname } from 'node:os';
import { createRuntimeInstanceId, type RuntimeInstanceId } from '@qa/shared';
import { RuntimeInstanceSchema, type RuntimeInstance } from '@qa/schemas';
import type { SentryRepository } from './repository.js';
import { RuntimePersistenceError } from './errors.js';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
export const DEFAULT_RUNTIME_STALE_AFTER_MS = 20_000;

export interface RuntimeLeaseOptions {
  readonly instanceId?: RuntimeInstanceId;
  readonly processId?: number;
  readonly hostname?: string;
  readonly heartbeatIntervalMs?: number;
  readonly staleAfterMs?: number;
  readonly now?: () => Date;
  readonly autoHeartbeat?: boolean;
  readonly onHeartbeatError?: (error: RuntimePersistenceError) => void;
}

export class RuntimeInstanceLease {
  readonly instanceId: RuntimeInstanceId;
  readonly staleAfterMs: number;
  private readonly now: () => Date;
  private readonly processId: number;
  private readonly host: string;
  private readonly heartbeatIntervalMs: number;
  private readonly autoHeartbeat: boolean;
  private readonly onHeartbeatError: ((error: RuntimePersistenceError) => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private current: RuntimeInstance | undefined;
  private heartbeatFailure: RuntimePersistenceError | undefined;

  constructor(
    private readonly repository: SentryRepository,
    options: RuntimeLeaseOptions = {},
  ) {
    this.instanceId = options.instanceId ?? createRuntimeInstanceId();
    this.processId = options.processId ?? process.pid;
    this.host = options.hostname ?? hostname();
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_RUNTIME_STALE_AFTER_MS;
    this.now = options.now ?? (() => new Date());
    this.autoHeartbeat = options.autoHeartbeat ?? true;
    this.onHeartbeatError = options.onHeartbeatError;
  }

  start(): RuntimeInstance {
    if (this.current !== undefined) return this.current;
    const timestamp = this.now().toISOString();
    this.current = RuntimeInstanceSchema.parse({
      schemaVersion: 1,
      id: this.instanceId,
      processId: this.processId,
      hostname: this.host,
      startedAt: timestamp,
      heartbeatAt: timestamp,
    });
    this.repository.saveRuntimeInstance(this.current);
    if (this.autoHeartbeat) {
      this.timer = setInterval(() => {
        try {
          this.heartbeat();
        } catch (cause) {
          const error =
            cause instanceof RuntimePersistenceError
              ? cause
              : new RuntimePersistenceError(
                  'RUNTIME_LEASE_LOST',
                  'Unable to renew the local runtime lease',
                  { cause },
                );
          this.heartbeatFailure = error;
          this.onHeartbeatError?.(error);
        }
      }, this.heartbeatIntervalMs);
      this.timer.unref();
    }
    return this.current;
  }

  heartbeat(): RuntimeInstance {
    if (this.current === undefined || this.current.releasedAt !== undefined) {
      throw new RuntimePersistenceError('RUNTIME_LEASE_LOST', 'Runtime lease is not active');
    }
    this.current = RuntimeInstanceSchema.parse({
      ...this.current,
      heartbeatAt: this.now().toISOString(),
    });
    this.repository.saveRuntimeInstance(this.current);
    this.heartbeatFailure = undefined;
    return this.current;
  }

  assertHealthy(): void {
    if (this.heartbeatFailure !== undefined) throw this.heartbeatFailure;
    if (this.current === undefined || this.current.releasedAt !== undefined) {
      throw new RuntimePersistenceError('RUNTIME_LEASE_LOST', 'Runtime lease is not active');
    }
  }

  isFresh(instanceId: RuntimeInstanceId, at: Date = this.now()): boolean {
    const instance = this.repository.getRuntimeInstance(instanceId);
    if (instance === undefined || instance.releasedAt !== undefined) return false;
    return Date.parse(instance.heartbeatAt) >= at.getTime() - this.staleAfterMs;
  }

  release(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    if (this.current === undefined || this.current.releasedAt !== undefined) return;
    const timestamp = this.now().toISOString();
    this.current = RuntimeInstanceSchema.parse({
      ...this.current,
      heartbeatAt: timestamp,
      releasedAt: timestamp,
    });
    this.repository.saveRuntimeInstance(this.current);
  }
}
