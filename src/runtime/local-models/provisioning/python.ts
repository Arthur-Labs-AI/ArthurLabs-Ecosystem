/**
 * HR-02.5D2: managed Python runtime provisioning.
 *
 * One reusable abstraction for all future model installers (Parakeet,
 * OmniVoice, BgTTS) so venv logic is never reinvented per model:
 *   discoverSystemPython() -> checkVersionSpec() -> ensureEnvironment()
 *   (python -m venv under runtimes/python/<runtime-id>/) ->
 *   installPinnedPackages() (argv-only pip, code-owned specs).
 *
 * Boundaries:
 * - the developer's active .venv / global Python is NEVER reused as the
 *   managed runtime; a system interpreter only bootstraps a venv that
 *   ARTHUR owns under the managed root (containment-checked).
 * - version policy is a caller-supplied spec ({minVersion,
 *   maxVersionExclusive}), never a hardcoded model version here.
 * - package specs are code-owned pinned names (+ optional code-owned
 *   index URL); arbitrary pip args from users/metadata are impossible by
 *   construction (the type carries only names + indexUrl).
 * - no real installs happen in D2 tests: the runner is injected and
 *   fakes assert argv shape. ARM64 discovery works (status reporting),
 *   but no package compatibility is claimed for it here.
 * - D2 never calls HR-02.5C state mutations and never touches
 *   routers/controllers/providers.
 */

import * as path from 'node:path';

import { ArthurError } from '../../../core/errors/errors';
import { assertInsideRoot } from './paths';
import { describeRun, runTrustedProcess, type RunResult, type SpawnFn } from './process_runner';
import type { PythonDiscovery, PythonEnvironment } from './contracts';

export interface PythonRuntimeSpec {
  minVersion?: string;
  maxVersionExclusive?: string;
}

export interface PinnedPackageSet {
  packages: string[];
  indexUrl?: string;
}

const PACKAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_\.\-]{0,63}(==[A-Za-z0-9][A-Za-z0-9_\.\-\+]{0,63})?$/;

function parseVersion(text: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function checkVersionSpec(version: string, spec: PythonRuntimeSpec): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  if (spec.minVersion) {
    const min = parseVersion(spec.minVersion);
    if (!min || compareVersions(parsed, min) < 0) return false;
  }
  if (spec.maxVersionExclusive) {
    const max = parseVersion(spec.maxVersionExclusive);
    if (!max || compareVersions(parsed, max) >= 0) return false;
  }
  return true;
}

function exeCandidates(): string[] {
  // Windows prefers the `py -3` launcher; POSIX uses python3 then python.
  if (process.platform === 'win32') return ['py', 'python'];
  return ['python3', 'python'];
}

// Deterministic interpreter discovery: tries trusted candidate names via
// the injected runner and classifies found / not_found /
// unsupported_version. Never downloads Python itself.
export async function discoverSystemPython(
  run: (exe: string, args: readonly string[]) => Promise<RunResult>,
  spec: PythonRuntimeSpec = {},
): Promise<PythonDiscovery> {
  const tried: string[] = [];
  for (const exe of exeCandidates()) {
    const args = exe === 'py' ? ['-3', '--version'] : ['--version'];
    let result: RunResult;
    try {
      result = await run(exe, args);
    } catch {
      tried.push(exe);
      continue;
    }
    if (result.exit_code !== 0) {
      tried.push(exe);
      continue;
    }
    const text = (result.stdout + ' ' + result.stderr).trim();
    const parsed = parseVersion(text);
    if (!parsed) {
      tried.push(exe);
      continue;
    }
    const version = parsed.join('.');
    if (!checkVersionSpec(version, spec)) {
      return { status: 'unsupported_version', executable: exe, version, reason: 'python ' + version + ' does not satisfy the runtime spec' };
    }
    return { status: 'found', executable: exe, version };
  }
  return { status: 'not_found', reason: 'no usable python interpreter on PATH (tried ' + tried.join(', ') + ')' };
}

export function environmentPython(root: string, runtimeDir: string): string {
  const inside = assertInsideRoot(root, runtimeDir, 'runtime dir');
  const rel = process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python');
  return assertInsideRoot(root, path.join(inside, rel), 'environment python');
}

export interface VenvFs {
  exists(path: string): boolean;
}

export function nodeVenvFs(): VenvFs {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  return {
    exists(p: string): boolean {
      try {
        fs.accessSync(p);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export interface EnsureEnvironmentArgs {
  root: string;
  runtimeDir: string;
  systemPython: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fs?: VenvFs;
  run: SpawnFn;
}

// Create (or reuse, when already present) the managed venv. Returns the
// environment handle with the deterministically resolved interpreter.
export async function ensureEnvironment(args: EnsureEnvironmentArgs): Promise<PythonEnvironment> {
  const runtimeDir = assertInsideRoot(args.root, args.runtimeDir, 'runtime dir');
  if (typeof args.systemPython !== 'string' || args.systemPython.trim() === '' || args.systemPython.includes('\0')) {
    throw new ArthurError('INVALID_CONFIG', 'system python must be a trusted executable path');
  }
  const fs = args.fs ?? nodeVenvFs();
  if (!fs.exists(runtimeDir)) {
    const created = await runTrustedProcess(args.run, {
      executable: args.systemPython,
      args: ['-m', 'venv', runtimeDir],
      timeoutMs: args.timeoutMs ?? 300000,
      signal: args.signal,
    });
    if (created.exit_code !== 0 || created.aborted || created.timed_out) {
      throw new ArthurError('TOOL_EXECUTION_FAILED', 'venv creation failed: ' + describeRun(args.systemPython, created));
    }
  }
  const pythonExe = environmentPython(args.root, runtimeDir);
  return { runtime_id: path.basename(runtimeDir), root: runtimeDir, python_executable: pythonExe, version: 'managed' };
}

export interface InstallPackagesArgs {
  env: PythonEnvironment;
  packages: PinnedPackageSet;
  timeoutMs?: number;
  signal?: AbortSignal;
  run: SpawnFn;
}

// argv-only pinned package install. `packages` + optional `indexUrl` are
// code-owned; arbitrary pip flags are not representable in the type.
// Defense in depth (pip parses argv flags even with shell=false): any
// entry starting with `-`, empty entries, and anything outside the pinned
// `name` / `name==version` shape is rejected BEFORE argv construction.
export async function installPinnedPackages(args: InstallPackagesArgs): Promise<{ installed: string[]; log_tail: string }> {
  if (args.packages.packages.length === 0) {
    throw new ArthurError('INVALID_CONFIG', 'package set must not be empty');
  }
  for (const pkg of args.packages.packages) {
    if (typeof pkg !== 'string' || pkg.trim() === '') {
      throw new ArthurError('INVALID_CONFIG', 'refusing empty package spec');
    }
    if (pkg.startsWith('-')) {
      throw new ArthurError('INVALID_CONFIG', 'refusing pip option injection through package list: ' + JSON.stringify(pkg.slice(0, 64)));
    }
    if (!PACKAGE_PATTERN.test(pkg)) {
      throw new ArthurError('INVALID_CONFIG', 'refusing unpinned or malformed package spec ' + JSON.stringify(pkg));
    }
  }
  let indexUrl = '';
  if (args.packages.indexUrl !== undefined) {
    if (!/^https:\/\/[^\s]+$/.test(args.packages.indexUrl)) {
      throw new ArthurError('INVALID_CONFIG', 'package index must be an https url');
    }
    indexUrl = args.packages.indexUrl;
  }
  const argv: string[] = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input'];
  if (indexUrl !== '') argv.push('--index-url', indexUrl);
  for (const pkg of args.packages.packages) argv.push(pkg);
  const result = await runTrustedProcess(args.run, {
    executable: args.env.python_executable,
    args: argv,
    timeoutMs: args.timeoutMs ?? 600000,
    signal: args.signal,
  });
  if (result.exit_code !== 0 || result.aborted || result.timed_out) {
    throw new ArthurError('TOOL_EXECUTION_FAILED', 'package install failed: ' + describeRun(args.env.python_executable, result));
  }
  return { installed: [...args.packages.packages], log_tail: result.stdout.slice(-2000) + result.stderr.slice(-2000) };
}
