export const LAN_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const LAN_MAX_HISTORY_MESSAGES = 256;
export const LAN_MAX_TOOL_SCHEMAS = 128;
export const LAN_MAX_TOOL_CALLS = 32;
export const LAN_MAX_STRING_CHARS = 1024 * 1024;
export const LAN_MAX_ASSISTANT_CHARS = 1024 * 1024;
export const LAN_MAX_IDENTIFIER_CHARS = 256;
export const LAN_MAX_STREAM_FRAME_BYTES = 1024 * 1024;

import type { ModelRequest, ModelResult, ModelStreamEvent } from "../../../models/contracts";
import { HybridRegistryError } from "../errors";

function bad(message: string): never {
  throw new HybridRegistryError("INVALID_ROUTING_REQUEST", message);
}

function assertString(value: unknown, what: string, max: number): string {
  if (typeof value !== "string") bad(what + " must be a string");
  const text = value as string;
  if (text.length > max) bad(what + " exceeds the bound");
  return text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertJsonValue(value: unknown, what: string, depth: number): void {
  if (depth > 32) bad(what + " is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    if (value.length > 1024) bad(what + " array exceeds the bound");
    for (const item of value) assertJsonValue(item, what, depth + 1);
    return;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > 1024) bad(what + " object exceeds the bound");
    for (const key of keys) {
      if (key.length > LAN_MAX_IDENTIFIER_CHARS) bad(what + " key exceeds the bound");
      assertJsonValue((value as Record<string, unknown>)[key], what, depth + 1);
    }
    return;
  }
  bad(what + " must be JSON-compatible");
}

export function parseLanModelRequest(raw: unknown): ModelRequest {
  if (!isPlainObject(raw)) bad("model request must be an object");
  const input = raw as Record<string, unknown>;
  const systemContract = assertString(input["systemContract"], "systemContract", LAN_MAX_STRING_CHARS);
  const modeContract = assertString(input["modeContract"], "modeContract", LAN_MAX_STRING_CHARS);
  const userMessage = assertString(input["userMessage"], "userMessage", LAN_MAX_STRING_CHARS);
  const model = assertString(input["model"], "model", LAN_MAX_IDENTIFIER_CHARS);
  if (!Array.isArray(input["history"])) bad("history must be an array");
  const history = input["history"] as unknown[];
  if (history.length > LAN_MAX_HISTORY_MESSAGES) bad("history exceeds the bound");
  for (const item of history) {
    if (!isPlainObject(item)) bad("history message must be an object");
    const msg = item as Record<string, unknown>;
    if (msg["role"] !== "system" && msg["role"] !== "user" && msg["role"] !== "assistant" && msg["role"] !== "tool") bad("history role invalid");
    assertString(msg["content"], "history content", LAN_MAX_STRING_CHARS);
    if (msg["name"] !== undefined) assertString(msg["name"], "history name", LAN_MAX_IDENTIFIER_CHARS);
    if (msg["tool_call_id"] !== undefined) assertString(msg["tool_call_id"], "history tool_call_id", LAN_MAX_IDENTIFIER_CHARS);
    if (msg["tool_calls"] !== undefined) {
      if (!Array.isArray(msg["tool_calls"])) bad("history tool_calls must be an array");
      const calls = msg["tool_calls"] as unknown[];
      if (calls.length > LAN_MAX_TOOL_CALLS) bad("history tool_calls exceed the bound");
      for (const call of calls) assertToolCallShape(call);
    }
  }
  if (!Array.isArray(input["toolSchemas"])) bad("toolSchemas must be an array");
  const schemas = input["toolSchemas"] as unknown[];
  if (schemas.length > LAN_MAX_TOOL_SCHEMAS) bad("toolSchemas exceed the bound");
  for (const schema of schemas) {
    if (!isPlainObject(schema)) bad("tool schema must be an object");
    const entry = schema as Record<string, unknown>;
    assertString(entry["name"], "tool schema name", LAN_MAX_IDENTIFIER_CHARS);
    assertString(entry["description"], "tool schema description", LAN_MAX_STRING_CHARS);
    if (!isPlainObject(entry["parameters"])) bad("tool schema parameters must be an object");
    assertJsonValue(entry["parameters"], "tool schema parameters", 0);
  }
  if (input["reasoningProfile"] !== "fast" && input["reasoningProfile"] !== "normal" && input["reasoningProfile"] !== "deep") bad("reasoningProfile invalid");
  for (const field of ["traceId", "sessionId", "clientRequestId"] as const) {
    if (input[field] !== undefined) assertString(input[field], field, LAN_MAX_IDENTIFIER_CHARS);
  }
  let memory: ModelRequest["memory"];
  if (input["memory"] !== undefined) {
    if (!isPlainObject(input["memory"])) bad("memory must be an object");
    const mem = input["memory"] as Record<string, unknown>;
    assertString(mem["domain"], "memory.domain", LAN_MAX_IDENTIFIER_CHARS);
    for (const num of ["context_tokens", "included"] as const) {
      if (typeof mem[num] !== "number" || !Number.isInteger(mem[num]) || (mem[num] as number) < 0) bad("memory." + num + " must be a non-negative integer");
    }
    memory = { domain: mem["domain"] as string, context_tokens: mem["context_tokens"] as number, included: mem["included"] as number };
  }
  return { systemContract, modeContract, history: history as ModelRequest["history"], toolSchemas: schemas as ModelRequest["toolSchemas"], userMessage, model, reasoningProfile: input["reasoningProfile"] as ModelRequest["reasoningProfile"], ...(input["traceId"] !== undefined ? { traceId: input["traceId"] as string } : {}), ...(input["sessionId"] !== undefined ? { sessionId: input["sessionId"] as string } : {}), ...(input["clientRequestId"] !== undefined ? { clientRequestId: input["clientRequestId"] as string } : {}), ...(memory !== undefined ? { memory } : {}) };
}

export function parseLanModelResult(raw: unknown): ModelResult {
  if (!isPlainObject(raw)) bad("model result must be an object");
  const input = raw as Record<string, unknown>;
  const assistantText = assertString(input["assistant_text"], "assistant_text", LAN_MAX_ASSISTANT_CHARS);
  if (!Array.isArray(input["tool_calls"])) bad("tool_calls must be an array");
  const calls = input["tool_calls"] as unknown[];
  if (calls.length > LAN_MAX_TOOL_CALLS) bad("tool_calls exceed the bound");
  for (const call of calls) assertToolCallShape(call);
  const finishReason = assertString(input["finish_reason"], "finish_reason", LAN_MAX_IDENTIFIER_CHARS);
  let usage: ModelResult["usage"];
  if (input["usage"] !== undefined) {
    if (!isPlainObject(input["usage"])) bad("usage must be an object");
    const use = input["usage"] as Record<string, unknown>;
    for (const num of ["input_tokens", "output_tokens", "total_tokens"] as const) {
      if (typeof use[num] !== "number" || !Number.isInteger(use[num]) || (use[num] as number) < 0 || !Number.isSafeInteger(use[num])) bad("usage." + num + " must be a non-negative safe integer");
    }
    usage = { input_tokens: use["input_tokens"] as number, output_tokens: use["output_tokens"] as number, total_tokens: use["total_tokens"] as number };
  }
  let rawProviderId: string | undefined;
  if (input["raw_provider_id"] !== undefined) rawProviderId = assertString(input["raw_provider_id"], "raw_provider_id", LAN_MAX_IDENTIFIER_CHARS);
  return { assistant_text: assistantText, tool_calls: calls as ModelResult["tool_calls"], finish_reason: finishReason, ...(usage !== undefined ? { usage } : {}), ...(rawProviderId !== undefined ? { raw_provider_id: rawProviderId } : {}) };
}

export function parseLanStreamEvent(raw: unknown): ModelStreamEvent {
  if (!isPlainObject(raw)) bad("stream event must be an object");
  const input = raw as Record<string, unknown>;
  const kind = input["type"];
  if (kind === "text_delta") return { type: "text_delta", text: assertString(input["text"], "text_delta.text", LAN_MAX_ASSISTANT_CHARS) };
  if (kind === "tool_call") {
    if (!isPlainObject(input["call"])) bad("tool_call.call must be an object");
    assertToolCallShape(input["call"]);
    return { type: "tool_call", call: input["call"] as ModelStreamEvent extends { type: "tool_call"; call: infer C } ? C : never };
  }
  if (kind === "usage") {
    if (!isPlainObject(input["usage"])) bad("usage event must carry a usage object");
    const use = input["usage"] as Record<string, unknown>;
    for (const num of ["input_tokens", "output_tokens", "total_tokens"] as const) {
      if (typeof use[num] !== "number" || !Number.isInteger(use[num]) || (use[num] as number) < 0 || !Number.isSafeInteger(use[num])) bad("usage." + num + " must be a non-negative safe integer");
    }
    return { type: "usage", usage: { input_tokens: use["input_tokens"] as number, output_tokens: use["output_tokens"] as number, total_tokens: use["total_tokens"] as number } };
  }
  if (kind === "done") return { type: "done", finish_reason: assertString(input["finish_reason"], "done.finish_reason", LAN_MAX_IDENTIFIER_CHARS) };
  bad("unknown stream event type");
  throw new Error("unreachable");
}

function assertToolCallShape(call: unknown): void {
  if (!isPlainObject(call)) bad("tool call must be an object");
  const entry = call as Record<string, unknown>;
  assertString(entry["id"], "tool call id", LAN_MAX_IDENTIFIER_CHARS);
  assertString(entry["name"], "tool call name", LAN_MAX_IDENTIFIER_CHARS);
  if (!isPlainObject(entry["arguments"])) bad("tool call arguments must be an object");
  assertJsonValue(entry["arguments"], "tool call arguments", 0);
}
