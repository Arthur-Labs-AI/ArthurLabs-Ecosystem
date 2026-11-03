import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TOOLCHAIN_PACKS,
  toolchainDir,
  toolchainEnvironment,
  toolchainPack,
  toolchainsRoot,
  type ToolchainPackId,
  type ToolchainSetup,
} from '@qa/shared';

const INSTALL_TIMEOUT_MS = 30 * 60_000;
const LOG_TAIL_CHARS = 2000;
const MARKER = '.installed.json';

export interface ScriptResult {
  readonly code: number;
  readonly output: string;
}
/** Runs one bash script with the given environment; injectable so tests never touch the network. */
export type ScriptRunner = (
  script: string,
  options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
) => Promise<ScriptResult>;

export const bashRunner: ScriptRunner = (script, { cwd, env }) =>
  new Promise((resolve) => {
    const child = spawn('bash', ['-c', 'set -euo pipefail\n' + script], {
      cwd,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: process.env['HOME'] ?? '/', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-LOG_TAIL_CHARS);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), INSTALL_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 127, output: String(error.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });

export interface GoRelease {
  readonly version: string;
  readonly stable: boolean;
  readonly files: ReadonlyArray<{
    readonly filename: string;
    readonly os: string;
    readonly arch: string;
    readonly kind: string;
    readonly sha256: string;
  }>;
}

async function fetchGoReleases(): Promise<GoRelease[]> {
  const response = await fetch('https://go.dev/dl/?mode=json&include=all');
  if (!response.ok) throw new Error('go.dev release list returned ' + response.status);
  return (await response.json()) as GoRelease[];
}

/** The newest stable patch release of a Go minor version, as a linux archive for this machine. */
export function pickGoArchive(
  releases: readonly GoRelease[],
  minor: string,
  arch: string,
): { filename: string; sha256: string } | undefined {
  const goArch = arch === 'aarch64' || arch === 'arm64' ? 'arm64' : 'amd64';
  for (const release of releases) {
    if (!release.stable) continue;
    if (release.version !== 'go' + minor && !release.version.startsWith('go' + minor + '.')) continue;
    const file = release.files.find(
      (candidate) =>
        candidate.os === 'linux' && candidate.arch === goArch && candidate.kind === 'archive',
    );
    if (file !== undefined) return { filename: file.filename, sha256: file.sha256 };
  }
  return undefined;
}

const PYTHON_SCRIPT = `
mkdir -p bin python tmp
ARCH=$(uname -m)
ASSET="uv-\${ARCH}-unknown-linux-gnu.tar.gz"
BASE="https://github.com/astral-sh/uv/releases/latest/download"
curl -fsSL --retry 3 -o "tmp/$ASSET" "$BASE/$ASSET"
curl -fsSL --retry 3 -o "tmp/$ASSET.sha256" "$BASE/$ASSET.sha256"
(cd tmp && sha256sum -c "$ASSET.sha256")
tar -xzf "tmp/$ASSET" --strip-components=1 -C bin
rm -rf tmp
export UV_PYTHON_INSTALL_DIR="$SENTRY_TC_DIR/python" UV_PYTHON_BIN_DIR="$SENTRY_TC_DIR/bin" UV_PYTHON_PREFERENCE=only-managed
bin/uv python install "$SENTRY_TC_VERSION"
PY=$(bin/uv python find "$SENTRY_TC_VERSION")
ln -sf "$PY" bin/python3
ln -sf python3 bin/python
`;

const DOTNET_SCRIPT = `
curl -fsSL --retry 3 -o dotnet-install.sh https://dot.net/v1/dotnet-install.sh
bash dotnet-install.sh --channel "$SENTRY_TC_VERSION" --install-dir "$SENTRY_TC_DIR/dotnet" --no-path
rm -f dotnet-install.sh
`;

const RUST_SCRIPT = `
curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o rustup-init.sh https://sh.rustup.rs
export RUSTUP_HOME="$SENTRY_TC_DIR/rustup" CARGO_HOME="$SENTRY_TC_DIR/cargo"
sh rustup-init.sh -y --no-modify-path --profile minimal --default-toolchain "$SENTRY_TC_VERSION"
rm -f rustup-init.sh
`;

const GO_SCRIPT = `
curl -fsSL --retry 3 -o go.tar.gz "https://go.dev/dl/$SENTRY_GO_FILE"
echo "$SENTRY_GO_SHA  go.tar.gz" | sha256sum -c -
tar -xzf go.tar.gz
rm -f go.tar.gz
`;

const JAVA_SCRIPT = `
case "$(uname -m)" in aarch64|arm64) A=aarch64 ;; *) A=x64 ;; esac
curl -fsSL --retry 3 -L -o jdk.tar.gz "https://api.adoptium.net/v3/binary/latest/$SENTRY_TC_VERSION/ga/linux/$A/jdk/hotspot/normal/eclipse"
mkdir -p jdk && tar -xzf jdk.tar.gz --strip-components=1 -C jdk && rm -f jdk.tar.gz
MAVEN=3.9.9
BASE="https://archive.apache.org/dist/maven/maven-3/$MAVEN/binaries/apache-maven-$MAVEN-bin.tar.gz"
curl -fsSL --retry 3 -o maven.tar.gz "$BASE"
curl -fsSL --retry 3 -o maven.tar.gz.sha512 "$BASE.sha512"
echo "$(cut -d' ' -f1 maven.tar.gz.sha512)  maven.tar.gz" | sha512sum -c -
mkdir -p maven && tar -xzf maven.tar.gz --strip-components=1 -C maven
rm -f maven.tar.gz maven.tar.gz.sha512
`;

export interface InstalledToolchain {
  readonly packId: ToolchainPackId;
  readonly version: string;
  readonly installedAt: string;
}

export interface ToolchainVersionStatus {
  readonly version: string;
  readonly installed: boolean;
  readonly installing: boolean;
  readonly sizeMb?: number;
  readonly error?: string;
}

export interface ToolchainPackStatus {
  readonly id: ToolchainPackId;
  readonly label: string;
  readonly description: string;
  readonly approxSizeMb: number;
  readonly defaultVersion: string;
  readonly note?: string;
  readonly versions: readonly ToolchainVersionStatus[];
}

function duMegabytes(dir: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile('du', ['-sk', dir], (error, stdout) => {
      const kilobytes = Number.parseInt(stdout.split('\t')[0] ?? '', 10);
      resolve(error !== null || Number.isNaN(kilobytes) ? undefined : Math.round(kilobytes / 1024));
    });
  });
}

/**
 * Installs, lists and removes the optional language toolchains. Downloads run on the
 * host with its network, never inside an agent sandbox; each version is its own folder
 * and only counts as installed once its marker file is written.
 */
export class ToolchainManager {
  private readonly installing = new Map<string, Promise<void>>();
  private readonly errors = new Map<string, string>();

  constructor(
    private readonly dataRoot: string,
    private readonly runner: ScriptRunner = bashRunner,
    private readonly goReleases: () => Promise<GoRelease[]> = fetchGoReleases,
  ) {}

  private key(id: ToolchainPackId, version: string): string {
    return id + '@' + version;
  }

  async installed(): Promise<InstalledToolchain[]> {
    const found: InstalledToolchain[] = [];
    for (const pack of TOOLCHAIN_PACKS) {
      for (const version of pack.versions) {
        try {
          const marker = JSON.parse(
            await readFile(join(toolchainDir(this.dataRoot, pack.id, version), MARKER), 'utf8'),
          ) as { installedAt?: string };
          found.push({ packId: pack.id, version, installedAt: marker.installedAt ?? '' });
        } catch {
          /* not installed */
        }
      }
    }
    return found;
  }

  async status(): Promise<ToolchainPackStatus[]> {
    const installed = new Set((await this.installed()).map((item) => this.key(item.packId, item.version)));
    return Promise.all(
      TOOLCHAIN_PACKS.map(async (pack) => ({
        id: pack.id,
        label: pack.label,
        description: pack.description,
        approxSizeMb: pack.approxSizeMb,
        defaultVersion: pack.defaultVersion,
        ...(pack.note === undefined ? {} : { note: pack.note }),
        versions: await Promise.all(
          pack.versions.map(async (version) => {
            const key = this.key(pack.id, version);
            const isInstalled = installed.has(key);
            const sizeMb = isInstalled
              ? await duMegabytes(toolchainDir(this.dataRoot, pack.id, version))
              : undefined;
            const error = this.errors.get(key);
            return {
              version,
              installed: isInstalled,
              installing: this.installing.has(key),
              ...(sizeMb === undefined ? {} : { sizeMb }),
              ...(error === undefined ? {} : { error }),
            };
          }),
        ),
      })),
    );
  }

  /** Starts an install and returns at once; poll status() for the outcome. */
  install(packId: string, version: string): { started: boolean } {
    const pack = toolchainPack(packId);
    if (pack === undefined) throw new Error('Unknown toolchain: ' + packId);
    if (!pack.versions.includes(version)) throw new Error('Unknown ' + pack.label + ' version: ' + version);
    const key = this.key(pack.id, version);
    if (this.installing.has(key)) return { started: false };
    this.errors.delete(key);
    const work = this.runInstall(pack.id, version)
      .catch((error: unknown) => {
        this.errors.set(key, (error instanceof Error ? error.message : String(error)).slice(-LOG_TAIL_CHARS));
      })
      .finally(() => this.installing.delete(key));
    this.installing.set(key, work);
    return { started: true };
  }

  /** Resolves when every running install has finished (used by tests and shutdown). */
  async settled(): Promise<void> {
    await Promise.all([...this.installing.values()]);
  }

  private async runInstall(id: ToolchainPackId, version: string): Promise<void> {
    const dir = toolchainDir(this.dataRoot, id, version);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const env: Record<string, string> = { SENTRY_TC_DIR: dir, SENTRY_TC_VERSION: version };
    let script: string;
    switch (id) {
      case 'python':
        script = PYTHON_SCRIPT;
        break;
      case 'dotnet':
        script = DOTNET_SCRIPT;
        break;
      case 'rust':
        script = RUST_SCRIPT;
        break;
      case 'java':
        script = JAVA_SCRIPT;
        break;
      case 'go': {
        const archive = pickGoArchive(await this.goReleases(), version, process.arch === 'arm64' ? 'arm64' : 'x86_64');
        if (archive === undefined) throw new Error('No Go ' + version + ' release found for this machine.');
        env['SENTRY_GO_FILE'] = archive.filename;
        env['SENTRY_GO_SHA'] = archive.sha256;
        script = GO_SCRIPT;
        break;
      }
    }
    const result = await this.runner(script, { cwd: dir, env });
    if (result.code !== 0) {
      await rm(dir, { recursive: true, force: true });
      throw new Error('Install failed (exit ' + result.code + '): ' + result.output.trim());
    }
    await writeFile(
      join(dir, MARKER),
      JSON.stringify({ packId: id, version, installedAt: new Date().toISOString() }),
      'utf8',
    );
  }

  async remove(packId: string, version: string): Promise<void> {
    const pack = toolchainPack(packId);
    if (pack === undefined || !pack.versions.includes(version))
      throw new Error('Unknown toolchain version: ' + packId + ' ' + version);
    if (this.installing.has(this.key(pack.id, version))) throw new Error('That install is still running.');
    await rm(toolchainDir(this.dataRoot, pack.id, version), { recursive: true, force: true });
    this.errors.delete(this.key(pack.id, version));
  }

  /** What an agent shell needs to use the installed toolchains, or undefined when none are installed. */
  async setup(): Promise<ToolchainSetup | undefined> {
    const { path, env } = await this.environment();
    return path.length === 0 ? undefined : { binds: [toolchainsRoot(this.dataRoot)], path, env };
  }

  /** PATH folders and variables for the installed toolchains, newest version of each pack first. */
  async environment(): Promise<{ path: string[]; env: Record<string, string> }> {
    const path: string[] = [];
    const env: Record<string, string> = {};
    const installed = await this.installed();
    for (const pack of TOOLCHAIN_PACKS) {
      const first = installed.find((item) => item.packId === pack.id);
      if (first === undefined) continue;
      const setup = toolchainEnvironment(pack.id, toolchainDir(this.dataRoot, pack.id, first.version));
      path.push(...setup.path);
      Object.assign(env, setup.env);
    }
    return { path, env };
  }
}
