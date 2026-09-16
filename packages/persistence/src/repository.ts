import type { AgentRunId, ProjectId, QARunId, RuntimeInstanceId } from '@qa/shared';
import {
  AgentInvestigationPlanSchema,
  AgentRunSchema,
  ArtifactSchema,
  EmergentHypothesisSchema,
  EvidenceSchema,
  FindingSchema,
  HarnessEventSchema,
  ManagedProjectCopySchema,
  ProjectContextSnapshotSchema,
  ProjectRevisionSchema,
  ProjectSchema,
  ProjectSnapshotSchema,
  QARunSchema,
  RunActivitySchema,
  RunExportManifestSchema,
  RuntimeInstanceSchema,
  RuntimeOperationSchema,
  type AgentInvestigationPlan,
  type AgentRun,
  type Artifact,
  type EmergentHypothesis,
  type Evidence,
  type Finding,
  type HarnessEvent,
  type ManagedProjectCopy,
  type Project,
  type ProjectContextSnapshot,
  type ProjectRevision,
  type ProjectSnapshot,
  type QARun,
  type RunActivity,
  type RunExportManifest,
  type RuntimeInstance,
  type RuntimeOperation,
} from '@qa/schemas';
import type { SentryDatabase } from './database.js';
import { RuntimePersistenceError } from './errors.js';
import {
  FindingClusterSchema,
  MergeResultSchema,
  VerificationAssertionSchema,
  VerificationObservationSchema,
  VerificationRecipeStepSchema,
  VerificationRunAttemptSchema,
  VerificationRunSchema,
  type FindingCluster,
  type MergeResult,
  type VerificationAssertion,
  type VerificationObservation,
  type VerificationRecipeStep,
  type VerificationRun,
  type VerificationRunAttempt,
} from '@qa/schemas';

interface Parser<T> {
  parse(value: unknown): T;
}

interface PayloadRow {
  readonly payload: string;
}

export interface StoredHarnessEvent {
  readonly sequence: number;
  readonly event: HarnessEvent;
}

function encode<T>(schema: Parser<T>, value: T): string {
  return JSON.stringify(schema.parse(value));
}

function decode<T>(schema: Parser<T>, row: PayloadRow | undefined, label: string): T | undefined {
  if (row === undefined) return undefined;
  try {
    return schema.parse(JSON.parse(row.payload));
  } catch (cause) {
    throw new RuntimePersistenceError(
      'PERSISTED_DATA_INVALID',
      'Persisted ' + label + ' failed contract validation',
      { cause },
    );
  }
}

function decodeMany<T>(schema: Parser<T>, rows: readonly PayloadRow[], label: string): T[] {
  return rows.map((row, index) => {
    const value = decode(schema, row, label + '[' + index + ']');
    if (value === undefined) throw new Error('Unreachable empty persisted row');
    return value;
  });
}

function* decodeRows<T>(schema: Parser<T>, rows: Iterable<PayloadRow>, label: string): Iterable<T> {
  let index = 0;
  for (const row of rows) {
    const value = decode(schema, row, label + '[' + index + ']');
    if (value === undefined) throw new Error('Unreachable empty persisted row');
    yield value;
    index += 1;
  }
}

export class SentryRepository {
  constructor(private readonly database: SentryDatabase) {}

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation);
  }

  saveProject(value: Project): void {
    const payload = encode(ProjectSchema, value);
    this.database.connection
      .prepare(
        'INSERT INTO projects(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(value.id, payload);
  }

  getProject(id: ProjectId): Project | undefined {
    const row = this.database.connection
      .prepare('SELECT payload FROM projects WHERE id=?')
      .get(id) as PayloadRow | undefined;
    return decode(ProjectSchema, row, 'Project ' + id);
  }

  listProjects(): Project[] {
    return decodeMany(
      ProjectSchema,
      this.database.connection
        .prepare('SELECT payload FROM projects ORDER BY id')
        .all() as unknown as PayloadRow[],
      'Project',
    );
  }

  deleteProject(id: ProjectId): void {
    this.database.connection.prepare('DELETE FROM projects WHERE id=?').run(id);
  }

  saveManagedCopy(value: ManagedProjectCopy): void {
    const payload = encode(ManagedProjectCopySchema, value);
    this.database.connection
      .prepare(
        'INSERT INTO managed_project_copies(project_id,state,locked_by_run_id,runtime_instance_id,payload) VALUES (?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET state=excluded.state,locked_by_run_id=excluded.locked_by_run_id,runtime_instance_id=excluded.runtime_instance_id,payload=excluded.payload',
      )
      .run(
        value.projectId,
        value.state,
        value.lockedByQARunId ?? null,
        value.runtimeInstanceId ?? null,
        payload,
      );
  }

  getManagedCopy(projectId: ProjectId): ManagedProjectCopy | undefined {
    const row = this.database.connection
      .prepare('SELECT payload FROM managed_project_copies WHERE project_id=?')
      .get(projectId) as PayloadRow | undefined;
    return decode(ManagedProjectCopySchema, row, 'ManagedProjectCopy ' + projectId);
  }

  listManagedCopiesByState(states: readonly string[]): ManagedProjectCopy[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => '?').join(',');
    const rows = this.database.connection
      .prepare('SELECT payload FROM managed_project_copies WHERE state IN (' + placeholders + ')')
      .all(...states) as unknown as PayloadRow[];
    return decodeMany(ManagedProjectCopySchema, rows, 'ManagedProjectCopy');
  }

  saveRevision(value: ProjectRevision): void {
    this.database.connection
      .prepare(
        'INSERT INTO project_revisions(id,project_id,payload) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(value.id, value.projectId, encode(ProjectRevisionSchema, value));
  }

  getRevision(id: string): ProjectRevision | undefined {
    const row = this.database.connection
      .prepare('SELECT payload FROM project_revisions WHERE id=?')
      .get(id) as PayloadRow | undefined;
    return decode(ProjectRevisionSchema, row, 'ProjectRevision ' + id);
  }

  listRevisions(projectId: ProjectId): ProjectRevision[] {
    return decodeMany(
      ProjectRevisionSchema,
      this.database.connection
        .prepare('SELECT payload FROM project_revisions WHERE project_id=? ORDER BY id')
        .all(projectId) as unknown as PayloadRow[],
      'ProjectRevision',
    );
  }

  listContexts(projectId: ProjectId): ProjectContextSnapshot[] {
    return decodeMany(
      ProjectContextSnapshotSchema,
      this.database.connection
        .prepare('SELECT payload FROM project_context_snapshots WHERE project_id=? ORDER BY id')
        .all(projectId) as unknown as PayloadRow[],
      'ProjectContextSnapshot',
    );
  }

  saveArtifact(value: Artifact): void {
    this.database.connection
      .prepare(
        'INSERT INTO artifacts(id,project_id,qa_run_id,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,project_id=excluded.project_id,qa_run_id=excluded.qa_run_id',
      )
      .run(value.id, value.projectId ?? null, value.qaRunId ?? null, encode(ArtifactSchema, value));
  }

  getArtifact(id: string): Artifact | undefined {
    const row = this.database.connection
      .prepare('SELECT payload FROM artifacts WHERE id=?')
      .get(id) as PayloadRow | undefined;
    return decode(ArtifactSchema, row, 'Artifact ' + id);
  }

  deleteArtifact(id: string): void {
    this.database.connection.prepare('DELETE FROM artifacts WHERE id=?').run(id);
  }

  listArtifacts(runId: QARunId): Artifact[] {
    return decodeMany(
      ArtifactSchema,
      this.database.connection
        .prepare('SELECT payload FROM artifacts WHERE qa_run_id=? ORDER BY id')
        .all(runId) as unknown as PayloadRow[],
      'Artifact',
    );
  }

  iterateArtifacts(runId: QARunId): Iterable<Artifact> {
    return decodeRows(
      ArtifactSchema,
      this.database.connection
        .prepare('SELECT payload FROM artifacts WHERE qa_run_id=? ORDER BY id')
        .iterate(runId) as Iterable<PayloadRow>,
      'Artifact',
    );
  }

  saveSnapshot(value: ProjectSnapshot): void {
    this.database.connection
      .prepare(
        'INSERT INTO project_snapshots(id,project_id,revision_id,manifest_artifact_id,payload) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(
        value.id,
        value.projectId,
        value.projectRevisionId,
        value.manifest.artifactId,
        encode(ProjectSnapshotSchema, value),
      );
  }

  getSnapshot(id: string): ProjectSnapshot | undefined {
    const row = this.database.connection
      .prepare('SELECT payload FROM project_snapshots WHERE id=?')
      .get(id) as PayloadRow | undefined;
    return decode(ProjectSnapshotSchema, row, 'ProjectSnapshot ' + id);
  }

  saveContext(value: ProjectContextSnapshot, materialIndexPath?: string): void {
    this.database.connection
      .prepare(
        'INSERT INTO project_context_snapshots(id,project_id,revision_id,material_index_path,payload) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,material_index_path=excluded.material_index_path',
      )
      .run(
        value.id,
        value.projectId,
        value.projectRevisionId,
        materialIndexPath ?? null,
        encode(ProjectContextSnapshotSchema, value),
      );
  }

  getContext(id: string): ProjectContextSnapshot | undefined {
    const row = this.database.connection
      .prepare('SELECT payload FROM project_context_snapshots WHERE id=?')
      .get(id) as PayloadRow | undefined;
    return decode(ProjectContextSnapshotSchema, row, 'ProjectContextSnapshot ' + id);
  }

  getContextForRevision(revisionId: string): ProjectContextSnapshot | undefined {
    const row = this.database.connection
      .prepare(
        'SELECT payload FROM project_context_snapshots WHERE revision_id=? ORDER BY id DESC LIMIT 1',
      )
      .get(revisionId) as PayloadRow | undefined;
    return decode(ProjectContextSnapshotSchema, row, 'ProjectContextSnapshot for ' + revisionId);
  }

  saveRun(value: QARun): void {
    this.database.connection
      .prepare(
        'INSERT INTO qa_runs(id,project_id,snapshot_id,context_id,status,runtime_instance_id,payload) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,runtime_instance_id=excluded.runtime_instance_id,payload=excluded.payload',
      )
      .run(
        value.id,
        value.projectId,
        value.snapshotId,
        value.projectContextSnapshotId,
        value.status,
        value.runtimeInstanceId ?? null,
        encode(QARunSchema, value),
      );
  }

  getRun(id: QARunId): QARun | undefined {
    const row = this.database.connection
      .prepare('SELECT payload FROM qa_runs WHERE id=?')
      .get(id) as PayloadRow | undefined;
    return decode(QARunSchema, row, 'QARun ' + id);
  }

  listRuns(projectId: ProjectId): QARun[] {
    return decodeMany(
      QARunSchema,
      this.database.connection
        .prepare('SELECT payload FROM qa_runs WHERE project_id=? ORDER BY id DESC')
        .all(projectId) as unknown as PayloadRow[],
      'QARun',
    );
  }

  countProjectRuns(projectId: ProjectId): number {
    const row = this.database.connection
      .prepare('SELECT COUNT(*) AS count FROM qa_runs WHERE project_id=?')
      .get(projectId) as { count: number };
    return row.count;
  }

  listNonterminalRuns(): QARun[] {
    return decodeMany(
      QARunSchema,
      this.database.connection
        .prepare(
          "SELECT payload FROM qa_runs WHERE status NOT IN ('completed','partial','failed','cancelled')",
        )
        .all() as unknown as PayloadRow[],
      'QARun',
    );
  }

  saveAgentRun(value: AgentRun): void {
    this.database.connection
      .prepare(
        'INSERT INTO agent_runs(id,qa_run_id,status,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET qa_run_id=excluded.qa_run_id,status=excluded.status,payload=excluded.payload',
      )
      .run(value.id, value.qaRunId, value.status, encode(AgentRunSchema, value));
  }

  getAgentRun(id: AgentRunId): AgentRun | undefined {
    const row = this.database.connection
      .prepare('SELECT payload FROM agent_runs WHERE id=?')
      .get(id) as PayloadRow | undefined;
    return decode(AgentRunSchema, row, 'AgentRun ' + id);
  }

  listAgentRuns(runId: QARunId): AgentRun[] {
    return decodeMany(
      AgentRunSchema,
      this.database.connection
        .prepare('SELECT payload FROM agent_runs WHERE qa_run_id=? ORDER BY id')
        .all(runId) as unknown as PayloadRow[],
      'AgentRun',
    );
  }

  countAgentRunsByStatus(runId: QARunId): ReadonlyMap<AgentRun['status'], number> {
    const rows = this.database.connection
      .prepare('SELECT status, COUNT(*) AS count FROM agent_runs WHERE qa_run_id=? GROUP BY status')
      .all(runId) as unknown as Array<{ status: AgentRun['status']; count: number }>;
    return new Map(rows.map((row) => [row.status, row.count]));
  }

  countRunFindings(runId: QARunId): number {
    return this.countRunRows('findings', runId);
  }

  countRunEvidence(runId: QARunId): number {
    return this.countRunRows('evidence', runId);
  }

  countRunActivities(runId: QARunId): number {
    return this.countRunRows('run_activities', runId);
  }

  countRunEvents(runId: QARunId): number {
    return this.countRunRows('harness_events', runId);
  }

  countRunExports(runId: QARunId): number {
    return this.countRunRows('run_exports', runId);
  }

  iterateAgentRuns(runId: QARunId): Iterable<AgentRun> {
    return decodeRows(
      AgentRunSchema,
      this.database.connection
        .prepare('SELECT payload FROM agent_runs WHERE qa_run_id=? ORDER BY id')
        .iterate(runId) as Iterable<PayloadRow>,
      'AgentRun',
    );
  }

  listNonterminalAgentRuns(): AgentRun[] {
    return decodeMany(
      AgentRunSchema,
      this.database.connection
        .prepare(
          "SELECT payload FROM agent_runs WHERE status NOT IN ('completed','failed','cancelled','timed_out','interrupted')",
        )
        .all() as unknown as PayloadRow[],
      'AgentRun',
    );
  }

  savePlan(value: AgentInvestigationPlan): void {
    this.database.connection
      .prepare(
        'INSERT INTO investigation_plans(id,qa_run_id,agent_run_id,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET qa_run_id=excluded.qa_run_id,agent_run_id=excluded.agent_run_id,payload=excluded.payload',
      )
      .run(value.id, value.qaRunId, value.agentRunId, encode(AgentInvestigationPlanSchema, value));
  }

  listPlans(runId: QARunId): AgentInvestigationPlan[] {
    return this.listRunEntity(
      'investigation_plans',
      runId,
      AgentInvestigationPlanSchema,
      'AgentInvestigationPlan',
    );
  }

  iteratePlans(runId: QARunId): Iterable<AgentInvestigationPlan> {
    return this.iterateRunEntity(
      'investigation_plans',
      runId,
      AgentInvestigationPlanSchema,
      'AgentInvestigationPlan',
    );
  }

  saveHypothesis(value: EmergentHypothesis): void {
    this.database.connection
      .prepare(
        'INSERT INTO emergent_hypotheses(id,qa_run_id,agent_run_id,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET qa_run_id=excluded.qa_run_id,agent_run_id=excluded.agent_run_id,payload=excluded.payload',
      )
      .run(value.id, value.qaRunId, value.agentRunId, encode(EmergentHypothesisSchema, value));
  }

  listHypotheses(runId: QARunId): EmergentHypothesis[] {
    return this.listRunEntity(
      'emergent_hypotheses',
      runId,
      EmergentHypothesisSchema,
      'EmergentHypothesis',
    );
  }

  iterateHypotheses(runId: QARunId): Iterable<EmergentHypothesis> {
    return this.iterateRunEntity(
      'emergent_hypotheses',
      runId,
      EmergentHypothesisSchema,
      'EmergentHypothesis',
    );
  }

  saveFinding(value: Finding): void {
    this.database.connection
      .prepare(
        'INSERT INTO findings(id,qa_run_id,agent_run_id,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET qa_run_id=excluded.qa_run_id,agent_run_id=excluded.agent_run_id,payload=excluded.payload',
      )
      .run(value.id, value.qaRunId, value.agentRunId, encode(FindingSchema, value));
  }

  listFindings(runId: QARunId): Finding[] {
    return this.listRunEntity('findings', runId, FindingSchema, 'Finding');
  }

  iterateFindings(runId: QARunId): Iterable<Finding> {
    return this.iterateRunEntity('findings', runId, FindingSchema, 'Finding');
  }

  saveEvidence(value: Evidence): void {
    this.database.connection
      .prepare(
        'INSERT INTO evidence(id,qa_run_id,agent_run_id,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET qa_run_id=excluded.qa_run_id,agent_run_id=excluded.agent_run_id,payload=excluded.payload',
      )
      .run(value.id, value.qaRunId, value.agentRunId ?? null, encode(EvidenceSchema, value));
  }

  listEvidence(runId: QARunId): Evidence[] {
    return this.listRunEntity('evidence', runId, EvidenceSchema, 'Evidence');
  }

  iterateEvidence(runId: QARunId): Iterable<Evidence> {
    return this.iterateRunEntity('evidence', runId, EvidenceSchema, 'Evidence');
  }

  saveActivity(value: RunActivity): void {
    this.database.connection
      .prepare(
        'INSERT INTO run_activities(id,qa_run_id,agent_run_id,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET qa_run_id=excluded.qa_run_id,agent_run_id=excluded.agent_run_id,payload=excluded.payload',
      )
      .run(value.id, value.qaRunId, value.agentRunId ?? null, encode(RunActivitySchema, value));
  }

  listActivities(runId: QARunId): RunActivity[] {
    return this.listRunEntity('run_activities', runId, RunActivitySchema, 'RunActivity');
  }

  iterateActivities(runId: QARunId): Iterable<RunActivity> {
    return this.iterateRunEntity('run_activities', runId, RunActivitySchema, 'RunActivity');
  }

  /** Atomic merge persistence: MergeResult + clusters + memberships +
   *  evidence links + disagreements commit together or roll back together.
   *  Callers compute the merge OUTSIDE the transaction (no long-held
   *  write lock); this method only persists. Source findings/evidence
   *  are never modified. */
  saveMergeResult(result: MergeResult, members: ReadonlyMap<string, readonly string[]>): void {
    this.transaction(() => {
      this.database.connection
        .prepare(
          'INSERT INTO merge_results(id,qa_run_id,input_digest,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET qa_run_id=excluded.qa_run_id,input_digest=excluded.input_digest,payload=excluded.payload',
        )
        .run(result.id, result.qaRunId, result.inputDigest, encode(MergeResultSchema, result));
      for (const cluster of result.clusters) {
        this.database.connection
          .prepare(
            'INSERT INTO finding_clusters(id,qa_run_id,merge_result_id,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET qa_run_id=excluded.qa_run_id,merge_result_id=excluded.merge_result_id,payload=excluded.payload',
          )
          .run(cluster.id, cluster.qaRunId, result.id, encode(FindingClusterSchema, cluster));
        const findingIds = members.get(cluster.id) ?? cluster.sourceFindingIds;
        for (const findingId of findingIds) {
          this.database.connection
            .prepare(
              'INSERT INTO finding_cluster_members(cluster_id,finding_id) VALUES (?,?) ON CONFLICT(cluster_id,finding_id) DO NOTHING',
            )
            .run(cluster.id, findingId);
        }
        for (const evidenceId of cluster.evidenceIds) {
          this.database.connection
            .prepare(
              'INSERT INTO cluster_evidence(cluster_id,evidence_id) VALUES (?,?) ON CONFLICT(cluster_id,evidence_id) DO NOTHING',
            )
            .run(cluster.id, evidenceId);
        }
        for (const disagreement of cluster.fieldDisagreements) {
          for (const [stackId, value] of Object.entries(disagreement.valuesByAgentStackId)) {
            this.database.connection
              .prepare(
                'INSERT INTO cluster_disagreements(cluster_id,field,agent_stack_id,value) VALUES (?,?,?,?) ON CONFLICT(cluster_id,field,agent_stack_id) DO UPDATE SET value=excluded.value',
              )
              .run(cluster.id, disagreement.field, stackId, value);
          }
        }
      }
    });
  }

  getMergeResult(id: string): MergeResult | undefined {
    return decode(
      MergeResultSchema,
      this.database.connection.prepare('SELECT payload FROM merge_results WHERE id=?').get(id) as
        PayloadRow | undefined,
      'MergeResult ' + id,
    );
  }

  findMergeResultByDigest(runId: QARunId, inputDigest: string): MergeResult | undefined {
    return decode(
      MergeResultSchema,
      this.database.connection
        .prepare('SELECT payload FROM merge_results WHERE qa_run_id=? AND input_digest=?')
        .get(runId, inputDigest) as PayloadRow | undefined,
      'MergeResult ' + runId + ' digest',
    );
  }

  listMergeResults(runId: QARunId): MergeResult[] {
    return decodeMany(
      MergeResultSchema,
      this.database.connection
        .prepare('SELECT payload FROM merge_results WHERE qa_run_id=? ORDER BY id')
        .all(runId) as unknown as PayloadRow[],
      'MergeResult',
    );
  }

  *iterateMergeResults(runId: QARunId): Iterable<MergeResult> {
    yield* decodeRows(
      MergeResultSchema,
      this.database.connection
        .prepare('SELECT payload FROM merge_results WHERE qa_run_id=? ORDER BY id')
        .iterate(runId) as Iterable<PayloadRow>,
      'MergeResult',
    );
  }

  *iterateClusters(mergeResultId: string): Iterable<FindingCluster> {
    yield* decodeRows(
      FindingClusterSchema,
      this.database.connection
        .prepare('SELECT payload FROM finding_clusters WHERE merge_result_id=? ORDER BY id')
        .iterate(mergeResultId) as Iterable<PayloadRow>,
      'FindingCluster',
    );
  }

  listClusters(mergeResultId: string): FindingCluster[] {
    return decodeMany(
      FindingClusterSchema,
      this.database.connection
        .prepare('SELECT payload FROM finding_clusters WHERE merge_result_id=? ORDER BY id')
        .all(mergeResultId) as unknown as PayloadRow[],
      'FindingCluster',
    );
  }

  /** Verification persistence: runs/attempts upsert by id (incremental
   *  durability); steps/observations/assertions are insert-only per
   *  attempt. Completed attempts are never updated — finalization
   *  writes the completed payload once via saveVerificationAttempt.
   *  Status transitions go through saveVerificationRun/saveStepState. */
  saveVerificationRun(value: VerificationRun): void {
    this.database.connection
      .prepare(
        'INSERT INTO verification_runs(id,merge_result_id,qa_run_id,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(value.id, value.mergeResultId, value.qaRunId, encode(VerificationRunSchema, value));
  }

  getVerificationRun(id: string): VerificationRun | undefined {
    return decode(
      VerificationRunSchema,
      this.database.connection
        .prepare('SELECT payload FROM verification_runs WHERE id=?')
        .get(id) as PayloadRow | undefined,
      'VerificationRun ' + id,
    );
  }

  listVerificationRuns(mergeResultId: string): VerificationRun[] {
    return decodeMany(
      VerificationRunSchema,
      this.database.connection
        .prepare('SELECT payload FROM verification_runs WHERE merge_result_id=? ORDER BY id')
        .all(mergeResultId) as unknown as PayloadRow[],
      'VerificationRun',
    );
  }

  saveVerificationAttempt(value: VerificationRunAttempt): void {
    // verification_run_id stays in the SET clause so the ownership
    // trigger loudly rejects re-homing (column and payload can never
    // silently diverge). Same pattern as the finding/agent ownership.
    this.database.connection
      .prepare(
        'INSERT INTO verification_attempts(id,verification_run_id,finding_cluster_id,status,payload) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET verification_run_id=excluded.verification_run_id,status=excluded.status,payload=excluded.payload',
      )
      .run(
        value.id,
        value.verificationRunId,
        value.findingClusterId,
        value.status,
        encode(VerificationRunAttemptSchema, value),
      );
  }

  getVerificationAttempt(id: string): VerificationRunAttempt | undefined {
    return decode(
      VerificationRunAttemptSchema,
      this.database.connection
        .prepare('SELECT payload FROM verification_attempts WHERE id=?')
        .get(id) as PayloadRow | undefined,
      'VerificationAttempt ' + id,
    );
  }

  listVerificationAttempts(verificationRunId: string): VerificationRunAttempt[] {
    return decodeMany(
      VerificationRunAttemptSchema,
      this.database.connection
        .prepare(
          'SELECT payload FROM verification_attempts WHERE verification_run_id=? ORDER BY id',
        )
        .all(verificationRunId) as unknown as PayloadRow[],
      'VerificationRunAttempt',
    );
  }

  saveVerificationStep(attemptId: string, value: VerificationRecipeStep): void {
    this.database.connection
      .prepare(
        'INSERT INTO verification_steps(id,verification_attempt_id,type,status,payload) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET type=excluded.type,status=excluded.status,payload=excluded.payload',
      )
      .run(
        value.id,
        attemptId,
        value.type,
        value.status,
        encode(VerificationRecipeStepSchema, value),
      );
  }

  listVerificationSteps(attemptId: string): VerificationRecipeStep[] {
    return decodeMany(
      VerificationRecipeStepSchema,
      this.database.connection
        .prepare(
          'SELECT payload FROM verification_steps WHERE verification_attempt_id=? ORDER BY id',
        )
        .all(attemptId) as unknown as PayloadRow[],
      'VerificationStep',
    );
  }

  saveVerificationObservation(attemptId: string, value: VerificationObservation): void {
    this.database.connection
      .prepare(
        'INSERT INTO verification_observations(id,verification_attempt_id,step_id,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING',
      )
      .run(value.id, attemptId, value.stepId, encode(VerificationObservationSchema, value));
  }

  listVerificationObservations(attemptId: string): VerificationObservation[] {
    return decodeMany(
      VerificationObservationSchema,
      this.database.connection
        .prepare(
          'SELECT payload FROM verification_observations WHERE verification_attempt_id=? ORDER BY id',
        )
        .all(attemptId) as unknown as PayloadRow[],
      'VerificationObservation',
    );
  }

  saveVerificationAssertion(attemptId: string, value: VerificationAssertion): void {
    this.database.connection
      .prepare(
        'INSERT INTO verification_assertions(verification_attempt_id,subject,payload) VALUES (?,?,?) ON CONFLICT(verification_attempt_id,subject) DO UPDATE SET payload=excluded.payload',
      )
      .run(attemptId, value.subject, encode(VerificationAssertionSchema, value));
  }

  listVerificationAssertions(attemptId: string): VerificationAssertion[] {
    return decodeMany(
      VerificationAssertionSchema,
      this.database.connection
        .prepare(
          'SELECT payload FROM verification_assertions WHERE verification_attempt_id=? ORDER BY subject',
        )
        .all(attemptId) as unknown as PayloadRow[],
      'VerificationAssertion',
    );
  }

  *iterateVerificationAttempts(verificationRunId: string): Iterable<VerificationRunAttempt> {
    yield* decodeRows(
      VerificationRunAttemptSchema,
      this.database.connection
        .prepare(
          'SELECT payload FROM verification_attempts WHERE verification_run_id=? ORDER BY id',
        )
        .iterate(verificationRunId) as Iterable<PayloadRow>,
      'VerificationRunAttempt',
    );
  }

  saveExport(value: RunExportManifest): void {
    this.database.connection
      .prepare(
        'INSERT INTO run_exports(qa_run_id,format,artifact_id,payload) VALUES (?,?,?,?) ON CONFLICT(qa_run_id,format) DO UPDATE SET artifact_id=excluded.artifact_id,payload=excluded.payload',
      )
      .run(value.qaRunId, value.format, value.artifactId, encode(RunExportManifestSchema, value));
  }

  listExports(runId: QARunId): RunExportManifest[] {
    return this.listRunEntity('run_exports', runId, RunExportManifestSchema, 'RunExportManifest');
  }

  appendHarnessEvent(runId: QARunId, event: HarnessEvent): number {
    return this.database.transaction(() => this.appendHarnessEventWithinTransaction(runId, event));
  }

  appendHarnessEventWithinTransaction(runId: QARunId, event: HarnessEvent): number {
    const payload = encode(HarnessEventSchema, event);
    const row = this.database.connection
      .prepare(
        'SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM harness_events WHERE agent_run_id=?',
      )
      .get(event.agentRunId) as { sequence: number };
    try {
      this.database.connection
        .prepare(
          'INSERT INTO harness_events(agent_run_id,sequence,event_id,qa_run_id,payload) VALUES (?,?,?,?,?)',
        )
        .run(event.agentRunId, row.sequence, event.eventId, runId, payload);
    } catch (cause) {
      const code =
        typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : '';
      const message = cause instanceof Error ? cause.message : '';
      if (
        code.includes('CONSTRAINT') ||
        message.includes('UNIQUE constraint failed: harness_events')
      ) {
        throw new RuntimePersistenceError(
          'EVENT_CONFLICT',
          'Harness event identity or sequence conflicts with persisted history',
          { cause },
        );
      }
      throw cause;
    }
    return row.sequence;
  }

  listAgentEvents(agentRunId: AgentRunId): StoredHarnessEvent[] {
    const rows = this.database.connection
      .prepare('SELECT sequence,payload FROM harness_events WHERE agent_run_id=? ORDER BY sequence')
      .all(agentRunId) as Array<{ sequence: number; payload: string }>;
    return rows.map((row) => {
      const event = decode(
        HarnessEventSchema,
        row,
        'HarnessEvent ' + agentRunId + '#' + row.sequence,
      );
      if (event === undefined) throw new Error('Unreachable empty event row');
      return { sequence: row.sequence, event };
    });
  }

  listRunEvents(runId: QARunId): StoredHarnessEvent[] {
    const rows = this.database.connection
      .prepare(
        'SELECT sequence,payload FROM harness_events WHERE qa_run_id=? ORDER BY agent_run_id,sequence',
      )
      .all(runId) as Array<{ sequence: number; payload: string }>;
    return rows.map((row, index) => {
      const event = decode(HarnessEventSchema, row, 'HarnessEvent ' + runId + '[' + index + ']');
      if (event === undefined) throw new Error('Unreachable empty event row');
      return { sequence: row.sequence, event };
    });
  }

  *iterateRunEvents(runId: QARunId): Iterable<StoredHarnessEvent> {
    const rows = this.database.connection
      .prepare(
        'SELECT sequence,payload FROM harness_events WHERE qa_run_id=? ORDER BY agent_run_id,sequence',
      )
      .iterate(runId) as Iterable<{ sequence: number; payload: string }>;
    let index = 0;
    for (const row of rows) {
      const event = decode(HarnessEventSchema, row, 'HarnessEvent ' + runId + '[' + index + ']');
      if (event === undefined) throw new Error('Unreachable empty event row');
      yield { sequence: row.sequence, event };
      index += 1;
    }
  }

  saveRuntimeInstance(value: RuntimeInstance): void {
    this.database.connection
      .prepare(
        'INSERT INTO runtime_instances(id,process_id,started_at,heartbeat_at,released_at,payload) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at,released_at=excluded.released_at,payload=excluded.payload',
      )
      .run(
        value.id,
        value.processId,
        value.startedAt,
        value.heartbeatAt,
        value.releasedAt ?? null,
        encode(RuntimeInstanceSchema, value),
      );
  }

  getRuntimeInstance(id: RuntimeInstanceId): RuntimeInstance | undefined {
    const row = this.database.connection
      .prepare('SELECT payload FROM runtime_instances WHERE id=?')
      .get(id) as PayloadRow | undefined;
    return decode(RuntimeInstanceSchema, row, 'RuntimeInstance ' + id);
  }

  saveRuntimeOperation(value: RuntimeOperation): void {
    this.database.connection
      .prepare(
        'INSERT INTO runtime_operations(id,project_id,runtime_instance_id,type,stage,payload) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET runtime_instance_id=excluded.runtime_instance_id,stage=excluded.stage,payload=excluded.payload',
      )
      .run(
        value.id,
        value.projectId,
        value.runtimeInstanceId,
        value.type,
        value.stage,
        encode(RuntimeOperationSchema, value),
      );
  }

  listRuntimeOperations(): RuntimeOperation[] {
    return decodeMany(
      RuntimeOperationSchema,
      this.database.connection
        .prepare('SELECT payload FROM runtime_operations ORDER BY id')
        .all() as unknown as PayloadRow[],
      'RuntimeOperation',
    );
  }

  deleteRuntimeOperation(id: string): void {
    this.database.connection.prepare('DELETE FROM runtime_operations WHERE id=?').run(id);
  }

  agentProducedUsableOutput(agentRunId: AgentRunId): boolean {
    const row = this.database.connection
      .prepare(
        'SELECT (SELECT COUNT(*) FROM findings WHERE agent_run_id=?) + (SELECT COUNT(*) FROM evidence WHERE agent_run_id=?) AS count',
      )
      .get(agentRunId, agentRunId) as { count: number };
    return row.count > 0;
  }

  private listRunEntity<T>(table: string, runId: QARunId, schema: Parser<T>, label: string): T[] {
    const allowed = new Set([
      'investigation_plans',
      'emergent_hypotheses',
      'findings',
      'evidence',
      'run_activities',
      'run_exports',
    ]);
    if (!allowed.has(table)) throw new TypeError('Unsupported repository table');
    const rows = this.database.connection
      .prepare('SELECT payload FROM ' + table + ' WHERE qa_run_id=? ORDER BY rowid')
      .all(runId) as unknown as PayloadRow[];
    return decodeMany(schema, rows, label);
  }

  private countRunRows(table: string, runId: QARunId): number {
    const allowed = new Set([
      'findings',
      'evidence',
      'run_activities',
      'harness_events',
      'run_exports',
    ]);
    if (!allowed.has(table)) throw new TypeError('Unsupported repository table');
    const row = this.database.connection
      .prepare('SELECT COUNT(*) AS count FROM ' + table + ' WHERE qa_run_id=?')
      .get(runId) as { count: number };
    return row.count;
  }

  private iterateRunEntity<T>(
    table: string,
    runId: QARunId,
    schema: Parser<T>,
    label: string,
  ): Iterable<T> {
    const allowed = new Set([
      'investigation_plans',
      'emergent_hypotheses',
      'findings',
      'evidence',
      'run_activities',
    ]);
    if (!allowed.has(table)) throw new TypeError('Unsupported repository table');
    return decodeRows(
      schema,
      this.database.connection
        .prepare('SELECT payload FROM ' + table + ' WHERE qa_run_id=? ORDER BY rowid')
        .iterate(runId) as Iterable<PayloadRow>,
      label,
    );
  }
}
