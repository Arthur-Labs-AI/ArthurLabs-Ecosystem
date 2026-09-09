/**
 * HarnessAdapter semantic contract. ZERO vendor SDK dependencies.
 * Future adapters (in-process, worker process, NDJSON, JSON-RPC,
 * socket, container) implement these semantics without changing
 * domain behavior.
 */
import type { AgentRunId } from '@qa/shared';
import type { HarnessEvent } from '@qa/schemas';
import type { HarnessHealthResult, HarnessMetadata } from './metadata.js';
import type { HarnessRunRequest } from './requests.js';

export interface HarnessAdapter {
  getMetadata(): Promise<HarnessMetadata>;
  healthCheck(): Promise<HarnessHealthResult>;
  run(request: HarnessRunRequest): AsyncIterable<HarnessEvent>;
  cancel(runId: AgentRunId): Promise<void>;
  dispose(): Promise<void>;
}
