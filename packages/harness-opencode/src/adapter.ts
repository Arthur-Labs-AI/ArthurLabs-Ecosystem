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
  REPORT_REPRODUCTION_CONTRACT,
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
  assertSupportedOpenCodeProvider,
  credentialEnvForProvider,
  doctorOpenCode,
  markOpenCodeRuntimeVerified,
  openCodeCatalogMode,
  openCodeCredential,
  openCodeSandboxBypassed,
  openCodeUpstreamBaseUrl,
  resolveOpenCodeRuntime,
  upstreamHostForDiagnostics,
  type OpenCodeRuntimeConfiguration,
} from './discovery.js';
import {
  applyOpenCodeScopeEnvironment,
  applyOpenCodeTurnEnvironment,
  buildOpenCodeChildEnvironment,
  buildOpenCodeProviderConfig,
  buildOpenCodeToolEnvironment,
} from './environment.js';
import { OpenCodeHarnessError } from './errors.js';
import { redactDiagnostic, redactStructured, secretValues } from './redaction.js';
import {
  cleanupOpenCodeRunScope,
  createOpenCodeRunScope,
  maskProjectOpenCodeConfig,
  type OpenCodeRunScope,
} from './scope.js';
import { findExecutable } from './process.js';
import { SENTRY_PROXY_DUMMY_KEY, startOpenCodeAuthProxy, type OpenCodeAuthProxy } from './proxy.js';
import { computeToolHiddenPaths, writeToolShellWrapper } from './toolshell.js';
import {
  createProductionOpenCodeClient,
  type OpenCodeClientFactory,
  type OpenCodeClientView,
  type OpenCodePromptResult,
  type OpenCodeSessionView,
} from './client.js';
import type { OpenCodeToolObservation } from './wire.js';

export interface OpenCodeHarnessAdapterOptions {
  readonly executable?: string;
  /**
   * Sentry-managed candidate (derived from the runtime data root by the
   * host, e.g. `<dataRoot>/tools/opencode/...`). Used only when neither
   * an explicit executable nor SENTRY_OPENCODE_BINARY is set, and only
   * when it exists and is executable; never silently overrides config.
   */
  readonly managedExecutable?: string;
  readonly modelId?: string;
  /** Provider id for the OpenCode session; default 'openrouter'. */
  readonly provider?: string;
  /**
   * Advanced: direct provider endpoint (OpenAI-compatible base URL) that
   * BYPASSES the localhost proxy in turn config, e.g. the zero-credit
   * test stub. Implies custom SDK/table handling via `providerNpm` /
   * `providerModels`. Production paths leave this unset.
   */
  readonly providerBaseUrl?: string;
  /**
   * Advanced: upstream override for the localhost proxy itself, keeping
   * the production config shape (options-only). Used by transport
   * contract tests to capture real-binary routes without provider credit.
   */
  readonly proxyUpstreamBaseUrl?: string;
  readonly providerNpm?: string;
  readonly providerModels?: Readonly<Record<string, Record<string, unknown>>>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly clientFactory?: OpenCodeClientFactory;
  readonly shutdownTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly onRuntimeIdentity?: (identity: {
    readonly harnessVersion?: string;
    readonly executableVersion?: string;
  }) => void;
}

export class OpenCodeTurnTimeoutError extends OpenCodeHarnessError {
  constructor(phase: string, budgetMs: number) {
    super(
      'OPENCODE_START_FAILED',
      'OpenCode ' + phase + ' turn exceeded its ' + String(budgetMs) + ' ms budget.',
      true,
    );
    this.name = 'OpenCodeTurnTimeoutError';
  }
}

interface CollectedTurn {
  readonly text: string;
  readonly observations: readonly OpenCodeToolObservation[];
  readonly events: readonly HarnessEvent[];
  readonly usage?: AgentUsage | undefined;
  readonly steps: number;
}

/** Owned per-AgentRun execution state (Sentry IDs and OpenCode IDs tracked separately). */
interface OpenCodeRunEntry {
  readonly agentRunId: AgentRunId;
  /** OpenCode-owned conversation id, captured from turn 1 envelopes. Never forced equal to agentRunId. */
  openCodeSessionId?: string | undefined;
  /** Turns already issued: every turn after the first must continue the captured session. */
  turnsIssued: number;
  scope?: OpenCodeRunScope | undefined;
  proxy?: OpenCodeAuthProxy | undefined;
  session?: OpenCodeSessionView | undefined;
  client?: OpenCodeClientView | undefined;
  maskedConfig: readonly string[];
  turnBase?: NodeJS.ProcessEnv | undefined;
  readonly controller: AbortController;
}

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
        new OpenCodeHarnessError('OPENCODE_INVALID_RESULT', message),
    },
    authorLabel: 'OpenCode Harness',
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
    'OUTPUT CONTRACT (must hold exactly): your ENTIRE final response is exactly one raw JSON object matching the schema. No Markdown. No code fences. No preamble, introduction, explanation, or closing sentence. The first character is { and the last character is }. Any additional text invalidates the response.',
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
    'For each significant candidate bug, determine whether its behavior can be safely reproduced in this workspace; when feasible, run a narrow focused reproduction command or test and observe the result (exploration commands like grep, cat, ls, or rg do not count as reproduction). Preserve the operation key: the frozen ledger in the reporting turn is the only provenance the final report may cite.',
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
    REPORT_REPRODUCTION_CONTRACT,
    REPORT_CONFIDENCE_CALIBRATION,
    'Finding category MUST be exactly one of: build, runtime, logic, api, frontend, database, authentication, authorization, security, configuration, performance, concurrency, dependency, testing, cicd, deployment, maintainability, documentation, other. Copy the string exactly; any other value fails validation. Severity MUST be exactly one of: critical, high, medium, low, info.',
    'Report evidence contract (exact fields per type; copy names exactly): ' +
      describeSentryAgentReportContract(),
    REPORT_ENVELOPE_SCHEMA,
    'Authoritative Sentry operation ledger (frozen after investigation):\n' +
      renderFrozenLedger(operations),
    'Frozen plan: ' + JSON.stringify(plan),
    'OUTPUT CONTRACT (must hold exactly): your ENTIRE final response is exactly one raw JSON object matching SentryAgentReportV2 (schemaVersion 2). No Markdown. No code fences. No preamble, introduction, explanation, or closing sentence. The first character is { and the last character is }. Any additional text invalidates the response.',
  ].join('\n');
}

/** Extract a shell command or file path from tool-call input, if present. */
function commandFromToolInput(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const key of ['command', 'cmd', 'script']) {
    const candidate = typeof input[key] === 'string' ? (input[key] as string).trim() : '';
    if (candidate.length > 0) return candidate.slice(0, 500);
  }
  const argv = input['argv'];
  if (Array.isArray(argv)) {
    const parts = argv.filter((entry): entry is string => typeof entry === 'string');
    if (parts.length > 0) return parts.join(' ').slice(0, 500);
  }
  if (/file|read|write|edit|search|glob|patch/i.test(toolName)) {
    for (const key of ['path', 'file', 'filePath', 'pattern', 'query']) {
      const candidate = typeof input[key] === 'string' ? (input[key] as string).trim() : '';
      if (candidate.length > 0) return candidate.slice(0, 500);
    }
  }
  return undefined;
}

export class OpenCodeHarnessAdapter implements HarnessAdapter {
  private readonly hostEnvironment: NodeJS.ProcessEnv;
  private readonly baseEnvironment: NodeJS.ProcessEnv;
  private readonly childEnvironmentReport: {
    readonly allowedNames: readonly string[];
    readonly blockedNames: readonly string[];
  };
  private readonly runtime: OpenCodeRuntimeConfiguration;
  private readonly clientFactory: OpenCodeClientFactory;
  private readonly shutdownTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly secrets: readonly string[];
  private readonly sessions = new Map<string, OpenCodeRunEntry>();
  private readonly observedCommands = new Set<string>();
  private readonly observedOperations = new Map<string, ObservedOperation>();
  private operationCounter = 0;
  private cancelledRuns = new Set<string>();
  private readonly shutdownDiagnostics: HarnessDiagnostic[] = [];

  constructor(private readonly options: OpenCodeHarnessAdapterOptions = {}) {
    this.hostEnvironment = options.environment ?? process.env;
    this.runtime = resolveOpenCodeRuntime({ ...options, environment: this.hostEnvironment });
    this.clientFactory = options.clientFactory ?? createProductionOpenCodeClient;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 1_800_000;
    const child = buildOpenCodeChildEnvironment({ source: this.hostEnvironment });
    this.baseEnvironment = child.environment;
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

  /** Tool-observable environment proving secret isolation (tested). */
  toolEnvironmentNames(): {
    readonly allowed: readonly string[];
    readonly blocked: readonly string[];
  } {
    const tool = buildOpenCodeToolEnvironment(this.baseEnvironment);
    return { allowed: tool.allowedNames, blocked: tool.blockedNames };
  }

  async getMetadata(): Promise<HarnessMetadata> {
    return {
      adapterId: 'opencode',
      adapterVersion: '0.1.0',
      protocolVersion: 1,
      displayName: 'OpenCode Harness Adapter',
      capabilities: {
        streaming: false,
        cancellation: true,
        filesystemRead: true,
        filesystemWrite: true,
        shell: true,
        browser: false,
        sessionResume: true,
        structuredOutput: true,
        usageReporting: true,
      },
      supportedModelPatterns: [this.runtime.effectiveModelId],
      supportedOperatingSystems: ['windows', 'linux', 'macos'],
    };
  }

  async healthCheck(): Promise<HarnessHealthResult> {
    return doctorOpenCode({
      executable: this.runtime.executable,
      modelId: this.runtime.modelId,
      provider: this.runtime.provider,
      environment: this.hostEnvironment,
    });
  }

  /**
   * Map one observed terminal OpenCode tool execution to correlated Sentry
   * events. `tool.started` + `tool.completed` are normalized together from
   * the single terminal observation (documented normalization: OpenCode's
   * headless stream reports terminal tool states, not live transitions;
   * event timestamps are Sentry observation times by construction).
   * Correlation uses one fresh Sentry operation id per observation; the
   * OpenCode `callID` is carried for diagnostics only.
   *
   * Exit codes come ONLY from `state.metadata.exit` (observed, exact).
   * Unknown stays unknown: no `command.executed`, no exit code anywhere.
   * Failures without exit codes carry a redacted `errorPreview` instead —
   * the schema's designated channel, never a fabricated code.
   */
  private observeTool(
    observation: OpenCodeToolObservation,
    agentRunId: AgentRunId,
    emit: (value: Readonly<Record<string, unknown>>) => HarnessEvent,
  ): HarnessEvent[] {
    if (observation.tool === 'task') {
      // The `task` tool spawns autonomous subagent sessions (verified:
      // child session with parentSessionId). Sentry agents stay independent.
      throw new OpenCodeHarnessError(
        'OPENCODE_SUBAGENT_FORBIDDEN',
        'OpenCode attempted subagent delegation (task tool), which Sentry forbids.',
      );
    }
    const operationId: OperationId = createOperationId();
    const commandText = commandFromToolInput(observation.tool, observation.input) ?? '';
    const out: HarnessEvent[] = [
      emit({
        type: 'tool.started',
        operationId,
        tool: {
          name: observation.tool,
          ...(commandText.length === 0
            ? {}
            : { inputSummary: redactDiagnostic(commandText, this.secrets) }),
        },
      }),
    ];
    const exitCode = observation.exitCode;
    const errorPreview =
      observation.error === undefined
        ? undefined
        : redactDiagnostic(observation.error, this.secrets).slice(0, 1000);
    out.push(
      emit({
        type: 'tool.completed',
        operationId,
        tool: {
          name: observation.tool,
          ...(exitCode === undefined ? {} : { exitCode }),
          ...(observation.durationMs === undefined ? {} : { durationMs: observation.durationMs }),
          ...(errorPreview === undefined || errorPreview.length === 0 ? {} : { errorPreview }),
        },
      }),
    );
    if (commandText.length > 0 && observation.tool !== 'invalid') {
      const command = redactDiagnostic(commandText, this.secrets);
      if (exitCode !== undefined) {
        this.observedCommands.add(commandIdentity(command, exitCode));
        out.push(
          emit({
            type: 'command.executed',
            operationId,
            command,
            exitCode,
          }),
        );
      }
      this.operationCounter += 1;
      const operationKey = 'op_' + this.operationCounter;
      this.observedOperations.set(operationKey, {
        operationId,
        operationKey,
        toolName: observation.tool,
        commandText: command,
        ...(exitCode === undefined ? {} : { exitCode }),
        isTestOperation: isTestCommand(observation.tool + ' ' + command),
      });
    }
    if (observation.status === 'completed' && observation.output !== undefined) {
      const summary = redactDiagnostic(observation.output.trim(), this.secrets).slice(0, 1000);
      if (summary.length > 0) {
        out.push(
          emit({
            type: 'agent.message',
            message: ('observed tool ' + observation.tool + ' output: ' + summary).slice(0, 2000),
          }),
        );
      }
    }
    return out;
  }

  /**
   * Build the per-run turn base: scope dirs, localhost proxy endpoint,
   * tool shell wrapper (Linux), all baked into turn config content.
   * The real credential never leaves proxy/runtime memory.
   */
  private async buildTurnBase(
    request: HarnessRunRequest,
    scope: OpenCodeRunScope,
    proxy: OpenCodeAuthProxy,
  ): Promise<NodeJS.ProcessEnv> {
    const scoped = applyOpenCodeScopeEnvironment(this.baseEnvironment, scope);
    let shell: string | undefined;
    if (process.platform === 'linux') {
      shell = await this.buildToolShell(request, scope);
    } else {
      this.shutdownDiagnostics.push({
        code: 'OPENCODE_DIRECT_SHELL',
        severity: 'warning',
        message:
          'Tool shell namespace unavailable off Linux: model shells run without mount isolation (development only).',
        retryable: false,
      });
    }
    // SDK/transport selection preserves OpenCode's own catalog: native and
    // opencode-catalog modes override ONLY connection options (baseURL to
    // the localhost proxy, dummy key, shell) so each model keeps its
    // verified SDK + wire protocol (responses/chat/messages). Only explicit
    // test/gateway seams inject npm/models/endpoint (custom mode).
    const directEndpoint = this.options.providerBaseUrl;
    const catalogMode = openCodeCatalogMode({
      provider: this.runtime.provider,
      ...(this.options.providerNpm === undefined ? {} : { customNpm: this.options.providerNpm }),
      ...(this.options.providerModels === undefined
        ? {}
        : { customModels: this.options.providerModels }),
      ...(directEndpoint === undefined ? {} : { directEndpoint }),
    });
    this.shutdownDiagnostics.push({
      code: 'OPENCODE_PROVIDER_TRANSPORT',
      severity: 'info',
      message:
        'OpenCode provider ' +
        this.runtime.provider +
        ' model ' +
        this.runtime.effectiveModelId +
        ' catalog mode ' +
        catalogMode +
        ' (names only, no credentials).',
      retryable: false,
    });
    const configContent = buildOpenCodeProviderConfig({
      provider: this.runtime.provider,
      baseUrl: directEndpoint ?? proxy.baseUrl,
      // Dummy key satisfies SDK key requirements; the proxy swaps the real one.
      // Omitted for direct endpoints that need no key at all.
      ...(directEndpoint === undefined ? { apiKey: SENTRY_PROXY_DUMMY_KEY } : {}),
      ...(catalogMode === 'custom'
        ? {
            ...(this.options.providerNpm === undefined ? {} : { npm: this.options.providerNpm }),
            ...(this.options.providerModels === undefined
              ? {}
              : { models: this.options.providerModels }),
          }
        : {}),
      ...(shell === undefined ? {} : { shell }),
    });
    return { ...scoped, OPENCODE_CONFIG_CONTENT: configContent };
  }

  /**
   * Generate the bwrap tool shell wrapper (Linux production only).
   * Returns undefined only when weaker execution is explicitly allowed
   * (SENTRY_OPENCODE_ALLOW_DIRECT=1, development/test only).
   */
  private async buildToolShell(
    request: HarnessRunRequest,
    scope: OpenCodeRunScope,
  ): Promise<string | undefined> {
    if (openCodeSandboxBypassed(this.hostEnvironment)) {
      this.shutdownDiagnostics.push({
        code: 'OPENCODE_DIRECT_SHELL',
        severity: 'warning',
        message: 'Tool shell namespace bypassed by explicit opt-in (development only).',
        retryable: false,
      });
      return undefined;
    }
    const bwrap = await findExecutable(['/usr/bin/bwrap', '/bin/bwrap', 'bwrap']);
    if (bwrap === undefined) {
      throw new OpenCodeHarnessError(
        'OPENCODE_SANDBOX_UNAVAILABLE',
        'bubblewrap is required for OpenCode tool isolation on Linux.',
      );
    }
    const realShell = await findExecutable(['/bin/bash', '/usr/bin/bash', 'bash']);
    if (realShell === undefined) {
      throw new OpenCodeHarnessError(
        'OPENCODE_SANDBOX_UNAVAILABLE',
        'A POSIX shell is required for OpenCode tool isolation on Linux.',
      );
    }
    const realHome = this.hostEnvironment.HOME;
    return writeToolShellWrapper({
      scopeBinDir: scope.binDir,
      spec: {
        realShell,
        bwrap,
        hidePaths: computeToolHiddenPaths({
          scopeDir: scope.directory,
          workspace: request.workspace.runtimePath,
          ...(realHome === undefined || realHome.length === 0 ? {} : { realHome }),
        }),
        runTmp: scope.runTmp,
        scopeHome: scope.home,
        workspace: request.workspace.runtimePath,
      },
    });
  }

  private turnEnvironment(entry: OpenCodeRunEntry, forbidTools: boolean): NodeJS.ProcessEnv {
    const base = entry.turnBase ?? this.baseEnvironment;
    return applyOpenCodeTurnEnvironment(base, {
      configContent:
        base['OPENCODE_CONFIG_CONTENT'] ??
        buildOpenCodeProviderConfig({ provider: this.runtime.provider }),
      forbidTools,
    });
  }

  private async runTurn(
    entry: OpenCodeRunEntry,
    text: string,
    agentRunId: AgentRunId,
    phase: string,
    forbidTools = false,
  ): Promise<CollectedTurn> {
    const session = entry.session;
    if (session === undefined) {
      throw new OpenCodeHarnessError(
        'OPENCODE_CANCEL_FAILED',
        'OpenCode session ended before the ' + phase + ' turn.',
      );
    }
    // Fail closed on lost continuity: every turn after the first must
    // continue the captured OpenCode session, never silently start fresh.
    if (entry.turnsIssued > 0 && entry.openCodeSessionId === undefined) {
      throw new OpenCodeHarnessError(
        'OPENCODE_SESSION_MISMATCH',
        'OpenCode turn ' + phase + ' has no session to continue.',
        true,
      );
    }
    const deadline = Date.now() + this.turnTimeoutMs;
    const budget = deadline - Date.now();
    if (budget <= 0) throw new OpenCodeTurnTimeoutError(phase, this.turnTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result: OpenCodePromptResult = await Promise.race([
        session.runPrompt(text, {
          timeoutMs: budget,
          signal: entry.controller.signal,
          ...(entry.openCodeSessionId === undefined ? {} : { sessionId: entry.openCodeSessionId }),
          environment: this.turnEnvironment(entry, forbidTools),
          context: { provider: this.runtime.provider, model: this.runtime.effectiveModelId },
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new OpenCodeTurnTimeoutError(phase, this.turnTimeoutMs)),
            budget,
          );
        }),
      ]);
      if (entry.openCodeSessionId === undefined) {
        // First turn must establish the session; later turns must return it.
        if (result.sessionId === undefined) {
          throw new OpenCodeHarnessError(
            'OPENCODE_SESSION_MISMATCH',
            'OpenCode turn ' + phase + ' established no session.',
            true,
          );
        }
        entry.openCodeSessionId = result.sessionId;
      } else if (result.sessionId !== undefined && result.sessionId !== entry.openCodeSessionId) {
        throw new OpenCodeHarnessError(
          'OPENCODE_SESSION_MISMATCH',
          'OpenCode turn ' +
            phase +
            ' returned an unexpected session; refusing to switch conversations.',
        );
      }
      entry.turnsIssued += 1;
      if (forbidTools && result.toolCalls.length > 0) {
        // Upstream deny-all should already have prevented execution; this
        // firewall rejects anything that slipped through (never silently
        // incorporated into the report).
        throw new OpenCodeHarnessError(
          'OPENCODE_REPORT_TOOL_FORBIDDEN',
          'OpenCode used tools during the reporting turn, which must serialize from the frozen ledger only.',
        );
      }
      const emit = (value: Readonly<Record<string, unknown>>): HarnessEvent =>
        event(agentRunId, value);
      const collected: HarnessEvent[] = [];
      for (const observation of result.toolCalls) {
        collected.push(...this.observeTool(observation, agentRunId, emit));
      }
      return {
        text: result.text,
        observations: result.toolCalls,
        events: collected,
        usage: result.usage,
        steps: result.steps,
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

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

  async *run(request: HarnessRunRequest): AsyncIterable<HarnessEvent> {
    yield event(request.agentRunId, { type: 'run.started' });
    yield event(request.agentRunId, {
      type: 'agent.status',
      status: 'planning',
      message: 'OpenCode is creating a frozen investigation plan.',
    });
    const entry: OpenCodeRunEntry = {
      agentRunId: request.agentRunId,
      turnsIssued: 0,
      maskedConfig: [],
      controller: new AbortController(),
    };
    this.sessions.set(request.agentRunId, entry);
    try {
      if (this.cancelledRuns.has(request.agentRunId)) {
        throw new OpenCodeHarnessError('OPENCODE_CANCEL_FAILED', 'OpenCode run was cancelled.');
      }
      assertSupportedOpenCodeProvider(
        this.runtime.provider,
        this.options.providerBaseUrl !== undefined,
      );
      const apiKey = openCodeCredential(this.runtime.provider, this.hostEnvironment);
      if (apiKey.length === 0) {
        throw new OpenCodeHarnessError(
          'OPENCODE_CREDENTIAL_MISSING',
          'OpenCode credential is missing. Set ' +
            credentialEnvForProvider(this.runtime.provider) +
            ' for provider ' +
            this.runtime.provider +
            '.',
        );
      }
      // Neutralize project-controlled OpenCode configuration inside the
      // disposable workspace (proven: suppression flags alone do not stop
      // project plugin auto-discovery in 1.18.32). FAIL-CLOSED: any
      // masking failure aborts before OpenCode launches. Originals outside
      // Sentry are untouched; the masked content stays readable for QA.
      entry.maskedConfig = await maskProjectOpenCodeConfig(request.workspace.runtimePath);
      if (entry.maskedConfig.length > 0) {
        this.shutdownDiagnostics.push({
          code: 'OPENCODE_PROJECT_CONFIG_MASKED',
          severity: 'info',
          message:
            'Masked project OpenCode configuration in the disposable workspace: ' +
            entry.maskedConfig.join(', '),
        });
      }
      // Disposable HOME/XDG scope (no credential material anywhere).
      const scope = await createOpenCodeRunScope({
        workspacePath: request.workspace.runtimePath,
        runId: request.agentRunId,
      });
      entry.scope = scope;
      // Localhost auth proxy: the real key lives only in its closure.
      // OpenCode receives the proxy endpoint plus a dummy key. Upstream
      // follows the configured provider (OpenRouter vs OpenCode Zen).
      const upstreamBaseUrl = openCodeUpstreamBaseUrl(
        this.runtime.provider,
        this.options.proxyUpstreamBaseUrl ?? this.options.providerBaseUrl,
      );
      const proxy = await startOpenCodeAuthProxy({
        apiKey,
        allowedModel: this.runtime.effectiveModelId,
        upstreamBaseUrl,
        // Stable per-conversation id for upstream routing/caching
        // (required as x-opencode-session by the Go gateway).
        sessionId: request.agentRunId,
      });
      entry.proxy = proxy;
      this.shutdownDiagnostics.push({
        code: 'OPENCODE_PROVIDER_UPSTREAM',
        severity: 'info',
        message:
          'OpenCode provider ' +
          this.runtime.provider +
          ' via localhost proxy to ' +
          upstreamHostForDiagnostics(upstreamBaseUrl) +
          ' (names only, no credentials).',
        retryable: false,
      });
      // Tool shell wrapper (Linux production): bwrap namespace per shell
      // invocation. Fail closed unless explicitly bypassed for dev/test.
      const turnBase = await this.buildTurnBase(request, scope, proxy);
      entry.turnBase = turnBase;
      const client = await this.clientFactory({
        executable: this.runtime.executable,
        cwd: request.workspace.runtimePath,
        environment: turnBase,
        modelId: this.runtime.effectiveModelId,
        shutdownTimeoutMs: this.shutdownTimeoutMs,
      });
      entry.client = client;
      entry.session = await client.startSession();
      markOpenCodeRuntimeVerified();
      this.options.onRuntimeIdentity?.({});
      const pipeline = pipelineContext(this.secrets);
      let planResult: ReturnType<typeof SentryInvestigationPlanV1Schema.parse> | undefined;
      let planCorrection: string[] | undefined;
      let planningUsage: AgentUsage | undefined;
      let planningSteps = 0;
      for (let attempt = 1; attempt <= MAX_PLANNING_ATTEMPTS; attempt += 1) {
        const planning = await this.runTurn(
          entry,
          planCorrection === undefined
            ? planningPrompt(request)
            : buildPlanningCorrectionIntro(planCorrection) +
                '\nImmutable mission context: ' +
                JSON.stringify(request.task.context ?? {}),
          request.agentRunId,
          'planning',
        );
        for (const emitted of planning.events) yield emitted;
        planningSteps += planning.steps;
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
            code: 'OPENCODE_PLANNING_RETRY',
            message: 'OpenCode planning attempt ' + attempt + ' rejected; retrying planning only.',
          });
        } else {
          throw new OpenCodeHarnessError(
            'OPENCODE_INVALID_RESULT',
            'OpenCode planning failed after ' +
              MAX_PLANNING_ATTEMPTS +
              ' attempts: ' +
              (planCorrection ?? []).map(boundCorrectionMessage).join('; '),
          );
        }
      }
      if (planResult === undefined)
        throw new OpenCodeHarnessError('OPENCODE_INVALID_RESULT', 'OpenCode produced no plan.');
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
        message: 'OpenCode is executing the frozen plan.',
      });
      const investigation = await this.runTurn(
        entry,
        investigationPrompt(planResult),
        request.agentRunId,
        'investigation',
      );
      for (const emitted of investigation.events) yield emitted;
      yield event(request.agentRunId, {
        type: 'agent.status',
        status: 'reporting',
        message: 'OpenCode is serializing the frozen investigation into a report.',
      });
      const reportTurns: Array<{ usage?: AgentUsage; steps: number }> = [];
      let result: SentryAgentReportV2 | undefined;
      let built: BuiltReportAttempt | undefined;
      let correction: string[] | undefined;
      for (let attempt = 1; attempt <= MAX_REPORT_ATTEMPTS; attempt += 1) {
        let reporting: CollectedTurn | undefined;
        let errors: string[] | undefined;
        try {
          reporting = await this.runTurn(
            entry,
            reportPrompt(planResult, this.observedOperations, correction),
            request.agentRunId,
            'reporting',
            true,
          );
        } catch (cause) {
          if (
            cause instanceof OpenCodeHarnessError &&
            cause.code === 'OPENCODE_REPORT_TOOL_FORBIDDEN'
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
          reportTurns.push({
            ...(reporting.usage === undefined ? {} : { usage: reporting.usage }),
            steps: reporting.steps,
          });
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
          throw new OpenCodeHarnessError(
            'OPENCODE_INVALID_RESULT',
            'OpenCode report attempt produced no result and no error.',
          );
        }
        correction = errors;
        if (attempt < MAX_REPORT_ATTEMPTS) {
          yield event(request.agentRunId, {
            type: 'warning',
            code: 'OPENCODE_REPORT_RETRY',
            message:
              'OpenCode report attempt ' +
              attempt +
              ' rejected; retrying report only (' +
              errors.length +
              ' issues).',
          });
        } else {
          throw new OpenCodeHarnessError(
            'OPENCODE_INVALID_RESULT',
            'OpenCode report failed after ' +
              MAX_REPORT_ATTEMPTS +
              ' attempts: ' +
              errors.map(boundCorrectionMessage).join('; '),
          );
        }
      }
      if (result === undefined || built === undefined)
        throw new OpenCodeHarnessError('OPENCODE_INVALID_RESULT', 'OpenCode produced no report.');
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
          code: 'OPENCODE_LIMITATION',
          message: limitation,
        });
      let summed = sumUsage(planningUsage, investigation.usage ?? {});
      for (const turn of reportTurns) summed = sumUsage(summed, turn.usage ?? {});
      const usage: AgentUsage = {
        ...summed,
        turns: planningSteps + investigation.steps + reportTurns.reduce((n, t) => n + t.steps, 0),
      };
      yield event(request.agentRunId, { type: 'usage.updated', usage });
      yield event(request.agentRunId, {
        type: 'run.completed',
        usage,
      });
    } catch (cause) {
      if (cause instanceof OpenCodeHarnessError && cause.code === 'OPENCODE_CANCEL_FAILED') {
        yield event(request.agentRunId, {
          type: 'run.failed',
          failure: {
            code: 'OPENCODE_CANCEL_FAILED',
            message: 'OpenCode run was cancelled.',
            retryable: false,
          },
        });
        return;
      }
      const typed =
        cause instanceof OpenCodeHarnessError
          ? cause
          : cause instanceof Error && cause.name === 'ZodError'
            ? new OpenCodeHarnessError(
                'OPENCODE_INVALID_RESULT',
                'OpenCode returned data that did not match the required schema.',
              )
            : new OpenCodeHarnessError(
                /auth|credential|sign in|api key|unauthorized|401|apicallerror/i.test(
                  String(cause) + ' ' + messageOf(cause),
                )
                  ? 'OPENCODE_AUTH_FAILED'
                  : /sandbox/i.test(String(cause))
                    ? 'OPENCODE_SANDBOX_UNAVAILABLE'
                    : 'OPENCODE_START_FAILED',
                redactDiagnostic(cause, this.secrets),
                true,
              );
      yield event(request.agentRunId, {
        type: 'run.failed',
        failure: {
          code: typed.code,
          message: redactDiagnostic(typed.message, this.secrets),
          retryable: typed.retryable,
        },
      });
    } finally {
      await this.closeRunEntry(request.agentRunId);
    }
  }

  /** Close a run's owned client and remove its disposable scope (best-effort). */
  private async closeRunEntry(agentRunId: AgentRunId): Promise<void> {
    const entry = this.sessions.get(agentRunId);
    this.sessions.delete(agentRunId);
    if (entry?.client !== undefined) {
      const client = entry.client;
      entry.client = undefined;
      try {
        await client.close();
      } catch (cause) {
        this.shutdownDiagnostics.push({
          code: 'OPENCODE_SHUTDOWN_ISSUE',
          severity: 'warning',
          message: redactDiagnostic(cause, this.secrets),
          retryable: false,
        });
      }
    }
    // Observed transport evidence: which proxy routes actually relayed
    // (truthful per-model transport without duplicating OpenCode's catalog).
    if (entry?.proxy !== undefined) {
      const routes = entry.proxy.relayedRoutes();
      const observed = (Object.entries(routes) as Array<[string, number]>)
        .filter(([, count]) => count > 0)
        .map(([route, count]) => route + 'x' + String(count))
        .join(',');
      if (observed.length > 0) {
        this.shutdownDiagnostics.push({
          code: 'OPENCODE_PROVIDER_TRANSPORT_OBSERVED',
          severity: 'info',
          message:
            'Observed upstream routes for ' +
            this.runtime.effectiveModelId +
            ': ' +
            observed +
            ' (names only, no credentials).',
          retryable: false,
        });
      }
    }
    // Auth proxy stops before scope cleanup: no new upstream use, and the
    // key leaves memory with the closure. Scope removal follows.
    if (entry?.proxy !== undefined) {
      const proxy = entry.proxy;
      entry.proxy = undefined;
      try {
        await proxy.close();
      } catch (cause) {
        this.shutdownDiagnostics.push({
          code: 'OPENCODE_SHUTDOWN_ISSUE',
          severity: 'warning',
          message: redactDiagnostic(cause, this.secrets),
          retryable: false,
        });
      }
    }
    if (entry?.scope !== undefined) {
      const scope = entry.scope;
      entry.scope = undefined;
      try {
        await cleanupOpenCodeRunScope(scope);
      } catch (cause) {
        this.shutdownDiagnostics.push({
          code: 'OPENCODE_SCOPE_CLEANUP_FAILED',
          severity: 'error',
          message: redactDiagnostic(cause, this.secrets),
          retryable: false,
        });
      }
    }
  }

  /**
   * Cancel exactly the OpenCode execution owned by this AgentRun: abort
   * its controller (in-flight turn settles promptly) and stop its owned
   * process boundary. Never touches other runs (no broad pkill).
   */
  async cancel(runId: AgentRunId): Promise<void> {
    const entry = this.sessions.get(runId);
    this.cancelledRuns.add(runId);
    if (entry === undefined) return;
    try {
      entry.controller.abort();
    } catch {
      // Abort is best-effort; session.abort() below owns process teardown.
    }
    try {
      entry.session?.abort();
    } catch (cause) {
      throw new OpenCodeHarnessError(
        'OPENCODE_CANCEL_FAILED',
        'OpenCode cancellation failed: ' + redactDiagnostic(cause, this.secrets),
      );
    }
  }

  async dispose(): Promise<void> {
    const deadline = Date.now() + this.shutdownTimeoutMs;
    const entries = [...this.sessions.entries()];
    for (const [, entry] of entries) {
      try {
        entry.controller.abort();
      } catch {
        // Ignored: dispose owns the final outcome.
      }
      try {
        entry.session?.abort();
      } catch {
        // Ignored: dispose owns the final outcome.
      }
    }
    this.sessions.clear();
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      this.shutdownDiagnostics.push({
        code: 'OPENCODE_SHUTDOWN_TIMEOUT',
        severity: 'warning',
        message: 'OpenCode client close exceeded its shutdown budget.',
        retryable: false,
      });
      return;
    }
    const closers: Array<Promise<unknown>> = [];
    for (const [, entry] of entries) {
      if (entry.client !== undefined) {
        const client = entry.client;
        entry.client = undefined;
        closers.push(client.close().catch(() => undefined));
      }
      if (entry.proxy !== undefined) {
        const proxy = entry.proxy;
        entry.proxy = undefined;
        closers.push(proxy.close().catch(() => undefined));
      }
      if (entry.scope !== undefined) {
        const scope = entry.scope;
        entry.scope = undefined;
        closers.push(
          cleanupOpenCodeRunScope(scope).catch((cause: unknown) => {
            this.shutdownDiagnostics.push({
              code: 'OPENCODE_SCOPE_CLEANUP_FAILED',
              severity: 'error',
              message: redactDiagnostic(cause, this.secrets),
              retryable: false,
            });
          }),
        );
      }
    }
    if (closers.length > 0) {
      try {
        await Promise.race([
          Promise.all(closers),
          new Promise<never>((_resolve, reject) => {
            setTimeout(
              () => reject(new OpenCodeHarnessError('OPENCODE_START_FAILED', 'Close timed out.')),
              remaining,
            );
          }),
        ]);
      } catch (cause) {
        this.shutdownDiagnostics.push({
          code: 'OPENCODE_SHUTDOWN_ISSUE',
          severity: 'warning',
          message: redactDiagnostic(cause, this.secrets),
          retryable: false,
        });
      }
    }
  }

  getShutdownDiagnostics(): readonly HarnessDiagnostic[] {
    return [...this.shutdownDiagnostics];
  }
}
