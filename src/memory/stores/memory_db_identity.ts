/**
 * SC-01A - Physical database identity guard v2 (freeze invariant M2).
 *
 * Resolves the physical identity of a configured database path:
 * configured path -> absolute path -> real filesystem path ->
 * filesystem device/inode identity when the file exists.
 *
 * ":memory:" stays a special test-only case: two in-memory handles are two
 * separate private SQLite databases, so they are always allowed.
 *
 * Broken or ambiguous filesystem aliases fail closed.
 */

import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface MemoryDbIdentity {
  requested: string;
  absolute: string;
  canonical: string;
  exists: boolean;
  dev?: number;
  ino?: number;
}

const IN_MEMORY = ":memory:";

function failClosed(message: string): never {
  throw new Error("Memory database identity cannot be established (fail-closed): " + message);
}

function resolveRealTarget(absolute: string): { canonical: string; exists: boolean } {
  try {
    return { canonical: realpathSync(absolute), exists: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") failClosed(absolute + ": " + ((error as Error)?.message ?? String(error)));
    let parent = dirname(absolute);
    const remainder: string[] = [basename(absolute)];
    for (;;) {
      try {
        const realParent = realpathSync(parent);
        const canonical = remainder.length > 0 ? join(realParent, ...remainder) : realParent;
        return { canonical, exists: false };
      } catch (parentError) {
        const parentCode = (parentError as NodeJS.ErrnoException | undefined)?.code;
        if (parentCode !== "ENOENT") {
          failClosed(absolute + ": " + ((parentError as Error)?.message ?? String(parentError)));
        }
        const next = dirname(parent);
        if (next === parent) {
          failClosed(absolute + ": no resolvable filesystem parent");
        }
        const segment = parent.slice(next.length).replace(/^[/\\]+/, "");
        remainder.unshift(segment);
        parent = next;
      }
    }
  }
}

export function resolveMemoryDbIdentity(configuredPath: string): MemoryDbIdentity {
  const requested = (configuredPath ?? "").trim();
  if (requested === "") failClosed("empty database path");
  if (requested === IN_MEMORY) {
    return { requested, absolute: IN_MEMORY, canonical: IN_MEMORY, exists: false };
  }
  const absolute = resolve(requested);
  const resolved = resolveRealTarget(absolute);
  const canonical = process.platform === "win32" ? resolved.canonical.toLowerCase() : resolved.canonical;
  const identity: MemoryDbIdentity = { requested, absolute, canonical, exists: resolved.exists };
  if (resolved.exists) {
    try {
      const stats = statSync(absolute);
      identity.dev = stats.dev;
      identity.ino = stats.ino;
    } catch (error) {
      failClosed(absolute + ": " + ((error as Error)?.message ?? String(error)));
    }
  }
  return identity;
}

/**
 * Assert that two configured database paths point at physically distinct
 * databases. Throws on same canonical target, same device+inode, or any
 * ambiguous/broken alias. Two ":memory:" paths are the only allowed alias.
 */
export function assertDistinctMemoryDatabases(personalPath: string, businessPath: string): void {
  const personal = resolveMemoryDbIdentity(personalPath);
  const business = resolveMemoryDbIdentity(businessPath);
  if (personal.canonical === IN_MEMORY && business.canonical === IN_MEMORY) return;
  if (personal.canonical === business.canonical) {
    throw new Error("Personal and Business memory databases must use different physical files (both resolve to " + personal.canonical + ")");
  }
  if (
    personal.exists &&
    business.exists &&
    personal.dev !== undefined &&
    business.dev !== undefined &&
    personal.ino !== undefined &&
    business.ino !== undefined &&
    personal.dev === business.dev &&
    personal.ino === business.ino
  ) {
    throw new Error("Personal and Business memory databases are the same physical file (device " + String(personal.dev) + ", inode " + String(personal.ino) + ")");
  }
}
