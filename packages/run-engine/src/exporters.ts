import { nowIsoTimestamp, type QARunId } from '@qa/shared';
import { RunExportManifestSchema, type RunExportManifest } from '@qa/schemas';
import {
  FilesystemArtifactStore,
  runDataPaths,
  type SentryRepository,
  type StoredHarnessEvent,
} from '@qa/persistence';

function eventLogLine(stored: StoredHarnessEvent): string {
  const event = stored.event;
  let message: string;
  switch (event.type) {
    case 'run.started':
      message = 'Run started';
      break;
    case 'investigation.plan.created':
      message = 'Investigation plan created';
      break;
    case 'tool.started':
      message = 'Tool started: ' + event.tool.name;
      break;
    case 'tool.completed':
      message = 'Tool completed: ' + event.tool.name;
      break;
    case 'test.result':
      message = 'Test result: ' + (event.suite ?? 'unnamed');
      break;
    case 'finding.submitted':
      message = 'Finding submitted: ' + event.finding.title;
      break;
    case 'evidence.submitted':
      message = 'Evidence submitted';
      break;
    case 'run.completed':
      message = 'Run completed';
      break;
    case 'run.failed':
      message = 'Run failed: ' + event.failure.message;
      break;
    case 'run.cancelled':
      message = 'Run cancelled';
      break;
    case 'warning':
      message = 'Warning: ' + event.message;
      break;
    default:
      message = event.type;
  }
  return (
    '[' +
    event.timestamp +
    '] [' +
    event.agentRunId +
    '] [' +
    stored.sequence +
    '] ' +
    message +
    '\n'
  );
}

function section(name: string, values: readonly unknown[], comma: boolean): AsyncIterable<string> {
  return (async function* (): AsyncGenerator<string> {
    yield JSON.stringify(name) + ':[';
    for (let index = 0; index < values.length; index += 1) {
      if (index > 0) yield ',';
      yield JSON.stringify(values[index]);
    }
    yield ']' + (comma ? ',' : '');
  })();
}

export class RunExporter {
  private readonly artifacts: FilesystemArtifactStore;

  constructor(
    private readonly dataRoot: string,
    private readonly repository: SentryRepository,
  ) {
    this.artifacts = new FilesystemArtifactStore(dataRoot, repository);
  }

  async export(runId: QARunId, format: 'log' | 'json'): Promise<RunExportManifest> {
    const run = this.repository.getRun(runId);
    if (run === undefined) throw new Error('RUN_NOT_FOUND: ' + runId);
    const existing = this.repository.listExports(runId).find((item) => item.format === format);
    if (existing !== undefined && this.repository.getArtifact(existing.artifactId) !== undefined) {
      return existing;
    }
    const runPaths = runDataPaths(this.dataRoot, run.projectId, runId);
    const absolute = runPaths.exports + '/run.' + format;
    const relativePath = absolute
      .slice(this.dataRoot.length)
      .replace(/^[\\/]+/, '')
      .replaceAll('\\', '/');
    const artifact = await this.artifacts.write({
      relativePath,
      type: format === 'log' ? 'log' : 'json',
      source: format === 'log' ? this.logSource(runId) : this.jsonSource(runId),
      projectId: run.projectId,
      qaRunId: runId,
      mimeType: format === 'log' ? 'text/plain' : 'application/json',
    });
    const manifest = RunExportManifestSchema.parse({
      schemaVersion: 1,
      qaRunId: runId,
      format,
      artifactId: artifact.id,
      createdAt: nowIsoTimestamp(),
    });
    this.repository.saveExport(manifest);
    return manifest;
  }

  private async *logSource(runId: QARunId): AsyncGenerator<string> {
    const run = this.repository.getRun(runId);
    if (run === undefined) return;
    yield '[' + run.createdAt + '] [SENTRY] SIMULATED / FAKE HARNESS RUN created\n';
    for (const stored of this.repository.listRunEvents(runId)) yield eventLogLine(stored);
    yield '[' +
      (run.completedAt ?? nowIsoTimestamp()) +
      '] [SENTRY] Run status: ' +
      run.status +
      '\n';
  }

  private async *jsonSource(runId: QARunId): AsyncGenerator<string> {
    const run = this.repository.getRun(runId);
    if (run === undefined) return;
    const snapshot = this.repository.getSnapshot(run.snapshotId);
    const revision =
      snapshot === undefined ? undefined : this.repository.getRevision(snapshot.projectRevisionId);
    const context = this.repository.getContext(run.projectContextSnapshotId);
    yield '{"schemaVersion":1,"exportKind":"sentry.fake-run","qaRun":' + JSON.stringify(run) + ',';
    yield '"projectRevision":' + JSON.stringify(revision ?? null) + ',';
    yield '"projectSnapshot":' + JSON.stringify(snapshot ?? null) + ',';
    yield '"projectContextSnapshot":' + JSON.stringify(context ?? null) + ',';
    for await (const part of section('agentRuns', this.repository.listAgentRuns(runId), true))
      yield part;
    for await (const part of section('investigationPlans', this.repository.listPlans(runId), true))
      yield part;
    for await (const part of section(
      'emergentHypotheses',
      this.repository.listHypotheses(runId),
      true,
    ))
      yield part;
    for await (const part of section('runActivities', this.repository.listActivities(runId), true))
      yield part;
    for await (const part of section('harnessEvents', this.repository.listRunEvents(runId), true))
      yield part;
    for await (const part of section('findings', this.repository.listFindings(runId), true))
      yield part;
    for await (const part of section('evidence', this.repository.listEvidence(runId), true))
      yield part;
    for await (const part of section('artifacts', this.repository.listArtifacts(runId), false))
      yield part;
    yield '}';
  }
}
