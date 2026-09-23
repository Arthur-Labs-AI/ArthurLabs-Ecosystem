import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Sentry-owned OpenCode auth boundary (file-based provider credential).
 *
 * Verified against current OpenCode source: provider keys resolve from the
 * auth store (`<Global.Path.data>/auth.json`, `"<providerId>":
 * {"type": "api", "key": "..."}`) and are passed to the model SDK as
 * `options.apiKey`, so `OPENROUTER_API_KEY` never needs to appear in ANY
 * child process environment. `Global.Path.data` honors `XDG_DATA_HOME`, so
 * Sentry redirects it per AgentRun to a Sentry-owned disposable directory
 * OUTSIDE (sibling of, never inside) the agent workspace.
 *
 * Result: model-controlled shell tools inherit an environment that simply
 * has no provider credential — isolation by construction, not by filtering.
 * The boundary directory is removed when the run settles (run finally +
 * adapter dispose as a backstop). Values never leave this module.
 */
export const OPENCODE_AUTH_PROVIDER_ID = 'openrouter' as const;

export interface OpenCodeAuthBoundary {
  /** Sentry-owned disposable directory (contains `opencode/auth.json`). */
  readonly directory: string;
  readonly authFile: string;
}

export async function writeOpenCodeAuthBoundary(input: {
  /** The agent workspace path; the boundary lands beside it (never inside). */
  readonly workspacePath: string;
  readonly runId: string;
  readonly apiKey: string;
}): Promise<OpenCodeAuthBoundary> {
  const safeRunId = input.runId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'run';
  const directory = join(dirname(input.workspacePath), '.sentry-opencode-auth-' + safeRunId);
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
    // Sentry-owned data scope and is removed after the run.
  }
  return { directory, authFile };
}

export async function cleanupOpenCodeAuthBoundary(boundary: OpenCodeAuthBoundary): Promise<void> {
  await rm(boundary.directory, { recursive: true, force: true });
}

export async function readOpenCodeAuthFile(authFile: string): Promise<unknown> {
  return JSON.parse(await readFile(authFile, 'utf8'));
}
