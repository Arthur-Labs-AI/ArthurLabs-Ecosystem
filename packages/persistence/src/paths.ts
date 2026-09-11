import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { AgentRunId, ProjectId, QARunId } from '@qa/shared';

export interface ProjectDataPaths {
  readonly root: string;
  readonly workingCopy: string;
  readonly staging: string;
  readonly revisions: string;
  readonly context: string;
  readonly runs: string;
}

export interface RunDataPaths {
  readonly root: string;
  readonly snapshot: string;
  readonly events: string;
  readonly activities: string;
  readonly artifacts: string;
  readonly exports: string;
  readonly agents: string;
}

export function projectDataPaths(dataRoot: string, projectId: ProjectId): ProjectDataPaths {
  const root = resolve(dataRoot, 'projects', projectId);
  return {
    root,
    workingCopy: resolve(root, 'working-copy'),
    staging: resolve(root, 'staging'),
    revisions: resolve(root, 'revisions'),
    context: resolve(root, 'context'),
    runs: resolve(root, 'runs'),
  };
}

export function runDataPaths(dataRoot: string, projectId: ProjectId, runId: QARunId): RunDataPaths {
  const root = resolve(projectDataPaths(dataRoot, projectId).runs, runId);
  return {
    root,
    snapshot: resolve(root, 'snapshot'),
    events: resolve(root, 'events'),
    activities: resolve(root, 'activities'),
    artifacts: resolve(root, 'artifacts'),
    exports: resolve(root, 'exports'),
    agents: resolve(root, 'agents'),
  };
}

export function agentWorkspacePath(
  dataRoot: string,
  projectId: ProjectId,
  runId: QARunId,
  agentRunId: AgentRunId,
): string {
  return resolve(runDataPaths(dataRoot, projectId, runId).agents, agentRunId, 'workspace');
}

function comparisonPath(value: string): string {
  const normalized = resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

export async function canonicalizePath(value: string): Promise<string> {
  const resolved = resolve(value);
  try {
    return await realpath(resolved);
  } catch {
    try {
      const parent = await realpath(dirname(resolved));
      return resolve(parent, resolved.slice(dirname(resolved).length + 1));
    } catch {
      return resolved;
    }
  }
}

export async function assertNoPathOverlap(source: string, destinationRoot: string): Promise<void> {
  const canonicalSource = comparisonPath(await canonicalizePath(source));
  const canonicalDestination = comparisonPath(await canonicalizePath(destinationRoot));
  if (
    isPathInside(canonicalSource, canonicalDestination) ||
    isPathInside(canonicalDestination, canonicalSource)
  ) {
    throw new Error(
      'PROJECT_PATH_OVERLAP: source and Sentry destination must not contain each other',
    );
  }
}

export function resolveInside(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  if (!isPathInside(comparisonPath(root), comparisonPath(target))) {
    throw new Error('PATH_ESCAPE: path resolves outside Sentry data root');
  }
  return target;
}
