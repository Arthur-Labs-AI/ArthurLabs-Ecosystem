/**
 * WSL runtime manager + typed RPC client (Electron main).
 *
 * Owns one long-lived `wsl.exe -d <distro> -- node <runtimeEntry> --stdio`
 * process. Argv-based invocation only — no shell, no string-built commands.
 * stdout is protocol NDJSON (validated); stderr is bounded diagnostics.
 * Secrets travel via runtime.configure AFTER the handshake — never argv.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  RUNTIME_PROTOCOL_VERSION,
  RpcLineBuffer,
  encodeRpcLine,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
} from '@qa/runtime-protocol';

export interface WslDistroInfo {
  readonly name: string;
  readonly state: string;
  readonly version: number;
}

export interface RuntimeHello {
  readonly protocolVersion: number;
  readonly runtimeVersion: string;
  readonly platform: string;
  readonly isWsl: boolean;
  readonly nodeVersion: string;
  readonly processExecPath: string;
  readonly distro?: string;
  readonly dataRoot: string;
}

export interface RuntimeStatus {
  readonly connected: boolean;
  readonly distro: string | undefined;
  readonly hello: RuntimeHello | undefined;
  readonly lastError: string | undefined;
}

const REQUEST_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 120_000;
/**
 * Methods whose legitimate work scales with project size (full tree copy +
 * content scan: a 60k-file project takes minutes) get a long window; every
 * other method stays at 60 s. The runtime itself has no arbitrary deadline
 * (poll-until-settled), so these windows only bound truly hung transports.
 */
const ROW_CREATION_TIMEOUT_MS = 600_000;
const ROW_CREATION_METHODS: ReadonlySet<string> = new Set([
  'runs.start',
  'retests.start',
  'projects.add',
  'projects.update',
]);

function nextId(prefix: string): string {
  return prefix + '_' + Date.now().toString(36) + Math.floor(Math.random() * 0xffffff).toString(36);
}

export class WslRuntimeClient {
  private child: ChildProcess | undefined;
  private readonly buffer = new RpcLineBuffer();
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private notificationHandler: ((event: string, payload: unknown) => void) | undefined;
  private exitHandler: ((code: number | null) => void) | undefined;
  private stderrTail: string[] = [];
  private hello: RuntimeHello | undefined;
  private lastError: string | undefined;
  private readonly distro: string;
  private readonly entry: string;
  private readonly dataRootOverride: string | undefined;

  constructor(options: { distro: string; runtimeEntry: string; dataRoot?: string }) {
    this.distro = options.distro;
    this.entry = options.runtimeEntry;
    this.dataRootOverride = options.dataRoot;
  }

  onNotification(handler: (event: string, payload: unknown) => void): void {
    this.notificationHandler = handler;
  }

  onExit(handler: (code: number | null) => void): void {
    this.exitHandler = handler;
  }

  get status(): RuntimeStatus {
    return {
      connected: this.child !== undefined && this.hello !== undefined,
      distro: this.distro,
      hello: this.hello,
      lastError: this.lastError,
    };
  }

  get stderrDiagnostics(): readonly string[] {
    return this.stderrTail;
  }

  /** Spawn the runtime and complete the handshake. Rejects on timeout/mismatch. */
  async start(): Promise<RuntimeHello> {
    if (this.child !== undefined) {
      if (this.hello !== undefined) return this.hello;
      throw Object.assign(new Error('Runtime is starting'), { code: 'RUNTIME_STARTING' });
    }
    const args =
      this.dataRootOverride === undefined
        ? ['-d', this.distro, '--', 'node', this.entry, '--stdio']
        : [
            '-d',
            this.distro,
            '--',
            'node',
            this.entry,
            '--stdio',
            '--data-root',
            this.dataRootOverride,
          ];
    const child = spawn('wsl.exe', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        this.stderrTail.push(trimmed.slice(0, 500));
        if (this.stderrTail.length > 50) this.stderrTail.shift();
      }
    });
    child.on('error', (error: Error) => {
      this.lastError = 'wsl.exe spawn failed: ' + error.message.slice(0, 300);
      this.failAllPending(new Error(this.lastError));
      this.child = undefined;
      this.exitHandler?.(null);
    });
    child.on('exit', (code) => {
      if (this.hello === undefined && this.lastError === undefined) {
        this.lastError = 'Runtime exited before handshake (code ' + String(code) + ')';
      }
      this.failAllPending(new Error(this.lastError ?? 'Runtime exited'));
      this.child = undefined;
      this.hello = undefined;
      this.exitHandler?.(code);
    });
    try {
      const hello = (await this.request('runtime.hello', {}, START_TIMEOUT_MS)) as RuntimeHello;
      if (hello.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
        throw Object.assign(
          new Error(
            'Runtime protocol mismatch: got ' +
              String(hello.protocolVersion) +
              ', want ' +
              String(RUNTIME_PROTOCOL_VERSION),
          ),
          { code: 'RUNTIME_PROTOCOL_MISMATCH' },
        );
      }
      if (hello.platform !== 'linux') {
        throw Object.assign(new Error('Runtime is not Linux: ' + hello.platform), {
          code: 'RUNTIME_NOT_LINUX',
        });
      }
      if (
        typeof hello.processExecPath === 'string' &&
        hello.processExecPath.toLowerCase().endsWith('electron.exe')
      ) {
        throw Object.assign(new Error('Runtime runs under Electron — WSL boundary violated'), {
          code: 'RUNTIME_UNDER_ELECTRON',
        });
      }
      this.hello = hello;
      this.lastError = undefined;
      return hello;
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  /** Graceful shutdown; falls back to kill after a bounded wait. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.hello = undefined;
    this.failAllPending(new Error('Runtime stopped'));
    if (child === undefined) return;
    try {
      child.stdin?.write(
        JSON.stringify({
          type: 'request',
          id: nextId('rpc'),
          method: 'runtime.shutdown',
          params: {},
        }) + '\n',
      );
    } catch {
      // transport already broken
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = ROW_CREATION_METHODS.has(method) ? ROW_CREATION_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const child = this.child;
    if (child === undefined || child.stdin === undefined) {
      return Promise.reject(
        Object.assign(new Error('WSL runtime unavailable'), { code: 'RUNTIME_OFFLINE' }),
      );
    }
    const id = nextId('rpc');
    const message: RpcRequest = { type: 'request', id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          Object.assign(new Error('Runtime request timed out: ' + method), {
            code: 'RUNTIME_TIMEOUT',
          }),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin?.write(encodeRpcLine(message as never));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onStdout(text: string): void {
    let messages: ReturnType<RpcLineBuffer['push']>;
    try {
      messages = this.buffer.push(text);
    } catch {
      return;
    }
    for (const message of messages) {
      if (message.type === 'response') {
        const entry = this.pending.get((message as RpcResponse).id);
        if (entry === undefined) continue;
        this.pending.delete((message as RpcResponse).id);
        clearTimeout(entry.timer);
        const response = message as RpcResponse;
        if (response.ok) entry.resolve(response.result);
        else {
          entry.reject(
            Object.assign(new Error(response.error?.message ?? 'Runtime error'), {
              code: response.error?.code ?? 'RUNTIME_ERROR',
            }),
          );
        }
      } else if (message.type === 'notification') {
        const note = message as RpcNotification;
        this.notificationHandler?.(note.event, note.payload);
      }
    }
  }

  private failAllPending(error: Error): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
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
        : join(options.userDataDir, 'preferences', 'wsl-runtime.json'));
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
    const tmp = this.preferencesFile + '.tmp-' + String(process.pid);
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

export function translateWindowsPathForWsl(windowsPath: string, distro: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('wsl.exe', ['-d', distro, '--', 'wslpath', '-u', windowsPath], {
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
