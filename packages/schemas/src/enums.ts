/** Controlled vocabularies. Literal unions (never TS enums) so JSON and Zod stay aligned. */
export const QARUN_MODES = ['quick', 'full', 'targeted', 'ci', 'verify', 'retest', 'cicd'] as const;
export type QARunMode = (typeof QARUN_MODES)[number];

export const QARUN_STATUSES = [
  'created',
  'preflight',
  'snapshotting',
  'baseline',
  'preparing',
  'agents_running',
  'collecting',
  'normalizing',
  'clustering',
  'verifying',
  'synthesizing',
  'completed',
  'partial',
  'failed',
  'cancelled',
] as const;
export type QARunStatus = (typeof QARUN_STATUSES)[number];

export const AGENT_TASK_TYPES = ['qa', 'verify', 'retest', 'cicd', 'targeted_analysis'] as const;
export type AgentTaskType = (typeof AGENT_TASK_TYPES)[number];

export const AGENT_RUN_STATUSES = [
  'queued',
  'starting',
  'planning',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const FINDING_CATEGORIES = [
  'build',
  'runtime',
  'logic',
  'api',
  'frontend',
  'database',
  'authentication',
  'authorization',
  'security',
  'configuration',
  'performance',
  'concurrency',
  'dependency',
  'testing',
  'cicd',
  'deployment',
  'maintainability',
  'documentation',
  'other',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_CONFIDENCES = ['confirmed', 'strong', 'probable', 'speculative'] as const;
export type FindingConfidence = (typeof FINDING_CONFIDENCES)[number];

export const EVIDENCE_TYPES = [
  'test',
  'command',
  'runtime',
  'browser',
  'static_analysis',
  'code_reference',
  'log',
  'manual',
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const EVIDENCE_STRENGTHS = [
  'reproduced_failure',
  'reproduced_behavior',
  'tool_diagnostic',
  'strong_code_evidence',
  'agent_reasoning',
] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];

export const EVIDENCE_ENVIRONMENT_STATES = ['baseline', 'modified_workspace'] as const;
export type EvidenceEnvironmentState = (typeof EVIDENCE_ENVIRONMENT_STATES)[number];

export const UNIFIED_ISSUE_STATUSES = [
  'confirmed',
  'corroborated',
  'probable',
  'unverified',
  'rejected',
] as const;
export type UnifiedIssueStatus = (typeof UNIFIED_ISSUE_STATUSES)[number];

export const ISSUE_AGREEMENT_STATES = ['single_source', 'aligned', 'mixed', 'disputed'] as const;
export type IssueAgreementState = (typeof ISSUE_AGREEMENT_STATES)[number];

export const VERIFICATION_STATUSES = [
  'pending',
  'running',
  'verified',
  'failed',
  'inconclusive',
  'cancelled',
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const FIX_FILE_OPERATIONS = ['create', 'modify', 'delete', 'rename'] as const;
export type FixFileOperation = (typeof FIX_FILE_OPERATIONS)[number];

export const CICD_PROVIDERS = [
  'github_actions',
  'gitlab_ci',
  'azure_devops',
  'jenkins',
  'circleci',
  'custom',
] as const;
export type CICDProvider = (typeof CICD_PROVIDERS)[number];

export const CICD_RECOMMENDATION_CATEGORIES = [
  'build',
  'test',
  'lint',
  'typecheck',
  'cache',
  'security',
  'artifact',
  'deployment',
  'qa',
] as const;
export type CICDRecommendationCategory = (typeof CICD_RECOMMENDATION_CATEGORIES)[number];

export const CICD_RECOMMENDATION_SEVERITIES = ['required', 'recommended', 'optional'] as const;
export type CICDRecommendationSeverity = (typeof CICD_RECOMMENDATION_SEVERITIES)[number];

export const ARTIFACT_TYPES = [
  'stdout',
  'stderr',
  'log',
  'screenshot',
  'patch',
  'transcript',
  'json',
  'html_report',
  'sarif',
  'network_dump',
  'test_report',
  'other',
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const HARNESS_HEALTH_STATUSES = ['healthy', 'degraded', 'unavailable'] as const;
export type HarnessHealthStatus = (typeof HARNESS_HEALTH_STATUSES)[number];

export const HARNESS_CHECK_STATUSES = ['pass', 'warn', 'fail'] as const;
export type HarnessCheckStatus = (typeof HARNESS_CHECK_STATUSES)[number];

export const SNAPSHOT_FILE_TYPES = ['file', 'directory', 'symlink'] as const;
export type SnapshotFileType = (typeof SNAPSHOT_FILE_TYPES)[number];

export const OPERATING_SYSTEMS = ['linux', 'windows', 'macos', 'any'] as const;
export type OperatingSystem = (typeof OPERATING_SYSTEMS)[number];

export const VERIFICATION_LEVELS = ['fast', 'balanced', 'strict'] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

export const MANAGED_PROJECT_COPY_STATES = [
  'ready',
  'updating',
  'locked_for_run',
  'deleting',
  'error',
] as const;
export type ManagedProjectCopyState = (typeof MANAGED_PROJECT_COPY_STATES)[number];

export const CONTEXT_SOURCE_KINDS = [
  'readme',
  'documentation',
  'source',
  'test',
  'configuration',
  'user',
  'inference',
] as const;
export type ContextSourceKind = (typeof CONTEXT_SOURCE_KINDS)[number];

export const RUN_ACTIVITY_SOURCES = [
  'sentry',
  'agent',
  'baseline',
  'verifier',
  'merger',
  'report',
] as const;
export type RunActivitySource = (typeof RUN_ACTIVITY_SOURCES)[number];

export const RUN_ACTIVITY_KINDS = [
  'run',
  'preparation',
  'project_copy',
  'snapshot',
  'context',
  'baseline',
  'agent',
  'planning',
  'tool',
  'command',
  'file',
  'runtime',
  'api',
  'browser',
  'test',
  'evidence',
  'finding',
  'merger',
  'verification',
  'report',
  'other',
] as const;
export type RunActivityKind = (typeof RUN_ACTIVITY_KINDS)[number];

export const RUN_ACTIVITY_STATUSES = [
  'waiting',
  'running',
  'completed',
  'warning',
  'failed',
  'cancelled',
  'skipped',
] as const;
export type RunActivityStatus = (typeof RUN_ACTIVITY_STATUSES)[number];

export const FILE_CHANGE_PURPOSES = [
  'test',
  'instrumentation',
  'diagnostic_script',
  'configuration_experiment',
  'other',
] as const;
export type FileChangePurpose = (typeof FILE_CHANGE_PURPOSES)[number];
