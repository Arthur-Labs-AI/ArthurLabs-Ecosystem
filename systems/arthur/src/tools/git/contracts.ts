/**
 * SC-05 Git read-only intelligence contracts (spec sections 45-88).
 *
 * Model-facing shapes only. No executable, argv, shell, cwd, env, or
 * physical path ever appears here: the model selects a trusted repo_id
 * plus bounded semantic parameters; ARTHUR derives the fixed Git argv.
 */

export type GitDiffScope = "unstaged" | "staged" | "working_tree" | "commits";

export interface GitStatusBranch {
  name: string | null;
  detached: boolean;
  unborn: boolean;
  head_oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface GitStatusFileEntry {
  path: string;
  index_status: string;
  worktree_status: string;
  old_path?: string;
}

export interface GitStatusResult {
  repository: string;
  branch: GitStatusBranch;
  clean: boolean;
  staged: GitStatusFileEntry[];
  unstaged: GitStatusFileEntry[];
  untracked: string[];
  conflicted: string[];
  truncated: boolean;
  observed_at: string;
  shallow: boolean;
  history_complete: boolean;
  operation_state: GitOperationState;
}

export interface GitOperationState {
  merge_in_progress: boolean;
  rebase_in_progress: boolean;
  cherry_pick_in_progress: boolean;
  revert_in_progress: boolean;
}

export interface GitDiffFileStat {
  path: string;
  added_lines: number;
  deleted_lines: number;
  old_path?: string;
}

export interface GitDiffResult {
  repository: string;
  scope: GitDiffScope;
  base_oid: string | null;
  target_oid: string | null;
  files: GitDiffFileStat[];
  patch_available: boolean;
  patch_truncated: boolean;
  patch: string | null;
  truncated: boolean;
  observed_at: string;
}

export interface GitLogCommit {
  oid: string;
  short_oid: string;
  parents: string[];
  author_name: string;
  authored_at: string;
  committed_at: string;
  subject: string;
}

export interface GitLogResult {
  repository: string;
  ref: string;
  resolved_oid: string | null;
  commits: GitLogCommit[];
  truncated: boolean;
  history_complete: boolean;
  observed_at: string;
}

export interface GitBranchEntry {
  name: string;
  oid: string;
  upstream: string | null;
}

export interface GitBranchesResult {
  repository: string;
  current: string | null;
  detached: boolean;
  local: GitBranchEntry[];
  remote_tracking: GitBranchEntry[];
  truncated: boolean;
  observed_at: string;
}

export interface GitShowResult {
  repository: string;
  ref: string;
  oid: string;
  parents: string[];
  author_name: string;
  authored_at: string;
  committed_at: string;
  subject: string;
  body: string;
  body_truncated: boolean;
  files: GitDiffFileStat[];
  patch_available: boolean;
  patch_truncated: boolean;
  patch: string | null;
  observed_at: string;
}

export interface GitRepositoriesResult {
  repositories: Array<{ id: string; label: string; available: boolean }>;
}
