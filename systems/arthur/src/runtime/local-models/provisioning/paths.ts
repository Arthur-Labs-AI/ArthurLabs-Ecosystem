/**
 * HR-02.5D2: managed path service for provisioned model files.
 *
 * Layout under the managed root: models live under models/<key>/live,
 * transient staging areas beside live, managed Python environments
 * under runtimes/python/<runtime-id>, plus staging/ and cache/ areas.
 *
 * A catalog model id NEVER becomes a path directly: it maps through
 * toStorageKey() (lowercase alnum + internal -/_ , max 64 chars) and
 * every resolved path is containment-checked against the canonical
 * managed root. Absolute/drive/UNC escapes, dot-dot segments, NUL bytes
 * are rejected lexically; symlink/junction escapes are rejected via
 * realpath inspection of existing prefixes on destructive and promotion
 * operations (assertNoEscapeThroughLinks). The canonical root identity
 * never depends on the process working directory.
 */

import * as path from 'node:path';

import { ArthurError } from '../../../core/errors/errors';

export const LOCAL_MODEL_DIRNAME = 'local-models';

/** State filename under `<data-root>/runtime/` (single canonical default). */
export const LOCAL_MODEL_STATE_FILENAME = 'models.json';

/**
 * @deprecated Legacy repo-relative segments from early D2 drafts. Never
 * used by the canonical resolver (which derives every default from
 * resolveAppDataRoot). Kept only for import compatibility.
 */
export const DEFAULT_MANAGED_ROOT_SEGMENTS = ['data', 'runtime', 'local-models'];

/**
 * Filesystem indirection inspector (production: node lstat/realpath;
 * tests: in-memory symlinks). Only the prefix chain a caller is about
 * to trust is inspected — no whole-tree walks.
 */
export interface Pathoscopy {
  /** True when the path itself is a symlink/junction (lstat, never follows). */
  isLink(p: string): boolean;
  /** Canonical location of an existing path (realpath); null when absent. */
  realpathOrNull(p: string): string | null;
}

export function nodePathoscopy(): Pathoscopy {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  return {
    isLink(p: string): boolean {
      try {
        return fs.lstatSync(p).isSymbolicLink() || (!fs.statSync(p).isDirectory() && (fs.lstatSync(p) as unknown as { isJunction?: unknown }).isJunction === true);
      } catch {
        return false;
      }
    },
    realpathOrNull(p: string): string | null {
      try {
        return fs.realpathSync(p);
      } catch {
        return null;
      }
    },
  };
}

export function memoryPathoscopy(links: Record<string, string> = {}): Pathoscopy & { links: Map<string, string> } {
  const norm = (p: string): string => path.normalize(p);
  const table = new Map<string, string>(Object.entries(links).map(([k, v]) => [norm(k), norm(v)] as [string, string]));
  return {
    links: table,
    isLink(p: string): boolean {
      return table.has(norm(p));
    },
    realpathOrNull(p: string): string | null {
      const n = norm(p);
      // Longest linked prefix wins, mirroring realpath semantics.
      let cur = n;
      for (let i = 0; i < 64; i += 1) {
        const hit = table.get(cur);
        if (hit !== undefined) return norm(hit + n.slice(cur.length));
        const parent = path.dirname(cur);
        if (parent === cur) return n;
        cur = parent;
      }
      return n;
    },
  };
}

export const STORAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9_\-]{0,63}$/;
export const MAX_STORAGE_KEY_CHARS = 64;

export interface ManagedLayout {
  root: string;
  modelsDir: string;
  runtimesDir: string;
  stagingDir: string;
  cacheDir: string;
  /** Shared ARTHUR-managed torch hub cache (TORCH_HOME). */
  torchCacheDir: string;
  /** Shared ARTHUR-managed model (Hugging Face) cache. */
  hfCacheDir: string;
  /** Shared ARTHUR-managed model hub directory (HF_HUB_CACHE). */
  hfHubDir: string;
  /** Shared ARTHUR-managed Xet chunk cache (HF_XET_CACHE). */
  hfXetDir: string;
  /** Shared ARTHUR-managed HF assets cache (HF_ASSETS_CACHE). */
  hfAssetsDir: string;
}

/** Managed model-cache directory names (code-owned literals). */
export const HF_CACHE_DIRNAME = 'huggingface';
export const HF_HUB_DIRNAME = 'hub';
export const HF_XET_DIRNAME = 'xet';
export const HF_ASSETS_DIRNAME = 'assets';
/** ARTHUR-managed torch hub cache (torch.hub / torchaudio pipelines). */
export const TORCH_CACHE_DIRNAME = 'torch';

/**
 * Code-owned subprocess environment overlay for model-cache variables.
 * Keys are a closed set of CACHE-LOCATION variables only; values are
 * always containment-checked managed paths. Never carries secrets,
 * indexes, URLs, or caller data.
 *
 * Credential separation (E2 correction): HF_HOME is deliberately ABSENT.
 * Per Hugging Face semantics HF_HOME also controls the default token
 * location ($HF_HOME/token), so overriding it would hide the user's
 * normal credential discovery (~/.cache/huggingface/token, HF_TOKEN_PATH,
 * HF_TOKEN) and break gated-repo access with spurious 401s. ARTHUR owns
 * model/cache artifacts; the user's credential remains user-owned
 * external auth state. HF_TOKEN must never appear here.
 */
export interface ModelCacheEnv {
  HF_HUB_CACHE: string;
  HF_XET_CACHE: string;
  HF_ASSETS_CACHE: string;
  TRANSFORMERS_CACHE: string;
  /**
   * ARTHUR-managed torch hub dir (TORCH_HOME). torchaudio pipelines
   * (e.g. the Wav2Vec2 bundle MioCodec loads) download through
   * torch.hub, which defaults to ~/.cache/torch — unmanaged home
   * state outside containment. Overriding keeps ALL model weights
   * inside the managed root. No credential semantics (unlike HF_HOME).
   */
  TORCH_HOME: string;
}

const MANAGED_ENV_KEYS = ['HF_HUB_CACHE', 'HF_XET_CACHE', 'HF_ASSETS_CACHE', 'TRANSFORMERS_CACHE', 'TORCH_HOME'] as const;

export function isManagedEnvKey(key: string): boolean {
  return (MANAGED_ENV_KEYS as readonly string[]).includes(key);
}

export function toStorageKey(modelId: string): string {
  if (typeof modelId !== 'string' || modelId.length === 0 || modelId.length > 256) {
    throw new ArthurError('INVALID_CONFIG', 'invalid model id for storage key: must be 1..256 characters');
  }
  // Fail closed BEFORE sanitizing: path separators, drive/UNC shapes,
  // parent segments, and NUL must never be laundered into an
  // innocent-looking key (which could also collide two model ids).
  if (modelId.includes('\0') || modelId.includes('/') || modelId.includes('\\') || /(^|[\s:])\.\.(\s|$|[/\\])/.test(modelId) || /^[a-zA-Z]:/.test(modelId.trim()) || modelId.trim().startsWith('\\\\')) {
    throw new ArthurError('INVALID_CONFIG', 'model id ' + JSON.stringify(modelId) + ' cannot map to a safe storage key');
  }
  const key = modelId.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (key.length === 0 || key.length > MAX_STORAGE_KEY_CHARS || !STORAGE_KEY_PATTERN.test(key)) {
    throw new ArthurError('INVALID_CONFIG', 'model id ' + JSON.stringify(modelId) + ' cannot map to a safe storage key');
  }
  return key;
}

export function resolveManagedRoot(rawRoot: string): string {
  if (typeof rawRoot !== 'string' || rawRoot.trim() === '') {
    throw new ArthurError('INVALID_CONFIG', 'managed root must be a non-empty path');
  }
  if (rawRoot.includes('\0')) {
    throw new ArthurError('INVALID_CONFIG', 'managed root contains NUL');
  }
  return path.resolve(rawRoot);
}

/**
 * Canonical root identity: absolute + normalized + realpath-resolved when
 * the directory exists. Independent of process cwd: callers pass an
 * absolute configured root (resolveAppDataRoot), so two processes with
 * different cwds derive the same identity for the same configuration.
 */
export function canonicalizeRoot(rawRoot: string, scope: Pathoscopy | null): string {
  const resolved = resolveManagedRoot(rawRoot);
  if (scope) {
    const real = scope.realpathOrNull(resolved);
    if (typeof real === 'string' && real !== '') return path.normalize(real);
  }
  return path.normalize(resolved);
}

/**
 * Canonical app-data-root args — re-exported from the generic primitive
 * (`runtime/app_data.ts`) so existing import sites keep working. New code
 * SHOULD import from `runtime/app_data.ts` directly.
 */
import type { AppDataRootArgs } from '../../app_data';
// Re-exported so existing import sites keep working. New code SHOULD
// import the type from `runtime/app_data.ts` directly.
export type { AppDataRootArgs } from '../../app_data';

/**
 * Canonical app-data-root resolver — re-exported from the generic
 * primitive (`runtime/app_data.ts`). Single implementation; this
 * re-export exists only so existing import sites keep working. New
 * code SHOULD import from `runtime/app_data.ts` directly.
 */
import { resolveAppDataRoot } from '../../app_data';
// Re-exported so existing import sites keep working. New code SHOULD
// import the resolver from `runtime/app_data.ts` directly.
export { resolveAppDataRoot };

export function defaultLocalModelRoot(args: AppDataRootArgs = {}, scope: Pathoscopy | null = null): string {
  const pathImpl = args.pathImpl ?? path;
  const canonical = canonicalizeRoot(resolveAppDataRoot(args), scope);
  return pathImpl.join(canonical, 'runtime', LOCAL_MODEL_DIRNAME);
}

/**
 * HR-02.5F: canonical default state path. Same data-root contract as
 * defaultLocalModelRoot: `<data-root>/runtime/models.json`. Never
 * depends on process.cwd().
 */
export function defaultLocalModelStatePath(args: AppDataRootArgs = {}, scope: Pathoscopy | null = null): string {
  const pathImpl = args.pathImpl ?? path;
  const canonical = canonicalizeRoot(resolveAppDataRoot(args), scope);
  return pathImpl.join(canonical, 'runtime', LOCAL_MODEL_STATE_FILENAME);
}

export interface LocalModelPathOverrides {
  /** Explicit --root / caller configuration (highest precedence). */
  managedRoot?: string;
  /** Explicit --state / caller configuration (highest precedence). */
  statePath?: string;
}

export interface ResolvedLocalModelPaths {
  /** Effective absolute managed root actually in use. */
  managedRoot: string;
  /** Effective absolute state path actually in use. */
  statePath: string;
}

function normalizeExplicitPath(raw: string, what: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ArthurError('INVALID_CONFIG', what + ' must be a non-empty path');
  }
  if (raw.indexOf(String.fromCharCode(0)) !== -1) {
    throw new ArthurError('INVALID_CONFIG', what + ' contains NUL');
  }
  // Deterministic normalization: absolute stays absolute; relative
  // explicit paths keep documented path.resolve semantics.
  return path.resolve(raw);
}

/**
 * HR-02.5F canonical local-model path contract — the ONE resolver used
 * by CLI, setup, and app runtime.
 *
 * Precedence per field:
 *   explicit override -> ARTHUR_DATA_DIR-derived default -> stable OS
 *   user-data root.
 *
 * Defaults NEVER depend on process.cwd(). Returned paths are always
 * absolute. Explicit relative paths preserve the existing documented
 * path.resolve semantics but are normalized deterministically. No shell
 * execution; no secret logging (only paths are returned).
 */
export function resolveLocalModelPaths(
  overrides: LocalModelPathOverrides = {},
  base: AppDataRootArgs = {},
  scope: Pathoscopy | null = null,
): ResolvedLocalModelPaths {
  const managedRaw = overrides.managedRoot;
  const stateRaw = overrides.statePath;
  const managedRoot =
    managedRaw !== undefined && managedRaw.trim() !== ''
      ? normalizeExplicitPath(managedRaw, 'managed root')
      : defaultLocalModelRoot(base, scope);
  const statePath =
    stateRaw !== undefined && stateRaw.trim() !== ''
      ? normalizeExplicitPath(stateRaw, 'state path')
      : defaultLocalModelStatePath(base, scope);
  return { managedRoot, statePath };
}

function insideLexical(rootNorm: string, candNorm: string): boolean {
  return candNorm === rootNorm || candNorm.startsWith(rootNorm + path.sep);
}

/**
 * Link-aware containment for destructive and promotion operations: after
 * the lexical check, every EXISTING prefix of the candidate (and of the
 * root itself) is inspected via realpath. If any existing prefix
 * canonicalizes outside the canonical root, the operation is rejected.
 * Non-existent tails cannot be links yet, so they are lexically bound to
 * the trusted existing prefix instead.
 */
export function assertNoEscapeThroughLinks(canonicalRoot: string, candidate: string, what: string, scope: Pathoscopy): string {
  const candNorm = path.normalize(path.resolve(candidate));
  const rootNorm = path.normalize(canonicalRoot);
  if (!insideLexical(rootNorm, candNorm)) {
    throw new ArthurError('INVALID_CONFIG', what + ' escapes the managed root');
  }
  // The candidate itself must not be a link (it would redirect the whole
  // subtree, including on Windows junctions).
  if (scope.isLink(candNorm)) {
    throw new ArthurError('INVALID_CONFIG', what + ' is a symlink or junction');
  }
  // Walk existing prefixes from the candidate upward: the first existing
  // prefix decides the on-disk truth for the whole tail below it.
  let cur = candNorm;
  for (let i = 0; i < 64; i += 1) {
    const real = scope.realpathOrNull(cur);
    if (real !== null) {
      const realNorm = path.normalize(real);
      if (!insideLexical(rootNorm, realNorm)) {
        throw new ArthurError('INVALID_CONFIG', what + ' escapes the managed root through a symlink or junction');
      }
      return candNorm;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return candNorm;
    cur = parent;
  }
  return candNorm;
}

// Containment check: candidate must equal root or live strictly inside it
// (separator-aware, case-aware per platform, symlink-aware when the path
// exists via realpath). Throws INVALID_CONFIG otherwise.
export function assertInsideRoot(root: string, candidate: string, what: string): string {
  const resolved = path.resolve(candidate);
  if (resolved.includes('\0')) {
    throw new ArthurError('INVALID_CONFIG', what + ' contains NUL');
  }
  const rootNorm = path.normalize(root);
  const candNorm = path.normalize(resolved);
  const inside = candNorm === rootNorm || candNorm.startsWith(rootNorm + path.sep);
  if (!inside) {
    throw new ArthurError('INVALID_CONFIG', what + ' escapes the managed root');
  }
  return candNorm;
}

export class ManagedPathService {
  readonly layout: ManagedLayout;

  constructor(rawRoot: string) {
    const root = resolveManagedRoot(rawRoot);
    const cacheDir = path.join(root, 'cache');
    const hfCacheDir = path.join(cacheDir, HF_CACHE_DIRNAME);
    this.layout = {
      root,
      modelsDir: path.join(root, 'models'),
      runtimesDir: path.join(root, 'runtimes'),
      stagingDir: path.join(root, 'staging'),
      cacheDir,
      torchCacheDir: path.join(cacheDir, TORCH_CACHE_DIRNAME),
      hfCacheDir,
      hfHubDir: path.join(hfCacheDir, HF_HUB_DIRNAME),
      hfXetDir: path.join(hfCacheDir, HF_XET_DIRNAME),
      hfAssetsDir: path.join(hfCacheDir, HF_ASSETS_DIRNAME),
    };
  }

  /**
   * ARTHUR-managed shared model cache env for model subprocesses.
   * Every value is containment-checked inside the managed root, so an
   * ambient external HF_HUB_CACHE / HF_XET_CACHE / home-directory cache
   * can never redirect a model install outside managed storage: callers
   * pass the result as the subprocess env overlay (which overrides
   * ambient values). HF_HOME is NOT set here: credential discovery
   * (user token store, HF_TOKEN_PATH, HF_TOKEN) stays intact.
   */
  modelCacheEnv(): ModelCacheEnv {
    const hfHubDir = assertInsideRoot(this.layout.root, this.layout.hfHubDir, 'model hub dir');
    const hfXetDir = assertInsideRoot(this.layout.root, this.layout.hfXetDir, 'model xet dir');
    const hfAssetsDir = assertInsideRoot(this.layout.root, this.layout.hfAssetsDir, 'model assets dir');
    const torchDir = assertInsideRoot(this.layout.root, this.layout.torchCacheDir, 'model torch dir');
    return { HF_HUB_CACHE: hfHubDir, HF_XET_CACHE: hfXetDir, HF_ASSETS_CACHE: hfAssetsDir, TRANSFORMERS_CACHE: hfHubDir, TORCH_HOME: torchDir };
  }

  modelDir(storageKey: string): string {
    this.checkKey(storageKey);
    return assertInsideRoot(this.layout.root, path.join(this.layout.modelsDir, storageKey), 'model dir');
  }

  liveDir(storageKey: string): string {
    this.checkKey(storageKey);
    return assertInsideRoot(this.layout.root, path.join(this.layout.modelsDir, storageKey, 'live'), 'live dir');
  }

  runtimeDir(runtimeId: string): string {
    // Two accepted shapes (same directory for both): bare storage keys
    // (D2 seam compat) and logical `python/<name>-vN` ids (§21). The
    // `python/` boundary becomes a real directory; the remainder must be
    // a strict storage key in both cases (no separators survive).
    if (typeof runtimeId !== 'string' || runtimeId.includes('\0')) {
      throw new ArthurError('INVALID_CONFIG', 'invalid runtime id ' + JSON.stringify(runtimeId));
    }
    let name = runtimeId;
    if (runtimeId.includes('/')) {
      const parts = runtimeId.split('/');
      if (parts.length !== 2 || parts[0] !== 'python' || typeof parts[1] !== 'string') {
        throw new ArthurError('INVALID_CONFIG', 'invalid runtime id ' + JSON.stringify(runtimeId));
      }
      name = parts[1] as string;
    }
    if (!STORAGE_KEY_PATTERN.test(name)) {
      throw new ArthurError('INVALID_CONFIG', 'invalid runtime id ' + JSON.stringify(runtimeId));
    }
    return assertInsideRoot(this.layout.root, path.join(this.layout.runtimesDir, 'python', name), 'runtime dir');
  }

  cachePath(name: string): string {
    if (typeof name !== 'string' || name.trim() === '' || name.includes('\0')) {
      throw new ArthurError('INVALID_CONFIG', 'invalid cache name');
    }
    return assertInsideRoot(this.layout.root, path.join(this.layout.cacheDir, name), 'cache path');
  }

  private checkKey(storageKey: string): void {
    if (typeof storageKey !== 'string' || !STORAGE_KEY_PATTERN.test(storageKey)) {
      throw new ArthurError('INVALID_CONFIG', 'invalid storage key ' + JSON.stringify(storageKey));
    }
  }
}
