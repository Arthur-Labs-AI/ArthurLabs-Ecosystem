import { createHmac, timingSafeEqual } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { WSL_SPACE_HELPER } from './wsl-space-helper.js';

const payload = gzipSync(Buffer.from(WSL_SPACE_HELPER)).toString('base64');
export function wslSpaceCommand(
  action: 'Inspect' | 'Reclaim',
  distro: string,
  directory: string,
  operationId: string,
  key: Buffer,
): string {
  const encode = (value: string) => Buffer.from(value).toString('base64');
  if (!/^[a-f0-9]{32}$/.test(operationId) || key.length !== 32)
    throw new Error('Invalid maintenance operation identity.');
  const bootstrap = `$PSModuleAutoLoadingPreference='None'
foreach ($module in @('Microsoft.PowerShell.Management','Microsoft.PowerShell.Utility')) {
  Import-Module ([IO.Path]::Combine($PSHOME,'Modules',$module,($module+'.psd1'))) -ErrorAction Stop
}
$p='${payload}'
$m=[IO.MemoryStream]::new([Convert]::FromBase64String($p))
$g=[IO.Compression.GZipStream]::new($m,[IO.Compression.CompressionMode]::Decompress)
$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8)
try { $s=$r.ReadToEnd() } finally { $r.Dispose(); $g.Dispose(); $m.Dispose() }
& ([ScriptBlock]::Create($s)) -Action ${action} -TrustedPayload $p -DistroBase64 '${encode(distro)}' -MaintenanceRootBase64 '${encode(directory)}' -OperationId '${operationId}' -ReceiptKeyBase64 '${key.toString('base64')}'`;
  const command = Buffer.from(bootstrap, 'utf16le').toString('base64');
  if (command.length > 29000)
    throw new Error('Maintenance command exceeds the Windows argument limit.');
  return command;
}

const receiptSchema = z
  .object({
    version: z.literal(1),
    operationId: z.string().regex(/^[a-f0-9]{32}$/),
    sid: z.string().regex(/^S-1-[0-9-]+$/),
    distro: z.string().min(1).max(200),
    disk: z.string().regex(/^[A-Za-z]:\\/),
    outcome: z.enum(['completed', 'failed']),
    message: z.string().max(1000),
    mac: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** The key is per operation, memory-only; never retained in diagnostic receipts. */
export function verifyWslSpaceReceipt(
  value: unknown,
  operationId: string,
  distro: string,
  key: Buffer,
): void {
  const receipt = receiptSchema.parse(value);
  const canonical = [
    '1',
    receipt.operationId,
    receipt.sid,
    receipt.distro,
    receipt.disk,
    receipt.outcome,
    Buffer.from(receipt.message).toString('base64'),
  ].join('\n');
  const expected = createHmac('sha256', key).update(canonical).digest();
  if (
    receipt.operationId !== operationId ||
    receipt.distro !== distro ||
    !timingSafeEqual(expected, Buffer.from(receipt.mac, 'hex'))
  )
    throw new Error('Maintenance receipt authentication failed.');
  if (receipt.outcome !== 'completed' || receipt.message !== '')
    throw new Error(receipt.message || 'Windows disk reclamation did not complete.');
}
