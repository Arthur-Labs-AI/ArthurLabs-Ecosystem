/**
 * HR-02.5D2: streaming SHA-256 artifact verification.
 *
 * Policy (`VerificationMode`):
 * - required: mismatch (or unreadable file) fails the installation;
 *   the staged copy is deleted/quarantined so a corrupt artifact can
 *   never be promoted.
 * - optional: still verified when an expected hash is provided; without
 *   one the file passes through unverified (caller documents why).
 * - provider_verified: the caller attests an upstream mechanism already
 *   proved identity (e.g. a future trusted HF backend); this module
 *   records the attestation without re-hashing.
 *
 * TLS alone is never treated as artifact identity: `required` without a
 * known hash is a caller error, not a silent pass. Hashes are compared
 * as normalized lowercase hex; malformed expectations are rejected.
 */

import { ArthurError } from '../../../core/errors/errors';
import type { VerifiedArtifact, VerificationMode } from './contracts';

export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function normalizeSha256(expected: string): string {
  if (typeof expected !== 'string') {
    throw new ArthurError('INVALID_CONFIG', 'checksum must be a hex string');
  }
  const hex = expected.trim().toLowerCase();
  if (!SHA256_HEX_PATTERN.test(hex)) {
    throw new ArthurError('INVALID_CONFIG', 'malformed SHA-256 checksum');
  }
  return hex;
}

export interface VerifyFs {
  openRead(path: string): AsyncIterable<Uint8Array>;
  sizeOf(path: string): number;
  remove(path: string): void;
}

export function nodeVerifyFs(): VerifyFs {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  return {
    openRead(path: string): AsyncIterable<Uint8Array> {
      const stream = fs.createReadStream(path);
      return {
        [Symbol.asyncIterator]() {
          const it = stream as unknown as AsyncIterable<Uint8Array>;
          return it[Symbol.asyncIterator]();
        },
      };
    },
    sizeOf(path: string): number {
      return (fs.statSync(path) as { size: number }).size;
    },
    remove(path: string): void {
      try {
        fs.rmSync(path, { force: true });
      } catch {
        // best effort.
      }
    },
  };
}

export function memoryVerifyFs(files: Map<string, Uint8Array[]>): VerifyFs {
  return {
    openRead(path: string): AsyncIterable<Uint8Array> {
      const chunks = files.get(path);
      if (!chunks) throw new Error('ENOENT: ' + path);
      const snapshot = [...chunks];
      return {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          let i = 0;
          return {
            next(): Promise<IteratorResult<Uint8Array>> {
              if (i >= snapshot.length) return Promise.resolve({ done: true, value: undefined });
              const value = snapshot[i] as Uint8Array;
              i += 1;
              return Promise.resolve({ done: false, value });
            },
          };
        },
      };
    },
    sizeOf(path: string): number {
      const chunks = files.get(path);
      if (!chunks) throw new Error('ENOENT: ' + path);
      return chunks.reduce((n, c) => n + c.length, 0);
    },
    remove(path: string): void {
      files.delete(path);
    },
  };
}

export async function sha256OfFile(fs: VerifyFs, path: string): Promise<{ hex: string; bytes: number }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.openRead(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { hex: (hash.digest('hex') as string).toLowerCase(), bytes };
}

export interface VerifyRequest {
  mode: VerificationMode;
  expected_sha256?: string;
  quarantine?: boolean;
}

// Returns the verified artifact on success; throws INVALID_CONFIG on
// malformed expectations and TOOL_OUTPUT_INVALID-equivalent failures via
// ArthurError('TOOL_EXECUTION_FAILED') on mismatch so callers fail the
// installation without promotion. Corrupt staged copies are removed.
export async function verifyArtifact(fs: VerifyFs, path: string, request: VerifyRequest): Promise<VerifiedArtifact> {
  if (request.mode === 'provider_verified') {
    let bytes = 0;
    try {
      bytes = fs.sizeOf(path);
    } catch {
      bytes = 0;
    }
    // Identity was proved upstream; record the attestation explicitly.
    return { path, sha256_hex: 'provider-verified', bytes };
  }
  if (request.expected_sha256 === undefined) {
    if (request.mode === 'required') {
      throw new ArthurError('INVALID_CONFIG', 'checksum required but no expected hash was provided');
    }
    let bytes = 0;
    try {
      bytes = fs.sizeOf(path);
    } catch {
      bytes = 0;
    }
    return { path, sha256_hex: 'unverified', bytes };
  }
  const expected = normalizeSha256(request.expected_sha256);
  let actual: { hex: string; bytes: number };
  try {
    actual = await sha256OfFile(fs, path);
  } catch (err) {
    throw new ArthurError('TOOL_EXECUTION_FAILED', 'cannot read artifact for verification: ' + String(err instanceof Error ? err.message : err));
  }
  if (actual.hex !== expected) {
    try {
      fs.remove(path);
    } catch {
      // best effort quarantine.
    }
    throw new ArthurError('TOOL_EXECUTION_FAILED', 'checksum mismatch: artifact failed SHA-256 verification and was removed from staging');
  }
  return { path, sha256_hex: actual.hex, bytes: actual.bytes };
}
