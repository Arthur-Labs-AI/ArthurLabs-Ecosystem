import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { INITIAL_AGENT_STACKS } from '@qa/domain';
import { DesktopApplicationService } from '../../src/main/services/desktop-service.js';
import { ProviderCredentialService } from '../../src/main/services/provider-credentials.js';
import { serveStdio } from '../../../runtime/src/runtime.js';

const roots: string[] = [];
async function rmRoot(value: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(value, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rmRoot(value)));
});

/**
 * Service-level smoke over the REAL runtime host (in-process stdio, no providers):
 * add → run → merge → issue, with the desktop service as a pure RPC adapter.
 * Provider adapters never execute here — the runtime registry is real but no
 * run starts (only project + empty-list reads + readiness).
 */
describe('desktop smoke: service over real runtime host', () => {
  it('lists projects and gates readiness through the RPC boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-desktop-smoke-'));
    roots.push(root);
    const dataRoot = join(root, 'data');
    const input = new PassThrough();
    const output = new PassThrough();
    const serving = serveStdio({
      dataRoot,
      input: input as never,
      output: output as never,
      onStderr: () => undefined,
      onExit: () => undefined,
    });
    const { WslRuntimeClient } = await import('../../src/main/services/wsl-runtime-client.js');
    void WslRuntimeClient;
    const lines: string[] = [];
    output.on('data', (chunk: Buffer) => {
      lines.push(chunk.toString('utf8'));
    });
    const request = (
      id: string,
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<unknown> =>
      new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('rpc timeout ' + method)), 15000);
        const onData = (chunk: Buffer): void => {
          for (const line of (received.text + chunk.toString('utf8')).split('\n')) {
            if (line.trim().length === 0) continue;
            try {
              const message = JSON.parse(line) as {
                type: string;
                id?: string;
                ok?: boolean;
                result?: unknown;
                error?: { message?: string };
              };
              if (message.type === 'response' && message.id === id) {
                received.text = '';
                output.off('data', onData);
                clearTimeout(timer);
                if (message.ok) resolve(message.result);
                else reject(new Error(message.error?.message ?? 'rpc error'));
              } else {
                received.text += line + '\n';
              }
            } catch {
              received.text += line + '\n';
            }
          }
        };
        const received = { text: lines.join('') };
        lines.length = 0;
        output.on('data', onData);
        input.write(JSON.stringify({ type: 'request', id, method, params }) + '\n');
      });
    const credentials = new ProviderCredentialService({ filePath: join(root, 'providers.json') });
    const hello = (await request('rpc_hello', 'runtime.hello')) as {
      platform: string;
      processExecPath: string;
    };
    expect(hello.platform).toBe(process.platform);
    expect(hello.processExecPath.toLowerCase().endsWith('electron.exe')).toBe(false);
    const projects = (await request('rpc_projects', 'projects.list')) as unknown[];
    expect(Array.isArray(projects)).toBe(true);
    const gate = (await request('rpc_gate', 'production.preRunGate', {
      agentStackIds: ['stack_deepseek_main'],
    })) as {
      ready: boolean;
      stacks: Array<{ id: string }>;
    };
    expect(gate.stacks.map((s) => s.id)).toContain('stack_deepseek_main');
    expect(gate.ready).toBe(false);
    const service = new DesktopApplicationService({
      runtime: {
        request: (method: string, params: Record<string, unknown> = {}) =>
          request('rpc_' + method.replace(/\./g, '_') + '_' + String(Date.now()), method, params),
        status: { connected: true, distro: undefined, hello: undefined, lastError: undefined },
      } as never,
      host: {
        hostKind: 'linux',
        executionMode: 'native-linux',
        createRuntimeClient: () => {
          throw new Error('test seam: no runtime launch');
        },
        prepareSourcePath: (path: string) => Promise.resolve(path),
        runtimeEnvironmentInfo: () =>
          Promise.resolve({ hostPlatform: 'linux', executionMode: 'native-linux' }),
        runtimeDistros: () => Promise.resolve({ distros: [], preferred: null, selected: null }),
        runtimeSelectDistro: () => {
          throw Object.assign(new Error('unsupported'), { code: 'DISTRO_SELECTION_UNSUPPORTED' });
        },
      } as never,
      credentials,
      agentStacks: [...INITIAL_AGENT_STACKS],
    });
    const statuses = service.providerStatuses() as Array<{ name: string }>;
    expect(statuses.some((s) => s.name === 'DEEPSEEK_API_KEY')).toBe(true);
    input.write(
      JSON.stringify({ type: 'request', id: 'rpc_bye', method: 'runtime.shutdown', params: {} }) +
        '\n',
    );
    await serving;
  }, 60000);
});
