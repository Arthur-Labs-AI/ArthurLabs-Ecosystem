/**
 * SC-05 GitRefResolver (spec sections 80-85, F19-F21).
 *
 * Untrusted model refs never reach a final command directly. Pipeline:
 * length/control validation -> reject option-like values -> rev-parse
 * --verify --quiet --end-of-options <ref>^{commit} -> canonical full OID.
 * Final diff/show/log commands use the OID only, giving snapshot semantics.
 */

export const MAX_REF_CHARS = 256;

export interface RefResolveDeps {
  runGit: (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export class GitRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitRefError";
    (this as { code?: string }).code = "GIT_REF_INVALID";
  }
}

function failRef(reason: string): never {
  throw new GitRefError("Invalid git ref: " + reason + ".");
}

/** Pure validation of the raw model ref (fail closed, no I/O). */
export function assertRefShape(ref: unknown): asserts ref is string {
  if (typeof ref !== "string") failRef("must be a string");
  const value = ref as string;
  if (value.length === 0 || value.length > MAX_REF_CHARS) failRef("length must be 1..256 characters");
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0 || code < 0x20 || code === 0x7f) failRef("contains control characters");
  }
  if (value.startsWith("-")) failRef("must not begin with '-'");
  if (value.includes("\0")) failRef("contains NUL");
}

/**
 * Resolve a model ref to a canonical full commit OID.
 * Uses: git rev-parse --verify --quiet --end-of-options <ref>^{commit}
 */
export async function resolveRefToOid(ref: string, cwd: string, deps: RefResolveDeps): Promise<string> {
  assertRefShape(ref);
  const peeled = ref + "^{commit}";
  const res = await deps.runGit(["rev-parse", "--verify", "--quiet", "--end-of-options", peeled], cwd);
  if (res.exitCode !== 0) failRef("cannot be resolved to a commit");
  const oid = res.stdout.trim().split("\n")[0]?.trim() ?? "";
  if (!/^[0-9a-f]{40}$/.test(oid)) failRef("cannot be resolved to a commit");
  return oid;
}

/** Resolve an optional ref; undefined stays undefined (means HEAD default). */
export async function resolveOptionalRef(
  ref: unknown,
  cwd: string,
  deps: RefResolveDeps,
): Promise<string | undefined> {
  if (ref === undefined) return undefined;
  if (typeof ref !== "string") failRef("must be a string");
  return resolveRefToOid(ref, cwd, deps);
}
