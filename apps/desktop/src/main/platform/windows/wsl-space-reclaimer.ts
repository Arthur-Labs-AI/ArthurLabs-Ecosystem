import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { WslSpaceResult } from '../../../shared/ipc-contract.js';
import { WSL_SPACE_HELPER } from './wsl-space-helper.js';

const bytes = z.number().int().nonnegative().safe();
const resultSchema = z.object({
  distro: z.string().min(1),
  diskBytesBefore: bytes,
  diskBytesAfter: bytes,
  windowsFreeBytesBefore: bytes,
  windowsFreeBytesAfter: bytes,
});

/** Invokes a fixed per-operation helper. Receipts are retained for diagnostics. */
export class WslSpaceReclaimer {
  constructor(private readonly directory: string) {}

  private async invoke(action: 'Inspect' | 'Reclaim', distro: string): Promise<unknown> {
    if (process.platform !== 'win32') throw new Error('WSL disk reclamation requires Windows.');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(this.directory, { recursive: true });
    const operation = await mkdtemp(join(this.directory, 'reclaim-'));
    const script = join(operation, 'reclaim-wsl-space.ps1');
    await writeFile(script, WSL_SPACE_HELPER, { flag: 'wx' });
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
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-Action',
          action,
          '-DistroBase64',
          Buffer.from(distro).toString('base64'),
        ],
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
    return JSON.parse(output) as unknown;
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
    return result;
  }
}
