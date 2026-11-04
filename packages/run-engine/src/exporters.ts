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

function section(name: string, values: Iterable<unknown>, comma: boolean): AsyncIterable<string> {
  return (async function* (): AsyncGenerator<string> {
    yield JSON.stringify(name) + ':[';
    let index = 0;
    for (const value of values) {
      if (index > 0) yield ',';
      yield JSON.stringify(value);
      index += 1;
    }
    yield ']' + (comma ? ',' : '');
  })();
}

export interface RunExportContent {
  readonly filename: string;
  readonly mimeType: string;
  readonly format: 'log' | 'json';
  readonly sizeBytes: number;
  readonly contentBase64: string;
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
    // Exports are cached per (run, format). Execution data is immutable once
    // the run is terminal, so a cached export never goes stale.
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

  /** Canonical export bytes for a trusted Save As transfer.
   *  Always derived from export() above — never from caller-supplied
   *  paths — so redaction, ordering and historical sections stay
   *  identical to the internal artifact. Transfers are uncapped: run
   *  exports are small relative to desktop memory, and a partial-bytes
   *  failure mode would be worse than a large allocation. */
  async exportContent(runId: QARunId, format: 'log' | 'json'): Promise<RunExportContent> {
    const manifest = await this.export(runId, format);
    const artifact = this.repository.getArtifact(manifest.artifactId);
    if (artifact === undefined) {
      throw new Error('EXPORT_ARTIFACT_MISSING: ' + manifest.artifactId);
    }
    const stream = this.artifacts.open(artifact);
    const chunks: Buffer[] = [];
    let sizeBytes = 0;
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer | string) => {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        sizeBytes += buffer.byteLength;
        chunks.push(buffer);
      });
      stream.on('end', () => resolve());
      stream.on('error', (cause: unknown) => reject(cause));
    });
    return {
      filename: 'sentry-' + runId + '.' + format,
      mimeType: format === 'log' ? 'text/plain' : 'application/json',
      format,
      sizeBytes,
      contentBase64: Buffer.concat(chunks).toString('base64'),
    };
  }

  private async *logSource(runId: QARunId): AsyncGenerator<string> {
    const run = this.repository.getRun(runId);
    if (run === undefined) return;
    yield '[' +
      run.createdAt +
      '] [SENTRY] ' +
      (run.executionKind === 'production' ? 'REAL AGENT RUN' : 'SIMULATED / FAKE HARNESS RUN') +
      ' created\n';
    for (const stored of this.repository.iterateRunEvents(runId)) yield eventLogLine(stored);
    // Independent-agents product: the human log leads with one block per
    // agent (never a merged/deduplicated view).
    const logAt = nowIsoTimestamp();
    yield `[${logAt}] [SENTRY] ${run.mode.toUpperCase()} QA RUN — independent agent results\n`;
    for (const agentRun of this.repository.iterateAgentRuns(runId)) {
      const agentFindings = [...this.repository.iterateFindings(runId)].filter(
        (finding) => finding.agentRunId === agentRun.id,
      );
      yield `[${logAt}] [SENTRY] Agent ${agentRun.agentStackId} (${agentRun.status}): ${agentFindings.length} finding${agentFindings.length === 1 ? '' : 's'}\n`;
      for (const finding of agentFindings) {
        yield `[${logAt}] [SENTRY] Finding [${finding.severity.toUpperCase()}] ${finding.title}\n`;
      }
    }
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
    const exportKind = run.executionKind === 'production' ? 'sentry.agent-run' : 'sentry.fake-run';
    yield '{"schemaVersion":1,"exportKind":' +
      JSON.stringify(exportKind) +
      ',"qaRun":' +
      JSON.stringify(run) +
      ',';
    yield '"projectRevision":' + JSON.stringify(revision ?? null) + ',';
    yield '"projectSnapshot":' + JSON.stringify(snapshot ?? null) + ',';
    yield '"projectContextSnapshot":' + JSON.stringify(context ?? null) + ',';
    for await (const part of section('agentRuns', this.repository.iterateAgentRuns(runId), true))
      yield part;
    for await (const part of section(
      'investigationPlans',
      this.repository.iteratePlans(runId),
      true,
    ))
      yield part;
    for await (const part of section(
      'emergentHypotheses',
      this.repository.iterateHypotheses(runId),
      true,
    ))
      yield part;
    for await (const part of section(
      'runActivities',
      this.repository.iterateActivities(runId),
      true,
    ))
      yield part;
    for await (const part of section(
      'harnessEvents',
      this.repository.iterateRunEvents(runId),
      true,
    ))
      yield part;
    for await (const part of section('findings', this.repository.iterateFindings(runId), true))
      yield part;
    for await (const part of section('evidence', this.repository.iterateEvidence(runId), true))
      yield part;
    // Giant artifacts are never inlined — only metadata rows and records.
    const targetSpec = this.repository.getTargetSpec(runId);
    for await (const part of section(
      'targetSpecs',
      targetSpec === undefined ? [] : [targetSpec],
      true,
    ))
      yield part;
    for await (const part of section('artifacts', this.repository.iterateArtifacts(runId), false))
      yield part;
    yield '}';
  }
}
