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
  describeSentryAgentEvidenceContract,
  EvidenceSchema,
  FindingSchema,
  HarnessEventSchema,
  SentryAgentResultV1Schema,
  SentryInvestigationPlanV1Schema,
  type AgentUsage,
  type Evidence,
  type FindingConfidence,
  type HarnessEvent,
  type HarnessRunRequest,
  type SentryAgentEvidenceV1,
  type SentryAgentResultV1,
} from '@qa/schemas';
import { validateFindingTrust } from '@qa/domain';
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

async function buildBaselineIndex(
  // workspace/project runtime path; the sidecar lives in Sentry-owned
  // .sentry-workspace/ next to it (outside the agent-visible project tree).
  workspaceRuntimePath: string,
  snapshotId: string,
): Promise<BaselineFileIndex | undefined> {
  try {
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const sidecar = join(
      dirname(workspaceRuntimePath),
      '.sentry-workspace',
      'baseline-hashes.json',
    );
    const raw = await readFile(sidecar, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as {
      schemaVersion?: unknown;
      snapshotId?: unknown;
      files?: unknown;
    };
    // Snapshot-anchored: a sidecar from another run must never classify.
    if (record.schemaVersion !== 1 || record.snapshotId !== snapshotId) return undefined;
    if (record.files === null || typeof record.files !== 'object' || Array.isArray(record.files))
      return undefined;
    const map = new Map<string, string>();
    for (const [key, value] of Object.entries(record.files as Record<string, unknown>)) {
      if (typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)) map.set(key, value);
    }
    return { fileHashByPath: map };
  } catch {
    // Absent/unreadable sidecar: conservative modified_workspace.
  }
  return undefined;
}

/**
 * Production finding gate delegates to the single generic trust policy
 * (validateFindingTrust in @qa/domain). The adapter only translates the
 * verdict into its canonical MUSE_INVALID_RESULT error; no duplicate
 * confidence logic lives here.
 */
function validateProductionFindings(
  findings: ReadonlyArray<{
    readonly evidenceKeys: readonly string[];
    readonly confidence: FindingConfidence;
  }>,
  evidenceByKey: ReadonlyMap<string, Evidence>,
): void {
  for (const finding of findings) {
    const evidence = [...evidenceByKey.values()];
    const verdict = validateFindingTrust(
      {
        confidence: finding.confidence,
        evidenceIds: finding.evidenceKeys.map(
          (key) => (evidenceByKey.get(key)?.id ?? key) as Evidence['id'],
        ),
      },
      evidence,
    );
    if (!verdict.ok) {
      throw new MuseHarnessError('MUSE_INVALID_RESULT', verdict.reason);
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

function summarizeSchemaIssues(error: {
  issues: Array<{ path: Array<string | number>; message: string }>;
}): string {
  // Paths only, never model values; bounded so the message stays a summary.
  return error.issues
    .slice(0, 8)
    .map((issue) => issue.path.join('.') + ': ' + issue.message)
    .join('; ')
    .slice(0, 500);
}

function parseAgentResult(text: string, secrets: readonly string[]): SentryAgentResultV1 {
  const parsed = SentryAgentResultV1Schema.safeParse(parseWholeJson(text, 'execution', secrets));
  if (parsed.success) return parsed.data;
  throw new MuseHarnessError(
    'MUSE_INVALID_RESULT',
    'Muse execution result did not match the required schema (' +
      summarizeSchemaIssues(parsed.error) +
      ').',
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

/** One observed tool/command execution, adapter-owned correlation identity. */
export interface ObservedOperation {
  readonly operationId: OperationId;
  /** Temporary agent-visible correlation key (op_1, op_2, ...). */
  readonly operationKey: string;
  readonly toolName: string;
  readonly commandText?: string;
  readonly argsText?: string;
  readonly exitCode?: number;
  /** True when this operation ran a test command (generic detection). */
  readonly isTestOperation: boolean;
  readonly durationMs?: number;
}

export interface ObservedEvidenceGrounding {
  readonly observedCommands: ReadonlySet<string>;
  readonly operations: ReadonlyMap<string, ObservedOperation>;
  readonly baseline?: BaselineFileIndex;
  /** Host secret values for redacting model-supplied strings in diagnostics. */
  readonly secrets?: readonly string[];
}

function groundingOf(observedCommands: ReadonlySet<string>): ObservedEvidenceGrounding {
  return { observedCommands, operations: new Map<string, ObservedOperation>() };
}

const TEST_COMMAND_PATTERN =
  /\b(pnpm|npm|yarn|bun|node|npx|vitest|jest|pytest|dotnet\s+test|cargo\s+test|go\s+test|mvn(\s+test)?|gradle(\s+test)?|phpunit|rspec)\b/i;

function normalizeCommandText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function commandIdentity(command: string, exitCode: number): string {
  return JSON.stringify([normalizeCommandText(command), exitCode]);
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
  // Operation-specific grounding (HIGH C): a claim is grounded ONLY by the
  // specific observed operation it names via operationKey. An unrelated tool
  // run elsewhere in the session never grounds a claim. Unknown operation
  // keys are rejected. Policy for misrepresented reproduction: a reproduced
  // strength without a correlated operation is rejected as MUSE_INVALID_RESULT
  // (the model explicitly misrepresents reproduction); weaker ungrounded
  // test/runtime/log claims are downgraded to manual/agent_reasoning.
  const isReproducedClaim =
    source.strength === 'reproduced_failure' || source.strength === 'reproduced_behavior';
  const needsOperation =
    source.type === 'test' || source.type === 'runtime' || source.type === 'log';
  let correlated: ObservedOperation | undefined;
  if (source.operationKey !== undefined) {
    correlated = observed.operations.get(source.operationKey);
    if (correlated === undefined) {
      throw new MuseHarnessError(
        'MUSE_INVALID_RESULT',
        'Evidence references an unknown operation correlation key.',
      );
    }
    if (source.type === 'test' && !correlated.isTestOperation) {
      throw new MuseHarnessError(
        'MUSE_INVALID_RESULT',
        'Test evidence references an operation that did not run tests.',
      );
    }
    if (
      source.type === 'test' &&
      source.status !== undefined &&
      correlated.exitCode !== undefined
    ) {
      const observedStatus = correlated.exitCode === 0 ? 'passed' : 'failed';
      if (observedStatus !== source.status) {
        throw new MuseHarnessError(
          'MUSE_INVALID_RESULT',
          'Test evidence status does not match the observed operation result.',
        );
      }
    }
  } else if (needsOperation) {
    if (isReproducedClaim) {
      throw new MuseHarnessError(
        'MUSE_INVALID_RESULT',
        'Reproduced evidence strength requires a correlated observed operation.',
      );
    }
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
        summary: 'Ungrounded ' + source.type + ' claim downgraded: ' + source.description,
        author: 'Muse Code',
      },
    });
  }
  const downgradedManual = (summary: string): Evidence =>
    EvidenceSchema.parse({
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
      manual: { summary, author: 'Muse Code' },
    });
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
    const reference = await codeReference(request.workspace.runtimePath, source, observed.baseline);
    return EvidenceSchema.parse({
      ...base,
      environmentState: reference.sourceState,
      type: 'code_reference',
      codeReference: reference,
    });
  }
  if (source.type === 'command') {
    // Canonical integrity: the OBSERVED operation is authoritative. When an
    // operation link exists, command/exitCode/durationMs derive from it —
    // model-authored text can never become the canonical execution record.
    // Text mismatch policy (deterministic): reproduced claims are rejected
    // as misrepresentation; weaker ones downgrade to manual reasoning.
    // Exit-code alteration on a matched operation is always fatal (spoofing).
    if (source.operationKey !== undefined) {
      const linked = observed.operations.get(source.operationKey);
      if (linked === undefined) {
        throw new MuseHarnessError(
          'MUSE_INVALID_RESULT',
          'Command evidence references an unknown operation correlation key.',
        );
      }
      if (linked.commandText === undefined || linked.exitCode !== source.exitCode) {
        throw new MuseHarnessError(
          'MUSE_INVALID_RESULT',
          'Command evidence operation does not match the claimed exit code.',
        );
      }
      if (
        source.command !== undefined &&
        normalizeCommandText(source.command) !== normalizeCommandText(linked.commandText)
      ) {
        if (isReproducedClaim) {
          throw new MuseHarnessError(
            'MUSE_INVALID_RESULT',
            'Reproduced command evidence text does not match the linked observed operation.',
          );
        }
        return downgradedManual(
          'Command text differs from the linked observed operation; downgraded: ' +
            source.description,
        );
      }
      return EvidenceSchema.parse({
        ...base,
        type: 'command',
        command: {
          command: linked.commandText,
          exitCode: linked.exitCode,
          ...(linked.durationMs === undefined ? {} : { durationMs: linked.durationMs }),
        },
      });
    } else if (
      source.command === undefined ||
      source.exitCode === undefined ||
      !observed.observedCommands.has(commandIdentity(source.command, source.exitCode))
    ) {
      // Proportional policy (consistent with test/runtime/log handling): a
      // non-matching command claim with reproduced strength is explicit
      // misrepresentation and fails the run; a weaker one downgrades to
      // manual reasoning so one paraphrased recon command cannot nuke the
      // whole investigation. Identity for command-type evidence itself is
      // never weakened. EXCEPTION (spoofing, always fatal): the claimed
      // command text matches an observed execution but the exit code was
      // altered — that is fabricated proof, regardless of strength.
      const claimedText =
        source.command === undefined ? undefined : normalizeCommandText(source.command);
      const textObserved =
        claimedText !== undefined &&
        [...observed.observedCommands].some((entry) => {
          try {
            const parsed: unknown = JSON.parse(entry);
            return Array.isArray(parsed) && parsed[0] === claimedText;
          } catch {
            return false;
          }
        });
      if (textObserved) {
        throw new MuseHarnessError(
          'MUSE_INVALID_RESULT',
          'Command evidence exit code does not match the observed execution.',
        );
      }
      if (isReproducedClaim) {
        const claimed =
          source.command === undefined
            ? 'missing'
            : redactDiagnostic(source.command, observed.secrets ?? []).slice(0, 200);
        throw new MuseHarnessError(
          'MUSE_INVALID_RESULT',
          'Reproduced command evidence does not match an observed Muse command execution ' +
            '(claimed command=' +
            claimed +
            ' exitCode=' +
            String(source.exitCode) +
            ').',
        );
      }
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
            'Unmatched command claim downgraded (claimed command=' +
            (source.command === undefined
              ? 'missing'
              : redactDiagnostic(source.command, observed.secrets ?? []).slice(0, 200)) +
            ' exitCode=' +
            String(source.exitCode) +
            '): ' +
            source.description,
          author: 'Muse Code',
        },
      });
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
    'Create an investigation plan before executing it. Return exactly one JSON document and no Markdown: no code fences, no preamble, no commentary, just the raw JSON object.',
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
    'Use only the repository toolchain already present in the workspace; do not download packages or install dependencies from the network (no npx fetches, no npm/pip installs). If a test runner is unavailable, record it as a limitation.',
    'Keep the investigation tight: a handful of targeted checks beats dozens of exploratory commands. Do not repeat commands that already produced results.',
    'Return exactly one JSON document and no Markdown. Do not invent file paths or command results.',
    'Use temporary evidence keys only; Sentry owns all durable IDs.',
    'Finding category MUST be exactly one of: build, runtime, logic, api, frontend, database, authentication, authorization, security, configuration, performance, concurrency, dependency, testing, cicd, deployment, maintainability, documentation, other. Copy the string exactly; any other value (for example correctness) fails validation. Severity MUST be exactly one of: critical, high, medium, low, info. Confidence MUST be exactly one of: confirmed, strong, probable, speculative.',
    'Evidence type MUST be exactly one of: command, runtime, code_reference, test, log, manual. Strength MUST be exactly one of: reproduced_failure, reproduced_behavior, tool_diagnostic, strong_code_evidence, agent_reasoning.',
    'For command evidence, use ONLY short single-purpose commands you issued alone (never chains joined by &&, ;, or |, never pipelines): reproduce the command text EXACTLY character-for-character as you issued it, with the exact exit code you observed. Any deviation fails validation. Prefer test and code_reference evidence for findings over command evidence.',
    'For test/runtime/log evidence, set operationKey to the observed operation that produced it: op_1 is your first tool/command operation this session, op_2 the second, and so on in execution order. Omit operationKey only for pure reasoning/manual evidence. Never invent operation keys.',
    'Evidence item contract (every field the parser accepts; copy names exactly): ' +
      describeSentryAgentEvidenceContract(),
    'Schema: {"schemaVersion":1,"summary":string,"checks":[{"name":string,"status":"passed|failed|inconclusive|not_run","details"?:string}],"hypotheses":[{"title":string,"rationale":string,"relatedPaths":string[],"plannedChecks":string[at least one]}],"evidence":[<see Evidence item contract above>],"findings":[{"title":string,"category":string,"categoryDetail"?:string,"severity":"critical|high|medium|low|info","confidence":"confirmed|strong|probable|speculative","description":string,"expectedBehavior"?:string,"actualBehavior"?:string,"locations":[{"relativePath":string,"lineStart"?:number,"lineEnd"?:number,"symbol"?:string}],"evidenceKeys":string[],"reproductionSteps":string[],"rootCause"?:string,"recommendedFix"?:string}],"limitations":string[]}.',
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
  ): AsyncGenerator<HarnessEvent, TurnCollection> {
    // Per-turn watchdog (the SDK never times out a turn locally, INV-006, so
    // Sentry owns the bound): the inner generator is pumped one step at a
    // time, racing each next() against the deadline. A wedged item stream
    // (no yields at all) still trips the bound. On expiry the pump throws
    // MuseTurnTimeoutError out through run() for structured mapping; events
    // already yielded stay persisted by the coordinator.
    const inner = this.streamTurnInner(turn, agentRunId, session);
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

  private async *streamTurnInner(
    turn: MuseTurnView,
    agentRunId: AgentRunId,
    session?: MuseSessionView,
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
            isTestOperation: TEST_COMMAND_PATTERN.test(command),
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
            isTestOperation:
              TEST_COMMAND_PATTERN.test(item.tool ?? '') ||
              TEST_COMMAND_PATTERN.test(argsText ?? ''),
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
      const planning = yield* this.streamTurn(
        await session.sendText(planningPrompt(request)),
        request.agentRunId,
        session,
        'planning',
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
        session,
      );
      assertCompleted(execution.outcome, 'execution');
      const result = parseAgentResult(execution.text, this.secrets);
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
          operations: this.observedOperations,
          ...(baselineIndex === undefined ? {} : { baseline: baselineIndex }),
          secrets: this.secrets,
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
