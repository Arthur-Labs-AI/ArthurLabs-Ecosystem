import { INITIAL_AGENT_STACKS } from '@qa/domain';
import {
  SentryDatabase,
  SentryRepository,
  RuntimeInstanceLease,
  resolveSentryDataRoot,
} from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { RunCoordinator } from '@qa/run-engine';
import { DesktopApplicationService } from './services/desktop-service.js';
import {
  ProviderCredentialService,
  type SafeStorageLike,
} from './services/provider-credentials.js';
import {
  createProductionRegistry,
  createSimulationRegistry,
} from './services/execution-registries.js';

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

export async function bootstrapDesktop(dataRootOverride?: string): Promise<BootstrappedDesktop> {
  const recoveryWarnings: string[] = [];
  const dataRoot = dataRootOverride ?? resolveSentryDataRoot();
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const lease = new RuntimeInstanceLease(repository);
  lease.start();

  // Provider credentials BEFORE doctors / registry construction / execution.
  const dir = userDataDir();
  // safeStorage is Electron-only; resolve lazily so node/vitest contexts run
  // session-only without importing 'electron' at module load.
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
  const credentials = new ProviderCredentialService({
    ...(dir === undefined ? {} : { userDataDir: dir }),
    ...(safeStorageLike === undefined ? {} : { safeStorage: safeStorageLike }),
  });
  // Load persisted secrets + model prefs + one-time legacy migration (never throws).
  await credentials.load();
  if (!credentials.secureStorageAvailable) {
    recoveryWarnings.push(
      'Secure persistent storage unavailable. Credentials can be used for this session only.',
    );
  }

  const projects = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
  // Simulation registry: FakeHarness only, never provider spend.
  const registry = createSimulationRegistry('success');
  // Production registry: exact CLI registrations (Muse / DeepSeek / GLM).
  const productionRegistry = createProductionRegistry();
  const coordinator = new RunCoordinator(dataRoot, repository, lease, registry);
  const productionCoordinator = new RunCoordinator(dataRoot, repository, lease, productionRegistry);
  // Awaited recovery BEFORE presenting live state (includes retest +
  // verification recovery through coordinator behavior). Errors are
  // recorded, not swallowed: fatal failures throw and surface a startup
  // error; bounded warnings ride to Environment diagnostics.
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
    productionCoordinator,
    productionRegistry,
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
