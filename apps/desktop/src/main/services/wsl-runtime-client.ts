/**
 * WSL runtime manager + thin WSL specialization of the stdio runtime client.
 *
 * Transport ownership (NDJSON framing, pending requests, handshake,
 * shutdown) lives in the platform-neutral StdioRuntimeClient. This module
 * only supplies the Windows/WSL launch behavior: distro, wsl.exe argv
 * construction, and WSL-specific spawn error text.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { StdioRuntimeClient } from '../runtime/stdio-runtime-client.js';
import type {
  RuntimeClient,
  RuntimeHello,
  RuntimeProcessLauncher,
  RuntimeStatus,
} from '../runtime/runtime-client.js';

export type { RuntimeClient, RuntimeHello, RuntimeStatus };
export type { RuntimeProcessLauncher };

export interface WslDistroInfo {
  readonly name: string;
  readonly state: string;
  readonly version: number;
}

export interface WslRuntimeClientOptions {
  readonly distro: string;
  readonly runtimeEntry: string;
  readonly dataRoot?: string;
  /** Test seam: override child creation (production always spawns wsl.exe). */
  readonly launcher?: RuntimeProcessLauncher;
}

/**
 * Argv for 'wsl.exe -d <distro> -- node <runtimeEntry> --stdio'
 * plus '--data-root <linux path>' when configured. Argv-based invocation
 * only — no shell, no string-built commands. Secrets travel via
 * runtime.configure AFTER the handshake — never argv.
 */
export function buildWslArgs(distro: string, runtimeEntry: string, dataRoot?: string): string[] {
  if (dataRoot === undefined) {
    return ['-d', distro, '--', 'node', runtimeEntry, '--stdio'];
  }
  return ['-d', distro, '--', 'node', runtimeEntry, '--stdio', '--data-root', dataRoot];
}

/** Thin Windows/WSL specialization: distro launch over the shared transport. */
export class WslRuntimeClient implements RuntimeClient {
  private readonly inner: StdioRuntimeClient;
  private readonly distro: string;

  constructor(options: WslRuntimeClientOptions) {
    this.distro = options.distro;
    const entry = options.runtimeEntry;
    const dataRoot = options.dataRoot;
    const distro = options.distro;
    const launcher =
      options.launcher ??
      ((): ChildProcess => {
        return spawn('wsl.exe', buildWslArgs(distro, entry, dataRoot), {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      });
    this.inner = new StdioRuntimeClient({
      launch: launcher,
      spawnErrorPrefix: 'wsl.exe spawn failed: ',
      offlineMessage: 'WSL runtime unavailable',
      electronGuardMessage: 'Runtime runs under Electron — WSL boundary violated',
    });
  }

  onNotification(handler: (event: string, payload: unknown) => void): void {
    this.inner.onNotification(handler);
  }

  onExit(handler: (code: number | null) => void): void {
    this.inner.onExit(handler);
  }

  get status(): RuntimeStatus {
    const base = this.inner.status;
    return {
      connected: base.connected,
      distro: this.distro,
      hello: base.hello,
      lastError: base.lastError,
      hostPlatform: 'windows',
      executionMode: 'wsl2',
    };
  }

  get stderrDiagnostics(): readonly string[] {
    return this.inner.stderrDiagnostics;
  }

  /** Spawn the runtime and complete the handshake. Rejects on timeout/mismatch. */
  start(): Promise<RuntimeHello> {
    return this.inner.start();
  }

  /** Graceful shutdown; falls back to kill after a bounded wait. */
  stop(): Promise<void> {
    return this.inner.stop();
  }

  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.inner.request(method, params, timeoutMs);
  }
}

export interface WslManagerOptions {
  readonly userDataDir?: string;
  readonly preferencesFile?: string;
}

/** Detects wsl.exe + distros, persists the selected distro preference. */
export class WslRuntimeManager {
  private readonly preferencesFile: string | undefined;

  constructor(options: WslManagerOptions = {}) {
    this.preferencesFile =
      options.preferencesFile ??
      (options.userDataDir === undefined
        ? undefined
        : // Never a directory named preferences: collides with Chromium's
          // Preferences file on case-insensitive filesystems (see
          // provider-credentials).
          join(options.userDataDir, 'sentry-prefs', 'wsl-runtime.json'));
  }

  async wslAvailable(): Promise<boolean> {
    try {
      const result = spawnSync('wsl.exe', ['--status'], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 15000,
      });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  async listDistros(): Promise<WslDistroInfo[]> {
    const result = spawnSync('wsl.exe', ['--list', '--verbose'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
    });
    if (result.status !== 0)
      throw Object.assign(new Error('wsl.exe --list failed'), { code: 'WSL_UNAVAILABLE' });
    const text = String(result.stdout ?? '');
    const distros: WslDistroInfo[] = [];
    for (const line of text.split('\n')) {
      const cleaned = line
        .replace(/\0/g, '')
        .trim()
        .replace(/^\*\s*/, '');
      if (/^NAME\s+STATE/i.test(cleaned)) continue;
      const match =
        /^(\S(?:.*?\S)?)\s+(Running|Stopped|Installing|Uninstalling|Converting)\s+(\d+)\s*$/.exec(
          cleaned,
        );
      if (match?.[1] !== undefined) {
        distros.push({
          name: match[1].trim(),
          state: match[2] ?? 'Unknown',
          version: Number(match[3] ?? '2'),
        });
      }
    }
    return distros;
  }

  /**
   * Probe whether a distro can host the runtime: node must resolve on the
   * direct-exec path (no login shell). Never selects utility distros such as
   * docker-desktop, which lack node and a Sentry home.
   */
  async distroReady(name: string): Promise<boolean> {
    try {
      const result = spawnSync('wsl.exe', ['-d', name, '--', 'node', '--version'], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 20000,
      });
      return result.status === 0 && /^v\d+/.test(String(result.stdout ?? '').trim());
    } catch {
      return false;
    }
  }

  async defaultDistro(): Promise<string | undefined> {
    const distros = await this.listDistros().catch(() => []);
    const usable = distros.filter((d) => d.version === 2 && !/^docker-desktop/i.test(d.name));
    // Prefer Ubuntu by name, then any running usable distro, then first usable.
    const named =
      usable.find((d) => d.name.toLowerCase() === 'ubuntu') ??
      usable.find((d) => d.state === 'Running') ??
      usable[0];
    if (named !== undefined && (await this.distroReady(named.name))) return named.name;
    for (const candidate of usable) {
      if (candidate.name !== named?.name && (await this.distroReady(candidate.name))) {
        return candidate.name;
      }
    }
    return named?.name;
  }

  async loadPreferredDistro(): Promise<string | undefined> {
    if (this.preferencesFile === undefined) return undefined;
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(this.preferencesFile, 'utf8');
      const parsed = JSON.parse(raw) as { wslDistro?: unknown };
      return typeof parsed.wslDistro === 'string' && parsed.wslDistro.length > 0
        ? parsed.wslDistro
        : undefined;
    } catch {
      return undefined;
    }
  }

  async savePreferredDistro(distro: string): Promise<void> {
    if (this.preferencesFile === undefined) return;
    const { mkdir, writeFile, rename } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(this.preferencesFile), { recursive: true });
    const tmp = this.preferencesFile + '.tmp-' + String(process.pid) + '-' + String(Date.now());
    await writeFile(tmp, JSON.stringify({ version: 1, wslDistro: distro }, null, 2) + '\n');
    await rename(tmp, this.preferencesFile);
  }

  /**
   * Resolve: stored preference (validated node-capable) else default.
   * A stored distro that lost node (or vanished) falls through to default
   * instead of failing closed on a stale preference.
   */
  async resolveDistro(preferred?: string): Promise<string> {
    const stored = preferred ?? (await this.loadPreferredDistro());
    const distros = await this.listDistros();
    const usable = distros.filter((d) => d.version === 2);
    if (usable.length === 0) {
      throw Object.assign(new Error('No usable WSL2 distro found'), { code: 'WSL_NO_DISTRO' });
    }
    if (stored !== undefined) {
      const match = usable.find((d) => d.name === stored);
      if (match !== undefined && (await this.distroReady(match.name))) return match.name;
    }
    const fallback = await this.defaultDistro();
    if (fallback === undefined)
      throw Object.assign(new Error('No usable WSL2 distro found'), { code: 'WSL_NO_DISTRO' });
    return fallback;
  }
}

/** Resolve the distro user's $HOME via wslpath (for runtime entry location). */
export function wslHomeDir(distro: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('wsl.exe', ['-d', distro, '--', 'sh', '-c', 'printf %s "$HOME"'], {
      windowsHide: true,
    });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error('wsl home probe timed out'), { code: 'WSL_PATH_TIMEOUT' }));
    }, 15000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(
        Object.assign(new Error('wsl home probe failed: ' + error.message.slice(0, 200)), {
          code: 'WSL_PATH_FAILED',
        }),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const home = stdout.trim();
      if (code !== 0 || home.length === 0 || !home.startsWith('/')) {
        reject(
          Object.assign(new Error('wsl home probe returned no Linux home'), {
            code: 'WSL_PATH_FAILED',
          }),
        );
        return;
      }
      resolve(home);
    });
  });
}

/**
 * wsl.exe re-parses argv after `--` with backslash-escape semantics, so a
 * native `C:\...` path arrives mangled (`C:Users...`). Forward slashes
 * survive intact and wslpath accepts them identically.
 */
export function toWslPathArg(windowsPath: string): string {
  return windowsPath.replaceAll('\\', '/');
}

export function translateWindowsPathForWsl(windowsPath: string, distro: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const forwardSlashed = toWslPathArg(windowsPath);
    const child = spawn('wsl.exe', ['-d', distro, '--', 'wslpath', '-u', forwardSlashed], {
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error('wslpath timed out'), { code: 'WSL_PATH_TIMEOUT' }));
    }, 15000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(
        Object.assign(new Error('wslpath failed: ' + error.message.slice(0, 200)), {
          code: 'WSL_PATH_FAILED',
        }),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          Object.assign(new Error('wslpath failed: ' + stderr.slice(0, 200)), {
            code: 'WSL_PATH_FAILED',
          }),
        );
        return;
      }
      const translated = stdout.trim();
      if (translated.length === 0 || !translated.startsWith('/')) {
        reject(
          Object.assign(new Error('wslpath returned no Linux path'), { code: 'WSL_PATH_FAILED' }),
        );
        return;
      }
      resolve(translated);
    });
  });
}
