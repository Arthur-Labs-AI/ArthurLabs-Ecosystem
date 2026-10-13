import { createRequire } from 'node:module';
import { INITIAL_AGENT_STACKS } from '@qa/domain';
import { resolveSentryDataRoot } from '@qa/persistence';

/**
 * The desktop main process is ESM (package type: module), where bare
 * `require` does not exist. Electron's API must be reached through a
 * scoped require — a bare require('electron') throws ReferenceError,
 * which the try/catch below would silently convert into 'safeStorage
 * bridge unavailable' (and an undefined userData dir).
 */
const require = createRequire(import.meta.url);
import { DesktopApplicationService } from './services/desktop-service.js';
import {
  ProviderCredentialService,
  type SafeStorageLike,
} from './services/provider-credentials.js';
import type { RuntimeClient } from './runtime/runtime-client.js';
import type { HostPlatform } from './platform/host-platform.js';
import { createHostPlatform } from './platform/create-host-platform.js';
import { assertRuntimeIdentity, readReleaseIdentity } from './distribution.js';

export interface BootstrappedDesktop {
  readonly service: DesktopApplicationService;
  readonly runtime: RuntimeClient;
  readonly host: HostPlatform;
  readonly dataRoot: string;
  readonly recoveryWarnings: readonly string[];
  /** Reconnect the runtime after a crash: respawn, handshake, reconfigure. */
  reconnect(): Promise<void>;
  close(): Promise<void>;
}

function userDataDir(): string | undefined {
  try {
    const electron = require('electron') as typeof import('electron');
    return electron.app.getPath('userData');
  } catch {
    return undefined;
  }
}

/**
 * Production boot order:
 * credentials -> host platform -> runtime client -> handshake -> configure ->
 * awaited recovery (inside runtime) -> service. No RunCoordinator on any host.
 * Windows resolves a WSL distro; native Linux requires CachyOS.
 */
export async function bootstrapDesktop(dataRootOverride?: string): Promise<BootstrappedDesktop> {
  const recoveryWarnings: string[] = [];
  let safeStorageLike: SafeStorageLike | undefined;
  try {
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
  // Provider executables resolve inside the Linux runtime; host binary
  // discovery no longer drives production readiness.
  // No secure-storage warning here: this runs before app-ready, when
  // Electron's crypto backend is not up yet, so any verdict would be stale.
  // Availability is evaluated lazily at save time (see secureStorageAvailable),
  // and a genuine failure surfaces live in the save error itself.
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
  const host = await createHostPlatform({
    ...(dir === undefined ? {} : { userDataDir: dir }),
    ...(linuxOverride === undefined ? {} : { dataRoot: linuxOverride }),
  });
  const client = await host.createRuntimeClient();
  let hello;
  try {
    hello = await client.start();
    const electron = require('electron') as typeof import('electron');
    const identity = electron.app?.isPackaged
      ? readReleaseIdentity(electron.app.getAppPath())
      : undefined;
    assertRuntimeIdentity(identity, hello);
  } catch (error) {
    await client.stop().catch(() => undefined);
    const diagnostics = client.stderrDiagnostics.join('\n').slice(0, 800);
    const message = error instanceof Error ? error.message : String(error);
    const info = await host.runtimeEnvironmentInfo().catch(() => undefined);
    const where =
      info === undefined
        ? ''
        : ' [host=' +
          info.hostPlatform +
          '/' +
          info.executionMode +
          (info.distro === undefined ? '' : ' distro=' + info.distro) +
          (info.distribution === undefined ? '' : ' distro=' + info.distribution.id) +
          (info.runtimeEntry === undefined ? '' : ' entry=' + info.runtimeEntry) +
          ']';
    // Structured host identity survives the wrap so the fatal screen can
    // show native Linux guidance on CachyOS instead of WSL instructions.
    throw Object.assign(
      new Error(
        message +
          (diagnostics.length > 0
            ? ' Runtime output: ' + diagnostics
            : ' (no runtime output captured)') +
          where,
      ),
      {
        code: 'RUNTIME_OFFLINE',
        hostPlatform: host.hostKind,
        executionMode: host.executionMode,
      },
    );
  }
  const service = new DesktopApplicationService({
    runtime: client,
    host,
    credentials,
    agentStacks: [...INITIAL_AGENT_STACKS],
    legacyDataRoot: resolveSentryDataRoot(),
  });
  await service.pushRuntimeConfiguration().catch((error: unknown) => {
    // The push carries secrets by design; a transport failure must not echo
    // them into the boot log. Scrub with the same boundary redactor.
    const detail = error instanceof Error ? error.message : String(error);
    recoveryWarnings.push(
      'Runtime configuration push failed: ' +
        credentials.redactSecretsFromText(detail).slice(0, 200),
    );
  });
  return {
    service,
    runtime: client,
    host,
    dataRoot: hello.dataRoot,
    recoveryWarnings,
    async reconnect() {
      try {
        const hello = await client.start();
        const electron = require('electron') as typeof import('electron');
        assertRuntimeIdentity(
          electron.app?.isPackaged ? readReleaseIdentity(electron.app.getAppPath()) : undefined,
          hello,
        );
      } catch (error) {
        await client.stop().catch(() => undefined);
        throw error;
      }
      await service.pushRuntimeConfiguration();
    },
    async close() {
      await client.stop();
    },
  };
}
