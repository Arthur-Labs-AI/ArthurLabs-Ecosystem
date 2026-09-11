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
import {
  doctorMuse,
  markMuseRuntimeVerified,
  resolveMuseRuntime,
  type MuseRuntimeConfiguration,
} from './discovery.js';
import { buildMuseChildEnvironment } from './environment.js';
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

/**
 * Aggregate per-turn usage. The SDK documents
 * TurnCompletedParams.usage as "the turn's aggregate token usage, summed
 * across the turn's model completions", i.e. PER-TURN, not cumulative, so
 * planning + execution totals are summed. Unknown stays undefined (never 0).
 */
export function aggregateTurnUsage(
  turns: ReadonlyArray<{ readonly outcome: MuseTurnOutcome }>,
): AgentUsage | undefined {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let durationMs: number | undefined;
  let knownTurns = 0;
  let sawUsage = false;
  for (const turn of turns) {
    if (turn.outcome.kind !== 'completed') continue;
    knownTurns += 1;
    const source = turn.outcome.params.usage;
    if (source !== undefined) {
      sawUsage = true;
      inputTokens = (inputTokens ?? 0) + source.inputTokens;
      outputTokens = (outputTokens ?? 0) + source.outputTokens;
      cachedInputTokens = (cachedInputTokens ?? 0) + source.cachedTokens;
    }
    if (turn.outcome.params.durationMs !== undefined) {
      durationMs = (durationMs ?? 0) + turn.outcome.params.durationMs;
    }
  }
  if (knownTurns === 0) return undefined;
  if (!sawUsage && durationMs === undefined) return { turns: knownTurns };
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    turns: knownTurns,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function childPidOf(client: MuseClientView): number | undefined {
  const maybe = client as { readonly pid?: unknown };
  return typeof maybe.pid === 'number' ? maybe.pid : undefined;
}

async function buildBaselineIndex(
  workspaceRoot: string,
  _snapshotId: string,
): Promise<BaselineFileIndex | undefined> {
  // Baseline provenance without rehashing the project per evidence item:
  // the adapter cannot reach the run snapshot manifest directly, so it
  // consults a sidecar baseline-hashes file ONLY when the coordinator wrote
  // one next to the workspace. Absent sidecar → undefined → every file
  // is conservatively classified modified_workspace (never a false baseline).
  try {
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const sidecar = join(dirname(workspaceRoot), 'baseline-hashes.json');
    const raw = await readFile(sidecar, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const map = new Map<string, string>();
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)) map.set(key, value);
      }
      return { fileHashByPath: map };
    }
  } catch {
    // Absent/unreadable sidecar: conservative modified_workspace.
  }
  return undefined;
}

function validateProductionFindings(
  findings: ReadonlyArray<{
    readonly evidenceKeys: readonly string[];
    readonly confidence: string;
  }>,
  evidenceByKey: ReadonlyMap<string, Evidence>,
): void {
  for (const finding of findings) {
    if (finding.evidenceKeys.length === 0) {
      throw new MuseHarnessError(
        'MUSE_INVALID_RESULT',
        'Production findings must reference at least one durable evidence item.',
      );
    }
    if (finding.confidence === 'confirmed') {
      const items = finding.evidenceKeys.map((key) => evidenceByKey.get(key));
      const grounded = items.some(
        (item) =>
          item !== undefined &&
          (item.type === 'command' ||
            item.type === 'code_reference' ||
            item.type === 'test' ||
            item.strength === 'reproduced_failure' ||
            item.strength === 'reproduced_behavior' ||
            item.strength === 'tool_diagnostic' ||
            item.strength === 'strong_code_evidence'),
      );
      if (!grounded) {
        throw new MuseHarnessError(
          'MUSE_INVALID_RESULT',
          'Confirmed findings require at least one grounded evidence item; manual/model reasoning alone is insufficient.',
        );
      }
    }
  }
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

export interface BaselineFileIndex {
  /** Baseline content hash by workspace-relative path (forward slashes). */
  readonly fileHashByPath: ReadonlyMap<string, string>;
}

async function codeReference(
  root: string,
  source: SentryAgentEvidenceV1,
  baseline?: BaselineFileIndex,
) {
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
  const contentHash = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  const baselineHash = baseline?.fileHashByPath.get(relativePath);
  return {
    relativePath,
    ...(source.lineStart === undefined ? {} : { startLine: source.lineStart }),
    ...(source.lineEnd === undefined ? {} : { endLine: source.lineEnd }),
    // Unchanged-from-baseline evidence is baseline provenance; anything else
    // (modified existing file or agent-created new file) is modified_workspace.
    sourceState:
      baselineHash !== undefined && baselineHash === contentHash
        ? ('baseline' as const)
        : ('modified_workspace' as const),
    contentHash,
    ...(excerpt.length === 0 ? {} : { excerpt }),
  };
}

export interface ObservedEvidenceGrounding {
  readonly observedCommands: ReadonlySet<string>;
  /** Normalized observed test executions: "framework\u0000name\u0000status". */
  readonly observedTests: ReadonlySet<string>;
  /** Normalized observed tool operations: "tool-name\u0000command-or-args". */
  readonly observedTools: ReadonlySet<string>;
  readonly baseline?: BaselineFileIndex;
}

function groundingOf(observedCommands: ReadonlySet<string>): ObservedEvidenceGrounding {
  return { observedCommands, observedTests: new Set<string>(), observedTools: new Set<string>() };
}

async function convertEvidence(
  request: HarnessRunRequest,
  source: SentryAgentEvidenceV1,
  grounding: ObservedEvidenceGrounding | ReadonlySet<string>,
): Promise<Evidence> {
  const observed =
    grounding instanceof Set ? groundingOf(grounding) : (grounding as ObservedEvidenceGrounding);
  if (source.relativePath !== undefined)
    await validateLocation(
      request.workspace.runtimePath,
      source.relativePath,
      source.lineStart,
      source.lineEnd,
    );
  // Grounding policy: a model must not mint reproduced test/runtime/log proof
  // by writing JSON alone. Test evidence without an observed tool operation is
  // downgraded to agent reasoning; purely model-reported runtime/log evidence
  // keeps its type but is marked agent_reasoning strength so confirmed
  // findings cannot rely on it.
  if (source.type === 'test') {
    const key = [source.framework ?? '', source.name ?? '', source.status ?? ''].join('\u0000');
    const observedTest =
      observed.observedTests.has(key) || observed.observedTests.size === 0
        ? observed.observedCommands.size > 0 || observed.observedTools.size > 0
        : false;
    if (!observedTest) {
      return EvidenceSchema.parse({
        schemaVersion: 1 as const,
        id: createEvidenceId(),
        qaRunId: request.qaRunId,
        agentRunId: request.agentRunId,
        strength: 'agent_reasoning',
        environmentState: 'modified_workspace' as const,
        description: source.description,
        artifactIds: [],
        createdAt: nowIsoTimestamp(),
        type: 'manual',
        manual: {
          summary:
            'Ungrounded test claim downgraded (framework=' +
            (source.framework ?? 'unknown') +
            ' name=' +
            (source.name ?? 'unknown') +
            ' status=' +
            (source.status ?? 'unknown') +
            '): ' +
            source.description,
          author: 'Muse Code',
        },
      });
    }
  }
  const groundedStrength = (
    fallback: SentryAgentEvidenceV1['strength'],
  ): SentryAgentEvidenceV1['strength'] => {
    if (source.type === 'runtime' || source.type === 'log') {
      const hasToolGrounding =
        observed.observedCommands.size > 0 || observed.observedTools.size > 0;
      if (!hasToolGrounding) return 'agent_reasoning';
    }
    return fallback;
  };
  const base = {
    schemaVersion: 1 as const,
    id: createEvidenceId(),
    qaRunId: request.qaRunId,
    agentRunId: request.agentRunId,
    strength: groundedStrength(source.strength),
    environmentState: 'modified_workspace' as const,
    description: source.description,
    artifactIds: [],
    createdAt: nowIsoTimestamp(),
  };
  if (source.type === 'code_reference') {
    const reference = await codeReference(request.workspace.runtimePath, source, observed.baseline);
    return EvidenceSchema.parse({
      ...base,
      environmentState: reference.sourceState,
      type: 'code_reference',
      codeReference: reference,
    });
  }
  if (source.type === 'command') {
    if (!observed.observedCommands.has(JSON.stringify([source.command, source.exitCode]))) {
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
  private readonly hostEnvironment: NodeJS.ProcessEnv;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly childEnvironmentReport: {
    readonly allowedNames: readonly string[];
    readonly blockedNames: readonly string[];
  };
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
  private readonly observedTests = new Set<string>();
  private readonly observedTools = new Set<string>();
  private shutdownWarning?: string;

  constructor(private readonly options: MuseHarnessAdapterOptions = {}) {
    this.hostEnvironment = options.environment ?? process.env;
    this.runtime = resolveMuseRuntime({ ...options, environment: this.hostEnvironment });
    this.clientFactory = options.clientFactory ?? createProductionMuseClient;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
    // Never hand the raw host environment to the autonomous worker: build the
    // explicit sanitized child environment (PATH/temp/locale + Muse config).
    const child = buildMuseChildEnvironment({ source: this.hostEnvironment });
    this.environment = child.environment;
    this.childEnvironmentReport = child;
    this.secrets = secretValues(this.hostEnvironment);
  }

  /** Names forwarded to the Muse child (never values); for diagnostics only. */
  childEnvironmentNames(): {
    readonly allowed: readonly string[];
    readonly blocked: readonly string[];
  } {
    return {
      allowed: this.childEnvironmentReport.allowedNames,
      blocked: this.childEnvironmentReport.blockedNames,
    };
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
    // Doctor reads local config (host env); only run() spawns the worker and
    // only with the sanitized child environment.
    return doctorMuse({
      executable: this.runtime.executable,
      modelId: this.runtime.modelId,
      environment: this.hostEnvironment,
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
      this.observedTools.add(
        (item.kind === 'userShell' ? 'shell' : (item.tool ?? 'unknown')) +
          '\u0000' +
          (item.commandText ?? item.args ?? ''),
      );
      // Record observed test executions so final-JSON test claims can be
      // correlated to real tool activity instead of trusted on assertion.
      if (item.kind === 'toolCall' && /test/i.test(item.tool ?? '')) {
        const argsText = item.commandText ?? item.args ?? '';
        const status = item.exitCode === undefined ? '' : item.exitCode === 0 ? 'passed' : 'failed';
        this.observedTests.add(argsText + '\u0000' + status);
      }
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
      // A real session started: ephemeral runtime verification for this process.
      markMuseRuntimeVerified();
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
      const baselineIndex = await buildBaselineIndex(
        request.workspace.runtimePath,
        request.workspace.snapshotId,
      ).catch(() => undefined);
      for (const source of result.evidence) {
        const converted = await convertEvidence(request, source, {
          observedCommands: this.observedCommands,
          observedTests: this.observedTests,
          observedTools: this.observedTools,
          ...(baselineIndex === undefined ? {} : { baseline: baselineIndex }),
        });
        evidenceByKey.set(source.key, converted);
        yield event(request.agentRunId, { type: 'evidence.submitted', evidence: converted });
      }
      validateProductionFindings(result.findings, evidenceByKey);
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
      const usage = aggregateTurnUsage([
        { outcome: planning.outcome },
        { outcome: execution.outcome },
      ]);
      if (usage !== undefined) yield event(request.agentRunId, { type: 'usage.updated', usage });
      // NOTE: dispose() runs after this stream ends (coordinator-owned
      // lifecycle), so a partial-shutdown warning cannot be yielded here.
      // It stays observable via shutdownNotice() for coordinators/exports.
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
    const client = this.client;
    if (client === undefined) {
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }
    // Primary mechanism stays SDK shutdown (SS2.1.2: stdin EOF, bounded
    // drain, then SIGTERM/SIGKILL escalation of the owned child). On Windows
    // the SDK signals only the child (no subtree containment per FR-017b),
    // so record an observable warning when shutdown confidence is partial.
    this.closePromise = (async () => {
      const pid = childPidOf(client);
      await client.close();
      if (process.platform === 'win32' && pid !== undefined) {
        this.shutdownWarning =
          'Windows process-tree limitation: SDK shutdown closed the Muse host ' +
          '(pid ' +
          pid +
          ') but cannot guarantee descendant cleanup; orphaned grandchildren ' +
          'remain possible. Workspace cleanup still proceeds.';
      }
    })();
    return this.closePromise;
  }

  /** Observable shutdown limitation, when dispose() could not prove full cleanup. */
  shutdownNotice(): string | undefined {
    return this.shutdownWarning;
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
