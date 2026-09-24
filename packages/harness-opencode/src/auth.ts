import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Sentry-owned OpenCode auth boundary file (see scope.ts for the full
 * disposable scope).
 *
 * Provider auth resolves from `<scopeDataHome>/opencode/auth.json` as
 * `{"<providerId>": {"type": "api", "key": "..."}}` and reaches the
 * model SDK as `options.apiKey`, so `OPENROUTER_API_KEY` never appears in
 * ANY child process environment (verified against opencode-ai 1.18.32
 * source: auth store → provider key → SDK options; shell tools inherit the
 * host process environment).
 */
export const OPENCODE_AUTH_PROVIDER_ID = 'openrouter' as const;

export interface OpenCodeAuthBoundary {
  readonly directory: string;
  readonly authFile: string;
}

export async function writeOpenCodeAuthBoundary(input: {
  /** Sentry-owned disposable data home (`XDG_DATA_HOME` value). */
  readonly scopeDataHome: string;
  readonly apiKey: string;
}): Promise<OpenCodeAuthBoundary> {
  const directory = input.scopeDataHome;
  const authFile = join(directory, 'opencode', 'auth.json');
  await mkdir(dirname(authFile), { recursive: true });
  await writeFile(
    authFile,
    JSON.stringify({ [OPENCODE_AUTH_PROVIDER_ID]: { type: 'api', key: input.apiKey } }) + '\n',
    { mode: 0o600 },
  );
  try {
    await chmod(authFile, 0o600);
  } catch {
    // Windows: chmod is best-effort; the file stays inside the
    // Sentry-owned scope and is removed after the run.
  }
  return { directory, authFile };
}

export async function removeOpenCodeAuthFile(authFile: string): Promise<void> {
  await rm(authFile, { force: true });
}

export async function readOpenCodeAuthFile(authFile: string): Promise<unknown> {
  return JSON.parse(await readFile(authFile, 'utf8'));
}
