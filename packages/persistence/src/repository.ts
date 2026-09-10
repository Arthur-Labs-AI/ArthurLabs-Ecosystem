import type { AgentRunId, ProjectId, QARunId } from '@qa/shared';
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
} from '@qa/schemas';
import type { SentryDatabase } from './database.js';
import { RuntimePersistenceError } from './errors.js';

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
        'INSERT INTO managed_project_copies(project_id,state,locked_by_run_id,payload) VALUES (?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET state=excluded.state,locked_by_run_id=excluded.locked_by_run_id,payload=excluded.payload',
      )
      .run(value.projectId, value.state, value.lockedByQARunId ?? null, payload);
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
        'INSERT INTO qa_runs(id,project_id,snapshot_id,context_id,status,payload) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload',
      )
      .run(
        value.id,
        value.projectId,
        value.snapshotId,
        value.projectContextSnapshotId,
        value.status,
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
        'INSERT INTO agent_runs(id,qa_run_id,status,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload',
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
        'INSERT INTO investigation_plans(id,qa_run_id,agent_run_id,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
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

  saveHypothesis(value: EmergentHypothesis): void {
    this.database.connection
      .prepare(
        'INSERT INTO emergent_hypotheses(id,qa_run_id,agent_run_id,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
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

  saveFinding(value: Finding): void {
    this.database.connection
      .prepare(
        'INSERT INTO findings(id,qa_run_id,agent_run_id,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(value.id, value.qaRunId, value.agentRunId, encode(FindingSchema, value));
  }

  listFindings(runId: QARunId): Finding[] {
    return this.listRunEntity('findings', runId, FindingSchema, 'Finding');
  }

  saveEvidence(value: Evidence): void {
    this.database.connection
      .prepare(
        'INSERT INTO evidence(id,qa_run_id,agent_run_id,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(value.id, value.qaRunId, value.agentRunId ?? null, encode(EvidenceSchema, value));
  }

  listEvidence(runId: QARunId): Evidence[] {
    return this.listRunEntity('evidence', runId, EvidenceSchema, 'Evidence');
  }

  saveActivity(value: RunActivity): void {
    this.database.connection
      .prepare(
        'INSERT INTO run_activities(id,qa_run_id,agent_run_id,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(value.id, value.qaRunId, value.agentRunId ?? null, encode(RunActivitySchema, value));
  }

  listActivities(runId: QARunId): RunActivity[] {
    return this.listRunEntity('run_activities', runId, RunActivitySchema, 'RunActivity');
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
    const payload = encode(HarnessEventSchema, event);
    return this.database.transaction(() => {
      const row = this.database.connection
        .prepare(
          'SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM harness_events WHERE agent_run_id=?',
        )
        .get(event.agentRunId) as { sequence: number };
      this.database.connection
        .prepare(
          'INSERT INTO harness_events(agent_run_id,sequence,event_id,qa_run_id,payload) VALUES (?,?,?,?,?)',
        )
        .run(event.agentRunId, row.sequence, event.eventId, runId, payload);
      return row.sequence;
    });
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
}
