import type { AgentRunId, AgentStackId, QARunId } from '@qa/shared';
import type { AgentRuntimeIdentity, AgentStackDefinition } from '@qa/schemas';
import type { HarnessAdapter } from './adapter.js';

export interface HarnessAdapterFactoryContext {
  readonly qaRunId: QARunId;
  readonly agentRunId: AgentRunId;
  readonly agentIndex: number;
  readonly stack: AgentStackDefinition;
}

export interface HarnessAdapterRegistration {
  readonly stack: AgentStackDefinition;
  readonly preflight?: () => void | Promise<void>;
  readonly createAdapter: (
    context: HarnessAdapterFactoryContext,
  ) => HarnessAdapter | Promise<HarnessAdapter>;
  readonly runtimeIdentity?: Partial<AgentRuntimeIdentity>;
}

/** Composition-root registry. Orchestration depends on this abstraction, never a vendor SDK. */
export class HarnessAdapterRegistry {
  private readonly registrations = new Map<AgentStackId, HarnessAdapterRegistration>();

  register(registration: HarnessAdapterRegistration): this {
    if (this.registrations.has(registration.stack.id)) {
      throw new Error('Duplicate harness registration: ' + registration.stack.id);
    }
    this.registrations.set(registration.stack.id, registration);
    return this;
  }

  resolve(stackId: AgentStackId): HarnessAdapterRegistration | undefined {
    return this.registrations.get(stackId);
  }

  list(): readonly HarnessAdapterRegistration[] {
    return [...this.registrations.values()];
  }
}
