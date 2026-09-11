import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  createEvidenceId,
  createFindingId,
  createHarnessEventId,
  createInvestigationHypothesisId,
  createInvestigationPlanId,
  createOperationId,
  nowIsoTimestamp,
  type AgentRunId,
  type OperationId,
} from '@qa/shared';
import {
  EvidenceSchema,
  FindingSchema,
  HarnessEventSchema,
  SentryAgentResultV1Schema,
  SentryInvestigationPlanV1Schema,
  type AgentUsage,
  type Evidence,
  type HarnessEvent,
  type HarnessRunRequest,
  type SentryAgentEvidenceV1,
} from '@qa/schemas';
import type { HarnessAdapter, HarnessHealthResult, HarnessMetadata } from '@qa/harness-protocol';
import { doctorMuse, resolveMuseRuntime, type MuseRuntimeConfiguration } from './discovery.js';
import { MuseHarnessError } from './errors.js';
import { redactDiagnostic, redactStructured, secretValues } from './redaction.js';
import {
  MUSE_SDK_VERSION,
  createProductionMuseClient,
  type MuseClientFactory,
  type MuseClientView,
  type MuseTurnOutcome,
  type MuseTurnView,
} from './sdk.js';

export interface MuseHarnessAdapterOptions {
  readonly executable?: string;
  readonly modelId?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly clientFactory?: MuseClientFactory;
  readonly shutdownTimeoutMs?: number;
  readonly onRuntimeIdentity?: (identity: {
    readonly harnessVersion?: string;
    readonly executableVersion?: string;
  }) => void;
}

interface TurnCollection {
  readonly text: string;
  readonly outcome: MuseTurnOutcome;
}

function event(agentRunId: AgentRunId, value: Readonly<Record<string, unknown>>): HarnessEvent {
  return HarnessEventSchema.parse({
    schemaVersion: 1,
    eventId: createHarnessEventId(),
    agentRunId,
    timestamp: nowIsoTimestamp(),
    ...value,
  });
}

function usageFrom(outcome: MuseTurnOutcome, turns: number): AgentUsage | undefined {
  if (outcome.kind !== 'completed') return undefined;
  const source = outcome.params.usage;
  const durationMs = outcome.params.durationMs;
  if (source === undefined && durationMs === undefined) return { turns };
  return {
    ...(source === undefined
      ? {}
      : {
          inputTokens: source.inputTokens,
          outputTokens: source.outputTokens,
          cachedInputTokens: source.cachedTokens,
        }),
    turns,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function assertCompleted(outcome: MuseTurnOutcome, phase: string): void {
  if (outcome.kind === 'completed' && outcome.params.terminal === 'completed') return;
  if (
    outcome.kind === 'completed' &&
    /sandbox/i.test(outcome.params.error?.message ?? outcome.params.reason ?? '')
  ) {
    throw new MuseHarnessError(
      'MUSE_SANDBOX_UNAVAILABLE',
      `Muse ${phase} turn could not enforce its sandbox.`,
    );
  }
  if (
    outcome.kind === 'completed' &&
    /auth|credential|sign in/i.test(outcome.params.error?.message ?? outcome.params.reason ?? '')
  ) {
    throw new MuseHarnessError('MUSE_AUTH_FAILED', `Muse ${phase} turn could not authenticate.`);
  }
  const detail =
    outcome.kind === 'completed'
      ? (outcome.params.error?.message ?? outcome.params.reason ?? outcome.params.terminal)
      : outcome.kind;
  throw new MuseHarnessError(
    'MUSE_INVALID_RESULT',
    `Muse ${phase} turn did not complete: ${detail}`,
    false,
  );
}

function parseWholeJson(text: string, phase: string, secrets: readonly string[]): unknown {
  try {
    return redactStructured(JSON.parse(text), secrets);
  } catch {
    throw new MuseHarnessError(
      'MUSE_INVALID_RESULT',
      `Muse ${phase} response was not one complete JSON document.`,
    );
  }
}

function safeAbsolute(root: string, relativePath: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, relativePath);
  const rel = relative(absoluteRoot, absolute);
  if (rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)))
    return absolute;
  throw new MuseHarnessError(
    'MUSE_INVALID_RESULT',
    'Evidence path escapes the isolated workspace.',
  );
}

async function validateExistingFile(root: string, relativePath: string): Promise<string> {
  const absolute = safeAbsolute(root, relativePath);
  let details;
  let realRoot: string;
  let realTarget: string;
  try {
    [realRoot, realTarget] = await Promise.all([realpath(root), realpath(absolute)]);
    details = await stat(absolute);
  } catch {
    throw new MuseHarnessError(
      'MUSE_INVALID_RESULT',
      'Referenced evidence path does not exist: ' + relativePath,
    );
  }
  if (!details.isFile()) {
    throw new MuseHarnessError(
      'MUSE_INVALID_RESULT',
      'Referenced evidence path is not a file: ' + relativePath,
    );
  }
  const realRelative = relative(realRoot, realTarget);
  if (realRelative === '..' || realRelative.startsWith('..' + sep) || isAbsolute(realRelative)) {
    throw new MuseHarnessError(
      'MUSE_INVALID_RESULT',
      'Referenced evidence path resolves outside the isolated workspace.',
    );
  }
  return absolute;
}

async function validateLocation(
  root: string,
  relativePath: string,
  lineStart?: number,
  lineEnd?: number,
): Promise<string> {
  const absolute = await validateExistingFile(root, relativePath);
  if (lineStart === undefined) return absolute;
  const lineCount = (await readFile(absolute, 'utf8')).split(/\r?\n/).length;
  if (lineStart > lineCount || (lineEnd !== undefined && lineEnd > lineCount)) {
    throw new MuseHarnessError(
      'MUSE_INVALID_RESULT',
      'Referenced evidence line range is outside the file: ' + relativePath,
    );
  }
  return absolute;
}

async function codeReference(root: string, source: SentryAgentEvidenceV1) {
  const relativePath = source.relativePath as string;
  const absolute = await validateLocation(root, relativePath, source.lineStart, source.lineEnd);
  const bytes = await readFile(absolute);
  const lines = bytes.toString('utf8').split(/\r?\n/);
  const start = source.lineStart ?? 1;
  const end = Math.min(source.lineEnd ?? start, lines.length);
  const excerpt = lines
    .slice(start - 1, end)
    .join('\n')
    .slice(0, 4_000);
  return {
    relativePath,
    ...(source.lineStart === undefined ? {} : { startLine: source.lineStart }),
    ...(source.lineEnd === undefined ? {} : { endLine: source.lineEnd }),
    sourceState: 'modified_workspace' as const,
    contentHash: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    ...(excerpt.length === 0 ? {} : { excerpt }),
  };
}

async function convertEvidence(
  request: HarnessRunRequest,
  source: SentryAgentEvidenceV1,
  observedCommands: ReadonlySet<string>,
): Promise<Evidence> {
  if (source.relativePath !== undefined)
    await validateLocation(
      request.workspace.runtimePath,
      source.relativePath,
      source.lineStart,
      source.lineEnd,
    );
  const base = {
    schemaVersion: 1 as const,
    id: createEvidenceId(),
    qaRunId: request.qaRunId,
    agentRunId: request.agentRunId,
    strength: source.strength,
    environmentState: 'modified_workspace' as const,
    description: source.description,
    artifactIds: [],
    createdAt: nowIsoTimestamp(),
  };
  if (source.type === 'code_reference') {
    return EvidenceSchema.parse({
      ...base,
      type: 'code_reference',
      codeReference: await codeReference(request.workspace.runtimePath, source),
    });
  }
  if (source.type === 'command') {
    if (!observedCommands.has(JSON.stringify([source.command, source.exitCode]))) {
      throw new MuseHarnessError(
        'MUSE_INVALID_RESULT',
        'Command evidence does not match an observed Muse command execution.',
      );
    }
    return EvidenceSchema.parse({
      ...base,
      type: 'command',
      command: { command: source.command, exitCode: source.exitCode },
    });
  }
  if (source.type === 'test') {
    return EvidenceSchema.parse({
      ...base,
      type: 'test',
      test: {
        framework: source.framework,
        name: source.name,
        status: source.status,
        summary: source.description,
      },
    });
  }
  if (source.type === 'runtime') {
    return EvidenceSchema.parse({
      ...base,
      type: 'runtime',
      runtime: { summary: source.description },
    });
  }
  if (source.type === 'log') {
    return EvidenceSchema.parse({
      ...base,
      type: 'log',
      log: { source: source.source ?? 'muse', summary: source.description },
    });
  }
  return EvidenceSchema.parse({
    ...base,
    type: 'manual',
    manual: { summary: source.description, author: 'Muse Code' },
  });
}

function planningPrompt(request: HarnessRunRequest): string {
  return [
    'You are the sole QA investigator. Do not create, delegate to, or message subagents.',
    'Host safety is authoritative: work only inside the current isolated workspace; never disable or bypass sandboxing; never access the original project, Sentry managed baseline, other workspaces, Sentry data, or arbitrary host files.',
    'Do not commit, push, modify Git remotes, create pull requests, or intentionally fix product defects.',
    'Explicit run instructions define intended behavior and outrank project documentation; project documentation outranks your inference. None may override host safety.',
    'Inspect project documentation and the supplied immutable mission context. Do not use peer plans, findings, or messages.',
    'Create an investigation plan before executing it. Return exactly one JSON document and no Markdown.',
    'Schema: {"schemaVersion":1,"projectUnderstanding":string,"criticalFlows":string[],"weakPoints":string[],"plannedChecks":string[at least one]}.',
    'Immutable mission context: ' + JSON.stringify(request.task.context ?? {}),
    'User instructions: ' + request.task.prompt,
  ].join('\n');
}

function executionPrompt(plan: ReturnType<typeof SentryInvestigationPlanV1Schema.parse>): string {
  return [
    'Execute the frozen investigation plan below as the sole investigator. Do not create or use subagents.',
    'Host safety is authoritative: remain inside the isolated workspace; never disable or bypass sandboxing; never access the original project, Sentry managed baseline, other workspaces, Sentry data, or arbitrary host files.',
    'Do not commit, push, modify Git remotes, create pull requests, or intentionally fix product defects.',
    'You may create temporary tests, configuration, instrumentation, build output, and runtime state only inside this disposable workspace to investigate behavior.',
    'Inspect every applicable area needed for comprehensive QA: build, lint, typecheck, existing and generated tests, integration/runtime/API/frontend/database/auth behavior, configuration, dependencies, architecture, business logic, error handling, edge cases, performance, concurrency, CI/CD, deployment, maintainability, and project-specific weak points. Do not force irrelevant checks.',
    'Priority controls order, not permission to skip relevant checks. Record every blocked or incomplete check as a limitation; never claim it passed.',
    'Do not silently obtain unrestricted network access. Record sandbox or network restrictions as limitations and never retry with sandbox disabled.',
    'Return exactly one JSON document and no Markdown. Do not invent file paths or command results.',
    'Use temporary evidence keys only; Sentry owns all durable IDs.',
    'Schema: {"schemaVersion":1,"summary":string,"checks":[{"name":string,"status":"passed|failed|inconclusive|not_run","details"?:string}],"hypotheses":[{"title":string,"rationale":string,"relatedPaths":string[],"plannedChecks":string[at least one]}],"evidence":[{"key":string,"type":"command|runtime|code_reference|test|log|manual","strength":"reproduced_failure|reproduced_behavior|tool_diagnostic|strong_code_evidence|agent_reasoning","description":string,"relativePath"?:string,"lineStart"?:number,"lineEnd"?:number,"command"?:string,"exitCode"?:number,"framework"?:string,"name"?:string,"status"?:"passed|failed","source"?:string}],"findings":[{"title":string,"category":string,"categoryDetail"?:string,"severity":"critical|high|medium|low|info","confidence":"confirmed|strong|probable|speculative","description":string,"expectedBehavior"?:string,"actualBehavior"?:string,"locations":[{"relativePath":string,"lineStart"?:number,"lineEnd"?:number,"symbol"?:string}],"evidenceKeys":string[],"reproductionSteps":string[],"rootCause"?:string,"recommendedFix"?:string}],"limitations":string[]}.',
    'Frozen plan: ' + JSON.stringify(plan),
  ].join('\n');
}

export class MuseHarnessAdapter implements HarnessAdapter {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly runtime: MuseRuntimeConfiguration;
  private readonly clientFactory: MuseClientFactory;
  private readonly shutdownTimeoutMs: number;
  private readonly secrets: readonly string[];
  private client?: MuseClientView;
  private serverVersion?: string;
  private closePromise?: Promise<void>;
  private readonly operationIds = new Map<string, OperationId>();
  private readonly completedTools = new Set<string>();
  private readonly observedCommands = new Set<string>();

  constructor(private readonly options: MuseHarnessAdapterOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.runtime = resolveMuseRuntime({ ...options, environment: this.environment });
    this.clientFactory = options.clientFactory ?? createProductionMuseClient;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
    this.secrets = secretValues(this.environment);
  }

  async getMetadata(): Promise<HarnessMetadata> {
    return {
      adapterId: 'muse-code',
      adapterVersion: '0.1.0',
      protocolVersion: 1,
      displayName: 'Muse Code SDK Adapter',
      capabilities: {
        streaming: true,
        cancellation: true,
        filesystemRead: true,
        filesystemWrite: true,
        shell: true,
        browser: false,
        sessionResume: false,
        structuredOutput: true,
        usageReporting: true,
      },
      supportedModelPatterns: [this.runtime.modelId],
      supportedOperatingSystems: ['windows', 'linux', 'macos'],
    };
  }

  async healthCheck(): Promise<HarnessHealthResult> {
    return doctorMuse({
      executable: this.runtime.executable,
      modelId: this.runtime.modelId,
      environment: this.environment,
    });
  }

  private async *streamTurn(
    turn: MuseTurnView,
    agentRunId: AgentRunId,
  ): AsyncGenerator<HarnessEvent, TurnCollection> {
    let text = '';
    for await (const item of turn.items()) {
      if (item.kind === 'reasoning') continue;
      if (item.kind === 'subagent' || item.kind === 'workflow' || item.kind === 'reminderChild') {
        throw new MuseHarnessError(
          'MUSE_SUBAGENT_FORBIDDEN',
          'Muse attempted forbidden subagent fanout.',
        );
      }
      if (item.kind === 'agentMessage' && item.text !== undefined) text = item.text;
      if (item.kind !== 'toolCall' && item.kind !== 'userShell') continue;
      let operationId = this.operationIds.get(item.itemId);
      if (operationId === undefined) {
        operationId = createOperationId();
        this.operationIds.set(item.itemId, operationId);
        yield event(agentRunId, {
          type: 'tool.started',
          operationId,
          tool: {
            name: item.kind === 'userShell' ? 'shell' : (item.tool ?? 'unknown'),
            inputSummary: redactDiagnostic(item.commandText ?? item.args ?? '', this.secrets),
          },
        });
      }
      if (item.status !== 'inProgress' && !this.completedTools.has(item.itemId)) {
        this.completedTools.add(item.itemId);
        yield event(agentRunId, {
          type: 'tool.completed',
          operationId,
          tool: {
            name: item.kind === 'userShell' ? 'shell' : (item.tool ?? 'unknown'),
            ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
            ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
          },
        });
        if (item.commandText !== undefined && item.exitCode !== undefined) {
          const command = redactDiagnostic(item.commandText, this.secrets);
          this.observedCommands.add(JSON.stringify([command, item.exitCode]));
          yield event(agentRunId, {
            type: 'command.executed',
            operationId,
            command,
            exitCode: item.exitCode,
            ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
          });
        }
      }
    }
    return { text, outcome: await turn.completed };
  }

  async *run(request: HarnessRunRequest): AsyncIterable<HarnessEvent> {
    const stderr: string[] = [];
    yield event(request.agentRunId, { type: 'run.started' });
    yield event(request.agentRunId, {
      type: 'agent.status',
      status: 'planning',
      message: 'Muse is creating a frozen investigation plan.',
    });
    try {
      this.client = await this.clientFactory({
        executable: this.runtime.executable,
        cwd: request.workspace.runtimePath,
        environment: this.environment,
        onStderr: (chunk) => {
          if (stderr.length < 10) stderr.push(redactDiagnostic(chunk, this.secrets));
        },
        shutdownTimeoutMs: this.shutdownTimeoutMs,
      });
      if (this.client.serverVersion !== undefined) this.serverVersion = this.client.serverVersion;
      if (this.serverVersion !== undefined) {
        this.options.onRuntimeIdentity?.({ harnessVersion: this.serverVersion });
      }
      const session = await this.client.startSession({
        workspaceRoot: request.workspace.runtimePath,
        modelId: this.runtime.modelId,
      });
      const planning = yield* this.streamTurn(
        await session.sendText(planningPrompt(request)),
        request.agentRunId,
      );
      assertCompleted(planning.outcome, 'planning');
      const planResult = SentryInvestigationPlanV1Schema.parse(
        parseWholeJson(planning.text, 'planning', this.secrets),
      );
      const plan = {
        id: createInvestigationPlanId(),
        qaRunId: request.qaRunId,
        agentRunId: request.agentRunId,
        agentStackId: request.agentStackId,
        projectSnapshotId: request.workspace.snapshotId,
        projectContextSnapshotId: request.projectContextSnapshotId,
        ...planResult,
        createdAt: nowIsoTimestamp(),
      };
      yield event(request.agentRunId, { type: 'investigation.plan.created', plan });
      yield event(request.agentRunId, {
        type: 'agent.status',
        status: 'investigating',
        message: 'Muse is executing the frozen plan.',
      });
      const execution = yield* this.streamTurn(
        await session.sendText(executionPrompt(planResult)),
        request.agentRunId,
      );
      assertCompleted(execution.outcome, 'execution');
      const result = SentryAgentResultV1Schema.parse(
        parseWholeJson(execution.text, 'execution', this.secrets),
      );
      yield event(request.agentRunId, { type: 'agent.message', message: result.summary });
      for (const check of result.checks) {
        yield event(request.agentRunId, {
          type: 'agent.message',
          message:
            '[' +
            check.status +
            '] ' +
            check.name +
            (check.details === undefined ? '' : ' — ' + check.details),
        });
      }
      for (const hypothesis of result.hypotheses) {
        yield event(request.agentRunId, {
          type: 'investigation.hypothesis.discovered',
          hypothesis: {
            schemaVersion: 1,
            id: createInvestigationHypothesisId(),
            qaRunId: request.qaRunId,
            agentRunId: request.agentRunId,
            ...hypothesis,
            discoveredAt: nowIsoTimestamp(),
          },
        });
      }
      const evidenceByKey = new Map<string, Evidence>();
      for (const source of result.evidence) {
        const converted = await convertEvidence(request, source, this.observedCommands);
        evidenceByKey.set(source.key, converted);
        yield event(request.agentRunId, { type: 'evidence.submitted', evidence: converted });
      }
      for (const source of result.findings) {
        for (const location of source.locations)
          await validateLocation(
            request.workspace.runtimePath,
            location.relativePath,
            location.lineStart,
            location.lineEnd,
          );
        const { evidenceKeys, locations, ...findingFields } = source;
        const finding = FindingSchema.parse({
          schemaVersion: 1,
          id: createFindingId(),
          qaRunId: request.qaRunId,
          agentRunId: request.agentRunId,
          sourceAgentStackId: request.agentStackId,
          ...findingFields,
          locations: locations.map(({ lineStart, lineEnd, ...location }) => ({
            ...location,
            ...(lineStart === undefined ? {} : { startLine: lineStart }),
            ...(lineEnd === undefined ? {} : { endLine: lineEnd }),
          })),
          evidenceIds: evidenceKeys.map((key) => (evidenceByKey.get(key) as Evidence).id),
          createdAt: nowIsoTimestamp(),
        });
        yield event(request.agentRunId, { type: 'finding.submitted', finding });
      }
      for (const limitation of result.limitations)
        yield event(request.agentRunId, {
          type: 'warning',
          code: 'MUSE_LIMITATION',
          message: limitation,
        });
      for (const diagnostic of stderr) {
        yield event(request.agentRunId, {
          type: 'warning',
          code: 'MUSE_STDERR',
          message: diagnostic,
        });
      }
      const usage = usageFrom(execution.outcome, 2);
      if (usage !== undefined) yield event(request.agentRunId, { type: 'usage.updated', usage });
      yield event(request.agentRunId, {
        type: 'run.completed',
        ...(usage === undefined ? {} : { usage }),
      });
    } catch (cause) {
      const typed =
        cause instanceof MuseHarnessError
          ? cause
          : cause instanceof Error && cause.name === 'ZodError'
            ? new MuseHarnessError(
                'MUSE_INVALID_RESULT',
                'Muse returned data that did not match the required schema.',
              )
            : new MuseHarnessError(
                /auth|credential|sign in/i.test(String(cause))
                  ? 'MUSE_AUTH_FAILED'
                  : /sandbox/i.test(String(cause))
                    ? 'MUSE_SANDBOX_UNAVAILABLE'
                    : 'MUSE_START_FAILED',
                redactDiagnostic(cause, this.secrets),
                true,
              );
      yield event(request.agentRunId, {
        type: 'run.failed',
        failure: {
          code: typed.code,
          message: redactDiagnostic(typed, this.secrets),
          retryable: typed.retryable,
        },
      });
    }
  }

  async cancel(_runId: AgentRunId): Promise<void> {
    try {
      await this.dispose();
    } catch (cause) {
      throw new MuseHarnessError('MUSE_CANCEL_FAILED', redactDiagnostic(cause, this.secrets), true);
    }
  }

  async dispose(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closePromise = this.client?.close() ?? Promise.resolve();
    return this.closePromise;
  }

  runtimeIdentity() {
    return {
      modelId: this.runtime.modelId,
      adapterId: 'muse-code',
      adapterVersion: '0.1.0',
      harnessVersion: this.serverVersion,
      sdkVersion: MUSE_SDK_VERSION,
      executable: this.runtime.executable,
    };
  }
}
