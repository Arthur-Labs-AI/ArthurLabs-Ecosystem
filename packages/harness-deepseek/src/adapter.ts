import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RequestTimeoutError } from '@deepseek-ai/dsh-sdk-client';
import {
  createFindingId,
  createAgentRunId,
  createHarnessEventId,
  createInvestigationHypothesisId,
  createInvestigationPlanId,
  createOperationId,
  nowIsoTimestamp,
  type AgentRunId,
  type OperationId,
} from '@qa/shared';
import {
  canChallenge,
  limitPhase,
  reportAttemptDeadline,
  promisePhase,
  investigationDeadline,
  PhaseDeadlineReached,
  ObservedToolNotes,
  buildRecoveryReportContext,
  buildQaPlanningPrompt,
  buildQaInvestigationPrompt,
  buildQaReportPrompt,
  validationBudgetMs,
  reviewNeedsUpdate,
  boundedValidation,
  challengePrompt,
  coverageErrors,
  groundCoverage,
  resolveReportChecks,
  reportableDepthPlan,
  depthPolicy,
  boundCorrectionMessage,
  buildPlanningCorrectionIntro,
  buildBaselineIndex,
  commandIdentity,
  convertReportEvidence,
  isTestCommand,
  MAX_PLANNING_ATTEMPTS,
  MAX_REPORT_ATTEMPTS,
  parseWholeJson,
  summarizeSchemaIssues,
  validateLocation,
  validateProductionFindings,
  type EvidencePipelineContext,
  type ObservedOperation,
} from '@qa/evidence-pipeline';
import {
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
  const initializeTimeout = /^initialize timed out after \d+ms(?:\s|$)/i;
  if (cause instanceof RequestTimeoutError) return initializeTimeout.test(cause.message);
  // Some package managers can load a second SDK copy, making instanceof
  // unreliable. Keep the fallback bound to the SDK's documented method-first
  // timeout shape so unrelated request timeouts never restart the client.
  return cause instanceof Error && initializeTimeout.test(cause.message);
}

interface BuiltReportAttempt {
  readonly evidenceByKey: ReadonlyMap<string, Evidence>;
  readonly findings: readonly Finding[];
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
 * Parse explicit terminal status markers from the pinned shell renderers.
 * dsh-shell uses [exit code: N] / [killed by signal: X]; persistent Bash
 * uses [Command finished with exit code N], including 0 and empty output.
 * Absent or invalid markers leave the outcome unknown, never implicit 0.
 */
function parseShellExitMarker(text: string): { exitCode: number } | { signal: string } | undefined {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text);
  if (signal?.[1] !== undefined) return { signal: signal[1] };
  const persistent = /(?:^|\n)\[Command finished with exit code (\d+)\]$/.exec(text);
  if (persistent?.[1] !== undefined) {
    const exitCode = Number(persistent[1]);
    return Number.isSafeInteger(exitCode) ? { exitCode } : undefined;
  }
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
  private closePromise: Promise<void> | undefined;
  private cancelled = false;
  private readonly toolNotes = new ObservedToolNotes();
  private readonly operationIds = new Map<string, OperationId>();
  private readonly pendingToolCalls = new Map<string, PendingToolCall>();
  private readonly liveOpenOperations = new Map<OperationId, string>();
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
    // never degrade to unconfined execution. Scoped to FAILED tool results
    // only: a `tool/call` is the model asking (never the runtime refusing),
    // and result text that merely discusses sandboxes without a structured
    // error is observation, not refusal — it surfaces as a warning while
    // the result still completes its matching tool operation.
    // (Live evidence: two identical production refusals with zero mapped
    // tool events tripped on call-side wording, blocking real runs.)
    // assistant/message text never trips the detector.
    if (
      kind === 'tool/result' &&
      /sandbox/i.test(dataText) &&
      /denied|unavailable|not permitted|forbidden|disabled/i.test(dataText)
    ) {
      const errorBlock = (data as { error?: unknown } | undefined)?.error;
      const errorName =
        typeof errorBlock === 'object' && errorBlock !== null
          ? (eventText((errorBlock as { name?: unknown }).name) ??
            eventText((errorBlock as { code?: unknown }).code))
          : undefined;
      if (errorName !== undefined) {
        const toolName = eventText((data as { name?: unknown } | undefined)?.name) ?? 'unknown';
        throw new DeepSeekHarnessError(
          'DEEPSEEK_SANDBOX_UNAVAILABLE',
          'DeepSeek sandbox denied a workspace operation; failing closed. tool=' +
            toolName.slice(0, 100) +
            ' error=' +
            errorName.slice(0, 100) +
            ' detail=' +
            redactDiagnostic(dataText, this.secrets).slice(0, 300),
        );
      }
      return {
        events: [
          emit({
            type: 'warning',
            code: 'DEEPSEEK_SANDBOX_MENTION',
            message: (
              'Tool result mentions a sandbox limitation without a structured error; ' +
              'treated as observation, not refusal. ' +
              redactDiagnostic(dataText, this.secrets).slice(0, 300)
            ).slice(0, 500),
          }),
          ...this.observeToolResult(data as ToolResultDataView, emit),
        ],
      };
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
    // appends [exit code: N] / [killed by signal: X], and persistent Bash
    // appends [Command finished with exit code N] to model-facing shell
    // results. Reading the marker is observation of the
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
    onObserved?: (event: HarnessEvent) => void,
  ): Promise<CollectedTurn> {
    const deadline = Date.now() + this.turnTimeoutMs;
    // Reporting tool denial is enforced adapter-side (observeSessionEvent
    // firewall): the DeepSeek session slot carries session routing, not
    // turn options, so no per-turn tool flag exists at this SDK layer.
    const emit = (value: Readonly<Record<string, unknown>>): HarnessEvent =>
      event(agentRunId, value);
    const collected: HarnessEvent[] = [];
    let usage: AgentUsage | undefined;
    const observe = (raw: unknown): void => {
      try {
        // The pinned SDK resolves on idle even after a failed model request.
        // A structured terminal failure overrides any partial final text.
        if ((raw as { type?: unknown } | null)?.type === 'turn/end') {
          const reason = eventData(raw)?.reason;
          if (reason !== null && typeof reason === 'object') {
            const outcome = reason as { kind?: unknown; error?: unknown };
            if (outcome.kind === 'error') {
              const failure =
                outcome.error !== null && typeof outcome.error === 'object'
                  ? (outcome.error as { code?: unknown; status?: unknown; message?: unknown })
                  : undefined;
              const code = eventText(failure?.code) ?? 'UNKNOWN';
              const status = eventNumber(failure?.status);
              const auth =
                status === 401 ||
                status === 403 ||
                ['AUTH', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL'].includes(code);
              const diagnostic = `DeepSeek ${phase} failed: ${code}${status === undefined ? '' : ` (HTTP ${status})`}. ${eventText(failure?.message) ?? 'Provider request failed.'}`;
              throw new DeepSeekHarnessError(
                auth ? 'DEEPSEEK_AUTH_FAILED' : 'DEEPSEEK_PROVIDER_FAILED',
                redactDiagnostic(diagnostic, [...this.secrets, text]),
              );
            }
          }
        }
        const observed = this.observeSessionEvent(raw, agentRunId, emit, forbidTools);
        collected.push(...observed.events);
        for (const value of observed.events) this.toolNotes.add(value);
        for (const value of observed.events) onObserved?.(value);
        if (observed.usage !== undefined) usage = sumUsage(usage, observed.usage);
      } catch (cause) {
        if (cause instanceof DeepSeekHarnessError) throw cause;
        throw new DeepSeekHarnessError(
          'DEEPSEEK_INVALID_RESULT',
          'DeepSeek session event could not be interpreted.',
        );
      }
    };
    let active = true;
    let streamed = 0;
    let result: DeepSeekRunResult;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const budget = deadline - Date.now();
      if (budget <= 0) throw new DeepSeekTurnTimeoutError(phase, this.turnTimeoutMs);
      const runPromise = Promise.resolve().then(() =>
        session.runText(
          text,
          undefined,
          onObserved === undefined
            ? undefined
            : (raw) => {
                if (!active) return;
                streamed += 1;
                observe(raw);
              },
        ),
      );
      result = await Promise.race([
        runPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new DeepSeekTurnTimeoutError(phase, this.turnTimeoutMs)),
            budget,
          );
        }),
      ]);
    } finally {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    }
    // SDK callbacks are an ordered prefix of the final root event list. Buffered
    // fake/legacy clients supply no callback and still follow the same observer.
    for (const raw of (result.events ?? []).slice(streamed)) observe(raw);
    return { text: result.finalResponse, result, events: collected, usage };
  }

  /** Primary stages persist genuine observed events while the SDK turn is live. */
  private async *streamTurn(
    session: DeepSeekSessionView,
    text: string,
    agentRunId: AgentRunId,
    phase: string,
  ): AsyncGenerator<HarnessEvent, CollectedTurn> {
    const queue: HarnessEvent[] = [];
    let wake: (() => void) | undefined;
    let settled = false;
    let result: CollectedTurn | undefined;
    let failure: unknown;
    let failed = false;
    const signal = () => {
      wake?.();
      wake = undefined;
    };
    void this.runTurn(session, text, agentRunId, phase, false, (value) => {
      queue.push(value);
      signal();
    }).then(
      (value) => {
        result = value;
        settled = true;
        signal();
      },
      (cause) => {
        failure = cause;
        failed = true;
        settled = true;
        signal();
      },
    );
    try {
      while (!settled || queue.length > 0) {
        const value = queue.shift();
        if (value !== undefined) {
          if (value.type === 'tool.started')
            this.liveOpenOperations.set(value.operationId, value.tool.name);
          if (value.type === 'tool.completed') this.liveOpenOperations.delete(value.operationId);
          yield value;
        } else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
      if (failed) {
        // The SDK has no wire cancel: close only this owned client before yielding
        // a failure. This also detaches the callback when runText rejects.
        await this.dispose().catch(() => undefined);
        throw failure;
      }
      if (result === undefined)
        throw new DeepSeekHarnessError(
          'DEEPSEEK_INVALID_RESULT',
          'DeepSeek turn ended without a result.',
        );
      return result;
    } finally {
      // A consumer may stop on persistence/transport failure while a yield is
      // suspended. Iterator return must not leave the owned model running.
      if (!settled) await this.dispose();
    }
  }

  async *run(request: HarnessRunRequest): AsyncIterable<HarnessEvent> {
    yield event(request.agentRunId, { type: 'run.started' });
    if (depthPolicy(request.task.context) !== undefined) {
      yield event(request.agentRunId, {
        type: 'agent.message',
        message: 'QA_DEPTH_V1: independent validation enabled.',
      });
      const preparation = request.task.context?.['workspacePreparation'] as
        { status?: string; reason?: string } | undefined;
      if (preparation !== undefined)
        yield event(request.agentRunId, {
          type: 'agent.message',
          message: 'QA_PREPARATION_RECEIPT: ' + JSON.stringify(preparation),
        });
      if (preparation?.status === 'limited')
        yield event(request.agentRunId, {
          type: 'warning',
          code: 'QA_PREPARATION_LIMITED',
          message: preparation.reason ?? 'Workspace preparation is limited.',
        });
    }

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
      // 'initialize timed out'). The pinned SDK performs the real subprocess
      // startup and initialize handshake in client.start(), so that exact
      // operation stays inside the retry scope. Anything else, or a second timeout, fails the run with
      // the original typed error. Never loops.
      // Budget note: 120s per attempt. Two consecutive 30s-cliff timeouts
      // on WSL-against-/mnt/c checkouts (while Windows-native init is
      // instant) indicate host startup over the 9P bridge can exceed 30s
      // without being wedged; the retry alone cannot fix a too-small
      // budget. Timeouts still enforced, just calibrated to the slow path.
      const createClient = () =>
        this.clientFactory({
          executable: this.runtime.executable,
          cwd: request.workspace.runtimePath,
          dshHome,
          environment: this.environment,
          modelId: this.runtime.modelId,
          provider: this.runtime.provider,
          profilePatches: [profilePatchPath],
          initializeTimeoutMs: 120_000,
          shutdownTimeoutMs: this.shutdownTimeoutMs,
        });
      let session: DeepSeekSessionView;
      let recoveryContext = '';
      let recoveryUsed = false;
      const startReportContext = async () => {
        await this.dispose();
        if (this.cancelled)
          throw new DeepSeekHarnessError(
            'DEEPSEEK_CANCEL_FAILED',
            'Run was cancelled before report recovery.',
          );
        const candidate = await createClient();
        if (this.cancelled) {
          await candidate.close();
          throw new DeepSeekHarnessError(
            'DEEPSEEK_CANCEL_FAILED',
            'Run was cancelled before report recovery.',
          );
        }
        this.client = candidate;
        this.closePromise = undefined;
        await candidate.start();
        if (this.cancelled)
          throw new DeepSeekHarnessError(
            'DEEPSEEK_CANCEL_FAILED',
            'Run was cancelled before report recovery.',
          );
        session = await candidate.startSession({ sessionId: createAgentRunId() });
        if (this.cancelled)
          throw new DeepSeekHarnessError(
            'DEEPSEEK_CANCEL_FAILED',
            'Run was cancelled before report recovery.',
          );
        recoveryUsed = true;
        recoveryContext = buildRecoveryReportContext(request, this.toolNotes.render()) + '\n';
      };
      try {
        this.client = await createClient();
        await this.client.start();
        markDeepSeekRuntimeVerified();
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
        await this.client.start();
        markDeepSeekRuntimeVerified();
        session = await this.client.startSession({ sessionId: request.agentRunId });
      }
      const pipeline = pipelineContext(this.secrets);
      // STAGE 1 — planning with one bounded correction. A prose-first or
      // misshapen plan retries once in the same session with the parse
      // error fed back; planning ops stay valid (ledger not frozen yet).
      let planResult: ReturnType<typeof SentryInvestigationPlanV1Schema.parse> | undefined;
      let planCorrection: string[] | undefined;
      let planningUsage: AgentUsage | undefined;
      let planningTurns = 0;
      for (let attempt = 1; attempt <= MAX_PLANNING_ATTEMPTS; attempt += 1) {
        const planning = yield* this.streamTurn(
          session,
          planCorrection === undefined
            ? buildQaPlanningPrompt(request)
            : buildPlanningCorrectionIntro(planCorrection),
          request.agentRunId,
          'planning',
        );

        planningTurns += 1;
        planningUsage = sumUsage(planningUsage, planning.usage ?? {});
        if (planning.text.trim().length === 0) {
          planCorrection = ['Planning turn produced no response.'];
        } else {
          try {
            planResult = reportableDepthPlan(
              SentryInvestigationPlanV1Schema.parse(
                parseWholeJson(planning.text, 'planning', pipeline),
              ),
              depthPolicy(request.task.context) !== undefined,
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
      const depth = depthPolicy(request.task.context);
      let challenge: CollectedTurn | undefined;
      let validationIssued = 0;
      let reportingIssued = 0;
      let investigation: CollectedTurn | undefined;
      try {
        const work = this.streamTurn(
          session,
          buildQaInvestigationPrompt(planResult, this.observedOperations),
          request.agentRunId,
          'investigation',
        );
        investigation = yield* depth === undefined
          ? work
          : limitPhase(work, investigationDeadline(depth.deadlineAt), () => this.dispose());
      } catch (cause) {
        if (!(cause instanceof PhaseDeadlineReached) || this.cancelled) throw cause;
        this.liveOpenOperations.clear();
        await startReportContext();
        yield event(request.agentRunId, {
          type: 'warning',
          code: 'QA_INVESTIGATION_INCOMPLETE',
          message:
            'Investigation reached its phase deadline. Reporting from this agent’s own observed facts in a fresh report-only context; analysis is partial.',
        });
      }

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
      let checkpoint: { result: SentryAgentReportV2; built: BuiltReportAttempt } | undefined;
      let validationCleanupFailed = false;
      const stopValidation = async (): Promise<void> => {
        await (this.client?.close() ?? Promise.resolve());
      };
      for (let reportPass = 0; reportPass < (depth === undefined ? 1 : 2); reportPass += 1) {
        try {
          for (let attempt = 1; attempt <= MAX_REPORT_ATTEMPTS; attempt += 1) {
            // Firewall trip fails the REPORT ATTEMPT (not the run): the
            // correction loop tells the model to serialize without tools.
            let reporting: CollectedTurn | undefined;
            let errors: string[] | undefined;
            try {
              const reportText =
                recoveryContext +
                buildQaReportPrompt(
                  planResult,
                  this.observedOperations,
                  recoveryContext ? undefined : correction,
                );
              recoveryContext = '';
              reportingIssued += 1;
              if (reportPass === 0 && depth !== undefined) {
                reporting = yield* limitPhase(
                  promisePhase(() =>
                    this.runTurn(session, reportText, request.agentRunId, 'reporting', true),
                  ),
                  reportAttemptDeadline(depth.deadlineAt, attempt),
                  () => this.dispose(),
                  'Reporting',
                );
              } else
                reporting =
                  reportPass === 0
                    ? await this.runTurn(session, reportText, request.agentRunId, 'reporting', true)
                    : await boundedValidation(
                        () =>
                          this.runTurn(session, reportText, request.agentRunId, 'reporting', true),
                        Math.max(1, depth!.deadlineAt - Date.now() - 30_000),
                        stopValidation,
                      );
            } catch (cause) {
              if (
                cause instanceof PhaseDeadlineReached &&
                reportPass === 0 &&
                depth !== undefined &&
                attempt < MAX_REPORT_ATTEMPTS &&
                !this.cancelled
              ) {
                await startReportContext();
                errors = [
                  'Reporting time budget reached. Return a shorter complete report from observed facts only.',
                ];
              } else if (
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
                  const grounded =
                    depth === undefined
                      ? resolveReportChecks(planResult, candidate.report)
                      : groundCoverage(
                          resolveReportChecks(planResult, candidate.report),
                          this.observedOperations,
                        );
                  const missing = depth === undefined ? [] : coverageErrors(planResult, grounded);
                  if (missing.length > 0) throw new Error(missing.join('\n'));
                  built = await this.buildReportAttempt(request, grounded, pipeline);
                  result = grounded;
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
        } catch (cause) {
          if (checkpoint === undefined) throw cause;
          try {
            await stopValidation();
          } catch {
            validationCleanupFailed = true;
          }
          if (cause instanceof Error && cause.message === 'QA_VALIDATION_CLEANUP_FAILED')
            validationCleanupFailed = true;
          result = checkpoint.result;
          built = checkpoint.built;
          yield event(request.agentRunId, {
            type: 'warning',
            code: 'QA_VALIDATION_INCOMPLETE',
            message:
              'Optional refinement did not complete; the validated checkpoint report is retained. Analysis is partial.',
          });
          break;
        }
        if (result === undefined || built === undefined) break;
        if (reportPass > 0 || depth === undefined) break;
        checkpoint = { result, built };
        yield event(request.agentRunId, {
          type: 'report.checkpoint',
          findings: built.findings,
          evidence: [...built.evidenceByKey.values()],
        });
        yield event(request.agentRunId, {
          type: 'agent.message',
          message: 'QA_REPORT_CHECKPOINT_READY: valid report prepared before optional validation.',
        });
        if (recoveryUsed || !canChallenge(depth.deadlineAt)) {
          yield event(request.agentRunId, {
            type: 'warning',
            code: 'QA_CHALLENGE_NOT_RUN',
            message:
              'Remaining budget reserved for finalization; checkpoint report retained. Analysis is partial.',
          });
          break;
        }
        try {
          yield event(request.agentRunId, {
            type: 'agent.status',
            status: 'investigating',
            message:
              'Validating own findings with a bounded budget; checkpoint report is available.',
          });
          validationIssued += 1;
          challenge = await boundedValidation(
            () =>
              this.runTurn(
                session,
                challengePrompt(planResult),
                request.agentRunId,
                'investigation',
              ),
            validationBudgetMs(depth.deadlineAt),
            stopValidation,
          );
          for (const emitted of challenge.events) yield emitted;
          if (!reviewNeedsUpdate(challenge.text)) break;
        } catch (cause) {
          try {
            await stopValidation();
          } catch {
            validationCleanupFailed = true;
          }
          if (cause instanceof Error && cause.message === 'QA_VALIDATION_CLEANUP_FAILED')
            validationCleanupFailed = true;
          result = checkpoint.result;
          built = checkpoint.built;
          yield event(request.agentRunId, {
            type: 'warning',
            code: 'QA_VALIDATION_INCOMPLETE',
            message:
              'Validation stopped within its own budget; checkpoint report retained. Analysis is partial.',
          });
          break;
        }
        result = undefined;
        built = undefined;
        correction = undefined;
        yield event(request.agentRunId, {
          type: 'agent.status',
          status: 'reporting',
          message: 'Refining the checkpoint report against the final operation ledger.',
        });
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
      if (
        depth !== undefined &&
        result.checks.some((check) => ['not_run', 'inconclusive'].includes(check.status))
      )
        yield event(request.agentRunId, {
          type: 'warning',
          code: 'QA_COVERAGE_PARTIAL',
          message: 'Analysis is partial: applicable planned checks remain unverified.',
        });
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
      let summed = sumUsage(planningUsage, investigation?.usage ?? {});
      if (challenge !== undefined) summed = sumUsage(summed, challenge.usage ?? {});
      for (const turn of reportTurns) summed = sumUsage(summed, turn.usage ?? {});
      const usage: AgentUsage = {
        ...summed,
        turns: planningTurns + 1 + validationIssued + reportingIssued,
      };
      yield event(request.agentRunId, { type: 'usage.updated', usage });
      if (validationCleanupFailed) {
        yield event(request.agentRunId, {
          type: 'run.failed',
          failure: {
            code: 'QA_VALIDATION_CLEANUP_FAILED',
            message:
              'Validation process cleanup could not be confirmed; checkpoint output was retained.',
            retryable: false,
          },
        });
      } else {
        yield event(request.agentRunId, {
          type: 'run.completed',
          usage,
        });
      }
    } catch (cause) {
      const typed =
        cause instanceof PhaseDeadlineReached
          ? new DeepSeekHarnessError('QA_REPORT_DEADLINE', cause.message, false)
          : cause instanceof DeepSeekHarnessError
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
      for (const [operationId, name] of this.liveOpenOperations)
        yield event(request.agentRunId, {
          type: 'tool.completed',
          operationId,
          tool: { name, errorPreview: 'Turn interrupted before a tool outcome was observed.' },
        });
      this.liveOpenOperations.clear();
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
    this.cancelled = true;
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
