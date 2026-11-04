/**
 * HR-02.5A: injectable filesystem seam for sysfs/procfs reads.
 *
 * Production reads real files; tests inject an in-memory map. Every read
 * is non-fatal: missing files, permission errors, and oversized content
 * degrade to null so one unreadable path never breaks the whole profile.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";

export const FS_MAX_BYTES = 256 * 1024;

export interface FsReader {
  readTextFile(path: string, maxBytes?: number): string | null;
  exists(path: string): boolean;
  listDir(path: string): string[] | null;
}

export function nodeFsReader(): FsReader {
  return {
    readTextFile(path: string, maxBytes: number = FS_MAX_BYTES): string | null {
      try {
        const raw = readFileSync(path, "utf8");
        if (typeof raw !== "string") return null;
        return raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
      } catch {
        return null;
      }
    },
    exists(path: string): boolean {
      try {
        // existsSync (never reads file contents) so probing a system DLL
        // can never pull megabytes of binary data into the heap.
        return existsSync(path);
      } catch {
        return false;
      }
    },
    listDir(path: string): string[] | null {
      try {
        return readdirSync(path);
      } catch {
        return null;
      }
    },
  };
}

/** Deterministic in-memory FsReader for tests. */
export function mapFsReader(files: Record<string, string>, dirs: Record<string, string[]> = {}): FsReader {
  return {
    readTextFile(path: string, maxBytes: number = FS_MAX_BYTES): string | null {
      const raw = files[path];
      if (typeof raw !== "string") return null;
      return raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
    },
    exists(path: string): boolean {
      return typeof files[path] === "string" || Array.isArray(dirs[path]);
    },
    listDir(path: string): string[] | null {
      const entries = dirs[path];
      return Array.isArray(entries) ? [...entries] : null;
    },
  };
}
