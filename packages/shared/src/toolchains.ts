import { join, resolve } from 'node:path';

/**
 * Optional language toolchains installed by the host (never by agent code) into a
 * Sentry-managed folder. Every (pack, version) is a self-contained directory:
 * `<dataRoot>/toolchains/<pack>/<version>/` with its programs under `bin/`.
 */
export const TOOLCHAIN_PACK_IDS = ['python', 'dotnet', 'rust', 'go', 'java'] as const;
export type ToolchainPackId = (typeof TOOLCHAIN_PACK_IDS)[number];

export interface ToolchainPackInfo {
  readonly id: ToolchainPackId;
  readonly label: string;
  readonly description: string;
  readonly versions: readonly string[];
  readonly defaultVersion: string;
  /** Rough installed size per version, so the page can show what a click costs. */
  readonly approxSizeMb: number;
  readonly note?: string;
}

export const TOOLCHAIN_PACKS: readonly ToolchainPackInfo[] = [
  {
    id: 'python',
    label: 'Python',
    description: 'uv (package manager) and a Python interpreter.',
    versions: ['3.13', '3.12', '3.11', '3.10', '3.9'],
    defaultVersion: '3.12',
    approxSizeMb: 90,
  },
  {
    id: 'dotnet',
    label: 'C# / .NET',
    description: 'The .NET SDK (compiler, runtime, NuGet restore).',
    versions: ['9.0', '8.0', '6.0'],
    defaultVersion: '8.0',
    approxSizeMb: 450,
    note: 'Linux only: Windows desktop workloads (WPF, WinForms) cannot be built or run.',
  },
  {
    id: 'rust',
    label: 'Rust',
    description: 'rustup with cargo and rustc.',
    versions: ['stable', 'beta', 'nightly'],
    defaultVersion: 'stable',
    approxSizeMb: 400,
    note: 'Building needs a C linker (cc) on the machine.',
  },
  {
    id: 'go',
    label: 'Go',
    description: 'The Go toolchain.',
    versions: ['1.24', '1.23', '1.22', '1.21'],
    defaultVersion: '1.24',
    approxSizeMb: 250,
  },
  {
    id: 'java',
    label: 'Java / Kotlin',
    description: 'An Eclipse Temurin JDK and Apache Maven. Gradle projects bring their own wrapper.',
    versions: ['21', '17', '11', '8'],
    defaultVersion: '21',
    approxSizeMb: 450,
  },
];

export function toolchainPack(id: string): ToolchainPackInfo | undefined {
  return TOOLCHAIN_PACKS.find((pack) => pack.id === id);
}

export function toolchainsRoot(dataRoot: string): string {
  return resolve(dataRoot, 'toolchains');
}

/** Directory of one installed (pack, version); both parts are validated by the caller's pack list. */
export function toolchainDir(dataRoot: string, id: ToolchainPackId, version: string): string {
  return join(toolchainsRoot(dataRoot), id, version);
}

/** Folders to add to PATH and variables to set for one installed toolchain. */
export function toolchainEnvironment(
  id: ToolchainPackId,
  dir: string,
): { readonly path: readonly string[]; readonly env: Readonly<Record<string, string>> } {
  switch (id) {
    case 'python':
      // No UV_PYTHON_INSTALL_DIR: the mount is read-only and uv writes a lock there. uv finds the
      // interpreter through the python3 link in bin/ and keeps what it downloads in the run's home.
      return { path: [join(dir, 'bin')], env: {} };
    case 'dotnet':
      return {
        path: [join(dir, 'dotnet')],
        env: {
          DOTNET_ROOT: join(dir, 'dotnet'),
          DOTNET_CLI_TELEMETRY_OPTOUT: '1',
          DOTNET_NOLOGO: '1',
          DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1',
          // A project pinned to a runtime that is not installed still runs on a newer one.
          DOTNET_ROLL_FORWARD: 'Major',
          // Build servers (MSBuild nodes, the Roslyn compiler server) would outlive the command and
          // keep its output pipe open, so the shell tool waits until its timeout and records no exit code.
          MSBUILDDISABLENODEREUSE: '1',
          UseSharedCompilation: 'false',
        },
      };
    case 'rust':
      return {
        path: [join(dir, 'cargo', 'bin')],
        env: { RUSTUP_HOME: join(dir, 'rustup'), CARGO_HOME: join(dir, 'cargo') },
      };
    case 'go':
      return { path: [join(dir, 'go', 'bin')], env: { GOROOT: join(dir, 'go'), GOTOOLCHAIN: 'local' } };
    case 'java':
      return {
        path: [join(dir, 'jdk', 'bin'), join(dir, 'maven', 'bin')],
        env: { JAVA_HOME: join(dir, 'jdk') },
      };
  }
}

/** What a run needs to see the installed toolchains: folders to mount read-only, PATH and variables. */
export interface ToolchainSetup {
  readonly binds: readonly string[];
  readonly path: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}
