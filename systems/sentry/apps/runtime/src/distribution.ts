import { readFileSync } from 'node:fs';
import { ReleaseIdentitySchema } from '@qa/runtime-protocol';

export function runtimeReleaseIdentity(
  identityFile = new URL('../../../build-identity.json', import.meta.url),
) {
  let raw: string;
  try {
    raw = readFileSync(identityFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return ReleaseIdentitySchema.parse(JSON.parse(raw));
}
