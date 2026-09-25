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
    // Exports are cached per (run, format), but a merge computed AFTER the
    // cached export would otherwise be omitted forever. Regenerate only
    // when merge state is newer than the cached artifact; execution data
    // is immutable once the run is terminal, so merges are the sole
    // staleness source. The superseded artifact is removed AFTER the new
    // manifest lands: the old manifest row still references it until the
    // upsert, so deletion must come second. Old exports are superseded,
    // never mutated.
    const superseded =
      existing !== undefined && this.repository.getArtifact(existing.artifactId) !== undefined
        ? existing
        : undefined;
    if (superseded !== undefined && !this.isExportStale(runId, superseded.createdAt)) {
      return superseded;
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
    if (superseded !== undefined && superseded.artifactId !== artifact.id) {
      // Drop only the superseded metadata row: both artifacts share the
      // same stable file path (already overwritten with new content),
      // so byte deletion would destroy the fresh export. FK-safe now
      // that the manifest upsert no longer references the old row.
      this.repository.deleteArtifact(superseded.artifactId);
    }
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

  /** An export is stale when a merge, verification, issue ingest, or
   *  retest assessment touching this run was persisted after it. Run
   *  execution data is immutable once terminal, so these are the only
   *  staleness sources. String comparison is safe: all timestamps are
   *  canonical ISO-8601 UTC with fixed width. */
  private isExportStale(runId: QARunId, exportedAt: string): boolean {
    for (const merge of this.repository.iterateMergeResults(runId)) {
      if (merge.createdAt > exportedAt) return true;
      for (const verificationRun of this.repository.listVerificationRuns(merge.id)) {
        if (verificationRun.createdAt > exportedAt) return true;
      }
    }
    for (const occurrence of this.repository.listOccurrencesForRun(runId)) {
      if (occurrence.createdAt > exportedAt) return true;
      for (const event of this.repository.listIssueEvents(occurrence.issueId)) {
        if (event.createdAt > exportedAt) return true;
      }
      for (const assessment of this.repository.listRetestAssessments(occurrence.issueId)) {
        if (assessment.assessedAt > exportedAt) return true;
      }
    }
    return false;
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
    // agent (never a merged/deduplicated view). Merge / verification /
    // issue sections below only appear when historical rows exist.
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
    for (const merge of this.repository.iterateMergeResults(runId)) {
      const at = nowIsoTimestamp();
      const clusters = [...this.repository.iterateClusters(merge.id)];
      yield `[${at}] [SENTRY] Merge result ${merge.id} (${clusters.length} clusters)\n`;
      for (const cluster of clusters) yield* this.mergeClusterLines(at, cluster);
      for (const verificationRun of this.repository.listVerificationRuns(merge.id)) {
        yield* this.verificationRunLines(at, verificationRun.id);
      }
    }
    yield* this.issueLineageLines(runId);
    yield '[' +
      (run.completedAt ?? nowIsoTimestamp()) +
      '] [SENTRY] Run status: ' +
      run.status +
      '\n';
  }

  /** Human lineage rendering (§81): one block per issue observed on this
   *  run — first-seen revision and mode, then each retest crossing. */
  private *issueLineageLines(runId: QARunId): Generator<string> {
    const at = nowIsoTimestamp();
    for (const occurrence of this.repository.listOccurrencesForRun(runId)) {
      const issue = this.repository.getIssue(occurrence.issueId);
      if (issue === undefined) continue;
      const sourceRun = this.repository.getRun(occurrence.qaRunId);
      yield `[${at}] [SENTRY] Issue: ${issue.id} (${issue.title})\n`;
      yield `[${at}] [SENTRY] First seen: revision ${occurrence.projectRevisionId} ` +
        `${sourceRun?.mode ?? 'unknown'} run ${occurrence.qaRunId}\n`;
      for (const assessment of this.repository.listRetestAssessments(issue.id)) {
        yield `[${at}] [SENTRY] Retest: revision ${assessment.targetRevisionId} ` +
          `${assessment.result.toUpperCase().replace(/_/g, ' ')}\n`;
      }
    }
  }

  /** Log rendering keeps agreement visibly separate from verification
   *  (§72): support lists come from the cluster, outcomes only from
   *  fresh verification observations. */
  private *verificationRunLines(at: string, verificationRunId: string): Generator<string> {
    for (const attempt of this.repository.iterateVerificationAttempts(verificationRunId)) {
      const outcome = (attempt.outcome ?? 'pending').toUpperCase().replace(/_/g, ' ');
      yield `[${at}] [SENTRY] Verification\n`;
      yield `[${at}] [SENTRY] Cluster: ${attempt.findingClusterId}\n`;
      yield `[${at}] [SENTRY] Outcome: ${outcome}\n`;
      for (const assertion of this.repository.listVerificationAssertions(attempt.id)) {
        const mark =
          assertion.state === 'confirmed' ? '✓' : assertion.state === 'contradicted' ? '✗' : '?';
        yield `[${at}] [SENTRY] ${mark} ${assertion.subject}: ${assertion.detail}\n`;
      }
      const observations = this.repository.listVerificationObservations(attempt.id);
      yield `[${at}] [SENTRY] Verification: ${observations.length} fresh observation${observations.length === 1 ? '' : 's'}\n`;
    }
  }

  private *mergeClusterLines(
    at: string,
    cluster: {
      readonly id: string;
      readonly agreementState: string;
      readonly sourceAgentStackIds: readonly string[];
      readonly unavailableAgentStackIds: readonly string[];
      readonly sourceFindingIds: readonly string[];
      readonly evidenceIds: readonly string[];
      readonly representativeFindingId: string;
      readonly fieldDisagreements: ReadonlyArray<{
        readonly field: string;
        readonly valuesByAgentStackId: Readonly<Record<string, string>>;
      }>;
    },
  ): Generator<string> {
    const reported = [...new Set(cluster.sourceAgentStackIds)].sort();
    yield `[${at}] [SENTRY] Cluster ${cluster.id} [${cluster.agreementState}] support=${reported.join(',') || '(none)'}\n`;
    const unavailable =
      cluster.unavailableAgentStackIds.length > 0
        ? cluster.unavailableAgentStackIds.join(',')
        : '(none unavailable)';
    yield `[${at}] [SENTRY] Not reported is not disagreement; unavailable: ${unavailable}\n`;
    const severities = cluster.fieldDisagreements.find((d) => d.field === 'severity');
    if (severities !== undefined) {
      const parts = Object.entries(severities.valuesByAgentStackId)
        .map(([stack, value]) => `${stack}: ${value}`)
        .join('; ');
      yield `[${at}] [SENTRY] Severity reports: ${parts}\n`;
    }
    yield `[${at}] [SENTRY] Source findings: ${cluster.sourceFindingIds.join(',')}; evidence: ${cluster.evidenceIds.join(',') || '(none)'}\n`;
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
    for await (const part of section(
      'mergeResults',
      this.repository.iterateMergeResults(runId),
      true,
    ))
      yield part;
    const clusterDocs: unknown[] = [];
    for (const merge of this.repository.iterateMergeResults(runId)) {
      for (const cluster of this.repository.iterateClusters(merge.id)) clusterDocs.push(cluster);
    }
    for await (const part of section('findingClusters', clusterDocs, true)) yield part;
    // Verification sections are additive; absent when nothing verified.
    const verificationRuns: unknown[] = [];
    const verificationAttempts: unknown[] = [];
    const verificationObservations: unknown[] = [];
    const verificationAssertions: unknown[] = [];
    for (const merge of this.repository.iterateMergeResults(runId)) {
      for (const verificationRun of this.repository.listVerificationRuns(merge.id)) {
        verificationRuns.push(verificationRun);
        for (const attempt of this.repository.iterateVerificationAttempts(verificationRun.id)) {
          verificationAttempts.push(attempt);
          for (const observation of this.repository.listVerificationObservations(attempt.id)) {
            verificationObservations.push(observation);
          }
          for (const assertion of this.repository.listVerificationAssertions(attempt.id)) {
            verificationAssertions.push(assertion);
          }
        }
      }
    }
    for await (const part of section('verificationRuns', verificationRuns, true)) yield part;
    for await (const part of section('verificationAttempts', verificationAttempts, true))
      yield part;
    for await (const part of section('verificationObservations', verificationObservations, true))
      yield part;
    for await (const part of section('verificationAssertions', verificationAssertions, true))
      yield part;
    // Phase 7 lineage sections are additive; absent when nothing ingested.
    // Giant artifacts are never inlined — only metadata rows and records.
    const targetSpec = this.repository.getTargetSpec(runId);
    for await (const part of section(
      'targetSpecs',
      targetSpec === undefined ? [] : [targetSpec],
      true,
    ))
      yield part;
    const occurrences = this.repository.listOccurrencesForRun(runId);
    for await (const part of section('issueOccurrences', occurrences, true)) yield part;
    const issueIds = [...new Set(occurrences.map((occurrence) => occurrence.issueId))];
    const issues: unknown[] = [];
    const issueEvents: unknown[] = [];
    const retestRuns: unknown[] = [];
    const retestAssessments: unknown[] = [];
    for (const issueId of issueIds) {
      const issue = this.repository.getIssue(issueId);
      if (issue !== undefined) issues.push(issue);
      for (const event of this.repository.listIssueEvents(issueId)) issueEvents.push(event);
      for (const retest of this.repository.listRetestRuns(issueId)) retestRuns.push(retest);
      for (const assessment of this.repository.listRetestAssessments(issueId))
        retestAssessments.push(assessment);
    }
    for await (const part of section('issues', issues, true)) yield part;
    for await (const part of section('issueEvents', issueEvents, true)) yield part;
    for await (const part of section('retestRuns', retestRuns, true)) yield part;
    for await (const part of section('retestAssessments', retestAssessments, true)) yield part;
    for await (const part of section('artifacts', this.repository.iterateArtifacts(runId), false))
      yield part;
    yield '}';
  }
}
