import { createHash } from 'node:crypto';
import { VERIFICATION_SIGNATURE_VERSION } from '@qa/schemas';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** First-token allowlist for replayable commands (v1). Replay executes
 *  ONLY recorded commands headed by known test/build/language tooling.
 *  Anything else becomes an `unsupported` step (honest inconclusive),
 *  never an ad-hoc shell. This bounds the blast radius alongside cwd
 *  containment, scrubbed env, and timeouts — never a blocklist. */
export const VERIFICATION_COMMAND_ALLOWLIST: ReadonlySet<string> = new Set(
  (
    'node npm pnpm yarn bun npx tsc vite vitest jest pytest python python3 ' +
    'dotnet cargo go mvn gradle phpunit rspec ruby bundle make cmake ctest'
  ).split(' '),
);

/** Head token of a recorded command (lowercased basename of argv[0]). */
export function commandHeadToken(command: string): string {
  const first = command.trim().split(/\s+/, 1)[0] ?? '';
  const base = first.replace(/\\/g, '/').split('/').pop() ?? '';
  return base.toLowerCase().replace(/\.(exe|cmd|bat|sh)$/, '');
}

export function isReplayableCommand(command: string): boolean {
  return VERIFICATION_COMMAND_ALLOWLIST.has(commandHeadToken(command));
}

/** Defense-in-depth path guard (§34): reject recorded commands that
 *  smuggle host-escape paths. Cwd containment is the real boundary;
 *  this only refuses the obviously unsafe before spawning. /tmp stays
 *  allowed (test tooling legitimately stages there). */
export function hasUnsafeTarget(command: string): boolean {
  if (/(^|\s)\.\.(\/|\\|$)/.test(command)) return true;
  if (/(^|\s)~(\/|\\|$)/.test(command)) return true;
  const tokens = command.split(/\s+/);
  for (const token of tokens) {
    const cleaned = token.replace(/^["']|["',;]+$/g, '');
    if (/^[A-Za-z]:[\\/]/.test(cleaned)) return true;
    if (
      cleaned.startsWith('/') &&
      !cleaned.startsWith('/tmp/') &&
      cleaned !== '/tmp' &&
      !cleaned.startsWith('/dev/null')
    ) {
      return true;
    }
  }
  return false;
}

/** Deterministic diagnostic normalization (signature v1): strip clearly
 *  unstable information only (workspace root, ISO timestamps, ANSI
 *  escapes, temp prefixes, whitespace). Semantic text is preserved.
 *  Returns a bounded fingerprint for audit, never a full log. */
export function diagnosticFingerprint(output: string, workspaceRoot: string): string {
  const noAnsi = output.replace(/\u001b\[[0-9;]*m/g, '');
  const rooted = workspaceRoot.replace(/\\/g, '/');
  let text = noAnsi.split(rooted).join('<ws>');
  text = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<ts>');
  text = text.replace(/(\S*tmp\S*?)([0-9A-Za-z]{6,})/g, '$1<rand>');
  text = text.replace(/\s+/g, ' ').trim();
  return 'sig' + VERIFICATION_SIGNATURE_VERSION + ':' + text.slice(0, 500);
}

/** Recipe-step dedup fingerprint (§50): identical canonical replay
 *  intent always yields the identical step, whatever the source
 *  finding. */
export function recipeStepFingerprint(parts: {
  readonly type: string;
  readonly command?: string;
  readonly operationIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly path?: string;
  readonly lines?: string;
}): string {
  const canonical = JSON.stringify({
    t: parts.type,
    c: parts.command ?? '',
    ops: [...parts.operationIds].sort(),
    ev: [...parts.evidenceIds].sort(),
    p: parts.path ?? '',
    l: parts.lines ?? '',
  });
  return 'sha256:' + sha256Hex(canonical);
}
