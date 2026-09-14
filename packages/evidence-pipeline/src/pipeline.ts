/**
 * Shared evidence pipeline (Phase 4). ONE generic trust path for every
 * AgentStack: raw harness observation -> adapter-specific correlation ->
 * canonical Evidence -> validateFindingTrust() -> canonical Finding.
 *
 * Adapters own tool correlation (they build the observed-operations map
 * from their own vendor events). This module owns everything downstream:
 * path containment, baseline provenance, operation-specific grounding,
 * canonical derivation, and the generic finding gate. Vendor differences
 * enter only through the `context` parameters (error factory, author
 * label, secret redaction).
 */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createEvidenceId, nowIsoTimestamp, type OperationId } from '@qa/shared';
import {
  EvidenceSchema,
  type Evidence,
  type FindingConfidence,
  type HarnessRunRequest,
  type SentryAgentEvidenceV1,
  type SentryAgentReportEvidenceV2,
} from '@qa/schemas';
import { validateFindingTrust } from '@qa/domain';

export interface PipelineErrorFactory {
  invalidResult(message: string): Error;
}

export interface EvidencePipelineContext {
  readonly errors: PipelineErrorFactory;
  /** Human author label for downgraded manual evidence (e.g. harness name). */
  readonly authorLabel: string;
  /** Host secret values for redacting model-supplied strings in diagnostics. */
  readonly secrets: readonly string[];
  /** Redact a model-supplied diagnostic string (bounded). */
  redactDiagnostic(value: string): string;
  /** Redact secrets inside a parsed model-supplied JSON value. */
  redactStructured(value: unknown): unknown;
}

export interface BaselineFileIndex {
  /** Baseline content hash by workspace-relative path (forward slashes). */
  readonly fileHashByPath: ReadonlyMap<string, string>;
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
}

export function emptyGrounding(): ObservedEvidenceGrounding {
  return { observedCommands: new Set<string>(), operations: new Map<string, ObservedOperation>() };
}

export const TEST_COMMAND_PATTERN =
  /\b(pnpm|npm|yarn|bun|node|npx|vitest|jest|pytest|dotnet\s+test|cargo\s+test|go\s+test|mvn(\s+test)?|gradle(\s+test)?|phpunit|rspec)\b/i;

export function normalizeCommandText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function commandIdentity(command: string, exitCode: number): string {
  return JSON.stringify([normalizeCommandText(command), exitCode]);
}

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND_PATTERN.test(command);
}

function safeAbsolute(
  root: string,
  relativePath: string,
  fail: (message: string) => Error,
): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, relativePath);
  const rel = relative(absoluteRoot, absolute);
  if (rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)))
    return absolute;
  throw fail('Evidence path escapes the isolated workspace.');
}

async function validateExistingFile(
  root: string,
  relativePath: string,
  fail: (message: string) => Error,
): Promise<string> {
  const absolute = safeAbsolute(root, relativePath, fail);
  let details;
  let realRoot: string;
  let realTarget: string;
  try {
    [realRoot, realTarget] = await Promise.all([realpath(root), realpath(absolute)]);
    details = await stat(absolute);
  } catch {
    throw fail('Referenced evidence path does not exist: ' + relativePath);
  }
  if (!details.isFile()) {
    throw fail('Referenced evidence path is not a file: ' + relativePath);
  }
  const realRelative = relative(realRoot, realTarget);
  if (realRelative === '..' || realRelative.startsWith('..' + sep) || isAbsolute(realRelative)) {
    throw fail('Referenced evidence path resolves outside the isolated workspace.');
  }
  return absolute;
}

export async function validateLocation(
  root: string,
  relativePath: string,
  context: EvidencePipelineContext,
  lineStart?: number,
  lineEnd?: number,
): Promise<string> {
  const fail = (message: string): Error => context.errors.invalidResult(message);
  const absolute = await validateExistingFile(root, relativePath, fail);
  if (lineStart === undefined) return absolute;
  const lineCount = (await readFile(absolute, 'utf8')).split(/\r?\n/).length;
  if (lineStart > lineCount || (lineEnd !== undefined && lineEnd > lineCount)) {
    throw fail('Referenced evidence line range is outside the file: ' + relativePath);
  }
  return absolute;
}

async function codeReference(
  root: string,
  source: SentryAgentEvidenceV1,
  context: EvidencePipelineContext,
  baseline?: BaselineFileIndex,
) {
  const relativePath = source.relativePath as string;
  const absolute = await validateLocation(
    root,
    relativePath,
    context,
    source.lineStart,
    source.lineEnd,
  );
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
    sourceState:
      baselineHash !== undefined && baselineHash === contentHash
        ? ('baseline' as const)
        : ('modified_workspace' as const),
    contentHash,
    ...(excerpt.length === 0 ? {} : { excerpt }),
  };
}

export async function buildBaselineIndex(
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
    if (record.schemaVersion !== 1 || record.snapshotId !== snapshotId) return undefined;
    if (record.files === null || typeof record.files !== 'object' || Array.isArray(record.files))
      return undefined;
    const map = new Map<string, string>();
    for (const [key, value] of Object.entries(record.files as Record<string, unknown>)) {
      if (typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)) map.set(key, value);
    }
    return { fileHashByPath: map };
  } catch {
    return undefined;
  }
}

/**
 * Normalize a ReportV2 evidence item into the V1 model-facing shape, then
 * delegate to the single trust core (convertEvidence). Sentry-owned facts
 * (command text, exit codes, test status) are derived from the frozen
 * observed operation — never repeated from model text. Unknown-exit
 * operations cannot ground outcome claims: weak claims return a manual
 * downgrade here, reproduced claims throw (consistent with V1 policy).
 */
export async function convertReportEvidence(
  request: HarnessRunRequest,
  source: SentryAgentReportEvidenceV2,
  context: EvidencePipelineContext,
  grounding: ObservedEvidenceGrounding,
): Promise<Evidence> {
  const fail = (message: string): Error => context.errors.invalidResult(message);
  const isReproducedClaim =
    source.strength === 'reproduced_failure' || source.strength === 'reproduced_behavior';
  const weakDowngrade = (summary: string): Promise<Evidence> =>
    convertEvidence(
      request,
      {
        key: source.key,
        type: 'manual',
        strength: 'agent_reasoning',
        description: source.description,
      },
      context,
      grounding,
    ).then((manual) => ({
      ...manual,
      manual: { summary, author: context.authorLabel },
    }));
  switch (source.type) {
    case 'command': {
      const linked = grounding.operations.get(source.operationKey);
      if (linked === undefined) throw fail('Command evidence references an unknown operation.');
      if (linked.commandText === undefined || linked.exitCode === undefined) {
        if (isReproducedClaim)
          throw fail(
            'Reproduced command evidence cites an operation without observed command outcome.',
          );
        return weakDowngrade(
          'Command evidence cites an operation with unobserved outcome; downgraded: ' +
            source.description,
        );
      }
      return convertEvidence(
        request,
        {
          key: source.key,
          type: 'command',
          strength: source.strength,
          description: source.description,
          command: linked.commandText,
          exitCode: linked.exitCode,
          operationKey: source.operationKey,
        },
        context,
        grounding,
      );
    }
    case 'test': {
      const linked = grounding.operations.get(source.operationKey);
      if (linked === undefined) throw fail('Test evidence references an unknown operation.');
      if (!linked.isTestOperation) throw fail('Test evidence references a non-test operation.');
      if (linked.exitCode === undefined) {
        if (isReproducedClaim)
          throw fail(
            'Reproduced test evidence cites an operation whose exit code was not observed.',
          );
        return weakDowngrade(
          'Test evidence cites an operation with unobserved exit code; downgraded: ' +
            source.description,
        );
      }
      return convertEvidence(
        request,
        {
          key: source.key,
          type: 'test',
          strength: source.strength,
          description: source.description,
          framework: source.framework ?? 'observed-operation',
          name: source.name ?? source.description.slice(0, 200),
          status: linked.exitCode === 0 ? 'passed' : 'failed',
          operationKey: source.operationKey,
        },
        context,
        grounding,
      );
    }
    case 'runtime':
    case 'log':
      return convertEvidence(
        request,
        {
          key: source.key,
          type: source.type,
          strength: source.strength,
          description: source.description,
          ...(source.operationKey === undefined ? {} : { operationKey: source.operationKey }),
          ...(source.type === 'log' && source.source !== undefined
            ? { source: source.source }
            : {}),
        },
        context,
        grounding,
      );
    case 'code_reference':
      return convertEvidence(
        request,
        {
          key: source.key,
          type: 'code_reference',
          strength: source.strength,
          description: source.description,
          relativePath: source.relativePath,
          ...(source.lineStart === undefined ? {} : { lineStart: source.lineStart }),
          ...(source.lineEnd === undefined ? {} : { lineEnd: source.lineEnd }),
        },
        context,
        grounding,
      );
    case 'manual':
      return convertEvidence(
        request,
        {
          key: source.key,
          type: 'manual',
          strength: source.strength,
          description: source.description,
        },
        context,
        grounding,
      );
    default: {
      const _exhaustive: never = source;
      throw fail('Unknown report evidence type: ' + JSON.stringify(_exhaustive));
    }
  }
}

export async function convertEvidence(
  request: HarnessRunRequest,
  source: SentryAgentEvidenceV1,
  context: EvidencePipelineContext,
  grounding: ObservedEvidenceGrounding,
): Promise<Evidence> {
  const observed = grounding;
  const fail = (message: string): Error => context.errors.invalidResult(message);
  if (source.relativePath !== undefined)
    await validateLocation(
      request.workspace.runtimePath,
      source.relativePath,
      context,
      source.lineStart,
      source.lineEnd,
    );
  const isReproducedClaim =
    source.strength === 'reproduced_failure' || source.strength === 'reproduced_behavior';
  const needsOperation =
    source.type === 'test' || source.type === 'runtime' || source.type === 'log';
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
      manual: { summary, author: context.authorLabel },
    });
  if (source.operationKey !== undefined) {
    const correlated = observed.operations.get(source.operationKey);
    if (correlated === undefined) {
      throw fail('Evidence references an unknown operation correlation key.');
    }
    if (source.type === 'test' && !correlated.isTestOperation) {
      throw fail('Test evidence references an operation that did not run tests.');
    }
    if (
      source.type === 'test' &&
      source.status !== undefined &&
      correlated.exitCode === undefined
    ) {
      // Sentry never observed this operation's code: a claimed test
      // outcome is unverifiable here. Same policy as command codes.
      if (isReproducedClaim) {
        throw fail('Reproduced test evidence cites an operation whose exit code was not observed.');
      }
      return downgradedManual(
        'Test evidence cites an operation with unobserved exit code; downgraded: ' +
          source.description,
      );
    }
    if (
      source.type === 'test' &&
      source.status !== undefined &&
      correlated.exitCode !== undefined
    ) {
      // Status mismatch mirrors the command-text policy: a reproduced claim
      // asserting a contradicted outcome is misrepresentation (fatal);
      // a weaker mischaracterization of a real observed run downgrades to
      // manual reasoning instead of nuking the whole investigation.
      // Exit-code fabrication on linked command evidence stays always
      // fatal (see below); this only covers the status label.
      const observedStatus = correlated.exitCode === 0 ? 'passed' : 'failed';
      if (observedStatus !== source.status) {
        if (isReproducedClaim) {
          throw fail('Test evidence status does not match the observed operation result.');
        }
        return downgradedManual(
          'Test status differs from the linked observed operation ' +
            `(claimed=${source.status}, observed=${observedStatus}); downgraded: ` +
            source.description,
        );
      }
    }
  }
  if (source.operationKey === undefined && needsOperation) {
    if (isReproducedClaim) {
      throw fail('Reproduced evidence strength requires a correlated observed operation.');
    }
    return downgradedManual(
      'Ungrounded ' + source.type + ' claim downgraded: ' + source.description,
    );
  }
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
    const reference = await codeReference(
      request.workspace.runtimePath,
      source,
      context,
      observed.baseline,
    );
    return EvidenceSchema.parse({
      ...base,
      environmentState: reference.sourceState,
      type: 'code_reference',
      codeReference: reference,
    });
  }
  if (source.type === 'command') {
    if (source.operationKey !== undefined) {
      const linked = observed.operations.get(source.operationKey);
      if (linked === undefined) {
        throw fail('Command evidence references an unknown operation correlation key.');
      }
      if (linked.commandText === undefined) {
        throw fail('Command evidence operation has no observed command text.');
      }
      if (linked.exitCode === undefined) {
        // Sentry never observed this operation's code: the claim is
        // unverifiable here. Reproduced assertions without verifiable
        // proof fail; weaker ones downgrade to manual reasoning.
        if (isReproducedClaim) {
          throw fail(
            'Reproduced command evidence cites an operation whose exit code was not observed.',
          );
        }
        return downgradedManual(
          'Command evidence cites an operation with unobserved exit code; downgraded: ' +
            source.description,
        );
      }
      if (linked.exitCode !== source.exitCode) {
        throw fail('Command evidence operation does not match the claimed exit code.');
      }
      if (
        source.command !== undefined &&
        normalizeCommandText(source.command) !== normalizeCommandText(linked.commandText)
      ) {
        if (isReproducedClaim) {
          throw fail(
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
        groundingOperationIds: [linked.operationId],
        type: 'command',
        command: {
          command: linked.commandText,
          exitCode: linked.exitCode,
          ...(linked.durationMs === undefined ? {} : { durationMs: linked.durationMs }),
        },
      });
    }
    if (
      source.command === undefined ||
      source.exitCode === undefined ||
      !observed.observedCommands.has(commandIdentity(source.command, source.exitCode))
    ) {
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
        throw fail('Command evidence exit code does not match the observed execution.');
      }
      if (isReproducedClaim) {
        const claimed =
          source.command === undefined
            ? 'missing'
            : context.redactDiagnostic(source.command).slice(0, 200);
        throw fail(
          'Reproduced command evidence does not match an observed command execution ' +
            '(claimed command=' +
            claimed +
            ' exitCode=' +
            String(source.exitCode) +
            ').',
        );
      }
      return downgradedManual(
        'Unmatched command claim downgraded (claimed command=' +
          (source.command === undefined
            ? 'missing'
            : context.redactDiagnostic(source.command).slice(0, 200)) +
          ' exitCode=' +
          String(source.exitCode) +
          '): ' +
          source.description,
      );
    }
    return EvidenceSchema.parse({
      ...base,
      type: 'command',
      command: { command: source.command, exitCode: source.exitCode },
    });
  }
  // Durable provenance: validation above already established the link;
  // record the CANONICAL operationId (never the temporary op_N key).
  // Key-less matches and downgraded/manual items carry no link.
  const groundingOperationIds =
    source.operationKey === undefined
      ? []
      : [observed.operations.get(source.operationKey)?.operationId].filter(
          (id): id is OperationId => id !== undefined,
        );
  if (source.type === 'test') {
    return EvidenceSchema.parse({
      ...base,
      groundingOperationIds,
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
      groundingOperationIds,
      type: 'runtime',
      runtime: { summary: source.description },
    });
  }
  if (source.type === 'log') {
    return EvidenceSchema.parse({
      ...base,
      groundingOperationIds,
      type: 'log',
      log: { source: source.source ?? context.authorLabel, summary: source.description },
    });
  }
  return EvidenceSchema.parse({
    ...base,
    type: 'manual',
    manual: { summary: source.description, author: context.authorLabel },
  });
}

export function validateProductionFindings(
  findings: ReadonlyArray<{
    readonly evidenceKeys: readonly string[];
    readonly confidence: FindingConfidence;
  }>,
  evidenceByKey: ReadonlyMap<string, Evidence>,
  fail: (message: string) => Error,
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
      throw fail(verdict.reason);
    }
  }
}

export function summarizeSchemaIssues(error: {
  issues: Array<{ path: Array<string | number>; message: string }>;
}): string {
  // Paths only, never model values; bounded so the message stays a summary.
  return error.issues
    .slice(0, 8)
    .map((issue) => issue.path.join('.') + ': ' + issue.message)
    .join('; ')
    .slice(0, 500);
}

export function parseWholeJson(
  text: string,
  phase: string,
  context: EvidencePipelineContext,
): unknown {
  try {
    return context.redactStructured(JSON.parse(text));
  } catch {
    // Diagnostic shape hint (redacted, bounded): distinguishes empty
    // responses from prose from near-JSON without persisting model text.
    const sample = context
      .redactDiagnostic(text.slice(0, 300))
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 200);
    const hint = sample.length === 0 ? 'empty response' : `response starts with: ${sample}`;
    throw context.errors.invalidResult(
      phase + ' response was not one complete JSON document (' + hint + ').',
    );
  }
}
