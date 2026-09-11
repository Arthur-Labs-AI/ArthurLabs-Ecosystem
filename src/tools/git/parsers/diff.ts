/**
 * SC-05 diff parser (spec sections 52-61, F16-F18, F34).
 *
 * Two-stage pipeline: (1) numstat for file-level stats (NUL-safe with -z),
 * (2) bounded patch with --no-ext-diff --no-textconv --no-color. Patch is
 * secondary: oversized patches are omitted whole while stats survive.
 * Rename detection disabled (--no-renames) for determinism (section 61).
 */

import type { GitDiffFileStat } from "../contracts";

export const MAX_DIFF_FILES = 500;
export const MAX_PATCH_CHARS = 24 * 1024;

export interface ParsedDiff {
  files: GitDiffFileStat[];
  truncated: boolean;
}

function assertRelativePath(p: string): void {
  if (p.length === 0 || p.length > 4096) throw new Error("diff path out of bounds");
  if (p.includes("\0")) throw new Error("diff path contains NUL");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p) || p.startsWith("\\")) throw new Error("diff path is not repository-relative");
}

/**
 * Parse git diff --numstat -z output (F16 NUL-safe contract, spec §44).
 * Records are NUL-separated triples:
 *   <added>\t<deleted>\t<path>\0  (binary files use "-\t-\t<path>")
 *
 * Path identity comes ONLY from NUL framing: with -z git never C-quotes or
 * mangles paths, so space/quote/tab/newline/Unicode/leading-dash names all
 * round-trip byte-exact. The numstat invocation MUST NOT contain any flag
 * that (re-)enables patch output (--unified, -U, -p/--patch, --format with
 * patch semantics): on Git 2.55 such a flag appends the full patch after the
 * stats records. A record that is not a well-formed triple (e.g. a patch
 * tail leaking into the stream) fails closed: it is never misread as a stat.
 */
export function parseNumstatZ(stdout: Buffer): ParsedDiff {
  const files: GitDiffFileStat[] = [];
  const raw = stdout.toString("utf8").split("\0").filter((p) => p.length > 0);
  let truncated = false;
  for (const record of raw) {
    const tab = record.split("\t");
    if (tab.length < 3) throw new Error("unparseable numstat record");
    const [addedRaw = "", deletedRaw = ""] = tab;
    const filePath = tab.slice(2).join("\t");
    assertRelativePath(filePath);
    if (files.length >= MAX_DIFF_FILES) {
      truncated = true;
      break;
    }
    const added = addedRaw === "-" ? 0 : Number.parseInt(addedRaw, 10);
    const deleted = deletedRaw === "-" ? 0 : Number.parseInt(deletedRaw, 10);
    files.push({
      path: filePath,
      added_lines: Number.isSafeInteger(added) && added >= 0 ? added : 0,
      deleted_lines: Number.isSafeInteger(deleted) && deleted >= 0 ? deleted : 0,
    });
  }
  return { files, truncated };
}

/** Bound a patch whole: oversized patches are omitted, never cut mid-hunk. */
export function boundPatch(patch: string, maxChars: number = MAX_PATCH_CHARS): { patch: string | null; available: boolean; truncated: boolean } {
  if (patch.length === 0) return { patch: null, available: false, truncated: false };
  if (patch.length > maxChars) return { patch: null, available: true, truncated: true };
  return { patch, available: true, truncated: false };
}

/** Fixed deterministic diff flags shared by every patch command. */
export function deterministicDiffFlags(): string[] {
  return [
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--unified=3",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ];
}

/**
 * Numstat-only flags: deterministicDiffFlags() minus --unified. The unified
 * context setting implies patch output on Git 2.55, which appends the full
 * patch after --numstat -z records. The numstat invocation stays patch-free
 * so NUL framing delimits stats only. Numstat runs never need hunk context.
 */
export function deterministicNumstatFlags(): string[] {
  return deterministicDiffFlags().filter((f) => !f.startsWith("--unified"));
}
