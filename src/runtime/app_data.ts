/**
 * HR-02.5 Linux enablement / HR-02.5F: canonical ARTHUR application
 * data-root primitive.
 *
 * This is a generic ARTHUR platform primitive — NOT a local-model
 * primitive. It answers one question: where do ARTHUR's persistent
 * per-user application files live on this machine? Model provisioning
 * (`runtime/local-models/provisioning/paths.ts`), configuration
 * defaults (`config/settings.ts`), and any future persistent subsystem
 * all derive from THIS resolver so there is exactly one app-data-root
 * policy. Do not duplicate its logic; re-export it where a previous
 * import location must keep working.
 *
 * Precedence: explicit configured root -> ARTHUR_DATA_DIR -> stable
 * OS-specific per-user application data directory. The fallback NEVER
 * depends on process.cwd(): without an explicit root, two processes
 * started from different directories resolve the same identity. When
 * no stable location exists, resolution fails typed (INVALID_CONFIG)
 * rather than silently using temp storage (temp is not durable).
 * Repo-local ./data remains available only as an explicit dev override
 * (configured root or ARTHUR_DATA_DIR).
 */

import * as path from 'node:path';

import { ArthurError } from '../core/errors/errors';

export interface AppDataRootArgs {
  configured?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /**
   * Platform seam for tests: path semantics matching `platform`
   * (default: host node:path). Lets Windows-shape assertions run
   * deterministically on Linux CI via path.win32 without weakening them.
   */
  pathImpl?: Pick<typeof path, 'join' | 'resolve' | 'normalize' | 'sep'>;
}

// Stable per-user application data root. Windows uses LOCALAPPDATA
// (machine-local, non-roaming: model weights, Python runtimes, staging,
// caches, and databases can be very large and must never live in the
// roaming profile). Returns null when no stable location is discoverable
// — the caller fails typed rather than falling back to temp storage
// (temp is not durable: files may vanish while persisted state still
// claims they exist). Tests may use temp dirs via an explicit
// configured root.
function userDataFallback(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, pathImpl: Pick<typeof path, 'join' | 'resolve' | 'normalize' | 'sep'>): string | null {
  if (platform === 'win32') {
    const base = env['LOCALAPPDATA'];
    if (typeof base === 'string' && base.trim() !== '') return pathImpl.join(base, 'ARTHUR');
    return null;
  }
  if (platform === 'darwin') {
    const home = env['HOME'];
    if (typeof home === 'string' && home.trim() !== '') return pathImpl.join(home, 'Library', 'Application Support', 'ARTHUR');
    return null;
  }
  const xdg = env['XDG_DATA_HOME'];
  if (typeof xdg === 'string' && xdg.trim() !== '') return pathImpl.join(xdg, 'arthur');
  const home = env['HOME'];
  if (typeof home === 'string' && home.trim() !== '') return pathImpl.join(home, '.local', 'share', 'arthur');
  return null;
}

/**
 * Resolve the ARTHUR application data root once: explicit configured
 * root wins, then ARTHUR_DATA_DIR, else a stable OS-specific per-user
 * application data directory. The fallback NEVER depends on
 * process.cwd(). Returns an absolute path.
 */
export function resolveAppDataRoot(args: AppDataRootArgs = {}): string {
  const env = args.env ?? process.env;
  const platform = args.platform ?? process.platform;
  const pathImpl = args.pathImpl ?? path;
  const fromEnv = env['ARTHUR_DATA_DIR'];
  if (args.configured !== undefined || (typeof fromEnv === 'string' && fromEnv.trim() !== '')) {
    const raw = (args.configured ?? fromEnv) as string;
    if (raw.indexOf(String.fromCharCode(0)) !== -1) throw new ArthurError('INVALID_CONFIG', 'data root contains NUL');
    return pathImpl.resolve(raw);
  }
  const fallback = userDataFallback(platform, env, pathImpl);
  if (fallback === null) {
    throw new ArthurError('INVALID_CONFIG', 'no stable application data directory available; set an explicit data root or ARTHUR_DATA_DIR');
  }
  return pathImpl.resolve(fallback);
}
