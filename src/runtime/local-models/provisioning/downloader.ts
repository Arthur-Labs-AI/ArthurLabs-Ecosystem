/**
 * HR-02.5D2: streamed, bounded, trusted-source-only artifact downloader.
 *
 * Security model (origin trust vs transport safety are separate):
 * - ORIGIN TRUST lives in TrustedArtifactSource: an opaque code-owned
 *   handle constructed only by trusted installer code via the internal
 *   factory (absent from all public barrels) from literals the
 *   installer owns.
 *   URLs from user/LLM/persistent-state/downloaded-manifest data cannot
 *   manufacture one (the factory validates shape AND the type is opaque:
 *   no structural forgery through a plain object literal typechecks).
 * - TRANSPORT SAFETY lives in downloadArtifact(): HTTPS-only (initial
 *   URL AND every redirect), no credentials in URL, streamed `.part`
 *   writes promoted only on success, size/redirect/timeout bounds,
 *   deterministic AbortSignal cancellation.
 * - Hugging Face resolution (if needed) belongs in a dedicated trusted
 *   backend in E — this module never special-cases hosts.
 * - 401/403 maps to `auth_required` (no credential collection, logging,
 *   or persistence — see contracts.NO_CREDENTIALS).
 *
 * Transport is injected (HttpTransport seam): tests use fakes,
 * production uses the node:https adapter. No shell, no execution.
 */

import * as path from 'node:path';

import { ArthurError } from '../../../core/errors/errors';
import { assertInsideRoot, assertNoEscapeThroughLinks, canonicalizeRoot, type Pathoscopy } from './paths';
import type { DownloadedArtifact } from './contracts';

export const DOWNLOADER_DEFAULT_TIMEOUT_MS = 60000;
export const DOWNLOADER_DEFAULT_MAX_BYTES = 16 * 1024 * 1024 * 1024;
export const DOWNLOADER_DEFAULT_MAX_REDIRECTS = 5;

const SOURCE_BRAND = Symbol('TrustedArtifactSource');

/**
 * Opaque code-owned download origin. Construct ONLY via the internal
 * factory below, called from trusted installer/source definitions
 * (future E installers, co-located with this boundary). The brand
 * symbol cannot be forged from untrusted data at runtime, and the
 * factory rejects malformed URLs up front — so a TrustedArtifactSource
 * value reaching downloadArtifact() proves code-owned provenance.
 * A generic runtime caller MUST NOT be able to mint one: the factory
 * is intentionally absent from every public barrel (provisioning,
 * local-models, runtime). Module/API visibility is the boundary.
 */
export interface TrustedArtifactSource {
  readonly [SOURCE_BRAND]: true;
  readonly url: string;
  readonly label: string;
}

/**
 * @internal — trusted provisioning/installer boundary only. NOT exported
 * from any public barrel. Concrete E installers will call this from
 * code-owned literals they own; it must never wrap user/LLM/state data.
 */
export function internalDefineTrustedArtifactSource(url: string, label: string): TrustedArtifactSource {
  const checked = checkUrl(url).toString();
  if (typeof label !== 'string' || label.trim() === '' || label.length > 128) {
    throw new ArthurError('INVALID_CONFIG', 'trusted artifact source needs a non-empty label');
  }
  return { [SOURCE_BRAND]: true, url: checked, label: label.trim() };
}

function assertTrustedSource(value: unknown): TrustedArtifactSource {
  if (typeof value !== 'object' || value === null || (value as Record<symbol, unknown>)[SOURCE_BRAND] !== true) {
    throw new ArthurError('INVALID_CONFIG', 'download source is not a code-owned TrustedArtifactSource');
  }
  const source = value as TrustedArtifactSource;
  // Re-validate: defense in depth against brand-symbol smuggling across
  // realms or hand-built objects carrying the symbol.
  checkUrl(source.url);
  return source;
}

export interface DownloadRequest {
  source: TrustedArtifactSource;
  destPath: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  scope?: Pathoscopy | null;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  cancel: () => void;
}

export type HttpTransport = (url: string, options: { timeoutMs: number; signal?: AbortSignal }) => Promise<TransportResponse>;

export interface DownloadFs {
  createPart(destPath: string): { write(chunk: Uint8Array): void; closeOk(): string; closeDiscard(): void };
  remove(path: string): void;
}

export function nodeDownloadFs(): DownloadFs {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  return {
    createPart(destPath: string): { write(chunk: Uint8Array): void; closeOk(): string; closeDiscard(): void } {
      const part = destPath + '.part';
      fs.mkdirSync(path.dirname(part), { recursive: true });
      const fd = fs.openSync(part, 'w');
      return {
        write(chunk: Uint8Array): void {
          fs.writeSync(fd, chunk);
        },
        closeOk(): string {
          fs.closeSync(fd);
          fs.renameSync(part, destPath);
          return destPath;
        },
        closeDiscard(): void {
          try {
            fs.closeSync(fd);
          } catch {
            // best effort.
          }
          try {
            fs.rmSync(part, { force: true });
          } catch {
            // best effort.
          }
        },
      };
    },
    remove(p: string): void {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        // best effort.
      }
    },
  };
}

// In-memory download fs for tests: part writes accumulate, closeOk
// promotes part->dest, closeDiscard drops the part.
export function memoryDownloadFs(): DownloadFs & { files: Map<string, Uint8Array[]> } {
  const files = new Map<string, Uint8Array[]>();
  return {
    files,
    createPart(destPath: string): { write(chunk: Uint8Array): void; closeOk(): string; closeDiscard(): void } {
      const part = destPath + '.part';
      files.set(part, []);
      return {
        write(chunk: Uint8Array): void {
          const acc = files.get(part);
          if (acc) acc.push(chunk);
        },
        closeOk(): string {
          const acc = files.get(part) ?? [];
          files.delete(part);
          files.set(destPath, acc);
          return destPath;
        },
        closeDiscard(): void {
          files.delete(part);
        },
      };
    },
    remove(p: string): void {
      files.delete(p);
    },
  };
}

function checkUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ArthurError('INVALID_CONFIG', 'download url is malformed');
  }
  if (parsed.protocol !== 'https:') {
    throw new ArthurError('INVALID_CONFIG', 'download url must use https');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ArthurError('INVALID_CONFIG', 'download url must not embed credentials');
  }
  return parsed;
}

export async function downloadArtifact(root: string, transport: HttpTransport, fs: DownloadFs, request: DownloadRequest): Promise<DownloadedArtifact> {
  const source = assertTrustedSource(request.source);
  const dest = assertInsideRoot(root, request.destPath, 'download destination');
  if (request.scope) assertNoEscapeThroughLinks(canonicalizeRoot(root, request.scope), dest, 'download destination', request.scope);
  let current = checkUrl(source.url).toString();
  const timeoutMs = request.timeoutMs ?? DOWNLOADER_DEFAULT_TIMEOUT_MS;
  const maxBytes = request.maxBytes ?? DOWNLOADER_DEFAULT_MAX_BYTES;
  const maxRedirects = request.maxRedirects ?? DOWNLOADER_DEFAULT_MAX_REDIRECTS;

  if (request.signal && request.signal.aborted) {
    return { outcome: 'cancelled', bytes_written: 0, reason: 'download aborted before start' };
  }

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let response: TransportResponse;
    try {
      response = await transport(current, { timeoutMs, signal: request.signal });
    } catch (err) {
      if (request.signal && request.signal.aborted) {
        return { outcome: 'cancelled', bytes_written: 0, reason: 'download aborted' };
      }
      return { outcome: 'failed', bytes_written: 0, reason: 'download transport failed: ' + String(err instanceof Error ? err.message : err) };
    }
    if (response.status === 401 || response.status === 403) {
      try {
        response.cancel();
      } catch {
        // best effort.
      }
      return { outcome: 'auth_required', bytes_written: 0, reason: 'remote requires authentication (status ' + String(response.status) + '); use normal HF authentication, no token is collected here' };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers['location'] ?? response.headers['Location'] ?? '';
      try {
        response.cancel();
      } catch {
        // best effort.
      }
      if (hop === maxRedirects || location.trim() === '') {
        return { outcome: 'failed', bytes_written: 0, reason: 'redirect limit exceeded or missing location' };
      }
      let next = '';
      try {
        next = new URL(location, current).toString();
      } catch {
        return { outcome: 'failed', bytes_written: 0, reason: 'redirect location malformed' };
      }
      try {
        checkUrl(next);
      } catch {
        return { outcome: 'failed', bytes_written: 0, reason: 'redirect target must use https' };
      }
      current = next;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      try {
        response.cancel();
      } catch {
        // best effort.
      }
      return { outcome: 'failed', bytes_written: 0, reason: 'download failed with status ' + String(response.status) };
    }
    // Success: stream to .part with a hard byte cap.
    const part = fs.createPart(dest);
    let written = 0;
    try {
      for await (const chunk of response.body) {
        if (request.signal && request.signal.aborted) {
          try {
            response.cancel();
          } catch {
            // best effort.
          }
          part.closeDiscard();
          return { outcome: 'cancelled', bytes_written: written, reason: 'download aborted mid-transfer' };
        }
        written += chunk.length;
        if (written > maxBytes) {
          try {
            response.cancel();
          } catch {
            // best effort.
          }
          part.closeDiscard();
          return { outcome: 'failed', bytes_written: written, reason: 'artifact exceeds maximum size' };
        }
        part.write(chunk);
      }
    } catch (err) {
      part.closeDiscard();
      if (request.signal && request.signal.aborted) {
        return { outcome: 'cancelled', bytes_written: written, reason: 'download aborted mid-transfer' };
      }
      return { outcome: 'failed', bytes_written: written, reason: 'download stream failed: ' + String(err instanceof Error ? err.message : err) };
    }
    const finalPath = part.closeOk();
    return { outcome: 'downloaded', path: finalPath, bytes_written: written, reason: 'downloaded ' + String(written) + ' bytes' };
  }
  return { outcome: 'failed', bytes_written: 0, reason: 'redirect limit exceeded' };
}

export function nodeHttpTransport(): HttpTransport {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const https = require('node:https') as typeof import('node:https');
  return (url: string, options: { timeoutMs: number; signal?: AbortSignal }) =>
    new Promise<TransportResponse>((resolve, reject) => {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') {
        reject(new ArthurError('INVALID_CONFIG', 'download url must use https'));
        return;
      }
      const req = https.get(
        url,
        { timeout: options.timeoutMs },
        (res) => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers[k.toLowerCase()] = v;
            else if (Array.isArray(v) && typeof v[0] === 'string') headers[k.toLowerCase()] = v[0] as string;
          }
          const body: AsyncIterable<Uint8Array> = {
            [Symbol.asyncIterator]() {
              const stream = res as unknown as AsyncIterable<Uint8Array>;
              return stream[Symbol.asyncIterator]();
            },
          };
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body,
            cancel: () => {
              try {
                res.destroy();
              } catch {
                // best effort.
              }
            },
          });
        },
      );
      req.on('timeout', () => {
        try {
          req.destroy(new Error('download timed out'));
        } catch {
          // best effort.
        }
      });
      req.on('error', (err) => reject(err));
      if (options.signal) {
        if (options.signal.aborted) {
          try {
            req.destroy(new Error('aborted'));
          } catch {
            // best effort.
          }
          reject(new Error('aborted'));
          return;
        }
        options.signal.addEventListener('abort', () => {
          try {
            req.destroy(new Error('aborted'));
          } catch {
            // best effort.
          }
          reject(new Error('aborted'));
        }, { once: true });
      }
      req.end();
    });
}
