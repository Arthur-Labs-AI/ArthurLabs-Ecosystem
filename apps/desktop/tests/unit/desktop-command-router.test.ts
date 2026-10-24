import { describe, expect, it, vi } from 'vitest';
import { INITIAL_AGENT_STACKS } from '@qa/domain';
import {
  CLI_ALLOWED_CHANNELS,
  DesktopChannelSchemas,
  dispatchDesktopCommand,
  isCliAllowed,
} from '../../src/main/desktop-command-router.js';
import { DesktopApplicationService } from '../../src/main/services/desktop-service.js';
import { ProviderCredentialService } from '../../src/main/services/provider-credentials.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from('enc:' + value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').slice(4),
  };
}

async function harness(gateReady = true) {
  const root = await mkdtemp(join(tmpdir(), 'sentry-router-'));
  const credentials = new ProviderCredentialService({
    filePath: join(root, 'providers.json'),
    safeStorage: fakeSafeStorage(),
  });
  const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
  const runtime = {
    request: async (method: string, params: Record<string, unknown> = {}) => {
      seen.push({ method, params });
      if (method === 'production.preRunGate')
        return {
          ready: gateReady,
          warnings: [],
          stacks: gateReady
            ? []
            : [
                {
                  id: 'stack_opencode_main',
                  ready: false,
                  reasons: ['no credential'],
                  warnings: [],
                },
              ],
        };
      if (method === 'runs.start')
        return { operationId: 'dop_test', runId: 'run_01K7777777777777777777A8W1' };
      if (method === 'retests.start')
        return { operationId: 'dop_test', retestRunId: 'retest_01K7777777777777777777A8W1' };
      if (method === 'runtime.configure') return { configured: true };
      return { ok: true };
    },
    status: { connected: true, distro: 'Ubuntu', hello: undefined, lastError: undefined },
  };
  const service = new DesktopApplicationService({
    runtime: runtime as never,
    distro: 'Ubuntu',
    credentials,
    agentStacks: [...INITIAL_AGENT_STACKS],
  });
  return { service, seen };
}
describe('shared desktop command router', () => {
  it.each(['runs:merge', 'runs:verify', 'issues:ingest'])(
    'rejects retired %s on both renderer and external CLI paths',
    async (channel) => {
      const h = await harness();
      for (const external of [false, true]) {
        await expect(
          dispatchDesktopCommand(h.service, channel, {}, {}, { external }),
        ).rejects.toMatchObject({ code: 'IPC_UNKNOWN_CHANNEL' });
      }
      expect(h.seen).toEqual([]);
    },
  );

  it('routes renderer and external CLI through the same dispatch with the same result', async () => {
    const a = await harness();
    const b = await harness();
    const renderer = await dispatchDesktopCommand(a.service, 'projects:list', {}, {});
    const cli = await dispatchDesktopCommand(
      b.service,
      'projects:list',
      {},
      {},
      { external: true },
    );
    expect(renderer).toEqual(cli);
    expect(a.seen.map((c) => c.method)).toEqual(b.seen.map((c) => c.method));
  });

  it('applies the pre-run readiness gate for CLI runs:start exactly like Desktop', async () => {
    const blocked = await harness(false);
    await expect(
      dispatchDesktopCommand(
        blocked.service,
        'runs:start',
        { projectId: 'proj_01K7777777777777777777A8W1', mode: 'full' },
        {},
        { external: true },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_READY' });
    const gateCalls = blocked.seen.filter((c) => c.method === 'production.preRunGate');
    expect(gateCalls).toHaveLength(1);
    expect(blocked.seen.some((c) => c.method === 'runs.start')).toBe(false);
  });

  it('propagates a bounded run timeout and rejects out-of-range values', async () => {
    const h = await harness(true);
    await dispatchDesktopCommand(
      h.service,
      'runs:start',
      { projectId: 'proj_01K7777777777777777777A8W1', mode: 'full', runTimeoutMs: 600000 },
      {},
      { external: true },
    );
    const start = h.seen.find((c) => c.method === 'runs.start');
    expect(start?.params['runTimeoutMs']).toBe(600000);
    await expect(
      dispatchDesktopCommand(
        h.service,
        'runs:start',
        { projectId: 'proj_01K7777777777777777777A8W1', mode: 'full', runTimeoutMs: 99999999999 },
        {},
        { external: true },
      ),
    ).rejects.toThrow();
  });

  it('fires run-created hooks for CLI-started runs (Desktop live updates stay truthful)', async () => {
    const h = await harness(true);
    const onRunCreated = vi.fn();
    const result = await dispatchDesktopCommand(
      h.service,
      'runs:start',
      { projectId: 'proj_01K7777777777777777777A8W1', mode: 'full' },
      { onRunCreated },
      { external: true },
    );
    expect(result).toMatchObject({ runId: 'run_01K7777777777777777777A8W1' });
    expect(onRunCreated).toHaveBeenCalledWith('run_01K7777777777777777777A8W1', 'dop_test');
  });

  it('rejects provider-secret and admin commands for external clients', async () => {
    const h = await harness(true);
    for (const channel of [
      'providers:save',
      'providers:clear',
      'providers:persist',
      'providers:forget-file',
      'providers:forget-all',
      'runtime:select-distro',
      'runs:export-save',
      'runs:export-reveal',
      'cli:set-enabled',
    ]) {
      expect(isCliAllowed(channel)).toBe(false);
      await expect(
        dispatchDesktopCommand(h.service, channel, {}, {}, { external: true }),
      ).rejects.toMatchObject({ code: 'CLI_COMMAND_FORBIDDEN' });
    }
  });

  it('persists the renderer-selected language without touching the runtime', async () => {
    const h = await harness(true);
    const persisted: string[] = [];
    const result = await dispatchDesktopCommand(
      h.service,
      'app:set-language',
      { language: 'bg' },
      { persistAppLanguage: (language) => persisted.push(language) },
    );
    expect(result).toEqual({ saved: true, language: 'bg' });
    expect(persisted).toEqual(['bg']);
    expect(h.seen).toHaveLength(0);
  });

  it('rejects invalid languages and keeps them out of the external allowlist', async () => {
    const h = await harness(true);
    await expect(
      dispatchDesktopCommand(h.service, 'app:set-language', { language: 'fr' }, {}),
    ).rejects.toThrow();
    expect(isCliAllowed('app:set-language')).toBe(false);
    await expect(
      dispatchDesktopCommand(h.service, 'app:set-language', { language: 'bg' }, {}, { external: true }),
    ).rejects.toMatchObject({ code: 'CLI_COMMAND_FORBIDDEN' });
  });

  it('lets the language persist during runtime maintenance', async () => {
    const h = await harness(true);
    const persisted: string[] = [];
    const result = await dispatchDesktopCommand(
      h.service,
      'app:set-language',
      { language: 'en' },
      { maintenanceActive: () => true, persistAppLanguage: (language) => persisted.push(language) },
    );
    expect(result).toEqual({ saved: true, language: 'en' });
    expect(persisted).toEqual(['en']);
  });

  it('keeps renderer-only commands working on the internal path', async () => {
    const h = await harness(true);
    const statuses = await dispatchDesktopCommand(h.service, 'providers:status', {}, {});
    expect(Array.isArray(statuses)).toBe(true);
  });

  it('rejects unknown commands on both paths', async () => {
    const h = await harness(true);
    await expect(dispatchDesktopCommand(h.service, 'nope:missing', {}, {})).rejects.toMatchObject({
      code: 'IPC_UNKNOWN_CHANNEL',
    });
    await expect(
      dispatchDesktopCommand(h.service, 'nope:missing', {}, {}, { external: true }),
    ).rejects.toMatchObject({ code: 'IPC_UNKNOWN_CHANNEL' });
  });

  it('exposes cli:status to external clients but keeps provider writes out of the allowlist', () => {
    expect(isCliAllowed('projects:delete')).toBe(true);
    expect(isCliAllowed('cli:status')).toBe(true);
    expect(isCliAllowed('providers:save')).toBe(false);
    expect(CLI_ALLOWED_CHANNELS.has('runs:export-content')).toBe(true);
  });

  it('every registered channel is known to the router', () => {
    expect(Object.keys(DesktopChannelSchemas).length).toBeGreaterThan(20);
  });
});
