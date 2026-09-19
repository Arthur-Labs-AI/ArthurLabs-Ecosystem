import {
  SentryDatabase,
  SentryRepository,
  RuntimeInstanceLease,
  resolveSentryDataRoot,
} from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { RunCoordinator } from '@qa/run-engine';
import { INITIAL_AGENT_STACKS } from '@qa/domain';
import { DesktopApplicationService } from './services/desktop-service.js';
import {
  ProviderCredentialService,
  type SafeStorageLike,
} from './services/provider-credentials.js';
import { createProductionRegistry } from './services/execution-registries.js';

export interface BootstrappedDesktop {
  readonly service: DesktopApplicationService;
  readonly dataRoot: string;
  readonly database: SentryDatabase;
  readonly lease: RuntimeInstanceLease;
  readonly recoveryWarnings: readonly string[];
  close(): void;
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
 * Production-only boot order:
 * credentials -> model prefs -> production registry -> DB -> lease ->
 * coordinator -> AWAITED recovery -> service -> (caller creates window).
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
  if (!credentials.secureStorageAvailable) {
    recoveryWarnings.push(
      'Secure persistent storage unavailable. Credentials can be used for this session only.',
    );
  }
  const dataRoot = dataRootOverride ?? resolveSentryDataRoot();
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const lease = new RuntimeInstanceLease(repository);
  lease.start();
  const projects = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
  const registry = createProductionRegistry();
  const coordinator = new RunCoordinator(dataRoot, repository, lease, registry);
  try {
    await coordinator.recover();
  } catch (error) {
    lease.release();
    database.close();
    throw error;
  }
  const service = new DesktopApplicationService({
    dataRoot,
    database,
    repository,
    lease,
    projects,
    coordinator,
    registry,
    credentials,
    agentStacks: [...INITIAL_AGENT_STACKS],
  });
  return {
    service,
    dataRoot,
    database,
    lease,
    recoveryWarnings,
    close() {
      lease.release();
      database.close();
    },
  };
}
