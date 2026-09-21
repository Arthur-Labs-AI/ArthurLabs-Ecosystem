/** Loose structural types: renderer never imports node-only packages at runtime. */

export interface AgentRunLike {
  readonly id: string;
  readonly qaRunId: string;
  readonly agentStackId: string;
  readonly status: string;
  readonly startedAt?: string;
  readonly completedAt?: string | null;
  readonly runtimeIdentity?: { modelId?: string; adapterId?: string };
  readonly usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    turns?: number;
    durationMs?: number;
  };
  readonly failure?: { code: string; message: string; retryable?: boolean };
}

export interface RunLike {
  readonly id: string;
  readonly projectId: string;
  readonly mode: string;
  readonly status: string;
  readonly executionKind?: string;
  readonly snapshotId: string;
  readonly projectContextSnapshotId?: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string | null;
  readonly configuration?: { agentStackIds?: string[] };
}

export interface FindingLike {
  readonly id: string;
  readonly agentRunId: string;
  readonly severity: string;
  readonly title: string;
  readonly category?: string;
}

export interface EvidenceLike {
  readonly id: string;
  readonly agentRunId: string;
  readonly type: string;
}

export interface ActivityLike {
  readonly id: string;
  readonly agentRunId?: string;
  readonly kind: string;
  readonly status: string;
  readonly title: string;
  readonly startedAt?: string;
  readonly completedAt?: string | null;
}

export interface HarnessEventLike {
  readonly type: string;
  readonly agentRunId: string;
  readonly timestamp: string;
  readonly tool?: {
    name?: string;
    inputSummary?: string;
    exitCode?: number;
    durationMs?: number;
    errorPreview?: string;
  };
  readonly command?: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly relativePath?: string;
  readonly suite?: string;
  readonly passed?: number;
  readonly failed?: number;
  readonly skipped?: number;
  readonly message?: string;
  readonly status?: string;
  readonly code?: string;
  readonly operationId?: string;
  readonly finding?: { id?: string; title?: string; severity?: string };
  readonly evidence?: { id?: string; type?: string };
  readonly failure?: { code: string; message: string; retryable?: boolean };
  readonly reason?: string;
  readonly usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    turns?: number;
    durationMs?: number;
  };
}

export type AgentStageId =
  'preparation' | 'planning' | 'investigation' | 'runtime' | 'evidence' | 'reporting' | 'completed';

export type StageState =
  'not_started' | 'active' | 'completed' | 'warning' | 'failed' | 'cancelled';

export interface AgentStageView {
  readonly id: AgentStageId;
  readonly label: string;
  readonly state: StageState;
}

export interface OperationView {
  readonly kind:
    'command' | 'file' | 'search' | 'test' | 'evidence' | 'finding' | 'lifecycle' | 'working';
  readonly title: string;
  readonly detail?: string | undefined;
  readonly timestamp?: string | undefined;
}

export interface AgentTelemetryCounts {
  readonly operations: number;
  readonly filesInspected: number;
  readonly commands: number;
  readonly tests: number;
}

export interface AgentNodeView {
  readonly agentRunId: string;
  readonly agentStackId: string;
  readonly displayName: string;
  readonly model: string;
  readonly status: string;
  readonly failure?: { code: string; message: string; retryable?: boolean | undefined } | undefined;
  readonly elapsedMs?: number | undefined;
  readonly telemetry: AgentTelemetryCounts;
  readonly stages: readonly AgentStageView[];
  readonly currentStage: AgentStageId | 'working';
  readonly currentOperation: OperationView;
  readonly recentActivity: readonly OperationView[];
  readonly findingsCount: number;
  readonly evidenceCount: number;
  readonly turns?: number | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly cachedInputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly severityCounts: Record<string, number>;
}

export interface TimelineItem {
  readonly timestamp?: string | undefined;
  readonly category: string;
  readonly title: string;
  readonly status?: string | undefined;
}
