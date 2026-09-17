/** Phase 7 private-beta doctors (§51–§54, §56–§60).
 *
 *  Read-only inspection with truthful availability reporting: unavailable
 *  providers, runtimes, and sandboxes are reported as unavailable — never
 *  faked, never silently substituted. No secrets are persisted or printed;
 *  error paths use the bounded redaction in errors.ts.
 */
import { access, constants, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  projectDataPaths,
  resolveSentryConfig,
  inspectStorageHealth,
  cleanupOrphans,
} from '@qa/persistence';
import type { SentryRepository } from '@qa/persistence';
import { createOperationId } from '@qa/shared';
import { ProjectManager } from '@qa/project-manager';

const ECOSYSTEM_MARKERS: Readonly<Record<string, string>> = {
  'package.json': 'node',
  'package-lock.json': 'node',
  'pnpm-lock.yaml': 'node',
  'yarn.lock': 'node',
  'bun.lockb': 'node',
  'deno.json': 'deno',
  'requirements.txt': 'python',
  'pyproject.toml': 'python',
  'setup.py': 'python',
  'Cargo.toml': 'rust',
  'go.mod': 'go',
  'pom.xml': 'java',
  'build.gradle': 'java',
  'build.gradle.kts': 'java',
  'composer.json': 'php',
  Gemfile: 'ruby',
};

const DOTNET_EXTENSIONS = new Set(['.sln', '.slnx', '.csproj', '.fsproj', '.vbproj']);

const RUNTIME_BINARIES: Readonly<Record<string, readonly string[]>> = {
  node: ['node'],
  deno: ['deno'],
  python: ['python', 'python3'],
  rust: ['cargo'],
  go: ['go'],
  java: ['java'],
  php: ['php'],
  ruby: ['ruby'],
  dotnet: ['dotnet'],
};

async function detectEcosystem(workingCopy: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(workingCopy);
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const name of names) {
    const marker = ECOSYSTEM_MARKERS[name];
    if (marker !== undefined) found.add(marker);
    const dot = name.lastIndexOf('.');
    if (dot >= 0 && DOTNET_EXTENSIONS.has(name.slice(dot).toLowerCase())) found.add('dotnet');
  }
  return [...found].sort();
}

async function binaryOnPath(names: readonly string[]): Promise<boolean> {
  const pathValue = process.env['PATH'] ?? '';
  const directories = pathValue.split(process.platform === 'win32' ? ';' : ':');
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of directories) {
    if (directory.length === 0) continue;
    for (const name of names) {
      for (const suffix of suffixes) {
        try {
          await access(join(directory, name + suffix), constants.X_OK);
          return true;
        } catch {
          // Keep scanning PATH entries.
        }
      }
    }
  }
  return false;
}

export async function projectDoctor(input: {
  readonly dataRoot: string;
  readonly repository: SentryRepository;
  readonly projectId: string;
}): Promise<{
  projectId: string;
  ready: boolean;
  managedCopyState: string;
  currentRevisionId?: string;
  revisionCount: number;
  runCount: number;
  issueCount: number;
  detectedEcosystem: string[];
  runtimes: { name: string; available: boolean }[];
  verifier: { sandboxAvailable: boolean; runtimeReplaySupported: boolean; reason?: string };
  warnings: string[];
}> {
  const projects = new ProjectManager(input.dataRoot, input.repository);
  const record = projects.getProject(input.projectId as never);
  if (record === undefined) throw new Error('PROJECT_NOT_FOUND: ' + input.projectId);
  const warnings: string[] = [];
  const workingCopy = projectDataPaths(input.dataRoot, record.project.id).workingCopy;
  const ecosystem = await detectEcosystem(workingCopy);
  if (ecosystem.length === 0) warnings.push('No known ecosystem markers at the working-copy root.');
  const runtimes: { name: string; available: boolean }[] = [{ name: 'node', available: true }];
  for (const system of ecosystem) {
    if (system === 'node') continue;
    const binaries = RUNTIME_BINARIES[system];
    if (binaries === undefined) continue;
    runtimes.push({ name: system, available: await binaryOnPath(binaries) });
  }
  for (const runtime of runtimes) {
    if (!runtime.available)
      warnings.push('Detected ecosystem ' + runtime.name + ' has no runtime on PATH.');
  }
  const { SystemdSandboxBackend } = await import('@qa/verifier');
  const { verifierStagingParent } = await import('@qa/run-engine');
  const { mkdir } = await import('node:fs/promises');
  const probeParent = verifierStagingParent(input.dataRoot);
  await mkdir(probeParent, { recursive: true });
  const availability = await new SystemdSandboxBackend().preflight(probeParent);
  if (!availability.available) {
    warnings.push(
      'Verifier sandbox unavailable: ' +
        (availability.reason ?? 'unknown reason') +
        '. Verification stays inconclusive.',
    );
  }
  if (record.managedCopy.state !== 'ready') {
    warnings.push('Managed copy is ' + record.managedCopy.state + ', not ready.');
  }
  return {
    projectId: record.project.id,
    ready: record.managedCopy.state === 'ready' && availability.available,
    managedCopyState: record.managedCopy.state,
    currentRevisionId: record.revision.id,
    revisionCount: input.repository.listRevisions(record.project.id).length,
    runCount: input.repository.countProjectRuns(record.project.id),
    issueCount: input.repository.listIssues(record.project.id).length,
    detectedEcosystem: ecosystem,
    runtimes,
    verifier: {
      sandboxAvailable: availability.available,
      runtimeReplaySupported: availability.available,
      ...(availability.reason === undefined ? {} : { reason: availability.reason }),
    },
    warnings,
  };
}

export async function storageReport(input: {
  readonly dataRoot: string;
  readonly repository: SentryRepository;
}) {
  const { verifierStagingParent } = await import('@qa/run-engine');
  return inspectStorageHealth(
    input.dataRoot,
    input.repository,
    verifierStagingParent(input.dataRoot),
    {},
  );
}

export async function cleanupReport(
  input: { readonly dataRoot: string; readonly repository: SentryRepository },
  options: { apply: boolean },
) {
  const { verifierStagingParent } = await import('@qa/run-engine');
  const stagingParent = verifierStagingParent(input.dataRoot);
  const health = await inspectStorageHealth(input.dataRoot, input.repository, stagingParent, {});
  const operationId = createOperationId();
  if (!options.apply) {
    return {
      applied: false as const,
      operationId,
      orphans: health.orphans.map((orphan) => ({ ...orphan, removed: false as const })),
    };
  }
  const audits = await cleanupOrphans(input.dataRoot, stagingParent, health.orphans, {
    operationId,
  });
  return {
    applied: true as const,
    operationId,
    orphans: audits.map((audit) => ({
      pathClass: audit.pathClass,
      path: audit.path,
      ageMs: audit.ageMs,
      reason: audit.reason,
      removed: audit.removed,
      ...(audit.detail === undefined ? {} : { detail: audit.detail }),
    })),
  };
}

export function configReport(dataRoot: string) {
  const config = resolveSentryConfig({ dataRoot });
  return {
    dataRoot: config.dataRoot,
    cliContractVersion: 1 as const,
    defaultAgents: [...config.defaultAgents],
    runTimeoutMs: config.productionRunTimeoutMs,
    simulationTimeoutMs: config.simulationRunTimeoutMs,
    verificationCommandTimeoutMs: config.verificationCommandTimeoutMs,
    orphanMinAgeMs: config.orphanMinAgeMs,
    sandboxBackend: config.sandboxBackend,
    supportedPlatforms: [...config.supportedPlatforms],
  };
}
