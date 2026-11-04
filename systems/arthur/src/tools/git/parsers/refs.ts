/**
 * SC-05 branch enumeration parser (spec sections 69-73, F36).
 *
 * Machine plumbing only: git for-each-ref --format=<unit-sep fields>
 * over refs/heads and refs/remotes. Never parses human git branch output.
 * Remote-tracking refs are local cached refs (no network query, F73).
 */

import type { GitBranchEntry } from "../contracts";

export const MAX_BRANCH_REFS = 200;
const FIELD_SEP = "\x1f";

export interface ParsedBranches {
  local: GitBranchEntry[];
  remote_tracking: GitBranchEntry[];
  truncated: boolean;
}

/** Parse one for-each-ref line: refname<US>objectname<US>upstream. */
export function parseForEachRefLine(line: string): { refname: string; oid: string; upstream: string } {
  const parts = line.split(FIELD_SEP);
  if (parts.length !== 3) throw new Error("unparseable ref line");
  const [refname = "", oid = "", upstream = ""] = parts;
  if (!refname.startsWith("refs/heads/") && !refname.startsWith("refs/remotes/")) {
    throw new Error("unexpected ref namespace");
  }
  if (!/^[0-9a-f]{40}$/.test(oid.trim())) throw new Error("invalid ref oid");
  return { refname, oid: oid.trim(), upstream: upstream.trim() };
}

export function parseBranches(headLines: string[], remoteLines: string[]): ParsedBranches {
  const local: GitBranchEntry[] = [];
  const remote_tracking: GitBranchEntry[] = [];
  let truncated = false;
  const push = (list: GitBranchEntry[], entry: GitBranchEntry): void => {
    if (local.length + remote_tracking.length >= MAX_BRANCH_REFS) {
      truncated = true;
      return;
    }
    list.push(entry);
  };
  for (const line of headLines) {
    if (line.trim().length === 0) continue;
    const parsed = parseForEachRefLine(line);
    if (!parsed.refname.startsWith("refs/heads/")) throw new Error("unexpected ref namespace");
    push(local, { name: parsed.refname.slice("refs/heads/".length), oid: parsed.oid, upstream: parsed.upstream.length > 0 ? parsed.upstream : null });
  }
  for (const line of remoteLines) {
    if (line.trim().length === 0) continue;
    const parsed = parseForEachRefLine(line);
    if (!parsed.refname.startsWith("refs/remotes/")) throw new Error("unexpected ref namespace");
    push(remote_tracking, { name: parsed.refname.slice("refs/remotes/".length), oid: parsed.oid, upstream: null });
  }
  return { local, remote_tracking, truncated };
}

/** for-each-ref --format value (unit-separator fields, sorted). */
export function forEachRefFormat(): string {
  return "%(refname)" + FIELD_SEP + "%(objectname)" + FIELD_SEP + "%(upstream:short)";
}
