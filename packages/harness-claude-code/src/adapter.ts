import { mkdir, rm, writeFile } from 'node:fs/promises';
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
  buildBaselineIndex,
  commandIdentity,
  convertEvidence,
  isTestCommand,
  parseWholeJson,
  summarizeSchemaIssues,
  validateLocation,
  validateProductionFindings,
  type EvidencePipelineContext,
  type ObservedOperation,
} from '@qa/evidence-pipeline';
import {
  describeSentryAgentEvidenceContract,
  FindingSchema,
  HarnessEventSchema,
  SentryAgentResultV1Schema,
  SentryInvestigationPlanV1Schema,
  type AgentUsage,
  type Evidence,
  type HarnessEvent,
  type HarnessRunRequest,
  type SentryAgentResultV1,
} from '@qa/schemas';
import type {
  HarnessAdapter,
  HarnessDiagnostic,
  HarnessHealthResult,
  HarnessMetadata,
} from '@qa/harness-protocol';
import {
  doctorGlm,
  markGlmRuntimeVerified,
  resolveGlmRuntime,
  type GlmRuntimeConfiguration,
} from './discovery.js';
import { buildClaudeChildEnvironment } from './environment.js';
import { ClaudeCodeHarnessError } from './errors.js';
import { redactDiagnostic, redactStructured, secretValues } from './redaction.js';
import {
  buildClaudeSettings,
  createProductionClaudeClient,
  type ClaudeClientFactory,
  type ClaudeClientView,
  type ClaudeSessionView,
  type ClaudeSpawnSpec,
  type ClaudeStreamEvent,
} from './sdk.js';

export interface ClaudeCodeHarnessAdapterOptions {
  readonly executable?: string;
  readonly modelId?: string;
  readonly provider?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly clientFactory?: ClaudeClientFactory;
  readonly shutdownTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly onRuntimeIdentity?: (identity: {
    readonly harnessVersion?: string;
    readonly executableVersion?: string;
  }) => void;
}

export class ClaudeTurnTimeoutError extends ClaudeCodeHarnessError {
  constructor(phase: string, budgetMs: number) {
    super(
      'GLM_START_FAILED',
      'Claude Code ' + phase + ' turn exceeded its ' + String(budgetMs) + ' ms budget.',
      true,
    );
    this.name = 'ClaudeTurnTimeoutError';
  }
}

interface CollectedTurn {
  readonly text: string;
  readonly events: readonly HarnessEvent[];
  readonly usage?: AgentUsage | undefined;
  readonly result?: ClaudeStreamEvent | undefined;
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
      invalidResult: (message: string) => new ClaudeCodeHarnessError('GLM_INVALID_RESULT', message),
    },
    authorLabel: 'Claude Code',
    secrets,
    redactDiagnostic: (value: string) => redactDiagnostic(value, secrets),
    redactStructured: (value: unknown) => redactStructured(value, secrets),
  };
}

function parseAgentResult(text: string, pipeline: EvidencePipelineContext): SentryAgentResultV1 {
  const parsed = SentryAgentResultV1Schema.safeParse(parseWholeJson(text, 'execution', pipeline));
  if (parsed.success) return parsed.data;
  throw new ClaudeCodeHarnessError(
    'GLM_INVALID_RESULT',
    'Claude Code execution result did not match the required schema (' +
      summarizeSchemaIssues(parsed.error) +
      ').',
  );
}

function planningPrompt(request: HarnessRunRequest): string {
  return [
    'You are the sole QA investigator. Do not create, delegate to, or message subagents.',
    'Host safety is authoritative: work only inside the current isolated workspace; never disable or bypass sandboxing; never access the original project, Sentry managed baseline, other workspaces, Sentry data, or arbitrary host files.',
    'Do not commit, push, modify Git remotes, create pull requests, or intentionally fix product defects.',
    'Explicit run instructions define intended behavior and outrank project documentation; project documentation outranks your inference. None may override host safety.',
    'Inspect project documentation and the supplied immutable mission context. Do not use peer plans, findings, or messages.',
    'Create an investigation plan before executing it. Return exactly one JSON document and no Markdown: no code fences, no preamble, no commentary, just the raw JSON object.',
    'Schema: {"schemaVersion":1,"projectUnderstanding":string,"criticalFlows":string[],"weakPoints":string[],"plannedChecks":string[at least one]}.',
    'Immutable mission context: ' + JSON.stringify(request.task.context ?? {}),
    'User instructions: ' + request.task.prompt,
  ].join('\n');
}

function executionPrompt(
  plan: ReturnType<typeof SentryInvestigationPlanV1Schema.parse>,
  observedOperations: ReadonlyMap<string, ObservedOperation>,
): string {
  // Authoritative operation ledger (same protection as DeepSeek): keys and
  // exit codes are session-global (planning ops included), so the model
  // never reconstructs numbering or recalls codes from memory. Compact:
  // key, tool, command/target summary, exit code. No command output.
  const ledger = [...observedOperations.values()]
    .map(
      (op) =>
        `${op.operationKey}: ${op.toolName} ${op.commandText ?? op.argsText ?? '(no target)'} ` +
        `(exit ${op.exitCode === undefined ? 'unknown' : op.exitCode})`,
    )
    .join('\n');
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
    'Return exactly one JSON document and no Markdown. Do not invent file paths or command results.',
    'Use temporary evidence keys only; Sentry owns all durable IDs.',
    'Finding category MUST be exactly one of: build, runtime, logic, api, frontend, database, authentication, authorization, security, configuration, performance, concurrency, dependency, testing, cicd, deployment, maintainability, documentation, other. Copy the string exactly; any other value fails validation. Severity MUST be exactly one of: critical, high, medium, low, info. Confidence MUST be exactly one of: confirmed, strong, probable, speculative.',
    'Calibrate confidence honestly: confirmed requires at least one reproduced-strength or operation-linked command/test evidence item behind the finding — code references and manual reasoning support strong at most. Overconfident findings fail validation.',
    'Evidence type MUST be exactly one of: command, runtime, code_reference, test, log, manual. Strength MUST be exactly one of: reproduced_failure, reproduced_behavior, tool_diagnostic, strong_code_evidence, agent_reasoning.',
    'For command evidence, use ONLY short single-purpose commands you issued alone (never chains joined by &&, ;, or |, never pipelines): reproduce the command text EXACTLY character-for-character as you issued it, with the exact exit code you observed.',
    'For test/runtime/log evidence, set operationKey to the observed operation that produced it, using the EXACT keys and exit codes from the operation ledger below. Operation keys are session-global: planning-turn operations keep their keys, and execution-turn operations continue numbering. NEVER restart numbering at op_1 for the execution turn. Copy the exit code exactly as listed; if listed as unknown, do not guess a code.',
    'Observed operation ledger (authoritative):\n' +
      (ledger.length > 0 ? ledger : '(no operations observed yet)'),
    'Evidence item contract (every field the parser accepts; copy names exactly): ' +
      describeSentryAgentEvidenceContract(),
    'Schema: {"schemaVersion":1,"summary":string,"checks":[{"name":string,"status":"passed|failed|inconclusive|not_run","details"?:string}],"hypotheses":[{"title":string,"rationale":string,"relatedPaths":string[],"plannedChecks":string[at least one]}],"evidence":[<see Evidence item contract above>],"findings":[{"title":string,"category":string,"categoryDetail"?:string,"severity":"critical|high|medium|low|info","confidence":"confirmed|strong|probable|speculative","description":string,"expectedBehavior"?:string,"actualBehavior"?:string,"locations":[{"relativePath":string,"lineStart"?:number,"lineEnd"?:number,"symbol"?:string}],"evidenceKeys":string[],"reproductionSteps":string[],"rootCause"?:string,"recommendedFix"?:string}],"limitations":string[]}.',
    'Frozen plan: ' + JSON.stringify(plan),
  ].join('\n');
}

function eventText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function eventNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Extract final assistant text from stream-json content blocks. */
function textFromContentBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === 'text') {
      const text = eventText(record.text);
      if (text !== undefined) parts.push(text);
    }
  }
  return parts.join('\n');
}

/** Extract a shell command from Bash tool input, if the tool is Bash-like. */
function commandFromBashInput(toolName: string, input: unknown): string | undefined {
  if (!/^(bash|powershell)$/i.test(toolName)) return undefined;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  return eventText((input as { command?: unknown }).command);
}

export class ClaudeCodeHarnessAdapter implements HarnessAdapter {
  private readonly hostEnvironment: NodeJS.ProcessEnv;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly childEnvironmentReport: {
    readonly allowedNames: readonly string[];
    readonly blockedNames: readonly string[];
  };
  private readonly runtime: GlmRuntimeConfiguration;
  private readonly clientFactory: ClaudeClientFactory;
  private readonly shutdownTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly secrets: readonly string[];
  private client?: ClaudeClientView;
  private closePromise?: Promise<void>;
  private readonly operationIds = new Map<string, OperationId>();
  private readonly pendingToolUses = new Map<
    string,
    { operationId: OperationId; toolName: string; commandText?: string; argsText?: string }
  >();
  private readonly completedTools = new Set<string>();
  private readonly observedCommands = new Set<string>();
  private readonly observedOperations = new Map<string, ObservedOperation>();
  private operationCounter = 0;
  private sandboxVerified = false;
  private readonly shutdownDiagnostics: HarnessDiagnostic[] = [];

  constructor(private readonly options: ClaudeCodeHarnessAdapterOptions = {}) {
    this.hostEnvironment = options.environment ?? process.env;
    this.runtime = resolveGlmRuntime({ ...options, environment: this.hostEnvironment });
    this.clientFactory = options.clientFactory ?? createProductionClaudeClient;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 1_800_000;
    const child = buildClaudeChildEnvironment({ source: this.hostEnvironment });
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
      adapterId: 'claude-code',
      adapterVersion: '0.1.0',
      protocolVersion: 1,
      displayName: 'Claude Code GLM Adapter',
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
    return doctorGlm({
      executable: this.runtime.executable,
      modelId: this.runtime.modelId,
      provider: this.runtime.provider,
      environment: this.hostEnvironment,
    });
  }

  /**
   * Interpret one stream-json event (verified vocabulary on 2.1.270):
   * - `system/init`: session identity, tool inventory, model echo
   * - `assistant` with `tool_use` blocks: tool.started
   * - `user` with `tool_result` blocks: tool.completed + observed op
   * - `assistant` text: accumulated model text
   * - `result`: terminal turn record (usage, subagent stats, errors)
   */
  private observeStreamEvent(
    stream: ClaudeStreamEvent,
    agentRunId: AgentRunId,
    emit: (value: Readonly<Record<string, unknown>>) => HarnessEvent,
    text: { value: string },
    turnUsage: { usage?: AgentUsage },
  ): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    const raw = stream.raw;
    if (stream.type === 'system' && raw['subtype'] === 'init') {
      const tools = Array.isArray(raw['tools']) ? raw['tools'] : [];
      // Forbidden tools must stay absent even with --disallowedTools: a
      // present Agent/Task tool means the composition failed open.
      const forbiddenPresent = tools.filter(
        (tool): tool is string =>
          typeof tool === 'string' &&
          /^(agent|task|webfetch|websearch|skill|cron|schedulewakeup)$/i.test(tool),
      );
      if (forbiddenPresent.length > 0) {
        throw new ClaudeCodeHarnessError(
          'GLM_SUBAGENT_FORBIDDEN',
          'Claude Code session exposes forbidden tools: ' + forbiddenPresent.join(', '),
        );
      }
      return out;
    }
    if (stream.type === 'assistant') {
      const message = raw['message'];
      const content =
        message !== null && typeof message === 'object' && !Array.isArray(message)
          ? (message as { content?: unknown }).content
          : undefined;
      if (!Array.isArray(content)) return out;
      for (const block of content) {
        if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
        const record = block as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          input?: unknown;
          text?: unknown;
        };
        if (record.type === 'text') {
          const chunk = eventText(record.text);
          if (chunk !== undefined) text.value += (text.value.length > 0 ? '\n' : '') + chunk;
        } else if (record.type === 'tool_use') {
          const toolUseId = eventText(record.id) ?? 'tool-' + this.operationCounter;
          const toolName = eventText(record.name) ?? 'unknown';
          if (toolName === 'Agent' || toolName === 'Task') {
            throw new ClaudeCodeHarnessError(
              'GLM_SUBAGENT_FORBIDDEN',
              'Claude Code attempted forbidden subagent fanout.',
            );
          }
          if (this.operationIds.has(toolUseId)) continue;
          const operationId = createOperationId();
          this.operationIds.set(toolUseId, operationId);
          const commandText = commandFromBashInput(toolName, record.input);
          // Every tool use gets a ledger entry (not just Bash): non-command
          // tools carry a bounded args summary as their observable target.
          const argsText =
            commandText === undefined
              ? redactDiagnostic(JSON.stringify(record.input ?? '').slice(0, 300), this.secrets)
              : undefined;
          this.pendingToolUses.set(toolUseId, {
            operationId,
            toolName,
            ...(commandText === undefined ? {} : { commandText }),
            ...(argsText === undefined ? {} : { argsText }),
          });
          out.push(
            emit({
              type: 'tool.started',
              operationId,
              tool: {
                name: toolName,
                inputSummary: redactDiagnostic(
                  commandText ?? JSON.stringify(record.input ?? '').slice(0, 500),
                  this.secrets,
                ),
              },
            }),
          );
        }
      }
      return out;
    }
    if (stream.type === 'user') {
      const message = raw['message'];
      const content =
        message !== null && typeof message === 'object' && !Array.isArray(message)
          ? (message as { content?: unknown }).content
          : undefined;
      if (!Array.isArray(content)) return out;
      for (const block of content) {
        if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
        const record = block as {
          type?: unknown;
          tool_use_id?: unknown;
          content?: unknown;
          is_error?: unknown;
        };
        if (record.type !== 'tool_result') continue;
        const toolUseId = eventText(record.tool_use_id) ?? '';
        if (toolUseId === '' || this.completedTools.has(toolUseId)) continue;
        this.completedTools.add(toolUseId);
        const operationId = this.operationIds.get(toolUseId) ?? createOperationId();
        const pending = this.pendingToolUses.get(toolUseId);
        if (pending !== undefined) this.pendingToolUses.delete(toolUseId);
        const toolName = pending?.toolName ?? 'unknown';
        const failed = record.is_error === true;
        out.push(
          emit({
            type: 'tool.completed',
            operationId,
            tool: { name: toolName, ...(failed ? { exitCode: 1 } : {}) },
          }),
        );
        const commandText = pending?.commandText;
        const argsText = pending?.argsText;
        // Every completed tool use mints a session-global operation (monotonic
        // counter shared by planning and execution turns — never reset).
        // Bash-family commands additionally record exit codes and command
        // events; other tools record their observable target instead.
        this.operationCounter += 1;
        const operationKey = 'op_' + this.operationCounter;
        if (commandText !== undefined) {
          const command = redactDiagnostic(commandText, this.secrets);
          // Exit codes come only from structured tool metadata, never
          // inferred from result text: Bash results carry stdout/stderr text,
          // not codes. A non-error Bash result proves success (code 0); an
          // error result proves non-success without a specific code.
          const exitCode = failed ? undefined : 0;
          if (exitCode !== undefined) this.observedCommands.add(commandIdentity(command, exitCode));
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
        } else {
          this.observedOperations.set(operationKey, {
            operationId,
            operationKey,
            toolName,
            ...(argsText === undefined ? {} : { argsText }),
            isTestOperation: isTestCommand(toolName + ' ' + (argsText ?? '')),
          });
        }
        const resultText = textFromContentBlocks(
          Array.isArray(record.content) ? record.content : [record.content],
        );
        if (resultText.length > 0) {
          out.push(
            emit({
              type: 'agent.message',
              message: ('tool ' + toolName + ' result: ' + resultText).slice(0, 2_000),
            }),
          );
        }
      }
      return out;
    }
    if (stream.type === 'result') {
      const usage = raw['usage'];
      if (usage !== null && typeof usage === 'object' && !Array.isArray(usage)) {
        const record = usage as Record<string, unknown>;
        const inputTokens = eventNumber(record['input_tokens']);
        const outputTokens = eventNumber(record['output_tokens']);
        const cacheRead = eventNumber(record['cache_read_input_tokens']);
        const cacheCreate = eventNumber(record['cache_creation_input_tokens']);
        if (
          inputTokens !== undefined ||
          outputTokens !== undefined ||
          cacheRead !== undefined ||
          cacheCreate !== undefined
        ) {
          turnUsage.usage = {
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
            ...(cacheRead === undefined && cacheCreate === undefined
              ? {}
              : { cachedInputTokens: (cacheRead ?? 0) + (cacheCreate ?? 0) }),
          };
        }
      }
      // Subagent fanout proof: spawned must stay zero; the Task/Agent
      // tools are denied, so any spawn is a composition failure.
      const stats = raw['subagent_stats'];
      const spawned =
        stats !== null && typeof stats === 'object' && !Array.isArray(stats)
          ? eventNumber((stats as { spawned?: unknown }).spawned)
          : undefined;
      if (spawned !== undefined && spawned > 0) {
        throw new ClaudeCodeHarnessError(
          'GLM_SUBAGENT_FORBIDDEN',
          'Claude Code spawned subagents during the turn.',
        );
      }
      if (raw['is_error'] === true) {
        const resultText = eventText(raw['result']) ?? '';
        if (/not logged in|login|authentication_failed|unauthorized|api key/i.test(resultText)) {
          throw new ClaudeCodeHarnessError(
            'GLM_AUTH_FAILED',
            'Claude Code could not authenticate to the provider.',
          );
        }
        if (/sandbox/i.test(resultText)) {
          throw new ClaudeCodeHarnessError(
            'GLM_SANDBOX_UNAVAILABLE',
            'Claude Code sandbox refused the turn; failing closed.',
          );
        }
      }
      return out;
    }
    return out;
  }

  private async runTurn(
    session: ClaudeSessionView,
    text: string,
    agentRunId: AgentRunId,
    phase: string,
  ): Promise<CollectedTurn> {
    const deadline = Date.now() + this.turnTimeoutMs;
    const runPromise = session.runText(text);
    const events = await (async (): Promise<ClaudeStreamEvent[]> => {
      const budget = deadline - Date.now();
      if (budget <= 0) throw new ClaudeTurnTimeoutError(phase, this.turnTimeoutMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          runPromise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new ClaudeTurnTimeoutError(phase, this.turnTimeoutMs)),
              budget,
            );
          }),
        ]);
      } catch (cause) {
        // A timed-out turn abandons its child: terminate owned processes
        // promptly instead of leaving them for coordinator teardown.
        // Dispose is idempotent; the run aborts after this throw.
        if (cause instanceof ClaudeTurnTimeoutError) {
          await this.dispose().catch(() => undefined);
        }
        throw cause;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    const emit = (value: Readonly<Record<string, unknown>>): HarnessEvent =>
      event(agentRunId, value);
    const collected: HarnessEvent[] = [];
    const textAcc: { value: string } = { value: '' };
    const turnUsage: { usage?: AgentUsage } = {};
    let result: ClaudeStreamEvent | undefined;
    for (const stream of events) {
      try {
        if (stream.type === 'result') result = stream;
        collected.push(...this.observeStreamEvent(stream, agentRunId, emit, textAcc, turnUsage));
      } catch (cause) {
        if (cause instanceof ClaudeCodeHarnessError) throw cause;
        throw new ClaudeCodeHarnessError(
          'GLM_INVALID_RESULT',
          'Claude Code stream event could not be interpreted.',
        );
      }
    }
    return { text: textAcc.value, events: collected, usage: turnUsage.usage, result };
  }

  async *run(request: HarnessRunRequest): AsyncIterable<HarnessEvent> {
    yield event(request.agentRunId, { type: 'run.started' });
    yield event(request.agentRunId, {
      type: 'agent.status',
      status: 'planning',
      message: 'Claude Code is creating a frozen investigation plan.',
    });
    // Ephemeral Sentry-owned config boundary: every Claude session state
    // (history, transcripts, plugins, skills, hooks, MCP config, memory,
    // settings) lives beneath this disposable directory and is destroyed
    // after extraction. Never the user's ordinary Claude environment.
    const configDir = join(dirname(request.workspace.runtimePath), '.sentry-claude-home');
    const settingsPath = join(configDir, 'sentry-settings.json');
    let session: ClaudeSessionView | undefined;
    try {
      await mkdir(configDir, { recursive: true });
      await writeFile(settingsPath, JSON.stringify(buildClaudeSettings()), 'utf8');
      const spec: ClaudeSpawnSpec = {
        executable: this.runtime.executable,
        cwd: request.workspace.runtimePath,
        configDir,
        environment: this.environment,
        modelId: this.runtime.modelId,
        settingsPath,
        initializeTimeoutMs: 30_000,
        turnTimeoutMs: this.turnTimeoutMs,
        shutdownTimeoutMs: this.shutdownTimeoutMs,
      };
      this.client = await this.clientFactory(spec);
      session = await this.client.startSession();
      markGlmRuntimeVerified();
      const planning = await this.runTurn(
        session,
        planningPrompt(request),
        request.agentRunId,
        'planning',
      );
      for (const emitted of planning.events) yield emitted;
      if (planning.text.trim().length === 0) {
        throw new ClaudeCodeHarnessError(
          'GLM_INVALID_RESULT',
          'Claude Code planning turn produced no response.',
        );
      }
      const pipeline = pipelineContext(this.secrets);
      const planResult = SentryInvestigationPlanV1Schema.parse(
        parseWholeJson(planning.text, 'planning', pipeline),
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
        message: 'Claude Code is executing the frozen plan.',
      });
      const execution = await this.runTurn(
        session,
        executionPrompt(planResult, this.observedOperations),
        request.agentRunId,
        'execution',
      );
      for (const emitted of execution.events) yield emitted;
      if (execution.text.trim().length === 0) {
        throw new ClaudeCodeHarnessError(
          'GLM_INVALID_RESULT',
          'Claude Code execution turn produced no response.',
        );
      }
      const result = parseAgentResult(execution.text, pipeline);
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
        const converted = await convertEvidence(request, source, pipeline, {
          observedCommands: this.observedCommands,
          operations: this.observedOperations,
          ...(baselineIndex === undefined ? {} : { baseline: baselineIndex }),
        });
        evidenceByKey.set(source.key, converted);
        yield event(request.agentRunId, { type: 'evidence.submitted', evidence: converted });
      }
      validateProductionFindings(result.findings, evidenceByKey, (message: string) =>
        pipeline.errors.invalidResult(message),
      );
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
          code: 'GLM_LIMITATION',
          message: limitation,
        });
      const usage: AgentUsage = {
        ...sumUsage(planning.usage, execution.usage ?? {}),
        turns: 2,
      };
      yield event(request.agentRunId, { type: 'usage.updated', usage });
      yield event(request.agentRunId, {
        type: 'run.completed',
        usage,
      });
    } catch (cause) {
      const typed =
        cause instanceof ClaudeCodeHarnessError
          ? cause
          : cause instanceof Error && cause.name === 'ZodError'
            ? new ClaudeCodeHarnessError(
                'GLM_INVALID_RESULT',
                'Claude Code returned data that did not match the required schema.',
              )
            : new ClaudeCodeHarnessError(
                /auth|credential|sign in|api key|unauthorized|401|not logged in/i.test(
                  String(cause),
                )
                  ? 'GLM_AUTH_FAILED'
                  : /sandbox/i.test(String(cause))
                    ? 'GLM_SANDBOX_UNAVAILABLE'
                    : 'GLM_START_FAILED',
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
    } finally {
      // Ephemeral state destroyed after extraction: transcripts, plugins,
      // skills, hooks, MCP config, memory, settings. Only canonical
      // observable data already persisted by the coordinator survives.
      await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async cancel(_runId: AgentRunId): Promise<void> {
    try {
      await this.dispose();
    } catch (cause) {
      throw new ClaudeCodeHarnessError(
        'GLM_CANCEL_FAILED',
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
