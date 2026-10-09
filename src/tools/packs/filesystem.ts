/**
 * SC-04 filesystem tool pack (spec sections 17-40, 60).
 *
 * filesystem.roots / list / stat / read_text / search. All take
 * (root_id, path) only: absolute paths are schema-rejected and
 * scope-checked. Read risk, effects=none, cooperative cancellation.
 * Bounds are trusted config (filesystem_bounds), never model args:
 * list limit<=200, read max_lines<=200 and ~12KiB, search literal-only.
 */

import { ArthurMode } from "../../core/modes/mode";
import type { LocalCapabilityHost } from "../local_host";
import type { ToolRegistry } from "../registry";

export interface FilesystemPackBounds {
  list_limit_max: number;
  read_max_lines: number;
  read_max_bytes: number;
  search_max_results: number;
}

export const DEFAULT_PACK_BOUNDS: FilesystemPackBounds = {
  list_limit_max: 200,
  read_max_lines: 200,
  read_max_bytes: 12 * 1024,
  search_max_results: 50,
};

const ROOT_ID_SCHEMA = { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_]*$" };
const REL_PATH_SCHEMA = { type: "string", minLength: 1, maxLength: 4096 };

export function registerFilesystemPack(
  registry: ToolRegistry,
  host: LocalCapabilityHost,
  bounds: FilesystemPackBounds = DEFAULT_PACK_BOUNDS,
): void {
  registry.register(
    {
      name: "filesystem.roots",
      version: "1.0.0",
      description: "List the filesystem scopes ARTHUR may use (id + label only, no physical paths). Read-only.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      output_schema: {
        type: "object",
        properties: {
          roots: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: { type: "string" },
              },
              required: ["id", "label"],
              additionalProperties: false,
            },
          },
        },
        required: ["roots"],
        additionalProperties: false,
      },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
    },
    async () => {
      const roots = host.filesystem.listRoots();
      return { ok: true, summary: roots.length + " filesystem scope(s)", data: { roots: roots } };
    },
  );

  registry.register(
    {
      name: "filesystem.list",
      version: "1.0.0",
      description: "List entries of a scoped directory (deterministic order, paged). Read-only.",
      input_schema: {
        type: "object",
        properties: {
          root_id: ROOT_ID_SCHEMA,
          path: REL_PATH_SCHEMA,
          offset: { type: "integer", minimum: 0, maximum: 1000000 },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        required: ["root_id", "path"],
        additionalProperties: false,
      },
      output_schema: {
        type: "object",
        properties: {
          entries: {
            type: "array",
            maxItems: 200,
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                type: { type: "string", enum: ["file", "directory", "symlink", "other"] },
                size_bytes: { type: "integer", minimum: 0 },
              },
              required: ["name", "type", "size_bytes"],
              additionalProperties: false,
            },
          },
        },
        required: ["entries"],
        additionalProperties: false,
      },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
    },
    async (args, ctx) => {
      const limit = Math.min(Number(args.limit ?? 50), bounds.list_limit_max);
      const offset = Math.max(0, Number(args.offset ?? 0));
      const entries = await host.filesystem.list(String(args.root_id), String(args.path), offset, limit, ctx.signal);
      return { ok: true, summary: entries.length + " entries", data: { entries: entries } };
    },
  );

  registry.register(
    {
      name: "filesystem.stat",
      version: "1.0.0",
      description: "Return bounded metadata for one scoped path (lstat semantics for symlinks). Read-only.",
      input_schema: {
        type: "object",
        properties: { root_id: ROOT_ID_SCHEMA, path: REL_PATH_SCHEMA },
        required: ["root_id", "path"],
        additionalProperties: false,
      },
      output_schema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["file", "directory", "symlink", "other"] },
          size_bytes: { type: "integer", minimum: 0 },
          modified_at: { type: "string" },
          readable: { type: "boolean" },
        },
        required: ["type", "size_bytes", "modified_at", "readable"],
        additionalProperties: false,
      },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
    },
    async (args, ctx) => {
      const stat = await host.filesystem.stat(String(args.root_id), String(args.path), ctx.signal);
      return { ok: true, summary: stat.type + " (" + stat.size_bytes + " bytes)", data: stat };
    },
  );

  registry.register(
    {
      name: "filesystem.read_text",
      version: "1.0.0",
      description: "Read a bounded page of a scoped UTF-8 text file. Regular files only; symlinks/binary rejected. Read-only.",
      input_schema: {
        type: "object",
        properties: {
          root_id: ROOT_ID_SCHEMA,
          path: REL_PATH_SCHEMA,
          start_line: { type: "integer", minimum: 1, maximum: 10000000 },
          max_lines: { type: "integer", minimum: 1, maximum: 200 },
        },
        required: ["root_id", "path"],
        additionalProperties: false,
      },
      output_schema: {
        type: "object",
        properties: {
          start_line: { type: "integer", minimum: 1 },
          end_line: { type: "integer", minimum: 0 },
          text: { type: "string", maxLength: 16384 },
          truncated: { type: "boolean" },
          next_line: { type: ["integer", "null"], minimum: 1 },
        },
        required: ["start_line", "end_line", "text", "truncated", "next_line"],
        additionalProperties: false,
      },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
    },
    async (args, ctx) => {
      const startLine = Math.max(1, Number(args.start_line ?? 1));
      const maxLines = Math.min(Number(args.max_lines ?? 120), bounds.read_max_lines);
      const read = await host.filesystem.readText(String(args.root_id), String(args.path), startLine, maxLines, bounds.read_max_bytes, ctx.signal);
      return {
        ok: true,
        summary: "lines " + read.start_line + "-" + read.end_line + (read.truncated ? " (truncated)" : ""),
        data: read,
      };
    },
  );

  registry.register(
    {
      name: "filesystem.search",
      version: "1.0.0",
      description: "Bounded literal-text search over a scoped directory (never follows symlinks). Read-only.",
      input_schema: {
        type: "object",
        properties: {
          root_id: ROOT_ID_SCHEMA,
          path: REL_PATH_SCHEMA,
          query: { type: "string", minLength: 1, maxLength: 256 },
          mode: { type: "string", enum: ["filename", "content", "both"] },
          max_results: { type: "integer", minimum: 1, maximum: 50 },
        },
        required: ["root_id", "path", "query"],
        additionalProperties: false,
      },
      output_schema: {
        type: "object",
        properties: {
          matches: {
            type: "array",
            maxItems: 50,
            items: {
              type: "object",
              properties: {
                root_id: { type: "string" },
                relative_path: { type: "string" },
                line_number: { type: ["integer", "null"] },
                snippet: { type: "string", maxLength: 512 },
              },
              required: ["root_id", "relative_path", "snippet"],
              additionalProperties: false,
            },
          },
        },
        required: ["matches"],
        additionalProperties: false,
      },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
    },
    async (args, ctx) => {
      const maxResults = Math.min(Number(args.max_results ?? 30), bounds.search_max_results);
      const matches = await host.filesystem.search(
        String(args.root_id),
        String(args.path),
        String(args.query),
        String(args.mode ?? "both"),
        maxResults,
        ctx.signal,
      );
      return { ok: true, summary: matches.length + " match(es)", data: { matches: matches } };
    },
  );
}
