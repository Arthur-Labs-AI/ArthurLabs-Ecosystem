import { createReadStream } from 'node:fs';
import { extname } from 'node:path';
import {
  createProjectContextSnapshotId,
  nowIsoTimestamp,
  type ProjectId,
  type ProjectRevisionId,
} from '@qa/shared';
import {
  ProjectContextSnapshotSchema,
  type Artifact,
  type ProjectContextSnapshot,
} from '@qa/schemas';
import {
  FilesystemArtifactStore,
  projectDataPaths,
  type SentryRepository,
  walkTree,
} from '@qa/persistence';

export interface ContextMaterial {
  readonly relativePath: string;
  readonly kind: 'documentation' | 'configuration' | 'source' | 'test' | 'other';
  readonly sizeBytes: number;
  readonly textual: boolean;
  readonly relevanceHint?: string;
}

export interface BuildContextInput {
  readonly projectId: ProjectId;
  readonly projectRevisionId: ProjectRevisionId;
  readonly workingCopyPath: string;
  readonly signal?: AbortSignal;
}

export interface PreparedProjectContext {
  readonly context: ProjectContextSnapshot;
  readonly materialArtifact: Artifact;
}

const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.go',
  '.gradle',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.md',
  '.mjs',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.cs': 'C#',
  '.go': 'Go',
  '.java': 'Java',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
};

function classify(relativePath: string): ContextMaterial['kind'] {
  const lower = relativePath.toLowerCase();
  if (lower.startsWith('docs/') || /(^|\/)readme[^/]*$/.test(lower) || lower === 'agents.md') {
    return 'documentation';
  }
  if (/(^|\/)(test|tests|spec|specs)(\/|$)/.test(lower) || /\.(test|spec)\.[^.]+$/.test(lower)) {
    return 'test';
  }
  if (
    /package\.json$|pyproject\.toml$|cargo\.toml$|go\.mod$|\.sln$|\.csproj$|dockerfile|\.ya?ml$/.test(
      lower,
    )
  ) {
    return 'configuration';
  }
  return TEXT_EXTENSIONS.has(extname(lower)) ? 'source' : 'other';
}

async function readTextPrefix(path: string, maximumBytes = 262_144): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  const input = createReadStream(path, { highWaterMark: 32 * 1024 });
  try {
    for await (const raw of input) {
      const chunk = raw as Buffer;
      const remaining = maximumBytes - length;
      if (remaining <= 0) break;
      chunks.push(chunk.subarray(0, remaining));
      length += Math.min(chunk.length, remaining);
      if (length >= maximumBytes) break;
    }
  } finally {
    input.destroy();
  }
  return Buffer.concat(chunks, length)
    .toString('utf8')
    .replace(/^\uFEFF/, '');
}

function firstParagraph(markdown: string): string | undefined {
  const cleaned = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('!['));
  const first = cleaned[0];
  return first === undefined ? undefined : first.slice(0, 1000);
}

export class ProjectContextBuilder {
  private readonly artifacts: FilesystemArtifactStore;

  constructor(
    private readonly dataRoot: string,
    private readonly repository: SentryRepository,
  ) {
    this.artifacts = new FilesystemArtifactStore(dataRoot, repository);
  }

  async build(input: BuildContextInput): Promise<ProjectContextSnapshot> {
    const prepared = await this.prepare(input);
    try {
      this.repository.transaction(() => {
        this.artifacts.persist(prepared.materialArtifact);
        this.repository.saveContext(
          prepared.context,
          prepared.materialArtifact.relativeStoragePath,
        );
      });
      return prepared.context;
    } catch (cause) {
      await this.artifacts.discard(prepared.materialArtifact).catch(() => undefined);
      throw cause;
    }
  }

  async prepare(input: BuildContextInput): Promise<PreparedProjectContext> {
    const id = createProjectContextSnapshotId();
    const languages = new Set<string>();
    const frameworks = new Set<string>();
    const packageManagers = new Set<string>();
    const testFrameworks = new Set<string>();
    const sources: Array<{ kind: 'configuration' | 'documentation'; relativePath: string }> = [];
    let purpose: string | undefined;

    const materials = (async function* (): AsyncGenerator<string> {
      for await (const entry of walkTree(input.workingCopyPath, input.signal)) {
        if (entry.type !== 'file') continue;
        const extension = extname(entry.relativePath).toLowerCase();
        const language = LANGUAGE_BY_EXTENSION[extension];
        if (language !== undefined) languages.add(language);
        const kind = classify(entry.relativePath);
        const textual =
          TEXT_EXTENSIONS.has(extension) || kind === 'documentation' || kind === 'configuration';
        const lower = entry.relativePath.toLowerCase();
        if (lower.endsWith('package.json')) {
          packageManagers.add('npm-compatible');
          sources.push({ kind: 'configuration', relativePath: entry.relativePath });
          if (entry.sizeBytes <= 1_048_576) {
            try {
              const pkg = JSON.parse(await readTextPrefix(entry.absolutePath, 1_048_576)) as {
                dependencies?: Record<string, unknown>;
                devDependencies?: Record<string, unknown>;
              };
              const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
              if ('react' in dependencies) frameworks.add('React');
              if ('vue' in dependencies) frameworks.add('Vue');
              if ('@angular/core' in dependencies) frameworks.add('Angular');
              if ('vitest' in dependencies) testFrameworks.add('Vitest');
              if ('jest' in dependencies) testFrameworks.add('Jest');
            } catch {
              // The material remains indexed; malformed project metadata is not invented or coerced.
            }
          }
        } else if (lower.endsWith('pyproject.toml') || /requirements[^/]*\.txt$/.test(lower)) {
          packageManagers.add('pip');
          sources.push({ kind: 'configuration', relativePath: entry.relativePath });
        } else if (lower.endsWith('cargo.toml')) packageManagers.add('cargo');
        else if (lower.endsWith('go.mod')) packageManagers.add('go modules');
        else if (lower.endsWith('pom.xml')) packageManagers.add('Maven');
        else if (lower.endsWith('.csproj') || lower.endsWith('.sln')) packageManagers.add('NuGet');

        if (purpose === undefined && /(^|\/)readme[^/]*$/.test(lower) && textual) {
          purpose = firstParagraph(await readTextPrefix(entry.absolutePath));
          sources.push({ kind: 'documentation', relativePath: entry.relativePath });
        }
        const material: ContextMaterial = {
          relativePath: entry.relativePath,
          kind,
          sizeBytes: entry.sizeBytes,
          textual,
          ...(kind === 'documentation' || kind === 'configuration'
            ? { relevanceHint: 'high' }
            : {}),
        };
        yield JSON.stringify(material) + '\n';
      }
    })();

    const indexPath =
      projectDataPaths(this.dataRoot, input.projectId).context + '/' + id + '.materials.ndjson';
    const relativePath = indexPath
      .slice(this.dataRoot.length)
      .replace(/^[\\/]+/, '')
      .replaceAll('\\', '/');
    const artifact = await this.artifacts.write({
      relativePath,
      type: 'json',
      source: materials,
      projectId: input.projectId,
      mimeType: 'application/x-ndjson',
      persistMetadata: false,
    });
    const context = ProjectContextSnapshotSchema.parse({
      schemaVersion: 1,
      id,
      projectId: input.projectId,
      projectRevisionId: input.projectRevisionId,
      ...(purpose === undefined ? {} : { purpose }),
      criticalFlows: [],
      businessRules: [],
      constraints: [],
      knownLimitations: [],
      outOfScope: [],
      detectedStack: {
        languages: [...languages].sort(),
        frameworks: [...frameworks].sort(),
        packageManagers: [...packageManagers].sort(),
        testFrameworks: [...testFrameworks].sort(),
        sources,
      },
      createdAt: nowIsoTimestamp(),
    });
    return { context, materialArtifact: artifact };
  }

  persist(prepared: PreparedProjectContext): void {
    this.artifacts.persist(prepared.materialArtifact);
    this.repository.saveContext(prepared.context, prepared.materialArtifact.relativeStoragePath);
  }

  discard(prepared: PreparedProjectContext): Promise<void> {
    return this.artifacts.discard(prepared.materialArtifact);
  }
}
