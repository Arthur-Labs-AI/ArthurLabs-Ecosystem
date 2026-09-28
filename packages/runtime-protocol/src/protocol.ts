/**
 * Sentry WSL runtime RPC protocol v1.
 *
 * Transport: one JSON object per stdout line (NDJSON). stdout is PROTOCOL
 * ONLY — the runtime must never write logs there (stderr carries bounded
 * diagnostics). Every message validates with Zod on receipt.
 */
import { z } from 'zod';

export const RUNTIME_PROTOCOL_VERSION = 1 as const;

export const RpcIdSchema = z.string().min(1).max(100);
export type RpcId = z.infer<typeof RpcIdSchema>;

export const RpcRequestSchema = z
  .object({
    type: z.literal('request'),
    id: RpcIdSchema,
    method: z.string().min(1).max(120),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export const RpcErrorSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(2000),
  })
  .strict();
export type RpcError = z.infer<typeof RpcErrorSchema>;

export const RpcResponseSchema = z
  .object({
    type: z.literal('response'),
    id: RpcIdSchema,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: RpcErrorSchema.optional(),
  })
  .strict();
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

export const RpcNotificationSchema = z
  .object({
    type: z.literal('notification'),
    event: z.string().min(1).max(120),
    payload: z.unknown().optional(),
  })
  .strict();
export type RpcNotification = z.infer<typeof RpcNotificationSchema>;

export const RpcMessageSchema = z.union([
  RpcRequestSchema,
  RpcResponseSchema,
  RpcNotificationSchema,
]);
export type RpcMessage = z.infer<typeof RpcMessageSchema>;

/** Parse one NDJSON line; throws RpcFramingError on malformed JSON/unknown shape. */
export function parseRpcLine(line: string): RpcMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new RpcFramingError('MALFORMED_JSON', 'Runtime RPC line is not JSON');
  }
  const parsed = RpcMessageSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RpcFramingError('UNKNOWN_MESSAGE', 'Runtime RPC message failed validation');
  }
  if (parsed.data.type === 'response') {
    if (parsed.data.ok && parsed.data.error !== undefined) {
      throw new RpcFramingError('UNKNOWN_MESSAGE', 'ok:true response must not carry error');
    }
    if (!parsed.data.ok && parsed.data.error === undefined) {
      throw new RpcFramingError('UNKNOWN_MESSAGE', 'ok:false response must carry error');
    }
  }
  return parsed.data;
}

export class RpcFramingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RpcFramingError';
    this.code = code;
  }
}

export function encodeRpcLine(message: RpcMessage): string {
  return JSON.stringify(message) + '\n';
}

export const RUNTIME_METHODS = [
  'runtime.hello',
  'runtime.configure',
  'runtime.environment',
  'runtime.shutdown',
  'projects.list',
  'projects.add',
  'projects.get',
  'projects.revisions',
  'projects.update',
  'projects.delete',
  'projects.doctor',
  'projects.suggestTargets',
  'runs.list',
  'runs.get',
  'runs.status',
  'runs.start',
  'runs.cancel',
  'runs.export',
  'runs.exportContent',
  'issues.list',
  'issues.get',
  'issues.history',
  'retests.list',
  'retests.start',
  'retests.get',
  'retests.cancel',
  'system.activeRuns',
  'system.info',
  'production.readiness',
  'production.preRunGate',
] as const;
export type RuntimeMethod = (typeof RUNTIME_METHODS)[number];

export const RUNTIME_NOTIFICATIONS = [
  'run.created',
  'run.snapshot',
  'retest.created',
  'retest.snapshot',
  'activeRuns.updated',
  'runtime.status',
] as const;
export type RuntimeNotification = (typeof RUNTIME_NOTIFICATIONS)[number];

export const RuntimeHelloResultSchema = z
  .object({
    protocolVersion: z.number().int(),
    runtimeVersion: z.string().min(1).max(50),
    platform: z.string().min(1).max(50),
    isWsl: z.boolean(),
    nodeVersion: z.string().min(1).max(50),
    processExecPath: z.string().min(1).max(500),
    distro: z.string().min(1).max(200).optional(),
    dataRoot: z.string().min(1).max(2000),
  })
  .strict();
export type RuntimeHelloResult = z.infer<typeof RuntimeHelloResultSchema>;

export const RuntimeConfigureParamsSchema = z
  .object({
    // Compatibility: `models.muse` existed until the Muse → OpenCode
    // migration. It is still ACCEPTED but deprecated and IGNORED (never
    // activates anything) so a new runtime keeps working with an old
    // sender instead of rejecting its configure call. Runtime
    // configuration is ephemeral and never persisted; historical RUN rows
    // are unaffected. RUNTIME_PROTOCOL_VERSION stays 1: the transport and
    // framing contract is unchanged, and every previously valid NEW field
    // still validates.
    models: z
      .object({
        muse: z.string().min(1).max(300).optional(),
        opencode: z.string().min(1).max(300).optional(),
        deepseek: z.string().min(1).max(300).optional(),
        glm: z.string().min(1).max(300).optional(),
      })
      .strict()
      .default({}),
    providers: z
      .object({
        openRouterApiKey: z.string().min(1).max(5000).optional(),
        openCodeApiKey: z.string().min(1).max(5000).optional(),
        deepseekApiKey: z.string().min(1).max(5000).optional(),
        anthropicAuthToken: z.string().min(1).max(5000).optional(),
        anthropicBaseUrl: z.string().min(1).max(2000).optional(),
      })
      .strict()
      .default({}),
    // OpenCode upstream provider selection (openrouter|opencode). Ephemeral
    // like everything else here; additive, so the version stays 1.
    openCodeProvider: z.enum(['openrouter', 'opencode', 'opencode-go']).optional(),
    // Harness executable overrides (non-secret absolute paths inside the
    // runtime environment, e.g. a user-local opencode install). Ephemeral
    // like everything else here; additive, so the version stays 1.
    // Optional WITHOUT a default: present-but-key-absent means the sender
    // cleared that override (full-state push), while a missing `binaries`
    // block leaves runtime env untouched (old senders stay compatible).
    binaries: z
      .object({
        opencode: z.string().min(1).max(2000).optional(),
        deepseek: z.string().min(1).max(2000).optional(),
        glm: z.string().min(1).max(2000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RuntimeConfigureParams = z.infer<typeof RuntimeConfigureParamsSchema>;
