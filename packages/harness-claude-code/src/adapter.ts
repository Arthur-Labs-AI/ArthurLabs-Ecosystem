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
  canChallenge,
  limitPhase,
  reportAttemptDeadline,
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
  doctorGlm,
  isWslEnvironment,
  markGlmRuntimeVerified,
  probeClaudeExecutable,
  probeClaudeWslMountIsolation,
  probeWindowsProfileSandboxBlockers,
  resolveGlmRuntime,
  type ClaudeWslIsolationReport,
  type GlmRuntimeConfiguration,
} from './discovery.js';
import { buildClaudeChildEnvironment } from './environment.js';
import { SystemdIsolatedClaudeProcessLauncher, type ClaudeProcessLauncher } from './launcher.js';
import { ClaudeCodeHarnessError } from './errors.js';
import { redactDiagnostic, redactStructured, secretValues } from './redaction.js';
import {
  buildClaudeSettings,
  CLAUDE_CODE_TESTED_VERSION,
  classifyClaudeCodeVersion,
  createProductionClaudeClient,
  type ClaudeClientFactory,
  type ClaudeClientView,
  type ClaudeSessionView,
  type ClaudeSpawnSpec,
  type ClaudeStreamEvent,
  type ClaudeTurnStream,
} from './sdk.js';

export interface ClaudeCodeHarnessAdapterOptions {
  readonly executable?: string;
  readonly modelId?: string;
  readonly provider?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly clientFactory?: ClaudeClientFactory;
  readonly shutdownTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
  /**
   * Actual probed executable version (e.g. '2.1.276 (Claude Code)'),
   * wired from registration preflight when it ran. The adapter does NOT
   * depend on preflight having run: when this is absent, run() probes
   * the binary itself (bounded, cached per adapter) so the version
   * policy (fail-closed on live-proven incompatible versions) holds on
   * every construction path, including runtimes that call createAdapter
   * without preflight.
   */
  readonly executableVersion?: string;
  /**
   * Test seam for the Windows-profile sandbox preflight (fixture Users
   * root with controlled permissions). Production never sets this; the
   * real `/mnt/c/Users` is inspected. Mirrors the `spawnProcess` seam
   * precedent in `ClaudeSpawnSpec`.
   */
  readonly windowsUsersRoot?: string;
  /**
   * Test seam for the WSL mount-isolation preflight. When set, run()
   * treats the worker as a WSL worker and uses this report INSTEAD of
   * spawning real transient units — deterministic on any platform.
   * Production never sets this; the real preflight always runs.
   */
  readonly wslMountIsolationOverride?: ClaudeWslIsolationReport | undefined;
  readonly onRuntimeIdentity?: (identity: {
    readonly harnessVersion?: string;
    readonly executableVersion?: string;
  }) => void;
}

export class ClaudeInitTimeoutError extends ClaudeCodeHarnessError {
  constructor(budgetMs: number) {
    super(
      'GLM_INIT_TIMEOUT',
      'Claude Code turn produced no initialization event within ' +
        String(budgetMs) +
        ' ms; aborting the owned turn instead of spending the turn budget on startup.',
      true,
    );
    this.name = 'ClaudeInitTimeoutError';
  }
}

export class ClaudeTurnTimeoutError extends ClaudeCodeHarnessError {
  constructor(phase: string, budgetMs: number) {
    super(
      'GLM_TURN_TIMEOUT',
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

/**
 * Turn-abort errors that must carry their trigger events (the abort
 * throw site runs before the trigger is yielded, so without this the
 * very event that tripped the breaker would vaporize). Loop aborts and
 * the cold-start permission abort share this contract.
 */
function isEventCarryingAbort(cause: unknown): cause is ClaudeCodeHarnessError {
  return (
    cause instanceof ClaudeCodeHarnessError &&
    (cause.code === 'GLM_TOOL_LOOP' ||
      cause.code === 'GLM_TOOL_PERMISSION_UNAVAILABLE' ||
      cause.code === 'GLM_SANDBOX_UNAVAILABLE')
  );
}

/** Events buffered before a loop-breaker abort: flush so the run record
 *  shows the thrash (and the model saw the correction) instead of 3
 *  events for 25 tool calls. */
function partialTurnEvents(cause: unknown): readonly HarnessEvent[] {
  if (typeof cause === 'object' && cause !== null && 'partialEvents' in cause) {
    const partial = (cause as { partialEvents?: unknown }).partialEvents;
    if (Array.isArray(partial)) return partial as HarnessEvent[];
  }
  return [];
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

function eventText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function eventNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Extract human-readable text from stream-json content blocks.
 *
 * Verified shape on 2.1.270: `{type:'text', text}` blocks. Production on
 * 2.1.276 persisted ZERO result texts across three runs (68 tool results
 * in run_01M324B2ZGD50VSA48ERJ7HM51 alone), so the wire shape drifted —
 * most likely to a plain-string `content`. This extractor therefore
 * accepts every structural text carrier (string content, `{text}` blocks
 * of any block type, nested arrays) while still ignoring non-text blocks
 * structurally. Callers bound the emitted length.
 */
function textFromContentBlocks(content: unknown): string {
  const parts: string[] = [];
  const visit = (node: unknown): void => {
    const text = eventText(node);
    if (text !== undefined) {
      parts.push(text);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const record = node as { type?: unknown; text?: unknown; content?: unknown };
    const inline = eventText(record.text);
    if (inline !== undefined) parts.push(inline);
    if (record.content !== undefined) visit(record.content);
  };
  visit(content);
  return parts.join('\n');
}

/**
 * True when Bash-like tool result text proves sandbox/bootstrap failure
 * before the actual shell command executed (bubblewrap could not
 * initialize). Conservative by design: anchored to bootstrap markers
 * (`bwrap:`, bind/mount/mkdir failures, sandbox-unavailable) at the start
 * of diagnostic lines. Source searches and documentation can quote these
 * same markers, so substring matches are not proof of a bootstrap failure.
 * Ordinary nonzero exits and missing-file errors are NOT infrastructure
 * failures.
 */
export function isSandboxBootstrapFailureText(text: string): boolean {
  if (/^[\t ]*bwrap:/im.test(text)) return true;
  if (/^[\t ]*can'?t\s+(mkdir|create\s+file|mount|bind|chdir|pivot|clone|unshare)\b/im.test(text))
    return true;
  if (/^[\t ]*sandbox[\t ]+unavailable\b/im.test(text)) return true;
  if (/^[\t ]*bubblewrap\b[^\r\n]*(permission denied|failed)/im.test(text)) return true;
  return false;
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
  private readonly initializeTimeoutMs: number;
  private activeTurn: ClaudeTurnStream | undefined;
  private readonly secrets: readonly string[];
  private client?: ClaudeClientView;
  private closePromise: Promise<void> | undefined;
  private cancelled = false;
  private readonly toolNotes = new ObservedToolNotes();
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
  /** Futile-loop breaker: consecutive identical failing tool calls. */
  private lastFailureSignature: string | undefined;
  private consecutiveIdenticalFailures = 0;
  private loopCorrectionIssuedFor: string | undefined;
  /** Failure-rate breaker: consecutive failures regardless of identity
   *  (sweep loops hit distinct paths, so signature matching never trips). */
  private consecutiveFailures = 0;
  private rateCorrectionIssuedAt: number | undefined;
  /**
   * Trailing-window failure-rate breaker (per turn, reset at each phase
   * turn start): aborts when the last 40 completions contain >= 34
   * failures. Sparse successes (including provider-side false-success
   * result shapes) reset the consecutive streak but cannot mask a 85%+
   * failure rate — live runs show thrash with occasional accidental
   * successes (run_01M325QK0BR8H2SADF4YCJCDVA: 3 successes in ~50 calls).
   * A legitimate investigation never fails 85% of 40 tool calls.
   */
  private readonly loopWindowSize = 40;
  private readonly loopWindowAbortFailures = 34;
  private loopWindow: boolean[] = [];
  /**
   * Cold-start preflight counters (per turn): completions, successes,
   * and Bash failures since the turn started. If the first tools of a
   * turn all fail including Bash (even `pwd && true`), the tool layer is
   * broken (permissions/sandbox), not the model choice — abort with a
   * precise code in seconds instead of burning 25 calls discovering it.
   */
  private turnCompletions = 0;
  private turnSuccesses = 0;
  private turnBashFailures = 0;
  private readonly shutdownDiagnostics: HarnessDiagnostic[] = [];

  /** Reset per-turn loop state (identical streak, consecutive rate,
   *  trailing window, and cold-start counters) so one turn's thrash
   *  never leaks into the next. */
  private resetLoopBreakers(): void {
    this.turnCompletions = 0;
    this.turnSuccesses = 0;
    this.turnBashFailures = 0;
    this.lastFailureSignature = undefined;
    this.consecutiveIdenticalFailures = 0;
    this.loopCorrectionIssuedFor = undefined;
    this.consecutiveFailures = 0;
    this.rateCorrectionIssuedAt = undefined;
    this.loopWindow = [];
  }

  /**
   * Futile-loop breakers: identical-signature streak (10), consecutive
   * failures (25), and trailing-window rate (34/40). Called AFTER the
   * completion event lands, so a throw never vaporizes its trigger.
   * Returns diagnostic warnings (empty normally).
   *
   * Diagnostic (NOT model correction): Claude Code 2.1.270 exposes no
   * supported mid-turn prompt-injection channel, so these warnings are
   * coordinator-observable telemetry flushed into the live event stream —
   * the model never receives them as turn feedback. The hard thresholds
   * below abort the owned turn immediately (fail-fast); the soft
   * thresholds (5 identical / 15 consecutive) only record that the turn
   * is already thrashing so the run history shows it.
   */
  private trackToolResult(
    toolName: string,
    signatureArgs: string,
    failed: boolean,
    emit: (value: Readonly<Record<string, unknown>>) => HarnessEvent,
  ): HarnessEvent[] {
    const extra: HarnessEvent[] = [];
    // Cold-start preflight accounting (per turn, reset in
    // resetLoopBreakers): every completion counts; Bash failures are
    // tracked separately because a broken tool layer fails Bash first.
    this.turnCompletions += 1;
    if (!failed) this.turnSuccesses += 1;
    if (failed && /^(bash|powershell)$/i.test(toolName)) this.turnBashFailures += 1;
    // Cold-start abort: the first tools of a turn all fail and Bash is
    // among them (even trivial commands). The tool layer — permissions,
    // sandbox, cwd — is broken, not the model choice. Abort with a
    // precise code in seconds (verified live: `pwd && true` failing is
    // the signature) instead of burning 25 calls discovering it.
    if (this.turnCompletions >= 3 && this.turnSuccesses === 0 && this.turnBashFailures >= 1) {
      throw new ClaudeCodeHarnessError(
        'GLM_TOOL_PERMISSION_UNAVAILABLE',
        'The first ' +
          this.turnCompletions +
          ' tool calls of the turn all failed, including Bash; ' +
          'the Claude tool layer (permissions/sandbox/workspace) is unavailable. ' +
          'Repair the tool configuration instead of retrying model turns.',
      );
    }
    const failureSignature = toolName + '\0' + signatureArgs;
    if (failed) {
      if (this.lastFailureSignature === failureSignature) {
        this.consecutiveIdenticalFailures += 1;
      } else {
        this.lastFailureSignature = failureSignature;
        this.consecutiveIdenticalFailures = 1;
      }
      if (
        this.consecutiveIdenticalFailures === 5 &&
        this.loopCorrectionIssuedFor !== failureSignature
      ) {
        this.loopCorrectionIssuedFor = failureSignature;
        extra.push(
          emit({
            type: 'warning',
            code: 'GLM_TOOL_LOOP_WARNING',
            message: (
              "Tool '" +
              toolName +
              "' failed 5 times with identical arguments; the turn is thrashing " +
              '(run telemetry only — the model does not receive this warning mid-turn).'
            ).slice(0, 500),
          }),
        );
      }
      if (this.consecutiveIdenticalFailures >= 10) {
        throw new ClaudeCodeHarnessError(
          'GLM_TOOL_LOOP',
          "Tool '" +
            toolName +
            "' failed 10 times with identical arguments (vary the approach: list the directory, or read a file inside it); aborting the phase instead of burning the run budget.",
        );
      }
    } else {
      this.lastFailureSignature = undefined;
      this.consecutiveIdenticalFailures = 0;
    }
    if (failed) {
      this.consecutiveFailures += 1;
    } else {
      this.consecutiveFailures = 0;
      this.rateCorrectionIssuedAt = undefined;
    }
    if (failed && this.consecutiveFailures === 15 && this.rateCorrectionIssuedAt === undefined) {
      this.rateCorrectionIssuedAt = this.consecutiveFailures;
      extra.push(
        emit({
          type: 'warning',
          code: 'GLM_TOOL_LOOP_WARNING',
          message: (
            'Fifteen consecutive tool calls failed without a success; ' +
            'the turn is sweeping blindly ' +
            '(run telemetry only — the model does not receive this warning mid-turn).'
          ).slice(0, 500),
        }),
      );
    }
    if (failed && this.consecutiveFailures >= 25) {
      throw new ClaudeCodeHarnessError(
        'GLM_TOOL_LOOP',
        'Twenty-five consecutive tool calls failed without a success; ' +
          'aborting the phase instead of burning the run budget.',
      );
    }
    this.loopWindow.push(failed);
    if (this.loopWindow.length > this.loopWindowSize) this.loopWindow.shift();
    if (this.loopWindow.length >= this.loopWindowSize) {
      const windowFailures = this.loopWindow.filter((outcome) => outcome).length;
      if (windowFailures >= this.loopWindowAbortFailures) {
        throw new ClaudeCodeHarnessError(
          'GLM_TOOL_LOOP',
          windowFailures +
            ' of the last ' +
            this.loopWindowSize +
            ' tool calls failed; ' +
            'aborting the phase instead of burning the run budget.',
        );
      }
    }
    return extra;
  }

  private probedExecutableVersion: string | undefined;
  private executableVersionProbed = false;

  constructor(private readonly options: ClaudeCodeHarnessAdapterOptions = {}) {
    this.hostEnvironment = options.environment ?? process.env;
    this.runtime = resolveGlmRuntime({ ...options, environment: this.hostEnvironment });
    this.clientFactory = options.clientFactory ?? createProductionClaudeClient;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 1_800_000;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? 30_000;
    const child = buildClaudeChildEnvironment({ source: this.hostEnvironment });
    this.environment = child.environment;
    this.childEnvironmentReport = child;
    this.secrets = secretValues(this.hostEnvironment);
    if (options.executableVersion !== undefined) {
      this.probedExecutableVersion = options.executableVersion;
      this.executableVersionProbed = true;
    }
  }

  /**
   * Effective binary version: the preflight-wired value when present,
   * otherwise a single bounded self-probe (`claude --version`, 5 s cap).
   * Never throws: probe failure yields undefined and the run proceeds to
   * the normal spawn path, where absence surfaces with typed errors.
   * Never consults the network; never persists credentials.
   */
  private async effectiveExecutableVersion(): Promise<string | undefined> {
    if (this.executableVersionProbed) return this.probedExecutableVersion;
    this.executableVersionProbed = true;
    try {
      this.probedExecutableVersion = await probeClaudeExecutable(
        this.runtime.executable,
        this.hostEnvironment,
      );
    } catch {
      this.probedExecutableVersion = undefined;
    }
    return this.probedExecutableVersion;
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

  private observeStreamEvent(
    stream: ClaudeStreamEvent,
    agentRunId: AgentRunId,
    emit: (value: Readonly<Record<string, unknown>>) => HarnessEvent,
    text: { value: string },
    turnUsage: { usage?: AgentUsage },
    forbidTools = false,
  ): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    const raw = stream.raw;
    if (stream.type === 'system' && raw['subtype'] === 'init') {
      const tools = Array.isArray(raw['tools']) ? raw['tools'] : [];
      // Forbidden tools must stay absent even with --disallowedTools: a
      // present Agent/Task tool means the composition failed open.
      // WebFetch/WebSearch are allowed investigative QA tools (§27-29)
      // and must NOT trip this check; report-turn tool use is still
      // failed by the reporting firewall. Artifact is denied: newer
      // Claude Code tool outside the Z.AI route's supported vocabulary
      // (provider 400 risk, no QA use) — present means composition
      // failed open. TaskOutput (background-task reader) is denied with
      // Task: it succeeded live without any visible Task launch, which
      // is either ledger-invisible subagent fanout or a blind spot.
      // TaskStop (background-task control) joins the fanout family: no QA
      // use, present in the 2.1.276 inventory.
      const forbiddenPresent = tools.filter(
        (tool): tool is string =>
          typeof tool === 'string' &&
          /^(agent|task|taskoutput|taskstop|skill|cron|schedulewakeup|artifact)$/i.test(tool),
      );
      if (forbiddenPresent.length > 0) {
        throw new ClaudeCodeHarnessError(
          'GLM_SUBAGENT_FORBIDDEN',
          'Claude Code session exposes forbidden tools: ' + forbiddenPresent.join(', '),
        );
      }
      // Preflight (deterministic, no model turns burned): the init
      // inventory must expose the required QA tools. Failing here — before
      // planning spends provider budget discovering it — with a precise code.
      const present = new Set(
        tools
          .filter((tool): tool is string => typeof tool === 'string')
          .map((tool) => tool.toLowerCase()),
      );
      const missing = ['bash', 'read'].filter((tool) => !present.has(tool));
      if (missing.length > 0) {
        throw new ClaudeCodeHarnessError(
          'GLM_TOOL_PERMISSION_UNAVAILABLE',
          'Claude Code session does not expose required QA tools: ' +
            missing.join(', ') +
            ' (failing fast before planning burns budget).',
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
          // Reporting firewall: the frozen ledger must not mutate. The
          // attempted tool is named (bounded, redacted) so correction
          // feedback and run history show what was refused.
          if (forbidTools) {
            const attempted = redactDiagnostic(
              eventText(record.name) ?? 'unknown',
              this.secrets,
            ).slice(0, 100);
            throw new ClaudeCodeHarnessError(
              'GLM_REPORT_TOOL_FORBIDDEN',
              "Claude Code attempted tool '" + attempted + "' during the tool-free reporting turn.",
            );
          }
          const toolUseId = eventText(record.id) ?? 'tool-' + this.operationCounter;
          const toolName = eventText(record.name) ?? 'unknown';
          if (
            toolName === 'Agent' ||
            toolName === 'Task' ||
            toolName === 'TaskOutput' ||
            toolName === 'TaskStop'
          ) {
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
        const isBashLike = /^(bash|powershell)$/i.test(toolName);
        const rawResultForFailure = textFromContentBlocks(
          Array.isArray(record.content) ? record.content : [record.content],
        );
        // Sandbox/bootstrap failures (bubblewrap dies before the shell
        // starts) are failures even when Claude Code does not set
        // is_error: the command never executed, so exit 0 must never be
        // recorded. Ordinary model errors (missing files, bad paths) stay
        // ordinary — only proven bootstrap markers qualify.
        const sandboxFailure = isBashLike && isSandboxBootstrapFailureText(rawResultForFailure);
        const failed = record.is_error === true || sandboxFailure;
        // Observable result text (bounded later, redacted at emit).
        // Computed BEFORE the completion event so failures carry their
        // real diagnostic instead of only a bare exit code.
        const rawResultText = rawResultForFailure;
        // A tool_result with is_error:true is NOT a shell exit code.
        // Only a provider-reported `Exit code N` prefix (verified 2.1.276
        // Bash shape) yields a numeric code; everything else stays
        // unknown with the reason in errorPreview. A non-error Bash
        // result WITHOUT bootstrap markers proves execution (exit 0); a
        // sandbox/bootstrap failure never yields an exit code — the shell
        // never started. Other tools have no exit concept at all.
        const exitMatch = /^Exit code (\d+)/.exec(rawResultText);
        const reportedExitCode =
          exitMatch?.[1] === undefined ? undefined : Number.parseInt(exitMatch[1], 10);
        const exitCode = sandboxFailure
          ? undefined
          : failed
            ? isBashLike &&
              reportedExitCode !== undefined &&
              Number.isInteger(reportedExitCode) &&
              reportedExitCode >= 0 &&
              reportedExitCode <= 255
              ? reportedExitCode
              : undefined
            : isBashLike
              ? 0
              : undefined;
        const errorPreview =
          failed && rawResultText.length > 0
            ? redactDiagnostic(rawResultText, this.secrets).slice(0, 1000)
            : undefined;
        out.push(
          emit({
            type: 'tool.completed',
            operationId,
            tool: {
              name: toolName,
              ...(exitCode === undefined ? {} : { exitCode }),
              ...(errorPreview === undefined ? {} : { errorPreview }),
              ...(sandboxFailure ? { infrastructureFailure: true } : {}),
            },
          }),
        );
        // Proven sandbox/bootstrap failure aborts the turn immediately
        // with a precise infrastructure code: continuing to guess project
        // structure with Read while Bash cannot start wastes budget and
        // produces degraded evidence. The completion above stays in `out`
        // so run history shows the trigger.
        if (sandboxFailure) {
          throw Object.assign(
            new ClaudeCodeHarnessError(
              'GLM_SANDBOX_UNAVAILABLE',
              'Claude Code sandbox failed to initialize (' +
                redactDiagnostic(rawResultText, this.secrets).slice(0, 300) +
                '); the shell command never executed. Repair the sandbox instead of retrying model turns.',
            ),
            { partialEvents: [...out] },
          );
        }
        // Futile-loop breakers run AFTER the completion lands in `out`
        // (see trackToolResult below): a throw must never vaporize the
        // very event that triggered it. On abort, the whole buffered `out`
        // rides along for the phase boundary to flush.
        try {
          out.push(
            ...this.trackToolResult(
              toolName,
              pending?.commandText ?? pending?.argsText ?? '',
              failed,
              emit,
            ),
          );
        } catch (cause) {
          if (isEventCarryingAbort(cause)) {
            throw Object.assign(cause, { partialEvents: [...out] });
          }
          throw cause;
        }
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
          // `exitCode` is the outer honest value: real provider-reported
          // codes (including real nonzero Bash failures) ground the ledger;
          // unknown stays unknown and never fabricates a code.
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
        // rawResultText computed above (same extraction); agent.message
        // persists the bounded observable text for run-history diagnosis.
        if (rawResultText.length > 0) {
          out.push(
            emit({
              type: 'agent.message',
              message: ('tool ' + toolName + ' result: ' + rawResultText).slice(0, 2_000),
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

  /**
   * Classify a raw transport/process failure into the most precise typed
   * code available from STRUCTURED signals only (exit codes, error names,
   * result-event payloads, timeout kinds). Human stderr/result text is
   * used only as a last-resort hint and is always redacted; credentials
   * never persist (all messages flow through redactDiagnostic).
   */
  private classifyTurnFailure(cause: unknown, phase: string): ClaudeCodeHarnessError {
    if (cause instanceof ClaudeCodeHarnessError) return cause;
    if (cause instanceof ClaudeTurnTimeoutError || cause instanceof ClaudeInitTimeoutError)
      return cause;
    const message = redactDiagnostic(cause, this.secrets);
    const text = cause instanceof Error ? cause.message + ' ' + cause.name : String(cause);
    if (/Claude client is closed/i.test(text))
      return new ClaudeCodeHarnessError('GLM_CANCEL_FAILED', message, true);
    if (/no initialization event within/i.test(text))
      return new ClaudeInitTimeoutError(this.initializeTimeoutMs);
    if (/exceeded its \d+ ms budget/i.test(text))
      return new ClaudeTurnTimeoutError(phase, this.turnTimeoutMs);
    if (/exited with code/i.test(text)) {
      if (/ENOENT/i.test(text))
        return new ClaudeCodeHarnessError(
          'GLM_BINARY_START_FAILED',
          'Claude Code binary could not be started: ' + message,
          false,
        );
      if (/EACCES|EPERM/i.test(text))
        return new ClaudeCodeHarnessError(
          'GLM_BINARY_START_FAILED',
          'Claude Code binary could not be executed: ' + message,
          false,
        );
      if (/429|rate.?limit|too many requests/i.test(text))
        return new ClaudeCodeHarnessError('GLM_PROVIDER_RATE_LIMITED', message, true);
      if (
        /50[023]|52[0-9]|gateway|overloaded|temporar|unavailable|timeout|ECONN|ENOTFOUND|socket/i.test(
          text,
        )
      )
        return new ClaudeCodeHarnessError('GLM_PROVIDER_TRANSIENT', message, true);
      if (/40[01]|bad request|invalid|incompatib|unsupported|unrecognized/i.test(text))
        return new ClaudeCodeHarnessError('GLM_PROVIDER_BAD_REQUEST', message, false);
      return new ClaudeCodeHarnessError('GLM_START_FAILED', message, true);
    }
    if (cause instanceof Error && cause.name === 'ZodError')
      return new ClaudeCodeHarnessError(
        'GLM_INVALID_RESULT',
        'Claude Code returned data that did not match the required schema.',
      );
    return new ClaudeCodeHarnessError('GLM_START_FAILED', message, true);
  }

  /**
   * Live streaming turn: consumes the owned Claude child incrementally
   * and yields each harness event to the coordinator as it is observed.
   * Loop breakers abort the owned turn mid-flight (no waiting for Claude
   * to finish); init/turn timeouts terminate the owned child; cancel
   * closes the client. Yields NOTHING on entry — every yield below is a
   * real observed event, so RunCoordinator's activity-aware timeout is
   * refreshed by genuine GLM activity, not turn completion.
   */
  private async *streamTurn(
    session: ClaudeSessionView,
    text: string,
    agentRunId: AgentRunId,
    phase: string,
    options?: { forbidTools?: boolean; jsonSchema?: Record<string, unknown> },
  ): AsyncGenerator<HarnessEvent, CollectedTurn> {
    // Per-turn loop state: a new turn starts clean so one turn's thrash
    // never leaks into the next (single choke point for both the live
    // and legacy-buffered branches below).
    this.resetLoopBreakers();
    const forbidTools = options?.forbidTools === true;
    // tools:'none' is a SEMANTIC Sentry contract enforced by the adapter
    // firewall (observeStreamEvent throws GLM_REPORT_TOOL_FORBIDDEN).
    // Phase reaches the process boundary (the SDK maps it to explicit
    // per-phase --allowedTools). Reporting stays tool-free: Claude Code
    // 2.1.276 offers no trustworthy native empty-tools mechanism (an
    // empty --allowedTools value is ignored), so the adapter firewall
    // owns tools:none. Do not pretend otherwise.
    const turnOptions =
      options?.jsonSchema === undefined
        ? forbidTools
          ? { phase: 'reporting' as const, tools: 'none' as const }
          : { phase: phase as 'planning' | 'investigation', tools: 'normal' as const }
        : {
            phase: 'reporting' as const,
            tools: 'none' as const,
            outputSchema: options.jsonSchema,
          };
    const emit = (value: Readonly<Record<string, unknown>>): HarnessEvent =>
      event(agentRunId, value);
    const collected: HarnessEvent[] = [];
    const textAcc: { value: string } = { value: '' };
    const turnUsage: { usage?: AgentUsage } = {};
    let result: ClaudeStreamEvent | undefined;
    let stream: ClaudeTurnStream | undefined;
    let legacyBuffered: ClaudeStreamEvent[] | undefined;
    try {
      const started = session.runText(text, turnOptions) as
        ClaudeTurnStream | Promise<ClaudeStreamEvent[]> | Promise<ClaudeTurnStream>;
      if (started instanceof Promise) {
        const awaited = await started;
        if (Symbol.asyncIterator in Object(awaited)) {
          stream = awaited as ClaudeTurnStream;
        } else {
          legacyBuffered = awaited as ClaudeStreamEvent[];
        }
      } else {
        stream = started;
      }
    } catch (cause) {
      throw this.classifyTurnFailure(cause, phase);
    }
    // Legacy fake-array sessions (existing unit tests): process the
    // completed array through the same observer path. No live abort is
    // possible there (nothing is running), but thresholds still throw
    // GLM_TOOL_LOOP with identical semantics.
    if (legacyBuffered !== undefined) {
      for (const chunk of legacyBuffered) {
        if (chunk.type === 'result') result = chunk;
        let produced: HarnessEvent[];
        try {
          produced = this.observeStreamEvent(
            chunk,
            agentRunId,
            emit,
            textAcc,
            turnUsage,
            forbidTools,
          );
        } catch (cause) {
          if (isEventCarryingAbort(cause)) {
            throw Object.assign(cause, {
              partialEvents: [...collected, ...partialTurnEvents(cause)],
            });
          }
          throw cause instanceof ClaudeCodeHarnessError
            ? cause
            : new ClaudeCodeHarnessError(
                'GLM_INVALID_RESULT',
                'Claude Code stream event could not be interpreted.',
              );
        }
        for (const emitted of produced) {
          collected.push(emitted);
          this.toolNotes.add(emitted);
          yield emitted;
        }
      }
      return { text: textAcc.value, events: collected, usage: turnUsage.usage, result };
    }
    const live = stream as ClaudeTurnStream;
    // Track the live turn so cancel() can abort it mid-flight without
    // waiting for Claude to finish. Cleared in the finally below.
    this.activeTurn = live;
    try {
      for await (const chunk of live) {
        if (chunk.type === 'result') result = chunk;
        let produced: HarnessEvent[];
        try {
          produced = this.observeStreamEvent(
            chunk,
            agentRunId,
            emit,
            textAcc,
            turnUsage,
            forbidTools,
          );
        } catch (cause) {
          // Loop abort: flush the turn-so-far plus the trigger's buffer,
          // THEN terminate the owned child so no further provider tokens
          // burn. The model does not continue this turn after abort.
          if (isEventCarryingAbort(cause)) {
            const merged = [...collected, ...partialTurnEvents(cause)];
            for (const emitted of merged.slice(collected.length)) {
              collected.push(emitted);
              this.toolNotes.add(emitted);
              yield emitted;
            }
            await live.abort().catch(() => undefined);
            throw Object.assign(cause, { partialEvents: [...collected] });
          }
          await live.abort().catch(() => undefined);
          throw cause instanceof ClaudeCodeHarnessError
            ? cause
            : new ClaudeCodeHarnessError(
                'GLM_INVALID_RESULT',
                'Claude Code stream event could not be interpreted.',
              );
        }
        for (const emitted of produced) {
          collected.push(emitted);
          this.toolNotes.add(emitted);
          yield emitted;
        }
      }
    } catch (cause) {
      if (isEventCarryingAbort(cause)) {
        if (!('partialEvents' in (cause as object))) {
          throw Object.assign(cause, { partialEvents: [...collected] });
        }
        throw cause;
      }
      throw this.classifyTurnFailure(cause, phase);
    } finally {
      if (this.activeTurn === live) this.activeTurn = undefined;
    }
    return { text: textAcc.value, events: collected, usage: turnUsage.usage, result };
  }

  /**
   * Buffered compatibility turn: collects the live stream (legacy fake
   * sessions + non-streaming callers). Retained for compatibility;
   * production phases use streamPhaseTurn so the coordinator observes
   * every event mid-turn.
   */
  private async runTurn(
    session: ClaudeSessionView,
    text: string,
    agentRunId: AgentRunId,
    phase: string,
    options?: { forbidTools?: boolean; jsonSchema?: Record<string, unknown> },
  ): Promise<CollectedTurn> {
    const collected: HarnessEvent[] = [];
    const gen = this.streamTurn(session, text, agentRunId, phase, options);
    let step = await gen.next();
    while (step.done !== true) {
      collected.push(step.value);
      step = await gen.next();
    }
    const final = step.value as CollectedTurn;
    return { text: final.text, events: collected, usage: final.usage, result: final.result };
  }

  /**
   * Live phase turn: yields every observed harness event IMMEDIATELY so
   * the run() generator forwards it to the coordinator mid-turn (which
   * persists it and refreshes the activity-aware timeout), and resolves
   * the collected turn for phase parsing. On loop-abort the owned child
   * is already terminated inside streamTurn; the throw's partialEvents
   * carry only the unyielded tail (normally empty — streamTurn yields
   * each event before the abort throw), so phase catch blocks flush
   * without double-yielding.
   */
  private async *streamPhaseTurn(
    session: ClaudeSessionView,
    text: string,
    agentRunId: AgentRunId,
    phase: string,
    options?: { forbidTools?: boolean; jsonSchema?: Record<string, unknown> },
  ): AsyncGenerator<HarnessEvent, CollectedTurn> {
    const gen = this.streamTurn(session, text, agentRunId, phase, options);
    let step = await gen.next();
    let delivered = 0;
    const forwarded: HarnessEvent[] = [];
    let final: CollectedTurn | undefined;
    try {
      while (step.done !== true) {
        forwarded.push(step.value);
        delivered += 1;
        yield step.value;
        step = await gen.next();
      }
      final = step.value as CollectedTurn;
    } catch (cause) {
      // Already yielded `delivered` events: only the unyielded tail
      // (normally empty) may flush in the phase catch block.
      if (isEventCarryingAbort(cause)) {
        const all = [...partialTurnEvents(cause)];
        throw Object.assign(cause, { partialEvents: all.slice(delivered) });
      }
      throw cause;
    }
    if (final === undefined) {
      throw new ClaudeCodeHarnessError(
        'GLM_INVALID_RESULT',
        'Claude Code phase turn ended without a result.',
      );
    }
    return { text: final.text, events: forwarded, usage: final.usage, result: final.result };
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

    // Version policy (data-driven, TASK-0012): the tested version is
    // ready; live-proven incompatible versions fail closed BEFORE any
    // provider budget burns; unknown newer versions warn and continue
    // (never silent). The version is self-probed when preflight did not
    // wire one in (production runtimes call createAdapter directly), so
    // a blocked binary can never slip through on an unwired path.
    // Credential scrubbing and the fail-closed sandbox apply in every
    // branch — version handling never weakens them.
    const actualVersion = await this.effectiveExecutableVersion();
    const policy = classifyClaudeCodeVersion(actualVersion);
    if (policy === 'blocked') {
      yield event(request.agentRunId, {
        type: 'run.failed',
        failure: {
          code: 'GLM_CLAUDE_VERSION_UNSUPPORTED',
          message: (
            'Claude Code executable reports version ' +
            (actualVersion ?? 'unknown').slice(0, 100) +
            ', which Sentry live smoke proved incompatible with the WSL/bubblewrap Bash sandbox; ' +
            'Sentry validated adapter behavior against ' +
            CLAUDE_CODE_TESTED_VERSION +
            '. Set SENTRY_CLAUDE_BINARY to the validated binary.'
          ).slice(0, 500),
          retryable: false,
        },
      });
      return;
    }
    if (actualVersion !== undefined && policy === 'unverified') {
      yield event(request.agentRunId, {
        type: 'warning',
        code: 'GLM_CLAUDE_VERSION_UNVERIFIED',
        message: (
          'Claude Code executable reports version ' +
          actualVersion.slice(0, 100) +
          '; Sentry validated adapter behavior against ' +
          CLAUDE_CODE_TESTED_VERSION +
          '. Continuing: newer versions are used opportunistically, not failed.'
        ).slice(0, 500),
      });
    }
    // WSL mount-isolation preflight (no provider spend): when this worker
    // runs on WSL, Claude must start inside a mount namespace where
    // `/mnt/c` is shadowed — otherwise its unconditional Windows-profile
    // enumeration feeds inaccessible `/.claude/ide` paths to bubblewrap
    // and every Bash call dies before the shell starts. The launcher
    // selected here governs every turn spawned below via the spec.
    const isolationOverride = this.options.wslMountIsolationOverride;
    const wslWorker =
      isolationOverride !== undefined || isWslEnvironment(this.hostEnvironment, process.platform);
    let launcher: ClaudeProcessLauncher | undefined;
    if (wslWorker) {
      const isolation =
        isolationOverride !== undefined
          ? isolationOverride
          : await probeClaudeWslMountIsolation({
              executable: this.runtime.executable,
              workspaceDir: request.workspace.runtimePath,
              environment: this.hostEnvironment,
            });
      if (isolation.status !== 'available') {
        yield event(request.agentRunId, {
          type: 'run.failed',
          failure: {
            code: 'GLM_SANDBOX_UNAVAILABLE',
            message: (
              'Claude Code WSL mount isolation is unavailable (' +
              isolation.reason +
              '); the worker could not hide Windows host mounts before Claude startup. ' +
              'No provider turn was started.'
            ).slice(0, 500),
            retryable: false,
          },
        });
        return;
      }
      launcher = new SystemdIsolatedClaudeProcessLauncher();
    }
    // Windows-profile diagnostic (read-only, names only): with mount
    // isolation healthy the blockers below are IRRELEVANT to Claude (it
    // cannot see /mnt/c at all) and are reported informationally; they
    // stay fatal only when isolation itself is unavailable — which
    // already returned above. Never repair host ACLs for these.
    let profileBlockers: readonly string[] = [];
    try {
      const usersRoot = this.options.windowsUsersRoot;
      profileBlockers = await probeWindowsProfileSandboxBlockers(
        usersRoot === undefined ? {} : { usersRoot },
      );
    } catch {
      profileBlockers = [];
    }
    if (profileBlockers.length > 0) {
      yield event(request.agentRunId, {
        type: 'warning',
        code: 'GLM_WINDOWS_PROFILES_HIDDEN',
        message: (
          'Host Windows profiles detected (' +
          profileBlockers.join(', ') +
          ') but hidden from the Claude worker namespace by mount isolation; ' +
          'no host repair needed.'
        ).slice(0, 500),
      });
    }
    yield event(request.agentRunId, {
      type: 'agent.status',
      status: 'planning',
      message: 'Claude Code is creating a frozen investigation plan.',
    });
    // Ephemeral Sentry-owned home+config boundary: the Claude worker must
    // never depend on the host user's profile directory (a Windows-mounted
    // or corrupt HOME makes bwrap fail before any tool runs). Both HOME
    // and CLAUDE_CONFIG_DIR point beneath this disposable directory and
    // are destroyed after extraction. Never the user's ordinary environment.
    const claudeHome = join(dirname(request.workspace.runtimePath), '.sentry-claude-home');
    const ephemeralHome = join(claudeHome, 'home');
    const ephemeralClaudeDir = join(ephemeralHome, '.claude');
    const configDir = join(claudeHome, 'config');
    const settingsPath = join(configDir, 'sentry-settings.json');
    let session: ClaudeSessionView | undefined;
    try {
      await mkdir(ephemeralClaudeDir, { recursive: true });
      await mkdir(configDir, { recursive: true });
      await writeFile(settingsPath, JSON.stringify(buildClaudeSettings()), 'utf8');
      const spec: ClaudeSpawnSpec = {
        executable: this.runtime.executable,
        cwd: request.workspace.runtimePath,
        configDir,
        homeDir: ephemeralHome,
        environment: this.environment,
        modelId: this.runtime.modelId,
        settingsPath,
        initializeTimeoutMs: this.initializeTimeoutMs,
        turnTimeoutMs: this.turnTimeoutMs,
        shutdownTimeoutMs: this.shutdownTimeoutMs,
        // WSL workers launch isolated (mount namespace hides /mnt/c);
        // every other platform spawns direct. Test seams (spawnProcess)
        // take precedence inside the client regardless.
        ...(launcher === undefined ? {} : { launcher }),
      };
      this.client = await this.clientFactory(spec);
      session = await this.client.startSession();
      let recoveryContext = '';
      let recoveryUsed = false;
      const startReportContext = async () => {
        await this.dispose();
        if (this.cancelled)
          throw new ClaudeCodeHarnessError(
            'GLM_CANCEL_FAILED',
            'Run cancelled before report recovery.',
          );
        const candidate = await this.clientFactory(spec);
        if (this.cancelled) {
          await candidate.close();
          throw new ClaudeCodeHarnessError(
            'GLM_CANCEL_FAILED',
            'Run cancelled before report recovery.',
          );
        }
        this.client = candidate;
        this.closePromise = undefined;
        session = await candidate.startSession();
        if (this.cancelled)
          throw new ClaudeCodeHarnessError(
            'GLM_CANCEL_FAILED',
            'Run cancelled before report recovery.',
          );
        recoveryUsed = true;
        recoveryContext = buildRecoveryReportContext(request, this.toolNotes.render()) + '\n';
      };
      markGlmRuntimeVerified();
      const pipeline = pipelineContext(this.secrets);
      // STAGE 1 — planning with one bounded correction. A prose-first or
      // misshapen plan retries once in the same session with the parse
      // error fed back; planning ops stay valid (ledger not frozen yet).
      // Each planning turn spawns its own owned child (same session id
      // minted once; resume chain continues into investigation).
      let planResult: ReturnType<typeof SentryInvestigationPlanV1Schema.parse> | undefined;
      let planCorrection: string[] | undefined;
      let planningTurns = 0;
      let planningUsage: AgentUsage | undefined;
      for (let attempt = 1; attempt <= MAX_PLANNING_ATTEMPTS; attempt += 1) {
        let planning: CollectedTurn;
        {
          // Live: each observed event is yielded to the coordinator
          // mid-turn (activity-aware timeout refresh); the resolved
          // turn feeds plan parsing only (its events already yielded).
          const live = this.streamPhaseTurn(
            session,
            planCorrection === undefined
              ? buildQaPlanningPrompt(request)
              : buildPlanningCorrectionIntro(planCorrection),
            request.agentRunId,
            'planning',
          );
          try {
            let step = await live.next();
            while (step.done !== true) {
              yield step.value;
              step = await live.next();
            }
            planning = step.value;
          } catch (cause) {
            // Loop abort: unflushed tail only (live events already sent).
            for (const emitted of partialTurnEvents(cause)) yield emitted;
            throw cause;
          }
        }
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
            code: 'GLM_PLANNING_RETRY',
            message:
              'Claude Code planning attempt ' + attempt + ' rejected; retrying planning only.',
          });
        } else {
          throw new ClaudeCodeHarnessError(
            'GLM_INVALID_RESULT',
            'Claude Code planning failed after ' +
              MAX_PLANNING_ATTEMPTS +
              ' attempts: ' +
              (planCorrection ?? []).map(boundCorrectionMessage).join('; '),
          );
        }
      }
      if (planResult === undefined)
        throw new ClaudeCodeHarnessError('GLM_INVALID_RESULT', 'Claude Code produced no plan.');
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
      // STAGE 2 — investigation only. Terminal prose is ignored (never
      // parsed as a result, never persisted as reasoning); tool events
      // carry the evidentiary facts. Live: yielded mid-turn so the
      // coordinator's activity window tracks real tool work.
      const depth = depthPolicy(request.task.context);
      let challenge: CollectedTurn | undefined;
      let validationIssued = 0;
      let reportingIssued = 0;
      let investigation: CollectedTurn | undefined;
      {
        const work = this.streamPhaseTurn(
          session,
          buildQaInvestigationPrompt(planResult, this.observedOperations),
          request.agentRunId,
          'investigation',
        );
        const live =
          depth === undefined
            ? work
            : limitPhase(work, investigationDeadline(depth.deadlineAt), () => this.dispose());
        try {
          let step = await live.next();
          while (step.done !== true) {
            yield step.value;
            step = await live.next();
          }
          investigation = step.value;
        } catch (cause) {
          for (const emitted of partialTurnEvents(cause)) yield emitted;
          if (!(cause instanceof PhaseDeadlineReached) || this.cancelled) throw cause;
          await startReportContext();
          yield event(request.agentRunId, {
            type: 'warning',
            code: 'QA_INVESTIGATION_INCOMPLETE',
            message:
              'Investigation reached its phase deadline. Reporting only this agent’s observed facts in a fresh report-only context; analysis is partial.',
          });
        }
      }

      // STAGE 3 — reporting against the frozen ledger. Strict whole-
      // document JSON only. Provider structured output (--json-schema)
      // is REMOVED from the report flow: measured live, the schema path
      // never produced a successful report and killed two runs (~20min
      // validator fights → run timeout), in both default and repair
      // positions. Parse failures recycle through the correction loop
      // (bounded report attempts); investigation never reruns.
      yield event(request.agentRunId, {
        type: 'agent.status',
        status: 'reporting',
        message: 'Claude Code is serializing the frozen investigation into a report.',
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
              // Live: report-turn events stream mid-turn; the resolved turn
              // feeds report parsing only (its events already yielded).
              if (reportPass > 0) {
                reporting = await boundedValidation(
                  () =>
                    this.runTurn(session!, reportText, request.agentRunId, 'reporting', {
                      forbidTools: true,
                    }),
                  Math.max(1, depth!.deadlineAt - Date.now() - 30_000),
                  stopValidation,
                );
                for (const emitted of reporting.events) yield emitted;
              } else {
                const work = this.streamPhaseTurn(
                  session!,
                  reportText,
                  request.agentRunId,
                  'reporting',
                  { forbidTools: true },
                );
                const live =
                  depth === undefined
                    ? work
                    : limitPhase(
                        work,
                        reportAttemptDeadline(depth.deadlineAt, attempt),
                        () => this.dispose(),
                        'Reporting',
                      );
                let step = await live.next();
                while (step.done !== true) {
                  yield step.value;
                  step = await live.next();
                }
                reporting = step.value;
              }
            } catch (cause) {
              for (const emitted of partialTurnEvents(cause)) yield emitted;
              // Firewall trip: the model attempted a tool call in the
              // tool-free turn. Per protocol this fails the REPORT ATTEMPT
              // (not the run): the correction loop tells the model to
              // serialize from the frozen ledger without tools.
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
                cause instanceof ClaudeCodeHarnessError &&
                cause.code === 'GLM_REPORT_TOOL_FORBIDDEN'
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
            // A completed report turn consumed a model turn: account it.
            // Live events already yielded above stay persisted either way;
            // the resolved turn feeds parsing only (never re-yielded).
            if (reporting !== undefined) {
              if (reporting.usage === undefined) reportTurns.push({});
              else reportTurns.push({ usage: reporting.usage });
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
            // Firewall trips (reporting undefined) arrive here with errors
            // already set; parse/build failures arrive via the block above.
            if (errors === undefined) {
              throw new ClaudeCodeHarnessError(
                'GLM_INVALID_RESULT',
                'Claude Code report attempt produced no result and no error.',
              );
            }
            correction = errors;
            if (attempt < MAX_REPORT_ATTEMPTS) {
              // Observability: persist the bounded rejection reasons (not just
              // the count) so a failed correction loop is diagnosable from run
              // history without the model's raw report text.
              const reasonPreview = errors
                .slice(0, 3)
                .map((issue) => boundCorrectionMessage(issue))
                .join('; ')
                .slice(0, 1_500);
              yield event(request.agentRunId, {
                type: 'warning',
                code: 'GLM_REPORT_RETRY',
                message: (
                  'Claude Code report attempt ' +
                  attempt +
                  ' rejected; retrying report only (' +
                  errors.length +
                  ' issues): ' +
                  reasonPreview
                ).slice(0, 2_000),
              });
            } else {
              throw new ClaudeCodeHarnessError(
                'GLM_INVALID_RESULT',
                'Claude Code report failed after ' +
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
                session!,
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
        throw new ClaudeCodeHarnessError('GLM_INVALID_RESULT', 'Claude Code produced no report.');
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
          code: 'GLM_LIMITATION',
          message: limitation,
        });
      // Actual turn accounting: every planning attempt + investigation +
      // every report attempt (initial, schema-fallback retries,
      // corrections). Never hardcoded.
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
      // Structured-first classification: typed harness errors (loop,
      // firewall, timeouts) pass through verbatim; transport/process
      // failures map via classifyTurnFailure. Auth/sandbox hints apply
      // only when no precise signal exists.
      const typed =
        cause instanceof PhaseDeadlineReached
          ? new ClaudeCodeHarnessError('QA_REPORT_DEADLINE', cause.message, false)
          : cause instanceof ClaudeCodeHarnessError
            ? cause
            : (() => {
                const text = String(cause);
                if (
                  /not logged in|login|authentication_failed|unauthorized|api key|credential|sign in|401/i.test(
                    text,
                  )
                )
                  return new ClaudeCodeHarnessError(
                    'GLM_AUTH_FAILED',
                    redactDiagnostic(cause, this.secrets),
                  );
                if (/sandbox/i.test(text))
                  return new ClaudeCodeHarnessError(
                    'GLM_SANDBOX_UNAVAILABLE',
                    redactDiagnostic(cause, this.secrets),
                  );
                return this.classifyTurnFailure(cause, 'run');
              })();
      yield event(request.agentRunId, {
        type: 'run.failed',
        failure: {
          code: typed.code,
          message: redactDiagnostic(typed, this.secrets),
          retryable: typed.retryable,
        },
      });
    } finally {
      // Ephemeral state destroyed after extraction: home profile,
      // transcripts, plugins, skills, hooks, MCP config, memory, settings.
      // Only canonical observable data already persisted by the
      // coordinator survives.
      await rm(claudeHome, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async cancel(_runId: AgentRunId): Promise<void> {
    this.cancelled = true;
    try {
      // Live cancel: abort the in-flight owned turn immediately so the
      // child dies while the turn is active (not at process exit), then
      // dispose the client. Owned handle only — never by process name.
      const turn = this.activeTurn;
      if (turn !== undefined) await turn.abort().catch(() => undefined);
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
    const turn = this.activeTurn;
    if (client === undefined && turn === undefined) {
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }
    this.closePromise = (async () => {
      if (turn !== undefined) await turn.abort().catch(() => undefined);
      this.activeTurn = undefined;
      if (client !== undefined) await client.close();
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
