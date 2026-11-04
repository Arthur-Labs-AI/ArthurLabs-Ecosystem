/**
 * HarnessAdapter semantic contract. ZERO vendor SDK dependencies.
 * Future adapters (in-process, worker process, NDJSON, JSON-RPC,
 * socket, container) implement these semantics without changing
 * domain behavior.
 */
import type { AgentRunId } from '@qa/shared';
import type { HarnessEvent } from '@qa/schemas';
import type { HarnessDiagnostic, HarnessHealthResult, HarnessMetadata } from './metadata.js';
import type { HarnessRunRequest } from './requests.js';

export interface HarnessAdapter {
  getMetadata(): Promise<HarnessMetadata>;
  healthCheck(): Promise<HarnessHealthResult>;
  run(request: HarnessRunRequest): AsyncIterable<HarnessEvent>;
  cancel(runId: AgentRunId): Promise<void>;
  dispose(): Promise<void>;
  /**
   * Optional shutdown diagnostics (e.g. partial process-tree confidence on
   * Windows). The coordinator consumes these after dispose() and persists
   * them as observable run warnings. Generic: any future adapter may use it.
   */
  getShutdownDiagnostics?(): readonly HarnessDiagnostic[];
}
