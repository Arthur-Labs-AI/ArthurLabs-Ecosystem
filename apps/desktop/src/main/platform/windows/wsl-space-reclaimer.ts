import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { WslSpaceResult } from '../../../shared/ipc-contract.js';
import { verifyWslSpaceReceipt, wslSpaceCommand } from './wsl-space-command.js';

const bytes = z.number().int().nonnegative().safe();
const resultSchema = z.object({
  distro: z.string().min(1),
  diskBytesBefore: bytes,
  diskBytesAfter: bytes,
  windowsFreeBytesBefore: bytes,
  windowsFreeBytesAfter: bytes,
  receipt: z.unknown(),
});

/** Invokes a fixed per-operation helper. Receipts are retained for diagnostics. */
export class WslSpaceReclaimer {
  constructor(private readonly directory: string) {}

  private async invoke(action: 'Inspect' | 'Reclaim', distro: string): Promise<unknown> {
    if (process.platform !== 'win32') throw new Error('WSL disk reclamation requires Windows.');
    const operationId = randomUUID().replaceAll('-', '');
    const key = randomBytes(32);
    const command = wslSpaceCommand(action, distro, this.directory, operationId, key);
    const executable = join(
      process.env['SystemRoot'] ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        executable,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', command],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString('utf8')).slice(-16000);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-2000);
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || 'Windows disk reclamation failed.'));
      });
      // Do not kill an elevated native disk operation on an arbitrary JS timeout.
    });
    const parsed: unknown = JSON.parse(output);
    if (action === 'Reclaim') {
      const result = resultSchema.strict().parse(parsed);
      verifyWslSpaceReceipt(result.receipt, operationId, distro, key);
    }
    return parsed;
  }

  async inspect(distro: string): Promise<void> {
    z.object({ distro: z.literal(distro), diskBytes: bytes, windowsFreeBytes: bytes }).parse(
      await this.invoke('Inspect', distro),
    );
  }

  async reclaim(distro: string): Promise<Omit<WslSpaceResult, 'reconnected'>> {
    const result = resultSchema.parse(await this.invoke('Reclaim', distro));
    if (result.distro !== distro)
      throw new Error('Windows maintenance returned a different distribution.');
    return {
      distro: result.distro,
      diskBytesBefore: result.diskBytesBefore,
      diskBytesAfter: result.diskBytesAfter,
      windowsFreeBytesBefore: result.windowsFreeBytesBefore,
      windowsFreeBytesAfter: result.windowsFreeBytesAfter,
    };
  }
}
