/**
 * Secure persistent provider credentials for the desktop host.
 *
 * Frozen-core facts respected:
 * - Harnesses read credentials from process env / local login state; the frozen
 *   packages are never modified to accept keys through another channel.
 * - Phase 7 §57: secrets are NEVER part of Sentry config or the domain DB.
 * - Renderer receives statuses only, never values.
 *
 * Storage:
 * - Secrets (OPENROUTER_API_KEY, DEEPSEEK_API_KEY, ANTHROPIC_AUTH_TOKEN) → encrypted JSON store
 *   under the app userData directory (or explicit override), encrypted with
 *   Electron safeStorage. Atomic write (tmp + rename). Base64 blobs in JSON.
 * - Non-secret model ids (SENTRY_*_MODEL) → plain JSON preferences file.
 * - One-time migration from the legacy plaintext user-level env file.
 *
 * safeStorage unavailable → session-only storage, NEVER plaintext fallback.
 */
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const MANAGED_PROVIDER_KEYS = [
  'OPENROUTER_API_KEY',
  'OPENCODE_API_KEY',
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'SENTRY_OPENCODE_MODEL',
  'SENTRY_OPENCODE_PROVIDER',
  'SENTRY_DEEPSEEK_MODEL',
  'SENTRY_GLM_MODEL',
  'SENTRY_OPENCODE_BINARY',
  'SENTRY_DEEPSEEK_BINARY',
  'SENTRY_GLM_BINARY',
] as const;

export type ManagedProviderKey = (typeof MANAGED_PROVIDER_KEYS)[number];

export const SECRET_PROVIDER_KEYS = [
  'OPENROUTER_API_KEY',
  'OPENCODE_API_KEY',
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
] as const;

export type SecretProviderKey = (typeof SECRET_PROVIDER_KEYS)[number];

const SECRET_NAMES: ReadonlySet<string> = new Set(SECRET_PROVIDER_KEYS);

const MODEL_KEYS: ReadonlySet<string> = new Set([
  'ANTHROPIC_BASE_URL',
  'SENTRY_OPENCODE_MODEL',
  'SENTRY_OPENCODE_PROVIDER',
  'SENTRY_DEEPSEEK_MODEL',
  'SENTRY_GLM_MODEL',
  'SENTRY_OPENCODE_BINARY',
  'SENTRY_DEEPSEEK_BINARY',
  'SENTRY_GLM_BINARY',
]);

export interface SafeStorageLike {
  readonly isEncryptionAvailable: () => boolean;
  readonly encryptString: (value: string) => Buffer;
  readonly decryptString: (buffer: Buffer) => string;
}

export interface ProviderCredentialStatus {
  readonly name: string;
  readonly configured: boolean;
  /** 'secure' = encrypted store, 'persisted' = plain prefs file, 'environment' = pre-existing env. */
  readonly persistence: 'secure' | 'persisted' | 'environment' | 'missing';
  readonly source: 'stored' | 'persisted' | 'environment' | 'missing';
  readonly hint: string;
}

interface EncryptedStoreFile {
  readonly version: 1;
  readonly secrets: Record<string, string>;
}

interface ModelPrefsFile {
  readonly version: 1;
  readonly models: Record<string, string>;
}

function isSecretName(name: string): boolean {
  return SECRET_NAMES.has(name);
}

function isModelName(name: string): boolean {
  return MODEL_KEYS.has(name);
}

function parseLegacyEnvFile(text: string): Map<string, string> {
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

async function atomicWriteJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp-' + process.pid;
  await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  try {
    await chmod(tmp, 0o600);
  } catch {
    // Windows: chmod is a no-op; ACLs inherit the user profile.
  }
  await rename(tmp, filePath);
}

export interface ProviderCredentialServiceOptions {
  readonly filePath?: string;
  readonly userDataDir?: string;
  readonly safeStorage?: SafeStorageLike;
  readonly legacyEnvPath?: string;
}

function defaultLegacyPath(): string {
  return join(tmpdir(), 'sentry-desktop-providers.env');
}

export class ProviderCredentialService {
  private readonly memory = new Map<string, string>();
  /** Secret names currently backed by the encrypted store. */
  private readonly persistedSecrets = new Set<string>();
  /** Non-secret names currently backed by the plain prefs file. */
  private readonly persistedPrefs = new Set<string>();
  private readonly credentialPath: string;
  private readonly modelPrefsPath: string;
  private readonly legacyPath: string | undefined;
  private readonly safeStorage: SafeStorageLike | undefined;
  private secureAvailable: boolean;

  constructor(options: ProviderCredentialServiceOptions = {}) {
    const dir = options.userDataDir;
    this.credentialPath =
      options.filePath ??
      (dir !== undefined
        ? join(dir, 'credentials', 'providers.json')
        : join(tmpdir(), 'sentry-credentials', 'providers.json'));
    this.modelPrefsPath =
      dir !== undefined
        ? join(dir, 'preferences', 'models.json')
        : join(tmpdir(), 'sentry-credentials', 'models.json');
    this.legacyPath = options.legacyEnvPath ?? defaultLegacyPath();
    // Never collide the new encrypted store with the legacy plaintext path.
    this.safeStorage = options.safeStorage;
    this.secureAvailable = options.safeStorage?.isEncryptionAvailable() ?? false;
  }

  get path(): string {
    return this.credentialPath;
  }

  get secureStorageAvailable(): boolean {
    return this.secureAvailable;
  }

  refreshSecureAvailability(): boolean {
    this.secureAvailable = this.safeStorage?.isEncryptionAvailable() ?? false;
    return this.secureAvailable;
  }

  /**
   * Boot load: decrypt saved secrets → memory + process.env, load model
   * prefs, then one-time migrate the legacy plaintext file. Never throws.
   */
  async load(): Promise<void> {
    this.refreshSecureAvailability();
    if (this.secureAvailable && this.safeStorage !== undefined) {
      try {
        const text = await readFile(this.credentialPath, 'utf8');
        const parsed = JSON.parse(text) as Partial<EncryptedStoreFile>;
        const secrets = parsed.secrets ?? {};
        for (const name of SECRET_PROVIDER_KEYS) {
          const blob = secrets[name];
          if (typeof blob !== 'string' || blob.length === 0) continue;
          try {
            const value = this.safeStorage.decryptString(Buffer.from(blob, 'base64'));
            if (value.length === 0) continue;
            this.memory.set(name, value);
            this.persistedSecrets.add(name);
            if (process.env[name] === undefined || process.env[name] === '')
              process.env[name] = value;
          } catch {
            // Corrupt entry: skip without failing boot; never log the value.
          }
        }
      } catch {
        // Absent store is the normal first-launch state.
      }
    }
    try {
      const text = await readFile(this.modelPrefsPath, 'utf8');
      const parsed = JSON.parse(text) as Partial<ModelPrefsFile>;
      for (const [name, value] of Object.entries(parsed.models ?? {})) {
        if (!isModelName(name) || typeof value !== 'string' || value.length === 0) continue;
        this.persistedPrefs.add(name);
        if (!this.memory.has(name)) {
          this.memory.set(name, value);
          if (process.env[name] === undefined || process.env[name] === '')
            process.env[name] = value;
        }
      }
    } catch {
      // Absent prefs are normal.
    }
    // Adopt pre-existing environment values as session memory (never persisted here).
    for (const name of MANAGED_PROVIDER_KEYS) {
      if (!this.memory.has(name)) {
        const envValue = process.env[name];
        if (envValue !== undefined && envValue.length > 0) this.memory.set(name, envValue);
      }
    }
    await this.migrateLegacyFile();
  }

  private async migrateLegacyFile(): Promise<void> {
    if (this.legacyPath === undefined) return;
    if (this.legacyPath === this.credentialPath) return;
    let text: string;
    try {
      text = await readFile(this.legacyPath, 'utf8');
    } catch {
      return;
    }
    const entries = parseLegacyEnvFile(text);
    if (entries.size === 0) {
      try {
        await unlink(this.legacyPath);
      } catch {
        // Best effort.
      }
      return;
    }
    if (!this.secureAvailable || this.safeStorage === undefined) return;
    let migratedSecrets = 0;
    for (const [name, value] of entries) {
      if (!isSecretName(name) || value.length === 0) continue;
      if (!this.memory.has(name)) {
        this.memory.set(name, value);
        if (process.env[name] === undefined || process.env[name] === '') process.env[name] = value;
      }
      this.persistedSecrets.add(name);
      migratedSecrets += 1;
    }
    const models: Record<string, string> = {};
    for (const [name, value] of entries) {
      if (isModelName(name) && value.length > 0) {
        if (!this.memory.has(name)) {
          this.memory.set(name, value);
          if (process.env[name] === undefined || process.env[name] === '')
            process.env[name] = value;
        }
        models[name] = value;
      }
    }
    if (Object.keys(models).length > 0) {
      try {
        await this.writeModelPrefs(models);
      } catch {
        // Non-fatal; secrets below still persist.
      }
    }
    if (migratedSecrets > 0) {
      try {
        await this.writeEncryptedStore();
        await unlink(this.legacyPath);
      } catch {
        // Keep the legacy file if the secure write failed — never delete
        // credentials we could not re-persist.
      }
    }
  }

  private async writeEncryptedStore(): Promise<void> {
    if (this.safeStorage === undefined) throw new Error('Secure storage unavailable');
    const secrets: Record<string, string> = {};
    for (const name of this.persistedSecrets) {
      const value = this.memory.get(name);
      if (value === undefined || !isSecretName(name)) continue;
      secrets[name] = this.safeStorage.encryptString(value).toString('base64');
    }
    const payload: EncryptedStoreFile = { version: 1, secrets };
    await atomicWriteJson(this.credentialPath, payload);
  }

  private async writeModelPrefs(extra?: Record<string, string>): Promise<void> {
    const models: Record<string, string> = { ...(extra ?? {}) };
    for (const name of MODEL_KEYS) {
      const value = this.memory.get(name);
      if (value !== undefined && value.length > 0) models[name] = value;
    }
    const payload: ModelPrefsFile = { version: 1, models };
    await atomicWriteJson(this.modelPrefsPath, payload);
    for (const name of Object.keys(models)) this.persistedPrefs.add(name);
  }

  statuses(): ProviderCredentialStatus[] {
    return MANAGED_PROVIDER_KEYS.map((name) => this.statusFor(name));
  }

  /**
   * Main-process-only value read (for boot-time env wiring). Never exposed
   * over IPC — the renderer sees statuses only.
   */
  getValue(name: string): string | undefined {
    if (!(MANAGED_PROVIDER_KEYS as readonly string[]).includes(name)) return undefined;
    const fromMemory = this.memory.get(name);
    if (fromMemory !== undefined && fromMemory.length > 0) return fromMemory;
    const envValue = process.env[name];
    return envValue !== undefined && envValue.length > 0 ? envValue : undefined;
  }

  /**
   * Save (the only mode): encrypt + persist + load into runtime + refresh
   * env. Secrets require secure storage — without it the save is refused
   * instead of silently degrading. Non-secret values persist as prefs.
   */
  async saveKey(name: string, value: string): Promise<ProviderCredentialStatus> {
    this.assertManaged(name);
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 5000) {
      throw Object.assign(new Error('Provider key value is empty or too long'), {
        code: 'PROVIDER_KEY_INVALID',
      });
    }
    if (isSecretName(name) && (!this.secureAvailable || this.safeStorage === undefined)) {
      throw Object.assign(
        new Error('Secure persistent storage unavailable. The credential was not saved.'),
        { code: 'SECURE_STORAGE_UNAVAILABLE' },
      );
    }
    this.memory.set(name, trimmed);
    process.env[name] = trimmed;
    if (isSecretName(name)) {
      this.persistedSecrets.add(name);
      await this.writeEncryptedStore();
    } else if (isModelName(name)) {
      await this.writeModelPrefs();
    }
    return this.statusFor(name);
  }

  async clearKey(name: string): Promise<ProviderCredentialStatus> {
    this.assertManaged(name);
    this.memory.delete(name);
    this.persistedSecrets.delete(name);
    this.persistedPrefs.delete(name);
    delete process.env[name];
    if (isSecretName(name) && this.secureAvailable) {
      try {
        await this.writeEncryptedStore();
      } catch {
        // Memory + env already cleared; store rewrite is best-effort.
      }
    }
    if (isModelName(name)) {
      try {
        await this.writeModelPrefs();
      } catch {
        // Best effort.
      }
    }
    return this.statusFor(name);
  }

  /** @deprecated Use saveKey (persist); kept for older IPC call sites. */
  async persist(): Promise<{ path: string; keys: number }> {
    if (this.secureAvailable && this.safeStorage !== undefined) {
      await this.writeEncryptedStore();
      await this.writeModelPrefs();
      return { path: this.credentialPath, keys: this.persistedSecrets.size };
    }
    throw Object.assign(new Error('Secure persistent storage unavailable.'), {
      code: 'SECURE_STORAGE_UNAVAILABLE',
    });
  }

  async forgetAll(): Promise<{ forgotten: boolean }> {
    for (const name of SECRET_PROVIDER_KEYS) {
      this.memory.delete(name);
      this.persistedSecrets.delete(name);
      delete process.env[name];
    }
    try {
      await unlink(this.credentialPath);
    } catch {
      // Absent file is the desired end state.
    }
    return { forgotten: true };
  }

  /** @deprecated Use forgetAll; kept for older IPC call sites. */
  async forgetFile(): Promise<void> {
    await this.forgetAll();
    try {
      if (this.legacyPath !== undefined && this.legacyPath !== this.credentialPath) {
        await unlink(this.legacyPath);
      }
    } catch {
      // Best effort.
    }
  }

  private assertManaged(name: string): void {
    if (!(MANAGED_PROVIDER_KEYS as readonly string[]).includes(name)) {
      throw Object.assign(new Error('Unsupported provider key: ' + name), {
        code: 'PROVIDER_KEY_UNSUPPORTED',
      });
    }
  }

  private statusFor(name: string): ProviderCredentialStatus {
    const fromMemory = this.memory.get(name);
    const envValue = process.env[name];
    const effective = fromMemory ?? envValue;
    const configured = effective !== undefined && effective.length > 0;
    if (!configured) {
      return {
        name,
        configured: false,
        persistence: 'missing',
        source: 'missing',
        hint: 'missing',
      };
    }
    if (isSecretName(name)) {
      // Secrets never leak: fixed display, no prefixes/suffixes/blobs.
      if (this.persistedSecrets.has(name) && fromMemory !== undefined) {
        return {
          name,
          configured: true,
          persistence: 'secure',
          source: 'stored',
          hint: 'Configured · Stored securely',
        };
      }
      return {
        name,
        configured: true,
        persistence: 'environment',
        source: 'environment',
        hint: 'Configured · From environment',
      };
    }
    if (this.persistedPrefs.has(name) && fromMemory !== undefined) {
      return {
        name,
        configured: true,
        persistence: 'persisted',
        source: 'persisted',
        hint: effective ?? 'missing',
      };
    }
    return {
      name,
      configured: true,
      persistence: 'environment',
      source: 'environment',
      hint: effective ?? 'missing',
    };
  }
}
