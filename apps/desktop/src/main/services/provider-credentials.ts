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
 * safeStorage unavailable → refuse secret saves, NEVER plaintext fallback.
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
  readonly persistence: 'secure' | 'persisted' | 'environment' | 'missing' | 'unavailable';
  readonly source: 'stored' | 'persisted' | 'environment' | 'missing' | 'unavailable';
  readonly storageError?:
    'store-unreadable' | 'entry-unreadable' | 'secure-storage-unavailable' | 'migration-failed';
  readonly hint: string;
}

interface EncryptedStoreFile {
  readonly version: 1;
  readonly secrets: Record<string, unknown>;
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

function entryUnreadable(): Error {
  return Object.assign(new Error('Credential entry unreadable'), {
    code: 'CREDENTIAL_ENTRY_UNREADABLE',
  });
}

function isEntryUnreadable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'CREDENTIAL_ENTRY_UNREADABLE'
  );
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

let atomicWriteCounter = 0;

async function atomicWriteJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  // Unique per call: concurrent same-file writers must never share a tmp path.
  const tmp = filePath + '.tmp-' + String(process.pid) + '-' + String(atomicWriteCounter++);
  try {
    await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    try {
      await chmod(tmp, 0o600);
    } catch {
      // Windows: chmod is a no-op; ACLs inherit the user profile.
    }
    await rename(tmp, filePath);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
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
  private mutation: Promise<void> = Promise.resolve();
  private storeLoadError: ProviderCredentialStatus['storageError'];
  private readonly entryLoadErrors = new Map<string, ProviderCredentialStatus['storageError']>();

  constructor(options: ProviderCredentialServiceOptions = {}) {
    const dir = options.userDataDir === '' ? undefined : options.userDataDir;
    this.credentialPath =
      options.filePath ?? (dir !== undefined ? join(dir, 'credentials', 'providers.json') : '');
    // Never a directory named preferences: on case-insensitive filesystems
    // that collides with Chromium's own Preferences file in Electron userData.
    this.modelPrefsPath =
      dir !== undefined
        ? join(dir, 'sentry-prefs', 'models.json')
        : options.filePath !== undefined
          ? join(dirname(options.filePath), 'models.json')
          : '';
    this.legacyPath = options.legacyEnvPath ?? defaultLegacyPath();
    // Never collide the new encrypted store with the legacy plaintext path.
    this.safeStorage = options.safeStorage;
    this.secureAvailable = false;
    this.refreshSecureAvailability();
  }

  get path(): string {
    this.assertProfile();
    return this.credentialPath;
  }

  private assertProfile(): void {
    if (this.credentialPath.length === 0 || this.modelPrefsPath.length === 0) {
      throw Object.assign(
        new Error('Credential profile unavailable. Restart with a valid Electron profile.'),
        { code: 'CREDENTIAL_PROFILE_UNAVAILABLE' },
      );
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutation.then(operation);
    this.mutation = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async readEncryptedStore(): Promise<EncryptedStoreFile> {
    try {
      const parsed = JSON.parse(
        await readFile(this.credentialPath, 'utf8'),
      ) as Partial<EncryptedStoreFile>;
      if (
        parsed === null ||
        parsed.version !== 1 ||
        typeof parsed.secrets !== 'object' ||
        parsed.secrets === null ||
        Array.isArray(parsed.secrets)
      )
        throw new Error();
      return parsed as EncryptedStoreFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { version: 1, secrets: {} };
      throw Object.assign(
        new Error(
          'Credential store unreadable. Keep the existing store and check OS secure storage.',
        ),
        { code: 'CREDENTIAL_STORE_UNREADABLE' },
      );
    }
  }

  /** Live availability, never a cached boot verdict: Electron's crypto
   *  backend is not up before app-ready, and the service is constructed
   *  during pre-ready boot. Every consumer below re-evaluates. */
  get secureStorageAvailable(): boolean {
    return this.refreshSecureAvailability();
  }

  /** Concrete reason saves are refused, if they are. Surfaced in errors
   *  so a blocked user sees the cause, not a generic sentence. */
  secureUnavailableReason(): string | undefined {
    if (this.refreshSecureAvailability()) return undefined;
    if (this.safeStorage === undefined) return 'Electron safeStorage bridge unavailable';
    return 'OS encryption (DPAPI/keychain) reported unavailable';
  }

  refreshSecureAvailability(): boolean {
    try {
      this.secureAvailable = this.safeStorage?.isEncryptionAvailable() ?? false;
    } catch {
      this.secureAvailable = false;
    }
    return this.secureAvailable;
  }

  /**
   * Boot load: decrypt saved secrets → memory + process.env, load model
   * prefs, then one-time migrate the legacy plaintext file. Storage failures
   * remain non-fatal; an unresolved profile is refused before any I/O.
   * Presence diagnostics opt into strict encrypted-store validation;
   * a skipped/unreadable entry cannot be presented as a confirmed absence.
   */
  async load(options: { readonly strict?: boolean } = {}): Promise<void> {
    this.assertProfile();
    this.refreshSecureAvailability();
    if (options.strict && !this.secureAvailable) throw new Error('Secure storage unavailable');
    this.storeLoadError = undefined;
    this.entryLoadErrors.clear();
    for (const name of this.persistedSecrets) this.memory.delete(name);
    this.persistedSecrets.clear();
    {
      try {
        const { secrets } = await this.readEncryptedStore();
        for (const name of SECRET_PROVIDER_KEYS) {
          const blob = secrets[name];
          if (blob === undefined) continue;
          try {
            if (
              typeof blob !== 'string' ||
              blob.length === 0 ||
              Buffer.from(blob, 'base64').toString('base64') !== blob
            )
              throw entryUnreadable();
            if (!this.secureAvailable || this.safeStorage === undefined) {
              this.entryLoadErrors.set(name, 'secure-storage-unavailable');
              continue;
            }
            const value = this.safeStorage.decryptString(Buffer.from(blob, 'base64'));
            if (value.length === 0) throw entryUnreadable();
            this.memory.set(name, value);
            this.persistedSecrets.add(name);
            if (process.env[name] === undefined || process.env[name] === '')
              process.env[name] = value;
          } catch {
            if (options.strict) throw entryUnreadable();
            this.entryLoadErrors.set(name, 'entry-unreadable');
          }
        }
      } catch (error) {
        if (options.strict) {
          // Entry-level verdicts already carry their precision outward;
          // only unclassified failures become the store-level verdict.
          if (isEntryUnreadable(error)) throw error;
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new Error('Credential store unreadable');
          }
        }
        this.storeLoadError = 'store-unreadable';
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
    // A presence query only inspects the store. Normal Desktop boot keeps
    // the existing one-time migration; diagnostics must not rewrite settings.
    if (!options.strict && this.storeLoadError === undefined) await this.migrateLegacyFile();
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
    try {
      for (const [name, value] of entries) {
        if (value.length === 0) continue;
        if (isSecretName(name)) {
          // A current stored key wins; never overwrite an unreadable entry
          // with a stale legacy value during automatic migration.
          if (this.entryLoadErrors.has(name)) return;
          if (!this.persistedSecrets.has(name))
            await this.saveKey(name, this.memory.get(name) ?? value);
          migratedSecrets += 1;
        } else if (isModelName(name) && !this.persistedPrefs.has(name)) {
          await this.saveKey(name, this.memory.get(name) ?? value);
        }
      }
      if (migratedSecrets > 0) await unlink(this.legacyPath);
    } catch {
      // Retain legacy input until every intended encrypted write succeeds.
      // Successfully committed keys remain durable; rejected keys stay unconfigured.
      this.storeLoadError = 'migration-failed';
    }
  }

  private async writeModelPrefs(memory: ReadonlyMap<string, string>): Promise<void> {
    const models: Record<string, string> = {};
    for (const name of MODEL_KEYS) {
      const value = memory.get(name);
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
   * Boundary scrubber: removes exact known secret-lane values from
   * outbound diagnostic text (renderer/CLI/log surfaces). Format-agnostic
   * (exact values, not prefix patterns); only values long enough to be
   * distinctive are scrubbed so ordinary words are never mangled. Values
   * never leave this process through this method — only scrubbed text does.
   */
  redactSecretsFromText(text: string): string {
    let out = text;
    for (const name of SECRET_PROVIDER_KEYS) {
      const candidates = [this.memory.get(name), process.env[name]];
      for (const candidate of candidates) {
        if (candidate !== undefined && candidate.length >= 8 && out.includes(candidate)) {
          out = out.split(candidate).join('[REDACTED]');
        }
      }
    }
    return out;
  }
  /**
   * Save (the only mode): encrypt + persist + load into runtime + refresh
   * env. Secrets require secure storage — without it the save is refused
   * instead of silently degrading. Non-secret values persist as prefs.
   */
  async saveKey(name: string, value: string): Promise<ProviderCredentialStatus> {
    this.assertProfile();
    this.assertManaged(name);
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 5000) {
      throw Object.assign(new Error('Provider key value is empty or too long'), {
        code: 'PROVIDER_KEY_INVALID',
      });
    }
    return this.enqueue(async () => {
      if (
        isSecretName(name) &&
        (!this.refreshSecureAvailability() || this.safeStorage === undefined)
      ) {
        throw Object.assign(
          new Error(
            'Secure persistent storage unavailable' +
              (this.secureUnavailableReason() === undefined
                ? '. The credential was not saved.'
                : ' (' +
                  (this.secureUnavailableReason() as string) +
                  '). The credential was not saved.'),
          ),
          { code: 'SECURE_STORAGE_UNAVAILABLE' },
        );
      }
      try {
        if (isSecretName(name)) {
          const store = await this.readEncryptedStore();
          const blob = this.safeStorage!.encryptString(trimmed).toString('base64');
          if (blob.length === 0) throw new Error();
          // Preserve every untouched ciphertext, including unreadable entries.
          await atomicWriteJson(this.credentialPath, {
            ...store,
            secrets: { ...store.secrets, [name]: blob },
          });
        } else {
          await this.writeModelPrefs(new Map(this.memory).set(name, trimmed));
        }
      } catch {
        // Backend exceptions can include the submitted secret. Never forward them.
        throw Object.assign(
          new Error('Credential could not be stored securely. Previous settings were preserved.'),
          { code: 'CREDENTIAL_WRITE_FAILED' },
        );
      }
      this.memory.set(name, trimmed);
      process.env[name] = trimmed;
      if (isSecretName(name)) {
        this.persistedSecrets.add(name);
        this.entryLoadErrors.delete(name);
      }
      return this.statusFor(name);
    });
  }

  async clearKey(name: string): Promise<ProviderCredentialStatus> {
    this.assertProfile();
    this.assertManaged(name);
    return this.enqueue(async () => {
      try {
        if (isSecretName(name)) {
          const store = await this.readEncryptedStore();
          const secrets = { ...store.secrets };
          delete secrets[name];
          await atomicWriteJson(this.credentialPath, { ...store, secrets });
        } else {
          const memory = new Map(this.memory);
          memory.delete(name);
          await this.writeModelPrefs(memory);
        }
      } catch {
        throw Object.assign(
          new Error('Credential could not be cleared. Previous settings were preserved.'),
          { code: 'CREDENTIAL_WRITE_FAILED' },
        );
      }
      this.memory.delete(name);
      this.persistedSecrets.delete(name);
      this.persistedPrefs.delete(name);
      delete process.env[name];
      this.entryLoadErrors.delete(name);
      return this.statusFor(name);
    });
  }

  /** @deprecated Use saveKey (persist); kept for older IPC call sites. */
  async persist(): Promise<{ path: string; keys: number }> {
    this.assertProfile();
    return this.enqueue(async () => {
      if (this.refreshSecureAvailability() && this.safeStorage !== undefined) {
        const store = await this.readEncryptedStore();
        await atomicWriteJson(this.credentialPath, store);
        await this.writeModelPrefs(this.memory);
        return { path: this.credentialPath, keys: this.persistedSecrets.size };
      }
      const reason = this.secureUnavailableReason();
      throw Object.assign(
        new Error(
          reason === undefined
            ? 'Secure persistent storage unavailable.'
            : 'Secure persistent storage unavailable (' + reason + ').',
        ),
        { code: 'SECURE_STORAGE_UNAVAILABLE' },
      );
    });
  }

  async forgetAll(): Promise<{ forgotten: boolean }> {
    this.assertProfile();
    return this.enqueue(async () => {
      try {
        await unlink(this.credentialPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw Object.assign(
            new Error('Credentials could not be forgotten. Previous settings were preserved.'),
            { code: 'CREDENTIAL_WRITE_FAILED' },
          );
      }
      for (const name of SECRET_PROVIDER_KEYS) {
        this.memory.delete(name);
        this.persistedSecrets.delete(name);
        delete process.env[name];
      }
      this.entryLoadErrors.clear();
      this.storeLoadError = undefined;
      return { forgotten: true };
    });
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
    const storageError = isSecretName(name)
      ? (this.storeLoadError ?? this.entryLoadErrors.get(name))
      : undefined;
    if (!configured) {
      return {
        name,
        configured: false,
        persistence: storageError === undefined ? 'missing' : 'unavailable',
        source: storageError === undefined ? 'missing' : 'unavailable',
        hint:
          storageError === undefined
            ? 'missing'
            : 'Stored credential unavailable. Check OS secure storage; keep the existing store.',
        ...(storageError === undefined ? {} : { storageError }),
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
        ...(storageError === undefined ? {} : { storageError }),
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
