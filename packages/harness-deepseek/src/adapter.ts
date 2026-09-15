import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
  doctorDeepSeek,
  markDeepSeekRuntimeVerified,
  resolveDeepSeekRuntime,
  type DeepSeekRuntimeConfiguration,
} from './discovery.js';
import { buildDeepSeekChildEnvironment } from './environment.js';
import { DeepSeekHarnessError } from './errors.js';
import { buildRestrictedProfilePatch } from './profile.js';
import { redactDiagnostic, redactStructured, secretValues } from './redaction.js';
import {
  DEEPSEEK_SDK_VERSION,
  createProductionDeepSeekClient,
  type DeepSeekClientFactory,
  type DeepSeekClientView,
  type DeepSeekRunResult,
  type DeepSeekSessionView,
} from './sdk.js';

export interface DeepSeekHarnessAdapterOptions {
  readonly executable?: string;
  readonly modelId?: string;
  readonly provider?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly clientFactory?: DeepSeekClientFactory;
  readonly shutdownTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly onRuntimeIdentity?: (identity: {
    readonly harnessVersion?: string;
    readonly executableVersion?: string;
  }) => void;
}

export class DeepSeekTurnTimeoutError extends DeepSeekHarnessError {
  constructor(phase: string, budgetMs: number) {
    super(
      'DEEPSEEK_START_FAILED',
      'DeepSeek ' + phase + ' turn exceeded its ' + String(budgetMs) + ' ms budget.',
      true,
    );
    this.name = 'DeepSeekTurnTimeoutError';
  }
}

interface CollectedTurn {
  readonly text: string;
  readonly result: DeepSeekRunResult;
  readonly events: readonly HarnessEvent[];
  readonly usage?: AgentUsage | undefined;
}

/** Sum per-step token usage; unknown stays unknown (never zero). */
function sumUsage(first: AgentUsage | undefined, second: AgentUsage): AgentUsage {
  if (first === undefined) return second;
  const add = (a?: number, b?: number): number | undefined =>
    a === undefined ? b : b === undefined ? a : a + b;
  return {
    inputTokens: add(first.inputTokens, second.inputTokens),
    outputTokens: add(first.outputTokens, second.outputTokens),
    cachedInputTokens: add(first.cachedInputTokens, second.cachedInputTokens),
    turns: add(first.turns, second.turns),
    durationMs: add(first.durationMs, second.durationMs),
  };
}

/** Sentry-owned disposable home next to (never inside) the agent workspace. */
function sentryDshHome(workspaceRuntimePath: string): string {
  return join(dirname(workspaceRuntimePath), '.sentry-dshome');
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

function pipelineContext(secrets: readonly string[]): EvidencePipelineContext {
  return {
    errors: {
      invalidResult: (message: string) =>
        new DeepSeekHarnessError('DEEPSEEK_INVALID_RESULT', message),
    },
    authorLabel: 'DeepSeek Harness',
    secrets,
    redactDiagnostic: (value: string) => redactDiagnostic(value, secrets),
    redactStructured: (value: unknown) => redactStructured(value, secrets),
  };
}

type ReportAttempt = { ok: true; report: SentryAgentReportV2 } | { ok: false; errors: string[] };

function parseReportAttempt(text: string, pipeline: EvidencePipelineContext): ReportAttempt {
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

/** Vendor SDK initialize timeout (local host did not come up; no session
 *  started, nothing to corrupt). Only this narrow signal retries. */
function isInitializeTimeout(cause: unknown): boolean {
  return /initialize timed out/i.test(messageOf(cause));
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

/**
 * Minimal structural view over DeepSeek `SessionEvent` envelopes
 * (`{type, seq, time, data}` per `@deepseek-ai/dsh-session@0.1.5-rc.2`).
 * Tool correlation reads the `data` payload: `tool/call` carries
 * `{callId, name, arguments}`, `tool/result` carries `{message, error?,
 * meta?}`, and `assistant/message` carries `{usage?}`. Unknown shapes are
 * ignored for evidence (never trusted); only `data` fields the pinned
 * vocabulary documents are interpreted.
 */
interface SessionEventView {
  readonly type?: unknown;
  readonly data?: unknown;
}

interface ToolCallDataView {
  readonly callId?: unknown;
  readonly name?: unknown;
  readonly arguments?: unknown;
}

interface ToolResultDataView {
  readonly message?: unknown;
  readonly error?: unknown;
  readonly meta?: unknown;
}

interface AssistantMessageDataView {
  readonly usage?: unknown;
}

interface TokenUsageView {
  readonly inputTokens?: unknown;
  readonly outputTokens?: unknown;
  readonly cacheReadTokens?: unknown;
  readonly cacheWriteTokens?: unknown;
  readonly reasoningTokens?: unknown;
}

function eventText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function eventNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function eventData(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const data = (raw as SessionEventView).data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  return data as Record<string, unknown>;
}

/** Extract a shell command string from parsed tool-call arguments, if present. */
function commandFromToolArguments(toolName: string, argsText: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsText);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'script']) {
    const candidate = eventText(record[key]);
    if (candidate !== undefined) return candidate;
  }
  const argv = record['argv'];
  if (Array.isArray(argv)) {
    const parts = argv.filter((entry): entry is string => typeof entry === 'string');
    if (parts.length > 0) return parts.join(' ');
  }
  // File-operation tools: record the affected path as the operation's
  // argument text so evidence can reference what was touched.
  if (/file|read|write|edit|search|glob|patch/i.test(toolName)) {
    for (const key of ['path', 'file', 'filePath', 'pattern', 'query']) {
      const candidate = eventText(record[key]);
      if (candidate !== undefined) return candidate;
    }
  }
  return undefined;
}

/** Aggregate `TokenUsage` carried by an `assistant/message` data payload. */
function tokenUsageFromEvent(data: AssistantMessageDataView): AgentUsage | undefined {
  const usage = data.usage;
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const view = usage as TokenUsageView;
  const inputTokens = eventNumber(view.inputTokens);
  const outputTokens = eventNumber(view.outputTokens);
  const cacheReadTokens = eventNumber(view.cacheReadTokens);
  const cacheWriteTokens = eventNumber(view.cacheWriteTokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined
  )
    return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined && cacheWriteTokens === undefined
      ? {}
      : { cachedInputTokens: (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) }),
  };
}

/** Extract the tool-call correlation id from a tool-result message, if present. */
function toolCallIdFromResultMessage(message: unknown): string | undefined {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
    const record = block as { type?: unknown; toolCallId?: unknown };
    if (record.type === 'tool-result') {
      const callId = eventText(record.toolCallId);
      if (callId !== undefined) return callId;
    }
  }
  return undefined;
}

interface PendingToolCall {
  readonly operationId: OperationId;
  readonly toolName: string;
  readonly commandText: string;
}

function lastPendingCall(
  pending: ReadonlyMap<string, PendingToolCall>,
): PendingToolCall | undefined {
  let last: PendingToolCall | undefined;
  for (const entry of pending.values()) last = entry;
  return last;
}

/**
 * Parse the dsh-shell exit-status marker contract (`\n[exit code: N]` /
 * `\n[killed by signal: X]`, anchored to end of string). Mirrors
 * parseExitStatus in @deepseek-ai/dsh-shell: the marker is the runtime's
 * structured signal, and absent markers mean clean exit 0.
 */
function parseShellExitMarker(text: string): { exitCode: number } | { signal: string } | undefined {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text);
  if (signal?.[1] !== undefined) return { signal: signal[1] };
  const exit = /\n\[exit code: (\d+)\]$/.exec(text);
  if (exit?.[1] !== undefined) return { exitCode: Number(exit[1]) };
  return undefined;
}

/** Flatten tool-result message content blocks to bounded text for diagnostics. */
function textFromToolResultMessage(message: unknown): string {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return '';
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  // Tool results nest text inside tool-result wrapper blocks
  // ({type:'tool-result', content:[{type:'text',...}]}): recurse so exit-
  // status markers on inner text remain visible to the marker parser.
  const parts: string[] = [];
  const visit = (blocks: unknown[]): void => {
    for (const block of blocks) {
      if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
      const record = block as { text?: unknown; content?: unknown };
      const text = eventText(record.text);
      if (text !== undefined) parts.push(text);
      if (Array.isArray(record.content)) visit(record.content);
      if (parts.join('\n').length >= 4_000) break;
    }
  };
  visit(content);
  return parts.join('\n').slice(0, 4_000);
}

export class DeepSeekHarnessAdapter implements HarnessAdapter {
  private readonly hostEnvironment: NodeJS.ProcessEnv;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly childEnvironmentReport: {
    readonly allowedNames: readonly string[];
    readonly blockedNames: readonly string[];
  };
  private readonly runtime: DeepSeekRuntimeConfiguration;
  private readonly clientFactory: DeepSeekClientFactory;
  private readonly shutdownTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly secrets: readonly string[];
  private client?: DeepSeekClientView;
  private closePromise?: Promise<void>;
  private readonly operationIds = new Map<string, OperationId>();
  private readonly pendingToolCalls = new Map<string, PendingToolCall>();
  private readonly completedTools = new Set<string>();
  private readonly observedCommands = new Set<string>();
  private readonly observedOperations = new Map<string, ObservedOperation>();
  private operationCounter = 0;
  private readonly shutdownDiagnostics: HarnessDiagnostic[] = [];

  constructor(private readonly options: DeepSeekHarnessAdapterOptions = {}) {
    this.hostEnvironment = options.environment ?? process.env;
    this.runtime = resolveDeepSeekRuntime({ ...options, environment: this.hostEnvironment });
    this.clientFactory = options.clientFactory ?? createProductionDeepSeekClient;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 1_800_000;
    const child = buildDeepSeekChildEnvironment({ source: this.hostEnvironment });
    this.environment = child.environment;
    this.childEnvironmentReport = child;
    this.secrets = secretValues(this.hostEnvironment);
  }

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
      adapterId: 'deepseek-harness',
      adapterVersion: '0.1.0',
      protocolVersion: 1,
      displayName: 'DeepSeek Harness SDK Adapter',
      capabilities: {
        streaming: true,
        cancellation: true,
        filesystemRead: true,
        filesystemWrite: true,
        shell: true,
        browser: false,
        sessionResume: true,
        structuredOutput: true,
        usageReporting: true,
      },
      supportedModelPatterns: [this.runtime.modelId],
      supportedOperatingSystems: ['windows', 'linux', 'macos'],
    };
  }

  async healthCheck(): Promise<HarnessHealthResult> {
    return doctorDeepSeek({
      executable: this.runtime.executable,
      modelId: this.runtime.modelId,
      provider: this.runtime.provider,
      environment: this.hostEnvironment,
    });
  }

  /**
   * Interpret one `SessionEvent` envelope. Returns Sentry events plus any
   * token usage carried by `assistant/message` events.
   */
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

  private observeSessionEvent(
    raw: unknown,
    agentRunId: AgentRunId,
    emit: (value: Readonly<Record<string, unknown>>) => HarnessEvent,
    forbidTools = false,
  ): { events: HarnessEvent[]; usage?: AgentUsage } {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { events: [] };
    const envelope = raw as SessionEventView;
    const kind = eventText(envelope.type) ?? '';
    // Reporting firewall: the frozen ledger must not mutate. Any tool call
    // during reporting fails the report turn (never silently incorporated).
    // The attempted tool is named (bounded) for correction feedback.
    if (forbidTools && kind === 'tool/call') {
      const attempted = eventText((eventData(raw) as { name?: unknown } | undefined)?.name)?.slice(
        0,
        100,
      );
      throw new DeepSeekHarnessError(
        'DEEPSEEK_REPORT_TOOL_FORBIDDEN',
        "DeepSeek attempted tool '" +
          (attempted ?? 'unknown') +
          "' during the tool-free reporting turn.",
      );
    }
    const lowered = kind.toLowerCase();
    const data = eventData(raw);
    // Subagent fanout is forbidden: a child session owned by the model (not
    // Sentry) must fail the run, never execute silently beside it. The
    // signal is a subagent-typed session event or delegation vocabulary
    // inside its data payload.
    const dataText = data === undefined ? '' : JSON.stringify(data).slice(0, 2_000);
    if (
      lowered.includes('subagent') ||
      lowered.includes('delegate') ||
      lowered.includes('background_task') ||
      /"origin"\s*:\s*"subagent"|"delegationDepth"\s*:\s*[1-9]/i.test(dataText)
    ) {
      throw new DeepSeekHarnessError(
        'DEEPSEEK_SUBAGENT_FORBIDDEN',
        'DeepSeek attempted forbidden subagent fanout.',
      );
    }
    // Sandbox denials fail the run closed: an unenforceable sandbox must
    // never degrade to unconfined execution. Scoped to TOOL events only:
    // assistant/message text routinely discusses sandbox policy (including
    // echoes of our own safety instructions, which contain both "sandbox"
    // and "disabled") and must never trip the detector.
    if (
      (kind === 'tool/call' || kind === 'tool/result') &&
      /sandbox/i.test(dataText) &&
      /denied|unavailable|not permitted|forbidden|disabled/i.test(dataText)
    ) {
      throw new DeepSeekHarnessError(
        'DEEPSEEK_SANDBOX_UNAVAILABLE',
        'DeepSeek sandbox denied a workspace operation; failing closed.',
      );
    }
    if (kind === 'assistant/message' && data !== undefined) {
      const usage = tokenUsageFromEvent(data as AssistantMessageDataView);
      return usage === undefined ? { events: [] } : { events: [], usage };
    }
    if (kind === 'tool/call' && data !== undefined) {
      return { events: this.observeToolCall(data as ToolCallDataView, emit) };
    }
    if (kind === 'tool/result' && data !== undefined) {
      return { events: this.observeToolResult(data as ToolResultDataView, emit) };
    }
    return { events: [] };
  }

  private observeToolCall(
    data: ToolCallDataView,
    emit: (value: Readonly<Record<string, unknown>>) => HarnessEvent,
  ): HarnessEvent[] {
    const callId = eventText(data.callId) ?? 'call-' + this.operationCounter;
    const toolName = eventText(data.name) ?? 'unknown';
    const argsText = eventText(data.arguments) ?? '';
    const commandText = commandFromToolArguments(toolName, argsText) ?? argsText.slice(0, 500);
    let operationId = this.operationIds.get(callId);
    if (operationId !== undefined) return [];
    operationId = createOperationId();
    this.operationIds.set(callId, operationId);
    // Stash the call context so the later `tool/result` with the same
    // callId completes the same operation.
    this.pendingToolCalls.set(callId, { operationId, toolName, commandText });
    return [
      emit({
        type: 'tool.started',
        operationId,
        tool: {
          name: toolName,
          inputSummary: redactDiagnostic(commandText, this.secrets),
        },
      }),
    ];
  }

  private observeToolResult(
    data: ToolResultDataView,
    emit: (value: Readonly<Record<string, unknown>>) => HarnessEvent,
  ): HarnessEvent[] {
    const resultText = textFromToolResultMessage(data.message);
    const errorName = eventText((data.error as { name?: unknown } | undefined)?.name);
    const errorCode = eventText((data.error as { code?: unknown } | undefined)?.code);
    const failed = errorName !== undefined || errorCode !== undefined;
    // Correlate with the pending call by matching result-block call id.
    const resultCallId = toolCallIdFromResultMessage(data.message);
    const pending =
      (resultCallId !== undefined ? this.pendingToolCalls.get(resultCallId) : undefined) ??
      lastPendingCall(this.pendingToolCalls);
    const operationId = pending?.operationId ?? createOperationId();
    const toolName = pending?.toolName ?? 'unknown';
    const commandText = pending?.commandText;
    const itemId = resultCallId ?? 'result-' + this.operationCounter;
    if (this.completedTools.has(itemId)) return [];
    this.completedTools.add(itemId);
    if (resultCallId !== undefined) this.pendingToolCalls.delete(resultCallId);
    // Shell exit-status markers (dsh-shell render contract): the runtime
    // appends `\n[exit code: N]` / `\n[killed by signal: X]` to
    // model-facing shell results. Reading the marker is observation of the
    // runtime's own structured signal — the same contract its terminal
    // presentation parses — never inference from prose. Scoped to
    // shell-family tools; other tools' text is never code-mined.
    // CRITICAL: unknown stays unknown. A result with no marker, no
    // structured code, and no error field records NO code (never a
    // default 0): fabricating success for unobserved codes is exactly
    // the spoofing our own pipeline exists to reject.
    const marker = /^(bash|pwsh|powershell|shell|command)$/i.test(toolName)
      ? parseShellExitMarker(resultText)
      : undefined;
    const signalKilled = marker !== undefined && 'signal' in marker;
    const resolvedFailed = failed || signalKilled;
    const out: HarnessEvent[] = [
      emit({
        type: 'tool.completed',
        operationId,
        tool: { name: toolName, ...(resolvedFailed ? { exitCode: 1 } : {}) },
      }),
    ];
    if (commandText !== undefined && commandText.length > 0) {
      const command = redactDiagnostic(commandText, this.secrets);
      // Exit codes come ONLY from structured tool metadata or the shell
      // exit-status marker. No marker + no code + no error means UNKNOWN
      // (never default 0): the code stays undefined, no command.executed
      // event is emitted, and evidence citing a code for this operation
      // downgrades (weak) or fails (reproduced) in the pipeline.
      const structuredExit = eventNumber(
        (data.meta as { exitCode?: unknown } | undefined)?.exitCode,
      );
      const markerExit = marker !== undefined && 'exitCode' in marker ? marker.exitCode : undefined;
      const exitCode = structuredExit ?? markerExit;
      if (exitCode !== undefined) this.observedCommands.add(commandIdentity(command, exitCode));
      this.operationCounter += 1;
      const operationKey = 'op_' + this.operationCounter;
      this.observedOperations.set(operationKey, {
        operationId,
        operationKey,
        toolName,
        commandText: command,
        ...(exitCode === undefined ? {} : { exitCode }),
        isTestOperation: isTestCommand(toolName + ' ' + command),
      });
      if (exitCode !== undefined) {
        out.push(
          emit({
            type: 'command.executed',
            operationId,
            command,
            exitCode,
          }),
        );
      }
    }
    if (resultText.length > 0) {
      out.push(
        emit({
          type: 'agent.message',
          message: ('tool ' + toolName + ' result: ' + resultText).slice(0, 2_000),
        }),
      );
    }
    return out;
  }

  private async runTurn(
    session: DeepSeekSessionView,
    text: string,
    agentRunId: AgentRunId,
    phase: string,
    forbidTools = false,
  ): Promise<CollectedTurn> {
    const deadline = Date.now() + this.turnTimeoutMs;
    // Reporting tool denial is enforced adapter-side (observeSessionEvent
    // firewall): the DeepSeek session slot carries session routing, not
    // turn options, so no per-turn tool flag exists at this SDK layer.
    const runPromise = session.runText(text);
    const result = await (async (): Promise<DeepSeekRunResult> => {
      const budget = deadline - Date.now();
      if (budget <= 0) throw new DeepSeekTurnTimeoutError(phase, this.turnTimeoutMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          runPromise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new DeepSeekTurnTimeoutError(phase, this.turnTimeoutMs)),
              budget,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    const emit = (value: Readonly<Record<string, unknown>>): HarnessEvent =>
      event(agentRunId, value);
    const collected: HarnessEvent[] = [];
    let usage: AgentUsage | undefined;
    for (const raw of result.events ?? []) {
      try {
        const observed = this.observeSessionEvent(raw, agentRunId, emit, forbidTools);
        collected.push(...observed.events);
        if (observed.usage !== undefined) usage = sumUsage(usage, observed.usage);
      } catch (cause) {
        if (cause instanceof DeepSeekHarnessError) throw cause;
        throw new DeepSeekHarnessError(
          'DEEPSEEK_INVALID_RESULT',
          'DeepSeek session event could not be interpreted.',
        );
      }
    }
    return { text: result.finalResponse, result, events: collected, usage };
  }

  async *run(request: HarnessRunRequest): AsyncIterable<HarnessEvent> {
    yield event(request.agentRunId, { type: 'run.started' });
    yield event(request.agentRunId, {
      type: 'agent.status',
      status: 'planning',
      message: 'DeepSeek is creating a frozen investigation plan.',
    });
    try {
      // Sentry-owned disposable home + restricted profile, both outside the
      // agent-visible project tree. The patch pins workspace-write sandboxing
      // to this run's isolated workspace.
      const dshHome = sentryDshHome(request.workspace.runtimePath);
      await mkdir(dshHome, { recursive: true });
      const profilePatchPath = join(dshHome, 'sentry-restricted.cordis.yml');
      await writeFile(
        profilePatchPath,
        buildRestrictedProfilePatch(request.workspace.runtimePath),
        'utf8',
      );
      // Bounded client-initialize retry: the vendor host occasionally
      // fails to come up within its budget (observed live as
      // 'initialize timed out'). Initialization may complete inside the
      // factory or lazily at startSession, so BOTH are inside the retry
      // scope; anything else, or a second timeout, fails the run with
      // the original typed error. Never loops.
      const createClient = () =>
        this.clientFactory({
          executable: this.runtime.executable,
          cwd: request.workspace.runtimePath,
          dshHome,
          environment: this.environment,
          modelId: this.runtime.modelId,
          provider: this.runtime.provider,
          profilePatches: [profilePatchPath],
          initializeTimeoutMs: 30_000,
          shutdownTimeoutMs: this.shutdownTimeoutMs,
        });
      let session: DeepSeekSessionView;
      try {
        this.client = await createClient();
        session = await this.client.startSession({ sessionId: request.agentRunId });
      } catch (cause) {
        if (!isInitializeTimeout(cause)) throw cause;
        yield event(request.agentRunId, {
          type: 'warning',
          code: 'DEEPSEEK_INIT_RETRY',
          message: 'DeepSeek client initialize timed out; retrying once with a fresh client.',
        });
        await this.client?.close().catch(() => undefined);
        this.client = await createClient();
        session = await this.client.startSession({ sessionId: request.agentRunId });
      }
      markDeepSeekRuntimeVerified();
      const pipeline = pipelineContext(this.secrets);
      // STAGE 1 — planning with one bounded correction. A prose-first or
      // misshapen plan retries once in the same session with the parse
      // error fed back; planning ops stay valid (ledger not frozen yet).
      let planResult: ReturnType<typeof SentryInvestigationPlanV1Schema.parse> | undefined;
      let planCorrection: string[] | undefined;
      let planningUsage: AgentUsage | undefined;
      let planningTurns = 0;
      for (let attempt = 1; attempt <= MAX_PLANNING_ATTEMPTS; attempt += 1) {
        const planning = await this.runTurn(
          session,
          planCorrection === undefined
            ? planningPrompt(request)
            : buildPlanningCorrectionIntro(planCorrection) +
                '\nImmutable mission context: ' +
                JSON.stringify(request.task.context ?? {}),
          request.agentRunId,
          'planning',
        );
        for (const emitted of planning.events) yield emitted;
        planningTurns += 1;
        planningUsage = sumUsage(planningUsage, planning.usage ?? {});
        if (planning.text.trim().length === 0) {
          planCorrection = ['Planning turn produced no response.'];
        } else {
          try {
            planResult = SentryInvestigationPlanV1Schema.parse(
              parseWholeJson(planning.text, 'planning', pipeline),
            );
            break;
          } catch (cause) {
            planCorrection = [boundCorrectionMessage(messageOf(cause))];
          }
        }
        if (attempt < MAX_PLANNING_ATTEMPTS) {
          yield event(request.agentRunId, {
            type: 'warning',
            code: 'DEEPSEEK_PLANNING_RETRY',
            message: 'DeepSeek planning attempt ' + attempt + ' rejected; retrying planning only.',
          });
        } else {
          throw new DeepSeekHarnessError(
            'DEEPSEEK_INVALID_RESULT',
            'DeepSeek planning failed after ' +
              MAX_PLANNING_ATTEMPTS +
              ' attempts: ' +
              (planCorrection ?? []).map(boundCorrectionMessage).join('; '),
          );
        }
      }
      if (planResult === undefined)
        throw new DeepSeekHarnessError('DEEPSEEK_INVALID_RESULT', 'DeepSeek produced no plan.');
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
        message: 'DeepSeek is executing the frozen plan.',
      });
      // STAGE 2 — investigation only. Terminal prose is ignored (never
      // parsed as a result, never persisted as reasoning); tool events
      // carry the evidentiary facts.
      const investigation = await this.runTurn(
        session,
        investigationPrompt(planResult),
        request.agentRunId,
        'investigation',
      );
      for (const emitted of investigation.events) yield emitted;
      // STAGE 3 — reporting against the frozen ledger. Bounded correction:
      // schema/trust failures retry the REPORT ONLY (same session, no
      // tools, same frozen ledger); investigation never reruns.
      yield event(request.agentRunId, {
        type: 'agent.status',
        status: 'reporting',
        message: 'DeepSeek is serializing the frozen investigation into a report.',
      });
      const reportTurns: Array<{ usage?: AgentUsage }> = [];
      let result: SentryAgentReportV2 | undefined;
      let built: BuiltReportAttempt | undefined;
      let correction: string[] | undefined;
      for (let attempt = 1; attempt <= MAX_REPORT_ATTEMPTS; attempt += 1) {
        // Firewall trip fails the REPORT ATTEMPT (not the run): the
        // correction loop tells the model to serialize without tools.
        let reporting: CollectedTurn | undefined;
        let errors: string[] | undefined;
        try {
          reporting = await this.runTurn(
            session,
            reportPrompt(planResult, this.observedOperations, correction),
            request.agentRunId,
            'reporting',
            true,
          );
        } catch (cause) {
          if (
            cause instanceof DeepSeekHarnessError &&
            cause.code === 'DEEPSEEK_REPORT_TOOL_FORBIDDEN'
          ) {
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
          for (const emitted of reporting.events) yield emitted;
          reportTurns.push(reporting.usage === undefined ? {} : { usage: reporting.usage });
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
          throw new DeepSeekHarnessError(
            'DEEPSEEK_INVALID_RESULT',
            'DeepSeek report attempt produced no result and no error.',
          );
        }
        correction = errors;
        if (attempt < MAX_REPORT_ATTEMPTS) {
          yield event(request.agentRunId, {
            type: 'warning',
            code: 'DEEPSEEK_REPORT_RETRY',
            message:
              'DeepSeek report attempt ' +
              attempt +
              ' rejected; retrying report only (' +
              errors.length +
              ' issues).',
          });
        } else {
          throw new DeepSeekHarnessError(
            'DEEPSEEK_INVALID_RESULT',
            'DeepSeek report failed after ' +
              MAX_REPORT_ATTEMPTS +
              ' attempts: ' +
              errors.map(boundCorrectionMessage).join('; '),
          );
        }
      }
      if (result === undefined || built === undefined)
        throw new DeepSeekHarnessError('DEEPSEEK_INVALID_RESULT', 'DeepSeek produced no report.');
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
          code: 'DEEPSEEK_LIMITATION',
          message: limitation,
        });
      // Token usage is first-class: per-step usage observed on
      // `assistant/message` events sums across ALL turns. Unknown stays
      // unknown (never fabricated zero); turns count actual model turns
      // (every planning attempt + investigation + every report attempt).
      let summed = sumUsage(planningUsage, investigation.usage ?? {});
      for (const turn of reportTurns) summed = sumUsage(summed, turn.usage ?? {});
      const usage: AgentUsage = {
        ...summed,
        turns: planningTurns + 1 + reportTurns.length,
      };
      yield event(request.agentRunId, { type: 'usage.updated', usage });
      yield event(request.agentRunId, {
        type: 'run.completed',
        usage,
      });
    } catch (cause) {
      const typed =
        cause instanceof DeepSeekHarnessError
          ? cause
          : cause instanceof Error && cause.name === 'ZodError'
            ? new DeepSeekHarnessError(
                'DEEPSEEK_INVALID_RESULT',
                'DeepSeek returned data that did not match the required schema.',
              )
            : new DeepSeekHarnessError(
                /auth|credential|sign in|api key|unauthorized|401/i.test(String(cause))
                  ? 'DEEPSEEK_AUTH_FAILED'
                  : /sandbox/i.test(String(cause))
                    ? 'DEEPSEEK_SANDBOX_UNAVAILABLE'
                    : 'DEEPSEEK_START_FAILED',
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
      throw new DeepSeekHarnessError(
        'DEEPSEEK_CANCEL_FAILED',
        redactDiagnostic(cause, this.secrets),
        true,
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    const client = this.client;
    if (client === undefined) {
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }
    this.closePromise = (async () => {
      await client.close();
    })();
    return this.closePromise;
  }

  getShutdownDiagnostics(): readonly HarnessDiagnostic[] {
    return this.shutdownDiagnostics;
  }

  runtimeIdentity() {
    return {
      // Requested/configured model through DeepSeek Harness. The host does
      // not expose authoritative provider-level execution identity, so this
      // must never be read as proof of which model weights served a turn.
      modelId: this.runtime.modelId,
      provider: this.runtime.provider,
      adapterId: 'deepseek-harness',
      adapterVersion: '0.1.0',
      sdkVersion: DEEPSEEK_SDK_VERSION,
      executable: this.runtime.executable,
    };
  }
}
