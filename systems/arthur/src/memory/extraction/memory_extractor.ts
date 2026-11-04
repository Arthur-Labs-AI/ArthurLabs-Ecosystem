/**
 * Automatic memory extraction (spec sections 20, 36, 44).
 *
 * Runs through the existing ModelGateway as a strict structured task: the
 * prompt asks for a fixed JSON shape, output is schema-validated, and
 * malformed output is discarded without affecting the conversation. The
 * extractor receives only same-mode, sanitized transcript text.
 */

import type { ModelGateway } from "../../models/contracts";
import type { ArthurMode } from "../../core/modes/mode";
import type { TurnRecord } from "../../sessions/models";
import { estimateTokens } from "../../observability/usage";
import { MemoryCandidate, parseExtractionOutput } from "./schemas";
import { decideCandidate, CandidateWritePolicy, DEFAULT_CANDIDATE_POLICY } from "../policy";

export interface MemoryExtractorOptions {
  gateway: ModelGateway;
  model: string;
  maxCandidates?: number;
  maxTranscriptTokens?: number;
  policy?: CandidateWritePolicy;
}

export interface ExtractionInput {
  mode: ArthurMode;
  history: TurnRecord[];
  userMessage: string;
  assistantText: string;
  traceId?: string;
  sessionId?: string;
}

export interface ExtractionResult {
  candidates: MemoryCandidate[];
  malformed: boolean;
}

const SYSTEM_PROMPT = [
  "You extract durable memories from a conversation for a local assistant called ARTHUR.",
  'Return ONLY a JSON object of the form {"memories":[...]} with no markdown, no commentary, no chain-of-thought.',
  "Each memory object must match exactly:",
  '{"text": string (a complete, standalone, factual statement, 12-2000 chars),',
  ' "type": "EPISODIC" | "SEMANTIC" | "PROJECT" | "PROCEDURAL" | "TEMPORARY",',
  ' "subject_key": optional short stable identifier for the topic (max 128 chars),',
  ' "project_key": optional project identifier (max 128 chars),',
  ' "confidence": number 0..1, "importance": number 0..1,',
  ' "reason": short justification, "should_store": boolean}.',
  "Rules:",
  "- Do NOT extract secrets, credentials, tokens, passwords, API keys, or anything that looks like them.",
  "- Do NOT extract temporary conversational filler, greetings, or small talk.",
  "- Do NOT present guesses or model conclusions as facts; mark uncertain items should_store=false or omit them.",
  "- Do NOT extract large copied blocks; they belong in documents.",
  "- Do NOT extract information that belongs to the opposite mode of this conversation.",
  "- Prefer durable facts and decisions the user stated explicitly.",
].join(" ");

export class MemoryExtractor {
  private readonly gateway: ModelGateway;
  private readonly model: string;
  private readonly maxCandidates: number;
  private readonly maxTranscriptTokens: number;
  private readonly policy: CandidateWritePolicy;

  constructor(opts: MemoryExtractorOptions) {
    this.gateway = opts.gateway;
    this.model = opts.model;
    this.maxCandidates = opts.maxCandidates ?? 10;
    this.maxTranscriptTokens = opts.maxTranscriptTokens ?? 2000;
    this.policy = opts.policy ?? DEFAULT_CANDIDATE_POLICY;
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const transcript = this.buildTranscript(input);
    const request = {
      systemContract: SYSTEM_PROMPT,
      modeContract: "",
      history: [],
      toolSchemas: [],
      userMessage: transcript,
      model: this.model,
      reasoningProfile: "fast" as const,
      traceId: input.traceId,
      sessionId: input.sessionId,
    };
    const result = await this.gateway.generate(request);
    const parsed = parseExtractionOutput(result.assistant_text);
    if (!parsed.ok) {
      return { candidates: [], malformed: true };
    }
    const candidates: MemoryCandidate[] = [];
    for (const candidate of parsed.candidates.slice(0, this.maxCandidates)) {
      const verdict = decideCandidate(candidate, this.policy);
      if (verdict.action === "store") candidates.push(candidate);
    }
    return { candidates, malformed: false };
  }

  private buildTranscript(input: ExtractionInput): string {
    const parts: string[] = [];
    for (const turn of input.history.slice(-20)) {
      const role = turn.role === "user" ? "user" : turn.role === "assistant" ? "assistant" : "system";
      parts.push(`<${role}> ${turn.text}`);
    }
    if (input.userMessage) parts.push(`<user> ${input.userMessage}`);
    if (input.assistantText) parts.push(`<assistant> ${input.assistantText}`);

    const full = `Extract durable memories from this ${input.mode} conversation:\n\n${parts.join("\n")}`;
    const tokens = estimateTokens(full);
    if (tokens <= this.maxTranscriptTokens) return full;
    // Budget: keep the newest content.
    let kept: string[] = [];
    let used = 0;
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i] as string;
      const cost = estimateTokens(part);
      if (used + cost > this.maxTranscriptTokens) break;
      kept.unshift(part);
      used += cost;
    }
    return `Extract durable memories from this ${input.mode} conversation (recent portion):\n\n${kept.join("\n")}`;
  }
}