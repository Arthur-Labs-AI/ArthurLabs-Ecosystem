/**
 * SC-04 local filesystem capability adapter (spec sections 19-40).
 *
 * Capability implementation behind the filesystem.* tools. Every method
 * takes (root_id, relative_path) only: absolute paths never enter, and
 * every access funnels through scoped_path resolution (lexical +
 * physical containment). Symlinks: list/stat report type=symlink
 * without traversal; read_text rejects symlinks; search never follows
 * them. Only regular UTF-8 files are readable, with bounded paging.
 * Cancellation is cooperative via AbortSignal (effects = none).
 */

import { promises as fsp, lstatSync, realpathSync, type Dirent } from "node:fs";
import * as path from "node:path";
import { probeStorage } from "../storage_probe";

import { capabilityUnavailable, resourceNotFound, resourceUnsupported, scopeViolation } from "../capability_errors";
import {
  assertNotSensitive,
  assertPhysicalContainment,
  DEFAULT_SENSITIVE_POLICY,
  resolveLexical,
  type FilesystemScopeRegistry,
  type SensitivePathPolicy,
} from "../scoped_path";

export type FilesystemEntryType = "file" | "directory" | "symlink" | "other";

export interface FilesystemEntry {
  name: string;
  type: FilesystemEntryType;
  size_bytes: number;
}

export interface FilesystemStat {
  type: FilesystemEntryType;
  size_bytes: number;
  modified_at: string;
  readable: boolean;
}

export interface FilesystemReadText {
  start_line: number;
  end_line: number;
  text: string;
  truncated: boolean;
  next_line: number | null;
}

export interface FilesystemSearchMatch {
  root_id: string;
  relative_path: string;
  line_number: number | null;
  snippet: string;
}

export interface FilesystemSearchBounds {
  max_results: number;
  max_files_scanned: number;
  max_bytes_per_file: number;
  max_total_bytes: number;
}

export const DEFAULT_SEARCH_BOUNDS: FilesystemSearchBounds = {
  max_results: 50,
  max_files_scanned: 5000,
  max_bytes_per_file: 1024 * 1024,
  max_total_bytes: 50 * 1024 * 1024,
};

/** Directories skipped by default recursive search (perf, not security). */
export const SEARCH_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".cache",
]);

export interface LocalFilesystemAdapter {
  listRoots(): Array<{ id: string; label: string }>;
  list(rootId: string, rel: string, offset: number, limit: number, signal?: AbortSignal): Promise<FilesystemEntry[]>;
  stat(rootId: string, rel: string, signal?: AbortSignal): Promise<FilesystemStat>;
  readText(rootId: string, rel: string, startLine: number, maxLines: number, maxBytes: number, signal?: AbortSignal): Promise<FilesystemReadText>;
  search(rootId: string, rel: string, query: string, mode: string, maxResults: number, signal?: AbortSignal): Promise<FilesystemSearchMatch[]>;
  storage(): Promise<Array<{ root_id: string; total_bytes: number; free_bytes: number }>>;
}

export interface NodeFilesystemOptions {
  searchBounds?: Partial<FilesystemSearchBounds>;
  sensitive?: SensitivePathPolicy | null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("cancelled");
    (err as { code?: string }).code = "TOOL_CANCELLED";
    throw err;
  }
}

function classifyDirent(d: Dirent, size: number): FilesystemEntry {
  if (d.isSymbolicLink()) return { name: d.name, type: "symlink", size_bytes: 0 };
  if (d.isDirectory()) return { name: d.name, type: "directory", size_bytes: 0 };
  if (d.isFile()) return { name: d.name, type: "file", size_bytes: Math.max(0, size) };
  return { name: d.name, type: "other", size_bytes: 0 };
}

/** Deterministic ordering: directories first, then files, by name. */
export function sortFilesystemEntries(entries: FilesystemEntry[]): FilesystemEntry[] {
  const rank = (t: FilesystemEntryType): number => (t === "directory" ? 0 : t === "file" ? 1 : t === "symlink" ? 2 : 3);
  return [...entries].sort((a, b) => rank(a.type) - rank(b.type) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
export class NodeLocalFilesystemAdapter implements LocalFilesystemAdapter {
  private readonly scopes: FilesystemScopeRegistry;
  private readonly searchBounds: FilesystemSearchBounds;
  private readonly sensitive: SensitivePathPolicy | null;

  constructor(scopes: FilesystemScopeRegistry, opts: NodeFilesystemOptions = {}) {
    this.scopes = scopes;
    this.searchBounds = { ...DEFAULT_SEARCH_BOUNDS, ...(opts.searchBounds ?? {}) };
    this.sensitive = opts.sensitive === undefined ? DEFAULT_SENSITIVE_POLICY : opts.sensitive;
  }

  listRoots(): Array<{ id: string; label: string }> {
    return this.scopes.list().map((s) => ({ id: s.id, label: s.label }));
  }

  async list(rootId: string, rel: string, offset: number, limit: number, signal?: AbortSignal): Promise<FilesystemEntry[]> {
    throwIfAborted(signal);
    const display = rel === "" ? "." : rel;
    this.scopes.requirePermission(rootId, "list", display);
    const scope = this.scopes.get(rootId);
    const realRoot = this.scopes.realRoot(rootId);
    const candidate = resolveLexical(rootId, scope.physical_root, rel);
    let lst;
    try {
      lst = lstatSync(candidate);
    } catch {
      throw resourceNotFound(rootId, display);
    }
    if (lst.isSymbolicLink()) {
      throw scopeViolation(rootId, display);
    }
    let realTarget: string;
    try {
      realTarget = realpathSync(candidate);
    } catch {
      throw resourceNotFound(rootId, display);
    }
    assertPhysicalContainment(rootId, display, realRoot, realTarget);
    let st;
    try {
      st = lstatSync(realTarget);
    } catch {
      throw resourceNotFound(rootId, display);
    }
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw resourceUnsupported("Not a directory", rootId, display);
    }
    let dirents;
    try {
      dirents = await fsp.readdir(realTarget, { withFileTypes: true });
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") throw resourceNotFound(rootId, display);
      throw capabilityUnavailable("filesystem.list");
    }
    const entries: FilesystemEntry[] = [];
    for (const d of dirents as Dirent[]) {
      throwIfAborted(signal);
      let size = 0;
      try {
        if (d.isFile()) size = lstatSync(path.join(realTarget, d.name)).size;
      } catch {
        size = 0;
      }
      entries.push(classifyDirent(d, size));
    }
    return sortFilesystemEntries(entries).slice(offset, offset + limit);
  }

  async stat(rootId: string, rel: string, signal?: AbortSignal): Promise<FilesystemStat> {
    throwIfAborted(signal);
    const display = rel === "" ? "." : rel;
    this.scopes.requirePermission(rootId, "stat", display);
    const scope = this.scopes.get(rootId);
    const realRoot = this.scopes.realRoot(rootId);
    const candidate = resolveLexical(rootId, scope.physical_root, rel);
    let st;
    try {
      st = lstatSync(candidate);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") throw resourceNotFound(rootId, display);
      throw capabilityUnavailable("filesystem.stat");
    }
    if (st.isSymbolicLink()) {
      return { type: "symlink", size_bytes: 0, modified_at: st.mtime.toISOString(), readable: false };
    }
    let realForStat: string;
    try {
      realForStat = realpathSync(candidate);
    } catch {
      throw resourceNotFound(rootId, display);
    }
    assertPhysicalContainment(rootId, display, realRoot, realForStat);
    if (st.isDirectory()) return { type: "directory", size_bytes: 0, modified_at: st.mtime.toISOString(), readable: true };
    if (st.isFile()) {
      let readable = true;
      try {
        await fsp.access(candidate);
      } catch {
        readable = false;
      }
      return { type: "file", size_bytes: Math.max(0, st.size), modified_at: st.mtime.toISOString(), readable: readable };
    }
    return { type: "other", size_bytes: 0, modified_at: st.mtime.toISOString(), readable: false };
  }

  async readText(
    rootId: string,
    rel: string,
    startLine: number,
    maxLines: number,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<FilesystemReadText> {
    throwIfAborted(signal);
    if (rel === "" || rel === ".") throw resourceUnsupported("Cannot read a directory", rootId, ".");
    this.scopes.requirePermission(rootId, "read", rel);
    if (this.sensitive !== null) assertNotSensitive(rootId, rel, this.sensitive);
    const scope = this.scopes.get(rootId);
    const realRoot = this.scopes.realRoot(rootId);
    const candidate = resolveLexical(rootId, scope.physical_root, rel);
    let st;
    try {
      st = lstatSync(candidate);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") throw resourceNotFound(rootId, rel);
      throw capabilityUnavailable("filesystem.read_text");
    }
    if (st.isSymbolicLink()) {
      let linkReal: string;
      try {
        linkReal = realpathSync(candidate);
      } catch {
        throw scopeViolation(rootId, rel);
      }
      assertPhysicalContainment(rootId, rel, realRoot, linkReal);
      throw resourceUnsupported("Symlink targets are not readable in v1", rootId, rel);
    }
    if (!st.isFile()) {
      throw resourceUnsupported("Only regular files may be read as text", rootId, rel);
    }
    let realTarget: string;
    try {
      realTarget = realpathSync(candidate);
    } catch {
      throw resourceNotFound(rootId, rel);
    }
    assertPhysicalContainment(rootId, rel, realRoot, realTarget);
    let handle;
    try {
      handle = await fsp.open(realTarget, "r");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") throw resourceNotFound(rootId, rel);
      throw capabilityUnavailable("filesystem.read_text");
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw resourceUnsupported("Only regular files may be read as text", rootId, rel);
      }
      const toRead = Math.min(stat.size, Math.max(1, maxBytes) + 64 * 1024);
      const buf = Buffer.alloc(Math.max(0, toRead));
      await handle.read(buf, 0, buf.length, 0);
      throwIfAborted(signal);
      const slice = buf.subarray(0, Math.min(buf.length, Math.max(1, maxBytes) + 1024));
      if (slice.includes(0)) {
        throw resourceUnsupported("Binary data is not readable as text", rootId, rel);
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(slice);
      } catch {
        throw resourceUnsupported("File is not valid UTF-8 text", rootId, rel);
      }
      const lines = text.split("\n");
      const startIdx = Math.max(1, startLine) - 1;
      const picked = lines.slice(startIdx, startIdx + Math.max(1, maxLines));
      let joined = picked.join("\n");
      let truncated = startIdx + picked.length < lines.length || buf.length > slice.length || stat.size > toRead;
      const budget = Math.max(1, maxBytes);
      const encoded = Buffer.byteLength(joined, "utf8");
      if (encoded > budget) {
        let cut = joined;
        while (Buffer.byteLength(cut, "utf8") > budget && cut.length > 0) {
          cut = cut.slice(0, Math.max(0, cut.length - 256));
        }
        joined = cut;
        truncated = true;
      }
      const endLine = startIdx + picked.length;
      return {
        start_line: Math.max(1, startLine),
        end_line: endLine,
        text: joined,
        truncated: truncated,
        next_line: truncated ? endLine + 1 : null,
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  async search(
    rootId: string,
    rel: string,
    query: string,
    mode: string,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<FilesystemSearchMatch[]> {
    throwIfAborted(signal);
    const display = rel === "" ? "." : rel;
    this.scopes.requirePermission(rootId, "search", display);
    if (query.length === 0) {
      throw resourceUnsupported("Search query must not be empty", rootId, display);
    }
    const scope = this.scopes.get(rootId);
    const realRoot = this.scopes.realRoot(rootId);
    const candidate = resolveLexical(rootId, scope.physical_root, rel);
    let realTarget: string;
    try {
      realTarget = realpathSync(candidate);
    } catch {
      throw resourceNotFound(rootId, display);
    }
    assertPhysicalContainment(rootId, display, realRoot, realTarget);
    // Literal-only modes (spec 34-35): "content" must NOT also match
    // filenames; "filename" must NOT scan contents. Unknown modes fail
    // closed (the tool schema normally rejects them first).
    if (mode !== "filename" && mode !== "content" && mode !== "both") {
      throw resourceUnsupported("Unknown search mode", rootId, display);
    }
    const wantFile = mode === "filename" || mode === "both";
    const wantContent = mode === "content" || mode === "both";
    const bounds = this.searchBounds;
    const limit = Math.min(Math.max(1, maxResults), bounds.max_results);
    const needle = query.toLowerCase();
    const matches: FilesystemSearchMatch[] = [];
    let filesScanned = 0;
    let totalBytes = 0;
    const stack: string[] = [realTarget];
    const seenDirs = new Set<string>([realTarget]);
    while (stack.length > 0 && matches.length < limit) {
      throwIfAborted(signal);
      const dir = stack.pop() as string;
      let dirents;
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const ordered = [...dirents].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const d of ordered) {
        throwIfAborted(signal);
        if (matches.length >= limit) break;
        const abs = path.join(dir, d.name);
        if (d.isSymbolicLink()) continue;
        if (d.isDirectory()) {
          if (SEARCH_SKIP_DIRS.has(d.name)) continue;
          try {
            const real = realpathSync(abs);
            if (seenDirs.has(real)) continue;
            seenDirs.add(real);
            assertPhysicalContainment(rootId, display, realRoot, real);
            stack.push(real);
          } catch {
            continue;
          }
          continue;
        }
        if (!d.isFile()) continue;
        if (wantFile && d.name.toLowerCase().includes(needle)) {
          const relPath = toRootRelative(realRoot, abs);
          if (relPath !== null) {
            matches.push({ root_id: rootId, relative_path: relPath, line_number: null, snippet: d.name.slice(0, 200) });
            if (matches.length >= limit) break;
          }
        }
        if (!wantContent) continue;
        if (filesScanned >= bounds.max_files_scanned) return matches;
        let st;
        try {
          st = lstatSync(abs);
        } catch {
          continue;
        }
        if (!st.isFile() || st.size > bounds.max_bytes_per_file) continue;
        if (totalBytes + Math.min(st.size, bounds.max_bytes_per_file) > bounds.max_total_bytes) return matches;
        filesScanned += 1;
        totalBytes += Math.min(st.size, bounds.max_bytes_per_file);
        // F14 per-file byte bound: the content scanner must honor the SAME
        // trusted cap, never a hardcoded constant, so a match past the
        // allowance is unobservable by the model.
        const found = await scanFileContent(abs, realRoot, rootId, needle, 200, bounds.max_bytes_per_file);
        for (const f of found) {
          matches.push(f);
          if (matches.length >= limit) break;
        }
      }
    }
    return matches;
  }

  async storage(): Promise<Array<{ root_id: string; total_bytes: number; free_bytes: number }>> {
    const out: Array<{ root_id: string; total_bytes: number; free_bytes: number }> = [];
    for (const scope of this.scopes.list()) {
      const probed = probeStorage(scope.physical_root);
      out.push({ root_id: scope.id, total_bytes: probed.total_bytes, free_bytes: probed.free_bytes });
    }
    return out;
  }
}

function toRootRelative(realRoot: string, abs: string): string | null {
  const relative = path.relative(realRoot, abs);
  if (relative === "" || relative === ".") return null;
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

async function scanFileContent(
  abs: string,
  realRoot: string,
  rootId: string,
  needle: string,
  snippetMax: number,
  maxBytesPerFile: number = 1024 * 1024,
): Promise<FilesystemSearchMatch[]> {
  const out: FilesystemSearchMatch[] = [];
  let handle;
  try {
    handle = await fsp.open(abs, "r");
  } catch {
    return out;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return out;
    const size = Math.min(stat.size, Math.max(1, maxBytesPerFile));
    if (size <= 0) return out;
    const buf = Buffer.alloc(size);
    await handle.read(buf, 0, buf.length, 0);
    if (buf.subarray(0, Math.min(buf.length, 8192)).includes(0)) return out;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      return out;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      const idx = line.toLowerCase().indexOf(needle);
      if (idx >= 0) {
        const start = Math.max(0, idx - 60);
        const snippet = line.slice(start, start + snippetMax);
        const relPath = toRootRelative(realRoot, abs);
        if (relPath !== null) {
          out.push({ root_id: rootId, relative_path: relPath, line_number: i + 1, snippet: snippet });
        }
        if (out.length >= 10) break;
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return out;
}
