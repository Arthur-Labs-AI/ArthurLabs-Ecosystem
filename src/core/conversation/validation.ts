/**
 * Strict request validation (spec sections 6.2, 18).
 *
 * External input is validated with strict schemas and size limits before any
 * work is performed.
 */

import { createHash } from "node:crypto";

import { z } from "zod";

import { invalidRequest } from "../errors/errors";
import { ArthurMode } from "../modes/mode";
import type { TurnRequest } from "./models";

export const modeSchema = z.enum([ArthurMode.PERSONAL, ArthurMode.BUSINESS]);
export const clientTypeSchema = z.enum(["cli", "desktop", "mobile", "web", "voice"]);
const identifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Invalid identifier format");

const turnRequestSchema = z.object({
  session_id: identifierSchema.optional(),
  mode: modeSchema,
  message: z.string().min(1),
  client_request_id: z.string().min(1).max(200),
  metadata: z
    .object({
      client_type: clientTypeSchema.optional(),
    })
    .strict()
    .optional(),
}).strict();

const modeChangeSchema = z.object({
  mode: modeSchema,
}).strict();

function formatIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
}

export function parseTurnRequest(input: unknown, maxMessageChars: number): TurnRequest {
  const result = turnRequestSchema.safeParse(input);
  if (!result.success) {
    throw invalidRequest("Invalid turn request", { issues: formatIssues(result.error) });
  }
  if (result.data.message.length > maxMessageChars) {
    throw invalidRequest(`Message exceeds maximum length of ${maxMessageChars} characters`, {
      max_message_chars: maxMessageChars,
    });
  }
  return result.data;
}

export function parseRouteIdentifier(input: string, kind: "session" | "approval" | "memory" | "document" | "execution"): string {
  const result = identifierSchema.safeParse(input);
  if (!result.success) {
    throw invalidRequest(`Invalid ${kind} identifier`);
  }
  return result.data;
}

export function parseModeChange(input: unknown): { mode: ArthurMode } {
  const result = modeChangeSchema.safeParse(input);
  if (!result.success) {
    throw invalidRequest("Invalid mode change request", { issues: formatIssues(result.error) });
  }
  return { mode: result.data.mode };
}

/**
 * Globally unique operation identity. The request digest binds message, mode,
 * session, and client metadata so key reuse cannot disclose an old response.
 */
export function idempotencyKey(request: TurnRequest): string {
  // Client request ids are globally unique operation identities. Session and
  // mode remain in requestHash, so reusing a key for another session/mode is a
  // conflict rather than a cached-response disclosure.
  return `request:${request.client_request_id}`;
}

/** Stable digest of the normalized request, used to detect key reuse. */
export function requestHash(request: TurnRequest): string {
  const normalized = {
    mode: request.mode,
    message: request.message,
    session_id: request.session_id ?? null,
    client_request_id: request.client_request_id,
    client_type: request.metadata?.client_type ?? null,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}