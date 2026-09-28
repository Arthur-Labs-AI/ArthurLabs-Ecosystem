// Local Sentry CLI IPC contract shared by the Electron broker (server)
// and sentry cli (client). Windows Beta uses a named pipe scoped to the
// local Sentry launcher home; POSIX uses a tmp socket with the same scope.
// Framing is NDJSON with bounded message sizes and strict validation.
// Provider secrets never travel this protocol in either direction.
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CLI_IPC_PROTOCOL_VERSION = 1 as const;
export const CLI_IPC_PIPE_TAG = 'sentry-cli-v1' as const;
export const CLI_IPC_MAX_REQUEST_BYTES = 256 * 1024;
export const CLI_IPC_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const CLI_IPC_MAX_LINE_BYTES = 32 * 1024 * 1024;

function launcherHomeScope(): string {
  const local = process.env['LOCALAPPDATA'];
  const base =
    local !== undefined && local.length > 0
      ? local
      : join(process.env['HOME'] ?? tmpdir(), '.local', 'share');
  return base.replace(/\\+$/, '').toLowerCase() + '/sentry/launcher';
}

export function cliPipeScope(): string {
  return createHash('sha1').update(launcherHomeScope(), 'utf8').digest('hex').slice(0, 12);
}

export function cliPipePath(scope: string = cliPipeScope()): string {
  if (process.platform === 'win32') return '\\\\.\\pipe\\' + CLI_IPC_PIPE_TAG + '-' + scope;
  return join(tmpdir(), CLI_IPC_PIPE_TAG + '-' + scope + '.sock');
}

export interface CliClientIdentity {
  readonly name: string;
  readonly version?: string | undefined;
}

export function parseClientIdentity(value: unknown): CliClientIdentity | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record['type'] !== 'cli') return undefined;
  const name = record['name'];
  if (typeof name !== 'string' || name.length === 0 || name.length > 100) return undefined;
  const version = record['version'];
  return {
    name,
    ...(typeof version === 'string' && version.length > 0 && version.length <= 50
      ? { version: version.slice(0, 50) }
      : {}),
  };
}

export type CliHelloMessage = {
  readonly type: 'hello';
  readonly protocolVersion: number;
  readonly client: CliClientIdentity;
};

export function parseHelloMessage(
  value: unknown,
): { ok: true; message: CliHelloMessage } | { ok: false; code: string; message: string } {
  if (typeof value !== 'object' || value === null)
    return { ok: false, code: 'MALFORMED_MESSAGE', message: 'CLI message must be a JSON object' };
  const record = value as Record<string, unknown>;
  if (record['type'] !== 'hello')
    return {
      ok: false,
      code: 'MALFORMED_MESSAGE',
      message: 'First message must be a hello handshake',
    };
  if (record['protocolVersion'] !== CLI_IPC_PROTOCOL_VERSION) {
    return {
      ok: false,
      code: 'PROTOCOL_VERSION_MISMATCH',
      message: 'CLI protocol mismatch: want ' + CLI_IPC_PROTOCOL_VERSION,
    };
  }
  const client = parseClientIdentity(record['client']);
  if (client === undefined)
    return {
      ok: false,
      code: 'MALFORMED_MESSAGE',
      message: 'Hello must declare a cli client identity',
    };
  return {
    ok: true,
    message: { type: 'hello', protocolVersion: CLI_IPC_PROTOCOL_VERSION, client },
  };
}

export type CliRequestMessage = {
  readonly type: 'request';
  readonly id: string;
  readonly command: string;
  readonly payload: Record<string, unknown>;
};

export function parseRequestMessage(
  value: unknown,
): { ok: true; message: CliRequestMessage } | { ok: false; code: string; message: string } {
  if (typeof value !== 'object' || value === null)
    return { ok: false, code: 'MALFORMED_MESSAGE', message: 'CLI message must be a JSON object' };
  const record = value as Record<string, unknown>;
  if (record['type'] !== 'request')
    return { ok: false, code: 'UNKNOWN_MESSAGE', message: 'Unknown CLI message type' };
  const id = record['id'];
  const command = record['command'];
  if (typeof id !== 'string' || id.length === 0 || id.length > 100)
    return { ok: false, code: 'MALFORMED_MESSAGE', message: 'Request id must be a short string' };
  if (typeof command !== 'string' || command.length === 0 || command.length > 120)
    return {
      ok: false,
      code: 'MALFORMED_MESSAGE',
      message: 'Request command must be a short string',
    };
  const payload = record['payload'] ?? {};
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    return { ok: false, code: 'MALFORMED_MESSAGE', message: 'Request payload must be an object' };
  return {
    ok: true,
    message: { type: 'request', id, command, payload: payload as Record<string, unknown> },
  };
}

const SECRET_SHAPE =
  /(api[_-]?key|token|secret|password|authorization|bearer|anthropic_auth_token|openrouter_api_key|opencode_api_key|deepseek_api_key)/i;

export function containsSecretShapedValue(value: string): boolean {
  return SECRET_SHAPE.test(value);
}

// Broker log fields: command names, client names, sizes, and codes only.
// Payloads and results are never logged (they may contain project paths,
// instructions, or findings adjacent to credential-adjacent strings).
export function sanitizeBrokerField(value: string): string {
  const trimmed = value.slice(0, 200);
  return SECRET_SHAPE.test(trimmed) ? '[redacted]' : trimmed;
}
