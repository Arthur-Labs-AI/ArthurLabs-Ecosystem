/**
 * Provider credentials for the desktop host (Phase 8 bridge toward Phase 9).
 *
 * Frozen-core facts respected:
 * - Harnesses read credentials from process env / local login state; the frozen
 *   packages are never modified to accept keys through another channel.
 * - Phase 7 §57: secrets are NEVER part of Sentry config or the domain DB.
 * - Phase 8 §116: the renderer receives statuses only, never values.
 *
 * This service keeps values in main-process memory and injects them into
 * `process.env` at set-time so harness discovery sees them with zero core
 * changes. Optional file persistence goes to a user-level env file OUTSIDE
 * the Sentry data root and outside git (0600 on POSIX), storing `NAME=value`
 * lines that are loaded back into memory + process.env on boot.
 */
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const MANAGED_PROVIDER_KEYS = [
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'SENTRY_DEEPSEEK_MODEL',
  'SENTRY_GLM_MODEL',
  'SENTRY_MUSE_MODEL',
] as const;

export type ManagedProviderKey = (typeof MANAGED_PROVIDER_KEYS)[number];

const SECRET_NAMES: ReadonlySet<string> = new Set(['DEEPSEEK_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);

export interface ProviderCredentialStatus {
  readonly name: string;
  readonly configured: boolean;
  readonly source: 'environment' | 'desktop' | 'missing';
  readonly hint: string;
}

function hintFor(value: string | undefined): string {
  if (value === undefined || value.length === 0) return 'missing';
  if (value.length <= 8) return 'set (short)';
  return '…​' + value.slice(-4);
}

function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if ((MANAGED_PROVIDER_KEYS as readonly string[]).includes(name)) out.set(name, value);
  }
  return out;
}

export class ProviderCredentialService {
  private readonly memory = new Map<string, string>();
  private readonly filePath: string;

  constructor(options: { filePath?: string } = {}) {
    this.filePath = options.filePath ?? join(tmpdir(), 'sentry-desktop-providers.env');
  }

  get path(): string {
    return this.filePath;
  }

  /** Load persisted file values into memory + process.env. Never throws. */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch {
      return;
    }
    for (const [name, value] of parseEnvFile(text)) {
      this.memory.set(name, value);
      if (process.env[name] === undefined || process.env[name] === '') process.env[name] = value;
    }
  }

  statuses(): ProviderCredentialStatus[] {
    return MANAGED_PROVIDER_KEYS.map((name) => {
      const fromMemory = this.memory.get(name);
      const envValue = process.env[name];
      const effective = fromMemory ?? envValue;
      return {
        name,
        configured: effective !== undefined && effective.length > 0,
        source: fromMemory !== undefined ? 'desktop' : envValue ? 'environment' : 'missing',
        hint: SECRET_NAMES.has(name) ? hintFor(effective) : (effective ?? 'missing'),
      };
    });
  }

  /** Set a key for this session (memory + process.env). Values never leave main. */
  setKey(name: string, value: string): ProviderCredentialStatus {
    if (!(MANAGED_PROVIDER_KEYS as readonly string[]).includes(name)) {
      throw Object.assign(new Error('Unsupported provider key: ' + name), {
        code: 'PROVIDER_KEY_UNSUPPORTED',
      });
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 5000) {
      throw Object.assign(new Error('Provider key value is empty or too long'), {
        code: 'PROVIDER_KEY_INVALID',
      });
    }
    this.memory.set(name, trimmed);
    process.env[name] = trimmed;
    return this.statusFor(name);
  }

  clearKey(name: string): ProviderCredentialStatus {
    if (!(MANAGED_PROVIDER_KEYS as readonly string[]).includes(name)) {
      throw Object.assign(new Error('Unsupported provider key: ' + name), {
        code: 'PROVIDER_KEY_UNSUPPORTED',
      });
    }
    this.memory.delete(name);
    delete process.env[name];
    return this.statusFor(name);
  }

  /** Persist memory values to the user-level env file (0600). */
  async persist(): Promise<{ path: string; keys: number }> {
    const lines = ['# Sentry desktop provider values (user-level, do not commit).'];
    for (const name of MANAGED_PROVIDER_KEYS) {
      const value = this.memory.get(name);
      if (value === undefined) continue;
      lines.push(name + '="' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp-' + process.pid;
    await writeFile(tmp, lines.join('\n') + '\n', { mode: 0o600 });
    try {
      await chmod(tmp, 0o600);
    } catch {
      // Windows: chmod is a no-op; ACLs inherit the user profile.
    }
    await rename(tmp, this.filePath);
    return { path: this.filePath, keys: lines.length - 1 };
  }

  async forgetFile(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch {
      // Absent file is the desired end state.
    }
  }

  private statusFor(name: string): ProviderCredentialStatus {
    const found = this.statuses().find((s) => s.name === name);
    if (found === undefined) throw new Error('Unreachable missing provider status');
    return found;
  }
}
