import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chooseVersion, readPinFiles, toolchainHints } from '../src/toolchain-pins.js';
import { ToolchainManager, type ScriptRunner } from '../src/toolchains.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
const temp = async (): Promise<string> => {
  const value = await mkdtemp(join(tmpdir(), 'sentry-pins-'));
  roots.push(value);
  return value;
};

describe('toolchain hints', () => {
  it('reads .NET from global.json first, else the highest target framework', () => {
    expect(
      toolchainHints([
        { name: 'global.json', text: '{ "sdk": { "version": "6.0.402" } }' },
        { name: 'App.csproj', text: '<TargetFramework>net8.0</TargetFramework>' },
      ]).dotnet,
    ).toBe('6.0');
    expect(
      toolchainHints([
        { name: 'A.csproj', text: '<TargetFramework>net6.0</TargetFramework>' },
        { name: 'B.csproj', text: '<TargetFrameworks>netstandard2.0;net8.0</TargetFrameworks>' },
      ]).dotnet,
    ).toBe('8.0');
    expect(toolchainHints([{ name: 'A.csproj', text: '<TargetFramework>netstandard2.0</TargetFramework>' }]).dotnet).toBeUndefined();
  });

  it('reads Python, Go, Rust and Java pins', () => {
    const hints = toolchainHints([
      { name: '.python-version', text: '3.11.4\n' },
      { name: 'go.mod', text: 'module x\n\ngo 1.22.3\n' },
      { name: 'rust-toolchain.toml', text: '[toolchain]\nchannel = "nightly-2024-01-01"\n' },
      { name: 'pom.xml', text: '<properties><maven.compiler.release>17</maven.compiler.release></properties>' },
    ]);
    expect(hints).toEqual({ python: '3.11', go: '1.22', rust: 'nightly', java: '17' });
    expect(toolchainHints([{ name: '.java-version', text: '1.8' }]).java).toBe('8');
    expect(toolchainHints([])).toEqual({});
  });

  it('uses the hinted version when installed, otherwise the newest', () => {
    expect(chooseVersion(['9.0', '8.0', '6.0'], '8.0')).toBe('8.0');
    expect(chooseVersion(['9.0', '8.0'], '7.0')).toBe('9.0');
    expect(chooseVersion(['9.0'], undefined)).toBe('9.0');
    expect(chooseVersion([], '8.0')).toBeUndefined();
  });

  it('finds pin files a few folders deep and skips build and dependency folders', async () => {
    const workspace = await temp();
    await mkdir(join(workspace, 'project', 'App', 'App'), { recursive: true });
    await mkdir(join(workspace, 'project', 'node_modules', 'x'), { recursive: true });
    await writeFile(join(workspace, 'project', 'App', 'App', 'App.csproj'), '<TargetFramework>net8.0</TargetFramework>');
    await writeFile(join(workspace, 'project', 'node_modules', 'x', 'go.mod'), 'go 1.10');
    const files = await readPinFiles(workspace);
    expect(files.map((f) => f.name)).toEqual(['App.csproj']);
  });

  it('puts the project pinned version on PATH for the shell', async () => {
    const dataRoot = await temp();
    const runner: ScriptRunner = async (_script, { cwd }) => {
      await writeFile(join(cwd, 'tool'), 'x');
      return { code: 0, output: '' };
    };
    const manager = new ToolchainManager(dataRoot, runner);
    manager.install('dotnet', '9.0');
    manager.install('dotnet', '8.0');
    await manager.settled();
    const workspace = await temp();
    await writeFile(join(workspace, 'App.csproj'), '<TargetFramework>net8.0</TargetFramework>');
    const pinned = await manager.environment(workspace);
    expect(pinned.env['DOTNET_ROOT']).toContain(join('dotnet', '8.0'));
    expect(pinned.env['DOTNET_ROLL_FORWARD']).toBe('Major');
    const unpinned = await manager.environment(await temp());
    expect(unpinned.env['DOTNET_ROOT']).toContain(join('dotnet', '9.0'));
  });
});
