import { INITIAL_AGENT_STACKS } from '@qa/domain';
import {
  FakeHarnessAdapter,
  HarnessAdapterRegistry,
  type FakeScenario,
} from '@qa/harness-protocol';
import { createEvidenceId, createFindingId, nowIsoTimestamp, type AgentStackId } from '@qa/shared';
import type { HarnessEvent, HarnessRunRequest, VerificationLevel } from '@qa/schemas';
import type { AgentRun } from '@qa/schemas';

export type SimulationScenario =
  'success' | 'partial' | 'all-fail' | 'transport-loss' | 'timeout' | 'protocol-error';

function scenarioFor(scenario: SimulationScenario, index: number): FakeScenario {
  if (scenario === 'all-fail') return 'failure';
  if (scenario === 'partial') return index === 1 ? 'transport-loss' : 'success';
  if (scenario === 'transport-loss') return index === 0 ? 'transport-loss' : 'success';
  if (scenario === 'timeout') return index === 0 ? 'timeout' : 'success';
  if (scenario === 'protocol-error') return index === 0 ? 'protocol-error' : 'success';
  return 'success';
}

export function createFakeHarnessRegistry(scenario: SimulationScenario): HarnessAdapterRegistry {
  const registry = new HarnessAdapterRegistry();
  for (const stack of INITIAL_AGENT_STACKS) {
    registry.register({
      stack,
      runtimeIdentity: {
        modelId: stack.model.modelId,
        adapterId: 'fake-harness',
        adapterVersion: '0.1.0',
      },
      createAdapter: ({ qaRunId, agentRunId, agentIndex }) => {
        const evidenceId = createEvidenceId();
        const createdAt = nowIsoTimestamp();
        return new FakeHarnessAdapter({
          scenario: scenarioFor(scenario, agentIndex),
          evidence: {
            schemaVersion: 1,
            id: evidenceId,
            qaRunId,
            agentRunId,
            strength: 'reproduced_behavior',
            environmentState: 'baseline',
            type: 'test',
            test: { framework: 'fake-harness', name: 'deterministic simulation', status: 'passed' },
            artifactIds: [],
            // Fake simulation has no observed operations; never invent a link.
            groundingOperationIds: [],
            createdAt,
          },
          finding: {
            schemaVersion: 1,
            id: createFindingId(),
            qaRunId,
            agentRunId,
            sourceAgentStackId: stack.id,
            title: 'Simulated finding from ' + stack.displayName,
            category: 'testing',
            severity: 'low',
            confidence: 'confirmed',
            description: 'Deterministic fake output used to validate the Sentry runtime pipeline.',
            locations: [{ relativePath: 'README.md' }],
            evidenceIds: [evidenceId],
            reproductionSteps: ['Run the fake harness simulation'],
            createdAt,
          },
          usage: {
            inputTokens: 100 + agentIndex,
            outputTokens: 40,
            cachedInputTokens: 10,
            turns: 2,
            durationMs: 90,
          },
        });
      },
    });
  }
  return registry;
}

export interface SimulateRunOptions {
  readonly agentStackIds?: readonly AgentStackId[];
  readonly scenario?: SimulationScenario;
  /** Run against an older project revision (same semantics as RunOptions). */
  readonly revisionId?: string;
  readonly verificationLevel?: VerificationLevel;
  readonly instructions?: string;
  readonly runTimeoutMs?: number;
  readonly onHarnessRequest?: (request: HarnessRunRequest) => void;
  readonly onHarnessEventPersisted?: (event: HarnessEvent, agentRun: AgentRun) => void;
}
