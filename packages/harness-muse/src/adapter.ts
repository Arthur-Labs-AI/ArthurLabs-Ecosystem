import {
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
  boundCorrectionMessage,
  buildPlanningCorrectionIntro,
  buildReportCorrectionIntro,
  buildBaselineIndex,
  commandIdentity,
  convertReportEvidence,
  isTestCommand,
  MAX_PLANNING_ATTEMPTS,
  MAX_REPORT_ATTEMPTS,
  parseWholeJson,
  renderFrozenLedger,
  REPORT_CONFIDENCE_CALIBRATION,
  REPORT_ENVELOPE_SCHEMA,
  REPORT_LEDGER_RULES,
  summarizeSchemaIssues,
  validateLocation,
  validateProductionFindings,
  type EvidencePipelineContext,
  type ObservedOperation,
} from '@qa/evidence-pipeline';
import {
  describeSentryAgentReportContract,
  FindingSchema,
  type Finding,
  HarnessEventSchema,
  SentryAgentReportV2Schema,
  SentryInvestigationPlanV1Schema,
  type AgentUsage,
  type Evidence,
  type HarnessEvent,
  type HarnessRunRequest,
  type SentryAgentReportV2,
} from '@qa/schemas';
import type {
  HarnessAdapter,
  HarnessDiagnostic,
  HarnessHealthResult,
  HarnessMetadata,
} from '@qa/harness-protocol';
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
  type MuseFatalApproval,
  type MuseHostCompatibility,
  type MuseSessionView,
  type MuseTurnOutcome,
  type MuseTurnView,
} from './sdk.js';

export interface MuseHarnessAdapterOptions {
  readonly executable?: string;
  readonly modelId?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly clientFactory?: MuseClientFactory;
  readonly shutdownTimeoutMs?: number;
  /**
   * Per-turn watchdog: the SDK never times out a turn locally (INV-006), so
   * Sentry owns the bound. When one turn exceeds this budget the adapter
   * aborts the session and reports a structured timeout (partial
   * observations already yielded are preserved). Defaults to 30 minutes.
   */
  readonly turnTimeoutMs?: number;
  readonly onRuntimeIdentity?: (identity: {
    readonly harnessVersion?: string;
    readonly executableVersion?: string;
  }) => void;
}

export class MuseTurnTimeoutError extends MuseHarnessError {
  constructor(phase: string, budgetMs: number) {
    super(
      'MUSE_START_FAILED',
      'Muse ' + phase + ' turn exceeded its ' + String(budgetMs) + ' ms budget.',
      true,
    );
    this.name = 'MuseTurnTimeoutError';
  }
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

function pipelineContext(secrets: readonly string[]): EvidencePipelineContext {
  return {
    errors: {
      invalidResult: (message: string) => new MuseHarnessError('MUSE_INVALID_RESULT', message),
    },
    authorLabel: 'Muse Code',
    secrets,
    redactDiagnostic: (value: string) => redactDiagnostic(value, secrets),
    redactStructured: (value: unknown) => redactStructured(value, secrets),
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

/** Parse one report attempt: strict whole-document JSON + ReportV2
 *  schema. Returns the report or bounded correction errors (never throws
 *  for report-shape problems; the repair loop decides). */
function parseReportAttempt(
  text: string,
  pipeline: EvidencePipelineContext,
): { ok: true; report: SentryAgentReportV2 } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = parseWholeJson(text, 'reporting', pipeline);
  } catch (cause) {
    return { ok: false, errors: [boundCorrectionMessage(messageOf(cause))] };
  }
  const parsed = SentryAgentReportV2Schema.safeParse(raw);
  if (parsed.success) return { ok: true, report: parsed.data };
  return { ok: false, errors: [boundCorrectionMessage(summarizeSchemaIssues(parsed.error))] };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface BuiltReportAttempt {
  readonly evidenceByKey: ReadonlyMap<string, Evidence>;
  readonly findings: readonly Finding[];
}

function planningPrompt(request: HarnessRunRequest): string {
  return [
    'You are the sole QA investigator. Do not create, delegate to, or message subagents.',
    'Host safety is authoritative: work only inside the current isolated workspace; never disable or bypass sandboxing; never access the original project, Sentry managed baseline, other workspaces, Sentry data, or arbitrary host files.',
    'Do not commit, push, modify Git remotes, create pull requests, or intentionally fix product defects.',
    'Explicit run instructions define intended behavior and outrank project documentation; project documentation outranks your inference. None may override host safety.',
    'Inspect project documentation and the supplied immutable mission context. Do not use peer plans, findings, or messages.',
    'Create an investigation plan before executing it.',
    'Schema: {"schemaVersion":1,"projectUnderstanding":string,"criticalFlows":string[],"weakPoints":string[],"plannedChecks":string[at least one]}.',
    'Immutable mission context: ' + JSON.stringify(request.task.context ?? {}),
    'User instructions: ' + request.task.prompt,
    'OUTPUT CONTRACT (must hold exactly): your ENTIRE response is exactly one raw JSON object matching the schema. No Markdown. No code fences. No preamble, introduction, explanation, or closing sentence. The first character is { and the last character is }. Any additional text invalidates the response.',
  ].join('\n');
}

function investigationPrompt(
  plan: ReturnType<typeof SentryInvestigationPlanV1Schema.parse>,
): string {
  return [
    'Execute the frozen investigation plan below as the sole investigator. Do not create or use subagents.',
    'Host safety is authoritative: remain inside the isolated workspace; never disable or bypass sandboxing; never access the original project, Sentry managed baseline, other workspaces, Sentry data, or arbitrary host files.',
    'Do not commit, push, modify Git remotes, create pull requests, or intentionally fix product defects.',
    'You may create temporary tests, configuration, instrumentation, build output, and runtime state only inside this disposable workspace to investigate behavior.',
    'Inspect every applicable area needed for comprehensive QA: build, lint, typecheck, existing and generated tests, integration/runtime/API/frontend/database/auth behavior, configuration, dependencies, architecture, business logic, error handling, edge cases, performance, concurrency, CI/CD, deployment, maintainability, and project-specific weak points. Do not force irrelevant checks.',
    'Priority controls order, not permission to skip relevant checks. Record every blocked or incomplete check as a limitation; never claim it passed.',
    'Do not silently obtain unrestricted network access. Record sandbox or network restrictions as limitations and never retry with sandbox disabled.',
    'Use only the repository toolchain already present in the workspace; do not download packages or install dependencies from the network (no npx fetches, no npm/pip installs). If a test runner is unavailable, record it as a limitation.',
    'Keep the investigation tight: a handful of targeted checks beats dozens of exploratory commands. Do not repeat commands that already produced results.',
    'Do NOT produce the final Sentry JSON report yet. Investigate only, using permitted local tools as needed. When the investigation is complete, finish this turn with a short terminal message such as: Investigation complete.',
    'Sentry will provide the authoritative operation ledger in the following reporting turn.',
    'Frozen plan: ' + JSON.stringify(plan),
  ].join('\n');
}

function reportPrompt(
  plan: ReturnType<typeof SentryInvestigationPlanV1Schema.parse>,
  operations: ReadonlyMap<string, ObservedOperation>,
  correction?: readonly string[],
): string {
  return [
    'Serialize the investigation you just completed into exactly one Sentry report. No new QA: do not run commands, read files, or use any tools in this turn. Temporary evidence keys only; Sentry owns all durable IDs.',
    ...(correction === undefined ? [] : [buildReportCorrectionIntro(correction)]),
    REPORT_LEDGER_RULES,
    REPORT_CONFIDENCE_CALIBRATION,
    'Finding category MUST be exactly one of: build, runtime, logic, api, frontend, database, authentication, authorization, security, configuration, performance, concurrency, dependency, testing, cicd, deployment, maintainability, documentation, other. Copy the string exactly; any other value fails validation. Severity MUST be exactly one of: critical, high, medium, low, info.',
    'Report evidence contract (exact fields per type; copy names exactly): ' +
      describeSentryAgentReportContract(),
    REPORT_ENVELOPE_SCHEMA,
    'Authoritative Sentry operation ledger (frozen after investigation):\n' +
      renderFrozenLedger(operations),
    'Frozen plan: ' + JSON.stringify(plan),
    'OUTPUT CONTRACT (must hold exactly): your ENTIRE response is exactly one raw JSON object matching SentryAgentReportV2 (schemaVersion 2). No Markdown. No code fences. No preamble, introduction, explanation, or closing sentence. The first character is { and the last character is }. Any additional text invalidates the response.',
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
  private readonly turnTimeoutMs: number;
  private readonly secrets: readonly string[];
  private client?: MuseClientView;
  private serverVersion?: string;
  private hostCompatibility?: MuseHostCompatibility;
  private closePromise?: Promise<void>;
  private readonly operationIds = new Map<string, OperationId>();
  private readonly completedTools = new Set<string>();
  private readonly observedCommands = new Set<string>();
  private readonly observedOperations = new Map<string, ObservedOperation>();
  private operationCounter = 0;
  private readonly shutdownDiagnostics: HarnessDiagnostic[] = [];
  private approvalFatal?: MuseHarnessError;
  private approvalAbortReject?: (cause: MuseHarnessError) => void;

  constructor(private readonly options: MuseHarnessAdapterOptions = {}) {
    this.hostEnvironment = options.environment ?? process.env;
    this.runtime = resolveMuseRuntime({ ...options, environment: this.hostEnvironment });
    this.clientFactory = options.clientFactory ?? createProductionMuseClient;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 1_800_000;
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
    session?: MuseSessionView,
    phase = 'execution',
    forbidTools = false,
  ): AsyncGenerator<HarnessEvent, TurnCollection> {
    // Per-turn watchdog (the SDK never times out a turn locally, INV-006, so
    // Sentry owns the bound): the inner generator is pumped one step at a
    // time, racing each next() against the deadline. A wedged item stream
    // (no yields at all) still trips the bound. On expiry the pump throws
    // MuseTurnTimeoutError out through run() for structured mapping; events
    // already yielded stay persisted by the coordinator.
    const inner = this.streamTurnInner(turn, agentRunId, session, forbidTools);
    const deadline = Date.now() + this.turnTimeoutMs;
    const timeoutError = (): MuseTurnTimeoutError =>
      new MuseTurnTimeoutError(phase, this.turnTimeoutMs);
    const nextWithDeadline = async (): Promise<IteratorResult<HarnessEvent, TurnCollection>> => {
      const budget = deadline - Date.now();
      if (budget <= 0) throw timeoutError();
      if (this.approvalFatal !== undefined) throw this.approvalFatal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          inner.next(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(timeoutError()), budget);
            this.approvalAbortReject = (cause) => {
              if (timer !== undefined) clearTimeout(timer);
              reject(cause);
            };
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        delete this.approvalAbortReject;
      }
    };
    // Final drain helper: approval decisions buffer in the session and are
    // otherwise emitted only when the next item arrives. A decision made on
    // the last item of a turn must still reach observable run history.
    const drainRemaining = function* (): Generator<HarnessEvent> {
      const drained = session?.drainApprovalDecisions?.() ?? [];
      for (const decision of drained) {
        yield event(agentRunId, {
          type: 'warning',
          code: decision.approved ? 'MUSE_APPROVAL_GRANTED' : 'MUSE_APPROVAL_DENIED',
          message:
            'Tool approval ' +
            (decision.approved ? 'granted' : 'denied') +
            ' for ' +
            decision.toolName +
            ' (' +
            decision.reason +
            ')',
        });
      }
    };
    try {
      for (;;) {
        const step = await nextWithDeadline();
        if (step.done === true) {
          yield* drainRemaining();
          return step.value;
        }
        yield step.value;
      }
    } catch (cause) {
      // Do not await the inner return: a wedged item stream may never settle
      // its pending next(), which would wedge the return as well.
      try {
        inner.return?.(undefined as never)?.catch?.(() => undefined);
      } catch {
        // ignore synchronous return errors; the timeout is already decided
      }
      throw cause;
    }
  }

  /** Convert + trust-validate a parsed report WITHOUT emitting events, so
   *  a failed attempt leaves no partial durable history. Throws the
   *  correction-grade error (caught by the repair loop). */
  private async buildReportAttempt(
    request: HarnessRunRequest,
    result: SentryAgentReportV2,
    pipeline: EvidencePipelineContext,
  ): Promise<BuiltReportAttempt> {
    const evidenceByKey = new Map<string, Evidence>();
    const baselineIndex = await buildBaselineIndex(
      request.workspace.runtimePath,
      request.workspace.snapshotId,
    ).catch(() => undefined);
    for (const source of result.evidence) {
      const converted = await convertReportEvidence(request, source, pipeline, {
        observedCommands: this.observedCommands,
        operations: this.observedOperations,
        ...(baselineIndex === undefined ? {} : { baseline: baselineIndex }),
      });
      evidenceByKey.set(source.key, converted);
    }
    validateProductionFindings(result.findings, evidenceByKey, (message: string) =>
      pipeline.errors.invalidResult(message),
    );
    const findings: Finding[] = [];
    for (const source of result.findings) {
      for (const location of source.locations)
        await validateLocation(
          request.workspace.runtimePath,
          location.relativePath,
          pipeline,
          location.lineStart,
          location.lineEnd,
        );
      const { evidenceKeys, locations, ...findingFields } = source;
      findings.push(
        FindingSchema.parse({
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
        }),
      );
    }
    return { evidenceByKey, findings };
  }

  private async *streamTurnInner(
    turn: MuseTurnView,
    agentRunId: AgentRunId,
    session?: MuseSessionView,
    forbidTools = false,
  ): AsyncGenerator<HarnessEvent, TurnCollection> {
    let text = '';
    const drainDecisions = function* (): Generator<HarnessEvent> {
      // Defensive: test fakes and older sessions may omit the drain method.
      const drained = session?.drainApprovalDecisions?.() ?? [];
      for (const decision of drained) {
        yield event(agentRunId, {
          type: 'warning',
          code: decision.approved ? 'MUSE_APPROVAL_GRANTED' : 'MUSE_APPROVAL_DENIED',
          message:
            'Tool approval ' +
            (decision.approved ? 'granted' : 'denied') +
            ' for ' +
            decision.toolName +
            ' (' +
            decision.reason +
            ')',
        });
      }
    };
    for await (const item of turn.items()) {
      yield* drainDecisions();
      if (item.kind === 'reasoning') continue;
      // reminderChild items are host-internal reminder-plugin sessions (e.g.
      // skill-reminder, goal-reminder, verify-reminder): they carry no model
      // delegation, no objective, and no usable output. Verified against a
      // live 1.1.1 host, which emits them on even trivial turns. They are
      // skipped like reasoning, never persisted, never trusted as evidence.
      if (item.kind === 'reminderChild') continue;
      if (item.kind === 'subagent' || item.kind === 'workflow') {
        throw new MuseHarnessError(
          'MUSE_SUBAGENT_FORBIDDEN',
          'Muse attempted forbidden subagent fanout.',
        );
      }
      if (item.kind === 'agentMessage' && item.text !== undefined) text = item.text;
      if (item.kind === 'toolCall' || item.kind === 'userShell') {
        // Reporting firewall: the frozen ledger must not mutate. Any tool
        // attempt during reporting fails the report turn (never silently
        // incorporated, never observed as a new operation). The
        // attempted tool is named (bounded, redacted) for correction
        // feedback and run history.
        if (forbidTools) {
          const attempted = redactDiagnostic(
            item.kind === 'userShell' ? 'shell' : (item.tool ?? 'unknown'),
            this.secrets,
          ).slice(0, 100);
          throw new MuseHarnessError(
            'MUSE_REPORT_TOOL_FORBIDDEN',
            "Muse attempted tool '" + attempted + "' during the tool-free reporting turn.",
          );
        }
      } else continue;
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
          this.observedCommands.add(commandIdentity(command, item.exitCode));
          const toolName = item.kind === 'userShell' ? 'shell' : (item.tool ?? 'unknown');
          this.operationCounter += 1;
          const operationKey = 'op_' + this.operationCounter;
          this.observedOperations.set(operationKey, {
            operationId,
            operationKey,
            toolName,
            commandText: command,
            ...(item.args === undefined ? {} : { argsText: item.args }),
            exitCode: item.exitCode,
            isTestOperation: isTestCommand(command),
            ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
          });
          yield event(agentRunId, {
            type: 'command.executed',
            operationId,
            command,
            exitCode: item.exitCode,
            ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
          });
        } else if (item.kind === 'toolCall') {
          // Non-command tool operations (file reads, edits, browser, etc.)
          // also get correlation keys so runtime/log evidence can name them.
          const argsText = item.args;
          this.operationCounter += 1;
          const operationKey = 'op_' + this.operationCounter;
          this.observedOperations.set(operationKey, {
            operationId,
            operationKey,
            toolName: item.tool ?? 'unknown',
            ...(argsText === undefined ? {} : { argsText }),
            ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
            isTestOperation: isTestCommand(item.tool ?? '') || isTestCommand(argsText ?? ''),
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
      const compatibility = this.client.compatibility;
      if (compatibility !== undefined) {
        this.hostCompatibility = compatibility;
        // Unknown protocol states warn instead of being silently assumed:
        // a non-1 envelope schema version is a real compatibility risk.
        if (compatibility.schemaVersion !== undefined && compatibility.schemaVersion !== 1) {
          yield event(request.agentRunId, {
            type: 'warning',
            code: 'MUSE_SCHEMA_MISMATCH',
            message:
              'Muse host reports MSP envelope schema version ' +
              String(compatibility.schemaVersion) +
              '; Sentry expects version 1.',
          });
        }
      }
      const session = await this.client.startSession({
        workspaceRoot: request.workspace.runtimePath,
        modelId: this.runtime.modelId,
      });
      // Fail fast on fatal approvals: tear down ONLY the owned client
      // (bounded SDK close of the child it spawned) so the turn cannot park
      // until the watchdog. Never kills by process name.
      session.onFatalApproval?.((fatal: MuseFatalApproval) => {
        this.triggerApprovalFailFast(fatal);
      });
      // A real session started: ephemeral runtime verification for this process.
      markMuseRuntimeVerified();
      const pipeline = pipelineContext(this.secrets);
      // STAGE 1 — planning with one bounded correction. A prose-first or
      // misshapen plan retries once in the same session with the parse
      // error fed back; planning ops from both turns stay valid and
      // numbered (the ledger is not frozen yet). Strict parse every time.
      const planningOutcomes: Array<{ readonly outcome: MuseTurnOutcome }> = [];
      let planResult: ReturnType<typeof SentryInvestigationPlanV1Schema.parse> | undefined;
      let planCorrection: string[] | undefined;
      for (let attempt = 1; attempt <= MAX_PLANNING_ATTEMPTS; attempt += 1) {
        const planning = yield* this.streamTurn(
          await session.sendText(
            planCorrection === undefined
              ? planningPrompt(request)
              : buildPlanningCorrectionIntro(planCorrection) +
                  '\nImmutable mission context: ' +
                  JSON.stringify(request.task.context ?? {}),
            { phase: 'planning', tools: 'normal' },
          ),
          request.agentRunId,
          session,
          'planning',
        );
        assertCompleted(planning.outcome, 'planning');
        planningOutcomes.push({ outcome: planning.outcome });
        try {
          planResult = SentryInvestigationPlanV1Schema.parse(
            parseWholeJson(planning.text, 'planning', pipeline),
          );
          break;
        } catch (cause) {
          planCorrection = [boundCorrectionMessage(messageOf(cause))];
          if (attempt < MAX_PLANNING_ATTEMPTS) {
            yield event(request.agentRunId, {
              type: 'warning',
              code: 'MUSE_PLANNING_RETRY',
              message: 'Muse planning attempt ' + attempt + ' rejected; retrying planning only.',
            });
          } else {
            throw cause;
          }
        }
      }
      if (planResult === undefined)
        throw new MuseHarnessError('MUSE_INVALID_RESULT', 'Muse produced no plan.');
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
      // STAGE 2 — investigation only. Terminal prose is ignored (never
      // parsed as a result, never persisted as reasoning); tool events
      // below carry the evidentiary facts.
      const investigation = yield* this.streamTurn(
        await session.sendText(investigationPrompt(planResult), {
          phase: 'investigation',
          tools: 'normal',
        }),
        request.agentRunId,
        session,
        'investigation',
      );
      assertCompleted(investigation.outcome, 'investigation');
      // STAGE 3 — reporting against the frozen ledger. Bounded correction:
      // schema/trust failures retry the REPORT ONLY (same session, no
      // tools, same frozen ledger); investigation never reruns.
      yield event(request.agentRunId, {
        type: 'agent.status',
        status: 'reporting',
        message: 'Muse is serializing the frozen investigation into a report.',
      });
      const reportOutcomes: Array<{ readonly outcome: MuseTurnOutcome }> = [];
      let result: SentryAgentReportV2 | undefined;
      let built: BuiltReportAttempt | undefined;
      let correction: string[] | undefined;
      for (let attempt = 1; attempt <= MAX_REPORT_ATTEMPTS; attempt += 1) {
        // Firewall trip fails the REPORT ATTEMPT (not the run): the
        // correction loop tells the model to serialize without tools.
        let reporting: TurnCollection | undefined;
        let errors: string[] | undefined;
        try {
          reporting = yield* this.streamTurn(
            await session.sendText(reportPrompt(planResult, this.observedOperations, correction), {
              phase: 'reporting',
              tools: 'none',
            }),
            request.agentRunId,
            session,
            'reporting',
            true,
          );
        } catch (cause) {
          if (cause instanceof MuseHarnessError && cause.code === 'MUSE_REPORT_TOOL_FORBIDDEN') {
            errors = [
              boundCorrectionMessage(messageOf(cause)) +
                ' The reporting stage is tool-free: ' +
                'serialize ONLY from the investigation already completed, using ONLY the frozen ledger below. ' +
                'Do not run commands, read files, or use any tools.',
            ];
          } else {
            throw cause;
          }
        }
        if (reporting !== undefined) {
          assertCompleted(reporting.outcome, 'reporting');
          reportOutcomes.push({ outcome: reporting.outcome });
          // One attempt = strict parse + full conversion/trust validation,
          // all without emitting events. Any failure becomes bounded
          // correction feedback; the investigation never reruns.
          const candidate = parseReportAttempt(reporting.text, pipeline);
          if (!candidate.ok) {
            errors = candidate.errors;
          } else {
            try {
              built = await this.buildReportAttempt(request, candidate.report, pipeline);
              result = candidate.report;
              break;
            } catch (cause) {
              errors = [boundCorrectionMessage(messageOf(cause))];
            }
          }
        }
        if (errors === undefined) {
          throw new MuseHarnessError(
            'MUSE_INVALID_RESULT',
            'Muse report attempt produced no result and no error.',
          );
        }
        correction = errors;
        if (attempt < MAX_REPORT_ATTEMPTS) {
          yield event(request.agentRunId, {
            type: 'warning',
            code: 'MUSE_REPORT_RETRY',
            message:
              'Muse report attempt ' +
              attempt +
              ' rejected; retrying report only (' +
              errors.length +
              ' issues).',
          });
        } else {
          throw new MuseHarnessError(
            'MUSE_INVALID_RESULT',
            'Muse report failed after ' +
              MAX_REPORT_ATTEMPTS +
              ' attempts: ' +
              errors.map(boundCorrectionMessage).join('; '),
          );
        }
      }
      if (result === undefined || built === undefined)
        throw new MuseHarnessError('MUSE_INVALID_RESULT', 'Muse produced no report.');
      const attempt = built;
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
      for (const evidence of attempt.evidenceByKey.values())
        yield event(request.agentRunId, { type: 'evidence.submitted', evidence });
      for (const finding of attempt.findings)
        yield event(request.agentRunId, { type: 'finding.submitted', finding });
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
      // Actual turn accounting: every planning attempt + investigation +
      // every report attempt (initial and corrections). Never hardcoded.
      const usage = aggregateTurnUsage([
        ...planningOutcomes,
        { outcome: investigation.outcome },
        ...reportOutcomes,
      ]);
      if (usage !== undefined) yield event(request.agentRunId, { type: 'usage.updated', usage });
      // NOTE: dispose() runs after this stream ends (coordinator-owned
      // lifecycle), so partial-shutdown diagnostics surface via
      // getShutdownDiagnostics() and the coordinator persists them.
      yield event(request.agentRunId, {
        type: 'run.completed',
        ...(usage === undefined ? {} : { usage }),
      });
    } catch (cause) {
      if (this.approvalFatal !== undefined) {
        yield event(request.agentRunId, {
          type: 'warning',
          code: 'MUSE_APPROVAL_FATAL',
          message: redactDiagnostic(this.approvalFatal.message, this.secrets),
        });
      }
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

  private triggerApprovalFailFast(fatal: MuseFatalApproval): void {
    if (this.approvalFatal !== undefined) return;
    const error = new MuseHarnessError(
      'MUSE_INVALID_RESULT',
      'Muse approval could not be satisfied safely (tool=' +
        fatal.toolName +
        '): ' +
        fatal.reason +
        '. Owned session terminated promptly.',
    );
    this.approvalFatal = error;
    this.shutdownDiagnostics.push({
      code: 'MUSE_APPROVAL_FATAL',
      severity: 'error',
      message: 'Fatal approval failure tore down the owned Muse session promptly: ' + fatal.reason,
    });
    this.approvalAbortReject?.(error);
    void this.dispose().catch(() => undefined);
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
    // so record an observable diagnostic when shutdown confidence is partial.
    // The SDK facade does not expose the host PID, so no PID is claimed and
    // no process is ever targeted by name: the limitation is observed, not
    // worked around with unsafe kills.
    this.closePromise = (async () => {
      await client.close();
      if (process.platform === 'win32') {
        this.shutdownDiagnostics.push({
          code: 'MUSE_SHUTDOWN_PARTIAL',
          severity: 'warning',
          message:
            'Windows process-tree limitation: SDK shutdown closed the Muse host ' +
            'but descendant process-tree cleanup cannot be fully verified on Windows; ' +
            'orphaned grandchildren remain possible. Workspace cleanup still proceeds.',
        });
      }
    })();
    return this.closePromise;
  }

  getShutdownDiagnostics(): readonly HarnessDiagnostic[] {
    return this.shutdownDiagnostics;
  }

  runtimeIdentity() {
    return {
      // Requested/configured model through Muse. The host does not expose
      // authoritative provider-level execution identity, so this must never
      // be read as proof of which model weights served a turn.
      modelId: this.runtime.modelId,
      adapterId: 'muse-code',
      adapterVersion: '0.1.0',
      harnessVersion: this.serverVersion,
      sdkVersion: MUSE_SDK_VERSION,
      executable: this.runtime.executable,
    };
  }
}
