/**
 * Extraction schemas + strict parsing (spec section 20).
 *
 * The extractor output is data: it is validated against a fixed JSON schema
 * before any policy or write runs. Malformed output is discarded.
 */

import { z } from "zod";

import { MEMORY_TYPES, MemoryType } from "../contracts";

export interface MemoryCandidate {
  text: string;
  type: MemoryType;
  subject_key?: string;
  project_key?: string;
  confidence: number;
  importance: number;
  reason: string;
  should_store: boolean;
}

export const memoryCandidateSchema = z
  .object({
    text: z.string().min(1).max(2000),
    type: z.enum(MEMORY_TYPES as unknown as [MemoryType, ...MemoryType[]]),
    subject_key: z.string().min(1).max(128).optional(),
    project_key: z.string().min(1).max(128).optional(),
    confidence: z.number().min(0).max(1),
    importance: z.number().min(0).max(1),
    reason: z.string().max(500),
    should_store: z.boolean(),
  })
  .strict();

export const memoryExtractionSchema = z
  .object({
    memories: z.array(memoryCandidateSchema).max(20),
  })
  .strict();

export interface ExtractionParseResult {
  ok: boolean;
  candidates: MemoryCandidate[];
}

/** Parse and strictly validate extractor output. Never throws. */
export function parseExtractionOutput(raw: string): ExtractionParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, candidates: [] };
  }
  const result = memoryExtractionSchema.safeParse(parsed);
  if (!result.success) return { ok: false, candidates: [] };
  return {
    ok: true,
    candidates: result.data.memories.map((c) => ({
      text: c.text,
      type: c.type,
      subject_key: c.subject_key,
      project_key: c.project_key,
      confidence: c.confidence,
      importance: c.importance,
      reason: c.reason,
      should_store: c.should_store,
    })),
  };
}
