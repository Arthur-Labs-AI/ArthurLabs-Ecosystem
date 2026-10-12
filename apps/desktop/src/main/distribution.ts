import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReleaseIdentitySchema, type ReleaseIdentity } from '@qa/runtime-protocol';

export function sourceUserDataPath(appData: string): string {
  return join(appData, '@qa', 'desktop');
}

export function readReleaseIdentity(appPath: string): ReleaseIdentity {
  return ReleaseIdentitySchema.parse(
    JSON.parse(readFileSync(join(appPath, 'build-identity.json'), 'utf8')),
  );
}

export function assertRuntimeIdentity(
  expected: ReleaseIdentity | undefined,
  hello: { runtimeVersion: string; sourceCommit?: string | undefined },
): void {
  if (
    expected !== undefined &&
    (hello.runtimeVersion !== expected.version || hello.sourceCommit !== expected.sourceCommit)
  ) {
    throw Object.assign(
      new Error(
        'Desktop/runtime release identity mismatch. Stop Sentry and run setup from the approved matching archive.',
      ),
      { code: 'RUNTIME_IDENTITY_MISMATCH' },
    );
  }
}
