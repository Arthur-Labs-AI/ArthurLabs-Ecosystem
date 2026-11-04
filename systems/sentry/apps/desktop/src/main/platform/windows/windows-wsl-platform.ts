/**
 * Windows host platform: Electron Desktop -> WSL2 -> Sentry Linux Runtime.
 *
 * A thin adapter around the proven WSL behavior (distro selection,
 * wslpath translation, runtime entry probing). Launch argv, selection
 * rules, and preference storage are unchanged from the pre-platform
 * implementation; they only moved behind the HostPlatform seam so a
 * native Linux platform can sit beside them.
 */
import { z } from 'zod';
import type { RuntimeClient } from '../../runtime/runtime-client.js';
import type { HostPlatform, HostRuntimeInfo } from '../host-platform.js';
import {
  translateWindowsPathForWsl,
  WslRuntimeClient,
  WslRuntimeManager,
} from '../../services/wsl-runtime-client.js';

export interface WindowsWslPlatformOptions {
  readonly userDataDir?: string;
  readonly preferencesFile?: string;
  readonly dataRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Location of the deployed runtime entry inside the WSL distro. */
export async function runtimeEntryForDistro(
  distro: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const override = env['SENTRY_RUNTIME_ENTRY'];
  if (override !== undefined && override.length > 0) return override;
  const { wslHomeDir } = await import('../../services/wsl-runtime-client.js');
  const home = await wslHomeDir(distro);
  return home.replace(/\/$/, '') + '/.local/share/sentry/runtime/current/apps/runtime/dist/host.js';
}

function toError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export class WindowsWslPlatform implements HostPlatform {
  readonly hostKind = 'windows' as const;
  readonly executionMode = 'wsl2' as const;
  private readonly manager: WslRuntimeManager;
  private readonly dataRoot: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private distroCache: string | undefined;
  private runtimeEntryCache: string | undefined;

  constructor(options: WindowsWslPlatformOptions = {}) {
    this.manager = new WslRuntimeManager(
      options.preferencesFile === undefined && options.userDataDir === undefined
        ? {}
        : {
            ...(options.userDataDir === undefined ? {} : { userDataDir: options.userDataDir }),
            ...(options.preferencesFile === undefined
              ? {}
              : { preferencesFile: options.preferencesFile }),
          },
    );
    this.dataRoot = options.dataRoot;
    this.env = options.env ?? process.env;
  }

  async createRuntimeClient(): Promise<RuntimeClient> {
    if (!(await this.manager.wslAvailable())) {
      throw Object.assign(
        new Error(
          "WSL2 is required for Sentry's production QA runtime, but wsl.exe is unavailable.",
        ),
        { code: 'WSL_UNAVAILABLE' },
      );
    }
    const distro = await this.manager.resolveDistro();
    this.distroCache = distro;
    const runtimeEntry = await runtimeEntryForDistro(distro, this.env);
    this.runtimeEntryCache = runtimeEntry;
    return new WslRuntimeClient({
      distro,
      runtimeEntry,
      ...(this.dataRoot === undefined ? {} : { dataRoot: this.dataRoot }),
    });
  }

  async prepareSourcePath(path: string): Promise<string> {
    if (/^[A-Za-z]:[\\/]/.test(path)) {
      return translateWindowsPathForWsl(path, await this.distroName());
    }
    return path;
  }

  async runtimeEnvironmentInfo(): Promise<HostRuntimeInfo> {
    const distro = await this.distroName();
    const runtimeEntry = await this.entryFor(distro);
    return { hostPlatform: 'windows', executionMode: 'wsl2', distro, runtimeEntry };
  }

  async runtimeDistros(): Promise<unknown> {
    let distros: Array<{ name: string; state: string; version: number }> = [];
    let listError: string | undefined;
    try {
      distros = await this.manager.listDistros();
    } catch (error) {
      // Never a silent empty list: the UI must distinguish "none installed"
      // from "wsl.exe failed", otherwise users chase the wrong fix.
      listError =
        error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    }
    const preferred = await this.manager.loadPreferredDistro().catch(() => undefined);
    return {
      distros,
      preferred: preferred ?? null,
      selected: this.distroCache ?? null,
      ...(listError === undefined ? {} : { listError }),
    };
  }

  async runtimeSelectDistro(distro: string): Promise<unknown> {
    const parsed = z.string().min(1).max(200).parse(distro);
    const usable = (await this.manager.listDistros()).filter((d) => d.version === 2);
    if (!usable.some((d) => d.name === parsed)) {
      throw toError('WSL_NO_DISTRO', 'Not a usable WSL2 distribution: ' + parsed);
    }
    await this.manager.savePreferredDistro(parsed);
    return { saved: parsed, restartRequired: true };
  }

  private async distroName(): Promise<string> {
    if (this.distroCache === undefined) {
      this.distroCache = await this.manager.resolveDistro();
    }
    return this.distroCache;
  }

  private async entryFor(distro: string): Promise<string> {
    if (this.runtimeEntryCache === undefined) {
      this.runtimeEntryCache = await runtimeEntryForDistro(distro, this.env);
    }
    return this.runtimeEntryCache;
  }
}
