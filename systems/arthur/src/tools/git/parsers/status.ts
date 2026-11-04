/**
 * SC-05 porcelain v2 status parser (spec sections 44-51, F15-F16).
 *
 * Parses: git status --porcelain=v2 -z --branch --untracked-files=normal
 * NUL-separated machine format. Handles branch headers (# branch.*),
 * ordinary changed entries (1 <XY> ...), renames/copies (2 ...), and
 * untracked items (? path). Paths stay repository-relative; absolute
 * paths are rejected. Rename entries expose old_path + path.
 */

import type { GitOperationState, GitStatusBranch, GitStatusFileEntry } from "../contracts";

export interface ParsedStatus {
  branch: GitStatusBranch;
  staged: GitStatusFileEntry[];
  unstaged: GitStatusFileEntry[];
  untracked: string[];
  conflicted: string[];
  truncated: boolean;
  operationState: GitOperationState;
}

export const MAX_STATUS_ENTRIES = 500;

function emptyBranch(): GitStatusBranch {
  return { name: null, detached: false, unborn: false, head_oid: null, upstream: null, ahead: 0, behind: 0 };
}

function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function assertRelativePath(p: string): void {
  if (p.length === 0 || p.length > 4096) throw new Error("status path out of bounds");
  if (p.includes("\0")) throw new Error("status path contains NUL");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p) || p.startsWith("\\")) throw new Error("status path is not repository-relative");
}

/** Split a NUL-separated buffer into records (binary-safe, no coercion loss). */
export function splitNulRecords(stdout: Buffer): string[] {
  const parts = stdout.toString("utf8").split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.filter((p) => p.length > 0);
}

export function parsePorcelainV2(records: string[], operationState: GitOperationState): ParsedStatus {
  const branch = emptyBranch();
  const staged: GitStatusFileEntry[] = [];
  const unstaged: GitStatusFileEntry[] = [];
  const untracked: string[] = [];
  const conflicted: string[] = [];
  let entryCount = 0;
  let truncated = false;

  const pushEntry = (list: GitStatusFileEntry[], entry: GitStatusFileEntry): void => {
    entryCount += 1;
    if (entryCount > MAX_STATUS_ENTRIES) {
      truncated = true;
      return;
    }
    list.push(entry);
  };
  const pushSimple = (list: string[], value: string): void => {
    entryCount += 1;
    if (entryCount > MAX_STATUS_ENTRIES) {
      truncated = true;
      return;
    }
    list.push(value);
  };

  for (const record of records) {
    if (record.startsWith("# branch.oid ")) {
      const oid = record.slice("# branch.oid ".length).trim();
      if (oid !== "(initial)") {
        if (!isOid(oid)) throw new Error("invalid branch oid in status output");
        branch.head_oid = oid;
      } else {
        branch.unborn = true;
      }
      continue;
    }
    if (record.startsWith("# branch.head ")) {
      const head = record.slice("# branch.head ".length).trim();
      if (head === "(detached)") {
        branch.detached = true;
        branch.name = null;
      } else if (head === "(unknown)" || head === "(initial)") {
        branch.unborn = branch.unborn || head === "(initial)";
        branch.name = null;
      } else {
        branch.name = head;
      }
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      const upstream = record.slice("# branch.upstream ".length).trim();
      branch.upstream = upstream.length > 0 ? upstream : null;
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const rest = record.slice("# branch.ab ".length).trim();
      const ahead = /^\+([0-9]+) -([0-9]+)$/.exec(rest);
      if (ahead) {
        branch.ahead = Number.parseInt(ahead[1] ?? "0", 10);
        branch.behind = Number.parseInt(ahead[2] ?? "0", 10);
      }
      continue;
    }
    if (record.startsWith("# ")) continue;
    if (record.startsWith("? ")) {
      const p = record.slice(2);
      assertRelativePath(p);
      pushSimple(untracked, p);
      continue;
    }
    if (record.startsWith("u ")) {
      // Unmerged (conflicted) entry: u <XY> <subm> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = record.slice(2).split(" ");
      const p = parts[parts.length - 1] ?? "";
      assertRelativePath(p);
      pushSimple(conflicted, p);
      continue;
    }
    if (record.startsWith("1 ")) {
      // 1 <XY> <subm> <mH> <mI> <mW> <hH> <hI> <path>
      const m = /^1 ([.?ABCDMNRSTU]{2}) [^ ]+ [0-9]+ [0-9]+ [0-9]+ [0-9a-f]+ [0-9a-f]+ (.+)$/.exec(record);
      if (!m) throw new Error("unparseable status v2 entry");
      const xy = m[1] ?? "";
      const p = m[2] ?? "";
      assertRelativePath(p);
      const x = xy[0] ?? ".";
      const y = xy[1] ?? ".";
      if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
        pushSimple(conflicted, p);
        continue;
      }
      if (x !== "." && x !== "?") pushEntry(staged, { path: p, index_status: x, worktree_status: y });
      if (y !== "." && y !== "?") pushEntry(unstaged, { path: p, index_status: x, worktree_status: y });
      continue;
    }
    if (record.startsWith("2 ")) {
      // 2 <XY> <subm> <mH> <mI> <mW> <hH> <hI> <X><score> <path><TAB><origPath>
      const tab = record.indexOf("\t");
      if (tab < 0) throw new Error("unparseable rename entry");
      const head = record.slice(0, tab);
      const tail = record.slice(tab + 1);
      const sep = tail.indexOf("\t");
      // Porcelain v2 rename layout: "<path>\t<origPath>" after the header;
      // some versions emit an extra field, so take first/last segments.
      const headMatch = /^2 ([.?ABCDMNRSTU]{2}) /.exec(head);
      if (!headMatch) throw new Error("unparseable rename entry");
      const xy = headMatch[1] ?? "";
      const segments = tail.split("\t").filter((s) => s.length > 0);
      const newPath = segments[0] ?? "";
      const oldPath = segments[segments.length - 1] ?? "";
      assertRelativePath(newPath);
      assertRelativePath(oldPath);
      const entry: GitStatusFileEntry = { path: newPath, old_path: oldPath, index_status: xy[0] ?? ".", worktree_status: xy[1] ?? "." };
      const x = xy[0] ?? ".";
      const y = xy[1] ?? ".";
      if (x !== "." && x !== "?") pushEntry(staged, entry);
      if (y !== "." && y !== "?") pushEntry(unstaged, { ...entry });
      continue;
    }
    throw new Error("unparseable status v2 record: " + record.slice(0, 32));
  }

  return { branch, staged, unstaged, untracked, conflicted, truncated, operationState };
}

/** Derive operation state from trusted .git marker files (no content read). */
export function operationStateFromMarkers(exists: (name: string) => boolean): GitOperationState {
  return {
    merge_in_progress: exists("MERGE_HEAD"),
    rebase_in_progress: exists("rebase-merge") || exists("rebase-apply"),
    cherry_pick_in_progress: exists("CHERRY_PICK_HEAD"),
    revert_in_progress: exists("REVERT_HEAD"),
  };
}
