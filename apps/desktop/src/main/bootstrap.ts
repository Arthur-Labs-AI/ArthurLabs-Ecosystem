import { INITIAL_AGENT_STACKS } from '@qa/domain';
import { resolveSentryDataRoot } from '@qa/persistence';
import { DesktopApplicationService } from './services/desktop-service.js';
import {
  ProviderCredentialService,
  type SafeStorageLike,
} from './services/provider-credentials.js';
import { WslRuntimeClient, WslRuntimeManager } from './services/wsl-runtime-client.js';

export interface BootstrappedDesktop {
  readonly service: DesktopApplicationService;
  readonly runtime: WslRuntimeClient;
  readonly distro: string;
  readonly dataRoot: string;
  readonly recoveryWarnings: readonly string[];
  /** Reconnect the runtime after a crash: respawn, handshake, reconfigure. */
  reconnect(): Promise<void>;
  close(): Promise<void>;
}

function userDataDir(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as typeof import('electron');
    return electron.app.getPath('userData');
  } catch {
    return undefined;
  }
}

/**
 * Production boot order:
 * credentials -> WSL distro -> spawn runtime -> handshake -> configure ->
 * awaited recovery (inside runtime) -> service. No RunCoordinator on Windows.
 */
export async function bootstrapDesktop(dataRootOverride?: string): Promise<BootstrappedDesktop> {
  const recoveryWarnings: string[] = [];
  let safeStorageLike: SafeStorageLike | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as typeof import('electron');
    const ss = electron.safeStorage;
    if (ss !== undefined) {
      safeStorageLike = {
        isEncryptionAvailable: () => ss.isEncryptionAvailable(),
        encryptString: (value: string) => ss.encryptString(value),
        decryptString: (buffer: Buffer) => ss.decryptString(buffer),
      };
    }
  } catch {
    safeStorageLike = undefined;
  }
  const dir = userDataDir();
  const credentials = new ProviderCredentialService({
    ...(dir === undefined ? {} : { userDataDir: dir }),
    ...(safeStorageLike === undefined ? {} : { safeStorage: safeStorageLike }),
  });
  await credentials.load();
  // Provider executables resolve inside the WSL runtime; Windows binary
  // discovery no longer drives production readiness.
  if (!credentials.secureStorageAvailable) {
    recoveryWarnings.push(
      'Secure persistent storage unavailable. Credentials can be used for this session only.',
    );
  }
  const manager = new WslRuntimeManager({ ...(dir === undefined ? {} : { userDataDir: dir }) });
  if (!(await manager.wslAvailable())) {
    throw Object.assign(
      new Error("WSL2 is required for Sentry's production QA runtime, but wsl.exe is unavailable."),
      {
        code: 'WSL_UNAVAILABLE',
      },
    );
  }
  const distro = await manager.resolveDistro();
  const runtimeEntry = await runtimeEntryForDistro(distro);
  // The runtime owns its Linux data root. A Windows-style path must never be
  // forwarded as --data-root (backslashes mangle through wsl.exe and the Linux
  // runtime cannot own a Windows path). Only absolute Linux paths override.
  const rawOverride = dataRootOverride ?? process.env['SENTRY_DATA_ROOT'];
  const linuxOverride =
    rawOverride !== undefined && rawOverride.startsWith('/') ? rawOverride : undefined;
  if (rawOverride !== undefined && linuxOverride === undefined) {
    recoveryWarnings.push(
      'Ignoring Windows-style SENTRY_DATA_ROOT for the Linux runtime; using the Linux-managed data root instead.',
    );
  }
  const client = new WslRuntimeClient({
    distro,
    runtimeEntry,
    ...(linuxOverride === undefined ? {} : { dataRoot: linuxOverride }),
  });
  let hello;
  try {
    hello = await client.start();
  } catch (error) {
    const diagnostics = client.stderrDiagnostics.join('\n').slice(0, 800);
    const message = error instanceof Error ? error.message : String(error);
    throw Object.assign(
      new Error(
        message +
          (diagnostics.length > 0 ? ' Runtime output: ' + diagnostics : ' (no runtime output captured)') +
          ' [distro=' + distro + ' entry=' + runtimeEntry + ']',
      ),
      { code: 'RUNTIME_OFFLINE' },
    );
  }
  const service = new DesktopApplicationService({
    runtime: client,
    distro,
    credentials,
    agentStacks: [...INITIAL_AGENT_STACKS],
    legacyDataRoot: resolveSentryDataRoot(),
  });
  await service.pushRuntimeConfiguration().catch((error: unknown) => {
    recoveryWarnings.push(
      'Runtime configuration push failed: ' +
        (error instanceof Error ? error.message : String(error)).slice(0, 200),
    );
  });
  return {
    service,
    runtime: client,
    distro,
    dataRoot: hello.dataRoot,
    recoveryWarnings,
    async reconnect() {
      await client.start();
      await service.pushRuntimeConfiguration();
    },
    async close() {
      await client.stop();
    },
  };
}

/** Location of the deployed runtime entry inside the WSL distro. */
export async function runtimeEntryForDistro(distro: string): Promise<string> {
  const override = process.env['SENTRY_RUNTIME_ENTRY'];
  if (override !== undefined && override.length > 0) return override;
  const { wslHomeDir } = await import('./services/wsl-runtime-client.js');
  const home = await wslHomeDir(distro);
  return home.replace(/\/$/, '') + '/.local/share/sentry/runtime/current/apps/runtime/dist/host.js';
}
