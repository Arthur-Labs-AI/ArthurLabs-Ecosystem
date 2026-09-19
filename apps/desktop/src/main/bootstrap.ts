import { INITIAL_AGENT_STACKS } from '@qa/domain';
import {
  SentryDatabase,
  SentryRepository,
  RuntimeInstanceLease,
  resolveSentryDataRoot,
} from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { RunCoordinator } from '@qa/run-engine';
import { createFakeHarnessRegistry } from '@qa/run-engine';
import { DesktopApplicationService } from './services/desktop-service.js';

export interface BootstrappedDesktop {
  readonly service: DesktopApplicationService;
  readonly dataRoot: string;
  readonly database: SentryDatabase;
  readonly lease: RuntimeInstanceLease;
  close(): void;
}

export function bootstrapDesktop(dataRootOverride?: string): BootstrappedDesktop {
  const dataRoot = dataRootOverride ?? resolveSentryDataRoot();
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const lease = new RuntimeInstanceLease(repository);
  lease.start();
  const projects = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
  // Phase 8 uses the deterministic fake registry exclusively: no paid
  // provider calls from desktop development, tests, or simulation runs.
  const registry = createFakeHarnessRegistry('success');
  const coordinator = new RunCoordinator(dataRoot, repository, lease, registry);
  // Recover stale operations before presenting live state (§205-§206).
  void coordinator.recover().catch(() => undefined);
  const service = new DesktopApplicationService({
    dataRoot,
    database,
    repository,
    lease,
    projects,
    coordinator,
    registry,
    agentStacks: [...INITIAL_AGENT_STACKS],
  });
  return {
    service,
    dataRoot,
    database,
    lease,
    close() {
      lease.release();
      database.close();
    },
  };
}
