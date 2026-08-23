/**
 * HTTP memory API validation (spec sections 30, 32).
 *
 * Strict schemas with no domain/namespace/database/context_key fields:
 * every endpoint resolves the memory domain from the server-side session
 * record, so client-supplied isolation hints are impossible by construction.
 */

import { z } from "zod";

import { invalidRequest } from "../core/errors/errors";
import { MEMORY_TYPE_BY_LABEL, MemoryListFilter, MemoryType } from "./contracts";

const identifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Invalid identifier format");
const clientRequestIdSchema = z.string().min(1).max(200);
const keySchema = z.string().min(1).max(128);
const typeLabelSchema = z.enum(["episodic", "semantic", "project", "document", "procedural", "temporary"]);

function formatIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw invalidRequest("Invalid memory request", { issues: formatIssues(result.error) });
  }
  return result.data;
}

export function parseTypeLabel(label: string): MemoryType {
  const type = MEMORY_TYPE_BY_LABEL[label];
  if (!type) throw invalidRequest("Invalid memory type");
  return type;
}

export const rememberBodySchema = z
  .object({
    session_id: identifierSchema,
    client_request_id: clientRequestIdSchema,
    text: z.string().min(1).max(8000),
    type: typeLabelSchema,
    subject_key: keySchema.optional(),
    project_key: keySchema.optional(),
  })
  .strict();

export type RememberBody = z.infer<typeof rememberBodySchema>;

export const searchBodySchema = z
  .object({
    session_id: identifierSchema,
    query: z.string().min(1).max(2000),
    top_k: z.number().int().min(1).max(40).optional(),
    project_key: keySchema.optional(),
    allowed_types: z.array(typeLabelSchema).max(6).optional(),
  })
  .strict();

export type SearchBody = z.infer<typeof searchBodySchema>;

export const documentBodySchema = z
  .object({
    session_id: identifierSchema,
    client_request_id: clientRequestIdSchema,
    title: z.string().min(1).max(500),
    source_type: z.enum(["text", "markdown"]),
    content: z.string().min(1).max(1_000_000),
    project_key: keySchema.optional(),
  })
  .strict();

export type DocumentBody = z.infer<typeof documentBodySchema>;

export function parseRememberBody(input: unknown): RememberBody {
  return parse(rememberBodySchema, input);
}

export function parseSearchBody(input: unknown): SearchBody {
  return parse(searchBodySchema, input);
}

export function parseDocumentBody(input: unknown): DocumentBody {
  return parse(documentBodySchema, input);
}

export function parseListParams(params: Record<string, string>): { session_id: string; filter: MemoryListFilter } {
  const schema = z
    .object({
      session_id: identifierSchema,
      status: z.enum(["ACTIVE", "SUPERSEDED", "DELETED", "EXPIRED"]).optional(),
      type: typeLabelSchema.optional(),
      project_key: keySchema.optional(),
      subject_key: keySchema.optional(),
      limit: z.string().regex(/^[0-9]{1,4}$/).optional(),
      offset: z.string().regex(/^[0-9]{1,6}$/).optional(),
    })
    .strict();
  const parsed = parse(schema, params);
  return {
    session_id: parsed.session_id,
    filter: {
      domain: "personal", // replaced by the service from the trusted session
      status: parsed.status,
      type: parsed.type ? MEMORY_TYPE_BY_LABEL[parsed.type] : undefined,
      project_key: parsed.project_key,
      subject_key: parsed.subject_key,
      limit: parsed.limit ? Number(parsed.limit) : undefined,
      offset: parsed.offset ? Number(parsed.offset) : undefined,
    },
  };
}

export function parseQueryParams(url: string | undefined): Record<string, string> {
  const query = (url ?? "").split("?", 2)[1];
  if (!query) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(query)) {
    out[key] = value;
  }
  return out;
}
