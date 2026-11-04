import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { createProductionOpenCodeClient, DirectOpenCodeProcessLauncher } from '../src/index.js';

describe('incremental production observations', () => {
  it.each([true, false])(
    'emits split UTF-8 tool output before exit; confirmed shutdown=%s',
    async (confirmed) => {
      const root = await mkdtemp(join(tmpdir(), 'sentry-oc-live-'));
      const direct = new DirectOpenCodeProcessLauncher();
      let observed!: (value: unknown) => void;
      const observation = new Promise((resolve) => {
        observed = resolve;
      });
      const wire =
        JSON.stringify({
          type: 'tool_use',
          sessionID: 'ses_fixture',
          part: {
            type: 'tool',
            tool: 'read',
            callID: 'read_1',
            state: {
              status: 'completed',
              input: { filePath: 'README.md' },
              output: 'Доказателство',
            },
          },
        }) + '\n';
      const client = await createProductionOpenCodeClient({
        executable: 'synthetic',
        cwd: root,
        environment: process.env,
        modelId: 'stub',
        shutdownTimeoutMs: 5000,
        launcher: {
          kind: direct.kind,
          launch: (input) => {
            const owned = direct.launch({
              ...input,
              executable: process.execPath,
              argv: [
                '-e',
                `const data=Buffer.from(${JSON.stringify(wire)}); for(const byte of data)process.stdout.write(Buffer.from([byte])); setInterval(()=>{},10000);`,
              ],
            });
            return {
              ...owned,
              stop: async () => {
                const actual = await owned.stop();
                return confirmed && actual;
              },
            };
          },
        },
      });
      try {
        const pending = (await client.startSession()).runPrompt('synthetic', {
          timeoutMs: 10000,
          onTool: observed,
        });
        const failed = pending.catch((error: unknown) => error);
        expect(await observation).toMatchObject({ callID: 'read_1', output: 'Доказателство' });
        if (confirmed) await client.close();
        else await expect(client.close()).rejects.toThrow('shutdown could not be confirmed');
        expect(await failed).toBeInstanceOf(Error);
      } finally {
        await client.close().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
