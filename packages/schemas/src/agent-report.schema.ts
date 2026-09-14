import { z } from 'zod';
import {
  EVIDENCE_STRENGTHS,
  FINDING_CATEGORIES,
  FINDING_CONFIDENCES,
  FINDING_SEVERITIES,
} from './enums.js';
import { RelativePathSchema } from './primitives.js';

/**
 * SentryAgentReportV2 — the MODEL-FACING report contract for the tool-free
 * reporting stage (Phase 4.2).
 *
 * Unlike V1's flat evidence shape, V2 evidence is a discriminated union
 * keyed by `type`. Each variant accepts ONLY the fields its kind needs;
 * strict variants reject cross-type bleed (e.g. `symbol` on evidence,
 * `relativePath` on runtime) by construction.
 *
 * Sentry-owned facts are never repeated by the model: command evidence
 * cites an operationKey and Sentry derives command/exitCode from the
 * frozen ObservedOperation; test evidence cites an operationKey and
 * Sentry derives passed/failed from the observed exit code.
 *
 * V1 parsing/export compatibility is preserved: V1 schemas stay intact
 * for historical runs; V2 normalizes into the same canonical
 * Evidence/Finding models via @qa/evidence-pipeline.
 */

const ReportKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);

const ReportLineRange = {
  lineStart: z.number().int().min(1).optional(),
  lineEnd: z.number().int().min(1).optional(),
};

const ReportCodeReferenceEvidenceSchema = z
  .object({
    key: ReportKeySchema,
    type: z.literal('code_reference'),
    strength: z.enum(EVIDENCE_STRENGTHS),
    description: z.string().min(1).max(5_000),
    relativePath: RelativePathSchema,
    ...ReportLineRange,
  })
  .strict();

const ReportCommandEvidenceSchema = z
  .object({
    key: ReportKeySchema,
    type: z.literal('command'),
    strength: z.enum(EVIDENCE_STRENGTHS),
    description: z.string().min(1).max(5_000),
    // Sentry derives command/exitCode from this operation. No repetition.
    operationKey: ReportKeySchema,
  })
  .strict();

const ReportTestEvidenceSchema = z
  .object({
    key: ReportKeySchema,
    type: z.literal('test'),
    strength: z.enum(EVIDENCE_STRENGTHS),
    description: z.string().min(1).max(5_000),
    // Sentry derives passed/failed from this operation's observed exit
    // code. framework/name are model metadata and never override it.
    operationKey: ReportKeySchema,
    framework: z.string().min(1).max(100).optional(),
    name: z.string().min(1).max(500).optional(),
  })
  .strict();

const ReportRuntimeEvidenceSchema = z
  .object({
    key: ReportKeySchema,
    type: z.literal('runtime'),
    strength: z.enum(EVIDENCE_STRENGTHS),
    description: z.string().min(1).max(5_000),
    operationKey: ReportKeySchema.optional(),
  })
  .strict();

const ReportLogEvidenceSchema = z
  .object({
    key: ReportKeySchema,
    type: z.literal('log'),
    strength: z.enum(EVIDENCE_STRENGTHS),
    description: z.string().min(1).max(5_000),
    operationKey: ReportKeySchema.optional(),
    source: z.string().min(1).max(200).optional(),
  })
  .strict();

const ReportManualEvidenceSchema = z
  .object({
    key: ReportKeySchema,
    type: z.literal('manual'),
    strength: z.enum(EVIDENCE_STRENGTHS),
    description: z.string().min(1).max(5_000),
  })
  .strict();

export const SentryAgentReportEvidenceV2Schema = z.discriminatedUnion('type', [
  ReportCodeReferenceEvidenceSchema,
  ReportCommandEvidenceSchema,
  ReportTestEvidenceSchema,
  ReportRuntimeEvidenceSchema,
  ReportLogEvidenceSchema,
  ReportManualEvidenceSchema,
]);
export type SentryAgentReportEvidenceV2 = z.infer<typeof SentryAgentReportEvidenceV2Schema>;

const ReportFindingLocationSchema = z
  .object({
    relativePath: RelativePathSchema,
    lineStart: z.number().int().min(1).optional(),
    lineEnd: z.number().int().min(1).optional(),
    symbol: z.string().min(1).max(500).optional(),
  })
  .strict();

const SentryAgentReportFindingV2Schema = z
  .object({
    title: z.string().min(1).max(200),
    category: z.enum(FINDING_CATEGORIES),
    categoryDetail: z.string().min(1).max(200).optional(),
    severity: z.enum(FINDING_SEVERITIES),
    confidence: z.enum(FINDING_CONFIDENCES),
    description: z.string().min(1).max(20_000),
    expectedBehavior: z.string().min(1).max(5_000).optional(),
    actualBehavior: z.string().min(1).max(5_000).optional(),
    locations: z.array(ReportFindingLocationSchema).min(1).max(100),
    evidenceKeys: z.array(ReportKeySchema).min(1).max(100),
    // Required field, may be an empty array when no steps apply.
    reproductionSteps: z.array(z.string().min(1).max(2_000)).max(100),
    rootCause: z.string().min(1).max(5_000).optional(),
    recommendedFix: z.string().min(1).max(5_000).optional(),
  })
  .strict();

export const SentryAgentReportV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    summary: z.string().min(1).max(20_000),
    checks: z
      .array(
        z
          .object({
            name: z.string().min(1).max(500),
            status: z.enum(['passed', 'failed', 'inconclusive', 'not_run']),
            details: z.string().min(1).max(5_000).optional(),
          })
          .strict(),
      )
      .max(300),
    hypotheses: z
      .array(
        z
          .object({
            title: z.string().min(1).max(200),
            rationale: z.string().min(1).max(10_000),
            relatedPaths: z.array(RelativePathSchema).max(100),
            plannedChecks: z.array(z.string().min(1).max(2_000)).min(1).max(100),
          })
          .strict(),
      )
      .max(100),
    evidence: z.array(SentryAgentReportEvidenceV2Schema).max(500),
    findings: z.array(SentryAgentReportFindingV2Schema).max(500),
    limitations: z.array(z.string().min(1).max(2_000)).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = new Set<string>();
    const strengthByKey = new Map<string, (typeof EVIDENCE_STRENGTHS)[number]>();
    const typeByKey = new Map<string, string>();
    for (const [index, evidence] of value.evidence.entries()) {
      if (keys.has(evidence.key))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['evidence', index, 'key'],
          message: 'Evidence keys must be unique',
        });
      keys.add(evidence.key);
      strengthByKey.set(evidence.key, evidence.strength);
      typeByKey.set(evidence.key, evidence.type);
    }
    value.findings.forEach((finding, findingIndex) => {
      finding.evidenceKeys.forEach((key, keyIndex) => {
        if (!keys.has(key))
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['findings', findingIndex, 'evidenceKeys', keyIndex],
            message: 'Unknown evidence key',
          });
      });
      const isGroundedKey = (key: string): boolean => {
        const strength = strengthByKey.get(key);
        const type = typeByKey.get(key);
        return (
          strength === 'reproduced_failure' ||
          strength === 'reproduced_behavior' ||
          strength === 'tool_diagnostic' ||
          strength === 'strong_code_evidence' ||
          type === 'command' ||
          type === 'code_reference' ||
          type === 'test'
        );
      };
      if (finding.confidence === 'confirmed' || finding.confidence === 'strong') {
        const grounded = finding.evidenceKeys.some(isGroundedKey);
        if (!grounded)
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['findings', findingIndex, 'confidence'],
            message:
              finding.confidence +
              ' findings require at least one grounded evidence item; manual/model reasoning alone is insufficient',
          });
      }
    });
  });
export type SentryAgentReportV2 = z.infer<typeof SentryAgentReportV2Schema>;

/** Per-variant field lists: the consistency test fails if any variant gains
 *  a field without updating this table (single source of truth). */
export const SENTRY_AGENT_REPORT_V2_VARIANT_FIELDS = {
  code_reference: [
    'key',
    'type',
    'strength',
    'description',
    'relativePath',
    'lineStart',
    'lineEnd',
  ],
  command: ['key', 'type', 'strength', 'description', 'operationKey'],
  test: ['key', 'type', 'strength', 'description', 'operationKey', 'framework', 'name'],
  runtime: ['key', 'type', 'strength', 'description', 'operationKey'],
  log: ['key', 'type', 'strength', 'description', 'operationKey', 'source'],
  manual: ['key', 'type', 'strength', 'description'],
} as const;

/** Model-facing report contract rendered from THIS schema (never
 *  hand-maintained separately): per-variant exact fields plus the finding
 *  contract with its required fields. */
export function describeSentryAgentReportContract(): string {
  const variantKeys = Object.keys(SENTRY_AGENT_REPORT_V2_VARIANT_FIELDS);
  // The report schema carries a superRefine (ZodEffects): read through
  // its inner type, mirroring describeSentryAgentEvidenceContract.
  const evidenceField = SentryAgentReportV2Schema.innerType().shape.evidence;
  const options = (evidenceField as z.ZodArray<z.ZodDiscriminatedUnion<'type', never>>).element
    .options as readonly z.ZodTypeAny[];
  if (options.length !== variantKeys.length) {
    throw new Error(
      'Report contract description is stale; discriminated union has ' +
        options.length +
        ' variants, table lists ' +
        variantKeys.length,
    );
  }
  const lines = options.map((variant: z.ZodTypeAny) => {
    if (!(variant instanceof z.ZodObject))
      throw new Error('Report evidence variant is not an object');
    const shape = variant.shape;
    const type = shape['type'];
    if (!(type instanceof z.ZodLiteral))
      throw new Error('Report evidence variant lacks literal type');
    const kind = String(type.value);
    const expected = (SENTRY_AGENT_REPORT_V2_VARIANT_FIELDS as Record<string, readonly string[]>)[
      kind
    ];
    if (expected === undefined) throw new Error('Report contract table missing variant: ' + kind);
    const actual = Object.keys(shape);
    const missing = expected.filter((field) => !actual.includes(field));
    const extra = actual.filter((field) => !expected.includes(field));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        'Report contract description is stale for ' +
          kind +
          '; missing: ' +
          missing.join(',') +
          '; extra: ' +
          extra.join(','),
      );
    }
    // Strength vocabulary comes from the live schema (never a
    // hand-maintained list): models must see the exact enum values.
    const strengthField = shape['strength'];
    let strengths = '';
    if (strengthField instanceof z.ZodEnum) strengths = strengthField.options.join('|');
    return (
      kind +
      ': {"key","type":"' +
      kind +
      '","strength":"' +
      strengths +
      '","description"' +
      expected
        .filter((field) => !['key', 'type', 'strength', 'description'].includes(field))
        .map((field) => ',"' + field + '"')
        .join('') +
      '}'
    );
  });
  return (
    'Evidence variants (exact fields per type; unknown fields fail validation): ' +
    lines.join(' | ') +
    '. Finding (required: title, category, severity, confidence, description, locations[>=1], evidenceKeys[>=1], reproductionSteps (always include, [] allowed)): locations entries accept relativePath, lineStart?, lineEnd?, symbol?.'
  );
}

/** Deterministic JSON Schema derivation for provider structured-output
 *  (e.g. Claude `--json-schema`): generated from THIS Zod source, never
 *  hand-written. Sentry Zod validation remains authoritative. */
export function sentryAgentReportJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(SentryAgentReportV2Schema, 'SentryAgentReportV2');
}

function zodToJsonSchema(node: z.ZodTypeAny, name: string): Record<string, unknown> {
  const def = (node as { _def?: Record<string, unknown> })._def ?? {};
  if (node instanceof z.ZodOptional || node instanceof z.ZodDefault) {
    const inner = (def['innerType'] ?? def['defaultValue']) as z.ZodTypeAny;
    return zodToJsonSchema(inner, name);
  }
  if (node instanceof z.ZodLiteral) return { const: def['value'] };
  if (node instanceof z.ZodEnum) return { enum: def['values'] };
  if (node instanceof z.ZodString) return { type: 'string' };
  if (node instanceof z.ZodNumber) return { type: 'number' };
  if (node instanceof z.ZodArray) {
    const out: Record<string, unknown> = {
      type: 'array',
      items: zodToJsonSchema(def['type'] as z.ZodTypeAny, name + 'Item'),
    };
    if (typeof def['minLength'] === 'object' && def['minLength'] !== null)
      out['minItems'] = (def['minLength'] as { value: number }).value;
    if (typeof def['maxLength'] === 'object' && def['maxLength'] !== null)
      out['maxItems'] = (def['maxLength'] as { value: number }).value;
    return out;
  }
  if (node instanceof z.ZodObject) {
    const shape = node.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, field] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(field, name + '_' + key);
      if (!(field instanceof z.ZodOptional) && !(field instanceof z.ZodDefault)) required.push(key);
    }
    return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
  }
  if (node instanceof z.ZodDiscriminatedUnion) {
    return {
      oneOf: node.options.map((option: z.ZodTypeAny) => zodToJsonSchema(option, name)),
    };
  }
  if (node instanceof z.ZodEffects) {
    return zodToJsonSchema(def['schema'] as z.ZodTypeAny, name);
  }
  throw new Error('Report JSON Schema derivation hit an unsupported Zod node in ' + name);
}
